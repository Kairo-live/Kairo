// KAIRO — Multi-language translation
//
// Two paths, matched to how confident each one can be:
//   1. Scripture (a real book/chapter/verse reference) → look up the actual
//      verse in a bundled public-domain/open-license translation. This is
//      the accurate path — real published wording, not a paraphrase.
//   2. Anything else (sermon slides, arbitrary text) → run it through a
//      dedicated translation model, since there's no fixed reference text to
//      look up. Engine order: the bundled local model (mt_engine.js — Opus-MT
//      via ONNX/@huggingface/transformers, ~110MB, downloaded on first use by
//      mt_installer.js) first, since it works out of the box with zero setup;
//      then a user's own Ollama install if they have one configured.
//      Matches this app's "nobody should need to pay or hand over a key"
//      design goal.
//
//      The bundled model is a dedicated seq2seq MT model (Opus-MT), not a
//      general chat LLM — an earlier version of this bundled a small Qwen2.5
//      chat model via node-llama-cpp, which was ~1GB and heavy enough on CPU
//      to visibly slow the whole machine down for a one-line translation.
//      A model built specifically for translation is both far smaller and
//      faster, since it isn't also carrying general conversational/reasoning
//      weights this feature never uses.
//
// See databases/i18n/SOURCES.md for what each bundled translation is and its
// license.
'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const mtEngine    = require('./mt_engine');
const mtInstaller = require('./mt_installer');

const I18N_DIR = path.join(__dirname, '..', 'databases', 'i18n');

const LANGUAGES = {
  fr: { name: 'French',     file: 'fr.json' },
  es: { name: 'Spanish',    file: 'es.json' },
  pt: { name: 'Portuguese', file: 'pt.json' },
};

const _bibleCache = new Map(); // lang -> parsed verse data

function loadBible(lang) {
  if (_bibleCache.has(lang)) return _bibleCache.get(lang);
  const spec = LANGUAGES[lang];
  if (!spec) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(I18N_DIR, spec.file), 'utf8'));
    _bibleCache.set(lang, data);
    return data;
  } catch {
    _bibleCache.set(lang, null);
    return null;
  }
}

// Real verse text in the target language — null if the reference or
// language isn't available, so the caller can fall back to AI translation.
function lookupVerse(book, chapter, verse, lang) {
  const bible = loadBible(lang);
  const chapters = bible?.[book];
  const text = chapters?.[chapter - 1]?.[verse - 1];
  return text || null;
}

// Small in-memory cache — a live service re-sends the same slide/verse
// repeatedly (re-opening a section, re-sending), and Ollama translation costs
// a few seconds of local inference per call. Shared across both engines — the
// cache key doesn't care which one produced the text.
const _aiCache = new Map(); // `${lang}|${text}` -> translated text
const AI_CACHE_MAX = 500;

const OLLAMA_TRANSLATE_TIMEOUT_MS = 15_000; // a single slide/verse line, not a whole sermon note

function translatePrompt(langName) {
  return `You translate live worship-service slide text into ${langName} for display alongside the English original. Translate faithfully and idiomatically — preserve the exact meaning, tone, and register (no summarizing, no adding or dropping content). Output ONLY the ${langName} translation, nothing else: no quotes, no notes, no explanation.`;
}

// Bundled model — no install step beyond the one-time per-language download
// (~108MB for French/Spanish, ~895MB for Portuguese — see mt_engine.js for
// why Portuguese alone is bigger), no per-request network call after that.
// Tried before Ollama since it's guaranteed to exist (once installed)
// rather than depending on the operator having set anything up themselves.
//
// Downloaded lazily per-language rather than at app bootstrap: most
// operators will only ever use one or two of the three languages, so
// pulling all of them for everyone would just relocate the "installer got
// huge" problem instead of solving it. The first-ever request for a given
// language kicks its download off in the background and falls through to
// Ollama for itself; once it finishes, every later request for that
// language resolves locally.
const _mtInstallStarted = new Set();
async function translateWithLocalLLM(text, lang) {
  if (!(await mtInstaller.isModelPresent(lang))) {
    if (!_mtInstallStarted.has(lang)) {
      _mtInstallStarted.add(lang);
      mtInstaller.installLLMModel({ lang }).catch((err) => {
        console.warn(`[Translate] Background local-model download failed (${lang}):`, err.message);
        _mtInstallStarted.delete(lang); // let a later request retry
      });
    }
    return null; // not downloaded yet — fall through
  }
  return mtEngine.translate(text, lang);
}

// Local, free, offline — tried first. `ollamaUrl` is always a real value
// (server.js's ollamaUrl() falls back to http://localhost:11434), so this
// runs whether or not the operator ever explicitly set up Ollama for
// translation specifically; it just fails fast (short timeout) if nothing's
// listening there, and the caller throws.
async function translateWithOllama(text, lang, ollamaUrl, model) {
  const langName = LANGUAGES[lang]?.name || lang;
  const r = await axios.post(`${ollamaUrl}/api/chat`, {
    model,
    stream: false,
    options: { temperature: 0.2 },
    messages: [
      { role: 'system', content: translatePrompt(langName) },
      { role: 'user', content: text },
    ],
  }, { timeout: OLLAMA_TRANSLATE_TIMEOUT_MS });
  return (r.data?.message?.content || '').trim();
}

// Top-level entry point for the /api/translate route.
// `ref` — { book, chapter, verse } when the source is scripture, else null.
// `ollamaUrl`/`ollamaModel` — server.js's ollamaUrl()/ollamaModel(), always a
// real value (falls back to http://localhost:11434) whether or not the
// operator ever set Ollama up specifically for translation.
async function translate({ text, lang, ref, ollamaUrl, ollamaModel }) {
  if (!LANGUAGES[lang]) throw Object.assign(new Error(`Unsupported language "${lang}"`), { code: 'UNSUPPORTED_LANGUAGE' });

  if (ref?.book && ref?.chapter && ref?.verse) {
    const verseText = lookupVerse(ref.book, ref.chapter, ref.verse, lang);
    if (verseText) return { text: verseText, source: 'bible' };
    // Reference didn't resolve (e.g. verse numbering differs) — fall through
    // to AI translation of the English text instead of returning nothing.
  }

  if (!text || !text.trim()) return { text: '', source: 'none' };

  const cacheKey = `${lang}|${text.trim()}`;
  if (_aiCache.has(cacheKey)) return { text: _aiCache.get(cacheKey), source: 'cache' };

  const remember = (translated, source) => {
    if (_aiCache.size > AI_CACHE_MAX) _aiCache.delete(_aiCache.keys().next().value);
    _aiCache.set(cacheKey, translated);
    return { text: translated, source };
  };

  // Bundled local model first — works with zero setup. Then a user's own
  // Ollama, if they've configured one. Claude only as a last resort. Each
  // step silently falls through to the next on failure; only run out of
  // options does this actually throw.
  try {
    const translated = await translateWithLocalLLM(text.trim(), lang);
    if (translated) return remember(translated, 'local');
  } catch (err) { console.warn('[Translate] Local model failed, falling through:', err.message); }

  if (ollamaUrl) {
    try {
      const translated = await translateWithOllama(text.trim(), lang, ollamaUrl, ollamaModel);
      if (translated) return remember(translated, 'ollama');
    } catch (err) { console.warn('[Translate] Ollama failed, falling through:', err.message); }
  }

  throw Object.assign(
    new Error('No translation engine available — the bundled local model is still downloading and Ollama is unavailable'),
    { code: 'NO_TRANSLATE_ENGINE' }
  );
}

module.exports = { translate, lookupVerse, LANGUAGES };
