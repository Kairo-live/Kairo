// KAIRO — Offline detection-accuracy eval harness
//
// Feeds a real sermon's caption/transcript text through the SAME
// handleTranscriptSegment() the live app uses (via server.js's module
// boundary — see server.js's own comment near `require.main === module`),
// in simulated real-time-chunked fashion approximating Deepgram's actual
// interim/final cadence, and scores what got broadcast against a
// human-spot-checked ground-truth fixture.
//
// Usage:
//   KAIRO_EVAL_MODE=1 node server/eval/run_eval.js [fixture-name ...]
//   KAIRO_EVAL_MODE=1 node server/eval/run_eval.js                    # all fixtures
'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const RESULTS_DIR = path.join(__dirname, 'results');

// Ground-truth match window — a detection landing within this many ms of
// the ground-truth entry's own transcript position counts as a match for
// that entry. Generous enough to cover interim-vs-final timing jitter and
// the harness's own simulated chunk pacing, not so wide it'd credit an
// unrelated later mention of the same verse.
const MATCH_WINDOW_MS = 30000;

function loadFixture(name) {
  const p = path.join(FIXTURES_DIR, name.endsWith('.json') ? name : `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function groundTruthVerseKeys(entry) {
  // Normalizes a ground-truth entry (single verse / range / chapter-only)
  // into the set of "book|chapter|verse" keys it represents, for matching
  // against broadcast detections (which are always a single resolved verse).
  if (entry.verse != null) return [`${entry.book}|${entry.chapter}|${entry.verse}`];
  if (entry.verseStart != null) {
    const keys = [];
    for (let v = entry.verseStart; v <= entry.verseEnd; v++) keys.push(`${entry.book}|${entry.chapter}|${v}`);
    return keys;
  }
  if (entry.ranges) {
    const keys = [];
    for (const r of entry.ranges) for (let v = r.start; v <= r.end; v++) keys.push(`${entry.book}|${entry.chapter}|${v}`);
    return keys;
  }
  return []; // bare chapter citation, no specific verse to match against — informational only
}

// Splits an utterance into growing-prefix word slices (3-8 words per step)
// to approximate Deepgram's real interim cadence, then one final call with
// the full text. Models Deepgram's cadence specifically — a batch-style
// engine that re-transcribes from scratch each partial (no stable-prefix
// guarantee) would need its own simulation shape, not this one.
function chunkUtterance(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const step = 3 + Math.floor(Math.random() * 6); // 3-8 words
    i = Math.min(words.length, i + step);
    chunks.push(words.slice(0, i).join(' '));
  }
  return chunks;
}

async function runFixture(server, fixture) {
  server.resetDetectionSession();

  // Detections are timestamped against the ORIGINAL AUDIO's own timeline
  // (the current cue's startMs from the fixture), not harness wall-clock
  // time — a real, confirmed bug caught by the first full run: the harness
  // compresses an hour of audio into a few minutes of real processing time
  // (only a 15ms pacing delay between chunks, not real speaking pace), so
  // comparing wall-clock elapsed time against the ground truth's real
  // audio-position timestamps meant NOTHING could ever fall within the
  // match window even when the detection log showed clearly correct sends
  // (e.g. Deuteronomy 11:23/24/25 all landing "→ viewer" at exactly the
  // ground-truth verses, yet scored as 0% recall). currentCueMs tracks
  // "which point in the ORIGINAL audio are we currently processing" —
  // this is what both ground truth and detections need to share.
  let currentCueMs = 0;
  let cueFedAt = 0;      // wall clock when the current cue started being fed
  const detections = []; // { verseKey, method, target, atMs, pipelineMs }
  const listener = (msg) => {
    if (msg.type !== 'detection' || !msg.verses?.length) return;
    const v = msg.verses[0];
    detections.push({
      verseKey: `${v.book}|${v.chapter}|${v.verse}`,
      reference: v.reference,
      method: msg.method,
      target: msg.target,
      corrected: !!msg.corrected,
      atMs: currentCueMs,
      // Processing delay: from the moment this cue's words started arriving to
      // the broadcast (harness pacing is compressed, so this is the pipeline's
      // own cost, not speech time).
      pipelineMs: Math.round(performance.now() - cueFedAt),
    });
  };
  server.onBroadcast(listener);
  // onBroadcast has no remove — harmless here (one process per run_eval.js
  // invocation, not a long-lived server), but noted for anyone reusing this
  // pattern in a long-lived process.

  for (const cue of fixture.transcript) {
    currentCueMs = cue.startMs;
    cueFedAt = performance.now();
    const chunks = chunkUtterance(cue.text);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await server.handleTranscriptSegment(chunks[i], isLast, 0.9, isLast);
      // Small real delay between chunks so wall-clock-dependent logic
      // INSIDE the real detection code (SAME_BOOK_WINDOW_MS decay,
      // CORRECTION_IMMUNITY_MS, etc. — genuine Date.now() calls in
      // server.js/detection_scoring.js) sees real elapsed time, not zero —
      // matches the plan's "real-time pacing, not a virtual clock"
      // decision. This is independent of currentCueMs above, which is
      // only for SCORING (comparing against the original audio position),
      // not for the live decision logic's own timing.
      await new Promise(r => setTimeout(r, 15));
    }
  }

  return detections;
}

function scoreFixture(fixture, detections) {
  const viewerDetections = detections.filter(d => d.target === 'viewer');
  const truePositives = [];
  const falseNegatives = [];
  const matchedDetectionIdx = new Set();

  for (const gt of fixture.groundTruth) {
    const keys = new Set(groundTruthVerseKeys(gt));
    if (!keys.size) continue; // bare chapter citation, nothing to match
    let matched = null;
    for (let i = 0; i < viewerDetections.length; i++) {
      if (matchedDetectionIdx.has(i)) continue;
      const d = viewerDetections[i];
      if (!keys.has(d.verseKey)) continue;
      if (Math.abs(d.atMs - gt.startMs) > MATCH_WINDOW_MS) continue;
      matched = { gt, detection: d, idx: i };
      break;
    }
    if (matched) { truePositives.push(matched); matchedDetectionIdx.add(matched.idx); }
    else falseNegatives.push(gt);
  }

  const groundTruthKeySet = new Set();
  for (const gt of fixture.groundTruth) for (const k of groundTruthVerseKeys(gt)) groundTruthKeySet.add(k);

  // A bare-chapter citation ("turn to Ephesians 5", no verse yet) has no
  // specific verse to compare against — groundTruthVerseKeys() correctly
  // returns nothing for it. But that meant ANY verse legitimately detected
  // afterward while the preacher actually reads that chapter (Ephesians
  // 5:22, 5:32, ...) got counted as a wrong auto-send purely because the
  // ground truth never named a specific verse — a real, confirmed bug in
  // this scoring code (not the detection engine): the first full run
  // flagged several such "wrong sends" that were plausible, unverifiable
  // reads of a chapter that WAS genuinely cited, just not down to the
  // verse. Detections in a bare-cited chapter within 10 minutes of the
  // citation are excluded from wrongAutoSends entirely — neither a true
  // positive (we don't know the intended verse) nor a false one.
  const bareChapterWindows = fixture.groundTruth
    .filter(gt => gt.verse == null && gt.verseStart == null && !gt.ranges)
    .map(gt => ({ book: gt.book, chapter: gt.chapter, startMs: gt.startMs }));
  const inBareChapterWindow = (d) => bareChapterWindows.some(w =>
    w.book === d.verseKey.split('|')[0] && String(w.chapter) === d.verseKey.split('|')[1]
    && d.atMs >= w.startMs && d.atMs - w.startMs <= 10 * 60 * 1000);

  const wrongAutoSends = viewerDetections.filter((d, i) =>
    !matchedDetectionIdx.has(i) && !groundTruthKeySet.has(d.verseKey) && !inBareChapterWindow(d));

  const total = truePositives.length + falseNegatives.length;
  const recall = total ? truePositives.length / total : null;
  const precision = viewerDetections.length ? (viewerDetections.length - wrongAutoSends.length) / viewerDetections.length : null;

  // Possible Matches: a verse missed on screen may still have been offered to
  // the operator there — the useful kind of miss. Busyness is suggestions per hour.
  const suggestions = detections.filter(d => d.target === 'suggestions');
  const offered = falseNegatives.filter(gt => {
    const keys = new Set(groundTruthVerseKeys(gt));
    return suggestions.some(d => keys.has(d.verseKey) && Math.abs(d.atMs - gt.startMs) <= MATCH_WINDOW_MS);
  });
  const hours = Math.max(1, fixture.transcript.at(-1)?.startMs || 0) / 3600000;
  const suggestionsPerHour = suggestions.length / hours;

  return { truePositives, falseNegatives, wrongAutoSends, viewerDetectionCount: viewerDetections.length, recall, precision, missedButOffered: offered.length, suggestionCount: suggestions.length, suggestionsPerHour, hours };
}

// Seconds-to-screen proxies for the matched verses. speechDelay: how much of
// the sermon had been spoken since the ground-truth moment when the verse went
// up (cue resolution — cues are ~5-10s long, so read it as "within the same /
// next cue"). pipeline: processing time after the words arrived.
function speedStats(results) {
  const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  const speech = [], pipe = [];
  for (const r of results) for (const tp of r.truePositives) {
    speech.push(Math.max(0, tp.detection.atMs - tp.gt.startMs));
    if (typeof tp.detection.pipelineMs === 'number') pipe.push(tp.detection.pipelineMs);
  }
  return { speechDelayMedianS: q(speech, 0.5) / 1000, speechDelayP90S: q(speech, 0.9) / 1000, pipelineMedianMs: q(pipe, 0.5), pipelineP90Ms: q(pipe, 0.9) };
}

async function main() {
  if (!process.env.KAIRO_EVAL_MODE) {
    console.error('Set KAIRO_EVAL_MODE=1 — this avoids binding the real HTTP port / polling OBS-ProPresenter.');
    process.exit(1);
  }
  const server = require('../server.js');
  console.log('[Eval] Spawning detection worker...');
  server.spawnDetectionWorker();
  await server.workerReadyPromise;
  console.log('[Eval] Worker ready.');

  const args = process.argv.slice(2);
  const runsIdx = args.indexOf('--runs');
  const runs = runsIdx >= 0 ? Math.max(1, parseInt(args[runsIdx + 1], 10) || 1) : 1;
  const requested = args.filter((a, i) => a !== '--runs' && i !== runsIdx + 1);
  const names = requested.length ? requested : fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json'));

  const perRun = [];
  for (let run = 1; run <= runs; run++) {
  if (runs > 1) console.log(`\n[Eval] ######## run ${run} of ${runs} ########`);
  const allResults = [];
  for (const name of names) {
    const fixture = loadFixture(name);
    console.log(`\n[Eval] === ${fixture.title || name} ===`);
    const detections = await runFixture(server, fixture);
    const score = scoreFixture(fixture, detections);
    allResults.push({ name, title: fixture.title, ...score });

    console.log(`  recall:    ${score.recall == null ? 'n/a' : (score.recall * 100).toFixed(1) + '%'}  (${score.truePositives.length}/${score.truePositives.length + score.falseNegatives.length})`);
    console.log(`  precision: ${score.precision == null ? 'n/a' : (score.precision * 100).toFixed(1) + '%'}  (${score.viewerDetectionCount - score.wrongAutoSends.length}/${score.viewerDetectionCount} viewer sends correct)`);
    console.log(`  wrong auto-sends: ${score.wrongAutoSends.length}`);
    console.log(`  missed on screen but offered in Possible Matches: ${score.missedButOffered}/${score.falseNegatives.length}; Possible Matches entries: ${score.suggestionCount} (${score.suggestionsPerHour.toFixed(0)}/hour)`);
    if (score.falseNegatives.length) {
      console.log('  missed:');
      score.falseNegatives.forEach(gt => console.log(`    ${(gt.startMs/1000).toFixed(0)}s  ${gt.book} ${gt.chapter}${gt.verse != null ? ':' + gt.verse : ''}`));
    }
    if (score.wrongAutoSends.length) {
      console.log('  wrong sends:');
      score.wrongAutoSends.forEach(d => console.log(`    ${(d.atMs/1000).toFixed(0)}s  ${d.reference} (method=${d.method})`));
    }
  }

  const totalTP = allResults.reduce((s, r) => s + r.truePositives.length, 0);
  const totalGT = allResults.reduce((s, r) => s + r.truePositives.length + r.falseNegatives.length, 0);
  const totalWrong = allResults.reduce((s, r) => s + r.wrongAutoSends.length, 0);
  const totalViewer = allResults.reduce((s, r) => s + r.viewerDetectionCount, 0);
  console.log(`\n[Eval] === Aggregate across ${allResults.length} sermon(s) ===`);
  console.log(`  recall:    ${totalGT ? ((totalTP / totalGT) * 100).toFixed(1) + '%' : 'n/a'}  (${totalTP}/${totalGT})`);
  console.log(`  precision: ${totalViewer ? (((totalViewer - totalWrong) / totalViewer) * 100).toFixed(1) + '%' : 'n/a'}  (${totalViewer - totalWrong}/${totalViewer})`);
  console.log(`  total wrong auto-sends: ${totalWrong}`);
  const totalMissed = totalGT - totalTP, offered = allResults.reduce((s, r) => s + r.missedButOffered, 0);
  const hours = allResults.reduce((s, r) => s + r.hours, 0), sugg = allResults.reduce((s, r) => s + r.suggestionCount, 0);
  console.log(`  missed on screen but offered in Possible Matches: ${offered}/${totalMissed}; Possible Matches entries: ${(sugg / hours).toFixed(0)}/hour`);
  const sp = speedStats(allResults);
  console.log(`  time to screen (speech time since the quote/citation): median ${sp.speechDelayMedianS?.toFixed(1)}s, 90th pct ${sp.speechDelayP90S?.toFixed(1)}s (cue resolution)`);
  console.log(`  pipeline delay after the words arrived: median ${sp.pipelineMedianMs}ms, 90th pct ${sp.pipelineP90Ms}ms`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\n[Eval] Full results -> ${outPath}`);
  perRun.push({ recall: totalGT ? totalTP / totalGT : 0, precision: totalViewer ? (totalViewer - totalWrong) / totalViewer : 0, wrong: totalWrong, results: allResults });
  }

  // Several runs: the harness's concurrent async paths make single verses flip
  // between runs, so one run can't judge a small change. Report the spread and
  // exactly which verses flipped.
  if (runs > 1) {
    const fmt = (xs) => `mean ${(100 * xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}% (min ${(100 * Math.min(...xs)).toFixed(1)}, max ${(100 * Math.max(...xs)).toFixed(1)})`;
    console.log(`\n[Eval] === ${runs} runs ===`);
    console.log(`  recall:    ${fmt(perRun.map(r => r.recall))}`);
    console.log(`  precision: ${fmt(perRun.map(r => r.precision))}`);
    console.log(`  wrong sends: ${perRun.map(r => r.wrong).join(', ')}`);
    const caughtIn = new Map();
    for (const r of perRun) for (const f of r.results) for (const tp of f.truePositives) {
      const k = `${f.name} | ${tp.gt.book} ${tp.gt.chapter}:${tp.gt.verse ?? tp.gt.verseStart}`;
      caughtIn.set(k, (caughtIn.get(k) || 0) + 1);
    }
    const flaky = [...caughtIn].filter(([, n]) => n < runs);
    console.log(`  verses caught in some runs but not all (${flaky.length}):`);
    flaky.forEach(([k, n]) => console.log(`    ${k}  (${n}/${runs})`));
  }

  process.exit(0);
}

main().catch(err => { console.error('[Eval] fatal:', err); process.exit(1); });
