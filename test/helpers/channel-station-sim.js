'use strict';
const CanonicalHistory = require('./channel-history.js');
/* test/helpers/channel-station-sim.js — a station's channels, faked only at the transport edge, for the delivery property
   (test/channels.delivery-ledger.property.test.js) and its soak (channel-delivery-ledger S2), and for the intake receipts
   of edits and taps (test/channels.intake-receipts.test.js, S3).

   THE HUBS ARE BUILT THE PRODUCTION WAY. The station Telegram hub and its adapter are startTelegram's own makeChannelHub and
   makeTelegramAdapter calls, lifted out of sidecar/index.js property by property (test/helpers/source.js objectProps) and
   evaluated in one function, in index.js's order (the hub, then the adapter, guarded, then adapterRef), so they carry
   textBatchWaitMs 350, editMessage and deleteMessage, the prompt registry and the consent broker. Each property is either
   REAL — its own expression, over real seams: the channel store and its ledger, the real adapter over a fake Bot API
   fetch, the prompt registry, the channelAskConsent slice, the host-path scrub, a virtual clock — or a STUB: an inert
   recording stand-in for a seam outside delivery (the run host, routing, roster, media). MANIFEST lists both, and
   manifestProblems() fails when a production call grows a property nobody classified. The agent bot (the soak) is
   startTelegramBot's calls over makeBotScopedStore, lifted the same way. Discord is built through wireChannel, its
   production path, over a fake REST that honours a nonce with enforce_nonce for 5 virtual minutes.

   A CRASH IS REAL. The disk is in memory with a generation fence: a dead process can neither write (EDEAD) nor send (its
   requests never return) and its timers die with it; a fresh store and fresh hubs boot from the same disk and are told
   'up'. Time is virtual (setTimeout/clearTimeout are swapped for the seed's run, Date.now through the lifted `Date`).

   THE RUN HOST is scripted: it emits the shared/events.js agent.* contract (each payload validated) and journals each tool
   step's side effect on the world's disk, so a step run twice is counted whatever process ran it. Some runs end by asking
   (a TASK_QUESTION with two tagged options): the lifted hub's real TaskIntent and prompt registry make that a keyboard.
   A run whose plan says ask (S6) stops at its first tool step for the Commander's permission: the lifted hub's real
   consent prompt, the channelAskConsent slice over the real makeConsentWait, and STARNET REMOTE's real approvals index.

   FAULTS: send failures (retryable, refused for good, a refused credential), a lost response (the platform took it), a
   crash before a send, after the platform took it and before its mark, and inside a receipt or answer write; write
   failure spans (EBUSY, UPDATE_MUTATIONS_FROZEN) while sends succeed; update-barrier spans; a lane pushed past its mark;
   a channel's receipt cap filled; a membership kick and the unblock; a chat down for 20-50 s, and the healthy chat's own
   blip (one failed send of a reply). INBOUND (S3 adds the last two): messages, batches, follow-ups, stops, commands,
   overheard lines, edits of older messages, CORRECTIONS (the latest message edited twice, each edit with its own
   edit_date) and choice TAPS (a live keyboard's option, a double tap, a keyboard a dead process sent). Every decision S3
   added draws from a second stream, so S2's script (and its seeds) keep their shape. ROUTINE FIRES (S4) draw from a third:
   two routines, one to the Telegram group and one to the Discord DM, each fire settled through the REAL cron driver
   (sidecar/cron-driver.js, its lease then settleRun, as Run Now settles one) over a cron.jobs.json on the same fenced
   disk, delivered by the REAL makeRoutineDelivery (sidecar/routine-delivery.js) over the real ChannelOutbound when the
   tree has one; each process ticks the driver every 5 s and asks its pending results again at boot, as index.js does. A
   digest is a few parts long on either platform, and every line of it is its own, so P7 can count each part on the wire.
   EDITS OF A KEYBOARD (S6) answer as Telegram answers them: an edit to what the message already says is refused with
   'message is not modified', so however often one stamp is sent it lands once, and w.stamps lists only the edits that
   changed something (w.editCalls lists them all). w.editFaults arms the next edits: '429' ('429:<retry_after>'), '502',
   '401', 'gone', 'refused', 'lost', 'crashBefore', 'crashAfter'. w.holdKeyboardAnswers() keeps a keyboard the platform took from telling the hub its
   message until w.releaseKeyboardAnswers(): the phone shows it, a tap can come back, and the hub cannot stamp it yet.
   THE ORACLE reads only what any build exposes — the wire, channel.delivery events, the run host's record, the Bot API
   calls and the receipts left on disk — so the same file runs on trunk.

     makeWorld(seed, { steps, bot, limits }) -> world;  await world.run() -> { problems: [...], stats }
       world.inbound(chat, kind, opt) -> its tag (opt.edit: an edit of that message id, carrying opt.editDate)
       world.tap(keyboard, idx) -> its callback id   (a keyboard is one of world.keyboards, the ones the Bot API carried)
       Each delivers a raw update through the adapter's own dispatch, and world.lastAck says whether it was acknowledged:
       a throw is no acknowledgement, and the platform hands that update over again (world.redeliver()).
       world.current() -> the live process { gen, store, tg, dc, bot, cron };  world.mix() -> what the S3 inbound drew;
       world.routineMix() -> what the S4 routine fires drew;  world.reconnect() -> the station's Telegram hub replaced, in
       the same process;  world.canCrash() -> a crash now would be a fair one (the crash boundary below)
     manifestProblems() -> [...]      a lifted bag's keys differ from the production call's, or a key is unclassified */
const pathPosix = require('path').posix;
const { makeChannelStore } = require('../../sidecar/channels/store.js');
const { makeChannelHub, chunkTextParts } = require('../../sidecar/channels/hub.js');
const { makeTelegramAdapter } = require('../../sidecar/channels/telegram.js');
const { makeChannelRegistry, wireChannel } = require('../../sidecar/channels/registry.js');
const { makePromptRegistry } = require('../../sidecar/channels/prompts.js');
const { makeConsentWait } = require('../../sidecar/consentwait.js');
const { makeApprovals } = require('../../sidecar/remote/approvals.js');
const HostPathScrub = require('../../sidecar/host-path-scrub.js');
const { TaskIntent } = require('../../frontend/app/fork.js');
const Events = require('../../shared/events.js');
const { sidecarTopLevelFunction, sidecarFunctionSource, callRegion, readSidecarIndex, liftValues } = require('./source.js');
const { productionHubBag, productionAdapterBag, topLevel } = require('./channel-hub-bags.js');
const HubFactory = require('../../sidecar/channels/factory.js');
const fsReal = require('fs');
const pathReal = require('path');
const cronStore = require('../../sidecar/cron-store.js');
const { makeCronDriver } = require('../../sidecar/cron-driver.js');
const cronMath = require('../../sidecar/cron.js');
const { makeChannelReach } = require('../../sidecar/channels/reach.js');
// the routine delivery has its own module since S1 and the one outbound contract since S4: a tree from before either
// fires no routines (from before S1) or delivers them on its own path (from before S4)
const SIDECAR = pathReal.join(__dirname, '..', '..', 'sidecar');
const RoutineDelivery = fsReal.existsSync(pathReal.join(SIDECAR, 'routine-delivery.js')) ? require(pathReal.join(SIDECAR, 'routine-delivery.js')) : null;
const Outbound = fsReal.existsSync(pathReal.join(SIDECAR, 'channels', 'outbound.js')) ? require(pathReal.join(SIDECAR, 'channels', 'outbound.js')) : null;

const T0 = 1761900000000;
const ROOT = '/ws/channels';
const OWNER = '4242';                 // the Telegram owner (and the DM chat with them)
const GROUP = '-100777';              // a Telegram group the owner admitted
const DC_OWNER = 'd-owner';           // the Discord owner; their DM channel id is 4242 too (the same id on two platforms)
const BOT_ID = 'simbot2';             // the soak's agent bot
const HEADER = '⌛ delayed reply — the channel was unreachable when this was first sent:';
const CHATS = { tgDm: 'telegram|' + OWNER, tgGroup: 'telegram|' + GROUP, dcDm: 'discord|' + OWNER, botDm: 'telegram:' + BOT_ID + '|' + OWNER };
const JOBS_FILE = '/ws/cron.jobs.json';
// index.js's makeCronDriver call: the routines' driver is built with its own delivery hooks (bootCron)
const CRON_CALL = callRegion(readSidecarIndex(), 'const cronDriver = makeCronDriver({', '\n});');
// the two routines of the station (S4): each delivers its digest to a chat the faults reach
const ROUTINES = [
  { id: 'rt-group', name: 'Group digest', chat: CHATS.tgGroup, origin: { channel: 'telegram', chatId: GROUP } },
  { id: 'rt-dc', name: 'Discord digest', chat: CHATS.dcDm, origin: { channel: 'discord', chatId: OWNER } }
];

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const drain = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); };
const hang = () => new Promise(() => {});

/* ---------------------------------------------------------------- the lifted bags ---------------------------------- */
// REAL: the property's own production expression, evaluated over real delivery seams. STUB: replaced, with the reason.
const MANIFEST = {
  stationHub: {
    // taskIntent is real since S3: a question's keyboard is what a choice tap answers
    real: ['channel', 'store', 'ownerTrusted', 'isOwner', 'send', 'chatAction', 'prompts', 'answerCallback', 'editMessage', 'setReaction',
      'deleteMessage', 'streamReplies', 'askConsent', 'resolveConsent', 'consentOutcome', 'newId', 'now', 'maxMessageLength', 'textBatchWaitMs',
      'scrubOutbound', 'taskIntent', 'history'],
    stub: {
      runOnce: 'the scripted run host (agent.* contract, tool steps journaled on the disk)', steerRun: 'joins the host\'s live run',
      runSlash: 'answers every slash command', userCommandNames: 'none',
      desktopCommand: 'none', canReadAllGroupMessages: 'unknown', secrets: 'a configured provider', resolveEntryRunConfig: 'a configured provider', resolveRunConfig: 'a configured downstream provider',
      persona: 'a fixed persona', classify: 'every message is a task', redact: 'identity', emit: 'records channel.delivery events',
      briefFor: 'no brief', groundedFor: 'none', resolveAgent: 'no floor plan', lineRunner: 'no work line',
      lineOriginFor: 'no line', intakeReceiptFor: 'no floor binding or durable line intake in this delivery simulation', getTag: 'no tag', resolveStation: 'office default', stageBriefFor: 'no brief', roster: 'empty', setModel: 'refused',
      modelCatalog: 'empty', fetchMedia: 'no media', transcribe: 'no media', saveAttachment: 'no media', expandAttachments: 'identity'
    }
  },
  stationAdapter: {
    real: ['fetch', 'token', 'apiBase', 'clock', 'botUsername', 'requireMention', 'allowedChats', 'mentionPatterns', 'observeUnmentioned',
      'ownerUserId', 'onInbound', 'onCallback', 'onMembership', 'onStatus', 'onDelivery'],
    // sendNotice (S4) sends the "I was offline" notices: the sim never connects (no backlog is dropped) and its owner is
    // always paired, so none is ever sent here (test/channels.outbound.contract.test.js drives them)
    stub: { onOwnerClaim: 'the owner is already paired', ownerAdmission: 'no pairing code in flight', sendNotice: 'no offline backlog: the sim never connects' }
  }
};
// the agent bot's bags (startTelegramBot) carry the same delivery seams under the same names; its hub answers no roster
// commands; its live bound entry and every later target now have explicit configuration resolvers.
MANIFEST.botHub = { real: MANIFEST.stationHub.real.slice(), stub: Object.assign({}, MANIFEST.stationHub.stub, { resolveRunConfig: 'a configured provider' }) };
for (const k of ['roster', 'setModel', 'modelCatalog']) delete MANIFEST.botHub.stub[k];
MANIFEST.botAdapter = { real: MANIFEST.stationAdapter.real.slice(), stub: Object.assign({}, MANIFEST.stationAdapter.stub) };

function productionBags() {
  return {
    stationHub: productionHubBag('telegram').props,
    stationAdapter: productionAdapterBag('telegram').props,
    botHub: productionHubBag('telegram-bot').props,
    botAdapter: productionAdapterBag('telegram-bot').props
  };
}
function manifestProblems() {
  const out = [];
  const bags = productionBags();
  for (const name of Object.keys(MANIFEST)) {
    const keys = bags[name].map(p => p.key);
    const m = MANIFEST[name];
    const known = new Set(m.real.concat(Object.keys(m.stub)));
    for (const k of keys) if (!known.has(k)) out.push(name + ': production key "' + k + '" is not classified real or stub');
    for (const k of known) if (keys.indexOf(k) < 0) out.push(name + ': classified key "' + k + '" is no longer in the production call');
  }
  return out;
}
// one function that runs the lifted calls in index.js's order; compiled once per bag shape
const factoryCache = new Map();
function liftedFactory(kind, scopeNames) {
  const key = kind + '|' + scopeNames.join(',');
  if (factoryCache.has(key)) return factoryCache.get(key);
  const bags = productionBags();
  const hubBag = kind === 'bot' ? bags.botHub : bags.stationHub;
  const adBag = kind === 'bot' ? bags.botAdapter : bags.stationAdapter;
  const hubM = kind === 'bot' ? MANIFEST.botHub : MANIFEST.stationHub;
  const adM = kind === 'bot' ? MANIFEST.botAdapter : MANIFEST.stationAdapter;
  const prop = (p, m, which) => '  ' + p.key + ': ' + (m.real.indexOf(p.key) >= 0 ? '(' + p.expr + ')' : '__stub.' + which + '[' + JSON.stringify(p.key) + ']');
  const body = 'let adapterRef = null;\n'
    + 'const hub = makeChannelHub(__factory.makeHubDeps(' + JSON.stringify(kind === 'bot' ? 'telegram-bot' : 'telegram') + ', {}, {\n' + hubBag.map(p => prop(p, hubM, 'hub')).join(',\n') + '\n}));\n'
    + 'const adapterBag = {\n' + adBag.map(p => prop(p, adM, 'adapter')).join(',\n') + '\n};\n'
    + 'const adapter = makeTelegramAdapter(__factory.makeAdapterOpts(' + JSON.stringify(kind === 'bot' ? 'telegram-bot' : 'telegram') + ', adapterBag));\n'
    + 'guardOutbound(adapter);\n'
    + 'adapterRef = adapter;\n'
    + 'return { hub: hub, adapter: adapter, adapterBag: adapterBag, status: function () { return telegramStatus; } };';
  const compiled = new Function(...scopeNames, '__stub', '__factory', body);   // eslint-disable-line no-new-func
  const fn = (...args) => compiled(...args, HubFactory);
  factoryCache.set(key, fn);
  return fn;
}

/* the channel consent broker, sliced out of index.js (channelAskConsent and its finishers) over the real makeConsentWait */
function consentSlice(world) {
  const names = ['channelAskConsent', 'noteChannelConsentSettled', 'channelConsentOutcome', 'channelResolveConsent', 'consentSummary'];
  const src = names.map(n => sidecarFunctionSource(n)).filter(Boolean).join('\n');
  const deps = {
    makeConsentWait, channelPendingByRun: new Map(), channelConsentSettled: new Map(), CONSENT_TIMEOUT_MS: 120000, CONSENT_ACK_EXTEND_MS: 60000,
    crypto: { randomUUID: () => world.uuid() }, remoteApprovals: world.approvals, failNote: () => {}, redact: (v) => v
  };
  try {
    return new Function(...Object.keys(deps), src + '\nreturn { channelAskConsent, channelResolveConsent, channelConsentOutcome };')(...Object.values(deps));   // eslint-disable-line no-new-func
  } catch (e) { world.problems.push('setup: the channel consent slice did not compile: ' + e.message); return {}; }
}

/* ---------------------------------------------------------------- the world ----------------------------------------- */
function makeWorld(seed, opts) {
  const o = opts || {};
  const rand = rng(seed);
  // S3's own stream: corrections, keyboards and taps draw here, so the S2 script above them keeps its shape per seed
  const rand2 = rng((seed * 7919 + 104729) >>> 0);
  // S4's own stream: routine fires draw here, so the S2 and S3 scripts above them keep their shape per seed
  const rand3 = rng((seed * 104729 + 15485863) >>> 0);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const w = {
    seed, gen: 0, now: T0, problems: [], files: new Map(), wire: [], attempts: [], events: [], windows: [], runs: [], journal: new Map(),
    contract: [], replies: new Map(), held: [], healthy: seed % 2 ? CHATS.dcDm : CHATS.tgDm, disrupted: T0, crashes: 0,
    writeFault: '', holding: false, crashOnWrite: '', plans: new Map(), kicked: new Set(), spans: [], acked: new Map(), seq: 0,
    tgMsgId: 1000, updateId: 0, discordId: 9000, nonces: new Map(), live: new Map(), tags: 0, lastTgMsg: new Map(), finished: new Map(), finishOrder: new Map(),
    limits: Object.assign({ laneMaxDeliveries: 3, maxPendingPerChannel: 10 }, o.limits || {}), stats: { steps: 0, actions: {} },
    down: new Set(), blipAt: -Infinity,
    // S3: the keyboards the Bot API carried, its tap answers (callback id -> toast) and keyboard edits (the choice stamp),
    // every tap and correction the adapter acknowledged, what was steered into a live run, and receipts written deferred
    keyboards: [], toasts: new Map(), stamps: [], taps: [], corrections: [], steered: [], deferredIds: new Set(), cbSeq: 0,
    heard: new Set(),  // '<chat>#<messageId>' of every message a member sent: the only messages a reply may quote
    // S4: every routine digest a fire settled ({ jobId, runId, chat, lines }), in fire order, and the records the cron took
    // back before anything of them went (a newer result replaced them, or it is queued again with its new count)
    digests: [], withdrawn: new Set(),
    // S6: every edit of a keyboard's message the Bot API was asked for, the faults armed for the next ones, the hold on a
    // keyboard's answer, and STARNET REMOTE's real index of open asks (w.approvals.answer is what a paired phone calls)
    editCalls: [], editFaults: [], kbHold: null, approvals: makeApprovals({ now: () => w.now }),
    // (review round 1) what the platform refused for good, and when the group removed the bot: the only grounds on which a
    // finished reply may be given up (P1); and every slash command the run host's registry was asked to run (P5)
    refusals: [], kickLog: [], slashCalls: [], stopAcks: []
  };
  w.uuid = () => 'u' + seed + '-' + (++w.seq);

  // ---- virtual time: every timer of every process of this world, in one queue ----
  const timers = [];
  let tseq = 0;
  const vSetTimeout = (fn, ms) => { const t = { at: w.now + Math.max(0, Number(ms) || 0), seq: ++tseq, fn, gen: w.gen, unref() { return t; }, ref() { return t; }, hasRef() { return false; } }; timers.push(t); return t; };
  const vClearTimeout = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  w.advance = async (ms) => {
    const end = w.now + Math.max(0, ms);
    for (;;) {
      await drain(4);
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      w.now = Math.max(w.now, t.at);
      if (t.gen !== w.gen) continue;   // a dead process's timer dies with it
      try { t.fn(); } catch (e) { w.problems.push('a timer threw: ' + ((e && e.message) || e)); }
    }
    w.now = end;
    await drain(8);
  };
  const Real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  w.install = () => { global.setTimeout = vSetTimeout; global.clearTimeout = vClearTimeout; };
  w.uninstall = () => { global.setTimeout = Real.setTimeout; global.clearTimeout = Real.clearTimeout; };

  // ---- the disk: a generation fence, write-failure spans, a crash inside a receipt or answer write ----
  const err = (code, msg) => Object.assign(new Error(code + ': ' + (msg || 'simulated')), { code });
  function fsFor(gen) {
    const dead = () => { if (gen !== w.gen) throw err('EDEAD', 'the process died'); };
    return {
      readFileSync(p) { dead(); if (!w.files.has(p)) throw err('ENOENT', p); return w.files.get(p); },
      writeFileSync(p, d) { dead(); w.files.set(p, String(d)); },
      renameSync(a, b) {
        dead();
        // (a test's own fault) writes start failing at the first delivery-state write `refuseWhen` picks out, that one included
        if (w.refuseWhen && /\/(delivery|inbox)\.json$/.test(b) && w.refuseWhen(w.files.get(a))) { w.writeFault = w.refuseCode || 'EBUSY'; w.refuseWhen = null; }
        if (w.writeFault) throw err(w.writeFault, 'durable writes refused');
        if (w.crashOnWrite && canCrash() && /\/(delivery|inbox)\.json$/.test(b) && isWriteKind(w.files.get(b), w.files.get(a), w.crashOnWrite)) {
          w.crashOnWrite = ''; w.crash('inside a ' + 'write'); throw err('EDEAD', 'the process died inside the write');
        }
        if (!w.files.has(a)) throw err('ENOENT', a);
        w.files.set(b, w.files.get(a)); w.files.delete(a);
        // the last write of the delivery state that reached this disk, in the world's order (what a crash leaves durable)
        if (/\/(delivery|inbox|outbox)\.json$/.test(b)) { w.lastGood = ++w.seq; w.lastGoodAt = w.now; }
        if (/\/delivery\.json$/.test(b)) observeLedger(w.files.get(b));
      },
      mkdirSync() {}
    };
  }
  // WHAT A BUILD WITH A LEDGER MADE DURABLE: every delivery that reached delivery.json, and every tombstone (a build without
  // one never writes the file, and this records nothing). A durable delivery must land, or be given up and said so.
  w.durable = new Map();   // delivery id -> { chat, first, kind, runId }
  w.tombs = new Map();     // delivery id -> reason
  w.tombAt = new Map();    // delivery id -> when its tombstone reached the disk
  w.answerProblems = [];
  function observeLedger(text) {
    let d = null;
    try { d = JSON.parse(text); } catch (_) { return; }
    const pending = new Set((d.receipts || []).map(r => r.id));
    for (const r of d.receipts || []) if (r.deferred) w.deferredIds.add(r.id);   // kept, not run yet (backpressure)
    for (const x of d.deliveries || []) {
      if (!w.durable.has(x.id)) {
        const parts = (x.parts || []).map(p => stripHeader(p.text)).filter(t => t && t !== HEADER);
        const lines = (parts.length ? parts.join('\n') : stripHeader(x.text || '')).split('\n').filter(Boolean);
        w.durable.set(x.id, { chat: x.chat, first: (parts[0] || stripHeader(x.text || '')).split('\n')[0], lines: lines, kind: x.kind, runId: x.runId, at: w.now, gen: w.gen });
        // P5: the write that answers a merged batch settles every one of its receipts
        for (const id of x.receiptIds || []) if (pending.has(id)) w.answerProblems.push('P5 the answer ' + x.id + ' was written while its receipt ' + id + ' stayed pending');
      }
    }
    for (const t of d.tombstones || []) if (!w.tombs.has(t.id)) { w.tombs.set(t.id, t.reason); w.tombAt.set(t.id, w.now); }
  }
  // a receipt write adds a receipt; an answer write adds a reply and takes receipts away (either file shape)
  function isWriteKind(before, after, kind) {
    const parse = (t) => { try { return JSON.parse(t || 'null') || {}; } catch (_) { return {}; } };
    const b = parse(before), a = parse(after);
    const ids = (d) => new Set((d.receipts || d.items || []).map(x => x.id));
    const bi = ids(b), ai = ids(a);
    if (kind === 'receipt') return [...ai].some(id => !bi.has(id));
    return (a.deliveries || []).length > (b.deliveries || []).length && [...bi].some(id => !ai.has(id));
  }
  /* NO CRASH BOUNDARY (review round 1). A crash may come at any moment, a write-failure span included: the station dies,
     or the user quits a station that stopped replying, while an antivirus holds delivery.json or the disk is full. Nothing
     a mark protects may happen twice then either (P4): a run starts, and a tool step goes, only once its mark is on the
     disk (hub.js LEDGER_HELD). What a crash in such a span may legitimately cost is the same window as a crash in the
     instant a part landed, below: a part whose sent mark, or a refusal whose tombstone, never reached the disk. */
  const canCrash = () => true;
  w.canCrash = canCrash;
  w.lastGood = 0;          // the world's sequence number of the last delivery-state write that reached the disk
  w.crashLog = [];         // { gen, at, seq, lastGood } — each crash, and what its process had made durable by then
  /* THE WINDOW: a part the platform took before the process died, whose sent mark had not reached the disk (it landed
     after the process's last durable write: in the very instant of the crash, or while its writes were failing), may be
     sent again by the next process; each is logged as a window event. Its twin: a part the platform REFUSED for good
     whose tombstone had not reached the disk is not known to the next process, which may try it again; that refusal is
     logged the same way (P6 then allows the later process's tries). */
  w.windowed = new Set();
  w.crash = (why) => {
    for (const m of w.wire) {
      if (m.gen !== w.gen || w.windowed.has(m) || !(m.at === w.now || m.seq > w.lastGood)) continue;
      w.windowed.add(m);
      w.windows.push({ chat: m.chat, text: m.text, discord: m.chat.indexOf('discord|') === 0, crash: true });
    }
    for (const h of w.held) if (h.gen === w.gen && (h.at === w.now || h.seq > w.lastGood)) h.window = true;
    w.crashLog.push({ gen: w.gen, at: w.now, seq: ++w.seq, lastGood: w.lastGood });
    // a keyboard, likewise: its id died with this process, or the hub never got to act on it
    // (and one whose open ask was written down only in memory: its process's writes failed from its answer to the crash)
    for (const k of w.keyboards) if (k.gen === w.gen && (k.at === w.now || k.answeredAt === w.now || (k.answeredSeq && k.answeredSeq > w.lastGood))) k.window = true;
    // what the gateway handed this process and its adapter still held (its intake refused so far) dies with it
    if (proc && proc.gen === w.gen && proc.dcCarry) for (const u of proc.dcCarry) u.lostWithProcess = true;
    w.gen++; w.crashes++; w.disrupted = w.now; w.live.clear(); w.stats.lastCrash = why;
  };

  // ---- the run host ----
  function planFor(tags) {
    const k = tags.join('+');
    if (!w.plans.has(k)) w.plans.set(k, { steps: Math.floor(rand() * 3), stepMs: 200 + Math.floor(rand() * 900), long: rand() < 0.25 });
    const p = w.plans.get(k);
    if (p.question === undefined) p.question = rand2() < 0.2;   // S3: some runs end by asking (a keyboard to tap)
    return p;
  }
  // the plan of a message S3 made up (an option a tap answers, a correction): all of it from S3's stream
  function altPlan() { return { steps: Math.floor(rand2() * 3), stepMs: 200 + Math.floor(rand2() * 900), long: false, question: rand2() < 0.15 }; }
  // the chat a run answers, from the task key its hub gives it ('channel:<channel>:<chatId>'; a bot's channel holds a ':')
  function chatOfTask(taskKey) {
    const k = String(taskKey || '');
    if (k.indexOf('channel:') !== 0) return '';
    const rest = k.slice(8), cut = rest.lastIndexOf(':');
    return cut < 0 ? '' : rest.slice(0, cut) + '|' + rest.slice(cut + 1);
  }
  function runHost(gen) {
    return async function runOnce(ro) {
      const words = String((ro.messages[ro.messages.length - 1] || {}).content || '');
      const tags = (words.match(/#(\d+)/g) || []).map(t => t.slice(1));
      const base = { agentId: String(ro.agentId || 'agent'), runId: String(ro.runId) };
      const emit = (name, extra) => {
        const payload = Object.assign({}, base, extra);
        const v = Events.validate(name, payload);
        if (!v.ok) w.contract.push(name + ': ' + v.errors.join('; '));
        ro.emit(name, payload);
      };
      const run = { gen, runId: base.runId, tags, steps: 0, chat: ro.taskKey || '', ended: '', startedAt: w.now };
      w.runs.push(run);
      // when its signal was aborted (a newer message, a stop, E-STOP): a run taken back as it ended may finish 'done' unsaid
      const aborted = () => { if (run.abortedAt == null) { run.abortedAt = w.now; run.abortSeq = ++w.seq; } };
      if (ro.signal && ro.signal.aborted) aborted();
      else if (ro.signal && typeof ro.signal.addEventListener === 'function') ro.signal.addEventListener('abort', aborted, { once: true });
      /* (P1) A FINISHED REPLY, as the run host knows it: the run ended 'done' at this instant, in this process, with these
         writes failing or not. The hub's answer is written in the same instant (no timer runs between a run's end and its
         answer), so whatever ends a reply's claim to land is a fact recorded outside the delivery: its signal aborted by
         then, its process dead in that instant, or its writes failing until the process died (P1, finishedReplies). */
      const finished = () => { run.ended = 'done'; run.endedAt = w.now; run.endSeq = ++w.seq; run.endFault = !!w.writeFault; run.chatKey = chatOfTask(ro.taskKey); };
      emit('agent.run.start', { trigger: 'event', model: 'sim/model' });
      const plan = planFor(tags);
      w.live.set(base.runId, run);
      try {
        for (let s = 0; s < plan.steps; s++) {
          if (gen !== w.gen) return hang();
          emit('agent.tool_call', { callId: 'c' + s, name: 'fs_append' });   // the hub marks the step before it runs
          if (gen !== w.gen) return hang();
          // loop.js asks the run's signal between announcing a step and dispatching it (isCancelled): a run stopped right
          // there — a newer message, a stop, or the hub when the step's mark could not be written — dispatches nothing
          if (ro.signal && ro.signal.aborted) break;
          // (S6) the broker stops this step for the Commander's permission: the run waits here, and anything but a yes skips it
          if (plan.ask && s === 0) {
            run.decision = await ro.prompt({ name: 'fs.write', args: { path: 'notes.md' } }, { scope: 'write' });
            if (gen !== w.gen) return hang();
            if (!/^(once|session|always|full)$/.test(String(run.decision))) continue;
          }
          // a message's step, keyed by the message (an untagged one — "stop", "/status" run as tasks — by its own run)
          const key = (tags.length ? tags.join('+') : 'untagged:' + base.runId) + '#' + s;
          w.journal.set(key, (w.journal.get(key) || 0) + 1);                   // the step's side effect, on the disk
          run.steps++;
          await new Promise((r) => setTimeout(r, plan.stepMs));
          if (gen !== w.gen) return hang();
          if (ro.signal && ro.signal.aborted) break;
        }
        await new Promise((r) => setTimeout(r, 150));
        if (gen !== w.gen) return hang();
        if (ro.signal && ro.signal.aborted) { run.ended = 'cancelled'; emit('agent.run.end', { reason: 'cancelled', turns: 1, usd: 0 }); return; }
        if (plan.question) {
          // IT ASKS (a TASK_QUESTION): two options, each a message of its own once tapped ('choose #<tag>'). What must land
          // is the lines a Telegram hub renders from it (the closing line it adds is the same in every question, so not
          // those); Discord's hub is given no TaskIntent (as in production), so there the question goes out as written.
          const a = String(++w.tags), b = String(++w.tags);
          w.plans.set(a, altPlan()); w.plans.set(b, altPlan());
          const head = 'REPLY ' + tags.join('+') + ' ' + base.runId;
          const asked = head + '\nTASK_QUESTION: Pick one for ' + base.runId + ' || choose #' + a + ' | choose #' + b;
          w.replies.set(base.runId, { text: [head, 'Pick one for ' + base.runId, '1. choose #' + a, '2. choose #' + b].join('\n'), raw: asked, tags, chat: '', options: [a, b] });
          emit('agent.token', { delta: asked });
          finished();
          emit('agent.run.end', { reason: 'clarifying', turns: 1, usd: 0 });
          return;
        }
        const lines = ['REPLY ' + tags.join('+') + ' ' + base.runId];
        if (plan.long) for (let i = 0; i < 60; i++) lines.push('L' + i + ' ' + base.runId + ' ' + 'z'.repeat(90));
        const text = lines.join('\n');
        w.replies.set(base.runId, { text, tags, chat: '' });
        emit('agent.token', { delta: text });
        finished();
        emit('agent.run.end', { reason: 'done', turns: 1, usd: 0 });
      } finally { w.live.delete(base.runId); }
    };
  }

  // ---- the platforms (the transport edge) ----
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, async json() { return body; }, async text() { return JSON.stringify(body); } });
  function takeFault(chat) { const q = w.faults.get(chat); return q && q.length ? q.shift() : 'ok'; }
  w.faults = new Map();
  // replyTo: the message this one quotes (Telegram's reply_to_message_id), '' when none
  function landed(chat, text, replyTo) { const m = { chat, text: String(text), at: w.now, gen: w.gen, seq: ++w.seq, replyTo: replyTo == null ? '' : String(replyTo) }; w.wire.push(m); return m; }
  // (P1, P6) a send the platform refused FOR GOOD, as the platform answered it: the only ground on which a reply may be given up
  function refusedForGood(chat, text, status, gen) { w.refusals.push({ chat, text: String(text), status, gen, at: w.now }); }
  // (S6) an edit of a keyboard's message, as Telegram answers it: a stamp the message already carries changes nothing
  const editRefused = (status, description) => res(status, { ok: false, error_code: status, description: description });
  async function editKeyboard(kb, chat, body) {
    const text = String(body.text || '');
    w.editCalls.push({ chat, messageId: String(kb.messageId), text, gen: w.gen, at: w.now });
    const drawn = w.editFaults.length ? w.editFaults.shift() : '';
    const f = (/^crash/.test(drawn) && !canCrash()) ? '' : drawn;
    if (f === 'crashBefore') { w.crash('before an edit reached the platform'); return hang(); }
    if (/^429/.test(f)) { const after = Number(f.split(':')[1]) || 1; return res(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after ' + after, parameters: { retry_after: after } }); }
    if (f === '502') return editRefused(502, 'Bad Gateway');
    if (f === '401') return editRefused(401, 'Unauthorized');
    if (f === 'gone') return editRefused(400, 'Bad Request: message to edit not found');
    if (f === 'refused') return editRefused(400, 'Bad Request: message can\'t be edited');
    if (kb.stamped === text) return editRefused(400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
    kb.stamped = text;
    w.stamps.push({ chat, messageId: String(kb.messageId), text, markup: body.reply_markup !== undefined, gen: w.gen, at: w.now, seq: ++w.seq });
    if (f === 'lost') throw err('ECONNRESET', 'the answer was lost');
    if (f === 'crashAfter') { w.crash('after the platform made an edit'); return hang(); }
    return res(200, { ok: true, result: { message_id: Number(kb.messageId) } });
  }
  w.holdKeyboardAnswers = () => { let release; const promise = new Promise((r) => { release = r; }); w.kbHold = { promise, release }; };
  w.releaseKeyboardAnswers = () => { const h = w.kbHold; w.kbHold = null; if (h) h.release(); };
  // the option tags a question's message lists ('1. choose #12'), in button order
  const optionTags = (text) => String(text).split('\n').map(l => /^\d+\. choose #(\d+)$/.exec(l)).filter(Boolean).map(m => m[1]);
  function sendOutcome(chat, text, kind, gen) {
    w.attempts.push({ chat, text: String(text), at: w.now, gen });
    if (kind === 'telegram' && w.kicked.has(chat)) return 'kicked';
    // a chat that is down fails every send retryably until its span ends (its armed faults wait)
    if (w.down.has(chat)) return 'retryable';
    const q = w.faults.get(chat);
    // a refusal for good, or the healthy chat's blip, is a REPLY's (P6 and P3 are about replies): an acknowledgement or a
    // notice in between leaves it armed
    if (q && (q[0] === 'permanent' || q[0] === 'blip') && !/^REPLY /.test(stripHeader(String(text)))) return 'ok';
    const f = takeFault(chat);
    if (f === 'blip') { w.blipAt = w.now; return 'retryable'; }
    return ((f === 'crashBefore' || f === 'crashAfter') && !canCrash()) ? 'ok' : f;
  }
  function botApi(label) {
    return (gen) => async (url, init) => {
      if (gen !== w.gen) return hang();
      const method = String(url).split('/').pop();
      const body = init && init.body ? JSON.parse(String(init.body)) : {};
      const chat = label + '|' + String(body.chat_id);
      if (method === 'sendMessage') {
        const f = sendOutcome(chat, body.text, 'telegram', gen);
        if (f === 'crashBefore') { w.crash('before a send'); return hang(); }
        if (f === 'kicked') { refusedForGood(chat, body.text, 403, gen); return res(403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' }); }
        if (f === 'retryable') return res(502, { ok: false, error_code: 502, description: 'Bad Gateway' });
        if (f === 'permanent') { w.held.push({ chat, text: String(body.text), after: w.attempts.length, gen, at: w.now, seq: ++w.seq }); refusedForGood(chat, body.text, 400, gen); return res(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' }); }
        if (f === 'auth') return res(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        const got = landed(chat, body.text, body.reply_to_message_id);
        if (f === 'lost') { w.windowed.add(got); w.windows.push({ chat, text: String(body.text) }); throw err('ECONNRESET', 'the answer was lost'); }
        if (f === 'crashAfter') { w.crash('after the platform took a part'); return hang(); }   // the crash logs the window
        const mid = ++w.tgMsgId;
        // a keyboard the hub can learn the message of: what a later tap answers (each button's callback_data, in order)
        const kb = body.reply_markup && Array.isArray(body.reply_markup.inline_keyboard) ? body.reply_markup.inline_keyboard : null;
        const keyboard = kb ? { chat, messageId: mid, gen, at: w.now, text: String(body.text), data: kb.map(row => String(((row || [])[0] || {}).callback_data || '')), tags: optionTags(body.text), taps: 0, answered: false } : null;
        if (keyboard) w.keyboards.push(keyboard);
        // (S6) the phone shows it, and its answer is still on the way back: the hub does not know this message yet
        if (keyboard && w.kbHold) { await w.kbHold.promise; if (gen !== w.gen) return hang(); }
        if (keyboard) { keyboard.answered = true; keyboard.answeredAt = w.now; keyboard.answeredSeq = ++w.seq; }
        return res(200, { ok: true, result: { message_id: mid } });
      }
      if (method === 'getMe') return res(200, { ok: true, result: { id: 1, is_bot: true, username: 'simbot', first_name: 'Sim' } });
      // a tap's answer (its toast says whether the choice was taken) and an edit of a keyboard's message (its stamp)
      if (method === 'answerCallbackQuery') w.toasts.set(String(body.callback_query_id), { text: String(body.text || ''), gen, seq: ++w.seq });
      if (method === 'editMessageText') {
        const stamped = w.keyboards.find(k => k.chat === chat && String(k.messageId) === String(body.message_id));
        if (stamped) return editKeyboard(stamped, chat, body);
      }
      return res(200, { ok: true, result: true });   // edit, delete, reaction, chat action, callback answer
    };
  }
  w.tgFetch = botApi('telegram');
  w.botFetch = botApi('telegram:' + BOT_ID);
  w.dcFetch = (gen) => async (url, init) => {
    if (gen !== w.gen) return hang();
    const m = /\/channels\/([^/]+)\/messages$/.exec(String(url));
    if (!m || !init || init.method !== 'POST') return res(200, {});
    const body = JSON.parse(String(init.body || '{}'));
    const chat = 'discord|' + m[1];
    // a nonce with enforce_nonce returns the message it already made, for 5 minutes
    const nk = chat + '|' + String(body.nonce || '');
    if (body.nonce && body.enforce_nonce && w.nonces.has(nk) && w.now - w.nonces.get(nk).at < 5 * 60000) { w.attempts.push({ chat, text: String(body.content), at: w.now, deduped: true }); return res(200, { id: w.nonces.get(nk).id }); }
    const f = sendOutcome(chat, body.content, 'discord', gen);
    if (f === 'crashBefore') { w.crash('before a send'); return hang(); }
    if (f === 'retryable') return res(503, { message: 'Service Unavailable' });
    if (f === 'permanent') { w.held.push({ chat, text: String(body.content), after: w.attempts.length, gen, at: w.now, seq: ++w.seq }); refusedForGood(chat, body.content, 403, gen); return res(403, { message: 'Missing Access' }); }
    if (f === 'auth') return res(401, { message: '401: Unauthorized' });
    const got = landed(chat, body.content);
    const id = String(++w.discordId);
    if (body.nonce) w.nonces.set(nk, { id, at: w.now });
    if (f === 'lost') { w.windowed.add(got); w.windows.push({ chat, text: String(body.content), discord: true }); throw err('ECONNRESET', 'the answer was lost'); }
    if (f === 'crashAfter') { w.crash('after the platform took a part'); return hang(); }   // the crash logs the window
    return res(200, { id });
  };

  // ---- a process: the store, the lifted station hub and adapter, Discord through wireChannel, the soak's agent bot ----
  const consent = consentSlice(w);
  const scrub = HostPathScrub.makeHostPathScrub({ fixed: ['/ws/agents'] });
  // a dead process reports nothing: its events are fenced like its writes and its sends
  function emitter(channel, gen) { return (name, payload) => { if (name === 'channel.delivery' && gen === w.gen) w.events.push(Object.assign({ gen: gen, at: w.now, seq: ++w.seq, via: channel }, payload)); }; }
  function stubs(gen, channel) {
    const live = () => null;
    return {
      hub: {
        runOnce: runHost(gen),
        // a note joins the live run it names (recorded: a follow-up or a tap steered into a run is answered by that run)
        steerRun: (runId, note) => {
          if (!(w.live.has(String(runId)) && gen === w.gen)) return { ok: false, status: 409 };
          w.steered.push({ runId: String(runId), text: String(note == null ? '' : note), gen, at: w.now });
          return { ok: true };
        },
        userCommandNames: () => [],
        runSlash: async (line) => { w.slashCalls.push({ line: String(line), gen: gen, at: w.now }); return { ok: true, text: 'done' }; },
        desktopCommand: () => false, canReadAllGroupMessages: () => null,
        secrets: () => ({ key: 'k', model: 'sim/model', provider: 'openrouter', configured: true }),
        resolveEntryRunConfig: () => ({ ok: true, key: 'k', model: 'sim/model', provider: 'openrouter', configured: true }),
        resolveRunConfig: () => ({ ok: true, key: 'k', model: 'sim/model', provider: 'openrouter', configured: true }),
        persona: 'You are a simulated agent.', classify: () => true, redact: (p) => p, emit: emitter(channel, gen),
        taskIntent: null, briefFor: () => null, groundedFor: () => null, resolveAgent: live, lineRunner: null, lineOriginFor: live, intakeReceiptFor: () => null, getTag: () => undefined,
        resolveStation: live, stageBriefFor: live, roster: () => [], setModel: () => ({ ok: false, error: 'not here' }), modelCatalog: () => [],
        fetchMedia: async () => ({ ok: false, error: 'no media' }), transcribe: null, saveAttachment: null, expandAttachments: (m) => m
      },
      adapter: { onOwnerClaim: () => {}, ownerAdmission: () => null }
    };
  }
  const historyByStore = new WeakMap();
  let transcriptIo;
  function historyForStore(store) {
    if (!historyByStore.has(store)) {
      const built = CanonicalHistory.make(store, { io: transcriptIo, now: () => w.now });
      transcriptIo = built.io; historyByStore.set(store, built.history);
    }
    return historyByStore.get(store);
  }
  function scopeFor(gen, store, extra) {
    return Object.assign({
      makeChannelHub, makeTelegramAdapter, makePromptRegistry, guardOutbound: (a) => HostPathScrub.guardOutbound(a, scrub), TaskIntent,
      channelStore: store, channelHistory: historyForStore(store), crypto: { randomUUID: () => w.uuid() }, Date: { now: () => w.now },
      channelAskConsent: consent.channelAskConsent, channelResolveConsent: consent.channelResolveConsent, channelConsentOutcome: consent.channelConsentOutcome,
      scrubOutbound: scrub, telegramTransportFetch: () => w.tgFetch(gen), token: '1:SIM', TELEGRAM_API_BASE: 'http://tg.sim',
      stationBotUsername: 'simbot', stationBotName: 'Sim', stationBotSeesAll: null, channelSecrets: { telegram: { ownerId: OWNER } },
      activeItem: new Map(), bumpQueue: () => 0, QUEUE_CAP: 64, chanEmit: () => {}, telegramStatus: { delivery: {} }, telegram: null,
      console: { log() {}, warn() {}, error() {} }
    }, extra || {});
  }
  function bootStation(gen, store) {
    const scope = scopeFor(gen, store);
    const names = Object.keys(scope);
    return liftedFactory('station', names)(...names.map(n => scope[n]), stubs(gen, 'telegram'));
  }
  function bootBot(gen, store) {
    // makeBotScopedStore, sliced out of index.js over this process's store
    const scoped = new Function('channelStore', 'botScopedStores', sidecarTopLevelFunction('makeBotScopedStore') + '\nreturn makeBotScopedStore;')(store, new Map());   // eslint-disable-line no-new-func
    const rec = { username: 'simbot2', botName: 'SimTwo', name: 'Agent', ownerId: OWNER };
    const entry = { adapter: null, hub: null, status: { connected: false, state: 'connecting', detail: '', delivery: { state: 'unknown', detail: '', at: 0 } } };
    const scope = scopeFor(gen, store, {
      botId: BOT_ID, botStore: scoped(BOT_ID), recOf: () => rec, rec: rec, entry: entry, telegramBots: new Map([[BOT_ID, entry]]),
      telegramTransportFetch: () => w.botFetch(gen), token: '2:SIM', persistTelegramBotOwnerClaim: () => true, publishCommandMenu: () => {},
      telegramOwnerAdmission: () => null, channelSteerRun: null
    });
    const names = Object.keys(scope);
    return Object.assign(liftedFactory('bot', names)(...names.map(n => scope[n]), stubs(gen, 'telegram:' + BOT_ID)), { store: scope.botStore });
  }
  function bootDiscord(gen, store) {
    const reg = makeChannelRegistry();
    const st = stubs(gen, 'discord').hub;
    return wireChannel(reg.get('discord'), {
      outbound: scrub,
      hub: { runOnce: st.runOnce, store: store, history: historyForStore(store), steerRun: st.steerRun, secrets: st.secrets, persona: st.persona, classify: st.classify, redact: st.redact,
        emit: st.emit, newId: () => w.uuid(), now: () => w.now, roster: st.roster, runSlash: st.runSlash, userCommandNames: st.userCommandNames },
      adapter: { fetch: w.dcFetch(gen), token: 'D', clock: { now: () => w.now }, connectGateway: () => ({ close() {} }), ownerUserId: DC_OWNER }
    });
  }
  /* ---- S4: the routines, through the REAL cron driver and routine delivery over this process's store and hubs ---- */
  function bootCron(gen, store, procRef) {
    if (!RoutineDelivery) return null;
    if (!w.files.has(JOBS_FILE)) {
      const jobs = ROUTINES.map(r => cronStore.makeJob({ id: r.id, name: r.name, prompt: 'the digest', agentId: 'agent',
        schedule: cronMath.parseSchedule('every 24h', T0), deliver: 'origin', origin: r.origin }, { id: r.id, now: T0 }));
      w.files.set(JOBS_FILE, JSON.stringify({ version: 1, jobs: jobs }));
    }
    let jobs = cronStore.loadEnvelope(w.files.get(JOBS_FILE)).jobs;
    const registry = makeChannelRegistry();
    const liveFor = (c) => {
      const pr = procRef();
      if (!pr || pr.gen !== w.gen) return null;
      if (String(c) === 'telegram') return { adapter: pr.tg.adapter, hub: pr.tg.hub };
      if (String(c) === 'discord') return { adapter: pr.dc.adapter, hub: pr.dc.hub };
      return null;
    };
    const channelReach = makeChannelReach({ liveChannelFor: liveFor, channelLiveHealth: () => ({ connected: true, state: 'up' }) }).reach;
    const outbound = (Outbound && store.ledger) ? Outbound.makeChannelOutbound({ ledger: store.ledger, registry: registry, reach: channelReach,
      chatRecord: (k) => store.getChatRecord(k), liveChannelFor: liveFor, scrub: scrub, redact: (t) => t, emit: emitter('outbound', gen) }) : null;
    const none = async () => ({ ok: false, notFound: true, error: 'not found' });
    const rd = RoutineDelivery.makeRoutineDelivery({
      channelStore: store, channelOutbound: outbound, channelReach: channelReach, channelRegistry: registry, scrubOutbound: scrub, redact: (t) => t,
      history: historyForStore(store), historyContext: (channel, chatId) => {
        const live = liveFor(channel);
        return live && live.hub && typeof live.hub.historyContext === 'function' ? live.hub.historyContext(chatId) : null;
      },
      runStore: { list: () => [] }, egressReader: { fireReader: () => none, shownName: (paths, x) => String(x), pathsFor: () => ({}) }, readChannelUpload: none,
      transcriptStore: { reconstruct: () => [], append: () => {} }, stationBridge: { request: async () => ({ ok: true }) },
      now: () => w.now, setTimeout: vSetTimeout
    });
    // the driver's delivery hooks are index.js's own, lifted out of its makeCronDriver call (a hook it stops passing is one
    // this driver lacks); the withdrawn one is watched, so P7 knows which records the cron took back
    const hooks = liftValues(CRON_CALL, ['deliverResult', 'deliveryStarted', 'deliveryWithdrawn', 'deliveryRecorded'], { deliverCronResult: rd.deliverCronResult, routineDelivery: rd });
    const driver = makeCronDriver({
      getJobs: () => jobs,
      // cron.jobs.json on the same fenced disk: a dead process writes nothing, and a write-failure span refuses it too
      setJobs: (next) => { if (gen !== w.gen || w.writeFault) return false; jobs = next; w.files.set(JOBS_FILE, JSON.stringify({ version: 1, jobs: next })); return true; },
      runOnce: async () => {}, emit: () => {}, newId: () => w.uuid(), newAbort: () => new AbortController(), now: () => w.now,
      getKey: () => 'k', defaultModel: 'sim/model', persona: 'P', warn: () => {},
      deliverResult: hooks.deliverResult, deliveryStarted: hooks.deliveryStarted, deliveryRecorded: hooks.deliveryRecorded,
      deliveryWithdrawn: hooks.deliveryWithdrawn ? (jobId, runId) => {
        const id = 'routine:' + jobId + ':' + runId + ':@origin';
        const had = !!store.ledger.delivery(id);
        hooks.deliveryWithdrawn(jobId, runId);
        if (had && !store.ledger.delivery(id)) w.withdrawn.add(id);
      } : undefined
    });
    // index.js: the pending results are asked again at boot, then on every tick
    const tick = () => { if (gen !== w.gen) return; try { driver.applyTick(w.now); } catch (e) { w.problems.push('the cron tick threw: ' + e.message); } vSetTimeout(tick, 5000); };
    vSetTimeout(tick, 5000);
    Promise.resolve(driver.recoverFinalizations()).catch((e) => w.problems.push('the boot recovery threw: ' + e.message));
    return { driver: driver, jobs: () => jobs };
  }
  // A ROUTINE FIRE (S4): its digest settled the way Run Now settles one (index.js): the lease, then the driver's settleRun
  function fireRoutine(note) {
    const c = proc && proc.cron;
    if (!c || proc.gen !== w.gen) return;
    const r = ROUTINES[Math.floor(rand3() * ROUTINES.length)];
    if (c.driver.leases.has(r.id)) return;
    const runId = 'rt' + (++w.seq);
    const lines = ['DIGEST ' + r.id + ' ' + runId];
    for (let i = 0; i < 80; i++) lines.push('D' + i + ' ' + runId + ' ' + 'q'.repeat(100));
    w.digests.push({ jobId: r.id, runId: runId, chat: r.chat, lines: lines, gen: w.gen, at: w.now });
    // now and then the digest's own chat fails a LATER part (refused twice, its answer lost, or the station dies once the
    // platform took it): the case a resend of the parts before it would show. Never the healthy chat (P3 holds it to blips).
    if (r.chat !== w.healthy && !(w.faults.get(r.chat) || []).length && rand3() < 0.5) {
      const mid = [['ok', 'retryable', 'retryable'], ['ok', 'lost'], ['ok', 'crashAfter'], ['ok', 'ok', 'retryable', 'retryable']];
      arm(r.chat, mid[Math.floor(rand3() * mid.length)]);
      note('routine:fault');
    }
    c.driver.leases.set(r.id, { runId: runId, startedAt: w.now, heartbeatAt: w.now, ac: new AbortController(), isOnce: false });
    try { c.driver.settleRun(r.id, runId, { reason: 'done', buf: lines.join('\n') }, null); }
    catch (e) { w.problems.push('a routine fire threw: ' + e.message); }
    note('routine');
  }

  let proc = null;
  w.boot = () => {
    const gen = w.gen;
    for (const t of timers.slice()) if (t.gen !== gen) vClearTimeout(t);
    const store = makeChannelStore({ fs: fsFor(gen), pathMod: pathPosix, root: ROOT, clock: { now: () => w.now }, bootId: 'boot-' + gen,
      timers: { setTimeout: vSetTimeout, clearTimeout: vClearTimeout }, holding: () => w.holding, ledgerLimits: w.limits,
      inboxLimits: { maxInbox: w.limits.maxPendingPerChannel }, outboxLimits: { maxOutbox: 6 } });
    if (gen === 0) {   // the owner admitted the group, which mentions the bot to be answered and is overheard otherwise
      store.saveChatRecord(GROUP, { admittedOn: 'telegram', requireMention: true, observeUnmentioned: true });
    }
    proc = { gen, store, tg: bootStation(gen, store), dc: bootDiscord(gen, store), bot: o.bot ? bootBot(gen, store) : null, cron: null };
    w.up();
    proc.cron = bootCron(gen, store, () => proc);
  };
  // (S6) a reconnect: this process replaces the station's Telegram hub, and whatever the old one's runs still ask for lives on
  w.reconnect = () => {
    proc.tg.hub.close();
    proc.tg = bootStation(proc.gen, proc.store);
    proc.tg.adapterBag.onStatus({ state: 'up' });
  };
  w.up = () => {
    if (!proc || proc.gen !== w.gen) return;
    try { proc.tg.adapterBag.onStatus({ state: 'up' }); } catch (e) { w.problems.push('setup: the lifted onStatus threw: ' + e.message); }
    try { proc.dc.hub.onStatus({ state: 'up' }); } catch (e) { w.problems.push('setup: discord onStatus threw: ' + e.message); }
    if (proc.bot) { try { proc.bot.adapterBag.onStatus({ state: 'up' }); } catch (e) { w.problems.push('setup: the bot onStatus threw: ' + e.message); } }
  };

  // ---- inbound: raw platform updates through each adapter's own dispatch (acknowledged = it did not throw) ----
  const pending = [];   // updates the platform still holds (not acknowledged)
  w.current = () => proc;
  /* DISCORD'S GATEWAY HANDS A MESSAGE OVER ONCE (its transport splices the buffer it filled): the platform never hands a
     refused one over again, so the sim never does either. The adapter's own intake takes it (channels/adapter.js: what
     it could not receive it keeps, and hands over again first on its next pass, which w.redeliver plays), or it is gone.
     Every message handed to a live process must end with a receipt (P5), unless that process died while it still held it. */
  w.handed = [];
  function handOver(u, adapter) {
    const ad = adapter._internals;
    w.handed.push(u);
    u.gen = w.gen; u.at = w.now;
    if (typeof ad.intake !== 'function') {   // an adapter that keeps nothing: a refused update is gone with the refusal
      try { ad.dispatch(u.raw); } catch (e) { u.dropped = true; return false; }
      acked(u, false);
      return true;
    }
    (proc.dcCarry = proc.dcCarry || []).push(u);
    intakePass([u.raw]);
    if (!u.acked) u.carried = true;   // its adapter keeps it for its next pass
    return !!u.acked;
  }
  // one pass of the Discord adapter's intake: what it carries first, then `raws`; what it no longer carries was received
  function intakePass(raws) {
    const ad = proc.dc.adapter._internals;
    const q = proc.dcCarry || (proc.dcCarry = []);
    try { ad.intake(raws); } catch (e) { w.problems.push('the Discord adapter\'s intake threw: ' + ((e && e.message) || e)); }
    const done = q.splice(0, Math.max(0, q.length - ad.carried));
    for (const x of done) acked(x, false);
  }
  function deliverUpdate(u) {
    if (!proc || proc.gen !== w.gen) { pending.push(u); return false; }
    const ends = u.via === 'discord' ? proc.dc : (u.via === 'bot' ? proc.bot : proc.tg);
    const adapter = ends && ends.adapter;
    if (!adapter) return false;
    if (u.via === 'discord') return handOver(u, adapter);
    // a correction counts only when it edits the message the hub heard last in that chat (its own rule, read just before
    // the update reaches it): such an edit must run, and the oracle holds it to that
    let current = false;
    if (u.kind === 'correction') { try { current = ends.hub._internals.editIsCurrent({ chatId: u.raw.edited_message.chat.id, messageId: u.raw.edited_message.message_id }) === true; } catch (_) { current = false; } }
    try { adapter._internals.dispatch(u.raw); }
    catch (e) { pending.push(u); return false; }
    acked(u, current);
    return true;
  }
  function acked(u, current) {
    u.acked = true;
    if (u.kind === 'stop') w.stopAcks.push({ chat: u.chat, at: w.now, gen: w.gen });   // the owner's "stop": an outcome for the run it stops
    for (const t of u.tags) if (!w.acked.has(t)) w.acked.set(t, { kind: u.kind, chat: u.chat, at: w.now, gen: w.gen, rid: u.rid || '' });
    if (u.kind === 'tap') w.taps.push({ cb: u.cb, tag: u.tags[0], chat: u.chat, gen: w.gen, at: w.now, kb: u.kb });
    if (u.kind === 'correction') {
      // kept but not run yet (its chat's lane is over the mark): when the recover timer runs it, a newer message may have
      // made it an edit of an older one — a build with a ledger says so in the receipt it wrote
      const em = u.raw.edited_message;
      const deferred = w.deferredIds.has(u.chat + '|' + em.message_id + '|edited@' + em.edit_date);
      w.corrections.push({ tag: u.tags[0], chat: u.chat, current: current, deferred: deferred, gen: w.gen, at: w.now });
    }
  }
  w.redeliver = () => {
    const q = pending.splice(0);
    for (const u of q) deliverUpdate(u);
    // the Discord adapter's next pass: what it kept goes first (its poll loop does this after its backoff)
    if (proc && proc.gen === w.gen && proc.dcCarry && proc.dcCarry.length && typeof proc.dc.adapter._internals.intake === 'function') intakePass([]);
  };
  function tgRaw(chatId, text, from, edited, editDate) {
    const id = edited ? edited : ++w.tgMsgId;
    const m = { message_id: id, from: { id: Number(from), is_bot: false, first_name: from === OWNER ? 'Ana' : 'Bo' }, chat: { id: Number(chatId), type: String(chatId).charAt(0) === '-' ? 'supergroup' : 'private' }, date: Math.floor(w.now / 1000), text };
    // an edit carries WHEN it was made (whole seconds, as Telegram sends it)
    if (edited) m.edit_date = editDate != null ? editDate : Math.floor(w.now / 1000);
    // an @mention reaches a bot as a 'mention' entity (the adapter reads no other form of it), as Telegram sends it
    const at = String(text).indexOf('@simbot ');
    if (at >= 0) m.entities = [{ type: 'mention', offset: at, length: 7 }];
    return edited ? { update_id: ++w.updateId, edited_message: m } : { update_id: ++w.updateId, message: m };
  }
  w.inbound = (chat, kind, opt) => {
    const tag = String(++w.tags);
    const sub = opt || {};
    let text = typeof sub.text === 'function' ? sub.text(tag) : (sub.text || ('please #' + tag));
    const tags = sub.noTag ? [] : [tag];
    let u;
    if (chat === CHATS.dcDm) {
      u = { via: 'discord', chat, kind, tags, raw: { id: String(++w.discordId), channel_id: OWNER, author: { id: DC_OWNER, username: 'ana' }, content: text } };
      u.rid = 'discord|' + OWNER + '|' + u.raw.id;
    } else {
      const chatId = chat === CHATS.tgGroup ? GROUP : OWNER;
      if (chat === CHATS.tgGroup && kind !== 'observe' && !sub.raw) text = '@simbot ' + text;
      const via = chat === CHATS.botDm ? 'bot' : 'telegram';
      const raw = sub.edit ? tgRaw(chatId, text, OWNER, sub.edit, sub.editDate) : tgRaw(chatId, text, sub.from || OWNER);
      if (!sub.edit) { w.lastTgMsg.set(chat, raw.message.message_id); w.heard.add(chat + '#' + raw.message.message_id); }
      u = { via, chat, kind, tags, raw };
      if (!sub.edit) u.rid = chat + '|' + raw.message.message_id;   // its receipt's id ('<channel>|<chatId>|<messageId>')
    }
    const gen = w.gen;
    w.lastAck = deliverUpdate(u);
    // (P3) the healthy chat's message refused at intake by a live process whose writes work: another chat's doing
    if (chat === w.healthy && kind === 'message' && !w.lastAck && proc && proc.gen === gen && gen === w.gen && !w.writeFault && !w.holding) w.healthyRefused.push({ tag: tag, at: w.now });
    return tag;
  };
  w.healthyRefused = [];
  /* A TAP on one of a keyboard's buttons (S3): the owner's callback_query for the message the keyboard rode, with that
     button's callback_data. Its tag is the option's ('choose #<tag>'). Telegram hands an unacknowledged tap over again
     with the same callback id. */
  w.tap = (kb, idx) => {
    const cb = 'cbq' + seed + '-' + (++w.cbSeq);
    const chatId = kb.chat.slice(kb.chat.lastIndexOf('|') + 1);
    const raw = { update_id: ++w.updateId, callback_query: { id: cb, from: { id: Number(OWNER), is_bot: false, first_name: 'Ana' }, chat_instance: 'ci' + chatId,
      message: { message_id: kb.messageId, chat: { id: Number(chatId), type: chatId.charAt(0) === '-' ? 'supergroup' : 'private' }, date: Math.floor(kb.at / 1000), text: kb.text },
      data: kb.data[idx] } };
    kb.taps++;
    w.lastAck = deliverUpdate({ via: kb.chat === CHATS.botDm ? 'bot' : 'telegram', chat: kb.chat, kind: 'tap', tags: kb.tags.length ? [kb.tags[idx]] : [], raw, cb, kb });
    return cb;
  };
  w.membership = (status) => {
    const raw = { update_id: ++w.updateId, my_chat_member: { chat: { id: Number(GROUP), type: 'supergroup' }, from: { id: Number(OWNER) }, date: Math.floor(w.now / 1000),
      old_chat_member: { status: status === 'kicked' ? 'member' : 'kicked' }, new_chat_member: { status, user: { id: 1, is_bot: true } } } };
    if (status === 'kicked') { w.kicked.add(CHATS.tgGroup); w.kickLog.push({ chat: CHATS.tgGroup, at: w.now }); } else w.kicked.delete(CHATS.tgGroup);
    deliverUpdate({ via: 'telegram', chat: CHATS.tgGroup, kind: 'membership', tags: [], raw });
  };
  /* A CORRECTION (S3): a new message, then the member edits it twice, the edits more than a second apart (so each carries
     its own edit_date) and the second while the first edit's run still works. Each edit of the latest message must run;
     a build that keys an edit by the message alone takes the second for Telegram handing the first over again. */
  w.correct = async (chat) => {
    const m = w.inbound(chat, 'message');
    w.plans.set(m, altPlan());
    const mid = w.lastTgMsg.get(chat);
    await w.advance(500 + Math.floor(rand2() * 300));            // past the 350 ms batch window: the hub heard it
    const e1 = w.inbound(chat, 'correction', { edit: mid });
    w.plans.set(e1, { steps: 2, stepMs: 1000, long: false, question: false });
    await w.advance(1100 + Math.floor(rand2() * 300));           // a new second: its own edit_date
    const e2 = w.inbound(chat, 'correction', { edit: mid });
    w.plans.set(e2, altPlan());
    return [m, e1, e2];
  };
  /* A TAP (S3): mostly the newest untapped keyboard a live process sent to a Telegram chat; sometimes any keyboard, a dead
     process's included (its buttons died with it: the tap must be refused and nothing run); and sometimes a second button
     of the keyboard just tapped (single-use: refused, nothing run). Now and then the station dies while the tapped choice
     is being worked on (never across a write-failure span: the crash boundary above). */
  async function tapOne(note) {
    const chats = [CHATS.tgDm, CHATS.tgGroup].concat(o.bot ? [CHATS.botDm] : []);
    const kbs = w.keyboards.filter(k => chats.indexOf(k.chat) >= 0 && k.data.length >= 2 && k.tags.length === k.data.length);
    if (!kbs.length) return;
    let kb;
    if (rand2() < 0.15) kb = kbs[Math.floor(rand2() * kbs.length)];
    else { const live = kbs.filter(k => k.gen === w.gen && !k.taps); if (!live.length) return; kb = live[live.length - 1]; }
    const idx = Math.floor(rand2() * kb.data.length);
    w.tap(kb, idx); note('tap');
    const took = w.lastAck;
    if (rand2() < 0.2) { w.tap(kb, (idx + 1) % kb.data.length); note('tap:double'); }
    if (took && rand2() < 0.35) {
      await w.advance(50 + Math.floor(rand2() * 600));
      const working = [...w.live.values()].some(r => r.gen === w.gen && r.tags.indexOf(kb.tags[idx]) >= 0);
      if (working && canCrash()) { w.crash('while a tapped choice was worked on'); note('crash:tap'); }
    }
  }

  // ---- one step of the script ----
  const sendChats = () => [CHATS.tgDm, CHATS.tgGroup, CHATS.dcDm].concat(o.bot ? [CHATS.botDm] : []);
  const faultChats = () => sendChats().filter(c => c !== w.healthy);
  function arm(chat, list) { const q = w.faults.get(chat) || []; w.faults.set(chat, q.concat(list)); }
  // the healthy chat's own blip: ONE failed send of a reply (two transport failures — the adapter's bounded resend fails
  // too), so its lane backs off once (5 s). Never while one is armed, nor within 10 s of the last: its backoff never grows.
  function blip() {
    if ((w.faults.get(w.healthy) || []).length || w.now - w.blipAt < 10000) return false;
    arm(w.healthy, ['blip', 'blip']);
    return true;
  }
  w.step = async () => {
    w.stats.steps++;
    if (!proc || proc.gen !== w.gen) { await drain(8); w.boot(); }
    for (const s of w.spans.slice()) if (s.until <= w.now) { w.spans.splice(w.spans.indexOf(s), 1); s.end(); }
    w.redeliver();
    const r = rand();
    const note = (k) => { w.stats.actions[k] = (w.stats.actions[k] || 0) + 1; };
    if (r < 0.34) {
      const chat = pick(sendChats());
      w.inbound(chat, 'message');
      if (rand() < 0.3 && chat !== CHATS.dcDm) { await w.advance(120); w.inbound(chat, 'message'); note('batch'); }
      note('message');
    } else if (r < 0.40) {
      // a follow-up to a run working in a direct chat (a group's runs are never steered): it names its tag (its plan, should
      // it run, from S3's stream), and joined to the working run or run, it is acted on once (P5)
      const dms = { ['channel:telegram:' + OWNER]: CHATS.tgDm, ['channel:discord:' + OWNER]: CHATS.dcDm };
      const run = [...w.live.values()].find(x => x.gen === w.gen && dms[x.chat]) || [...w.live.values()].find(x => x.gen === w.gen);
      if (run) { w.plans.set(String(w.tags + 1), altPlan()); w.inbound(dms[run.chat] || CHATS.tgDm, 'followup', { text: (t) => 'also note this #' + t }); note('followup'); }
    } else if (r < 0.43) {
      w.inbound(CHATS.tgDm, 'stop', { text: 'stop', noTag: true }); note('stop');
    } else if (r < 0.46) {
      const chat = pick([CHATS.tgDm, CHATS.dcDm]);
      if (rand2() < 0.5) { w.inbound(chat, 'slash', { text: (t) => '/routine add every day | water the plants #' + t }); note('slash'); }
      else { w.inbound(chat, 'command', { text: '/status', noTag: true }); note('command'); }
    } else if (r < 0.49) {
      w.inbound(CHATS.tgGroup, 'observe', { text: 'just chatting here', noTag: true, from: '777' }); note('observe');
    } else if (r < 0.52) {
      // an edit: of an older message (settled unrun), or (S3) a correction of the latest one, twice
      if (rand2() < 0.6) { await w.correct(CHATS.tgDm); note('correction'); }
      else {
        const last = w.lastTgMsg.get(CHATS.tgDm);
        if (last && last > 1001) { w.inbound(CHATS.tgDm, 'edit', { text: 'an edit of an older message', noTag: true, edit: last - 1 }); note('edit'); }
      }
    } else if (r < 0.64) {
      const chat = pick(faultChats());
      const kinds = ['retryable', 'retryable', 'lost', 'permanent', 'crashAfter', 'crashBefore'];
      const k = pick(kinds);
      arm(chat, k === 'retryable' ? new Array(1 + Math.floor(rand() * 4)).fill('retryable') : (k === 'permanent' ? ['retryable', 'permanent'] : [k]));
      note('fault:' + k);
      // the healthy chat has the odd blip of its own: its reply must then land on its own lane's first retry, whatever
      // the failing chat's head is doing
      if (rand() < 0.5 && blip()) note('blip');
    } else if (r < 0.67) {
      // a refused credential: the channel (never the healthy chat's) holds until its next 'up'
      const chat = w.healthy === CHATS.dcDm ? CHATS.tgGroup : CHATS.dcDm;
      arm(chat, ['auth']); note('fault:auth');
    } else if (r < 0.70) {
      w.crashOnWrite = pick(['receipt', 'answer']); note('crash:' + w.crashOnWrite);
    } else if (r < 0.73) {
      if (!w.writeFault && !w.spans.some(s => s.kind === 'write')) {
        w.writeFault = pick(['EBUSY', 'UPDATE_MUTATIONS_FROZEN']); w.disrupted = w.now;
        const span = 1500 + Math.floor(rand() * 4000);
        w.spans.push({ kind: 'write', until: w.now + span, end: () => { w.writeFault = ''; w.disrupted = w.now; } });
        note('span:write');
        // (review round 1) now and then the station dies inside the span — a crash, or a user restarting a station that
        // stopped replying — while a run may be starting or between its tool steps (S3's stream draws it)
        if (rand2() < 0.6) {
          const at = 200 + Math.floor(rand2() * (span - 200));
          vSetTimeout(() => { if (w.writeFault && proc && proc.gen === w.gen) { w.crash('during a write-failure span'); note('crash:write-span'); } }, at);
        }
      }
    } else if (r < 0.76) {
      if (!w.holding) {
        w.holding = true; w.disrupted = w.now;
        w.spans.push({ kind: 'hold', until: w.now + 1000 + Math.floor(rand() * 3000), end: () => { w.holding = false; w.disrupted = w.now; } });
        note('span:hold');
      }
    } else if (r < 0.79) {
      if (!w.kicked.has(CHATS.tgGroup) && w.healthy !== CHATS.tgGroup) {
        w.membership('kicked'); note('kick');
        w.spans.push({ kind: 'kick', until: w.now + 3000 + Math.floor(rand() * 6000), end: () => { w.membership('member'); w.inbound(CHATS.tgGroup, 'admit', { text: '/allow', noTag: true, raw: true }); } });
      }
    } else if (r < 0.82) {
      // a lane pushed past its mark and the channel's receipt cap: a burst into one failing chat
      const chat = pick(faultChats());
      arm(chat, new Array(6).fill('retryable'));
      for (let i = 0; i < 5; i++) w.inbound(chat, 'message');
      note('burst');
    } else if (r < 0.85) {
      // a chat that keeps failing (a flood wait, its side of the platform down): every send to it fails retryably for
      // 20-50 s while its members keep writing; another chat on the healthy chat's own channel when there is one (one
      // queue per channel puts its head in front of the healthy chat's replies). The healthy chat, writing too, blips.
      if (!w.spans.some(s => s.kind === 'down')) {
        const same = faultChats().filter(c => c.split('|')[0] === w.healthy.split('|')[0]);
        const chat = same.length && rand() < 0.75 ? pick(same) : pick(faultChats());
        w.down.add(chat);
        w.spans.push({ kind: 'down', until: w.now + 20000 + Math.floor(rand() * 30000), end: () => { w.down.delete(chat); } });
        w.inbound(chat, 'message');
        if (blip()) note('blip');
        await w.advance(1500 + Math.floor(rand() * 1000));
        w.inbound(w.healthy, 'message');
        note('span:down');
      }
    } else {
      w.up(); note('up');
    }
    // (S3) now and then the owner taps a keyboard
    if (rand2() < 0.3) await tapOne(note);
    // (S4) now and then a routine fires
    if (rand3() < 0.18) fireRoutine(note);
    await w.advance(250 + Math.floor(rand() * 2000));
    w.checkHealthy();
  };

  // ---- the oracle ----
  const stripHeader = (t) => String(t).replace(new RegExp('^' + HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?'), '');
  const wireLines = (chat) => { const out = []; for (const m of w.wire) if (m.chat === chat) for (const l of stripHeader(m.text).split('\n')) if (l && l !== HEADER) out.push(l); return out; };
  const windowLines = (chat) => { const out = new Map(); for (const e of w.windows) if (e.chat === chat && !e.discord) for (const l of stripHeader(e.text).split('\n')) if (l) out.set(l, (out.get(l) || 0) + 1); return out; };
  // what a reply's chat must show: a question as its hub renders it (Discord's hub has no TaskIntent: as the run wrote it)
  const textIn = (rep, chat) => (rep.raw && String(chat).indexOf('discord|') === 0 ? rep.raw : rep.text);
  /* A FINISHED REPLY IS THE RUN HOST'S FACT (review round 1). The oracle took "finished" from what reached delivery.json,
     the system under test's own record, so a reply the hub never wrote was never finished, and a hub that settled a
     message's receipts without writing its answer lost replies in every chat with P1 and P3 green. Now every run that ended
     'done' must land, in its own chat (its task key), unless the record outside the delivery says it may not:
       · its signal was aborted by the instant it ended: a newer message, a stop or E-STOP took it back, and the hub drops
         its partial and says so (an abort later in that instant, after its answer was written, is the durable clause's);
       · its process died in that very instant: the answer write may not have run (the message's attempt rule applies);
       · its writes were failing when it ended, and its process died before any later write reached the disk: the answer
         stayed in memory (the attempt rule applies).
     A reply that reached delivery.json lands whatever happened after (the durable clause below); P2 orders replies by
     when they reached it. A tree without a ledger is judged by the same run-host facts. */
  function finishedReplies() {
    const out = [];
    for (const run of w.runs) {
      if (run.ended !== 'done' || !run.chatKey) continue;
      const rep = w.replies.get(run.runId);
      if (!rep) continue;
      if (run.abortedAt != null && run.abortedAt <= run.endedAt) continue;
      const crash = w.crashLog.find(c => c.gen === run.gen && c.at >= run.endedAt);
      if (crash && (crash.at === run.endedAt || (run.endFault && crash.lastGood < run.endSeq))) continue;
      out.push({ runId: run.runId, chat: run.chatKey, text: textIn(rep, run.chatKey), at: run.endedAt, gen: run.gen });
    }
    return out;
  }
  /* A REPLY MAY BE GIVEN UP ONLY ON A FACT AT THE TRANSPORT EDGE (review round 1). P1, P6 and the durable clause excused
     every 'undeliverable' or 'redelivery-gave-up' tombstone, so a reply given up on a 502 (a retryable failure taken for a
     refusal for good) passed. It may be given up when the platform refused one of its parts for good (400, 403: the fake
     platform's own answer), or when its chat removed the bot between the moment it was finished and the moment it was
     given up (every send to that chat is then refused 403, its delayed-reply line sent on its own too). */
  function refusedLinesOf(chat) {
    const s = new Set();
    for (const r of w.refusals) if (r.chat === chat) for (const l of stripHeader(r.text).split('\n')) if (l && l !== HEADER) s.add(l);
    return s;
  }
  function givenUpFairly(chat, lines, at, tombId) {
    const refused = refusedLinesOf(chat);
    if (lines.some(l => l && refused.has(l))) return true;
    const until = w.tombAt.get(tombId);
    return until != null && w.kickLog.some(k => k.chat === chat && k.at >= at && k.at <= until);
  }
  w.debug = { finishedReplies: () => finishedReplies(), stripHeader: (t) => stripHeader(t) };
  // what S4's routine fires drew (the property and the soak assert it: a clause over nothing proves nothing)
  w.routineMix = () => {
    const landed = w.digests.filter(d => wireLines(d.chat).indexOf(d.lines[0]) >= 0).length;
    const retried = w.digests.filter(d => w.attempts.filter(a => a.chat === d.chat && String(a.text).indexOf(d.lines[0]) >= 0).length > 1).length;
    return { fired: w.digests.length, landed: landed, retried: retried, withdrawn: w.withdrawn.size };
  };
  // what review round 1's clauses stand on (the property and the soak assert it was drawn): a crash inside a write-failure
  // span, a follow-up that joined a working run, a slash command the registry ran, a Discord message kept through a refusal
  w.xmix = () => ({ crashInWriteSpan: w.stats.actions['crash:write-span'] || 0, followupsJoined: w.steered.filter(s => /also note this #[0-9]+/.test(s.text)).length,
    slashCommands: w.slashCalls.length, discordKept: w.handed.filter(u => u.carried && u.acked).length });
  // what S3's inbound drew (the property and the soak assert it was drawn: a clause over nothing proves nothing)
  w.mix = () => {
    const refused = w.taps.filter(t => /no longer (open|available)/.test((w.toasts.get(t.cb) || {}).text || '')).length;
    return { tapsTaken: w.taps.length - refused, tapsRefused: refused, tapCrashes: w.stats.actions['crash:tap'] || 0,
      corrections: w.corrections.filter(c => c.current && !c.deferred).length };
  };
  w.checkHealthy = () => {
    if (w.holding || w.writeFault) return;   // the update barrier or failing writes hold every chat: not another chat's doing
    const chat = w.healthy;
    const lines = new Set(wireLines(chat));
    const fail = (p) => { w.problems.push(p); w.checkHealthy = () => {}; };
    for (const f of finishedReplies()) {
      // within one drain: a blip of its own costs the adapter's 1 s resend and its lane's first 5 s retry; another chat's
      // head, down for 20-50 s, costs it nothing. A hold or a write-failure span that ended since restarts its clock.
      const from = Math.max(f.at, w.disrupted);
      if (f.chat !== chat || from > w.now - 16000 || f.gen !== w.gen) continue;
      const first = f.text.split('\n')[0];
      if (!lines.has(first)) return fail('P3 the healthy chat ' + chat + ' still waits for reply ' + f.runId + ' (finished at +' + (f.at - T0) + ' ms, now +' + (w.now - T0) + ' ms)');
    }
    /* (review round 1) ...and its messages get IN, whatever another chat does: one chat whose sends keep failing while its
       members keep talking must not fill the channel's intake. A message the healthy chat sent is acknowledged, unless a
       crash, a hold or failing writes came within the 16 s before it, and reaches a run (or joins the one working) within
       one drain — a message its own lane held back (its own replies owed) is its own backpressure, not another chat's. */
    for (const r of w.healthyRefused) {
      if (r.at - w.disrupted < 16000) continue;
      return fail('P3 the healthy chat ' + chat + '\'s message #' + r.tag + ' was refused at intake at +' + (r.at - T0) + ' ms (another chat holds the channel\'s intake)');
    }
    for (const [tag, a] of w.acked) {
      if (a.chat !== chat || a.kind !== 'message' || a.gen !== w.gen || Math.max(a.at, w.disrupted) > w.now - 16000 || w.deferredIds.has(a.rid)) continue;
      const re = new RegExp('#' + tag + '(?!\\d)');
      if (w.runs.some(r => r.tags.indexOf(tag) >= 0) || w.steered.some(s => re.test(s.text))) continue;
      return fail('P3 the healthy chat ' + chat + '\'s message #' + tag + ' (acknowledged at +' + (a.at - T0) + ' ms) has not reached a run by +' + (w.now - T0) + ' ms');
    }
  };
  // the tail: nothing new is drawn for `ms` while what was drawn plays out (a chat that is down stays down until its span
  // ends), and P3 is checked every second
  w.tail = async (ms) => {
    for (let t = 0; t < ms; t += 1000) {
      if (!proc || proc.gen !== w.gen) { await drain(8); w.boot(); }
      for (const s of w.spans.slice()) if (s.until <= w.now) { w.spans.splice(w.spans.indexOf(s), 1); s.end(); }
      w.redeliver();
      await w.advance(1000);
      w.checkHealthy();
    }
  };
  w.quiesce = async () => {
    w.faults.clear(); w.crashOnWrite = ''; w.editFaults.length = 0;
    for (const s of w.spans.splice(0)) s.end();
    w.writeFault = ''; w.holding = false;
    for (let i = 0; i < 40; i++) {
      if (!proc || proc.gen !== w.gen) { await drain(8); w.boot(); }
      w.redeliver();
      w.up();
      await w.advance(31000);
    }
  };
  w.oracle = () => {
    const P = w.problems;
    for (const c of w.contract) P.push('contract: ' + c);
    const tombed = new Set(w.events.filter(e => e.reason === 'undeliverable' || e.reason === 'redelivery-gave-up').map(e => e.runId));
    const refused = new Set(w.held.map(h => h.chat + '\u0000' + stripHeader(h.text).split('\n')[0]));
    // P1: every finished reply lands line for line, exactly once (one extra copy per logged Telegram window event), unless
    // the platform refused it for good or its chat removed the bot (givenUpFairly)
    for (const f of finishedReplies()) {
      const lines = wireLines(f.chat), allow = windowLines(f.chat);
      const all = f.text.split('\n');
      const tomb = w.tombs.get('reply:' + f.runId);
      const fair = givenUpFairly(f.chat, all, f.at, 'reply:' + f.runId);
      for (const l of all) {
        if (!l) continue;
        const n = lines.filter(x => x === l).length;
        const max = 1 + (allow.get(l) || 0);
        if (n < 1) {
          if (!fair) P.push('P1 ' + f.chat + ' reply ' + f.runId + ' never landed line "' + l.slice(0, 40) + '"' + (tomb ? ' (given up as ' + tomb + ', and the platform never refused it for good)' : ''));
          break;
        }
        if (n > max) { P.push('P1 ' + f.chat + ' reply ' + f.runId + ' line "' + l.slice(0, 40) + '" landed ' + n + 'x (window allows ' + max + ')'); break; }
      }
    }
    // P2: per chat, durable replies land in the order they finished (first copies). A reply finishes when its answer is
    // durable: on a build with a ledger, the order replies reached delivery.json; otherwise the order of their first events
    const byChat = new Map();
    const finished = finishedReplies();
    const durableOrder = [...w.durable.values()].map(d => d.runId);
    if (durableOrder.length) finished.sort((a, b) => { const ia = durableOrder.indexOf(a.runId), ib = durableOrder.indexOf(b.runId); return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); });
    for (const f of finished) { if (tombed.has(f.runId)) continue; if (!byChat.has(f.chat)) byChat.set(f.chat, []); byChat.get(f.chat).push(f); }
    for (const [chat, list] of byChat) {
      const order = w.wire.filter(m => m.chat === chat).map(m => stripHeader(m.text).split('\n')[0]);
      const firsts = list.map(f => order.indexOf(f.text.split('\n')[0])).filter(i => i >= 0);
      for (let i = 1; i < firsts.length; i++) if (firsts[i] < firsts[i - 1]) { P.push('P2 ' + chat + ' replies landed out of their finish order'); break; }
    }
    // P4: no (message, tool step) pair runs twice
    for (const [k, n] of w.journal) if (n > 1) P.push('P4 tool step ' + k + ' ran ' + n + 'x');
    // P5: every acknowledged message has exactly one terminal outcome, and nothing is left pending
    const runsOf = (tag) => w.runs.filter(r => r.tags.indexOf(tag) >= 0);
    for (const [tag, a] of w.acked) {
      if (a.kind !== 'message' && a.kind !== 'correction' && a.kind !== 'tap' && a.kind !== 'followup') continue;
      const rs = runsOf(tag);
      if (rs.length > 2) P.push('P5 message #' + tag + ' ran ' + rs.length + 'x');
      else if (rs.length === 2 && (w.journal.get(rs[0].tags.join('+') + '#0') || 0) > 0 && rs[0].tags.join('+') === rs[1].tags.join('+')) P.push('P5 message #' + tag + ' ran again after its first run began a tool step');
    }
    /* P5 (review round 1) A FOLLOW-UP AND A COMMAND ARE ACTED ON ONCE. A follow-up steered into the working run, and a
       command the slash registry ran, settled only once routeInbound resolved, after its ack had been on the wire: the
       station dying in that window replayed it as a new message — the follow-up ran as a task of its own, the command ran
       again. Now a follow-up joins the working run or runs, never both and never twice (the one exception: the station died
       in the very instant it joined, before anything else could happen), and a command runs at most once. */
    const tagged = (t) => new RegExp('#' + t + '(?!\\d)');
    for (const [tag, a] of w.acked) {
      if (a.kind === 'followup') {
        const steers = w.steered.filter(s => tagged(tag).test(s.text));
        const rs = runsOf(tag);
        const instant = steers.some(s => w.crashLog.some(c => c.gen === s.gen && c.at === s.at));
        // twice: joined twice; or joined, then run (its replay a task of its own); or run with a tool step begun, then joined.
        // A run cut before any tool step and then, on its second go, joined to the run working then, is its one second go
        const ranAfter = steers.length && rs.some(r => r.startedAt >= steers[0].at);
        const steppedFirst = steers.length && rs.some(r => r.startedAt < steers[0].at && (w.journal.get(r.tags.join('+') + '#0') || 0) > 0);
        if ((steers.length > 1 || ranAfter || steppedFirst) && !instant) P.push('P5 the follow-up #' + tag + ' was acted on ' + (steers.length + rs.length) + 'x (joined the working run ' + steers.length + 'x, ran ' + rs.length + 'x)');
      }
      if (a.kind === 'slash') {
        const calls = w.slashCalls.filter(c => tagged(tag).test(c.line));
        if (calls.length > 1) P.push('P5 the command #' + tag + ' in ' + a.chat + ' ran ' + calls.length + 'x');
      }
    }
    // one notice per message; a notice the platform took in a logged window may land once more
    const seen = new Map();
    for (const m of w.wire) if (/NOT run again/.test(m.text)) { const k = m.chat + ' ' + (m.text.match(/#\d+/g) || []).join(','); seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [k, n] of seen) {
      const chat = k.split(' ')[0], tags = k.slice(chat.length + 1);
      const windows = w.windows.filter(e => e.chat === chat && /NOT run again/.test(e.text) && (e.text.match(/#\d+/g) || []).join(',') === tags && !e.discord).length;
      if (tags && n > 1 + windows) P.push('P5 message ' + tags + ' in ' + chat + ' got ' + n + ' "not run again" notices');
    }
    for (const a of w.answerProblems) P.push(a);
    /* P5 (review round 1) EVERY MESSAGE A PLATFORM HANDED OVER IS RECEIVED. Discord's gateway hands a message over once; a
       receipt the hub could not write at that moment (a failing write, a full intake) must not lose it. A message handed
       to a process that then died while it still held it is the one exception (nothing could have kept it). */
    for (const u of w.handed) {
      if (u.acked || u.lostWithProcess) continue;
      P.push('P5 the ' + u.via + ' message ' + (u.tags.length ? '#' + u.tags.join('+') : JSON.stringify(String(u.raw && u.raw.content || '').slice(0, 30))) + ' in ' + u.chat
        + ', handed over at +' + (u.at - T0) + ' ms, never got a receipt' + (u.dropped ? ' (its refused receipt dropped it: the platform does not hand it over again)' : ''));
    }
    /* P5 (S3) CORRECTIONS: an acknowledged edit of the message the hub heard last in its chat runs — the second correction
       of one message too, never taken for a redelivery of the first. (An edit the receipt kept deferred may meet a newer
       message before it runs, and is then an edit of an older one: settled unrun.) */
    const tagRe = (t) => new RegExp('#' + t + '(?!\\d)');
    for (const c of w.corrections) {
      if (!c.current || c.deferred) continue;
      if (!runsOf(c.tag).length) P.push('P5 the correction #' + c.tag + ' in ' + c.chat + ' (an edit of the latest message, acknowledged at +' + (c.at - T0) + ' ms) never ran');
    }
    /* P5 (S3) CHOICE TAPS: a tap the adapter acknowledged that took its button ends exactly once: its choice ran and was
       answered (or refused for good, said once), or was told it was interrupted and not run again, or was stopped or
       superseded by a newer message, or joined a live run. A crash anywhere after the acknowledgement changes nothing:
       the tap is a durable receipt like any message. A tap refused as no longer open runs nothing. */
    const refusedToast = (t) => !!t && /no longer (open|available)/.test(t.text);
    const takenTags = new Set(w.taps.filter(t => !refusedToast(w.toasts.get(t.cb))).map(t => t.tag));
    for (const t of w.taps) {
      const toast = w.toasts.get(t.cb);
      const rs = runsOf(t.tag);
      if (refusedToast(toast)) {
        if (!takenTags.has(t.tag) && rs.length) P.push('P5 the tap ' + t.cb + ' in ' + t.chat + ' was refused ("' + toast.text + '") yet its choice #' + t.tag + ' ran ' + rs.length + 'x');
        continue;
      }
      const re = tagRe(t.tag);
      const answered = w.wire.some(m => m.chat === t.chat && stripHeader(m.text).split('\n')[0].indexOf('REPLY ' + t.tag + ' ') === 0)
        || rs.some(r => tombed.has(r.runId));
      const noticed = w.wire.some(m => m.chat === t.chat && /NOT run again/.test(m.text) && re.test(m.text));
      // stopped: it ended cancelled, or the owner's "stop" in its chat aborted it (its message settles with the stop: a crash
      // before it unwinds leaves nothing to replay, and that is the outcome the owner asked for)
      const ended = rs.some(r => r.ended === 'cancelled' || (r.abortedAt != null && w.stopAcks.some(x => x.chat === t.chat && x.gen === r.gen && x.at <= r.abortedAt)));
      const steered = w.steered.some(s => re.test(s.text));
      if (!answered && !noticed && !ended && !steered) {
        P.push('P5 the tapped choice #' + t.tag + ' in ' + t.chat + ' (tap ' + t.cb + ', acknowledged at +' + (t.at - T0) + ' ms' + (toast ? '' : ', its answer never sent') + ') has no outcome: '
          + rs.length + ' run(s) ' + JSON.stringify(rs.map(r => r.ended || 'cut')) + ', no reply, no notice');
      }
    }
    // ...and its keyboard is stamped once at most (a replay after a crash never stamps it again)
    const stampsOf = new Map();
    for (const s of w.stamps) { const k = s.chat + ' message ' + s.messageId; stampsOf.set(k, (stampsOf.get(k) || 0) + 1); }
    for (const [k, n] of stampsOf) if (n > 1) P.push('P5 the keyboard in ' + k + ' was stamped ' + n + 'x');
    // ...and a tap's answer quotes nothing: a reply only ever quotes a message a member sent in that chat
    for (const m of w.wire) if (m.replyTo && !w.heard.has(m.chat + '#' + m.replyTo)) P.push('P5 a reply in ' + m.chat + ' quotes message ' + m.replyTo + ', which no member sent');
    // P1 (durability): every delivery that reached delivery.json lands, or is given up on a fact at the transport edge and
    // said so (a ledger build only); a record the cron took back with nothing of it sent is the routine clause's (P7)
    for (const [id, d] of w.durable) {
      if (w.withdrawn.has(id) || !d.first) continue;   // taken back with nothing of it sent; a keyboard's stamp has no words
      if (w.tombs.has(id)) {
        if (!givenUpFairly(d.chat, d.lines || [d.first], d.at, id)) P.push('P1 the durable delivery ' + id + ' in ' + d.chat + ' was given up (' + w.tombs.get(id) + '), and the platform never refused it for good');
        continue;
      }
      if (!w.wire.some(m => m.chat === d.chat && stripHeader(m.text).split('\n')[0] === d.first)) P.push('P1 the durable delivery ' + id + ' in ' + d.chat + ' never landed');
    }
    const left = [];
    for (const [p, text] of w.files) {
      if (/\/delivery\.json$/.test(p)) { try { for (const r of (JSON.parse(text).receipts || [])) left.push(r.id); } catch (_) { left.push('unreadable ledger'); } }
      if (/\/inbox\.json$/.test(p)) { try { for (const r of (JSON.parse(text).items || [])) left.push(r.id); } catch (_) { left.push('unreadable inbox'); } }
    }
    if (left.length) P.push('P5 receipts still pending after everything drained: ' + left.slice(0, 4).join(', ') + (left.length > 4 ? ' …' : ''));
    // P6: a refusal for good is reported once and never retried; no finished reply is dropped for capacity
    const undeliverable = new Map();
    // a report whose tombstone never reached the disk (its process made it after its last durable write, and died before
    // the next) is in the window: the next process does not know of it, tries once more, and reports it again
    const unwritten = (e) => w.crashLog.some(c => c.gen === e.gen && c.lastGood < e.seq);
    for (const e of w.events) if (e.reason === 'undeliverable' && e.runId && !unwritten(e)) undeliverable.set(e.runId, (undeliverable.get(e.runId) || 0) + 1);
    // ...a REPLY: a merged batch's answer that died in its write never was one (a build with a ledger says which were). Each
    // of its messages replays under the attempt rule with a '↻ running it again' notice of its own, naming that run, and in
    // a chat that removed this bot each notice is refused on its own
    const wasReply = (runId) => !w.durable.size || w.durable.has('reply:' + runId);
    for (const [runId, n] of undeliverable) if (n > 1 && wasReply(runId)) P.push('P6 undeliverable reply ' + runId + ' reported ' + n + 'x');
    for (const h of w.held) {
      if (h.text === HEADER || !/^REPLY /.test(stripHeader(h.text))) continue;   // the delayed line and ephemeral texts are shared
      // a refusal in a logged window died with its process: a later process did not know of it (the process that heard
      // it may never try again)
      const tries = w.attempts.slice(h.after).filter(a => a.chat === h.chat && a.text === h.text && !a.deduped && !(h.window && a.gen !== h.gen)).length;
      if (tries > 0) P.push('P6 a reply refused for good in ' + h.chat + ' was tried ' + tries + 'x more after its refusal');
    }
    for (const e of w.events) if (!e.ok && /capacity|full/.test(String(e.reason || ''))) P.push('P6 a finished reply was dropped for capacity (' + e.reason + ')');
    /* P7 (S4): a routine's parts are never resent — each line of a digest lands at most once, plus one copy per logged
       Telegram window event (a part the platform took in the instant the process died, or whose answer was lost; on
       Discord, none) — and a digest whose first part reached the chat lands whole, unless its record was given up
       (refused for good, or the chat removed this bot), which is said once. A record the cron took back had no part marked
       sent, so it is held to this only if it went again: of a record taken back and not sent again, nothing may be on the
       wire but a part in the window (the platform took it as the process died, or its answer was lost: the ledger cannot
       tell that from a refusal, and a newer result replaces the rest). Once everything has drained (the cron's longest
       backoff has passed), no result is left pending but one given up. */
    for (const d of w.digests) {
      const lines = wireLines(d.chat), allow = windowLines(d.chat);
      const recordId = 'routine:' + d.jobId + ':' + d.runId + ':@origin';
      for (const l of d.lines) {
        const n = lines.filter(x => x === l).length;
        const max = 1 + (allow.get(l) || 0);
        if (n > max) { P.push('P7 ' + d.chat + ' routine ' + d.jobId + ' ' + d.runId + ' line "' + l.slice(0, 40) + '" landed ' + n + 'x (window allows ' + max + ')'); break; }
      }
      const started = lines.indexOf(d.lines[0]) >= 0 || (w.durable.has(recordId) && !w.withdrawn.has(recordId));
      if (started && !w.tombs.has(recordId)) {
        const missing = d.lines.find(l => lines.indexOf(l) < 0);
        const inWindow = (l) => w.windows.some(e => e.chat === d.chat && stripHeader(e.text).split('\n').indexOf(l) >= 0);
        const taken = w.withdrawn.has(recordId) && d.lines.filter(l => lines.indexOf(l) >= 0).every(inWindow);
        if (missing && !taken) P.push('P7 ' + d.chat + ' routine ' + d.jobId + ' ' + d.runId + ' started but never landed line "' + missing.slice(0, 40) + '"');
      }
    }
    if (w.files.has(JOBS_FILE)) {
      for (const job of cronStore.loadEnvelope(w.files.get(JOBS_FILE)).jobs) {
        for (const f of cronStore.pendingDeliveries(job)) {
          const recordId = 'routine:' + job.id + ':' + f.runId + ':@origin';
          if (!w.tombs.has(recordId)) P.push('P7 routine ' + job.id + ' ' + f.runId + ' is still pending after everything drained (' + String(f.lastError || 'never asked').slice(0, 80) + ')');
        }
      }
    }
    void refused;
    return P;
  };
  w.run = async (steps) => {
    w.install();
    try {
      w.boot();
      await w.advance(500);
      for (let i = 0; i < steps; i++) await w.step();
      await w.tail(20000);
      await w.quiesce();
      return { problems: w.oracle(), stats: w.stats };
    } catch (e) {
      return { problems: ['the simulation threw: ' + ((e && e.stack) || e)], stats: w.stats };
    } finally { w.uninstall(); }
  };
  return w;
}

/* THE SOURCE LOCK: every hub index.js builds stands over the station's store (or a view of it), or over a one-job fire's
   store, whose ledger is its own and in memory (channels/fire-store.js): those are named, with the reason. */
const ONE_JOB_SITES = {
  getSampleHub: 'the sample job (RUN ONE REAL JOB): its replies are captured into the job record in this process',
  makeTriggerHub: 'line triggers and SEND TO hand-offs: each fire\'s replies are captured into that fire\'s job record'
};
function storeSiteProblems(indexSource) {
  const src = String(indexSource || ''), out = [], fire = new Set(), owners = new Set();
  const kinds = HubFactory.KINDS.slice();
  for (const kind of kinds) {
    let bag;
    try { bag = productionHubBag(kind, src); }
    catch (e) { out.push(kind + ': ' + e.message); continue; }
    owners.add(bag.owner);
    const prop = bag.props.find(p => p.key === 'store'), value = prop && prop.expr.trim();
    if (kind === 'telegram-bot') {
      if (value !== 'botStore' || !/const botStore = makeBotScopedStore\(botId\);/.test(topLevel(src, bag.owner)))
        out.push(kind + ': store is not the actual bot-scoped station view');
    } else if (['sample', 'trigger', 'handoff'].includes(kind)) {
      if (!/^perFireStore\(channelStore\b/.test(value || '') || !ONE_JOB_SITES[bag.owner])
        out.push(kind + ': store is not its named per-fire station view');
      else fire.add(bag.owner);
    } else if (value !== 'channelStore') out.push(kind + ': store is not the shared station owner (' + String(value) + ')');
  }
  // Census the actual call sites as well as all ten effective bags: a new unclassified constructor must fail.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sites = [...code.matchAll(/(?<![\w$])(?:makeChannelHub|wireChannel)\(/g)];
  const found = [];
  for (const site of sites) {
    const heads = [...code.slice(0, site.index).matchAll(/^(?:async )?function ([\w$]+)\(/gm)];
    const name = heads.length ? heads[heads.length - 1][1] : '?';
    found.push(name);
    if (!owners.has(name)) out.push(name + ': unclassified production hub constructor');
  }
  for (const owner of owners) if (found.filter(name => name === owner).length !== 1) out.push(owner + ': expected one actual constructor');
  return { problems: out, sites: sites.length, kinds, oneJob: [...fire] };
}

module.exports = { makeWorld, manifestProblems, storeSiteProblems, MANIFEST, ONE_JOB_SITES, CHATS, HEADER, ROOT, OWNER, GROUP, T0, rng, chunkTextParts };
