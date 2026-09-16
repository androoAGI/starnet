// Separate seeded sidecar: catalog switching never reaches the user's preview save.
import {existsSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {materializeSeedWorkspace,bootSeededSidecar,waitUp,isUp} from '../scripts/lib/seed.mjs';
const port=18796,url='http://127.0.0.1:'+port,scratch=resolve('dev/.scratch-workspace/remaster-audit');
if(await isUp(url))throw Error('Audit port occupied; existing process untouched.');
if(!existsSync(scratch)){
  materializeSeedWorkspace(scratch,{key:'',fullAccess:false});
  copyFileSync(resolve('dev/.scratch-workspace/kepler-showcase/agent.save.json'),join(scratch,'agent.save.json'));
}
const child=bootSeededSidecar({port,scratchDir:scratch,key:'',fullAccess:false});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??0));
if(!await waitUp(url))throw Error('Audit sidecar failed to start');
console.log(url+'/?propSet=projection&skinSet=study&remasterAudit=1');
