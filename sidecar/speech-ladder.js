'use strict';

/* sidecar/speech-ladder.js — ONE synthesis ladder for every surface that speaks (speech-ladder lane, wave 4).

   The desk (POST /api/tts), the desk's Live/built-in mode (the same route with `local`), the paired device
   (remote/voice.js `speak`) and the agent's voice_generate each used to run their own ladder: a different leg order, a
   different voice (the desk spoke the station voice, voice_generate and the device's keyed tail a stock 'Umbriel'), a
   different retry (the desk retried a blip twice, spaced; the device and the tool never), and a different continuity
   rule (the device and Live pinned a reply to its first engine, the desk's keyed path switched speaker on a blip).

   This module is the rule they all share. It is PURE (no I/O, no clock of its own): media-service.js supplies one
   attempt function per engine and the clock, and every surface goes through synthesize() there.

     plan({ identity, pin, policy, keyed }) -> legs, in order
     run(legs, attempt, { sleep, budgetLeft, gone }) -> { ok, leg, result, failures:[{ leg, text }], tries:[...] }

   LEG ORDER is a function of the IDENTITY, the PIN and the POLICY only, never of the surface. A surface picks only its
   default identity engine and policy, from the SURFACE_DEFAULTS table below (today's behaviour of each, unchanged), so
   the one place a surface may differ is visible and tested.

   IDENTITY (the sidecar owns it; a client sends a persona id and its surface):
     engine 'keyed' — the station's neural voice: STATION_VOICE (model, voice, style) on the keyed providers, then the
                      free Edge floor in its default voice.
     engine 'local' — the built-in engine's voice (a Live pick or the default), then that voice's mapped Edge neural
                      voice, then (policy.keyedAfterFloor) the keyed ladder without a second Edge try.
   Every agent and every persona speaks as the one station voice (Andrew 2026-07-12, "ONE LOCKED VOICE"); a
   voice_generate call may still name its own voice and style for a clip.

   CONTINUITY (one rule): a reply is pinned to the engine that spoke its first sentence. A pinned sentence tries only
   that leg: it fails, typed, rather than change the speaker halfway.

   RETRY (one rule, the desk's): a leg whose failure is TRANSIENT (speech-outcome.js) is tried again after 400 ms, then
   after 1200 ms (or the provider's Retry-After when that is longer, up to 3 s: a longer ask is not retried), while the sentence's deadline has at least
   MIN_RETRY_BUDGET_MS left past the wait. A terminal failure, a cancellation, or a leg that says retry:false (a model
   still loading in the background) moves straight to the next leg.

   POLICY (spend and patience; the defaults are each surface's behaviour before this lane):
     walkKeyed        after the first keyed account fails, try the next keyed account. Off on the desk (it spends only
                      the account it chose), on for the device and voice_generate. Changing a default is Andrew's
                      spend decision; a host may set it per surface (makeMediaService({ speechPolicy })).
     keyedAfterFloor  a 'local' identity falls to the keyed voice after the Edge floor fails (device: yes; Live: no — a
                      station that chose the built-in voice does not spend on a keyed one).
     localWaitsForModel  the built-in engine is waited on even while its model is cold or downloading (Live: yes, the
                      desk gives its first local sentence 90 s; device: no — a model not yet on disk loads in the
                      background and this reply takes the next leg).
     cache            clips are read from and written to the voice cache (the desk and Live, as before; the device and
                      voice_generate never cached, and still do not). */

const SO = require('./speech-outcome.js');

const RETRY_GAP_MS = Object.freeze([400, 1200]);   // the desk's spaced retry (frontend/app/voice.js RETRY_GAP_MS)
const MIN_RETRY_BUDGET_MS = 1000;                   // less than this left after the wait: the leg is not retried
const MAX_RETRY_WAIT_MS = 3000;                     // a provider that asks for a longer wait is not retried inside the sentence (the desk's RETRY_WAIT_MAX_MS)
const SURFACES = Object.freeze(['desk', 'live', 'device', 'agent']);

const SURFACE_DEFAULTS = Object.freeze({
  desk:   Object.freeze({ engine: 'keyed', policy: Object.freeze({ walkKeyed: false, keyedAfterFloor: false, localWaitsForModel: true, cache: true }) }),
  live:   Object.freeze({ engine: 'local', policy: Object.freeze({ walkKeyed: false, keyedAfterFloor: false, localWaitsForModel: true, cache: true }) }),
  device: Object.freeze({ engine: 'local', policy: Object.freeze({ walkKeyed: true, keyedAfterFloor: true, localWaitsForModel: false, cache: false }) }),
  agent:  Object.freeze({ engine: 'keyed', policy: Object.freeze({ walkKeyed: true, keyedAfterFloor: false, localWaitsForModel: true, cache: false }) })
});

/* The station's ONE voice on the keyed providers. frontend/app/personas.js STATION_VOICE carries the same voice and
   style for the desk's playback shell; the conformance test holds the two equal. The model is the sidecar's. */
const STATION_VOICE = Object.freeze({
  voice: 'Algenib',
  style: 'A low, smooth American male voice with a subtle gravelly rasp and clean, crisp articulation. Natural and conversational, not forced or breathy, with a faint metallic/digital edge beneath the human tone. Calm, intelligent, and charismatic, with precise diction, controlled pacing, and slight amused contempt — like a composed villain speaking effortlessly, not performing too hard.'
});

const KEYED_ENGINES = Object.freeze(['openrouter', 'gemini', 'openai']);
const isKeyedEngine = e => KEYED_ENGINES.indexOf(e) >= 0;

function surfaceOf(s) { return SURFACES.indexOf(s) >= 0 ? s : 'desk'; }

// the policy a surface runs: its defaults, then the host's per-surface override (a spend decision lives in config)
function policyFor(surface, overrides) {
  const base = SURFACE_DEFAULTS[surfaceOf(surface)].policy;
  const o = overrides && overrides[surfaceOf(surface)];
  const out = Object.assign({}, base);
  if (o && typeof o === 'object') for (const k of Object.keys(base)) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

/* legs, in order. keyed = [{ provider, key, source }] in preference order (an explicit page key first, alone, when the
   request carried one). A pin keeps only its own leg; a pin to a keyed provider with no credential is one no_key leg. */
function plan(o) {
  const identity = o.identity || {};
  const policy = o.policy || {};
  const keyed = Array.isArray(o.keyed) ? o.keyed : [];
  const pin = String(o.pin || '');
  const keyedLegs = (first) => {
    const list = policy.walkKeyed ? keyed : keyed.slice(0, 1);
    if (!list.length) return [{ engine: 'keyed', kind: 'keyed', missing: true }];
    return list.map(k => ({ engine: k.provider, kind: 'keyed', key: k.key, source: k.source || 'station', model: identity.model, voice: identity.voice, style: identity.style }))
      .map((l, i) => (i === 0 && first ? Object.assign(l, first) : l));
  };
  const edge = voice => ({ engine: 'edge', kind: 'edge', voice: voice || '' });
  const local = () => ({ engine: 'local-kokoro', kind: 'local', voice: identity.localVoice, speed: identity.speed, waitsForModel: !!policy.localWaitsForModel });
  let legs;
  if (identity.engine === 'local') {
    legs = [local(), edge(identity.mappedEdgeVoice)];
    if (policy.keyedAfterFloor) legs = legs.concat(keyedLegs());
  } else if (identity.engine === 'edge') {
    // a caller named an Edge neural voice for this clip (voice_generate): that voice first, the station's keyed voice after
    legs = [edge(identity.edgeVoice)].concat(keyedLegs());
  } else {
    legs = keyedLegs().concat([edge(identity.edgeVoice)]);
  }
  if (!pin) return legs;
  const pinned = legs.filter(l => l.engine === pin);
  if (pinned.length) return pinned.slice(0, 1);
  // a pin to a keyed account this policy would not have planned (Live never spends on a keyed voice; the desk spends one
  // account) is that account's missing credential: a pin never buys a paid call the policy forbids
  if (isKeyedEngine(pin)) return [{ engine: pin, kind: 'keyed', missing: true }];
  if (pin === 'edge') return [edge(identity.engine === 'local' ? identity.mappedEdgeVoice : identity.edgeVoice)];
  if (pin === 'local-kokoro') return [local()];
  return legs;
}

// retry? a transient failure, with time left for the wait and a real attempt after it
function retryWaitMs(failure, attemptIndex, budgetLeft) {
  if (!failure || !failure.leg || failure.retry === false) return -1;
  if (attemptIndex >= RETRY_GAP_MS.length) return -1;
  if (SO.isTerminalCode(failure.leg.code)) return -1;
  const asked = Number(failure.leg.retryAfterMs) || 0;
  if (asked > MAX_RETRY_WAIT_MS) return -1;
  const wait = Math.max(RETRY_GAP_MS[attemptIndex], asked);
  const left = typeof budgetLeft === 'function' ? budgetLeft() : Infinity;
  if (left - wait < MIN_RETRY_BUDGET_MS) return -1;
  return wait;
}

/* Walk the legs. attempt(leg, { failures }) -> { ok:true, ... } | { ok:false, leg (a SpeechOutcome leg), text (legacy
   reason part), retry?:false, stop?:true } | { ok:false, skip:true } (the leg does not apply here: the built-in engine
   is not installed, so it was never tried). A failure with stop:true ends the ladder there (the caller went away). Every try is recorded in `tries` ({ engine, attempt, code, waitMs }) so a surface's
   leg order, retries and outcome can be compared with any other's. */
async function run(legs, attempt, ctx) {
  const c = ctx || {};
  const sleep = typeof c.sleep === 'function' ? c.sleep : (ms => new Promise(r => setTimeout(r, ms)));
  const gone = typeof c.gone === 'function' ? c.gone : (() => false);
  const failures = [], tries = [];
  for (const leg of legs) {
    let n = 0;
    for (;;) {
      if (gone()) return { ok: false, gone: true, failures, tries };
      let r;
      try { r = await attempt(leg, { failures }); }
      catch (error) { r = { ok: false, leg: SO.errorLeg(leg.engine, error), text: leg.engine + ': ' + ((error && error.message) || error) }; }
      if (r && r.ok) { tries.push({ engine: leg.engine, attempt: n + 1, code: 'ok', waitMs: 0 }); return { ok: true, leg, result: r, failures, tries }; }
      if (r && r.skip) { tries.push({ engine: leg.engine, attempt: n + 1, code: 'skipped', waitMs: 0 }); break; }
      const f = r || { ok: false, leg: SO.leg(leg.engine, 'internal_error', { detail: 'no result' }) };
      const wait = f.stop ? -1 : retryWaitMs(f, n, c.budgetLeft);
      tries.push({ engine: leg.engine, attempt: n + 1, code: f.leg ? f.leg.code : 'unknown', waitMs: wait > 0 ? wait : 0 });
      if (wait < 0) { if (f.leg || f.text || f.gone) failures.push(f); break; }
      n++;
      if (gone()) return { ok: false, gone: true, failures, tries };   // nobody wants it any more: no wait, no retry
      await sleep(wait);
    }
    if (failures.length && failures[failures.length - 1].stop) break;
  }
  return { ok: false, failures, tries };
}

module.exports = { RETRY_GAP_MS, MIN_RETRY_BUDGET_MS, MAX_RETRY_WAIT_MS, SURFACES, SURFACE_DEFAULTS, STATION_VOICE, KEYED_ENGINES, surfaceOf, policyFor, plan, retryWaitMs, run };
