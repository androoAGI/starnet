/* node test/secondbrain.test.js — THE SECOND BRAIN: the pure cross-agent graph + the Obsidian vault writer.
   Proves the projection is honest and deterministic: every belief becomes a node wired to the agent that holds
   it, a paraphrase learned independently by two agents becomes a real cross-agent edge, the trust/recall stats
   are sums over the stores (never invented), a re-run over the same inputs is byte-identical, and the vault the
   writer emits is a valid Obsidian shape (frontmatter, wikilinks, .base filters, graph.json) with no traversal in
   a record title. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const SecondBrain = require('../sidecar/secondbrain.js');
const Vault = require('../sidecar/secondbrain-vault.js');

const NOW = 1_700_000_000_000;
const DAY = 86400000;

const nova = [
  { id: 'note_1', kind: 'fact', title: 'Deploy ritual', body: 'Deploys go out on Tuesday mornings with the release:prod script; never on a Friday.', scope: 'project', projectRoot: 'C:/work/agent-dev-company', confirmation: 'user-confirmed', origin: 'reflect', trust: 0.6, useCount: 7, pinned: true, createdAt: NOW - 40 * DAY, updatedAt: NOW - 2 * DAY, lastUsedAt: NOW - DAY },
  { id: 'note_2', kind: 'note', title: 'Registry throttling', body: 'The npm registry keeps rate-limiting uploads during release windows; back off 60s and retry.', scope: 'global', confirmation: 'inferred', origin: 'reflect', trust: 0.15, useCount: 3, createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY },
  { id: 'note_3', kind: 'note', title: 'Unused idea', body: 'Consider a changelog bot that posts to the team channel every Monday.', scope: 'global', confirmation: 'inferred', origin: 'reflect', trust: 0, useCount: 0, createdAt: NOW - 80 * DAY, updatedAt: NOW - 80 * DAY }
];
const atlas = [
  { id: 'note_1', kind: 'note', title: 'Upload throttling lesson', body: 'Uploads keep getting throttled by the registry; exponential backoff with jitter fixed it.', scope: 'global', confirmation: 'user-confirmed', origin: 'reflect', trust: 0.5, useCount: 5, createdAt: NOW - 10 * DAY, updatedAt: NOW - 3 * DAY },
  { id: 'note_2', kind: 'skill', title: 'Playwright flake fix', body: 'Wait for networkidle before asserting on the table; the flake was a hydration race.', scope: 'stream', streamId: 'qa-sweep', confirmation: 'inferred', origin: 'notebook.write', trust: 0.2, useCount: 2, createdAt: NOW - 6 * DAY }
];

const input = () => ({
  agents: [{ agentId: 'nova', name: 'Nova' }, { agentId: 'atlas', name: 'Atlas' }],
  notebooks: { nova: nova.slice(), atlas: atlas.slice() },
  embeddings: {},
  now: NOW
});

// ---- nodes + edges ---------------------------------------------------------------------------------------
const g = SecondBrain.buildGraph(input());
A.eq(g.ok, true, 'buildGraph reports ok');
A.eq(g.stats.agents, 2, 'two agents');
A.eq(g.stats.memories, 5, 'five beliefs across both notebooks');
A.eq(g.nodes.filter(n => n.type === 'agent').length, 2, 'one agent node per notebook owner');
A.eq(g.nodes.filter(n => n.type === 'memory').length, 5, 'one memory node per record');
A.eq(g.edges.filter(e => e.type === 'wrote').length, 5, 'every belief is wired to its owner (wrote)');
A.eq(g.nodes.find(n => n.id === 'agent:nova').memories, 3, 'the agent node counts its own beliefs');
A.eq(g.nodes.find(n => n.id === 'mem:nova/note_1').pinned, true, 'pinned survives the projection');

// the cross-agent payoff: two agents independently learned the same registry lesson
const sim = g.edges.filter(e => e.type === 'similar' && e.crossAgent);
A.ok(sim.length >= 1, 'a paraphrase learned by two different agents becomes a cross-agent edge');
A.ok(sim.some(e => (e.source === 'mem:nova/note_2' && e.target === 'mem:atlas/note_1') || (e.source === 'mem:atlas/note_1' && e.target === 'mem:nova/note_2')),
  'the registry-throttling pair is the one that links');
A.eq(g.stats.crossAgentLinks, sim.length, 'stats.crossAgentLinks counts exactly the cross-agent edges');

// unrelated beliefs must NOT be welded together
const unrelated = g.edges.some(e => e.type === 'similar' &&
  ((e.source === 'mem:nova/note_3' && e.target === 'mem:atlas/note_2') || (e.source === 'mem:atlas/note_2' && e.target === 'mem:nova/note_3')));
A.ok(!unrelated, 'unrelated beliefs stay unconnected');

// ---- scope nodes + stats ---------------------------------------------------------------------------------
A.ok(g.nodes.some(n => n.type === 'project' && n.label === 'agent-dev-company'), 'a project node exists for the project-scoped belief');
A.ok(g.nodes.some(n => n.type === 'stream' && n.label === 'qa-sweep'), 'a stream node exists for the workstream-scoped skill');
A.eq(g.stats.totalRecalls, 17, 'recalls are the honest sum of useCount (7+3+0+5+2)');
A.eq(g.stats.pinned, 1, 'one pinned belief');
A.eq(g.stats.stale, 1, 'the 80-day-old never-recalled idea is stale');
A.eq(g.stats.byConfirmation['user-confirmed'], 2, 'two user-confirmed beliefs');
A.ok(g.stats.communities >= 1, 'community detection produces at least one neighbourhood');
A.ok(g.communities.every(c => c.members.length === c.size), 'each community size matches its member list');
A.ok(g.nodes.filter(n => n.type === 'concept').length === g.communities.length, 'one concept node per community');
A.ok(g.topUsed[0].useCount === 7 && g.topUsed[0].agentId === 'nova', 'topUsed ranks the most-recalled belief first');

// ---- determinism: same inputs + same clock => identical graph ---------------------------------------------
A.eq(JSON.stringify(SecondBrain.buildGraph(input())), JSON.stringify(SecondBrain.buildGraph(input())),
  'buildGraph is deterministic (no clock/random leaks)');

// ---- a notebook that exists on disk but is missing from the roster is still mapped ------------------------
const orphan = SecondBrain.buildGraph({ agents: [], notebooks: { ghost: [{ id: 'note_1', body: 'orphaned belief' }] }, now: NOW });
A.ok(orphan.nodes.some(n => n.id === 'agent:ghost'), 'a notebook with no roster entry still gets an agent node');
A.eq(orphan.nodes.find(n => n.id === 'agent:ghost').label, 'ghost', 'and falls back to its id as a label');

// ---- hardening: sparse / hostile records ------------------------------------------------------------------
const sparse = SecondBrain.buildGraph({ agents: [{ agentId: 'x' }], notebooks: { x: [null, {}, { title: 'only a title' }] }, now: NOW });
A.ok(sparse.ok, 'sparse records do not throw');
A.eq(sparse.stats.memories, 2, 'null entries are skipped, an empty object is still a belief');
A.eq(SecondBrain.buildGraph({}).stats.memories, 0, 'no input -> an empty graph, not a crash');

// ---- slug + wikilinks ------------------------------------------------------------------------------------
A.eq(SecondBrain.slug('Hello, World!'), 'hello-world', 'slug is filename-safe');
A.eq(SecondBrain.slug(''), 'untitled', 'an empty slug falls back');
A.eq(SecondBrain.wikilinks('see [[Deploy ritual]] and [[Other|alias]]'), ['Deploy ritual', 'Other'], 'wikilinks are extracted without aliases');

// ---- recallPulse: what a piece of text would surface ------------------------------------------------------
const hits = SecondBrain.recallPulse(g, 'the registry is throttling our uploads');
A.ok(hits.length >= 1, 'a probe returns at least one belief');
A.ok(hits.some(h => h.id === 'mem:atlas/note_1'), 'the throttling lesson is surfaced for a throttling probe');
A.eq(SecondBrain.recallPulse(g, ''), [], 'an empty probe surfaces nothing');

// ---- the vault -------------------------------------------------------------------------------------------
(async () => {
  let dir = null;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentos-brain-'));
    const records = {};
    for (const list of [nova, atlas]) {
      for (let i = 0; i < list.length; i++) {
        const r = SecondBrain.normalizeRecord(list === nova ? 'nova' : 'atlas', list[i], i);
        records[r.uid] = r;
      }
    }
    const graph = SecondBrain.buildGraph(input());
    const out = await Vault.writeVault({ fs: fs, fsp: fsp, path: path, root: dir, graph: graph, records: records, now: NOW });

    A.eq(out.ok, true, 'export reports ok');
    A.eq(out.counts.memories, 5, 'export counted every belief');
    A.eq(out.counts.agents, 2, 'export counted every agent');
    A.ok(out.files >= 14, 'the vault wrote its notes, views and graph (' + out.files + ' files)');

    const read = rel => fs.readFileSync(path.join(dir, rel), 'utf8');
    A.ok(fs.existsSync(path.join(dir, 'Brain.md')), 'Brain.md dashboard exists');
    A.ok(fs.existsSync(path.join(dir, 'Memories.base')), 'Memories.base exists');
    A.ok(fs.existsSync(path.join(dir, 'graph.json')), 'graph.json exists');
    A.ok(fs.existsSync(path.join(dir, 'Attach an AI.md')), 'the attach-an-AI prompt note exists');
    A.ok(fs.existsSync(path.join(dir, '.obsidian', 'graph.json')), 'Obsidian graph colour groups exist');

    const base = read('Memories.base');
    A.ok(base.indexOf('file.inFolder("Memories")') >= 0, '.base filters to the Memories folder');
    A.ok(base.indexOf('type: table') >= 0, '.base declares a table view');
    A.ok(base.indexOf('views:') >= 0, '.base declares views');

    const graphJson = JSON.parse(read('graph.json'));
    A.eq(graphJson.nodes.length, graph.nodes.length, 'graph.json carries every node');
    A.eq(graphJson.links.length, graph.edges.length, 'graph.json carries every link');
    A.ok(graphJson.nodes.every(n => 'id' in n && 'label' in n), 'every graph.json node is {id,label,...}');

    const brain = read('Brain.md');
    A.ok(brain.indexOf('![[Memories.base]]') >= 0, 'the dashboard embeds the base view');
    A.ok(brain.indexOf('Beliefs') >= 0, 'the dashboard states the belief count');

    // one memory note, frontmatter + provenance + a real neighbour link
    const memFiles = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else memFiles.push(p); } };
    walk(path.join(dir, 'Memories'));
    A.eq(memFiles.length, 5, 'one note per belief');
    const deploy = memFiles.find(f => fs.readFileSync(f, 'utf8').indexOf('Deploy ritual') >= 0);
    const deploySrc = fs.readFileSync(deploy, 'utf8');
    A.ok(deploySrc.startsWith('---\n'), 'the memory note opens with YAML frontmatter');
    A.ok(deploySrc.indexOf('type: "memory"') >= 0, 'frontmatter types the note as a memory');
    A.ok(deploySrc.indexOf('agent: "Nova"') >= 0, 'frontmatter names the agent');
    A.ok(deploySrc.indexOf('confirmation: "user-confirmed"') >= 0, 'frontmatter carries confirmation');
    A.ok(deploySrc.indexOf('use_count: 7') >= 0, 'frontmatter carries the recall count');
    A.ok(deploySrc.indexOf('## Provenance') >= 0, 'the note carries a provenance section');
    A.ok(deploySrc.indexOf('[[') >= 0, 'the note wikilinks into the graph');

    // idempotence: a second export over the same graph rewrites, never duplicates
    const before = memFiles.length;
    await Vault.writeVault({ fs: fs, fsp: fsp, path: path, root: dir, graph: SecondBrain.buildGraph(input()), records: records, now: NOW });
    const again = [];
    const walk2 = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk2(p); else again.push(p); } };
    walk2(path.join(dir, 'Memories'));
    A.eq(again.length, before, 'a re-export rewrites the same files (no duplicate notes)');

    // path safety: a record title can never escape the vault folder
    const evil = SecondBrain.buildGraph({ agents: [{ agentId: 'x', name: '../../owned' }], notebooks: { x: [{ id: 'note_1', title: '../../../../etc/passwd', body: 'x' }] }, now: NOW });
    const evilDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentos-brain-evil-'));
    await Vault.writeVault({ fs: fs, fsp: fsp, path: path, root: evilDir, graph: evil, records: {}, now: NOW });
    A.ok(fs.existsSync(evilDir), 'a hostile title still writes inside the vault root');
    A.ok(!fs.existsSync(path.join(evilDir, '..', '..', '..', '..', 'etc', 'passwd')), 'and never escapes it');
  } catch (e) {
    A.ok(false, 'vault export threw: ' + ((e && e.stack) || e));
  } finally {
    if (dir) { try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) {} }
  }
  A.report('secondbrain.test');
})();
