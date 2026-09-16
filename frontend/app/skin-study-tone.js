/* Bounded display calibration for the opt-in study skins. Source PNGs, alpha,
 * feet, silhouettes and animation selection stay unchanged. Local lighting is
 * applied afterward by the existing sprite renderer. */
'use strict';
const SkinStudyTone=(()=>{
 const cached=new WeakMap();let builds=0;
 function pixel(r,g,b) {
  const l=.2126*r+.7152*g+.0722*b;
  // Protect the black outline; lift dark interior planes and roll off highlights.
  const lift=6*Math.min(1,l/24)*Math.pow(1-l/255,2);
  const roll=Math.max(0,l-150)*.16;
  const saturation=Math.max(r,g,b)-Math.min(r,g,b)>90?.92:1;
  return [r,g,b].map(c=>Math.max(0,Math.min(255,Math.round(l+(c-l)*saturation+lift-roll))));
 }
 function frame(source) {
  if(cached.has(source))return cached.get(source);
  try {
   if(!source?.width||source.width*source.height>262144)return source;
   const cv=document.createElement('canvas');cv.width=source.width;cv.height=source.height;
   const g=cv.getContext('2d');g.drawImage(source,0,0);
   const data=g.getImageData(0,0,cv.width,cv.height),d=data.data;
   for(let i=0;i<d.length;i+=4)if(d[i+3]){const rgb=pixel(d[i],d[i+1],d[i+2]);d[i]=rgb[0];d[i+1]=rgb[1];d[i+2]=rgb[2];}
   g.putImageData(data,0,0);cached.set(source,cv);builds++;
   cv.addEventListener?.('contextlost',()=>cached.delete(source),{once:true});return cv;
  }catch(_){return source;}
 }
 return {pixel,frame,stats:()=>({builds})};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=SkinStudyTone;
