// KAIRO — Shared per-word/per-character DOM splitting for the Text
// Animation family (Word, Activate, Karaoke, Typewriter, Impact, Bold
// Caption, Bounce, Highlight Box, Shimmer)
//
// This is a TEXT ANIMATION (how the verse text itself reveals once
// painted) — a separate concern from a theme's Transition (Fade/Slide/Cut,
// how the whole slide swaps when new content arrives). A theme picks both
// independently: e.g. Transition: Cut + Text Animation: Word is the usual
// pairing for a Motion theme (no redundant container fade on top of the
// per-word reveal), but Transition: Fade + Text Animation: Bounce is just
// as valid if that's the combined look someone wants.
//
// Each builder splits text into small inline-block spans so every word (or
// character) can carry its own staggered CSS reveal animation (see the
// @keyframes kairo-word-*/kairo-char-* rules in styles.css). Whitespace
// between words always stays a plain text node, never a span — that's what
// lets line-wrapping behave exactly as it does for an ordinary text node;
// only word/character element boundaries are added. Loaded by both
// index.html and display.html so app.js/service.js/display.html share one
// implementation.
'use strict';

// Every text animation this module knows how to render as a per-element
// reveal. Callers use this to decide whether the container-level Transition
// choreography should still run alongside it — Cut always skips it
// regardless (nothing to fade), and 'none' just means plain text with
// whatever Transition the theme picked.
const TEXT_ANIMATIONS = ['word-in', 'activate', 'karaoke', 'typewriter', 'impact', 'bold-caption', 'bounce', 'highlight-box', 'shimmer'];
function isPerElementMotion(animation) {
  return TEXT_ANIMATIONS.includes(animation);
}

// Shared word-splitting core: one <span> per word (class + per-word timing
// vars), whitespace left as plain text nodes. See the file header for why
// everything goes into one inner `wrap` div rather than straight into
// `container` — text layers vertically-center via flex on the layer div
// itself, and a flex parent with many direct children (one per word) would
// lay each one out as its own flex item instead of letting them wrap
// together as a sentence.
function splitWords(container, text, className, speedMultiplier, { staggerBaseMs, durBaseMs }) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  const staggerMs = Math.max(20, Math.round(staggerBaseMs * speedMultiplier));
  const durMs = Math.round(durBaseMs * speedMultiplier);
  let wordIndex = 0;
  String(text || '').split(/(\s+)/).forEach(tok => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) { wrap.appendChild(document.createTextNode(tok)); return; }
    const span = document.createElement('span');
    span.className = className;
    span.textContent = tok;
    span.style.setProperty('--kairo-word-delay', `${wordIndex * staggerMs}ms`);
    span.style.setProperty('--kairo-word-dur', `${durMs}ms`);
    wordIndex++;
    wrap.appendChild(span);
  });
  container.appendChild(wrap);
  return wrap.querySelectorAll('.' + className);
}

// "Word" — bold, punchy broadcast/LED-wall style: each word starts
// oversized, slightly tilted, and transparent, and snaps into place with a
// small overshoot (see @keyframes kairo-word-in in styles.css).
function buildWordSpans(container, text, speedMultiplier = 1) {
  return splitWords(container, text, 'kairo-word', speedMultiplier, { staggerBaseMs: 60, durBaseMs: 260 });
}

// "Activate" — inspired by Final Cut Pro's "Activate" title: each word
// starts dim and desaturated, then flashes up to full brightness with a
// brief glow as it "activates", settling at its normal color. Reads as an
// energetic scan/power-on rather than Word's tilt-and-drop.
function buildActivateSpans(container, text, speedMultiplier = 1) {
  return splitWords(container, text, 'kairo-word-activate', speedMultiplier, { staggerBaseMs: 90, durBaseMs: 420 });
}

// "Karaoke" — classic sing-along chase: each word sits dim ("unsung") until
// its turn, then snaps instantly (not a fade) to fully lit and stays that
// way, same rhythm as a bouncing-ball lyric video. The snap is a `steps()`
// timing function rather than an eased opacity ramp, so it reads as a
// discrete flip, not a glow — see @keyframes kairo-word-karaoke. If a
// Highlight Color is set, the "sung" state switches to that color as well
// as full opacity (real karaoke videos usually do change color, not just
// brighten); with no color configured, only opacity changes and the word
// keeps the layer's own color throughout.
function buildKaraokeSpans(container, text, speedMultiplier = 1, opts = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  const staggerMs = Math.max(20, Math.round(70 * speedMultiplier));
  let wordIndex = 0;
  String(text || '').split(/(\s+)/).forEach(tok => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) { wrap.appendChild(document.createTextNode(tok)); return; }
    const span = document.createElement('span');
    span.className = 'kairo-word-karaoke';
    span.textContent = tok;
    if (opts.color) span.style.setProperty('--kairo-highlight-color', opts.color);
    span.style.setProperty('--kairo-word-delay', `${wordIndex * staggerMs}ms`);
    wordIndex++;
    wrap.appendChild(span);
  });
  container.appendChild(wrap);
  return wrap.querySelectorAll('.kairo-word-karaoke');
}

// "Bounce" — springy pop-on, the rhythm most "TikTok bounce" caption
// presets use: each word overshoots well past 100% size on the way in and
// settles with a couple of decreasing wobbles, rather than Word's single
// gentle overshoot. Higher-energy/more elastic than Word — a distinct feel,
// not just a speed difference.
function buildBounceSpans(container, text, speedMultiplier = 1) {
  return splitWords(container, text, 'kairo-word-bounce', speedMultiplier, { staggerBaseMs: 70, durBaseMs: 520 });
}

// "Typewriter" — one character at a time, as if being typed, with a
// blinking caret that appears once the last character lands. Splits on
// individual characters WITHIN each word (word boundaries come from the
// same whitespace-preserving split every other builder uses, so wrapping
// still behaves normally at real spaces) while the stagger index keeps
// counting continuously across the whole string, not resetting per word,
// so the reveal reads as one steady left-to-right typing motion.
function buildTypewriterSpans(container, text, speedMultiplier = 1) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  const staggerMs = Math.max(14, Math.round(28 * speedMultiplier));
  let charIndex = 0;
  String(text || '').split(/(\s+)/).forEach(tok => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) { wrap.appendChild(document.createTextNode(tok)); charIndex += tok.length; return; }
    [...tok].forEach(ch => {
      const span = document.createElement('span');
      span.className = 'kairo-char';
      span.textContent = ch;
      span.style.setProperty('--kairo-word-delay', `${charIndex * staggerMs}ms`);
      charIndex++;
      wrap.appendChild(span);
    });
  });
  const caret = document.createElement('span');
  caret.className = 'kairo-caret';
  caret.style.setProperty('--kairo-word-delay', `${charIndex * staggerMs}ms`);
  wrap.appendChild(caret);
  container.appendChild(wrap);
  return wrap.querySelectorAll('.kairo-char');
}

// "Impact" — the "Hormozi preset"/CapCut-style dynamic caption: most words
// pop in at normal size, but a handful of "hit" words are enlarged,
// bolder, and highlight-colored, same visual language as the keyword-
// highlight captions that have dominated short-form video since ~2023.
// There's no real emphasis/audio-timing data to draw on here (unlike a
// caption tool transcribing spoken emphasis), so hit words are picked
// deterministically from the text itself — long words and Capitalized ones
// (proper nouns: "God", "Christ", names of books) read as the meaningful
// words in a sentence far more often than "the/a/and/of" do. Deterministic
// (not random) so the same verse highlights the same words every time it's
// shown, not a different flicker on every replay. `intensity` (0.5–2, see
// Theme Studio's Intensity slider) scales how much bigger a hit word runs.
const IMPACT_STOPWORDS = new Set(['a','an','the','and','or','but','of','to','in','on','at','for','is','are','was','were','be','been','it','as','with','that','this','these','those','his','her','their','our','your','my','i','he','she','they','we','you','not','so','if','then']);
function isImpactHit(word) {
  const clean = word.replace(/[^\p{L}\p{N}']/gu, '');
  if (!clean) return false;
  if (IMPACT_STOPWORDS.has(clean.toLowerCase())) return false;
  return clean.length >= 6 || /^[A-Z]/.test(clean);
}
function buildImpactSpans(container, text, speedMultiplier = 1, opts = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  const staggerMs = Math.max(20, Math.round(60 * speedMultiplier));
  const durMs = Math.round(300 * speedMultiplier);
  const scale = (1 + 0.22 * (opts.intensity ?? 1)).toFixed(3);
  let wordIndex = 0;
  String(text || '').split(/(\s+)/).forEach(tok => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) { wrap.appendChild(document.createTextNode(tok)); return; }
    const hit = isImpactHit(tok);
    const span = document.createElement('span');
    span.className = 'kairo-word-impact' + (hit ? ' kairo-word-impact-hit' : '');
    span.textContent = tok;
    if (hit) {
      span.style.setProperty('--kairo-impact-scale', scale);
      span.style.color = opts.color || '#ffd23f';
    }
    span.style.setProperty('--kairo-word-delay', `${wordIndex * staggerMs}ms`);
    span.style.setProperty('--kairo-word-dur', `${durMs}ms`);
    wordIndex++;
    wrap.appendChild(span);
  });
  container.appendChild(wrap);
  return wrap.querySelectorAll('.kairo-word-impact');
}

// "Bold Caption" — the tightly-stacked, mixed-size headline look from
// viral short-form editing (per Ben Kaluza's "The Most Viral Caption Style
// Revealed" — big words get noticeably TIGHTENED letter-spacing, "kern
// that bad boy... squishing the letters together" — and a second reference
// showing short word-groups stacked line-by-line, each line starting at
// its OWN horizontal position rather than a single flush-left margin, e.g.
// "How"/"To" sharing a line, "edit" on the next indented differently).
// Three earlier versions of this missed the mark: one rotated/jittered
// every word (no tilt in the actual style), one ran every word through one
// flowing centered paragraph, one hugged a single flush-left margin and
// stayed too small for its box (a real side-by-side against the
// reference — not just a screenshot of ours in isolation — showed all of
// this). Every word runs at a flat, heavy weight (900) — the style's whole
// visual identity is "everything is already bold", so size is the only
// thing distinguishing a punch word from a normal one. Deterministic per
// word (hashWord)/per line (line index), not random — the same verse
// always lays out the same way across replays. `intensity` (0.5–2) scales
// how far the big words swing from 1.0 and how tight their kerning gets.
function hashWord(word) {
  let h = 0;
  for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0;
  return h;
}
// Mostly clustered near 1.0 (most words stay a normal, bold size) with a
// few dramatic spikes — a uniform spread across every value here would
// make EVERY word oversized, reading as a huge wall of text rather than a
// few words popping out of a normal sentence.
const BOLDCAP_SIZES = [1.0, 1.0, 0.7, 1.0, 1.85, 1.0, 0.85, 2.4, 1.0, 1.5];
// Per-line indent variance was tried here (each stacked line starting at
// its own horizontal position, matching a reference's asymmetric "How"/
// "edit" groupings) and reverted — on a real multi-line Bible verse (not a
// short, hand-curated 2-3-word caption) a few lines in a row trending
// further right in the cycle read, at a glance, as the WHOLE block sitting
// crooked/rotated rather than "each line has its own position", even
// though every individual line is still perfectly horizontal. Flush left
// throughout is more legible for a live display, which is what actually
// matters here over matching a fast-cut social-video composition.
const BOLDCAP_INDENTS = [0];

// Breaks verse text into short line groups — natural pause punctuation
// first, then re-chunked by word count so nothing runs long — each becomes
// its own tightly-stacked line, matching the reference's "How To" / "edit"
// groupings rather than one continuous sentence. Words-per-line SCALES UP
// with the verse's total length (3 for a short verse, up to 6 for a long
// one) rather than a fixed 3 always — a fixed chunk size means a long
// verse turns into many more lines, which the fit-to-box step (see
// buildBoldCapSpans) then has to shrink the font drastically to fit
// vertically; text that small needs a huge horizontal stretch to still
// reach the box's width, and stretching bold display type 4-5× wider than
// tall visibly warps every letter's diagonal strokes until the whole line
// reads as "slanted". Keeping line count roughly bounded regardless of
// verse length keeps the natural block's proportions closer to the box's
// own, so no correction anywhere near that extreme is ever needed.
function splitBoldCapLines(text) {
  const allWords = String(text || '').split(/\s+/).filter(Boolean);
  const perLine = allWords.length <= 12 ? 3 : allWords.length <= 24 ? 4 : allWords.length <= 40 ? 5 : 6;
  const rough = String(text || '').split(/(?<=[,;:])\s+/).map(s => s.trim()).filter(Boolean);
  const lines = [];
  rough.forEach(chunk => {
    const words = chunk.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += perLine) lines.push(words.slice(i, i + perLine));
  });
  return lines.length ? lines : [allWords];
}

function buildBoldCapSpans(container, text, speedMultiplier = 1, opts = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  // width:max-content (shrink-wrapped to its own content, not stretched to
  // the container) — required for the fit-to-box scaling below to measure
  // and scale the ACTUAL text size rather than an artificial full-width
  // box. Each line's em-based indent (not a percentage) is what makes
  // per-line horizontal variation still possible without wrap needing a
  // real width to resolve percentages against.
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;justify-content:center;width:max-content;';
  const staggerMs = Math.max(40, Math.round(90 * speedMultiplier));
  const durMs = Math.round(360 * speedMultiplier);
  const intensity = opts.intensity ?? 1;
  let wordIndex = 0;
  splitBoldCapLines(text).forEach((words, lineIndex) => {
    const lineEl = document.createElement('div');
    // Tight leading + a small negative top margin (after the first line)
    // packs lines close enough to nearly touch, matching the reference's
    // dense stacking — a normal paragraph's line-height/margin would leave
    // each short line looking like its own isolated caption instead of one
    // cascading headline.
    lineEl.style.cssText = 'display:flex;flex-wrap:wrap;align-items:baseline;column-gap:0.3em;line-height:0.9;'
      + `margin-left:${BOLDCAP_INDENTS[lineIndex % BOLDCAP_INDENTS.length]}em;`
      + (lineIndex > 0 ? 'margin-top:-0.05em;' : '');
    words.forEach(word => {
      const h = hashWord(word);
      const span = document.createElement('span');
      span.className = 'kairo-word-boldcap';
      span.textContent = word;
      // Scale each multiplier's distance from 1.0 by `intensity` rather
      // than the raw table value, so intensity affects how FAR the big
      // words pop from a plain uniform paragraph, not just re-picking
      // fixed sizes.
      const sizeBase = BOLDCAP_SIZES[h % BOLDCAP_SIZES.length];
      const size = 1 + (sizeBase - 1) * intensity;
      span.style.fontSize = size.toFixed(3) + 'em';
      // "Kern that bad boy" — the bigger a word runs, the tighter (more
      // negative) its letter-spacing, so it reads as squished-together
      // bold display type rather than just a scaled-up copy of body text.
      span.style.letterSpacing = (size > 1 ? -0.03 * (size - 1) : 0).toFixed(3) + 'em';
      span.style.setProperty('--kairo-word-delay', `${wordIndex * staggerMs}ms`);
      span.style.setProperty('--kairo-word-dur', `${durMs}ms`);
      wordIndex++;
      lineEl.appendChild(span);
    });
    wrap.appendChild(lineEl);
  });
  container.appendChild(wrap);
  // Fill the verse box as fully as possible while still fitting BOTH
  // dimensions — same "as large as possible, fully contained" math as CSS
  // object-fit:contain. A fixed base size either looked tiny in a corner
  // for a short verse or overflowed a long one; this instead measures the
  // block's actual rendered size after one real layout pass (sizes aren't
  // knowable before paint) and applies the needed scale as ONE extra font-
  // size multiplier on `wrap` — every word's own em-based size cascades
  // from it, so a single number rescales the whole block without touching
  // each word individually.
  requestAnimationFrame(() => {
    const cw = container.clientWidth, ch = container.clientHeight;
    if (cw < 10 || ch < 10) return; // not laid out yet
    const nw = wrap.scrollWidth, nh = wrap.scrollHeight;
    if (nw < 1 || nh < 1) return;
    const targetW = cw * 0.96, targetH = ch * 0.94;
    const fitScale = Math.min(targetW / nw, targetH / nh);
    wrap.style.fontSize = fitScale.toFixed(3) + 'em';
    // A uniform scale alone only fills whichever axis was the TIGHTER
    // constraint (usually height, in this landscape box), leaving empty
    // width. A small width-only stretch closes minor gaps — but capped
    // well short of anything that would visibly warp letterforms: an
    // EARLIER version stretched however far was needed to fully close the
    // gap, which for a long verse (many lines, so a much smaller fit-
    // font-size) meant a 4-5× horizontal stretch — enough to bend every
    // diagonal stroke in the font until whole lines visibly read as
    // "slanted". splitBoldCapLines's own adaptive line length (see there)
    // is the real fix for that case; this cap is just a backstop so even
    // an unusual verse shape never gets stretched past a barely-
    // perceptible amount.
    const nw2 = wrap.scrollWidth; // re-measure — now reflects the new font-size
    if (nw2 > 1 && nw2 < targetW) {
      const stretch = Math.min(1.12, targetW / nw2);
      wrap.style.transform = `scaleX(${stretch.toFixed(3)})`;
      wrap.style.transformOrigin = 'left center';
    }
  });
  return wrap.querySelectorAll('.kairo-word-boldcap');
}

// "Highlight Box" — the animated background-pill caption style (YouTube/
// Descript-style "spotlight" captions): a solid highlight-colored box
// appears behind each word in turn as it's "read", sliding along word by
// word rather than changing the word's own color/size the way Karaoke
// does. Genuinely different mechanic from Karaoke (a moving background
// box vs. a text-opacity chase) even though the rhythm is similar.
function buildHighlightBoxSpans(container, text, speedMultiplier = 1, opts = {}) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  const staggerMs = Math.max(60, Math.round(140 * speedMultiplier));
  let wordIndex = 0;
  String(text || '').split(/(\s+)/).forEach(tok => {
    if (!tok) return;
    if (/^\s+$/.test(tok)) { wrap.appendChild(document.createTextNode(tok)); return; }
    const span = document.createElement('span');
    span.className = 'kairo-word-highlightbox';
    span.textContent = tok;
    span.style.setProperty('--kairo-highlight-color', opts.color || '#ffd23f');
    span.style.setProperty('--kairo-word-delay', `${wordIndex * staggerMs}ms`);
    wordIndex++;
    wrap.appendChild(span);
  });
  container.appendChild(wrap);
  return wrap.querySelectorAll('.kairo-word-highlightbox');
}

// "Shimmer" — a soft gradient sweep across the whole line, the "premium
// title card" look (metallic/glossy sheen passing over the text once).
// Unlike every other transition here this isn't per-word at all — it's one
// continuous background-clip:text gradient animated across the full verse
// box in a single pass, closer to a cinematic title treatment than a
// caption style.
function buildShimmerSpans(container, text, speedMultiplier = 1) {
  // Captured BEFORE clearing/appending — the gradient's dark stops need
  // the layer's actual configured text color (see the CSS comment on
  // .kairo-shimmer for why currentColor can't be used directly once this
  // span sets its own color to transparent).
  const baseColor = getComputedStyle(container).color || '#ffffff';
  container.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'kairo-shimmer';
  span.textContent = text || '';
  span.style.setProperty('--kairo-shimmer-base', baseColor);
  span.style.setProperty('--kairo-shimmer-dur', `${Math.round(1400 * speedMultiplier)}ms`);
  container.appendChild(span);
  return [span];
}

// Single dispatch point for every per-element text animation — used by
// every renderer (Theme Studio canvas, Live Preview, real display output,
// thumbnails) instead of each one duplicating its own animation-name
// switch. Returns true if it painted `container` itself (caller should NOT
// also set plain textContent), false for any animation it doesn't own
// (caller falls back to plain text — this includes 'none'/undefined).
// `opts` — { color, intensity } — only Impact/Bold Caption/Karaoke/Highlight Box
// read them; every other animation ignores extra opts harmlessly.
function applyMotionText(container, animation, text, speedMultiplier = 1, opts = {}) {
  if (animation === 'word-in')       { buildWordSpans(container, text, speedMultiplier); return true; }
  if (animation === 'activate')      { buildActivateSpans(container, text, speedMultiplier); return true; }
  if (animation === 'karaoke')       { buildKaraokeSpans(container, text, speedMultiplier, opts); return true; }
  if (animation === 'typewriter')    { buildTypewriterSpans(container, text, speedMultiplier); return true; }
  if (animation === 'impact')        { buildImpactSpans(container, text, speedMultiplier, opts); return true; }
  if (animation === 'bold-caption')       { buildBoldCapSpans(container, text, speedMultiplier, opts); return true; }
  if (animation === 'bounce')        { buildBounceSpans(container, text, speedMultiplier); return true; }
  if (animation === 'highlight-box') { buildHighlightBoxSpans(container, text, speedMultiplier, opts); return true; }
  if (animation === 'shimmer')       { buildShimmerSpans(container, text, speedMultiplier); return true; }
  return false;
}

window.KairoWordSplit = {
  buildWordSpans, buildActivateSpans, buildKaraokeSpans, buildTypewriterSpans,
  buildImpactSpans, buildBoldCapSpans, buildBounceSpans, buildHighlightBoxSpans, buildShimmerSpans,
  applyMotionText, isPerElementMotion, TEXT_ANIMATIONS,
};
