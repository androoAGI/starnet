/* Authored prop artwork. No catalog, simulation, or orientation ownership.
   Manifest v1: {version:1,props:{id:{views:{s:{image:"id.png",
     sourceWidth,sourceHeight,footprint:{w,h},bounds:{x,y,width,height},
     mode:"static"|"native"|"screen"|"water"|"scanner",nativeLayers:[{polygon:[[x,y],...]}],
     nativeMask:"optional-mask.png",nativeBounds:{x,y,width,height},
     nativeFallbackWhen:["sleeper"]}}}}}.
   Bounds/layers use WORLD pixels relative to the native prop origin (12px/tile).
   Art alpha bounds fit uniformly inside bounds, centered X and at its bottom.
   Mask PNG alpha spans nativeBounds (or bounds); RGB is ignored. Polygon masks
   may extend outside art bounds. Masked casing pixels are removed, then the
   existing native renderer supplies those live pixels, including their OFF state.
   Static mode is an explicit author assertion that the replaced view has no
   internal animation/state. Screen mode animates the NEW art's phosphor and follows
   occupancy without calling the original painter. Native mode is for retained
   legacy drafts only and requires a mask; missing entries/assets,
   custom footprints, classic mode, and unfinished layers retain the native view.
   Source readback happens ONCE at load; frames use small cached canvases only. */
'use strict';
const PropRemaster = (() => {
  // The casing-only drafts remain accessible explicitly, never the default set.
  let draftReview=false,projectionReview=false;
  try{const query=new URLSearchParams(location.search);draftReview=query.get('propReview')==='skins';projectionReview=query.get('propSet')==='projection';}catch(_){}
  // Match the camera's 6x close-zoom limit. A 4x staging canvas softened even
  // full-resolution sources before they reached the final CRT pass.
  const ROOT = 'assets/industrial/'+(draftReview?'props-v2/':projectionReview?'projection-correction/':'approved-sheet/'), DENSITY = projectionReview ? 6 : 4, entries = new Map(), failures = [];
  let revision = 0, pixelBudget = 0;
  const MAX_PIXELS = 12 * 1024 * 1024;
  let measuredGeometry={};
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const rectOK = r => r && [r.x,r.y,r.width,r.height].every(finite) &&
    r.width > 0 && r.height > 0 && r.width <= 192 && r.height <= 192 &&
    Math.abs(r.x) <= 192 && Math.abs(r.y) <= 192;
  const fileOK = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*\.png$/.test(s);
  const pointOK = p => Array.isArray(p) && p.length === 2 && p.every(finite) && p.every(n => Math.abs(n) <= 384);
  const unitPoint = p => Array.isArray(p)&&p.length===2&&p.every(n=>finite(n)&&n>=0&&n<=1);
  const unitPoly = p => Array.isArray(p)&&p.length>=3&&p.length<=16&&p.every(unitPoint);
  const unitRect = r => r&&[r.x,r.y,r.width,r.height].every(finite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=1&&r.y+r.height<=1;
  function validate(v) {
    if (!v || !fileOK(v.image) || !Number.isInteger(v.sourceWidth) || !Number.isInteger(v.sourceHeight) ||
        v.sourceWidth < 1 || v.sourceHeight < 1 || v.sourceWidth > 4096 || v.sourceHeight > 4096 ||
        !rectOK(v.bounds) || !v.footprint || ![v.footprint.w,v.footprint.h].every(n => Number.isInteger(n) && n > 0 && n <= 16) ||
        !['static','native','screen','water','scanner','steam','pulse','pool','content','machine','service','approved'].includes(v.mode)) return false;
    if(v.screenPower!=null&&!['occupied','ambient','bound','connected'].includes(v.screenPower))return false;
    if(v.activity!=null&&!['ambient','work','fired'].includes(v.activity))return false;
    if(v.contact!=null&&(!v.contact||![v.contact.x,v.contact.y].every(n=>finite(n)&&n>=0&&n<=1)))return false;
    if (v.exposure != null && (!finite(v.exposure) || v.exposure < .25 || v.exposure > 3)) return false;
    if (v.nativeBounds != null && !rectOK(v.nativeBounds)) return false;
    if (v.nativeMask != null && !fileOK(v.nativeMask)) return false;
    if (v.nativeLayers != null && (!Array.isArray(v.nativeLayers) || v.nativeLayers.length > 32 ||
        v.nativeLayers.some(l => !l || !Array.isArray(l.polygon) || l.polygon.length < 3 ||
          l.polygon.length > 32 || !l.polygon.every(pointOK)))) return false;
    if (v.nativeFallbackWhen != null && (!Array.isArray(v.nativeFallbackWhen) ||
        v.nativeFallbackWhen.some(s => !['sleeper','crates','pins','trophies','journeyStage'].includes(s)))) return false;
    if(v.screenRegions!=null&&(!Array.isArray(v.screenRegions)||v.screenRegions.length>8||v.screenRegions.some(poly=>
      !Array.isArray(poly)||poly.length<3||poly.length>16||poly.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>!finite(n)||n<0||n>1)))))return false;
    if(['water','scanner','pulse','pool'].includes(v.mode)&&(!v.motion||!unitPoly(v.motion.region)))return false;
    if(v.mode==='water'&&(!Array.isArray(v.motion.bubbleLanes)||v.motion.bubbleLanes.length>4||!v.motion.bubbleLanes.every(unitRect)))return false;
    if(v.mode==='steam'&&(!v.motion||!unitPoint(v.motion.origin)||!finite(v.motion.rise)||v.motion.rise<=0||v.motion.rise>12||v.motion.trigger!=null&&!['ambient','work'].includes(v.motion.trigger)))return false;
    if(v.mode==='pulse'&&(!Array.isArray(v.motion.colour)||v.motion.colour.length!==3||!v.motion.colour.every(n=>finite(n)&&n>=0&&n<=255)||!['work','ambient','fired'].includes(v.motion.trigger)))return false;
    if(v.motion&&v.motion.failureColour!=null&&(!Array.isArray(v.motion.failureColour)||v.motion.failureColour.length!==3||!v.motion.failureColour.every(n=>finite(n)&&n>=0&&n<=255)))return false;
    if(v.foreground!=null&&!unitPoly(v.foreground))return false;
    return v.mode !== 'native' || !!v.nativeMask || !!(v.nativeLayers && v.nativeLayers.length);
  }
  function canvas(w,h) {
    const cv=document.createElement('canvas');cv.width=Math.max(1,Math.ceil(w));cv.height=Math.max(1,Math.ceil(h));
    if(!cv.getContext('2d'))throw Error('canvas unavailable');return cv;
  }
  function image(file) {
    return new Promise((resolve,reject) => {
      const im=new Image();
      im.onload=()=>resolve(im); im.onerror=()=>reject(Error('asset unavailable: '+file)); im.src=ROOT+file;
    });
  }
  function fit(bounds, crop, contact, sourceHeight) {
    const s=Math.min(bounds.width/crop.width,bounds.height/crop.height);
    return {x:bounds.x+(bounds.width-crop.width*s)/2,y:bounds.y+bounds.height-(contact?(contact.y*sourceHeight-(crop.y||0)):crop.height)*s,
      width:crop.width*s,height:crop.height*s};
  }
  async function prepare(key,v) {
    try {
      if(!validate(v))throw Error('invalid manifest view');
      const id=key.split(':')[0];
      if(v.mode==='content'&&(typeof AuthoredPropContent==='undefined'||!AuthoredPropContent.regions[id]))throw Error('authored content unavailable');
      if(v.mode==='service'&&(typeof AuthoredServiceContent==='undefined'||!AuthoredServiceContent.regions[id]))throw Error('authored service content unavailable');
      if(v.mode==='machine'){
        const machine=typeof AuthoredMachineConfig!=='undefined'&&AuthoredMachineConfig.get(id);
        if(!machine||typeof AuthoredPropMotion==='undefined'||machine.motion.sourceWidth!==v.sourceWidth||machine.motion.sourceHeight!==v.sourceHeight)throw Error('authored machine configuration unavailable');
        const layers={};
        for(const [name,file]of Object.entries(machine.layers)){
          if(!fileOK(file))throw Error('invalid machine layer');
          const source=await image(file),scale=Math.min(1,128/Math.max(source.width,source.height));
          const layer=canvas(source.width*scale,source.height*scale),lg=layer.getContext('2d');lg.imageSmoothingQuality='high';lg.drawImage(source,0,0,layer.width,layer.height);layers[name]=layer;
        }
        if(!AuthoredPropMotion.register(id,machine.motion,layers))throw Error('invalid authored mechanism');
      }
      const im=await image(v.image);
      if(im.width!==v.sourceWidth || im.height!==v.sourceHeight)throw Error('source dimensions differ');
      const view=key.split(':')[1];
      const projectionHandled=projectionReview&&typeof ProjectionPropEffects!=='undefined'&&ProjectionPropEffects.matches(id,view,v);
      const projection=projectionHandled?ProjectionPropEffects.prepare(id,view,im,v):null;
      const measured=measuredGeometry[key],mc=measured&&measured.crop;
      const measuredOK=measured&&measured.image===v.image&&measured.width===im.width&&measured.height===im.height&&mc&&
        [mc.x,mc.y,mc.width,mc.height].every(Number.isInteger)&&mc.x>=0&&mc.y>=0&&mc.width>0&&mc.height>0&&mc.x+mc.width<=im.width&&mc.y+mc.height<=im.height;
      let crop,scan,rgba;
      if(measuredOK)crop={...mc};
      else {
        scan=canvas(im.width,im.height);const sg=scan.getContext('2d');sg.drawImage(im,0,0);
        rgba=sg.getImageData(0,0,im.width,im.height).data;
        let l=im.width,t=im.height,r=-1,b=-1;
        for(let i=3;i<rgba.length;i+=4)if(rgba[i]){const p=(i-3)/4,x=p%im.width,y=Math.floor(p/im.width);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
        if(r<l)throw Error('empty source');crop={x:l,y:t,width:r-l+1,height:b-t+1};
      }
      const box=fit(v.bounds,crop,v.contact,v.sourceHeight);
      // Isolate the measured alpha rectangle before scaling. Sampling outside a
      // drawImage source crop can pull transparent padding into its edge pixels.
      const cropped=canvas(crop.width,crop.height),cg=cropped.getContext('2d');
      // Integer 1:1 staging cannot blend outside the alpha crop. Downscale only
      // afterward, from this isolated canvas, preserving the same sampling edge.
      if(measuredOK){cg.imageSmoothingEnabled=false;cg.drawImage(im,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);}
      else {const ci=cg.createImageData(crop.width,crop.height);
        for(let row=0;row<crop.height;row++)ci.data.set(rgba.subarray(((crop.y+row)*im.width+crop.x)*4,((crop.y+row)*im.width+crop.x+crop.width)*4),row*crop.width*4);
        cg.putImageData(ci,0,0);}
      // Release full-resolution staging storage as soon as the cropped source
      // exists. A full catalog must not retain every decode until a later GC.
      rgba=null;if(scan){scan.width=1;scan.height=1;}im.onload=null;im.onerror=null;
      const frame={...v.bounds},regions=v.nativeLayers||[],nb=v.nativeBounds||v.bounds;
      const include=(x,y)=>{const right=Math.max(frame.x+frame.width,x),bottom=Math.max(frame.y+frame.height,y);
        frame.x=Math.min(frame.x,x);frame.y=Math.min(frame.y,y);frame.width=right-frame.x;frame.height=bottom-frame.y;};
      if(v.contact){include(box.x,box.y);include(box.x+box.width,box.y+box.height);}
      if(projectionHandled){
        const extent=ProjectionPropEffects.frameBounds(id,view);
        if(extent){const px=u=>box.x+(u*v.sourceWidth-crop.x)/crop.width*box.width,py=u=>box.y+(u*v.sourceHeight-crop.y)/crop.height*box.height;
          include(px(extent.x),py(extent.y));include(px(extent.x+extent.width),py(extent.y+extent.height));}
      }
      if(v.mode==='native'){
        for(const region of regions)for(const p of region.polygon)include(p[0],p[1]);
        if(v.nativeMask){include(nb.x,nb.y);include(nb.x+nb.width,nb.y+nb.height);}
      }
      if(v.mode==='steam')include(box.x+v.motion.origin[0]*box.width,box.y+v.motion.origin[1]*box.height-v.motion.rise);
      if(frame.width>256||frame.height>256)throw Error('layer bounds too large');
      const pw=Math.ceil(frame.width*DENSITY),ph=Math.ceil(frame.height*DENSITY);
      const cost=pw*ph*((projectionHandled?1:v.mode==='native'?3:v.mode==='screen'||v.screenPower?10:v.mode==='pool'?49:['water','scanner','steam','pulse'].includes(v.mode)?13:['content','machine','service'].includes(v.mode)?2:1)+(v.foreground?1:0)+(!projectionHandled&&v.activity?2:0))+(projection?.image?projection.width*projection.height:0);
      if(pixelBudget+cost>MAX_PIXELS)throw Error('decoded prop budget exceeded');
      const body=canvas(pw,ph),g=body.getContext('2d');
      g.scale(DENSITY,DENSITY);g.translate(-frame.x,-frame.y);
      g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';
      g.filter='brightness('+(v.exposure||1)+')';
      g.drawImage(cropped,box.x,box.y,box.width,box.height);
      cropped.width=1;cropped.height=1;
      g.filter='none';
      let mask=null,live=null;
      if(v.mode==='native'){
        mask=canvas(pw,ph);const mg=mask.getContext('2d');
        mg.scale(DENSITY,DENSITY);mg.translate(-frame.x,-frame.y);mg.fillStyle='#fff';
        for(const region of regions){mg.beginPath();region.polygon.forEach((p,i)=>i?mg.lineTo(...p):mg.moveTo(...p));mg.closePath();mg.fill();}
        if(v.nativeMask){const mi=await image(v.nativeMask);mg.drawImage(mi,nb.x,nb.y,nb.width,nb.height);}
        g.setTransform(1,0,0,1,0,0);g.globalCompositeOperation='destination-out';g.drawImage(mask,0,0);
        live=canvas(pw,ph);
      }
      // Concurrent image decodes may finish between the initial budget check
      // and mask decode, so enforce the shared bound again at the commit point.
      if(pixelBudget+cost>MAX_PIXELS)throw Error('decoded prop budget exceeded');
      const screen=!projectionHandled&&(v.mode==='screen'||v.screenPower)?authoredScreen(body,v.screenRegions,box,frame):null;
      const approved= !projectionHandled&&v.mode==='approved'&&v.effects!==false&&typeof ApprovedSheetEffects!=='undefined'&&ApprovedSheetEffects.ids.includes(id)
        ?ApprovedSheetEffects.prepare(id,im,{sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight,crop}):null;
      const indicators=!projectionHandled&&v.activity?authoredIndicators(body):null;
      const motion=!projectionHandled&&['water','scanner','steam','pulse','pool'].includes(v.mode)?authoredMotion(body,v,box,frame):null;
      let foreground=null;
      if(v.foreground){
        foreground=canvas(pw,ph);const fg=foreground.getContext('2d');fg.beginPath();
        v.foreground.forEach((p,i)=>{const x=(box.x-frame.x+p[0]*box.width)*DENSITY,y=(box.y-frame.y+p[1]*box.height)*DENSITY;i?fg.lineTo(x,y):fg.moveTo(x,y);});
        fg.closePath();fg.clip();fg.drawImage(body,0,0);
      }
      const composed=['content','machine','service'].includes(v.mode)?canvas(pw,ph):null;
      let projectionEmitter=null;
      if(projectionHandled){const emitter=ProjectionPropEffects.classify(id,view).effects.find(e=>['screen','connector','lamp'].includes(e.kind));
        if(emitter){const cx=emitter.region.reduce((n,p)=>n+p[0],0)/emitter.region.length,cy=emitter.region.reduce((n,p)=>n+p[1],0)/emitter.region.length;
          projectionEmitter={x:box.x+(cx*v.sourceWidth-crop.x)/crop.width*box.width,y:box.y+(cy*v.sourceHeight-crop.y)/crop.height*box.height};}}
      const entry={spec:v,body,mask,live,screen,motion,foreground,composed,approved,indicators,projectionHandled,projection,projectionEmitter,frame,box,crop,lost:false};
      // One byte per prepared pixel; pointer picking never reads a canvas in-frame.
      const pickPixels=body.getContext('2d').getImageData(0,0,pw,ph).data;
      entry.pickAlpha=new Uint8Array(pw*ph);
      for(let i=0;i<entry.pickAlpha.length;i++)entry.pickAlpha[i]=pickPixels[i*4+3];
      for(const plane of [body,mask,live,foreground,composed,screen&&screen.off,...(motion||[])])if(plane&&plane.addEventListener)
        plane.addEventListener('contextlost',()=>{entry.lost=true;if(entry.projection)ProjectionPropEffects.dispose(entry.projection);},{once:true});
      pixelBudget+=cost;entries.set(key,entry);revision++;
    }catch(e){failures.push({view:key,reason:String(e.message||e)});}
  }
  // Complete new display art: no original sprite is drawn beneath or over it.
  // Power follows physical occupancy; motion modifies only authored cyan phosphor.
  function authoredScreen(body,regions,box,frame){
    const w=body.width,h=body.height,src=body.getContext('2d').getImageData(0,0,w,h),off=canvas(w,h),g=off.getContext('2d');
    let glass=null;
    if(regions&&regions.length){
      const cv=canvas(w,h),cg=cv.getContext('2d');cg.fillStyle='#fff';
      for(const poly of regions){cg.beginPath();poly.forEach((p,i)=>{const x=(box.x-frame.x+p[0]*box.width)*DENSITY,y=(box.y-frame.y+p[1]*box.height)*DENSITY;i?cg.lineTo(x,y):cg.moveTo(x,y);});cg.closePath();cg.fill();}
      glass=cg.getImageData(0,0,w,h).data;
    }
    const dim=g.createImageData(w,h);dim.data.set(src.data);const phosphor=new Uint8Array(w*h);let sx=0,sy=0,total=0;
    for(let p=0;p<w*h;p++){
      const i=p*4,r=src.data[i],gb=Math.min(src.data[i+1],src.data[i+2]),cyan=gb-r;
      if(src.data[i+3]<160)continue;
      const isCyan=cyan>=8&&r<=gb*.8;
      if(!isCyan&&!(glass&&glass[i+3]>=160))continue;
      dim.data[i]=Math.min(12,r*.2+3);dim.data[i+1]=Math.min(20,src.data[i+1]*.055+7);dim.data[i+2]=Math.min(22,src.data[i+2]*.06+8);
      if(!isCyan)continue; // turn off white plot marks too; the moving beam stays cyan
      phosphor[p]=Math.min(255,cyan*2);
      sx+=(p%w+.5)*cyan;sy+=(Math.floor(p/w)+.5)*cyan;total+=cyan;
    }
    g.putImageData(dim,0,0);return{off,phosphor,frames:new Map(),w,h,centroid:total?{x:sx/total/DENSITY,y:sy/total/DENSITY}:null};
  }
  function screenBeam(s,phase){
    if(s.frames.has(phase))return s.frames.get(phase);
    const cv=canvas(s.w,s.h),g=cv.getContext('2d'),p=g.createImageData(s.w,s.h);
    for(let n=0;n<s.phosphor.length;n++)if(s.phosphor[n]){
      const y=Math.floor(n/s.w)/s.h,beam=Math.max(0,1-Math.abs(y-phase/7)/.18),i=n*4;
      p.data[i]=115;p.data[i+1]=235;p.data[i+2]=244;p.data[i+3]=Math.round(s.phosphor[n]/255*beam*110);
    }
    g.putImageData(p,0,0);s.frames.set(phase,cv);return cv;
  }
  // Motion is authored in the new sprite's source coordinates. Water stays
  // decorative; the reader receives an explicit real-belt occupancy flag.
  // All frames are built once, with no legacy sprite fragments or frame readback.
  function authoredMotion(body,v,box,frame){
    const X=n=>(box.x-frame.x+n*box.width)*DENSITY,Y=n=>(box.y-frame.y+n*box.height)*DENSITY;
    const frames=v.mode==='pool'?48:12;
    return Array.from({length:frames},(_,phase)=>{
      const cv=canvas(body.width,body.height),g=cv.getContext('2d'),u=phase/frames;
      if(v.mode==='steam'){
        const x=X(v.motion.origin[0]),y=Y(v.motion.origin[1]),rise=v.motion.rise*DENSITY;
        g.strokeStyle='rgba(218,224,214,'+(.10+.10*Math.sin(u*Math.PI))+')';g.lineWidth=DENSITY*.22;
        g.beginPath();g.moveTo(x,y);g.bezierCurveTo(x+DENSITY*Math.sin(u*6.28),y-rise*.35,x-DENSITY*Math.cos(u*6.28),y-rise*.7,x,y-rise);g.stroke();return cv;
      }
      g.save();g.beginPath();v.motion.region.forEach((p,i)=>i?g.lineTo(X(p[0]),Y(p[1])):g.moveTo(X(p[0]),Y(p[1])));g.closePath();g.clip();
      if(v.mode==='pulse'){
        g.fillStyle='rgba('+v.motion.colour.join(',')+','+(.04+.18*Math.pow(Math.sin(u*Math.PI),2))+')';g.fillRect(0,0,body.width,body.height);
      }else if(v.mode==='pool'){
        const balls=[[.27+.34*(1-Math.cos(u*Math.PI*2))*.5,.29,'#e0d3af'],[.69,.22,'#a25d30'],[.72,.30,'#357b6d'],[.68,.39,'#9b3840']];
        for(const [x,y,colour]of balls){const cx=X(x),cy=Y(y),radius=DENSITY*.62;g.fillStyle='#121915';g.beginPath();g.ellipse(cx+DENSITY*.16,cy+DENSITY*.25,radius,radius*.65,0,0,Math.PI*2);g.fill();
          const sphere=g.createRadialGradient(cx-radius*.3,cy-radius*.4,0,cx,cy,radius);sphere.addColorStop(0,'#f2e4c3');sphere.addColorStop(.3,colour);sphere.addColorStop(1,'#252724');g.fillStyle=sphere;g.beginPath();g.arc(cx,cy,radius,0,Math.PI*2);g.fill();}
      }else if(v.mode==='scanner'){
        const xs=v.motion.region.map(p=>X(p[0])),ys=v.motion.region.map(p=>Y(p[1]));
        const left=Math.min(...xs),top=Math.min(...ys),width=Math.max(...xs)-left,height=Math.max(...ys)-top;
        g.fillStyle='rgba(207,157,249,.48)';g.fillRect(left+u*width,top,Math.max(1,DENSITY*.32),height);
      }else{
        g.strokeStyle='rgba(157,236,225,.20)';g.lineWidth=DENSITY*.16;
        for(let n=0;n<5;n++){
          const yy=.61+n*.023+Math.sin(u*Math.PI*2+n)*.014;
          g.beginPath();g.moveTo(X(.13),Y(yy));g.bezierCurveTo(X(.32),Y(yy+.025),X(.51),Y(yy-.025),X(.73),Y(yy));g.stroke();
        }
      }
      g.restore();
      if(v.mode==='water')for(const [laneIndex,lane]of v.motion.bubbleLanes.entries()){
        g.save();g.beginPath();g.rect(X(lane.x),Y(lane.y),lane.width*box.width*DENSITY,lane.height*box.height*DENSITY);g.clip();
        for(let n=0;n<3;n++){
          const progress=(u+n/3+laneIndex*.17)%1,cx=X(lane.x+lane.width*(.3+.35*Math.sin(n*2+u*4))),cy=Y(lane.y+lane.height*(1-progress));
          const radius=DENSITY*(.18+n*.055);g.strokeStyle='rgba(181,242,236,'+(.24+.4*Math.sin(progress*Math.PI))+')';g.lineWidth=DENSITY*.12;
          g.beginPath();g.arc(cx,cy,radius,0,Math.PI*2);g.stroke();
        }g.restore();
      }
      g.globalCompositeOperation='destination-in';g.drawImage(body,0,0);return cv;
    });
  }
  function authoredIndicators(body){
    const src=body.getContext('2d').getImageData(0,0,body.width,body.height).data;
    return [[239,194,103],[222,85,68]].map(colour=>{const cv=canvas(body.width,body.height),g=cv.getContext('2d'),p=g.createImageData(body.width,body.height);
      for(let i=0;i<src.length;i+=4){const hi=Math.max(src[i],src[i+1],src[i+2]),lo=Math.min(src[i],src[i+1],src[i+2]);if(src[i+3]<180||hi<110||hi-lo<32)continue;
        p.data[i]=colour[0];p.data[i+1]=colour[1];p.data[i+2]=colour[2];p.data[i+3]=Math.min(100,hi-lo);}
      g.putImageData(p,0,0);return cv;});
  }
  function remasterOn(){
    return typeof IndustrialTextures!=='undefined' && typeof IndustrialTextures.isRemaster==='function' && IndustrialTextures.isRemaster();
  }
  function enabled(id,view='s'){return remasterOn()&&entries.has(id+':'+view);}
  function draw(ctx,id,view,x,y,w,h,state,drawNative) {
    if(!enabled(id,view))return false;
    const e=entries.get(id+':'+view),v=e.spec;
    if(e.lost)return false; // a lost cached plane must never make the prop disappear
    // A saved custom box is already a native geometry contract, not permission to squash.
    if(w!==v.footprint.w*12||h!==v.footprint.h*12||
      (v.nativeFallbackWhen||[]).some(k=>state&&state[k]))return false;
    const f=e.frame;
    if(e.composed){
      const g=e.composed.getContext('2d');g.save();
      try{
        g.setTransform(1,0,0,1,0,0);g.globalAlpha=1;g.globalCompositeOperation='source-over';g.clearRect(0,0,e.composed.width,e.composed.height);g.drawImage(e.body,0,0);
        g.scale(DENSITY,DENSITY);g.translate(-f.x,-f.y);
        if(v.mode==='content')AuthoredPropContent.draw(g,id,{...e.box,crop:e.crop},state||{});
        if(v.mode==='machine')AuthoredPropMotion.draw(g,id,{...e.box,crop:e.crop},state||{});
        if(v.mode==='service')AuthoredServiceContent.draw(g,id,{...e.box,crop:e.crop},state||{});
      }finally{g.restore();}
      ctx.save();try{ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(e.composed,x+f.x,y+f.y,e.composed.width/DENSITY,e.composed.height/DENSITY);}finally{ctx.restore();}
      return true;
    }
    if(e.live){
      const g=e.live.getContext('2d');g.save();
      try{
        g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,e.live.width,e.live.height);
        g.globalAlpha=1;g.globalCompositeOperation='source-over';g.imageSmoothingEnabled=false;
        g.scale(DENSITY,DENSITY);g.translate(-x-f.x,-y-f.y);
        drawNative(g);
        g.setTransform(1,0,0,1,0,0);g.globalAlpha=1;g.globalCompositeOperation='destination-in';g.drawImage(e.mask,0,0);
      }finally{g.restore();}
    }
    ctx.save();
    try{
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      const baseAlpha=ctx.globalAlpha;
      const occupied=v.screenPower==='ambient'?true:v.screenPower==='connected'?!!state?.live:v.screenPower==='bound'?!!state?.bound&&state.state==='online':state&&typeof state.occupied==='boolean'?state.occupied:!!(state&&state.work);
      ctx.drawImage(e.screen&&!occupied?e.screen.off:e.body,x+f.x,y+f.y,e.body.width/DENSITY,e.body.height/DENSITY);
      if(e.live)ctx.drawImage(e.live,x+f.x,y+f.y,e.live.width/DENSITY,e.live.height/DENSITY);
      if(e.screen&&occupied&&!(state&&state.still)){
        const phase=Math.floor((Math.max(0,Number(state&&state.now)||0)%2800)/350);
        ctx.globalCompositeOperation='source-atop';
        ctx.globalAlpha *= .65 + .2 * Math.max(0,Math.min(1,Number(state&&state.heat)||0));
        ctx.drawImage(screenBeam(e.screen,phase),x+f.x,y+f.y,e.body.width/DENSITY,e.body.height/DENSITY);
      }
      const fired=v.mode==='pulse'&&v.motion.trigger==='fired';
      const active=fired?!!(state&&state.fired):v.mode==='scanner'?!!(state&&state.scanning):v.mode==='pool'||['pulse','steam'].includes(v.mode)&&v.motion.trigger==='work'?!!(state&&state.work):true;
      const moving=!(state&&state.still)&&active;
      if(e.motion&&(moving||v.mode==='pool'||fired&&active)){
        const period=v.mode==='scanner'?900:4800,phase=moving?Math.floor((Math.max(0,Number(state&&state.now)||0)%period)/period*e.motion.length):fired?6:0;
        ctx.globalCompositeOperation=v.mode==='steam'?'source-over':'source-atop';
        if(fired&&state.bad&&v.motion.failureColour){
          ctx.fillStyle='rgba('+v.motion.failureColour.join(',')+',.48)';ctx.beginPath();
          v.motion.region.forEach((p,i)=>{const px=x+e.box.x+p[0]*e.box.width,py=y+e.box.y+p[1]*e.box.height;i?ctx.lineTo(px,py):ctx.moveTo(px,py);});ctx.closePath();ctx.fill();
        }else ctx.drawImage(e.motion[phase],x+f.x,y+f.y,e.body.width/DENSITY,e.body.height/DENSITY);
      }
      if(v.mode==='approved'){
        ctx.globalCompositeOperation='source-over';ctx.globalAlpha=baseAlpha;
        if(e.approved&&typeof ApprovedSheetEffects!=='undefined')ApprovedSheetEffects.draw(ctx,id,{x:x+e.box.x,y:y+e.box.y,width:e.box.width,height:e.box.height,crop:e.crop,sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight},{...state,prepared:e.approved});
        approvedState(ctx,id,e,x,y,state||{});
      }
      if(e.projectionHandled){ctx.globalAlpha=baseAlpha;ctx.globalCompositeOperation='source-over';
        ProjectionPropEffects.draw(ctx,id,view,{x:x+e.box.x,y:y+e.box.y,width:e.box.width,height:e.box.height,crop:e.crop,sourceWidth:v.sourceWidth,sourceHeight:v.sourceHeight},state||{},e.projection);}
    }finally{ctx.restore();}
    return true;
  }
  function approvedState(ctx,id,e,x,y,state){
    // Small real-state marks sit below the source artwork. These are readable
    // telemetry, never invented inventory or replacement geometry in the PNG.
    let label=null;
    if(id==='outbox'&&state.crates>0)label=String(state.crates)+' pending';
    if(id==='missionboard'&&state.pins>0)label=String(state.pins)+' quests';
    if(id==='trophycase'&&state.trophies>0)label=String(state.trophies)+' earned';
    if(id==='airlock'&&state.door)label=String(state.door).slice(0,16);
    if(label){ctx.font='3px monospace';ctx.textAlign='center';ctx.fillStyle='#cbb985';ctx.fillText(label,x+e.spec.footprint.w*6,y+e.box.y+e.box.height+3);}
    const trigger=e.spec.activity,amount=trigger==='fired'?Math.max(0,Math.min(1,+state.fired||0)):trigger==='work'&&state.work?1:trigger==='ambient'?.3:0;
    if(amount&&!e.approved&&e.indicators){ctx.globalAlpha*=amount*(state.still?.45:.35+.15*Math.sin((+state.now||0)/280));ctx.drawImage(e.indicators[state.bad?1:0],x+e.frame.x,y+e.frame.y,e.body.width/DENSITY,e.body.height/DENSITY);}
  }
  const ready=(async()=>{
    if(typeof document==='undefined'||typeof Image==='undefined'||typeof fetch!=='function')return;
    try{
      // Classic avoids all optional asset traffic and remains independently runnable.
      if(typeof location!=='undefined' && new URLSearchParams(location.search||'').get('textures')==='classic')return;
      const response=await fetch(ROOT+'manifest.json');if(!response.ok)throw Error('manifest unavailable');
      const manifest=await response.json();
      if(!manifest||manifest.version!==1||!manifest.props||typeof manifest.props!=='object')throw Error('invalid manifest');
      if(projectionReview)try{const geometry=await fetch(ROOT+'runtime-geometry.json');if(geometry.ok){const data=await geometry.json();if(data.version===1&&data.views)measuredGeometry=data.views;}}catch(_){} // older packs retain measured-at-load fallback
      const queue=[];
      for(const [id,p]of Object.entries(manifest.props)){
        if(!/^[A-Za-z0-9_]+$/.test(id)||!p||!p.views)continue;
        for(const [view,v]of Object.entries(p.views))if(['s','n','e','w'].includes(view))queue.push([id+':'+view,v]);
      }
      if(queue.length>640)throw Error('too many authored views');
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(next<queue.length){const task=queue[next++];await prepare(...task);}}));
      if(typeof document!=='undefined'&&document.documentElement){
        document.documentElement.dataset.propRasterViews=String(entries.size);
        document.documentElement.dataset.propRasterFailures=String(failures.length);
        document.documentElement.dataset.propRasterDensity=String(DENSITY);
        document.documentElement.dataset.propRasterPixels=String(pixelBudget);
      }
    }catch(e){failures.push({view:'manifest',reason:String(e.message||e)});}
  })();
  function emitter(id,view='s',w,h){
    const e=enabled(id,view)&&entries.get(id+':'+view),p=e&&e.screen&&e.screen.centroid;
    if(e&&(e.lost||(w!=null&&w!==e.spec.footprint.w*12)||(h!=null&&h!==e.spec.footprint.h*12)))return null;
    if(e?.projectionEmitter)return {...e.projectionEmitter};
    return p?{x:e.frame.x+p.x,y:e.frame.y+p.y}:null;
  }
  function screenEmission(id,view='s',w,h,state={}){
    const e=enabled(id,view)&&entries.get(id+':'+view);
    if(!e||e.lost||!e.projectionHandled||w!==e.spec.footprint.w*12||h!==e.spec.footprint.h*12)return null;
    const p=ProjectionPropEffects.screenEmission(id,view,state);if(!p)return null;
    return {...p,screenEmission:true,x:e.box.x+(p.x*e.spec.sourceWidth-e.crop.x)/e.crop.width*e.box.width,
      y:e.box.y+(p.y*e.spec.sourceHeight-e.crop.y)/e.crop.height*e.box.height};
  }
  function drawForeground(ctx,id,view,x,y,w,h,mirror=false){
    const e=enabled(id,view)&&entries.get(id+':'+view);
    if(!e||e.lost||!e.foreground||w!==e.spec.footprint.w*12||h!==e.spec.footprint.h*12)return false;
    ctx.save();try{ctx.translate(x,y);if(mirror){ctx.translate(w,0);ctx.scale(-1,1);}ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      ctx.drawImage(e.foreground,e.frame.x,e.frame.y,e.body.width/DENSITY,e.body.height/DENSITY);
    }finally{ctx.restore();}return true;
  }
  function viewGeometry(id,view='s'){
    const e=enabled(id,view)&&entries.get(id+':'+view);
    return !e||e.lost?null:{box:{...e.box},crop:{...e.crop},spec:{...e.spec},surfaceSupport:e.spec.surfaceSupport};
  }
  function hitTest(id,view,x,y,w,h){
    const e=enabled(id,view)&&entries.get(id+':'+view);
    if(!e||e.lost||w!==e.spec.footprint.w*12||h!==e.spec.footprint.h*12)return null;
    const px=Math.floor((x-e.frame.x)*DENSITY),py=Math.floor((y-e.frame.y)*DENSITY);
    return px>=0&&py>=0&&px<e.body.width&&py<e.body.height&&e.pickAlpha[py*e.body.width+px]>=24;
  }
  return Object.freeze({ready,enabled,draw,drawForeground,emitter,screenEmission,viewGeometry,hitTest,isProjection:()=>projectionReview,revision:()=>revision,
    status:()=>({views:Array.from(entries.keys()),failures:failures.slice(),pixels:pixelBudget}),
    // Pure contracts exposed for deterministic headless geometry validation.
    validate,fit});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=PropRemaster;
