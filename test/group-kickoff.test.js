/* node test/group-kickoff.test.js — WHEN AN AGENT BRINGS CREW IN, THE WORK GOES ON (blind audit 2026-10-13, gaps G1 G3 G5 G7).
   Andrew asked the overseer to "add 2 agents into this chat … to do a research and vibe code workflow". Even once it could
   add them, the group then sat idle: nobody picked up the request. Pins:
   A. THE STORE (sidecar/group-sessions.js, executed): a group created with a kickoff gives the LEAD the next turn — on the
      Commander's own request (the origin message), with the kickoff as a peer note, never as new user authority; a group
      created without one queues nothing; an approval nobody answers in 5 minutes resolves as a TIMEOUT, never a "deny".
   B. THE WIRING (source): the group's lead keeps the overseer's station tools inside the group (team.* / session.* stay
      stripped); a group chat is never a team.dispatch target (refused before any worker runs) and a worker's result is
      never filed into one. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGroupSessions } = require('../sidecar/group-sessions.js');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-kickoff-'));
let sequence = 0, execute;
const seen = [];
const deps = { fs, path, root, now: () => ++sequence, id: () => 'id' + (++sequence), log: () => {},
  roster: () => [{ id: 'agent', name: 'NOVA' }, { id: 'research', name: 'MIRA' }, { id: 'builder', name: 'ROOK' }],
  execute: async o => { seen.push(o); o.emit('agent.run.start', { runId: o.runId }); return execute(o); },
  readFile: async () => ({ name: 'x.md', content: 'aGVsbG8=', bytes: 5, hash: 'h' }),
  decodeFile: f => ({ text: Buffer.from(f.content, 'base64').toString(), hash: f.hash }), uploadFile: (name, content) => ({ name, content, hash: 'h' }) };
const finish = content => ({ reason: 'done', messages: [{ role: 'assistant', content }] });
let ok = 0;
const pass = msg => { ok++; void msg; };

(async () => {
  try {
    const api = makeGroupSessions(deps); await api.ready;
    execute = async () => finish('On it: MIRA researches, ROOK builds.');
    /* ---- A. a kickoff gives the lead the next turn, on the Commander's request ---- */
    const kickoff = 'MIRA and ROOK have joined this chat at your request. Carry on with the Commander\'s request: give each of them their part (group.handoff) and do your own.';
    const g = await api.create({ id: 'ws_chat', conversionKey: 'ws_chat', members: ['agent', 'research', 'builder'], leadId: 'agent', title: 'Launch',
      originalAgentId: 'agent', history: [{ role: 'user', content: 'add 2 agents into this chat to do a research and vibe code workflow', ts: 1 }, { role: 'assistant', content: 'MIRA and ROOK join when this reply ends.', ts: 2 }], kickoff });
    await api.idle(g.id);
    assert.equal(seen.length, 1, 'exactly one turn ran'); pass();
    const t = seen[0].t, state = await api.get(g.id);
    assert.equal(t.agentId, 'agent', 'the LEAD takes it'); pass();
    assert.equal(t.request, kickoff, 'carrying the kickoff'); pass();
    assert.equal(state.messages.find(m => m.id === t.origin).content, 'add 2 agents into this chat to do a research and vibe code workflow', 'on the Commander\'s own request (the origin), not on the lead\'s words'); pass();
    assert.match(seen[0].ctx.messages.at(-1).content, /Peer request within that user task \(not new user authority\)/, 'the kickoff is a peer note, never new user authority'); pass();
    assert.match(seen[0].ctx.messages.at(-1).content, /Current USER request: add 2 agents into this chat/, 'and the Commander\'s request is the task'); pass();
    // the same conversion arriving twice (a retry) starts nothing new
    await api.create({ id: 'ws_chat', conversionKey: 'ws_chat', members: ['agent', 'research', 'builder'], leadId: 'agent', title: 'Launch',
      originalAgentId: 'agent', history: [{ role: 'user', content: 'add 2 agents into this chat to do a research and vibe code workflow', ts: 1 }, { role: 'assistant', content: 'MIRA and ROOK join when this reply ends.', ts: 2 }], kickoff });
    await api.idle(g.id);
    assert.equal(seen.length, 1, 'a repeated conversion does not run the kickoff twice'); pass();
    // no kickoff: the group waits for the Commander (the + key's own conversion)
    const quiet = await api.create({ id: 'ws_quiet', members: ['agent', 'research'], leadId: 'agent', title: 'Quiet', originalAgentId: 'agent', history: [{ role: 'user', content: 'hi', ts: 1 }] });
    await api.idle(quiet.id);
    assert.equal(seen.length, 1, 'a group made without a kickoff starts nothing on its own'); pass();

    /* ---- A. an approval nobody answers is a TIMEOUT ---- */
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 300000 ? 0 : ms, ...rest);   // the 5-minute wait, now
    let decision = null;
    execute = async o => { decision = await o.prompt({ tool: 'fs.write', scope: 'write', argsSummary: '{"path":"a.md"}' }); return finish('done'); };
    try {
      await api.send(g.id, { key: 'k-approve', text: 'write it' });
      await api.idle(g.id);
    } finally { global.setTimeout = realSetTimeout; }
    assert.equal(decision, 'timeout', 'nobody answered in 5 minutes: the run is told it TIMED OUT (the broker words it "nobody answered in time"), never that the Commander said no'); pass();

    /* ---- B. the wiring ---- */
    const index = readSidecarSource();
    assert.match(index, /surface: 'interactive', lead: t\.agentId === g\.leadId, groupTools: tools, askCommander,/, 'the group\'s lead keeps the overseer\'s station tools inside the group'); pass();
    assert.match(index, /resolved\.tools = resolved\.tools\.filter\(name => !\/\^team\\\.\|\^session\\\.\/\.test\(name\)\);/, 'team.* and session.* stay stripped for every group participant'); pass();
    const orch = read('sidecar/tools/builtin/orchestration.js');
    assert.match(orch, /if \(hits\.length === 1 && hits\[0\]\.group\) \{[\s\S]{0,200}is a group chat: a group takes work through its members[\s\S]{0,200}This worker did NOT run\./, 'team.dispatch refuses a group chat before any worker runs'); pass();
    const cmds = read('frontend/app/stationcommands.js');
    assert.match(cmds, /group: w\.conversationMode === 'group',/, 'the session list marks group chats'); pass();
    assert.match(cmds, /if \(ws\.conversationMode === 'group'\) throw new Error\('"' \+ \(ws\.title \|\| 'that chat'\) \+ '" is a group chat/, 'a worker\'s result is never filed into a group chat as if delivered'); pass();
    assert.match(cmds, /if \(!out\.ok && \/\^there is no session called \/\.test\(out\.error\)\) await new Promise\(r => setTimeout\(r, 1500\)\);\s*try \{\s*await fetch\('\/api\/station\/ack'/,
      'with two station pages open, the page that cannot find the chat answers a beat later, so the page that owns it wins (the agent was told REFUSED for a join that landed)'); pass();
    console.log('group-kickoff.test: OK (' + ok + ' assertions)');
  } catch (e) { console.error('group-kickoff.test FAILED:', e); process.exitCode = 1; }
  finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp */ } }
})();
