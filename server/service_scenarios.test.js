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

  // ── Back: undo the last change to the screen ──
  await test('Back puts the previous verse back up, and the undone verse is not re-sent by detection', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('John 3 verse 16.'); await wait(4500);
    await say('Romans 8 verse 28.');
    sent = [];
    const r = await server.screenBack();
    assert.equal(r.restored, 'John 3:16', JSON.stringify(r));
    assert.equal(sent.filter(s => s.target === 'viewer').at(-1)?.ref, 'John 3:16');
    sent = [];
    await say('And we know that all things work together for good to them that love God, to them who are the called according to his purpose.');
    assert.ok(!onScreen().includes('Romans 8:28'), JSON.stringify(sent));
  });

  await test('Back undoes an accidental clear, and returns to the slide a verse covered', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await server.sendServiceSlide({ reference: 'Welcome', text: 'Welcome to church' }, null);
    await say('Psalm 23 verse 1.');
    await server.clearLayer('all');
    sent = [];
    assert.equal((await server.screenBack()).restored, 'Psalms 23:1');   // the clear undone
    assert.equal((await server.screenBack()).restored, 'Welcome');       // the slide under it
    assert.equal(sent.filter(s => s.target === 'viewer').at(-1)?.ref, 'Welcome');
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
    // an automatic re-send (a theme edit on the live slide) stays under the scripture
    sent = [];
    const landed = await server.sendServiceSlide({ reference: 'Announcements', text: 'Next week' }, null, { auto: true });
    assert.equal(landed, 'under-bible');
    assert.deepEqual(sent.filter(s => s.target === 'viewer'), []);
    // Clear Bible reveals the (updated) slide
    const r = await server.clearLayer('bible');
    assert.ok(r.restored);
    assert.equal(sent.filter(s => s.target === 'viewer').at(-1)?.ref, 'Announcements');
  });

  await test('slides that follow the preacher take the screen back from a scripture', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await server.sendServiceSlide({ reference: 'Point 1', text: 'Faith that speaks' }, null);
    await say('Turn with me to John 3 verse 16.');
    assert.ok(onScreen().includes('John 3:16'), JSON.stringify(sent));
    sent = [];
    await server.sendServiceSlide({ reference: 'Point 2', text: 'Faith that acts' }, null, { auto: true, follow: true });
    assert.equal(sent.filter(s => s.target === 'viewer').at(-1)?.ref, 'Point 2', JSON.stringify(sent));
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

  await test('a verse number called out after a named chapter goes up while the sentence is still being spoken', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('In Matthew 11, say, come to me.');
    sent = [];
    // interim only — the sentence isn't finished yet
    await server.handleTranscriptSegment('28, all you', false, 0.9, false); await wait(300);
    assert.ok(onScreen().includes('Matthew 11:28'), JSON.stringify(sent));
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

  // ── A book heard as another real book (accents, a garbled ordinal) ──
  await test('a chapter only the sound-alike book has goes up at once as that book', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Philippians 6 verse 12.');
    assert.deepEqual(onScreen(), ['Ephesians 6:12'], JSON.stringify(sent));
  });

  await test('a verse only the sound-alike has is offered, not sent', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Jonah 3 verse 16.');
    assert.deepEqual(onScreen(), [], JSON.stringify(sent));
    assert.ok(sent.some(s => s.ref === 'John 3:16' && s.target === 'suggestions'), JSON.stringify(sent));
  });

  await test('"Fake John 4:4" then 1 John 4:4\'s words: the screen switches to 1 John 4:4', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Fake John four verse four say, who is in you is greater than the devils in the world.');
    assert.equal(onScreen().at(-1), '1 John 4:4', JSON.stringify(sent));
  });

  await test('a paraphrase in modern words decides too ("the world… under the control of the evil one" = 1 John 5:19)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('But hear this, say John five verse 19 have said, the world where you are is under power controlled by the evil one.');
    assert.equal(onScreen().at(-1), '1 John 5:19', JSON.stringify(sent));
  });

  await test('"Ephesians 2:10, in the name of Jesus every knee shall bow" is Philippians 2:10', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('He said Ephesians two verse 10, in my name Jesus, every knee shall bow.');
    assert.equal(onScreen().at(-1), 'Philippians 2:10', JSON.stringify(sent));
  });

  await test('a citation heard right stays, whatever follows it', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('John 4 verse 4. And he must needs go through Samaria. Jesus went out of his way for one woman in the world.');
    await say('Let us talk about love this morning, because love is the greatest thing in the world.');
    assert.deepEqual(onScreen(), ['John 4:4'], JSON.stringify(sent));
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('John 3 verse 16.');
    await say('He gave everything, even his own life, church, so we should give our lives for one another too.');
    assert.ok(!sent.some(s => s.ref === '1 John 3:16' && s.method === 'direct'), JSON.stringify(sent));   // no switch by the citation check
  });

  await test('a bare "Timothy" with nothing to choose by is only offered', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Timothy 3 verse 16.');
    assert.deepEqual(onScreen(), [], JSON.stringify(sent));
  });

  await test('"second" | "Timothy" | "three one to five" split across segments is 2 Timothy', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('That will disconnect people from being partakers of this agenda and it is listed in second');
    await say('Timothy');
    await say('three one to five');
    assert.equal(onScreen()[0], '2 Timothy 3:1', JSON.stringify(sent));
    assert.ok(!onScreen().includes('1 Timothy 3:1'), JSON.stringify(sent));
  });

  await test('"third John five verse 19" after a 1 John citation is 1 John 5:19', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('First John four verse four say, who is in you is greater than the devils in the world.');
    await say('But hear this, third John five verse 19 have said, the world where you are is under power controlled by the evil one.');
    assert.equal(onScreen().at(-1), '1 John 5:19', JSON.stringify(sent));
  });

  await test('the twin of the verse on screen is not offered (Psalm 1:3 while Jeremiah 17:8 is up)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Jeremiah 17 verse seven to eight.');
    await say('He said blessed are those who trusted in the Lord Jesus. For you shall be like a tree, planted by the side of the river bank. You will never dry.');
    await wait(1500);
    assert.ok(!sent.some(s => s.ref === 'Psalms 1:3'), JSON.stringify(sent));
  });

  await test('a verse read before a new citation can\'t "correct" it (Jeremiah 17:7, then Psalm 125)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Ephesians two verse 10, in my name Jesus, every knee shall do what?');
    await say('17 verse seven to eight. He said, blessed are those who trusted in the Lord Jesus. For you shall be like a tree.');
    await say('Someone 25 verse one and two. He said, you shall be like a mountain Zion.');
    await say('And nobody can take you away from your position. From today, prepare the barrier of your enemies.');
    await wait(1500);
    assert.equal(onScreen().at(-1), 'Psalms 125:1', JSON.stringify(sent));
  });

  // ── Wrong sends found in the eval (2026-09-27) ──
  await test('"is one of the nine" | "seeds" after John 3:8 is counting, not John 3:9', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('John 3 verse 8.');
    await say('The seed of love comes alive in you after you are saved. Is one of the nine');
    await say('seeds of your generous spirit.');
    assert.ok(!onScreen().includes('John 3:9'), JSON.stringify(sent));
  });

  await test('a range read aloud with no "next verse" steps forward verse by verse and never flicks back', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Psalm 1 verse 1 to 3.');
    await say('Blessed is the man that walketh not in the counsel of the ungodly, nor standeth in the way of sinners, nor sitteth in the seat of the scornful.');
    await say('But his delight is in the law of the LORD; and in his law doth he meditate day and night.');
    await say('And he shall be like a tree planted by the rivers of water, that bringeth forth his fruit in his season; his leaf also shall not wither; and whatsoever he doeth shall prosper.');
    await wait(1500);
    const seq = onScreen().filter((r, i, a) => r !== a[i - 1]);
    assert.deepEqual(seq, ['Psalms 1:1', 'Psalms 1:2', 'Psalms 1:3'], JSON.stringify(sent));
  });

  await test('a common phrase shared by several verses doesn\'t put one of them up ("the other side of the sea")', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('They head like dummies, the sea saw them, it fled, and then they sang a new song on the other side of the sea. Amen.');
    assert.ok(!onScreen().includes('Mark 5:1'), JSON.stringify(sent));
  });

  await test('"hangeth upon the tree" after Galatians 3:13 doesn\'t replace it with Joshua 10:26', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Christ has redeemed us from the curse of the law, being made a curse for us, for it is written.');
    await say('Cursed is every man that hangeth upon the tree. That the blessing of Abraham might come on the Gentiles.');
    assert.ok(!onScreen().includes('Joshua 10:26'), JSON.stringify(sent));
    assert.ok(onScreen().includes('Galatians 3:13'), JSON.stringify(sent));
  });

  await test('"my blood, shed for the remission of sins" ends on Matthew 26:28, not Luke 22:20', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Number two, we partake of the blood of Jesus in the Holy Communion.');
    await say('This is my blood which is shed for the remission of the sins of the world.');
    await say('My blood, my blood.');
    await wait(1500);
    assert.equal(onScreen().at(-1), 'Matthew 26:28', JSON.stringify(sent));
  });

  // ── Wrong verse numbers, misheard books, fragmented speech (2026-09-27) ──
  await test('"Genesis 24 verse 53" right after "Isaac went to the field to meditate" is Genesis 24:63', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Scriptures in search of the way out of issues of concern in our lives, and Isaac went to the field to meditate');
    await say('there. Genesis 24 and verse 53. And Isaac engaged, and the Philistines envied him.');
    await wait(1500);
    assert.equal(onScreen().at(-1), 'Genesis 24:63', JSON.stringify(sent));
  });

  await test('"Joshua 1:18" followed by 1:8\'s words ends on Joshua 1:8', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Joshua 1 verse 18. This book of the law shall not depart from your mouth, but you shall meditate therein day and night.');
    await wait(1500);
    assert.equal(onScreen().at(-1), 'Joshua 1:8', JSON.stringify(sent));
  });

  await test('a correct citation with number look-alikes stays (Genesis 24:63, John 3:16)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Genesis 24 verse 63. And Isaac went out to meditate in the field at the eventide.');
    await wait(1200);
    assert.deepEqual(onScreen().filter((r, i, a) => r !== a[i - 1]), ['Genesis 24:63'], JSON.stringify(sent));
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('John 3 verse 16. God loved you so much, church, that he gave everything for you.');
    await wait(1200);
    assert.deepEqual(onScreen().filter((r, i, a) => r !== a[i - 1]), ['John 3:16'], JSON.stringify(sent));
  });

  await test('"Proverbate him" — the righteous run to it and are safe — finds Proverbs 18:10', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Proverbate him, the name of the Lord is a strong tower, the righteous run into it and they are safe and protected.');
    await wait(2000);
    assert.ok(sent.some(s => s.ref === 'Proverbs 18:10'), JSON.stringify(sent));
  });

  await test('"In Romans\', whosoever call upon the name of Jesus shall be saved" finds Romans 10:13, not Acts 2:21', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say("In Romans' whosoever shall call upon the name of the Lord shall be saved. That is the promise.");
    await say('Nobody who calls on him is turned away, church.');
    await wait(2000);
    assert.ok(sent.some(s => s.ref === 'Romans 10:13'), JSON.stringify(sent));
    assert.ok(!onScreen().includes('Acts 2:21'), JSON.stringify(sent));
  });

  await test('a cited verse stays when its word-for-word twin is read (Jeremiah 31:34, not Hebrews 8:11)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Jeremiah 31 verse 34.');
    await say('He said, and they shall teach no more every man his neighbour, and every man his brother, saying, Know the Lord: for they shall all know me.');
    await wait(1500);
    assert.ok(!onScreen().includes('Hebrews 8:11'), JSON.stringify(sent));
    assert.equal(onScreen().at(-1), 'Jeremiah 31:34', JSON.stringify(sent));
  });

  await test('a cited verse isn\'t "corrected" to its near-duplicate as it\'s read (Matthew 11:11, not Luke 7:28)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Matthew 11 verse 11.');
    await say('He said, among them that are born of women, there are not risen a greater than John the Baptist.');
    await say('But he that is least in the kingdom of heaven is greater than he.');
    await wait(1500);
    assert.ok(!onScreen().includes('Luke 7:28'), JSON.stringify(sent));
    assert.equal(onScreen().at(-1), 'Matthew 11:11', JSON.stringify(sent));
  });

  await test('a verse inside an actively-cited range isn\'t traded for its twin (Matthew 24:46, not Luke 12:37)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Matthew 24:45 to 47.');
    await say('Who then is a faithful and wise servant, whom his lord hath made ruler over his household, to give them meat in due season?');
    await say('Blessed is that servant, whom his lord when he cometh shall find so doing.');
    await wait(1500);
    assert.ok(!onScreen().includes('Luke 12:37'), JSON.stringify(sent));
    assert.equal(onScreen().at(-1), 'Matthew 24:46', JSON.stringify(sent));
  });

  await test('"2 Samuel 5:18 to 20" with 5:19\'s words around it doesn\'t become the look-alike number 5:8', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Walk through scriptures with your meditation in search of answers. Shall I go up, David said, 2 Samuel chapter 5:18');
    await say('to 20. Will you deliver the Philistines into my hand, and the Lord said go up.');
    await wait(1500);
    assert.ok(!onScreen().includes('2 Samuel 5:8'), JSON.stringify(sent));
  });

  await test('a citation split across segments completes even when the next segment cites something else', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('this is my blood which is shed for the remission of sins, my blood, my blood, John 6');
    await say('48-57, reference again in 1 Corinthians 11 28-30, my blood.');
    await wait(1200);
    assert.ok(onScreen().includes('John 6:48'), JSON.stringify(sent));
  });

  await test('"…on our high places verse" | "14, favour…" is verse 14 of the chapter in play', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Isaiah 58 verse 12.');
    await say('It impacts our generation after us, verse 12, and then it gets us up on our high places verse');
    await say('14, favour, I mean prayer and fasting is a game changer.');
    await wait(1200);
    assert.ok(onScreen().includes('Isaiah 58:14'), JSON.stringify(sent));
  });

  await test('a "verse" | number split doesn\'t resolve against a chapter the words don\'t fit', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('2 Corinthians 3 verse 17.');
    await say('Isaac sowed in that land and received in the same year an hundredfold, and he had possession of flocks, and the Philistines envied him verse');
    await say('16, and Abimelech said unto Isaac, go from us, for thou art much mightier than we.');
    await wait(1200);
    assert.ok(!onScreen().includes('2 Corinthians 3:16'), JSON.stringify(sent));
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('He said Isaiah 66:3, what does he mean? I said start from verse');
    await say('one, start from verse one. Unto this man that has a contrite spirit, who trembles at my word.');
    await wait(1200);
    assert.ok(!onScreen().includes('Isaiah 66:1'), JSON.stringify(sent));
  });

  await test('"Jeremiah 29:1" then 29:11 in modern words ends on Jeremiah 29:11', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('Your future is in his plan, not in your plan. Jeremiah');
    await say('29:1, Revised Standard Version: for I know the plans I have for you, says the Lord, plans for welfare and not for evil, to give you a future and a hope.');
    await wait(1500);
    assert.equal(onScreen().at(-1), 'Jeremiah 29:11', JSON.stringify(sent));
  });

  await test('a verse quoted from memory in NIV words is offered ("plans to prosper you" = Jeremiah 29:11)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    await say('God has not forgotten you church. For I know the plans I have for you, plans to prosper you and not to harm you, plans to give you hope and a future.');
    await say('That is his word over your life this morning.');
    await wait(2000);
    assert.ok(sent.some(s => s.ref === 'Jeremiah 29:11'), JSON.stringify(sent));
  });

  await test('a quote said in fragments is told from its near-duplicate (Mark 11:23, not Matthew 21:21)', async () => {
    fresh(); server.clearRangeQueue(); await server.clearLayer('all');
    for (const piece of ['If you will say', 'to this mountain,', 'be thou removed,', 'and be thou cast into the sea,', 'and shall not doubt in your heart,', 'but shall believe that those things you say shall come to pass,', 'you shall have whatsoever you say.']) await say(piece);
    await wait(1500);
    assert.ok(!onScreen().includes('Matthew 21:21'), JSON.stringify(sent));
    assert.ok(sent.some(s => s.ref === 'Mark 11:23'), JSON.stringify(sent));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
