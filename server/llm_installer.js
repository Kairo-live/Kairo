// Local translation-model installer — same shape as whisper_installer.js
// (shared by an in-app HTTP endpoint and a CLI script), so the frontend's
// existing NDJSON progress-bar wiring works unchanged for this too.
//
// This is deliberately a small general-purpose instruct model (Qwen2.5,
// GGUF, run locally via node-llama-cpp — see llm_engine.js) rather than a
// full Ollama install: translating a slide/verse line doesn't need a whole
// chat-LLM server, and bundling one would mean every user downloads several
// extra gigabytes even if they never touch Multi-Language. The 1.5B variant
// is the default — small enough to ship as part of first-run setup, and
// Qwen's multilingual training makes it noticeably better at French/Spanish/
// Portuguese than most same-size alternatives.
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const HF_BASE = 'https://huggingface.co/Qwen';

// name → { repo, file, approxMB }. q4_k_m is the standard size/quality
// balance (same convention Ollama defaults to). The 0.5B variant is an
// opt-in downgrade for disk-constrained machines — noticeably rougher
// translations, but a fraction of the size.
const MODELS = {
  'qwen2.5-1.5b-instruct-q4_k_m': {
    repo: 'Qwen2.5-1.5B-Instruct-GGUF',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    mb: 1000,
  },
  'qwen2.5-0.5b-instruct-q4_k_m': {
    repo: 'Qwen2.5-0.5B-Instruct-GGUF',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    mb: 400,
  },
};
const DEFAULT_NAME = 'qwen2.5-1.5b-instruct-q4_k_m';

function modelsDir(base) {
  return base || (process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'models')
    : path.join(__dirname, 'models'));
}

function modelSpec(name) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`Unknown local LLM model "${name}". Options: ${Object.keys(MODELS).join(', ')}`);
  return spec;
}

function modelPath(name = DEFAULT_NAME, base) {
  return path.join(modelsDir(base), modelSpec(name).file);
}

function isModelPresent(name = DEFAULT_NAME, base) {
  const p = modelPath(name, base);
  return fs.existsSync(p) && fs.statSync(p).size > 1_000_000; // guards against a truncated/partial download
}

// Follows redirects (Hugging Face's CDN issues a 302 to its S3-backed mirror)
// — identical to whisper_installer.js's downloader.
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

async function installLLMModel({ name = DEFAULT_NAME, modelsDir: base, onProgress } = {}) {
  if (isModelPresent(name, base)) {
    onProgress?.({ phase: 'done', already: true, modelPath: modelPath(name, base) });
    return { alreadyPresent: true, modelPath: modelPath(name, base) };
  }
  const dir = modelsDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const dest = modelPath(name, base);
  const spec = modelSpec(name);

  onProgress?.({ phase: 'download', pct: 0 });
  await download(`${HF_BASE}/${spec.repo}/resolve/main/${spec.file}`, dest, onProgress);

  if (!isModelPresent(name, base)) {
    throw new Error('Download completed but the model file looks truncated — try again.');
  }
  onProgress?.({ phase: 'done', already: false, modelPath: dest });
  return { alreadyPresent: false, modelPath: dest };
}

module.exports = {
  installLLMModel,
  isModelPresent,
  modelPath,
  modelsDir,
  MODELS,
  DEFAULT_NAME,
};
