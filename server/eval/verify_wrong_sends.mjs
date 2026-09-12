// One-off: cross-reference each eval run's "wrong auto-send" against the
// fixture's own transcript text near that timestamp, and the claimed
// verse's real KJV text — printing both side by side so a wrong-send can be
// classified as a real detection error vs. a ground-truth gap (a real
// citation/quote the single-pass extraction script missed) without needing
// to re-listen to the audio. Read-only, writes nothing.
import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2];
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const kjvArr = JSON.parse(fs.readFileSync('databases/bibles/kjv.json', 'utf8').replace(/^﻿/, ''));
const kjv = new Map(kjvArr.map(b => [b.name, b.chapters]));

function verseText(ref) {
  // ref like "Isaiah 1:19" or "2 Corinthians 10:3"
  const m = ref.match(/^(.+)\s+(\d+):(\d+)$/);
  if (!m) return '(unparseable ref)';
  const [, book, ch, vs] = m;
  const chapters = kjv.get(book);
  if (!chapters) return `(no book "${book}")`;
  const chapter = chapters[Number(ch) - 1];
  if (!chapter) return '(no chapter)';
  return (chapter[Number(vs) - 1] || '(no verse)').replace(/\{[^}]*\}/g, '').trim();
}

for (const r of results) {
  const fixturePath = path.join('server/eval/fixtures', r.name.endsWith('.json') ? r.name : `${r.name}.json`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (!r.wrongAutoSends.length) continue;
  console.log(`\n\n########## ${r.title} ##########`);
  for (const w of r.wrongAutoSends) {
    const nearby = fixture.transcript.filter(c => Math.abs(c.startMs - w.atMs) <= 20000);
    console.log(`\n--- ${(w.atMs/1000).toFixed(0)}s  ${w.reference}  (method=${w.method}) ---`);
    console.log(`VERSE TEXT: ${verseText(w.reference)}`);
    console.log(`TRANSCRIPT NEARBY:`);
    nearby.forEach(c => console.log(`  [${(c.startMs/1000).toFixed(0)}s] ${c.text}`));
  }
}
