'use strict';
// Mechanical proof sheet, using the exact uniform-fit contract of the renderer.
const fs=require('node:fs'),path=require('node:path'),{createCanvas,loadImage}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p),geometry=require('./prop-structure-manifest.json');
const {fit}=require('../../frontend/app/propremaster.js');
(async()=>{
 const records=JSON.parse(fs.readFileSync(at('frontend/assets/industrial/batch03/lab/export-checks.json'))).records;
 const floor=await loadImage(at('frontend/assets/industrial/remaster/floors/plate.png'));
 const sheet=createCanvas(1440,800),g=sheet.getContext('2d');g.fillStyle='#10191a';g.fillRect(0,0,1440,800);
 g.fillStyle='#c8bd9a';g.font='22px sans-serif';g.fillText('STARNET · LAB & FABRICATION · NATIVE FOOTPRINT PROOF',24,35);
 const checks=[];
 for(const [index,a]of records.filter(a=>a.id!=='fabricator_carriage').entries()){
  const spec=geometry.props[a.id].views.s,im=await loadImage(at(a.output)),box=fit(spec.bounds,{width:im.width,height:im.height});
  const left=index%3*480+20,top=Math.floor(index/3)*360+65;
  g.save();g.translate(left,top);g.scale(4,4);
  for(let y=0;y<5;y++)for(let x=0;x<9;x++)g.drawImage(floor,x*12,y*12,12,12);
  const x=(108-spec.footprint.w*12)/2,y=48-spec.footprint.h*12;
  g.strokeStyle='rgba(126,208,207,.45)';g.lineWidth=.25;g.strokeRect(x,y,spec.footprint.w*12,spec.footprint.h*12);
  g.drawImage(im,x+box.x,y+box.y,box.width,box.height);g.restore();
  g.fillStyle='#b8b2a0';g.font='16px sans-serif';g.fillText(a.id+' · '+spec.footprint.w+' × '+spec.footprint.h+' tiles',left,top+270);
  checks.push({id:a.id,footprint:spec.footprint,bounds:spec.bounds,actualUniformFit:box,sourceRgbChanges:a.subjectRgbChanges,sourceOnly:true});
 }
 const out='docs/station-remaster/batch03/lab/';
 fs.writeFileSync(at(out+'native-scale.png'),await sheet.encode('png'));
 fs.writeFileSync(at(out+'geometry-review.json'),JSON.stringify(checks,null,2)+'\n');
 console.log('Six sources rendered with shared uniform fit and native footprint outlines.');
})().catch(e=>{console.error(e);process.exitCode=1;});
