/* node test/channels.telegram.pairing-ux.test.js -- a healthy poller is not yet a usable Telegram channel.

   The reported failure was a truthful transport fact rendered as a false product claim: the Bot API poll loop
   was up, but owner enrollment was unfinished, so every ordinary DM was rejected while CHANNELS said CONNECTED
   and told the Commander to DM the bot. Lock both halves of the repair: connect returns the one-time local code,
   and the panel renders the unpaired poller as blocked rather than operational. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');
const sidecar = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');

A.ok(ui.includes('POLLING — DMs BLOCKED: PAIR OWNER'),
  'an up Telegram poller without an owner is rendered as blocked, never CONNECTED');
A.ok(/j\.pairingCode/.test(ui) && /\/pair /.test(ui),
  'the connect response pairing code is turned into the exact Telegram command the Commander must send');
A.ok(/pairingInstruction/.test(ui),
  'the one-time pairing command is retained across the asynchronous status repaint');
A.ok(/<code>\/pair<\/code> message with a code/.test(ui.slice(ui.indexOf("id: 'telegram'"), ui.indexOf("id: 'discord'"))),
  'the Telegram setup guide explains the pairing message and code');

A.ok(/out\.pairingCode = pairing\.code/.test(sidecar),
  'the authenticated connect route returns the freshly issued one-time pairing code');
A.ok(/ownerLocked, acceptingDms/.test(sidecar),
  'channel status exposes the operational DM-admission truth separately from poll health');
A.ok(/finish setup now/.test(ui.slice(ui.indexOf('function wireTelegramBots'))) && /j\.pairingCode/.test(ui.slice(ui.indexOf('function wireTelegramBots'))),
  'adding an agent bot immediately renders the exact owner pairing command instead of waiting for impossible green');
A.ok(/issueTelegramBotOwnerPairing/.test(sidecar) && /out\.pairingCode = pairing\.code/.test(sidecar.slice(sidecar.indexOf('async function handleTelegramBotAdd'))),
  'the agent-bot add route issues the owner challenge in its authenticated response');
A.ok(/deliveryDown[\s\S]*?replies blocked · polling/.test(ui),
  'agent-bot outbound failure is visible text, never a connected-looking tooltip only');
A.ok(/bItem\.warning[\s\S]*?state\.textContent \+=/.test(ui),
  'agent-bot durability warnings render on the row');
A.ok(/telegramBotWarn\[botId\][\s\S]*?owner binding not saved/.test(sidecar),
  'a failed agent-bot owner persist becomes status truth instead of a console-only warning');
A.ok(/could not prove reconnect was saved; the bot was not started/.test(sidecar)
  && /could not prove disconnect was saved; the bot remains connected/.test(sidecar),
  'agent-bot lifecycle actions fail closed when their durable state cannot be proven');
A.ok((sidecar.match(/streamReplies:\s*false/g) || []).length >= 2,
  'station and agent Telegram bots publish final answers only instead of exposing raw token deltas');
A.ok(/const provider = \(ag && ag\.provider\)/.test(ui) && /const model = \(ag && ag\.model\)/.test(ui),
  'agent-bot setup sends the selected roster agent provider/model, not the globally focused provider/model');
A.ok(/channelRunConfigFor\(agentId,[\s\S]*?probeChannelRunConfig\(runConfig/.test(sidecar.slice(sidecar.indexOf('async function handleTelegramBotAdd'))),
  'the add route resolves and probes the bound agent configuration before persistence');
A.ok(/providerVerified:\s*true/.test(sidecar) && /j\.providerVerified/.test(ui),
  'setup success identifies the agent model as verified only after the backend inference proof');
A.ok(/runReady:[\s\S]*?runDetail:/.test(sidecar) && /runBlocked[\s\S]*?replies blocked/.test(ui),
  'a saved bot whose bound agent cannot run is visibly reply-blocked even when Telegram polling works');

const mirror = fs.readFileSync(path.join(root, 'website', 'app', 'app', 'windows', 'messaging.js'), 'utf8');
A.ok(mirror.includes('POLLING — DMs BLOCKED: PAIR OWNER') && /j\.pairingCode/.test(mirror),
  'the generated website app mirror carries the same pairing truth');

A.report('channels.telegram.pairing-ux.test');
