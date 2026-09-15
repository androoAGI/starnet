'use strict';
// Display envelopes only. Source PNGs, floor footprints and contacts stay intact.
const fits={
  coffee:{bounds:{x:2.5,y:2,width:7,height:10},reason:'Countertop appliance height calibrated against the adjacent crew and low table.'},
  mug:{bounds:{x:4,y:8,width:4,height:4},reason:'Hand-sized mug; the tile remains its placement cell, not its physical width.'}
};
function apply(manifest,records){
  // The authored sofa back is taller than the native one. Raise the sitter's artwork
  // onto its cushion while retaining the floor foot/sort key and blocking rectangle.
  manifest.props.couch.views.s.seatLift=6;
  const couch=records.find(r=>r.id==='couch'&&(r.view||'s')==='s');
  if(couch)couch.seatLift=6;
  for(const[id,fit]of Object.entries(fits)){
    const view=manifest.props[id].views.s,record=records.find(r=>r.id===id&&(r.view||'s')==='s');
    if(!record)throw Error('Missing authored receipt '+id);
    const sourceBounds=record.displayFit?.sourceBounds||record.bounds;
    view.bounds={...fit.bounds};record.bounds={...fit.bounds};
    record.displayFit={sourceBounds,reason:fit.reason};
  }
}
module.exports={fits,apply};
if(require.main===module){
  const fs=require('node:fs'),m='frontend/assets/industrial/projection-correction/manifest.json',r='docs/station-remaster/projection-correction/exports.json';
  const manifest=JSON.parse(fs.readFileSync(m)),receipt=JSON.parse(fs.readFileSync(r));
  apply(manifest,receipt.records);fs.writeFileSync(m,JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(r,JSON.stringify(receipt,null,2)+'\n');
}
