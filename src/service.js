// KAIRO — Playlist (service order)
//
// A playlist is a folder: everything the operator wants to project during the
// service, stacked in the order it will be presented. Selecting the playlist
// (any section, or "+ Add content") takes over the centre column so the whole
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
  // Shared with app.js/display.html — see design_space.js.
  const DESIGN_W = window.KAIRO_DESIGN_W, DESIGN_H = window.KAIRO_DESIGN_H;

  // Kept in sync with server/translate.js's LANGUAGES map by hand — small,
  // fixed list, not worth a round-trip to /api/translate/languages just to
  // populate a 3-item picker.
  const TRANSLATE_LANGUAGES = [
    { code: 'fr', name: 'French' },
    { code: 'es', name: 'Spanish' },
    { code: 'pt', name: 'Portuguese' },
  ];

  // Auto-default for the bilingual/Multi-Language themes: if an item needs
  // translation and no language has been explicitly picked yet, but exactly
  // one of the three bundled MT models is actually installed, just use that
  // one instead of leaving the panel blank until an operator manually picks
  // it — the language isn't ambiguous when there's only one candidate.
  // Deliberately NOT persisted to item.translateTo (so the language-picker
  // chips still show "nothing chosen" and an explicit pick still overrides
  // this cleanly) — it's a resolve-only fallback, same idiom themeForItem
  // already uses for item.themeId. With zero or 2+ installed, there's a
  // real choice to make, so this stays unset and the operator picks as
  // before. Warmed once at boot (see init()) rather than fetched fresh on
  // every render — a few hundred ms of "not ready yet" just means this
  // falls back to today's behavior for that one render, self-healing on
  // the next.
  let installedMtLangs = null; // Set<code> once resolved, else null
  async function loadInstalledMtLangs() {
    const results = await Promise.all(TRANSLATE_LANGUAGES.map(({ code }) =>
      fetchWithTimeout(`${SERVER}/api/translate-model/status?lang=${code}`)
        .then(r => r.json()).then(s => ({ code, installed: !!s.installed }))
        .catch(() => ({ code, installed: false }))));
    installedMtLangs = new Set(results.filter(r => r.installed).map(r => r.code));
  }
  function effectiveTranslateTo(item) {
    if (item.translateTo) return item.translateTo;
    if (installedMtLangs && installedMtLangs.size === 1) return [...installedMtLangs][0];
    return null;
  }

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
  let selectedItemIds = new Set(); // multi-select in the sidebar (Cmd/Ctrl+Click, Shift+Click, Cmd/Ctrl+A)
  let lastClickedItemId = null;    // anchor for Shift+Click range-select
  let liveSlideKey = null;
  let slideSearchQuery = ''; // lowercased, trimmed — see the search wiring below and slideCard()'s use of it
  let dragFlowIndex = null;    // index being dragged in the flow view
  const expanded = new Set(); // section ids currently expanded in the stack
  // Single-open by design: expanding a card closes any other open one instead
  // of piling up. renderStack() rebuilds and repaints every *expanded*
  // card's full slide grid on every single call (any sidebar click, any
  // send, etc.), so letting more than one stay open at once meant that cost
  // multiplied with every card ever opened, and — confirmed live via the
  // topbar-diag logging in app.js — a couple of open cards was enough to
  // block the main thread for several hundred ms on a real machine, long
  // enough to trip the WebView compositor bug where the top bar stops
  // repainting until something forces it to (see the .top-bar-center
  // comment in styles.css for the documented prior instance of that exact
  // symptom). Collapsing to at most one open card removes the "multiply"
  // entirely, regardless of which of the three places below opens one.
  function expandOnly(id) {
    expanded.clear();
    expanded.add(id);
  }

  // Slide-level multi-select/clipboard — shared across all three surfaces
  // that render "this item's slides" (Quick Edit's flowRow, the Stack/Grid
  // view's slideCard, and Full-scale edit's renderItemSlidesList in app.js).
  // A single global set is enough (not per-item) because those three views
  // are mutually exclusive — showCenterView only shows one at a time, and
  // item mode hides the stack entirely — so at most one item's slide list
  // is ever visible at once.
  let selectedSlideIndices = new Set();
  let lastClickedSlideIndex = null;
  let slideClipboard = null; // { blocks: [...] } — deep-cloned blocks ready to paste

  function clearSlideSelection() {
    selectedSlideIndices.clear();
    lastClickedSlideIndex = null;
  }
  function isSlideSelected(index) { return selectedSlideIndices.has(index); }

  // Shared click-gesture handler for all three slide-row builders (mirrors
  // the sidebar's own Cmd/Ctrl+Click toggle / Shift+Click range pattern,
  // src/service.js:688-715). Returns true when the click was consumed as a
  // selection gesture — the caller should stop there. Returns false for a
  // plain click, which clears the selection first and lets the caller run
  // its own single-slide action (send/focus/select, whichever this surface
  // normally does).
  function handleSlideRowClick(index, e, rerender) {
    if (e.metaKey || e.ctrlKey) {
      if (selectedSlideIndices.has(index)) selectedSlideIndices.delete(index);
      else selectedSlideIndices.add(index);
      lastClickedSlideIndex = index;
      rerender();
      return true;
    }
    if (e.shiftKey && lastClickedSlideIndex != null) {
      const lo = Math.min(lastClickedSlideIndex, index), hi = Math.max(lastClickedSlideIndex, index);
      selectedSlideIndices = new Set(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k));
      rerender();
      return true;
    }
    clearSlideSelection();
    return false;
  }

  // A slide can only be duplicated/copied when it maps onto a whole,
  // distinct block — always true for 'slides' items (1:1 with item.blocks),
  // conditionally true for 'song' items (only when that stanza's block
  // wasn't chunked by linesPerSlide into multiple slides), never true for
  // 'scripture'/'image' items (no .blocks array at all — always exactly one
  // slide tied to the whole item, nothing narrower to duplicate).
  function canDuplicateSlide(item, slide) {
    if (item.type === 'slides') return true;
    if (item.type === 'song' && slide.blockIndex != null) {
      return slide.lineStart === 0 && slide.lineEnd === (item.blocks[slide.blockIndex]?.lines || []).length;
    }
    return false;
  }
  function blockIndexForSlide(item, index, slide) {
    return item.type === 'slides' ? index : slide?.blockIndex;
  }
  // Gates the "Copy" menu item the same way "Duplicate" is gated — showing
  // it for a selection that's entirely scripture/image/chunked-song slides
  // would just silently no-op on click (copySlides filters those out and
  // returns early), which reads as a broken button rather than an absent one.
  function anySlidesDuplicable(item, indices) {
    const slides = slidesFor(item);
    return [...indices].some(i => slides[i] && canDuplicateSlide(item, slides[i]));
  }

  function duplicateSlide(item, index) {
    const slide = slidesFor(item)[index];
    if (!slide || !canDuplicateSlide(item, slide)) return;
    const bi = blockIndexForSlide(item, index, slide);
    if (bi == null || !item.blocks[bi]) return;
    const copy = JSON.parse(JSON.stringify(item.blocks[bi]));
    item.blocks.splice(bi + 1, 0, copy);
    refreshAfterSlideEdit(item);
  }

  function copySlides(item, indices) {
    const slides = slidesFor(item);
    const blockIndices = [...new Set(
      [...indices].filter(i => slides[i] && canDuplicateSlide(item, slides[i]))
        .map(i => blockIndexForSlide(item, i, slides[i]))
    )].filter(bi => bi != null);
    if (!blockIndices.length) return;
    slideClipboard = { blocks: JSON.parse(JSON.stringify(blockIndices.map(bi => item.blocks[bi]))) };
    if (typeof toast === 'function') {
      toast(`Copied ${blockIndices.length} slide${blockIndices.length === 1 ? '' : 's'}`, 'success');
    }
  }

  // Paste only supports 'slides' items for now — a song's chunked structure
  // makes "paste after this slide" ambiguous (which block, which line
  // offset?) in a way that's a much narrower edge case than the common
  // "duplicate/copy within a slide deck" path this is really for.
  function pasteSlides(item, afterIndex) {
    if (!slideClipboard || item.type !== 'slides') return;
    const copy = JSON.parse(JSON.stringify(slideClipboard.blocks));
    item.blocks.splice(afterIndex + 1, 0, ...copy);
    refreshAfterSlideEdit(item);
    if (typeof toast === 'function') {
      toast(`Pasted ${copy.length} slide${copy.length === 1 ? '' : 's'}`, 'success');
    }
  }

  function selectAllSlidesFor(item) {
    selectedSlideIndices = new Set(slidesFor(item).map((_, i) => i));
  }

  // The one place that actually mutates item.blocks/lines for a single
  // slide's removal — deleteFlowSlideOrSong (below) delegates here too, so
  // there's one implementation of the per-type branch, not two.
  function deleteSlideAt(item, index, slide) {
    if (item.type === 'slides') {
      item.blocks.splice(index, 1);
    } else if (item.type === 'song' && slide.blockIndex != null) {
      const b = item.blocks[slide.blockIndex];
      b.lines.splice(slide.lineStart, slide.lineEnd - slide.lineStart);
      shiftBreaks(b, slide.lineStart, -(slide.lineEnd - slide.lineStart));
      if (!b.lines.length && item.blocks.length > 1) item.blocks.splice(slide.blockIndex, 1);
    }
  }

  function bulkDeleteSlides(item, indices) {
    const canDelete = item.type === 'slides' || item.type === 'song';
    if (!canDelete) return;
    const slides = slidesFor(item);
    // High-to-low so earlier indices/blockIndexes already deleted don't
    // shift the meaning of the ones still queued up.
    [...indices].sort((a, b) => b - a).forEach(i => {
      if (slidesFor(item).length <= 1) return; // always keep at least one
      const slide = slides[i];
      if (slide) deleteSlideAt(item, i, slide);
    });
    clearSlideSelection();
    refreshAfterSlideEdit(item);
  }

  // Unified re-render fan-out for slide operations. Originally built only
  // for duplicate/copy/paste/bulk-delete — deleteFlowSlideOrSong/
  // splitSlideAtCaretAt/splitFlowSlideAtCaretAt were deliberately left on
  // their own narrower saveService()+renderFullEdit()+renderSidebar() calls,
  // which never refreshed the Stack/Grid view. That gap turned into a real,
  // reported bug once those same three became reachable from the grid
  // card's own right-click menu (not just Flow view, where renderFullEdit()
  // alone happened to be enough) — "right click a slide to delete it, it
  // never works," because the grid never re-rendered to show the deletion.
  // All three now use this fan-out too.
  function refreshAfterSlideEdit(item) {
    saveService();
    renderSidebar();
    renderStack();
    if (activeItemId === item.id && !document.getElementById('svc-fullscreen')?.classList.contains('hidden')) {
      renderFullEdit();
    }
    window.KairoItemStyleEditor?.refreshSlides?.(item.id);
  }

  // None of this file's fetch() calls to the local Kairo server previously
  // had a timeout — a stalled response left callers (translation lookups,
  // media uploads, imports) hung indefinitely with no way to tell "stuck"
  // from "slow". Wraps fetch with an AbortController-based timeout; callers
  // still get a normal fetch Response or a rejected promise.
  const FETCH_TIMEOUT_MS = 15_000;
  function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  // Fire-and-forget diagnostic logging — forwards to the server's debug.log
  // so bug reports can be diagnosed by reading logs instead of re-testing on
  // the shared live server. Never throws, never blocks the caller.
  function debugLog(event, data) {
    try {
      fetch(`${SERVER}/api/debug-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, data }),
      }).catch(() => {});
    } catch {}
  }

  function todayName() {
    return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // Auto-creates the permanent "Default" playlist that collects every file
  // import (see archiveImportToDefault) if it doesn't already exist. Called
  // from every loadAll() path so it's unconditionally present — a lazy
  // create-on-first-import would need this exact guard duplicated at every
  // import entry point instead of once here.
  function ensureDefaultPlaylist() {
    if (playlists.some(p => p.isDefault)) return false;
    playlists.unshift({ id: uid('pl'), name: 'Default', items: [], isDefault: true });
    if (!activePlaylistId) { activePlaylistId = playlists[0].id; service = playlists[0]; }
    return true;
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
        // The old plain sermonFollow boolean became a followMode string
        // ('sermon'/'script'/unset) so a 'slides' item can pick which
        // tracking engine, not just on/off — carry an operator's existing
        // choice forward rather than silently turning their auto-advance
        // off. Idempotent: once followMode is set, this never runs again
        // for that item.
        let followModeMigrated = false;
        playlists.forEach(p => (p.items || []).forEach(it => {
          if (it.sermonFollow && !it.followMode) { it.followMode = 'sermon'; followModeMigrated = true; }
        }));
        if (ensureDefaultPlaylist() || followModeMigrated) saveAll();
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
    ensureDefaultPlaylist();
    saveAll();
  }

  function saveAll() {
    try { localStorage.setItem(PLAYLISTS_KEY, JSON.stringify({ playlists, activePlaylistId })); } catch {}
  }
  // Alias — the bulk of this file predates multi-playlist support and just
  // wants "persist whatever changed", which is always the whole set now.
  // Timer segments aren't playlist items (they live server-side, see
  // segments.js), so Full-scale edit's normal "mutate item, call
  // saveService()" autosave path (app.js's writeItemSlideStyleFromSynthetic)
  // wouldn't actually persist anything for one — this is the one place
  // that needs to know the difference and redirect to the server instead.
  function saveService() {
    markLookupCandidatesDirty();
    saveAll();
    if (window.KairoItemStyleEditor?.isOpen?.()) {
      const item = window.KairoItemStyleEditor.getItem();
      if (item?.type === 'timer') {
        fetchWithTimeout(`${SERVER}/api/segments/${item.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ themeId: item.themeId ?? null, slideStyles: item.slideStyles || {} }),
        }).catch(() => {});
      }
    }
  }

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
    if (!p || !name.trim() || p.isDefault) return;
    p.name = name.trim();
    saveAll();
    renderPlaylistSwitcher();
  }

  function deletePlaylist(id) {
    const target = playlists.find(p => p.id === id);
    if (target?.isDefault) {
      if (typeof toast === 'function') toast("Default can't be deleted", 'error');
      return;
    }
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
  // "Song" is reserved for content actually picked from the Song/Hymn bank
  // (songBank flag, set in renderHymnList's add handler) — imported/chunked
  // text also uses type:'song' internally for its linesPerSlide machinery,
  // but that's an implementation detail, not something the operator picked
  // a song for, so it reads as "Slides" like everything else that isn't.
  const typeLabel = item => {
    if (item.type === 'song' && !item.songBank) return 'Slides';
    return { song: 'Song', slides: 'Slides', image: 'Image', scripture: 'Scripture' }[item.type] || item.type;
  };

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
            // b.label is empty for a Custom-lines import's single flattened
            // block (see confirmAddConfirm) — that block never had a real
            // section name, just the deck's own title, which repeated on
            // every single chunked slide was pure noise (owner: "title in
            // all slide is not required, slide numbers are more important" —
            // applies here too, not just the 'slides' case above, since a
            // song saved to the library from that same flow keeps carrying
            // this same blank label). Also catches decks saved to the
            // library BEFORE this fix, whose block label is still the
            // deck's own title verbatim — same noise, just pre-existing
            // data rather than a fresh blank string. Either way, fall back
            // to a bare slide number instead of prefixing " · N" with
            // something that isn't a real section name. A real song's
            // genuine stanza label (e.g. "Verse 1") is untouched.
            const hasRealLabel = b.label && b.label.trim().toLowerCase() !== String(item.title || '').trim().toLowerCase();
            out.push({
              label: parts.length > 1 ? (hasRealLabel ? `${b.label} · ${i + 1}` : `${i + 1}`) : (hasRealLabel ? b.label : ''),
              lines, text: lines.join('\n'), reference: item.title,
              blockIndex: bi, lineStart: start, lineEnd: start + lines.length,
            });
          });
        });
        return out;
      }
      case 'slides':
        // No per-slide reference caption here, unlike scripture/song — an
        // imported deck's file title repeated under every single slide (e.g.
        // "FINANCIAL FORTUNE IS MY HERITAGE" under all 181 slides) is just
        // noise, not information; each slide already carries its own text.
        // A block carrying `.image` instead of `.text` is a pure-image cue
        // from a ProPresenter import (see slide_import.js) — rendered the
        // same shape as an 'image'-type item's own single slide so every
        // existing image-slide code path (flowRow, slideCard, fit mode)
        // handles it with no further branching.
        //
        // A block carrying `.layers` is a REAL ProPresenter scene (position/
        // font/color/images, preserved as-authored rather than re-themed —
        // see slide_import.js's decodeCueSceneLayers). Unlike Timer's own
        // isScene slides (which look up item.scenes[sceneIndex].layers by
        // index), this item type carries its layers directly on the slide
        // object — a 'slides' item's blocks are already 1:1 with its
        // slides, with no separate scenes array to index into.
        return (item.blocks || []).map((b, i) => b.layers
          ? { label: b.label || `Slide ${i + 1}`, isScene: true, blockIndex: i, layers: b.layers, canvasSize: b.canvasSize, text: b.text || '', reference: '' }
          : b.image
          ? { label: b.label || `Slide ${i + 1}`, image: b.image, text: '', reference: '' }
          : {
              label: b.label || `Slide ${i + 1}`,
              lines: (b.text || '').split('\n'),
              text: b.text || '', reference: '',
            });
      case 'image':
        return [{ label: item.title, image: item.src, text: '', reference: item.title }];
      case 'scripture':
        return [{ label: item.ref, lines: [item.text || item.ref], text: item.text || '', reference: item.ref,
                  book: item.book || null, chapter: item.chapter || null, verse: item.verse || null }];
      // A segment (server/segments.js) is a real item for editing purposes
      // ("a slide with a timer component"). Scenes (segment.scenes — a
      // storyboard, played in order across the live countdown, each with
      // its own explicit duration and complete layer set) show up here as
      // real slides, exactly like a Song/Slides deck's own multiple
      // slides — same thumbnail panel, same click-to-select, same
      // Duplicate/Copy/Paste right-click menu, rather than a separate
      // bespoke list. A plain segment with no scenes still gets the one
      // placeholder slide it always had.
      case 'timer':
        if (item.scenes && item.scenes.length) {
          return item.scenes.map((sc, i) => ({
            label: sc.name || `Slide ${i + 1}`, text: '', reference: '', timerText: '',
            isScene: true, sceneIndex: i, durationSec: sc.durationSec,
          }));
        }
        return [{ label: item.name || item.title || 'Timer', text: '', reference: '', timerText: '' }];
      default:
        return [];
    }
  }

  // Whether a 'slides' item can become a chunked 'song' — image blocks
  // (ProPresenter picture slides, see the 'slides' case above) have no
  // .lines to chunk, so re-flowing one into a song would silently drop it.
  function slidesHasImages(item) {
    return (item.blocks || []).some(b => b.image);
  }

  // The delimiter's display value for whichever type the item currently is —
  // 'slides' items have no linesPerSlide field at all (they're implicitly
  // "0", one block per slide), so the raw field can't just be read directly.
  function linesPerSlideValue(item) {
    if (item.type === 'slides') return 0;
    return item.linesPerSlide == null ? DEFAULT_LINES_PER_SLIDE : item.linesPerSlide;
  }

  // Re-chunks (n > 0) or un-chunks (n === 0) an item's slides, converting
  // between 'song' and 'slides' the same way confirmAddConfirm does at
  // import time (src/service.js's add-confirm modal) — exposed here so the
  // "lines per slide" choice stays editable after import too, not just at
  // the moment of import. Returns false (no-op, item untouched) if n > 0 is
  // asked of a 'slides' item holding image blocks, since a song stanza has
  // no way to represent those.
  function setLinesPerSlide(item, n) {
    n = Math.max(0, Math.floor(Number(n)) || 0);
    if (n === 0) {
      if (item.type === 'song') {
        item.blocks = (item.blocks || []).map(b => ({ label: b.label, text: (b.lines || []).join('\n') }));
        item.type = 'slides';
      }
      delete item.linesPerSlide;
      return true;
    }
    if (item.type === 'slides') {
      if (slidesHasImages(item)) return false;
      item.blocks = (item.blocks || []).map(b => ({ label: b.label, lines: (b.text || '').split('\n') }));
      item.type = 'song';
    }
    item.linesPerSlide = n;
    return true;
  }

  // Theme this section renders with, if the operator overrode the output default.
  // Falls back to the REAL configured primary-output default theme
  // (app.js's primaryOutputLook, backed by Settings' per-output theme map) —
  // not just "whichever theme happens to be first in the array", which
  // previously made an item left on "Output default" silently preview (and
  // need-translation-check) as an arbitrary, unrelated theme whenever the
  // operator had reordered/deleted themes such that a different one ended
  // up at index 0.
  function themeForItem(item) {
    const list = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
    if (!list.length) return null;
    const explicit = list.find(l => l.id === item.themeId);
    if (explicit) return explicit;
    // Mirrors resolveItemBaseLook's timer branch in app.js — a segment
    // nobody's assigned a theme to yet must still resolve to something with
    // an actual 'timer'-bound layer, not whichever verse/reference theme
    // the output happens to be running, or the countdown silently never
    // shows up on the real output even though Edit previewed it correctly.
    if (item.type === 'timer') {
      const timerDefault = list.find(l => l.id === 'timer-big');
      if (timerDefault) return timerDefault;
    }
    if (typeof primaryOutputLook === 'function') {
      const primary = primaryOutputLook();
      if (primary) return primary;
    }
    return list[0];
  }
  function itemLookOverride(item) {
    if (!item || !item.themeId) return null;
    const list = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
    return list.find(l => l.id === item.themeId) || null;
  }

  // ── Multi-Language translation ────────────────────────────────────────────
  // Cache is keyed by language + a natural key (book/chapter/verse for
  // scripture, the raw text otherwise) so re-sending or re-previewing the
  // same content — or two different items that happen to share a verse —
  // never re-fetches. Scripture resolves against a real bundled translation
  // server-side; anything else goes through Claude. See server/translate.js.
  const translationCache = new Map();

  function themeNeedsTranslation(look) {
    return !!(look?.layers || []).some(l => l.type === 'text' && l.binding === 'verse_translated');
  }

  function translationCacheKey(lang, slide) {
    if (slide.book && slide.chapter && slide.verse) return `${lang}|${slide.book}|${slide.chapter}|${slide.verse}`;
    return `${lang}|${slide.text || ''}`;
  }

  // Returns the translation NOW if cached (else ''), and — if a fetch is
  // needed — kicks it off in the background and calls `onReady(text)` once
  // it resolves. Callers render immediately with whatever comes back and
  // re-render on `onReady`, rather than blocking the current paint on a
  // network round-trip.
  function getTranslatedText(item, slide, onReady) {
    const lang = effectiveTranslateTo(item);
    if (!lang || !themeNeedsTranslation(themeForItem(item))) return '';
    const key = translationCacheKey(lang, slide);
    if (translationCache.has(key)) return translationCache.get(key);
    if (!slide.text && !(slide.book && slide.chapter && slide.verse)) return '';

    translationCache.set(key, ''); // placeholder so concurrent renders don't double-fetch
    fetchWithTimeout(`${SERVER}/api/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: slide.text || '', lang,
        book: slide.book, chapter: slide.chapter, verse: slide.verse,
      }),
    }).then(r => r.json()).then(d => {
      if (!d.ok) throw new Error(d.error || 'Translation failed');
      translationCache.set(key, d.text || '');
      onReady?.(d.text || '');
    }).catch(() => {
      translationCache.delete(key); // let the next render retry rather than sticking on a transient failure
      // Silent — a translation miss just means that panel stays blank until
      // the next retry; it's not worth interrupting a live service over.
    });
    return '';
  }

  // ── Speech-driven auto-advance ("Auto-follow") ─────────────────────────
  // THREE engines, splitting "what should be live" from "where in it are
  // we":
  //  • src/content_lookup.js — listens even with NOTHING live, and brings
  //    a song or slide deck up the moment its OPENING is clearly heard
  //    (same idea as scripture auto-detect, scoped to the playlist + the
  //    full Song Bank).
  //  • src/lyrics_follow.js — once a SONG is live, chases an exact token
  //    position (sung verbatim from a known script).
  //  • src/sermon_follow.js — once a 'slides' deck with its own Auto-
  //    Advance turned on is live, tracks position by distinctive
  //    vocabulary (a sermon is paraphrased, not recited).
  // Only one position-tracking engine is ever live at once; the lookup
  // engine runs alongside it independently, so it can still catch the
  // NEXT song starting while the current one is still being tracked. Fed
  // every {type:'transcript'} the WS delivers (app.js → onTranscript).
  // All three degrade by freezing/staying silent — a wrong flip (or a
  // wrong autonomous send) mid-service is glaring, a missed one is one
  // click.
  //
  // Driven directly by Start Listening (app.js's handleConnectionState
  // calls setAutoFollow(true)/(false) on connect/disconnect) — owner:
  // "Start Listening [should be] the universal control... it automatically
  // advances based on what it hears in real time." This used to be its own
  // separate toggle an operator had to remember to also turn on, which is
  // exactly the silently-off failure mode the rest of this product fights
  // ("a wrong send is worse than a missed one" cuts both ways — a MISSED
  // auto-advance because a second switch was forgotten is a real failure
  // too). setAutoFollow is still exported and the HUD's own click handler
  // still calls it directly — an operator can pause auto-advance mid-
  // service (e.g. wants manual control through one song) without stopping
  // audio capture altogether; it's just no longer a REQUIRED separate
  // startup step.
  let follower = null;
  let followItemId = null;
  let contentLookup = null;
  let autoFollow = false;
  let followerAdvancing = false; // guard: our own sendSlide must not resync
  try { autoFollow = localStorage.getItem('kairo-auto-follow') === '1'; } catch {}

  function songShapeForFollow(item) {
    return { title: item.title || 'Song', blocks: (item.blocks || []).map(b => ({ label: b.label, lines: b.lines || [] })) };
  }
  function firstSlideOfBlock(item, blockIdx) {
    const i = slidesFor(item).findIndex(s => s.blockIndex === blockIdx);
    return i < 0 ? null : i;
  }
  // Flat deck shape sermon_follow.js expects — a 'slides' item's blocks are
  // already one slide each (unlike a song's verse/chorus blocks, which
  // expand into several slides apiece via the "Lines per slide" delimiter),
  // so this is just the plain text list, no block/slide translation needed.
  function sermonShapeForFollow(item) {
    return { title: item.title || 'Sermon', slides: (item.blocks || []).map(b => b.text || '') };
  }
  // A slide's own label doubles as its auto-advance trigger phrase for an
  // image block that has no spoken text of its own to match against —
  // owner: "if they name the image a custom name, or even the image file
  // name is called, it goes up." Custom name wins when it's real (not the
  // generic "Slide N" fallback every block gets by default); otherwise
  // falls back to the file's own name, captured at upload time
  // (b.imageFileName — see uploadMediaFiles/the image-replace handler),
  // cleaned into plain words. Genuinely nothing to key off (no custom name,
  // no captured filename — e.g. an image inserted before this existed)
  // returns '' — flattenSong tokenizes that to zero words, so the block
  // simply has no head keys and can never independently trigger a catch-up
  // or a jump, which is the correct, safe behavior for "nothing to match".
  function imageTriggerPhrase(b) {
    if (b.label && !/^slide\s+\d+$/i.test(b.label)) return b.label;
    if (b.imageFileName) return b.imageFileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    return '';
  }
  // Exact-script shape for an announcement/prepared-slide deck — reuses
  // lyrics_follow.js's own engine (it's just token alignment against a
  // known text, the exact same problem a hymn's verse/chorus is), treating
  // each slide as its own one-slide "block". Owner: "the moment the person
  // matches the first few words, it should send and immediately prepare
  // for the next one." A text slide's own lines are the script; an image
  // slide's "script" is its trigger phrase (see imageTriggerPhrase).
  function announcementShapeForFollow(item) {
    return {
      title: item.title || 'Slides',
      blocks: (item.blocks || []).map((b, i) => ({
        label: b.label || `Slide ${i + 1}`,
        lines: b.image ? [imageTriggerPhrase(b)] : (b.lines || (b.text || '').split('\n')),
      })),
    };
  }
  // A 'slides' item picks ONE of two tracking engines, since they make
  // genuinely different tradeoffs (see openItemContextMenu's submenu):
  //  'sermon' — src/sermon_follow.js, paraphrase-tolerant, tracks by
  //             distinctive vocabulary (a sermon outline is talked AROUND,
  //             not read verbatim).
  //  'script' — src/lyrics_follow.js, exact alignment against the slide's
  //             own text (an announcement is read close to verbatim off
  //             the slide, or matched by an image's own name), with a wide
  //             maxBlockSkip so a presenter jumping straight to a later
  //             item in the deck is still caught, not just sequential +1.
  // Owner: "work on the automatic movement" — an UNSET item now defaults to
  // 'script' (exact-wording) rather than neither, matching how a 'song'
  // already auto-follows with no per-item toggle needed. This is safe by
  // construction, not just by policy: a genuine photo set or wording-free
  // deck has no label/filename/text for LyricsFollower to align against
  // (see imageTriggerPhrase — empty block = no keys = never independently
  // advances), so it simply stays inert either way. An operator who wants a
  // SPECIFIC deck to never react to ambient speech regardless can still
  // explicitly turn it Off — a real, distinct value from "never touched",
  // not just item.followMode being falsy the way it used to be.
  function followModeOf(item) {
    if (!item || item.type !== 'slides') return null;
    if (item.followMode === 'off') return null;
    if (item.followMode === 'sermon') return 'sermon';
    return 'script';
  }
  // Kept as a thin alias — several call sites below only care "is SOME
  // slides-follow engine eligible", not which one.
  function sermonFollowEligible(item) {
    return !!followModeOf(item);
  }
  // fromIndex is always a SLIDE index (matching what sendSlide/slidesFor
  // use everywhere else) regardless of which engine starts — translated to
  // a block index internally for the lyrics follower, which tracks blocks.
  function startFollower(item, fromIndex) {
    if (!item) return;
    if (item.type === 'song') {
      const LF = window.KairoLyricsFollow;
      if (!LF) return;
      follower = new LF.LyricsFollower(songShapeForFollow(item), {
        onAdvance: (e) => {
          const idx = firstSlideOfBlock(item, e.toBlockIdx);
          if (idx == null || `${item.id}:${idx}` === liveSlideKey) return;
          followerAdvancing = true;
          Promise.resolve(sendSlide(item, idx)).finally(() => { followerAdvancing = false; });
        },
        onPosition: (s) => renderFollowHud(s),
      });
      followItemId = item.id;
      const blockIdx = fromIndex != null ? (slidesFor(item)[fromIndex]?.blockIndex ?? 0) : null;
      if (blockIdx != null) follower.resync(blockIdx);
    } else if (followModeOf(item) === 'script') {
      const LF = window.KairoLyricsFollow;
      if (!LF) return;
      const blocks = (item.blocks || []).length;
      follower = new LF.LyricsFollower(announcementShapeForFollow(item), {
        // Search the whole rest of the deck, not just +1/+2 — a presenter
        // jumping straight to a later item is the expected case here, not
        // a rare exception the way a dropped verse is for a song.
        config: { maxBlockSkip: Math.max(1, blocks - 1) },
        onAdvance: (e) => {
          const idx = firstSlideOfBlock(item, e.toBlockIdx);
          if (idx == null || `${item.id}:${idx}` === liveSlideKey) return;
          followerAdvancing = true;
          Promise.resolve(sendSlide(item, idx)).finally(() => { followerAdvancing = false; });
        },
        onPosition: (s) => renderFollowHud(s),
      });
      followItemId = item.id;
      const blockIdx = fromIndex != null ? (slidesFor(item)[fromIndex]?.blockIndex ?? 0) : null;
      if (blockIdx != null) follower.resync(blockIdx);
    } else if (followModeOf(item) === 'sermon') {
      const SF = window.KairoSermonFollow;
      if (!SF) return;
      follower = new SF.SermonFollower(sermonShapeForFollow(item), {
        onAdvance: (e) => {
          if (e.toIndex == null || `${item.id}:${e.toIndex}` === liveSlideKey) return;
          followerAdvancing = true;
          Promise.resolve(sendSlide(item, e.toIndex)).finally(() => { followerAdvancing = false; });
        },
        onPosition: (s) => renderFollowHud(s),
      });
      followItemId = item.id;
      if (fromIndex != null) follower.resync(fromIndex);
    } else {
      return;
    }
    renderFollowHud(follower.snapshot());
  }
  function stopFollower() { follower = null; followItemId = null; renderFollowHud(null); }

  // Called by app.js after a Theme Studio / Full-Edit autosave — if the
  // edited theme (or per-slide style) is what's LIVE right now, re-push it
  // so the output updates without the operator hitting Send again. The
  // simple "verse on the output's default theme" case is already covered
  // by the look-update broadcast in app.js; this catches item-assigned
  // themes and the live timer, which that broadcast doesn't carry.
  function resendLiveForThemeEdit(themeId) {
    let did = false;
    if (liveSlideKey) {
      const [id, idxStr] = liveSlideKey.split(':');
      const item = service && service.items.find(i => i.id === id);
      if (item) {
        const eff = itemLookOverride(item) || themeForItem(item);
        if (themeId == null || (eff && eff.id === themeId)) { sendSlide(item, Number(idxStr)); did = true; }
      }
    }
    const liveSeg = segmentList.find(s => s.status === 'live');
    if (liveSeg) {
      const eff = themeForItem({ ...liveSeg, type: 'timer' });
      if (themeId == null || (eff && eff.id === themeId)) { sendTimerSegment(liveSeg); did = true; }
    }
    return did;
  }
  // Just the live timer segment (its warn/overtime colours changed) — no
  // touching the slide layer.
  function resendLiveTimer() {
    const liveSeg = segmentList.find(s => s.status === 'live');
    if (liveSeg) { sendTimerSegment(liveSeg); return true; }
    return false;
  }
  // Per-slide style (Full-Edit item mode) changed for a specific item+slide.
  // Full-scale edit's autosave (scheduleItemStyleAutosave, app.js) used to
  // only persist + re-push if live — nothing ever told the Stack view's
  // slide thumbnails or the Timer grid's segment cards to actually repaint,
  // so an edit (a new background image, a moved text layer, whatever) sat
  // saved and correct but invisible in either thumbnail until the operator
  // happened to leave and come back to that view, which rebuilds it fresh
  // regardless. Cheap enough to just refresh both unconditionally rather
  // than track which one the edited item actually belongs to.
  function refreshThumbnails() {
    renderStack();
    renderTimerGrid();
  }

  function resendLiveForSlideStyleEdit(itemId, slideIndex) {
    // Timer segments aren't playlist items (they live in segmentList, not
    // service.items — see getTimerItem) — a live segment being edited in
    // Full-scale edit (e.g. adding a video background) needs the SAME
    // "re-push what's already live" treatment a regular slide gets below,
    // otherwise the change just sits saved until the operator manually
    // stops/starts the segment to see it. Segments only ever have one
    // slide (index 0), unlike a real item's multiple slides.
    const liveSeg = segmentList.find(s => s.id === itemId && s.status === 'live');
    if (liveSeg) { sendTimerSegment(liveSeg); return true; }
    if (!liveSlideKey || liveSlideKey !== `${itemId}:${slideIndex}`) return false;
    const item = service && service.items.find(i => i.id === itemId);
    if (!item) return false;
    sendSlide(item, slideIndex);
    return true;
  }
  // Builds a real playlist 'song' item from a Song Bank record — the exact
  // same shape buildHymnRow's own "Add" click constructs (renderHymnList),
  // just pushed straight into service.items instead of opening the Add-to-
  // playlist confirm modal: there's no operator standing at that modal
  // mid-service to click Confirm, so an autonomous match has to land
  // directly, the same way a detected scripture reference sends without
  // anyone confirming it first.
  function addHymnToPlaylist(h) {
    const item = {
      id: uid('song'), type: 'song', songBank: true,
      title: h.title, author: h.author, year: h.year,
      linesPerSlide: DEFAULT_LINES_PER_SLIDE,
      blocks: (h.blocks || []).map(b => ({ label: b.label, lines: [...(b.lines || [])] })),
    };
    // Mirrors openAddConfirm's own default (the manual "Add" modal) — a bank
    // hymn with no stored themeId falls back to the lyrics theme, not
    // whatever the operator's general output theme happens to be. This path
    // has no operator confirm step to catch a wrong theme before it's live.
    if (h.themeId) item.themeId = h.themeId;
    else {
      const lyrics = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks.find(l => l.id === 'lyrics-block') : null;
      if (lyrics) item.themeId = lyrics.id;
    }
    service.items.push(item);
    saveService();
    renderSidebar();
    renderStack();
    return item;
  }

  // Rebuild content_lookup.js's candidate pool — every song/'slides' item
  // already in the CURRENT PLAYLIST (except whatever's already live), PLUS
  // every song in the Song Bank/Library that ISN'T already sitting in the
  // playlist under the same title. "It's in my song bank" was explicit —
  // a song doesn't need to have been staged for this service ahead of
  // time, the same way scripture detection doesn't need a verse queued up
  // first. Bank entries are tagged _bank so onMatch below knows to add them
  // to the playlist (addHymnToPlaylist) before sending, instead of trying
  // to sendSlide something that was never a real item. Cheap either way —
  // tokenizing one opening line per candidate, a few hundred short hymns
  // included — called fresh on every ingest rather than tracked as dirty
  // state, so it can never go stale after an item's added or edited.
  // onTranscript calls this on EVERY transcript delivery while auto-follow
  // is on — per app.js's own comment, interim transcripts can arrive
  // several times a second during continuous speech. Rebuilding from
  // scratch each time (including re-tokenizing all ~286 bank hymns via
  // searchHymns('')) is cheap per-call but needless repeated work for the
  // full duration of a live service. `lookupCandidatesDirty` (set by
  // saveService — the one place every playlist mutation funnels through)
  // covers a content change; comparing the live id inline below covers the
  // pool's other real input (the live item is excluded from its own
  // candidates) without needing to hook every liveSlideKey assignment site.
  let lookupCandidatesDirty = true;
  let lookupCandidatesLiveId; // undefined sentinel forces the first build
  function markLookupCandidatesDirty() { lookupCandidatesDirty = true; }
  // Owner: songs scrapped from auto-detect ("not viable") — the whole
  // premise leaned on what's actually being SUNG matching a song's opening,
  // and STT reliably transcribing singing is the same architectural dead
  // end this project killed for scripture-during-singing detection earlier.
  // Plain slide decks/announcements have no such dependency (they're
  // matched against ordinary spoken words), so they're untouched — only
  // the song half of the candidate pool (playlist songs + the whole hymn
  // bank) is dropped. content_lookup.js/lyrics_follow.js/the hymn bank
  // itself are left in place, just not fed songs anymore.
  function refreshLookupCandidates() {
    if (!contentLookup || !service) return;
    const liveId = liveSlideKey ? liveSlideKey.split(':')[0] : null;
    if (!lookupCandidatesDirty && liveId === lookupCandidatesLiveId) return;
    lookupCandidatesDirty = false;
    lookupCandidatesLiveId = liveId;
    const playlistPool = service.items.filter(i => i.id !== liveId && i.type === 'slides');
    contentLookup.setCandidates(playlistPool);
  }

  function onTranscript(msg) {
    const text = (msg && msg.text) || '';
    // words: real per-word timestamps (Deepgram always sends these; see
    // server.js's handleTranscriptSegment) — LyricsFollower uses them for
    // actual audio-time-based rate tracking instead of estimating tempo
    // from wall-clock arrival timing. Absent for engines that don't provide
    // them; LyricsFollower.ingest falls back to the old estimate then.
    const meta = { isFinal: !!(msg && msg.isFinal), words: msg && msg.words };
    if (follower && autoFollow) follower.ingest(text, meta);
    if (autoFollow) {
      if (!contentLookup) {
        const CL = window.KairoContentLookup;
        if (CL) {
          contentLookup = new CL.ContentLookup({
            onMatch: ({ item, confidence }) => {
              const target = item._bank ? addHymnToPlaylist(item._bank) : item;
              debugLog('content-lookup-match', { itemId: target.id, itemType: target.type, fromBank: !!item._bank, confidence });
              sendSlide(target, 0);
            },
          });
        }
      }
      if (contentLookup) {
        refreshLookupCandidates();
        contentLookup.ingest(text, meta);
      }
    }
  }
  function setAutoFollow(on) {
    autoFollow = !!on;
    try { localStorage.setItem('kairo-auto-follow', autoFollow ? '1' : '0'); } catch {}
    if (!autoFollow) { stopFollower(); }
    else if (liveSlideKey) {
      const [id, idx] = liveSlideKey.split(':');
      const live = service && service.items.find(i => i.id === id);
      if (live && (live.type === 'song' || sermonFollowEligible(live))) startFollower(live, Number(idx));
    }
    renderFollowHud(follower ? follower.snapshot() : null);
  }

  // Compact status chip — present while a song, or a 'slides' item with its
  // own Auto-Advance toggle on, is live. Shows the tracked position + a
  // confidence bar, and carries the master auto-follow toggle.
  function renderFollowHud(snap) {
    let el = document.getElementById('lyric-follow-hud');
    const liveItem = liveSlideKey && service && service.items.find(i => i.id === liveSlideKey.split(':')[0]);
    const followable = liveItem && (liveItem.type === 'song' || sermonFollowEligible(liveItem));
    if (!followable) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'lyric-follow-hud';
      el.className = 'lyric-follow-hud';
      document.body.appendChild(el);
    }
    const on = autoFollow;
    const state = !on ? 'off' : !snap ? 'idle' : snap.frozen ? 'frozen' : snap.armed ? 'armed' : 'tracking';
    const pct = snap ? Math.round(snap.confidence * 100) : 0;
    // The lyrics follower's snapshot names the block; the sermon follower
    // just has a slide index — name it from the deck's own slide text so
    // the HUD still reads as "here's where it thinks we are", not a bare number.
    const posLabel = !snap ? 'listening…'
      : snap.blockLabel ? snap.blockLabel
      : (slidesFor(liveItem)[snap.index]?.text || '').split('\n')[0].slice(0, 40) || `Slide ${snap.index + 1}`;
    el.innerHTML =
      `<button class="lfh-toggle ${on ? 'on' : ''}" title="Auto-advance slides by listening">` +
        `<span class="lfh-dot ${state}"></span>Auto-follow</button>` +
      (on ? `<span class="lfh-info">${posLabel}` +
        `<span class="lfh-bar"><i style="width:${pct}%"></i></span></span>` : '');
    el.querySelector('.lfh-toggle').onclick = () => setAutoFollow(!autoFollow);
  }

  async function sendSlide(item, index) {
    const slide = slidesFor(item)[index];
    if (!slide) return;
    liveSlideKey = `${item.id}:${index}`;
    // Keep the follower in step with what's actually on screen.
    if (item.type === 'song') {
      const blockIdx = slide.blockIndex ?? 0;
      if (autoFollow && (!follower || followItemId !== item.id)) startFollower(item, index);
      else if (follower && followItemId === item.id && !followerAdvancing) follower.resync(blockIdx);
    } else if (sermonFollowEligible(item)) {
      if (autoFollow && (!follower || followItemId !== item.id)) startFollower(item, index);
      else if (follower && followItemId === item.id && !followerAdvancing) follower.resync(index);
    } else if (follower) {
      stopFollower(); // this item has nothing for either follower to track
    }
    renderFollowHud(follower ? follower.snapshot() : null);
    renderStack();
    if (activeItemId === item.id && !document.getElementById('svc-fullscreen')?.classList.contains('hidden')) {
      renderFlowView(item); // refresh the "live" highlight onto this row
    }
    // Resolved (not just kicked off) — this is the actual live output, so it
    // must carry the real translation rather than sending blank and letting
    // a later re-render catch up.
    const translatedText = await awaitTranslatedText(item, slide);
    // A scene slide (slide.layers — a ProPresenter import preserved
    // as-authored, see slidesFor's 'slides' case) carries its OWN complete
    // layer set, same as Theme Studio's editor already treats it (see
    // buildSyntheticLook in app.js) — itemLookOverride is item-level only
    // (a single themeId for the whole deck), which can never vary per
    // slide the way a real per-slide scene needs to. Without this, the
    // live output would show whatever item-level theme happens to be
    // assigned (or nothing) instead of the slide's own preserved design.
    const look = slide.isScene ? { layers: slide.layers || [] } : itemLookOverride(item);
    debugLog('send-slide', {
      itemId: item.id,
      itemType: item.type,
      themeId: item.themeId || null,
      resolvedLookId: look?.id || null,
      previewLookId: themeForItem(item)?.id || null,
      hasImage: !!slide.image,
      fit: item.type === 'image' ? (item.fit || 'contain') : null,
      hasText: !!(slide.text && slide.text.trim()),
      index,
    });
    try {
      const res = await fetchWithTimeout(`${SERVER}/api/service/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          look,
          verse: {
            reference: slide.reference || '',
            // ProPresenter-style section annotation (Verse/Chorus/Bridge/
            // etc.) — only ever meaningful for a 'song' item (slidesFor's
            // other cases already fold their own label into `reference`
            // or leave it blank); the operator preview's section badge
            // (app.js renderPreviewScreen) reads this separately from
            // `reference`, which still carries the song's own title.
            label: item.type === 'song' ? (slide.label || '') : '',
            text: slide.text || '',
            nlt_text: slide.text || '',
            translatedText,
            image: slide.image || null,   // fixes images never reaching the display
            fit: item.type === 'image' ? (item.fit || 'contain') : undefined,
            slideStyle: item.slideStyles?.[index] || null, // per-slide text-layer overrides (Full Edit)
            book: 'Service', chapter: 0, verse: index + 1,
            similarity: 1, method: 'service',
          },
        }),
      });
      // fetch only rejects on network-level failure — a 4xx/5xx (e.g. an
      // oversized image tripping the body-size cap, or a stale auth token)
      // resolves normally and was silently swallowed as "sent" with nothing
      // ever reaching the display and no error anywhere to explain why.
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const body = await res.json(); if (body?.error) msg = body.error; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      debugLog('send-slide-error', { itemId: item.id, message: err.message });
      if (typeof toast === 'function') toast('Send failed: ' + err.message, 'error');
    }
  }

  // Cycle the CURRENTLY LIVE song slide's section label through the
  // standard ProPresenter-style set — a one-click fix for a wrong or
  // missing auto-detected type (see slide_import.js's own SECTION_LABEL_RE,
  // applied at import time), right where the operator is already looking,
  // rather than a trip back into the song editor. Entry point for app.js's
  // live-preview section badge (window.KairoService.cycleSectionLabel,
  // exposed below) — the badge click itself lives in app.js since that's
  // where the preview DOM is, but playlists/liveSlideKey/slidesFor/
  // sendSlide are all private to this file's own closure.
  //
  // Session-only: updates the in-memory item and re-sends so the live
  // output picks it up immediately; does NOT write back to the Song
  // Library — a real per-song edit still belongs in the editor, this is
  // for "the import guessed wrong, fix it now" during a live service.
  const SECTION_CYCLE = ['Verse', 'Chorus', 'Refrain', 'Solo', 'Pre-Chorus', 'Bridge', 'Tag', 'Intro', 'Outro'];
  // Mirrors app.js's own SECTION_TYPE_RE/sectionTypeClass exactly (same
  // class names, so the CSS palette is shared) — duplicated rather than
  // shared across the app.js/service.js boundary since app.js is a
  // separate top-level script with no access into this IIFE's scope, and
  // window.KairoService is a one-way bridge (service.js exposes TO app.js,
  // not the reverse).
  const SECTION_TYPE_RE = /^(verse|chorus|refrain|solo|pre-?chorus|bridge|tag|intro|outro|ending)/i;
  function sectionTypeClass(label) {
    const m = SECTION_TYPE_RE.exec(String(label || '').trim());
    if (!m) return null;
    const t = m[1].toLowerCase().replace(/-/g, '');
    if (t === 'prechorus') return 'sec-prechorus';
    if (t === 'ending') return 'sec-outro';
    return `sec-${t}`;
  }
  function cycleSectionLabel() {
    if (!liveSlideKey) return;
    const [itemId, idxStr] = liveSlideKey.split(':');
    const item = playlists.flatMap(p => p.items || []).find(it => it.id === itemId);
    if (!item || item.type !== 'song') return;
    const idx = Number(idxStr);
    const slide = slidesFor(item)[idx];
    if (!slide || slide.blockIndex == null) return;
    const block = item.blocks[slide.blockIndex];
    if (!block) return;
    const currentBase = String(block.label || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    let nextIdx = 0;
    if (currentBase) {
      const i = SECTION_CYCLE.findIndex(s => currentBase.startsWith(s.toLowerCase().replace(/[^a-z]/g, '')));
      nextIdx = i >= 0 ? (i + 1) % SECTION_CYCLE.length : 0;
    }
    block.label = SECTION_CYCLE[nextIdx];
    renderStack();
    sendSlide(item, idx);
  }

  // The operator's Clear Slide/Clear All action (app.js's clearOutputLayer)
  // wipes the real output and the top preview panel, but until this existed
  // never told the PLAYLIST what happened — the slide's row/thumbnail in the
  // Stack/Sidebar kept showing itself as "live" indefinitely after Clear,
  // and refreshLookupCandidates kept wrongly excluding that item from
  // auto-lookup's candidate pool since it still thought it was live. Also
  // stops a follower tracking the now-cleared item, same as removeItem —
  // nothing is live for it to sync position against anymore.
  function clearLive() {
    if (!liveSlideKey) return;
    liveSlideKey = null;
    if (follower) stopFollower(); // already calls renderFollowHud(null) internally
    else renderFollowHud(null);
    renderStack();
    renderSidebar();
  }

  async function awaitTranslatedText(item, slide) {
    const lang = effectiveTranslateTo(item);
    if (!lang || !themeNeedsTranslation(themeForItem(item))) return '';
    const key = translationCacheKey(lang, slide);
    const cached = translationCache.get(key);
    if (cached) return cached;
    if (!slide.text && !(slide.book && slide.chapter && slide.verse)) return '';
    try {
      const r = await fetchWithTimeout(`${SERVER}/api/translate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: slide.text || '', lang, book: slide.book, chapter: slide.chapter, verse: slide.verse }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Translation failed');
      translationCache.set(key, d.text || '');
      return d.text || '';
    } catch {
      // Silent — same reasoning as getTranslatedText's catch above: a live
      // service shouldn't get interrupted by a translation miss, it should
      // just send without the right-hand panel filled in.
      return '';
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
    sendSlide(item, next); // also refreshes Flow's "live" highlight if it's open
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
        btn.textContent = p.name + (p.isDefault ? ' 📌' : '');
        btn.addEventListener('click', () => { switchPlaylist(p.id); closePopover(); });

        // Cross-playlist drag target — dragItemId is set by the sidebar/stack
        // item drag handlers (moveItem's existing same-list drag), reused
        // here so dropping on a DIFFERENT playlist calls moveItemToPlaylist
        // instead. Dropping onto Default from a non-Default source is not a
        // legal destination (see moveItemToPlaylist) — skip preventDefault so
        // the browser shows its native "not allowed" cursor there instead of
        // a false-positive highlight.
        btn.addEventListener('dragover', (e) => {
          if (!dragItemId) return;
          const source = playlists.find(pl => pl.items.some(i => i.id === dragItemId));
          if (!source || source.id === p.id) return;
          if (p.isDefault && !source.isDefault) return;
          e.preventDefault();
          btn.classList.add('svc-drop-target');
        });
        btn.addEventListener('dragleave', () => btn.classList.remove('svc-drop-target'));
        btn.addEventListener('drop', (e) => {
          e.preventDefault();
          btn.classList.remove('svc-drop-target');
          if (dragItemId) moveItemToPlaylist(dragItemId, p.id);
          closePopover();
        });

        row.appendChild(btn);
        if (!p.isDefault) {
          const del = document.createElement('button');
          del.className = 'svc-playlist-row-del';
          del.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
          del.title = 'Delete playlist';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            deletePlaylist(p.id);
            openPlaylistSwitcherPopover(anchor);
          });
          row.appendChild(del);
        }
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
      row.className = 'svc-item' + (item.id === activeItemId ? ' active' : '') + (selectedItemIds.has(item.id) ? ' selected' : '');
      row.dataset.id = item.id;
      // Confirmed by isolation test: native HTML5 drag-and-drop was the
      // top-bar-disappearing bug's trigger — entering/exiting a native OS
      // drag session (WebKit/macOS) left the unrelated .top-bar layer stale,
      // even when the drag was never actually completed. `draggable` used to
      // be permanently true on the whole row, so any ordinary click with a
      // hair of mouse/trackpad drift could silently start a real drag
      // session. Now it's only switched on for the duration of a press on
      // the number badge (the de facto handle below), same fix as the stack
      // card's grip.
      row.draggable = false;

      const n = document.createElement('span');
      n.className = 'svc-item-num';
      n.textContent = idx + 1;
      n.title = 'Drag to reorder';
      n.addEventListener('mousedown', () => { row.draggable = true; });
      row.addEventListener('mouseup', () => { row.draggable = false; });

      const body = document.createElement('div');
      body.className = 'svc-item-body';
      const count = slidesFor(item).length;

      // The sidebar row is the one place an item gets renamed — double-click
      // the title, same gesture as the playlist switcher. The stack view's
      // accordion card and the Slides tab's library card both show this same
      // title read-only, no rename affordance of their own.
      const title = document.createElement('div');
      title.className = 'svc-item-title';
      title.textContent = item.title || '(untitled)';
      title.title = 'Double-click to rename';
      // No click guard — clicking the title is just clicking the row (opens
      // the item), same as clicking anywhere else in it. This was
      // swallowing the row's own click entirely: a stray leftover from
      // before renaming moved here, protecting a bubble path that
      // sectionCard's title doesn't need to guard against either.
      title.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenamingItemTitle(title, item, () => { renderStack(); renderSidebar(); });
      });

      const sub = document.createElement('div');
      sub.className = 'svc-item-sub';
      sub.textContent = `${typeLabel(item)} · ${count} slide${count === 1 ? '' : 's'}`;

      body.appendChild(title);
      body.appendChild(sub);

      const del = document.createElement('button');
      del.className = 'svc-item-del';
      del.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      del.title = 'Remove';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDeletePopover(del, `Remove "${item.title || '(untitled)'}" from this playlist?`, () => removeItem(item.id));
      });

      row.appendChild(n); row.appendChild(body); row.appendChild(del);
      row.addEventListener('click', (e) => {
        // Cmd/Ctrl+Click toggles this row in/out of the selection (standard
        // multi-select gesture) without opening it — same as Finder/Explorer.
        if (e.metaKey || e.ctrlKey) {
          if (selectedItemIds.has(item.id)) selectedItemIds.delete(item.id);
          else selectedItemIds.add(item.id);
          lastClickedItemId = item.id;
          renderSidebar();
          return;
        }
        // Shift+Click selects the contiguous range from the last click to
        // here, again without opening anything.
        if (e.shiftKey && lastClickedItemId) {
          const ids = service.items.map(i => i.id);
          const a = ids.indexOf(lastClickedItemId), b = ids.indexOf(item.id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            selectedItemIds = new Set(ids.slice(lo, hi + 1));
            renderSidebar();
            return;
          }
        }
        // A plain click always narrows back to one, same as everywhere else
        // multi-select coexists with a normal click in this app.
        selectedItemIds.clear();
        lastClickedItemId = item.id;
        focusInStack(item.id);
      });
      row.addEventListener('contextmenu', (e) => {
        if (e.target.closest('input,button')) return;
        e.preventDefault();
        openItemContextMenu(e.clientX, e.clientY, item, title, row);
      });

      row.addEventListener('dragstart', (e) => {
        if (e.target.closest('input,button,textarea')) { e.preventDefault(); return; }
        dragItemId = item.id;
        row.classList.add('svc-item-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', item.id); } catch {}
      });
      row.addEventListener('dragend', () => {
        dragItemId = null;
        document.querySelectorAll('.svc-item').forEach(r => {
          r.classList.remove('svc-item-dragging', 'svc-drop-before', 'svc-drop-after');
          r.draggable = false;
        });
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

  // Deleting from Default cascades — every linked copy elsewhere (items
  // whose libraryId points at this id) is removed too, since Default is the
  // canonical/permanent record. Deleting from any other playlist only
  // removes the local copy; Default's (and every other playlist's) copy is
  // untouched. removeItem always operates on the currently active playlist
  // (its only two call sites — the sidebar and stack delete buttons — both
  // act on whatever's currently open), so `service.isDefault` alone decides
  // which behavior applies.
  function removeItem(id) {
    if (service.isDefault) {
      playlists.forEach(p => {
        if (p.id === service.id) return;
        p.items = p.items.filter(i => {
          if (i.libraryId !== id) return true;
          expanded.delete(i.id);
          if (liveSlideKey && liveSlideKey.startsWith(i.id + ':')) liveSlideKey = null;
          return false;
        });
      });
    }
    service.items = service.items.filter(i => i.id !== id);
    expanded.delete(id);
    if (activeItemId === id) activeItemId = null;
    if (liveSlideKey && liveSlideKey.startsWith(id + ':')) {
      liveSlideKey = null;
      // A follower tracking the just-deleted item would otherwise keep
      // ingesting transcripts and can still fire sendSlide on a stale item,
      // resurrecting a deleted item back onto the live output unattended.
      if (followItemId === id) stopFollower();
    }
    saveService(); renderSidebar(); renderStack();
  }

  // Shared by cross-playlist drag (see openPlaylistSwitcherPopover) and the
  // "Move to Playlist" context-menu action. Default's contents must always
  // stay complete, so moving OUT of Default copies rather than removing;
  // moving INTO Default isn't a legal destination (Default is populated only
  // by the import pipeline — see archiveImportToDefault); moving between two
  // ordinary playlists is a true move.
  function moveItemToPlaylist(itemId, destPlaylistId) {
    const source = playlists.find(p => p.items.some(i => i.id === itemId));
    const dest = playlists.find(p => p.id === destPlaylistId);
    if (!source || !dest || source.id === dest.id) return false;
    const item = source.items.find(i => i.id === itemId);

    if (source.isDefault) {
      const clone = JSON.parse(JSON.stringify(item));
      clone.id = uid(item.type);
      clone.libraryId = item.id;
      dest.items.push(clone);
    } else if (dest.isDefault) {
      if (typeof toast === 'function') toast("Default collects imports automatically — items can't be moved here.", 'error');
      return false;
    } else {
      source.items.splice(source.items.indexOf(item), 1);
      dest.items.push(item);
    }
    if (source.id === service?.id) {
      if (activeItemId === itemId) activeItemId = null;
      expanded.delete(itemId);
    }
    if (liveSlideKey && liveSlideKey.startsWith(itemId + ':') && !source.isDefault) liveSlideKey = null;
    saveService(); renderSidebar(); renderStack(); renderPlaylistSwitcher();
    return true;
  }

  // ── Views: Bible ⇄ stack ⇄ full-edit ⇄ Slides library ⇄ Songs library ───
  // One dispatcher for every top-level body view so exactly one is ever
  // visible and the top-bar tab buttons stay in sync with it — previously
  // each view function toggled its own `.hidden` classes independently,
  // which is how new views kept getting left showing behind one another.
  const CENTER_VIEWS = {
    bible:      'live-queue-section',
    stack:      'svc-stack-view',
    fullscreen: 'svc-fullscreen',
    timer:      'timer-view',
    songs:      'songs-library-view',
    media:      'media-library-view',
  };
  let currentCenterView = 'bible';
  function showCenterView(view) {
    // The top nav is the one master controller for the whole body — Theme
    // Studio included. Switching to any of these views has to close it out
    // (autosaved already, so there's nothing to lose) rather than leaving it
    // showing underneath.
    window.KairoThemeStudio?.close?.();
    window.KairoItemStyleEditor?.close?.();
    currentCenterView = view;
    Object.entries(CENTER_VIEWS).forEach(([key, id]) => {
      document.getElementById(id)?.classList.toggle('hidden', key !== view);
    });
    // The scripture search bar only makes sense on the Bible view itself.
    // Used to also show on the Slides stack/full-edit (a leftover from
    // before Slides had its own content search) — now that Slides has its
    // own "find a word across all slides" search bar right below this one
    // (a completely different thing: looking up scripture to ADD, vs.
    // finding text already IN the deck), stacking both was confusing
    // rather than useful (owner feedback, live). Adding to a playlist from
    // the Bible tab is unaffected — Send/Add still works the same way it
    // always did; this only controls whether the search INPUT itself
    // shows on views where it was never the point.
    document.querySelector('.cs-lookup')?.classList.toggle('hidden', view !== 'bible');
    document.querySelectorAll('#bible-btn, #slides-btn, #timer-btn, #songs-btn, #media-btn').forEach(b => b?.classList.remove('active'));
    // The stack (running order) and full-edit are both reached by drilling
    // into a playlist's slides — "Slides" is the right tab to show active
    // there, since the Slides nav button itself just re-opens the current
    // playlist's stack (there's no separate library view to land on).
    const btnId = { bible: 'bible-btn', songs: 'songs-btn', media: 'media-btn', timer: 'timer-btn', stack: 'slides-btn', fullscreen: 'slides-btn' }[view];
    if (btnId) document.getElementById(btnId)?.classList.add('active');
    updateMediaBinVisibility();
  }

  // ── Media Bin — ProPresenter-style always-reachable background shelf ───
  // Only meaningful under Bible/Slides/Timer (per the operator's own
  // scoping: "an option in bible, slides, timer") — Songs/Media browsing
  // has no "currently live" thing to set a background on. Independent of
  // the Media *tab*'s own bin/folders browsing (that sends to the separate
  // media output layer); this sets item.slideStyles[i].bgMedia /
  // segment.slideStyles[0].bgMedia / the Bible theme override instead —
  // see applyBgMediaOverride in app.js/service.js/display.html.
  const MEDIA_BIN_VIEWS = new Set(['bible', 'stack', 'fullscreen', 'timer']);
  let mediaBinUserHidden = false;
  try { mediaBinUserHidden = localStorage.getItem('kairo-media-bin-hidden') === '1'; } catch {}
  let mediaBinLoaded = false;

  function updateMediaBinVisibility() {
    const bin = document.getElementById('media-bin');
    if (!bin) return;
    const shouldShow = MEDIA_BIN_VIEWS.has(currentCenterView) && !mediaBinUserHidden;
    bin.classList.toggle('hidden', !shouldShow);
    // Same .active treatment the nav tabs above it already use (red pill) —
    // the toggle button otherwise looked identical whether the bin was
    // actually showing or not, on top of/instead of just Bible/Slides/
    // Timer/Songs/Media each having their own separate .active state.
    document.getElementById('media-bin-toggle-btn')?.classList.toggle('active', shouldShow);
    // Re-fetch every time it's revealed (not just the first time) — the bin
    // is a live shortcut of the Media tab, so a folder added or a watched
    // folder's contents changing while the bin was hidden must show up the
    // moment it's shown again. It's a few small HTTP calls, cheap enough.
    if (shouldShow) { mediaBinLoaded = true; renderMediaBinStrip(); }
  }

  // The Media Bin mirrors the Media tab — so anything that changes the Media
  // tab's contents (a smart folder added/removed, a watched folder's files
  // changing on disk, an upload) must refresh the bin too if it's visible.
  function refreshMediaBinIfVisible() {
    const bin = document.getElementById('media-bin');
    if (bin && !bin.classList.contains('hidden')) renderMediaBinStrip();
  }

  function toggleMediaBin() {
    mediaBinUserHidden = !mediaBinUserHidden;
    try { localStorage.setItem('kairo-media-bin-hidden', mediaBinUserHidden ? '1' : '0'); } catch {}
    updateMediaBinVisibility();
    // Owner: hiding the bin should take its transport bar with it, even if
    // a video happens to still be playing out live — the bar sits right
    // above the bin (see index.html's own comment on why it's a sibling,
    // not nested), so leaving it behind reads as an orphaned control once
    // its bin is gone. If a video really is still playing, the next real
    // onMediaStatus update (timeupdate fires continuously during playback)
    // brings it straight back once the bin — and the bar with it — is shown
    // again, so this only ever hides it, never needs to restore it here.
    if (mediaBinUserHidden) setMediaTransportVisible(false);
  }

  // All bin + smart-folder media in one flat list — same shape app.js's own
  // fetchAllMediaItems uses for its Theme Studio "Library" picker, kept as
  // a separate copy per this file's own fetch helpers/no cross-file import.
  async function fetchAllMediaItemsForBin() {
    const items = [];
    const binP = fetchWithTimeout(`${SERVER}/api/media/bin`).then(r => r.json())
      .then(bin => (bin.items || []).forEach(it => items.push(it)))
      .catch(() => {});
    // Smart folders are fetched in parallel, not one round-trip per folder
    // in sequence — the Media Bin's first paint used to wait on N serial
    // requests for N watched folders.
    const foldersP = fetchWithTimeout(`${SERVER}/api/media/folders`).then(r => r.json())
      .then(foldersRes => Promise.all((foldersRes.folders || []).map(folder =>
        fetchWithTimeout(`${SERVER}/api/media/folders/${folder.id}/items`).then(r => r.json())
          .then(res => (res.items || []).forEach(it => items.push(it)))
          .catch(() => {})
      )))
      .catch(() => {});
    await Promise.all([binP, foldersP]);
    return items;
  }

  // Drag-and-drop mime for a Media Bin card → a slide grid drop. Custom
  // type (not a bare string on 'text/plain') so a drop target can tell
  // "this is a Kairo media pick" apart from an ordinary text/file drag
  // without guessing from content.
  const MEDIA_DRAG_MIME = 'application/x-kairo-media';

  function buildMediaBinCard(item) {
    const card = document.createElement('button');
    card.className = 'media-card';
    // Owner: "add a dropzone highlight for where the user wants to drag
    // from media bin directly to slides grid." The Media Bin strip is the
    // one place Media content is ever visible AT THE SAME TIME as another
    // view (Bible/Slides/Timer) — see this function's own header comment
    // and renderMediaBinStrip's — unlike the full Media tab, which closes
    // whatever editor was open (buildMediaCard's own comment), so this is
    // the only surface a real cross-panel drag is even physically possible
    // from. Video isn't draggable here — a 'slides' block's own shape only
    // ever holds a static image (see slidesFor's 'slides' case), so a
    // dropped video would have nowhere valid to land.
    //
    // draggable is only switched on for the actual duration of a mouse
    // press, never left permanently true — same fix already applied to the
    // sidebar row/stack card's own reorder-drag (see their comments): a
    // permanently-draggable element that's ALSO an ordinary click target
    // (this card sends the item on click) let a hair of mouse/trackpad
    // drift silently start a real native drag session, which a confirmed
    // WebKit/macOS bug turned into the unrelated top bar going stale — even
    // when the drag was never actually completed.
    if (item.kind === 'image') {
      card.draggable = false;
      card.addEventListener('mousedown', () => { card.draggable = true; });
      card.addEventListener('mouseup', () => { card.draggable = false; });
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify({ url: item.url, name: item.name }));
        e.dataTransfer.effectAllowed = 'copy';
      });
      // Belt-and-suspenders: mouseup won't fire if the drag ends outside
      // the window/over a drop target that swallows it — dragend always
      // fires exactly once a drag session concludes, however it ends.
      card.addEventListener('dragend', () => { card.draggable = false; });
    }
    // Same shared thumbnail builder the Media tab's own grid uses
    // (buildMediaThumb, defined further down with buildMediaCard) — was
    // its own separate copy that never autoplayed a video thumbnail at
    // all, which is exactly "frozen, like an image" for a video the same
    // way the Timer layer's own bug was.
    card.appendChild(buildMediaThumb(item));
    if (item.kind === 'video') {
      const badge = document.createElement('span');
      badge.className = 'media-card-badge';
      badge.textContent = 'VIDEO';
      card.appendChild(badge);
    }
    const label = document.createElement('div');
    label.className = 'media-card-label';
    label.textContent = item.name;
    card.appendChild(label);
    card.title = `Send "${item.name}" to the media layer`;
    // Same call the Media tab's own grid uses (buildMediaCard, above) — the
    // Media Bin is just a second, always-reachable place to trigger it from
    // Bible/Slides/Timer, not a different mechanism. An earlier version of
    // this tried to inject the pick as a background layer into the current
    // item/segment/theme instead; that path had real bugs and, more
    // fundamentally, never reached Kairo's fully-automatic live-detection
    // sends at all (they broadcast straight from the server with no look
    // attached) — sendMediaItem's independent media layer has neither
    // problem, since it's a separate compositing layer the slide paints
    // over, not something threaded through the slide/theme's own data.
    card.addEventListener('click', () => sendMediaItem(item));
    // Same Fit Mode menu as the Media tab's own grid (buildMediaCard,
    // above) — was missing here entirely, so there was no way to pick
    // Cover/Stretch from the bin at all, only from the Media tab itself.
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const currentFit = mediaFitPrefs.get(item.url) || 'contain';
      const sections = [[{
        label: 'Fit Mode',
        submenu: [['contain', 'Contain'], ['cover', 'Cover'], ['fill', 'Stretch']].map(([v, label]) => ({
          label, selected: currentFit === v, onClick: () => sendMediaItem(item, v),
        })),
      }]];
      openContextMenu(e.clientX, e.clientY, sections);
    });
    return card;
  }

  async function renderMediaBinStrip() {
    const strip = document.getElementById('media-bin-strip');
    if (!strip) return;
    strip.innerHTML = '<div class="svc-empty">Loading…</div>';
    const items = await fetchAllMediaItemsForBin();
    strip.innerHTML = '';
    if (!items.length) {
      strip.innerHTML = '<div class="svc-empty">No media yet — add some from the Media tab.</div>';
      return;
    }
    items.forEach(item => strip.appendChild(buildMediaBinCard(item)));
  }

  document.getElementById('media-bin-toggle-btn')?.addEventListener('click', toggleMediaBin);
  document.getElementById('media-bin-hide-btn')?.addEventListener('click', toggleMediaBin);

  // Drag-to-resize — deliberately NOT reusing app.js's initVerticalSplitter:
  // that helper resizes a pane that sits ABOVE its splitter (dragging down
  // grows it). Here the splitter is the bin's own top edge and the bin
  // itself sits at the bottom of .center-stage, so it's the opposite
  // relationship — dragging UP (mouse Y decreasing) has to grow it, and the
  // element being resized (.media-bin) IS the splitter's own parent, not a
  // separate sibling pane.
  const MEDIA_BIN_H_KEY = 'kairo-media-bin-h';
  function initMediaBinResize() {
    const bin = document.getElementById('media-bin');
    const splitter = document.getElementById('media-bin-splitter');
    if (!bin || !splitter) return;
    const saved = parseInt(localStorage.getItem(MEDIA_BIN_H_KEY) || '', 10);
    if (saved > 0) bin.style.height = saved + 'px';

    let startY = 0, startH = 0;
    const MIN_H = 90, MAX_H = 400; // matches .media-bin's own min-/max-height in styles.css
    const onMove = (e) => {
      const h = Math.max(MIN_H, Math.min(MAX_H, startH + (startY - e.clientY)));
      bin.style.height = h + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      splitter.classList.remove('dragging');
      document.body.style.userSelect = '';
      try { localStorage.setItem(MEDIA_BIN_H_KEY, String(bin.offsetHeight)); } catch {}
    };
    splitter.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startY = e.clientY;
      startH = bin.offsetHeight;
      splitter.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  initMediaBinResize();

  function openStack() {
    showCenterView('stack');
    renderStack();
  }
  function closeStack() {
    showCenterView('bible');
    activeItemId = null;
    renderSidebar();
  }

  // Sidebar click: open the stack (if not already) and expand + scroll to it.
  // See expandOnly's own comment for why this is single-open rather than
  // additive.
  function focusInStack(id) {
    activeItemId = id;
    expandOnly(id);
    openStack();
    renderSidebar();
    // Confirmed root cause of the top-bar-disappearing bug: element.scrollIntoView()
    // walks up the ancestor chain to find "the" scrollable container, and in
    // WebKit that walk can still reach body/html and shift the whole page
    // even with overflow:hidden set on both — which folds .top-bar (a normal-
    // flow element at the very top of body) up off the top of the viewport.
    // Fixed by scrolling the ONE container we actually mean (#svc-stack-list)
    // directly via scrollTop, with no ancestor walk that could ever touch
    // anything above that container. Always aligns the newly-focused card to
    // the top rather than just nudging it into view — switching to a
    // different item should start fresh, not land wherever renderStack's own
    // scroll-position restore (for the *previous* item) happened to leave it,
    // which read as "jumps to some random spot in the middle" after scrolling
    // deep into a long item and then picking a different one.
    requestAnimationFrame(() => {
      const card = document.querySelector(`.svc-card[data-id="${CSS.escape(id)}"]`);
      const container = document.getElementById('svc-stack-list');
      if (!card || !container) return;
      const cRect = container.getBoundingClientRect();
      const eRect = card.getBoundingClientRect();
      container.scrollTop += (eRect.top - cRect.top);
    });
  }

  function openFullEdit(id) {
    activeItemId = id;
    showCenterView('fullscreen');
    renderFullEdit();
    renderSidebar();
  }
  function closeFullEdit() {
    openStack();
  }

  // ── Stack: one card per section ──────────────────────────────────────────
  function renderStack() {
    const host = document.getElementById('svc-stack-list');
    if (!host) return;
    const outerScroll = host.scrollTop;
    host.innerHTML = '';

    if (!service || !service.items.length) {
      host.innerHTML = '<div class="svc-empty">Nothing in this playlist yet.<br>Use “+ Add content” to plan the service.</div>';
      return;
    }

    service.items.forEach((item, idx) => host.appendChild(sectionCard(item, idx)));
    // Every card (and its .svc-slides-grid) is rebuilt from scratch above, so
    // a freshly-expanded card would otherwise render at the CSS default
    // (Grid, 190px) until the next unrelated Grid/List/slider interaction.
    // Must run BEFORE the scroll restore below: toggling Grid<->List changes
    // each card's height (list mode stacks slides in one column instead of
    // side-by-side), and doing that *after* setting scrollTop let the
    // browser's scroll-anchoring "helpfully" shift the restored position to
    // compensate for the layout change — the exact cause of the stack
    // visibly jumping on every send.
    // applyView() (below) also repaints every tagged thumbnail — see its
    // own comment — now that every card is attached and it has set each
    // grid's real --svc-card width.
    applyView();
    host.scrollTop = outerScroll;
  }

  function sectionCard(item, idx) {
    const isOpen = expanded.has(item.id);
    const card = document.createElement('div');
    card.className = 'svc-card' + (isOpen ? ' open' : '') + (item.id === activeItemId ? ' active' : '');
    card.dataset.id = item.id;
    // Confirmed by isolation test: native HTML5 drag-and-drop was the
    // top-bar-disappearing bug's trigger (see the matching comment on the
    // sidebar row above). draggable is only switched on for the duration of
    // a press on the grip below, not permanently on the whole card.
    card.draggable = false;

    const head = document.createElement('div');
    head.className = 'svc-card-head';

    const grip = document.createElement('span');
    grip.className = 'svc-card-grip';
    grip.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/></svg>`;
    grip.addEventListener('mousedown', () => { card.draggable = true; });
    card.addEventListener('mouseup', () => { card.draggable = false; });

    const chevron = document.createElement('button');
    chevron.className = 'svc-card-chevron';
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    chevron.title = isOpen ? 'Collapse' : 'Expand';
    chevron.addEventListener('click', (e) => {
      // Without this the click bubbles to the head's own toggle handler below,
      // firing twice per click and cancelling itself out — the chevron looked
      // unresponsive when in fact it was toggling and un-toggling in one go.
      e.stopPropagation();
      if (expanded.has(item.id)) expanded.delete(item.id); else expandOnly(item.id);
      renderStack();
    });

    const num = document.createElement('span');
    num.className = 'svc-card-num';
    num.textContent = idx + 1;

    // Read-only here — renaming happens exactly one place: the sidebar row
    // (double-click), not the stack accordion and not the Slides tab card.
    // No click guard either — clicking the title is just clicking the
    // header, same as clicking anywhere else in it (toggles the chevron).
    const title = document.createElement('span');
    title.className = 'svc-card-title';
    title.textContent = item.title || '(untitled)';

    const typeTag = document.createElement('span');
    typeTag.className = 'svc-card-type';
    typeTag.textContent = typeLabel(item);

    head.appendChild(grip);
    head.appendChild(chevron);
    head.appendChild(num);
    head.appendChild(title);
    head.appendChild(typeTag);

    // Lines popover (songs and imported slide decks — anything the delimiter
    // can chunk/un-chunk) and Theme popover — icon buttons, single row.
    if (item.type === 'song' || item.type === 'slides') {
      const linesBtn = document.createElement('button');
      linesBtn.className = 'svc-card-icon-btn';
      linesBtn.title = 'Lines per slide';
      linesBtn.textContent = linesPerSlideValue(item) || 'S';
      linesBtn.addEventListener('click', (e) => { e.stopPropagation(); openLinesPopover(linesBtn, item); });
      head.appendChild(linesBtn);
    }

    // Theme / Full-scale edit / Quick edit / Remove section used to
    // be four separate icon-only buttons crammed into this header. Right-
    // clicking the head already opens openItemContextMenu (below) with
    // Theme/Delete — this labeled "Actions" button is the same menu (now
    // also carrying Full-scale edit/Quick edit), just with a visible,
    // discoverable trigger instead of relying on an undiscoverable
    // right-click for an operator who's never found it.
    const moreBtn = document.createElement('button');
    moreBtn.className = 'svc-card-icon-btn svc-card-actions-btn';
    moreBtn.title = 'More actions';
    moreBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg><span>Actions</span>`;
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openItemContextMenu(e.clientX, e.clientY, item, title, moreBtn);
    });
    head.appendChild(moreBtn);

    head.addEventListener('click', () => {
      activeItemId = item.id;
      if (expanded.has(item.id)) expanded.delete(item.id); else expandOnly(item.id);
      renderStack(); renderSidebar();
    });
    head.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input,button')) return;
      e.preventDefault();
      openItemContextMenu(e.clientX, e.clientY, item, title, head);
    });

    card.appendChild(head);

    if (isOpen) {
      const body = document.createElement('div');
      body.className = 'svc-card-body';
      const slides = slidesFor(item);
      if (!slides.length) {
        body.innerHTML = '<div class="svc-empty-sm">No slides yet — Edit to add content.</div>';
        // Still a valid drop target — an empty announcement deck is the
        // MOST likely case someone's about to build by dragging images in.
        // Wired on the actual .svc-empty-sm child, not `body` itself —
        // that's what the .svc-media-drop-target highlight (styles.css)
        // targets.
        if (item.type === 'slides') wireMediaBinDropTarget(body.firstElementChild, item);
      } else {
        const grid = document.createElement('div');
        grid.className = 'svc-slides-grid';
        slides.forEach((s, i) => grid.appendChild(slideCard(item, s, i)));
        if (item.type === 'slides') wireMediaBinDropTarget(grid, item);
        body.appendChild(grid);
      }
      card.appendChild(body);
    }

    // Reorder by dragging the grip (draggable is only switched on for the
    // duration of a press on it — see the grip's mousedown listener above).
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('input,button,textarea')) { e.preventDefault(); return; }
      dragItemId = item.id;
      card.classList.add('svc-item-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', item.id); } catch {}
    });
    card.addEventListener('dragend', () => {
      dragItemId = null;
      document.querySelectorAll('.svc-card').forEach(c => {
        c.classList.remove('svc-item-dragging', 'svc-drop-before', 'svc-drop-after');
        c.draggable = false;
      });
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

  // Swaps a title label for an inline input, in place — same rename gesture
  // as the playlist switcher's startRenamingSwitcher(), just reusable for any
  // item title (stack accordion cards and sidebar rows both use this).
  function startRenamingItemTitle(titleEl, item, onCommit) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = titleEl.className;
    input.value = item.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      item.title = input.value.trim();
      saveService();
      onCommit();
    };
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); settled = true; onCommit(); }
    });
  }
  // Destructive actions get an explicit confirm step — a stray click on a
  // small "×" shouldn't be able to drop a section with no way back.
  function confirmDeletePopover(anchor, message, onConfirm) {
    openPopover(anchor, (pop) => {
      pop.classList.add('svc-popover-wide');
      const msg = document.createElement('div');
      msg.className = 'svc-popover-hint';
      msg.textContent = message;
      pop.appendChild(msg);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn secondary';
      cancelBtn.style.cssText = 'flex:1;justify-content:center;';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', closePopover);
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'modal-btn primary ts-danger-btn';
      deleteBtn.style.cssText = 'flex:1;justify-content:center;';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => { closePopover(); onConfirm(); });
      row.appendChild(cancelBtn); row.appendChild(deleteBtn);
      pop.appendChild(row);
    });
  }

  function slideCard(item, s, i) {
    const card = document.createElement('button');
    const isLive = liveSlideKey === `${item.id}:${i}`;
    const isMatch = !!slideSearchQuery && (s.text || '').toLowerCase().includes(slideSearchQuery);
    card.className = 'svc-slide' + (isLive ? ' live' : '') + (isSlideSelected(i) ? ' selected' : '') + (isMatch ? ' search-match' : '');
    card.title = 'Send to all outputs';

    const preview = document.createElement('div');
    preview.className = 'svc-slide-preview';
    if (s.image) {
      preview.style.backgroundImage = `url('${s.image}')`;
      preview.classList.add('is-image');
      // Wins over .is-image's hardcoded `background-size: cover` (styles.css)
      // — background-size has no 'fill' keyword, unlike object-fit, so 'fill'
      // needs the explicit 100%/100% translation (same idiom Theme Studio's
      // own layer rendering already uses).
      preview.style.backgroundSize = item.fit === 'fill' ? '100% 100%' : (item.fit || 'contain');
    } else {
      // Same theme-layer renderer the full-edit canvas uses — the thumbnail
      // is just a smaller container, and the layout math is percentage-based
      // so it scales down correctly without any special-casing here... but
      // only once `preview` is actually attached to the document AND
      // applyView() has set its grid's real --svc-card width. Neither is
      // true yet at this exact point (this card hasn't been appended to the
      // live list, and applyView() runs once at the end of renderStack, not
      // per-card) — clientWidth reads 0 on a detached/unstyled element, so
      // paintLookLayers' scale calc always fell back to its hardcoded 640px
      // guess instead of this card's real (often much smaller) width,
      // rendering every thumbnail's text far too large regardless of the
      // size slider. Tag it and let renderStack's final pass (after
      // everything is attached and sized) do the actual paint — deferring
      // via requestAnimationFrame/setTimeout instead would silently stop
      // firing at all while the window is minimized/backgrounded, which is
      // worse than the original bug.
      preview.__pendingPaint = { item, s, i };
    }

    // Overlaid on the thumbnail itself (bottom-left badge), matching
    // Full-scale edit's slide-list convention (.ts-item-slide-label) rather
    // than sitting as its own row below the card. Stashed on __pendingPaint
    // too — paintLookLayers wipes preview.innerHTML when it fires later (see
    // repaintSlidePreviews), which would otherwise erase this label the
    // instant the deferred text paint lands (same bug class already fixed
    // once for Full-scale edit's own slide list).
    const label = document.createElement('div');
    label.className = 'svc-slide-label';
    // Show the real section label (Verse/Chorus/Bridge/etc — from import
    // detection or the operator's own click-to-cycle edit) when this slide
    // has one, instead of always just the bare index. Real gap: this grid
    // is where an operator actually browses a song's slides (matching
    // ProPresenter's own slide-library convention of labeling each slide),
    // but the label was previously only ever surfaced on the LIVE preview
    // badge for whichever slide happens to be on air — nowhere in the
    // browsing view itself. `b.label` falls back to a generic `Slide N`
    // string (see slidesFor) when nothing real was ever set, so exclude
    // that shape and fall back to the plain numeral exactly as before.
    // songBank distinguishes a real song (with genuine Verse/Chorus/Bridge
    // structure) from an imported deck that merely reuses the song type's
    // linesPerSlide chunking machinery internally (see confirmAddConfirm's
    // "Custom lines" import mode) — that import's single block is just
    // labelled with the deck's own title, not a real song section, so it
    // shouldn't get the colored section highlight below (same distinction
    // typeLabel() above already draws for the sidebar's type text).
    const realLabel = item.type === 'song' && item.songBank && s.label && !/^slide\s+\d+$/i.test(s.label) ? s.label : null;
    label.textContent = realLabel || `${i + 1}.`;
    // Owner: "it needs a color shading with a frame around it to make the
    // user see it in first glance" — a plain-text label was easy to miss
    // among the thumbnails. Same color palette as the live-screen operator
    // badge, so Verse/Chorus/Bridge/etc read as a real category, not just
    // more dim text.
    const secCls = realLabel ? sectionTypeClass(realLabel) : null;
    if (secCls) label.classList.add('sec-labeled', secCls);
    preview.appendChild(label);
    if (preview.__pendingPaint) preview.__pendingPaint.label = label;

    card.appendChild(preview);
    if (isLive) {
      const tag = document.createElement('span');
      tag.className = 'svc-live-tag';
      tag.textContent = 'LIVE';
      card.appendChild(tag);
    }
    // Cmd/Ctrl+Click toggle / Shift+Click range-select, same gesture as the
    // sidebar and Quick Edit. A plain click sends the slide as before, after
    // clearing any existing selection in place (no full renderStack rebuild
    // needed just for that).
    card.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        handleSlideRowClick(i, e, renderStack);
        return;
      }
      if (selectedSlideIndices.size) {
        clearSlideSelection();
        document.querySelectorAll('.svc-slide.selected').forEach(c => c.classList.remove('selected'));
      }
      sendSlide(item, i);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sections = [];
      // Edit/Change Theme were only ever reachable for the WHOLE item
      // (openItemContextMenu, the sidebar/stack-head menu) — a slide's own
      // right-click had Duplicate/Copy/Paste/Delete but no way to actually
      // style it or re-theme it without leaving to find that other menu.
      // Edit jumps straight to THIS slide (index i), not always slide 0.
      sections.push([
        { label: 'Edit', onClick: () => window.KairoItemStyleEditor?.open?.(item.id, i) },
        { label: 'Change Theme', onClick: () => openThemePopover(card, item) },
      ]);
      if (s.image) sections.push([{ label: 'Fit Mode', submenu: fitModeMenuItems(item) }]);
      // Real gap: a song's section label (Verse/Chorus/Bridge/etc) was only
      // ever settable via the operator's own live-preview badge — cycling
      // through SECTION_CYCLE one click at a time, and only once THIS exact
      // slide happened to be live. An operator browsing/prepping the song
      // ahead of time (this grid, not yet on air) had no way to set it at
      // all. Direct pick here, same underlying block.label write-through.
      if (item.type === 'song' && s.blockIndex != null) {
        sections.push([{ label: 'Section', submenu: sectionMenuItems(item, s, i) }]);
      }
      const editGroup = [];
      if (canDuplicateSlide(item, s)) {
        editGroup.push({ label: 'Duplicate', onClick: () => duplicateSlide(item, i) });
      }
      const selection = selectedSlideIndices.size ? selectedSlideIndices : new Set([i]);
      if (anySlidesDuplicable(item, selection)) {
        editGroup.push({
          label: selection.size > 1 ? `Copy ${selection.size} slides` : 'Copy',
          onClick: () => copySlides(item, selection),
        });
      }
      if (slideClipboard && item.type === 'slides') {
        editGroup.push({ label: 'Paste', onClick: () => pasteSlides(item, i) });
      }
      if (editGroup.length) sections.push(editGroup);
      sections.push([{ label: 'Delete this slide', danger: true, onClick: () => deleteFlowSlideOrSong(item, i, s) }]);
      openContextMenu(e.clientX, e.clientY, sections);
    });
    return card;
  }

  // ── Popovers ─────────────────────────────────────────────────────────────
  // Tracks the current outside-click closer so closePopover() (called from
  // every menu item's own click handler) can remove it explicitly — without
  // this, picking a menu item left its "click outside" listener behind
  // forever (it only ever unregistered itself on the OUTSIDE-click branch),
  // piling up one stale capture-phase document listener per open/pick cycle.
  let activePopoverClose = null;
  function openPopover(anchor, build) {
    const pop = document.getElementById('svc-popover');
    if (!pop) return;
    if (activePopoverClose) { document.removeEventListener('mousedown', activePopoverClose, true); activePopoverClose = null; }
    pop.innerHTML = '';
    build(pop);
    pop.classList.remove('hidden');
    // Fixed positioning + raw viewport coordinates from getBoundingClientRect()
    // — no offsetParent math. offsetParent-relative positioning (the previous
    // approach) silently broke whenever the popover's nearest positioned
    // ancestor didn't match the assumption baked into that math (e.g. opening
    // from a card inside a scrolling grid), landing the popover pinned near
    // the top of the page instead of under the button that opened it.
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(4, r.left) + 'px';
    pop.style.top  = (r.bottom + 4) + 'px';
    // Clamp so a popover opened near the right/bottom edge doesn't render
    // partially off-screen — measured after content is in place above.
    requestAnimationFrame(() => {
      const pr = pop.getBoundingClientRect();
      if (pr.right > window.innerWidth - 4) {
        pop.style.left = Math.max(4, window.innerWidth - pr.width - 4) + 'px';
      }
      if (pr.bottom > window.innerHeight - 4) {
        // Flip above the anchor only if there's actually room — a tall
        // popover (e.g. theme list + "Translate to" language list stacked)
        // opened from a button near the top of the screen has nowhere near
        // enough space above it either. The previous version always flipped
        // and clamped the result to a 4px floor, which silently pinned the
        // whole popover to the top of the screen, detached from its anchor,
        // instead of actually fitting it anywhere sensible.
        const spaceAbove = r.top - 4;
        const spaceBelow = window.innerHeight - r.bottom - 4;
        if (spaceAbove > spaceBelow && spaceAbove >= pr.height) {
          pop.style.top = (r.top - pr.height - 4) + 'px';
        } else {
          // Doesn't fully fit on either side — clamp fully on-screen and
          // let the popover's own max-height/scroll (see CSS) absorb the
          // rest, rather than flying off to a disconnected position.
          pop.style.top = Math.max(4, window.innerHeight - pr.height - 4) + 'px';
        }
      }
    });
    const close = (e) => {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      closePopover();
    };
    activePopoverClose = close;
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }
  function closePopover() {
    document.getElementById('svc-popover')?.classList.add('hidden');
    if (activePopoverClose) { document.removeEventListener('mousedown', activePopoverClose, true); activePopoverClose = null; }
  }
  // Escape is the standard way to dismiss any context menu/popover — closing
  // only on an outside click (the previous behavior) left keyboard-driven
  // dismissal broken. Ignored while typing in a focused input/contenteditable
  // so it doesn't steal Escape from e.g. an in-place rename or slide-edit
  // field that has its own more specific Escape handling.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    closePopover();
  });

  // ── Right-click context menus ───────────────────────────────────────────
  // Built on openPopover rather than a parallel popover/menu system —
  // #svc-ctxmenu-anchor (index.html) is a permanent, reused, invisible 0×0
  // element that openPopover's anchor.getBoundingClientRect()/.contains()
  // calls need a real DOM element for.
  //
  // `sections` is MenuItem[][] — each inner array renders as one
  // .svc-popover-list, with a divider between groups (same idiom
  // openAddContentPopover already uses). MenuItem: { label, onClick,
  // disabled?, danger?, submenu?: MenuItem[] }. A submenu-bearing row
  // re-renders the SAME popover with that item's own sections (plus a
  // "‹ Back" row) — the same "append/replace within one popover" convention
  // openThemePopover already uses for its Multi-Language language picker,
  // rather than building separate flyout-positioning logic for two submenus.
  function openContextMenu(x, y, sections) {
    const anchor = document.getElementById('svc-ctxmenu-anchor');
    if (!anchor) return;
    anchor.style.left = x + 'px';
    anchor.style.top  = y + 'px';
    openPopover(anchor, (pop) => buildContextMenu(pop, sections, sections));
  }

  function buildContextMenu(pop, sections, topSections) {
    pop.innerHTML = ''; // re-invoked directly (not via openPopover) when a submenu row is clicked — must clear the previous level's content first
    if (sections !== topSections) {
      const back = document.createElement('button');
      back.className = 'svc-popover-item';
      back.textContent = '‹ Back';
      back.addEventListener('click', () => buildContextMenu(pop, topSections, topSections));
      pop.appendChild(back);
      const sep = document.createElement('div');
      sep.className = 'svc-add-menu-sep';
      pop.appendChild(sep);
    }
    sections.forEach((group, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'svc-add-menu-sep';
        pop.appendChild(sep);
      }
      const list = document.createElement('div');
      list.className = 'svc-popover-list';
      group.forEach(mi => {
        const b = document.createElement('button');
        b.className = 'svc-popover-item'
          + (mi.danger ? ' danger' : '')
          + (mi.submenu ? ' has-submenu' : '')
          + (mi.selected ? ' active' : ''); // e.g. Fit Mode's current value — marked, still clickable
        b.textContent = mi.label;
        b.disabled = !!mi.disabled;
        b.addEventListener('click', () => {
          // mi.submenu is a flat MenuItem[] (one group) — buildContextMenu's
          // own `sections` param is MenuItem[][] (groups of items), so it's
          // wrapped here rather than requiring every submenu definition to
          // remember to double-wrap itself.
          if (mi.submenu) { buildContextMenu(pop, [mi.submenu], topSections); return; }
          closePopover();
          mi.onClick?.();
        });
        list.appendChild(b);
      });
      pop.appendChild(list);
    });
  }

  // Whole-item menu — shared by the sidebar row and the stack card head,
  // both of which represent one item (as opposed to the per-slide menu in
  // flowRow/slideCard). `anchorEl` is whichever real element triggered the
  // menu, needed by Change Theme/Delete since they reuse openThemePopover/
  // confirmDeletePopover, which anchor to a real element rather than a
  // coordinate.
  function openItemContextMenu(x, y, item, titleEl, anchorEl) {
    const otherPlaylists = playlists.filter(p => p.id !== activePlaylistId);
    const sections = [
      [
        { label: 'Rename', onClick: () => startRenamingItemTitle(titleEl, item, () => { renderSidebar(); renderStack(); }) },
        { label: 'Duplicate', onClick: () => duplicateItem(item) },
        { label: 'Change Theme', onClick: () => openThemePopover(anchorEl, item) },
        { label: 'Edit', onClick: () => window.KairoItemStyleEditor?.open?.(item.id, 0) },
        { label: 'Quick edit', onClick: () => openFullEdit(item.id) },
        // Auto-advance mode (src/lyrics_follow.js or src/sermon_follow.js)
        // — opt-in per item, unlike a song (which always auto-follows once
        // Start Listening is on): a 'slides' deck is just as often
        // announcements or a photo set that should never react to ambient
        // speech, so this is the explicit "yes, listen for THIS one" — and
        // WHICH way to listen for it, since a prepared announcement (read
        // close to verbatim off the slide) and a sermon outline (talked
        // AROUND, not read) need genuinely different tracking engines.
        ...(item.type === 'slides' ? [{ label: 'Auto-Advance', submenu: followModeMenuItems(item) }] : []),
        // Omitted rather than shown-but-empty when there's nowhere else to
        // move to (e.g. only one playlist exists) — same convention as
        // every Copy/Duplicate/Paste item elsewhere in this menu (see the
        // file header), which reads as a broken button rather than an
        // absent one.
        ...(otherPlaylists.length ? [{
          label: 'Move to Playlist',
          submenu: otherPlaylists.map(p => ({
            label: p.name + (p.isDefault ? ' 📌' : ''),
            onClick: () => moveItemToPlaylist(item.id, p.id),
          })),
        }] : []),
      ],
      [
        { label: 'Delete', danger: true, onClick: () =>
          confirmDeletePopover(anchorEl, `Remove "${item.title || '(untitled)'}" from this playlist?`, () => removeItem(item.id)) },
      ],
    ];
    openContextMenu(x, y, sections);
  }

  function duplicateItem(item) {
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = uid(item.type);
    delete copy.libraryId; // a duplicate is a new, independent thing, not a linked Default copy
    const idx = service.items.findIndex(i => i.id === item.id);
    service.items.splice(idx + 1, 0, copy);
    saveService(); renderSidebar(); renderStack();
  }

  function fitModeMenuItems(item) {
    const current = item.fit || 'contain';
    return [['contain', 'Contain'], ['cover', 'Cover'], ['fill', 'Stretch']].map(([v, label]) => ({
      label, selected: current === v,
      onClick: () => { item.fit = v; saveService(); renderStack(); if (activeItemId === item.id) renderFullEdit(); },
    }));
  }

  // Direct pick, mirroring cycleSectionLabel's own normalize-and-compare
  // logic (so a manually-imported "Chorus:" label and a menu-picked
  // "Chorus" are recognized as the same value, not treated as distinct).
  function sectionMenuItems(item, s, i) {
    const block = item.blocks[s.blockIndex];
    if (!block) return [];
    const current = String(block.label || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const items = SECTION_CYCLE.map(lbl => ({
      label: lbl,
      selected: current === lbl.toLowerCase().replace(/[^a-z]/g, ''),
      onClick: () => {
        block.label = lbl;
        saveService();
        renderStack();
        // Refresh the on-air badge too if this exact slide is currently live
        // — otherwise the operator's live output would show a stale label
        // until the next send.
        if (liveSlideKey === `${item.id}:${i}`) sendSlide(item, i);
      },
    }));
    items.push({
      label: 'None', selected: !current,
      onClick: () => { block.label = ''; saveService(); renderStack(); },
    });
    return items;
  }

  function followModeMenuItems(item) {
    const setMode = (mode) => {
      // 'off' is a real, explicit value now — distinct from unset, which
      // defaults to 'script' automatically (see followModeOf). Storing null
      // here would just mean "never touched" again and silently re-enable
      // the default the operator just tried to turn off.
      item.followMode = mode;
      saveService();
      // Live right now with Start Listening already on: start/stop
      // immediately instead of waiting for the next send to notice.
      if (liveSlideKey && liveSlideKey.split(':')[0] === item.id && autoFollow) {
        const idx = Number(liveSlideKey.split(':')[1]);
        if (mode === 'off') stopFollower(); else startFollower(item, idx);
      }
    };
    const current = followModeOf(item);
    return [
      {
        label: 'Off', selected: !current,
        onClick: () => setMode('off'),
      },
      {
        label: 'Announcement (exact wording)', selected: current === 'script',
        onClick: () => setMode('script'),
      },
      {
        label: 'Sermon outline (paraphrase-tolerant)', selected: current === 'sermon',
        onClick: () => setMode('sermon'),
      },
    ];
  }

  function openLinesPopover(anchor, item) {
    openPopover(anchor, (pop) => {
      const label = document.createElement('div');
      label.className = 'svc-popover-label';
      label.textContent = 'Lines per slide';
      pop.appendChild(label);
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.className = 'svc-delim-input';
      input.value = linesPerSlideValue(item);
      const hint = document.createElement('div');
      hint.className = 'svc-popover-hint';
      hint.textContent = '0 = keep each slide/stanza as-is';
      input.addEventListener('change', () => {
        const requested = Math.max(0, Math.floor(Number(input.value)) || 0);
        const applied = setLinesPerSlide(item, requested);
        input.value = linesPerSlideValue(item);
        if (!applied) {
          hint.textContent = "Can't group image slides into a song";
          return;
        }
        hint.textContent = '0 = keep each slide/stanza as-is';
        refreshAfterSlideEdit(item);
      });
      pop.appendChild(input);
      pop.appendChild(hint);
      requestAnimationFrame(() => input.focus());
    });
  }

  // Content-level add menu — reached from the stack view's "+ Add content",
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
          // Songs come from the Song Library now (bundled hymns + the
          // operator's own persistent collection, searchable/foldered) —
          // not a blank verse typed from scratch each time.
          if (kind === 'song') showSongsLibrary();
          else if (kind === 'image') document.getElementById('svc-image-file')?.click();
          else if (MAKERS[kind]) openAddConfirm(MAKERS[kind](), { showDelimiter: false });
        });
        return b;
      };

      const list = document.createElement('div');
      list.className = 'svc-popover-list';
      [['song', 'Song…'], ['slides', 'Slides'], ['scripture', 'Scripture'], ['image', 'Image…']]
        .forEach(([k, t]) => list.appendChild(row(k, t)));
      pop.appendChild(list);

      const sep = document.createElement('div');
      sep.className = 'svc-add-menu-sep';
      pop.appendChild(sep);

      const list2 = document.createElement('div');
      list2.className = 'svc-popover-list';
      buildImportRows(list2, 'playlist');
      pop.appendChild(list2);
    });
  }

  // Shared "Import file…" / "Paste from clipboard" menu rows — the two
  // quick-import entry points every add-content menu offers alongside its
  // own type-specific options. Used by both openAddContentPopover (Slides,
  // destination:'playlist') and openSongImportPopover (Songs tab's own
  // "+ Import Song", destination:'library') so the two stay wired
  // identically rather than drifting into separate implementations — see
  // this file's "Import (file / clipboard / paste-textarea fallback)"
  // section below for the destination-aware functions these call into.
  function buildImportRows(list, destination) {
    const fileRow = document.createElement('button');
    fileRow.className = 'svc-popover-item';
    fileRow.textContent = 'Import file…';
    fileRow.addEventListener('click', () => {
      closePopover();
      const input = document.getElementById('quick-import-file');
      if (input) { input.dataset.destination = destination; input.click(); }
    });
    list.appendChild(fileRow);

    const clipRow = document.createElement('button');
    clipRow.className = 'svc-popover-item';
    clipRow.textContent = 'Paste from clipboard';
    clipRow.addEventListener('click', () => {
      closePopover();
      quickImportClipboard(destination);
    });
    list.appendChild(clipRow);
  }

  // Songs tab's own import entry point — the Song-Library equivalent of
  // Slides' "+ Add content" import rows (openAddContentPopover above),
  // scoped down to just the two quick-import options since a library entry
  // has no "blank slides/scripture" maker the way a playlist section does.
  function openSongImportPopover(anchor) {
    openPopover(anchor, (pop) => {
      const list = document.createElement('div');
      list.className = 'svc-popover-list';
      buildImportRows(list, 'library');
      pop.appendChild(list);
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
      dflt.addEventListener('click', () => {
        item.themeId = null; saveService(); renderStack(); renderFullEditHeader();
        window.KairoItemStyleEditor?.refreshTheme?.(item.id);
        closePopover();
      });
      list.appendChild(dflt);

      const all = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
      // Same clustering as Theme Studio's own list (Bible/Lyrics/Slides,
      // plus any imported .protheme bundle) — this used to list every theme
      // as unrelated flat rows with no preview, which read as a completely
      // different (and unhelpfully longer) picker than the one in Theme
      // Studio for the exact same set of themes.
      const renderedGroups = new Set();
      const buildRow = (l) => {
        const b = document.createElement('button');
        b.className = 'svc-popover-item has-thumb' + (item.themeId === l.id ? ' active' : '');
        const thumb = document.createElement('div');
        thumb.className = 'ts-theme-thumb';
        renderLookThumbnail(thumb, l);
        const label = document.createElement('span');
        label.textContent = l.name;
        b.appendChild(thumb);
        b.appendChild(label);
        b.addEventListener('click', () => {
          item.themeId = l.id; saveService(); renderStack();
          if (activeItemId === item.id) renderFullEdit();
          window.KairoItemStyleEditor?.refreshTheme?.(item.id);
          // Any theme with a verse_translated layer (not just the one
          // built-in preset whose id literally is 'multi-language' — a
          // custom theme, or "Lyrics — Bilingual", needs this exactly as
          // much) needs a target language before it's actually showing
          // anything on the right panel — keep the popover open and show
          // the picker instead of closing on a half-finished choice.
          if (themeNeedsTranslation(l)) {
            // renderStack() just destroyed and rebuilt every card, so the
            // original `anchor` (that card's theme button) is now a detached
            // node — getBoundingClientRect() on it returns an all-zero rect,
            // which pinned the reopened popover to the top-left corner
            // instead of back under the button. Re-find the fresh one.
            const freshAnchor = document.querySelector(`.svc-card[data-id="${CSS.escape(item.id)}"] .svc-card-actions-btn`);
            openThemePopover(freshAnchor && freshAnchor.isConnected ? freshAnchor : anchor, item);
          } else closePopover();
        });
        return b;
      };
      all.forEach(l => {
        if (l.groupId) {
          if (renderedGroups.has(l.groupId)) return;
          renderedGroups.add(l.groupId);
          const groupLabel = document.createElement('div');
          groupLabel.className = 'svc-popover-group-label';
          groupLabel.textContent = l.groupName || 'Theme';
          list.appendChild(groupLabel);
          all.filter(g => g.groupId === l.groupId).forEach(g => list.appendChild(buildRow(g)));
          return;
        }
        list.appendChild(buildRow(l));
      });
      pop.appendChild(list);

      // Use themeForItem (not a raw id lookup against `all`) so this also
      // shows for an item left on "Output default" when that default
      // itself happens to need a translation — matching how sendSlide/
      // getTranslatedText resolve the theme for real, not just an explicit
      // per-item override.
      if (themeNeedsTranslation(themeForItem(item))) {
        const langLabel = document.createElement('div');
        langLabel.className = 'svc-popover-label';
        langLabel.style.marginTop = '8px';
        langLabel.textContent = 'Translate to';
        pop.appendChild(langLabel);
        const langList = document.createElement('div');
        langList.className = 'svc-popover-list';
        // Point-of-use upsell slot: only occupied (and only holds the
        // popover open past the pick) when the chosen language isn't
        // installed yet — an installed pick still closes immediately,
        // matching the pre-existing one-click behavior.
        const upsellSlot = document.createElement('div');
        upsellSlot.style.marginTop = '8px';
        const showUpsell = (code) => {
          if (installedMtLangs && installedMtLangs.has(code)) { upsellSlot.innerHTML = ''; return; }
          if (typeof renderInlineTranslateUpsell === 'function') renderInlineTranslateUpsell(upsellSlot, code);
        };
        TRANSLATE_LANGUAGES.forEach(({ code, name }) => {
          const b = document.createElement('button');
          b.className = 'svc-popover-item' + (item.translateTo === code ? ' active' : '');
          b.textContent = name;
          b.addEventListener('click', () => {
            item.translateTo = code; saveService(); renderStack();
            if (activeItemId === item.id) renderFullEdit();
            langList.querySelectorAll('.svc-popover-item').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            if (installedMtLangs && installedMtLangs.has(code)) closePopover();
            else showUpsell(code);
          });
          langList.appendChild(b);
        });
        pop.appendChild(langList);
        pop.appendChild(upsellSlot);
        if (item.translateTo) showUpsell(item.translateTo);
      }
    });
  }

  // ── Bible tab theme picker ──────────────────────────────────────────────
  // Auto-detected and manually-searched scripture carry no per-item theme —
  // they've always rendered with whichever theme is assigned to the primary
  // output in Settings (outputThemeMap/applyOutputThemes, defined in app.js).
  // This just surfaces that same assignment as a one-click shortcut right
  // next to the search bar, instead of it only being reachable from Settings.
  function openBibleThemePopover(anchor) {
    openPopover(anchor, (pop) => {
      const label = document.createElement('div');
      label.className = 'svc-popover-label';
      label.textContent = 'Theme for auto-detect & search';
      pop.appendChild(label);

      const all = (typeof looks !== 'undefined' && Array.isArray(looks)) ? looks : [];
      const primaryKey = (typeof PRIMARY_DISPLAY !== 'undefined') ? PRIMARY_DISPLAY : 'display-1';
      const map = (typeof outputThemeMap === 'function') ? outputThemeMap() : {};
      const current = map[primaryKey];

      const list = document.createElement('div');
      list.className = 'svc-popover-list';
      // Same clustering + thumbnails as the per-item theme popover above —
      // see its own comment for why.
      const renderedGroups = new Set();
      const buildRow = (l) => {
        const b = document.createElement('button');
        b.className = 'svc-popover-item has-thumb' + (l.id === current ? ' active' : '');
        const thumb = document.createElement('div');
        thumb.className = 'ts-theme-thumb';
        renderLookThumbnail(thumb, l);
        const lbl = document.createElement('span');
        lbl.textContent = l.name;
        b.appendChild(thumb);
        b.appendChild(lbl);
        b.addEventListener('click', () => {
          if (typeof settings !== 'undefined' && typeof outputThemeMap === 'function') {
            settings.outputThemes = { ...outputThemeMap(), [primaryKey]: l.id };
            if (typeof saveSettingsPatch === 'function') saveSettingsPatch({ outputThemes: settings.outputThemes });
            if (typeof applyOutputThemes === 'function') applyOutputThemes();
          }
          // Multi-Language needs a target language before the right panel
          // shows anything — keep the popover open and show the picker
          // instead of closing on a half-finished choice (same pattern as
          // the per-item theme popover above).
          if (l.id === 'multi-language') openBibleThemePopover(anchor);
          else closePopover();
        });
        return b;
      };
      all.forEach(l => {
        if (l.groupId) {
          if (renderedGroups.has(l.groupId)) return;
          renderedGroups.add(l.groupId);
          const groupLabel = document.createElement('div');
          groupLabel.className = 'svc-popover-group-label';
          groupLabel.textContent = l.groupName || 'Theme';
          list.appendChild(groupLabel);
          all.filter(g => g.groupId === l.groupId).forEach(g => list.appendChild(buildRow(g)));
          return;
        }
        list.appendChild(buildRow(l));
      });
      pop.appendChild(list);

      if (current === 'multi-language') {
        const langLabel = document.createElement('div');
        langLabel.className = 'svc-popover-label';
        langLabel.style.marginTop = '8px';
        langLabel.textContent = 'Translate to';
        pop.appendChild(langLabel);
        const langList = document.createElement('div');
        langList.className = 'svc-popover-list';
        const upsellSlot = document.createElement('div');
        upsellSlot.style.marginTop = '8px';
        const showUpsell = (code) => {
          if (installedMtLangs && installedMtLangs.has(code)) { upsellSlot.innerHTML = ''; return; }
          if (typeof renderInlineTranslateUpsell === 'function') renderInlineTranslateUpsell(upsellSlot, code);
        };
        TRANSLATE_LANGUAGES.forEach(({ code, name }) => {
          const b = document.createElement('button');
          b.className = 'svc-popover-item' + ((typeof settings !== 'undefined' && settings.bibleTranslateTo === code) ? ' active' : '');
          b.textContent = name;
          b.addEventListener('click', () => {
            if (typeof settings !== 'undefined') {
              settings.bibleTranslateTo = code;
              if (typeof saveSettingsPatch === 'function') saveSettingsPatch({ bibleTranslateTo: code });
            }
            langList.querySelectorAll('.svc-popover-item').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            if (installedMtLangs && installedMtLangs.has(code)) closePopover();
            else showUpsell(code);
          });
          langList.appendChild(b);
        });
        pop.appendChild(langList);
        pop.appendChild(upsellSlot);
        if (typeof settings !== 'undefined' && settings.bibleTranslateTo) showUpsell(settings.bibleTranslateTo);
      }
    });
  }

  // ── Quick edit ────────────────────────────────────────────────────────────
  // Flow is the one quick-text editing surface for every item type — a text
  // field per slide, stacked and editable at once. Layout/position styling
  // lives in Full-scale edit (the Theme-Studio-style canvas) instead — see
  // the header's "Full-scale edit" button, wired in renderFullEditHeader.
  function renderFullEdit() {
    const item = activeItem();
    if (!item) return;
    renderFullEditHeader();
    renderFlowView(item);
  }

  function renderFullEditHeader() {
    const item = activeItem();
    const titleInp = document.getElementById('svc-fs-title');
    const delim = document.getElementById('svc-delim-group');
    if (titleInp) titleInp.value = item?.title || '';
    if (delim) delim.style.display = item && (item.type === 'song' || item.type === 'slides') ? '' : 'none';
    syncFullEditDelim();
  }
  function syncFullEditDelim() {
    const item = activeItem();
    if (!item) return;
    const input = document.getElementById('svc-delim-input');
    if (input && document.activeElement !== input) {
      input.value = linesPerSlideValue(item);
    }
  }

  // Paint a look's layers into `host` (must be position:relative and sized).
  // Percentages keep this resolution-independent — the exact same math works
  // for the full-size editing canvas, a small grid thumbnail, or the top-bar
  // live preview, just by rendering into containers of different pixel size.
  // `style` is a per-layer-id override map (item.slideStyles[slideIndex]) —
  // any text layer (verse, reference, translated line) can have its own
  // pos/font/align/color/opacity/shadow/outline/visibility overridden for
  // this specific slide, independent of the theme it otherwise inherits.
  // `opts.onCommit`/`opts.onSplit` wire the verse-text layer up for in-place
  // editing (full-edit canvas only) — omit both to get a read-only render,
  // which is what thumbnails and previews want.
  // isVideoLayerSrc, applyShapeGeometry, applyLayerOrder — see
  // src/layer_geometry.js for the shared implementation (loaded via
  // index.html before this script; resolved here via normal scope lookup
  // out of this file's enclosing IIFE, same as hexToRgb/hexA already are).
  // Was a byte-identical copy-paste across this file, app.js, and
  // display.html — already silently drifted (this copy of
  // applyShapeGeometry had dropped app.js's .toFixed(1) rounding).

  function paintLookLayers(host, look, style, content, opts = {}) {
    host.classList.remove('is-alpha');
    host.innerHTML = '';
    const scale = (host.clientWidth || 640) / DESIGN_W;

    // Item/slide-specific layers (added in Full-scale edit, see
    // src/app.js's writeItemSlideStyleFromSynthetic) ride along inside the
    // same per-slide style object rather than a parallel field — appended
    // last so they paint on top, same as every other "new layer" convention.
    let layers = [...(look?.layers || []), ...((style || {}).__customLayers || [])];
    if ((style || {}).__layerOrder) layers = applyLayerOrder(layers, style.__layerOrder);
    // Media Bin "set as background" (see app.js's matching
    // applyBgMediaOverride) — same field, same synthetic-layer shape, so
    // this preview mirror agrees with the real output and the editor
    // canvas instead of just showing the theme's own flat fill.
    if (style?.bgMedia?.src) {
      layers = [
        { id: '__bg-media', type: 'image', name: 'Background (Media Bin)', visible: true,
          src: style.bgMedia.src, fit: 'cover', opacity: 100, radius: 0,
          pos: { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H } },
        ...layers.filter(l => l.type !== 'background'),
      ];
    }
    // Only themes that actually pair a reference/translation caption with a
    // verse layer get the "no caption without a verse line" guard below — a
    // theme deliberately built with ONLY a reference/citation layer (no verse
    // layer at all) has nothing else to show, so its reference must still
    // paint even when verseText is empty.
    const hasVerseLayer = layers.some(l => l.type === 'text' && l.binding === 'verse' && l.visible !== false);
    layers.forEach(layer => {
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
        applyShapeGeometry(d, layer, scale);
        host.appendChild(d);
        return;
      }
      if (layer.type === 'image') {
        const p = layer.pos || { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H };
        const fit = layer.fit === 'fill' ? 'fill' : (layer.fit || 'contain');
        // An "image" layer whose src is actually a video (Theme Studio's
        // file picker doesn't hard-block it, drag-and-drop never respected
        // accept="image/*") can't play at all through background-image —
        // same fix as display.html's buildLayerDOM, so the monitoring
        // preview agrees with what the real output now does instead of
        // showing a permanently frozen frame.
        if (layer.src && isVideoLayerSrc(layer.src)) {
          const v = document.createElement('video');
          v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
          v.style.cssText = 'position:absolute;background:transparent;';
          v.style.objectFit = fit;
          v.style.left = (p.x / DESIGN_W * 100) + '%';
          v.style.top = (p.y / DESIGN_H * 100) + '%';
          v.style.width = (p.w / DESIGN_W * 100) + '%';
          v.style.height = (p.h / DESIGN_H * 100) + '%';
          if (layer.rotation) v.style.transform = `rotate(${layer.rotation}deg)`;
          v.src = layer.src;
          host.appendChild(v);
          v.play().catch(() => {});
          return;
        }
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;background-position:center;background-repeat:no-repeat;';
        // Theme Studio's layer.fit is already fully wired everywhere else
        // (app.js's canvas render, display.html's real output) — this was
        // the one renderer left hardcoded to 'contain', so a Cover/Stretch
        // layer looked right on the real output but wrong in every sidebar/
        // stack live-look preview that goes through paintLookLayers.
        d.style.backgroundSize = fit === 'fill' ? '100% 100%' : fit;
        d.style.left = (p.x / DESIGN_W * 100) + '%';
        d.style.top = (p.y / DESIGN_H * 100) + '%';
        d.style.width = (p.w / DESIGN_W * 100) + '%';
        d.style.height = (p.h / DESIGN_H * 100) + '%';
        // Matches app.js's canvas render and display.html's real output —
        // this renderer (thumbnails, Live Preview) was the one place a
        // rotated image layer never rotated at all.
        if (layer.rotation) d.style.transform = `rotate(${layer.rotation}deg)`;
        // Ken Burns (layer.motion) is a continuous 1.0x→1.12x drift on the
        // real output — this thumbnail is a static snapshot with no per-
        // tick refresh, so it can't replay that, but pinning it to the
        // animation's exact starting frame (scale 1, its LEAST zoomed
        // point) meant the live output almost always looked more zoomed in
        // than the thumbnail promised, since most of the time it's
        // somewhere past that starting point. A fixed mid-drift scale
        // approximates what a glance at the real output usually looks like
        // instead of its one least-zoomed instant.
        if (layer.motion === 'kenburns') {
          d.style.transform = (layer.rotation ? `rotate(${layer.rotation}deg) ` : '') + 'scale(1.06)';
          d.style.transformOrigin = 'center';
        }
        if (layer.src) d.style.backgroundImage = `url('${layer.src}')`;
        host.appendChild(d);
        return;
      }
      if (layer.type === 'image-cycle') {
        // Same "always frame 0" rule as app.js's canvas — this preview
        // mirror doesn't get a live per-second countdown tick at all, only
        // the real output (display.html's handleActionBadge) does.
        const sources = layer.sources || [];
        if (!sources.length) return;
        const p = layer.pos || { x: 0, y: 0, w: DESIGN_W, h: DESIGN_H };
        const fit = layer.fit === 'fill' ? 'fill' : (layer.fit || 'cover');
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;background-position:center;background-repeat:no-repeat;';
        d.style.backgroundSize = fit === 'fill' ? '100% 100%' : fit;
        d.style.left = (p.x / DESIGN_W * 100) + '%';
        d.style.top = (p.y / DESIGN_H * 100) + '%';
        d.style.width = (p.w / DESIGN_W * 100) + '%';
        d.style.height = (p.h / DESIGN_H * 100) + '%';
        if (layer.rotation) d.style.transform = `rotate(${layer.rotation}deg)`;
        d.style.backgroundImage = `url('${sources[0]}')`;
        host.appendChild(d);
        return;
      }
      if (layer.type !== 'text') return;

      const isVerse = layer.binding === 'verse';
      const isTranslated = layer.binding === 'verse_translated';
      const isReference = layer.binding === 'reference';
      const isTimer = layer.binding === 'timer';
      // Individual hour/minute/second parts (see display.html's timeParts)
      // — a static "00" placeholder here same as isTimer's own content
      // pick below; this preview mirror never ticks live either way.
      const isTimerPart = layer.binding === 'timer-h' || layer.binding === 'timer-m' || layer.binding === 'timer-s';
      // A reference/translation caption with no verse line to caption reads
      // as orphaned floating text (e.g. just a song title on an otherwise
      // empty canvas) rather than theme-controlled output — withhold it
      // everywhere this painter runs, same rule display.html's buildLayerDOM
      // applies for the real output.
      if (hasVerseLayer && (isReference || isTranslated) && !String(content.verseText || '').trim()) return;
      // Thumbnails (the accordion's slide-preview grid) skip the reference/
      // title caption — at that size it just overlaps the verse text rather
      // than reading as a separate line, and the verse text is the whole
      // point of the preview anyway.
      if (opts.hideReference && isReference) return;

      // Per-slide override for THIS specific layer (keyed by the theme's own
      // stable layer id) — lets an operator reposition/restyle/hide any text
      // layer (verse, reference, or translated line) for one slide of one
      // item, without touching the theme itself. `visible: false` hides the
      // layer entirely for this slide only.
      const ov = (style || {})[layer.id] || {};
      if (ov.visible === false) return;

      const d = document.createElement('div');
      d.className = 'svc-canvas-text' + (isVerse ? ' is-verse' : '');
      // Tag the binding so the live countdown can find this element after
      // paint — app.js's onTimerAction writes each tick into
      // [data-binding="timer"], mirroring display.html's real output.
      if (layer.binding) d.dataset.binding = layer.binding;
      const p = layer.pos || { x: 100, y: 400, w: DESIGN_W - 200, h: 0 };
      const box = ov.pos || p;
      d.style.position = 'absolute';
      d.style.display = 'flex';
      d.style.flexDirection = 'column';
      d.style.justifyContent = 'center';
      d.style.left = (box.x / DESIGN_W * 100) + '%';
      d.style.top = (box.y / DESIGN_H * 100) + '%';
      d.style.width = (box.w / DESIGN_W * 100) + '%';
      // Entrance (layer.entrance, renderTextProps' Effects tab) — this
      // painter always positions via plain left/top (no layout-preset
      // centering transform to conflict with, unlike app.js's canvas), so
      // it's safe to apply unconditionally.
      if (layer.entrance === 'fade-up') d.style.animation = 'kairo-text-in 700ms ease-out both';
      if (box.h > 0) d.style.height = (box.h / DESIGN_H * 100) + '%';
      // A thumbnail/card preview has no handles or editing affordance to
      // show "this text doesn't fit its box" the way the real canvas can —
      // it should just always stay a clean, contained thumbnail regardless
      // of what the underlying layer's own sizing is doing, unconditionally,
      // not only once some overflow heuristic trips.
      d.style.overflow = 'hidden';

      const size = ov.font?.size ?? layer.font.size;
      d.style.fontFamily = `'${ov.font?.family || layer.font.family}', system-ui, sans-serif`;
      d.style.fontSize = (size * scale).toFixed(1) + 'px';
      d.style.fontWeight = ov.font?.weight ?? layer.font.weight;
      d.style.fontStyle = (ov.font?.italic ?? layer.font.italic) ? 'italic' : 'normal';
      d.style.lineHeight = ov.font?.lineHeight ?? layer.font.lineHeight;
      d.style.letterSpacing = ((ov.font?.letterSpacing ?? layer.font.letterSpacing) * scale).toFixed(2) + 'px';
      d.style.textTransform = ov.font?.transform || layer.font.transform;
      d.style.textAlign = ov.align || layer.align;
      const color = ov.color || layer.color;
      const opacity = ov.opacity ?? layer.opacity;
      d.style.color = hexA(color, opacity);
      if (isTimer || isTimerPart) {
        // Timer state colours (see display.html buildLayerDOM) — onTimerAction
        // recolours the element as the countdown enters warning / overtime.
        d.dataset.baseColor = hexA(color, opacity);
        d.dataset.warnColor = ov.warnColor || layer.warnColor || '#e8a64a';
        d.dataset.overtimeColor = ov.overtimeColor || layer.overtimeColor || '#e8404a';
      }
      // Outline folded into this SAME text-shadow (a ring of sharp offset
      // shadows via outlineShadows — see layer_geometry.js) rather than
      // -webkit-text-stroke, which this WebKit build corrupts on bold/
      // large text — see that helper's own comment.
      const shadow = ov.shadow || layer.shadow;
      const outline = ov.outline || layer.outline;
      const shadowParts = [];
      if (outline?.enabled) shadowParts.push(...outlineShadows(outline.width * scale, outline.color));
      if (shadow?.enabled) shadowParts.push(`${shadow.x * scale}px ${shadow.y * scale}px ${shadow.blur * scale}px ${hexA(shadow.color, shadow.opacity)}`);
      if (shadowParts.length) d.style.textShadow = shadowParts.join(', ');
      // Lyrics — Motion's per-word/per-character reveal only applies to the
      // verse text, and only when this painter isn't also being used as a
      // live contentEditable field (Full-scale edit's in-place editing) —
      // typing into individual word/character spans would fight normal
      // caret/selection behavior, so that case stays plain text regardless
      // of animation.
      const editable = isVerse && !!opts.onCommit;
      if (isVerse && !editable && window.KairoWordSplit?.applyMotionText(d, look?.textAnimation, content.verseText, look?.textAnimationSpeed || 1, { color: look?.textHighlightColor, intensity: look?.textAnimationIntensity })) {
        // handled
      } else {
        const hasTimerTemplate = layer.binding === 'custom' && typeof layer.customText === 'string' && layer.customText.includes('{timer}');
        d.textContent = isVerse ? content.verseText
          : isTranslated ? (content.translatedText || '')
          : isReference ? (content.referenceText || '')
          : isTimer ? (content.timerText || '')
          : isTimerPart ? '00'
          : hasTimerTemplate ? layer.customText.replace('{timer}', content.timerText || '0:00')
          : (layer.customText || '');
        if (hasTimerTemplate) d.dataset.timerTemplate = layer.customText;
      }

      if (isVerse && opts.onCommit) {
        d.contentEditable = 'true';
        d.spellcheck = false;
        d.addEventListener('blur', () => opts.onCommit(d.innerText));
        d.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); d.blur(); return; }
          // Plain Enter = new line, same slide (default contentEditable
          // behaviour). Shift+Enter = break into a new slide at the caret —
          // right-click gives the same action for anyone who reaches for a
          // mouse instead.
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            opts.onSplit?.(d);
          }
        });
        d.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          opts.onSplit?.(d);
        });
        d.addEventListener('mousedown', (e) => e.stopPropagation());
      }
      host.appendChild(d);
    });
  }

  // Small live preview of a look's layers, shared by every theme picker in
  // the app (Theme Studio's own list in app.js, and the Slides/Bible theme
  // popovers below) so they all show the same thumbnail for the same theme
  // rather than app.js and service.js drifting into two implementations.
  // Reuses paintLookLayers unchanged — laying the real content out at full
  // 1920x1080 in an absolutely-positioned inner div, then shrinking the
  // whole thing with a CSS transform, means every shadow/radius/letter-
  // spacing px value computes correctly at full scale before being
  // uniformly scaled down, same as it would look rendered at full size and
  // then visually shrunk. Also flags a genuinely-transparent canvas (the
  // 'is-alpha' class paintLookLayers itself sets) with a checkerboard
  // background instead of leaving it a flat, indistinguishable black box.
  const THUMB_W = 56;
  function renderLookThumbnail(container, look) {
    container.innerHTML = '';
    const inner = document.createElement('div');
    const scale = THUMB_W / DESIGN_W;
    inner.style.cssText = `position:absolute;top:0;left:0;width:${DESIGN_W}px;height:${DESIGN_H}px;transform:scale(${scale});transform-origin:top left;`;
    container.appendChild(inner);
    paintLookLayers(inner, look, {}, { verseText: 'Sample text', referenceText: 'Reference', translatedText: '' });
    container.classList.toggle('is-transparent-thumb', inner.classList.contains('is-alpha'));
  }

  // Write a flow row's edited text back into whatever storage that slide
  // actually came from — the same slide can be a whole block (slides items),
  // a spliced line-range within a block (song items, via lineStart/lineEnd),
  // or the item's own text field (scripture, always exactly one slide).
  function commitSlideText(item, index, slide, text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim());
    if (item.type === 'song' && slide.blockIndex != null) {
      const b = item.blocks[slide.blockIndex];
      if (!b) return;
      b.lines.splice(slide.lineStart, slide.lineEnd - slide.lineStart, ...lines);
      shiftBreaks(b, slide.lineStart, lines.length - (slide.lineEnd - slide.lineStart));
    } else if (item.type === 'slides') {
      const b = item.blocks[index];
      if (b) b.text = lines.join('\n');
    } else if (item.type === 'scripture') {
      item.text = lines.join('\n');
    }
    saveService();
    renderSidebar(); renderFlowView(item);
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
  // — a 'slides' item splits via splitFlowSlideAtCaret instead (each block
  // there already *is* one slide, no chunkable line array to split within).
  // Split into two — the caret-taking `...At` variant lets a right-click
  // context menu capture the caret position synchronously (while the
  // contenteditable's selection is still live) and act on it later from a
  // detached menu button click, after the field may have already blurred.
  function splitSlideAtCaret(item, slide, el) {
    return splitSlideAtCaretAt(item, slide, el, caretLineIndex(el));
  }
  function splitSlideAtCaretAt(item, slide, el, rel) {
    if (item.type !== 'song' || slide.blockIndex == null) return;
    const abs = slide.lineStart + rel;
    // Commit whatever's been typed so far before touching the break array —
    // otherwise an edit made in this same pass would be lost.
    commitSlideText(item, null, slide, el.innerText);
    const block = item.blocks[slide.blockIndex];
    if (!block) return;
    block.breaks = block.breaks || [];
    if (abs > 0 && abs < block.lines.length && !block.breaks.includes(abs)) {
      block.breaks.push(abs);
      // Same gap as deleteFlowSlideOrSong's own fix — never called
      // renderStack(), so a split made via the grid view's own caret-split
      // path never showed up in the grid until some unrelated action
      // happened to re-render it.
      refreshAfterSlideEdit(item);
      if (typeof toast === 'function') toast('Slide split', 'success');
    }
  }

  function shiftBreaks(block, from, delta) {
    block.breaks = (block.breaks || [])
      .map(b => (b >= from ? b + delta : b))
      .filter(b => b > 0 && b < block.lines.length);
  }

  // ── Flow view: every slide of the item, stacked and editable at once.
  // Built off slidesFor() rather than item.blocks directly — for 'slides'
  // items a block already *is* one slide, but for 'song' items one block can
  // span several slides via linesPerSlide chunking, so this is the only view
  // that lines up 1:1 with what's actually sent/shown. Reordering and
  // Shift+Enter splitting only make sense for the two multi-slide types
  // ('slides' and 'song'); scripture/image are always exactly one slide.
  function renderFlowView(item) {
    const host = document.getElementById('svc-flow');
    if (!host) return;
    // Same class of bug as renderStack: a full rebuild on every call (every
    // send while browsing a multi-slide item in Full-Edit view) reset scroll
    // to the top with nothing to restore it — the operator's position in a
    // long song/slide deck kept getting yanked out from under them.
    const outerScroll = host.scrollTop;
    host.innerHTML = '';
    const slides = slidesFor(item);
    if (!slides.length) {
      host.innerHTML = '<div class="svc-flow-hint">No slides yet.</div>';
      return;
    }
    slides.forEach((s, i) => host.appendChild(flowRow(item, s, i, slides.length)));
    host.scrollTop = outerScroll;

    if (item.type === 'slides' || item.type === 'song') {
      const add = document.createElement('button');
      add.className = 'svc-add-line';
      add.style.margin = '4px auto';
      add.textContent = '+ slide';
      add.addEventListener('click', () => {
        if (item.type === 'slides') item.blocks.push({ label: `Slide ${item.blocks.length + 1}`, text: '' });
        else item.blocks.push({ label: `Verse ${item.blocks.length + 1}`, lines: [''] });
        saveService(); renderFullEdit(); renderSidebar();
      });
      host.appendChild(add);
      // Image slides only make sense for a plain 'slides' deck (a song's
      // blocks are lyric text, chunked into slides by line count — an
      // image doesn't fit that shape). See openSlideMediaLibraryPicker.
      if (item.type === 'slides') {
        const addMedia = document.createElement('button');
        addMedia.className = 'svc-add-line';
        addMedia.style.margin = '4px auto';
        addMedia.textContent = '+ image from library';
        addMedia.addEventListener('click', () => openSlideMediaLibraryPicker(item));
        host.appendChild(addMedia);
      }
    }

    const hint = document.createElement('div');
    hint.className = 'svc-flow-hint';
    hint.textContent = item.type === 'slides'
      ? 'Drag the grip to reorder · Shift+Enter or right-click at the caret splits into a new slide'
      : item.type === 'song'
      ? 'Shift+Enter or right-click at the caret splits into a new slide'
      : 'Click text to edit';
    host.appendChild(hint);
  }

  // Shared by the flow row's own delete button and its context menu's
  // "Delete this slide" — extracted so both call one implementation instead
  // of duplicating the type-branch. Only 'slides'/'song' items support
  // per-slide deletion (image/scripture items are always exactly one slide;
  // deleting that is deleting the whole item, via removeItem elsewhere).
  function deleteFlowSlideOrSong(item, index, slide) {
    const canDelete = slidesFor(item).length > 1 && (item.type === 'slides' || item.type === 'song');
    if (!canDelete) {
      if (typeof toast === 'function') toast('A section needs at least one slide', 'error');
      return;
    }
    deleteSlideAt(item, index, slide);
    // Real incident, owner: "when you right click on a slide to delete the
    // slide, it never works." This function is reached from BOTH the Flow
    // view's own delete button AND the grid card's right-click "Delete
    // this slide" (slideCard's own contextmenu handler) — but it only ever
    // called renderFullEdit()/renderSidebar(), never renderStack(). Flow
    // view (which calls renderFullEdit itself right after) never noticed;
    // the grid view did — the slide was genuinely deleted from item.blocks,
    // saved, everything, the GRID just never re-rendered to show it, so it
    // looked like the delete silently did nothing. refreshAfterSlideEdit
    // (the fan-out duplicateSlide/pasteSlides/bulkDeleteSlides already use —
    // this exact same context menu's OTHER actions, which is why only
    // Delete looked broken) covers both views correctly, including only
    // calling renderFullEdit() when that view is actually the one open.
    refreshAfterSlideEdit(item);
  }

  // `total` is passed in (computed once by renderFlowView) rather than
  // recomputed here — slidesFor() re-chunks every block for 'song' items,
  // so calling it again inside every one of N rows turned one N-row render
  // into O(N²) work. For a real multi-hundred-slide song this was the
  // actual few-second stall between hitting send and the row/board
  // updating, not anything about the send itself.
  function flowRow(item, slide, i, total) {
    const canReorder = item.type === 'slides';
    // Excludes image slides — a 'slides' item can now mix text and
    // pure-image blocks (ProPresenter imports), and there's no caret/text to
    // split at on an image block.
    const canSplit   = (item.type === 'slides' || item.type === 'song') && !slide.image;
    const canDelete  = total > 1 && (item.type === 'slides' || item.type === 'song');
    const isLive = liveSlideKey === `${item.id}:${i}`;
    const row = document.createElement('div');
    row.className = 'svc-flow-row' + (isLive ? ' live' : '') + (isSlideSelected(i) ? ' selected' : '');
    // Cmd/Ctrl+Click toggle / Shift+Click range-select — mirrors the
    // sidebar's own gesture. A plain click just clears the selection
    // in-place (no full renderFlowView rebuild — that would destroy the
    // very contenteditable the operator just clicked into, right as the
    // browser's native click-to-focus tries to land on it).
    row.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        handleSlideRowClick(i, e, () => renderFlowView(item));
        return;
      }
      if (selectedSlideIndices.size) {
        clearSlideSelection();
        document.querySelectorAll('.svc-flow-row.selected').forEach(r => r.classList.remove('selected'));
      }
    });

    const grip = document.createElement('span');
    grip.className = 'svc-flow-grip' + (canReorder ? '' : ' is-disabled');
    grip.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/></svg>`;
    // draggable is switched on only for the duration of a press on the grip
    // itself (see the confirmed top-bar-disappearing bug fix on the sidebar
    // row/stack card above) rather than left permanently true and merely
    // cancelled at dragstart-time — the previous pattern here still let
    // WebKit enter native drag-session preparation on any stray mousedown.
    if (canReorder) grip.addEventListener('mousedown', () => { row.draggable = true; });

    const num = document.createElement('span');
    num.className = 'svc-flow-num';
    num.textContent = i + 1;

    let content;
    if (slide.image) {
      content = document.createElement('div');
      content.className = 'svc-flow-image';
      const img = document.createElement('img');
      img.src = slide.image;
      img.style.objectFit = item.fit || 'contain';
      content.appendChild(img);
      const replace = document.createElement('button');
      replace.className = 'modal-btn secondary';
      replace.textContent = 'Replace image…';
      replace.addEventListener('click', (e) => {
        e.stopPropagation();
        replaceImageTarget = { item, blockIndex: item.type === 'slides' ? i : null };
        document.getElementById('svc-image-file')?.click();
      });
      content.appendChild(replace);
    } else {
      const text = document.createElement('div');
      text.className = 'svc-flow-text';
      text.contentEditable = 'true';
      text.spellcheck = false;
      text.textContent = slide.text || '';
      text.addEventListener('mousedown', (e) => e.stopPropagation());
      text.addEventListener('blur', () => commitSlideText(item, i, slide, text.innerText));
      text.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); text.blur(); return; }
        if (e.key === 'Enter' && e.shiftKey && canSplit) {
          e.preventDefault();
          if (item.type === 'slides') splitFlowSlideAtCaret(item, i, text);
          else splitSlideAtCaret(item, slide, text);
        }
      });
      content = text;
    }

    // Right-click: split (text slides)/Fit Mode (image slides)/Delete this
    // slide, all via the shared context-menu primitive. The caret position
    // is captured synchronously here, at right-click time, rather than
    // re-derived later from a possibly-stale selection once a menu button
    // (a separate, later click, on a detached popover) is clicked — by then
    // the contenteditable may have already blurred.
    if (canSplit || slide.image) {
      content.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const rel = canSplit ? caretLineIndex(content) : null;
        const sections = [];
        if (canSplit) {
          sections.push([{ label: 'Split slide here', onClick: () =>
            item.type === 'slides' ? splitFlowSlideAtCaretAt(item, i, content, rel) : splitSlideAtCaretAt(item, slide, content, rel) }]);
        }
        if (slide.image) sections.push([{ label: 'Fit Mode', submenu: fitModeMenuItems(item) }]);
        // Duplicate/Copy/Paste — omitted (not just disabled) when they don't
        // apply, same convention as Split above: this slide's underlying
        // block can't be duplicated (canDuplicateSlide), or nothing's been
        // copied yet, or (for Paste) this item type's structure doesn't
        // support pasting a clipboard slide into it.
        const editGroup = [];
        if (canDuplicateSlide(item, slide)) {
          editGroup.push({ label: 'Duplicate', onClick: () => duplicateSlide(item, i) });
        }
        const selection = selectedSlideIndices.size ? selectedSlideIndices : new Set([i]);
        if (anySlidesDuplicable(item, selection)) {
          editGroup.push({
            label: selection.size > 1 ? `Copy ${selection.size} slides` : 'Copy',
            onClick: () => copySlides(item, selection),
          });
        }
        if (slideClipboard && item.type === 'slides') {
          editGroup.push({ label: 'Paste', onClick: () => pasteSlides(item, i) });
        }
        if (editGroup.length) sections.push(editGroup);
        sections.push([{ label: 'Delete this slide', danger: true, disabled: !canDelete,
          onClick: () => deleteFlowSlideOrSong(item, i, slide) }]);
        openContextMenu(e.clientX, e.clientY, sections);
      });
    }

    const send = document.createElement('button');
    send.className = 'svc-flow-send';
    send.title = 'Send to screen';
    send.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Send</span>`;
    send.addEventListener('click', (e) => {
      e.stopPropagation();
      sendSlide(item, i); // also refreshes Flow's "live" highlight
    });

    const del = document.createElement('button');
    del.className = 'svc-flow-del' + (canDelete ? '' : ' is-disabled');
    del.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Delete</span>`;
    del.title = canDelete ? 'Delete slide' : 'A section needs at least one slide';
    del.addEventListener('click', () => deleteFlowSlideOrSong(item, i, slide));

    row.appendChild(grip);
    row.appendChild(num);
    row.appendChild(content);
    if (item.type === 'scripture') {
      const lookup = document.createElement('button');
      lookup.className = 'svc-flow-send';
      lookup.title = 'Re-look-up this verse by its reference';
      lookup.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span>Look up</span>`;
      lookup.addEventListener('click', (e) => { e.stopPropagation(); resolveScripture(item, lookup); });
      row.appendChild(lookup);
    }
    row.appendChild(send);
    row.appendChild(del);

    // Reorder by dragging the grip specifically — the row itself hosts an
    // editable text area, so a drag started from anywhere else would fight
    // with text selection. Only 'slides' items support this (see canReorder).
    if (canReorder) {
      row.draggable = false;
      row.addEventListener('mouseup', () => { row.draggable = false; });
      row.addEventListener('dragstart', (e) => {
        if (!grip.contains(e.target)) { e.preventDefault(); return; }
        dragFlowIndex = i;
        row.classList.add('svc-item-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch {}
      });
      row.addEventListener('dragend', () => {
        dragFlowIndex = null;
        document.querySelectorAll('.svc-flow-row').forEach(r => {
          r.classList.remove('svc-item-dragging', 'svc-drop-before', 'svc-drop-after');
          r.draggable = false;
        });
      });
      row.addEventListener('dragover', (e) => {
        if (dragFlowIndex == null || dragFlowIndex === i) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        row.classList.toggle('svc-drop-after', after);
        row.classList.toggle('svc-drop-before', !after);
      });
      row.addEventListener('dragleave', () => row.classList.remove('svc-drop-before', 'svc-drop-after'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = row.classList.contains('svc-drop-after');
        row.classList.remove('svc-drop-before', 'svc-drop-after');
        reorderFlowSlide(item, dragFlowIndex, i, after);
      });
    }

    return row;
  }

  function reorderFlowSlide(item, fromIndex, toIndex, after) {
    if (fromIndex == null || fromIndex === toIndex) return;
    const blocks = item.blocks;
    const targetBlock = blocks[toIndex];
    const [moved] = blocks.splice(fromIndex, 1);
    let to = blocks.indexOf(targetBlock);
    if (to < 0) to = blocks.length - 1;
    blocks.splice(after ? to + 1 : to, 0, moved);
    saveService(); renderFullEdit(); renderSidebar();
  }

  // Split a 'slides' block at the caret. Unlike splitSlideAtCaret (songs,
  // where one block chunks across several slides via linesPerSlide), each
  // block here already *is* one slide — so "splitting" means inserting a
  // whole new block right after, carrying everything past the caret.
  function splitFlowSlideAtCaret(item, index, el) {
    return splitFlowSlideAtCaretAt(item, index, el, caretLineIndex(el));
  }
  function splitFlowSlideAtCaretAt(item, index, el, rel) {
    const block = item.blocks[index];
    if (!block) return;
    const lines = el.innerText.replace(/\r/g, '').split('\n');
    const before = lines.slice(0, rel).join('\n');
    const after  = lines.slice(rel).join('\n');
    if (!after.trim()) return; // nothing past the caret to break off
    block.text = before;
    item.blocks.splice(index + 1, 0, { label: `Slide ${index + 2}`, text: after });
    // Same gap as deleteFlowSlideOrSong's own fix — never called renderStack().
    refreshAfterSlideEdit(item);
    if (typeof toast === 'function') toast('Slide split', 'success');
  }

  // hexA now lives in color_utils.js (as window.hexA, an alias for
  // hexOpacity) — shared with app.js and display.html, which had two more
  // divergent copies of this same logic.

  async function resolveScripture(item, btn) {
    const ref = (item.ref || '').trim();
    if (!ref) return;
    btn.disabled = true; btn.textContent = 'Looking up…';
    try {
      const r = await fetchWithTimeout(`${SERVER}/api/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: ref, limit: 1 }),
      });
      const d = await r.json();
      const hit = d.result || (d.results || [])[0];
      if (hit) {
        item.text = hit.text || ''; item.title = hit.reference || ref;
        // Structured book/chapter/verse — needed so the Multi-Language theme
        // can look up the real verse in the target language instead of
        // falling back to an AI translation of the English text.
        item.book = hit.book || null; item.chapter = hit.chapter || null; item.verse = hit.verse || null;
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

  // Mirrors any newly-created item (file/clipboard import, hymn bank, manual
  // song/slides/scripture/image) into Default with a fresh id, and stamps
  // `libraryId` on the item actually being placed so removeItem's cascade
  // can find it later. Deep-cloned (not shared by reference) — editing the
  // copy in its destination playlist must not retroactively change
  // Default's copy or vice versa; only deletion is meant to cascade.
  function archiveImportToDefault(item, target) {
    if (target.isDefault) return; // already the canonical copy
    const dflt = playlists.find(p => p.isDefault);
    if (!dflt) return; // defensive — ensureDefaultPlaylist guarantees this exists
    const clone = JSON.parse(JSON.stringify(item));
    clone.id = uid(item.type);
    delete clone.libraryId;
    dflt.items.push(clone);
    item.libraryId = clone.id;
  }

  // ── Adding sections ───────────────────────────────────────────────────────
  // Actually commit a drafted item into a (possibly non-active) playlist.
  // Every item, however it was created — file/clipboard import, hymn bank,
  // manual song/slides/scripture, manual image — archives a copy into
  // Default first (see archiveImportToDefault); archiveImportToDefault
  // itself no-ops when `playlist` already IS Default, so this is safe to
  // call unconditionally rather than needing every call site to flag its
  // own origin.
  function commitItem(playlist, item) {
    archiveImportToDefault(item, playlist);
    playlist.items.push(item);
    saveService();
    if (playlist.id !== activePlaylistId) switchPlaylist(playlist.id);
    focusInStack(item.id);
  }

  const MAKERS = {
    slides:    () => ({ id: uid('slides'), type: 'slides', title: 'New slides', blocks: [{ label: 'Slide 1', text: '' }] }),
    scripture: () => ({ id: uid('scr'), type: 'scripture', title: 'Scripture', ref: '', text: '' }),
  };

  // ── Add / import confirmation ────────────────────────────────────────────
  // Every path that creates a new section — hymn bank, the add-menu, a file
  // or clipboard import — routes through here so the operator picks the
  // destination playlist, the theme, and (for text content) how it splits
  // into slides, in one step instead of three.
  let acDraft = null;   // { item, showDelimiter, isImportBlocks, rawBlocks }
  // 'paragraph' = each imported block/stanza is kept as one slide as-is
  // (delimiter n=0); 'lines' = re-flow by the numeric "lines per slide"
  // input. A named toggle instead of a bare "0 means keep-as-is" number —
  // set by setAcStructureMode(), read by confirmAddConfirm().
  let acStructureMode = 'lines';
  let pendingExtraImages = [];   // remaining files from a multi-select image add
  let pendingExtraBlockItems = [];   // remaining presentations from a multi-item playlist import
  // Set by flowRow's "Replace image…" button just before it clicks the
  // hidden #svc-image-file input, so the input's change handler knows
  // whether this is a direct in-place swap (and on which block, for a
  // 'slides'-type item's own image block — it can now hold several) rather
  // than adding a brand-new image item.
  let replaceImageTarget = null;   // { item, blockIndex: number|null } | null

  function openAddConfirm(item, opts = {}) {
    const destination = opts.destination || 'playlist';
    acDraft = {
      item, showDelimiter: !!opts.showDelimiter, isImportBlocks: !!opts.isImportBlocks, rawBlocks: opts.rawBlocks || null,
      destination, libraryId: opts.libraryId || null,
    };
    // A block carrying `.layers` is a real ProPresenter scene (position/
    // font/color/images preserved as-authored — see slide_import.js's
    // decodeCueSceneLayers). Neither the theme picker nor the slide-
    // structure choice below has any effect on it at all (isScene slides
    // never consult item.themeId, and re-flowing would destroy the real
    // per-slide layout) — hidden in favor of one clear line saying so,
    // rather than showing two controls that quietly do nothing.
    const isSceneImport = !!(acDraft.rawBlocks && acDraft.rawBlocks.some(b => b.layers));
    document.getElementById('ac-scene-notice')?.classList.toggle('hidden', !isSceneImport);
    document.getElementById('ac-theme-group')?.classList.toggle('hidden', isSceneImport);

    const titleInp = document.getElementById('ac-title');
    if (titleInp) titleInp.value = item.title || '';

    // Adding to the Song Library has nowhere for a playlist pick to go
    // (it's not landing in one) — a category pick replaces it instead.
    document.getElementById('ac-playlist-group')?.classList.toggle('hidden', destination === 'library');
    const folderGroup = document.getElementById('ac-folder-group');
    folderGroup?.classList.toggle('hidden', destination !== 'library');
    if (destination === 'library') {
      const folderSel = document.getElementById('ac-folder');
      if (folderSel) {
        folderSel.innerHTML = '';
        const none = document.createElement('option');
        none.value = ''; none.textContent = 'Uncategorized';
        folderSel.appendChild(none);
        SONG_CATEGORIES.forEach(cat => {
          const o = document.createElement('option');
          o.value = cat.id; o.textContent = cat.name;
          folderSel.appendChild(o);
        });
        // A library entry's own stored category wins (editing an existing
        // song); otherwise default to whichever category rail chip the
        // operator currently has selected (see activeSongCategory) rather
        // than always resetting to Uncategorized — importing while browsing
        // "Worship" should land the new song in Worship without an extra
        // click, same as Slides' import defaulting to whichever playlist is
        // currently open.
        folderSel.value = item.category || activeSongCategory || '';
      }
    } else {
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
      // A library song's own stored default (set on a previous add/edit)
      // wins over the generic lyrics-theme guess — round-trips correctly
      // when editing an existing library entry.
      if (item.themeId && all.some(l => l.id === item.themeId)) themeSel.value = item.themeId;
      // Scene import: no theme applies, so no theme should be recorded on
      // the item either (item.themeId isn't read for rendering an isScene
      // slide, but leaving a stale value from a previous dialog use around
      // for no reason is its own small confusion to avoid).
      if (isSceneImport) themeSel.value = '';
    }

    const delimGroup = document.getElementById('ac-delim-group');
    if (delimGroup) delimGroup.style.display = (acDraft.showDelimiter && !isSceneImport) ? '' : 'none';
    const delimInput = document.getElementById('ac-delim-input');
    if (delimInput) delimInput.value = DEFAULT_LINES_PER_SLIDE;
    setAcStructureMode(opts.defaultKeepAsIs ? 'paragraph' : 'lines');

    document.getElementById('add-confirm-heading').textContent = destination === 'library'
      ? (acDraft.libraryId ? 'Edit Song Library entry' : 'Add to Song Library')
      : (opts.isImportBlocks ? 'Import into playlist' : 'Add to playlist');
    document.getElementById('add-confirm-modal')?.classList.remove('hidden');
    titleInp?.focus();
  }

  function closeAddConfirm() {
    document.getElementById('add-confirm-modal')?.classList.add('hidden');
    acDraft = null;
  }

  // Toggles the add-confirm modal's "Slide structure" pair (Paragraph vs
  // Custom lines) — Paragraph hides the numeric input entirely (it's the
  // n=0 case, "keep each imported block/stanza as one slide"); Custom lines
  // shows it so the operator can set a lines-per-slide count.
  function setAcStructureMode(mode) {
    acStructureMode = mode;
    const paraBtn = document.getElementById('ac-structure-paragraph');
    const linesBtn = document.getElementById('ac-structure-lines');
    const delimInput = document.getElementById('ac-delim-input');
    const hint = document.getElementById('ac-delim-hint');
    paraBtn?.classList.toggle('primary', mode === 'paragraph');
    paraBtn?.classList.toggle('secondary', mode !== 'paragraph');
    linesBtn?.classList.toggle('primary', mode === 'lines');
    linesBtn?.classList.toggle('secondary', mode !== 'lines');
    if (delimInput) delimInput.style.display = mode === 'paragraph' ? 'none' : '';
    if (hint) hint.textContent = mode === 'paragraph'
      ? 'Each imported paragraph/stanza becomes its own slide, exactly as imported.'
      : 'Re-flows the text into slides of this many lines each, ignoring the original paragraph breaks.';
  }

  function confirmAddConfirm() {
    if (!acDraft) return;
    const { item, showDelimiter, isImportBlocks, rawBlocks, destination, libraryId } = acDraft;

    const titleInp = document.getElementById('ac-title');
    if (titleInp?.value.trim()) item.title = titleInp.value.trim();

    const themeSel = document.getElementById('ac-theme');
    item.themeId = themeSel?.value || null;

    if (showDelimiter) {
      const delimInput = document.getElementById('ac-delim-input');
      const n = acStructureMode === 'paragraph'
        ? 0
        : (delimInput ? Math.max(0, Math.floor(Number(delimInput.value)) || 0) : DEFAULT_LINES_PER_SLIDE);
      if (isImportBlocks && rawBlocks) {
        if (n === 0) {
          // Keep each imported block as its own fixed slide. A block
          // carrying `.layers` is a real ProPresenter scene (position/
          // font/color/images preserved as-authored) — same gap as
          // toBlocksItem's own copy of this mapping (see its comment):
          // this is the actual FINAL commit path (toBlocksItem only
          // builds the dialog's initial preview item), so losing .layers
          // here specifically would have silently thrown away everything
          // slide_import.js just extracted, right at the moment the
          // operator clicks "Add slides."
          item.type = 'slides';
          item.blocks = rawBlocks.map(b => b.layers
            ? { label: b.label, layers: b.layers, canvasSize: b.canvasSize, text: b.text || '' }
            : b.image
            ? { label: b.label, image: b.image }
            : { label: b.label, text: (b.lines || []).join('\n') });
          delete item.linesPerSlide;
        } else {
          // Re-flow ALL the imported text as ONE continuous stream of
          // lines, ignoring the original paragraph breaks — that's the
          // whole point of Custom-lines mode (see its own hint text just
          // above: "ignoring the original paragraph breaks"). Chunking
          // each imported block (paragraph) separately, the previous
          // behavior, meant this delimiter silently did nothing whenever
          // a pasted stanza already had <= n lines — which looks exactly
          // like Paragraph mode, with nothing to explain why "Custom
          // lines: 2" didn't actually re-split anything.
          item.type = 'song';
          item.linesPerSlide = n;
          const allLines = rawBlocks.filter(b => !b.image).flatMap(b => b.lines || []);
          // No real section name for this synthetic block — it's just the
          // deck's own title, which slidesFor() would otherwise repeat on
          // every single chunked slide (owner: "title in all slide is not
          // required, slide numbers are more important"). Blank it and let
          // slidesFor's own fallback show a bare slide number instead.
          item.blocks = [{ label: '', lines: allLines }];
        }
      } else {
        item.linesPerSlide = n;
      }
    }

    // Song Library entries aren't playlist items — no playlist target, no
    // songBank/uid churn, just a persisted record (create or update).
    if (destination === 'library') {
      const folderSel = document.getElementById('ac-folder');
      const record = {
        title: item.title, author: item.author || '', year: item.year || null,
        themeId: item.themeId, category: folderSel?.value || null, blocks: toLibraryBlocks(item.blocks),
      };
      const extras = pendingExtraBlockItems; pendingExtraBlockItems = [];
      closeAddConfirm();
      (async () => {
        if (libraryId) await updateLibrarySong(libraryId, record);
        else await addLibrarySong(record);
        // A multi-item playlist import's remaining presentations ride along
        // into the library too, same as the playlist-destination case below.
        for (const extra of extras) {
          await addLibrarySong({
            title: extra.name || 'Imported song', author: '', year: null, themeId: item.themeId, category: record.category,
            blocks: toLibraryBlocks(extra.blocks),
          });
        }
        renderHymnList(hymnListQuery);
      })();
      return;
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
          if (!src) continue;
          const extraImg = { id: uid('img'), type: 'image', title: f.name.replace(/\.[^.]+$/, ''), src, themeId: item.themeId };
          archiveImportToDefault(extraImg, target);
          target.items.push(extraImg);
        }
        saveService(); renderStack(); renderSidebar();
      })();
    }

    // A playlist import confirms its first presentation once, then the rest
    // ride along with the same playlist/theme/delimiter choice — same pattern
    // as the multi-select image add above, just for imported blocks instead.
    if (isImportBlocks && pendingExtraBlockItems.length) {
      const extras = pendingExtraBlockItems; pendingExtraBlockItems = [];
      const delimInput = document.getElementById('ac-delim-input');
      const n = delimInput ? Math.max(0, Math.floor(Number(delimInput.value)) || 0) : DEFAULT_LINES_PER_SLIDE;
      for (const extra of extras) {
        const extraItem = n === 0
          ? { id: uid('slides'), type: 'slides', title: extra.name || 'Imported slides', themeId: item.themeId,
              blocks: extra.blocks.map(b => b.image
                ? { label: b.label, image: b.image }
                : { label: b.label, text: (b.lines || []).join('\n') }) }
          // Same flatten-across-blocks reflow as the primary item above —
          // Custom-lines mode ignores the original paragraph breaks. Blank
          // label, same reasoning as the primary item's own block above:
          // no real section name here, just noise if repeated per slide.
          : { id: uid('song'), type: 'song', title: extra.name || 'Imported slides', themeId: item.themeId, linesPerSlide: n,
              blocks: [{ label: '', lines: extra.blocks.filter(b => !b.image).flatMap(b => b.lines || []) }] };
        archiveImportToDefault(extraItem, target);
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

  // Same fetch+canvas re-encode readImage() does for a File, just sourced
  // from an existing Media Bin/smart-folder URL instead — for pulling an
  // already-organized announcement image straight into a slide deck
  // (openSlideMediaLibraryPicker below) without a redundant re-upload
  // through the OS file picker.
  function readImageFromUrl(url) {
    return fetch(url).then(r => {
      if (!r.ok) throw new Error('fetch failed');
      return r.blob();
    }).then(blob => new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('decode failed')); };
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const scale = Math.min(1, 1920 / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(/png|webp/i.test(blob.type) ? 'image/png' : 'image/jpeg', 0.86));
      };
      img.src = objectUrl;
    }));
  }

  // Local mirror of app.js's own fetchAllMediaItems (Theme Studio's Library
  // picker) — same cross-file duplication convention used elsewhere in this
  // pair of files (see SECTION_CYCLE/sectionTypeClass) rather than reaching
  // into app.js's closure, which service.js's own IIFE has no access to.
  async function fetchAllMediaItemsForPicker() {
    const items = [];
    try {
      const bin = await fetch(`${SERVER}/api/media/bin`).then(r => r.json());
      (bin.items || []).forEach(it => items.push(it));
    } catch {}
    try {
      const foldersRes = await fetch(`${SERVER}/api/media/folders`).then(r => r.json());
      for (const folder of (foldersRes.folders || [])) {
        try {
          const res = await fetch(`${SERVER}/api/media/folders/${folder.id}/items`).then(r => r.json());
          (res.items || []).forEach(it => items.push(it));
        } catch {}
      }
    } catch {}
    return items;
  }

  // Real drag-and-drop from the Media Bin strip (buildMediaBinCard) onto a
  // 'slides' item's own slide grid (or its empty-state placeholder) in the
  // Stack view — the ONE place Media content is visible at the same time
  // as another view (see buildMediaBinCard's own comment for why the full
  // Media tab can't support this). `el` is either the .svc-slides-grid or
  // the empty-deck placeholder div, both wired identically. Highlighted
  // via .svc-media-drop-target (styles.css) — checked with
  // el.contains(e.relatedTarget) on dragleave so hovering over a CHILD
  // slide card doesn't flicker the highlight off and back on.
  function wireMediaBinDropTarget(el, item) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(MEDIA_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('svc-media-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (el.contains(e.relatedTarget)) return;
      el.classList.remove('svc-media-drop-target');
    });
    el.addEventListener('drop', async (e) => {
      const raw = e.dataTransfer.getData(MEDIA_DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      el.classList.remove('svc-media-drop-target');
      let mi;
      try { mi = JSON.parse(raw); } catch { return; }
      try {
        const src = await readImageFromUrl(mi.url);
        item.blocks.push({ label: `Slide ${item.blocks.length + 1}`, image: src, imageFileName: mi.name });
        saveService(); renderStack();
        if (activeItemId === item.id) renderFullEdit();
      } catch {
        if (typeof toast === 'function') toast('Could not load that image', 'error');
      }
    });
  }

  // "Add from Media Library" for an actual SLIDE (not a Theme Studio decor
  // layer — see app.js's openMediaLibraryPicker/addMediaToCurrentSlide,
  // which pushes into activeLook.layers, a different thing entirely).
  // Appends a real new block to a 'slides' item, filename captured so the
  // announcement follower (announcementShapeForFollow/imageTriggerPhrase)
  // has something to match on even before the operator names it. The
  // click-based bridge (dragging works too now — wireMediaBinDropTarget
  // above — but only from the Media Bin strip, which is the one place
  // Media content is visible alongside another view; this stays as the
  // reachable path from the Media tab itself, where dragging isn't
  // physically possible).
  let slideMediaPickerEl = null;
  function closeSlideMediaLibraryPicker() { slideMediaPickerEl?.remove(); slideMediaPickerEl = null; }
  async function openSlideMediaLibraryPicker(item) {
    closeSlideMediaLibraryPicker();
    const overlay = document.createElement('div');
    overlay.className = 'ts-media-picker-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSlideMediaLibraryPicker(); });
    const panel = document.createElement('div');
    panel.className = 'ts-media-picker-panel';
    const header = document.createElement('div');
    header.className = 'ts-media-picker-header';
    header.innerHTML = '<span>Add from Media Library</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Close</span>';
    closeBtn.addEventListener('click', closeSlideMediaLibraryPicker);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const grid = document.createElement('div');
    grid.className = 'ts-media-picker-grid';
    grid.textContent = 'Loading…';
    panel.appendChild(grid);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    slideMediaPickerEl = overlay;

    const items = (await fetchAllMediaItemsForPicker()).filter(it => it.kind === 'image');
    grid.innerHTML = '';
    if (!items.length) {
      grid.innerHTML = '<div class="svc-empty">No images in your Media Library yet.</div>';
      return;
    }
    items.forEach(mi => {
      const card = document.createElement('button');
      card.className = 'media-card';
      const img = document.createElement('img');
      img.src = mi.url;
      card.appendChild(img);
      const label = document.createElement('div');
      label.className = 'media-card-label';
      label.textContent = mi.name;
      card.appendChild(label);
      card.addEventListener('click', async () => {
        card.disabled = true;
        try {
          const src = await readImageFromUrl(mi.url);
          item.blocks.push({ label: `Slide ${item.blocks.length + 1}`, image: src, imageFileName: mi.name });
          saveService(); renderFullEdit(); renderStack();
          closeSlideMediaLibraryPicker();
        } catch {
          if (typeof toast === 'function') toast('Could not load that image', 'error');
          card.disabled = false;
        }
      });
      grid.appendChild(card);
    });
  }

  // ── Recently used (Songs/Media pickers) ─────────────────────────────────
  // Small localStorage-backed MRU list per content kind — same idiom as
  // `kairo-output-themes` (app.js). Stores enough of the item to re-render
  // a row/card without a second fetch; a `key` field is the dedupe/lookup
  // handle (song id, media item URL, etc.). Entries pointing at something
  // that no longer exists are left for the caller to filter at render
  // time rather than pruned proactively here.
  const RECENTS_MAX = 8;
  function recentsStorageKey(kind) { return `kairo-recent-${kind}`; }
  function pushRecent(kind, key, data) {
    let list = getRecents(kind);
    list = list.filter(e => e.key !== key);
    list.unshift({ key, ts: Date.now(), ...data });
    list = list.slice(0, RECENTS_MAX);
    try { localStorage.setItem(recentsStorageKey(kind), JSON.stringify(list)); } catch {}
  }
  function getRecents(kind) {
    try { return JSON.parse(localStorage.getItem(recentsStorageKey(kind)) || '[]'); } catch { return []; }
  }

  // ── Song bank + persistent Song Library ─────────────────────────────────
  // The bundled/imported-JSON hymn bank (src/hymns.js) is read-only and has
  // no category — this is the operator's own persistent collection on top
  // of it. It merges into the same search/list via hymns.js's
  // setLibrarySongs(), so searchHymns() already includes it; librarySongs
  // itself is only kept here to know which rows are ours to edit/delete and
  // to drive the category-chip filter (bundled hymns never carry a
  // category, so they always show under "All Songs").
  const SONG_CATEGORIES = [
    { id: 'worship', name: 'Worship' },
    { id: 'praise', name: 'Praise' },
    { id: 'hymn', name: 'Hymn' },
  ];
  let librarySongs = [];
  let activeSongCategory = null; // null = "All Songs"
  let hymnListQuery = '';

  function isLibrarySong(id) { return librarySongs.some(s => s.id === id); }

  function syncLibraryIntoHymnBank() {
    if (typeof setLibrarySongs === 'function') setLibrarySongs(librarySongs);
  }

  async function loadSongLibrary() {
    try {
      const r = await fetchWithTimeout(`${SERVER}/api/songs`).then(r => r.json());
      librarySongs = r.songs || [];
      syncLibraryIntoHymnBank();
    } catch { librarySongs = []; }
  }

  async function addLibrarySong(record) {
    const r = await fetchWithTimeout(`${SERVER}/api/songs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record),
    }).then(r => r.json());
    if (r.song) { librarySongs.push(r.song); syncLibraryIntoHymnBank(); }
    return r.song || null;
  }

  async function updateLibrarySong(id, record) {
    const r = await fetchWithTimeout(`${SERVER}/api/songs/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record),
    }).then(r => r.json());
    if (r.song) {
      const idx = librarySongs.findIndex(s => s.id === id);
      if (idx >= 0) librarySongs[idx] = r.song;
      syncLibraryIntoHymnBank();
    }
    return r.song || null;
  }

  async function deleteLibrarySong(id) {
    await fetchWithTimeout(`${SERVER}/api/songs/${id}`, { method: 'DELETE' });
    librarySongs = librarySongs.filter(s => s.id !== id);
    syncLibraryIntoHymnBank();
    renderHymnList(hymnListQuery);
  }

  function showSongsLibrary() {
    showCenterView('songs');
    renderSongFolderRail();
    renderHymnList('');
    document.getElementById('hymn-search')?.focus();
  }

  // "Folder rail" name kept for the DOM id/CSS class (mirrors Media's own
  // chip rail exactly) even though these are 3 fixed preset categories, not
  // creatable/deletable folders — no add/remove chip, just a filter.
  function renderSongFolderRail() {
    renderChipRail(document.getElementById('song-folder-rail'), {
      items: SONG_CATEGORIES,
      getId: cat => cat.id,
      getLabel: cat => cat.name,
      activeId: activeSongCategory,
      allLabel: 'All Songs',
      onSelect: (id) => { activeSongCategory = id; renderSongFolderRail(); renderHymnList(hymnListQuery); },
    });
  }

  function buildHymnRow(h) {
    const isLib = isLibrarySong(h.id);
    const row = document.createElement('button');
    row.className = 'hymn-row';
    // Library songs commonly have no author/year (unlike bundled hymns,
    // which always carry both) — omit each blank part instead of printing
    // an empty string or literal "null".
    const subParts = [h.author, h.year, `${h.blocks.length} stanzas`].filter(Boolean);
    row.innerHTML =
      `<div class="hymn-row-main"><div class="hymn-title">${escapeHtml(h.title)}</div>` +
      `<div class="hymn-sub">${escapeHtml(subParts.join(' · '))}</div></div>` +
      (isLib ? `<span class="hymn-edit" title="Edit">Edit</span><span class="hymn-delete" title="Delete">Delete</span>` : '') +
      `<span class="hymn-add">Add</span>`;
    // Default action for the whole row (matches the pre-existing
    // whole-row-is-clickable behavior) — Edit/Delete below stop
    // propagation so they override this instead of also triggering it.
    row.addEventListener('click', () => {
      const item = {
        id: uid('song'), type: 'song', songBank: true,
        title: h.title, author: h.author, year: h.year,
        linesPerSlide: DEFAULT_LINES_PER_SLIDE,
        blocks: h.blocks.map(b => ({ label: b.label, lines: [...(b.lines || [])] })),
      };
      if (h.themeId) item.themeId = h.themeId;
      pushRecent('song', h.id, { title: h.title, author: h.author, year: h.year });
      openAddConfirm(item, { showDelimiter: true });
    });
    if (isLib) {
      row.querySelector('.hymn-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddConfirm({
          id: uid('song'), type: 'song',
          title: h.title, author: h.author, year: h.year, themeId: h.themeId || null,
          category: h.category || null,
          linesPerSlide: DEFAULT_LINES_PER_SLIDE,
          blocks: h.blocks.map(b => ({ label: b.label, lines: [...(b.lines || [])] })),
        }, { showDelimiter: true, destination: 'library', libraryId: h.id });
      });
      row.querySelector('.hymn-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDeletePopover(e.currentTarget, `Delete "${h.title}" from your Song Library?`, () => deleteLibrarySong(h.id));
      });
    }
    return row;
  }

  function renderHymnList(query) {
    hymnListQuery = query || '';
    const host = document.getElementById('hymn-list');
    if (!host || typeof searchHymns !== 'function') return;
    let results = searchHymns(query);
    if (activeSongCategory != null) {
      results = results.filter(h => {
        // The bundled 286-hymn bank has no per-song category (it's a
        // read-only import, not the operator's own tagged library) — but
        // every one of those songs genuinely IS a hymn by origin, so the
        // "Hymn" chip specifically must include all of them, not just
        // library songs someone happened to tag category:'hymn'. Real
        // incident this fixes: selecting "Hymn" showed nothing from the
        // actual hymn bank at all — only the operator's own manually-
        // tagged library entries, which for most operators is empty.
        if (activeSongCategory === 'hymn' && !isLibrarySong(h.id)) return true;
        return isLibrarySong(h.id) && librarySongs.find(s => s.id === h.id)?.category === activeSongCategory;
      });
    }
    host.innerHTML = '';

    // "Recently Used" only makes sense as a view of the *unfiltered* bank —
    // under a category chip or an active search it'd just be confusing
    // noise ("why is this here, I filtered it out"), so it only shows when
    // both are cleared. Recent picks still also appear in the full list
    // below; this is a shortcut to the top, not a separate silo.
    if (activeSongCategory == null && !hymnListQuery) {
      const recentHymns = getRecents('song')
        .map(r => results.find(h => h.id === r.key))
        .filter(Boolean);
      renderRecentsSection(host, { items: recentHymns, buildItem: buildHymnRow, allLabel: 'All Songs' });
    }

    if (!results.length) {
      host.insertAdjacentHTML('beforeend', '<div class="svc-empty">No songs match that search</div>');
      return;
    }
    results.forEach(h => host.appendChild(buildHymnRow(h)));
  }

  // ── Media library ──────────────────────────────────────────────────────
  // Independent of playlists entirely — media is sent to the output's own
  // media layer (see display.html), not into a playlist item. Two sources:
  // the general "bin" (direct uploads/drops with no folder chosen) and
  // "smart folders" — a saved reference to a real folder on disk that KAIRO
  // watches and reflects live, never owning a copy of what's in it.
  let mediaFolders = [];
  let activeMediaFolderId = null; // null = the bin
  let mediaSeeking = false;       // true while the operator is dragging the seek slider
  // Session-only: once the operator opts into the plain bin on first run,
  // stop leading with the "add a folder" prompt for the rest of the session.

  function showMediaLibrary() {
    showCenterView('media');
    loadMediaFolders();
  }

  async function loadMediaFolders() {
    try {
      const r = await fetchWithTimeout(`${SERVER}/api/media/folders`);
      const d = await r.json();
      mediaFolders = d.folders || [];
    } catch (err) {
      // Distinguish "server unreachable" from "genuinely no folders" — both
      // used to render identically as an empty rail with no indication
      // anything went wrong.
      console.warn('[Media] Could not load folders:', err);
      if (typeof toast === 'function') toast('Could not reach Kairo server', 'error');
      mediaFolders = [];
    }
    renderMediaFolderRail();
    renderMediaGrid();
    refreshMediaBinIfVisible();   // folder linked/unlinked → bin mirrors it
  }

  function renderMediaFolderRail() {
    const rail = document.getElementById('media-folder-rail');
    if (!rail) return;
    renderChipRail(rail, {
      items: mediaFolders,
      getId: f => f.id,
      getLabel: f => f.name,
      chipTitle: f => f.path,
      activeId: activeMediaFolderId,
      allLabel: 'All Media',
      onSelect: (id) => { activeMediaFolderId = id; renderMediaFolderRail(); renderMediaGrid(); },
      // Unlike Songs' fixed categories, a folder chip is deletable — a
      // real <button> here would nest inside `chip` (also a <button>),
      // which is an invalid HTML content model, so this is a span with
      // role="button" + tabindex for keyboard/screen-reader access instead.
      buildExtra: (chip, f) => {
        const del = document.createElement('span');
        del.className = 'media-folder-chip-del';
        del.textContent = '×';
        del.title = 'Unlink folder (does not delete the files)';
        del.setAttribute('role', 'button');
        del.tabIndex = 0;
        del.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); del.click(); }
        });
        del.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await fetchWithTimeout(`${SERVER}/api/media/folders/${f.id}`, { method: 'DELETE' });
          } catch (err) {
            if (typeof toast === 'function') toast('Could not unlink folder: ' + err.message, 'error');
            return;
          }
          if (activeMediaFolderId === f.id) activeMediaFolderId = null;
          loadMediaFolders();
        });
        chip.appendChild(del);
      },
    });

    const addChip = document.createElement('button');
    addChip.id = 'media-add-folder-btn-inline';
    addChip.className = 'media-folder-chip media-folder-chip-add';
    addChip.textContent = '+';
    addChip.title = 'Choose a media folder';
    addChip.addEventListener('click', (e) => pickMediaFolder(e.currentTarget));
    rail.appendChild(addChip);
  }

  // Native folder picker — pick any folder on disk (the OS dialog's own
  // "New Folder" button covers "create one anywhere"). Falls back to the
  // name-only popover in a plain-browser dev context with no Tauri bridge.
  async function pickMediaFolder(anchorForFallback) {
    const dlg = window.__TAURI__?.dialog;
    if (!dlg?.open) { openAddMediaFolderPopover(anchorForFallback || document.getElementById('media-add-folder-btn-inline')); return; }
    let dir;
    try {
      dir = await dlg.open({ directory: true, multiple: false, title: 'Choose a media folder', canCreateDirectories: true });
    } catch { return; }
    if (!dir) return;
    const dirPath = Array.isArray(dir) ? dir[0] : dir;
    const name = String(dirPath).split(/[/\\]+/).filter(Boolean).pop() || 'Media';
    try {
      const r = await fetchWithTimeout(`${SERVER}/api/media/folders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, dirPath }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || 'Could not link that folder');
      activeMediaFolderId = d.folder?.id || null;
      loadMediaFolders();
    } catch (e) {
      if (typeof toast === 'function') toast(e.message, 'error');
    }
  }

  function openAddMediaFolderPopover(anchor) {
    openPopover(anchor, (pop) => {
      pop.classList.add('svc-popover-wide');
      const title = document.createElement('div');
      title.className = 'svc-popover-hint';
      title.textContent = 'Name it and KAIRO creates a real folder under Documents › Kairo Media — anything you add, remove, or rename in it (from Finder, another app, anywhere) shows up here automatically.';
      pop.appendChild(title);

      const nameInput = document.createElement('input');
      nameInput.type = 'text'; nameInput.className = 'setting-input';
      nameInput.placeholder = 'Folder name';
      nameInput.style.marginTop = '6px';
      pop.appendChild(nameInput);

      const err = document.createElement('div');
      err.style.cssText = 'color:var(--red);font-size:11px;margin-top:6px;display:none;';
      pop.appendChild(err);

      const addBtn = document.createElement('button');
      addBtn.className = 'modal-btn primary';
      addBtn.style.cssText = 'width:100%;justify-content:center;margin-top:8px;';
      addBtn.textContent = 'Create folder';
      addBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        try {
          const r = await fetchWithTimeout(`${SERVER}/api/media/folders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          const d = await r.json();
          if (!r.ok || d.error) throw new Error(d.error || 'Could not create folder');
          closePopover();
          loadMediaFolders();
        } catch (e2) {
          err.textContent = e2.message;
          err.style.display = '';
        }
      });
      pop.appendChild(addBtn);
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
      requestAnimationFrame(() => nameInput.focus());
    });
  }

  async function fetchActiveMediaItems() {
    try {
      const url = activeMediaFolderId
        ? `${SERVER}/api/media/folders/${activeMediaFolderId}/items`
        : `${SERVER}/api/media/bin`;
      const r = await fetchWithTimeout(url);
      const d = await r.json();
      const items = d.items || [];
      items.truncated = !!d.truncated;
      return items;
    } catch (err) {
      // Same reasoning as loadMediaFolders — an unreachable server used to
      // render identically to "this folder is empty".
      console.warn('[Media] Could not load items:', err);
      if (typeof toast === 'function') toast('Could not reach Kairo server', 'error');
      return [];
    }
  }

  // Only load a thumbnail's bytes once the card is near the viewport — a
  // linked folder can hold hundreds of images (esp. an existing Google
  // Drive / Photos folder), and loading them all at once, some of them
  // large or cloud-backed, is what locked the app up. A video thumbnail
  // deliberately stays PAUSED on its first frame once loaded, same as an
  // image — playing every visible video thumbnail at once (a grid can show
  // a dozen+ cards) is real, ongoing decode work for media nobody picked
  // yet, purely for a shelf/grid preview. It plays for real once actually
  // selected — sendMediaItem's target (the independent media layer /
  // display.html) is a real autoplaying <video>.
  const lazyMediaObserver = (typeof IntersectionObserver === 'function')
    ? new IntersectionObserver((entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target;
          if (el.dataset.src) { el.src = el.dataset.src; delete el.dataset.src; }
          obs.unobserve(el);
        }
      }, { rootMargin: '300px' })
    : { observe(el) { if (el.dataset.src) { el.src = el.dataset.src; delete el.dataset.src; } }, unobserve() {} };

  // The one shared thumbnail builder for every "media item as a card" grid
  // in the app (Media tab's own grid via buildMediaCard, the Media Bin via
  // buildMediaBinCard below) — was two near-identical copies that could
  // silently drift.
  function buildMediaThumb(item) {
    if (item.kind === 'video') {
      const v = document.createElement('video');
      // preload:'metadata' (not 'none') + lazy src, and deliberately never
      // played — see lazyMediaObserver's own comment on why a shelf/grid
      // full of thumbnails stays paused until something is actually
      // selected. 'metadata' only fetches enough to know duration/
      // dimensions — nowhere near the cost of decoding the whole file — but
      // whether that alone also paints a first frame is browser/codec-
      // dependent, which is why some cards showed a real frame and others
      // sat solid black with just the VIDEO badge. The explicit seek below
      // is the standard cross-browser fix: forcing currentTime to a hair
      // past 0 makes every browser decode and paint that one frame, same
      // lightweight cost either way.
      v.muted = true; v.preload = 'metadata';
      v.addEventListener('loadedmetadata', () => {
        try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch {}
      }, { once: true });
      v.dataset.src = item.url;
      lazyMediaObserver.observe(v);
      return v;
    }
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.dataset.src = item.url;
    lazyMediaObserver.observe(img);
    return img;
  }

  function buildMediaCard(item, { isRecent } = {}) {
    const card = document.createElement('button');
    card.className = 'media-card';
    card.appendChild(buildMediaThumb(item));
    if (item.kind === 'video') {
      const badge = document.createElement('span');
      badge.className = 'media-card-badge';
      badge.textContent = 'VIDEO';
      card.appendChild(badge);
    }
    // A "Recently Used" entry is a denormalized snapshot, not a live
    // listing — if the underlying file's been moved/deleted since, the
    // thumbnail just won't load. Self-heal instead of leaving a dead
    // tile around: drop it from the card, its recent entry, and re-check.
    if (isRecent) {
      card.querySelector('img,video')?.addEventListener('error', () => {
        let list = getRecents('media').filter(e => e.key !== item.url);
        try { localStorage.setItem(recentsStorageKey('media'), JSON.stringify(list)); } catch {}
        card.remove();
      });
    }
    const label = document.createElement('div');
    label.className = 'media-card-label';
    label.textContent = item.name;
    card.appendChild(label);
    card.title = `Send "${item.name}" to the media layer`;
    card.addEventListener('click', () => sendMediaItem(item));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // "Add to slide" lives in Theme Studio / Full-scale edit's own
      // "Library" button instead of here — switching to the Media tab
      // closes whichever slide editor was open first (showCenterView
      // deliberately "closes it out rather than leaving it showing
      // underneath"), so there's never a live slide context to add into
      // from this side.
      const currentFit = mediaFitPrefs.get(item.url) || 'contain';
      const sections = [[{
        label: 'Fit Mode',
        submenu: [['contain', 'Contain'], ['cover', 'Cover'], ['fill', 'Stretch']].map(([v, label]) => ({
          label, selected: currentFit === v, onClick: () => sendMediaItem(item, v),
        })),
      }]];
      openContextMenu(e.clientX, e.clientY, sections);
    });
    return card;
  }

  async function renderMediaGrid() {
    const grid = document.getElementById('media-grid');
    if (!grid) return;

    // First run: no smart folder linked yet. Lead with a create-a-folder
    // prompt rather than dropping the operator straight into the bin — a
    // smart folder (auto-synced with a real directory) is the intended way
    // to keep media, and "just drop files in the bin" buries that.
    if (!mediaFolders.length && activeMediaFolderId === null) {
      grid.innerHTML = '';
      const cta = document.createElement('div');
      cta.className = 'media-first-run';
      cta.innerHTML =
        '<div class="media-first-run-title">Choose a media folder</div>' +
        '<div class="media-first-run-body">Pick any folder on your computer (or make a new one). ' +
        'KAIRO keeps it in sync both ways — drop an image or video here and it lands in that folder; ' +
        'add or remove files in Finder and they show up here.</div>';
      const btn = document.createElement('button');
      btn.className = 'modal-btn primary';
      btn.style.cssText = 'margin-top:14px;justify-content:center;';
      btn.textContent = 'Choose folder…';
      btn.addEventListener('click', pickMediaFolder);
      cta.appendChild(btn);
      grid.appendChild(cta);
      return;
    }

    const items = await fetchActiveMediaItems();
    grid.innerHTML = '';

    // Recents only shown against the bin ("All Media") — a smart folder is
    // already a filtered view, and a recent pick made in a different
    // folder has no obvious place to point back to from inside this one.
    if (activeMediaFolderId === null) {
      const recents = getRecents('media').map(r => ({ name: r.name, kind: r.kind, url: r.url }));
      renderRecentsSection(grid, {
        items: recents,
        buildItem: (item) => buildMediaCard(item, { isRecent: true }),
        allLabel: 'All Media',
      });
    }

    if (!items.length) {
      grid.insertAdjacentHTML('beforeend', '<div class="svc-empty">Nothing here yet.<br>Drop an image or video, or use "+ Upload".</div>');
      return;
    }
    items.forEach(item => grid.appendChild(buildMediaCard(item)));
    if (items.truncated) {
      grid.insertAdjacentHTML('beforeend',
        `<div class="svc-empty" style="grid-column:1/-1">Showing the first ${items.length} files — ` +
        `this folder has more. Point KAIRO at a tighter folder for the full list.</div>`);
    }
  }

  // Per-item fit choice for the independent media output — ephemeral,
  // client-side only (bin/smart-folder items are just filesystem entries,
  // no metadata store to persist this in server-side). Remembered by
  // item.url for the rest of the session so a plain click after picking a
  // Fit Mode from the right-click menu keeps using it.
  const mediaFitPrefs = new Map();

  async function sendMediaItem(item, fit) {
    const resolvedFit = fit || mediaFitPrefs.get(item.url) || 'contain';
    if (fit) mediaFitPrefs.set(item.url, fit);
    try {
      await fetchWithTimeout(`${SERVER}/api/service/send-media`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: item.url, kind: item.kind, fit: resolvedFit }),
      });
    } catch (err) {
      if (typeof toast === 'function') toast('Send failed: ' + err.message, 'error');
      return;
    }
    pushRecent('media', item.url, { name: item.name, kind: item.kind, url: item.url });
    setMediaTransportVisible(item.kind === 'video');
  }

  // ── Upload / drag-drop (both land on the same endpoint the active folder
  // dictates — the bin if nothing's selected, otherwise straight into that
  // folder's real directory) ────────────────────────────────────────────
  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // Video uploads can be multi-hundred-MB, so this needs a much longer
  // timeout than the 15s default — long enough to not abort a legitimate
  // large upload, short enough to still eventually surface a truly stuck one.
  const MEDIA_UPLOAD_TIMEOUT_MS = 120_000;

  async function uploadMediaFiles(files) {
    const list = Array.from(files || []).filter(f => /^image\/|^video\//.test(f.type));
    if (!list.length) return;
    const url = activeMediaFolderId
      ? `${SERVER}/api/media/folders/${activeMediaFolderId}/upload`
      : `${SERVER}/api/media/bin/upload`;
    for (const file of list) {
      try {
        const dataBase64 = await fileToBase64(file);
        await fetchWithTimeout(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, dataBase64 }),
        }, MEDIA_UPLOAD_TIMEOUT_MS);
      } catch (err) {
        if (typeof toast === 'function') toast(`Upload failed (${file.name}): ${err.message}`, 'error');
      }
    }
    // The bin has no watcher pushing change events (only smart folders do,
    // since only those are real external directories) — refresh directly.
    if (!activeMediaFolderId) renderMediaGrid();
    refreshMediaBinIfVisible();
  }

  // ── Transport bar (mute/play/volume/seek) — remote-controls whatever the
  // display's media layer is currently showing; see display.html's
  // applyMediaControl/reportMediaStatus and server.js's ws relay. ─────────
  function setMediaTransportVisible(visible) {
    document.getElementById('media-transport')?.classList.toggle('hidden', !visible);
  }

  function mediaControl(action, value) {
    fetchWithTimeout(`${SERVER}/api/service/media-control`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, value }),
    }).catch(() => {});
  }

  function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // Called from app.js's WS switch (see window.KairoService.onMediaStatus)
  // whenever the display reports a timeupdate/play/pause/loadedmetadata —
  // or, now, whenever the media layer's content changes at all (see
  // display.html's renderMediaStage). `kind` says what's actually there:
  // once it's anything but 'video' (cleared, or overwritten by a scene's
  // own image — see renderTimerScene, which shares this same layer), the
  // transport bar has nothing left to control and must hide instead of
  // sitting there with a seek bar frozen at 0:00/0:00 looking broken.
  function onMediaStatus({ currentTime, duration, paused, kind }) {
    if (kind && kind !== 'video') { setMediaTransportVisible(false); return; }
    setMediaTransportVisible(true);
    const seek = document.getElementById('media-seek');
    const time = document.getElementById('media-time');
    const playIcon = document.getElementById('media-play-icon');
    if (seek && !mediaSeeking && duration > 0) {
      seek.value = String(Math.round((currentTime / duration) * 1000));
      seek.dataset.duration = String(duration);
    }
    if (time) time.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    if (playIcon) playIcon.innerHTML = paused
      ? '<polygon points="5 3 19 12 5 21 5 3"/>'
      : '<rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/>';
  }

  // Folder contents changed on disk (fs.watch) — refresh the Media tab grid
  // if it's the folder currently open, and the Media Bin unconditionally
  // (it aggregates every folder, so any folder's change is relevant to it)
  // whenever it's visible.
  function onMediaFolderChanged(folderId) {
    if (activeMediaFolderId === folderId) renderMediaGrid();
    refreshMediaBinIfVisible();
  }

  // ── Timer ──────────────────────────────────────────────────────────────
  // Named service-segment countdowns (Preservice/Worship/Sermon/...) —
  // each segment IS a stage-timer trigger under the hood (server/
  // segments.js layers ordering + a "one live at a time" rule on top of
  // the generic action/trigger framework in server/triggers.js). Cards
  // mirror the slide-thumbnail visual language (black 16:9 preview +
  // bottom-left label, see .ts-item-slide-thumb) so a segment reads as
  // "a layer" the same way a slide does, per this tab's whole reason for
  // existing: the output now composites slide/media/timer as real
  // independent layers, so each gets its own top-level tab and its own
  // Clear control (see clearOutputLayer('timer') in app.js).
  let segmentList = [];

  async function loadSegments() {
    try {
      const r = await fetchWithTimeout(`${SERVER}/api/segments`);
      const d = await r.json();
      segmentList = d.segments || [];
      // Every segment IS a timer item (see getTimerItem) — stamping this
      // here, not just lazily inside getTimerItem when Edit happens to be
      // opened, matters because loadSegments() itself runs again right
      // after every start/stop (see startSegmentNow), which used to wipe
      // out a .type set by an earlier getTimerItem call. themeForItem's
      // timer-specific fallback (resolving to 'timer-big' instead of
      // whatever verse/reference theme the output happens to be running)
      // depends on item.type === 'timer' being reliably true, not
      // something that silently reverts after the first start.
      segmentList.forEach(s => { s.type = 'timer'; s.title = s.name; });
    } catch (err) {
      console.warn('[Timer] Could not load segments:', err);
      if (typeof toast === 'function') toast('Could not reach Kairo server', 'error');
      segmentList = [];
    }
  }

  function showTimerLibrary() {
    showCenterView('timer');
    loadSegments().then(renderTimerGrid);
    syncClockToggle();
  }

  function statusLabel(status) {
    return status === 'live' ? 'Live' : status === 'done' ? 'Done' : 'Pending';
  }

  // Persists a segment's countdown target (mode/endAtTime/durationSec) —
  // used by the Timer section that now lives directly in Edit's item-mode
  // header (see renderItemTimerControls in app.js), same PUT the "Quick
  // edit" popover and its Set-end-time flow already use, so both surfaces
  // read/write the exact same underlying trigger params.
  async function updateSegmentParams(id, params) {
    await fetchWithTimeout(`${SERVER}/api/segments/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params }),
    });
  }

  // Persists a timer item's scenes (its slide storyboard — see
  // segments.js) — called from app.js whenever a slide's layers, duration,
  // name, order, or count changes. Also refreshes the Timer grid's
  // thumbnail and pushes a live update if this segment happens to be the
  // one currently running, same "don't make the operator stop/restart to
  // see it" rule everything else in Full-scale edit follows.
  // `resend: false` — writeItemSlideStyleFromSynthetic's scene branch (app.js)
  // saves via this same function but is itself immediately followed by
  // scheduleItemStyleAutosave's own resendLiveForSlideStyleEdit call; without
  // this flag a live-scene layer edit fired sendTimerSegment twice (150ms
  // apart), visibly flashing the output back to scene 0 an extra time.
  function saveTimerScenes(item, opts) {
    fetchWithTimeout(`${SERVER}/api/segments/${item.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes: item.scenes }),
    }).catch(() => {});
    renderTimerGrid();
    if (!opts || opts.resend !== false) setTimeout(() => resendLiveTimer(), 150);
  }

  // Adapts a fetched segment into the shape openItemStyleEditor/slidesFor/
  // themeForItem expect of a real item ({id, type, themeId, slideStyles,
  // title}) — a LIVE reference into segmentList, not a copy, so Full-scale
  // edit's in-place mutations (item.themeId = ...) land directly on the
  // object saveService's timer-redirect (above) later reads back out of.
  function getTimerItem(id) {
    const seg = segmentList.find(s => s.id === id);
    if (!seg) return null;
    seg.type = 'timer';
    seg.title = seg.name;
    if (seg.themeId === undefined) seg.themeId = null;
    if (seg.slideStyles === undefined) seg.slideStyles = {};
    return seg;
  }

  // Shared by the Start/Stop button and the thumbnail's double-click —
  // "double-click to activate" is the same action as the button, just a
  // second way to reach it, same as a slide's thumbnail-is-the-action
  // convention elsewhere in this file. If no end time has ever been set,
  // starting prompts for one on the spot instead of failing — the
  // thumbnail is deliberately down to just a Start button now (everything
  // else moved to right-click), so this is the one remaining path to set
  // a time at all.
  // toast() is a permanent no-op in Kairo, so a network failure on this
  // dblclick-direct path (no popover/inline-error surface to write into)
  // used to fail completely silently — briefly swap the card's own readout
  // text instead, the one piece of UI already sitting right where the
  // operator is looking. Truncated with the full message left in `title`
  // (hover tooltip) — the readout is a small mono-font strip sized for
  // "12:34"/"Ends 12:34", and a full server message like "That time has
  // already passed today — pick a later time" wrapped across two cramped
  // lines and blew past the card's edges when shown verbatim.
  function flashCardError(seg, msg) {
    const readoutEl = document.getElementById(`timer-readout-${seg.id}`);
    if (!readoutEl) return;
    const prev = readoutEl.textContent;
    const short = msg.length > 22 ? msg.slice(0, 21) + '…' : msg;
    readoutEl.textContent = short;
    readoutEl.title = msg;
    readoutEl.style.color = '#e8404a';
    setTimeout(() => {
      if (readoutEl.textContent === short) { readoutEl.textContent = prev; readoutEl.removeAttribute('title'); readoutEl.style.color = ''; }
    }, 2500);
  }

  async function toggleSegment(seg, anchorEl) {
    try {
      if (seg.status === 'live') {
        await fetchWithTimeout(`${SERVER}/api/segments/${seg.id}/stop`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markDone: true }),
        });
        await loadSegments(); renderTimerGrid();
        return;
      }
      const p = seg.trigger?.params || {};
      const hasTarget = p.mode === 'duration' ? Number(p.durationSec) > 0 : !!p.endAtTime;
      if (!hasTarget) {
        openSegmentTimePopover(anchorEl, seg, { autoStart: true });
        return;
      }
      // This path used to ignore startSegmentNow's return value entirely —
      // a rejection (e.g. an end time left over from earlier that's now in
      // the past) meant a dblclick that visibly did nothing, no different
      // from the toast()-swallowed silent failure below.
      const result = await startSegmentNow(seg);
      if (!result.ok) flashCardError(seg, result.error || 'Could not start');
    } catch (e) {
      flashCardError(seg, 'Could not reach server');
    }
  }

  // The one place a segment actually gets fired, called from BOTH
  // toggleSegment's direct path (a time was already set) and
  // openSegmentTimePopover's "Set & Start" path (the auto-prompt when it
  // wasn't) — those used to duplicate this logic independently, which is
  // exactly how the slide-layer send below went missing from one of the
  // two paths and sat untested until a real end-to-end check caught it.
  // Returns {ok, error} rather than a bare boolean — the actual reason
  // (from server/triggers.js's validate(), e.g. "That time has already
  // passed today") used to only reach toast(), a permanent no-op in this
  // codebase, so every caller saw a bare failure with the real message
  // thrown away and had to fall back to a made-up generic string instead.
  async function startSegmentNow(seg) {
    const r = await fetchWithTimeout(`${SERVER}/api/segments/${seg.id}/start`, { method: 'POST' });
    const j = await r.json();
    if (j.error) return { ok: false, error: j.error };
    // The themed countdown goes to its OWN layer (#timer-layer), not the
    // slide layer — whatever scripture/lyrics are on screen stay put, and
    // Clear Timer removes just this. themeForItem's timer branch resolves a
    // countdown-shaped look even for an un-customised segment.
    await sendTimerSegment(seg);
    await loadSegments(); renderTimerGrid();
    return { ok: true };
  }

  // Paints the segment's timer theme onto the independent timer layer once,
  // at Start. The per-second value then arrives via the stage-timer 'action'
  // broadcast (display.html's handleActionBadge writes into
  // [data-binding="timer"], which lives in that layer).
  async function sendTimerSegment(seg) {
    const p = seg.trigger?.params || {};
    // Fold this segment's warning/overtime colour choices onto every
    // Countdown-bound text layer so the output recolours through them as
    // the countdown runs down — every scene's own timer layer, not just
    // the single-theme case's one.
    const foldWarnColors = (layers) => {
      const tl = (layers || []).find(l => l.binding === 'timer');
      if (tl) {
        if (p.warnColor) tl.warnColor = p.warnColor;
        if (p.overtimeColor) tl.overtimeColor = p.overtimeColor;
      }
    };
    // Scenes (a storyboard — see segments.js) take over entirely when
    // present; themeId/slideStyles stay exactly as they always were for
    // the plain single-theme case, which is still how most segments work.
    const scenes = (seg.scenes && seg.scenes.length)
      ? JSON.parse(JSON.stringify(seg.scenes))
      : null;
    let look = null;
    if (scenes) {
      scenes.forEach(sc => foldWarnColors(sc.layers));
    } else {
      const base = themeForItem(seg);
      if (!base) return;
      look = JSON.parse(JSON.stringify(base));
      foldWarnColors(look.layers);
    }
    try {
      await fetchWithTimeout(`${SERVER}/api/service/send-timer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          look,
          scenes,
          style: seg.slideStyles?.[0] || {},
          label: seg.name || 'Timer',
          timerText: '0:00',
        }),
      });
    } catch (err) {
      if (typeof toast === 'function') toast('Could not send timer to output: ' + err.message, 'error');
    }
  }

  // resolveFlexibleTime — "Ends at" used to require strict 24-hour HH:MM;
  // see src/layer_geometry.js for the shared, relaxed parser (loaded via
  // index.html before this script; resolved via normal scope lookup out
  // of this file's enclosing IIFE). Was a byte-identical copy-paste shared
  // with app.js's own Quick-edit popover.

  // Set (or change) a segment's end time — the only control that used to
  // live directly on the card face and now lives behind right-click /
  // the auto-prompt in toggleSegment above.
  function openSegmentTimePopover(anchor, seg, { autoStart } = {}) {
    if (typeof openPopover !== 'function' || !anchor) return;
    openPopover(anchor, (pop) => {
      const params = seg.trigger?.params || {};
      // Two ways to set the target, chosen with the chips below:
      //  • "Ends at" — a clock time (HH:MM). Matches how a service is
      //    planned ("done by 11:45") but is rejected the moment that time
      //    already reads as past — an evening rehearsal, a quick 5-min
      //    test — which came across as "can't set the time" with no way
      //    through.
      //  • "Run for" — a length in minutes, resolved against the clock at
      //    Start (server/triggers.js resolveEndAt, mode:'duration'). Always
      //    takes, so it's the one that unblocks a fast test.
      let mode = params.mode === 'duration' ? 'duration' : 'endAt';

      const hint = document.createElement('div');
      hint.className = 'svc-popover-hint';
      hint.textContent = seg.name;
      pop.appendChild(hint);

      // makeChips is a top-level fn in app.js — both scripts share the page,
      // and this handler only runs on user interaction, long after parse.
      pop.appendChild(makeChips([
        { label: 'Ends at',  value: 'endAt' },
        { label: 'Run for',  value: 'duration' },
      ], mode, (v) => { mode = v; renderField(); }));

      const fieldWrap = document.createElement('div');
      fieldWrap.style.marginTop = '6px';
      pop.appendChild(fieldWrap);

      const err = document.createElement('div');
      err.style.cssText = 'color:var(--red);font-size:11px;margin-top:6px;display:none;';
      pop.appendChild(err);
      const showErr = (msg) => { err.textContent = msg; err.style.display = ''; };

      const submitBtn = document.createElement('button');
      submitBtn.className = 'modal-btn primary';
      submitBtn.style.cssText = 'width:100%;justify-content:center;margin-top:8px;';
      submitBtn.textContent = autoStart ? 'Set & Start' : 'Set time';
      pop.appendChild(submitBtn);

      // Set by renderField() to a fn returning the {params} to PUT, or null
      // after calling showErr() — keeps validation next to the field it
      // belongs to as the mode flips.
      let readParams = () => null;

      function renderField() {
        fieldWrap.innerHTML = '';
        err.style.display = 'none';
        // A plain text input, never <input type="time"/"number"> — WebKit in
        // Tauri's webview can report an empty .value for a filled-looking
        // native time control until every sub-field is confirmed, which
        // silently defeated this popover on a real launch once. Our own
        // formatting/validation sidesteps the whole class of bug.
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'numeric';
        inp.className = 'setting-input';
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitBtn.click(); });

        if (mode === 'duration') {
          inp.placeholder = 'Minutes';
          inp.maxLength = 4;
          inp.value = params.durationSec ? String(Math.round(params.durationSec / 60)) : '';
          inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); });
          readParams = () => {
            const n = parseInt(inp.value, 10);
            if (!(n > 0)) { showErr('Enter a number of minutes, e.g. 15'); return null; }
            return { mode: 'duration', durationSec: n * 60 };
          };
        } else {
          inp.placeholder = 'HH:MM or H:MM AM/PM';
          inp.maxLength = 8;
          inp.value = params.endAtTime || '';
          inp.addEventListener('input', () => {
            // Only auto-format (digits-only, auto-insert the colon) while
            // it's STILL plain digits — the moment a space or an am/pm
            // letter shows up, leave the rest of what's typed alone rather
            // than fight a digit-only formatter that has no idea what to
            // do with letters.
            if (/^[0-9:]*$/.test(inp.value)) {
              const d = inp.value.replace(/\D/g, '').slice(0, 4);
              inp.value = d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d;
            }
          });
          readParams = () => {
            const resolved = resolveFlexibleTime(inp.value);
            if (!resolved) { showErr('Enter a valid time, e.g. 19:30 or 7:30 PM'); return null; }
            return { mode: 'endAt', endAtTime: resolved };
          };
        }
        fieldWrap.appendChild(inp);
        requestAnimationFrame(() => inp.focus());
      }
      renderField();

      submitBtn.addEventListener('click', async () => {
        const p = readParams();
        if (!p) return;
        submitBtn.disabled = true;
        try {
          await fetchWithTimeout(`${SERVER}/api/segments/${seg.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params: p }),
          });
          // Mirror onto the in-memory seg so startSegmentNow (which fires a
          // bare POST /start with no body) validates against the value we
          // just saved, not a stale one.
          seg.trigger = seg.trigger || {};
          seg.trigger.params = { ...seg.trigger.params, ...p };
          if (autoStart) {
            const result = await startSegmentNow(seg);
            if (!result.ok) { showErr(result.error || 'Could not start'); submitBtn.disabled = false; return; }
          }
          closePopover();
          await loadSegments(); renderTimerGrid();
        } catch (e) {
          // A network/timeout failure here used to reject silently (an
          // unhandled promise rejection with no visible trace) — the same
          // "the button just does nothing" symptom, from a different cause.
          showErr('Could not reach the server — ' + (e?.message || 'try again'));
          submitBtn.disabled = false;
        }
      });
    });
  }

  // Rename-in-place — a real prompt()/confirm() isn't reliable inside the
  // Tauri webview (same reason confirmDialog exists for confirms), so
  // this swaps the label for a text input rather than using one.
  function startSegmentRename(label, seg) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = seg.name;
    input.className = 'timer-card-rename-input';
    input.style.cssText = 'width:90%;font-size:12px;font-weight:700;background:var(--bg-input);border:1px solid var(--blue);border-radius:4px;padding:1px 4px;color:var(--text);';
    const commit = async () => {
      const name = input.value.trim() || seg.name;
      await fetchWithTimeout(`${SERVER}/api/segments/${seg.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      });
      await loadSegments(); renderTimerGrid();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = seg.name; input.blur(); }
    });
    input.addEventListener('blur', commit, { once: true });
    label.replaceWith(input);
    input.focus(); input.select();
  }

  // The card is just the thumbnail — double-click is the action (same "the
  // thumbnail IS the button" cue as a Slides card), so a separate Start/Stop
  // button underneath was one more thing on the face for no real gain.
  // Everything else (quick-edit the time, rename, full edit, duplicate,
  // delete) lives behind right-click.
  function buildSegmentCard(seg) {
    const card = document.createElement('div');
    card.className = 'timer-card' + (seg.status === 'live' ? ' is-live' : seg.status === 'done' ? ' is-done' : '');

    const preview = document.createElement('div');
    preview.className = 'timer-card-preview' + (seg.status !== 'live' ? ' is-pending' : '');
    preview.id = `timer-preview-${seg.id}`;
    preview.title = (seg.status === 'live' ? 'Double-click to stop' : 'Double-click to start') + ' · right-click for more';

    // The card used to be a plain black box regardless of what theme/
    // background media the segment actually carries — same idea as
    // Slides' own slide thumbnails (paintLookLayers), just painted behind
    // the status/readout/label overlays below instead of standing alone.
    const bg = document.createElement('div');
    bg.className = 'timer-card-bg';
    preview.appendChild(bg);
    // Scenes (a storyboard, see segments.js) replace the single-theme case
    // entirely — the thumbnail shows scene 0's own frame instead of
    // whatever themeForItem would otherwise fall back to (there's no real
    // themeId to resolve once a segment has scenes).
    const theme = (seg.scenes && seg.scenes.length) ? { layers: seg.scenes[0].layers || [] } : themeForItem(seg);
    if (theme) paintLookLayers(bg, theme, seg.slideStyles?.[0] || {}, { timerText: '' });

    const status = document.createElement('span');
    status.className = 'timer-card-status' + (seg.status === 'live' ? ' is-live' : '');
    status.textContent = statusLabel(seg.status);
    preview.appendChild(status);

    const readout = document.createElement('div');
    readout.className = 'timer-card-readout';
    readout.id = `timer-readout-${seg.id}`;
    readout.textContent = seg.status === 'live'
      ? '…'
      : (() => {
          const p = seg.trigger?.params || {};
          if (p.mode === 'duration' && Number(p.durationSec) > 0) return `${Math.round(p.durationSec / 60)} min`;
          if (p.endAtTime) return `Ends ${p.endAtTime}`;
          return 'No time set';
        })();
    preview.appendChild(readout);

    const label = document.createElement('div');
    label.className = 'timer-card-label';
    label.textContent = seg.name;
    preview.appendChild(label);

    preview.addEventListener('dblclick', () => toggleSegment(seg, preview));
    preview.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, [
        [
          // "Quick edit" (just the end time — the one thing you'd touch
          // between services) vs. "Edit" (the real Full-scale/Theme Studio
          // editor for font, color, position, background media, etc.) —
          // matches the "quick" vs. "full" framing the rest of the Timer UI
          // uses rather than a raw "Set end time…" verb.
          { label: 'Quick edit', onClick: () => openSegmentTimePopover(preview, seg) },
          { label: 'Rename', onClick: () => startSegmentRename(label, seg) },
          { label: 'Edit', onClick: () => window.KairoItemStyleEditor?.open?.(seg.id, 0) },
          { label: 'Duplicate', onClick: () => duplicateSegment(seg) },
        ],
        [{ label: 'Delete', danger: true, onClick: () => {
          confirmDeletePopover(preview, `Delete "${seg.name}"?`, async () => {
            await fetchWithTimeout(`${SERVER}/api/segments/${seg.id}`, { method: 'DELETE' });
            await loadSegments(); renderTimerGrid();
          });
        } }],
      ]);
    });
    card.appendChild(preview);

    return card;
  }

  // "Preset timers, but the user can copy or make more" — the seeded
  // defaults (Preservice/Prayer/Worship/…) stay fixed and fully editable in
  // place, but if an operator needs a second one (two prayer slots in one
  // service, say) this clones the theme/styling/time instead of starting
  // from '+ Add Segment's blank slate. Live/done status is intentionally
  // NOT copied — a duplicate always starts pending, even if the original
  // is currently running.
  async function duplicateSegment(seg) {
    const r = await fetchWithTimeout(`${SERVER}/api/segments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${seg.name} copy`, themeId: seg.themeId, slideStyles: seg.slideStyles }),
    });
    const j = await r.json();
    const newSeg = j.segment;
    if (newSeg && seg.trigger?.params && Object.keys(seg.trigger.params).length) {
      await fetchWithTimeout(`${SERVER}/api/segments/${newSeg.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params: seg.trigger.params }),
      });
    }
    await loadSegments(); renderTimerGrid();
  }

  // Reordering isn't exposed in the card UI right now (kept intentionally
  // minimal — see toggleSegment above) but the backend route
  // (/api/segments/reorder, server/segments.js) is still there if a
  // drag-to-reorder UI gets added later.

  function renderTimerGrid() {
    const grid = document.getElementById('timer-grid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!segmentList.length) {
      grid.innerHTML = '<div class="svc-empty">No segments yet. Use "+ Add Segment" above.</div>';
      return;
    }
    segmentList.slice().sort((a, b) => a.order - b.order).forEach(seg => grid.appendChild(buildSegmentCard(seg)));
  }

  document.getElementById('segment-add-btn')?.addEventListener('click', async () => {
    await fetchWithTimeout(`${SERVER}/api/segments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New Segment' }),
    });
    await loadSegments(); renderTimerGrid();
  });

  // ── Live clock toggle ────────────────────────────────────────────────
  // Independent of any segment — the clock has its own badge on the
  // output (#clock-badge in display.html) and can be on at the same time
  // as a segment's countdown.
  let clockTriggerId = null;
  async function ensureClockTrigger() {
    if (clockTriggerId) return clockTriggerId;
    const r = await fetchWithTimeout(`${SERVER}/api/triggers`);
    const j = await r.json();
    let clock = (j.triggers || []).find(t => t.typeId === 'clock-message');
    if (!clock) {
      const r2 = await fetchWithTimeout(`${SERVER}/api/triggers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typeId: 'clock-message', label: 'System Clock' }),
      });
      clock = (await r2.json()).trigger;
    }
    clockTriggerId = clock?.id || null;
    return clockTriggerId;
  }
  async function syncClockToggle() {
    const toggle = document.getElementById('clock-toggle');
    if (!toggle) return;
    // Live clock is ON by default — only off if the operator explicitly
    // turned it off before (persisted). A server restart drops the trigger's
    // interval, so re-fire it here on load whenever it should be showing.
    let pref = '1';
    try { pref = localStorage.getItem('kairo-live-clock') ?? '1'; } catch {}
    const on = pref === '1';
    toggle.checked = on;
    try {
      const id = await ensureClockTrigger();
      if (id && on) await fetchWithTimeout(`${SERVER}/api/triggers/${id}/fire`, { method: 'POST' });
    } catch {}
  }
  document.getElementById('clock-toggle')?.addEventListener('change', async (e) => {
    try { localStorage.setItem('kairo-live-clock', e.target.checked ? '1' : '0'); } catch {}
    const id = await ensureClockTrigger();
    if (!id) return;
    try {
      await fetchWithTimeout(`${SERVER}/api/triggers/${id}/${e.target.checked ? 'fire' : 'stop'}`, { method: 'POST' });
    } catch (err) {
      if (typeof toast === 'function') toast('Clock toggle failed: ' + err.message, 'error');
    }
  });

  // Called from app.js's WS switch via window.KairoService.onTimerAction/
  // onClockAction (see registerActionHandler wiring in app.js) — updates
  // just the live card's readout in place rather than re-fetching and
  // re-rendering the whole grid every second.
  function onTimerAction(msg) {
    const { remainingMs, cleared, totalMs } = msg.payload || {};

    // Tick the Monitoring panel's timer layer regardless of which view the
    // operator is on — segmentList is only loaded when the Timer view has
    // been opened, but the countdown must keep updating everywhere.
    if (!cleared) {
      const ot = remainingMs < 0, wn = !ot && remainingMs <= 60000;
      const f = (ot ? '+' : '') + formatTime(Math.abs(remainingMs) / 1000);
      document.querySelectorAll('#slide-preview-timer [data-binding="timer"]').forEach(el => {
        el.textContent = f;
        el.classList.toggle('is-overtime', ot);
        el.classList.toggle('is-warning', wn);
        const base = el.dataset.baseColor;
        if (base) el.style.color = ot ? (el.dataset.overtimeColor || '#e8404a')
          : wn ? (el.dataset.warnColor || '#e8a64a') : base;
      });
      // Individual hour/minute/second parts — same idea as display.html's
      // timeParts, mirrored here so this preview keeps pace with the real
      // output instead of sitting frozen on its initial "00" placeholder.
      const absSec = Math.max(0, Math.ceil(Math.abs(remainingMs) / 1000));
      const parts = {
        h: String(Math.floor(absSec / 3600)).padStart(2, '0'),
        m: String(Math.floor((absSec % 3600) / 60)).padStart(2, '0'),
        s: String(absSec % 60).padStart(2, '0'),
      };
      ['h', 'm', 's'].forEach(k => {
        document.querySelectorAll(`#slide-preview-timer [data-binding="timer-${k}"]`).forEach(el => {
          el.textContent = parts[k];
          el.classList.toggle('is-overtime', ot);
          el.classList.toggle('is-warning', wn);
          const base = el.dataset.baseColor;
          if (base) el.style.color = ot ? (el.dataset.overtimeColor || '#e8404a')
            : wn ? (el.dataset.warnColor || '#e8a64a') : base;
        });
      });
      // "{timer}" inline-copy substitution — same idea as display.html's
      // own [data-timer-template] tick loop, so the operator's own preview
      // shows the live sentence too, not just the real output.
      document.querySelectorAll('#slide-preview-timer [data-timer-template]').forEach(el => {
        el.textContent = el.dataset.timerTemplate.replace('{timer}', f);
      });
      // Scene switch — see previewTimerScenes' own comment above. Runs
      // even past zero (no !overtime guard, unlike the real output's own
      // whole-countdown Image Cycle spacing) since a segment stays live
      // and counting up in overtime rather than ending outright, and the
      // last scene should still be the one showing throughout that.
      if (previewTimerScenes && previewTimerScenes.length && typeof totalMs === 'number' && totalMs > 0) {
        const elapsed = Math.max(0, totalMs - remainingMs);
        const { index } = previewActiveSceneForElapsed(elapsed);
        if (index !== previewActiveSceneIndex) {
          previewActiveSceneIndex = index;
          const host = document.getElementById('slide-preview-timer');
          const scene = previewTimerScenes[index];
          if (host && scene) {
            paintLookLayers(host, { layers: scene.layers || [] }, {}, { timerText: f });
          }
        }
      }
    } else {
      onTimerSlide({ clear: true });
    }

    const seg = segmentList.find(s => s.triggerId === msg.triggerId);
    if (!seg) return;
    const readoutEl = document.getElementById(`timer-readout-${seg.id}`);
    const previewEl = document.getElementById(`timer-preview-${seg.id}`);
    if (cleared) {
      // An explicit stop (Stop button, Clear Timer, or another segment
      // starting) — reconcile segments.js's stored status so it doesn't
      // stay stuck on "live" with nothing actually counting anymore.
      // Reaching zero on its own no longer counts as "cleared" — the
      // timer runs into overtime instead of ending, so only a real stop
      // reconciles status now.
      if (seg.status === 'live') {
        fetchWithTimeout(`${SERVER}/api/segments/${seg.id}/stop`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markDone: true }),
        }).then(() => loadSegments()).then(renderTimerGrid).catch(() => {});
      }
      // Belt-and-suspenders: also tell the real output to drop the timer
      // layer, in case this 'cleared' came from the segment itself rather
      // than a Clear-Timer press (which the server already routes).
      fetchWithTimeout(`${SERVER}/api/service/send-timer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }),
      }).catch(() => {});
      return;
    }
    const overtime = remainingMs < 0;
    const warning = !overtime && remainingMs <= 60000;
    previewEl?.classList.toggle('is-overtime', overtime);
    previewEl?.classList.toggle('is-warning', warning);
    if (readoutEl) readoutEl.textContent = (overtime ? '+' : '') + formatTime(Math.abs(remainingMs) / 1000);
  }

  // Scenes (segment.scenes — a storyboard, see segments.js) live-switch in
  // this preview too, not just the real output (display.html) — a scene
  // change is a completely different slide, not a minor background
  // variation, so the operator needs to actually see the show progress in
  // their own monitor to know it's working, not just trust that it's
  // happening somewhere else. Mirrors display.html's timerScenes/
  // activeSceneIndex/activeSceneForElapsed exactly.
  let previewTimerScenes = null;
  let previewActiveSceneIndex = -1;
  function previewActiveSceneForElapsed(elapsedMs) {
    if (!previewTimerScenes || !previewTimerScenes.length) return { index: 0, sceneElapsedMs: elapsedMs };
    let cum = 0;
    for (let i = 0; i < previewTimerScenes.length; i++) {
      const durMs = Math.max(0, Number(previewTimerScenes[i].durationSec) || 0) * 1000;
      if (i === previewTimerScenes.length - 1 || elapsedMs < cum + durMs) {
        return { index: i, sceneElapsedMs: Math.max(0, elapsedMs - cum) };
      }
      cum += durMs;
    }
    return { index: previewTimerScenes.length - 1, sceneElapsedMs: 0 };
  }

  // A segment went live (or was cleared) — render its full theme into the
  // Monitoring panel's timer layer, exactly as the real output does.
  function onTimerSlide(msg) {
    const host = document.getElementById('slide-preview-timer');
    if (!host) return;
    const plain = document.querySelector('#slide-preview .live-screen-inner');
    const themed = document.getElementById('slide-preview-themed');
    const media = document.getElementById('slide-preview-media');
    previewTimerScenes = msg.scenes && msg.scenes.length ? msg.scenes : null;
    previewActiveSceneIndex = 0;
    const look = msg.look || (msg.scenes && msg.scenes[0] ? { layers: msg.scenes[0].layers || [] } : null);
    if (msg.clear || !look) {
      previewTimerScenes = null;
      previewActiveSceneIndex = -1;
      host.innerHTML = '';
      host.classList.add('hidden');
      // Bring back whatever the slide layer was showing under the timer.
      const somethingElse = (themed && !themed.classList.contains('hidden'))
        || (media && !media.classList.contains('hidden'));
      if (!somethingElse) plain?.classList.remove('hidden');
      return;
    }
    host.innerHTML = '';
    host.classList.remove('hidden');
    // A themed timer with a solid background reads as "on screen" — don't
    // let the "Nothing on display" placeholder show through beneath it.
    plain?.classList.add('hidden');
    paintLookLayers(host, look, msg.style || {}, {
      verseText: '', referenceText: '', translatedText: '', timerText: msg.timerText || '0:00',
    });
  }
  function onClockAction() { /* clock has no in-tab readout to update yet — the output badge is the source of truth */ }

  // ── Import (file / clipboard / paste-textarea fallback) ──────────────────
  // Default representation is 'slides' (one imported block = one fixed slide);
  // openAddConfirm's delimiter choice may rebuild this as a chunked 'song'
  // instead — the raw {label, lines} blocks travel alongside for that.
  function toBlocksItem(blocks, title) {
    return {
      id: uid('slides'), type: 'slides', title: title || 'Imported slides',
      // A block carrying `.layers` is a real ProPresenter scene (position/
      // font/color/images preserved as-authored — see slide_import.js's
      // decodeCueSceneLayers and slidesFor's 'slides' branch). This used to
      // fall through to the plain-text branch below, silently discarding
      // every bit of that real layout the moment the raw import result
      // became an actual playlist item — the one place all of it needs to
      // survive into. A pure-image block (no lines, no layers) from an
      // older-format ProPresenter import carries its own `image` — kept as
      // an image-only block rather than forced into a text slide.
      blocks: blocks.map(b => b.layers
        ? { label: b.label, layers: b.layers, canvasSize: b.canvasSize, text: b.text || '' }
        : b.image
        ? { label: b.label, image: b.image }
        : { label: b.label, text: (b.lines || []).join('\n') }),
    };
  }

  // Song Library records always store {label, lines} blocks — every
  // consumer (slidesFor's 'song' case, the hymn-bank "Add to playlist"
  // flow) reads .lines, never .text. A Paragraph-mode import build
  // {label, text} blocks instead (see confirmAddConfirm's n===0 branch) —
  // the shape a 'slides'-type PLAYLIST item needs there, where slidesFor's
  // 'slides' case reads .text correctly. Library records are never
  // 'slides'-type, so that shape gets normalized right here, at the one
  // place it's actually persisted, rather than threading a destination-
  // aware branch back into confirmAddConfirm's delimiter logic (which
  // still has to produce {label,text} for the playlist-destination case).
  function toLibraryBlocks(blocks) {
    return (blocks || []).map(b => b.image
      ? { label: b.label, image: b.image }
      : { label: b.label, lines: b.lines || (b.text ? b.text.split('\n') : []) });
  }

  async function importArrayBufferAsFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const r = await fetchWithTimeout(`${SERVER}/api/service/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, dataBase64: btoa(bin) }),
    }, MEDIA_UPLOAD_TIMEOUT_MS);
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'import failed');
    return d;
  }

  async function importTextViaServer(text) {
    const r = await fetchWithTimeout(`${SERVER}/api/service/import`, {
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
  // ProPresenter source files arrive already segmented into slides by
  // whoever built them there — re-chunking by line count would undo that
  // work, so these default the delimiter to "keep as-is" (0) instead of the
  // plain-text default. Freeform text/.docx/.pptx has no such boundaries to
  // preserve, so it keeps defaulting to DEFAULT_LINES_PER_SLIDE.
  function beginImportResult(d, fallbackTitle, opts = {}) {
    const destination = opts.destination || 'playlist';
    const keepAsIs = /^pro/.test(d.format || '');
    if (d.items && d.items.length) {
      const [first, ...rest] = d.items;
      pendingExtraBlockItems = rest;
      openAddConfirm(toBlocksItem(first.blocks, first.name || fallbackTitle), { showDelimiter: true, isImportBlocks: true, rawBlocks: first.blocks, defaultKeepAsIs: keepAsIs, destination });
    } else {
      openAddConfirm(toBlocksItem(d.blocks, fallbackTitle), { showDelimiter: true, isImportBlocks: true, rawBlocks: d.blocks, defaultKeepAsIs: keepAsIs, destination });
    }
  }

  // Direct path from the add-menu: pick a file, import, add as a section —
  // no confirmation dialog beyond the shared Add-to-playlist/Song-Library
  // step, since a folder should be quick to fill. `destination` ('playlist'
  // or 'library') is the one thing that varies between the Slides add-menu
  // and the Songs tab's own "+ Import Song" — see openSongImportPopover.
  async function quickImportFile(file, destination = 'playlist') {
    try {
      const d = await importArrayBufferAsFile(file);
      beginImportResult(d, file.name.replace(/\.[^.]+$/, ''), { destination });
    } catch (err) {
      // toast() is a deliberate no-op in this app (see its own comment in
      // app.js) — this used to call it anyway, so a failed quick-import
      // (a real incident: a .proplaylist that failed to parse) produced
      // literally no feedback at all, not even a console trace a user
      // would think to check. Reuse the SAME inline-error surface the
      // dialog-based import path already has (#import-status inside
      // #import-modal) rather than inventing a new one — open that dialog
      // straight into its error state so the failure is visible exactly
      // where every other import failure already shows up.
      openImport({ destination });
      const st = document.getElementById('import-status');
      if (st) st.textContent = err.message;
    }
  }

  // Reads the OS clipboard directly — window.__TAURI__.clipboardManager
  // (tauri-plugin-clipboard-manager, see its own Cargo.toml/lib.rs comment)
  // when running as the real app, since a Tauri webview never grants the
  // plain web Clipboard API used below without it; navigator.clipboard is
  // kept only as a fallback for the rare case this runs outside Tauri.
  async function readClipboardText() {
    if (window.__TAURI__?.clipboardManager?.readText) {
      return await window.__TAURI__.clipboardManager.readText();
    }
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
    throw new Error('clipboard unavailable');
  }

  async function quickImportClipboard(destination = 'playlist') {
    try {
      const text = await readClipboardText();
      if (!text || !text.trim()) throw new Error('Clipboard is empty');
      const d = await importTextViaServer(text);
      // Routed through the same beginImportResult every other import path
      // uses (not a direct openAddConfirm call) — keeps ProPresenter-style
      // "keep as-is" defaulting and multi-item (.proplaylist) handling
      // consistent regardless of which of the three entry points (quick
      // file, quick clipboard, or the paste-dialog fallback) was used.
      beginImportResult(d, 'Pasted content', { destination });
    } catch (err) {
      // Permission denied or nothing to read — fall back to the paste dialog.
      openImport({ destination });
    }
  }

  // Fallback dialog (manual paste when clipboard read is blocked) — also
  // reused as-is by the Songs tab's "+ Import Song" button, just tagged with
  // a different destination so confirmImport() routes the result into the
  // Song Library instead of a playlist.
  let importPending = null;
  let importDestination = 'playlist';
  // Bumped every time the dialog opens (fresh or reopened for a different
  // destination) — importFileIntoDialog captures this before its async parse
  // and checks it again on resolve, so a slow parse from a cancelled/
  // superseded dialog session can't land in a LATER session's importPending
  // (and get imported to whatever destination that later session was for).
  let importGeneration = 0;
  function openImport(opts = {}) {
    importGeneration++;
    importPending = null;
    importDestination = opts.destination || 'playlist';
    const ta = document.getElementById('import-text');
    const st = document.getElementById('import-status');
    if (ta) ta.value = '';
    if (st) st.textContent = '';
    // Same modal either way (see this section's own header comment) — just
    // relabeled so a Songs-tab operator isn't told they're "Import slides"-
    // ing into a heading/button that never mentions songs.
    const heading = document.getElementById('import-heading');
    if (heading) heading.textContent = importDestination === 'library' ? 'Import song' : 'Import slides';
    const confirmBtn = document.getElementById('import-confirm');
    if (confirmBtn) confirmBtn.textContent = importDestination === 'library' ? 'Add song' : 'Add slides';
    document.getElementById('import-modal')?.classList.remove('hidden');
    ta?.focus();
  }
  function closeImport() { document.getElementById('import-modal')?.classList.add('hidden'); }

  async function importFileIntoDialog(file) {
    const myGeneration = importGeneration;
    const st = document.getElementById('import-status');
    if (st) st.textContent = `Reading ${file.name}…`;
    try {
      const d = await importArrayBufferAsFile(file);
      // The dialog was closed and reopened (fresh or for a different
      // destination) while this parse was in flight — that session's own
      // openImport() already reset importPending; don't resurrect this
      // stale result over it.
      if (myGeneration !== importGeneration) return;
      importPending = d;
      const count = d.items ? d.items.length : d.blocks.length;
      const label = d.items ? `presentation${count === 1 ? '' : 's'}` : `slide${count === 1 ? '' : 's'}`;
      if (st) st.textContent = `${count} ${label} found in ${file.name}${d.note ? ` (${d.note})` : ''} — press “Add slides”.`;
    } catch (err) {
      if (myGeneration !== importGeneration) return;
      importPending = null;
      if (st) st.textContent = err.message;
    }
  }

  async function confirmImport() {
    const ta = document.getElementById('import-text');
    const st = document.getElementById('import-status');
    let d = importPending;
    if (!d && ta && ta.value.trim()) {
      try { d = await importTextViaServer(ta.value); }
      // Same dead-toast bug as quickImportFile's own comment — the dialog
      // is already open right here, #import-status is right there. No
      // reason this path alone should still funnel through a no-op.
      catch (err) { if (st) st.textContent = err.message; return; }
    }
    const hasContent = d && ((d.items && d.items.length) || (d.blocks && d.blocks.length));
    if (!hasContent) {
      if (st) st.textContent = 'Nothing to import';
      return;
    }
    closeImport();
    beginImportResult(d, 'Pasted content', { destination: importDestination });
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
    if (slider && Number(slider.value) !== size) slider.value = size;
    // paintLookLayers bakes its scale calc into fixed pixel values at paint
    // time — it doesn't stay relative to --svc-card afterward. Without this,
    // dragging the slider resized every card's box but left already-painted
    // thumbnail text at whatever size it was first painted at, so text and
    // card size drifted out of sync instead of the text scaling WITH the
    // slider like the rest of the thumbnail. Repainting here (not just after
    // a fresh renderStack rebuild) is what makes that live.
    repaintSlidePreviews();
  }

  // Actually invokes paintLookLayers for every thumbnail slideCard tagged
  // with pending paint info (see its own comment) — split out from
  // renderStack so applyView can also call it live when the size slider or
  // Grid/List toggle changes, not just once per full rebuild.
  //
  // ROOT CAUSE of the top-bar-disappearing bug (see the diagnostic block in
  // app.js and the .top-bar comment in styles.css): this used to call the
  // FULL renderStack() here once a translation resolved. A playlist whose
  // many slides all need a first-time translation gets that many separate
  // async completions, each firing independently — and renderStack() tears
  // down and rebuilds the ENTIRE stack (every expanded card, every slide)
  // just to update the one thumbnail whose translation actually arrived.
  // With 181 slides open, real logs showed 40+ full rebuilds in under two
  // seconds, ~100-160ms of blocking main-thread work each, back-to-back —
  // long enough to starve the compositor and leave .top-bar's GPU layer
  // stuck mid-paint. repaintSlidePreviews() re-paints every existing
  // thumbnail in place (no teardown/rebuild) and is what applyView() already
  // uses for the same "just refresh what's visible" case — cheap enough to
  // call on every single translation as it trickles in.
  function repaintSlidePreviews() {
    document.querySelectorAll('#svc-stack-list .svc-slide-preview').forEach(preview => {
      const pending = preview.__pendingPaint;
      if (!pending) return;
      const { item, s, i, label } = pending;
      // A scene slide (s.layers — a ProPresenter import preserved
      // as-authored, see slidesFor's 'slides' case) has no shared item
      // theme to apply at all; themeForItem(item) would be either the
      // wrong theme or nothing. Same convention Full-scale Edit's own
      // thumbnail painter already uses for this (renderItemSlidesList).
      const look = s.isScene ? { layers: s.layers || [] } : themeForItem(item);
      const style = s.isScene ? {} : (item.slideStyles?.[i] || {});
      paintLookLayers(preview, look, style, {
        verseText: s.text, referenceText: s.reference || '',
        translatedText: getTranslatedText(item, s, () => repaintSlidePreviews()),
      }, { hideReference: true });
      if (label) preview.appendChild(label);
    });
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  let inited = false;
  // Output transition (Fade/Slide/Cut + speed) — display-level, not per-
  // theme (see display.html's outputAnimation and its own comment there),
  // so this quick picker lives right under the Monitoring preview instead
  // of requiring a trip into Theme Studio to change how the WHOLE output
  // transitions. Persisted through the existing /api/settings store; the
  // POST there broadcasts live to display.html, so a change here takes
  // effect on the real output immediately, no reload.
  function initOutputTransitionPicker() {
    const picker = document.getElementById('rs-anim-picker');
    const speedInput = document.getElementById('rs-anim-speed');
    if (!picker || !speedInput) return;

    function setActive(anim) {
      picker.querySelectorAll('.ts-align-btn').forEach(b => b.classList.toggle('active', b.dataset.anim === anim));
      speedInput.classList.toggle('hidden', anim === 'cut');
    }

    // If the operator touches the picker before this initial fetch
    // resolves, its own POST already applied the real change — the fetch
    // landing after that would otherwise visually revert the UI back to
    // the stale value it fetched at load, even though the persisted
    // setting itself is still correct.
    let userTouched = false;
    fetchWithTimeout(`${SERVER}/api/settings`).then(r => r.json()).then(s => {
      if (userTouched) return;
      setActive(s.outputAnimation || 'fade');
      if (typeof s.outputAnimationSpeed === 'number' && s.outputAnimationSpeed > 0) speedInput.value = s.outputAnimationSpeed;
    }).catch(() => { if (!userTouched) setActive('fade'); });

    picker.addEventListener('click', (e) => {
      const btn = e.target.closest('.ts-align-btn');
      if (!btn) return;
      userTouched = true;
      setActive(btn.dataset.anim);
      fetchWithTimeout(`${SERVER}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputAnimation: btn.dataset.anim }),
      }).catch(() => {});
    });

    // Debounced — 'input' fires continuously while dragging, and each
    // change here is a real settings-file write plus a broadcast, not
    // just a local style update.
    let speedTimer = null;
    speedInput.addEventListener('input', () => {
      userTouched = true;
      clearTimeout(speedTimer);
      const value = parseFloat(speedInput.value);
      speedTimer = setTimeout(() => {
        fetchWithTimeout(`${SERVER}/api/settings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outputAnimationSpeed: value }),
        }).catch(() => {});
      }, 200);
    });
  }

  function init() {
    if (inited) return;
    inited = true;
    initOutputTransitionPicker();

    loadAll();
    loadInstalledMtLangs(); // fire-and-forget — warms effectiveTranslateTo's single-language fallback

    // Bible is the default landing view and nothing ever calls
    // showCenterView('bible') to arrive there (it's just already showing in
    // the static HTML) — so without this, updateMediaBinVisibility never
    // runs until the operator happens to switch tabs at least once, and the
    // Media Bin toggle button's very first click flips mediaBinUserHidden
    // from its already-correct default straight into "hidden", with no
    // visible change (it started hidden in the HTML either way) to explain
    // why nothing happened. Sync the real DOM state up front instead.
    updateMediaBinVisibility();

    document.getElementById('playlist-switcher')?.addEventListener('click', (e) => openPlaylistSwitcherPopover(e.currentTarget));
    // Cross-playlist drag: dragging a sidebar/stack item onto the switcher
    // opens the playlist list so every playlist becomes an individually
    // droppable target (see the per-row drag handlers in
    // openPlaylistSwitcherPopover) — no live cross-playlist list preview
    // needed since only one playlist is ever rendered at a time.
    document.getElementById('playlist-switcher')?.addEventListener('dragenter', (e) => {
      if (!dragItemId) return;
      e.preventDefault();
      if (document.getElementById('svc-popover')?.classList.contains('hidden')) {
        openPlaylistSwitcherPopover(e.currentTarget);
      }
    });
    renderPlaylistSwitcher();

    if (typeof loadHymnBank === 'function') {
      loadHymnBank().then(n => { if (n) console.log(`[Songs] imported bank loaded: ${n} songs`); });
    }
    loadSongLibrary();

    // The only way back to the Bible/Live Queue view once a playlist/slides
    // section is open was closing the whole playlist — no obvious exit while
    // actually inside one. Mirrors Slides/Songs/Theme Studio as an
    // always-visible top-bar control rather than something buried in the
    // playlist toolbar.
    document.getElementById('bible-btn')?.addEventListener('click', () => closeStack());
    document.getElementById('slides-btn')?.addEventListener('click', () => openStack());
    document.getElementById('timer-btn')?.addEventListener('click', showTimerLibrary);
    document.getElementById('songs-btn')?.addEventListener('click', showSongsLibrary);
    document.getElementById('media-btn')?.addEventListener('click', showMediaLibrary);
    document.getElementById('hymn-search')?.addEventListener('input', e => renderHymnList(e.target.value));
    document.getElementById('song-import-btn')?.addEventListener('click', (e) => openSongImportPopover(e.currentTarget));
    document.getElementById('bible-theme-btn')?.addEventListener('click', (e) => openBibleThemePopover(e.currentTarget));

    // ── Media tab wiring ─────────────────────────────────────────────────
    document.getElementById('media-add-folder-btn')?.addEventListener('click', (e) => pickMediaFolder(e.currentTarget));
    const mediaUploadInput = document.getElementById('media-upload-file');
    document.getElementById('media-upload-btn')?.addEventListener('click', () => mediaUploadInput?.click());
    mediaUploadInput?.addEventListener('change', () => {
      uploadMediaFiles(mediaUploadInput.files);
      mediaUploadInput.value = '';
    });

    const mediaDropzone = document.getElementById('media-dropzone');
    const mediaDropHint = document.getElementById('media-dropzone-hint');
    if (mediaDropzone) {
      let dragDepth = 0;
      mediaDropzone.addEventListener('dragover', (e) => { e.preventDefault(); });
      mediaDropzone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (!e.dataTransfer?.types?.includes('Files')) return;
        dragDepth++;
        mediaDropHint?.classList.remove('hidden');
      });
      mediaDropzone.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) mediaDropHint?.classList.add('hidden');
      });
      mediaDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        mediaDropHint?.classList.add('hidden');
        if (e.dataTransfer?.files?.length) uploadMediaFiles(e.dataTransfer.files);
      });
    }

    // Transport — remote-controls the display's media <video>; see
    // display.html's applyMediaControl and server.js's /api/service/media-control.
    document.getElementById('media-play-btn')?.addEventListener('click', () => {
      const icon = document.getElementById('media-play-icon');
      // The icon already reflects real state via onMediaStatus; use its
      // current glyph to decide which way to toggle rather than tracking a
      // separate local "is playing" flag that could drift out of sync.
      const isPaused = icon?.innerHTML.includes('polygon');
      mediaControl(isPaused ? 'play' : 'pause');
    });
    let mediaMutedLocal = false;
    document.getElementById('media-mute-btn')?.addEventListener('click', (e) => {
      mediaMutedLocal = !mediaMutedLocal;
      e.currentTarget.classList.toggle('active', mediaMutedLocal);
      mediaControl(mediaMutedLocal ? 'mute' : 'unmute');
    });
    const mediaSeekInput = document.getElementById('media-seek');
    mediaSeekInput?.addEventListener('mousedown', () => { mediaSeeking = true; });
    mediaSeekInput?.addEventListener('touchstart', () => { mediaSeeking = true; });
    mediaSeekInput?.addEventListener('change', () => {
      const duration = Number(mediaSeekInput.dataset.duration || 0);
      if (duration > 0) mediaControl('seek', (Number(mediaSeekInput.value) / 1000) * duration);
      mediaSeeking = false;
    });
    document.getElementById('media-volume')?.addEventListener('input', (e) => {
      mediaControl('volume', Number(e.target.value) / 100);
    });

    // Folder-level "+": creates a new playlist, Explorer-style — appears
    // immediately with an editable name rather than behind a naming dialog.
    // Jumps straight to its (empty) stack view afterward, ready for
    // "+ Add content", rather than staring at the Bible/Live Queue view.
    document.getElementById('svc-add-menu-btn')?.addEventListener('click', () => {
      const p = createPlaylist('New Playlist');
      switchPlaylist(p.id);
      startRenamingSwitcher();
      openStack();
    });

    // Content-level "+": adding songs/slides/scripture/images only makes
    // sense once you're inside a playlist, so it lives on the stack view's
    // own toolbar rather than duplicated at the folder level.
    document.getElementById('svc-add-section-btn')?.addEventListener('click', (e) => openAddContentPopover(e.currentTarget));

    // Keyword search across every slide's text in the current playlist —
    // see slideSearchQuery's own declaration and slideCard()'s use of it
    // for how the actual matching/highlighting works. This wiring just
    // owns the input itself: debounced re-render, auto-expand any section
    // with a match, scroll+flash the first one, keep the count/clear-button
    // in sync.
    {
      const searchInput = document.getElementById('svc-slide-search');
      const clearBtn    = document.getElementById('svc-slide-search-clear');
      const countEl     = document.getElementById('svc-slide-search-count');
      let searchDebounce = null;

      const runSearch = () => {
        slideSearchQuery = (searchInput.value || '').trim().toLowerCase();
        clearBtn.style.display = slideSearchQuery ? '' : 'none';
        if (!slideSearchQuery) { countEl.textContent = ''; renderStack(); return; }

        // A match inside a collapsed section is invisible until expanded.
        // Sections stay single-open by design elsewhere (expandOnly, see
        // its own comment on the re-render cost of more than one open card
        // at once) — auto-open only the FIRST item with a match, same as
        // clicking its chevron, rather than forcing every matching section
        // open at once.
        let matchCount = 0;
        let firstMatchItemId = null;
        (service?.items || []).forEach(item => {
          const n = slidesFor(item).filter(s =>
            (s.text || '').toLowerCase().includes(slideSearchQuery)).length;
          matchCount += n;
          if (n && firstMatchItemId == null) firstMatchItemId = item.id;
        });
        if (firstMatchItemId != null) expandOnly(firstMatchItemId);
        countEl.textContent = matchCount
          ? `${matchCount} match${matchCount === 1 ? '' : 'es'}`
          : 'No matches';

        renderStack();

        const first = document.querySelector('#svc-stack-list .svc-slide.search-match');
        if (first) {
          first.scrollIntoView({ block: 'center', behavior: 'smooth' });
          first.classList.add('search-match-flash');
          setTimeout(() => first.classList.remove('search-match-flash'), 900);
        }
      };

      searchInput?.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(runSearch, 150);
      });
      clearBtn?.addEventListener('click', () => {
        searchInput.value = '';
        runSearch();
        searchInput.focus();
      });
    }

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
      // Set right before .click() by whichever quick-import trigger opened
      // the native file picker (Slides' add-menu, or the Songs tab's own
      // "+ Import Song" — see openAddContentPopover/openSongImportPopover)
      // — one shared hidden input, so this is the only way its change
      // handler knows which destination the pick was actually for.
      if (f) quickImportFile(f, quickFileInput.dataset.destination || 'playlist');
    });

    const fileInput = document.getElementById('svc-image-file');
    fileInput?.addEventListener('change', async () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = '';
      const target = replaceImageTarget; replaceImageTarget = null;
      // Replacing the current image (from the full-edit inspector's own
      // "Replace image…" button) is a direct in-place swap, not a new
      // section — no confirm dialog needed. `target` (set at click time)
      // says exactly which image to swap: an 'image'-type item's own `src`,
      // or one specific block within a 'slides'-type item (which can now
      // hold several image blocks from a ProPresenter import).
      const replacing = !!target;
      for (const f of files) {
        const src = await readImage(f);
        if (!src) continue;
        if (target && target.item.type === 'image') {
          target.item.src = src; saveService(); renderFullEdit(); renderStack();
        } else if (target && target.blockIndex != null) {
          const block = target.item.blocks[target.blockIndex];
          // imageFileName: the announcement-follower's fallback trigger
          // phrase when no custom label is set — see imageTriggerPhrase.
          if (block) { block.image = src; block.imageFileName = f.name; saveService(); renderFullEdit(); renderStack(); }
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
    document.getElementById('ac-structure-paragraph')?.addEventListener('click', () => setAcStructureMode('paragraph'));
    document.getElementById('ac-structure-lines')?.addEventListener('click', () => setAcStructureMode('lines'));

    // Stack view
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
    document.getElementById('svc-item-fullscale-btn')?.addEventListener('click', () => {
      const item = activeItem();
      if (item) window.KairoItemStyleEditor?.open?.(item.id, 0);
    });
    document.getElementById('svc-delim-input')?.addEventListener('change', (e) => {
      const item = activeItem();
      if (!item) return;
      const requested = Math.max(0, Math.floor(Number(e.target.value)) || 0);
      setLinesPerSlide(item, requested);
      e.target.value = linesPerSlideValue(item);
      refreshAfterSlideEdit(item);
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

    // Multi-select for the playlist sidebar — Cmd/Ctrl+A selects every item
    // in the current playlist, Delete/Backspace removes whatever's selected
    // (one confirm for the whole batch, not one per item), Escape clears it.
    // Gated off while Theme Studio is open since it owns the same shortcuts
    // for its own layer list (see app.js) — only one "select all" makes
    // sense for whichever surface is actually in front.
    document.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
      if (window.KairoThemeStudio?.isOpen?.()) return;
      if (!service || !service.items.length) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectedItemIds = new Set(service.items.map(i => i.id));
        renderSidebar();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItemIds.size) {
        e.preventDefault();
        const ids = [...selectedItemIds];
        const message = ids.length === 1
          ? `Remove "${service.items.find(i => i.id === ids[0])?.title || '(untitled)'}" from this playlist?`
          : `Remove ${ids.length} items from this playlist?`;
        confirmDeletePopover(document.getElementById('svc-items-list'), message, () => {
          ids.forEach(id => removeItem(id));
          selectedItemIds.clear();
        });
      } else if (e.key === 'Escape' && selectedItemIds.size) {
        selectedItemIds.clear();
        renderSidebar();
      }
    });

    // Same select-all/copy/paste/delete gesture as the sidebar above, but for
    // slides within whichever of the three slide surfaces is currently
    // showing (Quick Edit, Full-scale edit/item mode, or the Stack view's
    // one expanded card — expanded is single-open, see expandOnly's comment,
    // so there's at most one to resolve here). Item mode is deliberately
    // included even though it shares Theme Studio's modal (window.
    // KairoThemeStudio.isOpen() would say "open" for both) — isOpen() here
    // is the item-mode-specific flag, so this never fires during normal
    // theme editing, only Full-scale edit.
    function activeSlideSurfaceItem() {
      if (window.KairoItemStyleEditor?.isOpen?.()) return window.KairoItemStyleEditor.getItem?.() || null;
      const fsOpen = !document.getElementById('svc-fullscreen')?.classList.contains('hidden');
      if (fsOpen) return activeItem();
      const stackOpen = !document.getElementById('svc-stack-view')?.classList.contains('hidden');
      if (stackOpen && expanded.size) return service.items.find(it => expanded.has(it.id)) || null;
      return null;
    }
    document.addEventListener('keydown', (e) => {
      // Guards against hijacking normal text copy/paste while actually
      // editing a Quick Edit slide's contenteditable — only engage when the
      // click/focus target is the row/thumbnail itself, not text inside it.
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
      const item = activeSlideSurfaceItem();
      if (!item) return;
      const mod = e.metaKey || e.ctrlKey;
      const slides = slidesFor(item);
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAllSlidesFor(item);
        rerenderActiveSlideSurface(item);
      } else if (mod && e.key.toLowerCase() === 'c' && selectedSlideIndices.size) {
        e.preventDefault();
        copySlides(item, selectedSlideIndices);
      } else if (mod && e.key.toLowerCase() === 'v' && slideClipboard) {
        e.preventDefault();
        const after = lastClickedSlideIndex ?? (slides.length - 1);
        pasteSlides(item, after);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedSlideIndices.size) {
        e.preventDefault();
        const indices = [...selectedSlideIndices];
        const message = indices.length === 1 ? 'Remove this slide?' : `Remove ${indices.length} slides?`;
        confirmDeletePopover(document.getElementById('svc-items-list'), message, () => bulkDeleteSlides(item, indices));
      } else if (e.key === 'Escape' && selectedSlideIndices.size) {
        clearSlideSelection();
        rerenderActiveSlideSurface(item);
      }
    });
    function rerenderActiveSlideSurface(item) {
      if (window.KairoItemStyleEditor?.isOpen?.()) window.KairoItemStyleEditor.refreshSlides?.(item.id);
      else if (!document.getElementById('svc-fullscreen')?.classList.contains('hidden')) renderFullEdit();
      else renderStack();
    }

    applyView();
    renderSidebar();
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();

  // Song auto-detection will want the playlist's lyrics to build its index.
  // paintLookLayers is also used by app.js to render the top-bar live preview
  // with the same theme a sent slide actually carries, instead of plain text.
  window.KairoService = {
    get service() { return service; },
    slidesFor, sendSlide, cycleSectionLabel, focusInStack, openFullEdit, closeStack, closeFullEdit,
    effectiveTranslateTo, awaitTranslatedText,
    paintLookLayers, renderLookThumbnail, saveService, openContextMenu, openThemePopover, themeForItem,
    showMediaLibrary, onMediaStatus, onMediaFolderChanged, setMediaTransportVisible,
    showTimerLibrary, onTimerAction, onClockAction, getTimerItem, updateSegmentParams, saveTimerScenes,
    onTranscript, setAutoFollow, get autoFollow() { return autoFollow; },
    resendLiveForThemeEdit, resendLiveForSlideStyleEdit, onTimerSlide, refreshThumbnails, clearLive,
    // Lets Full-scale edit's canvas (app.js's beginInlineTextEdit) double-
    // click-edit a verse-bound layer's actual words — a song lyric or a
    // plain slide's own text — the same write-back the Flow view's
    // contentEditable already uses, not a second, separate mechanism.
    commitSlideText,
    // Slide multi-select/duplicate/copy-paste — shared state lives here,
    // Full-scale edit's renderItemSlidesList (app.js) reaches in through
    // these instead of touching selectedSlideIndices directly cross-file.
    isSlideSelected, handleSlideRowClick, clearSlideSelection,
    canDuplicateSlide, anySlidesDuplicable, duplicateSlide, copySlides, pasteSlides,
    selectAllSlidesFor, bulkDeleteSlides,
    get slideClipboard() { return slideClipboard; },
    get selectedSlideIndices() { return selectedSlideIndices; },
    // File > Import's chooser (initNativeMenuBridge, app.js) reaches into
    // this same "Paste from clipboard" flow the Slides/Songs add-menus
    // already use, rather than a second implementation of clipboard import.
    quickImportClipboard,
  };
})();
