'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('frontend/app/commandroom.js','utf8');
const manifest=JSON.parse(fs.readFileSync('frontend/assets/command-room/operator/manifest.json'));
const calls=[];const g=new Proxy({globalAlpha:1,createLinearGradient:()=>({addColorStop(){}})}, {get(o,k){return k in o?o[k]:(...args)=>calls.push([k,...args]);}});
const canvas=()=>({width:128,height:128,getContext:()=>g,addEventListener(){}});
let requests=0;
class ImageMock{constructor(){this.complete=true;this.naturalWidth=64;this.naturalHeight=64;}set src(v){this._src=v;this.onload?.();}get src(){return this._src;}}
async function boot(search){const box={location:{search},URLSearchParams,Image:ImageMock,document:{createElement:canvas},fetch:async()=>{requests++;return{ok:true,json:async()=>manifest};}};vm.createContext(box);vm.runInContext(source,box);await new Promise(r=>setImmediate(r));return vm.runInContext('CommandRoom',box);}
(async()=>{
 const off=await boot('');assert.equal(off.enabled,false);assert.equal(requests,0,'normal station does not fetch preview assets');
 const r=await boot('?commandroom=1');assert.ok(r.stats().manifestReady);
 const geo={W:144,H:144,COLS:12,ROWS:12,zones:{a:{x1:1,y1:1,x2:4,y2:8}},zoneGrid:Array(144).fill(null),props:[],chamfers:[],doorDefs:[[4,3,5,3],[4,4,5,4],[4,7,5,7]]};
 for(let y=1;y<=8;y++)for(let x=1;x<=6;x++)geo.zoneGrid[y*12+x]=x<5?'a':'b';
 const actor={id:'agent',px:62,py:48,dir:'north',state:'idle'};const frozen=JSON.stringify(geo);
 r.begin({geo,ctx:g,spawnRoomId:'a',bodies:[actor],now:1000,reducedMotion:true});let items=[],lights=[];r.addItems(items,lights);
 assert.equal(items.length,2,'noncontiguous door spans cannot bridge a solid wall');assert.equal(r.stats().doors[0].open,1,'a nearby real body opens the threshold');
 actor.px=130;actor.py=130;r.begin({geo,ctx:g,spawnRoomId:'a',bodies:[actor],now:2000,reducedMotion:true});r.addItems([],[]);assert.ok(r.stats().doors.every(d=>d.open===0));
 assert.equal(JSON.stringify(geo),frozen,'rendering never mutates authoritative geometry');
 const sealed={...geo,doorDefs:[]};r.begin({geo:sealed,ctx:g,spawnRoomId:'a',bodies:[actor],now:3000,reducedMotion:false});items=[];r.addItems(items,[]);assert.equal(items.length,0,'sealed geometry cannot acquire an automatic open door');
 const p={id:'desk',t:'desk',x:2,y:2,w:2,h:1};const idle=r.lightOf(p,false,null),view=r.lightOf(p,true,null),working=r.lightOf(p,true,{heat:.7});assert.equal(idle.a,view.a,'mere inspection is not fabricated work');assert.ok(working.a>idle.a);
 actor.px=36;actor.py=65;actor.working=false;r.drawBody(g,actor,3000,null);assert.equal(actor._pose,'command.rot.north');actor.working=true;r.drawBody(g,actor,3200,null);assert.equal(actor._pose,'command.type.north');actor.working=false;actor.sitting=true;r.drawBody(g,actor,3400,null);assert.equal(actor._pose,'command.sit.north');
 actor.sitting=false;actor.state='walk';actor.usingProp='rack';geo.props.push({id:'rack',t:'rackV',x:2,y:3,w:1,h:2});r.begin({geo,ctx:g,spawnRoomId:'a',bodies:[actor],now:4000,reducedMotion:false});r.drawBody(g,actor,4000,null);actor.state='idle';actor.dir='north';r.drawBody(g,actor,6000,null);assert.equal(actor._pose,'command.reach.north','reach starts on arrival, not when a long walk was planned');
 actor.usingProp=null;actor.goal='post';geo.props=[{id:'board',t:'missionboard',x:2,y:3,w:1,h:2}];r.drawBody(g,actor,8000,null);assert.equal(actor._pose,'command.reach.north','actual board survey goal does not claim a leisure usingProp');
 console.log('command-room: isolated preview, contiguous doors, sealed geometry, proximity, truthful lights, seated identity and arrival interaction passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
