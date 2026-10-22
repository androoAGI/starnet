/* AGENT OS — worksignalstore.js : the live wiring that folds REAL tool activity into the capability-usage
   histogram (pure engine in worksignal.js).

   The browser half of the workflow-signal system, modelled on profilestore.js + stationqueststore.js:
     • the SIGNAL — subscribes to `agent.tool_call` on U.bus (harness re-emits every hero tool step; the SSE tee
       re-broadcasts routed-run tool calls name-only — the SAME event that drives the G0 per-tool prop pulse and
       the G1b station-quest generator). Every real HERO tool fire maps NAME -> capability LANE and folds a
       decayed weight into that lane, plus the run's interest tag into the lane's per-tag task tally.
     • the tool->capability MAP is NOT hand-rolled: it reuses ToolProps.toolPropType (the render-side mirror of
       the sidecar CAP_REGISTRY) for the cap-prop lanes (dish/cabinet/notebook/studio/jukebox), and adds the
       KIT-ONLY lanes ToolProps intentionally omits (workbench/connector/orchestrator) — grounded in the exact
       same CAP_REGISTRY tool families (shell./verify. -> workbench, mcp__ -> connector, team./routine. ->
       orchestrator). model.chat stays unmapped (the compute gate, not a lane you "work in").

   Like profilestore.js it is a READ-ONLY consumer of U.bus (subscribes only, NEVER emits — the frozen
   shared/events.js contract is untouched), it holds only derived counts (never tool args / prompt text), and it
   is gated on the SAME learning-enabled flag the profile uses (one glass-box switch governs both). Date.now()
   lives here (the injection edge); the engine stays clock-pure. Persists through the save envelope (like the
   profile slice) so the histogram round-trips a resume. */
'use strict';
const WorkSignalStore = (() => {
  let signal = null;
  let persistFn = () => {};
  let learningOn = () => true;   // shared with the profile's glass-box flag (injected by app.js)
  let getRunTag = () => null;    // resolve a run's interest tag (from RUN_META / active workstream) — injected
  let wired = false;
  const pending = new Map();     // runId -> { lanes:Set, tag }; raw tool frequency never enters the model

  const now = () => Date.now();
  const ready = () => typeof WorkSignal !== 'undefined' && signal;

  // NAME -> capability lane. Reuse the CAP_REGISTRY-mirroring ToolProps mapper for the cap-prop lanes, then the
  // kit-only lane extension (same CAP_REGISTRY families). Returns a WorkSignal.LANES member or null.
  function laneForTool(name) {
    if (!name || typeof name !== 'string') return null;
    // cap-prop lanes: fs.* -> cabinet, web_*/browser.*/desktop.open -> dish, notebook.*/skill.*/todo/recall -> notebook,
    // image_* -> studio, spotify_* -> jukebox (ToolProps is the single source, so this can't drift from the world pulse).
    const prop = (typeof ToolProps !== 'undefined' && ToolProps.toolPropType) ? ToolProps.toolPropType(name) : null;
    if (prop) return prop;   // prop type IS the capability objectType for these lanes
    // kit-only lanes ToolProps returns null for (they own a different floor visual, but they ARE real work lanes a
    // class kit draws on) — mapped here off the same CAP_REGISTRY tool families:
    if (name.indexOf('mcp__') === 0) return 'connector';                                             // an MCP connector's live tools
    if (name.indexOf('shell.') === 0 || name.indexOf('verify.') === 0 || name === 'computer.use') return 'workbench';   // real code execution
    if (name.indexOf('team.') === 0 || name.indexOf('routine.') === 0) return 'orchestrator';       // delegation / scheduling
    return null;   // model.chat + unknowns: not a work lane
  }

  // fold one real tool fire into its capability lane (+ the run's interest tag into that lane's tally).
  // ALL agents count (scout moderate-loosening, 2026-07-08): delegated/specialist tool work is still the
  // Commander's workflow — the old hero-only gate starved the histogram whenever work was routed, which was
  // a big reason the adaptive shelves never warmed up. The work the STATION does is the signal, whoever did it.
  function onToolCall(p) {
    if (!ready() || !learningOn()) return;
    if (!p) return;
    const lane = laneForTool(p.name);
    if (!lane) return;
    const runId = String(p.runId || '').trim();
    if (!runId) return;
    let row = pending.get(runId);
    if (!row) {
      let tag = null; try { tag = getRunTag(runId) || null; } catch (_) {}
      row = { lanes: new Set(), tag }; pending.set(runId, row);
    }
    row.lanes.add(lane);
  }

  function onRunEnd(p) {
    if (!ready() || !p) return;
    const runId = String(p.runId || '').trim();
    if (!runId) return;
    const row = pending.get(runId); pending.delete(runId);
    if (!row || p.reason !== 'done' || !learningOn()) return;
    WorkSignal.observeRun(signal, { lanes: Array.from(row.lanes), tag: row.tag }, now());
    try { persistFn(); } catch (_) {}
  }

  // opts: { signal, persist, learningOn(), getRunTag(runId) }
  function init(opts) {
    opts = opts || {};
    if (opts.persist) persistFn = opts.persist;
    if (typeof opts.learningOn === 'function') learningOn = opts.learningOn;
    if (typeof opts.getRunTag === 'function') getRunTag = opts.getRunTag;
    signal = (typeof WorkSignal !== 'undefined') ? WorkSignal.hydrate(opts.signal) : (opts.signal || null);
    if (!wired && typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.tool_call', p => { try { onToolCall(p); } catch (e) { console.warn('[worksignal]', e); } });
      U.bus.on('agent.run.end', p => { try { onRunEnd(p); } catch (e) { console.warn('[worksignal]', e); } });
      wired = true;
    }
  }

  // ---- read surface (the recruiter consumes these) ----
  function summary() { return ready() ? WorkSignal.summary(signal, now()) : null; }
  function model() { return signal || null; }                 // the raw histogram the pure matcher reads (with an injected clock)
  function serialize() { return signal || undefined; }        // folded into the save envelope by App.persist()

  // shares the profile's FORGET (one glass-box control wipes both learned models).
  function forget() { pending.clear(); if (typeof WorkSignal !== 'undefined') { signal = WorkSignal.forget(); try { persistFn(); } catch (_) {} } }

  return { init, summary, model, serialize, forget, _laneForTool: laneForTool, _onToolCall: onToolCall, _onRunEnd: onRunEnd, _pending: pending };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { WorkSignalStore };
