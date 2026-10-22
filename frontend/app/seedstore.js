/* AGENT OS — seedstore.js : the browser wiring for the SELF-GROWING SEED SHELF (pure engine: seeds.js).

   When the mint detector (mintstore.js) has watched the Commander ask for the same shape of task enough times,
   the agent gently offers to AUTHOR it as a one-tap seed — a custom recipe whose {input} becomes a REQUIRED gap
   param (so a later run asks for the one thing that makes it theirs). Saving lands it in Recipes.list(), which
   means the First Pitch / ongoing-suggestion engines can then propose it too — the loop closes itself.

   Discipline (mirrors curiositystore.js / suggeststore.js): a gentle Chat.nudge (never the Dialogue panel), one
   offer per session (anti-nag), and it shares chat.js's single post-run beat slot — ceded to AFTER the ongoing
   suggestion and BEFORE curiosity, so the agent never stacks two asks on one task. READ-ONLY citizen of U.bus
   (it never emits; mint already owns the minted/dismissed bookkeeping). node-exportable for its test. */
'use strict';
const SeedStore = (() => {
  const CAP = 1;            // at most one seed offer per session
  let sessionProposed = 0;

  function init() { sessionProposed = 0; }
  function reset() { sessionProposed = 0; }

  const enabled = () => (typeof MintStore === 'undefined' || typeof MintStore.enabled !== 'function') ? true : !!MintStore.enabled();

  // the freshest mint candidate turned into a seed proposal (or null). Mint already filters minted/dismissed; the
  // NUDGE path (nudgeCandidates) additionally hides a shape already offered-and-ignored enough times, so an ignored
  // seed stops looping across sessions. Falls back to candidates() where nudgeCandidates isn't available.
  function pick() {
    if (typeof Seeds === 'undefined' || typeof MintStore === 'undefined') return null;
    const list = MintStore.nudgeCandidates || MintStore.candidates;
    if (typeof list !== 'function') return null;
    if (!enabled()) return null;   // honor the learning pause
    const cands = list.call(MintStore) || [];
    for (const c of cands) { const s = Seeds.fromCandidate(c); if (s) return s; }
    return null;
  }

  // the sync gate the post-run beat slot consults (read-only): a seed exists AND this session's budget is free.
  function willPropose() { return sessionProposed < CAP && !!pick(); }

  // render the gentle seed offer; "save it" authors the recipe-with-gap, "not now" waves the shape off for good.
  function propose() {
    if (sessionProposed >= CAP) return;
    if (typeof Chat === 'undefined' || !Chat.nudge) return;
    const s = pick(); if (!s) return;
    sessionProposed++;   // spend the session's one seed offer whether or not they save (anti-nag)
    // durably tally the offer so an IGNORED nudge (no click) stops re-surfacing this shape across sessions — the
    // counterpart to the curiosity stop-forever. Save/dismiss below set the stronger minted/dismissed flags.
    if (typeof MintStore !== 'undefined' && MintStore.markProposed) MintStore.markProposed(s.key);
    let handled = false;   // one-shot: a double-click on the choice can't double-author the recipe
    Chat.nudge(s.line, (typeof Seeds !== 'undefined' ? Seeds.choices() : []), choice => {
      if (handled) return; handled = true;
      // THE OUTCOME LOOP (quality loop, Q2): saving a seed authors a recipe rather than launching a run, so the
      // accept IS the outcome; a wave-off is the Commander's own signal about this channel. Fail-open.
      // AND THE LEDGER'S HALF (dead-wires lane, 2026-08-28): the spine minted a `shown` row for this card
      // (RecLedger.note — seed is not OWN_LEDGER), and until now nothing ever answered it, so every seed offer
      // sat on the durable ledger as an unanswered impression forever. The verdict lands in both places.
      const rq = (typeof RecQualityStore !== 'undefined') ? RecQualityStore : null;
      const rl = (typeof RecLedger !== 'undefined') ? RecLedger : null;
      if (choice && choice.value === 'save') {
        save(s);
        if (rq && rq.noteAccept) { try { rq.noteAccept({ channel: 'seed', spawnsWork: false, id: s.key }); } catch (_) {} }
        if (rl && rl.accepted) { try { rl.accepted('seed'); } catch (_) {} }
      } else {
        if (typeof MintStore !== 'undefined' && MintStore.markDismissed) MintStore.markDismissed(s.key);
        if (rq && rq.noteDecline) { try { rq.noteDecline({ channel: 'seed' }, false); } catch (_) {} }
        if (rl && rl.declined) { try { rl.declined('seed', false); } catch (_) {} }
      }
    });
  }

  // author the seed onto the shelf: a custom recipe whose {input} becomes a REQUIRED gap param (Recipes
  // derives it from the template), then mark the shape minted so it never re-proposes.
  function save(s) {
    try {
      if (!s || typeof Recipes === 'undefined' || !Recipes.saveCustom) return;
      const params = (typeof Recipes.paramsFromTemplate === 'function') ? Recipes.paramsFromTemplate(s.task) : [];
      // seedborn: durable provenance — this recipe was AUTHORED BY THE AGENT from an observed pattern (not a
      // hand-built custom), so a later pitch/suggestion/digest that reuses it can credit the Commander's seed (G3a).
      const draft = (typeof Recipes.draft === 'function')
        ? Recipes.draft({ name: s.title, task: s.task, params: params, seedborn: true })
        : { name: s.title, task: s.task, params: params, seedborn: true };
      Recipes.saveCustom(draft);
      if (typeof MintStore !== 'undefined' && MintStore.markMinted) MintStore.markMinted(s.key);
      if (typeof SFX !== 'undefined' && SFX.seed) { try { SFX.seed(); } catch (_) {} }   // G3a: saving a seed gets its planting chime (was mute)
      // NO StationUI.notify (notification diet): the chime is the moment; the seed is findable under RECIPES.
    } catch (_) {}
  }

  return { init, reset, willPropose, propose, _pick: pick, _save: save };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { SeedStore };
