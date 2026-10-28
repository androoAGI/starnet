/* node test/questinject.test.js — the pure agent-awareness prompt folder (sidecar/questinject.js, QUEST V2 §B).
   Locks: questBlock formats a stanza per open quest (id, title, next open step, completes-when in words,
   groundedIn, declineNote) with a how-to header; an EMPTY list is the exact empty string ''; withQuests appends
   the block and an empty/whitespace block is a STRICT byte-identical no-op (the invariant the cron tests share);
   it never double-appends; and the block is clipped to the cap, dropping the OLDEST quests first with a "N more"
   note. Pure + deterministic (no clock/rng/fs). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { questBlock, withQuests, _internals } = require('../sidecar/questinject.js');

const SYS = 'You are an autonomous STARNET station agent.';

/* ---------- empty list → the MINIMAL minting-doctrine block (NOT '' — a no-quest agent should still mint, §E) ---------- */
{
  const mb = questBlock([]);
  A.ok(mb.indexOf('STATION QUESTS') === 0, 'empty ledger → a minimal block still headed STATION QUESTS (never the empty string)');
  A.ok(/no open quests/.test(mb), 'the minimal block says there are no open quests right now');
  A.ok(mb.indexOf('op:"mint"') >= 0, 'the minimal block carries the minting doctrine (quest.update op:"mint")');
  A.ok(mb.indexOf('groundedIn') >= 0, 'the minting doctrine demands grounding (groundedIn a concrete fact)');
  A.ok(mb.indexOf('busywork') >= 0, 'the minting doctrine forbids busywork');
  A.ok(mb.length < 900, 'the minimal block stays a few lines (minting doctrine only, no stanzas)');
  A.eq(questBlock(null), mb, 'null → the same minimal minting block');
  A.eq(questBlock(undefined), mb, 'undefined → the same minimal minting block');
  A.eq(mb, _internals.MINT_ONLY, 'the empty-ledger block is exactly the exported MINT_ONLY constant');
}

/* ---------- withQuests still no-ops on an EMPTY block (the non-task path never composes a block) ---------- */
A.eq(withQuests(SYS, ''), SYS, 'an empty block is a strict no-op (byte-identical) — the non-task path');
A.eq(withQuests(SYS, '   \n  '), SYS, 'a whitespace-only block is a no-op');
A.eq(withQuests(SYS, null), SYS, 'a null block is a no-op');
A.eq(withQuests(SYS, questBlock([])), SYS + '\n\n' + questBlock([]), 'an empty ledger now APPENDS the minting-doctrine block (a task run should mint)');

/* ---------- a run quest with steps: header, id+title, next step, completes-when ---------- */
{
  const q = { id: 'q:1', title: 'Automate the CSV export', kind: 'work', contract: { type: 'run', key: 'r1' },
    steps: [{ key: 'a', label: 'gather the columns', done: true }, { key: 'b', label: 'write the script', done: false }],
    groundedIn: 'dossier: exports CSVs by hand every morning' };
  const b = questBlock([q]);
  A.ok(b.indexOf('STATION QUESTS') === 0, 'block starts with the STATION QUESTS header');
  A.ok(b.indexOf('quest.update') >= 0, 'header tells the agent to use the quest.update tool');
  A.ok(b.indexOf('op:"mint"') >= 0 && b.indexOf('At most ONE mint per run') >= 0, 'the full block carries the minting doctrine too (rides every task run)');
  A.ok(b.indexOf('[q:1] Automate the CSV export') >= 0, 'stanza carries id + title');
  A.ok(b.indexOf('next step (b): write the script') >= 0, 'stanza names the FIRST not-done step (a is done → b)');
  A.ok(b.indexOf('the bound run finishes') >= 0, 'run contract phrased "the bound run finishes"');
  A.ok(b.indexOf('why: dossier: exports CSVs by hand every morning') >= 0, 'groundedIn surfaced as "why:"');
  A.ok(b.indexOf('op:"start"') >= 0, 'run stanza tells the agent to explicitly start THIS quest before doing its work');
  A.ok(b.indexOf('id:"q:1"') >= 0, 'the start instruction names the exact quest id — no ambient auto-binding');
}

/* ---------- an attest quest with a prior decline: completes-when phrasing + the decline note ---------- */
{
  const q = { id: 'q:2', title: 'Draft the launch email', contract: { type: 'attest', key: '' },
    steps: [], declineNote: { at: 5, note: 'the draft was too generic' } };
  const b = questBlock([q]);
  A.ok(b.indexOf('attest with concrete evidence and the Commander confirms') >= 0, 'attest contract phrased for attest+confirm');
  A.ok(b.indexOf('your last completion claim was declined: the draft was too generic') >= 0, 'declineNote surfaced verbatim');
  A.ok(b.indexOf('address it before re-attesting') >= 0, 'declineNote tells the agent to address it before re-attesting');
  A.ok(b.indexOf('next step') < 0, 'a quest with no steps shows no next-step line');
}

/* ---------- contract phrasing per type ---------- */
A.ok(_internals.completesWhen({ type: 'prop' }).indexOf('capability goes live') >= 0, 'prop → capability goes live');
A.ok(_internals.completesWhen({ type: 'fact' }).indexOf('harness learns') >= 0, 'fact → harness learns');
A.ok(_internals.completesWhen({ type: 'artifact' }).indexOf('deliverable exists') >= 0, 'artifact → deliverable exists');
A.ok(_internals.completesWhen({ type: 'attest' }).indexOf('Commander confirms') >= 0, 'attest → Commander confirms');
A.ok(_internals.completesWhen({}).indexOf('harness proves it') >= 0, 'unknown type → safe default');

/* ---------- nextStep helper: first not-done, or null ---------- */
A.eq(_internals.nextStep({ steps: [{ key: 'a', done: true }, { key: 'b', done: false }] }).key, 'b', 'nextStep = first not-done');
A.eq(_internals.nextStep({ steps: [{ key: 'a', done: true }] }), null, 'all steps done → null');
A.eq(_internals.nextStep({ steps: [] }), null, 'no steps → null');
A.eq(_internals.nextStep({}), null, 'missing steps → null');

/* ---------- withQuests append + idempotence + defensiveness ---------- */
{
  const b = questBlock([{ id: 'q:9', title: 'Ship it', contract: { type: 'attest', key: '' }, steps: [] }]);
  A.eq(withQuests(SYS, b), SYS + '\n\n' + b, 'appends the block after the system');
  A.eq(withQuests('', b), b, 'an empty system yields just the block');
  A.eq(withQuests(withQuests(SYS, b), b), withQuests(SYS, b), 'never double-appends a block already present');
  A.notThrows(() => withQuests(42, 7), 'non-string inputs do not throw');
  A.notThrows(() => questBlock([null, undefined, {}]), 'junk quest entries do not throw');
}

/* ---------- cap: many quests clip to the cap, dropping the OLDEST first with a "N more" note ---------- */
{
  const many = [];
  for (let i = 1; i <= 60; i++) {
    many.push({ id: 'q:' + i, title: 'Quest number ' + i + ' with a reasonably long descriptive title to eat budget',
      contract: { type: 'attest', key: '' }, steps: [], groundedIn: 'dossier fact ' + i + ' motivating this quest' });
  }
  const b = questBlock(many);
  A.ok(b.length <= _internals.BLOCK_CAP + 200, 'block stays near the cap (header + kept stanzas + note)');
  A.ok(/…and \d+ more open quests in the QUEST LOG\./.test(b), 'a "…and N more" line replaces the dropped oldest quests');
  A.ok(b.indexOf('[q:60]') >= 0, 'the NEWEST quest (q:60) is kept');
  A.ok(b.indexOf('[q:1] ') < 0, 'the OLDEST quest (q:1) is dropped under the cap');
}

/* ---------- Fix 2 (truthful telemetry): the injection seam in index.js composes the STATION QUESTS block ONLY when
   quest.update is actually in the run's RESOLVED tool set — the block never advertises a tool the model can't see.
   Source-guarded (the mirror of settings-p1-backend.test.js's gate check) because the composition lives inline in the
   runOnce path where a full-loop harness isn't cheap to stand up. ---------- */
{
  const idx = readSidecarSource();
  // the exact gate: isTask AND quest.update present in resolved.tools before questBlock is composed.
  A.ok(/questsBlock\s*=\s*questBlock\(/.test(idx), 'index.js composes questsBlock via questBlock(...)');
  A.ok(/isTask\s*&&[\s\S]{0,120}?resolved\.tools\.indexOf\(\s*['"]quest\.update['"]\s*\)\s*>=\s*0[\s\S]{0,20}?\)\s*questsBlock\s*=\s*questBlock\(/.test(idx),
    'the questsBlock injection is GATED on quest.update being present in resolved.tools (never advertise an absent tool)');
  A.ok(/catch\s*\(_\)\s*\{\s*questsBlock\s*=\s*''\s*;\s*\}/.test(idx), 'the gate is fail-open: any error yields no block');
}

A.report('questinject.test');
