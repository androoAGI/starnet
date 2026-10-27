/* test/save-journal.test.js — each window's browser copy is its own crash journal (wave-1 save-latch-kill; qa/bugs 27bae3d6).

   Two tabs of one browser share localStorage. The whole save used to live under the one key 'starnet.save', so a tab
   reloaded while another ran booted THAT tab's stale snapshot as its own work, and any tab's persist overwrote a crashed
   tab's unsent save. Now (frontend/app/save.js key()/useKey(), cloudsave.js openJournal()):
     a. save.js reads and writes the key it is given, and only a journal key;
     b. openJournal() never takes a LIVE page's journal; a reloaded tab continues its own (sessionStorage); a fresh tab with
        no dead journal and the legacy key live takes a key of its own;
     c. a DEAD window's other journal is merged into the station (POST /api/save/adopt) before this page boots, and removed —
        but never when it changed since it was read (a busy tab that answered late), and a clean one only once the station
        file has been read;
     d. a backup carries THIS window's save under 'starnet.save' and no other window's journal; an import lands in this
        window's journal, never over another window's.
   Real cloudsave.js + save.js + backup.js in vms; the station is the real handlers + savestore (test/_save-restore-kit.js). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const K = require('./_save-restore-kit.js');

const repo = path.join(__dirname, '..');
const saveSrc = fs.readFileSync(path.join(repo, 'frontend/app/save.js'), 'utf8');
const backupSrc = fs.readFileSync(path.join(repo, 'frontend/app/backup.js'), 'utf8');
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const settle = () => new Promise(r => setImmediate(r));

// one browser: a localStorage over a Map and a BroadcastChannel hub
function browser() {
  const cache = new Map(), members = new Set();
  const ls = { getItem: k => (cache.has(k) ? cache.get(k) : null), setItem: (k, v) => cache.set(k, String(v)), removeItem: k => cache.delete(k),
    get length() { return cache.size; }, key: i => Array.from(cache.keys())[i] || null };
  function Channel(name) { this.name = name; this.fns = new Set(); this.open = true; members.add(this); }
  Channel.prototype.addEventListener = function (t, fn) { if (t === 'message') this.fns.add(fn); };
  Channel.prototype.removeEventListener = function (t, fn) { this.fns.delete(fn); };
  Channel.prototype.postMessage = function (data) { const msg = JSON.parse(JSON.stringify(data)); for (const m of members) if (m !== this && m.open) setImmediate(() => { if (m.open) for (const fn of Array.from(m.fns)) fn({ data: msg }); }); };
  Channel.prototype.close = function () { this.open = false; };
  return { cache, ls, Channel, members };
}
// a page: the real save.js + cloudsave.js against the browser and the station host; o.session: its sessionStorage (a Map)
let ids = 0;
function page(b, host, o) {
  o = o || {};
  const session = o.session || new Map();
  const ctx = { console: quiet, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout, clearTimeout, AbortController,
    localStorage: b.ls, BroadcastChannel: b.Channel, crypto: { randomUUID: () => 'page' + (++ids) },
    sessionStorage: { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: k => session.delete(k) },
    location: { reload() {} }, fetch: (u, init) => host.fetch(u, init) };
  vm.createContext(ctx);
  vm.runInContext(saveSrc + '\n;globalThis.Save = Save;', ctx);
  ctx.module = { exports: {} };
  vm.runInContext(fs.readFileSync(path.join(repo, 'frontend/app/cloudsave.js'), 'utf8') + '\n;globalThis.CloudSave = CloudSave;', ctx);
  return { ctx, Save: ctx.Save, cs: ctx.CloudSave, session, channel: () => Array.from(b.members).pop() };
}
const station = (over) => K.stationDoc(Object.assign({ updatedAt: Date.now() }, over || {}));
const turn = K.turn;

(async () => {
  try {
    // ---- a. save.js ----
    {
      const b = browser(); const p = page(b, { fetch: async () => { throw new Error('offline'); } });
      A.eq(p.Save.key(), 'starnet.save', 'a: before a journal is opened, the legacy key, as before');
      A.eq(p.Save.useKey('starnet.save.w.abc_1-2'), 'starnet.save.w.abc_1-2', 'a: a window journal key is taken');
      A.eq(p.Save.useKey('starnet.settings'), 'starnet.save.w.abc_1-2', 'a: anything else is not a journal key: ignored');
      p.Save.write({ agent: { id: 'agent', name: 'NOVA' } });
      A.ok(b.cache.has('starnet.save.w.abc_1-2') && !b.cache.has('starnet.save'), 'a: Save.write writes this window\'s journal only');
      A.eq(p.Save.load() && p.Save.load().agent.name, 'NOVA', 'a: Save.load reads it back');
    }

    // ---- b. picking the journal ----
    {
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const b = browser();
      const first = page(b, host);
      A.eq(await first.cs.openJournal(), 'starnet.save', 'b: the first window of a browser takes the legacy key');
      first.Save.write(Object.assign(station(), { _saveDirty: false }));
      const second = page(b, host);
      const k2 = await second.cs.openJournal();
      A.ok(k2 !== 'starnet.save' && /^starnet\.save\.w\./.test(k2), 'b: a second tab, while the first is live, takes a journal of its own (' + k2 + ')');
      second.Save.write(Object.assign(station(), { _saveDirty: true, workstreams: [{ id: 'general', title: null, history: [turn('user', 'second tab work')] }] }));
      // the second tab reloads: its page dies (stops answering) and a new page of the same tab (same sessionStorage) boots
      second.channel().close();
      const again = page(b, host, { session: second.session });
      A.eq(await again.cs.openJournal(), k2, 'b: a reloaded tab continues ITS OWN journal');
      A.ok(again.Save.load() && JSON.stringify(again.Save.load()).includes('second tab work'), 'b: and reads its own save from it');
      A.eq(first.cs.journalKey(), 'starnet.save', 'b: the live first tab kept its journal throughout');
    }

    // ---- c. another dead window's journal: merged into the station, then removed (unless it changed) ----
    {
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const rev = host.saveStore.load('agent')._saveRevision;
      const b = browser();
      // two windows died: one left unsent work, one a clean copy
      b.cache.set('starnet.save.w.deadA', JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: 'deadA', updatedAt: Date.now() + 5,
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'unsent', title: 'U', history: [turn('user', 'dead window A typed this')] }] })));
      b.cache.set('starnet.save.w.deadB', JSON.stringify(station({ _saveDirty: false, _saveRevision: rev, _saveClient: 'deadB', updatedAt: Date.now() + 10 })));
      const p = page(b, host);
      const k = await p.cs.openJournal();
      A.eq(k, 'starnet.save.w.deadB', 'c: the page continues the newest dead journal');
      A.ok(host.saveStore.load('agent').workstreams.some(w => w.id === 'unsent'), 'c: the other dead window\'s unsent work was merged into the station before boot');
      A.ok(!b.cache.has('starnet.save.w.deadA'), 'c: and its journal removed');
      await p.cs.reconcile(p.Save.load());
      A.ok(b.cache.has('starnet.save.w.deadB'), 'c: the continued journal stays (it is this page\'s now)');
    }
    {
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const rev = host.saveStore.load('agent')._saveRevision;
      const b = browser();
      b.cache.set('starnet.save.w.busy', JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: 'busy', updatedAt: Date.now() + 1,
        workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'b1', title: 'B', history: [turn('user', 'busy one')] }] })));
      b.cache.set('starnet.save.w.mine', JSON.stringify(station({ _saveDirty: false, _saveRevision: rev, updatedAt: Date.now() + 9 })));
      // the "dead" window was only busy: it writes again while the merge of what it held is on its way
      const slow = { fetch: async (u, init) => {
        if (String(u) === '/api/save/adopt') b.cache.set('starnet.save.w.busy', JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: 'busy', updatedAt: Date.now() + 2,
          workstreams: [{ id: 'general', title: null, history: [turn('user', 'hi')] }, { id: 'b1', title: 'B', history: [turn('user', 'busy one'), turn('user', 'busy two, after the read')] }] })));
        return host.fetch(u, init);
      } };
      const p = page(b, slow);
      await p.cs.openJournal();
      A.ok(b.cache.has('starnet.save.w.busy') && b.cache.get('starnet.save.w.busy').includes('busy two, after the read'), 'c: a journal that changed since it was read is never removed');
    }
    {
      // a clean dead journal is removed only once the station file has been read
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const b = browser();
      b.cache.set('starnet.save.w.old', JSON.stringify(station({ _saveDirty: false, updatedAt: 1 })));
      b.cache.set('starnet.save.w.new', JSON.stringify(station({ _saveDirty: false, updatedAt: 2 })));
      const off = page(b, { fetch: async () => { throw new Error('offline'); } });
      await off.cs.openJournal(); await off.cs.reconcile(off.Save.load());
      A.ok(b.cache.has('starnet.save.w.old'), 'c: the station could not be read: a clean dead journal is kept');
      const on = page(b, host);
      await on.cs.openJournal(); await on.cs.reconcile(on.Save.load());
      // `off` is still live (it answers for w.new), so `on` continued w.old or took its own; the other clean one is gone once read
      const left = Array.from(b.cache.keys()).filter(k => /^starnet\.save/.test(k));
      A.ok(left.length <= 2 && left.includes(on.cs.journalKey()) && left.includes(off.cs.journalKey()), 'c: once the station is read, only the live pages\' journals remain (' + left + ')');
    }

    // ---- d. a backup carries THIS window's save; an import lands in this window's journal ----
    {
      const b = browser();
      const host = { fetch: async () => { throw new Error('offline'); } };
      const p = page(b, host);
      p.Save.useKey('starnet.save.w.mine');
      b.cache.set('starnet.save.w.mine', JSON.stringify(station({ agent: { id: 'agent', name: 'MINE', createdAt: 5000 } })));
      b.cache.set('starnet.save.w.other', JSON.stringify(station({ agent: { id: 'agent', name: 'OTHER', createdAt: 5000 } })));
      b.cache.set('starnet.save', JSON.stringify(station({ agent: { id: 'agent', name: 'LEGACY-OTHER', createdAt: 5000 } })));
      b.cache.set('starnet.theme', 'dark');
      p.ctx.module = { exports: {} };
      vm.runInContext(backupSrc + '\n;globalThis.Backup = Backup;', p.ctx);
      const store = p.ctx.Backup.collectStore();
      A.eq(JSON.parse(store['starnet.save']).agent.name, 'MINE', 'd: the backup carries THIS window\'s save as the station');
      A.ok(!Object.keys(store).some(k => /^starnet\.save\.w\./.test(k)), 'd: and no window\'s journal key');
      A.eq(store['starnet.theme'], 'dark', 'd: other records ride along as before');
      const r = p.ctx.Backup.applyBundle({ schema: 'starnet.backup', version: 1, store: { 'starnet.save': JSON.stringify(station({ agent: { id: 'agent', name: 'IMPORTED', createdAt: 5000 } })), 'starnet.save.w.other': 'x', 'starnet.theme': 'light' } });
      A.ok(r && r.ok === true, 'd: the import applies (' + JSON.stringify(r) + ')');
      A.eq(JSON.parse(b.cache.get('starnet.save.w.mine')).agent.name, 'IMPORTED', 'd: the imported station lands in THIS window\'s journal');
      A.eq(JSON.parse(b.cache.get('starnet.save.w.other')).agent.name, 'OTHER', 'd: never over another window\'s journal');
      A.eq(JSON.parse(b.cache.get('starnet.save')).agent.name, 'LEGACY-OTHER', 'd: nor over the legacy key another window writes');
    }
  } catch (e) { A.ok(false, 'threw: ' + (e && e.stack || e)); }
  finally { K.cleanup(); }
  await settle();
  A.report('save-journal');
})();
