// KAIRO — Bible Reference Parser
// Extracted from KAIRO v1 main.js. Handles spoken reference parsing with
// Deepgram STT healing, fuzzy book matching, and verse range detection.
'use strict';

const WORD_TO_NUM = {
  'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,
  'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
  'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
  'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
  'twenty-one':21,'twenty-two':22,'twenty-three':23,'twenty-four':24,
  'twenty-five':25,'twenty-six':26,'twenty-seven':27,'twenty-eight':28,
  'twenty-nine':29,'thirty':30,'thirty-one':31,'thirty-two':32,
  'thirty-three':33,'thirty-four':34,'thirty-five':35,'thirty-six':36,
  'thirty-seven':37,'thirty-eight':38,'thirty-nine':39,'forty':40,
  'forty-one':41,'forty-two':42,'forty-three':43,'forty-four':44,
  'forty-five':45,'forty-six':46,'forty-seven':47,'forty-eight':48,
  'forty-nine':49,'fifty':50,'fifty-one':51,'fifty-two':52,'fifty-three':53,
  'fifty-four':54,'fifty-five':55,'fifty-six':56,'fifty-seven':57,
  'fifty-eight':58,'fifty-nine':59,'sixty':60,'sixty-one':61,'sixty-two':62,
  'sixty-three':63,'sixty-four':64,'sixty-five':65,'sixty-six':66,
  'sixty-seven':67,'sixty-eight':68,'sixty-nine':69,'seventy':70,
  'seventy-one':71,'seventy-two':72,'seventy-three':73,'seventy-four':74,
  'seventy-five':75,'seventy-six':76,'seventy-seven':77,'seventy-eight':78,
  'seventy-nine':79,'eighty':80,'eighty-one':81,'eighty-two':82,
  'eighty-three':83,'eighty-four':84,'eighty-five':85,'eighty-six':86,
  'eighty-seven':87,'eighty-eight':88,'eighty-nine':89,'ninety':90,
  'ninety-one':91,'ninety-two':92,'ninety-three':93,'ninety-four':94,
  'ninety-five':95,'ninety-six':96,'ninety-seven':97,'ninety-eight':98,
  'ninety-nine':99,'hundred':100,'one hundred':100,
  // Digit-by-digit zero: "Psalm one oh eight" = 108. Only meaningful inside
  // the 3-digit composition below — a bare "oh" resolving to 0 never produces
  // a valid chapter/verse, so it can't create phantom references.
  'oh':0,
  'first':1,'second':2,'third':3,'fourth':4,'fifth':5,
  // Deepgram STT artifacts — common mishearings for number words in biblical context
  'for':4,   // "four" → "for"  (e.g. "john for verse one")
  'won':1,   // "one"  → "won"  (e.g. "chapter won verse five")
  'too':2,   // "two"  → "too"  (e.g. "verse too")
  'ate':8,   // "eight"→ "ate"  (e.g. "verse ate")
};

function spokenToNumber(word) {
  if (!word) return null;
  const w = word.toLowerCase().trim();
  if (/^\d+$/.test(w)) return parseInt(w);
  if (WORD_TO_NUM[w] !== undefined) return WORD_TO_NUM[w];
  const parts = w.split(/\s+/);
  if (parts.length === 2) {
    const a = WORD_TO_NUM[parts[0]], b = WORD_TO_NUM[parts[1]];
    if (a !== undefined && b !== undefined) {
      if (a >= 20 && b >= 1 && b <= 19) return a + b;
      if (a >= 1 && a <= 9 && b >= 10 && b <= 99) return a * 100 + b;
    }
  }
  if (parts.length === 3) {
    const a = WORD_TO_NUM[parts[0]], b = WORD_TO_NUM[parts[1]], c = WORD_TO_NUM[parts[2]];
    if (a !== undefined && b !== undefined && c !== undefined &&
        a >= 0 && a <= 9 && b >= 0 && b <= 9 && c >= 0 && c <= 9) {
      return a * 100 + b * 10 + c;
    }
  }
  return null;
}

function consumeNumber(words, idx, maxValue = Infinity) {
  if (idx >= words.length) return null;

  // Hundreds composition: "<1-9> hundred [and] [<sub-hundred>]".
  // Handles "one hundred seventy six" (176), "one hundred nineteen" (119),
  // "one hundred and five" (105) — common in Psalm 119 verse callouts, which
  // the digit-by-digit paths below can't compose.
  // Also bare "hundred [and] N" and "a hundred [and] N" — many preachers drop
  // the leading "one": "Psalm hundred and eight" = Psalm 108.
  const lead = spokenToNumber(words[idx]);
  const bareHundred = words[idx] === 'hundred' ||
                      (words[idx] === 'a' && words[idx + 1] === 'hundred');
  if (bareHundred || (lead !== null && lead >= 1 && lead <= 9 && words[idx + 1] === 'hundred')) {
    let value    = bareHundred ? 100 : lead * 100;
    let consumed = (bareHundred && words[idx] === 'hundred') ? 1 : 2;
    let j = idx + consumed;
    if (words[j] === 'and') { j++; consumed++; }
    const rest = consumeNumber(words, j, 99);
    if (rest && rest.value >= 1 && rest.value <= 99) {
      value += rest.value;
      consumed += rest.consumed;
    }
    if (value <= maxValue) return { value, consumed };
    // else fall through — caller may reinterpret an over-max value
  }

  if (idx + 2 < words.length) { const n = spokenToNumber(words.slice(idx,idx+3).join(' ')); if (n !== null && n <= maxValue) return { value: n, consumed: 3 }; }
  if (idx + 1 < words.length) { const n = spokenToNumber(words.slice(idx,idx+2).join(' ')); if (n !== null && n <= maxValue) return { value: n, consumed: 2 }; }
  const n = spokenToNumber(words[idx]);
  if (n !== null) return { value: n, consumed: 1 };
  return null;
}

const BOOK_ALIASES = {
  'genesis':'Genesis','gen':'Genesis','exodus':'Exodus','leviticus':'Leviticus',
  'numbers':'Numbers','deuteronomy':'Deuteronomy','joshua':'Joshua','judges':'Judges','ruth':'Ruth',
  '1 samuel':'1 Samuel','first samuel':'1 Samuel','2 samuel':'2 Samuel','second samuel':'2 Samuel',
  '1 kings':'1 Kings','first kings':'1 Kings','2 kings':'2 Kings','second kings':'2 Kings',
  '1 chronicles':'1 Chronicles','first chronicles':'1 Chronicles',
  '2 chronicles':'2 Chronicles','second chronicles':'2 Chronicles',
  'ezra':'Ezra','nehemiah':'Nehemiah','esther':'Esther','job':'Job',
  'psalms':'Psalms','psalm':'Psalms','ps':'Psalms','psa':'Psalms','pss':'Psalms','psal':'Psalms','sal':'Psalms',
  'proverbs':'Proverbs','prov':'Proverbs','pro':'Proverbs','prv':'Proverbs',
  'ecclesiastes':'Ecclesiastes','eccl':'Ecclesiastes','ecc':'Ecclesiastes','qoh':'Ecclesiastes',
  // DB canonical name is "Song of Solomon"; the multi-word phrase is collapsed
  // to the single token "songofsolomon" during healing so it flows through the
  // single-word book machinery below.
  'songofsolomon':'Song of Solomon','sos':'Song of Solomon','ss':'Song of Solomon','cant':'Song of Solomon',
  'isaiah':'Isaiah','isa':'Isaiah',
  'jeremiah':'Jeremiah','jer':'Jeremiah',
  'lamentations':'Lamentations','lam':'Lamentations',
  'ezekiel':'Ezekiel','ezek':'Ezekiel','eze':'Ezekiel',
  'daniel':'Daniel','dan':'Daniel',
  'hosea':'Hosea','hos':'Hosea',
  'joel':'Joel','amos':'Amos',
  'obadiah':'Obadiah','obad':'Obadiah','oba':'Obadiah',
  'jonah':'Jonah','jon':'Jonah',
  'micah':'Micah','mic':'Micah',
  'nahum':'Nahum','nah':'Nahum',
  'habakkuk':'Habakkuk','hab':'Habakkuk',
  'zephaniah':'Zephaniah','zeph':'Zephaniah','zep':'Zephaniah',
  'haggai':'Haggai','hag':'Haggai',
  'zechariah':'Zechariah','zachariah':'Zechariah','zacharias':'Zechariah','zech':'Zechariah','zec':'Zechariah',
  'malachi':'Malachi','mal':'Malachi',
  'matthew':'Matthew','matt':'Matthew','mt':'Matthew',
  'mark':'Mark','mk':'Mark','mrk':'Mark',
  'luke':'Luke','lk':'Luke','luk':'Luke',
  'john':'John','jn':'John','joh':'John',
  'acts':'Acts',
  'romans':'Romans','rom':'Romans',
  '1 corinthians':'1 Corinthians','first corinthians':'1 Corinthians','1 cor':'1 Corinthians','1cor':'1 Corinthians',
  '2 corinthians':'2 Corinthians','second corinthians':'2 Corinthians','2 cor':'2 Corinthians','2cor':'2 Corinthians',
  'galatians':'Galatians','gal':'Galatians',
  'ephesians':'Ephesians','eph':'Ephesians',
  'philippians':'Philippians','phil':'Philippians','php':'Philippians',
  'colossians':'Colossians','col':'Colossians',
  '1 thessalonians':'1 Thessalonians','first thessalonians':'1 Thessalonians','1 thess':'1 Thessalonians','1thess':'1 Thessalonians','1 th':'1 Thessalonians',
  '2 thessalonians':'2 Thessalonians','second thessalonians':'2 Thessalonians','2 thess':'2 Thessalonians','2thess':'2 Thessalonians','2 th':'2 Thessalonians',
  '1 timothy':'1 Timothy','first timothy':'1 Timothy','1 tim':'1 Timothy','1tim':'1 Timothy',
  '2 timothy':'2 Timothy','second timothy':'2 Timothy','2 tim':'2 Timothy','2tim':'2 Timothy',
  'titus':'Titus','tit':'Titus',
  'philemon':'Philemon','phlm':'Philemon','phm':'Philemon',
  'hebrews':'Hebrews','heb':'Hebrews',
  'james':'James','jas':'James','jam':'James',
  '1 peter':'1 Peter','first peter':'1 Peter','1 pet':'1 Peter','1pet':'1 Peter','1 pe':'1 Peter',
  '2 peter':'2 Peter','second peter':'2 Peter','2 pet':'2 Peter','2pet':'2 Peter','2 pe':'2 Peter',
  '1 john':'1 John','first john':'1 John','1 jn':'1 John','1jn':'1 John','1 jo':'1 John',
  '2 john':'2 John','second john':'2 John','2 jn':'2 John','2jn':'2 John',
  '3 john':'3 John','third john':'3 John','3 jn':'3 John','3jn':'3 John',
  'jude':'Jude','jud':'Jude',
  'revelation':'Revelation','revelations':'Revelation','rev':'Revelation','re':'Revelation',
};

const SINGLE_WORD_BOOKS = new Set([
  // Full names
  'genesis','exodus','leviticus','numbers','deuteronomy','joshua','judges','ruth',
  'ezra','nehemiah','esther','job','psalms','psalm','proverbs','ecclesiastes',
  'isaiah','jeremiah','lamentations','ezekiel','daniel','hosea','joel','amos',
  'obadiah','jonah','micah','nahum','habakkuk','zephaniah','haggai',
  'zechariah','zachariah','zacharias','malachi',
  'matthew','mark','luke','john','acts','romans','galatians',
  'ephesians','philippians','colossians','titus','philemon','hebrews','james','jude',
  'revelation','revelations',
  // Common typed abbreviations (all lowercase — normalised before lookup)
  'gen','exod','exo','lev','num','deut','deu','josh','jos','judg','jdg',
  'ps','psa','pss','psal','sal',
  'prov','pro','prv',
  'eccl','ecc','qoh',
  'sos','ss','cant','songofsolomon',
  'isa','jer','lam',
  'ezek','eze','dan','hos','obad','oba','jon','mic','nah','hab',
  'zeph','zep','zech','zec','hag','mal',
  'matthew','mark','luke','john','acts','romans',
  'galatians','ephesians','philippians','colossians',
  'titus','philemon','hebrews','james','jude','revelation','revelations',
  'matt','mt','mk','mrk','lk','luk','jn','joh',
  'rom','gal','eph','php','col','tit','phlm','phm','heb','jas','jam','jud',
  'rev','re',
]);

const NUMBERED_BOOK_VARIANTS = {
  'corinthians':['1 Corinthians','2 Corinthians'],
  'thessalonians':['1 Thessalonians','2 Thessalonians'],
  'timothy':['1 Timothy','2 Timothy'],
  'peter':['1 Peter','2 Peter'],
  'samuel':['1 Samuel','2 Samuel'],
  'kings':['1 Kings','2 Kings'],
  'chronicles':['1 Chronicles','2 Chronicles'],
};
for (const b of Object.keys(NUMBERED_BOOK_VARIANTS)) {
  SINGLE_WORD_BOOKS.add(b);
  if (!BOOK_ALIASES[b]) BOOK_ALIASES[b] = NUMBERED_BOOK_VARIANTS[b][0];
}

const AMBIGUOUS_BOOKS = new Set([
  'numbers','ruth','mark','john','james','acts','judges','job',
  'joel','amos','micah','nahum','titus','jude','luke','hebrews',
  'esther','hosea','jonah','genesis','exodus','philemon','obadiah','haggai',
]);

const MAX_CHAPTERS = {
  'Genesis':50,'Exodus':40,'Leviticus':27,'Numbers':36,'Deuteronomy':34,
  'Joshua':24,'Judges':21,'Ruth':4,'1 Samuel':31,'2 Samuel':24,
  '1 Kings':22,'2 Kings':25,'1 Chronicles':29,'2 Chronicles':36,
  'Ezra':10,'Nehemiah':13,'Esther':10,'Job':42,'Psalms':150,
  'Proverbs':31,'Ecclesiastes':12,'Song of Solomon':8,
  'Isaiah':66,'Jeremiah':52,'Lamentations':5,'Ezekiel':48,'Daniel':12,
  'Hosea':14,'Joel':3,'Amos':9,'Obadiah':1,'Jonah':4,'Micah':7,
  'Nahum':3,'Habakkuk':3,'Zephaniah':3,'Haggai':2,'Zechariah':14,'Malachi':4,
  'Matthew':28,'Mark':16,'Luke':24,'John':21,'Acts':28,'Romans':16,
  '1 Corinthians':16,'2 Corinthians':13,'Galatians':6,'Ephesians':6,
  'Philippians':4,'Colossians':4,'1 Thessalonians':5,'2 Thessalonians':3,
  '1 Timothy':6,'2 Timothy':4,'Titus':3,'Philemon':1,'Hebrews':13,
  'James':5,'1 Peter':5,'2 Peter':3,'1 John':5,'2 John':1,'3 John':1,
  'Jude':1,'Revelation':22,
};

const PARSER_HEALING_PAIRS = [
  // Book name repairs
  ['acts of the apostles','acts'],['acts of the apostle','acts'],
  ['acts of apostles','acts'],['acts of apostle','acts'],['book of acts','acts'],
  ['zachariah','zechariah'],['zacharias','zechariah'],
  ['naha','nahum'],      // Deepgram mishear: "Nahum" → "naha"  (4-char, below fuzzy threshold)
  ['habakkak','habakkuk'],['habaka','habakkuk'],['habacuc','habakkuk'], // Habakkuk variants
  ['zephan','zephaniah'],['zephania','zephaniah'],
  ['hagga','haggai'],['hagai','haggai'],
  ['malach','malachi'],
  ['ecclesiast','ecclesiastes'],
  ['lamentations of jeremiah','lamentations'],
  ['philippine chapter','philippians chapter'],['philippine verse','philippians verse'],['philippine','philippians'],
  ['first corinthian','1 corinthians'],['second corinthian','2 corinthians'],
  ['galatian chapter','galatians chapter'],['galatian verse','galatians verse'],['galatian','galatians'],
  ['ephesian chapter','ephesians chapter'],['ephesian verse','ephesians verse'],['ephesian','ephesians'],
  ['colossian chapter','colossians chapter'],['colossian verse','colossians verse'],['colossian','colossians'],
  ['thessalonian','1 thessalonians'],
  ['profit chapter','proverbs chapter'],['profit verse','proverbs verse'],
  ['first chronic','1 chronicles'],['second chronic','2 chronicles'],
  // Song of Solomon — all spoken variants collapse to the single token
  // "songofsolomon" so it flows through the single-word book machinery.
  // Plural forms first: "songs of solomon" doesn't contain the singular
  // substring, so it needs its own pair.
  ['songs of solomon','songofsolomon'],['songs of songs','songofsolomon'],
  ['song of songs','songofsolomon'],['song of solomon','songofsolomon'],
  ['solomon songs','songofsolomon'],['solomons song','songofsolomon'],
  // Deepgram number mishearing
  ['chapter won ','chapter one '],['verse fork','verse four'],['verse tree','verse three'],
  ['verse ate','verse eight'],['chapter ate','chapter eight'],['verse sick','verse six'],
  ['chapter for verse','chapter four verse'],['chapter for ','chapter four '],
  ['chapter covenant verse','chapter seven verse'],['chapter covenant verses','chapter seven verses'],
  ['chapter heaven verse','chapter seven verse'],['chapter heaven verses','chapter seven verses'],
  // Common Deepgram STT mis-transcriptions
  ['revelation chapter','revelation chapter'],
  ['book of john','john'],['book of mark','mark'],['book of luke','luke'],
  ['book of matthew','matthew'],['book of acts','acts'],
  ['book of genesis','genesis'],['book of exodus','exodus'],
  ['book of psalms','psalms'],['book of proverbs','proverbs'],
  ['book of isaiah','isaiah'],['book of jeremiah','jeremiah'],
  ['book of ezekiel','ezekiel'],['book of daniel','daniel'],
  ['first john','1 john'],['second john','2 john'],['third john','3 john'],
  ['first peter','1 peter'],['second peter','2 peter'],
  ['first kings','1 kings'],['second kings','2 kings'],
  ['first samuel','1 samuel'],['second samuel','2 samuel'],
  ['first timothy','1 timothy'],['second timothy','2 timothy'],
  ['first thessalonians','1 thessalonians'],['second thessalonians','2 thessalonians'],
  ['first corinthians','1 corinthians'],['second corinthians','2 corinthians'],
  ['first chronicles','1 chronicles'],['second chronicles','2 chronicles'],
];

const HEALING_COMPILED = PARSER_HEALING_PAIRS.map(([find, replace]) => {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { find, replace, regex: new RegExp(escaped + '(?![a-z])', 'g') };
});

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i-1] === b[j-1] ? prev[j-1] : 1 + Math.min(prev[j], curr[j-1], prev[j-1]);
    }
    prev.splice(0, b.length + 1, ...curr);
  }
  return prev[b.length];
}

const LEVENSHTEIN_CACHE_MAX = 5000;
const levenshteinCache = new Map();
function cachedLevenshtein(a, b) {
  const key = a + '|' + b;
  if (levenshteinCache.has(key)) return levenshteinCache.get(key);
  const dist = levenshtein(a, b);
  // Evict the single oldest entry (Map iteration order = insertion order)
  // instead of wiping the whole cache — a full clear caused a burst of
  // misses right after every 5000th call.
  if (levenshteinCache.size >= LEVENSHTEIN_CACHE_MAX) {
    levenshteinCache.delete(levenshteinCache.keys().next().value);
  }
  levenshteinCache.set(key, dist);
  return dist;
}

// Every exported parse/detect function in this module funnels through here
// first. The transcript pipeline should only ever pass strings, but a single
// malformed STT payload (null/undefined/non-string) reaching this function
// used to throw uncaught and could crash the live-service process — guard
// it so bad input degrades to "no reference found" instead.
function cleanReferenceText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[.,!?;]/g, ' ')
    .replace(/\bcolon\b/gi, ':')
    .replace(/(\d)\s*:\s*(\d)/g, '$1 $2')
    .replace(/(\d)\s*-\s*(\d)/g, '$1 to $2')
    .replace(/([a-z])-([a-z])/gi, '$1 $2')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Requires the digit immediately before "zero" to itself repeat (e.g. "one
// ONE zero one") — the actual Deepgram artifact this exists for is a run of
// the SAME repeated digit word with a spurious extra zero inserted partway
// through. A plain 3-digit chapter/verse composition like "one zero four"
// (=104) has no such repetition and must NOT match this — consumeNumber's
// own 3-word lookahead already parses "one zero four" correctly on its own;
// this regex used to strip the zero out from under it too, silently
// truncating "Psalm 104" down to "Psalm 1". Real incident this caused:
// "Psalm one zero four verse twenty-four" (Psalm 104:24) parsed as Psalm
// 1:24 — an invalid verse (Psalm 1 only has 6) that still silently
// "succeeded" instead of erroring. Replacement keeps both repeated
// occurrences of the leading digit (only the spurious zero is dropped).
const DIGIT_WORDS_RE = (function() {
  const DIGIT_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine';
  return new RegExp(`\\b(${DIGIT_WORDS})\\s+\\1\\s+zero\\s+(${DIGIT_WORDS})\\b`, 'g');
})();

// Handles "chapter 7 of Luke" (chapter-then-book word order) by rewriting
// it to "Luke chapter 7" — the order every downstream check in this file
// expects. Preachers say it both ways ("Luke chapter 7" / "chapter 7 of
// Luke"); only the first form was ever recognized — the second silently
// produced ZERO references, falling through to a stale direct-partial
// guess against whatever book was active from an earlier, unrelated
// citation. Real incident (2026-09-07, real sermon audio): "chapter 7 of
// Luke from verse 1-6" (Luke 7:1-6, the centurion's servant) produced
// nothing here, and the caller's fallback resolved the bare "verse 1"
// against a stale "Psalms 45" context instead, sending "Psalms 45:1" —
// wrong book entirely, not just a wrong verse. Deliberately requires the
// token right after "of" to be a RECOGNIZED book alias (numbered-prefix
// pair or single-word book), not just any noun, so this can't misfire on
// an unrelated "chapter 7 of the book" type phrase.
function normalizeChapterOfBook(text) {
  const words = text.split(' ');
  const out = [];
  let i = 0;
  while (i < words.length) {
    if (words[i] === 'chapter') {
      let j = i + 1;
      const numTokens = [];
      while (j < words.length && numTokens.length < 4 && words[j] !== 'of') {
        numTokens.push(words[j]);
        j++;
      }
      if (numTokens.length && j < words.length && words[j] === 'of' && j + 1 < words.length) {
        const num = getNumberedPrefix(words[j + 1]);
        let bookTokens = null;
        if (num && j + 2 < words.length && BOOK_ALIASES[`${num} ${words[j + 2]}`]) {
          bookTokens = [words[j + 1], words[j + 2]];
        } else if (SINGLE_WORD_BOOKS.has(words[j + 1])) {
          bookTokens = [words[j + 1]];
        }
        if (bookTokens) {
          out.push(...bookTokens, 'chapter', ...numTokens);
          i = j + 1 + bookTokens.length;
          continue;
        }
      }
    }
    out.push(words[i]);
    i++;
  }
  return out.join(' ');
}

function getNumberedPrefix(word) {
  if (word === 'first' || word === '1' || word === '1st') return '1';
  if (word === 'second' || word === '2' || word === '2nd') return '2';
  if (word === 'third' || word === '3' || word === '3rd') return '3';
  return null;
}

// Shared by parseSpokenReference's own scan AND parseAllSpokenReferences's
// outer segmenting loop (previously two independently-maintained copies of
// this exact logic — a fix to one silently never reached the other; see the
// numbered-book fuzzy fallback below, which was originally added only here
// and had no effect at all through parseAllSpokenReferences until this was
// extracted). Returns { bookName, consumed } (bookName null if nothing
// matched at position i) — never mutates `words`.
function matchBookAt(words, i) {
  let bookName = null, consumed = 0;

  if (i + 1 < words.length) {
    const num = getNumberedPrefix(words[i]);
    if (num) {
      const key = `${num} ${words[i+1]}`;
      if (BOOK_ALIASES[key]) { bookName = BOOK_ALIASES[key]; consumed = 2; }
      else {
        // Exact stem match failed — the numbered PREFIX itself
        // ("first"/"1st"/"two"/...) is already strong, deliberate intent
        // that's rarely a coincidence, so a fuzzy match on just the stem
        // word is safe to attempt here even without a "chapter" keyword,
        // unlike the bare single-word case below. Real incident this
        // fixes: local-STT mishearings of "Kings"/"Samuel"/"Corinthians"/
        // etc. that survive as something close but not exact ("kings" ->
        // "king's", "corinthians" -> "corinthian"). Tight distance either
        // way — this is still guessing at which book, not just whether
        // one was named.
        const stem = words[i+1];
        let bestDist = Infinity, bestStem = null;
        for (const s of Object.keys(NUMBERED_BOOK_VARIANTS)) {
          const maxDist = s.length >= 9 ? 2 : 1;
          if (Math.abs(s.length - stem.length) > maxDist) continue;
          if (stem[0] !== s[0]) continue;
          const d = cachedLevenshtein(stem, s);
          if (d <= maxDist && d < bestDist) { bestDist = d; bestStem = s; }
        }
        if (bestStem) {
          // getNumberedPrefix returns a STRING ('1'/'2'/'3'); every
          // NUMBERED_BOOK_VARIANTS entry only ever has 2 real variants
          // (no book goes past "2nd"), so a spoken "third" here is
          // already a mishearing itself — fall back to the 1st variant
          // rather than indexing past the array.
          const variants = NUMBERED_BOOK_VARIANTS[bestStem];
          bookName = variants[Number(num) - 1] || variants[0];
          consumed = 2;
        }
      }
    }
  }
  if (!bookName && SINGLE_WORD_BOOKS.has(words[i])) { bookName = BOOK_ALIASES[words[i]]; consumed = 1; }

  if (!bookName && words[i].length >= 4) {
    const nextWord = words[i+1] || '';
    // "chapter" immediately after is a strong intent signal — allow looser
    // matching there. A bare number after an ordinary long word is weak
    // evidence (sermons are full of "<word> four", "<word> forty"), so we
    // require a near-exact match (dist ≤ 1) in that case to avoid turning
    // words like "strategical" / "accessed" into phantom book references.
    const hasChapterKw = nextWord === 'chapter';
    const hasNumber    = /^\d+$/.test(nextWord) || WORD_TO_NUM[nextWord] !== undefined;
    // Short candidate words (under 6 chars — Ruth, Mark, Luke, Acts, Amos,
    // Joel, Jude...) carry much higher false-positive risk per fuzzy
    // attempt: plenty of ordinary short words sit within edit-distance-1
    // of a short book name. Require the explicit "chapter" keyword (the
    // strongest available signal) for those; a bare trailing number alone
    // isn't enough evidence at that length. Longer words (the original
    // >=6 behavior) keep the more permissive bare-number allowance too.
    const isShort = words[i].length < 6;
    if (hasChapterKw || (hasNumber && !isShort)) {
      const candidate = words[i];
      const maxDist = isShort ? 1 : (hasChapterKw ? (candidate.length >= 8 ? 2 : 1) : 1);
      let bestDist = Infinity, bestAlias = null;
      for (const alias of SINGLE_WORD_BOOKS) {
        if (Math.abs(alias.length - candidate.length) > maxDist) continue;
        if (candidate[0] !== alias[0]) continue;   // STT rarely changes the first phoneme
        const d = cachedLevenshtein(candidate, alias);
        if (d <= maxDist && d < bestDist) { bestDist = d; bestAlias = alias; }
      }
      if (bestAlias) { bookName = BOOK_ALIASES[bestAlias]; consumed = 1; }
    }
  }

  return { bookName, consumed };
}

function parseSpokenReference(text, inBibleMode = false) {
  let cleanText = cleanReferenceText(text);

  for (const { find, replace, regex } of HEALING_COMPILED) {
    if (!cleanText.includes(find)) continue;
    regex.lastIndex = 0;
    cleanText = cleanText.replace(regex, replace);
  }
  if (cleanText.includes('chapter') && cleanText.includes(' of ')) {
    cleanText = normalizeChapterOfBook(cleanText);
  }

  const words = cleanText.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const matched = matchBookAt(words, i);
    const bookName = matched.bookName, consumed = matched.consumed;

    if (!bookName) continue;

    let idx = i + consumed;
    let skippedChapterKw = (idx < words.length && words[idx] === 'chapter');
    if (skippedChapterKw) idx++;

    // Single-chapter books (Obadiah, Philemon, 2 John, 3 John, Jude) have no
    // chapter to speak — a bare number is the verse: "Jude 9" = Jude 1:9.
    // Without this, the over-max-chapter path below rejects them, and a
    // numbered book ("3 John 4") falls through to re-match the bare word
    // ("John") as the wrong book.
    if (MAX_CHAPTERS[bookName] === 1) {
      let scan = idx;
      if (skippedChapterKw) {                       // "...chapter 1 verse 9" — skip the spoken "1"
        const chNum = consumeNumber(words, scan);
        if (chNum) scan += chNum.consumed;
      }
      let vKeyword = -1;
      for (let k = scan; k < words.length && k < scan + 4; k++) {
        if (['verse','verses','vers',':'].includes(words[k])) { vKeyword = k; break; }
        if (SINGLE_WORD_BOOKS.has(words[k])) break;
      }
      let vStart, consumedTo;
      if (vKeyword >= 0) {
        const r = consumeNumber(words, vKeyword + 1);
        if (r) { vStart = r.value; consumedTo = vKeyword + 1 + r.consumed; }
      } else if (!skippedChapterKw && !AMBIGUOUS_BOOKS.has(words[i])) {
        // "Jude 9" — first number is the verse, no "verse" keyword needed.
        // Excluded for ambiguous single-chapter books (Obadiah, Jude,
        // Philemon) — accepting literally ANY number that happens to
        // follow, with zero structural cue, is exactly how an STT-
        // hallucinated "Obadiah" ("...you owe him Obadiah for your desired
        // change...", nothing to do with scripture) combined with an
        // unrelated nearby number to compose a full, wrong citation
        // (Obadiah 1:4). Same principle as the two other AMBIGUOUS_BOOKS
        // guards above: require the actual word "verse" nearby, don't
        // infer it from bare proximity alone.
        const r = consumeNumber(words, scan);
        if (r) { vStart = r.value; consumedTo = scan + r.consumed; }
      }
      if (vStart !== undefined) {
        let vEnd = vStart;
        if (consumedTo < words.length && ['to','through','-'].includes(words[consumedTo])) {
          let a = consumedTo + 1;
          if (a < words.length && ['verse','verses'].includes(words[a])) a++;
          const e = consumeNumber(words, a);
          if (e && e.value >= vStart) vEnd = e.value;
        }
        if (vEnd !== vStart) return { book: bookName, chapter: 1, verseStart: vStart, verseEnd: vEnd };
        return { book: bookName, chapter: 1, verse: vStart };
      }
      // No verse number present — fall through to bare-book handling below.
    }

    let chRes = consumeNumber(words, idx, MAX_CHAPTERS[bookName] || Infinity);
    // Book heard, but nothing chapter-shaped immediately follows — the
    // preacher may have inserted a quote/aside before the chapter number
    // ("John — 'God so loved the world' — chapter 3"). Give that a bounded
    // amount of tolerance rather than abandoning the match outright, but
    // require the literal word "chapter" to reappear: a coincidentally
    // nearby number with no verbal cue is exactly the shape of the Esther/
    // Obadiah false-positive incidents documented below and above — this
    // stays just as strict about that, only more patient about *where*
    // the cue shows up.
    if (!chRes && !skippedChapterKw) {
      const HOLD_WINDOW = 12;
      for (let k = idx; k < words.length && k < idx + HOLD_WINDOW; k++) {
        if (words[k] === 'chapter') {
          const held = consumeNumber(words, k + 1, MAX_CHAPTERS[bookName] || Infinity);
          // Also updates skippedChapterKw itself — a downstream check
          // (the AMBIGUOUS_BOOKS verse-bail-out below) used to re-derive
          // "was there a chapter keyword" from the ORIGINAL adjacent
          // position only, which silently defeated this whole hold for
          // every AMBIGUOUS_BOOKS entry (John/Mark/Luke/Acts/James/
          // Genesis/Exodus/... — a much bigger list than it sounds,
          // and includes the exact book in the motivating example).
          if (held) { chRes = held; idx = k + 1; skippedChapterKw = true; }
          break;
        }
        if (SINGLE_WORD_BOOKS.has(words[k])) break; // a second book mention ends the hold
      }
    }
    if (!chRes) continue;
    const chapter = chRes.value;
    idx += chRes.consumed;

    const maxCh = MAX_CHAPTERS[bookName];
    if (maxCh && chapter > maxCh) {
      // The FIRST number exceeded this book's max chapter — try
      // reinterpreting it as the verse, with the number right after it as
      // the real chapter (a "book verse one chapter six"-style reordering).
      // The "verse" keyword here used to be optional, accepting whatever
      // number happened to come next even with no reference-shaped
      // structure at all between the two numbers. Real incident: an STT-
      // hallucinated "Esther" immediately followed by "twenty one" (from
      // "21 days of prayer and fasting," nothing to do with scripture)
      // satisfied this and composed a complete, wrong citation — Esther
      // 1:20 — out of two coincidentally-adjacent numbers. Requiring the
      // keyword closes that off while still supporting the genuine
      // reordering this fallback exists for.
      let peekIdx = idx;
      const hasVerseCue = peekIdx < words.length && ['verse','verses','vers'].includes(words[peekIdx]);
      if (hasVerseCue) {
        peekIdx++;
        const peekVRes = consumeNumber(words, peekIdx);
        if (peekVRes && peekVRes.value <= maxCh) {
          return { book: bookName, chapter: peekVRes.value, verse: chapter };
        }
      }
      continue;
    }

    if (idx < words.length && ['and','of','from'].includes(words[idx]) &&
        idx+1 < words.length && ['verse','verses','vers'].includes(words[idx+1])) idx++;

    let hasVerseKeyword = idx < words.length && ['verse','verses','vers',':'].includes(words[idx]);
    if (hasVerseKeyword) idx++;
    else if (idx < words.length && words[idx] === 'and' && idx + 1 < words.length
        && consumeNumber(words, idx + 1)
        && !(referenceContext.book === bookName && referenceContext.chapter != null)) {
      // "Book N and M" ("John 15 and 16") — no "chapter"/"verse" keyword at
      // all between the two numbers, a common plain-spoken citation shape.
      // Owner's spec: assume chapter N, verse M — UNLESS this book's
      // chapter is already an active, established context, in which case a
      // bare "N and M" more plausibly means two VERSES within the
      // already-known chapter (a compound verse citation), not a fresh
      // chapter number smuggled in via "and" — so this fallback is
      // deliberately skipped there and falls through to the normal
      // hold-window/stray-word paths below instead.
      hasVerseKeyword = true;
      idx++;   // skip "and" — consumeNumber below picks up the number right after it
    }

    let vRes = consumeNumber(words, idx);
    let lookAheadRepositioned = false;

    if (vRes && !hasVerseKeyword) {
      let lookIdx = idx + vRes.consumed;
      while (lookIdx < words.length && ['and','of','from'].includes(words[lookIdx])) lookIdx++;
      if (lookIdx < words.length && ['verse','verses','vers'].includes(words[lookIdx])) {
        lookIdx++;
        const explicitVRes = consumeNumber(words, lookIdx);
        if (explicitVRes) {
          vRes = explicitVRes;
          idx = lookIdx + explicitVRes.consumed;
          hasVerseKeyword = true;
          lookAheadRepositioned = true;
        }
      }
    }

    // Same tolerance as the book→chapter hold above, one step later:
    // chapter is already confirmed, but nothing verse-shaped immediately
    // follows — a quote/aside may sit between "chapter 3" and "verse 16".
    // Still requires the literal word "verse" to reappear, not a bare
    // nearby number, for the same reason.
    if (!vRes && !hasVerseKeyword) {
      const HOLD_WINDOW = 12;
      for (let k = idx; k < words.length && k < idx + HOLD_WINDOW; k++) {
        if (['verse', 'verses', 'vers'].includes(words[k])) {
          const held = consumeNumber(words, k + 1);
          if (held) { vRes = held; idx = k + 1; hasVerseKeyword = true; }
          break;
        }
        if (SINGLE_WORD_BOOKS.has(words[k])) break;
      }
    }

    // Fallback: Deepgram occasionally mis-hears "verse(s)" as an unrelated
    // single word RIGHT where a verse-range marker belongs — confirmed
    // live (2026-09-07): "Psalm chapter one Numbers one to three" for an
    // actual "...chapter one and verse one to three" (the real book name
    // "Numbers" substituted for "verses"). The HOLD_WINDOW search above
    // deliberately stops at any recognized book name, since that's
    // normally a genuine second reference — but a LONE stray word
    // immediately followed by a clean, ascending "N to M" numeric range,
    // right where the verse marker is expected, is a much stronger signal
    // of a garbled verse-range than of an intentional, keyword-less
    // second book mention (which this parser doesn't otherwise support
    // anywhere else). Deliberately narrow: exactly one word may be
    // skipped, and what follows must be an unambiguous "to"/"through"
    // range, not just a bare number — a coincidental stray word before an
    // unrelated lone number is far more likely noise than a garbled verse
    // marker, but a stray word directly before "N to M" is not.
    if (!vRes && !hasVerseKeyword && idx < words.length) {
      const strayThenStart = consumeNumber(words, idx + 1);
      if (strayThenStart) {
        const afterStart = idx + 1 + strayThenStart.consumed;
        if (afterStart < words.length && ['to', 'through'].includes(words[afterStart])) {
          vRes = strayThenStart;
          idx = idx + 1;
          hasVerseKeyword = true;
        }
      }
    }

    if (!vRes) {
      const rawBookWord = words[i];
      // Reuses skippedChapterKw (set above, including by the hold-window
      // search) rather than re-deriving "was there a chapter keyword"
      // from scratch against only the original adjacent position — that
      // duplicate computation used to silently ignore a chapter number
      // recovered via the hold, undoing it for every AMBIGUOUS_BOOKS entry.
      const hadChapterKeyword = skippedChapterKw;
      // inBibleMode used to also exempt ambiguous books from needing an
      // explicit "chapter" keyword nearby — but inBibleMode stays true for
      // 30s after ANY book mention, which is most of a sermon, so it barely
      // narrowed anything. Real incident: Deepgram mis-heard "thy father"
      // (an actual Isaiah 58:14 quote) as "thy Esther" — no "chapter"/
      // "verse" cue anywhere nearby — and inBibleMode alone let it set
      // book=Esther/chapter=4 as real context, which a later segment then
      // fused a verse onto and auto-sent as a genuine 'direct' citation.
      // Matches the bare-mention path's same rule two functions up.
      if (AMBIGUOUS_BOOKS.has(rawBookWord) && !hadChapterKeyword) continue;
      return { book: bookName, chapter, verse: null };
    }

    const verseStart = vRes.value;
    if (!lookAheadRepositioned) idx += vRes.consumed;

    const collectedRanges = [];
    if (idx < words.length && ['to','through','-'].includes(words[idx])) {
      idx++;
      if (idx < words.length && ['verse','verses'].includes(words[idx])) idx++;
      const vEndRes = consumeNumber(words, idx);
      if (vEndRes) { collectedRanges.push({ verseStart, verseEnd: vEndRes.value }); idx += vEndRes.consumed; }
      else collectedRanges.push({ verseStart, verseEnd: verseStart });
    } else {
      collectedRanges.push({ verseStart, verseEnd: verseStart });
    }

    let scanIdx = idx;
    while (scanIdx < words.length) {
      // Real incident (live test, 2026-09-07): "Ephesians six verse 12,
      // for we wrestle not against flesh and blood..." — the connector
      // skip below is OPTIONAL (a plain while, zero-or-more), so with no
      // connector present at all this fell straight through to
      // consumeNumber on whatever word came next — and "for" is a
      // deliberate, necessary homophone of "four" (consumeNumber maps it
      // to 4, for legitimate cases like "john for verse one"). Since "for"
      // is also just an ordinary, extremely common English word — and the
      // KJV itself constantly opens a verse's own continuing clause with
      // "For..." — that turned an explicit single-verse citation into a
      // bogus 2-verse range ("12" and "4") with zero real signal a second
      // verse was ever intended. A genuine compound citation is always
      // marked by an explicit connector ("and 17 to 19", ", verse 20");
      // require one to have actually been consumed before even attempting
      // to parse a continuation number, rather than trying regardless.
      const beforeConnector = scanIdx;
      while (scanIdx < words.length && ['and',',','verse','verses'].includes(words[scanIdx])) scanIdx++;
      if (scanIdx === beforeConnector) break; // no connector consumed — not a real continuation
      const nextStartRes = consumeNumber(words, scanIdx);
      if (!nextStartRes) break;
      scanIdx += nextStartRes.consumed;
      let nextEnd = nextStartRes.value;
      if (scanIdx < words.length && ['to','through'].includes(words[scanIdx])) {
        scanIdx++;
        if (scanIdx < words.length && ['verse','verses'].includes(words[scanIdx])) scanIdx++;
        const nextEndRes = consumeNumber(words, scanIdx);
        if (nextEndRes) { nextEnd = nextEndRes.value; scanIdx += nextEndRes.consumed; }
      }
      collectedRanges.push({ verseStart: nextStartRes.value, verseEnd: nextEnd });
    }

    // Merge duplicate: {A,A} immediately followed by {A,B} means the first was
    // just the verse-start spoken alone before the range — keep the wider range.
    if (collectedRanges.length === 2) {
      const [first, second] = collectedRanges;
      if (first.verseStart === first.verseEnd &&
          second.verseStart === first.verseStart &&
          second.verseEnd > second.verseStart) {
        collectedRanges.splice(0, 2, second);
      }
    }

    if (collectedRanges.length > 1) return { book: bookName, chapter, ranges: collectedRanges };
    const only = collectedRanges[0];
    if (only.verseEnd !== only.verseStart) return { book: bookName, chapter, verseStart: only.verseStart, verseEnd: only.verseEnd };
    return { book: bookName, chapter, verse: verseStart };
  }
  return null;
}

function parseAllSpokenReferences(text, inBibleMode = false) {
  let cleanText = cleanReferenceText(text);

  // Remove STT-artifact "zero" sandwiched between two single-digit number words.
  // e.g. "one one one one zero one to three" → "one one one one one to three"
  // This handles Deepgram inserting a spurious "zero" inside digit-by-digit numbers.
  DIGIT_WORDS_RE.lastIndex = 0;
  cleanText = cleanText.replace(DIGIT_WORDS_RE, '$1 $2');

  for (const { find, replace, regex } of HEALING_COMPILED) {
    if (!cleanText.includes(find)) continue;
    regex.lastIndex = 0;
    cleanText = cleanText.replace(regex, replace);
  }
  if (cleanText.includes('chapter') && cleanText.includes(' of ')) {
    cleanText = normalizeChapterOfBook(cleanText);
  }
  const words = cleanText.split(/\s+/);
  const refs = [];
  let i = 0;
  while (i < words.length) {
    // See matchBookAt's own comment — this used to be its own independent
    // copy of the exact-match-only logic, which meant the fuzzy numbered-
    // book/short-book fallbacks (added to parseSpokenReference) never had
    // any effect here: this outer loop decides where a candidate reference
    // even STARTS, so a book matchBookAt would have fuzzy-caught never got
    // as far as parseSpokenReference at all.
    const matched = matchBookAt(words, i);
    const bookName = matched.bookName, consumed = matched.consumed;
    if (!bookName) { i++; continue; }

    let nextBookIdx = words.length;
    for (let j = i+consumed; j < words.length; j++) {
      if (SINGLE_WORD_BOOKS.has(words[j]) && j > i+consumed) {
        // A recognized book name here is normally a genuine second
        // reference starting, so we stop and hand off there — EXCEPT when
        // it's immediately followed by a clean "N to M" numeric range,
        // which is a much stronger signal that this "book name" is
        // actually Deepgram mis-hearing "verse(s)" right where a
        // verse-range marker belongs than that the preacher just named a
        // second book with no "chapter"/"verse" keyword at all (a pattern
        // this parser doesn't otherwise support anywhere). Confirmed live
        // (2026-09-07): "Psalm chapter one Numbers one to three" for an
        // actual "...chapter one and verse one to three" — without this,
        // the whole tail ("Numbers one to three") was truncated away
        // before parseSpokenReference ever saw it, silently degrading a
        // full verse range down to a bare, verseless chapter citation.
        const rangeStart = consumeNumber(words, j + 1);
        const looksLikeGarbledVerseMarker = !!rangeStart &&
          words[j + 1 + rangeStart.consumed] &&
          ['to', 'through'].includes(words[j + 1 + rangeStart.consumed]);
        if (!looksLikeGarbledVerseMarker) { nextBookIdx = j; break; }
      }
      const jNum = getNumberedPrefix(words[j]);
      if (jNum && j+1 < words.length && BOOK_ALIASES[`${jNum} ${words[j+1]}`]) { nextBookIdx = j; break; }
    }

    const subText = words.slice(i, nextBookIdx).join(' ');
    const ref = parseSpokenReference(subText, inBibleMode);
    if (ref) {
      const bareWord = words[i];
      const hadPrefix = consumed > 1;
      const variants = NUMBERED_BOOK_VARIANTS[bareWord];
      if (variants && !hadPrefix) {
        // Genuinely ambiguous — "Timothy" alone (no "first"/"second") could
        // mean either book, and this parser has no session context to
        // prefer one. Tagged (not silently picking variants[0]) so the
        // caller — which DOES have context via referenceContext — can
        // disambiguate using what book was actually active, rather than
        // every ambiguous mention blindly resolving to whichever book
        // happens to be listed first. Real incident this replaces: "Timothy
        // three one to five" pushed BOTH "1 Timothy 3:1-5" and "2 Timothy
        // 3:1-5" as independent refs, and the caller (server.js's
        // processForReferences) had no way to know they were mutually
        // exclusive alternatives rather than two real separate citations —
        // both got sent to the live viewer seconds apart, one guaranteed
        // wrong. ambiguousGroup lets the caller recognize and collapse them.
        const ambiguousGroup = `${bareWord}@${i}`;
        for (const v of variants) refs.push({ ...ref, book: v, ambiguousGroup });
      } else {
        refs.push(ref);
      }
      i = nextBookIdx;
    } else {
      i++;
    }
  }
  return refs;
}

// ── Bare book detection ───────────────────────────────────────────────────
// Scans text for bare book mentions (e.g. "Exodus" on its own, or "1 John"
// with no chapter/verse). Used to hold book context across a monologue
// between the book callout and the actual "chapter X verse Y".
//
// Rules for accepting a bare book:
//   1. Numbered books ("1 John", "first corinthians") → always accept.
//   2. Unambiguous single-word books (Leviticus, Deuteronomy, …) → accept.
//   3. Ambiguous books (exodus, genesis, john, mark, …) → only when a
//      "bible trigger phrase" precedes them (book of, turn to, read from, …)
//      OR when we're already in bible mode.
//
// The trigger-phrase pass runs against the RAW (pre-healing) text because
// the healing collapses "book of exodus" → "exodus" and would erase the
// trigger. We scan triggers first, then run the healed pass for the rest.
const BIBLE_TRIGGER_PHRASES = [
  'book of', 'turn to', 'turn with me to', 'open to', 'open your bible to',
  'read from', 'read in', 'read out of', 'scripture in', 'found in',
  'writings of', 'gospel of', 'gospel according to', 'epistle of',
  'letter of', 'letter to', 'prophet',
];

function detectBookMentions(text, inBibleMode = false) {
  if (typeof text !== 'string') return [];
  const lowered = text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
  const books = [];
  const seen  = new Set();

  // Pass 1 — trigger-phrase pass on RAW text. Accepts AMBIGUOUS books too.
  for (const trigger of BIBLE_TRIGGER_PHRASES) {
    let idx = 0;
    while ((idx = lowered.indexOf(trigger, idx)) !== -1) {
      const after = lowered.slice(idx + trigger.length).trimStart();
      const afterWords = after.split(/\s+/, 3); // peek up to 3 tokens
      // Numbered: "first john", "1 peter"
      const num = getNumberedPrefix(afterWords[0]);
      if (num && afterWords[1]) {
        const key = `${num} ${afterWords[1]}`;
        if (BOOK_ALIASES[key] && !seen.has(BOOK_ALIASES[key])) {
          books.push(BOOK_ALIASES[key]);
          seen.add(BOOK_ALIASES[key]);
        }
      } else if (afterWords[0] && SINGLE_WORD_BOOKS.has(afterWords[0]) && !NUMBERED_BOOK_VARIANTS[afterWords[0]]) {
        // A bare numbered-book STEM ("Corinthians", "Timothy", "Kings"...)
        // with no 1st/2nd prefix is excluded even here, unlike ordinary
        // AMBIGUOUS_BOOKS — see this function's own header comment above
        // AMBIGUOUS_BOOKS for why a trigger phrase alone can resolve "is
        // this really a citation" but never "which numbered book," so
        // there's no safe default to fall back on the way there is for a
        // single-word ambiguous book. Real incident: "the book of
        // Corinthians" (no number) silently resolved to "1 Corinthians" via
        // BOOK_ALIASES's own blind default (NUMBERED_BOOK_VARIANTS[b][0]),
        // poisoning referenceContext before the real citation ("Corinthians
        // 10:3-5", actually 2 Corinthians) ever got a chance to go through
        // resolveAmbiguousRefs's real, context-aware disambiguation.
        const resolved = BOOK_ALIASES[afterWords[0]];
        if (resolved && !seen.has(resolved)) { books.push(resolved); seen.add(resolved); }
      }
      idx += trigger.length;
    }
  }

  // Pass 2 — healed pass. Accepts unambiguous books, or ambiguous when in bible mode.
  let cleanText = cleanReferenceText(text);
  for (const { find, replace, regex } of HEALING_COMPILED) {
    if (!cleanText.includes(find)) continue;
    regex.lastIndex = 0;
    cleanText = cleanText.replace(regex, replace);
  }
  const words = cleanText.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (i + 1 < words.length) {
      const num = getNumberedPrefix(words[i]);
      if (num) {
        const key = `${num} ${words[i + 1]}`;
        if (BOOK_ALIASES[key] && !seen.has(BOOK_ALIASES[key])) {
          books.push(BOOK_ALIASES[key]);
          seen.add(BOOK_ALIASES[key]);
          i++;
          continue;
        }
      }
    }
    const w = words[i];
    if (SINGLE_WORD_BOOKS.has(w)) {
      // Ambiguous books ("esther", "acts", "john") are common English words and
      // sermon filler. A *bare* mention — no chapter, no trigger phrase — must
      // never set context, even in bible mode: doing so lets a passing word
      // ("…out of Esther if you've…") hijack an already-established book+chapter
      // (Luke 4) and wipe the chapter, breaking later "verse N" fusion. Genuine
      // ambiguous-book callouts arrive with a trigger phrase (handled in pass 1)
      // or a chapter (handled by the full parser, not here).
      // Numbered-book stems ("corinthians", "timothy", "kings"...) are
      // excluded unconditionally, same reasoning as pass 1's own check
      // just above — no default is safe for "which numbered book," only
      // resolveAmbiguousRefs's real context-aware resolution is.
      if (AMBIGUOUS_BOOKS.has(w) || NUMBERED_BOOK_VARIANTS[w]) continue;
      const resolved = BOOK_ALIASES[w];
      if (resolved && !seen.has(resolved)) { books.push(resolved); seen.add(resolved); }
    }
  }
  return books;
}

// ── Reference Context ─────────────────────────────────────────────────────
// Tracks the last cited book/chapter so bare verse references like
// "verse 17" or "and verse 18 says" can be resolved in context.
// Context expires after 45 seconds of no explicit citation. Used to be 180s
// ("long enough to bridge a monologue between a bare book mention and the
// eventual chapter/verse call"), tightened to 20s on the reasoning that
// "most real follow-up citations land within a few seconds of the book
// mention, not minutes" — but real live testing (2026-09-07) directly
// contradicted that: a preacher explaining "verse 12" for 20 seconds
// before saying "verse 15" landed EXACTLY on the boundary, and real-world
// processing delay pushed it just past expiry — the bare "verse 15"
// trigger silently never fired at all. Per the owner's own spec:
// "speech 'verse 15' - this should go to verse 15 of the already sent
// scripture... that's a trigger along with 'next verse'" — i.e. this
// needs to reliably survive a normal expository pause, not just a few
// seconds. Raised to 45s (comfortable margin over the exact incident,
// still well short of the original 180s that motivated tightening this in
// the first place). The downstream protection this comment originally
// worried about is unchanged and still real: resolvePartialReference's
// result only ever reaches broadcastDetection as method 'direct-partial'
// (server.js), calibrated at 0.75 — below VIEWER_MIN_SCORE on its own,
// still needs D()/A() corroboration to auto-send — so widening this
// window doesn't reopen the stale-citation risk the 20s value was chosen
// to guard against, it only changes how long a bare verse NUMBER is even
// attempted against the last real book/chapter.
const CONTEXT_EXPIRE_MS = 45000;

class ReferenceContext {
  constructor() {
    this._book      = null;
    this._chapter   = null;
    this._updatedAt = 0;
  }

  // Update with a fully resolved reference.
  // - If `chapter` is provided, store it.
  // - If `chapter` is null/undefined: preserve the current chapter ONLY when
  //   the book hasn't changed. Switching books without a chapter clears the
  //   stale chapter so a later bare "verse 13" can't resolve against the
  //   previous book's chapter number.
  update(book, chapter) {
    if (!book) return;
    const bookChanged = this._book !== book;
    this._book      = book;
    if (chapter) this._chapter = chapter;
    else if (bookChanged) this._chapter = null;
    this._updatedAt = Date.now();
  }

  // Check if context is still valid.
  get isValid() {
    return !!this._book && (Date.now() - this._updatedAt) < CONTEXT_EXPIRE_MS;
  }

  get book()    { return this.isValid ? this._book    : null; }
  get chapter() { return this.isValid ? this._chapter : null; }

  reset() {
    this._book = null; this._chapter = null; this._updatedAt = 0;
  }
}

// Singleton shared across the process (imported by server.js).
const referenceContext = new ReferenceContext();

// ── Bare verse resolver ───────────────────────────────────────────────────
// Detects spoken patterns like "verse 17", "verses 3 through 5",
// "and verse eighteen" and resolves them against the current context.
// Returns null if no context or no bare verse pattern found.

function resolvePartialReference(text, { allowBareNumber = true } = {}) {
  if (!referenceContext.isValid) return null;

  // Tokenize through the same cleaner the full parser uses, then resolve
  // numbers with consumeNumber so compound spoken numbers ("seventy seven",
  // "one hundred nineteen") survive — a plain \w+ capture truncates them.
  const words = cleanReferenceText(text).split(/\s+/).filter(Boolean);

  // Pattern 1 (MORE SPECIFIC, try first): "chapter N verse M" with no book.
  // Resolves when the preacher said a bare book ("Exodus") earlier, then
  // followed up later with "chapter 3 verse 13".
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'chapter') continue;
    const chRes = consumeNumber(words, i + 1);
    if (!chRes) continue;
    const j = i + 1 + chRes.consumed;
    if (!['verse','verses','vers',':'].includes(words[j])) continue;
    const vRes = consumeNumber(words, j + 1);
    if (!vRes || !referenceContext.book) continue;
    const maxCh = MAX_CHAPTERS[referenceContext.book];
    if (maxCh && chRes.value > maxCh) continue;
    return { book: referenceContext.book, chapter: chRes.value, verse: vRes.value, partial: true };
  }

  // Pattern 2: bare "verse N" or "verses N to M" — needs a chapter in context.
  for (let i = 0; i < words.length; i++) {
    if (!['verse','verses','vers',':'].includes(words[i])) continue;
    const vRes = consumeNumber(words, i + 1);
    if (!vRes) continue;
    const verseStart = vRes.value;
    if (verseStart < 1 || verseStart > 176) continue;
    const book    = referenceContext.book;
    const chapter = referenceContext.chapter;
    if (!chapter) return null;
    let j = i + 1 + vRes.consumed;
    if (['to','through','-'].includes(words[j])) {
      let a = j + 1;
      if (['verse','verses'].includes(words[a])) a++;
      const vEnd = consumeNumber(words, a);
      if (vEnd && vEnd.value >= verseStart) {
        return { book, chapter, verseStart, verseEnd: vEnd.value, partial: true };
      }
    }
    return { book, chapter, verse: verseStart, partial: true };
  }

  // Pattern 3 (LEAST specific, tried last): a genuinely BARE number, no
  // "verse"/"chapter" keyword at all. Owner's explicit spec: "if it hears a
  // number or 'verse n' it goes to the verse of that book and chapter
  // already displayed" — a preacher calling out just "...fifteen..." as its
  // own standalone utterance (Deepgram naturally endpoints a short pause
  // like that into its own final segment) is meant to work exactly like an
  // explicit "verse 15" would.
  //
  // Deliberately narrow so it can't fire on an ordinary sentence that
  // happens to CONTAIN a number ("he waited twenty years then said..."):
  // the number must consume the segment all the way to its end, and must
  // start within the first 3 words. A number buried mid-sentence, or one
  // followed by any other real word, never matches this pattern at all —
  // only a segment that IS (up to at most 2 leading filler words) just the
  // number itself. This still only ever produces method 'direct-partial'
  // (0.75, below VIEWER_MIN_SCORE alone) downstream, so a false match here
  // still needs real corroboration before it could ever auto-send.
  //
  // allowBareNumber=false disables this pattern specifically for INTERIM
  // callers. Real incident (owner testing, 2026-09-07): a sermon with
  // enumerated points ("One attribute we saw in Isaac..." / "What is
  // meditation number two? It is...") produces exactly the shape this
  // pattern is designed to catch — a lone number — for the split second
  // Deepgram's interim transcript is JUST "One" before the rest of the
  // sentence streams in and the "consumes to the very end" check starts
  // failing again. The FINAL transcript never has this problem (a settled
  // final segment that's genuinely just "...fifteen..." IS the intended
  // case; "One attribute we saw..." as a final segment never matches at
  // all, since real words follow in the same segment) — only the fleeting
  // interim snapshot does. Caught here safely (direct-partial's 0.75 never
  // cleared VIEWER_MIN_SCORE alone), but a false match should not depend on
  // the score gate alone to stay harmless — Pattern 2 (explicit "verse N")
  // stays enabled on interim either way, since the word "verse" itself is
  // strong enough signal that a transient interim catch of it isn't the
  // same risk.
  if (allowBareNumber && referenceContext.chapter) {
    for (let i = 0; i < words.length && i <= 2; i++) {
      const nRes = consumeNumber(words, i);
      if (!nRes || i + nRes.consumed !== words.length) continue;
      const verseStart = nRes.value;
      if (verseStart < 1 || verseStart > 176) continue;
      return { book: referenceContext.book, chapter: referenceContext.chapter, verse: verseStart, partial: true };
    }
  }

  return null;
}

module.exports = {
  parseSpokenReference,
  parseAllSpokenReferences,
  resolvePartialReference,
  detectBookMentions,
  referenceContext,
  BOOK_ALIASES,
  SINGLE_WORD_BOOKS,
  AMBIGUOUS_BOOKS,
  NUMBERED_BOOK_VARIANTS,
  WORD_TO_NUM,
  consumeNumber,
};
