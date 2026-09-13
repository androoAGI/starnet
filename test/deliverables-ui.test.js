'use strict';
const A = require('./_assert.js');
const D = require('../frontend/app/deliverables.js');

const md = D.safeMarkdown('# Hello\n<script>alert(1)</script>\n**bold**');
A.ok(md.indexOf('<h1>Hello</h1>') >= 0 && md.indexOf('<strong>bold</strong>') >= 0, 'bounded Markdown formatting renders');
A.ok(md.indexOf('<script>') < 0 && md.indexOf('&lt;script&gt;') >= 0, 'Markdown HTML is escaped before formatting');

const csv = D.safeCsv('a,b,c\n1,"two, too",3\n4,5,6', 2, 2);
A.ok(csv.indexOf('<table') >= 0 && csv.indexOf('two, too') >= 0, 'quoted CSV cells parse into a table');
A.ok(csv.indexOf('<td>3</td>') < 0 && csv.indexOf('<td>4</td>') < 0, 'CSV preview obeys row and column bounds');

A.eq(D.openUrl('/workshop-run/a/r/index.html', 'secret'), '/workshop-run/a/r/index.html?token=secret', 'sandboxed HTML navigation receives the launch token');
A.eq(D.openUrl('/api/file?agent=a&path=x.md', 'secret'), '/api/file?agent=a&path=x.md&token=secret', 'file preview receives the launch token');

/* ---- the organized library's display helpers (2026-08-13) ---- */
const NOW = new Date('2026-08-13T15:00:00').getTime();
A.eq(D.bucketOf(new Date('2026-08-13T00:30:00').getTime(), NOW), 'TODAY', 'anything since local midnight is TODAY');
A.eq(D.bucketOf(NOW - 2 * 86400000, NOW), 'THIS WEEK', 'two days back is THIS WEEK');
A.eq(D.bucketOf(NOW - 30 * 86400000, NOW), 'EARLIER', 'a month back is EARLIER');
A.eq(D.bucketOf(0, NOW), 'EARLIER', 'a row with no timestamp falls to EARLIER rather than claiming TODAY');

A.eq(D.agoOf(NOW - 30000, NOW), 'just now', 'sub-minute reads as just now');
A.eq(D.agoOf(NOW - 3 * 3600000, NOW), '3h ago', 'hours read as hours');
A.eq(D.agoOf(0, NOW), '', 'no timestamp produces no relative stamp, never a fabricated one');


// the status pill vocabulary, including the prototype-key trap that bit this repo before
A.eq(D.pillOf('pending').label, 'NEEDS A DECISION', 'pending is the only status that asks the user for something');
A.eq(D.pillOf('produced').cls, 'ok', 'a finished run reads as good');
A.eq(D.pillOf('failed').cls, 'bad', 'a failed run reads as bad');
A.eq(D.pillOf('constructor').cls, 'off', 'a prototype key cannot resolve through Object.prototype into a fake pill');

const runRows = [{runId:'run-1',title:'First draft'}, {runId:'run-10',title:'First draft'}, {runId:'elsewhere',summary:'run-1'}, {runId:'run-1',ask:'Review feedback'}];
A.eq(D.rowsForRun(runRows, 'run-1', '').length, 2, 'step output filtering requires exact run identity, never prefix or text matches');
A.eq(D.rowsForRun(runRows, 'run-1', 'FEEDBACK')[0].ask, 'Review feedback', 'search within a step retains exact provenance');
A.eq(D.rowsForRun(runRows, 'missing', '').length, 0, 'a missing run never falls back to unrelated output');
A.report('deliverables-ui.test');
