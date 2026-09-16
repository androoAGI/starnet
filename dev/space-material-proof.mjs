import { mkdirSync, writeFileSync } from 'node:fs';
import { launchChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';
import { waitUp, waitDevReady } from '../scripts/lib/seed.mjs';
const url='http://127.0.0.1:8985/', out=new URL('../.shell-proof/space/',import.meta.url);
mkdirSync(out,{recursive:true});
const {proc}=launchChrome({cdpPort:9386,profileDir:new URL('chrome/',out).pathname.replace(/^\/([A-Z]:)/,'$1')});
let cdp;
try {
 if(!await waitUp(url)) throw Error('seed server unavailable');
 cdp=await connectCDP(9386); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
 await cdp.send('Page.navigate',{url});
 if(!await waitDevReady(cdp,evalJS,{url})) throw Error('station not ready');
 const result=await evalJS(cdp,`(async()=>{
  await IndustrialTextures.ready;
  const status=IndustrialTextures.status(); if(!status.loaded||status.failed.length) throw Error(JSON.stringify(status));
  const defs=[['hull','thermal'],['hull','insulation'],['hull','heatsink'],['floor','flightdeck'],['floor','lunar'],['floor','maggrid'],['floor','habitat'],['wall','pressure'],['wall','radiator'],['wall','utility'],['wall','acoustic']].map(([axis,id])=>[axis,id,WorldModel[axis==='hull'?'HULL_MATERIALS':axis==='floor'?'FLOOR_MATERIALS':'WALL_MATERIALS'][id].suggest]);
  const cv=document.createElement('canvas'); cv.width=1000; cv.height=defs.length*150;
  const g=cv.getContext('2d');g.fillStyle='#10171e';g.fillRect(0,0,cv.width,cv.height);
  const samples=[];
  for(const [i,[axis,id,hue]] of defs.entries()) {
   const c=document.createElement('canvas');c.width=240;c.height=96;const p=c.getContext('2d');
   const base=WorldModel.FLOOR_STYLES[hue].base;
   if(axis==='hull') StationBake.sampleHull(p,id,base,20,96,12);
   else if(axis==='floor') StationBake.sampleMaterial(p,id,base,20,8,12);
   else StationBake.sampleWall(p,id,base,20,96,12);
   const d=p.getImageData(0,0,240,96).data;let sum=0,lit=0;
   for(let k=0;k<d.length;k+=4){sum+=d[k]+d[k+1]+d[k+2];if(d[k+3])lit++;}
   if(!sum||!lit)throw Error('empty '+id);samples.push({axis,id,hue,sum,lit});
   g.fillStyle='#dbe4e8';g.font='16px monospace';g.fillText(axis.toUpperCase()+' / '+id,12,i*150+24);g.drawImage(c,240,i*150+8,720,126);
  }
  if(new Set(samples.map(s=>s.sum)).size!==11)throw Error('duplicate materials');
  // Read real browser pixels: each floor repeats at eight world tiles, including negative coordinates.
  const floorParity=[];
  for(const id of ['flightdeck','lunar','maggrid','habitat']){
   const render=(x,y)=>{const c=document.createElement('canvas');c.width=c.height=36;const p=c.getContext('2d');WorldSurface.paintFloorTile(p,id,'#3a3b41',0,0,36,x,y);return Array.from(p.getImageData(0,0,36,36).data).join(',');};
   if(render(-1,-2)!==render(7,6))throw Error('world phase '+id);floorParity.push(id);
  }
  const wallParity=[];
  for(const id of ['pressure','radiator','utility','acoustic']){
   const c=document.createElement('canvas');c.width=48;c.height=30;const p=c.getContext('2d');
   for(let x=0;x<4;x++)IndustrialTextures.wall(p,x*12,0,12,30,x,id,'#3a3b41');
   const a=p.getImageData(0,0,48,30).data,b=IndustrialTextures.wallStrip(30,id,'#3a3b41').d;
   let error=0;for(let k=0;k<a.length;k++)error=Math.max(error,Math.abs(a[k]-b[k]));
   if(error>2)throw Error('wall face / strip mismatch '+id+' '+error);wallParity.push({id,error});
  }
  const doc=WorldModel.defaultDoc();doc.rooms={};doc.order=[];doc.props=[];doc.belts={};doc.edges=[];doc.meta.spawnRoomId=null;
  const st=WorldModel.create(doc);
  for(let i=0;i<4;i++){
   const x=(i%2)*23,y=Math.floor(i/2)*22;
   const room=st.addRoom({kind:'hab',rects:[{x1:x,y1:y,x2:x+18,y2:y+12}]});if(!room.ok)throw Error(JSON.stringify(room));
   const floor=defs[3+i],wall=defs[7+i],shell=defs[i%3];
   for(const r of [st.setDeck(room.id,{mat:floor[1],style:floor[2]}),st.setWalls(room.id,{mat:wall[1],style:wall[2]}),st.setHull(room.id,{mat:shell[1],style:shell[2]})])if(!r.ok)throw Error(JSON.stringify(r));
  }
  const bake=StationBake.bake(st.projectGeometry());
  const scene=document.createElement('canvas');scene.width=bake.W*2;scene.height=bake.H*2;const sg=scene.getContext('2d');sg.fillStyle='#080d15';sg.fillRect(0,0,scene.width,scene.height);sg.scale(2,2);StationBake.drawBase(sg,bake,0,0);StationBake.drawLight(sg,bake,0,0);
  return {status,samples,floorParity,wallParity,roomCount:st.doc().order.length,swatches:cv.toDataURL().split(',')[1],scene:scene.toDataURL().split(',')[1]};
 })()`);
 for(const key of ['swatches','scene']){writeFileSync(new URL(key+'.png',out),Buffer.from(result[key],'base64'));delete result[key];}
 // Prove the real material picker commits every addition to a seeded room, then undo each change.
 await evalJS(cdp,`document.querySelector('#bb-build').click()`);await sleep(400);
 await evalJS(cdp,`document.querySelector('#refit-guide-go')?.click();document.querySelector('button[data-tool="paint"]').click()`);
 const choices=[['hull','hull','thermal','hullMatOfRoom'],['hull','hull','insulation','hullMatOfRoom'],['hull','hull','heatsink','hullMatOfRoom'],['floor','floor','flightdeck','matOfRoom'],['floor','floor','lunar','matOfRoom'],['floor','floor','maggrid','matOfRoom'],['floor','floor','habitat','matOfRoom'],['walls','wall','pressure','wallMatOfRoom'],['walls','wall','radiator','wallMatOfRoom'],['walls','wall','utility','wallMatOfRoom'],['walls','wall','acoustic','wallMatOfRoom']];
 result.ui=[];
 for(const [target,axis,id,method] of choices){
  const point=await evalJS(cdp,`(()=>{document.querySelector('button[data-target="${target}"]').click();const button=document.querySelector('button[data-surface="${axis}"][data-mat="${id}"]');if(!button)throw Error('missing ${id}');button.click();const st=Build.__test__.station(),doc=st.doc(),room=doc.rooms[doc.order[0]],r=room.rects[0];const e=Build.__test__._tileEvent([Math.floor((r.x1+r.x2)/2),Math.floor((r.y1+r.y2)/2)]);return {x:e.clientX,y:e.clientY,id:room.id};})()`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});await sleep(150);
  const receipt=await evalJS(cdp,`(()=>{const st=Build.__test__.station(),mat=st.${method}(${JSON.stringify(point.id)}),layers=Build.__test__.degradedLayers();if(mat!=='${id}'||layers.length)throw Error(JSON.stringify({mat,layers}));st.undo();return {id:mat,layers};})()`);
  result.ui.push(receipt);
 }
 writeFileSync(new URL('receipt.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{cdp?.ws.close();proc.kill();}
process.exit(0);
