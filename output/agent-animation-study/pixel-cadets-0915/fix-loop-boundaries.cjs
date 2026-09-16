const fs=require('fs'),base='output/agent-animation-study/pixel-cadets-0915',p=base+'/pack-motion.cjs';
let s=fs.readFileSync(p,'utf8');s=s.replace("j.track==='sit'?[paths.at(-1)]:paths.slice(1)","j.track==='sit'?[paths.at(-1)]:j.track==='walk'&&j.pinLast?[...paths.slice(1,-1),paths[0]]:paths.slice(1)");fs.writeFileSync(p,s);
// Run the manifest selection pass only when the scheduler is stopped.
if(!process.argv.includes('--select'))process.exit(0);
const m=JSON.parse(fs.readFileSync(base+'/manifest.json'));let n=0;
for(const file of fs.readdirSync(base+'/jobs').filter(x=>x.endsWith('.json'))){const j=JSON.parse(fs.readFileSync(base+'/jobs/'+file));if(j.packed&&j.track==='walk'&&j.pinLast){const key='approved_'+j.id+'.walk.'+j.dir;m.sprites[key][7]='../agent-demo/approved-motion/'+j.id+'/walk_'+j.dir+'_0.png';n++;}}
fs.writeFileSync(base+'/manifest.json',JSON.stringify(m)+'\n');console.log({cleanLoopBoundaries:n});
