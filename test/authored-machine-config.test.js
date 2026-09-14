'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),A=require('./_assert');
const configs=require('../frontend/app/authored-machine-config'),motion=require('../frontend/app/authored-prop-motion');
const root=path.join(__dirname,'../frontend');
for(const id of configs.ids){
  const s=configs.get(id),png=fs.readFileSync(path.join(root,configs.sourceRoot,s.image));
  A.eq(crypto.createHash('sha256').update(png).digest('hex'),s.sha256,'calibration binds exact exported art '+id);
  A.eq([png.readUInt32BE(16),png.readUInt32BE(20)],[s.motion.sourceWidth,s.motion.sourceHeight],'normalized geometry uses exported dimensions '+id);
  A.ok(motion.validate(s.motion),'calibrated motion config valid '+id);
  motion.register(id,s.motion);
  const k=Math.min(s.bounds.width/s.motion.sourceWidth,s.bounds.height/s.motion.sourceHeight);
  const box={x:s.bounds.x+(s.bounds.width-s.motion.sourceWidth*k)/2,y:s.bounds.y+s.bounds.height-s.motion.sourceHeight*k,width:s.motion.sourceWidth*k,height:s.motion.sourceHeight*k};
  A.eq(Math.round(box.width/box.height*100000),Math.round(s.motion.sourceWidth/s.motion.sourceHeight*100000),'native fit retains authored proportions '+id);
  A.ok(box.x>=s.bounds.x&&box.y>=s.bounds.y&&box.x+box.width<=s.bounds.x+s.bounds.width+.00001&&box.y+box.height<=s.bounds.y+s.bounds.height+.00001,'complete body stays in native bounds '+id);
  const idle=motion.sample(id,box,{now:0,work:false}),later=motion.sample(id,box,{now:1200,work:true,still:true});
  A.eq(later,idle,'calibrated reduced motion returns idle mechanism '+id);
  if(id==='etsy_packbot'){
    const flange=[box.x+855*k,box.y+190*k];
    A.ok(Math.hypot(flange[0]-idle.shoulder[0],flange[1]-idle.shoulder[1])<.04,'new shoulder is centered in authored mounting flange');
    let solid=true,inside=true;
    for(let t=0;t<s.motion.period;t+=25){
      const p=motion.sample(id,box,{now:t,work:true});
      solid=solid&&Math.abs(Math.hypot(p.elbow[0]-p.shoulder[0],p.elbow[1]-p.shoulder[1])-s.motion.upper*s.motion.sourceWidth*k)<1e-8;
      for(const q of [p.shoulder,p.elbow,p.wrist])inside=inside&&q[0]>box.x&&q[0]<box.x+box.width&&q[1]>box.y&&q[1]<box.y+box.height;
    }
    A.ok(solid,'calibrated arm preserves rigid hardware through every pose');A.ok(inside,'calibrated linkage stays inside full native envelope');
  }
}
A.ok(Object.isFrozen(configs.get('etsy_packbot').motion.shoulder),'calibrated geometry is immutable');
A.eq(configs.get('__proto__'),null,'only explicit calibrated IDs are returned');
A.report('authored-machine-config.test');
