'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto'),sharp=require('sharp');
const base='frontend/assets/skin-study-0914/',source=fs.readFileSync('frontend/app/skin-study-preview.js','utf8'),data=JSON.parse(fs.readFileSync(base+'runtime-preview.json'));
function harness(search){
 const nodes=[];let requests=0;
 const element=()=>({style:{},dataset:{},children:[],append(...items){this.children.push(...items);},setAttribute(){}});
 const box={location:{hostname:'127.0.0.1',search},URLSearchParams,fetch:async()=>{requests++;return {ok:true,json:async()=>data};},document:{createElement:()=>{const n=element();nodes.push(n);return n;},body:element()}};
 vm.runInNewContext(source+';this.study=SkinStudy;',box);
 return {box,nodes,requests:()=>requests};
}
(async()=>{
 const ordinary=harness('?propSet=projection'),unchanged={sprites:{'blank.rot.south':['old.png']}};
 await ordinary.box.study.install(unchanged);assert.equal(ordinary.requests(),0);assert.equal(ordinary.box.study.setFor({id:'agent'}),null);assert.equal(Object.keys(unchanged.sprites).length,1);
 const active=harness('?propSet=projection&skinSet=study'),manifest={sprites:{'blank.rot.south':['old.png']}};
 await active.box.study.install(manifest);assert.equal(active.box.study.sets.length,38);assert.equal(Object.keys(manifest.sprites).length,153);
 const selected=new Set();for(let i=0;i<38;i++){const body={id:'agent-'+i,skin:'blank',state:'walk'},before=JSON.stringify(body);selected.add(active.box.study.setFor(body));assert.equal(JSON.stringify(body),before);assert.equal(active.box.study.setFor(body),active.box.study.setFor(body));}assert.equal(selected.size,38);
 for(const skin of data.skins)for(const [dir,v]of Object.entries(skin.views)){
  const bytes=fs.readFileSync(base+skin.id+'/'+dir+'.png');assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),v.sha256);
  const decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(decoded.info.height,v.height);assert.equal(decoded.info.width,v.width);
  let bottom=-1;for(let y=0;y<v.height;y++)for(let x=0;x<v.width;x++)if(decoded.data[(y*v.width+x)*4+3]>16)bottom=Math.max(bottom,y);
  assert.equal(bottom,v.bottom);assert.ok((v.bottom-v.top+1)*skin.scale<=(skin.id==='ultron'?25:18)+1e-6);
 }
 console.log('PASS: opt-in isolation, 38 distinct skins, 152 source hashes and per-view foot anchors.');
})().catch(e=>{console.error(e);process.exitCode=1;});
