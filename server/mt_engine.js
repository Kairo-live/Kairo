// KAIRO — Bundled local translation engine (@huggingface/transformers, ONNX)
//
// One model PER LANGUAGE, downloaded independently the first time that
// specific language is actually selected — a French-only operator never
// pays for Portuguese's download, matching the app's "pay only for what you
// use" design goal all the way down to individual languages.
//
// This replaced an earlier attempt at bundling a general Qwen2.5 chat model
// via node-llama-cpp (~1GB, slow enough on CPU to visibly bog the whole
// machine down for a one-line translation). Dedicated seq2seq MT models are
// both far smaller and faster, since they're built for exactly this job.
//
// Two model families, chosen per language after empirical testing:
//   - French/Spanish: Xenova/opus-mt-en-{fr,es} — dedicated bilingual Marian
//     models, ~107MB each, no target-language selection needed at all.
//   - Portuguese: Xenova/nllb-200-distilled-600M — ~895MB. Helsinki-NLP has
//     no small dedicated en→pt model with a trusted ONNX conversion (Xenova
//     hasn't published one, and the community ones on the Hub are from
//     unverified individual accounts). Helsinki's *multilingual* en-mul
//     model would cover pt in a much smaller file, but its target-language
//     selection works by prefixing the input text with a ">>por<<" control
//     token — verified empirically (see git history) that this library's
//     current MarianTokenizer doesn't handle that special token correctly
//     and produces garbled, unusable output. NLLB uses a proper
//     src_lang/tgt_lang parameter instead of manual text-prefixing, and a
//     real test round-trip against John 3:16 confirmed clean output, so
//     it's the larger but actually-correct option until a trustworthy small
//     en-pt conversion exists.
'use strict';

const path = require('path');

// @huggingface/transformers is ESM-only (confirmed the same way node-llama-cpp
// was: a plain require() throws on its top-level await), so it's loaded via
// dynamic import() and cached.
let _hfPromise = null;
function loadHf() {
  if (!_hfPromise) _hfPromise = import('@huggingface/transformers');
  return _hfPromise;
}

// lang -> { id, dir, mb, translate(translator, text) }. `dir` is this
// language's own cache subfolder, so each one installs/verifies/reports
// independently of the others.
const MODELS = {
  fr: {
    id: 'Xenova/opus-mt-en-fr', dir: 'opus-mt-en-fr', mb: 108,
    run: (translator, text) => translator(text),
  },
  es: {
    id: 'Xenova/opus-mt-en-es', dir: 'opus-mt-en-es', mb: 108,
    run: (translator, text) => translator(text),
  },
  pt: {
    id: 'Xenova/nllb-200-distilled-600M', dir: 'nllb-200-distilled-600M', mb: 895,
    run: (translator, text) => translator(text, { src_lang: 'eng_Latn', tgt_lang: 'por_Latn' }),
  },
};

function modelSpec(lang) {
  const spec = MODELS[lang];
  if (!spec) throw new Error(`Unsupported language "${lang}"`);
  return spec;
}

function cacheDir(lang) {
  const base = process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'models', 'mt')
    : path.join(__dirname, 'models', 'mt');
  return path.join(base, modelSpec(lang).dir);
}

const _translators = new Map();   // lang -> loaded pipeline
const _loadPromises = new Map();  // lang -> in-flight load promise

// `onProgress` receives the library's own {status, file, progress, loaded,
// total} events. `localOnly` — true for a passive presence check (throws
// instead of downloading if this language's files aren't cached yet).
async function ensureLoaded(lang, onProgress, localOnly = false) {
  if (_translators.has(lang)) return _translators.get(lang);
  // Keyed by localOnly too — otherwise a passive Settings-panel presence
  // check (local_files_only: true) racing a real download request for the
  // same language would share one in-flight promise, and whichever call
  // started first decides for both whether a download actually happens.
  const cacheKey = `${lang}:${localOnly}`;
  if (_loadPromises.has(cacheKey)) return _loadPromises.get(cacheKey);

  const spec = modelSpec(lang);
  const promise = (async () => {
    const { pipeline } = await loadHf();
    const translator = await pipeline('translation', spec.id, {
      dtype: 'q8',
      cache_dir: cacheDir(lang),
      local_files_only: localOnly,
      progress_callback: onProgress,
    });
    _translators.set(lang, translator);
    return translator;
  })();
  _loadPromises.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    _loadPromises.delete(cacheKey);
  }
}

function isReady(lang) { return _translators.has(lang); }

// Passive check — never triggers a download. Used by the Settings status
// panel, which polls this on every open; it must not silently start pulling
// however many hundred MB just because the operator looked at the pane. A
// successful check also leaves the model loaded (no wasted work — the next
// real translate() call reuses it instead of loading twice).
async function checkPresent(lang) {
  if (_translators.has(lang)) return true;
  try {
    await ensureLoaded(lang, null, true);
    return true;
  } catch {
    return false;
  }
}

async function translate(text, lang) {
  const spec = modelSpec(lang);
  const translator = await ensureLoaded(lang);
  const out = await spec.run(translator, text);
  const first = Array.isArray(out) ? out[0] : out;
  return (first?.translation_text || '').trim();
}

module.exports = { translate, ensureLoaded, isReady, checkPresent, cacheDir, MODELS };
