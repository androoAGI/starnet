'use strict';
/* Pure registry readback plus the actual settings renderer. Unknown facts remain unknown; proposed restart
 * values never masquerade as active caps, and a sign-in/local chat does not inherit a dollar-run cap. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const R = require('../sidecar/limits-registry.js');
const active = { maxIters: 0, maxConcurrentAgents: 0, consentTimeoutMs: 120000, cronTickMs: 60000,
  maxSubscriptionTokens: 9000000, maxUnpricedTokens: 2000000 };
const projection = R.effective({ classes: ['subscription', 'local', 'managed', 'metered'], env: key => key === 'MAX_UNPRICED_TOKENS' ? '2000000' : undefined,
  active, runtimeSaved: { maxIters: 20, maxSubscriptionTokens: 9000000 }, runtimeBootSaved: {},
  budget: { perRun: 0, perAgent: 1, perDay: 5, global: 0 }, budgetSaved: { perDay: 5, perRun: 0 },
  readback: { managedPerRun: { value: 2, source: 'default' }, unknownImageRun: { value: 10, source: 'default' } } });
const row = key => projection.rows.find(r => r.key === key);
assert.deepEqual([row('maxIters').value, row('maxIters').nextValue, row('maxIters').source], [0, 20, 'default'], 'pending restart leaves active value/source truthful');
assert.deepEqual([row('maxSubscriptionTokens').value, row('maxSubscriptionTokens').nextValue, row('maxSubscriptionTokens').source], [9000000, undefined, 'saved'], 'next-run ceiling can be active without restart');
assert.equal(row('maxUnpricedTokens').source, 'env', 'explicit environment source wins');
assert.deepEqual([row('perRun').value, row('perRun').source], [0, 'saved'], 'explicit no-cap is a real saved choice');
assert.deepEqual(row('perRun').inUse, ['metered', 'managed'], 'sign-in/local chat has no dollar-run cap');
assert.ok(row('perDay').inUse.includes('subscription') && row('perDay').inUse.includes('local'), 'paid media keeps cross-run dollar policy');
assert.deepEqual(row('managedPerRun').inUse, ['managed']);
assert.deepEqual(row('maxSubscriptionTokens').inUse, ['subscription']);
assert.deepEqual([row('workerUsd').value, row('workerUsd').source], [null, 'unknown'], 'missing enforcing-owner readback is not the catalog default');
const ui = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
const from = ui.indexOf('  function effectiveLimitsHtml('), to = ui.indexOf('\n  function wireBudget(', from);
assert.ok(from >= 0 && to > from, 'actual settings renderer exists');
const ctx = vm.createContext({ esc: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) });
vm.runInContext(ui.slice(from, to) + '\nthis.render = effectiveLimitsHtml;', ctx);
const html = ctx.render(projection);
assert.match(html, /WHAT|API KEY/, 'current payer groups render');
assert.match(html, /saved: 20; after restart/, 'pending restart disclosed beside active value');
assert.match(html, /Paid images only; chat calls spend no dollars\./, 'plan/local media distinction is visible');
assert.match(html, /unavailable/, 'unknown owner readback stays unavailable');
assert.doesNotMatch(html, /<input|<button|generationId/, 'effective inventory is read-only and does not expose provider handles');
const hostile = { classes: ['subscription'], rows: [{ ...row('maxSubscriptionTokens'), label: '<img src=x onerror=bad>', hint: '<script>bad</script>', where: '"bad"', env: '<bad>' }] };
assert.doesNotMatch(ctx.render(hostile), /<img|<script>|STARNET_<bad>/, 'metadata rendered as text');
assert.match(ctx.render(null), /unavailable/, 'missing API section is not an all-clear');
assert.match(ctx.render({ classes: [], rows: [] }), /No payer is selected/, 'empty payer inventory states its scope');
console.log('effective-limits.test: active/source/payer/unknown/read-only renderer assertions OK');
