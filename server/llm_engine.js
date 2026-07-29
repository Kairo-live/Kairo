// KAIRO — Bundled local translation engine (node-llama-cpp)
//
// Runs a small local Qwen2.5-Instruct GGUF model (see llm_installer.js) via
// node-llama-cpp's native llama.cpp bindings — same integration shape as
// whisper_engine.js/smart-whisper: a lazily-loaded native package, a
// friendly install-hint error if it's missing, model loaded once and reused.
//
// node-llama-cpp ships as an ESM-only package (confirmed empirically: a
// plain require() throws ERR_REQUIRE_ASYNC_MODULE) while this server is
// CommonJS, so it's loaded via dynamic import() rather than require() —
// the standard way a CJS module pulls in an ESM-only dependency.
//
// This exists so Multi-Language translation works out of the box with no
// setup (no Ollama install, no API key) — see translate.js for how this
// slots into the translation fallback chain (local model → Ollama → Claude).
'use strict';

let _llama = null;      // Llama instance (native backend), loaded once
let _model = null;      // loaded GGUF model, keyed by path so a model swap reloads
let _modelPath = null;
let _loadPromise = null;
let _nlcPromise = null; // cached dynamic import() of the ESM-only package

function loadNlc() {
  if (!_nlcPromise) {
    _nlcPromise = import('node-llama-cpp').catch(() => {
      throw new Error('node-llama-cpp is not installed. Run: npm i node-llama-cpp');
    });
  }
  return _nlcPromise;
}

async function ensureLoaded(modelPath) {
  if (_model && _modelPath === modelPath) return _model;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const { getLlama } = await loadNlc();
    if (!_llama) _llama = await getLlama();
    const model = await _llama.loadModel({ modelPath });
    _model = model;
    _modelPath = modelPath;
    return model;
  })();

  try {
    return await _loadPromise;
  } finally {
    _loadPromise = null;
  }
}

// One-shot chat completion — loads a fresh context per call rather than
// holding a persistent session, since translation requests are independent
// (no multi-turn conversation to carry) and this keeps memory bounded when
// idle between slides.
async function chat(modelPath, systemPrompt, userMessage) {
  const { LlamaChatSession } = await loadNlc();
  const model = await ensureLoaded(modelPath);
  const context = await model.createContext();
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });
    return (await session.prompt(userMessage)).trim();
  } finally {
    await context.dispose();
  }
}

module.exports = { chat, ensureLoaded };
