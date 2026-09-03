#!/usr/bin/env node
// Build Kairo's bundled hymn bank from the Open Hymnal Project.
//
// The Open Hymnal Project (openhymnal.org) explicitly places its
// compilation, indices and data files in the PUBLIC DOMAIN — the one large
// hymn set that is safe to ship inside Kairo (see scripts/import-hymns.js
// for why the other GitHub sets are not). Its data is ABC-Plus music
// notation with the lyrics carried on `w:` (aligned, syllabified) and `W:`
// (free-text) lines; this script parses those into Kairo's block format.
//
// Usage:
//   git clone --depth 1 https://github.com/mzealey/openhymnal /tmp/openhymnal
//   node scripts/import-openhymnal.js /tmp/openhymnal [--out src/hymn-bank.json]
//
// Output feeds hymns.js's IMPORTED bank (loadHymnBank), merged ahead of the
// built-ins with the built-ins winning on id clash.
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root || !fs.existsSync(path.join(root, 'Complete'))) {
  console.error('usage: node scripts/import-openhymnal.js <openhymnal repo path> [--out <file>]');
  console.error('  the path must contain a Complete/ directory');
  process.exit(1);
}
const outArg = process.argv.indexOf('--out');
const outPath = path.resolve(outArg >= 0 && process.argv[outArg + 1] ? process.argv[outArg + 1] : 'src/hymn-bank.json');

const slug = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Clean one aligned `w:` lyric token stream into plain text:
//  "per- ish- ing"  → "perishing"     (hyphen joins syllables)
//  "~"              → a hard space
//  "*"              → held note, no syllable — drop
//  "1.~" / "1."     → verse marker, stripped by the caller
function cleanW(raw) {
  return raw
    .replace(/~/g, ' ')
    .replace(/\s*-\s+/g, '')       // join "per- ish" → "perish"
    .replace(/(^|\s)\*(?=\s|$)/g, ' ')
    .replace(/[_\\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function parseHymn(abc, fallbackTitle) {
  const lines = abc.split(/\r?\n/);
  let title = fallbackTitle, author = '', year = null, aka = '';

  const wLines = [];   // aligned lyric lines, in file order
  const bigW = [];      // free-text W: lines
  for (const ln of lines) {
    let m;
    if ((m = ln.match(/^T:\s*(.+)/))) {
      const t = m[1].trim();
      const ak = t.match(/^\(also known as (.+?)\)$/i);
      if (ak) aka = ak[1].trim();
      else if (title === fallbackTitle) title = t;
    }
    else if ((m = ln.match(/^%OHAUTHOR\s+([^(]+)/))) {
      // "Crosby, Fanny Jane (1820-1915)" → "Fanny Jane Crosby"
      const parts = m[1].split(',').map(s => s.trim());
      author = parts.length === 2 ? `${parts[1]} ${parts[0]}` : m[1].trim();
    } else if ((m = ln.match(/^C:\s*Words?:\s*(.+)/i))) {
      const w = m[1].trim();
      if (!author) { const nm = w.match(/^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/); if (nm) author = nm[1]; }
      const y = w.match(/\b(1[0-9]\d\d|20[0-2]\d)\b/); if (y) year = Number(y[1]);
    } else if ((m = ln.match(/^w:\s*(.+)/))) wLines.push(m[1]);
    else if ((m = ln.match(/^W:\s*(.+)/))) bigW.push(m[1].trim());
  }

  // ── aligned verses ────────────────────────────────────────────────────
  // The first contiguous run of numbered w: lines fixes the verse count and
  // seeds each verse's opening line. Every later group of that many w:
  // lines is one more line for verses 1..N in order.
  const verses = new Map();  // n → [line, line, …]
  let vCount = 0, phase = 'seed', idx = 0;
  for (const raw of wLines) {
    const numMatch = raw.match(/^\s*(\d+)\s*\.\s*~?\s*/);
    if (phase === 'seed') {
      if (numMatch) {
        const n = Number(numMatch[1]);
        const text = cleanW(raw.slice(numMatch[0].length));
        verses.set(n, [text]);
        vCount = Math.max(vCount, n);
      } else { phase = 'cont'; idx = 0; /* fall through to handle this line */ }
    }
    if (phase === 'cont') {
      const n = (idx % Math.max(1, vCount)) + 1;
      const text = cleanW(raw.replace(/^\s*\d+\s*\.\s*~?\s*/, ''));
      if (text) { if (!verses.has(n)) verses.set(n, []); verses.get(n).push(text); }
      idx++;
    }
  }

  // A tail that only verse 1 carries while verses 2..N are shorter for the
  // same systems is a REFRAIN — pull it out into its own block after v1.
  let refrain = null;
  const v1 = verses.get(1) || [];
  const v2len = (verses.get(2) || []).length;
  if (vCount > 1 && v1.length > v2len) {
    refrain = v1.splice(v2len, v1.length - v2len);
  }

  // ABC `w:` lines follow music systems, not poetic lines — re-flow each
  // verse: join, then break at sentence punctuation and at a comma before a
  // capitalised word (a hymn line boundary), so the presenter gets stanza
  // lines rather than mid-phrase splits.
  const reflow = (sysLines) => {
    const joined = sysLines.join(' ').replace(/\s+/g, ' ').trim();
    return joined
      .split(/(?<=[;.!?])\s+|(?<=,)\s+(?=[A-Z])/)
      .map(s => s.trim())
      .filter(Boolean);
  };

  const blocks = [];
  for (let n = 1; n <= vCount; n++) {
    const ls = reflow((verses.get(n) || []).filter(Boolean));
    if (ls.length) blocks.push({ label: `Verse ${n}`, lines: ls });
    if (n === 1 && refrain && refrain.length) {
      blocks.splice(1, 0, { label: 'Refrain', lines: reflow(refrain) });
    }
  }

  // ── free-text extra verses (W:) ───────────────────────────────────────
  let cur = null;
  for (const w of bigW) {
    const nm = w.match(/^(\d+)\s*\.\s*(.*)/);
    if (nm) { cur = { label: `Verse ${nm[1]}`, lines: [] }; if (nm[2].trim()) cur.lines.push(nm[2].trim()); blocks.push(cur); }
    else if (cur) cur.lines.push(w);
    else { cur = { label: `Verse ${blocks.length + 1}`, lines: [w] }; blocks.push(cur); }
  }

  const fullTitle = aka && !title.toLowerCase().includes(aka.toLowerCase())
    ? `${title} (${aka})` : (title || fallbackTitle);
  return {
    id: slug(title),
    title: fullTitle,
    author: author || 'Unknown',
    year: year || null,
    meter: '',
    source: 'Open Hymnal Project (public domain)',
    blocks: blocks.filter(b => b.lines.length),
  };
}

const dirs = fs.readdirSync(path.join(root, 'Complete'), { withFileTypes: true })
  .filter(d => d.isDirectory());

const out = [];
let skipped = 0;
for (const d of dirs) {
  const files = fs.readdirSync(path.join(root, 'Complete', d.name)).filter(f => f.endsWith('.abc'));
  if (!files.length) { skipped++; continue; }
  const abc = fs.readFileSync(path.join(root, 'Complete', d.name, files[0]), 'utf8');
  const hymn = parseHymn(abc, d.name.replace(/_/g, ' '));
  if (hymn.blocks.length) out.push(hymn);
  else skipped++;
}

// De-dup by id (built-ins win at merge time anyway; this just keeps the file clean).
const seen = new Set();
const deduped = out.filter(h => (seen.has(h.id) ? false : (seen.add(h.id), true)));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(deduped, null, 1));

console.log(`[openhymnal] ${deduped.length} hymns → ${path.relative(process.cwd(), outPath)}` +
  (skipped ? `  (${skipped} skipped — no parseable lyrics)` : ''));
console.log(`[openhymnal] total verse/refrain blocks: ${deduped.reduce((n, h) => n + h.blocks.length, 0)}`);
console.log('[openhymnal] source: Open Hymnal Project — public domain compilation.');
