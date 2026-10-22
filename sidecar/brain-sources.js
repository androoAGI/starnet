/* sidecar/brain-sources.js — the OTHER two graphs, folded into the same brain.

   Three things were being asked to be "one second brain":

     1. the station's own memory   — every agent notebook (secondbrain.js builds this)
     2. graphify                   — a code/doc corpus as a graph: graphify-out/graph.json
     3. basemode (ChristopherKahler/base) — a workspace as an RDF graph: .base/graph.nq

   graphify and base are both real, both local, both produce a graph — and both live in their own silo. This
   module is the adapter layer: it parses each into the SAME shape secondbrain.js already understands, so the
   Commander sees one map instead of three tools.

   Everything here is PURE (string/object in, object out, injected now). The host reads the files; this decides
   what they mean. That keeps the whole merge unit-testable without a graphify or base install, which matters
   because neither is a dependency of the app — they are optional amplifiers.

   Node/edge vocabulary produced (consumed by secondbrain.buildGraph `sources`):
     { id, label, type: 'knowledge', source: 'graphify'|'base', kind, community, file, trust }
     { source, target, type: relation, weight, source: 'graphify'|'base' } */
'use strict';

const MAX_NODES = 3000;

// graphify tags every edge EXTRACTED (read directly from source) or INFERRED (resolved). That is exactly the
// confirmation distinction Agent OS already makes, so carry it through instead of flattening it.
function trustForConfidence(c) {
  const s = String(c || '').toUpperCase();
  if (s === 'EXTRACTED') return 0.9;
  if (s === 'INFERRED') return 0.4;
  return 0.5;
}

// A label that can safely become a filename and a wikilink target.
function cleanLabel(s, fallback) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t) return String(fallback || 'untitled');
  return t.length > 90 ? t.slice(0, 89).trimEnd() + '…' : t;
}

/* ---- graphify ---------------------------------------------------------------------------------------- */

/* parseGraphify(json) -> { ok, source:'graphify', version, nodes, edges, stats }
   Accepts the `node_link_data` shape graphify writes (`{ nodes:[], links:[] }`, directed/multigraph header) and
   tolerates `edges` as an alias for `links` because other tools emit that name for the same structure.
   Node attrs we read: id, label, type, community, file/source_location. Edge attrs: source, target, relation,
   confidence (EXTRACTED|INFERRED), weight. Unknown attributes are ignored, never fatal. */
function parseGraphify(input) {
  const g = typeof input === 'string' ? safeJson(input) : input;
  const out = { ok: false, source: 'graphify', version: null, nodes: [], edges: [], stats: { nodes: 0, edges: 0, extracted: 0, inferred: 0 } };
  if (!g || typeof g !== 'object') { out.error = 'not a graphify graph'; return out; }
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : (Array.isArray(g.vertices) ? g.vertices : null);
  if (!rawNodes) { out.error = 'no nodes[] — not a graphify graph.json'; return out; }
  const rawLinks = Array.isArray(g.links) ? g.links : (Array.isArray(g.edges) ? g.edges : []);
  out.version = (g.graph && (g.graph.graphify_version || g.graph.schema_version)) || null;

  const seen = {};
  for (const n of rawNodes) {
    if (!n || n.id == null) continue;
    if (out.nodes.length >= MAX_NODES) break;
    const id = String(n.id);
    if (seen[id]) continue;
    seen[id] = 1;
    const label = cleanLabel(n.label || n.name || n.title, id);
    out.nodes.push({
      id: 'gfy:' + id,
      label: label,
      type: 'knowledge',
      source: 'graphify',
      kind: String(n.type || n.kind || 'concept'),
      community: n.community != null ? String(n.community) : null,
      file: n.file || n.source_file || n.source_location || null,
      trust: 0.6
    });
  }
  for (const l of rawLinks) {
    if (!l || l.source == null || l.target == null) continue;
    const a = 'gfy:' + String(l.source), b = 'gfy:' + String(l.target);
    if (!seen[String(l.source)] || !seen[String(l.target)]) continue;   // a dangling link would draw a floating node
    const conf = String(l.confidence || 'EXTRACTED').toUpperCase();
    if (conf === 'EXTRACTED') out.stats.extracted++; else out.stats.inferred++;
    out.edges.push({
      source: a, target: b,
      type: 'gfy_' + String(l.relation || l.label || 'relates_to').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      weight: Math.max(0.2, Math.min(1, Number(l.weight) || trustForConfidence(conf))),
      sourceKind: 'graphify'
    });
  }
  out.stats.nodes = out.nodes.length;
  out.stats.edges = out.edges.length;
  out.ok = true;
  return out;
}

/* ---- basemode (ChristopherKahler/base) --------------------------------------------------------------- */

/* N-Quads: `<subject> <predicate> <object> <graph> .` — subject/object may be a URI or a blank node, object may be
   a quoted literal (with optional @lang / ^^datatype). splitQuad() walks the line respecting quotes and escapes
   so a summary containing a space or a '>' cannot derail the parse. */
function splitQuad(line) {
  const parts = [];
  let cur = '';
  let inQuote = false;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (esc) { cur += c; esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inQuote = false; continue; }
      cur += c; continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === ' ' || c === '\t') {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur) parts.push(cur);
  return parts.length >= 3 ? parts : null;
}

function localName(iri) {
  const s = String(iri || '');
  const cut = Math.max(s.lastIndexOf('#'), s.lastIndexOf('/'), s.lastIndexOf(':'));
  return cut >= 0 ? s.slice(cut + 1) : s;
}
function stripAngle(s) { return String(s || '').replace(/^<|>$/g, '').replace(/^_:/, ''); }
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/* parseBaseNQuads(text) -> { ok, source:'base', records:[…], edges:[…], stats }
   Groups triples by subject, then reads the vocabulary basemode documents (docs/markdown-ontology-protocol.md):
     rdf:type        -> the node kind (ops:PlatformQuirk, ops:Document, ops:LoreKnowledge, …)
     ops:summary     -> the label (the one-line description base writes)
     ops:title/name  -> fallbacks
     ops:relatedTo / ops:supersedes -> real edges, resolved to another subject in the same file
     ops:tag / ops:domain / ops:status / ops:verified -> carried as metadata
   A subject with no rdf:type and no label is skipped rather than drawn as a mystery dot. */
function parseBaseNQuads(text) {
  const out = { ok: false, source: 'base', records: [], edges: [], stats: { records: 0, edges: 0, triples: 0 } };
  const raw = String(text || '');
  if (!raw.trim()) { out.error = 'empty graph'; return out; }
  const bySubject = new Map();
  let lines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = splitQuad(t);
    if (!parts) continue;
    lines++;
    const subject = stripAngle(parts[0]);
    // strip the angle brackets BEFORE taking the local name, or `…#type>` yields `type>` as the predicate key
    // and every vocabulary lookup (type / summary / relatedTo) silently misses.
    const predicate = localName(stripAngle(parts[1]));
    const object = stripAngle(parts[2]);
    if (!subject || !predicate) continue;
    let rec = bySubject.get(subject);
    if (!rec) { rec = { id: subject, preds: {} }; bySubject.set(subject, rec); }
    if (rec.preds[predicate] == null) rec.preds[predicate] = [];
    rec.preds[predicate].push(object);
  }
  out.stats.triples = lines;

  const one = (rec, keys) => {
    for (const k of keys) { const v = rec.preds[k]; if (v && v.length) return String(v[0]); }
    return '';
  };
  const many = (rec, keys) => {
    for (const k of keys) { const v = rec.preds[k]; if (v && v.length) return v.map(String); }
    return [];
  };

  const known = new Set(bySubject.keys());
  for (const [id, rec] of bySubject) {
    if (out.records.length >= MAX_NODES) break;
    const kind = one(rec, ['type']);
    const summary = one(rec, ['summary', 'description', 'title', 'name', 'label']);
    const local = localName(id);
    const label = cleanLabel(summary || local, id);
    const looksBlank = /^(b|n|node)[0-9a-f_-]{4,}$/i.test(local);
    // a record is worth drawing when it is typed, described, or has a human-looking local name
    if (!kind && !summary && (looksBlank || !local)) continue;
    out.records.push({
      id: 'base:' + id,
      label: label,
      type: 'knowledge',
      source: 'base',
      kind: kind ? localName(kind) : 'record',
      domain: one(rec, ['domain']),
      status: one(rec, ['status']),
      verified: String(one(rec, ['verified'])).toLowerCase() === 'true',
      tags: many(rec, ['tag', 'tags']),
      trust: String(one(rec, ['verified'])).toLowerCase() === 'true' ? 0.85 : 0.55
    });
    for (const pred of ['relatedTo', 'related', 'supersedes', 'dependsOn', 'references']) {
      for (const target of (rec.preds[pred] || [])) {
        if (!known.has(target)) continue;
        out.edges.push({ source: 'base:' + id, target: 'base:' + target, type: 'base_' + pred.toLowerCase(), weight: 0.8, sourceKind: 'base' });
      }
    }
  }
  out.stats.records = out.records.length;
  out.stats.edges = out.edges.length;
  out.ok = true;
  return out;
}

/* mergeSources(sources) -> { nodes, edges, stats }
   Flattens any number of parsed sources (plus already-normalized `{ nodes, edges }` objects) into the single
   node/edge list secondbrain.buildGraph consumes. Ids are namespaced by source inside the parsers, so two tools
   describing the same word ("auth") never collide into one node by accident. */
function mergeSources(sources) {
  const nodes = [];
  const edges = [];
  const bySource = {};
  for (const s of (Array.isArray(sources) ? sources : [])) {
    if (!s) continue;
    const label = s.source || s.kind || 'source';
    const list = Array.isArray(s.nodes) ? s.nodes : (Array.isArray(s.records) ? s.records : []);
    for (const n of list) { if (n && n.id) nodes.push(n); }
    for (const e of (Array.isArray(s.edges) ? s.edges : [])) { if (e && e.source && e.target) edges.push(e); }
    bySource[label] = list.length;
  }
  const ids = new Set(nodes.map(n => n.id));
  return {
    nodes: nodes,
    edges: edges.filter(e => ids.has(e.source) && ids.has(e.target)),
    stats: { sources: Object.keys(bySource).length, bySource: bySource }
  };
}

module.exports = { parseGraphify, parseBaseNQuads, mergeSources, splitQuad, localName, trustForConfidence, MAX_NODES };
