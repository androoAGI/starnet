#!/usr/bin/env node
'use strict';

// Fixture-driven unit test for scripts/release-preflight.mjs. The core is pure: every probe goes
// through the injected io, so this never shells out, never reads the real repo, never touches git.

const A = require('./_assert.js');

function fakeRepo(overrides) {
  const v = (overrides && overrides.version) || '0.10.7';
  const files = Object.assign({
    'package.json': JSON.stringify({ name: 'starnet-harness', version: v }),
    'package-lock.json': JSON.stringify({ name: 'starnet-harness', version: v, packages: { '': { version: v } } }),
    'src-tauri/tauri.conf.json': JSON.stringify({ version: v, plugins: { updater: { endpoints: ['https://github.com/acme/starnet-releases/releases/latest/download/latest.json'] } } }),
    'src-tauri/Cargo.toml': '[package]\nname = "skynet-desktop"\nversion = "' + v + '"\n',
    'src-tauri/Cargo.lock': '[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "skynet-desktop"\nversion = "' + v + '"\n',
    'RELEASE_NOTES.md': '# StarNet v' + v + '\n\n- real notes\n',
    '/keys/starnet-updater.key': 'NEVER-PRINTED'
  }, (overrides && overrides.files) || {});
  const git = Object.assign({
    'rev-parse --abbrev-ref HEAD': 'feat/harness-backend\n',
    'rev-parse HEAD': 'a'.repeat(40) + '\n',
    'status --porcelain --untracked-files=normal': '',
    'tag --list v0.10.8': '',
    'ls-remote --tags origin refs/tags/v0.10.8': '',
    'rev-list --count origin/feat/harness-backend..HEAD': '0\n'
  }, (overrides && overrides.git) || {});
  const cmds = Object.assign({
    'gh release view v0.10.8 -R acme/starnet-releases --json tagName,isDraft,isPrerelease': { status: 1, stderr: 'release not found' },
    'node scripts/qa/product-perfect/claims.mjs': { status: 0, stdout: 'PASS claims planning authority · 37 claims · 209 locked surface files\n' },
    'node scripts/sync-website-app.mjs --check': { status: 0 },
    'node scripts/qa/ready.mjs --json': { status: 0, stdout: JSON.stringify({ ready: true, reasons: [] }) }
  }, (overrides && overrides.cmds) || {});
  const calls = [];
  const io = {
    calls,
    readText(p) { return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null; },
    exists(p) { return Object.prototype.hasOwnProperty.call(files, p); },
    listDir(p) {
      const prefix = p.replace(/\/$/, '') + '/';
      const names = new Set();
      for (const k of Object.keys(files)) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      return names.size ? [...names] : null;
    },
    stat() { return null; },
    exec(cmd, args) {
      const key = args.join(' ');
      calls.push(cmd + ' ' + key);
      if (cmd === 'git') {
        if (Object.prototype.hasOwnProperty.call(git, key)) {
          const val = git[key];
          return typeof val === 'object' ? val : { status: 0, stdout: val, stderr: '' };
        }
        return { status: 128, stdout: '', stderr: 'fatal: unknown fixture git call ' + key };
      }
      const k2 = cmd + ' ' + key;
      if (cmds[k2]) return Object.assign({ stdout: '', stderr: '' }, cmds[k2]);
      return { status: 127, stdout: '', stderr: 'fixture: no such command ' + k2 };
    },
    now() { return Date.parse('2026-08-21T12:00:00Z'); }
  };
  return io;
}

const {
  runPreflight, renderChecklist, parseGateLog, bumpSemver, compareSemver, readVersionPins, parseArgs, stripBom
} = require('../scripts/release-preflight.mjs');

const CTX = { version: '0.10.8', phase: 'pre-bump', keyFile: '/keys/starnet-updater.key' };
const byId = (r, id) => r.rows.find(x => x.id === id);

// ── helpers ──
A.eq(bumpSemver('0.10.7', 'patch'), '0.10.8', 'bump patch');
A.eq(bumpSemver('0.10.7', 'minor'), '0.11.0', 'bump minor');
A.eq(bumpSemver('0.10.7', 'major'), '1.0.0', 'bump major');
A.throws(() => bumpSemver('0.10.7', 'weird'), 'bad --next rejected');
A.ok(compareSemver('0.10.8', '0.10.7') > 0 && compareSemver('0.10.7', '0.10.7') === 0 && compareSemver('0.10.7-rc.1', '0.10.7') < 0, 'semver compare');
A.eq(stripBom('﻿{"a":1}'), '{"a":1}', 'BOM stripped (PowerShell > writes one)');
A.eq(parseArgs(['--next', 'patch', '--allow-lane']).next, 'patch', 'parseArgs --next');
A.eq(parseArgs(['--version=1.2.3', '--phase', 'post-bump']).phase, 'post-bump', 'parseArgs --phase');

// ── gate log parsing: the LAST LINE is the proof, never the exit code ──
A.eq(parseGateLog('blah\nrun-fast-tests: OK — 654 step(s) green\n').gate, 'fast', 'fast summary recognised');
A.eq(parseGateLog('x\nrun-test-list: OK — 78 step(s) green\n\n').gate, 'http', 'http summary recognised (trailing blank ignored)');
A.eq(parseGateLog('﻿run-fast-tests: OK — 3 step(s) green\r\n').steps, 3, 'BOM + CRLF log accepted');
A.ok(!parseGateLog('run-fast-tests: OK — 654 step(s) green\nrun-fast-tests: FAILED at step 9/654: node test/x.js (exit 1)\n').ok, 'a red tail after a green line is NOT green');
A.ok(!parseGateLog('test:fast exited with code 0\n').ok, 'an exit-code line is not a green summary');
A.ok(!parseGateLog('').ok, 'empty log rejected');

// ── all green on trunk ──
{
  const io = fakeRepo();
  const r = runPreflight(CTX, io);
  A.ok(r.ok, 'green fixture passes: ' + JSON.stringify(r.rows.filter(x => x.status === 'FAIL').map(x => x.label)));
  A.eq(r.target, '0.10.8', 'target resolved from --version');
  A.eq(byId(r, 'branch').status, 'PASS', 'branch row PASS on trunk');
  A.eq(byId(r, 'pins').status, 'PASS', 'pins agree pre-bump');
  A.ok(/bump to 0.10.8 pending/.test(byId(r, 'pins').detail), 'pins row says bump pending');
  A.eq(byId(r, 'tag-local').status, 'PASS', 'tag not local');
  A.eq(byId(r, 'tag-remote').status, 'PASS', 'tag not on origin');
  A.eq(byId(r, 'tag-release').status, 'PASS', 'no release on releases repo (gh "not found")');
  A.eq(byId(r, 'claims').status, 'PASS', 'claims PASS');
  A.eq(byId(r, 'website').status, 'PASS', 'website in sync');
  A.eq(byId(r, 'gate-fast').status, 'WARN', 'gate at HEAD is informational pre-bump');
  A.ok(/gate NOT proven at HEAD/.test(byId(r, 'gate-fast').detail), 'gate row says NOT proven');
  A.eq(byId(r, 't0').status, 'WARN', 'T0 owed');
  A.eq(byId(r, 'g1').status, 'WARN', 'G1 owed');
  A.eq(byId(r, 'soak').status, 'WARN', 'soak owed');
  A.eq(byId(r, 'ready').status, 'PASS', 'READY');
  A.eq(byId(r, 'updater-key').status, 'PASS', 'key present');
  A.ok(!/NEVER-PRINTED/.test(renderChecklist(r)), 'key contents never rendered');
  A.eq(byId(r, 'updater-key-backup').status, 'SKIP', 'offline backup is human attestation');
  A.eq(byId(r, 'notes').status, 'WARN', 'notes header is previous version pre-bump → WARN');
  A.ok(/PREFLIGHT PASS/.test(renderChecklist(r)), 'render says PASS');
  A.ok(!io.calls.some(c => /push|commit|tag v|checkout|reset/.test(c) && !/tag --list/.test(c)), 'no mutating git call: ' + io.calls.filter(c => /push|commit|checkout|reset/.test(c)).join(','));
}

// ── --next derives the target ──
{
  const r = runPreflight({ next: 'patch', phase: 'pre-bump', keyFile: '/keys/starnet-updater.key' }, fakeRepo());
  A.eq(r.target, '0.10.8', '--next patch → 0.10.8');
  const r2 = runPreflight({ phase: 'pre-bump', keyFile: '/keys/starnet-updater.key' }, fakeRepo());
  A.eq(byId(r2, 'target').status, 'FAIL', 'no version/next is a hard FAIL');
}

// ── branch: lane FAILs unless --allow-lane ──
{
  const io = fakeRepo({ git: { 'rev-parse --abbrev-ref HEAD': 'agent/foo\n' } });
  const r = runPreflight(CTX, io);
  A.eq(byId(r, 'branch').status, 'FAIL', 'lane branch is a hard FAIL');
  A.ok(!r.ok, 'lane → not ok');
  const r2 = runPreflight(Object.assign({ allowLane: true }, CTX), fakeRepo({ git: { 'rev-parse --abbrev-ref HEAD': 'agent/foo\n' } }));
  A.eq(byId(r2, 'branch').status, 'WARN', '--allow-lane downgrades to WARN');
  A.ok(/TAG goes on trunk AFTER the merge/.test(byId(r2, 'branch').detail), 'lane row explains tag-after-merge');
  A.ok(!byId(r2, 'origin'), 'origin drift row only on trunk');
}

// ── working tree: Guardian row refresh is named, not failed ──
{
  const r = runPreflight(CTX, fakeRepo({ git: { 'status --porcelain --untracked-files=normal': ' M qa/STATUS.md\n' } }));
  A.eq(byId(r, 'clean').status, 'PASS', 'qa/STATUS.md alone keeps the tree PASS');
  A.eq(byId(r, 'guardian-row').status, 'WARN', 'Guardian row refresh detected and named');
  A.ok(/never fold it into the release commit/.test(byId(r, 'guardian-row').fix), 'Guardian remediation present');
  const r2 = runPreflight(CTX, fakeRepo({ git: { 'status --porcelain --untracked-files=normal': ' M sidecar/index.js\n?? junk.txt\n' } }));
  A.eq(byId(r2, 'clean').status, 'FAIL', 'modified tracked file is a hard FAIL');
  A.ok(/sidecar\/index.js/.test(byId(r2, 'clean').detail), 'names the dirty file');
  const r3 = runPreflight(CTX, fakeRepo({ git: { 'status --porcelain --untracked-files=normal': '?? junk.txt\n' } }));
  A.eq(byId(r3, 'clean').status, 'WARN', 'untracked-only is a WARN (claims re-lock guard trap)');
}

// ── five pins ──
{
  const io = fakeRepo({ files: { 'src-tauri/Cargo.toml': '[package]\nname = "skynet-desktop"\nversion = "0.10.6"\n' } });
  const r = runPreflight(CTX, io);
  A.eq(byId(r, 'pins').status, 'FAIL', 'a straggling pin fails');
  A.ok(/Cargo.toml=0.10.6/.test(byId(r, 'pins').detail), 'pin row lists every value');
  A.ok(/release:bump/.test(byId(r, 'pins').fix), 'pin remediation names release:bump');
  const pins = readVersionPins(fakeRepo());
  A.eq(pins.length, 5, 'exactly five pins');
  A.eq(pins.map(p => p.value), ['0.10.7', '0.10.7', '0.10.7', '0.10.7', '0.10.7'], 'all five read');
  const r2 = runPreflight({ version: '0.10.7', phase: 'pre-bump', keyFile: '/keys/starnet-updater.key' }, fakeRepo());
  A.eq(byId(r2, 'pins').status, 'WARN', 'target == current pre-bump → already bumped WARN');
  const r3 = runPreflight({ version: '0.10.1', phase: 'pre-bump', keyFile: '/keys/starnet-updater.key' }, fakeRepo());
  A.eq(byId(r3, 'pins').status, 'FAIL', 'target below in-tree is a FAIL (updater never downgrades)');
}

// ── tag collisions ──
{
  const r = runPreflight(CTX, fakeRepo({ git: { 'tag --list v0.10.8': 'v0.10.8\n', 'rev-list -n 1 v0.10.8': 'b'.repeat(40) + '\n' } }));
  A.eq(byId(r, 'tag-local').status, 'FAIL', 'local tag exists → FAIL');
  A.ok(/--next patch/.test(byId(r, 'tag-local').fix), 'spent version → bump patch');
  const r2 = runPreflight(CTX, fakeRepo({ git: { 'ls-remote --tags origin refs/tags/v0.10.8': 'deadbeef\trefs/tags/v0.10.8\n' } }));
  A.eq(byId(r2, 'tag-remote').status, 'FAIL', 'remote tag exists → FAIL (train already fired)');
  const r3 = runPreflight(CTX, fakeRepo({ git: { 'ls-remote --tags origin refs/tags/v0.10.8': { status: 128, stdout: '', stderr: 'fatal: unable to access' } } }));
  A.eq(byId(r3, 'tag-remote').status, 'SKIP', 'offline ls-remote → SKIP');
  A.ok(/unverified: offline/.test(byId(r3, 'tag-remote').detail), 'offline says so');
  const r4 = runPreflight(CTX, fakeRepo({ cmds: { 'gh release view v0.10.8 -R acme/starnet-releases --json tagName,isDraft,isPrerelease': { status: 0, stdout: '{"tagName":"v0.10.8","isDraft":true}' } } }));
  A.eq(byId(r4, 'tag-release').status, 'FAIL', 'draft release reserves the version');
  A.ok(/DRAFT/.test(byId(r4, 'tag-release').detail), 'says draft');
  const r5 = runPreflight(CTX, fakeRepo({ cmds: { 'gh release view v0.10.8 -R acme/starnet-releases --json tagName,isDraft,isPrerelease': { status: null, error: { code: 'ENOENT' } } } }));
  A.eq(byId(r5, 'tag-release').status, 'SKIP', 'no gh → SKIP, never green');
  const r6 = runPreflight(CTX, fakeRepo({ cmds: { 'gh release view v0.10.8 -R acme/starnet-releases --json tagName,isDraft,isPrerelease': { status: 4, stderr: 'gh: To get started with GitHub CLI, please run: gh auth login' } } }));
  A.eq(byId(r6, 'tag-release').status, 'SKIP', 'unauth gh → SKIP with reason');
}

// ── claims / website / ready ──
{
  const r = runPreflight(CTX, fakeRepo({ cmds: { 'node scripts/qa/product-perfect/claims.mjs': { status: 2, stdout: 'BLOCKED claims planning authority · 37 claims · 209 locked surface files\n  - release surface bytes changed: RELEASE_NOTES.md\n' } } }));
  A.eq(byId(r, 'claims').status, 'FAIL', 'BLOCKED claims → FAIL');
  A.ok(/release surface bytes changed/.test(byId(r, 'claims').detail), 'carries the reason');
  A.ok(/--refresh-surface --candidate/.test(byId(r, 'claims').fix) && /COMMIT first/.test(byId(r, 'claims').fix), 'remediation is the re-lock recipe, commit-first');
  const r2 = runPreflight(CTX, fakeRepo({ cmds: { 'node scripts/sync-website-app.mjs --check': { status: 1, stdout: 'website/app is stale: 3 file(s) differ\n' } } }));
  A.eq(byId(r2, 'website').status, 'FAIL', 'stale mirror → FAIL');
  A.ok(/sync:website/.test(byId(r2, 'website').fix) && /re-lock claims/.test(byId(r2, 'website').fix), 'mirror fix chains into the claims re-lock');
  const r3 = runPreflight(CTX, fakeRepo({ cmds: { 'node scripts/qa/ready.mjs --json': { status: 1, stdout: JSON.stringify({ ready: false, reasons: ['1. Green Guardian last cycle: RED'] }) } } }));
  A.eq(byId(r3, 'ready').status, 'FAIL', 'NOT READY → FAIL');
  A.ok(/Green Guardian/.test(byId(r3, 'ready').detail), 'reasons surfaced');
  const r4 = runPreflight(CTX, fakeRepo({ cmds: { 'node scripts/qa/ready.mjs --json': { status: 1, stdout: 'garbage' } } }));
  A.eq(byId(r4, 'ready').status, 'FAIL', 'unparseable qa:ready is NOT READY (no-fake-green)');
}

// ── gate receipts ──
{
  const head = 'a'.repeat(40);
  const receipt = JSON.stringify({ commit: head, gate: 'fast', green: true, steps: 654, at: '2026-08-21T11:00:00Z', log: 'gate-fast.log' });
  const r = runPreflight(CTX, fakeRepo({ files: { ['.dogfood/gate-receipts/' + head + '.fast.json']: receipt } }));
  A.eq(byId(r, 'gate-fast').status, 'PASS', 'receipt for HEAD → PASS');
  A.ok(/654 step/.test(byId(r, 'gate-fast').detail), 'receipt detail carries the step count');
  const stale = JSON.stringify({ commit: 'b'.repeat(40), gate: 'fast', green: true, steps: 654 });
  const r2 = runPreflight(CTX, fakeRepo({ files: { ['.dogfood/gate-receipts/' + head + '.fast.json']: stale } }));
  A.eq(byId(r2, 'gate-fast').status, 'WARN', 'a receipt naming another commit does not count');
  const post = Object.assign({}, CTX, { phase: 'post-bump', version: '0.10.7' });
  const r3 = runPreflight(post, fakeRepo());
  A.eq(byId(r3, 'gate-fast').status, 'FAIL', 'post-bump: missing gate receipt is HARD');
  A.ok(/--gates-proven-by/.test(byId(r3, 'gate-fast').fix), 'post-bump remediation names --gates-proven-by');
  A.eq(byId(r3, 'pins').status, 'PASS', 'post-bump: pins == target PASS');
  A.eq(byId(r3, 'notes').status, 'PASS', 'post-bump: real notes PASS');
  const r4 = runPreflight(post, fakeRepo({ files: { 'RELEASE_NOTES.md': '# StarNet v0.10.7\n\n- TODO: summarize what changed in this release.\n' } }));
  A.eq(byId(r4, 'notes').status, 'FAIL', 'post-bump: TODO scaffold is a hard FAIL');
  const r5 = runPreflight(Object.assign({}, CTX, { phase: 'post-bump' }), fakeRepo());
  A.eq(byId(r5, 'pins').status, 'FAIL', 'post-bump with pins still on the old version FAILs');
}

// ── T0 / G1 / soak receipts recognised when present for the target ──
{
  const io = fakeRepo({ files: {
    '.dogfood/t0-clean-install-20260821/t0-clean-install-status.json': JSON.stringify({ version: '0.10.8', verdict: 'PASS' }),
    '.dogfood/g1/packaged-lifecycle-receipt.json': JSON.stringify({ meta: {tag: 'v0.10.8'}, verdict: 'PASS', cases: ['idle-close', 'close-to-tray', 'updater-smoke'].map(name => ({name, result: 'PASS'})) }),
    'qa/installed/last-smoke.json': JSON.stringify({ schemaVersion: 3, appVersion: '0.10.8', result: 'GREEN', stampIso: '2026-08-20T12:00:00Z' })
  } });
  const r = runPreflight(CTX, io);
  A.eq(byId(r, 't0').status, 'PASS', 'T0 receipt for target → PASS');
  A.eq(byId(r, 'g1').status, 'PASS', 'G1 receipt for target → PASS');
  const {buildReceipt} = require('../scripts/qa/packaged-lifecycle.mjs');
  const checkG1 = receipt => byId(runPreflight(CTX, fakeRepo({files:{'.dogfood/g1/packaged-lifecycle-receipt.json':JSON.stringify(receipt)}})), 'g1').status;
  const full = buildReceipt({meta:{tag:'v0.10.8'},cases:['idle-close','close-to-tray','updater-smoke'].map(name=>({name,result:'PASS'}))});
  A.eq(checkG1(full), 'PASS', 'actual G1 writer output is recognized');
  A.eq(checkG1(buildReceipt({meta:{tag:'v0.10.8'},cases:full.cases.slice(0,2)})), 'WARN', 'passing subset cannot clear full G1');
  A.eq(checkG1({...full, meta:{tag:'v0.10.7'}}), 'WARN', 'different release cannot clear G1');
  A.eq(checkG1({...full, cases:full.cases.map(c=>c.name==='updater-smoke'?{...c,result:'FAIL'}:c)}), 'WARN', 'summary PASS cannot hide failing updater case');
  A.eq(byId(r, 'soak').status, 'PASS', 'fresh schema-3 GREEN soak stamp for target → PASS');
  const r2 = runPreflight(CTX, fakeRepo({ files: { 'qa/installed/last-smoke.json': JSON.stringify({ appVersion: '0.10.7', verdict: 'GREEN', stampIso: '2026-08-20T12:00:00Z' }) } }));
  A.eq(byId(r2, 'soak').status, 'WARN', 'a soak of the PREVIOUS version is not a soak of the target');
  const r3 = runPreflight(CTX, fakeRepo({ files: { 'qa/installed/last-smoke.json': JSON.stringify({ appVersion: '0.10.8', verdict: 'GREEN', stampIso: '2026-08-01T12:00:00Z' }) } }));
  A.eq(byId(r3, 'soak').status, 'WARN', 'a stale (>7d) soak stamp is owed again');
}

// ── updater key ──
{
  const r = runPreflight(Object.assign({}, CTX, { keyFile: '/keys/missing.key' }), fakeRepo());
  A.eq(byId(r, 'updater-key').status, 'FAIL', 'missing key is a hard FAIL');
  A.ok(/OFFLINE backup/.test(byId(r, 'updater-key').fix), 'key remediation points at the offline backup');
}

// ── render ──
{
  const r = runPreflight(CTX, fakeRepo({ git: { 'rev-parse --abbrev-ref HEAD': 'agent/x\n' } }));
  const text = renderChecklist(r);
  A.ok(/^\[FAIL\] on trunk/m.test(text), 'render prefixes status');
  A.ok(/fix: cd to the integration tree/.test(text), 'render prints the fix under red rows');
  A.ok(/PREFLIGHT FAIL .*Do not bump, do not tag\./.test(text), 'render verdict line');
}

A.report();
