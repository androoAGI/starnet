'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');const root=path.resolve(__dirname,'../..');process.chdir(root);
const owner=process.argv[2]||'C:/Users/andro/gen-trees/industrial-textures-0912';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const all=read('dev/industrial-textures/prop-structure-manifest.json').props,claims=read('docs/station-remaster/batch03/claims.json'),old=read('frontend/assets/industrial/batch02/catalog.json').items,local=read('docs/station-remaster/batch03/source-audit.json');
const ours=new Set([...old.map(a=>a.id),...claims.newSections.flatMap(g=>g.ids)]),reserved=new Set(claims.ownerReserved),coverage=read(path.join(owner,'docs/station-remaster/props-v3/coverage.json')),runtime=read(path.join(owner,'frontend/assets/industrial/props-v3/manifest.json')).props,external=[];
for(const lane of ['equipment','communications','lab'])external.push(...read(path.join(owner,'frontend/assets/industrial/batch03',lane,'export-checks.json')).records);
const records=[];
for(const id of Object.keys(all)){
 if(ours.has(id)){const rs=local.records.filter(r=>r.id===id);records.push({id,owner:'parallel-art',category:old.some(a=>a.id===id)?'repaint':'new-source',available:rs.length>0,completeViews:Object.values(all[id].views).every(v=>rs.some(r=>r.view===v.r)),files:rs.map(r=>({workspace:root,path:r.output,sha256:r.outputSha256}))});}
 else if(reserved.has(id)){const rs=external.filter(r=>r.id===id);for(const r of rs){if(sha(path.join(owner,r.output))!==r.outputSha256||sha(path.join(owner,r.source))!==r.sourceSha256)throw Error('Owner receipt mismatch '+id);}records.push({id,owner:'original-task',category:'new-source',available:rs.length>0,files:rs.map(r=>({workspace:owner,path:r.output,sha256:r.outputSha256})),note:id==='fabricator'||id==='etsy_packbot'||id==='tube'?'Body source; original task separately supplies moving mechanisms.':undefined});}
 else {const state=coverage.props.find(a=>a.id===id)?.status;if(state==='approved-existing')records.push({id,owner:'existing',category:'approved-existing',available:true,evidence:'Original-task coverage status; approved artwork retained.'});else {const files=Object.values(runtime[id]?.views||{}).map(v=>{const p='frontend/assets/industrial/props-v3/'+v.image;return{workspace:owner,path:p,sha256:sha(path.join(owner,p))};});records.push({id,owner:'earlier-source',category:'prior-source',available:files.length>0,files});}}
}
const report={catalog:records.length,sourceCandidates:records.filter(r=>r.category!=='approved-existing'&&r.available).length,approvedExisting:records.filter(r=>r.category==='approved-existing').length,missingSourceIds:records.filter(r=>!r.available).map(r=>r.id),repaintsDoNotIncreaseCoverage:true,scope:'Cross-task source inventory only; source availability is distinct from complete runtime mechanisms and user visual acceptance.',records};
fs.writeFileSync('docs/station-remaster/batch03/combined-source-inventory.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,records:undefined}));

