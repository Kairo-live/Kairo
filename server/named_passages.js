// KAIRO — well-known passages referred to by name ("the Lord's Prayer", "the
// Beatitudes", "the prodigal son"). A name is usually a passing allusion, not
// an instruction to read, so these are offered in Possible Matches only —
// never auto-sent. Only names that point to one passage are listed; stories
// told in several Gospels (the feeding of the five thousand) are left out.
'use strict';

const PASSAGES = [
  [/\bthe lord'?s prayer\b/, 'Matthew', 6, 9, 13],
  [/\bthe beatitudes\b/, 'Matthew', 5, 3, 12],
  [/\bsermon on the mount\b/, 'Matthew', 5, 1, 12],
  [/\bthe love chapter\b/, '1 Corinthians', 13, 1, 13],
  [/\bthe great commission\b/, 'Matthew', 28, 18, 20],
  [/\bthe great commandment\b/, 'Matthew', 22, 37, 40],
  [/\bthe golden rule\b/, 'Matthew', 7, 12, 12],
  [/\b(whole )?armou?r of god\b/, 'Ephesians', 6, 10, 18],
  [/\bthe fruits? of the spirit\b/, 'Galatians', 5, 22, 23],
  [/\bthe ten commandments\b/, 'Exodus', 20, 1, 17],
  [/\bthe shepherd psalm\b/, 'Psalms', 23, 1, 6],
  [/\b(the faith chapter|hall of faith|heroes of faith)\b/, 'Hebrews', 11, 1, 40],
  [/\b(the )?prodigal son\b/, 'Luke', 15, 11, 32],
  [/\b(the )?good samaritan\b/, 'Luke', 10, 30, 37],
  [/\b(the )?(priestly|aaronic) blessing\b/, 'Numbers', 6, 24, 26],
  [/\bthe shema\b/, 'Deuteronomy', 6, 4, 5],
  [/\bthe magnificat\b/, 'Luke', 1, 46, 55],
  [/\bvalley of (the )?dry bones\b/, 'Ezekiel', 37, 1, 14],
  [/\bparable of the sower\b/, 'Matthew', 13, 3, 9],
  [/\bparable of the talents\b/, 'Matthew', 25, 14, 30],
  [/\bthe burning bush\b/, 'Exodus', 3, 1, 6],
  [/\bjacob'?s ladder\b/, 'Genesis', 28, 10, 17],
  [/\btower of babel\b/, 'Genesis', 11, 1, 9],
  [/\bday of pentecost\b/, 'Acts', 2, 1, 4],
  [/\bwedding (at|in) cana\b/, 'John', 2, 1, 11],
];

/** Passages named in the text: [{ name, book, chapter, verseStart, verseEnd }]. */
function findNamedPassages(text) {
  const t = String(text || '').toLowerCase().replace(/[’]/g, "'");
  const found = [];
  for (const [re, book, chapter, verseStart, verseEnd] of PASSAGES) {
    const m = re.exec(t);
    if (m) found.push({ name: m[0].trim(), book, chapter, verseStart, verseEnd });
  }
  return found;
}

module.exports = { findNamedPassages };
