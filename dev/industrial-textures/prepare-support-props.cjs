'use strict';
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..');
const source=process.argv[2];
if(!source)throw Error('Pass the built-in imagegen directory.');
const target=path.join(root,'frontend/assets/industrial/props');
const sources=[
 {id:'war_intelcab',file:'exec-b9346611-6cfa-42c5-8048-fe4275a8ae12.png',seeds:[],footprint:[1,2],height:29,width:14,groundSource:[218,1350,805,1416],anchorSource:[530,1417],screens:[{name:'status-channel',polygon:[[706,355],[781,355],[781,1110],[706,1110]]},{name:'cap-status',polygon:[[411,215],[646,215],[646,231],[411,231]]}]},
 {id:'gigs_servercart',file:'exec-55a9ccea-0fb7-417f-9bed-59e67adc9e31.png',seeds:[[520,210]],footprint:[1,1],height:19.33,width:12,groundSource:[151,1342,888,1405],anchorSource:[520,1405],screens:[{name:'blade-1',polygon:[[650,690],[672,690],[672,708],[650,708]]},{name:'blade-2',polygon:[[650,845],[672,845],[672,863],[650,863]]},{name:'blade-3',polygon:[[650,1000],[672,1000],[672,1018],[650,1018]]}]},
 {id:'industrial_wallpanel',file:'exec-ce6ee71b-252f-41d8-b9e6-b32497f3662f.png',seeds:[],footprint:[2,1],height:13.68,width:24,mount:'wall',groundSource:[53,891,1455,910],anchorSource:[754,913],screens:[{name:'diagnostic',polygon:[[1171,290],[1287,290],[1287,457],[1171,457]]}]},
 {id:'workbench',file:'exec-10239748-0b4f-44e9-acff-1bf256be385b.png',seeds:[[340,766],[626,767],[1084,767]],footprint:[2,1],height:19.42,width:26,groundSource:[98,1001,1334,1053],anchorSource:[716,1053],screens:[{name:'test-meter',polygon:[[1075,461],[1137,461],[1139,495],[1078,495]]},{name:'work-status',polygon:[[552,703],[878,703],[878,723],[552,723]]}]}
];
(async()=>{
fs.mkdirSync(target,{recursive:true});const metadata={schemaVersion:1,camera:'south-facing overhead oblique parallel; ground axes horizontal/vertical, verticals vertical',preparation:'Source RGB subject pixels preserved. Generator returned opaque checkerboard; only connected bright-neutral exterior and explicit open-gap mattes removed. No repainting, resizing, gamma, sharpening or generated-body transformation.',assets:[]};
for(const s of sources){
 const src=path.join(source,s.file),m=await sharp(src).metadata();
 const {data,info}=await sharp(src).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const {width:w,height:h}=info,seen=new Uint8Array(w*h),q=new Int32Array(w*h);let n=0,head=0;
 const visit=i=>{if(i<0||i>=w*h||seen[i])return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);if(data[p+3]>0&&(lo<145||hi-lo>25))return;seen[i]=1;q[n++]=i;};
 if(!m.hasAlpha){
  for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}
  for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
  for(const [x,y]of s.seeds)visit(y*w+x);
  while(head<n){const i=q[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
 }
 let l=w,t=h,r=0,b=0;
 for(let i=0;i<w*h;i++){if(seen[i]){data.fill(0,i*4,i*4+4);continue;}if(!data[i*4+3])continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
 const cw=r-l+1,ch=b-t+1,relative=([x,y])=>[Number(((x-l)/cw).toFixed(6)),Number(((y-t)/ch).toFixed(6))];
 const dest=path.join(target,s.id+'-s.png');
 await sharp(data,{raw:{width:w,height:h,channels:4}}).extract({left:l,top:t,width:cw,height:ch}).png({compressionLevel:9}).toFile(dest);
 const [gl,gt,gr,gb]=s.groundSource;
 const entry={id:s.id,file:'frontend/assets/industrial/props/'+s.id+'-s.png',sourceFile:s.file,sourceDimensions:[w,h],sourceHasAlpha:m.hasAlpha,crop:[l,t,cw,ch],dimensions:[cw,ch],transparentPixelCount:n,footprintTiles:s.footprint,mount:s.mount||'floor',recommendedDisplayHeightWorldPx:s.height,recommendedDisplayWidthWorldPx:s.width,groundContactBBox:[...relative([gl,gt]),...relative([gr,gb])],anchor:relative(s.anchorSource),screens:s.screens.map(v=>({name:v.name,polygon:v.polygon.map(relative),initialState:'off'}))};
 metadata.assets.push(entry);console.log(JSON.stringify(entry));
}
fs.writeFileSync(path.join(target,'support-metadata.json'),JSON.stringify(metadata,null,2)+'\n');
})();
