/* Optional authored prop skins. No catalog, simulation, or orientation ownership.
   Manifest v1: {version:1,props:{id:{views:{s:{image:"id.png",
     sourceWidth,sourceHeight,footprint:{w,h},bounds:{x,y,width,height},
     mode:"static"|"native",nativeLayers:[{polygon:[[x,y],...]}],
     nativeMask:"optional-mask.png",nativeBounds:{x,y,width,height},
     nativeFallbackWhen:["sleeper"]}}}}}.
   Bounds/layers use WORLD pixels relative to the native prop origin (12px/tile).
   Art alpha bounds fit uniformly inside bounds, centered X and at its bottom.
   Mask PNG alpha spans nativeBounds (or bounds); RGB is ignored. Polygon masks
   may extend outside art bounds. Masked casing pixels are removed, then the
   existing native renderer supplies those live pixels, including their OFF state.
   Static mode is an explicit author assertion that the replaced view has no
   internal animation/state. Native mode requires a mask; missing entries/assets,
   custom footprints, classic mode, and unfinished layers retain the native view.
   Source readback happens ONCE at load; frames use small cached canvases only. */
'use strict';
const PropRemaster = (() => {
  const ROOT = 'assets/industrial/props-v2/', DENSITY = 4, entries = new Map(), failures = [];
  let revision = 0, pixelBudget = 0;
  const MAX_PIXELS = 12 * 1024 * 1024;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const rectOK = r => r && [r.x,r.y,r.width,r.height].every(finite) &&
    r.width > 0 && r.height > 0 && r.width <= 192 && r.height <= 192 &&
    Math.abs(r.x) <= 192 && Math.abs(r.y) <= 192;
  const fileOK = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*\.png$/.test(s);
  const pointOK = p => Array.isArray(p) && p.length === 2 && p.every(finite) && p.every(n => Math.abs(n) <= 384);
  function validate(v) {
    if (!v || !fileOK(v.image) || !Number.isInteger(v.sourceWidth) || !Number.isInteger(v.sourceHeight) ||
        v.sourceWidth < 1 || v.sourceHeight < 1 || v.sourceWidth > 4096 || v.sourceHeight > 4096 ||
        !rectOK(v.bounds) || !v.footprint || ![v.footprint.w,v.footprint.h].every(n => Number.isInteger(n) && n > 0 && n <= 16) ||
        !['static','native'].includes(v.mode)) return false;
    if (v.exposure != null && (!finite(v.exposure) || v.exposure < .25 || v.exposure > 3)) return false;
    if (v.nativeBounds != null && !rectOK(v.nativeBounds)) return false;
    if (v.nativeMask != null && !fileOK(v.nativeMask)) return false;
    if (v.nativeLayers != null && (!Array.isArray(v.nativeLayers) || v.nativeLayers.length > 32 ||
        v.nativeLayers.some(l => !l || !Array.isArray(l.polygon) || l.polygon.length < 3 ||
          l.polygon.length > 32 || !l.polygon.every(pointOK)))) return false;
    if (v.nativeFallbackWhen != null && (!Array.isArray(v.nativeFallbackWhen) ||
        v.nativeFallbackWhen.some(s => !['sleeper','crates','pins','trophies','journeyStage'].includes(s)))) return false;
    return v.mode === 'static' || !!v.nativeMask || !!(v.nativeLayers && v.nativeLayers.length);
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
  function fit(bounds, crop) {
    const s=Math.min(bounds.width/crop.width,bounds.height/crop.height);
    return {x:bounds.x+(bounds.width-crop.width*s)/2,y:bounds.y+bounds.height-crop.height*s,
      width:crop.width*s,height:crop.height*s};
  }
  async function prepare(key,v) {
    try {
      if(!validate(v))throw Error('invalid manifest view');
      const im=await image(v.image);
      if(im.width!==v.sourceWidth || im.height!==v.sourceHeight)throw Error('source dimensions differ');
      const scan=canvas(im.width,im.height),sg=scan.getContext('2d');sg.drawImage(im,0,0);
      const rgba=sg.getImageData(0,0,im.width,im.height).data;
      let l=im.width,t=im.height,r=-1,b=-1;
      for(let i=3;i<rgba.length;i+=4)if(rgba[i]){
        const p=(i-3)/4,x=p%im.width,y=Math.floor(p/im.width);
        l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);
      }
      if(r<l)throw Error('empty source');
      const crop={x:l,y:t,width:r-l+1,height:b-t+1},box=fit(v.bounds,crop);
      // Isolate the measured alpha rectangle before scaling. Sampling outside a
      // drawImage source crop can pull transparent padding into its edge pixels.
      const cropped=canvas(crop.width,crop.height),cg=cropped.getContext('2d');
      const ci=cg.createImageData(crop.width,crop.height);
      for(let row=0;row<crop.height;row++)ci.data.set(
        rgba.subarray(((crop.y+row)*im.width+crop.x)*4,((crop.y+row)*im.width+crop.x+crop.width)*4),
        row*crop.width*4);
      cg.putImageData(ci,0,0);
      const frame={...v.bounds},regions=v.nativeLayers||[],nb=v.nativeBounds||v.bounds;
      const include=(x,y)=>{const right=Math.max(frame.x+frame.width,x),bottom=Math.max(frame.y+frame.height,y);
        frame.x=Math.min(frame.x,x);frame.y=Math.min(frame.y,y);frame.width=right-frame.x;frame.height=bottom-frame.y;};
      if(v.mode==='native'){
        for(const region of regions)for(const p of region.polygon)include(p[0],p[1]);
        if(v.nativeMask){include(nb.x,nb.y);include(nb.x+nb.width,nb.y+nb.height);}
      }
      if(frame.width>256||frame.height>256)throw Error('layer bounds too large');
      const pw=Math.ceil(frame.width*DENSITY),ph=Math.ceil(frame.height*DENSITY);
      const cost=pw*ph*(v.mode==='native'?3:1);
      if(pixelBudget+cost>MAX_PIXELS)throw Error('decoded prop budget exceeded');
      const body=canvas(pw,ph),g=body.getContext('2d');
      g.scale(DENSITY,DENSITY);g.translate(-frame.x,-frame.y);
      g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';
      g.filter='brightness('+(v.exposure||1)+')';
      g.drawImage(cropped,box.x,box.y,box.width,box.height);
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
      const entry={spec:v,body,mask,live,frame,box,crop,lost:false};
      for(const plane of [body,mask,live])if(plane&&plane.addEventListener)
        plane.addEventListener('contextlost',()=>{entry.lost=true;},{once:true});
      pixelBudget+=cost;entries.set(key,entry);revision++;
    }catch(e){failures.push({view:key,reason:String(e.message||e)});}
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
      ctx.drawImage(e.body,x+f.x,y+f.y,e.body.width/DENSITY,e.body.height/DENSITY);
      if(e.live)ctx.drawImage(e.live,x+f.x,y+f.y,e.live.width/DENSITY,e.live.height/DENSITY);
    }finally{ctx.restore();}
    return true;
  }
  const ready=(async()=>{
    if(typeof document==='undefined'||typeof Image==='undefined'||typeof fetch!=='function')return;
    try{
      // Classic avoids all optional asset traffic and remains independently runnable.
      if(typeof location!=='undefined' && new URLSearchParams(location.search||'').get('textures')==='classic')return;
      const response=await fetch(ROOT+'manifest.json');if(!response.ok)throw Error('manifest unavailable');
      const manifest=await response.json();
      if(!manifest||manifest.version!==1||!manifest.props||typeof manifest.props!=='object')throw Error('invalid manifest');
      const queue=[];
      for(const [id,p]of Object.entries(manifest.props)){
        if(!/^[A-Za-z0-9_]+$/.test(id)||!p||!p.views)continue;
        for(const [view,v]of Object.entries(p.views))if(['s','n','e','w'].includes(view))queue.push([id+':'+view,v]);
      }
      if(queue.length>640)throw Error('too many authored views');
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(next<queue.length){const task=queue[next++];await prepare(...task);}}));
    }catch(e){failures.push({view:'manifest',reason:String(e.message||e)});}
  })();
  return Object.freeze({ready,enabled,draw,revision:()=>revision,
    status:()=>({views:Array.from(entries.keys()),failures:failures.slice(),pixels:pixelBudget}),
    // Pure contracts exposed for deterministic headless geometry validation.
    validate,fit});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=PropRemaster;
