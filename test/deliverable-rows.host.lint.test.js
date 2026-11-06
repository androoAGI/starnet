'use strict';
/* node test/deliverable-rows.host.lint.test.js — the run-end file-row line keeps the hottest block of the host whole (turn identity,
   commit 10; the H3-anchor disposition).

   index.js runOnceCore ends a run in one block: the fail-open try that holds runStore.record (which TAKES the agent's deliverable
   note), the final transcript drain and the journal retirement. A throw from the new file-row call placed bare in that try would skip
   all three. So the call is one guarded line of its own, directly above `const runEndedAt` (and so above runStore.record and the
   drain), in its own try/catch with failNote('turn.files'); it reads the note with get (never take, so runStore.record keeps its
   one-liner and the note); and it is the ONLY writer of a kind 'deliverable' row. The runtime proof of the same disposition (a refused
   disk write skips nothing) is leg 7 of test/deliverable-rows.e2e.test.js; this is the fast structural lock that fails the moment the
   line is moved, widened or duplicated, with mutation controls proving each rule can fail. */
const fs = require('node:fs'), path = require('node:path');
const A = require('./_assert.js');
const { readSidecarIndex } = require('./helpers/source.js');

// every structural problem with a copy of index.js's text ([] = the disposition holds)
function problems(src) {
  const out = [], lines = src.split(/\r?\n/), at = needle => lines.findIndex(line => line.includes(needle));
  const call = at('TurnDelivery.fileRows(transcriptStore, {'), ended = at('const runEndedAt = entryEndedAt === null ? Date.now() : entryEndedAt;');
  const record = lines.findIndex((line, i) => i > ended && line.includes('runStore.record({ runId, parentRunId:')), drain = at('try { runTranscript.drain(result && result.messages); }');
  if (src.split('TurnDelivery.fileRows(').length - 1 !== 1) out.push('fileRows is not called exactly once');
  if (!(call > 0 && ended > call && record > ended && drain > record)) out.push('the call does not precede runEndedAt, runStore.record and the final drain');
  if (ended - call !== 1) out.push('the call is not the line directly above runEndedAt');
  const line = lines[call] || '';
  if (!/^\s*try \{ if \(o\.streamId && kinds\.directiveKind !== 'station'\) \{ const files = TurnDelivery\.fileRows\(transcriptStore, \{/.test(line)) out.push('a stream-less or station-internal run is not excluded');
  if (!/\} catch \(e\) \{ failNote\('turn\.files', e\); \}/.test(line)) out.push('the call is not guarded on its own line');
  if (!line.includes('note: deliverableNotes.get(runId)') || line.includes('deliverableNotes.take')) out.push('the note is not read with get');
  if (!line.includes('artifacts: execution.artifactList()') || !line.includes('agentId, runId') || !line.includes('turnId: runStartExtra.turnId') || !line.includes("root: o.projectRoot || ''")) out.push('the call is not fed the run\'s own ledger, agent, turn and root');
  if (!/taint: execution.rowTaint\(\) \|\| /.test(line)) out.push('the row\'s taint is not the run\'s');
  const skip = line.slice(line.indexOf("failNote('turn.files.skipped'"), line.indexOf('} } catch'));
  if (!skip.startsWith("failNote('turn.files.skipped'") || /\.path\b/.test(skip)) out.push('a skipped artifact is not counted by reason only');
  if (src.split('deliverableNotes.take(runId)').length - 1 !== 1) out.push('the note is not taken exactly once');
  if (!(lines[record] || '').includes('deliverable: deliverableNotes.take(runId)') || !(lines[record] || '').includes('artifacts: execution.artifactList()')) out.push('runStore.record lost its note or ledger');
  if (lines.slice(call + 1, record).some(l => /fileRows|appendStrict|kind: 'deliverable'/.test(l))) out.push('another row write sits between the call and runStore.record');
  return out;
}

const real = readSidecarIndex();   // pins index.js's own run-end structure, not a module that merely contains the text
A.eq(problems(real), [], 'the run-end file-row line holds every rule');

// mutation controls: each rule can fail
const lines = real.split('\n'), callAt = lines.findIndex(l => l.includes('TurnDelivery.fileRows(transcriptStore, {'));
const mutate = (label, edit) => { const copy = lines.slice(); edit(copy); A.ok(problems(copy.join('\n')).length > 0, 'mutation caught: ' + label); };
mutate('the call deleted', copy => { copy.splice(callAt, 1); });
mutate('the call moved below runStore.record', copy => { const [moved] = copy.splice(callAt, 1); const rec = copy.findIndex(l => l.includes('runStore.record({ runId, parentRunId:')); copy.splice(rec + 1, 0, moved); });
mutate('the call unguarded', copy => { copy[callAt] = copy[callAt].replace("catch (e) { failNote('turn.files', e); }", 'catch (e) { throw e; }'); });
mutate('the note taken instead of read', copy => { copy[callAt] = copy[callAt].replace('deliverableNotes.get(runId)', 'deliverableNotes.take(runId)'); });
mutate('the call duplicated', copy => { copy.splice(callAt, 0, copy[callAt]); });
mutate('a station-internal run not excluded', copy => { copy[callAt] = copy[callAt].replace(" && kinds.directiveKind !== 'station'", ''); });
mutate('a skipped path named in the diagnostic', copy => { copy[callAt] = copy[callAt].replace("files.skipped.map(s => s.why)", 'files.skipped.map(s => s.path)'); });
mutate('a line inserted between the call and the anchor', copy => { copy.splice(callAt + 1, 0, '      void 0;'); });

// one writer per row kind: no other file in the sidecar builds a kind 'deliverable' row
const sidecar = path.join(__dirname, '..', 'sidecar');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? (entry.name === 'node_modules' || /^workspaces/.test(entry.name) ? [] : walk(path.join(dir, entry.name))) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []);
const writers = walk(sidecar).filter(file => /kind:\s*'deliverable'/.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(sidecar, file).split(path.sep).join('/'));
A.eq(writers, ['turn-delivery.js'], 'turn-delivery.js is the only sidecar file that writes a kind \'deliverable\' row');

A.report('deliverable-rows.host.lint');
