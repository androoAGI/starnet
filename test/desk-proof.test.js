/* node test/desk-proof.test.js — THE DESK PROOF (GHSA-2hpj-9wm7-rvg5 #1, 2026-11-08).

   The page token alone used to make every AUTHORITY change: FULL BYPASS on, a FULL ACCESS / ALWAYS answer, a standing
   grant, raising an agent to full access, Remote on, a pairing code, letting a phone use the desk's permissions. Any local
   process that read GET / — a command an agent ran included — held that token. This locks the fix:
     1. sidecar/deskproof.js: a challenge is single use, bound to one action + scope, short-lived; in desktop mode only the
        shell's IPC-token approval of the EXACT words it was issued with makes it good;
     2. index.js deskGate (lifted and run): the served page's CLIENT_TOKEN is refused outright (desk_only), the app page
        gets a challenge (desk_confirm_required), and a good proof passes once;
     3. every authority route asks deskGate BEFORE it changes anything, and lowering power never asks;
     4. GET / serves CLIENT_TOKEN under the desktop shell, /api/desk/approve is IPC-guarded, CORS lets the proof through,
        and the shell registers a native-dialog command that reports to that route;
     5. the page's fetch wrapper (harness.js deskConfirmation, lifted and run) confirms once and replays with the proof,
        hands a "no" back untouched, and never replays a desktop challenge without the shell. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const D = require('../sidecar/deskproof.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { readSidecarSource } = require('./helpers/source.js');
const IDX = readSidecarSource();   // index.js first, then every sidecar module (test/helpers/source.js)

function clockAt(t) { const c = { t }; c.now = () => c.t; return c; }
let seq = 0;
const rnd = n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (seq * 31 + i * 7) & 0xff; seq++; return b; };

(async () => {
  // ---- 1. the module ----
  {
    const c = clockAt(1000);
    const page = D.makeDeskProof({ now: c.now, randomBytes: rnd });
    A.eq(page.mode(), 'page', 'no shell token: page mode');
    A.eq(D.makeDeskProof({ desktop: true, ipcToken: '', now: c.now }).mode(), 'page', 'desktop without an IPC token is still page mode (nothing could approve)');
    const ch = page.issue({ action: 'bypass-on', scope: '', title: 'StarNet — turn on FULL BYPASS', summary: 'Turn it on?', verb: 'Turn on' });
    A.ok(D.ID_RE.test(ch.id), 'a challenge id has the issued shape: ' + ch.id);
    A.eq(ch.mode, 'page', 'the challenge says which confirmation it needs');
    A.ok(/^[A-Z0-9]{1,6}$/.test(ch.code), 'the in-page confirm shows a short code: ' + ch.code);
    A.eq(page.consume(ch.id, 'grant', '').ok, false, 'a challenge for another action is refused');
    A.eq(page.consume(ch.id, 'bypass-on', '').reason, 'gone', '…and that burned it: a proof is never tried twice');
    const ch2 = page.issue({ action: 'bypass-on', scope: '' });
    A.eq(page.consume(ch2.id, 'bypass-on', '').ok, true, 'page mode: a fresh, matching challenge passes');
    A.eq(page.consume(ch2.id, 'bypass-on', '').ok, false, '…once');
    const ch3 = page.issue({ action: 'grant', scope: 'cabinet:write' });
    c.t += D.TTL_MS + 1;
    A.eq(page.consume(ch3.id, 'grant', 'cabinet:write').reason, 'gone', 'an expired challenge is gone');
    A.eq(page.consume('', 'grant', '').reason, 'missing', 'no proof is no proof');
    A.eq(page.consume('dc_short', 'grant', '').reason, 'bad-id', 'a malformed proof is refused');
    A.throws(() => page.issue({ action: 'anything-else' }), 'an unknown action cannot be issued');
    A.eq(page.approve({ id: ch2.id }, 'x').reason, 'no-desktop', 'page mode has no shell approval route');
    for (let i = 0; i < D.MAX_OPEN + 10; i++) page.issue({ action: 'remote-pair' });
    A.ok(page._open.size <= D.MAX_OPEN, 'a flood of challenges evicts the oldest, never grows memory');
  }
  {
    const c = clockAt(5000);
    const desk = D.makeDeskProof({ desktop: true, ipcToken: 'IPC-SECRET', now: c.now, randomBytes: rnd });
    A.eq(desk.mode(), 'desktop', 'desktop shell with its IPC token: desktop mode');
    const words = { title: 'StarNet — give Full Access', summary: 'Give "Ada" FULL ACCESS?', verb: 'Give Full Access' };
    const ch = desk.issue(Object.assign({ action: 'approval-full', scope: 'ada' }, words));
    A.eq(desk.consume(ch.id, 'approval-full', 'ada').reason, 'not-approved', 'desktop: the page token alone cannot spend a challenge');
    const ch2 = desk.issue(Object.assign({ action: 'approval-full', scope: 'ada' }, words));
    A.eq(desk.approve(Object.assign({ id: ch2.id }, words), 'wrong').reason, 'forbidden', 'only the IPC token approves');
    A.eq(desk.approve(Object.assign({ id: ch2.id }, words, { summary: 'Open a file?' }), 'IPC-SECRET').reason, 'words-differ', 'an approval of OTHER words is refused…');
    A.eq(desk.approve(Object.assign({ id: ch2.id }, words), 'IPC-SECRET').reason, 'gone', '…and burns the challenge');
    const ch3 = desk.issue(Object.assign({ action: 'approval-full', scope: 'ada' }, words));
    A.eq(desk.approve(Object.assign({ id: ch3.id }, words), 'IPC-SECRET').ok, true, 'the shell approves the exact words it showed');
    A.eq(desk.consume(ch3.id, 'approval-full', 'bob').reason, 'mismatch', 'an approved challenge is still bound to its scope');
    const ch4 = desk.issue(Object.assign({ action: 'approval-full', scope: 'ada' }, words));
    desk.approve(Object.assign({ id: ch4.id }, words), 'IPC-SECRET');
    A.eq(desk.consume(ch4.id, 'approval-full', 'ada').ok, true, 'approved + same action + same scope: passes once');
  }
  {
    const w = D.cleanWords('a\u0007b\r\nc‮d\n\n\n\ne', 100);
    A.eq(w, 'a b\nc d\n\ne', 'dialog words carry no control or bidi characters, only line breaks');
    A.ok(D.cleanWords('x'.repeat(500), 40).length <= 40, 'dialog words are capped');
  }

  // ---- 2. deskGate, lifted from index.js and run ----
  const gateSrc = A.fnBody(IDX, 'function deskGate(');
  const wordsSrc = A.fnBody(IDX, 'function deskWords(');
  A.ok(gateSrc.length > 100 && wordsSrc.length > 100, 'index.js defines deskGate and deskWords');
  const respond = require('../sidecar/respond.js');
  const apiauth = require('../sidecar/apiauth.js');
  function fakeRes() {
    const r = { status: 0, headers: {}, body: '', headersSent: false };
    r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); r.headersSent = true; };
    r.end = b => { r.body = String(b || ''); };
    return r;
  }
  function gateWith(CLIENT_TOKEN, deskProof) {
    return new Function('apiauth', 'API_TOKEN', 'CLIENT_TOKEN', 'deskProof', 'respondFail',
      wordsSrc + '\n' + gateSrc + '\nreturn deskGate;')(apiauth, 'API-TOKEN-' + 'x'.repeat(40), CLIENT_TOKEN, deskProof, respond.fail);
  }
  const API = 'API-TOKEN-' + 'x'.repeat(40), CLIENT = 'CLIENT-TOKEN-' + 'y'.repeat(40);
  {
    const proof = D.makeDeskProof({ desktop: true, ipcToken: 'IPC', now: () => 1, randomBytes: rnd });
    const gate = gateWith(CLIENT, proof);
    let res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': CLIENT } }, res, 'bypass-on', '', {}), false, 'the served page\'s client key never passes');
    A.eq(res.status, 403, 'client key: 403');
    A.eq(res.headers['X-StarNet-Code'], 'desk_only', 'client key: desk_only');
    A.ok(!/deskConfirm/.test(res.body), 'client key: no challenge is ever handed out');
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API } }, res, 'bypass-on', '', {}), false, 'the app page with no proof does not pass…');
    A.eq(res.headers['X-StarNet-Code'], 'desk_confirm_required', '…it is asked to confirm');
    const body = JSON.parse(res.body);
    A.ok(body.deskConfirm && body.deskConfirm.mode === 'desktop' && /FULL BYPASS/.test(body.deskConfirm.summary), 'the challenge carries the station\'s own words');
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API, 'x-starnet-desk-proof': body.deskConfirm.id } }, res, 'bypass-on', '', {}), false, 'desktop: an unapproved challenge does not pass');
    res = fakeRes();
    gate({ headers: { 'x-starnet-token': API } }, res, 'bypass-on', '', {});
    const c2 = JSON.parse(res.body).deskConfirm;
    A.eq(proof.approve({ id: c2.id, title: c2.title, summary: c2.summary, verb: c2.verb }, 'IPC').ok, true, 'the shell approves it');
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API, 'x-starnet-desk-proof': c2.id } }, res, 'bypass-on', '', {}), true, 'approved: the change passes');
    A.eq(res.status, 0, 'and the gate wrote nothing');
  }
  {
    const proof = D.makeDeskProof({ now: () => 1, randomBytes: rnd });
    const gate = gateWith('', proof);
    let res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API } }, res, 'remote-pair', '', {}), false, 'browser mode: asked to confirm in the page');
    const c = JSON.parse(res.body).deskConfirm;
    A.eq(c.mode, 'page', 'browser mode: a page challenge');
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API, 'x-starnet-desk-proof': c.id } }, res, 'remote-pair', '', {}), true, 'browser mode: the confirmed replay passes');
  }

  // ---- 3. every authority route asks before it changes anything ----
  const before = (fn, gateRe, effectRe, msg) => {
    const src = A.fnBody(IDX, fn);
    const g = src.search(gateRe), e = src.search(effectRe);
    A.ok(src.length > 0 && g > 0 && e > 0 && g < e, msg + ' (' + fn + ')');
  };
  before('async function handlePermissionsBypass(', /if \(want && !masterBypassOn\(\) && !deskGate\(req, res, 'bypass-on'/, /setMasterBypass\(want\)/, 'FULL BYPASS on asks first; off never asks');
  before('async function handlePermissionsGrant(', /deskGate\(req, res, 'grant', grantKey/, /grantManager\.grant\(/, 'a new standing grant asks first');
  before('async function handleConsent(', /deskGate\(req, res, 'consent-' \+ decision/, /persistAgentFullAccess\(agentId\)/, 'FULL ACCESS / ALWAYS answers ask before anything resolves');
  A.ok(/finish\.freshConsent !== true && \(decision === 'always' \|\| decision === 'full'\)/.test(A.fnBody(IDX, 'async function handleConsent(')), 'only standing answers ask (once/session/deny never do)');
  before('async function handleRoster(', /deskGate\(req, res, 'approval-full'/, /replaceAgentRoster\(incomingRows\)/, 'a roster raise asks first');
  A.ok(/clamped = raised;[\s\S]{0,200}approvalMode: 'ask'/.test(A.fnBody(IDX, 'async function handleRoster(')), 'a roster push that does not ask for a raise keeps those agents ask-first');
  before('async function handleAgentApproval(', /mode === 'full' && cur\.approvalMode !== 'full' && !deskGate\(req, res, 'approval-full'/, /agentRoster\.set\(agentId, Object\.assign\(\{\}, cur, \{ approvalMode: mode \}\)\)/, '/yolo with no page asks first');
  before('async function handleRemoteEnable(', /if \(on && !remoteDevices\.enabled\(\) && !deskGate\(req, res, 'remote-enable'/, /remoteDevices\.setEnabled\(on\)/, 'Remote on asks first; off never asks');
  before('async function handleRemotePair(', /deskGate\(req, res, 'remote-pair'/, /remoteDevices\.startPairing\(/, 'a pairing code asks first');
  before('async function handleRemoteDevice(', /deskGate\(req, res, 'device-desk-permissions'/, /remoteDevices\.setAskFirst\(/, 'a phone on the desk\'s permissions asks first');
  before('async function handleConfigImport(', /deskGate\(req, res, 'grant-import'/, /applyBudgetCaps\(\)|want\('budget'\)/, 'a backup that adds grants asks before any section applies');

  // ---- 4. the keys and the shell ----
  const serve = A.fnBody(IDX, 'async function serveStatic(');
  A.ok(/'window\.__STARNET_API_TOKEN__=' \+ JSON\.stringify\(CLIENT_TOKEN \|\| API_TOKEN\)/.test(serve), 'GET / serves CLIENT_TOKEN under the desktop shell (API_TOKEN only for a bare station)');
  A.ok(/const DESK_SHELL_PROOF = DESKTOP_SHELL && !!String\(ENV\('IPC_TOKEN'\)/.test(IDX) && /const CLIENT_TOKEN = DESK_SHELL_PROOF \? crypto\.randomBytes\(32\)/.test(IDX), 'a client key exists exactly when the shell can confirm');
  A.ok(/!stationTokenOk\(req\) && !stationTicketOk\(req\)\) return refuseAtGate/.test(IDX), 'the gate takes either key (no route lost its key)');
  A.eq(apiauth.requiresApiToken({ method: 'POST', url: '/api/desk/approve', headers: {} }), false, '/api/desk/approve is page-token exempt…');
  A.ok(/async function handleDeskApprove\(req, res\) \{\s*if \(!ipcTokenOk\(req\)\)/.test(IDX), '…and guarded by the IPC token');
  A.ok(/X-StarNet-Desk-Proof/.test(A.fnBody(IDX, 'function applyApiCors(')), 'the desktop page\'s cross-origin replay may carry the proof header');
  A.eq(respond.CODES.desk_confirm_required, 403, 'desk_confirm_required is a named 403');
  A.eq(respond.CODES.desk_only, 403, 'desk_only is a named 403');
  const rs = read('src-tauri/src/main.rs');
  const cmd = A.fnBody(rs, 'async fn starnet_desk_confirm(');
  A.ok(/desk_confirm_words_ok\(&id, &title, &summary, &verb\)\?;\s*if !confirm_host_launch\(&app, &title, &summary, &verb\)/.test(cmd), 'the shell checks the words, then shows them in its blocking native dialog');
  A.ok(/post_sidecar_json\(&state, "\/api\/desk\/approve"/.test(cmd), '…and only then reports the yes with its IPC token');
  A.ok(/starnet_reveal_path,\s*starnet_desk_confirm,/.test(rs), 'the command is registered');

  // ---- 5. the page's fetch wrapper ----
  const harness = read('frontend/app/harness.js');
  const dcSrc = A.fnBody(harness, 'function deskConfirmation(');
  A.ok(dcSrc.length > 200, 'harness.js defines deskConfirmation');
  const make = o => new Function(dcSrc + '\nreturn deskConfirmation;')()(o);
  const challengeRes = (ch) => new Response(JSON.stringify({ ok: false, code: 'desk_confirm_required', error: 'confirm', deskConfirm: ch }), { status: 403, headers: { 'X-StarNet-Code': 'desk_confirm_required', 'Content-Type': 'application/json' } });
  const DESK = { id: 'dc_' + 'a'.repeat(24), mode: 'desktop', title: 'T', summary: 'S', verb: 'V', code: 'AAAAAA' };
  {
    const calls = [];
    const dc = make({ desktop: true, invoke: (c, a) => { calls.push([c, a]); return Promise.resolve(); }, win: null });
    const out = await dc.settle(challengeRes(DESK), id => Promise.resolve(new Response('replayed:' + id)));
    A.eq(await out.text(), 'replayed:' + DESK.id, 'desktop: confirmed in the shell, replayed once with the proof');
    A.eq(calls, [['starnet_desk_confirm', { id: DESK.id, title: 'T', summary: 'S', verb: 'V' }]], 'the shell gets the station\'s own words');
  }
  {
    const dc = make({ desktop: true, invoke: () => Promise.reject(new Error('declined at the host confirmation')), win: null });
    const res = challengeRes(DESK);
    const out = await dc.settle(res, () => { throw new Error('must not replay'); });
    A.ok(out === res && (await out.json()).code === 'desk_confirm_required', 'a "no" in the shell hands the refusal back untouched');
  }
  {
    let asked = 0;
    const dc = make({ desktop: false, invoke: null, win: { confirm: () => { asked++; return true; } } });
    const res = challengeRes(DESK);
    A.ok(await dc.settle(res, () => Promise.resolve(new Response('x'))) === res && asked === 0, 'a desktop challenge is never confirmed in-page');
    const out = await dc.settle(challengeRes(Object.assign({}, DESK, { mode: 'page' })), id => Promise.resolve(new Response('ok:' + id)));
    A.eq(await out.text(), 'ok:' + DESK.id, 'browser mode: the in-page confirm replays with the proof');
    A.eq(asked, 1, 'asked once');
  }
  {
    const dc = make({ desktop: true, invoke: () => Promise.resolve(), win: null });
    const other = new Response('forbidden', { status: 403, headers: { 'X-StarNet-Code': 'forbidden' } });
    A.ok(await dc.settle(other, () => Promise.resolve(new Response('x'))) === other, 'any other 403 passes through');
    const res = challengeRes(DESK);
    A.ok(await dc.settle(res, null) === res, 'an unreplayable body is never confirmed (nothing to replay)');
  }
  A.ok(/\.then\(res => deskConfirm\.settle\(res, \(replayable && deskAgain != null\) \? id => rawFetch\(deskAgain, withApiToken\(withDeskProof\(init, id\), apiToken \|\| t\)\) : null\)\)\);/.test(harness),
    'the hardened fetch routes every /api answer through the desk confirmation, replaying with the proof and the current key');

  A.report();
})().catch(e => { console.error(e); process.exit(1); });
