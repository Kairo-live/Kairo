// KAIRO — Regression tests for two real incidents (2026-09-23):
//
// 1. Correction-collision guard: "Ephesians 2:10" was cited, the preacher
//    actually read Jeremiah 17:7-8 ("tree planted by the...waters, never
//    dries"), and the mis-citation corrector landed on Psalm 1:3 instead —
//    the same near-duplicate-phrasing collision this codebase has
//    repeatedly hardened against elsewhere, now hit via the plain
//    correction path (maybeCorrectMiscitation), which had no such guard.
//
// 2. Bare chapter-only citation ("Jeremiah chapter 17" with no verse) must
//    resolve to the specific verse via the preacher's next few words —
//    owner: "when he calls a chapter, but no verse, it is our
//    responsibility to look for the correct verse based on his next few
//    keywords."
//
// Plain script, not node:test — see ambiguous_refs.test.js's own comment
// for why (server.js's orphan-parent-process watchdog setInterval defeats
// node:test's process-isolation teardown even though every assertion
// passes).
//
//   KAIRO_EVAL_MODE=1 node server/chapter_keyword_and_correction_collision.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-chapter-keyword-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
fs.writeFileSync(path.join(appDataDir, 'settings.json'), JSON.stringify({ useUnifiedScoring: true }));
process.env.KAIRO_APP_DATA_DIR = appDataDir;

const server = require('./server');
const { referenceContext } = require('./reference_parser');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✔ ${name}`);
  } catch (err) {
    fail++;
    console.log(`✖ ${name}`);
    console.log(`  ${err.message}`);
  }
}

async function main() {
  server.spawnDetectionWorker();
  await server.workerReadyPromise;

  await test('a bare chapter citation with no verse resolves to the specific verse via the next words spoken in the SAME utterance', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Genesis 1:27's real text, right after naming the chapter with no verse.
    await server.handleTranscriptSegment(
      'Turn to Genesis chapter one. So God created man in his own image, in the image of God created he him; male and female created he them.',
      true, 0.9, true
    );
    await new Promise(r => setTimeout(r, 50));
    const sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Genesis 1:27');
    assert.ok(sent, 'Genesis 1:27 should have been resolved and reached viewer');
  });

  await test('a bare chapter citation resolves on a LATER segment once the reading catches up, and does not fire on unrelated narration', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('Please turn with me to Deuteronomy chapter thirty one.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 30));
    // Unrelated filler — must NOT trigger a false resolve.
    await server.handleTranscriptSegment('Let us just take a moment before we continue.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 30));
    const falsePositive = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.book === 'Deuteronomy');
    assert.ok(!falsePositive, 'unrelated filler must not resolve to a Deuteronomy verse');

    // Deuteronomy 31:6's real text, arriving on a later segment.
    await server.handleTranscriptSegment(
      'Be strong and of a good courage, fear not, nor be afraid of them: for the LORD thy God, he it is that doth go with thee.',
      true, 0.9, true
    );
    await new Promise(r => setTimeout(r, 50));
    const sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Deuteronomy 31:6');
    assert.ok(sent, 'Deuteronomy 31:6 should have resolved once the real text arrived');
  });

  await test('correction refuses to fire when a comparably strong different-book alternate exists (Jeremiah 17:8 vs Psalm 1:3 collision)', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Establish a citation to something unrelated — "Ephesians 2:10".
    await server.handleTranscriptSegment('Ephesians chapter two and verse ten.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    const cited = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Ephesians 2:10');
    assert.ok(cited, 'setup: Ephesians 2:10 must have been cited first');

    // Now read text that's genuinely ambiguous between Jeremiah 17:7-8 and
    // Psalm 1:3 (both describe a tree planted by water, never withering).
    await server.handleTranscriptSegment(
      'For he shall be as a tree planted by the waters, and shall not see when heat cometh, and his leaf shall be green.',
      true, 0.9, true
    );
    await new Promise(r => setTimeout(r, 80));

    const wrongCorrection = broadcasts.some(b =>
      b.corrected && b.verses?.[0]?.reference === 'Psalms 1:3');
    assert.ok(!wrongCorrection, 'must NOT have "corrected" to Psalms 1:3 — genuine ambiguity should block the correction');
  });

  await test('a bare chapter citation does not lock onto a weak wrong guess when the real verse number arrives moments later (Matthew 11:28, real incident)', async () => {
    server.resetDetectionSession();
    referenceContext.reset(); // defensive: guards against any straggling async callback from the previous test's still-in-flight searches
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Realistic mid-sermon context — the real incident never happened at a
    // cold start, there was always a prior citation moments before.
    await server.handleTranscriptSegment('John three verse 31 say, he that is above is above all.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));

    await server.handleTranscriptSegment('In Matthew 11, say come to me.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    // A weak/wrong guess reaching the viewer here would be the bug —
    // real incident: this used to land on Matthew 11:17.
    const wrongOnAir = broadcasts.some(b => b.target === 'viewer' && /^Matthew 11:(?!28)/.test(b.verses?.[0]?.reference || ''));
    assert.ok(!wrongOnAir, `a weak guess must not reach viewer before the real verse arrives — got: ${broadcasts.map(b => b.target === 'viewer' && b.verses?.[0]?.reference).filter(Boolean).join(', ')}`);

    await server.handleTranscriptSegment('28, all you that are in pain, I will solve the problem.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 80));
    const sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Matthew 11:28');
    assert.ok(sent, `expected Matthew 11:28 to resolve once the real verse number arrived — got: ${broadcasts.map(b => b.target === 'viewer' && b.verses?.[0]?.reference).filter(Boolean).join(', ')}`);
  });

  await test('a bare "John" citation continues the recently-active numbered epistle instead of defaulting to the Gospel (real, repeated incident)', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('First John four verse four say, who is in you is greater than the devils in the world.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    const cited = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === '1 John 4:4');
    assert.ok(cited, 'setup: 1 John 4:4 must have been cited first');

    await server.handleTranscriptSegment('But hear this, say John five verse 19 have said, the world where you are is under power controlled by the evil one.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    const sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === '1 John 5:19');
    const wrongGospel = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'John 5:19');
    assert.ok(sent, `expected "John five verse 19" to resolve to 1 John 5:19 given the recently-active context — got: ${broadcasts.map(b => b.target === 'viewer' && b.verses?.[0]?.reference).filter(Boolean).join(', ')}`);
    assert.ok(!wrongGospel, 'must not have defaulted to the Gospel of John');
  });

  await test('a bare "John" citation with NO recent numbered-John context still correctly defaults to the Gospel (regression check)', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('For God so loved the world, John three sixteen.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    const sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'John 3:16');
    assert.ok(sent, `expected John 3:16 (Gospel) with no prior numbered-John context — got: ${broadcasts.map(b => b.target === 'viewer' && b.verses?.[0]?.reference).filter(Boolean).join(', ')}`);
  });

  await test('a genuinely valid Gospel citation shortly after 1 John is NOT wrongly rewritten to an invalid numbered-epistle reference (real incident: "John 3:31" after "1 John 5:19")', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('First John four verse four say, who is in you is greater than the devils in the world.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    await server.handleTranscriptSegment('But hear this, say John five verse 19 have said, the world where you are is under power controlled by the evil one.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));

    // 1 John chapter 3 only has 24 verses — "1 John 3:31" is not a real
    // reference. Real regression: this used to silently vanish (rewritten
    // to a nonexistent verse, directLookup failed, nothing sent) instead of
    // correctly landing on the Gospel.
    await server.handleTranscriptSegment('But John three verse 31 say, he that is above is above what?', true, 0.9, true);
    await new Promise(r => setTimeout(r, 80));
    const sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'John 3:31');
    const wrongInvalid = broadcasts.some(b => b.verses?.[0]?.reference === '1 John 3:31');
    assert.ok(!wrongInvalid, 'must never produce the nonexistent "1 John 3:31"');
    assert.ok(sent, `expected the valid Gospel citation "John 3:31" to still resolve — got: ${broadcasts.map(b => b.target === 'viewer' && b.verses?.[0]?.reference).filter(Boolean).join(', ')}`);
  });

  await test('re-reading verse 26 does not prematurely fuzzy-advance to 27 on shared generic words (Genesis 1:26/27, real recurring incident)', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('Genesis one from verse 26 to 28.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    // The preacher re-emphasizing verse 26's own content in his own words —
    // shares "man"/"own" with verse 27's real opening ("So God created man
    // in his own image") purely by coincidence.
    await server.handleTranscriptSegment('Say, let us make man in our own word, image.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 80));
    const wrongAdvance = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Genesis 1:27');
    assert.ok(!wrongAdvance, 'must not have prematurely advanced to Genesis 1:27');
  });

  await test('a stale joined-segment re-parse of an already-resolved bare chapter does not trigger a fresh, wrong guess (Romans 10:14, real incident)', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('In Romans 10, whosoever call upon the name of the Lord shall be saved.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 50));
    const cited = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Romans 10:13');
    assert.ok(cited, 'setup: Romans 10:13 must have been resolved first');

    // Unrelated content that happens to loosely echo Romans 10:14's own
    // wording ("believed"/"preacher") — must NOT trigger a fresh guess.
    await server.handleTranscriptSegment('He said a believer runs to the tower and is safe and protected.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 80));
    const wrongExtra = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Romans 10:14');
    assert.ok(!wrongExtra, 'must not have produced a fresh, wrong "Romans 10:14" guess from unrelated narration');
  });

  // Real live segmentation (app via BlackHole, 2026-09-24, runs 1 and 3):
  // Deepgram delivered the chapter AND the callout in one segment, so "28"
  // was mid-text, not the first word.
  await test('a verse callout MID-segment after a bare chapter resolves (Matthew 11:28, exact live segmentation)', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('In Matthew 11, say come to me. 28, all you that', true, 0.95, true);
    await new Promise(r => setTimeout(r, 300));
    await server.handleTranscriptSegment('are in pain, I will solve the problem. In no', true, 0.95, true);
    await new Promise(r => setTimeout(r, 300));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(sent.includes('Matthew 11:28'), `expected Matthew 11:28, got ${JSON.stringify(sent)}`);
  });

  await test('a callout that only arrives in the NEXT segment is found through the joined text (live shape B)', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('In Matthew 11, say come to me.', true, 0.95, true);
    await new Promise(r => setTimeout(r, 300));
    await server.handleTranscriptSegment('28, all you that are in pain', true, 0.95, true);
    await new Promise(r => setTimeout(r, 300));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(sent.includes('Matthew 11:28'), `expected Matthew 11:28, got ${JSON.stringify(sent)}`);
  });

  await test('a number in narration WITHOUT a trailing comma/period after a bare chapter is NOT taken as a verse ("12 disciples")', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('Turn to Matthew 11. He sent out 12 disciples to preach', true, 0.95, true);
    await new Promise(r => setTimeout(r, 300));
    const wrong = broadcasts.some(b => b.target === 'viewer' && b.verses[0].reference === 'Matthew 11:12');
    assert.ok(!wrong, 'must not treat "12 disciples" as verse 12');
  });

  // Real replay of the live run-3 segments (2026-09-24): the segment
  // "...You will never dry. Psalm one twenty five verse one and two, he say,
  // your" holds the just-read Jeremiah text AND the new citation. The
  // corrector saw strong Jeremiah 17:7 text and replaced Psalms 125:1 with a
  // verse that was already shown BEFORE the citation.
  await test('a fresh citation is not "corrected" to a verse that was already on screen before that citation (stale reading text, exact live run-3 segments)', async () => {
    server.resetDetectionSession();
    referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    const segs = [
      'Every knee shall do what? Jeremiah 17 verse seven to',
      'eight. He said blessed are those',
      'who trusted in the Lord Jesus. For you',
      'shall be like a tree planted by the side of the liver bank.',
      'You will never dry. Psalm one twenty five five verse one and two. He say, you shall be',
      'like a mountain Zion. And nobody can',
      'you away from your position. From today, prepare the barrier of',
    ];
    for (const t of segs) { await server.handleTranscriptSegment(t, true, 0.95, true); await new Promise(r => setTimeout(r, 900)); }
    await new Promise(r => setTimeout(r, 1500));
    const sentPs = broadcasts.some(b => b.target === 'viewer' && b.verses[0].reference.startsWith('Psalms 125:1'));
    const wrong = broadcasts.some(b => b.correctedFrom && /Psalms 125/.test(b.correctedFrom));
    assert.ok(sentPs, 'setup: Psalms 125:1 must have been cited');
    assert.ok(!wrong, 'Psalms 125:1 must not be replaced by a verse shown earlier');
  });

  // ── Wrong sends found in the clean live runs (2026-09-24) ──────────────
  await test('a half-heard interim citation does not reach the screen ("verse twenty" before "twenty six to twenty eight")', async () => {
    server.resetDetectionSession(); referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('Genesis one from verse twenty', false, 0.9, false);
    await new Promise(r => setTimeout(r, 200));
    await server.handleTranscriptSegment('Genesis one from verse twenty six to twenty eight', false, 0.9, false);
    await new Promise(r => setTimeout(r, 200));
    await server.handleTranscriptSegment('Genesis one from verse 26 to 28.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 300));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(!sent.includes('Genesis 1:20'), `must never show the half-heard verse 20, got ${JSON.stringify(sent)}`);
    assert.ok(sent.includes('Genesis 1:26'), `the real citation must still arrive, got ${JSON.stringify(sent)}`);
  });

  await test('a COMPLETE interim citation still goes out once it is stable on two updates', async () => {
    server.resetDetectionSession(); referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('Second Timothy one verse seven say', false, 0.9, false);
    await new Promise(r => setTimeout(r, 200));
    await server.handleTranscriptSegment('Second Timothy one verse seven say that the spirit', false, 0.9, false);
    await new Promise(r => setTimeout(r, 300));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(sent.includes('2 Timothy 1:7'), `a stable interim citation should not wait for the final, got ${JSON.stringify(sent)}`);
  });

  await test('"verse eight" while a DIFFERENT book is being announced never resolves against the stale active chapter (Psalms 82:8, real incident)', async () => {
    server.resetDetectionSession(); referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    // Exact live split: the book name ends one segment, its number starts the next.
    await server.handleTranscriptSegment('In Psalm 82 verse six, heaven say you are a God. In the book of Acts', true, 0.9, true);
    await new Promise(r => setTimeout(r, 300));
    await server.handleTranscriptSegment('of Apostle one verse eight', false, 0.9, false);
    await new Promise(r => setTimeout(r, 300));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(!sent.includes('Psalms 82:8'), `verse eight belongs to the NEW book, got ${JSON.stringify(sent)}`);
  });

  await test('unrelated narration after a bare chapter does not match a long verse on everyday words (Romans 10:19, real incident)', async () => {
    server.resetDetectionSession(); referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('Turn to Romans 10.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 300));
    await server.handleTranscriptSegment('you that are in pain, I will solve the problem and they are safe and protected. In no man\'s', true, 0.9, true);
    await new Promise(r => setTimeout(r, 400));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(!sent.some(r => r.startsWith('Romans 10')), `narration must not resolve to a Romans 10 verse, got ${JSON.stringify(sent)}`);
  });

  await test('an interim citation the speaker has clearly moved past goes out at once, even if Deepgram later rewrites its wording (Acts 1:8, live)', async () => {
    server.resetDetectionSession(); referenceContext.reset();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });
    await server.handleTranscriptSegment('In the book of Acts of Apostle one verse eight, he say, when the', false, 0.9, false);
    await new Promise(r => setTimeout(r, 300));
    // Deepgram then rewrites the same words to something unparseable.
    await server.handleTranscriptSegment('Book of act of apostle one verse eight, he say, when the spirit of Christ', false, 0.9, false);
    await new Promise(r => setTimeout(r, 300));
    const sent = broadcasts.filter(b => b.target === 'viewer').map(b => b.verses[0].reference);
    assert.ok(sent.includes('Acts 1:8'), `expected Acts 1:8, got ${JSON.stringify(sent)}`);
  });

  await test('a Deepgram auto-reconnect (keepContinuity) keeps the active book/chapter; a fresh start clears it', async () => {
    server.resetDetectionSession();
    referenceContext.update('1 Kings', 19);
    server.resetDetectionSession({ keepContinuity: true });
    assert.ok(referenceContext.isValid && referenceContext.book === '1 Kings', 'reconnect must not wipe the active citation context');
    server.resetDetectionSession();
    assert.ok(!referenceContext.isValid, 'a fresh session start must clear it');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
