'use strict';
// Inspection contact sheets; source props remain unchanged.
const fs=require('node:fs'),sharp=require('sharp');
(async()=>{
 const root='frontend/assets/industrial/projection-correction',m=JSON.parse(fs.readFileSync(root+'/manifest.json'));
 const views=Object.entries(m.props).flatMap(([id,p])=>Object.entries(p.views).map(([view,s])=>({id,view,...s}))),out='dev/.scratch-workspace/camera-audit';fs.mkdirSync(out,{recursive:true});
 for(let offset=0;offset<views.length;offset+=24){const layers=[];
  for(const[v,s]of views.slice(offset,offset+24).entries()){
   const x=(v%4)*250,y=Math.floor(v/4)*160;
   layers.push({input:await sharp(root+'/'+s.image).resize({width:220,height:122,fit:'inside'}).png().toBuffer(),left:x+14,top:y+28});
   layers.push({input:Buffer.from('<svg width="250" height="24"><text x="8" y="17" font-family="monospace" font-size="12" fill="#ddd">'+s.id+':'+s.view+'</text></svg>'),left:x,top:y});
  }
  await sharp({create:{width:1000,height:960,channels:4,background:'#282b2d'}}).composite(layers).png().toFile(out+'/plate-'+(offset/24+1)+'.png');
 }console.log('Inspection plates: '+views.length+' exported views');
})();
