import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {launchChrome,connectCDP,evalJS,sleep,capture,collectDiagnostics} from '../scripts/lib/cdp.mjs';
const out=path.resolve('.dogfood/station-default');
const {proc}=launchChrome({cdpPort:18847,profileDir:path.join(out,'tutorial-final-'+Date.now()),win:'1440,1000'});
let cdp;
try {
  cdp=await connectCDP(18847);await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:'Element.prototype.requestPointerLock=async function(){};if(navigator.keyboard)navigator.keyboard.lock=async function(){};'});
  const diagnostics=collectDiagnostics(cdp);
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:18845/'});
  for(let i=0;i<100;i++){if(await evalJS(cdp,"typeof World!=='undefined'&&!!World.stationDoc()"))break;await sleep(300);}
  await sleep(1000);
  assert.equal(await evalJS(cdp,'!!CloudSave.health().conflict'),false,'Fresh proof starts on the durable station revision');
  await evalJS(cdp,`Build.open();document.querySelector('#refit-stations').click();document.querySelector('[data-station-build="retreat"]').click();document.querySelector('[data-use-build]').click();document.querySelector('[data-use-build]').click();Build.close()`);
  assert.equal((await evalJS(cdp,'CloudSave.flushForUpdate()')).ok,true,'Retreat saved');
  await cdp.send('Page.reload');await sleep(3000);
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),'retreat','Selected build survives reload');
  await evalJS(cdp,"Build.open();document.querySelector('#refit-stations').click();document.querySelector('[data-restore-build]').click();Build.close()");
  assert.equal((await evalJS(cdp,'CloudSave.flushForUpdate()')).ok,true,'Default restored durably');
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),'default');
  const before=await evalJS(cdp,'World.stationDoc().props');
  await evalJS(cdp,'Tutorial.replayFirstCommand()');
  let toured=false,complete=false;
  for(let i=0;i<100;i++){
    const labels=await evalJS(cdp,"Array.from(document.querySelectorAll('.fnv-opt')).map(b=>b.textContent)");
    if(labels.some(s=>s.includes('SHOW ME AROUND'))){
      await evalJS(cdp,"Array.from(document.querySelectorAll('.fnv-opt')).find(b=>b.textContent.includes('SHOW ME AROUND')).click()");toured=true;
    }else if(labels.some(s=>s.includes('TRY A REAL FILE TASK'))){complete=true;break;}
    else await evalJS(cdp,"(()=>{document.querySelector('.fnv-dialogue')?.click();const b=document.querySelector('.fnv-more');if(b&&b.getClientRects().length)b.click()})()");
    assert.equal(await evalJS(cdp,'Build.isOpen()'),false,'Tour never opens placement mode');
    await sleep(350);
  }
  assert.ok(toured&&complete,'Equipment tour reaches the real-task choice');
  const text=await evalJS(cdp,"document.querySelector('.fnv-line').textContent");
  for(const word of ['files','web','terminal','memory','media'])assert.ok(text.includes(word),word);
  assert.deepEqual(await evalJS(cdp,'World.stationDoc().props'),before,'Tour places no props');
  await capture(cdp,out,'tutorial-equipment');
  await evalJS(cdp,"Array.from(document.querySelectorAll('.fnv-opt')).find(b=>b.textContent.includes('ready to work')).click()");
  await sleep(350);
  assert.equal(await evalJS(cdp,'Dialogue.isOpen()'),false);
  // Verify the durable backup remains available after a browser reload and use the
  // final validated replacement path once more, then restore the default floor.
  await evalJS(cdp,"Build.open();document.querySelector('#refit-stations').click()");
  assert.equal(await evalJS(cdp,"document.querySelector('[data-restore-build]').disabled"),false);
  const backupId=await evalJS(cdp,"JSON.parse(localStorage.getItem('starnet.layoutBackup.'+World.stationDoc().meta.createdAt)).meta.templateId");
  await evalJS(cdp,"document.querySelector('[data-restore-build]').click()");
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),backupId);
  await evalJS(cdp,"document.querySelector('#refit-undo').click();Build.close()");
  assert.equal(await evalJS(cdp,'World.stationDoc().meta.templateId'),'default');
  assert.equal((await evalJS(cdp,'CloudSave.flushForUpdate()')).ok,true,'Layout persisted');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:800,height:700,deviceScaleFactor:1,mobile:false});
  await evalJS(cdp,"Build.open();document.querySelector('#refit-stations').click()");
  const fit=await evalJS(cdp,"(()=>{const el=document.querySelector('.station-build-box'),r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:el.scrollWidth>el.clientWidth};})()");
  await capture(cdp,out,'picker-narrow');
  assert.ok(fit.left>=0&&fit.right<=800&&fit.top>=0&&fit.bottom<=700&&!fit.overflow,'Picker fits narrow viewport: '+JSON.stringify(fit));
  await evalJS(cdp,"document.querySelector('[data-workflow-close]').click();Build.close()");
  const durability=await evalJS(cdp,'CloudSave.flushForUpdate()');
  assert.equal(durability.ok,true,'All saves acknowledged before browser exit');
  const receipt={tour:toured,equipment:text,propsUnchanged:true,placementOpened:false,backupAfterReload:true,narrowPicker:fit,durability,exceptions:diagnostics.exceptions};
  fs.writeFileSync(path.join(out,'tutorial-receipt.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
}finally{cdp?.ws.close();proc.kill();}
