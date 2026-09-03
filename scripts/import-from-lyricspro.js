#!/usr/bin/env node
// Copy songs out of a local LyricsPro install into Kairo's operator Song
// Library (server/songs.js → databases/songs/songs.json).
//
// LyricsPro stores each song as one flat `lyrics` TEXT blob in a SQLite DB
// under its Electron userData dir. Kairo wants ordered { label, lines[] }
// blocks and one of three fixed categories (worship/praise/hymn). This script
// bridges the two: it reads rows with the sqlite3 CLI (no native module
// needed), splits each blob into blocks, picks a category, and either POSTs to
// a running Kairo server or appends straight to songs.json.
//
// Usage:
//   node scripts/import-from-lyricspro.js "<title substring>" [options]
//   node scripts/import-from-lyricspro.js --all [options]
//
//   --all                   import every song in the LyricsPro DB
//   --list                  show matching LyricsPro songs and exit
//   --id <lyricspro-id>      match by exact song id instead of title
//   --db <path>             LyricsPro songs.db
//                           (default: ~/Library/Application Support/Electron/songs.db,
//                            then …/LyricsPro/songs.db)
//   --category worship|praise|hymn   force the category (default: auto-detect)
//   --server <url>          POST to a running Kairo server (e.g. http://localhost:7777)
//   --file <path>           songs.json to append to
//                           (default: databases/songs/songs.json)
//   --dry-run               print what would be written, write nothing
//   --force                 add even if a same title+author song already exists
//
// Auto category: LyricsPro's is_hymn flag wins; otherwise a copyright year
// before 1930 or a "public domain" notice → hymn; everything else → worship
// (the safe default — override with --category when it's really praise).
//
// ── Licensing, read this first ───────────────────────────────────────────
// This tool is for pulling YOUR OWN downloaded songs into YOUR OWN Kairo
// library on the same machine. Most of LyricsPro's catalogue is modern,
// copyrighted worship music (note the `ccli` column). Do NOT commit the
// resulting songs.json to a shared repo or ship it inside a Kairo build —
// that redistributes lyrics you are not licensed to redistribute. Bundling
// is only safe for public-domain texts (see scripts/import-hymns.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ── args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (name) => args.includes('--' + name);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const positional = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') &&
    !['all', 'list', 'dry-run', 'force'].includes(args[i - 1].slice(2))));

const CATEGORIES = ['worship', 'praise', 'hymn'];

function die(msg) { process.stderr.write(`[lp-import] ERROR: ${msg}\n`); process.exit(1); }
function log(msg) { process.stdout.write(`[lp-import] ${msg}\n`); }

const forcedCategory = flag('category');
if (forcedCategory && !CATEGORIES.includes(forcedCategory)) {
  die(`--category must be one of ${CATEGORIES.join('/')}`);
}

// ── locate the LyricsPro DB ──────────────────────────────────────────────
function resolveDb() {
  const explicit = flag('db');
  if (explicit) return path.resolve(explicit);
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  const candidates = [
    path.join(support, 'Electron', 'songs.db'),   // unpackaged run (app name = "Electron")
    path.join(support, 'LyricsPro', 'songs.db'),  // packaged / named build
    path.join(support, 'lyricspro', 'songs.db'),
  ];
  return candidates.find(fs.existsSync) || candidates[0];
}

const DB = resolveDb();
if (!fs.existsSync(DB)) {
  die(`no LyricsPro songs.db found (looked at ${DB}).\n` +
      `        Launch LyricsPro, sign in, and download at least one song first,\n` +
      `        or pass --db <path>.`);
}

// ── query via the sqlite3 CLI ────────────────────────────────────────────
function query(sql) {
  let out;
  try {
    out = execFileSync('sqlite3', ['-json', '-readonly', DB, sql], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    die(`sqlite3 query failed: ${e.stderr || e.message}`);
  }
  out = out.trim();
  return out ? JSON.parse(out) : [];
}

const esc = (s) => String(s).replace(/'/g, "''");
const COLS = 'id,title,artist,lyrics,is_hymn,copyright,ccli,metadata';

let rows;
if (has('all')) {
  rows = query(`SELECT ${COLS} FROM songs ORDER BY title COLLATE NOCASE`);
} else if (flag('id')) {
  rows = query(`SELECT ${COLS} FROM songs WHERE id = '${esc(flag('id'))}'`);
} else {
  const term = positional[0];
  if (!term) die('give a title substring, --id <lyricspro-id>, or --all. See the header for usage.');
  rows = query(`SELECT ${COLS} FROM songs
                WHERE title LIKE '%${esc(term)}%' COLLATE NOCASE
                ORDER BY length(title) ASC`);
}

if (!rows.length) die('no matching song in LyricsPro.');

if (has('list')) {
  for (const r of rows) {
    log(`${r.title}${r.artist ? '  —  ' + r.artist : ''}` +
        `${r.is_hymn ? '  [hymn]' : ''}${r.ccli ? '  CCLI ' + r.ccli : ''}   (${r.id})`);
  }
  log(`${rows.length} song(s).`);
  process.exit(0);
}

if (!has('all') && rows.length > 1) {
  log(`${rows.length} title matches — importing the closest. Use --list / --id to disambiguate, or --all for everything.`);
  rows = rows.slice(0, 1);
}

// ── parse a lyrics blob into blocks ──────────────────────────────────────
const HEADER_RE = /^\s*\[?\s*(verse|chorus|refrain|bridge|pre[\s-]?chorus|prechorus|intro|outro|tag|ending|interlude|coda|vamp|hook)\s*(\d+)?\s*\]?\s*:?\s*$/i;
// Lines that are really the CCLI / copyright trailer, not lyrics.
const TRAILER_RE = /^\s*(ccli|©|\(c\)\s|copyright\b|words and music|music and words|administ|used by permission|all rights reserved|public domain\b)/i;

function titleCaseLabel(kind, num) {
  const k = kind.toLowerCase().replace(/[\s-]/g, '');
  const pretty = {
    verse: 'Verse', chorus: 'Chorus', refrain: 'Refrain', bridge: 'Bridge',
    prechorus: 'Pre-Chorus', intro: 'Intro', outro: 'Outro', tag: 'Tag',
    ending: 'Ending', interlude: 'Interlude', coda: 'Coda', vamp: 'Vamp', hook: 'Hook',
  }[k] || (kind[0].toUpperCase() + kind.slice(1));
  return num ? `${pretty} ${num}` : pretty;
}

function toBlocks(raw) {
  const chunks = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')
    .split(/\n\s*\n+/)
    .map(c => c.split('\n').map(l => l.trim()).filter(Boolean))
    .filter(lines => lines.length);

  const blocks = [];
  const seen = new Map();       // normalised body → label, to name repeats "Chorus"
  let verseNum = 0;

  for (const lines of chunks) {
    let label = null;
    let body = lines;

    const m = lines[0].match(HEADER_RE);
    if (m) { label = titleCaseLabel(m[1], m[2]); body = lines.slice(1); }
    body = body.filter(l => !TRAILER_RE.test(l));
    if (!body.length) continue;

    const key = body.join('\n').toLowerCase().replace(/[^a-z0-9\n ]/g, '');
    if (!label) {
      if (seen.has(key)) label = seen.get(key);
      else { verseNum += 1; label = `Verse ${verseNum}`; }
    }
    if (!seen.has(key)) seen.set(key, label);
    blocks.push({ label, lines: body });
  }
  return blocks;
}

// ── convert one LyricsPro row → one Kairo record ─────────────────────────
function detectYear(row, meta) {
  if (Number.isFinite(meta.year)) return meta.year;
  const s = `${meta.year || ''} ${row.copyright || ''}`;
  const m = s.match(/\b(1[6-9]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : null;
}

function detectCategory(row, year) {
  if (forcedCategory) return forcedCategory;
  if (row.is_hymn) return 'hymn';
  if (/public domain/i.test(row.copyright || '')) return 'hymn';
  if (year && year < 1930) return 'hymn';
  // No reliable praise-vs-worship signal in the data — worship is the default,
  // operator flips the odd one in-app or via --category.
  return 'worship';
}

function convert(row) {
  let meta = {};
  try { meta = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* ignore */ }
  const blocks = toBlocks(row.lyrics);
  if (!blocks.length) return null;
  const year = detectYear(row, meta);
  return {
    title: row.title || 'Untitled',
    author: row.artist || '',
    year: year || null,
    themeId: null,
    category: detectCategory(row, year),
    blocks,
  };
}

const records = [];
let skipped = 0;
for (const row of rows) {
  const rec = convert(row);
  if (rec) records.push(rec);
  else { skipped += 1; if (!has('all')) die('that song has no usable lyrics text in LyricsPro.'); }
}

log(`${records.length} song(s) ready` + (skipped ? `, ${skipped} skipped (no lyrics)` : ''));
if (!has('all')) {
  const r = records[0];
  log(`"${r.title}"${r.author ? ' — ' + r.author : ''}`);
  log(`category: ${r.category}${forcedCategory ? ' (forced)' : ' (auto)'}${r.year ? `,  year: ${r.year}` : ''}`);
  log(`blocks: ${r.blocks.map(b => b.label).join(', ')}`);
} else {
  const byCat = records.reduce((m, r) => (m[r.category] = (m[r.category] || 0) + 1, m), {});
  log(`categories: ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

if (has('dry-run')) {
  process.stdout.write(JSON.stringify(has('all') ? records : records[0], null, 2) + '\n');
  process.exit(0);
}

// ── write: POST to a server, or append to the JSON file ─────────────────
async function viaServer(base) {
  const url = base.replace(/\/$/, '') + '/api/songs';
  let ok = 0;
  for (const rec of records) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    });
    if (!res.ok) { log(`  ! ${rec.title}: server ${res.status}`); continue; }
    ok += 1;
  }
  log(`added ${ok}/${records.length} via ${url}`);
}

function viaFile(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let list = [];
  try { list = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { list = []; }
  if (!Array.isArray(list)) list = [];

  const key = (s) => `${(s.title || '').trim().toLowerCase()} ${(s.author || '').trim().toLowerCase()}`;
  const existing = new Set(list.map(key));

  let added = 0, dupes = 0;
  for (const rec of records) {
    if (existing.has(key(rec)) && !has('force')) { dupes += 1; continue; }
    const song = { id: crypto.randomUUID(), ...rec };
    list.push(song);
    existing.add(key(rec));
    added += 1;
  }
  fs.writeFileSync(target, JSON.stringify(list, null, 2) + '\n');
  log(`${added} added` + (dupes ? `, ${dupes} already present (skipped — use --force to duplicate)` : '') +
      `  →  ${file}  (${list.length} songs total)`);
  log('If the Kairo server is running, restart it — it rewrites this file from memory on its next edit.');
}

(async () => {
  if (flag('server')) await viaServer(flag('server'));
  else viaFile(flag('file', 'databases/songs/songs.json'));
})();
