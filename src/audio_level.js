// KAIRO — automatic input level control, ahead of both speech engines.
//
// Both engines drop whole phrases when the feed is far from a normal speech
// level. Live tests 2026-09-27/28: a feed 26 dB down (a player's volume near
// 5%) and a feed clipping at full scale. With the same sermon audio sent at
// those levels, Deepgram and the offline engine each dropped 10+ word
// stretches they transcribe fine at a normal level. This keeps what they hear
// in range, with one behavior and no setting:
//   - a normal feed passes through untouched (gain 1);
//   - a quiet one is raised, a few dB a second (faster while it is far too
//     quiet), so the level settles instead of pumping word to word;
//   - a hot one is lowered before the 16-bit conversion, so it never clips
//     there;
//   - silence and a steady noise floor are never raised.
// It steers by the loudest peak of the last 5 s, so an ordinary pause between
// sentences leaves the gain where it is.
//
// How far it may raise depends on the input. A microphone's own hiss comes up
// with its speech, so +30 dB. A digital loopback (BlackHole and friends) has
// no hiss, and the capture is floating point, so a feed turned down 50 dB by
// a volume slider comes back exactly: +60 dB. The capture starts from the
// gain the same input needed last time, so a session doesn't open quiet
// while it catches up.
//
// Measured 2026-09-29 on a captioned sermon played through BlackHole at the
// owner's 46% volume (words missing against the human captions): fed at
// −56 dBFS and not raised (the old fixed gate), the offline engine lost 8.9%,
// in stretches of up to 40 words — the "transcript drops off" reports;
// Deepgram lost 1.9%. Raised by this, both lost 1.2–1.5%, the same as at a
// normal level and no worse than Deepgram fed directly (2.3%).
//
// Shared by the capture worklet (audio_capture_worklet.js), the main-thread
// fallback in app.js, the Settings meter and the Node tests.
(function (root) {
  'use strict';

  const WINDOW_S  = 5;      // steer by the loudest peak of the last 5 s…
  const SEGMENT_S = 0.1;    // …kept as the loudest of each 100 ms
  const TARGET    = 0.3;    // quiet speech is raised until its peaks reach about −10 dBFS
  const CEILING   = 0.9;    // nothing leaves above −1 dBFS
  const MAX_GAIN  = 31.6;   // +30 dB at most (a microphone)
  const MAX_GAIN_DIGITAL = 1000;   // +60 dB (a digital loopback: no hiss to raise)
  const GATE      = 0.005;  // loudest peak under −46 dBFS for 5 s, from a mic: silence or a noise floor, hold…
  const GATE_DIGITAL = 0.0003;     // −70 dBFS: a loopback's silence is digital zero
  // …unless those 5 s move like speech: syllables and pauses, the loudest
  // 100 ms at least 12 dB above the quietest fifth. A steady hiss or hum
  // never does, so it is never raised; quiet speech is (see the measurements
  // above: a sermon at −56 dBFS sat under the fixed gate and was never raised).
  const SPEECH_SWING = 4;
  const RISE_DB_S = 6;      // how fast the gain may rise…
  const CATCH_UP_DB_S = 24; // …while it is more than 12 dB short
  const FALL_DB_S = 40;     // …and settle back (a peak that would clip is cut at once)
  // A feed this quiet needs raising (the Settings meter's "Quiet").
  const QUIET_PEAK = 0.1;

  const dbToGain = (db) => Math.pow(10, db / 20);

  class LevelControl {
    // digital: the input is a loopback (no hiss), which may be raised further.
    // initialGain: where to start, e.g. what this input needed last time.
    constructor(sampleRate = 16000, { digital = false, initialGain = 1 } = {}) {
      this.sampleRate = sampleRate;
      this.segLen = Math.max(1, Math.round(sampleRate * SEGMENT_S));
      this.segs = new Float32Array(Math.round(WINDOW_S / SEGMENT_S));
      this.segIdx = 0;
      this.segFill = 0;
      this.segMax = 0;
      this.segCount = 0;          // how many of `segs` hold real audio yet
      this.quiet = 0;             // the quietest fifth of the window (see SPEECH_SWING)
      this.sorted = new Float32Array(this.segs.length);
      this.maxGain = digital ? MAX_GAIN_DIGITAL : MAX_GAIN;
      this.gate = digital ? GATE_DIGITAL : GATE;
      this.gain = Math.min(this.maxGain, Math.max(1, Number(initialGain) || 1));
    }

    // Loudest raw peak over the last WINDOW_S.
    windowPeak() {
      let m = this.segMax;
      for (let i = 0; i < this.segs.length; i++) if (this.segs[i] > m) m = this.segs[i];
      return m;
    }

    _note(peak, n) {
      if (peak > this.segMax) this.segMax = peak;
      this.segFill += n;
      if (this.segFill >= this.segLen) {
        this.segs[this.segIdx] = this.segMax;
        this.segIdx = (this.segIdx + 1) % this.segs.length;
        this.segMax = 0;
        this.segFill = 0;
        if (this.segCount < this.segs.length) this.segCount++;
        const n = this.segCount;
        for (let i = 0; i < n; i++) this.sorted[i] = this.segs[i];
        const part = this.sorted.subarray(0, n).sort();
        this.quiet = part[Math.floor(n / 5)];
      }
    }

    // Whether the last 5 s are worth raising: above the input's gate, or
    // moving like speech (see SPEECH_SWING) once 2 s are in to judge by.
    _open(w) {
      if (w >= this.gate) return true;
      return w >= GATE_DIGITAL && this.segCount >= 20 && w >= SPEECH_SWING * this.quiet;
    }

    // Writes the level-controlled block to `out` (same length as `input`).
    // Returns the block's raw peak and whether the input itself reached full
    // scale — clipped before it got here, which no gain can undo.
    apply(input, out) {
      const n = input.length;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const a = input[i] < 0 ? -input[i] : input[i];
        if (a > peak) peak = a;
      }
      this._note(peak, n);

      const w = this.windowPeak();
      const want = !this._open(w) ? this.gain
        : Math.min(this.maxGain, Math.max(1, TARGET / w), CEILING / w);
      const dt = n / this.sampleRate;
      const from = this.gain;
      const rise = want > from * 4 ? CATCH_UP_DB_S : RISE_DB_S;
      let to = want > from ? Math.min(want, from * dbToGain(rise * dt))
        : Math.max(want, from / dbToGain(FALL_DB_S * dt));
      if (peak * to > CEILING) to = CEILING / peak;
      // Where the current gain would already push this block over the ceiling,
      // take the lower gain from its first sample (a loud onset masks the step).
      const start = peak * from > CEILING ? to : from;
      const step = (to - start) / n;
      for (let i = 0; i < n; i++) {
        const v = input[i] * (start + step * (i + 1));
        out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      this.gain = to;
      return { peak, clipped: peak >= 0.999 };
    }
  }

  // One line for the Settings meter from what the capture reports: the
  // loudest raw peak of the last few seconds (0–1), whether the input clipped
  // recently, and the gain in use (null when only previewing the input).
  function describeLevel({ peak, clipped, gain }) {
    if (clipped) return { state: 'hot', text: 'Clipping. Turn the source down' };
    if (!(peak > 0.001)) return { state: 'silent', text: 'Silent' };
    if (peak < QUIET_PEAK) {
      const db = gain != null ? Math.round(20 * Math.log10(gain)) : 0;
      return { state: 'quiet', text: db >= 1 ? `Quiet. Raised ${db} dB` : 'Quiet. Kairo raises it' };
    }
    return { state: 'good', text: 'Good level' };
  }

  const api = { LevelControl, describeLevel, TARGET, CEILING, MAX_GAIN, MAX_GAIN_DIGITAL, GATE, GATE_DIGITAL, QUIET_PEAK };
  root.KairoLevel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
