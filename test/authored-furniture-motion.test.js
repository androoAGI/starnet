'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),A=require('./_assert');
const Motion=require('../frontend/app/authored-furniture-motion'),Configs=require('../frontend/app/authored-furniture-config');
let reads=0,allocations=0;
function factory(width,height){
  allocations++;const cv={width,height};const data=new Uint8ClampedArray(width*height*4);data.fill(255);
  cv.getContext=()=>({imageSmoothingEnabled:false,drawImage(){},getImageData(){reads++;return {data:data.slice()};},createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(){}});return cv;
}
function recorder(){let stack=0;const calls=[],ctx={save(){stack++;},restore(){stack--;},drawImage(...args){calls.push(['image',...args]);},translate(...args){calls.push(['translate',...args]);},rotate(...args){calls.push(['rotate',...args]);},isContextLost:()=>false};return {ctx,calls,depth:()=>stack};}
for(const id of Configs.ids){
  const c=Configs.get(id),png=fs.readFileSync(path.join(__dirname,'../frontend',Configs.sourceRoot,c.image));
  A.eq([png.readUInt32BE(16),png.readUInt32BE(20)],[c.sourceWidth,c.sourceHeight],'source dimensions bound '+id);
  A.eq(crypto.createHash('sha256').update(png).digest('hex'),c.sha256,'moving region bound to exact new pixels '+id);
  const before=reads;A.ok(Motion.prepare(id,{width:c.sourceWidth,height:c.sourceHeight},factory,c),'separate authored hanging layer '+id);
  A.eq(reads-before,1,'one source readback during preparation '+id);
  const k=Math.min(c.bounds.width/c.sourceWidth,c.bounds.height/c.sourceHeight),box={x:7,y:13,width:c.sourceWidth*k,height:c.sourceHeight*k};
  const zero=Motion.sample(id,box,{now:0}),quarter=Motion.sample(id,box,{now:c.period/4});
  A.eq(zero.angle,0,'neutral pose remains original artwork '+id);A.eq(quarter.angle,c.ambientAngle,'original ambient swing remains decorative '+id);
  A.eq(Motion.sample(id,box,{now:c.period/4,work:true}).angle,c.workAngle,'explicit work increases swing '+id);
  A.eq(Motion.sample(id,box,{now:c.period/4,work:1}).angle,c.ambientAngle,'truthy integer cannot claim exercising '+id);
  A.eq(Motion.sample(id,box,{now:c.period/4,still:true}).angle,0,'reduced motion holds neutral key art '+id);
  A.eq(Motion.sample(id,box,{now:c.period/4,reducedMotion:true}).angle,0,'system reduced motion alias holds neutral key art '+id);
  A.eq(zero.pivot,quarter.pivot,'chain pivot does not drift '+id);
  const b=Motion.bounds(id,box);A.ok(b.x<=box.x&&b.x+b.width>=box.x+box.width&&(b.x<box.x||b.x+b.width>box.x+box.width),'cache envelope includes outward swing and full stationary frame '+id);
  const draw=recorder(),startReads=reads,startAllocations=allocations;
  for(let i=0;i<240;i++)A.ok(Motion.draw(draw.ctx,id,box,{now:i*25,work:true}),'cached frame '+id+' '+i);
  A.eq(reads,startReads,'no per-frame source readback '+id);A.eq(allocations,startAllocations,'no per-frame canvas allocation '+id);A.eq(draw.depth(),0,'all frame contexts restored '+id);
  const quiet=recorder();Motion.draw(quiet.ctx,id,box,{now:500,still:true});A.eq(quiet.calls.filter(c=>c[0]==='image').length,1,'reduced motion draws original cached body once '+id);
  const lost=recorder();lost.ctx.isContextLost=()=>true;A.eq(Motion.draw(lost.ctx,id,box,{}),false,'context loss refuses optional renderer '+id);
  const cropped={x:7,y:13,width:(c.sourceWidth-20)*k,height:(c.sourceHeight-20)*k,crop:{x:10,y:10,width:c.sourceWidth-20,height:c.sourceHeight-20}};
  const cp=Motion.sample(id,cropped,{});A.ok(Math.abs(cp.pivot[0]-(zero.pivot[0]-10*k))<1e-9,'crop correction changes origin once '+id);
  A.eq(Motion.sample(id,{...box,width:box.width+1},{}),null,'nonuniform target fit is refused '+id);
}
A.ok(Motion.status().cachedPixels<30000,'both props retain fewer than thirty thousand cached pixels');
A.eq(Configs.get('benchpress'),null,'historically static bench press does not gain unrequested exercise motion');
const c=Configs.get('punchbag');
for(const invalid of [{period:0},{pivot:[-1,.1]},{region:[[0,0],[1,1]]},{workAngle:1},{sourceWidth:Infinity}])A.eq(Motion.validate({...c,...invalid}),false,'invalid calibration rejected '+JSON.stringify(invalid));
A.eq(Motion.prepare('bad',{width:1,height:1},factory,c),false,'wrong decoded image dimensions cannot use old calibration');
const saved=Motion.status().cachedPixels;A.ok(Motion.release('punchbag'),'release one decoded prop');A.ok(Motion.status().cachedPixels<saved,'release returns cache budget');
A.eq(Motion.ready('punchbag'),false,'released prop is unavailable');
A.report('authored-furniture-motion.test');
