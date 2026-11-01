/* sidecar/tools/builtin/widgets.js — the AGENT-FED WIDGET surface: widget.set.

   The chrome's widget rails (frontend/app/widgets.js) can pin AGENT-FED instruments —
   a small named readout ANY agent keeps fresh (app revenue, AI news, subscriber count…).
   User definitions and this tool's readings share one serialized store. The frontend polls GET /api/widgets and renders each
   record with PROVENANCE ("<agent> · <age>"): the app never asserts the value is true,
   only that this agent reported it at that time — truthful telemetry for external data.

   Pure, sandboxed, no filesystem path-escape surface, no network. Backed by an injected
   store ({get,set,update} — the durable station-scoped store in the sidecar; in-memory in
   tests), the notebook.js pattern. NEVER emits: the frozen shared/events.js contract has
   no widget event, and the poll transport needs none.

   makeWidgetTools({ store, clock, redact }) -> { setTool, list(), register(registry) }
     store  : { get(key) -> value|undefined, set(key, value), update?(key, mutator) }
     clock  : { now() -> ms }   (injected; lint-determinism — no ambient Date.now)
     redact : secret scrub applied to every persisted string (a fed value can carry a
              key/token the agent just saw; it must never persist in cleartext). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).widgets = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY = 'station';          // ONE station-scoped record list (widgets are station chrome, not per-agent)
  const MAX_WIDGETS = 12;         // the rails are small; a fleet of stale gauges is noise, not signal
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
  const LIM = { label: 28, value: 24, sub: 28, listItem: 90, listLen: 5, sparkLen: 24 };
  const TONES = ['ok', 'warn', 'bad'];    // the instrument tint palette — semantic, theme-mapped by the chrome

  const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  // spark: keep only finite numbers, cap the series; <2 points can't draw a line → null
  const cleanSpark = (raw) => {
    if (!Array.isArray(raw)) return null;
    const pts = raw.slice(0, LIM.sparkLen).map(Number).filter(v => isFinite(v));
    return pts.length >= 2 ? pts : null;
  };
  const cleanProgress = (raw) => {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };

  function makeWidgetTools(deps) {
    deps = deps || {};
    const store = deps.store;
    const clock = deps.clock || { now: () => 0 };
    const redact = typeof deps.redact === 'function' ? deps.redact : (x => x);

    const rawList = () => { const v = store.get(KEY); return Array.isArray(v) ? v : []; };
    const listOf = () => rawList().filter(w => w && !w.deleted);
    // P1 SAFE WRITE: serialize through store.update when the host provides it (durable store);
    // plain get->mutate->set for a standalone in-memory store (tests). notebook.js discipline.
    const updateList = (mutator) => {
      if (store && typeof store.update === 'function') return store.update(KEY, cur => mutator(Array.isArray(cur) ? cur : []));
      const next = mutator(rawList());
      if (next !== undefined) store.set(KEY, next);
      return Promise.resolve(next);
    };

    // User-owned definitions live beside their readings, so edit/delete and an in-flight
    // publication are serialized by the SAME durable-store mutex.
    async function configure(args, source) {
      const id = String(args.id || '');
      if (!ID_RE.test(id)) throw new Error('Invalid widget id');
      const label = String(args.label || '').trim(), request = String(args.request || '').trim();
      if (!label || label.length > 28) throw new Error('Give the widget a name (up to 28 characters).');
      if (!request || request.length > 1200) throw new Error('Describe what to display (up to 1200 characters).');
      if (!['metric', 'list', 'trend', 'progress'].includes(args.display)) throw new Error('Choose a display type.');
      if (!source || !['connector', 'servicekey', 'agent'].includes(source.kind) || !source.id || !source.label) throw new Error('Choose a source app.');
      let result;
      await updateList(list => {
        const old = list.find(w => w && w.id === id);
        if (old && !old.config) throw new Error('That widget id is already in use.');
        if (old && old.deleted) throw new Error('This widget was deleted. Create a new widget instead.');
        if (old && args.version == null) {
          if (old.label === trunc(redact(label), 28) && old.config.request === redact(request)
            && old.config.display === args.display && JSON.stringify(old.config.source) === JSON.stringify(source)) { result = old; return list; }
          throw new Error('This widget already exists. Reload before editing it.');
        }
        if (old && args.version !== old.config.version) throw new Error('This widget changed. Reload before editing it.');
        if (!old && args.version != null) throw new Error('This widget no longer exists.');
        if (!old && list.filter(w => w && !w.deleted).length >= MAX_WIDGETS) throw new Error('Remove a widget before adding another.');
        result = { id, label: trunc(redact(label), 28), value: null, sub: null, list: [], spark: null, progress: null,
          agentId: null, runId: null, updatedAt: 0, error: null,
          config: { source, request: redact(request), display: args.display, version: ((old && old.config.version) || 0) + 1,
            createdAt: old ? old.config.createdAt : clock.now() } };
        return list.filter(w => w && w.id !== id).concat([result]);
      });
      return result;
    }
    async function remove(id) {
      if (!ID_RE.test(String(id))) throw new Error('Invalid widget id');
      await updateList(list => {
        const next = list.flatMap(w => w && w.id === id
          ? (w.config ? [{ id, config: { version: w.config.version + 1 }, deleted: true }] : []) : [w]);
        const tombs = next.filter(w => w && w.deleted).slice(-100);
        return next.filter(w => w && !w.deleted).concat(tombs);
      });
    }
    function instruction(id) {
      const w = listOf().find(x => x.id === id);
      if (!w || !w.config) throw new Error('Widget no longer exists.');
      const c = w.config, source = c.source;
      return 'Refresh my saved widget ' + JSON.stringify(w.label) + '.\n'
        + 'Source I selected: ' + JSON.stringify(source) + '\n'
        + 'Information to display: ' + c.request + '\n'
        + 'Display: ' + c.display + '.\n'
        + 'Read current information using that connected app through its existing tools/access. This request authorizes reading and updating this widget only, not modifying the app. '
        + 'Do not substitute another app or invent readings. If details are missing, ask me in this conversation. '
        + 'Publish the result with widget.set using id=' + JSON.stringify(w.id) + ' and version=' + c.version + '. '
        + 'For a metric use value and sub (period/unit); for a list use list; for a trend use value plus a real spark series; for progress use value and a real 0-100 progress. '
        + 'Include sourceUrl when the app supplies a link to the source. If you cannot read it, call widget.set with the same id/version and error explaining why, preserving the last reading. '
        + 'A chat reply alone does not update the widget.';
    }
    /* THE WIDGET'S OWN UPDATE RUN (releases#6, 2026-10-17). A refresh is sent to the agent open in COMMS on the
       widget's own conversation ('widget-' + id, frontend/app/widgets.js openWidgetTask); a scheduled update is a
       routine whose job meta names the widget. widget.get/widget.set ride the NOTEBOOK prop (memory), which an
       interactive run holds only while one is placed and the MEMORY switch is on, so the refresh demanded a tool the
       run did not have and the agent searched for it until stopped. The host grants the two widget tools to the run
       whose purpose IS a configured widget, and to no other run. Returns that widget's id, or null. */
    function updateRunOf(run) {
      run = run || {};
      const stream = String(run.streamId || '');
      const id = String(run.widgetId || (stream.indexOf('widget-') === 0 ? stream.slice(7) : ''));
      if (!ID_RE.test(id)) return null;
      return listOf().some(w => w.id === id && w.config) ? id : null;
    }
    // ...and that run reads and publishes its OWN widget only: the host stamps the id on the tool ctx (widgetScope).
    function assertScope(id, ctx) {
      const own = ctx && ctx.widgetScope ? String(ctx.widgetScope) : '';
      if (own && id !== own) throw new Error('This run updates widget "' + own + '" only; it cannot read or publish widget "' + id + '".');
    }

    const setTool = {
      // NO consent gate: a widget record is a sandboxed local write to the station's OWN chrome
      // (no filesystem reach, no network, no outward effect) — the same trust class as notebook.write.
      name: 'widget.set', capability: 'memory', scope: 'write', requiresConsent: false,
      /* Trimmed 2026-07-26 (tool-schema cost pass; widest tool in the harness at 2,361 B on the wire). This
         text is re-sent on EVERY turn, so it may only carry what CHANGES A DECISION *and* has nowhere better
         to live. The old version narrated value/sub/list/tone/spark/progress/clear one by one — every one of
         which the `schema` below already describes at the point of use, and more precisely (it carries the
         max lengths this prose did not). What survives is what a per-field description structurally cannot
         say: what the instrument IS, the cross-turn freshness contract, the cross-field "only when the data
         has that shape" rule, and SKIP — which has no runtime guard behind it, so it stays spelled out. */
      description: 'Publish or update a small named readout on the station\'s widget rails: a live instrument the Commander can pin ' +
        'on screen (e.g. app revenue, top AI headlines, subscriber count). It always shows YOUR name and the time you set it, ' +
        'so a stale figure is attributable to you: re-set the same id (it overwrites) whenever you have a newer one; a routine ' +
        'is the natural driver. Use tone/spark/progress only when the data genuinely has that shape (a real trend series, a ' +
        'real completion fraction), never as decoration. ' +
        'SKIP: secrets, walls of text, anything you cannot back with a real source when asked.',
      schema: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'string', description: 'Stable slug: lowercase letters/digits/dashes, max 24 chars, e.g. app-revenue.' },
          label: { type: 'string', description: 'Caption, e.g. APP REVENUE (max 28 chars).' },
          value: { type: 'string', description: 'The big figure (max 24 chars), e.g. "$​1,240".' },
          sub: { type: 'string', description: 'Small line beside the value, e.g. today (max 28 chars).' },
          list: { type: 'array', items: { type: 'string' }, description: 'Up to 5 short lines shown as a cycling ticker (headlines), INSTEAD of value.' },
          tone: { type: 'string', enum: ['ok', 'warn', 'bad'], description: 'Tint for the figure (ok = good); omit for neutral.' },
          spark: { type: 'array', items: { type: 'number' }, description: 'Trend series (2-24 numbers, oldest first) drawn as a sparkline.' },
          progress: { type: 'number', description: 'Completion 0-100 drawn as a small bar (a goal or quota).' },
          version: { type: 'integer', description: 'User-configured widget: the exact version from its refresh request (stops an outdated run overwriting a changed widget).' },
          error: { type: 'string', description: 'Configured widget: why its data could not be read (keeps the last reading and its timestamp).' },
          sourceUrl: { type: 'string', description: 'http(s) link from the source app, so the user can inspect the data.' },
          clear: { type: 'boolean', description: 'true = remove this readout from the rails.' }
        }
      },
      run: async (args, ctx) => {
        const id = args && String(args.id || '').toLowerCase().trim();
        // error paths THROW — the registry turns a throw into an isError result the model can react to.
        if (!ID_RE.test(id)) throw new Error('id must be 1-24 chars of lowercase letters/digits/dashes, e.g. "app-revenue"');
        assertScope(id, ctx);
        const aid = (ctx && ctx.agentId) || 'agent';

        if (args.clear === true) {
          const existed = listOf().some(w => w.id === id);
          if (listOf().some(w => w.id === id && w.config)) throw new Error('User-created widgets are removed in the widget library. Report an error instead of deleting one.');
          await remove(id);
          return existed
            ? { content: 'Cleared widget "' + id + '" — it is off the rails now.', summary: 'cleared ' + id }
            : { content: 'No widget "' + id + '" exists — nothing to clear.', summary: 'no-op' };
        }

        const hasValue = args.value !== undefined && args.value !== null && String(args.value).trim() !== '';
        const rawList = Array.isArray(args.list) ? args.list.map(x => String(x)).filter(x => x.trim() !== '') : [];
        if (!hasValue && !rawList.length && !args.error) throw new Error('give a `value` (a short figure) or a `list` (up to 5 lines) — a widget with neither has nothing to show');

        let sourceUrl = null;
        if (args.sourceUrl) {
          try { const url = new URL(String(args.sourceUrl)); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) sourceUrl = trunc(redact(url.href), 1500); } catch (_) {
            // A malformed optional link must not discard an otherwise valid reading.
            sourceUrl = null;
          }
        }

        const rec = {
          id: id,
          label: trunc(redact(String(args.label !== undefined && String(args.label).trim() !== '' ? args.label : id).toUpperCase()), LIM.label),
          value: hasValue ? trunc(redact(String(args.value)), LIM.value) : null,
          sub: (args.sub !== undefined && String(args.sub).trim() !== '') ? trunc(redact(String(args.sub)), LIM.sub) : null,
          list: rawList.slice(0, LIM.listLen).map(x => trunc(redact(x), LIM.listItem)),
          tone: TONES.indexOf(args.tone) >= 0 ? args.tone : null,
          spark: cleanSpark(args.spark),
          progress: cleanProgress(args.progress),
          agentId: aid,
          runId: ctx && ctx.runId ? String(ctx.runId) : null,   // provenance: which run fed it
          updatedAt: clock.now()
        };

        let created = false;
        await updateList(list => {
          const idx = list.findIndex(w => w && w.id === id);
          const old = idx >= 0 ? list[idx] : null;
          if (old && old.deleted) throw new Error('This widget was deleted; do not recreate it.');
          if (old && old.config) {
            if (args.version !== old.config.version) throw new Error('Widget definition changed. Use its latest refresh request.');
            rec.config = old.config; rec.label = old.label; rec.sourceUrl = sourceUrl;
            rec.error = args.error ? trunc(redact(String(args.error)), 300) : null;
            if (rec.error) { const next = list.slice(); next[idx] = Object.assign({}, old, { error: rec.error, errorAt: clock.now() }); return next; }
            const display = old.config.display;
            if (display === 'list' && !rec.list.length) throw new Error('This widget needs a list. Report error if its data is unavailable.');
            if (display !== 'list' && !hasValue) throw new Error('This widget needs a value. Report error if its data is unavailable.');
            if (display === 'trend' && !rec.spark) throw new Error('This trend needs at least two real data points.');
            if (display === 'progress' && rec.progress == null) throw new Error('This progress widget needs a real completion percentage.');
          } else if (args.version != null || args.error) throw new Error('The configured widget no longer exists.');
          if (idx >= 0) { const next = list.slice(); next[idx] = rec; return next; }
          // the cap binds NEW ids only — updating an existing readout must always work
          if (list.filter(w => w && !w.deleted).length >= MAX_WIDGETS) throw new Error('the station already has ' + MAX_WIDGETS + ' widgets — clear one (widget.set {id, clear:true}) before adding another');
          created = true;
          return list.concat([rec]);
        });

        return {
          content: args.error ? 'Recorded the refresh error for widget "' + id + '". Its last reading and timestamp are unchanged.' : (created ? 'Published' : 'Updated') + ' widget "' + rec.label + '" (' + id + '). ' +
            'It shows your name and this timestamp; the Commander can pin it from the rail’s ＋ menu.',
          summary: (created ? 'published ' : 'updated ') + id
        };
      }
    };

    const getTool = {
      name: 'widget.get', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Read the latest user-owned definition and refresh instructions for a saved widget. Call before a scheduled update; if removed, stop without fetching data or recreating it.',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      run: async (args, ctx) => { const id = String(args && args.id || ''); assertScope(id, ctx); return { content: instruction(id), summary: 'widget definition' }; }
    };

    return {
      setTool, getTool, configure, remove, instruction, updateRunOf,
      list: listOf,   // the GET /api/widgets read surface (host route) — same records, no reshaping
      register(reg) { reg.register(setTool); reg.register(getTool); return reg; }
    };
  }

  return { makeWidgetTools, MAX_WIDGETS: MAX_WIDGETS, ID_RE: ID_RE };
});
