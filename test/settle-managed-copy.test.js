/* test/settle-managed-copy.test.js — SETTINGS › SPENDING LIMITS › INTERRUPTED tells you WHERE the charge is.
   An interrupted run's receipt records whether it ran on StarNet credits (ledger receipt `managed: true`). Its charge
   then shows in the STORE's RECENT ACTIVITY (SETTINGS → AI & MODELS), listed by run id, not on a provider dashboard
   the user never had — the old copy told every row to "enter the charge your provider dashboard shows". A BYOK row
   keeps the provider dashboard. Spend-truth lane B6, 2026-10-08. Drives the real wireBudget/paintUnsettled source in a vm with
   fake DOM nodes (the same harness shape as test/budget-authority-ui.test.js). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
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
  // the StarNet-credit row points at the in-app STORE's RECENT ACTIVITY (review 2026-10-08): it lists each charge with
  // its run id, on a linked station AND on an operator (env) station — the account web page has no run ids, and an
  // operator station's charges are not on account.starnetos.com at all
  const mTip = managedRow.attrs['data-tip'];
  assert.match(mTip, /StarNet credits/, 'the managed row says it ran on StarNet credits: ' + mTip);
  assert.match(mTip, /SETTINGS → AI & MODELS › STORE › RECENT ACTIVITY/, 'and where its charge is: ' + mTip);
  assert.match(mTip, /run m1\b/, 'naming the run id the activity lists it under: ' + mTip);
  assert.doesNotMatch(mTip, /account\.starnetos\.com/, 'no hardcoded account host');
  assert.doesNotMatch(mTip, /provider dashboard/, 'not a provider dashboard the user never had');
  const [, mUsd, mSettle, mCount] = managedRow.children;
  assert.match(mUsd.attrs['aria-label'], /what StarNet charged/, 'the amount field asks what StarNet charged');
  assert.match(mCount.attrs['data-tip'], /the STORE’s RECENT ACTIVITY has the exact charge/, 'COUNT AS points at the same activity: ' + mCount.attrs['data-tip']);
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
  // Legacy receipts cannot identify who billed the run, even if a provider label survives.
  for (const managed of [undefined, null, 'false']) {
    const unknown = {runId:'legacy', agentId:'legacy', provider:'starnet', managed, runCapUsd:null};
    const h = harness({...st, unsettled:[unknown]}); await tick();
    const row = h.node('#budget-unsettled').children[0];
    assert.match(row.attrs['data-tip'], /billing source was not recorded/);
    assert.doesNotMatch(row.attrs['data-tip'], /Enter the charge your provider dashboard|it ran on your StarNet credits/);
    assert.match(row.children[1].attrs['aria-label'], /verified charge/);
    assert.match(row.children[0].textContent, /BILLING SOURCE UNKNOWN/);
    assert.equal(row.children.length, 3, 'missing cap is never invented');
    row.children[2].click(); await tick();
    assert.equal(h.posts.length,0,'blank unknown charge must not become zero');
  }
  const cappedUnknown = harness({...st,unsettled:[{runId:'unknown-cap',agentId:'agent',managed:null,runCapUsd:1}]}); await tick();
  const unknownCount=cappedUnknown.node('#budget-unsettled').children[0].children[3];
  assert.match(unknownCount.attrs['data-tip'],/verify the exact charge in the original billing records/);
  assert.doesNotMatch(unknownCount.attrs['data-tip'],/provider dashboard|STORE/,'recorded cap cannot establish billing provenance');
  // security-storage-07: a skill evaluation run (budgetUnsettledRuns tags it kind 'evaluation') was not interrupted;
  // its provider call has no recorded price. The row says UNPRICED, and the settled message does not call it interrupted.
  const evalRun = { runId: 'skill-eval-abc-1-before-0123456789ab', agentId: 'agent', ts: Date.now(), title: 'skill evaluation (agent)', kind: 'evaluation',
    provider: 'openrouter', model: 'test/m', managed: false, runCapUsd: 0.5 };
  const ev = harness({ ...st, unsettled: [evalRun, st.unsettled[1]] }); await tick();
  const [evalRow, plainRow] = ev.node('#budget-unsettled').children;
  assert.match(evalRow.children[0].textContent, /^UNPRICED — skill evaluation \(agent\)/, 'an evaluation row is UNPRICED: ' + evalRow.children[0].textContent);
  assert.doesNotMatch(evalRow.children[0].textContent, /INTERRUPTED/);
  assert.match(evalRow.attrs['data-tip'], /^This skill evaluation run has no recorded price/, 'its tip says what is missing: ' + evalRow.attrs['data-tip']);
  assert.doesNotMatch(evalRow.attrs['data-tip'], /stopped before/, 'and does not say it stopped');
  assert.match(evalRow.attrs['data-tip'], /Enter the charge your provider dashboard shows for it/, 'it keeps where to find the charge');
  assert.match(plainRow.children[0].textContent, /^INTERRUPTED — Fix the build/, 'every other row stays INTERRUPTED');
  evalRow.children[3].click(); await tick();
  assert.match(ev.node('#budget-msg').textContent, /skill evaluation run settled/, 'the settled message names the evaluation: ' + ev.node('#budget-msg').textContent);
  plainRow.children[3].click(); await tick();
  assert.match(ev.node('#budget-msg').textContent, /interrupted run settled/, 'a plain run still settles as an interrupted run');
  // the spend line above the rows tells the same story: an unpriced evaluation is never counted as an interrupted run
  const evalRun2 = { ...evalRun, runId: 'skill-eval-abc-2-after-0123456789ab' };
  for (const [unsettled, re, settle] of [
    [[evalRun], /— a skill evaluation run has no recorded price, so your spending limits can’t be checked\./, /Settle it below/],
    [[evalRun, evalRun2], /— 2 skill evaluation runs have no recorded price, so/, /Settle each below/],
    [[evalRun, st.unsettled[1]], /— 2 runs never recorded what they spent, so/, /Settle each below/]
  ]) {
    const h = harness({ ...st, unsettled }); await tick();
    const line = h.node('#budget-spend').textContent;
    assert.match(line, re, 'the spend line names what is missing: ' + line);
    assert.match(line, settle);
    assert.doesNotMatch(line, /interrupted/, 'an evaluation is never counted as an interrupted run: ' + line);
  }
  // d688ea20: an unreadable line of the spend record (kind 'damaged') is listed to settle, and is never called a run
  // that was interrupted, nor told its billing source is unknown (it is a damaged line, not a run with a receipt)
  const damagedLine = { runId: 'damaged-0123456789abcdef01234567', agentId: 'nova', ts: Date.now(), title: 'unreadable spend record line (run old-a)', kind: 'damaged', provider: null, model: 'deepseek/deepseek-chat', managed: null, runCapUsd: null };
  const dm = harness({ ...st, unsettled: [damagedLine] }); await tick();
  const dRow = dm.node('#budget-unsettled').children[0];
  assert.match(dRow.children[0].textContent, /^DAMAGED RECORD — unreadable spend record line \(run old-a\)/, dRow.children[0].textContent);
  assert.doesNotMatch(dRow.children[0].textContent, /INTERRUPTED|BILLING SOURCE UNKNOWN/);
  assert.match(dRow.attrs['data-tip'], /^One line of your spend record could not be read/, dRow.attrs['data-tip']);
  assert.match(dRow.attrs['data-tip'], /it names deepseek\/deepseek-chat/);
  assert.match(dRow.attrs['data-tip'], /keeps the damaged line untouched/);
  assert.doesNotMatch(dRow.attrs['data-tip'], /stopped before/);
  assert.equal(dRow.children.length, 3, 'no COUNT AS: a damaged line recorded no limit');
  dRow.children[2].click(); await tick();
  assert.equal(dm.posts.length, 0, 'a blank charge is never booked as $0');
  assert.match(dm.node('#budget-spend').textContent, /— a line of your spend record is damaged \(what it recorded is unknown\), so your spending limits can’t be checked\. Settle it below/, dm.node('#budget-spend').textContent);
  dRow.children[1].value = '0.3'; dRow.children[2].click(); await tick();
  assert.match(dm.node('#budget-msg').textContent, /damaged record line settled/, dm.node('#budget-msg').textContent);
  const mixed = harness({ ...st, unsettled: [damagedLine, st.unsettled[1]] }); await tick();
  assert.match(mixed.node('#budget-spend').textContent, /— 2 items in your spend history have no recorded charge, so/, mixed.node('#budget-spend').textContent);
  // every skill evaluation run id opens with the runner's 'skill-eval-' namespace, so its first 8 chars are the same for
  // all of them: the tip and RECENT ACTIVITY both name its evaluation, serial and phase instead (one helper, same words)
  const evalId = 'skill-eval-3f2a9c1d-7b4e-4c1a-9d2e-0123456789ab';
  const managedEval = { ...evalRun, runId: evalId + '-2-after-0123456789ab', provider: 'starnet', managed: true };
  const me = harness({ ...st, unsettled: [managedEval, { ...managedEval, runId: evalId + '-1-before-0123456789ab' }] }); await tick();
  const [meAfter, meBefore] = me.node('#budget-unsettled').children;
  assert.match(meAfter.attrs['data-tip'], /RECENT ACTIVITY lists those charges as skill eval 3f2a9c1d-2-after:/, 'the tip names this evaluation run: ' + meAfter.attrs['data-tip']);
  assert.match(meBefore.attrs['data-tip'], /lists those charges as skill eval 3f2a9c1d-1-before:/, 'and tells the two runs apart: ' + meBefore.attrs['data-tip']);
  assert.doesNotMatch(meAfter.attrs['data-tip'], /run skill-ev/, 'never the shared namespace');
  const runTag = vm.runInNewContext(code + ';creditRunTag', {});
  assert.equal(runTag('m1'), 'run m1', 'a plain run keeps its first 8 chars');
  assert.equal(runTag('run-0123456789'), 'run run-0123');
  assert.equal(runTag(managedEval.runId), 'skill eval 3f2a9c1d-2-after');
  assert.equal(runTag('skill-eval-odd'), 'run skill-ev', 'an id that is not the runner shape falls back to the plain tag');
  const idx = readSidecarSource();
  const settle = idx.slice(idx.indexOf('async function handleBudgetSettle('), idx.indexOf('async function warmModelCatalogSet('));
  assert.ok(settle.length > 200 && settle.length < 6000, 'handleBudgetSettle found');
  assert.match(settle, /open\.managed === true \? 'this run recorded no per-run limit — enter what StarNet charged for it \(SETTINGS → AI & MODELS › STORE › RECENT ACTIVITY lists each charge with its run id\)' : open\.managed === false \? 'this run recorded no per-run limit — enter the charge from your provider dashboard'/,
    'a limit-less managed receipt is pointed at the STORE’s RECENT ACTIVITY');
  // the door exists: the configured STORE renders a RECENT ACTIVITY list whose rows carry the run id
  assert.match(text, /<h4 class="ms-h">STORE /, 'the STORE heading exists under AI & MODELS');
  assert.match(text, /RECENT ACTIVITY<\/span>/, 'with its RECENT ACTIVITY list');
  assert.match(text, /e && e\.runId \? ' · ' \+ esc\(creditRunTag\(e\.runId\)\)/, 'whose rows show the run tag the tip names (first 8 chars, or a skill evaluation\'s own id)');
  console.log('settle-managed-copy: StarNet-credit receipts point at the STORE’s RECENT ACTIVITY, provider-key receipts at the provider dashboard PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
