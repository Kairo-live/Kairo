// KAIRO — sermon notes: each point with its quotes and scriptures, then the
// prayer points, from a session.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotes, buildNotesWithMeaning, renderNotesPdf } = require('./sermon_notes');

let t = 0;
const said = (...lines) => lines.map(text => ({ at: (t += 5000), text }));
const shown = (ref, text) => ({ at: (t += 1000), ref, text });

test('enumerated points become sections, each with the scriptures shown while it was made', () => {
  t = 0;
  const transcript = [
    ...said('Welcome church, God is good.', 'He speaks to us through a number of channels. One, he speaks to us directly.'),
  ];
  const verses = [shown('Genesis 26:2', 'And the LORD appeared unto him, and said, Go not down into Egypt')];
  transcript.push(...said('Number two, very importantly, God speaks to us through his word.'));
  verses.push(shown('Psalms 119:105', 'Thy word is a lamp unto my feet, and a light unto my path.'));
  verses.push(shown('Psalms 119:106', 'I have sworn, and I will perform it'));
  const notes = buildNotes({ transcript, verses, name: 'The Voice of God' });
  assert.equal(notes.title, 'The Voice of God');
  assert.deepEqual(notes.sections.map(s => s.kind), ['point', 'point'], 'nothing before the first point made the notes');
  assert.deepEqual(notes.sections.map(s => s.heading), ['He speaks to us directly.', 'God speaks to us through his word.']);
  assert.deepEqual(notes.sections.map(s => s.scriptures.map(p => p.ref)), [['Genesis 26:2'], ['Psalms 119:105-106']]);
});

test('"First Timothy three nine" is a citation, not point one; counting, "the first lady" and a lone "number one" are not lists', () => {
  t = 0;
  const notes = buildNotes({ transcript: said(
    'First Timothy three nine, holding the mystery of the faith.', 'One, two, three, lift your hands.',
    'The first lady of the nation came to church.', 'The number one thing you need is faith.',
    'Number one, God is good.',
  ) });
  assert.deepEqual(notes.sections.map(s => s.kind), ['whole']);
  assert.deepEqual(notes.sections[0].scriptures.map(p => p.ref), ['1 Timothy 3:9']);
});

test('a point said as a run-on is cut to a heading where a clause ends', () => {
  t = 0;
  const notes = buildNotes({ transcript: said(
    'Number one, faith is the currency of heaven, and when you walk in faith you will see things change in your family, in your business, in your career and in every area of your life without fail.',
    'Number two, love is the law of the kingdom.',
  ) });
  assert.equal(notes.sections[0].heading, 'Faith is the currency of heaven, and when you walk in faith you will see things change in your family, in your business…');
});

test('quotes: lines said again and again — not filler, citations, garbled transcription or a restated point', () => {
  t = 0;
  const line = 'You cannot hear from God and doubt him.';
  const transcript = said(
    'Number one, we must be spiritual people.',
    line, 'Praise the Lord, praise the Lord everybody.', line,
    'In Acts chapter four verse 20, we cannot but speak.', 'In Acts chapter four verse 20, we cannot but speak.',
    'Access to is the bedrock of faith.', 'Access to is the bedrock of faith.',
    'We must be spiritual people.', 'We must be spiritual people.',
    'Praise the Lord, praise the Lord everybody.', line,
    'Number two, we must be praying people.',
  );
  const notes = buildNotes({ transcript });
  assert.deepEqual(notes.sections.map(s => s.heading), ['We must be spiritual people.', 'We must be praying people.']);
  assert.deepEqual(notes.sections[0].quotes.map(q => q.text), [line]);
  assert.deepEqual(notes.sections[0].scriptures.map(p => p.ref), ['Acts 4:20'], 'cited aloud, listed once');
});

test('quotes: a repeated prayer, a service instruction or a line that says nothing is never one', () => {
  t = 0;
  const notes = buildNotes({ transcript: said(
    'Number one, love never fails.',
    'Give the Lord a big hand of praise, everybody.', 'Give the Lord a big hand of praise, everybody.',
    'Lord, have mercy on us and heal our land.', 'Lord, have mercy on us and heal our land.',
    "I'm going to do it.", "I'm going to do it.", "I'm going to do it.",
    'Love keeps no record of wrongs done to it.', 'Love keeps no record of wrongs done to it.',
    'Number two, love always hopes.',
  ) });
  assert.deepEqual(notes.sections.flatMap(s => s.quotes.map(q => q.text)), ['Love keeps no record of wrongs done to it.']);
});

test('scriptures: cited aloud or shown, each under the point it came in, once — and only verses the Bible has', () => {
  t = 0;
  const transcript = said('Number one, God keeps his promises.', 'Numbers 23:19 says God is not a man that he should lie.');
  const verses = [shown('Numbers 23:19', 'God is not a man, that he should lie')];
  transcript.push(...said('Number two, God answers prayer.', 'In Psalm 23, David says the Lord is my shepherd.', 'Turn with me to Psalm 20 verse 1889.'));
  const notes = buildNotes({ transcript, verses });
  assert.deepEqual(notes.sections.map(s => s.scriptures.map(p => p.ref)), [['Numbers 23:19'], ['Psalms 23']]);
  assert.equal(notes.passageCount, 2);
});

test('the PDF renders', async () => {
  t = 0;
  const pdf = await renderNotesPdf(buildNotes({ transcript: said('Number one, faith comes by hearing.'), verses: [shown('Romans 10:17', 'So then faith cometh by hearing')], name: 'Faith' }));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

// ── Meaning (buildNotesWithMeaning) ─────────────────────────────────────────
// A stand-in for the semantic model: a sentence's vector points along the
// topic words it contains, so "about the same thing" is testable by hand,
// plus a little of its own (from its text), as real sentences have — two
// sentences on one topic are close, not identical.
const TOPICS = ['faith', 'prayer', 'giving', 'love'];
const OWN = 8;
const fakeEmbed = (quoted = new Set()) => async (texts) => ({
  vectors: texts.map(t => {
    const v = new Float32Array(TOPICS.length + 1 + OWN);
    TOPICS.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
    v[TOPICS.length] = 0.2;   // everything a sermon says shares a little
    let h = 2166136261;
    for (const ch of t) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    for (let i = 0; i < OWN; i++) { h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0; v[TOPICS.length + 1 + i] = ((h % 1000) / 1000 - 0.5) * 1.2; }
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  }),
  quoteShares: texts.map(t => (quoted.has(t) ? 0.9 : 0.1)),
});
const sermonWithPoints = () => said(
  'Number one, faith is the currency of heaven.',
  'Faith moves the hand that moves the world.', 'Real faith keeps standing when nothing changes.',
  'Faith grows when the word is heard again and again.', 'Faith without works stays asleep in the heart.',
  'Please stand to your feet and lift your hands.',
  'Number two, prayer is the engine room of the church.',
  'Prayer changes the one who prays before it changes anything.', 'A prayer-less church is a powerless church.',
  'Prayer is the breath of the soul.', 'Prayer keeps the heart soft toward heaven.',
  'Number three, giving opens the windows of heaven.',
  'Giving is the proof that the heart has been converted.', 'Generous giving breaks the grip of fear.',
  'Giving to the poor is lending to the Lord himself.', 'Cheerful giving is the kind that heaven honours.',
);

const topicOf = (text) => TOPICS.find(w => text.toLowerCase().includes(w));
const quotesOf = (notes) => notes.sections.flatMap(s => s.quotes).map(q => q.text);

test('with meaning: each point gets its own quotable lines, on its own subject, none twice', async () => {
  t = 0;
  const notes = await buildNotesWithMeaning({ transcript: sermonWithPoints(), name: 'Three keys' }, fakeEmbed());
  assert.deepEqual(notes.sections.map(s => s.kind), ['point', 'point', 'point']);
  const [faith, prayer, giving] = notes.sections;
  for (const [sec, topic] of [[faith, 'faith'], [prayer, 'prayer'], [giving, 'giving']]) {
    assert.ok(sec.quotes.length >= 1, `${topic} has quotes`);
    assert.ok(sec.quotes.every(q => topicOf(q.text) === topic), `${topic}'s quotes stay on ${topic}`);
  }
  const all = quotesOf(notes);
  assert.equal(new Set(all).size, all.length, 'no line appears twice');
  assert.ok(!all.some(x => /stand to your feet/i.test(x)), 'service talk is never a quote');
});

test('with meaning: a verse being read is never quoted as the preacher\'s own words', async () => {
  t = 0;
  const reading = 'Faith grows when the word is heard again and again.';
  const notes = await buildNotesWithMeaning({ transcript: sermonWithPoints() }, fakeEmbed(new Set([reading])));
  assert.ok(!quotesOf(notes).includes(reading));
});

test('with meaning: a sermon with no numbered points is split where its subject shifts, each part headed by its most telling line', async () => {
  t = 0;
  const transcript = said(
    'Faith moves the hand that moves the world.', 'Real faith keeps standing when nothing changes.',
    'Faith without works stays asleep in the heart.', 'Faith is the currency that heaven accepts.',
    'Faith sees the harvest while the seed is still in the ground.', 'Doubt starves where faith is fed daily.',
    'Faith takes God at his word and walks.', 'Great faith is simply small faith that refused to quit.',
    'Faith hears before it sees anything change.', 'Faith is the evidence the heart carries first.',
    'Love keeps no record of wrongs done to it.', 'Love is patient with people who are slow to change.',
    'Real love serves when nobody is watching.', 'Love covers what gossip would uncover.',
    'Love gives without keeping a ledger of favours.', 'Love chooses the other person again and again.',
    'Love is the family likeness of the children of God.', 'Love forgives before the apology comes.',
    'Love bears weight that pride would drop.', 'Love is the one debt we are meant to keep owing.',
  );
  const notes = await buildNotesWithMeaning({ transcript }, fakeEmbed());
  assert.deepEqual(notes.sections.map(s => s.kind), ['topic', 'topic']);
  assert.deepEqual(notes.sections.map(s => topicOf(s.heading)), ['faith', 'love']);
  for (const s of notes.sections) assert.ok(s.quotes.length >= 1 && s.quotes.every(q => topicOf(q.text) === topicOf(s.heading)));
  assert.ok(!quotesOf(notes).some(q => notes.sections.some(s => s.heading === q)), 'a heading is not quoted again');
});

test('with meaning: no model, a failing model, or unpunctuated captions leave the rule-based notes', async () => {
  t = 0;
  const transcript = sermonWithPoints();
  const plain = buildNotes({ transcript });
  assert.deepEqual(await buildNotesWithMeaning({ transcript }), plain);
  assert.deepEqual(await buildNotesWithMeaning({ transcript }, async () => { throw new Error('worker busy'); }), plain);
  t = 0;
  const captions = said('faith is the currency of heaven and faith moves the hand that moves the world and real faith keeps standing', 'prayer changes the one who prays before it changes anything a prayer-less church is a powerless church');
  assert.deepEqual(await buildNotesWithMeaning({ transcript: captions }, fakeEmbed()), buildNotes({ transcript: captions }));
});

test('with meaning: the PDF renders the points with their quotes', async () => {
  t = 0;
  const notes = await buildNotesWithMeaning({ transcript: sermonWithPoints(), name: 'Three keys' }, fakeEmbed());
  const pdf = await renderNotesPdf(notes);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1500);
});

test('prayer points: only prayers raised for the church to pray, as the prayer itself', () => {
  t = 0;
  const notes = buildNotes({ transcript: said(
    'In Jesus precious name we have prayed.',
    'Papa, pray for us.',
    'Prayer point number one: Father, let every closed door over my life open by fire.',
    'Prayer point number two.', 'Lord, give me the grace to love you more than anything, in Jesus name.',
    'Now pray that God will give you a hunger for his word.',
    'And pray this prayer of faith after me.', 'Lord Jesus.', 'Save my soul.', 'I repent of my sins tonight.',
    'All that pray this prayer, I cover you with the blood of Jesus.', 'Remain covered against every assault of the enemy.',
  ) });
  assert.deepEqual(notes.prayerPoints.map(p => p.text), [
    'Father, let every closed door over my life open by fire.',
    'Lord, give me the grace to love you more than anything.',
    'Pray that God will give you a hunger for his word.',
    'Lord Jesus. Save my soul. I repent of my sins tonight.',
  ]);
});
