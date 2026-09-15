/* Disposable anatomy fixture. Uses actual world geometry, prop sizes and sprite rendering. */
'use strict';
(async()=>{
 const $=id=>document.getElementById(id),cv=$('comparison'),ctx=cv.getContext('2d');
 const names=['Current','A · Natural','B · Stronger silhouette','C · More overhead'];
 const sets=['industrial_secretagent','proportion_a','proportion_b','proportion_c'];
 let moving=false,paused=false,time=0,last=0,view='all';
 for(const set of sets)DATA.SKINS[set]={name:set,set,scale:18/76};
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);
 await SPRITES.init();await Promise.all(sets.map(set=>SPRITES.ensureSkin(set)));
 WorldModel.setPropRules(id=>PropSprites.spec(id));
 const doc=WorldModel.defaultDoc(),rid=doc.order[0];
 doc.rooms[rid]={...doc.rooms[rid],name:'PROPORTION STUDY',rects:[{x1:0,y1:0,x2:19,y2:17}],floorMat:'plate'};doc.props=[];doc.belts={};doc.edges=[];
 const spots=[];
 for(let i=0;i<4;i++){
  const x=1+(i%2)*10,y=2+Math.floor(i/2)*8;
  for(const[t,px,py]of [['desk',x,y],['chair',x+1,y+2],['plant',x+7,y+2]]){
   // The running demo's saved desks are 2x1; preserve those placed dimensions.
   const f=t==='desk'?{w:2,h:1}:PropSprites.footprintAt(t,0);doc.props.push({id:'study-'+i+'-'+t,t,x:px,y:py,w:f.w,h:f.h,r:0});
  }
  // Align boots, chair feet and plant pot on the same ground line. SPRITES lifts by 3px.
  spots.push({x:x+4.4,y:y+3.25});
 }
 doc._nid=10000;
 const station=WorldModel.deserialize(doc),geo=station.projectGeometry();
 const props=geo.props.map(p=>({...p,mount:station.mountOf(p)}));PropSprites.setSurfaceLayout(props);
 const bake=StationBake.bake(geo);
 const bodies=spots.map((s,i)=>({id:'proportion-study-'+i,skin:sets[i],px:(s.x-geo.origin.tx)*12,py:(s.y-geo.origin.ty)*12,dir:'south',state:'idle',aph:0}));
 let scale=1,ox=0,oy=0;
 function resize(){
  const width=Math.max(300,cv.parentElement.clientWidth-2),available=Math.max(380,window.innerHeight-260);
  if(view==='all'){scale=Math.min(3.6,width/geo.W,available/geo.H);ox=0;oy=0;cv.width=Math.ceil(geo.W*scale);cv.height=Math.ceil(geo.H*scale);}
  else{const s=spots[Number(view)];scale=Math.min(6,width/112,available/108);ox=(s.x-geo.origin.tx-4.8)*12;oy=(s.y-geo.origin.ty-5.5)*12;cv.width=Math.ceil(112*scale);cv.height=Math.ceil(108*scale);}
  cv.style.width=cv.width+'px';cv.style.height=cv.height+'px';
 }
 $('motion').onclick=()=>{moving=!moving;$('motion').textContent=moving?'Show standing poses':'Play walking loops';$('motion').setAttribute('aria-pressed',String(moving));};
 $('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'Resume':'Pause';};
 $('view').onchange=e=>{view=e.target.value;resize();};window.addEventListener('resize',resize);view=$('view').value;resize();
 const missing=sets.filter(set=>!SPRITES.isSkinReady(set));
 $('status').textContent=missing.length?'Missing study frames: '+missing.join(', '):'All four loaded · fixed 18 px height · actual 12 px world tiles · south-facing studies';
 cv.dataset.ready=String(!missing.length);cv.dataset.height='18';cv.dataset.variants='4';
 function paint(now){
  if(!paused)time+=Math.min(100,now-(last||now));last=now;
  ctx.setTransform(scale,0,0,scale,-ox*scale,-oy*scale);ctx.clearRect(ox,oy,cv.width/scale,cv.height/scale);StationBake.drawBase(ctx,bake,0,0);
  PropSprites.setCtx(ctx);PropSprites.setNow(0);PropSprites.setSurfaceLayout(props);
  for(const p of props)PropSprites.drawShadow(p,p.mount);
  const items=props.map(p=>({y:(p.y+p.h)*12,draw:()=>PropSprites.draw(p,false,{still:true,occupied:false})}));
  for(const b of bodies){b.state=moving?'walk':'idle';items.push({y:b.py,draw:()=>SPRITES.drawBody(ctx,b,time,{reducedMotion:!moving})});}
  items.sort((a,b)=>a.y-b.y).forEach(i=>i.draw());if($('lighting').checked)ctx.drawImage(bake.lightCv,0,0);
  for(let i=0;i<bodies.length;i++){
   const b=bodies[i];ctx.font='3.4px monospace';ctx.textAlign='center';ctx.fillStyle='#d4c6a4';ctx.fillText(names[i],b.px-10,b.py+12);
   if($('guides').checked){ctx.strokeStyle='#a6c8bb80';ctx.lineWidth=.3;ctx.setLineDash([1,1]);ctx.beginPath();ctx.moveTo(b.px-7,b.py-3);ctx.lineTo(b.px+7,b.py-3);ctx.moveTo(b.px-7,b.py-21);ctx.lineTo(b.px+7,b.py-21);ctx.stroke();ctx.setLineDash([]);}
  }
  cv.dataset.motion=moving?'walk':'standing';cv.dataset.frame=String(Math.floor(time/125)%8);requestAnimationFrame(paint);
 }requestAnimationFrame(paint);
})().catch(e=>{document.getElementById('status').textContent='Could not load comparison: '+e.message;console.error(e);});
