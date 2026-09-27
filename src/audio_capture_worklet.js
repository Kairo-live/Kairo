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
class KairoCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(1024);   // 64 ms at 16 kHz, what the server expects
    this.filled = 0;
    this.peak = 0;
    this.out = null;                     // the sender worker's port
    this.lastLevelAt = 0;
    this.port.onmessage = (e) => { if (e.data && 'port' in e.data) this.out = e.data.port; };
  }

  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) {
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-32768, Math.min(32767, samples[i] * 32768));
        this.frame[this.filled++] = v;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        if (this.filled === this.frame.length) {
          const buf = this.frame.buffer;
          (this.out || this.port).postMessage(buf, [buf]);
          this.frame = new Int16Array(1024);
          this.filled = 0;
        }
      }
    }
    // The level, ten times a second, for the meter and the dead-device checks.
    if (currentTime - this.lastLevelAt >= 0.1) {
      this.port.postMessage({ peak: this.peak });
      this.peak = 0;
      this.lastLevelAt = currentTime;
    }
    return true;
  }
}

registerProcessor('kairo-capture', KairoCapture);
