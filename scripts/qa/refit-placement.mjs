// Isolated seeded-app proof: node scripts/qa/refit-placement.mjs <url> <output-dir>
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchChrome, connectCDP, evalJS, sleep } from '../lib/cdp.mjs';

const [url, output] = process.argv.slice(2);
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname));
const out = path.resolve(output); fs.mkdirSync(out, {recursive:true});
const {proc} = launchChrome({cdpPort:9396, profileDir:path.join(out,'chrome')});
const c = await connectCDP(9396);
try {
  await c.send('Page.navigate',{url});
  let ready=false;
  for(let i=0;i<100;i++){
    ready=await evalJS(c,"typeof Build!=='undefined' && !!Build.__test__ && World.bodies().length>0").catch(()=>false);
    if(ready)break; await sleep(500);
  }
  assert.ok(ready,'seed reached the real world');
  await evalJS(c,'Promise.all([IndustrialTextures.ready,PropRemaster.ready]).then(()=>true)');
  // Keep the original seeded save separate; exercise a copy using the real model.
  await evalJS(c,`(()=>{
    const st=WorldModel.deserialize(Build.__test__.station().doc());
    World.stop();World.loadStation(st);World.rebake();
    Build.init({getStation:()=>st,persist:()=>{},world:World,agents:()=>App.agents()});
    Build.open();return true;
  })()`);
  await sleep(1000);
  const result=await evalJS(c,`(async()=>{
    const st=Build.__test__.station(), paint=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
    const prime=Build.__test__.placeCapProp('plant');assert(prime.ok,'prime plant tool');st.undo();await paint();
    const cv=document.querySelector('.refit-overlay canvas.refit-canvas')||document.querySelector('#refit-canvas');
    assert(cv,'refit canvas exists');
    const bake=StationBake.bakeIncremental,bakes=[];
    StationBake.bakeIncremental=function(...args){const t=performance.now(),r=bake(...args);bakes.push(performance.now()-t);return r};
    const spot=(t='plant',ignore)=>{
      const spec=PropSprites.spec(t);
      for(const rm of st.rooms())for(const rect of rm.rects)for(let y=rect.y1;y<=rect.y2;y++)for(let x=rect.x1;x<=rect.x2;x++){
        const e=Build.__test__._tileEvent([x,y]);
        if(e.clientX<320||e.clientX>innerWidth-20||e.clientY<90||e.clientY>innerHeight-100)continue;
        if(!st.propAt(x,y)&&st.canPlaceProp(t,x,y,spec.w,spec.h,ignore).ok)return [x,y];
      }
      throw Error('no visible placement tile');
    };
    const dispatch=(type,tile)=>cv.dispatchEvent(new PointerEvent(type,{...Build.__test__._tileEvent(tile),bubbles:true}));
    const placements=[];let last;
    for(let i=0;i<5;i++){
      const tile=spot(),before=st.props().length,t=performance.now();
      dispatch('pointermove',tile);await paint();
      const ghost=Build.__test__.ghostRects();assert(ghost&&ghost[0].x1===tile[0]&&ghost[0].y1===tile[1],'ghost follows cursor');
      const click=performance.now();dispatch('pointerdown',tile);dispatch('pointerup',tile);
      await paint();
      assert(st.props().length===before+1,'one click adds exactly one prop');
      last=st.props().at(-1);assert(last.x===tile[0]&&last.y===tile[1],'placement matches ghost');
      placements.push({clickToTwoFramesMs:performance.now()-click,cursorAndClickMs:performance.now()-t});
    }
    assert(bakes.length===0,'ordinary placements must not bake environment');
    const dest=spot();assert(st.moveProp(last.id,dest[0]-last.x,dest[1]-last.y).ok,'move');
    assert(st.rotateProp(last.id,1).ok,'rotate');assert(st.mirrorProp(last.id).ok,'mirror');await paint();
    assert(bakes.length===0,'move/rotate/mirror reuse environment');
    const geometry=st.projectGeometry(),local=geometry.props.find(p=>p.id===last.id);
    assert(local.x+geometry.origin.tx===last.x,'geometry carries moved prop');
    assert(geometry.blockedTiles.has((last.x-geometry.origin.tx)+','+(last.y-geometry.origin.ty))===(last.block!==false),'collision respects prop blocking flag');
    const functional=Build.__test__.placeCapProp('workbench');assert(functional.ok,'functional equipment places');await paint();
    assert(bakes.length===0,'functional placement reuses environment too');
    const fg=st.projectGeometry(),fp=fg.props.at(-1);
    assert(fg.blockedTiles.has(fp.x+','+fp.y),'functional equipment blocks navigation');
    const saved=st.serialize(),restored=WorldModel.deserialize(saved);
    assert(JSON.stringify(restored.props())===JSON.stringify(st.props()),'save round-trip retains placements and facing');
    const oldBakes=bakes.length;st.undo();await paint();assert(bakes.length>oldBakes,'undo invalidates');
    const undoBakes=bakes.length;st.redo();await paint();assert(bakes.length>undoBakes,'redo invalidates');
    const room=st.rooms()[0],style=Object.keys(WorldModel.FLOOR_STYLES).find(s=>s!==room.floorStyle);
    const floorBakes=bakes.length;assert(st.setFloor(room.id,style).ok,'floor edit');
    const next=spot();assert(st.addProp({t:'plant',x:next[0],y:next[1],w:1,h:1}).ok,'same-frame prop edit');
    await paint();assert(bakes.length>floorBakes,'prop edit cannot mask pending floor repaint');
    const airSpot=spot('airlock'),as=PropSprites.spec('airlock'),airBakes=bakes.length;
    assert(st.addProp({t:'airlock',door:'closed',x:airSpot[0],y:airSpot[1],w:as.w,h:as.h}).ok,'airlock place');
    await paint();assert(bakes.length>airBakes,'airlock repaints environment');
    const degraded=Build.__test__.degradedLayers();assert(!degraded.length,'no degraded rendering');
    const sample=[...cv.getContext('2d').getImageData(cv.width>>1,cv.height>>1,1,1).data];
    assert(sample[3]>0,'canvas has painted pixels');
    Build.close();await paint();Build.open();await paint();
    assert(document.querySelector('.refit-overlay').dataset.renderState==='ready','reopen paints');
    return {pass:true,placements,bakes,degraded,sample,props:st.props().length,
      checks:['pointer preview and click','move rotate mirror','collision','serialization','undo redo','mixed floor and prop','airlock','reopen'],
      scope:'Isolated seeded Chromium; software rendering. No installed WebView or customer recovery claim.'};
  })()`);
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{c.ws.close();proc.kill();}
process.exit();
