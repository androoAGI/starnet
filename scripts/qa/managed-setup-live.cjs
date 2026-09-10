'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.STARNET_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.STARNET_CHROME ? { executablePath: process.env.STARNET_CHROME } : {}) });
  const proof = { scope: 'Live seeded app, simulated credits/catalog responses; no paid inference.', pageErrors: [] };
  const activation = process.argv[3] || 'banner';
  proof.activation = activation;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => proof.pageErrors.push(e.message));
    await page.route('**/api/credits?*', route => route.fulfill({ json: { configured: true, balanceUsd: 100 } }));
    await page.route('**/api/models/*', route => {
      const p = new URL(route.request().url()).pathname.split('/').pop();
      return route.fulfill({ json: { models: p === 'starnet' ? [{ id: 'anthropic/test-model', name: 'Managed test model' }] : [], ...(p === 'starnet' ? {} : { error: 'not configured' }) } });
    });
    await page.goto(process.argv[2] || 'http://127.0.0.1:19316/');
    await page.waitForSelector('#screen-game.active');
    await page.evaluate(async () => {
      await Harness.refreshCreditsConfigured();
      Harness.listModels = async () => []; // keep unavailable-provider fallback probes local too
      Harness.setProv('anthropic'); Harness.setModel('claude-test');
      App.currentAgent().onboarded = true;
      KeyCTA.arm(); KeyCTA.refresh();
    });
    const warning = page.getByText(/there’s no ANTHROPIC key on the station/);
    await warning.waitFor();
    proof.initialWarning = await warning.count();
    // Keep the inherited empty selection from the report, then use the real Settings card.
    await page.evaluate(() => { Harness.setModel(''); ModelDock.reflect(); });
    await page.locator('#bottombar [data-group="system"] > .bb-grp').click();
    await page.locator('#bottombar [data-term="settings"]').click();
    await page.locator('.prov-card[data-provider="starnet"]').click();
    await page.waitForFunction(() => Harness.getProv() === 'starnet' && KeyCTA.gapOf()?.kind === 'nomodel');
    assert.equal(await warning.count(), 0);
    assert.equal(await page.getByRole('button', { name: /ADD ANTHROPIC KEY/ }).count(), 0);
    await page.locator('.term:not(.term-closing) .term-x').click();
    await page.waitForFunction(() => !document.querySelector('.term'));
    proof.emptyModel = await page.evaluate(() => ({ gap: KeyCTA.gapOf(), label: document.getElementById('model-dock-toggle').textContent }));
    assert.match(proof.emptyModel.label, /CHOOSE MODEL/);
    if (activation === 'banner') await page.locator('#key-cta .key-cta-act').click();
    else {
      const choose = page.locator('.choice-row button').filter({ hasText: 'CHOOSE MODEL' });
      if (activation === 'keyboard') await choose.press('Enter'); else await choose.click();
    }
    try { await page.locator('.model-dock-row[data-provider="starnet"]').click({ timeout: 7000 }); }
    catch (e) {
      console.log(await page.evaluate(() => ({ provider: Harness.getProv(), model: Harness.getModel(), revision: Harness.getSelectionRevision(), gap: KeyCTA.gapOf(), hidden: document.getElementById('model-dock').hidden, list: document.getElementById('model-dock-list').innerText, body: document.body.innerText.slice(-1800) })));
      throw e;
    }
    await page.waitForFunction(() => Harness.getModel() === 'anthropic/test-model' && !KeyCTA.gapOf());
    proof.selected = await page.evaluate(() => ({ provider: Harness.getProv(), model: Harness.getModel(), bannerHidden: document.getElementById('key-cta').hidden }));
    assert.equal(proof.selected.provider, 'starnet');
    assert.equal(proof.selected.bannerHidden, true);
    assert.equal(await page.getByText(/no model is selected for STARNET/).count(), 0);
    // Retirement is scoped: another producer's choices survive a resolved setup warning.
    proof.unrelatedChoicesSurvive = await page.evaluate(() => {
      Harness.setModel(''); KeyCTA.refresh();
      const other = Chat.choices([{ label: 'UNRELATED TEST CHOICE', value: 'test' }], () => {});
      Harness.setModel('anthropic/test-model'); KeyCTA.refresh();
      const survived = other.isConnected; other.dismiss(); return survived;
    });
    assert.equal(proof.unrelatedChoicesSurvive, true);
    proof.lateCatalog = await page.evaluate(async () => {
      const original = Harness.apiFetch;
      let release, begin;
      const started = new Promise(r => begin = r), held = new Promise(r => release = r);
      Harness.apiFetch = async (url, options) => {
        if (url === '/api/models/ollama') { begin(); await held; return new Response(JSON.stringify({ models: [{ id: 'qwen3:14b' }] })); }
        return original(url, options);
      };
      try {
        Harness.setProv('ollama'); Harness.setModel('qwen3:14b');
        const pending = ModelDock.refresh(); await started;
        Harness.setProv('starnet'); Harness.setModel('anthropic/test-model');
        release(); await pending;
        return { provider: Harness.getProv(), model: Harness.getModel() };
      } finally { Harness.apiFetch = original; }
    });
    assert.deepEqual(proof.lateCatalog, { provider: 'starnet', model: 'anthropic/test-model' });
    assert.deepEqual(proof.pageErrors, []);
    fs.mkdirSync('qa/evidence/managed-setup-0910', { recursive: true });
    fs.writeFileSync('qa/evidence/managed-setup-0910/live-' + activation + '.json', JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(proof, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
