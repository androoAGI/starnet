
'use strict';
const { readSidecarSource } = require('./helpers/source');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const backend = readSidecarSource();
const chat = fs.readFileSync(require.resolve('../frontend/app/chat.js'), 'utf8');
function extract(src, start, end) { return src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start))); }
test('file approval preserves every mutation argument beyond the run summary cap', () => {
 const src = extract(backend, 'function consentSummary(call, where)', 'function throttleSearch');
 const ctx = { redact: require('../sidecar/context.js').redact }; vm.createContext(ctx); vm.runInContext(src, ctx);
 for (const name of ['fs.edit','fs.patch','fs.write','fs.append']) {
  const args = { path: 'sample.txt', find: 'old'.repeat(200), replace: 'new'.repeat(200), patch: '@@\n-old\n+new', content: '<script>literal</script>' + 'x'.repeat(5000) };
  assert.deepEqual(JSON.parse(ctx.consentSummary({name,args})), args, name);
 }
 assert.equal(ctx.consentSummary({name:'fs.read',args:{path:'sample.txt'}}), 'sample.txt');
 // QA 10-02: the clipped fallback reaches a phone's lock screen (remoteAskWords) — a token in a command must never ride along
 const short = ctx.consentSummary({name:'shell.run',args:{command:'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://x'}});
 assert.ok(!/sk-ant-api03/.test(short) && /redacted/.test(short), 'fallback summary is redacted: ' + short);
});
test('rating controls name the originating task and run, even when an older card is shown', () => {
 const nodes=[];
 const elem=()=>({children:[],appendChild(n){this.children.push(n);},setAttribute(k,v){this[k]=v;}});
 const ctx={name:'NOVA', WORKRATE_COACH_KEY:'seen',localStorage:{getItem:()=> '1'}, document:{createElement:()=>{const n=elem();nodes.push(n);return n;}},runMeta:id=>({directive:id==='read-run'?'Read STATE.md and return the first heading':'Create one file'}), runWork:new Map()};
 vm.createContext(ctx); vm.runInContext(extract(chat,'function workRateControl(', '  // STANDALONE rate-the-work'),ctx);
 ctx.workRateControl(elem(),'agent','read-run');
 assert.ok(nodes.some(n=>String(n.textContent).includes('Read STATE.md and return the first heading')),'visible task evidence');
 assert.ok(nodes.some(n=>String(n.textContent).includes('read-run')),'visible stable run reference');
});
test('deliverable naming instruction yields to explicit task limits', () => {
 const src=extract(backend,'const DELIVERABLE_NOTE_CLAUSE =','const DELIVERABLE_NOTES_MAX');
 const clause=vm.runInNewContext(src+'; DELIVERABLE_NOTE_CLAUSE');
 assert.match(clause,/optional/i);
 assert.match(clause,/no further actions/i);
});

test('Codex probe sends Medium to Astra and completes instead of the unsupported-none 400', async () => {
 const {makeCodexProvider}=require('../sidecar/providers/codex.js');
 let wire;
 const ctx={AbortController,setTimeout,clearTimeout,normalizeProvider:x=>x,resolveReasoningEffort:(p,v)=>v||'low',providerUsesCodex:()=>true,extraAccountProviderFor:()=>null,ensureCodexAccessToken:async()=> 'fixture',forceRefreshCodexAccessToken:async()=> 'fixture',redact:x=>x,globalThis:{fetch:async (url,opts)=>{wire=JSON.parse(opts.body); return wire.reasoning.effort==='none' ? new Response(JSON.stringify({error:{message:"Unsupported value: 'none'"}}),{status:400}) : new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:1,output_tokens:1}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});}},selectProvider:opts=>makeCodexProvider(opts)};
 vm.createContext(ctx);vm.runInContext(extract(backend,'async function probeChannelRunConfig(', '/* A cron/Run-Now HOP'),ctx);
 const result=await ctx.probeChannelRunConfig({ok:true,provider:'codex',model:'gpt-6-astra',reasoningEffort:'medium'});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(wire.reasoning.effort,'medium');
});

test('follow-up keeps the selected run through another run and save hydration', () => {
 const Dossier=require('../frontend/app/dossier.js');const dossier=Dossier.fresh();let choose;
 const ctx={log:{},VerdictFollowup:require('../frontend/app/verdictfollowup.js'),followedUp:new Set(),taskQuestionLive:()=>false,clearNudge:()=>{},row:()=>({d:{classList:{add(){}}},body:{}}),autoscroll:()=>{},choices:(chips,cb)=>{choose=cb;return {};},runMeta:id=>({directive:id==='write-run'?'Create exactly one file':'Read the first heading'}),activeNudge:null,postCorrection:()=>{},briefingReceipt:()=>{},vanish:()=>{},beatCards:{claim:()=>({isCurrent:()=>true,decide(){},finish(){}})},DossierStore:{upsert:(dim,b)=>Dossier.upsert(dossier,dim,b,100)},Date};
 vm.createContext(ctx);vm.runInContext(extract(chat,'function verdictFollowupBeat(', '  function curiosityNudge('),ctx);
 assert.equal(ctx.verdictFollowupBeat('agent','write-run','miss'),true);
 // A later run changes what is active; the feedback must retain its original evidence.
 ctx.runMeta=()=>({directive:'Read the first heading'});choose({value:'offgoal',label:'not what I asked for'});
 const saved=Dossier.hydrate(JSON.parse(JSON.stringify(dossier)));const b=Dossier.beliefs(saved,'goals')[0];
 assert.equal(b.sourceRunId,'write-run');assert.match(b.text,/Create exactly one file/);assert.doesNotMatch(b.text,/Read the first heading/);
});

test('a delayed rating for the preceding run cannot appear below newer work in the same session',()=>{
 const ctx={log:{querySelector:()=>null},workRatedRuns:new Set(),runMeta:()=>({streamId:'session'}),Workstreams:{get:()=>({runIds:['read-run','write-run']})},activeWs:{id:'session',agentId:'agent'},runWork:new Map([['read-run',{toolsOk:1}],['write-run',{toolsOk:1}]]),isBusy:()=>false,interview:null,beatCards:null,activeTurnin:null};
 vm.createContext(ctx);vm.runInContext(extract(chat,'function ratingRunSuperseded(', '  const armedRateRuns'),ctx);
 assert.equal(ctx.rateStatus('agent','read-run'),'never');assert.equal(ctx.rateStatus('agent','write-run'),'ready');
 ctx.Workstreams.get=()=>({runIds:['read-run']});assert.equal(ctx.rateStatus('agent','read-run'),'ready','another session does not supersede this run');
});

test('delayed memory decks do not reintroduce a superseded rating',()=>{assert.match(extract(chat,'function renderTurninBatch(', '    const state ='),/!ratingRunSuperseded\(batch.runId\)/);});

test('QA 10-02: a skill review (also fired by a rating) checks the spending cap before it spends', async () => {
 const src = extract(backend, 'async function runBackgroundSkillReview(o)', 'async function runSkillCurator');
 const gate = src.indexOf("budget.check(null, String(agentId || 'agent'), 0, Date.now(), null)");
 assert.ok(gate > 0, 'the review asks the budget first');
 assert.ok(gate < src.indexOf('new AbortController()'), 'before any provider work starts');
 assert.ok(/if \(!unmetered\) \{/.test(src.slice(0, gate)), 'an unmetered provider is not gated by a cap it never spends against');
 // Execute the actual host function up to the first provider setup boundary.
 // The sentinel keeps this focused test independent of downstream skill tools.
 const reachedSetup = new Error('provider setup reached'), checks = [];
 let blocked = { scope: 'day' }, providerSetup = 0;
 const ctx = {
  LearningEvidence: { buildLearningEvidence: () => ({ eligible: true }) }, redact: x => x,
  Date: { now: () => 123 }, console: { log() {} },
  budget: { check: (...args) => { checks.push(args); return blocked; } },
  AbortController: class { constructor() { providerSetup++; throw reachedSetup; } }
 };
 vm.createContext(ctx); vm.runInContext(src, ctx);
 const packet = { agentId: 'nova', runId: 'rated-run', messages: [] };
 assert.equal(await ctx.runBackgroundSkillReview(packet), false, 'a reached cap defers the review');
 assert.deepEqual(checks, [[null, 'nova', 0, 123, null]]);
 assert.equal(providerSetup, 0, 'cap refusal stops before any provider setup');
 blocked = { unknown: true, code: 'spend_history_unavailable' };
 assert.equal(await ctx.runBackgroundSkillReview(packet), false, 'unknown spend also defers the review');
 assert.equal(providerSetup, 0);
 const checksBeforeUnmetered = checks.length;
 await assert.rejects(ctx.runBackgroundSkillReview({ ...packet, unmetered: true }), error => error === reachedSetup);
 assert.equal(checks.length, checksBeforeUnmetered, 'unmetered review bypasses the metered budget check');
 assert.equal(providerSetup, 1, 'unmetered review actually passes the budget guard');

 // Returning null would complete this job. The real queue must retain false
 // as pending and schedule another guarded attempt without doing paid work.
 providerSetup = 0; blocked = { scope: 'day' };
 const timers = [], launches = [];
 const queue = require('../sidecar/verdictreview.js').makeVerdictReview({
  now: () => 123, graceMs: 0, retryMs: 100,
  setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
  clearTimeout: () => {}, onChange: () => true
 });
 queue.stash(packet.runId, packet);
 assert.equal(queue.arm(packet.runId, 'miss', job => {
  const result = ctx.runBackgroundSkillReview(job); launches.push(result); return result;
 }), true);
 await launches[0];
 assert.equal(queue.holding(packet.runId), true);
 assert.equal(queue.snapshot()[0].reviewStatus, 'pending', 'budget refusal cannot consume the review');
 assert.equal(queue.snapshot()[0].attempts, 1);
 assert.equal(timers.length, 1); assert.equal(timers[0].ms, 100);
 timers.shift().fn(); await launches[1];
 assert.equal(launches.length, 2, 'the retained review retries through the same spending guard');
 assert.equal(queue.snapshot()[0].reviewStatus, 'pending');
 assert.equal(queue.snapshot()[0].attempts, 2);
 assert.equal(providerSetup, 0, 'neither blocked attempt reaches provider setup');
});
