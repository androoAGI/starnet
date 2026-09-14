'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const Mounts=require('../frontend/app/authored-surface-mounts.js');
const root=path.resolve(__dirname,'..');
const c=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(root,'frontend/app/authored-surface-calibration.js'),'utf8')+'\nthis.data=AuthoredSurfaceCalibration;',c);
const calibration=JSON.parse(JSON.stringify(c.data));
const structure=require('../dev/industrial-textures/prop-structure-manifest.json').props;
const recipes=require('../dev/industrial-textures/coordinated-batch03-recipes.json').props;
const previous=require('../frontend/assets/industrial/props-v3/manifest.json').props;
let assertions=0;
const ok=(p,msg)=>{assertions++;assert.ok(p,msg);};
const eq=(a,b,msg)=>{assertions++;assert.deepEqual(a,b,msg);};
const near=(a,b,msg)=>ok(Math.abs(a-b)<1e-8,msg);
const geometry={};
function box(bounds,size){const s=Math.min(bounds.width/size.width,bounds.height/size.height);return{x:bounds.x+(bounds.width-size.width*s)/2,y:bounds.y+bounds.height-size.height*s,width:size.width*s,height:size.height*s};}
for(const[id,p]of Object.entries(calibration.props))for(const[view,v]of Object.entries(p.views)){
  const bytes=fs.readFileSync(path.join(root,v.art));
  eq(crypto.createHash('sha256').update(bytes).digest('hex'),v.sha256,id+':'+view+' exact calibrated export hash.');
  eq([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[v.sourceWidth,v.sourceHeight],id+':'+view+' actual PNG dimensions.');
  const r=recipes[id]?.views[view],alpha=r?.alphaCrop||{left:0,top:0,width:v.sourceWidth,height:v.sourceHeight};
  const bounds=structure[id].views[view].bounds;
  geometry[id+':'+view]={spec:{image:v.image,sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight,footprint:v.footprint},crop:{x:alpha.left,y:alpha.top,width:alpha.width,height:alpha.height},box:box(bounds,alpha)};
}
geometry['mug:s']={spec:{image:'mug.png',sourceWidth:1050,sourceHeight:1027,footprint:{w:1,h:1}},crop:{x:0,y:0,width:1050,height:1027},box:box({x:4,y:8,width:4,height:4},{width:1050,height:1027})};
const books=recipes.bookstack.views.s;
geometry['bookstack:s']={spec:{image:'bookstack.png',sourceWidth:books.exported.width,sourceHeight:books.exported.height,footprint:books.footprint},crop:{x:books.alphaCrop.left,y:books.alphaCrop.top,width:books.alphaCrop.width,height:books.alphaCrop.height},box:box(books.nativeBounds,books.alphaCrop)};
const lookup=(t,v)=>geometry[t+':'+v]||null;
const ruleFor=t=>({surface:!!calibration.props[t],canMirror:true});
const engine=Mounts.create({calibration,viewGeometry:lookup,ruleFor});
for(const[id,p]of Object.entries(calibration.props))for(const[view,v]of Object.entries(p.views))for(const mirror of [0,1]){
  const host={id:'host',t:id,x:10,y:20,w:v.footprint.w,h:v.footprint.h,r:['s','w','n','e'].indexOf(view),m:mirror};
  const children=Array.from({length:host.h},(_,y)=>({id:'mug'+y,t:'mug',x:host.x+Math.floor(host.w/2),y:host.y+y,w:1,h:1}));
  const layout=[host,...children],before=JSON.stringify(layout);engine.setLayout(layout);
  const placements=children.map(p=>engine.placementFor(p));
  for(const result of placements){
    ok(result.authored,id+':'+view+' supports this physical row.');
    near(result.contact.y-result.lift,result.target.y,id+':'+view+' rendered bottom contacts tabletop.');
    near(result.contact.x,result.target.x,id+':'+view+' physical/rendered X is preserved.');
    ok(result.sortY>result.hostSortY,id+':'+view+' mounted object sorts above the whole host.');
    ok(Number.isFinite(result.lift),id+':'+view+' finite lift.');
  }
  if(host.h>1){
    ok(placements[0].target.y<placements.at(-1).target.y,id+' far and near rows map to different points on its projected plane.');
    ok(placements[0].lift!==placements.at(-1).lift,id+' depth views do not reuse one front-edge lift.');
  }
  eq(JSON.stringify(layout),before,id+':'+view+' no saved geometry or fields mutate.');
}

const host={id:'a',t:'glasstable',x:0,y:0,w:1,h:3,r:3},child={id:'m',t:'mug',x:0,y:0,w:1,h:1};
engine.setLayout([host,child]);const back=engine.placementFor(child);
near(back.target.y,6.31661807580175+(27.98921282798834-6.31661807580175)/3,'Real east-glass far row uses one-third of its new projected depth.');
ok(back.lift<0,'A negative render lift is retained when a back-row body must move down slightly onto the new plane.');
const frontMug={...child,y:2},frontBooks={...frontMug,t:'bookstack'};
near(engine.liftFor(frontMug)-engine.liftFor(frontBooks),2,'Actual new book-stack base ending at y10 receives two pixels less lift than a y12 mug.');
const last={...host,id:'b'};engine.setLayout([host,last,child]);eq(engine.placementFor(child).hostId,'b','Last containing native surface matches worldmodel selection.');
last.x=20;eq(engine.placementFor(child).hostId,'b','SetLayout keeps a transient snapshot until next derivation.');
engine.setLayout([host,last,child]);eq(engine.placementFor(child).hostId,'a','Changed layout is picked up on next setLayout.');
engine.setLayout([]);eq(engine.liftFor(child),8,'Caller-confirmed mount without a host retains legacy rise.');
engine.setLayout([{...host,w:17},child]);eq(engine.liftFor(child),8,'Oversized hostile host is ignored.');
engine.setLayout([host,child]);eq(engine.liftFor({...child,w:2}),8,'Child must fit wholly inside native host footprint.');
eq(engine.liftFor({...child,x:NaN}),8,'Non-finite child falls back.');
eq(engine.liftFor({...child,x:.5}),8,'Fractional tile footprints are rejected.');
const none=Mounts.create({calibration,ruleFor});none.setLayout([host,child]);eq(none.liftFor(child),8,'Absent loaded authored pack never activates stored calibration.');
const deny=Mounts.create({calibration,viewGeometry:lookup,ruleFor:()=>({surface:false})});deny.setLayout([host,child]);eq(deny.liftFor(child),8,'Runtime catalog authority can reject a host.');
const throws=Mounts.create({calibration,viewGeometry:()=>{throw Error('lost context');},ruleFor});throws.setLayout([host,child]);eq(throws.liftFor(child),8,'Lost geometry context has a safe fallback.');
const wrong=Mounts.create({calibration,ruleFor,viewGeometry:(t,v)=>{const g=lookup(t,v);return g?{...g,spec:{...g.spec,image:'older-body.png'}}:null;}});wrong.setLayout([host,child]);eq(wrong.liftFor(child),8,'A different runtime source cannot consume stale calibration.');
const invalid=Mounts.create({calibration,ruleFor,viewGeometry:(t,v)=>{const g=lookup(t,v);return g?{...g,crop:{x:-1,y:0,width:10,height:10}}:null;}});invalid.setLayout([host,child]);eq(invalid.liftFor(child),8,'Invalid exported alpha crop never produces a lift.');

const q=[[0,0],[12,2],[12,12],[0,8]];
const a=Mounts.projectedPoint(q,3,.5),b=Mounts.projectedPoint(q,9,.5);
near(a.y,4.75,'Bilinear inverse X respects tilted left support.');near(b.y,6.25,'Bilinear inverse X respects tilted right support.');
eq(Mounts.projectedPoint(q,13,.5),null,'Outside-X contact is not silently clamped onto the board.');
eq(Mounts.projectedPoint(q,3,2),null,'Outside-depth contact is rejected.');
eq(Mounts.projectedPoint([[0,0],[12,0],[0,12],[12,12]],6,.5),null,'Folded/crossed quad is rejected.');
eq(Mounts.projectedPoint([[0,0],[0,0],[12,12],[0,12]],6,.5),null,'Degenerate quad is rejected.');
const tilted=Mounts.create({ruleFor:()=>({surface:true,canMirror:true}),viewGeometry:(type,view)=>type==='tilt'&&view==='s'?{box:{x:0,y:0,width:24,height:12},crop:{x:0,y:0,width:100,height:100},spec:{image:'tilt.png',sourceWidth:100,sourceHeight:100,footprint:{w:2,h:1}},surfaceSupport:[[0,0],[1,.2],[1,1],[0,.8]]}:null});
const tiltHost={id:'tilt',t:'tilt',x:0,y:0,w:2,h:1},tiltChild={id:'mug',t:'mug',x:0,y:0,w:1,h:1};
tilted.setLayout([tiltHost,tiltChild]);const normal=tilted.placementFor(tiltChild);
tilted.setLayout([{...tiltHost,m:1},tiltChild]);const flipped=tilted.placementFor(tiltChild);
near(normal.target.y,10.2,'Asymmetric source near edge resolves left quarter.');near(flipped.target.y,11.4,'Host mirroring reflects its asymmetric support around native width.');
near(normal.target.x,flipped.target.x,'Mirroring never changes the child physical X.');
// A contact is normalized to the complete export, not its alpha crop. Both offsets
// matter: this cropped child has feet above its faint fringe and off its centreline.
const anchorChildGeometry={box:{x:2,y:-8,width:5,height:10},crop:{x:20,y:40,width:50,height:100},
  spec:{sourceWidth:100,sourceHeight:200,footprint:{w:1,h:1},contact:{x:.35,y:.6}}};
const anchorHostGeometry={box:{x:0,y:0,width:12,height:4},
  spec:{sourceWidth:100,sourceHeight:100,footprint:{w:1,h:1}},surfaceSupport:[[0,0],[1,0],[1,1],[0,1]]};
const contacts=Mounts.create({ruleFor:t=>({surface:t==='table',canMirror:true}),
  viewGeometry:t=>t==='table'?anchorHostGeometry:anchorChildGeometry});
const anchorHost={id:'table',t:'table',x:10,y:20,w:1,h:1};
const anchorChild={id:'sample',t:'sample',x:10,y:20,w:1,h:1};
const anchorLayout=[anchorHost,anchorChild],anchorBefore=JSON.stringify(anchorLayout);
contacts.setLayout(anchorLayout);
const placed=contacts.placementFor(anchorChild);
ok(placed.authored,'Cropped child contact seats on authored table.');
near(placed.contact.x,123.5,'Contact X projects full source x35 through crop x20 and box offset x2.');
near(placed.contact.y,240,'Contact Y projects full source y120 through crop y40 and box offset -8.');
near(placed.lift,-4,'Declared contact receives the lift, not the lower alpha-fringe edge.');
near(placed.contact.y-placed.lift,placed.target.y,'Actual declared feet touch table after lift.');
const mirrored=contacts.placementFor({...anchorChild,m:1});
near(mirrored.contact.x,128.5,'Mirrored child reflects projected contact around physical 12px footprint once.');
near(mirrored.contact.y,placed.contact.y,'Mirroring leaves vertical contact unchanged.');
eq(JSON.stringify(anchorLayout),anchorBefore,'Contact projection never changes saved placement.');
delete anchorChildGeometry.spec.contact;
const legacyContact=contacts.placementFor(anchorChild);
near(legacyContact.contact.x,124.5,'Without declared contact, legacy alpha-box centre remains the X anchor.');
near(legacyContact.contact.y,242,'Without declared contact, legacy alpha-box bottom remains the Y anchor.');
near(legacyContact.lift,-2,'Legacy lift remains unchanged when contact is absent.');
console.log(`authored-surface-mounts.test: OK (${assertions} assertions; 10 actual tabletop views, both mirror states)`);
