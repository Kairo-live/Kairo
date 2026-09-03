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
// auto-send decision. See databases/logos/build_verse_embeddings.mjs for
// how the corpus-side vectors were produced (same model, same settings, so
// query and corpus vectors are directly comparable).
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, '..', 'databases', 'logos');
const EMB_BIN      = path.join(DATA_DIR, 'verse_embeddings.f32');
const EMB_META     = path.join(DATA_DIR, 'verse_embeddings.json');
const MODEL_DIR    = path.join(DATA_DIR, 'model', 'embeddinggemma');

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

// Kicks off model + corpus loading in the background. Safe to call more
// than once — subsequent calls reuse the in-flight/completed promise.
// Deliberately NOT awaited by detection_worker's init() — the fast lexical
// layers (direct/verbatim/fingerprint/anchor) must stay on their existing
// startup timeline; this loads a ~200MB model on top and shouldn't delay
// "seconds to screen" for the very start of a service. isReady() is the
// gate every caller checks instead.
function ensureLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (!fs.existsSync(EMB_BIN) || !fs.existsSync(EMB_META)) {
      throw new Error('verse_embeddings.f32/.json not found — run server/build_verse_embeddings.mjs first');
    }
    const meta = JSON.parse(fs.readFileSync(EMB_META, 'utf8'));
    _dims  = meta.dims;
    _count = meta.count;

    const buf = fs.readFileSync(EMB_BIN);
    _corpus = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (_corpus.length !== _count * _dims) {
      throw new Error(`verse_embeddings.f32 size mismatch: expected ${_count * _dims} floats, got ${_corpus.length}`);
    }

    const { pipeline, env } = await loadHf();
    env.allowLocalModels  = true;
    env.allowRemoteModels = false;
    env.localModelPath    = path.dirname(MODEL_DIR);
    _extractor = await pipeline('feature-extraction', path.basename(MODEL_DIR), {
      local_files_only: true,
      dtype: 'q4',
    });
    console.log(`[Semantic] Ready — ${_count} verse embeddings (${_dims}d) + model loaded.`);
  })();
  return _loadPromise;
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

module.exports = { ensureLoaded, isReady, embed, search };
