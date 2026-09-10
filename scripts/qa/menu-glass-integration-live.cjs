const assert = require('node:assert/strict');
const { chromium } = require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.STARNET_CHROME ? {executablePath:process.env.STARNET_CHROME} : {})});
 const proof = {url:process.argv[2] || 'http://127.0.0.1:8968/', checks:[], errors:[]};
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',e=>proof.errors.push(e.message));
  await page.goto(proof.url); await page.waitForSelector('#screen-game.active');
  assert(await page.locator('.cam-hud').evaluate(el=>['::before','::after'].every(p=>getComputedStyle(el,p).display==='none')),'decorative targeting marks are absent');
  const dialog=()=>page.locator('.term:not(.term-closing):not(.term-min-hidden)').last();
  const open=async(group,key)=>{
   await page.locator('[data-group="'+group+'"] > .bb-grp').click();
   await page.locator(key.startsWith('#') ? key : '#bottombar [data-term="'+key+'"]').click();
   await dialog().waitFor(); await page.waitForTimeout(350);
  };
  const geometry=async(label)=>{
   await page.waitForFunction(()=>[...document.querySelectorAll('.term')].every(w=>!w.style.willChange));
   const r=await dialog().evaluate(w=>{const b=w.getBoundingClientRect();const p=w.querySelector('.con-pane')||w.querySelector('.term-body');return {width:innerWidth,height:innerHeight,x:b.x,y:b.y,right:b.right,bottom:b.bottom,overflow:p.scrollWidth-p.clientWidth};});
   assert(r.x>=-1&&r.y>=-1&&r.right<=r.width+1&&r.bottom<=r.height+1,label+' stays in viewport');
   assert(r.overflow<=2,label+' has no horizontal overflow: '+r.overflow);
   proof.checks.push({label,...r});
  };
  const close=async()=>{
   await dialog().locator('.term-x').click();
   if(await page.locator('.term-unsaved-bar').count()) await dialog().locator('.term-x').click();
   await page.waitForFunction(()=>!document.querySelector('.term:not(.term-min-hidden)'));
  };
  for (const [group,key] of [['crew','agents'],['crew','#bb-recruit'],['work','#bb-missions'],['crew','commander'],['work','tasks'],['work','deliverables'],['work','quests'],['work','automation'],['build','connectors'],['build','messaging'],['system','settings'],['system','notifs'],['system','manual']]) {
   await open(group,key);await geometry(key+' desktop');
   if(key.startsWith('#')) {
    const size=await dialog().evaluate(w=>({height:w.getBoundingClientRect().height,catalog:w.querySelector('.mkt-stage').clientHeight,zoom:Number.parseFloat(getComputedStyle(document.body).zoom)||1}));
    assert(size.catalog*size.zoom>=250,'catalog has useful room on first open: '+JSON.stringify(size));
    await dialog().locator('.gd-pull').press('ArrowDown');
    const resized=await dialog().evaluate(w=>w.getBoundingClientRect().height);
    assert(Math.abs(resized-(size.height-40*size.zoom))<2,'explicit catalog resize is retained: '+JSON.stringify({before:size.height,after:resized,zoom:await page.evaluate(()=>getComputedStyle(document.body).zoom)}));
    proof.checks.push({label:key+' catalog and manual resize',catalog:size.catalog,before:size.height,after:resized});
   }
   if(key==='automation') {
    await page.locator('#con-tab-automation-loops-start').click();
    await page.locator('[data-tpl="research"]').count().then(async count=>{if(!count){await page.locator('.lp-shape').filter({hasText:'Research Loop'}).click();}else await page.locator('[data-tpl="research"]').click();});
    await page.locator('#lp-form textarea').first().fill('Compare three ways to organize a community garden.');
    if(await page.locator('#lp-form .rt-agent-btn').count()>1) await page.locator('#lp-form .rt-agent-btn').nth(1).click();
    assert.equal(await page.locator('#lp-form textarea').first().inputValue(),'Compare three ways to organize a community garden.');
    await page.locator('.lp-adv > summary').click();await page.locator('.lp-preview > summary').click();
    assert(await page.locator('#lp-prev').textContent());
    await page.locator('#lp-create').scrollIntoViewIfNeeded();await geometry('goal loop expanded review');
    await page.locator('#con-tab-automation-away').click();await geometry('away work');
   }
   if(key==='manual') { await page.locator('.fm-tab[data-t="GEAR"]').click();await geometry('manual gear'); }
   if(key==='settings') {await page.locator('#con-tab-settings-appearance').click();await geometry('appearance swatches');}
   await page.setViewportSize({width:700,height:650});await geometry(key+' narrow');
   await page.setViewportSize({width:1024,height:600});await geometry(key+' short');
   await close();await page.setViewportSize({width:1280,height:800});await page.waitForTimeout(350);
  }
  await open('work','tasks');await dialog().getByRole('button',{name:'OUTBOX',exact:true}).click();await geometry('Outbox');
  await page.locator('#ob-library').click();await geometry('Outbox to Library');
  assert(await dialog().textContent().then(t=>t.includes('LIBRARY')));
  assert.deepEqual(proof.errors,[]);proof.pass=true;
 } catch(e) {proof.pass=false;proof.failure=e.stack;process.exitCode=1;}
 finally {console.log(JSON.stringify(proof,null,2));await browser.close();}
})();
