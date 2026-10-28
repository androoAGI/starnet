'use strict';
/* node test/version-source.test.js — GET /api/version names a git build id whenever git can give one.

   THE HOLE THIS CLOSES (guardian triage, 2026-10-28): computeVersionSurface ran ONE `git describe --always --dirty
   --tags` with a 2s timeout. On a loaded machine it lost, the surface fell to the package.json '0.0.0' placeholder
   (harnessSource 'pkg'), and that answer was cached for the life of the process — so test/sidecar.http.test.js's
   "harnessSource is git in a checkout" went red with no product change.

   Laws (run on the real function, extracted through test/helpers/source.js, with a scripted execSync):
     V1 git gets a 10s budget, not 2s;
     V2 when --dirty fails, `describe --always --tags` and then `rev-parse --short HEAD` still name the commit, and
        buildDirty stays null (only --dirty can prove a clean tree);
     V3 a 'pkg' answer caused by a git TIMEOUT is not cached for good: a later call asks git again;
     V4 a 'pkg' answer with no git at all (the packaged app) is cached, so git is not re-spawned on every call;
     V5 the happy path is unchanged: one --dirty call, harnessSource 'git', buildDirty from the suffix. */
const vm = require('node:vm');
const path = require('node:path');
const A = require('./_assert.js');
const { locateSidecarFunction, sidecarFunctionSource, sidecarSourceFiles } = require('./helpers/source.js');

const at = locateSidecarFunction('computeVersionSurface');
A.ok(at, 'computeVersionSurface exists in the sidecar');
const fileText = sidecarSourceFiles().find(f => f.rel === at.rel).text;
const stateAt = fileText.lastIndexOf('let _versionCache', at.index);
A.ok(stateAt >= 0, 'its cache state is declared just above it');
const program = fileText.slice(stateAt, at.index) + sidecarFunctionSource('computeVersionSurface') + '\nthis.computeVersionSurface = computeVersionSurface;';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const timeoutErr = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
const noGitErr = () => Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });

function load(script, clock) {
  const calls = [];
  const execSync = (cmd, opts) => {
    calls.push({ cmd, timeout: opts && opts.timeout });
    const r = script(cmd, calls.length);
    if (r instanceof Error) throw r;
    return Buffer.from(r + '\n');
  };
  const sandbox = {
    stationChildProcess: { execSync }, path, __dirname: path.join(path.resolve(__dirname, '..'), 'sidecar'),
    ENV: () => '', process: { version: process.version },
    require: (m) => { if (/package\.json$/.test(m)) return { version: '0.0.0' }; throw noGitErr(); },
    Date: { now: () => clock.t }
  };
  vm.createContext(sandbox);
  vm.runInContext(program, sandbox);
  return { fn: sandbox.computeVersionSurface, calls };
}

// V5 + V1
{
  const clock = { t: 1e6 };
  const { fn, calls } = load(cmd => cmd === 'git rev-parse HEAD' ? SHA : 'v0.9.0-4-gabc1234-dirty', clock);
  const v = fn();
  A.eq(v.harnessSource, 'git', 'happy path: git');
  A.eq(v.harness, 'v0.9.0-4-gabc1234-dirty', 'harness is the --dirty describe');
  A.eq(v.buildDirty, true, 'buildDirty from the -dirty suffix');
  A.eq(v.buildSha, SHA, 'buildSha from rev-parse HEAD');
  A.eq(calls[0].cmd, 'git describe --always --dirty --tags', 'asks --dirty first');
  A.ok(calls[0].timeout >= 10000, 'with a 10s budget, not 2s (got ' + calls[0].timeout + ')');
  A.eq(calls.length, 2, 'one describe + one rev-parse');
  fn();
  A.eq(calls.length, 2, 'and the git answer is cached');
}

// V2
{
  const clock = { t: 1e6 };
  const { fn, calls } = load(cmd => cmd === 'git describe --always --dirty --tags' ? timeoutErr()
    : cmd === 'git rev-parse HEAD' ? SHA : 'v0.9.0-4-gabc1234', clock);
  const v = fn();
  A.eq(v.harnessSource, 'git', '--dirty timing out still resolves via git');
  A.eq(v.harness, 'v0.9.0-4-gabc1234', 'from describe --always --tags');
  A.eq(calls[1].cmd, 'git describe --always --tags', 'second probe');
  A.eq(v.buildDirty, null, 'buildDirty is unknown, not a claimed clean tree');
}
{
  const clock = { t: 1e6 };
  const { fn } = load(cmd => /^git describe/.test(cmd) ? noGitErr() : cmd === 'git rev-parse --short HEAD' ? 'abc1234' : SHA, clock);
  const v = fn();
  A.eq(v.harness, 'abc1234', 'describe failing entirely falls to rev-parse --short HEAD');
  A.eq(v.harnessSource, 'git', 'still git');
}

// V3
{
  const clock = { t: 1e6 };
  let slow = true;
  const { fn, calls } = load(cmd => slow ? timeoutErr() : cmd === 'git rev-parse HEAD' ? SHA : 'v1.0.0', clock);
  A.eq(fn().harnessSource, 'pkg', 'every git probe timing out falls to pkg');
  const n = calls.length;
  fn();
  A.eq(calls.length, n, 'within the retry window the answer is served from cache (no git storm)');
  slow = false; clock.t += 61000;
  const v = fn();
  A.eq(v.harnessSource, 'git', 'a timeout-caused pkg is re-asked later and becomes git');
  A.eq(v.harness, 'v1.0.0', 'with the real describe');
}

// V4
{
  const clock = { t: 1e6 };
  const { fn, calls } = load(() => noGitErr(), clock);
  A.eq(fn().harnessSource, 'pkg', 'no git at all -> pkg');
  const n = calls.length;
  clock.t += 3600000;
  fn();
  A.eq(calls.length, n, 'a no-git pkg answer is cached for good');
}

A.report('version-source.test');
