// KAIRO — sermon notes: points, key lines and scriptures from a session.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotes, renderNotesPdf } = require('./sermon_notes');

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
  assert.deepEqual(notes.sections.map(s => s.heading), ['He speaks to us directly.', 'God speaks to us through his word.']);
  assert.deepEqual(notes.sections.map(s => s.scriptures.map(p => p.ref)), [['Genesis 26:2'], ['Psalms 119:105-106']]);
});

test('"First Timothy three nine" is a citation, not point one; counting is not a list', () => {
  t = 0;
  const notes = buildNotes({ transcript: said('First Timothy three nine, holding the mystery of the faith.', 'One, two, three, lift your hands.') });
  assert.deepEqual(notes.sections, []);
});

test('key things said: repeated lines, not filler, citations, garbled transcription or a restated point', () => {
  t = 0;
  const line = 'You cannot hear from God and doubt him.';
  const transcript = said(
    'Number one, we must be spiritual people.',
    line, 'Praise the Lord, praise the Lord everybody.', line,
    'In Acts chapter four verse 20, we cannot but speak.', 'In Acts chapter four verse 20, we cannot but speak.',
    'Access to is the bedrock of faith.', 'Access to is the bedrock of faith.',
    'We must be spiritual people.', 'We must be spiritual people.',
    'Praise the Lord, praise the Lord everybody.', line,
  );
  const notes = buildNotes({ transcript });
  assert.deepEqual(notes.keyThings.map(k => k.text), [line]);
});

test('the PDF renders', async () => {
  t = 0;
  const pdf = await renderNotesPdf(buildNotes({ transcript: said('Number one, faith comes by hearing.'), verses: [shown('Romans 10:17', 'So then faith cometh by hearing')], name: 'Faith' }));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});
