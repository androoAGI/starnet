// Furnished station preview: geometry-only copy, leaving the existing saves untouched.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {materializeSeedWorkspace,bootSeededSidecar,waitUp,isUp} from '../scripts/lib/seed.mjs';
const require=createRequire(import.meta.url),port=18797,url='http://127.0.0.1:'+port;
if(await isUp(url))throw Error('Preview port occupied; existing process untouched.');
const scratch=resolve('dev/.scratch-workspace/capability-default-station');
if(!existsSync(scratch)){
 materializeSeedWorkspace(scratch);
 globalThis.IndustrialTextures={enabled:()=>true,isRemaster:()=>true,ready:Promise.resolve()};
 globalThis.PropRemaster={enabled:()=>false,isProjection:()=>true,revision:()=>0,ready:Promise.resolve()};
 const P=require('../frontend/app/propsprites.js'),M=require('../frontend/app/worldmodel.js');M.setPropRules(id=>P.spec(id));
 const original=JSON.parse(readFileSync('dev/.scratch-workspace/prop-layout-demo/agent.save.json','utf8'));
 const source=typeof original.doc==='string'?JSON.parse(original.doc):original.doc;
 const doc=structuredClone(source.station);
 for(const [id,type]of [['p4','comms_dish'],['p6','gigs_servercart']]){const p=doc.props.find(p=>p.id===id);if(!p)throw Error('Missing station prop '+id);const f=P.footprintAt(type,0);Object.assign(p,{t:type,w:f.w,h:f.h,r:0});}
 const targets=doc.props.filter(p=>P.STARTER.includes(p.t));
 if(new Set(targets.map(p=>p.t)).size!==5)throw Error('Missing capability prop');
 const checks=targets.map(p=>({id:p.id,type:p.t,...M.deserialize({...doc,props:doc.props.filter(q=>q.id!==p.id)}).canPlaceProp(p.t,p.x,p.y,p.w,p.h)}));
 if(checks.some(c=>!c.ok))throw Error(JSON.stringify(checks));
 const savePath=join(scratch,'agent.save.json'),envelope=JSON.parse(readFileSync(savePath,'utf8'));
 envelope.doc.station=doc;envelope.doc.agent.skin='station_minion';envelope.updatedAt=envelope.savedAt=envelope.doc.updatedAt=Date.now();
 writeFileSync(savePath,JSON.stringify(envelope,null,2));writeFileSync(join(scratch,'placement-receipt.json'),JSON.stringify({rooms:doc.order.length,props:doc.props.length,checks},null,2));
}
const child=bootSeededSidecar({port,scratchDir:scratch,key:'',fullAccess:false});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>process.exit(code??0));
if(!await waitUp(url))throw Error('Preview did not start');
console.log(url+'/?propSet=projection&skinSet=study');
console.log(readFileSync(join(scratch,'placement-receipt.json'),'utf8'));
