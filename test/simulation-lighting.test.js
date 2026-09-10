'use strict';

/* The station should feel warm and comfortable without solving brightness by flattening the
   light model. Lock the color temperature separately from the existing intensity controls so a
   future polish pass cannot drift the pools back toward white or silently reduce readability. */

const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', name), 'utf8');
const bake = read('stationbake.js');
const world = read('world.js');
const build = read('build.js');
const lab = read('crtlab.js');
// Room colour must survive opening a saved custom phosphor theme. The production
// theme round-trip is recorded in qa/digests/2026-09-06-room-colour-parity.md.
const appCss = fs.readFileSync(path.join(__dirname, '..', 'frontend/css/app.css'), 'utf8');
const stageRule = appCss.match(/#stage\s*\{([^}]+)\}/)[1];
A.ok(/filter:\s*saturate\(1\.14\) contrast\(1\.08\) brightness\(0\.94\)/.test(stageRule),
  'station preserves the approved grade independently of theme saturation and hue');
A.ok(!stageRule.includes('--cam-grade'), 'custom UI grade cannot desaturate the live station');
A.eq(appCss, fs.readFileSync(path.join(__dirname, '..', 'website/app/css/app.css'), 'utf8'),
  'website and packaged station use the same colour treatment');

const srgb = v => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = rgb => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
const warm = rgb => rgb[0] - rgb[2];

const oldPool = [250, 236, 206], pool = [246, 224, 188];
const oldGlow = [240, 230, 206], glow = [238, 218, 184];

// 2026-09-02: the six literal stops became ONE constant (POOL_RGB) painted through falloffStops, so
// the room pool, the corridor pool and the lightmap's cut all ride the same curve. The colour lock
// moves to the constant; the two pool sites must still draw through it.
A.ok(/const POOL_RGB = '246,224,188'/.test(bake), 'the warm-neutral pool color is the one POOL_RGB constant');
A.eq((bake.match(/falloffStops\((?:gw|g), POOL_RGB, LIGHT\.floor(?: \* ROOM_FIXTURE_GAIN)?\)/g) || []).length, 2,
  'room and corridor pools both paint POOL_RGB along the shared falloff curve');
A.ok(!/rgba\(246,224,188,' \+ LIGHT\.floor/.test(bake), 'no pool still hand-rolls its own stop list');
A.ok(!/rgba\(250,236,206/.test(bake), 'the near-white floor-pool color no longer ships');
A.ok(!world.includes('drawOverhead('), 'no ceiling pendants are drawn over the room');
A.ok(!bake.includes("b.fillStyle = '#6a6253'"), 'no room lamp mount bars are painted');
A.ok(!bake.includes('// fixture caps +'), 'no corridor ceiling lamp caps are painted');
A.ok(bake.includes("const LAMP_RGB = '255,192,104'"), 'room glow uses saturated golden light');
A.ok(/f\.rgb \|\| '238,218,184'/.test(world), 'simulation uses fixture temperature with the warm fallback');
A.ok(/f\.rgb \|\| '238,218,184'/.test(build), 'REFIT uses the same fixture temperature and fallback');

A.ok(luminance(pool) < luminance(oldPool), 'floor pools are slightly less luminous than before');
A.ok(luminance(pool) > 0.70, 'floor pools retain a bright source color for readable deck contrast');
A.ok(warm(pool) > warm(oldPool), 'floor pools shift warmer rather than merely darker');
A.ok(luminance(glow) < luminance(oldGlow), 'animated shimmer is slightly less luminous than before');
A.ok(luminance(glow) > 0.65, 'animated shimmer remains visible over the ambient mask');
A.ok(warm(glow) > warm(oldGlow), 'animated shimmer shifts warmer rather than merely darker');

/* The shipped light controls, locked so a polish pass can't drift them silently — and so the CRT
   LAB's RESET can never restore a state that never shipped. Dulled 2026-08-15 on Andrew's call
   ("a bit too bright… slightly dull it"). Re-lit 2026-09-02 (the world glow-up): a physical
   falloff curve, a cool shadow plate, a warm film inside each pool, starlight spill, and pools
   with 1.3x reach — measured on a furnished lounge as contrast + colour (mean luma 31 -> 44, lit
   deck 2% -> 7%, chroma 12 -> 22) with the ambient plate itself barely moved (0.82 -> 0.80).
   `pitch` (the fixture grid) did NOT move — dimming that flattens the model instead of dimming
   the room, which is the failure this file exists to prevent. */
/* World overhaul 2026-09-03: the film that puts light ON the deck under a lamp went 0.14 -> 0.3 and the
   deck pool 0.26 -> 0.3, measured on the same furnished lounge as CONTRAST (luma sd 28.8 -> 35+, crushed
   4% -> 2%) — the deck models by light now instead of sitting in one wash. Ambient, cuts, pitch unmoved. */
const lightControls = { ambient: '0.82', pool: '0.85', room: '0.46', corridor: '0.34', door: '0.4', floor: '0.24', crown: '0.45', pitch: '8', reach: '1.3', falloff: '0.85', cool: '0.45', warm: '0.16', spill: '0.7' };
for (const [key, value] of Object.entries(lightControls)) {
  const lock = new RegExp('\\b' + key + ': ' + value.replace('.', '\\.') + '(?:[, }])');
  A.ok(lock.test(bake), 'the shipped ' + key + ' lighting control remains ' + value);
  A.ok(lock.test((lab.match(/const LIGHT_DEFAULTS = \{([^}]+)\}/) || [])[1] || ''), 'the CRT lab reset keeps ' + key + ' at the shipped value');
}

// Run the actual drawing functions: steady across time, cached between frames,
// refreshed after rebake, with canvas state restored for the next layer.
for (const [name, source, end] of [['world', world, '  /* ---- PROP LIGHT'], ['build', build, '  /* ---------- PLACEMENT']]) {
  const code = source.slice(source.indexOf('  const _fixtureGlow ='), source.indexOf(end));
  let allocations = 0, calls = [];
  const ctx = { globalAlpha: 1, createRadialGradient(...coords) {
    allocations++; return { coords, stops: [], addColorStop(...s) { this.stops.push(s); } };
  }, fillRect(...rect) { calls.push({rect, alpha:this.globalAlpha, gradient:this.fillStyle}); } };
  const cache = {origin:{tx:2,ty:3}, flickers:[{x:20,y:30,r:25,rgb:'255,196,120'},{x:60,y:30,r:25}]};
  const draw = new Function('ctx','cache','CRT','T',code+'; return drawGlows;')(ctx,cache,{glow:.13},()=>12);
  draw(0); const first = JSON.stringify(calls); calls=[];
  for (const time of [83,210,1000,5000,30000]) {
    draw(time); A.eq(JSON.stringify(calls),first,name+' fixture image is steady at '+time+'ms'); calls=[];
  }
  A.eq(allocations,2,name+' reuses gradients instead of allocating every frame');
  A.eq(ctx.globalAlpha,1,name+' restores alpha');
  A.eq(ctx.globalCompositeOperation,'source-over',name+' restores compositing');
  cache.flickers=cache.flickers.map(f=>({...f,x:f.x+10}));draw(1);
  A.eq(allocations,4,name+' rebake gets new positioned gradients');
}

const props = read('propsprites.js');
const start = props.indexOf('  function lightOf('), stop = props.indexOf('\n  }',start)+4;
const emission = new Function('EMIT','TILE','SURFACE_RISE','let now=0;'+props.slice(start,stop)+';return (t,f,work,still)=>{now=t;return lightOf(f,work,still);};');
for(const [mode,limit] of [['screen',.031],['pulse',.041],['fire',.101],['steady',0]]) {
  const light = emission({probe:{c:[120,200,255],r:22,a:1,m:mode,y:.3,work:true}},12,8);
  const f={t:'probe',x:4,y:6}; const samples=[];
  for(let t=0;t<=30000;t+=50)samples.push(light(t,f,true,false));
  const alphas=samples.map(l=>l.a);
  A.ok(Math.max(...alphas)-Math.min(...alphas)<=limit,mode+' spill has restrained modulation');
  A.ok(samples.every(l=>l.x===samples[0].x && l.y===samples[0].y),mode+' source stays anchored');
  A.eq(light(100,f,false,false),null,mode+' working source still obeys real activity');
  A.eq(light(100,f,true,true).a,1,mode+' reduced motion stays steady');
}
for(const file of ['world.js','build.js','propsprites.js','stationbake.js','crtlab.js']) {
  A.eq(read(file),fs.readFileSync(path.join(__dirname,'..','website','app','app',file),'utf8'),file+' website parity');
}
A.report('simulation-lighting');
