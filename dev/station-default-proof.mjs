import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchChrome, connectCDP, evalJS, sleep, capture, collectDiagnostics } from '../scripts/lib/cdp.mjs';

const out = path.resolve('.dogfood/station-default');
fs.mkdirSync(out, {recursive:true});
const {proc} = launchChrome({cdpPort:18846, profileDir:path.join(out,'browser'), win:'1440,1000'});
let cdp;
try {
  cdp = await connectCDP(18846);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:`
    Element.prototype.requestPointerLock = async function() {};
    if (navigator.keyboard) navigator.keyboard.lock = async function() {};
  `});
  const diagnostics=collectDiagnostics(cdp);
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:18845/'});
  let ready=false;
  for(let i=0;i<120;i++) {
    ready=await evalJS(cdp,"typeof World!=='undefined' && !!World.stationDoc() && typeof PropRemaster!=='undefined' && PropRemaster.enabled('studio','s')");
    if(ready)break;
    await sleep(500);
  }
  assert.ok(ready,'Station and remastered art loaded');
  await sleep(1500);
  const receipt=await evalJS(cdp,`({station:World.stationDoc(),caps:World.heroCaps('agent').map(c=>c.objectType),art:PropRemaster.status()})`);
  assert.equal(receipt.station.order.length,1);
  assert.equal(receipt.station.props.length,9);
  for(const cap of ['cabinet','dish','workbench','notebook','studio'])assert.ok(receipt.caps.includes(cap),cap);
  assert.equal(receipt.station.props.filter(p=>p.t==='desk'&&p.agentId==='agent').length,1);
  assert.deepEqual(receipt.art.failures,[]);
  receipt.exceptions=diagnostics.exceptions;
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));
  await capture(cdp,out,'default-station');
  console.log('Default station: five grants, assigned desk, remastered assets, no loader failures');
  await evalJS(cdp,"Build.open();document.querySelector('#refit-stations').click()");
  assert.equal(await evalJS(cdp,"document.querySelectorAll('[data-station-build]').length"),6);
  await capture(cdp,out,'station-build-picker');
  receipt.builds=[];
  for(const [id,count] of [['retreat',2],['creative',3],['research',3],['engineering',5],['operations',5]]) {
    await evalJS(cdp,`if(!document.querySelector('[data-station-build]'))document.querySelector('#refit-stations').click();document.querySelector('[data-station-build="${id}"]').click();document.querySelector('[data-use-build]').click()`);
    const before=await evalJS(cdp,'World.stationDoc().meta.templateId||"default"');
    await evalJS(cdp,"document.querySelector('[data-use-build]').click()");
    await sleep(800);
    const result=await evalJS(cdp,`({id:World.stationDoc().meta.templateId,rooms:Object.values(World.stationDoc().rooms).filter(r=>r.kind!=='corridor').length,owners:World.stationDoc().props.filter(p=>p.agentId).map(p=>p.agentId),backup:JSON.parse(localStorage.getItem('starnet.layoutBackup.'+World.stationDoc().meta.createdAt)).meta.templateId||'default'})`);
    assert.equal(result.id,id);assert.equal(result.rooms,count);assert.equal(result.backup,before);assert.deepEqual(result.owners,['agent']);
    receipt.builds.push(result);
    await evalJS(cdp,'Build.close();World.camPullBack()');await sleep(1200);
    await capture(cdp,out,id);
    await evalJS(cdp,'Build.open()');
  }
  await evalJS(cdp,"document.querySelector('#refit-stations').click();document.querySelector('[data-restore-build]').click()");
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),'engineering');
  await evalJS(cdp,"document.querySelector('#refit-undo').click()");
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),'operations');
  await evalJS(cdp,`document.querySelector('#refit-stations').click();document.querySelector('[data-station-build="default"]').click();document.querySelector('[data-use-build]').click();document.querySelector('[data-use-build]').click();Build.close()`);
  await sleep(1000);
  await cdp.send('Page.reload');await sleep(3000);
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),'default');
  assert.equal(await evalJS(cdp,'World.stationDoc().props.length'),9);
  assert.equal((await evalJS(cdp,'CloudSave.flushForUpdate()')).ok,true);
  receipt.exceptions=diagnostics.exceptions;
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));
  console.log('Five build choices: apply, backup, restore, undo, reload PASS');
} finally {cdp?.ws.close();proc.kill();}
