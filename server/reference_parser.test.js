// KAIRO — Regression tests for reference_parser.js parsing edge cases.
// Uses node:test directly since this module has no server.js/worker_threads
// side effects (unlike ambiguous_refs.test.js etc., which need the plain-
// script pattern to dodge server.js's orphan-watchdog interval).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAllSpokenReferences, resolvePartialReference, referenceContext } = require('./reference_parser');

test('a single-verse citation immediately followed by ordinary continuation text starting with "for" does NOT become a bogus 2-verse range (real incident, 2026-09-07)', () => {
  // "for" is a deliberate, necessary homophone of "four" (consumeNumber
  // maps it to 4, for legitimate cases like "john for verse one" = John
  // 4:1) — but it's also an ordinary, extremely common English word, and
  // the KJV itself constantly opens a verse's continuing clause with
  // "For...". Real incident: "Ephesians six verse 12, for we wrestle not
  // against flesh and blood..." (Ephesians 6:12's own actual KJV
  // continuation) was parsed as a compound range covering verses 12 AND
  // 4 — verse 4 was never spoken or intended at all.
  const refs = parseAllSpokenReferences(
    'Ephesians six verse 12 for we not against flesh and blood but against principalities and powers'
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].book, 'Ephesians');
  assert.equal(refs[0].chapter, 6);
  assert.equal(refs[0].verse, 12);
  assert.equal(refs[0].ranges, undefined, 'must not synthesize a compound range from ordinary continuation text');
});

test('a legitimate compound range (explicit "and" connector) still parses correctly', () => {
  const refs = parseAllSpokenReferences('Luke chapter 10 from verse one to two and seventeen to nineteen');
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].ranges, [
    { verseStart: 1, verseEnd: 2 },
    { verseStart: 17, verseEnd: 19 },
  ]);
});

test('a legitimate simple range still parses correctly', () => {
  const refs = parseAllSpokenReferences('psalm chapter one and verse one to three');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].verseStart, 1);
  assert.equal(refs[0].verseEnd, 3);
});

test('a legitimate comma-separated compound citation still parses correctly', () => {
  const refs = parseAllSpokenReferences('genesis chapter one verse one, verse three');
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].ranges, [
    { verseStart: 1, verseEnd: 1 },
    { verseStart: 3, verseEnd: 3 },
  ]);
});

test('a bare "verse N" trigger survives a normal 20s expository pause since the last citation (real incident, 2026-09-07)', () => {
  // Real incident: "1 Kings 19 and verse 4" ... [20s of explaining the
  // still small voice] ... "verse 12" ... [another ~20s] ... "verse 15" —
  // each gap landed almost exactly on the OLD 20s CONTEXT_EXPIRE_MS
  // boundary, and real-world processing delay pushed resolution just past
  // it, so the bare "verse 15" trigger silently never fired at all. Per
  // the owner's own spec: "speech 'verse 15' — this should go to verse 15
  // of the already sent scripture... that's a trigger along with 'next
  // verse'."
  referenceContext.update('1 Kings', 19);
  referenceContext._updatedAt = Date.now() - 20000; // exactly the old expiry boundary
  assert.equal(referenceContext.isValid, true, 'context must still be valid at the old 20s boundary');
  const ref = resolvePartialReference('in verse 15 and God began to tell him what to do');
  assert.deepEqual(ref, { book: '1 Kings', chapter: 19, verse: 15, partial: true });
});

test('context still correctly expires eventually (does not become an unbounded stale-context risk)', () => {
  referenceContext.update('Acts', 3);
  referenceContext._updatedAt = Date.now() - 46000; // past the new 45s window
  assert.equal(referenceContext.isValid, false, 'context must still expire — this is not an unconditional removal of the guard');
});

test('a genuinely bare number (no "verse" keyword at all) resolves against the already-displayed book/chapter, per owner spec: "if it hears a number or \'verse n\' it goes to the verse of that book and chapter already displayed"', () => {
  referenceContext.update('1 Kings', 19);
  referenceContext._updatedAt = Date.now();
  assert.deepEqual(resolvePartialReference('fifteen'), { book: '1 Kings', chapter: 19, verse: 15, partial: true });
  // A couple of leading filler words are tolerated too ("and fifteen").
  assert.deepEqual(resolvePartialReference('and fifteen'), { book: '1 Kings', chapter: 19, verse: 15, partial: true });
});

test('a bare number embedded in an ordinary sentence does NOT get misread as a verse-number trigger', () => {
  referenceContext.update('1 Kings', 19);
  referenceContext._updatedAt = Date.now();
  // "twenty" here is a real word in ordinary speech (a count of years), not
  // a verse callout — the number must consume the WHOLE segment to trigger,
  // so anything with real words following it must not match.
  assert.equal(resolvePartialReference('he waited twenty years then said'), null);
  assert.equal(resolvePartialReference('for twenty years he served faithfully'), null);
});

test('allowBareNumber:false (the interim caller) disables the bare-number pattern, real regression 2026-09-07 — an enumerated-points sermon caught a fleeting interim snapshot', () => {
  // Real incident, live: "One attribute we saw in Isaac was the art of
  // meditation..." and, minutes later, "What is meditation number two? It
  // is reasoning through scriptures." — ordinary enumerated points, never
  // meant as verse callouts. Deepgram's INTERIM transcript briefly showed
  // just "One" (or "One,") before the rest of the sentence streamed in,
  // and Pattern 3's "consumes the whole segment" check was satisfied for
  // that split second, resolving against a stale book/chapter context. The
  // FINAL transcript never has this problem (real words follow in the same
  // settled segment), so the fix is to disable the pattern on interim only
  // — Pattern 2 (explicit "verse N") stays enabled either way.
  referenceContext.update('Genesis', 24);
  referenceContext._updatedAt = Date.now();
  assert.equal(resolvePartialReference('One', { allowBareNumber: false }), null,
    'a bare number must not resolve on interim, even though it would on final');
  assert.deepEqual(resolvePartialReference('One'), { book: 'Genesis', chapter: 24, verse: 1, partial: true },
    'the default (final-path) behavior is unchanged — allowBareNumber defaults to true');
  // Pattern 2 (explicit "verse N") is untouched by allowBareNumber — an
  // interim catch of an EXPLICIT "verse 15" should still resolve.
  assert.deepEqual(resolvePartialReference('verse 15', { allowBareNumber: false }), { book: 'Genesis', chapter: 24, verse: 15, partial: true });
});

test('"chapter N of Book" word order still resolves (regression check for the earlier fix in this same file)', () => {
  const refs = parseAllSpokenReferences('the Centurion in chapter 7 of Luke from verse 1-6 a servant was there');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].book, 'Luke');
  assert.equal(refs[0].chapter, 7);
  assert.equal(refs[0].verseStart, 1);
  assert.equal(refs[0].verseEnd, 6);
});
