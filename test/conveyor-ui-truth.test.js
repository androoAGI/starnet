/* Recovery regressions: compiled hand-offs, stable names, real feed evidence and LOOP run bounds. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');
for (const [input, shown] of [['Line A', 'LINE A'], ['line: b', 'LINE B'], ['LINE—C', 'LINE C'], ['Line', 'LINE LINE'], ['assembly', 'LINE ASSEMBLY']]) A.eq(P.lineWord(input), shown, 'line name shown once: ' + input);
A.eq(P.lineWord('', 'LINE p12'), 'LINE p12', 'unnamed fallback preserves its identity');
const hand = P.handoffInput({ fromName: 'Line A', original: 'write the report', output: 'report body' });
A.ok(hand.startsWith('[HAND-OFF — LINE A finished'), 'hand-off carries no duplicate LINE prefix');
A.ok(hand.includes('full finished work itself'), 'receiving line must hand on the work rather than completion commentary');
A.eq(P.parseHandoffInput(P.parseHandoff(P.handoffPrompt(hand, 'nova', 'revised body', 1)).original).original, 'write the report', 'nested later-stage hand-off retains the human job');
/* M7 (2026-10-12): the old expectation {B:true,A:true} was WRONG — a run count is not a feed. A line's runs include the
   Commander's own SEND IT A JOB and the lead's station.test_line, and neither starts the line by itself: counting them cleared
   the NO FEED nag and ticked the finish card's "what starts this line" for a line nothing is wired to start. Per-line feed
   evidence is a compiled hand-off into it (SEND TO); channels/routines/folders/webhooks come through the station-wide feed. */
A.eq(P.fedLineIds({sendTo:{out:{toLine:'B'}}}, {known:true,byLine:{A:{runs:1},C:{runs:0}}}), {B:true}, 'a compiled hand-off proves a fed line; a run count does not');
A.eq(P.fedLineIds({}, {known:true,byLine:{A:{runs:3,tests:2}}}), {}, 'a line with sample/test runs and nothing wired to start it is NOT fed');
A.eq(P.fedLineIds({}, {known:false,byLine:{A:{runs:5}}}), {}, 'unknown stats cannot assert real runs');
function fresh() { const d=WM.starterDoc(); for(const r of Object.values(d.rooms)) for(const b of r.rects) {b.x2=64;b.y2=48;} return WM.create(d); }
function crew(st) { for(const p of st.props()) if(p.t==='bay') st.assignPropAgent(p.id,'ag_'+p.id); }
for(const [bp,worst] of [['revision_loop',8],['deep_dive',12]]) {
 const st=fresh(); A.ok(LE.placeBlueprint(st,bp,{x:20,y:10}).ok,'place '+bp); crew(st);
 const plan=P.compileRoutingPlan(st.projectGeometry()), before=plan.hash, n=P.lineStages(plan,plan.lines[0].lineId);
 A.eq(n.worst,worst,bp+' shows the possible LOOP runs'); A.eq(plan.hash,before,'display count never changes routing identity');
}
{
 const st=fresh(), a=LE.placeBlueprint(st,'research_line',{x:8,y:4}), b=LE.placeBlueprint(st,'research_line',{x:8,y:22}); crew(st);
 const find=(r,t)=>r.ids.find(id=>st.propById(id).t===t), ob=find(a,'outbox'), ia=find(a,'intake'), ib=find(b,'intake');
 A.ok(st.setSendTo(ob,ib).ok,'two independent lines linked by SEND TO');
 st.setPropLabel(ib,'Line B'); A.eq(st.sendToChoices(ob).find(c=>c.on).name,'LINE B','model SEND TO choices use the same normalized label');
 const p=P.compileRoutingPlan(st.projectGeometry());
 // Produced files now ride the job as exact read grants, so the old blanket private-files warning is retired.
 A.ok(!p.errors.some(e=>/^SEND_TO/.test(e.code)),'a clean SEND TO compiles no finding (no PRIVATE FILES nag on the floor)');
 A.eq(typeof P.sendToFileAdvice,'undefined','retired private-files advice has no remaining public producer');
 A.ok(P.ok(p)&&!!p.sendTo[ob],'different crews can hand produced files on without a shared project');
 st.setPropProject(ia,'C:/projects/source'); st.setPropProject(ib,'C:/projects/target');
 const q=P.compileRoutingPlan(st.projectGeometry());
 A.ok(!q.errors.some(e=>e.code==='SEND_TO_PRIVATE_FILES'),'two named project folders need no private-workspace warning');
 A.eq(q.hash,p.hash,'private-file legibility does not change the routing hash');
 st.setPropProject(ib,'');
 A.ok(!!P.compileRoutingPlan(st.projectGeometry()).sendTo[ob],'source project alone preserves SEND TO');
 st.setPropProject(ia,''); st.setPropProject(ib,'C:/projects/target');
 A.ok(!!P.compileRoutingPlan(st.projectGeometry()).sendTo[ob],'target project alone preserves SEND TO');
}
// one agent on both lines: its own private workspace — the files ARE reachable, so no advice (M29: the old warning was false here)
{
 const st=fresh(), a=LE.placeBlueprint(st,'research_line',{x:8,y:4}), b=LE.placeBlueprint(st,'research_line',{x:8,y:22});
 for(const pr of st.props()) if(pr.t==='bay') st.assignPropAgent(pr.id,'writer');
 const find=(r,t)=>r.ids.find(id=>st.propById(id).t===t), ob=find(a,'outbox'), ib=find(b,'intake');
 A.ok(st.setSendTo(ob,ib).ok,'one agent, two lines, SEND TO');
 const p=P.compileRoutingPlan(st.projectGeometry());
 A.ok(!!p.sendTo[ob]&&!p.errors.some(e=>/^SEND_TO/.test(e.code)),'the same agent on both lines keeps a valid SEND TO');
 // A different receiving agent can read exactly the files handed on by this job.
 const bayB=b.ids.find(id=>st.propById(id).t==='bay'); st.assignPropAgent(bayB,'coder');
 A.ok(!P.compileRoutingPlan(st.projectGeometry()).errors.some(e=>e.code==='SEND_TO_PRIVATE_FILES'),'changing the receiving crew cannot revive the retired warning');
}

// Placement checks the complete footprint and calls the same insertion verdict as the click.
{
 const fs=require('fs'),vm=require('vm'),build=fs.readFileSync(require.resolve('../frontend/app/build.js'),'utf8');
 const start=build.indexOf('  function beltUnderFoot('),end=build.indexOf('  function commitPropStamp(',start);
 let probes=0;const links=[{from:{prop:'a'},to:{prop:'b'},path:[{x:5,y:5}]}];
 const ctx={CONNECT_TYPES:{bay:1,outbox:1,splitter:1},JUNCTION_TAG_TYPES:{splitter:1},linkedFloor:()=>true,linksMemoed:()=>links,station:{beltAt:(x,y)=>x===5&&y===5,canInsertBayBetween:()=>{probes++;return{ok:true};}}};
 vm.createContext(ctx);vm.runInContext(build.slice(start,end)+'this.check=beltUnderFoot;',ctx);
 A.ok(ctx.check('bay',4,4,{w:2,h:2}).v.ok,'BAY overlap at far footprint corner is an insertion');
 A.eq(probes,1,'insertion asks the model verdict');
 A.ok(!ctx.check('outbox',4,4,{w:2,h:2}).v.ok,'OUTBOX over any footprint belt tile refuses');
 A.eq(ctx.check('splitter',5,5,{w:1,h:1}),null,'junctions keep their separate on-belt path');
 A.eq(ctx.check('bay',1,1,{w:2,h:2}),null,'clear floor keeps ordinary placement');
 links.push({from:{prop:'c'},to:{prop:'d'},path:[{x:5,y:5}]});
 A.ok(!ctx.check('bay',4,4,{w:2,h:2}).v.ok,'shared belt tile refuses ambiguous insertion');
}
// A BAY dropped on a belt: the ghost stands where the click LANDS it (final floor lane M4). The insert picks its spot near the
// lane's middle, wherever on the belt you point — so the ghost, its art and the landing flash read the model's own dry run.
{
 const fs=require('fs'),vm=require('vm'),build=fs.readFileSync(require.resolve('../frontend/app/build.js'),'utf8');
 const start=build.indexOf('  function beltUnderFoot('),end=build.indexOf('  function commitPropStamp(',start);
 const s=WM.create();s.projectGeometry();s.addRoom({kind:'hab',rect:{x1:30,y1:0,x2:120,y2:60}});
 const add=(t,x,y)=>s.addProp({t,x,y,w:2,h:2,block:true}).id,I=add('intake',32,4),B=add('bay',42,4),O=add('outbox',76,4);
 A.ok(s.connectBelt(I,B).ok&&s.connectBelt(B,O).ok,'insert rig');
 const ctx={CONNECT_TYPES:{bay:1,outbox:1,splitter:1},JUNCTION_TAG_TYPES:{splitter:1},linkedFloor:()=>true,linksMemoed:()=>s.links(),station:s};
 vm.createContext(ctx);vm.runInContext(build.slice(start,end)+'this.check=beltUnderFoot;this.land=landRect;',ctx);
 const lane=s.links().find(l=>l.from.prop===B),size={w:2,h:2};
 for(const t of [lane.path[2],lane.path[Math.floor(lane.path.length/2)],lane.path[lane.path.length-3]]){
  const foot=ctx.check('bay',t.x,t.y,size),ghost=ctx.land(foot,{x1:t.x,y1:t.y,x2:t.x+1,y2:t.y+1},size);
  A.ok(foot&&foot.v.ok&&foot.v.x!=null,'hovering belt tile '+t.x+','+t.y+' offers an insert with its landing spot');
  const before=JSON.stringify(s.serialize()),r=s.insertBayBetween(lane.from.prop,lane.to.prop,{w:2,h:2,block:true});
  A.ok(r.ok,'…the click inserts');
  A.eq(ghost,{x1:r.x,y1:r.y,x2:r.x+1,y2:r.y+1},'…and the ghost rect IS the committed BAY (pointer '+t.x+','+t.y+')');
  A.eq({x:foot.v.x,y:foot.v.y},{x:r.x,y:r.y},'…the dry run and the insert agree');
  s.undo();A.eq(JSON.stringify(s.serialize()),before,'(undo)');
 }
 A.eq(ctx.land(null,{x1:1,y1:2,x2:2,y2:3},size),{x1:1,y1:2,x2:2,y2:3},'off a belt the ghost stays at the pointer');
 A.ok(/if \(foot && res && res\.ok && res\.x != null\) \{ px = res\.x; py = res\.y; \}[^\n]*\n\s*if \(res && res\.ok\) \{\s*pushFlash\(\[\{ x1: px, y1: py/.test(build),'the landing flash marks the BAY where it landed');
 A.ok((build.match(/rects: ?\[landRect\(foot, rect, s\)\]/g)||[]).length===2,'both the hover ghost and the stamp drag stand at the landing spot');
}
A.report('conveyor-ui-truth.test');
