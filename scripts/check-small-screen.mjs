import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { launchChrome, connectCDP, evalJS, capture, sleep } from './lib/cdp.mjs';
import { waitDevReady } from './lib/seed.mjs';
const require = createRequire(import.meta.url);
const { SYNTHETIC_INPUT_BOOTSTRAP } = require('../sidecar/tools/builtin/browser.js')._internals;
const out = '.dogfood/small-screen'; mkdirSync(out, { recursive: true });
const { proc } = launchChrome({ cdpPort: 9367, win: '1366,768', profileDir: out + '/profile-' + Date.now() });
let cdp;
const results = [];
try {
  cdp = await connectCDP(9367);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SYNTHETIC_INPUT_BOOTSTRAP });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8967' });
  if (!await waitDevReady(cdp, evalJS, { tries: 24, url: 'http://127.0.0.1:8967' })) throw Error('Seed did not boot');
  console.log('Live app ready');
  await evalJS(cdp, `(() => {
    document.body.classList.add('no-flicker');
    StationUI.openTerm('settings');
    document.querySelector('[data-ts="100"]').click();
    StationUI.closeTerm('settings');
    const toast=document.getElementById('toast-stack'); if(toast)toast.remove();
    const log=document.getElementById('chat-log'); log.replaceChildren();
    const row=document.createElement('div'); row.className='cmsg agent nudge';
    const body=document.createElement('div'); body.className='body'; row.append(body); log.append(row);
    window.layoutFixture=TaskConversation.mount(body, {
      question:'What should I include in your inventory?',
      reason:'A few details will help me create a useful first draft.',
      options:["I’ll write a short free-text inventory",'Give me a quick fill-in template']
    }, async text => { window.layoutAnswer=text; return true; });
  })()`);
  for (const [w,h] of [[1366,768],[1280,720],[1024,600],[800,600],[390,844]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});
    for (const zoom of [1,1.45]) {
      await evalJS(cdp, `StationUI.openTerm('settings');document.querySelector('[data-ts="${Math.round(zoom*100)}"]').click();StationUI.closeTerm('settings');`);
      for (const expanded of [false,true]) {
        await evalJS(cdp, `if(document.getElementById('comms-expand').getAttribute('aria-pressed')!=='${expanded}') document.getElementById('comms-expand').click();`);
        await sleep(180);
        const r=await evalJS(cdp, `(() => {
          const rect=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
          return {actualZoom:parseFloat(document.body.style.zoom)||1,panel:rect('#chat-panel'),composer:rect('#chat-inputrow'),log:rect('#chat-log'),button:rect('#comms-expand'),card:rect('.task-conversation'),bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth};
        })()`);
        const pass=Math.abs(r.actualZoom-zoom)<.01 && r.panel.right<=w+2 && r.panel.bottom<=h+2 && r.composer.bottom<=r.panel.bottom+2 && r.composer.y>=r.panel.y && r.log.height>40 && r.button.right<=w+2;
        results.push({w,h,zoom,expanded,pass,...r});
        console.log(JSON.stringify({w,h,zoom,expanded,pass,chatWidth:r.panel.width,transcriptHeight:r.log.height}));
        if(w===1280 && zoom===1) {
          await evalJS(cdp, `document.getElementById('nav-coach-x')?.click();document.getElementById('toast-stack')?.remove();`);
          await capture(cdp,out,expanded?'expanded-1280':'after-1280');
        }
      }
    }
  }
  // Same live form and viewport, with only this pass's sheet disabled, gives the baseline.
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  await evalJS(cdp, `StationUI.openTerm('settings');document.querySelector('[data-ts="100"]').click();StationUI.closeTerm('settings');if(document.getElementById('comms-expand').getAttribute('aria-pressed')==='true')document.getElementById('comms-expand').click();document.querySelector('link[href="css/comms-layout.css"]').disabled=true;document.getElementById('comms-expand').hidden=true;window.dispatchEvent(new Event('resize'));`);
  await sleep(250); await capture(cdp,out,'before-1280');
  const baseline=await evalJS(cdp, `({width:document.getElementById('chat-panel').getBoundingClientRect().width,cardHeight:document.querySelector('.task-conversation').getBoundingClientRect().height})`);
  await evalJS(cdp, `document.querySelector('link[href="css/comms-layout.css"]').disabled=false;document.getElementById('comms-expand').hidden=false;`);
  await sleep(200);
  const after=await evalJS(cdp, `({width:document.getElementById('chat-panel').getBoundingClientRect().width,cardHeight:document.querySelector('.task-conversation').getBoundingClientRect().height})`);
  await evalJS(cdp, `document.querySelector('.tc-shortcut').click();document.querySelector('.tc-actions .primary').click();`);
  await sleep(200);
  const answer=await evalJS(cdp, `({text:window.layoutAnswer,answered:document.querySelector('.task-conversation').classList.contains('tc-answered')})`);
  const restore=await evalJS(cdp, `(() => {
    const game=document.getElementById('screen-game'), button=document.getElementById('comms-expand');
    game.style.setProperty('--chat-w','420px');game.style.setProperty('--crew-w','250px');
    document.getElementById('chat-input').value='Unsent draft stays here';
    const crewOff=document.body.classList.contains('crew-rail-off');
    button.click();button.click();
    return {width:game.style.getPropertyValue('--chat-w'),crewWidth:game.style.getPropertyValue('--crew-w'),
      crewUnchanged:crewOff===document.body.classList.contains('crew-rail-off'),
      draft:document.getElementById('chat-input').value,restored:button.getAttribute('aria-pressed')==='false'};
  })()`);
  writeFileSync(out+'/results.json',JSON.stringify({results,baseline,after,answer,restore},null,2));
  if(results.some(r=>!r.pass)||!answer.answered||restore.width!=='420px'||restore.crewWidth!=='250px'||!restore.crewUnchanged||!restore.restored||restore.draft!=='Unsent draft stays here') process.exitCode=1;
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:8967/dev/comms-layout-review.html'});
  let reviewReady=false;
  for(let i=0;i<30;i++) {
    reviewReady=await evalJS(cdp, `!!document.querySelector('iframe')?.contentDocument?.querySelector('.task-conversation')`).catch(()=>false);
    if(reviewReady)break;await sleep(500);
  }
  if(!reviewReady)throw Error('Interactive review did not initialize');
  await evalJS(cdp, `document.getElementById('before').click()`);
  const beforeWorks=await evalJS(cdp, `document.getElementById('app').contentDocument.querySelector('link[href="css/comms-layout.css"]').disabled`);
  await evalJS(cdp, `document.getElementById('after').click()`);
  const afterWorks=await evalJS(cdp, `!document.getElementById('app').contentDocument.querySelector('link[href="css/comms-layout.css"]').disabled`);
  if(!beforeWorks||!afterWorks)throw Error('Review comparison toggle failed');
  console.log('Interactive review: initialized; before/after toggles PASS');
} finally {
  if(cdp) { await cdp.send('Browser.close').catch(()=>{}); cdp.ws.close(); }
  if(proc.exitCode===null) { const exit=once(proc,'exit'); proc.kill(); await exit; }
}
