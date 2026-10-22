/* sidecar/secondbrain-reflect.js — the brain IMPROVES ITSELF, across agents.

   StarNet already had a real learning loop for ONE agent: reflect.js proposes beliefs, the Commander answers
   Keep / Edit / Discard, `memory.feedback` moves trust, trust decays when it goes unreinforced, and an explicit
   Discard lands in `declined:<agent>` so it is never proposed again. That is the Hermes-shaped loop, and it
   works — inside a single notebook.

   What it could never do is notice anything BETWEEN agents:
     · the same lesson learned twice, in slightly different words, in two notebooks
     · a hard-won fact one agent uses constantly that another agent, working the same project, has never heard of
   This module reads the unified graph and turns those two patterns into ordinary PROPOSALS, so they ride the
   exact same deck (POST /api/memory/turnin) and the exact same trust mechanics as everything else. No parallel
   memory system, no silent writes: everything here is a suggestion until the Commander keeps it.

   PURE: the graph, the notebooks' declined lists and the clock are all injected, so the rules are unit-testable
   and a double run proposes the same set.

   Deliberately NOT proposed (the loop's own honesty rules):
     · a forget/delete — there is no Discard-for-existing-beliefs verdict, and a proposal deck must never be able
       to destroy something the Commander pinned or confirmed.
     · a pin or a trust bump — those are earned through memory.feedback, never asserted by a reflector.
     · anything already in `declined:` — discard means never again, station-wide. */
'use strict';

const MAX_PER_AGENT = 4;         // a deck of 20 is a deck nobody reads
const MERGE_FLOOR = 0.62;        // two beliefs this close are the same lesson in two accents
const CROSS_LEARN_USE = 2;       // a belief must have actually been recalled before it is worth teaching
const CONTENT_CHARS = 420;

function clean(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function keyOf(text) { return clean(text, 400).toLowerCase(); }

/* similarity(graph, idA, idB) — reuse the edge the graph already computed (embedding or IDF-weighted tokens). */
function similarity(graph, idA, idB) {
  for (const e of (graph.edges || [])) {
    if (e.type !== 'similar') continue;
    if ((e.source === idA && e.target === idB) || (e.source === idB && e.target === idA)) return Number(e.weight) || 0;
  }
  return 0;
}

function memoryNodes(graph) {
  return ((graph && graph.nodes) || []).filter(n => n && n.type === 'memory');
}

/* propose(graph, opts) -> [{ agentId, proposals: [...] }]
   opts: { declined: { agentId: string[] }, now, records }
   Each proposal is shaped for the EXISTING turn-in path: { id, kind, content, scope, projectRoot, replaceId?, previousBody? }.
   `replaceId` (same agent) is how a merge is expressed: Keep replaces that record's text instead of adding a new one. */
function propose(graph, opts) {
  const o = opts || {};
  const now = Number(o.now) || 0;
  const declined = o.declined && typeof o.declined === 'object' ? o.declined : {};
  const records = o.records && typeof o.records === 'object' ? o.records : {};
  const mems = memoryNodes(graph);
  const byAgent = {};
  for (const m of mems) (byAgent[m.agentId] = byAgent[m.agentId] || []).push(m);

  function isDeclined(agentId, text) {
    const list = declined[agentId];
    if (!Array.isArray(list) || !list.length) return false;
    const k = keyOf(text);
    return list.some(d => { const dk = keyOf(d); return dk && (dk === k || dk.indexOf(k) >= 0 || k.indexOf(dk) >= 0); });
  }

  const out = [];
  for (const agentId of Object.keys(byAgent).sort()) {
    const mine = byAgent[agentId];
    const proposals = [];
    const used = new Set();   // a belief may anchor at most one proposal per pass

    // ---- rule 1: CONSOLIDATE two near-identical beliefs in the same notebook -----------------------------
    const ordered = mine.slice().sort((a, b) => (num(b.useCount) - num(a.useCount)) || (num(b.trust) - num(a.trust)) || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < ordered.length; i++) {
      const a = ordered[i];
      if (used.has(a.id) || a.pinned) continue;           // never rewrite a pinned belief
      for (let j = i + 1; j < ordered.length; j++) {
        const b = ordered[j];
        if (used.has(b.id) || b.pinned) continue;
        if (similarity(graph, a.id, b.id) < MERGE_FLOOR) continue;
        const ra = records[a.agentId + '/' + a.recordId];
        const rb = records[b.agentId + '/' + b.recordId];
        if (!ra || !rb) continue;
        const keep = num(ra.useCount) >= num(rb.useCount) ? ra : rb;
        const drop = keep === ra ? rb : ra;
        const merged = clean(keep.body || keep.text, CONTENT_CHARS - 40) + ' — also: ' + clean(drop.body || drop.text, 160);
        if (isDeclined(agentId, merged)) { used.add(a.id); used.add(b.id); break; }
        used.add(a.id); used.add(b.id);
        proposals.push({
          id: 'sb_merge_' + (proposals.length + 1),
          kind: keep.kind || 'note',
          content: merged,
          scope: keep.scope || 'global',
          projectRoot: keep.projectRoot || null,
          replaceId: keep.recordId,
          previousBody: keep.body || keep.text || '',
          reason: 'merge'
        });
        break;
      }
      if (proposals.length >= MAX_PER_AGENT) break;
    }

    // ---- rule 2: CROSS-LEARN — teach this agent a proven lesson a teammate already holds ------------------
    // "Proven" = actually recalled (useCount) AND endorsed or user-confirmed. Project/stream scope must match,
    // so an agent is never taught a lesson about a repo or workstream it does not touch.
    if (proposals.length < MAX_PER_AGENT) {
      const held = new Set(mine.map(m => keyOf(m.label)));
      const candidates = [];
      for (const other of Object.keys(byAgent).sort()) {
        if (other === agentId) continue;
        for (const m of byAgent[other]) {
          if (num(m.useCount) < CROSS_LEARN_USE) continue;
          if (m.confirmation !== 'user-confirmed' && num(m.trust) < 0.3) continue;
          if (m.scope === 'project') {
            if (!m.projectRoot) continue;
            const sharesProject = mine.some(x => x.projectRoot && String(x.projectRoot) === String(m.projectRoot));
            if (!sharesProject && !(o.projectRoot && String(o.projectRoot) === String(m.projectRoot))) continue;
          }
          if (m.scope === 'stream') {
            const sharesStream = mine.some(x => x.streamId && x.streamId === m.streamId);
            if (!sharesStream && !(o.streamId && o.streamId === m.streamId)) continue;
          }
          if (held.has(keyOf(m.label))) continue;
          const already = mine.some(x => similarity(graph, x.id, m.id) >= MERGE_FLOOR);
          if (already) continue;
          const rec = records[m.agentId + '/' + m.recordId];
          if (!rec) continue;
          candidates.push({ m: m, rec: rec, score: num(m.useCount) + num(m.trust) * 4 });
        }
      }
      candidates.sort((a, b) => (b.score - a.score) || (a.m.id < b.m.id ? -1 : 1));
      for (const c of candidates) {
        if (proposals.length >= MAX_PER_AGENT) break;
        const text = clean('Learned on this station by ' + c.m.agentId + ': ' + (c.rec.body || c.rec.text || c.m.label), CONTENT_CHARS);
        if (isDeclined(agentId, text)) continue;
        proposals.push({
          id: 'sb_learn_' + (proposals.length + 1),
          kind: c.rec.kind === 'profile' ? 'fact' : (c.rec.kind || 'note'),
          content: text,
          scope: c.rec.scope || 'global',
          projectRoot: c.rec.scope === 'project' ? c.rec.projectRoot : null,
          reason: 'cross-learn'
        });
      }
    }

    if (proposals.length) out.push({ agentId: agentId, proposals: proposals });
  }
  return out;
}

function num(v) { return Number(v) || 0; }

module.exports = { propose, similarity, MAX_PER_AGENT, MERGE_FLOOR };
