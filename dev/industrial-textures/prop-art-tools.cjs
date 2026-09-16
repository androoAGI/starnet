'use strict';
// Native structural references and lossless generated-art export; never paints artwork.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),sharp=require('sharp');
const {createCanvas,Image}=require('@napi-rs/canvas');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
async function native(){
 const document={documentElement:{dataset:{}},createElement:()=>createCanvas(1,1)},window={addEventListener(){},matchMedia:()=>({matches:false})};
 const U=new Function('window','document',read('frontend/js/util.js')+';return U;')(window,document);
 class Asset extends Image{set src(url){super.src=fs.readFileSync(path.join(root,'frontend',url));}}
 const a={document,window,Image:Asset,URLSearchParams,location:{search:''},module:{exports:{}}};
 vm.runInNewContext(read('frontend/app/industrialtextures.js'),a);const pack=a.module.exports;await pack.ready;
 const e={document,window,U,IndustrialTextures:pack,module:{exports:{}}};vm.runInNewContext(read('frontend/app/propsprites.js'),e);
 return e.module.exports;
}
async function guides(){
 const PS=await native(),out=path.join(root,'dev/.scratch-workspace/prop-structure');fs.mkdirSync(out,{recursive:true});
 const manifest={version:1,source:'Original procedural industrial geometry; existing approved raster props retained',props:{}};
 for(const p of PS.CATALOG){
  const views={};for(const r of PS.facings(p.id)){
   if(p.flat&&r)continue;
   const fp=PS.footprintAt(p.id,r),cv=createCanvas(240,240),g=cv.getContext('2d'),ox=72,oy=84;
   PS.setCtx(g);PS.setNow(1000);PS.draw({id:'guide-'+p.id,t:p.id,x:6,y:7,w:fp.w,h:fp.h,r},false,{occupied:false,still:true});
   const d=g.getImageData(0,0,240,240).data;let l=240,t=240,rr=-1,b=-1;
   for(let y=0;y<240;y++)for(let x=0;x<240;x++)if(d[(y*240+x)*4+3]>=160){l=Math.min(l,x);rr=Math.max(rr,x);t=Math.min(t,y);b=Math.max(b,y);}
   if(rr<l)throw Error('Empty '+p.id);
   const key=r?p.id+'-r'+r:p.id,crop={left:l,top:t,width:rr-l+1,height:b-t+1};
   const clipped=await sharp(cv.toBuffer('image/png')).extract(crop).png().toBuffer();
   const scale=Math.min(900/crop.width,900/crop.height);
   await sharp(clipped).resize(Math.round(crop.width*scale),Math.round(crop.height*scale),{kernel:'nearest'}).png().toFile(path.join(out,key+'.png'));
   views[['s','w','n','e'][r]]={key,r,image:key+'.png',footprint:fp,bounds:{x:l-ox,y:t-oy,width:crop.width,height:crop.height},guide:path.relative(root,path.join(out,key+'.png')).replaceAll('\\','/')};
  }
  manifest.props[p.id]={label:p.label,family:p.cat,description:p.desc,flat:!!p.flat,views};
 }
 fs.writeFileSync(path.join(root,'dev/industrial-textures/prop-structure-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log('Exported '+Object.keys(manifest.props).length+' prop structures to '+out);
}
async function prepare(source,id,version='props-v2',seedSpec=''){
 if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw Error('Valid asset id required');
 if(!['props-v2','props-v3'].includes(version))throw Error('Unsupported art version');
 const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const w=info.width,h=info.height,n=w*h,seen=new Uint8Array(n),queue=new Int32Array(n);let head=0,end=0;
 const transparentSeeds=seedSpec?seedSpec.split(';').map(p=>p.split(',').map(Number)):[];
 if(transparentSeeds.some(p=>p.length!==2||!p.every(Number.isInteger)||p[0]<0||p[0]>=w||p[1]<0||p[1]>=h))throw Error('Invalid transparent-hole seed');
 // Preserve true alpha. For opaque generated white/checker backgrounds, remove only
 // near-neutral light pixels connected to the image border; never recolor the subject.
 const hasAlpha=data.some((v,i)=>i%4===3&&v<250);
 if(!hasAlpha){
  const visit=i=>{if(i<0||i>=n||seen[i])return;const p=i*4,lo=Math.min(data[p],data[p+1],data[p+2]),hi=Math.max(data[p],data[p+1],data[p+2]);if(lo<145||hi-lo>25)return;seen[i]=1;queue[end++]=i;};
  for(let x=0;x<w;x++){visit(x);visit((h-1)*w+x);}for(let y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
  // Explicitly inspected background holes (e.g. a cart handle) are enclosed by
  // the subject and cannot be reached from the border. Seed only those regions.
  for(const [x,y]of transparentSeeds){visit(y*w+x);if(!seen[y*w+x])throw Error('Hole seed is not light neutral background: '+x+','+y);}
  while(head<end){const i=queue[head++],x=i%w;if(x)visit(i-1);if(x<w-1)visit(i+1);visit(i-w);visit(i+w);}
 }
 let l=w,t=h,r=-1,b=-1;for(let i=0;i<n;i++){if(seen[i])data[i*4+3]=0;if(data[i*4+3]<16)continue;const x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}
 if(r<l)throw Error('Empty generated subject');
 const out=path.join(root,'frontend/assets/industrial',version);fs.mkdirSync(out,{recursive:true});
 const crop={left:l,top:t,width:r-l+1,height:b-t+1};
 await sharp(data,{raw:{width:w,height:h,channels:4}}).extract(crop).png().toFile(path.join(out,id+'.png'));
 const meta={id,source,sourceWidth:w,sourceHeight:h,crop,sourceAlpha:hasAlpha,transparentSeeds,subjectRgbChanges:0,output:'frontend/assets/industrial/'+version+'/'+id+'.png'};
 const docs=path.join(root,'docs/station-remaster',version);fs.mkdirSync(docs,{recursive:true});fs.writeFileSync(path.join(docs,id+'.export.json'),JSON.stringify(meta,null,2)+'\n');console.log(JSON.stringify(meta));
}
const command=process.argv[2];(command==='guides'?guides():command==='prepare'?prepare(process.argv[3],process.argv[4],process.argv[5],process.argv[6]):Promise.reject(Error('Use guides or prepare <source> <id> [props-v3] [x,y;x,y]'))).catch(e=>{console.error(e);process.exitCode=1;});
