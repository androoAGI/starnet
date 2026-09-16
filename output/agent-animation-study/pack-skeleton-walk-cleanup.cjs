const fs=require('fs'), sharp=require('sharp');
const base='output/agent-animation-study/approved-motion';
const source=base+'/walk-fixes/skeleton-west-clean-source.png';
async function bounds(input){const {data,info}=await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject:true});let l=info.width,r=-1,t=info.height,b=-1;for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>100){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);}return{left:l,top:t,width:r-l+1,height:b-t+1};}
(async()=>{
 const m=await sharp(source).metadata(),jobs=JSON.parse(fs.readFileSync(base+'/walk-fixes.json'));
 const j=jobs.find(j=>j.id==='skeleton'&&j.dir==='west'),dir=`${base}/walk-fixes/skeleton/west/${j.job}`;
 const cells=[];
 for(let i=0;i<9;i++){const l=Math.round(i*m.width/9),r=Math.round((i+1)*m.width/9);const c=await sharp(source).extract({left:l,top:0,width:r-l,height:m.height}).png().toBuffer();cells.push({data:c,box:await bounds(c)});}
 const scale=76/cells[0].box.height,layers=[];
 for(let i=0;i<9;i++){
  const original=`${dir}/${i}.png`,b=await bounds(original),cell=cells[i];
  const input=await sharp(cell.data).extract(cell.box).resize({height:Math.round(cell.box.height*scale)}).png().toBuffer(),size=await sharp(input).metadata();
  const packed=await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input,left:Math.round(b.left+b.width/2-size.width/2),top:b.top}]).png().toBuffer();
  // Reference frame zero stays exact. Only the eight generated poses need the cleanup.
  if(i)for(const root of ['frontend','website/app'])fs.writeFileSync(`${root}/assets/agent-demo/approved-motion/skeleton/walk_west_${i}.png`,packed);
  layers.push({input:i?packed:original,left:i*144,top:0});
 }
 await sharp({create:{width:1296,height:144,channels:4,background:'#273237'}}).composite(layers).png().toFile(base+'/walk-fixes/skeleton-west-clean.png');
 console.log('Packed eight corrected bone-limb poses');
})();
