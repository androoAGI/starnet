'use strict';
const AuthoredFurnitureConfig=(()=>{
  const common={bounds:{x:0,y:-8,width:12,height:30},frameBounds:{x:-2.5,y:-8,width:17,height:30},
    footprint:{w:1,h:2},period:5800,ambientAngle:.042,workAngle:.105};
  const byId={
    punchbag:{...common,image:'punchbag.png',sourceWidth:815,sourceHeight:1437,
      sha256:'7f4e79f9deb9b8f5c413c221a8c7bbf3e91a2f2c800d76150f40ff3dc64002de',pivot:[.1595,.0543],
      region:[[.132,.0543],[.188,.0543],[.188,.151],[.28,.206],[.327,.235],[.327,.752],[0,.752],[0,.232],[.057,.196],[.132,.151]]},
    punchbag_r:{...common,image:'punchbag_r.png',sourceWidth:832,sourceHeight:1438,
      sha256:'46a5f45af4f4c97a49c184a2ec1546b77a6a65703d844dceb6c76f260ab67134',pivot:[.839,.05424],
      region:[[.812,.05424],[.865,.05424],[.865,.151],[.943,.196],[1,.232],[1,.751],[.682,.751],[.682,.235],[.72,.206],[.812,.151]]}
  };
  const freeze=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o);}return o;};freeze(byId);
  return Object.freeze({byId,ids:Object.freeze(Object.keys(byId)),get:id=>Object.prototype.hasOwnProperty.call(byId,id)?byId[id]:null,sourceRoot:'assets/industrial/batch03/crew/'});
})();
if(typeof module!=='undefined'&&module.exports)module.exports=AuthoredFurnitureConfig;
