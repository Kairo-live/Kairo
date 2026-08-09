// Ollama one-click installer — macOS + Windows. Same NDJSON progress-bar
// shape as whisper_installer.js/mt_installer.js so the frontend's existing
// install-progress UI pattern applies here unchanged.
//
// Ollama is fundamentally different from the Whisper model or the bundled
// MT model: those are plain files Kairo can download and use directly.
// Ollama is a full standalone server application — on macOS it ships as a
// signed .app, on Windows as a GUI installer (.exe). Neither can be
// silently, fully installed with zero user interaction: macOS Gatekeeper
// expects the user to approve a downloaded .app at least once, and the
// Windows installer is a native NSIS-style dialog with its own "Install"
// button. This is the deliberate "one-click GUIDED" tradeoff scoped with
// the user: Kairo automates the download (and, on macOS, launches the .app
// directly rather than making the user find it in Downloads), but the
// native one-time install/approval step still happens through the OS's own
// UI — that's a platform constraint, not something worth trying to defeat.
'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { checkDiskSpace } = require('./disk_space');

// No activity (not even a data event) for this long → treat the connection
// as stalled. Same guard as the other installers — without it a stalled
// CDN connection leaves the install promise (and the progress UI) hanging
// forever with no way to retry.
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

// Official installers, straight from ollama.com — no mirror, no version
// pinning (Ollama itself self-updates after install on both platforms, so
// pinning a version here would just go stale).
const DOWNLOADS = {
  darwin: { url: 'https://ollama.com/download/Ollama-darwin.zip', file: 'Ollama-darwin.zip', approxMB: 400 },
  win32:  { url: 'https://ollama.com/download/OllamaSetup.exe',   file: 'OllamaSetup.exe',   approxMB: 400 },
};

function platformKey() { return process.platform; } // 'darwin' | 'win32' | ...
function supported()   { return !!DOWNLOADS[platformKey()]; }

function downloadDir(base) {
  return base || (process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'downloads')
    : path.join(os.tmpdir(), 'kairo-ollama-install'));
}

// Follows redirects (ollama.com's download links 302 to a CDN). Identical
// shape to whisper_installer.js's download() — kept as its own copy rather
// than a shared import since the two installers otherwise have nothing in
// common and a shared module would just be indirection for one function.
function download(url, dest, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
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
    req.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download stalled (no activity for ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s)`));
    });
  });
}

// macOS: unzip → Ollama.app, then `open` it directly. Launching the .app
// starts Ollama's background server immediately (it runs as a menu-bar
// app) — the user doesn't have to manually drag it to /Applications first
// for it to actually start working, though macOS will still show its own
// one-time "downloaded from the internet" confirmation on first launch,
// which Kairo has no way to (and shouldn't try to) skip past.
async function installMac(dest, onProgress) {
  const dir = path.dirname(dest);
  onProgress?.({ phase: 'extract' });
  await new Promise((resolve, reject) => {
    execFile('/usr/bin/unzip', ['-o', dest, '-d', dir], (err) => (err ? reject(err) : resolve()));
  });
  const appPath = path.join(dir, 'Ollama.app');
  if (!fs.existsSync(appPath)) throw new Error('Ollama.app not found after extracting the download');
  onProgress?.({ phase: 'launch' });
  await new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [appPath], (err) => (err ? reject(err) : resolve()));
  });
}

// Windows: run the downloaded installer directly. It's a standard GUI
// installer with its own "Install" button — Kairo can't (and shouldn't try
// to) silently drive it past the user; that one click through the native
// dialog is the actual "guided" half of "one-click guided".
async function installWindows(dest, onProgress) {
  onProgress?.({ phase: 'launch' });
  await new Promise((resolve, reject) => {
    try {
      const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.unref();
      resolve();
    } catch (err) { reject(err); }
  });
}

async function installOllama({ downloadsDir: base, onProgress } = {}) {
  const key  = platformKey();
  const spec = DOWNLOADS[key];
  if (!spec) {
    throw new Error(`Ollama auto-install isn't available on this platform (${key}) — install manually from ollama.com`);
  }

  const dir  = downloadDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, spec.file);

  checkDiskSpace(dir, spec.approxMB);

  onProgress?.({ phase: 'download', pct: 0 });
  await download(spec.url, dest, onProgress);

  if (key === 'darwin')      await installMac(dest, onProgress);
  else if (key === 'win32')  await installWindows(dest, onProgress);

  // Not "done" — the OS-native install/approval step (drag to Applications
  // on macOS, click through the installer on Windows) still has to happen
  // on the user's side. The caller polls /api/llm/status afterward to know
  // when Ollama actually becomes reachable.
  onProgress?.({ phase: 'launched' });
  return { launched: true };
}

module.exports = { installOllama, supported, platformKey };
