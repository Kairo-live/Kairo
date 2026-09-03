// KAIRO — Media library
//
// Two ways media gets into the app:
//   1. A direct upload/drop with no folder target — lands in the general
//      "bin" (MEDIA_BIN_DIR), copied into app data like any other asset.
//   2. A "smart folder" — a real, Finder-browsable directory KAIRO watches
//      and reflects whatever's in it. The normal path (createFolder) has the
//      operator just name it — KAIRO creates a fresh directory under
//      ~/Documents/Kairo Media and watches it from the start, so anything
//      later dropped in from Finder, another app's export, a USB stick,
//      whatever, shows up here automatically. addFolder (linking a folder
//      that already exists somewhere else on disk — an existing ProPresenter
//      media folder, a Dropbox sync) is still the underlying primitive both
//      go through. Either way KAIRO never owns these files as its own copy;
//      dropping a file onto a smart folder INSIDE the app writes it into the
//      real directory, so the folder stays the single source of truth
//      whether it's edited from Finder or from KAIRO.
'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { checkDiskSpace } = require('./disk_space');

const APP_DATA = process.env.KAIRO_APP_DATA_DIR || path.join(__dirname, '..', 'databases');
const MEDIA_BIN_DIR   = path.join(APP_DATA, 'media', 'bin');
const FOLDERS_MANIFEST = path.join(APP_DATA, 'media', 'folders.json');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);

function kindForExt(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function ensureDirs() {
  fs.mkdirSync(MEDIA_BIN_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(FOLDERS_MANIFEST), { recursive: true });
}

// ── Smart folders manifest ──────────────────────────────────────────────
let folders = [];      // [{ id, name, dirPath }]
const watchers = new Map(); // id -> fs.FSWatcher

function loadFolders() {
  try {
    folders = JSON.parse(fs.readFileSync(FOLDERS_MANIFEST, 'utf8'));
    if (!Array.isArray(folders)) folders = [];
  } catch { folders = []; }
}

function saveFolders() {
  ensureDirs();
  fs.writeFileSync(FOLDERS_MANIFEST, JSON.stringify(folders, null, 2));
}

// `onChange(folderId)` fires on any add/remove/rename inside a watched
// directory — debounced, since editors/OS file managers tend to emit several
// events in a burst for one logical change (e.g. a temp file + rename).
const WATCH_RETRY_MS = 15000;
const WATCH_MAX_RETRIES = 5;   // a permanently-unwatchable path (some cloud mounts) must not retry forever
const WATCH_DEBOUNCE_MS = 800; // cloud folders (Google Drive, iCloud) fire events in long bursts on sync

function watchFolder(folder, onChange, attempt = 0) {
  if (watchers.has(folder.id)) return;
  const retry = (why) => {
    watchers.delete(folder.id);
    if (attempt + 1 >= WATCH_MAX_RETRIES) {
      console.warn(`[Media] Giving up watching "${folder.dirPath}" after ${WATCH_MAX_RETRIES} tries (${why}). ` +
        `Its contents still load on open, just not live-refresh.`);
      return;
    }
    if (findFolder(folder.id)) setTimeout(() => watchFolder(folder, onChange, attempt + 1), WATCH_RETRY_MS);
  };
  try {
    let t = null;
    const watcher = fs.watch(folder.dirPath, { persistent: true }, () => {
      clearTimeout(t);
      t = setTimeout(() => onChange(folder.id), WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', (err) => {
      console.warn(`[Media] Watch error on "${folder.dirPath}", will retry:`, err.message);
      retry(err.message);
    });
    watchers.set(folder.id, watcher);
  } catch (err) {
    console.warn(`[Media] Could not watch folder "${folder.dirPath}":`, err.message);
    retry(err.message);
  }
}

function initFolders(onChange) {
  ensureDirs();
  loadFolders();
  folders.forEach(f => watchFolder(f, onChange));
}

function listFolders() {
  return folders.map(f => ({ id: f.id, name: f.name, path: f.dirPath }));
}

// Shared tail for both ways a folder becomes a registered smart folder —
// linking an existing one (addFolder) and creating a brand-new one
// (createFolder) — so there's one registration/watch implementation, not two.
function registerFolder(name, resolved, onChange) {
  const folder = { id: crypto.randomUUID(), name: name || path.basename(resolved), dirPath: resolved };
  folders.push(folder);
  saveFolders();
  watchFolder(folder, onChange);
  return folder;
}

function addFolder(name, dirPath, onChange) {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw Object.assign(new Error('Not a valid folder path'), { code: 'BAD_FOLDER' });
  }
  return registerFolder(name, resolved, onChange);
}

// The operator names a folder; KAIRO creates it (a real, Finder-browsable
// directory, not the hidden internal APP_DATA store) and starts watching it
// immediately — the flow the app-created "+ Smart Folder" button uses today,
// as opposed to addFolder's "link something that already exists" path.
function createFolder(name, onChange) {
  const safeName = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim() || 'New folder';
  const root = path.join(os.homedir(), 'Documents', 'Kairo Media');
  const resolved = path.resolve(root, safeName);
  // Belt-and-suspenders against a name like "..": resolved must still land
  // inside `root`, same escape guard resolveFileInFolder uses elsewhere.
  if (!(resolved + path.sep).startsWith(root + path.sep) && resolved !== root) {
    throw Object.assign(new Error('Invalid folder name'), { code: 'BAD_FOLDER' });
  }
  fs.mkdirSync(resolved, { recursive: true });
  // A same-named folder that's already registered is just reused rather than
  // duplicated — non-destructive, matches this file's general style.
  const existing = folders.find(f => f.dirPath === resolved);
  if (existing) return existing;
  return registerFolder(name, resolved, onChange);
}

function removeFolder(id) {
  const before = folders.length;
  folders = folders.filter(f => f.id !== id);
  saveFolders();
  const w = watchers.get(id);
  if (w) { w.close(); watchers.delete(id); }
  return folders.length !== before;
}

function findFolder(id) { return folders.find(f => f.id === id) || null; }

// Directory listing for a smart folder — scanned live on each request rather
// than cached, since the whole point is that it reflects the real folder;
// the fs.watch callback just tells callers WHEN to re-fetch this.
// Async (fs.promises) rather than readdirSync/statSync — this backs an HTTP
// endpoint the UI polls, and a smart folder with thousands of files would
// otherwise block the single event loop (stalling live transcript/
// translation delivery) on every request.
// Hard ceiling on how many files one smart folder contributes to the UI —
// a folder pointed at a large tree (a whole Google Drive, a Photos export)
// would otherwise fan out into thousands of <img> requests and thousands of
// stat() calls, and on a cloud/virtual filesystem (Google Drive File
// Provider, iCloud) each of those can block on a network round-trip. This
// keeps the app responsive; the operator can point at a tighter folder.
const MAX_FOLDER_ITEMS = 600;
const STAT_BATCH = 48;

async function listFolderItems(id) {
  const folder = findFolder(id);
  if (!folder) return null;
  let names = [];
  try { names = await fs.promises.readdir(folder.dirPath); } catch { return []; }

  // Filter to media by extension FIRST (no filesystem call), then cap,
  // before doing any stat() — the expensive part on a cloud folder.
  let media = names
    .map(name => ({ name, kind: kindForExt(path.extname(name).toLowerCase()) }))
    .filter(m => m.kind);
  const truncated = media.length > MAX_FOLDER_ITEMS;
  if (truncated) media = media.slice(0, MAX_FOLDER_ITEMS);

  const items = [];
  for (let i = 0; i < media.length; i += STAT_BATCH) {
    const batch = media.slice(i, i + STAT_BATCH);
    const stated = await Promise.all(batch.map(async ({ name, kind }) => {
      let mtimeMs = 0;
      try { mtimeMs = (await fs.promises.stat(path.join(folder.dirPath, name))).mtimeMs; } catch {}
      return { name, kind, mtimeMs, url: `/api/media/folders/${folder.id}/file/${encodeURIComponent(name)}` };
    }));
    items.push(...stated);
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (truncated) items.truncated = true;
  return items;
}

// Resolves a requested filename to a real path INSIDE the folder's root,
// rejecting anything that would escape it (../, absolute paths, etc.) —
// the filename comes straight from a URL segment, so this is the one thing
// standing between a client and arbitrary file reads. Also resolves symlinks
// and re-checks against the real root — a symlink placed inside a watched
// folder pointing outside it would otherwise pass the string-prefix check
// and get served through the file route.
function resolveFileInFolder(id, name) {
  const folder = findFolder(id);
  if (!folder) return null;
  const full = path.resolve(folder.dirPath, name);
  const root = folder.dirPath + path.sep;
  if (!full.startsWith(root)) return null;
  if (!fs.existsSync(full)) return null;
  let real, realRoot;
  try {
    real = fs.realpathSync(full);
    realRoot = fs.realpathSync(folder.dirPath) + path.sep;
  } catch { return null; }
  return real.startsWith(realRoot) ? real : null;
}

// Write a dropped/uploaded file's bytes into a smart folder's real directory
// — the app never keeps its own copy for these, matching "the folder is the
// source of truth" above. fs.watch on the folder will pick this up and fire
// onChange on its own; no separate notification needed here.
// Async — an upload can be a multi-hundred-MB video; writeFileSync would
// block the event loop (and any live audio/translation streaming) for the
// full write.
async function writeIntoFolder(id, filename, buffer) {
  const folder = findFolder(id);
  if (!folder) throw Object.assign(new Error('No such folder'), { code: 'NOT_FOUND' });
  const safeName = path.basename(filename); // strip any path components
  const ext = path.extname(safeName).toLowerCase();
  if (!kindForExt(ext)) throw Object.assign(new Error(`Unsupported file type "${ext}"`), { code: 'BAD_TYPE' });
  // Exact size in hand already (whole buffer is in memory) — no need for the
  // installers' approximate pre-download estimate.
  checkDiskSpace(folder.dirPath, buffer.length / (1024 * 1024));
  const dest = path.join(folder.dirPath, safeName);
  try {
    await fs.promises.writeFile(dest, buffer);
  } catch (err) {
    // A failed write (e.g. ENOSPC mid-write) can still leave a truncated
    // file behind — clean it up so it doesn't show up as a corrupt media
    // item the next time this folder is listed.
    await fs.promises.unlink(dest).catch(() => {});
    throw err;
  }
}

// ── General bin (no folder — direct upload/drop) ────────────────────────
async function listBinItems() {
  ensureDirs();
  let names = [];
  try { names = await fs.promises.readdir(MEDIA_BIN_DIR); } catch { return []; }
  const items = await Promise.all(names.map(async (name) => {
    const ext = path.extname(name).toLowerCase();
    const kind = kindForExt(ext);
    if (!kind) return null;
    let mtimeMs = 0;
    try { mtimeMs = (await fs.promises.stat(path.join(MEDIA_BIN_DIR, name))).mtimeMs; } catch {}
    return { name, kind, mtimeMs, url: `/api/media/bin/file/${encodeURIComponent(name)}` };
  }));
  return items.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function resolveBinFile(name) {
  const full = path.resolve(MEDIA_BIN_DIR, name);
  const root = MEDIA_BIN_DIR + path.sep;
  if (!full.startsWith(root)) return null;
  if (!fs.existsSync(full)) return null;
  let real, realRoot;
  try {
    real = fs.realpathSync(full);
    realRoot = fs.realpathSync(MEDIA_BIN_DIR) + path.sep;
  } catch { return null; }
  return real.startsWith(realRoot) ? real : null;
}

async function writeToBin(filename, buffer) {
  ensureDirs();
  const ext = path.extname(filename).toLowerCase();
  if (!kindForExt(ext)) throw Object.assign(new Error(`Unsupported file type "${ext}"`), { code: 'BAD_TYPE' });
  // Exact size in hand already (whole buffer is in memory) — no need for the
  // installers' approximate pre-download estimate.
  checkDiskSpace(MEDIA_BIN_DIR, buffer.length / (1024 * 1024));
  const safeName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${path.basename(filename)}`;
  const dest = path.join(MEDIA_BIN_DIR, safeName);
  try {
    await fs.promises.writeFile(dest, buffer);
  } catch (err) {
    // A failed write (e.g. ENOSPC mid-write) can still leave a truncated
    // file behind — clean it up so it doesn't show up as a corrupt media
    // item the next time the bin is listed.
    await fs.promises.unlink(dest).catch(() => {});
    throw err;
  }
  return safeName;
}

function deleteBinItem(name) {
  const full = resolveBinFile(name);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

module.exports = {
  kindForExt,
  initFolders, listFolders, addFolder, createFolder, removeFolder, findFolder,
  listFolderItems, resolveFileInFolder, writeIntoFolder,
  listBinItems, resolveBinFile, writeToBin, deleteBinItem,
};
