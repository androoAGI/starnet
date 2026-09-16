'use strict';
// Native Canvas proof of the authored-casing/native-layer seam. Fixture geometry
// is synthetic and labelled; this verifies compositing, not finished asset design.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const source=createCanvas(16,12),sg=source.getContext('2d');sg.fillStyle='#5a4632';sg.fillRect(4,2,8,8);
const sourceBytes=source.toBuffer('image/png');
const alpha=createCanvas(24,24),ag=alpha.getContext('2d');ag.fillStyle='#fff';ag.fillRect(6,6,12,12);
const maskBytes=alpha.toBuffer('image/png');
const good={image:'fixture.png',sourceWidth:16,sourceHeight:12,footprint:{w:2,h:1},
 bounds:{x:0,y:-12,width:24,height:24},mode:'native',nativeMask:'fixture-native.png'};
const manifest={version:1,props:{console:{views:{s:good}},rackV:{views:{s:{...good,image:'rackV.png'}}},
 broken:{views:{s:{...good,image:'missing.png'}}},wrong:{views:{s:{...good,sourceWidth:17}}}}};
let mode=true,readbacks=0,sourceLoads=0;
const lossListeners=[];
const document={createElement(){
 const cv=createCanvas(1,1),native=cv.getContext.bind(cv);
 cv.addEventListener=(name,fn)=>{if(name==='contextlost')lossListeners.push(fn);};
 cv.getContext=(...args)=>{
  const g=native(...args);if(!g.__counted){const read=g.getImageData.bind(g);g.getImageData=(...a)=>{readbacks++;return read(...a);};g.__counted=true;}
  return g;
 };return cv;
}};
class Asset extends Image{set src(url){
 sourceLoads++;if(url.endsWith('/missing.png')){queueMicrotask(()=>this.onerror(Error('missing')));return;}
 super.src=url.endsWith('-native.png')?maskBytes:sourceBytes;
}}
const env={module:{exports:{}},document,Image:Asset,URLSearchParams,location:{search:''},
 IndustrialTextures:{isRemaster:()=>mode},fetch:async()=>({ok:true,json:async()=>manifest})};
vm.runInNewContext(read('frontend/app/propremaster.js'),env);
(async()=>{
 const p=env.module.exports;assert.equal(p.enabled('console'),false);await p.ready;
 assert.equal(p.enabled('console'),true);assert.equal(p.enabled('console','e'),false);
 assert.equal(p.enabled('rackV'),true,'catalog case is preserved');
 assert.equal(p.enabled('broken'),false);assert.equal(p.enabled('wrong'),false);
 const loads=sourceLoads,reads=readbacks,cv=createCanvas(64,64),g=cv.getContext('2d');
 const pixel=(x,y)=>Array.from(g.getImageData(x,y,1,1).data);
 const draw=(color,empty=false)=>{g.clearRect(0,0,64,64);return p.draw(g,'console','s',20,24,24,12,{work:color!=='#050909'},ng=>{
  if(!empty){ng.fillStyle=color;ng.fillRect(26,18,12,12);}
 });};
 assert.equal(draw('#050909'),true);assert.deepEqual(pixel(22,14),[90,70,50,255]);assert.deepEqual(pixel(30,24),[5,9,9,255]);
 assert.equal(pixel(20,11)[3],0);assert.equal(pixel(20,36)[3],0);assert.equal(pixel(20,35)[3],255);
 const outside=pixel(22,14);
 draw('#41bbcc');assert.deepEqual(pixel(30,24),[65,187,204,255]);assert.deepEqual(pixel(22,14),outside);
 draw('#050909');assert.deepEqual(pixel(30,24),[5,9,9,255],'off removes previous lit screen');
 draw('#050909',true);assert.deepEqual(pixel(30,24),[0,0,0,0],'vacated native geometry stays transparent');
 assert.deepEqual(pixel(22,14),outside,'native erase never removes unmasked casing');
 for(let t=0;t<120;t++)draw(t%2?'#41bbcc':'#050909');
 assert.equal(readbacks,reads,'animation performs no getImageData');assert.equal(sourceLoads,loads,'frames do not decode new images');
 assert.equal(p.draw(g,'console','s',0,0,12,12,{},()=>{}),false,'custom box retains native geometry');
 mode=false;assert.equal(draw('#41bbcc'),false,'classic returns native fallback');
 assert.equal(p.status().failures.length,2,'one failed image and one bad dimension are isolated');
 // Identical mirrored bounds and layer transform: mirror exactly once at the caller.
 mode=true;g.clearRect(0,0,64,64);g.save();g.translate(64,0);g.scale(-1,1);
 p.draw(g,'console','s',20,24,24,12,{},ng=>{ng.fillStyle='#41bbcc';ng.fillRect(26,18,12,12);});g.restore();
 assert.deepEqual(pixel(64-30-1,24),[65,187,204,255]);
 for(const loss of lossListeners)loss();assert.equal(draw('#41bbcc'),false,'lost cached art returns native fallback');
 const result={status:'PASS',fixture:'synthetic native-layer compositor',sourceAlphaBounds:[8,8],worldBounds:[24,24],
 feetY:36,framesWithoutReadback:120,isolatedAssetFailures:2,classic:true,mirror:true,contextLossFallback:true};
 const out=path.join(root,'dev/.scratch-workspace/prop-native-masks');fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'compositor-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;});

