/* Real Canvas connection coverage. Shipped model/surface/bake code runs in an
   isolated blank Chromium page; no server, saved station or UI is mutated. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { findChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const source = ['frontend/js/util.js','frontend/app/worldmodel.js','frontend/app/worldsurface.js','frontend/app/stationbake.js']
  .map(path => readFileSync(new URL('../'+path, import.meta.url), 'utf8')).join('\n');
const freePort = () => new Promise((done,reject) => {
  const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const port=server.address().port;server.close(error=>error?reject(error):done(port));
  });
});
const stop = child => new Promise(done => {
  if(!child || child.exitCode!=null){done();return;}
  const timer=setTimeout(done,3000);child.once('exit',()=>{clearTimeout(timer);done();});
  try{child.kill('SIGKILL');}catch{clearTimeout(timer);done();}
});
function probe() {
  let checks=0;const failures=[],shots={};
  const check=(ok,name)=>{checks++;if(!ok)failures.push(name);};
  const R=(z,x1,y1,x2,y2)=>({z,x1,y1,x2,y2});
  const make=(rects,kinds={})=>{
    const doc=WorldModel.defaultDoc(1);doc.rooms={};doc.order=[];doc.props=[];doc.belts={};doc.edges=[];
    doc.meta.spawnRoomId=null;doc.meta.trunkRoomId=null;
    for(const r of rects){
      if(!doc.rooms[r.z]){doc.order.push(r.z);doc.rooms[r.z]={id:r.z,name:'',kind:kinds[r.z]||'hab',rects:[],
        floorStyle:'hull',floorMat:'alloy',wallStyle:'hull',wallMat:'ribbed',hullStyle:null,hullMat:null,floorPaint:{}};}
      const {z,...rect}=r;doc.rooms[z].rects.push(rect);
    }
    return WorldModel.create(doc).projectGeometry();
  };
  const pixel=(cv,x,y)=>cv.getContext('2d').getImageData(Math.floor(x),Math.floor(y),1,1).data;
  const occluderMask=b=>{
    const cv=document.createElement('canvas');cv.width=b.W;cv.height=b.H;const c=cv.getContext('2d');
    for(const d of b.doorOccluders||[])c.drawImage(d.image,d.x,d.y);return cv;
  };
  const cases=[];
  for(const w of [2,3,4])cases.push({name:'room-mouth-'+w,rects:[R('H',6,2,5+w,9),R('R',2,10,18,18)],kinds:{H:'corridor'},y:10});
  cases.push(
    {name:'hall-right-L',rects:[R('H',6,2,8,9),R('H',6,10,16,12)],kinds:{H:'corridor'},y:10},
    {name:'hall-left-L',rects:[R('H',6,2,8,9),R('H',2,10,8,12)],kinds:{H:'corridor'},y:10},
    {name:'hall-T',rects:[R('H',6,2,8,9),R('H',2,10,16,12)],kinds:{H:'corridor'},y:10},
    {name:'hall-cross',rects:[R('H',6,2,8,20),R('H',2,10,5,12),R('H',9,10,16,12)],kinds:{H:'corridor'},y:10},
    {name:'wide-partial',rects:[R('A',2,2,16,9),R('B',2,10,18,18)],y:10},
    {name:'room-from-west',rects:[R('H',2,6,9,8),R('R',10,2,18,14)],kinds:{H:'corridor'},y:6},
    {name:'room-from-east',rects:[R('R',2,2,10,14),R('H',11,6,18,8)],kinds:{H:'corridor'},y:6}
  );
  for(const f of cases){
    const g=make(f.rects,f.kinds),b=StationBake.bake(g),mask=occluderMask(b),y=f.y-g.origin.ty;
    const mouth=StationBake.connectionPlan(g).mouths.find(m=>m.y===y);
    check(!!mouth,f.name+' has physical mouth');if(!mouth)continue;
    const x0=mouth.x1*12,x1=(mouth.x2+1)*12,Y=y*12,top=Y-StationBake.WALL.up;
    for(let yy=top;yy<=Y+9;yy++){
      check(pixel(mask,(x0+x1)/2,yy)[3]===0,f.name+' clear centre at '+yy);
      check(pixel(b.baseCv,(x0+x1)/2,yy)[3]===255,f.name+' continuous deck at '+yy);
    }
    if(mouth.left!=null)for(let yy=top;yy<=Y+9;yy++)check(pixel(mask,x0,yy)[3]===255,f.name+' connected left return at '+yy);
    else check(pixel(mask,x0+1,top+6)[3]===0,f.name+' has no invented left jamb');
    if(mouth.right!=null)for(let yy=top;yy<=Y+9;yy++)check(pixel(mask,x1-1,yy)[3]===255,f.name+' connected right return at '+yy);
    else check(pixel(mask,x1-2,top+6)[3]===0,f.name+' has no invented right jamb');
    const view=document.createElement('canvas');view.width=b.W*2;view.height=b.H*2;const c=view.getContext('2d');
    c.imageSmoothingEnabled=false;c.fillStyle='#08090b';c.fillRect(0,0,view.width,view.height);c.drawImage(b.baseCv,0,0,view.width,view.height);
    shots[f.name]=view.toDataURL('image/png').split(',')[1];
  }
  const south=make([R('R',2,2,18,9),R('H',6,10,8,18)],{H:'corridor'});
  check(StationBake.bake(south).doorOccluders.length===0,'south opening retains the cutaway convention, with no invented standing wall');
  // A partial join has only one real jamb. Its opposite, uninterrupted side
  // wall must retain the same pixels as a single continuous room at that edge.
  const partial=make([R('A',2,2,16,9),R('B',2,10,18,18)]),solid=make([R('Z',2,2,18,18)]);
  const pb=StationBake.bake(partial),sb=StationBake.bake(solid),left=(2-partial.origin.tx)*12,joinY=(10-partial.origin.ty)*12;
  for(let yy=joinY-30;yy<joinY+10;yy++)for(let xx=left;xx<=left+4;xx++)
    check(String(pixel(pb.baseCv,xx,yy))===String(pixel(sb.baseCv,xx,yy)),'unwalled end preserves continuous side wall at '+xx+','+yy);
  // The curved corridor walls already used the room section. Its straight wall
  // contact rows must now match the same construction, with kind held irrelevant.
  const room=make([R('Z',2,2,14,14)]),hall=make([R('Z',2,2,14,14)],{Z:'corridor'});
  const rb=StationBake.bake(room),hb=StationBake.bake(hall),r=room.allRects[0],X=r.x1*12,Y=r.y1*12;
  for(let yy=Y+4;yy<=Y+10;yy++)for(let xx=X+24;xx<X+36;xx++)
    check(String(pixel(rb.baseCv,xx,yy))===String(pixel(hb.baseCv,xx,yy)),'room/hall north contact matches at '+xx+','+yy);
  for(let yy=Y+36;yy<Y+48;yy++)for(let xx=X;xx<=X+5;xx++)
    check(String(pixel(rb.baseCv,xx,yy))===String(pixel(hb.baseCv,xx,yy)),'room/hall side section matches at '+xx+','+yy);
  // Put a branch on the real 384px chunk boundary, using an unrelated anchor
  // footprint to retain the model's frame. Pixel comparison includes light masks.
  const g=make([R('A',0,0,6,6),R('H',29,18,31,28),R('B',24,29,39,31),R('H',27,32,33,42)],{H:'corridor',B:'corridor'});
  const mono=StationBake.bake(g),chunk=StationBake.bakeIncremental(g,null,null);
  for(const layer of ['base','light']){
    const cv=document.createElement('canvas');cv.width=g.W;cv.height=g.H;
    (layer==='base'?StationBake.drawBase:StationBake.drawLight)(cv.getContext('2d'),chunk,0,0);
    const a=cv.getContext('2d').getImageData(0,0,g.W,g.H).data,z=mono[layer+'Cv'].getContext('2d').getImageData(0,0,g.W,g.H).data;
    // Canvas gradients can round a distant fixture differently when cropped;
    // compare the light at the actual junction, including its raised crown.
    const minY=layer==='light'?384-40:0,maxY=layer==='light'?384+48:g.H;
    let different=0;for(let y=minY;y<maxY;y++)for(let x=0;x<g.W;x++)for(let c=0;c<4;c++){const i=(y*g.W+x)*4+c;if(a[i]!==z[i])different++;}
    check(different===0,layer+' junction chunk/monolithic parity: '+different+' channel differences');
  }
  return {checks,failures,shots};
}
let chrome,cdp,profile,failed=false;
try{
  const port=await freePort();profile=mkdtempSync(join(tmpdir(),'starnet-connection-render-'));
  chrome=spawn(findChrome(),['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--mute-audio',
    '--remote-debugging-port='+port,'--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true});
  cdp=await connectCDP(port);
  const result=await evalJS(cdp,source+'\n('+probe.toString()+')()');
  if(process.env.STARNET_JOIN_SHOTS){
    const dir=resolve(process.env.STARNET_JOIN_SHOTS);mkdirSync(dir,{recursive:true});
    for(const [name,data]of Object.entries(result.shots))writeFileSync(join(dir,name+'.png'),Buffer.from(data,'base64'));
  }
  assert.deepEqual(result.failures,[],result.failures.slice(0,12).join('\n'));
  console.log('stationbake.connections: '+result.checks+' real Canvas pixel assertions passed');
}catch(error){failed=true;console.error(error.stack||error);}
finally{
  try{cdp?.ws.close();}catch{}await stop(chrome);
  if(profile){
    const rel=relative(resolve(tmpdir()),resolve(profile));
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&rel.startsWith('starnet-connection-render-'),'cleanup stays inside unique test temp directory');
    for(let attempt=0;attempt<10;attempt++)try{rmSync(profile,{recursive:true,force:true});break;}catch(error){if(attempt===9)throw error;await sleep(200);}
  }
}
process.exit(failed?1:0);
