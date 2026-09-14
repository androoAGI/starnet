'use strict';
(async()=>{
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);
 const body=new Image();body.src='assets/sprites/station_minion/rot_south.png';await body.decode();
 const bodyCv=document.createElement('canvas');bodyCv.width=body.width;bodyCv.height=body.height;const bg=bodyCv.getContext('2d');bg.drawImage(body,0,0);const rgba=bg.getImageData(0,0,body.width,body.height).data;let foot=0;for(let i=3;i<rgba.length;i+=4)if(rgba[i]>50)foot=Math.max(foot,Math.floor(i/4/body.width)+1);
 const approved=new Set(['crate','desk','desk2','chair','bridge_consolebank','bridge_tacticaltable','bridge_equipmentbay','bridge_deckperimeter']);
 const cards=[],main=document.querySelector('#catalog'),search=document.querySelector('#search'),family=document.querySelector('#family');let work=false,facing=0;
 search.value=new URLSearchParams(location.search).get('search')||'';
 for(const cat of [...new Set(PropSprites.CATALOG.map(p=>p.cat))].sort()){const option=document.createElement('option');option.value=cat;option.textContent=cat;family.append(option);}
 for(const p of PropSprites.CATALOG){
  const article=document.createElement('article'),cv=document.createElement('canvas');cv.width=880;cv.height=530;cv.setAttribute('aria-label',p.label+' at station scale');
  const footer=document.createElement('footer'),heading=document.createElement('h2'),meta=document.createElement('div'),size=document.createElement('span'),state=document.createElement('span');heading.textContent=p.label;meta.className='meta';size.textContent=p.w+' × '+p.h+' tiles';meta.append(size,state);footer.append(heading,meta);article.append(cv,footer);main.append(article);cards.push({p,article,cv,g:cv.getContext('2d'),state,visible:true});
 }
 function filter(){let n=0;for(const c of cards){c.visible=(!family.value||c.p.cat===family.value)&&(!search.value||(c.p.id+' '+c.p.label).toLowerCase().includes(search.value.toLowerCase()));c.article.hidden=!c.visible;if(c.visible)n++;}document.querySelector('#count').textContent=n+' / '+cards.length+' props';}
 search.addEventListener('input',filter);family.addEventListener('change',filter);
 document.querySelector('#motion').onclick=e=>{work=!work;e.target.textContent='Animation preview: '+(work?'on':'off');};
 document.querySelector('#turn').onclick=e=>{facing=(facing+1)%4;e.target.textContent='Facing: '+['south','west','north','east'][facing];};
 const observer=new IntersectionObserver(entries=>{for(const e of entries){const c=cards.find(c=>c.article===e.target);if(c)c.inView=e.isIntersecting;}},{rootMargin:'150px'});cards.forEach(c=>observer.observe(c.article));
 function frame(now){
  PropSprites.setNow(now);
  for(const c of cards){if(!c.visible||!c.inView)continue;const {g,p,cv}=c;g.setTransform(1,0,0,1,0,0);g.fillStyle='#10191a';g.fillRect(0,0,cv.width,cv.height);
   // Fixed 3.8px/world-pixel display scale for every item, including tiny props.
   const scale=3.8;g.save();g.translate(20,22);g.scale(scale,scale);
   for(let y=0;y<11;y++)for(let x=0;x<18;x++)IndustrialTextures.floor(g,x*12,y*12,12,x,y,'plate');
   const r=PropSprites.facings(p.id).includes(facing)?facing:0,fp=PropSprites.footprintAt(p.id,r),x=1,y=9-fp.h;
   PropSprites.setCtx(g);PropSprites.draw({id:'atlas-'+p.id,t:p.id,x,y,w:fp.w,h:fp.h,r},work,{occupied:work,still:!work});
   PropSprites.draw({t:'crate',x:14,y:8,w:2,h:1},false);g.imageSmoothingEnabled=true;g.drawImage(body,204-body.width*.385/2,108-foot*.385,body.width*.385,body.height*.385);g.restore();
   const v=PropSprites.viewAt(p.id,r),key=v.fn===undefined?'s':['s','w','n','e'][r];
   const ready=approved.has(p.id)||PropRemaster.enabled(p.id,key)||((r===1||r===3)&&(PropRemaster.enabled(p.id,'e')||PropRemaster.enabled(p.id,'w')));
   c.state.textContent=ready?'Remastered':'Awaiting artwork';c.state.className=ready?'':'pending';
  }
  requestAnimationFrame(frame);
 }
 document.body.dataset.ready='true';filter();requestAnimationFrame(frame);
})().catch(e=>{document.querySelector('#count').textContent='Artwork could not load: '+e.message;console.error(e);});
