/* node test/route-authority.census.test.js — every MUTATING station route, classified by what it does to authority
   (review-sec2-1108 item 7, fix-sec2-1108 round 3).

   The station key (or the page's client key) reaches every route below. Anything that RAISES what an agent, a chat, a
   routine or a remote device may do must also carry the desk proof (sidecar/deskproof.js): a person at this computer said
   yes. This census reads the route table from the source (test/helpers/route-table.js) and holds each mutating route to
   one class:

     desk      raises authority and asks the desk first. The handler's body (or the `via` handler an inline entry calls)
               must call the desk proof (deskGate / ownerPairingPass / loopCheckAtDesk / blessPath / deskApproved).
     lowering  takes authority away, stops something or forgets something. Never asks.
     neutral   adds no authority: data, views, the owner's own sign-ins, or a use of something the desk already allowed.
               The reason says why; `must` pins the line in the body that makes it true.
     open      a raise that is NOT gated yet. Each names the item or the lane that closes it, and the test pins the open
               set exactly, so it can only shrink on purpose.

   An unclassified route fails. A classified route that no longer exists fails. A route whose body calls the desk proof
   but is classified as anything but desk fails (the census must not hide a gate it cannot see). Reads source only. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_fnbody');
const { mutatingRoutes } = require('./helpers/route-table');

const ROOT = path.join(__dirname, '..');
const IDX = fs.readFileSync(path.join(ROOT, 'sidecar', 'index.js'), 'utf8');
const DESK_CALL = /deskGate\(|ownerPairingPass\(|loopCheckAtDesk\(|deskApproved|blessPath\(|workshopRaiseAtDesk\(/;

const C = Object.create(null);
function put(kind, reason, keys, extra) {
  for (const k of keys) {
    assert.ok(!C[k], 'classified twice: ' + k);
    C[k] = Object.assign({ kind, reason }, extra || {});
  }
}
const ex = p => "POST exact '" + p + "'";

/* ---------------------------------------------------------------- desk */
put('desk', 'consent ALWAYS / permanent grants, the master bypass and blessing a project folder widen what tools may do',
  [ex('/api/consent'), ex('/api/permissions/grant'), ex('/api/permissions/bypass'), ex('/api/projects/bless')]);
put('desk', 'a channel connect or an owner pairing lets a chat drive the crew',
  [ex('/api/channels/telegram/connect'), ex('/api/channels/telegram/owner/pair'), ex('/api/channels/telegram/bots/connect'),
    ex('/api/channels/discord/connect')]);
put('desk', 'roster raises (Full Access, a wider execution profile, keepFull across a drive change) and the per-agent approval dial',
  [ex('/api/roster')], { must: /fullAccessDriveOf\(/ });
put('desk', 'the per-agent approval dial', [ex('/api/agent/approval')]);
put('desk', 'remote access: turning it on, pairing a device, activating it, raising a device', [ex('/api/remote/enable'),
  ex('/api/remote/pair'), ex('/api/remote/activate'), ex('/api/remote/device')]);
put('desk', 'an imported config can carry grants, hooks and posture', [ex('/api/config/import')]);
put('desk', 'a service key used without asking', [ex('/api/servicekeys/autonomy')]);
put('desk', 'turning a toolset on gives agents its tools', ["POST prefix '/api/toolsets/'"]);
put('desk', 'a routine with unattended grants, or a changed/stale script under them', [ex('/api/cron'), ex('/api/cron/update')]);
put('desk', 'a loop check is a host command run on every iteration', [ex('/api/loops'), ex('/api/loops/update'), ex('/api/loops/testcheck')]);
put('desk', 'a hook is a host command the station runs on events; a plugin is code it loads', [ex('/api/hooks/allow'),
  ex('/api/hooks/create'), ex('/api/plugins/allow')]);
put('desk', 'a bot owner pairing lets that chat drive the crew', ['POST rx TG_BOT_RX.owner'], { via: 'handleTelegramBotOwner' });
put('desk', 'a generic channel connect lets its chats reach the crew', ['POST rx GENERIC_CHANNEL_RX.connect'], { via: 'handleGenericChannelConnect' });
put('desk', 'an owner pairing lets that chat drive the crew', ['POST rx GENERIC_CHANNEL_RX.ownerPair'], { via: 'handleChannelOwnerPair' });

put('desk', 'turning the away workshop on lets the agent build unattended and arms a build shift that spends (review2 #9)',
  [ex('/api/workshop/grant')]);
put('desk', 'a dial raise to building grants the away workshop when it was never decided (review2 #9); lowering never asks',
  [ex('/api/autonomy/posture')]);
put('desk', '"/away on" is the same workshop grant (review2 #9); a custom exec command is the owner\'s own snippet',
  [ex('/api/slash/dispatch')]);

/* ---------------------------------------------------------------- open (not gated yet; each names what closes it) */
put('desk', 'quit: the desktop shell stops the station with its own key; anyone else is asked at the desk (review2 #11: a pm2 restart reset the wrong-code count)',
  [ex('/api/lifecycle/quit')]);
put('open', 'a raised spend cap, a resumed spend or a settled-low charge lets runs spend more: the spend rail is fix-sec3-1108\'s',
  [ex('/api/budget/caps'), ex('/api/budget/resume'), ex('/api/budget/settle')], { closes: 'fix-sec3-1108 (spend rail)' });

/* ---------------------------------------------------------------- lowering */
put('lowering', 'stops a run or every automation (the E-STOP)', [ex('/api/cancel'), ex('/api/halt'), ex('/api/subagents/interrupt'),
  ex('/api/routing/sample/stop')]);
put('lowering', 'revokes a grant, a pairing, a device or an owner', [ex('/api/permissions/revoke'), ex('/api/channels/telegram/owner/revoke'),
  ex('/api/remote/revoke'), ex('/api/hooks/revoke'), ex('/api/plugins/revoke')]);
put('lowering', 'disconnects a channel', [ex('/api/channels/telegram/disconnect'), ex('/api/channels/discord/disconnect'),
  'POST rx GENERIC_CHANNEL_RX.disconnect']);
put('lowering', 'removes an agent, a project, a routine, a loop, a hook, a plugin, an app or a widget', [ex('/api/agent/delete'),
  ex('/api/projects/forget'), ex('/api/cron/remove'), ex('/api/loops/remove'), ex('/api/hooks/delete'), ex('/api/plugins/delete'),
  ex('/api/apps/delete'), ex('/api/widgets/remove'), ex('/api/workshop/remove'), ex('/api/userprops/delete'),
  'DELETE rx TRIGGER_ID_RX', 'DELETE rx LINE_JOB_RX']);
put('lowering', 'drops a sign-in, a key or a linked account', [ex('/api/auth/grok/logout'), ex('/api/auth/kimi/logout'),
  ex('/api/auth/codex/remove'), ex('/api/auth/grok/remove'), ex('/api/auth/kimi/remove'), ex('/api/auth/claude-cli/remove'),
  ex('/api/auth/claude-cli/cancel'), ex('/api/auth/codex/logout'), ex('/api/connectors/remove'), ex('/api/connectors/oauth/cancel'),
  ex('/api/servicekeys/scrub'), ex('/api/servicekeys/remove'), ex('/api/spotify/disconnect'), ex('/api/credits/unlink'),
  ex('/api/browser/signins/forget')]);
put('lowering', 'uninstalls a skill', [ex('/api/skill-market/uninstall')]);
put('lowering', 'forgets or redacts text', [ex('/api/transcript/redact'), ex('/api/prompt/scrub'), ex('/api/memory/reset'),
  ex('/api/memory/forget'), "DELETE exact '/api/personalization'"]);
put('lowering', 'closes the station browser', [ex('/api/browser/view/close'), ex('/api/browser/reset')]);
put('lowering', 'resets a section to its safe defaults (roster cleared, grants cleared)', [ex('/api/config/reset')]);
put('lowering', 'removes idle sandboxes', [ex('/api/execution/cleanup')]);

/* ---------------------------------------------------------------- neutral */
put('neutral', 'starts or steers a run; every tool call in it goes through the consent broker and the agent\'s own posture',
  [ex('/api/run'), ex('/api/run/steer'), ex('/api/subagents/steer'), ex('/api/run-recoveries/continue'), ex('/api/run-recoveries/resolve'),
    ex('/api/run/stream/withdraw'), ex('/api/nightshift/beat'), ex('/api/workshop/shift'), ex('/api/workshop/implement'),
    ex('/api/cron/run'), ex('/api/routing/steptest'), 'POST rx STEPTEST_RX', 'POST rx LINE_JOB_RX', ex('/api/routing/sample')]);
put('neutral', 'answers a waiting question with text, or extends its wait; never an ALWAYS', [ex('/api/consent/answer'), ex('/api/consent/ack')]);
put('neutral', 'one fs.write through the real broker on the autonomous surface (default deny)', [ex('/api/autonomy/write')], { must: /makeConsentBroker\(/ });
put('neutral', 'group chats: a group approval answers once or deny only', [ex('/api/groups')]);
put('neutral', 'the desk\'s own answer: the shell IPC key only', [ex('/api/desk/approve')], { must: /ipcTokenOk\(req\)/ });
put('neutral', 'the shell pushes a key it stored in the OS keychain: the shell IPC key only', [ex('/api/channels/token'), ex('/api/key')], { must: /ipcTokenOk\(req\)/ });
put('neutral', 'a new model or new instructions for a Full Access agent drop it to ask-first (review2 #6)',
  [ex('/api/agent/model'), ex('/api/agent/personality')], { must: /fullAccessDriveOf\(/ });
put('neutral', 'the agent\'s context: dossier, goals, journey, memory, personalization (data the prompt reads; no tool authority)',
  [ex('/api/dossier'), ex('/api/goals'), ex('/api/journey'), "POST exact '/api/personalization'", ex('/api/memory/turnin'),
    ex('/api/threads/turnin'), ex('/api/memory/declined/restore'), ex('/api/memory/pin'), ex('/api/memory/edit'), ex('/api/memory/config'),
    ex('/api/study/resolve'), ex('/api/growth/ratings/correction'), ex('/api/taste/keep-style'), "POST qsplit '/api/growth/ratings'"]);
put('neutral', 'the owner\'s own provider sign-ins and keys: credentials for their accounts, no tool authority',
  [ex('/api/auth/codex/start'), ex('/api/auth/codex/poll'), ex('/api/auth/grok/start'), ex('/api/auth/grok/poll'),
    ex('/api/auth/kimi/start'), ex('/api/auth/kimi/poll'), ex('/api/auth/codex/add'), "POST qsplit '/api/auth/codex/account-start'",
    ex('/api/auth/codex/account-poll'), ex('/api/auth/grok/add'), "POST qsplit '/api/auth/grok/account-start'",
    ex('/api/auth/grok/account-poll'), ex('/api/auth/kimi/add'), "POST qsplit '/api/auth/kimi/account-start'",
    ex('/api/auth/kimi/account-poll'), ex('/api/auth/claude-cli/start'), ex('/api/auth/claude-cli/poll'), ex('/api/auth/claude-cli/code'),
    ex('/api/auth/claude-cli/add'), ex('/api/providers/probe'), ex('/api/providers/validate'), ex('/api/providers/engine-key'),
    ex('/api/providers/connect'), ex('/api/providers/connect/take'), ex('/api/credits/link/start'), ex('/api/credits/link/poll'),
    ex('/api/spotify/auth/start')]);
put('neutral', 'a connector: an http server, or a stdio server that runs only inside a Safe Cell agent\'s cell',
  [ex('/api/connectors')], { must: /SAFE_CELL_REQUIRED/ });
put('neutral', 'connector sign-in and storage', [ex('/api/connectors/oauth/start'), ex('/api/connectors/oauth/device/poll'),
  ex('/api/connectors/oauth/client'), ex('/api/connectors/storage/start-fresh'), ex('/api/connectors/refresh')]);
put('neutral', 'a service key\'s value or on/off; using it without asking is the desk-gated autonomy route',
  [ex('/api/servicekeys'), ex('/api/servicekeys/toggle')]);
put('neutral', 'a skill\'s text reaches the agent only through the skill guard and its approval; every tool it prompts still asks',
  [ex('/api/skills/toggle'), ex('/api/skill-market/install'), ex('/api/skill-exchange/inspect'), ex('/api/skill-exchange/registry'),
    ex('/api/skill-exchange/discover'), ex('/api/skill-exchange/registries'), ex('/api/skill-exchange/import'),
    ex('/api/skill-exchange/install'), ex('/api/skill-exchange/check'), ex('/api/skill-exchange/rollback'),
    ex('/api/skill-exchange/generations'), ex('/api/agent-skills/manage'), ex('/api/agent-skills/allow'),
    ex('/api/agent-skills/evaluate-candidate'), ex('/api/agent-skills/approve-candidate'), ex('/api/agent-skills/reject-candidate'),
    ex('/api/agent-skills/evaluation-suite')]);
put('neutral', 'the owner shares or exports something outward', [ex('/api/community-maps/share'), ex('/api/skill-market/share'),
  ex('/api/skill-exchange/export'), ex('/api/skill-exchange/publish-handoff'), ex('/api/agent-skills/share'), ex('/api/config/export'),
  ex('/api/config/export/save'), ex('/api/export/save')]);
put('neutral', 'a plugin is created unapproved (allowing it is the desk-gated route); its store is its own data', [ex('/api/plugins/create'),
  ex('/api/plugins/store')]);
put('neutral', 'calls a plugin only as the desk approved it on disk', [ex('/api/plugins/call')], { must: /approvedRecord\(/ });
put('neutral', 'apps: pages and their data; a schedule is an ordinary routine with no unattended grants', [ex('/api/apps'),
  ex('/api/apps/rename'), ex('/api/apps/schedule'), ex('/api/apps/store')]);
put('neutral', 'a routine with no unattended grants asks (or is refused) like any unattended run; preview and degraded only read or clear a note',
  [ex('/api/cron/preview'), ex('/api/cron/degraded/clear')]);
put('neutral', 'arming routines or lifting the E-STOP returns to what the desk already allowed; adds no grant',
  [ex('/api/cron/arm'), ex('/api/halt/resume'), ex('/api/loops/control')]);
put('neutral', 'loop verdicts and detection: a loop\'s check is set only through the desk-gated loop routes', [ex('/api/loops/verdict'),
  ex('/api/loops/detect')]);
put('neutral', 'the away workshop\'s queue and decisions (building needs the workshop grant)', [ex('/api/workshop/queue'),
  ex('/api/workshop/decide'), ex('/api/workshop/undo')]);
put('neutral', 'opening files from a run is refused', [ex('/api/workshop/open')], { must: /json\(403/ });
put('neutral', 'the night shift\'s focus and avoid lists steer what it picks, not what it may do', ["POST qsplit '/api/nightshift/focus'",
  "DELETE qsplit '/api/nightshift/focus'", "POST qsplit '/api/nightshift/avoid'", "DELETE qsplit '/api/nightshift/avoid'"]);
put('neutral', 'line triggers start a line\'s job through its crew\'s own posture; a webhook trigger has its own secret',
  [ex('/api/routing/triggers'), 'PATCH rx TRIGGER_ID_RX', 'POST rx TRIGGER_ID_RX']);
put('neutral', 'an inbound relay or line webhook, proved by its own signature or secret (not the station key)',
  ["POST prefix '/api/channels/webhook/'", 'POST serveTriggerHook'], { must: /verify\(|secretMatches\(/ });
put('neutral', 'routing hints are only asked about, never installed', [ex('/api/routing')]);
put('neutral', 'routing helpers that only draft or suggest', [ex('/api/routing/fix-suggest'), ex('/api/routing/line-draft')]);
put('neutral', 'channel housekeeping: sync, notify setting, moving a chat to a stream (owner status untouched)',
  [ex('/api/channels/telegram/sync'), ex('/api/channels/discord/sync'), 'POST rx GENERIC_CHANNEL_RX.sync', ex('/api/channels/notify'),
    ex('/api/channels/handoff')]);
put('neutral', 'reconnects a bot the desk connected, with its saved token; disconnect lowers', ['POST rx TG_BOT_RX.act']);
put('neutral', 'dev-only: 404 unless DEV_MODE', [ex('/api/dev/inbound'), ex('/api/dev/fault')], { must: /if \(!DEV_MODE\)/ });
put('neutral', 'remote view snapshots, only while remote is on', [ex('/api/remote/view'), ex('/api/remote/view/crew')], { must: /remoteDevices\.enabled\(\)/ });
put('neutral', 'model choice for voice and fallback; numeric runtime limits (env-locked ones stay locked)', [ex('/api/fallback/chain'),
  ex('/api/voice/chat-model'), ex('/api/runtime/knobs')]);
put('neutral', 'execution settings: idle cleanup minutes, where an agent\'s commands run, a workspace sync; each command still asks',
  [ex('/api/execution/policy'), ex('/api/execution/ssh'), ex('/api/execution/sync')]);
put('neutral', 'computer control: install, check or pick the fixed helper; each action still goes through consent', [ex('/api/computer-control')]);
put('neutral', 'project folders: a workspace needs a folder already granted permanently; discover and pickers only read or open the native picker',
  [ex('/api/projects/workspace'), ex('/api/projects/discover'), ex('/api/projects/pickfolder'), ex('/api/pickpath')]);
put('neutral', 'harness detection only reads', [ex('/api/harness/detect'), ex('/api/harness/scan')]);
put('neutral', 'the page\'s station save and its recovery; agents\' powers come from the roster push, which is desk-gated',
  ["POST qsplit '/api/save'", ex('/api/save/adopt'), ex('/api/save/conflicts/restore'), ex('/api/save/recovery-ack'),
    ex('/api/notebook/restore'), ex('/api/checkpoint/restore'), ex('/api/lineage/recover'), ex('/api/lineage/start-fresh'),
    ex('/api/recovery/backup')]);
put('neutral', 'the browser: the Commander drives, hands off or picks a mode (chrome mode needs the paired extension and asks per site)',
  [ex('/api/browser/view/open'), ex('/api/browser/view/nav'), ex('/api/browser/view/front'), ex('/api/browser/view/warm'),
    ex('/api/browser/settings'), ex('/api/browser/view/input'), ex('/api/browser/handoff/take'), ex('/api/browser/handoff/back'),
    ex('/api/browser/handoff/cancel'), ex('/api/browser/handoff/input')]);
put('neutral', 'voice in and out', [ex('/api/realtime/session').replace('exact', 'qsplit'), ex('/api/stt/native'),
  "POST qsplit '/api/local-voice/stream'", "POST qsplit '/api/local-voice/warm'", ex('/api/local-voice/transcribe'), ex('/api/tts'),
  "POST qsplit '/api/stt'"]);
put('neutral', 'acknowledgements, beacons and UI state', [ex('/api/session'), ex('/api/station/ack'), ex('/api/activity'),
  ex('/api/summon/ack'), ex('/api/away/briefing/deliver'), "POST qsplit '/api/workflow-takeovers'", ex('/api/diagnostics/live'),
  ex('/api/turn-identity/mode'), ex('/api/turn-identity/soak'), ex('/api/turn-identity/retract'), ex('/api/turn-identity/retractions'),
  ex('/api/transcript/rows')]);
put('neutral', 'the scout and discovery pick what to look at; anything they fetch taints the run that reads it',
  [ex('/api/scout/context'), ex('/api/scout/decide'), ex('/api/scout/telemetry'), ex('/api/discovery/sources'),
    ex('/api/discovery/decide'), ex('/api/discovery/scan'), ex('/api/recommendations')]);
put('neutral', 'outputs, quests and widgets: the owner\'s own deliverables and dashboard', [ex('/api/deliverables/cleanup-preview'),
  ex('/api/deliverables/cleanup'), ex('/api/deliverables/cleanup-undo'), ex('/api/deliverables/clear'), ex('/api/deliverables/clear-undo'),
  ex('/api/quests/mint'), ex('/api/quests/update'), ex('/api/quests/confirm'), ex('/api/quests/dismiss'), ex('/api/quests/disposition'),
  ex('/api/quests/report'), ex('/api/quests/refresh/run'), ex('/api/quests/refresh/northstar'), ex('/api/widgets/configure'),
  ex('/api/widgets/request')]);
put('neutral', '3D props in the room', [ex('/api/userprops/generate'), ex('/api/userprops/preview'), ex('/api/userprops/scale'),
  ex('/api/userprops/side')]);
put('neutral', 'uploads into the station', [ex('/api/attachments')]);
put('neutral', 'app updates are verified by signature before they install (src-tauri update_verify)', [ex('/api/update/prepare'),
  ex('/api/update/cancel')]);

/* ---------------------------------------------------------------- the census */
const OPEN = {
  "POST exact '/api/budget/caps'": 'fix-sec3-1108 (spend rail)',
  "POST exact '/api/budget/resume'": 'fix-sec3-1108 (spend rail)',
  "POST exact '/api/budget/settle'": 'fix-sec3-1108 (spend rail)'
};

const routes = mutatingRoutes(ROOT);
const keys = routes.map(r => r.key);
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').join('\n     ')); }
};

check('the route table parses (every route found, none twice)', () => {
  assert.ok(routes.length > 250, 'only ' + routes.length + ' mutating routes found: the table parser lost entries');
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepStrictEqual(dup, [], 'a route key appears twice');
  for (const r of routes) {
    if (/^[A-Za-z0-9_$]+$/.test(r.handler)) assert.ok(r.body, 'no body found for ' + r.key + ' (' + r.handler + ')');
  }
});

check('every mutating route is classified', () => {
  const missing = keys.filter(k => !C[k]);
  assert.deepStrictEqual(missing, [], 'unclassified mutating routes: classify each as desk, lowering, neutral or open, with a reason');
});

check('no classification names a route that is gone', () => {
  const stale = Object.keys(C).filter(k => keys.indexOf(k) < 0);
  assert.deepStrictEqual(stale, [], 'classified routes that no longer exist');
});

check('every desk route calls the desk proof (its own body, or the handler its inline entry calls)', () => {
  const bad = [];
  for (const r of routes) {
    const c = C[r.key]; if (!c || c.kind !== 'desk') continue;
    let body = r.body;
    if (c.via) {
      assert.ok(r.body.indexOf(c.via + '(') >= 0, r.key + ' does not call ' + c.via);
      body = fnBody(IDX, 'async function ' + c.via + '(') || fnBody(IDX, 'function ' + c.via + '(') || '';
    }
    if (!DESK_CALL.test(body)) bad.push(r.key);
  }
  assert.deepStrictEqual(bad, [], 'desk routes without a desk proof call');
});

check('a route that calls the desk proof is classified desk (no gate hidden as neutral)', () => {
  const hidden = routes.filter(r => DESK_CALL.test(r.body) && C[r.key] && C[r.key].kind !== 'desk').map(r => r.key);
  assert.deepStrictEqual(hidden, [], 'routes that call the desk proof but are not classified desk');
});

check('each pinned line is still in its route\'s body', () => {
  const bad = [];
  for (const r of routes) {
    const c = C[r.key];
    if (c && c.must && !c.must.test(r.body)) bad.push(r.key + ' lacks ' + c.must);
  }
  assert.deepStrictEqual(bad, []);
});

check('the open (still ungated) raises are exactly the known list', () => {
  const open = {};
  for (const k of Object.keys(C)) if (C[k].kind === 'open') open[k] = C[k].closes;
  assert.deepStrictEqual(open, OPEN, 'the open set changed: close an item by gating it (class desk) or pinning its refusal (must), never by relabelling it');
});

check('every class has a reason', () => {
  for (const k of Object.keys(C)) {
    assert.ok(['desk', 'lowering', 'neutral', 'open'].indexOf(C[k].kind) >= 0, k + ': unknown class ' + C[k].kind);
    assert.ok(String(C[k].reason || '').length >= 12, k + ': no reason');
  }
});

const tally = {};
for (const k of keys) { const c = C[k]; const kind = c ? c.kind : 'unclassified'; tally[kind] = (tally[kind] || 0) + 1; }
console.log('\n' + routes.length + ' mutating routes: ' + Object.keys(tally).sort().map(k => tally[k] + ' ' + k).join(', '));
const openNow = Object.keys(OPEN);
if (openNow.length) console.log('still ungated: ' + openNow.map(k => k.replace(/^POST exact /, '') + ' (' + OPEN[k] + ')').join(', '));
if (failures) { console.log('\n' + failures + ' check(s) failed'); process.exit(1); }
console.log('\nroute-authority census: all checks passed');
