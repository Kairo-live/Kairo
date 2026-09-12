// One-off: adds the human-reviewed wrong-auto-sends (verified against real
// verse text + nearby transcript, see verify_wrong_sends.mjs's output) into
// each fixture's groundTruth array, as either a missed citation or an
// uncited quote — bootstrapping the "verbatim quote without citation"
// ground truth the eval harness never had. Two entries were reviewed and
// found to be GENUINE detection errors, not ground-truth gaps, and are
// deliberately excluded (see the exclude list below, and the session notes
// for why): Romans 8:10 (Enough is Enough, a clock time "04:10" misread as
// a bare verse number) and Joshua 1:18 (Meditation sermon — the actual
// quoted text is Joshua 1:8; the system sent the wrong verse).
import fs from 'fs';
import path from 'path';

const resultsPath = process.argv[2];
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

const EXCLUDE = new Set([
  'Enough is Enough|Romans 8:10|1833000',
  'THE POWER OF MEDITATION FOR LASTING CHANGE | BISHOP DAVID OYEDEPO|Joshua 1:18|68000',
  'THE POWER OF MEDITATION FOR LASTING CHANGE | BISHOP DAVID OYEDEPO|Joshua 1:18|75000',
]);

function parseRef(ref) {
  const m = ref.match(/^(.+)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return { book: m[1], chapter: Number(m[2]), verse: Number(m[3]) };
}

for (const r of results) {
  const fixturePath = path.join('server/eval/fixtures', r.name.endsWith('.json') ? r.name : `${r.name}.json`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const existingKeys = new Set(
    fixture.groundTruth.map(gt => `${gt.book}|${gt.chapter}|${gt.verse ?? gt.verseStart}`)
  );

  let added = 0;
  for (const w of r.wrongAutoSends) {
    const key = `${r.title}|${w.reference}|${w.atMs}`;
    if (EXCLUDE.has(key)) continue;
    const parsed = parseRef(w.reference);
    if (!parsed) continue;
    const gtKey = `${parsed.book}|${parsed.chapter}|${parsed.verse}`;
    if (existingKeys.has(gtKey)) continue; // already covered (e.g. a dup at a different atMs)
    fixture.groundTruth.push({
      book: parsed.book,
      chapter: parsed.chapter,
      verse: parsed.verse,
      // direct/direct-partial required the reference parser to have caught
      // an actual spoken "book chapter:verse" — a real citation. Everything
      // else (stream/verbatim/fingerprint/semantic) matched on the verse's
      // own text, with no requirement that a citation was also spoken —
      // the uncited-quote case this whole bootstrap exists for.
      kind: (w.method === 'direct' || w.method === 'direct-partial') ? 'citation' : 'quote',
      startMs: w.atMs,
      bootstrapped: true,
    });
    existingKeys.add(gtKey);
    added++;
  }
  if (added) {
    fixture.groundTruth.sort((a, b) => a.startMs - b.startMs);
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`${r.title}: +${added} ground-truth entries (now ${fixture.groundTruth.length} total)`);
  }
}
