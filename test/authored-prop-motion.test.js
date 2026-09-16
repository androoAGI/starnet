'use strict';
const A=require('./_assert');
const Motion=require('../frontend/app/authored-prop-motion');
const base={sourceWidth:1000,sourceHeight:800,period:2000,clip:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]]};
const gantry={...base,kind:'gantry',from:[.3,.4],to:[.7,.4],size:[.15,.3],layer:'carriage'};
const tube={...base,kind:'tube',from:[.1,.5],to:[.9,.5],size:[.1,.2]};
const arm={...base,kind:'arm',shoulder:[.3,.3],rest:[.55,.6],pickup:[.6,.7],place:[.75,.55],
  upper:.25,fore:.23,thickness:.035,joint:.035,tool:.08,bend:-1};
const full={x:10,y:20,width:50,height:40};
const cropped={x:10,y:20,width:40,height:30,crop:{x:100,y:100,width:800,height:600}};
const layer={width:120,height:240};
const clone=o=>JSON.parse(JSON.stringify(o));
A.ok(Motion.register('fabricator',gantry,{carriage:layer}),'register new decoded carriage layer');
A.ok(Motion.register('tube',tube),'register new capsule geometry');
A.ok(Motion.register('etsy_packbot',arm),'register new linkage geometry');
A.ok(Motion.ready('fabricator'),'new decoded carriage is ready');
A.eq(Motion.ready('missing'),false,'no old art or renderer is selected for absent prop');
for(const change of [{kind:'legacy'},{period:0},{period:Infinity},{clip:[[0,0],[1,1]]},{sourceWidth:NaN},
  {from:[-.1,.3]},{size:[1,0]},{layer:'../old.png'},{palette:{metal:'red'}},{palette:{unknown:'#123456'}}])
  A.eq(Motion.validate({...gantry,...change}),false,'invalid config refused '+JSON.stringify(change));
A.eq(Motion.register('../id',tube),false,'registration key is bounded');
A.eq(Motion.register('missingHead',gantry),true,'body may register while external layer is loading');
A.eq(Motion.ready('missingHead'),false,'undecoded head is explicitly unavailable');
A.ok(Motion.setup({resolveLayer:(id,name)=>id==='missingHead'&&name==='carriage'?layer:null}),'external loader can supply only new decoded sources');
A.ok(Motion.ready('missingHead'),'resolver supplies new layer');
Motion.setup();
const idle=Motion.sample('fabricator',full,{now:0,work:false});
A.eq(idle.center,[25,36],'source geometry maps into uniformly fitted body');
A.eq(Motion.sample('fabricator',cropped,{now:0,work:false}).center,[20,31],'alpha padding is subtracted once before fitting');
A.eq(Motion.sample('fabricator',full,{now:1000,work:true}).center,[45,36],'horizontal head reaches rail end without vertical drift');
A.eq(Motion.sample('fabricator',full,{now:2000,work:true}).center,idle.center,'head returns at period boundary');
A.eq(Motion.sample('fabricator',full,{now:1000,work:false}),idle,'idle time cannot advance carriage');
A.eq(Motion.sample('fabricator',full,{now:1000,work:1}),idle,'truthy non-boolean value cannot claim activity');
A.eq(Motion.sample('fabricator',full,{now:1000,work:true,still:true}),idle,'renderer still preference parks mechanism');
A.eq(Motion.sample('fabricator',full,{now:1000,work:true,reducedMotion:true}),idle,'explicit reduced motion parks mechanism');
A.eq(Motion.sample('fabricator',full,{now:NaN,work:true}).center,idle.center,'invalid time cannot enter drawing geometry');
A.eq(Motion.sample('fabricator',{...full,width:60},{work:true}),null,'non-uniform fit is rejected rather than distorted');
A.eq(Motion.sample('fabricator',{...cropped,crop:{x:900,y:0,width:800,height:600}},{}),null,'crop outside exported PNG is invalid');
A.eq(Motion.sample('tube',full,{work:false,now:900}).center,[15,40],'idle capsule remains at inlet');
A.eq(Motion.sample('tube',full,{work:true,now:1000}).center,[35,40],'capsule advances only under work');
const original=clone(gantry);Motion.register('copy',original,{carriage:layer});original.from[0]=.99;
A.eq(Motion.sample('copy',full,{}).center,idle.center,'later manifest mutation cannot move registered mechanism');
let rigid=true,invariant=true,opens=new Set();
for(let now=0;now<2000;now+=50){
  const p=Motion.sample('etsy_packbot',full,{now,work:true});
  const len=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  rigid=rigid&&Math.abs(len(p.shoulder,p.elbow)-12.5)<1e-8&&Math.abs(len(p.elbow,p.wrist)-11.5)<1e-8;
  invariant=invariant&&p.shoulder[0]===25&&p.shoulder[1]===32;opens.add(p.open);
}
A.ok(rigid,'both linkage lengths remain constant over a complete pick/place cycle');
A.ok(invariant,'shoulder stays attached to the authored base throughout work');
A.eq(opens.size,2,'new pincer opens and closes during work');
A.eq(Motion.sample('etsy_packbot',full,{now:450,work:true,still:true}),Motion.sample('etsy_packbot',full,{now:0,work:false}),'arm and pincer both freeze under reduced motion');
const unreachable={...arm,upper:.08,fore:.07,rest:[1,1]};
Motion.register('shortArm',unreachable);
const short=Motion.sample('shortArm',full,{});
A.ok(Math.hypot(short.wrist[0]-short.shoulder[0],short.wrist[1]-short.shoulder[1])<7.5,'unreachable target does not stretch linkage');
function recording(fail=false){
  const calls=[],stack=[];let lost=false;
  const ctx={globalAlpha:.4,globalCompositeOperation:'multiply',imageSmoothingEnabled:false,
    save(){stack.push([this.globalAlpha,this.globalCompositeOperation,this.imageSmoothingEnabled]);calls.push(['save']);},
    restore(){[this.globalAlpha,this.globalCompositeOperation,this.imageSmoothingEnabled]=stack.pop();calls.push(['restore']);},
    isContextLost:()=>lost, lose:()=>{lost=true;}};
  for(const k of ['translate','scale','beginPath','moveTo','lineTo','closePath','clip','fillRect','arc','fill','stroke'])ctx[k]=(...a)=>calls.push([k,...a]);
  ctx.drawImage=(...a)=>{if(fail)throw Error('layer failed');calls.push(['drawImage',...a]);};
  return {ctx,calls,stack};
}
const g=recording();
A.ok(Motion.draw(g.ctx,'fabricator',cropped,{work:true,now:1000}),'new carriage draws into crop-corrected source space');
A.eq(g.calls.find(c=>c[0]==='translate'),['translate',5,15],'draw transform subtracts PNG alpha padding');
A.eq(g.calls.find(c=>c[0]==='scale'),['scale',.05,.05],'draw uses one scale on both axes');
const rendered=g.calls.find(c=>c[0]==='drawImage');
A.eq(rendered[4]/rendered[5],layer.width/layer.height,'isolated layer preserves aspect in its fitted region');
A.ok(g.calls.findIndex(c=>c[0]==='clip')<g.calls.findIndex(c=>c[0]==='drawImage'),'authored mechanism aperture clips before any art draws');
A.eq([g.ctx.globalAlpha,g.ctx.globalCompositeOperation,g.ctx.imageSmoothingEnabled,g.stack.length],[.4,'multiply',false,0],'draw restores caller state and opacity');
const bad=recording(true);
A.eq(Motion.draw(bad.ctx,'fabricator',full,{work:true}),false,'decoded-layer draw failure is reported');
A.eq([bad.ctx.globalCompositeOperation,bad.stack.length],['multiply',0],'failed draw still restores caller context');
const no=recording();no.ctx.lose();
A.eq(Motion.draw(no.ctx,'tube',full,{}),false,'lost canvas is unavailable');
A.eq(no.calls.length,0,'lost canvas receives no painting');
const t=recording();A.ok(Motion.draw(t.ctx,'tube',full,{work:true,now:500}),'capsule is newly authored geometry');
A.eq(t.calls.filter(c=>c[0]==='drawImage').length,0,'capsule does not reuse a legacy raster');
A.ok(t.calls.findIndex(c=>c[0]==='clip')<t.calls.findIndex(c=>c[0]==='fillRect'),'capsule remains clipped to barrel aperture');
const a=recording();A.ok(Motion.draw(a.ctx,'etsy_packbot',full,{work:true,now:1100}),'new articulated geometry draws');
A.ok(a.calls.some(c=>c[0]==='arc'),'linkage contains authored joints');
A.eq(a.calls.filter(c=>c[0]==='drawImage').length,0,'new arm has no old sprite callback or pixel dependency');
A.ok(Motion.unregister('copy'),'unregister releases an optional prop');
A.eq(Motion.sample('copy',full,{}),null,'released prop cannot animate');
A.report('authored-prop-motion.test');
