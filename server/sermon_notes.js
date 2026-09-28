// KAIRO — sermon notes from a live session: the points the preacher made, the
// scriptures shown under each, the lines he kept coming back to, and every
// passage read — built from what the session captured (transcript lines and
// verses shown, each timestamped). No model: points come from the preacher's
// own enumeration ("number two…", "secondly…"), emphasis from repetition.
'use strict';

const PDFDocument = require('pdfkit');

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
// "number two", "point three", "number 2"
const NUMBERED_CUE = /\b(?:number|point)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b[\s,:.\-–—]*/i;
// "Secondly, …" / "The third thing is …" at the start of a sentence
// Not "First Timothy …" — an ordinal before a numbered book is a citation.
const ORDINAL_CUE = /^(?:and\s+|now\s+|so\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:ly)?(?![\s,]+(?:samuel|kings|chronicles|corinthians|thessalonians|timothy|peter|john)\b)(?:\s+(?:thing|key|point|step|reason|way))?\b[\s,:.\-–—]*(?:is\s+)?/i;
// "One, he speaks to us directly." — a bare number opening a sentence; not
// counting ("One, two, three…").
const BARE_NUMBER_CUE = /^(one|two|three|four|five|six|seven|eight|nine|ten)[,:](?!\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)\s*/i;
// A declaration the congregation is led to repeat.
const DECLARATION_CUE = /\b(?:say|repeat|declare|confess)\s+(?:after|with)\s+me\b[\s,:.\-–—]*/i;
const TITLE_CUE = /\b(?:speaking|preaching|teaching|ministering|talking|sharing)\s+(?:on|to|about|from)\s+(?:the\s+|this\s+|our\s+)?(?:subject|topic|theme|message)\s*(?:titled|entitled|called)?[\s,:]*(.{4,90}?)(?:[.!?]|$)/i;
// Sermon filler that repeats without being a point.
// "…chapter four verse 20…": a citation, listed under the scriptures instead.
const CITATION_WORDS = /\b(?:chapter|verses?)\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)/i;
const FILLER = /^(?:amen|praise the lord|hallelujah|thank you(?: jesus| lord)?|glory to god|are you (?:with|listening to) me|give (?:the lord|god|him) (?:a|the biggest|a big) (?:hand|shout|clap)|yes sir|somebody (?:say|shout)|can i get an amen|in (?:the|jesus) name|lift up your hands?|look at your neighbou?r)\b/i;

const words = (t) => String(t || '').split(/\s+/).filter(Boolean);
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();

// A point or key line as a note reads: spoken lead-ins dropped ("He said,",
// "very importantly,", "So"), first letter capitalized.
const LEAD_IN = /^(?:(?:and|so|now|but|then|therefore|also|again|remember|listen|very importantly|importantly|he said|she said|jesus said|paul said|the bible says|the bible said|he says)[\s,:]+)+/i;
function tidy(text) {
  const t = String(text || '').replace(LEAD_IN, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
// Word pairs correct English never has ("access to is…", "the the") — a
// transcription that dropped or doubled a word; not worth a bullet.
const GARBLED = /\b(?:to|the|a|an|of|for|with|by|from)\s+(?:is|are|was|were)\b|\b(?:the|a|an)\s+(?:the|a|an)\b/i;
const contentWords = (t) => words(norm(t)).filter(w => w.length >= 4);

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
// "number two") is the same point; a lower number starts a new series.
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
    // A cue said on its own ("Number two.") — the point is what comes next.
    for (let j = i + 1; words(text).length < 5 && j < Math.min(sentences.length, i + 3); j++) text = `${text} ${sentences[j].text}`.trim();
    if (words(text).length < 3) return;
    const prev = points[points.length - 1];
    if (prev && prev.n === n) { if (words(prev.text).length < 6) prev.text = text; return; }
    points.push({ n, text: text.replace(/^[,:.\-–—\s]+/, ''), at: s.at });
  });
  return points;
}

// Lines the preacher repeated (the same sentence, or a 6-word phrase said 3+
// times), plus declarations the congregation was led to repeat.
function detectKeyLines(sentences, max = 6, verseTexts = []) {
  const verseWordSets = verseTexts.map(t => new Set(contentWords(t)));
  // Mostly a verse's own words: a scripture quote, listed under its point —
  // unless the preacher made it a refrain (3+ times).
  const quotesScripture = (text) => { const w = contentWords(text); return w.length > 0 && verseWordSets.some(v => w.filter(x => v.has(x)).length / w.length >= 0.6); };
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
    .filter(l => l.count >= 3 || !quotesScripture(l.text))
    .sort((a, b) => (b.count - a.count) || (a.at - b.at))
    .slice(0, max)
    .sort((a, b) => a.at - b.at);
}

// Verses in order of first appearance; consecutive verses of one chapter merge
// into a passage ("Psalms 29:3-5").
function groupScriptures(verses) {
  const seen = new Set(), list = [];
  for (const v of verses) {
    const m = String(v.ref || '').match(/^(.+) (\d+):(\d+)$/);
    if (!m || seen.has(v.ref)) continue;
    seen.add(v.ref);
    list.push({ book: m[1], chapter: +m[2], verse: +m[3], text: v.text || '', at: v.at });
  }
  const passages = [];
  for (const v of list) {
    const last = passages[passages.length - 1];
    if (last && last.book === v.book && last.chapter === v.chapter && v.verse === last.end + 1) {
      last.end = v.verse; last.texts.push(v.text);
    } else {
      passages.push({ book: v.book, chapter: v.chapter, start: v.verse, end: v.verse, texts: [v.text], at: v.at });
    }
  }
  return passages.map(p => ({ ...p, ref: `${p.book} ${p.chapter}:${p.start}${p.end > p.start ? '-' + p.end : ''}` }));
}

// The notes, in the shape asked for: the sermon's name, the key things said
// (bullets), then one subsection per point the preacher made, each with the
// scriptures shown while he was on it. Scriptures before the first point open
// the sermon ("Introduction"). A sermon with no enumerated points gets a
// single subsection listing every passage.
function buildNotes({ transcript = [], verses = [], name = '', startedAt = null } = {}) {
  const sentences = toSentences(transcript);
  const points = detectPoints(sentences);
  const scriptures = groupScriptures(verses);
  const sections = points.map(p => ({ heading: tidy(p.text), at: p.at, scriptures: [] }));
  const intro = { heading: 'Introduction', scriptures: [] };
  for (const p of scriptures) {
    let idx = -1;
    for (let i = 0; i < sections.length; i++) if (sections[i].at <= p.at) idx = i;
    (idx < 0 ? intro : sections[idx]).scriptures.push(p);
  }
  if (!points.length) intro.heading = 'Scriptures in this message';
  // A key line that restates a point is already in the notes as that point.
  const pointWords = sections.map(sec => new Set(contentWords(sec.heading)));
  const restatesPoint = (text) => { const w = contentWords(text); return w.length > 0 && pointWords.some(pw => w.filter(x => pw.has(x)).length / w.length >= 0.6); };
  const first = transcript.find(t => t.at)?.at, last = [...transcript].reverse().find(t => t.at)?.at;
  return {
    title: String(name || '').trim() || detectTitle(sentences) || 'Sermon Notes',
    startedAt: startedAt || first || null,
    minutes: first && last ? Math.max(1, Math.round((last - first) / 60000)) : null,
    keyThings: detectKeyLines(sentences, 8, verses.map(v => v.text || '')).filter(l => !restatesPoint(l.text)).slice(0, 6),
    sections: [...(intro.scriptures.length ? [intro] : []), ...sections],
    passageCount: scriptures.length,
  };
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

    const heading = (t) => { doc.moveDown(1.1).font('Helvetica-Bold').fontSize(12).fillColor(BRAND).text(t.toUpperCase(), left, doc.y, { width, characterSpacing: 1 }).moveDown(0.45); };
    const bullet = (t, { bold = false } = {}) => {
      const y = doc.y;
      doc.font('Helvetica').fontSize(12).fillColor(BRAND).text('•', left, y, { width: 12 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(12).fillColor(INK).text(t, left + 16, y, { width: width - 16, lineGap: 1.5 });
    };
    const refs = (label, list, indent) => {
      if (!list.length) return;
      doc.moveDown(0.15).font('Helvetica-Bold').fontSize(10).fillColor(MUTED).text(`${label}  `, left + indent, doc.y, { width: width - indent, continued: true })
        .font('Helvetica').text(list.map(p => p.ref).join('  ·  '), { lineGap: 1.5 });
    };

    doc.font('Helvetica-Bold').fontSize(24).fillColor(INK).text(notes.title, left, doc.y, { width });
    const when = notes.startedAt ? new Date(notes.startedAt).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    doc.moveDown(0.25).font('Helvetica').fontSize(10.5).fillColor(MUTED)
      .text([when, notes.minutes ? `${notes.minutes} min` : '', `${notes.passageCount} passage${notes.passageCount === 1 ? '' : 's'}`].filter(Boolean).join('  ·  '), left, doc.y, { width });
    doc.moveDown(0.4).moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1.5).strokeColor(BRAND).stroke();

    if (notes.keyThings.length) {
      heading('Key things said');
      for (const l of notes.keyThings) { bullet(l.text); doc.moveDown(0.4); }
    }

    const intro = notes.sections.find(sec => sec.heading === 'Introduction' || sec.heading === 'Scriptures in this message');
    const points = notes.sections.filter(sec => sec !== intro);
    if (points.length || intro) {
      heading('In the sermon');
      if (intro) { refs(points.length ? 'Opening scriptures' : 'Scriptures', intro.scriptures, 0); doc.moveDown(0.7); }
      for (const sec of points) {
        bullet(sec.heading, { bold: true });
        refs('Scriptures', sec.scriptures, 16);
        doc.moveDown(0.7);
      }
    }

    doc.moveDown(1).font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Notes generated by Kairo from the live session.', left, doc.y, { width, align: 'center' });
    doc.end();
  });
}

module.exports = { buildNotes, renderNotesPdf, toSentences, detectPoints, detectKeyLines, detectTitle, groupScriptures };
