/* test/path-smoothing.test.js — guards the string-pulling smoother in worldmodel.js path().

   path() is a 4-neighbour BFS whose raw output is a staircase of orthogonal tile hops. We smooth it
   (keep the farthest waypoint with clear line of sight, drop the rest) so bodies walk long straight
   runs and true diagonals instead of pivoting 90° at every tile. The danger of any such shortcut is
   that it cuts a corner THROUGH a blocker.

   This test checks that INDEPENDENTLY of how losClear walks the line: it densely samples every
   segment between consecutive waypoints and asks walkable() about the tile under each sample. A
   smoother that clips a wall — or that squeezes through the diagonal gap between two blockers —
   trips this even though its own Bresenham walk thought the segment was clear.

   The model is pure (no DOM / no ambient time or RNG), so it loads with a plain require(). */
'use strict';
const A = require('./_assert.js');
const WM = require('../frontend/app/worldmodel.js');

/* ---- a station with rooms, corridors and scattered blockers (corners + pinch points) ---- */
const s = WM.create();
s.addRoom({ kind: 'lab', rect: { x1: 20, y1: 0, x2: 30, y2: 12 } });
s.placeHallway({ rect: { x1: 18, y1: 3, x2: 19, y2: 4 } });
s.addRoom({ kind: 'storage', rect: { x1: 20, y1: 16, x2: 30, y2: 26 } });
s.placeHallway({ rect: { x1: 24, y1: 13, x2: 25, y2: 15 } });
for (const [x, y] of [[22, 4], [23, 4], [24, 4], [27, 7], [28, 7], [22, 19], [23, 19], [26, 21], [5, 5], [6, 5], [7, 5]]) {
  s.addProp({ t: 'desk', x, y, w: 1, h: 1 });
}

const geo = s.projectGeometry();
const { COLS, ROWS, walkable, path } = geo;

const cells = [];
for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (walkable(x, y, null)) cells.push({ x, y });
A.ok(cells.length > 100, 'fixture station has a substantial walkable area');

/* deterministic pair sampling — the gate must not depend on Math.random */
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const SAMPLES = 120;
let tested = 0, diagonal = 0, violations = 0, endpointMiss = 0, waypoints = 0, manhattan = 0;

for (let n = 0; n < 1200; n++) {
  const a = cells[Math.floor(rnd() * cells.length)];
  const b = cells[Math.floor(rnd() * cells.length)];
  const p = path(a.x, a.y, b.x, b.y, null);
  if (!p || !p.length) continue;
  tested++;
  waypoints += p.length;
  manhattan += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

  let px = a.x, py = a.y;
  for (const w of p) {
    const dx = w.x - px, dy = w.y - py;
    if (dx !== 0 && dy !== 0) diagonal++;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      if (!walkable(Math.round(px + dx * t), Math.round(py + dy * t), null)) { violations++; break; }
    }
    px = w.x; py = w.y;
  }
  if (px !== b.x || py !== b.y) endpointMiss++;
}

A.ok(tested > 500, 'enough reachable pairs exercised (' + tested + ')');
A.eq(violations, 0, 'no smoothed segment ever crosses an unwalkable tile');
A.eq(endpointMiss, 0, 'every smoothed path still ends exactly on its target tile');
A.ok(diagonal > 0, 'smoothing actually produces diagonal segments (a raw 4-neighbour BFS produces none)');
A.ok(waypoints < manhattan, 'smoothing strictly reduces waypoint count vs the orthogonal staircase');

console.log('  ' + tested + ' paths, ' + diagonal + ' diagonal segments, '
  + (manhattan / Math.max(1, waypoints)).toFixed(1) + 'x waypoint compression, 0 wall violations');


// Sample the actual bottom-of-tile foot anchor, independently of the route's
// grid traversal. Check room seams as well as missing floor and solid props.
function footViolations(g, start, pts) {
  let from = start, bad = 0;
  for (const to of pts || []) {
    let prev = from;
    const samples = Math.max(240, (Math.abs(to.x-from.x)+Math.abs(to.y-from.y))*24);
    for (let i=1; i<=samples; i++) {
      const t=i/samples, x=Math.floor(from.x+.5+(to.x-from.x)*t), y=Math.floor(from.y+11/12+(to.y-from.y)*t);
      if (!g.walkable(x,y,null)) bad++;
      if (x!==prev.x && !g.canStep(prev.x,prev.y,x,prev.y)) bad++;
      if (y!==prev.y && !g.canStep(x,prev.y,x,y)) bad++;
      prev={x,y};
    }
    from=to;
  }
  return bad;
}
let feetBad=0;
seed=45;
for(let n=0;n<1600;n++) {
  const a=cells[Math.floor(rnd()*cells.length)], b=cells[Math.floor(rnd()*cells.length)];
  feetBad+=footViolations(geo,a,path(a.x,a.y,b.x,b.y,null));
}
A.eq(feetBad,0,'rendered feet never cross solid doorway seams, void or furniture');

// Execute the world's corner/start/nudge helpers against the real geometry.
const worldSource=require('fs').readFileSync(require('path').join(__dirname,'../frontend/app/world.js'),'utf8');
const helpers=worldSource.slice(worldSource.indexOf('  function startBodyPath('),worldSource.indexOf('  function setPathTo('));
const nudge=worldSource.slice(worldSource.indexOf('  function nudgeBody('),worldSource.indexOf('  /* SLIDE,'));
const runtime=Function('geo','blocked','footOf','tileOf',helpers+nudge+'; return { startBodyPath, canRoundCorner, nudgeBody };')(
  geo,null,(x,y)=>({x:x*12+6,y:y*12+11}),(x,y)=>({x:Math.floor(x/12),y:Math.floor(y/12)}));
let rounded=0,held=0,walkBad=0,arrivals=0;
seed=83;
for(let n=0;n<250;n++) {
  const a=cells[Math.floor(rnd()*cells.length)], dest=cells[Math.floor(rnd()*cells.length)];
  const pts=path(a.x,a.y,dest.x,dest.y,null); if(!pts || !pts.length)continue;
  const b={px:a.x*12+6,py:a.y*12+11}; runtime.startBodyPath(b,pts);
  let prev=a,guard=12000;
  while(b.pathIdx<b.pathPts.length && guard-->0) {
    const wp=b.pathPts[b.pathIdx],tx=wp.x*12+6,ty=wp.y*12+11;
    const d=Math.hypot(tx-b.px,ty-b.py),more=b.pathIdx+1<b.pathPts.length;
    // The engine increments pathIdx when it selects the current waypoint.
    b.pathIdx++; const clear=more && runtime.canRoundCorner(b); b.pathIdx--;
    if(d<1e-6 || (more && d<2.5 && clear)) { if(d>1e-6)rounded++; b.pathIdx++; continue; }
    if(more && d<2.5 && !clear) held++;
    const step=Math.min(.4,d);b.px+=(tx-b.px)/d*step;b.py+=(ty-b.py)/d*step;
    const cur={x:Math.floor(b.px/12),y:Math.floor(b.py/12)};
    if(!geo.walkable(cur.x,cur.y,null))walkBad++;
    if(cur.x!==prev.x || cur.y!==prev.y) {
      const viaX=(cur.x===prev.x || geo.canStep(prev.x,prev.y,cur.x,prev.y)) && (cur.y===prev.y || geo.canStep(cur.x,prev.y,cur.x,cur.y));
      const viaY=(cur.y===prev.y || geo.canStep(prev.x,prev.y,prev.x,cur.y)) && (cur.x===prev.x || geo.canStep(prev.x,cur.y,cur.x,cur.y));
      if(!viaX&&!viaY)walkBad++;
    }
    prev=cur;
  }
  if(guard>0)arrivals++;
}
A.eq(walkBad,0,'early waypoint handoffs stay on floor and cross only real openings');
A.ok(arrivals>200,'corner guards let walkers complete their routes');
A.ok(held>0 && rounded>0,'tight doorway corners wait while open-floor corners stay smooth');
for(const body of ['b','self','agent']) A.ok(worldSource.includes('d < CORNER_LOOK && canRoundCorner('+body+')'),'corner guard is wired for '+body);
const sealed=WM.create();
sealed.addRoom({kind:'lab',rect:{x1:18,y1:0,x2:27,y2:10}});
sealed.addProp({t:'airlock',x:20,y:4,w:1,h:1,block:false,door:'closed'});
const sealedGeo=sealed.projectGeometry();
const sealedRuntime=Function('geo','blocked','footOf','tileOf',helpers+nudge+'; return {startBodyPath,nudgeBody};')(
  sealedGeo,null,(x,y)=>({x:x*12+6,y:y*12+11}),(x,y)=>({x:Math.floor(x/12),y:Math.floor(y/12)}));
let wallPair;
for(const a of cells) {
  const b={x:a.x+1,y:a.y};
  if(sealedGeo.walkable(a.x,a.y,null)&&sealedGeo.walkable(b.x,b.y,null)&&!sealedGeo.canStep(a.x,a.y,b.x,b.y)){wallPair={a,b};break;}
}
A.ok(!!wallPair,'fixture has adjacent walkable tiles separated by a wall');
if(wallPair){
  const {a,b}=wallPair,body={px:(a.x+1)*12-.2,py:a.y*12+11};
  A.eq(sealedRuntime.nudgeBody(body,.4,0),false,'separation cannot shove a body through a solid seam');
  A.eq(sealedGeo.clearFootSegment(body.px,body.py,(b.x+.5)*12,b.y*12+11),false,'pixel segment rejects a wall even though both endpoints are walkable');
}

let reanchor=null;
for(const a of cells) {
  for(const dest of cells.slice(0,100)) {
    const pts=path(a.x,a.y,dest.x,dest.y,null);if(!pts||!pts.length)continue;
    const b={px:a.x*12+.3,py:a.y*12+.3};runtime.startBodyPath(b,pts);
    if(b.pathPts.length>pts.length) {reanchor={a,b,pts};break;}
  }
  if(reanchor)break;
}
A.ok(!!reanchor,'off-anchor initial position exercises the first-leg guard');
if(reanchor){
  const {a,b,pts}=reanchor;
  A.eq(b.pathPts[0].x,a.x,'unsafe initial shortcut first aligns in its own tile (x)');
  A.eq(b.pathPts[0].y,a.y,'unsafe initial shortcut first aligns in its own tile (y)');
  A.ok(geo.clearFootSegment(b.px,b.py,a.x*12+6,a.y*12+11),'alignment leg itself stays inside the current tile');
  A.eq(footViolations(geo,a,pts),0,'the subsequent anchored route remains clear');
}
A.report('path-smoothing');
