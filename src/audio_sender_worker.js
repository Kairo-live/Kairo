// KAIRO — sends captured audio to the local server on its own connection, off
// the page's main thread. Frames arrive straight from the capture worklet
// (audio_capture_worklet.js) through a MessagePort, so a busy or backgrounded
// page can't delay them. The server takes any authenticated connection's binary
// messages as audio; ?audio=1 tells it this one only sends (it gets no
// broadcasts). While the connection is down, frames are held (~20 s) and sent
// the moment it's back, the same as the page's own socket did.
'use strict';

const MAX_PENDING = 16 * 20;   // 1024-sample frames at 16 kHz ≈ 20 s
let url = null;
let ws = null;
let pending = [];
let stopped = true;
let backoff = 500;
let received = 0, sent = 0;   // for {type:'status'} — the page can ask how the stream is going

function connect() {
  if (!url || stopped || ws) return;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    backoff = 500;
    const held = pending; pending = [];
    for (const f of held) ws.send(f);
  };
  ws.onclose = () => {
    ws = null;
    if (!stopped) setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
  ws.onerror = () => {};
}

function send(frame) {
  received++;
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(frame); sent++; return; }
  pending.push(frame);
  if (pending.length > MAX_PENDING) pending.shift();
  connect();
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'start') {
    url = m.url; stopped = false; connect();
  } else if (m.type === 'port' && m.port) {
    m.port.onmessage = (ev) => { if (!stopped && ev.data instanceof ArrayBuffer) send(ev.data); };
  } else if (m.type === 'status') {
    self.postMessage({ type: 'status', connected: !!ws && ws.readyState === WebSocket.OPEN, received, sent, pending: pending.length, stopped });
  } else if (m.type === 'stop') {
    stopped = true; pending = [];
    try { if (ws) ws.close(); } catch {}
    ws = null;
  }
};
