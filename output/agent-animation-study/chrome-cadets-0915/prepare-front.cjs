const fs=require('fs'),path=require('path'),sharp=require('sharp');
const base='output/agent-animation-study/chrome-cadets-0915';
(async()=>{const id=process.argv[2];if(!/^[a-z_]+$/.test(id))throw Error('Invalid skin');
const src=base+'/'+id+'-source.png';const {data,info}=await sharp(src).ensureAlpha().raw().toBuffer({resolveWithObject:true});
let l=info.width,t=info.height,r=-1,b=-1;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
if(r<l)throw Error('Empty sprite');const crop=await sharp(src).extract({left:l,top:t,width:r-l+1,height:b-t+1}).resize({height:76}).png().toBuffer();const m=await sharp(crop).metadata();if(m.width>92)throw Error('Sprite too wide');
const dir=base+'/full-motion/'+id;fs.mkdirSync(dir,{recursive:true});
await sharp({create:{width:96,height:96,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((96-m.width)/2),top:12}]).png().toFile(dir+'/front.png');
console.log(fs.readFileSync(dir+'/front.png').toString('base64'));
})();
