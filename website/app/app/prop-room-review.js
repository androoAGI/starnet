'use strict';
(async()=>{
 await Promise.all([IndustrialTextures.ready,PropRemaster.ready]);await SPRITES.init();await SPRITES.ensureSkin('station_minion');
 const groups={storage:['bookshelf','shelf','industrial_drawerbank','arc_indexwall','industrial_locker','rack','war_intelcab','safe'],utility:['coffee','quarters_minifridge','quarters_vending','jukebox','pixelrig','intake','core','rackV'],crew:['industrial_bench','dinerchair','dinertable','booth','podchair','beanbag','bunk','industrial_planter'],tables:['lowtable','lowtable:e','glasstable','glasstable:e','loungetable','loungetable:e','longtable','longtable:e']};
 groups.machinery=['tank','tube','fabricator','vat','industrial_servicecab','cryopod','incubator','comms_uplink'];
 groups['crew-facings']=['dinerchair:w','dinerchair:n','dinerchair:e','podchair:w','podchair:n','podchair:e','booth:w','booth:e','dinertable:e'];
 groups.command=['console','consoleL','bench','bridge_consolebank','bridge_equipmentbay','bigscreen','holotable','bridge_tacticaltable'];
 const response=await fetch('assets/industrial/'+(new URLSearchParams(location.search).get('propSet')==='projection'?'projection-correction':'approved-sheet')+'/manifest.json');
 if(!response.ok)throw Error('Prop manifest HTTP '+response.status);
 const manifest=await response.json(),revised=new Set((manifest.revisedViews||[]).map(v=>v.id+':'+v.view));
 for(const entry of manifest.revisedViews||[]){if(['lounge','glass-depth','crew-facings','utility','storage','crew','tables','machinery','command'].includes(entry.group))continue;(groups[entry.group]||(groups[entry.group]=[])).push(entry.id+(entry.view==='s'?'':':'+entry.view));}
 groups['mirrored-facings']=['desk2:w','industrial_partition:w'];
 WorldModel.setPropRules(id=>PropSprites.spec(id));
 let powered=false,currentGroup='storage';
 const cv=document.querySelector('#room'),g=cv.getContext('2d'),report=document.querySelector('#report');
 function render(name){
  try{
   currentGroup=name;
   document.querySelector('#groupPicker').value=name;
   const specs=groups[name].map(item=>{const [id,face='s']=item.split(':');const r=({s:0,w:1,n:2,e:3})[face];return {id,face,r,fp:PropSprites.footprintAt(id,r)};}),cols=specs.some(p=>p.fp.w>5)?2:4,stride=Math.max(7,...specs.map(p=>p.fp.w+3));let roomWidth=Math.max(31,cols*stride+2);
   let rowY=4;const positions=[];for(let start=0;start<specs.length;start+=cols){const row=specs.slice(start,start+cols);row.forEach((p,i)=>positions.push({...p,x:2+i*stride,y:rowY}));rowY+=Math.max(2,...row.map(p=>p.fp.h))+4;}const anchorY=rowY;let wallX=2;for(const p of positions)if(PropSprites.spec(p.id).mount==='wall'){p.x=wallX;p.y=0;wallX+=p.fp.w+3;}roomWidth=Math.max(roomWidth,wallX+2);
   const doc=WorldModel.defaultDoc(),roomId=doc.order[0];doc.rooms={[roomId]:{...doc.rooms[roomId],name:'ART REVIEW',rects:[{x1:0,y1:0,x2:roomWidth,y2:anchorY+3}]}};doc.order=[roomId];doc.props=[];doc.belts={};
   const add=(t,x,y,r=0,w,h)=>{const fp=PropSprites.footprintAt(t,r);const p={id:'review-'+doc.props.length,t,x,y,w:w||fp.w,h:h||fp.h,r};doc.props.push(p);return p;};
   for(const {id,face,r,x,y}of positions){const p=add(id,x,y,r);
    if(manifest.props[id].views[face]?.surfaceSupport){const mug=add('mug',p.x+Math.floor(p.w/2),p.y);mug.mount='surface';if(p.h>1){const second=add('mug',p.x,p.y+p.h-1);second.mount='surface';}}
   }
   add('desk',3,anchorY,0,2,1);add('crate',11,anchorY);add('chair',18,anchorY);
   const station=WorldModel.deserialize(doc),geo=station.projectGeometry(),bake=StationBake.bake(geo),scale=2.5,rendered=geo.props.map(p=>({...p,mount:station.mountOf(p)}));
   cv.width=Math.ceil(geo.W*scale);cv.height=Math.ceil(geo.H*scale);g.setTransform(scale,0,0,scale,0,0);g.clearRect(0,0,geo.W,geo.H);g.drawImage(bake.baseCv,0,0);PropSprites.setCtx(g);PropSprites.setNow(0);PropSprites.setSurfaceLayout(rendered);
   for(const p of rendered)PropSprites.drawShadow(p,p.mount);
   const order=p=>{const mounted=p.mount==='surface'&&PropSprites.surfacePlacement(p);return mounted&&Number.isFinite(mounted.sortY)?mounted.sortY:(p.y+p.h)*12;};
   for(const p of [...rendered].sort((a,b)=>order(a)-order(b)))PropSprites.draw(p,powered,{still:true,occupied:powered});
   SPRITES.drawBody(g,{id:'art-scale-crew',skin:'station_minion',px:(25-geo.origin.tx)*12,py:(anchorY+1-geo.origin.ty)*12,state:'idle',dir:'south'},0,{reducedMotion:true});
   g.drawImage(bake.lightCv,0,0);
   const status=PropRemaster.status(),changed=groups[name].filter(item=>revised.has(name==='mirrored-facings'?item.replace(':w',':e'):(item.includes(':')?item:item+':s'))).length,mounts=rendered.filter(p=>p.mount==='surface').map(p=>({id:p.id,...PropSprites.surfacePlacement(p)}));report.textContent=name.toUpperCase()+' — catalog order; wall mounts placed along north wall\n'+groups[name].join(' · ')+'\nRebuilt views in this group: '+changed+'/'+groups[name].length+(name==='mirrored-facings'?' (west mirrors revised east art).':'')+'\nLoaded views: '+status.views.length+'; asset errors: '+status.failures.length+'\nScreen art preview: '+(powered?'ON (demonstration only)':'OFF')+'\nArt fixture only; does not establish interaction or owner approval.'+(mounts.length?'\n'+JSON.stringify(mounts,null,2):'');document.body.dataset.result=status.failures.length||mounts.some(p=>!p.authored)?'fail':'pass';
  }catch(e){report.textContent=e.stack||String(e);document.body.dataset.result='fail';}
 }
 const picker=document.createElement('select');picker.id='groupPicker';picker.setAttribute('aria-label','Catalog group');for(const name of Object.keys(groups)){const option=document.createElement('option');option.value=name;option.textContent=name;picker.append(option);}picker.onchange=()=>{const url=new URL(location.href);url.searchParams.set('group',picker.value);history.replaceState(null,'',url);render(picker.value);};document.querySelector('#groups').append(picker);
 const size=document.createElement('button');let large=false;size.textContent='Enlarge';size.onclick=()=>{large=!large;cv.style.maxHeight=large?'none':'calc(100vh - 265px)';cv.style.maxWidth=large?'none':'100%';size.textContent=large?'Fit room':'Enlarge';};document.querySelector('#groups').append(size);
 const power=document.createElement('button');power.textContent='Screen art preview: off';power.onclick=()=>{powered=!powered;power.textContent='Screen art preview: '+(powered?'on':'off');render(currentGroup);};document.querySelector('header').append(power);
 const link=document.createElement('a');link.href='/?propSet=projection';link.textContent='Saved station';document.querySelector('#groups').append(link);
 render(new URLSearchParams(location.search).get('group') in groups?new URLSearchParams(location.search).get('group'):'storage');
})().catch(e=>{document.querySelector('#report').textContent=e.stack||String(e);document.body.dataset.result='fail';});
