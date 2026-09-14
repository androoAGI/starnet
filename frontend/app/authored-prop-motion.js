/* New mechanical layers for authored prop bodies. The caller owns artwork loading,
   fitted body bounds, facing transforms, and truthful per-instance activity.
   Coordinates refer to the COMPLETE exported PNG, before the alpha crop. */
'use strict';
const AuthoredPropMotion = (() => {
  const entries = new Map();
  let resolveLayer = null;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const point = p => Array.isArray(p) && p.length === 2 && p.every(n => finite(n) && n >= 0 && n <= 1);
  const positive = n => finite(n) && n > 0 && n <= 1;
  const polygon = p => Array.isArray(p) && p.length >= 3 && p.length <= 20 && p.every(point);
  const key = s => typeof s === 'string' && /^[A-Za-z0-9_]+(?::[snew])?$/.test(s);
  const colour = s => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
  const defaults = Object.freeze({dark:'#14191a', edge:'#353d3c', metal:'#666c64', light:'#a4a598', accent:'#917446'});
  function valid(c) {
    if (!c || !['gantry','tube','arm'].includes(c.kind) ||
        ![c.sourceWidth,c.sourceHeight].every(n => Number.isInteger(n) && n > 0 && n <= 4096) ||
        !polygon(c.clip) || !finite(c.period) || c.period < 300 || c.period > 60000 ||
        c.palette != null && (typeof c.palette !== 'object' || Object.keys(c.palette).some(k => !(k in defaults) || !colour(c.palette[k])))) return false;
    if (c.kind === 'gantry' || c.kind === 'tube') return point(c.from) && point(c.to) &&
      Array.isArray(c.size) && c.size.length === 2 && c.size.every(positive) &&
      (c.kind !== 'gantry' || typeof c.layer === 'string' && /^[A-Za-z0-9_-]+$/.test(c.layer));
    return point(c.shoulder) && point(c.rest) && point(c.pickup) && point(c.place) &&
      [c.upper,c.fore,c.thickness,c.joint,c.tool].every(positive) &&
      c.thickness < Math.min(c.upper,c.fore) && c.joint < Math.min(c.upper,c.fore) &&
      (c.bend === 1 || c.bend === -1);
  }
  function setup(options = {}) {
    if (options.resolveLayer != null && typeof options.resolveLayer !== 'function') return false;
    resolveLayer = options.resolveLayer || null;
    return true;
  }
  function register(id, config, layers = {}) {
    if (!key(id) || !valid(config) || (!entries.has(id) && entries.size >= 64) || !layers || typeof layers !== 'object') return false;
    // Configuration is data, not a retained mutable pointer into a manifest.
    entries.set(id, {config:JSON.parse(JSON.stringify(config)), layers:{...layers}});
    return true;
  }
  function unregister(id) { return entries.delete(id); }
  function layerOf(id, entry, name) {
    let image = entry.layers[name];
    if (!image && resolveLayer) {
      try { image = resolveLayer(id, name); } catch (_) { return null; }
    }
    if (!image || image.complete === false) return null;
    const w = image.naturalWidth || image.width, h = image.naturalHeight || image.height;
    return finite(w) && finite(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096 ? image : null;
  }
  function ready(id) {
    const e = entries.get(id);
    return !!e && (e.config.kind !== 'gantry' || !!layerOf(id,e,e.config.layer));
  }
  function space(c, box) {
    if (!box || ![box.x,box.y,box.width,box.height].every(finite) || box.width <= 0 || box.height <= 0) return null;
    const crop = box.crop || {x:0,y:0,width:c.sourceWidth,height:c.sourceHeight};
    if (![crop.x,crop.y,crop.width,crop.height].every(finite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
        crop.x+crop.width > c.sourceWidth || crop.y+crop.height > c.sourceHeight) return null;
    const sx = box.width/crop.width, sy = box.height/crop.height;
    // The body and moving mechanism must share one scale. A malformed custom box
    // is not permission to squash a carriage or change linkage lengths.
    if (Math.abs(sx-sy) > Math.max(sx,sy)*1e-5) return null;
    return {scale:sx,x:box.x-crop.x*sx,y:box.y-crop.y*sx};
  }
  const mix = (a,b,t) => a+(b-a)*t;
  const smooth = t => t*t*(3-2*t);
  const lerp = (a,b,t) => [mix(a[0],b[0],t),mix(a[1],b[1],t)];
  const pixel = (c,p) => [p[0]*c.sourceWidth,p[1]*c.sourceHeight];
  function phase(c, state) {
    if (!state || state.work !== true || state.still || state.reducedMotion) return 0;
    const now = finite(state.now) ? Math.max(0,state.now) : 0;
    return (now % c.period)/c.period;
  }
  function linkage(c, target) {
    const a = pixel(c,c.shoulder), desired = pixel(c,target), u = c.upper*c.sourceWidth, f = c.fore*c.sourceWidth;
    const dx = desired[0]-a[0], dy = desired[1]-a[1], distance = Math.hypot(dx,dy);
    const reach = Math.max(Math.abs(u-f)+.0001, Math.min(u+f-.0001,distance));
    const angle = distance > .0001 ? Math.atan2(dy,dx) : Math.PI/2;
    const offset = Math.acos(Math.max(-1,Math.min(1,(u*u+reach*reach-f*f)/(2*u*reach))))*c.bend;
    return {shoulder:a,elbow:[a[0]+Math.cos(angle+offset)*u,a[1]+Math.sin(angle+offset)*u],
      wrist:[a[0]+Math.cos(angle)*reach,a[1]+Math.sin(angle)*reach]};
  }
  function pose(c,state) {
    const p = phase(c,state), active = !!state && state.work === true && !state.still && !state.reducedMotion;
    if (c.kind === 'gantry') return {kind:c.kind,center:pixel(c,lerp(c.from,c.to,(1-Math.cos(p*Math.PI*2))/2)),active};
    if (c.kind === 'tube') return {kind:c.kind,center:pixel(c,lerp(c.from,c.to,active ? p : 0)),active};
    // Four eased movements form a mechanical pick/place cycle. This is a pose,
    // never a progress value, completion count, or invented transported object.
    const stops = [c.rest,c.pickup,c.place,c.rest,c.rest], leg = Math.min(3,Math.floor(p*4));
    const target = lerp(stops[leg],stops[leg+1],smooth(p*4-leg));
    return {kind:c.kind,...linkage(c,target),open:active ? (leg === 1 ? .22 : .75) : .75,active};
  }
  function sample(id,box,state) {
    const e = entries.get(id), s = e && space(e.config,box);
    if (!s) return null;
    const result = pose(e.config,state);
    for (const k of ['center','shoulder','elbow','wrist']) if (result[k]) result[k] = [s.x+result[k][0]*s.scale,s.y+result[k][1]*s.scale];
    return result;
  }
  function path(ctx, points) {
    ctx.beginPath();points.forEach((p,i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p));ctx.closePath();
  }
  function disc(ctx,p,r,fill) { ctx.fillStyle=fill;ctx.beginPath();ctx.arc(p[0],p[1],r,0,Math.PI*2);ctx.fill(); }
  function segment(ctx,a,b,width,pal) {
    const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy),nx=-dy/len,ny=dx/len;
    const corners = (half,shift=0) => [[a[0]+nx*half,a[1]+ny*half+shift],[b[0]+nx*half,b[1]+ny*half+shift],
      [b[0]-nx*half,b[1]-ny*half+shift],[a[0]-nx*half,a[1]-ny*half+shift]];
    ctx.fillStyle=pal.dark;path(ctx,corners(width*.62,width*.18));ctx.fill();
    ctx.fillStyle=pal.edge;path(ctx,corners(width*.5));ctx.fill();
    ctx.fillStyle=pal.metal;path(ctx,corners(width*.29));ctx.fill();
    ctx.strokeStyle=pal.light;ctx.lineWidth=width*.07;ctx.beginPath();
    ctx.moveTo(a[0]+nx*width*.3,a[1]+ny*width*.3);ctx.lineTo(b[0]+nx*width*.3,b[1]+ny*width*.3);ctx.stroke();
  }
  function capsule(ctx,c,p,pal) {
    const w=c.size[0]*c.sourceWidth,h=c.size[1]*c.sourceHeight,x=p.center[0]-w/2,y=p.center[1]-h/2;
    ctx.fillStyle=pal.dark;ctx.fillRect(x,y,w,h);
    ctx.fillStyle=pal.metal;ctx.fillRect(x+w*.11,y+h*.15,w*.78,h*.7);
    ctx.fillStyle=pal.edge;ctx.fillRect(x+w*.06,y,w*.14,h);ctx.fillRect(x+w*.8,y,w*.14,h);
    ctx.fillStyle=pal.light;ctx.fillRect(x+w*.23,y+h*.16,w*.5,h*.1);
    ctx.fillStyle=pal.accent;ctx.fillRect(x+w*.47,y+h*.18,w*.055,h*.64);
  }
  function arm(ctx,c,p,pal) {
    const w=c.sourceWidth,t=c.thickness*w,r=c.joint*w;
    segment(ctx,p.shoulder,p.elbow,t,pal);segment(ctx,p.elbow,p.wrist,t*.82,pal);
    for (const [i,j] of [p.shoulder,p.elbow,p.wrist].entries()) {
      disc(ctx,j,r*(i===2?.7:1),pal.dark);disc(ctx,j,r*(i===2?.52:.77),pal.metal);
      disc(ctx,j,r*(i===2?.22:.38),pal.edge);
      ctx.fillStyle=pal.light;ctx.fillRect(j[0]-r*.1,j[1]-r*.48,r*.2,r*.14);
    }
    const tool=c.tool*w,spread=tool*(.25+p.open*.28),x=p.wrist[0],y=p.wrist[1]+r*.6;
    segment(ctx,[x-spread,y],[x-spread,y+tool*.55],t*.35,pal);
    segment(ctx,[x+spread,y],[x+spread,y+tool*.55],t*.35,pal);
    segment(ctx,[x-spread,y+tool*.55],[x-spread*.48,y+tool*.67],t*.3,pal);
    segment(ctx,[x+spread,y+tool*.55],[x+spread*.48,y+tool*.67],t*.3,pal);
    ctx.fillStyle=pal.edge;ctx.fillRect(x-spread-t*.2,y-t*.25,spread*2+t*.4,t*.5);
  }
  function draw(ctx,id,box,state) {
    const e=entries.get(id),c=e&&e.config,s=c&&space(c,box);
    if (!s || !ctx || typeof ctx.save !== 'function' || typeof ctx.isContextLost === 'function' && ctx.isContextLost()) return false;
    const image=c.kind==='gantry' ? layerOf(id,e,c.layer) : null;
    if (c.kind==='gantry' && !image) return false;
    const p=pose(c,state),pal={...defaults,...c.palette};
    ctx.save();
    try {
      ctx.translate(s.x,s.y);ctx.scale(s.scale,s.scale);ctx.globalCompositeOperation='source-over';
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
      path(ctx,c.clip.map(q => pixel(c,q)));ctx.clip();
      if (c.kind==='gantry') {
        const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;
        const fit=Math.min(c.size[0]*c.sourceWidth/iw,c.size[1]*c.sourceHeight/ih);
        ctx.drawImage(image,p.center[0]-iw*fit/2,p.center[1]-ih*fit/2,iw*fit,ih*fit);
      } else if(c.kind==='tube') capsule(ctx,c,p,pal);
      else arm(ctx,c,p,pal);
    } catch (_) { return false; }
    finally { ctx.restore(); }
    return true;
  }
  return Object.freeze({setup,register,unregister,ready,draw,sample,validate:valid});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredPropMotion;
