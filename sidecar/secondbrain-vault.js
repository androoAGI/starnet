/* sidecar/secondbrain-vault.js — the second brain, ON DISK, as an Obsidian vault.

   Why a vault and not a database. The graph in secondbrain.js is a live projection: rebuild it from the store
   at any time and it is correct again. But a projection you can only see inside the app is a projection you
   cannot carry to another tool, diff, back up, or hand to an AI. Writing it out as Markdown makes every belief
   a first-class file: Obsidian's native graph view lights up from the [[wikilinks]], the Bases core plugin
   gives the database views (`.base`), and any CLI (graphify included) can read a vault of plain files.

   What is written per export (idempotent — same graph => same paths, rewritten in place):
     Brain.md                     dashboard; embeds the .base views
     Memories.base                every memory, table + cards
     Agents.base                  the crew, sized by learned beliefs
     Concepts.base                the detected communities
     Preferences.base             the Commander's taste (origin: feedback)
     Stale.base                   beliefs nothing has recalled in 30 days
     Agents/<name>.md             one hub note per agent
     Memories/<Agent>/<slug>.md   one note per belief, with provenance + related links
     Projects/<slug>.md           one note per blessed project
     Streams/<slug>.md            one note per workstream
     Concepts/<slug>.md           one note per community
     graph.json                   node/link graph, graphify-shaped
     .obsidian/graph.json         graph view colour groups per agent
     Attach an AI.md              the paste-in prompt that wires another AI into this brain

   The writer is IO-only: it takes an already-built graph, so the graph logic stays pure and testable. */
'use strict';

const GENERATED_BY = 'Agent OS · Second Brain';

function yamlValue(v) {
  if (v == null) return '""';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return '[' + v.map(x => yamlValue(x)).join(', ') + ']';
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"';
}

function frontmatter(obj) {
  const lines = ['---'];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    lines.push(k + ': ' + yamlValue(v));
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function mdEscape(s) { return String(s == null ? '' : s).replace(/\r\n/g, '\n'); }

function isoDate(ms) {
  const n = Number(ms) || 0;
  if (!n) return '';
  try { return new Date(n).toISOString(); } catch (_) { return ''; }
}

// Obsidian resolves links by filename, so a duplicate display name has to be disambiguated or the graph welds
// two unrelated beliefs into one node. We keep a per-export registry and suffix collisions deterministically.
function makeNamer() {
  const used = {};
  return function name(base) {
    let n = base;
    let i = 2;
    while (used[n]) { n = base + ' ' + i; i++; }
    used[n] = 1;
    return n;
  };
}

function memoryFileName(rec) {
  // a graph NODE carries `label` while the normalized RECORD carries `title`; both name the same note, and a
  // node named only by its record id would write Memories/Nova/note_1.md — unreadable in Obsidian's file list.
  const title = String(rec.title || rec.label || '').trim();
  const base = title || String(rec.body || '').split('\n')[0].slice(0, 60) || rec.recordId;
  return base.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || rec.recordId;
}

/* ---- .base files ----
   Bases syntax (Obsidian core plugin): `filters` / `formulas` / `properties` / `views`. Every view below is a
   real filter over the notes this exporter writes — a filter that matches nothing is a visible empty view, which
   is the honest failure (you can see the brain is empty) rather than a silently invented row. */
function memoriesBase() {
  return `# Agent OS · Second Brain — every belief the station holds.
# Open with the Obsidian Bases core plugin (Obsidian 1.9+). Each row is one note under Memories/.
filters:
  and:
    - file.inFolder("Memories")
    - 'type == "memory"'
formulas:
  trust_pct: '(trust * 100).round(0)'
  days_since_recall: '((now() - file.mtime) / 86400000).round(0)'
properties:
  agent:
    displayName: Agent
  kind:
    displayName: Kind
  scope:
    displayName: Scope
  confirmation:
    displayName: Confirmation
  trust_pct:
    displayName: Trust %
  use_count:
    displayName: Recalls
  project:
    displayName: Project
views:
  - type: table
    name: By trust
    order:
      - file.name
      - agent
      - kind
      - scope
      - confirmation
      - trust_pct
      - use_count
      - file.mtime
    sort:
      - property: trust_pct
        direction: DESC
  - type: table
    name: Never recalled
    filters:
      and:
        - 'use_count == 0'
    order:
      - file.name
      - agent
      - kind
      - file.mtime
  - type: cards
    name: Cards
    order:
      - file.name
      - agent
      - kind
`;
}

function agentsBase() {
  return `filters:
  and:
    - file.inFolder("Agents")
    - 'type == "agent"'
properties:
  memories:
    displayName: Beliefs
  pinned:
    displayName: Pinned
  communities:
    displayName: Neighbourhoods
views:
  - type: table
    name: Crew
    order:
      - file.name
      - memories
      - pinned
      - communities
    sort:
      - property: memories
        direction: DESC
`;
}

function conceptsBase() {
  return `filters:
  and:
    - file.inFolder("Concepts")
    - 'type == "concept"'
properties:
  size:
    displayName: Beliefs
  agents:
    displayName: Agents
views:
  - type: table
    name: Neighbourhoods
    order:
      - file.name
      - size
      - agents
    sort:
      - property: size
        direction: DESC
`;
}

function preferencesBase() {
  return `filters:
  and:
    - file.inFolder("Memories")
    - 'type == "memory"'
    - 'origin == "feedback"'
properties:
  agent:
    displayName: Given to
  trust_pct:
    displayName: Trust %
  use_count:
    displayName: Recalls
formulas:
  trust_pct: '(trust * 100).round(0)'
views:
  - type: table
    name: Taste
    order:
      - file.name
      - agent
      - trust_pct
      - use_count
      - file.mtime
`;
}

function staleBase() {
  return `filters:
  and:
    - file.inFolder("Memories")
    - 'type == "memory"'
    - 'use_count == 0'
formulas:
  age_days: '((now() - file.mtime) / 86400000).round(0)'
views:
  - type: table
    name: Never recalled
    order:
      - file.name
      - agent
      - age_days
    sort:
      - property: age_days
        direction: DESC
`;
}

function brainDashboard(stats, generatedAt) {
  const when = isoDate(generatedAt) || 'just now';
  return `---
type: dashboard
generated_by: ${yamlValue(GENERATED_BY)}
generated_at: ${yamlValue(when)}
---

# Agent OS — Second Brain

One graph over every agent's memory. Regenerate any time from Agent OS › BRAIN › EXPORT TO OBSIDIAN.
This folder is **generated**: edit beliefs in the app, not here, or the next export will rewrite the file.

## The station right now

| | |
| --- | --- |
| Agents | **${stats.agents}** |
| Beliefs | **${stats.memories}** |
| Links | **${stats.edges}** |
| Neighbourhoods | **${stats.communities}** |
| Cross-agent links | **${stats.crossAgentLinks}** |
| Average trust | **${stats.avgTrust}** |
| Recalls (lifetime) | **${stats.totalRecalls}** |
| Never recalled | **${stats.stale}** |

## Views

![[Memories.base]]
![[Concepts.base]]
![[Preferences.base]]
`;
}

function agentNote(agent, graph, stats, naming) {
  const name = naming(agent.label || agent.agentId);
  const mems = graph.nodes.filter(n => n.type === 'memory' && n.agentId === agent.agentId);
  const comms = graph.communities.filter(c => c.agents && c.agents.indexOf(agent.agentId) >= 0);
  const recent = mems.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 25);
  const body = recent.map(m => '- [[' + m.brainName + ']]' + (m.pinned ? ' (pinned)' : '')).join('\n');
  return {
    name: name,
    content: frontmatter({
      type: 'agent', agent: agent.label, agent_id: agent.agentId,
      memories: mems.length, pinned: mems.filter(m => m.pinned).length,
      communities: comms.length, generated_by: GENERATED_BY,
      tags: ['agent-os/agent']
    }) + '\n# ' + mdEscape(agent.label) + '\n\n' +
      'Part of the [[Brain]] — ' + mems.length + ' belief' + (mems.length === 1 ? '' : 's') + ', in ' +
      comms.length + ' neighbourhood' + (comms.length === 1 ? '' : 's') + '.\n\n' +
      '## Neighbourhoods\n\n' + (comms.length ? comms.map(c => '- [[' + c.brainName + ']] — ' + c.size + ' beliefs').join('\n') : '_none yet_') + '\n\n' +
      '## Recent beliefs\n\n' + (body || '_nothing learned yet_') + '\n'
  };
}

// One memory note. Provenance is the point: who holds it, how it was learned, how it has been treated since.
function memoryNote(rec, agentLabel, naming, graph) {
  const base = memoryFileName(rec);
  const name = naming(base);
  const project = rec.projectRoot ? rec.projectRoot.split(/[\\/]/).filter(Boolean).pop() : '';
  const related = graph.edges
    .filter(e => (e.source === 'mem:' + rec.uid || e.target === 'mem:' + rec.uid) && (e.type === 'similar' || e.type === 'references'))
    .map(e => (e.source === 'mem:' + rec.uid ? e.target : e.source))
    .map(id => graph.nodes.find(n => n.id === id))
    .filter(Boolean)
    .slice(0, 12);
  const tags = ['agent-os/memory', 'agent/' + rec.agentId, 'kind/' + rec.kind]
    .concat(rec.origin ? ['origin/' + rec.origin] : [])
    .concat(rec.confirmation === 'user-confirmed' ? ['confirmed'] : ['inferred']);
  const fm = frontmatter({
    type: 'memory',
    agent: agentLabel,
    agent_id: rec.agentId,
    kind: rec.kind,
    scope: rec.scope,
    project: project,
    stream: rec.streamId || '',
    confirmation: rec.confirmation,
    origin: rec.origin || '',
    authority: rec.authority,
    trust: Math.round(rec.trust * 1000) / 1000,
    use_count: rec.useCount,
    pinned: rec.pinned,
    created: isoDate(rec.createdAt),
    updated: isoDate(rec.updatedAt),
    last_used: isoDate(rec.lastUsedAt),
    source_run: rec.sourceRunId || '',
    generated_by: GENERATED_BY,
    tags: tags
  });
  const body = mdEscape(rec.body || rec.title || '');
  const prov = [
    '- **Agent:** [[' + agentLabel + ']]',
    '- **Kind:** ' + rec.kind,
    '- **Scope:** ' + rec.scope + (project ? ' · ' + project : ''),
    '- **Confirmation:** ' + rec.confirmation,
    '- **Trust:** ' + (Math.round(rec.trust * 100) / 100) + ' · **recalled** ' + rec.useCount + '×',
    rec.origin ? '- **Learned by:** ' + rec.origin : '',
    rec.pinned ? '- **Pinned:** yes' : ''
  ].filter(Boolean).join('\n');
  return {
    name: name,
    content: fm + '\n# ' + mdEscape(rec.title || name) + '\n\n' + body + '\n\n' +
      '## Provenance\n\n' + prov + '\n' +
      (related.length ? '\n## Related\n\n' + related.map(r => '- [[' + (r.brainName || r.label || r.id) + ']] — ' + r.kind).join('\n') + '\n' : '')
  };
}

function scopeNote(kind, label, pathOrId, members, naming) {
  const name = naming(label);
  return {
    name: name,
    content: frontmatter({ type: kind, path: pathOrId, memories: members.length, generated_by: GENERATED_BY, tags: ['agent-os/' + kind] }) +
      '\n# ' + mdEscape(label) + '\n\n' + members.length + ' belief' + (members.length === 1 ? '' : 's') + '.\n\n' +
      members.map(m => '- [[' + m.brainName + ']]').join('\n') + '\n'
  };
}

function conceptNote(c, members, naming) {
  const name = naming(c.label || 'Concept');
  c.brainName = name;
  return {
    name: name,
    content: frontmatter({ type: 'concept', size: members.length, agents: c.agents, generated_by: GENERATED_BY, tags: ['agent-os/concept'] }) +
      '\n# ' + mdEscape(c.label) + '\n\n' +
      'A neighbourhood of ' + members.length + ' belief' + (members.length === 1 ? '' : 's') + ' across ' + c.agents.length + ' agent' + (c.agents.length === 1 ? '' : 's') + '.\n\n' +
      members.map(m => '- [[' + m.brainName + ']] — ' + m.agentId).join('\n') + '\n'
  };
}

function attachNote(roster) {
  return `---
type: guide
generated_by: ${yamlValue(GENERATED_BY)}
tags: [agent-os/guide]
---

# Attach an AI to this brain

Point any AI at this folder (an Obsidian vault is just Markdown) and give it this brief:

\`\`\`text
You are connected to my Agent OS second brain at <PATH TO THIS VAULT>.

Before answering anything about me, my projects, or my preferences:
1. Read Brain.md, then the .base views it embeds (Memories.base, Concepts.base, Preferences.base).
2. Search Memories/ for the 5 most relevant notes using their frontmatter (agent, kind, scope, tags) and body text.
3. Treat "confirmation: inferred" notes as unconfirmed hypotheses; "user-confirmed" as fact.
4. Weigh trust and use_count: high-trust, recently recalled beliefs outrank cold ones.
5. When you learn something durable about me, propose it back in this exact note shape:

---
type: memory
agent: <your name>
kind: note | fact | profile | skill
scope: global | project | stream
confirmation: inferred
origin: <how you learned it>
trust: 0
use_count: 0
tags: [agent-os/memory]
---
# <short title>

<one belief, stated plainly. One idea per note.>

Never rewrite a note you did not create. Never touch Brain.md (generated).
\`\`\`

## Agents currently in this brain

${roster.length ? roster.map(a => '- [[' + a + ']]').join('\n') : '_none yet_'}
`;
}

/* writeVault({ fs, fsp, path, root, graph, now, roster }) -> { ok, root, files, counts }
   `fs`/`fsp` are injected (the sidecar composes them) so this stays free of ambient IO imports. */
async function writeVault(deps) {
  deps = deps || {};
  const fs = deps.fs, fsp = deps.fsp, pathMod = deps.path;
  const root = deps.root;
  const graph = deps.graph;
  if (!fs || !fsp || !pathMod) throw new Error('writeVault: fs/fsp/path required');
  if (!root) throw new Error('writeVault: root required');
  if (!graph || !Array.isArray(graph.nodes)) throw new Error('writeVault: graph required');
  const now = Number(deps.now) || Date.now();
  const roster = Array.isArray(deps.roster) ? deps.roster : [];

  const dirs = ['', 'Agents', 'Memories', 'Projects', 'Streams', 'Concepts', '.obsidian'];
  for (const d of dirs) await fsp.mkdir(pathMod.join(root, d), { recursive: true });

  const written = [];
  const write = async (rel, content) => {
    const full = pathMod.join(root, rel);
    await fsp.mkdir(pathMod.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
    written.push(rel);
  };

  // ---- name every node FIRST: a memory note refers to its neighbours by [[name]], so the registry has to be
  // complete before any body is rendered (otherwise the first note written would link to a stale name).
  const naming = makeNamer();
  naming('Brain'); naming('Attach an AI');
  const agentNodes = graph.nodes.filter(n => n.type === 'agent');
  for (const a of agentNodes) a.brainName = naming(a.label || a.agentId);
  for (const c of graph.communities) c.brainName = naming(c.label || c.id);
  const memNodes = graph.nodes.filter(n => n.type === 'memory');
  for (const m of memNodes) m.brainName = naming(memoryFileName(m));

  const agentLabelOf = {};
  for (const a of agentNodes) agentLabelOf[a.agentId] = a.brainName;
  for (const m of memNodes) if (!agentLabelOf[m.agentId]) agentLabelOf[m.agentId] = String(m.agentId);

  // ---- agents ----
  for (const a of agentNodes) {
    const note = agentNote(a, graph, graph.stats, n => a.brainName || n);
    await write(pathMod.join('Agents', note.name + '.md'), note.content);
  }

  // ---- memories, grouped one folder per agent (a vault with 400 notes in one folder is unreadable; the graph
  // is what makes it navigable, the folders keep the file list honest) ----
  for (const m of memNodes) {
    const rec = (deps.records && deps.records[m.agentId + '/' + m.recordId]) || m;
    const agentFolder = (agentLabelOf[m.agentId] || m.agentId).replace(/[\\/:*?"<>|]/g, '-');
    const note = memoryNote(rec, agentLabelOf[m.agentId] || m.agentId, () => m.brainName, graph);
    m.brainName = note.name;
    await write(pathMod.join('Memories', agentFolder, note.name + '.md'), note.content);
  }

  // ---- projects + streams ----
  for (const p of graph.nodes.filter(n => n.type === 'project')) {
    const members = memNodes.filter(m => m.projectRoot && String(m.projectRoot).replace(/\\/g, '/').replace(/\/+$/, '') === p.path);
    const note = scopeNote('project', p.label, p.path, members, () => p.brainName || p.label);
    p.brainName = note.name;
    await write(pathMod.join('Projects', note.name + '.md'), note.content);
  }
  for (const s of graph.nodes.filter(n => n.type === 'stream')) {
    const members = memNodes.filter(m => m.streamId === s.label);
    const note = scopeNote('stream', s.label, s.label, members, () => s.brainName || s.label);
    s.brainName = note.name;
    await write(pathMod.join('Streams', note.name + '.md'), note.content);
  }

  // ---- communities ----
  for (const c of graph.communities) {
    const members = c.members.map(id => graph.nodes.find(n => n.id === id)).filter(Boolean);
    const note = conceptNote(c, members, () => c.brainName || c.label);
    await write(pathMod.join('Concepts', note.name + '.md'), note.content);
  }

  // ---- the views + dashboard ----
  await write('Memories.base', memoriesBase());
  await write('Agents.base', agentsBase());
  await write('Concepts.base', conceptsBase());
  await write('Preferences.base', preferencesBase());
  await write('Stale.base', staleBase());
  await write('Brain.md', brainDashboard(graph.stats, now));

  // ---- graphify-shaped graph: nodes/links with a community per node, which is what graphify's own output
  // looks like and what any graph tool can consume without knowing Agent OS's record schema ----
  const communityOf = {};
  for (const c of graph.communities) for (const id of c.members) communityOf[id] = c.brainName || c.label;
  await write('graph.json', JSON.stringify({
    generated_by: GENERATED_BY,
    generated_at: isoDate(now),
    nodes: graph.nodes.map(n => ({
      id: n.id,
      label: n.brainName || n.label || n.id,
      type: n.type,
      agent: n.agentId || null,
      kind: n.kind || null,
      community: communityOf[n.id] || null,
      trust: n.trust != null ? n.trust : undefined,
      use_count: n.useCount != null ? n.useCount : undefined,
      file: n.type === 'memory' ? 'Memories/' + (n.brainName || '') + '.md' :
        n.type === 'agent' ? 'Agents/' + (n.brainName || '') + '.md' :
          n.type === 'concept' ? 'Concepts/' + (n.brainName || '') + '.md' : null
    })),
    links: graph.edges.map(e => ({ source: e.source, target: e.target, type: e.type, weight: e.weight, via: e.via || null }))
  }, null, 2));

  // ---- Obsidian graph view: colour the crew apart, so opening the vault's graph LOOKS like the in-app brain ----
  const colorGroups = [];
  const palette = ['#ffd34a', '#6fb3bf', '#7bc88a', '#d99a5a', '#a888c0', '#cf7d96'];
  let ci = 0;
  for (const a of agentNodes) {
    colorGroups.push({ query: 'tag:#agent/' + a.agentId, color: { a: 1, rgb: hexToInt(colorFor(a, palette, ci++)) } });
  }
  await write(pathMod.join('.obsidian', 'graph.json'), JSON.stringify({
    'collapse-filter': false,
    'search': '',
    'showTags': true,
    'showAttachments': false,
    'hideUnresolved': false,
    'showOrphans': true,
    'colorGroups': colorGroups,
    'showArrow': true,
    'textFadeMultiplier': 0,
    'nodeSizeMultiplier': 1.1,
    'lineSizeMultiplier': 1
  }, null, 2));

  await write('Attach an AI.md', attachNote(agentNodes.map(a => a.brainName || a.label)));

  return {
    ok: true,
    root: root,
    files: written.length,
    counts: { agents: agentNodes.length, memories: memNodes.length, concepts: graph.communities.length, edges: graph.edges.length },
    generatedAt: now
  };
}

function colorFor(node, palette, i) { return node.color || palette[i % palette.length]; }
function hexToInt(hex) {
  const s = String(hex || '#ffd34a').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map(c => c + c).join('') : s, 16);
  return isFinite(n) ? n : 0xffd34a;
}

module.exports = { writeVault, memoriesBase, agentsBase, conceptsBase, preferencesBase, staleBase, GENERATED_BY };
