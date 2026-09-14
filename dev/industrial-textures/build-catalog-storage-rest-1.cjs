// Generate self-contained packaging scripts from the previously verified RGBA exporter.
const fs=require('fs');
const contracts=JSON.parse(fs.readFileSync('docs/station-remaster/catalog-storage-rest-1/assignment-contracts.json'));
const batches=JSON.parse(fs.readFileSync('docs/station-remaster/catalog-storage-rest-1/batches.json'));
const cuts=[{w:1313,h:1198,ys:[0,295,550,837,1198],xs:[650,650,650,650]}, {w:1536,h:1024,ys:[0,260,486,741,1024],xs:[860,880,800,780]}, {w:1024,h:1536,ys:[0,395,780,1155,1536],xs:[500,500,500,500]}, {w:1083,h:1453,ys:[0,380,690,1010,1453],xs:[520,480,520,530]}];
let template=fs.readFileSync('dev/industrial-textures/build-catalog-storage.cjs','utf8');
for(let n=1;n<=4;n++){
 const d='docs/station-remaster/catalog-storage-rest-'+n,o='frontend/assets/industrial/catalog-storage-rest-'+n,c=cuts[n-1];
 const source=d+'/sheet-v'+(n===1?2:1)+'-source.png';
 const rows=batches[n-1].map((id,i)=>{let v=contracts.find(x=>x.id===id).structure.views.s;let row=Math.floor(i/2),left=i%2?c.xs[row]:0;return [id,source,null,[left,c.ys[row],(i%2?c.w:c.xs[row])-left,c.ys[row+1]-c.ys[row]],[v.bounds.x,v.bounds.y,v.bounds.width,v.bounds.height],[v.footprint.w,v.footprint.h]];});
 let script=template.replace("const docs='docs/station-remaster/catalog-storage',out='frontend/assets/industrial/catalog-storage';",'const docs='+JSON.stringify(d)+',out='+JSON.stringify(o)+';').replace(/const sheet=.*?\r?\nconst rows=.*?;\r?\n/s,'const rows='+JSON.stringify(rows)+';\n').replace("artSet:'catalog-storage-candidate'","artSet:'catalog-storage-rest-"+n+"-candidate'").replace("integrationRoot:'frontend/assets/industrial/catalog-storage/'",'integrationRoot:'+JSON.stringify(o+'/'));
 fs.writeFileSync('dev/industrial-textures/build-catalog-storage-rest-'+n+'-export.cjs',script);
}
