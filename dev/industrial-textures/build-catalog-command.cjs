'use strict';
// Reproducible packaging only: preserve every RGB value and retained alpha.
const fs=require('node:fs'),crypto=require('node:crypto');
const sharp=require('C:/Users/andro/Desktop/gen/node_modules/sharp');
const docs='docs/station-remaster/catalog-command',out='frontend/assets/industrial/catalog-command';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const rows=[
  [
    "console",
    "docs/station-remaster/catalog-command/console-v2-source.png",
    "9b16ec410d1f493787b7dea0248e98d6cf3691855ed1cc6b4f12026dab0f4005",
    [
      0,
      0,
      1383,
      1137
    ],
    [
      -3,
      -11,
      28,
      23
    ],
    [
      2,
      1
    ]
  ],
  [
    "consoleL",
    "docs/station-remaster/catalog-command/consoleL-final-source.png",
    "0f0a663c4555fecd9120dd0703458f99e516d2117669db4e47b4940f69317810",
    [
      0,
      0,
      1654,
      951
    ],
    [
      -3,
      -11,
      40,
      23
    ],
    [
      3,
      1
    ]
  ],
  [
    "bench",
    "docs/station-remaster/catalog-command/bench-final-source.png",
    "7507ed20103d20abba395e8e21f1b4976f4dc13619f191350417dfef670e5eee",
    [
      0,
      0,
      1811,
      868
    ],
    [
      -1,
      -14,
      54,
      26
    ],
    [
      4,
      1
    ]
  ],
  [
    "bridge_consolebank",
    "docs/station-remaster/catalog-command/sheet-v1-source.png",
    "98daed3c08c8c53826c58876deed4898d474b34b65471ae7924d577cf031cabb",
    [
      0,
      585,
      720,
      245
    ],
    [
      0,
      -21,
      108,
      33
    ],
    [
      9,
      1
    ]
  ],
  [
    "bridge_equipmentbay",
    "docs/station-remaster/catalog-command/bridge_equipmentbay-final-source.png",
    "35eb9b38abd8165830400b51e534b1d27899527a52b83df566283fa2ce0ebea6",
    [
      0,
      0,
      1995,
      788
    ],
    [
      0,
      -7,
      48,
      19
    ],
    [
      4,
      1
    ]
  ],
  [
    "bigscreen",
    "docs/station-remaster/catalog-command/sheet-v1-source.png",
    "98daed3c08c8c53826c58876deed4898d474b34b65471ae7924d577cf031cabb",
    [
      720,
      620,
      655,
      210
    ],
    [
      -1,
      -13,
      98,
      25
    ],
    [
      8,
      1
    ]
  ],
  [
    "holotable",
    "docs/station-remaster/catalog-command/holotable-final-source.png",
    "b249b6ce9585c27cfde9f8991f15dbe022b55c370a7435627ffe0a0ca2f9c559",
    [
      0,
      0,
      1521,
      1034
    ],
    [
      -1,
      -10,
      50,
      34
    ],
    [
      4,
      2
    ]
  ],
  [
    "bridge_tacticaltable",
    "docs/station-remaster/catalog-command/bridge_tacticaltable-final-source.png",
    "730120434a1ce8d44f74c8ed3cd1cca9bcae3cbbe5b442655659574ec5dc3e7c",
    [
      0,
      0,
      1550,
      1014
    ],
    [
      0,
      -7,
      84,
      55
    ],
    [
      7,
      4
    ]
  ]
];
const cells=rows.map(([id,source,expectedHash,r,b,f])=>({id,source,expectedHash,rect:{x:r[0],y:r[1],width:r[2],height:r[3]},bounds:{x:b[0],y:b[1],width:b[2],height:b[3]},footprint:{w:f[0],h:f[1]}}));
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
    const scale=Math.min(cell.bounds.width/crop.width,cell.bounds.height/crop.height);
    let contactRow=0;for(let yy=0;yy<crop.height;yy++){let count=0;for(let xx=0;xx<crop.width;xx++)if(check[(yy*crop.width+xx)*4+3]>=180)count++;if(count>=2)contactRow=yy+1;}
    records.push({id:cell.id,view:'s',image:cell.id+'.png',sourceWidth:crop.width,sourceHeight:crop.height,bounds:cell.bounds,footprint:cell.footprint,contact:{y:contactRow/crop.height},actualUniformFit:{width:crop.width*scale,height:crop.height*scale},aspectRatioError:(crop.width/crop.height)/(cell.bounds.width/cell.bounds.height)-1,source:cell.source,sourceSha256,output,outputSha256:hash(png),sourceRect:cell.rect,cropInCell:crop,sourceCrop:{left:left+l,top:top+t,width:crop.width,height:crop.height},width:crop.width,height:crop.height,alphaBounds:{x:0,y:0,width:crop.width,height:crop.height},retainedPixels:retained,alphaResidueRemoved:removed,coreThreshold:180,edgeRadius:radius,opaqueCellEdgePixels,rgbChanges,retainedAlphaChanges,alpha:{zero,partial,opaque255,maxAlpha},liveVerified:false});
  }
  const result={version:1,artSet:'catalog-command-candidate',integrationRoot:'frontend/assets/industrial/catalog-command/',count:records.length,method:'Same alpha core threshold180 and Euclidean radius3 as approved sheet extraction. All original RGB and retained alpha preserved; only detached translucent background alpha removed. Tight crop; no resizing, repainting or recoloring.',sourcesPreserved:true,records};
  fs.writeFileSync(docs+'/integration.json',JSON.stringify(result,null,2)+'\n');
  const composites=[];
  for(let i=0;i<records.length;i++){
    const r=records[i],left=(i%2)*760,top=Math.floor(i/2)*240;
    const svg=Buffer.from('<svg width="620" height="40"><text x="12" y="22" fill="#eef2eb" font-size="17">'+r.id+' — 1× / 2× / 3× native fit</text></svg>');
    composites.push({input:svg,left,top});
    for(const [zoom,offset] of [[1,20],[2,135],[3,380]]){
      const w=Math.round(r.actualUniformFit.width*zoom),h=Math.round(r.actualUniformFit.height*zoom);
      composites.push({input:await sharp(r.output).resize(w,h,{fit:'fill',kernel:'lanczos3'}).png().toBuffer(),left:left+offset,top:top+215-Math.round(h*r.contact.y)});
    }
  }
  await sharp({create:{width:1520,height:960,channels:4,background:'#344139'}}).composite(composites).png().toFile(docs+'/game-size-contact-sheet.png');
  console.log(JSON.stringify(records.map(r=>({id:r.id,width:r.width,height:r.height,rgbChanges:r.rgbChanges,retainedAlphaChanges:r.retainedAlphaChanges,opaqueCellEdgePixels:r.opaqueCellEdgePixels})),null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
