'use strict';
// Real artwork and real public renderer. Activity here is a labelled test fixture.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
let readbacks=0;
const losses=[];
const document={documentElement:{dataset:{}},createElement(){
 const cv=createCanvas(1,1),get=cv.getContext.bind(cv);
 cv.addEventListener=(name,fn)=>{if(name==='contextlost')losses.push(fn);};
 cv.getContext=(...args)=>{const g=get(...args);if(!g.__counted){const read=g.getImageData.bind(g);g.getImageData=(...args)=>{readbacks++;return read(...args);};g.__counted=true;}return g;};
 return cv;
}};
class Asset extends Image{set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
const window={addEventListener(){},matchMedia:()=>({matches:false})};
const U=new Function('window','document',read('frontend/js/util.js')+';return U;')(window,document);
function load(file,extra){const env={document,window,Image:Asset,URLSearchParams,location:{search:''},module:{exports:{}},...extra};vm.runInNewContext(read(file),env);return env.module.exports;}
const rgba=cv=>cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
const cyan=d=>{let n=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>200)n+=Math.max(0,Math.min(d[i+1],d[i+2])-d[i]);return n;};
(async()=>{
 const industrial=load('frontend/app/industrialtextures.js');await industrial.ready;
 const art=load('frontend/app/propremaster.js',{IndustrialTextures:industrial,fetch:async url=>({ok:true,json:async()=>JSON.parse(read('frontend/'+url))})});await art.ready;
 assert.equal(art.status().failures.length,0,JSON.stringify(art.status()));
 const props=load('frontend/app/propsprites.js',{U,IndustrialTextures:industrial,PropRemaster:art});
 const sheet=createCanvas(1280,560),sg=sheet.getContext('2d');sg.fillStyle='#0a1012';sg.fillRect(0,0,1280,560);
 sg.fillStyle='#c8b88e';sg.font='22px monospace';sg.fillText('NEW CONSOLE / SAME PHYSICAL SCALE',25,35);
 const p={t:'console',x:2,y:3,w:2,h:1};
 function draw(t,occupied,work=false,still=false,mirror=false){
  const cv=createCanvas(320,270),g=cv.getContext('2d');g.scale(5,5);props.setCtx(g);props.setNow(t);
  props.draw({...p,m:mirror},work,{occupied,still,heat:0,prog:null});return cv;
 }
 draw(0,false); // Warm the shared outline cache.
 const off=draw(0,false),offBusy=draw(1200,false,true),on=draw(1050,true),on2=draw(1750,true),frozen=draw(1050,true,true,true),frozen2=draw(1750,true,true,true);
 const a=rgba(off),b=rgba(on),c=rgba(on2);
 assert.deepEqual(a,rgba(offBusy),'unattended screen ignores backend work');
 assert.deepEqual(rgba(frozen),rgba(frozen2),'reduced motion is stable');
 assert.ok(cyan(b)>cyan(a)*2,'authored display powers on');assert.notDeepEqual(b,c,'new phosphor animates');
 let moving=0,outside=0;
 for(let i=0;i<a.length;i+=4){
  assert.equal(a[i+3],b[i+3],'power preserves shape alpha');assert.equal(a[i+3],c[i+3],'motion preserves shape alpha');
  if(b[i]!==c[i]||b[i+1]!==c[i+1]||b[i+2]!==c[i+2]){moving++;if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))<2)outside++;}
 }
 assert.ok(moving>0&&outside/moving<.03,'motion stays on the newly authored glass');
 const g=createCanvas(100,100).getContext('2d'),reads=readbacks;
 for(let now=0;now<6000;now+=50)assert.equal(art.draw(g,'console','s',24,36,24,12,{now,occupied:true},()=>{throw Error('Original sprite was drawn');}),true);
 assert.equal(readbacks,reads,'animated frames never read pixels');
 assert.equal(art.draw(g,'console','s',24,36,12,12,{},()=>{}),false,'custom footprint keeps honest native fallback');
 assert.equal(props.lightOf(p,true,true,{occupied:false}),null,'unoccupied glass has no green legacy glow');
 const lit=props.lightOf(p,false,true,{occupied:true});assert.ok(lit&&lit.c[2]>lit.c[0]*2,'seated idle glass emits cyan');
 const mirrored=props.lightOf({...p,m:true},false,true,{occupied:true});assert.ok(Math.abs(mirrored.x+lit.x-(p.x*24+p.w*12))<.001,'light mirrors with art');
 assert.equal(art.emitter('console','s',12,12),null,'custom footprint cannot use authored emitter');
 const manifest=JSON.parse(read('frontend/assets/industrial/props-v3/manifest.json'));
 for(const [id,prop]of Object.entries(manifest.props))for(const [view,v]of Object.entries(prop.views)){
  const render=(occupied,now,extra={})=>{const cv=createCanvas(320,270),cg=cv.getContext('2d');cg.scale(4,4);
   assert.equal(art.draw(cg,id,view,24,36,v.footprint.w*12,v.footprint.h*12,{occupied,scanning:occupied,work:occupied,fired:occupied,now,...extra},()=>{throw Error('Old pixels in '+id);}),true);
   return rgba(cv);
  };
  const idle=render(false,0),active=render(true,1050),later=render(true,1750);
  for(let i=3;i<idle.length;i+=4)if(v.mode!=='steam'||Math.floor(i/4/320)>=(36+v.bounds.y+v.bounds.height-2)*4){assert.equal(idle[i],active[i],id+' power keeps contact/silhouette');assert.equal(idle[i],later[i],id+' motion keeps contact/silhouette');}
  if(v.mode==='screen'){assert.ok(cyan(active)>cyan(idle)*2,id+' glass powers on');assert.notDeepEqual(active,later,id+' glass animates');}
  else if(['water','scanner','steam','pulse','pool'].includes(v.mode)){
   assert.notDeepEqual(active,later,id+' has newly authored motion');
   if(v.motion.trigger==='fired'){
    assert.deepEqual(render(false,100,{work:true}),render(false,2300,{work:true}),id+' room work cannot invent a verification result');
    assert.notDeepEqual(render(true,100,{bad:true}),render(true,100,{bad:false}),id+' failure has distinct result colour');
    assert.notDeepEqual(render(true,100,{bad:true,still:true}),render(false,100,{still:true}),id+' reduced motion retains truthful failure status');
   }
   assert.deepEqual(render(true,100,{still:true}),render(true,2300,{still:true}),id+' obeys reduced motion');
   if(v.mode==='scanner')assert.deepEqual(render(false,100,{work:true}),render(false,2300,{work:true}),'unrelated work cannot scan an empty conveyor');
   if(v.mode==='water'){
    assert.deepEqual(render(false,1050),active,'water is independent of occupancy');
    assert.equal(art.emitter(id),null,'water is not a workstation display');
   }
   if(v.mode==='pool'||v.motion.trigger==='work')assert.deepEqual(render(false,100),render(false,2300),id+' does not invent use');
  }else {assert.deepEqual(idle,active,id+' static appearance');assert.deepEqual(active,later,id+' has no invented motion');}
  const warmReads=readbacks;
  for(let now=0;now<6000;now+=50)art.draw(g,id,view,24,36,v.footprint.w*12,v.footprint.h*12,{now,occupied:true,scanning:true,work:true},()=>{throw Error('old pixels');});
  assert.equal(readbacks,warmReads,id+' frames never read pixels');
 }
 // The real public event-to-render path must preserve instance scope and failure.
 if(manifest.props.workbench){
  const wb=(id,now)=>{const cv=createCanvas(320,270),cg=cv.getContext('2d');cg.scale(4,4);props.setCtx(cg);props.setNow(now);props.draw({id,t:'workbench',x:2,y:3,w:2,h:1},false,{still:true});return rgba(cv);};
  const idleA=wb('verify-a',10000),idleB=wb('verify-b',10000);
  props.pulseWorkbench(true,'verify-a');const success=wb('verify-a',10100);
  assert.notDeepEqual(success,idleA,'real verification event lights the new workbench');
  assert.deepEqual(wb('verify-b',10100),idleB,'verification event stays on its own instance');
  props.pulseWorkbench(false,'verify-a');const failure=wb('verify-a',10200);
  assert.notDeepEqual(failure,success,'failed verification keeps distinct new-art status');
 }
 [off,on,on2,frozen].forEach((cv,i)=>{sg.drawImage(cv,i*320,65);sg.fillStyle='#b6b5a6';sg.font='14px monospace';sg.fillText(['UNATTENDED','OCCUPIED / 1050 ms','OCCUPIED / 1750 ms','REDUCED MOTION'][i],i*320+15,350);});
 // Same world scale, no per-object enlargement. This strip catches accidental
 // micro-sprites and furniture-height drift before the live browser check.
 sg.save();sg.translate(20,370);sg.scale(4,4);props.setCtx(sg);props.setNow(1050);
 for(let y=0;y<3;y++)for(let x=0;x<25;x++)industrial.floor(sg,x*12,y*12,12,x,y,'plate');
 for(const f of [{t:'console',x:1,y:2,w:2,h:1},{t:'desk',x:6,y:2,w:3,h:1},{t:'crate',x:12,y:2,w:2,h:1}])props.draw(f,false,{occupied:true,still:true});sg.restore();
 const output=path.join(root,'dev/.scratch-workspace/props-v3');fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'console-states.png'),sheet.toBuffer('image/png'));
 // Review contact sheets use the public game painter at one fixed scale. They
 // are labelled fixture renders, not saved-station screenshots or backend work.
 const cadet=new Image();cadet.src=fs.readFileSync(path.join(root,'frontend/assets/sprites/station_minion/rot_south.png'));
 const measure=createCanvas(cadet.width,cadet.height);measure.getContext('2d').drawImage(cadet,0,0);const md=rgba(measure);let foot=0;
 for(let i=3;i<md.length;i+=4)if(md[i]>50)foot=Math.max(foot,Math.floor(i/4/cadet.width)+1);
 const ids=Object.keys(manifest.props);
 for(let page=0;page<Math.ceil(ids.length/20);page++){
   const cv=createCanvas(1344,1240),cg=cv.getContext('2d');cg.fillStyle='#0b1214';cg.fillRect(0,0,cv.width,cv.height);cg.fillStyle='#c0b69a';cg.font='16px monospace';cg.fillText('STARNET · SAME WORLD SCALE · AUTHORING PREVIEW',16,25);
   for(const [index,id]of ids.slice(page*20,page*20+20).entries()){
     const col=index%4,row=Math.floor(index/4),spec=props.spec(id),x=col*336,y=40+row*240;cg.save();cg.translate(x+10,y+8);cg.scale(2.55,2.55);
     for(let fy=0;fy<7;fy++)for(let fx=0;fx<10;fx++)industrial.floor(cg,fx*12,fy*12,12,fx,fy,'plate');
     props.setCtx(cg);props.setNow(1750);const mounted=spec.mount==='surface'||spec.stack;
     if(mounted)props.draw({t:'lowtable',x:1,y:5,w:3,h:1},false,{still:true});
     props.draw({t:id,id:'review-'+id,x:1,y:6-spec.h,w:spec.w,h:spec.h,...(mounted?{mount:'surface'}:{})},true,{occupied:true,scanning:true});
     cg.imageSmoothingEnabled=true;cg.drawImage(cadet,110-cadet.width*.385/2,72-foot*.385,cadet.width*.385,cadet.height*.385);cg.restore();
     cg.fillStyle='#c0b69a';cg.font='14px monospace';cg.fillText(id,x+12,y+230);
   }
   fs.writeFileSync(path.join(output,'contact-'+(page+1)+'.png'),cv.toBuffer('image/png'));
 }
 for(const loss of losses)loss();assert.equal(art.draw(g,'console','s',24,36,24,12,{},()=>{}),false,'lost art returns fallback');
 const result={status:'PASS',newSpriteOwnsWholeBody:true,oldSpriteCallbackCalls:0,occupancy:true,reducedMotion:true,physicalContactStable:true,alphaStableExceptSteam:true,consoleScreenOnlyMotion:true,framesWithoutReadbackPerView:120,cyanLight:true,customFootprintFallback:true,contextLossFallback:true,views:art.status().views};
 fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;});
