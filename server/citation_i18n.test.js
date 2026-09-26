// KAIRO — spoken citations in Spanish, Portuguese, French and German parse
// the same as English ones.   node --test server/citation_i18n.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { localizeCitationText } = require('./citation_i18n');
const { parseAllSpokenReferences } = require('./reference_parser');

const refs = (text, lang) => parseAllSpokenReferences(localizeCitationText(text, lang)).map(r =>
  `${r.book} ${r.chapter}:${r.verse ?? r.verseStart}${r.verseEnd && r.verseEnd !== r.verseStart ? '-' + r.verseEnd : ''}`);

const CASES = [
  ['es', 'Juan capítulo tres versículo dieciséis', 'John 3:16'],
  ['es', 'primera de Corintios trece, cuatro al siete', '1 Corinthians 13:4-7'],
  ['es', 'la primera carta a los Corintios capítulo trece versículos del cuatro al siete', '1 Corinthians 13:4-7'],
  ['es', 'Salmo ciento diecinueve versículo ciento cinco', 'Psalms 119:105'],
  ['es', 'Hechos dos treinta y ocho', 'Acts 2:38'],
  ['es', 'Cantar de los Cantares dos versículo cuatro', 'Song of Solomon 2:4'],
  ['es', 'Juan 3:16', 'John 3:16'],
  ['pt', 'João três dezesseis', 'John 3:16'],
  ['pt', 'Salmos vinte e três versículo um', 'Psalms 23:1'],
  ['pt', 'Salmo cento e dezenove versículo cento e cinco', 'Psalms 119:105'],
  ['fr', 'Jean chapitre trois verset seize', 'John 3:16'],
  ['fr', 'Psaume quatre-vingt-onze verset un', 'Psalms 91:1'],
  ['fr', 'première épître aux Corinthiens treize verset quatre à sept', '1 Corinthians 13:4-7'],
  ['de', 'Johannes drei Vers sechzehn', 'John 3:16'],
  ['de', '1. Korinther dreizehn, Vers vier bis sieben', '1 Corinthians 13:4-7'],
  ['de', 'Psalm hundertneunzehn Vers hundertfünf', 'Psalms 119:105'],
  ['de', 'erstes Buch Mose Kapitel eins Vers eins', 'Genesis 1:1'],
  ['de', 'zweiter Korintherbrief fünf Vers siebzehn', '2 Corinthians 5:17'],
];
for (const [lang, text, want] of CASES) {
  test(`${lang}: "${text}" → ${want}`, () => assert.deepEqual(refs(text, lang), [want]));
}

test('ordinary sentences with numbers and articles are not citations', () => {
  assert.deepEqual(refs('había un hombre que tenía dos hijos', 'es'), []);
  assert.deepEqual(refs('il a vingt ans et il est venu', 'fr'), []);
  assert.deepEqual(refs('Jean a un fils', 'fr'), []);
  assert.deepEqual(refs('ein Mann hatte zwei Söhne', 'de'), []);
  assert.deepEqual(refs('um homem tinha dois filhos', 'pt'), []);
});

test('connector words are only rewritten between numbers', () => {
  assert.equal(localizeCitationText('il a vingt ans', 'fr'), 'il a 20 ans');
  assert.equal(localizeCitationText('la fe y el amor', 'es'), 'la fe y el amor');
});

test('the next/previous verse triggers are understood', () => {
  assert.match(localizeCitationText('vamos al siguiente versículo', 'es'), /next verse/);
  assert.match(localizeCitationText('le verset suivant', 'fr'), /next verse/);
  assert.match(localizeCitationText('der nächste Vers', 'de'), /next verse/);
  assert.match(localizeCitationText('o versículo anterior', 'pt'), /previous verse/);
});

test('English is passed through untouched', () => {
  assert.equal(localizeCitationText('John 3:16', 'en-US'), 'John 3:16');
  assert.equal(localizeCitationText('John 3:16', undefined), 'John 3:16');
});
