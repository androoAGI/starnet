/* Fresh content for the batch03 painted bodies. No source bitmap or legacy
   painter is sampled. Counts are projections supplied by PropSprites/world;
   missing facts remain empty. Coordinates are measured against the NEW source.
   draw(ctx,id,box,state): box is the fitted exported image in world coordinates.
   Optional box.crop is its measured alpha crop in exported-image pixels. */
'use strict';
const AuthoredPropContent = (() => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const count = n => finite(n) && n >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n)) : 0;
  const specs = {
    missionboard: { width:1610,height:965,left:0,top:0,
      panels:[[190,325,360,230],[650,325,333,230],[1080,325,320,230]],
      header:[208,84,1188,65] },
    trophycase: { width:1150,height:1367,left:0,top:0,
      shelves:[[250,330,620,134],[250,610,620,110],[250,860,620,110]],
      crown:[235,45,620,98], plaque:[285,1205,550,45] },
    comms_inbox: { width:1536,height:1020,left:0,top:0,
      trays:[[211,101,974,174],[217,450,1008,65],[225,684,1020,49]] },
    calwall: { width:2167,height:619,left:1,top:54,
      headers:Array.from({length:7},(_,i)=>[112+i*282,144,240,37]),
      paper:[108,190,1950,245] },
    arc_microfiche: { width:1394,height:1128,left:0,top:0,
      screen:[420,346,550,274] }
  };
  function freeze(o) { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); }
  // Every rectangle is normalized to the exported, alpha-extracted PNG. The
  // calendar's nonzero exporter crop is subtracted here, exactly once.
  const regions = {};
  for (const [id,s] of Object.entries(specs)) {
    const rect = r => ({x:(r[0]-s.left)/s.width,y:(r[1]-s.top)/s.height,width:r[2]/s.width,height:r[3]/s.height});
    regions[id]={sourceWidth:s.width,sourceHeight:s.height};
    for(const [key,value]of Object.entries(s)) if(Array.isArray(value)) regions[id][key]=Array.isArray(value[0])?value.map(rect):rect(value);
  }
  freeze(regions);
  const poly = (g,points,colour) => { g.fillStyle=colour;g.beginPath();points.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.closePath();g.fill(); };
  const rect = (g,x,y,w,h,colour) => {g.fillStyle=colour;g.fillRect(x,y,w,h);};
  function line(g,points,colour,width=3) {g.strokeStyle=colour;g.lineWidth=width;g.beginPath();points.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));g.stroke();}
  function clip(g,r,paint) {g.save();try{g.beginPath();g.rect(...r);g.clip();paint();}finally{g.restore();}}
  function lettering(g,value,x,y,size,colour,width,align='left') {
    g.font=size+"px 'VT323','Courier New',monospace";g.textAlign=align;g.textBaseline='middle';
    g.fillStyle=colour;g.shadowColor=colour;g.shadowBlur=size*.025;g.fillText(String(value),x,y,width);g.shadowBlur=0;
  }
  // Angular surface patches and uneven edges echo the brush facets in the body.
  // They are stable across time and never imply document contents or progress.
  function paper(g,x,y,w,h,kind,index) {
    const amber=kind==='proposal'||kind==='jam',c=amber?['#bb873e','#e2b66a','#f2ce89','#896237']:['#9b9e82','#c9ccb0','#e3dfbf','#74775f'];
    poly(g,[[x+5,y+6],[x+w+5,y+8],[x+w+2,y+h+7],[x+3,y+h+3]],'rgba(7,10,8,.46)');
    poly(g,[[x+2,y],[x+w-11,y+1],[x+w,y+12],[x+w-2,y+h],[x,y+h-3]],c[0]);
    poly(g,[[x+4,y+4],[x+w-14,y+4],[x+w-4,y+14],[x+w-6,y+h-7],[x+4,y+h-7]],c[1]);
    poly(g,[[x+4,y+4],[x+w-14,y+4],[x+w-24,y+12],[x+9,y+10]],c[2]);
    poly(g,[[x+w-13,y+2],[x+w-2,y+12],[x+w-13,y+14]],c[3]);
    for(let n=0;n<5;n++) {
      const px=x+9+((n*31+index*17)%Math.max(10,Math.floor(w-28))),py=y+19+((n*19+index*11)%Math.max(8,Math.floor(h-33)));
      poly(g,[[px,py],[px+13,py-2],[px+8,py+3],[px-3,py+4]],n%2?'rgba(248,231,188,.12)':'rgba(54,58,45,.08)');
    }
    // A stamped class glyph, not a fabricated quest title or message body.
    if(kind==='jam') lettering(g,'!',x+w*.5,y+h*.54,h*.6,'#5b2e1c',w*.7,'center');
    else if(kind==='proposal') line(g,[[x+w*.32,y+h*.56],[x+w*.5,y+h*.38],[x+w*.68,y+h*.56],[x+w*.5,y+h*.74],[x+w*.32,y+h*.56]],'#886432',4);
    else if(kind==='message') {
      line(g,[[x+w*.2,y+h*.35],[x+w*.5,y+h*.62],[x+w*.8,y+h*.35]],'#787b66',3);
      line(g,[[x+w*.2,y+h*.72],[x+w*.4,y+h*.54]],'#92967b',2);
    } else {
      rect(g,x+w*.24,y+h*.3,w*.46,4,'#929b7c');rect(g,x+w*.24,y+h*.42,w*.32,3,'#a2a88a');
    }
    if(kind!=='message') {
      const px=x+w*.5,py=y+4;
      poly(g,[[px-6,py],[px-2,py-5],[px+5,py-3],[px+7,py+3],[px+1,py+7],[px-5,py+5]],kind==='jam'?'#a0482c':'#a98840');
      rect(g,px-3,py-2,5,3,kind==='jam'?'#f08a5a':'#f2cf79');
    }
  }
  function cardRail(g,panel,n,kind,capacity=3) {
    const shown=Math.min(n,capacity),gap=12,w=Math.min(88,(panel[2]-(capacity+1)*gap)/capacity),h=Math.min(132,panel[3]-72);
    for(let i=0;i<shown;i++) paper(g,panel[0]+gap+i*(w+gap),panel[1]+43+(i%2)*6,w,h,kind,i);
    if(n>shown) lettering(g,'+'+(n-shown),panel[0]+panel[2]-9,panel[1]+panel[3]-17,35,'#d8c49c',panel[2]-18,'right');
  }
  function mission(g,s,time) {
    const p=specs.missionboard.panels,n=count(s.pins),np=count(s.proposals);
    // Total remains exact when physical cards reach their capacity.
    lettering(g,'OPEN '+n,236,117,56,n?'#d1e3b3':'#6d6b47',470);
    if(np) lettering(g,'PROPOSED '+np,724,117,45,'#e4c77d',470);
    if(s.hot===true) {
      const a=s.still?.18:.16+.07*(.5+.5*Math.sin(time/850));
      rect(g,1329,98,30,30,'rgba(239,208,105,'+a+')');
      poly(g,[[1336,106],[1352,106],[1352,121],[1336,121]],'#e0be65');
    }
    clip(g,p[0],()=>{lettering(g,'QUESTS',p[0][0]+12,p[0][1]+19,29,'#939b84',220);cardRail(g,p[0],n,'quest');});
    clip(g,p[1],()=>{if(np){lettering(g,'PROPOSALS',p[1][0]+12,p[1][1]+19,29,'#c2a76a',260);cardRail(g,p[1],np,'proposal');}});
    clip(g,p[2],()=>{
      if(s.jam===true) {paper(g,1114,358,99,147,'jam',0);lettering(g,'JAM',1240,427,45,'#dfa469',140);}
      else if(s.hot===true) {poly(g,[[1177,398],[1204,360],[1231,398],[1204,436]],'#b49749');lettering(g,'GAP',1260,420,36,'#d4bb78',117);}
    });
  }
  function cup(g,x,y,w,h,index) {
    // Two cast rim profiles share the same earned-trophy meaning.
    poly(g,[[x+3,y+h+3],[x+w*.85,y+h+3],[x+w,y+h+8],[x+w*.05,y+h+8]],'rgba(8,5,5,.45)');
    poly(g,[[x+w*.27,y+h*.76],[x+w*.73,y+h*.76],[x+w*.83,y+h*.93],[x+w*.78,y+h],[x+w*.2,y+h],[x+w*.16,y+h*.91]],'#815227');
    poly(g,[[x+w*.3,y+h*.77],[x+w*.69,y+h*.77],[x+w*.76,y+h*.91],[x+w*.23,y+h*.91]],'#c29443');
    rect(g,x+w*.43,y+h*.38,w*.12,h*.43,'#b88c3d');
    rect(g,x+w*.44,y+h*.43,w*.035,h*.33,'#eac978');
    const top=y+(index%2?6:0);
    line(g,[[x+w*.2,top+9],[x+w*.08,top+10],[x+w*.1,y+h*.31],[x+w*.3,y+h*.38]],'#ba8f46',w*.055);
    line(g,[[x+w*.78,top+9],[x+w*.92,top+10],[x+w*.88,y+h*.3],[x+w*.67,y+h*.38]],'#80572b',w*.055);
    poly(g,[[x+w*.2,top],[x+w*.8,top],[x+w*.73,y+h*.32],[x+w*.56,y+h*.5],[x+w*.4,y+h*.48],[x+w*.26,y+h*.31]],'#b5893a');
    poly(g,[[x+w*.22,top+3],[x+w*.47,top+3],[x+w*.42,y+h*.41],[x+w*.29,y+h*.29]],'#ebcb7c');
    poly(g,[[x+w*.51,top+4],[x+w*.77,top+4],[x+w*.68,y+h*.32],[x+w*.53,y+h*.44]],'#93632a');
    line(g,[[x+w*.2,top+1],[x+w*.55,top+2],[x+w*.8,top]],'#f2d89a',3);
    line(g,[[x+w*.26,y+h*.16],[x+w*.4,y+h*.13]],'rgba(255,231,163,.5)',3);
  }
  function trophy(g,s) {
    const n=count(s.trophies),stage=count(s.journeyStage),p=specs.trophycase;
    for(let row=0;row<3;row++) clip(g,p.shelves[row],()=>{
      for(let col=0;col<2;col++)if(row*2+col<Math.min(n,6)) {
        const r=p.shelves[row];cup(g,r[0]+88+col*292,r[1]+6,137,r[3]-17,row*2+col);
      }
      // Re-author the original pane's diagonal catches over content, entirely
      // within clear shelf apertures; rails, frame and door hardware remain art.
      if(n>row*2) {
        poly(g,[[817,320],[883,320],[760,974],[694,974]],'rgba(204,225,223,.12)');
        poly(g,[[254,320],[308,320],[250,462],[216,462]],'rgba(220,233,228,.09)');
      }
    });
    if(stage) clip(g,p.crown,()=>{
      for(let i=0;i<Math.min(stage,4);i++) {
        const x=302+i*127,deep=stage>4&&i<((stage-1)%4)+1;
        poly(g,[[x,83],[x+16,63],[x+32,84],[x+16,106]],deep?'#f5dba1':'#ba9149');
        poly(g,[[x+4,83],[x+16,69],[x+16,99]],'#eed79a');
      }
      if(stage>4)lettering(g,'+'+(stage-4),843,125,27,'#dfc58a',140,'right');
    });
    clip(g,p.plaque,()=>lettering(g,n?'HONOURS '+n:'EMPTY',560,1228,35,n?'#c8b478':'#635948',490,'center'));
  }
  function inbox(g,s) {
    // There is no inbox data feed in PropSprites today. An explicit collection
    // is the only supported future input; work/hot/time never manufacture mail.
    if(!Array.isArray(s.inboxItems))return;
    const n=new Set(s.inboxItems.filter(item=>item&&typeof item==='object'&&typeof item.id==='string'&&item.id.length>0).map(item=>item.id)).size;
    if(!n)return;
    for(let row=0;row<3;row++)clip(g,specs.comms_inbox.trays[row],()=>{
      const r=specs.comms_inbox.trays[row],shown=Math.min(2,Math.max(0,n-row*2));
      for(let i=0;i<shown;i++)paper(g,r[0]+53+i*435,r[1]+9,340,row?114:139,'message',row*2+i);
      if(row===0&&n>6)lettering(g,'+'+(n-6),r[0]+r[2]-24,r[1]+r[3]-27,42,'#d5c7a5',170,'right');
    });
  }
  function calendar(g,s,time) {
    const days=['MON','TUE','WED','THU','FRI','SAT','SUN'];
    specs.calwall.headers.forEach((r,i)=>clip(g,r,()=>lettering(g,days[i],r[0]+r[2]/2,r[1]+r[3]/2,32,'#98a995',r[2]-20,'center')));
    // Blank scheduling form. A slow warm illumination drift is hardware ambience;
    // no date selection, booked entry, event, checkmark, or progress is asserted.
    clip(g,specs.calwall.paper,()=>{
      const r=specs.calwall.paper,x=r[0]+(s.still?.42:(time%16000)/16000)*(r[2]-250);
      const glow=g.createLinearGradient(x,0,x+250,0);glow.addColorStop(0,'rgba(246,224,170,0)');glow.addColorStop(.5,'rgba(246,224,170,.09)');glow.addColorStop(1,'rgba(246,224,170,0)');
      rect(g,x,r[1],250,r[3],glow);
    });
  }
  function microfiche(g,s,time) {
    clip(g,specs.arc_microfiche.screen,()=>{
      const r=specs.arc_microfiche.screen;
      // Optical alignment pattern, never a fake archive document or scan meter.
      const glow=g.createRadialGradient(695,475,8,695,475,265);
      glow.addColorStop(0,'rgba(133,155,135,.10)');glow.addColorStop(1,'rgba(110,139,124,0)');rect(g,...r,glow);
      const c='rgba(173,188,160,.34)';
      for(const [x,y,dx,dy]of [[486,390,1,1],[904,390,-1,1],[486,577,1,-1],[904,577,-1,-1]])line(g,[[x+dx*30,y],[x,y],[x,y+dy*24]],c,3);
      line(g,[[682,484],[708,484]],'rgba(188,200,171,.28)',2);line(g,[[695,471],[695,497]],'rgba(188,200,171,.28)',2);
      // Ambient lamp shimmer is frozen by still. It carries no backend meaning.
      const shimmer=s.still?.026:.018+.016*(.5+.5*Math.sin(time/1200));
      rect(g,...r,'rgba(172,188,150,'+shimmer+')');
    });
  }
  const painters={missionboard:mission,trophycase:trophy,comms_inbox:inbox,calwall:calendar,arc_microfiche:microfiche};
  function draw(ctx,id,box,state={}) {
    const spec=Object.hasOwn(specs,id)?specs[id]:null;
    if(!spec||!ctx||!box||![box.x,box.y,box.width,box.height].every(finite)||box.width<=0||box.height<=0)return false;
    const crop=box.crop||{x:0,y:0,width:spec.width,height:spec.height};
    if(![crop.x,crop.y,crop.width,crop.height].every(finite)||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>spec.width||crop.y+crop.height>spec.height)return false;
    const s=state&&typeof state==='object'?state:{};
    ctx.save();
    try {
      // Keep the caller's world/mirror transform, clip and opacity. In particular,
      // fading an occluded prop must fade every content and glass stroke with it.
      ctx.translate(box.x,box.y);ctx.scale(box.width/crop.width,box.height/crop.height);
      ctx.beginPath();ctx.rect(0,0,crop.width,crop.height);ctx.clip();
      ctx.translate(-crop.x-spec.left,-crop.y-spec.top);
      ctx.globalCompositeOperation='source-over';ctx.shadowBlur=0;
      painters[id](ctx,s,finite(s.now)?Math.max(0,s.now):0);
    } finally {ctx.restore();}
    return true;
  }
  return Object.freeze({draw,regions});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredPropContent;
