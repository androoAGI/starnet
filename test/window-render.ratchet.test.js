/* node test/window-render.ratchet.test.js — THE WINDOW RENDER CONTRACT (wave 4: gh#85, window-open-lag-1026, email E14).

   Opening or refreshing a station window must cost the part that changed, not the whole window, and a closed window must
   give back everything it armed. Each block below is a CLASS of window, not one window, and fails on the base commit
   (0b8441064), where every background change rebuilt its window synchronously and teardown was per window and opt-in:

     1. BACKGROUND DOOR — no quest/dossier store, and no other module's background poke, rebuilds a window synchronously:
        they mark it stale through StationUI.invalidate. (Six quest stores each called rerender('quests', false) on every
        sync, so one tick rebuilt the QUEST LOG up to six times, and each rebuild ran their syncs again.)
     2. ONE PAINT PER FRAME — the real invalidate/flushStale/paintStale, executed: any number of pokes in a frame is one
        paint; a closed window costs nothing; a minimized one is owed its paint until it is restored; a poke during the
        window's own build is owed to that build; a named section repaints only itself; a window's own background repaint
        ('*', SETTINGS) is used for whole-window pokes.
     3. WINDOW SCOPE — the real makeWindowScope, executed: dispose stops every timer, listener, bus subscription and owned
        stop; a named slot keeps exactly one timer across rebuilds; nothing can be armed after dispose.
     4. CLOSE DISPOSES — the real closeTerm runs the window's scope dispose and drops any paint still owed.
     5. LAZY PANES — the QUEST LOG builds only the views that have been shown (executed in quest-log-window.test).
     6. WINDOW POLLS ARE OWNED — every window module that arms an interval hands its stop to the window scope. */
'use strict';
const fs = require('fs'), path = require('path'), A = require('./_assert');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sui = read('frontend/app/stationui.js');
const APP = path.join(ROOT, 'frontend/app');

/* ---- 1. BACKGROUND DOOR ---- */
{
  const stores = fs.readdirSync(APP).filter(f => /store\.js$/.test(f));
  A.ok(stores.length >= 20, 'every *store.js module is read (' + stores.length + ')');
  const syncRebuilds = stores.filter(f => /StationUI\.rerender\s*\(/.test(read('frontend/app/' + f)));
  A.eq(syncRebuilds, [], 'no store rebuilds a window synchronously: a store change is a StationUI.invalidate');
  for (const f of ['goalstore', 'journeystore', 'maintqueststore', 'stationqueststore', 'workqueststore', 'queststatestore', 'questledgerstore', 'questrefreshstore', 'dossierstore'])
    A.ok(/StationUI\.invalidate\('quests'\)/.test(read('frontend/app/' + f + '.js')), f + ': its quest-log poke goes through invalidate');
  // the background pokes outside the stores: a chat answer landing in the dossier, a specialty applied, a key saved from
  // the CTA or the command bar, the Update Center's own state. These are not the Commander clicking in that window.
  // any spelling of the synchronous call (with or without a swap argument) is caught
  A.ok(!/\.rerender\(\s*'commander'/.test(read('frontend/app/chat.js')) && /StationUI\.invalidate\('commander', null, \{ fresh: true \}\)/.test(read('frontend/app/chat.js')), 'chat.js: an answer landing repaints the dossier through invalidate (fresh: the new belief shows)');
  A.ok(!/\.rerender\(\s*'agents'/.test(read('frontend/app/app.js')) && /StationUI\.invalidate\('agents', null, \{ fresh: true \}\)/.test(read('frontend/app/app.js')), 'app.js: a specialty applied repaints the open dossier through invalidate, its editor showing the new purpose');
  A.ok(/Updates\.init\(\{ notify: StationUI\.notify, rerender: key => StationUI\.invalidate\(key, null, \{ fresh: true \}\) \}\)/.test(read('frontend/app/app.js')), 'the Update Center is handed the background door (fresh: its controls show the new state)');
  for (const f of ['keycta', 'stationcommands']) A.ok(!/\.rerender\(\s*'settings'/.test(read('frontend/app/' + f + '.js')), f + '.js: a key saved elsewhere repaints SETTINGS through invalidate');
  // RATCHET: the synchronous door from outside stationui.js is for the Commander's own clicks. The count only goes down.
  const outside = fs.readdirSync(APP).filter(f => f.endsWith('.js') && f !== 'stationui.js')
    .concat(fs.readdirSync(path.join(APP, 'windows')).filter(f => f.endsWith('.js')).map(f => 'windows/' + f));
  const syncCalls = outside.reduce((n, f) => n + (read('frontend/app/' + f).match(/(?:\bStationUI(?:\.h)?|\bui|\bUI\(\)|\b[Hh])\.rerender\s*\(/g) || []).length, 0);
  A.eq(outside.filter(f => /\{[^}]*\brerender\b[^}]*\}\s*=\s*(?:StationUI|H|h)\b/.test(read('frontend/app/' + f))), [], 'no module destructures rerender out of StationUI (it would hide from this count)');
  const CEILING = 4;   // pluginhost.js swaps a frame whose code changed (3), automation.js opens AWAY WORK on the Commander's click (1)
  A.ok(syncCalls <= CEILING, 'synchronous rerender calls from outside stationui.js: ' + syncCalls + ' (ceiling ' + CEILING + '; it only goes down)');
  A.ok(/StationUI\.h\.rerender\('automation'\)/.test(read('frontend/app/windows/automation.js')), '(the ceiling counts real sites: automation.js still has its click-driven one)');
}

/* ---- 1b. INSIDE stationui.js: the background paths (a notification landing, waits settling, the badge tick, the quest poll,
   the 1 s tick) never rebuild a window synchronously; every other rerender( is a click handler. The file's count only goes down. */
{
  for (const fn of ['  function notify(', '  function settleNotifs(', '  function seenSession(', '  function settleStoredWait(', '  function badges(', '  function pokeQuests(', '  function tick(', '  function crewTick('].filter(h => sui.includes(h))) {
    const body = A.fnBody(sui, fn);
    A.ok(body.length > 20 && body.length < 20000, fn.trim() + ' is sliced');
    A.ok(!/\brerender\(/.test(body), fn.trim() + ': a background path repaints through invalidate, never a synchronous rebuild');
  }
  const inFile = (sui.match(/\brerender\('/g) || []).length;
  const FILE_CEILING = 106;   // the Commander's own clicks (QUEST LOG, SETTINGS, the dossier, NOTIFICATIONS' buttons) - it only goes down
  A.ok(inFile <= FILE_CEILING, 'synchronous rerender(\'...\') calls inside stationui.js: ' + inFile + ' (ceiling ' + FILE_CEILING + ')');
}

/* ---- 2. ONE PAINT PER FRAME (the real functions, executed) ---- */
const slice = header => { const b = A.fnBody(sui, header); A.ok(b.length > 40 && b.length < 6000, header + ' is sliced'); return b; };
const contract = slice('  function invalidate(') + '\n' + slice('  function paintStale(') + '\n' + slice('  function flushStale(');
function rig() {
  const frames = [];
  const run = new Function('open', 'minimized', 'nextFrame', `
    const staleWins = {}, staleFresh = {}; let staleFrame = 0;
    ${contract}
    return { invalidate, flushStale, staleWins };`);
  const open = {}, minimized = {};
  const api = run(open, minimized, fn => { frames.push(fn); return frames.length; });
  const win = () => {
    const w = { paints: 0, building: false, _render(swap) { this.paints++; this.lastSwap = swap; }, _isBuilding() { return this.building; } };
    return w;
  };
  const frame = () => { const fs2 = frames.splice(0); fs2.forEach(f => f()); return fs2.length; };
  return Object.assign(api, { open, minimized, frames, frame, win });
}
{
  const r = rig(), w = r.win(); r.open.quests = w;
  for (let i = 0; i < 50; i++) r.invalidate('quests');
  A.eq(w.paints, 0, 'fifty pokes paint nothing before the frame');
  A.eq(r.frames.length, 1, '...and ask for exactly one frame');
  r.frame();
  A.eq(w.paints, 1, 'fifty pokes in one frame are ONE paint');
  A.eq(w.lastSwap, false, 'a background paint is a data paint (no crossfade, typed fields carried across)');
  r.frame();
  A.eq(w.paints, 1, 'nothing is painted again without a new poke');

  A.eq(r.invalidate('settings'), false, 'a closed window: invalidate says so');
  A.eq(r.frames.length, 0, '...and costs no frame');

  const m = r.win(); r.open.notifs = m; r.minimized.notifs = true;
  r.invalidate('notifs'); r.frame();
  A.eq(m.paints, 0, 'a minimized window is not painted while nobody can see it');
  A.ok(r.staleWins.notifs === true, '...its paint stays owed for restoreTerm');
  A.ok(/const owedPaint = staleWins\[key\], owedFresh = !!staleFresh\[key\]; delete staleWins\[key\]; delete staleFresh\[key\];\s*if \(owedPaint && key !== 'agents'\) \{ try \{ paintStale\(w, owedPaint, owedFresh\); \} catch \(_\) \{\} \}/.test(A.fnBody(sui, '  function restoreTerm(')), 'restoreTerm pays the owed paint once, when the window is seen again');

  const b = r.win(); r.open.tasks = b; b.building = true;
  r.invalidate('tasks');
  A.eq(r.frames.length, 0, 'a poke during the window\'s own build schedules no frame');
  A.eq(b.paints, 1, '...it is handed to the build (w._render owes exactly one follow-up), so a store poking from its own sync cannot loop the window');
  b.building = false;

  const s = r.win(); r.open.agents = s; let part = 0, own = 0;
  s._sections = { memory: () => { part++; } };
  r.invalidate('agents', 'memory'); r.invalidate('agents', 'memory'); r.frame();
  A.eq([part, s.paints], [1, 0], 'a named section repaints only itself, once');
  r.invalidate('agents', 'memory'); r.invalidate('agents', 'no-such-part'); r.frame();
  A.eq(s.paints, 1, 'an unknown section repaints the window (never silently skipped)');
  s._sections['*'] = () => { own++; };
  r.invalidate('agents'); r.frame();
  A.eq([own, s.paints], [1, 1], 'a window with its own background repaint (\'*\') gets that instead of a rebuild');
  s._sections.memory = () => { throw new Error('x'); };
  delete s._sections['*'];
  r.invalidate('agents', 'memory'); r.frame();
  A.eq(s.paints, 2, 'a section painter that throws falls back to a whole-window paint');
  A.ok(/sectionsOf\(body\)\['\*'\] = scheduleSettingsRepaint;/.test(sui), 'SETTINGS takes its coalesced, scroll-keeping repaint for background pokes');

  // FRESH: the new truth shows in the fields (no draft carried across), still once per frame, and it wins over a draft-keeping poke
  const f = r.win(); r.open.updates = f;
  r.invalidate('updates'); r.invalidate('updates', null, { fresh: true }); r.invalidate('updates'); r.frame();
  A.eq([f.paints, f.lastSwap], [1, 'fresh'], 'a fresh poke paints once, with no field carried across, even beside a draft-keeping one');
  f._sections = { part: () => { throw new Error('never'); } };
  r.invalidate('updates', 'part', { fresh: true }); r.frame();
  A.eq([f.paints, f.lastSwap], [2, 'fresh'], 'a fresh poke repaints the window, never only a section');
  // a throwing window does not cost the others their frame
  const bad = r.win(); bad._render = () => { throw new Error('builder threw'); }; r.open.apps = bad;
  const good = r.win(); r.open.trophies = good;
  r.invalidate('apps'); r.invalidate('trophies'); r.frame();
  A.eq(good.paints, 1, 'one window\'s throwing builder never drops another window\'s owed paint');
  A.ok(/if \(swap === true\) \{\s*body\.classList\.remove\('swap-in'\)/.test(sui), 'only the Commander\'s own swap crossfades (a fresh or draft-keeping background paint never blinks)');
  A.ok(/const keep = swap === false \? captureForms\(\) : null;/.test(sui), '...and only a draft-keeping paint carries fields across');
  A.ok(/function rerender\(key, swap\) \{ if \(open\[key\]\) \{ delete staleWins\[key\]; delete staleFresh\[key\];/.test(sui), 'a synchronous rebuild settles the paint owed to that window (no second rebuild next frame)');
}

/* ---- 3. WINDOW SCOPE (the real makeWindowScope, executed) ---- */
{
  const src = slice('  function makeWindowScope(');
  const timers = new Map(); let seq = 0;
  const listeners = new Set(), bus = new Map();
  const U = { bus: { on: (n, f) => bus.set(n, (bus.get(n) || 0) + 1), off: n => bus.set(n, bus.get(n) - 1) } };
  const make = new Function('U', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', src + '\nreturn makeWindowScope;')(U,
    (fn, ms) => { const id = ++seq; timers.set(id, ms); return id; }, id => timers.delete(id),
    (fn, ms) => { const id = ++seq; timers.set(id, ms); return id; }, id => timers.delete(id));
  const doc = { addEventListener: (t, f) => listeners.add(t + ':' + f.name), removeEventListener: (t, f) => listeners.delete(t + ':' + f.name) };
  const sc = make();
  sc.every(function a() {}, 1000); sc.after(function b() {}, 500);
  for (let i = 0; i < 25; i++) sc.every(function poll() {}, 4000, 'poll');   // a window rebuilt 25 times re-arms its poller
  A.eq([...timers.values()].filter(ms => ms === 4000).length, 1, 'a named slot keeps exactly one poller across 25 rebuilds');
  sc.on(doc, 'keydown', function onKey() {}); sc.bus('agent.run.end', () => {});
  let ownedStops = 0; sc.own('signin', () => { ownedStops++; }); sc.own('signin', () => { ownedStops += 10; });
  A.ok(timers.size === 3 && listeners.size === 1 && bus.get('agent.run.end') === 1, 'the scope holds what the window armed');
  sc.dispose();
  A.eq([timers.size, listeners.size, bus.get('agent.run.end')], [0, 0, 0], 'dispose stops every timer and removes every outside listener and subscription');
  A.eq(ownedStops, 10, 'an owned stop runs once at dispose (the replaced one is never run twice)');
  A.ok(sc.disposed, '...and says so');
  A.eq(sc.every(() => {}, 1000), null, 'nothing can be armed on a disposed scope');
  let late = 0; sc.add(() => { late++; });
  A.eq(late, 1, 'a teardown handed to a disposed scope runs at once');
  A.eq(timers.size, 0, 'a closed window holds no timer');
  A.ok(/return buildScope \|\| DEAD_SCOPE;/.test(A.fnBody(sui, '  function scopeOf(')), 'a pane built before it is attached gets its window\'s scope; outside any window, a disposed one');
  A.ok(/buildScope = w\._scope;[^\n]*\n\s*try \{ builder\(body\); \} finally \{ buildScope = outerScope; \}/.test(sui), 'the window scope is in force exactly while its builder runs');
}

/* ---- 4. CLOSE DISPOSES (the real closeTerm) ---- */
{
  const closeTerm = slice('  function closeTerm(');
  const run = new Function('closeTermSrc', `
    const open = {}, minimized = {}, staleWins = { quests: true };
    const removeChip = () => {}, sfx = () => {}, syncBB = () => {}, syncScrim = () => {};
    const document = { getElementById: () => null };
    eval(closeTermSrc);
    let disposed = 0;
    const win = { style: {}, classList: { add() {} }, addEventListener() {}, isConnected: true, remove() {}, _scope: { dispose() { disposed++; } } };
    open.quests = win;
    closeTerm('quests'); closeTerm('quests');
    return { disposed, staleWins };`);
  const r = run(closeTerm);
  A.eq(r.disposed, 1, 'closing a window disposes its scope, once');
  A.ok(!('quests' in r.staleWins), 'a paint still owed to a closed window is dropped');
  A.ok(/w\._scope = makeWindowScope\(\);/.test(sui), 'every window is given its scope when it is made');
}

/* ---- 5. LAZY PANES ---- */
{
  const bq = A.fnBody(sui, '  function buildQuests(');
  A.ok(bq.length > 5000, 'buildQuests is sliced');
  for (const v of ['pass', 'available', 'goals', 'progress', 'completed']) A.ok(new RegExp("pane\\('" + v + "', '[^']*', \\(\\) =>").test(bq), 'QUEST LOG: the ' + v.toUpperCase() + ' view is built only once it has been shown');
  A.ok(!/<section id="q-view-pass"[^']*' \+ passHtml\(\)/.test(bq), 'no view is built eagerly into the window HTML');
}

/* ---- 6. WINDOW POLLS ARE OWNED ---- */
{
  const dir = path.join(APP, 'windows');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = read('frontend/app/windows/' + f);
    // loops.js' module-level watch is the station's loop notifier (it runs with no window open, by design)
    const arms = (src.replace(/setTimeout\(\(\) => \{ watch\(\); setInterval\(watch, 25000\); \}, 6000\);/, '').match(/setInterval\(/g) || []).length;
    if (!arms) continue;
    // per interval, not per file: each arming site hands a stop (a direct .own( or the module's owning helper call)
    const owns = (src.match(/\.own\('/g) || []).length + (src.match(/\bownTimers\(\);/g) || []).length - (/function ownTimers\(\)/.test(src) ? 1 : 0);
    A.ok(/\.scopeOf\(/.test(src) && owns >= arms, 'windows/' + f + ': ' + arms + ' interval(s), ' + owns + ' handed to the window scope (close stops each at once)');
  }
}

A.report('window-render.ratchet');
