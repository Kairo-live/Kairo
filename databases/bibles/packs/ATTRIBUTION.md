# Scripture pack sources & licenses

Real verse text for the "Scripture Language" setting (Settings → Language →
Scripture Packs), sourced 2026-09-13. Each `<lang>.json` file also carries
its own `translation`/`license`/`source` fields — this is the same
information, collected in one place.

These packs change what language a **resolved** verse **displays** in.
Live audio detection still only runs against the English KJV corpus
(`databases/bibles/map.json`) — see the comment on `LANG_PACKS` in
`src/app.js` and on `applyScriptureLanguage` in `server/server.js` for the
full scope note.

| Code | Language | Translation | License | Source |
|---|---|---|---|---|
| es | Spanish | Reina-Valera (1909) | Public domain | https://api.getbible.net/v2/valera.json |
| pt | Portuguese | Almeida Atualizada (1911 revision) | GPL | https://api.getbible.net/v2/almeida.json |
| fr | French | Louis Segond (1910) | Public domain | https://api.getbible.net/v2/ls1910.json |
| de | German | Luther (1545, modern spelling) | Public domain | https://api.getbible.net/v2/luther1545.json |
| sw | Swahili | New Testament only | Public domain | https://api.getbible.net/v2/swahili.json |
| yo | Yoruba | Biblica Open Yoruba Contemporary Bible (2017) | CC BY-SA 4.0 — © Biblica, Inc. | https://ebible.org/find/details.php?id=yor |
| ig | Igbo | Biblica Igbo Bible (2020) | CC BY-SA 4.0 — © Biblica, Inc. | https://ebible.org/find/details.php?id=ibo |
| ha | Hausa | Biblica "Sabon Rai Don Kowa" (2009, 2020) | CC BY-SA 4.0 — © Biblica, Inc. | https://ebible.org/find/details.php?id=hausa |

CC BY-SA 4.0 requires attribution and that derivative works stay under the
same license — this file is that attribution. Full license text:
https://creativecommons.org/licenses/by-sa/4.0/

Converted from each source's native format (getbible.net's own JSON for
es/pt/fr/de/sw; standard USFM for yo/ig/ha) into Kairo's flat
`{book, chapter, verse, reference, text}` schema, keyed to the same
canonical English book names/order used throughout the app (via each
source's own standard 1–66 book numbering, not per-language name matching).
Verse counts differ slightly from the English corpus's 31,008 (versification
varies a little by tradition/edition) — not chased further, since none of
these are wired into live detection yet.
