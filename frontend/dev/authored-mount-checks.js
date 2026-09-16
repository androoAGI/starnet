'use strict';
(async()=>{
  const scale=6,images=new Map(),geometries=new Map();let authored=true,guides=true;
  const fit=(b,c)=>{const s=Math.min(b.width/c.width,b.height/c.height);return{x:b.x+(b.width-c.width*s)/2,y:b.y+b.height-c.height*s,width:c.width*s,height:c.height*s};};
  async function load(key,file,spec,bounds){
    const im=new Image();im.src='../'+file.replace(/^frontend\//,'');await im.decode();
    const cv=document.createElement('canvas');cv.width=im.width;cv.height=im.height;const g=cv.getContext('2d',{willReadFrequently:true});g.drawImage(im,0,0);const bytes=g.getImageData(0,0,im.width,im.height).data;
    let l=im.width,t=im.height,r=-1,b=-1;for(let i=3;i<bytes.length;i+=4)if(bytes[i]){const p=(i-3)/4,x=p%im.width,y=Math.floor(p/im.width);l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x);b=Math.max(b,y);}
    const crop={x:l,y:t,width:r-l+1,height:b-t+1};images.set(key,im);geometries.set(key,{spec,crop,box:fit(bounds,crop)});
  }
  const jobs=[];for(const[id,p]of Object.entries(AuthoredSurfaceCalibration.props))for(const[view,s]of Object.entries(p.views))jobs.push(load(id+':'+view,s.art,{image:s.image,sourceWidth:s.sourceWidth,sourceHeight:s.sourceHeight,footprint:s.footprint},s.bounds));
  jobs.push(load('mug:s','frontend/assets/industrial/batch03/storage/mug.png',{image:'mug.png',sourceWidth:1050,sourceHeight:1027,footprint:{w:1,h:1}},{x:4,y:8,width:4,height:4}));
  // The approved caddy remains an independent child body, with its real alpha
  // dimensions read once. Geometry reflects the root's previous authored view.
  const response=await fetch('../assets/industrial/props-v3/manifest.json');
  if(!response.ok)throw Error('Mount manifest HTTP '+response.status);
  const manifest=await response.json();
  const caddy=manifest.props.industrial_toolcaddy.views.s;
  jobs.push(load('industrial_toolcaddy:s','frontend/assets/industrial/props-v3/'+caddy.image,caddy,caddy.bounds));
  await Promise.all(jobs);
  const engine=AuthoredSurfaceMounts.create({viewGeometry:(t,v)=>geometries.get(t+':'+v),ruleFor:t=>({surface:!!AuthoredSurfaceCalibration.props[t]})});
  const cases=[];
  for(const[id,p]of Object.entries(AuthoredSurfaceCalibration.props))for(const[view,s]of Object.entries(p.views))for(const m of view==='e'?[0,1]:[0]){
    const host={id:'host',t:id,x:0,y:0,w:s.footprint.w,h:s.footprint.h,r:view==='e'?3:0,m};
    const children=[];for(let y=0;y<host.h;y++)for(let x=0;x<host.w;x++)children.push({id:`child-${x}-${y}`,t:x===host.w-1&&host.h===1?'industrial_toolcaddy':'mug',x,y,w:1,h:1});
    const article=document.createElement('article'),h=document.createElement('h2'),canvas=document.createElement('canvas'),pre=document.createElement('pre');h.textContent=id+' / '+view.toUpperCase()+(m?' mirrored':'');canvas.width=390;canvas.height=330;article.append(h,canvas,pre);document.querySelector('#cases').append(article);cases.push({host,children,canvas,pre});
  }
  function drawProp(g,p,lift=0){const view=p.r===3?'e':'s',key=p.t+':'+view,d=geometries.get(key),im=images.get(key);g.save();g.translate(p.x*12,p.y*12-lift);if(p.m){g.translate(p.w*12,0);g.scale(-1,1);}g.drawImage(im,d.crop.x,d.crop.y,d.crop.width,d.crop.height,d.box.x,d.box.y,d.box.width,d.box.height);g.restore();}
  function paint(){let checked=0;for(const c of cases){const g=c.canvas.getContext('2d');g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,c.canvas.width,c.canvas.height);g.translate(70,48);g.scale(scale,scale);g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';
      engine.setLayout([c.host,...c.children]);drawProp(g,c.host);const support=engine.supportFor(c.host);if(guides&&support){g.strokeStyle='#9ebca780';g.lineWidth=.14;g.beginPath();support.points.forEach((p,i)=>i?g.lineTo(...p):g.moveTo(...p));g.closePath();g.stroke();}
      const results=c.children.map(p=>({p,placement:engine.placementFor(p)}));for(const{p,placement:a}of results){drawProp(g,p,authored?a.lift:8);if(a.authored){checked++;if(guides){g.fillStyle='#a6d7b4';g.fillRect(a.target.x-.16,a.target.y-.16,.32,.32);}}}
      c.pre.textContent=results.map(({p,placement:a})=>`${p.t} row ${p.y+1}: ${a.authored?a.lift.toFixed(3)+' px lift':a.reason}`).join('\n');}
    document.querySelector('#receipt').textContent=`${checked} mounted source placements rendered across ${cases.length} view/mirror cases. Mode: ${authored?'authored support':'legacy fixed lift comparison'}.`;
  }
  document.querySelector('#authored').onclick=()=>{authored=true;document.querySelector('#authored').setAttribute('aria-pressed','true');document.querySelector('#legacy').setAttribute('aria-pressed','false');paint();};
  document.querySelector('#legacy').onclick=()=>{authored=false;document.querySelector('#authored').setAttribute('aria-pressed','false');document.querySelector('#legacy').setAttribute('aria-pressed','true');paint();};
  document.querySelector('#guides').onclick=()=>{guides=!guides;document.querySelector('#guides').setAttribute('aria-pressed',String(guides));paint();};paint();
})().catch(e=>{document.querySelector('#receipt').textContent='Fixture failed: '+e.message;});
