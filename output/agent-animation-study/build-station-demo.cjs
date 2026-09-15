// Mechanical packing only: preserves generated pixels and the standing anchor.
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const root=path.resolve(__dirname,'../..'),front=path.join(root,'frontend');
const source='C:/Users/andro/gen-trees/prop-coordination-0914/frontend';
const demo=path.join(front,'agent-demo');fs.mkdirSync(demo,{recursive:true});
const modules=['industrialtextures','authored-prop-content','authored-service-content','authored-prop-motion','authored-machine-config','approved-sheet-effects','projection-prop-effects','propremaster','authored-surface-mounts','propsprites','stationbake','worldsurface'];
for(const name of modules)fs.copyFileSync(path.join(source,'app',name+'.js'),path.join(demo,name+'.js'));
for(const folder of ['remaster','calibration','approved-sheet','projection-correction'])fs.cpSync(path.join(source,'assets/industrial',folder),path.join(front,'assets/industrial',folder),{recursive:true});
let html=fs.readFileSync(path.join(front,'index.html'),'utf8');
for(const name of modules)html=html.replace('src="app/'+name+'.js"','src="agent-demo/'+name+'.js"');
const extra=modules.filter(n=>!['industrialtextures','propsprites','stationbake','worldsurface'].includes(n));
html=html.replace('<script src="agent-demo/propsprites.js">',extra.map(n=>'<script src="agent-demo/'+n+'.js"></script>').join('\n')+'\n<script src="agent-demo/propsprites.js">');
html=html.replace('src="js/assets.js"','src="agent-demo/sprites.js"').replace('</body>','<script src="agent-demo/demo.js"></script>\n</body>');
fs.writeFileSync(path.join(front,'agent-station-demo.html'),html);
let engine=fs.readFileSync(path.join(front,'js/assets.js'),'utf8');
engine=engine.replace("fetch('assets/sprites/manifest.json'","fetch('agent-demo/manifest.json'");
fs.writeFileSync(path.join(demo,'sprites.js'),engine);
(async()=>{
 const original=JSON.parse(fs.readFileSync(path.join(front,'assets/sprites/manifest.json')));
 const study=JSON.parse(fs.readFileSync(path.join(front,'assets/agent-animation-0914/manifest.json')));
 let count=0;
 for(const [id,c]of Object.entries(study.characters)){
  const set='industrial_'+id;
  for(const [track,dirs]of Object.entries(c.tracks))for(const [dir,files]of Object.entries(dirs)){
   const a=c.anchors[dir],out=[];
   for(let i=0;i<files.length;i++){
    const input=path.join(front,'assets/agent-animation-0914',files[i]);const m=await sharp(input).metadata();
    const left=Math.round(64-((a.left+a.right+1)/2+(m.width-a.width)/2));
    const top=Math.round(112-(a.bottom+1+(m.height-a.height)/2));
    const rel='../agent-demo/frames/'+id+'/'+track+'_'+dir+'_'+i+'.png';
    const dest=path.join(front,'assets/sprites',rel);fs.mkdirSync(path.dirname(dest),{recursive:true});
    await sharp({create:{width:144,height:144,channels:4,background:'#00000000'}}).composite([{input,left:left+8,top}]).png().toFile(dest);
    out.push(rel);count++;
   }
   const key=track==='rotations'?'rot':track==='idle'?'idle':track;
   original.sprites[set+'.'+key+'.'+dir]=track==='sit'?[out.at(-1)]:track==='walk'?out.slice(1):out;
  }
  const portraitDir=path.join(front,'assets/sprites',set);fs.mkdirSync(portraitDir,{recursive:true});
  fs.copyFileSync(path.join(front,'assets/agent-demo/frames',id,'rotations_south_0.png'),path.join(portraitDir,'rot_south.png'));
  fs.cpSync(portraitDir,path.join(root,'website/app/assets/sprites',set),{recursive:true});
 }
 for(const base of [front,path.join(root,'website/app')]){
  const file=path.join(base,'assets/sprites/manifest.json'),catalog=JSON.parse(fs.readFileSync(file));
  for(const id of Object.keys(study.characters))catalog.sprites['industrial_'+id+'.rot.south']=['industrial_'+id+'/rot_south.png'];
  fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');
 }
 fs.writeFileSync(path.join(demo,'manifest.json'),JSON.stringify(original));
 for(const folder of ['agent-demo','assets/agent-demo','assets/industrial/remaster','assets/industrial/calibration','assets/industrial/approved-sheet','assets/industrial/projection-correction'])fs.cpSync(path.join(front,folder),path.join(root,'website/app',folder),{recursive:true});
 fs.copyFileSync(path.join(front,'agent-station-demo.html'),path.join(root,'website/app/agent-station-demo.html'));
 console.log('Packed '+count+' anchored frames and isolated station demo.');
})().catch(e=>{console.error(e);process.exitCode=1;});
