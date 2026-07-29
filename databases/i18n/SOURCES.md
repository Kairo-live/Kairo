# Bible translation sources

Bundled for the Multi-Language theme's scripture side. Each is a complete
66-book Protestant canon, fetched from the getbible.net API (api.getbible.net).

| File | Language | Translation | License |
|---|---|---|---|
| fr.json | French | Martin (1744) | Public Domain |
| es.json | Spanish | Sagradas Escrituras (1569) | Public Domain |
| pt.json | Portuguese | Bíblia Livre | Creative Commons Attribution 3.0 Brazil |

Bíblia Livre (pt.json) requires attribution under CC BY 3.0 BR — credited here
and wherever the app's own third-party notices are listed.

Structure: `{ "Genesis": [[verse1, verse2, ...], ...chapters], "Exodus": [...], ... }`,
keyed by the same English book names used elsewhere in Kairo (`verse.book`), in
chapter order, so a lookup is just `data[book][chapter - 1][verse - 1]`.
