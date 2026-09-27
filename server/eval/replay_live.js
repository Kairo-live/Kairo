// KAIRO — replay live-run transcripts (the same service transcribed differently
// on each run) through the whole pipeline, sentence by sentence, and print what
// reached the screen and Possible Matches. For comparing runs by eye after a
// change; the assertions for these cases live in service_scenarios.test.js.
//   KAIRO_EVAL_MODE=1 node server/eval/replay_live.js [file ...]   (default: every file in live_runs/)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }
const dir = path.join(os.tmpdir(), `kairo-replay-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
process.env.KAIRO_APP_DATA_DIR = dir;
const server = require('../server');
const { referenceContext } = require('../reference_parser');

const RUNS = path.join(__dirname, 'live_runs');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(RUNS).filter(f => f.endsWith('.txt')).map(f => path.join(RUNS, f));
const wait = ms => new Promise(r => setTimeout(r, ms));
let log = [], cur = '';
server.onBroadcast(m => {
  if (m.type !== 'detection') return;
  const refs = m.verses.map(v => v.reference).join(' + ');
  log.push(`${m.target === 'viewer' ? 'SCREEN' : '  maybe'} ${refs} [${m.method}${m.corrected ? `, corrected from ${m.correctedFrom}` : ''}]   <- "${cur.slice(0, 60)}"`);
});

(async () => {
  server.spawnDetectionWorker(); await server.workerReadyPromise; await wait(2500);
  for (const f of files) {
    const sentences = fs.readFileSync(f, 'utf8').replace(/\s+/g, ' ').match(/[^.?!]+[.?!]+/g) || [];
    server.resetDetectionSession(); referenceContext.reset(); server.clearRangeQueue(); await server.clearLayer('all');
    log = []; await wait(300);
    for (const s of sentences) {
      cur = s.trim(); const w = cur.split(' ');
      for (let i = 2; i < w.length; i += 2) { await server.handleTranscriptSegment(w.slice(0, i).join(' '), false, 0.9, false); await wait(180); }
      await server.handleTranscriptSegment(cur, true, 0.9, true); await wait(350);
    }
    await wait(2000);
    console.log(`\n##### ${path.basename(f)}\n${log.join('\n')}`);
  }
  process.exit(0);
})();
