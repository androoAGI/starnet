'use strict';
const { readSidecarSource } = require('./helpers/source');
const A=require('./_assert.js'),fs=require('node:fs'),vm=require('node:vm');
const read=p=>fs.readFileSync(require('node:path').join(__dirname,'..',p),'utf8');
const chat=read('frontend/app/chat.js'),gc=read('frontend/app/group-chat.js'),idx=readSidecarSource(),dlv=read('frontend/app/deliverables.js'),out=read('frontend/app/windows/outbox.js');
function fn(src,name){const m=new RegExp('^( {0,4})(?:async )?function '+name+'\\([^]*?\\n\\1\\}', 'm').exec(src);if(!m)throw Error('missing '+name);return m[0];}
(async()=>{
  let loads=0,version='v1';
  const refs=new Function('imageBlobUrl','wireFileOpen','fileUrl','attachAgentId',`const fileRefCache=new Map();let fileRefScope=0;${fn(chat,'cachedBlob')}${fn(chat,'workspaceFileRefs')}return workspaceFileRefs;`)(async p=>{loads++;if(p.endsWith('missing.png'))throw Error('missing');return version},()=>{},p=>p,()=> 'agent');
  const first=refs('agent');A.eq(await first.image('out/final.png'),'v1','first message reads first image');
  version='v2';A.eq(await first.image('out/final.png'),'v1','stream re-render keeps same message image');
  A.eq(await refs('agent').image('out/final.png'),'v2','new message revalidates overwritten path');
  A.eq(loads,2,'streaming does not refetch successful images');
  const missing=refs('agent');for(let i=0;i<5;i++)await missing.image('missing.png').catch(()=>{});A.eq(loads,3,'missing image fetched once per message');
  await refs('agent').image('missing.png').catch(()=>{});A.eq(loads,4,'new message can retry missing file');
  A.eq(await refs('agent','group:g:m1').image('out/final.png'),'v2','group first message reads image');version='v3';
  A.eq(await refs('agent','group:g:m1').image('out/final.png'),'v2','rebuilt group row shares message cache');A.eq(await refs('agent','group:g:m2').image('out/final.png'),'v3','later group message reads overwritten image');
  let sharedLoads=0;const groupRefs=new Function('Chat','sharedFor','openFile','showError',`const sharedBlobs=new Map();${fn(gc,'fileRefs')}return fileRefs;`)({workspaceFileRefs:refs,imageBlobUrl:async()=>{sharedLoads++;throw Error('missing shared')}},()=>({id:'immutable-v1',name:'gone.png'}),()=>{},()=>{});
  for(let i=0;i<5;i++)await groupRefs('g','agent','m').image('gone.png').catch(()=>{});A.eq(sharedLoads,1,'failed shared immutable version does not refetch every group repaint');
  const rows=[{id:'same',status:'pending'},{id:'kept',status:'kept'},{id:'open',status:'kept'}];
  const visible=new Function('deliverableRows','deliverableStore',fn(idx,'visibleDeliverableRows')+';return visibleDeliverableRows;')(async()=>rows,{clearedIds:()=>new Set(['same','kept'])});
  A.eq((await visible()).map(r=>r.id),['same','open'],'undo KEEP restores pending row even if library id was cleared');
  const ws={id:'build-run',history:[]};let request='';
  const note=new Function('Workstreams','sessionIdOf','historyTellsTheStory','fetch','App','Chat','RESOLUTION_LINE',fn(read('frontend/app/workshopstore.js'),'noteResolved')+';return noteResolved;')({get:()=>ws,activeId:()=>null},()=>ws.id,()=>false,async url=>{request=url;return {ok:true,json:async()=>({items:url.includes('includeCleared=1')?[{runId:'run',agentId:'agent',status:'kept'}]:[]})}},{persist:()=>{}},{},{kept:'KEPT: kept line',discarded:'DISCARDED: x',failed:'FAILED: x',gone:'GONE: x'});
  await note('agent','run');A.ok(request.includes('includeCleared=1'),'resolution lookup includes cleared cards');A.ok(ws.history[0].resolution==='kept'&&ws.history[0].content==='KEPT: kept line','cleared kept build gets correct durable note');
  const scroll=chat.match(/log\.addEventListener\('scroll', \(\) => \{([^]*?)\n      \}\);/)[1];
  function scrollState(held,now,near){return new Function('userScrollHeld','Date','nearBottom',`let historyPinPending=0,stick=true,userScrollAt=0;const log={scrollTop:20,scrollHeight:900};const hideNewPill=()=>{},showNewPill=()=>{};${scroll};return {stick,top:log.scrollTop};`)(held,{now:()=>now},()=>near)}
  A.eq(scrollState(true,9000,false),{stick:false,top:20},'holding scrollbar beyond gesture timeout keeps reader position');A.eq(scrollState(false,9000,false),{stick:true,top:900},'unprompted layout movement still follows bottom');
  const live=[{dataset:{runId:'already',collected:'1'}},{dataset:{runId:'left'}}];let resolved=[],notice='';
  const clear=out.match(/    const clearEvery = \(\) => \{([^]*?)\n    \};/)[1];new Function('list','RS','notify','renderEmpty',clear)({children:live},{resolveAll:ids=>{resolved=ids}},t=>{notice=t},()=>{});
  A.eq(resolved,['left'],'TO REVIEW clear acts only on still-live rows');A.ok(/Marked 1 reviewed/.test(notice),'clear toast counts only remaining reminder');
  {// leaving a group releases its inline shared images (review comms-threads-ui-12)
    const revoked=[],bad=Promise.reject(new Error('missing shared'));bad.catch(()=>{});
    const shared=new Map([['art-1',Promise.resolve('blob:one')],['art-2',bad]]);
    const els={},$=id=>els[id]||(els[id]={hidden:false,style:{},classList:{toggle(){}},replaceChildren(){},textContent:'',value:'',placeholder:''});
    const bind=new Function('$','sharedBlobs','URL','composerDrafts',`let root={},basePlaceholder=null,active={id:'g1'},pickerFor=null,openedFileUrl=null,openedFile=null,group=null,replyTo=null,selected=[],lastPaint='',generation=0,timer=0,draftKey=null,notice='';const init=()=>{},settleStaleJoins=()=>{},setGroupPlaceholder=()=>{},closeMentions=()=>{},recipientLabel=()=>{},poll=()=>{};${fn(gc,'bind')}return bind;`)($,shared,{revokeObjectURL:u=>revoked.push(u)},new Map());
    bind({id:'g1',conversationMode:'group'});await new Promise(r=>setImmediate(r));A.eq(revoked,[],'re-binding the same group keeps its images');
    bind({id:'g2',conversationMode:'group'});await new Promise(r=>setImmediate(r));
    A.eq(revoked,['blob:one'],'switching groups revokes the previous group image blob URLs');A.eq(shared.size,0,'and forgets them');
  }
  let q={value:'filtered'},status={value:''},runFilter=null,project='',kind='',total=12,clearable=12,libraryRows=[];
  const label=new Function('state','clearableRow',fn(dlv,'clearShownLabel').replace(/(?<![.\w])(runFilter|project|kind|total|clearable|rows|q|status)(?!\w)/g,x=>'state.'+({rows:'libraryRows'}[x]||x))+';return clearShownLabel;')({q,status,runFilter,project,kind,total,clearable,libraryRows},r=>r.status!=='pending');
  const armSrc=read('frontend/app/armconfirm.js');let timer=null;const sandbox={module:{exports:{}},setTimeout:f=>{timer=f;return 1},clearTimeout:()=>{},console};vm.runInNewContext(armSrc,sandbox);
  const btn={textContent:label(),dataset:{},classList:{add(){},remove(){}},addEventListener(t,f){this.click=f},removeEventListener(){},isConnected:true};
  sandbox.module.exports.wire(btn,{armedLabel:'SURE?',onDisarm:()=>{btn.textContent=label()},onConfirm:()=>{}});btn.click();q.value='';timer();A.eq(btn.textContent,'CLEAR ALL 12','disarm repaints current filter scope instead of stale wired label');
  A.ok(/onDisarm: \(\) => \{ shown.textContent = clearShownLabel\(\);/.test(dlv)&&/onDisarm: paintFold/.test(out),'both changing clear controls repaint their live label when disarmed');
  // ---- the DELIVERABLES window itself, mounted on a small DOM double (review comms-threads-ui-05, seams-07) ----
  {
    const D=require('../frontend/app/deliverables.js'),tick=()=>new Promise(r=>setImmediate(r)),settle=async()=>{for(let i=0;i<8;i++)await tick();};
    const mk=()=>({hidden:false,disabled:false,value:'',className:'',dataset:{},_h:{},_html:'',isConnected:true,
      addEventListener(t,f){(this._h[t]=this._h[t]||[]).push(f);},removeEventListener(){},classList:{add(){},remove(){},toggle(){}},focus(){},
      querySelector:()=>null,querySelectorAll:()=>[],get textContent(){return this._html;},set textContent(v){this._html=String(v);},
      get innerHTML(){return this._html;},set innerHTML(v){this._html=String(v);}});
    const wired=[];global.ArmConfirm={wire:(b,o)=>{b.__arm=o;wired.push(b);return()=>{};}};
    let library,calls=[];
    let undoGone=false;   // the server's 404 once the clear can no longer be undone (aged out, or another mount used it)
    global.fetch=async(url,opts)=>{calls.push(url);
      if(url==='/api/deliverables/clear-undo'&&undoGone)return {ok:false,status:404,json:async()=>({ok:false,error:'That clear can no longer be undone.'})};
      const j=url.startsWith('/api/deliverables?')?library:url==='/api/deliverables/clear'?{cleared:1,skipped:1,undoToken:'tok-1'}:url==='/api/deliverables/clear-undo'?{restored:1}:{};return {ok:true,status:200,json:async()=>j};};
    const mount=async()=>{const els={},body=mk();body.querySelector=sel=>els[sel]||(els[sel]=mk());D.mount(body);
      const list=body.querySelector('#dl-list');list.querySelectorAll=sel=>sel==='button.dlv-bclear'?[...list._html.matchAll(/data-bucket="([^"]+)"/g)].map(m=>{const b=mk();b.dataset.bucket=m[1];return b;}):[];
      await settle();return {body,q:sel=>body.querySelector(sel)};};
    const now=Date.now(),row=(id,status)=>({id,status,title:id,createdAt:now});
    library={items:[row('done','produced'),row('waiting','pending')],total:2,clearable:1,summary:{total:2,pending:1}};
    let w=await mount();
    A.eq(w.q('#dl-clear-shown').textContent,'CLEAR ALL 1','CLEAR ALL counts only what the server will clear (an undecided build stays)');
    library={items:[row('done','produced'),row('waiting','pending')],total:2,summary:{total:2,pending:1}};
    w=await mount();A.eq(w.q('#dl-clear-shown').textContent,'CLEAR ALL 1','a sidecar without the clearable count still counts the complete list it sent');
    library={items:[row('w1','pending'),row('w2','pending')],total:2,clearable:0,summary:{total:2,pending:2}};
    w=await mount();A.ok(w.q('#dl-clear-shown').hidden,'nothing clearable = no CLEAR ALL');A.ok(!/data-bucket=/.test(w.q('#dl-list').innerHTML),'a bucket of undecided builds offers no CLEAR');
    library={items:[row('done','produced'),row('waiting','pending')],total:2,clearable:1,summary:{total:2,pending:1}};
    w=await mount();const msg=w.q('#dl-msg'),shown=w.q('#dl-clear-shown');
    await shown.__arm.onConfirm();await settle();
    A.ok(/data-undo-clear="tok-1"/.test(msg.innerHTML),'a clear offers UNDO');
    const bucket=wired.filter(b=>b.dataset.bucket).pop();bucket.__arm.onArm();A.ok(!/data-undo-clear/.test(msg.innerHTML),'arming another CLEAR shows its warning');
    bucket.__arm.onDisarm();A.ok(/data-undo-clear="tok-1"/.test(msg.innerHTML),'disarming it brings the last clear\'s UNDO back instead of a blank line');
    shown.__arm.onArm();shown.__arm.onDisarm();A.ok(/data-undo-clear="tok-1"/.test(msg.innerHTML),'CLEAR ALL disarm keeps the UNDO too');
    w.q('#dl-refresh')._h.click[0]();await settle();A.ok(/data-undo-clear="tok-1"/.test(msg.innerHTML),'a reload keeps the UNDO in the line');
    await msg._h.click[0]({target:{closest:()=>({disabled:false,dataset:{undoClear:'tok-1'}})}});await settle();
    A.ok(/Brought back 1 deliverable/.test(msg.innerHTML),'undo reports what came back');
    shown.__arm.onArm();shown.__arm.onDisarm();A.eq(msg.innerHTML,'','a spent UNDO is never offered again');
    // review follow-up: an UNDO the server no longer honours is dropped, never redrawn on every disarm or reload
    await shown.__arm.onConfirm();await settle();A.ok(/data-undo-clear="tok-1"/.test(msg.innerHTML),'a second clear offers UNDO');
    undoGone=true;await msg._h.click[0]({target:{closest:()=>({disabled:false,dataset:{undoClear:'tok-1'}})}});await settle();
    A.ok(/can no longer be undone/.test(msg.innerHTML),'a dead UNDO says why it failed');
    shown.__arm.onArm();shown.__arm.onDisarm();A.eq(msg.innerHTML,'','a dead UNDO is not offered again after a disarm');
    w.q('#dl-refresh')._h.click[0]();await settle();A.ok(!/data-undo-clear/.test(msg.innerHTML),'…or after a reload');
    // review follow-up (seams-07): over 500 matches the list is cut short; the count is one the page can prove, or none
    const many=[...Array(500)].map((_,i)=>row('r'+i,i<400?'produced':'pending'));
    library={items:many,total:612,summary:{total:612,pending:150}};
    w=await mount();A.eq(w.q('#dl-clear-shown').textContent,'CLEAR ALL 462','the whole library: its summary proves what a clear takes (612 - 150 undecided)');
    w.q('#dl-query').value='report';w.q('#dl-refresh')._h.click[0]();await settle();
    A.eq(w.q('#dl-clear-shown').textContent,'CLEAR THESE','a search cut short at 500 names no count it cannot prove');A.ok(!w.q('#dl-clear-shown').hidden,'…and still offers the clear');
    w.q('#dl-query').value='';w.q('#dl-status').value='produced';library={items:many.slice(0,400),total:540,summary:{total:612,pending:150}};
    w.q('#dl-refresh')._h.click[0]();await settle();A.eq(w.q('#dl-clear-shown').textContent,'CLEAR THESE 540','a done-status view clears every match');
    w.q('#dl-status').value='pending';library={items:many.slice(400),total:150,summary:{total:612,pending:150}};
    w.q('#dl-refresh')._h.click[0]();await settle();A.ok(w.q('#dl-clear-shown').hidden,'an undecided-only view offers no CLEAR');
    delete global.ArmConfirm;delete global.fetch;
  }
  // seams-07: the sidecar sends the count itself, on the filtered view, by the clear route's own skip rule
  {
    const idx=readSidecarSource();
    const list=idx.slice(idx.indexOf('async function handleDeliverablesList('),idx.indexOf('async function handleDeliverablesClear('));
    A.ok(/items = deliverableFilter\(items, filter\);[\s\S]*clearable: items\.filter\(r => r\.status !== 'pending'\)\.length/.test(list),'the library list answers how many rows CLEAR ALL would take');
    A.ok(/const ids = rows\.filter\(r => r\.status !== 'pending'\)/.test(idx),'with the same rule the clear route applies');
  }
  A.report('declutter-recovery');
})().catch(e=>{console.error(e);process.exitCode=1;});
