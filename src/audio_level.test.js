// Tests for src/audio_level.js, the automatic input level control ahead of
// both speech engines. Plain node:test on synthetic speech-like audio: bursts
// of a tone with syllable-rate pauses, at the levels the live tests hit.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LevelControl, describeLevel, CEILING } = require('./audio_level.js');

const SR = 16000;
const dB = (x) => 20 * Math.log10(x);

// `seconds` of "speech": 180 ms voiced, 70 ms gap, 1.2 s pause every 3 s,
// peaks at `peak`.
function speech(seconds, peak) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const voiced = (t % 0.25) < 0.18 && (t % 3) < 1.8;
    out[i] = voiced ? peak * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0;
  }
  return out;
}

// Runs audio through a LevelControl in 128-sample blocks (the worklet's render
// quantum); returns the output and the gain after every block.
function run(audio, lc = new LevelControl(SR), block = 128) {
  const out = new Float32Array(audio.length);
  const gains = [];
  for (let i = 0; i < audio.length; i += block) {
    const inp = audio.subarray(i, i + block);
    lc.apply(inp, out.subarray(i, i + block));
    gains.push(lc.gain);
  }
  return { out, gains, lc };
}
const peakOf = (a, from = 0, to = a.length) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i])); return m; };

test('a normal feed passes through untouched', () => {
  const audio = speech(20, 0.5);
  const { out, gains } = run(audio);
  assert.ok(gains.every(g => g === 1), 'gain stays exactly 1');
  for (let i = 0; i < audio.length; i++) assert.equal(out[i], audio[i]);
});

test('a feed 26 dB down is raised to a normal level within a few seconds', () => {
  const audio = speech(20, 0.5 * 0.05);   // the live case: a player's volume near 5%
  const { out, gains } = run(audio);
  const settled = peakOf(out, 8 * SR);    // after 8 s
  assert.ok(settled > 0.2 && settled <= CEILING, `settled peak ${dB(settled).toFixed(1)} dBFS`);
  // It rises gradually: up to 24 dB/s while more than 12 dB short, then 6 dB/s
  const final = dB(gains[gains.length - 1]);
  const rises = gains.slice(1).map((g, i) => ({ rise: dB(g) - dB(gains[i]), short: final - dB(gains[i]) }));
  const fast = Math.max(...rises.map(r => r.rise));
  const near = Math.max(...rises.filter(r => r.short < 11).map(r => r.rise));
  assert.ok(fast <= 24 * 128 / SR + 1e-9, `fastest rise per 8 ms block ${fast.toFixed(4)} dB`);
  assert.ok(near <= 6 * 128 / SR + 1e-9, `rise near the settled level ${near.toFixed(4)} dB per block`);
});

test('a hot feed never clips, and a burst after a quiet stretch is caught at once', () => {
  const hot = speech(10, 1.6);            // overs: floats past full scale
  const { out: o1 } = run(hot);
  assert.ok(peakOf(o1) <= CEILING + 1e-6, `hot feed peak ${peakOf(o1)}`);

  // Quiet for 10 s (gain climbs), then a shout at full scale
  const mixed = new Float32Array(15 * SR);
  mixed.set(speech(10, 0.02), 0);
  mixed.set(speech(5, 1.0), 10 * SR);
  const { out: o2, gains } = run(mixed);
  assert.ok(gains[Math.floor(10 * SR / 128) - 1] > 10, 'gain had risen during the quiet stretch');
  assert.ok(peakOf(o2) <= CEILING + 1e-6, `peak through the shout ${peakOf(o2)}`);
});

test('silence and a low noise floor are never raised', () => {
  const zeros = new Float32Array(10 * SR);
  assert.ok(run(zeros).gains.every(g => g === 1));
  const noise = new Float32Array(10 * SR).map(() => (Math.random() * 2 - 1) * 0.003);   // about −50 dBFS
  assert.ok(run(noise).gains.every(g => g === 1));
});

test('quiet speech below the fixed gate is still raised; a steady hiss or hum there never is', () => {
  // A mic feed whose speech peaks at −56 dBFS over a −75 dBFS noise floor
  // (the level at which the offline engine dropped whole stretches, unraised)
  const floor = () => (Math.random() * 2 - 1) * Math.pow(10, -75 / 20);
  const quiet = speech(15, Math.pow(10, -56 / 20)).map((v) => v + floor());
  const mic = run(quiet);
  assert.ok(dB(mic.gains[mic.gains.length - 1]) > 29, `raised to +${dB(mic.gains[mic.gains.length - 1]).toFixed(1)} dB`);
  assert.ok(mic.gains.every(g => g <= 31.7), 'a microphone still stops at +30 dB');

  // Steady hiss at −55 dBFS and a −50 dBFS hum: no speech in them, never raised
  const hiss = new Float32Array(30 * SR).map(() => (Math.random() * 2 - 1) * Math.pow(10, -55 / 20));
  assert.ok(run(hiss).gains.every(g => g === 1), 'hiss');
  const hum = new Float32Array(30 * SR).map((_, i) => Math.pow(10, -50 / 20) * Math.sin(2 * Math.PI * 60 * i / SR));
  assert.ok(run(hum).gains.every(g => g === 1), 'hum');
});

test('an ordinary pause keeps the gain where it is', () => {
  // Quiet speech (raised), then a 3 s pause, then the same speech again
  const lc = new LevelControl(SR);
  run(speech(12, 0.03), lc);
  const before = lc.gain;
  run(new Float32Array(3 * SR), lc);
  assert.equal(lc.gain, before, 'no change across the pause');
});

test('the fallback path’s 1024-sample blocks behave the same', () => {
  const audio = speech(20, 0.5 * 0.05);
  const a = run(audio, new LevelControl(SR), 128).out;
  const b = run(audio, new LevelControl(SR), 1024).out;
  const pa = peakOf(a, 10 * SR), pb = peakOf(b, 10 * SR);
  assert.ok(Math.abs(dB(pa) - dB(pb)) < 1, `${dB(pa).toFixed(2)} vs ${dB(pb).toFixed(2)} dBFS`);
});

test('a digital loopback turned down 50 dB comes back to a normal level; a mic stops at +30 dB', () => {
  const audio = speech(20, 0.5 * Math.pow(10, -50 / 20));   // BlackHole at a low volume
  const digital = run(audio, new LevelControl(SR, { digital: true }));
  const settled = peakOf(digital.out, 8 * SR);
  assert.ok(settled > 0.2 && settled <= CEILING, `digital settled at ${dB(settled).toFixed(1)} dBFS`);
  const mic = run(audio, new LevelControl(SR));
  assert.ok(Math.max(...mic.gains) <= 31.7, 'a microphone is never raised past +30 dB');
});

test('far too quiet catches up within a few seconds, not tens', () => {
  const audio = speech(10, 0.5 * Math.pow(10, -45 / 20));
  const { gains } = run(audio, new LevelControl(SR, { digital: true }));
  const at4s = dB(gains[Math.floor(4 * SR / 128)]);
  assert.ok(at4s > 35, `gain after 4 s: +${at4s.toFixed(1)} dB`);
});

test('a remembered gain applies from the first sample, and still never clips', () => {
  const quiet = speech(2, 0.01);
  const { out } = run(quiet, new LevelControl(SR, { digital: true, initialGain: 30 }));
  assert.ok(peakOf(out, 0, SR) > 0.2, 'the first second is already at a normal level');
  const loud = speech(2, 0.8);   // the source was turned back up since last time
  const r = run(loud, new LevelControl(SR, { digital: true, initialGain: 30 }));
  assert.ok(peakOf(r.out) <= CEILING + 1e-6, `peak ${peakOf(r.out)}`);
});

test('the Settings line names the problem', () => {
  assert.equal(describeLevel({ peak: 0, clipped: false, gain: 1 }).state, 'silent');
  assert.equal(describeLevel({ peak: 0.5, clipped: false, gain: 1 }).state, 'good');
  assert.equal(describeLevel({ peak: 1, clipped: true, gain: 1 }).state, 'hot');
  const quiet = describeLevel({ peak: 0.02, clipped: false, gain: 10 });
  assert.equal(quiet.state, 'quiet');
  assert.match(quiet.text, /20 dB/);
  assert.equal(describeLevel({ peak: 0.02, clipped: false, gain: null }).text, 'Quiet. Kairo raises it');
});
