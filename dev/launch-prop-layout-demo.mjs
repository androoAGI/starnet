// Local art review: copies station geometry only into a separate seeded sidecar.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {materializeSeedWorkspace,bootSeededSidecar,waitUp,isUp} from '../scripts/lib/seed.mjs';

const source=process.argv[2];
if(!source)throw Error('Usage: node dev/launch-prop-layout-demo.mjs <source agent.save.json>');
const port=18794,url='http://127.0.0.1:'+port;
if(await isUp(url))throw Error('Port '+port+' already has a server; leave it untouched.');
const scratch=resolve('dev/.scratch-workspace/prop-layout-demo');
if(!existsSync(scratch))materializeSeedWorkspace(scratch);
const marker=join(scratch,'.prop-layout-source.json');
if(!existsSync(marker)){
 const envelope=JSON.parse(readFileSync(source,'utf8'));
 const sourceDoc=typeof envelope.doc==='string'?JSON.parse(envelope.doc):envelope.doc;
 if(!sourceDoc?.station?.rooms||!Array.isArray(sourceDoc.station.props))throw Error('Missing station geometry');
 const savePath=join(scratch,'agent.save.json'),seed=JSON.parse(readFileSync(savePath,'utf8'));
 seed.doc.station=structuredClone(sourceDoc.station);
 seed.doc.agent.skin='station_minion';
 seed.updatedAt=seed.savedAt=seed.doc.updatedAt=Date.now();
 writeFileSync(savePath,JSON.stringify(seed,null,2));
 writeFileSync(marker,JSON.stringify({source:resolve(source),rooms:Object.keys(sourceDoc.station.rooms).length,props:sourceDoc.station.props.length},null,2));
}
const child=bootSeededSidecar({port,scratchDir:scratch,key:'',fullAccess:false});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
child.on('exit',code=>process.exit(code??0));
if(!await waitUp(url))throw Error('Demo server did not start');
console.log('Projection demo ready: '+url+'/?propSet=projection');
console.log(readFileSync(marker,'utf8'));
