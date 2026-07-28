#!/usr/bin/env node
// Thin CLI wrapper around server/whisper_installer.js. The actual download
// logic lives there so the in-app HTTP installer can reuse it.
//
// Usage:  node scripts/download-whisper-model.js [model]
//   Or:   npm run whisper:install               (default: small.en-q5_1)
//   Or:   npm run whisper:install -- large-v3-turbo-q5_0
'use strict';

const { installWhisperModel, isModelPresent, modelPath, MODELS, DEFAULT_NAME } = require('../server/whisper_installer');

function log(msg) { process.stdout.write(`[whisper] ${msg}\n`); }
function die(msg) { process.stderr.write(`[whisper] ERROR: ${msg}\n`); process.exit(1); }

const name = (process.argv[2] || DEFAULT_NAME).trim();
if (!MODELS[name]) die(`Unknown model "${name}". Options: ${Object.keys(MODELS).join(', ')}`);

(async () => {
  if (isModelPresent(name)) {
    log(`Model already present at ${modelPath(name)}`);
    return;
  }
  log(`Downloading ${MODELS[name].file} (~${MODELS[name].mb}MB)…`);

  let lastPrinted = -1;
  try {
    await installWhisperModel({
      name,
      onProgress: (e) => {
        if (e.phase === 'download' && e.pct % 5 === 0 && e.pct !== lastPrinted) {
          process.stdout.write(`\r[whisper] Downloading… ${e.pct}%`);
          lastPrinted = e.pct;
        } else if (e.phase === 'done') {
          process.stdout.write('\n');
          log(`Done. Model installed at ${e.modelPath}`);
        }
      },
    });
  } catch (err) {
    die(err.message || String(err));
  }
})();
