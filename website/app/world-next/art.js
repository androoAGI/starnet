/* StarNet / World Next — independent prop art engine.
 * All bitmap masters in assets/props were generated for this client. No legacy
 * sprite renderer, image, palette, or canvas is loaded here. Catalog IDs are
 * compatibility data only; the app owns placement rules and harness state.
 *
 * const art = await NextArt.create();
 * art.drawProp(ctx, {t,x,y,w,h,r,m}, timeMs, {working,selected,mountRise});
 * x/y/w/h are logical 32px tiles; returned bounds are world pixels. No agent art.
 */
'use strict';

const NextArt = (() => {
  const TILE = 32;
  const scriptBase = typeof document !== 'undefined' && document.currentScript
    ? new URL('./', document.currentScript.src).href : './';
  const C = Object.freeze({ ink: '#142226', dark: '#223538', shadow: '#0c191d', bone: '#d6cfb3', cream: '#eee2bb',
    shade: '#8f998e', copper: '#ad653d', gold: '#d3a467', teal: '#66b5aa', glass: '#254e50', leaf: '#3e796b',
    light: '#f3d09b', orange: '#c67842', red: '#a8594b', cloth: '#467b79' });
  const GROUPS = Object.freeze({
    workstation: 'desk desk2 console consoleL pixelrig bench djbooth bar',
    orrery: 'holotable wartable research_corelens treasury_pnl_holo plasmaglobe',
    memory: 'core gigs_servercart bridge_relaystack bridge_dispatch_pylon war_threatcore research_trendpillar notebook',
    planter: 'plant tallplant monstera',
    couch: 'couch booth recliner recliner_r',
    'sleep-pod': 'bunk cryopod',
    fabricator: 'fabricator workbench etsy_kiln etsy_packbot pub_publishpress treasury_coinsorter',
    intake: 'intake comms_inbox',
    outbox: 'outbox bay pub_outboundchute pub_mailpod bridge_orderqueue',
    table: 'sidetable lowtable glasstable dinertable loungetable longtable research_samplecart',
    cabinet: 'cabinet war_intelcab safe vault rack shelf rackV quarters_lockerbank quarters_minifridge bookshelf etsy_threadrack trophycase weaponrack weaponrack_r',
    reactor: 'vat tube etsy_dyevat treasury_token_furnace lavalamp tank connector_portal',
    armchair: 'chair dinerchair podchair beanbag',
    dish: 'dish comms_dish comms_uplink comms_beacon',
    display: 'missionboard bigscreen screens whiteboard ticker chartwall calwall bridge_tacscreen war_pivotpanel commswall gigs_thumbwall arc_indexwall tv',
    crate: 'crate boxes goldcrate gigs_partsbin toolbox parcels',
    camera: 'studio camerarig camerarig_r',
    jukebox: 'jukebox speaker gigs_amp quarters_vending gachapon arcade arcade2 pinball radio',
    terminal: 'deskterminal crt_pile arc_microfiche',
    terrarium: 'terrarium fishtank incubator',
    junction: 'filter merger splitter joiner loop airlock',
    rug: 'rug rug_small rug_large', cable: 'cablerun beltH', hazard: 'hazardpad', ladder: 'arc_ladder',
    stool: 'stool', mug: 'mug', books: 'bookstack research_papers', lamp: 'desklamp arc_floorlight',
    guitar: 'guitar', telescope: 'telescope telescope_r', exercise: 'punchbag punchbag_r benchpress benchpress_r',
    modelship: 'modelship', vent: 'steamvent', pet: 'holopet figurine', easel: 'easel', coffee: 'coffee',
    'gaming-table': 'quarters_pooltable pokertable'
  });
  const MASTERS = Object.freeze(Object.keys(GROUPS).slice(0, 20));
  const SPECS = Object.create(null);
  const flatFamilies = new Set(['rug', 'cable', 'hazard', 'ladder', 'vent', 'junction']);
  const smallFamilies = new Set(['mug', 'books', 'lamp', 'modelship', 'pet', 'coffee']);
  const repeating = new Set(['bench', 'shelf', 'rack', 'rackV', 'quarters_lockerbank', 'bookshelf', 'bigscreen', 'commswall', 'calwall', 'arc_indexwall', 'crt_pile', 'boxes', 'parcels']);
  for (const [family, list] of Object.entries(GROUPS)) for (const [index, type] of list.split(' ').entries()) {
    SPECS[type] = Object.freeze({ type, family, asset: MASTERS.includes(family) ? family + '.png' : null,
      variant: index, master: index === 0, flat: flatFamilies.has(family), small: smallFamilies.has(family),
      repeat: repeating.has(type), label: type.replace(/_/g, ' ').toUpperCase(), view: 'south-oblique', rotationMode: 'footprint-and-direction-marker' });
  }
  const UNKNOWN = Object.freeze({ type: 'unknown', family: 'crate', asset: 'crate.png', variant: 0, master: false,
    flat: false, small: false, repeat: false, label: 'UNRECOGNIZED EQUIPMENT', view: 'south-oblique', placeholder: true });
  const getSpec = type => SPECS[type] || UNKNOWN;
  const catalog = Object.freeze(Object.values(SPECS));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const rotationOf = p => ((Math.round(finite(p.r, /_r$/.test(p.t || '') ? 1 : 0)) % 4) + 4) % 4;
  const fill = (g, c, x, y, w, h) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); };
  function poly(g, points, color, stroke) {
    g.beginPath(); points.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
    if (color) { g.fillStyle = color; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  }
  function line(g, pts, color, width = 2) {
    g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
  }
  function oval(g, x, y, rx, ry, color, stroke) {
    g.beginPath(); g.ellipse(x, y, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    if (color) { g.fillStyle = color; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  }
  function bounds(p, spec, entry, state = {}) {
    const w = Math.max(0.25, finite(p.w, 1)), h = Math.max(0.25, finite(p.h, 1));
    const cx = (finite(p.x, 0) + w / 2) * TILE, floorY = (finite(p.y, 0) + h) * TILE;
    const rise = Math.max(0, finite(state.mountRise, p.host ? 16 : 0));
    const crop = entry && entry.bounds || { x: 0, y: 0, w: entry && entry.width || 96, h: entry && entry.height || 96 };
    const count = spec.repeat ? Math.max(1, Math.ceil(w / (spec.family === 'display' ? 3 : 2))) : 1;
    let width = w * TILE * 0.96 / count, height = width * crop.h / Math.max(1, crop.w);
    if (!entry) { width = w * TILE * 0.92; height = spec.flat ? h * TILE * 0.87 : Math.max(24, Math.min(78, h * TILE + 26)); }
    if (spec.small) { width = Math.min(24, w * TILE * 0.65); height = width; }
    if (spec.family === 'junction') { width = w * TILE * 0.88; height = h * TILE * 0.72; }
    if (spec.family === 'table') height = Math.min(height, Math.max(38, h * TILE + 18));
    return { x: cx - width * count / 2, y: floorY - height - rise, w: width * count, h: height,
      unitW: width, count, cx, floorY, anchorY: floorY - rise, sortY: floorY, crop, tileW: w * TILE, tileH: h * TILE, rotation: rotationOf(p) };
  }
  function drawFacing(g, p, f, selected) {
    const r = rotationOf(p), cx = f.cx, py = f.floorY - f.tileH / 2;
    const dx = [0, -1, 0, 1][r], dy = [1, 0, -1, 0][r];
    const x = cx + dx * (f.tileW / 2 + 3), y = py + dy * (f.tileH / 2 + 3);
    if (!selected && r === 0 && !p.m) return;
    g.save(); g.translate(x, y); g.rotate(r * Math.PI / 2);
    poly(g, [[-3, -2], [0, 2], [3, -2]], selected ? C.light : C.copper); g.restore();
  }
  function selection(g, p, f) {
    const x = finite(p.x, 0) * TILE, y = finite(p.y, 0) * TILE, w = f.tileW, h = f.tileH;
    for (const [cx, cy, dx, dy] of [[x,y,1,1],[x+w,y,-1,1],[x,y+h,1,-1],[x+w,y+h,-1,-1]])
      line(g, [[cx + dx * 8, cy], [cx, cy], [cx, cy + dy * 8]], C.light, 1.5);
  }

  // Newly authored small objects and routing hardware. These deliberately have
  // their own silhouettes instead of a colored rectangle for every catalog ID.
  function drawOriginal(g, spec, f, p) {
    const cx = f.cx, y = f.anchorY, w = f.w, h = f.h, left = cx - w / 2, top = y - h;
    const family = spec.family, type = p.t;
    if (family === 'rug') {
      const colors = type === 'rug_large' ? ['#754957','#be8b72'] : type === 'rug_small' ? ['#87643f','#dfbc8a'] : ['#346e69','#bb975e'];
      const rh = f.tileH * 0.87, ry = y - rh;
      poly(g, [[left+8,ry],[left+w-8,ry],[left+w,ry+8],[left+w,y-8],[left+w-8,y],[left+8,y],[left,y-8],[left,ry+8]], colors[0], C.ink);
      for(let i=4;i<12;i+=4) { g.strokeStyle=colors[1];g.lineWidth=1;g.strokeRect(left+i,ry+i,w-i*2,rh-i*2); }
      for(let yy=ry+16;yy<y-12;yy+=14)for(let xx=left+17;xx<left+w-12;xx+=18)
        poly(g,[[xx,yy-3],[xx+5,yy],[xx,yy+3],[xx-5,yy]],colors[1]);
      for(let xx=left+8;xx<left+w-6;xx+=5){line(g,[[xx,ry-3],[xx,ry+1]],colors[1],1);line(g,[[xx,y-1],[xx,y+3]],colors[1],1);}
      return;
    }
    if (family === 'junction') {
      const cy = y - h / 2;
      const arms = type === 'loop' ? 4 : type === 'filter' ? 3 : type === 'airlock' ? 2 : 4;
      for(let a=0;a<arms;a++){const angle=a*Math.PI*2/arms;line(g,[[cx+Math.cos(angle)*w*.12,cy+Math.sin(angle)*h*.12],[cx+Math.cos(angle)*w*.46,cy+Math.sin(angle)*h*.44]],C.ink,6);line(g,[[cx+Math.cos(angle)*w*.12,cy+Math.sin(angle)*h*.12],[cx+Math.cos(angle)*w*.46,cy+Math.sin(angle)*h*.44]],C.copper,3);}
      oval(g,cx,cy+2,w*.27,h*.31,C.ink);oval(g,cx,cy,w*.27,h*.31,C.bone,C.copper);oval(g,cx,cy,w*.15,h*.16,C.dark);
      const symbol = type==='splitter'?[[0,3],[0,-3],[-4,0],[0,-3],[4,0]]:type==='merger'?[[0,-3],[0,3],[-4,0],[0,3],[4,0]]:type==='filter'?[[-4,0],[0,-3],[4,0],[0,3],[-4,0]]:type==='joiner'?[[-3,-2],[3,-2],[3,2],[-3,2],[-3,-2]]:null;
      if(symbol)line(g,symbol.map(q=>[cx+q[0],cy+q[1]]),C.gold,1);
      else if(type==='loop')oval(g,cx,cy,4,3,null,C.gold);
      else{line(g,[[cx-3,cy-3],[cx-3,cy+3]],C.gold,2);line(g,[[cx+3,cy-3],[cx+3,cy+3]],C.gold,2);}
      return;
    }
    if(family==='cable'||family==='ladder'){
      const yy=y-f.tileH/2;
      for(const d of [-5,5])line(g,[[left,yy+d],[left+w*.3,yy+d+2],[left+w*.7,yy+d-2],[left+w,yy+d]],C.ink,5);
      for(const d of [-5,5])line(g,[[left,yy+d],[left+w*.3,yy+d+2],[left+w*.7,yy+d-2],[left+w,yy+d]],family==='ladder'?C.shade:C.copper,2);
      for(let xx=left+5;xx<left+w;xx+=family==='ladder'?9:15)line(g,[[xx,yy-6],[xx,yy+6]],family==='ladder'?C.bone:C.dark,2);
      return;
    }
    if(family==='hazard'){
      const yy=y-f.tileH*.75;poly(g,[[left+6,yy],[left+w-6,yy],[left+w,yy+6],[left+w,y-5],[left+w-6,y],[left+6,y],[left,y-5],[left,yy+6]],C.dark,C.copper);
      for(let xx=left+3;xx<left+w-4;xx+=9)poly(g,[[xx,yy+2],[xx+5,yy+2],[xx+2,yy+7],[xx-2,yy+7]],C.gold);return;
    }
    if(family==='mug'||family==='coffee'){
      const cy=y-10;if(family==='coffee'){fill(g,C.dark,cx-9,y-4,18,4);poly(g,[[cx-7,y-7],[cx-6,y-25],[cx+6,y-25],[cx+7,y-7]],C.bone,C.copper);oval(g,cx,y-25,7,3,C.dark,C.gold);fill(g,C.glass,cx-3,y-20,6,9);line(g,[[cx+7,y-20],[cx+11,y-20],[cx+11,y-13],[cx+7,y-13]],C.copper,2);}
      else{oval(g,cx+6,cy+1,4,4,null,C.bone);poly(g,[[cx-6,cy-4],[cx+6,cy-4],[cx+5,cy+6],[cx-4,cy+6]],C.bone,C.ink);oval(g,cx,cy-4,6,3,C.cream);oval(g,cx,cy-4,4,2,C.copper);}
      return;
    }
    if(family==='books'){
      const cols=[C.copper,C.cloth,C.bone];for(let i=0;i<(type==='research_papers'?2:3);i++){const xx=cx-9+i%2*2,yy=y-5-i*5;poly(g,[[xx,yy-4],[xx+16,yy-6],[xx+20,yy-3],[xx+3,yy]],cols[i]);fill(g,C.cream,xx+3,yy,17,2);line(g,[[xx,yy-4],[xx,yy+1],[xx+3,yy+2]],C.ink,1);}return;
    }
    if(family==='lamp'){
      oval(g,cx,y-3,8,3,C.dark,C.copper);line(g,[[cx,y-4],[cx-2,y-18],[cx+8,y-28]],C.copper,3);
      poly(g,[[cx+3,y-30],[cx+10,y-31],[cx+16,y-23],[cx,y-23]],C.bone,C.ink);oval(g,cx+8,y-23,7,2,C.light);return;
    }
    if(family==='stool'){
      for(const dx of [-7,7])line(g,[[cx+dx*.6,y-16],[cx+dx,y-2]],C.copper,3);line(g,[[cx,y-17],[cx+1,y-3]],C.shade,3);
      oval(g,cx,y-17,11,5,C.dark);oval(g,cx,y-19,11,5,C.cloth,C.gold);return;
    }
    if(family==='guitar'){
      oval(g,cx-2,y-12,10,9,C.copper,C.ink);oval(g,cx+1,y-23,7,7,C.copper,C.ink);line(g,[[cx+1,y-20],[cx+8,y-48]],C.bone,5);fill(g,C.dark,cx+6,y-51,6,7);oval(g,cx-1,y-20,4,4,C.dark);line(g,[[cx-3,y-6],[cx+9,y-48]],C.gold,1);return;
    }
    if(family==='telescope'){
      for(const dx of [-13,0,13])line(g,[[cx,y-22],[cx+dx,y-2]],C.copper,3);
      line(g,[[cx-14,y-27],[cx+15,y-44]],C.ink,15);line(g,[[cx-14,y-29],[cx+15,y-46]],C.bone,11);
      oval(g,cx+16,y-47,7,9,C.dark,C.copper);oval(g,cx+16,y-47,4,6,C.teal);return;
    }
    if(family==='exercise'){
      if(type.startsWith('punchbag')){line(g,[[cx,y-h+3],[cx,y-34]],C.copper,2);poly(g,[[cx-8,y-37],[cx+8,y-37],[cx+11,y-13],[cx+7,y-6],[cx-7,y-6],[cx-11,y-13]],C.red,C.ink);line(g,[[cx-6,y-32],[cx+6,y-32]],C.gold,2);}
      else{for(const dx of [-w*.3,w*.3])line(g,[[cx+dx,y-23],[cx+dx,y]],C.copper,4);poly(g,[[left+3,y-24],[left+w-3,y-24],[left+w,y-15],[left,y-15]],C.cloth,C.ink);line(g,[[left,y-37],[left+w,y-37]],C.shade,3);for(const x of [left+4,left+w-4])oval(g,x,y-37,5,10,C.dark,C.copper);}return;
    }
    if(family==='modelship'){
      poly(g,[[cx,y-26],[cx+6,y-15],[cx+20,y-7],[cx+15,y-3],[cx+4,y-8],[cx,y-4],[cx-4,y-8],[cx-15,y-3],[cx-20,y-7],[cx-6,y-15]],C.bone,C.copper);fill(g,C.teal,cx-2,y-18,4,7);return;
    }
    if(family==='vent'){
      oval(g,cx,y-9,13,7,C.ink,C.copper);for(let x=-8;x<=8;x+=4)line(g,[[cx+x,y-13],[cx+x,y-5]],C.shade,2);return;
    }
    if(family==='pet'){
      poly(g,[[cx-9,y-3],[cx-8,y-13],[cx-4,y-19],[cx-1,y-14],[cx+4,y-15],[cx+9,y-20],[cx+9,y-10],[cx+5,y-3]],C.teal,C.glass);line(g,[[cx-8,y-6],[cx-14,y-9],[cx-16,y-16]],C.copper,2);fill(g,C.light,cx+3,y-12,2,2);return;
    }
    if(family==='easel'){
      line(g,[[cx,y-h],[left+4,y]],C.copper,4);line(g,[[cx,y-h],[left+w-4,y]],C.copper,4);poly(g,[[left+5,top+8],[left+w-5,top+8],[left+w-8,y-15],[left+8,y-15]],C.cream,C.copper);line(g,[[left+4,y-13],[left+w-4,y-13]],C.gold,3);return;
    }
    if(family==='gaming-table'){
      for(const dx of [-w*.3,w*.3])line(g,[[cx+dx,y-13],[cx+dx,y]],C.copper,5);
      oval(g,cx,y-24,w*.5,Math.min(27,h*.35),C.copper,C.ink);oval(g,cx,y-25,w*.43,Math.min(22,h*.29),C.leaf,C.gold);
      if(type==='pokertable'){for(let i=0;i<5;i++)fill(g,i===3?C.red:C.cream,cx-16+i*7,y-29,5,8);}
      else{for(const [dx,dy]of[[-w*.34,-3],[w*.34,-3],[0,13]])oval(g,cx+dx,y-24+dy,3,2,C.dark);oval(g,cx-12,y-25,2,2,C.cream);oval(g,cx+9,y-28,2,2,C.gold);line(g,[[cx-20,y-36],[cx+25,y-13]],C.bone,1);}return;
    }
    // Asset-load failure remains a recognizable unmapped supply pod, not a
    // silent legacy-art fallback. create().failures tells the client what failed.
    const rw=Math.min(w,42);poly(g,[[cx-rw/2+5,y-28],[cx+rw/2-5,y-28],[cx+rw/2,y-22],[cx+rw/2,y-5],[cx+rw/2-5,y],[cx-rw/2+5,y],[cx-rw/2,y-5],[cx-rw/2,y-22]],C.bone,C.ink);
    line(g,[[cx-rw/2+3,y-9],[cx+rw/2-3,y-9]],C.copper,3);oval(g,cx,y-20,6,4,C.dark,C.gold);
  }

  function variantDetails(g, spec, f, p) {
    const x=f.cx,y=f.anchorY,w=f.w,h=f.h,type=p.t;
    if(spec.family==='workstation'&&['desk2','console','consoleL','pixelrig'].includes(type)){
      const n=type==='desk2'?2:1;for(let i=0;i<n;i++){const px=x+(i?1:-1)*w*.32,py=y-h*.74;
        line(g,[[px,py+14],[px,py+4]],C.copper,2);poly(g,[[px-10,py-6],[px+9,py-6],[px+11,py+5],[px-8,py+5]],C.dark,C.bone);line(g,[[px-6,py-2],[px+6,py-2]],C.teal,1);}
    }
    if(spec.family==='memory'&&spec.variant){for(let i=0;i<Math.min(3,spec.variant);i++)line(g,[[x-w*.34,y-h*.62+i*7],[x-w*.46,y-h*.52+i*7],[x-w*.42,y-h*.34+i*3]],C.copper,2);}
    if(spec.family==='cabinet'&&['safe','vault'].includes(type)){oval(g,x,y-h*.43,Math.min(12,w*.15),Math.min(12,w*.15),C.dark,C.gold);for(let a=0;a<4;a++){const aa=a*Math.PI/2;line(g,[[x,y-h*.43],[x+Math.cos(aa)*8,y-h*.43+Math.sin(aa)*8]],C.copper,2);}}
    if(spec.family==='dish'&&type==='comms_beacon')line(g,[[x,y-h*.85],[x,y-h-12],[x-6,y-h-7],[x+6,y-h-7]],C.copper,2);
    if(spec.family==='reactor'&&type==='connector_portal'){oval(g,x,y-h*.58,w*.36,h*.3,null,C.teal);oval(g,x,y-h*.58,w*.43,h*.34,null,C.copper);}
    if(spec.family==='outbox'&&type==='bay'){poly(g,[[x-9,y-h*.82],[x+9,y-h*.82],[x+11,y-h*.65],[x-11,y-h*.65]],C.dark,C.bone);oval(g,x,y-h*.73,4,4,C.gold);}
    if(spec.family==='display'&&type==='whiteboard')poly(g,[[x-w*.32,y-h*.79],[x+w*.3,y-h*.84],[x+w*.3,y-h*.42],[x-w*.32,y-h*.37]],C.bone,C.copper);
    if(spec.family==='crate'&&type==='goldcrate')line(g,[[x-w*.28,y-h*.55],[x+w*.25,y-h*.68],[x+w*.25,y-h*.2]],C.gold,3);
  }
  function loadImage(url) {
    return new Promise((resolve,reject)=>{const im=new Image();const timer=setTimeout(()=>reject(new Error('Image timeout')),12000);
      im.onload=()=>{clearTimeout(timer);resolve(im);};im.onerror=()=>{clearTimeout(timer);reject(new Error('Image unavailable'));};im.src=url;});
  }
  async function create(options = {}) {
    const rawBase=options.baseUrl || scriptBase+'assets/props/';
    const base=rawBase.endsWith('/')?rawBase:rawBase+'/';
    const manifest=options.manifest || await fetch(base+'manifest.json').then(r=>{if(!r.ok)throw new Error('Prop manifest unavailable');return r.json();});
    const entries=new Map((manifest.assets||[]).map(e=>[e.name,e])),images=new Map(),failures=[];
    const loader=options.loadImage || loadImage;
    await Promise.all(MASTERS.map(async name=>{const entry=entries.get(name);try{if(!entry)throw new Error('Missing manifest entry');images.set(name,await loader(base+entry.file));}catch(_){failures.push(name);}}));
    function drawProp(ctx,p,time=0,state={}) {
      if(!ctx||!p)return null;
      const spec=getSpec(p.t),entry=entries.get(spec.family),im=images.get(spec.family),f=bounds(p,spec,entry,state);
      ctx.save();ctx.imageSmoothingEnabled=false;
      if(!spec.flat&&!p.host){ctx.globalAlpha=.27;oval(ctx,f.cx,f.floorY-2,Math.max(5,f.tileW*.38),Math.min(9,f.tileH*.2),C.shadow);ctx.globalAlpha=1;}
      if(state.selected===true)selection(ctx,p,f);
      if(im){for(let i=0;i<f.count;i++){const cx=f.x+f.unitW*(i+.5),mirror=!!p.m !== (f.rotation===1||f.rotation===2);
        ctx.save();if(mirror){ctx.translate(cx*2,0);ctx.scale(-1,1);}const crop=f.crop;
        ctx.drawImage(im,crop.x,crop.y,crop.w,crop.h,Math.round(cx-f.unitW/2),Math.round(f.y),Math.round(f.unitW),Math.round(f.h));ctx.restore();}
        variantDetails(ctx,spec,f,p);
      }else drawOriginal(ctx,spec,f,p);
      // Animation is conditional on observed harness work supplied by the caller.
      // Static colored lenses in the art are materials; no arbitrary idle machine
      // animation, progress, job counters or pretend activity is introduced here.
      if(state.working===true){const pulse=.6+.4*Math.sin(finite(time,0)/190);ctx.globalAlpha=pulse;
        line(ctx,[[f.cx-8,f.anchorY+1],[f.cx+8,f.anchorY+1]],C.light,2);ctx.globalAlpha=1;}
      drawFacing(ctx,p,f,state.selected===true);ctx.restore();return f;
    }
    return Object.freeze({drawProp,getSpec,catalog,TILE,ready:failures.length===0,failures:Object.freeze(failures),
      masterCount:images.size,manifest,getBounds:(p,state)=>bounds(p,getSpec(p.t),entries.get(getSpec(p.t).family),state)});
  }
  return Object.freeze({create,getSpec,catalog,TILE,MASTERS,GROUPS,bounds,rotationOf});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=NextArt;
