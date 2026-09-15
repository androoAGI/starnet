// Run inside functions.exec's tool orchestration environment, not Node directly.
const root='C:/Users/andro/gen-trees/sprite-reimagine-0914',base='output/agent-animation-study/chrome-cadets-0915',prepared=new Set();
const jobFile=j=>`${base}/jobs/${j.id}_${j.track}_${j.dir}.json`;
const save=(file,value)=>tools.apply_patch('*** Begin Patch\n*** Add File: '+root+'/'+file+'\n+'+JSON.stringify(value,null,2).replaceAll('\n','\n+')+'\n*** End Patch');
async function run(cmd,max=1000){let r=await tools.exec_command({cmd,workdir:root,max_output_tokens:max,yield_time_ms:10000}),output=r.output;while(r.session_id){r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:1000,max_output_tokens:max});output+=r.output;if(r.session_id)await new Promise(resolve=>setTimeout(resolve,1000));}return{...r,output};}
const initial=await run(`node -e "const fs=require('fs'),b='${base}';console.log(JSON.stringify({queue:JSON.parse(fs.readFileSync(b+'/queue.json')),jobs:fs.readdirSync(b+'/jobs').filter(f=>f.endsWith('.json')).map(f=>{const j=JSON.parse(fs.readFileSync(b+'/jobs/'+f));return j.packed?{id:j.id,track:j.track,dir:j.dir,job:j.job,done:true,packed:true,lastRaw:j.lastRaw}:j})}));"`,100000);
const data=JSON.parse(initial.output),queue=data.queue;
for(const j of data.jobs){const target=queue.find(x=>x.id===j.id&&x.track===j.track&&x.dir===j.dir);if(target)Object.assign(target,j);}
let ticks=0;
while(true){
 const resets=await run(`node -e "const fs=require('fs'),p='${base}/reset-requests.json',f='${base}/reset-inflight.json',read=x=>fs.existsSync(x)?JSON.parse(fs.readFileSync(x)):[],q=read(f).concat(read(p));fs.writeFileSync(f,JSON.stringify(q));fs.writeFileSync(p,'[]');console.log(JSON.stringify(q));"`,10000),deferred=[];
 for(const reset of JSON.parse(resets.output)){const j=queue.find(x=>x.id===reset.id&&x.track===reset.track&&x.dir===reset.dir);if(!j)continue;if(j.job&&!j.done&&!j.failed){deferred.push(reset);continue;}await save(`${base}/jobs/history/${j.id}_${j.track}_${j.dir}-${j.job||'unsubmitted'}.json`,j);for(const key of Object.keys(j))delete j[key];Object.assign(j,reset);await save(jobFile(j),j);}
 if(JSON.parse(resets.output).length)await save(base+'/reset-inflight.json',deferred);
 if(!queue.some(j=>!j.packed&&!j.failed)&&!deferred.length)break;
 const rs=await run(`node -e "const fs=require('fs'),b='${base}/full-motion';console.log(JSON.stringify({ready:fs.readdirSync(b).filter(id=>['rotation','character'].some(n=>{try{return JSON.parse(fs.readFileSync(b+'/'+id+'/'+n+'.json')).detail?.startsWith('status: completed')}catch{return false}})),prompts:JSON.parse(fs.readFileSync('${base}/motion-prompts.json'))}));"`,6000),state=JSON.parse(rs.output),ready=new Set(state.ready),prompts=state.prompts;
 let active=queue.filter(j=>j.job&&!j.done&&!j.failed);
 for(const j of queue){
  if(active.length>=(prompts.maxActive||8))break;if(j.packed||j.failed||j.job||!ready.has(j.id))continue;
  let source=`${base}/full-motion/${j.id}/refs/${j.dir}.png`;
  if(j.track==='type'){const seat=queue.find(s=>s.id===j.id&&s.track==='sit'&&s.dir==='north');if(!seat?.packed)continue;source=seat.lastRaw;}
  if(!prepared.has(j.id)){const p=await run(`node output/agent-animation-study/chrome-cadets-0915/prepare-refs.cjs ${j.id}`);if(p.exit_code!==0){j.error=p.output;j.failed=true;await save(jobFile(j),j);notify({id:j.id,preparationError:p.output});continue;}prepared.add(j.id);}
  const b=await run(`node -e "process.stdout.write(require('fs').readFileSync('${source}').toString('base64'))"`,30000);
  const description=(j.promptOverride||(j.track==='sit'&&j.dir==='north'?prompts.sitNorth:prompts[j.track])).replaceAll('DIRECTION',j.dir);
  const args={first_frame_base64:b.output.trim(),frame_count:j.track==='walk'?8:4,direction:j.dir,enhance_prompt:false,no_background:true,description};if(j.pinLast)args.last_frame_base64=b.output.trim();
  const r=await tools.mcp__pixellab__animate_image_pixminimax(args);
  j.request=r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');j.job=j.request.match(/job_id:\s*([a-f0-9-]{36})/)?.[1];j.source=source;
  if(!j.job){if(/slot|concurren|limit/i.test(j.request)){await save(jobFile(j),j);break;}j.attempts=(j.attempts||0)+1;j.failed=j.attempts>=3||/safety|moderation|policy/i.test(j.request);await save(jobFile(j),j);if(j.failed)notify({id:j.id,track:j.track,dir:j.dir,error:j.request});continue;}
  await save(jobFile(j),j);active.push(j);
 }
 active=queue.filter(j=>j.job&&!j.done&&!j.failed);
 if(active.length)await new Promise(resolve=>setTimeout(resolve,45000));
 const results=await Promise.allSettled(active.map(j=>tools.mcp__pixellab__get_image({job_id:j.job})));
 for(let i=0;i<results.length;i++){const result=results[i],j=active[i];if(result.status!=='fulfilled'){j.pollError=String(result.reason);await save(jobFile(j),j);continue;}j.result=result.value.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');if(j.result.startsWith('status: completed'))j.done=true;else if(j.result.startsWith('status: failed'))j.failed=true;await save(jobFile(j),j);}
 for(const j of queue.filter(j=>j.done&&!j.packed&&!j.failed)){
  const p=await run(`node output/agent-animation-study/chrome-cadets-0915/pack-motion.cjs ${jobFile(j)}`);if(p.exit_code!==0){j.failed=true;j.error=p.output;await save(jobFile(j),j);notify({id:j.id,track:j.track,dir:j.dir,packingError:p.output});continue;}
  const updated=await run(`node -e "process.stdout.write(require('fs').readFileSync('${jobFile(j)}','utf8'))"`,20000);Object.assign(j,JSON.parse(updated.output));
 }
 const progress={total:queue.length,packed:queue.filter(j=>j.packed).length,active:queue.filter(j=>j.job&&!j.done&&!j.failed).length,failed:queue.filter(j=>j.failed).map(j=>({id:j.id,track:j.track,dir:j.dir,error:j.error||j.result||j.request})),completedSkins:[...new Set(queue.map(j=>j.id))].filter(id=>queue.filter(j=>j.id===id).every(j=>j.packed))};
 await save(base+'/motion-progress.json',progress);notify(progress);

 if(!active.length)await new Promise(resolve=>setTimeout(resolve,45000));
 if(++ticks>500){notify('Scheduler stopped at bounded tick limit.');break;}
}
store('minimaxCompletedQueue',queue);text({packed:queue.filter(j=>j.packed).length,failed:queue.filter(j=>j.failed).length});

