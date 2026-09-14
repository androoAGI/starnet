'use strict';
// Alpha-only packaging of authored repair sources. Run from repository root.
const fs = require('node:fs');
const crypto = require('node:crypto');
const sharp = require('sharp');
const docs = 'docs/station-remaster/approved-sheet/storage';
const out = 'frontend/assets/industrial/approved-sheet';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const receipt = JSON.parse(fs.readFileSync(docs + '/repair-sheet-receipt.json'));
const cells = receipt.layout.cells.map(c => ({id:c.id, source:docs+'/repair-sheet-source.png', expectedHash:receipt.sha256, rect:c.sourceReviewRegion}));
cells.push({id:'holopet', source:docs+'/holopet-repair-source.png', expectedHash:'c3c6506b00486392b1dace79fe3d520c830888ec8708f0f6a92522fcb9bb42a2', rect:{x:0,y:0,width:1536,height:1024}});

(async () => {
  fs.mkdirSync(out,{recursive:true});
  const records=[];
  for (const cell of cells) {
    const bytes=fs.readFileSync(cell.source), sourceSha256=hash(bytes);
    if(cell.expectedHash && sourceSha256!==cell.expectedHash) throw Error('Source changed: '+cell.id);
    const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const {x:left,y:top,width:w,height:h}=cell.rect;
    if(left<0||top<0||left+w>info.width||top+h>info.height) throw Error('Invalid region '+cell.id);
    const raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h),radius=3;
    let opaqueCellEdgePixels=0;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const s=((y+top)*info.width+x+left)*4,d=(y*w+x)*4;
      data.copy(raw,d,s,s+4);
      if(raw[d+3]>=180)core[y*w+x]=1;
      if((x===0||y===0||x===w-1||y===h-1)&&raw[d+3]>=180)opaqueCellEdgePixels++;
    }
    let l=w,t=h,r=-1,b=-1,removed=0,retained=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const d=(y*w+x)*4;if(!raw[d+3])continue;let keep=!!core[y*w+x];
      if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-radius);yy<=Math.min(h-1,y+radius)&&!keep;yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(w-1,x+radius);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=radius*radius){keep=true;break;}
      if(!keep){raw[d+3]=0;removed++;continue;}
      retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
    }
    if(r<l)throw Error('Empty repair '+cell.id);
    if(opaqueCellEdgePixels)throw Error('Clipped opaque region '+cell.id+': '+opaqueCellEdgePixels);
    const crop={left:l,top:t,width:r-l+1,height:b-t+1};
    const output=out+'/'+cell.id+'.png';
    const png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toBuffer();
    fs.writeFileSync(output,png);
    const check=await sharp(png).ensureAlpha().raw().toBuffer();
    let rgbChanges=0,retainedAlphaChanges=0,zero=0,partial=0,opaque255=0,maxAlpha=0;
    for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
      const p=(y*crop.width+x)*4,s=((top+t+y)*info.width+left+l+x)*4,a=check[p+3];
      for(let c=0;c<3;c++)if(check[p+c]!==data[s+c])rgbChanges++;
      if(a&&a!==data[s+3])retainedAlphaChanges++;
      if(!a)zero++;else if(a===255)opaque255++;else partial++;maxAlpha=Math.max(maxAlpha,a);
    }
    if(rgbChanges||retainedAlphaChanges)throw Error('Pixel preservation failed '+cell.id);
    records.push({id:cell.id,source:cell.source,sourceSha256,output,outputSha256:hash(png),sourceRect:cell.rect,cropInCell:crop,sourceCrop:{left:left+l,top:top+t,width:crop.width,height:crop.height},width:crop.width,height:crop.height,alphaBounds:{x:0,y:0,width:crop.width,height:crop.height},retainedPixels:retained,alphaResidueRemoved:removed,coreThreshold:180,edgeRadius:radius,opaqueCellEdgePixels,rgbChanges,retainedAlphaChanges,alpha:{zero,partial,opaque255,maxAlpha},liveVerified:false});
  }
  const result={version:1,count:records.length,method:'Same alpha core threshold180 and Euclidean radius3 as approved sheet extraction. All original RGB and retained alpha preserved; only detached translucent background alpha removed. Tight crop; no resizing, repainting or recoloring.',sourcesPreserved:true,records};
  fs.writeFileSync(docs+'/repair-extraction.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(records.map(r=>({id:r.id,width:r.width,height:r.height,rgbChanges:r.rgbChanges,retainedAlphaChanges:r.retainedAlphaChanges,opaqueCellEdgePixels:r.opaqueCellEdgePixels})),null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
