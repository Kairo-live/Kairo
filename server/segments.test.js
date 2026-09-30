// KAIRO — the Timer tab's built-in Preservice segment is the pre-service loop
// (Welcome to Church and the pack's ready-to-run slides, each carrying the
// countdown), for new installs and, once, for an untouched Preservice from
// before.
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// segments.js and triggers.js read their data folder when loaded: a fresh
// copy of both per install.
const dirs = [];
after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
function freshInstall(segmentsJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-segments-'));
  dirs.push(dir);
  if (segmentsJson) {
    fs.mkdirSync(path.join(dir, 'segments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'segments', 'segments.json'), JSON.stringify(segmentsJson));
  }
  process.env.KAIRO_APP_DATA_DIR = dir;
  for (const m of ['./segments.js', './triggers.js']) delete require.cache[require.resolve(m)];
  const segments = require('./segments.js');
  segments.init();
  return segments.listSegments();
}
const plain = (name, extra = {}) => ({ id: name, name, order: 0, triggerId: 't-' + name, status: 'pending', themeId: null, slideStyles: {}, scenes: [], scenePace: null, ...extra });

test('a new install\'s Preservice is the pre-service loop, Welcome to Church first, Service Begins last', () => {
  const list = freshInstall();
  const pre = list.find(s => s.name === 'Preservice');
  assert.equal(pre.scenes[0].name, 'Welcome to Church');
  assert.equal(pre.scenes[pre.scenes.length - 1].name, 'Service Begins');
  assert.ok(pre.scenes.every(sc => sc.layers.some(l => l.binding === 'timer')), 'every slide carries the countdown');
  assert.equal(pre.scenePace.mode, 'countdown');
  assert.ok(!pre.scenes.some(sc => /give|missed|weekly/i.test(sc.name)), 'no slide with stand-in details');
  assert.deepEqual(list.filter(s => !/^Preservice/.test(s.name)).map(s => s.scenes.length), [0, 0, 0, 0, 0]);
});

test('a new install\'s Preservice 2, right after Preservice, is the pre-service set: Welcome first, Almost Time last', () => {
  const list = freshInstall();
  assert.deepEqual(list.map(s => s.name), ['Preservice', 'Preservice 2', 'Prayer', 'Worship', 'The Word', 'Testimony', 'Ministration']);
  const pre2 = list[1];
  assert.deepEqual(pre2.scenes.map(sc => sc.name), ['Welcome', 'Starting Soon', 'Pre-Service', 'Almost Time']);
  assert.ok(pre2.scenes[3].finale && !pre2.scenes.slice(0, 3).some(sc => sc.finale), 'Almost Time is the finale');
  assert.ok(pre2.scenes.every(sc => sc.layers.some(l => l.binding === 'timer')), 'every slide carries the countdown');
  assert.ok(pre2.scenes.every(sc => !sc.layers.some(l => l.type === 'image-cycle')), 'no slideshow layer — every part editable');
  assert.equal(pre2.scenePace.mode, 'countdown');
});

test('an install from before Preservice 2 gets it right after Preservice, once; deleted, it stays deleted', () => {
  let list = freshInstall([plain('Preservice', { loopSeeded: true }), plain('Prayer', { order: 1 }), plain('Worship', { order: 2 })]);
  assert.deepEqual(list.map(s => s.name), ['Preservice', 'Preservice 2', 'Prayer', 'Worship']);
  assert.equal(list[1].scenes[0].name, 'Welcome');
  const saved = () => JSON.parse(fs.readFileSync(path.join(dirs[dirs.length - 1], 'segments', 'segments.json'), 'utf8'));
  // Started again: still one.
  list = freshInstall(saved());
  assert.equal(list.filter(s => s.name === 'Preservice 2').length, 1);
  // Deleted, then started again: stays deleted.
  list = freshInstall(saved().filter(s => s.name !== 'Preservice 2'));
  assert.deepEqual(list.map(s => s.name), ['Preservice', 'Prayer', 'Worship']);
});

test('an install that already has a Preservice 2 of its own is not given a second one', () => {
  const list = freshInstall([plain('Preservice'), plain('Preservice 2', { order: 1, themeId: 'timer-big' })]);
  assert.equal(list.filter(s => s.name === 'Preservice 2').length, 1);
  assert.equal(list[1].themeId, 'timer-big');
});

test('an untouched Preservice from before becomes the loop, keeping its own look edits', () => {
  const list = freshInstall([plain('Preservice', { slideStyles: { 0: { bg: { src: 'backgrounds/emerald.jpg' } } } }), plain('Prayer')]);
  const pre = list.find(s => s.name === 'Preservice');
  assert.equal(pre.scenes[0].name, 'Welcome to Church');
  assert.equal(pre.slideStyles[0].bg.src, 'backgrounds/emerald.jpg');
  assert.equal(list.find(s => s.name === 'Prayer').scenes.length, 0);
});

test('a Preservice with a theme, or one made plain again, is left as it is', () => {
  let list = freshInstall([plain('Preservice', { themeId: 'timer-ring' })]);
  assert.equal(list[0].scenes.length, 0);
  list = freshInstall([plain('Preservice', { loopSeeded: true })]);
  assert.equal(list[0].scenes.length, 0);
});
