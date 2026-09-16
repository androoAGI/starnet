// Candidate-bound graphics and responsiveness proof against the real installed WebView.
// Passive observation only: never opens panels, steals focus, or alters the station.
// node scripts/qa/installed-graphics.mjs <port> <full-head> <exe> <out-dir> [minutes=10]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { connectCDP, evalJS, capture, sleep } from '../lib/cdp.mjs';

const [port, head, executable, output, duration = '10'] = process.argv.slice(2);
assert.match(head || '', /^[a-f0-9]{40}$/);
const minutes = Number(duration);
assert.ok(minutes > 0 && minutes <= 60);
const out = path.resolve(output), bytes = fs.readFileSync(executable);
const artifact = { path: path.resolve(executable), size: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
fs.mkdirSync(out, { recursive: true });
const c = await connectCDP(Number(port));
const samples = [];
const stats = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const p = q => a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * q) - 1)] : null;
  return { count: a.length, median: p(.5), p95: p(.95), p99: p(.99), max: a.at(-1) ?? null };
};
try {
  await c.send('Page.enable');
  const identity = await evalJS(c, `(async()=>{
    await IndustrialTextures.ready; await PropRemaster.ready;
    const shell = await window.__TAURI__.core.invoke('starnet_build_info');
    const v = await fetch('/api/version',{headers:{'X-StarNet-Token':window.__STARNET_API_TOKEN__}}).then(r=>r.json());
    return { origin:location.origin, shell, sidecar:v, textures:IndustrialTextures.status(),
      props:PropRemaster.status(), enabledProp:PropRemaster.enabled('desk','s'),
      revision:document.documentElement.dataset.textureRevision,
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, camera:World.cameraDbg(),
      sprites:{ preview:SkinStudy.enabled, catalog:Object.entries(DATA.SKINS).map(([id,s])=>({id,...s})),
        agents:App.agents().map(a=>({id:a.id,skin:a.skin,set:SPRITES.setForBody(a),scale:SPRITES.bodyScale(a)})),
        bodies:World.bodies().map(b=>({id:b.id,pose:b.pose})),
        portraits:[...document.querySelectorAll('[data-portrait-set]')].map(n=>({set:n.dataset.portraitSet,visible:!n.hidden,loaded:n.complete&&n.naturalWidth>0}))} };
  })()`);
  assert.ok(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'].includes(identity.origin));
  assert.equal(identity.shell.sha, head);
  assert.equal(identity.sidecar.buildSha, head);
  assert.equal(identity.shell.dirty, false);
  assert.equal(identity.sidecar.buildDirty, false);
  assert.equal(identity.shell.executableSha256, artifact.sha256);
  assert.equal(identity.shell.executableSize, artifact.size);
  assert.equal(identity.textures.loaded, true, JSON.stringify(identity.textures.failed));
  assert.deepEqual(identity.textures.failed, []);
  assert.deepEqual(identity.props.failures, []);
  assert.ok(identity.props.views.length > 100 && identity.enabledProp);
  assert.equal(identity.revision, 'bridge-remaster');
  assert.equal(identity.sprites.preview, false, 'installed proof must not opt into a review mode');
  assert.equal(identity.sprites.catalog.length, 37);
  const selected = JSON.parse(fs.readFileSync('frontend/assets/skin-study-0914/runtime-motion.json'));
  for (const skin of selected.skins) {
    const live = identity.sprites.catalog.find(s=>s.id===skin.skin);
    assert.equal(live?.set, skin.renderSet, skin.skin + ' production catalog');
    assert.equal(live.scale, selected.standingHeight/skin.sourceStandingHeight);
  }
  const approved = set => set === 'pikachu' || set.startsWith('approved_');
  assert.ok(identity.sprites.agents.length > 0 && identity.sprites.agents.every(a=>approved(a.set)));
  const drawn = identity.sprites.bodies.filter(b=>b.pose);
  assert.ok(drawn.length > 0 && drawn.every(b=>approved(b.pose.split('.')[0])), 'actual floor draw tracks use selected art');
  assert.ok(identity.sprites.portraits.length > 0 && identity.sprites.portraits.every(p=>approved(p.set)&&p.loaded&&p.visible), 'visible portraits use selected art');
  await capture(c, out, 'installed-remaster');
  await evalJS(c, `(()=>{
    const p=window.__releaseGraphics={frames:[],longTasks:[],errors:[],last:null,active:true};
    p.error=e=>p.errors.push(String(e.message||e.reason).slice(0,240));
    addEventListener('error',p.error);addEventListener('unhandledrejection',p.error);
    p.observer=new PerformanceObserver(list=>{for(const e of list.getEntries())p.longTasks.push(e.duration)});
    p.observer.observe({type:'longtask'});
    function tick(t){if(!p.active)return;if(p.last!==null)p.frames.push(t-p.last);p.last=t;requestAnimationFrame(tick)}
    requestAnimationFrame(tick);
  })()`);
  const started = Date.now(), deadline = started + minutes * 60000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const sample = await evalJS(c, `(async()=>{
      const p=window.__releaseGraphics, t=performance.now();
      const r=await fetch('/api/health',{cache:'no-store',headers:{'X-StarNet-Token':window.__STARNET_API_TOKEN__}});
      return {frames:p.frames.splice(0),longTasks:p.longTasks.splice(0),errors:p.errors.slice(),
        hidden:document.hidden,heap:performance.memory?.usedJSHeapSize??null,
        healthStatus:r.status,healthMs:performance.now()-t,cache:World._dbgCanvasLoss()};
    })()`);
    samples.push(sample);
    fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify({ elapsedSeconds: (Date.now()-started)/1000,
      samples:samples.length, frames:stats(samples.flatMap(s=>s.frames)) }, null, 2));
  }
  const frames = stats(samples.flatMap(s => s.frames));
  const longTasks = stats(samples.flatMap(s => s.longTasks));
  const health = stats(samples.map(s => s.healthMs));
  const checks = {
    visibleSamples: samples.every(s => !s.hidden),
    enoughFrames: frames.count >= minutes * 600,
    frameP95Within34ms: frames.p95 !== null && frames.p95 <= 34,
    noHalfSecondLongTask: longTasks.max === null || longTasks.max < 500,
    healthResponsive: health.p95 < 500 && samples.every(s => s.healthStatus === 200),
    noRuntimeErrors: samples.every(s=>s.errors.length === 0),
    noBlankCanvas: samples.every(s=>!s.cache?.blank)
  };
  const receipt = { at:new Date().toISOString(), head, artifact, identity, minutes,
    actualSeconds:(Date.now()-started)/1000, frames, longTasks, health, checks,
    pass:Object.values(checks).every(Boolean),
    scope:'Passive observation of the installed Windows WebView on this machine and populated station. Frame timing and engine health; does not exercise panels or Refit and makes no provider workload or cross-hardware performance claim.' };
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt,null,2));
  fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify(samples));
  console.log(JSON.stringify(receipt,null,2));
  process.exitCode = receipt.pass ? 0 : 1;
} finally {
  await evalJS(c, `(()=>{const p=window.__releaseGraphics;if(p){p.active=false;p.observer.disconnect();removeEventListener('error',p.error);removeEventListener('unhandledrejection',p.error);delete window.__releaseGraphics}})()`).catch(()=>{});
  c.ws.close();
}
