'use strict';
(async()=>{
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);
 await SPRITES.init();await SPRITES.ensureSkin('station_minion');
 const approved=new Set(['crate','desk','desk2','chair','bridge_consolebank','bridge_tacticaltable','bridge_equipmentbay','bridge_deckperimeter']);
 const query=new URLSearchParams(location.search),newOnly=query.get('set')==='new';
 const cards=[],main=document.querySelector('#catalog'),search=document.querySelector('#search'),family=document.querySelector('#family');let work=false,facing=0,placement=false;
 const cadet=(g,x,y,sitting,now)=>SPRITES.drawBody(g,{id:'review-cadet',skin:'station_minion',px:x,py:y,state:'idle',dir:sitting?'north':'south',sitting},now,{reducedMotion:true,skipGroundShadow:sitting});
 search.value=query.get('search')||'';
 if(newOnly){main.style.gridTemplateColumns='minmax(0,1000px)';document.querySelector('#scope').textContent='Showing newly rebuilt props. Each is followed by the approved desk, crate, and agent at the same scale.';}
 for(const cat of [...new Set(PropSprites.CATALOG.map(p=>p.cat))].sort()){const option=document.createElement('option');option.value=cat;option.textContent=cat;family.append(option);}
 for(const p of PropSprites.CATALOG){
  const article=document.createElement('article'),cv=document.createElement('canvas');cv.width=880;cv.height=newOnly?320:530;cv.setAttribute('aria-label',p.label+' at station scale');
  const footer=document.createElement('footer'),heading=document.createElement('h2'),meta=document.createElement('div'),size=document.createElement('span'),state=document.createElement('span');heading.textContent=p.label;meta.className='meta';size.textContent=p.w+' × '+p.h+' tiles';meta.append(size,state);footer.append(heading,meta);article.append(cv,footer);main.append(article);cards.push({p,article,cv,g:cv.getContext('2d'),state,size,visible:true});
 }
 function filter(){let n=0;for(const c of cards){c.visible=(!newOnly||PropRemaster.enabled(c.p.id))&&(!family.value||c.p.cat===family.value)&&(!search.value||(c.p.id+' '+c.p.label).toLowerCase().includes(search.value.toLowerCase()));c.article.hidden=!c.visible;if(c.visible)n++;}document.querySelector('#count').textContent=n+' / '+cards.length+' props';}
 search.addEventListener('input',filter);family.addEventListener('change',filter);
 document.querySelector('#motion').onclick=e=>{work=!work;e.target.textContent='Animation preview: '+(work?'on':'off');};
 document.querySelector('#turn').onclick=e=>{const supported=[...new Set(cards.filter(c=>c.visible).flatMap(c=>PropSprites.facings(c.p.id)))].sort();facing=supported[(supported.indexOf(facing)+1)%supported.length]||0;e.target.textContent='Facing: '+['south','west','north','east'][facing];};
 document.querySelector('#placement').onclick=e=>{placement=!placement;e.target.textContent='Placement preview: '+(placement?'on':'off');};
 const observer=new IntersectionObserver(entries=>{for(const e of entries){const c=cards.find(c=>c.article===e.target);if(c)c.inView=e.isIntersecting;}},{rootMargin:'150px'});cards.forEach(c=>observer.observe(c.article));
 function frame(now){
  PropSprites.setNow(now);
  for(const c of cards){if(!c.visible||!c.inView)continue;const {g,p,cv}=c;g.setTransform(1,0,0,1,0,0);g.fillStyle='#10191a';g.fillRect(0,0,cv.width,cv.height);
   // Fixed 3.8px/world-pixel display scale for every item, including tiny props.
   const scale=3.8;g.save();g.translate(20,22);g.scale(scale,scale);
   const ground=newOnly?4:9;
   for(let y=0;y<(newOnly?6:11);y++)for(let x=0;x<18;x++)IndustrialTextures.floor(g,x*12,y*12,12,x,y,'plate');
   const r=PropSprites.facings(p.id).includes(facing)?facing:0,fp=PropSprites.footprintAt(p.id,r),x=1,y=ground-fp.h;
   c.size.textContent=fp.w+' × '+fp.h+' tiles · '+['south','west','north','east'][r];
   PropSprites.setCtx(g);
   if(placement&&p.id==='couch')for(const offset of [18,30,42])cadet(g,x*12+offset,ground*12-2,true,now);
   PropSprites.draw({id:'atlas-'+p.id,t:p.id,x,y,w:fp.w,h:fp.h,r},work,{occupied:work,scanning:work,still:!work});
   if(placement&&p.id==='lowtable')PropSprites.draw({t:'industrial_toolcaddy',x:x+(fp.w>1?1:0),y:y+fp.h-1,w:1,h:1,mount:'surface'},false,{still:true});
   if(fp.w<=4)PropSprites.draw({t:'desk',x:7,y:ground-1,w:3,h:1},false,{occupied:work,still:!work});
   PropSprites.draw({t:'crate',x:14,y:ground-1,w:2,h:1},false);cadet(g,204,ground*12,false,now);g.restore();
   const v=PropSprites.viewAt(p.id,r),key=v.fn===undefined?'s':['s','w','n','e'][r];
   const ready=approved.has(p.id)||PropRemaster.enabled(p.id,key)||((r===1||r===3)&&(PropRemaster.enabled(p.id,'e')||PropRemaster.enabled(p.id,'w')));
   c.state.textContent=approved.has(p.id)?'Approved':ready?'New design · ready for review':'Awaiting full redesign';c.state.className=ready?'':'pending';
  }
  requestAnimationFrame(frame);
 }
 document.body.dataset.ready='true';filter();requestAnimationFrame(frame);
})().catch(e=>{document.querySelector('#count').textContent='Artwork could not load: '+e.message;console.error(e);});
