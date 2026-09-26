// KAIRO — extra, time-offset Deepgram streams for citation rescue.
//
// Why: Deepgram's streaming transcript of IDENTICAL audio changes by ~15% of
// its words for a 20-40 ms shift in where the stream starts (measured
// 2026-09-24: same audio, start shifted 333/700 samples, no audio lost).
// Every listening session lands on a different alignment, so a book name
// heard in one run ("Matthew 11") is "Imagine 11" in the next. The misses
// of differently-aligned streams barely overlap: across 14 citations in one
// real clip a single stream heard 10-12, two streams together 12-13, three
// 13-14.
//
// This module ONLY owns the extra sockets. It forwards the same audio the
// primary stream gets (delayed by a few samples of leading silence per
// stream) and hands back FINAL transcript text. What to do with that text —
// voting, dedupe, Candidates vs live screen — is server.js's job; nothing
// here touches transcripts, the UI, or detection state.
'use strict';

const OFFSET_SAMPLES = [333, 700];   // stream 1, stream 2 (relative to the primary)

class SttEnsemble {
  /**
   * @param {object} o
   * @param {Function} o.createClient   @deepgram/sdk createClient
   * @param {object}   o.events         LiveTranscriptionEvents
   * @param {string}   o.apiKey
   * @param {object}   o.config         the primary stream's exact live config
   * @param {number}   o.extraStreams   how many EXTRA streams (1-2)
   * @param {Function} o.onFinal        (text, streamId, words) => void
   */
  constructor(o) {
    this.o = o;
    this.streams = [];
    this.stopped = false;
  }

  start() {
    const n = Math.max(0, Math.min(OFFSET_SAMPLES.length, this.o.extraStreams | 0));
    const client = this.o.createClient(this.o.apiKey);
    for (let i = 0; i < n; i++) this._open(client, i);
  }

  _open(client, i) {
    if (this.stopped) return;
    const id = `s${i + 1}`;
    const st = { id, conn: null, open: false, keepAlive: null, retry: null };
    this.streams[i] = st;
    let conn;
    try { conn = client.listen.live(this.o.config); } catch (err) {
      console.warn(`[Ensemble] ${id} failed to start:`, err.message);
      return;
    }
    st.conn = conn;
    const E = this.o.events;
    conn.on(E.Open, () => {
      if (this.stopped || this.streams[i] !== st) return;
      st.open = true;
      // Leading silence = the alignment offset. Sent BEFORE any real audio so
      // this stream's frames land at a different phase than the primary's.
      try { conn.conn.send(Buffer.alloc(OFFSET_SAMPLES[i] * 2)); } catch {}
      st.keepAlive = setInterval(() => {
        try { if (conn.conn && conn.conn.readyState === 1) conn.conn.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
      }, 8000);
      console.log(`[Ensemble] ${id} open (offset ${OFFSET_SAMPLES[i]} samples)`);
    });
    conn.on(E.Transcript, (data) => {
      if (this.stopped || this.streams[i] !== st) return;
      const alt = data.channel?.alternatives?.[0];
      if (!data.is_final || !alt?.transcript?.trim()) return;   // finals only — interims are noise here
      try { this.o.onFinal(alt.transcript, id, alt.words); } catch (err) { console.warn('[Ensemble] onFinal error:', err.message); }
    });
    conn.on(E.Error, (err) => {
      if (this.streams[i] !== st) return;
      console.warn(`[Ensemble] ${id} error:`, err?.message || err?.reason || String(err));
    });
    conn.on(E.Close, () => {
      if (this.streams[i] !== st) return;
      st.open = false;
      clearInterval(st.keepAlive);
      if (this.stopped) return;
      // Never let an extra stream's drop affect the primary — just retry quietly.
      st.retry = setTimeout(() => this._open(client, i), 3000);
    });
  }

  /** Same PCM the primary got. Raw socket send with a real readyState check — the SDK's own send() can silently swallow into a never-flushed buffer (see server.js's audio path). */
  send(chunk) {
    for (const st of this.streams) {
      if (!st || !st.open || !st.conn?.conn || st.conn.conn.readyState !== 1) continue;
      try { st.conn.conn.send(chunk); } catch {}
    }
  }

  stop() {
    this.stopped = true;
    for (const st of this.streams) {
      if (!st) continue;
      clearInterval(st.keepAlive);
      clearTimeout(st.retry);
      try { st.conn?.requestClose(); } catch {}
    }
    this.streams = [];
  }
}

module.exports = { SttEnsemble, OFFSET_SAMPLES };
