/* node test/projects-view.test.js — the PROJECTS rail view shaping (frontend/app/projects.js, NS-5c).
   Locks: toRows mirrors GET /api/projects EXACTLY (a blessed:false row is kept + flagged REVOKED, never hidden —
   truthful telemetry), basename handles win32 + posix paths, relTime speaks the rail's own now/2m/1h/3d vocabulary,
   and panels() is the toggle's show/hide truth table. Pure + headless like workstreams.test.js. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/projects.js');
const fs = require('fs');
const path = require('path');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');

/* ---------- basename: win32 + posix, trailing separators ignored ---------- */
A.eq(P.basename('C:\\Users\\me\\project'), 'project', 'win32 basename');
A.eq(P.basename('/home/me/proj'), 'proj', 'posix basename');
A.eq(P.basename('/home/me/proj/'), 'proj', 'trailing slash ignored');
A.eq(P.basename('C:\\Users\\me\\proj\\'), 'proj', 'trailing backslash ignored');
A.eq(P.basename(''), '', 'empty path -> empty basename');

/* ---------- relTime: the SAME compact vocabulary as the sessions rail ---------- */
const NOW = 1_000_000_000_000;
A.eq(P.relTime(0, NOW), '', 'no timestamp -> empty (no honest "last worked")');
A.eq(P.relTime(NOW - 30_000, NOW), 'now', 'under a minute reads now');
A.eq(P.relTime(NOW - 5 * 60_000, NOW), '5m', 'minutes');
A.eq(P.relTime(NOW - 3 * 3_600_000, NOW), '3h', 'hours');
A.eq(P.relTime(NOW - 2 * 86_400_000, NOW), '2d', 'days');

/* ---------- toRows: mirrors /api/projects, including a REVOKED (blessed:false) row ---------- */
const apiProjects = [
  { root: '/home/me/repo', displayPath: '/home/me/repo', isGitRepo: true, lastTouchedAt: NOW - 60_000, blessed: true },
  { root: '/home/me/plain', displayPath: '/home/me/plain', isGitRepo: false, lastTouchedAt: NOW - 2 * 3_600_000, blessed: false },
  { root: 'C:\\proj\\win', displayPath: 'C:\\proj\\win', isGitRepo: true, lastTouchedAt: null, blessed: true }
];
const rows = P.toRows(apiProjects, NOW);
A.eq(rows.length, 3, 'every API row is rendered (a revoked row is NOT hidden)');

A.eq(rows[0].name, 'repo', 'row name is the basename');
A.eq(rows[0].blessed, true, 'blessed row stays blessed');
A.eq(rows[0].state, 'blessed', 'blessed state');
A.eq(rows[0].isGitRepo, true, 'git flag carried');
A.eq(rows[0].rel, '1m', 'lastTouchedAt -> relative stamp');

A.eq(rows[1].blessed, false, 'blessed:false is preserved verbatim (truthful telemetry)');
A.eq(rows[1].state, 'revoked', 'blessed:false -> REVOKED state, shown not hidden');
A.eq(rows[1].name, 'plain', 'revoked row still names its folder');

A.eq(rows[2].rel, '', 'a never-touched project has an empty stamp, not a fake time');
A.eq(rows[2].name, 'win', 'win32 displayPath basename');

// a missing `blessed` field (older payload) defaults to blessed:true; a bad input is a safe empty list.
A.eq(P.toRows([{ root: '/a/b', displayPath: '/a/b' }], NOW)[0].blessed, true, 'absent blessed defaults true');
A.eq(P.toRows(null).length, 0, 'null input -> empty rows');

/* ---------- sessionsFor: the REAL stored w.projectRoot link, never a title guess ---------- */
const wsList = [
  { id: 'a', title: 'repo work', projectRoot: '/home/me/repo', archived: false, lastActiveAt: NOW - 60_000 },
  { id: 'b', title: 'older repo work', projectRoot: '/home/me/repo', archived: false, lastActiveAt: NOW - 3_600_000 },
  { id: 'c', title: 'repo-ish but unanchored', projectRoot: null, archived: false, lastActiveAt: NOW },
  { id: 'd', title: 'archived repo work', projectRoot: '/home/me/repo', archived: true, lastActiveAt: NOW },
  { id: 'e', title: null, projectRoot: '/other', archived: false, lastActiveAt: NOW - 1000 }
];
const sess = P.sessionsFor('/home/me/repo', wsList, NOW);
A.eq(sess.length, 2, 'only live sessions with the EXACT stored root attach (no title guessing, archived excluded)');
A.eq(sess[0].id, 'a', 'most-recently-active first');
A.eq(sess[1].id, 'b', 'older second');
A.eq(sess[0].rel, '1m', 'session rows speak the rail relTime vocabulary');
A.eq(P.sessionsFor('/other', wsList, NOW)[0].title, 'General', 'a null-title record reads as General');
A.eq(P.sessionsFor('', wsList, NOW).length, 0, 'empty root -> no attachments');
A.eq(P.sessionsFor('/nowhere', wsList, NOW).length, 0, 'unknown root -> empty, never a fake list');
A.eq(P.sessionsFor('/home/me/repo', null, NOW).length, 0, 'bad workstreams input -> safe empty');

/* ---------- sameRoot: the two anchor doors may differ only in case/slash shape on Windows ---------- */
A.eq(P.sameRoot('C:\\Proj\\Repo', 'c:\\proj\\repo'), true, 'win32 roots match case-insensitively');
A.eq(P.sameRoot('C:/proj/repo', 'C:\\proj\\repo'), true, 'win32 separators unify');
A.eq(P.sameRoot('C:\\proj\\repo\\', 'C:\\proj\\repo'), true, 'trailing separator ignored');
A.eq(P.sameRoot('/home/me/Repo', '/home/me/repo'), false, 'posix roots stay case-SENSITIVE');
A.eq(P.sameRoot('/home/me/repo/', '/home/me/repo'), true, 'posix trailing slash ignored');
A.eq(P.sameRoot('', ''), false, 'empty never matches (no fake attachment)');
A.eq(P.sameRoot(null, null), false, 'null never matches');
// and sessionsFor attaches through the SAME matcher: a Windows-case-variant stored anchor still lists.
const winWs = [{ id: 'w1', title: 'win work', projectRoot: 'c:\\proj\\WIN', archived: false, lastActiveAt: NOW }];
A.eq(P.sessionsFor('C:\\proj\\win', winWs, NOW).length, 1, 'win32 case-variant anchor still attaches to its project');

/* ---------- panels: the SESSIONS ↔ PROJECTS toggle truth table ---------- */
const s = P.panels('sessions');
A.eq(s.sessionsList, true, 'sessions view shows the sessions list');
A.eq(s.projectsList, false, 'sessions view hides the projects list');
A.eq(s.newBtn, true, 'sessions view shows + NEW');
A.eq(s.addBtn, false, 'sessions view hides + ADD');
const pr = P.panels('projects');
A.eq(pr.sessionsList, false, 'projects view hides the sessions list');
A.eq(pr.projectsList, true, 'projects view shows the projects list');
A.eq(pr.newBtn, false, 'projects view hides + NEW');
A.eq('archivedBtn' in pr, false, 'no ARCHIVED head action exists — the archived reveal is a footer row inside #workstreams');
A.eq(pr.addBtn, true, 'projects view shows + ADD');

/* ---------- revoked scope: browse history, but never mint work against an untrusted root ---------- */
const headAction = appSrc.slice(
  appSrc.indexOf('function updateProjHeadAction()'),
  appSrc.indexOf('function setRailView(', appSrc.indexOf('function updateProjHeadAction()'))
);
const newInProject = appSrc.slice(
  appSrc.indexOf('function newSessionInProject('),
  appSrc.indexOf('// the project row actions menu', appSrc.indexOf('function newSessionInProject('))
);
A.ok(/b\.disabled\s*=\s*!projScopeBlessed/.test(headAction),
  'entered revoked project disables + NEW from the fetched path-grant truth');
A.ok(/!projScopeBlessed/.test(newInProject),
  'newSessionInProject refuses to anchor a new session after trust is revoked');
A.ok(/Access revoked[\s\S]{0,180}existing sessions/i.test(appSrc),
  'revoked project empty-state copy says existing sessions remain browseable instead of promising new work');

/* ---------- project removal: revoke trust first, then hard-forget metadata truthfully ---------- */
const removeProject = appSrc.slice(
  appSrc.indexOf('function removeProject('),
  appSrc.indexOf('// ADD A PROJECT:', appSrc.indexOf('function removeProject('))
);
A.ok(/r\.blessed[\s\S]{0,220}\/api\/permissions\/revoke/.test(removeProject),
  'removing a blessed project uses the standing-grant revoke endpoint');
A.ok(/!r\.blessed[\s\S]{0,260}\/api\/projects\/forget/.test(removeProject),
  'forgetting a revoked project uses the project metadata forget endpoint');
A.ok(/trust revoked for/.test(removeProject) && /forgot/.test(removeProject),
  'success telemetry distinguishes trust revocation from an actually forgotten project');

/* ---------- bounded discovery: candidate selection is separate from authority ---------- */
const addProject = appSrc.slice(
  appSrc.indexOf('function beginAddProject()'),
  appSrc.indexOf('// disconnect()', appSrc.indexOf('function beginAddProject()'))
);
A.ok(/proj-add-discover/.test(addProject) && /\/api\/projects\/discover/.test(addProject),
  'Add Project offers an explicit bounded discovery action');
A.ok(/Candidate selected\. ADD grants this folder/.test(addProject),
  'candidate selection says plainly that it has not granted access yet');
A.ok(/const submit = \(\) =>[\s\S]{0,500}\/api\/projects\/bless/.test(addProject),
  'only the separate ADD submit reaches the durable path-grant route');
A.ok(/filter\(x => x && x\.root && !x\.blessed\)/.test(addProject),
  'discovery suggestions omit already-granted roots');

/* ---------- project rail accessibility: every clickable row is keyboard + AT reachable ---------- */
A.ok(/class="ws-row proj-row[\s\S]{0,300}tabindex="0" role="button" aria-label=/.test(appSrc),
  'project overview rows are named keyboard buttons');
A.ok(/class="proj-sess[\s\S]{0,300}tabindex="0" role="button" aria-label=/.test(appSrc),
  'project preview sessions and overflow rows are named keyboard buttons');
A.ok(/proj-sess-full[\s\S]{0,260}tabindex="0" role="button" aria-label=/.test(appSrc),
  'entered-project session rows are named keyboard buttons');
A.ok(/li\.onkeydown[\s\S]{0,240}e\.key === 'Enter'[\s\S]{0,160}li\.click\(\)/.test(appSrc),
  'project preview/session rows activate with Enter or Space');
A.ok(/openProjectMenu\(row, b\.left, b\.bottom \+ 2, li\)/.test(appSrc)
  && /menu\.querySelector\('\.ws-menu-item'\)[\s\S]{0,100}first\.focus\(\)/.test(appSrc)
  && /closeProjectMenu\(true\)/.test(appSrc),
  'Shift+F10 enters the project action menu and Escape restores its row focus');

/* ---------- failed refresh: unknown stays unknown; never mint an empty trust ledger ---------- */
const renderProjects = appSrc.slice(
  appSrc.indexOf('function renderProjects()'),
  appSrc.indexOf('// sessions attached to one project', appSrc.indexOf('function renderProjects()'))
);
const unavailableProjects = appSrc.slice(
  appSrc.indexOf('function renderProjectsUnavailable('),
  appSrc.indexOf('function renderProjects()', appSrc.indexOf('function renderProjectsUnavailable('))
);
A.ok(/if \(!r\.ok\) throw new Error\('projects unavailable'\)/.test(renderProjects),
  'a non-2xx /api/projects response enters the unavailable path instead of synthesizing an empty list');
A.ok(/!Array\.isArray\(j\.projects\)/.test(renderProjects),
  'a malformed success payload is unavailable, not a confirmed empty trust ledger');
A.ok(!/projects:\s*\[\]/.test(renderProjects),
  'the fetch path cannot manufacture a confirmed-empty projects response');
A.ok(/lastConfirmedProjects[\s\S]*renderProjectRows\(ul, lastConfirmedProjects\)/.test(unavailableProjects),
  'failed refreshes repaint the last confirmed ledger before adding the stale warning');
A.ok(/showing the last confirmed list/.test(unavailableProjects) && /Reload to reconnect/.test(unavailableProjects),
  'the stale ledger is labeled honestly with the recovery action');
A.ok(!/setProjScope\(/.test(unavailableProjects),
  'an unavailable refresh cannot erase the persisted project scope');


/* Execute the production rendering path: source-pattern checks missed an undefined
   session-status variable in every nonempty project overview (v0.12.3). */
const vm = require('node:vm');
async function renderingRegression() {
  const list = { innerHTML: '', querySelectorAll: () => [], insertBefore(node) { this.innerHTML = node.textContent + this.innerHTML; } };
  const ctx = vm.createContext({
    Projects: P, Date, console: { error() {} },
    U: { esc: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') },
    Workstreams: { all: () => [], activeId: () => null },
    el: () => list,
    document: { createElement: () => ({ setAttribute() {} }) },
    railView: 'projects', projScope: null, lastConfirmedProjects: null,
    fetch: async () => ({ ok: true, json: async () => ({ projects: apiProjects }) })
  });
  for (const name of ['projDot', 'projSessionsOf', 'renderProjectsOverview', 'renderProjectRows', 'renderProjectsUnavailable', 'renderProjects']) {
    vm.runInContext(A.fnBody(appSrc, 'function ' + name + '('), ctx);
  }
  const refresh = async () => { vm.runInContext('renderProjects()', ctx); await new Promise(resolve => setImmediate(resolve)); };
  await refresh();
  A.ok(list.innerHTML.includes('repo project') && list.innerHTML.includes('plain project, access revoked'), 'nonempty trusted and revoked overview renders actual accessible rows');
  A.ok(!list.innerHTML.includes('loading projects'), 'successful nonempty response ends loading');
  A.eq(ctx.lastConfirmedProjects.length, 3, 'success retains rendered rows for stale fallback');
  ctx.fetch = async () => { throw Error('offline'); };
  await refresh();
  A.ok(list.innerHTML.includes('showing the last confirmed list') && list.innerHTML.includes('repo project'), 'offline refresh preserves real project rows with stale warning');
  ctx.renderProjectRows = () => { throw Error('renderer failure'); };
  await refresh();
  A.ok(list.innerHTML.includes('Could not display projects') && !list.innerHTML.includes('loading projects'), 'broken cached renderer ends loading without an unhandled rejection');
  ctx.lastConfirmedProjects = null;
  ctx.fetch = async () => ({ ok: true, json: async () => ({ projects: apiProjects }) });
  await refresh();
  A.ok(list.innerHTML.includes('Could not load projects'), 'first render failure has a terminal recovery message');
  A.eq(ctx.lastConfirmedProjects, null, 'failed rendering cannot poison the last rendered snapshot');
  vm.runInContext(A.fnBody(appSrc, 'function renderProjectRows('), ctx);
  await refresh();
  A.ok(list.innerHTML.includes('repo project'), 'later successful refresh recovers without resetting data');
  ctx.fetch = async () => ({ ok: true, json: async () => ({ projects: [] }) });
  await refresh();
  A.ok(list.innerHTML.includes('NO TRUSTED PROJECTS'), 'genuinely empty server ledger still renders its empty state');
}
renderingRegression().then(() => A.report('projects-view.test')).catch(e => { console.error(e); process.exitCode = 1; });

