/* A behavioral comparison must not create free or falsely settled provider calls. */
'use strict';
function makeEvaluationAccounting(options) {
  const o = options || {}, ledger = o.ledger;
  if (!ledger || typeof ledger.beginRun !== 'function' || typeof ledger.recordStrict !== 'function' || typeof ledger.markUnsettled !== 'function') throw new Error('evaluation ledger required');
  // An UNMETERED provider (a subscription or a local model) bills nothing per token: the run host books its runs
  // at $0 and writes no dispatch receipt for them (spend.js effectiveUsd; runBudget skips budget.check). Settling
  // only priced charges here made every Ollama evaluation "unknown spend": a durable unsettled receipt that turned
  // station spend history incomplete and a candidate that could never pass. Its usage settles at $0 instead.
  const unmetered = !!o.unmetered;
  let spent = 0, uncertain = false;
  const clearLive = runId => { if (o.budget) o.budget.clearLive(runId); };
  function unknown(runId) {
    uncertain = true;
    // The dispatch receipt is already durable. Make it visible to every station
    // budget check now, rather than waiting for a process restart to discover it.
    ledger.markUnsettled(runId);
    clearLive(runId);
  }
  const count = n => (Number.isFinite(n) && n >= 0 ? n : 0);
  return {
    canContinue(caseSpent) { return !uncertain && spent + (Number(caseSpent) || 0) < (o.maxUsd || 0.40); },
    beforeRun({ runId }) {
      // An unmetered provider bills nothing per call, so there is no unknown charge to hold a receipt for (runOnce skips it too).
      // managed: the billing source the host knew (Agent OS credits vs the Commander's own key); the ledger keeps only a boolean.
      if (uncertain || (!unmetered && !ledger.beginRun(runId, o.agentId, { provider: o.provider, model: o.model, managed: o.managed, runCapUsd: o.runCapUsd || 0.08 }))) {
        uncertain = true;
        throw new Error('Evaluation dispatch could not be durably recorded.');
      }
      // The unmetered admission tells the runner to settle each attempt at $0 rather than by price.
      return unmetered ? { ok: true, unmetered: true } : true;
    },
    onStream({ runId, spentUsd, accountingIncomplete }) {
      if (accountingIncomplete && !unmetered) unknown(runId);
      else if (o.budget) o.budget.noteLive(runId, unmetered ? 0 : spentUsd);
    },
    onRun({ result, runId }) {
      if (unmetered) {
        const r = result || {};
        // Every outcome there (done, failed, timed out, cancelled) bills the Commander nothing per call, so none is
        // unknown spend. Booked like the run host books an unmetered run: the row counts the run, its tokens and any
        // provider-reported figure, the ledger keeps it out of metered dollars (so out of every USD cap), and it never
        // adds to this evaluation's dollar ceiling.
        try { ledger.recordStrict({ runId, agentId: o.agentId, turns: count(r.turns), usd: count(r.usd), tokens: count(r.tokens), model: o.model, unmetered: true }); }
        catch (error) { uncertain = true; throw error; }
        finally { clearLive(runId); }
        return;
      }
      // A cancel that landed between provider calls is known spend: the runner says so only with a literal false
      // (every attempt finished and was priced). A cancel mid-call leaves that attempt unaccounted, so it stays unknown.
      const knownCancel = !!result && result.reason === 'cancelled' && result.accountingIncomplete === false;
      if (!result || ['error', 'runner-error'].includes(result.reason) || (result.reason === 'cancelled' && !knownCancel) || result.accountingIncomplete || !Number.isFinite(result.usd) || result.usd < 0 || !Number.isFinite(result.tokens) || result.tokens < 0 || (result.unpricedUsage || []).length) {
        unknown(runId);
        // Keep the dispatch receipt for explicit settlement, now or after restart.
        throw new Error('Evaluation spend is incomplete; its dispatch receipt remains unsettled.');
      }
      spent += result.usd;
      try { ledger.recordStrict({ runId, agentId: o.agentId, turns: result.turns || 0, usd: result.usd, tokens: result.tokens, model: o.model, unmetered: false }); }
      catch (error) { uncertain = true; throw error; }
      finally { clearLive(runId); }
    }
  };
}
module.exports = { makeEvaluationAccounting };
