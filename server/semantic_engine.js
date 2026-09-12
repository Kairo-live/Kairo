// KAIRO — Semantic embedding engine for the Candidates ("Context") layer.
//
// The lexical layers (verbatim, fingerprint) all work by word overlap —
// they can only ever notice that the preacher used similar VOCABULARY to a
// verse. This layer instead compares MEANING: it embeds whatever's being
// said into the same vector space as every verse in the Bible (via the
// bundled embeddinggemma-300m model) and finds the nearest ones by cosine
// similarity, so "God made the heavens and the earth in the very
// beginning" can surface Genesis 1:1 even though it shares almost no
// literal words with it.
//
// This is suggestions-only, same as fingerprint — it never drives an
// auto-send decision. See databases/bibles/build_verse_embeddings.mjs for
// how the corpus-side vectors were produced (same model, same settings, so
// query and corpus vectors are directly comparable).
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'databases', 'bibles');
const EMB_BIN      = path.join(DATA_DIR, 'verse_embeddings.f32');
const EMB_META     = path.join(DATA_DIR, 'verse_embeddings.json');
// cache_dir root, NOT the model's own folder — @huggingface/transformers
// nests every download under <cache_dir>/<org>/<repo>/... itself (confirmed
// against mt_engine.js's real on-disk layout, e.g.
// models/mt/opus-mt-en-fr/Xenova/opus-mt-en-fr/...), so MODEL_DIR below is
// derived, not something ensureLoaded/installModel pass in directly.
const MODEL_CACHE_BASE = path.join(DATA_DIR, 'model');
const MODEL_ID         = 'onnx-community/embeddinggemma-300m-ONNX';
const MODEL_DIR         = path.join(MODEL_CACHE_BASE, ...MODEL_ID.split('/'));
const MODEL_WEIGHTS_FILE = path.join(MODEL_DIR, 'onnx', 'model_q4.onnx_data');

// @huggingface/transformers is ESM-only — same dynamic-import pattern
// mt_engine.js already uses for the same reason.
let _hfPromise = null;
function loadHf() {
  if (!_hfPromise) _hfPromise = import('@huggingface/transformers');
  return _hfPromise;
}

let _extractor   = null;   // loaded pipeline
let _loadPromise = null;
let _corpus       = null;   // Float32Array, flat [verseCount * dims]
let _dims          = 0;
let _count          = 0;
// Serializes retryLoaded() calls (see the comment on retryLoaded below) —
// starts resolved so the first call's .then() runs on the next microtask
// with nothing to wait for.
let _retryChain = Promise.resolve();

// Passive, local-files-only presence check — a real file-existence test,
// not a pipeline load, so a Settings-panel status poll never risks
// triggering network access or the ~1-2s ONNX session init just to answer
// "is this installed yet?".
function isModelPresent() {
  return fs.existsSync(MODEL_WEIGHTS_FILE) && fs.statSync(MODEL_WEIGHTS_FILE).size > 1_000_000;
}
function embeddingsPresent() { return fs.existsSync(EMB_BIN) && fs.existsSync(EMB_META); }

// Kicks off model + corpus loading in the background. Safe to call more
// than once — subsequent calls reuse the in-flight/completed promise.
// Deliberately NOT awaited by detection_worker's init() — the fast lexical
// layers (direct/verbatim/fingerprint/anchor) must stay on their existing
// startup timeline; this loads a ~200MB model on top and shouldn't delay
// "seconds to screen" for the very start of a service. isReady() is the
// gate every caller checks instead. Never downloads anything itself
// (local_files_only: true) — semantic_installer.js is the only path that
// fetches the model/builds the embeddings on a fresh install; this only
// ever loads what's already on disk, and fails soft (isReady() stays
// false, semanticSearch calls just no-op) when nothing's there yet.
// ensureLoaded() caches its promise forever, including a REJECTED one — a
// server that booted before the installer ever ran would otherwise be
// stuck replaying that same "not found" failure for the rest of the
// process's life even after semantic_installer.js finishes. Called once,
// right after a successful install, from the same worker process that
// actually serves semanticSearch (see detection_worker.js's 'reloadSemantic'
// handler) — retryLoaded() must run there, not in server.js's main
// process, since this whole module's state is per-process/per-thread.
//
// Chains onto _retryChain rather than resetting state immediately — two
// retryLoaded() calls back to back (e.g. two 'reloadSemantic' worker
// messages) would otherwise both see the same in-flight/stale _loadPromise,
// both reset it, and both start their own ensureLoaded() concurrently: two
// loads racing over the same module-level _extractor/_corpus, with
// isReady() able to flip true on whichever happens to finish first and the
// other's late completion silently overwriting it afterward. Chaining off
// a shared promise (rather than just awaiting whatever _loadPromise was at
// call time) closes that gap — each retry's reset+reload only begins once
// the previous one has fully finished, so at most one load ever runs.
function retryLoaded() {
  _retryChain = _retryChain.catch(() => {}).then(() => {
    _loadPromise = null;
    _extractor = null;
    _corpus = null;
    return ensureLoaded();
  });
  return _retryChain;
}

function ensureLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (!embeddingsPresent()) {
      throw new Error('verse_embeddings.f32/.json not found — run the semantic-layer installer (Settings) or server/build_verse_embeddings.mjs first');
    }
    const meta = JSON.parse(fs.readFileSync(EMB_META, 'utf8'));
    _dims  = meta.dims;
    _count = meta.count;

    const buf = fs.readFileSync(EMB_BIN);
    _corpus = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (_corpus.length !== _count * _dims) {
      throw new Error(`verse_embeddings.f32 size mismatch: expected ${_count * _dims} floats, got ${_corpus.length}`);
    }

    const { pipeline } = await loadHf();
    _extractor = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q4',
      cache_dir: MODEL_CACHE_BASE,
      local_files_only: true,
    });
    console.log(`[Semantic] Ready — ${_count} verse embeddings (${_dims}d) + model loaded.`);
  })();
  return _loadPromise;
}

// The one path that's allowed to hit the network — used only by
// semantic_installer.js. `onProgress` receives the library's own
// {status, file, progress, loaded, total} events, same shape mt_engine.js
// already forwards for the MT installer's progress bar.
async function installModel(onProgress) {
  const { pipeline } = await loadHf();
  await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q4',
    cache_dir: MODEL_CACHE_BASE,
    local_files_only: false,
    progress_callback: onProgress,
  });
}

function isReady() { return !!(_extractor && _corpus); }

// Embeds arbitrary text into the same space as the corpus. Returns a plain
// Float32Array (already unit-normalized — pooling:'mean', normalize:true,
// matching how the corpus itself was built).
async function embed(text) {
  const out = await _extractor(text, { pooling: 'mean', normalize: true });
  return out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
}

// Top-K nearest verses by cosine similarity. Since every stored vector
// (corpus AND query) is unit-normalized, cosine similarity reduces to a
// plain dot product — no per-candidate division needed, just a tight
// multiply-accumulate loop over the flat Float32Array.
async function search(text, limit = 5) {
  if (!isReady()) return [];
  const q = await embed(text);
  const dims = _dims;

  // Track top-K with a simple insertion-sorted small array — limit is
  // always small (≤10), so this beats sorting all 31k scores.
  const top = []; // [{idx, score}], descending
  for (let i = 0; i < _count; i++) {
    const base = i * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += q[d] * _corpus[base + d];
    if (top.length < limit || dot > top[top.length - 1].score) {
      let pos = top.length;
      while (pos > 0 && top[pos - 1].score < dot) pos--;
      top.splice(pos, 0, { idx: i, score: dot });
      if (top.length > limit) top.pop();
    }
  }
  return top;
}

module.exports = {
  ensureLoaded, retryLoaded, isReady, embed, search,
  isModelPresent, embeddingsPresent, installModel,
  MODEL_DIR, MODEL_WEIGHTS_FILE, EMB_BIN, EMB_META,
};
