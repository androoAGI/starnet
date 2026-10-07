/* node test/nightshift-budget.e2e.test.js — a night-shift beat must NOT burn a leash unit on a run that could never
   reach a model call. Two pre-spend stand-downs the old nightshiftPrecheck never checked (LANE L):

   THE WART: the leash is spent at ACCEPT time (nightshift-driver.js — setState(recordBeat) then fire). The only
   pre-spend gate was the READINESS precheck; it never consulted the cross-run BUDGET pools or provider capability.
   So with the day/global/agent pool exhausted, a beat's first model call died with reason 'budget' AFTER the leash
   unit was already spent (loop.js) — every attempt burned leash on a run that made ZERO model calls. Same shape for
   a missing provider (stand-down 'no-capability' AFTER the spend).

   This boots the ACTUAL sidecar (no mock provider needed — a pre-spend stand-down never reaches a model) and proves,
   over HTTP at GET /api/nightshift/status (which folds the precheck via statusDecision, so status == what the tick
   would do), the two new pre-spend declines:
     · NO runnable provider  → binding:'no-provider' (the pure gates clear, but the beat could not call anything).
     · a cross-run budget POOL exhausted (seeded ledger) → binding:'budget', and it OUTRANKS 'no-provider' (an
       exhausted pool is the actionable reason). Both stand down BEFORE the leash is spent. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const BUDGET = path.resolve(__dirname, '..', 'sidecar', 'budget.js');
const FAULT_BOOT = 'const b=require(' + JSON.stringify(BUDGET) + '),mk=b.makeBudget;' +
  'b.makeBudget=(...a)=>{const v=mk(...a);v.check=()=>{throw new Error("injected precheck read failure")};return v};' +
  'require(' + JSON.stringify(INDEX) + ');';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// clear any AMBIENT OpenRouter key from the parent env so "no runnable provider" is deterministic (the dev seed holds
// NO secret — the key lives only in runtimeKey, sourced from these envs; blanking them removes the credential).
const NO_KEY = { OPENROUTER_KEY: '', OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '' };

function boot(port, env, attemptsLeft, injectBudgetFault) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, injectBudgetFault ? ['-e', FAULT_BOOT] : [INDEX], { env: Object.assign({}, process.env, NO_KEY, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1, injectBudgetFault)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}
function kill(child) { return new Promise(r => { try { child.on('exit', () => r()); child.kill(); } catch (_) { r(); } setTimeout(r, 3000); }); }

// raise the autonomy dial (arms the shift + clears the posture gate), let the 1ms away threshold elapse, read status.
async function armAndStatus(B) {
  const token = await bootToken(B, B);
  const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
  const arm = await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'observe', leashPerDay: 3 } }) })).json();
  A.ok(arm.ok === true && arm.nightshiftArmed === true, 'raising the dial arms the night shift');
  await sleep(40);   // let the 1ms away threshold elapse so the pure gates get PAST 'present' → the precheck runs
  return (await fetch(B + '/api/nightshift/status', { headers })).json();
}

(async () => {
  // ===== 1. NO runnable provider → a pre-spend 'no-provider' stand-down (the pure gates clear, but no model call
  //         is reachable — declining here spends NO leash) =====
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsbudget-noprov-'));
    const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_NIGHTSHIFT_AWAY_MS: '1' };
    let { child, port } = await boot(8940 + (process.pid % 25), env, 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const s = await armAndStatus(B);
      A.eq(s.binding, 'no-provider', 'no runnable provider → binding:no-provider (pre-spend, before the leash is spent)');
      A.eq(s.beatsUsedToday, 0, 'the no-provider stand-down spent no leash');
    } finally {
      await kill(child);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ===== 2. a cross-run BUDGET pool is exhausted → a pre-spend 'budget' stand-down that OUTRANKS 'no-provider' =====
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsbudget-exhausted-'));
    // seed the spend ledger with a finished run that blows the governed pools and lands in the trailing-day
    // window (ts ~ now), so budget.check reports the pool blocked at boot. The shipped defaults are now
    // UNGOVERNED (budget-legibility pass 2026-07-23), so the pools under test are pinned via env.
    const rec = { runId: 'seed-exhaust', agentId: 'agent', turns: 1, usd: 999, tokens: 1000, model: 'seed', ts: Date.now() };
    fs.writeFileSync(path.join(ws, 'ledger.jsonl'), JSON.stringify(rec) + '\n');
    const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_BUDGET_PER_AGENT: '5', SKYNET_BUDGET_PER_DAY: '40', SKYNET_BUDGET_GLOBAL: '100' };
    let { child, port } = await boot(8980 + (process.pid % 25), env, 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const s = await armAndStatus(B);
      A.eq(s.binding, 'budget', 'an exhausted cross-run budget pool → binding:budget (outranks no-provider; keys are also blank)');
      A.eq(s.beatsUsedToday, 0, 'the budget stand-down spent no leash (the cold-leash wart is fixed)');
    } finally {
      await kill(child);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ===== 2b. spend history UNKNOWN (an interrupted run's dispatch receipt) under a CHOSEN cap → 'spend-unknown', never
  //          'budget': the budget is not exhausted, and no resume or cap change would clear it =====
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsbudget-unknown-'));
    const dir = path.join(ws, '.spend-pending');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, require('crypto').createHash('sha256').update('interrupted').digest('hex') + '.json'), JSON.stringify({ runId: 'interrupted', agentId: 'agent' }));
    const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_BUDGET_PER_DAY: '40' };
    let { child, port } = await boot(9000 + (process.pid % 25), env, 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const s = await armAndStatus(B);
      A.eq(s.binding, 'spend-unknown', 'unknown spend history under a chosen cap → binding:spend-unknown (not an "exhausted" budget)');
      A.eq(s.beatsUsedToday, 0, 'the spend-unknown stand-down spent no leash');
    } finally {
      await kill(child);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ===== 3. PRECHECK INSPECTION FAILURE -> fail closed, spend nothing, and leave a truthful durable decision =====
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsbudget-precheck-fault-'));
    const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_TICK_MS: '10' };
    let { child, port } = await boot(9020 + (process.pid % 25), env, 20, true);
    const B = 'http://' + HOST + ':' + port;
    try {
      const s = await armAndStatus(B);
      A.eq(s.binding, 'precheck-error', 'a thrown budget/provider/readiness inspection stands down as precheck-error');
      A.eq(s.beatsUsedToday, 0, 'the unproven safety gate spends no leash');
      await sleep(80); // let the real server-owned tick persist at least one decline
      const token = await bootToken(B, B);
      const headers = { 'X-StarNet-Token': token, Origin: B };
      const body = await (await fetch(B + '/api/autonomy/ledger', { headers })).json();
      const decline = (body.entries || []).find(e => e.source === 'nightshift' && e.kind === 'decline' && e.binding === 'precheck-error');
      A.ok(decline && decline.detail && decline.detail.preSpend === true, 'the real sidecar ledger records the failed inspection as a pre-spend decline');
      A.ok(fs.existsSync(path.join(ws, 'autonomy.ledger.jsonl')), 'the fail-closed decision is durable on disk');
    } finally {
      await kill(child);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('nightshift-budget.e2e.test');
})().catch(e => { console.error('nightshift-budget.e2e.test FAILED:', e); process.exit(1); });
