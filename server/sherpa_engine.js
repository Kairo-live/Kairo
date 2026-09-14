// KAIRO — Offline STT engine (sherpa-onnx + NVIDIA Nemotron streaming)
//
// Replaces whisper_engine.js as the offline engine. The reason for the swap,
// in one line: whisper.cpp is a BATCH recognizer emulating streaming by
// re-transcribing overlapping windows — inherently bursty, always behind, and
// no amount of tuning closes the behavioral gap with Deepgram. sherpa-onnx
// runs a streaming TRANSDUCER model (same architectural class as Deepgram's
// own): it consumes audio frame-by-frame, keeps an internal encoder-state
// cache, and emits tokens as they're recognized — each audio frame processed
// exactly once, no re-transcription. That's the only way to get transcript
// behavior that actually matches Deepgram's continuous word-by-word delivery,
// which is the stated bar for the offline fallback: "consistent behavior and
// similar performance, not a huge gap."
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
// This module keeps the SAME public interface the old whisper.cpp engine
// had, so server.js's startOffline()/feedOfflineAudio()/stopOffline() and
// everything downstream of handleTranscriptSegment is untouched:
//   new SherpaEngine({ modelDir, language, onPartial, onFinal, onError })
//   .start()   async, throws a coded error the server maps to a friendly msg
//   .feed(buffer)   PCM s16le, 16 kHz, mono, Node Buffer
//   .stop()    async
//
// Audio contract is identical to the whisper path: 16 kHz mono signed-16-bit
// PCM. sherpa-onnx wants Float32 in [-1, 1] with a { samples, sampleRate }
// shape, converted on the way in.
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const SAMPLE_RATE = 16000;

// How often to pump the decoder and check for new text / an endpoint. The
// model itself streams continuously; this is just the JS-side polling
// cadence for surfacing partials. 120ms keeps partials feeling live without
// spinning the event loop.
const POLL_INTERVAL_MS = 120;

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

class SherpaEngine {
  // opts:
  //   modelDir  — dir holding the extracted streaming-zipformer model files
  //   language  — accepted for parity; the en model is monolingual so unused
  //   onPartial(text)  — evolving transcript of the current utterance
  //   onFinal(text)    — once per utterance, at the endpoint
  //   onError(err)
  constructor(opts = {}) {
    // `modelPath` accepted as an alias so server.js's
    // `new OfflineEngine({ modelPath, ... })` call needs no further change.
    this.modelDir = opts.modelDir || opts.modelPath || defaultModelDir();
    this.language = opts.language || 'en';
    this.onPartial = opts.onPartial || (() => {});
    this.onFinal   = opts.onFinal   || (() => {});
    this.onError   = opts.onError   || (() => {});

    this._recognizer = null;
    this._stream     = null;
    this._timer      = null;
    this._running    = false;
    this._lastPartial = '';
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

    const p = (f) => path.join(this.modelDir, MODEL_FILES[f]);
    this._recognizer = new OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
      modelConfig: {
        transducer: { encoder: p('encoder'), decoder: p('decoder'), joiner: p('joiner') },
        tokens: p('tokens'),
        numThreads: Math.max(1, Math.min(4, (os.cpus().length || 4) - 2)),
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      // Endpoint rules — when the model decides an utterance has ended, which
      // is our cue to emit onFinal() and reset the stream. Tuned close to
      // Deepgram's endpointing feel: ~1.4s of trailing silence ends a normal
      // utterance, faster (0.8s) if a decode already produced text.
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4,  // silence after nothing decoded yet
      rule2MinTrailingSilence: 1.4,  // silence after some text — the common case
      rule3MinUtteranceLength: 25,   // hard cap in seconds, mirrors MAX_UTTERANCE
    });
    this._stream = this._recognizer.createStream();
    this._lastPartial = '';
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

      if (rec.isEndpoint(st)) {
        // Utterance boundary — commit whatever we have as a final, then reset
        // the stream so the encoder state cache starts clean for the next one.
        if (text) this.onFinal(text);
        rec.reset(st);
        this._lastPartial = '';
        return;
      }

      if (text && text !== this._lastPartial) {
        this._lastPartial = text;
        this.onPartial(text);
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
        if (text) this.onFinal(text);
      }
    } catch {}
    this._recognizer = null;
    this._stream = null;
    this._lastPartial = '';
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
  MODEL_FILES,
};
