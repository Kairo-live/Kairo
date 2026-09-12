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
const { checkDiskSpace } = require('./disk_space');

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

// No activity (not even a data event) for this long → treat the connection
// as stalled. Hugging Face's CDN can accept the connection and then hang
// mid-transfer (or a network/router in between can cap long-lived TCP
// connections outright — observed twice in a row stalling at the exact same
// byte offset on a 1.5GB model, which points at a connection-duration cap,
// not random flakiness); without this the install promise never settles and
// the progress UI freezes with no way to cancel/retry.
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

// Authoritative remote file size via HEAD (follows redirects). The old code
// estimated `total` from the MODELS table's rounded approxMB, which reliably
// undercounts the real byte count (e.g. 1560*1e6 vs the real 1,624,555,275)
// — enough to make the progress bar hit "100%" before the stream actually
// finished, and worse, to make a post-100% resume attempt send a Range
// request starting past the real end of file (HTTP 416 Range Not
// Satisfiable), which the old code treated as a fatal error and deleted the
// otherwise-complete download. Getting the real size up front avoids both.
function headContentLength(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return headContentLength(res.headers.location, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HEAD HTTP ${res.statusCode}`));
      resolve(parseInt(res.headers['content-length'] || '0', 10));
    });
    req.on('error', reject);
    req.end();
  });
}

// A stall/network error no longer throws away what was already downloaded —
// large models (1GB+) can take several minutes, and a network that resets
// long-lived connections around the same point every time would otherwise
// make the download un-completable (each retry restarting from 0% and
// hitting the same wall again). Resumes via an HTTP Range request against
// whatever partial bytes already exist on disk; only starts over on a
// genuinely non-resumable failure (bad URL, server doesn't honor Range, etc).
//
// Follows redirects (Hugging Face's CDN issues a 302 to its S3-backed mirror).
function download(url, dest, onProgress, { maxRedirects = 5, startByte = 0, total = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (total > 0 && startByte >= total) {
      // Already fully downloaded (e.g. a prior attempt actually finished
      // but a late/duplicate error still bubbled up to the retry loop) —
      // nothing left to fetch, and a Range request here would 416.
      onProgress?.({ phase: 'download', pct: 100, received: total, total });
      return resolve();
    }
    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
    const file = fs.createWriteStream(dest, { flags: startByte > 0 ? 'a' : 'w' });
    const req = https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close();
        return download(res.headers.location, dest, onProgress, { maxRedirects: maxRedirects - 1, startByte, total })
          .then(resolve, reject);
      }
      // 206 = server honored our Range resume; 200 = resume not supported,
      // server sent the whole file again from the start — restart the file.
      if (res.statusCode === 200 && startByte > 0) {
        file.close();
        return download(url, dest, onProgress, { maxRedirects, startByte: 0, total }).then(resolve, reject);
      }
      // 416 with a partial file already on disk almost certainly means the
      // file is already complete (our own accounting just didn't know it) —
      // don't destroy real progress over it. Only treat it as fatal (and
      // clean up) when there's no partial file to fall back on.
      if (res.statusCode === 416) {
        file.close();
        if (startByte > 0) {
          onProgress?.({ phase: 'download', pct: 100, received: startByte, total: total || startByte });
          return resolve();
        }
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error('HTTP 416'));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let received = startByte, lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!total) return;
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress?.({ phase: 'download', pct, received, total }); }
      });
      res.pipe(file);
      file.on('finish', () => {
        onProgress?.({ phase: 'download', pct: 100, received: total || received, total });
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      // Keep the partial file — a caller-level retry resumes from here.
      reject(err);
    });
    req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download stalled (no activity for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s)`));
    });
  });
}

const DOWNLOAD_MAX_ATTEMPTS = 6;

async function installWhisperModel({ name = DEFAULT_NAME, modelsDir: base, onProgress } = {}) {
  if (isModelPresent(name, base)) {
    onProgress?.({ phase: 'done', already: true, modelPath: modelPath(name, base) });
    return { alreadyPresent: true, modelPath: modelPath(name, base) };
  }
  const dir = modelsDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const dest = modelPath(name, base);
  const spec = modelSpec(name);

  checkDiskSpace(dir, spec.mb);

  onProgress?.({ phase: 'download', pct: 0 });

  const url = `${HF_BASE}/${spec.file}`;
  let total = 0;
  try { total = await headContentLength(url); } catch { /* fall back to the pipe's own content-length on first request */ }

  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    const startByte = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    try {
      await download(url, dest, onProgress, { startByte, total });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        onProgress?.({ phase: 'retry', attempt, maxAttempts: DOWNLOAD_MAX_ATTEMPTS, error: err.message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  if (lastErr) {
    throw new Error(`Download failed after ${DOWNLOAD_MAX_ATTEMPTS} attempts: ${lastErr.message}`);
  }

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
