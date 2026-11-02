/* test/save-journal-page-lock.test.js — a page alone in its browser opens its journal without waiting (0.14.3 boot lag).

   0.14.2's openJournal (923f03a98) waited a fixed 250 ms on every launch and reload: silence on the channel was the only way to
   learn that no other page was alive, and the desktop app's one window never hears an answer. Every page now holds a shared Web
   Lock for its life (cloudsave.js otherLockHolders). What the wait protected must still hold:
     a. alone with one journal: no 250 ms timer is armed, and the page continues its journal;
     b. a live page holding the lock: the ping still runs, and that page's journal is never taken;
     c. no Web Locks, a refused lock, a lock list that throws or never answers: the ping decides, as before, and boot never hangs;
     d. more than one journal: the ping always runs, since the list cannot show a page from before the lock. A dead window's unsent
        work still reaches the station;
     e. a live page of a build from before the lock (it holds none, and answers the ping): this page moves off its journal;
     f. the whole save is parsed once less when the one journal is this page's whatever it holds, and never when a choice remains;
     g. another holder that does not answer in time is read as dead, as in 0.14.2: its journal is merged;
     h. an older save's merge (the answer to it was overtaken by a newer save) does not report the newer save's sessions gone;
     i. a real 0.14.1 tab's shape: it writes the legacy key, answers with no journal field and hears no claim;
     j. no first-run path with a save unread: one journal alone, and a reload remembering a key with no journal behind it;
     k. a real delete stays deleted when its save merges, and an undo keeps the session.
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
    // held until the promise the callback returned settles, as in a browser
    request: (name, o, cb) => { const h = { name, mode: o && o.mode, owner }; held.push(h); const free = () => { const i = held.indexOf(h); if (i >= 0) held.splice(i, 1); }; return Promise.resolve().then(() => cb(h)).then(free, free); },
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
      // this page holds nothing, so the one holder on the list is another page: never read as this page's own, never "alone"
      ['a refused lock, with one other holder', () => ({ locks: { request: () => Promise.reject(new Error('SecurityError')), query: async () => ({ held: [{ name: 'starnet-page', mode: 'shared' }] }) } })],
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

    // ---- d. two journals: the ping always runs. A dead window's lock is gone: its journal is continued, its unsent work lands ----
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
      const k = await p.cs.openJournal();
      A.eq(k, 'starnet.save', 'd: the page continues the newest dead journal');
      A.ok(p.armed.filter(ms => ms === 250).length >= 2, 'd: with two journals the ping ran, even with no other holder on the list (' + p.armed + ')');
      A.ok(host.saveStore.load('agent').workstreams.some(w => w.id === 'unsent'), 'd: the other dead window\'s unsent work reached the station before boot');
      A.ok(!b.cache.has('starnet.save.w.deadA'), 'd: and its journal is removed');
    }
    {
      // F1: a live tab of a build from before the lock writes one journal, a dead window left another. The list shows nobody
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const rev = host.saveStore.load('agent')._saveRevision;
      const b = browser();
      const oldTab = page(b, host, { navigator: null });
      await oldTab.cs.openJournal();
      const tabRaw = JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: 'oldtab', updatedAt: Date.now() + 9,
        workstreams: [{ id: 'general', title: null, history: [K.turn('user', 'hi')] }, { id: 'tab-s', title: 'T', history: [K.turn('user', 'typed in the live old tab')] }] }));
      b.cache.set('starnet.save', tabRaw);
      b.cache.set('starnet.save.w.other', JSON.stringify(station({ _saveDirty: false, _saveRevision: rev, _saveClient: 'other', updatedAt: Date.now() + 5 })));
      const p = page(b, host);
      await p.cs.openJournal();
      A.ok(p.armed.filter(ms => ms === 250).length >= 2, 'd: the list shows nobody, and the ping still ran');
      A.ok(p.cs.journalKey() !== 'starnet.save', 'd: the lockless tab\'s journal was not taken (' + p.cs.journalKey() + ')');
      A.eq(b.cache.get('starnet.save'), tabRaw, 'd: its journal is not merged or removed');
      A.ok(!host.saveStore.load('agent').workstreams.some(w => w.id === 'tab-s'), 'd: and nothing of it was sent in its place');
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

    {
      // the answer comes well after the boot, and after this page has saved: the save goes with it, later saves stay off the old key
      const b = browser();
      b.cache.set('starnet.save', JSON.stringify(station({ marker: 'theirs' })));
      const slow = new b.Channel('starnet-pages');
      const pings = [];
      slow.addEventListener('message', e => { if (e.data && e.data.ping) pings.push(e.data.ping); });
      const p = page(b, offline);
      await p.cs.openJournal();
      for (let i = 0; i < 4; i++) await settle();
      A.eq(p.cs.journalKey(), 'starnet.save', 'e: no answer yet: this page is on the key it took');
      A.eq(pings.length, 1, 'e: alone, one ping went out after the journal was picked');
      p.Save.write(Object.assign(station(), { marker: 'mine' }));
      slow.postMessage({ pong: 'some-other-ping', from: 'pre-journal' });
      for (let i = 0; i < 4; i++) await settle();
      A.eq(p.cs.journalKey(), 'starnet.save', 'e: an answer to some other ping moves nothing');
      slow.postMessage({ pong: pings[0], from: 'pre-journal' });
      for (let i = 0; i < 4; i++) await settle();
      const fresh = p.cs.journalKey();
      A.ok(/^starnet\.save\.w\./.test(fresh), 'e: the late answer moved this page (' + fresh + ')');
      A.eq(p.cs._lateMoves(), 1, 'e: the move came from the late ping');
      A.eq(JSON.parse(b.cache.get(fresh)).marker, 'mine', 'e: and carried the save this page made');
      A.eq(p.session.get('starnet.save.journal'), fresh, 'e: a reload of this tab continues the new key');
      p.Save.write(Object.assign(station(), { marker: 'mine again' }));
      A.eq(JSON.parse(b.cache.get(fresh)).marker, 'mine again', 'e: later saves land on the new key');
      A.eq(JSON.parse(b.cache.get('starnet.save')).marker, 'mine', 'e: and never again on the other page\'s');
      slow.postMessage({ pong: pings[0], from: 'pre-journal' });
      for (let i = 0; i < 4; i++) await settle();
      A.eq([p.cs.journalKey(), p.cs._lateMoves()], [fresh, 1], 'e: a repeated answer moves nothing');
    }

    // ---- g. another holder that does not answer in time is read as dead, as in 0.14.2 ----
    {
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const rev = host.saveStore.load('agent')._saveRevision;
      const b = browser();
      b.held.push({ name: 'starnet-page', mode: 'shared', owner: 'ghost' });   // a busy live page, or a dead page's lock not yet dropped
      const unsent = (id, t) => JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: id, updatedAt: Date.now() + t,
        workstreams: [{ id: 'general', title: null, history: [K.turn('user', 'hi')] }, { id: id + '-s', title: 'S', history: [K.turn('user', id + ' typed this')] }] }));
      b.cache.set('starnet.save', unsent('legacy', 5));
      b.cache.set('starnet.save.w.other', unsent('other', 9));
      const p = page(b, host);
      A.eq(await p.cs.openJournal(), 'starnet.save.w.other', 'g: the newest journal is continued, whoever holds a lock');
      A.ok(host.saveStore.load('agent').workstreams.some(w => w.id === 'legacy-s'), 'g: the other journal\'s unsent work is merged');
      A.ok(!b.cache.has('starnet.save'), 'g: and it is removed');
      await p.cs.reconcile(p.Save.load());
      await p.cs.flush({ force: true });
      A.ok(host.saveStore.load('agent').workstreams.some(w => w.id === 'other-s'), 'g: both reach the station');
    }
    {
      // an answering holder is accounted for, so a dead window's journal is recovered with another tab open
      const root = K.workspace(); const host = K.sidecar(root);
      host.saveStore.save('agent', station(), { compareRevision: true });
      const rev = host.saveStore.load('agent')._saveRevision;
      const b = browser();
      const running = page(b, host);
      await running.cs.openJournal();
      running.Save.write(Object.assign(station(), { _saveDirty: false }));
      b.cache.set('starnet.save.w.dead', JSON.stringify(station({ _saveDirty: true, _saveRevision: rev, _saveClient: 'dead', updatedAt: Date.now() + 5,
        workstreams: [{ id: 'general', title: null, history: [K.turn('user', 'hi')] }, { id: 'dead-s', title: 'D', history: [K.turn('user', 'dead typed this')] }] })));
      const p = page(b, host);
      A.eq(await p.cs.openJournal(), 'starnet.save.w.dead', 'g: every holder answered: the dead journal is continued as usual');
      A.eq(running.cs.journalKey(), 'starnet.save', 'g: and the running page keeps its own');
    }

    // ---- j. the first-run path is never reached with a save unread: no other holder, one journal, an empty station file ----
    {
      const only = dirty => JSON.stringify(K.stationDoc({ updatedAt: 5000, _saveDirty: dirty, _saveClient: 'crashed', _saveRevision: 7,
        workstreams: [{ id: 'general', title: null, history: [K.turn('user', 'hi')] }, { id: 'mine', title: 'Mine', history: [K.turn('user', 'only copy turn')] }] }));
      const holds = d => !!(d && d.workstreams && d.workstreams.some(w => w.id === 'mine'));
      for (const dirty of [true, false]) {
        const label = dirty ? 'unsent' : 'clean';
        for (const key of ['starnet.save', 'starnet.save.w.crashed']) {
          // a cold start
          const b = browser(), host = K.sidecar(K.workspace());
          b.cache.set(key, only(dirty));
          const p = page(b, host);
          await p.cs.openJournal();
          A.ok(holds(await p.cs.reconcile(p.Save.load())), 'j cold ' + label + ' ' + key + ': the boot opens on the only copy');
        }
        // A REAL RELOAD, the same session Map: this tab was given a key of its own beside a live page, and never saved. That page died,
        // leaving its journal, and this tab reloads remembering a key with nothing behind it
        const b = browser(), host = K.sidecar(K.workspace());
        const raw = only(dirty);
        b.cache.set('starnet.save', raw);
        const running = page(b, host);
        await running.cs.openJournal();
        const session = new Map();
        const first = page(b, host, { session });
        const remembered = await first.cs.openJournal();
        A.ok(/^starnet\.save\.w\./.test(remembered) && !b.cache.has(remembered), 'j reload ' + label + ': the note names a key with no journal behind it (' + remembered + ')');
        A.eq(session.get('starnet.save.journal'), remembered, 'j reload ' + label + ': on the tab\'s own session');
        running.die(); first.die();
        const again = page(b, host, { session });
        await again.cs.openJournal();
        A.ok(holds(await again.cs.reconcile(again.Save.load())), 'j reload ' + label + ': the reload opens on the only copy, never first-run');
        A.eq(again.cs.journalKey(), 'starnet.save', 'j reload ' + label + ': and continues that journal');
        A.eq(session.get('starnet.save.journal'), 'starnet.save', 'j reload ' + label + ': the next reload does too');
        await again.cs.flush({ force: true });
        A.ok(holds(host.saveStore.load('agent')), 'j reload ' + label + ': and it reaches the station');
        A.ok(b.cache.has('starnet.save'), 'j reload ' + label + ': with the copy still there');
      }
      {
        // which journal, and how: a reload remembering a key with nothing behind it, on an empty station file
        const NOTE = () => new Map([['starnet.save.journal', 'starnet.save.w.gone']]);
        const doc = (t, over) => JSON.stringify(K.stationDoc(Object.assign({ updatedAt: t, _saveDirty: false, _saveClient: 'crashed', _saveRevision: 7 }, over || {})));
        {
          // the newest of them, and the others are left as they were
          const b = browser(), host = K.sidecar(K.workspace());
          b.cache.set('starnet.save.w.old', doc(1000, { marker: 'old' }));
          const newRaw = doc(9000, { marker: 'new' }), oldRaw = b.cache.get('starnet.save.w.old');
          b.cache.set('starnet.save.w.new', newRaw);
          const claims = [];
          const ear = new b.Channel('starnet-pages');
          ear.addEventListener('message', e => { if (e.data && e.data.claim) claims.push(e.data.claim); });
          const p = page(b, host, { session: NOTE() });
          await p.cs.openJournal();
          const view = await p.cs.reconcile(p.Save.load());
          for (let i = 0; i < 4; i++) await settle();
          A.eq(p.cs.journalKey(), 'starnet.save.w.new', 'j which: the newest journal is continued');
          A.eq(view.marker, 'new', 'j which: and is the view');
          A.eq(b.cache.get('starnet.save.w.old'), oldRaw, 'j which: the other is left as it was');
          A.ok(claims.includes('starnet.save.w.new'), 'j which: the page claims the journal it took, so another page that took it moves (' + claims + ')');
        }
        {
          // a journal of a newer build is never opened or changed, however new
          const b = browser(), host = K.sidecar(K.workspace());
          const future = doc(9000, { version: 999, marker: 'future' });
          b.cache.set('starnet.save.w.future', future);
          b.cache.set('starnet.save.w.old', doc(1000, { marker: 'old' }));
          const p = page(b, host, { session: NOTE() });
          await p.cs.openJournal();
          A.eq((await p.cs.reconcile(p.Save.load())).marker, 'old', 'j future: the newer build\'s journal is not opened');
          A.eq(p.cs.journalKey(), 'starnet.save.w.old', 'j future: and not continued');
          A.eq(b.cache.get('starnet.save.w.future'), future, 'j future: and stays as it was');
        }
        {
          // an old journal goes up the migration ladder like any other load, with its backup
          const b = browser(), host = K.sidecar(K.workspace());
          b.cache.set('starnet.save.w.v3', doc(1000, { version: 3, marker: 'v3' }));
          const p = page(b, host, { session: NOTE() });
          await p.cs.openJournal();
          const view = await p.cs.reconcile(p.Save.load());
          A.eq([view.marker, view.version], ['v3', p.Save.CURRENT], 'j migrate: the view is migrated');
          A.ok(b.cache.has('starnet.save.pre-migrate.backup'), 'j migrate: with the backup from before it');
          await p.cs.flush({ force: true });
          A.eq(host.saveStore.load('agent').version, p.Save.CURRENT, 'j migrate: and the station gets the migrated save');
        }
      }
      {
        // the station has the save: the note stands. This tab's journal may be gone because another page merged it, so its turns are in the
        // station, and the journal that looks free is not this tab's to open on (seeds 42, 107 and 117 lost sight of their own turn that way)
        const b = browser(), host = K.sidecar(K.workspace());
        host.saveStore.save('agent', station(), { compareRevision: true });
        b.cache.set('starnet.save', only(false));
        const session = new Map([['starnet.save.journal', 'starnet.save.w.gone']]);
        const p = page(b, host, { session });
        await p.cs.openJournal();
        A.ok(!holds(await p.cs.reconcile(p.Save.load())), 'j station: a reload opens on the station, not on the journal that looks free');
        A.eq(p.cs.journalKey(), 'starnet.save.w.gone', 'j station: and keeps the key it remembers');
      }
      {
        // a reload whose note has a journal behind it still continues it
        const b = browser();
        b.cache.set('starnet.save.w.mine', JSON.stringify(station({ marker: 'mine' })));
        const p = page(b, offline, { session: new Map([['starnet.save.journal', 'starnet.save.w.mine']]) });
        A.eq(await p.cs.openJournal(), 'starnet.save.w.mine', 'j: a reload continues its own journal');
      }
    }

    // ---- k. a real delete stays deleted: mergeWire keeps what the newest save no longer holds, and an undo keeps the session ----
    for (const mode of ['delete in flight', 'deleted by another tab', 'delete then undo']) {
      const root = K.workspace(), host = K.sidecar(root);
      const sess = (id, title, text) => ({ id, title, history: [K.turn('user', text)] });
      host.saveStore.save('agent', K.stationDoc({ updatedAt: 1000, workstreams: [sess('general', null, 'hi'), sess('s0', 'S0', 'zero')] }), { compareRevision: true });
      const b = browser();
      let gated = false; const queue = [];
      const net = { fetch: (u, init) => gated ? new Promise((res, rej) => queue.push({ u, init, res, rej })) : host.fetch(u, init) };
      const release = async () => { gated = false; for (const r of queue.splice(0)) { try { r.res(await host.fetch(r.u, r.init)); } catch (e) { r.rej(e); } } };
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let at = 0;
      const persist = (pg, ws, extra) => { const d = K.stationDoc(Object.assign({ updatedAt: Date.now() + (++at) * 1000, workstreams: ws, _saveDirty: true, _saveRevision: pg.cs.revision(), _saveClient: pg.cs.writerId() }, extra || {})); const raw = JSON.stringify(d); b.cache.set(pg.cs.journalKey(), raw); pg.cs.push(d, { raw }); };
      const copy = x => JSON.parse(JSON.stringify(x));
      const P = page(b, net);
      await P.cs.openJournal(); await P.cs.reconcile(P.Save.load()); await settle();
      const w0 = copy(host.saveStore.load('agent').workstreams), w1 = copy(w0).concat([sess('s1', 'S1', 'one')]);
      // s1 lands, and its answer never comes
      gated = true;
      persist(P, copy(w1));
      const f1 = P.cs.flush({ force: true }).catch(() => {});
      await settle(); await wait(5);
      gated = false;
      for (const r of queue.splice(0)) { await host.fetch(r.u, r.init); r.rej(new Error('answer lost')); }
      await f1; await settle(); await wait(20);
      A.ok(host.saveStore.load('agent').workstreams.some(w => w.id === 's1'), 'k: s1 landed, this page does not know');
      const T = page(b, host);
      await T.cs.openJournal(); await T.cs.reconcile(T.Save.load()); await settle();
      const now = () => copy(host.saveStore.load('agent').workstreams);
      if (mode === 'deleted by another tab') {
        persist(T, now().filter(w => w.id !== 's1'), { deletedIds: ['s1'] });
        await T.cs.flush({ force: true }); await wait(20);
        const w = copy(w1); w.find(s => s.id === 'general').history.push(K.turn('user', 'P turn'));
        persist(P, w);
        await P.cs.flush({ force: true }); await wait(50); await P.cs.flush({ force: true }); await wait(30);
      } else {
        gated = true;
        persist(P, copy(w0), { deletedIds: ['s1'] });
        const f = P.cs.flush({ force: true }).catch(() => {}); await settle();
        persist(T, now().concat([sess('sT', 'ST', 'tab turn')]));
        await T.cs.flush({ force: true }); await wait(20);
        if (mode === 'delete then undo') persist(P, copy(w1));
        await release(); await f; await settle(); await wait(50);
        await release(); await P.cs.flush({ force: true }); await wait(50);
        await release(); await P.cs.flush({ force: true }); await wait(30);
      }
      const d = host.saveStore.load('agent');
      A.eq(d.workstreams.some(w => w.id === 's1'), mode === 'delete then undo', 'k ' + mode + ': s1 in the station is what the user last chose');
      if (mode !== 'deleted by another tab') A.ok(d.workstreams.some(w => w.id === 'sT'), 'k ' + mode + ': and the other tab\'s session stays');
    }

    // ---- h. a live tab misses the ping with an older save in flight and a newer one unsent; the new page merges its journal ----
    {
      const root = K.workspace(), host = K.sidecar(root);
      const sess = (id, title, text) => ({ id, title, history: [K.turn('user', text)] });
      host.saveStore.save('agent', K.stationDoc({ updatedAt: 1000, workstreams: [sess('general', null, 'hi'), sess('s0', 'old title', 'zero')] }), { compareRevision: true });
      const b = browser();
      let gated = false, dead = false; const queue = [];
      const tabNet = { fetch: (u, init) => dead ? new Promise(() => {}) : gated ? new Promise((res, rej) => queue.push({ u, init, res, rej })) : host.fetch(u, init) };
      const release = async () => { gated = false; for (const r of queue.splice(0)) { try { r.res(await host.fetch(r.u, r.init)); } catch (e) { r.rej(e); } } };
      const T = page(b, tabNet, { navigator: null });
      await T.cs.openJournal();
      await T.cs.reconcile(T.Save.load());
      const w0 = JSON.parse(JSON.stringify(host.saveStore.load('agent').workstreams));
      const persist = (t, ws) => { const d = K.stationDoc({ updatedAt: t, workstreams: ws, _saveDirty: true, _saveRevision: T.cs.revision(), _saveClient: T.cs.writerId() }); const raw = JSON.stringify(d); b.cache.set(T.cs.journalKey(), raw); T.cs.push(d, { raw }); };
      gated = true;
      persist(Date.now() + 2000, w0.concat([sess('s1', 'S1', 'one')]));
      const sending = T.cs.flush({ force: true });
      await settle();
      persist(Date.now() + 3000, w0.concat([sess('s1', 'S1', 'one'), sess('s2', 'S2', 'PRECIOUS turn')]));
      b.cache.set('starnet.save.w.other', JSON.stringify(Object.assign(host.saveStore.load('agent'), { _saveDirty: false, _saveClient: 'other', updatedAt: Date.now() + 100000 })));
      T.channel.open = false;   // busy: no answer in time
      const N = page(b, host);
      await N.cs.openJournal();
      await N.cs.reconcile(N.Save.load());
      const held = () => host.saveStore.load('agent').workstreams.some(w => (w.history || []).some(t => t.content === 'PRECIOUS turn'));
      A.ok(held(), 'h: the new page merged the tab\'s journal, with its newest session');
      T.channel.open = true;
      await release();
      await sending;
      for (let i = 0; i < 5; i++) await settle();
      await new Promise(r => setTimeout(r, 50));
      await release();
      dead = true;              // the tab dies before its newer save goes
      A.ok(held(), 'h: the older save\'s merge does not take the newer save\'s session back out');
    }

    // ---- i. a live tab of 0.14.1, with unsent work: the legacy key, a pong with no journal field, no claim, no lock ----
    for (const when of ['reconcile at once, as the boot does', 'the answer first']) {
      const root = K.workspace(), host = K.sidecar(root);
      host.saveStore.save('agent', K.stationDoc({ updatedAt: 1000 }), { compareRevision: true });
      const v = host.saveStore.load('agent');
      const raw = JSON.stringify(Object.assign({}, v, { _saveDirty: true, _saveClient: 'oldtab', updatedAt: Date.now() + 500,
        workstreams: (v.workstreams || []).concat([{ id: 'tab-s', title: 'T', history: [K.turn('user', 'the old tab typed this'), K.turn('user', 'and this')] }]) }));
      const b = browser();
      b.cache.set('starnet.save', raw);
      const tab = new b.Channel('starnet-pages');
      tab.addEventListener('message', e => { if (e.data && e.data.ping) tab.postMessage({ pong: e.data.ping, from: 'oldtab' }); });
      const p = page(b, host);
      await p.cs.openJournal();
      if (when === 'the answer first') for (let i = 0; i < 4; i++) await settle();
      await p.cs.reconcile(p.Save.load());
      for (let i = 0; i < 4; i++) await settle();
      await p.cs.flush({ force: true });
      A.ok(p.cs.journalKey() !== 'starnet.save', 'i (' + when + '): the page ends off the legacy key (' + p.cs.journalKey() + ')');
      A.eq(b.cache.get('starnet.save'), raw, 'i (' + when + '): the tab\'s journal is exactly as it wrote it');
      const got = new Set(); for (const w of host.saveStore.load('agent').workstreams) for (const t of w.history || []) got.add(t.content);
      A.ok(got.has('the old tab typed this') && got.has('and this'), 'i (' + when + '): every turn of the tab reached the station');
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
