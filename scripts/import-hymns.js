#!/usr/bin/env node
// Convert a third-party hymn dataset into Kairo's song-bank format.
//
// Usage:
//   node scripts/import-hymns.js <input.json> [--format auto|ghs|songdata|generic] [--out src/hymn-bank.json]
//
// Kairo's format:
//   { id, title, author, year, meter, source, blocks: [{ label, lines: [string] }] }
//
// ── Licensing, read this first ────────────────────────────────────────────
// The hymn TEXTS published before 1929 are public domain, but a repository's
// *compilation* (its selection, transcription and structuring) can still carry
// its own licence. Two of the popular GitHub sets are not safely bundleable:
//
//   • marvinjude/gospel-hymns (GHS, 260 hymns) — no LICENSE file at all, which
//     under default copyright means all rights reserved.
//   • josmithua/song-data (Believers Hymn Book) — AGPL-3.0, a strong copyleft
//     that would arguably reach the application distributing it.
//
// The Open Hymnal Project (openhymnal.org) explicitly places its compilation,
// indices and data files in the public domain, which makes it the safe default.
// This script does not decide for you — it records `source` on every hymn so
// the provenance travels with the data.
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error('usage: node scripts/import-hymns.js <input.json> [--format auto|ghs|songdata|generic] [--out <file>]');
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const outPath = path.resolve(flag('out', 'src/hymn-bank.json'));
let format = flag('format', 'auto');

const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
// Datasets ship either a bare array or an object wrapping one.
const list = Array.isArray(raw)
  ? raw
  : (raw.hymns || raw.songs || raw.data || Object.values(raw).find(Array.isArray) || []);

if (!list.length) {
  console.error('No records found in input.');
  process.exit(1);
}

if (format === 'auto') {
  const s = list[0];
  if ('verses' in s && Array.isArray(s.verses) && typeof s.verses[0] === 'string') format = 'ghs';
  else if ('verses' in s && Array.isArray(s.verses) && Array.isArray(s.verses[0])) format = 'songdata';
  else format = 'generic';
  console.log(`[import] detected format: ${format}`);
}

const slug = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// A stanza's text may arrive as one blob with newlines, or as an array of
// lines. Normalise to an array of trimmed, non-empty lines either way.
const toLines = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/))
  .map(l => String(l).trim())
  .filter(Boolean);

function convert(rec, i) {
  let title, author, year, meter, blocks = [];

  if (format === 'ghs') {
    // { number, title, verses: [string], chorus: string|false, category }
    title = rec.title || `Hymn ${rec.number ?? i + 1}`;
    author = rec.author || '';
    meter = rec.meter || '';
    blocks = toLines0(rec.verses).map((v, n) => ({ label: `Verse ${n + 1}`, lines: toLines(v) }));
    if (rec.chorus && rec.chorus !== false) {
      // Chorus sits after verse 1, which is how it is actually sung.
      blocks.splice(1, 0, { label: 'Chorus', lines: toLines(rec.chorus) });
    }
  } else if (format === 'songdata') {
    // { id, title, author, meter, verses: [[line]], chorus: [line] }
    title = rec.title || `Hymn ${i + 1}`;
    author = rec.author || '';
    meter = rec.meter || '';
    blocks = (rec.verses || []).map((v, n) => ({ label: `Verse ${n + 1}`, lines: toLines(v) }));
    const chorus = toLines(rec.chorus);
    if (chorus.length) blocks.splice(1, 0, { label: 'Chorus', lines: chorus });
  } else {
    // Generic: anything with a title and some stanza-ish field.
    title = rec.title || rec.name || `Hymn ${i + 1}`;
    author = rec.author || rec.writer || '';
    year = rec.year || undefined;
    meter = rec.meter || '';
    const stanzas = rec.blocks || rec.stanzas || rec.verses || [];
    blocks = stanzas.map((b, n) => ({
      label: b.label || b.name || `Verse ${n + 1}`,
      lines: toLines(b.lines || b.text || b),
    }));
  }

  blocks = blocks.filter(b => b.lines.length);

  return {
    id: slug(title) || `hymn-${i + 1}`,
    title,
    author: author || 'Unknown',
    year: year || null,
    meter: meter || '',
    source: flag('source', path.basename(input)),
    blocks,
  };
}

// GHS verses are sometimes a single string containing every verse; split on
// blank lines so each stanza becomes its own block.
function toLines0(verses) {
  if (!Array.isArray(verses)) return String(verses || '').split(/\n\s*\n/);
  return verses;
}

const out = list.map(convert).filter(h => h.blocks.length);
const dropped = list.length - out.length;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

console.log(`[import] ${out.length} hymns written to ${outPath}` + (dropped ? ` (${dropped} skipped — no lyrics)` : ''));
console.log(`[import] total blocks: ${out.reduce((n, h) => n + h.blocks.length, 0)}`);
console.log('[import] NOTE: confirm the source licence before shipping this file.');
