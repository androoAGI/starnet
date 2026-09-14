'use strict';
(async()=>{
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);
 await SPRITES.init();await SPRITES.ensureSkin('station_minion');
 const query=new URLSearchParams(location.search),newOnly=query.get('set')==='new';
 const cards=[],main=document.querySelector('#catalog'),search=document.querySelector('#search'),family=document.querySelector('#family');let work=false,facing=0,placement=false;
 const cadet=(g,x,y,sitting,now)=>SPRITES.drawBody(g,{id:'review-cadet',skin:'station_minion',px:x,py:y,state:'idle',dir:sitting?'north':'south',sitting},now,{reducedMotion:true,skipGroundShadow:sitting});
 const probe=document.createElement('canvas');probe.width=64;probe.height=64;const cadetHeight=32-cadet(probe.getContext('2d'),32,32,false,0).top;
 search.value=query.get('search')||'';
 if(newOnly){main.style.gridTemplateColumns='minmax(0,1000px)';document.querySelector('#scope').textContent='Showing newly rebuilt props. Each is followed by the approved desk, crate, and agent at the same scale.';}
 for(const cat of [...new Set(PropSprites.CATALOG.map(p=>p.cat))].sort()){const option=document.createElement('option');option.value=cat;option.textContent=cat;family.append(option);}
 for(const p of PropSprites.CATALOG){
  const article=document.createElement('article'),cv=document.createElement('canvas');cv.width=440;cv.height=newOnly?180:285;cv.setAttribute('aria-label',p.label+' at 2 display pixels per world pixel');
  const footer=document.createElement('footer'),heading=document.createElement('h2'),meta=document.createElement('div'),size=document.createElement('span'),state=document.createElement('span');heading.textContent=p.label;meta.className='meta';size.textContent=p.w+' × '+p.h+' tiles';meta.append(size,state);footer.append(heading,meta);article.append(cv,footer);main.append(article);cards.push({p,article,cv,g:cv.getContext('2d'),state,size,visible:true});
 }
 function filter(){facing=0;document.querySelector('#turn').textContent='Facing: south';let n=0;for(const c of cards){c.visible=(!newOnly||PropRemaster.enabled(c.p.id))&&(!family.value||c.p.cat===family.value)&&(!search.value||(c.p.id+' '+c.p.label).toLowerCase().includes(search.value.toLowerCase()));c.article.hidden=!c.visible;if(c.visible)n++;}document.querySelector('#count').textContent=n+' / '+cards.length+' props';}
 search.addEventListener('input',filter);family.addEventListener('change',filter);
 document.querySelector('#motion').onclick=e=>{work=!work;e.target.textContent='Animation preview: '+(work?'on':'off');};
 document.querySelector('#turn').onclick=e=>{const supported=[...new Set(cards.filter(c=>c.visible).flatMap(c=>PropSprites.facings(c.p.id)))].sort();facing=supported[(supported.indexOf(facing)+1)%supported.length]||0;e.target.textContent='Facing: '+['south','west','north','east'][facing];};
 document.querySelector('#placement').onclick=e=>{placement=!placement;e.target.textContent='Placement preview: '+(placement?'on':'off');};
 const observer=new IntersectionObserver(entries=>{for(const e of entries){const c=cards.find(c=>c.article===e.target);if(c)c.inView=e.isIntersecting;}},{rootMargin:'150px'});cards.forEach(c=>observer.observe(c.article));
 function frame(now){
  PropSprites.setNow(now);
  for(const c of cards){if(!c.visible||!c.inView)continue;const {g,p,cv}=c;g.setTransform(1,0,0,1,0,0);g.fillStyle='#10191a';g.fillRect(0,0,cv.width,cv.height);
   // Intrinsic CSS dimensions preserve exactly 2px/world-pixel display scale.
   const scale=2;g.save();g.translate(10,11);g.scale(scale,scale);
   const ground=newOnly?4:9;
   for(let y=0;y<(newOnly?6:11);y++)for(let x=0;x<18;x++)IndustrialTextures.floor(g,x*12,y*12,12,x,y,'plate');
   const r=PropSprites.facings(p.id).includes(facing)?facing:0,fp=PropSprites.footprintAt(p.id,r),x=1,y=ground-fp.h;
   c.size.textContent=fp.w+' × '+fp.h+' tiles · '+['south','west','north','east'][r];
   PropSprites.setCtx(g);
   if(placement&&['couch','industrial_bench'].includes(p.id))for(let slot=1;slot<=fp.w-2;slot++)cadet(g,(x+slot+.5)*12,ground*12-2,true,now);
   const mounted=!!(p.mount==='surface'||placement&&p.stack);
   if(mounted)PropSprites.draw({t:'lowtable',x,y:ground-1,w:3,h:1},false,{still:true});
   const prop={id:'atlas-'+p.id,t:p.id,x:x+(mounted&&fp.w===1?1:0),y,w:fp.w,h:fp.h,r,...(mounted?{mount:'surface'}:{})};
   // This labelled gallery owns only its demonstration instances, never the station.
   if(work&&p.id==='workbench'){
    const beat=Math.floor(now/2400);
    if(c.demoBeat!==beat){c.demoBeat=beat;PropSprites.pulseWorkbench(beat%2===0,prop.id);}
   }
   PropSprites.draw(prop,work,{occupied:work,scanning:work,still:!work});
   if(placement&&p.id==='bunk'){
     cadet(g,(x+fp.w/2)*12,y*12+1+cadetHeight,false,now);PropSprites.drawOver(prop);
   }
   if(placement&&p.id==='lowtable')PropSprites.draw({t:'industrial_toolcaddy',x:x+(fp.w>1?1:0),y:y+fp.h-1,w:1,h:1,mount:'surface'},false,{still:true});
   if(fp.w<=4)PropSprites.draw({t:'desk',x:7,y:ground-1,w:3,h:1},false,{occupied:work,still:!work});
   PropSprites.draw({t:'crate',x:14,y:ground-1,w:2,h:1},false);cadet(g,204,ground*12,false,now);g.restore();
   const v=PropSprites.viewAt(p.id,r),key=v.fn===undefined?'s':['s','w','n','e'][r];
   const ready=PropRemaster.enabled(p.id,key)||((r===1||r===3)&&(PropRemaster.enabled(p.id,'e')||PropRemaster.enabled(p.id,'w')));
   c.state.textContent=ready?'Approved sheet · loaded':'Native fallback';c.state.className=ready?'':'pending';
  }
  requestAnimationFrame(frame);
 }
 document.body.dataset.ready='true';filter();requestAnimationFrame(frame);
})().catch(e=>{document.querySelector('#count').textContent='Artwork could not load: '+e.message;console.error(e);});
