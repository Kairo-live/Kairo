// KAIRO — automatic input level control, ahead of both speech engines.
//
// Both engines drop whole phrases when the feed is far from a normal speech
// level. Live tests 2026-09-27/28: a feed 26 dB down (a player's volume near
// 5%) and a feed clipping at full scale. With the same sermon audio sent at
// those levels, Deepgram and the offline engine each dropped 10+ word
// stretches they transcribe fine at a normal level. This keeps what they hear
// in range, with one behavior and no setting:
//   - a normal feed passes through untouched (gain 1);
//   - a quiet one is raised, up to +30 dB, a few dB a second, so the level
//     settles over a few seconds instead of pumping word to word;
//   - a hot one is lowered before the 16-bit conversion, so it never clips
//     there;
//   - silence and a low noise floor are never raised.
// It steers by the loudest peak of the last 5 s, so an ordinary pause between
// sentences leaves the gain where it is.
//
// Shared by the capture worklet (audio_capture_worklet.js), the main-thread
// fallback in app.js, the Settings meter and the Node tests.
(function (root) {
  'use strict';

  const WINDOW_S  = 5;      // steer by the loudest peak of the last 5 s…
  const SEGMENT_S = 0.1;    // …kept as the loudest of each 100 ms
  const TARGET    = 0.3;    // quiet speech is raised until its peaks reach about −10 dBFS
  const CEILING   = 0.9;    // nothing leaves above −1 dBFS
  const MAX_GAIN  = 31.6;   // +30 dB at most
  const GATE      = 0.005;  // loudest peak under −46 dBFS for 5 s: silence or a noise floor, hold
  const RISE_DB_S = 6;      // how fast the gain may rise…
  const FALL_DB_S = 40;     // …and settle back (a peak that would clip is cut at once)
  // A feed this quiet needs raising (the Settings meter's "Quiet").
  const QUIET_PEAK = 0.1;

  const dbToGain = (db) => Math.pow(10, db / 20);

  class LevelControl {
    constructor(sampleRate = 16000) {
      this.sampleRate = sampleRate;
      this.segLen = Math.max(1, Math.round(sampleRate * SEGMENT_S));
      this.segs = new Float32Array(Math.round(WINDOW_S / SEGMENT_S));
      this.segIdx = 0;
      this.segFill = 0;
      this.segMax = 0;
      this.gain = 1;
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
      }
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
      const want = w < GATE ? this.gain
        : Math.min(MAX_GAIN, Math.max(1, TARGET / w), CEILING / w);
      const dt = n / this.sampleRate;
      const from = this.gain;
      let to = want > from ? Math.min(want, from * dbToGain(RISE_DB_S * dt))
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

  const api = { LevelControl, describeLevel, TARGET, CEILING, MAX_GAIN, GATE, QUIET_PEAK };
  root.KairoLevel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
