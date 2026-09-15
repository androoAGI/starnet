const fs = require('fs'), sharp = require('sharp');
const base = __dirname;
async function bounds(input) {
  const {data, info} = await sharp(input).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  // Find the subject bounds without letting isolated alpha specks enlarge the crop.
  const seen=new Uint8Array(info.width*info.height),parts=[];
  for(let start=0;start<seen.length;start++) {
    if(seen[start]||data[start*4+3]<=100)continue;
    const queue=[start];seen[start]=1;let l=info.width,t=info.height,r=-1,b=-1;
    for(let q=0;q<queue.length;q++) {
      const p=queue[q],x=p%info.width,y=Math.floor(p/info.width);
      l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
      for(const n of [x>0?p-1:-1,x<info.width-1?p+1:-1,y>0?p-info.width:-1,y<info.height-1?p+info.width:-1])if(n>=0&&!seen[n]&&data[n*4+3]>100){seen[n]=1;queue.push(n);}
    }
    parts.push({l,t,r,b,size:queue.length});
  }
  const max=Math.max(...parts.map(p=>p.size)),subject=parts.filter(p=>p.size>=max*.005);
  const l=Math.min(...subject.map(p=>p.l)),t=Math.min(...subject.map(p=>p.t)),r=Math.max(...subject.map(p=>p.r)),b=Math.max(...subject.map(p=>p.b));
  return {left:l,top:t,width:r-l+1,height:b-t+1};
}
(async()=>{
  const records=[];
  for(const id of ['android','blank_blue','blank_green','blank_red','blank_amber']) {
    for(const dir of ['south','south-east','north-east','north-west','south-west']) {
      const src=base+'/'+id+'-'+dir+'-walk-repair.png';
      if(!fs.existsSync(src)) continue;
      const meta=await sharp(src).metadata(),files=[];
      for(let i=0;i<8;i++) {
        const left=Math.floor(i%4*meta.width/4),top=Math.floor(Math.floor(i/4)*meta.height/2);
        const cell=await sharp(src).extract({left,top,width:Math.floor(meta.width/4),height:Math.floor(meta.height/2)}).png().toBuffer();
        const b=await bounds(cell),crop=await sharp(cell).extract(b).resize({height:76,kernel:'nearest'}).png().toBuffer();
        const m=await sharp(crop).metadata(),name='walk_'+dir+'_repair_'+i+'.png';
        await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:crop,left:Math.floor((144-m.width)/2),top:36}]).png().toFile(base+'/packed/'+id+'/'+name);
        files.push('../agent-demo/approved-motion/'+id+'/'+name);
      }
      records.push({id,dir,source:src.split(/[/\\]/).pop(),method:'Built-in ImageGen edit of generated eight-frame walk; mechanical equal-cell extraction, height normalization and transparent atlas packing',files});
    }
  }
  fs.writeFileSync(base+'/walk-repairs.json',JSON.stringify(records,null,2)+'\n');
  if(process.argv.includes('--select')) {
    const p=base+'/manifest.json',m=JSON.parse(fs.readFileSync(p));
    for(const r of records) m.sprites['approved_'+r.id+'.walk.'+r.dir]=r.files;
    fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');
  }
  console.log({repairedTracks:records.length,frames:records.length*8,selected:process.argv.includes('--select')});
})();
