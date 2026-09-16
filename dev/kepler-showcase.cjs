'use strict';
// A fresh review station. Never imports or rewrites another demo's save.
function createPreset(P,M){
  M.setPropRules(id=>P.spec(id));
  const doc=M.defaultDoc();doc.rooms={};doc.order=[];doc.props=[];doc.belts={};doc.edges=[];doc._nid=1000;
  doc.meta={...doc.meta,name:'KEPLER RELAY',spawnRoomId:'command',trunkRoomId:'command'};
  function room(id,name,kind,rects,floorStyle,floorMat,wallMat){
    doc.rooms[id]={id,name,kind,rects,floorStyle,floorMat,wallStyle:'hull',wallMat,hullStyle:'onyx',hullMat:'plating',floorPaint:{},tier:0};doc.order.push(id);
  }
  const rect=(x1,y1,x2,y2)=>({x1,y1,x2,y2});
  room('command','COMMAND / OBSERVATORY','bridge',[rect(15,0,38,14)],'cobalt','panel','panelled');
  room('fabrication','FABRICATION / DISPATCH','factory',[rect(0,21,24,37)],'rust','tread','service');
  room('lounge','CREW / COMMON ROOM','quarters',[rect(31,21,52,37)],'walnut','plank','ribbed');
  room('transit','TRANSFER GALLERY','corridor',[rect(25,15,28,17),rect(11,18,42,19),rect(11,20,14,20),rect(39,20,42,20)],'hull','runner','plating');
  // Short gallery tips meet four-tile openings in the two lower rooms.
  const props=doc.props;
  function add(id,t,x,y,r=0,extra={}){
    if(!P.spec(t)||!P.facings(t).includes(r))throw Error('Unsupported '+t+':'+r);
    const f=P.footprintAt(t,r),s=P.spec(t);
    const p={id,t,x,y,w:f.w,h:f.h,r,...extra};if(s.blocks===false)p.block=false;props.push(p);return p;
  }
  add('command-wall','bridge_consolebank',22,0);
  // The assigned command desk supplies its own working chair at its real seat anchor.
  add('command-desk','desk',18,4,0,{agentId:'agent'});
  add('navigation-desk','desk',32,4);add('navigation-chair','chair',33,5,2);
  const compact=P.spec('bridge_tacticaltable').w===5;
  add('chart-table','bridge_tacticaltable',compact?24:23,compact?9:8);
  add('chart-left','chair',compact?23:21,10,3);add('chart-right','chair',compact?29:31,10,1);
  add('command-green-left','industrial_planter',16,2);add('command-green-right','industrial_planter',35,2);
  add('command-rack-left','rackV',16,10);add('command-rack-right','rackV',36,10);
  add('command-storage','industrial_drawerbank',32,13);

  add('shop-lockers','industrial_locker',2,22);add('shop-tools','industrial_drawerbank',6,22);
  add('shop-bench','workbench',17,23);add('shop-stool','stool',18,25);
  add('shop-cabinet','industrial_servicecab',22,22);
  add('line-intake','intake',3,27);add('line-bay','bay',11,27,0,{agentId:'agent',role:'GENERALIST'});
  add('line-outbox','outbox',20,32);
  add('cargo-one','crate',2,34);add('cargo-two','crate',5,34);add('cargo-three','crate',2,36);
  add('cargo-parts','industrial_locker',8,36);add('shop-green','tallplant',22,36);
  add('shop-service-table','longtable',15,35);add('shop-toolbox','toolbox',16,35);
  add('shop-mark-one','hazardpad',3,26);add('shop-mark-two','hazardpad',20,31);
  // Physical belts, with an elbow that gives the dispatch end its own space.
  for(let x=5;x<=10;x++)doc.belts[x+',28']='E';
  for(let x=13;x<=16;x++)doc.belts[x+',28']=x===16?'S':'E';
  for(let y=29;y<=32;y++)doc.belts['16,'+y]=y===32?'E':'S';
  for(let x=17;x<=19;x++)doc.belts[x+',32']='E';

  add('lounge-carpet','rug_large',34,31);
  add('lounge-arcade','arcade',33,22);add('lounge-arcade-two','arcade2',35,22);
  add('lounge-bar','bar',44,22);add('bar-stool-one','stool',44,24);add('bar-stool-two','stool',46,24);
  add('lounge-aquarium','fishtank',50,22);
  add('lounge-billiards','quarters_pooltable',46,28);
  add('lounge-tv','tv',35,29);add('lounge-table','glasstable',35,32);
  add('lounge-sofa','couch',34,35);add('lounge-seat-left','recliner',40,33);add('lounge-seat-right','recliner_r',32,33);
  add('lounge-books','bookshelf',44,36);add('lounge-coffee-table','longtable',48,36);add('lounge-coffee','coffee',49,36);
  add('lounge-green-one','tallplant',32,36);add('lounge-green-two','industrial_planter',49,25);
  const station=M.deserialize(doc),violations=[];
  for(let i=0;i<props.length;i++){
    const p=props[i],before=M.deserialize({...doc,props:props.slice(0,i)}),check=before.canPlaceProp(p.t,p.x,p.y,p.w,p.h);
    if(!check.ok)violations.push({id:p.id,...check});
  }
  for(const [key,dir]of Object.entries(doc.belts)){const[x,y]=key.split(',').map(Number);const check=station.beltPlaceable?station.beltPlaceable(x,y):station.canPlaceBeltRun({tx:x,ty:y},{tx:x,ty:y});if(!check.ok)violations.push({belt:key,dir,...check});}
  if(violations.length)throw Error(JSON.stringify(violations));
  return {doc:station.serialize(),station};
}
module.exports={createPreset};
