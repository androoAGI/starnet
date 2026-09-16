'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {buildPlan,manifestPatch,applyPlan,fit,toExport,FACING,ROOT_OWNED,PREVIOUS} = require('../dev/industrial-textures/integrate-coordinated-batch03.cjs');
const root = path.resolve(__dirname,'..');
let assertions = 0;
const check = (value,message) => { assertions++;assert.ok(value,message); };
const equal = (actual,expected,message) => { assertions++;assert.deepEqual(actual,expected,message); };
const near = (a,b,message) => check(Math.abs(a-b)<1e-9,message);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const plan = buildPlan(root), patch = manifestPatch(plan);
equal(Object.keys(plan.props).length,122,'Every coordinated ID is represented, including missing source candidates.');
for(const id of [...ROOT_OWNED,...PREVIOUS]) check(!plan.props[id]&&!patch.props[id],id+' remains in its assigned lane.');
for(const [id,prop] of Object.entries(plan.props)) for(const [facing,v]of Object.entries(prop.views)) {
  if(v.status==='missing-source') { check(!patch.props[id]?.views[facing],id+' missing source is never silently fabricated.');continue; }
  equal(v.r,FACING[facing],id+' native r0/s, r1/w, r2/n, r3/e semantics.');
  const png = fs.readFileSync(path.join(root,v.exported.path));
  equal([v.exported.width,v.exported.height],[png.readUInt32BE(16),png.readUInt32BE(20)],id+' uses actual exported dimensions.');
  const view=patch.props[id]?.views[facing];
  if(v.runtime.status==='pending'||v.runtime.status==='requires-service-runtime') check(!view,id+' pending state stays unapplied.');
  if(view) {
    check(!view.nativeLayers&&!view.nativeMask&&view.mode!=='native',id+' contains no retained old painter.');
    const fitted=fit(view.bounds,v.alphaCrop);
    near(fitted.width/v.alphaCrop.width,fitted.height/v.alphaCrop.height,id+' scales uniformly.');
    near(fitted.y+fitted.height,view.bounds.y+view.bounds.height,id+' bottom remains anchored.');
  }
}
equal(Object.keys(patch.props.dinerchair.views).sort(),['e','n','s','w'],'Diner chair uses four independent source views.');
equal(patch.props.dinerchair.views.w.image,'dinerchair-r1.png','West is r1, not east.');
equal(patch.props.dinerchair.views.e.image,'dinerchair-r3.png','East is r3, not west.');
equal(patch.props.telescope_r.views.s.image,'telescope_r.png','Catalog _r remains a separate ID, not an r1 facing.');
equal(patch.props.glasstable.views.e.footprint,{w:1,h:3},'East table reserves the native vertical rectangle.');
check(plan.props.glasstable.views.s.mountSupport.measuredNearEdgeRise!==8,'New table support is measured instead of copied from generic rise8.');
check(plan.props.glasstable.views.s.mountSupport.supportPolygonWorld.length===4,'New tabletop support polygon survives handoff.');
const planter=plan.props.industrial_planter.views.s;
check(planter.exported.width!==planter.alphaCrop.width,'Preserved-canvas utility export is distinguished from its opaque body.');
near(planter.fit.width,26,'Utility alpha bounds determine fitted world width.');
equal(toExport([[100,60]],'sourcePixels',{width:200,height:100},{left:20,top:10,width:160,height:80}),[[.5,.625]],'Original source crop is subtracted exactly once.');
equal(patch.props.mug.views.s.bounds,{x:4,y:8,width:4,height:4},'Root-reviewed small mug proportions stay explicit.');
equal(patch.props.missionboard.views.s.mode,'content','Confirmed content-mode wiring is included by default.');
check(!patch.props.jukebox&&!patch.props.connector_portal,'Disconnected service objects cannot become ambient-success props.');
const service=manifestPatch(plan,{enableService:true,ids:['jukebox','connector_portal','outbox','airlock']});
equal(Object.keys(service.props).sort(),['airlock','connector_portal','jukebox','outbox'],'Service integration is an explicit scoped opt-in.');
for(const p of Object.values(service.props))equal(p.views.s.mode,'service','Service mode remains distinct from decorative light.');

// Exercise the mutating path only in a newly created disposable fixture; never
// apply a recipe to this helper's or the parent's actual runtime manifest.
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-prop-recipe-'));
try {
  const partial={version:1,props:{stool:plan.props.stool}}, selected=manifestPatch(partial);
  const copy=selected.copies[0],dest=path.join(scratch,'frontend/assets/industrial/props-v3');
  fs.mkdirSync(path.dirname(path.join(scratch,copy.from)),{recursive:true});
  fs.mkdirSync(dest,{recursive:true});
  fs.copyFileSync(path.join(root,copy.from),path.join(scratch,copy.from));
  const before={version:1,metadata:{keep:true},props:{
    crate:{views:{s:{image:'approved.png'}}},
    stool:{views:{e:{image:'keep-independent-e.png'}}},
    bar:{views:{s:{image:'keep-pending-bar.png'}}}
  }};
  const filename=path.join(dest,'manifest.json');
  fs.writeFileSync(filename,JSON.stringify(before));
  const bad=JSON.parse(JSON.stringify(partial));bad.props.stool.views.s.exported.sha256='0'.repeat(64);
  assertions++;assert.throws(()=>applyPlan(scratch,bad),/Stale recipe export/,'An edited source fails before any mutation.');
  equal(JSON.parse(fs.readFileSync(filename)),before,'Stale source rejection leaves manifest unchanged.');
  applyPlan(scratch,partial);
  const after=JSON.parse(fs.readFileSync(filename));
  equal(after.props.crate,before.props.crate,'Approved root-owned props are retained.');
  equal(after.props.bar,before.props.bar,'Pending runtime behavior is retained.');
  equal(after.props.stool.views.e,before.props.stool.views.e,'Unmentioned independently authored facings are retained.');
  equal(after.metadata,before.metadata,'Manifest metadata survives.');
  equal(hash(fs.readFileSync(path.join(scratch,copy.to))),copy.sha256,'Copy preserves exact exported RGB and alpha bytes.');
  const once=fs.readFileSync(filename,'utf8');applyPlan(scratch,partial);
  equal(fs.readFileSync(filename,'utf8'),once,'Repeated application is idempotent.');
} finally {
  if(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())+path.sep+'starnet-prop-recipe-'))fs.rmSync(scratch,{recursive:true,force:true});
}
console.log(`coordinated-prop-recipes.test: OK (${assertions} assertions; ${plan.counts.authoredViews} actual PNG views mapped)`);
