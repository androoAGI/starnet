'use strict';
/* node test/persist-seam.http.test.js — sidecar/persist through the production wiring (INV-8, lane persist-module).

   persist.conformance builds every store the way index.js composes it; this test does not compose anything. It boots
   sidecar/index.js itself, through test/helpers/save-read-fault-host.cjs (whose only fault is fs.readFileSync of the
   one file named in <workspace>/save-read-fault.json, failing EACCES while the bytes stay on disk), and checks three
   things only the real wiring can show:
     S1 the temp sweeper runs behind the station save: a temp of agent.save.json stamped with a dead writer's pid is
        gone after POST /api/save, and one stamped with a live pid (this test's) is kept, byte for byte (bug 75558694);
     S2 a general store's quarantine (station.widgets.json, torn, no .bak) goes to the first free .corrupt-<n>: the
        first incident is .corrupt-1 and the second, after a restart, is .corrupt-2, each byte-exact (bug e862d9ff);
     S3 a full-state store whose boot read was unreadable (_commander.dossier.json, locked at boot, then unlocked)
        keeps its old bytes in .unseen-1 when POST /api/dossier replaces it: the blind save never overwrites bytes the
        process could not read (bug 34c58f4f, decision D2).
   The dead pid is provably dead: it is a child this test spawned and waited for, process.kill(pid, 0) answers ESRCH
   before the save, and again after it (a pid reused in between would make S1 prove nothing, so that fails too).
   Two boots. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function isDead(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
}
function deadPid() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    if (child.status === 0 && Number.isInteger(child.pid) && child.pid > 0 && child.pid !== process.pid && isDead(child.pid)) return child.pid;
  }
  throw new Error('could not get a provably dead pid from an exited child');
}
const bytesOf = file => { try { return fs.readFileSync(file); } catch (_) { return null; } };
const same = (file, expected) => { const got = bytesOf(file); return !!got && got.equals(Buffer.from(expected)); };
const listing = dir => fs.readdirSync(dir).filter(n => /^(?:agent\.save\.json|station\.widgets\.json|_commander\.dossier\.json)/.test(n)).sort().join(' ');

(async () => {
  const fixture = SidecarFixture.create({ entry: path.join(__dirname, 'helpers', 'save-read-fault-host.cjs'), prefix: 'starnet-persist-seam-' });
  const ws = fixture.workspace;
  const control = path.join(ws, 'save-read-fault.json');
  const save = path.join(ws, 'agent.save.json');
  const widgets = path.join(ws, 'station.widgets.json');
  const dossier = path.join(ws, '_commander.dossier.json');

  const dead = deadPid();
  const live = process.pid;
  const deadTemp = save + '.' + dead + '.5ea70001dead.tmp';
  const liveTemp = save + '.' + live + '.5ea70002a11e.tmp';
  const TORN_1 = '{"widgets":[{"id":"first-incident","label":"Ersté — torn here';
  const TORN_2 = '{"widgets":[{"id":"second-incident","label":"Zwëit — torn';
  const OLD_DOSSIER = JSON.stringify({ block: 'Old dossier — written before the lock' });

  try {
    // everything is on disk before the first boot: the sweeper lists a folder once per process
    fs.writeFileSync(deadTemp, 'a crashed writer\'s full copy');
    fs.writeFileSync(liveTemp, 'a live writer\'s temp');
    fs.writeFileSync(widgets, TORN_1);
    fs.writeFileSync(dossier, OLD_DOSSIER);
    fs.writeFileSync(control, JSON.stringify({ file: '_commander.dossier.json' }));

    await fixture.start();

    // S2, first incident
    const first = await fixture.json('GET', '/api/widgets');
    A.eq(first.status, 200, 'S2: the widgets read answers after a torn main is moved aside');
    A.ok(same(widgets + '.corrupt-1', TORN_1), 'S2: the first torn station.widgets.json is kept byte-exact as station.widgets.json.corrupt-1 (have: ' + listing(ws) + ')');

    // S3: the dossier read failed at boot; the lock clears, and the browser pushes a new block
    fs.unlinkSync(control);
    const pushed = await fixture.json('POST', '/api/dossier', { block: 'New dossier' });
    A.eq(pushed.status, 200, 'S3: POST /api/dossier answers 200');
    A.ok(same(dossier + '.unseen-1', OLD_DOSSIER), 'S3: the dossier bytes the boot read could not see are kept byte-exact in _commander.dossier.json.unseen-1 (have: ' + listing(ws) + ')');
    let now = null;
    try { now = JSON.parse(fs.readFileSync(dossier, 'utf8')); } catch (_) { now = null; }
    A.eq(now && now.block, 'New dossier', 'S3: the new block is the dossier of record');

    // S1: the first station save of this process sweeps the dead writer's temp
    A.ok(isDead(dead), 'S1: the planted pid ' + dead + ' is dead before the save');
    const saved = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: 5, updatedAt: 100, agent: { id: 'agent', name: 'Seam' } });
    A.eq(saved.status === 200 && saved.body && saved.body.ok, true, 'S1: POST /api/save writes the station: ' + saved.text.slice(0, 200));
    A.ok(fs.existsSync(save), 'S1: agent.save.json is on disk');
    A.ok(isDead(dead), 'S1: the planted pid ' + dead + ' is still dead after the save (not reused), so the sweep below proves something');
    A.ok(!fs.existsSync(deadTemp), 'S1: the dead writer\'s temp ' + path.basename(deadTemp) + ' is swept by the save (have: ' + listing(ws) + ')');
    A.ok(same(liveTemp, 'a live writer\'s temp'), 'S1: the live writer\'s temp ' + path.basename(liveTemp) + ' is kept, byte for byte');

    // S2, second incident after a restart
    await fixture.stop();
    fs.writeFileSync(widgets, TORN_2);
    await fixture.start();
    const second = await fixture.json('GET', '/api/widgets');
    A.eq(second.status, 200, 'S2: the widgets read answers after the second torn main is moved aside');
    A.ok(same(widgets + '.corrupt-2', TORN_2), 'S2: the second incident, after a restart, is station.widgets.json.corrupt-2, byte-exact (have: ' + listing(ws) + ')');
    A.ok(same(widgets + '.corrupt-1', TORN_1), 'S2: the first incident\'s copy is never overwritten across the restart');
  } finally {
    await fixture.dispose();
  }
})().then(() => A.report('persist seam (production wiring)'), error => { console.error(error); process.exit(1); });
