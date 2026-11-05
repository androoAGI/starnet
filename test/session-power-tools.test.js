/* node test/session-power-tools.test.js — Wave 4A session search/export/recovery/bulk cleanup. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const W = require('../frontend/app/workstreams.js');

const DAY = 86400000;
const NOW = 200 * DAY;
const rows = [{ id: 'general', title: null, kind: 'chat', lane: 'active', createdAt: NOW, lastActiveAt: NOW, history: [] }];
for (let i = 1; i <= 50; i++) {
  rows.push({
    id: 's' + i,
    title: i === 17 ? 'Orchid launch notes' : 'Session ' + i,
    kind: 'chat', lane: i % 7 === 0 ? 'shipped' : 'active',
    createdAt: NOW - i * DAY, lastActiveAt: NOW - i * DAY,
    pinned: i === 49,
    history: i % 5 === 0 ? [] : [
      { role: 'user', content: i === 23 ? 'The body contains NEBULA-NEEDLE.' : 'Question ' + i },
      { role: 'assistant', content: 'Answer ' + i }
    ]
  });
}
W.init({ workstreams: rows, activeId: 's17', generalId: 'general' });

/* one surface searches all 50 title and transcript records */
A.eq(W.search('orchid').map(x => x.id), ['s17'], 'title search finds the known session');
A.eq(W.search('nebula-needle').map(x => x.id), ['s23'], 'body search finds the known transcript hit');
A.ok(W.search('answer').length === 40, 'search spans all seeded transcript bodies');
A.ok(!W.search('nebula-needle')[0].snippet.startsWith('Session 23'), 'body snippet does not repeat the separately rendered title');

/* export: visible dialogue only, obvious secrets scrubbed, hidden/system material absent */
const active = W.get('s17');
active.history.push(
  { role: 'system', content: 'HIDDEN-SYSTEM-SENTINEL' },
  { role: 'assistant', sys: true, content: 'LOCAL-MARKER-SENTINEL' },
  { role: 'user', content: 'token sk-abcdefghijklmnopqrstuvwxyz123456 and Bearer ABCDEFGHIJKLMNOPQRSTUV' },
  { role: 'assistant', content: 'safe visible answer' }
);
const json = W.exportConversation('s17', 'json', { exportedAt: 123 });
A.ok(json && json.mime === 'application/json', 'JSON export has an explicit MIME type');
A.ok(!/HIDDEN-SYSTEM|LOCAL-MARKER/.test(json.text), 'JSON excludes hidden system/local rows');
A.ok(!/sk-abcdefghijklmnopqrstuvwxyz|ABCDEFGHIJKLMNOPQRSTUV/.test(json.text), 'JSON scrubs obvious credential material');
A.ok(/\[redacted\]/.test(json.text), 'JSON visibly marks scrubbed values');
const parsed = JSON.parse(json.text);   // the importer (parseConversationExport) had no caller and was removed with the clear (turn identity commit 16)
A.eq(parsed.title, 'Orchid launch notes', 'JSON export carries its title');
A.ok(parsed.messages.some(m => m.content === 'safe visible answer'), 'JSON export carries visible dialogue');
A.ok(parsed.messages.every(m => m.role === 'user' || m.role === 'assistant'), 'the export contains dialogue roles only');
// the export reads the station's DISPLAY view when it has one: a row the station no longer shows (it quotes a deleted session) is not exported
const viaDisplay = W.exportConversation('s17', 'json', { exportedAt: 123, rows: [{ role: 'user', content: 'from the station' }, { role: 'assistant', content: 'a file chip', kind: 'deliverable' }, { role: 'assistant', content: 'station reply' }] });
A.eq(viaDisplay.doc.messages.map(m => m.content), ['from the station', 'station reply'], 'with the display rows of the station the export is those turns only (system-kind rows are not dialogue)');
const quoted = W.exportConversation('s17', 'json', { exportedAt: 123 });
A.ok(quoted.doc.messages.length > 0, 'without display rows the page history is exported');
const md = W.exportConversation('s17', 'markdown', { exportedAt: 123 });
A.ok(md && md.mime === 'text/markdown' && /^# Orchid launch notes/m.test(md.text), 'Markdown export has heading and MIME');
A.ok(/## Commander[\s\S]*## Agent/.test(md.text), 'Markdown labels both visible speakers');
A.ok(!/HIDDEN-SYSTEM|LOCAL-MARKER/.test(md.text), 'Markdown excludes hidden/system rows too');

/* bulk preview is exact; pinned and General are protected; only previewed ids move; undo survives restart */
const preview = W.previewArchive({ empty: true, completed: true, olderThanMs: 30 * DAY }, { now: NOW });
A.ok(preview.ids.length > 0, 'bulk criteria produce a non-empty preview');
A.ok(!preview.ids.includes('general'), 'bulk preview always protects General');
A.ok(!preview.ids.includes('s49'), 'bulk preview protects pinned sessions by default');
const beforeArchived = Object.fromEntries(W.all().map(w => [w.id, !!w.archived]));
const result = W.archivePreview(preview, { at: 888 });
A.eq(result.ids, preview.ids, 'bulk archive affects the exact previewed id list');
for (const w of W.all()) {
  const shouldMove = preview.ids.includes(w.id);
  A.eq(!!w.archived, shouldMove ? true : beforeArchived[w.id], 'archive membership is exact for ' + w.id);
}
const bulkSave = JSON.parse(JSON.stringify(W.serialize()));
W.init(bulkSave);
A.ok(W.undoLast(), 'bulk recovery checkpoint survives serialize/restart');
for (const id of preview.ids) A.eq(!!W.get(id).archived, beforeArchived[id], 'bulk undo restores ' + id);

/* stale/tampered previews cannot cross the shown set */
const exact = W.previewArchive({ empty: true }, { now: NOW });
const forged = Object.assign({}, exact, { ids: exact.ids.concat('s23') });
A.eq(W.archivePreview(forged), null, 'a forged preview token is rejected without mutation');
A.eq(!!W.get('s23').archived, beforeArchived.s23, 'rejected forged preview cannot archive an unpreviewed session');

/* browser wiring (2026-07-17 window retirement): search lives ON the rail, export lives in the
   row ⋯ actions menu, and the SESSION TOOLS window is fully gone — no orphaned entry points. */
const app = fs.readFileSync(require.resolve('../frontend/app/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
const sui = fs.readFileSync(require.resolve('../frontend/app/stationui.js'), 'utf8');
A.ok(!/data-term="sessiontools"/.test(html) && !/ws-tools-park/.test(html), 'the SESSION TOOLS window entry and parked panel are fully removed');
A.ok(!/buildSessionTools|parkSessionTools|sessiontools:/.test(sui), 'stationui no longer builds a SESSION TOOLS window');
A.ok(!/ws-tools-btn/.test(html), 'rail head stays SESSIONS/PROJECTS + NEW only (no inline TOOLS button)');
A.ok(/id="ws-rail-search"[\s\S]*id="ws-search"[\s\S]*search sessions \+ transcripts/.test(html), 'one labelled rail search surface covers sessions and transcripts');
A.ok(/sessions\.hidden = railView !== 'sessions' \|\| !!q/.test(app), 'an active search replaces ordinary session rows instead of leaving unrelated rows visible below the results');
A.ok(/input\.value = ''; renderSessionSearch\(\)/.test(app), 'opening a search hit clears search mode and restores the ordinary session rail');
A.ok(/searchActive = view === 'sessions' && !!\(search && search\.value\.trim\(\)\)/.test(app)
  && /set\('workstreams', pan\.sessionsList && !searchActive\)/.test(app), 'returning from PROJECTS preserves an active search instead of revealing unfiltered session rows');
A.ok(/set\('ws-rail-search', pan\.sessionsList\)/.test(app), 'the PROJECTS view hides rail search along with the sessions list');
A.ok(/item\('export-md', 'Export \.md'/.test(app) && /item\('export-json', 'Export \.json'/.test(app), 'both export formats live in the row actions menu');
A.ok(/exportSession\(id, 'markdown'\)/.test(app) && /exportSession\(id, 'json'\)/.test(app), 'menu export acts on the exact row session, never an implicit active one');
A.ok(/role', 'listbox'/.test(app) && /role="option" aria-selected=/.test(app),
  'the session rail exposes one named composite with selectable options');
A.ok(/w\.id === railFocusId \? '0' : '-1'/.test(app) && /let railFocusId = null/.test(app),
  'session rows use a roving tabindex instead of adding every session to the global Tab order');
A.ok(/<button class="ws-kebab" tabindex="-1" aria-label="session actions"/.test(app),
  'the pointer-only kebab stays out of the tab order so the rail has one keyboard stop');
A.ok(/e\.key === 'ArrowDown'[\s\S]{0,500}e\.key === 'ArrowUp'[\s\S]{0,500}e\.key === 'Home'[\s\S]{0,500}e\.key === 'End'[\s\S]{0,700}target\.focus\(\)/.test(app),
  'arrow, Home and End move the roving focus without opening sessions');
A.ok(/e\.key === 'Enter'[\s\S]{0,150}switchWorkstream\(id\)[\s\S]{0,1500}e\.key === 'F10'[\s\S]{0,300}openWsMenu\(id, r\.left, r\.bottom \+ 2, li\)/.test(app),
  'session options still open with Enter or Space and expose actions with Shift+F10');
A.ok(/restoreFocus[\s\S]{0,2600}target\.focus\(\{ preventScroll: true \}\)/.test(app),
  'a rail re-render restores focus to the same roving session row');
A.ok(/openWsMenu\(id, r\.left, r\.bottom \+ 2, keb\)/.test(app),
  'session actions pass their keyboard-focus origin into the menu');
A.ok(/menu\.querySelector\('\.ws-menu-item'\)\.focus\(\)/.test(app),
  'opening the session menu transfers focus to its first action');
A.ok(/e\.key === 'Escape'[\s\S]{0,100}closeWsMenu\(true\)/.test(app),
  'Escape closes the session menu and returns focus to its trigger');
A.ok(/sessionUndo:\s*saved\.sessionUndo/.test(app), 'the durable recovery checkpoint is still hydrated on restart');
A.ok(/U\.saveFile\(/.test(A.fnBody(app, 'function sessionDownload('))
  && /URL\.revokeObjectURL/.test(fs.readFileSync(path.join(__dirname, '../frontend/js/util.js'), 'utf8')),
  'session exports use the shared download owner, which releases its object URL');

A.report('session-power-tools.test');
