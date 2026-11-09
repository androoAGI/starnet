/* sidecar/unattended-admission.js — may an unattended beat spend a model call right now? (cost fix W1.6, slice 1)

   THE FUTILE BEAT. A night-shift build beat proposes, and PriorWork.veto renames a re-proposal of the newest undecided
   build into "Continue: <base>". When that undecided build is itself "Continue: <base>", workshopStore.queue refuses the
   identical title and the beat ends 'duplicate-backlog' — after its lead-model candidate call and a leash unit were
   spent. Nothing it read has changed by the next beat, so the next beat proposes the same thing and ends the same way:
   31 of 39 beats on Andrew's station between 10-20 and 11-08, one undecided build re-proposed 23 times.

   THE RULE (one resolver; the host only gathers):
     · settle(seen, result, now) after every build beat: a beat that ended 'duplicate-backlog' against a BUILT,
       undecided backlog item is remembered as { fp: what that beat read, runId/backlogId of the build it collided
       with }. Any other outcome — a delivery, a different stand-down, a throw — forgets it.
     · decide({ stuck, fp, waiting }) before the next beat spends anything: hold ('awaiting-verdict') only while the
       fingerprint of everything the beat would read is the one the futile beat read AND the build it collided with is
       still undecided in the live backlog. Any change re-admits at once: a new message, a verdict, a new task or
       thread, a commit, a steer, a dial or model change. It is not a limit — nothing counts, nothing expires on a
       clock, and a beat the Commander fires by hand never asks.
     · fingerprint(parts) — a stable digest of the parts the host gathers (sorted keys, no clock), so the beat and
       the pre-spend gate compare the same thing. It holds ids and a hash only, never session text.

   PURE: no clock, rng or fs — `now` is injected; node's crypto only hashes. */
'use strict';

const crypto = require('crypto');

const AWAITING_VERDICT = 'awaiting-verdict';
const DEAD_END = 'duplicate-backlog';

// a canonical JSON: object keys sorted at every depth, so two equal part bags always hash alike.
function canonical(v) {
  if (v === undefined || typeof v === 'function') return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined && typeof v[k] !== 'function')
    .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function fingerprint(parts) {
  return crypto.createHash('sha256').update(canonical(parts || {}), 'utf8').digest('hex');
}

const str = v => (v == null ? '' : String(v));

/* settle — what to remember after a build beat. seen: { fp } read before the beat; result: the beat's result (null when
   it threw). Returns the marker to keep, or null to forget. result.waitingOn is set by the beat only when the queue
   refused its job because a BUILT item with that title is still undecided: that, and only that, is a verdict awaited. */
function settle(seen, result, now) {
  const r = result || {};
  const w = r.waitingOn;
  if (r.reason !== DEAD_END || !w || !str(w.runId) || !seen || !str(seen.fp)) return null;
  return { fp: str(seen.fp), runId: str(w.runId), backlogId: str(w.backlogId), at: Number.isFinite(now) ? now : 0 };
}

/* decide — admit, or hold while nothing has changed since the futile beat.
     stuck:   the settled marker (or null)
     fp:      the fingerprint of what a beat would read now
     waiting: the live backlog row the marker names, { title, runId } — null when it is no longer there (decided)
   -> { admit: true } | { admit: false, binding: 'awaiting-verdict', why: { title, runId } } */
function decide(inp) {
  const i = inp || {};
  const s = i.stuck;
  if (!s || !str(s.fp) || !str(s.runId)) return { admit: true };
  if (str(i.fp) !== str(s.fp)) return { admit: true, changed: 'inputs' };
  const w = i.waiting;
  if (!w || str(w.runId) !== str(s.runId)) return { admit: true, changed: 'verdict' };
  return { admit: false, binding: AWAITING_VERDICT, why: { title: str(w.title).slice(0, 200), runId: str(w.runId) } };
}

module.exports = { fingerprint, settle, decide, canonical, AWAITING_VERDICT, DEAD_END };
