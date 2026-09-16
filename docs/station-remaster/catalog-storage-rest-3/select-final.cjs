const fs=require('fs'),source='docs/station-remaster/catalog-storage-rest-3/narrow-correction-source.png';
const p='dev/industrial-textures/build-catalog-storage-rest-3-export.cjs';
let t=fs.readFileSync(p,'utf8'),rows=JSON.parse(t.match(/const rows=(.*);/)[1]);
for(let row of rows){const rect={arc_ladder:[0,0,600,625],bridge_dispatch_pylon:[600,0,599,625],bridge_relaystack:[0,625,600,687]}[row[0]];if(rect){row[1]=source;row[3]=rect;}}
fs.writeFileSync(p,t.replace(/const rows=.*;/,'const rows='+JSON.stringify(rows)+';'));
const p5='dev/industrial-textures/build-catalog-storage-rest-5-export.cjs';t=fs.readFileSync(p5,'utf8');let cells=JSON.parse(t.match(/const cells=(.*);/)[1]);let c=cells.find(c=>c.id==='industrial_partition');c.source=source;c.rect={x:600,y:625,width:599,height:687};
t=t.replace(/const cells=.*;/,'const cells='+JSON.stringify(cells)+';').replace("r.id+' — 1× / 2× / 4× native fit'","r.id+':'+r.view+' — 1× / 2× / 4× native fit'");fs.writeFileSync(p5,t);
