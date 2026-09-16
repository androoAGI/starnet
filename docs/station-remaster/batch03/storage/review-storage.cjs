'use strict';
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const here=__dirname,root=path.resolve(here,'../../../..'),out=path.join(root,'frontend/assets/industrial/batch03/storage');
const ids=['bookshelf','bookstack','mug','guitar','radio','figurine','modelship','toolbox','desklamp','research_papers','etsy_threadrack','easel'];
(async()=>{const layers=[];const records=[];for(let i=0;i<ids.length;i++){
const id=ids[i],record=JSON.parse(fs.readFileSync(path.join(here,id+'.export.json')));records.push(record);
const x=(i%4)*300,y=Math.floor(i/4)*420;
layers.push({input:await sharp(path.join(out,id+'.png')).resize({width:250,height:200,fit:'inside'}).png().toBuffer(),left:x+20,top:y+28});
const scale=await sharp(path.join(here,id+'.scale.png')).metadata();
layers.push({input:path.join(here,id+'.scale.png'),left:x+20,top:y+240});
const tiny=await sharp(path.join(out,id+'.png')).resize({width:Math.round(record.bounds.width),height:Math.round(record.bounds.height),fit:'inside'}).png().toBuffer();layers.push({input:tiny,left:x+220,top:y+350});
layers.push({input:Buffer.from('<svg width="290" height="20"><text x="0" y="15" font-family="Arial" font-size="13" fill="#cbd0d3">'+id+' | 4x + 1x below</text></svg>'),left:x+10,top:y+400});
}
await sharp({create:{width:1200,height:1260,channels:4,background:'#272b2f'}}).composite(layers).png().toFile(path.join(here,'storage-contact-sheet.png'));
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({version:1,lane:'storage',status:'12 authored exports; awaiting owner live review',tilePixels:12,runtimeIntegrated:false,records},null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1});

