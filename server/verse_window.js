// KAIRO — longest run of a verse's words that appears in the transcript.
//
// Semantics are those of the original brute-force search in verbatimSearch's
// long-verse pass (kept here as bruteForceWindow for the equivalence test):
// the longest window verse[i..i+len) (minWords <= len <= cap) whose space-joined
// text occurs as a SUBSTRING of the space-joined transcript, earliest i winning
// ties. Substring matching means the window's first word may match the end of
// a transcript word and its last word the start of one; every word in between
// must match exactly.
//
// The brute force built every window as a new string (O(V^2) joins, each an
// O(T) search) — ~96% of verbatimSearch's time, ~150ms per call on real
// interims. This does one O(V*T) pass instead.
'use strict';

function longestWindow(verse, t, minWords, cap) {
  const V = verse.length, T = t.length;
  if (!V || !T) return null;
  // run[a*(T+1)+b] = number of exactly-equal words starting at verse[a], t[b].
  const W = T + 1;
  const run = new Uint16Array((V + 1) * W);
  for (let a = V - 1; a >= 0; a--) {
    for (let b = T - 1; b >= 0; b--) {
      if (verse[a] === t[b]) run[a * W + b] = 1 + run[(a + 1) * W + b + 1];
    }
  }
  let bestLen = 0, bestStart = -1;
  for (let i = 0; i < V; i++) {
    for (let k = 0; k < T; k++) {
      if (!t[k].endsWith(verse[i])) continue;              // first word: suffix of a transcript word
      const r = (i + 1 < V && k + 1 < T) ? run[(i + 1) * W + k + 1] : 0;
      let len = 1 + r;                                      // exact interior (the last exact word also satisfies "prefix")
      const ni = i + 1 + r, nk = k + 1 + r;
      if (ni < V && nk < T && t[nk].startsWith(verse[ni])) len++;   // last word: prefix of a transcript word
      if (len > cap) len = cap;
      if (len > bestLen) { bestLen = len; bestStart = i; }
    }
  }
  // A one-word window has no space in it, so the substring search can find it
  // anywhere inside a transcript word, not only at its end. (Production always
  // asks for 4+ words; this keeps the result identical for any input.)
  if (bestLen < 2 && cap >= 1) {
    bestLen = 0; bestStart = -1;
    for (let i = 0; i < V && bestStart < 0; i++) {
      for (let k = 0; k < T; k++) if (t[k].includes(verse[i])) { bestLen = 1; bestStart = i; break; }
    }
  }
  return bestLen >= minWords ? { len: bestLen, start: bestStart } : null;
}

// Reference implementation — the original algorithm, used only by tests.
function bruteForceWindow(verse, t, minWords, cap) {
  const text = t.join(' ');
  for (let len = Math.min(verse.length, cap); len >= minWords; len--) {
    for (let i = 0; i <= verse.length - len; i++) {
      if (text.includes(verse.slice(i, i + len).join(' '))) return { len, start: i };
    }
  }
  return null;
}

module.exports = { longestWindow, bruteForceWindow };
