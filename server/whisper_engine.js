// KAIRO — Offline STT engine (whisper.cpp)
//
// Whisper is a *batch* recognizer: it transcribes a whole audio window, not a
// live stream the way Vosk does. To match Kairo's streaming contract (a flow of
// partial guesses followed by a final when the speaker pauses) this module wraps
// whisper.cpp in a small streaming state machine:
//
//   • incoming PCM chunks accumulate into the "current utterance" buffer
//   • a light RMS voice-activity check tracks when speech is happening
//   • while speech continues we re-transcribe the growing window every
//     PARTIAL_INTERVAL_MS and emit the text as a *partial*
//   • when the speaker goes quiet for SILENCE_MS we transcribe once more, emit a
//     *final*, and reset for the next utterance
//   • an utterance is force-finalized past MAX_UTTERANCE_MS so latency (and
//     whisper's per-call cost, which grows with window length) stays bounded
//
// The only whisper.cpp-binding-specific code is `_transcribeWindow()`. Everything
// else — format conversion, buffering, VAD, segmentation — is plain JS. If the
// binding is swapped, only that one method changes.
//
// Audio contract (identical to the Vosk path): 16 kHz, mono, signed 16-bit PCM
// (linear16), delivered as Node Buffers. Whisper wants Float32 in [-1, 1], so we
// convert on the way in.
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const SAMPLE_RATE = 16000;

// Generous upper bound on a single transcribe call — well above what even a
// full MAX_UTTERANCE_MS window should take on CPU. Without this, a hung
// native binding call leaves `_busy` true forever and silently freezes all
// further partial/final output for the rest of the service.
const TRANSCRIBE_TIMEOUT_MS = 20_000;

// ── Streaming / VAD tuning ──────────────────────────────────────────────────
const PARTIAL_INTERVAL_MS = 850;    // re-transcribe the open window this often
const SILENCE_MS          = 650;    // trailing quiet that ends an utterance
const MIN_SPEECH_MS       = 300;    // ignore blips shorter than this
const MAX_UTTERANCE_MS    = 18000;  // hard cap → force a final, bound latency
const VAD_RMS_THRESH      = 0.012;  // normalized RMS above this counts as speech
const CARRY_TAIL_MS       = 250;    // audio kept after a forced cut for continuity
// Continuous singing (unlike speech) rarely produces the SILENCE_MS of quiet
// that would otherwise end an utterance, so the open window can grow toward
// the full MAX_UTTERANCE_MS before a natural cut ever happens. _emitPartial
// used to re-transcribe that WHOLE growing window every PARTIAL_INTERVAL_MS
// — cheap at 1s in, but by 15s in each call itself takes long enough that
// results start arriving noticeably behind real time and keep falling
// further behind for the rest of the utterance (real live symptom: lyrics
// never sent because the recognized text arrived too late to matter). Long
// unbroken windows also measurably raise whisper.cpp's own repetition-loop
// risk on sustained tonal/musical audio (observed live: dozens of
// hallucinated "oh"s in one window). Bounding what a PARTIAL transcribes to
// this many recent ms — not the whole accumulated buffer — keeps every
// partial's cost roughly constant regardless of how long the utterance has
// been running. _finalize() still uses the COMPLETE buffer, unchanged: it
// only runs at a real utterance boundary (natural silence or the
// MAX_UTTERANCE_MS cap), rare enough to afford transcribing the whole thing
// for one accurate final pass.
// Owner, live: "I want whisper to be better with its transcription speed —
// the transcript buffers before it's locked." Even bounded, re-transcribing
// a full 8s window every single PARTIAL_INTERVAL_MS (850ms) is real,
// felt compute cost on every cycle, not just the old unbounded-growth case —
// that's the actual source of the perceived buffering/delay before a
// partial settles. Cut to 4s: half the per-call cost, still comfortably
// enough audio for whisper.cpp to produce a coherent multi-word result
// (this is a PREVIEW that gets replaced every cycle anyway — _finalize()
// below is unaffected and still transcribes the true complete buffer for
// the one accurate final pass per utterance).
const PARTIAL_WINDOW_MS   = 4000;

// ── PCM s16le (mono) → Float32 [-1, 1] ──────────────────────────────────────
function pcm16ToFloat32(buf) {
  // buf is a Node Buffer of little-endian int16 samples.
  const n   = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

function rms(float32) {
  if (!float32.length) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

function concatFloat32(chunks, total) {
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// smart-whisper's prebuilt native binding loads whisper.cpp's Metal shader
// SOURCE file from disk at GPU-init time (it isn't embedded in the compiled
// .node binary in the version this app bundles) — a plain `npm install`
// without a full `node-gyp rebuild` of the whisper.cpp submodule can leave
// that file missing even though the binding itself loads fine. When it's
// missing, whisper.cpp doesn't throw — it logs `ggml_metal_init: error:
// ... couldn't be opened` and `failed to allocate context`, then silently
// falls back to CPU on every single transcribe call, since nothing caches
// that the attempt already failed. Harmless to output, but it re-attempts
// (and re-fails) GPU init on every call, spamming stderr and paying a
// wasted init cost each time. Checked once at start() and used to skip the
// doomed GPU attempt outright — if a future proper rebuild restores the
// file, this simply starts returning true again with no code change needed.
function metalShaderAvailable() {
  try {
    const smartWhisperDir = path.dirname(require.resolve('smart-whisper/package.json'));
    return fs.existsSync(path.join(smartWhisperDir, 'whisper.cpp', 'ggml', 'src', 'ggml-metal.metal'));
  } catch {
    return false;
  }
}

class WhisperEngine {
  // opts:
  //   modelPath  — path to a whisper.cpp ggml model (.bin)
  //   gpu        — use GPU acceleration when available (Metal/CUDA/Vulkan)
  //   language   — BCP-47 code, default 'en'
  //   onPartial(text)  — called with the evolving transcript of the open utterance
  //   onFinal(text)    — called once per utterance when the speaker pauses
  //   onError(err)
  constructor(opts = {}) {
    this.modelPath = opts.modelPath;
    this.gpu       = opts.gpu !== false;
    this.language  = opts.language || 'en';
    this.onPartial = opts.onPartial || (() => {});
    this.onFinal   = opts.onFinal   || (() => {});
    this.onError   = opts.onError   || (() => {});

    this._whisper = null;   // smart-whisper instance
    this._Whisper = null;   // constructor (lazy-required)

    this._chunks       = [];   // Float32Array pieces of the open utterance
    this._chunkSamples = 0;
    this._speechStart  = 0;    // wall-clock ms of first voiced frame
    this._lastVoiceAt  = 0;    // wall-clock ms of most recent voiced frame
    this._lastPartialAt = 0;
    this._lastPartialText = '';
    this._busy    = false;     // a transcription is in flight (no overlap)
    this._running = false;
    this._silenceTimer = null;
  }

  // Load the binding + model. Throws with a coded error the server maps to a
  // friendly message, mirroring loadVoskModel()'s VOSK_MODEL_MISSING contract.
  async start() {
    if (!this.modelPath || !fs.existsSync(this.modelPath)) {
      const e = new Error(`Whisper model not found at ${this.modelPath}`);
      e.code = 'WHISPER_MODEL_MISSING';
      throw e;
    }
    try {
      // Lazy require so a missing optional dependency never crashes server boot.
      ({ Whisper: this._Whisper } = require('smart-whisper'));
    } catch (err) {
      const e = new Error('smart-whisper is not installed. Run: npm i smart-whisper');
      e.code = 'WHISPER_BINDING_MISSING';
      throw e;
    }
    // On macOS, only request Metal if its shader source is actually present —
    // see metalShaderAvailable()'s comment. Other platforms' GPU backends
    // (CUDA/Vulkan) don't depend on this file, so leave them as the caller
    // requested.
    let useGpu = this.gpu;
    if (useGpu && os.platform() === 'darwin' && !metalShaderAvailable()) {
      useGpu = false;
      console.warn('[Whisper] Metal shader source missing from smart-whisper install — running on CPU. ' +
        'Reinstall smart-whisper with a full `node-gyp rebuild` to restore GPU acceleration.');
    }
    this._whisper = new this._Whisper(this.modelPath, { gpu: useGpu });
    this._resetUtterance();
    this._running = true;
  }

  _resetUtterance() {
    this._chunks = [];
    this._chunkSamples = 0;
    this._speechStart = 0;
    this._lastVoiceAt = 0;
    this._lastPartialAt = 0;
    this._lastPartialText = '';
  }

  // Feed one PCM chunk. Drives partial/final emission off wall-clock timing so
  // it works whether chunks arrive fast or slow.
  feed(buffer) {
    if (!this._running || !buffer || !buffer.length) return;

    const f   = pcm16ToFloat32(buffer);
    const now = Date.now();
    const voiced = rms(f) >= VAD_RMS_THRESH;

    this._chunks.push(f);
    this._chunkSamples += f.length;

    if (voiced) {
      if (!this._speechStart) this._speechStart = now;
      this._lastVoiceAt = now;
    }

    // Nothing spoken yet — keep only a short rolling pre-roll so the first word
    // isn't clipped, then bail. Prevents whisper running on pure silence.
    if (!this._speechStart) {
      this._trimTo(CARRY_TAIL_MS);
      return;
    }

    const speechMs    = now - this._speechStart;
    const silentMs     = now - this._lastVoiceAt;
    const utteranceMs = (this._chunkSamples / SAMPLE_RATE) * 1000;

    // End of utterance: enough speech happened and the speaker has gone quiet.
    if (speechMs >= MIN_SPEECH_MS && silentMs >= SILENCE_MS) {
      this._finalize();
      return;
    }

    // Hard cap: force a final so a long monologue doesn't grow the window without
    // bound (whisper cost scales with window length).
    if (utteranceMs >= MAX_UTTERANCE_MS) {
      this._finalize(true);
      return;
    }

    // Mid-utterance: emit a partial on a fixed cadence.
    if (now - this._lastPartialAt >= PARTIAL_INTERVAL_MS) {
      this._lastPartialAt = now;
      this._emitPartial();
    }
  }

  // Keep only the last `ms` of audio in the buffer (used as pre-roll during
  // silence so we don't discard the onset of the next word).
  _trimTo(ms) {
    const keep = Math.floor((ms / 1000) * SAMPLE_RATE);
    while (this._chunkSamples - (this._chunks[0]?.length || 0) > keep && this._chunks.length > 1) {
      this._chunkSamples -= this._chunks.shift().length;
    }
  }

  async _emitPartial() {
    if (this._busy || !this._running) return;
    this._busy = true;
    // Bounded recent tail, not the whole growing utterance — see
    // PARTIAL_WINDOW_MS's own comment. _finalize() below still transcribes
    // the complete buffer; only the frequent partial re-transcription is capped.
    const window = this._chunkSamples > (PARTIAL_WINDOW_MS / 1000) * SAMPLE_RATE
      ? this._tail(PARTIAL_WINDOW_MS)
      : concatFloat32(this._chunks, this._chunkSamples);
    try {
      const text = await this._transcribeWindow(window);
      if (text && text !== this._lastPartialText && this._running) {
        this._lastPartialText = text;
        this.onPartial(text);
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this._busy = false;
    }
  }

  async _finalize(forced = false) {
    if (!this._running) return;
    // Wait out any in-flight partial so we transcribe the complete window once.
    if (this._busy) { this._pendingFinal = forced; return; }
    this._busy = true;

    const window = concatFloat32(this._chunks, this._chunkSamples);
    // Reset now so audio arriving during the (async) transcribe starts a fresh
    // utterance. On a forced cut, carry a short tail for word continuity.
    const tail = forced ? this._tail(CARRY_TAIL_MS) : null;
    this._resetUtterance();
    if (tail) { this._chunks = [tail]; this._chunkSamples = tail.length; this._speechStart = Date.now(); this._lastVoiceAt = Date.now(); }

    try {
      const text = await this._transcribeWindow(window);
      if (text && this._running) this.onFinal(text);
    } catch (err) {
      this.onError(err);
    } finally {
      this._busy = false;
      if (this._pendingFinal !== undefined) { const f = this._pendingFinal; this._pendingFinal = undefined; this._finalize(f); }
    }
  }

  _tail(ms) {
    const keep = Math.floor((ms / 1000) * SAMPLE_RATE);
    const all  = concatFloat32(this._chunks, this._chunkSamples);
    return all.length > keep ? all.slice(all.length - keep) : all;
  }

  // ── The only binding-specific method ──────────────────────────────────────
  // Transcribe a Float32 window → plain text. Swap this if the whisper binding
  // changes; the streaming machinery above is binding-agnostic.
  async _transcribeWindow(float32) {
    if (!this._whisper || !float32.length) return '';
    const work = (async () => {
      const task = await this._whisper.transcribe(float32, {
        language: this.language,
        // whisper.cpp knobs: single segment keeps latency down for short windows.
        n_threads: Math.max(2, (os.cpus().length || 4) - 1),
      });
      const segments = await task.result;
      return (segments || []).map(s => (s.text || '').trim()).join(' ').replace(/\s+/g, ' ').trim();
    })();
    // We can't cancel the native call itself if it hangs, but racing it means
    // the caller's finally block still runs and frees `_busy` so the engine
    // doesn't get stuck silently ignoring all further audio.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Whisper transcribe timed out')), TRANSCRIBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async stop() {
    this._running = false;
    clearTimeout(this._silenceTimer);
    // Flush a final for whatever is buffered so the last utterance isn't lost.
    try {
      if (this._speechStart && this._chunkSamples > 0) {
        const window = concatFloat32(this._chunks, this._chunkSamples);
        const text = await this._transcribeWindow(window).catch(() => '');
        if (text) this.onFinal(text);
      }
    } catch {}
    this._resetUtterance();
    if (this._whisper) {
      try { await this._whisper.free(); } catch (err) { console.warn('[Whisper] free() failed:', err.message); }
      this._whisper = null;
    }
  }
}

// Default model location, mirroring VOSK_MODELS_DIR conventions.
function defaultModelDir() {
  return process.env.KAIRO_APP_DATA_DIR
    ? path.join(process.env.KAIRO_APP_DATA_DIR, 'models')
    : path.join(__dirname, 'models');
}

// A whisper.cpp ggml model file. small.en-q5_1 is a good CPU-friendly
// multiplatform default (~182 MB) — meaningfully more accurate than base.en
// for the price of a slightly larger download; swap for
// ggml-large-v3-turbo-q5_0.bin on GPU machines.
function defaultModelPath() {
  return process.env.KAIRO_WHISPER_MODEL
    || path.join(defaultModelDir(), 'ggml-small.en-q5_1.bin');
}

module.exports = { WhisperEngine, defaultModelPath, defaultModelDir, pcm16ToFloat32 };
