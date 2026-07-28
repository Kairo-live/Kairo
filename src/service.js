// KAIRO — Playlist (service order)
//
// A playlist is a folder: everything the operator wants to project during the
// service, stacked in the order it will be presented. Selecting the playlist
// (any section, or "+ Add section") takes over the centre column so the whole
// service runs from one screen without leaving the detection view; "Close"
// hands the centre back to the Live Queue.
//
// Slides deliberately reuse the *verse* pipeline: each one is sent as
// { reference, text, image? } so it renders through whichever theme the
// operator assigned to each output. A lyric slide on a transparent lyrics
// theme and a scripture verse on the main theme need no separate plumbing.
//
// Section types:
//   song       — lyrics, chunked into slides by a per-song delimiter
//   slides     — free text blocks (sermon points, announcements)
//   image      — a picture
//   scripture  — a reference resolved through the existing verse lookup
'use strict';

(function () {
  const SERVICE_KEY   = 'kairo-service-v1';    // legacy single-playlist key, migrated once
  const PLAYLISTS_KEY = 'kairo-playlists-v1';
  const SERVER = `${location.protocol}//${location.host}`;
  const DESIGN_W = 1920, DESIGN_H = 1080;

  // Default chunking for lyrics. Two lines per screen is the church-projection
  // norm — enough to sing ahead, short enough to stay readable at distance.
  const DEFAULT_LINES_PER_SLIDE = 2;

  // A playlist is a folder: { id, name, items }. `service` always points at
  // whichever playlist is active, so the rest of this file — written before
  // multi-playlist support existed — can keep reading/writing `service.items`
  // unchanged; only load/save/switch need to know playlists are plural.
  let playlists = [];
  let activePlaylistId = null;
  let service = null;

  let activeItemId = null;     // section expanded in the stack / open in full-edit
  let liveSlideKey = null;
  let editSlideIndex = 0;
  const expanded = new Set(); // section ids currently expanded in the stack

  function todayName() {
    return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function loadAll() {
    try {
      const raw = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || 'null');
      if (raw && Array.isArray(raw.playlists)) {
        playlists = raw.playlists;
        if (playlists.length) {
          activePlaylistId = raw.activePlaylistId && playlists.some(p => p.id === raw.activePlaylistId)
            ? raw.activePlaylistId : playlists[0].id;
          service = playlists.find(p => p.id === activePlaylistId);
        } else {
          // Explicit "no playlists yet" — the operator hasn't created one.
          activePlaylistId = null; service = null;
        }
        return;
      }
    } catch {}
    // Nothing stored at all — first-ever launch. Bring an old single-service
    // install across as its first playlist so existing work isn't lost; a
    // genuinely fresh install gets the create-your-first-playlist prompt
    // instead of a silently auto-named folder.
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(SERVICE_KEY) || 'null'); } catch {}
    if (legacy && Array.isArray(legacy.items) && legacy.items.length) {
      const first = { id: legacy.id || uid('pl'), name: legacy.name || todayName(), items: legacy.items };
      playlists = [first]; activePlaylistId = first.id; service = first;
    } else {
      playlists = []; activePlaylistId = null; service = null;
    }
    saveAll();
  }

  function saveAll() {
    try { localStorage.setItem(PLAYLISTS_KEY, JSON.stringify({ playlists, activePlaylistId })); } catch {}
  }
  // Alias — the bulk of this file predates multi-playlist support and just
  // wants "persist whatever changed", which is always the whole set now.
  function saveService() { saveAll(); }

  function switchPlaylist(id) {
    const p = playlists.find(x => x.id === id);
    if (!p) return;
    activePlaylistId = id;
    service = p;
    activeItemId = null;
    saveAll();
    renderPlaylistSwitcher();
    renderSidebar();
    // Entering a playlist is like opening a folder — it should actually show
    // its contents, not just quietly become the target of the next action.
    openStack();
  }

  function createPlaylist(name) {
    const p = { id: uid('pl'), name: name || 'New Playlist', items: [] };
    playlists.push(p);
    saveAll();
    return p;
  }

  function renamePlaylist(id, name) {
    const p = playlists.find(x => x.id === id);
    if (!p || !name.trim()) return;
    p.name = name.trim();
    saveAll();
    renderPlaylistSwitcher();
  }

  function deletePlaylist(id) {
    playlists = playlists.filter(p => p.id !== id);
    if (activePlaylistId !== id) { saveAll(); return; }
    // The active playlist was removed — hop to whatever's left, or fall back
    // to the same empty state a brand-new install starts in (the "create a
    // playlist" prompt already handles service === null everywhere it's read).
    if (playlists.length) {
      switchPlaylist(playlists[0].id);
    } else {
      activePlaylistId = null;
      service = null;
      activeItemId = null;
      saveAll();
      renderPlaylistSwitcher();
      renderSidebar();
    }
  }

  const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const activeItem = () => service ? (service.items.find(i => i.id === activeItemId) || null) : null;
  const typeLabel = t => ({ song: 'Song', slides: 'Slides', image: 'Image', scripture: 'Scripture' }[t] || t);

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Chunking ────────────────────────────────────────────────────────────
  // A song stores its lyrics as labelled stanzas. `linesPerSlide` decides how
  // those stanzas break down for the screen:
  //   0 → one slide per stanza (whatever the author wrote)
  //   n → n lines per slide, stanzas never bleeding into each other
  // `breaks` holds line indices the operator forced onto a new slide; those win
  // over the delimiter, and the delimiter then chunks each resulting segment.
  function chunkStanza(lines, n, breaks) {
    const clean = lines.filter(l => l !== undefined && l !== null);
    const brk = new Set(breaks || []);

    const segments = [];
    let cur = [];
    clean.forEach((line, i) => {
      if (brk.has(i) && cur.length) { segments.push(cur); cur = []; }
      cur.push(line);
    });
    if (cur.length) segments.push(cur);

    if (!n || n < 1) return segments;
    const out = [];
    segments.forEach(seg => {
      for (let i = 0; i < seg.length; i += n) out.push(seg.slice(i, i + n));
    });
    return out;
  }

  function slidesFor(item) {
    if (!item) return [];
    switch (item.type) {
      case 'song': {
        const n = item.linesPerSlide == null ? DEFAULT_LINES_PER_SLIDE : item.linesPerSlide;
        const out = [];
        (item.blocks || []).forEach((b, bi) => {
          const parts = chunkStanza(b.lines || [], n, b.breaks);
          let cursor = 0;
          parts.forEach((lines, i) => {
            const start = cursor;
            cursor += lines.length;
            if (!lines.length || lines.every(l => !String(l).trim())) return;
            out.push({
              label: parts.length > 1 ? `${b.label} · ${i + 1}` : b.label,
              lines, text: lines.join('\n'), reference: item.title,
              blockIndex: bi, lineStart: start, lineEnd: start + lines.length,
            });
          });
        });
        return out;
      }
      case 'slides':
        return (item.blocks || []).map((b, i) => ({
          label: b.label || `Slide ${i + 1}`,
          lines: (b.text || '').split('\n'),
          text: b.text || '', reference: item.title,
        }));
      case 'image':
        return [{ label: item.title, image: item.src, text: '', reference: item.title }];
      case 'scripture':
        return [{ label: item.ref, lines: [item.text || item.ref], text: item.text || '', reference: item.ref }];
      default:
        return [];
    }
  }

  // Theme this section renders with, if the operator overrode the output default.
  function themeForItem(item) {
    const list = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
    if (!list.length) return null;
    return list.find(l => l.id === item.themeId) || list[0];
  }
  function itemLookOverride(item) {
    if (!item || !item.themeId) return null;
    const list = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
    return list.find(l => l.id === item.themeId) || null;
  }

  async function sendSlide(item, index) {
    const slide = slidesFor(item)[index];
    if (!slide) return;
    liveSlideKey = `${item.id}:${index}`;
    renderStack();
    if (activeItemId === item.id) renderStrip(item, slidesFor(item));
    try {
      await fetch(`${SERVER}/api/service/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          look: itemLookOverride(item),
          verse: {
            reference: slide.reference || item.title || '',
            text: slide.text || '',
            nlt_text: slide.text || '',
            image: slide.image || null,   // fixes images never reaching the display
            book: 'Service', chapter: 0, verse: index + 1,
            similarity: 1, method: 'service',
          },
        }),
      });
    } catch (err) {
      if (typeof toast === 'function') toast('Send failed: ' + err.message, 'error');
    }
  }

  // Move the live slide forward/back within whichever item is currently on
  // air. If nothing is live yet, starts the active/expanded item at its first
  // slide instead of doing nothing.
  function advanceLiveSlide(delta) {
    if (!service) return;
    if (!liveSlideKey) {
      const item = activeItem();
      const slides = item ? slidesFor(item) : [];
      if (slides.length) sendSlide(item, 0);
      return;
    }
    const sep = liveSlideKey.lastIndexOf(':');
    const itemId = liveSlideKey.slice(0, sep);
    const idx = parseInt(liveSlideKey.slice(sep + 1), 10);
    const item = service.items.find(i => i.id === itemId);
    if (!item) return;
    const slides = slidesFor(item);
    if (!slides.length) return;
    const next = Math.max(0, Math.min(slides.length - 1, idx + delta));
    if (next === idx) return;   // already at the edge
    sendSlide(item, next);
    if (activeItemId === item.id) {
      editSlideIndex = next;
      if (!document.getElementById('svc-fullscreen')?.classList.contains('hidden')) {
        renderStrip(item, slides);
        renderCanvas(item, slides[next]);
      }
    }
  }

  // ── Playlist switcher ────────────────────────────────────────────────────
  // Rebuilds the button's contents rather than just updating a span's text, so
  // it can restore itself after startRenamingSwitcher() swaps in an <input>.
  function renderPlaylistSwitcher() {
    const btn = document.getElementById('playlist-switcher');
    if (!btn) return;
    btn.innerHTML =
      `<span id="playlist-switcher-name">${escapeHtml(service?.name || 'Playlist')}</span>` +
      `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  }

  // Windows-Explorer-style "New Folder": the playlist is created nameless and
  // immediately editable, rather than making the operator open a dialog to
  // name it before they can see it.
  function startRenamingSwitcher() {
    const btn = document.getElementById('playlist-switcher');
    if (!btn || !service) return;
    btn.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'svc-playlist-rename-input';
    input.value = service.name;
    btn.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    // Commit directly rather than depending solely on the native 'blur' event
    // to trigger it — .blur() is a no-op if the input never actually holds
    // focus (e.g. a stray click stole it first), which would silently drop
    // the rename with no visible error. Enter calls this directly; blur is
    // the fallback for clicking away. `settled` makes either path idempotent.
    const commit = () => {
      if (settled) return;
      settled = true;
      const val = input.value.trim();
      // renamePlaylist() only re-renders on success — an empty name needs its
      // own revert or the input is left stranded with nothing to restore it.
      if (val) renamePlaylist(activePlaylistId, val);
      else renderPlaylistSwitcher();
    };

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); settled = true; renderPlaylistSwitcher(); }
    });
  }

  function openPlaylistSwitcherPopover(anchor) {
    openPopover(anchor, (pop) => {
      pop.classList.add('svc-popover-wide');
      const label = document.createElement('div');
      label.className = 'svc-popover-label';
      label.textContent = 'Playlists';
      pop.appendChild(label);

      const list = document.createElement('div');
      list.className = 'svc-popover-list';
      playlists.forEach(p => {
        const row = document.createElement('div');
        row.className = 'svc-playlist-row' + (p.id === activePlaylistId ? ' active' : '');

        const btn = document.createElement('button');
        btn.className = 'svc-popover-item';
        btn.textContent = p.name;
        btn.addEventListener('click', () => { switchPlaylist(p.id); closePopover(); });

        const del = document.createElement('button');
        del.className = 'svc-playlist-row-del';
        del.innerHTML = '&times;';
        del.title = 'Delete playlist';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deletePlaylist(p.id);
          openPlaylistSwitcherPopover(anchor);
        });

        row.appendChild(btn); row.appendChild(del);
        list.appendChild(row);
      });
      pop.appendChild(list);

      const addRow = document.createElement('button');
      addRow.className = 'svc-popover-item svc-popover-add';
      addRow.textContent = '+ New playlist';
      addRow.addEventListener('click', () => {
        const p = createPlaylist('New Playlist ' + (playlists.length + 1));
        switchPlaylist(p.id);
        closePopover();
      });
      pop.appendChild(addRow);
    });
  }

  // ── Sidebar list (drag to reorder; click expands in the stack) ──────────
  let dragItemId = null;

  function renderSidebar() {
    const host = document.getElementById('svc-items-list');
    const section = document.querySelector('.ls-playlist-section');
    if (!host) return;
    host.innerHTML = '';

    // Nothing to nest content INSIDE yet — the flow is create the folder
    // first, then add songs/slides/scripture into it. Hide the switcher and
    // add-menu (there's nothing to switch between or add to) and show a
    // single "create a playlist" prompt instead.
    if (!service) {
      section?.classList.add('no-playlist');
      const wrap = document.createElement('div');
      wrap.className = 'svc-create-first';
      wrap.innerHTML = '<p>Create a playlist to start adding songs, slides and scripture.</p>';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'setting-input';
      input.placeholder = 'e.g. Sunday Service';
      const btn = document.createElement('button');
      btn.className = 'modal-btn primary';
      btn.style.cssText = 'width:100%;justify-content:center;margin-top:8px;';
      btn.textContent = '+ Create playlist';
      const doCreate = () => {
        const p = createPlaylist(input.value.trim() || todayName());
        switchPlaylist(p.id);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } });
      btn.addEventListener('click', doCreate);
      wrap.appendChild(input); wrap.appendChild(btn);
      host.appendChild(wrap);
      return;
    }
    section?.classList.remove('no-playlist');

    if (!service.items.length) {
      host.innerHTML = '<div class="svc-empty-sm">Nothing planned.<br>Use + to add a song, slides or scripture.</div>';
      return;
    }

    service.items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'svc-item' + (item.id === activeItemId ? ' active' : '');
      row.draggable = true;

      const n = document.createElement('span');
      n.className = 'svc-item-num';
      n.textContent = idx + 1;

      const body = document.createElement('div');
      body.className = 'svc-item-body';
      const count = slidesFor(item).length;
      body.innerHTML =
        `<div class="svc-item-title">${escapeHtml(item.title || '(untitled)')}</div>` +
        `<div class="svc-item-sub">${typeLabel(item.type)} · ${count} slide${count === 1 ? '' : 's'}</div>`;

      const del = document.createElement('button');
      del.className = 'svc-item-del';
      del.innerHTML = '&times;';
      del.title = 'Remove';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item.id); });

      row.appendChild(n); row.appendChild(body); row.appendChild(del);
      row.addEventListener('click', () => focusInStack(item.id));

      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragItemId = item.id;
        row.classList.add('svc-item-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', item.id); } catch {}
      });
      row.addEventListener('dragend', () => {
        dragItemId = null;
        document.querySelectorAll('.svc-item').forEach(r =>
          r.classList.remove('svc-item-dragging', 'svc-drop-before', 'svc-drop-after'));
      });
      row.addEventListener('dragover', (e) => {
        if (!dragItemId || dragItemId === item.id) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        row.classList.toggle('svc-drop-after', after);
        row.classList.toggle('svc-drop-before', !after);
      });
      row.addEventListener('dragleave', () =>
        row.classList.remove('svc-drop-before', 'svc-drop-after'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = row.classList.contains('svc-drop-after');
        row.classList.remove('svc-drop-before', 'svc-drop-after');
        moveItem(dragItemId, item.id, after);
      });

      host.appendChild(row);
    });
  }

  function moveItem(fromId, toId, after) {
    if (!fromId || fromId === toId) return;
    const from = service.items.findIndex(i => i.id === fromId);
    if (from < 0) return;
    const [moved] = service.items.splice(from, 1);
    let to = service.items.findIndex(i => i.id === toId);
    if (to < 0) to = service.items.length - 1;
    service.items.splice(after ? to + 1 : to, 0, moved);
    saveService(); renderSidebar(); renderStack();
  }

  function removeItem(id) {
    service.items = service.items.filter(i => i.id !== id);
    expanded.delete(id);
    if (activeItemId === id) activeItemId = null;
    saveService(); renderSidebar(); renderStack();
  }

  // ── Views: live queue ⇄ stack ⇄ full-edit ───────────────────────────────
  function openStack() {
    document.getElementById('live-queue-section')?.classList.add('hidden');
    document.getElementById('svc-fullscreen')?.classList.add('hidden');
    document.getElementById('svc-stack-view')?.classList.remove('hidden');
    renderStack();
  }
  function closeStack() {
    document.getElementById('svc-stack-view')?.classList.add('hidden');
    document.getElementById('svc-fullscreen')?.classList.add('hidden');
    document.getElementById('live-queue-section')?.classList.remove('hidden');
    activeItemId = null;
    renderSidebar();
  }

  // Sidebar click: open the stack (if not already) and expand + scroll to it.
  function focusInStack(id) {
    activeItemId = id;
    expanded.add(id);
    openStack();
    renderSidebar();
    requestAnimationFrame(() => {
      document.querySelector(`.svc-card[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function openFullEdit(id) {
    activeItemId = id;
    editSlideIndex = 0;
    document.getElementById('svc-stack-view')?.classList.add('hidden');
    document.getElementById('live-queue-section')?.classList.add('hidden');
    document.getElementById('svc-fullscreen')?.classList.remove('hidden');
    renderFullEdit();
    renderSidebar();
  }
  function closeFullEdit() {
    document.getElementById('svc-fullscreen')?.classList.add('hidden');
    openStack();
  }

  // ── Stack: one card per section ──────────────────────────────────────────
  function renderStack() {
    const host = document.getElementById('svc-stack-list');
    if (!host) return;
    host.innerHTML = '';

    if (!service || !service.items.length) {
      host.innerHTML = '<div class="svc-empty">Nothing in this playlist yet.<br>Use “+ Add section” to plan the service.</div>';
      return;
    }

    service.items.forEach((item, idx) => host.appendChild(sectionCard(item, idx)));
  }

  function sectionCard(item, idx) {
    const isOpen = expanded.has(item.id);
    const card = document.createElement('div');
    card.className = 'svc-card' + (isOpen ? ' open' : '') + (item.id === activeItemId ? ' active' : '');
    card.dataset.id = item.id;
    card.draggable = true;

    const head = document.createElement('div');
    head.className = 'svc-card-head';

    const grip = document.createElement('span');
    grip.className = 'svc-card-grip';
    grip.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/></svg>`;

    const chevron = document.createElement('button');
    chevron.className = 'svc-card-chevron';
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    chevron.title = isOpen ? 'Collapse' : 'Expand';
    chevron.addEventListener('click', (e) => {
      // Without this the click bubbles to the head's own toggle handler below,
      // firing twice per click and cancelling itself out — the chevron looked
      // unresponsive when in fact it was toggling and un-toggling in one go.
      e.stopPropagation();
      if (expanded.has(item.id)) expanded.delete(item.id); else expanded.add(item.id);
      renderStack();
    });

    const num = document.createElement('span');
    num.className = 'svc-card-num';
    num.textContent = idx + 1;

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'svc-card-title';
    title.value = item.title || '';
    title.placeholder = '(untitled)';
    title.addEventListener('click', e => e.stopPropagation());
    title.addEventListener('change', () => { item.title = title.value; saveService(); renderSidebar(); });

    const typeTag = document.createElement('span');
    typeTag.className = 'svc-card-type';
    typeTag.textContent = typeLabel(item.type);

    const count = slidesFor(item).length;
    const countTag = document.createElement('span');
    countTag.className = 'svc-card-count';
    countTag.textContent = `${count} slide${count === 1 ? '' : 's'}`;

    head.appendChild(grip);
    head.appendChild(chevron);
    head.appendChild(num);
    head.appendChild(title);
    head.appendChild(typeTag);

    // Lines popover (songs only) and Theme popover — icon buttons, single row.
    if (item.type === 'song') {
      const linesBtn = document.createElement('button');
      linesBtn.className = 'svc-card-icon-btn';
      linesBtn.title = 'Lines per slide';
      linesBtn.textContent = (item.linesPerSlide == null ? DEFAULT_LINES_PER_SLIDE : item.linesPerSlide) || 'S';
      linesBtn.addEventListener('click', (e) => { e.stopPropagation(); openLinesPopover(linesBtn, item); });
      head.appendChild(linesBtn);
    }

    const themeBtn = document.createElement('button');
    themeBtn.className = 'svc-card-icon-btn';
    themeBtn.title = 'Theme for this section';
    themeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="13.5" r="2.5"/><circle cx="8.5" cy="13.5" r="2.5"/><path d="M12 21a9 9 0 1 1 0-18"/></svg>`;
    themeBtn.addEventListener('click', (e) => { e.stopPropagation(); openThemePopover(themeBtn, item); });
    head.appendChild(themeBtn);
    head.appendChild(countTag);

    const editBtn = document.createElement('button');
    editBtn.className = 'svc-card-icon-btn svc-card-edit';
    editBtn.title = 'Full-scale edit';
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openFullEdit(item.id); });
    head.appendChild(editBtn);

    const del = document.createElement('button');
    del.className = 'svc-card-icon-btn svc-card-del';
    del.innerHTML = '&times;';
    del.title = 'Remove section';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item.id); });
    head.appendChild(del);

    head.addEventListener('click', () => {
      activeItemId = item.id;
      if (expanded.has(item.id)) expanded.delete(item.id); else expanded.add(item.id);
      renderStack(); renderSidebar();
    });

    card.appendChild(head);

    if (isOpen) {
      const body = document.createElement('div');
      body.className = 'svc-card-body';
      const slides = slidesFor(item);
      if (!slides.length) {
        body.innerHTML = '<div class="svc-empty-sm">No slides yet — Edit to add content.</div>';
      } else {
        const grid = document.createElement('div');
        grid.className = 'svc-slides-grid';
        slides.forEach((s, i) => grid.appendChild(slideCard(item, s, i)));
        body.appendChild(grid);
      }
      card.appendChild(body);
    }

    // Reorder by dragging the whole card.
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('input,button,textarea')) { e.preventDefault(); return; }
      dragItemId = item.id;
      card.classList.add('svc-item-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', item.id); } catch {}
    });
    card.addEventListener('dragend', () => {
      dragItemId = null;
      document.querySelectorAll('.svc-card').forEach(c =>
        c.classList.remove('svc-item-dragging', 'svc-drop-before', 'svc-drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (!dragItemId || dragItemId === item.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      card.classList.toggle('svc-drop-after', after);
      card.classList.toggle('svc-drop-before', !after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('svc-drop-before', 'svc-drop-after'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = card.classList.contains('svc-drop-after');
      card.classList.remove('svc-drop-before', 'svc-drop-after');
      moveItem(dragItemId, item.id, after);
    });

    return card;
  }

  function slideCard(item, s, i) {
    const card = document.createElement('button');
    const isLive = liveSlideKey === `${item.id}:${i}`;
    card.className = 'svc-slide' + (isLive ? ' live' : '');
    card.title = 'Send to all outputs';

    const preview = document.createElement('div');
    preview.className = 'svc-slide-preview';
    if (s.image) {
      preview.style.backgroundImage = `url('${s.image}')`;
      preview.classList.add('is-image');
    } else {
      (s.lines || []).forEach(line => {
        const ln = document.createElement('div');
        ln.className = 'svc-slide-line';
        ln.textContent = line;
        preview.appendChild(ln);
      });
    }

    const label = document.createElement('div');
    label.className = 'svc-slide-label';
    label.textContent = s.label || `Slide ${i + 1}`;

    card.appendChild(preview);
    card.appendChild(label);
    if (isLive) {
      const tag = document.createElement('span');
      tag.className = 'svc-live-tag';
      tag.textContent = 'LIVE';
      card.appendChild(tag);
    }
    card.addEventListener('click', () => sendSlide(item, i));
    return card;
  }

  // ── Popovers ─────────────────────────────────────────────────────────────
  function openPopover(anchor, build) {
    const pop = document.getElementById('svc-popover');
    if (!pop) return;
    pop.innerHTML = '';
    build(pop);
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const parentR = pop.offsetParent ? pop.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
    pop.style.left = Math.max(4, r.left - parentR.left) + 'px';
    pop.style.top = (r.bottom - parentR.top + 4) + 'px';
    const close = (e) => {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      pop.classList.add('hidden');
      document.removeEventListener('mousedown', close, true);
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }
  function closePopover() { document.getElementById('svc-popover')?.classList.add('hidden'); }

  function openLinesPopover(anchor, item) {
    openPopover(anchor, (pop) => {
      const label = document.createElement('div');
      label.className = 'svc-popover-label';
      label.textContent = 'Lines per slide';
      pop.appendChild(label);
      const group = document.createElement('div');
      group.className = 'ts-chip-group';
      [[1, '1'], [2, '2'], [4, '4'], [0, 'Stanza']].forEach(([v, label2]) => {
        const b = document.createElement('button');
        b.className = 'ts-chip' + ((item.linesPerSlide ?? DEFAULT_LINES_PER_SLIDE) === v ? ' active' : '');
        b.textContent = label2;
        b.addEventListener('click', () => {
          item.linesPerSlide = v;
          saveService(); renderStack(); renderSidebar();
          if (activeItemId === item.id) syncFullEditDelim();
          closePopover();
        });
        group.appendChild(b);
      });
      pop.appendChild(group);
    });
  }

  // Content-level add menu — reached from the stack view's "+ Add section",
  // scoped to whichever playlist is currently open (the folder you're "in").
  function openAddContentPopover(anchor) {
    openPopover(anchor, (pop) => {
      pop.classList.add('svc-popover-wide');
      const label = document.createElement('div');
      label.className = 'svc-popover-label';
      label.textContent = 'Add to playlist';
      pop.appendChild(label);

      const row = (kind, text) => {
        const b = document.createElement('button');
        b.className = 'svc-popover-item';
        b.textContent = text;
        b.addEventListener('click', () => {
          closePopover();
          if (kind === 'image') document.getElementById('svc-image-file')?.click();
          else if (kind === 'import-file') document.getElementById('quick-import-file')?.click();
          else if (kind === 'import-clipboard') quickImportClipboard();
          else if (MAKERS[kind]) openAddConfirm(MAKERS[kind](), { showDelimiter: kind === 'song' });
        });
        return b;
      };

      const list = document.createElement('div');
      list.className = 'svc-popover-list';
      [['song', 'New song'], ['slides', 'Slides'], ['scripture', 'Scripture'], ['image', 'Image…']]
        .forEach(([k, t]) => list.appendChild(row(k, t)));
      pop.appendChild(list);

      const sep = document.createElement('div');
      sep.className = 'svc-add-menu-sep';
      pop.appendChild(sep);

      const list2 = document.createElement('div');
      list2.className = 'svc-popover-list';
      [['import-file', 'Import file…'], ['import-clipboard', 'Paste from clipboard']]
        .forEach(([k, t]) => list2.appendChild(row(k, t)));
      pop.appendChild(list2);
    });
  }

  function openThemePopover(anchor, item) {
    openPopover(anchor, (pop) => {
      const label = document.createElement('div');
      label.className = 'svc-popover-label';
      label.textContent = 'Theme';
      pop.appendChild(label);
      const list = document.createElement('div');
      list.className = 'svc-popover-list';

      const dflt = document.createElement('button');
      dflt.className = 'svc-popover-item' + (!item.themeId ? ' active' : '');
      dflt.textContent = 'Output default';
      dflt.addEventListener('click', () => { item.themeId = null; saveService(); renderStack(); renderFullEditHeader(); closePopover(); });
      list.appendChild(dflt);

      const all = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
      all.forEach(l => {
        const b = document.createElement('button');
        b.className = 'svc-popover-item' + (item.themeId === l.id ? ' active' : '');
        b.textContent = l.name;
        b.addEventListener('click', () => {
          item.themeId = l.id; saveService(); renderStack();
          if (activeItemId === item.id) renderFullEdit();
          closePopover();
        });
        list.appendChild(b);
      });
      pop.appendChild(list);
    });
  }

  // ── Full-scale edit ──────────────────────────────────────────────────────
  function renderFullEdit() {
    const item = activeItem();
    if (!item) return;
    renderFullEditHeader();
    const slides = slidesFor(item);
    if (editSlideIndex >= slides.length) editSlideIndex = Math.max(0, slides.length - 1);
    renderStrip(item, slides);
    renderCanvas(item, slides[editSlideIndex]);
    renderInspector(item);
  }

  function renderFullEditHeader() {
    const item = activeItem();
    const titleInp = document.getElementById('svc-fs-title');
    const delim = document.getElementById('svc-delim-group');
    if (titleInp) titleInp.value = item?.title || '';
    if (delim) delim.style.display = item && item.type === 'song' ? '' : 'none';
    syncFullEditDelim();
  }
  function syncFullEditDelim() {
    const item = activeItem();
    if (!item) return;
    const n = item.linesPerSlide == null ? DEFAULT_LINES_PER_SLIDE : item.linesPerSlide;
    document.querySelectorAll('#svc-delim-chips .ts-chip').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.lines) === n));
  }

  function renderStrip(item, slides) {
    const host = document.getElementById('svc-strip');
    if (!host) return;
    host.innerHTML = '';
    slides.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'svc-strip-item' + (i === editSlideIndex ? ' active' : '') + (liveSlideKey === `${item.id}:${i}` ? ' live' : '');
      b.innerHTML =
        `<span class="svc-strip-num">${i + 1}</span>` +
        `<span class="svc-strip-text">${escapeHtml((s.lines || [])[0] || s.label || '')}</span>`;
      b.addEventListener('click', () => { editSlideIndex = i; renderCanvas(item, slides[i]); renderStrip(item, slides); });
      host.appendChild(b);
    });

    if (item.type === 'song' || item.type === 'slides') {
      const add = document.createElement('button');
      add.className = 'svc-add-line';
      add.style.margin = '6px';
      add.textContent = '+ slide';
      add.addEventListener('click', addSlide);
      host.appendChild(add);
    }
  }

  // Render a look + this slide's content into the canvas. Percentages keep it
  // resolution-independent, matching how display.html lays out.
  function renderCanvas(item, slide) {
    const host = document.getElementById('svc-canvas');
    if (!host) return;
    host.classList.remove('is-alpha');
    host.innerHTML = '';
    if (!slide) return;

    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = slide.image;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
      host.appendChild(img);
      return;
    }

    const look = themeForItem(item);
    const style = item.style || {};
    const scale = (host.clientWidth || 640) / DESIGN_W;

    (look?.layers || []).forEach(layer => {
      if (layer.visible === false) return;

      if (layer.type === 'background') {
        const d = document.createElement('div');
        d.style.position = 'absolute';
        if (layer.pos) {
          d.style.left = (layer.pos.x / DESIGN_W * 100) + '%';
          d.style.top = (layer.pos.y / DESIGN_H * 100) + '%';
          d.style.width = (layer.pos.w / DESIGN_W * 100) + '%';
          d.style.height = (layer.pos.h / DESIGN_H * 100) + '%';
        } else {
          d.style.inset = '0';
        }
        if (layer.fill === 'transparent') { host.classList.add('is-alpha'); return; }
        if (layer.fill === 'gradient') {
          d.style.background = `linear-gradient(${layer.angle || 0}deg, ${hexA(layer.color, layer.opacity)}, ${hexA(layer.color2 || layer.color, layer.opacity)})`;
        } else {
          d.style.background = hexA(layer.color, layer.opacity);
        }
        if (layer.radius) d.style.borderRadius = (layer.radius * scale) + 'px';
        host.appendChild(d);
        return;
      }
      if (layer.type === 'image') {
        const d = document.createElement('div');
        const p = layer.pos || { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H };
        d.style.cssText = 'position:absolute;background-size:contain;background-position:center;background-repeat:no-repeat;';
        d.style.left = (p.x / DESIGN_W * 100) + '%';
        d.style.top = (p.y / DESIGN_H * 100) + '%';
        d.style.width = (p.w / DESIGN_W * 100) + '%';
        d.style.height = (p.h / DESIGN_H * 100) + '%';
        if (layer.src) d.style.backgroundImage = `url('${layer.src}')`;
        host.appendChild(d);
        return;
      }
      if (layer.type !== 'text') return;

      const isVerse = layer.binding === 'verse';
      const d = document.createElement('div');
      d.className = 'svc-canvas-text' + (isVerse ? ' is-verse' : '');
      const p = layer.pos || { x: 100, y: 400, w: DESIGN_W - 200, h: 0 };
      const box = isVerse && style.pos ? style.pos : p;
      d.style.position = 'absolute';
      d.style.left = (box.x / DESIGN_W * 100) + '%';
      d.style.top = (box.y / DESIGN_H * 100) + '%';
      d.style.width = (box.w / DESIGN_W * 100) + '%';
      if (box.h > 0) d.style.height = (box.h / DESIGN_H * 100) + '%';

      const size = (isVerse && style.fontSize) ? style.fontSize : layer.font.size;
      d.style.fontFamily = `'${layer.font.family}', system-ui, sans-serif`;
      d.style.fontSize = (size * scale).toFixed(1) + 'px';
      d.style.fontWeight = layer.font.weight;
      d.style.fontStyle = layer.font.italic ? 'italic' : 'normal';
      d.style.lineHeight = layer.font.lineHeight;
      d.style.letterSpacing = (layer.font.letterSpacing * scale).toFixed(2) + 'px';
      d.style.textTransform = layer.font.transform;
      d.style.textAlign = (isVerse && style.align) ? style.align : layer.align;
      d.style.color = hexA(layer.color, layer.opacity);
      if (layer.shadow?.enabled) {
        d.style.textShadow = `${layer.shadow.x * scale}px ${layer.shadow.y * scale}px ${layer.shadow.blur * scale}px ${hexA(layer.shadow.color, layer.shadow.opacity)}`;
      }
      d.textContent = isVerse ? slide.text : (slide.reference || item.title || '');

      if (isVerse && item.type !== 'scripture') {
        d.contentEditable = 'true';
        d.spellcheck = false;
        d.addEventListener('blur', () => commitCanvasText(item, slide, d.innerText));
        d.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); d.blur(); return; }
          // Plain Enter = new line, same slide (default contentEditable
          // behaviour). Shift+Enter = break into a new slide at the caret —
          // right-click gives the same action for anyone who reaches for a
          // mouse instead.
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            splitSlideAtCaret(item, slide, d);
          }
        });
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          splitSlideAtCaret(item, slide, d);
        });
        d.addEventListener('mousedown', (e) => e.stopPropagation());
      }
      host.appendChild(d);
    });
  }

  // Write on-canvas edits back into the lines this slide came from.
  function commitCanvasText(item, slide, text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim());
    if (item.type === 'song' && slide.blockIndex != null) {
      const b = item.blocks[slide.blockIndex];
      if (!b) return;
      b.lines.splice(slide.lineStart, slide.lineEnd - slide.lineStart, ...lines);
      shiftBreaks(b, slide.lineStart, lines.length - (slide.lineEnd - slide.lineStart));
    } else if (item.type === 'slides') {
      const b = item.blocks[editSlideIndex];
      if (b) b.text = lines.join('\n');
    }
    saveService();
    renderSidebar(); renderFullEdit();
  }

  // Where the caret sits, measured in lines from the start of the editable —
  // used to translate "split here" into an absolute line index in the block.
  function caretLineIndex(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return 0;
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(el);
    range.setEnd(sel.anchorNode, sel.anchorOffset);
    return range.toString().split('\n').length - 1;
  }

  // Force a new slide to start at the caret's line. Only meaningful for songs
  // — slide/scripture/image items don't have a chunkable line array.
  function splitSlideAtCaret(item, slide, el) {
    if (item.type !== 'song' || slide.blockIndex == null) {
      if (typeof toast === 'function') toast('Slide breaks only apply to song lyrics', 'error');
      return;
    }
    const rel = caretLineIndex(el);
    const abs = slide.lineStart + rel;
    // Commit whatever's been typed so far before touching the break array —
    // otherwise an edit made in this same pass would be lost.
    commitCanvasText(item, slide, el.innerText);
    const block = item.blocks[slide.blockIndex];
    if (!block) return;
    block.breaks = block.breaks || [];
    if (abs > 0 && abs < block.lines.length && !block.breaks.includes(abs)) {
      block.breaks.push(abs);
      saveService(); renderSidebar(); renderFullEdit();
      if (typeof toast === 'function') toast('Slide split', 'success');
    }
  }

  function shiftBreaks(block, from, delta) {
    block.breaks = (block.breaks || [])
      .map(b => (b >= from ? b + delta : b))
      .filter(b => b > 0 && b < block.lines.length);
  }

  function renderInspector(item) {
    const host = document.getElementById('svc-inspector');
    if (!host) return;
    host.innerHTML = '';

    if (item.type === 'scripture') {
      const g = document.createElement('div');
      g.className = 'setting-group';
      const l = document.createElement('label');
      l.className = 'setting-label'; l.textContent = 'Reference';
      const i = document.createElement('input');
      i.type = 'text'; i.className = 'setting-input'; i.value = item.ref || '';
      i.addEventListener('change', () => { item.ref = i.value; saveService(); });
      g.appendChild(l); g.appendChild(i);
      host.appendChild(g);

      const lookup = document.createElement('button');
      lookup.className = 'modal-btn secondary';
      lookup.style.cssText = 'margin-top:8px;width:100%;justify-content:center;';
      lookup.textContent = 'Look up verse';
      lookup.addEventListener('click', () => resolveScripture(item, lookup));
      host.appendChild(lookup);
      return;
    }

    if (item.type === 'image') {
      const note = document.createElement('p');
      note.className = 'setting-hint';
      note.textContent = 'Images are shown full-frame and don’t take theme text styling.';
      host.appendChild(note);
      const replace = document.createElement('button');
      replace.className = 'modal-btn secondary';
      replace.style.cssText = 'margin-top:8px;width:100%;justify-content:center;';
      replace.textContent = 'Replace image…';
      replace.addEventListener('click', () => document.getElementById('svc-image-file')?.click());
      host.appendChild(replace);
      return;
    }

    const look = themeForItem(item);
    const verseLayer = (look?.layers || []).find(l => l.type === 'text' && l.binding === 'verse');
    item.style = item.style || {};
    const st = item.style;

    const head = document.createElement('div');
    head.className = 'svc-insp-head';
    head.textContent = 'Slide text';
    host.appendChild(head);

    host.appendChild(numRow('Size', st.fontSize ?? (verseLayer?.font.size || 64), 16, 220, v => {
      st.fontSize = v; saveService(); renderCanvas(item, slidesFor(item)[editSlideIndex]);
    }));
    host.appendChild(chipRow('Align', ['left', 'center', 'right'],
      st.align || verseLayer?.align || 'center', v => {
        st.align = v; saveService(); renderCanvas(item, slidesFor(item)[editSlideIndex]);
      }));

    const box = st.pos || verseLayer?.pos || { x: 140, y: 360, w: 1640, h: 380 };
    ['x', 'y', 'w', 'h'].forEach(k => {
      host.appendChild(numRow(k.toUpperCase(), box[k] ?? 0, -DESIGN_W, DESIGN_W, v => {
        st.pos = { ...box, ...st.pos, [k]: v };
        saveService(); renderCanvas(item, slidesFor(item)[editSlideIndex]);
      }));
    });

    const reset = document.createElement('button');
    reset.className = 'svc-add-line';
    reset.style.marginTop = '10px';
    reset.textContent = 'Reset to theme';
    reset.addEventListener('click', () => {
      delete item.style; saveService(); renderCanvas(item, slidesFor(item)[editSlideIndex]);
    });
    host.appendChild(reset);

    const note = document.createElement('p');
    note.className = 'setting-hint';
    note.style.marginTop = '10px';
    note.textContent = `Styling “${look ? look.name : 'theme'}” for this section only. Edit the theme itself in Theme Studio.`;
    host.appendChild(note);
  }

  function numRow(label, value, min, max, onChange) {
    const r = document.createElement('div');
    r.className = 'svc-insp-row';
    const l = document.createElement('span');
    l.className = 'svc-insp-label'; l.textContent = label;
    const i = document.createElement('input');
    i.type = 'number'; i.className = 'setting-input svc-insp-num';
    i.value = Math.round(value); i.min = min; i.max = max;
    i.addEventListener('change', () => onChange(parseFloat(i.value) || 0));
    r.appendChild(l); r.appendChild(i);
    return r;
  }
  function chipRow(label, options, current, onChange) {
    const r = document.createElement('div');
    r.className = 'svc-insp-row';
    const l = document.createElement('span');
    l.className = 'svc-insp-label'; l.textContent = label;
    const g = document.createElement('div');
    g.className = 'ts-chip-group';
    options.forEach(o => {
      const b = document.createElement('button');
      b.className = 'ts-chip' + (o === current ? ' active' : '');
      b.textContent = o[0].toUpperCase() + o.slice(1);
      b.addEventListener('click', () => { onChange(o); chipRowSync(g, o); });
      g.appendChild(b);
    });
    r.appendChild(l); r.appendChild(g);
    return r;
  }
  function chipRowSync(group, active) {
    [...group.children].forEach(b => b.classList.toggle('active', b.textContent.toLowerCase() === active));
  }

  function hexA(hex, opacity) {
    const h = String(hex || '#000000').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${((opacity ?? 100) / 100).toFixed(2)})`;
  }

  async function resolveScripture(item, btn) {
    const ref = (item.ref || '').trim();
    if (!ref) return;
    btn.disabled = true; btn.textContent = 'Looking up…';
    try {
      const r = await fetch(`${SERVER}/api/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ref, limit: 1 }),
      });
      const d = await r.json();
      const hit = d.result || (d.results || [])[0];
      if (hit) {
        item.text = hit.text || ''; item.title = hit.reference || ref;
        saveService(); renderSidebar(); renderStack(); renderFullEdit();
      } else if (typeof toast === 'function') {
        toast('No verse found for ' + ref, 'error');
      }
    } catch (err) {
      if (typeof toast === 'function') toast('Lookup failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Look up verse';
    }
  }

  function addSlide() {
    const item = activeItem();
    if (!item) return;
    item.blocks = item.blocks || [];
    if (item.type === 'song') item.blocks.push({ label: `Verse ${item.blocks.length + 1}`, lines: [''] });
    else if (item.type === 'slides') item.blocks.push({ label: `Slide ${item.blocks.length + 1}`, text: '' });
    else return;
    saveService();
    editSlideIndex = Math.max(0, slidesFor(item).length - 1);
    renderSidebar(); renderFullEdit();
  }

  // ── Adding sections ───────────────────────────────────────────────────────
  // Actually commit a drafted item into a (possibly non-active) playlist.
  function commitItem(playlist, item) {
    playlist.items.push(item);
    saveService();
    if (playlist.id !== activePlaylistId) switchPlaylist(playlist.id);
    expanded.add(item.id);
    focusInStack(item.id);
  }

  const MAKERS = {
    song:      () => ({ id: uid('song'), type: 'song', title: 'New song', linesPerSlide: DEFAULT_LINES_PER_SLIDE, blocks: [{ label: 'Verse 1', lines: [''] }] }),
    slides:    () => ({ id: uid('slides'), type: 'slides', title: 'New slides', blocks: [{ label: 'Slide 1', text: '' }] }),
    scripture: () => ({ id: uid('scr'), type: 'scripture', title: 'Scripture', ref: '', text: '' }),
  };

  // ── Add / import confirmation ────────────────────────────────────────────
  // Every path that creates a new section — hymn bank, the add-menu, a file
  // or clipboard import — routes through here so the operator picks the
  // destination playlist, the theme, and (for text content) how it splits
  // into slides, in one step instead of three.
  let acDraft = null;   // { item, showDelimiter, isImportBlocks, rawBlocks }
  let pendingExtraImages = [];   // remaining files from a multi-select image add
  let pendingExtraBlockItems = [];   // remaining presentations from a multi-item playlist import

  function openAddConfirm(item, opts = {}) {
    acDraft = { item, showDelimiter: !!opts.showDelimiter, isImportBlocks: !!opts.isImportBlocks, rawBlocks: opts.rawBlocks || null };

    const titleInp = document.getElementById('ac-title');
    if (titleInp) titleInp.value = item.title || '';

    const playlistSel = document.getElementById('ac-playlist');
    if (playlistSel) {
      playlistSel.innerHTML = '';
      playlists.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        if (p.id === activePlaylistId) o.selected = true;
        playlistSel.appendChild(o);
      });
    }

    const themeSel = document.getElementById('ac-theme');
    if (themeSel) {
      themeSel.innerHTML = '';
      const dflt = document.createElement('option');
      dflt.value = ''; dflt.textContent = 'Output default';
      themeSel.appendChild(dflt);
      const all = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
      all.forEach(l => {
        const o = document.createElement('option');
        o.value = l.id; o.textContent = l.name;
        themeSel.appendChild(o);
      });
      // Songs default to the lyrics theme when one exists — the common case.
      if (item.type === 'song') {
        const lyrics = all.find(l => l.id === 'lyrics-block');
        if (lyrics) themeSel.value = lyrics.id;
      }
    }

    const delimGroup = document.getElementById('ac-delim-group');
    if (delimGroup) delimGroup.style.display = acDraft.showDelimiter ? '' : 'none';
    document.querySelectorAll('#ac-delim-chips .ts-chip').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.lines) === DEFAULT_LINES_PER_SLIDE));

    document.getElementById('add-confirm-heading').textContent =
      opts.isImportBlocks ? 'Import into playlist' : 'Add to playlist';
    document.getElementById('add-confirm-modal')?.classList.remove('hidden');
    titleInp?.focus();
  }

  function closeAddConfirm() {
    document.getElementById('add-confirm-modal')?.classList.add('hidden');
    acDraft = null;
  }

  function confirmAddConfirm() {
    if (!acDraft) return;
    const { item, showDelimiter, isImportBlocks, rawBlocks } = acDraft;

    const titleInp = document.getElementById('ac-title');
    if (titleInp?.value.trim()) item.title = titleInp.value.trim();

    const themeSel = document.getElementById('ac-theme');
    item.themeId = themeSel?.value || null;

    if (showDelimiter) {
      const chip = document.querySelector('#ac-delim-chips .ts-chip.active');
      const n = chip ? Number(chip.dataset.lines) : DEFAULT_LINES_PER_SLIDE;
      if (isImportBlocks && rawBlocks) {
        if (n === 0) {
          // Keep each imported block as its own fixed slide.
          item.type = 'slides';
          item.blocks = rawBlocks.map(b => ({ label: b.label, text: (b.lines || []).join('\n') }));
          delete item.linesPerSlide;
        } else {
          // Re-flow the imported text as lyrics, n lines per slide.
          item.type = 'song';
          item.linesPerSlide = n;
          item.blocks = rawBlocks.map(b => ({ label: b.label, lines: [...(b.lines || [])] }));
        }
      } else {
        item.linesPerSlide = n;
      }
    }

    const playlistSel = document.getElementById('ac-playlist');
    const target = playlists.find(p => p.id === playlistSel?.value) || service;
    commitItem(target, item);
    closeAddConfirm();

    // A multi-select image add confirms once, then the rest ride along with
    // the same playlist/theme rather than reopening the dialog per file.
    if (item.type === 'image' && pendingExtraImages.length) {
      const extras = pendingExtraImages; pendingExtraImages = [];
      (async () => {
        for (const f of extras) {
          const src = await readImage(f);
          if (src) target.items.push({ id: uid('img'), type: 'image', title: f.name.replace(/\.[^.]+$/, ''), src, themeId: item.themeId });
        }
        saveService(); renderStack(); renderSidebar();
      })();
    }

    // A playlist import confirms its first presentation once, then the rest
    // ride along with the same playlist/theme/delimiter choice — same pattern
    // as the multi-select image add above, just for imported blocks instead.
    if (isImportBlocks && pendingExtraBlockItems.length) {
      const extras = pendingExtraBlockItems; pendingExtraBlockItems = [];
      const chip = document.querySelector('#ac-delim-chips .ts-chip.active');
      const n = chip ? Number(chip.dataset.lines) : DEFAULT_LINES_PER_SLIDE;
      for (const extra of extras) {
        const extraItem = n === 0
          ? { id: uid('slides'), type: 'slides', title: extra.name || 'Imported slides', themeId: item.themeId,
              blocks: extra.blocks.map(b => ({ label: b.label, text: (b.lines || []).join('\n') })) }
          : { id: uid('song'), type: 'song', title: extra.name || 'Imported slides', themeId: item.themeId, linesPerSlide: n,
              blocks: extra.blocks.map(b => ({ label: b.label, lines: [...(b.lines || [])] })) };
        target.items.push(extraItem);
      }
      saveService(); renderStack(); renderSidebar();
    }
  }

  function readImage(file) {
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onerror = () => resolve(null);
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const scale = Math.min(1, 1920 / img.naturalWidth);
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * scale);
          c.height = Math.round(img.naturalHeight * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL(/png|webp/i.test(file.type) ? 'image/png' : 'image/jpeg', 0.86));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // ── Song bank ───────────────────────────────────────────────────────────
  function openSongBank() {
    document.getElementById('hymn-modal')?.classList.remove('hidden');
    renderHymnList('');
    document.getElementById('hymn-search')?.focus();
  }
  function closeSongBank() { document.getElementById('hymn-modal')?.classList.add('hidden'); }

  function renderHymnList(query) {
    const host = document.getElementById('hymn-list');
    if (!host || typeof searchHymns !== 'function') return;
    const results = searchHymns(query);
    host.innerHTML = '';
    if (!results.length) {
      host.innerHTML = '<div class="svc-empty">No songs match that search</div>';
      return;
    }
    results.forEach(h => {
      const row = document.createElement('button');
      row.className = 'hymn-row';
      row.innerHTML =
        `<div class="hymn-row-main"><div class="hymn-title">${escapeHtml(h.title)}</div>` +
        `<div class="hymn-sub">${escapeHtml(h.author)} · ${h.year} · ${h.blocks.length} stanzas</div></div>` +
        `<span class="hymn-add">Add</span>`;
      row.addEventListener('click', () => {
        closeSongBank();
        openAddConfirm({
          id: uid('song'), type: 'song',
          title: h.title, author: h.author, year: h.year,
          linesPerSlide: DEFAULT_LINES_PER_SLIDE,
          blocks: h.blocks.map(b => ({ label: b.label, lines: [...b.lines] })),
        }, { showDelimiter: true });
      });
      host.appendChild(row);
    });
  }

  // ── Import (file / clipboard / paste-textarea fallback) ──────────────────
  // Default representation is 'slides' (one imported block = one fixed slide);
  // openAddConfirm's delimiter choice may rebuild this as a chunked 'song'
  // instead — the raw {label, lines} blocks travel alongside for that.
  function toBlocksItem(blocks, title) {
    return {
      id: uid('slides'), type: 'slides', title: title || 'Imported slides',
      blocks: blocks.map(b => ({ label: b.label, text: (b.lines || []).join('\n') })),
    };
  }

  async function importArrayBufferAsFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const r = await fetch(`${SERVER}/api/service/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, dataBase64: btoa(bin) }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'import failed');
    return d;
  }

  async function importTextViaServer(text) {
    const r = await fetch(`${SERVER}/api/service/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d;
  }

  // A .proplaylist import resolves to multiple presentations (one per item
  // in the playlist) rather than one flat block list. Confirm the first like
  // any other import; the rest ride along on the same playlist/theme choice
  // once confirmed, via pendingExtraBlockItems (mirrors pendingExtraImages).
  function beginImportResult(d, fallbackTitle) {
    if (d.items && d.items.length) {
      const [first, ...rest] = d.items;
      pendingExtraBlockItems = rest;
      openAddConfirm(toBlocksItem(first.blocks, first.name || fallbackTitle), { showDelimiter: true, isImportBlocks: true, rawBlocks: first.blocks });
    } else {
      openAddConfirm(toBlocksItem(d.blocks, fallbackTitle), { showDelimiter: true, isImportBlocks: true, rawBlocks: d.blocks });
    }
  }

  // Direct path from the add-menu: pick a file, import, add as a section —
  // no confirmation dialog, since a folder should be quick to fill.
  async function quickImportFile(file) {
    try {
      const d = await importArrayBufferAsFile(file);
      beginImportResult(d, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      if (typeof toast === 'function') toast(err.message, 'error');
    }
  }

  async function quickImportClipboard() {
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error('Clipboard is empty');
      const d = await importTextViaServer(text);
      openAddConfirm(toBlocksItem(d.blocks, 'Pasted content'), { showDelimiter: true, isImportBlocks: true, rawBlocks: d.blocks });
    } catch (err) {
      // Permission denied or nothing to read — fall back to the paste dialog.
      openImport();
    }
  }

  // Fallback dialog (manual paste when clipboard read is blocked).
  let importPending = null;
  function openImport() {
    importPending = null;
    const ta = document.getElementById('import-text');
    const st = document.getElementById('import-status');
    if (ta) ta.value = '';
    if (st) st.textContent = '';
    document.getElementById('import-modal')?.classList.remove('hidden');
    ta?.focus();
  }
  function closeImport() { document.getElementById('import-modal')?.classList.add('hidden'); }

  async function importFileIntoDialog(file) {
    const st = document.getElementById('import-status');
    if (st) st.textContent = `Reading ${file.name}…`;
    try {
      const d = await importArrayBufferAsFile(file);
      importPending = d;
      const count = d.items ? d.items.length : d.blocks.length;
      const label = d.items ? `presentation${count === 1 ? '' : 's'}` : `slide${count === 1 ? '' : 's'}`;
      if (st) st.textContent = `${count} ${label} found in ${file.name}${d.note ? ` (${d.note})` : ''} — press “Add slides”.`;
    } catch (err) {
      importPending = null;
      if (st) st.textContent = err.message;
    }
  }

  async function confirmImport() {
    const ta = document.getElementById('import-text');
    let d = importPending;
    if (!d && ta && ta.value.trim()) {
      try { d = await importTextViaServer(ta.value); }
      catch (err) { if (typeof toast === 'function') toast(err.message, 'error'); return; }
    }
    const hasContent = d && ((d.items && d.items.length) || (d.blocks && d.blocks.length));
    if (!hasContent) {
      if (typeof toast === 'function') toast('Nothing to import', 'error');
      return;
    }
    closeImport();
    beginImportResult(d, 'Pasted content');
  }

  // ── Grid/List + scale, applied to expanded card previews ─────────────────
  function applyView() {
    const size = parseInt(localStorage.getItem('kairo-svc-scale') || '190', 10);
    const view = localStorage.getItem('kairo-svc-view') || 'grid';
    document.querySelectorAll('#svc-stack-list .svc-slides-grid').forEach(g => {
      g.classList.toggle('is-list', view === 'list');
      g.style.setProperty('--svc-card', size + 'px');
    });
    document.querySelectorAll('#svc-view-chips .ts-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view));
    const slider = document.getElementById('svc-scale');
    if (slider) {
      if (Number(slider.value) !== size) slider.value = size;
      slider.style.display = view === 'list' ? 'none' : '';
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;

    loadAll();

    document.getElementById('playlist-switcher')?.addEventListener('click', (e) => openPlaylistSwitcherPopover(e.currentTarget));
    renderPlaylistSwitcher();

    if (typeof loadHymnBank === 'function') {
      loadHymnBank().then(n => { if (n) console.log(`[Songs] imported bank loaded: ${n} songs`); });
    }

    document.getElementById('songs-btn')?.addEventListener('click', openSongBank);
    document.getElementById('close-hymn')?.addEventListener('click', closeSongBank);
    document.querySelector('#hymn-modal .modal-overlay')?.addEventListener('click', closeSongBank);
    document.getElementById('hymn-search')?.addEventListener('input', e => renderHymnList(e.target.value));

    // Folder-level "+": creates a new playlist, Explorer-style — appears
    // immediately with an editable name rather than behind a naming dialog.
    document.getElementById('svc-add-menu-btn')?.addEventListener('click', () => {
      const p = createPlaylist('New Playlist');
      switchPlaylist(p.id);
      startRenamingSwitcher();
    });

    // Content-level "+": adding songs/slides/scripture/images only makes
    // sense once you're inside a playlist, so it lives on the stack view's
    // own toolbar rather than duplicated at the folder level.
    document.getElementById('svc-add-section-btn')?.addEventListener('click', (e) => openAddContentPopover(e.currentTarget));

    // Hidden input used for the quick "Import file…" path from the add-menu.
    let quickFileInput = document.getElementById('quick-import-file');
    if (!quickFileInput) {
      quickFileInput = document.createElement('input');
      quickFileInput.type = 'file';
      quickFileInput.id = 'quick-import-file';
      quickFileInput.accept = '.txt,.md,.docx,.pptx,.pro6,.pro,.pro7,.probundle,.proplaylist,.json';
      quickFileInput.style.display = 'none';
      document.body.appendChild(quickFileInput);
    }
    quickFileInput.addEventListener('change', () => {
      const f = quickFileInput.files?.[0];
      quickFileInput.value = '';
      if (f) quickImportFile(f);
    });

    const fileInput = document.getElementById('svc-image-file');
    fileInput?.addEventListener('change', async () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      const item = activeItem();
      // Replacing the current image (from the full-edit inspector) is a direct
      // in-place swap, not a new section — no confirm dialog needed.
      const replacing = item && item.type === 'image'
        && !document.getElementById('svc-fullscreen')?.classList.contains('hidden');
      for (const f of files) {
        const src = await readImage(f);
        if (!src) continue;
        if (replacing) {
          item.src = src; saveService(); renderFullEdit(); renderStack();
        } else {
          openAddConfirm({ id: uid('img'), type: 'image', title: f.name.replace(/\.[^.]+$/, ''), src }, {});
          break; // multi-select: confirm the first, add the rest after
        }
      }
      if (!replacing && files.length > 1) {
        // Remaining files get the same playlist/theme once the operator
        // confirms the first — queued so the dialog isn't shown N times.
        pendingExtraImages = files.slice(1);
      }
    });

    // Fallback import dialog
    document.getElementById('close-import')?.addEventListener('click', closeImport);
    document.getElementById('import-cancel')?.addEventListener('click', closeImport);
    document.querySelector('#import-modal .modal-overlay')?.addEventListener('click', closeImport);
    document.getElementById('import-file-btn')?.addEventListener('click', () => document.getElementById('import-file')?.click());
    document.getElementById('import-file')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (f) importFileIntoDialog(f);
    });
    document.getElementById('import-confirm')?.addEventListener('click', confirmImport);

    // Add / import confirmation dialog
    document.getElementById('close-add-confirm')?.addEventListener('click', closeAddConfirm);
    document.getElementById('ac-cancel')?.addEventListener('click', closeAddConfirm);
    document.querySelector('#add-confirm-modal .modal-overlay')?.addEventListener('click', closeAddConfirm);
    document.getElementById('ac-confirm')?.addEventListener('click', confirmAddConfirm);
    document.getElementById('ac-delim-chips')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.ts-chip');
      if (!btn) return;
      document.querySelectorAll('#ac-delim-chips .ts-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    // Stack view
    document.getElementById('svc-close-stack')?.addEventListener('click', closeStack);
    document.getElementById('svc-view-chips')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.ts-chip');
      if (!btn) return;
      localStorage.setItem('kairo-svc-view', btn.dataset.view);
      applyView();
    });
    document.getElementById('svc-scale')?.addEventListener('input', (e) => {
      localStorage.setItem('kairo-svc-scale', e.target.value);
      applyView();
    });

    // Full-edit view
    document.getElementById('svc-back-to-stack')?.addEventListener('click', closeFullEdit);
    document.getElementById('svc-fs-title')?.addEventListener('change', (e) => {
      const item = activeItem();
      if (!item) return;
      item.title = e.target.value; saveService(); renderSidebar(); renderStack();
    });
    document.getElementById('svc-item-theme-btn')?.addEventListener('click', (e) => {
      const item = activeItem();
      if (item) openThemePopover(e.currentTarget, item);
    });
    document.getElementById('svc-delim-chips')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.ts-chip');
      const item = activeItem();
      if (!btn || !item) return;
      item.linesPerSlide = Number(btn.dataset.lines);
      saveService(); renderSidebar(); syncFullEditDelim();
      editSlideIndex = 0; renderFullEdit();
    });

    // Space / arrows advance whichever slide is currently live — works from
    // the stack (present mode) as well as full-edit, since that's where an
    // operator actually runs a service from.
    document.addEventListener('keydown', (e) => {
      const stackOpen = !document.getElementById('svc-stack-view')?.classList.contains('hidden');
      const fsOpen = !document.getElementById('svc-fullscreen')?.classList.contains('hidden');
      if (!stackOpen && !fsOpen) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); advanceLiveSlide(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); advanceLiveSlide(-1); }
    });

    applyView();
    renderSidebar();
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  // Song auto-detection will want the playlist's lyrics to build its index.
  window.KairoService = {
    get service() { return service; },
    slidesFor, sendSlide, focusInStack, openFullEdit, closeStack, closeFullEdit,
  };
})();
