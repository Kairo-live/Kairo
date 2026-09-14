// Semantic-layer ("meaning-based Candidates") installer — same NDJSON
// {phase, pct}/{phase:'done'} shape the offline-model and MT installers
// use. Two real steps, unlike either of those installers' single
// one-download-and-done:
//   1. Download embeddinggemma-300m (ONNX, ~197MB) via semantic_engine.js's
//      installModel() — same @huggingface/transformers cache_dir mechanism
//      mt_engine.js uses, so this reuses that library's own resumable HTTP
//      client rather than a bespoke one.
//   2. Build the verse-embeddings index (server/build_verse_embeddings.mjs)
//      — a one-time ~31k-verse embedding pass that needs the model from
//      step 1, run as a child process (it's a standalone ESM script, and
//      the only consumer that needs the model loaded with remote access
//      briefly allowed, which the runtime pipeline here otherwise never
//      does — see semantic_engine.js's ensureLoaded staying local-only).
//
// Fixes a real gap, not a hypothetical one: neither the model nor the
// embeddings file ships in the Tauri bundle or is tracked in git (see
// .gitignore) — a fresh install had NO path to ever get the semantic layer
// working, silently, forever (semantic_engine.ensureLoaded's error was only
// ever logged to the console, never surfaced to an operator). This is that
// missing path, mirroring the offline-model/MT installers' existing pattern
// instead of inventing a third one.
'use strict';

const path  = require('path');
const { spawn } = require('child_process');
const { checkDiskSpace } = require('./disk_space');
const semanticEngine = require('./semantic_engine');

const MODEL_APPROX_MB = 200;      // model_q4.onnx_data, ~197MB
const EMBED_APPROX_MB = 100;      // verse_embeddings.f32, ~91MB
const BUILD_SCRIPT = path.join(__dirname, 'build_verse_embeddings.mjs');

function isModelPresent()     { return semanticEngine.isModelPresent(); }
function embeddingsPresent()  { return semanticEngine.embeddingsPresent(); }
function isFullyInstalled()   { return isModelPresent() && embeddingsPresent(); }

// Runs build_verse_embeddings.mjs as a child process rather than importing
// it — it's a standalone ESM script (see its own header comment for why:
// server/node_modules resolution), and running it out-of-process also means
// a failure here can't take the whole server down with it, just this one
// install attempt.
// "[Embed] 480/31008 (52.3/s, ETA 585s)" — pull the running count out of
// the script's own log lines rather than teaching it a second, machine-
// readable progress protocol just for this one caller. Returns an integer
// percent, or null for any line that isn't a progress line. Exported as a
// standalone function purely so it's unit-testable without spawning a
// child process.
function parseEmbedProgressPct(line) {
  const m = line.match(/\[Embed\]\s+(\d+)\/(\d+)\b/);
  if (!m) return null;
  return Math.floor((Number(m[1]) / Number(m[2])) * 100);
}

function runEmbeddingsBuild(onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILD_SCRIPT], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
    });
    let stderr = '';
    let lastPct = -1;
    const handleLine = (line) => {
      const pct = parseEmbedProgressPct(line);
      if (pct === null) return;
      if (pct !== lastPct) { lastPct = pct; onProgress?.({ phase: 'embed', pct }); }
    };
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Embedding build exited with code ${code}${stderr ? ': ' + stderr.slice(-500) : ''}`));
    });
  });
}

async function installSemanticLayer({ onProgress } = {}) {
  if (isFullyInstalled()) {
    onProgress?.({ phase: 'done', already: true });
    return { alreadyPresent: true };
  }

  if (!isModelPresent()) {
    checkDiskSpace(path.join(__dirname, '..', 'databases', 'bibles'), MODEL_APPROX_MB + EMBED_APPROX_MB);

    // The library reports progress per-file (config/tokenizer/onnx weights
    // each 0-100 on their own) — average across whichever files it's told
    // us about so far, same approach mt_installer.js uses, so the bar reads
    // as one steady sweep instead of restarting for each file.
    const fileProgress = new Map();
    onProgress?.({ phase: 'download', pct: 0 });
    await semanticEngine.installModel((evt) => {
      if (evt?.status !== 'progress' || typeof evt.progress !== 'number') return;
      fileProgress.set(evt.file, evt.progress);
      const values = [...fileProgress.values()];
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      onProgress?.({ phase: 'download', pct: Math.floor(avg) });
    });

    if (!isModelPresent()) {
      throw new Error('Model download completed but the weights file looks missing/truncated — try again.');
    }
  }

  if (!embeddingsPresent()) {
    onProgress?.({ phase: 'embed', pct: 0 });
    await runEmbeddingsBuild(onProgress);
    if (!embeddingsPresent()) {
      throw new Error('Embedding build finished but verse_embeddings.f32 is still missing — check server logs.');
    }
  }

  onProgress?.({ phase: 'done', already: false });
  return { alreadyPresent: false };
}

module.exports = {
  installSemanticLayer, isModelPresent, embeddingsPresent, isFullyInstalled,
  parseEmbedProgressPct,
};
