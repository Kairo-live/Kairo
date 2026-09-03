#!/usr/bin/env node
// Thin CLI wrapper around server/mt_installer.js. The actual download logic
// lives there so the in-app HTTP installer (and translate.js's lazy
// background download) can reuse it.
//
// Usage:  node scripts/download-mt-model.js [lang]
//   Or:   npm run mt:install [-- lang]
// With no [lang], downloads every supported language (French/Spanish/
// Portuguese) one after another — mt_installer.installLLMModel requires an
// explicit lang per call, there's no "download everything" mode on that side.
'use strict';

const { installLLMModel, isModelPresent, modelPath } = require('../server/mt_installer');
const { MODELS } = require('../server/mt_engine');

function log(msg) { process.stdout.write(`[mt] ${msg}\n`); }
function die(msg) { process.stderr.write(`[mt] ERROR: ${msg}\n`); process.exit(1); }

async function installOne(lang) {
  if (await isModelPresent(lang)) {
    log(`[${lang}] Model already present at ${modelPath(lang)}`);
    return;
  }
  log(`[${lang}] Downloading Opus-MT translation model…`);

  let lastPrinted = -1;
  await installLLMModel({
    lang,
    onProgress: (e) => {
      if (e.phase === 'download' && e.pct % 5 === 0 && e.pct !== lastPrinted) {
        process.stdout.write(`\r[mt] [${lang}] Downloading… ${e.pct}%`);
        lastPrinted = e.pct;
      } else if (e.phase === 'done') {
        process.stdout.write('\n');
        log(`[${lang}] Done. Model installed at ${e.modelPath}`);
      }
    },
  });
}

(async () => {
  const requested = process.argv[2];
  const langs = requested ? [requested] : Object.keys(MODELS);

  if (requested && !MODELS[requested]) {
    die(`Unknown language "${requested}" — supported: ${Object.keys(MODELS).join(', ')}`);
    return;
  }

  for (const lang of langs) {
    try {
      await installOne(lang);
    } catch (err) {
      die(`[${lang}] ${err.message || String(err)}`);
      return;
    }
  }
})();
