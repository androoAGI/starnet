'use strict';
// Packaging checks only. These cannot establish visual acceptance in the station.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p)),json=p=>JSON.parse(read(p));
const base='frontend/assets/industrial/approved-sheet/',candidate='frontend/assets/industrial/projection-correction/';
const old=json(base+'manifest.json'),next=json(candidate+'manifest.json'),receipt=json('docs/station-remaster/projection-correction/exports.json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const changed=new Set(receipt.records.map(r=>r.id));
 assert.equal(changed.size,8);assert.deepEqual(Object.keys(next.props),Object.keys(old.props));
 for(const [id,p]of Object.entries(old.props)){
  assert.deepEqual(Object.keys(next.props[id].views),Object.keys(p.views));
  for(const [f,v]of Object.entries(p.views)){
   assert.deepEqual(next.props[id].views[f].footprint,v.footprint,id+' footprint');
   if(!changed.has(id)||f!=='s'){assert.deepEqual(next.props[id].views[f],v,id+' metadata unchanged');assert.deepEqual(read(candidate+v.image),read(base+v.image),id+' image unchanged');}
  }
 }
 for(const r of receipt.records){
  assert.equal(hash(read(r.source)),r.sourceSha256,r.id+' source receipt');assert.equal(hash(read(r.output)),r.outputSha256,r.id+' export receipt');
  const source=await sharp(read(r.source)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const output=await sharp(read(r.output)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const v=next.props[r.id].views.s;
  assert.equal(output.info.width,v.sourceWidth);assert.equal(output.info.height,v.sourceHeight);
  assert.equal(v.contact.y,r.contact.y);assert.ok(v.contact.y>0&&v.contact.y<=1);
  let retained=0;
  for(let y=0;y<output.info.height;y++)for(let x=0;x<output.info.width;x++){
   const i=(y*output.info.width+x)*4,j=((y+r.sourceCrop.top)*source.info.width+x+r.sourceCrop.left)*4;
   if(output.data[i+3]){retained++;assert.deepEqual(output.data.subarray(i,i+4),source.data.subarray(j,j+4),r.id+' retained RGBA preserved');}
  }
  assert.equal(retained,r.retained);
 }
 console.log('PASS: 8 candidate exports preserve source pixels, footprints, receipts, and all untouched assets. Visual acceptance is separate.');
})().catch(e=>{console.error(e);process.exitCode=1;});
