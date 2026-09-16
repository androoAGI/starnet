'use strict';
// Read-only comparison of saved placements against the actual native view resolver.
const fs=require('node:fs');
global.IndustrialTextures={isRemaster:()=>true,enabled:()=>true,ready:Promise.resolve()};
const P=require('../frontend/app/propsprites.js');
const m=require('../frontend/assets/industrial/projection-correction/manifest.json');
const save=JSON.parse(fs.readFileSync('dev/.scratch-workspace/prop-layout-demo/agent.save.json'));
const station=(typeof save.doc==='string'?JSON.parse(save.doc):save.doc).station;
const mismatches=[],unsupportedRotations=[];
for(const p of station.props){
 const r=(p.r||0)&3,view=P.viewAt(p.t,r);let face='s';
 if(r&&!view)unsupportedRotations.push({id:p.id,type:p.t,rotation:r});
 if(view&&!view.turned&&r){face=['s','w','n','e'][r];if(!P.hasView(p.t,face))face=r===1?'e':r===3?'w':'s';}
 const asset=m.props[p.t]?.views[face];let w=p.w,h=p.h;
 if(view?.turned&&(r&1))[w,h]=[h,w];
 if(asset&&(asset.footprint.w!==w||asset.footprint.h!==h))mismatches.push({id:p.id,type:p.t,face,saved:[p.w,p.h],required:[asset.footprint.w,asset.footprint.h]});
}
const seen=new Set(station.props.map(p=>p.t));
console.log(JSON.stringify({instances:station.props.length,distinctTypes:seen.size,totalCatalogTypes:Object.keys(m.props).length,missingTypes:Object.keys(m.props).filter(id=>!seen.has(id)),sizeFallbacks:mismatches.length,sizeFallbacksByType:mismatches.reduce((a,p)=>(a[p.type]=(a[p.type]||0)+1,a),{}),mismatches,unsupportedRotations},null,2));
