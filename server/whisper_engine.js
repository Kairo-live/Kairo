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

const SAMPLE_RATE = 16000;

// ── Streaming / VAD tuning ──────────────────────────────────────────────────
const PARTIAL_INTERVAL_MS = 850;    // re-transcribe the open window this often
const SILENCE_MS          = 650;    // trailing quiet that ends an utterance
const MIN_SPEECH_MS       = 300;    // ignore blips shorter than this
const MAX_UTTERANCE_MS    = 18000;  // hard cap → force a final, bound latency
const VAD_RMS_THRESH      = 0.012;  // normalized RMS above this counts as speech
const CARRY_TAIL_MS       = 250;    // audio kept after a forced cut for continuity

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
    this._whisper = new this._Whisper(this.modelPath, { gpu: this.gpu });
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
    const window = concatFloat32(this._chunks, this._chunkSamples);
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
    const task = await this._whisper.transcribe(float32, {
      language: this.language,
      // whisper.cpp knobs: single segment keeps latency down for short windows.
      n_threads: Math.max(2, (require('os').cpus().length || 4) - 1),
    });
    const segments = await task.result;
    return (segments || []).map(s => (s.text || '').trim()).join(' ').replace(/\s+/g, ' ').trim();
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
      try { await this._whisper.free(); } catch {}
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
