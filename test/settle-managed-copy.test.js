/* test/settle-managed-copy.test.js — SETTINGS › SPENDING LIMITS › INTERRUPTED tells you WHERE the charge is.
   An interrupted run's receipt records whether it ran on StarNet credits (ledger receipt `managed: true`). Its charge
   then shows in the StarNet account's activity (account.starnetos.com), not on a provider dashboard the user never
   had — the old copy told every row to "enter the charge your provider dashboard shows". A BYOK row keeps the
   provider dashboard. Spend-truth lane B6, 2026-10-08. Drives the real wireBudget/paintUnsettled source in a vm with
   fake DOM nodes (the same harness shape as test/budget-authority-ui.test.js). */
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const text = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/stationui.js'), 'utf8');
const code = text.slice(text.indexOf('  const BG_KEYS ='), text.indexOf('  // MODELS panel'));
const tick = () => new Promise(r => setImmediate(r));
const harness = (status) => {
  const mkNode = tag => { const n = { tag, children: [], attrs: {}, style: {}, classList: { toggle() {} }, value: '', _t: '',
    get textContent() { return this._t + this.children.map(c => c.textContent).join(''); }, set textContent(v) { this._t = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener(k, fn) { this[k] = fn; }, focus() {} }; return n; };
  const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, mkNode(id)); return nodes.get(id); };
  const posts = [];
  vm.runInNewContext(code + ';wireBudget(body)', { body: { querySelector: node }, Harness: { api: { get: async () => status, post: async (u, b) => { posts.push([u, b]); return { ok: true, j: status }; } } },
    fmtUsd: n => '$' + n, sfx() {}, document: { createElement: mkNode, createTextNode: t => ({ textContent: String(t) }) } });
  return { node, posts };
};
(async () => {
  const base = { caps: { perRun: 0, perAgent: 0, perDay: 25, global: 0 }, saved: {}, envDefaults: { perRun: 0, perAgent: 0, perDay: 25, global: 0 }, spentToday: null, lifetime: null, runs: 0 };
  const st = { ...base, accounting: { complete: false, durable: true, readError: 'UNSETTLED_SPEND', writeError: null, unsettledRuns: 2 }, atLeast: { today: 1, lifetime: 2, runs: 3 },
    unsettled: [
      { runId: 'm1', agentId: 'agent', ts: Date.now(), title: 'Write the brief', provider: 'starnet', model: 'anthropic/claude-sonnet-5.5', managed: true, runCapUsd: 2 },
      { runId: 'b1', agentId: 'agent', ts: Date.now(), title: 'Fix the build', provider: 'openrouter', model: 'test/m', managed: false, runCapUsd: 0.5 }
    ] };
  const { node, posts } = harness(st); await tick();
  const [managedRow, byokRow] = node('#budget-unsettled').children;
  assert.ok(managedRow && byokRow, 'one row per interrupted run');
  // the StarNet-credit row points at the StarNet account activity, never a provider dashboard
  const mTip = managedRow.attrs['data-tip'];
  assert.match(mTip, /StarNet credits/, 'the managed row says it ran on StarNet credits: ' + mTip);
  assert.match(mTip, /StarNet account activity/, 'and where its charge is: ' + mTip);
  assert.match(mTip, /account\.starnetos\.com/, 'naming the account page: ' + mTip);
  assert.doesNotMatch(mTip, /provider dashboard/, 'not a provider dashboard the user never had');
  const [, mUsd, mSettle, mCount] = managedRow.children;
  assert.match(mUsd.attrs['aria-label'], /what StarNet charged/, 'the amount field asks what StarNet charged');
  assert.match(mCount.attrs['data-tip'], /StarNet account activity has the exact charge/, 'COUNT AS points at the account activity too: ' + mCount.attrs['data-tip']);
  assert.doesNotMatch(mCount.attrs['data-tip'], /provider dashboard/);
  mUsd.value = ''; mSettle.click(); await tick();
  assert.equal(posts.length, 0, 'a blank is not $0');
  assert.match(node('#budget-msg').textContent, /what StarNet charged/, 'the refusal asks for what StarNet charged: ' + node('#budget-msg').textContent);
  // a BYOK row keeps the provider dashboard
  const bTip = byokRow.attrs['data-tip'];
  assert.match(bTip, /provider dashboard/, 'a provider-key row still points at the provider dashboard: ' + bTip);
  assert.doesNotMatch(bTip, /starnetos/);
  const [, bUsd, bSettle, bCount] = byokRow.children;
  assert.match(bUsd.attrs['aria-label'], /what your provider charged/);
  assert.match(bCount.attrs['data-tip'], /provider dashboard has the exact charge/);
  bUsd.value = ''; bSettle.click(); await tick();
  assert.match(node('#budget-msg').textContent, /what your provider charged/);
  // the server's own refusal for a limit-less managed receipt names the same place (index.js handleBudgetSettle)
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar/index.js'), 'utf8');
  const settle = idx.slice(idx.indexOf('async function handleBudgetSettle('), idx.indexOf('async function warmModelCatalogSet('));
  assert.ok(settle.length > 200 && settle.length < 6000, 'handleBudgetSettle found');
  assert.match(settle, /open\.managed === true \? 'this run recorded no per-run limit — enter the charge your StarNet account activity \(account\.starnetos\.com\) shows' : 'this run recorded no per-run limit — enter the charge from your provider dashboard'/,
    'a limit-less managed receipt is pointed at the StarNet account activity');
  console.log('settle-managed-copy: StarNet-credit receipts point at the StarNet account activity, provider-key receipts at the provider dashboard PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
