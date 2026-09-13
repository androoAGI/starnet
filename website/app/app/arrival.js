/* The Arrival — bounded cinematic presentation, never task or model-loading telemetry.
   A pure timeline and deterministic canvas renderer shared by the station and replay preview. */
'use strict';
const Arrival = (() => {
  const DURATION = 24000;
  const clamp = x => Math.max(0, Math.min(1, x));
  const smooth = x => { x = clamp(x); return x*x*(3-2*x); };
  const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  function frame(ms, reduced) {
    const t = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    const clock = reduced ? t * 4 : t;
    return { t: clock / 1000, done: clock >= DURATION,
      phase: clock < 3500 ? 'SIGNAL' : clock < 8500 ? 'CONVERGENCE' : clock < 15500 ? 'EMBODIMENT' : clock < 18500 ? 'ARRIVAL' : clock < 21500 ? 'FIRST CONTACT' : 'FIRST LIGHT',
      gather: smooth((clock-2500)/7000), assemble: smooth((clock-8500)/7000),
      land: smooth((clock-15500)/2300), settle: smooth((clock-20500)/3500),
      body: clock < 17500 ? 0 : smooth((clock-17500)/1000),
      darkness: .97 - .78*smooth((clock-15500)/8500) };
  }
  function draw(ctx, input) {
    const { width:w, height:h, x, y, scale:s = 3, sprite, reduced = false } = input;
    const f = frame(input.elapsed, reduced), t = f.t;
    const color = input.color || '#ffad67';
    const unit = Math.max(1, Math.min(w, h)/700), radius = Math.min(w,h)*.3;
    const fade = 1-f.settle;
    ctx.save(); ctx.setTransform(1,0,0,1,0,0);
    // Wide quiet framing, a localized cold shadow rather than a full-screen flash.
    const shade=ctx.createRadialGradient(x,y-40*s,18*s,x,y-15*s,Math.max(w,h)*.72);
    shade.addColorStop(0,'rgba(2,6,12,0)'); shade.addColorStop(1,`rgba(1,3,8,${.65*fade})`);
    ctx.fillStyle=shade;ctx.fillRect(0,0,w,h);
    if (!reduced) {
      // Fine radial interference: the room appears to strain around an impossible focal point.
      ctx.globalCompositeOperation='screen';ctx.strokeStyle=color;
      for(let i=0;i<54;i++) {
        const a=hash(i+9)*Math.PI*2, r=radius*(.35+hash(i+17)*1.4);
        const contraction=1-f.gather*.72;
        const ax=x+Math.cos(a)*r*contraction, ay=y-30*s+Math.sin(a)*r*.6*contraction;
        ctx.globalAlpha=(.06+.24*f.gather)*(1-f.land)*(.5+.5*Math.sin(t*1.4+i));
        ctx.lineWidth=unit;
        ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(ax+Math.cos(a)*r*.22,ay+Math.sin(a)*r*.13);ctx.stroke();
      }
      // Orbital splinters travel in coherent spirals, each leaving a short, curved trail.
      for(let i=0;i<210;i++) {
        const seed=hash(i+51), cycle=(t*(.09+seed*.07)+hash(i+1))%1;
        const r=(1-cycle)*radius*(.4+seed)*Math.max(.06,1-f.assemble*.94);
        const a=hash(i+4)*6.283+t*(.1+seed*.23)+cycle*1.8;
        const py=y-28*s+Math.sin(a)*r*.55-(1-f.gather)*seed*30;
        const px=x+Math.cos(a)*r;
        ctx.globalAlpha=(.12+.7*cycle)*smooth(t/3)*(1-f.land);
        ctx.fillStyle=i%6===0?'#d4f7ff':color;
        const size=(i%7===0?3:1)*unit;
        ctx.fillRect(Math.round(px),Math.round(py),size,size);
        if(i%3===0){ctx.strokeStyle=color;ctx.globalAlpha*=.22;ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px-Math.cos(a)*12*unit,py-Math.sin(a)*6*unit);ctx.stroke();}
      }
    }
    // A signal slit grows vertically, then opens into a luminous, imperfect aperture.
    const aperture=smooth((t-2)/7)*(1-f.land);
    ctx.globalCompositeOperation='screen';ctx.globalAlpha=fade;
    const halo=ctx.createRadialGradient(x,y-30*s,0,x,y-30*s,Math.max(1,70*s*aperture+12));
    halo.addColorStop(0,`rgba(139,205,255,${.12+.15*aperture})`);halo.addColorStop(.4,`rgba(53,119,170,${.08*aperture})`);halo.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=halo;ctx.fillRect(x-100*s,y-130*s,200*s,200*s);
    ctx.strokeStyle=color;
    const reach=(4+42*aperture)*s;
    ctx.lineWidth=unit;ctx.globalAlpha=(.25+.4*aperture)*(1-f.land);
    ctx.beginPath();ctx.moveTo(x,y-30*s-reach);ctx.lineTo(x,y-30*s+reach);ctx.stroke();
    // Nested contours form the edge of the breach: a narrow mouth with depth,
    // offset refractions, and light catching its rim as it opens around the body.
    const breach=smooth((t-3.5)/6)*(1-f.land);
    if(breach>0){
      const height=(22+45*breach)*s, cy=y-33*s;
      ctx.globalCompositeOperation='screen';
      for(let layer=0;layer<9;layer++){
        const wide=(5+layer*3.3)*s*breach;
        ctx.strokeStyle=layer%3===0?'#c4edff':color;
        ctx.globalAlpha=(.10+(8-layer)*.035)*breach;
        ctx.lineWidth=(layer===0?2.2:1)*unit;
        ctx.beginPath();
        for(let j=0;j<=90;j++){
          const a=j/90*6.283;
          const wave=reduced?0:Math.sin(a*5+t*.7+layer*.8)*2.5*s*breach;
          const px=x+Math.sin(a)*(wide+wave),py=cy+Math.cos(a)*(height+layer*1.7*s);
          if(!j)ctx.moveTo(px,py);else ctx.lineTo(px,py);
        }ctx.stroke();
      }
      // A pair of much larger incomplete orbital paths connects the breach to the room.
      if(!reduced)for(let k=0;k<3;k++){
        ctx.strokeStyle=k%2?color:'#7fbfdc';ctx.globalAlpha=.18*breach;ctx.lineWidth=unit;
        ctx.beginPath();ctx.ellipse(x,cy,(50+k*18)*s,(14+k*8)*s,-.7+k*.65,t*.14+k,t*.14+k+4.6);ctx.stroke();
      }
      // Soft light spreading along the floor gives the arrival a physical footprint.
      ctx.save();ctx.translate(x,y);ctx.scale(1,.3);
      const spill=ctx.createRadialGradient(0,0,4,0,0,100*s);
      spill.addColorStop(0,`rgba(114,202,255,${.30*breach})`);spill.addColorStop(.3,`rgba(78,140,185,${.18*breach})`);spill.addColorStop(1,'rgba(0,0,0,0)');
      ctx.globalAlpha=1;ctx.fillStyle=spill;ctx.fillRect(-100*s,-100*s,200*s,200*s);ctx.restore();
    }
    // Interrupted floor ellipses read as a physical landing site, not a loading indicator.
    for(let ring=0;ring<4;ring++) {
      const r=(16+ring*10)*s*(.3+.7*f.gather);
      ctx.globalAlpha=(.08+.18*f.gather)*(1-f.settle)*(ring===0?1:.65);
      ctx.lineWidth=unit*(ring===0?1.4:.6);
      for(let k=0;k<5;k++) {
        const a=k*1.256+(reduced?0:t*.05*(ring%2?1:-1));
        ctx.beginPath();ctx.ellipse(x,y+2*s,r,r*.29,0,a,a+.85);ctx.stroke();
      }
    }
    // Assemble the actual selected skin from depth-separated pixel fragments.
    ctx.globalCompositeOperation='source-over';ctx.imageSmoothingEnabled=false;
    if(sprite && t>=7 && f.body<1) {
      for(let row=0;row<12;row++)for(let col=0;col<8;col++) {
        const i=row*8+col, delay=hash(i+112)*.26;
        const p=smooth((f.assemble-delay)/(.74));
        const visibility=smooth((t-7-delay*6)/3);
        if(!visibility)continue;
        const a=hash(i+101)*6.283;
        const distance=reduced?0:(1-p)*(55+hash(i+29)*160)*unit;
        const dx=x+(col*8-32)*s+Math.cos(a)*distance;
        const dy=y+(row*8-80)*s+Math.sin(a)*distance*.6-(1-f.land)*9*s;
        ctx.globalAlpha=visibility*(.12+.88*p)*(1-f.body);
        ctx.drawImage(sprite,32+col*8,20+row*8,8,8,dx,dy,8*s,8*s);
        if(p>.1&&p<.96&&!reduced){ctx.strokeStyle=color;ctx.globalAlpha=.12*(1-p);ctx.strokeRect(dx,dy,8*s,8*s);}
      }
    }
    // One expansive landing ripple. No repeated flashing or camera shake.
    const impact=clamp((t-15.8)/3.2);
    if(t>=15.8&&impact<1) {
      ctx.globalCompositeOperation='screen';ctx.strokeStyle='#d7f4ff';
      for(let k=0;k<3;k++) {
        const p=clamp(impact-k*.09),r=(18+p*(reduced?45:240))*s;
        ctx.globalAlpha=(1-impact)*.36/(k+1);ctx.lineWidth=(2-k*.45)*unit;
        ctx.beginPath();ctx.ellipse(x,y+2*s,r,r*.3,0,0,6.283);ctx.stroke();
      }
    }
    // Residual point lights fade while the station's own lighting takes over.
    ctx.globalCompositeOperation='screen';ctx.fillStyle=color;
    for(let i=0;i<18;i++) {
      const a=i/18*6.283,r=24*s;
      ctx.globalAlpha=f.land*(1-f.settle)*.35;
      ctx.fillRect(x+Math.cos(a)*r,y+Math.sin(a)*r*.29,unit*2,unit);
    }
    ctx.restore();return f;
  }
  return { DURATION, frame, draw };
})();
if(typeof module!=='undefined'&&module.exports)module.exports=Arrival;
