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
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:18845/?propSet=projection'});
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
  console.log(JSON.stringify(receipt));
} finally {cdp?.ws.close();proc.kill();}
