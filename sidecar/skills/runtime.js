/* sidecar/skills/runtime.js - prompt index for runtime-created agent skills.

   Bundled recipes inject full bodies because they are curated and capability
   gated. Agent-created skills use progressive disclosure: every run sees the
   compact index, and the model must call skill.view when a listed skill is
   even partly relevant.
*/
'use strict';
(function (root, factory) {
  // context.js supplies the ONE lexical scorer (bm25) so the skill index ranks by the same brain memory
  // recall uses — never a second drifting copy of the algorithm. Node requires it; the (vestigial) browser
  // path picks it off root.SK, degrading to unordered if absent — composeIndex guards for that.
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('../context.js'));
  else { (root.SK = root.SK || {}).runtimeSkills = factory((root.SK || {}).context); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (context) {
  'use strict';

  function str(v) { return v == null ? '' : String(v); }
  function platformOk(s, platform) {
    const ps = Array.isArray(s && s.platforms) ? s.platforms.map(x => str(x).toLowerCase()) : [];
    if (!ps.length || !platform) return true;
    const p = str(platform).toLowerCase();
    return ps.indexOf(p) >= 0 || (p === 'win32' && ps.indexOf('windows') >= 0) || (p === 'darwin' && ps.indexOf('macos') >= 0);
  }
  function isLive(s, platform) { return s && s.state !== 'archived' && platformOk(s, platform); }
  function cleanLine(s) { return str(s).replace(/\s+/g, ' ').trim(); }

  /* gateOf — the guard decision for one skill, from an injected gate (skills/gate.js). No gate
     injected = everything visible, which is exactly how this file behaved before the gate existed. */
  function gateOf(s, gate) {
    if (s && s.pendingCandidate) return { visible: false, reason: 'proposed skill awaits behavior evaluation and Commander approval' };
    if (typeof gate !== 'function') return { visible: true, reason: '' };
    try { const d = gate(s) || {}; return { visible: d.visible !== false, reason: str(d.reason) }; }
    catch (_) { return { visible: true, reason: '' };  /* a gate hiccup must never empty the index */ }
  }

  /* RELEVANCE-ORDERED INDEX: with opts.query, the index leads with the skills lexically relevant to THIS ask —
     under the 6000-char budget the relevant skill must never be the one skipped for a stale-but-recent one.
     Pinned skills keep the existing contract (always first, in caller order), with or without a query. With an
     agentId, only that agent's own pins lead: another agent's pinned station skill never jumps ahead of them. The
     rest sort by context.js's bm25 over {name, summary} (skills shim onto the record shape as title/body), tiebreak
     updatedAt desc then name then caller order. No query at all (or no scorer in the vestigial browser path) →
     the pins, then the caller's order (skillStore listAccessible(): own skills first, then pinned, most recently
     updated, then name). Nothing is ever DROPPED by relevance: the budget's own skip-and-count is the only
     omission path, unchanged.
     Without an agentId the owner is read off the list: listAccessible returns agent-scope rows only for the caller,
     so any such row names it. A list with none (every own skill shared) lets every pin lead, as before. */
  function listOwner(live, agentId) {
    if (str(agentId)) return str(agentId);
    const own = live.find(s => s && s.agentId && (!s.scope || s.scope === 'agent'));
    return own ? str(own.agentId) : '';
  }
  function leadsAsPinned(s, agentId) { return !!(s && s.pinned) && (!agentId || !s.agentId || str(s.agentId) === agentId); }
  function orderByQuery(live, query, ctx, agentId) {
    const owner = listOwner(live, agentId);
    const pinnedFirst = list => list.filter(s => leadsAsPinned(s, owner)).concat(list.filter(s => !leadsAsPinned(s, owner)));
    if (!query || !ctx || typeof ctx.bm25 !== 'function') return pinnedFirst(live);
    const rel = ctx.bm25(live.map(s => ({ kind: 'note', title: str(s && s.name), body: str(s && s.summary) })), query);
    if (!rel.queried) return pinnedFirst(live);   // no significant tokens (image-only turn) -> pins, then caller order
    const rows = live.map((s, i) => ({ s: s, i: i, score: rel.scores[i] || 0 }));
    const cmp = (a, b) => (b.score - a.score)
      || (((b.s && b.s.updatedAt) || 0) - ((a.s && a.s.updatedAt) || 0))
      || str(a.s && a.s.name).localeCompare(str(b.s && b.s.name))
      || (a.i - b.i);
    const pinned = rows.filter(x => leadsAsPinned(x.s, owner));
    const rest = rows.filter(x => !leadsAsPinned(x.s, owner)).sort(cmp);
    return pinned.concat(rest).map(x => x.s);
  }

  /* THE FIRST-SKILL LINE (2026-09-28). The only sentence that asked an agent to write skills lived inside the
     index below, and an agent with no saved skills got no index, so a new agent was never asked. With
     `emptyGuide`, an empty skillbase still gets one short constant block (constant, so the cached prefix stays
     stable) telling the agent what a skill is and when to save one. */
  function emptyGuide(canManage, archived) {
    // archived > 0: the agent HAS skills, all archived. "No saved skills yet" would be false and would steer it to
    // recreate instead of restore, so the line says what is true.
    const opening = archived > 0
      ? 'You have no active saved skills (' + archived + ' archived; skill.list with includeArchived shows them, and skill.manage action restore brings one back). '
      : 'You have no saved skills yet. ';
    return '\n\n## SAVED AGENT SKILLS\n'
      + opening + 'A skill is a procedure you write down so your next runs start from it instead of working it out again. '
      + 'When a task makes you work out a non-trivial procedure (a multi-step workflow, a fix for a tricky error, a format or approach the Commander wants), save it '
      + (canManage ? 'with skill.manage (action create)' : 'with skill.write')
      + ' before you finish: a short name, a one-line summary of when to use it, and the steps. '
      // A model-written skill is a pending proposal: say so, or the agent believes it already applies.
      + 'It applies once approved in ABILITIES > SKILLS.';
  }

  function composeIndex(skills, opts) {
    opts = opts || {};
    const budget = opts.budget > 0 ? opts.budget : 6000;
    const canManage = opts.canManage !== false;
    const live = (Array.isArray(skills) ? skills : []).filter(s => isLive(s, opts.platform));
    if (!live.length) {
      // counted from the list itself: the host passes the skillbase WITH archived rows (isLive drops them above)
      const archived = (Array.isArray(skills) ? skills : []).filter(s => s && s.state === 'archived').length;
      return { text: opts.emptyGuide ? emptyGuide(canManage, archived) : '', ids: [], omitted: 0, withheld: 0 };
    }
    const ordered = orderByQuery(live, opts.query == null ? '' : String(opts.query), context, opts.agentId);
    // The owner tag is spent only where it tells the model something: a shared (station/project) skill, or one
    // owned by another agent. An agent-scope skill in this list is the caller's own (listAccessible).
    const ownerTagged = s => !!s.agentId && ((s.scope && s.scope !== 'agent') || (!!opts.agentId && str(s.agentId) !== str(opts.agentId)));

    const parts = [];
    const ids = [];
    let used = 0, omitted = 0, withheld = 0, compacted = 0;
    const overflow = [];
    for (const s of ordered) {
      const bits = [];
      bits.push('- ' + cleanLine(s.name || s.id || 'Skill'));
      /* A WITHHELD SKILL IS NAMED, NEVER SUMMARIZED, AND NEVER PROMISED. The row exists so the
         model doesn't try to create a duplicate of a skill it cannot see; the summary is dropped
         because it is model-authored text the guard's scan never covered, and the id is dropped
         from `ids` so it is not counted as used — nothing was delivered. */
      const g = gateOf(s, opts.gate);
      if (!g.visible) {
        withheld++;
        const line = bits[0] + ' [WITHHELD: ' + cleanLine(g.reason || 'held by the skill guard') + ' - do not recreate it]';
        if (parts.length && used + line.length > budget) { overflow.push({ skill: s, held: true }); continue; }
        parts.push(line); used += line.length;
        continue;
      }
      if (s.summary) bits.push(' -- ' + cleanLine(s.summary));
      const meta = [];
      if (s.category) meta.push(cleanLine(s.category));
      if (s.state && s.state !== 'active') meta.push(cleanLine(s.state));
      if (s.pinned) meta.push('pinned');
      if (s.platforms && s.platforms.length) meta.push('platforms: ' + s.platforms.join('/'));
      if (s.files && s.files.length) meta.push(String(s.files.length) + ' support file' + (s.files.length === 1 ? '' : 's'));
      if (meta.length) bits.push(' [' + meta.join(', ') + ']');
      if (ownerTagged(s)) bits.push(' [owner: ' + cleanLine(s.agentId) + ', scope: ' + cleanLine(s.scope || 'agent') + ']');
      if (s.id) bits.push(' (id: ' + cleanLine(s.id) + ')');
      const line = bits.join('');
      if (parts.length && used + line.length > budget) { overflow.push({ skill: s, held: false }); continue; }
      parts.push(line); used += line.length; if (s.id) ids.push(s.id);
    }
    // Keep a bounded names-only overflow, including owner identity for shared skills.
    // Anything still too large remains discoverable through paginated skill.list.
    const overflowBudget = opts.overflowBudget > 0 ? opts.overflowBudget : 2000;
    let overflowUsed = 0;
    const compact = [];
    for (const row of overflow) {
      const s = row.skill;
      const line = '- ' + cleanLine(s.name || s.id) + (ownerTagged(s) ? ' [owner: ' + cleanLine(s.agentId) + ']' : '')
        + (row.held ? ' [WITHHELD]' : '');
      if (overflowUsed + line.length > overflowBudget) { omitted++; continue; }
      compact.push(line); overflowUsed += line.length; compacted++;
      if (!row.held && s.id) ids.push(s.id);
    }
    if (compact.length) parts.push('\nAdditional saved skills (names only; load with skill.view):\n' + compact.join('\n'));
    if (!parts.length) return { text: '', ids: [], omitted: live.length, withheld };

    const manage = canManage
      ? 'If the task teaches a reusable procedure, update an existing skill or create a new one with skill.manage.'
      : 'If the task teaches a reusable procedure, save it with skill.write.';
    const head = '\n\n## SAVED AGENT SKILLS (mandatory)\n'
      + 'Before replying, scan this skill index. If any saved skill is even partly relevant, call skill.view with its name before acting. '
      + 'Do not infer the procedure from the summary alone; load the full body first. ' + manage + '\n\n';
    const tail = omitted ? ('\n\n(' + omitted + ' more saved skill' + (omitted === 1 ? ' is' : 's are') + ' not shown. Search all accessible skills with skill.list {query, offset, limit}; page until exhausted before concluding no skill exists.)') : '';
    return { text: head + parts.join('\n') + tail, ids, omitted, withheld, compacted };
  }

  function extractInvocations(messages) {
    const out = [];
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
      for (const line of m.content.split(/\r?\n/)) {
        let mm = line.match(/^\s*\/skill\s+(.+?)\s*$/i);
        if (mm) { out.push(mm[1].trim()); continue; }
        mm = line.match(/^\s*\/skill-([A-Za-z0-9._ -]{1,80})\s*$/i);
        if (mm) out.push(mm[1].trim().replace(/-/g, ' '));
      }
    }
    return out.filter(Boolean);
  }

  /* A SUPPORT FILE AS THE AGENT READS IT (GitHub #145). An imported skill package stores every file base64-encoded
     (exchange.js), and skill.view / a preloaded skill printed that blob as the file: references unreadable, a third
     more context. A base64 file whose bytes are valid UTF-8 text is shown as that text; anything else is NAMED as
     binary with its size, never pasted. A plain-text entry is unchanged. The path leads, as before. */
  function supportFileLine(f) {
    if (!f) return '';
    const head = '- ' + str(f.path);
    if (f.encoding !== 'base64') return head + (f.content ? '\n' + f.content : '');
    const raw = str(f.content);
    if (!raw) return head;
    if (typeof Buffer === 'undefined' || typeof TextDecoder === 'undefined') return head + ' (binary file, not shown as text)';
    const bytes = Buffer.from(raw, 'base64');
    let text = null;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { text = null; }
    // NUL never appears in a text file: a decodable blob that holds one is binary all the same
    if (text == null || text.indexOf('\u0000') >= 0) return head + ' (binary file, ' + bytes.length + ' bytes, not shown as text)';
    return head + (text ? '\n' + text : '');
  }

  /* composeLoaded injects FULL BODIES for skills the Commander named (/skill, preloadSkills), so
     the gate matters here even more than in the index. The caller already filters, and `withheld`
     is checked again here: this is the last seam before the bytes enter the system prompt. */
  function composeLoaded(skills) {
    const live = (Array.isArray(skills) ? skills : []).filter(s => s && s.body && s.state !== 'archived' && !s.withheld && !s.pendingCandidate);
    if (!live.length) return '';
    return '\n\n## PRELOADED SKILLS\n'
      + 'The Commander explicitly loaded these skills for this run. Follow them where applicable.\n\n'
      + live.map(s => '### ' + cleanLine(s.name || s.id || 'Skill') + (s.summary ? ' -- ' + cleanLine(s.summary) : '') + '\n'
        + (s.setup ? 'Setup:\n' + s.setup + '\n\n' : '') + s.body
        + (s.files && s.files.length ? '\n\nSupport files:\n' + s.files.map(supportFileLine).join('\n') : '')
      ).join('\n\n');
  }

  function searchIndex(skills, query) {
    const list = Array.isArray(skills) ? skills : [];
    if (!str(query).trim()) return list.slice();
    const rel = context.bm25(list.map(s => ({ title: s.name, body: s.summary || s.description || '' })), str(query));
    return orderByQuery(list.filter((s, i) => rel.scores[i] > 0 || cleanLine(s.name).toLowerCase().includes(str(query).toLowerCase())), str(query), context);
  }
  return { composeIndex, extractInvocations, composeLoaded, searchIndex, supportFileLine };
});
