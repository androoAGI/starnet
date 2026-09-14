'use strict';
(async()=>{
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);await SPRITES.init();await SPRITES.ensureSkin('station_minion');
 const groups={storage:['bookshelf','shelf','industrial_drawerbank','arc_indexwall','industrial_locker','rack','war_intelcab','safe'],utility:['coffee','quarters_minifridge','quarters_vending','jukebox','pixelrig','intake','core','rackV'],crew:['industrial_bench','dinerchair','dinertable','booth','podchair','beanbag','bunk','industrial_planter'],tables:['lowtable','lowtable:e','glasstable','glasstable:e','loungetable','loungetable:e','longtable','longtable:e']};
 groups.machinery=['tank','tube','fabricator','vat','industrial_servicecab','cryopod','incubator','comms_uplink'];
 groups['crew-facings']=['dinerchair:w','dinerchair:n','dinerchair:e','podchair:w','podchair:n','podchair:e','booth:w','booth:e','dinertable:e'];
 groups.command=['console','consoleL','bench','bridge_consolebank','bridge_equipmentbay','bigscreen','holotable','bridge_tacticaltable'];
 const manifest=await(await fetch('assets/industrial/'+(new URLSearchParams(location.search).get('propSet')==='projection'?'projection-correction':'approved-sheet')+'/manifest.json')).json(),revised=new Set((manifest.revisedViews||[]).map(v=>v.id+':'+v.view));
 WorldModel.setPropRules(id=>PropSprites.spec(id));
 const cv=document.querySelector('#room'),g=cv.getContext('2d'),report=document.querySelector('#report');
 function render(name){
  try{
   for(const button of document.querySelectorAll('#groups button'))button.setAttribute('aria-pressed',String(button.textContent===name));
   const wide=name==='command',rows=Math.ceil(groups[name].length/(wide?2:4)),anchorY=4+rows*6;
   const doc=WorldModel.defaultDoc(),roomId=doc.order[0];doc.rooms={[roomId]:{...doc.rooms[roomId],name:'ART REVIEW',rects:[{x1:0,y1:0,x2:31,y2:anchorY+3}]}};doc.order=[roomId];doc.props=[];doc.belts={};
   const add=(t,x,y,r=0,w,h)=>{const fp=PropSprites.footprintAt(t,r);const p={id:'review-'+doc.props.length,t,x,y,w:w||fp.w,h:h||fp.h,r};doc.props.push(p);return p;};
   for(const [i,item]of groups[name].entries()){const [id,face]=item.split(':'),r=({s:0,w:1,n:2,e:3})[face||'s'],p=add(id,2+(i%(wide?2:4))*(wide?15:7),4+Math.floor(i/(wide?2:4))*6,r);
    if(name==='tables'){const mug=add('mug',p.x+Math.floor(p.w/2),p.y);mug.mount='surface';if(p.h>1){const second=add('mug',p.x,p.y+p.h-1);second.mount='surface';}}
   }
   add('desk',3,anchorY,0,2,1);add('crate',11,anchorY);add('chair',18,anchorY);
   const station=WorldModel.deserialize(doc),geo=station.projectGeometry(),bake=StationBake.bake(geo),scale=2.5,rendered=geo.props.map(p=>({...p,mount:station.mountOf(p)}));
   cv.width=Math.ceil(geo.W*scale);cv.height=Math.ceil(geo.H*scale);g.setTransform(scale,0,0,scale,0,0);g.clearRect(0,0,geo.W,geo.H);g.drawImage(bake.baseCv,0,0);PropSprites.setCtx(g);PropSprites.setNow(0);PropSprites.setSurfaceLayout(rendered);
   for(const p of rendered)PropSprites.drawShadow(p,p.mount);
   const order=p=>{const mounted=p.mount==='surface'&&PropSprites.surfacePlacement(p);return mounted&&Number.isFinite(mounted.sortY)?mounted.sortY:(p.y+p.h)*12;};
   for(const p of [...rendered].sort((a,b)=>order(a)-order(b)))PropSprites.draw(p,false,{still:true});
   SPRITES.drawBody(g,{id:'art-scale-crew',skin:'station_minion',px:(25-geo.origin.tx)*12,py:(anchorY+1-geo.origin.ty)*12,state:'idle',dir:'south'},0,{reducedMotion:true});
   g.drawImage(bake.lightCv,0,0);
   const status=PropRemaster.status(),changed=groups[name].filter(item=>revised.has(item.includes(':')?item:item+':s')).length,mounts=rendered.filter(p=>p.mount==='surface').map(p=>({id:p.id,...PropSprites.surfacePlacement(p)}));report.textContent=name.toUpperCase()+' — left to right, top to bottom\n'+groups[name].join(' · ')+'\nRebuilt views in this group: '+changed+'/'+groups[name].length+'; remaining views show the earlier artwork.\nLoaded views: '+status.views.length+'; asset errors: '+status.failures.length+'\nArt fixture only; does not establish interaction or owner approval.'+(mounts.length?'\n'+JSON.stringify(mounts,null,2):'');document.body.dataset.result=status.failures.length||mounts.some(p=>!p.authored)?'fail':'pass';
  }catch(e){report.textContent=e.stack||String(e);document.body.dataset.result='fail';}
 }
 for(const name of Object.keys(groups)){const button=document.createElement('button');button.textContent=name;button.onclick=()=>render(name);document.querySelector('#groups').append(button);}
 const link=document.createElement('a');link.href='/?propSet=projection';link.textContent='Saved station';document.querySelector('#groups').append(link);
 render(new URLSearchParams(location.search).get('group') in groups?new URLSearchParams(location.search).get('group'):'storage');
})().catch(e=>{document.querySelector('#report').textContent=e.stack||String(e);document.body.dataset.result='fail';});
