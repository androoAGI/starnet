/* sidecar/secondbrain.js — THE SECOND BRAIN: one graph over every agent's notebook.

   What this is. Agent OS/Agent OS already gives each agent a durable notebook (memory-store.js: one
   WORKSPACES/<agentId>.notebook.json per agent) and recall ranks that notebook alone (context.js: BM25 +
   optional embeddings + recency/trust/stream/project boosts). That is a set of SOLIPSISTIC brains: agent A's
   hard-won lesson is invisible to agent B, and nothing shows the Commander the shape of what the station knows.

   This module is the missing layer. It reads every notebook (never writes one), and projects them into ONE
   graph:
     agent    — a crew member, sized by how much it has learned
     memory   — one §5.2 record, coloured by its kind
     project  — a blessed project root memories are scoped to
     stream   — a workstream memories are scoped to
     concept  — a community the similarity edges fall into (the "neighbourhoods" of the brain)

   Edges are the real relationships Agent OS already stores or can prove:
     wrote        agent -> memory        (the record lives in that agent's notebook)
     similar      memory <-> memory      (embedding cosine when vectors exist, else Jaccard token overlap)
     references   memory -> memory       (an explicit [[wikilink]] in the record text)
     same_project memory -> project      (rec.scope === 'project')
     same_stream  memory -> stream       (rec.scope === 'stream')
     in_concept   memory -> concept      (community detection over the similarity graph)

   PURITY. No IO, no ambient clock, no randomness: the caller injects `now` and the raw notebook arrays. That
   keeps this module unit-testable without booting the server and deterministic across double runs (the same
   discipline as memcore.js / context.js), and it means the graph can be rebuilt from the store at any time
   rather than persisted and slowly diverging from the truth. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).secondbrain = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_RECORDS = 4000;      // a station with more memories than this renders a sampled graph, never a hang
  const MAX_SIMILAR_PER_NODE = 5;  // an edge cap: a hub memory must not weld the whole graph into one hairball
  const SIMILAR_FLOOR = 0.12;    // IDF-weighted cosine floor for a token-only edge — see weightedCosine() below
  const COSINE_FLOOR = 0.55;     // embedding floor (mirrors the semantic lane's intent, tighter because edges are permanent)
  const LABEL_ROUNDS = 6;        // label-propagation passes for communities
  const STALE_MS = 30 * 24 * 60 * 60 * 1000;

  // Same tokenisation as context.tokenize (>=2 chars, stop-worded) so an edge here means what recall would mean.
  const STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that these those with as at by ' +
    'from your you i we they he she them our their not no do does did has have had will would can could me my so if up us am').split(/\s+/));
  function tokenize(s) {
    return String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOP.has(t));
  }
  function tokenSet(text) { const out = new Set(); for (const t of tokenize(text)) out.add(t); return out; }

  function jaccard(a, b) {
    if (!a || !b || !a.size || !b.size) return 0;
    let inter = 0;
    const small = a.size <= b.size ? a : b, big = a.size <= b.size ? b : a;
    for (const t of small) if (big.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { const x = Number(a[i]) || 0, y = Number(b[i]) || 0; dot += x * y; na += x * x; nb += y * y; }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  // A filename-safe id. Kept byte-stable for the same input so a vault re-export rewrites the same file rather
  // than accumulating -2, -3 copies of the same belief.
  function slug(s, fallback) {
    const t = String(s == null ? '' : s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return t || String(fallback || 'untitled');
  }

  function dayOf(ms) {
    const n = Number(ms) || 0;
    if (!n) return '';
    const d = new Date(n);
    const p = x => (x < 10 ? '0' : '') + x;
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  const WIKILINK = /\[\[([^\]|#]{1,120})(?:[|#][^\]]*)?\]\]/g;
  function wikilinks(text) {
    const out = [];
    let m;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(String(text == null ? '' : text)))) out.push(m[1].trim());
    return out;
  }

  // The text a memory is ABOUT — mirrors embed.recordText/context.recordText so the graph indexes exactly what
  // recall indexes (a title-only fact is still findable).
  function recordText(r) {
    if (!r) return '';
    const body = r.body != null ? r.body : (r.content != null ? r.content : '');
    return String(r.title != null ? r.title : '') + ' ' + String(body == null ? '' : body);
  }

  function normalizeRecord(agentId, r, i) {
    if (!r) return null;
    const recordId = String(r.id != null ? r.id : 'note_' + (i + 1));
    const body = r.body != null ? String(r.body) : (r.content != null ? String(r.content) : '');
    const title = r.title != null ? String(r.title) : '';
    const explicitTags = Array.isArray(r.tags) ? r.tags.map(String) : [];
    return {
      uid: agentId + '/' + recordId,
      agentId: agentId,
      recordId: recordId,
      title: title,
      body: body,
      text: (title + ' ' + body).trim(),
      kind: r.kind || 'note',
      scope: r.scope || 'global',
      projectRoot: r.projectRoot || null,
      streamId: r.streamId || null,
      confirmation: r.confirmation || 'inferred',
      origin: r.origin || '',
      authority: r.authority || 'reference-only',
      trust: Number(r.trust) || 0,
      useCount: Number(r.useCount) || 0,
      pinned: !!r.pinned,
      createdAt: Number(r.createdAt || r.ts) || 0,
      updatedAt: Number(r.updatedAt) || 0,
      lastUsedAt: Number(r.lastUsedAt) || 0,
      lastFeedbackAt: Number(r.lastFeedbackAt) || 0,
      sourceRunId: r.sourceRunId || null,
      tags: explicitTags,
      links: wikilinks(title + ' ' + body)
    };
  }

  /* buildGraph({ agents, notebooks, embeddings, now, limits })
       agents     [{ agentId, name, color }]      — the roster (names are the only cosmetic input)
       notebooks  { agentId: record[] }           — raw notebook arrays, straight from the store
       embeddings { agentId: { model, items: { recordId: { v: [] } } } }  — optional derived vectors
     -> { nodes, edges, stats, communities, generatedAt, sampled }
     Pure: identical inputs + now => identical output. */
  function buildGraph(input) {
    const opts = input || {};
    const now = Number(opts.now) || 0;
    const roster = Array.isArray(opts.agents) ? opts.agents : [];
    const notebooks = opts.notebooks && typeof opts.notebooks === 'object' ? opts.notebooks : {};
    const embeddings = opts.embeddings && typeof opts.embeddings === 'object' ? opts.embeddings : {};
    const cap = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_RECORDS;

    const nameFor = {};
    const colorFor = {};
    for (const a of roster) {
      if (!a || !a.agentId) continue;
      nameFor[a.agentId] = String(a.name || a.agentId);
      colorFor[a.agentId] = a.color || null;
    }

    // ---- agents: every roster member, plus every notebook that exists even if the roster forgot it (an agent
    // deleted from the crew leaves its notebook on disk; its memories must not vanish from the map silently) ----
    const agentIds = [];
    const seenAgent = {};
    for (const a of roster) if (a && a.agentId && !seenAgent[a.agentId]) { seenAgent[a.agentId] = 1; agentIds.push(a.agentId); }
    for (const id of Object.keys(notebooks)) if (!seenAgent[id]) { seenAgent[id] = 1; agentIds.push(id); }

    const nodes = [];
    const edges = [];
    const memories = [];
    let sampled = false;

    for (const agentId of agentIds) {
      const list = Array.isArray(notebooks[agentId]) ? notebooks[agentId] : [];
      const agentNodeId = 'agent:' + agentId;
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        if (memories.length >= cap) { sampled = true; break; }
        const rec = normalizeRecord(agentId, list[i], i);
        if (!rec) continue;
        count++;
        memories.push(rec);
        nodes.push({
          id: 'mem:' + rec.uid, type: 'memory', agentId: agentId, recordId: rec.recordId,
          label: rec.title || (rec.body ? rec.body.slice(0, 48) : rec.recordId),
          kind: rec.kind, scope: rec.scope, trust: rec.trust, useCount: rec.useCount,
          pinned: rec.pinned, confirmation: rec.confirmation, origin: rec.origin,
          createdAt: rec.createdAt, updatedAt: rec.updatedAt, lastUsedAt: rec.lastUsedAt,
          projectRoot: rec.projectRoot, streamId: rec.streamId, tags: rec.tags
        });
        edges.push({ source: agentNodeId, target: 'mem:' + rec.uid, type: 'wrote', weight: 1 });
      }
      if (count || notebookExists(notebooks, agentId)) {
        nodes.unshift({
          id: agentNodeId, type: 'agent', agentId: agentId,
          label: nameFor[agentId] || agentId, color: colorFor[agentId] || null,
          memories: count
        });
      }
    }
    // unshift per agent reverses the roster on screen; the renderer sorts by size, so keep store order stable.
    nodes.sort((a, b) => (a.type === 'agent' ? 0 : 1) - (b.type === 'agent' ? 0 : 1));

    // ---- scope nodes (project / stream): one per distinct scope, so a cluster is navigable, not just coloured ----
    const projectNodes = {}, streamNodes = {};
    for (const rec of memories) {
      if (rec.scope === 'project' && rec.projectRoot) {
        const key = String(rec.projectRoot).replace(/\\/g, '/').replace(/\/+$/, '');
        if (!projectNodes[key]) {
          projectNodes[key] = true;
          nodes.push({ id: 'project:' + slug(key, 'project'), type: 'project', label: key.split('/').filter(Boolean).pop() || key, path: key, memories: 0 });
        }
        const pid = 'project:' + slug(key, 'project');
        const pn = nodes.find(n => n.id === pid);
        if (pn) pn.memories++;
        edges.push({ source: 'mem:' + rec.uid, target: pid, type: 'same_project', weight: 0.6 });
      }
      if (rec.scope === 'stream' && rec.streamId) {
        const key = String(rec.streamId);
        if (!streamNodes[key]) {
          streamNodes[key] = true;
          nodes.push({ id: 'stream:' + slug(key, 'stream'), type: 'stream', label: key, memories: 0 });
        }
        const sid = 'stream:' + slug(key, 'stream');
        const sn = nodes.find(n => n.id === sid);
        if (sn) sn.memories++;
        edges.push({ source: 'mem:' + rec.uid, target: sid, type: 'same_stream', weight: 0.5 });
      }
    }

    // ---- similarity edges ---------------------------------------------------------------------------------
    // Embeddings when the station has them (the honest semantic lane), token Jaccard otherwise. An inverted
    // index keeps this near-linear: only records sharing a token are ever compared, so 4k memories is a
    // fraction of the 16M-pair worst case.
    const vectors = {};
    for (const agentId of Object.keys(embeddings)) {
      const store = embeddings[agentId];
      if (!store || !store.items || typeof store.items !== 'object') continue;
      for (const rid of Object.keys(store.items)) {
        const it = store.items[rid];
        if (it && Array.isArray(it.v) && it.v.length) vectors[agentId + '/' + rid] = it.v;
      }
    }
    const tokens = {};
    const index = {};   // token -> [memory position]
    memories.forEach((m, i) => {
      const set = tokenSet(m.text);
      tokens[m.uid] = set;
      for (const t of set) { (index[t] = index[t] || []).push(i); }
    });

    /* The lexical lane. Plain Jaccard was the obvious first cut and it is the wrong metric here: two beliefs
       that independently learned the SAME lesson ("the npm registry rate-limits uploads" / "uploads keep getting
       throttled by the registry") share three terms out of ~23 and score 0.13 — below any honest "duplicate" bar,
       so the single most valuable edge on the whole map (a lesson two agents learned separately) never appeared.
       What matters is not how much of both sentences matches, it is whether the match is on RARE terms. So the
       score is an IDF-weighted cosine: a shared "registry"/"throttled" counts for a lot, a shared "the"/"during"
       counts for nearly nothing, and the floor then means exactly "these two beliefs share at least one rare
       concept". Deterministic: df is computed from the same record set on every build. */
    const N = memories.length;
    const df = {};
    for (const m of memories) for (const t of tokens[m.uid]) df[t] = (df[t] || 0) + 1;
    const idfW = t => Math.log(1 + N / (1 + (df[t] || 1)));
    const weights = {};   // uid -> { token: weight }
    const norms = {};     // uid -> L2 norm of its weight vector
    for (const m of memories) {
      const w = {};
      let n2 = 0;
      for (const t of tokens[m.uid]) { const x = idfW(t); w[t] = x; n2 += x * x; }
      weights[m.uid] = w;
      norms[m.uid] = Math.sqrt(n2);
    }
    function weightedCosine(uidA, uidB) {
      const wa = weights[uidA], wb = weights[uidB], na = norms[uidA], nb = norms[uidB];
      if (!wa || !wb || !na || !nb) return 0;
      let dot = 0;
      for (const t of tokens[uidA]) if (tokens[uidB].has(t)) dot += wa[t] * wb[t];
      return dot / (na * nb);
    }

    const pairScore = (a, b) => {
      const va = vectors[a.uid], vb = vectors[b.uid];
      if (va && vb) {
        const c = cosine(va, vb);
        return c >= COSINE_FLOOR ? { score: c, via: 'embedding' } : null;
      }
      const c = weightedCosine(a.uid, b.uid);
      return c >= SIMILAR_FLOOR ? { score: c, via: 'tokens' } : null;
    };

    const perNode = {};
    const seenPair = {};
    const candidates = [];
    memories.forEach((m, i) => {
      const set = tokens[m.uid];
      const touching = new Set();
      for (const t of set) for (const j of index[t]) if (j !== i) touching.add(j);
      for (const j of touching) {
        const other = memories[j];
        if (!other) continue;
        const key = i < j ? i + ':' + j : j + ':' + i;
        if (seenPair[key]) continue;
        seenPair[key] = 1;
        const s = pairScore(m, other);
        if (!s) continue;
        candidates.push({ i: i < j ? i : j, j: i < j ? j : i, score: s.score, via: s.via });
      }
    });
    // strongest edges first, then a per-node cap so one hub cannot claim the graph
    candidates.sort((a, b) => (b.score - a.score) || (a.i - b.i) || (a.j - b.j));
    for (const c of candidates) {
      const a = memories[c.i], b = memories[c.j];
      const ca = perNode[a.uid] || 0, cb = perNode[b.uid] || 0;
      if (ca >= MAX_SIMILAR_PER_NODE && cb >= MAX_SIMILAR_PER_NODE) continue;
      perNode[a.uid] = ca + 1; perNode[b.uid] = cb + 1;
      edges.push({ source: 'mem:' + a.uid, target: 'mem:' + b.uid, type: 'similar', via: c.via, weight: Math.round(c.score * 100) / 100, crossAgent: a.agentId !== b.agentId });
    }

    // ---- explicit [[wikilinks]] between records (author-written edges always win over inferred ones) ----
    const byTitle = {};
    for (const m of memories) {
      const k = slug(m.title, '');
      if (k) (byTitle[k] = byTitle[k] || []).push(m);
    }
    for (const m of memories) {
      for (const link of m.links) {
        const hits = byTitle[slug(link, '')];
        if (!hits) continue;
        for (const target of hits) {
          if (target.uid === m.uid) continue;
          edges.push({ source: 'mem:' + m.uid, target: 'mem:' + target.uid, type: 'references', weight: 1 });
        }
      }
    }

    // ---- communities: label propagation over the memory graph. Deterministic (ids sorted, ties by smallest
    // label) so a re-export does not reshuffle the neighbourhoods on every read.
    const adjacency = {};
    for (const m of memories) adjacency[m.uid] = [];
    for (const e of edges) {
      if (e.type === 'similar' || e.type === 'references') {
        const a = String(e.source).replace(/^mem:/, ''), b = String(e.target).replace(/^mem:/, '');
        if (adjacency[a] && adjacency[b]) { adjacency[a].push(b); adjacency[b].push(a); }
      }
    }
    const label = {};
    const order = memories.map(m => m.uid).sort();
    for (const uid of order) label[uid] = uid;
    for (let round = 0; round < LABEL_ROUNDS; round++) {
      let changed = false;
      for (const uid of order) {
        const tally = {};
        for (const nb of adjacency[uid]) { const l = label[nb]; tally[l] = (tally[l] || 0) + 1; }
        let best = label[uid], bestN = tally[best] || 0;
        for (const l of Object.keys(tally).sort()) {
          if (tally[l] > bestN || (tally[l] === bestN && l < best)) { best = l; bestN = tally[l]; }
        }
        if (best !== label[uid]) { label[uid] = best; changed = true; }
      }
      if (!changed) break;
    }
    const groups = {};
    for (const m of memories) {
      const root = label[m.uid];
      (groups[root] = groups[root] || []).push(m);
    }
    const communities = Object.keys(groups).sort().map(rootId => {
      const members = groups[rootId];
      // the label: the two most common significant tokens across the community, which reads like a topic
      const freq = {};
      for (const m of members) for (const t of tokens[m.uid]) freq[t] = (freq[t] || 0) + 1;
      const top = Object.keys(freq).sort((a, b) => (freq[b] - freq[a]) || (a < b ? -1 : 1)).slice(0, 3);
      const id = 'concept:' + slug(top.join('-') || rootId, 'concept');
      const labelText = top.length ? top.join(' · ') : 'unclustered';
      return { id: id, label: labelText, size: members.length, members: members.map(m => 'mem:' + m.uid), agents: unique(members.map(m => m.agentId)) };
    }).filter(c => c.size > 0);
    // two communities can mint the same label; disambiguate deterministically by suffixing the count
    const usedConcept = {};
    for (const c of communities) {
      if (usedConcept[c.id]) { usedConcept[c.id]++; c.id = c.id + '-' + usedConcept[c.id]; }
      else usedConcept[c.id] = 1;
      nodes.push({ id: c.id, type: 'concept', label: c.label, size: c.size, agents: c.agents });
      for (const memId of c.members) edges.push({ source: memId, target: c.id, type: 'in_concept', weight: 0.4 });
    }

    // ---- stats ------------------------------------------------------------------------------------------
    const byKind = {}, byAgent = {}, byConfirmation = { 'user-confirmed': 0, inferred: 0 };
    let totalUse = 0, totalTrust = 0, stale = 0, pinned = 0;
    for (const m of memories) {
      byKind[m.kind] = (byKind[m.kind] || 0) + 1;
      byAgent[m.agentId] = (byAgent[m.agentId] || 0) + 1;
      if (byConfirmation[m.confirmation] != null) byConfirmation[m.confirmation]++;
      totalUse += m.useCount;
      totalTrust += m.trust;
      if (m.pinned) pinned++;
      const last = Math.max(m.lastUsedAt, m.updatedAt, m.createdAt);
      if (now && last && (now - last) > STALE_MS) stale++;
    }
    const crossAgentEdges = edges.filter(e => e.crossAgent).length;
    const stats = {
      agents: agentIds.length,
      memories: memories.length,
      edges: edges.length,
      communities: communities.length,
      crossAgentLinks: crossAgentEdges,
      byKind: byKind,
      byAgent: byAgent,
      byConfirmation: byConfirmation,
      pinned: pinned,
      stale: stale,
      totalRecalls: totalUse,
      avgTrust: memories.length ? Math.round((totalTrust / memories.length) * 1000) / 1000 : 0,
      sampled: sampled
    };

    return {
      ok: true,
      generatedAt: now,
      nodes: nodes,
      edges: edges,
      communities: communities,
      stats: stats,
      // the top recalled beliefs across the WHOLE station — the "what does my station actually rely on" list
      topUsed: memories.slice().sort((a, b) => (b.useCount - a.useCount) || (b.lastUsedAt - a.lastUsedAt)).slice(0, 12)
        .map(m => ({ id: 'mem:' + m.uid, agentId: m.agentId, title: m.title || m.body.slice(0, 60), useCount: m.useCount, trust: m.trust, kind: m.kind }))
    };
  }

  function notebookExists(notebooks, agentId) { return Object.prototype.hasOwnProperty.call(notebooks, agentId); }
  function unique(list) { const seen = {}; const out = []; for (const x of list) if (!seen[x]) { seen[x] = 1; out.push(x); } return out; }

  /* recallPulse(graph, queryText, opts) — which nodes SHOULD light up for a given query, computed with the same
     lexical brain recall uses. The live view uses this to show recall as a travelled path rather than a spinner:
     given the text of a running task it answers "these are the beliefs the station will surface". */
  // a crude prefix key so the probe matches the way a human writes: "uploads" finds "upload", "throttled"
  // finds "throttling". Full stemming is a dependency; five characters buys almost all of it in English.
  function stemKey(t) { return t.length > 5 ? t.slice(0, 5) : t; }
  function recallPulse(graph, queryText, opts) {
    const o = opts || {};
    const k = Number(o.k) || 8;
    const records = o.records && typeof o.records === 'object' ? o.records : null;
    const q = tokenize(queryText || '');
    if (!q.length) return [];
    const qfreq = {};
    for (const t of q) { const s = stemKey(t); qfreq[s] = (qfreq[s] || 0) + 1; }
    const out = [];
    for (const n of (graph && graph.nodes) || []) {
      if (n.type !== 'memory') continue;
      // prefer the full record (body included): a graph node only carries a truncated label, and probing a
      // truncated label is why a probe for "throttled uploads" missed the belief that says exactly that.
      const rec = records ? records[n.agentId + '/' + n.recordId] : null;
      const text = rec ? recordText(rec) : String(n.label || '');
      const toks = tokenize(text);
      if (!toks.length) continue;
      let hits = 0;
      for (const t of toks) { const h = qfreq[stemKey(t)]; if (h) hits += h; }
      if (!hits) continue;
      out.push({ id: n.id, score: Math.round((hits / Math.sqrt(toks.length)) * 1000) / 1000, label: n.label });
    }
    out.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
    return out.slice(0, k);
  }

  return { buildGraph, recallPulse, tokenize, tokenSet, jaccard, cosine, slug, dayOf, wikilinks, recordText, normalizeRecord,
    MAX_RECORDS, SIMILAR_FLOOR, COSINE_FLOOR, STALE_MS };
});
