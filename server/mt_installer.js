// Local translation-model installer — thin wrapper around mt_engine.js that
// reshapes @huggingface/transformers' own progress events into the same
// {phase, pct}/{phase:'done'} shape whisper_installer.js established, and
// adds the per-language indirection mt_engine.js needs (French/Spanish/
// Portuguese are three independent model downloads, not one shared file —
// see mt_engine.js for why).
'use strict';

const fs = require('fs');
const mtEngine = require('./mt_engine');
const { checkDiskSpace } = require('./disk_space');

function isModelPresent(lang) {
  return mtEngine.checkPresent(lang);
}

function modelPath(lang) {
  return mtEngine.cacheDir(lang);
}

function approxMB(lang) {
  return mtEngine.MODELS[lang]?.mb ?? null;
}

async function installLLMModel({ lang, onProgress } = {}) {
  if (!lang) throw new Error('installLLMModel requires a lang');
  if (await isModelPresent(lang)) {
    onProgress?.({ phase: 'done', already: true, modelPath: modelPath(lang) });
    return { alreadyPresent: true, modelPath: modelPath(lang) };
  }

  const requiredMB = approxMB(lang);
  if (requiredMB) {
    fs.mkdirSync(modelPath(lang), { recursive: true });
    checkDiskSpace(modelPath(lang), requiredMB);
  }

  // The library reports progress per-file (encoder + decoder download
  // separately, each 0-100 on their own) — average across whichever files
  // it's told us about so far so the progress bar reads as one steady 0-100
  // sweep instead of restarting twice.
  const fileProgress = new Map();
  const onHfProgress = (evt) => {
    if (evt?.status !== 'progress' || typeof evt.progress !== 'number') return;
    fileProgress.set(evt.file, evt.progress);
    const values = [...fileProgress.values()];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    onProgress?.({ phase: 'download', pct: Math.floor(avg) });
  };

  await mtEngine.ensureLoaded(lang, onHfProgress, false);

  onProgress?.({ phase: 'done', already: false, modelPath: modelPath(lang) });
  return { alreadyPresent: false, modelPath: modelPath(lang) };
}

module.exports = { installLLMModel, isModelPresent, modelPath, approxMB };
