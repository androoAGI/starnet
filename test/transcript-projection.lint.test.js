'use strict';
/* The projection family law: production readers choose a view, and model replay always names its shape. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const { sidecarSourceFiles, sidecarFunctionSource, functionSourceIn } = require('./helpers/source.js');
const Kinds = require('../frontend/app/turnkinds.js');
const uncomment = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const UNTIL_CHANNEL_PORT = /^\s*historyFor: \(streamId\) => transcriptStore\.reconstruct\(streamId, \{ limit: 100 \}\), observeInto: channelObserveInto,/;
const rawRead = /\b(?:transcriptStore|d\.transcript)\.(?:history|reconstruct|all|search|around|streams)\s*\(/;
function rawProblems(text, rel) {
  return uncomment(text).split('\n').filter(line => rawRead.test(line) && !(rel === 'sidecar/index.js' && UNTIL_CHANNEL_PORT.test(line)));
}
function calls(text, re = /\b(?:transcriptStore|d\.transcript)\.(?:view|viewMany)\s*\(/g) {
  const out = [], clean = uncomment(text);
  for (const match of clean.matchAll(re)) {
    const start = match.index + match[0].length;
    let i = start, depth = 1, quote = '';
    for (; i < clean.length && depth; i++) {
      const ch = clean[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++; else if (ch === ')') depth--;
    }
    out.push(clean.slice(start, i - 1));
  }
  return out;
}
function callProblem(call) {
  const first = /^\s*(['"])([^'"]+)\1\s*,/.exec(call);
  if (!first || !Kinds.VIEWS.includes(first[2])) return 'view name is not a literal member';
  if (first[2] === 'model-replay' && !/\bshape\s*:\s*(['"])(?:prose|pairs)\1/.test(call)) return 'replay shape is not literal';
  return '';
}
const literalShape = call => /\bshape\s*:\s*(['"])(?:prose|pairs)\1/.test(call);
const channelReplay = text => calls(text, /\bhistory\.replay\s*\(/g);
const files = sidecarSourceFiles(), problems = [];
for (const file of files) {
  if (['sidecar/transcriptstore.js', 'sidecar/turn-view.js'].includes(file.rel)) continue;
  for (const line of rawProblems(file.text, file.rel)) problems.push(file.rel + ': raw read ' + line.trim());
  for (const call of calls(file.text)) { const problem = callProblem(call); if (problem) problems.push(file.rel + ': ' + problem); }
  for (const call of channelReplay(file.text)) if (!literalShape(call)) problems.push(file.rel + ': channel replay shape is not literal');
}
A.eq(problems, [], 'every production reader names a view and every replay names its literal shape');
const index = files.find(file => file.rel === 'sidecar/index.js').text;
A.eq(uncomment(index).split('\n').filter(line => UNTIL_CHANNEL_PORT.test(line)).length, 7, 'only seven named channel adapters remain until C9');
A.eq(rawProblems("transcriptStore.history('s', {});", 'sidecar/index.js').length, 1, 'negative fixture rejects a raw caller');
A.ok(callProblem("'model-replay', 's', { limit: 3 }").includes('shape'), 'negative fixture rejects a missing replay shape');
A.ok(callProblem("name, 's', { shape: 'pairs' }").includes('literal'), 'negative fixture rejects a computed view authority');
A.eq(calls("transcriptStore.viewMany('model-replay', streams, { limit: 6 });").filter(callProblem).length, 1, 'batched replay is subject to the same literal shape law');
A.eq(channelReplay("await history.replay({ streamId: 's' });").filter(literalShape).length, 0, 'channel replay without shape fails the family law');
A.eq(channelReplay("await history.replay({ streamId: 's', shape: mode });").filter(literalShape).length, 0, 'channel replay cannot compute its shape');
A.eq(channelReplay("await history.replay({ streamId: 's', shape: 'pairs' });").filter(literalShape).length, 1, 'channel replay accepts an explicit literal shape');
const proofOwners = ['finalizeDispatchDelivery', 'recoverPendingDeliveries', 'transcriptRecoveryTail', 'findTurn', 'deliverCronResult'];
const proofCalls = files.filter(file => !['sidecar/transcriptstore.js', 'sidecar/turn-view.js'].includes(file.rel))
  .flatMap(file => calls(file.text).filter(call => /^\s*['"]proof['"]/.test(call)).map(call => ({ rel: file.rel, call })));
const allowedProof = proofOwners.flatMap(name => calls(sidecarFunctionSource(name)));
A.eq(proofCalls.filter(item => !allowedProof.includes(item.call)), [], 'proof reads stay inside named evidence owners');
const handleRun = sidecarFunctionSource('handleRun');
const assignments = uncomment(index).match(/\bwindowCaller\s*=/g) || [];
A.eq(assignments.length, (uncomment(handleRun).match(/\bwindowCaller\s*=/g) || []).length, 'windowCaller has no writer outside handleRun');
const frontend = [];
function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.js')) frontend.push({ rel: path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }); } }
walk(path.resolve(__dirname, '../frontend/app'));
// These files own the actual writers (Pipeline also owns its existing handoff parser). The frozen legacy
// merge is the named byte-exact rollback exception; its body may not be rewritten to satisfy this ratchet.
const writers = new Set(['frontend/app/turnkinds.js', 'frontend/app/pipeline.js', 'frontend/app/chat.js', 'sidecar/group-sessions.js', 'sidecar/loop.js', 'sidecar/tools/builtin/orchestration.js']);
const shapes = ['Assistant reply (context only)', 'PIPELINE HANDOFF', 'BEGIN EXTERNAL SCREEN CAPTURE', 'Shared conversation context', 'STRUCTURED RESULT REPAIR'];
const stray = [];
for (const file of files.concat(frontend)) {
  if (writers.has(file.rel)) continue;
  let text = uncomment(file.text);
  if (file.rel === 'frontend/app/turnmerge.js') text = text.replace(uncomment(functionSourceIn(file.text, 'legacyMerge')), '');
  for (const shape of shapes) if (text.includes(shape)) stray.push(file.rel + ': ' + shape);
}
A.eq(stray, [], 'legacy shape readers live in the shared owner or byte-frozen rollback exception');
A.report('transcript-projection.lint');
