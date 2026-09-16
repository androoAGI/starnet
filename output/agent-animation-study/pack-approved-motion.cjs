const fs=require('fs'),path=require('path'),sharp=require('sharp');
const base='output/agent-animation-study/approved-motion',runtime='frontend/assets/agent-demo/approved-motion';
async function pad(input,dest){const m=await sharp(input).metadata();if(m.width>144||m.height>144)throw Error('oversize '+input);fs.mkdirSync(path.dirname(dest),{recursive:true});await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input,left:Math.round((144-m.width)/2),top:24-Math.round((m.height-96)/2)}]).png().toFile(dest);}
(async()=>{const jobs=JSON.parse(fs.readFileSync(base+'/jobs.json')),ids=Object.keys(JSON.parse(fs.readFileSync(base+'/characters.json')));let count=0;
for(const id of ids)for(const f of fs.readdirSync(base+'/'+id+'/refs'))await pad(base+'/'+id+'/refs/'+f,runtime+'/'+id+'/rot_'+f);
for(const j of jobs.filter(j=>j.done)){
 const n=j.frames||Number(j.result.match(/frames: (\d+)/)?.[1]);if(!n)throw Error('No frame count '+j.job);j.frames=n;
 const rawDir=base+'/'+j.id+'/'+j.track+'/'+j.dir+(j.revision?'/'+j.job:'');fs.mkdirSync(rawDir,{recursive:true});
 const download=j.result.match(/https:\/\/api\.pixellab\.ai\/mcp\/images\/[^\s]+\/download(?:\?index=\d+)?/)?.[0];if(!download)throw Error('No verified download '+j.job);
 for(let i=0;i<n;i++){
  const raw=rawDir+'/'+i+'.png',dest=runtime+'/'+j.id+'/'+j.track+'_'+j.dir+'_'+i+'.png';
  if(!fs.existsSync(raw)){const url=new URL(download);url.searchParams.set('index',i);let res;for(let retry=0;retry<3;retry++){res=await fetch(url);if(res.ok)break;}if(!res.ok)throw Error('download '+res.status+' '+j.job);fs.writeFileSync(raw,Buffer.from(await res.arrayBuffer()));}
  if(j.revision||!fs.existsSync(dest))await pad(raw,dest);count++;
 }
}
const dirs=['south','south-east','east','north-east','north','north-west','west','south-west'];
for(const id of ids){for(const track of ['walk','sit','type']){const layers=[],list=track==='walk'?dirs:track==='type'?['north']:['south','east','north','west'];for(let y=0;y<list.length;y++){const j=jobs.find(j=>j.id===id&&j.track===track&&j.dir===list[y]&&j.done);if(!j)continue;for(let x=0;x<j.frames;x++){const p=runtime+'/'+id+'/'+track+'_'+list[y]+'_'+x+'.png';if(fs.existsSync(p))layers.push({input:p,left:x*144,top:y*144});}}if(layers.length)await sharp({create:{width:144*(track==='walk'?9:5),height:144*list.length,channels:4,background:'#273237'}}).composite(layers).png().toFile(base+'/'+id+'-'+track+'-contact.png');}}
if(process.argv.includes('--final')){
 if(jobs.filter(j=>j.done).length!==65)throw Error('All 65 motion jobs required before activation');
 const manifest=JSON.parse(fs.readFileSync('frontend/agent-demo/manifest.json'));
 for(const id of ids){for(const dir of dirs)manifest.sprites['approved_'+id+'.rot.'+dir]=['../agent-demo/approved-motion/'+id+'/rot_'+dir+'.png'];for(const j of jobs.filter(j=>j.id===id)){const indices=j.track==='sit'?[j.frames-1]:Array.from({length:j.frames-1},(_,i)=>i+1);manifest.sprites['approved_'+id+'.'+j.track+'.'+j.dir]=indices.map(i=>'../agent-demo/approved-motion/'+id+'/'+j.track+'_'+j.dir+'_'+i+'.png');}}
 for(const prefix of ['frontend/','website/app/']){const file=prefix+'assets/sprites/manifest.json',catalog=JSON.parse(fs.readFileSync(file));for(const id of ids){const dir=prefix+'assets/sprites/approved_'+id;fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(runtime+'/'+id+'/rot_south.png',dir+'/rot_south.png');catalog.sprites['approved_'+id+'.rot.south']=['approved_'+id+'/rot_south.png'];}fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');}
 fs.writeFileSync('frontend/agent-demo/manifest.json',JSON.stringify(manifest)+'\n');fs.cpSync(runtime,'website/app/assets/agent-demo/approved-motion',{recursive:true});fs.copyFileSync('frontend/agent-demo/manifest.json','website/app/agent-demo/manifest.json');
}
console.log('Packed '+count+' motion source frames and 40 rotations');})();
