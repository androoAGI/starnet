
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const {createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'dev/.scratch-workspace/workstation-animation');
class AssetImage extends Image {set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
const document={documentElement:{dataset:{}},createElement:()=>createCanvas(1,1)};
const env={Image:AssetImage,document,URLSearchParams,location:{search:''},module:{exports:{}},console};
const rgba=cv=>cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
const cyanEnergy=d=>{let sum=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>200)sum+=Math.max(0,Math.min(d[i+1],d[i+2])-d[i]);return sum;};
(async()=>{
 vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/app/industrialtextures.js'),'utf8'),env);
 const pack=env.module.exports;await pack.ready;assert.ok(pack.enabled());
 const penv={module:{exports:{}},document,IndustrialTextures:pack,console};
 vm.runInNewContext(fs.readFileSync(path.join(root,'frontend/app/propsprites.js'),'utf8'),penv);
 const props=penv.module.exports;
 function draw(p,time,occupied,work=false,still=false){
  const cv=createCanvas(480,440),g=cv.getContext('2d');g.scale(6,6);props.setCtx(g);props.setNow(time);
  props.draw(p,work,{occupied,still,heat:work?.6:0,prog:null});return cv;
 }
 let views=0,alphaSamples=0;
 const sheet=createCanvas(1600,2690),sg=sheet.getContext('2d');
 sg.fillStyle='#080d10';sg.fillRect(0,0,sheet.width,sheet.height);
 sg.fillStyle='#d1c2a0';sg.font='22px monospace';sg.fillText('WORKSTATION / OCCUPANCY + PHOSPHOR',30,32);
 ['UNATTENDED','SEATED / 350 ms','SEATED / 1400 ms','REDUCED MOTION'].forEach((t,i)=>sg.fillText(t,30+i*390,66));
 for(const width of [2,3])for(const r of [0,1,2,3])for(const m of [false,true]){
  const p={t:'desk',x:2,y:3,w:r%2?1:width,h:r%2?width:1,r,m};
  // Warm outline cache before comparing frames.
  draw(p,0,false);
  const off=draw(p,0,false),off2=draw(p,1800,false,true),on=draw(p,350,true),on2=draw(p,1400,true);
  const frozen=draw(p,350,true,true,true),frozen2=draw(p,1400,true,true,true);
  const a=rgba(off),b=rgba(on),c=rgba(on2);
  assert.deepEqual(a,rgba(off2),'empty ignores live backend work and clock');
  assert.deepEqual(rgba(frozen),rgba(frozen2),'reduced motion retains a stable lit display');
  for(let i=3;i<a.length;i+=4){assert.equal(a[i],b[i],'ON never changes physical alpha');assert.equal(a[i],c[i],'animation never changes physical alpha');alphaSamples++;}
  if(r===2){assert.deepEqual(a,b,'rear furniture never invents visible screen');assert.deepEqual(b,c);}
  else{
   assert.ok(cyanEnergy(b)>cyanEnergy(a)*2,'visible glass darkens substantially off');
   assert.notDeepEqual(b,c,'occupied phosphor animates');
   // Pixels altered by the animation may only be within the screen-state change.
   let changed=0,outside=0;for(let i=0;i<a.length;i+=4)if(b[i]!==c[i]||b[i+1]!==c[i+1]||b[i+2]!==c[i+2]){
    changed++;if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))<2)outside++;
   }
   assert.ok(changed>0&&outside/changed<.03,'beam remains on authored screen pixels');
  }
  if(!m){
   const row=(width-2)*4+r,y=85+row*320;
   for(const [i,cv]of[off,on,on2,frozen].entries())sg.drawImage(cv,0,48,480,392,25+i*390,y,360,294);
   sg.fillStyle='#b2a68b';sg.font='14px monospace';sg.fillText(width+' tiles / '+['S','W','N','E'][r],25,y+308);
  }
  views++;
 }
 fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'screen-states.png'),sheet.toBuffer('image/png'));
 console.log(JSON.stringify({status:'PASS',views,alphaSamples,evidence:path.join(output,'screen-states.png')}));
})().catch(e=>{console.error(e);process.exitCode=1;});

