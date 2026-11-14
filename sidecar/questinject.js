/* sidecar/questinject.js — fold an agent's OPEN quests (the harness-owned QUEST LEDGER, quest-store.js) into its
   system prompt as a `STATION QUESTS` block, so a run can SEE and ACT ON its quests (QUEST V2, plan §B — agent
   awareness). The v1 system had zero agent visibility: nothing in the prompt, no tool — asking an agent about a
   quest could never work. This is the read half; the write half is the quest.update tool (tools/builtin/quests.js).

   Two functions, mirroring dossierinject.js exactly:
     questBlock(quests) — format an array of open quest records into the STATION QUESTS block. A NON-empty list →
       the full block (how-to header + minting doctrine + per-quest stanzas). An EMPTY/absent list → the MINIMAL
       minting-doctrine block (NOT '') — a no-quest agent is exactly who should consider grounded minting (plan §E).
     withQuests(system, block) — append the block to a system prompt; an empty/whitespace block is a STRICT no-op
       (byte-identical to a quest-less run — the invariant the non-task path depends on). Idempotent.

   NO-OP INVARIANT (moved to the caller): the strict byte-identical no-op now lives at the injection call site
   (sidecar/index.js), which composes questBlock ONLY for a task run (isTask). A non-task run never calls it, so
   withQuests('' , ...) stays the no-op for that path. questBlock itself never returns '' anymore.

   PURE (a `withQuests`/`questBlock` on the SK namespace in the browser UMD shape, module.exports under node) +
   node-testable: no Date.now / Math.random / fs / network — exactly what lint-determinism.js requires of a helper
   that rides the run-composition path. The caller passes questStore.openForAgent(agentId); this never reads a store. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).questInject = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // keep the whole block bounded so a large open ledger can't crowd out the rest of the prompt. Past the cap the
  // OLDEST quests are dropped first (a "…and N more in the QUEST LOG" line replaces them) — the newest direction
  // is what the agent should act on now, and nothing is silently lost (the full ledger is one tool/route call away).
  // ~2200 covers the fixed header + minting doctrine + a handful of stanzas (plan §E cap guidance).
  const BLOCK_CAP = 2200;

  const HEADER = 'STATION QUESTS — your standing objectives for the Commander. These progress the game in sync '
    + 'with the Commander\'s real work. To interact, use the quest.update tool: op:"start" binds the ONE named run '
    + 'quest you are beginning to this run; op:"progress" ticks a named step '
    + '(pass a short note on what you did); op:"attest_complete" PROPOSES a quest done with concrete evidence — it '
    + 'is NEVER complete until the Commander confirms. Never claim a quest done in prose alone; a mechanical quest '
    + 'completes on its own when the harness proves it.';

  // MINTING DOCTRINE (plan §E — generative minting). Rides EVERY task run's block (with quests or not), because a
  // no-quest agent is exactly who should consider minting. Tight + grounded + bounded: mint ONLY off a concrete
  // dossier/memory fact that reveals a recurring need or stated goal with no matching open quest, cite that fact in
  // groundedIn, aim at a real outcome the Commander wants (never "busywork" — a literal past failure), one per run.
  const MINT_DOCTRINE = 'MINTING — you MAY create ONE new quest this run with quest.update op:"mint", but ONLY when a '
    + 'concrete fact in your dossier or memory reveals a recurring need or a stated goal that has NO matching open '
    + 'quest above. Ground it: pass groundedIn naming that exact fact. A minted quest must be a real outcome the '
    + 'Commander wants — a goal, an aspiration, or work to automate — with a valid completion contract. Pass the '
    + 'closest honest domain (building, research, writing, growth, operations, creative, planning, or support) so '
    + 'verified completion can teach the right agent mastery track; never '
    + 'busywork, never a generic chore. If nothing concrete motivates one, mint nothing. At most ONE mint per run.';

  // the fixed prefix carried by a NON-EMPTY block: the how-to header + the minting doctrine (both always ride).
  const FIXED = HEADER + '\n\n' + MINT_DOCTRINE;

  // the MINIMAL block emitted when the agent has NO open quests: a short frame + the minting doctrine only. This is
  // NOT '' — an empty ledger for a task run should still invite grounded minting (plan §E). withQuests appends it.
  const NONE_LINE = 'STATION QUESTS — you have no open quests for the Commander right now.';
  const MINT_ONLY = NONE_LINE + '\n\n' + MINT_DOCTRINE;

  /* THE TWO HALVES OF THE BLOCK (cost lane, 2026-11-14; sidecar/slim-note.js, STARNET_SLIM_NOTE). The block rides the
     per-run note beside the newest message, which no cache reads, and its how-to header and minting doctrine are the
     same bytes on every message: 1,240 characters ahead of a quest that takes 290. split() takes a block questBlock()
     wrote and returns the constant half for the system prompt (guide) and what is left for the note (list).
       guide  the header and the doctrine, word for word, with the two places that point at the list re-pointed: one
              sentence saying where the list is, and the doctrine's "open quest above" as "open quest in that block"
              (the list is no longer above it). The same text whether the list is empty or not, so a quest minted or
              finished in the middle of a conversation never moves the system prompt.
       list   exactly the stanzas (and the "...and N more" line) questBlock() kept under BLOCK_CAP, under a one-line
              head; an empty ledger keeps its own first line.
     A block this module did not write returns null, and the caller leaves it whole. */
  const LIST_HEAD = 'STATION QUESTS — your open quests for the Commander right now:';
  const LIST_POINTER = 'Your open quests are listed in the STATION QUESTS block of this run\'s context note, which also says when you have none.';
  const ABOVE = 'NO matching open quest above';
  const GUIDE = HEADER + ' ' + LIST_POINTER + '\n\n' + MINT_DOCTRINE.replace(ABOVE, 'NO matching open quest in that block');
  function split(block) {
    const b = String(block == null ? '' : block);
    if (MINT_DOCTRINE.indexOf(ABOVE) < 0) return null;   // the doctrine no longer points at the list that way: nothing is re-pointed blind
    if (b === MINT_ONLY) return { guide: GUIDE, list: NONE_LINE };
    const head = FIXED + '\n\n';
    if (b.indexOf(head) === 0 && b.length > head.length) return { guide: GUIDE, list: LIST_HEAD + '\n\n' + b.slice(head.length) };
    return null;
  }

  // contract type → the one-line "how this completes" phrasing the agent reads under each quest.
  function completesWhen(contract) {
    const type = (contract && contract.type) || '';
    switch (type) {
      case 'run': return 'completes when: the bound run finishes successfully';
      case 'prop': return 'completes when: the required capability goes live on the station';
      case 'fact': return 'completes when: the harness learns this about the Commander';
      case 'artifact': return 'completes when: the named deliverable exists in the workspace';
      case 'attest': return 'completes when you attest with concrete evidence and the Commander confirms';
      default: return 'completes when: the harness proves it';
    }
  }

  // first not-yet-done step of a quest, or null (no steps, or all ticked).
  function nextStep(q) {
    const steps = (q && Array.isArray(q.steps)) ? q.steps : [];
    for (const s of steps) { if (s && !s.done) return s; }
    return null;
  }

  // render ONE quest into a compact stanza. Order: id + title, next step, completes-when, why (groundedIn),
  // and any prior decline note (so the agent addresses it before re-attesting).
  function stanza(q) {
    const lines = [];
    const title = String((q && q.title) || '(untitled)').trim() || '(untitled)';
    lines.push('- [' + String((q && q.id) || '?') + '] ' + title);
    const ns = nextStep(q);
    if (ns) lines.push('    next step (' + ns.key + '): ' + (String(ns.label || ns.key).trim() || ns.key)
      + ' — tick it with quest.update op:"progress" stepKey:"' + ns.key + '"');
    if (q && q.contract && q.contract.type === 'run') lines.push('    start this quest first with quest.update op:"start" id:"' + String(q.id || '') + '" — only this explicit binding can make the run count');
    lines.push('    ✓ ' + completesWhen(q && q.contract));
    const grounded = q && q.groundedIn != null ? String(q.groundedIn).trim() : '';
    if (grounded) lines.push('    why: ' + grounded);
    const masteryDomain = q && q.domain != null ? String(q.domain).trim() : '';
    if (masteryDomain) lines.push('    mastery track: ' + masteryDomain + ' (counts only after verified completion)');
    const dn = q && q.declineNote;
    if (dn) {
      const note = String((dn && dn.note) || '').trim();
      lines.push('    ⚑ your last completion claim was declined' + (note ? ': ' + note : '')
        + ' — address it before re-attesting.');
    }
    return lines.join('\n');
  }

  // format an agent's OPEN quests into the STATION QUESTS block. Empty/absent list → the MINIMAL minting-doctrine
  // block (NOT '' — an empty ledger for a task run should still invite grounded minting, plan §E). The caller gates
  // this on isTask, so a non-task run never composes it; withQuests('' ...) stays the no-op for the non-task path.
  // Defensively clips to BLOCK_CAP, dropping the OLDEST quests first.
  function questBlock(quests) {
    const list = Array.isArray(quests) ? quests.filter(Boolean) : [];
    if (!list.length) return MINT_ONLY;

    // build stanzas in ledger order (oldest→newest), then keep from the NEWEST end until the cap is reached, so
    // the quests dropped under pressure are the oldest ones. The fixed prefix (header + minting doctrine) always rides.
    const stanzas = list.map(stanza);
    const headerLen = FIXED.length + 2;    // + the '\n\n' that joins the prefix to the first stanza

    let used = headerLen;
    let firstKept = stanzas.length;        // index of the oldest stanza we keep (exclusive-below = dropped)
    for (let i = stanzas.length - 1; i >= 0; i--) {
      const add = stanzas[i].length + 2;   // + the '\n\n' separator
      if (used + add > BLOCK_CAP && firstKept < stanzas.length) break;   // keep at least the newest one
      used += add;
      firstKept = i;
    }
    const dropped = firstKept;             // stanzas[0..firstKept) were dropped
    const kept = stanzas.slice(firstKept);
    const parts = [FIXED];
    if (dropped > 0) parts.push('…and ' + dropped + ' more open quest' + (dropped === 1 ? '' : 's') + ' in the QUEST LOG.');
    for (const s of kept) parts.push(s);
    return parts.join('\n\n');
  }

  // append the quest block to a system prompt. Empty/whitespace block → the system is returned UNCHANGED
  // (byte-identical to a quest-less run — the no-op invariant). Idempotent: a system already containing the
  // block is never doubled. Identical shape to dossierinject.withDossier.
  function withQuests(system, block) {
    const sys = String(system == null ? '' : system);
    const b = String(block == null ? '' : block).trim();
    if (!b) return sys;
    if (sys.indexOf(b) >= 0) return sys;   // already present — never double-append
    return sys ? (sys + '\n\n' + b) : b;
  }

  return { questBlock: questBlock, withQuests: withQuests, split: split,
    _internals: { completesWhen: completesWhen, nextStep: nextStep, stanza: stanza, BLOCK_CAP: BLOCK_CAP, MINT_ONLY: MINT_ONLY, MINT_DOCTRINE: MINT_DOCTRINE,
      HEADER: HEADER, GUIDE: GUIDE, LIST_HEAD: LIST_HEAD, LIST_POINTER: LIST_POINTER, NONE_LINE: NONE_LINE } };
});
