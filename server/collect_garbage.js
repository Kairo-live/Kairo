// KAIRO — a full garbage collection, on demand.
//
// V8 collects when its own heap fills, and can't see native memory held by
// the tiny JS handles of a loaded model: a stopped speech recognizer kept its
// ~1.1 GB until a collection that could be hours away, and the detection
// worker kept ~130 MB of heap it grew into while building its indexes, plus
// the model files' read buffers. The few places that know a big release just
// happened call this. Node only exposes gc() with --expose-gc; enabling the
// flag at runtime and reading gc from a fresh context is the standard way to
// get it without one. A no-op if that ever stops working.
'use strict';

let gc = () => {};
try {
  require('v8').setFlagsFromString('--expose-gc');
  const fn = require('vm').runInNewContext('gc');
  if (typeof fn === 'function') gc = fn;
} catch {}

// Native finalizers run after a collection, not during it, and a model is
// only freed once whatever holds it (a stream, a session) has been — hence a
// second pass shortly after the first.
function collectGarbage() {
  gc();
  setTimeout(gc, 1000).unref?.();
}

module.exports = { collectGarbage };
