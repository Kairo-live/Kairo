// KAIRO — Listening-session lifecycle against a fake Deepgram SDK.
// Owner's rule: Start Listening opens the connection, Stop closes it — nothing
// else ends the session, and words already heard are never dropped by a
// reconnect.
//   KAIRO_EVAL_MODE=1 node server/deepgram_session.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }

// ── fake @deepgram/sdk ────────────────────────────────────────────────────
const E = { Open: 'open', Transcript: 'Results', Error: 'error', Close: 'close', UtteranceEnd: 'UtteranceEnd', Metadata: 'Metadata' };
const conns = [];
const configs = [];
function makeConn(config) {
  configs.push(config);
  const handlers = {};
  const c = {
    handlers, closed: false,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, d) { for (const fn of handlers[ev] || []) fn(d); },
    conn: { readyState: 1, sent: [], send(x) { this.sent.push(x); } },
    requestClose() { this.closed = true; },
  };
  conns.push(c);
  return c;
}
const sdkPath = require.resolve('@deepgram/sdk');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: {
  createClient: () => ({ listen: { live: (config) => makeConn(config) } }),
  LiveTranscriptionEvents: E,
} };

const d = path.join(os.tmpdir(), `kairo-dg-session-test-${Date.now()}`);
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ deepgramApiKey: 'test-key-not-real', sttStreams: 1, customKeyterms: 'Pastor Mensah, Grace Chapel\nShiloh' }));
process.env.KAIRO_APP_DATA_DIR = d;
const server = require('./server');

let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`✔ ${name}`); } catch (e) { fail++; console.log(`✖ ${name}\n  ${e.message}`); } }
const wait = ms => new Promise(r => setTimeout(r, ms));
const states = []; const transcripts = [];
server.onBroadcast(m => { if (m.type === 'connection-state') states.push(m.state); if (m.type === 'transcript') transcripts.push(m); });
const frame = (amp) => { const b = Buffer.alloc(2048); for (let i = 0; i < 1024; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2); return b; };
const isAudio = x => Buffer.isBuffer(x);

async function start() {
  const p = server.startDeepgram({});
  await wait(20);
  conns.at(-1).emit(E.Open);
  return p;
}

(async () => {
  server.spawnDetectionWorker(); await server.workerReadyPromise;

  await test("the church's own vocabulary is sent to Deepgram, ahead of the built-in terms", async () => {
    await start();
    const terms = configs.at(-1).keyterm || [];
    assert.deepEqual(terms.slice(0, 3), ['Pastor Mensah', 'Grace Chapel', 'Shiloh']);
    assert.ok(terms.includes('Genesis'));
    await server.stopDeepgram(); await wait(50);
  });

  await test('a mid-session drop keeps the session: "reconnecting" (never "disconnected"), unfinished words locked, audio held and replayed into the new connection', async () => {
    states.length = 0; transcripts.length = 0;
    const r = await start();
    assert.equal(r.ok, true);
    const first = conns.at(-1);
    first.emit(E.Transcript, { is_final: false, channel: { alternatives: [{ transcript: 'for God so loved the world that he gave', confidence: 0.9 }] } });
    await wait(20);
    first.emit(E.Close, { code: 1011, reason: 'network' });
    await wait(20);
    assert.ok(states.includes('reconnecting'), JSON.stringify(states));
    assert.ok(!states.includes('disconnected'), 'a drop must not announce the session as stopped: ' + JSON.stringify(states));
    assert.ok(transcripts.some(t => t.isFinal && t.text.startsWith('for God so loved the world')), 'the words already seen are locked in as final');
    for (let i = 0; i < 5; i++) server.ingestAudio(frame(4000));   // spoken during the gap
    await wait(1200);                                                   // first retry after 1s
    const second = conns.at(-1);
    assert.notEqual(second, first, 'a new connection was opened');
    second.emit(E.Open);
    await wait(20);
    assert.equal(second.conn.sent.filter(isAudio).length, 5, 'audio heard while reconnecting is replayed into the new connection');
    assert.equal(states.at(-1), 'connected');
    await server.stopDeepgram();
  });

  await test('long silence never reconnects; 30s of speech with no transcript back does (stuck)', async () => {
    states.length = 0;
    await start();
    const c = conns.at(-1);
    for (let i = 0; i < 16 * 45; i++) server.ingestAudio(frame(0));    // ~45s of digital silence
    await wait(5600);                                                   // one watchdog tick
    assert.ok(!states.includes('reconnecting'), 'silence must not reconnect: ' + JSON.stringify(states));
    for (let i = 0; i < 16 * 32; i++) server.ingestAudio(frame(5000)); // ~32s of speech, nothing transcribed
    await wait(5600);
    assert.ok(states.includes('reconnecting'), 'a connection that transcribes nothing while people talk is reconnected: ' + JSON.stringify(states));
    assert.equal(c.closed, true);
    await server.stopDeepgram();
  });

  await test('Stop asks Deepgram to finalize first, then ends the session', async () => {
    states.length = 0;
    await start();
    const c = conns.at(-1);
    const p = server.stopDeepgram();
    await wait(20);
    assert.ok(c.conn.sent.some(x => typeof x === 'string' && x.includes('Finalize')), 'Finalize sent before closing');
    c.emit(E.Transcript, { is_final: true, channel: { alternatives: [{ transcript: 'the last words', confidence: 0.9 }] } });
    await p;
    assert.equal(c.closed, true);
    assert.equal(states.at(-1), 'disconnected');
    const before = conns.length;
    await wait(1500);
    assert.equal(conns.length, before, 'no reconnect after Stop');
  });

  await test('a bad API key ends the session with an error instead of retrying forever', async () => {
    states.length = 0;
    await start();
    const c = conns.at(-1);
    c.emit(E.Error, { message: 'Unauthorized: invalid api key', code: 401 });
    await wait(1500);
    assert.equal(states.at(-1), 'error');
    assert.ok(!states.includes('reconnecting'), JSON.stringify(states));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
