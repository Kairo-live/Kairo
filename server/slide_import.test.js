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
const { pbFields } = require('./slide_import.js');

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

console.log('slide_import.test.js: 5/5 assertions passed');
