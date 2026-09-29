// KAIRO — sermon notes from a live session: each point the preacher made, with
// the quotable things said while making it and the scriptures shown or cited
// in it, then the prayer points raised for the church to pray — built from
// what the session captured (transcript lines and verses shown, each
// timestamped). Points come from the preacher's own enumeration ("number
// two…", "secondly…"); quotes from what was said again and again and, with the
// semantic model Kairo already ships (buildNotesWithMeaning), from what each
// point's sentences are about — always the preacher's own words, nothing
// generated.
'use strict';

const PDFDocument = require('pdfkit');
const { parseAllSpokenReferences } = require('./reference_parser');
const { VERSE_COUNTS, verseExists } = require('./verse_counts');

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
// "number two", "point three", "number 2" — not "the number one thing" or
// "verse number 2".
const NUMBERED_CUE = /(?<!\b(?:the|a|an|my|your|our|his|her|their|its|verse|chapter|psalm|page)\s+)\b(?:number|point)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b[\s,:.\-–—]*(?:is\s+)?/i;
// "Secondly, …" / "Second: …" / "The third thing is …" / "The fourth is …" at
// the start of a sentence. Not an ordinal describing something ("the first
// lady", "first things first", "the third day", "First Timothy three").
const ORDINAL_CUE = /^(?:and\s+|now\s+|so\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:ly\b[\s,:.\-–—]*|\s*[,:.\-–—]+\s*|\s+(?:thing|key|point|step|reason|way|lesson|truth|principle)\b[\s,:.\-–—]*(?:is\s+)?|\s+is\s+)/i;
// "One, he speaks to us directly." — a bare number opening a sentence; not
// counting ("One, two, three…").
const BARE_NUMBER_CUE = /^(one|two|three|four|five|six|seven|eight|nine|ten)[,:](?!\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)\s*/i;
// A declaration the congregation is led to repeat.
const DECLARATION_CUE = /\b(?:say|repeat|declare|confess)\s+(?:after|with)\s+me\b[\s,:.\-–—]*/i;
const TITLE_CUE = /\b(?:speaking|preaching|teaching|ministering|talking|sharing)\s+(?:on|to|about|from)\s+(?:the\s+|this\s+|our\s+)?(?:subject|topic|theme|message)\s*(?:titled|entitled|called)?[\s,:]*(.{4,90}?)(?:[.!?]|$)/i;
// Sermon filler that repeats without being a point.
// "…chapter four verse 20…": a citation, listed under the scriptures instead.
const CITATION_WORDS = /\b(?:chapter|verses?)\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)/i;
const FILLER = /^(?:amen|praise the lord|hallelujah|thank you(?: jesus| lord)?|glory to god|are you (?:with|listening to) me|give (?:the lord|god|him) (?:a|the biggest|a big) (?:hand|shout|clap)|yes sir|somebody (?:say|shout)|can i get an amen|in (?:the|jesus) name|lift up your hands?|look at your neighbou?r|i can tell you|let me tell you|i want to tell you|i tell you|listen to me|you know what|watch this|look at this|hear me|mark this|note this)\b/i;

const words = (t) => String(t || '').split(/\s+/).filter(Boolean);
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();

// A point or key line as a note reads: spoken lead-ins dropped ("He said,",
// "very importantly,", "So"), first letter capitalized.
const LEAD_IN = /^(?:(?:and|so|now|but|because|then|therefore|also|again|remember|listen|very importantly|importantly|he said|she said|jesus said|paul said|the bible says|the bible said|he says)[\s,:]+)+/i;
function tidy(text) {
  const t = String(text || '').replace(LEAD_IN, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
// Word pairs correct English never has ("access to is…", "the the") — a
// transcription that dropped or doubled a word; not worth a bullet.
const GARBLED = /\b(?:to|the|a|an|of|for|with|by|from)\s+(?:is|are|was|were)\b|\b(?:the|a|an)\s+(?:the|a|an)\b/i;
const contentWords = (t) => words(norm(t)).filter(w => w.length >= 4);
const wordSets = (texts) => texts.map(t => new Set(contentWords(t)));
// Mostly (60%+) the words of one of `sets`: a verse being read out, or a
// point being said again.
const mostlyFrom = (text, sets) => { const w = contentWords(text); return w.length > 0 && sets.some(s => w.filter(x => s.has(x)).length / w.length >= 0.6); };
// Said to God ("Lord, …", "Father, …"): a prayer, not a line of the sermon.
const ADDRESSED_TO_GOD = /^(?:o |oh )?(?:jesus|lord|father|god|holy spirit|abba),\s/i;

// Transcript lines are speech segments, not sentences: join them, split into
// sentences, and keep each sentence's time (the segment it started in).
function toSentences(transcript) {
  const out = [];
  let buf = '', at = null;
  for (const seg of transcript) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    if (!buf) at = seg.at;
    buf = buf ? `${buf} ${text}` : text;
    const parts = buf.split(/(?<=[.!?])\s+/);
    buf = parts.pop();
    // The buffer held no sentence end before this segment, so every sentence
    // after the first one here began in this segment.
    parts.forEach((p, i) => out.push({ text: p, at: i === 0 ? at : seg.at }));
    if (parts.length) at = seg.at;
    if (/[.!?]$/.test(buf)) { out.push({ text: buf, at }); buf = ''; }
  }
  if (buf) out.push({ text: buf, at });
  return out;
}

function detectTitle(sentences) {
  for (const s of sentences.slice(0, 400)) {
    const m = s.text.match(TITLE_CUE);
    if (m && words(m[1]).length >= 2) return m[1].replace(/^[\s,:"'“]+|[\s,:"'”]+$/g, '');
  }
  return null;
}

// Points in the order spoken. A number said again right after (restating
// "number two") is the same point; a lower number starts a new list. A list
// has two items at least: a lone "number one" or "firstly" is a manner of
// speaking, not the sermon's points.
function detectPoints(sentences) {
  const points = [];
  sentences.forEach((s, i) => {
    let n = null, rest = null;
    const m = s.text.match(NUMBERED_CUE);
    if (m) {
      n = NUMBER_WORDS[m[1].toLowerCase()] ?? parseInt(m[1], 10);
      rest = s.text.slice(m.index + m[0].length);
    } else {
      const o = s.text.match(ORDINAL_CUE);
      const b = !o && s.text.match(BARE_NUMBER_CUE);
      if (o) { n = ORDINALS[o[1].toLowerCase()]; rest = s.text.slice(o[0].length); }
      else if (b) { n = NUMBER_WORDS[b[1].toLowerCase()]; rest = s.text.slice(b[0].length); }
    }
    if (!n || n > 10) return;
    let text = rest.trim();
    // A cue said on its own ("Number two.") — the point is what comes next,
    // up to the next cue.
    const cue = (t) => NUMBERED_CUE.test(t) || ORDINAL_CUE.test(t) || BARE_NUMBER_CUE.test(t);
    for (let j = i + 1; words(text).length < 3 && j < Math.min(sentences.length, i + 3) && !cue(sentences[j].text); j++) text = `${text} ${sentences[j].text}`.trim();
    if (words(text).length < 3) return;
    const prev = points[points.length - 1];
    // "…is this: God is faithful" — the point is what follows.
    // "Number three on my list, …" — the point is what follows.
    text = text.replace(/^[,:.\-–—\s]+/, '').replace(/^(?:this|that)\s*[,:.\-–—]+\s*/i, '')
      .replace(/^(?:of|on|in|from) (?:the|my|this|our|your|today's) [a-z' ]{2,24}?[,:]\s*/i, '');
    if (prev && prev.n === n) { if (words(prev.text).length < 6) prev.text = text; return; }
    points.push({ n, text, at: s.at });
  });
  const lists = [];
  for (const p of points) {
    const list = lists[lists.length - 1];
    if (list && p.n > list[list.length - 1].n) list.push(p); else lists.push([p]);
  }
  return lists.filter(list => list.length >= 2).flat();
}

// A heading as a note: thirty words at most, cut where a clause ends when
// that leaves enough to read — a transcript that runs sentences together
// shouldn't make a point a paragraph.
function clip(text, max = 30) {
  const w = words(text);
  if (w.length <= max) return text;
  const head = w.slice(0, max).join(' ');
  const cut = Math.max(...[',', ';', ':', '–', '—'].map(c => head.lastIndexOf(c)));
  return `${cut > 0 && words(head.slice(0, cut)).length >= 8 ? head.slice(0, cut) : head}…`;
}

// Lines the preacher repeated (the same sentence, or a 6-word phrase said 3+
// times), plus declarations the congregation was led to repeat.
function detectKeyLines(sentences, max = 6, verseTexts = []) {
  const verseWords = wordSets(verseTexts);
  const bySentence = new Map();
  for (const s of sentences) {
    const k = norm(s.text);
    if (words(k).length < 5 || FILLER.test(k) || CITATION_WORDS.test(k)) continue;
    const e = bySentence.get(k) || { text: s.text, count: 0, at: s.at };
    e.count++;
    bySentence.set(k, e);
  }
  const lines = [...bySentence.values()].filter(e => e.count >= 2);

  const grams = new Map();
  for (const s of sentences) {
    if (CITATION_WORDS.test(s.text)) continue;
    const w = words(norm(s.text));
    const seen = new Set();
    for (let i = 0; i + 6 <= w.length; i++) {
      const g = w.slice(i, i + 6).join(' ');
      if (seen.has(g) || FILLER.test(g)) continue;
      seen.add(g);
      const e = grams.get(g) || { count: 0, sentence: s };
      e.count++;
      grams.set(g, e);
    }
  }
  for (const [g, e] of grams) {
    if (e.count < 3) continue;
    if (lines.some(l => norm(l.text).includes(g))) continue;
    lines.push({ text: e.sentence.text, count: e.count, at: e.sentence.at });
  }

  for (const s of sentences) {
    const m = s.text.match(DECLARATION_CUE);
    if (!m) continue;
    const text = s.text.slice(m.index + m[0].length).trim();
    if (words(text).length >= 3 && !lines.some(l => norm(l.text) === norm(text))) lines.push({ text, count: 1, at: s.at, declaration: true });
  }

  const seenText = new Set();
  return lines
    .map(l => ({ ...l, text: tidy(l.text) }))
    .filter(l => { const k = norm(l.text); if (!k || seenText.has(k)) return false; seenText.add(k); return true; })
    .filter(l => !GARBLED.test(l.text))
    // Mostly a verse's own words: the verse being read, listed under its
    // point's scriptures.
    .filter(l => !mostlyFrom(l.text, verseWords))
    .sort((a, b) => (b.count - a.count) || (a.at - b.at))
    .slice(0, max)
    .sort((a, b) => a.at - b.at);
}

// Prayer points the preacher raised for the church to pray — "Prayer point:
// Father, …", "Pray this prayer after me: Lord Jesus, …", "Pray that God
// will …" — kept as the prayer itself. A prayer said in passing during the
// sermon ("in Jesus' name we have prayed") isn't raised for anyone to pray,
// and a blessing pronounced over the church ("I cover you with the blood")
// isn't a prayer point; neither is ever listed.
const RAISE_PRAYER = /\b(?:(?:(?:our|the|my|your|next|last|another|final) )?(?:first |second |third |fourth |fifth |next |last |final )?prayer points?(?:\s+(?:number\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth))?(?:\s+is)?|(?:pray|say) (?:this|these|the following) (?:prayers?|words|prayer points?)|pray (?:like this|as follows|with me|after me|along with me)|(?:begin|start|continue) (?:to pray|praying)|(?:let's|let us) pray (?:like this|this|that|for)|(?:cry|call) (?:out )?(?:to|unto) (?:god|the lord|him|heaven)|open your mouth and pray)\b[:,.\s-]*/i;
const PRAY_THAT = /^(?:now |so |and )?(?:everybody |church |everyone |all of us )?pray (?:that|for)\b/i;
// Said to God, or asked of him in the first person: the words of a prayer.
const PRAYER_WORDS = /^(?:(?:o |oh )?(?:lord|father|god|jesus|holy spirit|abba|daddy)\b|(?:give|help|save|forgive|wash|cleanse|heal|deliver|restore|fill|open|let|grant|teach|lead|keep|make|baptize|anoint|visit|remember|arise|stretch|show|send|use|bless|empower|strengthen|renew|revive|take|come|cause|release|destroy|break|scatter|silence|uproot|remove|turn|change|enlarge|establish|settle|lift|favou?r) (?:me|my|us|our|this|it|every|all|the|your)\b|i (?:receive|repent|confess|believe|accept|surrender|reject|refuse|come|give|thank|ask|decree|declare|command)\b|thank you\b)/i;
const PRAYER_CLOSE = /[,\s]*(?:in (?:the )?(?:precious |mighty |matchless )?name of jesus|in jesus'?s? (?:precious |mighty |matchless )?name)(?: we (?:have )?prayed?)?[,.!\s]*(?:amen[.!]*)?\s*$|[,.\s]*amen[.!]*\s*$/i;

function detectPrayerPoints(sentences, max = 12) {
  const points = [];
  const seen = new Set();
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i].text.trim();
    if (words(s).length > 60) continue;   // a run-on (no punctuation): nothing to cut a prayer out of
    let body;
    const m = s.match(RAISE_PRAYER);
    if (m) body = s.slice(m.index + m[0].length).trim();
    else if (PRAY_THAT.test(s)) body = s.replace(/^(?:now |so |and )/i, '');
    else continue;
    // The prayer: whatever of the cue's own sentence is the prayer, then the
    // sentences after it that are said to God.
    const parts = [];
    if (words(body).length >= 4 && (PRAY_THAT.test(body) || PRAYER_WORDS.test(body))) parts.push(body);
    let j = i + 1;
    for (; j < sentences.length && j <= i + 5; j++) {
      const next = sentences[j].text.trim();
      if (!PRAYER_WORDS.test(next) || words(parts.join(' ')).length >= 45) break;
      parts.push(next);
    }
    const text = tidy(parts.join(' ').replace(PRAYER_CLOSE, '').trim());
    if (words(text).length < 4) continue;
    i = j - 1;
    const k = norm(text);
    if (seen.has(k)) continue;
    seen.add(k);
    points.push({ text: /[.!?]$/.test(text) ? text : `${text}.`, at: sentences[i].at });
    if (points.length >= max) break;
  }
  return points;
}

// Passages in order of first appearance. Verses of one chapter merge into
// runs of consecutive verses whatever order they were shown in (22:22, 22:21,
// 22:24 is "Job 22:21-24"); a run is placed at its earliest verse.
function groupScriptures(verses) {
  const chapters = new Map();
  for (const v of verses) {
    const m = String(v.ref || '').match(/^(.+) (\d+):(\d+)$/);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    if (!chapters.has(key)) chapters.set(key, { book: m[1], chapter: +m[2], verses: new Map() });
    const ch = chapters.get(key), n = +m[3];
    if (!ch.verses.has(n)) ch.verses.set(n, { verse: n, text: v.text || '', at: v.at });
  }
  const passages = [];
  for (const ch of chapters.values()) {
    const sorted = [...ch.verses.values()].sort((x, y) => x.verse - y.verse);
    let run = null;
    for (const v of sorted) {
      if (run && v.verse === run.end + 1) { run.end = v.verse; run.texts.push(v.text); run.at = Math.min(run.at, v.at); continue; }
      run = { book: ch.book, chapter: ch.chapter, start: v.verse, end: v.verse, texts: [v.text], at: v.at };
      passages.push(run);
    }
  }
  return passages
    .sort((x, y) => x.at - y.at)
    .map(p => ({ ...p, ref: `${p.book} ${p.chapter}:${p.start}${p.end > p.start ? '-' + p.end : ''}` }));
}

// Scriptures cited aloud ("Acts chapter four verse 20", "Romans 8:28") are
// referenced whether or not they went on screen. Kairo's own spoken-reference
// parser, with no live context: only a citation said in full counts, and only
// a verse the Bible has (captions run numbers together — "Psalm 20 18 89").
function citedScriptures(sentences) {
  const verses = [], chapters = [];
  for (const s of sentences) {
    let found = [];
    try { found = parseAllSpokenReferences(s.text) || []; } catch { found = []; }
    for (const r of found) {
      if (!r || !r.book || !VERSE_COUNTS[r.book]?.[r.chapter - 1]) continue;
      const cite = (v) => { if (verseExists(r.book, r.chapter, v)) verses.push({ ref: `${r.book} ${r.chapter}:${v}`, at: s.at }); };
      if (r.verse) cite(r.verse);
      else if (r.verseStart) {
        const end = Math.max(r.verseStart, Math.min(r.verseEnd || r.verseStart, VERSE_COUNTS[r.book][r.chapter - 1]));
        for (let v = r.verseStart; v <= end; v++) cite(v);
      } else chapters.push({ book: r.book, chapter: r.chapter, ref: `${r.book} ${r.chapter}`, at: s.at });
    }
  }
  return { verses, chapters };
}

// Everything the notes are made of that needs no model: the points, every
// scripture shown or cited (with when), the lines said again and again, and
// the prayer points.
function draftNotes({ transcript = [], verses = [], name = '', startedAt = null } = {}) {
  const sentences = toSentences(transcript);
  const points = detectPoints(sentences).map(p => ({ kind: 'point', heading: clip(tidy(p.text)), at: p.at }));
  const cited = citedScriptures(sentences);
  const allVerses = [...verses, ...cited.verses];
  const passages = groupScriptures(allVerses);
  const chapterOnly = new Set(cited.chapters.filter(c => !passages.some(p => p.book === c.book && p.chapter === c.chapter)).map(c => c.ref));
  const prayerPoints = detectPrayerPoints(sentences);
  const prayers = prayerPoints.map(p => norm(p.text));
  const headings = wordSets(points.map(p => p.heading));
  // A repeated line is a quote when it would be one said once (five words
  // will do for a refrain) — and not when it restates a point (it's there
  // already, as the point), or is prayer (inside a prayer point) or the
  // service. A declaration the preacher led the church in is, "I declare…"
  // and all.
  const keyLines = detectKeyLines(sentences, 12, verses.map(v => v.text || ''))
    .filter(l => quotable(l.text, 5) && !mostlyFrom(l.text, headings) && !FILLER.test(norm(l.text))
      && !prayers.some(p => p.includes(norm(l.text))) && (l.declaration || !SERVICE_TALK.test(l.text)));
  const first = transcript.find(t => t.at)?.at, last = [...transcript].reverse().find(t => t.at)?.at;
  return {
    title: String(name || '').trim() || detectTitle(sentences) || 'Sermon Notes',
    startedAt: startedAt || first || null,
    minutes: first && last ? Math.max(1, Math.round((last - first) / 60000)) : null,
    points,
    verses: allVerses,
    chapters: cited.chapters,
    keyLines,
    prayerPoints,
    passageCount: passages.length + chapterOnly.size,
  };
}

// The notes' parts before any meaning is read: what came before the first
// point (the opening) and the points, or — where the preacher didn't number
// them — the whole sermon as one.
function baseParts(draft) {
  return draft.points.length
    ? [{ kind: 'opening', heading: 'Opening', at: -Infinity }, ...draft.points.map(p => ({ ...p }))]
    : [{ kind: 'whole', heading: '', at: -Infinity }];
}

// Gives each part (in the order said; each runs until the next begins, the
// first from the start) the scriptures shown or cited while it was being made
// — a chapter's verses merged into runs, a chapter cited on its own listed
// unless its verses are — and its most repeated lines as quotes (three; six
// for a sermon taken whole).
function layOut(parts, draft) {
  const partAt = (at) => parts.reduce((found, p) => (p.at <= at ? p : found), parts[0]);
  const byPart = (items) => {
    const m = new Map(parts.map(p => [p, []]));
    items.forEach(it => m.get(partAt(it.at)).push(it));
    return m;
  };
  const verses = byPart(draft.verses), chapters = byPart(draft.chapters), lines = byPart(draft.keyLines);
  for (const p of parts) {
    const runs = groupScriptures(verses.get(p));
    const whole = chapters.get(p).filter((c, i, all) => all.findIndex(o => o.ref === c.ref) === i
      && !runs.some(r => r.book === c.book && r.chapter === c.chapter));
    p.scriptures = [...runs, ...whole].sort((a, b) => a.at - b.at);
    p.quotes = lines.get(p)
      .sort((a, b) => (b.count - a.count) || (a.at - b.at))
      .slice(0, p.kind === 'whole' ? 6 : 3)
      .sort((a, b) => a.at - b.at)
      .map(l => ({ text: l.text, at: l.at }));
  }
  return parts;
}

// The notes as the PDF shows them. The opening, or the sermon taken whole, is
// left out when nothing in it made the notes.
function finish(draft, parts) {
  return {
    title: draft.title,
    startedAt: draft.startedAt,
    minutes: draft.minutes,
    sections: parts.filter(p => (p.kind !== 'opening' && p.kind !== 'whole') || p.quotes.length || p.scriptures.length),
    prayerPoints: draft.prayerPoints,
    passageCount: draft.passageCount,
  };
}

// The notes from the rules alone: the opening and the points (or the sermon
// taken whole), each with its repeated lines and its scriptures, then the
// prayer points.
function buildNotes(opts = {}) {
  const draft = draftNotes(opts);
  return finish(draft, layOut(baseParts(draft), draft));
}

// ── PDF ──────────────────────────────────────────────────────────────────
const BRAND = '#F5301A', INK = '#1d1d1f', MUTED = '#6e6e73';

function renderNotesPdf(notes) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 60, bottom: 60, left: 64, right: 64 }, info: { Title: notes.title, Creator: 'Kairo' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = doc.page.margins.left, width = doc.page.width - 128;

    // A new page when this one can't hold `h` more points: a heading never
    // sits at the foot of a page, away from what's under it.
    const keepRoom = (h) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
    const heading = (t) => { doc.moveDown(1.1); keepRoom(70); doc.font('Helvetica-Bold').fontSize(12).fillColor(BRAND).text(t.toUpperCase(), left, doc.y, { width, characterSpacing: 1 }).moveDown(0.45); };
    // A numbered line: a point (with room for what's under it), or a prayer
    // point (kept whole).
    const numbered = (n, t, { bold = false } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(12);
      keepRoom(doc.heightOfString(t, { width: width - 22, lineGap: 1.5 }) + (bold ? 40 : 0));
      const y = doc.y;
      doc.font('Helvetica-Bold').fillColor(BRAND).text(n, left, y, { width: 20 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(INK).text(t, left + 22, y, { width: width - 22, lineGap: 1.5 });
    };
    // A quote, in the preacher's own words.
    const quote = (t) => {
      const line = /[.!?]$/.test(t) ? t : `${t.replace(/[\s,;:–—-]+$/, '')}.`;
      doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(11.5).fillColor(INK).text(`“${line}”`, left + 22, doc.y, { width: width - 22, lineGap: 1.5 });
    };
    // The scriptures, a reference never split across lines nor a line
    // starting with the dot between two.
    const refs = (list) => {
      if (!list.length) return;
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).fillColor(MUTED).text('Scriptures  ', left + 22, doc.y, { width: width - 22, continued: true })
        .font('Helvetica').text(list.map(p => p.ref.replace(/ /g, '\u00A0')).join('\u00A0\u00A0·  '), { lineGap: 1.5 });
    };

    doc.font('Helvetica-Bold').fontSize(24).fillColor(INK).text(notes.title, left, doc.y, { width });
    const when = notes.startedAt ? new Date(notes.startedAt).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    doc.moveDown(0.25).font('Helvetica').fontSize(10.5).fillColor(MUTED)
      .text([when, notes.minutes ? `${notes.minutes} min` : '', `${notes.passageCount} passage${notes.passageCount === 1 ? '' : 's'}`].filter(Boolean).join('  ·  '), left, doc.y, { width });
    doc.moveDown(0.4).moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).strokeColor(BRAND).stroke();

    // The points (numbered by the preacher, or found where the subject
    // shifts), after the opening; or the sermon taken whole.
    if (notes.sections.length) {
      heading(notes.sections.some(sec => sec.kind === 'point' || sec.kind === 'topic') ? 'The points' : 'The message');
      let n = 0;
      for (const sec of notes.sections) {
        if (sec.kind === 'opening') { keepRoom(55); doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(sec.heading, left + 22, doc.y, { width: width - 22 }); }
        else if (sec.kind !== 'whole') numbered(`${++n}.`, sec.heading, { bold: true });
        sec.quotes.forEach(q => quote(q.text));
        refs(sec.scriptures);
        doc.moveDown(0.8);
      }
    }

    if (notes.prayerPoints?.length) {
      heading('Prayer points');
      notes.prayerPoints.forEach((p, i) => { numbered(`${i + 1}.`, p.text); doc.moveDown(0.4); });
    }

    // The footer goes under the notes, or into the foot of the last page when
    // they fill it — never onto a page of its own.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text('Notes generated by Kairo from the live session.', left, Math.min(doc.y + 14, doc.page.height - 44), { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
    doc.end();
  });
}

// ── Meaning ──────────────────────────────────────────────────────────────
// Each candidate sentence's embedding (a unit vector, from the semantic model
// the detection worker already has loaded — no model of the notes' own) says
// what it's about. The quotable sentences nearest the centre of a point's
// stretch are the ones that carry it; where the preacher didn't number the
// points, the sermon is split where its subject shifts, each part headed by
// its most telling sentence. Picked by maximal marginal relevance, so no two
// picks say the same thing; kept in the order they were said.

// Prayer, altar-call and congregation instructions: the service happening
// around the sermon, not its content — never a line in the notes.
const SERVICE_TALK = new RegExp([
  String.raw`\b(?:stand|rise) (?:up )?(?:to|on) (?:your|his|her|their) feet\b`,
  String.raw`\b(?:please )?(?:be|remain|stay) (?:comfortably )?seated\b`,
  String.raw`\b(?:lift|raise) (?:up )?(?:(?:your|both|two|holy|right|left) )+(?:hands?|voices?)\b|\b(?:your|both|two|right|left) hands? (?:up|off|on|together|high)\b`,
  String.raw`\bgive (?:the lord|god|jesus|him) (?:a |the )?(?:(?:big|bigger|biggest|loud|louder|loudest|mighty|great|good) )*(?:hand|shout|clap|praise)\b`,
  String.raw`\b(?:bow|lift) (?:your|our) heads?\b|\bclose your eyes\b|\bheads? bowed\b`,
  String.raw`\b(?:turn|look) (?:to|at) (?:your|the person|somebody)\b|\btell (?:your neighbou?r|somebody|the person)\b`,
  String.raw`\b(?:say|pray) (?:this|these|it) (?:words? )?(?:of prayer )?after me\b|\brepeat after me\b`,
  String.raw`\bin (?:the )?(?:precious |mighty |matchless )?name of jesus\b|\bin jesus'?s? (?:precious |mighty |matchless )?name\b`,
  String.raw`\blet us pray\b|\bwe (?:have )?(?:prayed|given thanks)\b|\bfather,? (?:we|i) (?:thank|pray|ask|come)\b`,
  String.raw`\b(?:i|we) (?:decree|declare)\b|\bshall be (?:scattered|destroyed|broken|removed|consumed|silenced)\b|\bis (?:declared|broken|destroyed|averted) (?:today|now|this|over)\b`,
  String.raw`\b(?:clap|wave) your hands\b|\bopen your bibles?\b|\bturn (?:with me )?to (?:the book of )?\w+ chapter\b`,
  String.raw`\bplease (?:stand|rise|come|move|submit|sit|return|get)\b|\b(?:lift|raise) (?:up )?(?:your )?(?:right |left )?hands?\b`,
  String.raw`\b(?:let me hear|give me) (?:a |your )?(?:loud(?:est)? )?(?:amen|shout|clap)\b|\baltar\b|\b(?:dedicate|rededicate|give) (?:your|his|her|their) li(?:fe|ves) to (?:christ|jesus|him)\b`,
  String.raw`\b(?:back (?:on|to) your seats?|fill (?:out|in) (?:your|the) card|(?:submit|drop) (?:your|the) card)\b|\bthe prayer (?:i|we) pray\b`,
  String.raw`\b(?:is|are|be) (?:declared )?(?:averted|reversed|cancell?ed|broken|over) (?:today|tonight|now|this (?:morning|evening|moment))\b|\bi (?:speak|pronounce|command)\b`,
  String.raw`\b(?:is|are|be) (?:hereby )?(?:declared|pronounced|decreed)\b|\b(?:is|are) (?:broken|lifted|cancell?ed|destroyed) (?:off|over) (?:your|you)\b`,
  String.raw`\b(?:i|we|let me|let us|let's)(?: will| want to| would like to| like to|'ll|'d like to|'m| am| are)? pray(?:ing)? (?:with|for|over) (?:you|us)\b`,
].join('|'), 'i');

// The transcript as sentences. A transcript without punctuation (some
// captions) can't be split into quotable sentences, so it gets the notes
// without meaning: null.
function speechUnits(transcript) {
  const sentences = toSentences(transcript);
  const totalWords = sentences.reduce((n, s) => n + words(s.text).length, 0);
  if (!totalWords || sentences.length * 1000 / totalWords < 40) return null;
  return sentences;
}

// Sentences worth considering (candidateSentences): a statement of 6-45
// words, not filler or service talk, not a citation or a scripture being read
// (listed on their own), not a point's own opening line (that's its heading),
// not garbled. One that stands on its own as a quote (quotable): 6-24 words
// that don't open by leaning on what came before ("It's…", "They…",
// "Which…", "When he…", a clause with nothing after it, "Bring you…" with its
// subject lost) or by telling the room to do something ("Move to…", "Look
// at…"), aren't about the room itself (ushers, cards, yesterday's outing,
// prices) and aren't a fragment with no verb in it.
const LEANS_ON_CONTEXT = /^(?:it'?s?|its|they|them|their|he|him|his|she|her|this|that|these|those|there|here|which|who|whom|whose|what|where|why|how|or|nor|of|to|for|with|in|into|on|upon|at|by|from|through|under|over|without|within|about|after|before|until|while|as|like|just|maybe|well|okay|ok|yes|yeah|no|oh|uh|um|uh-uh|mm|hmm|ah|eh|now|even|also|then|than|is|are|was|were|i mean|you know|if you like|thy|thee|thou)\b|^(?:when|whenever|if|because|since|though|although|unless|once) (?:he|she|they|it|him|her|them|this|that|these|those)\b|^(?:when|whenever|if|since|though|although|unless|once)\b[^,;:–—]*$|^(?:bring|make|give|take|lead|keep|bless|help|set|cause|grant|send|put|carry|turn)\s+you\b/i;
const TELLS_THE_ROOM = /^(?:please |just |now |come on )?(?:move|go|come|turn|look|tell|say|lift|raise|stand|sit|bow|close|open|give|clap|shout|hold|put|take|ask|pray|repeat|wave|write|mention|touch|hug|greet|check|call)\b/i;
const ABOUT_THE_ROOM = /\b(?:ushers?|offering|seats?|seated|cards?|altar|workshop|officials?|announcements?|yesterday|last (?:week|night|year|sunday)|microphone|camera|livestream|online|the team|papers?|envelopes?|naira|dollars?|pounds?)\b|\d/i;
const HAS_VERB = /\b(?:is|are|was|were|be|been|being|am|will|shall|would|should|can|could|cannot|can't|must|may|might|do|does|did|don't|doesn't|didn't|has|have|had|won't|isn't|aren't|wasn't|weren't|never|always)\b|\b\w+(?:s|ed|es)\b/i;
// …nor a prayer or a blessing (said to God, or "Let…", "May…"), a word for
// this moment ("from today…"), a personal aside ("I… my…"), or speech that
// stumbled ("you you").
const PRAYER_START = /^(?:let|may)\b/i;
const THIS_MOMENT = /\b(?:today|tonight|right now|from now|this (?:[a-z]+ )?(?:morning|evening|night|moment|year|week|service|meeting|gathering|encounter|conference|convention|programme|program))\b/i;
const STUMBLED = /\b(\w+)[,\s]+\1\b/i;
const firstPerson = (t) => (t.match(/\b(?:i|i'm|i've|i'll|i'd|me|my|mine|myself)\b/gi) || []).length;
// …and says something: two words at least that aren't pronouns, helpers or
// "going to do" ("I'm not going to do that" says nothing on the page).
const LIGHT_WORDS = new Set(("i i'm i've i'll i'd me my mine you you're you've you'll your yours he he's him his she she's her hers it it's its we we're us our they they're them their "
  + "this that these those here there what which who whom is are was were be been being am do does did done doing don't doesn't didn't have has had "
  + "will would shall should can could may might must won't can't cannot not no yes going go goes gone get gets got to a an the and or but of in on at "
  + "for with so just now then out up like let make say said know see thing things one all some any").split(' '));
const substantive = (t) => words(norm(t)).filter(w => !LIGHT_WORDS.has(w)).length;
// A line thick with "it", "she", "they" is about something said before it.
// ("He" is left out: in a sermon it's so often God.)
const leansOnPronouns = (t) => (t.match(/\b(?:it|it's|its|she|she's|her|they|they're|them|their)\b/gi) || []).length / Math.max(1, words(t).length) >= 0.25;
// …nor misheard speech the transcript garbled (two determiners in a row,
// a sentence ending mid-phrase), nor a story being told (past tense with
// nothing said in the present about it).
const MISHEARD = /\b(?:my|your|our|his|their|the|an?)\s+(?:that|which|is|are|was|were|the|an?|my|your|our|his|their)\b|\b(?:until|unless|because|although|though)\s+(?:be|is|are|was|were)\b|\b(?:and|or|but|the|an?|to|of|for|with|that|because|so)\s*[.!]?\s*$/i;
const TELLS_A_STORY = /\b(?:had|went|came|said|told|saw|took|gave|happened)\b/i;
const SAYS_A_TRUTH = /\b(?:is|are|will|shall|can|cannot|can't|must|never|always|don't|doesn't|won't|isn't|aren't)\b/i;
function quotable(text, min = 6) {
  const t = text.replace(/^(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|finally|lastly),?\s+/i, '');
  const n = words(t).length;
  return n >= min && n <= 24 && substantive(t) >= 2 && !LEANS_ON_CONTEXT.test(t) && !leansOnPronouns(t) && !TELLS_THE_ROOM.test(t) && !ABOUT_THE_ROOM.test(t) && HAS_VERB.test(t)
    && !/\?\s*$/.test(t) && !ADDRESSED_TO_GOD.test(t) && !PRAYER_START.test(t) && !THIS_MOMENT.test(t) && !STUMBLED.test(t) && firstPerson(t) < 2
    && !/^some of (?:them|us|you|these|those)\b/i.test(t)
    && !MISHEARD.test(t) && !(TELLS_A_STORY.test(t) && !SAYS_A_TRUTH.test(t));
}

function candidateSentences(sentences, verseTexts = []) {
  const verseWords = wordSets(verseTexts);
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    const text = tidy(s.text);
    const n = words(text).length;
    if (n < 6 || n > 45) continue;
    const k = norm(text);
    if (seen.has(k) || FILLER.test(k) || CITATION_WORDS.test(k) || GARBLED.test(text) || DECLARATION_CUE.test(text) || SERVICE_TALK.test(text)) continue;
    if (NUMBERED_CUE.test(s.text) || ORDINAL_CUE.test(s.text) || BARE_NUMBER_CUE.test(s.text)) continue;
    if (/\?\s*$/.test(text) && n < 12) continue;
    if (mostlyFrom(text, verseWords)) continue;
    seen.add(k);
    out.push({ text, at: s.at, quotable: quotable(text) });
  }
  return out;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function centroid(vecs) {
  const c = new Float32Array(vecs[0].length);
  for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  let n = 0;
  for (let i = 0; i < c.length; i++) n += c[i] * c[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < c.length; i++) c[i] /= n;
  return c;
}

// Up to k sentences near `centre`, each unlike those already picked (a
// near-repeat is never picked at all). A sentence close to `avoid` (the
// sermon's own service talk) counts for less; so, a little, does a
// first-person aside ("I went out yesterday…"), and a sentence with more to
// it for a little more than a short, general one.
function pickCentral(items, centre, k, { lambda = 0.72, repeat = 0.9, avoid = null, floor = -Infinity } = {}) {
  const pool = items.map(it => {
    let rel = dot(it.vec, centre) - (avoid ? 0.5 * Math.max(0, dot(it.vec, avoid)) : 0) + 0.06 * Math.log1p(it.echoes || 0);
    rel *= (0.88 + 0.12 * Math.min(1, contentWords(it.text).length / 10)) * (/^i\b/i.test(it.text) ? 0.9 : 1);
    return { it, rel };
  }).filter(p => p.rel >= floor);
  const picked = [];
  while (picked.length < k && pool.length) {
    let best = -1, bestScore = -Infinity;
    pool.forEach((p, i) => {
      const redundancy = picked.length ? Math.max(...picked.map(q => dot(q.vec, p.it.vec))) : 0;
      if (redundancy >= repeat) return;
      const score = lambda * p.rel - (1 - lambda) * redundancy;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best < 0) break;
    picked.push(pool.splice(best, 1)[0].it);
  }
  return picked.sort((a, b) => a.at - b.at);
}

// Where the subject shifts: TextTiling over the embeddings — the similarity
// between the few sentences before and after each gap, cut at the deepest
// dips. About one section per eight minutes, two to six of them.
function topicSections(cands, minutes) {
  const n = cands.length;
  const want = Math.max(2, Math.min(6, Math.round((minutes || n / 10) / 8)));
  const w = 5, minLen = Math.max(6, Math.floor(n / (want * 2)));
  if (n < want * minLen) return [cands];
  const gaps = [];
  for (let g = w; g <= n - w; g++) {
    gaps.push({ g, sim: dot(centroid(cands.slice(g - w, g).map(c => c.vec)), centroid(cands.slice(g, g + w).map(c => c.vec))) });
  }
  gaps.forEach((x, i) => {
    let l = x.sim, r = x.sim;
    for (let j = i - 1; j >= 0 && gaps[j].sim >= l; j--) l = gaps[j].sim;
    for (let j = i + 1; j < gaps.length && gaps[j].sim >= r; j++) r = gaps[j].sim;
    x.depth = (l - x.sim) + (r - x.sim);
  });
  const cuts = [];
  for (const x of [...gaps].sort((a, b) => b.depth - a.depth)) {
    if (cuts.length >= want - 1 || x.depth <= 0) break;
    if (x.g >= minLen && n - x.g >= minLen && cuts.every(c => Math.abs(c - x.g) >= minLen)) cuts.push(x.g);
  }
  cuts.sort((a, b) => a - b);
  const out = [];
  let from = 0;
  for (const c of [...cuts, n]) { out.push(cands.slice(from, c)); from = c; }
  return out;
}

// A sentence mostly made of one verse's words is that verse being read.
const QUOTE_SHARE = 0.6;
// Two sentences this close in meaning say the same thing.
const ECHO = 0.88;
// How well a line has to fit its part (centred cosine; see pickCentral).
const LINE_FIT = 0.12;

// The notes buildNotes makes, with more of the preacher's quotable lines in
// each point (up to three; four in a long one; two in the opening), and the
// points found where they weren't numbered. `embed(texts, { check })` returns
// { vectors, quoteShares } — a unit vector per text, and how much of each of
// the first `check` texts is a Bible verse's own wording — or nothing, and
// the notes stay as buildNotes makes them.
//
// To this model every sentence of a sermon sounds alike, so the vectors are
// centred first — the sermon's average taken away — leaving what each
// sentence says that the rest doesn't. The service talk the patterns catch
// (prayers, altar calls) is embedded too, and sentences like it count for
// less.
async function buildNotesWithMeaning(opts = {}, embed) {
  const draft = draftNotes(opts);
  let parts = layOut(baseParts(draft), draft);
  const done = () => finish(draft, parts);
  if (typeof embed !== 'function') return done();
  const units = speechUnits(opts.transcript || []);
  if (!units) return done();
  let cands = candidateSentences(units, (opts.verses || []).map(v => v.text || ''));
  if (cands.length < 8) return done();
  const service = units.filter(u => words(u.text).length >= 5 && (SERVICE_TALK.test(u.text) || FILLER.test(norm(u.text)))).slice(0, 80).map(u => u.text);
  const refrains = draft.keyLines;
  const nC = cands.length, nR = refrains.length;
  // Sentences and refrains are checked for scripture being read; the service
  // talk only needs its meaning.
  const texts = [...cands.map(c => c.text), ...refrains.map(l => l.text), ...service];
  let got = null;
  try { got = await embed(texts, { check: nC + nR }); } catch { return done(); }
  const vecs = got && (Array.isArray(got) ? got : got.vectors);
  if (!vecs || vecs.length !== texts.length) return done();
  const share = (i) => (got.quoteShares ? got.quoteShares[i] : 0);
  cands.forEach((c, i) => { c.vec = vecs[i]; c.quote = share(i); });
  cands = cands.filter(c => c.quote < QUOTE_SHARE);
  if (cands.length < 8) return done();
  // A refrain that's mostly a verse's wording is the verse, said again —
  // listed under the scriptures, not quoted.
  refrains.forEach((l, i) => { l.raw = vecs[nC + i]; l.quote = share(nC + i); });
  draft.keyLines = refrains.filter(l => l.quote < QUOTE_SHARE);
  if (draft.keyLines.length < refrains.length) parts = layOut(parts, draft);
  // How often the preacher came back to the same thought in other words —
  // what's restated is what the church is meant to take home.
  cands.forEach(c => { c.raw = c.vec; });
  cands.forEach(c => { c.echoes = cands.reduce((n, o) => n + (o !== c && dot(o.raw, c.raw) >= ECHO ? 1 : 0), 0); });

  const mean = new Float32Array(cands[0].vec.length);
  for (const c of cands) for (let i = 0; i < mean.length; i++) mean[i] += c.vec[i] / cands.length;
  const centre = (v) => {
    const out = new Float32Array(v.length);
    let n = 0;
    for (let i = 0; i < v.length; i++) { out[i] = v[i] - mean[i]; n += out[i] * out[i]; }
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) out[i] /= n;
    return out;
  };
  cands.forEach(c => { c.vec = centre(c.vec); });
  const serviceVecs = vecs.slice(nC + nR).map(centre);
  const avoid = serviceVecs.length >= 3 ? centroid(serviceVecs) : null;
  // Only a quotable sentence becomes a line, but every sentence of a part
  // says what the part is about (`said`, three sentences at least); and a
  // line has to fit its part well enough (LINE_FIT) — a part shows fewer
  // lines rather than weak ones.
  const pick = (from, k, said = from) => {
    if (said.length < 3 || !from.length || k < 1) return [];
    return pickCentral(from.filter(c => c.quotable), centroid(said.map(c => c.vec)), k, { avoid, floor: LINE_FIT });
  };
  // A line said again and again is a quote already. Once a line is in the
  // notes, so is everything that says the same thing.
  const used = [...draft.keyLines];
  const unused = (list) => list.filter(c => !used.some(u => u === c || dot(u.raw, c.raw) >= ECHO));

  // What was said in each part.
  let said;
  if (draft.points.length) {
    said = parts.map((p, i) => cands.filter(c => c.at >= p.at && c.at < (i + 1 < parts.length ? parts[i + 1].at : Infinity)));
  } else {
    // Where the subject shifts, each part headed by its most telling
    // sentence; a stretch with nothing telling in it goes with the part
    // before it (or, at the start, the one after).
    const mark = used.length;
    const topics = [];
    let carry = [];
    for (const list of topicSections(cands, draft.minutes)) {
      const [head] = pick(unused(list), 1, list);
      if (!head) { if (topics.length) topics[topics.length - 1].said.push(...list); else carry.push(...list); continue; }
      used.push(head);
      topics.push({ part: { kind: 'topic', heading: head.text, at: (carry[0] || list[0]).at }, said: [...carry, ...list] });
      carry = [];
    }
    if (topics.length >= 2) {
      parts = layOut(topics.map(x => x.part), draft);
      said = topics.map(x => x.said);
    } else {
      used.length = mark;
      said = [cands];
    }
  }

  // Each part's quotes: its repeated lines, then the sentences that best
  // carry it — none restating its heading.
  parts.forEach((part, i) => {
    const k = part.kind === 'opening' ? (said[i].length >= 4 ? 2 : 0) : part.kind === 'whole' ? 6 : said[i].length >= 30 ? 4 : 3;
    const heading = part.kind === 'point' || part.kind === 'topic' ? wordSets([part.heading]) : [];
    part.quotes = part.quotes.filter(q => !mostlyFrom(q.text, heading));
    const lines = pick(unused(said[i]).filter(c => !mostlyFrom(c.text, heading)), k - part.quotes.length, said[i]);
    used.push(...lines);
    part.quotes = [...part.quotes, ...lines.map(c => ({ text: c.text, at: c.at }))].sort((a, b) => a.at - b.at);
  });
  return done();
}

module.exports = { buildNotes, buildNotesWithMeaning, renderNotesPdf, toSentences, detectPoints, detectKeyLines, detectTitle, detectPrayerPoints, groupScriptures, candidateSentences, pickCentral, topicSections };
