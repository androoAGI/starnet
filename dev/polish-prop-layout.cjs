'use strict';
// One explicit, versioned furnishing pass on the isolated art demo only.
const VERSION = 'projection-polish-1';
function polishStation(source, specFor) {
  const station = structuredClone(source), changed = [], added = [];
  const byId = new Map(station.props.map(p => [p.id, p]));
  function update(id, patch) {
    const prop = byId.get(id); if (!prop) throw Error('Missing demo placement '+id);
    changed.push({id, before: {...prop}, after: {...prop,...patch}}); Object.assign(prop,patch);
  }
  // This booth sits ABOVE its table and must look south, toward the diners.
  update('p68',{r:0});
  // The accepted compact desk stays 2×1. These three desk2 candidates require 3×1.
  update('p172',{x:14,w:3}); update('p173',{x:10,w:3}); update('p176',{w:3});
  const rooms = {
    r1:['OBSERVATORY','sterile','panel'],
    r16:['MESS & LOUNGE','walnut','plank'], r17:['CREW RECREATION','walnut','plank'],
    r12:['DISPATCH','sterile','alloy'], r13:['OPERATIONS','sterile','alloy'],
    r24:['RESEARCH','sterile','panel'], r89:['RESEARCH','sterile','panel'],
    r25:['COMMUNICATIONS','hull','alloy'], r86:['COMMUNICATIONS','hull','alloy'],
    r23:['FABRICATION','rust','tread'], r88:['FABRICATION','rust','tread'],
    r22:['LOGISTICS','onyx','rubber'], r87:['LOGISTICS','onyx','rubber'],
    r36:['ARCHIVE','walnut','plank'], r37:['SIGNAL ROOM','sterile','panel'],
    r32:['CREW SUPPORT','walnut','parquet'], r33:['MAINTENANCE','rust','tread']
  };
  for(const [id,[name,floorStyle,floorMat]] of Object.entries(rooms)) {
    if(!station.rooms[id])throw Error('Missing demo room '+id);
    Object.assign(station.rooms[id],{name,floorStyle,floorMat});
  }
  function add(id,t,x,y,mount) {
    if(byId.has(id))throw Error('Duplicate polish prop '+id);
    const spec=specFor(t);if(!spec)throw Error('Unknown prop '+t);
    const p={id,t,x,y,w:spec.w,h:spec.h,r:0};
    if(spec.blocks===false)p.block=false;
    if(mount)p.mount=mount;
    station.props.push(p);byId.set(id,p);added.push(p);
  }
  add('polish-archive-books','bookshelf',-2,-29);
  add('polish-archive-locker','industrial_locker',3,-29);
  add('polish-archive-planter','industrial_planter',-3,-22);
  add('polish-signal-rack','rackV',12,-28);
  add('polish-signal-drawers','industrial_drawerbank',18,-23);
  add('polish-support-books','bookshelf',3,38);
  add('polish-support-table','lowtable',-2,38);
  add('polish-support-coffee','coffee',-1,38,'surface');
  add('polish-maintenance-drawers','industrial_drawerbank',13,38);
  add('polish-maintenance-tools','toolbox',17,38);
  add('polish-maintenance-cab','industrial_servicecab',20,37);
  add('polish-research-books','bookshelf',-43,-19);
  add('polish-comms-locker','industrial_locker',58,-23);
  add('polish-logistics-crate','crate',32,30);
  add('polish-fabrication-cab','industrial_servicecab',-29,27);
  // Intentional wall storage and support stations; keep the existing routing network.
  return {station,receipt:{version:VERSION,changed,added,roomNames:rooms,originalProps:source.props.length,props:station.props.length}};
}
function validatePolish(before,after,specFor,viewAt) {
  const errors=[],oldIds=new Set(before.props.map(p=>p.id));
  if(new Set(after.props.map(p=>p.id)).size!==after.props.length)errors.push('Duplicate prop ids');
  const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  const floor=new Set();
  for(const room of Object.values(after.rooms))for(const r of room.rects)
    for(let y=r.y1;y<=r.y2;y++)for(let x=r.x1;x<=r.x2;x++)floor.add(x+','+y);
  for(const p of after.props) {
    if(!viewAt(p.t,(p.r||0)&3))errors.push(p.id+': unsupported direction');
    if(oldIds.has(p.id)&&JSON.stringify(before.props.find(q=>q.id===p.id))===JSON.stringify(p))continue;
    const spec=specFor(p.t);
    for(let y=p.y;y<p.y+p.h;y++)for(let x=p.x;x<p.x+p.w;x++) {
      if(!floor.has(x+','+y))errors.push(p.id+': outside floor');
      if(after.belts?.[x+','+y]&&spec.blocks!==false)errors.push(p.id+': blocks belt');
    }
    const collisions=after.props.filter(q=>q.id!==p.id&&specFor(q.t)?.blocks!==false&&q.block!==false&&overlap(p,q));
    if(p.mount==='surface') {
      if(!collisions.some(q=>specFor(q.t)?.surface))errors.push(p.id+': missing table support');
    }else if(spec.blocks!==false&&collisions.length)errors.push(p.id+': overlapping '+collisions.map(q=>q.id).join(','));
  }
  if(JSON.stringify(before.belts)!==JSON.stringify(after.belts))errors.push('Routing changed');
  for(const [id,room]of Object.entries(before.rooms))if(JSON.stringify(room.rects)!==JSON.stringify(after.rooms[id]?.rects))errors.push(id+': floor geometry changed');
  // Every previously reachable open tile stays reachable, except newly occupied furniture.
  function reachable(s) {
    const blocked=new Set();for(const p of s.props)if(specFor(p.t)?.blocks!==false&&p.block!==false)
      for(let y=p.y;y<p.y+p.h;y++)for(let x=p.x;x<p.x+p.w;x++)blocked.add(x+','+y);
    const start=[...floor].find(k=>!blocked.has(k));const seen=new Set([start]),queue=[start];
    for(let i=0;i<queue.length;i++){let[x,y]=queue[i].split(',').map(Number);for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]){const k=(x+dx)+','+(y+dy);if(floor.has(k)&&!blocked.has(k)&&!seen.has(k)){seen.add(k);queue.push(k);}}}
    return {seen,blocked};
  }
  const old=reachable(before),next=reachable(after);
  for(const key of old.seen)if(!next.seen.has(key)&&!next.blocked.has(key))errors.push('Lost circulation at '+key);
  return {errors,props:after.props.length,types:new Set(after.props.map(p=>p.t)).size,walkableReach:next.seen.size};
}
module.exports={VERSION,polishStation,validatePolish};
