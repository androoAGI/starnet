'use strict';
const fs = require('node:fs'), vm = require('node:vm');
const test = require('node:test'), assert = require('node:assert/strict');
const chat = fs.readFileSync('frontend/app/chat.js', 'utf8');
const delegated = fs.readFileSync('frontend/app/delegated.js', 'utf8');
function part(src, start, end) { const i=src.indexOf(start), j=src.indexOf(end,i+start.length); assert.ok(i>=0&&j>i,start); return src.slice(i,j); }
function ctx(code, extra={}) { const c=vm.createContext(extra); vm.runInContext(code,c); return c; }

test('explicit worker reveal wins a queued layout pin; ordinary loads still follow the latest message', () => {
  const frames=[], target={ scrollIntoView(){ log.scrollTop=120; } }, log={scrollTop:0,scrollHeight:2000,contains:el=>el===target,querySelectorAll:()=>[]};
  const c=ctx(part(chat,'  function cancelHistoryPin()', '  function positionNewPill('), {log,historyPinPending:1,stick:true,userScrollAt:0,requestAnimationFrame:fn=>frames.push(fn),nearBottom:()=>log.scrollTop===log.scrollHeight,hideNewPill(){},showNewPill(){}});
  c.pinLoadedHistoryAfterLayout(1); assert.equal(c.revealHistory(target),true);
  while(frames.length) frames.shift()();
  assert.equal(log.scrollTop,120); assert.equal(c.stick,false); assert.equal(c.historyPinPending,0);
  c.historyPinPending=2; c.pinLoadedHistoryAfterLayout(2);
  assert.equal(c.revealHistory({}),false); while(frames.length)frames.shift()();
  assert.equal(log.scrollTop,2000); assert.equal(c.stick,true);
});

test('worker prose uses the worker and project for both links and images; cache scopes do not collide',async()=>{
  const wired=[], images=[], keys=[];
  const c=ctx(part(chat,'  function workspaceFileRefs(', '  function hydrateFileRefs(')+part(chat,'  function fileUrl(', '  // append a small'),{
    fileRefScope:0,attachAgentId:()=> 'lead',wireFileOpen:(...args)=>wired.push(args),
    cachedBlob:(key,make)=>{keys.push(key);return make();},imageBlobUrl:(url)=>{images.push(url);return Promise.resolve(url);},
    ApiTicket:{fileUrl:(a,p)=>'/api/file?agent='+encodeURIComponent(a)+'&path='+encodeURIComponent(p)+'&ticket=test'}
  });
  const a={};const refs=c.workspaceFileRefs('vex','run-1','C:/project/');refs.wire(a,'report.html');await refs.image('chart.png');
  assert.deepEqual(wired[0],[a,'report.html','vex','C:/project/']);
  const url=new URL(images[0],'http://local'); assert.equal(url.searchParams.get('agent'),'vex');assert.equal(url.searchParams.get('project'),'C:/project');
  await c.workspaceFileRefs('vex','run-1','C:/elsewhere').image('chart.png'); assert.notEqual(keys[0],keys[1]);
  assert.ok(!c.fileUrl('D:/original/chart.png','vex','C:/project').includes('&project='),'absolute file keeps its original location');
});

test('approval failure leaves pending state intact; a confirmed answer settles only that prompt',async()=>{
  const effects=[], p={promptId:'mira-ask',runId:'lead-run',tool:'shell.exec'}, ws={id:'home',agentId:'lead'};
  let reply={ok:false,error:'temporarily unavailable'};
  const c=ctx(part(chat,'  const settledPromptNotices', '  // the channel\'s record'),{
    Harness:{consent:async()=>reply},StationUI:{settleNotifs:id=>effects.push(['notice',id])},
    Channels:{clearPending:(id,at,pid)=>effects.push(['clear',id,pid])},U:{bus:{emit:(name,data)=>effects.push(['event',name,data.promptId])}},
    isActiveWs:()=>false,renderPresence(){},syncStatus(){}
  });
  await assert.rejects(c.answerConsent(p,ws,'once'),/temporarily unavailable/);assert.equal(effects.length,0);
  reply={ok:true,decision:'once'};const res=await c.answerConsent(p,ws,'once');
  assert.equal(res.appliedDecision,'once');assert.deepEqual(effects.find(x=>x[0]==='clear'),['clear','home','mira-ask']);
});

test('delegated and ordinary inspectors render full payload as text, including build steps',()=>{
  const el=tag=>({tag,children:[],appendChild(n){this.children.push(n);},textContent:''});
  const raw='<script>unsafe()</script>'+ ' x'.repeat(200);
  const c=ctx(part(chat,'  function appendConsentDetails(', '  function actionPhrase('),{
    document:{createElement:el},consentInspect:()=>({label:'Inspect complete request',text:raw}),
    copyText:async()=>true,setTimeout,clearTimeout
  });
  const host=el('div');c.appendConsentDetails(host,{tool:'shell.exec'});
  assert.equal(host.children[0].children[1].textContent,raw);assert.equal(host.children[0].children[1].innerHTML,undefined);
  const build=el('div');c.appendConsentDetails(build,{tool:'station.build',argsSummary:'Plan\nFull first step\nFull second step'});
  assert.equal(build.children[1].children[1].textContent,'Full first step\nFull second step');
});

test('worker receipt failures are visible and retryable, and concurrent opens share one read',async()=>{
  let fail=true, reads=0;
  const c=ctx(part(delegated,'  async function loadReceipt(', '  function workHtml('),{
    findRow:()=>({ws:{agentId:'vex',parentStreamId:'home'},lead:'lead'}),workerRunOf:()=> 'run-1',
    loadingReceipts:new Set(),receipts:new Map(),repaint(){},stateOf:()=>({cls:'done'}),foldReceipt:(row)=>({answer:row.deliveryText}),
    fetch:async(url)=>{reads++;return {ok:!fail,status:503,json:async()=>url.startsWith('/api/runs')?{runs:[{runId:'run-1',deliveryText:'saved'}]}:{turns:[]}};}
  });
  await Promise.all([c.loadReceipt('worker'),c.loadReceipt('worker')]);assert.equal(reads,2);assert.equal(c.receipts.get('worker').status,'err');assert.match(c.receipts.get('worker').error,/503/);
  fail=false;await c.loadReceipt('worker');assert.equal(c.receipts.get('worker').status,'ok');assert.equal(c.receipts.get('worker').data.answer,'saved');
});

test('receipt prose refreshes on changed content without reparsing unchanged content',()=>{
  const renders=[],el={dataset:{dgAnswer:'worker'}};const rec={runId:'r',data:{answer:'first'}};
  const c=ctx(part(delegated,'  function hydrate(card)', '  function hydrateInspectors('),{
    receipts:new Map([['worker',rec]]),Workstreams:{get:()=>({agentId:'vex',projectRoot:'C:/project'})},
    Chat:{workspaceFileRefs:(...a)=>a,renderProse:(node,text,opts)=>{renders.push({text,files:opts.files});node.__proseSource=text;}}
  });
  const card={querySelectorAll:()=>[el]};c.hydrate(card);c.hydrate(card);assert.equal(renders.length,1);
  assert.deepEqual(renders[0].files,['vex','delegated:worker:r:vex:C:/project','C:/project']);
  rec.data.answer='second';c.hydrate(card);assert.equal(renders.length,2);assert.equal(renders[1].text,'second');
  rec.data.agentId='mira';rec.data.projectRoot='C:/original';c.hydrate(card);assert.equal(renders.length,3);assert.equal(renders[2].files[0],'mira');assert.equal(renders[2].files[2],'C:/original');
  rec.data.projectRoot='';c.hydrate(card);assert.equal(renders[3].files[2],'','finished run without a project never borrows a newer project');
});

test('answering one worker keeps the remaining worker in the bell; duplicate responses do not repeat notices',()=>{
  const effects=[], pending=[{promptId:'mira',workerAgentId:'mira',tool:'brief.ask'},{promptId:'rook',workerAgentId:'rook',tool:'fs.write'}];
  const c=ctx(part(chat,'  const settledPromptNotices', '  async function answerConsent('),{Channels:{pendingAllOf:()=>pending},StationUI:{notify:(text,cls,category,opts)=>effects.push(['pending',opts.prompt]),settleNotifs:key=>effects.push(['done',key])},askerName:p=>p.workerAgentId,actionPhrase:()=> 'write a file'});
  c.settlePromptNotice('home','mira');assert.deepEqual(effects,[['pending','rook']]);
  c.settlePromptNotice('home','mira');assert.equal(effects.length,1);
  pending.shift();c.settlePromptNotice('home','rook');assert.deepEqual(effects[1],['done','needs:home']);
});

test('delegated response repaint waits for the prompt-state listeners',async()=>{
  const listeners=new Map(),observed=[];let pending=true;
  ctx(delegated,{document:{addEventListener:(event,fn)=>{if(event==='DOMContentLoaded')fn();},getElementById:()=>{observed.push(pending);return null;}},U:{bus:{on:(event,fn)=>listeners.set(event,fn)}},setInterval,clearInterval});
  observed.length=0;listeners.get('permission.response')({promptId:'p'});pending=false;
  assert.deepEqual(observed,[]);await Promise.resolve();assert.deepEqual(observed,[false]);
});


// Minimal layout-backed DOM double: exercise actual insertion/separator/pruning logic without replacing old nodes.
function deliveryDom(pinned=false, count=4, scale=1, nativeAnchor=false) {
  let log;
  class Node {
    constructor(){this.children=[];this.dataset={};this.className='';this.textContent='';this.parentNode=null;this.classList={contains:x=>this.className.split(' ').includes(x),remove:x=>{this.className=this.className.split(' ').filter(c=>c!==x).join(' ');}};}
    appendChild(n){return this.insertBefore(n,null);}
    insertBefore(n,b){if(b&&!this.children.includes(b))throw Error('detached insertion target');if(n.parentNode)n.remove();const i=b?this.children.indexOf(b):this.children.length;this.children.splice(i,0,n);n.parentNode=this;return n;}
    remove(){if(this.parentNode){const a=this.parentNode.children;a.splice(a.indexOf(this),1);this.parentNode=null;}}
    get previousElementSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)-1]||null;}
    get firstElementChild(){return this.children[0]||null;}
    setAttribute(){}
    contains(n){return this.children.includes(n);}
    querySelector(s){return s==='.tb-when'?this.children.find(n=>n.className==='tb-when'):null;}
    getBoundingClientRect(){const top=this===log?0:(log.children.indexOf(this)*20-log.scrollTop)*scale;return {top,bottom:top+20*scale,height:100*scale};}
  }
  log=new Node();log.scrollTop=40;log.offsetHeight=100;
  const first=Date.UTC(2026,9,12,12);
  for(let i=0;i<count;i++){const n=new Node();n.dataset.ts=String(first+i*1000);n.textContent='original '+i;log.appendChild(n);}
  const ws={id:'read'}, original=log.children.slice();
  const code=part(chat,'  function syncTimeBreaks()', '  // stamp: omitted')+part(chat,'  function pruneLog()', '  function row(')+part(chat,'  function deliverTurns(', '  // SWITCH-SURVIVAL:');
  const c=ctx(code,{log,stick:pinned,insertingDelivery:false,LOG_DOM_CAP:400,TIME_BREAK_MS:1800000,document:{createElement:()=>new Node()},fmtBreak:at=>at.toISOString(),isActiveWs:w=>w===ws,cancelHistoryPin(){},autoscroll(){},noteDeliveryLanding(){},Set,Array,Number,Date});
  c.renderHistory=turns=>{for(const m of turns){const n=new Node();n.dataset.ts=String(m.ts);n.textContent=m.content;log.appendChild(n);if(nativeAnchor)log.scrollTop+=20;c.pruneLog();}};
  c.syncTimeBreaks();return {c,log,ws,original,first};
}

test('recovered history preserves existing nodes and reading anchor while correcting date ownership',()=>{
  const {c,log,ws,original,first}=deliveryDom();
  const anchor=log.children.find(n=>n.getBoundingClientRect().bottom>0), before=anchor.getBoundingClientRect().top;
  assert.equal(c.deliverTurns(ws,[{role:'assistant',content:'Yesterday answer',ts:first-86400000}]),true);
  assert.ok(original.every(n=>log.contains(n)),'reader selection and controls retain their original nodes');
  assert.equal(anchor.getBoundingClientRect().top,before,'earlier insertion keeps the same row at the same screen position');
  const breaks=log.children.filter(n=>n.className==='cmsg-timebreak');
  assert.deepEqual(breaks.map(n=>n.children[0].textContent),[new Date(first-86400000).toISOString(),new Date(first).toISOString()]);
  assert.equal(log.children[log.children.indexOf(breaks[1])+1],original[0],'Today separator still belongs to Today');
  const snapshot=log.children.slice();assert.equal(c.deliverTurns({id:'other'},[{ts:first,content:'unrelated'}]),false);assert.deepEqual(log.children,snapshot);
});

test('history insertion suspends pruning until the recovered message reaches its chronological position',()=>{
  const {c,log,ws,first}=deliveryDom(true,400);
  assert.doesNotThrow(()=>c.deliverTurns(ws,[{role:'assistant',content:'Recovered',ts:first+500}]));
  const stamps=log.children.filter(n=>n.dataset.ts).map(n=>Number(n.dataset.ts));
  assert.deepEqual(stamps,stamps.slice().sort((a,b)=>a-b),'pruning cannot strand older recovery at the tail');
  assert.ok(log.children.length<=400,'normal DOM cap still applies after insertion');
  assert.equal(c.insertingDelivery,false);
});

test('reader anchoring composes with browser anchoring and scaled UI coordinates',()=>{
  const {c,log,ws,original,first}=deliveryDom(false,4,1.15,true);
  const anchor=original[2], before=anchor.getBoundingClientRect().top;
  c.deliverTurns(ws,[{role:'assistant',content:'Earlier scaled insertion',ts:first-86400000}]);
  assert.ok(Math.abs(anchor.getBoundingClientRect().top-before)<0.001);
});

test('a finished worker with a failed finalization write shows retry instead of working forever',async()=>{
  const c=ctx(part(delegated,'  async function loadReceipt(', '  function workHtml('),{
    findRow:()=>({ws:{agentId:'mira',parentStreamId:'home'},lead:'lead'}),workerRunOf:()=> 'run-pending',
    loadingReceipts:new Set(),receipts:new Map(),repaint(){},stateOf:()=>({cls:'done'}),foldReceipt:()=>({live:true}),
    fetch:async(url)=>({ok:true,json:async()=>url.startsWith('/api/runs')?{runs:[{runId:'run-pending',dispatchDelivery:{state:'pending'}}]}:{turns:[]}})
  });
  await c.loadReceipt('worker');assert.equal(c.receipts.get('worker').status,'err');
  assert.match(c.receipts.get('worker').error,/ended.*finalized result.*Try again/);
});

test('reader anchor survives reassignment of a time separator',()=>{
  const {c,log,ws,original,first}=deliveryDom();
  original[1].dataset.ts=String(first+3600000);original[2].dataset.ts=String(first+3660000);original[3].dataset.ts=String(first+3720000);
  c.syncTimeBreaks();const divider=original[1].previousElementSibling;log.scrollTop=log.children.indexOf(divider)*20;
  const before=original[1].getBoundingClientRect().top;
  c.deliverTurns(ws,[{role:'assistant',content:'Recovered within the gap',ts:first+2700000}]);
  assert.equal(divider.children[0].textContent,new Date(first+2700000).toISOString(),'the separator now belongs to the recovered earlier message');
  assert.equal(original[1].getBoundingClientRect().top,before,'the persistent message remains anchored');
});


test('delegated receipts reject a truncated or changed final projection and retry the full Unicode result',async()=>{
  const Workstreams=require('../frontend/app/workstreams.js'), {createHash}=require('node:crypto');
  const full=JSON.stringify({answer:'\u{1f680}redacted '.repeat(24000)+'COMPLETE_TAIL'});
  const hash=createHash('sha256').update(full).digest('hex');
  const row={runId:'receipt-integrity',streamId:'worker',dispatchDelivery:{state:'final',text:full.slice(0,24000),textLength:full.length,textSha256:hash,reason:'done'}};
  const good={role:'assistant',dispatchState:'final',streamId:'worker',sourceRunId:row.runId,content:full,textLength:full.length,textSha256:hash};
  let projection={...good,content:full.slice(0,200000)};
  const c=ctx(part(delegated,'  async function loadReceipt(', '  function workHtml('),{
    Workstreams,findRow:()=>({ws:{agentId:'mira',parentStreamId:'home'},lead:'lead'}),workerRunOf:()=>row.runId,
    loadingReceipts:new Set(),receipts:new Map(),repaint(){},stateOf:()=>({cls:'done'}),foldReceipt:(r,t,text)=>({answer:text}),
    fetch:async(url)=>({ok:true,json:async()=>url.startsWith('/api/runs')?{runs:[row]}:{turns:url.includes('delivery=1')?[projection]:[{role:'assistant',content:'rejected original'}]}})
  });
  await c.loadReceipt('worker');assert.equal(c.receipts.get('worker').status,'err');
  assert.match(c.receipts.get('worker').error,/complete finalized result is unavailable/);
  projection={...good,content:full.slice(0,-3)+'X"}'};
  await c.loadReceipt('worker');assert.equal(c.receipts.get('worker').status,'err');
  projection=good;await c.loadReceipt('worker');assert.equal(c.receipts.get('worker').status,'ok');
  assert.equal(c.receipts.get('worker').data.answer,full);assert.equal(JSON.parse(full).answer.endsWith('COMPLETE_TAIL'),true);
});


test('complete output verification also works without WebCrypto',async()=>{
  const ApiTicket=require('../frontend/app/apiticket.js'), {createHash}=require('node:crypto');
  const full=JSON.stringify({answer:'\u{1f680}redacted '.repeat(24000)+'COMPLETE_TAIL'});
  const hash=createHash('sha256').update(full).digest('hex');
  const row={runId:'fallback-run',streamId:'fallback-worker',dispatchDelivery:{state:'final',text:full.slice(0,23999),textLength:full.length,textSha256:hash}};
  const projection={role:'assistant',dispatchState:'final',streamId:row.streamId,sourceRunId:row.runId,content:full,textLength:full.length,textSha256:hash};
  const source=fs.readFileSync('frontend/app/workstreams.js','utf8');
  const c=ctx(part(source,'  async function finalDeliveryText(', '  return {\n    init, reset'),{crypto:{},ApiTicket});
  assert.equal(await c.finalDeliveryText(row,[projection]),full);
  c.crypto.subtle={digest:async()=>{throw Error('native digest unavailable');}};
  assert.equal(await c.finalDeliveryText(row,[projection]),full);
  projection.content=full.slice(0,-3)+'X"}';assert.equal(await c.finalDeliveryText(row,[projection]),null);
});


test('spoken delegated approvals await confirmed exact-prompt settlement and preserve siblings on failure',async()=>{
  const voice=fs.readFileSync('frontend/app/voice-live.js','utf8');
  const Channels=require('../frontend/app/channels.js');Channels.reset();
  const ws={id:'voice-parent',agentId:'lead'},first={promptId:'voice-mira',tool:'fs.write'},second={promptId:'voice-rook',tool:'shell.exec'};
  Channels.setPending(ws.id,first);Channels.setPending(ws.id,second);
  let reply={ok:false,error:'offline'},calls=0;const spoken=[],events=[];
  const settlement=ctx(part(chat,'  const settledPromptNotices','  // the channel\'s record'),{Channels,
    Harness:{consent:async()=>{calls++;return reply;}},StationUI:{notify(){},settleNotifs(){}},askerName:()=> 'worker',actionPhrase:()=> 'write',
    U:{bus:{emit:(name,p)=>events.push([name,p.promptId])}},isActiveWs:()=>false,syncStatus(){}});
  const c=ctx(part(voice,'  const approvalSubmissions = new Set();', '  /* THE CALL IS BOUND'),{
    active:true,sessionSeq:1,boundWsId:ws.id,Channels,Workstreams:{active:()=>ws},Chat:{answerConsent:settlement.answerConsent},
    speakLocal:text=>spoken.push(text),refreshTask(){}});
  const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  assert.equal(c.approvalCommand('approve'),true);assert.equal(c.approvalCommand('approve'),true);await drain();
  assert.equal(calls,1);assert.deepEqual(Channels.pendingAllOf(ws.id).map(p=>p.promptId),['voice-mira','voice-rook']);
  assert.equal(events.length,0);assert.equal(spoken.some(t=>/^Approved/.test(t)),false);assert.match(spoken[0],/could not submit/);
  let confirm;reply=new Promise(resolve=>{confirm=resolve;});spoken.length=0;
  c.approvalCommand('always allow');await drain();assert.equal(spoken.length,0);assert.equal(Channels.pendingAllOf(ws.id).length,2);
  confirm({ok:true,decision:'always'});await drain();
  assert.deepEqual(Channels.pendingAllOf(ws.id).map(p=>p.promptId),['voice-mira']);assert.deepEqual(spoken,['Always allowed.']);
  assert.deepEqual(events,[['permission.response','voice-rook']]);
  reply={ok:true,decision:'deny'};c.approvalCommand('approve');await drain();
  assert.equal(Channels.pendingAllOf(ws.id).length,0);assert.equal(spoken.at(-1),'Denied.','say the decision the station applied');
  Channels.setPending(ws.id,{promptId:'question',tool:'brief.ask'});const before=calls;
  assert.equal(c.approvalCommand('approve'),false);assert.equal(calls,before,'a question is never answered as a tool approval');
  Channels.clearPending(ws.id,Date.now(),'question');Channels.setPending(ws.id,{promptId:'late',tool:'fs.write'});
  reply=new Promise(resolve=>{confirm=resolve;});spoken.length=0;c.approvalCommand('approve');await drain();c.sessionSeq++;
  confirm({ok:true,decision:'once'});await drain();assert.equal(spoken.length,0,'late confirmation never speaks into a later call');
  Channels.setPending(ws.id,{promptId:'rebound',tool:'fs.write'});reply=new Promise(resolve=>{confirm=resolve;});
  c.approvalCommand('approve');await drain();c.boundWsId='another-chat';
  confirm({ok:true,decision:'once'});await drain();assert.equal(spoken.length,0,'voice rebinding within one call suppresses the old conversation confirmation');
  c.boundWsId=ws.id;Channels.setPending(ws.id,{promptId:'remote-wins',tool:'fs.write'});let reject;
  reply=new Promise((_resolve,no)=>{reject=no;});c.approvalCommand('approve');await drain();
  Channels.clearPending(ws.id,Date.now(),'remote-wins');reject(new Error('local network failed'));await drain();
  assert.deepEqual(spoken,['That approval is no longer waiting.'],'a failed local request on a remotely handled prompt says so, never that it still waits (review app-shell-ui-08)');
});

test('COMMS prose resolves files where the speaking run wrote them (review comms-threads-ui-03)',()=>{
  const renders=[], ws={id:'s',agentId:'nova',projectRoot:'C:/proj',history:[
    {role:'assistant',content:'[open it](site/index.html)',ts:1,projectRoot:'C:/proj'},
    {role:'assistant',content:'![chart](out/chart.png)',agentId:'mira',ts:2},
    {role:'assistant',content:'[again](site/index.html)',agentId:'nova',ts:3,projectRoot:'C:/proj'}]};
  const row=()=>({d:{classList:{add(){}},appendChild(){}},body:{textContent:'x',addEventListener(){}}});
  const base={activeWs:ws,renderingHistory:false,row,renderProse:(el,text,opts)=>renders.push(opts&&opts.files),workspaceFileRefs:(...a)=>a,
    addUser(){},toolLine(){},trimMarkerLine(){},offerTryAgain(){},offerRetry(){},isBusy:()=>false,endToolRail(){},autoscroll(){},
    document:{hidden:true,createElement:()=>({remove(){}})}};
  const refs=part(chat,'  function turnFileRefs(', '  function hydrateFileRefs(');
  const c=ctx(refs+part(chat,'  function replayableDeliverables(', '  // A delivered/recovered answer'),base);
  c.renderHistory();
  assert.deepEqual(renders[0],['nova',null,'C:/proj'],'the session agent\'s reply resolves at the project root it wrote into');
  assert.deepEqual(renders[1],['mira',null,undefined],'a work-line stage resolves in its own agent\'s workspace (the hop runs without the project root)');
  assert.deepEqual(renders[2],['nova',null,'C:/proj'],'a reconciled turn stamped with the session agent is still the session\'s own reply');
  renders.length=0;
  const s=ctx(refs+part(chat,'  function streamingAgent(', '  // close the live paragraph (if any)'),base);
  const own=s.streamingAgent(); own.append('see [it](site/index.html)'); own.done();
  const hop=s.streamingAgent('MIRA','mira'); hop.append('see [it](out/chart.png)'); hop.done();
  assert.deepEqual(renders[0],['nova',null,'C:/proj'],'live reply links resolve at the project root');
  assert.deepEqual(renders[1],['mira',null,undefined],'a live work-line stage resolves in the stage agent\'s workspace');
});

test('a reply keeps the folder its own run used after the session joins a project (review follow-up, comms-threads-ui-03)',()=>{
  // turn 1 ran before a path.trust ALWAYS anchored the session (at t=50); its files are in the agent's own workspace
  const renders=[], ws={id:'s',agentId:'nova',projectRoot:'C:/proj',projectRootAt:50,history:[
    {role:'assistant',content:'[a](site/index.html)',ts:10,projectRoot:null},
    {role:'assistant',content:'[b](site/index.html)',ts:20},
    {role:'assistant',content:'[c](site/index.html)',ts:60},
    {role:'assistant',content:'[d](site/index.html)',ts:70,projectRoot:'C:/proj'},
    {role:'assistant',content:'[e](out/x.png)',ts:80,agentId:'nova',projectRoot:null},
    {role:'assistant',content:'[f](out/x.png)',ts:90,agentId:'mira',projectRoot:null}]};
  const row=()=>({d:{classList:{add(){}},appendChild(){}},body:{textContent:'x',addEventListener(){}}});
  const base={activeWs:ws,renderingHistory:false,row,renderProse:(el,text,opts)=>renders.push(opts&&opts.files),workspaceFileRefs:(...a)=>a,
    addUser(){},toolLine(){},trimMarkerLine(){},offerTryAgain(){},offerRetry(){},isBusy:()=>false,endToolRail(){},autoscroll(){},
    document:{hidden:true,createElement:()=>({remove(){}})}};
  const refs=part(chat,'  function turnFileRefs(', '  function hydrateFileRefs(');
  const c=ctx(refs+part(chat,'  function replayableDeliverables(', '  // A delivered/recovered answer'),base);
  c.renderHistory();
  assert.deepEqual(renders.map(r=>r[2]),[undefined,undefined,'C:/proj','C:/proj',undefined,undefined],
    'stamped turns keep their own run\'s folder; an unstamped one uses the project only when it is newer than the anchor; a hop never does');
  assert.deepEqual(renders[4],['nova',null,undefined],'a work-line stage run by the session\'s own agent still resolves in its workspace');
  renders.length=0; delete ws.projectRootAt; c.renderHistory();
  assert.deepEqual(renders[1],['nova',null,undefined],'with no record of when the session joined, an older unstamped reply resolves where it always did');
  renders.length=0;
  const s=ctx(refs+part(chat,'  function streamingAgent(', '  // close the live paragraph (if any)'),base);
  for (const o of [s.streamingAgent(undefined,undefined,null),s.streamingAgent('NOVA','nova',null),s.streamingAgent()]) { o.append('see [it](site/index.html)'); o.done(); }
  assert.deepEqual(renders.map(r=>r[2]),[undefined,undefined,'C:/proj'],'a live reply resolves at the folder its run was sent with (none for a hop)');
  // every reply the send path persists records the folder that run was sent with; a hop records none
  const p=ctx(part(chat,'  function persistPartial(', '  function isBusy(')+part(chat,'  function markStoppedTurn(', '  // WHY it stopped'),{capHistory(){},liveRunRoots:new Map([['a',null],['b','C:/proj']])});
  const w={id:'a',history:[]}; p.persistPartial(w,'partial'); w.id='b'; p.markStoppedTurn(w,'');
  assert.deepEqual(w.history.map(m=>m.projectRoot),[null,'C:/proj'],'a partial or stopped turn carries its in-flight run\'s folder');
  const send=part(chat,'  async function send(text, opts) {', '  async function maybeRetitle(');
  assert.match(send,/projectRoot: runRoot \|\| undefined,/,'the run body sends the same folder the turns record');
  assert.equal((send.match(/error: true, ts: Date\.now\(\), projectRoot: runRoot \}/g)||[]).length,2,'both failure lines record the folder');
  assert.match(send,/content: replyText, ts: Date\.now\(\), sourceRunId: thisRunId \|\| undefined, projectRoot: runRoot \}/,'the reply records the folder');
  assert.match(send,/const runRoot = ws\.projectRoot \|\| null;\s+liveRunRoots\.set\(ws\.id, runRoot\);/,'the in-flight run\'s folder is what a partial or stopped turn records');
  assert.match(part(chat,'  async function runWorkLine(', '  async function send(text, opts) {'),/content: hopText, agentId: nx, projectRoot: null, ts:/,'a work-line stage records that it ran without the project folder');
});

test('an explicit reveal survives the load\'s server-history repaint; a reader gesture forgets it (review comms-threads-ui-04)',async()=>{
  const frames=[];let current=null;
  const makeRow=()=>({hasAttribute:a=>a==='data-dg-row',getAttribute:a=>a==='data-dg-row'?'mira-ws':null,scrollIntoView(){log.scrollTop=700;}});
  const log={scrollTop:0,scrollHeight:2000,clientHeight:400,contains:el=>!!el&&el===current,
    querySelector:sel=>current&&sel==='[data-dg-row="mira-ws"]'?current:null,set innerHTML(v){current=null;this.scrollTop=0;}};
  const ws={id:'home',agentId:'lead',history:[]};
  const boot=()=>{
    const read={history:[],repaint:false};
    const c=ctx(part(chat,'  function cancelHistoryPin()', '  function positionNewPill(')+part(chat,'  async function reconcileServerHistory(', '  // swap the rendered conversation'),{
      log,activeWs:ws,historyPinSeq:1,historyPinPending:1,stick:true,userScrollAt:0,revealKey:'',historyLoads:new Map([[ws,read]]),
      requestAnimationFrame:fn=>frames.push(fn),nearBottom:()=>log.scrollHeight-log.scrollTop-log.clientHeight<40,hideNewPill(){},showNewPill(){},
      Workstreams:{get:()=>ws},Channels:{isBusy:()=>false},noteContinuity(){},mergeCanonicalHistory:(a,t)=>t,placeSteerNotes:rows=>rows,App:{persist(){}},
      fetch:async()=>({ok:true,json:async()=>({turns:[{role:'assistant',content:'the lead followed up '+Math.random()}]})}),
      renderHistory(){},replayChannel(){},syncStatus(){},maybeEmptyState(){},Delegated:{presentFor:async()=>{current=makeRow();}},
      AbortController,setTimeout,clearTimeout,Date,JSON,String,Promise});
    return {c,read};
  };
  let {c,read}=boot();
  current=makeRow();log.scrollTop=1600;
  assert.equal(c.revealHistory(current),true);assert.equal(log.scrollTop,700);
  await c.reconcileServerHistory(ws,1,read);while(frames.length)frames.shift()();
  assert.equal(log.scrollTop,700,'the repaint finds the revealed worker row again instead of dropping the reader at the top');
  assert.equal(c.stick,false);
  ({c,read}=boot());current=makeRow();
  assert.equal(c.revealHistory(current),true);c.forgetReveal();
  await c.reconcileServerHistory(ws,1,read);while(frames.length)frames.shift()();
  assert.equal(log.scrollTop,0,'after the reader scrolls on their own, a repaint does not jump them back to the old reveal');
});

test('a keyboard scroll forgets an earlier reveal like a wheel or touch does (review follow-up, comms-threads-ui-04)',()=>{
  const wiring=chat.match(/\[([^\]]*)\]\.forEach\(type => log\.addEventListener\(type, forgetReveal\b/);
  assert.ok(wiring,'the reader gestures that forget a reveal are wired on the log');
  const gestures=wiring[1].match(/'[a-z]+'/g).map(s=>s.slice(1,-1));
  for (const g of ['wheel','touchstart','pointerdown','keydown']) assert.ok(gestures.includes(g),g+' forgets the reveal (PageUp/arrow reading is a real gesture)');
});

test('a card settled by another surface says what was APPLIED and where it came from (voice "always" is not "once from your phone")', () => {
  const c = ctx(part(chat, '  function settledWhere(resp)', '  async function answerConsent('));
  assert.equal(c.settledLabel({ decision: 'always', via: 'voice' }), '✓ always allowed by voice');
  assert.equal(c.settledLabel({ decision: 'once', via: 'needs-you' }), '✓ approved once from NEEDS YOU');
  assert.equal(c.settledLabel({ decision: 'deny', via: 'row' }), '✕ denied');
  assert.equal(c.settledLabel({ decision: 'session' }), '✓ approved for this session from your phone', 'no via = the sidecar\'s remote (phone) answer');
  assert.equal(c.settledLabel({ decision: 'once' }), '✓ approved once from your phone');
  assert.ok(/U\.bus\.emit\('permission\.response', \{ promptId: p\.promptId, decision: appliedDecision, via: via \|\| 'desk' \}\)/.test(chat), 'every local answer names its surface on the bus');
  assert.ok(/Chat\.answerConsent\(pending, ws, decision, 'voice'\)/.test(fs.readFileSync('frontend/app/voice-live.js', 'utf8')), 'voice answers say they were spoken');
});

test('answering one of two asks moves the bell to the other QUIETLY (no second toast, no chime); a quiet notify files the bell only', () => {
  const effects = [];
  const pending = [{ promptId: 'a', tool: 'fs.write', workerAgentId: 'MIRA' }, { promptId: 'b', tool: 'fs.write', workerAgentId: 'VEX' }];
  const c = ctx(part(chat, '  const settledPromptNotices', '  function settledWhere(resp)'), { Channels: { pendingAllOf: () => pending }, StationUI: { notify: (text, cls, category, opts) => effects.push(opts), settleNotifs() {} }, Workstreams: { get: id => ({ id }) }, askerName: p => p.workerAgentId, actionPhrase: () => 'write a file' });
  c.settlePromptNotice('ws1', 'a');
  assert.equal(effects.length, 1); assert.equal(effects[0].prompt, 'b'); assert.equal(effects[0].quiet, true, 'the remaining ask is re-filed without a toast');
  const ui = fs.readFileSync('frontend/app/stationui.js', 'utf8');
  const toasts = [], notifs = [];
  const s = ctx(part(ui, '  function notify(text, cls, category, opts) {', '  function goToNotif(go) {'), { notifyPrefOf: () => ({ show: true, sound: true }), NOTIF_KIND_OF: { needsApproval: 'needs' }, store: { notifs }, uid: () => 'n1', save() {}, badges() {}, open: {}, rerender() {}, toast: (...a) => toasts.push(a), openNotif() {}, NOTIF_LIFE: 1 });
  s.notify('VEX still needs approval', 'warn', 'needsApproval', { kind: 'needs', key: 'needs:ws1', prompt: 'b', quiet: true });
  assert.equal(s.store.notifs.length, 1, 'the bell entry is filed'); assert.equal(toasts.length, 0, 'no toast, no sound');
  s.notify('MIRA needs approval', 'warn', 'needsApproval', { kind: 'needs', key: 'needs:ws2', prompt: 'c' });
  assert.equal(toasts.length, 1, 'an ordinary notify still toasts');
});

test('a delegated worker\'s question toasts in the WORKER\'s name, like its card', () => {
  const body = part(chat, '  function clarifyRow(', '  // p = a consent payload');
  assert.ok(/const asker = \(p && p\.workerAgentId\) \? askerName\(p, ws\) : name;[^\n]*\n\s*if \(ws && !announcedPrompt\(p\.promptId, ws\)[^\n]*StationUI\.notify\(asker \+ ' has a quick question for you'/.test(body));
  assert.ok(!/StationUI\.notify\(name \+ ' has a quick question/.test(body), 'never the lead\'s name');
});

test('a worker question is ONE hop away: revealAsk lands on its question card, redrawing it from the open ask when it is not in the transcript', () => {
  const cards = [], revealed = [], drawn = [], focused = [];
  const mkCard = id => ({ dataset: { clarifyPrompt: id }, focus() { focused.push(id); } });
  cards.push(mkCard('q-other'));   // another question's card is already showing: it is never the one revealed
  const log = { querySelectorAll: () => cards };
  const pend = [{ promptId: 'q1', tool: 'brief.ask', workerAgentId: 'MIRA' }, { promptId: 'p2', tool: 'fs.write' }];
  const c = ctx(part(chat, '  function revealAsk(promptId) {', '  function pinLoadedHistoryAfterLayout('), {
    log, activeWs: { id: 'ws1' }, Channels: { pendingAllOf: () => pend }, noteAskLanding() {},
    permissionRow: (p) => { drawn.push(p.promptId); cards.push(mkCard(String(p.promptId))); }, revealHistory: el => revealed.push(el.dataset.clarifyPrompt) });
  assert.equal(c.revealAsk('q1'), true, 'a missing card is drawn again from the open ask'); assert.deepEqual(drawn, ['q1']); assert.deepEqual(revealed, ['q1']);
  assert.equal(c.revealAsk('q1'), true); assert.deepEqual(drawn, ['q1'], 'a card already showing is revealed, never drawn twice');
  assert.deepEqual(focused, ['q1', 'q1'], 'focus lands on that exact card'); assert.ok(!revealed.includes('q-other'), 'never on the card of another question');
  // (live walk 10-14) NEEDS YOU › Review on an APPROVAL lands on its approval card the same way, drawn from the open ask when missing
  assert.equal(c.revealAsk('p2'), true, 'an approval lands on its approval card'); assert.deepEqual(drawn, ['q1', 'p2']);
  assert.equal(c.revealAsk('gone'), false, 'an answered ask reveals nothing');
  assert.ok(/if \(typeof Chat !== 'undefined' && Chat\.revealAsk\) Chat\.revealAsk\(q\.dataset\.dgQuestion\);/.test(delegated), 'the row\'s Answer key uses it');
  assert.ok(/\(i\.kind === 'question' \|\| i\.kind === 'approval'\) && i\.p && typeof Chat !== 'undefined' && Chat\.revealAsk && Chat\.revealAsk\(i\.p\.promptId\)\) return(?: true)?;/.test(fs.readFileSync('frontend/app/needsyou.js', 'utf8')), 'NEEDS YOU Answer / Review lands on the card, not the row');
});
