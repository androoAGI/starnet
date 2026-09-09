/* Command-room vertical slice. Presentation only: canonical geometry, capabilities,
   movement and harness activity remain owned by World. Opt in with ?commandroom=1. */
const CommandRoom = (() => {
  'use strict';
  const enabled = new URLSearchParams(location.search).get('commandroom') === '1';
  const root = 'assets/command-room/';
  const art = {}, tracks = {}, poses = new WeakMap(), doors = new Map();
  let frame = null, room = null, roomId = null, base = null, baseGeo = null;
  let loaded = 0, failed = [], manifestReady = false, metrics = {};
  const responses = new Map(), typedFrames = new WeakMap();
  const totals = { props: 0, bodies: 0, doors: 0, typing: 0, reaching: 0, walking: 0 };
  function load(path) {
    const im = new Image(); im.onload = () => { loaded++; }; im.onerror = () => { failed.push(path); }; im.src = root + path; return im;
  }
  if (enabled) {
    art.console = load('console.png'); art.server = load('server.png');
    fetch(root + 'operator/manifest.json').then(r => { if (!r.ok) throw Error('operator manifest'); return r.json(); }).then(m => {
      for (const [key, paths] of Object.entries(m.tracks)) tracks[key] = paths.map(p => load('operator/' + p));
      metrics = m.metrics || {}; manifestReady = true;
    }).catch(e => failed.push(e.message));
  }
  const ready = im => im && im.complete && im.naturalWidth > 0;
  function at(x, y) { return frame && frame.geo.zoneGrid[Math.floor(y / 12) * frame.geo.COLS + Math.floor(x / 12)] === roomId; }
  function owns(p) { return enabled && frame && at((p.x + (p.w || 1) / 2) * 12, (p.y + .5) * 12); }
  function kind(p) {
    if (!owns(p) || p.r || p.mount) return null;
    if (p.t === 'desk') return 'console';
    if (p.t === 'rackV') return 'server';
    if (p.t === 'holotable') return 'holo';
    return null;
  }
  function rect(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function outline(g, x, y, w, h, c) { rect(g,x,y,w,1,c);rect(g,x,y+h-1,w,1,c);rect(g,x,y,1,h,c);rect(g,x+w-1,y,1,h,c); }
  function panel(g,x,y,w,h) { rect(g,x,y,w,h,'#101921');rect(g,x+1,y+1,w-2,h-2,'#29333b');rect(g,x+2,y+2,w-4,1,'#56606a');rect(g,x+w-3,y+3,1,h-5,'#17222a'); }
  function begin(f) {
    if (!enabled) return;
    frame = f; roomId = f.spawnRoomId; room = f.geo.zones[roomId];
    if (!room) { base = null; baseGeo = null; doors.clear(); return; }
    if (baseGeo !== f.geo) { baseGeo = f.geo; base = build(f.geo); doors.clear(); }
  }
  function build(geo) {
    const c = document.createElement('canvas'); c.width = geo.W; c.height = geo.H;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    c.addEventListener('contextlost', () => { baseGeo = null; });
    // The new deck is clipped to the actual room tiles, including chamfers and edits.
    g.save();g.beginPath();
    for(let y=room.y1;y<=room.y2;y++)for(let x=room.x1;x<=room.x2;x++) if(geo.zoneGrid[y*geo.COLS+x]===roomId && !(geo.chamfers||[]).some(c=>c[0]===x&&c[1]===y))g.rect(x*12,y*12,12,12);
    g.clip();
    for(let y=room.y1;y<=room.y2;y++)for(let x=room.x1;x<=room.x2;x++) {
      const px=x*12,py=y*12;rect(g,px,py,12,12,((x+2*y)%3)?'#364047':'#333c44');
      rect(g,px,py,12,1,'#232d35');rect(g,px,py+1,1,11,'#424b51');
      rect(g,px+10,py+2,1,1,'#606970');rect(g,px+2,py+10,1,1,'#202b32');
      if(y%4===0){rect(g,px+3,py+4,7,1,'#303941');rect(g,px+3,py+6,7,1,'#303941');}
    }
    const x=room.x1*12,y=room.y1*12,w=(room.x2-room.x1+1)*12,h=(room.y2-room.y1+1)*12;
    // Flush cable trenches, service plates, and workstation docking outlines.
    for(const sx of [x+8,x+w-10]){rect(g,sx,y,3,h,'#17252d');rect(g,sx+1,y,1,h,'#41525b');}
    for(const p of geo.props.filter(p=>p.t==='desk'&&owns(p))) {
      const dx=p.x*12-5,dy=p.y*12-2,dw=p.w*12+10;
      outline(g,dx,dy,dw,32,'#1a272f');outline(g,dx+1,dy+1,dw-2,30,'#4b5960');
      for(let n=0;n<4;n++)rect(g,dx+2+n*3,dy+30,2,1,n%2?'#333938':'#a1854f');
      rect(g,dx+3,y+4,2,Math.max(0,dy-y-4),'#1e2930');rect(g,dx+3,dy-2,8,2,'#161f25');
    }
    g.restore();
    // Exterior north-wall segments only. Never place an observation window over an internal doorway.
    let start=null;
    for(let tx=room.x1;tx<=room.x2+1;tx++) {
      const exterior=tx<=room.x2 && geo.zoneGrid[room.y1*geo.COLS+tx]===roomId && geo.zoneGrid[(room.y1-1)*geo.COLS+tx]==null;
      if(exterior&&start===null)start=tx;
      if(!exterior&&start!==null){const width=(tx-start)*12;if(width>=60)windowBay(g,start*12,y,width,30);start=null;}
    }
    // Fixed edge ribs give the hull mass without projecting black bands over the wall.
    for(const sx of [x-3,x+w-3]) {panel(g,sx,y-24,6,23);rect(g,sx+2,y-20,2,8,'#b89560');}
    return c;
  }
  function windowBay(g,x,y,w,h) {
    panel(g,x+3,y-h,w-6,h);
    const ix=x+11,iy=y-h+5,iw=w-22,ih=h-11;
    rect(g,ix-2,iy-2,iw+4,ih+4,'#11181e');rect(g,ix,iy,iw,ih,'#080f19');
    // A finite view through glass: all celestial pixels stay inside the recessed aperture.
    g.save();g.beginPath();g.rect(ix,iy,iw,ih);g.clip();
    for(let n=0;n<55;n++){const sx=ix+(n*37+13)%iw,sy=iy+(n*19+7)%ih;rect(g,sx,sy,1,1,n%7?'#293b4a':'#789baf');}
    const cx=ix+iw*.72,cy=iy+ih+12,r=25;
    for(let yy=iy;yy<iy+ih;yy++)for(let xx=ix;xx<ix+iw;xx++){
      const d=Math.hypot(xx-cx,yy-cy);if(d<r){const rim=d>r-1.8;rect(g,xx,yy,1,1,rim?'#6991a4':((xx+yy*3)%13<3?'#283c50':'#1b2c3e'));}
    }
    rect(g,ix,iy,iw,1,'#344e5f');rect(g,ix,iy+ih-1,iw,1,'#23323e');
    g.restore();
    for(const a of [.31,.66]){const sx=ix+Math.floor(iw*a);rect(g,sx,iy-2,3,ih+4,'#121c25');rect(g,sx,iy-2,1,ih+4,'#55636a');}
    rect(g,x+7,y-5,w-14,3,'#101b23');rect(g,x+8,y-5,w-16,1,'#58747d');
    for(const a of [.15,.85]){const lx=x+Math.floor(w*a);rect(g,lx-5,y-h+1,10,2,'#ac9977');rect(g,lx-3,y-h+2,6,1,'#e6ca93');}
  }
  function drawBase(g) { if(enabled&&base)g.drawImage(base,0,0); }
  function footprint(p) {
    const k=kind(p),cx=(p.x+(p.w||1)/2)*12,foot=(p.y+(p.h||1))*12;
    if(k==='console')return {k,x:cx-16,y:foot-25,w:32,h:25,foot};
    if(k==='server')return {k,x:cx-9,y:foot-32,w:18,h:32,foot};
    if(k==='holo')return {k,x:p.x*12,y:p.y*12-8,w:p.w*12,h:p.h*12+8,foot};
    return null;
  }
  function litImage(im,light) {
    if(!light||!(light.strength>.02))return im;
    const power=Math.round(Math.min(1,light.strength)*8)/8;
    const color=(light.color||[120,180,195]).map(v=>Math.round(v/32)*32);
    const dx=Math.round((light.dx||0)*2)/2,dy=Math.round((light.dy||0)*2)/2;
    const key=[im.src,power,...color,dx,dy].join('|');
    if(responses.has(key))return responses.get(key);
    const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;
    const g=c.getContext('2d');g.drawImage(im,0,0);g.globalCompositeOperation='source-atop';
    const cx=c.width/2,cy=c.height/2;
    const grad=g.createLinearGradient(cx-dx*cx,cy-dy*cy,cx+dx*cx+.01,cy+dy*cy+.01);
    grad.addColorStop(0,'rgba(4,12,22,'+(power*.18)+')');
    grad.addColorStop(.45,'rgba('+color.join(',')+','+(power*.035)+')');
    grad.addColorStop(1,'rgba('+color.join(',')+','+(power*.3)+')');
    g.fillStyle=grad;g.fillRect(0,0,c.width,c.height);
    if(responses.size>=96)responses.delete(responses.keys().next().value);
    responses.set(key,c);c.addEventListener('contextlost',()=>responses.delete(key),{once:true});return c;
  }
  function drawProp(g,p,work,live,light) {
    const q=footprint(p);if(!q)return false;
    if(q.k!=='holo'&&!ready(art[q.k]))return false;
    totals.props++;
    g.save();
    if(q.k==='holo')drawHolo(g,q);else{
      g.imageSmoothingEnabled=true;g.drawImage(litImage(art[q.k],light),q.x,q.y,q.w,q.h);
      if(q.k==='console') {
        // A pulled-out keyboard tray meets the seated operator's actual hand plane.
        panel(g,q.x+8,q.foot-8,16,6);
        rect(g,q.x+10,q.foot-6,12,2,'#151d25');
        for(let k=0;k<5;k++)rect(g,q.x+10+k*2,q.foot-6,1,1,'#718282');
      }
      // Screen refresh follows actual assigned workstation activity. Idle screens are static.
      if(q.k==='console'&&live){
        const phase=frame.reducedMotion?0:Math.floor(frame.now/180)%3;
        rect(g,q.x+12,q.y+7+phase,7,1,'#81d8d1');
        rect(g,q.x+25,q.foot-8,1,2,'#d6a35f');
      }
    }
    // Physical connector cables remain below the elevated face and meet the floor.
    rect(g,q.x+3,q.foot-1,1,3,'#171d24');rect(g,q.x+3,q.foot+1,4,1,'#4c4140');
    g.restore();return true;
  }
  function drawHolo(g,q) {
    const {x,y,w,h}=q;const busy=frame.bodies.some(b=>b&&b.working&&at(b.px,b.py));
    for(const dx of [3,w-7]){panel(g,x+dx,y+h-10,4,10);rect(g,x+dx+1,y+h-2,3,1,'#806c4e');}
    panel(g,x,y+10,w,h-17);rect(g,x+3,y+12,w-6,5,'#19303a');
    rect(g,x+5,y+11,w-10,1,'#639395');
    // Empty navigation grid at rest; no invented jobs, task counts, or progress.
    rect(g,x+5,y,w-10,11,'#152b35');outline(g,x+5,y,w-10,11,'#41636f');
    for(let i=10;i<w-8;i+=7)rect(g,x+i,y+2,1,7,'#25454e');
    rect(g,x+7,y+5,w-14,1,'#25454e');
    for(const b of frame.bodies.filter(b=>b&&!b.unplaced&&at(b.px,b.py))){
      const sx=x+7+(b.px-room.x1*12)/((room.x2-room.x1+1)*12)*(w-15);
      const sy=y+2+(b.py-room.y1*12)/((room.y2-room.y1+1)*12)*6;
      rect(g,sx,sy,1,1,b.working?'#d5aa61':'#7cbbbd');
    }
    if(busy&&!frame.reducedMotion)rect(g,x+8+Math.floor(frame.now/230)%(w-17),y+8,2,1,'#92d4ce');
    for(const dx of [2,w-4]){rect(g,x+dx,y+5,2,9,'#222c34');rect(g,x+dx,y+5,2,1,'#bead87');}
  }
  function lightOf(p,work,live) {
    const q=footprint(p);if(!q)return null;
    return {x:q.x+q.w/2,y:q.foot-10,r:q.k==='console'?32:25,c:q.k==='server'?[213,157,79]:[100,188,199],a:live && live.heat != null ? .18+Math.min(1,Math.max(0,live.heat))*.18 : .15,softness:1.3};
  }
  function drawShadow(g,p) {
    const q=footprint(p);if(!q)return false;
    g.save();g.globalAlpha*=.23;
    g.fillStyle='#071019';g.beginPath();g.moveTo(q.x+3,q.foot-3);g.lineTo(q.x+q.w-3,q.foot-3);g.lineTo(q.x+q.w+3,q.foot+5);g.lineTo(q.x+7,q.foot+5);g.closePath();g.fill();g.restore();return true;
  }
  function addItems(items, lights) {
    if(!enabled||!frame||!room)return;
    // Group passable tile seams into one physical sliding bulkhead. A sealed seam is absent.
    if(lights)for(const a of [.15,.85]) {
      const x=(room.x1+(room.x2-room.x1+1)*a)*12,y=room.y1*12;
      lights.push({x,y:y+2,originX:x,originY:y+4,r:39,c:[210,183,135],a:.22,softness:1.5});
    }
    const groups=new Map();
    for(const d of frame.geo.doorDefs){
      const [ax,ay,bx,by]=d,za=frame.geo.zoneGrid[ay*frame.geo.COLS+ax],zb=frame.geo.zoneGrid[by*frame.geo.COLS+bx];
      if(za!==roomId&&zb!==roomId)continue;
      const vertical=ax!==bx,edge=vertical?Math.max(ax,bx)*12:Math.max(ay,by)*12;
      const key=(vertical?'v':'h')+edge,t=(vertical?ay:ax)*12;
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push({key,vertical,edge,min:t,max:t+12});
    }
    const keep=new Set();
    const spans=[];
    for(const list of groups.values()) {
      list.sort((a,b)=>a.min-b.min);let last=null;
      for(const d of list){if(last&&d.min===last.max)last.max=d.max;else{last={...d,key:d.key+':'+d.min};spans.push(last);}}
    }
    for(const d of spans){
      keep.add(d.key);const mid=(d.min+d.max)/2,cx=d.vertical?d.edge:mid,cy=d.vertical?mid:d.edge;
      const distance=Math.min(...frame.bodies.filter(b=>b&&!b.unplaced).map(b=>Math.hypot(b.px-cx,b.py-cy)));
      const target=distance<32?1:0,old=doors.get(d.key),dt=old?Math.min(64,Math.max(0,frame.now-old.now)):64;
      const open=frame.reducedMotion||distance<16?target:Math.max(0,Math.min(1,(old?.open||0)+(target?1:-1)*dt/220));
      doors.set(d.key,{open,now:frame.now,distance});
      items.push({y:d.vertical?d.max:d.edge+1,draw:()=>drawDoor(frame.ctx,d,open)});
    }
    for(const k of doors.keys())if(!keep.has(k))doors.delete(k);
  }
  function drawDoor(g,d,open) {
    totals.doors++;const len=d.max-d.min;
    if(d.vertical){
      panel(g,d.edge-3,d.min-19,6,19);panel(g,d.edge-3,d.max-19,6,19);
      rect(g,d.edge-2,d.min-18,1,len,'#5a6870');
      const leaf=Math.round(len/2*(1-open));
      if(leaf){panel(g,d.edge-1,d.min-17,3,leaf);panel(g,d.edge-1,d.max-17-leaf,3,leaf);}
      rect(g,d.edge-2,d.min-14,1,3,open>.9?'#78b8a1':'#b5935c');
    }else{
      panel(g,d.min-3,d.edge-23,5,24);panel(g,d.max-2,d.edge-23,5,24);
      rect(g,d.min,d.edge-23,len,3,'#202d35');rect(g,d.min,d.edge-22,len,1,'#61717a');
      const leaf=Math.round(len/2*(1-open));
      if(leaf){panel(g,d.min,d.edge-20,leaf,20);panel(g,d.max-leaf,d.edge-20,leaf,20);}
      rect(g,d.min-1,d.edge-18,1,4,open>.9?'#78b8a1':'#b5935c');
    }
  }
  function seatedTyping(im) {
    if(typedFrames.has(im))return typedFrames.get(im);
    const seated=tracks['sit.north']?.[0];if(!ready(seated))return im;
    // Upper-body animation over a fixed seated pelvis: generated hand motion must
    // never straighten the knees or lift the operator out of the chair.
    const c=document.createElement('canvas');c.width=64;c.height=64;
    const g=c.getContext('2d');g.drawImage(seated,0,0);g.clearRect(0,0,64,35);
    g.drawImage(im,(im.naturalWidth-64)/2,(im.naturalHeight-64)/2,64,35,0,0,64,35);
    c.naturalWidth=64;c.naturalHeight=64;c.src=im.src+'#seated';
    typedFrames.set(im,c);c.addEventListener('contextlost',()=>typedFrames.delete(im),{once:true});return c;
  }
  function drawBody(g,b,now,light) {
    if(!enabled||!frame||b.id!=='agent')return null;
    let st=poses.get(b);if(!st){st={x:b.px,y:b.py,use:null,since:now};poses.set(b,st);}
    let dir=b.glance?.until>now?b.glance.dir:(b.dir||'south'),action='rot';
    const dx=b.px-st.x,dy=b.py-st.y;
    if(b.state==='walk'){
      if(Math.hypot(dx,dy)>.02)dir=['east','south-east','south','south-west','west','north-west','north','north-east'][(Math.round(Math.atan2(dy,dx)/(.25*Math.PI))+8)%8];
      action='walk';
    }else if(b.working){action='type';dir='north';}
    else if(b.sitting||b.seated)action='sit';
    if(b.lying) { action='sit';dir=b.dir||'north'; }
    const interaction=b.usingProp||b.watchProp;
    const prop=frame.geo.props.find(p=>p.id===interaction);
    const engaged=prop&&b.state!=='walk'&&Math.hypot(b.px-(prop.x+(prop.w||1)/2)*12,b.py-(prop.y+(prop.h||1)/2)*12)<28?interaction:null;
    if(st.use!==engaged){st.use=engaged;st.since=now;}
    if(action==='rot'&&dir==='north'&&engaged&&prop&&['commswall','missionboard','rackV'].includes(prop.t)&&now-st.since<900)action='reach';
    st.x=b.px;st.y=b.py;
    const key=tracks[action+'.'+dir]?action+'.'+dir:'rot.'+dir;
    const track=tracks[key];if(!track||!track.every(ready))return null;
    let i=frame.reducedMotion?0:Math.floor(now/(action==='walk'?105:150)+(b.aph||0))%track.length;
    if(action==='reach')i=Math.min(track.length-1,Math.floor((now-st.since)/110));
    if(action==='sit')i=track.length-1;
    const im=action==='type'?seatedTyping(track[i]):track[i];
    const geometryKey=action==='type'?'sit.north':key;
    const sc=29/64,w=im.naturalWidth*sc,h=im.naturalHeight*sc;
    const pad=(im.naturalHeight-(metrics[geometryKey]?.bottom||im.naturalHeight))*sc;
    const lift=action==='sit'?(b.seatLift||0):0;
    const x=b.px-w/2,y=b.py-h+pad-2-lift;
    b._pose='command.'+key;
    g.save();g.imageSmoothingEnabled=true;g.drawImage(litImage(im,light),x,y,w,h);
    g.restore();totals.bodies++;if(action==='type')totals.typing++;if(action==='reach')totals.reaching++;if(action==='walk')totals.walking++;
    return {top:y+(metrics[geometryKey]?.top||0)*sc,left:x,right:x+w,bottom:b.py-2-lift};
  }
  function stats() {return {enabled,roomId,loaded,manifestReady,lightResponses:responses.size,failed:failed.slice(),tracks:Object.keys(tracks),draws:{...totals},doors:[...doors].map(([key,v])=>({key,...v}))};}
  return {enabled,begin,drawBase,drawProp,lightOf,drawShadow,addItems,drawBody,stats};
})();
