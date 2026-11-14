/* sidecar/providers/effort-clamp.js — THE ONE CLAUDE EFFORT RESOLVER: which effort levels a Claude model takes, and what a
   level it does not take becomes. Two routes reach the same models and must agree on them:

     the Anthropic API adapter (anthropic.js)   effortsFor + clampEffort decide the thinking contract a request carries
     the Claude sign-in route (claude-cli.js)   the same ladder with the CLI OVERLAY decides the `--effort` a child gets

   It lived inside anthropic.js, unexported, and the CLI adapter had its own flat list (low..max for every model). The
   tables and the clamp are here now, once; anthropic.js behaves exactly as before (it imports what it used to declare).

   THE LADDER (effortsFor, ascending). A non-Claude id gets ['none'] (nothing is sent to a third-party endpoint). A legacy
   model (Claude 3.x / 4.0 / 4.1 / 4.5: manual thinking budgets on the API) publishes none..max over its budget tiers. A
   modern model publishes low, medium, high, xhigh (not the 4.6 family, which predates it) and max, with 'none' first unless
   the model always thinks (Fable, Mythos, Opus 5.5).
   THE CLAMP (clampEffort). A level a model does not publish becomes its nearest neighbour, never nothing: ties resolve
   UPWARD, so 'minimal' becomes 'low' rather than switching thinking off, and 'xhigh' on a 4.6 model becomes 'max'.

   THE CLI OVERLAY (cost audit W3.8). `claude --effort` takes low, medium, high, xhigh or max and has no "off":
     - a legacy model (Haiku 4.5 is the one the CLI lists) takes no effort at all: the flag is OMITTED;
     - a model id that is not a Claude id (an alias this file does not know) is never guessed at: OMITTED;
     - 'none' is not a level there, so the ladder drops it: none and minimal clamp to the lowest level the model has (low);
     - the 4.6 family has no xhigh (it clamps to max), exactly as on the API.
   The adapter resolves its own aliases (opus, sonnet, haiku, a [1m] suffix) before asking.

   THE CLI SWITCH (STARNET_CLI_EFFORT, read by the host; cliMode parses it, cliArgvEffort is the one decision):
     'off' (default)  today's rule, byte for byte: only an effort a REQUEST carries (self-talk, a background loop) is sent,
                      as written when it is one of low..max, never clamped; a main run's effort is not sent.
     'picked'         a request's own effort, clamped; else the effort the adapter was BUILT with (the run's), clamped, only
                      when the host says the Commander picked it themselves. A class-applied default is not sent.
     'all'            a request's own effort, else the built one, clamped.
   '' = no flag: the CLI runs on its own default, and the record says 'cli-default'.

   Pure, no dependencies; UMD like its callers. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).effortClamp = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  // Substring-matched in BOTH the dashed and dotted spellings: catalog ids arrive dashed, hand-typed model
  // fields and imported agent dossiers arrive dotted, and both reach the adapters.
  const LEGACY_CLAUDE = [
    'claude-3',
    'claude-opus-4-0', 'claude-opus-4.0', 'claude-opus-4-1', 'claude-opus-4.1',
    'claude-sonnet-4-0', 'claude-sonnet-4.0',
    'claude-opus-4-2025', 'claude-sonnet-4-2025',
    'claude-opus-4-5', 'claude-opus-4.5',
    'claude-sonnet-4-5', 'claude-sonnet-4.5',
    'claude-haiku-4-5', 'claude-haiku-4.5'
  ];
  // The 4.6 family predates the `xhigh` level (low/medium/high/max only) — offering it there is a 400.
  const NO_XHIGH_CLAUDE = ['claude-opus-4-6', 'claude-opus-4.6', 'claude-sonnet-4-6', 'claude-sonnet-4.6'];
  // Thinking is ALWAYS ON for these: an explicit {type:'disabled'} is refused at any effort, so 'none' is never
  // offered; saved OFF settings clamp to adaptive thinking at the lowest supported effort.
  // Opus 5.5 rejects disabled thinking; Opus 5 still supports it, so do not match all Opus 5.x.
  const ALWAYS_THINKING_CLAUDE = ['claude-fable', 'claude-mythos', 'claude-opus-5-5', 'claude-opus-5.5'];

  const modelKey = (id) => String(id == null ? '' : id).toLowerCase();
  function hasAny(id, list) { const k = modelKey(id); for (const s of list) if (k.indexOf(s) >= 0) return true; return false; }
  function isClaude(id) { return modelKey(id).indexOf('claude') >= 0; }
  function alwaysThinks(id) { return hasAny(id, ALWAYS_THINKING_CLAUDE); }
  const WORDS = {
    off: 'none', none: 'none', no: 'none', disabled: 'none',
    min: 'minimal', minimal: 'minimal',
    low: 'low', med: 'medium', mid: 'medium', medium: 'medium', high: 'high',
    extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh', max: 'max'
  };
  // effortRung(v) -> the level a word names, or '' when it names none (never a guess)
  function effortRung(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, '');
    return Object.prototype.hasOwnProperty.call(WORDS, k) ? WORDS[k] : '';
  }
  // the dial's reading of a word: one that names no level is the default, medium
  function normalizeEffort(v) { return effortRung(v) || 'medium'; }
  // The levels this model actually accepts, ascending. Legacy models publish the BUDGET tiers under the same
  // vocabulary so one Commander-facing control drives both contracts.
  function effortsFor(id) {
    if (!isClaude(id)) return ['none'];
    if (hasAny(id, LEGACY_CLAUDE)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    const out = ['low', 'medium', 'high'];
    if (!hasAny(id, NO_XHIGH_CLAUDE)) out.push('xhigh');
    out.push('max');
    if (!alwaysThinks(id)) out.unshift('none');
    return out;
  }
  // A level this model does not publish is CLAMPED to its nearest neighbour, never dropped: asking a 4.6 model
  // for 'xhigh' means "as hard as you can", and 'max' is the honest answer. Ties resolve UPWARD (the list is
  // ascending and the comparison is <=), so 'minimal' becomes 'low' rather than silently switching thinking OFF.
  function clampEffort(want, allowed) {
    const i = EFFORT_ORDER.indexOf(want);
    if (i < 0) return allowed.indexOf('medium') >= 0 ? 'medium' : allowed[allowed.length - 1];
    let best = allowed[0], bestD = Infinity;
    for (const a of allowed) {
      const d = Math.abs(EFFORT_ORDER.indexOf(a) - i);
      if (d <= bestD) { bestD = d; best = a; }
    }
    return best;
  }

  /* ---- the CLI overlay ---------------------------------------------------------------------------------------------- */
  const CLI_FLAG_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];   // what `claude --effort` takes
  const CLI_OFF = 'off', CLI_PICKED = 'picked', CLI_ALL = 'all';
  // cliMode(raw) -> 'off' | 'picked' | 'all'. raw = the switch as the host's env reader read it (undefined: unset).
  // Tolerant of garbage (a typo must never change an argv): only the two words turn it on.
  function cliMode(raw) {
    const m = (typeof raw === 'string') ? raw.trim().toLowerCase() : '';
    return (m === CLI_PICKED || m === CLI_ALL) ? m : CLI_OFF;
  }
  // the levels `claude --effort` can be given for this model (the adapter has resolved its aliases); [] = send no flag
  function cliEffortsFor(id) {
    if (!isClaude(id) || hasAny(id, LEGACY_CLAUDE)) return [];
    return effortsFor(id).filter(e => CLI_FLAG_LEVELS.indexOf(e) >= 0);
  }
  // one wanted effort -> the --effort value for this model, or '' (no flag: the model takes none, or the word names no level)
  function cliEffortFor(id, want) {
    const allowed = cliEffortsFor(id);
    const rung = effortRung(want);
    if (!allowed.length || !rung) return '';
    return allowed.indexOf(rung) >= 0 ? rung : clampEffort(rung, allowed);
  }
  /* cliArgvEffort({ mode, model, perRequest, built, picked }) -> the `--effort` value a claude-cli child is started with,
     or '' for no flag. THE one decision: the adapter's argv and its effortAsSent both read it, so a record and an argv
     cannot disagree. perRequest = the effort the request itself carries; built = the effort the adapter was built with
     (the run's resolved effort); picked = the host's word that the Commander set that effort themselves. */
  function cliArgvEffort(o) {
    o = o || {};
    const mode = cliMode(o.mode);
    if (mode === CLI_OFF) {
      const e = String(o.perRequest || '').trim().toLowerCase();
      return CLI_FLAG_LEVELS.indexOf(e) >= 0 ? e : '';
    }
    if (o.perRequest) return cliEffortFor(o.model, o.perRequest);
    if (o.built && (mode === CLI_ALL || o.picked === true)) return cliEffortFor(o.model, o.built);
    return '';
  }
  // the per-model list the CLI adapter publishes: off = the flat list it always published; on = what the flag can carry
  function cliListFor(mode, id) { return cliMode(mode) === CLI_OFF ? CLI_FLAG_LEVELS.slice() : cliEffortsFor(id); }

  return { EFFORT_ORDER, LEGACY_CLAUDE, NO_XHIGH_CLAUDE, ALWAYS_THINKING_CLAUDE, modelKey, hasAny, isClaude, alwaysThinks,
    effortRung, normalizeEffort, effortsFor, clampEffort,
    CLI_FLAG_LEVELS, CLI_OFF, CLI_PICKED, CLI_ALL, cliMode, cliEffortsFor, cliEffortFor, cliArgvEffort, cliListFor };
});
