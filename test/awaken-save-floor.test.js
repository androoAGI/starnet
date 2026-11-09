/* node test/awaken-save-floor.test.js — the terminal awakening's save names its writer, so the floor it saves routes.

   The saved floor is the routing authority (sidecar/routing/saved-authority.js), and the station vouches only a save that names the window
   that wrote it (savestore vouchedHead: the wrapper's revision and client). The app's window names itself on every save (cloudsave.js
   _saveClient); bin/lib/awaken.js did not, so a station set up from the terminal and never opened in the app saved a floor that read as
   INVALID (no wrapper revision), and every routine, channel message and line it was asked to run was held. Locks: every save the awakening
   posts names one writer for the whole awakening · each lands in the REAL save owner the way POST /api/save writes it (compareRevision) ·
   the real saved authority reads the floor it left as one that routes · control: the same save with no writer is held, invalid. A fake
   station around the real SaveStore; no sidecar. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');
const am = require('../bin/lib/app-modules.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { makeSavedAuthority } = require('../sidecar/routing/saved-authority.js');

const ownerAt = root => {
  const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });
  const authority = makeSavedAuthority({ read: { agentId: 'agent', stamp: () => store.stamp('agent'), loadPrimaryState: () => store.loadPrimaryState('agent'), hasRecoveryCopy: () => store.hasRecoveryCopy('agent') } });
  return { store, authority };
};

async function awaken(store) {
  const M = am.load();
  const saves = [], landed = [];
  let clock = 1800000000000;
  const answer = (json, status) => ({ ok: status == null || status < 400, status: status || 200, json });
  const st = {
    async get(p) {
      if (p === '/api/save?agent=agent') return answer({ save: store.load('agent') || null });
      if (p === '/api/providers') return answer({ providers: [{ id: 'openrouter', name: 'OpenRouter', configured: true }] });
      if (p === '/api/models/openrouter') return answer({ models: [{ id: 'm/one' }], default: 'm/one' });
      if (p === '/api/permissions') return answer({ grants: [], masterBypass: false });
      if (p === '/api/autonomy/posture') return answer({ summary: M.Autonomy.fresh() });
      return answer({}, 404);
    },
    async post(p, body) {
      // POST /api/save, as sidecar/index.js handleSaveWrite writes it: the real save owner, on the revision the body names
      if (p === '/api/save') { saves.push(JSON.parse(JSON.stringify(body))); const r = store.save('agent', JSON.parse(JSON.stringify(body)), { compareRevision: true }); landed.push(r); return answer(r); }
      return answer({ ok: true });
    },
    async chat(c) { return /Reply with exactly: OK/.test(String(c.directive || '')) ? { text: 'OK' } : { error: 'the provider returned an error' }; },
    open() { return true; }
  };
  const opt = re => ({ re });
  const script = [opt(/^Give it a station codename/), opt(/^Composed/), opt(/^Ask for approval/), opt(/OpenRouter — already connected/), opt(/^m\/one/), opt(/^Let’s talk it through/), opt(/^Code & build/), opt(/^Wait for me/), opt(/^Start with one room/)];
  const io = {
    stage() {}, speaker() {}, note() {}, feed() {}, roster() {}, async say() {},
    async ask(spec) {
      const pick = script.shift();
      if (!pick) throw new Error('the script ran out');
      const choice = (spec.options || []).find(x => pick.re.test(x.label) || pick.re.test(String(x.value)));
      if (!choice) throw new Error('no option ' + pick.re + ' among ' + (spec.options || []).map(x => x.label).join(' | '));
      return Object.assign({}, choice);
    }
  };
  const aw = require('../bin/lib/awaken.js').makeAwakening({ st, io, mods: M, now: () => (clock += 300), sleep: () => new Promise(r => setImmediate(r)) });
  const res = await aw.run({ save: null, resume: false, privateStation: true });
  return { res, saves, landed };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awaken-save-floor-'));
  try {
    const { store, authority } = ownerAt(root);
    A.eq(authority.status().state, 'unfloored', 'fixture: a workspace with no save is a new install (nothing to route, nothing held)');
    const r = await awaken(store);
    A.ok(r.res.ok, 'the awakening completes');
    const writers = [...new Set(r.saves.map(s => s._saveClient))];
    A.ok(r.saves.length >= 2 && writers.length === 1 && /^terminal-[A-Za-z0-9_-]{1,71}$/.test(String(writers[0])), 'every save the awakening posts names one writer, the same for the whole awakening: ' + JSON.stringify(writers));
    A.ok(r.landed.length === r.saves.length && r.landed.every(x => x && x.ok === true), 'each save lands in the real save owner (POST /api/save\'s compareRevision write): ' + JSON.stringify(r.landed.map(x => x && x.ok)));
    const last = r.saves[r.saves.length - 1];
    A.ok(last.schema === 'starnet.save' && last.station && last.station.schema === 'starnet.station', 'the last save carries the save envelope and the station floor the awakening built');
    const status = authority.status();
    A.eq([status.state, status.status], ['ok', 'ok'], 'the saved authority reads the floor the terminal saved as one that routes (no hold)');
    A.ok(authority.require().routingOk === true, 'and the dispatch gate (require) lets work through');

    // control: the same save without its writer is one the station cannot vouch, so its floor is held (invalid) — what every terminal-made
    // station saved before; the writer is what makes it route
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'awaken-save-floor-bare-'));
    try {
      const control = ownerAt(bare);
      const doc = JSON.parse(JSON.stringify(last)); delete doc._saveClient; doc._saveRevision = 0;
      A.ok(control.store.save('agent', doc, { compareRevision: true }).ok === true, 'control: the writerless save is accepted (200)');
      const held = control.authority.status();
      A.eq([held.state, held.status], ['held', 'invalid'], 'control: ...and its floor is held, invalid');
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.report('awaken-save-floor.test');
})().catch(e => { A.ok(false, 'threw: ' + ((e && e.stack) || e)); A.report('awaken-save-floor.test'); });
