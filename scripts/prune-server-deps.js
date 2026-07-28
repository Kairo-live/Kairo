#!/usr/bin/env node
// Strips build-time-only weight out of server/node_modules before it gets
// bundled into the Tauri app (tauri.conf.json copies the whole `server/`
// directory in as a resource — see the "resources" key — so anything left in
// node_modules ships in the installer verbatim).
//
// Two passes:
//   1. A package-specific trim for smart-whisper: whisper.cpp compiles from
//      source via node-gyp, and that leaves ~20MB of submodule source,
//      intermediate .o build objects, and header-only build deps that are
//      never touched again once build/Release/smart-whisper.node exists.
//      Confirmed empirically that `require('smart-whisper')` still resolves
//      correctly after this trim (see whisper_installer.js commit notes).
//   2. A generic sweep across all installed packages for content that's
//      real weight but never read at runtime: markdown docs, changelogs,
//      source maps, test suites, CI config, and editor/VCS cruft that
//      occasionally ships inside a published tarball.
//
// Safe to run repeatedly — everything it deletes is regenerable by a clean
// `npm ci`, so this should run AFTER install and BEFORE `tauri build` reads
// the directory as a bundle resource (wired into the build via
// beforeBuildCommand and the CI workflow).
'use strict';

const fs   = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const NODE_MODULES = path.join(SERVER_DIR, 'node_modules');

function rm(p) {
  if (!fs.existsSync(p)) return 0;
  const before = duBytes(p);
  fs.rmSync(p, { recursive: true, force: true });
  return before;
}

function duBytes(p) {
  let total = 0;
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(p)) total += duBytes(path.join(p, entry));
  }
  return total;
}

function fmtMB(bytes) { return (bytes / 1_000_000).toFixed(1) + 'MB'; }

// ── Pass 1: smart-whisper-specific trim ──────────────────────────────────
function pruneSmartWhisper() {
  const dir = path.join(NODE_MODULES, 'smart-whisper');
  if (!fs.existsSync(dir)) return 0;
  let saved = 0;
  // Full source/build-tool directories not touched at runtime.
  for (const sub of ['whisper.cpp', 'src', 'node-addon-api', 'scripts']) {
    saved += rm(path.join(dir, sub));
  }
  saved += rm(path.join(dir, 'binding.gyp'));
  // build/Release/smart-whisper.node is the ONLY thing under build/ that
  // dist/index.js actually requires at runtime — everything else there is
  // node-gyp's own bookkeeping (object files, Makefiles, dep-tracking).
  const release = path.join(dir, 'build', 'Release');
  saved += rm(path.join(release, 'obj.target'));
  saved += rm(path.join(release, '.deps'));
  saved += rm(path.join(release, 'nothing.a'));
  for (const f of ['Makefile', 'binding.Makefile', 'config.gypi', 'gyp-mac-tool', 'smart-whisper.target.mk']) {
    saved += rm(path.join(dir, 'build', f));
  }
  return saved;
}

// ── Pass 2: generic bloat sweep across every installed package ───────────
const PRUNE_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'example', 'examples', 'docs', 'doc',
  '.github', '.circleci', '.vscode', '.idea', 'coverage',
]);
const PRUNE_FILE_RE = /\.(map)$/i;
const PRUNE_FILE_NAMES_RE = /^(CHANGELOG|HISTORY|CONTRIBUTING|CODE_OF_CONDUCT)(\.\w+)?$|^\.(travis|npmignore)\.yml$/i;
const MARKDOWN_RE = /\.mdx?$/i;

function sweep(dir) {
  let saved = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }

  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.bin') continue; // symlinked CLI shims — leave alone
      if (PRUNE_DIR_NAMES.has(entry.name.toLowerCase())) { saved += rm(p); continue; }
      saved += sweep(p); // recurse (covers nested node_modules and scoped @org/ dirs)
    } else if (entry.isFile()) {
      // Never touch LICENSE files — small, and required for legal redistribution.
      if (/^licen[sc]e/i.test(entry.name)) continue;
      if (PRUNE_FILE_RE.test(entry.name) || PRUNE_FILE_NAMES_RE.test(entry.name) || MARKDOWN_RE.test(entry.name)) {
        saved += rm(p);
      }
    }
  }
  return saved;
}

function main() {
  if (!fs.existsSync(NODE_MODULES)) {
    console.log('[prune] server/node_modules not found — run npm install first.');
    return;
  }
  const before = duBytes(NODE_MODULES);
  const whisperSaved = pruneSmartWhisper();
  const sweepSaved = sweep(NODE_MODULES);
  const after = duBytes(NODE_MODULES);

  console.log(`[prune] smart-whisper trim: ${fmtMB(whisperSaved)}`);
  console.log(`[prune] generic sweep:      ${fmtMB(sweepSaved)}`);
  console.log(`[prune] node_modules: ${fmtMB(before)} → ${fmtMB(after)} (saved ${fmtMB(before - after)})`);
}

main();
