/* New painted service content, measured on batch03 exported PNGs. The caller
   composes body + content at full opacity, then applies world opacity once.
   No source sampling, old sprite callbacks, timers, or harness mutations. */
'use strict';
const AuthoredServiceContent = (() => {
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const count=n=>finite(n)&&n>=0?Math.min(Number.MAX_SAFE_INTEGER,Math.floor(n)):0;
  const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  // Coordinates already use EXPORT pixels. Storage/control exporter crops have
  // been subtracted once; utility exports preserve their full source canvas.
  const specs={
    outbox:{width:1095,height:1139,mouth:rect(315,104,457,325),cargo:[[360,549],[725,549],[745,929],[338,929]],status:rect(906,283,114,50)},
    connector_portal:{width:602,height:1622,status:rect(168,220,209,69),sockets:[rect(223,422,98,90),rect(196,717,152,87),rect(220,1017,108,90)]},
    jukebox:{width:783,height:1395,status:rect(296,626,190,42),tubes:[rect(53,394,41,197),rect(682,394,44,197)]},
    // Ellipse extends beneath the rim; destination-over makes that real painted
    // hardware the mask. Its center was checked against the transparent opening.
    airlock:{width:1176,height:1132,iris:rect(230,206,716,718)},
    pub_publishpress:{width:1160,height:1204,throat:rect(391,615,376,40),tray:[[353,809],[800,809],[825,1019],[328,1019]],status:rect(1005,653,103,95)},
    pub_outboundchute:{width:743,height:1593,hopper:[[138,108],[538,108],[471,250],[191,250]],lane:rect(279,570,118,653)},
    pub_mailpod:{width:1430,height:976,bays:[[[240,451],[599,451],[600,638],[218,638]],[[831,452],[1195,452],[1209,638],[816,638]]],lamps:[rect(404,366,20,20),rect(1004,366,20,20)]},
    intake:{width:1298,height:1212,roller:rect(394,733,209,65),status:rect(846,830,67,43)},
    bay:{width:1232,height:1277,nameplate:rect(379,121,476,60),rollers:[rect(145,487,126,333),rect(961,487,132,333)]},
    merger:{width:1512,height:1040,rollers:[rect(156,135,240,114),rect(156,700,240,114),rect(1028,426,353,115)]},
    splitter:{width:1464,height:1075,rollers:[rect(49,438,38,152),rect(1376,160,37,129),rect(1376,692,37,133)]},
    joiner:{width:1511,height:1041,rollers:[rect(54,200,272,88),rect(54,623,272,93),rect(1180,422,199,101)]},
    loop:{width:1145,height:1374,rollers:[rect(75,678,315,92),rect(790,507,279,91),rect(789,878,281,93)]}
  };
  function freeze(o){for(const v of Object.values(o))if(v&&typeof v==='object')freeze(v);return Object.freeze(o);}
  const regions={};
  for(const [id,s]of Object.entries(specs)){
    const norm=p=>p.map(([x,y])=>[x/s.width,y/s.height]);
    const r=regions[id]={sourceWidth:s.width,sourceHeight:s.height};
    for(const [key,value]of Object.entries(s))if(Array.isArray(value))r[key]=Array.isArray(value[0][0])?value.map(norm):norm(value);
  }
  freeze(regions);
  function path(g,p){g.beginPath();p.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.closePath();}
  function polygon(g,p,c){g.fillStyle=c;path(g,p);g.fill();}
  function patch(g,x,y,w,h,c){g.fillStyle=c;g.fillRect(x,y,w,h);}
  function stroke(g,p,c,w=3){g.strokeStyle=c;g.lineWidth=w;g.beginPath();p.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.stroke();}
  function clipped(g,p,paint){g.save();try{path(g,p);g.clip();paint();}finally{g.restore();}}
  function text(g,value,x,y,size,c,maxWidth){g.font=size+"px 'VT323','Courier New',monospace";g.textAlign='center';g.textBaseline='middle';g.fillStyle=c;g.fillText(String(value),x,y,maxWidth);}
  function bounds(p){const xs=p.map(q=>q[0]),ys=p.map(q=>q[1]);return{x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};}
  function lens(g,p,c,level=1){clipped(g,p,()=>{const r=bounds(p);polygon(g,p,'rgba('+c+','+(.15+.24*level)+')');patch(g,r.x+r.w*.18,r.y+r.h*.2,r.w*.58,r.h*.42,'rgba('+c+','+(.34+.3*level)+')');patch(g,r.x+r.w*.2,r.y+r.h*.2,r.w*.4,Math.max(2,r.h*.1),'rgba(255,235,186,.46)');});}
  // Angular enamel, exposed bronze and cast side faces match the new outbox.
  // Each object corresponds to one uncollected run, bounded at five objects.
  function crate(g,x,y,w,h,index){
    polygon(g,[[x+5,y+h-4],[x+w+10,y+h-2],[x+w+15,y+h+9],[x+3,y+h+8]],'rgba(4,10,11,.5)');
    polygon(g,[[x,y+18],[x+w-19,y+18],[x+w,y],[x+21,y]],'#809288');
    polygon(g,[[x+w-19,y+18],[x+w,y],[x+w,y+h-18],[x+w-19,y+h]],'#283a39');
    polygon(g,[[x,y+18],[x+w-19,y+18],[x+w-19,y+h],[x,y+h]],'#3d5550');
    polygon(g,[[x+5,y+23],[x+w-25,y+23],[x+w-26,y+h-7],[x+6,y+h-7]],'#54736a');
    polygon(g,[[x+8,y+25],[x+w*.5,y+25],[x+w*.41,y+h-11],[x+9,y+h-8]],'#6b8171');
    for(const t of [.2,.73]){patch(g,x+w*t,y+19,7,h-19,'#b78c3e');polygon(g,[[x+w*t,y+18],[x+w*t+21,y],[x+w*t+27,y],[x+w*t+7,y+18]],'#d8bc73');}
    patch(g,x+w*.4,y+h*.54,w*.23,11,'#2b3e3a');patch(g,x+w*.42,y+h*.54,w*.18,3,'#acc0a4');
    stroke(g,[[x+2,y+20],[x+w-21,y+20]],'#c0c7a4',3);
    for(let i=0;i<4;i++){const px=x+9+(i*29+index*7)%(w-38),py=y+29+(i*17+index*11)%(h-45);polygon(g,[[px,py],[px+9,py-2],[px+4,py+3]],i%2?'#89957a':'#3b5149');}
  }
  function outbox(g,s,t){
    const n=count(s.crates),p=specs.outbox;
    clipped(g,p.mouth,()=>{for(let i=0;i<Math.min(n,3);i++)crate(g,350+(i%2)*190,195+Math.floor(i/2)*126,165,111,i);});
    clipped(g,p.cargo,()=>{for(let i=3;i<Math.min(n,5);i++)crate(g,415,600+(i-3)*153,239,121,i);});
    clipped(g,p.status,()=>text(g,n>5?'5 +'+(n-5):n,963,308,30,n?'#d4e1a9':'#68796d',101));
    if(s.work===true)clipped(g,p.cargo,()=>{const y=557+(t%1500)/1500*350;patch(g,348,y,8,26,'rgba(236,201,124,.38)');patch(g,730,y,6,26,'rgba(236,201,124,.24)');});
  }
  function connector(g,s){
    const bound=s.bound===true,status=bound?(typeof s.state==='string'?s.state:'offline'):'unbound';
    const online=bound&&status==='online',error=bound&&status==='error';
    const fired=online&&finite(s.fired)?Math.max(0,Math.min(1,s.fired)):0;
    const c=error?'239,112,77':online?'126,218,210':bound?'193,147,69':'62,76,73';
    const label=error?'ERROR':online?'ONLINE':bound?(status==='connecting'?'LINKING':'OFFLINE'):'UNBOUND';
    const p=specs.connector_portal;
    clipped(g,p.status,()=>{lens(g,p.status,c,online?.55+fired*.45:0);text(g,label,272,255,35,bound?(error?'#efb789':online?'#c5f4de':'#c3aa70'):'#718579',197);});
    if(!bound)return;
    for(const socket of p.sockets)clipped(g,socket,()=>{
      const r=bounds(socket),x=r.x+8,y=r.y+10,w=r.w-16,h=r.h-20;
      polygon(g,[[x+7,y],[x+w-8,y],[x+w,y+9],[x+w-2,y+h],[x,y+h-3],[x,y+7]],'#435959');
      polygon(g,[[x+7,y+2],[x+w-10,y+2],[x+w-15,y+12],[x+4,y+10]],'#9bafa0');
      patch(g,x+5,y+h-10,w-10,7,'#1c3031');
      for(const dx of [.25,.65])patch(g,x+w*dx,y+15,7,h-26,'#b39958');
      lens(g,rect(x+w*.37,y+14,w*.24,h*.46),c,online?.55+fired*.45:0);
    });
  }
  function jukebox(g,s){
    if(s.live!==true)return; // Connection is the only native fact; never playback.
    const p=specs.jukebox;for(const tube of p.tubes)lens(g,tube,'235,172,67',.35);
    clipped(g,p.status,()=>{lens(g,p.status,'147,197,156',.3);text(g,'LINK',391,647,32,'#d2e6ba',168);});
  }
  const polar=(angle,r)=>[588+Math.cos(angle)*r,565+Math.sin(angle)*r];
  function iris(g,s,t){
    const door=s.door==='closed'?'closed':s.door==='jammed'?'jammed':'open';
    const inner=door==='open'?298:door==='jammed'?111:0;
    g.save();try{
      // Paint behind the already-composed body: rim, tabs, and seals occlude
      // leaves without copying the original raster or painting over its frame.
      g.globalCompositeOperation='destination-over';
      g.beginPath();g.ellipse(588,565,358,359,0,0,Math.PI*2);g.clip();
      if(door==='jammed'){
        const d=s.still?0:Math.floor(t/120)%3;
        stroke(g,[[552,666],[561+d*4,644],[577,656],[589,632]],'#edba6b',5);
      }
      // Reflected light moves on a retracted leaf, never changing door state.
      if(door==='open'){
        const a=.1+(s.still?.2:Math.sin(t/1600)*.12),p=polar(a,307);
        stroke(g,[[p[0]-3,p[1]-14],[p[0]+1,p[1]+8]],'#8daca0',5);
      }
      for(let i=0;i<8;i++){
        const a=i*Math.PI/4,b=a+Math.PI/4,r=door==='jammed'&&i===2?36:inner;
        const p=[polar(a,400),polar(b,400),polar(b+.25,r),polar(a+.25,r)];
        // Destination-over requires highlights before the opaque leaf face.
        if(door==='jammed'&&i===2){stroke(g,[polar(a+.25,42),polar(a+.28,186)],'#b47a38',12);stroke(g,[polar(a+.25,44),polar(a+.25,184)],'#dfb168',3);}
        stroke(g,[polar(a+.25,r+6),polar(a+.06,341)],'#171e20',8);
        stroke(g,[polar(a+.29,r+13),polar(a+.09,336)],'#9fa99d',3);
        polygon(g,[p[0],polar(a+.22,352),polar(a+.3,r+18),p[3]],i%2?'#63716c':'#7c8575');
        polygon(g,p,['#526260','#455453','#4e5e5c','#384948'][i%4]);
      }
    }finally{g.restore();}
  }
  function press(g,s,t){
    if(s.work!==true&&s.scanning!==true)return;
    const p=specs.pub_publishpress,travel=s.still?8:5+(1+Math.sin(t/240))*8;
    clipped(g,p.throat,()=>{
      // A narrow pressure shoe in the new empty throat. Never a printed sheet.
      for(const x of [405,743]){patch(g,x,615,10,travel+9,'#819184');patch(g,x,615,3,travel+9,'#c3cbb2');}
      polygon(g,[[403,617+travel],[755,617+travel],[753,627+travel],[405,627+travel]],'#666b56');
      stroke(g,[[405,618+travel],[754,618+travel]],'#bc9a50',3);
    });
    clipped(g,p.status,()=>{lens(g,p.status,'216,176,83',.4);text(g,s.work===true?'RUN':'SCAN',1056,700,30,'#e2d2a1',90);});
  }
  function chute(g,s,t){
    if(s.work!==true&&s.scanning!==true)return;
    const p=specs.pub_outboundchute,light=s.still?.4:.25+(1+Math.sin(t/450))*.12;
    // Fixed glass-edge illumination implies powered machinery, no falling item.
    clipped(g,p.lane,()=>{patch(g,280,585,5,620,'rgba(221,192,116,'+light+')');patch(g,389,585,4,620,'rgba(153,189,172,'+light*.65+')');});
    clipped(g,p.hopper,()=>stroke(g,[[147,113],[529,113]],'#b3a16b',5));
  }
  function mailpod(g,s,t){
    if(s.work!==true&&s.scanning!==true)return;
    const level=s.still?.4:.3+(1+Math.sin(t/510))*.13;
    for(const p of specs.pub_mailpod.lamps)lens(g,p,'192,215,170',level);
    // Both bays stay vacant; no capsule, arrival, dispatch or success is implied.
  }
  function rollers(g,p,t,still,axis='vertical'){
    clipped(g,p,()=>{
      const r=bounds(p),phase=still?.38:(t%850)/850;
      // Catches stay attached to each cylinder. They do not travel down a route.
      if(axis==='horizontal'){
        const y=r.y+6+phase*(r.h-14);stroke(g,[[r.x+3,y],[r.x+r.w-4,y-1]],'rgba(195,202,176,.52)',4);
      }else{
        const columns=Math.max(1,Math.round(r.w/58)),step=r.w/columns;
        for(let i=0;i<columns;i++){
          const x=r.x+i*step+step*(.18+.5*phase);
          polygon(g,[[x,r.y+4],[x+4,r.y+7],[x+2,r.y+r.h-5],[x-2,r.y+r.h-8]],'rgba(190,201,186,.5)');
        }
      }
    });
  }
  function intake(g,s,t){
    if(s.work!==true&&s.scanning!==true)return;
    const p=specs.intake;rollers(g,p.roller,t,s.still,'horizontal');lens(g,p.status,'213,171,79',.45);
  }
  function bay(g,s,t){
    const p=specs.bay,bound=typeof s.agentId==='string'&&s.agentId.length>0;
    if(bound)clipped(g,p.nameplate,()=>{
      lens(g,p.nameplate,'102,169,143',.15);
      const name=typeof s.dockName==='string'?s.dockName.replace(/[\u0000-\u001f\u007f]/g,' ').trim():'';
      // The separate world bay-name pass remains authoritative at station scale.
      if(name)text(g,name.slice(0,64),617,151,42,'#c1dab2',453);
    });
    if(s.work===true||s.scanning===true)for(const p0 of p.rollers)rollers(g,p0,t,s.still);
  }
  function transport(g,s,t,id){
    if(s.work!==true&&s.scanning!==true)return;
    for(const p of specs[id].rollers)rollers(g,p,t,s.still);
    // No real branch, holding, or iteration facts are present in native o:
    // leave deflectors, stop pins, tallies, counters and all cargo spaces neutral.
  }
  const painters={outbox,connector_portal:connector,jukebox,airlock:iris,pub_publishpress:press,pub_outboundchute:chute,pub_mailpod:mailpod,intake,bay};
  function draw(ctx,id,box,state={}){
    const spec=Object.hasOwn(specs,id)?specs[id]:null;
    if(!spec||!ctx||!box||![box.x,box.y,box.width,box.height].every(finite)||box.width<=0||box.height<=0)return false;
    const crop=box.crop||{x:0,y:0,width:spec.width,height:spec.height};
    if(![crop.x,crop.y,crop.width,crop.height].every(finite)||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>spec.width||crop.y+crop.height>spec.height)return false;
    const s=state&&typeof state==='object'?state:{},t=s.still?0:finite(s.now)?Math.max(0,s.now):0;
    ctx.save();try{
      ctx.translate(box.x,box.y);ctx.scale(box.width/crop.width,box.height/crop.height);
      ctx.beginPath();ctx.rect(0,0,crop.width,crop.height);ctx.clip();ctx.translate(-crop.x,-crop.y);
      ctx.globalCompositeOperation='source-over';ctx.shadowBlur=0;
      if(Object.hasOwn(painters,id))painters[id](ctx,s,t);else transport(ctx,s,t,id);
    }finally{ctx.restore();}
    return true;
  }
  return Object.freeze({draw,regions});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredServiceContent;
