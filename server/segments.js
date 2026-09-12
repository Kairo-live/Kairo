// KAIRO — Service Segments (Preservice / Worship / Sermon / … timers)
//
// A thin, ordered layer on top of triggers.js's existing stage-timer
// trigger type — each segment IS one stage-timer trigger under the hood
// (so it gets the same clock-aligned countdown, broadcast, and display
// rendering for free), and this module only adds the two things a
// generic trigger has no opinion about:
//   1. an operator-editable ORDER (a real service running order), and
//   2. the rule that exactly one segment is ever "live" at a time —
//      starting one stops+marks-done whichever was live before it,
//      the same way advancing a service moves on regardless of whether
//      the last segment's clock had actually run out.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const triggers = require('./triggers');

const APP_DATA = process.env.KAIRO_APP_DATA_DIR || path.join(__dirname, '..', 'databases');
const SEGMENTS_FILE = path.join(APP_DATA, 'segments', 'segments.json');

const DEFAULT_SEGMENTS = ['Preservice', 'Prayer', 'Worship', 'The Word', 'Testimony', 'Ministration'];

let segments = []; // [{ id, name, order, triggerId, status }] status: 'pending'|'live'|'done'

function ensureDirs() { fs.mkdirSync(path.dirname(SEGMENTS_FILE), { recursive: true }); }

function loadSegments() {
  try {
    const data = JSON.parse(fs.readFileSync(SEGMENTS_FILE, 'utf8'));
    segments = Array.isArray(data) ? data : [];
  } catch { segments = []; }
  // Backfill segments saved before themeId/slideStyles/scenes existed.
  segments.forEach(s => {
    if (s.themeId === undefined) s.themeId = null;
    if (s.slideStyles === undefined) s.slideStyles = {};
    if (s.scenes === undefined) s.scenes = [];
  });
}

function saveSegments() {
  ensureDirs();
  fs.writeFileSync(SEGMENTS_FILE, JSON.stringify(segments, null, 2));
}

function init() {
  ensureDirs();
  loadSegments();
  // A server restart clears triggers.js's in-memory activeHandles, so any
  // segment still marked "live" from before the restart no longer has a
  // real countdown running — reconcile rather than show a stale live
  // state with nothing actually broadcasting.
  let changed = false;
  segments.forEach(s => {
    if (s.status === 'live' && !triggers.isActive(s.triggerId)) { s.status = 'pending'; changed = true; }
  });
  if (changed) saveSegments();
  if (!segments.length) DEFAULT_SEGMENTS.forEach(name => addSegment(name));
}

// `opts.themeId`/`opts.slideStyles` let a caller seed a new segment with an
// existing one's styling — used by the "Duplicate" action in service.js so
// copying a preset carries its look over instead of starting blank.
function addSegment(name, opts = {}) {
  const trigger = triggers.addTrigger({ typeId: 'stage-timer', label: name });
  const segment = {
    id: crypto.randomUUID(),
    name,
    order: segments.length,
    triggerId: trigger.id,
    status: 'pending',
    // A segment is "a slide with a timer component" — themeId + slideStyles
    // mirror exactly the shape a real playlist item uses (see
    // resolveItemBaseLook/themeForItem and writeItemSlideStyleFromSynthetic
    // in app.js/service.js), so Full-scale edit can treat a segment as a
    // real item with no separate persistence path of its own. slideStyles
    // is keyed by slide index the same way, even though a timer only ever
    // has the one slide (index 0).
    themeId: opts.themeId ?? null,
    slideStyles: opts.slideStyles ?? {},
    // A storyboard alternative to themeId/slideStyles — a sequence of
    // {id, name, durationSec, layers} scenes, each a standalone layer set
    // (its own background/image-cycle/text layers, edited the same way a
    // theme's are — see app.js's scene-mode Theme Studio integration)
    // played in order across the segment's live countdown, each with its
    // own explicit duration rather than one repeating cycle. Empty by
    // default: a plain segment with no scenes falls back to themeId/
    // slideStyles exactly as before — scenes are opt-in, not a
    // replacement for the simple single-theme case.
    scenes: opts.scenes ?? [],
  };
  segments.push(segment);
  saveSegments();
  return withTrigger(segment);
}

function withTrigger(s) {
  return { ...s, trigger: triggers.listTriggers().find(t => t.id === s.triggerId) || null };
}

function listSegments() {
  return segments.slice().sort((a, b) => a.order - b.order).map(withTrigger);
}

function updateSegment(id, record) {
  const s = segments.find(x => x.id === id);
  if (!s) return null;
  if (record.name !== undefined) { s.name = record.name; triggers.updateTrigger(s.triggerId, { label: record.name }); }
  // Was missing entirely — a PUT carrying {params: {endAtTime}} (the
  // "Set end time…" menu item / auto-prompt in service.js) silently did
  // nothing, since nothing here ever forwarded it to the underlying
  // trigger. Only surfaced once the visible time input moved off the
  // card face and this became the *only* way to set a time at all.
  if (record.params !== undefined) triggers.updateTrigger(s.triggerId, { params: record.params });
  if (record.themeId !== undefined) s.themeId = record.themeId;
  if (record.slideStyles !== undefined) s.slideStyles = record.slideStyles;
  if (record.scenes !== undefined) s.scenes = record.scenes;
  saveSegments();
  return withTrigger(s);
}

function removeSegment(id) {
  const s = segments.find(x => x.id === id);
  if (!s) return false;
  triggers.removeTrigger(s.triggerId);
  segments = segments.filter(x => x.id !== id);
  segments.forEach((seg, i) => { seg.order = i; }); // close the gap
  saveSegments();
  return true;
}

// Contract is "here's the full new order of ids", not "move this one up
// one slot" — simplest thing a reorder UI can send, and avoids
// accumulating fractional/duplicate order values from one-at-a-time moves.
function reorderSegments(orderedIds) {
  orderedIds.forEach((id, i) => {
    const s = segments.find(x => x.id === id);
    if (s) s.order = i;
  });
  saveSegments();
  return listSegments();
}

function startSegment(id, endAtTime) {
  const s = segments.find(x => x.id === id);
  if (!s) return { error: 'No such segment' };
  const wasLive = segments.find(x => x.status === 'live' && x.id !== id);
  if (endAtTime !== undefined) triggers.updateTrigger(s.triggerId, { params: { endAtTime } });
  const result = triggers.fireTrigger(s.triggerId);
  if (result.error) return result; // nothing changed yet — leave wasLive running
  if (wasLive) { triggers.stopTrigger(wasLive.triggerId); wasLive.status = 'done'; }
  s.status = 'live';
  saveSegments();
  return { ok: true, segment: withTrigger(s) };
}

function stopSegment(id, markDone) {
  const s = segments.find(x => x.id === id);
  if (!s) return { error: 'No such segment' };
  triggers.stopTrigger(s.triggerId);
  s.status = markDone ? 'done' : 'pending';
  saveSegments();
  return { ok: true, segment: withTrigger(s) };
}

function resetSegment(id) {
  const s = segments.find(x => x.id === id);
  if (!s) return { error: 'No such segment' };
  triggers.stopTrigger(s.triggerId);
  s.status = 'pending';
  saveSegments();
  return { ok: true, segment: withTrigger(s) };
}

// Used by "Clear Timer"/"Clear All" — there's at most one live segment by
// construction, so this is a direct lookup, not a search-and-hope.
function stopLiveSegment() {
  const live = segments.find(x => x.status === 'live');
  if (!live) return null;
  return stopSegment(live.id, true).segment;
}

module.exports = {
  init, listSegments, addSegment, updateSegment, removeSegment,
  reorderSegments, startSegment, stopSegment, resetSegment, stopLiveSegment,
};
