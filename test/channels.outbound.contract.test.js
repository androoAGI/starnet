/* node test/channels.outbound.contract.test.js — ONE outbound contract for every message the station sends to a chat
   outside a hub's own reply (channel-delivery-ledger S4, sidecar/channels/outbound.js).

   Five send paths left the station on their own terms. A routine's delivery had its own chunker call, its own 429 wait
   and its own per-chat FIFO; channel.send had a second chunker (the limit minus 100, no fence reopening) and no topic;
   the notifier, the step-in nudge and the loop notice each sent one unchunked line with no topic and no channel.delivery;
   the two "I was offline" notices went straight onto the transport, past the topic, the lane and the event (bugs
   3a9d5e4a, a199ee3c, c0beb187). Each copy of "how long may a message be", "which topic", "is the channel there" and
   "did it land" was a place to disagree.

   THE CENSUS (source, through test/helpers/source.js): no adapter or live-handle send / sendMedia / sendMediaGroup is
   called anywhere in sidecar/ outside channels/outbound.js (and the adapters, transports and hub delivery that own the
   wire); no chunker exists outside channels/chunk.js; adapter.js calls transport.send only inside send(), the offline
   notices' fallback (no hook wired) and the one refusal to a room the station does not serve; and the host wires the
   adapters' sendNotice hook in startTelegram, startTelegramBot and both wireChannel sites, which registry.js forwards.

   THE BEHAVIOUR, for every path, built the way index.js builds it: the REAL channel store and its delivery ledger, a REAL
   hub per channel attached as its lane's sender, the REAL channel registry (Telegram 4096, Discord 2000), the REAL reach
   gate, host-path scrub and ChannelOutbound, and each path's own wiring LIFTED out of sidecar/index.js (the notifier's
   send, the step-in nudge, the loop stop notice, channel.send's sendTo and sendMediaTo, the offline-notice hook, the
   status closure) or its own module (makeRoutineDelivery). Fakes stand only at the platform. For each path: the
   descriptor's limit applies; an explicit route wins (a routine created in topic A lands in A after the chat last spoke
   in topic B; a nudge lands in the topic of its run's own message) and otherwise the chat's durable route is carried; a
   down or errored channel is refused before any transport call, while a 'down' whose cause is the durable intake is
   attempted; exactly one channel.delivery with the path's reason is emitted per send.

   RED at trunk a3af8dafd (scratch checkout, this file copied in): the census finds the direct adapter sends in index.js,
   two chunkers and two offline-notice transport sends; channel.send, the notifier, the nudge and the loop notice carry no
   route and (all but channel.send) emit no channel.delivery; the offline notices have no hook; a refused receipt's
   'down' carries no cause, and the gate refuses it. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { readSidecarIndex, sidecarSourceFiles, sidecarTopLevelFunction, liftProp, callRegion, functionSourceIn } = require('./helpers/source.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChannelRegistry } = require('../sidecar/channels/registry.js');
const { makeChannelReach } = require('../sidecar/channels/reach.js');
const { makeTelegramAdapter } = require('../sidecar/channels/telegram.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeCommsTools } = require('../sidecar/tools/builtin/comms.js');
const HostPathScrub = require('../sidecar/host-path-scrub.js');
const { nudgeLine } = require('../sidecar/browser-handoff-routes.js');
// the outbound contract and the routine module are this lane's; a trunk tree has neither, and its cases say so
const OUTBOUND = path.join(__dirname, '..', 'sidecar', 'channels', 'outbound.js');
const ROUTINE = path.join(__dirname, '..', 'sidecar', 'routine-delivery.js');
const Outbound = fs.existsSync(OUTBOUND) ? require(OUTBOUND) : null;
const RoutineDelivery = fs.existsSync(ROUTINE) ? require(ROUTINE) : null;

const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const settle = async (n) => { for (let i = 0; i < (n || 40); i++) await new Promise(r => setImmediate(r)); };
const LIMITS = { telegram: 4096, discord: 2000 };
// a text far past either limit, in lines: '<tag> line <i> …'
const long = (tag, n) => Array.from({ length: n || 90 }, (_, i) => tag + ' line ' + i + ' ' + 'w'.repeat(80)).join('\n');
const idx = readSidecarIndex();   // index.js's own wiring is the subject of every lift below
const block = (head) => { const at = idx.indexOf(head); return at < 0 ? '' : idx.slice(at, idx.indexOf('\n});', at) + 4); };
const guard = async (label, fn) => { try { await fn(); } catch (e) { A.ok(false, label + ' could not run: ' + ((e && e.message) || e)); } };

/* ONE STATION: a disk, a clock and timers, the store and its ledger, a hub per channel over it, a platform per channel
   (every call recorded, each answer scripted), the registry, the reach gate, the scrub, and the outbound contract. */
function makeStation() {
  const st = { now: T0, files: new Map(), timers: [], calls: [], events: [], health: {}, plan: {}, ids: 0 };
  const err = (code) => Object.assign(new Error(code), { code: code });
  const disk = {
    readFileSync(p) { if (!st.files.has(p)) throw err('ENOENT'); return st.files.get(p); },
    writeFileSync(p, d) { st.files.set(p, String(d)); },
    renameSync(a, b) { if (!st.files.has(a)) throw err('ENOENT'); st.files.set(b, st.files.get(a)); st.files.delete(a); },
    mkdirSync() {}
  };
  const setT = (fn, ms) => { const t = { at: st.now + (Number(ms) || 0), fn: fn, unref() { return t; } }; st.timers.push(t); return t; };
  const clearT = (t) => { const i = st.timers.indexOf(t); if (i >= 0) st.timers.splice(i, 1); };
  st.store = makeChannelStore({ fs: disk, pathMod: path.posix, root: '/ws/channels', clock: { now: () => st.now }, bootId: 'contract', timers: { setTimeout: setT, clearTimeout: clearT } });
  st.registry = makeChannelRegistry();
  st.emit = (name, payload) => { if (name === 'channel.delivery') st.events.push(payload); };
  st.answer = (channel) => { const q = st.plan[channel] || []; const r = q.length ? q.shift() : 'ok'; return r === 'ok' ? { ok: true, messageId: 'm' + (++st.ids) } : Object.assign({}, r); };
  st.adapters = {}; st.hubs = {};
  for (const ch of ['telegram', 'discord']) {
    st.health[ch] = { connected: true, state: 'up' };
    st.adapters[ch] = {
      send: (chatId, text, opts) => { st.calls.push({ channel: ch, op: 'send', chatId: String(chatId), text: String(text), threadId: String((opts && opts.threadId) || '') }); return Promise.resolve(st.answer(ch)); },
      sendMedia: (chatId, item, opts) => { st.calls.push({ channel: ch, op: 'media', chatId: String(chatId), filename: String(item && item.filename), threadId: String((opts && opts.threadId) || '') }); return Promise.resolve(st.answer(ch)); }
    };
    st.hubs[ch] = makeChannelHub({ channel: ch, store: st.store, send: (c, t, o) => st.adapters[ch].send(c, t, o), emit: st.emit, runOnce: async () => {},
      secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => true, newId: () => 'hub-' + (++st.ids), now: () => st.now,
      setTimeout: setT, clearTimeout: clearT, maxMessageLength: LIMITS[ch] });
  }
  st.liveChannelFor = (c) => (st.adapters[String(c || 'telegram')] ? { adapter: st.adapters[String(c || 'telegram')], hub: st.hubs[String(c || 'telegram')] } : null);
  st.channelReach = makeChannelReach({ liveChannelFor: st.liveChannelFor, channelLiveHealth: (c) => st.health[String(c || 'telegram')] || { connected: false, state: 'down' } }).reach;
  st.scrubOutbound = HostPathScrub.makeHostPathScrub({ fixed: ['/ws/agents'] });
  st.redact = (t) => String(t).replace(/sk-[A-Za-z0-9-]{8,}/g, '[redacted]');
  st.channelOutbound = (Outbound && st.store.ledger) ? Outbound.makeChannelOutbound({ ledger: st.store.ledger, registry: { get: (id) => st.registry.get(id) },
    reach: st.channelReach, chatRecord: (k) => st.store.getChatRecord(k), liveChannelFor: st.liveChannelFor, scrub: st.scrubOutbound, redact: st.redact, emit: st.emit }) : null;
  // the chats a person opened with this station, each bound to the agent nova
  st.store.saveChatRecord('4242', { agentId: 'nova', channel: 'telegram', chatId: '4242' });
  st.store.saveChatRecord('99', { agentId: 'nova', channel: 'discord', chatId: '99' });
  /* THE CHAT'S DURABLE ROUTE: the topic the hub last heard it in rides that message's receipt into the ledger. A run's
     own message can stay pending (its run is working) in another topic. */
  st.heard = (channel, chatId, messageId, threadId, runId) => {
    const L = st.store.ledger;
    if (!L || typeof L.receive !== 'function') return;
    const id = channel + '|' + chatId + '|' + messageId;
    L.receive({ id: id, channel: channel, chatId: chatId, message: { channel: channel, chatId: chatId, messageId: messageId, threadId: threadId, text: 'hi' }, route: { threadId: threadId } });
    if (runId) L.markAttempt([id], { runId: runId }); else L.settle([id]);
  };
  st.mark = () => ({ calls: st.calls.length, events: st.events.length });
  st.since = (m) => ({ calls: st.calls.slice(m.calls), events: st.events.slice(m.events) });
  st.lift = (expr, scope, src) => {
    if (!expr) throw new Error('nothing to lift');
    const names = Object.keys(scope);
    return new Function(...names, (src || '') + '\nreturn (' + expr + ');')(...names.map(n => scope[n]));   // eslint-disable-line no-new-func
  };
  st.scope = (extra) => Object.assign({ channelOutbound: st.channelOutbound, channelReach: st.channelReach, liveChannelFor: st.liveChannelFor,
    channelStore: st.store, redact: st.redact, scrubOutbound: st.scrubOutbound, failNote: () => {}, console: { log() {}, warn() {}, error() {} } }, extra || {});
  return st;
}
// what every send of one path to one chat must show: its parts under the platform's limit, all in one topic, one event
// with its reason (a path that tells every chat bound to the agent sends to each, and each send is judged on its own)
function contract(label, all, want) {
  const got = { calls: all.calls.filter(c => c.channel === want.channel), events: all.events.filter(e => e.channel === want.channel) };
  const sends = got.calls.filter(c => c.op === 'send');
  A.ok(sends.length >= (want.minParts || 1), label + ': the text went out (' + sends.length + ' part(s))');
  A.ok(sends.every(c => c.text.length <= LIMITS[want.channel]), label + ': every part fits the ' + want.channel + ' limit of ' + LIMITS[want.channel] + ' (' + sends.map(c => c.text.length).join(',') + ')');
  A.eq(Array.from(new Set(got.calls.map(c => c.threadId))), [want.thread], label + ': ' + (want.why || 'every part in the expected topic'));
  const evs = got.events.filter(e => e.reason === want.reason);
  A.eq(got.events.length === 1 && evs.length === 1 && evs[0].ok === true, true, label + ': exactly one channel.delivery, its reason \'' + want.reason + '\', ok (' + JSON.stringify(got.events) + ')');
  if (want.agentId) A.eq(evs[0] && evs[0].agentId, want.agentId, label + ': the delivery names the agent, so the right dish pulses');
  if (want.runId) A.eq(evs[0] && evs[0].runId, want.runId, label + ': and the run it belongs to');
}

(async () => {
  /* ================================================================ THE CENSUS ======================================= */
  {
    const files = sidecarSourceFiles();
    // the files that own the wire: the contract itself, the hub's lane delivery, the adapters and the transports
    const owns = (rel) => /^sidecar\/channels\/(outbound|hub-delivery|adapter|telegram|discord|slack|matrix|signal)\.js$/.test(rel) || /\.transport\.js$/.test(rel);
    const re = /(?<![\w$])((?:[\w$]+\.)*adapter)\.(send|sendMedia|sendMediaGroup)\(/g;
    const outside = [];
    for (const f of files) {
      if (owns(f.rel)) continue;
      let m;
      while ((m = re.exec(f.text))) outside.push(f.rel + ':' + f.text.slice(0, m.index).split('\n').length + ' ' + m[1] + '.' + m[2]);
    }
    A.eq(outside, [], 'census: no adapter or live-handle send exists in sidecar/ outside the outbound contract and the wire it owns');
    const chunkers = [];
    for (const f of files) { if (f.rel === 'sidecar/channels/chunk.js') continue; for (const m of f.text.match(/function\s+chunk\w*\s*\(/g) || []) chunkers.push(f.rel + ' ' + m); }
    A.eq(chunkers, [], 'census: no chunker exists outside channels/chunk.js');
    // adapter.js: transport.send only in send(), the offline notices' fallback, and the refusal to a room it does not serve
    const ad = (files.find(f => f.rel === 'sidecar/channels/adapter.js') || { text: '' }).text;
    const total = (ad.match(/transport\.send\(/g) || []).length;
    const sendBody = (() => { const at = ad.indexOf('      async send(chatId, text, sendOpts) {'); return at < 0 ? '' : ad.slice(at, ad.indexOf('\n      },', at)); })();
    const inSend = (sendBody.match(/transport\.send\(/g) || []).length;
    const notice = functionSourceIn(ad, 'offlineNotice');
    const inNotice = (notice.match(/transport\.send\(/g) || []).length;
    const refusal = functionSourceIn(ad, 'refuseAdmission');
    const inRefusal = (refusal.match(/transport\.send\(/g) || []).length;
    A.ok(inSend === 2 && inNotice === 1 && /sendNotice \?/.test(notice), 'census: the offline notices go through the sendNotice hook, transport.send only its fallback (' + inNotice + ' in offlineNotice)');
    A.eq(total, inSend + inNotice + inRefusal, 'census: adapter.js calls transport.send nowhere else (send() ' + inSend + ', the notice fallback ' + inNotice + ', the admission refusal ' + inRefusal + ', of ' + total + ')');
    // the host wires the hook where it wires onMembership, and registry.js forwards it
    for (const fn of ['startTelegram', 'startTelegramBot']) {
      const bag = liftProp(callRegion(sidecarTopLevelFunction(fn), 'const adapter = makeTelegramAdapter({', '\n  });'), 'sendNotice');
      A.ok(/^channelNotice\(/.test(bag), 'census: ' + fn + ' wires its adapter\'s sendNotice to the outbound contract (' + JSON.stringify(bag) + ')');
    }
    A.eq((idx.match(/\n\s+sendNotice: channelNotice\(/g) || []).length, 4, 'census: so do the Discord and the generic wireChannel sites (four sites in all)');
    const reg = (files.find(f => f.rel === 'sidecar/channels/registry.js') || { text: '' }).text;
    A.ok(/sendNotice: \(deps\.adapter && deps\.adapter\.sendNotice\)/.test(reg), 'census: registry.js forwards sendNotice to the adapter it builds');
    for (const p of ['telegram', 'discord', 'slack', 'matrix', 'signal']) {
      const t = (files.find(f => f.rel === 'sidecar/channels/' + p + '.js') || { text: '' }).text;
      A.ok(/sendNotice: o\.sendNotice/.test(t), 'census: ' + p + '.js hands sendNotice on to the generic adapter (else the hook would have no reader)');
    }
    // the one contract is the one index.js builds, over its own ledger, gate and scrub
    const ob = block('const channelOutbound = makeChannelOutbound({');
    A.ok(/ledger: channelStore\.ledger,/.test(ob) && /reach: channelReach,/.test(ob) && /scrub: scrubOutbound,/.test(ob) && /emit: chanEmit/.test(ob), 'census: index.js builds the one outbound contract over the store\'s ledger, the reach gate, the host scrub and the station bus');
  }

  /* ================================================================ THE PATHS ======================================== */
  // ---- a routine's chat delivery (durable: its chat's lane) — explicit route, the chat's route, both limits ----
  await guard('the routine path', async () => {
    const st = makeStation();
    if (!RoutineDelivery || !st.channelOutbound) { A.ok(false, 'routine: delivered through makeRoutineDelivery over the one outbound contract (this tree has ' + (RoutineDelivery ? 'no outbound contract' : 'neither') + ')'); return; }
    const none = async () => ({ ok: false, notFound: true, error: 'not found' });
    const rd = RoutineDelivery.makeRoutineDelivery({ channelStore: st.store, channelOutbound: st.channelOutbound, channelReach: st.channelReach, channelRegistry: { get: (id) => st.registry.get(id) },
      scrubOutbound: st.scrubOutbound, redact: st.redact, runStore: { list: () => [] }, egressReader: { fireReader: () => none, shownName: (p, x) => String(x), pathsFor: () => ({}) },
      readChannelUpload: none, transcriptStore: { reconstruct: () => [], append: () => {} }, stationBridge: { request: async () => ({ ok: true }) }, now: () => st.now });
    // THE ROUTINE IN A TOPIC: made in topic A; the chat last spoke in topic B since
    st.heard('telegram', '4242', 'm1', 'B');
    let m = st.mark();
    await rd.deliverCronResult({ id: 'job-a', name: 'Digest', agentId: 'nova', deliver: 'origin', origin: { channel: 'telegram', chatId: '4242', threadId: 'A' } },
      { outcome: 'ok', runId: 'cron-a', text: long('ROUTINE-A') + '\nsaved to /ws/agents/nova/out.md' });
    await settle();
    const a = st.since(m);
    contract('routine (Telegram, made in topic A)', a, { channel: 'telegram', thread: 'A', reason: 'routine', agentId: 'nova', runId: 'cron-a', minParts: 2, why: 'an explicit route wins: it lands in topic A, where it was made, though the chat last spoke in B' });
    A.ok(a.calls.every(c => c.text.indexOf('/ws/agents') < 0) && a.calls.some(c => c.text.indexOf('[workspace]') >= 0), 'routine: scrubbed whole before it was split');
    // a routine with no route of its own lands where the chat last spoke
    m = st.mark();
    await rd.deliverCronResult({ id: 'job-b', name: 'Digest', agentId: 'nova', deliver: 'targets:4242' }, { outcome: 'ok', runId: 'cron-b', text: long('ROUTINE-B') });
    await settle();
    contract('routine (Telegram, no route of its own)', st.since(m), { channel: 'telegram', thread: 'B', reason: 'routine', minParts: 2, why: 'otherwise the chat\'s durable route: topic B, where it last spoke' });
    // Discord's own limit
    m = st.mark();
    await rd.deliverCronResult({ id: 'job-c', name: 'Digest', agentId: 'nova', deliver: 'origin', origin: { channel: 'discord', chatId: '99' } }, { outcome: 'ok', runId: 'cron-c', text: long('ROUTINE-C') });
    await settle();
    contract('routine (Discord)', st.since(m), { channel: 'discord', thread: '', reason: 'routine', minParts: 4 });
    // a channel the adapter saw fail is refused before any transport call, and said once
    st.health.telegram = { connected: false, state: 'error' };
    m = st.mark();
    const out = await rd.deliverCronResult({ id: 'job-d', name: 'Digest', agentId: 'nova', deliver: 'targets:4242' }, { outcome: 'ok', runId: 'cron-d', text: 'short' });
    const d = st.since(m);
    A.eq([out.ok, d.calls.length], [false, 0], 'routine: an errored channel is refused before any transport call');
    A.eq(d.events.map(e => [e.ok, e.reason]), [[false, 'routine']], 'routine: and the refusal is reported once');
  });

  // ---- channel.send, its file, and its missed-file note (not durable: now, once) ----
  await guard('the channel.send path', async () => {
    const st = makeStation();
    const core = sidecarTopLevelFunction('runOnceCore');
    const at = core.indexOf('makeCommsTools({');
    const wiring = at < 0 ? '' : core.slice(at, core.indexOf('.register(registry)', at));
    // a tree from before the contract sends through its own helpers: they are lifted with the wiring
    const helpers = ['commsTargetReach', 'commsSendTo', 'commsSendMediaTo'].map(n => sidecarTopLevelFunction(n)).filter(Boolean).join('\n');
    const sendTo = st.lift(liftProp(wiring, 'sendTo'), st.scope(), helpers);
    const sendMediaTo = st.lift(liftProp(wiring, 'sendMediaTo'), st.scope(), helpers);
    const listTargets = () => ['4242', '99'].map(k => { const r = st.store.getChatRecord(k); return { target: k, channel: r.channel, chatId: r.chatId, agentId: r.agentId, connected: st.channelReach(r.channel).ok }; });
    const readFile = async (agentId, rel) => (rel === 'out/chart.png' ? { ok: true, buffer: Buffer.from('PNG'), name: 'chart.png', mime: 'image/png' } : { ok: false, error: 'not found' });
    const tools = makeCommsTools({ listTargets: listTargets, sendTo: sendTo, sendMediaTo: sendMediaTo, readFile: readFile, redact: st.redact });
    st.heard('discord', '99', 'd1', 'T7');
    // the words: Discord's 2000, the chat's topic, one delivery
    let m = st.mark();
    const res = await tools.sendTool.run({ target: '99', text: long('TOOL', 60) }, { runId: 'run-tool', agentId: 'nova' });
    contract('channel.send (Discord)', st.since(m), { channel: 'discord', thread: 'T7', reason: 'tool', agentId: 'nova', runId: 'run-tool', minParts: 3, why: 'it carries the chat\'s durable route (was: General)' });
    A.ok(JSON.parse(res.content).parts >= 3, 'channel.send: the tool reports the parts that landed (' + JSON.parse(res.content).parts + ')');
    // a file: one more send, one more delivery
    m = st.mark();
    await tools.sendTool.run({ target: '99', text: 'the chart', files: ['out/chart.png'] }, { runId: 'run-file', agentId: 'nova' });
    const f = st.since(m);
    A.eq(f.calls.map(c => [c.op, c.threadId]), [['send', 'T7'], ['media', 'T7']], 'channel.send with a file: the words, then the file, both in the chat\'s topic');
    A.eq(f.events.map(e => [e.reason, e.ok, e.chunks]), [['tool', true, 1], ['tool', true, 1]], 'channel.send with a file: one delivery per send (the words, the file)');
    // the missed-file note: its own send, its own delivery, in the topic too
    st.plan.discord = ['ok', { ok: false, error: 'file is too large', retryable: false }];
    m = st.mark();
    await tools.sendTool.run({ target: '99', text: 'the report', files: ['out/chart.png'] }, { runId: 'run-note', agentId: 'nova' });
    const n = st.since(m);
    const note = n.calls.filter(c => c.op === 'send' && /could not be attached/.test(c.text));
    A.eq(note.map(c => c.threadId), ['T7'], 'missed-file note: said in the chat\'s topic');
    A.eq(n.events.filter(e => e.reason === 'note').map(e => e.ok), [true], 'missed-file note: one delivery, its reason \'note\'');
    // a send the gate refuses never reaches the transport, and is reported once
    st.health.discord = { connected: false, state: 'down' };
    m = st.mark();
    const refused = await sendTo('99', 'hello', { runId: 'run-x', agentId: 'nova' });
    const r = st.since(m);
    A.eq([refused && refused.ok, r.calls.length], [false, 0], 'channel.send: a down channel is refused before any transport call');
    A.eq(r.events.map(e => [e.ok, e.reason]), [[false, 'tool']], 'channel.send: and the refusal is reported once');
  });

  // ---- the autonomous notifier (not durable) ----
  await guard('the notifier path', async () => {
    const st = makeStation();
    const send = st.lift(liftProp(block('const autoNotifier = makeAutoNotifier({'), 'send'), st.scope());
    st.heard('telegram', '4242', 'm1', 'B');
    let m = st.mark();
    await send('4242', long('NOTIFY'), 'telegram', { jobId: 'job-1', runId: 'cron-n', agentId: 'nova' });
    await settle();
    contract('notifier', st.since(m), { channel: 'telegram', thread: 'B', reason: 'notify', agentId: 'nova', runId: 'cron-n', minParts: 2, why: 'it carries the chat\'s durable route (was: General)' });
    st.health.telegram = { connected: false, state: 'error' };
    m = st.mark();
    let threw = null;
    try { await send('4242', 'ping', 'telegram', { runId: 'cron-n2', agentId: 'nova' }); } catch (e) { threw = e; }
    const r = st.since(m);
    A.ok(!!threw && r.calls.length === 0, 'notifier: an errored channel is refused before any transport call (and the ping is a failure, never a phantom success)');
    A.eq(r.events.map(e => [e.ok, e.reason]), [[false, 'notify']], 'notifier: the refusal is reported once');
  });

  // ---- the step-in nudge (not durable): its run's own topic ----
  await guard('the step-in nudge path', async () => {
    const st = makeStation();
    const onNudge = st.lift(liftProp(block('const browserHandoffs = makeHandoffHost({'), 'onNudge'),
      st.scope({ channelSecrets: { notifyAutonomous: true }, agentRoster: new Map([['nova', { name: 'Nova '.repeat(900) }]]), handoffNudgeLine: nudgeLine }));
    // the waiting run's own message came from topic T9 (its receipt is pending while it works); the chat spoke in B since
    st.heard('telegram', '4242', 'm2', 'T9', 'run-wait');
    st.heard('telegram', '4242', 'm3', 'B');
    const m = st.mark();
    onNudge({ id: 'ho_1', agentId: 'nova', runId: 'run-wait', state: 'waiting', reason: 'login', host: 'example.com', where: 'example.com/login', title: 'Sign in' });
    await settle();
    contract('step-in nudge', st.since(m), { channel: 'telegram', thread: 'T9', reason: 'nudge', agentId: 'nova', runId: 'run-wait', minParts: 2, why: 'an explicit route wins: the topic of its run\'s own message (T9), not where the chat last spoke' });
    contract('step-in nudge (the agent\'s Discord chat too)', st.since(m), { channel: 'discord', thread: '', reason: 'nudge', agentId: 'nova', minParts: 2 });
  });

  // ---- the loop stop notice (not durable) ----
  await guard('the loop stop notice path', async () => {
    const st = makeStation();
    const onStopped = st.lift(liftProp(block('const loopDriver = makeLoopDriver({'), 'onStopped'),
      st.scope({ channelSecrets: { notifyAutonomous: true }, loopjob: { pendingReviews: () => [] } }));
    st.heard('telegram', '4242', 'm1', 'B');
    const m = st.mark();
    onStopped({ id: 'loop-1', agentId: 'nova', name: 'Long loop '.repeat(600), state: 'done', stopReason: 'objective met', lastRunId: 'run-loop' }, 'running');
    await settle();
    contract('loop stop notice', st.since(m), { channel: 'telegram', thread: 'B', reason: 'loop', agentId: 'nova', minParts: 2, why: 'it carries the chat\'s durable route (was: General)' });
    contract('loop stop notice (the agent\'s Discord chat too)', st.since(m), { channel: 'discord', thread: '', reason: 'loop', agentId: 'nova', minParts: 2 });
  });

  // ---- both "I was offline" notices: the adapter's sendNotice hook, in the dropped message's own topic ----
  await guard('the offline notices', async () => {
    const st = makeStation();
    const bag = callRegion(sidecarTopLevelFunction('startTelegram'), 'const adapter = makeTelegramAdapter({', '\n  });');
    const def = (() => { const at = idx.indexOf('const channelNotice = '); return at < 0 ? '' : idx.slice(at, idx.indexOf(';\n', at) + 1); })();
    const sendNotice = st.lift(liftProp(bag, 'sendNotice') || 'undefined', st.scope(), def);
    A.ok(typeof sendNotice === 'function', 'offline notices: startTelegram wires a sendNotice hook');
    // a fake Bot API whose backlog holds one message in a forum topic; the station is connecting
    const runAdapter = async (opts, backlog) => {
      const tg = [];
      let polled = 0;
      const fetch = async (url, init) => {
        const method = String(url).split('/').pop();
        const body = init && init.body ? JSON.parse(String(init.body)) : {};
        tg.push({ method: method, body: body });
        const ok = (result) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result: result }), text: async () => '' });
        if (method === 'getUpdates') {
          if (body.offset === -1) return ok(backlog);
          if (opts.live && !polled++) return ok(opts.live);
          await new Promise(r => setTimeout(r, 20));
          return ok([]);
        }
        if (method === 'sendMessage') return ok({ message_id: 900 + tg.length });
        return ok(true);
      };
      st.health.telegram = { connected: false, state: 'connecting' };
      const adapter = makeTelegramAdapter(Object.assign({ fetch: fetch, token: '1:T', apiBase: 'http://tg.test', clock: { now: () => st.now }, onInbound: () => {}, pollTimeoutSec: 1, sleep: () => Promise.resolve() }, opts.bag));
      await adapter.connect();
      for (let i = 0; i < 40 && tg.filter(c => c.method === 'getUpdates').length < 3; i++) await new Promise(r => setTimeout(r, 10));
      await settle();
      await adapter.disconnect();
      return tg;
    };
    const dm = (id, from, thread, text) => ({ update_id: id, message: { message_id: id * 10, from: { id: from, is_bot: false, first_name: 'Ana' }, chat: { id: from, type: 'private' }, is_topic_message: true, message_thread_id: thread, date: 1, text: text } });
    // the connect-time notice: the owner's message was dropped with the backlog
    let m = st.mark();
    await runAdapter({ bag: { ownerUserId: '4242', sendNotice: sendNotice } }, [dm(5, 4242, 55, 'are you there?')]);
    let got = st.since(m);
    A.eq(got.calls.map(c => [c.chatId, c.threadId, /I was offline/.test(c.text)]), [['4242', '55', true]], 'connect-time notice: through the one contract, in the dropped message\'s own topic (was: the transport, in General)');
    A.eq(got.events.map(e => [e.reason, e.ok]), [['offline', true]], 'connect-time notice: one channel.delivery, its reason \'offline\'');
    // the deferred notice: a first-run stranger-or-owner's DM was dropped, then the owner proves who they are
    m = st.mark();
    await runAdapter({ bag: { sendNotice: sendNotice }, live: [dm(7, 4242, 66, 'hello again')] }, [dm(6, 4242, 66, 'anyone?')]);
    got = st.since(m);
    A.eq(got.calls.map(c => [c.chatId, c.threadId, /I was offline/.test(c.text)]), [['4242', '66', true]], 'deferred notice: through the one contract, in the dropped message\'s own topic');
    A.eq(got.events.map(e => [e.reason, e.ok]), [['offline', true]], 'deferred notice: one channel.delivery, its reason \'offline\'');
    // with no hook wired (tests, an unwired host), the adapter keeps its transport — in that topic too
    m = st.mark();
    const bare = await runAdapter({ bag: { ownerUserId: '4242' } }, [dm(8, 4242, 77, 'still there?')]);
    const fallback = bare.filter(c => c.method === 'sendMessage');
    A.eq(fallback.map(c => [String(c.body.chat_id), c.body.message_thread_id]), [['4242', 77]], 'no hook: the transport sends the notice itself, in the dropped message\'s topic');
    A.eq(st.since(m).calls.length, 0, 'no hook: and the outbound contract is not involved');
  });

  // ---- THE INTAKE CAUSE: a refused receipt's 'down' is not a transport outage ----
  await guard('the intake cause', async () => {
    const st = makeStation();
    const statuses = [];
    let fail = true;
    const updates = [{ update_id: 1 }];
    const adapter = makeChannelAdapter({
      name: 'telegram', clock: { now: () => st.now }, sleep: () => new Promise(r => setTimeout(r, 5)), allowedChats: () => true, downAfterFailures: 2,
      transport: { getUpdates: async () => (updates.length ? [updates.shift()] : new Promise(r => setTimeout(() => r([]), 5))), send: async () => ({ ok: true }) },
      normalize: (u) => ({ offset: u.update_id, message: { chatId: '4242', chatType: 'dm', userId: '1', text: 'x', messageId: '1' } }),
      ownerUserId: '1', onInbound: () => { if (fail) throw Object.assign(new Error('channel inbox is full; refusing to acknowledge more work'), { code: 'INTAKE_FULL' }); },
      onStatus: (s) => statuses.push(s)
    });
    await adapter.connect();
    for (let i = 0; i < 50 && !statuses.some(s => s.state === 'down'); i++) await new Promise(r => setTimeout(r, 5));
    fail = false;
    await adapter.disconnect();
    const down = statuses.find(s => s.state === 'down');
    A.eq(down && down.cause, 'intake', 'intake: a receipt that cannot be written reports \'down\' with cause \'intake\' (' + JSON.stringify(down) + ')');
    // the host's status closure keeps the cause (startTelegram's onStatus, lifted), and the gate attempts a send on it
    const holder = { telegramStatus: { connected: false, state: 'connecting', detail: '', delivery: { state: 'unknown', detail: '', at: 0 } } };
    const onStatus = st.lift('function (s) { const f = (' + liftProp(callRegion(sidecarTopLevelFunction('startTelegram'), 'const adapter = makeTelegramAdapter({', '\n  });'), 'onStatus') + '); f(s); return telegramStatus; }',
      { telegramStatus: holder.telegramStatus, telegram: { adapter: {} }, hub: { onStatus() {} } });
    const kept = onStatus(down || { state: 'down', detail: 'durable intake failed', cause: 'intake' });
    A.eq(kept && kept.cause, 'intake', 'intake: startTelegram\'s status closure keeps the cause (' + JSON.stringify(kept) + ')');
    st.health.telegram = kept;
    let m = st.mark();
    const tried = st.channelOutbound ? await st.channelOutbound.send({ channel: 'telegram', chatId: '4242' }, 'the digest is ready', { durable: false, reason: 'notify' }) : { ok: false };
    A.eq([tried.ok, st.since(m).calls.length], [true, 1], 'intake: a send is attempted on a channel whose intake is held (intake backpressure is not a transport outage)');
    st.health.telegram = { connected: false, state: 'down', detail: 'poll error', cause: '' };
    m = st.mark();
    const refused = st.channelOutbound ? await st.channelOutbound.send({ channel: 'telegram', chatId: '4242' }, 'the digest is ready', { durable: false, reason: 'notify' }) : { ok: true };
    A.eq([refused.ok, st.since(m).calls.length], [false, 0], 'intake: a transport down is still refused before any transport call');
  });

  A.report('channels.outbound.contract.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
