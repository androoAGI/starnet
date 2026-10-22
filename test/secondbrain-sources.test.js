/* node test/secondbrain-sources.test.js — the OTHER two graphs + the auto-improving pass.

   Proves the integration is real and not decorative:
     · graphify's node_link_data graph.json is parsed into nodes + explained edges, dangling links dropped
     · basemode's .base/graph.nq (N-Quads) is grouped by subject, typed from rdf:type, labelled from ops:summary,
       and its ops:relatedTo edges resolve — the vocabulary its own docs/markdown-ontology-protocol.md specifies
     · both fold into the ONE graph without colliding with the station's beliefs
     · the reflection pass only ever PROPOSES: a merge carries replaceId (no new record), a cross-agent lesson
       never fires for a pinned/declined/project-mismatched belief, and nothing is written
     · the vault writes imported knowledge as its own notes, clearly not beliefs
*/
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SecondBrain = require('../sidecar/secondbrain.js');
const Vault = require('../sidecar/secondbrain-vault.js');
const Sources = require('../sidecar/brain-sources.js');
const Reflect = require('../sidecar/secondbrain-reflect.js');

const NOW = 1_700_000_000_000;
const DAY = 86400000;

// ---- graphify ------------------------------------------------------------------------------------------
const gfyJson = JSON.stringify({
  directed: true, multigraph: false,
  graph: { graphify_version: '1.4.0', schema_version: 3 },
  nodes: [
    { id: 'n_apirouter', label: 'APIRouter', type: 'class', community: 2, file: 'routing.py' },
    { id: 'n_dependant', label: 'Dependant', type: 'class', community: 2, file: 'dependencies.py' },
    { id: 'n_validate', label: 'validate_request', type: 'function', community: 2, file: 'routing.py' }
  ],
  links: [
    { source: 'n_apirouter', target: 'n_dependant', relation: 'uses', confidence: 'INFERRED' },
    { source: 'n_apirouter', target: 'n_validate', relation: 'calls', confidence: 'EXTRACTED' },
    { source: 'n_apirouter', target: 'n_ghost', relation: 'uses', confidence: 'INFERRED' }   // dangling
  ]
});
const gfy = Sources.parseGraphify(gfyJson);
A.eq(gfy.ok, true, 'graphify graph parses');
A.eq(gfy.version, '1.4.0', 'graphify_version carried through');
A.eq(gfy.nodes.length, 3, 'every node kept');
A.eq(gfy.edges.length, 2, 'a dangling link is dropped, not drawn as a floating node');
A.eq(gfy.stats.extracted, 1, 'EXTRACTED edges are counted');
A.eq(gfy.stats.inferred, 1, 'INFERRED edges are counted');
A.eq(gfy.nodes[0].type, 'knowledge', 'graphify nodes are knowledge, not beliefs');
A.eq(gfy.nodes[0].source, 'graphify', 'the source is stamped');
A.eq(gfy.nodes[0].id, 'gfy:n_apirouter', 'ids are namespaced so they cannot collide with a belief');
A.eq(gfy.edges[0].type, 'gfy_uses', 'the relation becomes the edge type');
A.ok(gfy.edges.find(e => e.type === 'gfy_calls').weight > gfy.edges.find(e => e.type === 'gfy_uses').weight,
  'an EXTRACTED edge outweighs an INFERRED one');

A.eq(Sources.parseGraphify('not json').ok, false, 'garbage is refused, not thrown');
A.eq(Sources.parseGraphify({}).ok, false, 'a graph with no nodes[] is refused');
A.eq(Sources.parseGraphify({ nodes: [{ id: 'a', label: 'A' }] }).nodes.length, 1, 'a bare graph still parses');

// ---- basemode -----------------------------------------------------------------------------------------
const nq = [
  '<http://ops/w#qr1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://ops/o#PlatformQuirk> .',
  '<http://ops/w#qr1> <http://ops/o#summary> "GHL API cannot create dropdown custom fields" .',
  '<http://ops/w#qr1> <http://ops/o#domain> "ghl-custom-fields" .',
  '<http://ops/w#qr1> <http://ops/o#status> "active" .',
  '<http://ops/w#qr1> <http://ops/o#tag> "api" .',
  '<http://ops/w#qr1> <http://ops/o#relatedTo> <http://ops/w#d1> .',
  '<http://ops/w#d1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://ops/o#Decision> .',
  '<http://ops/w#d1> <http://ops/o#summary> "Migrations always run through the CLI" .',
  '<http://ops/w#d1> <http://ops/o#verified> "true" .',
  '<http://ops/w#d1> <http://ops/o#relatedTo> <http://ops/w#nowhere> .'   // target not in this file
].join('\n');
const base = Sources.parseBaseNQuads(nq);
A.eq(base.ok, true, 'basemode graph parses');
A.eq(base.records.length, 2, 'two typed records, and the untargeted blank is not invented');
A.eq(base.records[0].kind, 'PlatformQuirk', 'rdf:type becomes the kind');
A.eq(base.records[0].label, 'GHL API cannot create dropdown custom fields', 'ops:summary becomes the label');
A.eq(base.records[0].domain, 'ghl-custom-fields', 'ops:domain is carried');
A.eq(base.records[0].tags, ['api'], 'ops:tag is carried');
A.eq(base.edges.length, 1, 'only edges whose target exists are kept');
A.eq(base.edges[0].type, 'base_relatedto', 'ops:relatedTo becomes an edge');
A.eq(base.records[1].kind, 'Decision', 'the second record is typed independently');
A.ok(base.records[1].trust > base.records[0].trust, 'verified:true carries more confidence than unverified');
A.eq(Sources.parseBaseNQuads('').ok, false, 'an empty graph is refused');

// a literal containing a quote and a comma must not derail the quad split
const tricky = Sources.parseBaseNQuads('<http://x#s> <http://x#summary> "He said \\"stop, now\\" twice" .');
A.eq(tricky.records[0].label, 'He said "stop, now" twice', 'escaped quotes inside a literal survive');

// ---- both folded into ONE graph ------------------------------------------------------------------------
const nova = [
  { id: 'note_1', kind: 'fact', title: 'Deploy ritual', body: 'Deploys go out on Tuesday mornings with the release:prod script.', scope: 'project', projectRoot: 'C:/work/app', confirmation: 'user-confirmed', origin: 'reflect', trust: 0.6, useCount: 7, pinned: true, createdAt: NOW - 40 * DAY, updatedAt: NOW - 2 * DAY },
  { id: 'note_2', kind: 'note', title: 'Registry throttling', body: 'The npm registry keeps rate-limiting uploads during release windows.', scope: 'global', confirmation: 'inferred', origin: 'reflect', trust: 0.15, useCount: 3, createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY },
  { id: 'note_3', kind: 'note', title: 'Registry throttling again', body: 'The npm registry keeps rate limiting uploads during release windows!', scope: 'global', confirmation: 'inferred', origin: 'reflect', trust: 0.1, useCount: 1, createdAt: NOW - 19 * DAY, updatedAt: NOW - 19 * DAY }
];
const atlas = [
  { id: 'note_1', kind: 'note', title: 'Upload throttling lesson', body: 'Uploads keep getting throttled by the registry; exponential backoff with jitter fixed it.', scope: 'project', projectRoot: 'C:/work/app', confirmation: 'user-confirmed', origin: 'reflect', trust: 0.5, useCount: 5, createdAt: NOW - 10 * DAY },
  { id: 'note_2', kind: 'skill', title: 'Playwright flake fix', body: 'Wait for networkidle before asserting on the table; the flake was a hydration race.', scope: 'stream', streamId: 'qa', confirmation: 'inferred', origin: 'notebook.write', trust: 0.2, useCount: 2, createdAt: NOW - 6 * DAY }
];
const notebooks = { nova: nova.slice(), atlas: atlas.slice() };
const merged = SecondBrain.buildGraph({ agents: [{ agentId: 'nova', name: 'Nova' }, { agentId: 'atlas', name: 'Atlas' }], notebooks: notebooks, sources: [gfy, base], now: NOW });

A.eq(merged.stats.memories, 5, 'beliefs are unchanged by the import');
A.eq(merged.stats.knowledge, 5, 'all five imported nodes are in the same graph (3 graphify + 2 base)');
A.eq(merged.stats.sources.graphify.nodes, 3, 'graphify contributed 3');
A.eq(merged.stats.sources.base.nodes, 2, 'basemode contributed 2');
A.ok(merged.nodes.some(n => n.type === 'knowledge' && n.label === 'APIRouter'), 'a graphify concept is a node');
A.ok(merged.nodes.some(n => n.type === 'knowledge' && n.kind === 'Decision'), 'a basemode decision is a node');
A.ok(!merged.nodes.some(n => n.id === 'mem:nova/note_1' && n.type === 'knowledge'), 'beliefs keep their own type');
A.ok(merged.edges.some(e => e.type === 'gfy_calls' && e.external), 'imported edges survive the merge');
A.eq(SecondBrain.buildGraph({ agents: [], notebooks: {}, sources: [], now: NOW }).stats.knowledge, 0, 'no sources -> no knowledge nodes');

// ---- the auto-improving pass ---------------------------------------------------------------------------
const records = {};
for (const list of [nova, atlas]) for (let i = 0; i < list.length; i++) {
  const r = SecondBrain.normalizeRecord(list === nova ? 'nova' : 'atlas', list[i], i);
  records[r.uid] = r;
}
const plan = Reflect.propose(merged, { now: NOW, records: records, declined: {} });
const novaPlan = plan.find(p => p.agentId === 'nova');
A.ok(!!novaPlan, 'the pass proposes something for nova');
const merge = novaPlan.proposals.find(p => p.reason === 'merge');
A.ok(!!merge, 'two near-duplicate beliefs in one notebook produce a merge proposal');
A.ok(!!merge.replaceId, 'a merge carries replaceId — Keep REWRITES, it does not add a sixth record');
A.ok(merge.content.length > 0 && merge.content.indexOf('—') >= 0, 'the merged text contains both beliefs');
A.ok(merge.kind === 'note', 'the merge keeps the original kind');

const learn = plan.find(p => p.agentId === 'atlas' && p.proposals.some(x => x.reason === 'cross-learn'));
A.ok(!!learn, 'atlas is offered a lesson it does not hold');
const taught = learn.proposals.find(x => x.reason === 'cross-learn');
A.ok(taught.content.indexOf('Learned on this station') === 0, 'the taught belief states where it came from');
A.ok(!taught.replaceId, 'a cross-learn proposal ADDS a belief (no replaceId)');

// honesty rules
const pinnedSource = Reflect.propose(merged, { now: NOW, records: records, declined: {} })
  .flatMap(p => p.proposals).find(p => p.replaceId === 'note_1');
A.ok(!pinnedSource, 'a pinned belief is never rewritten');
const declinedPlan = Reflect.propose(merged, { now: NOW, records: records, declined: { nova: [merge.content] } });
A.ok(!(declinedPlan.find(p => p.agentId === 'nova') || { proposals: [] }).proposals.some(p => p.reason === 'merge'),
  'a declined belief is never re-proposed');
A.ok(plan.every(p => p.proposals.length <= Reflect.MAX_PER_AGENT), 'a deck stays bounded per agent');
A.eq(Reflect.propose(merged, { now: NOW, records: records, declined: {} }),
  Reflect.propose(merged, { now: NOW, records: records, declined: {} }), 'the pass is deterministic');

// a project-scoped lesson is not pushed to an agent that does not touch that project
const isolated = SecondBrain.buildGraph({
  agents: [{ agentId: 'a' }, { agentId: 'b' }],
  notebooks: {
    a: [{ id: 'note_1', title: 'Repo rule', body: 'Deploys always go out Tuesday morning through release prod.', scope: 'project', projectRoot: 'C:/work/app', confirmation: 'user-confirmed', trust: 0.9, useCount: 9, kind: 'fact' }],
    b: [{ id: 'note_1', body: 'Nothing to do with any project here at all whatsoever.', scope: 'global', useCount: 0 }]
  }, now: NOW
});
const isolatedPlan = Reflect.propose(isolated, { now: NOW, records: {}, declined: {} });
A.ok(!isolatedPlan.some(p => p.agentId === 'b' && p.proposals.some(x => x.reason === 'cross-learn')),
  'a project-scoped belief is not taught to an agent outside that project');

// ---- the vault keeps imported knowledge visibly separate -----------------------------------------------
(async () => {
  let dir = null;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentos-brain-src-'));
    await Vault.writeVault({ fs: fs, fsp: fsp, path: path, root: dir, graph: merged, records: records, now: NOW });
    A.ok(fs.existsSync(path.join(dir, 'Knowledge')), 'imported knowledge gets its own folder');
    A.ok(fs.existsSync(path.join(dir, 'Knowledge.base')), 'and its own base view');
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(path.join(dir, 'Knowledge'));
    A.eq(files.length, 5, 'one note per imported node');
    const api = files.find(f => fs.readFileSync(f, 'utf8').indexOf('APIRouter') >= 0);
    const src = fs.readFileSync(api, 'utf8');
    A.ok(src.indexOf('type: "knowledge"') >= 0, 'the note is typed knowledge, not memory');
    A.ok(src.indexOf('source: "graphify"') >= 0, 'the note names the tool it came from');
    A.ok(src.indexOf('not a belief') >= 0, 'the note says plainly that it is not a belief');

    const graphJson = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
    A.ok(graphJson.nodes.some(n => n.type === 'knowledge'), 'graph.json carries the imported nodes');
    A.ok(graphJson.links.some(l => l.type === 'gfy_calls'), 'graph.json carries the explained relation');
  } catch (e) {
    A.ok(false, 'vault export threw: ' + ((e && e.stack) || e));
  } finally {
    if (dir) { try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) {} }
  }

  // EVERY module added here must start executing at `'use strict'`. This suite exists because three of them
  // shipped with an unclosed header comment that silently swallowed the whole file — it still parsed, still
  // "loaded", and defined nothing. One assertion here catches that class of mistake forever.
  for (const rel of ['secondbrain.js', 'secondbrain-vault.js', 'brain-sources.js', 'secondbrain-reflect.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', rel), 'utf8');
    const body = src.replace(/^\/\*[\s\S]*?\*\//, '').trim();
    A.ok(body.startsWith("'use strict';"), rel + ' starts with the strict directive (its header comment is closed)');
  }

  A.report('secondbrain-sources.test');
})();
