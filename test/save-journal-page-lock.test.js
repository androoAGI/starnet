/* test/save-journal-page-lock.test.js — a page alone in its browser opens its journal without waiting (0.14.3 boot lag).

   0.14.2's openJournal (923f03a98) waited a fixed 250 ms on every launch and reload: silence on the channel was the only way to
   learn that no other page was alive, and the desktop app's one window never hears an answer. Every page now holds a shared Web
   Lock for its life (cloudsave.js aloneHere). What the wait protected must still hold:
     a. alone: no 250 ms timer is armed, and the page continues its journal;
     b. a live page holding the lock: the ping still runs, and that page's journal is never taken;
     c. no Web Locks, a refused lock, a lock list that throws or never answers: the ping decides, as before, and boot never hangs;
     d. a dead window's lock is gone with it: its journal is continued and its unsent work still reaches the station;
     e. a live page of a build from before the lock (it holds none, and answers the ping): this page moves off its journal;
     f. the whole save is parsed once less when the one journal is this page's whatever it holds, and never when a choice remains.
   Real cloudsave.js + save.js in vms; the station is the real handlers + savestore (test/_save-restore-kit.js). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const K = require('./_save-restore-kit.js');

const repo = path.join(__dirname, '..');
const saveSrc = fs.readFileSync(path.join(repo, 'frontend/app/save.js'), 'utf8');
const cloudSrc = fs.readFileSync(path.join(repo, 'frontend/app/cloudsave.js'), 'utf8');
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const settle = () => new Promise(r => setImmediate(r));
const offline = { fetch: async () => { throw new Error('offline'); } };

// one browser: a localStorage over a Map, a BroadcastChannel hub and a Web Locks manager over a list of holders
function browser() {
  const cache = new Map(), members = new Set(), held = [];
  const ls = { getItem: k => (cache.has(k) ? cache.get(k) : null), setItem: (k, v) => cache.set(k, String(v)), removeItem: k => cache.delete(k),
    get length() { return cache.size; }, key: i => Array.from(cache.keys())[i] || null };
  function Channel(name) { this.name = name; this.fns = new Set(); this.open = true; members.add(this); }
  Channel.prototype.addEventListener = function (t, fn) { if (t === 'message') this.fns.add(fn); };
  Channel.prototype.removeEventListener = function (t, fn) { this.fns.delete(fn); };
  Channel.prototype.postMessage = function (data) { const msg = JSON.parse(JSON.stringify(data)); for (const m of members) if (m !== this && m.open) setImmediate(() => { if (m.open) for (const fn of Array.from(m.fns)) fn({ data: msg }); }); };
  Channel.prototype.close = function () { this.open = false; };
  const locksFor = owner => ({
    request: (name, o, cb) => { const h = { name, mode: o && o.mode, owner }; held.push(h); return Promise.resolve().then(() => cb(h)); },
    query: async () => ({ held: held.map(h => ({ name: h.name, mode: h.mode })), pending: [] }),
  });
  return { cache, ls, Channel, members, held, locksFor };
}
// a page: o.navigator overrides what it sees (null: no navigator at all); o.noLock: a page of a build from before the lock
let ids = 0;
function page(b, host, o) {
  o = o || {};
  const session = o.session || new Map(), id = o.id || ('lockpage' + (++ids));
  const armed = [];
  const stamp = (fn, ms) => { armed.push(ms); return setTimeout(fn, ms); };
  let parses = 0;
  const countingJSON = Object.create(JSON);
  countingJSON.parse = (s, r) => { if (typeof s === 'string' && s.length > 2000) parses++; return JSON.parse(s, r); };
  const ctx = { console: quiet, module: { exports: {} }, require: () => require('../frontend/app/cloudsavecore.js'), setTimeout: stamp, clearTimeout, AbortController,
    localStorage: b.ls, BroadcastChannel: b.Channel, crypto: { randomUUID: () => id }, JSON: countingJSON,
    sessionStorage: { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: k => session.delete(k) },
    location: { reload() {} }, fetch: (u, init) => host.fetch(u, init) };
  if (o.navigator !== null) ctx.navigator = o.navigator || { locks: b.locksFor(id) };
  vm.createContext(ctx);
  vm.runInContext(saveSrc + '\n;globalThis.Save = Save;', ctx);
  ctx.module = { exports: {} };
  vm.runInContext(cloudSrc + '\n;globalThis.CloudSave = CloudSave;', ctx);
  const channel = Array.from(b.members).pop();
  return { ctx, Save: ctx.Save, cs: ctx.CloudSave, session, armed, id, channel, parses: () => parses, resetParses: () => { parses = 0; },
    die() { channel.close(); for (let i = b.held.length - 1; i >= 0; i--) if (b.held[i].owner === id) b.held.splice(i, 1); } };
}
const station = over => K.stationDoc(Object.assign({ updatedAt: Date.now() }, over || {}));
const big = () => 'x'.repeat(4000);   // big enough for the parse counter to see it

(async () => {
  try {
    // ---- a. alone: no wait ----
    {
      const b = browser();
      b.cache.set('starnet.save', JSON.stringify(station()));
      const p = page(b, offline);
      A.eq(await p.cs.openJournal(), 'starnet.save', 'a: a page alone continues its journal');
      A.ok(p.armed.filter(ms => ms === 250).length <= 1, 'a: at most the lock read guard is armed, never the ping\'s wait (' + p.armed + ')');
      A.eq(b.held.filter(h => h.name === 'starnet-page').length, 1, 'a: it holds the page lock');
      A.eq(b.held[0].mode, 'shared', 'a: shared, so no page ever waits for another\'s');
    }
    {
      // the wait itself: openJournal must finish well before a 250 ms timer could fire, so it is run against a clock that never fires
      const b = browser();
      b.cache.set('starnet.save', JSON.stringify(station()));
      const p = page(b, offline);
      p.ctx.setTimeout = () => 0;   // nothing armed from here on ever fires
      let done = false;
      const opening = p.cs.openJournal().then(k => { done = true; return k; });
      for (let i = 0; i < 8; i++) await settle();
      A.ok(done, 'a: openJournal finished with no timer firing: the fixed 250 ms wait is gone for a page alone');
      A.eq(await opening, 'starnet.save', 'a: and it took the journal');
    }
    {
      // first run: no journal at all, so nothing to ask anyone
      const b = browser();
      const p = page(b, offline);
      A.eq(await p.cs.openJournal(), 'starnet.save', 'a: a first run takes the legacy key');
    }
    {
      // a reload: the old page's lock is gone, and the new page of the tab continues its own journal without waiting
      const b = browser();
      b.cache.set('starnet.save.w.mine', JSON.stringify(station()));
      const session = new Map([['starnet.save.journal', 'starnet.save.w.mine']]);
      const p = page(b, offline, { session });
      p.ctx.setTimeout = () => 0;
      let done = false;
      p.cs.openJournal().then(() => { done = true; });
      for (let i = 0; i < 8; i++) await settle();
      A.ok(done, 'a: a reload does not wait either');
      A.eq(p.cs.journalKey(), 'starnet.save.w.mine', 'a: a reloaded tab continues its own journal');
    }

    // ---- b. another live page: the ping still runs and its journal is never taken ----
    {
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const b = browser();
      const first = page(b, host);
      A.eq(await first.cs.openJournal(), 'starnet.save', 'b: the first window takes the legacy key');
      first.Save.write(Object.assign(station(), { _saveDirty: false }));
      const second = page(b, host);
      const k2 = await second.cs.openJournal();
      A.ok(second.armed.filter(ms => ms === 250).length >= 2, 'b: with another holder the ping ran its wait (' + second.armed + ')');
      A.ok(k2 !== 'starnet.save' && /^starnet\.save\.w\./.test(k2), 'b: a second tab takes a journal of its own (' + k2 + ')');
      A.eq(first.cs.journalKey(), 'starnet.save', 'b: the live first tab kept its journal');
    }
    {
      // duplicated tab: same sessionStorage, the original alive. The lock shows it, so the ping runs and the journal stays the original's.
      const b = browser();
      const session = new Map();
      const original = page(b, offline, { session });
      await original.cs.openJournal();
      original.Save.write(Object.assign(station(), { _saveDirty: false }));
      const copy = page(b, offline, { session: new Map(session) });
      const k = await copy.cs.openJournal();
      A.ok(k !== original.cs.journalKey(), 'b: a duplicated tab never shares the original\'s journal (' + k + ')');
    }

    // ---- c. every way the lock can fail: the ping decides, and boot never hangs ----
    const failures = [
      ['no navigator', () => null],
      ['no Web Locks', () => ({})],
      ['a refused lock', () => ({ locks: { request: () => Promise.reject(new Error('SecurityError')), query: async () => ({ held: [] }) } })],
      ['a request that throws', () => ({ locks: { request: () => { throw new Error('nope'); }, query: async () => ({ held: [] }) } })],
      ['a lock list that throws', () => ({ locks: { request: (n, o, cb) => { cb(); return new Promise(() => {}); }, query: async () => { throw new Error('nope'); } } })],
      ['a lock list that never answers', () => ({ locks: { request: (n, o, cb) => { cb(); return new Promise(() => {}); }, query: () => new Promise(() => {}) } })],
      ['a lock never granted', () => ({ locks: { request: () => new Promise(() => {}), query: async () => ({ held: [] }) } })],
    ];
    for (const [what, nav] of failures) {
      const b = browser();
      const live = page(b, offline);                 // a live page, answering pings, holding the real lock
      await live.cs.openJournal();
      live.Save.write(Object.assign(station(), { _saveDirty: false }));
      const p = page(b, offline, { navigator: nav() });
      const k = await p.cs.openJournal();
      A.ok(p.armed.includes(250), what + ': the ping ran');
      A.ok(k !== 'starnet.save', what + ': the live page\'s journal is not taken (' + k + ')');
      A.eq(live.cs.journalKey(), 'starnet.save', what + ': the live page keeps it');
    }

    // ---- d. a dead window's lock is gone: its journal is continued, and its unsent work still lands ----
    {
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const rev = host.saveStore.load('agent')._saveRevision;
      const b = browser();
      const dead = page(b, host);
      await dead.cs.openJournal();
      dead.die();
      b.cache.set('starnet.save.w.deadA', JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: 'deadA', updatedAt: Date.now() + 5,
        workstreams: [{ id: 'general', title: null, history: [K.turn('user', 'hi')] }, { id: 'unsent', title: 'U', history: [K.turn('user', 'dead window typed this')] }] })));
      b.cache.set('starnet.save', JSON.stringify(station({ _saveDirty: false, _saveRevision: rev, _saveClient: 'deadB', updatedAt: Date.now() + 10 })));
      const p = page(b, host);
      p.ctx.setTimeout = () => 0;
      const k = await p.cs.openJournal();
      A.eq(k, 'starnet.save', 'd: the page continues the newest dead journal, with no wait');
      A.ok(host.saveStore.load('agent').workstreams.some(w => w.id === 'unsent'), 'd: the other dead window\'s unsent work reached the station before boot');
      A.ok(!b.cache.has('starnet.save.w.deadA'), 'd: and its journal is removed');
    }

    // ---- e. a live page of a build from before the lock: it answers the ping, this page moves off its journal ----
    {
      const b = browser();
      const oldPage = page(b, offline, { navigator: null });   // holds no lock
      await oldPage.cs.openJournal();
      oldPage.Save.write(Object.assign(station({ _saveDirty: false }), { marker: 'old page' }));
      const p = page(b, offline);
      const k = await p.cs.openJournal();
      A.eq(k, 'starnet.save', 'e: (the lock cannot show it, so this page first took the old page\'s journal)');
      for (let i = 0; i < 8; i++) await settle();
      A.ok(/^starnet\.save\.w\./.test(p.cs.journalKey()), 'e: told otherwise, this page moved to a journal of its own (' + p.cs.journalKey() + ')');
      A.eq(oldPage.cs.journalKey(), 'starnet.save', 'e: the old page keeps its journal');
      A.ok(b.cache.has(p.cs.journalKey()), 'e: and this page carried the save it held');
    }
    {
      // a pre-journal build answers with no journal field: it writes the legacy key
      const b = browser();
      b.cache.set('starnet.save', JSON.stringify(station()));
      const preJournal = new b.Channel('starnet-pages');
      preJournal.addEventListener('message', e => { if (e.data && e.data.ping) preJournal.postMessage({ pong: e.data.ping, from: 'pre-journal' }); });
      const p = page(b, offline);
      await p.cs.openJournal();
      for (let i = 0; i < 8; i++) await settle();
      A.ok(/^starnet\.save\.w\./.test(p.cs.journalKey()), 'e: a page of a pre-journal build holds the legacy key: this page moved off it (' + p.cs.journalKey() + ')');
    }
    {
      // an answer naming another journal moves nothing
      const b = browser();
      b.cache.set('starnet.save', JSON.stringify(station()));
      const other = new b.Channel('starnet-pages');
      other.addEventListener('message', e => { if (e.data && e.data.ping) other.postMessage({ pong: e.data.ping, from: 'other', journal: 'starnet.save.w.other' }); });
      const p = page(b, offline);
      await p.cs.openJournal();
      for (let i = 0; i < 8; i++) await settle();
      A.eq(p.cs.journalKey(), 'starnet.save', 'e: a page writing another journal moves nothing');
    }

    // ---- f. the extra whole-save parse ----
    {
      const b = browser();
      b.cache.set('starnet.save', JSON.stringify(station({ pad: big() })));
      const p = page(b, offline);
      p.resetParses();
      await p.cs.openJournal();
      A.eq(p.parses(), 0, 'f: one legacy journal, this page\'s whatever it holds: not parsed before Save.load reads it');
      A.eq(p.cs.journalKey(), 'starnet.save', 'f: and it is taken');
    }
    {
      const b = browser();
      b.cache.set('starnet.save.w.mine', JSON.stringify(station({ pad: big() })));
      const p = page(b, offline, { session: new Map([['starnet.save.journal', 'starnet.save.w.mine']]) });
      p.resetParses();
      await p.cs.openJournal();
      A.eq(p.parses(), 0, 'f: a reload\'s own one journal: not parsed either');
    }
    {
      // a lone dead window's journal is taken only when it holds a save: this one needs reading
      const b = browser();
      b.cache.set('starnet.save.w.gone', JSON.stringify(station({ pad: big() })));
      const p = page(b, offline);
      p.resetParses();
      A.eq(await p.cs.openJournal(), 'starnet.save.w.gone', 'f: a lone dead window\'s journal is continued');
      A.eq(p.parses(), 1, 'f: and it had to be read to know it holds a save');
    }
    {
      const b = browser();
      b.cache.set('starnet.save.w.gone', 'not json');
      const p = page(b, offline);
      A.eq(await p.cs.openJournal(), 'starnet.save', 'f: an unreadable lone journal is not taken');
    }
    {
      // an unreadable legacy journal: the shortcut takes it, exactly as the long way did (reconcile reads and judges it)
      const b = browser();
      b.cache.set('starnet.save', 'not json');
      const p = page(b, offline);
      A.eq(await p.cs.openJournal(), 'starnet.save', 'f: an unreadable legacy journal stays this page\'s to judge');
      A.ok(b.cache.has('starnet.save'), 'f: and is left in place');
    }
  } catch (e) { A.ok(false, 'threw: ' + (e && e.stack || e)); }
  finally { K.cleanup(); }
  await settle();
  A.report('save-journal-page-lock');
})();
