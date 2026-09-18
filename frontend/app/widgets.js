/* STARNET — widgets.js : the WIDGET RAILS (user-pinnable telemetry instruments).

   Two rails of compact instruments live in the chrome's DEAD SPACE — the empty middle of
   #topbar (between the logo anchor and the instrument cluster) and of #bottombar (between
   the dock groups and #term-strip/.bb-right). The world canvas is NEVER a widget surface:
   widgets belong to the chrome, like the STATION/SPEND wells they sit beside.

   TRUTHFUL TELEMETRY — every widget in the Phase-1 catalog is a read-only projection of
   provable harness state, sourced exactly like topbar.js sources SPEND TODAY:
     - RUNS · 24H   — /api/insights (whole-station fold, 24 hourly buckets) polled ≤1/30s,
                      PLUS live agent.run.end folds between polls (reconciled on next poll).
     - QUEUE        — the live queue.status {queueId, depth} events (per-agent inbound
                      backpressure). Event-driven only: shows an honest "—" until the first
                      event arrives, never a fabricated zero.
     - ROUTINES     — /api/cron {jobs, enabled} polled ≤1/60s + a value pulse on cron.fire.
     - TOKENS       — /api/insights totalTokens (all-time, whole station).

   AGENT-FED widgets (Phase 2) — any agent can publish a named readout via the widget.set
   tool (app revenue, AI news, anything); records live in the sidecar's station store and
   are polled from GET /api/widgets (≤1/30s). Their pinned ids are 'feed:<slug>'.
   PROVENANCE LAW: an agent-fed instrument always shows WHO fed it and WHEN ("NOVA · 3m")
   — the app never asserts the value is true, only that that agent reported it, then. A
   pinned feed whose record disappears paints an honest "no signal", never a stale number
   dressed as fresh.

   The connected-app studio creates durable user definitions through /api/widgets/configure.
   Refresh uses a dedicated Workstreams/Chat conversation and the existing connector access
   gates; widget.set publishes the reading with version, agent and timestamp. Schedule setup
   uses AutomationWindow's existing editor. Legacy station counters remain loadable only for
   saved pins. This module never emits a new shared event or changes the shared contract.

   Layout is user-arranged: drag a widget by anywhere on its body between the two rails
   (an insert caret previews the slot), add from the ＋ popover, remove via the hover ✕.
   Persisted under starnet.widgets.v1 = {v:1, top:[ids], bot:[ids]}. */
'use strict';
const Widgets = (() => {
  const KEY = 'starnet.widgets.v1';
  const POLL_INSIGHTS_MS = 30000;
  const POLL_FEED_MS = 30000;
  const TICKER_MS = 4000;
  const FEED_RE = /^feed:[a-z0-9][a-z0-9-]{0,23}$/;   // pinned-layout id for an agent-fed record: 'feed:' + its widget.set slug

  let wired = false;
  let layout = { top: [], bot: [] };   // widgets are user-chosen app data; no counters pinned by default

  // ---- live data (module-local; all painted from here) ----
  let insights = null;        // last good /api/insights fold (null until first poll lands)
  let liveRunEnds = 0;        // agent.run.end count since the last good poll (the between-poll tick)
  let cron = null;            // last good /api/cron {jobs, enabled}
  const queueMap = new Map(); // queueId -> latest depth (event-driven)
  let queueSeen = false;      // stays honest: "—" until the first queue.status arrives
  const feed = new Map();     // slug -> agent-fed record (each /api/widgets poll rebuilds it whole)
  let tickerStep = 0;         // shared ticker phase — every list widget cycles in step
  let stopCron = null;        // subscription ownership; QuerySpine owns the one cron poll timer
  let insightsRequest = null, feedRequest = null;

  // E3: per-source staleness — the honest "this last-good number is no longer live" flag. A silent
  // poll failure used to keep painting the last-good figure with a hardcoded 'live' tag; now the
  // failing source flips stale (value dims + source tag reads 'stale', mirroring the canvas
  // linkStaleDim). Cleared on the next SUCCESSFUL poll. Keyed by the widget's real data source.
  const pollFail = { insights: false, cron: false, feed: false };
  // whether the live SSE bridge is down — the event-driven QUEUE widget's staleness signal (its depth
  // is fed by queue.status events, so a dropped bridge means the latched depth is last-known, not live).
  function linkDownNow() {
    try { if (typeof World !== 'undefined' && World.linkState) { const ls = World.linkState(); return !!(ls && ls.bridged && !ls.paused && ls.down); } } catch (_) {}
    return false;
  }
  // is a static widget's source stale RIGHT NOW? poll-fed widgets: their poll failed, OR the SSE bridge
  // is down (the sidecar is gone, so the next poll is already doomed — flag it now rather than waiting
  // ~30s for the poll to time out). Event-fed QUEUE: only the SSE bridge going down. Agent-fed widgets
  // keep their own provenance/"no signal" honesty and are never marked here.
  const SRC_OF = { runs24: 'insights', tokens: 'insights', cron: 'cron', next: 'cron', queue: 'queue', active: 'queue', approvals: 'queue' };
  function staleFor(id) {
    const src = SRC_OF[id];
    if (src === 'queue') return linkDownNow();
    if (src === 'insights' || src === 'cron') return pollFail[src] || linkDownNow();
    return false;
  }

  const $ = sel => document.querySelector(sel);

  /* ================= pure folds (node-tested; no DOM) ================= */

  // sum the insights overTime buckets → runs in the window, plus the per-bucket series for the spark.
  function foldRuns(st) {
    const ot = (st && Array.isArray(st.overTime)) ? st.overTime : [];
    let runs = 0; const series = [];
    for (const b of ot) { const n = Number(b && b.runs) || 0; runs += n; series.push(n); }
    return { runs, series };
  }

  // all-time token total: prefer the fold's own figure, else sum byModel (defensive, never NaN).
  function foldTokens(st) {
    if (st && isFinite(Number(st.totalTokens))) return Number(st.totalTokens);
    let t = 0;
    for (const m of (st && Array.isArray(st.byModel)) ? st.byModel : []) t += Number(m && m.tokens) || 0;
    return t;
  }

  // Arm intent and runnable state are separate: E-STOP deliberately preserves `enabled` while freezing the timer.
  function cronStateLabel(c) {
    if (!c) return '';
    if (c.halted) return 'stopped · E-STOP';
    return c.enabled ? 'armed' : 'disarmed';
  }

  // compact count: 950 → "950", 12400 → "12.4K", 3200000 → "3.2M" (tabular, no locale surprises)
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return (Math.round(n / 1e2) / 10) + 'K';
    return String(Math.round(n));
  }

  // sanitize a persisted layout: known ids (or well-formed feed:* ids) only, no dupes across
  // rails, always both arrays. A pinned feed id whose record is gone SURVIVES sanitize — the
  // record may simply not have polled in yet; it paints "no signal" until it does.
  function sanitizeLayout(raw, known) {
    const out = { top: [], bot: [] }, seen = new Set();
    for (const rail of ['top', 'bot']) {
      const ids = (raw && Array.isArray(raw[rail])) ? raw[rail] : [];
      for (const id of ids) if ((known.indexOf(id) >= 0 || FEED_RE.test(id)) && !seen.has(id)) { seen.add(id); out[rail].push(id); }
    }
    return out;
  }

  // sanitize ONE /api/widgets record: trust nothing, truncate everything, null on a bad id.
  function sanitizeFeedRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const slug = String(raw.id || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(slug)) return null;
    const s = (v, n) => { if (v === undefined || v === null) return null; v = String(v); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
    const list = Array.isArray(raw.list) ? raw.list.slice(0, 5).map(x => s(x, 90)).filter(Boolean) : [];
    const value = s(raw.value, 24);
    const config = raw.config && raw.config.source && ['metric', 'list', 'trend', 'progress'].includes(raw.config.display)
      ? { source: { kind: s(raw.config.source.kind, 24), id: s(raw.config.source.id, 100), label: s(raw.config.source.label, 80) },
        request: s(raw.config.request, 1200), display: raw.config.display, version: Number(raw.config.version) } : null;
    if (value === null && !list.length && !config) return null;
    // expressive dressing (tone/spark/progress) — trust nothing: whitelist the tone, keep only
    // finite spark numbers (≥2 to draw a line), clamp progress into 0-100. All optional.
    const spark = Array.isArray(raw.spark) ? raw.spark.slice(0, 24).map(Number).filter(v => isFinite(v)) : [];
    const prog = raw.progress == null || raw.progress === '' ? NaN : Number(raw.progress);
    return {
      slug: slug,
      label: s(raw.label, 28) || slug.toUpperCase(),
      value: value, sub: s(raw.sub, 28), list: list,
      tone: (raw.tone === 'ok' || raw.tone === 'warn' || raw.tone === 'bad') ? raw.tone : null,
      spark: spark.length >= 2 ? spark : null,
      progress: isFinite(prog) ? Math.max(0, Math.min(100, prog)) : null,
      agentId: s(raw.agentId, 40) || 'agent',
      updatedAt: Number(raw.updatedAt) || 0
      , config, error: s(raw.error, 300), sourceState: s(raw.sourceState, 40), sourceUrl: safeSourceUrl(raw.sourceUrl)
    };
  }

  function safeSourceUrl(raw) {
    try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch (_) { return null; }
  }
  function feedStatus(rec) {
    if (!rec) return 'no signal';
    if (rec.sourceState && !['up', 'cached', 'configured', 'available'].includes(rec.sourceState)) return 'app ' + rec.sourceState;
    if (rec.config && typeof Channels !== 'undefined' && Channels.isBusy('widget-' + rec.slug)) return Channels.runIdOf('widget-' + rec.slug) ? 'updating' : 'connecting';
    if (rec.error) return 'update failed';
    return rec.updatedAt ? 'updated ' + fmtAge(Date.now(), rec.updatedAt) : 'no reading yet';
  }

  // provenance age: how long since the agent set it. Coarse on purpose — it's a trust cue, not a stopwatch.
  function fmtAge(nowMs, ts) {
    const d = Math.max(0, (Number(nowMs) || 0) - (Number(ts) || 0));
    if (d < 45000) return 'now';
    if (d < 90 * 60000) return Math.max(1, Math.round(d / 60000)) + 'm';
    if (d < 36 * 3600000) return Math.round(d / 3600000) + 'h';
    return Math.round(d / 86400000) + 'd';
  }

  function nextRoutine(c, now) {
    if (!c) return { val: null, sub: 'waiting for scheduler' };
    if (c.halted || !c.enabled) return { val: null, sub: cronStateLabel(c) };
    const jobs = (c.jobs || []).filter(j => j.enabled && Number.isFinite(Date.parse(j.nextRunAt)))
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
    if (!jobs.length) return { val: null, sub: 'nothing scheduled' };
    const mins = Math.ceil((Date.parse(jobs[0].nextRunAt) - now) / 60000);
    return { val: mins <= 0 ? 'due' : mins < 60 ? mins + 'm' : mins < 1440 ? Math.ceil(mins / 60) + 'h' : Math.ceil(mins / 1440) + 'd', sub: jobs[0].name || jobs[0].id };
  }

  function commsReadout(approvals) {
    if (typeof Channels === 'undefined') return { val: null, sub: 'waiting for COMMS' };
    const ids = Channels.busyIds();
    const confirmed = ids.filter(id => Channels.runIdOf(id));
    const n = approvals ? Channels.pendingIds().length : confirmed.length;
    return { val: String(n), sub: approvals ? 'awaiting you' : (ids.length > confirmed.length ? (ids.length - confirmed.length) + ' connecting' : 'confirmed runs') };
  }

  /* ================= the catalog ================= */
  // paint() returns {val, sub, series?} — null val paints an honest "—".
  const CATALOG = {
    crew: {
      stats: true,
      lbl: 'CREW', tip: 'Agents in your current station roster, including the overseer.',
      paint() { return { val: typeof App !== 'undefined' && App.crewCount ? String(App.crewCount()) : null, sub: 'station roster' }; }
    },
    active: { stats: true, lbl: 'ACTIVE COMMS', tip: 'Confirmed running conversations in COMMS. Connecting requests are shown separately; background jobs are not included.', paint: () => commsReadout(false) },
    approvals: { lbl: 'NEEDS YOU', action: 'Review waiting conversation', tip: 'Conversations waiting for your approval or answer. Use the arrow to open the first waiting conversation.', paint: () => ({ ...commsReadout(true), tone: typeof Channels !== 'undefined' && Channels.pendingIds().length ? 'warn' : null }) },
    next: { lbl: 'NEXT ROUTINE', action: 'Open scheduled routines', tip: 'The next enabled routine on the scheduler. Use the arrow to view or change your schedule. A due time does not mean the job has started.', paint: () => nextRoutine(cron, Date.now()) },
    runs24: {
      stats: true,
      lbl: 'RUNS · 24H',
      tip: 'Runs across the whole station in the last 24h — folded from the real run history (/api/insights), ticking live on each run end.',
      paint() {
        if (!insights) return { val: null, sub: '' };
        const f = foldRuns(insights);
        return { val: String(f.runs + liveRunEnds), sub: '', series: f.series };
      }
    },
    queue: {
      stats: true,
      lbl: 'QUEUE',
      tip: 'Inbound work items waiting across all agents — live queue.status backpressure events. Shows — until the first event arrives.',
      paint() {
        if (!queueSeen) return { val: null, sub: '' };
        let d = 0; for (const v of queueMap.values()) d += v;
        return { val: String(d), sub: d === 1 ? 'item' : 'items' };
      }
    },
    cron: {
      stats: true,
      lbl: 'ROUTINES',
      tip: 'Scheduled routines on the sidecar (/api/cron) — count + whether the scheduler is armed. The value pulses when a routine fires.',
      paint() {
        if (!cron) return { val: null, sub: '' };
        const n = Array.isArray(cron.jobs) ? cron.jobs.length : 0;
        return { val: String(n), sub: cronStateLabel(cron) };
      }
    },
    tokens: {
      stats: true,
      lbl: 'TOKENS',
      tip: 'Recorded tokens across station run history, including subscription runs — from the real usage fold.',
      paint() {
        if (!insights) return { val: null, sub: '' };
        return { val: fmtCount(foldTokens(insights)), sub: 'all-time' };
      }
    }
  };
  const KNOWN = Object.keys(CATALOG);

  // Navigation only: review the underlying work, never approve or run it from a widget.
  function waitingConversation() {
    if (typeof Channels === 'undefined' || typeof Workstreams === 'undefined') return null;
    return Channels.pendingIds().find(id => Workstreams.get(id)) || null;
  }
  function openWidget(id) {
    if (id === 'next' && typeof StationUI !== 'undefined' && StationUI.openTerm) {
      closePop(); StationUI.openTerm('routines'); return true;
    }
    const wsId = id === 'approvals' ? waitingConversation() : null;
    if (wsId && typeof App !== 'undefined' && App.openWorkstream) {
      closePop(); App.openWorkstream(wsId);
      if (typeof StationUI !== 'undefined' && StationUI.h?.workConversation) StationUI.h.workConversation('widgets');
      return true;
    }
    return false;
  }

  // resolve an id to its definition — the static catalog, or a dynamic agent-fed def.
  // paint() for a feed widget returns {tick} (ticker line) OR {val,sub}, plus {prov} — the
  // provenance line ("NOVA · 3m") that REPLACES the static widgets' plain "live" source tag.
  function agentNameOf(aid) {
    try {
      if (typeof App !== 'undefined' && App.agentName) return App.agentName(aid) || aid;
      if (typeof App !== 'undefined' && App.agents && typeof App.agents.get === 'function') {
        const a = App.agents.get(aid);
        if (a && a.name) return String(a.name);
      }
    } catch (_) {}
    return aid;
  }
  function defOf(id) {
    if (CATALOG[id]) return CATALOG[id];
    if (!FEED_RE.test(id)) return null;
    const slug = id.slice(5);
    return {
      lbl: (feed.get(slug) || {}).label || slug.toUpperCase(),
      fed: true,
      configured: !!feed.get(slug)?.config,
      action: feed.get(slug)?.config ? 'View ' + feed.get(slug).label : null,
      tip: 'Agent-fed readout "' + slug + '" — an agent publishes this via widget.set. The station only asserts WHO reported it and WHEN (the name · age line), never that the figure itself is true.',
      paint() {
        const rec = feed.get(slug);
        if (!rec) return { val: null, sub: 'no signal', prov: null };
        const status = feedStatus(rec);
        const prov = rec.config ? rec.config.source.label + ' · ' + (rec.updatedAt ? agentNameOf(rec.agentId) + ' · ' + fmtAge(Date.now(), rec.updatedAt) + (status.startsWith('updated') ? '' : ' · ' + status) : status)
          : agentNameOf(rec.agentId) + ' · ' + fmtAge(Date.now(), rec.updatedAt);
        if (!rec.updatedAt && rec.config) return { val: null, sub: 'no reading yet', prov };
        if (rec.list.length) return { tick: rec.list[tickerStep % rec.list.length], prov: prov, tone: rec.tone };
        return { val: rec.value, sub: rec.sub || '', prov: prov, tone: rec.tone, series: rec.spark || undefined, prog: rec.progress };
      }
    };
  }

  /* ================= persistence (own key only) ================= */
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && raw.v === 1) layout = sanitizeLayout(raw, KNOWN);
    } catch (_) { /* corrupt store: keep the default */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ v: 1, top: layout.top, bot: layout.bot })); } catch (_) {}
  }

  /* ================= render ================= */
  function railEl(r) { return document.getElementById(r === 'top' ? 'wr-top' : 'wr-bot'); }

  function sparkSvg(series) {
    const w = 46, h = 16;
    if (!series || series.length < 2) return '';
    // normalize against the series RANGE (not just the max) so a flat-ish agent series
    // (e.g. revenue 1200..1240) still shows its shape instead of a flat line at the top.
    const mx = Math.max(...series), mn = Math.min(...series);
    const span = (mx - mn) || 1;
    const xy = series.map((v, i) => [
      (i / (series.length - 1)) * w,
      h - 2 - ((v - mn) / span) * (h - 5)
    ]);
    const pts = xy.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const last = xy[xy.length - 1];
    // area fill under the line + a bright endpoint dot — the "now" reading
    return '<svg class="wg-spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">'
      + '<polygon points="0,' + h + ' ' + pts + ' ' + w + ',' + h + '" stroke="none"/>'
      + '<polyline points="' + pts + '" fill="none"/>'
      + '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="1.6" stroke="none"/></svg>';
  }

  // a small milled progress bar — width is a sanitized 0-100 number, never agent markup
  function progHtml(pct) {
    return '<i class="wg-prog"><i class="wg-prog-fill" style="width:' + Number(pct).toFixed(1) + '%"></i></i>';
  }

  function makeWidget(id) {
    const def = defOf(id); if (!def) return document.createElement('span');
    const el = document.createElement('div');
    el.className = 'wg' + (def.fed ? ' wg-fed' : '');
    el.dataset.wg = id;
    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', def.lbl + '. Enter to manage; Alt + arrows to move.');
    el.title = def.tip;
    // NOTE label/name text lands via textContent below — feed strings are agent-authored, never innerHTML'd.
    el.innerHTML =
      '<span class="wg-meta"><span class="wg-lbl"></span>'
      + '<span class="wg-src"><i class="wg-dot' + (def.fed ? ' wg-dot-fed' : '') + '" aria-hidden="true"></i><span class="wg-srctext"></span></span></span>'
      + '<b class="wg-val">—</b><span class="wg-sub"></span><span class="wg-sparkslot"></span>'
      + (def.action ? '<button class="wg-open">↗</button>' : '')
      + '<button class="wg-x" title="remove widget" aria-label="Remove widget">✕</button>';
    const open = el.querySelector('.wg-open');
    if (open) {
      open.setAttribute('aria-label', def.action); open.title = def.action;
      open.addEventListener('click', e => { e.stopPropagation();
        if (def.configured) { if (popEl) closePop(); togglePop(el, layout.top.includes(id) ? 'top' : 'bot'); showWidgetDetail(id.slice(5)); }
        else openWidget(id);
      });
    }
    el.querySelector('.wg-lbl').textContent = def.lbl;
    el.querySelector('.wg-srctext').textContent = def.fed ? '…' : 'live';
    el.querySelector('.wg-x').addEventListener('click', (e) => { e.stopPropagation(); removeWidget(id); railEl('top').querySelector('.wg-add').focus(); });
    el.addEventListener('keydown', e => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePop(el, layout.top.includes(id) ? 'top' : 'bot'); if (def.configured) showWidgetDetail(id.slice(5)); }
      if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') placeWidget(id, e.key === 'ArrowUp' ? 'top' : 'bot');
        else reorderWidget(id, e.key === 'ArrowLeft' ? -1 : 1);
        document.querySelector('[data-wg="' + id + '"]').focus();
      }
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest('button')) return;
      startDrag(e, id);
    });
    paintWidget(el, id);
    return el;
  }

  function paintWidget(el, id) {
    const def = defOf(id); if (!def) return;
    const p = def.paint();
    const val = el.querySelector('.wg-val'), sub = el.querySelector('.wg-sub'), slot = el.querySelector('.wg-sparkslot');
    const lbl = el.querySelector('.wg-lbl'), srct = el.querySelector('.wg-srctext');
    const open = el.querySelector('.wg-open');
    if (open && id === 'approvals') open.disabled = !waitingConversation();
    if (lbl) lbl.textContent = def.lbl;                       // a feed label can change on any poll
    if (p.tick != null) {                                     // ticker form: one cycling line instead of a big figure
      if (val) { val.textContent = ''; val.style.display = 'none'; }
      if (sub) { sub.textContent = p.tick; sub.classList.add('wg-ticktext'); }
      el.setAttribute('data-empty', '0');
    } else {
      if (val) { val.style.display = ''; val.textContent = id === 'next' && p.val == null ? p.sub : id === 'approvals' && p.val === '0' ? 'clear' : p.val == null ? '—' : p.val; }
      if (sub) { sub.classList.remove('wg-ticktext'); sub.textContent = p.sub || ''; }
      el.setAttribute('data-empty', p.val == null ? '1' : '0');
    }
    // tone: an agent-declared semantic tint (whitelisted at sanitize) — the chrome maps it to theme colours
    el.setAttribute('data-tone', p.tone || '');
    if (slot) {
      if (p.val == null || p.tick != null) slot.innerHTML = '';
      else if (p.prog != null) slot.innerHTML = progHtml(p.prog);   // progress beats spark: one accessory per instrument
      else slot.innerHTML = sparkSvg(p.series);
    }
    if (def.fed && srct) {
      const rec = feed.get(id.slice(5));
      const sourceUnavailable = rec?.config && rec.sourceState && !['up', 'cached', 'configured', 'available'].includes(rec.sourceState);
      const stale = pollFail.feed || linkDownNow() || !!rec?.error || !!sourceUnavailable;
      el.setAttribute('data-stale', stale ? '1' : '0');
      srct.textContent = (p.prov || 'no signal') + (pollFail.feed || linkDownNow() ? ' · offline' : '');
    }
    // E3: STATIC widgets carry a hardcoded 'live' source tag. When the source goes stale (poll failure
    // or SSE drop) flip it to 'stale' and dim the value — but ONLY when a real latched value is showing.
    // A first-paint '—' (no value yet) stays honestly '—'/'live', never dressed as stale data.
    if (!def.fed) {
      const stale = staleFor(id);
      el.setAttribute('data-stale', stale ? '1' : '0');
      if (srct) srct.textContent = stale ? 'stale' : p.val == null ? 'no reading' : id === 'crew' ? 'roster' : (SRC_OF[id] === 'insights' || SRC_OF[id] === 'cron') ? 'synced' : 'live';
    }
  }

  function paintAll(pulseId) {
    for (const el of document.querySelectorAll('.wg')) {
      paintWidget(el, el.dataset.wg);
      if (pulseId && el.dataset.wg === pulseId) {
        el.classList.remove('wg-tick'); void el.offsetWidth; el.classList.add('wg-tick');
      }
    }
    paintWidgetDetail();
  }

  function makeAddBtn(rail) {
    const b = document.createElement('button');
    b.className = 'wg-add';
    b.title = 'add a widget';
    b.setAttribute('aria-label', 'Add a widget to this rail');
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    b.textContent = '＋';
    b.addEventListener('click', (e) => { e.stopPropagation(); togglePop(b, rail); });
    return b;
  }

  function render() {
    for (const r of ['top', 'bot']) {
      const el = railEl(r); if (!el) continue;
      el.innerHTML = '';
      for (const id of layout[r]) el.appendChild(makeWidget(id));
      el.appendChild(makeAddBtn(r));
      el.setAttribute('data-empty', layout[r].length === 0 ? '1' : '0');
    }
    save();
  }

  function removeWidget(id) {
    layout.top = layout.top.filter(x => x !== id);
    layout.bot = layout.bot.filter(x => x !== id);
    render();
  }

  function placeWidget(id, rail) {
    if (!defOf(id) || !['top', 'bot', 'hidden'].includes(rail)) return;
    if (rail !== 'hidden' && layout[rail].includes(id)) return;
    layout.top = layout.top.filter(x => x !== id);
    layout.bot = layout.bot.filter(x => x !== id);
    if (rail !== 'hidden') layout[rail].push(id);
    render();
  }
  function reorderWidget(id, delta) {
    const rail = layout.top.includes(id) ? 'top' : 'bot';
    const index = layout[rail].indexOf(id), target = index + delta;
    if (index < 0 || target < 0 || target >= layout[rail].length) return;
    layout[rail].splice(index, 1); layout[rail].splice(target, 0, id); render();
  }

  /* ================= widget library ================= */
  let popEl = null;
  let popReturn = null, popRail = 'top', popFilter = 'main', popSearch = '';
  let popMode = 'list', detailId = null;
  const refreshes = new Set();
  let sourceRows = null, sourcesRequest = null, studioEpoch = 0, selectedPreset = null;
  const PRESETS = [
    { label: 'Revenue snapshot', display: 'metric', request: 'Show revenue for this month so far, with the currency and reporting period. Use the connected app’s actual revenue definition and explain it in the update conversation.' },
    { label: 'Tasks due', display: 'list', request: 'Show up to five open tasks due today or overdue, including their due dates. If none are due, report that explicitly.' },
    { label: 'Daily brief', display: 'list', request: 'Show up to five important recent updates from this app that need my attention, with enough context to act. If there are none, say so.' }
  ];
  function studioText(parent, tag, text, cls) {
    const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; parent.appendChild(el); return el;
  }
  function addStudioButton(parent, label, fn, cls = '') {
    const b = studioText(parent, 'button', label, 'wg-studio-button ' + cls); b.type = 'button';
    b.addEventListener('click', fn); return b;
  }
  async function widgetApi(path, body) {
    const r = await fetch('/api/widgets' + path, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, signal: U.timeoutSignal(12000) });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Could not reach the widget service.');
    return data;
  }
  function selectWidgetTab(key) {
    if (!popEl) return;
    studioEpoch++; popMode = 'list'; detailId = null; popFilter = key; popSearch = '';
    const input = popEl.querySelector('.wg-library-search'); input.hidden = false; input.value = '';
    input.placeholder = key === 'apps' ? 'Find a connected app…' : 'Search widgets…';
    for (const b of popEl.querySelectorAll('[data-widget-tab]')) b.setAttribute('aria-pressed', String(b.dataset.widgetTab === key));
    libraryCards();
  }
  function studioBody(mode) {
    studioEpoch++; popMode = mode;
    const list = popEl.querySelector('.wg-library-list'); list.replaceChildren();
    popEl.querySelector('.wg-library-search').hidden = true;
    return list;
  }
  async function sourceCards(force = false) {
    if (!popEl || popMode !== 'list' || popFilter !== 'apps') return;
    const root = popEl, epoch = ++studioEpoch, list = root.querySelector('.wg-library-list'); list.replaceChildren();
    studioText(list, 'p', selectedPreset ? 'Choose the app for ' + selectedPreset.label + '.' : 'Choose an app, then tell StarNet what to display.', 'wg-studio-note');
    if (!sourceRows || force) {
      const loading = studioText(list, 'p', 'Loading connected apps…', 'wg-studio-note');
      try {
        if (!sourcesRequest) sourcesRequest = widgetApi('/sources').then(d => d.sources).finally(() => { sourcesRequest = null; });
        const rows = await sourcesRequest;
        if (!Array.isArray(rows)) throw new Error('The app list was unavailable.');
        sourceRows = rows;
      } catch (e) {
        if (popEl !== root || studioEpoch !== epoch) return;
        loading.textContent = e.message; addStudioButton(list, 'Retry app list', () => sourceCards(true)); return;
      }
      if (popEl !== root || studioEpoch !== epoch) return;
      loading.remove();
    }
    let matches = 0;
    for (const s of sourceRows) {
      if (!(s.label + ' ' + s.id).toLowerCase().includes(popSearch.toLowerCase())) continue;
      matches++;
      const row = studioText(list, 'div', '', 'wg-app-row');
      const caption = studioText(row, 'div', '', 'wg-app-caption');
      studioText(caption, 'strong', s.label);
      studioText(caption, 'small', s.kind === 'agent' ? 'Information StarNet manages' : s.kind === 'servicekey' && s.available ? 'API key configured' : s.available ? 'Connected' : s.state);
      const b = addStudioButton(row, s.available ? 'Choose' : 'Reconnect', () => {
        if (s.available) showWidgetForm(s, null, selectedPreset);
        else { closePop(); if (typeof StationUI !== 'undefined') StationUI.openTerm('connectors', s.kind === 'servicekey' ? 'keys' : 'mcp'); }
      });
      b.setAttribute('aria-label', (s.available ? 'Choose ' : 'Reconnect ') + s.label);
    }
    if (!matches) studioText(list, 'p', 'No apps match this search.', 'wg-studio-note');
    const foot = studioText(list, 'div', '', 'wg-studio-actions');
    addStudioButton(foot, 'Connect another app', () => { closePop(); if (typeof StationUI !== 'undefined') StationUI.openTerm('connectors', 'catalog'); });
    addStudioButton(foot, 'Reload apps', () => sourceCards(true));
  }
  function presetButtons(parent, onPick) {
    const strip = studioText(parent, 'div', '', 'wg-presets');
    for (const preset of PRESETS) addStudioButton(strip, preset.label, () => onPick(preset));
  }
  function showWidgetForm(source, record, preset) {
    if (!popEl) return;
    const root = popEl, list = studioBody('form'); detailId = null;
    addStudioButton(list, '← Back', () => record ? showWidgetDetail(record.slug) : selectWidgetTab('apps'));
    studioText(list, 'h3', (record ? 'Edit widget · ' : 'New widget · ') + source.label, 'wg-studio-heading');
    const form = document.createElement('form'); form.className = 'wg-studio-form'; list.appendChild(form);
    const field = (label, tag, name, value, max) => {
      const wrap = studioText(form, 'div', '', 'wg-studio-field');
      const caption = studioText(wrap, 'label', label); caption.htmlFor = 'wg-editor-' + name;
      const input = document.createElement(tag); input.name = name; input.className = 'wg-studio-input';
      input.id = caption.htmlFor;
      if (max) input.maxLength = max; input.value = value || ''; wrap.appendChild(input); return input;
    };
    const title = field('Name', 'input', 'label', record?.label || preset?.label, 28); title.required = true;
    const request = field('What should it show?', 'textarea', 'request', record?.config.request || preset?.request, 1200); request.required = true;
    request.placeholder = 'For example: monthly revenue for my app, in USD'; request.rows = 3;
    const display = field('Display', 'select', 'display', '');
    for (const [value, label] of [['metric','Number'],['list','List'],['trend','Trend'],['progress','Progress']]) {
      const option = studioText(display, 'option', label); option.value = value;
    }
    display.value = record?.config.display || preset?.display || 'metric';
    if (!record) presetButtons(form, p => { title.value = p.label; request.value = p.request; display.value = p.display; });
    studioText(form, 'p', 'Your agent reads this source and publishes the result. Refresh on demand, or add a schedule after creation.', 'wg-studio-note');
    const message = studioText(form, 'p', '', 'wg-studio-message'); message.setAttribute('role','status');
    const save = studioText(form, 'button', record ? 'Save & refresh' : 'Create & fetch', 'wg-studio-button wg-studio-primary'); save.type = 'submit';
    // A stable id makes an uncertain create response retryable without duplicating the widget.
    const id = record?.slug || ('w-' + crypto.randomUUID().replaceAll('-', '').slice(0,20));
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (save.disabled) return; save.disabled = true; message.textContent = 'Saving widget…';
      try {
        const d = await widgetApi('/configure', { id, label: title.value, request: request.value, display: display.value,
          source: { kind: source.kind, id: source.id }, version: record?.config.version });
        const rec = sanitizeFeedRecord(d.widget); if (!rec) throw new Error('The widget could not be loaded.');
        feed.set(rec.slug, rec); if (!record) placeWidget('feed:' + rec.slug, popRail); else render();
        selectedPreset = null;
        if (popEl !== root || popMode !== 'form' || !form.isConnected) return;
        showWidgetDetail(rec.slug);
        await refreshWidget(rec.slug);
      } catch (err) { if (form.isConnected) { message.textContent = err.message; save.disabled = false; } }
    });
    title.focus();
  }
  function openWidgetTask(rec) {
    const id = 'widget-' + rec.slug;
    const existing = Workstreams.get(id);
    const ws = existing || Workstreams.adopt({ id, title: rec.label, agentId: typeof App.heroId === 'function' ? App.heroId() : 'agent', kind: 'chat', revive: true });
    if (!ws) throw new Error('Could not open this widget’s update conversation.');
    App.openWorkstream(ws.id); Chat.load(ws); App.persist();
    if (typeof StationUI !== 'undefined' && StationUI.h?.workConversation) StationUI.h.workConversation('widgets');
    return ws;
  }
  async function refreshWidget(id) {
    if (refreshes.has(id)) return;
    const rec = feed.get(id); if (!rec?.config) return;
    const report = text => { if (popEl && detailId === id) popEl.querySelector('.wg-studio-message').textContent = text; };
    refreshes.add(id); report('Opening update…');
    try {
      if (typeof Workstreams === 'undefined' || typeof Chat === 'undefined' || typeof App === 'undefined') throw new Error('The agent conversation is unavailable.');
      if (typeof Channels !== 'undefined' && Channels.isBusy('widget-' + id)) { closePop(); openWidgetTask(rec); return; }
      const root = popEl, d = await widgetApi('/request', { id });
      if (popEl !== root || detailId !== id) return; // cancellation/navigation never sends a delayed task
      closePop(); openWidgetTask(rec);
      await Chat.send(d.prompt);
      await pollFeed();
    } catch (e) { report(e.message); }
    finally { refreshes.delete(id); paintAll(); }
  }
  function paintWidgetDetail() {
    if (!popEl || popMode !== 'detail') return;
    const rec = feed.get(detailId), box = popEl.querySelector('.wg-detail-reading'); if (!rec || !box) return;
    box.replaceChildren();
    studioText(box, 'p', rec.config.source.label + ' · ' + feedStatus(rec), 'wg-studio-note');
    if (rec.updatedAt) {
      if (rec.list.length) { const ul = document.createElement('ul'); for (const line of rec.list) studioText(ul, 'li', line); box.appendChild(ul); }
      else { studioText(box, 'strong', rec.value || '—', 'wg-detail-value'); studioText(box, 'p', rec.sub || '', 'wg-studio-note'); }
      if (rec.spark) { const chart = document.createElement('div'); chart.className = 'wg-detail-chart'; chart.innerHTML = sparkSvg(rec.spark); box.appendChild(chart); }
      if (rec.progress != null) { const p = document.createElement('progress'); p.max = 100; p.value = rec.progress; p.setAttribute('aria-label','Progress'); box.appendChild(p); studioText(box, 'span', rec.progress + '%'); }
      studioText(box, 'p', 'Reported by ' + agentNameOf(rec.agentId) + ' · ' + new Date(rec.updatedAt).toLocaleString(), 'wg-studio-note');
      if (rec.sourceUrl) { const a = studioText(box, 'a', 'Open source'); a.href = rec.sourceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    } else studioText(box, 'p', 'No reading yet. Open the update conversation for progress or questions.', 'wg-studio-note');
    if (rec.error) studioText(box, 'p', rec.error, 'wg-studio-error');
    const jobs = (cron?.jobs || []).filter(j => j.meta?.widgetId === rec.slug);
    const next = jobs.find(j => j.enabled && j.nextRunAt);
    studioText(box, 'p', jobs.length ? (!cron.enabled || cron.halted ? 'Scheduled updates paused' : next ? 'Next update: ' + new Date(next.nextRunAt).toLocaleString() : 'Update schedule disabled') : 'Refresh on demand', 'wg-studio-note');
    if (pollFail.feed || linkDownNow()) studioText(box, 'p', 'Station offline · showing the last saved reading.', 'wg-studio-error');
  }
  function showWidgetDetail(id) {
    const rec = feed.get(id); if (!popEl || !rec?.config) return;
    const list = studioBody('detail'); detailId = id;
    addStudioButton(list, '← Your widgets', () => selectWidgetTab('main'));
    studioText(list, 'h3', rec.label, 'wg-studio-heading');
    studioText(list, 'div', '', 'wg-detail-reading'); paintWidgetDetail();
    studioText(list, 'p', rec.config.request, 'wg-studio-note');
    const msg = studioText(list, 'p', '', 'wg-studio-message'); msg.setAttribute('role','status');
    const actions = studioText(list, 'div', '', 'wg-studio-actions');
    addStudioButton(actions, 'Refresh now', () => refreshWidget(id), 'wg-studio-primary');
    addStudioButton(actions, 'Open update', () => { closePop(); openWidgetTask(rec); });
    addStudioButton(actions, 'Edit', () => showWidgetForm(rec.config.source, rec));
    addStudioButton(actions, 'Schedule updates', async () => {
      if (typeof AutomationWindow === 'undefined' || !AutomationWindow.openDraft) { msg.textContent = 'Automation is unavailable.'; return; }
      if ((cron?.jobs || []).some(j => j.meta?.widgetId === id)) { closePop(); StationUI.openTerm('routines'); return; }
      closePop(); AutomationWindow.openDraft({ name: rec.label + ' widget', agentId: typeof App !== 'undefined' && App.heroId ? App.heroId() : 'agent',
        widgetId: rec.slug,
        prompt: 'Update my saved widget ' + JSON.stringify(rec.slug) + '. First call widget.get with that id for the CURRENT source, display and version. If it was deleted, stop without fetching or recreating it. Follow its refresh instructions, use the existing source access, and publish with widget.set. Do not modify data in the source app.' });
    });
    addStudioButton(actions, 'Delete widget', async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await widgetApi('/remove', { id }); feed.delete(id); removeWidget('feed:' + id); if (typeof QuerySpine !== 'undefined') QuerySpine.refresh('cron'); if (detailId === id && popEl) selectWidgetTab('main'); }
      catch (err) { if (msg.isConnected) { msg.textContent = err.message; b.disabled = false; } }
    });
  }
  function closePop() {
    if (!popEl) return;
    popEl.remove(); popEl = null;
    document.removeEventListener('click', outsidePop);
    window.removeEventListener('resize', closePop);
    const target = popReturn && popReturn.isConnected ? popReturn : railEl(popRail)?.querySelector('.wg-add');
    if (target) { target.setAttribute('aria-expanded', 'false'); target.focus(); }
  }
  function outsidePop(e) { if (popEl && !popEl.contains(e.target)) closePop(); }
  function libraryCards() {
    if (!popEl || popMode !== 'list') return;
    if (popFilter === 'apps') { sourceCards(); return; }
    const list = popEl.querySelector('.wg-library-list');
    const focused = document.activeElement && document.activeElement.dataset.wgControl;
    list.replaceChildren();
    const ids = Array.from(new Set([...KNOWN, ...Array.from(feed.keys(), s => 'feed:' + s), ...layout.top, ...layout.bot]));
    let count = 0;
    for (const id of ids) {
      const def = defOf(id), rail = layout.top.includes(id) ? 'top' : layout.bot.includes(id) ? 'bot' : 'hidden';
      if (popFilter === 'pinned' ? rail === 'hidden' : !def.fed) continue;
      if (!(def.lbl + ' ' + def.tip + ' ' + id).toLowerCase().includes(popSearch.toLowerCase())) continue;
      count++;
      const card = document.createElement('section'); card.className = 'wg-library-card' + (def.fed ? ' wg-library-card-fed' : ''); card.dataset.widget = id;
      card.title = def.tip;
      const preview = makeWidget(id); preview.classList.add('wg-preview'); preview.removeAttribute('tabindex');
      preview.setAttribute('aria-label', def.lbl + ' preview');
      preview.querySelector('.wg-x').remove();
      preview.querySelector('.wg-open')?.remove();
      const actions = document.createElement('div'); actions.className = 'wg-library-actions';
      const action = (label, key, fn, pressed, disabled, name = label) => {
        const b = document.createElement('button'); b.className = 'wg-library-action'; b.textContent = label;
        b.dataset.wgControl = id + ':' + key; b.setAttribute('aria-label', name + ' ' + def.lbl);
        b.title = name + ' ' + def.lbl;
        if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
        b.disabled = !!disabled;
        b.addEventListener('click', () => { fn(); libraryCards(); }); actions.appendChild(b);
      };
      action('TOP', 'top', () => placeWidget(id, 'top'), rail === 'top', false, 'Top');
      action('BTM', 'bot', () => placeWidget(id, 'bot'), rail === 'bot', false, 'Bottom');
      action('×', 'hidden', () => placeWidget(id, 'hidden'), undefined, rail === 'hidden', 'Hide');
      if (def.configured) action('…', 'details', () => showWidgetDetail(id.slice(5)), undefined, false, 'Manage');
      card.append(preview, actions); list.appendChild(card);
    }
    if (!count) {
      const empty = document.createElement('p'); empty.className = 'wg-library-empty';
      empty.textContent = popSearch ? 'No matching widgets.' : popFilter === 'pinned' ? 'No pinned widgets. Choose one from Your widgets.' : 'Your apps, at a glance. Choose a connected app to create your first widget.';
      list.appendChild(empty);
      if (!popSearch && popFilter === 'main') addStudioButton(list, 'Choose an app', () => selectWidgetTab('apps'));
    }
    if (popFilter === 'main' && !popSearch) {
      studioText(list, 'p', 'Start from a preset', 'wg-studio-note');
      presetButtons(list, preset => { selectedPreset = preset; selectWidgetTab('apps'); });
    }
    popEl.querySelector('.wg-library-count').textContent = (layout.top.length + layout.bot.length) + ' pinned';
    if (focused) {
      const next = Array.from(list.querySelectorAll('button')).find(b => b.dataset.wgControl === focused && !b.disabled);
      (next || list.querySelector('button'))?.focus();
    }
  }
  function togglePop(btn, rail) {
    if (popEl) { closePop(); return; }
    popReturn = btn; popRail = rail; popSearch = ''; popFilter = 'main'; popMode = 'list'; detailId = null; sourceRows = null; selectedPreset = null;
    popEl = document.createElement('div');
    popEl.className = 'wg-pop wg-library';
    popEl.setAttribute('role', 'dialog'); popEl.setAttribute('aria-modal', 'true'); popEl.setAttribute('aria-label', 'Widget library');
    popEl.innerHTML = '<header class="wg-library-header"><h2>WIDGETS</h2><span class="wg-library-count" role="status"></span><button class="wg-library-close" aria-label="Close widget library">✕</button></header>'
      + '<input class="wg-library-search" type="search" aria-label="Search widgets" placeholder="Search widgets…">'
      + '<div class="wg-library-filters" role="group" aria-label="Widget category"></div><div class="wg-library-list"></div>';
    for (const [key, label] of [['main', 'Your widgets'], ['apps', 'Connected apps'], ['pinned', 'Pinned']]) {
      const b = document.createElement('button'); b.textContent = label; b.setAttribute('aria-pressed', String(key === popFilter));
      b.dataset.widgetTab = key;
      b.addEventListener('click', () => selectWidgetTab(key)); popEl.querySelector('.wg-library-filters').appendChild(b);
    }
    popEl.querySelector('.wg-library-close').addEventListener('click', closePop);
    popEl.querySelector('input').addEventListener('input', e => { popSearch = e.target.value; libraryCards(); });
    popEl.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); }
      if (e.key === 'Tab') {
        const focusable = Array.from(popEl.querySelectorAll('input, textarea, select, a[href], button:not(:disabled)')).filter(el => !el.hidden && el.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(popEl);
    // TEXT SIZE zoom: rect + innerWidth are visual px, style.left/top on a body child is zoomed-space
    // — divide everything by the body zoom so the popover still hugs its rail button at any scale.
    const uz = uiZoom();
    const r = btn.getBoundingClientRect();
    const below = r.top < window.innerHeight / 2;   // top rail → open downward; bottom rail → upward
    const width = Math.min(340, window.innerWidth / uz - 16);
    popEl.style.width = width + 'px';
    popEl.style.left = Math.max(8, Math.min(window.innerWidth / uz - width - 8, r.left / uz)) + 'px';
    popEl.style.maxHeight = Math.min(480, Math.max(100, (below ? window.innerHeight - r.bottom : r.top) / uz - 14)) + 'px';
    if (below) popEl.style.top = (r.bottom / uz + 6) + 'px';
    else popEl.style.bottom = ((window.innerHeight - r.top) / uz + 6) + 'px';
    popEl.addEventListener('click', e => e.stopPropagation());
    libraryCards(); btn.setAttribute('aria-expanded', 'true'); popEl.querySelector('input').focus();
    document.addEventListener('click', outsidePop);
    window.addEventListener('resize', closePop);
  }

  function uiZoom() {
    if (typeof U !== 'undefined' && U.uiZoom) return U.uiZoom();
    return parseFloat(document.body.style.zoom) || 1;
  }

  /* ================= drag between rails ================= */
  let drag = null;
  function startDrag(e, id) {
    if (e.button !== 0 || e.currentTarget?.classList.contains('wg-preview')) return;
    // engage only after a small move so an idle click never grows a ghost
    const sx = e.clientX, sy = e.clientY;
    const arm = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      window.removeEventListener('pointermove', arm);
      engage(ev, id);
    };
    const disarm = () => { window.removeEventListener('pointermove', arm); window.removeEventListener('pointercancel', disarm); };
    window.addEventListener('pointermove', arm);
    window.addEventListener('pointerup', disarm, { once: true });
    window.addEventListener('pointercancel', disarm, { once: true });
  }
  function engage(e, id) {
    closePop();
    const ghost = makeWidget(id);
    ghost.classList.add('wg-drag');
    document.body.appendChild(ghost);
    const caret = document.createElement('i'); caret.className = 'wg-caret';
    drag = { id, ghost, caret, hot: null, x: 0 };
    for (const r of ['top', 'bot']) { const el = railEl(r); if (el) el.classList.add('wg-armed'); }
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop, { once: true });
    window.addEventListener('pointercancel', cancelDrag, { once: true });
  }
  function hitRail(x, y) {
    for (const r of ['top', 'bot']) {
      const el = railEl(r); if (!el) continue;
      const bar = el.parentElement.getBoundingClientRect();   // the whole bar is a generous target
      if (x >= bar.left && x <= bar.right && y >= bar.top - 6 && y <= bar.bottom + 6) return r;
    }
    return null;
  }
  function insertIndex(rail, x) {
    const kids = Array.from(railEl(rail).querySelectorAll('.wg')).filter(k => k.dataset.wg !== drag.id);
    for (let i = 0; i < kids.length; i++) {
      const b = kids[i].getBoundingClientRect();
      if (x < b.left + b.width / 2) return i;
    }
    return kids.length;
  }
  function move(e) {
    if (!drag) return;
    drag.ghost.style.left = (e.clientX / uiZoom() - 40) + 'px';
    drag.ghost.style.top = (e.clientY / uiZoom() - 14) + 'px';
    const hot = hitRail(e.clientX, e.clientY);
    for (const r of ['top', 'bot']) { const el = railEl(r); if (el) el.classList.toggle('wg-hot', r === hot); }
    if (drag.caret.parentElement) drag.caret.remove();
    if (hot) {
      const rail = railEl(hot);
      const kids = Array.from(rail.querySelectorAll('.wg')).filter(k => k.dataset.wg !== drag.id);
      const idx = insertIndex(hot, e.clientX);
      if (idx >= kids.length) rail.insertBefore(drag.caret, rail.querySelector('.wg-add'));
      else rail.insertBefore(drag.caret, kids[idx]);
    }
    drag.hot = hot; drag.x = e.clientX;
  }
  function drop() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', drop);
    window.removeEventListener('pointercancel', cancelDrag);
    if (!drag) return;
    const { id, hot, x } = drag;
    if (hot) {
      const idx = insertIndex(hot, x);
      layout.top = layout.top.filter(i => i !== id);
      layout.bot = layout.bot.filter(i => i !== id);
      layout[hot].splice(idx, 0, id);
    }
    drag.ghost.remove();
    if (drag.caret.parentElement) drag.caret.remove();
    for (const r of ['top', 'bot']) { const el = railEl(r); if (el) el.classList.remove('wg-armed', 'wg-hot'); }
    drag = null;
    render();
  }
  function cancelDrag() { if (drag) drag.hot = null; drop(); }

  /* ================= data wiring (poll + live fold, topbar.js pattern) ================= */
  // GATE THE RAIL POLLERS ON GAME-ENTRY. The intervals arm at DOMContentLoaded, but the rails live in the
  // #topbar/#bottombar chrome of screen-game — before the player leaves the title/connect screen there is no
  // rail on screen and every /api/insights|/api/cron|/api/widgets poll is pure waste. Reuse the SAME entry
  // signal app.js already gates on (`screen-game` has the `.active` class — app.js: "hidden screens have no
  // geometry"): no new signal invented. Node has no DOM, so the pure-fold tests read this as "not entered"
  // and never poll (init itself is already DOM-guarded).
  function gameEntered() {
    if (typeof document === 'undefined') return false;
    const g = document.getElementById('screen-game');
    return !!(g && g.classList.contains('active'));
  }
  function pollInsights() {
    if (!gameEntered()) return;
    if (![...layout.top, ...layout.bot].some(id => id === 'runs24' || id === 'tokens')) return;
    if (insightsRequest) return insightsRequest;
    insightsRequest = fetch('/api/insights', { cache: 'no-store', signal: U.timeoutSignal(10000) })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(st => { if (st) { insights = st; liveRunEnds = 0; pollFail.insights = false; paintAll(); } else { pollFail.insights = true; paintAll(); } })
      .catch(() => { pollFail.insights = true; paintAll(); })
      .finally(() => { insightsRequest = null; });
    return insightsRequest;
  }
  function foldCron(q) {
    if (q && q.hasData && q.data && Array.isArray(q.data.jobs)) cron = q.data;
    pollFail.cron = !!(q && q.error);
    paintAll();
  }
  function startCron() {
    if (stopCron || !gameEntered() || typeof QuerySpine === 'undefined' || !QuerySpine.subscribe) return;
    try { stopCron = QuerySpine.subscribe('cron', foldCron); } catch (_) { pollFail.cron = true; paintAll(); }
  }
  function pollFeed() {
    if (!gameEntered()) return;
    if (feedRequest) return feedRequest;
    feedRequest = fetch('/api/widgets', { cache: 'no-store', signal: U.timeoutSignal(10000) })
      .then(r => (r && r.ok) ? r.json() : null)
      .then(st => {
        if (!st || !Array.isArray(st.widgets)) throw new Error('Widget feed unavailable');
        const catalogSignature = () => JSON.stringify(Array.from(feed.values(), rec => [rec.slug, rec.label, rec.config?.version || null]));
        const oldCatalog = catalogSignature();
        feed.clear();
        for (const raw of st.widgets) { const rec = sanitizeFeedRecord(raw); if (rec) feed.set(rec.slug, rec); }
        pollFail.feed = false;
        if (oldCatalog !== catalogSignature()) { render(); libraryCards(); }
        paintAll();   // repaints values AND provenance ages
      })
      .catch(() => { pollFail.feed = true; paintAll(); })
      .finally(() => { feedRequest = null; });
    return feedRequest;
  }
  // the shared ticker: every list-widget shows its next line, in step. Text-swap only — no layout motion.
  function tickTicker() {
    if (!gameEntered()) return;   // nothing on screen pre-entry; don't churn the rail
    tickerStep++;
    let any = false;
    for (const rec of feed.values()) if (rec.list.length > 1) { any = true; break; }
    if (any) paintAll();
  }

  function init() {
    if (wired) return;
    wired = true;
    load();
    render();

    if (typeof U !== 'undefined' && U.bus) {
      U.bus.on('agent.run.end', () => { try { liveRunEnds++; paintAll('runs24'); } catch (_) {} });
      U.bus.on('queue.status', p => {
        try {
          if (!p || typeof p.queueId !== 'string') return;
          queueSeen = true;
          queueMap.set(p.queueId, Math.max(0, Number(p.depth) || 0));
          paintAll('queue');
        } catch (_) {}
      });
      U.bus.on('cron.fire', () => { try { paintAll('cron'); } catch (_) {} });
    }

    // Immediate kick + steady cadence. Each poller no-ops until the game is entered (see gameEntered), so on
    // the title screen these are cheap early-returns; the first REAL fetch happens on the catch-up below the
    // moment entry is detected (≤4s), not after a full 30s interval.
    pollInsights(); setInterval(pollInsights, POLL_INSIGHTS_MS);
    startCron();
    pollFeed(); setInterval(pollFeed, POLL_FEED_MS);
    setInterval(tickTicker, TICKER_MS);
    // E3: repaint on a short cadence so an SSE bridge drop surfaces the stale cue promptly (the QUEUE
    // widget is event-driven, so nothing else would repaint it) instead of waiting for the next poll.
    // Also the ENTRY WATCHER: on the not-entered→entered edge, fire a one-shot catch-up of the gated pollers
    // so the rail fills within ≤4s of the player entering (reusing this existing timer — no new interval).
    let lastEntered = gameEntered();
    setInterval(() => {
      try {
        const now = gameEntered();
        if (now && !lastEntered) { pollInsights(); startCron(); pollFeed(); }
        lastEntered = now;
        if (now) paintAll();   // only the live rail needs the stale-cue repaint
      } catch (_) {}
    }, 4000);
  }

  // browser boot only — under node (the pure-fold tests require this file) there is no DOM
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  // read-only dev/verification surface (mirrors topbar.js; inert otherwise)
  return { init, _layout: () => ({ top: layout.top.slice(), bot: layout.bot.slice() }), _paintAll: paintAll,
           _foldRuns: foldRuns, _foldTokens: foldTokens, _fmtCount: fmtCount, _sanitizeLayout: sanitizeLayout,
           _sanitizeFeedRecord: sanitizeFeedRecord, _fmtAge: fmtAge, _FEED_RE: FEED_RE, _pollFeed: pollFeed,
           _staleFor: staleFor, _pollFail: pollFail, _setInsights: (v) => { insights = v; },
           _setFeed: (recs) => { feed.clear(); for (const raw of (recs || [])) { const rec = sanitizeFeedRecord(raw); if (rec) feed.set(rec.slug, rec); } },
           _sparkSvg: sparkSvg, _cronStateLabel: cronStateLabel, _nextRoutine: nextRoutine,
           _commsReadout: commsReadout, _openWidget: openWidget };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Widgets };
