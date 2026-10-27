/* node test/consent-visibility.test.js — EL-11 escape tests: background consent must be VISIBLE.

   FIX 1 escape: a consent prompt on a NON-displayed session rendered nothing — StationUI.notify lived only
   inside permissionRow (active stream only); background prompts produced an unlabeled crew-dot flip that lit
   ALL agents' dots, and the sidecar auto-denied at 120s. A deny on a prompt nobody saw = consent violation.

   Behavioral part runs at the store seam (Channels, headless UMD) mirroring the sweep's planted state;
   the DOM wiring (which is not headless-loadable) is locked with source-level asserts, same convention as
   test/settings-p1-backend.test.js. */
'use strict';
const { readSidecarSource, readSidecarIndex } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const F = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/* ---------- FIX 1 · behavioral at the store seam: the planted background-pending state is queryable ---------- */
{
  delete require.cache[require.resolve('../frontend/app/channels.js')];
  const Channels = require('../frontend/app/channels.js');
  Channels.begin('ws-bg', 1000);                       // a background stream with a live run…
  Channels.setRunId('ws-bg', 'run-1');
  Channels.setPending('ws-bg', { promptId: 'pp1', tool: 'fs.write', argsSummary: 'notes.md', runId: 'run-1' });
  A.eq(Channels.pendingIds(), ['ws-bg'], 'store seam: the planted background pending is discoverable via pendingIds');
  A.eq(Channels.statusOf('ws-bg'), 'awaiting your approval…', 'store seam: status flips to the approval string the rail keys off');
  A.ok(Channels.snapshot('ws-bg').pending.promptId === 'pp1', 'store seam: the snapshot re-render path carries the prompt');
  Channels.reset();
}

/* ---------- FIX 1a · the GLOBAL surface: a background prompt fires a clickable notify that opens THAT session ---------- */
{
  const chat = F('frontend/app/chat.js');
  A.ok(/function backgroundPermissionNotify\s*\(/.test(chat),
    'chat.js: a background-consent notifier exists (the old code only notified inside permissionRow, active stream only)');
  // onPermission must route the NON-active case to it (the escape: the else-branch used to be nothing).
  A.ok(/onPermission:[\s\S]{0,600}?else\s*\{?\s*backgroundPermissionNotify\(ev,\s*ws\)/.test(chat),
    'chat.js: onPermission calls backgroundPermissionNotify for a non-displayed session');
  const fnBody = chat.split('function backgroundPermissionNotify')[1] || '';
  A.ok(/StationUI\.notify\(/.test(fnBody.slice(0, 2000)), 'backgroundPermissionNotify: fires StationUI.notify');
  A.ok(/needsApproval/.test(fnBody.slice(0, 2000)), 'backgroundPermissionNotify: uses the needsApproval category (mutable pref honored)');
  A.ok(/App\.agentName|agentName\(/.test(fnBody.slice(0, 2000)), 'backgroundPermissionNotify: names the AGENT (not the focused hero)');
  A.ok(/openWorkstream\(\s*ws\.id\s*\)|go:\s*\{\s*ws:\s*ws\.id\s*\}/.test(fnBody.slice(0, 2000)),
    'backgroundPermissionNotify: clicking opens THAT session (the rail-row restore path re-renders the consent card)');
  A.ok(/App\.refreshRail\(\)/.test(fnBody.slice(0, 2000)), 'backgroundPermissionNotify: refreshes the rail so the row marker shows instantly');
  // the browser attests the prompt is now human-visible → the sidecar may extend the deny deadline (FIX 1c).
  A.ok(/consentAck\(/.test(chat), 'chat.js: acks the sidecar that the prompt reached a human surface');
}
{
  const sui = F('frontend/app/stationui.js');
  A.ok(/function notify\(text, cls, category, opts\)/.test(sui), 'stationui.js: notify accepts opts (additive 4th arg)');
  A.ok(/onClick/.test(sui.split('function toast')[1] || ''), 'stationui.js: the toast supports a click-through action');
}

/* ---------- FIX 1b · the marker lands on the SPECIFIC workstream row, and crew dots stop lying globally ---------- */
{
  const app = F('frontend/app/app.js');
  // the rail row's attn state must carry an explicit human-readable marker, not just a subtle dot recolor.
  const Channels = require('../frontend/app/channels.js');
  const context = require('node:vm').createContext({ Channels, Workstreams: { get: id => ['ws-one', 'ws-two'].includes(id) ? { id, agentId: 'same-agent' } : null, unread: () => false }, railRelTime: () => '', railFmtElapsed: () => '' });
  require('node:vm').runInContext(A.fnBody(app, 'function railPendingIds()') + '\n' + A.fnBody(app, 'function railRowState(w)'), context);
  Channels.setPending('ws-one', { tool: 'fs.write', promptId: 'p1' });
  Channels.setPending('ws-two', { tool: 'brief.ask', promptId: 'p2' });
  Channels.setPending('deleted', { tool: 'fs.write', promptId: 'gone' });
  A.eq([...context.railPendingIds()], ['ws-one', 'ws-two'], 'attention counts sessions sharing one agent separately and excludes orphaned prompts');
  A.eq(context.railRowState({ id: 'ws-one' }).meta, 'Approval needed', 'the exact session shows a clear approval badge even before run-start state arrives');
  A.eq(context.railRowState({ id: 'ws-two' }).meta, 'Reply needed', 'an agent question asks for a reply, not permission');
  Channels.clearPending('ws-one');
  A.eq([...context.railPendingIds()], ['ws-two'], 'resolving one session leaves the other waiting session visible');
  A.eq(context.railRowState({ id: 'ws-one' }).attn, false, 'the resolved session no longer asks for attention');
  Channels.reset();
  const wr = F('frontend/app/warroom.js');
  A.ok(!/if \(awaiting\) cls = 'wr-await'/.test(wr),
    'warroom.js: the GLOBAL await flip is gone (it lit ALL agents\' dots for one agent\'s prompt — untruthful telemetry)');
  A.ok(/pendingAgentIds\s*\(/.test(wr) && /\.has\(id\)[\s\S]{0,40}?wr-await/.test(wr),
    'warroom.js: wr-await is scoped to the agent(s) that actually own a pending consent');
}

/* ---------- FIX 1c · sidecar: ack route exists, wired to the extendable waiter; fail-closed floor intact ---------- */
{
  const idx = readSidecarSource();
  A.ok(/'\/api\/consent\/ack'/.test(idx) && /handleConsentAck/.test(idx), 'sidecar: POST /api/consent/ack is routed');
  A.ok(/makeConsentWait/.test(idx) && /require\('\.\/consentwait\.js'\)/.test(idx),
    'sidecar: askHuman rides the tested extendable waiter (not a second untested timer)');
  A.ok(/CONSENT_ACK_EXTEND_MS\s*=/.test(idx), 'sidecar: the extension bound is a named, bounded constant');
  // the summon channel keeps its own untouched fail-closed timer (no behavior change out of scope).
  A.ok(/setTimeout\(\(\) => finish\(null\), CONSENT_TIMEOUT_MS\)/.test(idx), 'sidecar: summon fail-closed timer untouched');
  // sidecar-index-14: AbortSignal.any is missing on Node 18/20.0-20.2; an unguarded call threw inside askHuman, so a
  // delegated worker's first approval failed its tool call instead of showing the Commander a card
  // index.js only: sidecar/tools/builtin/cua-computer.js still makes two unguarded AbortSignal.any calls (outside this
  // fix's scope), and the scan does not skip comments
  const host = readSidecarIndex();
  const unguarded = [];
  for (let at = host.indexOf('AbortSignal.any(['); at >= 0; at = host.indexOf('AbortSignal.any([', at + 1)) {
    // the guard sits on the same expression or on the enclosing if, a few lines up
    if (!/typeof AbortSignal\.any === 'function'/.test(host.slice(Math.max(0, at - 300), at))) unguarded.push(host.slice(host.lastIndexOf('\n', at) + 1, host.indexOf('\n', at)).trim());
  }
  A.eq(unguarded, [], 'sidecar: every AbortSignal.any call checks that the runtime has it');
}

A.report('consent-visibility');
