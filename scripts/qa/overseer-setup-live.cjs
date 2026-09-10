const assert = require('node:assert/strict');
const { chromium } = require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.STARNET_CHROME ? { executablePath: process.env.STARNET_CHROME } : {}) });
  const receipt = { checks: [], errors: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', error => receipt.errors.push(error.message));
    // Exercise the first-run router against an explicitly empty save, without changing the seeded station.
    await page.route('**/api/save?*', route => route.fulfill({ json: { ok: true, save: null } }));
    let connections = 0, rejectConnection = false;
    await page.route('**/api/credits?*', route => route.fulfill({json:{configured:false}}));
    await page.route('**/api/credits/linkable', route => route.fulfill({json:{available:true}}));
    await page.route('**/api/credits/link/poll', route => route.fulfill({json:{pending:true}}));
    await page.route('**/api/credits/link/start', async route => {
      connections++;
      await new Promise(resolve => setTimeout(resolve,250));
      await route.fulfill(rejectConnection ? {status:503,json:{ok:false}} : {json:{code:'PREVIEW',verifyUrl:'http://127.0.0.1:9217/overseer-account-preview',expiresAt:Date.now()+60000}});
    });
    await page.context().route('**/overseer-account-preview', route => route.fulfill({contentType:'text/html',body:'<h1>Account connection test fixture</h1>'}));
    await page.goto(process.argv[2] || 'http://127.0.0.1:9217/');
    await page.locator('#sp-press').click();
    await page.locator('#in-name').fill('ORION');
    assert.equal(await page.locator('#np-name').textContent(), 'ORION');
    assert(await page.locator('#ov-brain').isHidden());
    assert.equal(await page.locator('#ov-skin-search').count(), 0);
    assert.equal(await page.locator('#skin-picker button:visible').count(), await page.locator('#skin-picker button').count());
    await page.locator('#skin-picker .skin-thumb').nth(1).click();
    const skin = await page.locator('#skin-stage-name').textContent();
    await page.locator('#approval-picker button').nth(1).click();
    const approval = await page.locator('#np-mode').textContent();
    const personalityButtons = page.locator('#voice-archetypes button');
    assert.deepEqual(await personalityButtons.allTextContents(), ['Composed','Warm','Blunt','Dry','Unhinged','Upbeat']);
    const personalityBounds = await page.locator('#voice-archetypes').boundingBox();
    const unhinged = page.locator('#voice-archetypes button').filter({hasText:/^Unhinged$/});
    await unhinged.click();
    assert.equal(await unhinged.getAttribute('aria-pressed'),'false');
    assert.match(await page.locator('#ov-personality-help').textContent(), /Select Unhinged again/);
    assert.deepEqual(await page.locator('#voice-archetypes').boundingBox(), personalityBounds, 'confirmation must not shift the selector');
    await unhinged.click();
    assert.equal(await unhinged.getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('#ov-personality-help').textContent(), /Fine-tune later/);
    receipt.checks.push('Six canonical personalities; accessible two-press confirmation without layout shift');
    await page.locator('#voice-archetypes button').nth(1).click();
    const persona = await page.locator('#voice-archetypes .sel').textContent();
    await page.locator('#in-name').press('Enter');
    assert(await page.locator('#ov-identity').isHidden());
    assert(await page.locator('#btn-wake').isVisible());
    assert.equal(await page.locator('.prov-grid .prov:visible').count(),16);
    assert.equal(await page.locator('.prov-grid .ov-provider-logo').count(),16);
    for (const logo of await page.locator('.prov-grid .prov').evaluateAll(buttons => buttons.map(button=>button.dataset.prov))) {
      const response = await page.request.get('http://127.0.0.1:9217/assets/brand/providers/'+logo+'.svg');
      assert(response.ok() && (await response.text()).includes('<svg'),logo+' is bundled');
    }
    const hero = page.locator('.prov[data-prov="starnet"]');
    await hero.waitFor({state:'visible'});
    assert.equal(connections,0,'automatic selection must never launch account connection');
    const [popup] = await Promise.all([page.waitForEvent('popup'),hero.evaluate(el => { el.click(); el.click(); })]);
    await popup.waitForLoadState();
    assert(popup.url().endsWith('/overseer-account-preview'));
    assert.equal(connections,1,'rapid repeat clicks create one connection request');
    await popup.close();
    await page.locator('#ov-change-provider').click();
    await page.locator('.prov[data-prov="custom"]').click();
    rejectConnection = true;
    await page.locator('#ov-change-provider').click();
    await hero.click();
    await page.waitForFunction(()=>document.querySelector('#connect-msg').textContent.includes('try again'));
    assert.equal(connections,2);
    assert(await hero.isEnabled());
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await hero.evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    receipt.checks.push('Unfiltered character gallery, all 16 bundled provider logos, single-click account window, duplicate-click guard, failure feedback, reduced motion');
    await page.locator('#ov-change-provider').click();
    await page.locator('.prov[data-prov="custom"]').click();
    await page.locator('#in-base-url').fill('http://127.0.0.1:11434/v1');
    await page.locator('#btn-back').click();
    assert.equal(await page.locator('#in-name').inputValue(), 'ORION');
    assert.equal(await page.locator('#voice-archetypes .sel').textContent(), persona);
    assert.equal(await page.locator('#skin-stage-name').textContent(), skin);
    assert.equal(await page.locator('#np-mode').textContent(), approval);
    await page.locator('#btn-setup-next').click();
    assert.equal(await page.locator('#in-base-url').inputValue(), 'http://127.0.0.1:11434/v1');
    receipt.checks.push('Name preview and Enter to continue; appearance, approval, personality and endpoint survive backtracking');
    await page.locator('#in-base-url').fill('');
    await page.locator('#btn-wake').click();
    await page.waitForFunction(() => document.querySelector('#connect-msg').textContent.includes('base URL'));
    assert(await page.locator('#btn-wake').isEnabled());
    receipt.checks.push('Missing endpoint gives an accessible validation message and allows retry');
    // Exercise the actual catalog controller with a deterministic provider catalog.
    await page.route('**/api/models/anthropic*', route => route.fulfill({json:{models:[
      {id:'claude-sonnet-4-5',name:'Claude Sonnet 4.5',supportsReasoning:true,supported_parameters:['reasoning']},
      {id:'claude-opus-4-1',name:'Claude Opus 4.1',supportsReasoning:true,supported_parameters:['reasoning']}
    ]}}));
    await page.locator('#ov-change-provider').click();
    await page.locator('.prov[data-prov="anthropic"]').click();
    await page.waitForFunction(()=>document.querySelector('#model-count').textContent.includes('2 in catalog'));
    const beforeModel = await page.locator('#in-model').inputValue();
    await page.locator('#ov-model-open').click();
    assert(await page.locator('#ov-model-dialog').isVisible());
    await page.locator('#in-model').fill('opus');
    assert.equal(await page.locator('#model-pop .ov-mdl-row').count(),1);
    await page.locator('#in-model').press('Escape');
    assert(await page.locator('#ov-model-dialog').isHidden());
    assert.equal(await page.locator('#in-model').inputValue(),beforeModel,'cancel restores prior model');
    await page.locator('#ov-model-open').click();
    await page.locator('#in-model').fill('opus');
    await page.locator('#in-model').press('ArrowDown');
    await page.locator('#in-model').press('Enter');
    assert.equal(await page.locator('#in-model').inputValue(),'claude-opus-4-1');
    assert(await page.locator('#ov-model-dialog').isHidden());
    assert((await page.locator('#ov-model-name').textContent()).toLowerCase().includes('opus'));

    const maxReasoning = page.locator('#ov-reasoning-presets button').filter({hasText:'MAX'});
    await maxReasoning.click();
    assert.equal(await maxReasoning.getAttribute('aria-pressed'),'true');
    const chosenEffort = await page.evaluate(()=>Harness.getReasoningEffort('anthropic'));
    await page.locator('.ov-advanced summary').click();
    assert.equal(await page.locator('#ov-reasoning-exact button[aria-pressed="true"]').count(),1);
    await page.locator('#byok-toggle').click();
    assert(await page.locator('#byok-note').isVisible());
    await page.locator('#byok-toggle').click();
    await page.locator('#ov-model-open').click();
    await page.locator('#in-model').fill('my-custom-model-id');
    await page.locator('#ov-model-custom').click();
    assert(await page.locator('#ov-model-dialog').isHidden());
    assert.equal(await page.locator('#in-model').inputValue(),'my-custom-model-id');
    await page.locator('#btn-back').click();
    await page.locator('#btn-setup-next').click();
    assert.equal(await page.evaluate(()=>Harness.getReasoningEffort('anthropic')),chosenEffort);
    receipt.checks.push('Glass catalog: filtered results, keyboard selection, Escape restores prior model, explicit custom ID, advanced reasoning and key details, persisted reasoning');
    for (const [width, height] of [[1280,800],[1024,600],[700,650],[390,740]]) {
      await page.setViewportSize({ width, height });
      for (const step of ['identity','brain']) {
        await page.locator('button[data-setup-step="'+step+'"]').click();
        const shape = await page.locator('#screen-connect').evaluate(screen => {
          const grid = screen.querySelector('.ov-grid');
          const action = screen.querySelector('[data-setup-step]') && screen.querySelector(screen.dataset.setupStep === 'brain' ? '#btn-wake' : '#btn-setup-next');
          const box = action.getBoundingClientRect();
          const panel = screen.querySelector('.ov-panel').getBoundingClientRect();
          return { fullWidth: Math.abs(panel.width-screen.getBoundingClientRect().width)<2, overflow: Math.max(grid.scrollWidth-grid.clientWidth,...[...screen.querySelectorAll('.ov-cfg')].filter(el=>el.getClientRects().length).map(el=>el.scrollWidth-el.clientWidth)), bottom: box.bottom, right: box.right, visible: box.height > 0, badPaint: [...screen.querySelectorAll('button,input')].filter(el => el.getClientRects().length).filter(el => ['rgb(255, 255, 255)','rgb(239, 239, 239)'].includes(getComputedStyle(el).backgroundColor)).length };
        });
        assert(shape.overflow <= 2, JSON.stringify({width,height,step,...shape}));
        assert(shape.visible && shape.bottom <= height+1 && shape.right <= width+1, JSON.stringify({width,height,step,...shape}));
        assert.equal(shape.badPaint,0);
        assert(shape.fullWidth,'creation fills its screen');
        receipt.checks.push({width,height,step,...shape});
      }
    }
    for (const [width,height] of [[1280,800],[1024,600],[390,740]]) {
      await page.setViewportSize({width,height});
      await page.locator('#ov-model-open').click();
      const box = await page.locator('#ov-model-dialog').boundingBox();
      assert(box.x>=0 && box.y>=0 && box.x+box.width<=width+1 && box.y+box.height<=height+1,JSON.stringify({width,height,box}));
      await page.locator('#ov-model-cancel').click();
    }
    receipt.checks.push('Model sheet fits desktop, short and mobile viewports with reachable close control');
    await page.setViewportSize({width:1280,height:800});
    await page.locator('button[data-setup-step="identity"]').click();
    const swatches = page.locator('#phosphor-swatches button');
    const materials = new Set();
    for (let index=0; index<await swatches.count(); index++) {
      await swatches.nth(index).click();
      materials.add(await page.locator('#screen-connect .ov-panel').evaluate(el => getComputedStyle(el).backgroundImage));
      assert.equal(await swatches.nth(index).getAttribute('aria-pressed'),'true');
    }
    assert(materials.size > 1);
    await page.evaluate(() => document.body.style.zoom = '1.45');
    await page.locator('#btn-setup-next').click();
    const zoomed = await page.locator('#btn-wake').boundingBox();
    assert(zoomed.y+zoomed.height<=800 && zoomed.x+zoomed.width<=1280);
    await page.evaluate(() => document.body.style.zoom = '');
    receipt.checks.push('Phosphor selection updates the glass material; Wake remains reachable at 145% UI scale');
    // Recovery uses the same controller but never offers identity editing or a setup next step.
    await page.evaluate(() => OverseerSetup.init(true));
    assert(await page.locator('.ov-setup-nav').isHidden());
    assert(await page.locator('#ov-identity').isHidden());
    assert(await page.locator('#btn-wake').isVisible());
    receipt.checks.push('Recovery controller opens connection directly');
    const recoveryPage = await browser.newPage();
    recoveryPage.on('pageerror', error => receipt.errors.push(error.message));
    // Suppress only the development credential shortcut; the real seeded save must route to RESUME.
    await recoveryPage.addInitScript(() => Object.defineProperty(window, '__STARNET_DEV__', { get: () => undefined, set: () => {} }));
    await recoveryPage.goto(process.argv[2] || 'http://127.0.0.1:9217/');
    await recoveryPage.locator('#screen-connect.recovery').waitFor();
    assert.equal(await recoveryPage.locator('#in-name').inputValue(), 'NOVA');
    assert.equal(await recoveryPage.locator('#in-name').getAttribute('readonly'), '');
    assert(await recoveryPage.locator('.ov-setup-nav').isHidden());
    assert(await recoveryPage.locator('#ov-brain').isVisible());
    assert((await recoveryPage.locator('#btn-wake').textContent()).includes('RESUME'));
    receipt.checks.push('Real saved-station boot routes to RESUME with preserved identity and connection directly visible');
    assert.deepEqual(receipt.errors, []);
    receipt.pass = true;
  } catch (error) { receipt.pass = false; receipt.failure = error.stack; process.exitCode = 1; }
  finally { console.log(JSON.stringify(receipt,null,2)); await browser.close(); }
})();
