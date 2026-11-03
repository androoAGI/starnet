'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Dual = require('../sidecar/turn-dual.js');
const Merge = require('../frontend/app/turnmerge.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
let disk = { modes: { merge: 'legacy', window: 'id' } }, failSave = false, time = 1;
const env = {}, failures = [];
const deps = { now: () => time++, hash, env: key => env[key], read: () => disk,
  save: value => { if (failSave) throw Error('disk full'); disk = value; }, failNote: (where, error) => failures.push(where) };
const d = Dual.make(deps);
A.eq(d.modes(), { merge: 'legacy', window: 'id', replay: 'id', display: 'id' }, 'persisted modes override the defaults');
env.STARNET_TURNID_MERGE = 'shadow';
A.eq(d.modes().merge, 'shadow', 'environment mode overrides saved mode');
d.setMode('merge', 'id');
A.eq([disk.modes.merge, d.modes().merge], ['id', 'shadow'], 'saving respects active environment precedence');
delete env.STARNET_TURNID_MERGE;
failSave = true;
A.throws(() => d.setMode('merge', 'legacy'), 'failed durable write refuses mode change');
A.eq(d.modes().merge, 'id', 'failed save cannot publish a new mode in memory');
failSave = false;
A.throws(() => d.setMode('forget', 'legacy'), 'forget is never a mode');
A.throws(() => d.setMode('display', 'shadow'), 'display has no shadow mode');
let old = 0, next = 0;
const legacy = () => { old++; return 'old'; }, modern = () => { next++; return 'new'; };
A.eq(d.pick('merge', legacy, modern), 'new', 'id returns the new path');
A.eq([old, next], [0, 1], 'id success does not run fallback');
A.eq(d.pick('merge', legacy, () => { throw Error('bad projection'); }), 'old', 'throw falls back only for this call');
A.eq(d.modes().merge, 'id', 'failure does not automatically flip configuration');
A.eq(failures, ['turnid.merge', 'turnid.divergence'], 'fallback notes its shared owner and the bounded divergence warning');
d.setMode('merge', 'shadow');
A.eq(d.pick('merge', legacy, modern), 'old', 'shadow executes new but returns legacy');
d.setMode('merge', 'legacy');
const beforeNext = next;
A.eq(d.pick('merge', legacy, modern), 'old', 'legacy returns old');
A.eq(next, beforeNext, 'legacy never runs the new path');
for (let i = 0; i < 90; i++) d.record('merge', { streamId: 'private-session-label', classes: ['orphan'], keys: { orphan: ['private-session-key'] }, content: 'not accepted' });
const status = d.status();
A.eq(status.ring.length, 20, 'status exposes only the last20 of the bounded ring');
A.eq(status.counters['merge.orphan'], 90, 'since-boot counters retain all occurrences');
A.ok(!JSON.stringify(status).includes('private-session') && !JSON.stringify(status).includes('not accepted'), 'diagnostics contain only hashed stream/keys and accepted counts');
A.eq(Dual.make(deps).modes().merge, 'legacy', 'mode survives an instance restart');

// Every row receives collision provenance, even after the 50-key diagnostic limit. Authority stays demoted on reload.
const rows = Array.from({ length: 70 }, (_, i) => ({ streamId: 's', rowId: i + 1, role: 'user', content: 'station ' + i }));
const wire = d.project('s', rows, { isCollided: id => id <= 65, forgottenAt: 2, liveRunIds: new Set(['live']) });
A.eq(wire.identity.collided.length, 50, 'wire collision diagnostic is bounded at50');
A.eq(wire.turns.filter(r => r.idFrom === 'collision').length, 65, 'all65 affected rows carry demotion proof');
A.ok(rows.every(r => !r.idFrom), 'projection never rewrites recorded rows');
const out = Merge.merge(rows, wire.turns, { identity: wire.identity }).rows;
A.eq(out.filter(r => !r.rowId).length, 65, 'keys beyond the diagnostic bound cannot acquire authority');
A.eq(out.length, rows.length, 'content matching preserves each station row once');
A.eq(Merge.merge(out, wire.turns, { identity: wire.identity }).rows, out, 'collision proof is stable across cache save/reload');

// The disk audit's 50-range status bound must not bound its identity predicate. Real duplicate rows in 55 segments.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-turn-dual-audit-'));
let io;
try {
  for (let n = 1; n <= 55; n++) {
    const row = { streamId: 's', rowId: n * 10, role: 'user', content: 'first', ts: n };
    fs.writeFileSync(path.join(root, 'segment-' + String(n).padStart(6, '0') + '.jsonl'), JSON.stringify(row) + '\n' + JSON.stringify(Object.assign({}, row, { content: 'second' })) + '\n');
  }
  io = makeSegmentedTranscriptIo({ fs, path, root, onWarning() {}, schedule() {} });
  A.eq(io.status().idCollisions.length, 50, 'real IO keeps its diagnostic status bounded');
  A.ok(io.isCollided(550), 'the final duplicate outside the status sample remains disavowed');
  A.ok(!io.isCollided(551), 'an unrelated id outside every audit range retains identity');
} finally { if (io) io.close(); fs.rmSync(root, { recursive: true, force: true }); }
A.report('turn-dual');
