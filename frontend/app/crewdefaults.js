/* frontend/app/crewdefaults.js — LEANER CREW DEFAULTS (cost lanes W3.3 + W3.4, approved by Andrew 2026-11-08).

   ONE switch for both halves. Ships OFF until an A/B on real models passes (scripts/crew-defaults-ab.mjs).
     STARNET_CREW_DEFAULTS (legacy spelling SKYNET_CREW_DEFAULTS). The sidecar reads it in one place, through its one env
     reader: index.js crewDefaultsMode() = mode(ENV('CREW_DEFAULTS')). ENV() takes the STARNET_ value whenever that variable
     is set, even blank, else the SKYNET_ one. This file never reads the environment: mode() is handed the value.
       unset, blank, 'off', anything else  -> 'off'   every request and record exactly as before this file
       'lean' (any case, spaces trimmed)   -> 'lean'  the two rules below
   The page learns the state from GET /api/providers (crewDefaults: 'lean', present only when on). Locked by
   test/crew-defaults.invariant.test.js (A and B).
   Not to be confused with STARNET_LEAN_CREW, the zero-crew diet (sidecar/crew-diet.js): that one is ON by default and '0'
   turns it off; this one is OFF by default and only 'lean' turns it on.

   W3.3 — EFFORT. effortRule() decides the effort a CREW run asks for: a worker (team.dispatch), a clone (team.spawn) or
   a line stage (a run that belongs to a line). A class's applied effort above medium (the class loadout wrote it) runs at
   medium; the run after a failed verify (a review gate sent the work back, a structured result failed host validation)
   steps up one rung, never above the class's own effort; a pinned effort (the Commander picked it) is never touched, and
   an effort with no marker is a pin. The level it returns is a WANT: the host clamps it to the rungs the provider lists
   for the model (AuxGovernor.clampEffort, the one clamp) and sends it per request, like every other effort override, but
   never above the effort the run asked for (sendable()).

   W3.4 — MODEL. tierPick() is the model a summon preselects for a class tier: the family's mid-tier model for a
   balanced class, its small one for a fast class, read from the provider's own catalog (never an id it does not list).
   A family this file does not know, a tier the catalog lacks, or a base already at or below the tier: null (today's
   choice stands). A reasoning class keeps the model it would have had.

   Pure, no dependencies; UMD (the sidecar requires it, the page loads it as a script). */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CrewDefaults = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ON = 'lean', OFF = 'off';
  // mode(raw) -> 'lean' | 'off'. raw = the switch's value as the sidecar's ENV('CREW_DEFAULTS') read it (undefined: unset).
  // Tolerant of garbage (a typo must never change a request): only the word itself turns it on.
  function mode(raw) {
    return (typeof raw === 'string' && raw.trim().toLowerCase() === ON) ? ON : OFF;
  }
  const isOn = m => m === ON;

  /* ---- W3.3 effort ------------------------------------------------------------------------------------------------- */
  const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];   // AuxGovernor.EFFORT_ORDER's ladder
  const LEAN = 'medium';
  const rank = e => ORDER.indexOf(String(e || '').toLowerCase());
  // which crew surface a run is, from the options every caller already passes: a delegated run is a worker when the
  // agent is on the roster, else an ephemeral clone; a run that carries a lineId is a line stage; anything else: ''
  function surfaceOf(o) {
    o = o || {};
    if (o.delegatedBy) return o.inRoster ? 'worker' : 'clone';
    return o.lineId ? 'line' : '';
  }
  /* effortRule({ mode, surface, asked, source, retry }) -> null (not a crew run, or the switch is off) or
     { why, want? }. asked = the effort the run resolved (the one rule in run-wire.js); source = 'class' | 'pin' | ''
     (no marker: a pin). why: 'lean' (class effort above medium, want medium) · 'retry' (after a failed verify, want one
     rung above medium, at most the class effort) · 'kept' (a class effort at or below medium) · 'pinned' · 'unmarked'. */
  function effortRule(o) {
    o = o || {};
    if (!isOn(o.mode) || !o.surface) return null;
    const asked = String(o.asked || '').toLowerCase();
    if (rank(asked) < 0) return null;
    if (o.source !== 'class') return { why: o.source === 'pin' ? 'pinned' : 'unmarked' };
    if (rank(asked) <= rank(LEAN)) return { why: 'kept' };
    if (o.retry) return { why: 'retry', want: ORDER[Math.min(rank(LEAN) + 1, rank(asked))] };
    return { why: 'lean', want: LEAN };
  }
  /* sendable(sent, asked) -> the rung the clamp gave, or null when it is not a rung or lands above the effort the run
     asked for. The rule only ever lowers. The one clamp (AuxGovernor.clampEffort) moves a want the model does not list
     to the nearest listed rung above it, which on a list without the asked rung can be above asked; then the rule sends
     nothing and the run goes out on its own effort, exactly as with the switch off. */
  function sendable(sent, asked) {
    const r = rank(sent);
    return (r >= 0 && rank(asked) >= 0 && r <= rank(asked)) ? ORDER[r] : null;
  }

  /* ---- W3.4 model -------------------------------------------------------------------------------------------------- */
  const TIER_RANK = { balanced: 1, fast: 2 };   // rank 0 = the family's top tier; a reasoning class asks for nothing
  // each family's tier words, top to small, as the providers name them (prices.js prices every one of these lines)
  const FAMILIES = [
    { family: 'claude', re: /^claude-(opus|fable|mythos|sonnet|haiku)(?:-(\d+(?:[-.]\d{1,2})?))?(?:-(\d{8}))?$/, tier: 1, ver: 2, date: 3 },
    { family: 'claude', re: /^claude-(\d+(?:[-.]\d{1,2})?)-(opus|sonnet|haiku)(?:-(\d{8}))?$/, tier: 2, ver: 1, date: 3 },
    { family: 'claude', re: /^(opus|sonnet|haiku)$/, tier: 1 },   // Claude Code's own aliases
    { family: 'gemini', re: /^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)((?:-preview|-exp)(?:-[\w.-]+)?)?$/, tier: 2, ver: 1, variant: 3 },
    { family: 'gemini', re: /^gemini-(pro|flash-lite|flash)-latest$/, tier: 1 },
    { family: 'gpt-planet', re: /^gpt-(\d+(?:\.\d+)?)-(sol|terra|luna)$/, tier: 2, ver: 1 },
    { family: 'gpt', re: /^gpt-(\d+(?:\.\d+)?)(?:-(mini|nano))?$/, tier: 2, ver: 1 },
    { family: 'mistral', re: /^mistral-(large|medium|small)(?:-(\d{4}))?(-latest)?$/, tier: 1, ver: 2, variant: 3 }
  ];
  const RANKS = { opus: 0, fable: 0, mythos: 0, sonnet: 1, haiku: 2, pro: 0, flash: 1, 'flash-lite': 2, sol: 0, terra: 1, luna: 2,
    '': 0, mini: 1, nano: 2, large: 0, medium: 1, small: 2 };
  /* parse(id) -> { id, family, rank, prefix, variant, ver, date } or null. prefix = a router's vendor path ('anthropic/'),
     variant = what a candidate must share with the base besides the family ('[1m]', ':free', '-preview'); ver = the
     version (null for an alias, which only ever matches an alias). */
  function parse(id) {
    const raw = String(id || '').trim();
    if (!raw) return null;
    let body = raw.toLowerCase(), prefix = '', variant = '';
    const slash = body.lastIndexOf('/');
    if (slash >= 0) { prefix = body.slice(0, slash + 1); body = body.slice(slash + 1); }
    const tail = body.match(/(\[[^\]]*\])?(:[\w.-]+)?$/);
    if (tail && tail[0]) { variant = tail[0]; body = body.slice(0, body.length - tail[0].length); }
    for (const f of FAMILIES) {
      const m = body.match(f.re);
      if (!m) continue;
      const word = m[f.tier] || '';
      if (!Object.prototype.hasOwnProperty.call(RANKS, word)) continue;
      const ver = f.ver && m[f.ver] ? m[f.ver].replace(/-/g, '.') : null;
      return { id: raw, family: f.family, rank: RANKS[word], prefix, variant: (f.variant && m[f.variant] ? m[f.variant] : '') + variant,
        ver, date: f.date && m[f.date] ? m[f.date] : '' };
    }
    return null;
  }
  const verParts = v => String(v || '').split('.').map(n => Number(n) || 0);
  function newer(a, b) {   // > 0 when a is newer than b
    const x = verParts(a.ver), y = verParts(b.ver);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return a.date === b.date ? 0 : (a.date > b.date ? 1 : -1);
  }
  /* tierPick({ mode, tier, base, catalog }) -> a model id from `catalog` (the ids the base model's provider lists), or
     null. The pick shares the base's family, router prefix, variant and alias-ness; the base's own version first, else
     the newest the catalog lists. */
  function tierPick(o) {
    o = o || {};
    if (!isOn(o.mode)) return null;
    const want = Object.prototype.hasOwnProperty.call(TIER_RANK, o.tier) ? TIER_RANK[o.tier] : null;
    const b = want == null ? null : parse(o.base);
    if (!b || b.rank >= want) return null;   // never above the base, and a base already on the tier stays
    const pool = (Array.isArray(o.catalog) ? o.catalog : []).map(parse).filter(c => c && c.family === b.family && c.rank === want
      && c.prefix === b.prefix && c.variant === b.variant && (c.ver == null) === (b.ver == null));
    if (!pool.length) return null;
    const same = pool.filter(c => c.ver != null && c.ver === b.ver);
    const pick = (same.length ? same : pool).slice().sort((x, y) => newer(y, x) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
    return pick ? pick.id : null;
  }

  return { ON, OFF, mode, isOn, LEAN, ORDER, surfaceOf, effortRule, sendable, TIER_RANK, parse, tierPick };
});
