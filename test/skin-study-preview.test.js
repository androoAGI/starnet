'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),sharp=require('sharp');
const base='frontend/assets/skin-study-0914/',source=fs.readFileSync('frontend/app/skin-study-preview.js','utf8'),data=JSON.parse(fs.readFileSync(base+'runtime-motion.json'));
function harness(search){
 const nodes=[];let requests=0;
 const element=()=>({style:{},dataset:{},children:[],append(...items){this.children.push(...items);},setAttribute(){}});
 const box={DATA:{SKINS:{}},location:{hostname:'127.0.0.1',search},URLSearchParams,fetch:async()=>{requests++;return {ok:true,json:async()=>data};},document:{createElement:()=>{const n=element();nodes.push(n);return n;},body:element()}};
 vm.runInNewContext(source+';this.study=SkinStudy;',box);
 return {box,nodes,requests:()=>requests};
}
(async()=>{
 const ordinary=harness('?propSet=projection'),unchanged={sprites:{'blank.rot.south':['old.png']}};
 await ordinary.box.study.install(unchanged);assert.equal(ordinary.requests(),0);assert.equal(ordinary.box.study.setFor({id:'agent'}),null);assert.equal(Object.keys(unchanged.sprites).length,1);
 const active=harness('?propSet=projection&skinSet=study'),manifest={sprites:{'blank.rot.south':['old.png']}};
 await active.box.study.install(manifest);assert.equal(active.box.study.sets.length,38);assert.equal(Object.keys(manifest.sprites).length,Object.keys(data.sprites).length+1);
 const selected=new Set();for(let i=0;i<38;i++){const body={id:'agent-'+i,skin:'blank',state:'walk'},before=JSON.stringify(body);selected.add(active.box.study.setFor(body));assert.equal(JSON.stringify(body),before);assert.equal(active.box.study.setFor(body),active.box.study.setFor(body));}assert.equal(selected.size,38);
 for(const skin of data.skins){
  const set=skin.renderSet,scale=active.box.DATA.SKINS[set].scale;
  assert.equal(scale,data.standingHeight/skin.sourceStandingHeight);
  const frame=data.sprites[set+'.rot.south'][0],bytes=fs.readFileSync(require('node:path').resolve('frontend/assets/sprites',frame));
  const decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let top=decoded.info.height,bottom=-1;for(let y=0;y<decoded.info.height;y++)for(let x=0;x<decoded.info.width;x++)if(decoded.data[(y*decoded.info.width+x)*4+3]>16){top=Math.min(top,y);bottom=Math.max(bottom,y);}
  assert.ok(bottom>=top,skin.id+' visible pixels');
  assert.ok((bottom-top+1)*scale<=20,skin.id+' standing height');
  if(!skin.retainedOriginal)for(const dir of ['north','east','south','west']){
   assert.ok(manifest.sprites[set+'.sit.'+dir]?.length,skin.id+' sit '+dir);
   assert.ok(manifest.sprites[set+'.walk.'+dir]?.length>1,skin.id+' animated walk '+dir);
  }
 }
 console.log('PASS: opt-in isolation, 38 distinct skins, native standing height, authored sitting and walking tracks.');
})().catch(e=>{console.error(e);process.exitCode=1;});
