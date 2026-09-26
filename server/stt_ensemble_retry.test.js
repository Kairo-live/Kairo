// KAIRO — stt_ensemble.js retry policy: an extra stream that keeps closing backs
// off and eventually gives up instead of reconnecting every 3s for the whole service.
//   node --test server/stt_ensemble_retry.test.js
'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { SttEnsemble, RETRY_BASE_MS, MAX_RETRIES } = require('./stt_ensemble');

const E = { Open: 'open', Transcript: 'transcript', Error: 'error', Close: 'close' };
function fakeClient() {
  const conns = [];
  return {
    conns,
    client: { listen: { live() { const h = {}; const c = { on: (e, f) => { h[e] = f; }, fire: (e, d) => h[e]?.(d), conn: { readyState: 1, send() {} }, requestClose() {} }; conns.push(c); return c; } } },
  };
}

test('repeated closes back off exponentially and stop after MAX_RETRIES', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const f = fakeClient();
    const ens = new SttEnsemble({ createClient: () => f.client, events: E, apiKey: 'k', config: {}, extraStreams: 1, onFinal() {} });
    ens.start();
    assert.equal(f.conns.length, 1);
    let delay = RETRY_BASE_MS;
    for (let i = 1; i <= MAX_RETRIES; i++) {
      f.conns.at(-1).fire(E.Close);
      mock.timers.tick(delay - 1);
      assert.equal(f.conns.length, i, `retry ${i} must not open before ${delay}ms`);
      mock.timers.tick(1);
      assert.equal(f.conns.length, i + 1, `retry ${i} opens after ${delay}ms`);
      delay = Math.min(delay * 2, 60000);
    }
    f.conns.at(-1).fire(E.Close);           // one more failure: give up
    mock.timers.tick(10 * 60000);
    assert.equal(f.conns.length, MAX_RETRIES + 1, 'no further reconnects after giving up');
    ens.stop();
  } finally { mock.timers.reset(); }
});

test('a stream that delivers a transcript resets its backoff', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const f = fakeClient();
    const ens = new SttEnsemble({ createClient: () => f.client, events: E, apiKey: 'k', config: {}, extraStreams: 1, onFinal() {} });
    ens.start();
    f.conns.at(-1).fire(E.Close); mock.timers.tick(RETRY_BASE_MS);        // failure 1
    f.conns.at(-1).fire(E.Close); mock.timers.tick(RETRY_BASE_MS * 2);    // failure 2
    f.conns.at(-1).fire(E.Open);
    f.conns.at(-1).fire(E.Transcript, { is_final: false, channel: { alternatives: [{ transcript: 'hi' }] } });
    const before = f.conns.length;
    f.conns.at(-1).fire(E.Close);
    mock.timers.tick(RETRY_BASE_MS);
    assert.equal(f.conns.length, before + 1, 'after real traffic the next retry is back at the base delay');
    ens.stop();
  } finally { mock.timers.reset(); }
});
