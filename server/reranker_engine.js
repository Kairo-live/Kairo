// KAIRO — Cross-encoder reranker for a real auto-send signal on paraphrase.
//
// Semantic search (semantic_engine.js) embeds the transcript and each verse
// SEPARATELY, then compares the two vectors by cosine similarity — a
// bi-encoder. That's fast enough to scan all ~31k verses, but cosine
// similarity has no absolute-confidence analogue the way verbatim/stream's
// matchedIdf does (see detection_scoring.js's own comment: "no absolute-
// evidence analogue to matchedIdf exists yet for cosine similarity") — which
// is exactly why semantic stays Candidates-only regardless of score.
//
// A cross-encoder instead scores the transcript and ONE candidate verse
// TOGETHER, in a single forward pass — the two texts attend to each other
// directly, not through two independently-collapsed vectors. This is the
// standard second-stage precision layer in production hybrid retrieval
// (BM25/dense retrieve, cross-encoder rerank) specifically because it
// discriminates "is THIS pair really a match" far better than bi-encoder
// cosine similarity — real confidence, not just "found something similar."
// Only ever run over a handful of ALREADY-short-listed candidates (from
// verbatim/fingerprint/semantic), never the full corpus — that's what makes
// it affordable despite being much more expensive per-pair than a dot product.
//
// Model: cross-encoder/ms-marco-MiniLM-L-12-v2 (Xenova ONNX port,
// int8-quantized, ~34MB) — FlashRank's own "best cross-encoder" pick.
// Same install/load split as semantic_engine.js: this module only ever
// loads what's already on disk (local_files_only: true, fails soft);
// reranker_installer.js is the only path that fetches it.
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'databases', 'bibles');
// Same cache_dir convention as semantic_engine.js — @huggingface/transformers
// nests every download under <cache_dir>/<org>/<repo>/..., so MODEL_DIR
// below is derived, not passed in directly.
const MODEL_CACHE_BASE  = path.join(DATA_DIR, 'reranker_model');
const MODEL_ID           = 'Xenova/ms-marco-MiniLM-L-12-v2';
const MODEL_DIR          = path.join(MODEL_CACHE_BASE, ...MODEL_ID.split('/'));
const MODEL_WEIGHTS_FILE = path.join(MODEL_DIR, 'onnx', 'model_int8.onnx');

let _hfPromise = null;
function loadHf() {
  if (!_hfPromise) _hfPromise = import('@huggingface/transformers');
  return _hfPromise;
}

let _tokenizer   = null;
let _model       = null;
let _loadPromise = null;
let _retryChain  = Promise.resolve();

function isModelPresent() {
  return fs.existsSync(MODEL_WEIGHTS_FILE) && fs.statSync(MODEL_WEIGHTS_FILE).size > 1_000_000;
}

function isReady() { return !!(_tokenizer && _model); }

// Mirrors semantic_engine.js's retryLoaded() exactly — chains onto a shared
// promise so two back-to-back reload requests (e.g. two 'reloadReranker'
// worker messages) can't both reset state and race their own loads.
function retryLoaded() {
  _retryChain = _retryChain.catch(() => {}).then(() => {
    _loadPromise = null;
    _tokenizer = null;
    _model = null;
    return ensureLoaded();
  });
  return _retryChain;
}

function ensureLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (!isModelPresent()) {
      throw new Error('Reranker model not found — run the reranker installer (Settings) first.');
    }
    const { AutoTokenizer, AutoModelForSequenceClassification } = await loadHf();
    const opts = { dtype: 'int8', cache_dir: MODEL_CACHE_BASE, local_files_only: true };
    _tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, opts);
    _model     = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, opts);
    console.log('[Reranker] Ready — cross-encoder loaded.');
  })();
  return _loadPromise;
}

// The one path allowed to hit the network — used only by
// reranker_installer.js, same split as semantic_engine.js's installModel().
async function installModel(onProgress) {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await loadHf();
  const opts = { dtype: 'int8', cache_dir: MODEL_CACHE_BASE, local_files_only: false, progress_callback: onProgress };
  await AutoTokenizer.from_pretrained(MODEL_ID, opts);
  await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, opts);
}

// Scores `query` against each of `passages` (plain strings) — returns a
// plain array of relevance scores in [0,1] (sigmoid of the model's raw
// logit; this model was trained on a single-logit relevance head, not a
// softmax over classes, so sigmoid is the correct squash, not softmax).
// Batched into one tokenizer/model call, not one per passage — the whole
// point of only ever calling this over a handful of already-short-listed
// candidates is that the batch stays small enough for one forward pass to
// be cheap.
async function score(query, passages) {
  if (!isReady() || !passages || !passages.length) return [];
  const features = _tokenizer(
    new Array(passages.length).fill(query),
    { text_pair: passages, padding: true, truncation: true }
  );
  const { logits } = await _model(features);
  const raw = logits.data instanceof Float32Array ? logits.data : Float32Array.from(logits.data);
  // logits is [batch, 1] for this model's single-relevance-score head.
  return Array.from(raw).map(x => 1 / (1 + Math.exp(-x)));
}

module.exports = {
  ensureLoaded, retryLoaded, isReady, score,
  isModelPresent, installModel,
  MODEL_DIR, MODEL_WEIGHTS_FILE,
};
