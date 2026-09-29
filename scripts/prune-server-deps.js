#!/usr/bin/env node
// Strips build-time-only weight out of server/node_modules before it gets
// bundled into the Tauri app (tauri.conf.json copies the whole `server/`
// directory in as a resource — see the "resources" key — so anything left in
// node_modules ships in the installer verbatim).
//
// Passes:
//   1. Whole-package removal for dependencies that are pulled in
//      transitively (so `npm uninstall` isn't an option — they'd just come
//      back on the next install) but are provably never require()'d by the
//      code path this app actually runs. Currently: onnxruntime-web (109MB)
//      — @huggingface/transformers lists it as a hard dependency because its
//      published bundle covers both a browser/WASM build and a Node build,
//      but confirmed directly against the compiled Node entry point
//      (transformers.node.cjs) that the string "onnxruntime-web" only ever
//      appears in a source-map-style comment and a browser-only WASM CDN
//      URL template — zero real `require("onnxruntime-web")` calls. The
//      actual Node runtime path loads `onnxruntime-node` only.
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
// The offline STT model (sherpa_engine.js/sherpa_installer.js) is meant to
// be download-on-demand — installSherpaModel() fetches it from our own
// GitHub release straight into the real per-user app-data directory at
// runtime, never into server/models/ in a real packaged app (that path is
// only the dev fallback when KAIRO_APP_DATA_DIR isn't set — see
// sherpa_engine.js's defaultModelDir()). But server/models/ IS gitignored,
// not bundle-ignored: if a dev machine happens to have it cached locally
// from testing (631MB), tauri.conf.json's blanket "../server": "server"
// resource copy ships it in the DMG anyway, silently defeating the whole
// point of the installer flow. Real incident: a release build came out at
// 1.4GB with this model included verbatim.
const SERVER_MODELS = path.join(SERVER_DIR, 'models');

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

// ── Pass 1: whole-package removal (confirmed dead at runtime) ───────────
const DEAD_PACKAGES = ['onnxruntime-web'];

function pruneDeadPackages() {
  let saved = 0;
  for (const name of DEAD_PACKAGES) saved += rm(path.join(NODE_MODULES, name));
  return saved;
}

// ── Pass 1b: sharp (image processing) → a stub ──────────────────────────
// @huggingface/transformers imports sharp when it loads (a top-level
// `import sharp from "sharp"`, and it throws if that comes back empty), but
// only ever calls it for image models — Kairo runs text models only. The
// real package loads its native libvips (the @img/* platform packages,
// ~16MB) the moment it's required, so it's swapped for a stub that only
// fails if something actually asks it to process an image.
function stubImageLibrary() {
  const dir = path.join(NODE_MODULES, 'sharp');
  if (!fs.existsSync(dir)) return 0;
  if (fs.existsSync(path.join(dir, 'kairo-stub'))) return 0;
  const before = duBytes(dir) + (fs.existsSync(path.join(NODE_MODULES, '@img')) ? duBytes(path.join(NODE_MODULES, '@img')) : 0);
  rm(dir);
  rm(path.join(NODE_MODULES, '@img'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kairo-stub'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.0.0-kairo-stub', main: 'index.js' }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'index.js'),
    "// Stand-in for sharp — see scripts/prune-server-deps.js. Kairo runs text\n"
    + "// models only; nothing should ever get here.\n"
    + "'use strict';\n"
    + "module.exports = function sharp() { throw new Error('Image processing is not included in Kairo'); };\n");
  return before - duBytes(dir);
}

// ── Pass 2: generic bloat sweep across every installed package ───────────
// Native binaries for other platforms. onnxruntime-node ships prebuilt
// libraries for every OS/arch it supports (bin/napi-v*/<platform>/<arch>) —
// ~175MB of Linux and Windows DLLs in a Mac build. Keeps the platform/arch
// being built: Tauri passes TAURI_ENV_PLATFORM/TAURI_ENV_ARCH to
// beforeBuildCommand (so a cross-build keeps the target's, not this
// machine's); with no recognizable arch (e.g. a universal Mac build) every
// arch of the platform is kept.
function buildTarget() {
  const plat = { darwin: 'darwin', macos: 'darwin', windows: 'win32', win32: 'win32', linux: 'linux' }[process.env.TAURI_ENV_PLATFORM] || process.platform;
  const envArch = process.env.TAURI_ENV_ARCH;
  const arch = envArch ? ({ aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', x64: 'x64' }[envArch] || null) : process.arch;
  return { plat, arch };
}
function pruneOtherPlatforms() {
  const { plat, arch } = buildTarget();
  let saved = 0;
  const binRoot = path.join(NODE_MODULES, 'onnxruntime-node', 'bin');
  let napiDirs = [];
  try { napiDirs = fs.readdirSync(binRoot); } catch { return 0; }
  for (const napi of napiDirs) {
    const napiDir = path.join(binRoot, napi);
    let plats = [];
    try { plats = fs.readdirSync(napiDir); } catch { continue; }
    for (const p of plats) {
      if (p !== plat) { saved += rm(path.join(napiDir, p)); continue; }
      if (!arch) continue;
      for (const a of fs.readdirSync(path.join(napiDir, p))) if (a !== arch) saved += rm(path.join(napiDir, p, a));
    }
  }
  return saved;
}

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
  // Locally-cached offline model — see SERVER_MODELS's own comment above.
  // Always ships downloaded fresh via the installer; never belongs in a
  // release bundle regardless of what a dev machine happens to have cached.
  const modelSaved = rm(SERVER_MODELS);
  if (modelSaved) console.log(`[prune] server/models (offline STT model, download-on-demand): ${fmtMB(modelSaved)}`);

  if (!fs.existsSync(NODE_MODULES)) {
    // Not a warning-and-continue case: a DMG built without this would launch
    // to a permanently blank window (real incident — express itself missing
    // at runtime, so the Node sidecar dies before ever binding its port,
    // and the webview's initial localhost:7777 navigation just never
    // resolves). beforeBuildCommand now always runs `npm install` first, but
    // fail loudly here too in case this script is ever invoked standalone.
    console.error('[prune] server/node_modules not found — the bundle would ship with no server dependencies. Run npm install in server/ first.');
    process.exit(1);
  }
  const before = duBytes(NODE_MODULES);
  const deadPackageSaved = pruneDeadPackages();
  const imageSaved = stubImageLibrary();
  const platformSaved = pruneOtherPlatforms();
  const sweepSaved = sweep(NODE_MODULES);
  const after = duBytes(NODE_MODULES);

  console.log(`[prune] dead packages:      ${fmtMB(deadPackageSaved)}`);
  console.log(`[prune] sharp → stub:       ${fmtMB(imageSaved)}`);
  console.log(`[prune] other platforms:    ${fmtMB(platformSaved)} (kept ${buildTarget().plat}/${buildTarget().arch || 'every arch'})`);
  console.log(`[prune] generic sweep:      ${fmtMB(sweepSaved)}`);
  console.log(`[prune] node_modules: ${fmtMB(before)} → ${fmtMB(after)} (saved ${fmtMB(before - after)})`);
}

main();
