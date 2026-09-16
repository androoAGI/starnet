'use strict';
const fs=require('node:fs');
const root='frontend/assets/industrial/projection-correction/',m=JSON.parse(fs.readFileSync(root+'manifest.json'));
const geo=JSON.parse(fs.readFileSync(root+'runtime-geometry.json'));
const restored=new Set(JSON.parse(fs.readFileSync('docs/station-remaster/sharpness-restoration/integration.json')).records.map(r=>r.id+':'+r.view));
const notes={
 'industrial_partition:w':'Narrow authored diagonal has crisp contour/trim at source. Limited close-zoom sampling; retain for comparison.',
 'desk:n':'Source outline and monitor arms read cleanly. Rear view still needs the separate camera/embedded-seat room check.',
 'bridge_deckperimeter:s':'Long narrow hazard border remains legible; smallest source budget for its large footprint. Keep on maximum-zoom watchlist.',
 'rug_large:s':'Soft pile is material shading; stepped woven border remains legible. Keep on maximum-zoom watchlist.'
};
const records=Object.entries(m.props).flatMap(([id,p])=>Object.entries(p.views).map(([view,v])=>{
 const key=id+':'+view,crop=geo.views[key].crop,density=Math.max(crop.width/v.bounds.width,crop.height/v.bounds.height);
 const scale=1/density,body={width:crop.width*scale,height:crop.height*scale};
 return {id,view,image:v.image,bounds:v.bounds,crop,body,sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight,
 sourcePixelsPerWorldPixel:+density.toFixed(2),zoomLimit:6,sourceExpansionAtMaxZoom:+Math.max(1,6/density).toFixed(2),
 status:restored.has(key)?'restored':density<6?'zoom-watch':'source-inspected',
 reason:restored.has(key)?'Under-resolved source replaced with a generated fidelity restoration. Same world bounds and footprint. Compare before/after and inspect in Kepler.':notes[key]||'Contour, primary shapes and material boundaries inspected on the source contact sheet; no obvious baked blur found. This is not room/camera approval.'};
}));
const counts={};for(const r of records)counts[r.status]=(counts[r.status]||0)+1;
const data={date:'2026-09-15',method:'184 source views inspected on eight labeled plates, seven low-resolution sources additionally inspected individually. Alpha bounds measured for every PNG. Source pixel budget uses the actual uniform fit; 6x is the supported camera maximum. Resolution is triage, not an automatic visual pass. Restored sources receive a separate in-station check. CRT/grain retained.',cacheDensity:6,counts,records};
fs.writeFileSync('docs/station-remaster/sharpness-restoration/audit.json',JSON.stringify(data,null,2)+'\n');
fs.writeFileSync('frontend/assets/industrial/sharpness-restoration/audit.json',JSON.stringify(data,null,2)+'\n');
console.log(counts);
