// KAIRO — resolve a verse INSIDE a chapter the preacher already named.
//
// Two situations, one ranking mechanism:
//   1. "Turn to Matthew 11 ..." with no verse: find the verse from the words
//      that follow (a spoken "28," callout first, then identifying-word match).
//   2. A citation whose verse number doesn't exist in its chapter ("Genesis 24
//      verse 83", a 67-verse chapter): recover the verse from recent speech.
// Both are strictly scoped to the named book+chapter, so they can never jump
// to an unrelated book. Ranking runs in the detection worker (scoreChapterText:
// stem-aware, IDF-weighted, so everyday words add almost nothing).
//
// Dependencies are injected so this module has no server state and is testable:
//   workerCall(type, payload, timeoutMs) -> Promise<{ ...worker reply }>
//   getRecentText() -> string   (the recent transcript buffer, for case 2)
'use strict';

// Calibrated against real cases — see chapter_keyword_and_correction_collision.test.js.
const CHAPTER_KEYWORD_MIN_IDF = 14;
const CHAPTER_KEYWORD_MIN_MARGIN = 2;
const RE_SPACES = /\s+/;

function createChapterResolver({ workerCall, getRecentText }) {
  // Rank one chapter's verses against spoken text; return the winner only if
  // it is both strong enough and clearly ahead of the runner-up.
  async function pickChapterVerseByIdf(book, chapter, text) {
    const scored = await workerCall('scoreChapterText', { book, chapter, text }, 5000);
    const [best, second] = scored.results || [];
    if (process.env.KAIRO_DEBUG_CHAPTER_IDF) console.log(`[ChapterIDF] ${book} ${chapter} best=${best?.verse} idf=${best?.idfSum?.toFixed(1)} hit=${best?.hit}/${best?.total} second=${second?.verse} idf=${second?.idfSum?.toFixed(1)} text="${text.slice(0, 70)}"`);
    if (best && best.idfSum >= CHAPTER_KEYWORD_MIN_IDF && best.idfSum - (second?.idfSum || 0) >= CHAPTER_KEYWORD_MIN_MARGIN) {
      const { idfSum, hit, total, ...verseOnly } = best;
      return [verseOnly];
    }
    return [];
  }

  // Case 2. Scored against the recent transcript buffer.
  async function resolveInvalidVerseByContext(book, chapter) {
    try {
      const recent = getRecentText();
      return recent ? await pickChapterVerseByIdf(book, chapter, recent) : [];
    } catch { return []; }
  }

  // Case 1. Scores ONLY the text passed in (the words since this chapter was
  // named), never the global rolling buffer — stale earlier sermon content
  // dilutes the match (real incident: Matthew 11:28 resolved to 11:17, then
  // 11:27). A clause-initial verse number with Deepgram's own punctuation after
  // it ("...me. 28, all you...") is far stronger evidence than word overlap, so
  // it is checked first, against the chapter's real verse list. Requiring the
  // trailing comma/period keeps "12 disciples went" from matching.
  async function resolveChapterByKeywords(book, chapter, text) {
    try {
      const msg = await workerCall('chapterLookup', { book, chapter }, 5000);
      const chapterVerses = msg.results || [];
      if (!chapterVerses.length) return [];

      const bookWord = String(book).toLowerCase().split(' ').pop();
      const mentionAt = text.toLowerCase().lastIndexOf(bookWord);
      const afterMention = mentionAt >= 0 ? text.slice(mentionAt + bookWord.length) : text;
      const scanText = afterMention.split(RE_SPACES).filter(Boolean).slice(0, 40).join(' ');
      const callout = /(?:^|[.!?;,]\s+)(\d{1,3})\s*[,.](?=\s|$)/g;
      let cm;
      while ((cm = callout.exec(scanText)) !== null) {
        const n = parseInt(cm[1], 10);
        if (n === chapter) continue;               // the chapter number itself, not a verse callout
        const exact = chapterVerses.find(v => v.verse === n);
        if (exact) return [exact];
      }
      return await pickChapterVerseByIdf(book, chapter, text);
    } catch { return []; }
  }

  return { pickChapterVerseByIdf, resolveInvalidVerseByContext, resolveChapterByKeywords };
}

module.exports = { createChapterResolver, CHAPTER_KEYWORD_MIN_IDF, CHAPTER_KEYWORD_MIN_MARGIN };
