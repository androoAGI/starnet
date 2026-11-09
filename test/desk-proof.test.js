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
    const notes = [];
    const page = D.makeDeskProof({ now: c.now, randomBytes: rnd, announce: n => notes.push(n) });
    const codeOf = id => { const n = notes.filter(x => x.kind === 'code' && x.id === id).pop(); return n ? n.code : ''; };
    A.eq(page.mode(), 'page', 'no shell token: page mode');
    A.eq(D.makeDeskProof({ desktop: true, ipcToken: '', now: c.now }).mode(), 'page', 'desktop without an IPC token is still page mode (nothing could approve)');
    const ch = page.issue({ action: 'bypass-on', scope: '', title: 'StarNet — turn on FULL BYPASS', summary: 'Turn it on?', verb: 'Turn on' });
    A.ok(D.ID_RE.test(ch.id), 'a challenge id has the issued shape: ' + ch.id);
    A.eq(ch.mode, 'page', 'the challenge says which confirmation it needs');
    A.ok(/^[A-Z0-9]{1,6}$/.test(ch.code), 'the in-page confirm shows a short code: ' + ch.code);
    A.eq(page.consume(ch.id, 'grant', '').ok, false, 'a challenge for another action is refused');
    A.eq(page.consume(ch.id, 'bypass-on', '').reason, 'gone', '…and that burned it: a proof is never tried twice');
    const ch2 = page.issue({ action: 'bypass-on', scope: '' });
    // fix-sec2 review 2: the desk code, shown only where the station's own console is, never in the challenge
    A.ok(D.CODE_RE.test(codeOf(ch2.id)), 'page mode: the station shows a six-digit desk code for each challenge');
    A.eq(ch2.codeWhere, 'station-console', 'the challenge says where to look for it');
    A.ok(!Object.keys(ch2).some(k => ch2[k] === codeOf(ch2.id)) && !('secret' in ch2), 'the challenge never carries the code');
    A.eq(page.consume(ch2.id, 'bypass-on', '').reason, 'code-missing', 'page mode: the id alone no longer passes…');
    const ch2b = page.issue({ action: 'bypass-on', scope: '' });
    A.eq(page.consume(ch2b.id, 'bypass-on', '', codeOf(ch2b.id)).ok, true, '…the id with its desk code does');
    A.eq(page.consume(ch2b.id, 'bypass-on', '', codeOf(ch2b.id)).ok, false, '…once');
    const ch2c = page.issue({ action: 'bypass-on', scope: '' });
    A.eq(page.consume(ch2c.id, 'bypass-on', '', codeOf(ch2b.id)).reason, 'wrong-code', 'another challenge\'s code is wrong');
    A.ok(notes.some(n => n.kind === 'wrong' && n.wrong === 1 && n.label === ch2c.code), 'and the console says a wrong code was typed');
    const ch2d = page.issue({ action: 'bypass-on', scope: '' });
    A.eq(page.consume(ch2d.id, 'bypass-on', '', ' ' + codeOf(ch2d.id).slice(0, 3) + ' ' + codeOf(ch2d.id).slice(3) + ' ').ok, true, 'spaces typed in a code are ignored');
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
    // a guesser: five wrong codes and the station takes no authority change until it restarts
    const notes = [];
    const page = D.makeDeskProof({ now: () => 1, randomBytes: rnd, announce: n => notes.push(n) });
    let last = null;
    for (let i = 0; i < D.MAX_WRONG_CODES; i++) {
      const ch = page.issue({ action: 'grant', scope: 'x' });
      const right = notes.filter(x => x.kind === 'code' && x.id === ch.id).pop().code;
      last = page.consume(ch.id, 'grant', 'x', right === '000000' ? '000001' : '000000');
    }
    A.eq(last.reason, 'locked', 'the fifth wrong code locks the station');
    A.ok(page.locked() && notes.some(n => n.kind === 'locked'), 'locked() says so, and so does the console');
    const after = page.issue({ action: 'grant', scope: 'x' });
    A.ok(after.locked === true && !notes.some(n => n.kind === 'code' && n.id === after.id), 'a locked station shows no more codes');
    A.eq(page.consume(after.id, 'grant', 'x', '123456').reason, 'locked', 'and spends nothing');
    // no console to show a code on: nothing can be confirmed in the page
    const blind = D.makeDeskProof({ now: () => 1, randomBytes: rnd });
    const bc = blind.issue({ action: 'grant', scope: 'x' });
    A.eq(bc.codeWhere, '', 'a station that shows its code nowhere says so');
    A.eq(blind.consume(bc.id, 'grant', 'x', '123456').reason, 'no-code-shown', 'and no code is ever right');
    const failing = D.makeDeskProof({ now: () => 1, randomBytes: rnd, announce: () => { throw new Error('console closed'); } });
    const fc = failing.issue({ action: 'grant', scope: 'x' });
    A.eq(failing.consume(fc.id, 'grant', 'x', '123456').reason, 'no-code-shown', 'a code that could not be shown confirms nothing');
    // a desktop station never shows a code (its confirmation is the shell's dialog)
    const desk = D.makeDeskProof({ desktop: true, ipcToken: 'IPC', now: () => 1, randomBytes: rnd, announce: n => notes.push(n) });
    const n0 = notes.length;
    const dch = desk.issue({ action: 'grant', scope: 'x' });
    A.ok(notes.length === n0 && !('codeWhere' in dch), 'desktop mode shows no desk code');
    A.eq(desk.locked(), false, 'and never locks');
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
  const IN_PROC = Symbol('in-process');   // index.js's IN_PROCESS_REQUEST: a JS property only callOwnRoute sets
  function gateWith(CLIENT_TOKEN, deskProof) {
    return new Function('apiauth', 'API_TOKEN', 'CLIENT_TOKEN', 'deskProof', 'respondFail', 'IN_PROCESS_REQUEST',
      wordsSrc + '\n' + gateSrc + '\nreturn deskGate;')(apiauth, 'API-TOKEN-' + 'x'.repeat(40), CLIENT_TOKEN, deskProof, respond.fail, IN_PROC);
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
    // fix-sec2 review 9: the station's own tools (callOwnRoute, no token) get a challenge to put to the desk, not desk_only…
    res = fakeRes();
    const own = { headers: {} }; own[IN_PROC] = true;
    A.eq(gate(own, res, 'grant', 'fs.write', {}), false, 'an in-process call does not pass on its own');
    A.eq(res.headers['X-StarNet-Code'], 'desk_confirm_required', 'an in-process call is handed a challenge to confirm at the desk');
    const c3 = JSON.parse(res.body).deskConfirm;
    res = fakeRes();
    const own2 = { headers: { 'x-starnet-desk-proof': c3.id } }; own2[IN_PROC] = true;
    A.eq(gate(own2, res, 'grant', 'fs.write', {}), false, 'and it still needs the shell\'s approval');
    // …and nothing a request can carry marks a call as in-process
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': CLIENT, 'in_process_request': 'true', 'starnet.inprocessrequest': '1' } }, res, 'bypass-on', '', {}), false, 'a header never marks a call as in-process');
    A.eq(res.headers['X-StarNet-Code'], 'desk_only', 'the client key stays desk_only');
  }
  {
    const shown = [];
    const proof = D.makeDeskProof({ now: () => 1, randomBytes: rnd, announce: n => shown.push(n) });
    const gate = gateWith('', proof);
    let res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API } }, res, 'remote-pair', '', {}), false, 'browser mode: asked to confirm in the page');
    const c = JSON.parse(res.body).deskConfirm;
    A.eq(c.mode, 'page', 'browser mode: a page challenge');
    const code = shown.filter(n => n.id === c.id).pop().code;
    A.ok(res.body.indexOf(code) < 0 || JSON.parse(res.body).deskConfirm.id.indexOf(code) >= 0, 'the 403 body never carries the desk code');
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API, 'x-starnet-desk-proof': c.id } }, res, 'remote-pair', '', {}), false, 'browser mode: the id alone (two requests with the page token) no longer passes');
    A.ok(/confirmation code/.test(JSON.parse(res.body).error), 'and says the code is needed');
    const c2 = JSON.parse(res.body).deskConfirm;
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API, 'x-starnet-desk-proof': c2.id, 'x-starnet-desk-code': shown.filter(n => n.id === c2.id).pop().code } }, res, 'remote-pair', '', {}), true, 'browser mode: the replay with the code the console showed passes');
    for (let i = 0; i < D.MAX_WRONG_CODES; i++) {
      res = fakeRes(); gate({ headers: { 'x-starnet-token': API } }, res, 'remote-pair', '', {});
      const ci = JSON.parse(res.body).deskConfirm;
      const right = shown.filter(n => n.id === ci.id).pop().code;
      res = fakeRes(); gate({ headers: { 'x-starnet-token': API, 'x-starnet-desk-proof': ci.id, 'x-starnet-desk-code': right === '999999' ? '999998' : '999999' } }, res, 'remote-pair', '', {});
    }
    A.eq(res.headers['X-StarNet-Code'], 'forbidden', 'five wrong codes: refused outright');
    A.ok(JSON.parse(res.body).deskLocked === true && /until it restarts/.test(JSON.parse(res.body).error), 'and the station says it takes no permission change until it restarts');
    res = fakeRes();
    A.eq(gate({ headers: { 'x-starnet-token': API } }, res, 'remote-pair', '', {}), false, 'locked: no new challenge either');
    A.ok(!/deskConfirm/.test(res.body), 'nothing to confirm');
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
  A.ok(/finish\.freshConsent !== true && \(decision === 'always' \|\| decision === 'full' \|\| decision === 'session'\)/.test(A.fnBody(IDX, 'async function handleConsent(')), 'standing answers and for-the-session answers ask (once and deny never do; fix-sec2 review 3)');
  // fix-sec2 review 3, 6, 7: the authority changes the first pass left on the page token alone
  before('async function handleTelegramOwnerPair(', /ownerPairingPass\(req, res, 'telegram-owner-pair'/, /issueTelegramOwnerPairing\(cur, ownerPass\)/, 'a Telegram owner pairing code asks first');
  // review2 #1: every route that can hand out an owner code asks first, before anything is saved or started
  before('async function handleChannelConnect(', /ownerPass = ownerPairingPass\(req, res, 'telegram-owner-pair', '', \{ connecting: true \}\)/, /credStore\.putChannel\('telegram'/, 'connecting the station bot with no owner asks before anything is saved');
  before('async function handleTelegramBotAdd(', /ownerPass = ownerPairingPass\(req, res, 'channel-owner-pair', 'telegram-bot:' \+ botId/, /probeChannelRunConfig\(/, 'adding an agent bot with no owner asks before the provider probe');
  before('async function handleTelegramBotAdd(', /ownerPass = ownerPairingPass\(/, /saveTelegramBotRecord\(botId/, 'and before its record is saved');
  before('async function handleTelegramBotOwner(', /ownerPairingPass\(req, res, 'channel-owner-pair', 'telegram-bot:' \+ botId/, /issueTelegramBotOwnerPairing\(botId, ownerPass\)/, 'an agent bot\'s PAIR asks first');
  before('async function handleDiscordConnect(', /ownerPass = ownerPairingPass\(req, res, 'channel-owner-pair', 'discord'/, /credStore\.putChannel\('discord'/, 'connecting Discord with no owner asks first');
  before('async function handleGenericChannelConnect(', /ownerPass = ownerPairingPass\(req, res, 'channel-owner-pair', id/, /credStore\.putChannel\(id/, 'connecting Slack, Matrix or Signal with no owner asks first');
  before('async function handleChannelOwnerPair(', /ownerPairingPass\(req, res, 'channel-owner-pair', id/, /issueChannelOwnerPairing\(id, ownerPass\)/, 'their PAIR OWNER asks first');
  {
    // the code is made in exactly one place, and that place makes one only for a pass the desk gate handed out, once
    const sites = IDX.split('telegramOwnerPairing.issue(').length - 1;
    A.eq(sites, 1, 'an owner code is made in one place only');
    const mint = A.fnBody(IDX, 'function mintOwnerCode(');
    A.ok(mint.indexOf('telegramOwnerPairing.issue(') > 0, 'and that place is mintOwnerCode');
    const passFn = A.fnBody(IDX, 'function ownerPairingPass(');
    A.ok(/if \(!deskGate\(req, res, action, scope, details\)\) return null;/.test(passFn), 'a pass comes only from the desk gate');
    const lifted = new Function('telegramOwnerPairing', 'deskGate', 'const OWNER_PAIRING_PASS = Symbol("p"); const ownerPassesSpent = new WeakSet();\n' + passFn + '\n' + mint + '\nreturn { ownerPairingPass, mintOwnerCode };');
    let made = 0;
    const tp = { issue: () => ({ code: 'pair-' + (++made), state: {} }) };
    let deskSays = false;
    const L = lifted(tp, () => deskSays);
    A.eq(L.mintOwnerCode(null), null, 'no pass: no code');
    A.eq(L.mintOwnerCode({ ok: true }), null, 'a look-alike pass: no code');
    A.eq(L.ownerPairingPass({}, {}, 'channel-owner-pair', 'slack', {}), null, 'the desk said no: no pass');
    deskSays = true;
    const pass = L.ownerPairingPass({}, {}, 'channel-owner-pair', 'slack', {});
    A.ok(pass && L.mintOwnerCode(pass) && made === 1, 'the desk said yes: one code');
    A.eq(L.mintOwnerCode(pass), null, 'and the same pass makes no second one');
    for (const fn of ['function issueChannelOwnerPairing(', 'function issueTelegramOwnerPairing(', 'function issueTelegramBotOwnerPairing(']) {
      A.ok(/const issued = mintOwnerCode\(pass\);\s*if \(!issued\) return \{ ok: false, error: OWNER_CODE_NEEDS_DESK \};/.test(A.fnBody(IDX, fn)), fn + ' makes a code only with a pass');
    }
    // revoking stays free (it takes power away), and is not followed by any ungated way back to a code
    A.ok(!/mintOwnerCode|OwnerPairing\(/.test(A.fnBody(IDX, 'async function handleTelegramOwnerRevoke(')), 'revoking an owner makes no code');
    A.ok(/'channel-owner-pair'/.test(read('sidecar/deskproof.js')), 'the desk knows the new change');
  }
  // review2 #4: a loop's check is a stored host command, gated like a hook for the exact command and folder
  before('function handleLoopsCreate(', /loopCheckAtDesk\(req, res, workdir, String\(body\.checkCmd\)/, /loopjobStore\.createLoop\(/, 'a loop that carries a check asks first');
  before('function handleLoopsUpdate(', /loopCheckAtDesk\(req, res, nextDir, nextCmd/, /loopjobStore\.updateLoop\(/, 'a changed or moved check asks first; removing one never does');
  before('function handleLoopsTestCheck(', /loopCheckAtDesk\(req, res, root, cmd, \{ now: true \}\)/, /shellRunCommand\(/, 'trying a check (it runs now) asks first');
  A.ok(/if \(held && held\.scope === scope && held\.until > now\) \{ loopCheckApprovals\.delete\(String\(approvalId\)\); return true; \}/.test(A.fnBody(IDX, 'function loopCheckAtDesk(')), 'a try\'s approval covers one create, for the same folder and command');
  A.ok(/'loop-check'/.test(read('sidecar/deskproof.js')), 'the desk knows the loop check');
  {
    const fe = read('frontend/app/windows/loops.js');
    A.ok(/if \(checkApproval && spec\.checkCmd === checkApproval\.cmd && extra\.workdir === checkApproval\.workdir\) spec\.checkApproval = checkApproval\.id;\s*checkApproval = null;/.test(fe), 'the loops window hands the try\'s approval to START once, for the same pair');
  }
  before('async function handleHooksAllow(', /deskGate\(req, res, 'hook-allow', event \+ '\\n' \+ command/, /shellHooks\.allow\(event, command\)/, 'approving a hook asks first, for that exact command');
  before('async function handleHooksCreate(', /deskGate\(req, res, 'hook-allow', event \+ '\\n' \+ hookCommand/, /shellHooks\.create\(/, 'creating (and so approving) a hook asks first');
  before('async function handlePluginsAllow(', /deskGate\(req, res, 'plugin-allow', id \+ '@' \+ digest/, /pluginLoader\.allow\(id, digest\)/, 'approving plugin code asks first, for that exact digest');
  before('async function handleProjectBless(', /deskGate\(req, res, 'project-bless', String\(root\)/, /projectBless\.blessPath\(/, 'trusting a folder asks first (inside blessPath, for the root it resolves to)');
  A.ok(/if \(typeof o\.confirm === 'function' && !\(await o\.confirm\(proposedReal\)\)\)[\s\S]{0,200}const isGit = await isGitRepoOf\(proposedReal\);\s*const ok = await bless\(proposedReal/.test(read('sidecar/projectbless.js')), 'blessPath asks the desk for the real root after every check and before the grant');
  before('function handleCronCreate(', /grants\.length && !deskGate\(req, res, 'routine-grants'/, /createCronJobFromSpec\(body, \{ grantsConfirmed: grants\.length > 0, scriptDigest \}\)/, 'a routine with an unattended grant asks first');
  A.ok(/if \(!\(opts && opts\.grantsConfirmed === true\)\) body = Object\.assign\(\{\}, body, \{ unattendedGrants: \[\] \}\);/.test(A.fnBody(IDX, 'async function createCronJobFromSpec(')), 'every other create path makes a routine with no unattended grant');
  before('function handleCronUpdate(', /if \(confirm\.length\) \{[\s\S]{0,400}deskGate\(req, res, 'routine-grants'/, /await withCronWrite\(jobs => \{\s*const current = cronStore\.getJob\(jobs, id\);/, 'adding a grant to a routine asks first (removing never does)');
  {
    // review2 #2: an edit that changes what a granted routine runs keeps its grants only with the desk's yes for the new routine
    const upd = A.fnBody(IDX, 'function handleCronUpdate(');
    A.ok(/const rewrite = cronStore\.grantsRevokedByEdit\(current, patch\)\.length > 0;[\s\S]{0,200}const stale = cronScriptStale\(current\);\s*const confirm = \(\(rewrite \|\| stale\) && keepGrants\) \? \[\.\.\.wanted\]\.sort\(\) : added;/.test(upd), 'keeping grants through a rewrite (or a changed script file) confirms every grant it keeps');
    A.ok(/const revoked = cronStore\.grantsRevokedByEdit\(current, patch\);[\s\S]{0,400}const keep = base\.filter\(g => revoked\.indexOf\(g\) < 0 \|\| confirmed\.has\(g\)\);/.test(upd), 'under the lock, a rewrite drops every grant the desk did not just confirm');
    A.ok(/routineGrantScope\(spec, confirm\), routineGrantWords\(spec, confirm, rewrite \|\| stale\)/.test(upd), 'the yes is scoped to the routine as it will run, and says it changed');
    const scope = A.fnBody(IDX, 'function routineGrantScope(');
    for (const f of ['prompt', 'script', 'workdir', 'agentId', 'noAgent', 'enabledToolsets', 'skills', 'contextFrom', 'runsLine']) A.ok(scope.indexOf('s.' + f) > 0, 'the desk scope covers ' + f);
    A.ok(/if \(cronStore\.grantsRevokedByEdit\(cronStore\.getJob\(jobs, id\), patch\)\.length\) patch\.unattendedGrants = \[\];/.test(IDX), 'an app\'s schedule save that rewrites the task drops the grants, whoever saves it');
    const fe = read('frontend/app/windows/routines.js');
    A.ok(/holds \? \{ id, patch, keepGrants: true \} : \{ id, patch \}/.test(fe) && /response\.code === 'desk_confirm_required' \|\| response\.code === 'desk_only'/.test(fe), 'the edit form asks to keep a granted routine\'s permissions, and can save without them when the desk says no');
    // review2 #3: the yes is for the script's bytes; a changed file does not run, and the run is handed the recorded digest
    const exec = A.fnBody(IDX, 'async function executeCronScript(');
    A.ok(exec.indexOf('cronScriptStale(job)') > 0 && exec.indexOf('cronScriptStale(job)') < exec.indexOf('cronScriptSpec(job)'), 'a script whose bytes changed is refused before anything runs');
    A.ok(/script: o\.cronScript, scriptDigest: o\.cronScriptDigest \|\| null,/.test(IDX) && /cronScriptDigest: job\.scriptDigest \|\| null,/.test(read('sidecar/cron-driver.js')), 'the scheduled fire and Run Now hand the recorded digest to the script run');
    A.ok(/spec\.scriptDigest = cronScriptDigest\(spec\);\s*if \(!deskGate\(req, res, 'routine-grants'/.test(upd) && /if \(spec\.script\) confirmedDigest = spec\.scriptDigest;/.test(upd), 'ALLOW THIS VERSION is a desk yes for the bytes as they are now, and records them');
    A.ok(/s\.runsLine === true, String\(s\.scriptDigest \|\| ''\)\]/.test(scope), 'the desk scope covers the script bytes');
    A.ok(/body = Object\.assign\(\{\}, body, \{ scriptDigest: \(opts && opts\.grantsConfirmed === true && typeof opts\.scriptDigest === 'string'\) \? opts\.scriptDigest : null \}\);/.test(A.fnBody(IDX, 'async function createCronJobFromSpec(')), 'a create keeps only the station\'s own digest, read at the desk\'s yes');
    A.ok(/workshop: \(call, tool\) => !execution\.taintedBy\(\) && workshopOf\(agentId\),/.test(IDX), 'the away-workshop grant is lifted by taint, as the terminal grant is');
    A.ok(/runsLine: j\.runsLine === true, scriptDigest: typeof j\.scriptDigest === 'string' \? j\.scriptDigest : null \};/.test(A.fnBody(IDX, 'function cronAuthorityParts(')), 'the seal covers the digest and every run field of a granted routine');
  }
  {
    const roster = A.fnBody(IDX, 'async function handleRoster(');
    A.ok(roster.indexOf("deskGate(req, res, 'execution-profile'") > 0 && roster.indexOf("deskGate(req, res, 'execution-profile'") < roster.indexOf('replaceAgentRoster(incomingRows)'), 'a wider execution profile asks first');
    A.ok(/profileClamped = widened;[\s\S]{0,300}executionProfile: \(previousRoster\.get\(String\(a\.agentId\)\) \|\| \{\}\)\.executionProfile \|\| 'station-gear'/.test(roster), 'a push that does not ask keeps the profile the station holds');
    const approval = A.fnBody(IDX, 'async function handleAgentApproval(');
    A.ok(approval.indexOf('relayedRaiseTimes.length >= RELAYED_RAISE_MAX') > 0 && approval.indexOf('relayedRaiseTimes.length >= RELAYED_RAISE_MAX') < approval.indexOf("stationBridge.request('station.control', { action: 'agent.approval'"), 'a Full Access raise relayed to the window is rate limited before the window is asked');
    // channelResolveConsent, lifted and run: a chat never gives a standing answer
    const crc = A.fnBody(IDX, 'function channelResolveConsent(');
    const got = [];
    const resolve = new Function('channelPendingByRun', crc + '\nreturn channelResolveConsent;')(new Map([['r', new Map([['p', d => got.push(d)]])]]));
    for (const d of ['always', 'full', 'session', 'once', 'nonsense']) resolve('r', 'p', d);
    A.eq(got, ['once', 'once', 'session', 'once', 'deny'], 'a chat\'s ALWAYS or FULL ACCESS is taken as once (fix-sec2 F3)');
    A.ok(!/Always allow/.test(read('sidecar/channels/hub.js')), 'and the chat keyboard no longer offers it');
  }
  {
    const acp = read('sidecar/acp/core.js');
    A.ok(/if \(decision !== 'session' \|\| !r \|\| r\.status !== 403[\s\S]{0,300}decision: 'once' \}\)/.test(acp), 'an editor\'s "for this session" that meets the desk is allowed once');
    const sc = read('bin/lib/station-commands.js');
    A.ok(/if \(decision === 'session' && deskRefused\(r\)\)[\s\S]{0,700}decision: 'once', via: 'terminal'/.test(sc), '`starnet allow --session` that meets the desk is allowed once, and says so');
    const dash = read('bin/lib/dashboard.js');
    A.ok(/if \(deskRefusal\(r\)\) \{[\s\S]{0,400}'\/api\/projects\/bless', \{ path: t\.root \}, \{ timeoutMs: 10000, deskProof: ch\.id, deskCode: code \}/.test(dash), 'the terminal\'s TRUST THIS FOLDER confirms with its own station\'s code, else points at the window');
    const app = read('frontend/app/app.js');
    A.ok(/raiseProfile\.length \? \{ raiseProfile \} : \{\}/.test(app) && /pendingProfileRaise\.add\(a\.id\)/.test(app), 'the dossier\'s profile picker asks for a wider profile by name');
  }
  before('async function handleRoster(', /deskGate\(req, res, 'approval-full'/, /replaceAgentRoster\(incomingRows\)/, 'a roster raise asks first');
  A.ok(/clamped = raised;[\s\S]{0,200}approvalMode: 'ask'/.test(A.fnBody(IDX, 'async function handleRoster(')), 'a roster push that does not ask for a raise keeps those agents ask-first');
  before('async function handleAgentApproval(', /mode === 'full' && cur\.approvalMode !== 'full' && !deskGate\(req, res, 'approval-full'/, /agentRoster\.set\(agentId, Object\.assign\(\{\}, cur, \{ approvalMode: mode \}\)\)/, '/yolo with no page asks first');
  before('async function handleRemoteEnable(', /if \(on && !remoteDevices\.enabled\(\) && !deskGate\(req, res, 'remote-enable'/, /remoteDevices\.setEnabled\(on\)/, 'Remote on asks first; off never asks');
  before('async function handleRemotePair(', /deskGate\(req, res, 'remote-pair'/, /remoteDevices\.startPairing\(/, 'a pairing code asks first');
  before('async function handleRemoteDevice(', /deskGate\(req, res, 'device-desk-permissions'/, /remoteDevices\.setAskFirst\(/, 'a phone on the desk\'s permissions asks first');
  // GHSA-2hpj #7: a newly paired phone is approved at the desk, which shows its name and fingerprint
  before('async function handleRemoteActivate(', /devRow\.pending === true && !deskGate\(req, res, 'device-activate', devRow\.id, \{ name: devRow\.name, fingerprint: devRow\.fingerprint \}\)/, /remoteDevices\.activate\(devRow\.id\)/, 'approving a new phone asks at the desk first');
  A.ok(IDX.includes("{ m: 'POST', exact: '/api/remote/activate', h: handleRemoteActivate }"), 'the approve route is registered');
  {
    const panel = read('frontend/app/remote-devices.js');
    A.ok(/data-approve=/.test(panel) && /api\('\/api\/remote\/activate', \{ deviceId: id \}\)/.test(panel) && /WAITING FOR YOUR APPROVAL/.test(panel), 'the REMOTE panel shows a pending phone with an APPROVE button');
  }
  before('async function handleConfigImport(', /deskGate\(req, res, 'grant-import'/, /applyBudgetCaps\(\)|want\('budget'\)/, 'a backup that adds grants asks before any section applies');

  // ---- 4. the keys and the shell ----
  const serve = A.fnBody(IDX, 'async function serveStatic(');
  A.ok(/'window\.__STARNET_API_TOKEN__=' \+ JSON\.stringify\(CLIENT_TOKEN \|\| API_TOKEN\)/.test(serve), 'GET / serves CLIENT_TOKEN under the desktop shell (API_TOKEN only for a bare station)');
  A.ok(/const DESK_SHELL_PROOF = DESKTOP_SHELL && !!IPC_TOKEN\.trim\(\)/.test(IDX) && /const CLIENT_TOKEN = DESK_SHELL_PROOF \? crypto\.randomBytes\(32\)/.test(IDX), 'a client key exists exactly when the shell can confirm');
  // fix-sec2 review 1: the per-launch secrets are read once and leave process.env before anything else can snapshot it
  {
    const at = IDX.indexOf("const IPC_TOKEN = String(ENV('IPC_TOKEN') || '');");
    const del = IDX.indexOf("for (const k of ['STARNET_API_TOKEN', 'SKYNET_API_TOKEN', 'STARNET_IPC_TOKEN', 'SKYNET_IPC_TOKEN']) delete process.env[k];");
    A.ok(at > 0 && del > at && del - at < 200 && IDX.indexOf('const API_TOKEN = String(ENV(\'API_TOKEN\')') < at, 'the page token and the IPC token are read, then deleted from process.env');
    const idxOnly = read('sidecar/index.js');
    A.eq((idxOnly.match(/ENV\('IPC_TOKEN'\)|ENV\('API_TOKEN'\)/g) || []).length, 2, 'nothing reads them from the environment again');
    // the same three lines, run: the variables are gone and the values kept
    const env = { STARNET_API_TOKEN: 'a', SKYNET_IPC_TOKEN: 'i', OTHER: 'o' };
    const from = idxOnly.indexOf("const API_TOKEN = String(ENV('API_TOKEN')");
    const to = idxOnly.indexOf('\n', idxOnly.indexOf("for (const k of ['STARNET_API_TOKEN'")) + 1;
    const run = new Function('process', 'crypto', "function ENV(suffix) { const k = 'STARNET_' + suffix; return (k in process.env) ? process.env[k] : process.env['SKYNET_' + suffix]; }\n" +
      idxOnly.slice(from, to) + '\nreturn [API_TOKEN, IPC_TOKEN];');
    A.eq(run({ env }, require('crypto')), ['a', 'i'], 'the values are kept');
    A.eq(Object.keys(env), ['OTHER'], 'and the variables are gone');
  }
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
    let asked = 0, said = '';
    const dc = make({ desktop: false, invoke: null, win: { confirm: () => { asked++; return true; }, prompt: (m) => { asked++; said = m; return ' 123 456 '; } } });
    const res = challengeRes(DESK);
    A.ok(await dc.settle(res, () => Promise.resolve(new Response('x'))) === res && asked === 0, 'a desktop challenge is never confirmed in-page');
    const PAGE = Object.assign({}, DESK, { mode: 'page', codeWhere: 'station-console' });
    const out = await dc.settle(challengeRes(PAGE), (id, code) => Promise.resolve(new Response('ok:' + id + ':' + code)));
    A.eq(await out.text(), 'ok:' + DESK.id + ':123456', 'browser mode: the page asks for the desk code and replays with the proof and the code');
    A.eq(asked, 1, 'asked once');
    A.ok(/6-digit code the station printed in the terminal/.test(said) && said.indexOf(DESK.code) >= 0, 'naming where the code is and which confirmation it is for');
    const noCode = make({ desktop: false, invoke: null, win: { prompt: () => 'abc' } });
    const r2 = challengeRes(PAGE);
    A.ok(await noCode.settle(r2, () => { throw new Error('must not replay'); }) === r2, 'no six digits typed: nothing is replayed');
    let asked2 = 0;
    const blind = make({ desktop: false, invoke: null, win: { prompt: () => { asked2++; return '123456'; } } });
    const r3 = challengeRes(Object.assign({}, PAGE, { codeWhere: '' }));
    A.ok(await blind.settle(r3, () => { throw new Error('must not replay'); }) === r3 && asked2 === 0, 'a station that shows its code nowhere is not asked for one');
  }
  {
    const dc = make({ desktop: true, invoke: () => Promise.resolve(), win: null });
    const other = new Response('forbidden', { status: 403, headers: { 'X-StarNet-Code': 'forbidden' } });
    A.ok(await dc.settle(other, () => Promise.resolve(new Response('x'))) === other, 'any other 403 passes through');
    const res = challengeRes(DESK);
    A.ok(await dc.settle(res, null) === res, 'an unreplayable body is never confirmed (nothing to replay)');
  }
  A.ok(/\.then\(res => deskConfirm\.settle\(res, \(replayable && deskAgain != null\) \? \(id, code\) => rawFetch\(deskAgain, withApiToken\(withDeskProof\(init, id, code\), apiToken \|\| t\)\) : null\)\)\);/.test(harness),
    'the hardened fetch routes every /api answer through the desk confirmation, replaying with the proof and the current key');

  // blessPath with a desk that says no grants nothing; a yes is asked for the root that is granted
  {
    const { makeProjectBless } = require('../sidecar/projectbless.js');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bless-desk-'));
    const granted = [], asked = [];
    const pb = makeProjectBless({ fsp: fs.promises, pathMod: path, detectRoot: async p => p, normalizeRoot: p => path.resolve(p),
      hardlineReason: () => null, bless: async (root) => { granted.push(root); return true; }, isGitRepoOf: async () => false, now: () => 1 });
    const no = await pb.blessPath({ path: dir, surface: 'interactive', confirm: root => { asked.push(root); return false; } });
    A.ok(no.ok === false && no.code === 'unconfirmed' && granted.length === 0, 'a folder the desk did not confirm is not trusted');
    const yes = await pb.blessPath({ path: dir, surface: 'interactive', confirm: async root => { asked.push(root); return true; } });
    A.ok(yes.ok === true && granted.length === 1 && asked[1] === granted[0], 'a confirmed folder is trusted, and the desk was shown the root that was granted');
    try { fs.rmdirSync(dir); } catch (_) { /* a temp folder left behind is harmless */ }
  }

  // ---- 6. where a bare station shows its desk code (fix-sec2, review 2) ----
  {
    const aStart = IDX.indexOf('const DESK_CODE_TO_PARENT = ');
    const aEnd = IDX.indexOf('const deskProofMod = require(');
    A.ok(aStart > 0 && aEnd > aStart, 'index.js defines announceDeskCode');
    const lift = (toParent, proc) => new Function('ENV', 'process', IDX.slice(aStart, aEnd) + '\nreturn announceDeskCode;')(k => (k === 'DESK_CODE_IPC' && toParent ? '1' : ''), proc);
    const note = { kind: 'code', id: 'dc_' + 'q'.repeat(20), label: 'QQQQQQ', title: 'StarNet — turn on FULL BYPASS', verb: 'Turn on', code: '424242', expiresAt: 9 };
    const err = [], sent = [];
    lift(false, { stderr: { write: s => err.push(s) }, send: m => sent.push(m), connected: true })(note);
    A.ok(err.length === 1 && /Type code 424242 in the StarNet page that asks for confirmation QQQQQQ/.test(err[0]) && /turn on FULL BYPASS/.test(err[0]) && sent.length === 0, 'a bare station prints the code, the change and its label on its own console');
    A.ok(/Never type it anywhere else or give it to an agent/.test(err[0]), 'and warns it is for the page only');
    const err2 = [], sent2 = [];
    lift(true, { stderr: { write: s => err2.push(s) }, send: m => sent2.push(m), connected: true })(note);
    A.ok(err2.length === 0 && sent2.length === 1 && sent2[0].type === 'starnet.desk-code' && sent2[0].id === note.id && sent2[0].code === '424242', 'a station the terminal started sends it over the IPC channel only');
    const err3 = [];
    lift(true, { stderr: { write: s => err3.push(s) }, connected: false })(note);
    A.eq(err3.length, 1, 'no channel: the console');
    A.ok(/announce: DESKTOP_SHELL \? null : announceDeskCode/.test(IDX), 'under the desktop shell (its console is a log file) no code is ever shown');
    A.ok(/deskProof\.consume\(presented, action, scope, req\.headers\['x-starnet-desk-code'\]\)/.test(IDX), 'deskGate spends the proof with the typed code');
    A.ok(/X-StarNet-Desk-Proof,X-StarNet-Desk-Code/.test(A.fnBody(IDX, 'function applyApiCors(')), 'CORS lets the code header through');
    // the `starnet` terminal's side
    const cli = require('../bin/starnet.js');
    const cliSrc = read('bin/starnet.js');
    A.ok(/STARNET_DESK_CODE_IPC: '1'/.test(cliSrc) && /child\.on\('message', m => \{ book\.take\(m\); \}\);/.test(cliSrc) && /client\.deskCodeFor = book\.codeFor;/.test(cliSrc), 'a station the terminal spawns sends its codes to that terminal\'s book');
    A.ok(/if \(o\.deskProof && o\.deskCode\) headers\['x-starnet-desk-code'\] = String\(o\.deskCode\);/.test(cliSrc), 'the terminal\'s replay carries the code');
    let t = 0;
    const timers = [];
    const book = cli.makeDeskCodeBook({ now: () => t, setTimeout: (fn, ms) => { timers.push({ fn, at: t + ms }); } });
    const run = () => { const due = timers.filter(x => x.at <= t); for (const x of due) { timers.splice(timers.indexOf(x), 1); x.fn(); } };
    const ask = (id, w) => { const pr = book.codeFor(id, w); run(); return pr; };
    const shownNotes = [];
    book.onNote((text, kind) => shownNotes.push([kind, text]));
    A.eq(book.take({ type: 'other' }), false, 'other IPC messages are not the book\'s');
    book.take({ type: 'starnet.desk-code', kind: 'code', id: 'dc_A', code: '111111', expiresAt: 100, text: 'Type code 111111' });
    A.eq(await book.codeFor('dc_A'), '111111', 'the dashboard gets the code of its own challenge');
    A.eq(await ask('dc_A', 0), '', 'once');
    t = 2000; run();
    A.eq(shownNotes.length, 0, 'a code the dashboard used is not shown');
    const late = book.codeFor('dc_B', 2000);
    book.take({ type: 'starnet.desk-code', kind: 'code', id: 'dc_B', code: '222222', expiresAt: 9000, text: 'B' });
    A.eq(await late, '222222', 'a note that arrives after the HTTP answer is waited for');
    const never = book.codeFor('dc_C', 500);
    t = 2600; run();
    A.eq(await never, '', 'no note in time: no code');
    book.take({ type: 'starnet.desk-code', kind: 'code', id: 'dc_D', code: '333333', expiresAt: 9000, text: 'Type code 333333 in the page' });
    t = 4200; run();
    A.ok(shownNotes.some(([k, x]) => k === 'code' && /333333/.test(x)), 'a code nobody here claimed is shown to the person, for a page that asks');
    book.take({ type: 'starnet.desk-code', kind: 'wrong', text: 'A wrong confirmation code was typed' });
    A.ok(shownNotes.some(([k]) => k === 'wrong'), 'a wrong-code note is shown at once');
    book.take({ type: 'starnet.desk-code', kind: 'code', id: 'dc_E', code: '12345', text: 'x' });
    A.eq(await ask('dc_E', 0), '', 'a malformed code is never kept');
    t = 20000;
    book.take({ type: 'starnet.desk-code', kind: 'code', id: 'dc_F', code: '444444', expiresAt: 19000, text: 'x' });
    A.eq(await ask('dc_F', 0), '', 'an expired code is never used');
    // the dashboard
    const dash = read('bin/lib/dashboard.js');
    A.ok(/await client\.deskCodeFor\(ch\.id\) : '';\s*if \(code\) r = await client\.request\('POST', '\/api\/consent'/.test(dash), 'ALWAYS from the terminal carries its own station\'s code');
    A.ok(/deskProof: held\.id, deskCode: typed/.test(dash) && /type \/yolo on <code> with the 6-digit code the station printed/.test(dash), 'a station started elsewhere: /yolo on <code> with the code its console printed');
    A.ok(/client\.onDeskNote\(\(text, kind\) => sayHere\('desk', \[text\]/.test(dash), 'the dashboard shows the codes its station sends');
  }

  A.report();
})().catch(e => { console.error(e); process.exit(1); });
