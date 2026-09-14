// sherpa-onnx offline-model installer — the GUI-driven counterpart to a
// manual download: {phase, pct} progress events, plus isModelPresent/
// modelPath/modelsDir accessors that server.js's /api/offline/* endpoints
// and the Settings installer UI read directly.
//
// The model ships as a single .tar.bz2, mirrored on our own GitHub releases
// (see MODEL_URL's own comment). After download it's extracted, the fp32
// encoder/joiner (only the int8 ones are used at runtime) and the test_wavs
// folder are pruned, and the versioned directory is renamed to the canonical
// name sherpa_engine.js looks for.
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { checkDiskSpace } = require('./disk_space');

// Mirrored on our own GitHub releases rather than pointed straight at
// upstream (k2-fsa/sherpa-onnx) — owner: "I thought we needed to host it, as
// long as we have control over the download and it's a consistent file
// everytime and we can update it." A third-party release asset can be
// renamed/pruned out from under us with zero warning; this one is ours, so
// the URL is stable and the file behind it never changes without MODEL_VERSION
// also changing (see below). Byte-identical to the upstream source at mirror
// time — verified via SHA-256 (78e2b79fcf7271553a74402a76b771b09ea40117a39566a79f52235b23db6358)
// — and licensed by NVIDIA Corporation under the NVIDIA Open Model License
// (https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/),
// which explicitly permits redistribution with attribution; see the release
// notes at https://github.com/Kairo-live/Kairo/releases/tag/offline-model-v1
// for the full notice and source link.
const MODEL_URL =
  'https://github.com/Kairo-live/Kairo/releases/download/offline-model-v1/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25.tar.bz2';
const ARCHIVE_TOP_DIR = 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25';
const CANONICAL_DIR   = 'sherpa-streaming-en';
const APPROX_MB       = 465;   // the .tar.bz2 download; extracted int8 set is ~662MB

// Bump this (alongside MODEL_URL, and ARCHIVE_TOP_DIR/REQUIRED_FILES if the
// new archive's own layout differs) whenever a new model is mirrored to our
// releases — see "How do we update the on-device model" below. A plain
// string, not semver — nothing parses or compares it beyond equality.
const MODEL_VERSION = 'v1';
// Written into the installed model directory after a successful install so
// a later run can tell "a model is present" (isModelPresent) apart from
// "the CURRENT model is present" (needsUpdate) — the two were conflated
// before this, so publishing a new MODEL_URL would never actually reach
// anyone who'd already installed the old one; the install button would just
// keep reporting "✓ installed" forever. THIS is how an update actually
// reaches an existing install: bump MODEL_VERSION + MODEL_URL here, publish
// the new file to a new (or updated) GitHub release, ship that code change —
// isModelPresent() alone stays true (the old files are still real and
// working), but needsUpdate() now returns true, the Settings UI switches
// from "✓ Offline model installed" to an "Update available" state, and
// clicking it re-runs installSherpaModel(), which now genuinely re-downloads
// (see the version check in installSherpaModel's short-circuit below) rather
// than immediately reporting "already installed" and doing nothing.
const VERSION_MARKER_FILE = '.kairo-model-version';

// The four files sherpa_engine.js requires (must match its MODEL_FILES).
const REQUIRED_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
];
// Pruned after extraction — just the bundled samples + readme (no fp32
// duplicates in this tarball, everything ships int8).
const PRUNE = [
  'test_wavs',
  'README.md',
];

function modelsDir(base) {
  return base || (process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'models')
    : path.join(__dirname, 'models'));
}

function modelDir(base) {
  return path.join(modelsDir(base), CANONICAL_DIR);
}

// server.js's /api/offline/status returns this — it's a directory here.
function modelPath(base) {
  return modelDir(base);
}

function isModelPresent(base) {
  try {
    const dir = modelDir(base);
    for (const f of REQUIRED_FILES) if (!fs.existsSync(path.join(dir, f))) return false;
    return fs.statSync(path.join(dir, 'encoder.int8.onnx')).size > 5_000_000;
  } catch {
    return false;
  }
}

// Absent for every install that predates this version-tracking change —
// treated as "some unknown older version," which correctly reports
// needsUpdate()=true rather than silently assuming it's current.
function installedVersion(base) {
  try {
    return fs.readFileSync(path.join(modelDir(base), VERSION_MARKER_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// A model is present AND it's the current MODEL_VERSION. See MODEL_VERSION's
// own comment above for how a real update actually reaches an existing
// install via this check.
function needsUpdate(base) {
  return isModelPresent(base) && installedVersion(base) !== MODEL_VERSION;
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_ATTEMPTS = 6;

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

// Resumable, retrying download.
function download(url, dest, onProgress, { maxRedirects = 5, startByte = 0, total = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (total > 0 && startByte >= total) {
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
      if (res.statusCode === 200 && startByte > 0) {
        file.close();
        return download(url, dest, onProgress, { maxRedirects, startByte: 0, total }).then(resolve, reject);
      }
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
    }).on('error', (err) => { file.close(); reject(err); });
    req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download stalled (no activity for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s)`));
    });
  });
}

function extractTarBz2(archivePath, intoDir) {
  return new Promise((resolve, reject) => {
    // `tar` with bzip2 support is present on macOS (bsdtar), Linux (GNU tar),
    // and Windows 10+ (bsdtar). -j handles .bz2.
    execFile('tar', ['xjf', archivePath, '-C', intoDir], (err, _stdout, stderr) => {
      if (err) return reject(new Error(`tar extract failed: ${stderr || err.message}`));
      resolve();
    });
  });
}

async function installSherpaModel({ modelsDir: base, onProgress } = {}) {
  // Only short-circuit when the CURRENT version is already installed — a
  // present-but-outdated model (needsUpdate()=true) falls through and
  // re-downloads for real, which is the whole point of version-tracking
  // this at all (see MODEL_VERSION's own comment). Explicitly re-checked
  // here rather than just calling needsUpdate() so the "nothing to do" path
  // still reads as one clear condition.
  if (isModelPresent(base) && installedVersion(base) === MODEL_VERSION) {
    onProgress?.({ phase: 'done', already: true, modelPath: modelDir(base) });
    return { alreadyPresent: true, modelPath: modelDir(base) };
  }
  const dir = modelsDir(base);
  fs.mkdirSync(dir, { recursive: true });
  checkDiskSpace(dir, APPROX_MB * 2);   // download + extracted, transiently

  const archive = path.join(dir, 'sherpa-en.tar.bz2');
  onProgress?.({ phase: 'download', pct: 0 });

  let total = 0;
  try { total = await headContentLength(MODEL_URL); } catch { /* fall back to stream's own length */ }

  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    const startByte = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
    try {
      await download(MODEL_URL, archive, onProgress, { startByte, total });
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
  if (lastErr) throw new Error(`Download failed after ${DOWNLOAD_MAX_ATTEMPTS} attempts: ${lastErr.message}`);

  onProgress?.({ phase: 'extract' });
  const extractedTop = path.join(dir, ARCHIVE_TOP_DIR);
  try { fs.rmSync(extractedTop, { recursive: true, force: true }); } catch {}
  await extractTarBz2(archive, dir);
  if (!fs.existsSync(extractedTop)) {
    throw new Error('Extraction produced no model directory');
  }

  // Prune duplicates + samples, then move into place atomically-ish.
  for (const f of PRUNE) {
    try { fs.rmSync(path.join(extractedTop, f), { recursive: true, force: true }); } catch {}
  }
  const finalDir = modelDir(base);
  try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch {}
  fs.renameSync(extractedTop, finalDir);
  try { fs.unlinkSync(archive); } catch {}

  if (!isModelPresent(base)) {
    throw new Error('Model files missing after extraction — the archive layout may have changed.');
  }
  // Record what got installed so a future run (possibly after MODEL_VERSION
  // bumps in a later app update) can tell this is now current.
  try { fs.writeFileSync(path.join(finalDir, VERSION_MARKER_FILE), MODEL_VERSION); } catch {}
  onProgress?.({ phase: 'done', already: false, modelPath: finalDir });
  return { alreadyPresent: false, modelPath: finalDir };
}

module.exports = {
  installSherpaModel,
  isModelPresent,
  needsUpdate,
  installedVersion,
  modelPath,
  modelsDir,
  modelDir,
  MODEL_URL,
  MODEL_VERSION,
  approxMB: () => APPROX_MB,
};
