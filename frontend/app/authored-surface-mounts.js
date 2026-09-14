/* Render-only support placement for authored tabletops. No saved-layout fields,
   catalog changes, pixel readback, physics changes, time, or invented host state. */
'use strict';
const AuthoredSurfaceMounts = (() => {
  const TILE=12, LEGACY_LIFT=8, FACES=['s','w','n','e'];
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const point=p=>Array.isArray(p)&&p.length===2&&p.every(finite);
  const rect=r=>r&&[r.x,r.y,r.width,r.height].every(finite)&&r.width>0&&r.height>0&&r.width<=192&&r.height<=192&&Math.abs(r.x)<=192&&Math.abs(r.y)<=192;
  const foot=p=>p&&typeof p.t==='string'&&p.t.length>0&&[p.x,p.y].every(n=>Number.isInteger(n)&&Math.abs(n)<=1000000)&&[p.w??1,p.h??1].every(n=>Number.isInteger(n)&&n>0&&n<=16);
  const copyFoot=p=>({id:p.id,t:p.t,x:p.x,y:p.y,w:p.w??1,h:p.h??1,r:Number.isInteger(p.r)?p.r&3:0,m:p.m?1:0});
  const contains=(a,b)=>b.x>=a.x&&b.y>=a.y&&b.x+b.w<=a.x+a.w&&b.y+b.h<=a.y+a.h;
  const sameFoot=(a,b)=>a&&b&&a.w===b.w&&a.h===b.h;
  const lerp=(a,b,t)=>a+(b-a)*t;
  function quadOK(q) {
    if(!Array.isArray(q)||q.length!==4||!q.every(point))return false;
    // TL/TR/BR/BL: require a bounded non-folding surface, with positive depth on
    // both side rails. Malformed data must not lift objects into the station void.
    if(q.some(p=>p.some(n=>Math.abs(n)>384)))return false;
    if(q[1][0]<=q[0][0]||q[2][0]<=q[3][0]||q[3][1]<=q[0][1]||q[2][1]<=q[1][1])return false;
    let sign=0;
    for(let i=0;i<4;i++){
      const a=q[i],b=q[(i+1)%4],c=q[(i+2)%4],cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
      if(Math.abs(cross)<1e-7)return false;
      if(sign&&Math.sign(cross)!==sign)return false;sign=Math.sign(cross);
    }
    return true;
  }
  function projectedPoint(q,x,v) {
    if(!quadOK(q)||!finite(x)||!finite(v)||v<0||v>1)return null;
    const left=[lerp(q[0][0],q[3][0],v),lerp(q[0][1],q[3][1],v)];
    const right=[lerp(q[1][0],q[2][0],v),lerp(q[1][1],q[2][1],v)];
    const span=right[0]-left[0];if(span<=1e-6)return null;
    const u=(x-left[0])/span;
    if(u<0||u>1)return null;
    return {x,y:lerp(left[1],right[1],u),u,v};
  }
  function create(options={}) {
    const calibration=options.calibration||(typeof AuthoredSurfaceCalibration!=='undefined'?AuthoredSurfaceCalibration:null);
    const lookup=typeof options.viewGeometry==='function'?options.viewGeometry:()=>null;
    const ruleFor=typeof options.ruleFor==='function'?options.ruleFor:t=>({surface:!!calibration?.props?.[t]});
    let layout=[],hosts=[];
    function rule(t){try{return ruleFor(t)||{};}catch(_){return {};}}
    function setLayout(props) {
      layout=Array.isArray(props)&&props.length<=20000?props.filter(foot).map(copyFoot):[];
      hosts=layout.filter(p=>rule(p.t).surface===true);
      return hosts.length;
    }
    function geometry(prop,host=false) {
      // Tables offer authored S/E views. An unsupported saved r1/r2 falls back
      // exactly as the native renderer does, only if its footprint still agrees.
      const views=calibration?.props?.[prop.t]?.views;
      const want=FACES[prop.r&3];
      const candidates=[want];if(want!=='s')candidates.push('s');
      for(const view of candidates){
        let g;try{g=lookup(prop.t,view);}catch(_){continue;}
        const spec=g?.spec;
        if(!g||!rect(g.box)||!spec||!sameFoot(spec.footprint,prop))continue;
        if(![spec.sourceWidth,spec.sourceHeight].every(n=>Number.isInteger(n)&&n>0&&n<=4096))continue;
        const c=g.crop||{x:0,y:0,width:spec.sourceWidth,height:spec.sourceHeight};
        if(![c.x,c.y,c.width,c.height].every(finite)||c.x<0||c.y<0||c.width<=0||c.height<=0||c.x+c.width>spec.sourceWidth||c.y+c.height>spec.sourceHeight)continue;
        const calibrated=views?.[view];
        const authored=g.surfaceSupport||spec.surfaceSupport;
        const supplied=Array.isArray(authored)?authored:authored?.points;
        if(authored&&!Array.isArray(authored)&&authored.space&&authored.space!=='export-normalized')continue;
        let points=supplied;
        if(!points&&calibrated){
          if(spec.image!==calibrated.image||spec.sourceWidth!==calibrated.sourceWidth||spec.sourceHeight!==calibrated.sourceHeight||!sameFoot(calibrated.footprint,prop))continue;
          const imageHash=g.imageSha256||spec.imageSha256||spec.exportSha256;
          if(imageHash&&imageHash!==calibrated.sha256)continue;
          points=calibrated.points;
        }
        if(host&&!points)continue;
        const mirror=!!prop.m&&rule(prop.t).canMirror!==false&&calibration?.props?.[prop.t]?.canMirror!==false;
        return {view,spec,box:g.box,crop:c,points,mirror};
      }
      return null;
    }
    function supportFor(host) {
      const g=geometry(host,true);if(!g)return null;
      if(!Array.isArray(g.points)||g.points.length!==4||!g.points.every(p=>point(p)&&p.every(n=>n>=0&&n<=1)))return null;
      const b=g.box,c=g.crop,s=g.spec;
      let q=g.points.map(([u,v])=>[b.x+(u*s.sourceWidth-c.x)/c.width*b.width,b.y+(v*s.sourceHeight-c.y)/c.height*b.height]);
      if(g.mirror){q=q.map(([x,y])=>[host.w*TILE-x,y]);q=[q[1],q[0],q[3],q[2]];}
      return quadOK(q)?{points:q,view:g.view,mirror:g.mirror}:null;
    }
    function actualContact(child) {
      const g=geometry(child);
      if(!g)return {x:child.w*TILE/2,y:child.h*TILE,authored:false};
      const x=g.box.x+g.box.width/2;
      return {x:g.mirror?child.w*TILE-x:x,y:g.box.y+g.box.height,authored:true};
    }
    function placementFor(prop) {
      const fallback=reason=>({lift:LEGACY_LIFT,authored:false,reason,hostId:null});
      if(!foot(prop))return fallback('invalid-child-footprint');
      const child=copyFoot(prop);
      // Mirrors worldmodel.surfaceHostFor: last containing surface in layout wins.
      // No generated/persisted host id is accepted as authority.
      let host=null;
      for(let i=hosts.length-1;i>=0;i--){
        const p=hosts[i];
        if((child.id!=null&&p.id===child.id)||!contains(p,child))continue;
        host=p;break;
      }
      if(!host)return fallback('no-containing-native-surface');
      const surface=supportFor(host);if(!surface)return fallback('host-has-no-valid-authored-surface');
      const contact=actualContact(child);
      const x=(child.x-host.x)*TILE+contact.x;
      // Physical row depth selects the tabletop cross-section; the child's
      // rendered base height is separate (a new book stack may end above y12).
      const depth=(child.y+child.h-host.y)/host.h;
      const target=projectedPoint(surface.points,x,depth);
      if(!target)return fallback('contact-outside-authored-support');
      const unliftedY=(child.y-host.y)*TILE+contact.y;
      const lift=unliftedY-target.y;
      if(!finite(lift)||lift < -TILE||lift > 48)return fallback('unsafe-render-lift');
      return {lift,authored:true,reason:'authored-tabletop',hostId:host.id??null,hostType:host.t,view:surface.view,mirror:surface.mirror,
        hostSortY:(host.y+host.h)*TILE,sortY:(host.y+host.h)*TILE+.5+depth*.001,
        depth,target:{x:host.x*TILE+target.x,y:host.y*TILE+target.y},
        contact:{x:child.x*TILE+contact.x,y:child.y*TILE+contact.y},support:surface.points};
    }
    return Object.freeze({setLayout,placementFor,liftFor:prop=>placementFor(prop).lift,supportFor});
  }
  return Object.freeze({create,projectedPoint,quadOK,LEGACY_LIFT});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredSurfaceMounts;
