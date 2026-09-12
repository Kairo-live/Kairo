// KAIRO — Regression tests for reference_parser.js parsing edge cases.
// Uses node:test directly since this module has no server.js/worker_threads
// side effects (unlike ambiguous_refs.test.js etc., which need the plain-
// script pattern to dodge server.js's orphan-watchdog interval).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAllSpokenReferences, resolvePartialReference, referenceContext, detectBookMentions } = require('./reference_parser');

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

// Real live incident: "Corinthians ten three to five" (actually 2 Corinthians
// 10:3-5) got silently resolved and auto-sent as "1 Corinthians" — traced to
// detectBookMentions resolving an EARLIER, bare, unprefixed "Corinthians"
// mention (no chapter/verse yet, from a growing interim transcript) via
// BOOK_ALIASES's own blind NUMBERED_BOOK_VARIANTS[b][0] default fallback,
// writing "1 Corinthians" into referenceContext BEFORE the full citation
// ever reached resolveAmbiguousRefs's real, context-aware disambiguation —
// which then dutifully "resolved via active context" to the wrong book.
test('a bare, unprefixed numbered-book mention ("Corinthians", "Timothy"...) never sets context via detectBookMentions — only an explicit citation with its own chapter/verse may resolve which one (real incident, 2026-09-13)', () => {
  assert.deepEqual(detectBookMentions('the book of Corinthians', true), [],
    'a trigger-phrase + bare numbered-book stem must not silently default to the #1 variant');
  assert.deepEqual(detectBookMentions('read Timothy chapter three', true), [],
    'same for every other numbered-book stem (Timothy, Kings, Samuel, Peter, Chronicles, Thessalonians)');

  referenceContext.reset();
  const refs = parseAllSpokenReferences('corinthians ten three to five');
  assert.equal(refs.length, 2, 'no active context means the full citation is genuinely ambiguous — both variants, not a silent default');
  assert.deepEqual(new Set(refs.map(r => r.book)), new Set(['1 Corinthians', '2 Corinthians']));
  assert.ok(refs.every(r => r.ambiguousGroup), 'both must be tagged ambiguous, not one confidently chosen');
});

// Fuzzy book-name correction for the local (Nemotron) offline engine, which
// mishears book names more often than Deepgram — but only ever a LIGHT
// mishearing (a dropped/added letter), never the total garbling a heavier
// ASR failure produces (e.g. "1 Kings 19" -> "Fourth case nineteen" is not
// fixable by any lightweight fuzzy pass; that's a much deeper failure). Two
// separate gaps closed together:
//   1. Numbered-book STEMS (Kings, Samuel, Corinthians, Thessalonians,
//      Timothy, Peter, Chronicles) had zero fuzzy tolerance at all — an
//      exact BOOK_ALIASES miss on the stem word silently dropped the whole
//      citation, no fallback attempted.
//   2. SHORT single-word books (Ruth, Mark, Luke, Acts, Amos, Joel, Jude —
//      under 6 chars) were excluded from the pre-existing longer-word fuzzy
//      matcher entirely, purely by an arbitrary length gate.
// Both must ALSO exercise parseAllSpokenReferences specifically, not just
// parseSpokenReference — the two functions used to carry independent
// copies of the book-matching scan (matchBookAt didn't exist yet), and a
// fix added to only one had zero effect through the other, which is the
// live entry point every real transcript actually goes through.
test('numbered-book stem fuzzy correction (real local-model mishearings) — only through the fuzzy path when the exact word is wrong, never blocking exact matches', () => {
  assert.deepEqual(parseAllSpokenReferences('first king nineteen and verse four'),
    [{ book: '1 Kings', chapter: 19, verse: 4 }]);
  assert.deepEqual(parseAllSpokenReferences('second corinthian ten verse three'),
    [{ book: '2 Corinthians', chapter: 10, verse: 3 }]);
  assert.deepEqual(parseAllSpokenReferences('first timothi three sixteen')[0],
    { book: '1 Timothy', chapter: 3, verse: 16 });
  // Still resolves the exact spelling normally — the fuzzy path is a
  // fallback, not a replacement for the existing exact match.
  assert.equal(parseAllSpokenReferences('first kings nineteen and verse four')[0].book, '1 Kings');
});

test('short single-word book fuzzy correction — only with an explicit "chapter" keyword, never from a bare trailing number', () => {
  // "mork"/"ruthe" (not real words, not pre-existing aliases) are each one
  // edit away from "Mark"/"Ruth" — genuinely exercises the NEW fuzzy path,
  // unlike "luk", which was already a registered exact abbreviation for
  // Luke before this change (BOOK_ALIASES already had 'luk':'Luke').
  assert.equal(parseAllSpokenReferences('mork chapter two verse one')[0]?.book, 'Mark');
  assert.equal(parseAllSpokenReferences('ruthe chapter one verse sixteen')[0]?.book, 'Ruth');
  // No "chapter" keyword — a short word followed by a bare number is FAR
  // too common in ordinary sermon speech ("<word> four", "<word> forty") to
  // safely guess from at this length; must not resolve at all.
  assert.deepEqual(parseAllSpokenReferences('mork two verse one'), []);
});

test('the widened fuzzy matchers still do not false-positive on ordinary sentences with no real citation intent', () => {
  assert.deepEqual(parseAllSpokenReferences('he had a great job chapter closing today'), []);
  assert.deepEqual(parseAllSpokenReferences('first time nineteen ninety nine'), []);
  assert.deepEqual(parseAllSpokenReferences('the first game nineteen to twenty'), []);
});

// Owner's spec (2026-09-13, live): "John 15 and 16 should be assumed as
// chapter 15 v 16 of the book of john unless the chapter was called
// earlier." "Book N and M" with no "chapter"/"verse" keyword at all between
// the numbers is a common plain-spoken citation shape that previously
// resolved to nothing (no "chapter" keyword -> rejected outright for
// AMBIGUOUS_BOOKS like John) or a bare, verseless chapter (with "chapter" ->
// the "and M" half was silently dropped).
test('"Book N and M" with no chapter/verse keyword resolves as chapter N, verse M — unless that book\'s chapter is already an established context', () => {
  referenceContext.reset();
  assert.deepEqual(parseAllSpokenReferences('john fifteen and sixteen'),
    [{ book: 'John', chapter: 15, verse: 16 }]);
  // Works identically whether "chapter" was said or not.
  referenceContext.reset();
  assert.deepEqual(parseAllSpokenReferences('john chapter fifteen and sixteen'),
    [{ book: 'John', chapter: 15, verse: 16 }]);

  // Chapter already active for this exact book — the fallback must NOT
  // fire (falls through to the existing, stricter paths instead of
  // guessing), per the owner's own "unless" clause.
  referenceContext.reset();
  referenceContext.update('John', 15);
  assert.deepEqual(parseAllSpokenReferences('john fifteen and sixteen'), []);

  // Must not affect ordinary sentences with no real citation shape.
  referenceContext.reset();
  assert.deepEqual(parseAllSpokenReferences('mark was born in nineteen and eighty'), []);
});
