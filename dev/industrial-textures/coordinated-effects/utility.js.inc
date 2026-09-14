(function (H) {
  'use strict';
  // All geometry uses the full exported image, never alpha-cropped coordinates.
  const ids = ['fishtank', 'lavalamp', 'plasmaglobe', 'terrarium', 'incubator', 'etsy_kiln', 'research_samplecart'];
  const TAU = Math.PI * 2;
  function path(c, p) { c.beginPath(); p.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); }
  function poly(c, p, colour) { path(c, p); c.fillStyle = colour; c.fill(); }
  function ellipse(c, x, y, rx, ry, colour) { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU); c.fillStyle = colour; c.fill(); }
  function line(c, p, colour, width) { c.beginPath(); p.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.strokeStyle = colour; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(); }
  function rect(x, y, w, h) { return [[x,y],[x+w,y],[x+w,y+h],[x,y+h]]; }
  function inside(c, p, fn) { c.save(); try { path(c, p); c.clip(); fn(); } finally { c.restore(); } }
  function effect(cfg, name) { return (cfg.motionEffects || []).find(e => e.mechanism === name); }
  function region(cfg, name, fallback) { const e = effect(cfg, name); return e ? e.region : fallback; }
  function fract(x) { return x - Math.floor(x); }
  function leaf(c, x, y, dx, dy, width, colour) {
    c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x+dx*.2-width, y+dy*.55, x+dx, y+dy);
    c.quadraticCurveTo(x+dx*.6+width, y+dy*.55, x, y); c.fillStyle=colour; c.fill();
  }
  function fish(c, x, y, east, t, scale, colour) {
    c.save(); c.translate(x,y); c.scale(east ? scale : -scale,scale);
    const tail = .010 + .004*Math.sin(t/170);
    poly(c,[[-.027,0],[-.046,-tail],[-.046,tail]],colour);
    ellipse(c,0,0,.031,.013,colour);
    poly(c,[[-.014,-.008],[.009,-.021],[.017,-.007]],'#cfb467');
    ellipse(c,.005,-.004,.020,.004,'rgba(245,234,175,.42)');
    ellipse(c,.020,-.002,.0026,.0028,'#142d34'); c.restore();
  }
  function aquarium(c,t,state,cfg) {
    // Opaque confined underpainting replaces all three baked fish and interior plants.
    // Hood, glass rim, side reflections, gravel lip and cabinet are outside this clip.
    const water=[[.156,.279],[.843,.279],[.844,.599],[.158,.608]];
    inside(c,water,()=>{
      poly(c,water,'#17667b');
      poly(c,[[.157,.279],[.843,.279],[.843,.36],[.157,.42]],'#237c8a');
      poly(c,[[.157,.47],[.843,.39],[.843,.61],[.157,.61]],'#185363');
      for(let j=0;j<8;j++) {
        const x=.19+j*.086, sway=.010*Math.sin(t/1100+j*.7);
        const top=.32+.08*(j%3)/2;
        line(c,[[x,.604],[x+sway*.4,.48],[x+sway,top]],'#3b7150',.004);
        for(let k=0;k<4;k++) {
          const y=.575-k*.045;
          leaf(c,x+sway*.3,y,(k%2?1:-1)*(.026+.006*(j%2))+sway,-.050,.006,k%2?'#75a349':'#498347');
        }
      }
      // Designed submerged branch and pebble bed, always behind fish.
      line(c,[[.30,.602],[.45,.54],[.59,.58],[.70,.602]],'#655237',.019);
      line(c,[[.43,.55],[.37,.47]],'#7d6742',.008);
      for(let j=0;j<24;j++) ellipse(c,.17+j*.029,.599+.003*Math.sin(j),.012,.006,j%3===0?'#859282':j%2?'#5e7771':'#3e655f');
      const specs=[[2600,0,.39,.92,'#c4dee0'],[3400,.7,.445,.8,'#ed953d'],[4200,1.4,.514,.76,'#ec8b36']];
      specs.forEach((s,i)=>{ const q=(t/s[0]+s[1])%2, east=q<1, u=east?q:2-q; fish(c,.285+u*.43,s[2]+.008*Math.sin(t/1900+i),east,t+i*123,s[3],s[4]); });
      for(let j=0;j<4;j++) {
        const u=fract(t/3600+j*.247),x=.778+.005*Math.sin(t/900+j),y=.576-u*.275;
        c.beginPath();c.ellipse(x,y,.0034,.0044,0,0,TAU);c.strokeStyle='rgba(184,229,225,.62)';c.lineWidth=.0015;c.stroke();
      }
      // Few broad glass/water strokes, not a screen scan.
      line(c,[[.17,.291],[.39,.293+.003*Math.sin(t/620)],[.64,.289],[.824,.292]],'rgba(184,230,214,.38)',.003);
      line(c,[[.185,.309],[.181,.396]],'rgba(195,228,213,.13)',.008);
    });
  }
  function lava(c,t,state,cfg) {
    const glass=region(cfg,'wax-rise-and-merge',[[.39,.164],[.61,.164],[.76,.66],[.69,.711],[.30,.711],[.22,.66]]);
    inside(c,glass,()=>{
      poly(c,glass,'#41133f');
      poly(c,[[.38,.164],[.48,.164],[.41,.71],[.25,.69]],'#572149');
      poly(c,[[.59,.164],[.63,.34],[.745,.68],[.66,.71],[.56,.35]],'#2d143c');
      ellipse(c,.493,.693,.203,.023,'#ef6f23');
      ellipse(c,.493,.686,.168,.014,'#ffb840');
      [6820,10340].forEach((period,i)=>{
        const u=fract(t/period+i*.47),y=.684-u*.47;
        const x=.5+(.047+.022*Math.sin(u*TAU))*Math.sin(u*4+i*2.5);
        const rx=.064+.019*Math.sin(u*Math.PI),ry=.021+.015*Math.sin(u*Math.PI);
        // Organic rising wax silhouette with broad painted highlight planes.
        c.beginPath();c.moveTo(x,y-ry);
        c.bezierCurveTo(x+rx*1.25,y-ry*.7,x+rx*.8,y+ry*.9,x+rx*.23,y+ry*1.35);
        c.bezierCurveTo(x-rx*.7,y+ry*1.1,x-rx*1.1,y-ry*.6,x,y-ry);
        c.fillStyle=i?'#f67b26':'#ee5722';c.fill();
        ellipse(c,x-rx*.2,y-ry*.2,rx*.56,ry*.55,'#ffa937');
        ellipse(c,x-rx*.38,y-ry*.45,rx*.21,ry*.18,'#ffd065');
      });
      line(c,[[.393,.182],[.326,.40],[.268,.612]],'rgba(226,162,201,.30)',.009);
      line(c,[[.603,.19],[.667,.405],[.727,.635]],'rgba(183,91,171,.22)',.006);
    });
  }
  function plasma(c,t,state,cfg) {
    const e=effect(cfg,'electrode-arcs'),sphere=e?e.region:[[.49,.027],[.93,.26],[.49,.477],[.06,.22]];
    const o=e?e.origin:[.496,.274],ends=e&&e.parameters.endpointRegions||[[.25,.12],[.805,.21],[.22,.35],[.78,.365]];
    inside(c,sphere,()=>{
      poly(c,sphere,'#371644');
      ellipse(c,.492,.255,.37,.20,'#49205c');ellipse(c,.492,.255,.28,.16,'#391847');
      for(let i=0;i<2;i++) {
        const step=Math.floor(t/(i?190:130)),end=ends[(step+i*2)%ends.length];
        const bend=.028*Math.sin(step*1.7+i),mid=[(o[0]+end[0])*.5+bend,(o[1]+end[1])*.5-.016];
        c.beginPath();c.moveTo(o[0],o[1]);c.quadraticCurveTo(mid[0],mid[1],end[0],end[1]);
        c.strokeStyle='#9c48af';c.lineWidth=.010;c.stroke();c.strokeStyle='#ea9fe8';c.lineWidth=.003;c.stroke();
        line(c,[[mid[0],mid[1]],[mid[0]+bend*.5,mid[1]-.025],[end[0]+.03*Math.sin(step),end[1]-.022]],'#b969c8',.002);
      }
      line(c,[[.496,.44],[.496,.29]],'#332b38',.019);
      line(c,[[.487,.43],[.487,.29]],'#b39eaf',.004);
      ellipse(c,o[0],o[1],.046,.025,'#251830');ellipse(c,o[0]-.009,o[1]-.006,.027,.013,'#895390');
      ellipse(c,o[0]-.015,o[1]-.01,.010,.005,'#d5a2d3');
      line(c,[[.16,.20],[.20,.15],[.28,.11]],'rgba(230,198,230,.45)',.018);
      line(c,[[.73,.10],[.82,.16],[.87,.24]],'rgba(166,118,187,.35)',.009);
    });
  }
  function terrarium(c,t,state,cfg) {
    const e=effect(cfg,'single-spore-rise');if(!e)return;
    inside(c,e.region,()=>{
      const q=fract(t/5600),x=.49+.014*Math.sin(t/1300),y=.65-q*.31;
      ellipse(c,x,y,.0028,.0019,'rgba(183,210,123,.55)');
      // Small mushroom-colony light, never a sensor/status lamp.
      ellipse(c,.621,.535,.014,.006,'rgba(186,187,91,'+(.018+.015*Math.sin(t/900))+')');
    });
  }
  function incubator(c,t,state,cfg) {
    const water=[[.343,.29],[.625,.29],[.625,.612],[.343,.612]];
    inside(c,water,()=>{
      poly(c,water,'#128541');poly(c,[[.343,.29],[.399,.29],[.413,.612],[.343,.612]],'#2ca34c');
      poly(c,[[.568,.29],[.625,.29],[.625,.612],[.572,.612]],'#096435');
      const bob=.005*Math.sin(t*.0009);
      c.save();c.translate(0,bob);
      // Curled suspended organic specimen and tendrils, clearly not a telemetry panel.
      c.beginPath();c.moveTo(.463,.385);c.bezierCurveTo(.526,.367,.574,.414,.56,.473);
      c.bezierCurveTo(.559,.520,.497,.551,.435,.531);c.bezierCurveTo(.485,.522,.523,.49,.50,.463);
      c.bezierCurveTo(.46,.448,.418,.444,.429,.411);c.bezierCurveTo(.431,.397,.444,.389,.463,.385);c.fillStyle='#153f2c';c.fill();
      c.beginPath();c.moveTo(.469,.39);c.bezierCurveTo(.518,.381,.548,.42,.536,.452);c.bezierCurveTo(.52,.419,.472,.422,.451,.406);c.closePath();c.fillStyle='#366747';c.fill();
      for(let i=0;i<4;i++) {
        line(c,[[.461+i*.019,.443+i*.011],[.44+i*.009,.48+i*.013],[.422+i*.01,.501+i*.014]],i%2?'#47784f':'#1c4e32',.0035);
      }
      for(let i=0;i<3;i++) {
        c.beginPath();c.moveTo(.452+i*.026,.409);c.bezierCurveTo(.39+i*.04,.377,.466-i*.02,.34,.411+i*.055,.297);
        c.strokeStyle='#255d36';c.lineWidth=.0025;c.stroke();
      }
      c.beginPath();c.moveTo(.464,.526);c.bezierCurveTo(.427,.559,.50,.56,.462,.601);c.strokeStyle='#224c32';c.lineWidth=.003;c.stroke();c.restore();
      for(let i=0;i<9;i++) {
        const u=fract(t/(9200+i*730)+i*.173),x=.366+fract(i*.618)*.229,y=.603-u*.301;
        ellipse(c,x,y,.0016+(i%2)*.0005,.0011,'rgba(188,225,141,.65)');
      }
      line(c,[[.352,.306],[.356,.584]],'rgba(169,223,144,.18)',.007);
    });
    const e=effect(cfg,'pedestal-indicator-cycle');if(e)inside(c,e.region,()=>{
      for(let i=0;i<3;i++) poly(c,rect(.473,.775+i*.011,.044,.004),Math.floor(t/700)%3===i?'#e4a54d':'#8b672e');
    });
  }
  function kiln(c,t,state,cfg) {
    const breathe=.5+.5*Math.sin(t/1000),gain=state.work?.14:.055;
    ['flue-heat','door-seam-heat'].forEach(name=>{
      const e=effect(cfg,name);if(e)inside(c,e.region,()=>poly(c,e.region,'rgba(255,160,46,'+(gain+.045*breathe)+')'));
    });
    const screens=cfg.screenEffects||[];
    screens.forEach(s=>inside(c,s.polygon,()=>{
      poly(c,s.polygon,'#242c2c');
      for(let i=0;i<3;i++)poly(c,rect(.845+i*.017,.503,.010,.012),breathe>i/3.2?'#ce963b':'#5e5236');
    }));
    const e=effect(cfg,'hot-air-shimmer');if(e)inside(c,e.region,()=>{
      const phase=fract(t/1700);line(c,[[.484,.183-phase*.018],[.487+.003*Math.sin(t/420),.174-phase*.018],[.486,.163-phase*.018]],'rgba(220,186,138,'+((1-phase)*.08)+')',.002);
    });
  }
  function cart(c,t,state,cfg) {
    (cfg.motionEffects||[]).forEach((e,i)=>{
      const x=e.origin[0],y=e.origin[1],alpha=(state.work?.055:.024)*(.6+.4*Math.sin(t/760+i*1.7));
      // Narrow fluid edge glints preserve mineral/coral/leaf specimens and jar planes.
      inside(c,e.region,()=>{
        const rgb=['218,173,74','105,195,205','157,187,97'][i%3];
        line(c,[[x-.035,y+.042],[x-.035,y-.018],[x-.030,y-.031]],'rgba('+rgb+','+alpha*2+')',.006);
        ellipse(c,x,y+.043,.026,.004,'rgba('+rgb+','+alpha+')');
      });
    });
  }
  const render={fishtank:aquarium,lavalamp:lava,plasmaglobe:plasma,terrarium,incubator,etsy_kiln:kiln,research_samplecart:cart};
  function draw(ctx,id,state,cfg) {
    if(!render[id])return false;
    state=state||{};cfg=cfg||{};
    const t=state.still?0:Math.max(0,Number(state.now)||0);
    ctx.save();
    try { render[id](ctx,t,state,cfg); } finally { ctx.restore(); }
    return true;
  }
  function frameBounds(id) { return ids.indexOf(id)>=0?{x:0,y:0,width:1,height:1}:null; }
  return {ids,draw,frameBounds};
})
