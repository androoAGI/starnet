'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'../../../..'),docs=__dirname,out=path.join(root,'frontend/assets/industrial/scale-calibration/utility');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
const records=[];
for(const [id,bounds] of [['coffee',{width:13,height:18}],['monstera',{width:12,height:13}]]){
const source=fs.readFileSync(path.join(docs,'originals',id+'.png'));const {data,info}=await sharp(source).raw().toBuffer({resolveWithObject:true});
if(info.channels!==4)throw Error('expected generated RGBA');
const before=Buffer.from(data);let residue=0,l=info.width,t=info.height,r=-1,b=-1;
for(let i=0;i<info.width*info.height;i++){if(data[i*4+3]===1){data[i*4+3]=0;residue++;}if(data[i*4+3]){const x=i%info.width,y=Math.floor(i/info.width);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}}
const crop={left:l,top:t,width:r-l+1,height:b-t+1};
await sharp(data,{raw:info}).extract(crop).png().toFile(path.join(out,id+'.png'));
const final=await sharp(path.join(out,id+'.png')).raw().toBuffer({resolveWithObject:true});let changes=0;
for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++)for(let c=0;c<3;c++)if(final.data[(y*crop.width+x)*4+c]!==before[((y+t)*info.width+x+l)*4+c])changes++;
if(changes)throw Error('RGB changed');
const s=Math.min(bounds.width/crop.width,bounds.height/crop.height),fit={width:crop.width*s,height:crop.height*s};
await sharp(path.join(out,id+'.png')).resize({width:Math.round(fit.width*4),height:Math.round(fit.height*4),fit:'inside',kernel:'lanczos3'}).png().toFile(path.join(docs,id+'-4x.png'));
records.push({id,source:'docs/station-remaster/scale-calibration/utility/originals/'+id+'.png',sourceSha256:hash(source),sourceWidth:info.width,sourceHeight:info.height,output:'frontend/assets/industrial/scale-calibration/utility/'+id+'.png',outputSha256:hash(fs.readFileSync(path.join(out,id+'.png'))),crop,alphaOneResiduePixelsRemoved:residue,retainedRgbChanges:changes,method:'Original generated RGBA preserved except alpha=1 dust cleared to0; uniform crop, no RGB edit, no stretch; full source preserved',bounds,fit,sourceAspect:crop.width/crop.height});
}
const items=[];let svg='<svg width="1100" height="530"><rect width="1100" height="530" fill="#252b2c"/>';
for(let i=0;i<records.length;i++){
const v=records[i],y=45+i*245;svg+='<text x="20" y="'+(y-18)+'" fill="#d8d4c9" font-size="18">'+v.id+' NEW — 1x / 2x / 4x world size; right = enlarged 4x diagnostic</text>';
for(const [k,x] of [[1,35],[2,150],[4,275]]){
const w=Math.round(v.fit.width*k),h=Math.round(v.fit.height*k);items.push({input:await sharp(path.join(out,v.id+'.png')).resize(w,h,{fit:'inside',kernel:'lanczos3'}).toBuffer(),left:x,top:y+85-h});
}
const mini=await sharp(path.join(docs,v.id+'-4x.png')).resize({width:Math.round(v.fit.width*4)*3,height:Math.round(v.fit.height*4)*3,kernel:'nearest'}).toBuffer();
items.push({input:mini,left:440,top:y});
}
svg+='</svg>';await sharp(Buffer.from(svg)).composite(items).png().toFile(path.join(docs,'size-proof.png'));
fs.writeFileSync(path.join(docs,'export-receipts.json'),JSON.stringify({version:1,tool:'built-in image_gen',authorization:'User authorized alpha-only packaging and uniform size-proof resizing',records},null,2)+'\n');console.log(JSON.stringify(records));
})().catch(e=>{console.error(e);process.exitCode=1;});

