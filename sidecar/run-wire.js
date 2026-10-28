/* sidecar/run-wire.js — THE ONE {provider, model} DECISION for every way a run starts (run-wire-resolver lane, B1).

   WHY. The station decided which provider and which model a run goes out on separately at every entry point: COMMS
   (the page), Run Now and the scheduled tick (cronModelFor / cronProviderFor), the channel hubs (a pair the page pushed at
   connect time), a team.dispatch worker (the lead's wire), /v1 (openrouter + an env model), ACP and the CLI
   (/api/runtime/agent), group turns, the Live Doctor and diagnostics. Each copy read the fields one at a time
   (`o.provider || roster.provider`, then `o.model || roster.model || env`), so the same agent ran on one pair in COMMS and
   another from a routine or a phone, and every fix patched one copy. This module is the decision; every surface asks it.

   THE RULE (pair precedence, first level that names a MODEL wins):
     1. explicit  — the caller's own per-run choice: a COMMS pick, a routine's saved pair ('routine'), a CLI flag.
     2. agent     — the agent's own roster pin.
     3. station   — the station default every unpinned agent follows: the Overseer's (roster id 'agent') pin.
     4. fallbacks — a host-supplied last resort before the environment (a channel's connect-time pair on a headless
                    station that never received a roster, labelled by the host).
     5. env       — the environment rule the host computes (STARNET_DEFAULT_MODEL on its provider rule).
     6. none      — an honest refusal: ok:false, model ''.
   HALF A PAIR resolves deterministically, never field by field:
     - a level holding a model but no provider takes the provider of the NEXT level down that names one (an agent pinned to
       a bare model id runs it on the station's provider, exactly as the page's focusWire does);
     - a level holding a provider but no model is NOT a pin (a provider names no model): resolution moves on, and the
       provider it named is reported in `ignored` when it differs from the one the run uses — visible, never silent.
   The Overseer's own pin IS the station default, so for agentId 'agent' the agent and station levels are one level
   ('agent').

     resolveRunWire(input) -> wire
       input = { agentId, explicit?: {provider, model, reasoningEffort?, source?}, agent?: rosterRow, hero?: rosterRow,
                 fallbacks?: [{provider, model, reasoningEffort?, source}], env?: {provider, model},
                 normalizeProvider?: (id) -> canonical id or '' }
       wire  = { ok, agentId, provider, model, reasoningEffort, source, providerSource, followsStation, ignored: [], error? }
     pairSavedWire(saved, inherited) -> { provider, model, changed, reason }
       the stored-pair normaliser (routines store provider and model only as a pair): `saved` is a record's own
       {provider, model}, `inherited` the wire its agent resolves to without it. Never drops a saved model.
     describeRunWire(wire) -> 'codex / gpt-5.5 (station default)' — the one readout sentence.

   UMD and dependency-free, so the sidecar, the CLI (bin/) and tests share the one implementation. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.runWire = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const SOURCE_LABELS = {
    explicit: "this run's own choice",
    routine: "the routine's own pair",
    agent: "the agent's own pin",
    station: 'the station default (the Overseer)',
    connect: "the channel's connect-time choice",
    env: 'the environment default (STARNET_DEFAULT_MODEL)',
    none: 'nothing: no model is configured'
  };

  function text(v) { return v == null ? '' : String(v).trim(); }

  function levelOf(source, rec, norm) {
    if (!rec || typeof rec !== 'object') return null;
    const effort = rec.reasoningEffort != null ? rec.reasoningEffort : rec.reasoning_effort;
    return {
      source: text(source) || 'explicit',
      model: text(rec.model),
      provider: norm(text(rec.provider)),
      reasoningEffort: text(effort) || undefined
    };
  }

  function resolveRunWire(input) {
    const i = input || {};
    const norm = typeof i.normalizeProvider === 'function'
      ? (p => (p ? text(i.normalizeProvider(p)) : ''))
      : (p => p.toLowerCase());
    const agentId = text(i.agentId) || 'agent';
    const levels = [];
    if (i.explicit) levels.push(levelOf(i.explicit.source || 'explicit', i.explicit, norm));
    if (agentId === 'agent') levels.push(levelOf('agent', i.hero || i.agent, norm));
    else {
      levels.push(levelOf('agent', i.agent, norm));
      levels.push(levelOf('station', i.hero, norm));
    }
    for (const f of (Array.isArray(i.fallbacks) ? i.fallbacks : [])) levels.push(levelOf((f && f.source) || 'connect', f, norm));
    levels.push(levelOf('env', i.env, norm));
    const list = levels.filter(Boolean);

    const at = list.findIndex(l => l.model);
    if (at < 0) {
      const named = list.find(l => l.provider);
      return {
        ok: false, agentId, provider: named ? named.provider : '', model: '', reasoningEffort: undefined,
        source: 'none', providerSource: named ? named.source : 'none', followsStation: false, ignored: [],
        error: 'no model is configured: ' + (agentId === 'agent' ? 'the Overseer has no model'
          : 'agent ' + agentId + ' has no model pin and the station default (the Overseer) has none')
          + ', and STARNET_DEFAULT_MODEL is unset'
      };
    }
    const won = list[at];
    let provider = won.provider, providerSource = won.source;
    if (!provider) {
      const lender = list.slice(at + 1).find(l => l.provider);
      provider = lender ? lender.provider : '';
      providerSource = lender ? lender.source : 'none';
    }
    // a provider-only level above the winner was passed over: say so when it named a different provider
    const ignored = list.slice(0, at).filter(l => l.provider && l.provider !== provider)
      .map(l => ({ source: l.source, provider: l.provider, reason: 'a provider without a model is not a pin' }));
    return {
      ok: true, agentId, provider, model: won.model, reasoningEffort: won.reasoningEffort,
      source: won.source, providerSource, followsStation: won.source === 'station', ignored
    };
  }

  /* A saved record (a routine) holds provider and model only as a PAIR. `inherited` is the wire the record's agent
     resolves to without it (resolveRunWire with no explicit level).
       both, or neither            -> unchanged
       a model, no provider        -> the provider it has been running on (the inherited provider): the model is kept, so the
                                      tuple the record already ran is the tuple it keeps, now stated outright
       a provider, no model        -> provider cleared: it named no model, so it never pinned anything, and the record
                                      follows its agent. The caller keeps the cleared value in its migration note.
     Deterministic for the same inputs; never invents a model and never drops one. */
  function pairSavedWire(saved, inherited) {
    const s = saved || {};
    const model = text(s.model), provider = text(s.provider);
    const out = { provider: provider || null, model: model || null, changed: false, reason: '' };
    if ((model && provider) || (!model && !provider)) return out;
    if (model) {
      const lent = inherited && text(inherited.provider);
      if (!lent) return out;   // nothing to pair it with yet: resolveRunWire still borrows at run time, deterministically
      out.provider = lent; out.changed = true;
      out.reason = 'model without a provider: paired with ' + lent + ', the provider it ran on (' + (SOURCE_LABELS[inherited.providerSource] || inherited.providerSource || 'inherited') + ')';
      return out;
    }
    out.provider = null; out.changed = true;
    out.reason = 'provider ' + provider + ' without a model is not a pin: the routine follows its agent';
    return out;
  }

  function describeRunWire(wire) {
    const w = wire || {};
    if (!w.ok) return 'no model configured' + (w.provider ? ' (' + w.provider + ')' : '');
    const borrowed = w.providerSource && w.providerSource !== w.source
      ? '; provider from ' + (SOURCE_LABELS[w.providerSource] || w.providerSource) : '';
    return w.provider + ' / ' + w.model + ' (' + (SOURCE_LABELS[w.source] || w.source) + borrowed + ')';
  }

  return { resolveRunWire, pairSavedWire, describeRunWire, SOURCE_LABELS };
});
