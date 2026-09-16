const fs=require('fs'),sharp=require('sharp'),assert=require('assert'),crypto=require('crypto');
const root='output/agent-animation-study',fallback='rollout-20px';
(async()=>{const rows=[],catalog=JSON.parse(fs.readFileSync('frontend/agent-demo/catalog.json'));
for(const item of catalog.skins){const base=root+'/'+(item.motionSource||fallback);if(!fs.existsSync(base+'/jobs'))continue;const names=fs.readdirSync(base+'/jobs').filter(f=>f.startsWith(item.id+'_')&&f.endsWith('.json'));
if(item.motionMethod==='imagegen-sheets'){
 assert.equal(names.length,9,'Expected eight walk sheets and one seat/typing sheet '+item.id);
 const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 for(const name of names){const j=JSON.parse(fs.readFileSync(base+'/jobs/'+name));assert(j.packed,'Unpacked '+name);assert.equal(j.selected.length,8,'Incomplete sheet '+name);assert(Object.keys(j.inputHashes||{}).length>0,'Missing input provenance '+name);const currentInput=Object.entries(j.inputHashes).every(([file,expected])=>hash(file)===expected);for(const [file,expected]of Object.entries(j.selectedHashes)){assert.equal(hash(base+'/packed/'+item.id+'/'+file),expected,'Staged frame changed '+file);assert.equal(hash('frontend/assets/agent-demo/approved-motion/'+item.id+'/'+file),expected,'Selected frame changed '+file);}rows.push({id:item.id,track:j.track||'walk',dir:j.dir||'cardinals+north-type',currentInput});}
 continue;
}
if(item.motionSource)assert.equal(names.length,13,'Missing motion jobs '+item.id);
for(const name of names){const j=JSON.parse(fs.readFileSync(base+'/jobs/'+name));if(j.id!==item.id)continue;if(!j.packed){assert(!item.motionSource,'Unpacked '+name);continue;}let expected=base+'/full-motion/'+j.id+'/refs/'+j.dir+'.png';if(j.track==='type')expected=JSON.parse(fs.readFileSync(base+'/jobs/'+j.id+'_sit_north.json')).lastRaw;const generated=base+'/full-motion/'+j.id+'/minimax/'+j.track+'-'+j.dir+'/'+j.job+'/0.png';if(!fs.existsSync(generated)){assert(!item.motionSource,'Missing generated input '+name);continue;}const a=await sharp(generated).ensureAlpha().raw().toBuffer(),b=await sharp(expected).ensureAlpha().raw().toBuffer();rows.push({id:j.id,track:j.track,dir:j.dir,currentInput:a.equals(b)});}}
const stale=rows.filter(r=>!r.currentInput);fs.writeFileSync(root+'/'+fallback+'/input-validation.json',JSON.stringify({checked:rows.length,stale},null,2)+'\n');console.log({checked:rows.length,stale});if(process.argv.includes('--final'))assert.equal(stale.length,0,'Animations use obsolete reference artwork');})();
