# English translation sources

Real, distinct verse text for the "Translation" setting — swapped in by
`applyTranslation()` in `server/server.js`. KJV and NLT are the exception:
they don't need a file here at all — KJV is already the detection corpus's
own text (`databases/bibles/map.json`), and NLT rides along on that same
file's `nlt_text` field. NKJV/NIV/ESV/NASB below are the four that needed
their own data.

| Code | Translation | Rights holder | Status |
|---|---|---|---|
| NKJV | New King James Version | Thomas Nelson | Copyrighted |
| NIV | New International Version | Biblica | Copyrighted |
| ESV | English Standard Version | Crossway | Copyrighted |
| NASB | New American Standard Bible | The Lockman Foundation | Copyrighted |

Source: files the owner already had (`~/Downloads/Contents/Resources/_up_/
BibleTranslations/`, dated July 2026) — confirmed by the owner directly
(2026-09-14) as data they'd already sourced for this project specifically,
not something newly acquired. Converted from their original
`{Book: {chapter: {verse: text}}}` shape into Kairo's flat
`{book, chapter, verse, reference, text}` pack schema (same shape as
`databases/bibles/packs/`), 2 book-name spellings normalized to the
canonical list used elsewhere in the app (`Psalm`→`Psalms`,
`Song Of Solomon`→`Song of Solomon`) — everything else matched exactly.

Unlike the public-domain/CC-licensed scripture-language packs
(`databases/bibles/packs/ATTRIBUTION.md`), these four are commercial,
copyrighted translations — they are not independently redistributable
without whatever rights the owner already holds for them. If this project
is ever redistributed to a party the owner's existing rights don't cover,
this is the file to check first.
