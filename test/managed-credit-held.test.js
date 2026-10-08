/* test/managed-credit-held.test.js — a StarNet balance HELD by a running run is not an empty wallet.
   Audit B11 (code-read, 2026-10-07): with PER RUN at or above the balance, admission clamps the run's reservation to
   the whole wallet; a concurrent or delegated StarNet run would then be refused "Out of managed credit — add credits",
   the same false top-up Chris got. Reproduced here against both backend modes the cloud supports
   (starnet-cloud src/app.js debitOrCredit):
     • PROXY-METERED (production): the reserve/settle debit+credit are ADVISORY — the cloud echoes the true balance
       and never subtracts a reservation — so the second run is ADMITTED. No refusal, nothing to relabel.
     • LEDGER (proxy off — env credits-only deploys): the reservation is a real debit, the refreshed balance reads $0,
       and the second run was refused as out of credit while the money sat in the first run's hold.
   Only the ledger case may say "held", and only when the backend itself acknowledged the hold as a real debit.
   Drives the real credits.js + billing.js + budgetcaps.managedRunCapUsd with the host's admission order
   (refresh → snapshot → clamp → beginRun), then the COMMS copy (friendlyerror.js) of the refusal. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { makeCredits } = require('../sidecar/credits.js');
const budgetCaps = require('../sidecar/budgetcaps.js');
const Friendly = require('../frontend/app/friendlyerror.js');

const tick = () => new Promise(r => setImmediate(r));
function fakeCloud(mode, start) {
  const st = { balance: start, debits: [] };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (url.includes('/v1/balance')) return reply(200, { balanceUsd: st.balance });
    if (url.includes('/v1/debit')) {
      st.debits.push(body);
      if (mode === 'ledger') st.balance = Math.round((st.balance - body.usd) * 1e6) / 1e6;
      return reply(200, mode === 'ledger' ? { ok: true, balanceUsd: st.balance } : { ok: true, balanceUsd: st.balance, advisory: true });
    }
    if (url.includes('/v1/credit')) {
      if (mode === 'ledger') st.balance = Math.round((st.balance + body.usd) * 1e6) / 1e6;
      return reply(200, mode === 'ledger' ? { ok: true, balanceUsd: st.balance } : { ok: true, balanceUsd: st.balance, advisory: true });
    }
    return reply(404, {});
  };
  return { st, fetch };
}
// the host's admission (sidecar/index.js runAgent, managed-credit admission) with the refusal it would raise
async function admit(credits, runId, chosenCap) {
  await credits.refresh();
  const snap = credits.snapshot();
  const avail = (snap && typeof snap.balanceUsd === 'number' && isFinite(snap.balanceUsd)) ? snap.balanceUsd : NaN;
  const cap = budgetCaps.managedRunCapUsd(chosenCap, avail, budgetCaps.DEFAULT_MANAGED_PER_RUN_USD);
  if (!(cap > 0)) return { refused: isFinite(avail) ? 'exhausted' : 'unavailable', held: typeof credits.held === 'function' ? credits.held() : null };
  const adm = credits.beginRun({ runId, agentId: 'agent', capUsd: cap });
  if (!adm || adm.ok === false) return { refused: adm && adm.reason === 'managed_credits_exhausted' ? 'exhausted' : 'unavailable', held: typeof credits.held === 'function' ? credits.held() : null };
  await tick(); await tick();   // the debit POST lands (fire-and-forget in credits.js)
  return { admitted: true, reservedUsd: adm.reservedUsd };
}

(async () => {
  // ---- PRODUCTION (proxy-metered, advisory debits): a $100 PER RUN on a $79 wallet, then a delegated worker ----
  {
    const cloud = fakeCloud('advisory', 79.24);
    const credits = makeCredits({ url: 'https://cloud.test', apiKey: 'snd', accountId: 'acct', fetch: cloud.fetch, clock: { now: () => 1 } });
    const lead = await admit(credits, 'lead', 100);
    A.eq([lead.admitted, lead.reservedUsd], [true, 79.24], 'the lead reserves the whole $79.24 wallet (cap clamped to the balance)');
    const worker = await admit(credits, 'worker', 100);
    A.ok(worker.admitted === true, 'on the proxy-metered cloud the delegated worker is ADMITTED — the hold never lowers the true balance (no false "out of credit"): ' + JSON.stringify(worker));
    A.eq(typeof credits.held === 'function' && credits.held().counted, false, 'the station knows this backend does not count holds against the balance');
  }

  // ---- LEDGER backend (proxy off): the reservation is a real debit, so the refreshed balance reads $0 ----
  let refusal = null;
  {
    const cloud = fakeCloud('ledger', 79.24);
    const credits = makeCredits({ url: 'https://cloud.test', apiKey: 'snd', accountId: 'acct', fetch: cloud.fetch, clock: { now: () => 1 } });
    const lead = await admit(credits, 'lead', 100);
    A.eq([lead.admitted, lead.reservedUsd, cloud.st.balance], [true, 79.24, 0], 'the lead holds the whole wallet; the backend balance reads $0');
    refusal = await admit(credits, 'worker', 100);
    A.eq(refusal.refused, 'exhausted', 'REPRODUCED: the worker is refused as if the wallet were empty');
    A.ok(refusal.held && refusal.held.runs === 1 && Math.abs(refusal.held.usd - 79.24) < 1e-9 && refusal.held.counted === true,
      'but the station can prove the balance is HELD by 1 running StarNet run it reserved ($79.24), on a backend that counts holds: ' + JSON.stringify(refusal.held));
    // once the lead settles (spent $3, refunds the rest) the next run is admitted again
    credits.finishRun({ runId: 'lead', usd: 3, reason: 'done' }); await tick(); await tick();
    A.eq([credits.held().runs, cloud.st.balance], [0, 76.24], 'the settle frees the hold');
    A.ok((await admit(credits, 'next', 100)).admitted === true, 'and the next run is admitted');
  }
  // an inert (BYOK) station has no holds
  A.eq(makeCredits({}).held && makeCredits({}).held(), { runs: 0, usd: 0, counted: false }, 'an inert credits adapter reports no holds');

  // ---- the refusal the host raises, and what COMMS says ----
  const { managedRefusalMessage } = budgetCaps;
  A.eq(typeof managedRefusalMessage, 'function', 'one pure helper owns the managed refusal wording (index.js refuseManaged)');
  if (typeof managedRefusalMessage === 'function') {
    const held = managedRefusalMessage({ exhausted: true, held: { runs: 1, usd: 79.24, counted: true } });
    A.ok(/held by 1 running StarNet run\b/.test(held.message) && /lower PER RUN in SETTINGS › SPENDING LIMITS/.test(held.message) && !/add credits|top up|out of/i.test(held.message),
      'a held balance says so and how to free it, never "out of credit": ' + held.message);
    A.eq(held.transient, true, 'a held balance frees up — the refusal is transient');
    A.ok(/held by 2 running StarNet runs\b/.test(managedRefusalMessage({ exhausted: true, held: { runs: 2, usd: 5, counted: true } }).message), 'plural for several runs');
    const empty = managedRefusalMessage({ exhausted: true, held: { runs: 0, usd: 0, counted: true } });
    A.eq([empty.message, empty.transient], ['Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).', false], 'a really empty wallet keeps the honest top-up refusal');
    A.ok(/^Out of managed credit/.test(managedRefusalMessage({ exhausted: true, held: { runs: 1, usd: 2, counted: false } }).message), 'an advisory backend never claims a hold it cannot prove');
    A.ok(/refused this station's link/.test(managedRefusalMessage({ exhausted: false, linkRefused: true }).message), 'a refused link keeps its relink refusal');
    A.ok(/did not answer/.test(managedRefusalMessage({ exhausted: false }).message), 'an unanswered check keeps its try-again refusal');
    // COMMS: a distinct kind with its own copy and door (SPENDING LIMITS, where PER RUN lives) — not the top-up
    const v = Friendly.friendlyError(held.message);
    A.eq(v.kind, 'managed_credit_held', 'friendlyerror reads it as a held balance, not managed_credit');
    A.ok(/held/.test(v.userMessage) && !/out of StarNet credits|top up/i.test(v.userMessage), 'the COMMS copy says the balance is held: ' + v.userMessage);
    A.eq([v.action, v.retryable], ['budget', true], 'its door is SPENDING LIMITS (lower PER RUN) and a retry helps once the run finishes');
    A.eq(Friendly.friendlyError(empty.message).kind, 'managed_credit', 'an empty wallet still reads as out of credit');
  }
  // the host uses the helper and asks credits.held() (a pure helper nobody calls fixes nothing)
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/budgetCaps\.managedRefusalMessage\(\{ exhausted, linkRefused, held: exhausted \? credits\.held\(\) : null \}\)/.test(idx), 'refuseManaged builds its refusal from managedRefusalMessage + credits.held()');
  A.report('managed-credit-held');
})().catch(e => { console.error(e); process.exit(1); });
