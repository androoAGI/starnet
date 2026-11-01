'use strict';
/* node test/needs-you.test.js — NEEDS YOU (2026-10-11): every ask and failure on the station in ONE list atop SESSIONS.
   GENUINE: NeedsYou.items reads only provable state (open asks per conversation incl. a delegated worker's stamped ask,
   group chats waiting, the overseer ledger's failed workers, unread failed routines), orders it (asks oldest first,
   then failures newest first), gives each kind its real action, and forgets a failure once dismissed or stale.
   SOURCE-LOCKED: the rail renders it in place of the retired "Waiting for you" filter, and the page loads it. */
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const NOW = 10 * 86400000;
const store = new Map();
global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const sessions = new Map([
  ['home', { id: 'home', title: null, agentId: 'agent' }],
  ['proj', { id: 'proj', title: 'Launch prep', agentId: 'agent' }],
  ['grp', { id: 'grp', title: 'War room', agentId: 'agent', conversationMode: 'group' }],
  ['cron-r1', { id: 'cron-r1', title: 'Inbox sweep', agentId: 'writer', lastRunOk: false, lastActiveAt: NOW - 60000, automation: { kind: 'routine', id: 'job1', name: 'Inbox sweep' } }],
  ['cron-r2', { id: 'cron-r2', title: 'Morning news', agentId: 'agent', lastRunOk: true, lastActiveAt: NOW - 60000 }]
]);
const unread = new Set(['cron-r1', 'cron-r2']);
global.Workstreams = { get: id => sessions.get(id) || null, list: () => [...sessions.values()], unread: w => unread.has(w.id), generalId: () => 'home', markRead: id => unread.delete(id) };
const pend = [
  { wsId: 'home', p: { promptId: 'p2', tool: 'mcp__gmail__send', agentId: 'agent', workerAgentId: 'writer', workerStreamId: 'thread_vex', askedAt: NOW - 120000 } },
  { wsId: 'proj', p: { promptId: 'p1', tool: 'brief.ask', agentId: 'agent', argsSummary: JSON.stringify({ question: 'Which price tier should lead?' }), askedAt: NOW - 600000 } },
  { wsId: 'gone', p: { promptId: 'p9', tool: 'fs.write', askedAt: 1 } }
];
global.Channels = { allPending: () => pend };
global.GroupChat = { attentionIds: () => ['grp'], stateOf: () => ({ approvals: 1 }), membersOf: id => id === 'grp' ? ['writer', 'agent', 'researcher'] : null };
global.Overseer = { snapshot: () => ({ workers: [
  { runId: 'wr1', status: 'error', reason: 'timeout', agentId: 'researcher', parentStreamId: 'home', streamId: 'thread_mira', completedAt: NOW - 300000 },
  { runId: 'wr2', status: 'done', agentId: 'researcher', parentStreamId: 'home', completedAt: NOW - 1000 },
  { runId: 'wr3', status: 'stale', agentId: 'designer', parentStreamId: 'proj', completedAt: 0, startedAt: NOW - 3600000 },
  { runId: 'wr4', status: 'error', agentId: 'designer', parentStreamId: 'home', completedAt: NOW - 5 * 86400000 },
  { runId: 'wr5', status: 'interrupted', agentId: 'designer', parentStreamId: 'home', completedAt: NOW - 1000 }
] }) };
global.App = { agentName: id => ({ agent: 'NOVA', writer: 'VEX', researcher: 'MIRA', designer: 'ROOK' })[id] || id };
global.Chat = { consentPhrase: p => p.tool === 'mcp__gmail__send' ? 'send an email to beta@list' : String(p.tool) };
// the approval card's own INSPECT rule (chat.js consentInspect), run for real: it decides whether the rail's one line is
// the whole request
const consentCard = {};
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8'), at = src.indexOf('function glance(');
  vm.createContext(consentCard); vm.runInContext(src.slice(at, src.indexOf('  function clarifyRow(', at)), consentCard);
  global.Chat.consentInspect = consentCard.consentInspect;
}
global.document = undefined;
global.Delegated = require('../frontend/app/delegated.js');   // the page loads both; worker end-lines are worded once, there
const NY = require('../frontend/app/needsyou.js');
// the SESSIONS rail's own agent line (app.js railAgentName + railAgentLine, run as shipped, with the production U.esc), as App
// exposes it: NEEDS YOU names a group chat by the line its session row reads
{
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
  const util = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'util.js'), 'utf8');
  const s0 = util.indexOf('  esc(s) {'), s1 = util.indexOf('\n  // seeded-ish', s0);
  A.ok(s0 >= 0 && s1 > s0 && s1 - s0 < 500, 'fixture: the production escaping method');
  const ctx = vm.createContext({ GroupChat: global.GroupChat, agents: new Map([['agent', { name: 'NOVA' }], ['writer', { name: 'VEX' }], ['researcher', { name: 'MIRA' }]]) });
  vm.runInContext('this.U = {' + util.slice(s0, s1) + '};\n' + A.fnBody(appSrc, 'function railAgentName(w)') + '\n' + A.fnBody(appSrc, 'function railAgentLine(w)') + '\nthis.line = railAgentLine;', ctx);
  global.App.railAgentLine = ctx.line;
  A.ok(/\n    railAgentLine,/.test(appSrc), 'App exposes railAgentLine: NEEDS YOU reads the SESSIONS row\'s own line');
}
// (Andrew 10-19, THE INBOX) nothing is approved, answered or confirmed from the rail, so it reads no ask line: every row is
// the door to where its wait is answered, and its only keys are the safe one-tap actions (Deny, Retry, Dismiss)
const WHOLE = { clientHeight: 19, scrollHeight: 19, clientWidth: 150, scrollWidth: 150 };

{
  const list = NY.items(NOW);
  A.eq(list.map(i => i.key).join(' '), 'group:grp ask:p1 ask:p2 routine:cron-r1 worker:wr1 worker:wr3',
    'asks first (oldest waiting first; a group with no age leads), then failures newest first');
  const ask = list.find(i => i.key === 'ask:p2');
  A.eq(ask.who + ' | ' + ask.what + ' | ' + ask.where + ' | ' + ask.workerWsId, 'VEX | send an email to beta@list | General | thread_vex', 'a delegated worker\'s ask names the WORKER, says exactly what, and where');
  A.eq(list.find(i => i.key === 'ask:p1').what, 'Which price tier should lead?', 'a question shows the question itself');
  // (two reviews 10-16) a group chat waiting on you was headed "GROUP" with an empty portrait well: standing law (Andrew 10-13) is
  // that a group reads its members' names, never a GROUP label. It is the SESSIONS row's own line, its portrait the lead's
  const grp = list.find(i => i.key === 'group:grp');
  A.eq([grp.who, grp.aid].join(' | '), 'NOVA, VEX +1 | agent', 'a group chat that waits on you is named by its members ("NOVA, VEX +1": the SESSIONS row\'s line, lead first), never GROUP');
  const grpHtml = NY._internals.html([grp], NOW);
  A.ok(/<span class="ny-who"[^>]*><span class="ws-agent-names">NOVA, VEX<\/span><span class="ws-agent-more">\+1<\/span><\/span>/.test(grpHtml) && !/>GROUP</.test(grpHtml),
    '…drawn as that very line: ' + grpHtml.slice(0, 300));
  A.ok(/<span class="ny-face" aria-hidden="true" data-ny-aid="agent">/.test(grpHtml) && !/ny-strip/.test(grpHtml) && /<div class="ny-sec approvals" role="group" aria-label="Approval">/.test(grpHtml),
    '…its portrait the lead\'s, under the APPROVAL strip (a group sits with what it waits on), and no strip of its own');
  A.eq(NY.lineOf(grp), 'has an approval waiting', '(its line stays what the group waits on)');
  A.ok(!list.some(i => i.key === 'ask:p9'), 'an ask in a conversation this page does not hold is not listed');
  A.ok(!list.some(i => /wr2|wr5/.test(i.key)), 'finished work and work the Commander stopped never need you');
  A.ok(!list.some(i => i.key === 'worker:wr4'), 'a failure older than three days is history, not a to-do');
  A.eq(list.find(i => i.key === 'worker:wr3').what, 'stopped when the station restarted', 'a restart-stopped worker says so');
  A.eq(list.find(i => i.key === 'worker:wr1').what, 'failed: ran out of time', 'a failed worker says why in words, never the ledger\'s code');
  A.ok(!list.some(i => i.key === 'routine:cron-r2'), 'a routine that ran fine is not a to-do');
  const k = NY._internals.keysFor;
  A.ok(/data-ny-act="deny"[^>]*>Deny/.test(k(ask)) && !/data-ny-act="(once|open)"/.test(k(ask)) && !/>(Approve|Review|Answer)/.test(k(ask)),
    'an approval: Deny, the one safe tap (approving happens on its card, which the row opens)');
  A.ok(!/data-ny-act="(always|full|session)"/.test(k(ask)), 'never a standing or lead-wide grant from the list');
  A.eq(k(list.find(i => i.key === 'ask:p1')), '', 'a question: no key (the row opens its card, where it is answered)');
  A.ok(/data-ny-act="retry"[^>]*>Retry/.test(k(list.find(i => i.key === 'routine:cron-r1'))), 'a failed routine: Retry');
  A.ok(/data-ny-act="dismiss"/.test(k(list.find(i => i.key === 'worker:wr1'))), 'failed delegated work: Open or Dismiss');
  const h = NY._internals.html(list, NOW);
  A.ok(/<span class="ny-title">Needs you<\/span><span class="ny-count">6<\/span>/.test(h), 'labeled: "Needs you" and how many, never a bare number');
  A.eq((h.match(/class="ny-item /g) || []).length, 6, 'up to six compact rows are drawn (fitRows then folds what the room cannot hold whole)');
  A.ok(/data-ny-act="more"[^>]* hidden>0 more</.test(h), '…so six waits draw no fold key');
  const more = list.concat(list.slice(0, 3).map(i => Object.assign({}, i, { key: i.key + '-b' })));
  const h9 = NY._internals.html(more, NOW);
  A.ok((h9.match(/class="ny-item /g) || []).length === 6 && /data-ny-act="more"[^>]*>3 more</.test(h9), '…and nine draw six with "3 more", saying how many are folded');
  A.eq(NY._internals.age(NOW - 120000, NOW) + ',' + NY._internals.age(NOW - 7200000, NOW) + ',' + NY._internals.age(0, NOW), '2m,2h,', 'age reads in plain units; unknown age shows nothing');
  global.localStorage.setItem('skynet.needs-dismissed', JSON.stringify(['worker:wr1']));
  A.ok(!NY.items(NOW).some(i => i.key === 'worker:wr1'), 'a dismissed failure leaves the list');
  unread.delete('cron-r1');
  A.ok(!NY.items(NOW).some(i => i.key === 'routine:cron-r1'), 'a failed routine you have opened (read) leaves it too');
}
{
  // the liveness check settles a hung worker as stale too (reason "stalled: …"), with no restart at all.
  // wr8's `result` is a field /api/overseer does not project yet: its tip assertion pins the page's half only.
  const ledger = global.Overseer;
  global.Overseer = { snapshot: () => ({ workers: [
    { runId: 'wr6', status: 'stale', reason: 'stalled: no progress for 450s — the liveness check stopped this worker (threshold 420s)', agentId: 'researcher', parentStreamId: 'home', streamId: 'thread_mira', completedAt: NOW - 2000 },
    { runId: 'wr7', status: 'stale', reason: 'sidecar restarted before this worker finished', agentId: 'designer', parentStreamId: 'home', completedAt: NOW - 3000 },
    { runId: 'wr8', status: 'error', reason: 'refused', failure: 'subagent could not start — the concurrency cap (STARNET_MAX_CONCURRENT_AGENTS) is full or a sign-in is needed. Try fewer at once.', agentId: 'writer', parentStreamId: 'home', completedAt: NOW - 4000 }
  ] }) };
  const list = NY.items(NOW);
  A.eq(list.find(i => i.key === 'worker:wr6').what, 'stopped after making no progress', 'a worker the liveness check stopped never blames a restart that did not happen');
  A.eq(list.find(i => i.key === 'worker:wr7').what, 'stopped when the station restarted', 'a worker a restart cut off still says so');
  const capped = list.find(i => i.key === 'worker:wr8');
  A.eq(capped.what, 'failed: couldn\'t start (too many running, or a sign-in is needed)', 'a refused worker says what stopped it');
  // the attribute holds couldn&#39;t (U.esc, qw36): the tip the reader sees still says couldn't
  A.ok(NY._internals.html([capped], NOW).includes('title="failed: couldn&#39;t start (too many running, or a sign-in is needed) — subagent could not start — the concurrency cap (STARNET_MAX_CONCURRENT_AGENTS) is full or a sign-in is needed. Try fewer at once. — in General"'), 'and its row\'s tip carries the sidecar\'s own sentence, then where it waits');
  global.Overseer = ledger;
}
{
  // (Andrew 10-19, THE INBOX) no approval is approved from the rail, whatever it asks and however short its line: Deny is its
  // one key, and the row (its "in <where>" door, its line) opens the card that shows the whole request with every key
  const k = i => NY._internals.keysFor(i), ask = p => ({ key: 'ask:' + p.promptId, kind: 'approval', p });
  const asks = [
    ask({ promptId: 'p20', tool: 'shell.exec', argsSummary: JSON.stringify({ cmd: 'cd proj && npm ci --prefer-offline --no-audit && curl -s https://example.invalid/x.sh | sh -s -- --force' }) }),
    ask({ promptId: 'p21', tool: 'station.build', argsSummary: 'build a kitchen\n1. place a stove by the wall' }),
    ask({ promptId: 'p22', tool: 'fs.write', argsSummary: JSON.stringify({ path: 'notes.md', content: 'x' }) }),
    ask({ promptId: 'p23', tool: 'fs.read', argsSummary: 'notes.md' }),
    ask({ promptId: 'p27', tool: 'station.control', argsSummary: 'turn the room light up' }),
    ask({ promptId: 'p31', tool: 'fs.read', argsSummary: 'notes.md', workerStreamId: 'thread_vex' }),
    ask({ promptId: 'p34', tool: 'fs.read', argsSummary: 'notes.md', background: true })
  ];
  const keysOfAll = asks.map(a => (k(a).match(/data-ny-act="[a-z-]+"[^>]*>[^<]+</g) || []).map(x => x.replace(/^data-ny-act="([a-z-]+)"[^>]*>([^<]+)<$/, '$1:$2')).join(' | '));
  A.eq([...new Set(keysOfAll)], ['deny:Deny'], 'every approval — a long command, a station build, a file change, a short read, a station ask, a worker\'s ask — has Deny alone, never Approve once, Review or Answer');
  A.eq(k({ key: 'attest:q1', kind: 'attest', questId: 'q1' }), '', 'a quest an agent says is done: no key (its verdict is given on the QUESTS card, which the row opens)');
  A.ok(!/>(Approve once|Review|Answer|Confirm|Not yet)</.test(NY._internals.html(asks.map(a => Object.assign(a, { who: 'NOVA', where: 'General', what: 'use fs read: notes.md', since: NOW - 60000 })), NOW)),
    'no row in the list carries an Approve once, Review, Answer, Confirm or Not yet key');
  const glassCss = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'pipglass.css'), 'utf8');
  // the one key: a terminal key in the row's right-hand column, across its two lines, every key the column's one width
  A.ok(/\.ny-keys \{ display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin: 0; \}/.test(glassCss)
    && /\.ny-item > :is\(\.ny-keys, \.ny-go\) \{ grid-column: 3; grid-row: 1 \/ span 2; justify-self: end; \}/.test(glassCss)
    && /\.ny-key \{\s*flex: 0 0 auto; min-width: 0; min-height: 34px; padding: 5px 7px; font: 16px\/1\.1 'VT323'/.test(glassCss)
    && /\.ny-keys > \.ny-key \{ flex: 0 0 auto; min-width: 68px; min-height: 34px; text-align: center; \}/.test(glassCss),
    'a row\'s one key stands in its right-hand column across its two lines, every key the column\'s width and 34px tall (test/needs-you-rail-fit.test.js lays it out)');
  A.ok(/@container \(max-width: \d+px\) \{[^@]*\.ny-item > \.ny-keys \{ grid-column: 1; grid-row: 3;/.test(glassCss), 'on the narrowest panel the key steps under the lines, so the ask keeps the row\'s width');
  // (two reviews 10-16) "in <where>" was display:none on every default rail (a 250px container query): approval rows never
  // said which conversation asks, keyboard focus fell to the page while an answer was on its way (the focus assertions below
  // run on a host with no CSS, so they never saw it), and build / STEP-IN / extension / loop / group rows had nothing to focus
  A.ok(!/\.ny-where[^{}]*\{[^}]*display:\s*none/.test(glassCss), 'no rule takes "in <where>" out with display:none: it stays a focusable door on every rail');
  A.ok(/@container \(max-width: \d+px\) \{\s*body\.glass-demo:not\(\.hud-mode\) #left \.ws-needs \.ny-where \{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/.test(glassCss),
    'on a narrow rail it is only hidden from sight (clipped, still focusable and read)');
  // live 10-16: put back into the line on keyboard focus it was a 0-22px stub on the 200px rail, so the focus showed nowhere
  A.ok(/\.ny-item:has\(> \.ny-line > \.ny-where:focus-visible\) \{ outline: 2px solid var\(--ph-bright\); outline-offset: -2px; \}/.test(glassCss),
    'a keyboard focus on a row\'s door rings the whole row (an edge, on every rail), so it is seen where the door is out of sight');
  const doorRow = NY._internals.html([Object.assign(ask({ promptId: 'p33', tool: 'fs.read', argsSummary: 'notes.md' }), { who: 'NOVA', where: 'Launch prep', what: 'use fs read: notes.md', since: NOW - 60000 })], NOW);
  A.ok(/<button type="button" class="ny-where" data-ny-act="open" data-ny-key="ask:p33" aria-label="Approval: NOVA wants to use fs read: notes\.md — in Launch prep"/.test(doorRow), 'the door\'s name says what the wait is, who, what, and where it lands: ' + doorRow.slice(0, 600));
  A.ok(/<div class="ny-what" title="use fs read: notes\.md — in Launch prep">/.test(doorRow), 'the line\'s hover tip says the whole ask and where it waits (the place the narrow rail hides from the line)');
  A.ok(/<div class="ny-line">[\s\S]*?<span class="ny-age">1m<\/span><\/div>/.test(doorRow), 'how long it has waited ends its first line');
}
{
  // (Andrew 10-19, B: "I like B when they are organized together perfectly … because its groups each agent by whether its an
  // approval etc") ONE panel, each kind of wait under its own strip, in one order, the most blocking first
  const mk = (key, kind, extra) => Object.assign({ key, kind, who: 'NOVA', aid: 'agent', what: 'x', where: 'General', since: NOW - 60000 }, extra);
  const mixed = [
    mk('worker:f1', 'failed', { what: 'failed: ran out of time', since: NOW - 1000 }),
    mk('ask:q', 'question', { what: 'Which tier?', p: { promptId: 'q' } }),
    mk('stepin:h', 'stepin', { what: 'needs you to sign in', where: 'STEP-IN' }),
    mk('ask:a1', 'approval', { what: 'use fs read: a.md', p: { promptId: 'a1' } }),
    mk('ask:a2', 'approval', { what: 'use fs read: b.md', p: { promptId: 'a2' } }),
    mk('worker:f2', 'failed', { what: 'stopped when the station restarted', since: NOW - 2000 })
  ];
  const hm = NY._internals.html(mixed, NOW);
  const secs = [...hm.matchAll(/<div class="ny-sec ([a-z]+)" role="group" aria-label="[^"]*"><div class="ny-grp" aria-hidden="true"><span class="ny-grp-t">([^<]*)<\/span>(?:<span class="ny-grp-n">(\d+)<\/span>)?<\/div><ul class="ny-list">([\s\S]*?)<\/ul><\/div>/g)]
    .map(m => [m[1], m[2], m[3] || '', [...m[4].matchAll(/data-ny-key="([^"]+)" data-ny-n/g)].map(k => k[1]).join(' ')]);
  A.eq(secs, [
    ['approvals', 'Approvals', '2', 'ask:a1 ask:a2'],
    ['questions', 'Question', '', 'ask:q'],
    ['stepin', 'Step-in', '', 'stepin:h'],
    ['failed', 'Failed or stopped', '2', 'worker:f1 worker:f2']
  ], 'one panel by kind, the most blocking first: each strip names its kind and counts from two waits up, and a kind keeps the list\'s own order');
  A.eq((hm.match(/<div class="ny-panel">/g) || []).length, 1, '…in ONE panel');
  A.ok(/<div class="ny-sec approvals" role="group" aria-label="Approvals, 2"><div class="ny-grp" aria-hidden="true">/.test(hm), 'a screen reader hears each kind once, as its group\'s label (the strip is for sight)');
  A.eq(NY._internals.byKind([mixed[0]]).map(g => g.label).join(), 'Failed', 'failed work alone says Failed');
  A.eq(NY._internals.byKind([mixed[5]]).map(g => g.label).join(), 'Stopped', 'work a restart or the liveness check stopped says Stopped, never Failed');
  A.eq(NY._internals.byKind([mk('routine:r', 'routine', { what: 'routine "x" failed' })]).map(g => g.label).join(), 'Failed', 'a failed routine run says Failed');
  A.eq(['approval', 'question', 'asked', 'stepin', 'build', 'attest', 'loop', 'extension', 'failed', 'routine'].map(kind => NY._internals.familyOf({ kind })).join(' '),
    'approvals questions questions stepin builds quests loops extensions failed failed', 'every kind of wait has its family');
  A.eq([NY._internals.familyOf({ kind: 'group', what: 'has an approval waiting' }), NY._internals.familyOf({ kind: 'group', what: 'has a question waiting' })].join(' '), 'approvals questions', 'a group chat sits with what it waits on');
  // every row: its portrait (when it names an agent), and ONE right-hand column: its key, or the caret where the row only opens
  const rowsOf = h => [...h.matchAll(/<li class="ny-item [^"]*" data-ny-key="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  A.ok(rowsOf(hm).length === 6 && rowsOf(hm).every(m => /^<span class="ny-face" aria-hidden="true" data-ny-aid="agent"><img alt="" draggable="false" hidden><\/span>/.test(m[2])),
    'every row that names an agent leads with its portrait well (painted by AgentPortraits after the build)');
  A.ok(rowsOf(hm).every(m => /class="ny-keys"/.test(m[2]) !== /<span class="ny-go" aria-hidden="true"><\/span>/.test(m[2])), 'every row has ONE right-hand column: its key, or else the caret (never both, never neither)');
  const station = NY._internals.html([mk('extensions', 'extension', { who: 'STATION', aid: undefined, what: 'has 2 extensions awaiting your approval', where: 'EXTENSIONS', since: 0 })], NOW);
  A.ok(!/ny-face/.test(station) && /<span class="ny-grp-t">Extensions<\/span><\/div>/.test(station), 'a wait that names no agent (the STATION\'s extensions) has no empty portrait well');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'needsyou.js'), 'utf8');
  A.ok(/host\.innerHTML = html\(list, now\);\s*\n\s*paintFaces\(host\);/.test(src) && /AgentPortraits\.paint\(face\.querySelector\('img'\), a\)/.test(src),
    'every rebuild paints the portraits through AgentPortraits (the CREW card\'s own figure)');
}
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  A.ok(!/railAttentionOnly|ws-attention/.test(app) && !/id="ws-attention"/.test(html), 'the "Waiting for you" filter is retired');
  A.ok(/<section id="ws-needs" class="ws-needs" aria-label="Needs you" hidden><\/section>/.test(html) && html.indexOf('app/needsyou.js') > 0, 'the page has the NEEDS YOU section and loads its module');
  // app-shell-ui-04 / seams-04: bounded in every mode (glass, plain, hud) — an expanded "N more" scrolls inside its card,
  // so the lower asks' keys and "Show fewer" stay reachable, with a themed scrollbar (never a white native one)
  const glass = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'css', 'pipglass.css'), 'utf8');
  A.ok(/\n#left \.ws-needs \{[^}]*max-height: min\(48%, 440px\);[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/.test(glass), 'NEEDS YOU has a height bound and scrolls inside its card, unscoped so every rail mode gets it');
  A.ok(/\n#left \.ws-needs\.ny-open \{ max-height: min\(72%, 680px\); \}/.test(glass) && /host\.classList\.toggle\('ny-open', expanded\)/.test(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'needsyou.js'), 'utf8')),
    'opened ("N more"), the list takes the rail\'s room rather than a short box that slices its rows');
  A.ok(/\n#left \.ws-needs::-webkit-scrollbar-thumb \{[^}]*background: var\(--ph-dim\)/.test(glass) && /\n#left \.ws-needs \{[^}]*scrollbar-color: var\(--ph-dim\) transparent/.test(glass), 'its scrollbar is themed like COMMS');
  A.ok(/if \(railView !== 'sessions'\) \{ host\.hidden = true; return; \}\s*\n\s*if \(typeof NeedsYou !== 'undefined' && NeedsYou\.render\) NeedsYou\.render\(\);/.test(app), 'the rail renders it (SESSIONS view only)');
  A.ok(/NeedsYou\.render\(\);   \/\/ ages tick, failures arrive/.test(app), 'and the 1s rail heartbeat keeps it current');
  const ny = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'needsyou.js'), 'utf8');
  A.ok(/Chat\.answerConsent\(i\.p, Workstreams\.get\(i\.wsId\), kind, 'needs-you'\)/.test(ny), 'Deny answers through the approval card\'s own path (and says it came from NEEDS YOU)');
  A.ok(/Harness\.streamPost\('\/api\/cron\/run', \{ id: i\.routineId, detach: true \}\)/.test(ny), 'Retry reruns the routine for real (detached), on the page\'s one run stream');
}
/* ---- the rail's 1s heartbeat: an age tick never rebuilds the list (focus survives), an answer in flight stays locked ---- */
// a host that understands exactly the markup html() writes (no DOM library in this repo's headless tests)
function fakeRail() {
  const doc = { activeElement: null };
  const host = { hidden: false, writes: 0, buttons: [], rows: [], listeners: {}, _h: '',
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    contains: n => host.buttons.includes(n),
    querySelectorAll: sel => sel === 'li.ny-item[data-ny-key]' ? host.rows : sel === '[data-ny-act]' ? host.buttons : [],
    querySelector: sel => sel === '.ny-more' ? host.buttons.find(b => /\bny-more\b/.test(b.className)) || null : null,
    get innerHTML() { return this._h; },
    set innerHTML(h) {
      if (this.buttons.includes(doc.activeElement)) doc.activeElement = null;   // a removed element loses focus to the page
      this._h = h; this.writes++;
      this.buttons = [...h.matchAll(/<button type="button" class="([^"]*)" data-ny-act="([^"]*)"([^>]*)>/g)].map(m => {
        const key = /data-ny-key="([^"]*)"/.exec(m[3]);
        const b = { className: m[1], dataset: { nyAct: m[2], nyKey: key ? key[1] : undefined }, disabled: / disabled/.test(m[3]), focus() { if (!b.disabled) doc.activeElement = b; } };   // a disabled key cannot take focus
        return b;
      });
      this.rows = [...h.matchAll(/<li class="ny-item [^"]*" data-ny-key="([^"]*)"[^>]*>[\s\S]*?<span class="ny-age">([^<]*)<\/span>/g)].map(m => {
        const ageEl = { textContent: m[2] };
        return { dataset: { nyKey: m[1] }, ageEl, querySelector: sel => sel === '.ny-age' ? ageEl : sel === '.ny-what' ? WHOLE : null };   // each line fits its row
      });
    } };
  doc.getElementById = id => id === 'ws-needs' ? host : null;
  return { doc, host, key: (act, k) => host.buttons.find(b => b.dataset.nyAct === act && b.dataset.nyKey === k) };
}
(async () => {
  const realNow = Date.now, realDoc = global.document;
  let clock = NOW; Date.now = () => clock;
  const { doc, host, key } = fakeRail(); global.document = doc;
  const drawn = [];
  const write = Object.getOwnPropertyDescriptor(host, 'innerHTML').set;
  Object.defineProperty(host, 'innerHTML', { get() { return this._h; }, set(h) { drawn.push(h); write.call(this, h); }, configurable: true });
  NY.render();
  A.eq(host.writes, 1, 'the first render draws the list once (it reads no line, so nothing redraws)');
  A.ok(key('deny', 'ask:p2') && !key('once', 'ask:p2') && !host.buttons.some(x => x.dataset.nyAct === 'open' && x.dataset.nyKey === 'ask:p2' && x.className.split(' ').includes('ny-key')),
    '…an approval drawn with Deny alone: no Approve once, no Review key');
  doc.activeElement = key('deny', 'ask:p2');
  clock = NOW + 60000; NY.render();
  A.eq(host.writes, 1, 'a minute passing does not rebuild the list');
  A.eq(host.rows.find(r => r.dataset.nyKey === 'ask:p2').ageEl.textContent, '3m', 'only the age text moves, in place');
  A.ok(doc.activeElement === key('deny', 'ask:p2'), 'so the key the Commander is on keeps its focus');
  pend.push({ wsId: 'proj', p: { promptId: 'p30', tool: 'fs.read', argsSummary: 'notes.md', askedAt: NOW - 30000 } });
  NY.render();
  A.eq(host.writes, 2, 'a new ask rebuilds the list');
  A.ok(doc.activeElement && doc.activeElement === key('deny', 'ask:p2'), 'and focus lands back on the same key in the new list');
  // an answer in flight: the key stays disabled through every re-render, and a second click sends nothing
  let calls = 0, settle = null;
  const answerConsent = global.Chat.answerConsent;
  global.Chat.answerConsent = () => { calls++; return new Promise(r => { settle = r; }); };
  const click = b => host.listeners.click({ target: { closest: sel => sel === '[data-ny-act]' ? b : null }, preventDefault() {}, stopPropagation() {} });
  click(key('deny', 'ask:p2'));
  A.ok(key('deny', 'ask:p2').disabled, 'Deny is disabled while the answer is in flight');
  A.ok(doc.activeElement === key('open', 'ask:p2'), 'a keyboard answer keeps focus on that ask\'s row (its "in <where>" door), never drops it to the page');
  clock += 1000; pend.push({ wsId: 'proj', p: { promptId: 'p31', tool: 'fs.read', argsSummary: 'b.md', askedAt: NOW - 20000 } }); NY.render();
  A.ok(key('deny', 'ask:p2').disabled, 'and stays disabled when the list rebuilds meanwhile');
  A.ok(doc.activeElement === key('open', 'ask:p2'), 'and focus stays on that row through the rebuild');
  click(key('deny', 'ask:p2')); click({ dataset: { nyAct: 'deny', nyKey: 'ask:p2' } });
  A.eq(calls, 1, 'a second click on a settling ask sends no second answer');
  pend.splice(pend.findIndex(x => x.p.promptId === 'p2'), 1);
  settle(); await new Promise(r => setTimeout(r, 0));
  A.ok(!key('deny', 'ask:p2') && !/ask:p2/.test(host.innerHTML), 'once answered, the ask leaves the list');
  // an answer that fails: the key comes back, and so does the focus
  let fail = null;
  global.Chat.answerConsent = () => new Promise((_, no) => { fail = no; });
  doc.activeElement = key('deny', 'ask:p30');
  click(key('deny', 'ask:p30'));
  const door30 = host.buttons.find(b => b.dataset.nyAct === 'open' && b.dataset.nyKey === 'ask:p30' && b.className.split(' ').includes('ny-where'));
  A.ok(key('deny', 'ask:p30').disabled && door30 && doc.activeElement === door30, 'a second ask in flight: its key locks, focus waits on its row\'s door');
  fail(new Error('the station is offline')); await new Promise(r => setTimeout(r, 0));
  A.ok(!key('deny', 'ask:p30').disabled && doc.activeElement === key('deny', 'ask:p30'), 'the answer failed: Deny is back and so is the focus');
  global.Chat.answerConsent = answerConsent; Date.now = realNow; global.document = realDoc;
  pend.splice(pend.findIndex(x => x.p.promptId === 'p30'), 1); pend.splice(pend.findIndex(x => x.p.promptId === 'p31'), 1);
})().then(() => A.report('needs-you.test'), e => { console.error(e); process.exit(1); });
