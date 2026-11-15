'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const D = require('../frontend/app/deliverables.js');
const Tickets = require('../sidecar/apitickets.js');

const md = D.safeMarkdown('# Hello\n<script>alert(1)</script>\n**bold**');
A.ok(md.indexOf('<h1>Hello</h1>') >= 0 && md.indexOf('<strong>bold</strong>') >= 0, 'bounded Markdown formatting renders');
A.ok(md.indexOf('<script>') < 0 && md.indexOf('&lt;script&gt;') >= 0, 'Markdown HTML is escaped before formatting');

const csv = D.safeCsv('a,b,c\n1,"two, too",3\n4,5,6', 2, 2);
A.ok(csv.indexOf('<table') >= 0 && csv.indexOf('two, too') >= 0, 'quoted CSV cells parse into a table');
A.ok(csv.indexOf('<td>3</td>') < 0 && csv.indexOf('<td>4</td>') < 0, 'CSV preview obeys row and column bounds');

// open URLs carry a SCOPED TICKET, never the launch token (2026-09-25 — these reach OS-browser history/Referer)
global.window = { __STARNET_API_TOKEN__: 'secret', crypto: require('node:crypto').webcrypto };
global.ApiTicket = require('../frontend/app/apiticket.js');
const runOpen = D.openUrl('/workshop-run/a/r/index.html');
const runSplit = Tickets.splitRunTicket(runOpen);
A.ok(runSplit && runSplit.rest === 'a/r/index.html' && runOpen.indexOf('secret') < 0, 'sandboxed HTML navigation gets a run ticket in the path, no launch token: ' + runOpen.slice(0, 40));
A.ok(Tickets.verify('secret', runSplit.ticket, 'run', Tickets.scopeRun('a', 'r'), { now: Date.now() }).ok, 'that run ticket verifies for run a/r');
const fileOpen = D.openUrl('/api/file?agent=a&path=x.md');
const fq = new URL(fileOpen, 'http://127.0.0.1').searchParams;
A.ok(fileOpen.indexOf('secret') < 0 && !fq.has('token') && Tickets.verify('secret', fq.get('ticket'), 'file', Tickets.scopeFile('a', 'x.md'), { now: Date.now() }).ok, 'file preview gets a file ticket for exactly x.md, no launch token');
delete global.ApiTicket; delete global.window;

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
/* ---- FILES rows can find their file on disk (org pass 10-14, P24): the path comes off the backend's own openUrl ---- */
{
  const loc = (url, project, extra) => D.savedLocation(Object.assign({ agentId: 'agent' }, extra || {}), { path: 'shown.md', openUrl: url }, project);
  const ws = loc('/api/file?agent=ultron&path=' + encodeURIComponent('out/report.md'), 'C:\\work\\acme');
  A.eq([ws.agentId, ws.path, ws.inProject], ['ultron', 'out/report.md', false], 'a workspace file of a project item is proven OUTSIDE that project (relative = the agent workspace)');
  const pr = loc('/api/file?agent=ultron&path=' + encodeURIComponent('src/a.js') + '&project=' + encodeURIComponent('C:\\work\\acme'), 'C:\\work\\acme');
  A.eq([pr.path, pr.inProject], ['C:\\work\\acme\\src\\a.js', true], 'a project-scoped file resolves inside the project folder');
  const nop = loc('/api/file?agent=a&path=x.md', '');
  A.eq(nop.inProject, null, 'an item with no project makes no outside/inside claim');
  const wsr = loc('/workshop-run/cypher/run-7/site/index.html', '');
  A.eq([wsr.agentId, wsr.path], ['cypher', 'workshop/run-7/site/index.html'], 'a sandboxed workshop page maps to its real workshop folder, not the bare display path');
  const abs = loc('/api/file?agent=a&path=' + encodeURIComponent('D:/elsewhere/out.txt'), 'C:\\work\\acme');
  A.eq([abs.path, abs.inProject], ['D:/elsewhere/out.txt', false], 'an absolute path outside the project is proven outside');
  /* P24 wiring: an absolute path outside the project is NOT proven to be the agent's workspace — a path: grant can let a run write
     to the Desktop. The note says 'workspace' only where the URL proves it or the agent's real workspace root holds the path. */
  A.eq([ws.inWorkspace, abs.inWorkspace, wsr.inWorkspace, pr.inWorkspace], [true, null, true, false], 'inWorkspace: relative = proven, workshop run = proven, absolute = unknown, project file = no');
  A.eq(D.outsideNote(ws, 'C:\\work\\acme', 'ULTRON', ''), 'saved in ULTRON workspace, not in acme', 'a relative workspace file of a project item: the workspace note');
  const desk = loc('/api/file?agent=nova&path=' + encodeURIComponent('C:\\Users\\me\\Desktop\\report.md'), 'C:\\work\\my-app');
  A.eq(D.outsideNote(desk, 'C:\\work\\my-app', 'NOVA', ''), 'saved outside my-app', 'a granted Desktop file is said as outside the project, never as the workspace (no root known yet)');
  A.eq(D.outsideNote(desk, 'C:\\work\\my-app', 'NOVA', 'C:\\Users\\me\\StarNet\\workspaces\\nova\\'), 'saved outside my-app', '…nor once the real workspace root is known and does not hold it');
  const outp = loc('/api/file?agent=nova&path=' + encodeURIComponent('C:\\Users\\me\\StarNet\\workspaces\\nova\\.output\\r.md'), 'C:\\work\\my-app');
  A.eq(D.outsideNote(outp, 'C:\\work\\my-app', 'NOVA', 'C:\\Users\\me\\StarNet\\workspaces\\nova\\'), 'saved in NOVA workspace, not in my-app', 'an absolute .output/ file inside the real workspace root keeps the workspace note');
  A.eq(D.outsideNote(pr, 'C:\\work\\acme', 'ULTRON', ''), '', 'a file inside the project carries no outside note');
  A.eq(D.outsideNote(nop, '', 'A', ''), '', 'an item with no project carries no outside note');
  A.eq(D.savedLocation({ agentId: 'a' }, { path: '', openUrl: '' }, ''), null, 'no path = no key');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'deliverables.js'), 'utf8');
  // P24 polish: the name keeps the row — the keys are glyph-only and ride the row's END, after the size and the main marker
  A.ok(/OPEN FILE<\/a><span class="dlv-fname">' \+ esc\(f\.path\) \+ '<\/span><span class="dlv-fsize">[\s\S]{0,140}<span class="dlv-floc" data-floc="' \+ fi \+ '"><\/span><\/li>/.test(src), 'every openable FILES row carries a key slot at its end');
  A.ok(/tauriCore\(\) \? Chat\.folderButton\(loc\.agentId, loc\.path\) : Chat\.copyPathButton\(loc\.agentId, loc\.path\)/.test(src) && /if \(tauriCore\(\)\) keys\.push\(Chat\.copyPathButton\(loc\.agentId, loc\.path\)\)/.test(src), 'desktop gets the folder key plus copy path; a browser gets the one copy-path key (its own glyph)');
  A.ok(/k\.removeAttribute\('title'\); k\.setAttribute\('data-tip-path', ''\); k\.setAttribute\('data-tip', \[verbs\[ki\], lead, breakable\(p\)\]/.test(src) && /let lead = sentence\(outsideNote\(loc, r\.project, agentLabel\(loc\.agentId\), ''\)\)/.test(src)
    && /Chat\.fullSavedPath\(loc\.agentId, ''\)\)\.then\(root => \{\s*const proven = sentence\(outsideNote\(loc, r\.project, agentLabel\(loc\.agentId\), root\)\)/.test(src), 'the full path rides a path data-tip (not title=): what the key does, the outside-the-project note, then the path');
  A.ok(/\.dlv-floc \.dlv-loc-key \.fb-label \{ display: none; \}/.test(fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'css', 'deliverables-glass.css'), 'utf8')), 'the row keys are glyph-only (their words ride the tip and aria-label)');
  A.ok(/if \(folderKey && folderKey\.click\) \{ folderKey\.click\(\);/.test(src), 'a failed desktop OPEN runs the folder key instead of the old hunt-for-it sentence');
  // a TO REVIEW FILES row (outbox.js) shares this OPEN seam but has no key slot: its fallback must name the library row
  // that really carries the key, never a folder key that is not on that surface, and only while that library card is drawn
  // (a cleared run stays in TO REVIEW with no library card: deliverables-open.test.js runs that case)
  A.ok(/slot \? slot\.querySelector\('\.deliverable-folder'\) : null, !slot && libraryShows\(link, r\.runId\)\)/.test(src) &&
    /else if \(say && pointBelow\) say\('Could not open that file — open its run in the library below; the folder key on its file row shows where it is saved\.'/.test(src) &&
    !/its folder key shows where it is saved/.test(src), 'a keyless TO REVIEW row points at the library row that has the folder key');
  const ob = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'windows', 'outbox.js'), 'utf8');
  A.ok(/DLV\.handleOpenClick\(/.test(ob) && !/dlv-floc/.test(ob), 'TO REVIEW rows still route OPEN through the library seam without their own key slot');
  const chat = fs.readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  A.ok(/folderButton, copyPathButton, fullSavedPath: absoluteArtifactPath \};\n\}\)\(\);\s*$/.test(chat), 'Chat exports the shared keys and their resolver');
}
A.report('deliverables-ui.test');
