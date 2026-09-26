// KAIRO — detection thresholds shared by the main process (server.js), the
// detection worker thread and the scoring model. Each of these used to be
// re-declared in 2-3 files with a "MUST stay in sync" comment; a drifted copy
// silently changes what reaches the live screen, so there is one definition.
// Pure values only — no requires, safe to load from a worker thread.
'use strict';

module.exports = {
  // The auto-send bar: anything scoring below this never goes straight to the viewer.
  VIEWER_MIN_SCORE: 0.80,
  // Verbatim's own length-score denominator: matched IDF weight at which length stops limiting.
  IDF_FULL_CONFIDENCE: 8,
  // Absolute-evidence bar for verbatim's "certain despite partial coverage" path. 18 (not
  // 14-17) after "twelve disciples"-style repeated common phrases cleared the lower bars.
  VERBATIM_CERTAIN_IDF: 18,
  // Minimum identifying weight for a streaming anchor to count as confirmed (also the worker's
  // ANCHOR_CONFIRM_IDF). Raised 8 -> 12 after "praise the Lord" cleared 8 against Psalms 150:6.
  STREAM_IDF_FULL_CONFIDENCE: 12,
  // How long a sent book stays "active" for continuity decisions.
  SAME_BOOK_WINDOW_MS: 60000,
  // Score bonus when two independent methods agree on the same verse.
  ENSEMBLE_BOOST: 0.08,
};
