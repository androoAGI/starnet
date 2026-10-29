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
       a bare model id runs it on the station's provider, exactly as the page's focusWire does). A CREW row holding a
       provider and no model lends nothing: that is the stale stamp an older page wrote on every unpinned row, so a bare
       model above it (a routine's, a loop's, an /api/run body's, a CLI --model) runs on the station's provider;
     - a level holding a provider but no model is NOT a pin (a provider names no model): resolution moves on, and the
       provider it named is reported in `ignored` when it differs from the one the run uses — visible, never silent.
   A PROVIDER THE HOST DOES NOT KNOW (its normaliser answers '' for it: a typo, a provider this build dropped) is reported
   in `ignored` as 'unknown provider' at whatever level the host hands it in AS NAMED. At the EXPLICIT level — an
   operator's or a caller's own choice (STARNET_V1_PROVIDER, a routine's or a loop's saved pair, a run option) — a model on
   it is REFUSED (ok:false): borrowing the next level's provider would send that model, and that provider's credential,
   somewhere nobody chose. A lower level with an unknown provider keeps the half-pair rule (its model borrows the next
   level's provider), reported. The sidecar's roster stores each row's provider already normalised (index.js
   replaceAgentRoster: an unknown id is stored as ''), so its agent and station levels never carry an unknown provider:
   such a row arrives as a row with no provider, and nothing about it is reported here.
   The Overseer's own pin IS the station default, so for agentId 'agent' the agent and station levels are one level
   ('agent').

   THE REASONING-EFFORT RULE (one rule for every surface: wire.reasoningEffort), the first that names one:
     1. the run's own per-run effort (the explicit level's: a COMMS pick, a CLI flag, a labelled caller's choice);
     2. the agent's own effort — its roster record: the effort its pin carries, else its class loadout's applied
        default (the roster keeps both in the one field);
     3. the station (Overseer) effort, ONLY when the agent follows the station (source 'station');
     4. a host fallback's own effort when that fallback chose the pair (a roster-less station's connect-time choice);
     5. undefined — the provider default (the host's resolveReasoningEffort fills it in).
   A pinned agent with no effort of its own never borrows the Overseer's: following the station is what lends it.

     resolveRunWire(input) -> wire
       input = { agentId, explicit?: {provider, model, reasoningEffort?, source?}, agent?: rosterRow, hero?: rosterRow,
                 fallbacks?: [{provider, model, reasoningEffort?, source}], env?: {provider, model},
                 normalizeProvider?: (id) -> canonical id or '' }
       wire  = { ok, agentId, provider, model, reasoningEffort, source, providerSource, followsStation, ignored: [], error?,
                 unknownProvider? (the refused explicit provider id, on that refusal only) }
       `ignored` lists each provider-only level the resolution passed over that named another provider, and each level
       that named a provider the host does not know; the host surfaces it (the Live Doctor's report.wire, the diagnostics
       snapshot), so a passed-over choice is never silent.
     pairSavedWire(saved) -> { provider, model, changed, reason }
       the stored-pair normaliser for a saved record (a routine's own {provider, model}): clears a provider that names no
       model; never drops a saved model and never stamps a provider onto one.

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
    const named = text(rec.provider), provider = norm(named);
    return {
      source: text(source) || 'explicit',
      model: text(rec.model),
      provider,
      unknown: named && !provider ? named : '',   // a provider id the host's normaliser does not know
      reasoningEffort: text(effort) || undefined
    };
  }

  function resolveRunWire(input) {
    const i = input || {};
    const norm = typeof i.normalizeProvider === 'function'
      ? (p => (p ? text(i.normalizeProvider(p)) : ''))
      : (p => p.toLowerCase());
    const agentId = text(i.agentId) || 'agent';
    const explicitLevel = i.explicit ? levelOf(i.explicit.source || 'explicit', i.explicit, norm) : null;
    const agentLevel = levelOf('agent', agentId === 'agent' ? (i.hero || i.agent) : i.agent, norm);
    const stationLevel = agentId === 'agent' ? null : levelOf('station', i.hero, norm);
    const fallbackLevels = (Array.isArray(i.fallbacks) ? i.fallbacks : []).map(f => levelOf((f && f.source) || 'connect', f, norm)).filter(Boolean);
    const list = [explicitLevel, agentLevel, stationLevel].concat(fallbackLevels, [levelOf('env', i.env, norm)]).filter(Boolean);
    const unknown = list.filter(l => l.unknown).map(l => ({ source: l.source, provider: l.unknown, reason: 'unknown provider' }));
    // an explicit model on a provider the host does not know is refused, never re-homed on another level's provider
    if (explicitLevel && explicitLevel.unknown && explicitLevel.model) {
      return {
        ok: false, agentId, provider: '', model: '', reasoningEffort: undefined,
        source: 'none', providerSource: 'none', followsStation: false, ignored: unknown, unknownProvider: explicitLevel.unknown,
        error: 'provider "' + explicitLevel.unknown + '" (' + (SOURCE_LABELS[explicitLevel.source] || explicitLevel.source)
          + ') is not a provider this station knows'
      };
    }

    const at = list.findIndex(l => l.model);
    if (at < 0) {
      const named = list.find(l => l.provider);
      return {
        ok: false, agentId, provider: named ? named.provider : '', model: '', reasoningEffort: undefined,
        source: 'none', providerSource: named ? named.source : 'none', followsStation: false, ignored: unknown,
        error: 'no model is configured: ' + (agentId === 'agent' ? 'the Overseer has no model'
          : 'agent ' + agentId + ' has no model pin and the station default (the Overseer) has none')
          + ', and STARNET_DEFAULT_MODEL is unset'
      };
    }
    const won = list[at];
    let provider = won.provider, providerSource = won.source;
    const skipped = [];
    if (!provider) {
      // a crew row's provider with no model of its own (the stale stamp) lends nothing; the Overseer's provider does
      const lends = l => l.model || l.source !== 'agent' || agentId === 'agent';
      let lender = null;
      for (const l of list.slice(at + 1)) {
        if (!l.provider) continue;
        if (lends(l)) { lender = l; break; }
        skipped.push(l);
      }
      provider = lender ? lender.provider : '';
      providerSource = lender ? lender.source : 'none';
    }
    // a provider-only level above the winner (or a stamp that could not lend) was passed over: say so when it named a
    // different provider
    const ignored = list.slice(0, at).concat(skipped).filter(l => l.provider && l.provider !== provider)
      .map(l => ({ source: l.source, provider: l.provider, reason: 'a provider without a model is not a pin' })).concat(unknown);
    const followsStation = won.source === 'station';
    const effortOf = l => (l && l.reasoningEffort) || undefined;   // THE REASONING-EFFORT RULE (header)
    const reasoningEffort = effortOf(explicitLevel) || effortOf(agentLevel)
      || (followsStation ? effortOf(stationLevel) : undefined)
      || (fallbackLevels.indexOf(won) >= 0 ? effortOf(won) : undefined);
    return {
      ok: true, agentId, provider, model: won.model, reasoningEffort,
      source: won.source, providerSource, followsStation, ignored
    };
  }

  /* A saved record (a routine) and the half pairs it may hold:
       both, or neither            -> unchanged
       a model, no provider        -> UNCHANGED. The model is the record's own; the provider is not. resolveRunWire borrows
                                      it at run time (the agent's, else the station's), so the record follows a station
                                      provider switch exactly as it always has. Stamping the provider it happened to run on
                                      would freeze it there — and, on a boot with an empty or lost roster, on the
                                      environment's provider.
       a provider, no model        -> provider cleared: it named no model, so it never pinned anything, and the record
                                      follows its agent. The caller keeps the cleared value in its migration note.
     Deterministic for the same input; never invents a model, never drops one, never stamps a provider. */
  function pairSavedWire(saved) {
    const s = saved || {};
    const model = text(s.model), provider = text(s.provider);
    const out = { provider: provider || null, model: model || null, changed: false, reason: '' };
    if (model || !provider) return out;
    out.provider = null; out.changed = true;
    out.reason = 'provider ' + provider + ' without a model is not a pin: the routine follows its agent';
    return out;
  }

  return { resolveRunWire, pairSavedWire, SOURCE_LABELS };
});
