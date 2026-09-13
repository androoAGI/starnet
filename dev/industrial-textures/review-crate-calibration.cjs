'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createCanvas,Image,loadImage}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'dev/.scratch-workspace/crate-calibration');
const src=p=>fs.readFileSync(path.join(root,p),'utf8');
const document={documentElement:{dataset:{}},createElement:()=>createCanvas(1,1)};
const window={addEventListener(){},matchMedia:()=>({matches:false})};
const U=new Function('window','document',src('frontend/js/util.js')+';return U;')(window,document);
class Asset extends Image{set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
async function load(review){
 const env={document,Image:Asset,URLSearchParams,location:{search:review?'?propReview=crate':''},module:{exports:{}}};
 vm.runInNewContext(src('frontend/app/industrialtextures.js'),env);const pack=env.module.exports;await pack.ready;assert.ok(pack.enabled());
 const p={document,U,IndustrialTextures:pack,module:{exports:{}}};vm.runInNewContext(src('frontend/app/propsprites.js'),p);return {pack,props:p.module.exports};
}
(async()=>{
 const before=await load(false),after=await load(true),body=await loadImage(fs.readFileSync(path.join(root,'frontend/assets/sprites/station_minion/rot_south.png')));
 const bc=createCanvas(body.width,body.height),bg=bc.getContext('2d');bg.drawImage(body,0,0);const bd=bg.getImageData(0,0,bc.width,bc.height).data;let foot=0;
 for(let i=3;i<bd.length;i+=4)if(bd[i]>50)foot=Math.max(foot,Math.floor((i/4)/bc.width)+1);
 const cv=createCanvas(1024,510),g=cv.getContext('2d');g.fillStyle='#101516';g.fillRect(0,0,cv.width,cv.height);
 g.font='18px sans-serif';g.fillStyle='#d0c6ae';g.fillText('CRATE / original proportions, new station materials',24,32);
 g.font='13px sans-serif';g.fillStyle='#989e97';g.fillText('Both panels use identical world scale. Approved workstation and unchanged white agent are the reference.',24,58);
 for(const [index,{pack,props}]of[before,after].entries()){
  const X=24+index*502;g.fillStyle='#c5bdad';g.font='15px sans-serif';g.fillText(index?'NEW CRATE / REVIEW':'PREVIOUS CRATE',X,96);
  g.save();g.translate(X,110);g.scale(2.8,2.8);
  for(let y=0;y<9;y++)for(let x=0;x<14;x++)pack.floor(g,x*12,y*12,12,x,y,'plate');
  props.setCtx(g);props.setNow(0);props.draw({t:'crate',x:1,y:4,w:2,h:1},false);props.draw({t:'desk',x:5,y:4,w:3,h:1},false,{occupied:false,still:true});
  g.imageSmoothingEnabled=true;g.drawImage(body,123-body.width*.385/2,60-foot*.385,body.width*.385,body.height*.385);
  g.strokeStyle='rgba(175,155,107,.45)';g.lineWidth=.3;g.beginPath();g.moveTo(8,60);g.lineTo(140,60);g.stroke();g.restore();
  g.fillStyle='#b8b3a8';g.font='12px sans-serif';g.fillText('CRATE',X+38,444);g.fillText('APPROVED DESK',X+160,444);g.fillText('AGENT',X+322,444);
 }
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'crate-scale-comparison.png'),cv.toBuffer('image/png'));
 // Native final image footprint, without UI scale or room lighting.
 const native=createCanvas(96,96),n=native.getContext('2d');after.props.setCtx(n);after.props.draw({t:'crate',x:3,y:3,w:2,h:1},false);
 const pixels=n.getImageData(0,0,96,96).data;let l=96,t=96,r=-1,b=-1,count=0;
 for(let y=0;y<96;y++)for(let x=0;x<96;x++)if(pixels[(y*96+x)*4+3]>160){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);count++;}
 assert.ok(r-l+1<=26&&b-t+1<=22);assert.equal(b,47);assert.ok(count>350);
 const spec=after.props.spec('crate');assert.equal(spec.w,2);assert.equal(spec.h,1);assert.ok(spec.blocks);assert.equal(after.props.lightOf({t:'crate',x:3,y:3,w:2,h:1},false,true),null);
 const result={status:'PASS',bodyPixels:[r-l+1,b-t+1],groundEdge:b+1,expectedGroundEdge:48,footprint:[spec.w,spec.h],aspectPreserved:true,scope:'One candidate crate; artwork remains review-only. Wider prop batch not adopted.'};
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;});
