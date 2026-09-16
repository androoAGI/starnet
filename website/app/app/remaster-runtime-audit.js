/* Disposable, local-only QA controls over the actual World renderer/simulation.
   Uses a separately seeded sidecar. Never appears in the normal showcase. */
'use strict';
(async()=>{
  if(['127.0.0.1','localhost'].includes(location.hostname)&&new URLSearchParams(location.search).get('worldPerf')==='1'){
    const panel=document.createElement('div');panel.id='world-perf';panel.style.cssText='position:fixed;right:12px;top:80px;z-index:99999;padding:8px;background:#101b20;color:#c6d8dc;border:1px solid #647a80;max-width:600px;font:12px monospace';
    const button=document.createElement('button');button.className='bb';button.textContent='Measure frame performance';
    const overview=document.createElement('button');overview.className='bb';overview.textContent='Frame full station';overview.onclick=()=>{World.setCinecamIdle(86400000);World.frameReviewRoom('');};
    const recover=document.createElement('button');recover.className='bb';recover.textContent='Verify recovery';recover.onclick=async()=>{
      recover.disabled=true;const results=[];World.setCinecamIdle(86400000);
      try{for(let i=0;i<3;i++){
        const before=World._dbgCanvasLoss(),wiped=World._dbgLoseCanvases('lod'),began=performance.now();let after;
        do{await new Promise(r=>setTimeout(r,50));after=World._dbgCanvasLoss();}while(after.recoveries===before.recoveries&&performance.now()-began<5000);
        results.push({wiped,recovered:after.recoveries>before.recoveries&&!after.blank,ms:Math.round(performance.now()-began)});
      }out.textContent=JSON.stringify({recovery:results},null,2);}finally{recover.disabled=false;}
    };
    const out=document.createElement('pre');out.id='world-perf-result';out.style.cssText='white-space:pre-wrap;max-height:60vh;overflow:auto';panel.append(button,overview,recover,out);document.body.append(panel);
    button.onclick=async()=>{
      button.disabled=true;out.textContent='Measuring 10 seconds…';World.setCinecamIdle(86400000);World._dbgReviewPerformance(true);
      await new Promise(r=>setTimeout(r,10000));const p=World._dbgReviewPerformance(false),q=(a,f)=>{a.sort((a,b)=>a-b);return +(a[Math.min(a.length-1,Math.floor(a.length*f))]||0).toFixed(2);};
      const times=p.samples.map(s=>s.ms),gaps=p.samples.slice(1).map((s,i)=>s.t-p.samples[i].t),parts={};
      for(const k of Object.keys(p.samples[0]?.parts||{}))parts[k]={median:q(p.samples.map(s=>s.parts[k]||0),.5),p95:q(p.samples.map(s=>s.parts[k]||0),.95)};
      out.textContent=JSON.stringify({frames:p.samples.length,canvas:p.canvas,props:p.props,scale:p.scale,crt:p.crtBackend,probes:p.probeBackend,frameMs:{median:q(times,.5),p95:q(times,.95)},intervalMs:{median:q(gaps,.5),p95:q(gaps,.95)},parts,renderer:World.renderStats()},null,2);button.disabled=false;
    };
    return;
  }
  if(!['127.0.0.1','localhost'].includes(location.hostname)||new URLSearchParams(location.search).get('remasterAudit')!=='1')return;
  for(const file of ['prop-catalog-data.js','prop-catalog-fixture.js'])await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='app/'+file;s.onload=resolve;s.onerror=reject;document.head.append(s);});
  const panel=document.createElement('aside');panel.id='runtime-audit';
  const css=document.createElement('style');css.textContent='#kepler-review,#skin-study-preview{display:none!important}#runtime-audit{position:fixed;z-index:99999;left:8px;top:50px;max-width:calc(100vw - 36px);background:#091214ed;color:#d7c89d;border:1px solid #746546;padding:8px;font:12px VT323,monospace}#runtime-audit button,#runtime-audit select{background:#172124;color:#d7c89d;border:1px solid #61716b;padding:4px;margin:2px;font:12px VT323,monospace}#runtime-audit output{display:block;white-space:pre-wrap;max-width:700px}#runtime-audit pre{max-height:200px;overflow:auto;font-size:10px}';document.head.append(css);
  panel.innerHTML='<b>LOCAL RUNTIME AUDIT · disposable station</b><nav></nav><output id="runtime-summary">Waiting for World…</output><details><summary>Measured results</summary><pre id="runtime-results"></pre></details>';
  document.body.append(panel);const nav=panel.querySelector('nav'),out=panel.querySelector('output'),raw=panel.querySelector('pre');
  const pageSelect=document.createElement('select');pageSelect.setAttribute('aria-label','Catalog room');nav.append(pageSelect);
  const subject=document.createElement('select');subject.setAttribute('aria-label','Audit subject');nav.append(subject);
  let page=0,fixture=null,original=null,busy=false,receipt={cases:[],performance:[]},last='';
  const walkLabel=document.createElement('label'),walkAll=document.createElement('input');walkAll.type='checkbox';walkAll.checked=true;walkLabel.append(walkAll,' Walk every case');nav.append(walkLabel);
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const button=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.onclick=()=>Promise.resolve(fn()).catch(e=>{out.textContent=e.stack||String(e);panel.dataset.state='error';});nav.append(b);return b;};
  const capabilityReview=new URLSearchParams(location.search).get('capabilityReview')==='1';
  const seatReview=new URLSearchParams(location.search).get('seatReview')==='1';
  const reviewViews=seatReview?PropCatalogData.views.filter(v=>['seat','couch','bed'].includes(PropSprites.spec(v.id).use?.kind)):capabilityReview?PropSprites.STARTER.map(id=>PropCatalogData.views.find(v=>v.id===id&&v.face==='s')).filter(Boolean):PropCatalogData.views;
  const entries=()=>reviewViews.slice(page*6,page*6+6);
  const wallReview=document.createElement('select');wallReview.setAttribute('aria-label','Wall material review');
  for(const id of Object.keys(WorldModel.WALL_MATERIALS)){const o=document.createElement('option');o.value=id;o.textContent=id;wallReview.append(o);}nav.append(wallReview);
  const actor=()=>World.bodies().find(b=>b.hero);
  const publish=()=>{raw.textContent=JSON.stringify(receipt,null,2);panel.dataset.state=busy?'running':'ready';out.textContent=last;};
  const load=async(mirror=false)=>{
    fixture=PropCatalogFixture.create(entries(),PropSprites,WorldModel);
    for(const p of fixture.doc.props){if(p.id.startsWith('catalog-')&&mirror&&PropSprites.canMirror(p.t))p.m=true;}
    fixture.station=WorldModel.deserialize(fixture.doc);World.loadStation(fixture.station);
    subject.replaceChildren();for(const v of entries()){const o=document.createElement('option');o.value='catalog-'+v.key;o.textContent=v.key;subject.append(o);}
    await pause(350);World.frameReviewRoom(fixture.roomId);World.setCinecamIdle(86400000);
    pageSelect.value=String(page);last='Room '+(page+1)+' / '+pageSelect.options.length+' · '+entries().map(v=>v.key).join(', ')+(mirror?' · mirrored':'');publish();
  };
  pageSelect.onchange=async()=>{if(busy)return;page=Number(pageSelect.value);await load();};
  button('Previous',async()=>{if(!busy){page=Math.max(0,page-1);await load();}});
  button('Next',async()=>{if(!busy){page=Math.min(pageSelect.options.length-1,page+1);await load();}});
  button('Use selected',()=>{const r=World._dbgReviewProp(actor().id,subject.value,'use');last=JSON.stringify(r);publish();});
  button('Walk around selected',()=>{last=JSON.stringify(World._dbgReviewProp(actor().id,subject.value,'walk'));publish();});
  button('Run catalog checks',async()=>{
    if(busy)return;busy=true;receipt.cases=[];publish();
    for(;page<pageSelect.options.length;page++){
      for(const mirror of [false,true]){
        await load(mirror);
        for(const v of entries()){
          if(mirror&&!PropSprites.canMirror(v.id))continue;
          let walk=null;
          if(walkAll.checked){
            const plan=World._dbgReviewProp(actor().id,'catalog-'+v.key,'walk');
            if(plan.route){
              const started=performance.now();let distance=Infinity,samples=0,maxStep=0,previous=actor();
              while(performance.now()-started<12000){
                await pause(40);const b=actor();distance=Math.hypot(b.px-plan.destination.x,b.py-plan.destination.y);maxStep=Math.max(maxStep,Math.hypot(b.px-previous.px,b.py-previous.py));previous=b;samples++;
                if(distance<1.1)break;
              }
              walk={arrived:distance<1.1,distance:+distance.toFixed(2),ms:Math.round(performance.now()-started),samples,maxStep:+maxStep.toFixed(2),motion:World._dbgReviewProp(actor().id,'catalog-'+v.key).motion,destination:plan.destination,end:{px:previous.px,py:previous.py,goal:previous.goal,moving:previous.moving,target:previous.target,zone:previous.zone,state:previous.state}};
            }else walk={excluded:!plan.back?'back edge is outside walkable floor':!plan.front?'front edge is occupied':'route unavailable'};
          }
          const result=World._dbgReviewProp(actor().id,'catalog-'+v.key,'use');result.walk=walk;
          const status=PropRemaster.status();
          result.key=v.key+(mirror?':mirror':'');result.placementConflicts=fixture.violations;result.assetFailures=status.failures;
          result.issues=[];
          if(result.footprint.join()!=result.canonical.join())result.issues.push('footprint mismatch');
          if(result.front&&result.back&&!result.route)result.issues.push('no route around prop');
          if(walk&&walk.arrived===false)result.issues.push('walk did not reach rear approach');
          if(result.interaction!=='none'&&!result.planned)result.issues.push('interaction planner failed');
          if(result.interaction==='seat'&&(!result.result.seated||result.result.usingProp!==result.id))result.issues.push('seat arrival mismatch');
          if(result.interaction==='bed'&&(!result.result.lying||result.result.usingProp!==result.id))result.issues.push('bed arrival mismatch');
          if(result.workstation&&result.anchor&&result.result.dir!==result.anchor.face)result.issues.push('workstation facing mismatch');
          if(result.side&&result.result.dir!==result.side.face)result.issues.push('profile sitter facing mismatch');
          if(status.failures.length)result.issues.push('asset load failure');
          receipt.cases.push(result);last='Checked '+receipt.cases.length+' placements · '+receipt.cases.filter(r=>r.issues.length).length+' with issues · '+result.key;publish();
          await pause(120);
        }
      }
    }
    page=0;await load();busy=false;last='Catalog complete: '+receipt.cases.length+' orientation/mirror cases, '+receipt.cases.filter(r=>r.issues.length).length+' with issues. Arrival is controlled; walking is reviewed separately.';publish();
  });
  button('Run sitting cycles',async()=>{
    if(busy)return;busy=true;receipt.sitting=[];page=0;publish();
    for(;page<pageSelect.options.length;page++)for(const mirror of [false,true]) {
      await load(mirror);
      for(const v of entries()) {
        if(mirror&&!PropSprites.canMirror(v.id))continue;
        const id='catalog-'+v.key,plan=World._dbgReviewProp(actor().id,id,'live');
        if(!['seat','bed'].includes(plan.interaction))continue;
        let state=null,elapsed=0;const began=performance.now();
        while(performance.now()-began<12000){await pause(60);state=World._dbgReviewProp(actor().id,id);elapsed=performance.now()-began;if(state.result.seated||state.result.lying)break;}
        const settled=!!(state.result.seated||state.result.lying),pose={...state.result};
        last='Reviewing '+v.key+(mirror?' mirrored':'')+' · '+(settled?'seated':'FAILED arrival');publish();await pause(500);
        const dest={x:plan.floorFront.x,y:plan.floorFront.y+2};
        const leaving=World._dbgReviewWalk(actor().id,dest.x,dest.y);let left=null;const departure=performance.now();
        do{await pause(60);left=World._dbgReviewProp(actor().id,id);}while(performance.now()-departure<8000&&Math.hypot(left.result.px-(dest.x*12+6),left.result.py-(dest.y*12+11))>1.1);
        const issues=[];if(!plan.planned||!settled)issues.push('sit arrival failed');
        if(pose.usingProp!==id)issues.push('wrong prop claim');
        const prop=fixture.doc.props.find(p=>p.id===id),expected=plan.side?.face||(prop.r?PropAnchor.frontOf(prop):null);
        if(expected&&plan.interaction==='seat'&&pose.dir!==expected)issues.push('seat facing mismatch');
        if(!leaving||left.result.seated||left.result.lying||left.result.seatKey)issues.push('seat release failed');
        if(Math.hypot(left.result.px-(dest.x*12+6),left.result.py-(dest.y*12+11))>1.1)issues.push('departure did not arrive');
        receipt.sitting.push({key:v.key,mirror,kind:plan.interaction,planned:plan.planned,elapsed:Math.round(elapsed),pose,left:left.result,issues});
        last='Sitting cycles: '+receipt.sitting.length+' · '+receipt.sitting.filter(c=>c.issues.length).length+' failures';publish();
      }
    }
    busy=false;publish();
  });
  button('Kepler layout',async()=>{if(busy)return;World.loadStation(WorldModel.deserialize(original));await pause(400);World.frameReviewRoom('');last='Kepler: 47 props, three rooms and transfer gallery';publish();});
  button('Large layout',async()=>{
    if(busy)return;const d=JSON.parse(JSON.stringify(original));d.rooms={};d.order=[];d.props=[];d.belts={};d.edges=[];
    for(let i=0;i<4;i++){const dx=(i%2)*62,dy=Math.floor(i/2)*48,prefix='copy'+i+'-';
      for(const id of original.order){const r=JSON.parse(JSON.stringify(original.rooms[id]));r.id=prefix+id;r.rects=r.rects.map(v=>({x1:v.x1+dx,x2:v.x2+dx,y1:v.y1+dy,y2:v.y2+dy}));d.rooms[r.id]=r;d.order.push(r.id);}
      for(const p of original.props){const q={...p,id:prefix+p.id,x:p.x+dx,y:p.y+dy};delete q.agentId;d.props.push(q);}
      for(const[k,v]of Object.entries(original.belts)){const[x,y]=k.split(',').map(Number);d.belts[(x+dx)+','+(y+dy)]=v;}
    }
    d.meta={...d.meta,spawnRoomId:d.order[0],trunkRoomId:d.order[0]};World.loadStation(WorldModel.deserialize(d));await pause(500);World.frameReviewRoom('');last='Large layout: '+d.props.length+' props, '+d.order.length+' room regions, '+Object.keys(d.belts).length+' belt tiles. Four separated Kepler modules.';publish();
  });
  button('Overview',()=>{World.frameReviewRoom('');});
  button('Doorway walk regression',async()=>{
    if(busy)return;busy=true;receipt.doorways=[];
    const station=WorldModel.create();
    station.placeHallway({rect:{x1:7,y1:-5,x2:8,y2:-1}});
    const g=station.projectGeometry(),root=station.doc().order[0];
    World.loadStation(station);await pause(500);World.frameReviewRoom(root);World.setCinecamIdle(86400000);
    const tile=(x,y)=>({x:x-g.origin.tx,y:y-g.origin.ty}),foot=t=>({x:t.x*12+6,y:t.y*12+11});
    for(let round=0;round<3;round++)for(const side of [3,12])for(const reverse of [false,true]){
      const a=tile(7,-2),b=tile(side,0),start=reverse?b:a,end=reverse?a:b,p=foot(start),dest=foot(end),aid=actor().id;
      World._dbgTeleport(aid,p.x,p.y);const planned=World._dbgReviewWalk(aid,end.x,end.y),began=performance.now();
      let samples=0,inWall=0,arrived=false;
      do{
        await pause(16);const body=actor();samples++;
        // Independent visual check against the known north wall shoulders,
        // not the pathfinder's own clearance predicate. Body snapshots round px.
        const wx=body.px/12+g.origin.tx,wy=body.py/12+g.origin.ty;
        if(wy>=0&&wy<9/12&&(wx<7||wx>9))inWall++;
        arrived=Math.hypot(body.px-dest.x,body.py-dest.y)<1.5;
      }while(!arrived&&performance.now()-began<15000);
      receipt.doorways.push({round,side,reverse,planned,arrived,inWall,samples,ms:Math.round(performance.now()-began)});
      last='Doorway walks: '+receipt.doorways.length+' / 12 · '+receipt.doorways.filter(c=>!c.arrived||c.inWall).length+' failures';publish();
    }
    busy=false;publish();
  });
  button('Close view',()=>{const d=World.stationDoc();World.frameReviewRoom(fixture&&d.rooms[fixture.roomId]?fixture.roomId:d.order[0]);});
  button('Inspect wall',async()=>{
    if(busy)return;const d=JSON.parse(JSON.stringify(World.stationDoc())),id=fixture&&d.rooms[fixture.roomId]?fixture.roomId:d.order[0];
    d.rooms[id].wallMat=wallReview.value;World.loadStation(WorldModel.deserialize(d));await pause(400);World.frameReviewRoom(id);World.setCinecamIdle(86400000);
    receipt.structure={material:wallReview.value,texturePack:IndustrialTextures.status(),room:id};last='Wall review: '+wallReview.value+' · '+receipt.structure.texturePack.assets.length+' textures loaded · '+receipt.structure.texturePack.failed.length+' failures';publish();
  });
  button('Test remaster recovery',async()=>{
    if(busy)return;busy=true;receipt.canvasRecovery=[];
    try {
      for(const mode of ['lod','lod','all','lod','detail']){
        await pause(500);const before=World._dbgCanvasLoss(),wiped=World._dbgLoseCanvases(mode),during=World._dbgCanvasLoss();
        const began=performance.now();let after;
        do{await pause(50);after=World._dbgCanvasLoss();}while(after.recoveries===before.recoveries&&performance.now()-began<5000);
        receipt.canvasRecovery.push({mode,wiped,detected:during.blank,recovered:after.recoveries>before.recoveries&&!after.blank,ms:Math.round(performance.now()-began)});
        last='Canvas recovery: '+receipt.canvasRecovery.length+' / 5';publish();
      }
      last=receipt.canvasRecovery.every(r=>r.recovered&&r.detected)?'PASS: all five canvas losses recovered':'FAIL: inspect canvas recovery receipt';
    } finally {busy=false;publish();}
  });
  button('Measure 2 minute soak',async()=>{
    if(busy)return;busy=true;receipt.soak=[];
    for(let i=0;i<6;i++){
      World._dbgReviewPerformance(true);last='Soak window '+(i+1)+' / 6 (20 seconds each)';publish();await pause(20000);
      const p=World._dbgReviewPerformance(false),times=p.samples.map(s=>s.ms).sort((a,b)=>a-b),gaps=p.samples.slice(1).map((s,j)=>s.t-p.samples[j].t).sort((a,b)=>a-b);
      const q=(a,f)=>+(a[Math.min(a.length-1,Math.floor(a.length*f))]||0).toFixed(2);
      receipt.soak.push({window:i+1,frames:p.samples.length,props:p.props,canvas:p.canvas,scale:p.scale,callbackP95:q(times,.95),intervalP95:q(gaps,.95),renderFaults:p.renderFaults,raster:PropRemaster.status(),renderer:World.renderStats()});
    }
    busy=false;last='Two-minute soak complete · '+receipt.soak.length+' measured windows';publish();
  });
  button('Measure 8 seconds',async()=>{
    if(busy)return;busy=true;last='Warming renderer for 2 seconds…';publish();await pause(2000);World._dbgReviewPerformance(true);last='Measuring actual World frame callbacks…';publish();await pause(8000);
    const p=World._dbgReviewPerformance(false),ms=p.samples.map(s=>s.ms).sort((a,b)=>a-b),gaps=p.samples.slice(1).map((s,i)=>s.t-p.samples[i].t).sort((a,b)=>a-b),q=(a,f)=>+(a[Math.min(a.length-1,Math.floor(a.length*f))]||0).toFixed(2);
    const r={viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,props:p.props,scale:+p.scale.toFixed(3),frames:p.samples.length,callbackMs:{p50:q(ms,.5),p95:q(ms,.95)},intervalMs:{p50:q(gaps,.5),p95:q(gaps,.95)},renderFaults:p.renderFaults,raster:PropRemaster.status().failures,renderer:World.renderStats(),canvas:p.canvas};receipt.performance.push(r);busy=false;last=JSON.stringify(r);publish();
  });
  for(let i=0;i<Math.ceil(reviewViews.length/6);i++){const o=document.createElement('option');o.value=String(i);o.textContent=capabilityReview?'Five capability props':'Room '+(i+1);pageSelect.append(o);}
  for(let n=0;n<150;n++){if(typeof World!=='undefined'&&World.stationDoc()&&actor())break;await pause(200);}
  original=JSON.parse(JSON.stringify(World.stationDoc()));await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);await load();
})().catch(e=>console.error('[remaster-audit]',e));
