'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const source='frontend/assets/industrial/complete-sheet/starnet-props-full-sheet.png';
const out='frontend/assets/industrial/approved-sheet',docs='docs/station-remaster/approved-sheet';
const ids=Object.keys(JSON.parse(fs.readFileSync('dev/industrial-textures/prop-structure-manifest.json')).props);
const rows=[0,120,227,332,439,548,653,759,850,934,1024];
const centers=[64,154,245,339,432,525,619,714,809,908,1004,1100,1196,1289,1385,1482];
const glow=new Set(['holotable','holopet','treasury_pnl_holo','plasmaglobe','steamvent','tube','incubator','core','tank','etsy_dyevat']);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
  const bytes=fs.readFileSync(source),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(hash(bytes)!=='e68ef0d3711e9164a3aff5333b98522ed6fdcb4bc7654929e333cb2ff2b97ea9')throw Error('Approved master changed');
  fs.mkdirSync(out,{recursive:true});fs.mkdirSync(docs,{recursive:true});const records=[];
  for(let row=0;row<10;row++){
    const rowTop=rows[row],rowBottom=rows[row+1],cuts=[0];
    for(let col=0;col<15;col++){const mid=Math.round((centers[col]+centers[col+1])/2);let best=mid,score=Infinity;
      for(let x=mid-16;x<=mid+16;x++){let n=0;for(let y=rowTop;y<rowBottom;y++){const a=data[(y*info.width+x)*4+3];if(a>40)n+=a;}
        const weighted=n+Math.abs(x-mid)*.001;if(weighted<score){score=weighted;best=x;}}
      cuts.push(best);
    }cuts.push(info.width);
    for(let col=0;col<16;col++){
      const id=ids[row*16+col],extended=['wartable','couch','quarters_pooltable'].includes(id),left=Math.max(0,cuts[col]-(extended?5:0)),right=Math.min(info.width,cuts[col+1]+(extended?5:0));
      const rowCut=nominal=>{if(nominal===0||nominal===info.height)return nominal;let best=nominal,score=Infinity;for(let y=nominal-16;y<=nominal+16;y++){let n=0;for(let x=left;x<right;x++){const a=data[(y*info.width+x)*4+3];if(a>40)n+=a;}const weighted=n+Math.abs(y-nominal)*.001;if(weighted<score){best=y;score=weighted;}}return best;};
      const top=rowCut(rowTop),bottom=rowCut(rowBottom),w=right-left,h=bottom-top,raw=Buffer.alloc(w*h*4),core=new Uint8Array(w*h),radius=glow.has(id)?8:3;
      let opaqueEdge=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const s=((y+top)*info.width+x+left)*4,d=(y*w+x)*4;data.copy(raw,d,s,s+4);if(raw[d+3]>=180)core[y*w+x]=1;if((x===0||y===0||x===w-1||y===h-1)&&raw[d+3]>=180)opaqueEdge++;}
      if(extended){
        const seen=new Uint8Array(w*h),groups=[];
        for(let p=0;p<core.length;p++)if(core[p]&&!seen[p]){const group=[p];seen[p]=1;for(let j=0;j<group.length;j++){const q=group[j],x=q%w,y=Math.floor(q/w);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy,n=yy*w+xx;if(xx>=0&&xx<w&&yy>=0&&yy<h&&core[n]&&!seen[n]){seen[n]=1;group.push(n);}}}groups.push(group);}
        groups.sort((a,b)=>b.length-a.length);core.fill(0);for(const p of groups[0]||[])core[p]=1;
        opaqueEdge=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if((x===0||y===0||x===w-1||y===h-1)&&core[y*w+x])opaqueEdge++;
      }
      let l=w,t=h,r=-1,b=-1,removed=0,retained=0;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=(y*w+x)*4;if(!raw[d+3])continue;let keep=!!core[y*w+x];
        if(!keep&&raw[d+3]>1)for(let yy=Math.max(0,y-radius);yy<=Math.min(h-1,y+radius)&&!keep;yy++)for(let xx=Math.max(0,x-radius);xx<=Math.min(w-1,x+radius);xx++)if(core[yy*w+xx]&&(x-xx)**2+(y-yy)**2<=radius*radius){keep=true;break;}
        if(!keep){raw[d+3]=0;removed++;continue;}retained++;l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
      }
      if(r<l)throw Error('Empty cell '+id);const crop={left:l,top:t,width:r-l+1,height:b-t+1},output=out+'/'+id+'.png';
      const png=await sharp(raw,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toBuffer();fs.writeFileSync(output,png);
      records.push({id,row,col,output,sourceRect:{left,top,width:w,height:h},cropInCell:crop,sourceCrop:{left:left+l,top:top+t,width:crop.width,height:crop.height},width:crop.width,height:crop.height,outputSha256:hash(png),retainedPixels:retained,alphaResidueRemoved:removed,retainedRgbChanges:0,coreThreshold:180,edgeRadius:radius,opaqueCellEdgePixels:opaqueEdge});
    }
  }
  const result={version:1,source,sourceSha256:hash(bytes),count:records.length,method:'Original RGB and retained alpha preserved; remove alpha=1 and soft detached background haze farther than3 pixels from opaque body (8 for emissive props). Tight crop per visually ordered cell. No repainting, recoloring, stretching or generated replacements.',records};
  fs.writeFileSync(docs+'/extraction.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({count:records.length,edgeFlags:records.filter(r=>r.opaqueCellEdgePixels).map(r=>({id:r.id,pixels:r.opaqueCellEdgePixels})),totalBytes:records.reduce((n,r)=>n+fs.statSync(r.output).size,0)}));
})();
