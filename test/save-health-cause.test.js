/* test/save-health-cause.test.js — the save light names WHY the newest save is not in the station file (wave-1
   save-latch-kill; quick win 11; gh#121, starnet-releases#4).

   Before: a save body over the station file's 16 MiB cap was answered 400 'bad json', every failed station-file write was
   answered 400 with its text, and after three failures the save light said "check disk space / folder permissions" for all
   of them — on machines with plenty of disk. Now:
     a. CloudSaveCore.causeOf names each failed attempt from what the station answered (or that it did not answer);
     b. POST /api/save (and /api/save/adopt) answers an over-cap body with a NAMED 413 { tooLarge } — read by the REAL bounded
        body reader (sidecar/http-body.js), the station file untouched;
     c. a failed write carries its errno; only ENOSPC (diskFull) and EPERM/EACCES (diskDenied) are disk causes;
     d. the REAL page (cloudsave.js) records the cause, and the REAL save light (stationui.js) says "too large" on the first
        refusal of a >16 MiB station, names the disk only for a disk errno, and never blames the disk for a locked file or a
        silent station.
   Drives the real modules through test/_save-restore-kit.js: never boots a sidecar, every workspace a fresh temp dir. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const K = require('./_save-restore-kit.js');
const Core = require('../frontend/app/cloudsavecore.js');
const SaveWire = require('../sidecar/save-wire.js');
const { sidecarFunctionSource } = require('./helpers/source');

// ---- a. the cause table (pure) ----
{
  const c = (answered, status, body) => Core.causeOf({ answered, status, body });
  A.eq(c(false), 'offline', 'a: no answer at all is "offline" — never the disk');
  A.eq(c(true, 413, { error: 'request body too large' }), 'tooLarge', 'a: a 413 is "too large" whatever its body says');
  A.eq(c(true, 413, null), 'tooLarge', 'a: a 413 whose body did not parse is still "too large"');
  A.eq(c(true, 500, { ok: false, code: 'ENOSPC', cause: 'diskFull' }), 'diskFull', 'a: ENOSPC is the full disk');
  A.eq(c(true, 500, { ok: false, code: 'EPERM' }), 'diskDenied', 'a: EPERM is the folder refusing the write');
  A.eq(c(true, 500, { ok: false, code: 'EACCES' }), 'diskDenied', 'a: EACCES is the folder refusing the write');
  A.eq(c(true, 500, { ok: false, code: 'EBUSY' }), 'writeFailed', 'a: a locked file (EBUSY) is a failed write, never the disk');
  A.eq(c(true, 200, { ok: false, conflict: true }), 'conflict', 'a: a conflict refusal');
  A.eq(c(true, 200, { ok: false, degraded: true }), 'degraded', 'a: a newer StarNet\'s workspace');
  A.eq(c(true, 200, { ok: false, stale: true, unreadable: true }), 'unreadable', 'a: an unreadable station file');
  A.eq(c(true, 200, { ok: false, growthStale: true }), 'growthStale', 'a: a rating catch-up refusal');
  A.eq(c(true, 503, { ok: false, growthUnavailable: true }), 'growthUnavailable', 'a: rating history unavailable');
  A.eq(c(true, 403, { error: 'forbidden' }), 'forbidden', 'a: an auth refusal');
  A.eq(c(true, 500, null), 'refused', 'a: an unnamed 500 is a refusal, never the disk');
  for (const k of Core.CAUSES) {
    const words = Core.describeCause(k);
    A.ok(typeof words === 'string' && words.length > 10, 'a: every cause has words (' + k + ')');
    A.eq(/disk/i.test(words), k === 'diskFull', 'a: only diskFull names the disk (' + k + ': ' + words + ')');
    A.eq(/permission|folder/i.test(words), k === 'diskDenied', 'a: only diskDenied names the folder\'s permissions (' + k + ')');
  }
  const h = Core.recordFailure(Core.freshHealth(), 1000, 'diskFull');
  A.eq(Core.snapshot(h, 1000).cause, 'diskFull', 'a: the health snapshot carries the cause');
  A.eq(Core.snapshot(Core.recordSuccess(h, 2000), 2000).cause, null, 'a: a landed save clears it');
  A.eq(Core.recordFailure(Core.freshHealth(), 1000).cause, 'offline', 'a: an unnamed failure is "offline"');
  A.eq(Core.recordFailure(Core.freshHealth(), 1000, 'not-a-cause').cause, 'offline', 'a: an unknown name is never passed through');
}

const turn = K.turn;
const doc = over => K.stationDoc(Object.assign({ updatedAt: Date.now() }, over || {}));
const big = () => doc({ workstreams: [{ id: 'general', title: null, history: [turn('user', 'x'.repeat((16 << 20) + 1024))] }] });
// what App.persist does: the window's state, stamped with this page's revision and writer, into the cache, then queued
function persist(cs, cache, d) {
  const out = Object.assign(JSON.parse(JSON.stringify(d)), { _saveDirty: true, _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: Date.now() });
  cache.set('starnet.save', JSON.stringify(out)); cs.push(out);
  return out;
}

// an fs facade whose station-file write fails with `code` (the main file only: conflict copies, backups still write)
function failingFs(code, armed) {
  return new Proxy(fs, { get(t, k) {
    if (k === 'renameSync') return function (from, to) {
      if (armed.on && path.basename(String(to)) === 'agent.save.json') { const e = new Error(code + ': simulated write failure'); e.code = code; throw e; }
      return t.renameSync.apply(t, arguments);
    };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
}

(async () => {
  try {
    // ---- b. the named 413, through the REAL bounded body reader ----
    A.eq(SaveWire.SAVE_BODY_MAX, 16 << 20, 'b: the cap is 16 MiB');
    for (const name of ['handleSaveWrite', 'handleSaveAdopt']) {
      const fn = sidecarFunctionSource(name);
      A.ok(/readBody\(req, 16 << 20\)/.test(fn) && /e\.tooLarge\) \? json\(413, SaveWire\.tooLargeReply\(\)\)/.test(fn), 'b: ' + name + ' reads at the 16 MiB cap and answers its overflow with the named 413');
    }
    {
      const root = K.workspace();
      const host = K.sidecar(root, { realBody: true });
      const r = await host.fetch('/api/save', { method: 'POST', body: JSON.stringify(big()) });
      const body = await r.json();
      A.eq(r.status, 413, 'b: a >16 MiB save is answered 413, not 400 \'bad json\'');
      A.eq(body.tooLarge, true, 'b: …and says it is too large');
      A.eq(body.limitBytes, 16 << 20, 'b: …naming the cap');
      A.ok(/16 MiB/.test(String(body.error)), 'b: …in words');
      A.ok(!fs.existsSync(path.join(root, 'agent.save.json')), 'b: the station file is untouched');
      const a = await host.fetch('/api/save/adopt', { method: 'POST', body: JSON.stringify(big()) });
      A.eq(a.status, 413, 'b: POST /api/save/adopt answers the same named 413');
      // an ordinary save still lands through the real reader
      const ok = await host.fetch('/api/save', { method: 'POST', body: JSON.stringify(doc()) });
      A.eq((await ok.json()).ok, true, 'b: an ordinary save still lands through the real body reader');
    }

    // ---- c. a failed write carries its errno; only ENOSPC / EPERM / EACCES name the disk ----
    for (const [code, cause] of [['ENOSPC', 'diskFull'], ['EPERM', 'diskDenied'], ['EACCES', 'diskDenied'], ['EBUSY', undefined]]) {
      const root = K.workspace();
      const armed = { on: true };
      const host = K.sidecar(root, { fs: failingFs(code, armed) });
      const r = await host.fetch('/api/save', { method: 'POST', body: JSON.stringify(doc()) });
      const body = await r.json();
      A.eq(r.status, 500, 'c: a failed station-file write (' + code + ') is the station\'s own failure (5xx)');
      A.eq(body.ok, false, 'c: …refused, ok:false');
      A.eq(body.code, code, 'c: …carrying its errno');
      A.eq(body.cause, cause, 'c: …' + (cause ? 'named ' + cause : 'never named as the disk'));
    }

    // ---- d. the REAL page records the cause; the REAL save light says it ----
    {
      // a >16 MiB station: "too large" on the FIRST refusal, never the disk
      const root = K.workspace();
      const host = K.sidecar(root, { realBody: true });
      const cache = new Map(); const cs = K.page(host, cache);
      await cs.reconcile(null);
      persist(cs, cache, big());
      A.eq(await cs.flush({ force: true }), false, 'd: the page\'s >16 MiB save is refused');
      A.eq(cs.health().cause, 'tooLarge', 'd: the page records why: tooLarge');
      const light = K.stationUi(cs).light();
      A.ok(/too large/i.test(light.title), 'd: the save light says "too large" on the first refusal — got: ' + light.title);
      A.ok(!/disk/i.test(light.title), 'd: …and never blames the disk');
      A.ok(/16 MiB/.test(light.title), 'd: …naming the cap');
    }
    for (const [code, re, label] of [['ENOSPC', /disk .*full/i, 'the full disk'], ['EPERM', /folder refused/i, 'the folder'], ['EBUSY', /could not be written/i, 'a failed write']]) {
      const root = K.workspace();
      const armed = { on: true };
      const host = K.sidecar(root, { fs: failingFs(code, armed) });
      const cache = new Map(); const cs = K.page(host, cache);
      await cs.reconcile(null);
      for (let i = 0; i < 3; i++) { persist(cs, cache, doc({ updatedAt: Date.now() + i })); A.eq(await cs.flush({ force: true }), false, 'd: ' + code + ' attempt ' + (i + 1) + ' is refused'); }
      A.eq(cs.health().consecutiveFailures, 3, 'd: three failures in a row (the light\'s warn line)');
      const title = K.stationUi(cs).light().title;
      A.ok(re.test(title), 'd: ' + code + ': the save light names ' + label + ' — got: ' + title);
      if (code === 'EBUSY') A.ok(!/disk|permission/i.test(title), 'd: a locked file is never called the disk — got: ' + title);
      A.ok(!/check disk space/i.test(title), 'd: the old blanket "check disk space" line is gone');
      // the station recovers: the next save lands and the cause clears
      armed.on = false;
      persist(cs, cache, doc({ updatedAt: Date.now() + 10 }));
      A.eq(await cs.flush({ force: true }), true, 'd: ' + code + ': once the write can land, it lands');
      A.eq(cs.health().cause, null, 'd: …and the cause clears');
      A.eq(K.stationUi(cs).light().title, 'autosave', 'd: …and the light is back to autosave');
    }
    {
      // the station never answers: "did not answer", never the disk
      const cache = new Map();
      const host = { fetch: () => Promise.reject(new TypeError('Failed to fetch')) };
      const cs = K.page(host, cache);
      for (let i = 0; i < 3; i++) { persist(cs, cache, doc({ updatedAt: Date.now() + i })); await cs.flush({ force: true }); }
      A.eq(cs.health().cause, 'offline', 'd: no answer is recorded as offline');
      const title = K.stationUi(cs).light().title;
      A.ok(/did not answer/.test(title) && !/disk/i.test(title), 'd: the light says the station did not answer, not the disk — got: ' + title);
    }
  } catch (e) { A.ok(false, 'threw: ' + (e && e.stack || e)); }
  finally { K.cleanup(); }
  A.report('save-health-cause');
})();
