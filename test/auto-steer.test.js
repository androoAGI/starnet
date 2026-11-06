/* Automatic mid-task messages: execute the browser queue and real loop, including receipt races. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('./_assert.js');
const Message = require('../frontend/app/steering-message.js');
const { makeSteerBuffers } = require('../sidecar/steer-buffer.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { joinReplyDelta } = require('../sidecar/reply-assembler.js');
const TurnMerge = require('../frontend/app/turnmerge.js');
const HistoryFit = require('../frontend/app/historyfit.js');
const source = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
const plain = value => JSON.parse(JSON.stringify(value));
const attachment = { path: 'attachments/reference.txt', name: 'reference.txt', kind: 'file', mediaType: 'text/plain' };
function browserRig(response) {
  let running = true, runId = 'r1';
  const posts = [], disk = new Map(), lines = [], flushes = [], timers = [];
  const ctx = vm.createContext({ Promise, JSON, Date, Math, SteeringMessage: Message, console, setTimeout: fn => timers.push(fn),
    activeWs: { id: 's1' }, autoSteerBusy: new Set(), autoSteerWait: new Map(), interrupted: new Set(),
    queued: new Map(), sentNow: new Map(), heldBack: new Map(), input: { value: '' }, pendingAtts: [],
    Channels: { isBusy: () => running, runIdOf: () => runId, peek: () => ({ acc: '' }) },
    Workstreams: { get: id => ({ id }) }, pendingAskFor: () => false, renderQueued() {}, renderAttachStrip() {}, autoGrowInput() {},
    localLine: t => lines.push(t), flushQueued: id => flushes.push(id), reconcileSentNow() {},
    localStorage: { getItem: k => disk.get(k), setItem: (k,v) => disk.set(k,v) },
    fetch: async (url, options) => { const body = JSON.parse(options.body); posts.push(body); return response ? response(body, posts.length) : { status: 200, json: async () => ({ ok: true }) }; }
  });
  // the page's one JSON client, over the same stub fetch: { ok, status, j } as harness.js's readReply gives it
  ctx.Harness = { api: { post: async (url, body) => { const r = await ctx.fetch(url, { method: 'POST', body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch (_) {} const status = Number(r.status) || 0; return { ok: status >= 200 && status < 300 && !!j && typeof j === 'object' && j.ok !== false, status, j }; } } };
  const names = ['steerQueued','qText','qAtts','keepSentNow','sentNowDisk','sentNowOverdue','dropSentNow','forgetSentNow',
    'markSentNowLanded','restoreSentNow','giveBack','settleSentNow','releaseSentNow'];
  vm.runInContext(names.map(n => A.fnBody(source, (n === 'steerQueued' ? 'async function ' : 'function ') + n)).join('\n'),ctx);
  return { ctx, posts, lines, disk, flushes, timers, setRun: id => { runId = id; }, end: () => { running = false; } };
}
async function loopScenario({ early = false, cancel = false, late = false } = {}) {
  const buffers = makeSteerBuffers(), events = [], requests = [], written = [];
  const note = { text: "How's it going?\nKeep working on the original report.", attachments: [] };
  const call = id => [{ type: 'tool_start', index: 0, id, name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: JSON.stringify({ path: id, content: 'report' }) }, { type: 'done', finishReason: 'tool_calls' }];
  const answer = text => [{ type: 'text', delta: text }, { type: 'done', finishReason: 'stop' }];
  const turns = early ? [answer('Checking progress.'), call('report'), answer('Report complete.')]
    : [call('outline'), answer('The outline is written; I am continuing the report.'), call('report'), answer('Report complete.')];
  const replay = makeReplayProvider({ turns });
  const ac = new AbortController();
  const provider = { ...replay, async *stream(req) {
    requests.push(plain(req.messages));
    for await (const e of replay.stream(req)) {
      if (late && requests.length === 2 && e.type === 'text') buffers.post('r', '', true, 'late', note);
      yield e;
    }
  } };
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_write', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, run: async args => {
    written.push(args.path);
    if (written.length === 1 && !early && !late) buffers.post('r', '', true, 'status', note);
    if (cancel) ac.abort();
    return 'wrote ' + args.path;
  } });
  if (early) buffers.post('r', '', true, 'early', note);
  const messages = [{ role: 'user', content: 'Write the whole report, including its outline.' }];
  const result = await runAgentLoop({ messages, provider, model: 'replay/model', agentId: 'a', runId: 'r', isTask: true,
    emit: (name,payload) => events.push({ name,payload }), cost: makeCostEngine({ priceOf: replay.priceOf }),
    tools: [], limits: { maxIters: 8, grace: false }, signal: ac.signal,
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' },
    dispatch: (c,ctx) => reg.dispatch(c,ctx), steer: () => buffers.drain('r'), steerClose: () => buffers.close('r') });
  return { result, events, requests, written, messages };
}
(async () => {
  const original = { text: 'Use this code:\n```js\n  const x = 2;\n```\n' + 'x'.repeat(3000), attachments: [attachment] };
  const wire = Message.encode(original);
  assert(!wire.includes('\n')); assert.deepEqual(Message.decode(wire), original);
  assert.equal(Message.normalize({ text: 'x'.repeat(100001) }), null);
  assert.equal(Message.decode('@starnet-message-v1:{bad'), null);
  const b = makeSteerBuffers();
  assert.equal(b.post('r', '', true, 'n1', original).status, 200);
  assert.equal(b.post('r', '', true, 'n1', original).body.duplicate, true);
  assert.equal(b.drain('r')[0].text, original.text);
  assert.equal(b.drain('r').length, 0);
  b.close('r'); assert.equal(b.post('r','',false,'n1',original).body.applied,true); assert.equal(b.post('r','',true,'n2',original).status,409);
  assert(!joinReplyDelta('', '\n[steering] '+wire+'\n').includes('@starnet-message'));
  const rows = [], store = makeTranscriptStore({ io: { readAll: () => rows, append: e => rows.push(e) }, clock: { now: () => 5 } });
  store.appendNewStrict('s1','a',[{role:'user',content:original.text,steeringWire:wire}],{sourceRunId:'r'});
  assert.equal(store.history('s1')[0].steeringWire,wire);
  const restored = makeTranscriptStore({ io: { readAll: () => rows, append: e => rows.push(e) }, clock: { now: () => 6 } });
  assert.equal(restored.history('s1')[0].steeringWire,wire);
  for (const options of [{},{early:true},{late:true}]) {
    const r=await loopScenario(options);
    assert.equal(r.result.reason,'done'); assert(r.written.includes('report'), 'status response must not end original work');
    assert(r.requests.some(ms => ms.some(m => typeof m.content==='string' && m.content.includes('<resume_after_message>'))) || options.late);
    for (let i=0;i<r.messages.length;i++) if (r.messages[i].tool_calls) assert.equal(r.messages[i+1].role,'tool');
    assert(r.events.some(e => e.name==='agent.token' && e.payload.delta.includes('[steering]')));
  }
  // TURN IDENTITY: the folded message is a steer row of its own (kind steer, the page's noteId), filed as a system row, never a station or directive row
  {
    const TurnKinds = require('../frontend/app/turnkinds.js');
    const r = await loopScenario({});
    const folded = (r.result.messages || r.messages).filter(m => m && m.steeringWire);
    assert.equal(folded.length, 1, 'one folded mid-task message');
    assert.deepEqual({ kind: TurnKinds.tagOf(folded[0]).kind, noteId: TurnKinds.tagOf(folded[0]).noteId }, { kind: 'steer', noteId: 'status' });
    const filed = [], identityStore = makeTranscriptStore({ io: { readAll: () => filed, append: e => filed.push(e) }, clock: { now: () => 7 } });
    identityStore.appendNewStrict('s2', 'a', [folded[0]], { sourceRunId: 'r', turnId: 't_0123456789abcdefghijk', kindOf: m => TurnKinds.messageKind(m, 'turn') });
    assert.deepEqual({ role: filed[0].role, kind: filed[0].kind, noteId: filed[0].noteId, wire: filed[0].steeringWire }, { role: 'system', kind: 'steer', noteId: 'status', wire: folded[0].steeringWire });
  }
  const stopped=await loopScenario({cancel:true}); assert.equal(stopped.result.reason,'cancelled'); assert.deepEqual(stopped.written,['outline']);
  let r=browserRig(); r.ctx.queued.set('s1',[{text:original.text,atts:[attachment]},'second']);
  await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,2); assert.deepEqual({text:r.posts[0].message.text,attachments:r.posts[0].message.attachments},original); assert.equal(r.posts[1].message.text,'second');
  assert.equal(r.ctx.queued.has('s1'),false);
  r.ctx.restoreSentNow('s1','r1'); assert(r.ctx.input.value.includes(original.text)); assert.equal(r.ctx.pendingAtts[0].ref.path,attachment.path);
  assert.equal(r.ctx.sentNow.has('s1'),false);
  // Connecting does not misroute; run confirmation hands the retained message to that exact run.
  r=browserRig(); r.setRun(null); r.ctx.queued.set('s1',['hello']); await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,0);
  r.setRun('confirmed'); await r.ctx.steerQueued('s1'); assert.equal(r.posts[0].runId,'confirmed');
  // Upload ordering and explicit /queue remain respected.
  r=browserRig(); r.ctx.queued.set('s1',[{text:'first',uploads:[{}]},'second']); await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,0);
  r.ctx.queued.set('s1',[{text:'later',afterRun:true}]); await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,0);
  // A lost HTTP response retries the identical note id; it never creates two messages.
  r=browserRig((body,n) => { if(n===1) throw Error('lost response'); return {status:200,json:async()=>({ok:true})}; });
  r.ctx.queued.set('s1',['hello']); await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,2); assert.equal(r.posts[0].noteId,r.posts[1].noteId);
  // Redaction may change displayed bytes; the receipt still identifies the same message.
  r=browserRig(); r.ctx.queued.set('s1',['a secret that will be redacted']); await r.ctx.steerQueued('s1');
  const received=r.ctx.sentNow.get('s1')[0];
  r.ctx.markSentNowLanded('s1','r1','\n[steering] '+Message.encode({text:'[REDACTED]',id:received.id})+'\n');
  assert.equal(received.landed,true);
  assert(Message.containsWire('\n[steering] '+Message.encode({text:'[REDACTED]',id:received.id})+'\n',received.wire));
  // Completed-run refusal retains files for exactly one next turn.
  r=browserRig(()=>({status:409,json:async()=>({ok:false})})); r.ctx.queued.set('s1',[{text:'look',atts:[attachment]}]);
  await r.ctx.steerQueued('s1'); assert.equal(r.ctx.queued.get('s1')[0].atts[0].path,attachment.path);
  await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,1,'no refusal retry spin');
  // A 429 after its drain echo still retries; it must not wait until the entire run finishes.
  r=browserRig((body,n)=>({status:n===1?429:200,json:async()=>({ok:n!==1})})); r.ctx.queued.set('s1',['capacity']);
  await r.ctx.steerQueued('s1'); assert.equal(r.posts.length,1); await r.timers[0](); assert.equal(r.posts.length,2); assert.equal(r.ctx.queued.has('s1'),false);
  // Stop while POST is unresolved must not dispatch the queued second message or requeue behind Stop.
  let resolve; r=browserRig(()=>new Promise(r=>{resolve=r;})); r.ctx.queued.set('s1',['first','second']);
  const sending=r.ctx.steerQueued('s1'); await tick(); r.ctx.interrupted.add('s1'); r.ctx.queued.delete('s1'); r.ctx.restoreSentNow('s1','r1');
  resolve({status:200,json:async()=>({ok:true})}); await sending; assert.equal(r.posts.length,1); assert.equal(r.ctx.input.value,'first'); assert.equal(r.ctx.queued.has('s1'),false);
  // The durable transcript and streamed echo restore as one row, including a second reload.
  const merge = (l, r) => TurnMerge.legacyWithIdentity(l, r, null);
  const local=[{role:'system',sys:true,steerEcho:true,sourceRunId:'r',content:'[steering] '+wire}];
  const remote=[{role:'user',sourceRunId:'r',content:original.text,steeringWire:wire}];
  const merged=merge(local,remote); assert.equal(merged.length,1); assert.equal(merge(merged,remote).length,1);
  assert.equal(merge([],remote)[0].content,'[steering] '+wire);
  assert.equal(Message.displayRows(merged)[0].content,original.text);
  const phone=Message.displayRows([{role:'assistant',content:'Before.\n[steering] '+wire+'\nAfter.'}]);
  assert.deepEqual(phone.map(r=>r.role),['assistant','user','assistant']);
  assert.equal(phone[1].content,original.text);
  const outbound = new Function('SteeringMessage','HistoryFit','stationModes', A.fnBody(source,'function historyWindowFrom')+';return historyWindowFrom;')(Message,HistoryFit,{ window: 'legacy' });
  const twice=[{role:'user',sourceRunId:'r',content:'status?',steeringWire:Message.encode({text:'status?',id:'first'})},{role:'user',sourceRunId:'r',content:'status?',steeringWire:Message.encode({text:'status?',id:'second'})}];
  assert.equal(merge([],twice).length,2,'identical messages sent twice remain distinct');
  assert.equal(outbound(merged)[0].role,'user'); assert.equal(outbound(merged)[0].content,original.text);
  console.log('auto-steer.test: PASS (lossless messages, status continuation, cancellation, ordering, delivery races, durable history)');
})().catch(e=>{ console.error(e); process.exitCode=1; });
