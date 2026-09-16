(function (H) {
  'use strict';
  const ids = ['research_papers', 'etsy_threadrack', 'easel', 'radio'];
  const fallback = {
    research_papers: [[.39,.075],[.646,.115],[.625,.845],[.37,.79]],
    etsy_threadrack: [[.133,.15],[.268,.15],[.268,.333],[.133,.333]],
    easel: [[.105,.21],[.894,.21],[.881,.539],[.113,.539]],
    radio: [[.616,.416],[.928,.416],[.928,.589],[.616,.589]]
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const phase = (now, period) => ((now % period) + period) % period / period;
  const box = p => {
    const xs=p.map(v=>v[0]), ys=p.map(v=>v[1]);
    const x=Math.min(...xs), y=Math.min(...ys);
    return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
  };
  const rect = r => [[r.x,r.y],[r.x+r.width,r.y],[r.x+r.width,r.y+r.height],[r.x,r.y+r.height]];
  const validPoly = p => Array.isArray(p) && p.length >= 3 && p.every(v =>
    Array.isArray(v) && v.length === 2 && v.every(Number.isFinite));
  function region(id, cfg) {
    // The broader measured glass interior includes the baked needle's top tip.
    // The smaller canonical polygon alone would leave that tip visible.
    if (id === 'radio') {
      const effect=cfg.screenEffects && cfg.screenEffects[0];
      const r=effect && effect.exportedImageNormalized && effect.exportedImageNormalized.rect;
      return r && [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>0 && r.height>0 ? rect(r) : fallback.radio;
    }
    const p=cfg.motion && cfg.motion.region;
    return validPoly(p) ? p : fallback[id];
  }
  function line(ctx, points, colour, width) {
    H.line(ctx, points, colour, width);
  }
  function quadPoint(p,u,v) {
    return [(1-v)*((1-u)*p[0][0]+u*p[1][0])+v*((1-u)*p[3][0]+u*p[2][0]),
      (1-v)*((1-u)*p[0][1]+u*p[1][1])+v*((1-u)*p[3][1]+u*p[2][1])];
  }
  function paper(ctx,p,now,state) {
    const b=box(p), worldWidth=Number.isFinite(state.worldPerUnitX) && state.worldPerUnitX>0 ? state.worldPerUnitX : 20;
    // A real one-world-pixel feed stroke, converted after the owner's world fit.
    // Clip to the top-sheet interior so no source page/clip/pencil is duplicated.
    const stroke=Math.min(1/worldWidth,b.width*.24);
    const travel=stroke*(.20+.80*phase(now,2400));
    H.poly(ctx,p,'#b9ad8d');
    const sheet=p.map(v=>[v[0]+travel,v[1]]);
    H.poly(ctx,sheet,'#e0d4b2');
    line(ctx,[quadPoint(sheet,.04,.035),quadPoint(sheet,.96,.035)],'#ede3c8',b.height*.012);
    // Sparse printed blueprint marks move WITH the sheet, not a scanner glow.
    for(let row=0;row<7;row++) {
      const y=.15+row*.095, end=row%3===0?.72:.88;
      line(ctx,[quadPoint(sheet,.12,y),quadPoint(sheet,end,y)],'#788d83',b.height*.005);
    }
    const chart=[quadPoint(sheet,.17,.66),quadPoint(sheet,.17,.91),quadPoint(sheet,.83,.91)];
    line(ctx,chart,'#667e77',b.height*.006);
    line(ctx,[quadPoint(sheet,.22,.85),quadPoint(sheet,.37,.77),quadPoint(sheet,.48,.81),quadPoint(sheet,.64,.71),quadPoint(sheet,.79,.73)],'#778d83',b.height*.008);
    line(ctx,[quadPoint(sheet,.018,.04),quadPoint(sheet,.018,.96)],'#f0e6cc',b.width*.018);
  }
  function thread(ctx,p,now) {
    const b=box(p), step=(Math.floor(now/260)%8+8)%8, pitch=b.height/7;
    H.poly(ctx,p,'#a24736');
    H.poly(ctx,rect({x:b.x,y:b.y,width:b.width*.16,height:b.height}),'#843c30');
    H.poly(ctx,rect({x:b.x+b.width*.80,y:b.y,width:b.width*.20,height:b.height}),'#8d3f31');
    // Winding seams travel around the spool; wooden flanges/endcaps stay baked.
    for(let i=-2;i<10;i++) {
      const y=b.y+(i+step/8)*pitch;
      line(ctx,[[b.x,y],[b.x+b.width,y-pitch*.48]],'#bd6a50',pitch*.21);
      line(ctx,[[b.x,y+pitch*.30],[b.x+b.width,y-pitch*.18]],'#93412f',pitch*.13);
    }
    // A short traveling thread accent follows the actual winding, not a new LED.
    const u=step/8, x=b.x+b.width*(.10+.75*u), y=b.y+b.height*(.60-.23*u);
    line(ctx,[[x,y],[x+b.width*.10,y-b.height*.031]],'#cf8060',pitch*.20);
  }
  function paint(ctx,p,now) {
    const b=box(p), reveal=.08+.92*phase(now,2400), edge=b.y+b.height*reveal;
    ctx.save();
    try {
      // Leave revealed pixels untouched: those are the actual authored Saturn.
      // Only the not-yet-painted portion receives a matte preparatory wash.
      H.clip(ctx,rect({x:b.x,y:edge,width:b.width,height:b.y+b.height-edge}));
      ctx.globalAlpha*=.88;
      H.poly(ctx,p,'#d8cfaf');
      ctx.globalAlpha/=.88;
      const cx=b.x+b.width*.50, cy=b.y+b.height*.51;
      ctx.save();
      ctx.translate(cx,cy);
      ctx.scale(b.width,b.height);
      ctx.strokeStyle='#aaa98c';ctx.lineWidth=.009;
      ctx.beginPath();ctx.ellipse(0,0,.215,.285,0,0,Math.PI*2);ctx.stroke();
      ctx.beginPath();ctx.ellipse(0,0,.475,.115,-.48,0,Math.PI*2);ctx.stroke();
      ctx.beginPath();ctx.ellipse(0,0,.405,.082,-.48,0,Math.PI*2);ctx.stroke();
      ctx.restore();
    } finally { ctx.restore(); }
  }
  function radio(ctx,p,now) {
    const b=box(p), x=u=>b.x+b.width*u, y=v=>b.y+b.height*v;
    // Opaque interior replacement removes the single baked needle first.
    H.poly(ctx,p,'#352f23');
    H.poly(ctx,[[x(0),y(.73)],[x(.66),y(0)],[x(.81),y(0)],[x(.15),y(1)],[x(0),y(1)]],'#3d3729');
    for(const v of [.39,.63])line(ctx,[[x(.035),y(v)],[x(.965),y(v)]],'#bc9959',b.height*.014);
    for(let i=0;i<8;i++) {
      const u=.11+i*.11;
      line(ctx,[[x(u),y(.23)],[x(u),y(.34)]],'#d2b276',b.width*.007);
      line(ctx,[[x(u),y(.70)],[x(u),y(i%2?.82:.86)]],'#bd995d',b.width*.007);
      if(i<7)line(ctx,[[x(u+.04),y(.46)],[x(u+.04),y(.54)]],'#bca172',b.width*.005);
    }
    const step=(Math.floor(now/900)%3+3)%3, needle=.23+step*.225;
    line(ctx,[[x(needle),y(.018)],[x(needle),y(.988)]],'#d49337',b.width*.023);
    line(ctx,[[x(needle-.006),y(.025)],[x(needle-.006),y(.98)]],'#edac51',b.width*.005);
  }
  function draw(ctx,id,state,cfg) {
    if(!ids.includes(id))return false;
    state=state||{};cfg=cfg||{};
    if(id!=='radio' && !state.work)return true;
    const now=state.still ? 0 : (Number.isFinite(state.now)?state.now:0);
    const p=region(id,cfg);
    ctx.save();
    try {
      H.clip(ctx,p);
      if(id==='research_papers')paper(ctx,p,now,state);
      else if(id==='etsy_threadrack')thread(ctx,p,now);
      else if(id==='easel')paint(ctx,p,now);
      else radio(ctx,p,now);
    } finally { ctx.restore(); }
    return true;
  }
  // Conservative bounds for this committed art; no effect touches another prop.
  function frameBounds(id) { return fallback[id] ? box(fallback[id]) : null; }
  return {ids,draw,frameBounds};
})
