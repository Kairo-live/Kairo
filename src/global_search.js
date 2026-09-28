// KAIRO — global search: ⌘F (Ctrl+F), or Edit → Find….
//
// One box over the whole app: Bible verses, songs, playlist items and their
// slides, media, timer segments and Help, grouped by kind. The kind the query
// most clearly names leads: a typed reference puts the Bible first, a song or
// playlist item title puts those first. Each group shows its best few, with
// "Show all" for the rest.
//
// Enter opens a result where it lives — its tab, scrolled to it and ringed —
// and never changes the output. ⌘/Ctrl+Enter, or the row's Send/Add button,
// does what clicking it in its own tab does: a verse, slide or media item goes
// live, a song opens Add to playlist. A wrong thing on screen is worse than
// one more keystroke.
(function () {
  'use strict';

  const SHOWN = { bible: 5, songs: 5, slides: 6, media: 5, timers: 3, help: 3 };
  const ORDER = ['bible', 'songs', 'slides', 'media', 'timers', 'help'];
  const NAMES = { bible: 'Bible', songs: 'Songs', slides: 'Slides & playlists', media: 'Media', timers: 'Timers', help: 'Help' };
  const RECENT_KEY = 'kairo-global-search-recent';
  const STOP = new Set(['a', 'an', 'and', 'are', 'be', 'can', 'do', 'does', 'for', 'how', 'i', 'if', 'in',
    'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'why', 'with', 'you', 'your']);
  const ICONS = {
    bible: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    songs: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    slides: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M7 20h10"/><path d="M12 16v4"/>',
    media: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    timers: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7"/><path d="M12 17h.01"/>',
  };
  const icon = (kind) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</svg>`;

  let overlay = null, input = null, resultsEl = null;
  let isOpen = false;
  let query = '';
  let bible = { query: '', results: [], reference: false, loading: false };
  let bibleSeq = 0, bibleTimer = 0;
  let expanded = new Set();
  let rows = [];            // selectable rows in display order: { key, el, open(send) }
  let active = -1;
  let activeKey = null;
  let userMoved = false;    // the operator moved the highlight; until then it stays on the top result

  // ── Text helpers ──────────────────────────────────────────────────────────
  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function termsOf(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const kept = words.filter(w => !STOP.has(w));
    return kept.length ? kept : words;
  }
  // The text with the query marked: the whole phrase where it appears,
  // otherwise its words (from the start of a word).
  function marked(text, q, { words = false } = {}) {
    const t = String(text ?? '');
    if (!q) return escapeHtml(t);
    const re = words
      ? new RegExp(termsOf(q).map(w => (/^\w/.test(w) ? '\\b' : '') + escapeRe(w)).join('|'), 'gi')
      : new RegExp(escapeRe(q.trim()).replace(/\s+/g, '\\s+'), 'gi');
    let out = '', last = 0, m, hits = 0;
    while ((m = re.exec(t))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += escapeHtml(t.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
      hits++;
    }
    // The phrase can be split by punctuation in the text ("love, joy"): mark its words.
    if (!hits && !words) return marked(t, q, { words: true });
    return out + escapeHtml(t.slice(last));
  }
  // A short window of long text around the first match.
  function around(text, q, max = 120) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const lower = t.toLowerCase();
    let at = lower.indexOf(q.trim().toLowerCase());
    if (at < 0) for (const w of termsOf(q)) { at = lower.indexOf(w); if (at >= 0) break; }
    if (at < 0) at = 0;
    const start = Math.max(0, Math.min(at - 30, t.length - max));
    return (start > 0 ? '…' : '') + t.slice(start, start + max).trim() + (start + max < t.length ? '…' : '');
  }

  // ── Recent searches ───────────────────────────────────────────────────────
  function recents() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(s => typeof s === 'string'); } catch { return []; }
  }
  function remember(q) {
    const v = q.trim();
    if (!v) return;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([v, ...recents().filter(r => r.toLowerCase() !== v.toLowerCase())].slice(0, 6))); } catch {}
  }

  // ── Sources ───────────────────────────────────────────────────────────────
  async function fetchBible(q) {
    const seq = ++bibleSeq;
    bible = { ...bible, loading: true };
    try {
      const r = await fetch(`${SERVER}/api/search/lookup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 30 }),
      });
      const d = await r.json();
      if (seq !== bibleSeq) return;
      bible = { query: q, results: d.results || [], reference: !!d.reference, loading: false };
    } catch {
      if (seq !== bibleSeq) return;
      bible = { query: q, results: [], reference: false, loading: false };
    }
    if (isOpen && query === q) render();
  }

  // Settings → Help's sections, matched the way Help's own search matches.
  function searchHelp(q) {
    const terms = termsOf(q).map(w => new RegExp((/^\w/.test(w) ? '\\b' : '') + escapeRe(w), 'i'));
    return [...document.querySelectorAll('.help-groups .help-group')].map(g => {
      const title = g.querySelector('summary')?.textContent.trim() || '';
      const body = (g.querySelector('.help-body')?.textContent || '').replace(/\s+/g, ' ').trim();
      const all = `${title} ${body}`;
      return terms.every(r => r.test(all)) ? { kind: 'help', title, body } : null;
    }).filter(Boolean);
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function openVerse(v, send) {
    if (send) {
      showInViewer([v], 'search', 1.0);
      sendVerseToServer(v);
      return;
    }
    // Where a verse lives: the Bible search, with the reference ready to send.
    document.getElementById('bible-btn')?.click();
    const box = document.getElementById('scripture-search-input');
    if (box) {
      box.value = v.reference;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
      box.select();
    }
  }
  function openHelp(q) {
    settingsModal?.classList.remove('hidden');
    showSettingsPane('help');
    const box = document.getElementById('help-search');
    if (box) {
      box.value = q;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────
  function groups(q) {
    const c = window.KairoService?.searchContent?.(q) || { songs: [], items: [], slides: [], media: [], timers: [] };
    const b = bible.query === q ? bible : { results: [], reference: false, loading: true };
    const list = [
      { key: 'bible', rank: b.reference ? 0 : 3, items: b.results.map(v => ({
        id: v.reference,
        title: escapeHtml(v.reference),
        sub: marked(around(v.text || '', q, 150), b.reference ? '' : q, { words: v.match === 'phrase' }),
        action: 'Send',
        open: (send) => openVerse(v, send),
      })), loading: b.loading && !b.results.length },
      { key: 'songs', rank: c.songs.some(s => s.rank <= 3) ? 1 : 4, items: c.songs.map(s => ({
        id: s.id,
        title: marked(s.title, q),
        sub: s.line ? marked(around(s.line, q), q) : escapeHtml([s.author, s.year, s.library ? 'Your library' : ''].filter(Boolean).join(' · ')),
        action: 'Add',
        open: (send) => window.KairoService.openFound(s, { send }),
      })) },
      { key: 'slides', rank: c.items.length ? 1 : 2, items: [
        ...c.items.map(it => ({
          id: `item:${it.itemId}`,
          title: marked(it.title, q),
          sub: escapeHtml(`${it.playlist} · ${it.type} · ${it.slides} slide${it.slides === 1 ? '' : 's'}`),
          action: it.slides ? 'Send' : '',
          open: (send) => window.KairoService.openFound(it, { send }),
        })),
        ...c.slides.map(s => ({
          id: `slide:${s.itemId}:${s.index}`,
          title: marked(around(s.text, q, 90), q),
          sub: escapeHtml(`${s.playlist} › ${s.item} · Slide ${s.index + 1}${s.label ? ` · ${s.label}` : ''}`),
          action: 'Send',
          open: (send) => window.KairoService.openFound(s, { send }),
        })),
      ] },
      { key: 'media', rank: 2, items: c.media.map(m => ({
        id: m.url,
        title: marked(m.name, q),
        sub: escapeHtml(`${m.folder} · ${m.mediaKind === 'video' ? 'Video' : 'Image'}`),
        action: 'Send',
        open: (send) => window.KairoService.openFound(m, { send }),
      })) },
      { key: 'timers', rank: 2, items: c.timers.map(t => ({
        id: t.id,
        title: marked(t.title, q),
        sub: escapeHtml(`Timer · ${t.status === 'live' ? 'Live' : t.status === 'done' ? 'Done' : 'Pending'}`),
        action: '',
        open: () => window.KairoService.openFound(t),
      })) },
      { key: 'help', rank: 5, items: searchHelp(q).map(h => ({
        id: h.title,
        title: marked(h.title, q, { words: true }),
        sub: marked(around(h.body, q), q, { words: true }),
        action: '',
        open: () => openHelp(q),
      })) },
    ];
    // The Bible group's "Searching…" shows only while nothing else has turned up.
    const found = list.filter(g => g.items.length);
    return (found.length ? found : list.filter(g => g.loading))
      .sort((a, b) => a.rank - b.rank || ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  }

  function rowEl({ kind, title, sub, action }) {
    const row = document.createElement('div');
    row.className = 'gs-row';
    row.setAttribute('role', 'option');
    row.innerHTML =
      `<span class="gs-row-icon">${icon(kind)}</span>` +
      `<span class="gs-row-main"><span class="gs-row-title">${title}</span>${sub ? `<span class="gs-row-sub">${sub}</span>` : ''}</span>` +
      (action ? `<button type="button" class="gs-row-action" tabindex="-1">${action}</button>` : '');
    return row;
  }

  function addRow(el, key, run) {
    const i = rows.length;
    rows.push({ key, el, run });
    el.addEventListener('mousemove', () => { if (active !== i) { userMoved = true; setActive(i); } });
    el.addEventListener('click', (e) => {
      const send = !!e.target.closest('.gs-row-action');
      e.stopPropagation();
      choose(i, send);
    });
  }

  function render() {
    if (!resultsEl) return;
    rows = [];
    resultsEl.innerHTML = '';
    const q = query.trim();
    if (!q) { renderStart(); return; }

    const list = groups(q);
    if (!list.length) {
      resultsEl.innerHTML = `<div class="gs-empty">Nothing matches “${escapeHtml(q)}”.</div>`;
      active = -1;
      return;
    }
    for (const g of list) {
      const section = document.createElement('section');
      section.className = 'gs-group';
      const total = g.items.length;
      section.innerHTML = `<div class="gs-group-head"><span>${NAMES[g.key]}</span>` +
        `<span class="gs-group-count">${g.loading ? 'Searching…' : total}</span></div>`;
      const shown = expanded.has(g.key) ? g.items : g.items.slice(0, SHOWN[g.key]);
      for (const it of shown) {
        const el = rowEl({ kind: g.key, ...it });
        section.appendChild(el);
        addRow(el, `${g.key}:${it.id}`, (send) => { remember(q); return it.open(send); });
      }
      if (total > shown.length) {
        const more = document.createElement('div');
        more.className = 'gs-row gs-more';
        more.setAttribute('role', 'option');
        more.textContent = `Show all ${total}`;
        section.appendChild(more);
        addRow(more, `${g.key}:more`, () => { expanded.add(g.key); activeKey = `${g.key}:more-done`; render(); return 'keep'; });
      }
      resultsEl.appendChild(section);
    }
    // The top result stays highlighted as results arrive (the Bible group comes
    // later), unless the operator has moved the highlight: then it stays put.
    let i = 0;
    if (activeKey?.endsWith(':more-done')) {
      const g = activeKey.split(':')[0];
      i = rows.findIndex(r => r.key.startsWith(`${g}:`)) + SHOWN[g];
    } else if (userMoved && activeKey) {
      i = rows.findIndex(r => r.key === activeKey);
    }
    setActive(i >= 0 && i < rows.length ? i : 0, { scroll: false });
  }

  function renderStart() {
    const rec = recents();
    let html = '<div class="gs-tips">Search every part of Kairo: a reference (<b>Jn 3:16</b>, <b>Ps 23</b>), ' +
      'words from a verse, a song title or lyric, slide text, a media file or timer name.</div>';
    resultsEl.innerHTML = html;
    if (rec.length) {
      const section = document.createElement('section');
      section.className = 'gs-group';
      section.innerHTML = '<div class="gs-group-head"><span>Recent searches</span></div>';
      rec.forEach(r => {
        const el = document.createElement('div');
        el.className = 'gs-row gs-recent';
        el.setAttribute('role', 'option');
        el.innerHTML = `<span class="gs-row-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg></span><span class="gs-row-main"><span class="gs-row-title">${escapeHtml(r)}</span></span>`;
        section.appendChild(el);
        addRow(el, `recent:${r}`, () => { input.value = r; onInput(); return 'keep'; });
      });
      resultsEl.appendChild(section);
    }
    setActive(rows.length ? 0 : -1, { scroll: false });
  }

  function setActive(i, { scroll = true } = {}) {
    rows[active]?.el.classList.remove('is-active');
    active = i;
    const r = rows[i];
    if (!r) { activeKey = null; return; }
    r.el.classList.add('is-active');
    activeKey = r.key;
    if (scroll) {
      const box = resultsEl.getBoundingClientRect(), e = r.el.getBoundingClientRect();
      if (e.top < box.top) resultsEl.scrollTop -= box.top - e.top + 28;
      else if (e.bottom > box.bottom) resultsEl.scrollTop += e.bottom - box.bottom + 8;
    }
  }

  async function choose(i, send) {
    const r = rows[i];
    if (!r) return;
    const kept = await r.run(send);
    if (kept === 'keep') { input.focus(); return; }
    close();
  }

  // Tab / Shift+Tab: to the first row of the next / previous group.
  function jumpGroup(dir) {
    if (!rows.length) return;
    const groupOf = (k) => k.split(':')[0];
    const cur = groupOf(rows[Math.max(0, active)].key);
    let i = Math.max(0, active);
    if (dir > 0) {
      while (i < rows.length && groupOf(rows[i].key) === cur) i++;
      if (i >= rows.length) i = 0;
    } else {
      while (i > 0 && groupOf(rows[i].key) === cur) i--;
      const g = groupOf(rows[i].key);
      if (g === cur) i = rows.length - 1;
      const target = groupOf(rows[i].key);
      while (i > 0 && groupOf(rows[i - 1].key) === target) i--;
    }
    setActive(i);
  }

  // ── Overlay ───────────────────────────────────────────────────────────────
  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'gs-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="gs-panel" role="dialog" aria-modal="true" aria-label="Search Kairo">' +
        '<div class="gs-input-row">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
          '<input type="text" class="gs-input" placeholder="Search Bible, songs, slides, media…" autocomplete="off" spellcheck="false" aria-label="Search">' +
          '<kbd class="gs-esc">esc</kbd>' +
        '</div>' +
        '<div class="gs-results" role="listbox"></div>' +
        '<div class="gs-footer">' +
          '<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>tab</kbd> next group</span>' +
          `<span><kbd>↵</kbd> open</span><span><kbd>${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd><kbd>↵</kbd> send / add</span>` +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('.gs-input');
    resultsEl = overlay.querySelector('.gs-results');
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
  }

  function onInput() {
    query = input.value;
    expanded = new Set();
    activeKey = null;
    userMoved = false;
    const q = query.trim();
    clearTimeout(bibleTimer);
    if (q) bibleTimer = setTimeout(() => fetchBible(q), 140);
    render();
  }

  function onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowDown') { e.preventDefault(); userMoved = true; if (rows.length) setActive((active + 1) % rows.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); userMoved = true; if (rows.length) setActive((active - 1 + rows.length) % rows.length); }
    else if (e.key === 'Tab') { e.preventDefault(); userMoved = true; jumpGroup(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) choose(active, mod); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }

  function open() {
    build();
    if (isOpen) { input.focus(); input.select(); return; }
    isOpen = true;
    overlay.hidden = false;
    document.body.classList.add('gs-open');
    input.value = query;
    render();
    if (query.trim()) fetchBible(query.trim());
    requestAnimationFrame(() => { input.focus(); input.select(); });
    // Media and timers come from the server; refresh them, then the results.
    window.KairoService?.prefetchForSearch?.().then(() => { if (isOpen && query.trim()) render(); }).catch(() => {});
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.hidden = true;
    document.body.classList.remove('gs-open');
  }

  // ⌘F / Ctrl+F from anywhere in the window, text fields included. The native
  // Edit → Find… item (lib.rs, "menu-find") covers the packaged app; this is
  // the same shortcut for the page itself, and opening twice is harmless.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (String(e.key).toLowerCase() !== 'f' && e.code !== 'KeyF') return;
    if (typeof capturingHotkeyId !== 'undefined' && capturingHotkeyId) return;   // Settings → Shortcuts is recording a combo
    e.preventDefault();
    e.stopPropagation();
    open();
  }, true);

  window.KairoGlobalSearch = { open, close, get isOpen() { return isOpen; } };
})();
