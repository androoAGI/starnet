/* node test/reply-assembler.census.test.js — ONE ReplyAssembler for every reply sink, and ONE ending for every withdrawn run
   (channel-delivery-ledger S5; the families of bugs e903a199 and 600f4982).

   THE SINKS. There is no agent.message event: every surface that keeps a run's words rebuilds them from its agent.token
   deltas. A steered run echoes its note as one delta, '\n[steering] <note>\n' (loop.js foldSteerNotes), and only the channel
   hub read that shape. The cron driver, the loop driver and the host's scheduled-hop, Run Now, Run Now hop, night-shift and
   step-test sinks each concatenated raw, so a steered routine delivered 'First answer.\n[steering] also add a sonnet\n...'.

   THE CENSUS (source, through test/helpers/source.js): every line of sidecar/ that names agent.token is an emitter, the
   assembler itself, a declared live-stream surface or a declared reader that keeps no reply, each with its reason; nothing
   else folds a run's deltas; the assembler's users are exactly the five remaining stream sinks; and joinReplyDelta is called nowhere else.

   THE BEHAVIOUR: a steered run and an ordinary run through every sink the way production runs them: the REAL hub (entry and
   line hop), the REAL cron driver, the REAL loop driver, and the two remaining host stream sinks LIFTED out of sidecar/index.js.
   The stream sinks deliver '↪ <note>' on its own line, never '[steering]', and ordinary streams byte for byte. Line hops now
   use the real LineRunner profiles and the run's accepted terminal text; streamed narration/steering cannot become their work. A seeded
   property says the same of the assembler: its text differs from a raw fold only when a steering echo is in the stream.

   THE ENDINGS. A run's ending was four flags (superseded, supersededBy, halted, faulted) with three writers and fourteen hub
   reads, and one flag carrying two meanings was the bug. A withdrawn run now carries one endReason, the first one written
   stands, and hub.js and steptest.js read it only through endOf: a source census, and a matrix through a REAL hub and the
   real killAll/markFaulted of each way a run is withdrawn, with what the chat is told.

   RED at trunk a3af8dafd (scratch checkout, this file copied in): the census finds the nine sinks, seven of them raw, and
   none using an assembler; the real cron driver, the loop driver and every lifted host sink deliver the raw marker; the
   record has no endReason, a run stopped and then killed or superseded tells the chat twice, a superseded one is told it
   was an E-STOP, and hub.js and steptest.js read the flags. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sidecarSourceFiles, readSidecarIndex, sidecarTopLevelFunction } = require('./helpers/source.js');
const { makeClock } = require('../shared/clock-rng.js');
const cron = require('../sidecar/cron.js');
const cronStore = require('../sidecar/cron-store.js');
const { makeCronDriver } = require('../sidecar/cron-driver.js');
const LoopStore = require('../sidecar/loopjob-store.js');
const { makeLoopDriver } = require('../sidecar/loopjob-driver.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const LineRunner = require('../sidecar/routing/line-runner.js');
const { makeRunTable } = require('../sidecar/run-table.js');
const { killAll, markFaulted } = require('../sidecar/halt.js');
// the assembler is this lane's; a trunk tree has none, and its cases say so
const ASSEMBLER = path.join(__dirname, '..', 'sidecar', 'reply-assembler.js');
const makeReplyAssembler = fs.existsSync(ASSEMBLER) ? require(ASSEMBLER).makeReplyAssembler : undefined;

const guard = async (label, fn) => { try { await fn(); } catch (e) { A.ok(false, label + ' could not run: ' + ((e && e.message) || e)); } };
const settle = async (n) => { for (let i = 0; i < (n || 50); i++) await new Promise(r => setImmediate(r)); };

/* ---- 1. THE CENSUS: every line that names agent.token ---------------------------------------------------------------- */
const NAMES_IT = /(['"`])agent\.token\1/;
const EMITS_IT = /\b\w*[eE]mit\(\s*['"`]agent\.token/;   // a run's own events going out: nothing is kept
const THE_ONE = { rel: 'sidecar/reply-assembler.js', at: /if \(name === 'agent\.token'\) \{ buf = joinReplyDelta\(buf, /, why: 'the one fold' };
/* A LIVE-STREAM SURFACE forwards each delta to a client as it arrives, and that client draws the run itself: a steered run's
   note is the client's own steer row. What such a surface keeps is what it already streamed, so a fold of its own would make
   its final text disagree with the deltas it sent. Their projection belongs to turn-identity and the ACP and remote owners. */
const LIVE_STREAMS = [
  { rel: 'sidecar/group-sessions.js', at: /if \(name === 'agent\.token'\) \{$/, why: 'a group turn\'s draft: every delta goes straight to the group transcript, with its tool chips at offsets into the text exactly as it streamed' },
  { rel: 'sidecar/openai-compat.js', at: /else if \(name === 'agent\.token'\) \{ const dlt = p\.delta/, why: '/v1 chat completions: each delta is one streamed chunk to an outside client, and the envelope must equal what the stream delivered' },
  { rel: 'sidecar/openai-compat.js', at: /if \(name === 'agent\.token'\) \{ const dlt = p\.delta \|\| ''; return dlt \? \{ event: 'message\.delta'/, why: '/v1/runs: one run event mapped to one typed message.delta, nothing kept' },
  { rel: 'sidecar/acp/core.js', at: /if \(name === 'agent\.token'\) \{$/, why: 'ACP: each delta is a message chunk to the editor, and the turn\'s answer is what those chunks said' },
  { rel: 'sidecar/remote/host.js', at: /if \(name === 'agent\.token'\) \{ buf \+= \(p\.delta \|\| ''\); if \(!timer\)/, why: 'the phone relay: a coalesced live frame of the text so far, for an app that draws its own run view' }
];
// a reader that keeps no reply at all
const KEEPS_NO_REPLY = [
  { rel: 'sidecar/group-sessions.js', at: /\['agent\.token', 'agent\.run\.start', 'agent\.tool_call', 'agent\.tool_result'\]\.includes\(name\)/, why: 'liveness: any of these proves the turn is working' },
  { rel: 'sidecar/observer.js', at: /case 'agent\.token':$/, why: '/api/observe: one event projected and clipped, nothing kept' },
  { rel: 'sidecar/subagents.js', at: /PROGRESS_EVENTS = new Set\(\['agent\.run\.start', 'agent\.token'/, why: 'liveness: a worker that streams is not stalled' },
  { rel: 'sidecar/index.js', at: /\(name === 'agent\.token' && payload\.delta\) \|\| name === 'agent\.tool_call'/, why: 'the answer hold: the first streamed word spends it' },
  { rel: 'sidecar/routing/line-runner.js', at: /if \(name === 'agent\.token'\) return;/, why: 'hops ignore streamed prose and hand on only runOnce returned terminal text after its outcome is accepted' },
  { rel: 'sidecar/run-table.js', at: /const CALL_EVENTS = new Set\(\['agent\.cost', 'cost\.estimate', 'agent\.token'/, why: 'the run table records that a provider call started; it keeps no reply bytes' },
  { rel: 'sidecar/run-streams.js', at: /\{"k":"<key>","name":"agent\.token"/, why: 'the wire format, in the header comment' }
];
const DECLARED = [THE_ONE].concat(LIVE_STREAMS, KEEPS_NO_REPLY);
const FILES = sidecarSourceFiles();
const where = (s) => s.rel + ':' + s.n + ' ' + s.line.trim().slice(0, 90);
const sites = [];
for (const f of FILES) f.text.split('\n').forEach((line, i) => { if (NAMES_IT.test(line) && !EMITS_IT.test(line)) sites.push({ rel: f.rel, n: i + 1, line: line }); });
const declaredBy = (s) => DECLARED.filter(d => d.rel === s.rel && d.at.test(s.line));
A.eq(sites.filter(s => !declaredBy(s).length).map(where), [],
  'every line that names agent.token is the assembler or a declared reader: a sink that keeps a reply feeds makeReplyAssembler (a live-stream surface or a reader that keeps none is declared here, with its reason)');
for (const d of DECLARED) {
  A.ok(sites.filter(s => declaredBy(s).includes(d)).length === 1, 'exactly one line answers to ' + d.rel + ' (' + d.why + ')');
  A.ok(String(d.why || '').length > 10, d.rel + ' says why it is exempt');
}
A.eq(Array.from(new Set(LIVE_STREAMS.map(d => d.rel))), ['sidecar/group-sessions.js', 'sidecar/openai-compat.js', 'sidecar/acp/core.js', 'sidecar/remote/host.js'], 'the live-stream surfaces are the plan\'s four, and no more');

// a fold that never names the event: the provider-stream readers (ev.type 'text': one model call, no run, no steering) are the rest
const FOLDS_DELTA = /\+=[^;]*\.delta\b/;
const folds = [];
for (const f of FILES) f.text.split('\n').forEach((line, i) => { if (FOLDS_DELTA.test(line) && !/ev\.type === 'text'/.test(line)) folds.push({ rel: f.rel, n: i + 1, line: line }); });
A.eq(folds.filter(s => !LIVE_STREAMS.some(d => d.rel === s.rel && d.at.test(s.line))).map(where), [], 'nothing folds a run\'s deltas by hand');

// LJR retired the three inline host hops and the hub's hop fold: the shared runner consumes accepted output instead.
const SINKS = { 'sidecar/index.js': 2, 'sidecar/channels/hub.js': 1, 'sidecar/cron-driver.js': 1, 'sidecar/loopjob-driver.js': 1 };
const users = {};
for (const f of FILES) {
  if (f.rel === THE_ONE.rel) continue;
  const n = (f.text.match(/\bmakeReplyAssembler\(\)/g) || []).length;
  if (n) users[f.rel] = n;
}
A.eq(users, SINKS, 'hub entry, cron, loop, Run Now entry and night shift each build one assembler; line hops use accepted terminal output');
A.eq(FILES.filter(f => f.rel !== THE_ONE.rel && /\bjoinReplyDelta\(/.test(f.text)).map(f => f.rel), [], 'joinReplyDelta is called only by the assembler');

/* ---- 2. THE RUN: the loop's own wire shapes ----------------------------------------------------------------------------- */
const STEERED = ['Let me look.', '<tool>', 'First answer.', '\n[steering] also add a sonnet\n', '\n\n', 'Second answer.'];
const STEERED_REPLY = 'First answer.\n\n↪ also add a sonnet\n\nSecond answer.';
const ORDINARY = ['Let me look.', '<tool>', 'Plain ', 'answer.', '\n\n', 'A [steering] word stays a word.'];
const ORDINARY_REPLY = 'Plain answer.\n\nA [steering] word stays a word.';
const TERMINAL_REPLY = 'Accepted terminal work. The stream-only notes are not the handoff.';
function runHost(deltas, reason, terminalText) {
  return async (o) => {
    const ids = { agentId: o.agentId, runId: o.runId };
    o.emit('agent.run.start', ids);
    for (const d of deltas) {
      if (d === '<tool>') o.emit('agent.tool_call', Object.assign({ callId: 'c1', name: 'web.search', argsSummary: '{}' }, ids));
      else o.emit('agent.token', Object.assign({ delta: d }, ids));
    }
    o.emit('agent.run.end', Object.assign({ reason: reason || 'done', turns: 1, usd: 0 }, ids));
    return { reason: reason || 'done', ...(terminalText !== undefined ? { text: terminalText } : {}) };
  };
}

/* ---- 3. THE SINKS: each one the way production runs it ------------------------------------------------------------------- */
const fakeStore = () => {
  const hist = new Map();
  return { loadHistory: (a) => (hist.get(a) || []).slice(), appendTurn: (a, role, content) => { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; }, getChatRecord: () => null };
};
let seq = 0;
const dm = (text) => ({ channel: 'telegram', chatId: '4242', chatType: 'dm', userId: 'u1', text, messageId: String(++seq), ts: seq });

async function hubEntry(deltas) {
  const sends = [];
  const hub = makeChannelHub({ runOnce: runHost(deltas), store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'hub-run-' + (++seq) });
  await hub.onInbound(dm('go'));
  return { text: sends.join('|') };
}
async function hubHop(deltas, terminalText = TERMINAL_REPLY) {
  const sends = [];
  let runs = 0;
  const hop = runHost(deltas, 'done', terminalText);
  const runOnce = (o) => (++runs === 1 ? runHost(['stage one'], 'done', 'stage one')(o) : hop(o));
  const chain = {
    advance: async (c) => { const r = await c.runAgent({ agentId: 'writer', text: 'handed on', signal: c.signal }); return { text: r.text, hops: [{ agentId: 'writer' }], agentId: 'writer', usd: 0, stopped: null }; },
    stopNote: () => ''
  };
  const hub = makeChannelHub({ runOnce, store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'hop-run-' + (++seq), chain, resolveRunConfig: () => ({ ok: true, key: 'k', model: 'm' }) });
  await hub.onInbound(dm('go'));
  return { text: sends.join('|') };
}
const T0 = 1700000000000;
async function cronFire(deltas, reason) {
  const clock = makeClock(T0);
  let store = [cronStore.makeJob({ id: 's1', prompt: 'report', agentId: 'ag', schedule: cron.parseSchedule('every 1m', T0), deliver: 'origin', origin: { channel: 'telegram', chatId: '777' } }, { id: 's1', now: T0 })];
  const delivered = [];
  const driver = makeCronDriver({
    getJobs: () => store, setJobs: (j) => { store = j; return true; }, runOnce: runHost(deltas, reason),
    emit: () => {}, newId: () => 'run-steer', newAbort: () => new AbortController(), now: () => clock.now(),
    getKey: () => 'sk-test', defaultModel: 'test/model', persona: 'P', maxRunMs: 480000,
    deliverResult: (j, r) => { delivered.push(r.text); return { ok: true, deliveredTargets: ['@origin'] }; }
  });
  clock.set(T0 + 60000);
  driver.applyTick(clock.now());
  await settle();
  return { text: delivered.join('|'), error: cronStore.getJob(store, 's1').lastError };
}
async function loopPass(deltas, reason) {
  let loops = LoopStore.createLoop([], { id: 'l1', objective: 'find bugs', agentId: 'agent' }, { now: T0 });
  let harvested = null, idN = 0;
  const host = runHost(deltas, reason);
  const driver = makeLoopDriver({
    getLoops: () => loops, setLoops: (next) => { loops = next; return true; }, runOnce: host,
    newId: () => 'run' + (++idN), newAbort: () => { const s = { aborted: false }; return { signal: s, abort() { s.aborted = true; } }; },
    now: () => T0, isHalted: () => false, concurrencyFree: () => true, defaultModel: 'test-model', persona: 'P', ledger: () => {},
    harvest: (loop, res) => { harvested = res.text; return { text: res.text, title: 't', usd: 0 }; }
  });
  driver.applyTick(T0);
  await settle();
  return { text: harvested == null ? '' : harvested, error: LoopStore.getLoop(loops, 'l1').iterations[0].error };
}

// The two remaining host stream sinks are lifted whole. Their lifecycle dependency is the actual RunTable.
const stubs = (host) => ({
  makeReplyAssembler, runOnce: host, crypto: { randomUUID: () => 'run-lifted' }, runTable: makeRunTable({ now: () => T0 }),
  cronSystemFor: () => 'P', RunOutcome: require('../frontend/app/runoutcome.js')
});
const idx = readSidecarIndex();
async function nightShift(deltas) {
  const fn = vm.runInNewContext('(' + sidecarTopLevelFunction('nightshiftChat') + ')', Object.assign(stubs(runHost(deltas)), {
    NIGHTSHIFT_AGENT: 'ns', cronIdentityFor: () => ({}), cronProviderFor: () => 'p', cronKeyFor: () => 'k', cronModelFor: () => 'm', cronHasCredential: () => true, PromptScrub: { scrubStored: (s) => s }
  }));
  return fn({ agentId: 'ns', messages: [] });
}
// The retired inline bodies are not compatibility shims. Exercise the shared production profiles, with
// deliberately different streamed and returned text, and pin that the host still selects these profiles.
for (const name of ['schedule', 'manual', 'steptest']) {
  A.ok(new RegExp('LineRunner\\.profiles\\.' + name + '\\(').test(idx), 'the host uses the real ' + name + ' LineRunner profile');
}
async function profiledHop(kind, deltas, terminalText = TERMINAL_REPLY) {
  const table = makeRunTable({ now: () => T0 });
  const runner = LineRunner.makeLineRunner({ runOnce: runHost(deltas, 'done', terminalText), now: () => T0,
    newId: () => 'profile-run-' + (++seq), liveRuns: { add: (runId, rec) => {
      const lease = table.admit(Object.assign({}, rec, { runId }));
      return () => lease.release();
    } } });
  const profile = LineRunner.profiles[kind]({
    config: () => ({ ok: true, key: 'k', model: 'm', provider: 'p', configured: true, system: 'P' }),
    system: () => 'P', station: () => null, persona: 'P', brief: () => null, dockSystem: p => p,
    streamId: 'profile-stream', emit: () => {}, redact: x => x
  });
  const result = await runner.hopRunner(profile)({ agentId: 'writer', entry: true, text: 'handed on',
    streamId: 'profile-stream', sessionId: 'profile-session', signal: null });
  A.eq(table.size(), 0, kind + ': its own returned admission is released after completion');
  return result;
}
const stepTest = (deltas, terminalText) => profiledHop('steptest', deltas, terminalText);
const scheduledHop = (deltas, terminalText) => profiledHop('schedule', deltas, terminalText);
const runNow = () => sidecarTopLevelFunction('handleCronRun');
async function runNowEntry(deltas) {
  const src = runNow();
  const from = src.indexOf("  const state = { buf: ''");
  const end = src.indexOf('\n  };\n', src.indexOf('const teeEmit', from)) + 6;
  const lifted = vm.runInNewContext('(function () {\n' + src.slice(from, end) + '\nreturn { teeEmit: teeEmit, state: state };\n})()', {
    makeReplyAssembler, emit: () => {}, cronDriver: { leases: new Map() }, job: { id: 'j' }, runId: 'r'
  });
  await runHost(deltas)({ agentId: 'ag', runId: 'r', emit: lifted.teeEmit });
  return { text: lifted.state.buf, tools: lifted.state.toolsRan };
}
const runNowHop = (deltas, terminalText) => profiledHop('manual', deltas, terminalText);

const EVERY_SINK = [
  ['the hub\'s entry run', hubEntry],
  ['the cron driver', cronFire], ['the loop driver', loopPass],
  ['Run Now', runNowEntry], ['night shift', nightShift]
];
const TERMINAL_HOPS = [['the hub\'s line hop', hubHop], ['a scheduled fire\'s line hop', scheduledHop],
  ['a Run Now line hop', runNowHop], ['the step test', stepTest]];

/* ---- 4. A WITHDRAWN RUN: each way, through a real hub, with what the chat is told ----------------------------------------- */
function parkedRun() {
  const sends = [], deliveries = [];
  let calls = 0, release = null;
  const latch = new Promise(r => { release = r; });
  const runOnce = async (o) => {
    const ids = { agentId: o.agentId, runId: o.runId };
    o.emit('agent.run.start', ids);
    if (++calls > 1) { o.emit('agent.token', Object.assign({ delta: 'the newer reply' }, ids)); o.emit('agent.run.end', Object.assign({ reason: 'done', turns: 1, usd: 0 }, ids)); return; }
    o.emit('agent.token', Object.assign({ delta: 'half an answ' }, ids));
    await new Promise(res => { if (o.signal.aborted) return res(); o.signal.addEventListener('abort', () => res(), { once: true }); });
    await latch;   // still unwinding: the record stays in the chat's inflight slot until the test lets it go
    o.emit('agent.run.end', Object.assign({ reason: 'cancelled', turns: 0, usd: 0 }, ids));
  };
  const h = { sends, deliveries, calls: () => calls, onEmit: null, release: () => release() };
  h.hub = makeChannelHub({ runOnce, store: fakeStore(), send: (c, t) => { sends.push(t); deliveries.push({ chatId: String(c), text: t }); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'end-run-' + (++seq), isOwner: () => true,
    emit: (name, payload) => { if (h.onEmit) h.onEmit(name, payload); } });
  h.live = () => h.hub._internals.inflight;
  return h;
}
const SAID_ESTOP = /E-STOP was pressed/, SAID_FAULT = /internal fault/, SAID_SUPERSEDE = /Stopped the earlier task/, SAID_STOP = /^Stopped the run in progress\.$/;
const ALL_SAID = [SAID_ESTOP, SAID_FAULT, SAID_SUPERSEDE, SAID_STOP];
const newer = (h) => h.hub.onInbound(dm('a newer message'));
const ENDINGS = [
  ['a newer message', 'superseded', [SAID_SUPERSEDE], newer],
  ['/stop', 'stopped', [SAID_STOP], async (h) => { await h.hub.onInbound(dm('/stop')); }],
  ['the owner\'s plain "stop"', 'stopped', [SAID_STOP], async (h) => { await h.hub.onInbound(dm('stop')); }],
  ['E-STOP', 'halted', [SAID_ESTOP], async (h) => { killAll(null, h.live()); }],
  ['the station\'s own fault', 'faulted', [SAID_FAULT], async (h) => { markFaulted(h.live()); killAll(null, h.live()); }],
  // THE FIRST ENDING STANDS: a later kill still aborts, but the run keeps its ending and the chat is told one thing
  ['/stop, then an E-STOP while it unwinds', 'stopped', [SAID_STOP], async (h) => { await h.hub.onInbound(dm('/stop')); killAll(null, h.live()); }],
  ['/stop, then a newer message while it unwinds', 'stopped', [SAID_STOP], async (h) => { await h.hub.onInbound(dm('/stop')); await newer(h); }],
  ['E-STOP, then a newer message while it unwinds', 'halted', [SAID_ESTOP], async (h) => { killAll(null, h.live()); await newer(h); }],
  // The older run retains superseded; the new preparation already owns its own cancellable record.
  ['a newer message, then an E-STOP before its run starts', 'superseded', [SAID_SUPERSEDE, SAID_ESTOP], async (h) => {
    h.onEmit = (name) => { if (name === 'channel.inbound') { h.onEmit = null; h.newerOwner = h.live().get('4242'); killAll(null, h.live()); } };
    await newer(h);
  }, 0]
];

/* ---- 5. THE SOURCE: one field, one reader -------------------------------------------------------------------------------- */
const ENDING_FILES = ['sidecar/channels/hub.js', 'sidecar/routing/steptest.js', 'sidecar/halt.js'];
const fileText = (rel) => FILES.find(f => f.rel === rel).text;
for (const rel of ENDING_FILES) {
  // a work line's own outcome is not a run's ending: chain.js says a line someone stopped is `halted` (line.halted, and the hub's
  // copy of it for onLineOutcome, lo.halted: typed-outcomes), which no run record carries
  const flags = fileText(rel).split('\n').map((line, i) => ({ rel, n: i + 1, line })).filter(s => /(?<!\b(?:line|lo))\.(superseded|supersededBy|halted|faulted)\b|\b(superseded|halted): (true|false)/.test(s.line));
  A.eq(flags.map(where), [], rel + ': no run-end flag is read or written: a withdrawn run carries one endReason');
}
for (const rel of ENDING_FILES.slice(0, 2)) A.ok(!/\.endReason\b/.test(fileText(rel)) && /\bendOf\(/.test(fileText(rel)), rel + ': reads the ending only through endOf(rec)');
const hubEndSource = fileText('sidecar/channels/hub.js');
const prestartStop = /if \(lineJob && lineJob\.stopRequested\) \{\s*markEnd\(myRec, lineJob\.stopRequested === 'fault' \? 'faulted' : 'halted'\);\s*if \(await abandoned\(\)\) \{ withdrawn = true; return; \}\s*\}/.exec(hubEndSource);
A.ok(!!prestartStop && prestartStop.index < hubEndSource.indexOf('if (!markAttempt({ runId: runId'),
  'the prestart STOP receipt is consumed through first-wins markEnd and withdrawal before any run attempt');
const editDispatchGuard = /if \(msg\.edited && !delivery\.editReady\(msg, intake\)\) \{\s*markEnd\(myRec, delivery\.editState\(msg, intake\) === 'superseded' \? 'superseded' : 'faulted'\);\s*withdrawn = true; await abandoned\(\); return;\s*\}/.exec(hubEndSource);
A.ok(!!editDispatchGuard && hubEndSource.indexOf('if (!markAttempt({ runId: runId', editDispatchGuard.index) > editDispatchGuard.index,
  'an edit whose receipt lost admission withdraws through first-wins markEnd before the paid attempt');
const withoutPrestartStop = prestartStop ? hubEndSource.replace(prestartStop[0], '') : hubEndSource;
const withoutNamedGuards = editDispatchGuard ? withoutPrestartStop.replace(editDispatchGuard[0], '') : withoutPrestartStop;
A.ok(!/\.endReason\s*=/.test(hubEndSource) && (withoutNamedGuards.match(/\bmarkEnd\(/g) || []).length === 4,
  'the other first-wins owners remain supersede, /stop, plain stop and the LineJob live stop handle');

(async () => {
  /* ---- the assembler itself ---- */
  if (!makeReplyAssembler) A.ok(false, 'sidecar/reply-assembler.js exports makeReplyAssembler');
  else {
    const a = makeReplyAssembler();
    A.eq([a.text(), a.toolsRan], ['', 0], 'a new reply is empty, with no tools');
    A.eq(a.feed('agent.token', { delta: 'narration' }), 'token', 'a token is fed');
    A.eq(a.text(), 'narration', 'and is the reply so far');
    A.eq(a.feed('agent.tool_call', { name: 't' }), 'tool', 'a tool call is fed');
    A.eq([a.text(), a.toolsRan], ['', 1], 'and resets the reply: what came before it was narration');
    for (const other of ['agent.run.start', 'agent.tool_result', 'agent.run.error', 'agent.run.end', 'capdenied', 'crew.tool_step']) A.eq(a.feed(other, { delta: 'x' }), '', other + ' is the sink\'s own business');
    A.eq(a.text(), '', 'and changes nothing here');
    A.notThrows(() => { a.feed('agent.token'); a.feed('agent.token', null); a.feed('agent.token', {}); }, 'a token with no delta is nothing, never a throw');
    A.eq(a.text(), '', 'and adds nothing');

    // THE TEXT CHANGES ONLY WHEN A STEERING ECHO IS IN THE STREAM: seeded, any mix of deltas and tool calls folds exactly as the raw concat did
    const PIECES = ['Hello ', 'world', '.', '\n', '\n\n', '  indented', 'a [steering] word', '[steering] not on its own line', '\n[steering]', 'tail\n', '```js\n', ' ', ''];
    let x = 20261102;
    const rnd = (n) => { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; return (x >>> 8) % n; };
    let same = 0;
    for (let round = 0; round < 400; round++) {
      const s = makeReplyAssembler();
      let raw = '', tools = 0;
      for (let i = 0, len = 1 + rnd(40); i < len; i++) {
        if (rnd(9) === 0) { s.feed('agent.tool_call', {}); raw = ''; tools++; continue; }
        const d = PIECES[rnd(PIECES.length)];
        s.feed('agent.token', { delta: d }); raw += d;
      }
      if (s.text() === raw && s.toolsRan === tools) same++;
    }
    A.eq(same, 400, 'a stream with no steering echo folds byte for byte as a raw concat, tool resets included');
  }

  /* ---- every sink ---- */
  for (const [name, run] of EVERY_SINK) {
    await guard(name, async () => {
      const steered = await run(STEERED);
      A.eq(steered.text, STEERED_REPLY, name + ': a steered run reads the way the hub writes it, the note on its own line');
      A.ok(!/\[steering\]/.test(steered.text), name + ': the raw marker never reaches what it keeps');
      A.eq((await run(ORDINARY)).text, ORDINARY_REPLY, name + ': an ordinary stream is byte for byte what it was');
    });
  }
  for (const [name, run] of TERMINAL_HOPS) {
    await guard(name, async () => {
      A.eq((await run(STEERED, TERMINAL_REPLY)).text, TERMINAL_REPLY, name + ': accepted terminal work excludes streamed narration and steering');
      A.eq((await run(ORDINARY, TERMINAL_REPLY)).text, TERMINAL_REPLY, name + ': even an ordinary stream cannot replace accepted terminal work');
    });
  }
  for (const [name, run] of TERMINAL_HOPS.slice(1)) {
    await guard(name + ' empty terminal', async () => {
      const empty = await run(STEERED, '');
      A.eq(empty.text, '', name + ': an empty accepted result never falls back to streamed prose');
      A.eq(empty.stopCode, 'stage_empty', name + ': the empty hop keeps its typed stop');
    });
  }
  // the count the stop sentences read comes from the assembler now
  await guard('tools ran', async () => {
    const tools = (r) => r.tools;
    A.eq(tools(await stepTest(STEERED)), 1, 'the step test reports the tool calls it saw');
    A.eq(tools(await runNowEntry(STEERED)), 1, 'Run Now counts each tool call it streams');
    for (const [name, run] of [['the cron driver', cronFire], ['the loop driver', loopPass]]) {
      A.ok(/nothing was done/.test(String((await run(['nothing'], 'empty')).error)), name + ': an empty end before any tool says nothing was done');
      const after = String((await run(['Let me look.', '<tool>'], 'empty')).error);
      A.ok(after.length > 0 && !/nothing was done/.test(after), name + ': an empty end after a tool never does: ' + after);
    }
  });

  /* ---- every way a run is withdrawn ---- */
  for (const [how, end, said, withdraw, expectedNewerReplies] of ENDINGS) {
    await guard(how, async () => {
      const h = parkedRun();
      const first = h.hub.onInbound(dm('do the long thing'));
      await settle();
      const rec = h.live().get('4242');
      A.ok(!!rec, how + ': the run is live');
      await withdraw(h);
      h.release();
      await first;
      await settle();
      A.eq(rec.endReason, end, how + ': the record says how the run ended');
      for (const re of ALL_SAID) A.eq(h.sends.filter(t => re.test(t)).length, said.includes(re) ? 1 : 0, how + ': ' + re + ' — ' + JSON.stringify(h.sends));
      A.ok(!h.sends.some(t => /half an answ/.test(t)), how + ': the stale partial is abandoned');
      A.eq(h.sends.filter(t => t === 'the newer reply').length, expectedNewerReplies == null ? (/newer message/.test(how) ? 1 : 0) : expectedNewerReplies, how + ': only a newer message that was not itself stopped is answered');
      if (h.newerOwner) {
        A.ok(h.newerOwner !== rec && h.newerOwner.runId === '' && h.newerOwner.endReason === 'halted', 'E-STOP names the distinct newer preparation, without changing the older first-wins ending');
        A.eq(h.calls(), 1, 'the newer stopped preparation never dispatches a provider call');
        A.eq(h.deliveries.filter(d => SAID_ESTOP.test(d.text)).map(d => d.chatId), ['4242'], 'the pending-work stop acknowledgement reaches the same actual chat');
      }
      A.eq(Object.keys(rec).filter(k => /^(superseded|supersededBy|halted|faulted)$/.test(k)), [], how + ': and carries none of the old flags');
    });
  }

  /* ---- an ended run starts nothing more: E-STOP lands just as the entry run finishes ---- */
  await guard('an E-STOP at the end of the entry run', async () => {
    const sends = [];
    let advanced = 0, hub = null;
    const runOnce = async (o) => {
      const ids = { agentId: o.agentId, runId: o.runId };
      o.emit('agent.run.start', ids);
      o.emit('agent.token', Object.assign({ delta: 'stage one' }, ids));
      killAll(null, hub._internals.inflight);   // E-STOP lands just as the entry run finishes
      o.emit('agent.run.end', Object.assign({ reason: 'done', turns: 1, usd: 0 }, ids));
    };
    hub = makeChannelHub({ runOnce, store: fakeStore(), send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true, messageId: 'm' + sends.length }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: () => 'gate-run-' + (++seq),
      chain: { advance: async () => { advanced++; return { text: 'x', hops: [], usd: 0 }; }, stopNote: () => '' } });
    await hub.onInbound(dm('go'));
    A.eq(advanced, 0, 'a run an E-STOP ended never advances its line');
    A.eq(sends.filter(t => SAID_ESTOP.test(t)).length, 1, 'and the chat is told once: ' + JSON.stringify(sends));
  });

  A.report('reply-assembler.census');
})().catch(e => { console.error(e); process.exit(1); });
