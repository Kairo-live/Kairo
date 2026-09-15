// Real incident: importing a real .proplaylist file crashed the whole
// import with "Cannot read properties of undefined (reading 'length')"
// instead of the friendly error message the UI is built to show — the
// operator saw the app silently pivot to the "paste content" fallback
// dialog with no indication their file import had actually failed.
// Traced to two stacked bugs, both covered here directly (not via a full
// synthetic .proplaylist zip, which would need a much larger fixture for
// no extra coverage — these are the exact two functions involved):
'use strict';

const assert = require('assert');
const { pbFields, rtfToText } = require('./slide_import.js');

// 1. pbFields' own doc comment promises "Returns null (never throws)" —
//    but `buf.length` on a non-Buffer threw instead. walkPlaylistManifest
//    (private, not exported) hit this by passing `fileRefField.raw` to
//    pro7FileRefRelPath -> pbFields without checking fileRefField.wire
//    first — a wire-0 (varint) field has no `.raw` at all, only `.value`.
assert.strictEqual(pbFields(undefined), null, 'pbFields(undefined) must return null, not throw');
assert.strictEqual(pbFields(null), null, 'pbFields(null) must return null, not throw');
assert.strictEqual(pbFields('not a buffer'), null, 'pbFields(non-buffer) must return null, not throw');

// A genuinely empty buffer is a legitimate zero-field message, not the
// same "not a buffer at all" case above — must NOT be treated as invalid.
assert.deepStrictEqual(pbFields(Buffer.alloc(0)), [], 'pbFields(empty buffer) must return [], not null');

// A real, valid message still parses correctly (one varint field, tag
// byte 0x08 = field 1, wire 0, value byte 0x05).
const real = pbFields(Buffer.from([0x08, 0x05]));
assert.deepStrictEqual(real, [{ num: 1, wire: 0, value: 5 }], 'a real varint field must still parse');

// 2. rtfToText's \'hh hex-escape handling mapped straight through
//    String.fromCharCode (Latin-1), but RTF's \'hh is a byte in the
//    document's ANSI codepage — Windows-1252 by default (\ansicpg1252),
//    which diverges from Latin-1 exactly in the 0x80-0x9F range: that's
//    where every curly quote/dash/ellipsis lives. Real incident: a
//    ProPresenter announcement slide's smart quotes/apostrophes/em-dash
//    silently vanished into invisible control characters on import.
assert.strictEqual(
  rtfToText(String.raw`{\rtf1\ansi\ansicpg1252 It\'92s a \'93great\'94 day \'96 don\'92t miss it\'85}`),
  'It’s a “great” day – don’t miss it…',
  'cp1252 smart quotes/dash/ellipsis must decode correctly, not vanish into control chars'
);

// 3. \uN (signed decimal Unicode code point) is RTF's OTHER real-world
//    escape form — used for characters outside the ANSI codepage entirely.
//    Before this fix it wasn't decoded at all: the generic control-word
//    strip just deleted "\uN" outright, silently dropping the character
//    (and never consumed the single ASCII fallback char RTF requires
//    immediately after, which would otherwise leak into the output).
assert.strictEqual(
  rtfToText(String.raw`{\rtf1 Caf\u233? na\u239?ve}`),
  'Café naïve',
  '\\uN unicode escapes must decode to the real character, with their fallback char consumed'
);

// Plain ASCII must be completely unaffected by either fix above.
assert.strictEqual(
  rtfToText(String.raw`{\rtf1 Hello World, no special chars here.}`),
  'Hello World, no special chars here.',
  'plain ASCII RTF text must be unaffected'
);

console.log('slide_import.test.js: 8/8 assertions passed');
