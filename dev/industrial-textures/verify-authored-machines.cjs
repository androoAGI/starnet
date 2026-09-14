'use strict';
// Optional rendered proof: NODE_PATH may point to the bundled @napi-rs/canvas.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createCanvas,loadImage}=require('@napi-rs/canvas');
const Motion=require('../../frontend/app/authored-prop-motion'),Configs=require('../../frontend/app/authored-machine-config');
const root=path.resolve(__dirname,'../..'),at=p=>path.join(root,p),out=at('docs/station-remaster/authored-machines');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const fit=(bounds,w,h)=>{const k=Math.min(bounds.width/w,bounds.height/h);return {x:bounds.x+(bounds.width-w*k)/2,y:bounds.y+bounds.height-h*k,width:w*k,height:h*k};};
(async()=>{
  const floor=await loadImage(at('frontend/assets/industrial/remaster/floors/plate.png'));
  const crate=await loadImage(at('frontend/assets/industrial/calibration/crate.png'));
  const sheet=createCanvas(1260,1020),g=sheet.getContext('2d');g.fillStyle='#10191a';g.fillRect(0,0,1260,1020);
  g.fillStyle='#cfb579';g.font='22px sans-serif';g.fillText('STARNET · NEW AUTHORED MACHINE COMPOSITES',20,34);
  g.font='16px sans-serif';g.fillStyle='#b1bbb2';g.fillText('Fixed 4 display px / world px · approved crate shares scale · fixture states, not real jobs',20,63);
  const receipts=[];
  for(const [col,id]of Configs.ids.entries()){
    const spec=Configs.get(id),body=await loadImage(at('frontend/'+Configs.sourceRoot+spec.image)),layers={};
    for(const [name,url]of Object.entries(spec.layers))layers[name]=await loadImage(at('frontend/'+Configs.sourceRoot+url));
    if(!Motion.register(id,spec.motion,layers)||!Motion.ready(id))throw Error('Missing machine '+id);
    const fitbox=fit(spec.bounds,body.width,body.height),world={...fitbox,x:fitbox.x+10,y:fitbox.y+48-spec.footprint.h*12};
    function plane(state,bodyOn=true){const cv=createCanvas(400,288),ctx=cv.getContext('2d');ctx.scale(4,4);
      if(bodyOn)ctx.drawImage(body,world.x,world.y,world.width,world.height);
      if(!Motion.draw(ctx,id,world,state))throw Error('Motion unavailable '+id);return cv;}
    const idle=plane({now:0,work:false}),working=plane({now:spec.motion.period*.5,work:true}),still=plane({now:spec.motion.period*.5,work:true,still:true});
    const idleData=idle.getContext('2d').getImageData(0,0,400,288).data,workData=working.getContext('2d').getImageData(0,0,400,288).data,stillData=still.getContext('2d').getImageData(0,0,400,288).data;
    const idleHash=hash(idleData),workHash=hash(workData),stillHash=hash(stillData);
    if(idleHash===workHash)throw Error('Work did not change authored pixels '+id);
    if(idleHash!==stillHash)throw Error('Reduced motion did not park all authored parts '+id);
    const motion=plane({now:spec.motion.period*.5,work:true},false),mg=motion.getContext('2d'),motionData=mg.getImageData(0,0,400,288).data;
    const clip=createCanvas(400,288),cg=clip.getContext('2d');cg.scale(4,4);cg.beginPath();spec.motion.clip.forEach((p,i)=>{const x=world.x+p[0]*world.width,y=world.y+p[1]*world.height;i?cg.lineTo(x,y):cg.moveTo(x,y);});cg.closePath();cg.fill();
    const mask= cg.getImageData(0,0,400,288).data;let escaped=0,changed=0;
    for(let i=3;i<motionData.length;i+=4){if(motionData[i]>8&&mask[i]===0)escaped++;if(idleData[i]!==workData[i]||idleData[i-1]!==workData[i-1]||idleData[i-2]!==workData[i-2]||idleData[i-3]!==workData[i-3])changed++;}
    if(escaped)throw Error(id+' painted '+escaped+' pixels outside its authored aperture');
    for(let row=0;row<3;row++){
      const left=col*420+10,top=90+row*302;g.save();g.translate(left,top);g.scale(4,4);
      for(let y=0;y<6;y++)for(let x=0;x<8;x++)g.drawImage(floor,x*12,y*12,12,12);
      g.strokeStyle='rgba(139,178,164,.5)';g.lineWidth=.25;g.strokeRect(10,48-spec.footprint.h*12,spec.footprint.w*12,spec.footprint.h*12);
      const state={now:spec.motion.period*(row===0?0:row===1?.25:.5),work:row>0};
      g.drawImage(body,world.x,world.y,world.width,world.height);Motion.draw(g,id,world,state);
      const cb=fit({x:0,y:0,width:26,height:22},crate.width,crate.height);g.drawImage(crate,62+cb.x,26+cb.y,cb.width,cb.height);g.restore();
      g.fillStyle='#c9c3b2';g.font='16px sans-serif';g.fillText(id+' · '+['parked','pickup / rail pass','place / rail return'][row],left,top+282);
    }
    receipts.push({id,sourceSha256:spec.sha256,footprint:spec.footprint,nativeBounds:spec.bounds,fittedBody:fitbox,
      scale:4,idleHash,workHash,reducedMotionHash:stillHash,workChangedPixels:changed,escapedClipPixels:escaped,
      staticOldSpriteCallbacks:0,verification:'offline raster fixture; live browser inspection is separate'});
  }
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'native-motion-composites.png'),await sheet.encode('png'));
  fs.writeFileSync(path.join(out,'raster-receipt.json'),JSON.stringify(receipts,null,2)+'\n');
  console.log('PASS: 3 authored machines change under work, park identically under reduced motion, and paint zero pixels outside calibrated openings.');
})().catch(error=>{console.error(error);process.exitCode=1;});
