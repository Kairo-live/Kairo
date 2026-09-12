// KAIRO — Regression tests for the anchor backward-extension fix
// (detection_worker.js's extendBackward, wired into _advanceAnchor).
//
// Real incident: a preacher saying "come and let us reason together" for
// Isaiah 1:18's real text "Come NOW, and let us reason together" scored
// matched=4 (unconfirmed) — the anchor only fires on "and let us reason"
// (the first 4-gram that survives the dropped "now" intact), so the
// genuinely-matching "come" spoken before that anchor point was invisible
// to a mechanism that only ever extended forward. Owner's own framing:
// "it should fill gaps or fuse things when 4/5 are correct as long as they
// match a scripture verse sequence."
//
// No server.js involved (pure worker_threads), so this uses node:test
// directly — no orphan-watchdog teardown issue to dodge.
//
// The mechanism is now ALWAYS ON in the worker (see detection_worker.js's
// own comment on `back`/`viaBackwardExtension` for the full harness-
// validated story: unconditionally TRUSTING a backward-dependent
// confirmation the same as an ordinary one traded meaningfully more wrong
// auto-sends than the recall gain was worth, across three separate tuning
// attempts). The corroboration-gated re-attempt: the worker still always
// computes it and tags exactly which confirmations depended on it
// (`viaBackwardExtension`); server.js's `processStreamText` only lets THOSE
// auto-send once a second, independent method has separately hit the same
// verse — otherwise they're demoted to Candidates instead of vanishing
// entirely. This suite tests the worker's own half in isolation (server.js's
// corroboration gate is a separate concern, exercised live/via the harness).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const path = require('path');

function makeWorkerClient() {
  const w = new Worker(path.join(__dirname, 'detection_worker.js'));
  let id = 0;
  const ready = new Promise((resolve) => {
    const onReady = (msg) => { if (msg.type === 'ready') { w.off('message', onReady); resolve(); } };
    w.on('message', onReady);
  });
  function call(type, payload) {
    return new Promise((resolve) => {
      const reqId = ++id;
      const handler = (msg) => { if (msg.id === reqId) { w.off('message', handler); resolve(msg); } };
      w.on('message', handler);
      w.postMessage({ type, id: reqId, ...payload });
    });
  }
  return { w, ready, call };
}

test('a dropped word EARLY in a quote ("come and let us reason together" for "Come NOW, and let us...") reaches confirmed via backward extension — the real reported incident', async () => {
  const { w, ready, call } = makeWorkerClient();
  try {
    await ready;
    const words = 'come and let us reason together'.split(' ');
    let result = null;
    for (const word of words) result = await call('streamText', { text: word });
    const hit = (result.results || []).find(r => r.reference === 'Isaiah 1:18');
    assert.ok(hit, 'Isaiah 1:18 must be found at all');
    assert.equal(hit.confirmed, true, 'must reach confirmed status thanks to backward-credited "come"');
    assert.ok(hit.matched >= 6, `matched must include the backward-extended word, got ${hit.matched}`);
    assert.equal(hit.viaBackwardExtension, true, 'must be tagged as depending on backward extension, so server.js knows to require corroboration before auto-sending it');
  } finally {
    await w.terminate();
  }
});

test('an ordinary confirmation that would have cleared the bar from forward words alone is NOT tagged viaBackwardExtension, even though backward extension always runs now', async () => {
  const { w, ready, call } = makeWorkerClient();
  try {
    await ready;
    // John 3:16, spoken in full straightforward order — 7+ words align
    // forward with no dropped words, comfortably clearing ALIGN_CONFIRM_AT
    // (6) and ANCHOR_CONFIRM_IDF from ordinary forward progress alone.
    const words = 'for god so loved the world that he gave his only begotten son'.split(' ');
    // Each streamText call's results only reflect verses that had a fresh
    // anchor/confirm event on THAT single word — the confirm fires the
    // moment enough words align (here, on "world"), not necessarily on the
    // final word of the phrase — so track the best hit seen across every
    // call rather than trusting only the last one.
    let hit = null;
    for (const word of words) {
      const result = await call('streamText', { text: word });
      const found = (result.results || []).find(r => r.reference === 'John 3:16');
      if (found) hit = found;
    }
    assert.ok(hit, 'John 3:16 must be found');
    assert.equal(hit.confirmed, true, 'must confirm from ordinary forward alignment');
    assert.equal(hit.viaBackwardExtension, false, 'a confirmation that did not NEED backward credit must not be tagged as depending on it, regardless of whether extendBackward happened to find something');
  } finally {
    await w.terminate();
  }
});

test('an UNRELATED short phrase that happens to share an anchor does not get inflated by backward extension into a false confirm', async () => {
  const { w, ready, call } = makeWorkerClient();
  try {
    await ready;
    // Ordinary, non-scriptural sentence containing a coincidental 4-word
    // overlap somewhere in the corpus — backward extension must not turn a
    // real coincidence into a confirmed false positive just because a few
    // words happen to precede it in normal speech too.
    const words = 'and every human knowledge that is contrary to the truth'.split(' ');
    let result = null;
    for (const word of words) result = await call('streamText', { text: word });
    // Whatever (if anything) fires, it must not be wrongly marked
    // "confirmed" purely from backward-extension inflation without real
    // forward alignment to back it up — this is a coarse sanity check, not
    // a claim about any specific verse.
    for (const hit of (result.results || [])) {
      if (hit.confirmed) {
        assert.ok(hit.matchedIdf >= 12, `a confirmed hit must still clear the real IDF floor (ANCHOR_CONFIRM_IDF), got ${hit.matchedIdf} for ${hit.reference}`);
      }
    }
  } finally {
    await w.terminate();
  }
});
