'use strict';
(async()=>{
  const cv=document.querySelector('#machines'),ctx=cv.getContext('2d'),evidence=document.querySelector('#evidence');
  const image=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('Failed '+src));im.src=src;});
  await IndustrialTextures.ready;await SPRITES.init();await SPRITES.ensureSkin('station_minion');
  const rows=[];
  for(const id of AuthoredMachineConfig.ids){
    const spec=AuthoredMachineConfig.get(id),body=await image(AuthoredMachineConfig.sourceRoot+spec.image),layers={};
    for(const [name,url]of Object.entries(spec.layers))layers[name]=await image(AuthoredMachineConfig.sourceRoot+url);
    if(!AuthoredPropMotion.register(id,spec.motion,layers)||!AuthoredPropMotion.ready(id))throw Error('Unavailable mechanism '+id);
    const scale=Math.min(spec.bounds.width/body.width,spec.bounds.height/body.height);
    const box={x:spec.bounds.x+(spec.bounds.width-body.width*scale)/2,y:spec.bounds.y+spec.bounds.height-body.height*scale,width:body.width*scale,height:body.height*scale};
    rows.push({id,spec,body,box});
  }
  let work=false,reduced=false,frozen=false,time=0,last=performance.now(),nextRead=0;
  document.querySelector('#work').onclick=e=>{work=!work;e.target.textContent='Preview work: '+(work?'on':'off');nextRead=0;};
  document.querySelector('#reduced').onclick=e=>{reduced=!reduced;e.target.textContent='Reduced motion: '+(reduced?'on':'off');nextRead=0;};
  document.querySelector('#freeze').onclick=e=>{frozen=!frozen;e.target.textContent='Freeze frame: '+(frozen?'on':'off');nextRead=0;};
  document.querySelector('#advance').onclick=()=>{frozen=true;document.querySelector('#freeze').textContent='Freeze frame: on';time+=550;nextRead=0;};
  function frame(now){
    if(!frozen)time+=Math.min(80,now-last);last=now;
    ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#10191a';ctx.fillRect(0,0,cv.width,cv.height);
    const poses=[];
    rows.forEach(({id,spec,body,box},i)=>{
      const left=i*416;ctx.save();ctx.translate(left+12,12);ctx.scale(4,4);
      for(let y=0;y<6;y++)for(let x=0;x<8;x++)IndustrialTextures.floor(ctx,x*12,y*12,12,x,y,'plate');
      const propX=8,propY=48-spec.footprint.h*12;
      ctx.strokeStyle='rgba(129,163,157,.45)';ctx.lineWidth=.25;ctx.strokeRect(propX,propY,spec.footprint.w*12,spec.footprint.h*12);
      const world={...box,x:box.x+propX,y:box.y+propY};
      ctx.drawImage(body,world.x,world.y,world.width,world.height);
      const state={now:time,work,still:reduced};AuthoredPropMotion.draw(ctx,id,world,state);
      PropSprites.setCtx(ctx);PropSprites.draw({t:'crate',x:5,y:3,w:2,h:1},false,{still:true});
      SPRITES.drawBody(ctx,{id:'machine-scale-cadet',skin:'station_minion',px:91,py:48,state:'idle',dir:'south'},0,{reducedMotion:true});
      ctx.restore();ctx.fillStyle='#c5bfa9';ctx.font='15px ui-monospace,monospace';ctx.fillText(id+' · '+spec.footprint.w+' × '+spec.footprint.h+' tiles',left+16,318);
      poses.push({id,...AuthoredPropMotion.sample(id,world,state)});
    });
    if(now>=nextRead){
      // Fixture-only pixel receipt, throttled; the production module never reads pixels.
      const pixels=ctx.getImageData(0,0,cv.width,cv.height).data;let hash=2166136261;
      for(let i=0;i<pixels.length;i++)hash=Math.imul(hash^pixels[i],16777619)>>>0;
      evidence.textContent=JSON.stringify({fixture:true,work,reducedMotion:reduced,frozen,timeMs:Math.round(time),pixelHash:hash,poses},null,2);
      document.body.dataset.pixelHash=String(hash);document.body.dataset.work=String(work);document.body.dataset.reduced=String(reduced);nextRead=now+350;
    }
    requestAnimationFrame(frame);
  }
  document.body.dataset.ready='true';requestAnimationFrame(frame);
})().catch(error=>{document.querySelector('#evidence').textContent='Fixture unavailable: '+error.message;console.error(error);});
