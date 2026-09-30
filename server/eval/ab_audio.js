// KAIRO — play an audio or video file into one speech engine in real time,
// through the same server pipeline the app uses (startOffline/startDeepgram →
// ingestAudio in the app's 64 ms frames → handleTranscriptSegment), and print
// what the engine heard and what went to the screen or Possible Matches. For
// A/B-ing the offline engine against Deepgram on identical audio: run it once
// per engine.
//   KAIRO_EVAL_MODE=1 node server/eval/ab_audio.js <file> offline|deepgram
// Uses the installed app's settings (Deepgram key, translation, auto-send) and
// offline model. The settings are copied into a scratch folder, so nothing of
// the app's is written.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }
const [file, engine] = process.argv.slice(2);
if (!file || !['offline', 'deepgram'].includes(engine)) { console.error('Usage: ab_audio.js <file> offline|deepgram'); process.exit(1); }

const APP_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'com.kairo.scripture');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-ab-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
fs.copyFileSync(path.join(APP_DATA, 'settings.json'), path.join(dir, 'settings.json'));
process.env.KAIRO_APP_DATA_DIR = dir;
process.env.KAIRO_OFFLINE_MODEL ||= path.join(APP_DATA, 'models', 'sherpa-streaming-en');

// 16 kHz mono int16, what the app's capture worker sends, in its 64 ms frames.
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
const FRAME_BYTES = 2048, FRAME_MS = 64;

// The semantic layer loads a few seconds after the worker; paraphrase matches
// need it, so the audio waits for it as the app's would have.
const log = console.log;
const semanticReady = new Promise(res => {
  console.log = (...a) => { log(...a); if (/Semantic layer ready/.test(String(a[0]))) res(); };
});

const server = require('../server');
const wait = ms => new Promise(r => setTimeout(r, ms));
let t0 = 0;
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const heard = [], sends = [];
server.onBroadcast(m => {
  if (m.type === 'transcript' && m.isFinal) heard.push(`${at()}  ${m.text}`);
  if (m.type === 'detection') {
    sends.push(`${at()}  ${m.target === 'viewer' ? 'SCREEN' : ' maybe'}  ${m.verses.map(v => v.reference).join(' + ')}`
      + `  [${m.method}${m.corrected ? `, corrected from ${m.correctedFrom}` : ''}]`);
  }
});

(async () => {
  server.spawnDetectionWorker();
  await server.workerReadyPromise;
  await Promise.race([semanticReady, wait(30000)]);
  const res = engine === 'offline' ? await server.startOffline() : await server.startDeepgram();
  if (res?.error) { console.error(res.error); process.exit(1); }
  // The app keeps sending after the talking stops: 5 s of silence lets the
  // engine lock its last words.
  const audio = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 5)]);
  t0 = Date.now();
  for (let i = 0; i * FRAME_BYTES < audio.length; i++) {
    const due = t0 + i * FRAME_MS - Date.now();   // frame i at t0 + i·64 ms: real time, no drift
    if (due > 0) await wait(due);
    server.ingestAudio(audio.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
  }
  await wait(3000);
  await (engine === 'offline' ? server.stopOffline() : server.stopDeepgram());
  await wait(2000);
  log(`\n##### ${engine}: what it heard (locked text)\n${heard.join('\n')}`);
  log(`\n##### ${engine}: sends\n${sends.join('\n')}`);
  process.exit(0);
})();
