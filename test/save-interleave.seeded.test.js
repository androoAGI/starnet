/* test/save-interleave.seeded.test.js — no window can wedge autosave, lose another window's work, or boot a stale view
   (wave-1 save-latch-kill, 10-26 reliability audit family B3; gh#153, #121, starnet-releases#4, qa/bugs 27bae3d6).

   THE HARNESS. Real modules end to end: the REAL page (frontend/app/cloudsave.js + cloudsavecore.js, one vm per window)
   -> the REAL /api/save, /api/save/adopt handlers sliced out of the sidecar -> the REAL savestore, on an in-memory disk.
   Everything that decides an interleaving is injected and seeded: one virtual clock drives every page timer (the 1.2 s
   debounce, the backoff, the 15 s ACK deadline) and the handlers' clock; one seeded network decides when the station takes
   each request and whether its answer arrives. Per seed, three windows (two tabs of one browser + a desktop window) type
   into sessions while the network loses answers, drops requests, and windows crash and reopen.

   THE INVARIANTS, checked on every seed:
     I1 the station never goes back: every turn the station file held is still in it after each write, and every landed
        write moves its revision strictly forward (CAS is never relaxed: a merge is written as a new revision);
     I2 no wedge: once the network is healthy, every live window's conflict clears and its next change lands — no banner
        that will not clear;
     I3 no loss: every turn a window persisted is in the station file at the end — a turn typed into a session other windows
        also write (General) too: a session both sides changed is kept beside it as a restored copy, the next one if it
        diverges again (sidecar/save-restore.js);
     I4 no stale boot: a window that reloads or reopens never resumes a view without the turns it had itself persisted.
   SEEDS: SAVE_INTERLEAVE_SEEDS (default 500). A failing seed prints its number: SAVE_INTERLEAVE_ONLY=<seed> replays it.

   Plus two NAMED cases (the done-means): a desktop window + a browser tab — the one behind merges in-session and
   re-enters, never a banner that will not clear; and a station that REFUSES the merge still shows the conflict as before. */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const K = require('./_save-restore-kit.js');

const SEEDS = Math.max(1, Number(process.env.SAVE_INTERLEAVE_SEEDS) || 500);
const ONLY = process.env.SAVE_INTERLEAVE_ONLY ? Number(process.env.SAVE_INTERLEAVE_ONLY) : null;
const STEPS = 70;
const SEEDED_OPTS = { separate: process.env.SAVE_INTERLEAVE_SEPARATE !== '0' };   // every window its own browser (shared-browser tabs: the journal slice)
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
  const brief = d => d ? { rev: d._saveRevision, dirty: d._saveDirty, client: String(d._saveClient || '').slice(0, 14), sessions: (d.workstreams || []).map(w => w.id + ':' + (w.history || []).length).join(',') } : null;
  // a founded station: the windows boot onto it (a missing one is onboarding, not this harness)
  host.saveStore.save('agent', { schema: 'starnet.save', version: 6, updatedAt: clock.now(), _saveRevision: 0, _saveDirty: false, _saveClient: 'founder',
    agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, agents: [], generalId: 'general', activeId: 'general', deletedIds: [],
    workstreams: [{ id: 'general', title: null, history: [{ role: 'user', content: 'founded' }] }] }, { compareRevision: true });
  let uuidSeq = 0, turnSeq = 0, reqSeq = 0;
  const uuid = () => 'p' + seed.toString(36) + '-' + (++uuidSeq).toString(36) + '-' + Math.floor(rand() * 1e9).toString(36);

  // the station: watch every write (I1)
  let lastRev = -1, lastTurns = new Set();
  function watchStation(label) {
    const doc = host.saveStore.load('agent');
    if (!doc) return;
    const rev = Number(doc._saveRevision) || 0;
    const turns = turnsOf(doc);
    if (rev !== lastRev) {
      if (rev < lastRev) fail('I1: the station revision went back ' + lastRev + ' -> ' + rev + ' (' + label + ')');
      for (const t of lastTurns) if (!turns.has(t)) fail('I1: the station lost turn "' + t + '" at revision ' + rev + ' (' + label + ')');
      lastRev = rev; lastTurns = turns;
    } else if (turns.size !== lastTurns.size || [...turns].some(t => !lastTurns.has(t))) fail('I1: the station changed without a new revision (' + label + ')');
  }

  // ---- the network ----
  const queue = [];   // requests the station has not taken yet
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
    let res;
    try { res = await host.fetch(req.url, req.init); } catch (e) { fail('the station threw on ' + req.url + ': ' + (e && e.message)); return; }
    if (tracing) { let b = null; try { b = await res.json(); } catch (_) {} const sent = req.init && req.init.body ? JSON.parse(req.init.body) : null; trace('serve', req.url, 'from', req.win.name + '#' + req.gen, lose ? 'LOST' : '', JSON.stringify(brief(sent)), '->', JSON.stringify(b && (b.save ? { save: brief(b.save) } : b.doc ? Object.assign({}, b, { doc: brief(b.doc) }) : b)).slice(0, 400)); }
    watchStation(req.url + ' from ' + req.win.name);
    const alive = req.win.gen === req.gen && req.win.status !== 'dead';
    if (!lose && alive && !req.done) { req.done = true; req.resolve(res); }
    await settle();
  }
  // a request the station never takes (an outage): the page's deadline ends the wait
  function drop(req) { const i = queue.indexOf(req); if (i >= 0) queue.splice(i, 1); trace('DROP', req.url, 'from', req.win.name + '#' + req.gen); }

  // ---- browsers and windows ----
  function browser(name) { return { name, cache: new Map() }; }
  // opts.separate: every window in a browser of its own (no shared browser cache)
  const browsers = [browser('chrome'), browser('desktop'), browser('other')];
  const windows = [
    { name: 'tabA', browser: browsers[0] },
    { name: 'tabB', browser: opts.separate ? browsers[2] : browsers[0] },
    { name: 'desk', browser: browsers[1] }
  ].slice(0, opts.windows || 3).map(w => Object.assign(w, { gen: 0, status: 'dead', page: null, state: null, mine: new Set(), own: new Set(), session: new Map(), wantReload: false, boot: null }));
  const committedOwn = new Set(), committedShared = new Set();

  function docOf(w) {
    return { schema: 'starnet.save', version: 6, agent: { id: 'agent', name: 'NOVA', createdAt: 5000 }, agents: [], generalId: 'general', activeId: 'general', deletedIds: [], workstreams: clone(w.state) };
  }
  function cacheKey(w) { return opts.journalKey ? opts.journalKey(w) : 'starnet.save'; }
  function boot(w) {
    w.gen++;
    const gen = w.gen, owner = w.name + '#' + gen;
    w.status = 'booting'; w.wantReload = false; w.state = null;
    const sessionStorage = { getItem: k => (w.session.has(k) ? w.session.get(k) : null), setItem: (k, v) => w.session.set(k, String(v)), removeItem: k => w.session.delete(k) };
    const extra = {
      console: quiet, Date: VDate, setTimeout: (fn, ms) => clock.set(fn, ms, owner), clearTimeout: id => clock.clear(id),
      crypto: { randomUUID: uuid }, sessionStorage,
      location: { reload() { if (w.gen === gen) w.wantReload = true; } }
    };
    if (opts.pageExtra) Object.assign(extra, opts.pageExtra(w, gen));
    w.page = K.page({ fetch: pageFetch(w, gen) }, w.browser.cache, extra);
    const local = opts.bootLocal ? opts.bootLocal(w) : (() => { try { return JSON.parse(w.browser.cache.get('starnet.save') || 'null'); } catch (_) { return null; } })();
    trace('boot', w.name + '#' + gen, 'local', JSON.stringify(brief(local)));
    w.boot = w.page.reconcile(local).then(doc => {
      trace('booted', w.name + '#' + gen, JSON.stringify(brief(doc)), 'merge', JSON.stringify(w.page.mergeNotice()));
      if (w.gen !== gen) return;
      if (!doc || doc.__saveUnknown || doc.__futureSave || !Array.isArray(doc.workstreams)) { w.status = 'gated'; return; }
      w.state = clone(doc.workstreams);
      w.status = 'live';
      // I4: never a view without the turns this window persisted into its own sessions (a turn in General, which other windows
      // write too, may come back as a restored copy, or only in a copy kept beside the station: I3 holds it to that)
      const view = turnsOf(doc);
      for (const t of w.mine) if (!view.has(t)) { fail('I4: ' + w.name + ' booted a view without its own turn "' + t + '"'); break; }
    }, e => { fail(w.name + ' boot threw: ' + (e && e.stack || e)); w.status = 'gated'; });
  }
  function kill(w) {
    if (w.status === 'dead') return;
    trace('kill', w.name + '#' + w.gen);
    w.status = 'dead'; clock.kill(w.name + '#' + w.gen); w.gen++;   // the page is gone: its timers and answers with it
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
    const own = w.state.filter(s => w.own.has(s.id));
    const r = kind === 'own' ? 0 : rand();
    if (r < 0.35 || !own.length) {
      const id = w.name + '-s' + turnSeq;
      w.state.push({ id, title: 'S ' + id, history: [{ role: 'user', content: text }] });
      w.own.add(id); committedOwn.add(text);
    } else if (r < 0.8) {
      pick(own).history.push({ role: 'user', content: text }); committedOwn.add(text);
    } else {
      let g = w.state.find(s => s.id === 'general');
      if (!g) { g = { id: 'general', title: null, history: [] }; w.state.unshift(g); }
      g.history.push({ role: 'user', content: text }); committedShared.add(text);
    }
    if (!committedShared.has(text)) w.mine.add(text);
    trace('edit', w.name + '#' + w.gen, text, committedShared.has(text) ? 'GENERAL' : 'own', 'rev', w.page.revision());
    persist(w);
    return text;
  }

  // one scheduler step: a timer, the station taking a request (or losing its answer, or never taking it), a window typing,
  // crashing or reopening
  async function step(faults) {
    for (const w of windows) if (w.wantReload && w.status !== 'dead') { kill(w); boot(w); }   // cloudsave asked to re-enter
    const r = rand();
    if (queue.length && r < 0.45) {
      const req = pick(queue);
      const x = rand();
      if (faults && x < 0.08) await serve(req, true);
      else if (faults && x < 0.13) drop(req);
      else await serve(req, false);
    } else if (r < 0.7) {
      const live = windows.filter(w => w.status === 'live');
      if (live.length) edit(pick(live));
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
  return { seed, rand, clock, host, disk, root, windows, browsers, problems, fail, committedOwn, committedShared, boot, kill, edit, persist, step, drain, serve, queue, watchStation };
}

// ---- one seed: random interleaving with faults, then a healthy network and one more change per window ----
async function runSeed(seed, opts) {
  const W = world(seed, opts);
  for (const w of W.windows) W.boot(w);
  if (!await W.drain()) W.fail('the first boots never settled');
  for (let i = 0; i < STEPS && W.problems.length === 0; i++) await W.step(true);
  // healthy from here: every window up, everything answered
  for (const w of W.windows) if (w.status === 'dead' || w.status === 'gated') W.boot(w);
  if (!await W.drain()) W.fail('I2: the station and the windows never went quiet');
  // I2: no wedge — each window, in turn, makes one more change, and it lands
  for (const w of W.windows) {
    if (w.status !== 'live') { W.fail('I2: ' + w.name + ' is ' + w.status + ' on a healthy network'); continue; }
    const text = W.edit(w, 'own');   // a change to its own sessions: one only this window writes
    if (!await W.drain()) W.fail('I2: ' + w.name + '\'s last change never went quiet');
    const h = w.page.health();
    if (h.conflict) W.fail('I2: ' + w.name + ' holds a conflict that will not clear (' + JSON.stringify({ reset: h.conflict.reset, reseeded: h.conflict.reseeded, ownSeed: h.conflict.ownSeed }) + ')');
    if (!turnsOf(W.host.saveStore.load('agent')).has(text)) W.fail('I2: ' + w.name + '\'s change "' + text + '" never reached the station file');
  }
  // I3: no loss — every persisted turn is IN THE STATION FILE, a turn in a session two windows both wrote (General) too: the
  // merge keeps a diverged session beside it as a restored copy, and a session that diverges again gets the next copy (never
  // only the copy kept beside the station, which is pruned)
  const station = turnsOf(W.host.saveStore.load('agent'));
  for (const t of W.committedOwn) if (!station.has(t)) { W.fail('I3: turn "' + t + '" (a window\'s own session) is not in the station file'); break; }
  for (const t of W.committedShared) if (!station.has(t)) { W.fail('I3: turn "' + t + '" (General, which other windows write too) is not in the station file'); break; }
  return W;
}

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
    A.ok(desk.gen > deskGen && desk.status === 'live', 'named: the desktop window merged in-session and re-entered (reloaded onto the merge)');
    A.eq(desk.page.health().conflict, null, 'named: no conflict stands: no banner that will not clear');
    const st = W.host.saveStore.load('agent');
    A.ok(turnsOf(st).has(text) && st._saveRevision > before, 'named: the desktop window\'s change is in the station file, at a new revision');
    A.eq(desk.page.mergeNotice() && desk.page.mergeNotice().inSession, true, 'named: the re-entered window knows it reopened on a merge (its one notice)');
    const keptCopies = () => [...W.disk.files.keys()].map(k => path.basename(k)).filter(n => /^agent\.save-conflict-kept-/.test(n));
    A.eq(keptCopies().length, 1, 'named: the window\'s whole save is kept beside the station ONCE for its in-session merge (' + keptCopies() + ')');
    A.ok(/^agent\.save-conflict-kept-[^0-9]/.test(keptCopies()[0] || ''), 'named: named by the window, not by the time: its later rounds overwrite it, never prune older copies');
    const text2 = W.edit(desk);
    A.ok(await W.drain(), 'named: the desktop window\'s next change settles');
    A.ok(turnsOf(W.host.saveStore.load('agent')).has(text2), 'named: and lands — autosave is not wedged');
    const text3 = W.edit(tab);
    A.ok(await W.drain(), 'named: the tab, now behind, saves');
    A.ok(turnsOf(W.host.saveStore.load('agent')).has(text3) && tab.page.health().conflict === null, 'named: the tab merges and re-enters too: both windows\' work is in the station file');
    A.eq(W.problems, [], 'named: no invariant broke');
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
    A.eq(desk.status, 'live', 'named: and the window is not reloaded');
    const asked = W.queue.length;
    W.edit(desk); await W.drain();
    A.ok(desk.page.health().conflict, 'named: its later saves are still refused and preserved (the old answer)');
    A.eq(asked, 0, 'named: nothing left pending');
  }

  // ================= SEEDED =================
  const started = Date.now();
  let failed = 0;
  const seeds = ONLY != null ? [ONLY] : Array.from({ length: SEEDS }, (_, i) => i + 1);
  for (const seed of seeds) {
    let W;
    try { W = await runSeed(seed, SEEDED_OPTS); }
    catch (e) { failed++; A.ok(false, 'seed ' + seed + ' threw: ' + (e && e.stack || e)); if (failed > 5) break; continue; }
    if (W.problems.length) {
      failed++;
      A.ok(false, 'seed ' + seed + ': ' + W.problems.slice(0, 3).join(' | ') + ' (replay: SAVE_INTERLEAVE_ONLY=' + seed + ')');
      if (failed > 5) break;
    }
  }
  A.eq(failed, 0, seeds.length + ' seeded interleavings keep I1-I4 (' + ((Date.now() - started) / 1000).toFixed(1) + ' s)');
  console.log('save-interleave: ' + seeds.length + ' seeds in ' + ((Date.now() - started) / 1000).toFixed(1) + ' s');
  A.report('save-interleave.seeded');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
