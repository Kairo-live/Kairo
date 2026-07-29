#!/usr/bin/env node
// Thin CLI wrapper around server/llm_installer.js. The actual download logic
// lives there so the in-app HTTP installer (and translate.js's lazy
// background download) can reuse it.
//
// Usage:  node scripts/download-llm-model.js [model]
//   Or:   npm run llm:install                        (default: qwen2.5-1.5b-instruct-q4_k_m)
//   Or:   npm run llm:install -- qwen2.5-0.5b-instruct-q4_k_m
'use strict';

const { installLLMModel, isModelPresent, modelPath, MODELS, DEFAULT_NAME } = require('../server/llm_installer');

function log(msg) { process.stdout.write(`[llm] ${msg}\n`); }
function die(msg) { process.stderr.write(`[llm] ERROR: ${msg}\n`); process.exit(1); }

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
    await installLLMModel({
      name,
      onProgress: (e) => {
        if (e.phase === 'download' && e.pct % 5 === 0 && e.pct !== lastPrinted) {
          process.stdout.write(`\r[llm] Downloading… ${e.pct}%`);
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
