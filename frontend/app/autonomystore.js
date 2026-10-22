/* Agent OS autonomy posture: the sidecar owns the setting. Browser storage is a
   last-confirmed cache, never permission to overwrite the server on page load. */
'use strict';
const AutonomyStore = (() => {
  const KEY = 'starnet.autonomy.v1';
  let state = null, loaded = false, error = '', pending = 0, epoch = 0;
  let tail = Promise.resolve();
  const listeners = new Set();
  const RESUMED = 'AUTOMATION RESUMED: schedules and away work will run again';   // a labeled toast: the stamp rides the label's row
  const ready = () => typeof Autonomy !== 'undefined';
  const floor = () => ready() ? Autonomy.fresh() : { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 3 };
  const normalize = value => ready() ? Autonomy.normalize(value) : floor();
  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function get() { if (!state) state = normalize(load()); return normalize(state); }
  function status() { return { loaded, pending: pending > 0, error }; }
  function notify() { for (const fn of listeners) { try { fn(status()); } catch (_) {} } }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function summary() { return ready() ? Autonomy.summary(get()) : null; }
  function describe() { return ready() ? Autonomy.describe(get()) : ''; }
  function valid(p) { return p && ['wait','propose','leash','free'].includes(p.initiative) && ['observe','sandbox','reach'].includes(p.reach) && Number.isInteger(p.leashPerDay) && p.leashPerDay >= 1 && p.leashPerDay <= 12; }
  async function request(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch('/api/autonomy/posture', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal } : { cache: 'no-store', signal: controller.signal });
      const j = await r.json();
      if (!r.ok || !j || (body && j.ok !== true) || !valid(j.summary)) throw new Error((j && j.error) || 'Could not confirm the autonomy setting.');
      return j;
    } finally { clearTimeout(timeout); }
  }
  function enqueue(work) {
    const generation = epoch;
    pending++; notify();
    const job = tail.then(async () => {
      if (generation !== epoch) return { ok: false, error: 'Setting changed while loading.' };
      try {
        const j = await work();
        if (generation !== epoch) return { ok: false, error: 'Setting changed while loading.' };
        state = normalize(j.summary); loaded = true; error = ''; save();
        if (j.nightshiftStatePersisted === false || j.cronHaltPersisted === false) error = 'Autonomy saved, but emergency stop could not be resumed. Try Resume again.';
        // org P06: a write that LIFTED a standing halt says so — the route's haltLifted is the proof, never the request
        if (j.haltLifted === true && !error) announceResume(get(), j);
        return { ok: !error, posture: get(), error, haltLifted: j.haltLifted === true };
      } catch (e) {
        if (generation === epoch) {
          error = 'Autonomy could not be confirmed. ' + ((e && e.message) || 'Check the station connection and try again.');
          loaded = false;
          // A lost acknowledgement can follow a committed write. Reconcile before
          // claiming the old setting is current; failed readback means unknown.
          try { const j = await request(); if (generation === epoch) { state = normalize(j.summary); loaded = true; save(); } } catch (_) {}
        }
        return { ok: false, posture: get(), error };
      } finally { if (generation === epoch) { pending--; notify(); } }
    });
    tail = job.then(() => undefined, () => undefined);
    return job;
  }
  // the receipt states what the SAVED posture lets run: away work (the night shift) only beats at SMALL JOBS or FREE
  // (sidecar nightshift.js gates every beat on actsUnattended), so a lift that saved WAIT or SUGGEST never promises it.
  // org P06 wiring: every clause is read from the route's halt picture AFTER the write (j.halt = haltStatus(), j.cronArmed).
  // The dial lifts only the cron + night-shift halts; goal loops stay E-STOPped until RESUME AUTOMATION in the top bar,
  // so "RESUMED" / "LIFTED" heads the toast only when nothing is still halted, and "schedules can run" only when the
  // scheduler is armed — a cleared halt flag is not proof that schedules will fire.
  function resumedText(posture, j) {
    const s = ready() ? Autonomy.summary(posture) : null;
    const acts = !!(s && s.actsUnattended);
    const halt = j && j.halt && j.halt.subsystems && typeof j.halt.halted === 'boolean' ? j.halt : null;
    const held = k => !!(halt && halt.subsystems[k] && halt.subsystems[k].halted === true);
    const cleared = k => !!(halt && halt.subsystems[k] && halt.subsystems[k].halted === false);
    const schedules = j && j.cronArmed === true && cleared('cron');
    if (!halt) return 'E-STOP LIFT SAVED: the rest of the pause could not be checked — see RESUME AUTOMATION in the top bar';
    // the same three subsystems the top bar's RESUME AUTOMATION watches (emergency-control.js) — a Commander's own
    // overseer review pause is not an E-STOP leftover
    const whole = ['cron', 'nightshift', 'loops'].every(cleared);
    if (whole && acts && schedules) return RESUMED;
    const id = (posture && posture.initiative) || 'wait';
    const rung = (typeof StationUI !== 'undefined' && StationUI.initiativeLabel) ? StationUI.initiativeLabel(id) : String(id).toUpperCase();
    const parts = [];
    if (schedules) parts.push('schedules can run again');
    // org P06 (g4 final round): at WAIT / SUGGEST away work waits for the dial, never "resumed" over a STATE card that says it is OFF
    if (!acts) parts.push('away work stays off while ON ITS OWN is ' + rung);
    else if (cleared('nightshift')) parts.push('away work can run again');
    if (held('loops')) parts.push('goal loops stay paused — RESUME AUTOMATION in the top bar');
    const head = !whole ? 'E-STOP PARTLY LIFTED' : acts ? 'AUTOMATION RESUMED' : 'E-STOP LIFTED';
    return head + ': ' + parts.join('; ');
  }
  function announceResume(posture, j) {
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(resumedText(posture, j), 'good'); } catch (e) { console.warn('[autonomy] resume notice failed:', (e && e.message) || e); }
  }
  function init() { get(); return refresh(); }
  function refresh() { return enqueue(() => request()); }
  function write(transform, resumeHalt) { return enqueue(async () => {
    // Never combine a one-axis change with unverified axes from an old cache: the server's posture is read first every
    // time, because the lead (station.power autonomy.set) or a phone can change it while this page holds its copy.
    const current = normalize((await request()).summary);
    return request({ posture: transform(current), resumeHalt: resumeHalt === true });
  }); }
  function applyPreset(id) { return write(p => ready() ? Autonomy.applyPreset(p, id) : p, true); }
  function setInitiative(level) { return write(p => ready() ? Autonomy.setInitiative(p, level) : p, true); }
  // org P06: REACH and PACE are tuning, not "autonomy back on" — they never lift an E-STOP halt. The ON ITS OWN rungs
  // (setInitiative / applyPreset) and RESUME AUTOMATION in the top bar stay the stated lifts.
  function setReach(level) { return write(p => ready() ? Autonomy.setReach(p, level) : p, false); }
  function setLeash(n) { return write(p => ready() ? Autonomy.setLeash(p, n) : p, false); }
  async function reset() {
    epoch++; pending = 0; error = '';
    const result = await enqueue(() => request({ posture: floor(), resumeHalt: false }));
    if (result.ok) try { localStorage.removeItem(KEY); } catch (_) {}
    return result;
  }
  function exportState() { return get(); }
  function importState(obj) { return obj && typeof obj === 'object' ? write(() => normalize(obj), false) : Promise.resolve({ ok: false, error: 'Invalid autonomy backup.' }); }
  return { init, refresh, get, status, subscribe, summary, describe, applyPreset, setInitiative, setReach, setLeash, reset, exportState, importState, _state: () => state };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { AutonomyStore };
