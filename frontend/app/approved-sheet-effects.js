/* Approved-sheet-only effects. Source artwork remains authoritative.
 * prepare(id, bodyImage) is called once after decode; pass its return value as
 * state.prepared to draw. No fetch, readback, old body painter or counters.
 * draw receives an already alpha-fitted WORLD box, plus the source crop in
 * pixels. All authored region coordinates below address the FULL decoded PNG.
 * frameBounds uses that same normalized full-source coordinate system.
 * Native evidence in utility branch snapshot: propsprites.js:1570-1616 coffee
 * clocks, :10501-10530 vent cycle, :7817 dye work, :7888 kiln work,
 * :7307 samplecart work, :11196/:11218 numeric capability-result decay.
 * Pass jukebox's real connection flag as state.live. fired is existing decay
 * amplitude 0..1, not an event timestamp; the module never fabricates a result.
 * Artwork constraints: wax/specimens get bounded source movement, not a new
 * fluid simulation. Translucent steam and plasma keep their approved layout.
 */
'use strict';
const ApprovedSheetEffects = (() => {
  const rect = (x,y,w,h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  const config = {
    fishtank: {kind:'water',region:rect(.14,.32,.73,.40),patches:[rect(.38,.48,.31,.18)],colour:[89,183,188],clock:2600},
    lavalamp: {kind:'wax',region:[[.40,.23],[.62,.23],[.76,.64],[.26,.64]],patches:[[[.40,.24],[.61,.24],[.73,.62],[.28,.62]]],colour:[247,111,55],clock:6820},
    plasmaglobe: {kind:'plasma',region:[[.49,.09],[.76,.16],[.88,.32],[.76,.49],[.49,.55],[.22,.48],[.12,.31],[.23,.15]],patches:[],colour:[184,103,204],clock:190},
    terrarium: {kind:'biology',region:[[.48,.18],[.78,.28],[.86,.53],[.66,.72],[.34,.72],[.17,.52],[.24,.29]],patches:[],colour:[123,163,92],clock:900},
    incubator: {kind:'specimen',region:rect(.33,.31,.32,.35),patches:[rect(.35,.32,.28,.33)],colour:[235,137,49],clock:7000},
    cryopod: {kind:'cold',region:rect(.36,.21,.24,.40),patches:[],colour:[105,176,194],clock:2600},
    coffee: {kind:'coffee',region:rect(.37,.55,.22,.10),patches:[],origin:[.50,.55],colour:[166,152,130],clock:4000},
    steamvent: {kind:'steam',region:[[.36,.03],[.89,.04],[.87,.32],[.61,.58],[.24,.53],[.14,.26]],patches:[],colour:[167,173,166],clock:3400},
    etsy_dyevat: {kind:'dye',region:[[.26,.15],[.69,.15],[.79,.25],[.65,.31],[.29,.30],[.18,.24]],patches:[],colour:[170,90,196],clock:1400,workGain:true},
    etsy_kiln: {kind:'heat',region:[[.37,.44],[.67,.44],[.73,.52],[.70,.65],[.33,.65],[.31,.54]],patches:[],colour:[247,143,42],clock:1000,workGain:true},
    research_samplecart: {kind:'samples',region:rect(.32,.16,.36,.21),patches:[],colour:[111,186,172],clock:760,workGain:true},
    studio: {kind:'screen',region:[[.11,.14],[.40,.08],[.41,.30],[.11,.36]],patches:[],colour:[88,183,192],clock:1800,workGain:true,result:[255,106,213]},
    jukebox: {kind:'audio',region:[[.23,.11],[.49,.03],[.76,.11],[.87,.31],[.77,.36],[.64,.19],[.36,.19],[.23,.36],[.13,.31]],patches:[],colour:[227,151,59],clock:900,result:[255,211,74]}
  };
  const ids=Object.freeze(Object.keys(config));
  const regions=Object.freeze(Object.fromEntries(ids.map(id=>[id,{content:config[id].region,patches:config[id].patches}])));
  const clamp=n=>Math.max(0,Math.min(1,Number(n)||0));
  const frac=n=>n-Math.floor(n);
  function bounds(p) { const xs=p.map(q=>q[0]),ys=p.map(q=>q[1]);return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)}; }
  function path(c,p) { c.beginPath();p.forEach((q,i)=>i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]));c.closePath(); }
  function clip(c,p,fn) { c.save();try{path(c,p);c.clip();fn();}finally{c.restore();} }
  function rgba(rgb,a) { return 'rgba('+rgb.join(',')+','+Math.max(0,Math.min(.25,a))+')'; }
  function ellipse(c,x,y,rx,ry,col) { c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fillStyle=col;c.fill(); }
  function line(c,points,col,width) { c.beginPath();points.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));c.strokeStyle=col;c.lineWidth=width;c.lineCap='round';c.stroke(); }
  function canvas(w,h) {
    if(typeof OffscreenCanvas!=='undefined')return new OffscreenCanvas(w,h);
    if(typeof document==='undefined')return null;
    const c=document.createElement('canvas');c.width=w;c.height=h;return c;
  }
  function prepare(id,bodyImage,meta) {
    if(!config[id]||!bodyImage)return null;
    const w=bodyImage.naturalWidth||bodyImage.width||(meta&&meta.sourceWidth),h=bodyImage.naturalHeight||bodyImage.height||(meta&&meta.sourceHeight);
    if(!(w>0&&h>0))return null;
    // Snapshot at native extracted resolution. The caller owns cache lifetime.
    const c=canvas(w,h);if(!c)return {id,image:bodyImage,width:w,height:h};
    const g=c.getContext('2d');g.drawImage(bodyImage,0,0,w,h);
    return Object.freeze({id,image:c,width:w,height:h});
  }
  function sourcePatch(c,prepared,polygon,dx,dy) {
    if(!prepared||!prepared.image)return false;
    const b=bounds(polygon),pad=.045;
    const x=Math.max(0,b.x-pad),y=Math.max(0,b.y-pad),r=Math.min(1,b.x+b.width+pad),bot=Math.min(1,b.y+b.height+pad);
    clip(c,polygon,()=>c.drawImage(prepared.image,x*prepared.width,y*prepared.height,(r-x)*prepared.width,(bot-y)*prepared.height,x+dx,y+dy,r-x,bot-y));
    return true;
  }
  function glow(c,cfg,a) { clip(c,cfg.region,()=>{c.fillStyle=rgba(cfg.colour,a);c.fillRect(0,0,1,1);}); }
  function emit(c,id,s,cfg,t) {
    const prepared=s.prepared&&s.prepared.id===id?s.prepared:null;
    const w=s.work?1:0,breath=.5+.5*Math.sin(t/cfg.clock);
    if(cfg.kind==='water') {
      // A small opaque water patch translates its existing fish pixels, replacing
      // their old position locally. No new fish and no hand-painted water layer.
      cfg.patches.forEach(p=>sourcePatch(c,prepared,p,.010*Math.sin(t/2600),.003*Math.sin(t/1900)));
      clip(c,cfg.region,()=>{
        for(let i=0;i<3;i++){const q=frac(t/3400+i*.31);ellipse(c,.78+.008*Math.sin(t/900+i),.69-q*.33,.004,.006,rgba(cfg.colour,.17*(1-q)));}
        line(c,[[.18,.37],[.46,.375+.006*Math.sin(t/620)],[.81,.37]],rgba(cfg.colour,.10),.006);
      });
    } else if(cfg.kind==='wax') {
      cfg.patches.forEach(p=>sourcePatch(c,prepared,p,.003*Math.sin(t/3000),.014*Math.sin(t/6820)));
      glow(c,cfg,.013+.012*breath);
    } else if(cfg.kind==='specimen') {
      cfg.patches.forEach(p=>sourcePatch(c,prepared,p,0,.007*Math.sin(t*.0009)));
      clip(c,cfg.region,()=>{for(let i=0;i<4;i++){const q=frac(t/(9200+i*710)+i*.23);ellipse(c,.38+frac(i*.618)*.21,.65-q*.31,.003,.004,rgba(cfg.colour,.16));}});
    } else if(cfg.kind==='steam') {
      // Existing translucent plume stays intact. Overlay-only drawing cannot
      // erase its old alpha safely on a world canvas, so avoid double-stamping.
      const q=frac(t/3400);if(q<.78)clip(c,cfg.region,()=>{
        ellipse(c,.50+.025*Math.sin(t/520),.48-q*.32,.045,.030,rgba(cfg.colour,.045*Math.sin(q/.78*Math.PI)));
      });
    } else if(cfg.kind==='coffee') {
      // Native brewer ambiance is clock-driven. This steam is not a work claim.
      const q=frac(t/2400);clip(c,rect(.32,.37,.36,.24),()=>{
        line(c,[[.50,.55-q*.06],[.49+.01*Math.sin(t/600),.50-q*.06],[.51,.46-q*.06]],rgba(cfg.colour,.10*(1-q)),.011);
      });
      clip(c,cfg.region,()=>ellipse(c,.48,.59,.055,.014,rgba([115,83,49],.035+.015*breath)));
    } else if(cfg.kind==='dye') {
      clip(c,cfg.region,()=>{
        const q=frac(t/4400);c.beginPath();c.ellipse(.48,.235,.06+q*.16,.017+q*.025,0,0,Math.PI*2);c.strokeStyle=rgba(cfg.colour,(.065+.05*w)*(1-q));c.lineWidth=.009;c.stroke();
      });
    } else if(cfg.kind==='plasma') {
      // Illuminate successive existing branches. Preserve the approved electrode,
      // glass and actual arc layout; no geometric replacement of the sphere.
      clip(c,cfg.region,()=>{
        const k=Math.floor(t/190)%4,angle=k*Math.PI/2;
        ellipse(c,.5+Math.cos(angle)*.19,.32+Math.sin(angle)*.14,.07,.05,rgba(cfg.colour,.065));
      });
    } else if(cfg.kind==='samples') {
      clip(c,cfg.region,()=>{for(let i=0;i<3;i++)ellipse(c,.39+i*.08,.27,.017,.05,rgba(cfg.colour,(.025+.035*w)*(.6+.4*Math.sin(t/760+i*1.7))));});
    } else if(cfg.kind==='biology') {
      clip(c,cfg.region,()=>ellipse(c,.55,.52,.06,.03,rgba(cfg.colour,.018+.012*breath)));
    } else if(cfg.kind==='cold') {
      // Fictional painted occupant stays still; no pulse means measured vitals.
      glow(c,cfg,.014+.014*breath);
    } else if(cfg.kind==='heat') {
      glow(c,cfg,.035+.045*breath+.065*w);
    } else if(cfg.kind==='screen') {
      // Broad low-contrast phosphor refresh over existing drawing, no new text.
      clip(c,cfg.region,()=>{c.fillStyle=rgba(cfg.colour,.014+.026*w);c.fillRect(.08,.12+frac(t/4200)*.24,.4,.018);});
    } else if(cfg.kind==='audio') {
      // Connection/actual work gates music ambiance. No unbound playback fiction.
      if(s.live===true||s.work)glow(c,cfg,.015+.025*breath);
    }
    if(cfg.result) {
      const fired=clamp(s.fired);
      if(fired>0)clip(c,cfg.region,()=>{c.fillStyle=rgba(s.bad?[255,92,92]:cfg.result,.20*fired);c.fillRect(0,0,1,1);});
    }
  }
  function draw(ctx,id,box,state) {
    const cfg=config[id];if(!cfg||!ctx||!box)return false;
    const bw=box.width==null?box.w:box.width,bh=box.height==null?box.h:box.height;
    if(![box.x,box.y,bw,bh].every(Number.isFinite)||bw<=0||bh<=0)return false;
    const s=state||{},sw=box.sourceWidth||(s.prepared&&s.prepared.width)||1,sh=box.sourceHeight||(s.prepared&&s.prepared.height)||1;
    const cr=box.crop||{x:0,y:0,width:sw,height:sh},cx=cr.x==null?(cr.left||0):cr.x,cy=cr.y==null?(cr.top||0):cr.y;
    if(!(cr.width>0&&cr.height>0))return false;
    const t=s.still?0:Math.max(0,Number(s.now)||0);
    ctx.save();try{
      ctx.translate(box.x-cx/cr.width*bw,box.y-cy/cr.height*bh);
      ctx.scale(sw/cr.width*bw,sh/cr.height*bh);
      emit(ctx,id,s,cfg,t);
    }finally{ctx.restore();}
    return true;
  }
  function frameBounds(id) { return config[id]?{x:0,y:0,width:1,height:1}:null; }
  return Object.freeze({ids,regions,prepare,draw,frameBounds});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=ApprovedSheetEffects;
