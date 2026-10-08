/* sidecar/budgetcaps.js — the PURE resolve+validate helper behind the SETTINGS → Budget panel (P0-2).
   Splits the two decisions out of the Node host so they're testable headlessly:

   • resolveCaps(envDefaults, overrides) -> effective caps. PRECEDENCE (additive, never breaks an env deploy):
     a persisted override wins for a key; else the env default. An override value of 0 is a REAL saved choice
     ("no cap" / ungoverned) and beats a non-zero env default — so the UI can dial a cap OFF. An override key
     that is absent means "use the env default" (that's how RESET works: clear the override, fall back to env).

   • validateOverridesPatch(patch) -> { ok, overrides?, error? }. Strictly parses an incoming
     { perRun?, perAgent?, perDay?, global? } patch against the current-nothing baseline: each present value must
     be a finite number >= 0 (0 = no cap) under a sane ceiling, or null/'' to CLEAR that key back to its default.
     Returns the SET of keys to persist (absent = cleared). No IO, no clock — trivially testable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).budgetcaps = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEYS = ['perRun', 'perAgent', 'perDay', 'global'];
  const CAP_MAX = 1e7;   // $10M ceiling — guards a fat-fingered / overflow value, far above any real budget
  /* SHIPPED DEFAULTS — what a fresh install is governed by before the Commander saves anything and before any
     env var speaks. Every cap was 0 (ungoverned) until 2026-09-17, when a customer's agent spun 98 overnight
     iterations re-confirming that files existed and burned ~$98 with nothing between a stuck loop and the card.
     perDay is now a SOFT rail, not a wall: hitting it ends the run with reason 'budget' scope 'day', the Budget
     panel shows a one-click RESUME that grants another cap of headroom, and the value is editable (0 = off).
     Unmetered runs (OAuth / subscription sign-ins) never touch it — there is no $ to govern. Andrew's call,
     2026-09-17, amending the older "quotas default off" decision for this one runaway-spend case. */
  const DEFAULT_PER_DAY_USD = 25;
  const SHIPPED_DEFAULTS = Object.freeze({ perRun: 0, perAgent: 0, perDay: DEFAULT_PER_DAY_USD, global: 0 });
  /* MANAGED PER-RUN DEFAULT (issue #53, 2026-09-30). A StarNet-credit run must reserve a FINITE amount before
     its first model call. With no per-run cap in force, admission used to reserve the ENTIRE wallet — and the
     reservation is the loop's per-run ceiling — so one "simple" prompt on a busy/expensive model was allowed to
     spend every dollar the user had just added (reporter: $10 top-up gone on a four-sentence question).
     Now a managed run with no positive per-run cap reserves at most this much. Why $2: the smallest top-up is
     $10, so one prompt can take at most a fifth of it; a simple question costs cents and a real multi-step task
     on a mid-tier model rarely passes a dollar; it is well under the $25/day rail so the day rail stays the
     backstop, not the first thing a user hits. It is a DEFAULT, not a wall: any per-run cap the user saves in
     SETTINGS → BUDGET (higher or lower) replaces it, the stop says which cap it hit and opens BUDGET, and
     SKYNET_BUDGET_MANAGED_PER_RUN retunes it (0 = the old wallet-is-the-ceiling behaviour). BYOK and
     subscription runs never see it — they are not spending StarNet credit. */
  const DEFAULT_MANAGED_PER_RUN_USD = 2;
  function shippedDefaults() { return Object.assign({}, SHIPPED_DEFAULTS); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* The amount a MANAGED (StarNet-credit) run reserves — which is also its per-run spend ceiling.
       capUsd      the cap already in force for this run: an explicit caller cap (a delegated worker's) or the
                   user's positive per-run cap. It is a CEILING, so it is clamped to the wallet: a cap above
                   the balance reserves the balance. (It used to pass through verbatim and admission refused it
                   as "out of credit" — a $100 cap on a $79 wallet, customer report 2026-10-06.)
       balanceUsd  the managed wallet as last REPORTED by the service (null/NaN = unknown, never $0).
       defaultUsd  the managed per-run default (DEFAULT_MANAGED_PER_RUN_USD unless an operator retuned it);
                   0/absent = no default, i.e. the wallet itself is the ceiling (pre-#53 behaviour).
     With no cap in force the run reserves min(default, balance): a wallet smaller than the default still runs
     (it is never refused for a cap the user never chose). Returns 0 for an unknown/empty wallet so the caller
     fails closed. Pure — no IO. */
  function managedRunCapUsd(capUsd, balanceUsd, defaultUsd) {
    const bal = (balanceUsd == null || balanceUsd === '') ? NaN : Number(balanceUsd);
    if (!(isFinite(bal) && bal > 0)) return 0;
    if (isNum(capUsd) && capUsd > 0) return Math.min(capUsd, bal);
    const d = Number(defaultUsd);
    return (isFinite(d) && d > 0) ? Math.min(d, bal) : bal;
  }

  /* The refusal a MANAGED run gets when admission cannot reserve (index.js refuseManaged) -> { message, transient }.
       exhausted    the service REPORTED a balance and it could not cover a reservation (a number, not an unknown)
       linkRefused  the service answered 401/403 for this station's link
       held         credits.held(): { runs, usd, counted } — StarNet runs THIS station has still working and the amount
                    they reserve; `counted` = the backend itself books a reservation as a debit (proxy-off deploys).
       balanceUsd   the balance the service reported (what admission read)
     A balance reported as $0 because this station's own running runs hold it is NOT an empty wallet: those holds
     come back when the runs settle (each refunds what it did not spend). That refusal says so and names the levers in
     order — wait, lower PER RUN so runs can share the balance (audit B11: PER RUN at/above the balance makes one run
     reserve all of it), or top up (kept: a small wallet's hold may come back as cents; worded "top up", not "add
     credits", so errorClass's status-less ladder never reads it as an empty wallet). Only claimed when the
     holds are WHY it reads empty: `counted` (on the proxy-metered cloud a reservation never lowers the reported
     balance, so a $0 there is real spend) and the reported balance plus the holds is positive (an overdrawn wallet a
     small hold cannot explain is out of credit). Pure. */
  function managedRefusalMessage(o) {
    o = o || {};
    const held = o.held || null;
    const bal = (o.balanceUsd == null || o.balanceUsd === '') ? NaN : Number(o.balanceUsd);
    if (o.exhausted && held && held.counted === true && held.runs > 0 && held.usd > 0 && isFinite(bal) && bal + held.usd > 0) {
      const n = Math.floor(held.runs);
      return { transient: true, message: 'Managed credits are held — your StarNet balance is held by ' + n + ' running StarNet run' + (n === 1 ? '' : 's') +
        ' (each reserves up to its PER RUN limit while it works and refunds what it does not spend). Wait for ' + (n === 1 ? 'it' : 'them') +
        ' to finish, lower PER RUN in SETTINGS › SPENDING LIMITS so runs can share the balance, or top up under SETTINGS → AI & MODELS.' };
    }
    if (o.exhausted) return { transient: false, message: 'Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).' };
    if (o.linkRefused) return { transient: false, message: 'Managed credits are unavailable — your StarNet account refused this station\'s link (it was unlinked, or belongs to another account). Relink it under SETTINGS → AI & MODELS → STARNET MANAGED (or use your own provider key).' };
    return { transient: true, message: 'Managed credits are unavailable right now — the credits service did not answer (try again, or use your own provider key).' };
  }

  // a stored override is only honoured if it's a finite number >= 0 (0 = explicit "no cap"). Anything else is junk
  // and treated as "not set" (fall back to env) — a corrupt persisted value can never grant unintended headroom.
  function cleanOverrides(overrides) {
    const out = {};
    if (overrides && typeof overrides === 'object') {
      for (const k of KEYS) {
        const v = overrides[k];
        if (isNum(v) && v >= 0) out[k] = v;
      }
    }
    return out;
  }

  // effective caps = per key: (persisted override present ? override : env default). Env default itself falls to 0.
  function resolveCaps(envDefaults, overrides) {
    envDefaults = envDefaults || {};
    const ov = cleanOverrides(overrides);
    const out = {};
    for (const k of KEYS) {
      out[k] = Object.prototype.hasOwnProperty.call(ov, k)
        ? ov[k]
        : (isNum(envDefaults[k]) && envDefaults[k] >= 0 ? envDefaults[k] : 0);
    }
    return out;
  }

  // parse a POST /api/budget/caps body into the next override set. Only keys PRESENT in the patch are touched;
  // a present null/'' clears that key (-> env default); a present number sets it. Returns {ok:false,error} on any
  // invalid value so the endpoint can 400 without partial application. `base` = the current overrides to merge onto.
  function validateOverridesPatch(patch, base) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'body must be an object of caps' };
    const next = Object.assign({}, cleanOverrides(base));
    let touched = false;
    for (const k of KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      touched = true;
      const raw = patch[k];
      if (raw === null || raw === '' || raw === undefined) { delete next[k]; continue; }   // clear -> env default
      const n = Number(raw);
      if (!isFinite(n) || n < 0) return { ok: false, error: k + ' must be a number >= 0 (0 = no cap), blank to reset to default' };
      if (n > CAP_MAX) return { ok: false, error: k + ' exceeds the $' + CAP_MAX.toLocaleString() + ' ceiling' };
      next[k] = Math.round(n * 1e6) / 1e6;   // micro-dollar precision, matching the ledger's $ granularity
    }
    if (!touched) return { ok: false, error: 'no cap fields provided (perRun, perAgent, perDay, global)' };
    return { ok: true, overrides: next };
  }

  return { KEYS, CAP_MAX, DEFAULT_PER_DAY_USD, DEFAULT_MANAGED_PER_RUN_USD, shippedDefaults, resolveCaps, validateOverridesPatch, cleanOverrides, managedRunCapUsd, managedRefusalMessage };
});
