// Reranker installer — same NDJSON {phase, pct}/{phase:'done'} shape the
// offline-model/MT/semantic installers all use. One step, unlike the
// semantic installer's two (model download + embeddings build): the
// reranker never needs a pre-built corpus index, it scores whatever
// short-listed candidates the caller hands it on demand.
'use strict';

const path = require('path');
const { checkDiskSpace } = require('./disk_space');
const reranker = require('./reranker_engine');

const MODEL_APPROX_MB = 35; // model_int8.onnx (~33MB) + tokenizer/config

function isModelPresent()   { return reranker.isModelPresent(); }
function isFullyInstalled() { return reranker.isModelPresent(); }

async function installReranker({ onProgress } = {}) {
  if (isFullyInstalled()) {
    onProgress?.({ phase: 'done', already: true });
    return { alreadyPresent: true };
  }

  checkDiskSpace(path.join(__dirname, '..', 'databases', 'bibles'), MODEL_APPROX_MB);

  // Same per-file-average approach semantic_installer.js/mt_installer.js
  // use — the library reports progress per file (tokenizer/config/onnx
  // weights each 0-100 on their own), averaged so the bar reads as one
  // steady sweep instead of restarting for each file.
  const fileProgress = new Map();
  onProgress?.({ phase: 'download', pct: 0 });
  await reranker.installModel((evt) => {
    if (evt?.status !== 'progress' || typeof evt.progress !== 'number') return;
    fileProgress.set(evt.file, evt.progress);
    const values = [...fileProgress.values()];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    onProgress?.({ phase: 'download', pct: Math.floor(avg) });
  });

  if (!isModelPresent()) {
    throw new Error('Model download completed but the weights file looks missing/truncated — try again.');
  }

  onProgress?.({ phase: 'done', already: false });
  return { alreadyPresent: false };
}

module.exports = { installReranker, isModelPresent, isFullyInstalled };
