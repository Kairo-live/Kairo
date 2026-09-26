// KAIRO — spoken citations in Spanish, Portuguese, French and German.
//
// The app offers those speech languages, but reference_parser.js only knows
// English book names and number words, so a citation spoken in them was never
// recognized. Rather than re-implementing the (heavily hardened) parser per
// language, this rewrites a localized citation into the English tokens the
// parser already understands:
//   "Juan capítulo tres versículo dieciséis"  -> "john chapter 3 verse 16"
//   "primera de Corintios trece, cuatro al siete" -> "1 corinthians 13 4 to 7"
//   "Psaume vingt-trois verset un"             -> "psalms 23 verse 1"
//   "Johannes drei Vers sechzehn"              -> "john 3 verse 16"
// Only citation-shaped words are rewritten (book names, chapter/verse words,
// connectors next to numbers, number words); everything else passes through.
'use strict';

const stripAccents = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const fold = (s) => stripAccents(s).toLowerCase();

// Canonical English book -> localized names (accents are folded before lookup).
const BOOKS = {
  es: {
    'Genesis': ['genesis'], 'Exodus': ['exodo'], 'Leviticus': ['levitico'], 'Numbers': ['numeros'], 'Deuteronomy': ['deuteronomio'],
    'Joshua': ['josue'], 'Judges': ['jueces'], 'Ruth': ['rut'], 'Samuel': ['samuel'], 'Kings': ['reyes'], 'Chronicles': ['cronicas'],
    'Ezra': ['esdras'], 'Nehemiah': ['nehemias'], 'Esther': ['ester'], 'Job': ['job'], 'Psalms': ['salmos', 'salmo'], 'Proverbs': ['proverbios'],
    'Ecclesiastes': ['eclesiastes'], 'Song of Solomon': ['cantar de los cantares', 'cantares', 'cantar'], 'Isaiah': ['isaias'], 'Jeremiah': ['jeremias'],
    'Lamentations': ['lamentaciones'], 'Ezekiel': ['ezequiel'], 'Daniel': ['daniel'], 'Hosea': ['oseas'], 'Joel': ['joel'], 'Amos': ['amos'],
    'Obadiah': ['abdias'], 'Jonah': ['jonas'], 'Micah': ['miqueas'], 'Nahum': ['nahum'], 'Habakkuk': ['habacuc'], 'Zephaniah': ['sofonias'],
    'Haggai': ['hageo'], 'Zechariah': ['zacarias'], 'Malachi': ['malaquias'], 'Matthew': ['mateo'], 'Mark': ['marcos'], 'Luke': ['lucas'],
    'John': ['juan'], 'Acts': ['hechos de los apostoles', 'hechos'], 'Romans': ['romanos'], 'Corinthians': ['corintios'], 'Galatians': ['galatas'],
    'Ephesians': ['efesios'], 'Philippians': ['filipenses'], 'Colossians': ['colosenses'], 'Thessalonians': ['tesalonicenses'], 'Timothy': ['timoteo'],
    'Titus': ['tito'], 'Philemon': ['filemon'], 'Hebrews': ['hebreos'], 'James': ['santiago'], 'Peter': ['pedro'], 'Jude': ['judas'],
    'Revelation': ['apocalipsis'],
  },
  pt: {
    'Genesis': ['genesis'], 'Exodus': ['exodo'], 'Leviticus': ['levitico'], 'Numbers': ['numeros'], 'Deuteronomy': ['deuteronomio'],
    'Joshua': ['josue'], 'Judges': ['juizes'], 'Ruth': ['rute'], 'Samuel': ['samuel'], 'Kings': ['reis'], 'Chronicles': ['cronicas'],
    'Ezra': ['esdras'], 'Nehemiah': ['neemias'], 'Esther': ['ester'], 'Job': ['jo'], 'Psalms': ['salmos', 'salmo'], 'Proverbs': ['proverbios'],
    'Ecclesiastes': ['eclesiastes'], 'Song of Solomon': ['cantico dos canticos', 'canticos', 'cantares'], 'Isaiah': ['isaias'], 'Jeremiah': ['jeremias'],
    'Lamentations': ['lamentacoes'], 'Ezekiel': ['ezequiel'], 'Daniel': ['daniel'], 'Hosea': ['oseias'], 'Joel': ['joel'], 'Amos': ['amos'],
    'Obadiah': ['obadias'], 'Jonah': ['jonas'], 'Micah': ['miqueias'], 'Nahum': ['naum'], 'Habakkuk': ['habacuque'], 'Zephaniah': ['sofonias'],
    'Haggai': ['ageu'], 'Zechariah': ['zacarias'], 'Malachi': ['malaquias'], 'Matthew': ['mateus'], 'Mark': ['marcos'], 'Luke': ['lucas'],
    'John': ['joao'], 'Acts': ['atos dos apostolos', 'atos'], 'Romans': ['romanos'], 'Corinthians': ['corintios'], 'Galatians': ['galatas'],
    'Ephesians': ['efesios'], 'Philippians': ['filipenses'], 'Colossians': ['colossenses'], 'Thessalonians': ['tessalonicenses'], 'Timothy': ['timoteo'],
    'Titus': ['tito'], 'Philemon': ['filemom', 'filemon'], 'Hebrews': ['hebreus'], 'James': ['tiago'], 'Peter': ['pedro'], 'Jude': ['judas'],
    'Revelation': ['apocalipse'],
  },
  fr: {
    'Genesis': ['genese'], 'Exodus': ['exode'], 'Leviticus': ['levitique'], 'Numbers': ['nombres'], 'Deuteronomy': ['deuteronome'],
    'Joshua': ['josue'], 'Judges': ['juges'], 'Ruth': ['ruth'], 'Samuel': ['samuel'], 'Kings': ['rois'], 'Chronicles': ['chroniques'],
    'Ezra': ['esdras'], 'Nehemiah': ['nehemie'], 'Esther': ['esther'], 'Job': ['job'], 'Psalms': ['psaumes', 'psaume'], 'Proverbs': ['proverbes'],
    'Ecclesiastes': ['ecclesiaste'], 'Song of Solomon': ['cantique des cantiques', 'cantique'], 'Isaiah': ['esaie', 'isaie'], 'Jeremiah': ['jeremie'],
    'Lamentations': ['lamentations'], 'Ezekiel': ['ezechiel'], 'Daniel': ['daniel'], 'Hosea': ['osee'], 'Joel': ['joel'], 'Amos': ['amos'],
    'Obadiah': ['abdias'], 'Jonah': ['jonas'], 'Micah': ['michee'], 'Nahum': ['nahum'], 'Habakkuk': ['habacuc'], 'Zephaniah': ['sophonie'],
    'Haggai': ['aggee'], 'Zechariah': ['zacharie'], 'Malachi': ['malachie'], 'Matthew': ['matthieu'], 'Mark': ['marc'], 'Luke': ['luc'],
    'John': ['jean'], 'Acts': ['actes des apotres', 'actes'], 'Romans': ['romains'], 'Corinthians': ['corinthiens'], 'Galatians': ['galates'],
    'Ephesians': ['ephesiens'], 'Philippians': ['philippiens'], 'Colossians': ['colossiens'], 'Thessalonians': ['thessaloniciens'], 'Timothy': ['timothee'],
    'Titus': ['tite'], 'Philemon': ['philemon'], 'Hebrews': ['hebreux'], 'James': ['jacques'], 'Peter': ['pierre'], 'Jude': ['jude'],
    'Revelation': ['apocalypse'],
  },
  de: {
    'Genesis': ['genesis', 'erste mose', '1 mose'], 'Exodus': ['exodus', 'zweite mose', '2 mose'], 'Leviticus': ['levitikus', 'dritte mose', '3 mose'],
    'Numbers': ['numeri', 'vierte mose', '4 mose'], 'Deuteronomy': ['deuteronomium', 'funfte mose', '5 mose'],
    'Joshua': ['josua'], 'Judges': ['richter'], 'Ruth': ['rut', 'ruth'], 'Samuel': ['samuel'], 'Kings': ['konige'], 'Chronicles': ['chronik'],
    'Ezra': ['esra'], 'Nehemiah': ['nehemia'], 'Esther': ['ester', 'esther'], 'Job': ['hiob', 'ijob'], 'Psalms': ['psalmen', 'psalm'],
    'Proverbs': ['spruche', 'sprichworter'], 'Ecclesiastes': ['prediger', 'kohelet'], 'Song of Solomon': ['hohelied'], 'Isaiah': ['jesaja'],
    'Jeremiah': ['jeremia'], 'Lamentations': ['klagelieder'], 'Ezekiel': ['hesekiel', 'ezechiel'], 'Daniel': ['daniel'], 'Hosea': ['hosea'],
    'Joel': ['joel'], 'Amos': ['amos'], 'Obadiah': ['obadja'], 'Jonah': ['jona'], 'Micah': ['micha'], 'Nahum': ['nahum'], 'Habakkuk': ['habakuk'],
    'Zephaniah': ['zefanja', 'zephanja'], 'Haggai': ['haggai'], 'Zechariah': ['sacharja'], 'Malachi': ['maleachi'], 'Matthew': ['matthaus'],
    'Mark': ['markus'], 'Luke': ['lukas'], 'John': ['johannes'], 'Acts': ['apostelgeschichte'], 'Romans': ['romer'], 'Corinthians': ['korinther'],
    'Galatians': ['galater'], 'Ephesians': ['epheser'], 'Philippians': ['philipper'], 'Colossians': ['kolosser'], 'Thessalonians': ['thessalonicher'],
    'Timothy': ['timotheus'], 'Titus': ['titus'], 'Philemon': ['philemon'], 'Hebrews': ['hebraer'], 'James': ['jakobus'], 'Peter': ['petrus'],
    'Jude': ['judas'], 'Revelation': ['offenbarung'],
  },
};

// Books that take a 1/2/3 prefix, and how each language says the ordinal
// ("primera de Juan", "premier Jean", "erster Johannes", "1. Johannes").
const NUMBERED_BOOKS = ['Samuel', 'Kings', 'Chronicles', 'Corinthians', 'Thessalonians', 'Timothy', 'Peter', 'John'];
const ORDINALS = {
  es: { primera: 1, primero: 1, primer: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, tercer: 3 },
  pt: { primeira: 1, primeiro: 1, segunda: 2, segundo: 2, terceira: 3, terceiro: 3 },
  fr: { premier: 1, premiere: 1, deuxieme: 2, second: 2, seconde: 2, troisieme: 3 },
  de: { erste: 1, erster: 1, ersten: 1, erstes: 1, zweite: 2, zweiter: 2, zweiten: 2, zweites: 2, dritte: 3, dritter: 3, dritten: 3, drittes: 3 },
};
const ORDINAL_FILLERS = {
  es: ['de', 'a los', 'a', 'carta de', 'carta a los', 'epistola de', 'epistola a los', 'libro de', 'libro de los'],
  pt: ['de', 'aos', 'a', 'carta de', 'carta aos', 'epistola de', 'epistola aos', 'livro de', 'livro dos'],
  fr: ['aux', 'a', 'de', 'epitre de', 'epitre aux', 'lettre de', 'lettre aux', 'livre de', 'livre des'],
  de: ['brief an die', 'an die', 'brief des', 'buch der', 'buch'],
};
// German compounds: "erster Korintherbrief", "zweiter Petrusbrief".
const DE_LETTER_COMPOUNDS = { Corinthians: 'korintherbrief', Thessalonians: 'thessalonicherbrief', Timothy: 'timotheusbrief', Peter: 'petrusbrief', John: 'johannesbrief' };
const DE_MOSE = { Genesis: 1, Exodus: 2, Leviticus: 3, Numbers: 4, Deuteronomy: 5 };
const DE_MOSE_ORD = { 1: ['erste', 'erstes', 'ersten'], 2: ['zweite', 'zweites', 'zweiten'], 3: ['dritte', 'drittes', 'dritten'], 4: ['vierte', 'viertes', 'vierten'], 5: ['funfte', 'funftes', 'funften'] };

// chapter/verse words are always citation words. "to"/"and" connectors are
// ordinary words too ("il a vingt ans"), so they're only rewritten between numbers.
const KEYWORDS = {
  es: { chapter: ['capitulo', 'capitulos'], verse: ['versiculos', 'versiculo', 'versos', 'verso'], to: ['hasta el', 'hasta', 'al', 'a'], and: ['y'] },
  pt: { chapter: ['capitulo', 'capitulos'], verse: ['versiculos', 'versiculo', 'versos', 'verso'], to: ['ate o', 'ate', 'ao', 'a'], and: ['e'] },
  fr: { chapter: ['chapitre', 'chapitres'], verse: ['versets', 'verset'], to: ['jusqu au', 'jusqu a', 'au', 'a'], and: ['et'] },
  de: { chapter: ['kapitel'], verse: ['verse', 'vers'], to: ['bis zu', 'bis'], and: ['und'] },
};
// "versículos del 4 al 7", "du verset 4 au 7", "Verse von 4 bis 7".
const VERSE_ARTICLES = { es: ['del', 'de'], pt: ['do', 'de'], fr: ['du', 'de'], de: ['von'] };
// The spoken continuation triggers server.js listens for ("next verse" / "previous verse").
const TRIGGERS = {
  es: { 'next verse': ['siguiente versiculo', 'proximo versiculo', 'versiculo siguiente'], 'previous verse': ['versiculo anterior'] },
  pt: { 'next verse': ['proximo versiculo', 'versiculo seguinte'], 'previous verse': ['versiculo anterior'] },
  fr: { 'next verse': ['verset suivant', 'prochain verset'], 'previous verse': ['verset precedent'] },
  de: { 'next verse': ['nachste vers', 'nachster vers', 'nachsten vers', 'folgende vers', 'folgenden vers'], 'previous verse': ['vorherige vers', 'vorherigen vers'] },
};

const UNITS = {
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
    'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco',
    'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve'],
  pt: ['zero', 'um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze',
    'dezesseis', 'dezessete', 'dezoito', 'dezenove'],
  fr: ['zero', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze',
    'seize', 'dix sept', 'dix huit', 'dix neuf'],
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'funf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwolf', 'dreizehn', 'vierzehn',
    'funfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'],
};
const TENS = {
  es: { veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 },
  pt: { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 },
  fr: { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, 'soixante dix': 70, 'quatre vingt': 80, 'quatre vingts': 80, 'quatre vingt dix': 90 },
  de: { zwanzig: 20, dreissig: 30, vierzig: 40, funfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 },
};
const HUNDRED = { es: ['ciento', 'cien'], pt: ['cento', 'cem'], fr: ['cent'], de: ['hundert', 'einhundert'] };
// Forms of "one" that are also the indefinite article ("un hombre", "ein Mann");
// only read as 1 in citation position (after a book, chapter/verse word, or number).
const ARTICLE_ONE = { es: ['un', 'una'], pt: ['um', 'uma'], fr: ['un', 'une'], de: ['ein', 'eine'] };

const COMPILED = {};
function compile(lang) {
  if (COMPILED[lang]) return COMPILED[lang];
  const map = new Map();
  const books = new Set();
  const add = (from, to) => { if (!map.has(from)) map.set(from, to); };
  for (const [en, names] of Object.entries(BOOKS[lang])) {
    const target = en.toLowerCase();
    books.add(target.split(' ').pop());
    const all = names.concat(lang === 'de' && DE_LETTER_COMPOUNDS[en] ? [DE_LETTER_COMPOUNDS[en]] : []);
    for (const name of all) {
      add(name, target);
      if (!NUMBERED_BOOKS.includes(en)) continue;
      for (const [o, n] of Object.entries(ORDINALS[lang])) {
        add(`${o} ${name}`, `${n} ${target}`);
        for (const f of ORDINAL_FILLERS[lang]) add(`${o} ${f} ${name}`, `${n} ${target}`);
      }
    }
  }
  if (lang === 'de') {
    for (const [en, n] of Object.entries(DE_MOSE)) {
      const target = en.toLowerCase();
      add(`${n} mose`, target); add(`${n} buch mose`, target);
      for (const o of DE_MOSE_ORD[n]) { add(`${o} mose`, target); add(`${o} buch mose`, target); }
    }
  }
  for (const [en, list] of Object.entries(TRIGGERS[lang])) for (const w of list) add(w, en);
  for (const k of ['chapter', 'verse']) for (const w of KEYWORDS[lang][k]) add(w, k);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = (list) => list.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
  const nums = new Map();
  UNITS[lang].forEach((w, i) => nums.set(w, i));
  if (lang === 'pt') nums.set('duas', 2);
  for (const [w, n] of Object.entries(TENS[lang])) nums.set(w, n);
  COMPILED[lang] = {
    phraseRe: new RegExp(`(?<![a-z0-9])(?:${keys.map(esc).join('|')})(?![a-z0-9])`, 'g'),
    map, books, nums,
    articleRe: new RegExp(`\\b(chapter|verse) (?:${words(VERSE_ARTICLES[lang])}) (\\d)`, 'g'),
    toRe: new RegExp(`(\\d) (?:${words(KEYWORDS[lang].to)}) (?:(?:verse|${words(VERSE_ARTICLES[lang])}) )?(\\d)`, 'g'),
    andRe: new RegExp(`(\\d) (?:${words(KEYWORDS[lang].and)}) (?:verse )?(\\d)`, 'g'),
  };
  return COMPILED[lang];
}

// German writes numbers as one word: "dreiundzwanzig", "hundertneunzehn".
function germanWordNumber(w, nums) {
  if (nums.has(w)) return nums.get(w);
  for (const h of ['einhundert', 'hundert']) {
    if (w.startsWith(h) && w.length > h.length) { const r = germanWordNumber(w.slice(h.length), nums); return r == null ? null : 100 + r; }
  }
  const m = /^([a-z]+)und([a-z]+)$/.exec(w);
  if (m) {
    const u = m[1] === 'ein' ? 1 : nums.get(m[1]), t = TENS.de[m[2]];
    if (u != null && u > 0 && u < 10 && t != null) return t + u;
  }
  return null;
}

// Turn runs of number words into digits: "ciento diecinueve", "treinta y uno",
// "vingt et un", "quatre vingt dix neuf", "einundzwanzig".
function numbersToDigits(words, lang, c) {
  const { nums, books } = c, hundreds = HUNDRED[lang], ands = KEYWORDS[lang].and;
  const citationSlot = (prev) => prev != null && (prev === 'chapter' || prev === 'verse' || /^\d+$/.test(prev) || books.has(prev));
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (lang === 'de') {
      const n = germanWordNumber(w, nums);
      if (n != null && n > 0) { out.push(String(n)); continue; }
    }
    if (ARTICLE_ONE[lang].includes(w)) { out.push(citationSlot(out[out.length - 1]) ? '1' : w); continue; }
    let value = null, j = i;
    if (hundreds.includes(w)) {
      value = 100; j = i + 1;
      if (ands.includes(words[j]) && nums.has(words[j + 1])) j++;          // "cento e dezenove"
    }
    const part = () => {
      for (const len of [3, 2]) {                                          // "quatre vingt dix", "dix sept"
        const p = words.slice(j, j + len).join(' ');
        if (nums.has(p)) { j += len; return nums.get(p); }
      }
      if (nums.has(words[j])) return nums.get(words[j++]);
      return null;
    };
    const first = part();
    if (first != null) {
      value = (value || 0) + first;
      if (first >= 20 && first % 10 === 0) {                               // "<tens> [y/e/et] <unit>"
        let k = j;
        if (ands.includes(words[k])) k++;
        const unitWord = words[k];
        const u = (unitWord === 'un' || unitWord === 'une' || unitWord === 'uma' || unitWord === 'una') ? 1 : nums.get(unitWord);
        const maxUnit = lang === 'fr' && (first === 60 || first === 80) ? 20 : 10;   // "soixante douze"
        if (u != null && u > 0 && u < maxUnit) { value += u; j = k + 1; }
      }
    }
    if (value != null && value > 0) { out.push(String(value)); i = j - 1; continue; }
    out.push(w);
  }
  return out;
}

/**
 * Rewrite a localized spoken citation into English citation tokens.
 * lang: 'es' | 'pt' | 'fr' | 'de' (region suffixes like 'pt-BR' are fine).
 * Returns the input unchanged for English or unsupported languages.
 */
function localizeCitationText(text, lang) {
  const l = String(lang || '').slice(0, 2).toLowerCase();
  if (!BOOKS[l] || typeof text !== 'string' || !text) return text;
  const c = compile(l);
  let t = fold(text).replace(/ß/g, 'ss');
  if (l === 'de') t = t.replace(/\b([1-5])\.\s/g, '$1 ');                  // "1. Korinther"
  t = t.replace(/(\d)\s*[:.]\s*(\d)/g, '$1 $2').replace(/[.,;:!?¿¡"()]/g, ' ')
    .replace(/[-']/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(c.phraseRe, (m) => c.map.get(m));
  t = numbersToDigits(t.split(' '), l, c).join(' ');
  return t.replace(c.articleRe, '$1 $2').replace(c.toRe, '$1 to $2').replace(c.andRe, '$1 and $2');
}

module.exports = { localizeCitationText, stripAccents };
