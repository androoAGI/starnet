/* node test/declutter-strips.test.js — the three "space thief" fixes of 2026-10-10 (Andrew: "wtf is this share BS … the user
   can't minimize that?"): the group chat's one-budget tray, the DELIVERABLES clear-from-library, and TO REVIEW's fold. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/* ---- GROUP CHAT: one tray, one budget, the shelf folds, the preview is no longer the shelf's child ---- */
const gc = read('frontend/app/group-chat.js');
A.ok(/#gc-tray\{[^}]*max-height:45%/.test(gc), 'everything under the transcript shares ONE 45% budget');
A.ok(!/max-height:40%/.test(gc) && !/#gc-questions\{[^}]*max-height:50%/.test(gc) && !/#gc-states\{[^}]*max-height:45%/.test(gc),
  'the three old per-strip caps (40% + 50% + 45% = 135%) are gone');
A.ok(/trayScroll\.append\(questions, states, preview\); tray\.append\(trayScroll, files\)/.test(gc),
  'questions, turn rows and the open file scroll inside the tray; the shelf rides its foot');
A.ok(/root\.append\(transcript, tray, recipient/.test(gc), 'the transcript is followed by the tray, not three loose strips');
A.ok(!/files\.append\([^)]*gc-preview/.test(gc), 'the preview is NOT inside the shelf (an attachment previews in a group with no shared files)');
A.ok(/id: 'gc-files', hidden: ''/.test(gc), 'the shelf chips start folded');
A.ok(/'starnet\.gc\.filesOpen\.' \+ id/.test(gc), 'the fold is remembered per group');
A.ok(/#gc-files\{[^}]*max-height:132px;overflow-y:auto/.test(gc), 'an opened shelf scrolls inside its own cap (no chips spilling under the composer)');
A.ok(/gc-preview-head[\s\S]{0,400}button\('CLOSE FILE', closeFile\)/.test(gc), 'CLOSE FILE sits in the preview head, not after the whole file body');

/* ---- DELIVERABLES: clear from the library (files kept), undoable, scoped by the view's own filter ---- */
const idx = readSidecarSource();
A.ok(/exact: '\/api\/deliverables\/clear', h: handleDeliverablesClear/.test(idx) && /exact: '\/api\/deliverables\/clear-undo', h: handleDeliverablesClearUndo/.test(idx),
  'clear + undo routes are registered');
const clearFn = idx.slice(idx.indexOf('async function handleDeliverablesClear('), idx.indexOf('async function handleDeliverablesClearUndo('));
A.ok(/r\.status !== 'pending'/.test(clearFn) && /skipped/.test(clearFn), 'a row that still needs a decision is never cleared, and is counted as skipped');
A.ok(/byIds === byFilter/.test(clearFn), 'an empty body clears nothing: a bulk clear must name ids or a filter');
A.ok(/deliverableFilter\(rows, deliverableFilterOf\(body\.filter\)\)/.test(clearFn) && /items = deliverableFilter\(items, filter\)/.test(idx),
  'the list and the bulk clear share ONE filter (clear these = exactly the rows in view, past the 500 the list ships)');
A.ok(/includeCleared \? await deliverableRows\(\) : await visibleDeliverableRows\(\)/.test(idx), 'the list hides cleared rows unless asked for the whole index');
const outbox = read('frontend/app/windows/outbox.js');
A.ok(/api\/deliverables\?includeCleared=1/.test(outbox), "TO REVIEW's FILES join still sees a crate whose library card was cleared");
const dlv = read('frontend/app/deliverables.js');
A.ok(/r\.status !== 'pending' \? '<button class="bb sm" data-act="clear"/.test(dlv), 'the drawer offers ✓ DONE · CLEAR on every row but an undecided build');
A.ok(/dataset.act === 'clear'\) return clearRows\(\{ ids: \[r\.id\] \}/.test(dlv), 'one card clears by its id');
A.ok(/class="dlv-bclear" data-bucket=/.test(dlv) && /bucketBounds\(bucket\)/.test(dlv), 'each time heading clears its own window');
A.ok(/ArmConfirm\.wire\(shown,/.test(dlv), 'CLEAR ALL / CLEAR THESE arms before it fires (station 2-step, no native confirm)');
A.ok(/data-undo-clear/.test(dlv) && /\/api\/deliverables\/clear-undo/.test(dlv), 'every clear offers UNDO in the message line');
A.ok(/The files stay on disk/.test(dlv), 'the copy says plainly that files are not deleted');
A.ok(/<details class="dlv-clean-list">/.test(dlv) && /dl-clean-cancel/.test(dlv), 'the CLEAN OLD RECORDS preview folds its list and can be cancelled');

/* ---- TO REVIEW: folds (remembered), shows a few until SHOW ALL, CLEAR ALL collects every crate ---- */
A.ok(/FOLD_KEY = 'starnet\.dlv\.review\.open', FEW = 3/.test(outbox), 'TO REVIEW folds (remembered) and shows the first 3 rows');
A.ok(/r\.hidden = !showAll && i >= FEW/.test(outbox), 'rows past the first few wait behind SHOW ALL');
A.ok(/RS\.resolveAll\(ids\)/.test(outbox) && /ArmConfirm\.wire\(clearAll,/.test(outbox), 'CLEAR ALL arms, then collects every crate in one go');
// org pass 10-14 (P12): the key says what it does (files them unrated), and the dim line says what the list holds
A.ok(/class="bb sm ob-clearall" data-tip="Takes every run off this list without a rating[^"]*">' \+ markLabel\(rows\.length\)/.test(outbox) && /const markLabel = n => '✓ MARK ALL ' \+ n \+ ' REVIEWED';/.test(outbox) && /b\.textContent = 'MARK ALL ' \+ list\.children\.length \+ ' REVIEWED — SURE\?'/.test(outbox), 'the clear key reads ✓ MARK ALL N REVIEWED (armed: MARK ALL N REVIEWED — SURE?, the count in one place), a glass key with a data-tip (no title=)');
A.ok(/armedLabel: 'MARK ALL REVIEWED — SURE\?'/.test(outbox) && /'Marked ' \+ ids\.length \+ ' reviewed\. Nothing was deleted\.'/.test(outbox), 'its armed label and toast say mark reviewed');
// org live walk 10-14 (P12): a run with no files is NOT in the library (sidecar deliverableRows drops it), so no TO REVIEW
// copy may say every row is — the note, MARK ALL's tip and its toast claimed it for 3 of 4 rows
A.ok(!/already in the library|work stays in your library/i.test(outbox), 'no TO REVIEW text claims every row is filed in the library');
A.ok(/const reviewNote = 'Away runs and workflow jobs waiting for your rating\. Files they made are in the library below; each one keeps its session \(↗ OPEN SESSION\)\./.test(outbox) && /class="consent-btn ob-open">↗ OPEN SESSION</.test(outbox), 'the note says what is true of every row: files in the library, the run in its session (every row carries ↗ OPEN SESSION)');
A.ok(/data-tip="Takes every run off this list without a rating\. Nothing is deleted: files stay in your library, each run in its session\."/.test(outbox), 'MARK ALL\'s tip says nothing is deleted, without claiming library filing');
A.ok(/Away runs and workflow jobs waiting for your rating/.test(outbox) && /Chats are rated in COMMS/.test(outbox) && !/waiting for your verdict \(/.test(outbox), 'the TO REVIEW dim line names what it holds');
A.ok(/<span class="dlv-review-lbl">TO REVIEW<\/span> <span class="dlv-review-n">' \+ rows\.length/.test(outbox) && /<p class="dim dlv-review-note">' \+ reviewNote/.test(outbox), 'P12 polish: the heading is one line (TO REVIEW N); what it holds is a note under it');
A.ok(!/CLEAR ALL ' \+ (rows|live)\.length/.test(outbox), 'no second CLEAR ALL label sits above the library’s own CLEAR ALL');
const rstore = read('frontend/app/returnstore.js');
A.ok(/function outboxLine\(\) \{ return 'they wait in TO REVIEW until you rate them\.'; \}/.test(rstore), 'the away digest points at TO REVIEW, not a floor crate (OUTBOX LAW)');
A.ok(/function resolveAll\(runIds\)[\s\S]{0,300}save\(\);[\s\S]{0,200}OutboxView\.refresh\(\)/.test(rstore), 'resolveAll is one save + one refresh');
A.ok(/\bresolveAll\b/.test(rstore.slice(rstore.lastIndexOf('return {'))), 'ReturnStore exports resolveAll');

/* ---- CHAT: files the agent names render as files, not raw markdown (Andrew's screenshot, 2026-10-10) ---- */
const chat = read('frontend/app/chat.js');
const ex = name => { const m = new RegExp('(  function ' + name + '\\([\\s\\S]*?\\n  \\})').exec(chat); A.ok(m, 'chat.js defines ' + name); return m ? m[1] : ''; };
const esc = /const HTML_ESC = \{[^}]*\};/.exec(chat)[0], rel = /  const REL_PATH = [^\n]*;/.exec(chat)[0];
// eslint-disable-next-line no-new-func
const inline = new Function(esc + '\n' + rel + '\n' + ex('escapeHtml') + ex('linkify') + ex('hostOf') + ex('linkHostNote') + ex('appFileRef') + ex('fileRefLink') + ex('fileRefImage') + ex('reportInline') + '\nreturn reportInline;')();
let o = inline('[Review the original](review/coffee-break-cat-new/index.html)');
A.ok(/<a class="md-file" href="#" data-md-path="review\/coffee-break-cat-new\/index\.html">Review the original<\/a>/.test(o), 'a relative [link](path) is a file link');
o = inline('![New candidate](review/coffee-break-cat-new/final-preview.jpg)');
A.ok(/<span class="md-img" data-md-path="review\/coffee-break-cat-new\/final-preview\.jpg" data-md-alt="New candidate">/.test(o) && !/!\[/.test(o), 'a relative ![image](path) becomes an image slot (no raw markdown left)');
A.ok(/href="https:\/\/x\.test\/a\.png"/.test(inline('![pic](https://x.test/a.png)')) && !/<img/.test(inline('![pic](https://x.test/a.png)')), 'a web image is a link, never an auto-loaded remote <img>');
for (const bad of ['../secrets.txt', '/etc/passwd', 'C:\\x.txt', '#top', 'javascript:alert(1)'])
  A.ok(!/md-file|md-img|href="(?!https?:)/.test(inline('[x](' + bad + ')')), 'no file link for an unsafe target: ' + bad);
A.ok(!/<script|<b>|"onerror/.test(inline('[<script>](a"onerror=1.png)') + inline('![<b>](x.png)')), 'labels and paths are escaped into our markup');
A.ok(/\|\\\]\\\(\/m;/.test(chat), 'the prose fast path no longer skips a reply whose only markup is a link');
A.ok(/function hydrateFileRefs\(bodyEl[,)]/.test(chat) && /hydrateFileRefs\(bodyEl\);/.test(chat) && /hydrateFileRefs\(bodyEl, added\);/.test(chat), 'renderProse hydrates file links and images (a live frame: the blocks it drew)');
A.ok(/new Blob\(\[b\], \{ type: 'image\/svg\+xml' \}\)/.test(chat), 'an .svg served as a download is retyped so the <img> decodes');
A.ok(/\.md-img\[data-ready\]/.test(chat), 'a loaded image is carried across streaming re-renders (no per-frame rebuild)');
A.ok(/userScrollHeld \|\| Date\.now\(\) - userScrollAt < 1200\) stick = false/.test(chat) && /else if \(stick\) log\.scrollTop = log\.scrollHeight/.test(chat),
  'only a real scroll gesture stops the follow; layout moving under a follower re-pins');
A.ok(/wire: \(a, p\) => \{\s*a\.addEventListener\('click', ev => \{\s*const art = sharedFor\(groupId, p, agentId, messageId\)/.test(gc), "a group link resolves its author and message version at CLICK time");
A.ok(/class: 'gc-message cmsg agent gc-doc'/.test(gc), 'a previewed .md file wears the transcript markdown styles');
const comms = read('frontend/css/comms.css');
A.ok(/\.chat-attach-strip:not\(\[hidden\]\) \{ max-height: 124px; overflow-y: auto/.test(comms) && /\.chat-queued:not\(:empty\) \{ max-height: 104px; overflow-y: auto/.test(comms),
  'staged attachments and queued messages scroll inside a cap instead of pushing the transcript up');
const voice = read('frontend/app/voice.js');
// (the speaker-off clear is one helper since 2026-10-15; voice.button.test proves every off path behaviorally)
A.ok(/el\.addEventListener\('click', \(\) => showInterruption\(''\)\)/.test(voice)
  && /function speakerOffClearsNote\(\) \{ if \(interruptionMessage\) showInterruption\(''\); \}/.test(voice)
  && /muteStopSpeaking\(\); speakerOffClearsNote\(\);/.test(voice),
  'the speech-interrupted note can be dismissed and clears when the speaker goes off');

/* ---- DELIVERABLES toolbar + drawer (org pass 10-14, P13): upkeep folds, filters stay, chips read plainly ---- */
{
  const bar = dlv.slice(dlv.indexOf('<div class="deliverables-toolbar">'), dlv.indexOf('<div id="dl-kinds"'));
  const fold = bar.indexOf('<details class="dlv-tools"');
  A.ok(fold > 0, 'the toolbar carries one MORE fold');
  A.ok(bar.indexOf('id="dl-query"') < fold && bar.indexOf('id="dl-status"') < fold && bar.indexOf('id="dl-clear-shown"') < fold, 'search, the status filter and CLEAR ALL/THESE stay in view, outside the fold');
  A.ok(bar.indexOf('id="dl-refresh"') > fold && bar.indexOf('id="dl-clean"') > fold, 'only REFRESH and the cleanup key fold behind MORE');
  A.ok(/<summary class="bb sm"[^>]*>MORE /.test(bar), 'MORE is a glass key (.bb sm), not an OS-painted control');
  A.ok(/id="dl-clean" data-tip="[^"]+">DELETE FAILED &amp; DISCARDED RECORDS</.test(bar) && !/CLEAN OLD RECORDS<\/button>/.test(dlv), 'the cleanup key names what it removes (its preview + UNDO stay)');
  A.ok(/\/api\/deliverables\/cleanup-preview', \{ statuses: \['discarded', 'failed'\] \}/.test(dlv) && /id="dl-undo">UNDO/.test(dlv), 'the cleanup still previews failed + discarded and offers UNDO');
  A.ok(/kinds\.map\(k => chip\(k\.kind, kindLabel\(k\.kind\), k\.count\)\)/.test(dlv) && /workflow: 'WORKFLOW JOBS'/.test(dlv) && /files: 'FILES'/.test(dlv), 'KIND chips read a plain label; the raw kind stays the filter value');
  {
    // org live walk 10-14 (P13): a real run's file read "FILE" — the shots used mocked rows with kind 'files'. GENUINE: the
    // REAL label map, against every kind a run artifact really carries (runstore's own ARTIFACT_KINDS)
    const KIND_LABEL = new Function('return ' + /const KIND_LABEL = (\{[^}]*\});/.exec(dlv)[1])();
    const kindLabel = new Function('KIND_LABEL', 'return ' + /const kindLabel = (k => [^;]*);/.exec(dlv)[1])(KIND_LABEL);
    const artifactKinds = JSON.parse(/const ARTIFACT_KINDS = new Set\((\[[^\]]*\])\)/.exec(read('sidecar/runstore.js'))[1].replace(/'/g, '"'));
    A.ok(artifactKinds.length >= 3, 'fixture: read the artifact kinds runstore keeps: ' + artifactKinds.join(','));
    for (const k of artifactKinds) A.ok(Object.prototype.hasOwnProperty.call(KIND_LABEL, k) && /S$/.test(KIND_LABEL[k]), 'the "' + k + '" kind chip reads a plain plural: ' + kindLabel(k));
    A.eq(kindLabel('file'), 'FILES', 'a run artifact\'s file reads FILES, never FILE');
    // and one chip, not two: the sidecar files an unnamed run's 'file' artifact under the library's 'files' kind
    A.ok(/source: 'run', status: status, kind: a\.kind === 'file' \? 'files' : a\.kind,/.test(readSidecarSource()), 'an unnamed run\'s file row carries the library\'s "files" kind (one FILES chip beside a named run\'s rows)');
  }
  A.ok(/class="dlv-bclear" data-bucket=/.test(dlv), 'per-bucket CLEAR stays a visible key');
  A.ok(!/data-act="clear" title=/.test(dlv) && /data-act="clear" data-tip="Takes it out of this library\. The files stay on disk\.">✓ DONE · CLEAR</.test(dlv), 'DONE · CLEAR carries a data-tip, not a native title');
  const css = read('frontend/css/deliverables-glass.css');
  A.ok(/\.dlv-tools > summary \{ list-style: none;/.test(css) && /\.dlv-tools-keys \{ display: inline-flex;/.test(css), 'the fold opens inline in the toolbar row (no popover)');
  // run the REAL drawer: the main file's OPEN leads, data-file indices still point at each file, DONE · CLEAR comes last
  const src = dlv.slice(dlv.indexOf('    function detailHtml(r) {'), dlv.indexOf('    function cardHtml('));
  const detailHtml = new Function('esc', 'fileHref', 'openHref', 'fmtSize', 'safeMarkdown', src + '; return detailHtml;')(v => String(v), f => f.openUrl, f => f.openUrl, n => n + 'B', v => v);
  const html = detailHtml({ status: 'produced', main: 'out/report.md', files: [{ path: 'notes.txt', openUrl: 'u0', bytes: 1 }, { path: 'out/report.md', openUrl: 'u1', bytes: 2 }, { path: 'gone.csv', bytes: 3 }], actions: { keep: true } });
  A.ok(html.indexOf('report.md') < html.indexOf('notes.txt') && html.indexOf('notes.txt') < html.indexOf('gone.csv'), 'the main file is listed first, the rest keep their order');
  A.ok(/class="bb sm dlv-hero" data-file="1"/.test(html) && /data-file="0"[^>]*>OPEN<\/a>(<span class="dlv-floc" data-floc="0"><\/span>)?<span class="dlv-fname">notes\.txt/.test(html), 'each OPEN keeps its original backend index');
  A.ok(html.lastIndexOf('data-act="clear"') > html.lastIndexOf('data-act="keep"'), '✓ DONE · CLEAR is the last key');
}
A.report('declutter-strips.test');
