'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Dual = require('../sidecar/turn-dual.js');
const { readJsonResilient, writeJsonResilient } = require('../sidecar/durable-store.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const copy = x => JSON.parse(JSON.stringify(x));
let now = 1000, versions = 0, reads = 0, saves = 0, disk = null, readStatus = 'absent', failSave = false;
const notes = [], modes = {};
const deps = { now: () => now, hash, read: () => modes, save: value => Object.assign(modes, value),
  failNote: (tag) => notes.push(tag), soak: { dir: 'fixture', version: () => { versions++; return { app: '0.14.2', harness: 'abc', buildSha: '1'.repeat(40) }; },
    read: () => { reads++; return { status: readStatus, value: copy(disk) }; },
    save: (file, value) => { saves++; if (failSave) throw Error('disk full'); disk = copy(value); readStatus = 'ok'; } } };
let d = Dual.make(deps);
A.eq([reads, saves, versions], [0, 0, 0], 'construction calls no ledger or version dependency');
d.modes(); d.identity('stream', []);
A.eq([reads, saves, versions], [0, 0, 0], 'mode/identity projection is not a ledger touch');
let st = d.status();
A.eq([reads, saves, versions], [1, 1, 1], 'first GET opens and persists one boot');
A.eq([st.soak.state, st.soak.resetReason, st.soak.releases[0].boots], ['open', 'new', 1], 'first absent ledger is honest new evidence');
const resetAt = st.soak.resetAt;
const record = (e = {}) => d.record('window', Object.assign({ caller: 'desk', streamId: 'private-stream', keys: { unexplained: ['private-key'] }, content: 'private-content' }, e));
record();
A.eq(saves, 1, 'ordinary updates coalesce within the minute');
now += 60000; st = d.status();
A.eq([saves, st.soak.agg['0.14.2']['window.shadow.desk'].compared], [2, 1], 'GET flushes held normal comparison at sixty seconds');
record({ classes: ['unexplained'], degraded: true });
A.eq(saves, 3, 'unexplained writes immediately');
record({ counts: { order: 1 } });
A.eq(saves, 4, 'order writes immediately');
record({ counts: { bytes: 2, expanded: 1 } });
A.eq([saves, disk.agg['0.14.2']['window.shadow.desk'].bytesBySub.unexplained], [5, 1], 'unexplained bytes persist without an invented explanation');
record({ counts: { fit_boundary: 1 }, fitBoundaryDepth: 6 });
A.eq(saves, 6, 'deep fit boundary writes immediately');
record({ counts: { fit_boundary: 1 } });
A.eq(disk.agg['0.14.2']['window.shadow.desk'].fitBoundaryMaxDepth, 6, 'missing depth cannot qualify as a shallow fit');
const row = d.status().soak.agg['0.14.2']['window.shadow.desk'];
A.eq(row.degraded, { compared: 1, unexplained: 1 }, 'degraded comparisons keep their own unexplained count');
A.ok(!JSON.stringify(disk).includes('private-'), 'ledger keeps no stream, key, or content');
const beforeMode = copy(disk);
d.setMode('window', 'id');
A.eq(disk, beforeMode, 'mode change does not reset or rewrite soak evidence');
failSave = true; record({ classes: ['unexplained'] });
A.eq(d.status().soak.writeFailures >= 1, true, 'open-ledger failed writes are visible');
failSave = false; now += 60000; st = d.status();
A.ok(disk.writeFailures > 0 && notes.includes('turn.soak.write'), 'later successful flush persists failure history');
const savedComparisons = st.soak.agg['0.14.2']['window.shadow.desk'].compared;
d.record('window', { classes: ['unexplained'] });
A.eq(d.status().soak.agg['0.14.2']['window.id.-'].byClass.unexplained, 1, 'caller-less fallback remains durable in its own bucket');
A.eq(d.status().soak.agg['0.14.2']['window.shadow.desk'].compared, savedComparisons, 'unknown caller cannot inflate the shadow desk denominator');
now += 1000; d = Dual.make(deps); st = d.status();
A.eq([st.soak.resetAt, st.soak.releases[0].boots, st.soak.agg['0.14.2']['window.shadow.desk'].compared], [resetAt, 2, savedComparisons], 'restart preserves reset/counts and counts its boot once');
d.status(); A.eq(versions, 2, 'one version lookup per touched instance');

// A closed unreadable episode holds aggregate updates and its one boot, without writing or accepting reset.
readStatus = 'unreadable'; const stored = copy(disk), writesBefore = saves;
now += 1000; d = Dual.make(deps); record({ classes: ['unexplained'] });
A.eq([saves, d.status().soak.state], [writesBefore, 'retrying'], 'unreadable ledger stays unwritten');
A.throws(() => d.resetSoak(), 'reset refuses unreadable authority');
A.eq(saves, writesBefore, 'refused reset performs no write');
const readBefore = reads; now += 59999; d.status(); A.eq(reads, readBefore, 'retry is not a busy read loop');
now++; readStatus = 'ok'; st = d.status();
A.eq([st.soak.resetAt, st.soak.releases[0].boots], [stored.resetAt, stored.releases[0].boots + 1], 'retry merges its held boot into existing evidence');
A.eq(st.soak.agg['0.14.2']['window.id.desk'].byClass.unexplained, stored.agg['0.14.2']['window.id.desk'].byClass.unexplained + 1, 'retry merges held unexplained comparison');

// Real corrupt/recovered files stay byte-identical until the explicit reset uses the normal durable writer.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-soak-'));
try {
  for (const kind of ['corrupt', 'recovered', 'shape']) {
    const dir = path.join(root, kind); fs.mkdirSync(dir);
    const file = path.join(dir, 'turn-identity.soak.json');
    const main = kind === 'shape' ? JSON.stringify(Object.assign(copy(disk), { content: 'not a ledger field' })) : '{torn';
    fs.writeFileSync(file, main);
    if (kind === 'recovered') fs.writeFileSync(file + '.bak', JSON.stringify(disk));
    const backup = fs.existsSync(file + '.bak') ? fs.readFileSync(file + '.bak', 'utf8') : null;
    const real = Dual.make(Object.assign({}, deps, { soak: { dir, version: deps.soak.version,
      read: f => readJsonResilient({ fs }, f), save: (f, value) => writeJsonResilient({ fs, path }, f, value) } }));
    A.eq(real.status().soak.state, 'blocked', kind + ': non-authoritative evidence is blocked');
    real.record('window', { caller: 'desk', classes: ['unexplained'] }); now += 120000; real.status();
    A.eq(fs.readFileSync(file, 'utf8'), main, kind + ': main unchanged by reads/records');
    A.eq(fs.existsSync(file + '.bak') ? fs.readFileSync(file + '.bak', 'utf8') : null, backup, kind + ': backup unchanged');
    A.eq(fs.readdirSync(dir).some(f => f.includes('.corrupt')), false, kind + ': no quarantine');
    const reset = real.resetSoak();
    A.eq([reset.state, reset.resetReason, reset.resetAt, reset.writeFailures], ['open', 'reset', now, 0], kind + ': explicit reset starts new evidence');
    A.eq(readJsonResilient({ fs }, file).value.agg, {}, kind + ': blocked updates were not adopted');
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
// This assertion deliberately pins index's boot order: the version callback must remain lazy across its TDZ.
const idx = require('./helpers/source.js').readSidecarIndex();
const construction = idx.slice(idx.indexOf('const turnDual = TurnDual.make('), idx.indexOf('// the desk\'s read-back'));
A.ok(/version:\s*computeVersionSurface\b/.test(construction) && !/computeVersionSurface\s*\(/.test(construction), 'version resolver is injected lazily before its boot TDZ ends');
A.ok(/read:\s*f\s*=>\s*readJsonResilient\(/.test(construction), 'soak uses status-preserving readJsonResilient');
A.report('turn-dual.soak');
