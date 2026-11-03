/* The final run-table owner surface: no parallel host registry and no unguarded host terminal owner. */
'use strict';
const A = require('./_assert.js');
const { readSidecarIndex, sidecarFunctionSource } = require('./helpers/source');
// This census deliberately pins the host registry and emit sites. Channel ownership maps remain separate.
const src = readSidecarIndex();
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
for (const retired of ['runsMeta', 'hostLiveRuns', 'runStopHandles', 'coreRunsLive']) {
  A.eq(new RegExp('\\b' + retired + '\\b').test(code), false, retired + ': no remaining host registry or counter reader/writer');
}
A.eq(/\bruns\s*=\s*new Map\b|\bruns\.(set|get|has|delete|values|keys|size)\s*\(/.test(code), false, 'no replacement use of the old host abort map');
A.eq(/function runTableCheck\(/.test(code), false, 'the legacy superset reader is retired');
A.ok(sidecarFunctionSource('updateLiveRunCount').includes('Math.max(runTable.size(), cronLive)'), 'drain counts admitted work plus physical cron leases');
A.ok(sidecarFunctionSource('runReachable').includes('runTable.stoppable(id)'), 'STOP and steer share the table authority');
A.ok(sidecarFunctionSource('isRunLive').includes('runTable.ownerLive(runId)'), 'workshop liveness preserves non-aborted host-owner meaning');
A.ok(src.includes('isBusy: agentId => runTable.groupBusy(agentId)'), 'group admission uses its explicit owner fact without broadening to all core runs');
const slash = sidecarFunctionSource('runSlashRoutine'), core = sidecarFunctionSource('runOnceCore');
A.ok(slash.includes('const emit = run.entry.guard('), 'the command routine has one entry-guarded terminal emitter');
A.ok(core.includes('const emit = runEntry ? runEntry.guard(chainEmit) : chainEmit;'), 'the core emitter is guarded before every downstream sink');
const outside = src.replace(slash, '').replace(core, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
A.eq(outside.match(/\b(?:emit|loopEmit)\(['"]agent\.run\.(?:start|end)['"]/g) || [], [], 'no other host site hand-writes lifecycle pairs outside shared refusals/settlement');
A.ok(core.includes('RunTable.refuseRun(emit,'), 'all core refusals use the balanced shared receipt');
A.report('run-table census');
