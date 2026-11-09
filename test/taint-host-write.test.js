/* node test/taint-host-write.test.js — A RUN THAT READ OUTSIDE CONTENT DOES NOT WRITE THE HOST UNASKED (fix-sec2, review 5).

   This Computer and Full Power let a run reach every host path with no card. Once the run has read a web page, a
   connector or another untrusted source, a write there would let that content's author plant a Startup entry, a
   LaunchAgent, ~/.bashrc or StarNet's own data (a routine's terminal grant) with nobody asked. Locks:
     - a tainted write outside the agent's workspace and the trusted projects asks a watched run, once, recording
       nothing; an unattended run is refused; a no is refused;
     - its own workspace and a trusted project still flow; StarNet's data directory (another agent's or the station's
       own files) is refused;
     - an untainted write and every read keep the host-wide pass, exactly as before;
     - index.js hands the guard the run's taint latch. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePathTrust } = require('../sidecar/pathtrust.js');

(async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taint-host-write-')));
  const workspaces = path.join(base, 'workspaces');
  const own = path.join(workspaces, 'nova');
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  for (const d of [own, path.join(workspaces, 'other'), project, home]) fs.mkdirSync(d, { recursive: true });
  const blessed = [];
  const pt = makePathTrust({ fsp: fs.promises, pathMod: path, workspaceRoot: workspaces, roots: () => [project],
    bless: async r => { blessed.push(r); return true; }, now: () => 1 });
  const asked = [];
  const say = d => async (root, meta) => { asked.push(meta && meta.path); return d; };
  const profile = path.join(home, '.bashrc');
  const g = (p, o) => pt.guard(p, Object.assign({ agentId: 'nova', surface: 'interactive' }, o));
  const refused = async (p, o) => { try { await g(p, o); return ''; } catch (e) { return String(e.message || e); } };

  for (const host of [{ fullAccess: true }, { unrestrictedHost: true }]) {
    const label = host.fullAccess ? 'This Computer' : 'Full Power';
    // untainted: the host-wide pass, as before
    const clean = await g(profile, Object.assign({ scope: 'write', tainted: () => false, prompt: () => { throw new Error('must not ask'); } }, host));
    A.ok(clean && (clean.fullAccess === true || clean.unrestrictedHost === true), label + ': an untainted write passes host-wide, unasked');
    const read = await g(profile, Object.assign({ scope: 'read', tainted: () => true, prompt: () => { throw new Error('must not ask'); } }, host));
    A.ok(read && (read.fullAccess === true || read.unrestrictedHost === true), label + ': a tainted READ is unchanged');
    // tainted write, watched: one card, one access, nothing recorded
    asked.length = 0;
    const once = await g(profile, Object.assign({ scope: 'write', tainted: () => true, prompt: say('always') }, host));
    A.ok(once && once.oneShot === true && asked.length === 1 && blessed.length === 0, label + ': a tainted write outside asks a watched run, and even ALWAYS allows only this access');
    A.ok(/was denied/.test(await refused(profile, Object.assign({ scope: 'write', tainted: true, prompt: say('deny') }, host))), label + ': a no is refused');
    // tainted write, unattended: refused
    A.ok(/read outside content/.test(await refused(profile, Object.assign({ scope: 'write', tainted: true, surface: 'autonomous' }, host))), label + ': an unattended tainted write outside is refused');
    // its own workspace and a trusted project still flow; StarNet's data is refused
    asked.length = 0;
    const mine = await g(path.join(own, 'notes.md'), Object.assign({ scope: 'write', tainted: true, prompt: say('deny') }, host));
    const proj = await g(path.join(project, 'src.js'), Object.assign({ scope: 'write', tainted: true, prompt: say('deny') }, host));
    A.ok(mine && proj && asked.length === 0, label + ': its own workspace and a trusted project still flow, unasked');
    A.ok(/another agent workspace/.test(await refused(path.join(workspaces, 'other', 'x.json'), Object.assign({ scope: 'write', tainted: true, prompt: say('once') }, host))), label + ': another agent\'s workspace is refused');
    A.ok(/another agent workspace/.test(await refused(path.join(workspaces, 'cron.jobs.json'), Object.assign({ scope: 'write', tainted: true, prompt: say('once') }, host))), label + ': StarNet\'s own data (a routine\'s grants) is refused');
    // a taint check that throws fails closed
    A.ok(/read outside content/.test(await refused(profile, Object.assign({ scope: 'write', tainted: () => { throw new Error('x'); }, surface: 'autonomous' }, host))), label + ': a taint check that throws counts as tainted');
  }
  // the floors still win
  A.ok(/\.env|protected/i.test(await refused(path.join(project, '.env'), { scope: 'write', tainted: true, unrestrictedHost: true, prompt: say('once') })), 'the protected-file floor still refuses');
  // index.js wires the run's latch
  const idx = require('./helpers/source.js').readSidecarIndex();
  // review2 #12: the latch is handed as its source (truthy = tainted), so the card can say what the run read
  A.ok(/tainted: \(\) => execution\.taintedBy\(\) \|\| \(typeof o\.connectorAuthority\?\.taintedBy === 'function' && o\.connectorAuthority\.taintedBy\(\)\) \|\| ''/.test(idx), 'the run hands its taint latch (own or inherited) to the path guard');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* a temp folder left behind is harmless */ }
  A.report('taint-host-write.test');
})().catch(e => { console.error(e); process.exit(1); });
