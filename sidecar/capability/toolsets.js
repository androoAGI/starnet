/* sidecar/capability/toolsets.js — the TOOLSET view of CAP_REGISTRY.

   A "toolset" is a capId family (web, cabinet, workbench, orchestrator, studio, memory, jukebox) —
   the same grouping resolveTools already keys grants by. This module DERIVES the toolset rows straight
   from CAP_REGISTRY so the tool lists can never drift from what the run path actually grants; only the
   in-world LABEL + short DESC per family live here (naming, not policy). It also computes each family's
   granting objectType (the prop that must be placed) and a consent summary (does any tool in the family
   ask first?). `compute` is the COMPUTE GATE freebie — never a toolset, never toggleable, so it is
   deliberately excluded from the toggleable set (TOOLSETS_META has no entry for it).

   Pure: same registry -> same rows. The persisted enabled-state + the live floor (placed?) are layered
   on by the caller (sidecar/index.js), never baked in here. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./registry.js'));
  else { root.SK = root.SK || {}; root.SK.capability = root.SK.capability || {}; root.SK.capability.toolsets = factory(root.SK.capability.registry); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (capReg) {
  'use strict';

  const DEFAULT = capReg.CAP_REGISTRY;

  // In-world naming per capId family. Order = display order in the UI. `compute` is intentionally absent:
  // it is the always-on freebie (the COMPUTE GATE), never a toggleable toolset.
  const TOOLSETS_META = [
    { id: 'web',          label: 'WEB & BROWSER',            glyph: '🛰', desc: 'Search the web, fetch pages, and drive a real browser — navigate, read, click, type.' },
    // COMMS rides the same DISH as WEB but is its own family on purpose: reading the internet and messaging
    // real people out of the Commander's own bot are very different amounts of trust, and this row is what
    // lets one be switched off without the other.
    { id: 'comms',        label: 'COMMS RELAY (OUTBOUND)',   glyph: '📡', desc: 'Let an agent send a message out to a connected chat — Telegram, Discord, Slack, Matrix, Signal. Only chats someone already opened with this station.' },
    { id: 'cabinet',      label: 'FILE CABINET',             glyph: '🗄', desc: 'Read, search, and write files in the agent’s workspace.' },
    { id: 'workbench',    label: 'WORKBENCH (CODE EXECUTION)', glyph: '🔧', desc: 'Run shell commands and verify code — the code-execution bench.' },
    { id: 'orchestrator', label: 'TASK DELEGATION',          glyph: '🕸', desc: 'Delegate subtasks to summoned crew, summon new agents, and schedule routines.' },
    { id: 'studio',       label: 'MEDIA STUDIO',             glyph: '🎨', desc: 'Generate images, analyse images, record voice clips, render short videos, and cut DaVinci Resolve timelines — on the keys and local services the agent already has.' },
    { id: 'memory',       label: 'MEMORY NOTEBOOK',          glyph: '📓', desc: 'The agent’s private memory and saved skills.' },   // task plans moved to the computer (taskplan freebie, 2026-08-17)
    { id: 'knowledge',    label: 'KNOWLEDGE BASE',           glyph: '📚', desc: 'Search a Commander-configured local knowledge base (RAGFlow) for relevant passages from uploaded documents.' },
    { id: 'jukebox',      label: 'JUKEBOX (SPOTIFY)',        glyph: '♫',  desc: 'Search and control your Spotify — play, pause, queue, “what’s playing”.' }
  ];

  // capId -> the objectType whose grants carry that capId (the prop that must be placed to grant it).
  // Derived from the registry so it can't drift; `compute`/`connector` (freebie / dynamic) are skipped.
  function objectForCap(registry) {
    const map = {};
    for (const objectType of Object.keys(registry)) {
      for (const g of (registry[objectType] || [])) {
        if (g.capId === 'compute') continue;
        if (map[g.capId] == null) map[g.capId] = objectType;
      }
    }
    return map;
  }

  /* toolsetRows(registry?) -> [{ id, label, glyph, desc, object, tools:[names], consentGated }]
     One row per toggleable capId family, in display order. `object` is the granting objectType.
     `tools` is the exact tool-name list the registry grants for that family (deduped, in order).
     `consentGated` is true if ANY tool in the family requires consent (the "asks first" summary). */
  function toolsetRows(registry) {
    registry = registry || DEFAULT;
    const objMap = objectForCap(registry);
    const byCap = {};   // capId -> { tools:[], consent:bool }
    for (const objectType of Object.keys(registry)) {
      for (const g of (registry[objectType] || [])) {
        if (g.capId === 'compute') continue;
        const b = byCap[g.capId] || (byCap[g.capId] = { tools: [], seen: {}, consent: false });
        if (!b.seen[g.tool]) { b.seen[g.tool] = true; b.tools.push(g.tool); }
        if (g.requiresConsent) b.consent = true;
      }
    }
    const rows = [];
    for (const meta of TOOLSETS_META) {
      const b = byCap[meta.id];
      if (!b) continue;   // family not in the registry (shouldn't happen) -> skip rather than lie
      rows.push({
        id: meta.id, label: meta.label, glyph: meta.glyph, desc: meta.desc,
        object: objMap[meta.id] || null,
        tools: b.tools.slice(),
        consentGated: !!b.consent
      });
    }
    return rows;
  }

  // The set of capIds that are legitimately toggleable (everything with a metadata row).
  function toggleableCaps(registry) { return toolsetRows(registry).map(r => r.id); }

  return { TOOLSETS_META, toolsetRows, toggleableCaps, objectForCap };
});
