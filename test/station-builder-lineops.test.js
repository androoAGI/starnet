'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const M = require('../frontend/app/worldmodel.js'), P = require('../frontend/app/pipeline.js');
const W = require('../frontend/app/workflowline.js'), LE = require('../frontend/app/lineedit.js');
const SB = require('../frontend/app/stationbuilder.js'), S = require('../frontend/app/propsprites.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const env = { WorldModel:M, Pipeline:P, WorkflowLine:W, LineEdit:LE, PropSprites:S, crew:[{id:'agent',name:'NOVA'}], heroId:'agent' };
M.setPropRules(t => { const s=S.spec(t); return s ? {mount:s.mount||null,stack:!!s.stack,surface:!!s.surface,flat:!!s.flat} : null; });
const snap = s => JSON.stringify(s.serialize());
function fixture() {
  const s=M.create(); const z=s.rooms()[0].rects[0];
  A.ok(s.addRoom({kind:'hab',rect:{x1:z.x2+1,y1:z.y1,x2:z.x2+50,y2:z.y1+40}}).ok,'hall for independent lines');
  const lines=[];
  for(const [i,name] of [[0,'Line A'],[1,'Line B']]) {
    const r=LE.run(s,null,'newLine',{role:'WRITER'},{near:{x:z.x2+8,y:z.y1+4+i*12}});
    A.ok(r.ok,'line fixture '+name); if(!r.ok) throw Error(JSON.stringify(r));
    const c=P.lineComponents(s.projectGeometry()).find(c=>c.props.includes(r.focus));
    const l={intake:c.intakes[0],outbox:c.outboxes[0],bay:c.bays[0].propId};
    s.setPropLabel(l.intake,name); s.assignPropAgent(l.bay,'agent'); s.ensureWorkstation('agent');
    s.setPropBrief(l.bay,'Write the incoming work.'); s.setPropHands(l.bay,'Pass the full draft.');
    lines.push(l);
  }
  return {s,a:lines[0],b:lines[1],z};
}
function plan(s,ops) {const before=snap(s),r=SB.planEdit(s.serialize(),{refit:ops},env);A.eq(snap(s),before,'planning never mutates the live floor');return r;}
function enact(s,ops) {const r=plan(s,ops);A.ok(r.ok,'plan accepted: '+(r.error||''));if(!r.ok) throw Error(r.error);const x=SB.apply(s,r.plan,env);A.ok(x.ok,'apply accepted: '+(x.error||''));return r.plan;}
{
  const {s,a,b}=fixture(),before=snap(s);
  const p=enact(s,[{op:'connect',from:a.outbox,to:b.intake}]);
  A.eq(s.propById(a.outbox).sendTo,b.intake,'OUTBOX-to-INBOX connect is SEND TO');
  A.eq(P.lineComponents(s.projectGeometry()).length,2,'SEND TO never fuses the lines');
  A.ok(/LINE B/.test(p.summary)&&!/LINE LINE B/.test(p.summary),'approval names the destination once');
  A.ok(s.undo().ok,'one undo'); A.eq(snap(s),before,'one undo restores exact document');
  enact(s,[{op:'sendto',from:a.outbox,to:b.intake}]);
  const linked=snap(s);
  for(const ops of [[{op:'send',prop:a.outbox,to:a.intake}],[{op:'send',prop:b.outbox,to:a.intake}],[{op:'send',prop:a.outbox}]]) {
    const r=plan(s,ops);A.ok(!r.ok&&/same line|circle|needs to/i.test(r.error),'invalid SEND TO is refused by model or explicit argument check: '+r.error);A.eq(snap(s),linked,'refusal leaves existing connection');
  }
  enact(s,[{op:'send',prop:a.outbox,to:null}]); A.ok(!s.propById(a.outbox).sendTo,'explicit null clears SEND TO');
}
{
  const {s,a,b,z}=fixture(); s.setSendTo(a.outbox,b.intake);s.setPropProject(a.intake,'C:/projects/source');s.setPropLimits(a.intake,{maxHops:9,maxUsdPerMessage:2,maxUsdPerDay:5});
  const before=snap(s),ids=new Set(s.props().map(p=>p.id));
  const p=enact(s,[{op:'copy',line:'Line A',x:z.x2+28,y:z.y1+24,as:'copied'},{op:'send',prop:b.outbox,to:'copied'}]);
  const made=s.props().filter(p=>!ids.has(p.id)),inbox=made.find(p=>p.t==='intake'),bay=made.find(p=>p.t==='bay'),outbox=made.find(p=>p.t==='outbox');
  A.ok(inbox&&bay&&outbox,'whole line copied');A.eq([bay.role,bay.agentId,bay.brief,bay.hands],['WRITER','agent','Write the incoming work.','Pass the full draft.'],'role, crew, brief and hand-off preserved');
  A.eq(inbox.limits,s.propById(a.intake).limits,'copy keeps own budget settings');A.ok(!inbox.projectRoot&&!outbox.sendTo,'copy drops project folder and external SEND TO');
  A.eq(s.propById(b.outbox).sendTo,inbox.id,'an as name resolves a copied INBOX later in same plan');A.ok(/not copied:.*SEND TO.*project folder/.test(p.summary),'approval names omitted project and onward destination');
  A.eq(P.lineComponents(s.projectGeometry()).length,3,'copy is a third independent line');
  A.ok(s.undo().ok,'copy refit undoes once');A.eq(snap(s),before,'copy and later SEND TO undo together');
  A.ok(!plan(s,[{op:'copy',prop:a.bay,x:20,y:20,turn:1.5}]).ok,'fractional turn refused');
}
{
  const {s,a,b}=fixture();s.setSendTo(a.outbox,b.intake);const before=snap(s);
  const p=enact(s,[{op:'delete',line:'Line B'}]);
  A.ok(/LINE A no longer sends its finished work on/.test(p.summary),'delete plan names broken incoming SEND TO');
  A.ok(!s.propById(b.intake)&&!s.propById(a.outbox).sendTo,'delete removes destination and clears pointer');s.undo();A.eq(snap(s),before,'delete restores destination and SEND TO in one undo');
  const old=SB.planEdit(s.serialize(),{remove:{line:'Line B'}},env);A.ok(old.ok&&/LINE A no longer sends/.test(old.plan.summary),'original remove-line entry point warns too');
  const prop=plan(s,[{op:'delete',prop:b.intake}]);A.ok(prop.ok&&/LINE A no longer sends/.test(prop.plan.summary),'delete INBOX warns too');
}
// M24 (2026-10-12): a copy laid out to fit says where it really stands and how many belts it really has
{
  const {s,a}=fixture(),ia=s.propById(a.intake),ids=new Set(s.props().map(p=>p.id));
  const p=enact(s,[{op:'copy',line:'Line A',x:ia.x+1,y:ia.y}]);
  const made=s.props().filter(q=>!ids.has(q.id)),ax=Math.min(...made.map(q=>q.x)),ay=Math.min(...made.map(q=>q.y));
  A.ok(/laid out to fit near \(\d+, \d+\)/.test(p.summary),'fixture: the exact spot overlaps, so the copy is laid out to fit: '+p.summary);
  A.ok(p.summary.indexOf('a copy of LINE A at ('+ax+', '+ay+')')>=0,'the card names where the copy actually stands ('+ax+', '+ay+'): '+p.summary);
  const belts=+(/(\d+) belts/.exec(p.summary)||[])[1],links=s.links().filter(l=>made.some(q=>q.id===l.from.prop)).length;
  A.ok(belts>0&&belts===links,'the card counts the belts the copy really has ('+belts+' vs '+links+')');
}
// M5 (2026-10-12): { op:'delete', line, room } takes up THAT line, never the room it stands in (and every other line in it)
{
  const {s,a,b}=fixture(),ia=s.propById(a.intake),room=s.rooms().find(r=>r.id===s.roomAt(ia.x,ia.y)).name,rooms=s.rooms().length,before=snap(s);
  A.eq(s.roomAt(ia.x,ia.y),s.roomAt(s.propById(b.intake).x,s.propById(b.intake).y),'fixture: both lines stand in one room');
  const p=enact(s,[{op:'delete',line:'Line A',room}]);
  A.ok(/LINE A taken up/.test(p.summary)&&!/removed, with the/.test(p.summary),'a line named with its room is the line, never the room: '+p.summary);
  A.eq(s.rooms().length,rooms,'every room stays');
  A.ok(!s.propById(a.intake)&&!s.propById(a.bay)&&!s.propById(a.outbox),'that line\'s machines are gone');
  A.ok(s.propById(b.intake)&&s.propById(b.bay)&&s.propById(b.outbox),'the other line in the same room is untouched');
  A.ok(s.undo().ok,'one undo');A.eq(snap(s),before,'one undo restores the line');
  const miss=plan(s,[{op:'delete',line:'Line A',room:'NO SUCH ROOM'}]);A.ok(!miss.ok&&/no room called/i.test(miss.error),'an unknown room is refused, never a guess: '+miss.error);
  const both=plan(s,[{op:'delete',line:'Line A',prop:b.bay}]);A.ok(!both.ok&&/one of/i.test(both.error),'a delete naming a line AND a piece is refused, never a silent pick: '+both.error);
}
// M6 (2026-10-12): a SEND TO made with connect (OUTBOX onto INBOX) is named on a long refit's card like op send — never "… more edits"
{
  const {s,a,b}=fixture(),labels=n=>Array.from({length:n},(_,i)=>({op:'label',prop:a.bay,text:'Step '+i}));
  const r=plan(s,labels(30).concat([{op:'connect',from:a.outbox,to:b.intake}],labels(5)));
  A.ok(r.ok,'long refit with a connect plans: '+(r.error||''));
  A.ok(/sends every finished job on to .*SEND TO/.test(r.plan.summary),'the connect that became a SEND TO is listed on the card');
  const briefs=n=>Array.from({length:n},(_,i)=>({op:'brief',prop:a.bay,text:'Brief '+i}));
  const r2=plan(s,labels(25).concat(briefs(61),[{op:'connect',from:a.outbox,to:b.intake}],labels(3)));
  A.ok(r2.ok&&/more edits that change what stands \([^)]*\b1 SEND TOs\b/.test(r2.plan.summary),'past 60 weighty edits the connect is counted as a SEND TO: '+(r2.ok?r2.plan.summary.slice(-200):r2.error));
  const z=s.rooms()[1].rects[0],X=z.x1+19,Y=z.y1+32;
  const r3=plan(s,labels(28).concat([{op:'place',t:'bay',x:X,y:Y,as:'p1'},{op:'place',t:'bay',x:X+8,y:Y,as:'p2'},{op:'connect',from:'p1',to:'p2'}],labels(5)));
  A.ok(r3.ok&&!/belted to/.test(r3.plan.summary)&&/… and 11 more edits that add or name pieces/.test(r3.plan.summary),'a plain belt connect stays a quiet edit (not every connect is weighty): '+(r3.ok?r3.plan.summary.slice(-120):r3.error));
}
// M27 (2026-10-12): an old OUTBOX→INBOX belt is converted by the lead's own send/connect (the Workflow panel's MAKE IT A SEND TO),
// never a refusal telling it to make a gesture no op can make
function legacy() {
  const {s,a,b,z}=fixture(),d=JSON.parse(snap(s));
  for(const p of d.props)if(p.id===a.outbox||p.id===b.intake)p.t='bay';
  const old=M.deserialize(d);A.ok(old.connectBelt(a.outbox,b.intake).ok,'old belt fixture');
  const saved=JSON.parse(snap(old));for(const p of saved.props){if(p.id===a.outbox)p.t='outbox';if(p.id===b.intake)p.t='intake';}
  const st=M.deserialize(saved);A.eq(st.oldHandoffBelts(a.outbox).length,1,'fixture: one legacy hand-off belt');A.eq(st.sendToRefusal(a.outbox,b.intake).error,'OLD_BELT','fixture: the floor refuses with OLD_BELT');
  return {s:st,a,b,z};
}
for(const op of ['send','connect']) {
  const {s,a,b}=legacy(),before=snap(s),oldTiles=s.links().find(l=>l.from.prop===a.outbox).path.map(t=>t.x+','+t.y);
  const r=plan(s,[{op,from:a.outbox,to:b.intake}]);
  A.ok(r.ok,op+': the old belt converts instead of a refusal: '+(r.error||''));
  A.ok(r.ok&&/old belt .* taken up.*SEND TO/.test(r.plan.summary),op+': the card says the old belt is taken up and becomes a SEND TO');
  if(!r.ok) continue;
  A.ok(SB.apply(s,r.plan,env).ok,op+': applies');
  A.eq(s.propById(a.outbox).sendTo,b.intake,op+': SEND TO set');A.eq(s.oldHandoffBelts(a.outbox).length,0,op+': no old hand-off link left');
  A.eq(P.lineComponents(s.projectGeometry()).length,2,op+': two separate lines');
  const belts=s.serialize().belts||{};A.ok(!oldTiles.some(k=>{const [x,y]=k.split(',').map(Number);return !s.propAt(x,y)&&belts[k];}),op+': no tile of the old belt is left on the floor');
  A.ok(s.undo().ok,op+': one undo');A.eq(snap(s),before,op+': one undo restores the old belt');
}
{
  const {s,a,b,z}=legacy(),c=LE.run(s,null,'newLine',{role:'WRITER'},{near:{x:z.x2+8,y:z.y1+28}});A.ok(c.ok,'third line');
  const cc=P.lineComponents(s.projectGeometry()).find(k=>k.props.includes(c.focus)),d=JSON.parse(snap(s));
  for(const p of d.props)if(p.id===a.outbox||p.id===cc.intakes[0])p.t='bay';
  const o2=M.deserialize(d);A.ok(o2.connectBelt(a.outbox,cc.intakes[0]).ok,'second old belt fixture');
  const sv=JSON.parse(snap(o2));for(const p of sv.props){if(p.id===a.outbox)p.t='outbox';if(p.id===cc.intakes[0]||p.id===b.intake)p.t='intake';}
  const st=M.deserialize(sv),before=snap(st);A.eq(st.oldHandoffBelts(a.outbox).length,2,'fixture: two legacy hand-off belts');
  const r=SB.planEdit(st.serialize(),{refit:[{op:'send',from:a.outbox,to:b.intake}]},env);
  A.ok(!r.ok&&/unbelt/.test(r.error)&&/op: "send"/.test(r.error)&&!/Convert it to SEND TO/.test(r.error),'several old belts: the refusal names the ops the lead can send: '+(r.error||''));
  A.eq(snap(st),before,'refusal leaves the floor');
}
(async()=>{
  let payload={};
  const t=makeStationTools({station:{request:async(verb,args)=>({ok:true,result:args&&args.line==='b'?{lineId:'b',name:'Line B',crewed:1,steps:[]}:{lineId:'a',name:'A',crewed:1,steps:[]}})},runLineJob:async()=>({code:200,obj:Object.assign({ok:true,totalUsd:0.12,runs:[],replies:[]},payload)})}).testLineTool;
  A.ok(/SEND TO.*own cost/.test(t.description),'test tool warns before paid downstream job');
  payload={sentTo:{line:'b',name:'Line B',jobId:'job-b'}};let r=await t.run({line:'A',job:'work'},{}),j=JSON.parse(r.content.split('\n')[0]);
  A.eq([j.cost,j.sentOnTo.lineId,j.sentOnTo.jobId],['$0.12','b','job-b'],'upstream cost and actual downstream job kept distinct');A.ok(/created/.test(j.sentOnTo.note)&&!/(now running|completed)/.test(j.sentOnTo.note),'created record is not a guessed current state');
  payload={sentTo:{line:'b',name:'B',refused:'budget exhausted'}};r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);A.eq(j.sentOnTo.refused,'budget exhausted','downstream refusal preserved');A.ok(/refused/.test(r.summary),'summary says refused');
  payload={onwardDestinations:[{lineId:'b',outboxId:'o'}]};r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);A.eq(j.sentOnTo.state,'unconfirmed','configured destination without durable link is unconfirmed');A.ok(!j.sentOnTo.jobId&&!/queued behind/.test(r.content),'no invented queue state');
  // conveyor-ui-17 / seams-06: the route's real producer reads the OUTBOX id from plan.sendTo's key (the values carry
  // fromLine/toLine/intakeId only), so the lead can tell which OUTBOX hands on to which line
  const idxSrc=readSidecarSource();
  const producer=(idxSrc.match(/onward\.onwardDestinations = [^\n]*/)||[''])[0];
  A.ok(/Object\.entries\(plan\.sendTo\)/.test(producer)&&/outboxId \}\)/.test(producer),'onwardDestinations names each OUTBOX by its plan key: '+producer.slice(0,160));
  {
    const plan={sendTo:{ob1:{intakeId:'in1',fromLine:'A',toLine:'b'},ob2:{intakeId:'in2',fromLine:'A',toLine:'c'},ob3:{intakeId:'in3',fromLine:'Z',toLine:'b'}}};
    const onward={},line='A';
    new Function('line','plan','onward','sampleLineOutcome',producer+';')(line,plan,onward,null);
    A.eq(onward.onwardDestinations,[{lineId:'b',outboxId:'ob1'},{lineId:'c',outboxId:'ob2'}],'two OUTBOXes on one line: each destination names its OUTBOX');
  }
  /* THE JOB'S OWN OUTBOX DECIDES (qa/bugs 3ee2d13a, 2026-10-15): the producer listed EVERY SEND TO of the line, so a job that landed in
     an OUTBOX that sends nowhere came back to station.test_line as "— onward hand-off unconfirmed" for a hand-off that can never
     happen (the hand-off itself only ever leaves from the OUTBOX the job reached: chain.js out.outboxId, pipeline.js sendToOf). The
     chain names that OUTBOX; the hub's line outcome carries it (sampleLineOutcome.outboxId); the producer keeps only its SEND TO.
     Where the job landed unknown: every SEND TO of the line, exactly as before. */
  {
    const dest=(plan,outcome)=>{const onward={};new Function('line','plan','onward','sampleLineOutcome',producer+';')('A',plan,onward,outcome);return onward.onwardDestinations;};
    const one={sendTo:{ob1:{intakeId:'in1',fromLine:'A',toLine:'b'}}};   // OUTBOX ob2 is on line A too, and sends nowhere
    A.eq(dest(one,{agentId:'x',dockId:'d2',stopped:null,outboxId:'ob2'}),[],'landed in the OUTBOX that sends nowhere: no onward destination');
    A.eq(dest(one,{agentId:'x',dockId:'d1',stopped:null,outboxId:'ob1'}),[{lineId:'b',outboxId:'ob1'}],'landed in the sending OUTBOX: its one destination');
    const two={sendTo:{ob1:{intakeId:'in1',fromLine:'A',toLine:'b'},ob2:{intakeId:'in2',fromLine:'A',toLine:'c'},ob3:{intakeId:'in3',fromLine:'Z',toLine:'b'}}};
    A.eq(dest(two,{outboxId:'ob2'}),[{lineId:'c',outboxId:'ob2'}],'two sending OUTBOXes: only the one the job reached');
    A.eq(dest(two,{outboxId:'ob3'}),[],'an OUTBOX of another line is never this line\'s destination');
    for(const unknown of [null,{agentId:'x',stopped:null},{outboxId:null},{outboxId:''}])
      A.eq(dest(two,unknown),[{lineId:'b',outboxId:'ob1'},{lineId:'c',outboxId:'ob2'}],'where it landed unknown ('+JSON.stringify(unknown)+'): every SEND TO of the line, as before');
    payload={onwardDestinations:dest(one,{outboxId:'ob2'})};
    const r2=await t.run({line:'A',job:'work'},{}),j2=JSON.parse(r2.content.split('\n')[0]);
    A.ok(j2.status==='delivered'&&!j2.sentOnTo&&!/onward|unconfirmed/.test(r2.summary)&&!/Check this job again/.test(r2.content),'station.test_line: a job in the OUTBOX that sends nowhere claims no hand-off — '+r2.summary);
  }
  /* …and END TO END on a real floor: a SORTING OFFICE (two BAYs, each into its OWN OUTBOX; only OUTBOX 1 sends on to LINE B), the
     real compiled plan, the real chain runner and the real channel hub the sample route runs on. The hub's line outcome names the
     OUTBOX the job reached; the route's own producer line reads it; station.test_line says what that means. */
  {
    const { makeChannelHub } = require('../sidecar/channels/hub.js');
    const { makeChainRunner } = require('../sidecar/routing/chain.js');
    const d=M.starterDoc(); for(const id in d.rooms) for(const rc of d.rooms[id].rects){rc.x2=60;rc.y2=44;}
    const st=M.create(d);
    const so=LE.placeBlueprint(st,'sorting_office',{x:8,y:4});
    A.ok(so.ok,'(fixture) a sorting office: '+JSON.stringify(so.error||''));
    const sb=so.ids.filter(id=>st.propById(id).t==='bay'),[o1,o2]=so.ids.filter(id=>st.propById(id).t==='outbox');
    const rb=LE.placeBlueprint(st,'research_line',{x:8,y:24}),bIn=rb.ids.find(id=>st.propById(id).t==='intake');
    for(const p of st.props()) if(p.t==='bay'&&!p.agentId) st.assignPropAgent(p.id,'ag_'+p.id);
    A.ok(sb.length===2&&o1&&o2&&st.setSendTo(o1,bIn).ok,'(fixture) two BAYs, two OUTBOXes on one line; only OUTBOX 1 sends on');
    const pl=P.compileRoutingPlan(st.projectGeometry()),la=pl.lineOfProp[sb[0]],lb=pl.lineOfProp[bIn];
    A.ok(la&&lb&&la!==lb&&pl.lineOfProp[sb[1]]===la,'(fixture) both BAYs on the sorting line, LINE B its own line');
    let n=0;const newId=()=>'id'+(++n)+'abcdef0123456789';
    const chain=makeChainRunner({nextAgent:()=>null,now:()=>1000,newId,stepDock:(dock,ctx)=>P.chainStepDock(pl,dock,ctx),entryDockOf:()=>null,
      lastStage:(a,dock)=>{const c=P.dockLayer(pl).dockChains[dock];return !!(c&&c.outbox&&!c.deadEnd);}});
    const outcomeAt=async dock=>{
      let lo=null;
      const hub=makeChannelHub({
        runOnce:async ro=>{ro.emit('agent.run.start',{agentId:ro.agentId,runId:ro.runId});ro.emit('agent.token',{agentId:ro.agentId,runId:ro.runId,delta:'sorted by '+ro.agentId});ro.emit('agent.run.end',{agentId:ro.agentId,runId:ro.runId,reason:'done',turns:1,usd:0});},
        store:{loadHistory:()=>[],appendTurn:()=>[],getChatRecord:()=>undefined},send:()=>Promise.resolve({ok:true}),secrets:()=>({key:'k',model:'m/x'}),
        classify:()=>true,emit:()=>{},newId,now:()=>1000,textBatchWaitMs:0,bindChats:false,chain,
        lineOriginFor:(a,dk)=>(dk?pl.lineOfProp[dk]:null)||null,
        resolveAgent:()=>({agentId:pl.agentOfDock[dock],dockId:dock}),resolveRunConfig:()=>({key:'k',model:'m/x'}),
        onLineOutcome:info=>{lo=info;}});
      await hub.onInbound({channel:'sample',chatId:'sample',chatType:'dm',userId:'commander',text:'sort this',messageId:'m-'+dock,ts:1});
      return lo;
    };
    const lo1=await outcomeAt(sb[0]),lo2=await outcomeAt(sb[1]);
    A.ok(lo1&&lo2&&lo1.stopped==null&&lo2.stopped==null,'(fixture) both jobs left the line clean: '+JSON.stringify([lo1,lo2]));
    A.eq([lo1&&lo1.outboxId,lo2&&lo2.outboxId],[o1,o2],'the hub\'s line outcome names the OUTBOX each job reached (chain out.outboxId)');
    const dest=lo=>{const onward={};new Function('line','plan','onward','sampleLineOutcome',producer+';')(la,pl,onward,lo);return onward.onwardDestinations;};
    A.eq(dest(lo2),[],'the job in the OUTBOX that sends nowhere: the route lists no onward destination');
    A.eq(dest(lo1),[{lineId:lb,outboxId:o1}],'the job in the sending OUTBOX: the route lists LINE B, from OUTBOX 1');
    payload={onwardDestinations:dest(lo2)};
    let r3=await t.run({line:'A',job:'work'},{}),j3=JSON.parse(r3.content.split('\n')[0]);
    A.ok(!j3.sentOnTo&&!/unconfirmed/.test(r3.summary),'station.test_line on the non-sending OUTBOX: no "onward hand-off unconfirmed" — '+r3.summary);
    payload={onwardDestinations:dest(lo1)};
    r3=await t.run({line:'A',job:'work'},{});j3=JSON.parse(r3.content.split('\n')[0]);
    A.ok(j3.sentOnTo&&j3.sentOnTo.state==='unconfirmed'&&/unconfirmed/.test(r3.summary),'…on the sending OUTBOX, with no job link yet, it is still said as unconfirmed — '+r3.summary);
  }
  // (wave 2 review, conveyor-backend-10) a destination is named, and only a job that reached its OUTBOX claims one
  A.eq(j.sentOnTo.destinations,[{lineId:'b',line:'Line B',outboxId:'o'}],'each destination carries the line name the lead can say, its id and its OUTBOX');
  payload={ok:false,error:'a step did not finish cleanly',runs:[{runId:'r1',reason:'error'}],onwardDestinations:[{lineId:'b',outboxId:'o'}]};r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);
  A.ok(j.status==='problem'&&!j.sentOnTo&&!/unconfirmed/.test(r.summary)&&!/Check this job again/.test(r.content),'a failed test claims no onward hand-off: '+r.summary);
  payload={ok:false,stopped:true,onwardDestinations:[{lineId:'b'}]};r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);
  A.ok(j.status==='stopped'&&!j.sentOnTo,'nor does a stopped one');
  // (wave 2 repair) a stop the station's own fault containment made is never told to the lead as the Commander's
  payload={ok:false,stopped:true,stoppedBy:'fault',error:'stopped — the station hit an internal fault and stopped this job before it reached the OUTBOX'};r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);
  A.ok(j.status==='stopped'&&/internal fault/.test(j.verdict)&&!/Commander/.test(j.verdict),'a fault stop is said as the station\'s fault: '+j.verdict);
  payload={ok:false,stopped:true};r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);
  A.eq(j.verdict,'The Commander stopped the job.','the Commander\'s own stop keeps its words');
  // the shape the route sends TODAY (sidecar/index.js reads s.outboxId off plan.sendTo values, which carry none, and JSON drops the
  // undefined): a destination is still named, and no OUTBOX id is invented for it (wave 2 review: the fixture above is the keyed shape
  // the route's own repair, seams-06 / conveyor-ui-17, will send)
  payload=JSON.parse(JSON.stringify({onwardDestinations:[{lineId:'b',outboxId:undefined}]}));r=await t.run({line:'A',job:'work'},{});j=JSON.parse(r.content.split('\n')[0]);
  A.eq(j.sentOnTo.destinations,[{lineId:'b',line:'Line B'}],'today\'s route shape: named, no OUTBOX id invented');
  A.report('station-builder-lineops');
})().catch(e=>{console.error(e);process.exitCode=1;});
