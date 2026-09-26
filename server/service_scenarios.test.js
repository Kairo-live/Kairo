// KAIRO — Real service situations run through the whole pipeline (scenario sweep,
// 2026-09-26). Each is a scripted transcript; the assertion is what reaches the screen.
//   KAIRO_EVAL_MODE=1 node server/service_scenarios.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }
const dir = path.join(os.tmpdir(), `kairo-scenarios-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
process.env.KAIRO_APP_DATA_DIR = dir;
const server = require('./server');
const { referenceContext } = require('./reference_parser');

let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`✔ ${name}`); } catch (e) { fail++; console.log(`✖ ${name}\n  ${e.message}`); } }
const wait = ms => new Promise(r => setTimeout(r, ms));
let sent = [];
server.onBroadcast(m => { if (m.type === 'detection') sent.push({ ref: m.verses[0].reference, target: m.target, method: m.method, count: m.verses.length }); });
const onScreen = () => sent.filter(s => s.target === 'viewer').map(s => s.ref);
async function say(text) {
  const w = text.split(' ');
  for (let i = 3; i < w.length; i += 3) { await server.handleTranscriptSegment(w.slice(0, i).join(' '), false, 0.9, false); await wait(15); }
  await server.handleTranscriptSegment(text, true, 0.9, true); await wait(150);
}
const fresh = () => { server.resetDetectionSession(); referenceContext.reset(); sent = []; };

(async () => {
  server.spawnDetectionWorker(); await server.workerReadyPromise; await wait(2500);

  // ── Paraphrase: the preacher's own words for a verse ──
  await test('a paraphrase in the preacher\'s own words is found (Possible Matches or the screen)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Church, some of you have been carrying this weight for a very long time.');
    await say('But the Bible says we should not worry about anything, instead pray about everything and tell God what you need, and thank him for all he has done.');
    await say('That is how you live free from anxiety every single day of your life.');
    await wait(1500);
    assert.ok(sent.some(s => s.ref === 'Philippians 4:6'), JSON.stringify(sent));
  });

  await test('ordinary preaching produces no paraphrase matches', async () => {
    fresh(); server.clearRangeQueue();
    await say('Good morning church, it is so good to be in the house of the Lord today, let us give God a round of applause.');
    await say('Before we continue, the ushers will come forward and after that the choir will minister to us in song.');
    await wait(1500);
    assert.deepEqual(sent.filter(s => s.method === 'paraphrase'), [], JSON.stringify(sent));
  });

  // ── Output layers: media < slide < Bible ──
  await test('a scripture called during slides goes up over the slide; Clear Bible brings the slide back', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    const layerStates = []; server.onBroadcast(m => { if (m.type === 'layer-state') layerStates.push(m); });
    await server.sendServiceSlide({ reference: 'Welcome', text: 'Welcome to church' }, null);
    sent = [];
    await say('Turn with me to John 3 verse 16.');
    assert.ok(onScreen().includes('John 3:16'), JSON.stringify(sent));
    assert.ok(layerStates.at(-1)?.bibleOnTop && layerStates.at(-1)?.slideUnderneath, JSON.stringify(layerStates));
    // auto-follow moving the slide underneath does not uncover the scripture
    sent = [];
    const landed = await server.sendServiceSlide({ reference: 'Announcements', text: 'Next week' }, null, { auto: true });
    assert.equal(landed, 'under-bible');
    assert.deepEqual(sent.filter(s => s.target === 'viewer'), []);
    // Clear Bible reveals the (updated) slide
    const r = await server.clearLayer('bible');
    assert.ok(r.restored);
    assert.equal(sent.filter(s => s.target === 'viewer').at(-1)?.ref, 'Announcements');
  });

  await test('an operator clicking a slide while a scripture is up sends it', async () => {
    fresh(); await server.clearLayer('all');
    await say('Romans 8 verse 28.');
    sent = [];
    await server.sendServiceSlide({ reference: 'Offering', text: 'Giving' }, null);
    assert.equal(sent.filter(s => s.target === 'viewer').at(-1)?.ref, 'Offering');
  });

  await test('Clear Slide while a scripture is up keeps the scripture; Clear Bible then clears the screen', async () => {
    fresh(); await server.clearLayer('all');
    await server.sendServiceSlide({ reference: 'Welcome', text: 'Welcome' }, null);
    await say('Psalm 23 verse 1.');
    assert.deepEqual(await server.clearLayer('slide'), { keptBible: true });
    assert.deepEqual(await server.clearLayer('bible'), { restored: false });
  });

  // ── Citation forms added 2026-09-26 (see the "all the ways a scripture is called" list) ──
  await test('"the following verse" moves to the next verse', async () => {
    fresh(); server.clearRangeQueue(); await say('Romans 8 verse 28.'); await wait(4500); await say('And the following verse says this.');
    assert.ok(onScreen().includes('Romans 8:29'), JSON.stringify(onScreen()));
  });

  await test('"verse 28 of Romans 8" goes up as Romans 8:28', async () => {
    fresh(); server.clearRangeQueue(); await say('Look at verse 28 of Romans 8.');
    assert.ok(onScreen().includes('Romans 8:28'), JSON.stringify(onScreen()));
  });

  // The interim fast path may already have shown 3:17 before "sorry, 16" was
  // heard; what is guaranteed is that the screen ends on the corrected verse.
  await test('a citation corrected in the same breath ends on the corrected verse', async () => {
    fresh(); server.clearRangeQueue(); await say('John 3:17, sorry, 16.');
    assert.equal(onScreen().at(-1), 'John 3:16', JSON.stringify(onScreen()));
  });

  await test('"verses 4, 5 and 6" queues all three', async () => {
    fresh(); server.clearRangeQueue(); await say('Romans 8 verses 4, 5 and 6.');
    const up = sent.find(s => s.target === 'viewer');
    assert.ok(up && up.ref === 'Romans 8:4' && up.count === 3, JSON.stringify(sent));
  });

  await test('"the last verse" goes to the last verse of the chapter in play', async () => {
    fresh(); server.clearRangeQueue(); await say('Psalm 23 verse 1.'); await wait(4500); await say('Now look at the last verse.');
    assert.ok(onScreen().includes('Psalms 23:6'), JSON.stringify(onScreen()));
  });

  await test('a named passage is offered in Possible Matches, never auto-sent', async () => {
    fresh(); server.clearRangeQueue(); await say('Like the prodigal son, some of us have been far from home for a long time.');
    assert.deepEqual(onScreen(), []);
    assert.ok(sent.some(s => s.ref === 'Luke 15:11' && s.target === 'suggestions'), JSON.stringify(sent));
  });

  await test('a lone "for" after a verse is the word, not verse 4', async () => {
    fresh(); server.clearRangeQueue(); await say('Psalm 30 verse 5.'); await wait(4500); await say('for');
    assert.ok(!onScreen().includes('Psalms 30:4'), JSON.stringify(onScreen()));
  });

  await test('"group one, group two" is counting, not verse numbers', async () => {
    fresh(); server.clearRangeQueue(); await say('John 3 verse 16.'); await wait(4500); await say('Group one,'); await say('group two,');
    assert.deepEqual(onScreen(), ['John 3:16']);
  });

  await test('"…nine and nine, I mean verse eleven" is not a verse of the chapter on screen', async () => {
    fresh(); server.clearRangeQueue(); await say('Revelation 1 verse 18.'); await wait(4500); await say('that anyone may have lost zear 9 and 9 I mean verse 11 and');
    assert.ok(!onScreen().includes('Revelation 1:11'), JSON.stringify(onScreen()));
  });

  await test('"24 of Genesis verse 12 to 15" is Genesis 24:12-15', async () => {
    fresh(); server.clearRangeQueue(); await say('Speed 24 of Genesis vers 12- 15 and Abraham servant said oh Lord God');
    assert.ok(onScreen().includes('Genesis 24:12'), JSON.stringify(sent));
  });

  await test('"the previous verse" steps back one verse', async () => {
    fresh(); await say('Romans 8 verse 28.'); await say('Look at the previous verse.');
    assert.ok(onScreen().includes('Romans 8:27'), JSON.stringify(onScreen()));
  });

  await test('"go back to verse 3" still goes up (a spoken verse number is not a text match)', async () => {
    fresh(); await say('John 3 verse 16.'); await say('Now go back to verse 3.');
    assert.ok(onScreen().includes('John 3:3'), JSON.stringify(onScreen()));
  });

  await test('"chapter 5 verse 1" while in Romans 8 goes up as a citation (book from context)', async () => {
    fresh(); await say('Romans 8 verse 1.'); await say('Now chapter 5 verse 1.');
    assert.ok(onScreen().includes('Romans 5:1'), JSON.stringify(onScreen()));
  });

  await test('"from verse 4 to the end" queues the rest of the chapter', async () => {
    fresh(); await say('Psalm 23 from verse 4 to the end.');
    const first = sent.find(s => s.target === 'viewer' && s.ref === 'Psalms 23:4');
    assert.ok(first && first.count === 3, `expected verses 4-6 of Psalm 23, got ${JSON.stringify(sent)}`);
  });

  await test('while a song is live, lyrics that quote scripture are only offered, never take over the screen', async () => {
    fresh();
    await server.sendServiceSlide({ reference: 'Holy Holy Holy', text: 'Holy, holy, holy! Lord God Almighty' });
    sent = [];
    await say('Holy holy holy is the Lord God Almighty, who was and is and is to come.');
    assert.deepEqual(onScreen(), [], JSON.stringify(sent));
  });

  await test('an explicit citation during a song still goes up', async () => {
    fresh();
    await server.sendServiceSlide({ reference: 'Holy Holy Holy', text: 'Holy, holy, holy! Lord God Almighty' });
    await say('Isaiah chapter 6 verse 3.');
    assert.ok(onScreen().includes('Isaiah 6:3'), JSON.stringify(onScreen()));
  });

  await test('a formula verse that only shares wording with the verse on screen does not replace it (Genesis 5:6 read, 5:3 matched)', async () => {
    fresh(); await say('Genesis 5 verse 6.'); await say('And Seth lived an hundred and five years, and begat Enos.');
    assert.ok(!onScreen().includes('Genesis 5:3'), JSON.stringify(onScreen()));
  });

  await test('a genuinely new quote still replaces the verse on screen', async () => {
    fresh(); await say('Psalm 23 verse 1.'); await say('And we know that all things work together for good to them that love God.');
    assert.ok(onScreen().includes('Romans 8:28'), JSON.stringify(onScreen()));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
