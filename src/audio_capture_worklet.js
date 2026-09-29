// KAIRO — audio capture on the audio rendering thread (AudioWorklet).
//
// The capture used to be a ScriptProcessorNode, whose callback runs on the
// page's MAIN thread: whenever that thread was busy (the transcript, the Live
// Queue and the Monitor all draw there) or the window was behind another app,
// the callback ran late and audio reached Deepgram in stalls and bursts — the
// transcript froze, then caught up, and words Deepgram had shown were dropped
// (live test). This runs on the audio thread instead, which the page can't hold
// up, and hands each 1024-sample frame straight to the sender worker
// (audio_sender_worker.js) through a MessagePort — the main thread never
// touches the audio. Until that port arrives, frames go to the page as before.
//
// Each block passes through the automatic level control (audio_level.js,
// loaded into this scope first) before the 16-bit conversion, so a quiet feed
// is raised and a hot one never clips there.
function passThrough(input, out) {
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return { peak, clipped: peak >= 0.999 };
}

class KairoCapture extends AudioWorkletProcessor {
  // processorOptions: { digital, initialGain } — see audio_level.js.
  constructor(options) {
    super();
    this.frame = new Int16Array(1024);   // 64 ms at 16 kHz, what the server expects
    this.filled = 0;
    // Never let a missing level control stop the capture: without it the
    // audio passes through as before.
    const o = (options && options.processorOptions) || {};
    this.level = globalThis.KairoLevel
      ? new globalThis.KairoLevel.LevelControl(sampleRate, { digital: !!o.digital, initialGain: o.initialGain })
      : null;
    this.block = new Float32Array(128);
    this.peak = 0;                       // raw input, before the level control
    this.clipped = false;
    this.out = null;                     // the sender worker's port
    this.lastLevelAt = 0;
    this.port.onmessage = (e) => { if (e.data && 'port' in e.data) this.out = e.data.port; };
  }

  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) {
      if (this.block.length !== samples.length) this.block = new Float32Array(samples.length);
      const { peak, clipped } = this.level ? this.level.apply(samples, this.block) : passThrough(samples, this.block);
      if (peak > this.peak) this.peak = peak;
      if (clipped) this.clipped = true;
      const out = this.block;
      for (let i = 0; i < out.length; i++) {
        this.frame[this.filled++] = out[i] * 32767;
        if (this.filled === this.frame.length) {
          const buf = this.frame.buffer;
          (this.out || this.port).postMessage(buf, [buf]);
          this.frame = new Int16Array(1024);
          this.filled = 0;
        }
      }
    }
    // The level, ten times a second, for the meter and the dead-device checks:
    // the raw input peak (int16 scale), the gain in use, and any clipping.
    if (currentTime - this.lastLevelAt >= 0.1) {
      this.port.postMessage({ peak: this.peak * 32768, gain: this.level ? this.level.gain : 1, clipped: this.clipped });
      this.peak = 0;
      this.clipped = false;
      this.lastLevelAt = currentTime;
    }
    return true;
  }
}

registerProcessor('kairo-capture', KairoCapture);
