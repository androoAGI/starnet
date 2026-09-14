/* Mechanical separation of NEW authored hanging furniture only. Pixel selection
   happens once in prepare; frames only blit cached artwork. No legacy painters. */
'use strict';
const AuthoredFurnitureMotion=(()=>{
  const entries=new Map(),DENSITY=4,MAX_CACHED_PIXELS=256*1024;
  let cachedPixels=0;
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const point=p=>Array.isArray(p)&&p.length===2&&p.every(n=>finite(n)&&n>=0&&n<=1);
  const valid=c=>c&&[c.sourceWidth,c.sourceHeight].every(n=>Number.isInteger(n)&&n>0&&n<=4096)&&
    point(c.pivot)&&Array.isArray(c.region)&&c.region.length>=3&&c.region.length<=20&&c.region.every(point)&&
    finite(c.period)&&c.period>=500&&c.period<=30000&&finite(c.ambientAngle)&&c.ambientAngle>=0&&c.ambientAngle<=.2&&
    finite(c.workAngle)&&c.workAngle>=c.ambientAngle&&c.workAngle<=.25&&c.bounds&&[c.bounds.x,c.bounds.y,c.bounds.width,c.bounds.height].every(finite)&&
    c.bounds.width>0&&c.bounds.height>0&&c.bounds.width<=96&&c.bounds.height<=96;
  const inside=(x,y,p)=>{let hit=false;for(let i=0,j=p.length-1;i<p.length;j=i++)if((p[i][1]>y)!==(p[j][1]>y)&&x<(p[j][0]-p[i][0])*(y-p[i][1])/(p[j][1]-p[i][1])+p[i][0])hit=!hit;return hit;};
  const defaultCanvas=(w,h)=>{const cv=document.createElement('canvas');cv.width=w;cv.height=h;return cv;};
  function prepare(id,image,canvasFactory,configuration){
    const c=configuration||(typeof AuthoredFurnitureConfig!=='undefined'&&AuthoredFurnitureConfig.get(id));
    if(!valid(c)||!image||image.complete===false||(image.naturalWidth||image.width)!==c.sourceWidth||(image.naturalHeight||image.height)!==c.sourceHeight)return false;
    const make=canvasFactory||defaultCanvas,scale=Math.min(c.bounds.width/c.sourceWidth,c.bounds.height/c.sourceHeight)*DENSITY;
    const width=Math.ceil(c.sourceWidth*scale),height=Math.ceil(c.sourceHeight*scale),cost=width*height*3,previous=entries.get(id);
    if(cachedPixels-(previous?previous.cost:0)+cost>MAX_CACHED_PIXELS)return false;
    try{
      const source=make(c.sourceWidth,c.sourceHeight),sg=source.getContext('2d');if(!sg) return false;
      sg.drawImage(image,0,0);const original=make(width,height),og=original.getContext('2d');if(!og)return false;
      og.imageSmoothingEnabled=true;og.imageSmoothingQuality='high';og.drawImage(source,0,0,width,height);
      const raw=sg.getImageData(0,0,source.width,source.height),moving=sg.createImageData(source.width,source.height);moving.data.set(raw.data);
      let selected=0;
      for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
        const i=(y*source.width+x)*4+3,hit=inside((x+.5)/source.width,(y+.5)/source.height,c.region);
        if(hit){if(raw.data[i])selected++;raw.data[i]=0;}else moving.data[i]=0;
      }
      if(!selected)return false;
      const stationary=make(width,height),part=make(width,height);
      for(const [canvas,data]of [[stationary,raw],[part,moving]]){
        const g=canvas.getContext('2d');if(!g)return false;sg.putImageData(data,0,0);g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.drawImage(source,0,0,width,height);
      }
      const config=JSON.parse(JSON.stringify(c));entries.set(id,{config,original,stationary,part,cost,selected});
      cachedPixels+=cost-(previous?previous.cost:0);return true;
    }catch(_){return false;}
  }
  function space(c,box){
    if(!box||![box.x,box.y,box.width,box.height].every(finite)||box.width<=0||box.height<=0)return null;
    const crop=box.crop||{x:0,y:0,width:c.sourceWidth,height:c.sourceHeight};
    if(![crop.x,crop.y,crop.width,crop.height].every(finite)||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>c.sourceWidth||crop.y+crop.height>c.sourceHeight)return null;
    const s=box.width/crop.width;if(Math.abs(s-box.height/crop.height)>s*.00001)return null;
    return {x:box.x-crop.x*s,y:box.y-crop.y*s,width:c.sourceWidth*s,height:c.sourceHeight*s};
  }
  function pose(c,state){
    if(state&&(state.still||state.reducedMotion))return 0;
    const now=state&&finite(state.now)?Math.max(0,state.now):0;
    return Math.sin(now/c.period*Math.PI*2)*(state&&state.work===true?c.workAngle:c.ambientAngle);
  }
  function sample(id,box,state){const e=entries.get(id),s=e&&space(e.config,box);return s?{angle:pose(e.config,state),pivot:[s.x+e.config.pivot[0]*s.width,s.y+e.config.pivot[1]*s.height]}:null;}
  function bounds(id,box){
    const e=entries.get(id),s=e&&space(e.config,box);if(!s)return null;const c=e.config,px=c.pivot[0]*s.width,py=c.pivot[1]*s.height;
    let l=s.x,t=s.y,r=s.x+s.width,b=s.y+s.height;
    for(let step=-16;step<=16;step++)for(const p of c.region){const a=c.workAngle*step/16,x=p[0]*s.width-px,y=p[1]*s.height-py,
      wx=s.x+px+x*Math.cos(a)-y*Math.sin(a),wy=s.y+py+x*Math.sin(a)+y*Math.cos(a);l=Math.min(l,wx);t=Math.min(t,wy);r=Math.max(r,wx);b=Math.max(b,wy);}
    return {x:l,y:t,width:r-l,height:b-t};
  }
  function draw(ctx,id,box,state){
    const e=entries.get(id),s=e&&space(e.config,box);if(!s||!ctx||typeof ctx.isContextLost==='function'&&ctx.isContextLost())return false;
    const angle=pose(e.config,state);ctx.save();
    try{
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.globalCompositeOperation='source-over';
      if(Math.abs(angle)<1e-10){ctx.drawImage(e.original,s.x,s.y,s.width,s.height);return true;}
      ctx.drawImage(e.stationary,s.x,s.y,s.width,s.height);
      const px=s.x+e.config.pivot[0]*s.width,py=s.y+e.config.pivot[1]*s.height;ctx.translate(px,py);ctx.rotate(angle);
      ctx.drawImage(e.part,s.x-px,s.y-py,s.width,s.height);return true;
    }catch(_){return false;}finally{ctx.restore();}
  }
  function release(id){const e=entries.get(id);if(!e)return false;cachedPixels-=e.cost;entries.delete(id);return true;}
  return Object.freeze({prepare,draw,sample,bounds,release,validate:valid,ready:id=>entries.has(id),
    status:()=>({ids:[...entries.keys()],cachedPixels,limit:MAX_CACHED_PIXELS,readbacksPerPrepare:1})});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredFurnitureMotion;
