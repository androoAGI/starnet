/* Agent OS — app/secondbrain.js : THE LIVE BRAIN.

   What this draws. Every agent on the station already keeps a durable notebook, and recall ranks that notebook
   when its owner works. What nobody could SEE was the whole thing at once: which agent knows what, which beliefs
   the crew actually shares, which lessons are cold, and — live — the moment a run teaches the station something
   new or a belief is recalled into a prompt.

   This view is that window. It reads the unified graph (GET /api/secondbrain/graph: every agent's notebook
   projected into nodes + edges) and then rides the SAME EventSource the rest of the station already listens to
   (world.js re-emits every server channel event onto U.bus). Nothing here invents telemetry: a pulse on the
   canvas is a real memory.write / memory.used / memory.proposed / memory.forget that arrived over SSE.

   Two things make it feel alive rather than decorative:
     · a memory.write LANDS AT ITS AGENT and then settles into the cluster, so you watch a belief join the brain
     · memory.used travels from the agent to the belief it recalled — recall as a path, not a spinner

   Self-contained on purpose: it injects its own CSS and owns its own canvas + RAF loop, so adding the BRAIN
   section to a console is one line and removing it leaves no residue. */
'use strict';

const SecondBrain = (() => {
  const MAX_NODES = 320;            // canvas budget: past this the view samples and SAYS it sampled
  const REFRESH_DEBOUNCE = 1200;    // a burst of writes repaints once, not per record
  const AGENT_COLORS = ['#ffd34a', '#6fb3bf', '#7bc88a', '#d99a5a', '#a888c0', '#cf7d96'];
  const KIND_COLORS = { note: '#8fa3b0', fact: '#6fb3bf', profile: '#d99a5a', skill: '#7bc88a' };

  // ---- tiny DOM helpers (the app's own idiom: mkEl/esc, but this module stays standalone) ----
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function num(n) { return Number(n) || 0; }
  function ago(ms) {
    const d = Date.now() - num(ms);
    if (!num(ms)) return '—';
    if (d < 45000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + 'm ago';
    if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
    return Math.round(d / 86400000) + 'd ago';
  }
  function shortId(id) { return String(id || '').replace(/^mem:/, '').replace(/^agent:/, ''); }

  // ---- CSS: injected once, prefixed sb- so it can never leak into the rest of the station ----
  const CSS = [
    '.sb-wrap{display:flex;flex-direction:column;gap:10px;min-height:520px}',
    '.sb-top{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}',
    '.sb-stat{flex:1 1 96px;min-width:92px;padding:8px 10px;border:1px solid rgba(255,211,74,.18);border-radius:6px;background:rgba(255,211,74,.04)}',
    '.sb-stat b{display:block;font-size:20px;line-height:1.1;color:#ffd34a;font-variant-numeric:tabular-nums}',
    '.sb-stat span{display:block;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#8b8f96;margin-top:2px}',
    '.sb-body{display:grid;grid-template-columns:minmax(0,1fr) 268px;gap:10px;min-height:420px}',
    '@media(max-width:900px){.sb-body{grid-template-columns:minmax(0,1fr)}}',
    '.sb-stage{position:relative;border:1px solid rgba(255,211,74,.14);border-radius:6px;background:radial-gradient(ellipse at 50% 45%,rgba(255,211,74,.05),rgba(0,0,0,.35) 70%);overflow:hidden;min-height:420px}',
    '.sb-canvas{display:block;width:100%;height:100%;cursor:crosshair}',
    '.sb-legend{position:absolute;left:10px;bottom:8px;display:flex;flex-wrap:wrap;gap:10px;font-size:10px;color:#9aa0a7;pointer-events:none}',
    '.sb-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}',
    '.sb-hint{position:absolute;right:10px;top:8px;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6f747b}',
    '.sb-side{display:flex;flex-direction:column;gap:8px;min-width:0}',
    '.sb-panel{border:1px solid rgba(255,255,255,.07);border-radius:6px;background:rgba(255,255,255,.02);padding:8px 10px;min-height:0}',
    '.sb-panel h4{margin:0 0 6px;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#8b8f96;font-weight:600}',
    '.sb-feed{overflow:auto;max-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.5}',
    '.sb-row{display:flex;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);opacity:0;animation:sb-in .25s ease forwards}',
    '@keyframes sb-in{to{opacity:1}}',
    '.sb-row time{color:#6f747b;flex:0 0 42px}',
    '.sb-row em{font-style:normal;flex:0 0 46px;font-weight:600;letter-spacing:.06em}',
    '.sb-row span{color:#b9bec4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sb-w{color:#7bc88a}.sb-u{color:#6fb3bf}.sb-p{color:#ffd34a}.sb-f{color:#cf7d96}',
    '.sb-detail{font-size:11px;line-height:1.55;color:#b9bec4;overflow:auto;max-height:200px}',
    '.sb-detail b{color:#e8eaec;font-weight:600}',
    '.sb-detail .k{color:#8b8f96}',
    '.sb-acts{display:flex;flex-wrap:wrap;gap:6px}',
    '.sb-btn{font:inherit;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:6px 9px;border-radius:4px;border:1px solid rgba(255,211,74,.35);background:rgba(255,211,74,.08);color:#ffd34a;cursor:pointer}',
    '.sb-btn:hover{background:rgba(255,211,74,.16)}',
    '.sb-btn:disabled{opacity:.45;cursor:default}',
    '.sb-btn.ghost{border-color:rgba(255,255,255,.14);background:transparent;color:#b9bec4}',
    '.sb-probe{display:flex;gap:6px}',
    '.sb-probe input{flex:1;min-width:0;font:inherit;font-size:11px;padding:6px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.25);color:#e8eaec}',
    '.sb-note{font-size:10px;color:#6f747b;line-height:1.5}',
    '.sb-empty{font-size:11px;color:#8b8f96;padding:14px;text-align:center}',
    '.sb-on{display:inline-block;width:6px;height:6px;border-radius:50%;background:#7bc88a;box-shadow:0 0 6px #7bc88a;margin-right:5px;animation:sb-pulse 2.2s infinite}',
    '@keyframes sb-pulse{0%,100%{opacity:1}50%{opacity:.35}}'
  ].join('\n');
  function injectCss() {
    if (document.getElementById('sb-styles')) return;
    const s = document.createElement('style');
    s.id = 'sb-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- one mounted view ----
  function mount(host, opts) {
    opts = opts || {};
    injectCss();
    host.innerHTML = '';
    const scopeAgent = opts.agentId || null;   // mounted inside a dossier: show that agent's brain first
    const state = {
      graph: null, records: {}, nodes: [], edges: [], byId: {}, communities: [],
      feed: [], pulses: [], agentFilter: scopeAgent, selected: null, sampled: false,
      loading: true, error: '', exporting: false, vaultRoot: '', lastExport: null,
      w: 0, h: 0, dpr: 1, raf: 0, alive: true, dirty: true, lastFrame: 0, t: 0
    };

    const wrap = el('div', 'sb-wrap');
    const top = el('div', 'sb-top');
    const body = el('div', 'sb-body');
    const stage = el('div', 'sb-stage');
    const canvas = el('canvas', 'sb-canvas');
    const hint = el('div', 'sb-hint', 'click a node · scroll to zoom');
    const legend = el('div', 'sb-legend');
    const side = el('div', 'sb-side');
    const feedPanel = el('div', 'sb-panel');
    const feedHead = el('h4', null, '<span class="sb-on"></span>live activity');
    const feedBox = el('div', 'sb-feed');
    const detailPanel = el('div', 'sb-panel');
    const detailHead = el('h4', null, 'belief');
    const detailBox = el('div', 'sb-detail');
    const actPanel = el('div', 'sb-panel');
    const actHead = el('h4', null, 'the brain on disk');
    const acts = el('div', 'sb-acts');
    const noteBox = el('div', 'sb-note');

    feedPanel.appendChild(feedHead); feedPanel.appendChild(feedBox);
    detailPanel.appendChild(detailHead); detailPanel.appendChild(detailBox);
    actPanel.appendChild(actHead); actPanel.appendChild(acts); actPanel.appendChild(noteBox);
    stage.appendChild(canvas); stage.appendChild(legend); stage.appendChild(hint);
    side.appendChild(feedPanel); side.appendChild(detailPanel); side.appendChild(actPanel);
    body.appendChild(stage); body.appendChild(side);
    wrap.appendChild(top); wrap.appendChild(body);
    host.appendChild(wrap);

    // ---- stat tiles ----
    const tiles = {};
    const tileDefs = [['agents', 'agents'], ['memories', 'beliefs'], ['edges', 'links'], ['communities', 'neighbourhoods'], ['totalRecalls', 'recalls'], ['crossAgentLinks', 'cross-agent']];
    for (const d of tileDefs) {
      const t = el('div', 'sb-stat', '<b>—</b><span>' + d[1] + '</span>');
      tiles[d[0]] = t.querySelector('b');
      top.appendChild(t);
    }

    // ---- controls ----
    const refreshBtn = el('button', 'sb-btn ghost', 'refresh');
    const exportBtn = el('button', 'sb-btn', 'export to obsidian');
    const probe = el('div', 'sb-probe');
    const probeIn = el('input');
    probeIn.type = 'text';
    probeIn.placeholder = 'type a task — watch what recall would surface…';
    probeIn.setAttribute('aria-label', 'Simulate recall for a piece of text');
    const probeBtn = el('button', 'sb-btn ghost', 'probe');
    probe.appendChild(probeIn); probe.appendChild(probeBtn);
    acts.appendChild(refreshBtn); acts.appendChild(exportBtn);
    actPanel.insertBefore(probe, noteBox);
    noteBox.textContent = 'Reading every agent notebook. Nothing is written until you export.';

    // ---- fetch the graph ----
    function applyGraph(payload) {
      const g = payload && payload.graph ? payload.graph : null;
      if (!g) { state.error = 'the sidecar did not return a graph'; return; }
      state.graph = g;
      state.communities = g.communities || [];
      state.sampled = !!(g.stats && g.stats.sampled);
      state.records = (payload && payload.records) || {};
      const stats = g.stats || {};
      for (const k of Object.keys(tiles)) tiles[k].textContent = String(num(stats[k]));
      legend.innerHTML = renderLegend(g);
      // layout nodes
      state.nodes = [];
      state.byId = {};
      const live = (g.nodes || []).filter(n => n.type !== 'concept');
      const concepts = (g.nodes || []).filter(n => n.type === 'concept');
      let budget = MAX_NODES;
      const picked = [];
      for (const n of live) { if (budget-- <= 0) break; picked.push(n); }
      const agentCol = {};
      let ai = 0;
      for (const n of g.nodes || []) {
        if (n.type !== 'agent') continue;
        agentCol[n.agentId] = n.color || AGENT_COLORS[ai % AGENT_COLORS.length];
        ai++;
      }
      const total = picked.length || 1;
      picked.forEach((n, i) => {
        const angle = i * 2.399963229728653;   // golden angle — a sunflower, so nothing overlaps at t=0
        const rad = 22 + Math.sqrt(i / total) * Math.min(state.w || 520, state.h || 420) * 0.42;
        const isAgent = n.type === 'agent';
        const node = {
          id: n.id, type: n.type, label: n.label, agentId: n.agentId || null, kind: n.kind || null,
          trust: n.trust, useCount: n.useCount, pinned: n.pinned, projectRoot: n.projectRoot,
          x: (state.w || 520) / 2 + Math.cos(angle) * rad,
          y: (state.h || 420) / 2 + Math.sin(angle) * rad,
          vx: 0, vy: 0,
          r: isAgent ? 13 + Math.min(12, Math.sqrt(num(n.memories) + 1) * 3) : n.type === 'project' || n.type === 'stream' ? 8 : 4.2,
          color: isAgent ? (agentCol[n.agentId] || '#ffd34a') : (agentCol[n.agentId] || KIND_COLORS[n.kind] || '#8fa3b0'),
          glow: 0, dim: 0
        };
        state.nodes.push(node);
        state.byId[node.id] = node;
      });
      // concepts: placed at the centroid of their members, so a neighbourhood sits where its beliefs live
      for (const c of concepts) {
        const mem = (c.members || []).map(id => state.byId[id]).filter(Boolean);
        if (!mem.length) continue;
        const cx = mem.reduce((s, n) => s + n.x, 0) / mem.length;
        const cy = mem.reduce((s, n) => s + n.y, 0) / mem.length;
        const node = { id: c.id, type: 'concept', label: c.label, x: cx, y: cy, vx: 0, vy: 0, r: 6 + Math.min(10, Math.sqrt(c.size) * 1.6), color: '#5b6470', glow: 0, dim: 0 };
        state.nodes.push(node);
        state.byId[node.id] = node;
      }
      state.edges = (g.edges || []).map(e => ({ a: e.source, b: e.target, type: e.type, w: num(e.weight) || 1 }))
        .filter(e => state.byId[e.a] && state.byId[e.b]);
      state.loading = false;
      state.dirty = true;
      renderDetail();
    }

    function renderLegend(g) {
      const agents = (g.nodes || []).filter(n => n.type === 'agent').slice(0, 6);
      const cols = {};
      let i = 0;
      for (const n of (g.nodes || [])) if (n.type === 'agent') { cols[n.agentId] = n.color || AGENT_COLORS[i % AGENT_COLORS.length]; i++; }
      return agents.map(a => '<span><i style="background:' + esc(cols[a.agentId] || '#ffd34a') + '"></i>' + esc(a.label) + '</span>').join('') +
        '<span><i style="background:#5b6470"></i>neighbourhood</span>';
    }

    async function load(quiet) {
      if (!quiet) state.error = '';
      try {
        const api = (typeof Harness !== 'undefined' && Harness.api) ? Harness.api : null;
        const payload = api ? await api.get('/api/secondbrain/graph') : await fetchJson('/api/secondbrain/graph');
        applyGraph(payload);
      } catch (e) {
        state.error = 'could not read the brain — ' + ((e && e.message) || e);
      } finally {
        state.loading = false;
        state.dirty = true;
      }
    }
    async function fetchJson(url, body) {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }

    // ---- feed ----
    const FEED_LABEL = {
      'memory.write': ['WRITE', 'sb-w'], 'memory.used': ['RECALL', 'sb-u'], 'memory.proposed': ['PROPOSE', 'sb-p'],
      'memory.forget': ['FORGET', 'sb-f'], 'memory.feedback': ['FEEDBK', 'sb-p'],
      'agent.run.start': ['RUN', 'sb-u'], 'agent.run.end': ['DONE', 'sb-w']
    };
    function pushFeed(name, payload) {
      const def = FEED_LABEL[name];
      if (!def) return;
      const p = payload || {};
      const who = agentLabel(p.agentId);
      let what = '';
      if (name === 'memory.write') what = 'learned ' + (p.kind || 'note') + ' · ' + shortId(p.id);
      else if (name === 'memory.used') what = 'recalled ' + shortId(p.id);
      else if (name === 'memory.proposed') what = 'proposes ' + (p.kind || 'note') + ' · ' + shortId(p.id);
      else if (name === 'memory.forget') what = 'forgot ' + shortId(p.id);
      else if (name === 'memory.feedback') what = 'verdict ' + (num(p.delta) > 0 ? '+' : '') + num(p.delta) + ' on ' + shortId(p.id);
      else if (name === 'agent.run.start') what = 'started a run';
      else what = 'finished a run';
      state.feed.unshift({ at: Date.now(), label: def[0], cls: def[1], who: who, what: what });
      if (state.feed.length > 120) state.feed.length = 120;
      paintFeed();
      // pulse the agent node so the activity is visible on the canvas, not only in the list
      const an = state.byId['agent:' + p.agentId];
      if (an) { an.glow = 1; state.pulses.push({ from: an, to: null, at: Date.now(), age: 0 }); }
      if (name === 'memory.used' && state.byId['mem:' + p.agentId + '/' + p.id]) {
        const target = state.byId['mem:' + p.agentId + '/' + p.id];
        target.glow = 1;
        state.pulses.push({ from: an || target, to: target, at: Date.now(), age: 0 });
      }
    }
    function paintFeed() {
      if (!state.feed.length) { feedBox.innerHTML = '<div class="sb-note">No activity yet. Send an agent a task — writes and recalls appear here as they happen.</div>'; return; }
      feedBox.innerHTML = state.feed.map(f =>
        '<div class="sb-row"><time>' + new Date(f.at).toTimeString().slice(0, 5) + '</time>' +
        '<em class="' + f.cls + '">' + f.label + '</em><span>' + esc(f.who) + ' ' + esc(f.what) + '</span></div>'
      ).join('');
    }
    function agentLabel(id) {
      const n = state.nodes.find(x => x.type === 'agent' && x.agentId === id);
      return n ? n.label : String(id || 'station');
    }

    // ---- detail ----
    function renderDetail() {
      const n = state.selected && state.byId[state.selected];
      if (!n) {
        detailHead.textContent = 'belief';
        const s = (state.graph && state.graph.stats) || {};
        detailBox.innerHTML = '<div class="sb-note">Click any node to inspect it. ' +
          '<b>' + num(s.memories) + '</b> beliefs · <b>' + num(s.crossAgentLinks) + '</b> links actually cross agents.<br><br>' +
          'Pinned beliefs, high-trust beliefs and never-recalled beliefs are all in here — the export writes each as an Obsidian note with its provenance.</div>';
        return;
      }
      const rec = state.records[shortId(n.id) + ''] || state.records[n.agentId + '/' + n.id.replace(/^mem:/, '')] || null;
      detailHead.textContent = n.type === 'memory' ? 'belief' : n.type;
      const rows = [];
      rows.push('<b>' + esc(n.label || n.id) + '</b>');
      if (n.type === 'memory') {
        if (rec) {
          rows.push('<div style="margin-top:6px;white-space:pre-wrap">' + esc(String(rec.body || rec.text || '').slice(0, 420)) + '</div>');
          rows.push('<div style="margin-top:8px">' +
            '<span class="k">agent</span> ' + esc(agentLabel(rec.agentId)) + ' · ' +
            '<span class="k">kind</span> ' + esc(rec.kind) + ' · ' +
            '<span class="k">scope</span> ' + esc(rec.scope) + '</div>');
          rows.push('<div><span class="k">confidence</span> ' + esc(rec.confirmation) + ' · ' +
            '<span class="k">trust</span> ' + (Math.round(num(rec.trust) * 100) / 100) + ' · ' +
            '<span class="k">recalled</span> ' + num(rec.useCount) + '×</div>');
          rows.push('<div><span class="k">learned</span> ' + ago(rec.createdAt) + ' · <span class="k">last used</span> ' + ago(rec.lastUsedAt) + '</div>');
          const related = state.edges.filter(e => (e.a === n.id || e.b === n.id) && (e.type === 'similar' || e.type === 'references'))
            .map(e => state.byId[e.a === n.id ? e.b : e.a]).filter(Boolean).slice(0, 5);
          if (related.length) rows.push('<div style="margin-top:6px"><span class="k">related</span><br>' + related.map(r => '· ' + esc(r.label)).join('<br>') + '</div>');
        } else {
          rows.push('<div style="margin-top:6px">' + esc(n.label) + '</div>');
        }
      } else if (n.type === 'agent') {
        const mems = state.nodes.filter(x => x.type === 'memory' && x.agentId === n.agentId);
        rows.push('<div style="margin-top:6px"><span class="k">beliefs</span> ' + mems.length + '<br><span class="k">pinned</span> ' + mems.filter(m => m.pinned).length + '</div>');
        rows.push('<div style="margin-top:6px">' + mems.slice(0, 6).map(m => '· ' + esc(m.label)).join('<br>') + '</div>');
      } else if (n.type === 'concept') {
        const c = state.communities.find(x => x.id === n.id);
        rows.push('<div style="margin-top:6px"><span class="k">beliefs</span> ' + num(c && c.size) + ' · <span class="k">agents</span> ' + ((c && c.agents) || []).length + '</div>');
      }
      detailBox.innerHTML = rows.join('');
    }

    // ---- canvas ----
    const ctx = canvas.getContext('2d');
    function fit() {
      const r = stage.getBoundingClientRect();
      state.w = Math.max(280, Math.round(r.width));
      state.h = Math.max(320, Math.round(r.height));
      state.dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
      canvas.width = Math.round(state.w * state.dpr);
      canvas.height = Math.round(state.h * state.dpr);
      canvas.style.width = state.w + 'px';
      canvas.style.height = state.h + 'px';
      state.dirty = true;
    }
    // Defer the resize to the next frame: fit() writes canvas.width/height inside the observer callback, which
    // is exactly the "ResizeObserver loop completed with undelivered notifications" error Chrome raises when a
    // callback mutates the element it observes. Scheduling it out of the callback settles the loop cleanly.
    let fitQueued = false;
    const queueFit = () => {
      if (fitQueued) return;
      fitQueued = true;
      requestAnimationFrame(() => { fitQueued = false; if (state.alive) fit(); });
    };
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(queueFit) : null;
    if (ro) ro.observe(stage); else window.addEventListener('resize', queueFit);

    function step() {
      const nodes = state.nodes, edges = state.edges;
      // grid-bucketed repulsion: near-linear, so 300+ nodes still animate smoothly on a laptop
      const CELL = 90, grid = new Map();
      for (const n of nodes) {
        const gx = Math.floor(n.x / CELL), gy = Math.floor(n.y / CELL);
        const k = gx + ',' + gy;
        let b = grid.get(k); if (!b) { b = []; grid.set(k, b); }
        b.push(n);
      }
      for (const n of nodes) {
        const gx = Math.floor(n.x / CELL), gy = Math.floor(n.y / CELL);
        for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const b = grid.get((gx + ox) + ',' + (gy + oy));
          if (!b) continue;
          for (const m of b) {
            if (m === n) continue;
            let dx = n.x - m.x, dy = n.y - m.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) { d2 = 1; dx = (n.id < m.id ? 0.6 : -0.6); dy = 0.4; }
            if (d2 > CELL * CELL * 2.2) continue;
            const f = 42 / d2 * (n.type === 'agent' ? 2.2 : 1);
            n.vx += dx * f * 0.06; n.vy += dy * f * 0.06;
          }
        }
      }
      for (const e of edges) {
        const a = state.byId[e.a], b = state.byId[e.b];
        if (!a || !b) continue;
        const rest = e.type === 'wrote' ? 70 : e.type === 'in_concept' ? 46 : e.type === 'similar' ? 54 : 60;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - rest) * 0.0016 * (e.w || 1);
        const fx = dx / d * f, fy = dy / d * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      const cx = state.w / 2, cy = state.h / 2;
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.0012;
        n.vy += (cy - n.y) * 0.0012;
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;
        const pad = n.r + 6;
        if (n.x < pad) { n.x = pad; n.vx = Math.abs(n.vx) * 0.4; }
        if (n.y < pad) { n.y = pad; n.vy = Math.abs(n.vy) * 0.4; }
        if (n.x > state.w - pad) { n.x = state.w - pad; n.vx = -Math.abs(n.vx) * 0.4; }
        if (n.y > state.h - pad) { n.y = state.h - pad; n.vy = -Math.abs(n.vy) * 0.4; }
        if (n.glow > 0) n.glow = Math.max(0, n.glow - 0.012);
      }
      // pulses: a travelling spark from agent to belief (recall) or a pop at the agent (write)
      for (let i = state.pulses.length - 1; i >= 0; i--) {
        const p = state.pulses[i];
        p.age += 0.02;
        if (p.age >= 1) state.pulses.splice(i, 1);
      }
    }

    function draw() {
      const w = state.w, h = state.h, d = state.dpr;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // edges
      for (const e of state.edges) {
        const a = state.byId[e.a], b = state.byId[e.b];
        if (!a || !b) continue;
        const dimmed = state.agentFilter && a.agentId !== state.agentFilter && b.agentId !== state.agentFilter && e.type !== 'in_concept';
        ctx.globalAlpha = dimmed ? 0.04 : e.type === 'similar' ? 0.16 : 0.1;
        ctx.strokeStyle = e.type === 'similar' ? '#6fb3bf' : e.type === 'in_concept' ? '#5b6470' : '#ffd34a';
        ctx.lineWidth = e.type === 'similar' ? 0.9 : 0.6;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // pulses
      for (const p of state.pulses) {
        const from = p.from, to = p.to || p.from;
        if (!from) continue;
        const x = from.x + (to.x - from.x) * p.age, y = from.y + (to.y - from.y) * p.age;
        const fade = 1 - p.age;
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255,211,74,' + (0.55 * fade) + ')';
        ctx.arc(x, y, 2.6 + 2 * fade, 0, Math.PI * 2);
        ctx.fill();
      }
      // nodes
      for (const n of state.nodes) {
        const dimmed = state.agentFilter && n.agentId && n.agentId !== state.agentFilter && n.type === 'memory';
        ctx.globalAlpha = dimmed ? 0.22 : 1;
        const glow = n.glow > 0 ? n.glow : 0;
        if (glow) {
          ctx.beginPath();
          ctx.fillStyle = 'rgba(255,211,74,' + (0.22 * glow) + ')';
          ctx.arc(n.x, n.y, n.r + 10 * glow, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        if (n.type === 'concept') {
          ctx.strokeStyle = n.color; ctx.lineWidth = 1.1; ctx.globalAlpha = (dimmed ? 0.1 : 0.5);
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.stroke();
        } else {
          ctx.fillStyle = n.color || '#8fa3b0';
          if (n.type === 'memory' && n.pinned) { ctx.strokeStyle = '#ffd34a'; ctx.lineWidth = 1.4; }
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
          if (n.type === 'memory' && n.pinned) ctx.stroke();
        }
        if (n.type === 'agent' || n === state.byId[state.selected]) {
          ctx.globalAlpha = dimmed ? 0.3 : 0.92;
          ctx.fillStyle = 'rgba(232,234,236,.92)';
          ctx.font = (n.type === 'agent' ? '600 11px ' : '10px ') + 'ui-monospace, Menlo, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(String(n.label || '').slice(0, 22), n.x, n.y - n.r - 6);
          if (n.useCount != null && n.type === 'memory') ctx.fillText(num(n.useCount) + '×', n.x, n.y + n.r + 12);
        }
      }
      ctx.globalAlpha = 1;
      if (state.loading) {
        ctx.fillStyle = 'rgba(232,234,236,.6)'; ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText('reading every notebook…', w / 2, h / 2);
      }
      if (state.error) {
        ctx.fillStyle = 'rgba(207,125,150,.9)'; ctx.font = '11px ui-monospace, monospace'; ctx.textAlign = 'center';
        ctx.fillText(state.error, w / 2, h / 2);
      }
      if (state.sampled) {
        ctx.fillStyle = 'rgba(139,143,150,.8)'; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'right';
        ctx.fillText('sampled — ' + num(state.graph && state.graph.stats && state.graph.stats.memories) + ' beliefs total', w - 10, h - 10);
      }
    }

    function loop() {
      if (!state.alive) return;
      // a rebuilt console throws its old panes away without calling destroy(); a detached host must stop its own
      // RAF loop or every visit to the dossier leaves an animation running behind the station forever.
      if (!host.isConnected) { state.alive = false; return; }
      const visible = host.offsetParent !== null;
      if (visible) {
        if (state.dirty) { fit(); state.dirty = false; }
        // settle hard for the first second after a load, then idle at a light simmer
        step();
        draw();
      }
      state.raf = requestAnimationFrame(loop);
    }

    // ---- interaction ----
    canvas.addEventListener('click', ev => {
      const r = canvas.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      let best = null, bestD = 18 * 18;
      for (const n of state.nodes) {
        const dx = n.x - x, dy = n.y - y, d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = n; }
      }
      state.selected = best ? best.id : null;
      renderDetail();
      state.dirty = false;
    });
    canvas.addEventListener('mousemove', ev => {
      const r = canvas.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      let hit = null;
      for (const n of state.nodes) { const dx = n.x - x, dy = n.y - y; if (dx * dx + dy * dy < (n.r + 5) * (n.r + 5)) { hit = n; break; } }
      canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    });

    // ---- actions ----
    refreshBtn.addEventListener('click', () => { refreshBtn.disabled = true; load().then(() => { refreshBtn.disabled = false; }); });
    exportBtn.addEventListener('click', async () => {
      if (state.exporting) return;
      state.exporting = true; exportBtn.disabled = true;
      noteBox.textContent = 'writing the vault…';
      try {
        const api = (typeof Harness !== 'undefined' && Harness.api) ? Harness.api : null;
        const out = api ? await api.post('/api/secondbrain/export', {}) : await fetchJson('/api/secondbrain/export', {});
        state.vaultRoot = out.root || '';
        state.lastExport = out;
        noteBox.innerHTML = 'Wrote <b>' + num(out.files) + '</b> files · ' + num(out.counts && out.counts.memories) + ' beliefs, ' +
          num(out.counts && out.counts.agents) + ' agents, ' + num(out.counts && out.counts.concepts) + ' neighbourhoods.<br>' +
          '<span style="word-break:break-all">' + esc(out.root || '') + '</span><br>' +
          'Open that folder as a vault in Obsidian — Brain.md, the .base views and the graph are all in there.';
        if (typeof notify === 'function') notify('Second brain exported to Obsidian', 'good');
      } catch (e) {
        noteBox.textContent = 'Export failed — ' + ((e && e.message) || e);
        if (typeof notify === 'function') notify('Second brain export failed', 'bad');
      } finally { state.exporting = false; exportBtn.disabled = false; }
    });
    async function runProbe() {
      const text = probeIn.value.trim();
      if (!text) { probeIn.focus(); return; }
      try {
        const api = (typeof Harness !== 'undefined' && Harness.api) ? Harness.api : null;
        const out = api ? await api.post('/api/secondbrain/recall', { text: text, k: 10 }) : await fetchJson('/api/secondbrain/recall', { text: text, k: 10 });
        state.pulses = [];   // a probe clears the previous wave so the new one reads cleanly
        let i = 0;
        for (const hit of (out.hits || [])) {
          const n = state.byId[hit.id];
          if (!n) continue;
          n.glow = 1;
          const from = state.byId['agent:' + (n.agentId || '')] || n;
          state.pulses.push({ from: from, to: n, at: Date.now(), age: -0.06 * i++ });
        }
        // negative age staggers the sparks so a multi-hit probe reads as a wave, not one blur
        state.feed.unshift({ at: Date.now(), label: 'PROBE', cls: 'sb-p', who: 'recall', what: '"' + text.slice(0, 40) + '" → ' + (out.hits || []).length + ' beliefs' });
        paintFeed();
      } catch (e) {
        state.feed.unshift({ at: Date.now(), label: 'PROBE', cls: 'sb-f', who: 'recall', what: 'failed — ' + ((e && e.message) || e) });
        paintFeed();
      }
    }
    probeBtn.addEventListener('click', runProbe);
    probeIn.addEventListener('keydown', ev => { if (ev.key === 'Enter') runProbe(); });

    // ---- live wiring: the station already re-emits every server event onto U.bus ----
    const wired = [];
    function wire(name) {
      if (typeof U === 'undefined' || !U.bus || typeof U.bus.on !== 'function') return;
      const fn = p => pushFeed(name, p);
      U.bus.on(name, fn);
      wired.push([name, fn]);
    }
    for (const name of Object.keys(FEED_LABEL)) wire(name);

    let refreshTimer = null;
    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refreshTimer = null; load(true); }, REFRESH_DEBOUNCE);
    }
    const bump = () => scheduleRefresh();
    for (const name of ['memory.write', 'memory.forget', 'memory.proposed', 'memory.feedback']) {
      if (typeof U !== 'undefined' && U.bus && typeof U.bus.on === 'function') { U.bus.on(name, bump); wired.push([name, bump]); }
    }

    fit();
    paintFeed();
    renderDetail();
    load();
    loop();

    return {
      destroy() {
        state.alive = false;
        if (state.raf) cancelAnimationFrame(state.raf);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', queueFit);
        if (refreshTimer) clearTimeout(refreshTimer);
        if (typeof U !== 'undefined' && U.bus && typeof U.bus.off === 'function') for (const w of wired) U.bus.off(w[0], w[1]);
        host.innerHTML = '';
      },
      refresh: () => load()
    };
  }

  return { mount: mount, MAX_NODES: MAX_NODES };
})();

/* The station-wide door. A per-agent brain lives in the dossier (MEMORY already answers "what does THIS agent
   know"); the second brain answers the other question — "what does the STATION know, and who learned it" — so it
   gets its own window in the CREW dock rather than a sixth tab inside one agent's file. registerWindow is
   stationui.js's additive seam: same slot shape as the inline windows, so nothing else has to change. */
if (typeof StationUI !== 'undefined' && StationUI.registerWindow) {
  StationUI.registerWindow('brain', 'SECOND BRAIN', body => {
    body.classList.add('brain-win');
    if (typeof SecondBrain !== 'undefined') SecondBrain.mount(body);
    else body.innerHTML = '<p class="muted">The second brain view failed to load.</p>';
  }, { console: true, className: 'brain-win' });
}

if (typeof module !== 'undefined' && module.exports) module.exports = SecondBrain;
