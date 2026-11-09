/* sidecar/oneshot-model.js — ONE resolver for "which model does a one-shot background pass run on" (W3.5, cost audit
   2026-11-08; Andrew's call 11-08: yes, on by default for study, thread mining, scout and titles; reflection last, behind
   its own switch, default off).

   A one-shot pass is a short, strict-format extraction that nobody reads as prose: the post-run study, thread mining and
   scout cycle, and the session title. Each ran on the run's own model, so on a Claude Sonnet run every pass paid Sonnet
   rates for a job the family's small model does. Now:

     pick(kind, ctx) -> { kind, model, runModel, small, why }
       The model the pass runs on. Order:
         1. the user's own aux model (STARNET_AUX_MODEL / REFLECT_MODEL, passed as ctx.explicit) always wins, exactly as
            before this resolver (no retry: that setting's behavior is unchanged);
         2. a kind that is not switched on keeps the run model (reflection: only with ctx.reflectionOn; every kind: not
            when ctx.smallOn === false; failure review and every other kind are not small-model passes);
         3. the SMALL model of the run model's provider family, chosen only from ctx.models (the run provider's own
            catalog ids, never an id the catalog does not list): Claude -> haiku, GPT -> -mini, Gemini -> flash-lite.
            The catalog's bare alias of that tier (claude-cli's `haiku`, which follows the newest Haiku) wins, else the
            newest version; same vendor prefix only (an OpenRouter anthropic/ run never lands on openai/).
         4. otherwise the run model: an unknown family, a family whose small model the catalog does not list, or a run
            model that is already small.
       small: true only for step 3. why: one word for the log line.

     call(plan, attempt, accept, opts) -> { text, model, retried, tries }
       Runs one call of a pass. attempt(model, which) streams one completion and returns its text (it throws on an
       error). On the small model, a reply the pass cannot use (accept(text) false: empty, a refusal, malformed output)
       or an error is retried ONCE on the run's model; both calls went through the pass's own meter, so both are
       recorded under the model each ran on. A pass the caller aborted (opts.aborted()) is never retried. A plan that
       is not small calls once, as before.

     guard(provider, plan, accept) -> provider
       The same retry for a pass that runs inside the agent loop (the session title): the small model's reply is held
       until it ends; a usable one is replayed unchanged, an unusable one (or an error) yields only its billing facts
       (usage, generation, billing) and throws an error marked oneShotUnusable, which errorClass files as
       `oneshot_unusable` (shouldFallback) — the loop books the small call under the small model, emits provider.fallback
       (fromModel small -> toModel run model) and runs the turn once on the run model, the first entry of its fallback
       chain (fallbackEntry). Requests on any other model pass straight through. innerOf(guarded) names the adapter a
       guard wraps (null for any other adapter): the run's credential watch is keyed by that adapter.

     isNone(text) · titleOf(raw) · verdict(text, accept) · smallModelOf(runModel, ids) · familyOf(id)

   Pure: no fs, no network, no clock. */
'use strict';

const str = v => (v == null ? '' : String(v));

// the kinds this resolver may move to the small model: 'on' = on by default, 'switch' = only with its own switch
const KINDS = { study: 'on', threadmine: 'on', scout: 'on', title: 'on', reflection: 'switch' };

/* provider families: how a model id says its family and tier, and which catalog ids are that family's SMALL model.
   base = the id without its vendor prefix (`anthropic/`), its `[1m]`-style suffix or a `:variant`. */
const FAMILIES = [
  {
    family: 'claude',
    is: b => /^claude-/i.test(b) || /^(?:opus|sonnet|haiku|fable)$/i.test(b),
    tier: b => /haiku/i.test(b) ? 'small' : /sonnet/i.test(b) ? 'mid' : 'large',
    alias: 'haiku',
    small: b => /^claude-(?:haiku-\d+(?:[-.]\d+)*|\d+(?:[-.]\d+)*-haiku)(?:-\d{8})?(?:-latest)?$/i.test(b)
  },
  {
    family: 'gpt',
    is: b => /^gpt-\d/i.test(b),
    tier: b => /-(?:mini|nano)(?:-|$)/i.test(b) ? 'small' : 'large',
    alias: '',
    small: b => /^gpt-\d+(?:\.\d+)?o?-mini(?:-\d{4}-\d{2}-\d{2})?$/i.test(b)
  },
  {
    family: 'gemini',
    is: b => /^gemini-\d/i.test(b),
    tier: b => /flash-lite/i.test(b) ? 'small' : /flash/i.test(b) ? 'mid' : 'large',
    alias: '',
    small: b => /^gemini-\d+(?:\.\d+)?-flash-lite(?:-preview(?:-[\d-]+)?|-latest|-\d{3})?$/i.test(b)
  }
];

function split(id) {
  const s = str(id).trim();
  const at = s.lastIndexOf('/');
  const prefix = at >= 0 ? s.slice(0, at + 1) : '';
  let base = at >= 0 ? s.slice(at + 1) : s;
  const variant = /:|\[[^\]]*\]$/.test(base);
  base = base.replace(/\[[^\]]*\]$/, '').replace(/:.*$/, '');
  return { prefix, base, variant };
}
function familyOf(id) {
  const { base } = split(id);
  if (!base) return null;
  for (const f of FAMILIES) if (f.is(base)) return { family: f.family, tier: f.tier(base), def: f };
  return null;
}
// the version numbers in an id (a trailing 8-digit snapshot date and a preview date are not the version)
function versionOf(base) {
  const b = str(base).replace(/-\d{8}$/, '').replace(/-preview(?:-[\d-]+)?$/i, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return (b.match(/\d+/g) || []).map(Number);
}
function newer(a, b) {   // > 0 when version a is newer than b
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] == null ? -1 : a[i], y = b[i] == null ? -1 : b[i];
    if (x !== y) return x - y;
  }
  return 0;
}

/* smallModelOf(runModel, ids) -> { model, why }: the family's small model as the catalog lists it, or model '' and why. */
function smallModelOf(runModel, ids) {
  const run = split(runModel);
  const fam = familyOf(runModel);
  if (!fam) return { model: '', why: 'unknown-family' };
  if (fam.tier === 'small') return { model: '', why: 'already-small' };
  const list = Array.isArray(ids) ? ids.map(str).filter(Boolean) : [];
  if (!list.length) return { model: '', why: 'no-catalog' };
  let best = null;
  for (const id of list) {
    if (id === str(runModel)) continue;
    const c = split(id);
    if (c.variant || c.prefix !== run.prefix) continue;
    const isAlias = !!fam.def.alias && c.base.toLowerCase() === fam.def.alias;
    if (!isAlias && !fam.def.small(c.base)) continue;
    const cand = { id, alias: isAlias, v: versionOf(c.base) };
    if (!best) { best = cand; continue; }
    if (cand.alias !== best.alias) { if (cand.alias) best = cand; continue; }   // the alias follows the newest release
    const d = newer(cand.v, best.v);
    if (d > 0 || (d === 0 && cand.id.length < best.id.length)) best = cand;  // a tie: the undated id
  }
  return best ? { model: best.id, why: 'family-small' } : { model: '', why: 'no-small-in-catalog' };
}

function plan(kind, model, runModel, small, why) { return { kind, model: str(model), runModel: str(runModel), small: !!small, why }; }

function pick(kind, ctx) {
  const c = ctx || {};
  const k = str(kind);
  const runModel = str(c.runModel);
  const explicit = str(c.explicit).trim();
  if (explicit) return plan(k, explicit, runModel, false, 'explicit');
  const mode = KINDS[k];
  if (!mode) return plan(k, runModel, runModel, false, 'not-a-small-pass');
  if (c.smallOn === false || (mode === 'switch' && c.reflectionOn !== true)) return plan(k, runModel, runModel, false, 'switch-off');
  const s = smallModelOf(runModel, c.models);
  return s.model ? plan(k, s.model, runModel, true, s.why) : plan(k, runModel, runModel, false, s.why);
}

// a pass's explicit "nothing to keep": a line that is just NONE (markdown bold or a trailing stop allowed)
const NONE_LINE = /^\s*\**\s*NONE\s*\**\s*[.!]?\s*$/im;
function isNone(text) { return NONE_LINE.test(str(text)); }
const REFUSAL = /\b(?:i(?:'|’)?m sorry|i am sorry|i can(?:'|’)?t|i cannot|i(?:'|’)?m unable|i am unable|as an ai)\b/i;
// why a reply is unusable ('' = usable): empty, refusal or malformed
function verdict(text, accept) {
  const t = str(text).trim();
  if (!t) return 'empty';
  let ok = false;
  try { ok = typeof accept === 'function' ? !!accept(t) : true; } catch (_) { ok = false; }
  if (ok) return '';
  return REFUSAL.test(t) ? 'refusal' : 'malformed';
}

/* titleOf(raw) -> the clean title or '' — the sidecar's copy of frontend/app/chat.js cleanTitle (the page keeps the final
   word; test/oneshot-model.test.js holds the two to the same verdicts). */
function titleOf(raw) {
  let t = str(raw).trim();
  if (!t) return '';
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = (t.split(/\r?\n/).find(l => l.trim()) || '').trim();
  t = t.replace(/^#+\s*/, '').replace(/^title\s*[:\-—]\s*/i, '');
  t = t.replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/[\s.:;,—–-]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 64) return '';
  if (/\b(sorry|cannot|can't|unable|as an ai|here(?:'s| is)|i (?:can|am|will|would))\b/i.test(t)) return '';
  return t;
}

async function call(p, attempt, accept, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : null;
  if (!p || !p.small || !p.runModel || p.runModel === p.model) {
    const text = await attempt(p && p.model, 'only');
    return { text, model: p && p.model, retried: '', tries: [{ model: p && p.model, why: '' }] };
  }
  let text = null, why = '';
  try {
    text = await attempt(p.model, 'small');
    why = verdict(text, accept);
  } catch (e) {
    if (o.aborted && o.aborted()) throw e;   // the pass gave up (its timeout): no second call
    why = 'error';
  }
  if (!why) return { text, model: p.model, retried: '', tries: [{ model: p.model, why: '' }] };
  if (o.aborted && o.aborted()) return { text: '', model: p.model, retried: '', tries: [{ model: p.model, why }] };
  if (log) log(p.kind + ': the small model ' + p.model + ' gave an unusable reply (' + why + ') — retrying once on the run model ' + p.runModel);
  const again = await attempt(p.runModel, 'retry');
  return { text: again, model: p.runModel, retried: why, tries: [{ model: p.model, why }, { model: p.runModel, why: '' }] };
}

// an error the loop files as `oneshot_unusable` (errorClass): it falls back to the run model, once
function unusableError(p, why, cause) {
  const e = new Error('the small model ' + p.model + ' gave an unusable ' + p.kind + ' reply (' + why + ') — retrying once on the run model ' + p.runModel);
  e.oneShotUnusable = true;
  e.oneShotWhy = why;
  if (cause) e.cause = cause;
  return e;
}
const BILLING = { usage: 1, generation: 1, billing: 1 };
// the adapter a guard wraps: identity-keyed host state (the run's credential watch) reads through the guard to it
const INNER = Symbol.for('starnet.oneShotInner');
function innerOf(adapter) { return adapter && (typeof adapter === 'object' || typeof adapter === 'function') ? (adapter[INNER] || null) : null; }
function guard(provider, p, accept) {
  if (!provider || typeof provider.stream !== 'function' || !p || !p.small) return provider;
  const inner = provider.stream;
  const out = Object.assign({}, provider, {
    stream(req) {
      if (!req || str(req.model) !== p.model) return inner.call(provider, req);
      return (async function* held() {
        const events = [];
        let text = '', err = null;
        try {
          for await (const ev of inner.call(provider, req)) {
            events.push(ev);
            if (ev && ev.type === 'text') text += str(ev.delta);
          }
        } catch (e) { err = e; }
        if (req.signal && req.signal.aborted) {   // a Stop is the Commander's, never a reason to call again
          for (const ev of events) if (ev && BILLING[ev.type]) yield ev;
          if (err) throw err;
          return;
        }
        const why = err ? 'error' : verdict(text, accept);
        if (!why) { for (const ev of events) yield ev; return; }
        for (const ev of events) if (ev && BILLING[ev.type]) yield ev;
        throw unusableError(p, why, err);
      })();
    }
  });
  out[INNER] = provider;
  return out;
}
// the run model's place at the head of the loop's fallback chain (same provider, same route)
function fallbackEntry(provider, providerId, p) { return { provider, providerId, model: p.runModel }; }

module.exports = { pick, call, guard, innerOf, fallbackEntry, verdict, isNone, titleOf, smallModelOf, familyOf, KINDS,
  _internals: { split, versionOf, newer, FAMILIES, REFUSAL, NONE_LINE } };
