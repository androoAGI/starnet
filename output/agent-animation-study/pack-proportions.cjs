const fs=require('fs'),path=require('path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),out=path.join(__dirname,'proportions-v1'),front=path.join(root,'frontend');
const jobs={a:'ad663e2a-cace-4fc4-a4b1-2c4a88b5f660',b:'07b5d193-db65-49ac-8164-034b830a3119',c:'94203a0b-6c20-42d8-99f4-0a14262a778f'};
(async()=>{const manifest=JSON.parse(fs.readFileSync(path.join(front,'agent-demo/manifest.json'))),sheet=[];let count=0;
for(const[id,job]of Object.entries(jobs)){
 const dir=path.join(front,'assets/agent-demo/proportions',id);fs.mkdirSync(dir,{recursive:true});
 const paths=[];
 for(let i=0;i<9;i++){
  const raw=path.join(out,id+'-walk-'+i+'.png');
  if(!fs.existsSync(raw)){const r=await fetch('https://api.pixellab.ai/mcp/images/'+job+'/download?index='+i);if(!r.ok)throw Error(r.status);fs.writeFileSync(raw,Buffer.from(await r.arrayBuffer()));}
  const m=await sharp(raw).metadata();const dest=path.join(dir,'walk-'+i+'.png');
  await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:raw,left:Math.round((144-m.width)/2),top:24-Math.round((m.height-96)/2)}]).png().toFile(dest);
  paths.push('../agent-demo/proportions/'+id+'/walk-'+i+'.png');
  sheet.push({input:await sharp(dest).resize(144,144,{kernel:'nearest'}).toBuffer(),left:i*148,top:Object.keys(jobs).indexOf(id)*148});count++;
 }
 const ref=path.join(out,id+'-reference.png');await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input:ref,left:24,top:24}]).png().toFile(path.join(dir,'front.png'));
 manifest.sprites['proportion_'+id+'.rot.south']=['../agent-demo/proportions/'+id+'/front.png'];
 manifest.sprites['proportion_'+id+'.walk.south']=paths.slice(1);
}
await sharp({create:{width:9*148,height:3*148,channels:4,background:'#243032'}}).composite(sheet).png().toFile(path.join(out,'walk-contact.png'));
fs.writeFileSync(path.join(front,'agent-demo/manifest.json'),JSON.stringify(manifest));
for(const item of ['agent-proportion-review.html','agent-demo/proportion-review.js','agent-demo/manifest.json','assets/agent-demo/proportions'])fs.cpSync(path.join(front,item),path.join(root,'website/app',item),{recursive:true});
fs.writeFileSync(path.join(out,'jobs.json'),JSON.stringify(jobs,null,2));console.log('Packed '+count+' walk frames + 3 standing poses; mirrored to website.');
})().catch(e=>{console.error(e);process.exitCode=1;});
