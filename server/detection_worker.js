// KAIRO — Detection Worker
// Single-phase init (no ONNX):
//   map.json → directIndex + verbatim inverted index + IDF map + verse fingerprints
//   → signals {type:'ready'}
//
// Five search layers:
//   1. directLookup      — explicit reference ("1 John 1:10"), O(1)
//   2. verbatimSearch    — exact phrase match across translations, ~5ms
//   3. fingerprintSearch — verse signature coverage for paraphrases, ~2ms
//   4. streaming anchor trie — word-by-word quote detection, sub-ms/word
//   5. semanticSearch    — meaning-based Candidates via embeddinggemma-300m,
//      loaded in the background after {type:'ready'} (see semantic_engine.js)
//      so its ~1-2s model load never delays the fast lexical layers coming
//      online; signals {type:'semanticReady'} separately once available.
'use strict';

const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs   = require('fs');
const semanticEngine = require('./semantic_engine');

const DATA_DIR = workerData?.dataDir || path.join(__dirname, '..', 'databases', 'bibles');
const MAP_PATH = path.join(DATA_DIR, 'map.json');

// ── Cached regex (avoid re-compilation in hot paths) ─────────────────────
const RE_NORM = /[^a-z0-9\s]/g;
const RE_WS   = /\s+/g;

// Hoisted once to module scope — this was previously redefined as an inline
// closure inside init(), verbatimSearch(), fingerprintSearch(), and
// fingerprintSearchInLibrary(), reallocating a closure on every hot-path call.
function norm(s) { return s.toLowerCase().replace(RE_NORM, '').replace(RE_WS, ' ').trim(); }

// ── Top-K selection (avoids full sort for large arrays) ──────────────────
function topK(arr, k, compareFn) {
  if (arr.length <= k) return arr.sort(compareFn);
  const top = arr.slice(0, k).sort(compareFn);
  for (let i = k; i < arr.length; i++) {
    if (compareFn(arr[i], top[top.length - 1]) < 0) {
      top[top.length - 1] = arr[i];
      top.sort(compareFn);
    }
  }
  return top;
}

// ── Context boost (shared between full and library fingerprint search) ───
function applyContextBoost(matchedWeight, contextHint, allVerses) {
  if (!contextHint || !contextHint.citations || !contextHint.citations.length) return;
  const WINDOW_MS      = 5 * 60 * 1000;
  const NEIGHBOR_RANGE = 5;
  const MAX_BOOST      = 0.15;

  const chapterNeighborhoods = new Map();
  for (const c of contextHint.citations) {
    if (!c.book || !c.chapter) continue;
    const key = `${c.book}|${c.chapter}`;
    const rf  = Math.max(0, 1 - c.age / WINDOW_MS);
    if (!chapterNeighborhoods.has(key)) chapterNeighborhoods.set(key, []);
    chapterNeighborhoods.get(key).push({ verse: c.verse, rf });
  }

  for (const [idx, weight] of matchedWeight.entries()) {
    const v    = allVerses[idx];
    const key  = `${v.book}|${v.chapter}`;
    const nbrs = chapterNeighborhoods.get(key);
    if (!nbrs) continue;
    let bestRF = 0;
    for (const { verse, rf } of nbrs) {
      if (verse === null || Math.abs(v.verse - verse) <= NEIGHBOR_RANGE) {
        bestRF = Math.max(bestRF, rf);
      }
    }
    if (bestRF > 0) {
      matchedWeight.set(idx, weight * (1 + MAX_BOOST * bestRF));
    }
  }
}

let verseMetadata        = [];
let directIndex          = null;   // Map<"Book|ch|vs", verse>
let verbatimIndex        = null;   // Map<word, number[]>  — inverted index for phrase match
let stemIndex            = null;   // Map<stem, number[]>  — healed(word) → verses, morphology bridge
let idfMap               = null;   // Map<word, number>    — IDF scores
let verseSignatures      = null;   // Map<idx, Map<word, idf>> — top N distinctive words per verse
let verseSignatureWeight = null;   // Map<idx, number> — total IDF weight of each verse's signature
let verseNormText        = null;   // Map<idx, string> — pre-computed norm(kjv_text)
let verseNormNlt         = null;   // Map<idx, string> — pre-computed norm(nlt_text)
let verseStemText        = null;   // Map<idx, string> — verseNormText with every word healWord()'d
let verseStemNlt         = null;   // Map<idx, string> — verseNormNlt with every word healWord()'d
let verseNormWords       = null;   // Map<idx, string[]> — verseNormText pre-split, avoids re-splitting per search call
let verseNormNltWords    = null;   // Map<idx, string[]> — verseNormNlt pre-split
let verseStemWords       = null;   // Map<idx, string[]> — verseStemText pre-split
let verseStemNltWords    = null;   // Map<idx, string[]> — verseStemNlt pre-split

// ── Streaming 4-gram anchor trie ─────────────────────────────────────────
// Word-level prefix trie over distinctive verse 4-grams.
// As STT words arrive one by one, we advance a set of active nodes through
// the trie. When depth 4 is reached, the terminal yields the matching verse(s).
// Per-word cost: O(active states) — no polling, no similarity math.
let anchorTrie       = null;   // root Map<word, node> where node is Map<word, node>
let anchorTerminals  = null;   // Map<node, Array<{idx, pos}>> at depth ≥ ANCHOR_N
let verseHealedWords = null;   // Map<idx, string[]> — pre-healed word list per verse (Layer 2)
let activeStates     = [];     // Array<{ node, depth }> — persists across streamText calls
let recentHitVerses  = new Map();   // Map<verseIdx, lastFireTime> — local dedupe

// Rolling history of recently-streamed (healed) words, oldest first — feeds
// extendBackward() below. An anchor only ever fires on the word that
// completes its own 4-gram, so without this, everything the preacher said
// BEFORE that point is invisible to the alignment tracker, which only ever
// extends forward from cand.cursor. Bounded well past ANCHOR_N + a
// reasonable backward-extension span; cheap to maintain (push + trim once
// per streamed word).
let recentWordHistory   = [];
const WORD_HISTORY_MAX  = 24;

// Layer 2 — alignment candidates track verses whose anchor fired and whose
// subsequent words continue to match the transcript in sequence. Cheap to
// maintain (one cursor per candidate) and drops fast on mismatch.
let alignmentCandidates = [];  // [{ idx, cursor, matched, misses, confirmed, firedAt }]

const ANCHOR_N       = 4;
const ANCHOR_DF_MAX  = 5;      // keep a 4-gram only if it appears in ≤5 verses
const HIT_DEDUP_MS   = 12000;  // don't re-fire the same verse within 12s in-worker

// Layer 2 tuning
const ALIGN_CONFIRM_AT   = 6;     // words aligned to escalate from anchor → confirmed
// IDF floor for confirmation, on top of the word-count floor above — found
// necessary from a real false-positive: liturgical/prayer language ("in the
// name of Jesus", "we give you the glory", "receive our thanks") is dense
// with short common phrases, and 6 CONSECUTIVE common words can coincidentally
// align with an unrelated verse's wording purely by chance. This layer had
// no IDF check at all before — word-count alone was the only bar, unlike
// verbatimSearch (see IDF_FULL_CONFIDENCE), so a "confirmed" auto-send here
// could fire on 6 aligned words that carried almost no actual identifying
// content. Reuses the same IDF_FULL_CONFIDENCE bar verbatim search uses, so
// both auto-send paths require the same minimum "this could only really be
// this one verse" evidence before going to the live screen.
const ALIGN_MISS_BUDGET  = 3;     // tolerate this many word skips before dropping —
                                  // covers filler ("you know", "uh", "amen") and
                                  // paraphrase substitutions between verse words so a
                                  // scrambled reading still reaches sequential confirmation.
const ALIGN_AGE_MS       = 20000; // drop candidates older than 20s without confirmation

// ── Algorithmic KJV stemmer ───────────────────────────────────────────────
// Applied to BOTH verse n-grams at build time AND transcript words at stream
// time, so morphological variants of any word in the Bible collapse to the
// same canonical token. Symmetric application is what matters — the stem
// doesn't need to be a real English word, only consistent between the trie
// and the transcript.
//
// The algorithm is a scoped Porter-style suffix stripper tuned for the
// English of the KJV and modern spoken paraphrases. Rules in priority order:
//
//   1. STT artifact heals  (oh→o, unto→to)        — pre-stem normalization
//   2. Irregular verbs     (hath/saith/came/…)    — genuine English irregulars
//      that no algorithmic stemmer can handle.
//   3. Suffix stripping    (-ies, -ied, -eth, -est, -ing, -ed, -es, -s)
//   4. Trailing -e collapse (come→com, gate→gat)  — pairs with -ing/-ed/-s
//      strips so come/coming/cometh/comes/came all meet at "com".
//   5. Double-consonant collapse (runn→run, putt→put)
//
// Stops-words and very short words (≤ 2 chars) are left alone. The DF ≤ 5
// filter on the 4-gram trie naturally self-prunes any combination that
// becomes too common after stemming, so aggressive stripping is safe.

// STT artifacts the speech-to-text layer produces. Applied before stemming.
//
// Also doubles as the bridge for archaic/British KJV spellings that a
// preacher pronounces normally but American-English STT transcribes with
// the modern/American spelling — "honour" is read aloud exactly like
// "honor", so the transcript says "honor", but the verse text says
// "honour". This is NOT a tense/suffix issue (suffixStrip can't touch it —
// the difference is mid-word, not a stripped ending), so without an
// explicit bridge these silently failed to match at all. Found empirically:
// map.json has 1,000+ combined occurrences of these words across all their
// forms — "shew" alone (the KJV's "show") appears 400+ times. Each entry
// maps the KJV/archaic spelling to its plain modern-spelled equivalent,
// which then continues through the normal IRREGULAR/suffixStrip pipeline
// below exactly as if it had been spoken that way — so only ONE spelling
// per family needs to be listed here; the rest (-s/-ed/-ing/-eth) fall out
// of the existing suffix rules once the mid-word spelling is bridged.
const STT_HEAL = {
  oh: 'o',
  unto: 'to',

  // shew (KJV "show") — very common; base + every inflected form, since
  // each one is a distinct literal word BEFORE suffix stripping runs.
  shew: 'show', shewed: 'showed', sheweth: 'showeth', shewing: 'showing',
  shewn: 'shown', shewest: 'showest',

  // -our → -or family (honour/favour/labour/neighbour/colour/armour/
  // rumour/saviour/behaviour/endeavour) — British KJV spelling vs.
  // American STT output. Includes the inflected forms that actually occur
  // in the text; suffixStrip handles further conjugation once the mid-word
  // spelling itself is bridged to the American form.
  honour: 'honor', honours: 'honors', honoured: 'honored',
  honoureth: 'honoreth', honourable: 'honorable',
  favour: 'favor', favours: 'favors', favoured: 'favored', favoureth: 'favoreth',
  labour: 'labor', labours: 'labors', laboured: 'labored',
  laboureth: 'laboreth', labouring: 'laboring',
  neighbour: 'neighbor', neighbours: 'neighbors',
  colour: 'color', colours: 'colors', coloured: 'colored',
  armour: 'armor', armours: 'armors',
  rumour: 'rumor', rumours: 'rumors',
  saviour: 'savior', saviours: 'saviors',
  behaviour: 'behavior', behaviours: 'behaviors',
  endeavour: 'endeavor', endeavoured: 'endeavored', endeavouring: 'endeavoring',

  // fulness (KJV) vs. fullness (modern/STT) — same word, not a suffix issue.
  fulness: 'fullness',
};

// English irregulars — every entry here is a verb whose forms differ enough
// from the base that pure suffix stripping can't collapse them. Each entry
// maps directly to a stem, so the stemmer short-circuits before suffix
// rules. Kept intentionally small; this is the irreducible core.
const IRREGULAR = {
  // be
  am: 'be', are: 'be', is: 'be', was: 'be', were: 'be',
  been: 'be', being: 'be', be: 'be', art: 'be',
  // have
  hath: 'hav', has: 'hav', have: 'hav', had: 'hav', having: 'hav', hast: 'hav',
  // say (KJV saith + modern said)
  saith: 'sai', said: 'sai', says: 'sai', saying: 'sai', say: 'sai',
  // do
  doth: 'do', doeth: 'do', does: 'do', did: 'do', done: 'do', doing: 'do',
  // go (went is irregular; going handled by -ing strip)
  went: 'go', gone: 'go',
  // show (shown is an irregular past participle, not a suffix pattern —
  // needed so the "shewn" → "shown" bridge in STT_HEAL actually converges
  // on the same stem as "show"/"showed"/"shows")
  shown: 'show',
  // come (came is irregular)
  came: 'com',
  // see (saw/seen irregular)
  saw: 'se', seen: 'se',
  // know (knew/known irregular)
  knew: 'kno', known: 'kno',
  // take (took/taken irregular)
  took: 'tak', taken: 'tak',
  // give (gave/given irregular)
  gave: 'giv', given: 'giv',
  // hear (heard irregular)
  heard: 'hear',
  // -ought past-tense cluster (brought/bought/taught/sought/thought/fought/caught/wrought)
  brought: 'bring', bought: 'buy', taught: 'teach', sought: 'seek',
  thought: 'think', fought: 'fight', caught: 'catch', wrought: 'work',
  // other common KJV irregulars
  ate: 'eat', eaten: 'eat',
  ran: 'run', rose: 'ris', risen: 'ris',
  fell: 'fall', fallen: 'fall',
  spoke: 'speak', spoken: 'speak', spake: 'speak',
  broke: 'break', broken: 'break', brake: 'break',
  stood: 'stand', sat: 'sit',
  wrote: 'writ', written: 'writ',
  chose: 'choos', chosen: 'choos',
  // KJV archaic contractions — archaic "brethren" is the plural of brother,
  // truly suppletive, can't be stripped.
  brethren: 'brother',
  // men/women suppletive plurals
  men: 'man', women: 'woman', children: 'child',

  // Additional irregulars added after the phrase-match scoring fix — Bible
  // narrative leans heavily on these, and none of them follow a stem-able
  // suffix pattern (suffixStrip only handles regular -ed/-ing/-s/-es/-eth/
  // -est), so without an explicit mapping a spoken "kept"/"killed"/"kills"
  // never lines up with each other even after the verse-side stemming fix.
  // Genealogy ("begat"), a huge share of KJV narrative text, is included.
  beget: 'beget', begat: 'beget', begetteth: 'beget', begotten: 'beget',
  bear: 'bear', bare: 'bear', bore: 'bear', born: 'bear', borne: 'bear',
  slay: 'slay', slew: 'slay', slain: 'slay',
  smite: 'smite', smote: 'smite', smitten: 'smite',
  draw: 'draw', drew: 'draw', drawn: 'draw',
  swear: 'swear', swore: 'swear', sware: 'swear', sworn: 'swear',
  tear: 'tear', tore: 'tear', torn: 'tear',
  wear: 'wear', wore: 'wear', worn: 'wear',
  shake: 'shake', shook: 'shake', shaken: 'shake',
  forsake: 'forsak', forsook: 'forsak', forsaken: 'forsak',
  hide: 'hid', hid: 'hid', hidden: 'hid',
  keep: 'keep', kept: 'keep', keepeth: 'keep',
  weep: 'weep', wept: 'weep',
  sleep: 'sleep', slept: 'sleep',
  leave: 'leav', left: 'leav',
  lose: 'los', lost: 'los',
  tell: 'tell', told: 'tell',
  sell: 'sell', sold: 'sell',
  hold: 'hold', held: 'hold',
  understand: 'understand', understood: 'understand',
  build: 'build', built: 'build',
  send: 'send', sent: 'send',
  spend: 'spend', spent: 'spend',
  feel: 'feel', felt: 'feel',
  find: 'find', found: 'find',
  bind: 'bind', bound: 'bind',
  mean: 'mean', meant: 'mean',
  deal: 'deal', dealt: 'deal',
  dwell: 'dwell', dwelt: 'dwell',
  cleave: 'cleav', clave: 'cleav', cloven: 'cleav',
  strive: 'striv', strove: 'striv', striven: 'striv',
  arise: 'ris', arose: 'ris', arisen: 'ris',
  // NOTE: "ground" (dirt/earth) and "lead" (the metal) are deliberately left
  // out of the grind/lead-the-verb families below — both nouns are far more
  // common in KJV text ("fell to the ground", "table of shewbread") than the
  // corresponding verb sense, and folding them in would misroute retrieval.
  fly: 'fly', flew: 'fly', flown: 'fly',
  grow: 'grow', grew: 'grow', grown: 'grow',
  throw: 'throw', threw: 'throw', thrown: 'throw',
  blow: 'blow', blew: 'blow', blown: 'blow',
  shine: 'shin', shone: 'shin', shined: 'shin',
  steal: 'steal', stole: 'steal', stolen: 'steal',
  // "rid" ("get rid of") is a real, distinct KJV word — map ride/rode/ridden
  // to "ride" rather than "rid" so the two don't collide.
  ride: 'ride', rode: 'ride', ridden: 'ride',
};

// Algorithmic suffix stripper. Runs after STT heal + irregulars.
function suffixStrip(s) {
  if (s.length <= 3) return s;
  // -ies / -ied  (babies→baby, cried→cry)
  if (s.length > 4 && s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.length > 4 && s.endsWith('ied')) return s.slice(0, -3) + 'y';
  // -eth / -est  (cometh/liftest)
  if (s.length > 4 && s.endsWith('eth')) return s.slice(0, -3);
  if (s.length > 4 && s.endsWith('est')) return s.slice(0, -3);
  // -ing  (lifting/coming)
  if (s.length > 5 && s.endsWith('ing')) return s.slice(0, -3);
  // -ed   (lifted/loved)
  if (s.length > 4 && s.endsWith('ed'))  return s.slice(0, -2);
  // -es   (gates/wishes) — but not -ses, -xes, -zes, -ches, -shes that drop only -s
  if (s.length > 4 && s.endsWith('es')) {
    if (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('zes') ||
        s.endsWith('ches') || s.endsWith('shes')) return s.slice(0, -2);
    return s.slice(0, -2);
  }
  // -s    (plural / 3rd-person) — preserve -ss, -us, -is (class, Jesus, this)
  if (s.length > 3 && s.endsWith('s') &&
      !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) return s.slice(0, -1);
  return s;
}

// Final collapse pass: trailing -e drop + double-consonant collapse.
// Runs after every other rule so come/coming/cometh/comes/came all meet
// at the same "com" stem.
function collapseEnd(s) {
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  if (s.length > 3) {
    const a = s[s.length - 1], b = s[s.length - 2];
    if (a === b && !'aeiou'.includes(a)) s = s.slice(0, -1);
  }
  return s;
}

// Bounded memo cache. Sermon vocabulary is highly repetitive — once a word
// has been healed once, every subsequent occurrence (and there are many)
// returns from the cache instead of re-running suffixStrip + collapseEnd
// regexes. Bounded so a pathological transcript can't grow it forever;
// when full we drop the oldest entries (Map preserves insertion order).
const _healCache    = new Map();
const _HEAL_CACHE_MAX = 8192;

function healWord(w) {
  if (!w) return w;
  const cached = _healCache.get(w);
  if (cached !== undefined) return cached;

  let healed;
  if (STT_HEAL[w])       healed = IRREGULAR[STT_HEAL[w]] || collapseEnd(suffixStrip(STT_HEAL[w]));
  else if (IRREGULAR[w]) healed = IRREGULAR[w];
  else if (w.length <= 2) healed = w;
  else healed = collapseEnd(suffixStrip(w));

  if (_healCache.size >= _HEAL_CACHE_MAX) {
    // Evict oldest ~256 entries in one pass so we don't pay this on every set.
    const it = _healCache.keys();
    for (let i = 0; i < 256; i++) _healCache.delete(it.next().value);
  }
  _healCache.set(w, healed);
  return healed;
}

// Max distinctive words stored per verse fingerprint.
// 10 gives better coverage for longer verses without inflating noise for short ones
// (short verses simply have fewer qualifying words — the cap is a ceiling, not a target).
const SIGNATURE_SIZE = 10;

// ── Stop words ────────────────────────────────────────────────────────────
// Structural words that carry no topical meaning in scripture detection.
// IDF also handles very common words, but this speeds up query processing.
const STOP_WORDS = new Set([
  // Articles / prepositions / conjunctions
  'a','an','the','and','but','or','for','nor','yet','so',
  'in','on','at','to','of','by','up','as','is','it','be',
  'do','if','no','i','we','he','me','us','am','my',
  // Auxiliary verbs
  'was','are','were','been','being','have','has','had',
  'does','did','will','would','can','could','shall','should','may','might',
  // Pronouns
  'you','she','they','them','their','this','that','these','those',
  'who','which','what','him','his','her','its','our','your',
  // Common adverbs / filler
  'not','all','very','also','just','more','then','than',
  'when','where','there','here','now','too','only','even','still',
  'from','with','into','about','over','after','before','out','down',
  'how','each','both','some','any','same','other','such','own','while',
  'say','said','says','come','came','went','get','got','make','made',
  // Biblical archaic structural words
  'thou','thee','thy','thine','ye','hath','doth','art',
  'unto','saith','thus','yea','nay','therefore','wherefore',
  'moreover','lo','behold','thereof','therein','whereby','wherein',
  'whereof','whatsoever','whosoever','thence','hence','whence',
]);

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  console.log('[DetectionWorker] Loading map.json…');
  const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  verseMetadata = raw.verses;

  // O(1) direct lookup
  directIndex = new Map();
  for (const v of verseMetadata) {
    directIndex.set(`${v.book}|${v.chapter}|${v.verse}`, v);
  }
  console.log(`[DetectionWorker] ${verseMetadata.length} verses indexed.`);

  // Inverted index: word → [verseIdx, ...]
  // Also tracks document frequency (df) for IDF computation

  // KJV markup: [bracketed] section headings ("[A Psalm of David.]") are not
  // spoken — drop them before indexing, or they inflate verse word counts and
  // suppress verbatim coverage scores (Psalm 23:1 read verbatim scored 0.77
  // instead of 0.93 and never cleared the auto-display bar). {braced} italic
  // words ARE spoken; norm() strips the braces and keeps the word, which is
  // already correct.
  const RE_HEADING = /\[[^\]]*\]/g;

  // Pre-compute normalized text for every verse (avoids re-normalizing in hot loops)
  verseNormText = new Map();
  verseNormNlt  = new Map();
  for (let i = 0; i < verseMetadata.length; i++) {
    const v = verseMetadata[i];
    verseNormText.set(i, norm(v.kjv_text.replace(RE_HEADING, ' ')));
    if (v.nlt_text) verseNormNlt.set(i, norm(v.nlt_text.replace(RE_HEADING, ' ')));
  }

  // Stemmed text for every verse — same content as verseNormText/verseNormNlt
  // but every word run through healWord() first. Built once here so
  // verbatimSearch can compare tense/inflection-normalized text directly
  // instead of raw words: a spoken "kept"/"keeping"/"keepeth" all collapse to
  // the same stem the KJV's own wording collapses to, so STT tense drift no
  // longer breaks the literal phrase-window match (previously it only helped
  // *retrieve* the candidate verse via stemIndex below, not score it — a
  // tense mismatch still forced the match down to the much looser 4-gram
  // fallback tier, which is where wrong-verse noise creeps in).
  //
  // Word-array forms (verseNormWords/verseStemWords, + their NLT twins) are
  // cached alongside the joined-string forms — verbatimSearch needs both
  // (`.includes()` substring checks want the string; IDF lookups and n-gram
  // windows want the array by position) and re-splitting the same static
  // per-verse string on every single search call, for every candidate verse,
  // was showing up as real repeated work on the detection hot path.
  verseStemText     = new Map();
  verseStemNlt      = new Map();
  verseNormWords    = new Map();
  verseNormNltWords = new Map();
  verseStemWords    = new Map();
  verseStemNltWords = new Map();
  for (let i = 0; i < verseMetadata.length; i++) {
    const normWords = verseNormText.get(i).split(' ').filter(Boolean);
    verseNormWords.set(i, normWords);
    const stemWords = normWords.map(healWord);
    verseStemWords.set(i, stemWords);
    verseStemText.set(i, stemWords.join(' '));

    const nltN = verseNormNlt.get(i);
    if (nltN) {
      const nltNormWords = nltN.split(' ').filter(Boolean);
      verseNormNltWords.set(i, nltNormWords);
      const nltStemWords = nltNormWords.map(healWord);
      verseStemNltWords.set(i, nltStemWords);
      verseStemNlt.set(i, nltStemWords.join(' '));
    }
  }

  const tempIndex = new Map(); // word → Set<idx> (unique per verse)
  for (let i = 0; i < verseMetadata.length; i++) {
    const kjvN = verseNormText.get(i);
    const nltN = verseNormNlt.get(i);
    const words = new Set([
      ...kjvN.split(' '),
      ...(nltN ? nltN.split(' ') : []),
    ]);
    for (const w of words) {
      if (w.length < 3) continue;
      if (!tempIndex.has(w)) tempIndex.set(w, []);
      tempIndex.get(w).push(i);
    }
  }
  verbatimIndex = tempIndex;
  console.log(`[DetectionWorker] Verbatim index: ${verbatimIndex.size} unique words.`);

  // Stem index: healed(word) → [verseIdx, ...]. The raw verbatim index keys on
  // literal verse words, so a lookup of healWord("loved")="lov" finds nothing.
  // This index lets verbatim/fingerprint retrieval bridge morphology the same
  // way the trie layer does — "loved", "loveth" and "love" all stem to "lov"
  // and resolve to the same bucket.
  {
    const stemTmp = new Map();   // stem → Set<idx>
    for (const [word, indices] of verbatimIndex.entries()) {
      const stem = healWord(word);
      if (stem === word) continue;          // raw lookups already cover these
      let bucket = stemTmp.get(stem);
      if (!bucket) { bucket = new Set(); stemTmp.set(stem, bucket); }
      for (const idx of indices) bucket.add(idx);
    }
    stemIndex = new Map();
    for (const [stem, set] of stemTmp) stemIndex.set(stem, [...set]);
    console.log(`[DetectionWorker] Stem index: ${stemIndex.size} stems.`);
  }

  // IDF map — log((N - df + 0.5) / (df + 0.5) + 1)
  // High IDF = rare/distinctive word (e.g. "meditate" ≈ 7.6)
  // Low IDF  = very common word (e.g. "lord" ≈ 1.2)
  const N = verseMetadata.length;
  idfMap = new Map();
  for (const [word, indices] of verbatimIndex.entries()) {
    const df  = indices.length;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(word, idf);
  }
  console.log('[DetectionWorker] IDF map ready.');

  // Verse fingerprints — top SIGNATURE_SIZE words by IDF for each verse.
  // Only words with IDF ≥ 1.5 qualify (rules out words appearing in >80% of verses).
  // Stored as Map<word, idf> per verse for O(1) hit lookup at query time.
  // Nothing hardcoded — derived entirely from the Bible data + IDF scores above.
  const IDF_FLOOR = 1.5;
  verseSignatures      = new Map();
  verseSignatureWeight = new Map();
  for (let i = 0; i < verseMetadata.length; i++) {
    const kjvN  = verseNormText.get(i);
    const nltN  = verseNormNlt.get(i);
    const words = [...new Set([
      ...kjvN.split(' '),
      ...(nltN ? nltN.split(' ') : []),
    ])].filter(w => w.length >= 4 && !STOP_WORDS.has(w));

    const top = words
      .map(w => [w, idfMap.get(w) || 0])
      .filter(([, idf]) => idf >= IDF_FLOOR)
      .sort((a, b) => b[1] - a[1])
      .slice(0, SIGNATURE_SIZE);

    verseSignatures.set(i, new Map(top));
    verseSignatureWeight.set(i, top.reduce((s, [, idf]) => s + idf, 0));
  }
  console.log(`[DetectionWorker] Verse fingerprints built (${SIGNATURE_SIZE} words/verse max).`);

  buildAnchorTrie();

  parentPort.postMessage({ type: 'ready' });
  console.log('[DetectionWorker] Ready — all four detection layers active.');

  // Semantic layer loads in the background — not awaited here, see the
  // header comment. Failure is non-fatal (missing/not-yet-built embeddings
  // file, e.g. a fresh install before build_verse_embeddings.mjs has run) —
  // semanticSearch calls just no-op via isReady() until this succeeds.
  semanticEngine.ensureLoaded()
    .then(() => parentPort.postMessage({ type: 'semanticReady' }))
    .catch(err => console.warn('[DetectionWorker] Semantic layer unavailable:', err.message));
}

// ── Anchor trie build ─────────────────────────────────────────────────────
// Pass 1: extract every 4-gram from every verse, count document frequency.
// Pass 2: insert into trie only those with DF ≤ ANCHOR_DF_MAX. Common phrases
// ("and it came to pass") are skipped — they'd fire on every sentence.
// Rare phrases ("lift up your heads", "meditate day and night") become anchors
// that fire the moment the 4th word lands.
function buildAnchorTrie() {
  const t0 = Date.now();
  verseHealedWords = new Map();
  const dfCounts   = new Map();   // Map<"w1 w2 w3 w4", Set<verseIdx>>

  // Pass 1 — cache healed word list per verse + count 4-gram DF
  for (let i = 0; i < verseMetadata.length; i++) {
    const words = (verseNormText.get(i) || '')
      .split(' ')
      .filter(Boolean)
      .map(healWord);
    verseHealedWords.set(i, words);
    for (let k = 0; k + ANCHOR_N <= words.length; k++) {
      const key = words.slice(k, k + ANCHOR_N).join(' ');
      let set = dfCounts.get(key);
      if (!set) { set = new Set(); dfCounts.set(key, set); }
      set.add(i);
    }
  }

  // Pass 2 — insert each distinctive 4-gram into trie, tagging with position.
  // Terminals store df (document frequency) so anchor fires can be scored by
  // distinctiveness. A df=1 4-gram is unique to one verse; df=5 is shared.
  anchorTrie      = new Map();
  anchorTerminals = new Map();
  let kept = 0, skipped = 0;

  for (let i = 0; i < verseMetadata.length; i++) {
    const words = verseHealedWords.get(i) || [];
    for (let k = 0; k + ANCHOR_N <= words.length; k++) {
      const gram = words.slice(k, k + ANCHOR_N);
      const key  = gram.join(' ');
      const df   = dfCounts.get(key).size;
      if (df > ANCHOR_DF_MAX) { skipped++; continue; }
      let node = anchorTrie;
      for (let d = 0; d < ANCHOR_N; d++) {
        let child = node.get(gram[d]);
        if (!child) { child = new Map(); node.set(gram[d], child); }
        node = child;
      }
      let terminal = anchorTerminals.get(node);
      if (!terminal) { terminal = { df, entries: [] }; anchorTerminals.set(node, terminal); }
      terminal.entries.push({ idx: i, pos: k });
      kept++;
    }
  }

  console.log(`[Anchor] Trie built in ${Date.now() - t0}ms — ${kept} distinctive 4-grams kept, ${skipped} common skipped.`);
}

// An anchor only ever fires on the word that completes its own 4-gram, and
// the alignment candidate it opens only ever extends FORWARD from there
// (cand.cursor advances, never retreats) — so anything the preacher said
// BEFORE the anchor point was structurally invisible to this whole layer,
// no matter how well it actually matched. Real incident: "come and let us
// reason together" (Isaiah 1:18's real text: "Come NOW, and let us reason
// together") — the dropped "now" sits exactly where a 4-gram anchor would
// need to start on "come", so the anchor only ever fires later, on "and
// let us reason" — and the genuinely-matching "come" spoken before it was
// never credited. Owner's own framing: "it should fill gaps or fuse things
// when 4/5 are correct as long as they match a scripture verse sequence."
//
// Mirrors the forward tolerance in streamWord's per-tick loop (skip one
// verse word on mismatch, burn a miss, stop when misses run out) but walks
// BACKWARD from the anchor's own start position through recentWordHistory
// — the same words the forward loop can already see, just the ones that
// arrived before this exact verse's candidate was born. Bounded by
// WORD_HISTORY_MAX; returns zero contribution (not an error) once the
// history or the verse's own text runs out.
// Below this per-word IDF, a match doesn't count toward `matched`/
// `matchedIdf` at all — it still lets the backward walk continue (a real
// grammatical-word match isn't a "miss," no reason to burn budget on it),
// it just can't be the THING that promotes a candidate to confirmed.
// Real regression this closes: the harness (all 5 real-sermon fixtures)
// showed backward extension alone traded +22 wrong auto-sends for only +1
// true positive before this floor existed — common words ("the," "and,"
// "of," "in," "to," "is," "it," "a," "he," all well under 2 here) were
// padding the RAW WORD-COUNT floor (ALIGN_CONFIRM_AT) against completely
// unrelated verses purely by coincidence, the exact false-positive shape
// this codebase has fought all night ("our father in the" / "praise the
// Lord"). Calibrated directly against the real corpus's own idfMap: "the"
// 0.25, "and" 0.26, "of" 0.52, "in" 1.16, "to" 1.13, "is" 1.70, "it" 1.87,
// "a" 1.57, "he" 1.40 — all excluded. "come" 2.83, "now" 3.15, "let" 3.22,
// "us" 3.34 — the actual words needed for the real "come and let us reason
// together" incident this whole mechanism exists for — all included.
const MEANINGFUL_BACKWARD_WORD_IDF = 2.0;
// Deliberately small — the real incident this exists for ("come and let us
// reason together," one dropped word) only ever needs 1-2 words of
// backward credit. Harness comparison (all 5 real fixtures) showed even
// the IDF-floored version still traded meaningfully more wrong auto-sends
// than the one true positive it gained was worth once the walk was allowed
// to range further back — capping the total distance keeps this narrowly
// scoped to "the anchor started one word late," not a general-purpose
// long-range fuzzy matcher.
const BACKWARD_EXTENSION_MAX_WORDS = 2;

function extendBackward(verseIdx, versePos) {
  const words    = verseHealedWords.get(verseIdx) || [];
  const rawWords = verseNormWords.get(verseIdx);
  const contributedWords = new Set();
  let matched = 0;
  let matchedIdf = 0;
  if (versePos <= 0) return { matched, matchedIdf, contributedWords };

  let vIdx   = versePos - 1;                          // verse word just before the anchor
  let hIdx   = recentWordHistory.length - 1 - ANCHOR_N; // transcript word just before the anchor's own ANCHOR_N words
  let misses = ALIGN_MISS_BUDGET;

  while (vIdx >= 0 && hIdx >= 0 && matched < BACKWARD_EXTENSION_MAX_WORDS) {
    if (words[vIdx] === recentWordHistory[hIdx]) {
      const w = rawWords[vIdx];
      const wIdf = idfMap.get(w) || 0;
      if (wIdf >= MEANINGFUL_BACKWARD_WORD_IDF && !contributedWords.has(w)) {
        matchedIdf += wIdf;
        contributedWords.add(w);
        matched++;
      }
      vIdx--; hIdx--;
    } else if (misses > 0 && vIdx - 1 >= 0 && words[vIdx - 1] === recentWordHistory[hIdx]) {
      // The verse has one extra word here the transcript is missing (an
      // STT-dropped word — the exact "come NOW, and" shape) — skip past it
      // and keep walking backward.
      const w = rawWords[vIdx - 1];
      const wIdf = idfMap.get(w) || 0;
      if (wIdf >= MEANINGFUL_BACKWARD_WORD_IDF && !contributedWords.has(w)) {
        matchedIdf += wIdf;
        contributedWords.add(w);
        matched++;
      }
      vIdx -= 2; hIdx--;
      misses--;
    } else if (misses > 0) {
      // The preacher said a word here that doesn't align at all — burn a
      // miss on the transcript side, don't move the verse cursor.
      misses--;
      hIdx--;
    } else {
      break;
    }
  }
  return { matched, matchedIdf, contributedWords };
}

// Hoisted out of streamWord so V8 doesn't re-allocate a fresh closure on
// every spoken word — streamWord runs at audio-tick rate (~3-5×/s during
// speech) so the GC churn was non-trivial. `next` and `anchors` are passed
// in by reference; alignmentCandidates / recentHitVerses are module-scoped.
function _advanceAnchor(node, depth, word, now, next, anchors) {
  const child = node.get(word);
  if (!child) return;
  const newDepth = depth + 1;
  if (newDepth >= ANCHOR_N) {
    const terminal = anchorTerminals.get(child);
    if (terminal) {
      for (const { idx, pos } of terminal.entries) {
        const last = recentHitVerses.get(idx) || 0;
        if (now - last < HIT_DEDUP_MS) continue;
        recentHitVerses.set(idx, now);
        // IDF weight of the matched 4-gram itself — a df=1 4-gram is unique
        // to one verse across the whole Bible, but "unique combination"
        // doesn't guarantee the individual words are meaningfully rare
        // ("our father in the" is 4 ordinary words that only HAPPEN to
        // combine uniquely in Genesis 42:32 — a preacher saying "our father
        // in the Lord" in an ordinary prayer isn't quoting it). Carried
        // through to server.js's df=1 fast-share gate for the same reason
        // ALIGN_CONFIRM_AT got an IDF floor above.
        const idf = idfWeightedSpan(verseNormWords.get(idx), pos, ANCHOR_N);

        // Backward extension (see extendBackward's own comment for the
        // real "come and let us reason together" incident) — credit
        // whatever the preacher said immediately before this anchor that
        // also matches the verse's own preceding words, tolerating the
        // same kind of gap the forward loop already tolerates.
        // ALWAYS COMPUTED now (previously disabled by default entirely —
        // see git history / BACKWARD_EXTENSION_MAX_WORDS's comment for the
        // full story: unconditionally trusting a backward-extended
        // confirmation the same as a purely-forward one traded +14 to +22
        // wrong auto-sends for only +1 true positive against the real
        // 191-item ground truth). Re-enabled with the owner's own suggested
        // fix from that writeup: don't trust it ALONE — `viaBackwardExtension`
        // below tags exactly which confirmations only happened BECAUSE of
        // this seed (would never have reached ALIGN_CONFIRM_AT/
        // ANCHOR_CONFIRM_IDF from forward words alone); server.js only lets
        // those auto-send when a second, independent method has also,
        // separately hit the exact same verse (EvidenceLedger corroboration)
        // — otherwise they're demoted to the same Candidates-only "moderate"
        // tier bug #30/#31 already built for exactly this shape of evidence.
        // A confirmation that WOULD have happened from forward words alone
        // is untouched either way — `viaBackwardExtension` is only ever true
        // for the genuinely backward-dependent case, so nothing already-safe
        // gets slower or stricter; it can only ever reach confirmation a
        // word or two SOONER now, never later.
        const back = extendBackward(idx, pos);
        const totalMatched = ANCHOR_N + back.matched;
        const totalIdf     = idf + back.matchedIdf;

        anchors.push({ verseIdx: idx, depth: newDepth, df: terminal.df, idf: totalIdf });

        // Open an alignment candidate so subsequent words can promote this
        // anchor to confirmed. Starts already at ANCHOR_N (+ any backward-
        // extended) words matched — matchedIdf seeded the same way.
        // contributedWords tracks which distinct verse-words have already
        // paid into matchedIdf — without it, a verse built from a couple of
        // repeated common words ("praise... the LORD... Praise ye the
        // LORD") can double-count the same word each time it recurs and
        // walk matchedIdf up to a "certain" score on repetition alone, not
        // genuine vocabulary diversity. Real incident: "praise the Lord"
        // (filler, not a citation) cleared the confirm bar against Psalms
        // 150:6 this way even after the bar itself was raised twice.
        const seedWords = (verseNormWords.get(idx) || []).slice(pos, pos + ANCHOR_N);
        const seedSet = new Set(seedWords);
        for (const w of back.contributedWords) seedSet.add(w);
        alignmentCandidates.push({
          idx,
          cursor:     pos + ANCHOR_N,
          matched:    totalMatched,
          matchedIdf: totalIdf,
          // Fixed seed contribution from this anchor's own backward
          // extension — never changes after candidate creation, used at
          // confirm time to test "would this have confirmed without it."
          backwardSeedMatched: back.matched,
          backwardSeedIdf:     back.matchedIdf,
          contributedWords: seedSet,
          misses:     ALIGN_MISS_BUDGET,
          confirmed:  false,
          firedAt:    now,
        });
      }
    }
  }
  if (newDepth < ANCHOR_N) next.push({ node: child, depth: newDepth });
}

// ── Streaming advance ────────────────────────────────────────────────────
// Called once per incoming word. Advances every active state one step and
// opens a new state from the root. Returns any verse indexes that fired
// (reached depth ANCHOR_N at a terminal node) at this tick, with local
// dedupe so the same verse can't re-fire within HIT_DEDUP_MS.
function streamWord(raw) {
  if (!anchorTrie) return { anchors: [], confirmed: [] };
  const word = healWord(
    String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  );
  if (!word) return { anchors: [], confirmed: [] };

  recentWordHistory.push(word);
  if (recentWordHistory.length > WORD_HISTORY_MAX) recentWordHistory.shift();

  const now       = Date.now();
  const anchors   = [];   // new 4-gram anchor fires from this word
  const confirmed = [];   // candidates that hit ALIGN_CONFIRM_AT alignment this word

  // ── Layer 2: advance alignment candidates ───────────────────────────────
  // For each open candidate, does the verse's next word equal the current
  // transcript word? If yes, cursor++. If no, spend a miss (skip one verse
  // word). When misses run out → drop. When `matched` crosses ALIGN_CONFIRM_AT
  // for the first time → emit a confirmed fire.
  const kept = [];
  for (const cand of alignmentCandidates) {
    if (now - cand.firedAt > ALIGN_AGE_MS) continue;

    const words    = verseHealedWords.get(cand.idx) || [];
    const rawWords = verseNormWords.get(cand.idx);   // same length/order as `words` — for IDF lookup
    if (cand.cursor >= words.length) continue;   // ran off the end — retire quietly

    let matchedThisTick = false;
    if (words[cand.cursor] === word) {
      const w = rawWords[cand.cursor];
      if (!cand.contributedWords.has(w)) {
        cand.matchedIdf += idfMap.get(w) || 0;
        cand.contributedWords.add(w);
      }
      cand.cursor++;
      cand.matched++;
      matchedThisTick = true;
    } else if (cand.misses > 0 && cand.cursor + 1 < words.length && words[cand.cursor + 1] === word) {
      // Skip one verse word (STT insertion or paraphrase) — the matched word
      // is the one at cursor+1 (the skipped word at cursor contributes no IDF).
      const w = rawWords[cand.cursor + 1];
      if (!cand.contributedWords.has(w)) {
        cand.matchedIdf += idfMap.get(w) || 0;
        cand.contributedWords.add(w);
      }
      cand.cursor   += 2;
      cand.matched++;
      cand.misses--;
      matchedThisTick = true;
    } else if (cand.misses > 0) {
      // Speaker said a word that doesn't align here at all — burn a miss,
      // but don't advance the cursor. The candidate waits for its next word.
      cand.misses--;
    } else {
      continue;   // dead
    }

    // Word-count floor (structural: enough sequential alignment happened)
    // AND IDF floor (content: that alignment carries real identifying
    // weight, not just a run of coincidentally-common words) — see the
    // comment above ALIGN_CONFIRM_AT for why both are needed. Deliberately a
    // separate, higher constant from IDF_FULL_CONFIDENCE rather than reusing
    // it — that one also normalizes verbatimSearch's score curve, so raising
    // it to tighten this gate would have quietly dropped raw similarity
    // scores everywhere. Raised from 8 after a real incident: "praise the
    // Lord" (said as filler, not read as scripture) cleared 8 against Psalms
    // 150:6 and auto-sent to the live screen.
    if (matchedThisTick && !cand.confirmed
        && cand.matched >= ALIGN_CONFIRM_AT && cand.matchedIdf >= ANCHOR_CONFIRM_IDF) {
      cand.confirmed = true;
      // Would this candidate have confirmed WITHOUT its backward-extension
      // seed? Subtract the fixed seed contribution and re-check the exact
      // same bar. See the comment above `back`'s own computation for why
      // this distinction matters — only a confirmation that genuinely
      // depends on backward extension needs the extra corroboration gate
      // server.js applies downstream.
      const viaBackwardExtension = cand.backwardSeedMatched > 0
        && !(cand.matched - cand.backwardSeedMatched >= ALIGN_CONFIRM_AT
             && cand.matchedIdf - cand.backwardSeedIdf >= ANCHOR_CONFIRM_IDF);
      confirmed.push({ verseIdx: cand.idx, matched: cand.matched, matchedIdf: cand.matchedIdf, viaBackwardExtension });
    }
    kept.push(cand);
  }
  alignmentCandidates = kept;

  // ── Layer 1: advance trie, open new anchor fires ────────────────────────
  const next = [];
  for (const s of activeStates) _advanceAnchor(s.node, s.depth, word, now, next, anchors);
  _advanceAnchor(anchorTrie, 0, word, now, next, anchors);

  activeStates = next.length > 50 ? next.slice(-50) : next;

  // Bound alignment candidate set too — keep the most recent
  if (alignmentCandidates.length > 40) {
    alignmentCandidates = alignmentCandidates.slice(-40);
  }

  return { anchors, confirmed };
}

function streamReset() {
  activeStates         = [];
  alignmentCandidates  = [];
  recentHitVerses.clear();
  recentWordHistory    = []; // a new session must not credit backward extension from a previous, unrelated sermon's tail words
  // Without this, a worker reused across services (no explicit
  // buildTopicLibrary call yet) keeps the previous sermon's topic bias for up
  // to 60s into the new session, skewing fingerprint scoring toward the wrong
  // passage.
  topicLibrary      = null;
  topicLibraryWords = [];
}

// ── Direct lookup ─────────────────────────────────────────────────────────
function directLookup(book, chapter, verse) {
  let v = directIndex.get(`${book}|${chapter}|${verse}`);
  if (!v && book === 'Psalm') v = directIndex.get(`Psalms|${chapter}|${verse}`);
  return v ? formatVerse(v, 1.0, 'direct') : null;
}

function lookupRange(book, chapter, verseStart, verseEnd) {
  const results = [];
  for (let vs = verseStart; vs <= verseEnd; vs++) {
    const v = directLookup(book, chapter, vs);
    if (v) results.push(v);
  }
  return results;
}

// KJV markup → display text. {supplied words} are part of the verse — unwrap
// them; {notes with a colon} ("{banqueting...: Heb. house of wine}") and
// [section headings] ("[A Psalm of David.]") are translator apparatus that
// should never reach the projector or the operator panel.
function displayText(s) {
  if (!s) return s;
  return s
    .replace(/\{([^}:]*)\}/g, '$1')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ').trim();
}

function formatVerse(v, similarity, method) {
  return {
    reference: v.reference, text: displayText(v.kjv_text), nlt_text: displayText(v.nlt_text),
    book: v.book, chapter: v.chapter, verse: v.verse, similarity, method,
  };
}

// ── Text search ───────────────────────────────────────────────────────────
// Reuses the verseNormText/verseNormNlt maps built once in init() instead of
// re-lowercasing all ~31k verses' kjv_text/nlt_text on every call.
function textSearch(query, limit = 8) {
  const q = norm(query);
  const results = [];
  for (let i = 0; i < verseMetadata.length; i++) {
    const kjvN = verseNormText.get(i);
    const nltN = verseNormNlt.get(i);
    if ((kjvN && kjvN.includes(q)) || (nltN && nltN.includes(q))) {
      results.push(formatVerse(verseMetadata[i], 0.9, 'text'));
      if (results.length >= limit) break;
    }
  }
  return results;
}

// ── N-gram helpers ────────────────────────────────────────────────────────
// Build a Set of every consecutive N-word sequence in a word array.
function buildNgramSet(words, n) {
  const s = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    s.add(words.slice(i, i + n).join(' '));
  }
  return s;
}

// What fraction of a verse's 4-grams appear anywhere in the transcript?
// This handles paraphrasing and STT insertion errors gracefully:
//   Transcript: "data that we planted in the house of the lord they shall flourish"
//   Verse:      "those that be planted in the house of the lord shall flourish…"
//   4-grams "planted in the house", "in the house of", "the house of the lord",
//   "shall flourish in the", "flourish in the courts"… all still match exactly.
function ngramCoverage(tNgramSet, verseWords, n) {
  const total = verseWords.length - n + 1;
  if (total <= 0) return 0;
  let matched = 0;
  for (let i = 0; i < total; i++) {
    if (tNgramSet.has(verseWords.slice(i, i + n).join(' '))) matched++;
  }
  return matched / total;
}

// ── IDF-weighted verse coverage ────────────────────────────────────────────
// Raw word-count coverage ("9 of this verse's 10 words showed up") treats
// every word as equally important — so a preacher dropping "For" off the
// front of a quote costs exactly as much confidence as dropping the one
// genuinely distinctive word in the verse would. That's backwards: the
// Bible is fixed text and no two verses share the same wording, so what
// actually identifies a verse is its RARE words, not its common ones — STT
// mishearing "for"/"and"/"the" (constant background noise across every
// accent and every engine) shouldn't move confidence much; losing the one
// word that makes this verse distinguishable from every other verse should.
// idfMap (built in init(), same IDF used by the fingerprint layer) already
// scores exactly that per word, so this reuses it instead of counting words.
function idfWeightedSpan(rawWords, start, len) {
  let sum = 0;
  for (let i = start; i < start + len; i++) sum += idfMap.get(rawWords[i]) || 0;
  return sum;
}
function idfTotal(rawWords) {
  let sum = 0;
  for (const w of rawWords) sum += idfMap.get(w) || 0;
  return sum || 1; // guards divide-by-zero on the (essentially nonexistent) all-stopword verse
}

// How much matched IDF weight counts as "plenty of evidence" on its own —
// roughly one strongly distinctive word ("meditate" ≈ 7.6, "fulness" ≈ 6.5)
// plus a bit of surrounding structure. This replaces raw phrase-length as
// the "how much did we actually hear" term: a 9-word match that captured
// 18 points of IDF weight (a rare word plus its neighbors) is much stronger
// evidence than a coincidental 9-word run of all-common words would be, so
// scoring by matched-word-COUNT was the wrong signal even before coverage
// came into it. Once matched weight clears this bar, length stops being the
// limiting factor and idfCoverage (how much of the VERSE's identity was
// captured, not just how many words) takes over as the deciding number.
const IDF_FULL_CONFIDENCE = 8;

// Gate for the anchor-trie's own "confirmed" auto-send (see the alignment
// loop below) — kept separate from IDF_FULL_CONFIDENCE above, which also
// sets the denominator for verbatimSearch's score curve.
const ANCHOR_CONFIRM_IDF = 12;

// ── Verbatim search (inverted index + phrase window) ──────────────────────
function verbatimSearch(transcript, minWords = 6, limit = 3) {
  const tNorm  = norm(transcript);
  const tWords = tNorm.split(' ').filter(Boolean);
  if (tWords.length < minWords) return [];

  // Stemmed transcript words — matched against verseStemText/verseStemNlt
  // below instead of the raw verse text, so a spoken tense/inflection that
  // differs from the KJV's own wording ("keeping" vs "kept") still lines up.
  // Word count is unaffected by stemming, so every length/coverage
  // calculation downstream stays correct either way.
  const tWordsStemmed = tWords.map(healWord);

  // Overlapping phrase windows, longest first
  const phrases = [];
  for (let len = Math.min(12, tWordsStemmed.length); len >= minWords; len--) {
    for (let i = 0; i <= tWordsStemmed.length - len; i++) {
      phrases.push(tWordsStemmed.slice(i, i + len).join(' '));
    }
  }

  // Candidate verses via inverted index.
  // Try both raw and healed (stemmed) form of each word so paraphrases like
  // "loved" → "love" still retrieve the same candidates as the trie layer.
  const queryWords = [...new Set(tWords)].filter(w => w.length >= 3);
  const counts = new Map();
  for (const w of queryWords) {
    const healed = healWord(w);
    const seen = new Set();
    for (const idx of (verbatimIndex.get(w) || [])) {
      seen.add(idx);
      counts.set(idx, (counts.get(idx) || 0) + 1);
    }
    if (healed !== w) {
      for (const idx of (stemIndex.get(healed) || [])) {
        if (!seen.has(idx)) counts.set(idx, (counts.get(idx) || 0) + 1);
      }
    }
  }

  const threshold  = Math.max(2, Math.floor(queryWords.length * 0.4));
  // topK instead of a full sort — with a long transcript the counts map spans
  // a large slice of the index, and sorting it per clause dominated the search.
  const qualifying = [];
  for (const entry of counts.entries()) {
    if (entry[1] >= threshold) qualifying.push(entry);
  }
  const candidates = topK(qualifying, 300, (a, b) => b[1] - a[1]).map(([idx]) => idx);

  const results = [];
  const seen    = new Set();
  for (const idx of candidates) {
    if (seen.has(idx)) continue;
    const kjvS = verseStemText.get(idx);
    const nltS = verseStemNlt.get(idx) || '';
    // Verses longer than the 12-word window cap are handled entirely by the
    // long-verse pass below, which searches windows up to the verse's real
    // length — letting this pass claim them first at a capped, worse score
    // (transcript-side windows can't exceed 12 words) would block that
    // better pass from ever getting a turn on the same candidate.
    if (verseStemWords.get(idx).length > 12) continue;
    const v         = verseMetadata[idx];
    const rawKjv    = verseNormWords.get(idx);   // same length/order as kjvS's words — for IDF lookup
    const rawNlt    = nltS ? verseNormNltWords.get(idx) : null;
    for (const phrase of phrases) {
      let charIdx = kjvS.indexOf(phrase);
      let sourceText = kjvS, sourceRaw = rawKjv;
      if (charIdx === -1 && nltS) {
        charIdx = nltS.indexOf(phrase);
        sourceText = nltS; sourceRaw = rawNlt;
      }
      if (charIdx === -1) continue;

      const phraseLenWords = phrase.split(' ').length;
      const wordStart = charIdx === 0 ? 0 : sourceText.slice(0, charIdx).split(' ').filter(Boolean).length;

      // IDF-weighted coverage: what fraction of the verse's IDENTIFYING
      // content did we actually match, not just what fraction of its raw
      // word count. Missing "for"/"and" barely moves this (near-zero IDF);
      // missing the verse's one distinctive word does — see the comment on
      // idfWeightedSpan/idfTotal above for why that's the right lens here.
      const matchedIdf     = idfWeightedSpan(sourceRaw, wordStart, phraseLenWords);
      const coverageRatio  = Math.min(1, matchedIdf / idfTotal(sourceRaw));
      const lengthScore    = Math.min(1, matchedIdf / IDF_FULL_CONFIDENCE);
      const rawScore       = 0.75 + lengthScore * 0.24;
      const score          = Math.min(0.99, rawScore * Math.sqrt(coverageRatio));

      // matchedIdf carried alongside the coverage-diluted score — see
      // server.js's use of it (VERBATIM_CERTAIN_IDF) for why raw sequential
      // evidence strength matters independently of how much of the verse
      // was captured.
      results.push({ ...formatVerse(v, score, 'verbatim'), matchedIdf });
      seen.add(idx);
      break;
    }
    if (results.length >= limit) break;
  }

  // ── Long-verse full-coverage pass ────────────────────────────────────────
  // The exact-phrase pass above only ever tests TRANSCRIPT-side windows up to
  // 12 words — fine when the verse itself is ≤12 words (the window can cover
  // it entirely), but most KJV verses run well past that (20-30+ words is
  // common). A preacher reading one of those verses word-for-word could never
  // score as "fully covered" there: the window physically can't get long
  // enough, so coverageRatio gets stuck at max ~12/verseLen even for a
  // complete, exact reading (e.g. a full 31-word verse read verbatim capped
  // out around 0.5-0.6 under the old scoring — nowhere near reflecting that
  // it was an exact quote).
  //
  // This pass flips direction for whatever the fast pass above missed: it
  // tests windows of the VERSE's OWN text (bounded by the verse's real
  // length, not an arbitrary cap) against the full transcript, so a genuinely
  // complete verbatim reading scores on its true coverage. Only runs for
  // long-verse candidates the fast pass didn't already resolve, so the common
  // (short-verse) case pays none of this extra cost.
  if (results.length < limit) {
    const tStemmedText   = tWordsStemmed.join(' ');
    const LONG_VERSE_SCAN_MAX = 45;   // bound the search span for pathologically long verses (a few KJV verses run to 80-90 words) while covering the common 15-45 word range in full

    for (const idx of candidates) {
      if (seen.has(idx)) continue;
      const verseWordsArr = verseStemWords.get(idx);
      if (verseWordsArr.length <= 12) continue;   // fast pass above already covers these fully
      const nltWordsArr = verseStemNltWords.get(idx) || [];
      const searchStart = Math.min(verseWordsArr.length, LONG_VERSE_SCAN_MAX);
      const rawKjv = verseNormWords.get(idx);   // same length/order as verseWordsArr — for IDF lookup
      const rawNlt = nltWordsArr.length ? verseNormNltWords.get(idx) : null;

      let matchedLen = 0, matchedStart = -1, matchedRaw = null;
      for (let len = searchStart; len >= minWords; len--) {
        let found = false;
        for (let i = 0; i <= verseWordsArr.length - len; i++) {
          if (tStemmedText.includes(verseWordsArr.slice(i, i + len).join(' '))) { found = true; matchedStart = i; matchedRaw = rawKjv; break; }
        }
        if (!found && nltWordsArr.length) {
          for (let i = 0; i <= nltWordsArr.length - len; i++) {
            if (tStemmedText.includes(nltWordsArr.slice(i, i + len).join(' '))) { found = true; matchedStart = i; matchedRaw = rawNlt; break; }
          }
        }
        if (found) { matchedLen = len; break; }
      }

      if (matchedLen) {
        const v              = verseMetadata[idx];
        // Same IDF-weighted coverage + evidence scoring as the fast pass
        // above — see the comments on idfWeightedSpan/idfTotal/
        // IDF_FULL_CONFIDENCE for why this replaced raw word-count.
        const matchedIdf     = idfWeightedSpan(matchedRaw, matchedStart, matchedLen);
        const coverageRatio  = Math.min(1, matchedIdf / idfTotal(matchedRaw));
        const lengthScore    = Math.min(1, matchedIdf / IDF_FULL_CONFIDENCE);
        const rawScore       = 0.75 + lengthScore * 0.24;
        const score          = Math.min(0.99, rawScore * Math.sqrt(coverageRatio));
        results.push({ ...formatVerse(v, score, 'verbatim'), matchedIdf });
        seen.add(idx);
      }
      if (results.length >= limit) break;
    }
  }

  // ── N-gram coverage fallback ────────────────────────────────────────────
  // For candidates that didn't match via exact phrase window, compute 4-gram
  // overlap: what percentage of the VERSE'S own 4-grams appear anywhere in
  // the transcript?  Handles:
  //   • STT word substitutions  ("data that we" ≠ "those that be" but the
  //     following grams all still land)
  //   • Paraphrasing / loose allusions ("they shall flourish in the courts
  //     of our God" ≈ Ps 92:13 even without quoting the opening)
  //   • Multi-sentence spread (rolling buffer contains multiple clauses)
  //
  // Scoring: 40% coverage → 0.65, 100% coverage → 0.82 (intentionally kept
  // below the 0.90 exact-phrase ceiling so the two tiers are distinguishable).
  if (results.length < limit) {
    const NGRAM_N        = 4;
    const NGRAM_MIN_COV  = 0.40;   // at least 40% of verse 4-grams spoken
    // Stemmed here too — same tense/inflection reasoning as the exact-phrase
    // pass above.
    const tNgramSet      = buildNgramSet(tWordsStemmed, NGRAM_N);

    for (const idx of candidates) {
      if (seen.has(idx)) continue;
      const v         = verseMetadata[idx];
      const verseWords = verseStemWords.get(idx);
      if (verseWords.length < NGRAM_N) continue;

      const cov = ngramCoverage(tNgramSet, verseWords, NGRAM_N);
      if (cov >= NGRAM_MIN_COV) {
        // Scale 0.40–1.0 → 0.65–0.82
        const score = Math.min(0.82, 0.65 + (cov - NGRAM_MIN_COV) / 0.60 * 0.17);
        results.push(formatVerse(v, score, 'verbatim'));
        seen.add(idx);
      }
      if (results.length >= limit) break;
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}

// ── Fingerprint search (verse signature coverage matching) ────────────────
// Each verse has a pre-computed fingerprint: its top SIGNATURE_SIZE words
// ranked by IDF (most distinctive first). Scores are computed entirely from
// the Bible data — nothing hardcoded.
//
// At query time:
//   1. Extract content words from speech (length ≥ 4, not in STOP_WORDS)
//   2. For each speech word, check if it appears in a verse's signature
//   3. Coverage score = matched signature IDF / total signature IDF
//      → a verse where 3 of its 5 signature words were spoken (60%) beats
//        one where 3 of its 20 words appeared (15%)
//   4. Apply the same confidence routing used before
//
// Example: "you must meditate in day and night"
//   → content words: ["meditate", "night"] (after stop-word filter)
//   → "meditate" is a signature word of Joshua 1:8 and Psalm 1:2
//   → "night" is also in both signatures
//   → coverage for both is high → medium confidence → both shown
//
// Returns { results, confidence: 'high' | 'medium' | 'low' | 'none' }
// contextHint: { citations: [{book, chapter, verse, age}] }
//   citations = last 8 explicitly cited verses, most recent first, within 5 min.
//
// Boost logic — tie-breaker only, word match always primary:
//   A scored verse gets a boost if it is a *neighbor* of any recent citation
//   (same book+chapter, verse within ±5) or an exact match of a citation.
//
//   boostFactor = 1 + (0.15 × recencyFactor)   → max 1.15×
//   recencyFactor decays linearly: 1.0 at 0s → 0.0 at 5 min
//
// A verse with zero word matches never gets promoted — boost only amplifies
// an existing score. This preserves the 87%+ word-match precision.
// Accumulate matched signature IDF per spoken word. A verse only scores when
// the spoken word (raw OR stemmed) is one of its distinctive signature words.
// Both the raw and the healed form are tried so a spoken inflection bridges to
// the base form a verse stores ("flourishing" → "flourish"), but each spoken
// word scores a given verse AT MOST ONCE — the per-word `seen` guard is what
// stops the heaven/heavens-style double counting. Fingerprint stays keyed on
// literal signature words (not a stem index): widening retrieval to every
// morphological variant dilutes distinctive-word precision (e.g. "renewing" +
// "eagles" would tie Isaiah 40:31 with Psalm 103:5). `restrict`, when given,
// scopes scoring to a verse-index Set (the topic library).
function accumulateFingerprint(speechWords, restrict = null) {
  const matchedWeight    = new Map();
  const matchedWordCount = new Map();
  for (const w of speechWords) {
    const healed  = healWord(w);
    const lookups = healed !== w ? [w, healed] : [w];
    const seen    = new Set();
    for (const lw of lookups) {
      for (const idx of (verbatimIndex.get(lw) || [])) {
        if (restrict && !restrict.has(idx)) continue;
        if (seen.has(idx)) continue;            // already scored for this spoken word
        const sig = verseSignatures.get(idx);
        if (!sig) continue;
        const idf = sig.get(lw) ?? sig.get(w);
        if (idf !== undefined) {
          seen.add(idx);
          matchedWeight.set(idx, (matchedWeight.get(idx) || 0) + idf);
          matchedWordCount.set(idx, (matchedWordCount.get(idx) || 0) + 1);
        }
      }
    }
  }
  return { matchedWeight, matchedWordCount };
}

// Shared scoring + confidence routing for both the full and library fingerprint
// searches, so they can never diverge. The context boost is applied AFTER the
// coverage threshold filter, so it only reorders already-qualified verses and
// can never pull a sub-threshold verse into the result set.
function scoreFingerprint(matchedWeight, matchedWordCount, contextHint, limit, fromLibrary = false) {
  // Coverage = matched signature weight / total signature weight.
  // Threshold: at least 35% of the verse's fingerprint must be covered,
  // AND at least 2 distinct signature words must match (prevents single-word
  // false positives on short verses like "thy years shall have no end").
  const COVERAGE_THRESHOLD = 0.35;
  const MIN_WORD_HITS      = 2;
  // A relative floor alone lets a short, low-information verse hit ~100%
  // coverage from generic vocabulary alone — e.g. Psalms 56:10 ("praise
  // his word... praise his word") has a total signature weight of just
  // ~9.8, so ANY "praise...word...LORD"-flavored filler phrase (constant
  // in charismatic preaching, not a citation) covers nearly all of it and
  // scores as if it were a confident match. Same fix as verbatim's
  // VERBATIM_CERTAIN_IDF / the anchor trie's ANCHOR_CONFIRM_IDF: require
  // real absolute evidence, not just "covered most of a small target."
  const MIN_ABS_WEIGHT = 15;

  const coverage = new Map();
  for (const [idx, matched] of matchedWeight) {
    const cov = matched / (verseSignatureWeight.get(idx) || 1);
    if (cov >= COVERAGE_THRESHOLD && (matchedWordCount.get(idx) || 0) >= MIN_WORD_HITS
        && matched >= MIN_ABS_WEIGHT) {
      coverage.set(idx, cov);
    }
  }
  if (!coverage.size) return { results: [], confidence: 'none' };

  // ── Context boost (tie-breaker only, qualified verses only) ───────────
  applyContextBoost(coverage, contextHint, verseMetadata);

  const scored = topK([...coverage.entries()], limit + 1, (a, b) => b[1] - a[1]);

  const topCoverage    = scored[0][1];
  const secondCoverage = scored.length > 1 ? scored[1][1] : 0;
  const tied           = scored.filter(([, c]) => c >= topCoverage * 0.9);

  // 'high' used to mean only "no real competitor" — a verse that barely
  // cleared COVERAGE_THRESHOLD (0.35) with nobody else in the running scored
  // exactly the same 'high' as a verse at 95% coverage, and server.js sends
  // any 'high' straight to the live screen regardless of the raw similarity.
  // That let low-evidence coincidental word overlap ("wrong verse suggested")
  // auto-broadcast just because no second candidate happened to tie it.
  // 'high' now ALSO requires the absolute coverage to be real, not just
  // uncontested; an isolated-but-weak match degrades to medium/low instead of
  // getting the same trust as a genuinely strong one.
  const HIGH_ABS_MIN   = 0.55;
  const MEDIUM_ABS_MIN = 0.42;
  let confidence;
  if (tied.length === 1 || secondCoverage === 0) {
    confidence = topCoverage >= HIGH_ABS_MIN ? 'high' : (topCoverage >= MEDIUM_ABS_MIN ? 'medium' : 'low');
  } else if (tied.length <= 3 && topCoverage / secondCoverage >= 1.4) {
    confidence = topCoverage >= HIGH_ABS_MIN ? 'high' : 'medium';
  } else if (tied.length <= 3) {
    confidence = 'medium';
  } else if (tied.length <= 5) {
    confidence = 'low';
  } else {
    confidence = 'none';
  }

  if (confidence === 'none') return { results: [], confidence: 'none' };

  const results = tied.slice(0, limit).map(([idx, cov]) => ({
    ...formatVerse(verseMetadata[idx], Math.min(0.97, cov), 'fingerprint'),
  }));
  const out = { results, confidence };
  if (fromLibrary) out.fromLibrary = true;
  return out;
}

function fingerprintSearch(transcript, limit = 5, contextHint = null) {
  const speechWords = [...new Set(
    norm(transcript).split(' ')
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  )];
  if (speechWords.length < 1) return { results: [], confidence: 'none' };

  const { matchedWeight, matchedWordCount } = accumulateFingerprint(speechWords);
  if (!matchedWeight.size) return { results: [], confidence: 'none' };

  return scoreFingerprint(matchedWeight, matchedWordCount, contextHint, limit);
}

// ── Topic Library ─────────────────────────────────────────────────────────
// Built from recurring high-IDF words extracted from speech over the first
// 2-5 minutes of the sermon. Stores the top 80 verse indices most relevant
// to the current topic — pre-ranked, cached, ready.
//
// When the preacher has been talking about "forgiveness, mercy, cleanse, restore"
// for 3 minutes, this library contains the ~60-80 verses that live at the
// intersection of those themes. Every subsequent fingerprint search checks
// this library first — searching 80 verses instead of 31,000.
//
// The library rebuilds every 60s as topic words accumulate, so it sharpens
// over time rather than locking in early. Falls back to full index if no
// library match is found.

let topicLibrary      = null;   // Set<idx> of pre-ranked verse indices
let topicLibraryWords = [];     // the topic words that built this library

const TOPIC_LIBRARY_SIZE = 80;

function buildTopicLibrary(topicWords) {
  if (!topicWords || topicWords.length < 2) {
    topicLibrary      = null;
    topicLibraryWords = [];
    return { size: 0 };
  }

  // Score every verse by how many topic words appear in its signature
  // (same mechanism as fingerprintSearch but across the full index)
  const scores = new Map();
  for (const w of topicWords) {
    const idf = idfMap.get(w);
    if (!idf || idf < 1.5) continue;
    for (const idx of (verbatimIndex.get(w) || [])) {
      const sig = verseSignatures.get(idx);
      if (!sig || !sig.has(w)) continue;
      scores.set(idx, (scores.get(idx) || 0) + idf);
    }
  }

  if (!scores.size) {
    topicLibrary      = null;
    topicLibraryWords = topicWords;
    return { size: 0 };
  }

  // Keep the top TOPIC_LIBRARY_SIZE by raw score — these are the verses
  // most relevant to the topic. Coverage normalization happens at query time.
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPIC_LIBRARY_SIZE)
    .map(([idx]) => idx);

  topicLibrary      = new Set(ranked);
  topicLibraryWords = topicWords;

  console.log(`[DetectionWorker] Topic library built: ${topicLibrary.size} verses for [${topicWords.slice(0, 5).join(', ')}${topicWords.length > 5 ? '...' : ''}]`);
  return { size: topicLibrary.size, words: topicWords };
}

// Fingerprint search scoped to the topic library.
// Same scoring as full fingerprintSearch but only iterates library candidates.
// Called first — if it returns a high/medium result, skip the full search.
function fingerprintSearchInLibrary(transcript, limit = 5, contextHint = null) {
  if (!topicLibrary || !topicLibrary.size) return { results: [], confidence: 'none' };

  const speechWords = [...new Set(
    norm(transcript).split(' ')
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  )];
  if (!speechWords.length) return { results: [], confidence: 'none' };

  // Identical accumulation + scoring to the full search (raw + stem candidates,
  // deduped), scoped to the topic library. Sharing the code keeps the fast path
  // and the full path from ever returning different answers for the same input.
  const { matchedWeight, matchedWordCount } = accumulateFingerprint(speechWords, topicLibrary);
  if (!matchedWeight.size) return { results: [], confidence: 'none' };

  return scoreFingerprint(matchedWeight, matchedWordCount, contextHint, limit, true);
}

// ── Semantic search (meaning, not words) ───────────────────────────────────
// Thin wrapper: delegates the actual embedding + nearest-neighbor work to
// semantic_engine.js and maps its {idx, score} results onto the same verse
// object shape every other search layer returns (formatVerse).
async function semanticSearch(transcript, limit = 5) {
  if (!semanticEngine.isReady()) return [];
  const hits = await semanticEngine.search(transcript, limit);
  return hits.map(({ idx, score }) => formatVerse(verseMetadata[idx], score, 'semantic'));
}

// ── Message handler ───────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'directLookup': {
        const result = directLookup(msg.book, msg.chapter, msg.verse);
        parentPort.postMessage({ type: 'directResult', id: msg.id, result });
        break;
      }
      case 'rangeLookup': {
        const results = lookupRange(msg.book, msg.chapter, msg.verseStart, msg.verseEnd);
        parentPort.postMessage({ type: 'rangeResult', id: msg.id, results });
        break;
      }
      case 'chapterLookup': {
        // Return all verses in a chapter (up to 200)
        const results = [];
        for (let vs = 1; vs <= 200; vs++) {
          const v = directLookup(msg.book, msg.chapter, vs);
          if (!v) break;
          results.push(v);
        }
        parentPort.postMessage({ type: 'rangeResult', id: msg.id, results });
        break;
      }
      case 'textSearch': {
        const results = textSearch(msg.query, msg.limit || 8);
        parentPort.postMessage({ type: 'textResults', id: msg.id, results });
        break;
      }
      case 'verbatimSearch': {
        const results = verbatimSearch(msg.text, msg.minWords || 6, msg.limit || 3);
        parentPort.postMessage({ type: 'verbatimResults', id: msg.id, results });
        break;
      }
      case 'fingerprintSearch': {
        // Try topic library first — if high/medium confidence, use it directly.
        // Library search is ~50× faster and topically pre-filtered.
        const libResult = fingerprintSearchInLibrary(msg.text, msg.limit || 5, msg.contextHint || null);
        if (libResult.results.length && libResult.confidence !== 'none' &&
            (libResult.confidence === 'high' || libResult.confidence === 'medium')) {
          parentPort.postMessage({ type: 'fingerprintResults', id: msg.id, ...libResult });
          break;
        }
        // Fall back to full index search
        const fullResult = fingerprintSearch(msg.text, msg.limit || 5, msg.contextHint || null);
        // Merge: if library had low-confidence results, include them alongside full results
        let merged;
        if (libResult.results.length) {
          const seen = new Set();
          const deduped = [];
          for (const r of [...fullResult.results, ...libResult.results]) {
            const key = `${r.book}|${r.chapter}|${r.verse}`;
            if (!seen.has(key)) { seen.add(key); deduped.push(r); }
          }
          merged = { ...fullResult, results: deduped.slice(0, msg.limit || 5) };
        } else {
          merged = fullResult;
        }
        parentPort.postMessage({ type: 'fingerprintResults', id: msg.id, ...merged });
        break;
      }
      // Batch variants — accept multiple texts, return the single best result.
      // Server sends all clauses in one call instead of N sequential calls,
      // eliminating N-1 round-trip latencies in continuous speech.
      case 'verbatimSearchBatch': {
        let best = null;
        for (const text of (msg.texts || [])) {
          const results = verbatimSearch(text, msg.minWords || 6, msg.limit || 3);
          if (!results.length) continue;
          if (!best || results[0].similarity > best[0].similarity) best = results;
          // Stop at the server's viewer bar (0.92) — the old 0.98 cutoff was
          // effectively unreachable given the score cap, so every clause was
          // always searched even after a hit strong enough to route on-air.
          if (best[0].similarity >= 0.92) break;
        }
        parentPort.postMessage({ type: 'verbatimResults', id: msg.id, results: best || [] });
        break;
      }
      case 'fingerprintSearchBatch': {
        // Try topic library across all clauses first
        let best = { results: [], confidence: 'none' };
        const rank = c => c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
        for (const text of (msg.texts || [])) {
          const r = fingerprintSearchInLibrary(text, msg.limit || 5, msg.contextHint || null);
          if (rank(r.confidence) > rank(best.confidence)) best = r;
          if (best.confidence === 'high') break;
        }
        // Fall back to full index if library didn't return high/medium
        if (rank(best.confidence) < 2) {
          for (const text of (msg.texts || [])) {
            const r = fingerprintSearch(text, msg.limit || 5, msg.contextHint || null);
            if (rank(r.confidence) > rank(best.confidence)) best = r;
            if (best.confidence === 'high') break;
          }
        }
        parentPort.postMessage({ type: 'fingerprintResults', id: msg.id, ...best });
        break;
      }
      case 'buildTopicLibrary': {
        const result = buildTopicLibrary(msg.topicWords);
        parentPort.postMessage({ type: 'topicLibraryReady', id: msg.id, ...result });
        break;
      }
      case 'getIdfScores': {
        const words = (msg.words || []).map(w => [w, idfMap.get(w) || 0]);
        parentPort.postMessage({ type: 'idfScores', id: msg.id, words });
        break;
      }
      case 'streamText': {
        // Word-by-word streaming into the anchor trie + alignment candidates.
        // No buffering, no throttle — every word is processed the instant it arrives.
        const words = String(msg.text || '').toLowerCase().split(/\s+/).filter(Boolean);
        const anchorsByVerse   = new Map();   // idx → { depth, df, idf }
        const confirmedByVerse = new Map();   // idx → { matched, matchedIdf }

        for (const w of words) {
          const { anchors, confirmed } = streamWord(w);
          for (const a of anchors) {
            const prev = anchorsByVerse.get(a.verseIdx);
            // Keep the most distinctive (lowest df) anchor seen for this verse
            if (!prev || a.df < prev.df || (a.df === prev.df && a.depth > prev.depth)) {
              anchorsByVerse.set(a.verseIdx, { depth: a.depth, df: a.df, idf: a.idf });
            }
          }
          for (const c of confirmed) {
            const prev = confirmedByVerse.get(c.verseIdx);
            if (!prev || c.matched > prev.matched) {
              // viaBackwardExtension: if a LATER, higher-matched confirmation
              // for the same verse within this same call didn't need
              // backward extension, prefer that — it's strictly stronger
              // evidence (see streamWord's own comment on what this flag
              // means) than an earlier one that did.
              confirmedByVerse.set(c.verseIdx, { matched: c.matched, matchedIdf: c.matchedIdf, viaBackwardExtension: c.viaBackwardExtension });
            }
          }
        }

        // Score formula:
        //   Confirmed: 0.90 at 6 words aligned → 0.97 at 13+
        //   Anchor:    df=1 → 0.85 (unique), df=2 → 0.80, df=3 → 0.76, df=4 → 0.72, df=5 → 0.68.
        //   With SUGGESTION_MIN_SCORE=0.75 on the server, df=4+ anchors self-drop unless a
        //   higher-layer signal boosts them (topic library, recent citation proximity).
        const anchorSimilarity = df => {
          if (df <= 1) return 0.85;
          if (df === 2) return 0.80;
          if (df === 3) return 0.76;
          if (df === 4) return 0.72;
          return 0.68;
        };

        const results = [];
        const seen = new Set();
        for (const [idx, { matched, matchedIdf, viaBackwardExtension }] of confirmedByVerse) {
          const similarity = Math.min(0.97, 0.90 + (matched - ALIGN_CONFIRM_AT) * 0.01);
          results.push({
            ...formatVerse(verseMetadata[idx], similarity, 'stream'),
            depth: matched,
            matched,
            matchedIdf,
            df: 0,
            confirmed: true,
            viaBackwardExtension: !!viaBackwardExtension,
            inTopicLibrary: !!(topicLibrary && topicLibrary.has(idx)),
          });
          seen.add(idx);
        }
        for (const [idx, { depth, df, idf }] of anchorsByVerse) {
          if (seen.has(idx)) continue;
          results.push({
            ...formatVerse(verseMetadata[idx], anchorSimilarity(df), 'stream'),
            depth,
            matched: depth,
            df,
            idf,
            confirmed: false,
            inTopicLibrary: !!(topicLibrary && topicLibrary.has(idx)),
          });
        }

        parentPort.postMessage({ type: 'streamResult', id: msg.id, results });
        break;
      }
      case 'streamReset': {
        streamReset();
        parentPort.postMessage({ type: 'streamResetAck', id: msg.id });
        break;
      }
      case 'semanticSearch': {
        const results = await semanticSearch(msg.text, msg.limit || 5);
        parentPort.postMessage({ type: 'semanticResults', id: msg.id, results });
        break;
      }
      // Sent by server.js right after /api/semantic-model/install finishes —
      // that route runs in the MAIN process, which never loads
      // semantic_engine.js at all (only this worker does), so it can't just
      // call ensureLoaded() itself. retryLoaded() also clears out a cached
      // REJECTED load promise from server boot (before anything was
      // installed), which a plain ensureLoaded() would otherwise keep
      // replaying forever.
      //
      // Posts exactly ONE id-correlated message either way — 'reloadSemanticAck'
      // is what settles server.js's workerCall(). It used to ALSO post an
      // 'error' message with the same id on failure; server.js's generic
      // handler resolves (never rejects) on the first message matching an
      // id, so that 'error' message — arriving first and carrying no `ok`
      // field — settled the call, and the real ack landed on nothing,
      // making the install route log success even when the reload failed.
      case 'reloadSemantic': {
        try {
          await semanticEngine.retryLoaded();
          parentPort.postMessage({ type: 'semanticReady' });
          parentPort.postMessage({ type: 'reloadSemanticAck', id: msg.id, ok: semanticEngine.isReady() });
        } catch (err) {
          parentPort.postMessage({ type: 'reloadSemanticAck', id: msg.id, ok: false, error: err.message });
        }
        break;
      }
      case 'ping':
        parentPort.postMessage({ type: 'pong', ready: true });
        break;
    }
  } catch (err) {
    console.error('[DetectionWorker] Error:', err.message);
    parentPort.postMessage({ type: 'error', id: msg.id, error: err.message });
  }
});

init().catch(err => {
  console.error('[DetectionWorker] Init failed:', err.message);
  parentPort.postMessage({ type: 'initError', error: err.message });
});
