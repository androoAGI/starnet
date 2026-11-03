'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
function owner(name, saved) {
  const file = require.resolve('../sidecar/' + name + '.js');
  if (!saved) return require(file);
  // Compile exact saved old bytes with the production module's actual relative dependencies.
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(saved, 'utf8'), file); return loaded.exports;
}
const Window = owner('turn-window', process.env.TURN_WINDOW_REVIEW_SOURCE);
const Dual = owner('turn-dual', process.env.TURN_DUAL_REVIEW_SOURCE);
const canonical = [{ role: 'user', content: 'SAME_WORDS', streamId: 's' }];
let out = Window.compare([{ role: 'user', content: 'SAME_WORDS', streamId: 'other' }], canonical, 's');
A.eq(out.counts.foreign, 1, 'same-byte id-less foreign row never qualifies as an identical window');
A.eq(out.counts.idless || 0, 0, 'foreign provenance is not explained as ordinary id-less identity');
out = Window.compare([{ role: 'user', content: 'SAME_WORDS', streamId: 'other' }, { role: 'user', content: 'NEW' }], canonical, 's');
A.eq(out.counts.foreign, 1, 'legacy byte matcher cannot consume an id-less foreign row first');
out = Window.compare([{ role: 'user', content: 'SAME_WORDS', foreign: true }], canonical, 's');
A.eq(out.counts.foreign, 1, 'explicit foreign annotation remains a diagnostic even with implicit current stream');
const shared = { role: 'user', content: 'SHARED', streamId: 's', rowId: 3 };
out = Window.compare([{ role: 'assistant', content: 'BRANCH_COPY', streamId: 's', rowId: 1, foreign: true }, shared],
  [{ role: 'assistant', content: 'CANONICAL', streamId: 's', rowId: 2 }, shared], 's');
A.eq([out.counts.foreign, out.counts.fit_boundary || 0], [1, 0], 'shared suffix cannot explain a flagged foreign keyed prefix as fit boundary');
A.eq(Window.compare(canonical, canonical, 's').counts, {}, 'same-stream byte-identical window remains equal');
const Fail = require('../sidecar/failopen.js'), warnings = [], warn = console.warn;
Fail.resetForTests();
try {
  console.warn = (...args) => warnings.push(args.join(' '));
  const dual = Dual.make({ now: () => 1000, hash: value => crypto.createHash('sha256').update(value).digest('hex'), failNote: Fail.note });
  dual.record('window', { caller: 'desk' });
  A.eq(warnings.length, 0, 'an equal comparison does not warn');
  for (let i = 0; i < 55; i++) dual.record('window', { caller: 'desk', counts: { foreign: 1 },
    streamId: 'private-stream', runId: 'private-run', keys: { foreign: ['private-key'] }, content: 'private-text' });
  A.eq(Fail.counts()['turnid.divergence'], 55, 'every successful divergence reaches the existing diagnostic owner');
  A.eq(warnings.length, 6, 'the existing first-five/every-fiftieth warning throttle bounds output');
  A.ok(warnings.every(line => !line.includes('private-') && line.includes('foreign')), 'warning carries classes/counts without content, keys or stream/run identifiers');
  A.eq(dual.status().counters['window.foreign'], 55, 'warning throttle does not drop counters');
} finally { console.warn = warn; Fail.resetForTests(); }
A.report('turn-window.review');
