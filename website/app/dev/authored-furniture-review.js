'use strict';
(async()=>{
  await IndustrialTextures.ready;await SPRITES.init();await SPRITES.ensureSkin('station_minion');
  const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d'),rows=[];
  for(const id of AuthoredFurnitureConfig.ids){const c=AuthoredFurnitureConfig.get(id),im=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=AuthoredFurnitureConfig.sourceRoot+c.image;});
    if(!AuthoredFurnitureMotion.prepare(id,im))throw Error('Cannot prepare '+id);
    const s=Math.min(c.bounds.width/im.width,c.bounds.height/im.height);rows.push({id,c,box:{x:24+c.bounds.x+(c.bounds.width-im.width*s)/2,y:28+c.bounds.y+c.bounds.height-im.height*s,width:im.width*s,height:im.height*s}});
  }
  let time=0,last=performance.now(),frozen=false,work=false,still=false,next=0;
  document.querySelector('#work').onclick=e=>{work=!work;e.target.textContent='Preview work: '+(work?'on':'off');};
  document.querySelector('#reduced').onclick=e=>{still=!still;e.target.textContent='Reduced motion: '+(still?'on':'off');};
  document.querySelector('#step').onclick=()=>{frozen=true;time+=1450;next=0;};
  function frame(now){if(!frozen)time+=Math.min(80,now-last);last=now;ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#10191a';ctx.fillRect(0,0,800,320);
    for(const [i,r]of rows.entries()){ctx.save();ctx.translate(i*400,10);ctx.scale(4,4);for(let y=0;y<6;y++)for(let x=0;x<8;x++)IndustrialTextures.floor(ctx,x*12,y*12,12,x,y,'plate');AuthoredFurnitureMotion.draw(ctx,r.id,r.box,{now:time,work,still});SPRITES.drawBody(ctx,{id:'bag-scale',skin:'station_minion',px:58,py:52,state:'idle',dir:'south'},0,{reducedMotion:true});ctx.restore();ctx.fillStyle='#c9c2ac';ctx.font='16px monospace';ctx.fillText(r.id,i*400+24,300);}
    if(now>next){document.querySelector('#proof').textContent=JSON.stringify({fixture:true,work,still,time:Math.round(time),cache:AuthoredFurnitureMotion.status(),poses:rows.map(r=>({id:r.id,...AuthoredFurnitureMotion.sample(r.id,r.box,{now:time,work,still})}))},null,2);next=now+350;}
    requestAnimationFrame(frame);
  }
  document.body.dataset.ready='true';requestAnimationFrame(frame);
})().catch(e=>{document.querySelector('#proof').textContent='Fixture error: '+e.message;console.error(e);});
