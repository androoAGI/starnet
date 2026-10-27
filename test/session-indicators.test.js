/* Real channel/session reducers drive the rail projection: no inferred runs or fake unreads. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Channels = require('../frontend/app/channels.js');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
let now = 2000;
const storeContext = vm.createContext({ Date: { now: () => now } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/workstreams.js'), 'utf8'), storeContext);
const Workstreams = storeContext.Workstreams;
const context = vm.createContext({
  Channels, Workstreams, Date: { now: () => now },
  agents: new Map([['nova', { name: 'NOVA' }]]),
  railFmtElapsed: ms => String(ms), railRelTime: () => '1m'
});
const names = ['railRowState(w)', 'railAgentName(w)', 'railAgentLine(w)', 'railModelFull(w)', 'railRowLabel(w, st, project = false)', 'railRowTip(w, st, project = false)'];
vm.runInContext(names.map(n => A.fnBody(app, 'function ' + n)).join('\n'), context);
const row = w => context.railRowState(w);
Workstreams.init({ workstreams: [
  { id: 'general', title: null },
  { id: 'a', agentId: 'nova', title: 'Review', lastActiveAt: 2000, lastReadAt: 1000 },
  { id: 'b', agentId: 'nova', title: 'Other', lastActiveAt: 1000, lastReadAt: 1000 }
], activeId: 'general', generalId: 'general' });
Channels.reset();
const a = Workstreams.get('a'), b = Workstreams.get('b');
A.eq(row(a).dot, 'ws-dot unseen', 'new activity in a closed session is unread');
A.eq(row(b).dot, 'ws-dot seen', 'read session remains quiet');
A.ok(context.railRowLabel(a, row(a)).includes('unread activity'), 'unread is named for assistive technology');
Workstreams.switch('a');
A.eq(row(a).dot, 'ws-dot seen', 'opening the actual session clears unread');
Workstreams.switch('general');
A.eq(row(a).dot, 'ws-dot seen', 'leaving a read session does not relight it');

now = 3000;
Channels.begin('a', now);
A.eq(row(a).dot, 'ws-dot connecting', 'send/connecting is never shown as confirmed work');
A.eq(row(a).meta, 'Connecting', 'no elapsed work is claimed while connecting');
A.ok(context.railRowLabel(a, row(a)).includes('connecting'), 'connecting state is accessible');
now = 4000;
Channels.setRunId('a', 'run-a', now);
Workstreams.appendRun('a', 'run-a', now);
now = 12000;
A.eq(row(a).dot, 'ws-dot working', 'server-confirmed run enters the working state');
A.eq(row(a).meta, '8000', 'elapsed starts at confirmed run time');
A.eq(row(b).dot, 'ws-dot seen', 'a different session on the same agent does not light up');
A.ok(context.railRowLabel(a, row(a)).includes('thinking'), 'working status is named for screen readers');
Channels.setPending('a', { tool: 'fs.write', promptId: 'approval' }, 6000);
A.eq(row(a).dot, 'ws-dot needsyou approval', 'pending approval outranks the working animation');
A.eq(row(a).meta, 'Approval needed', 'approval has an explicit visible label');
A.ok(context.railRowTip(a, row(a)).includes('awaiting your approval'), 'tooltip explains the actual approval state');
Channels.clearPending('a', 11000);
A.eq(row(a).dot, 'ws-dot working', 'resolving approval returns to the same confirmed run');
A.eq(row(a).meta, '3000', 'approval waiting time is excluded after resume');
A.ok(!context.railRowTip(a, row(a)).includes('awaiting'), 'resumed tooltip no longer claims a pending approval');
Channels.setPending('a', { tool: 'brief.ask', promptId: 'question' }, now);
A.eq(row(a).dot, 'ws-dot needsyou reply', 'an agent question has its own reply signal');
A.eq(row(a).meta, 'Reply needed', 'a question cannot masquerade as approval');
now = 13000;
Channels.clearPending('a', now);
Channels.end('a');
Workstreams.noteRunEnd('a', 'run-a', true);
Workstreams.touch('a');
A.eq(row(a).dot, 'ws-dot unseen', 'completed background activity becomes steadily unread');
Workstreams.switch('a');
A.eq(row(a).dot, 'ws-dot seen', 'opening the completed conversation marks it read');
Workstreams.init(Workstreams.serialize());
A.eq(row(Workstreams.get('a')).dot, 'ws-dot seen', 'read status survives save hydration');
let savedA = Workstreams.get('a');
Workstreams.appendRun('a', 'run-failed', 3000);
Workstreams.noteRunEnd('a', 'run-failed', false);
A.eq(row(savedA).dot, 'ws-dot failed', 'a recorded failure is not a live approval');
A.eq(row(savedA).busy, false, 'failure is not reported as ongoing work');
A.eq(row(savedA).meta, '1m', 'failure keeps the normal timestamp instead of a duplicate FAILED label');
A.eq(row(savedA).attn, false, 'a settled failure does not create the approval action row');
A.ok(context.railRowLabel(savedA, row(savedA)).includes('last run failed'), 'failure remains accessible without a visible badge');
A.ok(context.railRowTip(savedA, row(savedA), true).includes('last run failed'), 'project rows keep failure details in their tooltip');
Workstreams.init(Workstreams.serialize());
A.eq(row(Workstreams.get('a')).dot, 'ws-dot failed', 'failed marker survives saved-state hydration');
savedA = Workstreams.get('a');

Channels.setPending('a', { tool: 'fs.write', promptId: 'early' });
A.eq(row(savedA).dot, 'ws-dot needsyou approval', 'a real prompt is visible even before a run-start event');
Channels.clearPending('a');
Workstreams.appendRun('a', 'run-new', 4000);
Channels.begin('a', 4000);
A.eq(row(savedA).dot, 'ws-dot connecting', 'a new attempt clears the stale failure signal');
Channels.reset();
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/glass-demo.css'), 'utf8');
A.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ws-dot::before \{ animation: none; \}/.test(css), 'reduced motion disables both lamp and scan animation');
A.ok(/\.ws-dot\.failed \{[^}]*animation: gd-session-failure/.test(css), 'failure X has its own flashing animation');
A.ok(/railRowTip\(w, st, project\), tipAttr/.test(app), 'in-place rail updates refresh adopted tooltip text along with the signal');
A.ok(context.railRowLabel(savedA, row(savedA), true).includes(row(savedA).status), 'project session rows share the current state label');
A.ok(!context.railRowLabel(savedA, row(savedA), true).includes('Shift+F10'), 'project sessions do not advertise unsupported action shortcuts');
A.ok(!context.railRowTip(savedA, row(savedA), true).includes('right-click'), 'project session tooltip names its real open action');

// review app-shell-ui-05: the "N working" crew lamp reads the delegation ledger, and the ledger stops vouching for
// running workers once the station stops answering — the lamp must not keep pulsing through an outage
{
  Channels.reset();
  const quiet = Workstreams.get('b');
  let fresh = true;
  context.Overseer = { snapshot: () => ({ workers: [{ runId: 'w1', status: 'running', parentStreamId: 'b' }, { runId: 'w2', status: 'running', parentStreamId: 'b' }] }), fresh: () => fresh };
  A.eq([row(quiet).dot, row(quiet).meta, row(quiet).busy], ['ws-dot working', '2 working', true], 'a fresh ledger with two running workers lights the asking conversation');
  fresh = false;
  const st = row(quiet);
  A.ok(st.dot !== 'ws-dot working' && !st.busy, 'station unreachable: the row no longer pulses as working');
  A.ok(!/working/.test(st.meta) && /unknown/.test(st.meta), 'station unreachable: the row says the crew state is unknown, not "2 working"');
  A.ok(/unreachable/.test(st.status) && /unknown/.test(st.status), 'the row tip says why the crew state is unknown');
  delete context.Overseer;
}
// All row layouts share this projection. Execute the real escaping/name/state helpers; these controls do
// not claim that native CSS layout, clipping or focus geometry has been verified.
{
  const util = fs.readFileSync(path.join(__dirname, '../frontend/js/util.js'), 'utf8');
  const start = util.indexOf('  esc(s) {'), end = util.indexOf('\n  // seeded-ish', start);
  A.ok(start >= 0 && end > start && end - start < 500, 'the control uses the bounded production escaping method');
  vm.runInContext('this.U = {' + util.slice(start, end) + '};', context);
  const members = { pair: ['cypher', 'ultron'], crew: ['cypher', 'mira', 'ultron', 'rook', 'vex'] };
  const groupState = {};
  context.GroupChat = { membersOf: id => members[id] || null, stateOf: id => groupState[id] || null };
  for (const id of ['ultron', 'cypher', 'mira', 'rook', 'vex']) context.agents.set(id, { name: id.toUpperCase() });
  const title = 'Launch plan — website, pricing, delivery, and QA follow-up & decisions';
  const pair = { id: 'pair', agentId: 'ultron', conversationMode: 'group', title };
  const crew = { id: 'crew', agentId: 'ultron', conversationMode: 'group', title };
  A.eq(context.railAgentLine(pair), '<span class="ws-agent-names">ULTRON, CYPHER</span>', 'two members show their names, lead first, without a +0');
  A.eq(context.railAgentLine(crew), '<span class="ws-agent-names">ULTRON, CYPHER</span><span class="ws-agent-more">+3</span>', 'five members keep the remaining count separate from the first two names');
  A.eq(context.railAgentName(crew), 'ULTRON + CYPHER + MIRA + ROOK + VEX', 'accessible identity retains every member in lead-first order');
  A.eq(context.railRowLabel(crew, row(crew)), title + ' group chat, ULTRON + CYPHER + MIRA + ROOK + VEX, read; Enter to open; Shift+F10 for actions', 'custom long titles do not replace accessible crew membership or keyboard actions');
  for (const question of [true, false]) {
    groupState.crew = { questions: question ? 1 : 0, approvals: question ? 0 : 1, busy: true };
    A.eq([row(crew).attn, row(crew).meta], [true, question ? 'Reply needed' : 'Approval needed'], 'group attention reads the actual pending-request state');
    A.ok(context.railRowLabel(crew, row(crew)).includes(question ? 'waiting for your answer' : 'awaiting your approval'), 'the full crew label retains the truthful pending request');
    A.eq(context.railAgentLine(crew), '<span class="ws-agent-names">ULTRON, CYPHER</span><span class="ws-agent-more">+3</span>', 'attention does not replace or shorten the crew identity');
  }
  members.crew = ['ultron', 'vex']; delete groupState.crew;
  A.eq(context.railAgentLine(crew), '<span class="ws-agent-names">ULTRON, VEX</span>', 'membership shrink removes the stale overflow count');
  context.agents.set('ultron', { name: 'UL<&"\'' });
  members.pair = ['ultron', 'missing<&'];
  A.eq(context.railAgentLine(pair), '<span class="ws-agent-names">UL&lt;&amp;&quot;&#39;, missing&lt;&amp;</span>', 'names and unknown roster-ID fallbacks are escaped by production U.esc');
  A.eq(context.railAgentLine({ ...pair, conversationMode: 'direct' }), 'UL&lt;&amp;&quot;&#39;', 'a direct conversation ignores group membership and keeps its escaped agent name');
  A.eq(context.railAgentLine({ ...pair, id: 'unknown' }), 'UL&lt;&amp;&quot;&#39;', 'unknown group membership never invents a count or a second member');
}
// The default COMPACT layout (Andrew 10-13: a group row must read "AGENT, AGENT +3", never nothing and never a
// shrunken chip). The names line above is only half of it: COMPACT hides .ws-agent for every row, so the group line
// needs its own compact rules. These read the shipped stylesheet's real rules (comments stripped), not prose.
{
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sels: m[1].split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, ' ')), body: m[2] }));
  const decl = (sel, prop) => {
    let v = null;
    for (const r of rules) if (r.sels.includes(sel)) { const m = r.body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)')); if (m) v = m[1].trim(); }
    return v;
  };
  A.eq(decl('.ws-agent', 'display'), 'none', 'COMPACT still hides the agent line by default (direct rows keep their one-line layout)');
  A.eq(decl('body:not(.rows-inbox) #workstreams .ws-agent.ws-agent-group', 'display'), 'flex', 'a group row shows its crew identity line in COMPACT');
  A.eq(decl('body:not(.rows-inbox) #workstreams .ws-agent.ws-agent-group', 'font-size'), '14px', 'the compact crew line sits at the 14px glass floor, not a shrunken chip (walk 10-14 #6: it was 12px under a 17px title)');
  const grid = 'body:not(.rows-inbox) #workstreams .ws-row:has(> .ws-agent-group)';
  A.eq(decl(grid, 'display'), 'grid', 'a compact group row lays the identity on its own line');
  // the names own a whole line; the row's time/status ends the title line (rc walk 10-14: "NOVA, … +1  Working"). Title first
  // (Andrew 10-27: a gold names line over an unaligned title "looks hideous"): the row opens like every other row
  A.ok(/"dot title pin meta"\s*"\. agent agent agent"/.test(decl(grid, 'grid-template-areas') || ''), 'the title opens the row; the names take the whole line under it; the pin and status end the title line (no shared cell can widen under the names)');
  const attnAreas = decl('body:not(.rows-inbox) #workstreams .ws-row.attn:has(> .ws-agent-group)', 'grid-template-areas') || '';
  A.ok(/^"dot title title pin"\s*"\. agent agent agent"/.test(attnAreas), 'a waiting group row opens on its title too, its names under it');
  A.ok(/"dot agent agent agent"\s*"title title pin meta"\s*"recpt recpt recpt recpt"/.test(decl('body.rows-inbox #workstreams .ws-row:has(> .ws-agent-group)', 'grid-template-areas') || ''),
    'INBOX: a group row\'s names own the top line too (a "Connecting" status squeezed them to 0px)');
  // the shipped glass INBOX look (pipglass.css) lays its own rows: the same law there, and two real names too wide for the
  // rail at headline size wrap at a space instead of ending in "…"
  const glass = fs.readFileSync(path.join(__dirname, '../frontend/css/pipglass.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  A.ok(/\.ws-row:not\(\.attn\):has\(> \.ws-agent-group\) \{\s*grid-template-areas:\s*"dot agent agent agent"\s*"\.\s+title pin\s+meta";/.test(glass), 'glass INBOX: the names own line 1, the pin and status end the title line');
  A.ok(/\.ws-agent-group > \.ws-agent-names \{ display: inline; white-space: normal; overflow: visible; text-overflow: clip; \}/.test(glass), 'glass INBOX: the names wrap, never ellipsize');
  const attn = 'body:not(.rows-inbox) #workstreams .ws-row.attn:has(> .ws-agent-group)';
  A.ok(/"\. meta meta menu"/.test(decl(attn, 'grid-template-areas') || ''), 'an attention group row keeps its request and its menu in separate cells');
  A.eq(decl(attn + ' > .ws-kebab', 'grid-area'), 'menu', 'the kebab takes the menu cell, not the request');
  A.eq(decl('.ws-row:hover .ws-meta', 'display'), 'none', 'other rows still swap their meta for the kebab on hover');
  A.eq(decl('body:not(.rows-inbox) #workstreams .ws-row.attn:not(.renaming):has(> .ws-agent-group):is(:hover, :focus-within) > .ws-meta:not(:empty)', 'display'), 'block', 'hover or focus never hides a group row’s pending request');
}
A.report('session-indicators.test');
