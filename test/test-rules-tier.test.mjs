/* scripts/test-rules.mjs — the cheap "rules" tier is GENERATED from test/fast.list, never kept by hand (C15), and
   test/helpers/chrome-stop.mjs ends a Chrome child without ever signalling a PID that is no longer ours.

   Rules tier: the fast.list steps whose source (and whose helpers' sources) neither require sidecar/index.js, nor use
   child_process / spawn, nor call listen(, nor import a sidecar fixture, desk-station, strict-upstream, findChrome or
   helpers/ports. It is advisory and never replaces FAST. Red at 45e7ee302: the script does not exist.

   Chrome stop: exercised here with a FAKE child and injected kill / sleep (no browser, no process is started). The
   real Chrome behaviour is proven by running test/world-sharpen.test.mjs and test/worldlight-receiver.test.mjs. */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const A = require('./_assert.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const memo = new Map();
const rd = rel => { if (!memo.has(rel)) { const p = join(ROOT, rel); memo.set(rel, existsSync(p) ? readFileSync(p, 'utf8') : null); } return memo.get(rel); };
const listed = name => rd(name).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(s => s.split('|')[0].trim());

const mod = await import('../scripts/test-rules.mjs');
A.ok(typeof mod.selectRulesTier === 'function', 'scripts/test-rules.mjs exports selectRulesTier()');

const fast = listed('test/fast.list');
const out = mod.selectRulesTier({ fastList: fast, read: rd, slow: listed('test/slow.list'), flaky: listed('test/flaky.list') });
const tier = out.tier;

// ---- RED: a known pure test is in; a known spawning test is out; every pick is a line of fast.list ----
A.ok(existsSync(join(ROOT, 'test/run-outcome.test.js')), 'the known pure test exists');
A.ok(tier.includes('test/run-outcome.test.js'), 'the tier includes the pure test/run-outcome.test.js');
A.ok(existsSync(join(ROOT, 'test/persist-seam.http.test.js')), 'the known spawning test exists');
A.ok(!tier.includes('test/persist-seam.http.test.js'), 'the tier excludes the spawning test/persist-seam.http.test.js');
A.ok(tier.every(f => fast.includes(f)), 'every pick is a line of test/fast.list (there is no second list)');
A.eq(tier, [...new Set(tier)], 'no duplicates');
A.ok(out.skipped.some(s => s.file === 'test/persist-seam.http.test.js') || !fast.includes('test/persist-seam.http.test.js'),
  'a skipped step names the reason it was skipped, or was never on fast.list');

// ---- LIVENESS: the tier is non-empty and sized like a tier, and it is stable ----
A.ok(tier.length > 200, 'the tier is non-empty and substantial (' + tier.length + ' of ' + fast.length + ')');
A.ok(tier.length < fast.length, 'the tier is a subset of fast.list');
A.eq(mod.selectRulesTier({ fastList: fast, read: rd, slow: listed('test/slow.list'), flaky: listed('test/flaky.list') }).tier, tier,
  'selection is deterministic');
for (const pure of ['test/failopen-ratchet.test.js', 'test/lint-determinism.js', 'test/lint-gate-can-fail.js']) {
  if (fast.includes(pure)) A.ok(tier.includes(pure) || out.skipped.some(s => s.file === pure), pure + ' is decided, not lost');
}

// ---- every marker keeps a test out; its absence lets the test in (a table, one row per marker) ----
const clean = "const A = require('./_assert.js'); const M = require('../sidecar/runoutcome.js'); A.report('x');";
const row = (name, text, helpers) => mod.selectRulesTier({
  fastList: ['test/' + name + '.test.js'],
  read: rel => rel === 'test/' + name + '.test.js' ? text : (helpers && helpers[rel] != null ? helpers[rel] : null),
  slow: [], flaky: []
});
A.eq(row('clean', clean).tier, ['test/clean.test.js'], 'a pure module test is in the tier');
const markers = {
  index: "require('../sidecar/index.js');",
  childProcess: "require('node:child_process');",
  spawn: "const r = spawnSync(process.execPath, []);",
  listen: "srv.listen(0, '127.0.0.1');",
  fixture: "const { SidecarFixture } = require('./helpers/x.js');",
  desk: "require('./helpers/desk-station.js');",
  strict: "require('./helpers/strict-upstream.js');",
  chrome: "const c = findChrome();",
  ports: "require('./helpers/ports.js');",
};
for (const [name, text] of Object.entries(markers)) {
  A.eq(row('m-' + name, clean + text).tier, [], 'marker "' + name + '" keeps the test out of the tier');
}
A.eq(row('c1', clean + "// spawn( and child_process and listen( only in a comment\n").tier, ['test/c1.test.js'],
  'a marker word inside a comment does not exclude a pure test');
A.eq(row('h1', clean + "require('./helpers/spawny.js');", { 'test/helpers/spawny.js': "const cp = require('child_process');" }).tier, [],
  'a test whose helper uses child_process is out (the marker is looked for one helper deep)');
A.eq(row('h2', clean + "require('./helpers/calm.js');", { 'test/helpers/calm.js': "module.exports = {};" }).tier, ['test/h2.test.js'],
  'a test whose helper is pure stays in');
A.eq(mod.selectRulesTier({ fastList: ['test/s.test.js', 'test/t.test.js'], read: () => clean, slow: ['test/s.test.js'], flaky: ['test/t.test.js | a case'] }).tier, [],
  'declared slow and flaky steps are never part of the cheap tier');

// ---- PLANTED: dropping one marker makes the exclusion fail (proof the exclusion rests on the marker) ----
const dropped = mod.selectRulesTier({
  fastList: ['test/m.test.js'], read: () => clean + markers.spawn, slow: [], flaky: [], omitMarkers: ['spawn']
});
A.eq(dropped.tier, ['test/m.test.js'], 'with the spawn marker dropped the spawning test would slip into the tier');

// The same planted defect on the real estate: a spawning step that IS on fast.list is excluded, and slips in only
// when the markers that exclude it are dropped.
A.ok(fast.includes('test/cli.stop-child.test.js'), 'a spawning step is on fast.list');
A.ok(!tier.includes('test/cli.stop-child.test.js'), 'the spawning fast.list step test/cli.stop-child.test.js is out of the tier');
A.ok(mod.selectRulesTier({ fastList: fast, read: rd, slow: [], flaky: [], omitMarkers: ['childProcess', 'spawn'] }).tier.includes('test/cli.stop-child.test.js'),
  'with the spawn markers dropped it would be in (the exclusion rests on them)');

// ---- --list prints exactly the tier (no second list) ----
A.ok(typeof mod.main === 'function', 'main() exists for the CLI');
const lines = [];
const code = await mod.main(['--list'], { log: l => lines.push(l), cwd: ROOT, read: rd });
A.eq(code, 0, '--list exits 0');
A.eq(lines.filter(Boolean), tier, '--list prints the tier, one path per line, in fast.list order');
const pkg = JSON.parse(rd('package.json'));
A.eq(pkg.scripts['test:rules'], 'node scripts/test-rules.mjs', 'package.json carries the test:rules key');
A.eq(pkg.scripts['test:fast'].includes('test:fast:raw'), true, 'the existing gate keys are untouched');

// ---- the temp list file the runner reads is removed afterwards ----
{
  const made = [];
  const code2 = await mod.main([], {
    log: () => {}, cwd: ROOT, read: rd, tmpRoot: tmpdir(),
    run: async o => { made.push(o.listFile); A.ok(existsSync(o.listFile), 'the runner is handed a real list file'); A.eq(readFileSync(o.listFile, 'utf8').split(/\r?\n/).filter(Boolean), tier, 'the temp list is the tier'); return 0; }
  });
  A.eq(code2, 0, 'a run returns the runner exit code');
  A.ok(made.length === 1 && !existsSync(made[0]), 'the temp list file is gone after the run');
  A.ok(!existsSync(dirname(made[0])), 'and so is its temp folder');
}

// ================= chrome-stop: never signal a PID that is no longer ours =================
const cs = await import('./helpers/chrome-stop.mjs');
A.ok(typeof cs.stopChrome === 'function', 'test/helpers/chrome-stop.mjs exports stopChrome()');

const fakeChild = (pid, over) => Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null }, over || {});
const exits = (child, code) => { child.exitCode = code; child.emit('exit', code, null); };
const base = () => {
  const calls = [];
  return { calls, kill: pid => calls.push(['kill', pid]), sleep: () => Promise.resolve() };
};

// 1. Browser.close makes the child exit: no kill at all.
{
  const child = fakeChild(4242), env = base(); const sent = [];
  const cdp = { send: async m => { sent.push(m); if (m === 'Browser.close') setTimeout(() => exits(child, 0), 5); return {}; }, ws: { close() { sent.push('ws.close'); } } };
  await cs.stopChrome({ child, cdp, graceMs: 2000, platform: 'win32', killTree: env.kill });
  A.ok(sent.includes('Browser.close'), 'CDP Browser.close is sent over the existing connection');
  A.eq(env.calls, [], 'a child that exits on Browser.close is never killed (no taskkill after exit)');
}
// 2. A child that never exits: after the wait, the tree is killed once, by its own pid.
{
  const child = fakeChild(5151), env = base();
  const cdp = { send: async () => ({}), ws: { close() {} } };
  const t = Date.now();
  const p = cs.stopChrome({ child, cdp, graceMs: 60, platform: 'win32', killTree: pid => { env.kill(pid); setTimeout(() => exits(child, 1), 5); } });
  await p;
  A.eq(env.calls, [['kill', 5151]], 'a child still running after the grace period gets one tree kill, by its exact pid');
  A.ok(Date.now() - t >= 50, 'the kill waits out the grace period first');
}
// 3. Already exited (exit code set): never killed, even if Browser.close throws.
{
  const child = fakeChild(6161, { exitCode: 0 }), env = base();
  const cdp = { send: async () => { throw new Error('socket closed'); }, ws: { close() {} } };
  await cs.stopChrome({ child, cdp, graceMs: 50, platform: 'win32', killTree: env.kill });
  A.eq(env.calls, [], 'a child that has already exited is never signalled (its pid may belong to someone else now)');
}
// 4. Exited by signal: same.
{
  const child = fakeChild(7171, { signalCode: 'SIGTERM' }), env = base();
  await cs.stopChrome({ child, cdp: null, graceMs: 50, platform: 'linux', killTree: env.kill });
  A.eq(env.calls, [], 'a child that was ended by a signal is never signalled again');
}
// 5. The child exits between the grace timer and the kill: the re-check stops the kill.
{
  const child = fakeChild(8181), env = base();
  await cs.stopChrome({ child, cdp: { send: async () => ({}), ws: { close() {} } }, graceMs: 40, platform: 'win32',
    killTree: env.kill, beforeKill: () => { child.exitCode = 0; } });
  A.eq(env.calls, [], 'an exit that lands right before the kill cancels it');
}
// 6. No child at all is fine.
await cs.stopChrome({ child: null, cdp: null, graceMs: 10, platform: 'win32', killTree: () => A.ok(false, 'nothing to kill') });
A.ok(true, 'a missing child is a no-op');
// 7. The platform command: win32 taskkill by exact pid with /T /F, POSIX a negative pid (process group). Never a parent walk.
A.eq(cs.killCommand(4242, 'win32'), { cmd: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }, 'win32 kill is taskkill /PID <pid> /T /F');
A.eq(cs.killCommand(4242, 'linux'), { signalGroup: -4242, signal: 'SIGKILL' }, 'POSIX kill is the process group of the detached child');
{
  const src = readFileSync(join(ROOT, 'test/helpers/chrome-stop.mjs'), 'utf8');
  A.ok(!/ParentProcessId/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'the helper never walks ParentProcessId');
}

// 8. Profile removal retries, and the final error is NOT swallowed.
{
  const prof = mkdtempSync(join(tmpdir(), 'starnet-wall-receiver-'));
  try {
    writeFileSync(join(prof, 'chrome_debug.log'), 'x');
    await cs.stopChrome({ child: null, cdp: null, graceMs: 10, profile: prof, prefix: 'starnet-wall-receiver-', platform: 'win32', killTree: () => {} });
    A.ok(!existsSync(prof), 'the profile folder is removed');
    let threw = null;
    try {
      await cs.stopChrome({ child: null, cdp: null, graceMs: 10, profile: join(tmpdir(), 'not-ours'), prefix: 'starnet-wall-receiver-', platform: 'win32', killTree: () => {} });
    } catch (e) { threw = e; }
    A.ok(threw && /own unique temp/.test(threw.message), 'a profile outside the unique temp folder is refused, loudly');
    let seen = null;
    try {
      await cs.stopChrome({ child: null, cdp: null, graceMs: 10, profile: join(tmpdir(), 'starnet-wall-receiver-x'), prefix: 'starnet-wall-receiver-', platform: 'win32', killTree: () => {},
        rm: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } });
    } catch (e) { seen = e; }
    A.ok(seen && seen.code === 'EBUSY', 'a lock that never lifts is reported, not swallowed');
  } finally { rmSync(prof, { recursive: true, force: true }); }
}

// 9. Both Chrome tests use the helper (and no longer end the child with a bare SIGKILL).
for (const t of ['test/world-sharpen.test.mjs', 'test/worldlight-receiver.test.mjs']) {
  const src = rd(t);
  A.ok(/helpers\/chrome-stop\.mjs/.test(src) && /stopChrome\s*\(/.test(src), t + ' stops Chrome through the helper');
  A.ok(!/child\.kill\(\s*['"]SIGKILL/.test(src), t + ' no longer kills only the parent process');
}

A.report('test-rules-tier');
