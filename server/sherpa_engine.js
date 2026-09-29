// KAIRO — Offline STT engine (sherpa-onnx + NVIDIA Nemotron streaming)
//
// Runs a streaming TRANSDUCER model (same architectural class as Deepgram's
// own): it consumes audio frame-by-frame, keeps an internal encoder-state
// cache, and emits tokens as they're recognized — each audio frame processed
// exactly once, no re-transcription. That's what gets transcript behavior
// matching Deepgram's continuous word-by-word delivery, the stated bar for
// the offline fallback: "consistent behavior and similar performance, not a
// huge gap."
//
// Model: NVIDIA Nemotron Speech Streaming en 0.6b (560ms chunk, int8 ONNX).
// A first attempt used an old LibriSpeech streaming zipformer — it streamed
// fine but mangled real sermon audio badly enough that scripture detection
// couldn't match the corpus ("if ye be willing and obedient" → "VIOLENT
// OBEDIENT", ALL-CAPS, no punctuation). Nemotron is a 2026 model purpose-
// built for CPU streaming, benchmarked as the strongest option for this, and
// crucially emits natural casing + punctuation, which the detection pipeline
// downstream leans on for sentence segmentation.
//
// Public interface server.js's startOffline()/feedOfflineAudio()/
// stopOffline() drive, and everything downstream of handleTranscriptSegment
// consumes unchanged:
//   new SherpaEngine({ modelDir, language, onPartial, onFinal, onError })
//   .start()   async, throws a coded error the server maps to a friendly msg
//   .feed(buffer)   PCM s16le, 16 kHz, mono, Node Buffer
//   .stop()    async
//
// Audio contract: 16 kHz mono signed-16-bit PCM in; sherpa-onnx wants
// Float32 in [-1, 1] with a { samples, sampleRate } shape, converted on the
// way in.
'use strict';

const path = require('path');
const { collectGarbage } = require('./collect_garbage');
const fs   = require('fs');
const os   = require('os');

const SAMPLE_RATE = 16000;

// How often to pump the decoder and check for new text / an endpoint. The
// model itself streams continuously; this is just the JS-side polling
// cadence for surfacing partials. 120ms keeps partials feeling live without
// spinning the event loop.
const POLL_INTERVAL_MS = 120;

// Text rolls in and locks in the order it was said, not at pauses: in a
// service there is rarely real silence (organ, congregation, a fast
// preacher), and locking only after a pause let one line grow to 72 words /
// 25 s, whose citations and quotes then all fired at once when it locked.
// The model never revises a word once it has emitted it (measured: 0 of 502
// updates over 10 min of sermon audio changed an earlier word), so all but
// the newest few words lock as soon as they arrive. The newest words stay
// live — the last one may still be growing ("indefati" → "indefatigable") —
// and only that short tail waits for the endpoint.
const LIVE_TAIL_WORDS = 4;   // newest words kept live (interim)
const MIN_LOCK_WORDS  = 3;   // lock in runs of at least this many words

// Resetting the stream costs the model its context: the words right after a
// reset come out wrong or go missing. Resetting at every 1.2 s pause (10 min
// of sermon audio) lost 107 words — 28.6% word difference from Deepgram's
// transcript of the same audio vs 22.0% with no resets. A pause now only
// locks the live tail; the stream is reset at a pause once it has run this
// many words, which keeps its text bounded at no measurable cost (22.3%).
const RESET_AFTER_WORDS = 300;

// ── PCM s16le (mono) → Float32 [-1, 1] ──────────────────────────────────────
function pcm16ToFloat32(buf) {
  const n   = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// The three transducer files + tokens list sherpa-onnx needs, by the names
// they carry inside the Nemotron model tarball (all shipped int8).
const MODEL_FILES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner:  'joiner.int8.onnx',
  tokens:  'tokens.txt',
};

// Nemotron's feature frontend is 128-dim mel (the zipformer's was 80) — a
// mismatch here silently feeds the encoder garbage, so it's load-bearing.
const FEATURE_DIM = 128;

function defaultModelDir() {
  const base = process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'models')
    : path.join(__dirname, 'models');
  // Engine-neutral dir name so a future model swap doesn't need a rename.
  return path.join(base, 'sherpa-streaming-en');
}

// A model dir is "present" when all four required files exist and the encoder
// (the big one) is a plausible size — guards a half-finished extraction the
// same way sherpa_installer.js's own isModelPresent() check does.
function isModelPresent(dir = defaultModelDir()) {
  try {
    for (const f of Object.values(MODEL_FILES)) {
      if (!fs.existsSync(path.join(dir, f))) return false;
    }
    return fs.statSync(path.join(dir, MODEL_FILES.encoder)).size > 5_000_000;
  } catch {
    return false;
  }
}

// The recognizer config. The utterance-end pause comes from the treatments
// server.js shares with every engine. Decoding stays greedy: sherpa-onnx
// supports only greedy_search for NeMo transducers like Nemotron, and asking for
// modified_beam_search (which vocabulary hotwords require) makes the native
// library exit the whole process — so vocabulary for this engine is applied on
// the text side, by the reference parser's own mishearing fixes.
function recognizerConfig(modelDir, { utteranceEndMs = 1200 } = {}) {
  const p = (f) => path.join(modelDir, MODEL_FILES[f]);
  return {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      transducer: { encoder: p('encoder'), decoder: p('decoder'), joiner: p('joiner') },
      tokens: p('tokens'),
      numThreads: Math.max(1, Math.min(4, (os.cpus().length || 4) - 2)),
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    // Endpoint = a pause: lock the live tail (words otherwise lock as they
    // arrive, see LIVE_TAIL_WORDS) and maybe reset (RESET_AFTER_WORDS). rule2
    // uses the same pause Deepgram's utterance_end_ms does. No length cap
    // (rule3): it would reset the model mid-sentence.
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,  // silence after nothing decoded yet
    rule2MinTrailingSilence: utteranceEndMs / 1000,
    rule3MinUtteranceLength: 1e6,
  };
}

// ── The loaded model, shared ──────────────────────────────────────────────
// A recognizer holds the loaded model: ~1.1 GB of native memory, 1.2 s to
// load. That memory is only freed when its JS handle is garbage-collected,
// and V8 has no reason to collect a handle that small — measured: a stopped
// engine kept all of it, and each Start after a Stop loaded another copy
// beside the last (1.9 GB after two). So one recognizer serves every session
// (each gets its own stream): a restart is instant and never doubles up, and
// it's released RELEASE_AFTER_MS after the last session stops, with a
// collection so the memory actually goes back.
const RELEASE_AFTER_MS = 2 * 60 * 1000;
let sharedRecognizer = null;   // { key, recognizer }
let releaseTimer = null;

async function acquireRecognizer(OnlineRecognizer, modelDir, opts) {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  const key = JSON.stringify([modelDir, opts]);
  if (sharedRecognizer?.key !== key) {
    if (sharedRecognizer) {
      // Settings changed: let the old model go before loading the new one,
      // or both are in memory at once. Its native memory is freed by
      // finalizers that run after a collection, hence the wait.
      sharedRecognizer = null;
      collectGarbage();
      await new Promise(r => setTimeout(r, 1100));
    }
    sharedRecognizer = { key, recognizer: new OnlineRecognizer(recognizerConfig(modelDir, opts)) };
  }
  return sharedRecognizer.recognizer;
}

function releaseRecognizerSoon() {
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    sharedRecognizer = null;
    collectGarbage();
  }, RELEASE_AFTER_MS);
  releaseTimer.unref?.();
}

class SherpaEngine {
  // opts:
  //   modelDir  — dir holding the extracted streaming-zipformer model files
  //   language  — accepted for parity; the en model is monolingual so unused
  //   onPartial(text)  — the live tail: words not locked yet
  //   onFinal(text, { speechFinal })
  //                    — words locked, in the order they were said; without
  //                      speechFinal the live tail continues right after them
  //   onError(err)
  constructor(opts = {}) {
    // `modelPath` accepted as an alias so server.js's
    // `new OfflineEngine({ modelPath, ... })` call needs no further change.
    this.modelDir = opts.modelDir || opts.modelPath || defaultModelDir();
    this.language = opts.language || 'en';
    this.utteranceEndMs = opts.utteranceEndMs || 1200;
    this.onPartial = opts.onPartial || (() => {});
    this.onFinal   = opts.onFinal   || (() => {});
    this.onError   = opts.onError   || (() => {});

    this._recognizer = null;
    this._stream     = null;
    this._timer      = null;
    this._running    = false;
    this._lastPartial = '';
    this._locked     = 0;   // words of the current utterance already locked
  }

  async start() {
    if (!isModelPresent(this.modelDir)) {
      const e = new Error(`Offline model not found at ${this.modelDir}`);
      e.code = 'OFFLINE_MODEL_MISSING'; // reuse the code server.js already maps
      throw e;
    }
    let OnlineRecognizer;
    try {
      ({ OnlineRecognizer } = require('sherpa-onnx-node'));
    } catch (err) {
      const e = new Error('sherpa-onnx-node is not installed. Run: npm i sherpa-onnx-node');
      e.code = 'OFFLINE_BINDING_MISSING';
      throw e;
    }

    this._recognizer = await acquireRecognizer(OnlineRecognizer, this.modelDir, { utteranceEndMs: this.utteranceEndMs });
    try {
      this._stream = this._recognizer.createStream();
    } catch (err) {
      // No session after all: the model mustn't stay loaded waiting for one.
      this._recognizer = null;
      releaseRecognizerSoon();
      throw err;
    }
    this._lastPartial = '';
    this._locked = 0;
    this._running = true;
    this._timer = setInterval(() => this._pump(), POLL_INTERVAL_MS);
  }

  feed(buffer) {
    if (!this._running || !this._stream || !buffer || !buffer.length) return;
    try {
      this._stream.acceptWaveform({ samples: pcm16ToFloat32(buffer), sampleRate: SAMPLE_RATE });
    } catch (err) {
      this.onError(err);
    }
  }

  _pump() {
    if (!this._running || !this._recognizer || !this._stream) return;
    const rec = this._recognizer, st = this._stream;
    try {
      while (rec.isReady(st)) rec.decode(st);

      const text = (rec.getResult(st).text || '').trim();
      const words = text ? text.split(/\s+/) : [];
      if (words.length < this._locked) this._locked = words.length;   // never expected; stay consistent

      if (rec.isEndpoint(st)) {
        // A pause — lock the live tail; reset only a long-running stream.
        const rest = words.slice(this._locked).join(' ');
        if (rest) this.onFinal(rest, { speechFinal: true });
        this._lastPartial = '';
        this._locked = words.length;
        if (words.length >= RESET_AFTER_WORDS) {
          rec.reset(st);
          this._locked = 0;
        }
        return;
      }

      const upTo = words.length - LIVE_TAIL_WORDS;
      if (upTo - this._locked >= MIN_LOCK_WORDS) {
        this.onFinal(words.slice(this._locked, upTo).join(' '), { speechFinal: false });
        this._locked = upTo;
      }

      const live = words.slice(this._locked).join(' ');
      if (live && live !== this._lastPartial) {
        this._lastPartial = live;
        this.onPartial(live);
      }
    } catch (err) {
      this.onError(err);
    }
  }

  async stop() {
    this._running = false;
    clearInterval(this._timer);
    this._timer = null;
    // Flush a trailing final for anything still in the stream.
    try {
      if (this._recognizer && this._stream) {
        const rec = this._recognizer, st = this._stream;
        this._stream.inputFinished?.();
        while (rec.isReady(st)) rec.decode(st);
        const text = (rec.getResult(st).text || '').trim();
        const rest = (text ? text.split(/\s+/) : []).slice(this._locked).join(' ');
        if (rest) this.onFinal(rest, { speechFinal: true });
      }
    } catch {}
    const hadRecognizer = !!this._recognizer;
    this._recognizer = null;
    this._stream = null;
    this._lastPartial = '';
    this._locked = 0;
    if (hadRecognizer) releaseRecognizerSoon();
  }
}

function defaultModelPath() { return defaultModelDir(); }

module.exports = {
  SherpaEngine,
  OfflineEngine: SherpaEngine,   // name server.js's loadOfflineMod() destructures
  defaultModelPath,
  defaultModelDir,
  isModelPresent,
  pcm16ToFloat32,
  recognizerConfig,
  MODEL_FILES,
};
