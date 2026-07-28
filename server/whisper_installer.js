// Whisper offline-model installer — shared module used by both the CLI
// script (scripts/download-whisper-model.js) and the in-app HTTP endpoint
// (POST /api/whisper/install). Mirrors the shape of the old vosk_installer.js
// so the frontend's progress-bar wiring barely had to change: same
// {phase, pct} progress events, same isModelPresent/modelPath accessors.
//
// Unlike the Vosk model (a zip that needs extracting), a ggml whisper model
// is a single .bin file — no archive step.
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// name → { file, approxMB }. small.en-q5_1 is the CPU-friendly default that
// ships as the app's out-of-the-box offline engine — quantized small.en gets
// meaningfully closer to Deepgram-quality transcripts than base.en did, for
// only ~34MB more on disk. large-v3-turbo variants are opt-in upgrades for
// GPU machines (set KAIRO_WHISPER_MODEL_NAME to switch).
const MODELS = {
  'base.en':             { file: 'ggml-base.en.bin',              mb: 148 },
  'small.en':            { file: 'ggml-small.en.bin',             mb: 488 },
  'small.en-q5_1':       { file: 'ggml-small.en-q5_1.bin',        mb: 182 },
  'large-v3-turbo':      { file: 'ggml-large-v3-turbo.bin',       mb: 1560 },
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin',  mb: 574 },
};
const DEFAULT_NAME = 'small.en-q5_1';

function modelsDir(base) {
  return base || (process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'models')
    : path.join(__dirname, 'models'));
}

function modelSpec(name) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Unknown whisper model "${name}". Options: ${Object.keys(MODELS).join(', ')}`);
  return spec;
}

function modelPath(name = DEFAULT_NAME, base) {
  return path.join(modelsDir(base), modelSpec(name).file);
}

function isModelPresent(name = DEFAULT_NAME, base) {
  const p = modelPath(name, base);
  return fs.existsSync(p) && fs.statSync(p).size > 1_000_000; // guards against a truncated/partial download
}

// Follows redirects (Hugging Face's CDN issues a 302 to its S3-backed mirror).
function download(url, dest, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return download(res.headers.location, dest, onProgress, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0, lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!total) return;
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress?.({ phase: 'download', pct, received, total }); }
      });
      res.pipe(file);
      file.on('finish', () => {
        onProgress?.({ phase: 'download', pct: 100, received: total, total });
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function installWhisperModel({ name = DEFAULT_NAME, modelsDir: base, onProgress } = {}) {
  if (isModelPresent(name, base)) {
    onProgress?.({ phase: 'done', already: true, modelPath: modelPath(name, base) });
    return { alreadyPresent: true, modelPath: modelPath(name, base) };
  }
  const dir = modelsDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const dest = modelPath(name, base);
  const spec = modelSpec(name);

  onProgress?.({ phase: 'download', pct: 0 });
  await download(`${HF_BASE}/${spec.file}`, dest, onProgress);

  if (!isModelPresent(name, base)) {
    throw new Error('Download completed but the model file looks truncated — try again.');
  }
  onProgress?.({ phase: 'done', already: false, modelPath: dest });
  return { alreadyPresent: false, modelPath: dest };
}

module.exports = {
  installWhisperModel,
  isModelPresent,
  modelPath,
  modelsDir,
  MODELS,
  DEFAULT_NAME,
};
