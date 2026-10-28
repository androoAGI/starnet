/* node test/cloudsave-unknown.test.js — SAVE-UNKNOWN escape test (the July-19 "my save got deleted" incident).

   Before the fix, CloudSave.pull() mapped EVERY failure — network error, timeout, and an auth-refused 403
   (lost/stale per-launch token) — to null, and reconcile() treated null as "no durable save exists". With the
   localStorage cache also gone (webview cache purge on update), boot fell through to the first-run creation
   ceremony over an intact durable save: the app asserted "you have no save" when the harness proved no such
   thing. This locks the truth: only a definitive 200 "empty" answer may present as no-save; forbidden/
   unreachable with no local cache must hand boot the save-unknown sentinel so it gates and retries.

   Runs cloudsave.js in Node with a stubbed fetch, mirroring cloudsave-refusal.test.js. */
'use strict';
const A = require('./_assert.js');

let nextPull = null;   // () => Promise<Response-ish> for the next GET
global.fetch = (url, init) => {
  const method = (init && init.method) || 'GET';
  if (method === 'GET' && nextPull) return nextPull();
  // POSTs (the seed-from-local push path) — accept quietly so flush timers settle clean
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
};

const CloudSave = require('../frontend/app/cloudsave.js');
const doc = (updatedAt) => ({ schema: 'starnet.save', version: 3, updatedAt, agent: { id: 'agent', name: 'NOVA' } });

(async () => {
  for (const body of [null, {}, { error: 'unavailable' }, { save: { broken: true } }, { save: null, ok: false }]) {
    nextPull = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    A.ok(CloudSave.isUnknownSentinel(await CloudSave.reconcile(null)), 'malformed 200 is unknown, never a proven empty station');
  }
  // ---- 1. auth-refused pull (403) + NO local cache → save-unknown sentinel, reason 'forbidden' ----
  nextPull = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  let r = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(r), 'a 403 pull with no local cache yields the save-unknown sentinel, never "no save"');
  A.eq(r.reason, 'forbidden', 'the sentinel names the auth refusal so the gate can say so honestly');
  A.eq(CloudSave.isFutureSentinel(r), false, 'the unknown sentinel is not mistaken for the future-save sentinel');
  A.eq(CloudSave.pullOutcome(), 'forbidden', 'pullOutcome() reports what the pull actually proved');

  // ---- 2. network failure (sidecar unreachable) + NO local cache → sentinel, reason 'unreachable' ----
  nextPull = () => Promise.reject(new Error('ECONNREFUSED'));
  r = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(r), 'an unreachable sidecar with no local cache yields the sentinel');
  A.eq(r.reason, 'unreachable', 'network failure reads as unreachable');

  // ---- 3. definitive 200 empty answer + NO local cache → null (genuine first run; onboarding allowed) ----
  nextPull = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ save: null }) });
  r = await CloudSave.reconcile(null);
  A.eq(r, null, 'a definitive 200-empty answer is the ONLY no-local path that presents as no-save');
  A.eq(CloudSave.pullOutcome(), 'empty', 'a 200 with no save proves empty');

  // ---- 4. auth-refused pull + local cache PRESENT → resume from local (no sentinel, no data loss) ----
  nextPull = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  const local = doc(100);
  r = await CloudSave.reconcile(local);
  A.eq(r, local, 'with a local cache in hand, a refused pull still resumes from local');
  A.eq(CloudSave.isUnknownSentinel(r), false, 'a real save doc is never sentinel-shaped');

  // ---- 5. 5xx server error + NO local cache → sentinel 'unreachable' (a sick sidecar proves nothing) ----
  nextPull = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
  r = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(r), 'a 5xx with no local cache yields the sentinel');
  A.eq(r.reason, 'unreachable', 'a server error reads as unreachable, not as an auth refusal');

  nextPull = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ unreadable: true }) });
  A.eq((await CloudSave.reconcile(null)).reason, 'unreadable', 'file read failure retains its specific recovery diagnosis');

  // #121: a valid remote the browser cache cannot hold (its per-site storage cap) is resumed IN MEMORY through the
  // real Save.fromDoc (validated, migrated), with its own revision: never onboarding, never the save-unreachable screen.
  const RealSave = require('../frontend/app/save.js');
  const removed = [];
  global.Save = RealSave;
  nextPull = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ save: { ...doc(200), _saveRevision: 4 } }) });
  global.localStorage = { getItem() { return null; }, setItem() { throw new Error('quota exceeded'); }, removeItem(k) { removed.push(k); } };
  const fromMemory = await CloudSave.reconcile(null);
  A.ok(!CloudSave.isUnknownSentinel(fromMemory) && fromMemory && fromMemory.agent && fromMemory.agent.name === 'NOVA', 'a remote the cache cannot hold is resumed from memory, not gated');
  A.eq(fromMemory.version, RealSave.CURRENT, 'the in-memory resume runs the migration ladder');
  A.eq(CloudSave.revision(), 4, 'the in-memory resume carries the station file revision');
  A.eq(CloudSave.memorySave() && CloudSave.memorySave().agent.name, 'NOVA', 'the in-memory save is what a later re-entry resumes');
  A.eq(removed, [], 'with no cache entry there is nothing to drop');

  // the 'cache' sentinel stays ONLY for a remote save that fails migration
  global.Save = { CURRENT: 5, load: () => null, fromDoc: () => ({ status: 'error', doc: null, version: 0 }) };
  nextPull = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ save: doc(200) }) });
  const cacheFailure = await CloudSave.reconcile(null);
  A.ok(CloudSave.isUnknownSentinel(cacheFailure), 'a remote that fails migration cannot fall through to onboarding');
  A.eq(cacheFailure.reason, 'cache', 'a migration failure does not falsely diagnose a disconnected server');

  // a stale CLEAN local + a newer remote the cache cannot hold: the newer remote wins, from memory, at its revision;
  // the superseded cache entry is dropped so neither a re-entry nor the next boot can resume it
  const staleLocal = { ...doc(100), _saveRevision: 1 };
  const newerRemote = { ...doc(200), _saveRevision: 5, agent: { id: 'agent', name: 'NOVA-2' } };
  nextPull = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ save: newerRemote }) });
  global.Save = RealSave;
  removed.length = 0;
  const staleRaw = JSON.stringify(staleLocal);
  global.localStorage.getItem = () => staleRaw;
  const resumed = await CloudSave.reconcile(staleLocal);
  A.eq(resumed && resumed.agent && resumed.agent.name, 'NOVA-2', 'a failed cache write resumes the newer station file, not the stale local copy');
  A.eq(CloudSave.revision(), 5, 'the resumed station builds on the station file revision');
  // (with its merge description beside it, if any: save-latch-kill cloudsave writeSide — a copy and its description go together)
  A.eq(removed, ['starnet.save', 'starnet.save.merge'], 'the superseded clean cache entry is removed');

  // ...but when that newer remote fails migration, the original local snapshot is kept at its own revision
  global.Save = { CURRENT: 5, load: () => staleLocal, fromDoc: () => ({ status: 'error', doc: null, version: 0 }) };
  A.eq(await CloudSave.reconcile(staleLocal), staleLocal, 'a remote that fails migration retains the original local snapshot');
  A.eq(CloudSave.revision(), 1, 'failed adoption cannot rebase a stale cache onto the newer durable revision');

  A.report('cloudsave-unknown');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exit(1); });
