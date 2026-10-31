'use strict';
/* test/helpers/channel-station-sim.js — a station's channels, faked only at the transport edge, for the delivery property
   (test/channels.delivery-ledger.property.test.js) and its soak (channel-delivery-ledger S2).

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
   step's side effect on the world's disk, so a step run twice is counted whatever process ran it.

   FAULTS: send failures (retryable, refused for good, a refused credential), a lost response (the platform took it), a
   crash before a send, after the platform took it and before its mark, and inside a receipt or answer write; write
   failure spans (EBUSY, UPDATE_MUTATIONS_FROZEN) while sends succeed; update-barrier spans; a lane pushed past its mark;
   a channel's receipt cap filled; a membership kick and the unblock; a chat down for 20-50 s, and the healthy chat's own
   blip (one failed send of a reply). THE ORACLE reads only what any build exposes — the wire, channel.delivery events,
   the run host's record and the receipts left on disk — so the same file runs on trunk.

     makeWorld(seed, { steps, bot, limits }) -> world;  await world.run() -> { problems: [...], stats }
     manifestProblems() -> [...]      a lifted bag's keys differ from the production call's, or a key is unclassified */
const pathPosix = require('path').posix;
const { makeChannelStore } = require('../../sidecar/channels/store.js');
const { makeChannelHub, chunkTextParts } = require('../../sidecar/channels/hub.js');
const { makeTelegramAdapter } = require('../../sidecar/channels/telegram.js');
const { makeChannelRegistry, wireChannel } = require('../../sidecar/channels/registry.js');
const { makePromptRegistry } = require('../../sidecar/channels/prompts.js');
const { makeConsentWait } = require('../../sidecar/consentwait.js');
const HostPathScrub = require('../../sidecar/host-path-scrub.js');
const Events = require('../../shared/events.js');
const { sidecarTopLevelFunction, sidecarFunctionSource, callRegion, objectProps } = require('./source.js');

const T0 = 1761900000000;
const ROOT = '/ws/channels';
const OWNER = '4242';                 // the Telegram owner (and the DM chat with them)
const GROUP = '-100777';              // a Telegram group the owner admitted
const DC_OWNER = 'd-owner';           // the Discord owner; their DM channel id is 4242 too (the same id on two platforms)
const BOT_ID = 'simbot2';             // the soak's agent bot
const HEADER = '⌛ delayed reply — the channel was unreachable when this was first sent:';
const CHATS = { tgDm: 'telegram|' + OWNER, tgGroup: 'telegram|' + GROUP, dcDm: 'discord|' + OWNER, botDm: 'telegram:' + BOT_ID + '|' + OWNER };

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const drain = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); };
const hang = () => new Promise(() => {});

/* ---------------------------------------------------------------- the lifted bags ---------------------------------- */
// REAL: the property's own production expression, evaluated over real delivery seams. STUB: replaced, with the reason.
const MANIFEST = {
  stationHub: {
    real: ['channel', 'store', 'ownerTrusted', 'isOwner', 'send', 'chatAction', 'prompts', 'answerCallback', 'editMessage', 'setReaction',
      'deleteMessage', 'streamReplies', 'askConsent', 'resolveConsent', 'consentOutcome', 'newId', 'now', 'maxMessageLength', 'textBatchWaitMs',
      'scrubOutbound'],
    stub: {
      runOnce: 'the scripted run host (agent.* contract, tool steps journaled on the disk)', steerRun: 'joins the host\'s live run',
      historyFor: 'no canonical transcript', observeInto: 'records overheard lines', runSlash: 'answers every slash command', userCommandNames: 'none',
      desktopCommand: 'none', canReadAllGroupMessages: 'unknown', secrets: 'a configured provider', resolveEntryRunConfig: 'a configured provider',
      persona: 'a fixed persona', classify: 'every message is a task', redact: 'identity', emit: 'records channel.delivery events',
      taskIntent: 'no task questions', briefFor: 'no brief', groundedFor: 'none', resolveAgent: 'no floor plan', chain: 'no work line',
      lineOriginFor: 'no line', getTag: 'no tag', resolveStation: 'office default', stageBriefFor: 'no brief', roster: 'empty', setModel: 'refused',
      modelCatalog: 'empty', fetchMedia: 'no media', transcribe: 'no media', saveAttachment: 'no media', expandAttachments: 'identity'
    }
  },
  stationAdapter: {
    real: ['fetch', 'token', 'apiBase', 'clock', 'botUsername', 'requireMention', 'allowedChats', 'mentionPatterns', 'observeUnmentioned',
      'ownerUserId', 'onInbound', 'onCallback', 'onMembership', 'onStatus', 'onDelivery'],
    stub: { onOwnerClaim: 'the owner is already paired', ownerAdmission: 'no pairing code in flight' }
  }
};
// the agent bot's bags (startTelegramBot) carry the same delivery seams under the same names; its hub answers no roster
// commands and resolves a hop's agent through resolveRunConfig instead of resolveEntryRunConfig
MANIFEST.botHub = { real: MANIFEST.stationHub.real.slice(), stub: Object.assign({}, MANIFEST.stationHub.stub, { resolveRunConfig: 'a configured provider' }) };
for (const k of ['resolveEntryRunConfig', 'roster', 'setModel', 'modelCatalog']) delete MANIFEST.botHub.stub[k];
MANIFEST.botAdapter = { real: MANIFEST.stationAdapter.real.slice(), stub: Object.assign({}, MANIFEST.stationAdapter.stub) };

function productionBags() {
  const tg = sidecarTopLevelFunction('startTelegram');
  const bot = sidecarTopLevelFunction('startTelegramBot');
  return {
    stationHub: objectProps(callRegion(tg, 'const hub = makeChannelHub({', '\n  });')),
    stationAdapter: objectProps(callRegion(tg, 'const adapter = makeTelegramAdapter({', '\n  });')),
    botHub: objectProps(callRegion(bot, 'const hub = makeChannelHub({', '\n  });')),
    botAdapter: objectProps(callRegion(bot, 'const adapter = makeTelegramAdapter({', '\n  });'))
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
    + 'const hub = makeChannelHub({\n' + hubBag.map(p => prop(p, hubM, 'hub')).join(',\n') + '\n});\n'
    + 'const adapterBag = {\n' + adBag.map(p => prop(p, adM, 'adapter')).join(',\n') + '\n};\n'
    + 'const adapter = makeTelegramAdapter(adapterBag);\n'
    + 'guardOutbound(adapter);\n'
    + 'adapterRef = adapter;\n'
    + 'return { hub: hub, adapter: adapter, adapterBag: adapterBag, status: function () { return telegramStatus; } };';
  const fn = new Function(...scopeNames, '__stub', body);   // eslint-disable-line no-new-func
  factoryCache.set(key, fn);
  return fn;
}

/* the channel consent broker, sliced out of index.js (channelAskConsent and its finishers) over the real makeConsentWait */
function consentSlice(world) {
  const names = ['channelAskConsent', 'noteChannelConsentSettled', 'channelConsentOutcome', 'channelResolveConsent', 'consentSummary'];
  const src = names.map(n => sidecarFunctionSource(n)).filter(Boolean).join('\n');
  const deps = {
    makeConsentWait, channelPendingByRun: new Map(), channelConsentSettled: new Map(), CONSENT_TIMEOUT_MS: 120000, CONSENT_ACK_EXTEND_MS: 60000,
    crypto: { randomUUID: () => world.uuid() }, remoteApprovals: { add: () => () => {} }, failNote: () => {}
  };
  try {
    return new Function(...Object.keys(deps), src + '\nreturn { channelAskConsent, channelResolveConsent, channelConsentOutcome };')(...Object.values(deps));   // eslint-disable-line no-new-func
  } catch (e) { world.problems.push('setup: the channel consent slice did not compile: ' + e.message); return {}; }
}

/* ---------------------------------------------------------------- the world ----------------------------------------- */
function makeWorld(seed, opts) {
  const o = opts || {};
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const w = {
    seed, gen: 0, now: T0, problems: [], files: new Map(), wire: [], attempts: [], events: [], windows: [], runs: [], journal: new Map(),
    contract: [], replies: new Map(), held: [], healthy: seed % 2 ? CHATS.dcDm : CHATS.tgDm, disrupted: T0, crashes: 0,
    writeFault: '', holding: false, crashOnWrite: '', plans: new Map(), kicked: new Set(), spans: [], acked: new Map(), seq: 0,
    tgMsgId: 1000, updateId: 0, discordId: 9000, nonces: new Map(), live: new Map(), tags: 0, lastTgMsg: new Map(), finished: new Map(), finishOrder: new Map(),
    limits: Object.assign({ laneMaxDeliveries: 3, maxPendingPerChannel: 10 }, o.limits || {}), stats: { steps: 0, actions: {} },
    down: new Set(), blipAt: -Infinity
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
        if (w.writeFault) throw err(w.writeFault, 'durable writes refused');
        if (w.crashOnWrite && canCrash() && /\/(delivery|inbox)\.json$/.test(b) && isWriteKind(w.files.get(b), w.files.get(a), w.crashOnWrite)) {
          w.crashOnWrite = ''; w.crash('inside a ' + 'write'); throw err('EDEAD', 'the process died inside the write');
        }
        if (!w.files.has(a)) throw err('ENOENT', a);
        w.files.set(b, w.files.get(a)); w.files.delete(a);
        if (/\/delivery\.json$/.test(b)) observeLedger(w.files.get(b));
      },
      mkdirSync() {}
    };
  }
  // WHAT A BUILD WITH A LEDGER MADE DURABLE: every delivery that reached delivery.json, and every tombstone (a build without
  // one never writes the file, and this records nothing). A durable delivery must land, or be given up and said so.
  w.durable = new Map();   // delivery id -> { chat, first, kind, runId }
  w.tombs = new Map();     // delivery id -> reason
  w.answerProblems = [];
  function observeLedger(text) {
    let d = null;
    try { d = JSON.parse(text); } catch (_) { return; }
    const pending = new Set((d.receipts || []).map(r => r.id));
    for (const x of d.deliveries || []) {
      if (!w.durable.has(x.id)) {
        const parts = (x.parts || []).map(p => stripHeader(p.text)).filter(t => t && t !== HEADER);
        w.durable.set(x.id, { chat: x.chat, first: (parts[0] || stripHeader(x.text || '')).split('\n')[0], kind: x.kind, runId: x.runId, at: w.now, gen: w.gen });
        // P5: the write that answers a merged batch settles every one of its receipts
        for (const id of x.receiptIds || []) if (pending.has(id)) w.answerProblems.push('P5 the answer ' + x.id + ' was written while its receipt ' + id + ' stayed pending');
      }
    }
    for (const t of d.tombstones || []) if (!w.tombs.has(t.id)) w.tombs.set(t.id, t.reason);
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
  /* THE CRASH BOUNDARY: no crash is drawn while writes are failing or before the ledger's retry has surely landed after
     them (its backoff tops out at 30 s). A mark that never reached the disk cannot protect anything across a crash; the
     property claims no step twice and no resend under LIVE write failures, and under crashes on their own. */
  w.crashFree = 0;
  const canCrash = () => !w.writeFault && w.now >= w.crashFree;
  // THE WINDOW: a part the platform took in the very instant the process died (its sent mark was not written yet) may be
  // sent again by the next process; every part this process landed at this instant is logged as such a window event
  w.windowed = new Set();
  w.crash = (why) => {
    for (const m of w.wire) {
      if (m.gen !== w.gen || m.at !== w.now || w.windowed.has(m)) continue;
      w.windowed.add(m);
      w.windows.push({ chat: m.chat, text: m.text, discord: m.chat.indexOf('discord|') === 0, crash: true });
    }
    w.gen++; w.crashes++; w.disrupted = w.now; w.live.clear(); w.stats.lastCrash = why;
  };

  // ---- the run host ----
  function planFor(tags) {
    const k = tags.join('+');
    if (!w.plans.has(k)) w.plans.set(k, { steps: Math.floor(rand() * 3), stepMs: 200 + Math.floor(rand() * 900), long: rand() < 0.25 });
    return w.plans.get(k);
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
      const run = { gen, runId: base.runId, tags, steps: 0, chat: ro.taskKey || '', ended: '' };
      w.runs.push(run);
      emit('agent.run.start', { trigger: 'event', model: 'sim/model' });
      const plan = planFor(tags);
      w.live.set(base.runId, run);
      try {
        for (let s = 0; s < plan.steps; s++) {
          if (gen !== w.gen) return hang();
          emit('agent.tool_call', { callId: 'c' + s, name: 'fs_append' });   // the hub marks the step before it runs
          if (gen !== w.gen) return hang();
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
        const lines = ['REPLY ' + tags.join('+') + ' ' + base.runId];
        if (plan.long) for (let i = 0; i < 60; i++) lines.push('L' + i + ' ' + base.runId + ' ' + 'z'.repeat(90));
        const text = lines.join('\n');
        w.replies.set(base.runId, { text, tags, chat: '' });
        emit('agent.token', { delta: text });
        run.ended = 'done';
        emit('agent.run.end', { reason: 'done', turns: 1, usd: 0 });
      } finally { w.live.delete(base.runId); }
    };
  }

  // ---- the platforms (the transport edge) ----
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, async json() { return body; }, async text() { return JSON.stringify(body); } });
  function takeFault(chat) { const q = w.faults.get(chat); return q && q.length ? q.shift() : 'ok'; }
  w.faults = new Map();
  function landed(chat, text) { const m = { chat, text: String(text), at: w.now, gen: w.gen }; w.wire.push(m); return m; }
  function sendOutcome(chat, text, kind, gen) {
    w.attempts.push({ chat, text: String(text), at: w.now });
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
        if (f === 'kicked') return res(403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' });
        if (f === 'retryable') return res(502, { ok: false, error_code: 502, description: 'Bad Gateway' });
        if (f === 'permanent') { w.held.push({ chat, text: String(body.text), after: w.attempts.length }); return res(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' }); }
        if (f === 'auth') return res(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        const got = landed(chat, body.text);
        if (f === 'lost') { w.windowed.add(got); w.windows.push({ chat, text: String(body.text) }); throw err('ECONNRESET', 'the answer was lost'); }
        if (f === 'crashAfter') { w.crash('after the platform took a part'); return hang(); }   // the crash logs the window
        return res(200, { ok: true, result: { message_id: ++w.tgMsgId } });
      }
      if (method === 'getMe') return res(200, { ok: true, result: { id: 1, is_bot: true, username: 'simbot', first_name: 'Sim' } });
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
    if (f === 'permanent') { w.held.push({ chat, text: String(body.content), after: w.attempts.length }); return res(403, { message: 'Missing Access' }); }
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
  function emitter(channel, gen) { return (name, payload) => { if (name === 'channel.delivery' && gen === w.gen) w.events.push(Object.assign({ gen: gen, at: w.now, via: channel }, payload)); }; }
  function stubs(gen, channel) {
    const live = () => null;
    return {
      hub: {
        runOnce: runHost(gen), steerRun: (runId) => (w.live.has(String(runId)) && gen === w.gen ? { ok: true } : { ok: false, status: 409 }),
        historyFor: () => [], observeInto: () => {}, runSlash: async () => ({ ok: true, text: 'done' }), userCommandNames: () => [],
        desktopCommand: () => false, canReadAllGroupMessages: () => null,
        secrets: () => ({ key: 'k', model: 'sim/model', provider: 'openrouter', configured: true }),
        resolveEntryRunConfig: () => ({ ok: true, key: 'k', model: 'sim/model', provider: 'openrouter', configured: true }),
        resolveRunConfig: () => ({ ok: true, key: 'k', model: 'sim/model', provider: 'openrouter', configured: true }),
        persona: 'You are a simulated agent.', classify: () => true, redact: (p) => p, emit: emitter(channel, gen),
        taskIntent: null, briefFor: () => null, groundedFor: () => null, resolveAgent: live, chain: null, lineOriginFor: live, getTag: () => undefined,
        resolveStation: live, stageBriefFor: live, roster: () => [], setModel: () => ({ ok: false, error: 'not here' }), modelCatalog: () => [],
        fetchMedia: async () => ({ ok: false, error: 'no media' }), transcribe: null, saveAttachment: null, expandAttachments: (m) => m
      },
      adapter: { onOwnerClaim: () => {}, ownerAdmission: () => null }
    };
  }
  function scopeFor(gen, store, extra) {
    return Object.assign({
      makeChannelHub, makeTelegramAdapter, makePromptRegistry, guardOutbound: (a) => HostPathScrub.guardOutbound(a, scrub),
      channelStore: store, crypto: { randomUUID: () => w.uuid() }, Date: { now: () => w.now },
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
    const scoped = new Function('channelStore', sidecarTopLevelFunction('makeBotScopedStore') + '\nreturn makeBotScopedStore;')(store);   // eslint-disable-line no-new-func
    const rec = { username: 'simbot2', botName: 'SimTwo', name: 'Agent', ownerId: OWNER };
    const entry = { adapter: null, hub: null, status: { connected: false, state: 'connecting', detail: '', delivery: { state: 'unknown', detail: '', at: 0 } } };
    const scope = scopeFor(gen, store, {
      botId: BOT_ID, botStore: scoped(BOT_ID), recOf: () => rec, rec: rec, entry: entry, telegramBots: new Map([[BOT_ID, entry]]),
      telegramTransportFetch: () => w.botFetch(gen), token: '2:SIM', persistTelegramBotOwnerClaim: () => true, publishCommandMenu: () => {},
      telegramOwnerAdmission: () => null, channelSteerRun: null
    });
    const names = Object.keys(scope);
    return liftedFactory('bot', names)(...names.map(n => scope[n]), stubs(gen, 'telegram:' + BOT_ID));
  }
  function bootDiscord(gen, store) {
    const reg = makeChannelRegistry();
    const st = stubs(gen, 'discord').hub;
    return wireChannel(reg.get('discord'), {
      outbound: scrub,
      hub: { runOnce: st.runOnce, store: store, steerRun: st.steerRun, secrets: st.secrets, persona: st.persona, classify: st.classify, redact: st.redact,
        emit: st.emit, newId: () => w.uuid(), now: () => w.now, roster: st.roster, runSlash: st.runSlash, userCommandNames: st.userCommandNames },
      adapter: { fetch: w.dcFetch(gen), token: 'D', clock: { now: () => w.now }, connectGateway: () => ({ close() {} }), ownerUserId: DC_OWNER }
    });
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
    proc = { gen, store, tg: bootStation(gen, store), dc: bootDiscord(gen, store), bot: o.bot ? bootBot(gen, store) : null };
    w.up();
  };
  w.up = () => {
    if (!proc || proc.gen !== w.gen) return;
    try { proc.tg.adapterBag.onStatus({ state: 'up' }); } catch (e) { w.problems.push('setup: the lifted onStatus threw: ' + e.message); }
    try { proc.dc.hub.onStatus({ state: 'up' }); } catch (e) { w.problems.push('setup: discord onStatus threw: ' + e.message); }
    if (proc.bot) { try { proc.bot.adapterBag.onStatus({ state: 'up' }); } catch (e) { w.problems.push('setup: the bot onStatus threw: ' + e.message); } }
  };

  // ---- inbound: raw platform updates through each adapter's own dispatch (acknowledged = it did not throw) ----
  const pending = [];   // updates the platform still holds (not acknowledged)
  function deliverUpdate(u) {
    if (!proc || proc.gen !== w.gen) { pending.push(u); return false; }
    const adapter = u.via === 'discord' ? proc.dc.adapter : (u.via === 'bot' ? (proc.bot && proc.bot.adapter) : proc.tg.adapter);
    if (!adapter) return false;
    try { adapter._internals.dispatch(u.raw); }
    catch (e) { pending.push(u); return false; }
    for (const t of u.tags) if (!w.acked.has(t)) w.acked.set(t, { kind: u.kind, chat: u.chat });
    return true;
  }
  w.redeliver = () => { const q = pending.splice(0); for (const u of q) deliverUpdate(u); };
  function tgRaw(chatId, text, from, edited) {
    const id = edited ? edited : ++w.tgMsgId;
    const m = { message_id: id, from: { id: Number(from), is_bot: false, first_name: from === OWNER ? 'Ana' : 'Bo' }, chat: { id: Number(chatId), type: String(chatId).charAt(0) === '-' ? 'supergroup' : 'private' }, date: Math.floor(w.now / 1000), text };
    if (edited) m.edit_date = Math.floor(w.now / 1000);
    // an @mention reaches a bot as a 'mention' entity (the adapter reads no other form of it), as Telegram sends it
    const at = String(text).indexOf('@simbot ');
    if (at >= 0) m.entities = [{ type: 'mention', offset: at, length: 7 }];
    return edited ? { update_id: ++w.updateId, edited_message: m } : { update_id: ++w.updateId, message: m };
  }
  w.inbound = (chat, kind, opt) => {
    const tag = String(++w.tags);
    const sub = opt || {};
    let text = sub.text || ('please #' + tag);
    const tags = sub.noTag ? [] : [tag];
    let u;
    if (chat === CHATS.dcDm) {
      u = { via: 'discord', chat, kind, tags, raw: { id: String(++w.discordId), channel_id: OWNER, author: { id: DC_OWNER, username: 'ana' }, content: text } };
    } else {
      const chatId = chat === CHATS.tgGroup ? GROUP : OWNER;
      if (chat === CHATS.tgGroup && kind !== 'observe' && !sub.raw) text = '@simbot ' + text;
      const via = chat === CHATS.botDm ? 'bot' : 'telegram';
      const raw = sub.edit ? tgRaw(chatId, text, OWNER, sub.edit) : tgRaw(chatId, text, sub.from || OWNER);
      if (!sub.edit) w.lastTgMsg.set(chat, raw.message.message_id);
      u = { via, chat, kind, tags, raw };
    }
    deliverUpdate(u);
    return tag;
  };
  w.membership = (status) => {
    const raw = { update_id: ++w.updateId, my_chat_member: { chat: { id: Number(GROUP), type: 'supergroup' }, from: { id: Number(OWNER) }, date: Math.floor(w.now / 1000),
      old_chat_member: { status: status === 'kicked' ? 'member' : 'kicked' }, new_chat_member: { status, user: { id: 1, is_bot: true } } } };
    if (status === 'kicked') w.kicked.add(CHATS.tgGroup); else w.kicked.delete(CHATS.tgGroup);
    deliverUpdate({ via: 'telegram', chat: CHATS.tgGroup, kind: 'membership', tags: [], raw });
  };

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
      const run = [...w.live.values()].find(x => x.gen === w.gen);
      if (run) { w.inbound(CHATS.tgDm, 'followup', { text: 'also note this', noTag: true }); note('followup'); }
    } else if (r < 0.43) {
      w.inbound(CHATS.tgDm, 'stop', { text: 'stop', noTag: true }); note('stop');
    } else if (r < 0.46) {
      w.inbound(pick([CHATS.tgDm, CHATS.dcDm]), 'command', { text: '/status', noTag: true }); note('command');
    } else if (r < 0.49) {
      w.inbound(CHATS.tgGroup, 'observe', { text: 'just chatting here', noTag: true, from: '777' }); note('observe');
    } else if (r < 0.52) {
      const last = w.lastTgMsg.get(CHATS.tgDm);
      if (last && last > 1001) { w.inbound(CHATS.tgDm, 'edit', { text: 'an edit of an older message', noTag: true, edit: last - 1 }); note('edit'); }
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
        w.writeFault = pick(['EBUSY', 'UPDATE_MUTATIONS_FROZEN']); w.disrupted = w.now; w.crashFree = Infinity;
        w.spans.push({ kind: 'write', until: w.now + 1500 + Math.floor(rand() * 4000), end: () => { w.writeFault = ''; w.disrupted = w.now; w.crashFree = w.now + 35000; } });
        note('span:write');
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
    await w.advance(250 + Math.floor(rand() * 2000));
    w.checkHealthy();
  };

  // ---- the oracle ----
  const stripHeader = (t) => String(t).replace(new RegExp('^' + HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?'), '');
  const wireLines = (chat) => { const out = []; for (const m of w.wire) if (m.chat === chat) for (const l of stripHeader(m.text).split('\n')) if (l && l !== HEADER) out.push(l); return out; };
  const windowLines = (chat) => { const out = new Map(); for (const e of w.windows) if (e.chat === chat && !e.discord) for (const l of stripHeader(e.text).split('\n')) if (l) out.set(l, (out.get(l) || 0) + 1); return out; };
  // the messages a "not run again" / "not finished" notice names: their runs' replies were never made (the attempt rule
  // only ever meets a message whose answer was not written), so an event about such a run is about its notice
  const noticedTags = () => { const s = new Set(); for (const m of w.wire) if (/NOT run again/.test(m.text)) for (const t of (m.text.match(/#(\d+)/g) || [])) s.add(t.slice(1)); return s; };
  // a finished reply: a run whose answer a live process reported with a channel.delivery, or any of whose lines reached
  // the wire (then every line must, exactly once)
  function finishedReplies() {
    const out = new Map();
    const noticed = noticedTags();
    // a build with a ledger says exactly which answers were made durable (a reply whose answer write failed, in a process
    // that then died, never was: its message's attempt rule applies); a build without one is judged by its events
    const durable = [...w.durable.values()].filter(d => d.kind === 'reply');
    for (const d of durable) {
      const rep = w.replies.get(d.runId);
      if (rep && !out.has(d.runId)) out.set(d.runId, { runId: d.runId, chat: d.chat, text: rep.text, at: d.at, gen: d.gen });
    }
    if (!durable.length) for (const ev of w.events) {
      const rep = w.replies.get(ev.runId);
      // a notice or a command reply carries the run id it is about (a re-run, an interrupted attempt); it is not that reply
      if (!rep || out.has(ev.runId) || /^(command|prompt|interrupted|admission|undeliverable|redelivery-gave-up|redelivery-delayed)$/.test(String(ev.reason || ''))) continue;
      if (ev.reason === 'redelivered' && rep.tags.some(t => noticed.has(t))) continue;
      out.set(ev.runId, { runId: ev.runId, chat: (ev.via || ev.channel) + '|' + ev.chatId, text: rep.text, at: ev.at, gen: ev.gen });
    }
    for (const [runId, rep] of w.replies) {
      if (out.has(runId)) continue;
      const first = rep.text.split('\n')[0];
      const m = w.wire.find(x => stripHeader(x.text).split('\n').indexOf(first) >= 0);
      if (m) out.set(runId, { runId: runId, chat: m.chat, text: rep.text, at: m.at, gen: m.gen });
    }
    return [...out.values()];
  }
  w.debug = { finishedReplies: () => finishedReplies(), stripHeader: (t) => stripHeader(t) };
  w.checkHealthy = () => {
    if (w.holding || w.writeFault) return;   // the update barrier or failing writes hold every chat: not another chat's doing
    const chat = w.healthy;
    const lines = new Set(wireLines(chat));
    for (const f of finishedReplies()) {
      // within one drain: a blip of its own costs the adapter's 1 s resend and its lane's first 5 s retry; another chat's
      // head, down for 20-50 s, costs it nothing. A hold or a write-failure span that ended since restarts its clock.
      const from = Math.max(f.at, w.disrupted);
      if (f.chat !== chat || from > w.now - 16000 || f.gen !== w.gen) continue;
      const first = f.text.split('\n')[0];
      if (!lines.has(first)) { w.problems.push('P3 the healthy chat ' + chat + ' still waits for reply ' + f.runId + ' (finished at +' + (f.at - T0) + ' ms, now +' + (w.now - T0) + ' ms)'); w.checkHealthy = () => {}; return; }
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
    w.faults.clear(); w.crashOnWrite = '';
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
    // P1: every finished reply lands line for line, exactly once (one extra copy per logged Telegram window event)
    for (const f of finishedReplies()) {
      if (tombed.has(f.runId)) continue;
      const lines = wireLines(f.chat), allow = windowLines(f.chat);
      for (const l of f.text.split('\n')) {
        const n = lines.filter(x => x === l).length;
        const max = 1 + (allow.get(l) || 0);
        if (n < 1) { P.push('P1 ' + f.chat + ' reply ' + f.runId + ' never landed line "' + l.slice(0, 40) + '"'); break; }
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
      if (a.kind !== 'message') continue;
      const rs = runsOf(tag);
      if (rs.length > 2) P.push('P5 message #' + tag + ' ran ' + rs.length + 'x');
      else if (rs.length === 2 && (w.journal.get(rs[0].tags.join('+') + '#0') || 0) > 0 && rs[0].tags.join('+') === rs[1].tags.join('+')) P.push('P5 message #' + tag + ' ran again after its first run began a tool step');
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
    // P1 (durability): every delivery that reached delivery.json lands, or is given up and said so (a ledger build only)
    for (const [id, d] of w.durable) {
      if (w.tombs.has(id)) continue;
      if (!d.first) continue;
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
    for (const e of w.events) if (e.reason === 'undeliverable' && e.runId) undeliverable.set(e.runId, (undeliverable.get(e.runId) || 0) + 1);
    for (const [runId, n] of undeliverable) if (n > 1) P.push('P6 undeliverable reply ' + runId + ' reported ' + n + 'x');
    for (const h of w.held) {
      if (h.text === HEADER || !/^REPLY /.test(stripHeader(h.text))) continue;   // the delayed line and ephemeral texts are shared
      const tries = w.attempts.slice(h.after).filter(a => a.chat === h.chat && a.text === h.text && !a.deduped).length;
      if (tries > 0) P.push('P6 a reply refused for good in ' + h.chat + ' was tried ' + tries + 'x more after its refusal');
    }
    for (const e of w.events) if (!e.ok && /capacity|full/.test(String(e.reason || ''))) P.push('P6 a finished reply was dropped for capacity (' + e.reason + ')');
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
  const src = String(indexSource || '');
  const out = [];
  const sites = [];
  const re = /(?<![\w$])(makeChannelHub\(\{|wireChannel\()/g;   // never unwireChannel(...), which builds nothing
  let m;
  while ((m = re.exec(src))) sites.push({ at: m.index, call: m[1] });
  const fire = [];
  for (const site of sites) {
    const region = src.slice(site.at, site.at + 4000);
    const store = /\bstore: ([^\n]+)/.exec(region);
    const fnHead = src.lastIndexOf('\nfunction ', site.at);
    const fnName = (/^\nfunction ([\w$]+)/.exec(src.slice(fnHead)) || [])[1] || '?';
    if (!store) { out.push(fnName + ': a hub with no store property'); continue; }
    const s = store[1].trim();
    if (/^(channelStore|botStore),/.test(s + ',')) continue;
    if (/^perFireStore\(channelStore\b/.test(s)) { fire.push(fnName); if (!ONE_JOB_SITES[fnName]) out.push(fnName + ': perFireStore outside the named one-job sites'); continue; }
    out.push(fnName + ': a hub over "' + s.slice(0, 60) + '"');
  }
  // botStore is makeBotScopedStore(botId): a view of the station's store, so its hub shares the station's ledger
  if (/const botStore = makeBotScopedStore\(botId\);/.test(src) === false) out.push('startTelegramBot: botStore is no longer makeBotScopedStore(botId)');
  return { problems: out, sites: sites.length, oneJob: fire };
}

module.exports = { makeWorld, manifestProblems, storeSiteProblems, MANIFEST, ONE_JOB_SITES, CHATS, HEADER, rng, chunkTextParts };
