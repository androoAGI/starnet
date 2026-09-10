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
    await page.goto(process.argv[2] || 'http://127.0.0.1:9217/');
    await page.locator('#sp-press').click();
    await page.locator('#in-name').fill('ORION');
    assert.equal(await page.locator('#np-name').textContent(), 'ORION');
    assert(await page.locator('#ov-brain').isHidden());
    await page.locator('#skin-picker .skin-thumb').nth(1).click();
    const skin = await page.locator('#skin-stage-name').textContent();
    await page.locator('#approval-picker button').nth(1).click();
    const approval = await page.locator('#np-mode').textContent();
    await page.locator('#voice-archetypes button').nth(1).click();
    const persona = await page.locator('#voice-archetypes .sel').textContent();
    await page.locator('#in-name').press('Enter');
    assert(await page.locator('#ov-identity').isHidden());
    assert(await page.locator('#btn-wake').isVisible());
    await page.locator('#prov-more').click();
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
    for (const [width, height] of [[1280,800],[1024,600],[700,650],[390,740]]) {
      await page.setViewportSize({ width, height });
      for (const step of ['identity','brain']) {
        await page.locator('button[data-setup-step="'+step+'"]').click();
        const shape = await page.locator('#screen-connect').evaluate(screen => {
          const grid = screen.querySelector('.ov-grid');
          const action = screen.querySelector('[data-setup-step]') && screen.querySelector(screen.dataset.setupStep === 'brain' ? '#btn-wake' : '#btn-setup-next');
          const box = action.getBoundingClientRect();
          return { overflow: grid.scrollWidth-grid.clientWidth, bottom: box.bottom, right: box.right, visible: box.height > 0, badPaint: [...screen.querySelectorAll('button,input')].filter(el => el.getClientRects().length).filter(el => ['rgb(255, 255, 255)','rgb(239, 239, 239)'].includes(getComputedStyle(el).backgroundColor)).length };
        });
        assert(shape.overflow <= 2, JSON.stringify({width,height,step,...shape}));
        assert(shape.visible && shape.bottom <= height+1 && shape.right <= width+1, JSON.stringify({width,height,step,...shape}));
        assert.equal(shape.badPaint,0);
        receipt.checks.push({width,height,step,...shape});
      }
    }
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
