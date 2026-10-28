/* test/save-interleave.seeded.test.js — no window can wedge autosave, lose or silently revert another window's work, churn
   reloads, or boot a stale view (wave-1 save-latch-kill, 10-26 reliability audit family B3; gh#153, #121, starnet-releases#4,
   qa/bugs 27bae3d6; review 10-27).

   THE HARNESS. Real modules end to end: the REAL page (frontend/app/cloudsave.js + cloudsavecore.js, one vm per window)
   -> the REAL /api/save (plain and merged: sidecar/save-merge.js) and /api/save/adopt handlers sliced out of the sidecar ->
   the REAL savestore, on an in-memory disk. Everything that decides an interleaving is injected and seeded: one virtual
   clock drives every page timer (the 1.2 s debounce, the backoff, the 15 s ACK deadline) and the handlers' clock; one seeded
   network decides when the station takes each request and whether its answer arrives. Per seed, three windows (two tabs of
   one browser + a desktop window) type turns, rename their sessions and the hero, change their own crew member, delete
   sessions, all persist at once (a broadcast run end), while the network loses answers, drops requests, and windows crash
   and reopen.

   THE INVARIANTS, checked on every seed:
     I1 the station never goes back: every turn the station file held is still in it after each write (unless its session was
        deleted on purpose), and every landed write moves its revision strictly forward (CAS is never relaxed);
     I2 no wedge: once the network is healthy, every live window's conflict clears and its next change lands — no banner
        that will not clear;
     I3 no loss, no silent revert: every turn a window persisted is in the station file at the end, a turn typed into a
        session other windows also write (General) too; every session rename, crew change and delete a window made is in
        the station file — unless that window died (or reopened on a boot merge) before the station took it, where the
        boot merge keeps it beside the station (the boot merge takes sessions only);
     I4 no stale boot: a window that reloads or reopens never resumes a view without the turns it had itself persisted;
     I5 no reload churn: the save path reloads a window only when it cannot merge (it never had a save taken by the station),
        and never once the network is healthy.
   SEEDS: SAVE_INTERLEAVE_SEEDS (default 500). A failing seed prints its number: SAVE_INTERLEAVE_ONLY=<seed> replays it.

   Plus NAMED cases (the done-means and review 10-27's repros): a desktop window + a browser tab — the one behind merges and
   is never reloaded or bannered; two tabs of one browser (27bae3d6); a station that REFUSES the merge (the conflict stands as
   before); a behind window's non-session changes land; a session another window deleted is reported, never dropped
   silently; two windows typing in General for hundreds of turns make no restored copies and no reloads; an earlier
   preserved copy is never pruned away by merges; a passing refusal is asked again; a broadcast run end that makes both
   windows persist reloads neither. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const K = require('./_save-restore-kit.js');

const SEEDS = Math.max(1, Number(process.env.SAVE_INTERLEAVE_SEEDS) || 500);
const ONLY = process.env.SAVE_INTERLEAVE_ONLY ? Number(process.env.SAVE_INTERLEAVE_ONLY) : null;
const STEPS = 80;
const SEEDED_OPTS = { separate: process.env.SAVE_INTERLEAVE_SEPARATE === '1', noJournal: process.env.SAVE_INTERLEAVE_NO_JOURNAL === '1' };   // two tabs of one browser + a desktop window
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const clone = v => JSON.parse(JSON.stringify(v));
const settle = () => new Promise(r => setImmediate(r));

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- the virtual clock: every page timer and the handlers' Date read it ----
function makeClock(start) {
  let t = start, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    set(fn, ms, owner) { const id = ++seq; timers.set(id, { id, at: t + Math.max(0, Number(ms) || 0), fn, owner }); return id; },
    clear(id) { timers.delete(id); },
    kill(owner) { for (const [id, x] of timers) if (x.owner === owner) timers.delete(id); },
    next() { let best = null; for (const x of timers.values()) if (!best || x.at < best.at || (x.at === best.at && x.id < best.id)) best = x; return best; },
    advanceTo(at) { if (at > t) t = at; },
    tick(ms) { t += ms; },
    pending: () => timers.size
  };
}
function vDate(clock) {
  return class VDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now()); }
    static now() { return clock.now(); }
  };
}

// ---- an in-memory disk for the real savestore (the subset of node:fs it uses) ----
function memfs() {
  const files = new Map();
  let tick = 0n, ino = 0;
  const key = p => String(p);
  const enoent = p => Object.assign(new Error('ENOENT: no such file ' + p), { code: 'ENOENT' });
  return {
    files,
    readFileSync(p) { const f = files.get(key(p)); if (!f) throw enoent(p); return f.data; },
    writeFileSync(p, d) { files.set(key(p), { data: String(d), mtimeNs: ++tick, ino: ++ino }); },
    renameSync(a, b) { const f = files.get(key(a)); if (!f) throw enoent(a); files.delete(key(a)); files.set(key(b), { data: f.data, mtimeNs: ++tick, ino: f.ino }); },
    mkdirSync() {},
    existsSync(p) { return files.has(key(p)); },
    unlinkSync(p) { if (!files.delete(key(p))) throw enoent(p); },
    statSync(p, o) {
      const f = files.get(key(p)); if (!f) throw enoent(p);
      return o && o.bigint ? { mtimeNs: f.mtimeNs, size: BigInt(f.data.length), ino: BigInt(f.ino), mtimeMs: f.mtimeNs } : { mtimeNs: Number(f.mtimeNs), mtimeMs: Number(f.mtimeNs), size: f.data.length, ino: f.ino };
    },
    readdirSync(dir) { const pre = key(dir).replace(/[\\/]+$/, '') + path.sep; const out = []; for (const k of files.keys()) if (k.indexOf(pre) === 0 && k.slice(pre.length).indexOf(path.sep) < 0) out.push(k.slice(pre.length)); return out; }
  };
}

// every turn text in a save (or [] for none)
function turnsOf(doc) {
  const out = new Set();
  for (const w of (doc && Array.isArray(doc.workstreams) ? doc.workstreams : [])) for (const t of (Array.isArray(w.history) ? w.history : [])) if (t && typeof t.content === 'string') out.add(t.content);
  return out;
}

// ---- one world: a station (sidecar) + browsers + windows, all on one clock and one seeded network ----
function world(seed, opts) {
  opts = opts || {};
  const rand = rng(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const clock = makeClock(1_800_000_000_000 + seed * 1000);
  const VDate = vDate(clock);
  const disk = memfs();
  const root = path.join(path.sep === '\\' ? 'C:\\' : '/', 'mem-station-' + seed);
  const host = K.sidecar(root, { fs: disk, clock: { now: () => clock.now() }, Date: VDate, noMerge: !!opts.noMerge });
  const problems = [];
  const fail = m => { problems.push(m); };
  // SAVE_INTERLEAVE_TRACE=1 with SAVE_INTERLEAVE_ONLY=<seed>: print what happened, in order
  const tracing = process.env.SAVE_INTERLEAVE_TRACE === '1';
  const trace = (...a) => { if (tracing) console.log('[t=' + (clock.now() % 1e7) + ']', ...a); };
  const brief = d => d ? { rev: d._saveRevision, dirty: d._saveDirty, client: String(d._saveClient || '').slice(0, 14), merge: !!d._saveMerge, hero: d.agent && d.agent.name, sessions: (d.workstreams || []).map(w => w.id + ':' + (w.history || []).length).join(',') } : null;
  // a founded station: the windows boot onto it (a missing one is onboarding, not this harness)
  host.saveStore.save('agent', { schema: 'starnet.save', version: 6, updatedAt: clock.now(), _saveRevision: 0, _saveDirty: false, _saveClient: 'founder',
    agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, agents: [], generalId: 'general', activeId: 'general', deletedIds: [],
    workstreams: [{ id: 'general', title: null, history: [{ role: 'user', content: 'founded' }] }] }, { compareRevision: true });
  let uuidSeq = 0, turnSeq = 0, reqSeq = 0;
  const uuid = () => 'p' + seed.toString(36) + '-' + (++uuidSeq).toString(36) + '-' + Math.floor(rand() * 1e9).toString(36);

  // what the windows did that the station file must hold at the end (I3)
  const committedOwn = new Set(), committedShared = new Set(), deletedTurns = new Set();
  const ownTitles = new Map();      // session id -> the last title its owner set
  const crewModel = new Map();      // window name -> the last model it set on its own crew member
  const deletedSessions = new Set();
  const heroNames = new Set(['NOVA']);
  const ownerOf = new Map();        // session id -> the window that made it

  // the station: watch every write (I1)
  let lastRev = -1, lastTurns = new Set();
  function watchStation(label) {
    const doc = host.saveStore.load('agent');
    if (!doc) return;
    const rev = Number(doc._saveRevision) || 0;
    const turns = turnsOf(doc);
    if (rev !== lastRev) {
      if (rev < lastRev) fail('I1: the station revision went back ' + lastRev + ' -> ' + rev + ' (' + label + ')');
      for (const t of lastTurns) if (!turns.has(t) && !deletedTurns.has(t)) fail('I1: the station lost turn "' + t + '" at revision ' + rev + ' (' + label + ')');
      lastRev = rev; lastTurns = turns;
    } else if (turns.size !== lastTurns.size || [...turns].some(t => !lastTurns.has(t))) fail('I1: the station changed without a new revision (' + label + ')');
  }

  // ---- the network ----
  const queue = [];   // requests the station has not taken yet
  let intercept = null;   // a case may answer a request itself: fn(req) -> a response, or null to let the station take it
  function pageFetch(win, gen) {
    return (url, init) => new Promise((resolve, reject) => {
      const req = { id: ++reqSeq, win, gen, url: String(url), init: init || {}, resolve, reject, done: false };
      const sig = init && init.signal;
      if (sig && typeof sig.addEventListener === 'function') sig.addEventListener('abort', () => {
        if (req.done) return;
        req.done = true;
        const i = queue.indexOf(req); if (i >= 0) queue.splice(i, 1);   // never reached the station
        reject(new Error('aborted'));
      });
      queue.push(req);
    });
  }
  // the station takes one request; `lose`: its answer never arrives (the page's own deadline ends the wait)
  async function serve(req, lose) {
    const i = queue.indexOf(req); if (i >= 0) queue.splice(i, 1);
    if (req.done) return;
    let res = intercept ? intercept(req) : null;
    if (!res) { try { res = await host.fetch(req.url, req.init); } catch (e) { fail('the station threw on ' + req.url + ': ' + (e && e.message)); return; } }
    if (tracing) { let b = null; try { b = await res.json(); } catch (_) {} const sent = req.init && req.init.body ? JSON.parse(req.init.body) : null; trace('serve', req.url, 'from', req.win.name + '#' + req.gen, lose ? 'LOST' : '', JSON.stringify(brief(sent)), '->', JSON.stringify(b && (b.save ? { save: brief(b.save) } : b.doc ? Object.assign({}, b, { doc: brief(b.doc) }) : b)).slice(0, 400)); }
    watchStation(req.url + ' from ' + req.win.name);
    const alive = req.win.gen === req.gen && req.win.status !== 'dead';
    if (!lose && alive && !req.done) { req.done = true; req.resolve(res); }
    await settle();
  }
  // a request the station never takes (an outage): the page's deadline ends the wait
  function drop(req) { const i = queue.indexOf(req); if (i >= 0) queue.splice(i, 1); trace('DROP', req.url, 'from', req.win.name + '#' + req.gen); }

  // ---- browsers and windows ----
  // a browser: one localStorage (cache) and one BroadcastChannel hub that every live page of it is on
  function browser(name) { return { name, cache: new Map(), members: new Set() }; }
  function localStorageOf(b) {
    const c = b.cache;
    return { getItem: k => (c.has(k) ? c.get(k) : null), setItem: (k, v) => { c.set(k, String(v)); }, removeItem: k => { c.delete(k); },
      get length() { return c.size; }, key: i => Array.from(c.keys())[i] || null };
  }
  // the page's BroadcastChannel: a dead window's page hears and answers nothing; delivery is a later task, as in a browser
  function channelFor(b, w, gen) {
    return class FakeChannel {
      constructor(name) { this.name = name; this.fns = new Set(); b.members.add(this); }
      alive() { return w.gen === gen && w.status !== 'dead'; }
      addEventListener(t, fn) { if (t === 'message') this.fns.add(fn); }
      removeEventListener(t, fn) { this.fns.delete(fn); }
      postMessage(data) {
        if (!this.alive()) return;
        const msg = JSON.parse(JSON.stringify(data));
        for (const m of b.members) if (m !== this && m.name === this.name) setImmediate(() => { if (m.alive()) for (const fn of Array.from(m.fns)) fn({ data: msg }); });
      }
      close() { b.members.delete(this); }
    };
  }
  // save.js's key()/useKey()/load() over the browser cache: the page's own journal (cloudsave openJournal picks it)
  function saveOf(ls) {
    let key = 'starnet.save';
    return { CURRENT: 6, key: () => key, useKey: k => { key = String(k); return key; }, load: () => { try { return JSON.parse(ls.getItem(key) || 'null'); } catch (_) { return null; } } };
  }
  // opts.separate: every window in a browser of its own (no shared browser cache)
  const browsers = [browser('chrome'), browser('desktop'), browser('other')];
  const windows = [
    { name: 'tabA', browser: browsers[0] },
    { name: 'tabB', browser: opts.separate ? browsers[2] : browsers[0] },
    { name: 'desk', browser: browsers[1] }
  ].slice(0, opts.windows || 3).map(w => Object.assign(w, { gen: 0, status: 'dead', page: null, state: null, mine: new Set(), own: new Set(), session: new Map(), wantReload: false, boot: null, reloads: 0, saveReloads: 0 }));

  function docOf(w) {
    return { schema: 'starnet.save', version: 6, agent: { id: 'agent', name: w.state.hero, createdAt: 5000 }, agents: clone(w.state.crew), generalId: 'general', activeId: 'general',
      deletedIds: clone(w.state.deleted), workstreams: clone(w.state.ws) };
  }
  // the key this window's page writes its save under (its journal; the single legacy key with opts.noJournal)
  function cacheKey(w) { return (opts.noJournal || !w.page.journalKey) ? 'starnet.save' : w.page.journalKey(); }
  // a window's non-session changes the station has not taken when it dies (or reopens on a boot merge) are the boot merge's
  // to keep beside the station, not the station file's (I3)
  function expose(w) {
    const st = host.saveStore.load('agent') || {};
    const crew = (st.agents || []).find(a => a.id === 'crew-' + w.name);
    if (crewModel.has(w.name) && !(crew && crew.model === crewModel.get(w.name))) crewModel.delete(w.name);
    for (const [id, title] of Array.from(ownTitles)) {
      if (ownerOf.get(id) !== w.name) continue;
      const s = (st.workstreams || []).find(x => x.id === id);
      if (!(s && s.title === title)) ownTitles.delete(id);
    }
    for (const id of Array.from(deletedSessions)) if (ownerOf.get(id) === w.name && (st.workstreams || []).some(x => x.id === id)) deletedSessions.delete(id);
  }
  function boot(w) {
    w.gen++;
    const gen = w.gen, owner = w.name + '#' + gen;
    w.status = 'booting'; w.wantReload = false; w.state = null;
    const sessionStorage = { getItem: k => (w.session.has(k) ? w.session.get(k) : null), setItem: (k, v) => w.session.set(k, String(v)), removeItem: k => w.session.delete(k) };
    const localStorage = localStorageOf(w.browser), Save = saveOf(localStorage);
    const extra = {
      console: quiet, Date: VDate, setTimeout: (fn, ms) => clock.set(fn, ms, owner), clearTimeout: id => clock.clear(id),
      crypto: { randomUUID: uuid }, sessionStorage, localStorage, Save, BroadcastChannel: channelFor(w.browser, w, gen),
      location: { reload() {
        if (w.gen !== gen) return;
        w.wantReload = true; w.reloads++; w.saveReloads++;
        // I5: the save path reloads a window only when it cannot merge (no base: it never had a save taken by the station)
        const m = w.page && w.page._mergeState ? w.page._mergeState() : null;
        if (m && m.base) fail('I5: ' + w.name + ' was reloaded while it could merge in place');
        if (healthyPhase) fail('I5: ' + w.name + ' was reloaded on a healthy network');
      } }
    };
    w.page = K.page({ fetch: pageFetch(w, gen) }, w.browser.cache, extra);
    // the boot path (app.js init): this window's journal first, then the local save read from it, then reconcile
    const opened = (opts.noJournal || !w.page.openJournal) ? Promise.resolve() : w.page.openJournal();   // a build without journals: the one shared key
    w.boot = opened.then(() => {
      const local = Save.load();
      trace('boot', w.name + '#' + gen, 'journal', cacheKey(w), 'keys', JSON.stringify([...w.browser.cache.keys()]), 'local', JSON.stringify(brief(local)));
      return w.page.reconcile(local);
    }).then(doc => {
      trace('booted', w.name + '#' + gen, JSON.stringify(brief(doc)), 'merge', JSON.stringify(w.page.mergeNotice()));
      if (w.gen !== gen) return;
      if (!doc || doc.__saveUnknown || doc.__futureSave || !Array.isArray(doc.workstreams)) { w.status = 'gated'; return; }
      w.state = { ws: clone(doc.workstreams), hero: doc.agent && doc.agent.name, crew: clone(doc.agents || []), deleted: clone(doc.deletedIds || []) };
      w.status = 'live';
      // I4: never a view without the turns this window persisted into its own sessions (a turn in General, which other windows
      // write too, may come back only after the merge: I3 holds it to that)
      const view = turnsOf(doc);
      for (const t of w.mine) if (!view.has(t) && !deletedTurns.has(t)) { fail('I4: ' + w.name + ' booted a view without its own turn "' + t + '"'); break; }
    }, e => { fail(w.name + ' boot threw: ' + (e && e.stack || e)); w.status = 'gated'; });
  }
  function kill(w) {
    if (w.status === 'dead') return;
    trace('kill', w.name + '#' + w.gen);
    w.status = 'dead'; clock.kill(w.name + '#' + w.gen); w.gen++;   // the page is gone: its timers and answers with it
    expose(w);
  }
  function persist(w) {
    const cs = w.page;
    const d = Object.assign(docOf(w), { _saveDirty: true, _saveRevision: cs.revision(), _saveClient: cs.writerId(), updatedAt: clock.now() });
    const raw = JSON.stringify(d);
    w.browser.cache.set(cacheKey(w), raw);
    cs.push(d, { raw });
  }
  // type one turn: a new session of this window's, a turn in one of its own sessions, or a turn in General (shared)
  function edit(w, kind) {
    clock.tick(1 + Math.floor(rand() * 40));
    const text = w.name + ':' + (++turnSeq);
    const own = w.state.ws.filter(s => w.own.has(s.id));
    const r = kind === 'own' ? 0 : kind === 'general' ? 0.9 : rand();
    if (kind !== 'general' && (r < 0.35 || !own.length)) {
      const id = w.name + '-s' + turnSeq;
      w.state.ws.push({ id, title: 'S ' + id, history: [{ role: 'user', content: text }] });
      w.own.add(id); ownerOf.set(id, w.name); committedOwn.add(text);
    } else if (kind !== 'general' && r < 0.8) {
      pick(own).history.push({ role: 'user', content: text }); committedOwn.add(text);
    } else {
      let g = w.state.ws.find(s => s.id === 'general');
      if (!g) { g = { id: 'general', title: null, history: [] }; w.state.ws.unshift(g); }
      g.history.push({ role: 'user', content: text }); committedShared.add(text);
    }
    if (!committedShared.has(text)) w.mine.add(text);
    trace('edit', w.name + '#' + w.gen, text, committedShared.has(text) ? 'GENERAL' : 'own', 'rev', w.page.revision());
    persist(w);
    return text;
  }
  // a change that is not a turn: a session rename, the hero's name, this window's own crew member, a delete
  function change(w, kind) {
    clock.tick(1 + Math.floor(rand() * 40));
    const n = ++turnSeq;
    const own = w.state.ws.filter(s => w.own.has(s.id));
    if (kind === 'rename' && own.length) {
      const s = pick(own); s.title = w.name + ' title ' + n; ownTitles.set(s.id, s.title);
    } else if (kind === 'hero') {
      w.state.hero = w.name + ' hero ' + n; heroNames.add(w.state.hero);
    } else if (kind === 'crew') {
      let c = w.state.crew.find(a => a.id === 'crew-' + w.name);
      if (!c) { c = { id: 'crew-' + w.name, name: 'Crew of ' + w.name }; w.state.crew.push(c); }
      c.model = 'model-' + n; crewModel.set(w.name, c.model);
    } else if (kind === 'delete' && own.length > 1) {
      const s = pick(own);
      w.state.ws = w.state.ws.filter(x => x.id !== s.id); w.state.deleted.push(s.id);
      deletedSessions.add(s.id); ownTitles.delete(s.id);
      for (const t of (s.history || [])) { deletedTurns.add(t.content); committedOwn.delete(t.content); w.mine.delete(t.content); }
    } else return null;
    trace('change', w.name + '#' + w.gen, kind, 'rev', w.page.revision());
    persist(w);
    return kind;
  }

  let healthyPhase = false;
  // one scheduler step: a timer, the station taking a request (or losing its answer, or never taking it), a window typing or
  // changing something, every window persisting at once, a window crashing or reopening
  async function step(faults) {
    for (const w of windows) if (w.wantReload && w.status !== 'dead') { kill(w); boot(w); }   // cloudsave asked to re-enter
    const r = rand();
    const live = windows.filter(w => w.status === 'live');
    if (queue.length && r < 0.42) {
      const req = pick(queue);
      const x = rand();
      if (faults && x < 0.08) await serve(req, true);
      else if (faults && x < 0.13) drop(req);
      else await serve(req, false);
    } else if (r < 0.62) {
      if (live.length) edit(pick(live));
    } else if (r < 0.70) {
      if (live.length) change(pick(live), pick(['rename', 'hero', 'crew', 'crew', 'delete']));
    } else if (r < 0.73) {
      for (const w of live) persist(w);   // a broadcast run end: every window's growth store persists at once (xpstore)
    } else if (r < 0.88) {
      const nx = clock.next();
      if (nx) { clock.advanceTo(Math.min(nx.at, clock.now() + 1 + Math.floor(rand() * 20000))); await runDue(); }
      else clock.tick(1 + Math.floor(rand() * 2000));
    } else if (faults && r < 0.92) {
      const up = windows.filter(w => w.status !== 'dead');
      if (up.length > 1) kill(pick(up));
    } else {
      const down = windows.filter(w => w.status === 'dead' || w.status === 'gated');
      if (down.length) boot(pick(down));
    }
    await settle();
  }
  async function runDue() {
    for (let guard = 0; guard < 50; guard++) {
      const nx = clock.next();
      if (!nx || nx.at > clock.now()) return;
      clock.clear(nx.id);
      try { nx.fn(); } catch (e) { fail('a timer threw: ' + (e && e.stack || e)); }
      await settle();
    }
  }
  // healthy network until nothing is pending: every request answered, every due timer run, every re-entry booted
  async function drain(limit) {
    for (let i = 0; i < (limit || 600); i++) {
      for (const w of windows) if (w.wantReload && w.status !== 'dead') { kill(w); boot(w); }
      await settle();
      if (queue.length) { await serve(queue[0], false); continue; }
      const nx = clock.next();
      if (nx) { clock.advanceTo(nx.at); await runDue(); continue; }
      if (windows.some(w => w.status === 'booting' || w.wantReload)) { await settle(); continue; }
      return true;
    }
    return false;
  }
  return { seed, rand, clock, host, disk, root, windows, browsers, problems, fail, committedOwn, committedShared, deletedTurns, ownTitles, crewModel, deletedSessions, heroNames,
    boot, kill, edit, change, persist, step, drain, serve, queue, watchStation, setHealthy: v => { healthyPhase = !!v; }, setIntercept: fn => { intercept = fn; } };
}

// ---- one seed: random interleaving with faults, then a healthy network and one more change per window ----
async function runSeed(seed, opts) {
  const W = world(seed, opts);
  for (const w of W.windows) W.boot(w);
  if (!await W.drain()) W.fail('the first boots never settled');
  for (let i = 0; i < STEPS && W.problems.length === 0; i++) await W.step(true);
  // healthy from here: every window up, everything answered. A window whose boot read nothing during the faults sits at the
  // save-unreachable gate, which asks again once the station answers (app.js): the same as booting it again
  for (let round = 0; round < 3; round++) {
    for (const w of W.windows) if (w.status === 'dead' || w.status === 'gated') W.boot(w);
    if (!await W.drain()) W.fail('I2: the station and the windows never went quiet');
    if (!W.windows.some(w => w.status === 'gated')) break;
  }
  W.setHealthy(true);
  // I2: no wedge — each window, in turn, makes one more change, and it lands
  for (const w of W.windows) {
    if (w.status !== 'live') { W.fail('I2: ' + w.name + ' is ' + w.status + ' on a healthy network'); continue; }
    const text = W.edit(w, 'own');   // a change to its own sessions: one only this window writes
    if (!await W.drain()) W.fail('I2: ' + w.name + '\'s last change never went quiet');
    const h = w.page.health();
    if (h.conflict) W.fail('I2: ' + w.name + ' holds a conflict that will not clear (' + JSON.stringify({ reset: h.conflict.reset, reseeded: h.conflict.reseeded, ownSeed: h.conflict.ownSeed }) + ')');
    if (!turnsOf(W.host.saveStore.load('agent')).has(text)) W.fail('I2: ' + w.name + '\'s change "' + text + '" never reached the station file');
  }
  // I3: no loss — every persisted turn is IN THE STATION FILE, a turn in a session two windows both wrote (General) too
  const doc = W.host.saveStore.load('agent');
  const station = turnsOf(doc);
  for (const t of W.committedOwn) if (!station.has(t)) { W.fail('I3: turn "' + t + '" (a window\'s own session) is not in the station file'); break; }
  for (const t of W.committedShared) if (!station.has(t)) { W.fail('I3: turn "' + t + '" (General, which other windows write too) is not in the station file'); break; }
  // I3: no silent revert — every non-session change a window made is in the station file (unless the boot merge holds it)
  for (const [win, model] of W.crewModel) { const c = (doc.agents || []).find(a => a.id === 'crew-' + win); if (!(c && c.model === model)) { W.fail('I3: ' + win + '\'s crew change (' + model + ') was reverted: the station has ' + JSON.stringify(c && c.model)); break; } }
  for (const [id, title] of W.ownTitles) { const s = (doc.workstreams || []).find(x => x.id === id); if (s && s.title !== title) { W.fail('I3: the rename of ' + id + ' to "' + title + '" was reverted: "' + s.title + '"'); break; } }
  for (const id of W.deletedSessions) if ((doc.workstreams || []).some(x => x.id === id)) { W.fail('I3: the delete of ' + id + ' was reverted'); break; }
  if (!W.heroNames.has(doc.agent && doc.agent.name)) W.fail('I3: the hero\'s name is one no window set: ' + JSON.stringify(doc.agent && doc.agent.name));
  return W;
}

const sessionsOf = doc => (doc && doc.workstreams || []).map(w => w.id);
const conflictFileNames = W => [...W.disk.files.keys()].map(k => path.basename(k)).filter(n => /^agent\.save-conflict-.*\.json$/.test(n));

(async () => {
  // ================= NAMED: a desktop window + a browser tab (the done-means) =================
  {
    const W = world(7, { windows: 3 });
    const [tab, , desk] = W.windows;
    W.kill(W.windows[1]);   // one tab of the browser, and the desktop window
    W.boot(tab); W.boot(desk);
    A.ok(await W.drain(), 'named: both windows boot');
    W.edit(tab); A.ok(await W.drain(), 'named: the tab saves');
    const before = W.host.saveStore.load('agent')._saveRevision;
    const text = W.edit(desk);   // the desktop window is behind the tab's save
    const deskGen = desk.gen;
    A.ok(await W.drain(), 'named: the desktop window\'s save settles');
    A.ok(desk.gen === deskGen && desk.reloads === 0 && desk.status === 'live', 'named: the desktop window was NOT reloaded (nothing typed, open or running in it is touched)');
    A.eq(desk.page.health().conflict, null, 'named: no conflict stands: no banner that will not clear');
    A.eq(desk.page.health().merging, true, 'named: its saves are merged from now on (the save light says so)');
    const st = W.host.saveStore.load('agent');
    A.ok(turnsOf(st).has(text) && st._saveRevision > before, 'named: the desktop window\'s change is in the station file, at a new revision');
    const note = desk.page.mergeNotice();
    A.ok(note && note.inSession && note.first && !(note.lost && note.lost.length), 'named: the window is told once that its saves are merged (' + JSON.stringify(note) + ')');
    A.eq(conflictFileNames(W), [], 'named: the refused save\'s copy is removed once the station holds all of it — nothing piles up beside the station');
    const text2 = W.edit(desk);
    A.ok(await W.drain(), 'named: the desktop window\'s next change settles');
    A.ok(turnsOf(W.host.saveStore.load('agent')).has(text2), 'named: and lands — autosave is not wedged');
    const text3 = W.edit(tab);
    A.ok(await W.drain(), 'named: the tab, now behind, saves');
    A.ok(turnsOf(W.host.saveStore.load('agent')).has(text3) && tab.page.health().conflict === null && tab.reloads === 0, 'named: the tab merges too, unreloaded: both windows\' work is in the station file');
    A.eq(W.problems, [], 'named: no invariant broke');
  }
  // ================= NAMED: qa/bugs 27bae3d6 — two tabs of ONE browser: a reload never boots the other tab's snapshot =================
  {
    const W = world(13, { windows: 2 });   // tabA and tabB share one browser cache and one BroadcastChannel
    const [ta, tb] = W.windows;
    W.boot(ta); A.ok(await W.drain(), '27bae3d6: tab A boots');
    W.boot(tb); A.ok(await W.drain(), '27bae3d6: tab B boots');
    A.ok(ta.page.journalKey() !== tb.page.journalKey(), '27bae3d6: two live tabs write two journals (' + ta.page.journalKey() + ' / ' + tb.page.journalKey() + ')');
    const b1 = W.edit(tb, 'own'); A.ok(await W.drain(), '27bae3d6: tab B saves');
    const a1 = W.edit(ta, 'own'); A.ok(await W.drain(), '27bae3d6: tab A, behind, saves');
    A.eq([ta.page.health().conflict, ta.reloads], [null, 0], '27bae3d6: tab A merged: no banner, no reload');
    const bKey = tb.page.journalKey();
    W.kill(tb); W.boot(tb); A.ok(await W.drain(), '27bae3d6: tab B reloads');
    A.eq(tb.page.journalKey(), bKey, '27bae3d6: the reloaded tab continues ITS OWN journal');
    const view = new Set([].concat(...tb.state.ws.map(s => s.history.map(t => t.content))));
    A.ok(view.has(b1) && view.has(a1), '27bae3d6: and resumes its own work, plus the station\'s (never the other tab\'s snapshot)');
    A.eq(tb.page.mergeNotice(), null, '27bae3d6: and never says another window\'s work is this one\'s (no merge notice)');
    const st = turnsOf(W.host.saveStore.load('agent'));
    A.ok(st.has(a1) && st.has(b1), '27bae3d6: both tabs\' work is in the station file');
    A.eq(W.problems, [], '27bae3d6: no invariant broke');
  }
  // ================= NAMED: a station that REFUSES the merge keeps the conflict standing, as before =================
  {
    const W = world(11, { windows: 3, noMerge: true });
    const [tab, , desk] = W.windows;
    W.kill(W.windows[1]);
    W.boot(tab); W.boot(desk);
    await W.drain();
    W.edit(tab); await W.drain();
    W.edit(desk); await W.drain();
    const c = desk.page.health().conflict;
    A.ok(c && c.conflict === true && c.recovery, 'named: a refused merge leaves the conflict standing, its save preserved beside the station');
    A.eq([desk.status, desk.reloads], ['live', 0], 'named: and the window is not reloaded');
    W.edit(desk); await W.drain();
    A.ok(desk.page.health().conflict && desk.page._mergeState().mergeRefused, 'named: its later saves are still refused and preserved (the old answer)');
    A.eq(W.queue.length, 0, 'named: nothing left pending');
  }
  // ================= NAMED (review 10-27): a behind window's NON-SESSION changes land, and are never reverted =================
  {
    const W = world(17, { windows: 3 });
    const [tab, , desk] = W.windows;
    W.kill(W.windows[1]);
    W.boot(tab); W.boot(desk); await W.drain();
    W.edit(tab, 'own'); await W.drain();   // the tab saves: the desktop window is behind
    W.edit(desk, 'own'); await W.drain();
    W.change(desk, 'hero'); W.change(desk, 'crew'); W.change(desk, 'rename');
    A.ok(await W.drain(), 'non-session: the behind window\'s changes settle');
    let st = W.host.saveStore.load('agent');
    A.eq(st.agent.name, desk.state.hero, 'non-session: the hero rename is in the station file');
    A.eq(((st.agents || []).find(a => a.id === 'crew-desk') || {}).model, W.crewModel.get('desk'), 'non-session: the crew change is in the station file');
    const [rid, rtitle] = [...W.ownTitles][0];
    A.eq((st.workstreams.find(w => w.id === rid) || {}).title, rtitle, 'non-session: the session rename is in the station file');
    A.eq([desk.reloads, desk.page.health().conflict], [0, null], 'non-session: no reload, no banner');
    // the tab (behind now, it did not see them) saves its own work: nothing of the desktop window's is reverted
    W.edit(tab, 'own'); W.change(tab, 'rename'); await W.drain();
    st = W.host.saveStore.load('agent');
    A.eq([st.agent.name, ((st.agents || []).find(a => a.id === 'crew-desk') || {}).model], [desk.state.hero, W.crewModel.get('desk')], 'non-session: the other window\'s next merge reverts none of it');
    const n = desk.page.mergeNotice();
    A.ok(n && n.inSession && !(n.lost && n.lost.length), 'non-session: the notice reports nothing lost');
    A.eq(W.problems, [], 'non-session: no invariant broke');
  }
  // ================= NAMED (review 10-27): a session ANOTHER window deleted is reported, never dropped without a word =================
  {
    const W = world(19, { windows: 3, separate: true });
    const [tab, , desk] = W.windows;
    W.kill(W.windows[1]);
    W.boot(tab); await W.drain();
    W.edit(tab, 'own'); await W.drain();   // the tab makes session S
    const sid = [...tab.own][0];
    W.boot(desk); await W.drain();        // the desktop window opens on it
    desk.state.ws = desk.state.ws.filter(x => x.id !== sid); desk.state.deleted.push(sid); W.persist(desk);   // and deletes S
    await W.drain();
    A.ok(!W.host.saveStore.load('agent').workstreams.some(x => x.id === sid), 'cross-delete: the desktop window\'s delete is in the station file');
    const s = tab.state.ws.find(x => x.id === sid); s.history.push({ role: 'user', content: 'typed into S after another window deleted it' }); W.persist(tab);   // the tab, behind, types into S
    A.ok(await W.drain(), 'cross-delete: the tab\'s save settles');
    const n = tab.page.mergeNotice();
    A.ok(n && n.lost && n.lost.some(x => x.id === sid) && n.kept, 'cross-delete: the tab is told that change could not land, and where its save is kept (' + JSON.stringify(n) + ')');
    A.ok(!W.host.saveStore.load('agent').workstreams.some(x => x.id === sid), 'cross-delete: the delete stands');
    const kept = W.disk.files.get(path.join(W.root, n.kept));
    A.ok(kept && kept.data.includes('typed into S after another window deleted it'), 'cross-delete: the kept copy holds the turn');
    A.eq([tab.reloads, tab.page.health().conflict], [0, null], 'cross-delete: no reload, no banner');
  }
  // ================= NAMED (review 10-27): two windows typing in General, hundreds of turns: no copies, no reloads, no loss =================
  {
    const W = world(23, { windows: 3, separate: true });
    const [a, , b] = W.windows;
    W.kill(W.windows[1]);
    W.boot(a); W.boot(b); await W.drain();
    const typed = [];
    for (let round = 0; round < 150; round++) {
      typed.push(W.edit(a, 'general')); await W.drain();
      typed.push(W.edit(b, 'general')); await W.drain();
    }
    const st = W.host.saveStore.load('agent');
    const g = (st.workstreams.find(w => w.id === 'general') || { history: [] }).history.map(t => t.content);
    const missing = typed.filter(t => g.indexOf(t) === -1);
    A.eq(missing, [], 'shared General: every one of ' + typed.length + ' turns is in the station\'s General');
    A.eq(g.length, new Set(g).size, 'shared General: and none twice');
    A.eq(st.workstreams.filter(w => /~restored/.test(w.id)).length, 0, 'shared General: no restored copies of the conversation (' + sessionsOf(st).length + ' sessions)');
    A.ok(JSON.stringify(st).length < 60000, 'shared General: the station grows by the turns typed, not by copies (' + JSON.stringify(st).length + ' bytes)');
    A.eq([a.reloads, b.reloads], [0, 0], 'shared General: no window was reloaded');
    A.eq(conflictFileNames(W), [], 'shared General: nothing piles up beside the station');
    A.eq(W.problems, [], 'shared General: no invariant broke');
  }
  // ================= NAMED (review 10-27): merges never prune away an earlier preserved copy =================
  {
    const W = world(29, { windows: 3, separate: true });
    const [a, , b] = W.windows;
    W.kill(W.windows[1]);
    W.host.saveStore.preserve('agent', Object.assign({}, W.host.saveStore.load('agent'), { _saveClient: 'yesterday-window', workstreams: [{ id: 'yesterday-only', title: 'Yesterday', history: [{ role: 'user', content: 'from yesterday' }] }] }));
    W.boot(a); W.boot(b); await W.drain();
    for (let round = 0; round < 24; round++) { W.edit(a, 'own'); await W.drain(); W.edit(b, 'own'); await W.drain(); }
    A.ok(conflictFileNames(W).indexOf('agent.save-conflict-yesterday-window.json') !== -1, 'prune: the earlier preserved copy is still on disk after ' + 48 + ' merged saves (' + conflictFileNames(W) + ')');
    A.ok(conflictFileNames(W).length <= 2, 'prune: merged saves leave nothing beside it');
  }
  // ================= NAMED (review 10-27): a PASSING refusal (a locked file) is asked again, never latched =================
  {
    const W = world(31, { windows: 3, separate: true });
    const [a, , b] = W.windows;
    W.kill(W.windows[1]);
    W.boot(a); W.boot(b); await W.drain();
    W.edit(a, 'own'); await W.drain();
    let refusedOnce = 0;
    W.setIntercept(req => {
      if (refusedOnce >= 2 || !req.init || typeof req.init.body !== 'string' || req.init.body.indexOf('"_saveMerge"') < 0) return null;
      refusedOnce++;
      return { ok: true, status: 200, json: async () => ({ ok: false, unreadable: true, error: 'the station file is unreadable right now' }) };
    });
    const t = W.edit(b, 'own');
    A.ok(await W.drain(), 'passing: the behind window\'s save settles after the file is readable again');
    W.setIntercept(null);
    A.eq(refusedOnce, 2, 'passing: its merge was refused as unreadable, twice');
    A.ok(turnsOf(W.host.saveStore.load('agent')).has(t), 'passing: and then landed, asked again');
    A.eq([b.page.health().conflict, b.page._mergeState().mergeRefused, b.reloads], [null, false, 0], 'passing: no standing conflict, never latched, no reload');
  }
  // ================= NAMED (review 10-27 live proof): a merge whose answer was lost, then the window dies and reopens =================
  // the station took the merge; the reopened window merges its copy again from the journal's merge description: nothing new,
  // so it opens on the station silently — never the boot merge's rules again (a copy kept beside the station, "your unsent
  // changes were not taken")
  {
    const W = world(41, { windows: 3, separate: true });
    const [a, , b] = W.windows;
    W.kill(W.windows[1]);
    W.boot(a); W.boot(b); await W.drain();
    W.edit(a, 'own'); await W.drain();
    const t = W.edit(b, 'own');   // b is behind: its save is refused, then merged
    for (let i = 0; i < 40 && !W.queue.some(q => q.win === b && /"_saveMerge"/.test(String(q.init && q.init.body))); i++) {
      if (W.queue.length) await W.serve(W.queue[0], false); else { const nx = W.clock.next(); if (!nx) break; W.clock.advanceTo(nx.at); nx.fn(); W.clock.clear(nx.id); }
      await settle();
    }
    const mreq = W.queue.find(q => q.win === b && /"_saveMerge"/.test(String(q.init && q.init.body)));
    A.ok(!!mreq, 'lost merge answer: the behind window\'s merge is on its way');
    if (mreq) await W.serve(mreq, true);   // the station takes it; the answer is lost
    A.ok(turnsOf(W.host.saveStore.load('agent')).has(t), 'lost merge answer: the station has the window\'s turn');
    W.kill(b); W.boot(b); A.ok(await W.drain(), 'lost merge answer: the window reopens');
    A.eq(b.page.mergeNotice(), null, 'lost merge answer: it opens on the station, no boot merge and no notice');
    A.eq(conflictFileNames(W), [], 'lost merge answer: no copy kept beside the station');
    A.ok(b.state.ws.some(s => s.history.some(x => x.content === t)), 'lost merge answer: and its view holds its own turn');
  }
  // ================= NAMED (review 10-27 live proof): a window dies with an unsent SETTINGS change; another window saved meanwhile =================
  // the reopened window merges its copy three-way from the journal's own merge description: the change lands (never the boot
  // merge's sessions-only rules), nothing is kept beside the station, and it says its unsent changes were merged
  {
    const W = world(43, { windows: 3, separate: true });
    const [a, , b] = W.windows;
    W.kill(W.windows[1]);
    W.boot(a); W.boot(b); await W.drain();
    W.edit(b, 'own'); await W.drain();
    W.change(b, 'crew'); W.change(b, 'hero');   // persisted to b's journal, never sent: b dies inside the debounce
    const model = W.crewModel.get('b') || W.crewModel.get(b.name), hero = b.state.hero;
    W.kill(b);
    W.edit(a, 'own'); await W.drain();   // the station moves on without b's change
    W.boot(b); A.ok(await W.drain(), 'crash journal: the window reopens');
    const st = W.host.saveStore.load('agent');
    A.eq([((st.agents || []).find(x => x.id === 'crew-' + b.name) || {}).model, st.agent.name], [model, hero], 'crash journal: its unsent crew and hero changes are in the station file');
    const n = b.page.mergeNotice();
    A.ok(n && n.threeWay && !(n.lost && n.lost.length), 'crash journal: it says its unsent changes were merged (' + JSON.stringify(n) + ')');
    A.eq(conflictFileNames(W), [], 'crash journal: nothing kept beside the station');
    A.eq(W.problems, [], 'crash journal: no invariant broke');
  }
  // ================= NAMED (review 10-27): a broadcast run end makes both windows persist at once — neither reloads =================
  {
    const W = world(37, { windows: 3, separate: true });
    const [a, , b] = W.windows;
    W.kill(W.windows[1]);
    W.boot(a); W.boot(b); await W.drain();
    for (let i = 0; i < 20; i++) {
      W.edit(i % 2 ? a : b, 'own');
      W.persist(a); W.persist(b);   // the run end, in both windows
      await W.drain();
    }
    A.eq([a.reloads, b.reloads, a.page.health().conflict, b.page.health().conflict], [0, 0, null, null], 'run end: 20 broadcast run ends, both windows persisting: no reload, no banner');
    A.eq(W.problems, [], 'run end: no invariant broke');
  }

  // ================= SEEDED =================
  const started = Date.now();
  let failed = 0, reloads = 0, merged = 0;
  const seeds = ONLY != null ? [ONLY] : Array.from({ length: SEEDS }, (_, i) => i + 1);
  for (const seed of seeds) {
    let W;
    try { W = await runSeed(seed, SEEDED_OPTS); }
    catch (e) { failed++; A.ok(false, 'seed ' + seed + ' threw: ' + (e && e.stack || e)); if (failed > 5) break; continue; }
    for (const w of W.windows) { reloads += w.saveReloads; if (w.page && w.page.health().merging) merged++; }
    if (W.problems.length) {
      failed++;
      A.ok(false, 'seed ' + seed + ': ' + W.problems.slice(0, 3).join(' | ') + ' (replay: SAVE_INTERLEAVE_ONLY=' + seed + ')');
      if (failed > 5) break;
    }
  }
  A.eq(failed, 0, seeds.length + ' seeded interleavings keep I1-I5 (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  console.log('save-interleave: ' + seeds.length + ' seeds in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s; windows merging at the end: ' + merged + '; save-path reloads (no base to merge on): ' + reloads);
  A.report('save-interleave.seeded');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
