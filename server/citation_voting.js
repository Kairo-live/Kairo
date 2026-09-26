// KAIRO — multi-stream citation voting.
//
// Extra time-offset Deepgram streams (stt_ensemble.js) exist because the SAME
// audio transcribes ~15% differently depending on stream alignment — a book
// name one stream hears, another turns into "Imagine". Their FINAL text is
// parsed for citations ONLY (no transcript, no buffers, no UI). Rules, in
// order of safety:
//   - a citation the primary stream already produced is ignored;
//   - a citation only ONE extra stream heard goes to Candidates, never the
//     live screen (capAtSuggestions);
//   - it reaches the live screen only when 2+ streams agree on the IDENTICAL
//     book/chapter/verse — a different chapter/verse from an extra stream can
//     never override anything.
//
// Everything stateful the vote needs from the server is injected (`deps`), so
// this module owns only the vote table and the extra-stream lifecycle.
'use strict';

const { SttEnsemble } = require('./stt_ensemble');

const CITATION_VOTE_TTL_MS = 15000;

function citationKey(ref) {
  const v = ref.ranges?.length
    ? ref.ranges.map(r => `${r.verseStart}-${r.verseEnd}`).join('+')
    : ref.verseStart ? `${ref.verseStart}-${ref.verseEnd ?? ref.verseStart}` : String(ref.verse);
  return `${ref.book}|${ref.chapter}|${v}`;
}
function hasVerseInfo(ref) { return ref.verse != null || !!ref.verseStart || !!ref.ranges?.length; }

/**
 * @param {object} deps
 *   workerCall, parseAllSpokenReferences, resolveAmbiguousRefs, broadcastDetection,
 *   referenceContext, updateSermonContext, setRangeQueue, clearRangeQueue,
 *   isReady() -> { workerReady, inBibleMode }, joinWindowMs, getSettings()
 */
function createCitationVoting(deps) {
  const votes = new Map();         // key -> { streams:Set, at, primary, sent }
  const secondaryPrev = {};        // streamId -> { text, at } for the join retry
  let ensemble = null;

  function prune(now) {
    for (const [k, e] of votes) if (now - e.at > CITATION_VOTE_TTL_MS) votes.delete(k);
  }

  function recordPrimaryCitation(ref) {
    if (!ref.book || !ref.chapter || !hasVerseInfo(ref)) return;
    const now = Date.now();
    prune(now);
    const k = citationKey(ref);
    const e = votes.get(k) || { streams: new Set(), at: now, primary: false, sent: null };
    e.streams.add('p'); e.primary = true; e.at = now; e.sent = 'viewer';
    votes.set(k, e);
  }

  async function lookupRefVerses(ref) {
    const { book, chapter, verse } = ref;
    let { verseStart, verseEnd, ranges } = ref;
    if (ranges?.length === 1) { verseStart = ranges[0].verseStart; verseEnd = ranges[0].verseEnd; ranges = null; }
    if (ranges && ranges.length > 1) {
      const out = [];
      for (const r of ranges) {
        const m = await deps.workerCall('rangeLookup', { book, chapter, verseStart: r.verseStart, verseEnd: r.verseEnd }, 8000);
        out.push(...(m.results || []));
      }
      return out;
    }
    if (verseStart && verseEnd && verseEnd !== verseStart) {
      const m = await deps.workerCall('rangeLookup', { book, chapter, verseStart, verseEnd }, 8000);
      return m.results || [];
    }
    const v = verse ?? verseStart;
    if (!v) return [];
    const m = await deps.workerCall('directLookup', { book, chapter, verse: v }, 8000);
    return m.result ? [m.result] : [];
  }

  async function handleSecondaryFinal(text, streamId) {
    const { workerReady, inBibleMode } = deps.isReady();
    if (!workerReady) return;
    const now = Date.now();
    let refs = deps.parseAllSpokenReferences(text, inBibleMode);
    const prev = secondaryPrev[streamId];
    if (!refs.length && prev && now - prev.at < deps.joinWindowMs) {
      refs = deps.parseAllSpokenReferences(`${prev.text} ${text}`, inBibleMode);
    }
    secondaryPrev[streamId] = { text, at: now };
    if (!refs.length) return;
    refs = (await deps.resolveAmbiguousRefs(refs))
      .filter(r => r.book && r.chapter && !r.ambiguousUnresolved && hasVerseInfo(r));
    prune(now);
    for (const ref of refs) {
      const k = citationKey(ref);
      const e = votes.get(k) || { streams: new Set(), at: now, primary: false, sent: null };
      e.streams.add(streamId); e.at = now;
      votes.set(k, e);
      if (e.primary) continue;                                   // the primary already owns this citation
      const want = e.streams.size >= 2 ? 'viewer' : 'suggestions';
      if (e.sent === 'viewer' || e.sent === want) continue;
      let verses = [];
      try { verses = await lookupRefVerses(ref); } catch {}
      if (!verses.length) continue;
      e.sent = want;
      if (want === 'viewer') {
        deps.referenceContext.update(ref.book, ref.chapter);
        deps.updateSermonContext(ref);
        if (verses.length > 1) deps.setRangeQueue(verses); else deps.clearRangeQueue();
      }
      const sent = await deps.broadcastDetection(verses, 'direct', 1.0, want, want === 'suggestions' ? { capAtSuggestions: true } : {});
      console.log(`[Ensemble] ${streamId} heard "${verses[0].reference}"${verses.length > 1 ? ` (+${verses.length - 1})` : ''} (${e.streams.size} stream${e.streams.size > 1 ? 's' : ''} agree) → ${sent || 'dropped'}`);
    }
  }

  function reset() {
    votes.clear();
    for (const k of Object.keys(secondaryPrev)) delete secondaryPrev[k];
  }

  function stop() {
    if (ensemble) { try { ensemble.stop(); } catch {} ensemble = null; }
    reset();
  }

  function start(dgConfig, LiveTranscriptionEvents) {
    stop();
    const settings = deps.getSettings();
    // Opt-in: every extra stream is another full Deepgram audio bill. Measured
    // gain (real clip, 3 alignments, clean runs): 1 stream 10.0/14 on screen vs
    // 3 streams 10.3/14 + ~1 extra Candidate and 3/3 (was 1/3) on Jeremiah 17:7-8.
    const total = Math.max(1, Math.min(3, parseInt(settings.sttStreams ?? 1, 10) || 1));
    if (total < 2) return;
    const { createClient } = require('@deepgram/sdk');
    ensemble = new SttEnsemble({
      createClient, events: LiveTranscriptionEvents,
      apiKey: (settings.deepgramApiKey || '').trim(),
      config: dgConfig, extraStreams: total - 1,
      onFinal: (t, id) => { handleSecondaryFinal(t, id).catch(err => console.warn('[Ensemble] handler error:', err.message)); },
    });
    ensemble.start();
  }

  /** Forward the primary stream's audio to the extra streams. */
  function sendAudio(chunk) { if (ensemble) ensemble.send(chunk); }

  return { recordPrimaryCitation, handleSecondaryFinal, start, stop, reset, sendAudio };
}

module.exports = { createCitationVoting, citationKey, hasVerseInfo, CITATION_VOTE_TTL_MS };
