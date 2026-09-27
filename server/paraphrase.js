// KAIRO — paraphrase detection: which stretches of recent speech to search by
// meaning, and when a meaning match is trustworthy enough to offer or send.
//
// A paraphrase in a real sermon arrives wrapped in commentary and STT noise;
// embedding a whole segment dilutes it (real sermon speech: 36% right at #1
// as whole segments). So several short windows are searched at once — the
// last sentence or two, the last few seconds, and the words right after a
// quote signal ("the Bible says", "Jesus said") — and the best-fitting window
// speaks for each verse. Pure functions; server.js runs them, and the eval
// harness replays sermons through the same code.
'use strict';

// Phrases that introduce scripture — what follows them is the verse, in the
// preacher's own words or not.
const QUOTE_SIGNAL_RE = new RegExp('\\b(?:' + [
  'the (?:bible|scriptures?|word(?: of god)?) (?:says|said|tells us|told us|declares|teaches)',
  '(?:as )?it is written', 'it was written', 'thus says the lord', 'thus saith the lord',
  '(?:jesus|christ|the lord|god|the spirit) (?:says|said|told (?:us|them|him|her))',
  '(?:paul|peter|john|james|david|moses|isaiah|jeremiah|solomon|the psalmist|the apostle|the prophet) (?:says|said|wrote|writes|told \\w+|declared)',
  'in the words of (?:jesus|paul|the psalmist|scripture)',
].join('|') + ')\\b', 'gi');

const MAX_WINDOW_WORDS = 30;
const MAX_WINDOWS = 5;

function words(text) { return String(text || '').split(/\s+/).filter(Boolean); }

// Crowd work and fillers a preacher drops into the middle of a verse — "come
// to me, church, are you with me?, all you that are weary…". Removed to fuse
// the pieces of the verse back together. Only phrases that are never scripture
// wording themselves.
const INTERJECTION_RE = new RegExp('\\b(?:' + [
  '(?:somebody |can i get an? |let me hear (?:you )?)?say amen', 'amen', 'hallelujah', 'glory to god', 'thank you jesus',
  'are you (?:with me|listening|there|still with me)', 'can you hear me', 'do you hear me', 'listen to me', 'listen',
  '(?:turn to|look at|tell) (?:your|the person next to you|somebody)(?: neighbou?r)?(?: and say)?', 'say it with me', 'say it',
  'watch this', 'come on', 'i said', 'you know', 'i mean', 'right', 'okay', 'alright', 'hello', 'church', 'uh+', 'um+', 'hmm+',
].join('|') + ')\\b[,.!?]*', 'gi');
function withoutInterjections(text) {
  return String(text || '').replace(INTERJECTION_RE, ' ').replace(/\s+([,.!?;])/g, '$1').replace(/\s+/g, ' ').trim();
}
const SHORT_SENTENCE_WORDS = 7;   // an aside between two parts of a verse

/**
 * Windows of recent speech to search. `recent` is the last ~60 words with the
 * STT's own punctuation. Returns distinct strings, most specific first.
 */
function paraphraseWindows(recent) {
  const out = [];
  const add = (w) => { const t = words(w).slice(-MAX_WINDOW_WORDS).join(' '); if (words(t).length >= 6 && !out.includes(t)) out.push(t); };

  // After the last quote signal: the verse itself, in whatever words, with
  // any crowd work in between taken out.
  let m, lastEnd = -1;
  QUOTE_SIGNAL_RE.lastIndex = 0;
  while ((m = QUOTE_SIGNAL_RE.exec(recent)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd >= 0) add(words(withoutInterjections(recent.slice(lastEnd))).slice(0, 28).join(' '));

  // Fused: the last few seconds with the asides removed, so the pieces of a
  // verse said around them read as one.
  const fused = withoutInterjections(recent);
  add(words(fused).slice(-26).join(' '));

  // The last sentence, and the last two (a verse often spans a sentence break).
  const sentences = String(recent).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length) add(sentences[sentences.length - 1]);
  if (sentences.length > 1) add(sentences.slice(-2).join(' '));
  // Two sentences with a short aside between them ("…all you that are weary.
  // Are you listening? And I will give you rest.").
  if (sentences.length > 2 && words(sentences[sentences.length - 2]).length <= SHORT_SENTENCE_WORDS) {
    add(`${sentences[sentences.length - 3]} ${sentences[sentences.length - 1]}`);
  }

  // The last few seconds regardless of punctuation.
  const w = words(recent);
  add(w.slice(-24).join(' '));
  if (out.length < 3) add(w.slice(-14).join(' '));
  return out.slice(0, MAX_WINDOWS);
}

function hasQuoteSignal(text) { QUOTE_SIGNAL_RE.lastIndex = 0; return QUOTE_SIGNAL_RE.test(String(text || '')); }

// Thresholds — calibrated on the five eval sermons replayed word by word
// (6.7 hours): the screen tier made no clearly wrong sends there (every
// "unmatched" one was a real verse the answer key lacks), the offer tier ~9
// unmatched per hour; on written paraphrases the offer tier finds 83/99 and
// neither tier fires on 38 ordinary sermon sentences. A decision also has to
// repeat on the next window of speech before it is acted on (server.js) —
// single-window flukes were half of the noise.
//   rr     cross-encoder: does this passage say what the window says (0-1)
//   cos    meaning similarity of the best window (EmbeddingGemma)
//   lex    identifying wording shared (sum of IDF over shared word stems)
//   margin cross-encoder lead over the best different verse
const PARAPHRASE_THRESHOLDS = {
  offer:         { rr: 0.98, cos: 0.8, lex: 10 },              // Possible Matches
  offerInPlay:   { rr: 0.95, cos: 0.78, lex: 8 },              // …when the passage is already in play
  offerNoRerank: { cos: 0.82, lex: 10 },                       // non-English service: no cross-encoder
  offerModern:   { rr: 0.98, cos: 0.75, lex: 15, margin: 0.2 }, // read by the cross-encoder in modern wording (NIV-style quotes)
  send:          { rr: 0.99, cos: 0.84, lex: 15, margin: 0.2 }, // the screen
};
const OFFER_SCORE = 0.7, SEND_SCORE = 0.9;

/**
 * results: paraphraseSearch candidates ({ cos, rerankScore|null, lexIdf, ... }).
 * ctx: { affinity(verse) -> 0..3 }.
 * Returns { verse, key, target: 'viewer'|'suggestions', score, why } or null.
 */
function decideParaphrase(results, ctx = {}, T = PARAPHRASE_THRESHOLDS) {
  if (!results || !results.length) return null;
  const rrOf = (r) => (typeof r.rerankScore === 'number' ? r.rerankScore : -1);
  const ranked = results.slice().sort((a, b) => (rrOf(b) - rrOf(a)) || (b.cos - a.cos));
  const top = ranked[0];
  const key = `${top.book}|${top.chapter}|${top.verse}`;
  const second = ranked.find(r => r.reference !== top.reference);
  const rr = typeof top.rerankScore === 'number' ? top.rerankScore : null;
  const out = (target, score, why = null) => ({ verse: { ...top, paraphraseScore: score }, key, target, score, why });

  if (rr != null) {
    const S = T.send;
    const aff = (v) => (ctx.affinity ? ctx.affinity(v) : 0);
    const margin = second ? rr - Math.max(0, rrOf(second)) : 1;
    const sendable = rr >= S.rr && top.cos >= S.cos && top.lexIdf >= S.lex;
    if (sendable && margin >= S.margin) return out('viewer', SEND_SCORE);
    // Two verses that say the same thing ("whosoever shall call upon the name
    // of the Lord shall be saved": Romans 10:13 / Acts 2:21) can't be told
    // apart by meaning — the passage the preacher named or is reading can.
    if (sendable && second && aff(top) >= 2 && aff(second) < 2) return out('viewer', SEND_SCORE, 'the passage in play decides');
    const inPlay = aff(top) >= 2;
    const O = inPlay ? T.offerInPlay : T.offer;
    if (rr >= O.rr && top.cos >= O.cos && top.lexIdf >= O.lex) return out('suggestions', OFFER_SCORE, inPlay ? 'passage in play' : null);
    // Quoted from memory in modern words ("plans to prosper you and not to
    // harm you"): the KJV-calibrated scores fall short, the cross-encoder on a
    // modern wording doesn't. Offered only — never sent on this alone.
    const M = T.offerModern;
    const byModern = results.filter(r => typeof r.rerankModern === 'number').sort((a, b) => b.rerankModern - a.rerankModern);
    const mTop = byModern[0], mSecond = byModern.find(r => r.reference !== mTop?.reference);
    if (mTop && mTop.rerankModern >= M.rr && mTop.cos >= M.cos && mTop.lexIdf >= M.lex
        && mTop.rerankModern - Math.max(0, mSecond?.rerankModern ?? 0) >= M.margin) {
      return { verse: { ...mTop, paraphraseScore: OFFER_SCORE }, key: `${mTop.book}|${mTop.chapter}|${mTop.verse}`, target: 'suggestions', score: OFFER_SCORE, why: 'modern wording' };
    }
    return null;
  }
  const N = T.offerNoRerank;
  if (top.cos >= N.cos && top.lexIdf >= N.lex) return out('suggestions', OFFER_SCORE);
  return null;
}

module.exports = { paraphraseWindows, withoutInterjections, hasQuoteSignal, decideParaphrase, PARAPHRASE_THRESHOLDS, QUOTE_SIGNAL_RE };
