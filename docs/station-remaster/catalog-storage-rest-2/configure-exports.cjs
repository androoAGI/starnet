const fs=require('fs');
for(const n of [2,3]){
 const p='dev/industrial-textures/build-catalog-storage-rest-'+n+'-export.cjs';
 let t=fs.readFileSync(p,'utf8');
 let rows=JSON.parse(t.match(/const rows=(.*);/)[1]);
 for(const row of rows){
  if(!(n===3&&['bridge_dispatch_pylon','crt_pile'].includes(row[0])))row[1]=row[1].replace('sheet-v1','sheet-v2');
  if(n===2&&row[3][1]===486)row[3][3]=252;
  if(n===2&&row[3][1]===741){row[3][1]=738;row[3][3]=286;}
 }
 t=t.replace(/const rows=.*;/,'const rows='+JSON.stringify(rows)+';');fs.writeFileSync(p,t);
}
const docs='docs/station-remaster/catalog-storage-rest-5',out='frontend/assets/industrial/catalog-storage-rest-5';
const contracts=JSON.parse(fs.readFileSync('docs/station-remaster/catalog-storage-rest-1/assignment-contracts.json'));
const choices=[['desk2','s',[0,0,735,475]],['desk2','n',[735,0,726,475]],['desk2','e',[0,475,735,601]],['industrial_partition','e',[735,475,726,601]]];
const cells=choices.map(([id,view,r])=>{let v=contracts.find(c=>c.id===id).structure.views[view];return {id,view,key:id+(view==='s'?'':'-'+view),source:docs+'/sheet-v1-source.png',rect:{x:r[0],y:r[1],width:r[2],height:r[3]},bounds:v.bounds,footprint:v.footprint};});
let t=fs.readFileSync('dev/industrial-textures/build-catalog-storage.cjs','utf8');
t=t.replace("const docs='docs/station-remaster/catalog-storage',out='frontend/assets/industrial/catalog-storage';",'const docs='+JSON.stringify(docs)+',out='+JSON.stringify(out)+';').replace(/const sheet=.*?\r?\nconst rows=.*?;\r?\nconst cells=.*?;\r?\n/s,'const cells='+JSON.stringify(cells)+';\n').replace("out+'/'+cell.id+'.png'","out+'/'+cell.key+'.png'").replace("view:'s',image:cell.id+'.png'","view:cell.view,image:cell.key+'.png'").replace("artSet:'catalog-storage-candidate'","artSet:'catalog-storage-rest-5-candidate'").replace("integrationRoot:'frontend/assets/industrial/catalog-storage/'",'integrationRoot:'+JSON.stringify(out+'/'));
fs.writeFileSync('dev/industrial-textures/build-catalog-storage-rest-5-export.cjs',t);
