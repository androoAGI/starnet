/* The separate client's authored acceptance station. Validation is the default; writes are dev-fixture-only. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const W=require('../frontend/app/worldmodel.js'),catalog=require('../frontend/world-next/catalog.json').items;
const specs=new Map(catalog.map(x=>[x.id,x]));
function createStation(now=Date.now()){
 const d=W.defaultDoc(now),spawn=d.meta.spawnRoomId;d.meta.name='NEW HORIZON';
 Object.assign(d.rooms[spawn],{name:'THE ATRIUM',kind:'hab',rects:[{x1:0,y1:0,x2:19,y2:12},{x1:3,y1:-2,x2:16,y2:-1},{x1:3,y1:13,x2:16,y2:14}],floorStyle:'bone',floorMat:'ceramic'});
 W.setPropRules(id=>specs.get(id));const m=W.create(d),ok=(r,label)=>{assert.ok(r&&r.ok,label+': '+JSON.stringify(r));return r;};
 const room=(name,kind,rect,floorStyle,floorMat)=>ok(m.addRoom({name,kind,rect,floorStyle,floorMat}),name).id;
 room('OBSERVATORY','bridge',{x1:3,y1:-14,x2:16,y2:-6},'cobalt','panel');
 room('FABRICATION','foundry',{x1:-16,y1:1,x2:-5,y2:12},'rust','diamond');
 room('BOTANICAL LAB','lab',{x1:24,y1:-1,x2:37,y2:12},'verdant','tile');
 room('CREW QUARTERS','quarters',{x1:4,y1:19,x2:16,y2:28},'oak','plank');
 for(const [name,rect] of [['NORTH BRIDGE',{x1:8,y1:-5,x2:11,y2:-3}],['WEST BRIDGE',{x1:-4,y1:5,x2:-1,y2:8}],['EAST BRIDGE',{x1:20,y1:4,x2:23,y2:7}],['SOUTH BRIDGE',{x1:8,y1:15,x2:11,y2:18}]])ok(m.placeHallway({name,rect,floorStyle:'teal',floorMat:'runner'}),name);
 const put=(t,x,y,agentId)=>{const s=specs.get(t);assert.ok(s,t);return ok(m.addProp({t,x,y,w:s.w,h:s.h,block:s.blocks!==false,agentId}),t+'@'+x+','+y).id;};
 // Sculptural shared atrium: a navigation instrument, seating, foliage and useful station equipment.
 put('holotable',8,5);put('plant',2,1);put('tallplant',17,1);put('plant',2,11);put('plant',17,11);
 put('couch',4,10);put('loungetable',5,8);put('bar',14,9);put('stool',15,10);put('stool',17,10);
 put('war_intelcab',1,4);put('core',17,3);put('missionboard',6,-2);put('trophycase',13,1);
 put('rug',9,10);put('jukebox',1,8);put('arc_floorlight',4,1);put('arc_floorlight',15,1);
 // Real agent workstations and bays. The same IDs retain roster ownership and capability semantics.
 put('commswall',5,-14);put('desk',6,-11,'agent');put('desklamp',8,-11);put('rackV',15,-13);
 put('plant',4,-13);put('comms_dish',13,-10);const inbox=put('intake',4,-8),nova=put('bay',10,-8,'agent');
 put('workbench',-14,3);put('desk',-9,3,'world-ember');put('rack',-15,1);put('crate',-8,7);
 put('rackV',-6,1);put('arc_floorlight',-14,10);put('core',-6,9);const ember=put('bay',-11,9,'world-ember');
 put('desk',29,2,'world-fern');put('desklamp',31,2);put('terrarium',26,2);put('tank',34,0);
 for(const [x,y] of [[25,0],[28,0],[32,0],[36,0],[25,10],[35,10]])put('plant',x,y);
 put('loungetable',31,8);put('stool',32,9);put('studio',34,5);const fern=put('bay',27,8,'world-fern'),outbox=put('outbox',34,8);
 put('bunk',5,20);put('bunk',13,20);put('couch',7,25);put('lowtable',8,23);put('plant',5,27);put('plant',15,27);put('bookshelf',5,24);
 // The routing gantries form one readable line; each assigned agent still works in its own wing.
 for(const [id,x] of [[inbox,3],[nova,6],[ember,9],[fern,12],[outbox,15]]){const p=m.propById(id);ok(m.moveProp(id,x-p.x,-8-p.y),'gantry position');}
 for(const [a,b] of [[inbox,nova],[nova,ember],[ember,fern],[fern,outbox]])ok(m.connectBelt(a,b),'real workflow belt '+a+' -> '+b);
 const geo=m.projectGeometry(),plan=require('../frontend/app/pipeline.js').compileRoutingPlan(geo);
 assert.equal((plan.errors||[]).filter(e=>!e.warn).length,0,JSON.stringify(plan.errors));
 return m.serialize();
}
async function main(){const args=process.argv.slice(2);assert.ok(args.every(x=>x==='--write'),'Only --write is supported');const station=createStation();
 console.log(JSON.stringify({rooms:Object.values(station.rooms).filter(r=>r.kind!=='corridor').length,halls:Object.values(station.rooms).filter(r=>r.kind==='corridor').length,props:station.props.length,belts:Object.keys(station.belts).length}));
 if(!args.includes('--write'))return;
 const scratch=path.resolve(__dirname,'.scratch-workspace'),marker=path.join(scratch,'.world-next-proof.json');
 assert.ok(!fs.lstatSync(scratch).isSymbolicLink(),'Refuse linked scratch');assert.equal(JSON.parse(fs.readFileSync(marker)).fixture,'world-next','Only the existing named World Next dev fixture may be replaced');
 const port=Number(process.env.SKYNET_PORT||9207);const up=await new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port});s.setTimeout(700);const end=v=>{s.destroy();resolve(v);};s.once('connect',()=>end(true));s.once('error',()=>end(false));s.once('timeout',()=>end(false));});assert.ok(!up,'Stop the isolated sidecar before replacing the dev scene');
 const save=path.join(scratch,'agent.save.json');assert.ok(!fs.lstatSync(save).isSymbolicLink());const wrapper=JSON.parse(fs.readFileSync(save));const backup=path.join(scratch,'.first-world-preview.save.json');if(!fs.existsSync(backup))fs.copyFileSync(save,backup,fs.constants.COPYFILE_EXCL);
 wrapper.doc.station=station;wrapper.updatedAt=wrapper.savedAt=wrapper.doc.updatedAt=Date.now();const tmp=save+'.fresh.tmp';fs.writeFileSync(tmp,JSON.stringify(wrapper,null,2)+'\n');fs.renameSync(tmp,save);console.log('Fresh station saved in existing isolated fixture; prior station backed up.');
}
module.exports={createStation};if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
