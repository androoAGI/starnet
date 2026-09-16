'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createCanvas,loadImage,Image}=require('@napi-rs/canvas');
const Motion=require('../../frontend/app/authored-furniture-motion'),Configs=require('../../frontend/app/authored-furniture-config');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p),out=at('docs/station-remaster/authored-furniture');
const hash=p=>crypto.createHash('sha256').update(p).digest('hex');
const fit=(b,w,h)=>{const k=Math.min(b.width/w,b.height/h);return {x:b.x+(b.width-w*k)/2,y:b.y+b.height-h*k,width:w*k,height:h*k};};
async function sprites(){
  class FileImage extends Image {set src(src){super.src=fs.readFileSync(at('frontend/'+src));}get src(){return super.src;}}
  const env={console,Image:FileImage,document:{createElement:()=>createCanvas(1,1)},fetch:async()=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(at('frontend/assets/sprites/manifest.json')))}),
    DATA:{DEFAULT_SKIN:'station_minion',SKINS:{station_minion:{set:'station_minion',scale:.385}}}};
  vm.createContext(env);vm.runInContext(fs.readFileSync(at('frontend/js/sprite-load-plan.js'),'utf8'),env);
  vm.runInContext(fs.readFileSync(at('frontend/js/assets.js'),'utf8')+';globalThis.renderer=SPRITES;',env);await env.renderer.init();await env.renderer.ensureSkin('station_minion');return env.renderer;
}
(async()=>{
  const renderer=await sprites(),floor=await loadImage(at('frontend/assets/industrial/remaster/floors/plate.png'));
  const sheet=createCanvas(1280,870),g=sheet.getContext('2d');g.fillStyle='#10191a';g.fillRect(0,0,1280,870);g.fillStyle='#d3b775';g.font='22px sans-serif';g.fillText('STARNET · AUTHORED FURNITURE MOTION · 4 PX / WORLD PX',20,35);
  const receipts=[];
  for(const [col,id]of Configs.ids.entries()){
    const c=Configs.get(id),im=await loadImage(at('frontend/'+Configs.sourceRoot+c.image)),f=fit(c.bounds,im.width,im.height),box={...f,x:f.x+20,y:f.y+26};
    let reads=0,allocations=0;
    const make=(w,h)=>{allocations++;const cv=createCanvas(w,h),ctx=cv.getContext('2d'),read=ctx.getImageData.bind(ctx);ctx.getImageData=(...args)=>{reads++;return read(...args);};return cv;};
    if(!Motion.prepare(id,im,make,c))throw Error('Cannot prepare '+id);
    const render=state=>{const cv=createCanvas(300,256),ctx=cv.getContext('2d');ctx.scale(4,4);Motion.draw(ctx,id,box,state);return cv;};
    const idle=render({now:0}),work=render({now:c.period/4,work:true}),still=render({now:1000,work:true,still:true});
    const bytes=cv=>cv.getContext('2d').getImageData(0,0,300,256).data,pi=bytes(idle),pw=bytes(work),ps=bytes(still);
    let changed=0,frameChanges=0;
    for(let y=0;y<256;y++)for(let x=0;x<300;x++){
      const i=(y*300+x)*4,delta=pi[i]!==pw[i]||pi[i+1]!==pw[i+1]||pi[i+2]!==pw[i+2]||pi[i+3]!==pw[i+3];if(delta)changed++;
      const u=(x/4-box.x)/box.width,v=(y/4-box.y)/box.height;
      const fixed=v>.80||(id==='punchbag'?u>.51:u<.49);
      if(delta&&fixed)frameChanges++;
    }
    if(!changed||hash(pi)!==hash(ps)||frameChanges)throw Error('Furniture raster contract failed '+id+' changes='+changed+' frame='+frameChanges);
    const beforeReads=reads,beforeAllocations=allocations,perf=createCanvas(300,256).getContext('2d');
    for(let i=0;i<240;i++)Motion.draw(perf,id,box,{now:i*17,work:true});
    if(reads!==beforeReads||allocations!==beforeAllocations)throw Error('Per-frame allocation/readback '+id);
    for(let row=0;row<3;row++){
      const left=col*310+10,top=row*260+66;g.save();g.translate(left,top);g.scale(4,4);
      for(let y=0;y<5;y++)for(let x=0;x<6;x++)g.drawImage(floor,x*12,y*12,12,12);
      Motion.draw(g,id,box,{now:row===0?0:row===1?c.period/4:c.period*3/4,work:row>0});
      renderer.drawBody(g,{id:'furniture-cadet',skin:'station_minion',px:51,py:50,state:'idle',dir:'south'},0,{reducedMotion:true});g.restore();
      g.fillStyle='#c3bfae';g.font='15px sans-serif';g.fillText(id+' · '+['neutral','swing +','swing −'][row],left,top+251);
    }
    receipts.push({id,sourceSha256:c.sha256,fit:f,frameBounds:Motion.bounds(id,box),sourceReadbacks:reads,
      perFrameReadbacks:reads-beforeReads,perFrameCanvasAllocations:allocations-beforeAllocations,workChangedPixels:changed,stationaryFrameChangedPixels:frameChanges,
      neutralHash:hash(pi),reducedMotionHash:hash(ps),scope:'offline public-renderer fixture; no real activity claims'});
  }
  for(const [row,id]of ['benchpress','benchpress_r'].entries()){
    const spec=JSON.parse(fs.readFileSync(at('docs/station-remaster/batch03/crew/'+id+'.export.json'))),im=await loadImage(at('frontend/assets/industrial/batch03/crew/'+id+'.png')),f=fit(spec.bounds,im.width,im.height);
    g.save();g.translate(650,80+row*350);g.scale(4,4);for(let y=0;y<6;y++)for(let x=0;x<12;x++)g.drawImage(floor,x*12,y*12,12,12);
    g.drawImage(im,12+f.x,36+f.y,f.width,f.height);renderer.drawBody(g,{id:'bench-scale',skin:'station_minion',px:65,py:48,state:'idle',dir:'south'},0,{reducedMotion:true});g.restore();
    g.fillStyle='#c3bfae';g.font='16px sans-serif';g.fillText(id+' · static, matching original behavior',650,80+row*350+300);
  }
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'native-fitness-motion.png'),await sheet.encode('png'));fs.writeFileSync(path.join(out,'motion-receipt.json'),JSON.stringify({renderer:'SPRITES.drawBody, station_minion scale .385',cache:Motion.status(),props:receipts},null,2)+'\n');
  const chairs=['dinerchair','podchair','recliner','recliner_r','booth','booth-r1','booth-r3'];
  const seats=createCanvas(1440,650),sg=seats.getContext('2d'),anchors=[];sg.fillStyle='#10191a';sg.fillRect(0,0,1440,650);sg.fillStyle='#d3b775';sg.font='21px sans-serif';sg.fillText('NEW FURNITURE + CURRENT BODY ANCHORS · AUTHORED FOREGROUND · 4 PX / WORLD PX',20,34);
  for(const [i,id]of chairs.entries()){
    const spec=JSON.parse(fs.readFileSync(at('docs/station-remaster/batch03/crew/'+id+'.export.json'))),im=await loadImage(at('frontend/assets/industrial/batch03/crew/'+id+'.png')),f=fit(spec.bounds,im.width,im.height);
    const left=i%4*360+10,top=Math.floor(i/4)*300+60,propX=15,propY=24,regions=spec.authoredGeometry.regions;
    sg.save();sg.translate(left,top);sg.scale(4,4);for(let y=0;y<5;y++)for(let x=0;x<7;x++)sg.drawImage(floor,x*12,y*12,12,12);
    const world={...f,x:f.x+propX,y:f.y+propY};sg.drawImage(im,world.x,world.y,world.width,world.height);
    const booth=id.startsWith('booth'),side=id.startsWith('recliner'),w=spec.footprint.w,h=spec.footprint.h;
    const points=Array.from({length:booth?w:1},(_,n)=>({x:propX+(booth?n*12:0)+6+(side?(id.endsWith('_r')?2:-2):0),y:propY+h*12-(booth||side?2:1),face:side?(id.endsWith('_r')?'east':'west'):id.endsWith('-r1')?'west':id.endsWith('-r3')?'east':'south',lift:side?2:0}));
    for(const p of points)renderer.drawBody(sg,{id:'seat-cadet',skin:'station_minion',px:p.x,py:p.y,state:'idle',dir:p.face,sitting:true,seatLift:p.lift},0,{reducedMotion:true,skipGroundShadow:true});
    const key=booth?(id==='booth'?'backOcclusion':'nearArmOcclusion'):side?'nearArmOcclusion':id==='podchair'?'nearRimOcclusion':null;
    const poly=key&&regions[key]&&regions[key].cropNormalized;
    if(poly){sg.save();sg.beginPath();poly.forEach((p,j)=>{const x=world.x+p[0]*world.width,y=world.y+p[1]*world.height;j?sg.lineTo(x,y):sg.moveTo(x,y);});sg.closePath();sg.clip();sg.drawImage(im,world.x,world.y,world.width,world.height);sg.restore();}
    sg.restore();sg.fillStyle='#c3bfae';sg.font='16px sans-serif';sg.fillText(id+' · '+points.length+' inherited seat(s)',left,top+270);
    anchors.push({id,fit:f,inheritedBodyAnchors:points.map(p=>({...p,x:p.x-propX,y:p.y-propY})),authoredRegions:Object.fromEntries(Object.entries(regions).map(([k,v])=>[k,v.worldPixels])),fixture:'Actual SPRITES.drawBody. New foreground masks shown for inspection; not a production seat fix.'});
  }
  fs.writeFileSync(path.join(out,'native-seat-audit.png'),await seats.encode('png'));fs.writeFileSync(path.join(out,'seat-audit.json'),JSON.stringify(anchors,null,2)+'\n');
  console.log('PASS: 2 newly authored bags move; stationary frames unchanged; reduced motion exact; 240 frames each with zero readback/allocation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
