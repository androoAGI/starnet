/* sidecar/tools/builtin/connectors.js — `connectors.list`: the agent's readout of the station's INTEGRATIONS.

   WHY THIS EXISTS (a measured truthful-telemetry gap, not a nice-to-have). Three things were true at once:
     1. CONFIGURED service keys already ride the prompt (servicekeys.promptBlock — names only, never values).
     2. INSTALLED connectors already project their tools straight into the run's tool list (mcp/manager.js).
     3. Nothing ever told the agent about the integrations that are ONE CLICK AWAY but not yet added.
   So an agent asked "what is this harness missing?" answered with things the Commander could have had in
   thirty seconds — GitHub, Notion, Stripe, Google Workspace — because from inside the run they were
   indistinguishable from unbuildable. That is the station lying by omission about its own reach.

   This tool closes (3) ONLY. It is a READER: pure local state, no network, no consent, and it can neither
   install nor authenticate anything. Adding a connector spends the Commander's credentials and is their
   click, in ABILITIES › DISCOVER › CATALOG (a card per service) — the agent's job is to know the offer exists and say so.

   NEVER ECHOES A SECRET. Connector summaries carry `hasToken`, never the token (mcp/manager.js summary());
   service keys are reported as NAME + ENV VAR only, exactly like the prompt block. There is no code path
   here that reads a key's value.

   capability 'web' on the `dish` object — the same grant as web_request, which is the route an agent
   actually SPENDS a service key through. A station with no dish can neither call an API nor drive a
   connector, so advertising the catalog there would teach a reach the run does not have.

   makeConnectorTools({ connectors?, serviceKeys?, connectorCatalog?, keysCatalog?, signInUnavailable? }) -> { listTool, register(reg), _internals }
     connectors        : the live manager — { list() -> summary[] }        (omit → "none connected")
     serviceKeys       : () -> record[] (the raw KEYS list; only name/envVar/enabled/autonomous/docsUrl are read)
     connectorCatalog  : mcp/catalog.js      — { browse(installed) -> { connectors:[{id,name,category,authType,installed,blurb,via}] } }
     keysCatalog       : servicekeys-catalog — { PLATFORMS:[{id,name,category,envVar,docsUrl}] }
     signInUnavailable : (catalogEntry) -> '' | reason — the SAME availability the ABILITIES card shows (index.js
                         annotateConnectorAvailability). A card whose sign-in button is disabled is never offered as a door.
   Every dep is optional: a missing one degrades that SECTION to silence, never to a fake empty answer. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).connectors = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCOPES = ['all', 'connected', 'available'];
  const MAX_AVAILABLE = 40;      // the catalogs are curated and small; this is a runaway guard, not a policy
  const MAX_CHARS = 6000;        // a tool result is re-read by the model every turn — stay cheap

  const str = v => String(v == null ? '' : v).trim();
  const low = v => str(v).toLowerCase();

  // Does this row match the agent's free-text filter? Matched over the fields a human would name it by.
  function matches(q, ...fields) {
    if (!q) return true;
    const hay = fields.map(low).join(' ');
    return q.split(/\s+/).filter(Boolean).every(term => hay.indexOf(term) >= 0);
  }

  /* GOAL -> CONNECTOR (beginner seam Lane 1, `suggestFor`). A newcomer with NOTHING wired never triggers a
     tool-call throw, so the only way the station can say "you need Gmail for that" is to read the GOAL. The
     goal's words are expanded through a tiny topic table (the words people use for a thing -> the words the
     catalog names it by) and matched against each catalog entry's id/name/aliases — the SAME alias list the
     ABILITIES search and the catalog card already match on. Pure + bounded; never a fabricated match. */
  const GOAL_TOPICS = {
    email: ['email', 'e-mail', 'emails', 'mail', 'gmail', 'inbox', 'newsletter', 'newsletters', 'subscribers', 'outreach'],
    calendar: ['calendar', 'schedule', 'meeting', 'meetings', 'appointment', 'appointments', 'invite', 'invites'],
    docs: ['doc', 'docs', 'document', 'documents', 'google docs'],
    sheets: ['sheet', 'sheets', 'spreadsheet', 'spreadsheets'],
    drive: ['drive', 'google drive', 'gdrive'],
    site: ['site', 'website', 'web page', 'webpage', 'landing page', 'blog', 'webflow', 'wix', 'wordpress'],
    notion: ['notion'], github: ['github', 'repo', 'repository', 'pull request'], slack: ['slack'],
    stripe: ['stripe', 'payment', 'payments', 'invoice', 'invoices'], shopify: ['shopify', 'store', 'storefront']
  };
  function goalTopics(goal) {
    const g = ' ' + low(goal).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    const out = [];
    for (const topic of Object.keys(GOAL_TOPICS)) {
      if (GOAL_TOPICS[topic].some(w => g.indexOf(' ' + w + ' ') >= 0)) out.push(topic);
    }
    return out;
  }
  // score a catalog entry against the goal's topics: a topic word on the entry's id/name/aliases is a hit;
  // an entry whose id/name IS the topic word (gmail for email) outranks an aggregator that merely lists it.
  function entryScore(e, topics) {
    const names = [e.id, e.name].concat(Array.isArray(e.aliases) ? e.aliases : []).map(low).filter(Boolean);
    let score = 0;
    for (const t of topics) { if (names.indexOf(t) >= 0) score += 2; if (low(e.id) === t || low(e.name) === t || GOAL_TOPICS[t].indexOf(low(e.id)) >= 0) score += 1; }
    return score;
  }

  // A live connector, rendered honestly: state comes from the manager's real handshake, never from the catalog.
  function connectedLine(c) {
    const name = str(c.label) || str(c.id);
    const state = str(c.state) || 'unknown';
    const bits = [];
    if (c.enabled === false) bits.push('disabled');
    bits.push(state === 'up' ? (c.toolCount || 0) + ' tools' : state + (c.detail ? ': ' + str(c.detail).slice(0, 120) : ''));
    if (c.oauth) bits.push('oauth');
    if (c.account && c.account.email) bits.push('account at last sign-in: ' + str(c.account.email));
    return '- ' + str(c.id) + (name && name !== str(c.id) ? ' (' + name + ')' : '') + ' — ' + bits.join(', ');
  }

  function makeConnectorTools(deps) {
    deps = deps || {};
    const mgr = deps.connectors || null;
    const keysOf = typeof deps.serviceKeys === 'function' ? deps.serviceKeys : null;
    const mcpCatalog = deps.connectorCatalog || null;
    const keyCatalog = deps.keysCatalog || null;
    const unavailableOf = e => { if (typeof deps.signInUnavailable !== 'function') return ''; try { return str(deps.signInUnavailable(e)); } catch (_) { return ''; } };

    // ---- the three sections, each independently fail-open (a thrown dep degrades to a silent section) ----

    function sectionConnected(q) {
      if (!mgr || typeof mgr.list !== 'function') return null;
      let rows = [];
      try { rows = mgr.list() || []; } catch (_) { return null; }
      rows = rows.filter(c => c && matches(q, c.id, c.label));
      if (!rows.length) return { label: 'connected', count: 0, head: 'CONNECTED (0)', body: ['(no MCP connectors added yet)'] };
      return {
        label: 'connected', count: rows.length,
        head: 'CONNECTED (' + rows.length + ') — normal COMMS runs receive enabled connector tools; routed rooms and unattended tasks follow their own effective access. Account identity is not verified by this list.',
        body: rows.map(connectedLine)
      };
    }

    function sectionKeys(q) {
      if (!keysOf) return null;
      let rows = [];
      try { rows = keysOf() || []; } catch (_) { return null; }
      // Mirror promptBlock's filter: enabled rows that actually hold a key. `key` is only ever TESTED for
      // presence here — its value is never read into the output.
      rows = rows.filter(r => r && r.enabled !== false && r.envVar && r.key && matches(q, r.name, r.envVar));
      if (!rows.length) return { label: 'keys', count: 0, head: 'KEYS (0)', body: ['(no platform API keys connected yet)'] };
      return {
        label: 'keys', count: rows.length,
        head: 'KEYS (' + rows.length + ') — spend these with web_request by writing ${ENV_VAR} in a header; you never see the value',
        body: rows.slice().sort((a, b) => str(a.name).localeCompare(str(b.name))).map(r =>
          '- ' + str(r.name) + ': ${' + str(r.envVar) + '}'
          + (r.autonomous === true ? '' : ' [watched sessions only]')
          + (r.docsUrl ? ' — ' + str(r.docsUrl) : ''))
      };
    }

    /* The point of the whole tool: what the Commander could add but has not. Two catalogs, one list.
       An MCP row is only reported as available when it is NOT installed; a KEYS row only when its env var
       is not already connected — otherwise this would nag the Commander to add what they already have. */
    function sectionAvailable(q) {
      // NO catalog wired at all = we cannot see the offer, which is NOT the same as "there is nothing to add".
      // Returning a confident AVAILABLE (0) here would be the exact lie this tool was built to end.
      if (!mcpCatalog && !keyCatalog) return null;
      const out = [];
      let haveEnv = new Set();
      if (keysOf) { try { for (const r of (keysOf() || [])) { if (r && r.envVar && r.enabled !== false && r.key) haveEnv.add(str(r.envVar)); } } catch (_) {} }

      if (mcpCatalog && typeof mcpCatalog.browse === 'function') {
        let installed = [];
        if (mgr && typeof mgr.list === 'function') { try { installed = (mgr.list() || []).map(c => c && { id: str(c.id), url: '' }); } catch (_) {} }
        let entries = [];
        try { entries = (mcpCatalog.browse(installed) || {}).connectors || []; } catch (_) { entries = []; }
        for (const e of entries) {
          if (!e || e.installed) continue;
          if (!matches(q, e.id, e.name, e.category, e.blurb)) continue;
          const auth = e.authType === 'none' ? 'no credentials' : e.authType === 'oauth' ? 'sign-in' : 'api key';
          const off = unavailableOf(e);
          out.push('- ' + str(e.name) + ' [' + str(e.category) + '] — connector, ' + auth
            + (e.via ? ' via ' + str(e.via) : '') + (off ? ' — SIGN-IN NOT AVAILABLE in this build: ' + off.slice(0, 160) : (e.blurb ? '. ' + str(e.blurb).slice(0, 140) : '')));
        }
      }

      if (keyCatalog && Array.isArray(keyCatalog.PLATFORMS)) {
        for (const p of keyCatalog.PLATFORMS) {
          if (!p || haveEnv.has(str(p.envVar))) continue;
          if (!matches(q, p.id, p.name, p.category, p.blurb)) continue;
          out.push('- ' + str(p.name) + ' [' + str(p.category) + '] — API key (' + str(p.envVar) + ')'
            + (p.docsUrl ? ', docs ' + str(p.docsUrl) : ''));
        }
      }

      if (!out.length) return { label: 'available', count: 0, head: 'AVAILABLE (0)', body: ['(nothing left in the catalogs matches)'] };
      const shown = out.slice(0, MAX_AVAILABLE);
      // The count is the REAL total, not the shown slice — a truncated list that reports its own length as the
      // total would understate the offer, which is the failure this tool exists to fix.
      const head = 'AVAILABLE (' + out.length + ')' + (shown.length < out.length ? ', showing ' + shown.length : '')
        + ' — NOT installed. The Commander adds either kind in ABILITIES › DISCOVER › CATALOG: search the service and follow its card (sign-in, or SET UP API KEY). You cannot add these yourself; offer, never assume.';
      return { label: 'available', count: out.length, head: head, body: shown };
    }

    /* suggestFor(goal) -> [{ id, reason, unavailable }] (<=3 connectable, then <=3 unavailable): catalog entries that fit the goal AND are NOT connected
       per the host's own read-back (the manager's list — a configured-but-dead connector is still "not connected",
       and one that is up is never suggested). [] when no catalog, no topic, or everything needed is wired.
       `unavailable` is the card's own reason its sign-in is disabled in this build ('' when it can be connected). */
    function suggestFor(goal) {
      const topics = goalTopics(goal);
      if (!topics.length || !mcpCatalog || typeof mcpCatalog.browse !== 'function') return [];
      const up = new Set();
      const installed = [];
      if (mgr && typeof mgr.list === 'function') {
        // a failed read-back means "not connected" cannot be PROVEN for anything — suggest nothing rather than guess.
        try { for (const c of (mgr.list() || [])) { if (!c) continue; installed.push({ id: str(c.id), url: '' }); if (c.state === 'up') up.add(str(c.id)); } }
        catch (e) { return []; }
      }
      let entries = [];
      try { entries = (mcpCatalog.browse(installed) || {}).connectors || []; } catch (_) { entries = []; }
      const scored = [];
      for (const e of entries) {
        if (!e || !e.id || up.has(str(e.id))) continue;
        const score = entryScore(e, topics);
        if (score > 0) scored.push({ id: str(e.id), score: score, unavailable: unavailableOf(e) });
      }
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      // fill the 3 slots with CONNECTABLE fits first: a card whose sign-in is off must not push a working door out;
      // the blocked ones still ride along (up to 3) so the model can say plainly they are not available yet.
      const pick = scored.filter(x => !x.unavailable).slice(0, 3).concat(scored.filter(x => x.unavailable).slice(0, 3));
      return pick.map(x => ({ id: x.id, reason: 'needed for: ' + str(goal).slice(0, 120), unavailable: x.unavailable }));
    }

    const listTool = {
      name: 'connectors.list', capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: 8000,
      description: 'List the station\'s INTEGRATIONS: MCP connectors already connected, platform API keys already '
        + 'connected, and — the part you cannot otherwise know — the vetted connectors and platform keys the '
        + 'Commander could add but has not (GitHub, Notion, Stripe, Google Workspace, Printify, Etsy and more). '
        + 'Check this BEFORE telling the Commander that Agent OS cannot reach a service: it usually can, and the '
        + 'honest answer is "that service has a setup path in ABILITIES › DISCOVER › CATALOG — I can walk you through '
        + 'it?". Read-only: you cannot install or authenticate anything, and you never see a key\'s value. '
        + 'Optional `query` filters by service or category; `scope` narrows to connected or available. '
        + 'Pass `goal` (the Commander\'s task in their words, e.g. "email my notes to myself") to get SUGGESTED: '
        + 'the not-yet-connected connector(s) that task needs — the station then offers the Commander a one-click '
        + 'door to connect it. Call it with `goal` BEFORE declining a task for lack of email/site/calendar/docs access.',
      schema: {
        type: 'object', properties: {
          scope: { type: 'string', enum: SCOPES, description: 'all (default), connected (what is live now), or available (what could be added)' },
          query: { type: 'string', description: 'filter by name, id, or category — e.g. "github", "payments"' },
          goal: { type: 'string', description: 'the task in the Commander\'s words — returns SUGGESTED: the unconnected connector(s) it needs' }
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const scope = SCOPES.indexOf(low(args.scope)) >= 0 ? low(args.scope) : 'all';
        const q = low(args.query);
        const goal = str(args.goal).slice(0, 300);

        const parts = [];
        // SUGGESTED rides first: it is the answer to the question the goal asked. Each suggestion is ALSO the
        // same connector_required event the MCP manager emits on a dead tool call, so the ONE post-run chip
        // path ("⇄ CONNECT GMAIL") renders it — no second mechanism. An emit failure is reported, not swallowed.
        const all = goal ? suggestFor(goal) : [];
        // A card whose sign-in is disabled in this build is not a door: no chip, and the model is told so (the
        // first-hour walk 2026-09-28 had the agent promise "sign in with Google, no setup" beside a disabled button).
        const suggested = all.filter(x => !x.unavailable);
        const blocked = all.filter(x => x.unavailable);
        const lost = [];
        if (suggested.length && ctx && typeof ctx.emit === 'function') {
          for (const sgg of suggested) {
            try { ctx.emit('connector_required', { runId: str(ctx.runId), connectorId: sgg.id, kind: 'mcp', reason: sgg.reason, toolName: 'connectors.list' }); }
            catch (e) { lost.push(sgg.id + ': ' + ((e && e.message) || e)); }
          }
        }
        if (goal) {
          parts.push(suggested.length
            ? { label: 'suggested', count: suggested.length, head: 'SUGGESTED for "' + goal + '" — NOT connected yet. The Commander now has a ⇄ CONNECT chip for it on your reply (or on your question card, if you ask one): tell them to tap it — it opens that service in ABILITIES › DISCOVER › CATALOG. Setup varies by provider and may require an API key or developer app setup before sign-in. You cannot connect it yourself.', body: suggested.map(x => '- ' + x.id + ' — ' + x.reason) }
            : { label: 'suggested', count: 0, head: 'SUGGESTED (0) for "' + goal + '" — nothing connectable in the catalog matches this goal (or what it needs is already connected).', body: [] });
          if (blocked.length) parts.push({ label: 'suggested-unavailable', count: blocked.length, head: 'CANNOT BE CONNECTED IN THIS BUILD — sign-in is switched off for these, so there is NO connect chip. Tell the Commander plainly that it is not available yet; never tell them to sign in or tap a chip for it.', body: blocked.map(x => '- ' + x.id + ' — ' + x.unavailable.slice(0, 200)) });
          if (lost.length) parts.push({ label: 'suggested-emit-lost', count: lost.length, head: 'NOTE: the connect chip could not be raised for: ' + lost.join('; '), body: [] });
        }
        if (scope === 'all' || scope === 'connected') { parts.push(sectionConnected(q), sectionKeys(q)); }
        if (scope === 'all' || scope === 'available') { parts.push(sectionAvailable(q)); }

        const blocks = parts.filter(Boolean).map(s => s.head + '\n' + s.body.join('\n'));
        if (!blocks.length) return { content: 'No integration state is readable on this station.', summary: 'no data' };

        let text = blocks.join('\n\n');
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n… (truncated — narrow it with `query`)';
        // The floor summary counts ENTRIES, not rendered lines — "connected:1" for a station with zero
        // connectors (one "(none yet)" line) is exactly the kind of small lie this file is against.
        const counts = parts.filter(Boolean).map(s => s.label + ':' + s.count).join(' ');
        return { content: text, summary: counts };
      }
    };

    return {
      listTool: listTool,
      register(reg) { reg.register(listTool); return reg; },
      suggestFor: suggestFor,
      _internals: { matches, connectedLine, sectionConnected, sectionKeys, sectionAvailable, suggestFor, goalTopics, MAX_AVAILABLE, MAX_CHARS }
    };
  }

  return { makeConnectorTools: makeConnectorTools };
});
