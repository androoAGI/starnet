/* STARNET — toolprops.js : PURE tool-name -> capability-prop mapper (G0.1).

   The single source for "which placed prop does a firing tool light up?" — the render-side
   mirror of the sidecar's CAP_REGISTRY (sidecar/capability/registry.js), keyed the same way
   worldmodel's CAP_PROP_MAP keys prop types to capability objectTypes:

     fs.*                                        -> 'cabinet'   (files)
     web_search / web_fetch / public browser.*   -> 'dish'      (web)
     channel.*                                   -> 'dish'      (outbound comms — the dish transmits too)
     notebook.* / skill.* / recall_conversation  -> 'notebook'  (memory; todo moved to `computer` 2026-08-17)
     knowledge_search                            -> 'notebook'  (RAGFlow retrieval, 2026-10 — rides the notebook object, see registry.js)
     image_*                                     -> 'studio'    (media)
     resolve_*                                   -> 'studio'    (DaVinci Resolve)
     video_*                                     -> 'studio'    (MoneyPrinterTurbo render, 2026-10 — video_generate/status/result)
     spotify_*                                   -> 'jukebox'   (spotify)

   Everything else maps to null ON PURPOSE — those tools already have their own dedicated
   floor visual, so mapping them here would double-fire:
     mcp__<id>__*      -> the connector PORTAL pulse (world.js polls + pulseConnector)
     shell.* / verify.* / browser.test_* -> the WORKBENCH pulse (shell.exec / verify.result events)
     team.* / routine.*                -> the lead->worker handoff boxes (orchestration visuals)
     model.chat                        -> the compute gate, not a callable prop tool

   Pure + headless-safe: no DOM, no clock, no state — a name goes in, a prop type (or null)
   comes out. Loads under require() for the unit tests exactly like worldmodel.js. */
'use strict';

const ToolProps = (() => {
  // exact-name grants that don't share a family prefix (from CAP_REGISTRY's notebook rows)
  const EXACT = {
    web_search: 'dish',
    web_fetch: 'dish',
    web_request: 'dish',   // calling a third-party API is a WEB reach — the dish is the prop that projects it
    // connectors.list reads which integrations the station HAS and which it could add. It rides the same dish
    // grant as web_request, so it lights the same antenna: the agent is looking outward, at reach, even though
    // this particular read never leaves the machine.
    'connectors.list': 'dish',
    voice_generate: 'studio',   // the studio makes audio as well as images — same prop, same pulse
    recall_conversation: 'notebook',
    // RAGFlow retrieval (2026-10, tools/builtin/knowledge.js): a lookup against a Commander-curated external
    // document store, same "what can this agent recall/know" family as recall_conversation — no shared prefix
    // with anything else, so it's EXACT rather than earning its own PREFIX row.
    knowledge_search: 'notebook',
    'widget.get': 'notebook',
    'widget.set': 'notebook'   // Widget definitions/readings share the notebook-object (memory) grant.
    // QUEST V2 §B: quest.update is DELIBERATELY absent here → null. It moved from the notebook object to the `computer`
    // object (the 'quest' freebie capId), and the compute gate has no cap-prop pulse (model.chat is null for the same
    // reason). So updating a quest lights no placed-cap prop — correct: it rides compute, not a placeable object.
    // TASK PLAN (2026-08-17): `todo` is absent for the same reason — it moved to the `computer` object (the
    // 'taskplan' freebie capId) so a station without a placed notebook still has a task list. Same rule as quest.
  };
  // family prefix -> prop type (checked after EXACT; first match wins)
  const PREFIX = [
    ['fs.', 'cabinet'],
    ['browser.', 'dish'],
    // channel.targets / channel.send — the 'comms' capId rides the placed DISH, so an agent messaging a chat
    // pulses the same antenna a web fetch does. It genuinely IS the dish transmitting; leaving it null would
    // make the one outward-facing message in the tool surface invisible on the floor.
    ['channel.', 'dish'],
    ['notebook.', 'notebook'],
    ['skill.', 'notebook'],
    ['image_', 'studio'],
    ['resolve_', 'studio'],   // DaVinci Resolve edit bay — cutting timelines is studio work (tools/builtin/resolve.js)
    ['video_', 'studio'],     // MoneyPrinterTurbo render (2026-10): video_generate/video_status/video_result (tools/builtin/video.js)
    ['spotify_', 'jukebox']
  ];

  /* the mapper: real tool name -> capability prop type ('cabinet'|'dish'|'notebook'|'studio'|'jukebox') or null */
  function toolPropType(name) {
    if (!name || typeof name !== 'string') return null;
    if (name.indexOf('mcp__') === 0) return null;          // connector portals own their own pulse
    if (name.indexOf('browser.test_') === 0) return null;  // local synthetic testing rides workbench, not dish
    if (EXACT[name]) return EXACT[name];
    for (const [pre, t] of PREFIX) if (name.indexOf(pre) === 0) return t;
    return null;                                           // shell/verify/team/routine/model + unknowns: no cap-prop pulse
  }

  return { toolPropType };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ToolProps;
