// KAIRO — Action/Trigger framework
//
// A small, generic registry for named, fireable "actions" an operator can
// configure and fire from the UI — the ProPresenter-inspired abstraction
// behind things like a stage timer or a system-clock message. A "trigger"
// is one saved, configured instance (a specific countdown length, a
// specific clock label); firing it runs its type's `fire()` and broadcasts
// `{type:'action', actionId, target, triggerId, payload}` over the
// *existing* WebSocket broadcast() in server.js — this module never
// touches the transport itself, only what gets handed to it.
//
// Scope, deliberately: two trigger types (stage-timer, clock-message) to
// validate the abstraction against real cases instead of designing it in
// the abstract. No OSC/remote-trigger support yet — nothing here
// forecloses adding it later as one more registered type, but it isn't
// built until there's an actual consumer that needs it.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DATA = process.env.KAIRO_APP_DATA_DIR || path.join(__dirname, '..', 'databases');
const TRIGGERS_FILE = path.join(APP_DATA, 'triggers', 'triggers.json');

function ensureDirs() {
  fs.mkdirSync(path.dirname(TRIGGERS_FILE), { recursive: true });
}

let triggers = []; // [{ id, typeId, label, params, lastFiredAt }]
let broadcastFn = () => {}; // wired in by server.js via init() — this module doesn't own the WS transport

function loadTriggers() {
  try {
    const data = JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8'));
    triggers = Array.isArray(data) ? data : [];
  } catch { triggers = []; }
}

function saveTriggers() {
  ensureDirs();
  fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(triggers, null, 2));
}

// ── Trigger type registry ────────────────────────────────────────────────
// id -> { label, paramsSchema, fire(trigger, ctx): stopHandle? }
// `fire` returns nothing for a one-shot action, or `{ stop() }` for
// anything that keeps running (a timer's interval) so re-firing or
// deleting a trigger can clean it up instead of leaking a timer.
const triggerTypes = new Map();
function registerTriggerType(id, def) { triggerTypes.set(id, def); }
function listTriggerTypes() {
  return [...triggerTypes.entries()].map(([id, def]) => ({ id, label: def.label, paramsSchema: def.paramsSchema || {} }));
}

const activeHandles = new Map(); // triggerId -> { stop() }

function init(broadcast) {
  broadcastFn = broadcast;
  ensureDirs();
  loadTriggers();
}

function listTriggers() { return triggers; }
// Whether a trigger's countdown/interval is actually running right now —
// segments.js uses this to reconcile its own stored status against
// reality (e.g. after a server restart, activeHandles is empty again even
// though a segment's saved status still says "live").
function isActive(id) { return activeHandles.has(id); }

function addTrigger(record) {
  const type = triggerTypes.get(record.typeId);
  const trigger = {
    id: crypto.randomUUID(),
    typeId: record.typeId,
    label: record.label || type?.label || 'Trigger',
    params: record.params || {},
    lastFiredAt: null,
  };
  triggers.push(trigger);
  saveTriggers();
  return trigger;
}

function updateTrigger(id, record) {
  const trigger = triggers.find(t => t.id === id);
  if (!trigger) return null;
  if (record.label !== undefined) trigger.label = record.label;
  if (record.params !== undefined) trigger.params = { ...trigger.params, ...record.params };
  saveTriggers();
  return trigger;
}

function stopTrigger(id) {
  const handle = activeHandles.get(id);
  if (handle?.stop) handle.stop();
  activeHandles.delete(id);
  // An explicit stop (as opposed to a stage timer running its own
  // countdown to zero) has nothing left to broadcast — without this, a
  // display that already rendered the badge keeps showing its last
  // frozen value forever, since nothing else ever tells it otherwise.
  const trigger = triggers.find(t => t.id === id);
  if (trigger) {
    broadcastFn({ type: 'action', actionId: trigger.typeId, target: 'viewer', triggerId: id, payload: { cleared: true } });
  }
}

function removeTrigger(id) {
  stopTrigger(id);
  const before = triggers.length;
  triggers = triggers.filter(t => t.id !== id);
  saveTriggers();
  return triggers.length !== before;
}

function fireTrigger(id) {
  const trigger = triggers.find(t => t.id === id);
  if (!trigger) return { error: 'No such trigger' };
  const type = triggerTypes.get(trigger.typeId);
  if (!type) return { error: `Unknown trigger type "${trigger.typeId}"` };
  if (type.validate) {
    const problem = type.validate(trigger);
    if (problem) return { error: problem };
  }

  stopTrigger(id); // re-firing replaces whatever instance of it was already running
  trigger.lastFiredAt = Date.now();
  saveTriggers();

  const handle = type.fire(trigger, {
    broadcast: (payload) => broadcastFn({
      type: 'action', actionId: trigger.typeId, target: 'viewer', triggerId: trigger.id, payload,
    }),
  });
  if (handle) activeHandles.set(id, handle);
  return { ok: true, trigger };
}

// ── Built-in trigger types ───────────────────────────────────────────────

// "Ends at" (a clock time), not "runs for" (a duration) — a service
// timer is almost always thought of the second way ("we need to be done
// by 11:45"), and computing off the actual device clock rather than a
// duration means it can never silently drift out of sync with the real
// wall clock the way repeatedly restarting/adjusting a duration-based
// countdown could.
function resolveEndAtTime(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// Two ways to specify the countdown target — params.mode picks which:
//  - 'endAt' (default, backward-compatible): a fixed clock time, resolved
//    fresh off resolveEndAtTime every fire (see the comment above it).
//  - 'duration': a length in seconds, resolved against Date.now() AT FIRE
//    TIME — "run for 15 minutes starting whenever I hit Start", instead
//    of "be done by a specific clock time". Same tick/overtime behavior
//    either way once resolved to an absolute endAt.
function resolveEndAt(trigger) {
  if (trigger.params.mode === 'duration') {
    const sec = Number(trigger.params.durationSec);
    return sec > 0 ? Date.now() + sec * 1000 : null;
  }
  return resolveEndAtTime(trigger.params.endAtTime);
}

registerTriggerType('stage-timer', {
  label: 'Stage Timer',
  paramsSchema: {
    mode: { type: 'string', label: 'Mode (endAt/duration)', default: 'endAt' },
    endAtTime: { type: 'time', label: 'Ends at', default: '' },
    durationSec: { type: 'number', label: 'Duration (seconds)', default: 0 },
  },
  validate(trigger) {
    if (trigger.params.mode === 'duration') {
      const sec = Number(trigger.params.durationSec);
      if (!(sec > 0)) return 'Enter a duration';
      return null;
    }
    const endAt = resolveEndAtTime(trigger.params.endAtTime);
    if (endAt == null) return 'Enter an end time';
    if (endAt <= Date.now()) return 'That time has already passed today — pick a later time';
    return null;
  },
  fire(trigger, { broadcast }) {
    // Duration mode resolves ITS OWN endAt once, right here at fire
    // time (not per-tick) — re-deriving it every tick would restart the
    // countdown every second instead of counting down.
    const endAt = resolveEndAt(trigger);
    // Deliberately doesn't stop itself at zero — a real stage timer
    // doesn't vanish the moment time's up, it goes into overtime (see
    // remainingMs going negative here, rendered red+counting-up in
    // display.html) until the operator actually stops it.
    const tick = () => {
      const remainingMs = endAt - Date.now();
      broadcast({ remainingMs, label: trigger.label, style: trigger.params.style || null });
    };
    tick();
    const intervalId = setInterval(tick, 1000);
    return { stop: () => clearInterval(intervalId) };
  },
});

registerTriggerType('clock-message', {
  label: 'System Clock',
  paramsSchema: { format: { type: 'string', label: 'Format (24h/12h)', default: '24h' } },
  fire(trigger, { broadcast }) {
    const tick = () => broadcast({ now: Date.now(), format: trigger.params.format || '24h', label: trigger.label });
    tick();
    const intervalId = setInterval(tick, 1000);
    return { stop: () => clearInterval(intervalId) };
  },
});

module.exports = {
  init,
  listTriggerTypes,
  listTriggers, addTrigger, updateTrigger, removeTrigger,
  fireTrigger, stopTrigger, isActive,
};
