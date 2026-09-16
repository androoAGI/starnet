'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),sharp=require('sharp');
const repo=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(repo,p)),json=p=>JSON.parse(read(p));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 const primary=json('docs/station-remaster/approved-sheet/extraction.json'),facing=json('docs/station-remaster/approved-sheet/crew/facings-extraction.json'),repair=json('docs/station-remaster/approved-sheet/storage/repair-extraction.json');
 const manifest=json('frontend/assets/industrial/approved-sheet/manifest.json'),structure=json('dev/industrial-textures/prop-structure-manifest.json');
 assert.equal(sha(read(primary.source)),primary.sourceSha256,'approved master is immutable');
 const records=new Map();for(const r of primary.records)records.set(r.output,{...r,source:primary.source,sourceSha256:primary.sourceSha256});for(const r of [...facing.records,...repair.records])records.set(r.output,r);
 const sources=new Map();let retained=0,views=0;
 assert.deepEqual(Object.keys(manifest.props),Object.keys(structure.props),'complete ordered catalog');
 for(const [id,p]of Object.entries(manifest.props)){
  assert.deepEqual(Object.keys(p.views),Object.keys(structure.props[id].views),'all supported views '+id);
  for(const [face,v]of Object.entries(p.views)){
   views++;const output='frontend/assets/industrial/approved-sheet/'+v.image,r=records.get(output);assert.ok(r,'export receipt '+output);
   const png=read(output);assert.equal(sha(png),r.outputSha256,'exact reviewed export '+output);
   const out=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(out.info.width,v.sourceWidth);assert.equal(out.info.height,v.sourceHeight);
   assert.deepEqual(v.footprint,structure.props[id].views[face].footprint,'physics preserved '+id+face);
   assert.equal(v.mode,'approved');assert.equal(v.exposure,1);assert.ok(Math.abs(v.bounds.width/v.bounds.height-v.sourceWidth/v.sourceHeight)<.0001,'uniform scaling '+id+face);
   if(!sources.has(r.source)){const bytes=read(r.source);assert.equal(sha(bytes),r.sourceSha256);sources.set(r.source,await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}));}
   const source=sources.get(r.source),c=r.sourceCrop,left=c.left??c.x,top=c.top??c.y;
   for(let y=0;y<out.info.height;y++)for(let x=0;x<out.info.width;x++){
    const at=(y*out.info.width+x)*4;if(!out.data[at+3])continue;const from=((top+y)*source.info.width+left+x)*4;
    assert.ok(out.data.subarray(at,at+4).equals(source.data.subarray(from,from+4)),'source RGBA unchanged '+output+' '+x+','+y);retained++;
   }
  }
 }
 assert.equal(views,184);console.log('approved-sheet-assets: PASS 160 props, 184 views, '+retained+' exact source RGBA pixels; immutable master, complete facings and unchanged footprints');
})().catch(e=>{console.error(e);process.exitCode=1;});
