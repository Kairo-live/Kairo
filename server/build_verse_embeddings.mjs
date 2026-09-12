// KAIRO — one-time build step: embeds every verse in map.json with the
// bundled embeddinggemma-300m model and writes a flat Float32 binary index
// (verse_embeddings.f32, one 768-dim vector per verse, in map.json's index
// order) plus a small sidecar JSON with the dims/count/model id, so the
// detection worker can read it directly at startup with zero per-verse
// inference cost.
//
// This is the missing half of the semantic ("Context suggestions") layer —
// the model was already bundled but nothing consumed it. Run once (or
// whenever map.json's verse set changes); the runtime side (semantic_engine)
// only ever reads this cached output, never re-embeds the whole Bible.
//
// Lives in server/ (not scripts/) so its @huggingface/transformers import
// resolves against server/node_modules — Node's ESM resolution walks up
// from the importing FILE's own location, and that package is only
// installed there, not at the repo root (see server/package.json).
//
// Usage: node server/build_verse_embeddings.mjs
'use strict';
import { pipeline } from '@huggingface/transformers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, '..', 'databases', 'bibles');
const MAP_PATH   = path.join(DATA_DIR, 'map.json');
const OUT_BIN    = path.join(DATA_DIR, 'verse_embeddings.f32');
const OUT_META   = path.join(DATA_DIR, 'verse_embeddings.json');
// Must match semantic_engine.js's MODEL_CACHE_BASE/MODEL_ID — a
// @huggingface/transformers cache_dir nests every download under
// <cache_dir>/<org>/<repo>/... itself, so this is that resolved path, not
// a directory this script owns the shape of.
const MODEL_CACHE_BASE = path.join(DATA_DIR, 'model');
const MODEL_ID   = 'onnx-community/embeddinggemma-300m-ONNX';
const MODEL_DIR  = path.join(MODEL_CACHE_BASE, ...MODEL_ID.split('/'));

const RE_HEADING = /\[[^\]]*\]/g;   // [A Psalm of David.] etc — not spoken, strip before embedding
const BATCH_SIZE = 48;

async function main() {
  const t0 = Date.now();
  console.log('[Embed] Loading map.json…');
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const verses = raw.verses;
  console.log(`[Embed] ${verses.length} verses to embed.`);

  console.log('[Embed] Loading embeddinggemma…');
  const extractor = await pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q4',
    cache_dir: MODEL_CACHE_BASE,
    local_files_only: true,
  });
  console.log(`[Embed] Model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

  // Figure out the embedding dimension from a single probe call.
  const probe = await extractor(verses[0].kjv_text, { pooling: 'mean', normalize: true });
  const DIMS = probe.dims[probe.dims.length - 1];
  console.log(`[Embed] Embedding dimension: ${DIMS}`);

  const out = new Float32Array(verses.length * DIMS);
  out.set(probe.data, 0);

  let done = 1;
  const tEmbedStart = Date.now();
  for (let start = 1; start < verses.length; start += BATCH_SIZE) {
    const batch = verses.slice(start, start + BATCH_SIZE);
    const texts = batch.map(v => (v.kjv_text || '').replace(RE_HEADING, ' ').trim() || v.kjv_text || '.');
    const result = await extractor(texts, { pooling: 'mean', normalize: true });
    // result.dims = [batchLen, DIMS]; result.data is a flat Float32Array of batchLen*DIMS
    out.set(result.data, start * DIMS);
    done += batch.length;

    if (done % (BATCH_SIZE * 10) < BATCH_SIZE || done === verses.length) {
      const elapsed = (Date.now() - tEmbedStart) / 1000;
      const rate    = done / elapsed;
      const eta     = (verses.length - done) / rate;
      console.log(`[Embed] ${done}/${verses.length} (${rate.toFixed(1)}/s, ETA ${eta.toFixed(0)}s)`);
    }
  }

  fs.writeFileSync(OUT_BIN, Buffer.from(out.buffer));
  fs.writeFileSync(OUT_META, JSON.stringify({
    count: verses.length,
    dims: DIMS,
    model: 'embeddinggemma-300m (local, q4)',
    builtAt: new Date().toISOString(),
    source: 'map.json kjv_text, heading-stripped',
  }, null, 2));

  console.log(`[Embed] Wrote ${OUT_BIN} (${(out.byteLength / 1024 / 1024).toFixed(1)} MB) and ${OUT_META}`);
  console.log(`[Embed] Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => { console.error('[Embed] FAILED:', err); process.exit(1); });
