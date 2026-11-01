/* sidecar/tools/builtin/toolsearch.js — tool.search: how an agent reaches a DEFERRED tool.

   THE PROBLEM (measured at the wire, not assumed): a fully placed floor advertises 72 tools = 37.7KB of JSON
   schema, and the whole list is re-sent on EVERY turn of a run. The browser family alone is 29 tools / ~10.2KB,
   and an agent needs about six of them to drive a page. That is both a cost problem and a decision problem —
   choosing among 72 tools is strictly harder than choosing among 20.

   THE SPLIT: a grant row in CAP_REGISTRY may carry `deferred: true`. Deferred tools are still GRANTED (they
   stay in resolveTools' `tools`, so the capability gate, consent broker and toolset kill-switch are untouched)
   — they are simply not advertised. This tool is how the model finds them; the loop then adds what it found to
   the advertised set for the rest of the run.

     makeToolSearchTool({ registry }) -> { toolSearchTool, register(reg) }

   ctx supplies `deferred` (this run's hidden tool names) — the search is scoped to what this agent was
   actually granted, so it can never advertise a capability the room does not confer.

   WHY THE RESULT IS DELIBERATELY TERSE: returning full JSON schemas here would hand back exactly the bytes the
   split just saved, twice (once in the tool result, again in the now-advertised declaration). The result
   carries name + purpose + required params only; the real schema arrives with the tool declaration on the very
   next turn, which is where the model actually needs it. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).toolsearch = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_HITS = 8;          // a reveal is cheap, but 20 at once re-inflates the very request we shrank
  const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'how', 'do', 'i',
    'my', 'is', 'it', 'that', 'this', 'can', 'use', 'used', 'get', 'tool', 'tools']);

  function terms(s) {
    const out = String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9_.]+/)
      .filter(t => t && t.length > 1 && !STOP.has(t));
    /* a model searches by the WIRE name it was shown ("station_control"), which is the registry's dotted name with '_'
       for '.' — the search found "no match" for it (Gemini real-model run, 2026-10-08). Each underscored term also
       searches as its dotted twin; the original stays, because some real names have underscores (web_search). */
    for (const t of out.slice()) if (t.indexOf('_') >= 0) { const d = t.replace(/_/g, '.'); if (out.indexOf(d) < 0) out.push(d); }
    return out;
  }

  /* Score a tool against the query. The LEAF of a dotted name ('browser.screenshot' -> 'screenshot') is what
     carries the meaning; the namespace is a weak signal deliberately scored near zero, because a query that
     mentions "browser" or "page" would otherwise match all 22 hidden browser tools equally and hand back the
     whole shelf — undoing the split it exists to serve.
     Pure and deterministic — ties break on name, so the same query always yields the same order (the
     determinism lint forbids clock/random in sidecar/, and a flaky tool list would be untestable). */
  const hay = t => (String(t.name || '') + ' ' + String(t.description || '')).toLowerCase();

  /* Weight each query term by how RARE it is on this shelf (inverse document frequency). A term that appears
     in most of the candidates — 'page', 'browser', 'element', 'current' — says nothing about which tool is
     wanted; one that appears in a couple ('screenshot', 'dropdown', 'upload') says almost everything.
     This is load-bearing, not polish: measured against the real 22 deferred browser tools, unweighted scoring
     answered "go back to the previous page" with browser.eval first and returned 8 tools for a query with one
     obvious answer, because common words accumulated enough weak description hits to clear the floor. */
  /* PHRASES (rc walk 10-14). A lead told to search "station builder" searched "station builder - create assembly lines and
     workflows": "create" is a whole tool NAME (app.create, loop.create), so those outscored every builder tool, whose
     descriptions carry "station builder" only as two weak words — and two of three real runs spent a second search. Two
     adjacent words of the query (neither a stop word) that a description's LEADING LABEL carries word for word score like an
     exact name. The label only — the words before its first ':' when they are a heading of at most four words ("STATION
     BUILDER, step 2"), never a sentence: scored anywhere in a description, "every assembly line" in station.layout's text
     buried the builder for "build an assembly line", and "previous page" revealed the 13 KB station.plan beside browser.back
     (review, measured on the real browser + station shelf: test/toolsearch.phrases-real.test.js). */
  function label(tool) {
    const d = String((tool && tool.description) || '').toLowerCase(), i = d.indexOf(':');
    if (i < 0) return '';
    const head = d.slice(0, i);
    return head.split(/[^a-z0-9_.]+/).filter(Boolean).length <= 4 ? head : '';
  }
  function phrases(s) {
    const words = String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9_.]+/).filter(Boolean), out = [];
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i], b = words[i + 1];
      if (a.length > 1 && b.length > 1 && !STOP.has(a) && !STOP.has(b)) out.push(a + ' ' + b);
    }
    return out;
  }
  /* A NUMBERED FAMILY ("STATION BUILDER, step 3:"): a later step needs what the earlier ones make (station.build builds only
     a plan station.plan made), so a revealed step brings its family's earlier steps with it, and one search is enough. The
     fix round's live run searched "build an assembly line or workflow on the station", got station.build alone, and spent a
     second search (a whole turn of the run's context) on "see the station floor map and plan changes". */
  function stepOf(tool) {
    const m = /^(.+?),\s*step\s+(\d+)\s*$/.exec(label(tool));
    return m ? { family: m[1].trim(), n: Number(m[2]) } : null;
  }
  function withEarlierSteps(hits, pool) {
    const out = hits.slice(), has = new Set(hits.map(h => h.t.name));
    for (const h of hits) {
      const s = stepOf(h.t);
      if (!s) continue;
      for (const t of pool) {
        const o = stepOf(t);
        if (o && o.family === s.family && o.n < s.n && !has.has(t.name)) { has.add(t.name); out.push({ t, s: 0 }); }
      }
    }
    return out;
  }
  function weigh(pool, qs, query) {
    const out = [];
    for (const q of qs) {
      let df = 0;
      for (const t of pool) if (hay(t).indexOf(q) >= 0) df++;
      // Absent from the shelf, or present on ALL of it — either way it cannot discriminate.
      out.push({ q, w: (!df || df >= pool.length) ? 0 : Math.log(pool.length / df) });
    }
    // a phrase weighs what its two words weigh; one no tool (or every tool) carries cannot discriminate either
    out.phrases = phrases(query).map(p => {
      let df = 0;
      for (const t of pool) if (label(t).indexOf(p) >= 0) df++;
      const [a, b] = p.split(' '), wa = (out.find(x => x.q === a) || {}).w || 0, wb = (out.find(x => x.q === b) || {}).w || 0;
      return { p, w: (!df || df >= pool.length) ? 0 : wa + wb };
    }).filter(x => x.w);
    return out;
  }

  function score(tool, weighted) {
    const full = String(tool.name || '').toLowerCase();
    const leaf = full.slice(full.lastIndexOf('.') + 1);
    const desc = String(tool.description || '').toLowerCase();
    let s = 0;
    for (const { q, w } of weighted) {
      if (!w) continue;
      let base = 0;
      if (leaf === q || full === q) base = 100;
      else if (leaf.indexOf(q) >= 0) base = 30;
      else if (full.indexOf(q) >= 0) base = 5;   // namespace-only hit
      if (desc.indexOf(q) >= 0) base += 4;
      s += base * w;
    }
    const head = (weighted.phrases || []).length ? label(tool) : '';
    for (const { p, w } of weighted.phrases || []) if (head.indexOf(p) >= 0) s += 100 * w;
    return s;
  }

  function required(tool) {
    const r = tool && tool.schema && Array.isArray(tool.schema.required) ? tool.schema.required : [];
    return r.length ? '(' + r.join(', ') + ')' : '()';
  }

  // First sentence of the description — enough to choose between two candidates, far short of the full schema.
  function gist(tool) {
    const d = String((tool && tool.description) || '').trim();
    const cut = d.search(/\.\s/);
    const one = cut > 0 ? d.slice(0, cut + 1) : d;
    return one.length > 160 ? one.slice(0, 157) + '…' : one;
  }

  /* CONNECTOR DEFERRAL PLAN (w2 footprint, 2026-09-22). An MCP connector's tools used to ride EVERY request in
     full: a big server (40 tools of JSON schema) cost more per turn than the whole CAP_REGISTRY browser shelf
     this file was built to defer. Past a footprint threshold the LARGEST servers are deferred whole — a server
     is one line in the prompt index, so it is all-or-nothing — until what is still advertised fits. Small
     servers stay advertised: below the threshold nothing changes at all.

       planConnectorDeferral([{ name, server, bytes }], { maxBytes, maxTools })
         -> { deferred: [name], servers: [{ id, count, bytes }], totalBytes, totalTools }

     A limit of 0 (or absent) switches that axis off; both off never defers. Pure and deterministic — ties
     break on server id, so the same connector set always yields the same advertised list (and the same cached
     prompt prefix). */
  function planConnectorDeferral(entries, opts) {
    opts = opts || {};
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 0;
    const maxTools = Number(opts.maxTools) > 0 ? Number(opts.maxTools) : 0;
    const groups = new Map();
    let bytes = 0, tools = 0;
    for (const e of (entries || [])) {
      if (!e || !e.name) continue;
      const id = String(e.server || 'mcp');
      if (!groups.has(id)) groups.set(id, { id, count: 0, bytes: 0, names: [] });
      const g = groups.get(id);
      const b = Number(e.bytes) > 0 ? Number(e.bytes) : 0;
      g.count++; g.bytes += b; g.names.push(String(e.name));
      tools++; bytes += b;
    }
    const plan = { deferred: [], servers: [], totalBytes: bytes, totalTools: tools };
    const over = () => (maxBytes > 0 && bytes > maxBytes) || (maxTools > 0 && tools > maxTools);
    if (!over()) return plan;
    const order = Array.from(groups.values())
      .sort((a, b) => (b.bytes - a.bytes) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const g of order) {
      if (!over()) break;
      plan.deferred.push(...g.names);
      plan.servers.push({ id: g.id, count: g.count, bytes: g.bytes });
      bytes -= g.bytes; tools -= g.count;
    }
    plan.servers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return plan;
  }

  /* The one-line prompt index that stands in for the deferred servers' schemas: server + tool count, and the
     way in. Names the SERVER, not every tool — the measured failure this guards against is a model that never
     learns a capability exists; a server name is what a Commander's request actually mentions ("my github").
     Empty for no servers, so a run below the threshold carries no new bytes. */
  function connectorIndexLine(servers) {
    const list = (servers || []).filter(s => s && s.id);
    if (!list.length) return '';
    return 'Connector tools not loaded yet (they exist and you CAN use them): '
      + list.map(s => s.id + ' (' + s.count + ' tool' + (s.count === 1 ? '' : 's') + ')').join(', ') + '. '
      + 'To use one, call tool_search with the service and what you want done ("' + list[0].id + ' search", '
      + '"create an issue") and the matching tools become callable immediately. ';
  }

  /* WITHHELD MATCHES (issue #77). ctx.withheld (name -> { why, enable }) holds tools this agent's floor grants but the
     run authority removed from THIS run — shell.exec on a delegated ASK-mode worker. They are never revealed (the gate
     would refuse them), so they stay out of the deferred pool and its IDF scoring, which is byte-identical with or
     without them. A query that names one (a query term inside a withheld tool's name) or asks for commands in plain words —
     gets ONE note listing every withheld tool (they share one cause on a run), why, and what works instead. Before,
     "run a shell command" answered with an unrelated browser tool and the worker reported the shell as gone. */
  const COMMAND_WORDS = /\b(?:shell|command|commands|cmd|terminal|bash|powershell|exec|execute|script|run)\b/i;
  function withheldNote(q, ctx) {
    const withheld = (ctx && ctx.withheld && typeof ctx.withheld === 'object') ? ctx.withheld : null;
    const names = withheld ? Object.keys(withheld).sort() : [];
    if (!names.length) return '';
    const qs = terms(q);
    const hit = COMMAND_WORDS.test(String(q)) || names.some(n => qs.some(w => String(n).toLowerCase().indexOf(w) >= 0));
    if (!hit) return '';
    const first = withheld[names[0]] || {};
    return 'WITHHELD on this run (these exist on this station, but you cannot call them here): ' + names.join(', ')
      + '. Why: ' + first.why + '. What works instead: ' + first.enable + '.';
  }

  /* RUN-POLICY WITHHOLDING (direct-domain). ctx.policyWithheld ({ names, why, enable }) lists GRANTED tools this run's
     own policy keeps off the wire — web_search and delegation on a bounded one-host check. The host already removed
     them from ctx.deferred, so they can never be offered as "Now available"; this is only the explanation, kept apart
     from ctx.withheld (issue #77) because the two have different causes and withheldNote prints ONE cause for all. */
  const POLICY_WORDS = /\b(?:search|google|bing|web|delegate|delegation|team|teammate|worker|dispatch)\b/i;
  function policyNote(q, ctx) {
    const p = (ctx && ctx.policyWithheld && typeof ctx.policyWithheld === 'object') ? ctx.policyWithheld : null;
    const names = p && Array.isArray(p.names) ? p.names.slice().sort() : [];
    if (!names.length) return '';
    const qs = terms(q);
    const hit = POLICY_WORDS.test(String(q)) || names.some(n => qs.some(w => String(n).toLowerCase().indexOf(w) >= 0));
    if (!hit) return '';
    return 'WITHHELD on this run (granted, but this run\'s policy keeps them off): ' + names.join(', ')
      + '. Why: ' + p.why + '. What works instead: ' + p.enable + '.';
  }

  /* ALREADY LISTED. ctx.advertised names what this run already sends the model. Those tools are never in the hidden
     pool, so a model that missed one in its list ("browser navigate read text") was answered with the nearest HIDDEN
     tool — browser.test_navigate, which only opens localhost — as if that were the way to browse. Listed and hidden
     tools are ranked TOGETHER here: listed ones in the same league as the best match are named first, as callable
     now, and a hidden one that only clears the floor against the hidden shelf (but not against the listed tools) is
     not revealed. Absent ctx.advertised (or no listed match): { note: '', keep: null } and the search is unchanged. */
  const MAX_LISTED = 4;
  function listedMatch(q, ctx, registry, pool) {
    const none = { note: '', keep: null };
    const listed = (ctx && Array.isArray(ctx.advertised)) ? ctx.advertised : [];
    if (!listed.length || !registry || typeof registry.get !== 'function') return none;
    const hidden = new Set(pool.map(t => t.name));
    const shown = [];
    for (const n of listed) {
      if (n === 'tool.search' || hidden.has(n)) continue;
      const t = registry.get(n);
      if (t) shown.push(t);
    }
    if (!shown.length) return none;
    const all = pool.concat(shown);
    const weighted = weigh(all, terms(q), q);
    let best = 0;
    for (const t of all) best = Math.max(best, score(t, weighted));
    if (!best) return none;
    const hits = shown
      .map(t => ({ t, s: score(t, weighted) }))
      .filter(h => h.s > 0 && h.s * 3 >= best)
      .sort((a, b) => (b.s - a.s) || (a.t.name < b.t.name ? -1 : a.t.name > b.t.name ? 1 : 0))
      .slice(0, MAX_LISTED);
    if (!hits.length) return none;
    return {
      note: 'Already in your tool list (call it directly — no search needed):\n'
        + hits.map(h => '· ' + h.t.name + ' ' + required(h.t) + ' — ' + gist(h.t)).join('\n'),
      keep: t => score(t, weighted) * 3 >= best
    };
  }

  function makeToolSearchTool(deps) {
    const registry = (deps || {}).registry;

    const toolSearchTool = {
      name: 'tool.search', capability: 'toolsearch', scope: 'read', requiresConsent: false,
      description: 'Find a tool you do not currently have. Your tool list shows the common ones; the rest of ' +
        'what you have been granted (extra browser controls: screenshots, tabs, network, file upload, form ' +
        'selects, element inspection; UI test controls; other specialist tools) is hidden until you look ' +
        'it up. Search BEFORE concluding you cannot do something: describe the capability you want ("take a ' +
        'screenshot", "upload a file", "read network responses") and anything that matches becomes callable ' +
        'immediately, for the rest of this run. Returns names and what each is for; the ' +
        'schema arrives with the tool itself on your next turn.',
      schema: {
        type: 'object', required: ['query'],
        properties: { query: { type: 'string', description: 'The capability you are looking for, in your own words.' } }
      },
      run: async (args, ctx) => {
        const q = args && args.query != null ? String(args.query) : '';
        const names = (ctx && Array.isArray(ctx.deferred)) ? ctx.deferred : [];
        const blocked = q.trim() ? [withheldNote(q, ctx), policyNote(q, ctx)].filter(Boolean).join('\n') : '';
        const pool = [];
        for (const n of names) {
          const t = registry && typeof registry.get === 'function' ? registry.get(n) : null;
          if (t) pool.push(t);
        }
        const match = q.trim() ? listedMatch(q, ctx, registry, pool) : { note: '', keep: null };
        const listed = match.note;
        if (!names.length) {
          if (blocked || listed) return { content: [blocked, listed].filter(Boolean).join('\n'), summary: blocked ? 'withheld' : 'already listed' };
          return { content: 'Every tool you have been granted is already listed — there is nothing further to find.', summary: 'none hidden' };
        }
        if (!q.trim()) return { content: 'Provide a `query` describing the capability you want.', summary: 'no query' };

        const weighted = weigh(pool, terms(q), q);
        const scored = pool
          .map(t => ({ t, s: score(t, weighted) }))
          .filter(h => h.s > 0)
          .sort((a, b) => (b.s - a.s) || (a.t.name < b.t.name ? -1 : a.t.name > b.t.name ? 1 : 0));
        // RELEVANCE FLOOR: keep only what is in the same league as the best hit. A stray word shared with a
        // sibling's description otherwise drags the family along, quietly re-advertising on the first search
        // the very set the deferral exists to withhold.
        const best = scored.length ? scored[0].s : 0;
        const hits = withEarlierSteps(scored.filter(h => h.s * 3 >= best && (!match.keep || match.keep(h.t))).slice(0, MAX_HITS), pool);

        if (!hits.length && (blocked || listed)) return { content: [blocked, listed].filter(Boolean).join('\n'), summary: blocked ? 'withheld' : 'already listed' };
        if (!hits.length) {
          // Name the shelf rather than dead-ending: a miss usually means wrong vocabulary, not absent capability.
          const sample = pool.map(t => t.name).sort().slice(0, 12).join(', ');
          return {
            content: 'No hidden tool matched "' + q + '". Available to find: ' + sample +
              (pool.length > 12 ? ', … (' + pool.length + ' total)' : '') + '.',
            summary: 'no match'
          };
        }

        /* A tool the host PROVED cannot work this run (ctx.unavailable: name -> { why, enable }) is still found and
           still revealed — the Commander may fix it mid-run — but its line says so, with the fix, so the model
           reports the missing setup instead of calling it blind or claiming it worked. Absent map: unchanged. */
        const unavailable = (ctx && ctx.unavailable && typeof ctx.unavailable === 'object') ? ctx.unavailable : null;
        const caveat = n => {
          const u = unavailable && Object.prototype.hasOwnProperty.call(unavailable, n) ? unavailable[n] : null;
          return u ? ' [NOT USABLE RIGHT NOW: ' + u.why + '. To enable: ' + u.enable + '.]' : '';
        };
        const lines = hits.map(h => '· ' + h.t.name + ' ' + required(h.t) + ' — ' + gist(h.t) + caveat(h.t.name));
        return {
          content: (blocked ? blocked + '\n' : '') + (listed ? listed + '\n' : '') + 'Now available to call for the rest of this run:\n' + lines.join('\n'),
          summary: hits.length + ' revealed',
          // The loop reads this and adds these tools to the advertised set. Names only — the loop owns
          // turning them into wire declarations, so this tool never has to know the provider format.
          control: { revealTools: hits.map(h => h.t.name) }
        };
      }
    };

    return {
      toolSearchTool,
      register(reg) { reg.register(toolSearchTool); return toolSearchTool; }
    };
  }

  return { makeToolSearchTool, planConnectorDeferral, connectorIndexLine };
});
