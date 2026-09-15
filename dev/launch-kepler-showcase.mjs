import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {materializeSeedWorkspace,bootSeededSidecar,waitUp,isUp} from '../scripts/lib/seed.mjs';
const require=createRequire(import.meta.url),port=18795,url='http://127.0.0.1:'+port;
if(await isUp(url))throw Error('Port '+port+' is occupied; existing server left intact.');
const scratch=resolve('dev/.scratch-workspace/kepler-showcase');
if(!existsSync(scratch)){
  materializeSeedWorkspace(scratch,{key:'',fullAccess:false});
  globalThis.IndustrialTextures={enabled:()=>true,isRemaster:()=>true,ready:Promise.resolve()};
  const P=require('../frontend/app/propsprites.js'),M=require('../frontend/app/worldmodel.js');
  await IndustrialTextures.ready;
  const {doc,station}=require('./kepler-showcase.cjs').createPreset(P,M);
  const plan=require('../frontend/app/pipeline.js').compileRoutingPlan(station.projectGeometry());
  if(plan.errors.length)throw Error(JSON.stringify(plan.errors));
  const savePath=join(scratch,'agent.save.json'),envelope=JSON.parse(readFileSync(savePath,'utf8'));
  const seed=typeof envelope.doc==='string'?JSON.parse(envelope.doc):envelope.doc;
  seed.station=doc;seed.agent.skin='station_minion';seed.updatedAt=Date.now();
  envelope.doc=seed;envelope.updatedAt=envelope.savedAt=seed.updatedAt;
  writeFileSync(savePath,JSON.stringify(envelope,null,2));
  writeFileSync(join(scratch,'showcase-receipt.json'),JSON.stringify({name:doc.meta.name,rooms:3,corridors:1,props:doc.props.length,belts:Object.keys(doc.belts).length,routingErrors:plan.errors},null,2));
}
const child=bootSeededSidecar({port,scratchDir:scratch,key:'',fullAccess:false});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??0));
if(!await waitUp(url))throw Error('Showcase did not start');
console.log('KEPLER RELAY: '+url+'/?propSet=projection&skinSet=study&showcase=kepler');
