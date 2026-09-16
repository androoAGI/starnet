// Exercise a COPY of a saved station in a private browser, never the owner's UI.
// node scripts/qa/refit-entry.mjs <loopback-url> <layout.json> <output-directory>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { launchChrome, connectCDP, evalJS, sleep, capture } from '../lib/cdp.mjs';

const [url, layoutPath, output] = process.argv.slice(2);
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'use an isolated local seed');
const bytes = fs.readFileSync(layoutPath), layout = JSON.parse(bytes), out = path.resolve(output);
fs.mkdirSync(out, { recursive: true });
const { proc } = launchChrome({ cdpPort: 9348, win: '1280,832', profileDir: path.join(out, 'chrome') });
const c = await connectCDP(9348);
// Large saved-station cold bakes must produce a failure receipt, not disappear
// behind the normal CDP request timeout. Entry has its own strict time budget.
c.send = function(method, params = {}) {
  const id = ++this.id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) reject(Error('Refit probe timed out: ' + method));
    }, 180000);
    this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    this.ws.send(JSON.stringify({ id, method, params }));
  });
};
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
try {
  await c.send('Page.enable');
  await c.send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    ready = await evalJS(c, `typeof World!=='undefined' && typeof Build!=='undefined' && World.bodies().length>0`).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  assert.ok(ready, 'seed reached the live world');
  await evalJS(c, `Promise.all([IndustrialTextures.ready,PropRemaster.ready]).then(()=>true)`);
  const prepared = await evalJS(c, `(()=>{
    World.stop();
    const station=window.__refitProbeStation=WorldModel.deserialize(${JSON.stringify(layout)});
    World.loadStation(station);World.rebake();
    Build.init({getStation:()=>station,persist:()=>{},world:World,agents:()=>App.agents()});
    const bake=StationBake.bakeIncremental;
    window.__refitProbeBakes=0;
    StationBake.bakeIncremental=function(...args){window.__refitProbeBakes++;return bake(...args)};
    window.__refitProbeDoc=JSON.stringify(station.doc());
    return {rects:station.projectGeometry().allRects.length,props:station.doc().props.length,
      reusable:!!World.refitBake(station),
      differentSaveRejected:World.refitBake(WorldModel.deserialize(station.doc()))===null};
  })()`);
  const open = () => evalJS(c, `(async()=>{
    const t=performance.now();document.getElementById('bb-build').click();
    const syncMs=performance.now()-t;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {syncMs,paintMs:performance.now()-t,bakes:window.__refitProbeBakes,
      state:document.querySelector('.refit-overlay')?.dataset.renderState,
      unchanged:JSON.stringify(__refitProbeStation.doc())===__refitProbeDoc};
  })()`);
  const first = await open();
  await capture(c, out, 'refit-open');
  await evalJS(c, `(async()=>{Build.close();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()`);
  const reopen = await open();
  const edit = await evalJS(c, `(async()=>{
    const st=__refitProbeStation,room=st.rooms().find(r=>r.kind!=='corridor');
    const style=Object.keys(WorldModel.FLOOR_STYLES).find(s=>s!==room.floorStyle);
    const t=performance.now(),result=st.setFloor(room.id,style);
    const staleRejected=World.refitBake(st)===null;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {ok:result.ok,staleRejected,paintMs:performance.now()-t,bakes:__refitProbeBakes,
      state:document.querySelector('.refit-overlay')?.dataset.renderState};
  })()`);
  const undo = await evalJS(c, `(async()=>{
    document.getElementById('refit-undo').click();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {restored:JSON.stringify(__refitProbeStation.doc())===__refitProbeDoc,bakes:__refitProbeBakes,
      state:document.querySelector('.refit-overlay')?.dataset.renderState};
  })()`);
  const checks = {
    populated: prepared.rects >= 20 && prepared.props >= 50,
    exactStationOnly: prepared.reusable && prepared.differentSaveRejected,
    firstEntryUnderOneSecond: first.paintMs < 1000,
    reopenUnderOneSecond: reopen.paintMs < 1000,
    entryDoesNotRebake: first.bakes === 0 && reopen.bakes === 0,
    entryDoesNotEdit: first.unchanged && reopen.unchanged,
    editsInvalidate: edit.ok && edit.staleRejected && edit.bakes > 0,
    undoRestores: undo.restored && undo.bakes > edit.bakes,
    allFramesReady: [first,reopen,edit,undo].every(s=>s.state==='ready')
  };
  const receipt = { at: new Date().toISOString(), head,
    sourceDirty: !!execFileSync('git',['status','--porcelain','--','frontend'],{encoding:'utf8'}).trim(),
    layoutSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    prepared,first,reopen,edit,undo,checks,pass:Object.values(checks).every(Boolean),
    scope:'Isolated software-rendered Chromium with a copied saved station; no installed WebView claim. Entry threshold is one second. Edit/undo checks cover invalidation and persistence, with edit duration reported separately.' };
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt,null,2));
  process.exitCode = receipt.pass ? 0 : 1;
} finally { c.ws.close();proc.kill(); }
process.exit(process.exitCode || 0);
