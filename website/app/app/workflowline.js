/* frontend/app/workflowline.js — the WORKFLOW PANEL's pure readings of one conveyor line (2026-09-22).

   The docked Workflow panel in REFIT (build.js mounts it, workflowpanel.js draws it) says four things
   about a line: the ORDER its docks run in, a plain-English "how it runs" sentence, a readiness pill
   naming what is missing, and a cost estimate. Every one of those is a claim about what the harness
   will do, so every one is computed HERE, from the SAME compiled plan the sidecar routes by
   (Pipeline.compileRoutingPlan -> plan.reach / plan.chains / Pipeline.chainStep), and nothing else.

   PURE, zero-dep, UMD (the pipeline.js idiom): params in, plain data out, no DOM, no clock, no module
   state — so test/workflow-line.test.js can hold every sentence to the truthful-telemetry law.

   ORDER AND HAND-OFFS ARE COMPILED, NEVER INFERRED (2026-09-23 playtest). A crewed dock's position and every
   hand-off it claims come from the real plan's dock maps (reachDock / dockChains / chainStepDock). An UNCREWED
   bay is not a dock of the real plan, so the floor is compiled once more with probe agents on the uncrewed bays
   (probePlan) to place it — it still says "not routed until it has an agent" and hands off to nothing. A dock no
   INBOX reaches even then is listed as NOT CONNECTED (one 'apart' group), never chained in bay order, and
   neighbours() reads prev/next off compiled edges only — two parallel bays are siblings, never a sequence. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.WorkflowLine = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- role copy: the verb a dock "does" in the sentence + its starter chips ----------
     Keys are WorldModel.BAY_ROLES (the dock's stamped role). A starter fills DOES (the standing brief)
     and HANDS OFF (the phrase composed into the brief the agent receives — Pipeline.composeStageBrief).
     A REVIEWER's starters end with the VERDICT line the loop gate parses (routing/verdict.js). */
  const ROLE = {
    RESEARCHER: { verb: 'researches it', starters: [
      ['Find sources', 'Find three credible, recent sources on the task. Only include claims you can back with a link.', 'bullet notes with links'],
      ['Compare options', 'Compare the main options for the task in a short table: cost, pros, cons.', 'a comparison table'],
      ['Pull key numbers', 'Pull the 5 most important numbers on the topic, each with its source.', '5 numbers with sources']] },
    WRITER: { verb: 'writes it up', starters: [
      ['Newsletter blurb', 'Turn the notes into a 200-word newsletter blurb. Warm, plain English, no jargon. Keep every link.', 'a 200-word draft'],
      ['Bullet summary', 'Summarize the notes as 5 punchy bullets a busy reader can skim in 20 seconds.', '5 bullets'],
      ['Email draft', 'Write a short email sharing the findings with my team. Friendly, under 150 words.', 'an email draft']] },
    REVIEWER: { verb: 'reviews it', starters: [
      ['Fact-check + verdict', 'Check every claim in the draft against the notes. End with VERDICT: approved, or VERDICT: revise and exactly what to fix.', 'the approved draft'],
      ['Tone & clarity', 'Check the draft reads clearly for a non-expert. End with VERDICT: approved, or VERDICT: revise with the fixes.', 'the approved draft']] },
    ENGINEER: { verb: 'builds it', starters: [
      ['Build to the criteria', 'Build what the incoming request asks for. Restate the acceptance criteria, make the smallest complete change that meets them, and note how you checked it. If the tester sent it back, fix exactly what failed.', 'the change, your checks and the original request'],
      ['Implement it', 'Make the change the task asks for. Keep it small, run the tests, and list the files you touched.', 'a summary of the change and files touched'],
      ['Review code', 'Read the change for bugs and risky edge cases. List each problem with its file and line.', 'a list of issues']] },
    // TESTER (BUILD & TEST, from PR #47 by @mvanhorn): checks the change and calls the verdict the LOOP gate reads
    TESTER: { verb: 'tests it', starters: [
      ['Test + verdict', 'Test the incoming change against the original request. Check each acceptance criterion and edge case, and say which checks you actually ran. If everything passes, deliver the final change with a short test note and end with VERDICT: pass. If anything fails, say exactly what failed and end with VERDICT: revise.', 'the verified change'],
      ['Quick check', 'Run the quickest checks that prove the change works. End with VERDICT: pass, or VERDICT: revise and what failed.', 'a pass, or what failed']] },
    GENERALIST: { verb: 'handles it', starters: [
      ['Do the task', 'Do what the task asks, then summarize what you did in plain words.', 'the finished result'],
      ['Plan it', 'Break the task into 3 to 5 concrete steps and say what each one needs.', 'a short plan']] },
    CREW: { verb: 'works its share', starters: [
      ['Work your share', 'Handle your share of the incoming work and report the result plainly.', 'your part of the result']] },
    SHIPPER: { verb: 'finishes and ships it', starters: [
      ['Polish & ship', 'Turn the input into the final deliverable: clean formatting, a clear title, nothing missing.', 'the final deliverable']] },
    ANALYST: { verb: 'analyzes it', starters: [
      ['Combine branches', 'Combine the parts you receive into one answer. Note anywhere they disagree.', 'one combined answer']] },
    PLANNER: { verb: 'divides it into parts', starters: [
      ['Split into parts', 'Divide the task into independent parts, one per agent after you. Each part must be a complete task on its own; together they cover the whole job with no overlap.', 'a numbered list of parts']] },
    FIXER: { verb: 'fixes what the loop could not', starters: [
      ['Take over', 'The review loop gave up on this. Read the history, fix what is still wrong, and say what you changed.', 'the fixed result']] },
  };
  const GENERIC = { verb: 'works on it', starters: [
    ['Do the task', 'Do what the task asks, then summarize what you did in plain words.', 'the finished result'],
    ['Summarize', 'Summarize what you receive in 5 short bullets.', '5 bullets']] };
  const roleInfo = role => ROLE[role] || GENERIC;
  const starters = role => roleInfo(role).starters.map(s => ({ label: s[0], does: s[1], hands: s[2] }));
  /* A NEW LINE'S STEPS COME WITH INSTRUCTIONS (2026-09-30, found walking a fresh station): a line from the shelf used to land with
     every BAY blank — "BAY 1 (RESEARCHER) has no instructions" — and a WRITER with no brief, handed research, wrote an essay about
     "the upstream report" instead of the answer. Each role stamps with a NEUTRAL default (what that step is for, no guesses about the
     job); the roles whose first starter is job-specific ("a 200-word newsletter blurb") get one written for any job. The Commander
     edits it on the BAY card like any brief. */
  const DEFAULT_BRIEF = {
    RESEARCHER: ['Find credible, recent sources on the job and pull out the key facts. Only include claims you can back with a link.', 'notes with links'],
    WRITER: ['Write up what you receive as a clear, well-organized answer to the original request. Plain English, no filler, and keep any links.', 'the written answer'],
    REVIEWER: ['Check the draft against the original request: is it correct, complete and clear? If anything is off, say exactly what to fix.', 'the approved draft'],
  };
  function defaultBrief(role) {
    const d = DEFAULT_BRIEF[role];
    if (d) return { does: d[0], hands: d[1] };
    const s = ROLE[role] ? starters(role)[0] : null;
    return s ? { does: s.does, hands: s.hands } : null;
  }

  const key = (x, y) => x + ',' + y;

  /* ---------- lineFlow(plan, comp, P, props) -> the line's run order ----------
     plan  = the compiled RoutingPlan (LOCAL frame), comp = one Pipeline.lineComponents entry (same frame),
     P     = Pipeline (chainStep + _internals), props = the geometry's props (same frame; junction prop ids).
     Returns {
       cols:  [ { docks:[dock…], mode:'single'|'all'|'turns'|'oneof', gate?:gateNode } ]  in run order
              ('all' = a fan-out: every dock runs · 'turns' = a plain splitter · 'oneof' = a FILTER by content)
       docks: { propId -> dock }   dock = { propId, agentId, role, bound, routed, col, deadEnd, reachedBy }
       gates: [ { kind:'loop'|'join', key, propId, after:[propId…], backTo:propId|null, backAgent, max, when,
                  next:propId|null, timeoutMin } ]
       order: [propId…] every dock in strip order (the contract's previous/next)
       outbox: { propId|null, reached:bool }, trigger: { propId|null } }
     Order law: a BOUND dock's column is the compiled chain's (chainStep from the entry docks, loop back
     edges excluded). An UNCREWED dock sits where the physical belt walk meets it, flagged routed:false.
     KEYED BY DOCK (multi-bay agents, 2026-09-22): one agent may crew several bays, so the walk reads the plan's
     DOCK layer (reachDock / dockChains / Pipeline.chainStepDock) — writer@A → editor@B → writer@C is three
     columns with the writer in two of them. A plan without the dock layer derives it (Pipeline.dockLayer). */
  function lineFlow(plan, comp, P, props) {
    const out = { cols: [], docks: {}, gates: [], order: [], edges: {}, probeIn: {}, probeNext: {}, outbox: { propId: null, reached: false, reachedOnceCrewed: false }, trigger: { propId: null }, tooLong: null };
    // UNDER A BELT CYCLE the compiler never computes reach (every dock reads unreached), so no connectivity claim can
    // be made from it: readers say the one true thing — the loop stops all routing (station.layout audit 2026-09-28)
    out.cyclic = !!(plan && (plan.errors || []).some(e => e && e.code === 'CYCLE'));
    if (!comp) return out;
    out.trigger.propId = (comp.intakes && comp.intakes[0]) || null;
    out.outbox.propId = (comp.outboxes && comp.outboxes[0]) || null;
    const bays = comp.bays || [];
    for (const b of bays) {
      out.docks[b.propId] = { propId: b.propId, agentId: b.agentId || null, role: b.role || null,
        bound: !!b.agentId, routed: false, col: null, deadEnd: false, reachedBy: null, detached: false };
    }
    const mine = pid => !!out.docks[pid];
    const layerOf = pl => (P && P.dockLayer && pl) ? P.dockLayer(pl) : { dockChains: {}, reachDock: {} };
    const real = layerOf(plan);

    // 1. THE REAL PLAN decides what is ROUTED today, whether the line reaches the OUTBOX, and every hand-off a
    //    CREWED dock makes (edges). Nothing here comes from belt order or bay order.
    const R = walkCompiled(plan, comp, P, props, bays.filter(b => b.agentId && real.reachDock[b.propId]).map(b => b.propId));
    for (const pid in R.col) if (out.docks[pid] && out.docks[pid].bound) out.docks[pid].routed = true;
    if (R.outboxReached) out.outbox.reached = true;
    for (const b of bays) {
      if (!b.agentId) continue;
      const ch = real.dockChains[b.propId];
      out.edges[b.propId] = ch ? (ch.next || []).filter(mine) : [];
      if (ch && !ch.outbox && ch.deadEnd && !(ch.next || []).length && !ch.gated) out.docks[b.propId].deadEnd = true;
    }
    // no INBOX-fed run at all: the OUTBOX claim is still the compiled one — a crewed dock whose own chain ships out
    if (!R.outboxReached && !Object.keys(R.col).length) for (const b of bays) { const ch = b.agentId && real.dockChains[b.propId]; if (ch && ch.outbox) out.outbox.reached = true; }

    // 2. THE LAYOUT (where each dock sits in the strip) comes from the compiler too. An UNCREWED bay is not a
    //    dock of the real plan, so the floor is compiled once more with a probe agent on every uncrewed bay of
    //    this line: the columns are then the compiler's own answer for "once every bay is crewed". An uncrewed
    //    dock stays routed:false and hands off to nothing (its contract says "decided once it has an agent");
    //    a crewed dock's hand-offs are still read ONLY off the real plan (step 1).
    const probe = probePlan(plan, comp, P, props);
    const pl = probe ? layerOf(probe) : real;
    const L = walkCompiled(probe || plan, comp, P, props, bays.filter(b => (probe || b.agentId) && pl.reachDock[b.propId]).map(b => b.propId));
    for (const pid in L.col) if (out.docks[pid]) { out.docks[pid].col = L.col[pid]; out.docks[pid].reachedBy = L.reachedBy[pid] || null; }
    out.gates = L.gates;
    /* TOO LONG (2026-10-09 P0): the compiler's own LINE_TOO_LONG for this line — the stages one job runs against the LINE
       BUDGET in force — read off the stand-in-crew compile while a bay is uncrewed, so a line hears it is too long while it is
       being built, not when its first paid job stops part-way. */
    const tl = (((probe || plan) && (probe || plan).errors) || []).find(e => e && e.code === 'LINE_TOO_LONG' && e.lineId === comp.key) || null;
    out.tooLong = tl ? { propId: tl.propId || null, stages: tl.stages | 0, maxHops: tl.maxHops | 0 } : null;
    // a dock reached only on a LOOP's escalation lane is flagged: it runs only when the loop gives up (see walkCompiled)
    for (const pid in L.reachedBy) if (L.reachedBy[pid] === 'esc' && out.docks[pid]) out.docks[pid].escalation = true;
    // an uncrewed dock's upstream (its GETS) is the probe compile's — the only compiled answer for a dock with no agent
    if (probe) for (const b of bays) {
      if (b.agentId) continue;
      for (const x of bays) { const ch = pl.dockChains[x.propId]; if (x.propId !== b.propId && ch && (ch.next || []).indexOf(b.propId) >= 0) (out.probeIn[b.propId] = out.probeIn[b.propId] || []).push(x.propId); }
    }
    /* CONNECTED, JUST NOT CREWED (sweep 2026-09-25). The real plan routes nothing through an uncrewed bay, so a line
       whose belts DO run INBOX → bays → OUTBOX read "the last step is not connected to the OUTBOX" and a crewed bay
       before an uncrewed one read "nowhere — connect a belt" — telling a newcomer to lay belts that are already there.
       The probe compile (every uncrewed bay given a stand-in agent) is the compiler's answer for "once every bay is
       crewed": reachedOnceCrewed + probeNext carry it, so the copy can say what is really missing (an agent). The
       REAL claims (reached, edges, routed) are unchanged — nothing here says work flows today. */
    out.outbox.reachedOnceCrewed = !!(out.outbox.reached || (probe && L.outboxReached));
    if (probe) for (const b of bays) {
      if (!b.agentId || (out.edges[b.propId] || []).length) continue;
      const ch = pl.dockChains[b.propId];
      const nx = ch ? (ch.next || []).filter(pid => mine(pid) && !out.docks[pid].agentId) : [];
      if (nx.length) out.probeNext[b.propId] = nx;
    }

    // UNDER A BELT CYCLE nothing was reached, so nothing is "not connected" on the evidence: the docks sit where the
    // belts meet them (the physical walk terminates on a loop), still routed:false — nothing routes while it stands.
    if (out.cyclic) { let k = 0; for (const pid of physicalOrder(plan, comp, (P && P._internals) || {})) { const d = out.docks[pid]; if (d && d.col == null) d.col = k++; } }

    // 3. NOT CONNECTED: a dock no INBOX reaches even once crewed has no place in the run order. It is never
    //    chained in bay order: every such dock is listed together in ONE trailing 'apart' group.
    const placed = Object.values(out.docks).filter(d => d.col != null);
    const loose = bays.map(b => out.docks[b.propId]).filter(d => d.col == null);
    const colKeys = [...new Set(placed.map(d => d.col))].sort((a, b) => a - b);
    const bayOrder = {}; bays.forEach((b, i) => { bayOrder[b.propId] = i; });
    for (const ck of colKeys) {
      const inCol = placed.filter(d => d.col === ck).sort((a, b) => bayOrder[a.propId] - bayOrder[b.propId]);
      // an ESCALATION dock never shares a column with the done lane's next step (that read "A or FIX", one-by-content):
      // it gets its own column right after, carrying the gate it escalates from and whether that lane can ever fire
      for (const esc of [false, true]) {
        const docks = inCol.filter(d => !!d.escalation === esc);
        if (!docks.length) continue;
        const mode = docks.length < 2 ? 'single' : docks.some(d => d.reachedBy === 'all') ? 'all' : docks.some(d => d.reachedBy === 'turns') ? 'turns' : 'oneof';
        const c = { docks, mode, gate: null };
        if (esc) {
          const g = out.gates.find(gg => gg.kind === 'loop' && gg.escTo && docks.some(d => d.propId === gg.escTo));
          c.escalation = g ? { gate: g.key, propId: g.propId || null, when: g.when || null, max: g.max || null, live: !!g.when } : { gate: null, propId: null, when: null, max: null, live: false };
          // a loop with no pass condition never exhausts (loopDecision: exhausted needs `when`): its escalation dock is never routed
          if (!c.escalation.live) for (const d of docks) d.routed = false;
        } else {
          const g = out.gates.find(gg => gg.col === ck && gg.after.some(pid => docks.some(d => d.propId === pid)));
          if (g) c.gate = g;
        }
        out.cols.push(c);
        for (const d of docks) out.order.push(d.propId);
      }
    }
    if (loose.length) {
      const top = colKeys.length ? Math.floor(colKeys[colKeys.length - 1]) + 1 : 0;
      for (const d of loose) { d.col = top; d.detached = true; d.routed = false; }
      out.cols.push({ docks: loose, mode: loose.length > 1 ? 'apart' : 'single', gate: null, detached: true });
      for (const d of loose) out.order.push(d.propId);
    }
    return out;
  }

  /* the compiled walk: columns by longest forward path from `entries` along Pipeline.chainStepDock (loop back
     edges excluded), plus the loop/join gates it meets. Pure over one plan. */
  function walkCompiled(plan, comp, P, props, entries) {
    const res = { col: {}, reachedBy: {}, gates: [], outboxReached: false };
    if (!plan || !comp) return res;
    const lineId = comp.key;
    const L = (P && P.dockLayer) ? P.dockLayer(plan) : { dockChains: {}, reachDock: {} };
    const chains = L.dockChains || {};
    const isDock = {}; for (const b of (comp.bays || [])) isDock[b.propId] = true;
    const pidOf = n => (n && typeof n === 'object') ? (n.dockId || null) : (n && isDock[n] ? n : null);
    const step = pid => { try { return (P && P.chainStepDock) ? P.chainStepDock(plan, pid, { lineId }) : null; } catch (e) { return null; } };
    const I = (P && P._internals) || {};
    // the junction prop at a plan junction key (the compiler's attach rule: own tile if on a belt, else the ring)
    const jprop = (jk) => {
      const map = plan.belts || {};
      for (const p of (props || [])) {
        if (!(p.t === 'loop' || p.t === 'joiner') || (comp.props || []).indexOf(p.id) < 0) continue;
        const t = map[key(p.x, p.y)] ? { x: p.x, y: p.y } : (I.beltTileNear ? I.beltTileNear(map, p.x, p.y, p.w || 1, p.h || 1) : null);
        if (t && key(t.x, t.y) === jk) return p.id;
      }
      return null;
    };
    const col = res.col, gateByKey = {};
    const srcStarts = [];
    for (const s of (plan.sources || [])) if ((comp.intakes || []).indexOf(s.propId) >= 0) for (const t of ((s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []))) srcStarts.push(t);
    const entryBy = entries.length > 1 ? (forkKind(plan, srcStarts, I) || 'oneof') : 'entry';
    const q = entries.map(a => ({ a, c: 0, by: entryBy }));
    let guard = 0;
    while (q.length && guard++ < 4096) {
      const { a, c, by } = q.shift();
      const pid = pidOf(a); if (!pid) continue;
      if (col[pid] != null && col[pid] >= c) continue;
      col[pid] = c;
      if (!res.reachedBy[pid] || by === 'all' || by === 'turns') res.reachedBy[pid] = by;
      const s = step(pid), ch = chains[pid];
      const statics = (ch && ch.next) || [];
      if (!s) {
        if (ch && ch.outbox) res.outboxReached = true;
        for (const n of statics) q.push({ a: n, c: c + 1, by: 'oneof' });   // a static fork chainStep's default tag didn't take
        continue;
      }
      if (s.dockId) {
        const fk = statics.length > 1 ? (forkKind(plan, ch && ch.tile ? [ch.tile] : [], I) || 'oneof') : 'single';
        q.push({ a: s.dockId, c: c + 1, by: fk });
        for (const n of statics) if (n !== s.dockId) q.push({ a: n, c: c + 1, by: fk });
      } else if (s.branches) {
        for (const n of s.branches) q.push({ a: n, c: c + 1, by: 'all' });
      } else if (s.loop || s.join) {
        const k = s.loop || s.join;
        let g = gateByKey[k];
        if (!g) {
          g = gateByKey[k] = { kind: s.loop ? 'loop' : 'join', key: k, propId: jprop(k), after: [], backTo: null, backAgent: null, escTo: null,
            max: s.max || null, when: s.when || null, next: null, nextAgent: (s.next && s.next.agentId) || null, nextDock: pidOf(s.next), timeoutMin: s.timeoutMin || null, col: c };
          res.gates.push(g);
        }
        if (g.after.indexOf(pid) < 0) g.after.push(pid);
        if (c > g.col) g.col = c;
        if (s.loop) { g.backAgent = (s.backTo && s.backTo.agentId) || null; g.backTo = pidOf(s.backTo); g.escTo = pidOf(s.esc) || null; }
        const nd = pidOf(s.next), bd = pidOf(s.backTo), ed = s.loop ? pidOf(s.esc) : null;
        if (nd) q.push({ a: nd, c: c + 1, by: 'single' });
        else if (ch && ch.outbox) res.outboxReached = true;
        /* the ESCALATION lane is not a next step (station.layout audit 2026-09-28): its dock runs ONLY when the loop
           spends its passes with its condition still unmet (sidecar/routing/chain.js loopDecision) — so it is walked
           as 'esc', never as a forward 'oneof' fork the sentence would chain with "then". */
        if (ed) q.push({ a: ed, c: c + 1, by: 'esc' });
        // a loop's back lane re-enters UPSTREAM: never a forward edge (it is drawn as the back-arc)
        for (const n of statics) if (n !== nd && n !== bd && n !== ed) q.push({ a: n, c: c + 1, by: 'oneof' });
      }
      if (ch && ch.outbox && !s.dockId && !s.branches) res.outboxReached = true;
    }
    for (const g of res.gates) g.next = g.nextDock || null;
    return res;
  }

  /* the floor compiled once more with a probe agent on every UNCREWED bay of this line (null when the line has
     none — the real plan already answers everything). Memoized per compiled plan object. */
  const probeMemo = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function probePlan(plan, comp, P, props) {
    if (!plan || !P || !P.compileRoutingPlan || !props || !props.length) return null;
    const unbound = (comp.bays || []).filter(b => !b.agentId).map(b => b.propId);
    if (!unbound.length) return null;
    const sig = comp.key + '|' + unbound.join(',');
    const m = probeMemo && probeMemo.get(plan);
    if (m && m.sig === sig && m.props === props) return m.probe;
    const set = {}; for (const id of unbound) set[id] = true;
    const belts = [];
    for (const k in (plan.belts || {})) { const p = k.split(','); belts.push({ x: +p[0], y: +p[1], dir: plan.belts[k] }); }
    let probe = null;
    // a LINKED floor re-compiles with its links (a line the layout engine laid can have belts no ring rule would join)
    try { probe = P.compileRoutingPlan({ props: props.map(p => set[p.id] ? Object.assign({}, p, { agentId: '__probe_' + p.id }) : p), belts, links: plan.links || undefined }); } catch (e) { probe = null; }
    if (probeMemo) probeMemo.set(plan, { sig, props, probe });
    return probe;
  }

  /* what kind of FORK sits on a lane: walk forward from `starts` to the first junction that has more than
     one way out. 'all' = a fan-out splitter (every branch runs — it feeds a JOINER), 'turns' = a plain
     splitter (round-robin), 'oneof' = a FILTER (by content). null = no fork before the docks. */
  function forkKind(plan, starts, I) {
    if (!plan || !plan.belts) return null;
    const map = plan.belts, junctions = plan.junctions || {}, bayAt = plan.bayTileToDock || plan.bayTileToAgent || {};
    const q = (starts || []).slice(), seen = {};
    let guard = 0;
    while (q.length && guard++ < 4096) {
      const t = q.shift(), k = key(t.x, t.y);
      if (seen[k]) continue; seen[k] = true;
      const j = junctions[k];
      if (j && j.kind === 'split') return j.fanout ? 'all' : 'turns';
      if (j && j.kind === 'filter') return 'oneof';
      if (bayAt[k] && guard > 1) continue;
      const nts = I.nextTiles ? I.nextTiles(map, junctions, t) : [];
      if (nts.length) q.push(nts[0]);
    }
    return null;
  }

  // the physical walk (see lineFlow step 2): dock propIds in the order the belts meet them
  function physicalOrder(plan, comp, I) {
    const res = [];
    if (!plan || !plan.belts || !comp) return res;
    const map = plan.belts, junctions = plan.junctions || {};
    const ring = {};   // belt key -> dock propId (every belt tile in a dock's 1-tile ring)
    const ringOf = {};
    for (const b of (comp.bays || [])) {
      ringOf[b.propId] = [];
      for (let y = b.y - 1; y <= b.y + (b.h || 1); y++)
        for (let x = b.x - 1; x <= b.x + (b.w || 1); x++)
          if (map[key(x, y)] && !ring[key(x, y)]) { ring[key(x, y)] = b.propId; ringOf[b.propId].push({ x, y }); }
    }
    const intakeIds = {}; for (const id of (comp.intakes || [])) intakeIds[id] = true;
    const q = [], seen = {}, met = {};
    for (const s of (plan.sources || [])) {
      if (!intakeIds[s.propId]) continue;
      const ts = (s.tiles && s.tiles.length) ? s.tiles : (s.tile ? [s.tile] : []);
      for (const t of ts) if (!seen[key(t.x, t.y)]) { seen[key(t.x, t.y)] = true; q.push(t); }
    }
    let guard = 0;
    while (q.length && guard++ < 20000) {
      const t = q.shift(), k = key(t.x, t.y), pid = ring[k];
      if (pid && !met[pid]) {
        met[pid] = true; res.push(pid);
        for (const rt of ringOf[pid]) { const rk = key(rt.x, rt.y); if (!seen[rk]) { seen[rk] = true; q.push(rt); } }
      }
      const nts = I.nextTiles ? I.nextTiles(map, junctions, t) : [];
      for (const nt of nts) { const nk = key(nt.x, nt.y); if (!seen[nk]) { seen[nk] = true; q.push(nt); } }
    }
    return res;
  }

  /* ---------- the neighbours a dock's contract names (GETS / TO) ---------- */
  function neighbours(flow, propId) {
    const d = flow && flow.docks[propId];
    if (!d) return { prev: [], next: [], gate: null, first: false, last: false };
    const i = flow.cols.findIndex(c => c.docks.some(x => x.propId === propId));
    const colHere = flow.cols[i];
    const gate = colHere && colHere.gate && colHere.gate.after.indexOf(propId) >= 0 ? colHere.gate : null;
    // loop re-entry: the gate that sends work BACK to this dock
    const backFrom = flow.gates.filter(g => g.kind === 'loop' && g.backTo === propId);
    /* HAND-OFFS ARE COMPILED EDGES, NEVER COLUMN ADJACENCY (2026-09-23): two parallel bays under a splitter, or
       docks no INBOX reaches, used to read as a chain because they sat in neighbouring columns. next = the real
       plan's dockChains for a crewed dock (an uncrewed dock hands off to nothing yet); prev = the crewed docks
       whose compiled next is this one (+ the probe compile's answer for an uncrewed dock). */
    const E = flow.edges || {}, order = flow.order || [];
    const next = (E[propId] || []).slice();
    const prev = Object.keys(E).filter(x => x !== propId && (E[x] || []).indexOf(propId) >= 0);
    for (const x of ((flow.probeIn || {})[propId] || [])) if (prev.indexOf(x) < 0) prev.push(x);
    const byOrder = (a, b) => order.indexOf(a) - order.indexOf(b);
    prev.sort(byOrder); next.sort(byOrder);
    const lastRun = flow.cols.reduce((n, c, k) => (c.detached ? n : k), -1);
    return { prev, next, gate, backFrom, first: i === 0 && !d.detached, last: !d.detached && i === lastRun, index: i, detached: !!d.detached };
  }

  /* ---------- "how it runs": the sentence, as segments the panel paints ----------
     seg = { t:'text', s } | { t:'agent', s, propId } | { t:'miss', s, propId } | { t:'loop', s } | { t:'end', s }
     triggers = { schedules:[sentence…], channels:[label…], events:[sentence…] } — ONLY triggers that run the WHOLE
     line (a runsLine routine at an entry dock, a channel answering as an entry dock, an armed LINE TRIGGER —
     'when a file lands in C:\Drops' / 'when its webhook is called', see lineEventTriggers). */
  function howItRuns(flow, opt) {
    const o = opt || {}, nameOf = o.nameOf || (a => String(a || '').toUpperCase()), segs = [];
    const T = s => segs.push({ t: 'text', s });
    const dockName = d => d.agentId ? nameOf(d.agentId) : (d.role || 'an empty BAY');
    /* UNDER A BELT CYCLE (station.layout audit 2026-09-28) reach is never computed and the router refuses the whole
       floor, so any "who hands to whom" or "not connected" line would be invented: say the one true thing. */
    if (flow && flow.cyclic) {
      segs.push({ t: 'miss', s: '[a belt LOOP on the floor stops all routing: break the circle, then this line can run]', propId: null });
      if (flow.order.length) T('. Its steps, where the belts meet them: ' + flow.order.map(pid => dockName(flow.docks[pid])).join(', ') + '.');
      return segs;
    }
    const trig = o.triggers || { schedules: [], channels: [] };
    const starts = [].concat((trig.schedules || []), (trig.channels || []).map(c => 'when a ' + c + ' message arrives'), (trig.events || []));
    // PAUSED starts (E-STOP, the scheduler off, a trigger waiting, a channel disconnected) never start the line: they
    // are named, so "nothing starts it" is never said about a line whose start is merely stopped
    const paused = trig.paused || [];
    if (!flow || !flow.trigger.propId) T('This line has no INBOX yet, so nothing can start it. ');
    else if (!starts.length && paused.length) T('Nothing starts it right now (' + paused.join('; ') + '); it runs when you send it a job. ');
    else if (!starts.length) T('It runs when you send it a job. ');   // (2026-09-30: short — the INBOX card lists what could start it by itself)
    else T(cap(joinOr(starts)) + ', ');
    if (!flow || !flow.cols.length) { T('there is no BAY on it yet.'); return segs; }
    const run = flow.cols.filter(c => !c.detached), apart = flow.cols.filter(c => c.detached);
    run.forEach((c, i) => {
      if (c.escalation) {
        // the ESCALATION lane is conditional, never "then": it runs only when the loop spends its passes unmet
        const e = c.escalation;
        if (!e.live) {
          T('; ');
          segs.push({ t: 'miss', s: '[' + c.docks.map(dockName).join(', ') + ' on the escalation lane never runs: the LOOP has no pass condition]', propId: e.propId });
          return;
        }
        const tries = ' after ' + (e.max || 5) + ' tries';
        T('; ' + (e.when === 'approved' ? 'if it is still not approved' + tries : e.when === 'revise' ? 'if the verdict still does not say revise' + tries
          : 'if it still reads as ' + e.when + ' work' + tries) + ', ');
      } else if (i > 0) T(i === run.length - 1 && !c.gate ? ' then ' : '; ');
      // a lone step in front of a LOOP gate says its hand-off AFTER the loop clause — "reviews it, handing off the approved
      // draft and sends it back to NOVA…" read as two sentences glued together (2026-09-28 retest)
      const loopHands = (c.gate && c.gate.kind === 'loop' && c.docks.length === 1 && o.handsOf) ? o.handsOf(c.docks[0].propId) : null;
      c.docks.forEach((d, j) => {
        if (j > 0) T(c.mode === 'all' ? ' and ' : ' or ');
        if (d.agentId) segs.push({ t: 'agent', s: nameOf(d.agentId), propId: d.propId });
        else segs.push({ t: 'miss', s: '[pick ' + (d.role ? 'a ' + d.role.toLowerCase() : 'an agent') + ']', propId: d.propId });
        const hands = loopHands ? null : (o.handsOf ? o.handsOf(d.propId) : null);
        T(' ' + roleInfo(d.role).verb + (hands ? ', handing off ' + hands : ''));
      });
      if (c.docks.length > 1) T(c.mode === 'all' ? ' (in parallel)' : c.mode === 'turns' ? ' (taking turns)' : ' (whichever the content routes to)');
      const g = c.gate;
      if (g && g.kind === 'loop') {
        const back = g.backTo && flow.docks[g.backTo];
        const who = back ? (back.agentId ? nameOf(back.agentId) : (back.role || 'the earlier bay')) : 'an earlier bay';
        const until = g.when === 'approved' ? 'until it is approved' : g.when === 'revise' ? 'until the verdict says revise'
          : g.when ? 'while it reads as ' + g.when + ' work' : 'every pass';
        segs.push({ t: 'loop', s: ' and sends it back to ' + who + ' ' + until + ' (' + (g.max || 5) + ' tries max)' });
        if (loopHands) T(', then hands off ' + loopHands);
      } else if (g && g.kind === 'join') T(' and the parts wait at the JOINER, then continue as one');
    });
    /* NOT CONNECTED (2026-09-23): a dock no INBOX reaches is named, never sequenced — the old walk chained such
       docks in bay order ("WRITER then RESEARCHER") though the plan held no hand-off between them. */
    for (const c of apart) {
      T(run.length ? '; not connected to ' + (flow.trigger.propId ? 'the INBOX' : 'an INBOX') + ': ' : 'Not connected to ' + (flow.trigger.propId ? 'the INBOX' : 'an INBOX') + ': ');
      c.docks.forEach((d, j) => {
        if (j > 0) T(', ');
        if (d.agentId) segs.push({ t: 'agent', s: nameOf(d.agentId), propId: d.propId });
        else segs.push({ t: 'miss', s: '[pick ' + (d.role ? 'a ' + d.role.toLowerCase() : 'an agent') + ']', propId: d.propId });
      });
    }
    T('; ');
    if (flow.outbox.reached) segs.push({ t: 'end', s: 'the result goes to the OUTBOX.' });
    else if (flow.outbox.propId && flow.outbox.reachedOnceCrewed) segs.push({ t: 'miss', s: '[the result reaches the OUTBOX once every step has an agent]', propId: flow.outbox.propId });
    else if (flow.outbox.propId) segs.push({ t: 'miss', s: '[the last step is not connected to the OUTBOX]', propId: flow.outbox.propId });
    else segs.push({ t: 'miss', s: '[there is no OUTBOX, so the result goes nowhere]', propId: null });
    return segs;
  }
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  function joinOr(list) {
    if (list.length < 2) return list[0] || '';
    return list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1];
  }

  /* ---------- SEND TO, said the same way wherever a job is sent and wherever its result is read (2026-10-12, wave-2 repair) ----------
     A SEND TO starts ANOTHER line's paid job (handoff-runner), so every key that sends a job — the panel's SEND IT DOWN THE LINE and
     RUN ONE REAL JOB, the floor FINISH card's ③ RUN ONE REAL JOB — says it first, and every card that reads the result says what
     became of it. One reading here, so the panel and the FINISH card can never promise different things.

     sendRefusal(plan, outboxId, P, statsOf) -> null | { code:'NO_CREW' } | { code:'CAP', cap } — what the hand-off runner's preflight
       would refuse the SEND TO on this OUTBOX for: a target line with no crewed entry dock, or one whose daily limit is spent
       (statsOf(lineId) -> { usdToday, capUsdPerDay } | null, the LINE BUDGET ledger the floor reads — a spend not read yet says
       nothing, never a guess). The compiled plan's dock layer, as trigger-runner crewedDocksOnLine asks it.
     sendRefusalText(name, r) -> "LINE B has no agent on its first BAY yet" / "LINE B has spent its $1.00 daily limit".
     onwardPromise(plan, lineKey, nOutboxes, P, { nameOf(outboxId)->name|null (null: that SEND TO is off), statsOf, mark(name) })
       -> '' | the sentence a sending key adds: where a clean job is sent on, at whose cost — or, for a target that would refuse it
       now, that nothing will be sent on and why. mark wraps each line name (the panel bolds it; the FINISH card leaves it plain).
     onwardResult(sr, plan, P, lineName) -> null | { kind:'sent', name, jobId } | { kind:'refused', name, why }
       | { kind:'sends', names } | { kind:'maybe', names } — what a delivered sample job's card says about the hand-off: the job's own
       record (sentTo) when the runner wrote one; else only what the floor proves — 'sends' when every OUTBOX the job's last step
       reaches sends on, nothing when none of them does, 'maybe' (said conditionally) when the job could have landed in either.
       Names: the record's, else lineName(lineId) (World.lineName — the floor's one rule), through P.lineWord. */
  function sendRefusal(plan, outboxId, P, statsOf) {
    const rec = plan && plan.sendTo ? plan.sendTo[outboxId] : null, to = rec && rec.toLine;
    if (!to || !P || !P.dockLayer) return null;
    const L = P.dockLayer(plan), reach = L.reachDock || {}, agentOf = L.agentOfDock || {}, lineOf = L.lineOfDock || {};
    if (!Object.keys(reach).some(d => reach[d] && agentOf[d] && lineOf[d] === to)) return { code: 'NO_CREW' };
    const ls = typeof statsOf === 'function' ? statsOf(to) : null;
    if (ls && ls.capUsdPerDay != null && +ls.capUsdPerDay > 0 && +ls.usdToday >= +ls.capUsdPerDay) return { code: 'CAP', cap: +ls.capUsdPerDay };
    return null;
  }
  function sendRefusalText(name, r) {
    if (!r) return '';
    return r.code === 'CAP' ? name + ' has spent its $' + (+r.cap).toFixed(2) + ' daily limit' : name + ' has no agent on its first BAY yet';
  }
  function onwardPromise(plan, lineKey, nOutboxes, P, o) {
    o = o || {};
    const st = (plan && plan.sendTo) || {}, mark = typeof o.mark === 'function' ? o.mark : (n => n);
    const sends = Object.keys(st).filter(k => st[k] && st[k].fromLine === lineKey)
      .map(k => ({ k, name: typeof o.nameOf === 'function' ? o.nameOf(k) : null })).filter(x => x.name);
    if (!sends.length) return '';
    for (const x of sends) x.no = sendRefusal(plan, x.k, P, o.statsOf);
    const open = sends.filter(x => !x.no), shut = sends.filter(x => x.no);
    const list = xs => [...new Set(xs.map(x => x.name))].map(mark).join(' and ');
    let out = '';
    if (open.length) out += (sends.length >= (nOutboxes | 0) ? ' When it finishes cleanly it is sent on to ' : ' When it finishes cleanly in an OUTBOX that sends on, it goes on to ')
      + list(open) + ': that line’s crew starts a job of its own on the result, at its own cost.';
    for (const x of shut) out += ' Its SEND TO ' + mark(x.name) + ' is set, but nothing will be sent on: ' + sendRefusalText(mark(x.name), x.no) + '.';
    return out;
  }
  function onwardResult(sr, plan, P, lineName) {
    const v = sr && sr.view;
    if (!v || !v.ok || !P || !P.lineWord) return null;
    const word = e => P.lineWord(String((e && e.name) || '').trim() || (e && e.line != null && typeof lineName === 'function' ? lineName(String(e.line)) || '' : ''), 'another line');
    if (sr.sentTo && typeof sr.sentTo === 'object')
      return sr.sentTo.refused ? { kind: 'refused', name: word(sr.sentTo), why: String(sr.sentTo.refused) } : { kind: 'sent', name: word(sr.sentTo), jobId: sr.sentTo.jobId || null };
    const onward = Array.isArray(sr.onward) ? sr.onward : [];
    if (!onward.length) return null;
    const st = (plan && plan.sendTo) || {}, sends = k => !!(st[k] && String(st[k].fromLine) === String(sr.key));
    const names = ks => [...new Set(ks.map(k => word({ line: st[k].toLine })))];
    const last = (sr.runs || [])[0], dock = last && last.dockId;
    const reached = dock && plan && P.outboxesReached ? P.outboxesReached(plan, dock) : [];
    if (reached.length) {
      const on = reached.filter(sends);
      if (!on.length) return null;   // every OUTBOX this job's last step reaches sends nowhere: nothing was handed on
      return { kind: on.length === reached.length ? 'sends' : 'maybe', names: names(on) };
    }
    // where the job landed is not on the floor (its step is gone, or reaches no OUTBOX): one OUTBOX that sends is still certain
    const ln = plan && Array.isArray(plan.lines) ? plan.lines.find(l => l && String(l.lineId) === String(sr.key)) : null;
    const outs = ln && Array.isArray(ln.outboxes) ? ln.outboxes.map(String) : [];
    if (outs.length === 1 && sends(outs[0])) return { kind: 'sends', names: names(outs) };
    return { kind: 'maybe', names: [...new Set(onward.map(d => word({ line: d && d.lineId })))] };
  }

  /* ---------- readiness: what is missing, blocking first ----------
     facts = { hasCompute(agentId, dockId)->bool, errors:[{code, propId, tile, warn}], labelOf(code)->string, briefOf(propId),
               triggers (lineStarts), isCrew(agentId)->bool (optional: is this id on the crew roster?),
               stepName(propId)->string (optional: the BAY's NAME — a named step is said by it, BAY n (Fact checker), else by its role) }
     A BLOCKING item is one the harness would fail on: no INBOX, an uncrewed dock, a dock with no workstation
     (the compute gate stays shut), no route to an OUTBOX, a compiler error on this line — or a BLOCKING error
     ANYWHERE on the floor, because the router refuses the whole plan while one stands. A HINT is advice.
     (station.layout audit 2026-09-28: the station-wide refusal, the per-BAY compute gate, crew membership, a loop's
     dead escalation lane, paused starts and the belt CYCLE were all read wrong or not at all.) */
  function readiness(flow, comp, facts) {
    const f = facts || {}, blocking = [], hints = [];
    if (!comp) return { ready: false, blocking: [{ what: 'Connect this BAY to a line: drag a machine onto it (or use the BELT tool)', propId: null }], hints };
    const mine = {}; for (const id of (comp.props || [])) mine[id] = true;
    const onLine = e => (e.propId != null && mine[e.propId]) || !!(e.tile && comp.tiles && comp.tiles[key(e.tile.x, e.tile.y)]);
    const label = code => (f.labelOf ? f.labelOf(code) : code);
    // THE WHOLE FLOOR FIRST: one blocking finding anywhere and the router refuses every line (router.setPlan), so a
    // line elsewhere is not ready either — the pill names the real fix instead of READY TO RUN
    const away = {};
    for (const e of (f.errors || [])) {
      if (!e || e.warn || onLine(e) || away[e.code]) continue;
      away[e.code] = true;
      blocking.push({ what: 'routing is off for the whole station until this is fixed: ' + label(e.code), propId: e.propId || null });
    }
    const cyclic = !!flow.cyclic;
    if (!flow.trigger.propId) blocking.push({ what: 'add an INBOX', propId: null });
    let n = 0;
    for (const pid of flow.order) {
      n++;
      const d = flow.docks[pid], nm = (f.stepName && f.stepName(pid)) || d.role, lbl = 'BAY ' + n + (nm ? ' (' + nm + ')' : '');
      if (!d.agentId) { blocking.push({ what: lbl + ' needs an agent', propId: pid }); continue; }
      // an id that is not on the crew still RUNS — on the station's default identity (runOnce identityFallback)
      if (f.isCrew && !f.isCrew(d.agentId)) hints.push({ what: lbl + '\'s agent "' + d.agentId + '" is not on the crew: its runs use the station\'s default identity. Assign a crew agent', propId: pid });
      // PER BAY: a run gets the tools of the dock it runs at (router.stationFor(agentId, dockId))
      if (f.hasCompute && !f.hasCompute(d.agentId, pid)) blocking.push({ what: lbl + ' needs a workstation', propId: pid });
      if (f.briefOf && !f.briefOf(pid)) hints.push({ what: lbl + ' has no instructions', propId: pid });
    }
    // under a belt CYCLE reach is unknown: "not connected" and "no route to the OUTBOX" would be guesses
    if (flow.trigger.propId && !cyclic) { let k = 0; for (const pid of flow.order) { k++; const d = flow.docks[pid]; if (d.detached && d.agentId) blocking.push({ what: 'BAY ' + k + ' is not connected to the INBOX', propId: pid }); } }
    if (!flow.order.length) blocking.push({ what: 'add a BAY', propId: null });
    // belts that already reach the OUTBOX once every bay is crewed are not a belt problem: the uncrewed bays' own
    // "needs an agent" items above are what is missing (sweep 2026-09-25)
    else if (!cyclic && !flow.outbox.reached && !(flow.outbox.reachedOnceCrewed && flow.order.some(pid => !flow.docks[pid].agentId))) blocking.push({ what: flow.outbox.propId ? 'connect the last step to the OUTBOX' : 'add an OUTBOX', propId: flow.outbox.propId });
    // a line whose longest way runs past its stage ceiling stops a job that goes that way part-way (chain.js preHopRefusal): not
    // ready to run — one key raises the ceiling to fit (a FILTER / TAKE TURNS line's short ways would finish: the words say so)
    if (flow.tooLong && !cyclic) blocking.push({ what: tooLongText(flow.tooLong), propId: flow.tooLong.propId, code: 'LINE_TOO_LONG' });
    const seenCodes = {};
    for (const e of (f.errors || [])) {
      if (!e || e.warn || !onLine(e) || seenCodes[e.code]) continue;
      seenCodes[e.code] = true;
      blocking.push({ what: 'fix: ' + label(e.code), propId: e.propId || null });
    }
    // a LOOP with an escalation lane but no pass condition never exhausts, so its escalation BAY never runs
    for (const g of (flow.gates || [])) if (g.kind === 'loop' && g.escTo && !g.when) hints.push({ what: 'the LOOP\'s escalation lane never runs: give the LOOP a pass condition (for example, until approved)', propId: g.propId || null });
    const t = f.triggers || {}, paused = t.paused || [];
    const live = (t.schedules || []).length || (t.channels || []).length || (t.events || []).length;
    if (flow.trigger.propId && !live) hints.push({ what: paused.length ? 'nothing starts it right now: ' + paused.join('; ') : 'nothing starts it yet (no schedule, channel, folder or webhook)', propId: flow.trigger.propId });
    else if (paused.length) hints.push({ what: 'paused: ' + paused.join('; '), propId: flow.trigger.propId });
    return { ready: !blocking.length, blocking, hints };
  }
  /* LINE_TOO_LONG in words, numbers first (the panel's blocking line and the floor hover card say the same): `tl` = a flow's
     tooLong or the compiler finding ({ stages, maxHops }). The numbers are THE ONE STAGE COUNT's (Pipeline.stageCeiling — the one
     the executor stops by and the compiler warns by), resolved where they are read: the page's Pipeline, or the module beside this
     one under node. tooLongNumbers(tl) -> { stages, maxHops, allows (the stages the budget allows), stopsAt (the stage a job that
     goes that way stops at), raiseTo (the "max stages after the first" that fits, or null when even the hard ceiling is too few —
     then the fix is a shorter line), most (the most stages any LINE BUDGET allows) } | null. */
  const pipeline = () => (typeof Pipeline !== 'undefined' && Pipeline && typeof Pipeline.stageCeiling === 'function') ? Pipeline
    : (typeof require === 'function' ? (() => { try { return require('./pipeline.js'); } catch (_) { return null; } })() : null);
  function tooLongNumbers(tl) {
    const PL = pipeline();
    if (!PL) return null;
    const s = (tl && tl.stages) | 0, m = (tl && tl.maxHops) | 0, top = PL.LINE_LIMIT_CEILINGS.maxHops, allows = PL.stageCeiling(m);
    return { stages: s, maxHops: m, allows, stopsAt: allows + 1, raiseTo: PL.overStageCeiling(s, top) ? null : PL.hopsToFit(s), most: PL.stageCeiling(top) };
  }
  function tooLongFix(tl) { const n = tooLongNumbers(tl); return n ? n.raiseTo : null; }
  function tooLongText(tl) {
    const n = tooLongNumbers(tl);
    if (!n) return 'too long: the longest way runs more stages than its LINE BUDGET allows';
    return 'too long: the longest way runs ' + n.stages + ' stages, the LINE BUDGET allows ' + n.allows + (n.raiseTo == null ? ' — shorten the line' : '');
  }
  function pillText(r) {
    if (r.ready) return 'READY TO RUN';
    const n = r.blocking.length;
    return n + ' TO FIX · ' + String(r.blocking[0].what).toUpperCase();
  }

  /* ---------- cost estimate: ONLY from steps the Commander actually tested ----------
     tests = { propId -> { usd } } (real server answers). Never guesses an untested step. */
  function costEstimate(flow, tests) {
    let usd = 0, tested = 0, untested = 0;
    for (const pid of (flow ? flow.order : [])) {
      const t = tests && tests[pid];
      if (t && typeof t.usd === 'number' && isFinite(t.usd)) { usd += t.usd; tested++; } else untested++;
    }
    const loops = !!(flow && flow.gates.some(g => g.kind === 'loop'));
    return { usd, tested, untested, loops,
      text: !tested ? 'Test a step to see its real cost'
        : '≈ $' + usd.toFixed(3) + ' a run · from ' + tested + ' tested step' + (tested === 1 ? '' : 's')
          + (untested ? ', ' + untested + ' untested' : '') + (loops ? ' · a loop can repeat steps' : '') };
  }

  /* ---------- channels: which connected channels start THIS line ----------
     status = GET /api/channels/status (id -> payload). A channel runs a line only when the agent it answers as
     crews one of the line's ENTRY docks (Pipeline.lineOriginOf: reach, never the chat binding). Proven by id
     for per-agent Telegram bots; by display name for the station channels (the payload names, never ids). */
  const CHAN_LABEL = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', matrix: 'Matrix', signal: 'Signal' };
  // (a channel addresses an AGENT; on a multi-bay line it enters at that agent's ENTRY dock — the plan's
  //  entryDock — so "feeds this line" = the agent's entry dock is one of this line's entry docks)
  function channelFeeds(status, entryAgentIds, agents) {
    const rows = [];
    if (!status || typeof status !== 'object') return rows;
    const entry = {}; for (const a of (entryAgentIds || [])) entry[a] = true;
    const byName = {}; for (const a of (agents || [])) if (a && a.name) byName[String(a.name).toLowerCase()] = a.id;
    for (const id of Object.keys(status)) {
      const s = status[id]; if (!s || typeof s !== 'object') continue;
      const label = CHAN_LABEL[id] || (id[0] ? id[0].toUpperCase() + id.slice(1) : id);
      if (s.configured) {
        const aid = s.agentName ? (byName[String(s.agentName).toLowerCase()] || null) : null;
        rows.push({ id, label, connected: !!s.connected, answersAs: s.agentName || null, agentId: aid,
          feeds: aid ? !!entry[aid] : null });
      }
      for (const b of (Array.isArray(s.bots) ? s.bots : [])) {
        if (!b || !b.configured) continue;
        rows.push({ id: id + ':' + b.botId, label: label + (b.username ? ' @' + b.username : ' bot'), connected: !!b.connected && b.enabled !== false,
          answersAs: b.agentName || b.agentId || null, agentId: b.agentId || null, feeds: b.agentId ? !!entry[b.agentId] : null });
      }
    }
    return rows;
  }

  /* ---------- schedules: the routines that run the WHOLE line ----------
     A routine runs the line only with runsLine:true AND fired at an ENTRY dock (router.lineOriginFor is
     keyed on reach). A routine at a mid-line dock runs that dock on (the old "skips" rule, said plainly). */
  /* (multi-bay) entryDockIds: a routine that FIRES AT a named bay (job.dockId) is at the entry only when THAT bay is
     one of the line's entry docks — the writer's second bay is mid-line even though the writer's first is not. */
  function lineRoutines(jobs, dockAgentIds, entryAgentIds, entryDockIds) {
    const docks = {}, entry = {}, entryDock = {};
    for (const a of (dockAgentIds || [])) docks[a] = true;
    for (const a of (entryAgentIds || [])) entry[a] = true;
    for (const d of (entryDockIds || [])) entryDock[d] = true;
    const atEntry = j => (j.dockId && entryDockIds) ? !!entryDock[j.dockId] : !!entry[j.agentId];
    return (Array.isArray(jobs) ? jobs : []).filter(j => j && docks[j.agentId]).map(j => ({
      id: j.id, name: j.name || '(unnamed)', agentId: j.agentId, dockId: j.dockId || null, enabled: j.enabled !== false, display: j.scheduleDisplay || '',
      prompt: j.prompt || '', runsLine: j.runsLine === true, atEntry: atEntry(j),
      startsLine: j.runsLine === true && atEntry(j) && j.enabled !== false }));
  }

  /* ---------- LINE TRIGGERS: the folder / webhook events that start THIS line ----------
     list = GET /api/routing/triggers .triggers. A trigger belongs to ONE line by id (lineId = the compiled line key).
     It counts as starting the line only when the SERVER says it is enabled and nothing blocks it (blockedBy null —
     the same preflight a fire runs: E-STOP, armed plan, the line on the floor, a crewed dock, the day cap). */
  function lineEventTriggers(list, lineId) {
    const mine = (Array.isArray(list) ? list : []).filter(t => t && t.lineId === lineId);
    const live = mine.filter(t => t.enabled && !t.blockedBy);
    const sentences = [];
    const folders = live.filter(t => t.kind === 'folder').map(t => 'when a file lands in ' + ((t.config && t.config.path) || 'its folder'));
    const hooks = live.filter(t => t.kind === 'webhook');
    for (const s of folders) sentences.push(s);
    if (hooks.length === 1) sentences.push('when its webhook' + (hooks[0].name ? ' "' + hooks[0].name + '"' : '') + ' is called');
    else if (hooks.length > 1) sentences.push('when one of its ' + hooks.length + ' webhooks is called');
    return { mine, live, sentences };
  }

  /* ---------- what STARTS a line: every trigger fact, composed ONCE (2026-09-28) ----------
     The Workflow panel and the lead's station.layout tool both read a line's starts through THIS, so the two can
     never disagree about what runs a line. facts = { lt: GET /api/routing/triggers, lineKey, cron: GET /api/cron,
     chans: GET /api/channels/status, agents: the roster, human: a routine's display -> words }; a fact that was
     not read is simply absent (its list stays empty). Entry docks = the routed column-0 docks of the compiled flow. */
  const entryDocksOf = flow => flow ? flow.order.filter(p => { const d = flow.docks[p]; return d.agentId && d.col === 0 && d.routed; }) : [];
  const entryAgentsOf = flow => entryDocksOf(flow).map(p => flow.docks[p].agentId);
  const dockAgentsOf = flow => flow ? flow.order.map(p => flow.docks[p].agentId).filter(Boolean) : [];
  function lineStarts(flow, facts) {
    const x = facts || {}, out = { schedules: [], channels: [], routines: [], chanRows: [], events: [], paused: [], offSchedules: [], held: [] };
    if (!flow) return out;
    const said = d => (x.human ? x.human(d) : String(d == null ? '' : d));
    // LINE TRIGGERS: only the ones the server reports enabled with nothing blocking them start the line; an enabled one
    // the server holds back is PAUSED, with the server's own reason (E-STOP, the day cap, …) — never silently dropped
    if (x.lt) {
      const ev = lineEventTriggers(x.lt.triggers, x.lineKey);
      out.events = ev.sentences;
      for (const t of ev.mine) if (t && t.enabled && t.blockedBy) {
        out.paused.push((t.kind === 'folder' ? 'its folder trigger (' + ((t.config && t.config.path) || 'a folder') + ')'
          : 'its webhook' + (t.name ? ' "' + t.name + '"' : '')) + ' is waiting: ' + t.blockedBy);
        /* …and as the START it is, held with the server's own reason (org wire AUTO-P15-1): WORKFLOWS' STARTS line said 'by hand only'
           for a line whose folder trigger the E-STOP or the day cap held. `held` = the trigger and channel starts the server holds back
           (a routine held by the switch is offSchedules), each in the words of the start it is. */
        out.held.push((t.kind === 'folder' ? 'when a file lands in ' + ((t.config && t.config.path) || 'its folder') : 'when its webhook' + (t.name ? ' "' + t.name + '"' : '') + ' is called')
          + ' (waiting: ' + String(t.blockedBy).replace(/ · /g, ' — ') + ')');
      }
    }
    if (x.cron && Array.isArray(x.cron.jobs)) {
      out.routines = lineRoutines(x.cron.jobs, dockAgentsOf(flow), entryAgentsOf(flow), entryDocksOf(flow));
      const armed = !!(x.cron.enabled && !x.cron.halted);
      for (const r of out.routines) {
        if (!r.startsLine) continue;
        if (armed) out.schedules.push(said(r.display));
        else {
          out.paused.push('its routine "' + r.name + '" (' + said(r.display) + ') is saved but ' + (x.cron.halted ? 'the scheduler is stopped (E-STOP)' : 'the scheduler is off'));
          // …and named apart for the INBOX node and the INBOX section (2026-09-27 audit T1: the panel said "no schedule"
          // right above the schedule the Commander had just saved)
          if (r.enabled !== false) out.offSchedules.push(said(r.display));
        }
      }
    }
    if (x.chans) {
      out.chanRows = channelFeeds(x.chans, entryAgentsOf(flow), x.agents);
      for (const c of out.chanRows) {
        if (c.feeds !== true) continue;
        if (c.connected) { if (out.channels.indexOf(c.label.split(' ')[0]) < 0) out.channels.push(c.label.split(' ')[0]); }
        else { out.paused.push('its ' + c.label + ' channel answers as its first step but is not connected'); out.held.push('when a ' + c.label.split(' ')[0] + ' message arrives (not connected)'); }
      }
    }
    return out;
  }
  // howItRuns' segments as the plain sentence the panel paints (for a reader with no DOM — the lead's tool)
  const sentenceText = segs => (Array.isArray(segs) ? segs : []).map(s => (s && s.s) || '').join('');

  /* ---------- LINE TRIGGERS: repaint only what changed (2026-09-24) ----------
     The panel re-reads the trigger list every 5 s while an INBOX is open. Rebuilding the whole card on each read
     remounted the WHEN picker (the picked schedule snapped back to daily 9:00), replaced an ARMED two-click
     DELETE / NEW KEY button (its confirm then missed) and collapsed open sections. triggerSig is a row's data
     fingerprint; rowPatch(prev, next) — each a list of [id, sig] in display order — says what to repaint:
     { all:true } when the rows themselves changed (added / removed / reordered), else just the ids whose data
     changed ([] = touch nothing). Pure: the panel owns the DOM. */
  function triggerSig(t, extra) {
    const str = JSON.stringify([t == null ? null : t, extra == null ? null : extra]);
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36) + '.' + str.length.toString(36);
  }
  function rowPatch(prev, next) {
    const a = Array.isArray(prev) ? prev : [], b = Array.isArray(next) ? next : [];
    if (a.length !== b.length || a.some((r, i) => !r || !b[i] || String(r[0]) !== String(b[i][0]))) return { all: true, changed: [] };
    return { all: false, changed: b.filter((r, i) => String(r[1]) !== String(a[i][1])).map(r => String(r[0])) };
  }

  /* ---------- the test input a dock's "Try this step" starts from ----------
     the previous dock's last test OUTPUT (what it would really hand over), or the line's test job for the
     first dock. null = nothing honest to offer yet ("test <prev> first"). */
  function testInputFor(flow, propId, tests, job) {
    const nb = neighbours(flow, propId);
    if (nb.first || !nb.prev.length) return job ? { text: job, from: 'the INBOX test job' } : null;
    for (const p of nb.prev) { const t = tests && tests[p]; if (t && typeof t.output === 'string' && t.output) return { text: t.output, from: p }; }
    return null;
  }

  /* ---------- step test: plain readings of a session (STEPTEST contract shape) ---------- */
  function pausedNext(session, nameOf) {
    const p = session && session.paused, nx = p && p.next;
    if (!nx) return null;
    if (nx.kind === 'agent') return { kind: 'agent', agentId: nx.agentId, dockId: nx.dockId || null, back: !!nx.back, label: (nameOf ? nameOf(nx.agentId) : nx.agentId) + (nx.back ? ' (sent back)' : '') };
    if (nx.kind === 'outbox') return { kind: 'outbox', label: 'the OUTBOX' };
    return { kind: 'end', label: 'the end (' + (nx.reason || 'no next step') + ')' };
  }
  function hopLabel(h, nameOf) {
    if (!h) return '';
    return (nameOf ? nameOf(h.agentId) : h.agentId) + (h.pass > 1 ? ' ×' + h.pass : '') + (h.rerun ? ' ↻' : '')
      + (typeof h.usd === 'number' ? ' $' + h.usd.toFixed(3) : '') + (h.edited ? ' ✎' : '');
  }
  const TERMINAL = { done: 1, stopped: 1, failed: 1 };
  const isLive = s => !!s && !TERMINAL[s.state];

  /* suggestLineFor(text) -> { id, why } | null — START FROM INTENT (2026-09-28). The Commander's own words (their onboarding goal)
     read for the SHAPE of the work they describe — a draft that a reviewer approves, research that gets written up, code
     that gets reviewed, a decision that wants two takes — and mapped to the ready-made line that has that shape. Pure and
     conservative: a goal naming ONE kind of work suggests nothing (a single agent already does that), and a schedule in the
     words only adds a pointer to the INBOX, never a guess at the time. */
  /* "pressure-test" is a second opinion, not QA: a test word counts unless "pressure" (plus at most one character) sits right
     before it. Read match by match, WITHOUT a regex lookbehind — the one lookbehind this rule used to carry was a SyntaxError
     for this WHOLE file on a Mac WebKit older than 16.4 (Safari 16.4 / macOS 13.3), so WorkflowLine never existed there and
     every workflow reading said "not loaded" (#136). test/webkit-floor-syntax.test.js keeps the page lookbehind-free. */
  const TEST_WORD = /\b(tests?|testing|tested)\b/gi, PRESSURE_BEFORE = /pressure.?$/i, QA_WORD = /\b(qa|quality assurance)\b/i;
  function hasTestWork(t) {
    for (const m of t.matchAll(TEST_WORD)) if (!PRESSURE_BEFORE.test(t.slice(0, m.index))) return true;
    return QA_WORD.test(t);
  }
  const INTENT = {
    research: /\b(research|dig|look(ing)? (up|into)|gather|sources?|news|monitor|scan)\b/i,
    write: /\b(write|writ(es|ing)|draft|compose|blurb|post|article|newsletter|summar(y|ies|ise|ize)|report|email)\b/i,
    review: /\b(review(er|ers|s|ed|ing)?|proof ?read(s|ing)?|edit(or|ors|s|ed|ing)?|approv(e|es|al|ed)|fact.?check(s|ed|ing)?|sign.?off|before (i|we) (publish|post|send|ship))\b/i,
    code: /\b(code|coding|bugs?|pull requests?|refactor|repo|commits?)\b/i,
    compare: /\b(second opinion|two takes|compare|pressure.?test)\b/i,
    test: { test: hasTestWork },   // "pressure-test" is a second opinion, not QA (see hasTestWork)
    schedule: /\b(every|each|daily|weekly|hourly|morning|evening|nightly|mondays?|weekdays?)\b/i
  };
  function suggestLineFor(text) {
    const t = String(text == null ? '' : text); if (!t.trim()) return null;
    const has = k => INTENT[k].test(t);
    let s = null;
    if (has('code') && has('test')) s = { id: 'build_test', why: 'a builder makes the change and a tester sends it back until it passes' };
    else if (has('code') && has('review')) s = { id: 'code_foundry', why: 'an engineer builds it and a reviewer sends it back until it passes' };
    else if (has('write') && has('review')) s = { id: 'revision_loop', why: 'a writer drafts it and a reviewer sends it back until it is approved' + (has('research') ? ' (add a RESEARCHER in front with + in its Workflow panel)' : '') };
    else if (has('research') && has('write')) s = { id: 'research_line', why: 'one agent digs, the next writes it up' };
    else if (has('compare')) s = { id: 'second_opinion', why: 'two agents take the same job on their own, and you get both answers' };
    if (s && has('schedule')) s.why += '; its INBOX can run it on your schedule';
    return s;
  }
  return { ROLE, GENERIC, roleInfo, starters, defaultBrief, lineFlow, physicalOrder, neighbours, howItRuns, readiness, pillText, tooLongText, tooLongFix, tooLongNumbers,
    costEstimate, channelFeeds, lineRoutines, lineEventTriggers, lineStarts, entryDocksOf, entryAgentsOf, dockAgentsOf, sentenceText,
    triggerSig, rowPatch, testInputFor, pausedNext, hopLabel, isLive, CHAN_LABEL, suggestLineFor, sendRefusal, sendRefusalText, onwardPromise, onwardResult };
});
