// KAIRO — how the offline engine locks words: in the order they were said,
// the newest few kept live, and never a lock that ends on a number (what a
// number means depends on the words after it). Driven with a stand-in
// recognizer that grows its text a few words at a time, as the model does.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SherpaEngine } = require('./sherpa_engine');

// Pumps the engine once per step, the recognizer's text growing to each step's
// words; returns what locked, in order.
function lockRuns(steps) {
  const locked = [];
  const engine = new SherpaEngine({ modelDir: '/nonexistent', onFinal: (text) => locked.push(text) });
  let text = '';
  engine._recognizer = {
    isReady: () => false, decode() {}, isEndpoint: () => false, reset() {},
    getResult: () => ({ text }),
  };
  engine._stream = {};
  engine._running = true;
  for (const words of steps) { text = words; engine._pump(); }
  return locked;
}

test('words lock in the order they were said, the newest four live', () => {
  const locked = lockRuns([
    'the world but hear this',
    'the world but hear this is what',
    'the world but hear this is what he said to them',
  ]);
  assert.deepEqual(locked, ['the world but', 'hear this is what']);
});

test('a lock never ends on a number: "third John five" waits for "verse nineteen"', () => {
  const locked = lockRuns([
    'hear this third John five verse',
    'hear this third John five verse nineteen have said',
    'hear this third John five verse nineteen have said the world where you',
  ]);
  assert.deepEqual(locked, ['hear this third John', 'five verse nineteen have said']);
});

test('a two-word number is never split across locks', () => {
  const locked = lockRuns([
    'in Matthew eleven say come to me twenty',
    'in Matthew eleven say come to me twenty eight all you that',
  ]);
  assert.ok(!locked.some(run => /twenty$/.test(run)), `locked: ${JSON.stringify(locked)}`);
});

test('a number the model closed with punctuation locks like any word', () => {
  const locked = lockRuns(['Deuteronomy thirty one verse six. It says fear not']);
  assert.deepEqual(locked, ['Deuteronomy thirty one verse six.']);
});
