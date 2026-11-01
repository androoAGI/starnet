/* node test/cli-dashboard.test.js — the `starnet` dashboard, ls, approve and watch: their PURE parts, no I/O.

   Locks: the new commands parse (and a bare `starnet` opens the dashboard only at a terminal) · task-vs-talk rides
   every run body (a run without isTask is offered no tools) · the station model says only what the station proved
   (working while a run is live, needs-you while an ask waits, done only after run.end{done}, a run that vanished
   unseen is never "done", unknown spend is never $0) · the screen fits the terminal, shows the open ask as a card,
   and never lets model text drive the terminal · watch prints one line per meaningful event. Part of test:fast. */
'use strict';
const A = require('./_assert.js');
const core = require('../bin/lib/cli-core.js');
const { makeStation, sourceOf, toolName, oneLine, RECENT_MS, costText } = require('../bin/lib/station-model.js');
const tui = require('../bin/lib/tui.js');
const sc = require('../bin/lib/station-commands.js');

// ---- argv ---------------------------------------------------------------------------------------------------
{
  A.eq(core.parseArgs([], {}, { tty: true }).cmd, 'dash', 'a bare `starnet` at a terminal opens the dashboard');
  A.ok(core.parseArgs([], {}, { tty: false }).help, 'a bare `starnet` in a pipe prints the usage, never a screen');
  A.ok(core.parseArgs([], {}).help, 'no context → usage (the old contract)');
  A.eq(core.parseArgs(['ls', '--json'], {}).cmd + ':' + core.parseArgs(['ls', '--json'], {}).json, 'ls:true', 'ls --json');
  const ap = core.parseArgs(['approve', 'cypher', '--session'], {});
  A.eq([ap.cmd, ap.args, ap.session], ['approve', ['cypher'], true], 'approve <agent> --session');
  A.eq(core.parseArgs(['deny'], {}).cmd, 'deny', 'deny with no agent');
  const fl = core.parseArgs(['flow', 'run', 'release', 'ship the notes'], {});
  A.eq([fl.cmd, fl.args], ['flow', ['run', 'release', 'ship the notes']], 'flow run <name> <text>');
  const throws = (argv, re, label) => { let m = ''; try { core.parseArgs(argv, {}); } catch (e) { m = e.message; } A.ok(re.test(m), label + ': ' + m); };
  throws(['flow', 'run', 'release'], /needs a workflow and the job text/, 'flow run without text is a usage error');
  throws(['approve', 'a', 'b'], /at most one agent/, 'approve takes one agent');
  A.eq(core.parseArgs(['watch'], {}).cmd, 'watch', 'watch');
  A.ok(/starnet ls/.test(core.USAGE) && /6 nothing to answer/.test(core.USAGE), 'the usage names the new commands and exit code');
}

// ---- small pure helpers ---------------------------------------------------------------------------------------
{
  A.eq(core.cliStreamId('astra'), 'cli-astra', 'the terminal conversation id');
  A.ok(/^[A-Za-z0-9_-]{1,64}$/.test(core.cliStreamId('we!rd id/../x' + 'y'.repeat(80))), 'always a valid stream id');
  const sse = core.splitSse('retry: 3000\n\nid: e:1\ndata: {"name":"a"}\n\ndata: {}\n\nid: e:2\ndata: {"na');
  A.eq(sse.events.map(e => e.id + '|' + e.data), ['e:1|{"name":"a"}', '|{}'], 'complete events out (the retry hint dropped)');
  A.eq(sse.rest, 'id: e:2\ndata: {"na', 'the partial tail is kept');
  A.ok(core.isTaskText('write the release notes'), 'an instruction is a task (tools offered)');
  A.ok(!core.isTaskText('thanks!'), 'a pleasantry is talk');
  A.ok(core.isTaskText('yes', 'Want me to draft it?'), 'a yes to an offer to act is the task');
  A.eq(core.buildRunBody({ model: 'm', provider: 'p', agentId: 'agent' }, 'fix the build', {}).isTask, true, 'starnet -p marks a task (without it the station offers no tools)');
  A.eq(core.buildRunBody({ model: 'm', provider: 'p', agentId: 'agent' }, 'hello', {}).isTask, false, '…and talk as talk');
  A.eq([toolName('fs_write'), toolName('fs.write'), toolName('web')], ['fs.write', 'fs.write', 'web'], 'tool names as the station says them');
  A.eq(oneLine('{\n  "a": "x\\ny"\n}', 100), '{ "a": "x y" }', 'pretty JSON reads as one line');
  A.eq(costText({ usd: null, atLeast: null }), 'spend unknown', 'unknown spend is never $0');
  A.eq(costText({ usd: null, atLeast: 0.5 }), '≥$0.50 today', 'unsettled spend says at least');
  A.eq(costText({ usd: 1.234 }), '$1.23 today', 'settled spend');
}

// ---- the station model -------------------------------------------------------------------------------------------
const T0 = 1700000000000;
function crew() {
  const m = makeStation();
  m.setRoster({ agents: [{ agentId: 'astra', name: 'Astra', model: 'm/a', provider: 'openrouter' }, { agentId: 'agent', name: 'Nova', model: 'm/n' }, { agentId: 'cypher', name: 'Cypher', model: 'm/c' }] });
  return m;
}
{
  const m = crew();
  A.eq(m.state.order, ['agent', 'astra', 'cypher'], 'the hero leads the crew, then the roster order');
  A.eq(m.rows(T0).map(r => r.status.key), ['idle', 'idle', 'idle'], 'nobody works until a run proves it');

  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', streamId: 'desk-1', prompt: 'fix the redirect' }, T0);
  let astra = m.rows(T0 + 5000).find(r => r.id === 'astra');
  A.eq([astra.status.key, astra.status.since], ['working', T0], 'a live run = working, timed from its start');
  A.eq(m.logOf('astra')[0].k + ':' + m.logOf('astra')[0].source + ':' + m.logOf('astra')[0].text, 'start:desktop:fix the redirect', 'a desk run shows its asking prompt, said as from the app');
  m.apply('agent.tool_call', { runId: 'r1', agentId: 'astra', callId: 'c1', name: 'fs_read', argsSummary: '{"path":"auth.js"}' }, T0 + 100);
  A.eq(m.rows(T0 + 200).find(r => r.id === 'astra').now, 'fs.read auth.js', 'NOW is the tool it is running, said by its salient argument (never the raw JSON)');
  {
    const { argDigest } = require('../bin/lib/station-model.js');
    A.eq(argDigest('{"path":"notes.md","content":"# Notes\\n\\nFour comp', 'fs.write'), 'notes.md', 'a write cut mid-content still says its file');
    A.eq(argDigest('{"command":"npm run test:fast","cwd":"C:/w"}', 'shell.exec'), 'npm run test:fast', 'a shell call says its command');
    A.eq(argDigest('{"content":"a body the cut halved', 'fs.write'), '{"content":"a body the cut halved', 'a value the cut halved is never shown as whole: the raw line stays');
    A.eq(argDigest('{"workers":[{"agentId":"astra","task":"x"},{"agentId":"cyp', 'team.dispatch', id => id === 'astra' ? 'ASTRA' : ''), 'ASTRA …', 'a hand-off names its workers, and marks the cut');
    A.eq(argDigest('{}', 'brief.proceed'), '', 'no arguments, no words');
  }
  m.apply('agent.tool_result', { runId: 'r1', agentId: 'astra', callId: 'c1', ok: true, ms: 12, summary: '212\nlines' }, T0 + 300);
  const tool = m.logOf('astra').find(e => e.k === 'tool');
  A.eq([tool.running, tool.ok, tool.res], [false, true, '212 lines'], 'the outcome lands on its call');
  m.apply('agent.token', { runId: 'r1', agentId: 'astra', delta: 'Found ' }, T0 + 400);
  m.apply('agent.token', { runId: 'r1', agentId: 'astra', delta: 'it.' }, T0 + 410);
  m.apply('agent.cost', { runId: 'r1', agentId: 'astra', usd: 0.01 }, T0 + 420);
  m.apply('agent.token', { runId: 'r1', agentId: 'astra', delta: 'Next turn.' }, T0 + 430);
  const texts = m.logOf('astra').filter(e => e.k === 'agent').map(e => e.text);
  A.eq(texts, ['Found it.', 'Next turn.'], 'the reply is the streamed tokens; a new model turn is a new line');

  m.apply('permission.prompt', { runId: 'r1', agentId: 'astra', promptId: 'p1', tool: 'fs.write', scope: 'write', argsSummary: '{\n "path": "auth.js"\n}' }, T0 + 500);
  astra = m.rows(T0 + 600).find(r => r.id === 'astra');
  A.eq(astra.status.key, 'needs', 'an open ask = needs you');
  A.eq(m.header(T0).needs, 1, 'the header counts it');
  A.eq(m.front().summary, 'auth.js', 'the ask reads as what it acts on (the station sends the whole request; the terminal words its glance)');
  m.apply('permission.response', { runId: 'r1', agentId: 'astra', promptId: 'p1', decision: 'once', via: 'terminal' }, T0 + 700);
  A.eq([m.front(), m.rows(T0 + 800).find(r => r.id === 'astra').status.key], [null, 'working'], 'answered → back to working');
  A.ok(/allowed once from the terminal/.test(m.logOf('astra').slice(-1)[0].text), 'the conversation says who answered');
  m.apply('agent.run.end', { runId: 'r1', agentId: 'astra', reason: 'done', usd: 0.02 }, T0 + 1000);
  A.eq(m.rows(T0 + 1500).find(r => r.id === 'astra').status.key, 'done', 'done only after run.end{done}');
  A.eq(m.rows(T0 + 1000 + RECENT_MS + 1).find(r => r.id === 'astra').status.key, 'idle', 'and then it settles to idle');

  m.apply('agent.run.start', { runId: 'r2', agentId: 'cypher', trigger: 'directive' }, T0);
  m.apply('agent.run.end', { runId: 'r2', agentId: 'cypher', reason: 'budget', usd: 0 }, T0 + 10);
  A.eq(m.rows(T0 + 20).find(r => r.id === 'cypher').status, { key: 'stopped', text: 'budget' }, 'a run that ended early says why, never "done"');
}
{
  // the snapshot: adopt a run the feed never started; end one it no longer lists as UNSEEN, never as done
  const m = crew();
  m.applySnapshot({ runs: [{ runId: 'rX', agentId: 'cypher', startedAt: T0, source: 'interactive' }, { runId: 'rI', agentId: 'agent', startedAt: T0, internal: true }], prompts: [{ runId: 'rX', agentId: 'cypher', promptId: 'pX', tool: 'fs.write' }] }, T0 + 100);
  A.eq(m.rows(T0 + 200).find(r => r.id === 'cypher').status.key, 'needs', 'a snapshot ask is adopted');
  A.eq(m.rows(T0 + 200).find(r => r.id === 'agent').status.key, 'idle', 'self-talk (internal) never shows as work');
  A.ok(m.logOf('cypher').some(e => e.k === 'start' && e.adopted), 'a run already under way says so in its conversation');
  A.eq(m.logOf('cypher').find(e => e.k === 'ask').text, 'asks: fs.write', 'an adopted ask arrives without its words');
  m.describePrompt('pX', '{\n "path": "notes.md"\n}');
  A.eq([m.logOf('cypher').find(e => e.k === 'ask').text, m.front().summary], ['asks: fs.write notes.md', 'notes.md'], 'once its request is read, the ask line names it');
  m.applySnapshot({ runs: [], prompts: [] }, T0 + 1000);
  A.eq(m.rows(T0 + 1100).find(r => r.id === 'cypher').status.key, 'needs', 'inside the grace a run (and its ask) that just left the snapshot is not dropped');
  m.applySnapshot({ runs: [], prompts: [] }, T0 + 10000);
  const row = m.rows(T0 + 10001).find(r => r.id === 'cypher');
  A.ok(row.status.key !== 'done' && /ended unseen/.test(row.now), 'a run that vanished unseen is said as unseen, never as done: ' + JSON.stringify(row));
  A.eq(m.front(), null, 'and its ask is gone');
}
{
  // what this terminal sends
  const m = crew();
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive' }, T0);
  m.noteSent('astra', 'also check logout', 'cli-astra', T0 + 10);
  const log1 = m.logOf('astra');
  A.ok(log1.some(e => e.k === 'you' && e.queued) && log1.some(e => /queued/.test(e.text)), 'a message to a busy agent says it is queued');
  m.apply('agent.run.start', { runId: 'r9', agentId: 'astra', trigger: 'directive', surface: 'interactive', streamId: 'cli-astra', prompt: 'also check logout' }, T0 + 50);
  A.ok(!m.logOf('astra').some(e => e.k === 'start' && e.runId === 'r9'), 'its own run start does not print the message twice');
  A.ok(!m.logOf('astra').find(e => e.k === 'you').queued, 'and the message is marked delivered');
  m.noteSent('cypher', 'hi', 'cli-cypher', T0);
  m.sendFailed('cypher', 'cli-cypher', 'no model selected', T0 + 5);
  A.ok(/not sent: no model selected/.test(m.logOf('cypher').slice(-1)[0].text), 'a refused message says why');
  m.seedHistory('cypher', [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }, { role: 'tool', content: 'x' }]);
  A.eq(m.logOf('cypher').slice(0, 3).map(e => e.k + ':' + e.text), ['sys:— earlier in this terminal conversation —', 'you:earlier q', 'agent:earlier a'], 'earlier terminal turns come first, under their divider');
  // a delegated worker's ask is the worker's
  m.apply('permission.prompt', { runId: 'r1', agentId: 'astra', workerAgentId: 'cypher', promptId: 'pw', tool: 'fs.write' }, T0);
  A.eq(m.front().agentId, 'cypher', "a worker's ask is filed under the worker");
  A.eq(m.findAgent('cyp').id, 'cypher', 'agents are found by a name prefix');
  A.eq(m.findAgent('@NOVA').id, 'agent', '…or by name, @ and case ignored');
  A.eq(sourceOf({ streamId: 'cli-x' }) + sourceOf({ lineId: 'L1' }) + sourceOf({ trigger: 'schedule' }), 'terminalflowroutine', 'run sources');
}
{
  // budget + flows
  const m = crew();
  m.applyBudget({ spentToday: null, atLeast: 0.25 });
  A.eq(costText(m.state.cost), '≥$0.25 today', 'an unsettled ledger reads as at least');
  m.applyBudget({ spentToday: null, atLeast: { today: 0, lifetime: 1.35, runs: 815 } });
  A.eq(costText(m.state.cost), 'spend unsettled', "the station's own floor shape ({ today, lifetime, runs }) at $0.00 names the state, never reads as $0");
  m.applyBudget({ spentToday: null, atLeast: { today: 0.4, lifetime: 1.75, runs: 816 } });
  A.eq(costText(m.state.cost), '≥$0.40 today', 'a floor above zero reads as at least');
  m.applyLines({ lines: [{ lineId: 'L9' }] }, [{ id: 'j9', line: 'L9', name: 'CRUCIBLE', status: 'delivered', startedAt: T0, endedAt: T0 + 1000, steps: 8 }]);
  A.eq(m.flows(T0 + 5 * 86400000).find(x => x.lineId === 'L9').state, 'done', 'a delivered job is the line succeeding');
  A.ok(/5d ago/.test(m.flows(T0 + 5 * 86400000 + 2000).find(x => x.lineId === 'L9').text), 'old jobs read in days');
  m.applyLines({ lines: [{ lineId: 'L1', runs: 3, shipped: 2 }] }, [{ id: 'j1', line: 'L1', name: 'RELEASE', status: 'done', startedAt: T0, endedAt: T0 + 60000, steps: 3 }]);
  m.apply('agent.run.start', { runId: 'rf', agentId: 'astra', trigger: 'event', lineId: 'L1' }, T0 + 70000);
  const f = m.flows(T0 + 75000)[0];
  A.eq([f.name, f.state, f.agents], ['RELEASE', 'running', ['ASTRA']], 'a flow is running while a run on its line is live, named from its jobs');
  A.eq(m.findLine('rel').lineId, 'L1', 'a flow is found by a name prefix');
}

// ---- the screen ---------------------------------------------------------------------------------------------------
function screen(m, ui, cols, rows, now) { return tui.render(m, Object.assign({ focus: 'astra', input: '', scroll: 0, still: true, stationLabel: 'station · test' }, ui), { cols, rows }, now); }
{
  const m = crew();
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' }, T0);
  m.apply('agent.token', { runId: 'r1', agentId: 'astra', delta: 'evil \x1b[2J\x1b]0;pwned\x07 text' }, T0 + 1);
  m.apply('permission.prompt', { runId: 'r1', agentId: 'astra', promptId: 'p1', tool: 'fs.write', argsSummary: 'auth.js (+2 −1)' }, T0 + 2);
  const rows = screen(m, {}, 110, 34, T0 + 3000);
  const text = rows.map(tui.toPlain);
  A.eq(rows.length, 34, 'one row per terminal line');
  A.ok(text.every(l => tui.width(l) <= 110), 'nothing is wider than the terminal');
  const logo = require('../bin/lib/logo.js');
  const dots = require('../bin/lib/sixel.js').brailleLogo();
  A.ok(dots.length === 3 && dots.every((l, i) => l.trim() && text[i].indexOf(l.trim()) === text[i].indexOf(l.trim()[0]) && text[i].indexOf(l.trim()) >= 0), 'without an image the screen opens on the REAL logo drawn in braille dots, three rows');
  A.ok(/[⠁-⣿]/.test(dots.join('')) && Math.max(...dots.map(l => l.length)) <= 45, 'the dot logo is the three-row size (45 columns)');
  {
    // the logo back as a dot grid: dot[y][x], 12 rows
    const BIT = [[1, 8], [2, 16], [4, 32], [64, 128]];
    const dot = Array.from({ length: 12 }, (_, y) => Array.from({ length: 90 }, (_, x) => { const ch = dots[y >> 2][x >> 1]; const b = ch ? ch.codePointAt(0) - 0x2800 : 0; return b > 0 && (b & BIT[y & 3][x & 1]) ? 1 : 0; }));
    const lit = y => dot[y].reduce((a, b) => a + b, 0);
    A.ok(lit(0) > 45 && lit(0) >= 3 * lit(1), 'the top edge is ONE dot thick, as in the logo (a sampled cut lit two rows for it): ' + lit(0) + ' vs ' + lit(1));
    const STAR = ['..X..', '..X..', '.X.X.', 'X...X', '.X.X.', '..X..', '..X..'];
    A.ok(STAR.every((l, dy) => [...l].every((c, dx) => (c === 'X') === (dot[4 + dy][26 + dx] === 1))), 'the A carries a drawn four-point star, hollow at its heart, nothing else in its box — never a sampled blob');
    // the T's stems lean exactly as the wordmark does: one dot right for every two rows up, the pairs on the braille cells
    A.ok([13, 16].every(base => [4, 5, 6, 7, 8, 9, 10].every(y => dot[y][base + ((11 - y) >> 1)] === 1 && dot[y][base + ((11 - y) >> 1) - 1] === 0)), 'every upright leans one dot per two rows, so each braille row repeats the same pattern');
  }
  A.ok(text.slice(0, 1).some(l => /1 needs you/.test(l)), 'the counts sit on the top row');
  const ascii = screen(m, { logo: 'ascii' }, 110, 34, T0 + 3000);
  const starCell = ascii.slice(0, 4).flat().find(([t]) => t.indexOf('✦') >= 0);
  A.ok(logo.word.every((l, i) => tui.toPlain(ascii[i]).indexOf(l.trim()) >= 0) && starCell && /logohi/.test(starCell[1]), 'STARNET_LOGO=ascii draws the drawn-letter version, the star in its A glinting');
  // THE PIP-BOY CHROME (Andrew's pick 10-22): a tab rule under the logo names the places once, the one you are in hanging
  // from it; the frames under it carry no titles; CREW is grouped by kind under strips; a stat bar runs along the foot
  A.ok(/^── STAT ─── CREW 3 ─── FLOOR ───┘ COMMS ▸ ASTRA └─── WORK ─── SKILLS ─+$/.test(text[3]), 'the tab rule under the logo: CREW 3, FLOOR, and COMMS ▸ ASTRA hanging from it as the place you are in: ' + text[3]);
  const tabSeg = rows[3].find(([t]) => /COMMS ▸ ASTRA/.test(t));
  A.ok(tabSeg && /ink/.test(tabSeg[1]) && /hifill/.test(tabSeg[1]), 'the tab you are in is a filled label');
  const crewTop = text.findIndex(l => /^╭─+╮╭─/.test(l));
  const astraRow = text.findIndex(l => /^│▌ ▲ ASTRA +ASKS │/.test(l));
  A.ok(crewTop === 4 && /^│ NEEDS YOU 1 +│/.test(text[crewTop + 1]) && astraRow === crewTop + 2, 'CREW groups by kind: NEEDS YOU first, under its strip, the agent asking under it: ' + text[crewTop + 1] + ' / ' + text[astraRow]);
  const stripSeg = rows[crewTop + 1].find(([t]) => /NEEDS YOU/.test(t));
  A.ok(stripSeg && /amfill/.test(stripSeg[1]), 'the NEEDS YOU strip is a filled amber label');
  const sbRow = text.findIndex(l => /^│ STANDING BY 2 +│/.test(l));
  A.ok(sbRow > astraRow && /^│  ○ (NOVA|CYPHER) +│/.test(text[sbRow + 1]), 'the rest stand by under their own strip');
  A.ok(/^ {2}CREW 3 │ {2}⠋ 1 WORKING │ {2}▲ 1 NEEDS YOU │ {2}SPEND UNKNOWN +\d\d:\d\d $/.test(text[33]), 'the stat bar along the foot: crew, working, needs you, spend, the clock (no level until the station says one): ' + text[33]);
  const lv = screen(m, { stats: { level: 3, inLevel: 12, span: 40, frac: 0.3 } }, 110, 34, T0 + 3000).map(tui.toPlain)[33];
  A.ok(/^ LV 3  ▌{10} {2}XP 12\/40 {2}│ {2}CREW 3 │/.test(lv), 'with the station\'s level it leads with LV and a segmented XP bar: ' + lv);
  const lvRow = screen(m, { stats: { level: 3, inLevel: 12, span: 40, frac: 0.3 } }, 110, 34, T0 + 3000)[33];
  A.eq(lvRow.filter(([t, s]) => /^▌+$/.test(t) && /ph/.test(s)).reduce((n, [t]) => n + t.length, 0), 3,'the XP bar lights the share of the level it has made (3 of 10)');
  const tight = screen(m, { stats: { level: 3, inLevel: 12, span: 40, frac: 0.3 } }, 92, 34, T0 + 3000).map(tui.toPlain)[33];
  A.ok(/^ LV 3 .*NEEDS YOU │? *\d\d:\d\d $/.test(tight) && !/SPEND/.test(tight) && !/│ *\d\d:\d\d/.test(tight.replace(/ +\d\d:\d\d $/, '')) , 'a narrower bar leaves out what does not fit whole, never a cut word: ' + tight);
  const mono = rows.map(r => tui.toAnsi(r, 0)).join('\n');
  A.ok(/\x1b\[[0-9;]*7m COMMS ▸ ASTRA /.test(mono) && /\x1b\[[0-9;]*7m \d\d:\d\d /.test(mono), 'with NO_COLOR the filled labels are reverse video, so they still read as filled');
  const sel = rows[astraRow].find(([t]) => /ASTRA/.test(t));
  A.ok(sel && /sel/.test(sel[1]) && /hi b/.test(sel[1]), 'the agent in COMMS sits on the highlight bar, in white: ' + (sel && sel[1]));
  A.ok(!rows.flat().some(([, st]) => /a[0-5]/.test(st)), 'one palette: no agent has a hue of its own');
  A.ok(!text.some(l => /NOW {2}/.test(l)), 'the ask on the card is not said again on a NOW line (the only busy agent is the one asking)');
  {
    const m2 = crew();
    m2.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' }, T0);
    m2.apply('permission.prompt', { runId: 'r1', agentId: 'astra', promptId: 'p1', tool: 'fs.write', argsSummary: 'auth.js (+2 −1)' }, T0 + 2);
    m2.apply('agent.run.start', { runId: 'r2', agentId: 'cypher', trigger: 'schedule', surface: 'autonomous', prompt: 'nightly tests' }, T0);
    m2.apply('agent.tool_call', { runId: 'r2', agentId: 'cypher', callId: 'c1', name: 'shell_exec', argsSummary: '{"command":"npm test"}' }, T0 + 5);
    const t2 = screen(m2, {}, 110, 34, T0 + 3000).map(tui.toPlain);
    const nowRow = t2.findIndex(l => /NOW {4}CYPHER › shell\.exec npm test/.test(l));
    A.ok(nowRow === 1 && t2[nowRow].indexOf('NOW') > 45 && !/ASTRA/.test(t2[nowRow]), 'a NOW line beside the logo says what the other busy ones are doing: ' + t2[nowRow]);
    A.ok(t2.some(l => /│  ⠋ CYPHER +▌{6} │/.test(l)) && t2.some(l => /^│ WORKING 1 +│/.test(l)), 'a working agent spins under the WORKING strip, its recent activity as a segmented meter');
    const m6 = crew();
    m6.tick(T0);
    m6.apply('agent.run.start', { runId: 'r6', agentId: 'cypher', trigger: 'schedule', surface: 'autonomous', prompt: 'nightly tests' }, T0 + 100);
    m6.tick(T0 + 2000);   // the slot it started in: it did something
    for (let i = 2; i <= 4; i++) m6.tick(T0 + i * 2000);   // three slots waiting on its model: nothing came back
    m6.apply('agent.token', { runId: 'r6', agentId: 'cypher', delta: 'scoring the run against the rubric' }, T0 + 9000);
    m6.tick(T0 + 10000);
    m6.tick(T0 + 12000);   // and a last quiet slot
    const lit = screen(m6, { focus: 'cypher' }, 110, 34, T0 + 12500).find(r => /CYPHER/.test(tui.toPlain(r)) && /^│▌/.test(tui.toPlain(r)));
    const cells = lit ? lit.flatMap(([t, s]) => [...t].map(ch => [ch, s])).filter(([ch]) => ch === '▌').slice(1) : [];
    A.eq(cells.map(([, s]) => /ph/.test(s) ? 1 : 0), [1, 0, 0, 0, 1, 0], 'a segment lights only for a slot the agent did something in: a run left waiting on its model reads dim, never busy');
    A.ok(/⠋ 2 working/.test(t2[0]), 'the working count spins too');
    const spun = tui.render(m2, { focus: 'astra', input: '', scroll: 0, still: false, stationLabel: '' }, { cols: 110, rows: 34 }, T0 + 3150).map(tui.toPlain);
    A.ok(spun.some(l => /│  ⠙ CYPHER/.test(l)), 'a moving screen turns the wheel (frame 2 at +150 ms)');
  }
  A.ok(text[crewTop].indexOf('╭', 1) >= 29 && !/CREW|COMMS/.test(text[crewTop]), 'COMMS is framed beside the crew, from right under the tab rule, so it gets most of the screen (the frames carry no titles)');
  const compact = screen(m, {}, 70, 20, T0 + 3000).map(tui.toPlain);
  const cTop = compact.findIndex(l => /^╭─ COMMS ▸ ASTRA /.test(l));
  A.ok(/S T A R N E T/.test(compact[0]) && /1 needs you/.test(compact[0]) && cTop > 0 && cTop <= 3 && /2\/3 ─╮$/.test(compact[cTop].trimEnd()) && !compact.some(l => /CREW/.test(l)), 'a small terminal gets the one-line mark with the counts, and COMMS full width, saying which agent of how many: ' + compact[cTop]);
  A.ok(!screen(m, { logo: 'plain' }, 110, 34, T0).map(tui.toPlain).some(l => l.indexOf(logo.word[1].trim()) >= 0), 'STARNET_LOGO=plain keeps to the one-line mark');
  A.ok(text.some(l => /ASTRA ASKS/.test(l)) && text.some(l => /\[Y\] ALLOW ONCE/.test(l)), 'the open ask is a card with its keys');
  A.ok(text.some(l => /evil {2}text|evil text/.test(l)), 'model text is shown…');
  A.ok(!rows.some(r => r.some(([t]) => /\x1b|\x07/.test(t))), '…with every escape sequence stripped before it reaches a cell');
  const ansi = rows.map(r => tui.toAnsi(r, 3)).join('\n');
  A.ok(!/\x1b\[2J|\x1b\]0;/.test(ansi), 'the ANSI output carries only our own styling');
  A.ok(!/\x1b\[(38|48);/.test(rows.map(r => tui.toAnsi(r, 0)).join('')), 'NO_COLOR level emits no colors');
  const narrow = screen(m, {}, 60, 30, T0).map(tui.toPlain);
  A.ok(narrow.every(l => tui.width(l) <= 60) && narrow.some(l => /^╭─ COMMS ▸ ASTRA /.test(l)), 'narrow: still fits, COMMS framed');
  {
    const m3 = crew();
    m3.applyLines({ lines: [{ lineId: 'L1' }, { lineId: 'L2', shipped: 19 }] }, [
      { id: 'j1', line: 'L1', name: 'Venture Crucible', status: 'delivered', endedAt: T0 - 5 * 86400000, steps: 8 },
      { id: 'j2', line: 'L2', name: 'RIFT / 98 Evolution', status: 'delivered', endedAt: T0 - 4 * 86400000, steps: 6 }]);
    const fl = screen(m3, {}, 119, 30, T0).map(tui.toPlain).find(l => /FLOWS/.test(l));
    A.ok(/Venture Crucible 5d ago +\+1\s*$/.test(fl) && !/RIFT/.test(fl), 'a flow that does not fit is counted, never cut off mid-word: ' + fl.slice(56));
  }
  {
    // MARKDOWN: an agent's reply reads as formatted text, never raw ** ` ``` markers
    const m6 = crew();
    m6.apply('agent.run.start', { runId: 'md', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'how?' }, T0);
    m6.apply('agent.token', { runId: 'md', agentId: 'astra', delta: '## Steps\nDo it **here**, with `/model`:\n- first *thing*\n2. second [docs](https://starnetos.com/d)\n```\nstarnet ls\n```' }, T0 + 1);
    m6.apply('agent.run.end', { runId: 'md', agentId: 'astra', reason: 'done' }, T0 + 2);
    const segs = screen(m6, {}, 110, 34, T0 + 5);
    const t6 = segs.map(tui.toPlain);
    A.ok(t6.some(l => /│ ASTRA +Steps +│|ASTRA {3,}Steps/.test(l)) && !t6.some(l => /\*\*|```|`\/model`|## /.test(l)), 'markdown markers never reach the screen');
    A.ok(t6.some(l => /Do it here, with \/model:/.test(l)) && t6.some(l => /• first thing/.test(l)) && t6.some(l => /2\. second docs \(https:\/\/starnetos\.com\/d\)/.test(l)) && t6.some(l => /│ starnet ls/.test(l)), 'bold, code, bullets, numbered items, links and code blocks read as a terminal shows them');
    const bold = segs.flat().find(([t, s]) => t === 'here' && /hi b/.test(s)), code = segs.flat().find(([t, s]) => t === '/model' && /\bam\b/.test(s));
    A.ok(!!bold && !!code, 'bold is bold white, inline code is amber');
    // the PICKER (/model, /resume): filter by every typed word, the current item marked, the selection on the bar
    const items = [['codex', 'gpt-6.1-sol'], ['codex', 'gpt-5.6-sol'], ['openrouter', 'anthropic/claude-sonnet-5-5'], ['claude-cli', 'claude-opus-5-5']].map(([p, id]) => ({ cols: [[p + '  ', 'dim'], [id, 'fg']], search: p + ' ' + id, current: id === 'gpt-5.6-sol' }));
    A.eq(tui.pickerView({ items, filter: 'claude opus' }).map(i => i.search), ['claude-cli claude-opus-5-5'], 'the filter keeps items matching every word');
    const pk = screen(crew(), { picker: { title: 'MODEL · ASTRA', note: 'now codex · gpt-5.6-sol', filter: 'gpt', sel: 1, items } }, 110, 34, T0).map(tui.toPlain);
    A.ok(pk.some(l => /MODEL · ASTRA .*now codex · gpt-5\.6-sol/.test(l)) && pk.some(l => /› gpt.* 2 of 4/.test(l)), 'the picker says what it picks for, what it is now, the filter and the count');
    A.ok(pk.some(l => /▌● codex +gpt-5\.6-sol/.test(l)) && pk.some(l => / {2}codex +gpt-6\.1-sol/.test(l)) && !pk.some(l => /claude/.test(l)), 'the selection sits on the bar, the current one is marked, filtered-out items are gone');
    // a conversation switch starts the pane over
    const m7 = crew();
    m7.noteSent('astra', 'old talk', 'cli-astra', T0);
    m7.resetLog('astra', '— a new conversation with ASTRA —');
    A.eq(m7.logOf('astra').map(e => e.text), ['— a new conversation with ASTRA —'], '/new: the pane starts over under one divider');
  }
  {
    // the edges a long-lived station reaches: a long name, an hour-long run, a web request, a roster not loaded yet
    const m4 = crew();
    m4.setRoster({ agents: [{ agentId: 'comms-lead', name: 'Communications Lead', model: 'm' }] });
    m4.apply('agent.run.start', { runId: 'r9', agentId: 'comms-lead', trigger: 'schedule', surface: 'autonomous', prompt: 'nightly digest' }, T0 - 3725000);
    const t4 = screen(m4, { focus: 'comms-lead' }, 119, 30, T0).map(tui.toPlain);
    A.ok(t4.some(l => /│▌ ⠋ COMMUNICATIONS… +▌{6} │/.test(l)), 'a long name keeps its words and shortens with … beside its meter: ' + t4.find(l => /COMMUNICATIONS/.test(l) && /^│▌/.test(l)));
    const t4i = screen(m4, { focus: 'comms-lead', images: true }, 119, 30, T0).map(tui.toPlain);
    A.ok(t4i.some(l => /^├─ COMMUNICATIONS… ⠋ +● REC ─/.test(l)), 'on the camera\'s rule a long name keeps the room: its run time steps aside: ' + t4i.find(l => /^├─/.test(l)));
    A.ok(/┘ COMMS ▸ COMMUNICATIONS LEAD └/.test(t4[3]) && t4.some(l => /│ ROUTINE +nightly digest/.test(l)), 'the tab names it whole, and its speaker column fits the name');
    const { askGlance, fmtDur } = require('../bin/lib/station-model.js');
    A.eq([fmtDur(65000), fmtDur(3725000)], ['1m05s', '1h02m'], 'durations: minutes and seconds, then hours and minutes');
    A.eq(askGlance('web.request', JSON.stringify({ method: 'post', url: 'https://hooks.example.com/deploy' })), 'POST https://hooks.example.com/deploy', 'a web request asks with its method');
    const m5 = makeStation();
    const t5 = screen(m5, { focus: '' }, 110, 30, T0).map(tui.toPlain);
    A.ok(/┘ COMMS └/.test(t5[3]) && t5.some(l => /connecting to the station…/.test(l)), 'before the roster loads, COMMS says it is connecting (never an empty tab titled —)');
  }
  A.ok(/needs at least/.test(tui.toPlain(screen(m, {}, 40, 10, T0)[0])), 'a terminal too small says so');
  const help = screen(m, { overlay: { title: 'COMMANDS', items: tui.HELP, foot: 'any key closes this' } }, 110, 34, T0).map(tui.toPlain);
  A.ok(/┘ COMMANDS └/.test(help[3]) && help.some(l => /right-click +an agent: its menu/.test(l)), '/help, beside an open ask: the tab names the list, so the list keeps the row');
  const footY = help.findIndex(l => /↓ \d+ more · the wheel or pgup pgdn scrolls · any key closes this/.test(l));
  A.ok(footY > 0 && footY < help.findIndex(l => /ASTRA ASKS/.test(l)), 'what does not fit is said, never cut silently: ' + help[footY]);
  const ov = { title: 'COMMANDS', items: tui.HELP, foot: 'any key closes this', scroll: 99 };
  const helpEnd = screen(m, { overlay: ov }, 110, 34, T0).map(tui.toPlain);
  A.ok(helpEnd.some(l => /\/flow \[run name text\]/.test(l)) && helpEnd.some(l => /\/help  ctrl\+c +this list · quit/.test(l)) && helpEnd.some(l => /↑ \d+ above/.test(l)) && ov.scroll === tui.HELP.length - 20, 'scrolled to its end, every command is there');
  A.ok(!screen(crew(), { overlay: { title: 'COMMANDS', items: tui.HELP, foot: 'any key closes this' } }, 110, 40, T0).map(tui.toPlain).some(l => /more · /.test(l)), 'a list that fits says nothing more');
  A.eq(tui.colorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true), 0, 'NO_COLOR wins');
  A.eq(tui.colorLevel({ COLORTERM: 'truecolor' }, true), 3, '24-bit where the terminal says so');
  A.eq(tui.colorLevel({}, false), 0, 'no TTY, no color');
  A.eq(tui.width('日本'), 4, 'wide glyphs take two cells');
}

// ---- ls + watch formatting -----------------------------------------------------------------------------------------
{
  const m = crew();
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive' }, T0);
  m.apply('permission.prompt', { runId: 'r2', agentId: 'cypher', promptId: 'p', tool: 'fs.write', argsSummary: 'x.md' }, T0);
  const rows = sc.lsRows(m, T0 + 65000);
  A.eq(rows.map(r => r.status), ['idle', 'working', 'needs-you'], 'ls statuses');
  A.ok(/desktop run · 1m05s/.test(rows[1].now), 'ls says where a run came from and for how long');
  const out = sc.formatLs(rows, { usd: 0.4 }, 100);
  A.ok(/^AGENT\s+MODEL\s+STATUS\s+NOW/.test(out) && /1 working · 1 need you · \$0\.40 today/.test(out), 'ls table + summary line');
  const fmt = sc.makeWatchFormatter({ astra: 'ASTRA' });
  const at = new Date(2026, 9, 17, 12, 4, 31).getTime();
  A.eq(fmt({ name: 'agent.run.start', payload: { runId: 'r', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' } }, at), ['12:04:31  ASTRA       ▸ started (desktop) "fix it"'], 'watch: a run start');
  A.eq(fmt({ name: 'agent.token', payload: { runId: 'r', agentId: 'astra', delta: 'Hello ' } }, at), [], 'tokens wait for a whole line');
  A.eq(fmt({ name: 'agent.token', payload: { runId: 'r', agentId: 'astra', delta: 'there.\nNext' } }, at), ['12:04:31  ASTRA       Hello there.'], 'a finished line prints');
  A.eq(fmt({ name: 'agent.run.end', payload: { runId: 'r', agentId: 'astra', reason: 'done', usd: 0.0012 } }, at), ['12:04:31  ASTRA       Next', '12:04:31  ASTRA       ■ done · $0.0012'], 'the rest flushes at the end');
  const ask = fmt({ name: 'permission.prompt', payload: { agentId: 'astra', tool: 'fs_write', argsSummary: '{\n "path": "a"\n}' } }, at)[0];
  A.ok(/▲ needs you · fs\.write a\s+\(starnet approve astra\)/.test(ask), 'watch: an ask on one line, with the command that answers it: ' + ask);
  {
    const { askGlance, askInspect } = require('../bin/lib/station-model.js');
    const w = JSON.stringify({ path: 'auth-fix.md', content: '# Fix\n\nKeep ?next= through.\n' }, null, 2);
    A.eq(askGlance('fs.write', w), 'auth-fix.md (3 lines)', 'a file write asks as its file and how much goes in');
    A.eq(askInspect('fs.write', w), 'File: auth-fix.md\n\n# Fix\n\nKeep ?next= through.\n', '[v] reads a file write as the file: its path, then its text as written');
    A.eq(askGlance('shell.exec', JSON.stringify({ command: 'npm run test:fast', cwd: 'C:/w' }, null, 2)), 'npm run test:fast', 'a command asks as the command');
    A.eq(askGlance('fs.write', 'auth.js (+2 −1)'), 'auth.js (+2 −1)', 'a summary the station already worded is kept');
  }
}

// ---- the real logo as an image (Sixel) ----------------------------------------------------------------------------
{
  const sx = require('../bin/lib/sixel.js');
  const r = sx.logoSixel({ cellW: 10, cellH: 20, rows: 4, maxCols: 80 });
  A.ok(r && r.rows === 4 && r.height === 78 && r.cols === Math.ceil(r.width / 10), 'the image fits four rows of 20 px cells: ' + JSON.stringify(r && { cols: r.cols, rows: r.rows, width: r.width, height: r.height }));
  A.ok(/^\x1bP0;1;0q"1;1;\d+;\d+/.test(r.sixel) && r.sixel.endsWith('\x1b\\'), 'a DCS Sixel with transparent background and raster size');
  const d = sx.decodeSixel(r.sixel);
  let lit = 0; for (const v of d.px) if (v >= 0) lit++;
  A.ok(d.width === r.width && d.height === r.height && lit / d.px.length > 0.05 && lit / d.px.length < 0.6, 'it decodes back to the wordmark: ' + (lit / d.px.length).toFixed(3) + ' of pixels lit');
  const narrow = sx.logoSixel({ cellW: 10, cellH: 20, rows: 4, maxCols: 30 });
  A.ok(narrow && narrow.rows < 4 && narrow.cols <= 30, 'a narrow terminal gets a shorter image that still fits');
  {
    // scale: the wordmark a bit smaller inside the same rows, centred top to bottom
    const full = sx.logoSixel({ cellW: 10, cellH: 20, rows: 3 }), small = sx.logoSixel({ cellW: 10, cellH: 20, rows: 3, scale: 0.8 });
    const inkRows = r => { const d = sx.decodeSixel(r.sixel); const ys = []; for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.px[y * d.width + x] >= 0) { ys.push(y); break; } return { h: d.height, top: ys[0], bot: ys[ys.length - 1] }; };
    const f = inkRows(full), s = inkRows(small);
    A.ok(small.rows === 3 && small.height === full.height && s.h === f.h, 'scaled, the logo keeps its 3 rows (what sits beside it stays put)');
    A.ok(small.cols < full.cols && (s.bot - s.top) < (f.bot - f.top) * 0.85 && s.top > 3 && (s.h - 1 - s.bot) > 3, 'and draws the wordmark ~80% the size, centred: ' + full.cols + '→' + small.cols + ' columns, ink rows ' + s.top + '–' + s.bot + ' of ' + s.h);
  }
  A.eq(sx.logoSixel({ cellW: 10, cellH: 20, rows: 4, maxCols: 3 }), null, 'no room at all → no image (the text logo stands in)');
  A.eq(sx.parseTermReplies('\x1b[6;20;10t\x1b[4;680;1200t\x1b[?61;4;6;7;14;21;22c', 120, 34), { sixel: true, cellW: 10, cellH: 20, replied: true }, "Windows Terminal's real reply: Sixel, 10×20 cells");
  A.eq(sx.parseTermReplies('\x1b[?1;2c', 80, 24).sixel, false, 'a terminal without Sixel draws the text logo');
  A.eq(sx.parseTermReplies('\x1b[4;680;1200t\x1b[?62;4c', 120, 34).cellH, 20, 'the cell size falls back to the window size ÷ its cells');
  A.eq(tui.sliceSegs([['abc', 'x'], ['de', 'y']], 2), [['c', 'x'], ['de', 'y']], 'a row beside the image starts to its right');
  const m = crew();
  const img = screen(m, { logoImage: { cols: 58, rows: 4 } }, 120, 30, T0).map(tui.toPlain);
  A.ok(img.slice(0, 4).every(l => l.slice(0, 58).trim() === ''), "the image's cells stay blank (the image is painted there, never written over)");
  A.ok(/0 working/.test(img[0].slice(61)) && /^── STAT ─── CREW 3 /.test(img[4]) && /^╭─+╮╭─/.test(img[5]), 'the counts sit beside the image, the crew list under it: ' + img[0].slice(55, 120));
  A.ok(!img.some(l => l.indexOf(require('../bin/lib/logo.js').word[1].trim()) >= 0), 'with the image, the text logo is not drawn');
}

// ---- the camera feed: the station camera locked on the agent in COMMS, made of ASCII, at the foot of CREW --------------
{
  const fs = require('fs');
  const path = require('path');
  const cf = require('../bin/lib/camfeed.js');
  const sx = require('../bin/lib/sixel.js');
  const png = require('../bin/lib/png.js');
  const FRONT = path.join(__dirname, '..', 'frontend');
  const chair = png.decode(fs.readFileSync(path.join(FRONT, 'assets', 'furniture', 'chair.png')));
  A.ok(chair.width === 48 && chair.height === 48 && chair.data.some((v, i) => i % 4 === 3 && v === 255), 'the built-in PNG reader decodes the app\'s furniture: ' + chair.width + '×' + chair.height);
  const skins = cf.parseSkins("DATA.SKINS = {\n  blank: {\"name\":\"Cadet\",\"set\":\"approved_android\"},\n  ultron: {\"name\":\"U\",\"set\":\"approved_ultron\"},\n  alien: {\"name\":\"Alien\",\"set\":\"approved_alien\"},\n  junk: {not json},\n  evil: {\"set\":\"../../etc\"},\n};\nDATA.DEFAULT_SKIN = 'blank';");
  A.eq([skins.alien, skins.junk, skins.evil, skins['']], ['approved_alien', undefined, undefined, 'approved_android'], "the app's skin table is read off data-shim.js; a bad line or a path-like set is skipped");
  A.eq([cf.setFor('researcher', 'alien', skins), cf.setFor('kaze', '', skins), cf.setFor('ULTRON', 'alien', skins)], ['approved_alien', 'approved_android', 'approved_ultron'], "each agent wears its own skin, the default when it has none, ULTRON its own — the app's rule");

  const feed = cf.makeCamFeed();
  const box = { cellW: 10, cellH: 20, cols: 26, rows: 8 };
  A.eq(feed.frame('nova', 'idle', T0, false, box), null, 'no skin yet → no feed (the card waits)');
  feed.setSkin('nova', 'approved_elonmusk');
  const want = feed.needs('nova');
  A.ok(want.some(p => /\/assets\/sprites\/approved_elonmusk\/type_north_1\.png$/.test(p)) && want.some(p => /\/assets\/furniture\/chair\.png$/.test(p)) && want.every(p => /^\/assets\/(sprites|furniture)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\.png$/.test(p)), 'it asks for exactly its skin\'s walk / type frames and the room\'s furniture (' + want.length + ' files)');
  A.eq(feed.frame('nova', 'idle', T0, false, box), null, 'until they are in, no feed');
  for (const p of want) { const f = path.join(FRONT, p); feed.add(p, fs.existsSync(f) ? fs.readFileSync(f) : null); }
  A.eq(feed.needs('nova').length, 0, 'every file handed in (a missing one counts as answered)');
  const f0 = feed.frame('nova', 'idle', T0, false, box);
  const d0 = sx.decodeSixel(f0.sixel);
  A.ok(d0.width === 260 && d0.height === 160, 'one frame fills the card exactly: 26 × 8 cells of 10 × 20 px = ' + d0.width + '×' + d0.height);
  A.ok(d0.px.every(v => v >= 0 && v < cf.PALETTE.length), 'every pixel is one of StarNet\'s palette colours');
  // its walk follows its state
  const sim = (key, from, ms) => { let f; for (let t = from; t <= from + ms; t += 100) f = feed.frame('nova', key, T0 + t, false, box); return { f, s: feed.sim('nova', key, T0 + from + ms) }; };
  const idleA = feed.sim('nova', 'idle', T0 + 50);
  const w = sim('working', 100, 9000);
  A.ok(w.s.sat && Math.abs(w.s.x - 372) < 1, 'given work, it walks to its desk and sits: at x ' + Math.round(w.s.x) + ' (the seat is 372), started at ' + Math.round(idleA.x));
  const typing = new Set(); for (let t = 9200; t < 10400; t += 100) typing.add(feed.frame('nova', 'working', T0 + t, false, box).key);
  A.ok(typing.size >= 3, 'seated, it types: its frames change (' + typing.size + ' looks in a second)');
  const used = f => { const d = sx.decodeSixel(f.sixel); const s = new Set(); for (const v of d.px) s.add(v); return [...s].map(i => cf.PALETTE[i]); };
  A.ok(used(feed.frame('nova', 'working', T0 + 10500, true, box)).some(([r, g, b]) => r > 170 && g < r * 0.4 && b < r * 0.45), 'working: its rim is the station red');
  sim('needs', 10600, 300);
  A.ok(used(feed.frame('nova', 'needs', T0 + 11000, true, box)).some(([r, g, b]) => r > 170 && g > r * 0.55 && g < r * 0.8 && b < 80), 'needs you: amber');
  const dn = sim('done', 11100, 4000);
  A.ok(!dn.s.sat && used(feed.frame('nova', 'done', T0 + 15200, true, box)).some(([r, g, b]) => g > 150 && g > r * 1.8 && g > b * 1.2), 'done: it gets up, rimmed green');
  const st1 = feed.frame('nova', 'done', T0 + 20000, true, box).key, st2 = feed.frame('nova', 'done', T0 + 20000, true, box).key;
  A.eq(st1, st2, 'the same moment draws the same frame (cached, not redrawn)');

  const m = crew();
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' }, T0);
  const withImg = screen(m, { images: true }, 120, 34, T0 + 12000);
  const scr = withImg.map(tui.toPlain);
  const div = scr.findIndex(l => /^├─/.test(l));
  const crewTop = scr.findIndex(l => /^╭─+╮╭─/.test(l));
  const bot = scr.findIndex((l, i) => i > crewTop && /^╰─+╯/.test(l));
  const av = withImg.avatar;
  A.ok(div > crewTop && bot - div === 9 && /^├─ ASTRA ⠋ working ─+ ● REC ─*┤/.test(scr[div]), 'the card sits at the foot of CREW: its rule names the agent, says what it does, and carries the camera\'s REC light: ' + scr[div]);
  A.ok(av && av.x === 2 && av.y === div + 1 && av.cols === 26 && av.rows === 8 && av.id === 'astra' && av.key === 'working', 'the screen tells the dashboard where the feed goes, of whom, doing what: ' + JSON.stringify(av));
  A.ok(scr.slice(av.y, av.y + av.rows).every(l => l.slice(av.x, av.x + av.cols).trim() === ''), 'and leaves those cells empty for the image');
  const noImg = screen(m, {}, 120, 34, T0 + 12000);
  A.ok(!noImg.avatar && !noImg.map(tui.toPlain).some(l => /^├─/.test(l)), 'a terminal that cannot draw images has no card: the crew list keeps the room');
  const room = makeStation();
  room.setRoster({ agents: Array.from({ length: 12 }, (_, i) => ({ agentId: 'a' + i, name: 'Agent' + i })) });   // + the overseer the model adds = 13
  A.ok(screen(room, { focus: 'a3', images: true }, 120, 32, T0).avatar, 'a crew of 13 in a 120×32 window still has it (its STANDING BY strip and 13 rows above the camera)');
  A.ok(!screen(room, { focus: 'a3', images: true }, 120, 30, T0).avatar, 'two rows shorter, the 13 keep the room and the camera steps aside');
  const big = makeStation();
  big.setRoster({ agents: Array.from({ length: 24 }, (_, i) => ({ agentId: 'a' + i, name: 'Agent' + i })) });
  A.ok(!screen(big, { focus: 'a3', images: true }, 120, 30, T0).avatar, 'when the crew list needs the room, the card steps aside');
  A.eq(tui.sliceSegs([['abcdef', 'x'], ['gh', 'y']], 2, 5), [['cde', 'x']], 'a row beside the image is written either side of it');
}

// ---- the folder: the trusted project `starnet` was started in, or the card asking to trust it ------------------------
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const folder = require('../bin/lib/folder.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-folder-'));
  const proj = path.join(tmp, 'proj'), deep = path.join(proj, 'src', 'lib'), loose = path.join(tmp, 'notes'), wt = path.join(tmp, 'tree');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true }); fs.mkdirSync(deep, { recursive: true }); fs.mkdirSync(loose); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere');
  A.eq(folder.projectRoot(deep), proj, 'a folder inside a git project is that project');
  A.eq(folder.projectRoot(wt), wt, 'a worktree (.git is a file) is a project too');
  A.eq(folder.projectRoot(loose), loose, 'a folder in no git project is itself');

  const W = { platform: 'win32', path: path.win32, env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, home: 'C:\\Users\\you' };
  A.eq(folder.skipReason('C:\\Users\\you', W), 'home', 'your home folder (where a shell opens) is never offered');
  A.eq(folder.skipReason('c:\\users\\YOU', W), 'home', '…in any case');
  A.eq(folder.skipReason('C:\\', W), 'root', 'nor a drive root');
  A.eq(folder.skipReason('C:\\Windows\\System32', W), 'system', 'nor the OS (an admin shell opens in System32)');
  A.eq(folder.skipReason('C:\\Users\\you\\AppData\\Roaming\\ai.skynet.harness\\workspaces\\agent', Object.assign({ stationDirs: ['C:\\Users\\you\\AppData\\Roaming\\ai.skynet.harness\\workspaces'] }, W)), 'station', "nor StarNet's own workspaces");
  A.eq(folder.skipReason('C:\\Users\\you\\Desktop\\gen', W), '', 'a project in your home is');
  A.eq(folder.skipReason('/', { platform: 'linux', path: path.posix, env: {}, home: '/home/you' }), 'root', 'the filesystem root');
  A.eq(folder.skipReason('/home/you/code/app', { platform: 'linux', path: path.posix, env: {}, home: '/home/you' }), '', 'a linux project is offered');

  const projects = [{ root: 'C:\\Code\\App', blessed: true }, { root: 'C:\\Code', blessed: true }, { root: 'C:\\Code\\App\\pkg', blessed: false }];
  A.eq(folder.trustedRoot('c:\\code\\app\\pkg\\src', projects, W), 'C:\\Code\\App', 'the deepest TRUSTED project holding the folder, spelled as the station spells it (an untrusted one is no grant)');
  A.eq(folder.trustedRoot('C:\\Codex', projects, W), '', 'a folder that only starts with a trusted name is not inside it');
  A.eq(folder.trustedRoot('C:\\Code', [{ root: 'C:\\Code', blessed: false }], W), '', 'a project whose trust was removed is not trusted');

  const real = p => fs.realpathSync.native(p);
  const t1 = folder.locate({ cwd: deep, projects: [] }, { home: tmp });
  A.eq([t1.folder, t1.root, t1.trusted, t1.skip], [real(deep), real(proj), '', ''], 'not trusted yet: the project to ask about, from the folder you are in');
  const t2 = folder.locate({ cwd: deep, projects: [{ root: real(proj), blessed: true }] }, { home: tmp });
  A.eq(t2.trusted, real(proj), 'trusted: every message works there, no card');
  A.eq(folder.locate({ cwd: tmp, projects: [] }, { home: tmp }).skip, 'home', 'started in your home folder: nothing to ask');
  A.eq(folder.shortPath('C:\\Users\\you\\Desktop\\gen', 40, W), '~\\Desktop\\gen', 'a folder in your home is said from ~');
  A.ok(/^…/.test(folder.shortPath('D:\\' + 'x'.repeat(60) + '\\app', 20, W)) && [...folder.shortPath('D:\\' + 'x'.repeat(60) + '\\app', 20, W)].length === 20, 'a long one keeps its far end');
  A.ok(folder.isLocalHost('127.0.0.1') && folder.isLocalHost('localhost') && !folder.isLocalHost('10.0.0.5'), 'only a station on this machine shares its folders');
  fs.rmSync(tmp, { recursive: true, force: true });

  // the card
  const m = crew();
  const trust = { root: 'C:\\Code\\App', folder: 'C:\\Code\\App\\src' };
  const s1 = screen(m, { trust }, 110, 34, T0).map(tui.toPlain);
  const top = s1.findIndex(l => /┌─ ▲ TRUST THIS FOLDER\? ─/.test(l));
  A.ok(top > 0 && /│ C:\\Code\\App +│/.test(s1[top + 1]) && /you are in src · the whole project is trusted/.test(s1[top + 2]), 'started in a folder not trusted yet: COMMS asks to trust its project, naming it: ' + s1.slice(top, top + 3).join(' / '));
  A.ok(s1.some(l => /the crew can read and change files here · it joins PROJECTS in the app/.test(l)) && s1.some(l => /not now: each agent works in its own workspace/.test(l)) && s1.some(l => /└─ \[Y\] TRUST {3}\[N\] NOT NOW ─/.test(l)), 'says what trusting means, what not trusting means, and its keys');
  A.ok(/^y trust this folder · n not now/.test(s1[32]), 'the key line says them too');
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' }, T0);
  m.apply('permission.prompt', { runId: 'r1', agentId: 'astra', promptId: 'p1', tool: 'fs.write', argsSummary: 'auth.js (+2 −1)' }, T0 + 2);
  const s2 = screen(m, { trust }, 110, 34, T0 + 10).map(tui.toPlain);
  A.ok(s2.some(l => /ASTRA ASKS/.test(l)) && !s2.some(l => /TRUST THIS FOLDER/.test(l)), 'an agent waiting on an ask comes first: the folder card waits behind it');
  A.ok(!tui.trustLines({ root: '/home/you/app', folder: '/home/you/app' }, 60).some(l => l.segs && /you are in/.test(l.segs[0][0])), 'started at the project root: no "you are in" line');
  for (const [c, r] of [[110, 34], [70, 20]]) {
    const s3 = screen(crew(), { project: { root: 'C:\\Code\\App', label: '~\\Code\\App' } }, c, r, T0).map(tui.toPlain);
    const foot = s3.findIndex(l => /╰─ ~/.test(l));
    A.ok(foot === (c >= 100 ? r - 4 : r - 3) && /^.*╰─ ~\\Code\\App ─+╯$/.test(s3[foot].trimEnd()), 'working in a trusted project: the foot of COMMS says which (' + c + ' columns), right over the prompt: ' + s3[foot]);
  }
  A.ok(!screen(crew(), {}, 110, 34, T0).map(tui.toPlain).some(l => /╰─ \S/.test(l)), 'in no project: the foot says nothing');
}

// ---- the station's slash commands in COMMS ------------------------------------------------------------------------
{
  const m = crew();
  m.noteSaid('astra', '/usage', 'Spend', ['today $0.42 · lifetime $12.30', '214 runs'], true, T0);
  m.noteSaid('astra', '/routine', '', ['no routine named "nightly"'], false, T0 + 1);
  m.noteSent('astra', 'Use the "plan" skill recipe for this task.\n\nSkill recipe:\n1. read\n2. plan\n\nTask: refactor commands', 'cli-astra', T0 + 2);
  const shown = m.logOf('astra')[m.logOf('astra').length - 1];
  A.ok(/^Use the "plan" skill/.test(shown.text), 'noteSent keeps what it is handed (the dashboard hands it what to SHOW)');
  const m2 = crew();
  m2.noteSaid('astra', '/usage', 'Spend', ['today $0.42 · lifetime $12.30', '214 runs'], true, T0);
  m2.noteSaid('astra', '/routine', '', ['no routine named "nightly"'], false, T0 + 1);
  m2.noteSent('astra', '/plan refactor commands', 'cli-astra', T0 + 2);
  const rows = screen(m2, {}, 110, 34, T0 + 10);
  const text = rows.map(tui.toPlain);
  const u = text.findIndex(l => /\/usage +Spend/.test(l));
  A.ok(u > 0 && /today \$0\.42 · lifetime \$12\.30/.test(text[u + 1]) && /214 runs/.test(text[u + 2]), 'a station command\'s answer shows under the command that asked: its title, then its lines: ' + text.slice(u, u + 3).join(' / '));
  const label = rows[u].find(([t]) => /\/usage/.test(t));
  A.ok(label && /ph b/.test(label[1]), 'the command is the label, in the accent');
  const no = text.findIndex(l => /\/routine +no routine named "nightly"/.test(l));
  const noSeg = no > 0 && rows[no].find(([t]) => /no routine named/.test(t));
  A.ok(noSeg && /am/.test(noSeg[1]), 'a "no" from the station is amber, not an error: it answered');
  A.ok(text.some(l => /YOU +\/plan refactor commands/.test(l)) && !text.some(l => /skill recipe for this task/.test(l)), 'a skill shows as you typed it, not as the whole recipe it sends');
  for (const c of ['/retry', '/status', '/skills', '/usage  /tools', '/routine', '/away', '/version']) A.ok(tui.HELP.some(([k]) => k === c), '/help lists ' + c);
  A.ok(/\/usage · \/tools · \/routine · \/away/.test(core.USAGE) && /each skill as \/<skill> <task>/.test(core.USAGE), 'the usage names the station\'s own commands and skills');
}

// ---- an ask's answers: the app card's own ladder (once · always · deny), Always only where the app offers it ---------------
{
  const m = crew();
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' }, T0);
  m.apply('permission.prompt', { runId: 'r1', agentId: 'astra', promptId: 'p1', tool: 'fs.write', argsSummary: 'auth.js (+2 −1)' }, T0 + 2);
  const s1 = screen(m, {}, 110, 34, T0 + 10).map(tui.toPlain);
  A.ok(s1.some(l => /└─ \[Y\] ALLOW ONCE {3}\[A\] ALWAYS {3}\[N\] DENY {3}\[V\] VIEW ─/.test(l)), 'a file write offers Always, as the app\'s card does');
  A.ok(/^y allow once · a always · n deny · v view/.test(s1[32]), 'and the key line says a');
  m.apply('permission.response', { promptId: 'p1', decision: 'always', via: 'terminal' }, T0 + 20);
  A.ok(m.logOf('astra').some(e => e.k === 'ok' && /^always allowed from the terminal · fs\.write/.test(e.text)), 'answered Always: COMMS says so in the card\'s words');
  const m2 = crew();
  m2.apply('agent.run.start', { runId: 'r2', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'more room' }, T0);
  m2.apply('permission.prompt', { runId: 'r2', agentId: 'astra', promptId: 'p2', tool: 'station.power', argsSummary: 'widen the leash' }, T0 + 2);
  const s2 = screen(m2, {}, 110, 34, T0 + 10).map(tui.toPlain);
  A.ok(s2.some(l => /└─ \[Y\] ALLOW ONCE {3}\[N\] DENY/.test(l)) && !s2.some(l => /\[A\] ALWAYS/.test(l)) && !/a always/.test(s2[32]), 'an ask the app answers fresh every time (the station\'s leash) has no Always');
  m2.apply('permission.response', { promptId: 'p2', decision: 'once', via: 'terminal' }, T0 + 20);
  A.ok(m2.logOf('astra').some(e => e.k === 'ok' && /^allowed once from the terminal/.test(e.text)), 'and the station\'s echo (once) is what COMMS says');
  A.ok(tui.HELP.some(([k, d]) => k === 'y  a  n  v' && /once, always, no, view/.test(d)), '/help lists a');
}

// ---- THE AWAKENING in the terminal (bin/lib/awaken.js): the app's own modules, the app's ceremony, the app's writes ---------
const am = require('../bin/lib/app-modules.js');
{
  const lifted = am.liftFunction('x();\n  function f(a) { const s = "}{"; const r = /[}]/; return `${a}}` + \'}\'; }\nfunction g() {}', 'f');
  A.ok(lifted && /return `\$\{a\}\}` \+ '\}'; \}$/.test(lifted), 'a function is lifted whole: braces in strings, templates and regexes do not end it');
  const M = am.load();
  A.ok(am.COMPOSER_PARTS.every(n => am.liftFunction(require('fs').readFileSync(require('path').join(am.APP_DIR, 'app.js'), 'utf8'), n)), 'app.js still has every function the terminal lifts to compose a prompt (a rename here fails the gate, never a silent drift)');
  const a = { id: 'agent', name: 'VEGA', role: 'orchestrator', personaId: 'blunt', approvalMode: 'full', purpose: null };
  M.composer.docs(a);
  const p = M.composer.compose(a, { dossierBlock: '' });
  A.ok(/^You are VEGA, an AI agent operating from a workstation aboard the STARNET station/.test(p) && /OVERSEER/.test(p) && /YOUR CREW: none yet/.test(p) && /YOUR FOUNDATION/.test(p) && /PERSONALITY — Blunt/.test(p) && /AUTHORITY — FULL POWER/.test(p) && /not yet been given a purpose/.test(p), 'the composed prompt is the app\'s: identity, crew, foundation, personality, authority, the missing purpose');
  A.eq(M.Personas.list().map(x => x.id), ['composed', 'warm', 'blunt', 'dry', 'unhinged', 'upbeat'], 'the personalities are the app\'s own six');
}
async function awakenRun(o) {
  const M = am.load();
  const calls = [], said = [];
  let save = o.save || null, rev = 0, clock = 1800000000000;
  const answer = (path, json, status) => ({ ok: true, status: status || 200, json });
  const st = {
    async get(p) {
      calls.push('GET ' + p);
      if (p === '/api/save?agent=agent') return answer(p, { save });
      if (p === '/api/providers') return answer(p, { providers: [{ id: 'openrouter', name: 'OpenRouter', configured: true }, { id: 'codex', name: 'ChatGPT Codex', configured: false }] });
      if (p === '/api/models/openrouter') return answer(p, { models: [{ id: 'm/one' }, { id: 'm/two' }], default: 'm/one' });
      if (p === '/api/permissions') return answer(p, { grants: ['cabinet:write'], masterBypass: false });
      if (p === '/api/autonomy/posture') return answer(p, { summary: M.Autonomy.fresh() });
      if (p === '/api/nightshift/status') return answer(p, {});
      return answer(p, {}, 404);
    },
    async post(p, body) {
      calls.push('POST ' + p + (p === '/api/save' ? ' onboarded=' + body.agent.onboarded : p === '/api/permissions/revoke' ? ' ' + body.key : p === '/api/autonomy/posture' && body.posture ? ' preset=' + (M.Autonomy.matchPreset ? M.Autonomy.matchPreset(body.posture) : '?') : ''));
      if (p === '/api/save') { save = JSON.parse(JSON.stringify(body)); save._saveRevision = ++rev; return answer(p, { ok: true, revision: rev }); }
      if (p === '/api/roster') { o.rosters.push(body); return answer(p, { ok: true }); }
      return answer(p, { ok: true });
    },
    async chat(c) {
      const d = String(c.directive || '');
      calls.push('CHAT ' + d.slice(0, 40).replace(/\n/g, ' '));
      if (o.darkMind && !/Reply with exactly: OK/.test(d)) return { error: 'the provider returned an error' };
      if (/Reply with exactly: OK/.test(d)) return { text: 'OK' };
      if (/YOU ARE BEING SWITCHED ON/.test(d)) return { text: 'WAKE: flick / on\nTHINK: mine\nFLOODIN: all at once\nCREST: too much\nSETTLE: it is mine\nAIMLESS: aimed at nothing\nNOTICE: someone is here\nCONTACT: you lit me. aim me.\nMANDATE: i run the floor.' };
      if (/THE TUESDAY/.test(d)) return { text: (d.match(/"question"/g) || []).length >= 2 ? 'ACK: clear.\nASK: NONE' : 'ACK: a newsletter — good.\nASK: what is it about?\nBELIEF goals: Grows a newsletter' };
      if (/OFFER1/.test(d)) return { text: 'OFFER1: Draft the weekly issue\nOFFER2: Sort reader replies' };
      if (/READ:/.test(d)) return { text: 'READ: you write a newsletter about AI tools.\nPURPOSE: Help me write and grow my AI tools newsletter.\nSTACK: Substack' };
      return { text: 'ok' };
    },
    open() { return true; }
  };
  const script = o.script.slice();
  const io = {
    stage: (t, d) => said.push('[' + t + (d ? ' · ' + d : '') + ']'),
    speaker() {}, note() {}, feed: k => said.push('<feed ' + k + '>'), roster: list => said.push('<roster ' + list.map(x => x.name).join(',') + '>'),
    async say(segs, op) { for (const s of (typeof segs === 'string' ? [{ text: segs }] : segs)) said.push(((op && op.who) || 'AGENT') + ': ' + s.text); },
    async ask(spec) {
      const pick = script.shift();
      if (!pick) throw new Error('the script ran out at: ' + said[said.length - 1]);
      if (pick.type) return { value: pick.type, custom: true };
      const opt = (spec.options || []).find(x => pick.re.test(x.label) || pick.re.test(String(x.value)));
      if (!opt) throw new Error('no option ' + pick.re + ' among ' + (spec.options || []).map(x => x.label).join(' | '));
      return Object.assign({}, opt);
    }
  };
  const aw = require('../bin/lib/awaken.js').makeAwakening({ st, io, mods: M, now: () => (clock += 300), sleep: () => new Promise(r => setImmediate(r)) });
  const res = await aw.run({ save: o.save || null, resume: !!o.resume, privateStation: true });
  return { res, calls, said, save: () => save };
}

// ---- THE MOUSE (Andrew 10-22: "the crew agents can be clickable to open chats, we can also add actual different menus") ----
{
  const mouse = require('../bin/lib/mouse.js');
  // Node's keypress reader splits an SGR report into '\x1b[<' and one key per character: the reader puts it back together
  const evs = [];
  const feed = mouse.makeReader(e => evs.push(e));
  const keys = s => { const out = [feed('', { sequence: '\x1b[<' })]; for (const ch of s) out.push(feed(ch, { sequence: ch })); return out; };
  A.ok(keys('0;12;7M').every(Boolean) && keys('0;12;7m').every(Boolean), 'every key of a mouse report is the mouse\'s: none reaches the prompt');
  A.eq(evs.map(e => [e.kind, e.button, e.x, e.y]), [['down', 'left', 11, 6], ['up', 'left', 11, 6]], 'a press and its release, at the cell (counted from 0)');
  keys('64;30;9M'); keys('65;30;9M'); keys('2;5;5M'); keys('16;5;5M');
  A.eq(evs.slice(2).map(e => e.kind === 'wheel' ? 'wheel ' + e.dir : e.button + (e.ctrl ? '+ctrl' : '')), ['wheel up', 'wheel down', 'right', 'left+ctrl'], 'the wheel, the right button and ctrl+click');
  A.ok(!feed('a', { sequence: 'a', name: 'a' }) && feed('', { sequence: '\x1b[<' }) && !feed('x', { sequence: 'x', name: 'x' }), 'an ordinary key is the person\'s, even one after a broken report');
  A.ok(feed('', { sequence: '\x1b[<3;4;5M' }) && evs[evs.length - 1].x === 3, 'a report that arrives whole is read the same');
  // an Esc pressed just before a click: Node holds a lone Esc for its next bytes and hands over '\x1b\x1b[<' (seen live 10-22:
  // the click after closing /skills was typed into its filter as "0;39;36M")
  let escs = 0;
  const feed2 = mouse.makeReader(e => evs.push(e), () => escs++);
  const glued = [feed2('', { sequence: '\x1b\x1b[<' })].concat([...'0;39;36M'].map(ch => feed2(ch, { sequence: ch })));
  A.ok(glued.every(Boolean) && escs === 1 && evs[evs.length - 1].x === 38 && evs[evs.length - 1].y === 35, 'an Esc glued to a click is still the Esc, and the click is still a click — nothing reaches the prompt');
  A.eq(mouse.parse('35;10;10', true), null, 'motion is never acted on (never asked for)');

  // the screen says what a click lands on
  const m = crew();
  m.apply('agent.run.start', { runId: 'r1', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'fix it' }, T0);
  m.apply('permission.prompt', { runId: 'r1', agentId: 'astra', promptId: 'p1', tool: 'fs.write', argsSummary: 'auth.js (+2 −1)' }, T0 + 2);
  const s = screen(m, { stats: { level: 3, inLevel: 12, span: 40, frac: 0.3 } }, 110, 34, T0 + 3000);
  const text = s.map(tui.toPlain);
  const at = (re, y) => { const x = text[y].search(re); return x < 0 ? null : mouse.hitAt(s.hits, x + 1, y); };
  const novaY = text.findIndex(l => /○ NOVA/.test(l));
  A.eq((mouse.hitAt(s.hits, 8, novaY) || {}).act, { t: 'agent', id: 'agent' }, 'a click on a crew row is that agent');
  for (const [name, page] of [['STAT', 'stat'], ['CREW 3', 'crew'], ['WORK', 'work'], ['SKILLS', 'skills']]) A.eq((at(new RegExp(' ' + name + ' '), 3) || {}).act, { t: 'tab', page, here: false }, 'the tab rule\'s ' + name + ' opens its page');
  A.eq((at(/COMMS ▸ ASTRA/, 3) || {}).act, { t: 'tab', page: 'comms', here: true }, 'the tab you are in is a click too (its agent\'s menu)');
  const cardY = text.findIndex(l => /\[Y\] ALLOW ONCE/.test(l));
  A.ok(['Y] ALLOW', 'A] ALWAYS', 'N] DENY', 'V] VIEW'].every(k => { const h = at(new RegExp(k.replace(/[\]]/g, '\\$&')), cardY); return h && h.act.t === 'key' && h.act.key === k[0].toLowerCase(); }), 'each key on the ask card is a button for that key');
  A.eq([(at(/LV 3/, 33) || {}).act, (at(/CREW 3 /, 33) || {}).act, (at(/NEEDS YOU/, 33) || {}).act], [{ t: 'page', page: 'stat' }, { t: 'page', page: 'crew' }, { t: 'needs' }], 'the stat bar: the level opens STAT, the crew CREW, NEEDS YOU the agent asking');
  A.eq((at(/m\/a/, 4) || {}).act, { t: 'model' }, 'the model\'s name on the COMMS frame opens /model');
  A.ok(s.areas.comms && s.areas.comms.x0 === 30 && s.areas.crew && s.areas.crew.x1 === 30, 'the panes the wheel scrolls are known');
  A.ok(!mouse.hitAt(s.hits, 60, 15), 'empty space is no click');

  // links and files
  A.eq(mouse.urlAt([['⠋ see (https://example.com/a?b=1).', 'fg']], 12, ch => tui.width(ch)), 'https://example.com/a?b=1', 'a link said in parentheses is read off the row as drawn, its own characters only');
  A.eq(mouse.urlAt([['javascript:alert(1) ftp://x', 'fg']], 3, ch => tui.width(ch)), '', 'only http and https open');
  A.eq(mouse.fileArg('fs.write', '{"path":"notes\\\\plan.md","content":"# a very long fi'), 'notes\\plan.md', 'a file tool\'s path, read even from arguments cut short');
  A.eq(mouse.fileArg('shell.exec', '{"path":"x"}'), '', 'only a file tool names a file');
  const tickets = require('../sidecar/apitickets.js');
  const u = new URL(mouse.fileUrl('http://127.0.0.1:9', tickets, 'k3y', { agent: 'astra', path: 'notes/plan.md', project: 'C:\\Code\\App', now: T0 }));
  A.ok(u.pathname === '/api/file' && u.searchParams.get('agent') === 'astra' && u.searchParams.get('path') === 'notes/plan.md' && u.searchParams.get('project') === 'C:\\Code\\App' && u.searchParams.get('view') === 'doc'
    && tickets.verify('k3y', u.searchParams.get('ticket'), 'file', tickets.scopeFile('astra', 'notes/plan.md'), { now: T0 + 1000 }).ok, 'a file link carries the station\'s own signed ticket for exactly that file (a text file opens as its reading page)');
  m.apply('agent.tool_call', { runId: 'r1', agentId: 'astra', callId: 'c9', name: 'fs_write', argsSummary: '{"path":"auth.js","content":"x"}' }, T0 + 50);
  const s2 = screen(m, { focus: 'astra' }, 110, 34, T0 + 3000);
  const fy = s2.map(tui.toPlain).findIndex(l => /↳ fs\.write/.test(l));
  A.eq(((mouse.hitAt(s2.hits, 45, fy) || {}).act || {}).t === 'file' && mouse.hitAt(s2.hits, 45, fy).act, { t: 'file', path: 'auth.js', runId: 'r1', agentId: 'astra' }, 'a file tool\'s line in COMMS is the file (ctrl+click opens it); from a station that did not say where the run works, no folder is assumed');
  const m3 = crew();
  m3.apply('agent.run.start', { runId: 'r3', agentId: 'astra', trigger: 'directive', surface: 'interactive', prompt: 'notes', projectRoot: 'C:\\Code\\App' }, T0);
  m3.apply('agent.tool_call', { runId: 'r3', agentId: 'astra', callId: 'c1', name: 'fs_write', argsSummary: '{"path":"docs/notes.md","content":"x"}' }, T0 + 5);
  const s3 = screen(m3, { focus: 'astra' }, 110, 34, T0 + 3000);
  const f3 = s3.map(tui.toPlain).findIndex(l => /↳ fs\.write/.test(l));
  A.eq((mouse.hitAt(s3.hits, 45, f3) || {}).act, { t: 'file', path: 'docs/notes.md', runId: 'r3', agentId: 'astra', root: 'C:\\Code\\App' }, 'a run the feed says works in a project: its file is that project\'s, known while it still runs');
}

// ---- THE PAGES: STAT · CREW · WORK in the COMMS frame, and the agent menu -----------------------------------------------------
{
  const mouse = require('../bin/lib/mouse.js');
  const m = crew();
  m.apply('agent.run.start', { runId: 'r2', agentId: 'cypher', trigger: 'schedule', surface: 'autonomous', prompt: 'nightly tests' }, T0);
  m.apply('agent.tool_call', { runId: 'r2', agentId: 'cypher', callId: 'c1', name: 'shell_exec', argsSummary: '{"command":"npm test"}' }, T0 + 5);
  m.applyBudget({ spentToday: 0.42 });
  m.applyLines({ lines: [{ lineId: 'L1', shipped: 2 }] }, [{ id: 'j1', line: 'L1', name: 'RELEASE', status: 'done', startedAt: T0 - 60000, endedAt: T0 - 30000, steps: 3 }]);
  const stats = { level: 3, inLevel: 12, span: 40, frac: 0.3, toNext: 28, lifetimeXp: 132, tasksDone: 5, known: false, confLabel: '—', band: 'calibrating', positiveFeedback: 2, negativeFeedback: 0 };
  const stat = screen(m, { page: 'stat', stats, pageData: { usage: { title: 'Spend', lines: ['Today: $0.42 across 3 runs'] } } }, 110, 34, T0 + 3000);
  const st = stat.map(tui.toPlain);
  A.ok(/┘ STAT └/.test(st[3]) && / CREW 3 .* COMMS .* WORK 1 .* SKILLS /.test(st[3]), 'STAT is the tab you are in, the others beside it: ' + st[3]);
  A.ok(st.some(l => /│ LEVEL +LV 3 +▌{10} +XP 12\/40 +· 28 XP to level 4/.test(l)) && st.some(l => /132 XP in all · 5 tasks shipped/.test(l)) && st.some(l => /CONFIDENCE +calibrating/.test(l)), 'STAT: the level as the station records it, all of it');
  A.ok(st.some(l => /SPEND +\$0\.42 today/.test(l)) && st.some(l => /CREW +3 agents +· 1 working · 0 need you/.test(l)) && st.some(l => /WORK +1 workflow +· 0 running · 2 shipped/.test(l)) && st.some(l => /USAGE +Spend/.test(l)) && st.some(l => /Today: \$0\.42 across 3 runs/.test(l)), 'STAT: spend, crew, work, and the ledger in its own words');
  const crewY = st.findIndex(l => /│ CREW +3 agents/.test(l));
  A.eq((mouse.hitAt(stat.hits, 50, crewY) || {}).act, { t: 'page', page: 'crew' }, 'its CREW line opens CREW');
  A.ok(!st.some(l => /YOU +fix it/.test(l)) && /esc back to COMMS/.test(st[32]), 'a page takes the whole frame, and the key line says how back');
  A.ok(screen(m, { page: 'stat', pageData: {} }, 110, 34, T0).map(tui.toPlain).some(l => /LEVEL +not recorded on this station yet/.test(l)), 'a station that records no level says so — never a made-up LV 1');

  const cp = screen(m, { page: 'crew', focus: 'astra' }, 110, 34, T0 + 3000);
  const ct = cp.map(tui.toPlain);
  const hy = ct.findIndex(l => /NAME +STATE +MODEL +NOW/.test(l));
  A.ok(hy > 3 && /⠋ CYPHER +working 3s +m\/c +shell\.exec npm test/.test(ct[hy + 1]) && /○ ASTRA +idle +openrouter · m\/a/.test(ct.find((l, i) => i > hy && /ASTRA/.test(l)) || ''), 'CREW: every agent on one line — state, model, what it does — the working first: ' + ct[hy + 1]);
  const ay = ct.findIndex((l, i) => i > hy && /ASTRA/.test(l));
  A.eq((mouse.hitAt(cp.hits, 60, ay) || {}).act, { t: 'agent', id: 'astra' }, 'a click on a CREW line is its agent (its chat)');

  const wp = screen(m, { page: 'work', focus: 'astra', pageData: { cron: { enabled: true, halted: false, jobs: [{ name: 'nightly digest', when: 'every day at 7:00 AM', agent: 'Cypher', enabled: true, next: 'in 3h' }, { name: 'weekly report', when: 'every Monday', agent: '', enabled: false }] }, away: { agent: 'Astra', title: 'Away workshop — 1 queued', lines: ['1. the pricing page', 'Build while away: OFF.'] } } }, 110, 34, T0 + 3000);
  const wt = wp.map(tui.toPlain);
  A.ok(wt.some(l => /^│ WORKFLOWS 1 +│/.test(l.slice(29))) || wt.some(l => / WORKFLOWS 1 /.test(l)), 'WORK: the workflows under their strip');
  const fy = wt.findIndex((l, i) => i > 3 && /✓ RELEASE/.test(l));
  A.eq((mouse.hitAt(wp.hits, 60, fy) || {}).act, { t: 'flow', name: 'RELEASE' }, 'a click on a workflow readies a job for it');
  A.ok(wt.some(l => / ROUTINES 2 · scheduler on /.test(l)) && wt.some(l => /● nightly digest +every day at 7:00 AM · Cypher · next in 3h/.test(l)) && wt.some(l => /○ weekly report +every Monday · paused/.test(l)), 'WORK: the routines as the scheduler lists them, paused ones said so');
  A.ok(wt.some(l => / AWAY SHIFT · Astra /.test(l)) && wt.some(l => /Away workshop — 1 queued/.test(l)) && wt.some(l => /Build while away: OFF\./.test(l)), 'WORK: the away shift of the agent shown, in the station\'s words');
  A.ok(screen(m, { page: 'work', pageData: { cron: { error: 'the routines could not be read (HTTP 500) — their state is unknown' } } }, 110, 34, T0).map(tui.toPlain).some(l => /their state is unknown/.test(l)), 'a routines read that failed says their state is unknown, never "none"');

  const sk = screen(m, { picker: { kind: 'skills', title: 'SKILLS · Astra', filter: '', sel: 0, items: [{ name: 'plan', search: 'plan', cols: [['/plan', 'ph']] }] } }, 110, 34, T0).map(tui.toPlain);
  A.ok(/┘ SKILLS └/.test(sk[3]), 'the skills list is the SKILLS tab');
  const narrow = screen(m, { page: 'crew' }, 84, 30, T0).map(tui.toPlain);
  A.ok(narrow.some(l => /╭─ CREW ─/.test(l)), 'a terminal too short for the tab rule names the page on its frame');

  // THE AGENT MENU
  const mm = screen(m, { agentMenu: 'cypher', focus: 'astra' }, 110, 34, T0 + 3000);
  const mt = mm.map(tui.toPlain);
  const top = mt.findIndex(l => /┌─ ▸ CYPHER ─/.test(l));
  A.ok(top > 0 && /m\/c +⠋ working 3s/.test(mt[top + 1]) && /\[O\] OPEN CHAT +talk to CYPHER in COMMS/.test(mt[top + 2]) && /\[M\] MODEL/.test(mt[top + 3]) && /\[N\] NEW CHAT/.test(mt[top + 4]) && /\[H\] HISTORY/.test(mt[top + 5]) && /\[S\] STOP +stop its 1 run/.test(mt[top + 6]) && /CLICK ONE OR PRESS ITS KEY +\[ESC\] CLOSE/.test(mt[top + 7]), 'the agent menu is a card at the foot of COMMS: its model and state, then what you can do with it');
  A.eq([2, 3, 4, 5, 6].map(i => (mouse.hitAt(mm.hits, 50, top + i) || {}).act.key), ['o', 'm', 'n', 'h', 's'], 'each line of the menu is a click');
  A.ok(/^o open chat · m model · n new chat · h history · s stop · esc close/.test(mt[32]), 'the key line says its letters');
  const idle = screen(m, { agentMenu: 'astra' }, 110, 34, T0).map(tui.toPlain);
  A.ok(!idle.some(l => /\[S\] STOP/.test(l)), 'an agent with nothing running is offered no STOP');
  A.ok(tui.HELP.some(([k]) => k === 'right-click') && tui.HELP.some(([k]) => k === 'f1 – f6') && tui.HELP.some(([k, d]) => k === '/' && /\/goal/.test(d)), '/help says the mouse, the pages and the "/" menu (the list scrolls, so it can say all of it)');
}
// ---- THE "/" MENU (Andrew 10-24: "when users type / it should pop up with the suggestion menu") ------------------------------
{
  const mouse = require('../bin/lib/mouse.js');
  const cat = require('../sidecar/slash.js').catalog({}).commands.map(c => ({ name: c.name, aliases: c.aliases, desc: c.desc, argsHint: c.argsHint, source: c.source, here: c.dispatch === 'server' || c.name === 'model' }))
    .concat([{ name: 'plan', aliases: [], desc: 'Think through the approach and write a short plan', argsHint: '', source: 'skill', here: true }]);
  A.eq(tui.slashMatches(cat, 'go').map(c => c.name), ['goal', 'subgoal'], 'a typed word: the commands it starts first, then the ones it is in');
  A.eq(tui.slashMatches(cat, 'q')[0].name, 'queue', 'an alias counts (/q is /queue)');
  A.ok(tui.slashMatches(cat, '').length === cat.length, 'a lone / lists everything');
  // the word typed whole is first, so enter runs what was typed (review 10-24: /stat ran /status, /v completed /voice)
  const withTerm = cat.concat([{ name: 'stat', aliases: [], desc: 'the STAT page', argsHint: '', source: 'terminal', here: true }]);
  A.eq(tui.slashMatches(withTerm, 'stat')[0].name, 'stat', 'an exact name beats a longer one it starts (/stat, not /status)');
  A.eq(tui.slashMatches(withTerm, 'v')[0].name, 'version', 'an exact alias beats a name it starts (/v is /version, not /voice)');
  const m = crew();
  const base = { focus: 'agent', slashCatalog: cat };
  const open = screen(m, Object.assign({ input: '/' }, base), 110, 34, T0);
  const ot = open.map(tui.toPlain);
  const top = ot.findIndex(l => /┌─ \/ \d+ COMMANDS ─/.test(l));
  A.ok(top > 0 && /│▌\/retry +re-run the last turn/.test(ot[top + 1]) && /└─ \[TAB\] COMPLETE {3}\[ENTER\] RUN {3}\[↑↓\] PICK {3}\[ESC\] HIDE ─+ \+\d+ more ┘/.test(ot[top + 9]), 'typing / pops the menu above the prompt: the commands, the picked one on the bar, its keys');
  A.ok(/^tab completes \/retry · enter runs it/.test(ot[32]), 'the key line says what tab and enter do with the one picked');
  A.eq((mouse.hitAt(open.hits, 50, top + 3) || {}).act, { t: 'slash', name: 'copy' }, 'a click on a command is that command');
  const go = screen(m, Object.assign({ input: '/go', slashSel: 1 }, base), 110, 34, T0).map(tui.toPlain);
  A.ok(go.some(l => /│▌\/subgoal/.test(l)) && go.some(l => /│ \/goal +set a goal/.test(l)), 'it narrows as you type, and ↑ ↓ move the bar');
  A.ok(go.some(l => /· in the app/.test(l)), 'a command only the app runs yet is marked so (never offered as if it worked here)');
  A.ok(!screen(m, Object.assign({ input: '/goal ' }, base), 110, 34, T0).map(tui.toPlain).some(l => /COMMANDS ─/.test(l)), 'a space ends the menu (the command is chosen)');
  A.ok(/^\/goal \[text\|status\|pause\|resume\|clear\] — set a goal/.test(screen(m, Object.assign({ input: '/goal ship it' }, base), 110, 34, T0).map(tui.toPlain)[32]), 'then the key line says what it takes');
  A.ok(!screen(m, Object.assign({ input: '/go', slashHidden: '/go' }, base), 110, 34, T0).map(tui.toPlain).some(l => /COMMANDS ─/.test(l)), 'esc hides it for what is typed (typing on brings it back)');
  A.ok(!screen(m, Object.assign({ input: '/zzz' }, base), 110, 34, T0).map(tui.toPlain).some(l => /COMMANDS ─/.test(l)), 'nothing matches: no empty menu');
}
const awakenTests = (async () => {
  const opt = re => ({ re }), typed = t => ({ type: t });
  // the deep path, full power, a research station
  const rosters = [];
  const r = await awakenRun({ rosters, script: [
    typed('Vega'), opt(/^Blunt/), opt(/^Full power/), opt(/^An API key/), opt(/OpenRouter — already connected/), opt(/^m\/one/),
    opt(/^Let’s talk it through/), typed('I write a newsletter.'), typed('About AI tools.'), opt(/^Draft the weekly issue/), opt(/^that’s me/), opt(/^build$/), opt(/^research$/)
  ] });
  const s = r.save(), ag = s.agent;
  A.ok(r.res.ok && ag.onboarded === true && ag.name === 'VEGA' && ag.personaId === 'blunt' && ag.approvalMode === 'full' && ag.executionProfile === 'this-computer' && ag.provider === 'openrouter' && ag.model === 'm/one', 'the awakening ends onboarded: VEGA, blunt, full power on this computer, openrouter · m/one');
  A.ok(r.said.some(l => /API keys are added in the StarNet desktop app — SETTINGS › AI & MODELS/.test(l)) && r.said.some(l => /set it \(for example OPENROUTER_API_KEY/.test(l)), 'an API key is answered honestly (the desktop app, or this private station\'s environment)');
  A.ok(r.calls.indexOf('CHAT Reply with exactly: OK') >= 0 && r.calls.indexOf('CHAT Reply with exactly: OK') < r.calls.findIndex(c => /^POST \/api\/save/.test(c)), 'the wire is tested before anything is written');
  const firstSave = r.calls.findIndex(c => /^POST \/api\/save onboarded=false/.test(c)), journey = r.calls.indexOf('POST /api/journey'), revoke = r.calls.indexOf('POST /api/permissions/revoke cabinet:write');
  A.ok(firstSave >= 0 && journey > firstSave && revoke > firstSave && r.calls.indexOf('POST /api/memory/reset') > firstSave, 'the agent is saved (not onboarded) BEFORE the resets, which then run: grants revoked, journey and memory reset');
  A.ok(r.calls.some(c => /^POST \/api\/autonomy\/posture preset=suggest|^POST \/api\/autonomy\/posture preset=/.test(c)) && r.calls.some(c => c === 'POST /api/autonomy/posture preset=build'), 'the opening posture, then the cadence preset picked (build)');
  A.ok(r.said.some(l => /^AGENT: all at once$/.test(l)) && r.said.some(l => /^AGENT: +you lit me\. aim me\.$/.test(l)) && r.said.some(l => /already got a way of talking — blunt\./.test(l)), 'the awakening speaks the birth script\'s own lines, and owns the voice that was picked');
  A.ok(ag.docs.purpose === 'Help me write and grow my AI tools newsletter.' && /Question: what is it about\?\nAnswer: About AI tools\./.test(ag.docs.context) && ag.docs.manual === '', 'purpose.md from THE READ, context.md the conversation, the manual empty');
  const goals = D_beliefs(s.dossier, 'goals');
  A.ok(goals.some(t => /Draft the weekly issue/.test(t)) && goals.some(t => /AI tools newsletter/.test(t)) && goals.some(t => /Grows a newsletter/.test(t)), 'the dossier: the dig\'s belief, the grabbed offer, the mission');
  A.eq(s.station && s.station.meta && s.station.meta.templateId, 'research', 'the station picked is built (YOUR STATION)');
  const lastRoster = rosters[rosters.length - 1].agents[0];
  A.ok(/YOUR PURPOSE \(purpose\.md\):\nHelp me write and grow my AI tools newsletter\./.test(lastRoster.system) && /AUTHORITY — FULL POWER/.test(lastRoster.system) && /Draft the weekly issue/.test(lastRoster.system) && lastRoster.approvalMode === 'full', 'the roster carries the composed prompt: purpose, authority, the dossier');
  A.eq(r.res.firstMove, 'Draft the weekly issue', 'the grabbed offer comes back as the first task');
  A.ok(r.said.some(l => /^\[YOUR FIRST TASK/.test(l)) && r.said.some(l => /i’m VEGA\. the station is yours/.test(l)), 'it closes on YOUR FIRST TASK, in its own words');
  // the dark mind: the wire passed, then the mind went quiet — the honest holding path, purpose and cadence still asked
  const r2 = await awakenRun({ rosters: [], darkMind: true, script: [opt(/^Give it a station codename/), opt(/^Composed/), opt(/^Ask for approval/), opt(/OpenRouter — already connected/), opt(/^m\/one/), opt(/^Let’s talk it through/), opt(/^Code & build/), opt(/^Wait for me/), opt(/^Start with one room/)] });
  const s2 = r2.save();
  A.ok(r2.said.some(l => /my wire is dark/.test(l)) && s2.agent.docs.purpose === 'Help me write, debug, and ship software.' && s2.agent.onboarded === true, 'a mind gone quiet gets the honest holding line, and purpose.md still lands');
  A.ok(/^[A-Z]{2,18}$/.test(s2.agent.name) && s2.agent.name !== 'AGENT', 'no name given: a station codename (' + s2.agent.name + ')');
  A.ok(r2.said.some(l => /something just opened\./.test(l)), 'the scripted spine speaks where the mind is quiet');
  A.ok(!(s2.station.meta && s2.station.meta.templateId), 'one room kept');
  // started again mid-awakening: no second birth
  const mid = JSON.parse(JSON.stringify(s2)); mid.agent.onboarded = false;
  const r3 = await awakenRun({ rosters: [], save: mid, resume: true, script: [opt(/^Quick setup/), opt(/^Run tasks & ops/), opt(/^Line up suggestions/), opt(/^Start with one room/)] });
  A.ok(r3.said.some(l => /…and we’re back\./.test(l)) && !r3.calls.some(c => /YOU ARE BEING SWITCHED ON|Reply with exactly/.test(c)), 'resumed: "…and we’re back", no second birth and no second wire test');
  A.ok(r3.said.some(l => /^\[GET ACQUAINTED · 1 of 3 · Your direction\]$/.test(l)) && r3.save().agent.onboarded === true && r3.save().agent.docs.purpose === 'Run tasks, ops, and the day-to-day work.', 'quick setup counts what it asks, and the resumed agent ends onboarded');
  // the bootstrap a headless run writes is marked, so the dashboard gives it the awakening
  A.eq(core.bootstrapDocs({ name: 'ATLAS', model: 'm', provider: 'openrouter', now: 1 }).save.doc.agent.bootstrappedBy, 'starnet-cli', 'a headless bootstrap marks its agent as never met by a person');
  // the screen
  const tm = crew();
  const wakeUi = { focus: 'agent', input: '', scroll: 0, still: true, stationLabel: 'private station · port 1', wake: { log: [{ who: 'STARNET', text: 'what should it be called?', first: true, full: true }, { who: 'YOU', text: 'Vega', full: true, you: true }], ask: { options: [{ label: 'Give it a station codename', value: '', skip: true }], custom: true, customLabel: 'its name', optional: true }, stage: { title: 'CREATE YOUR OVERSEER', detail: 'Who it is' }, speaker: 'STARNET' } };
  const ws = tui.render(tm, wakeUi, { cols: 120, rows: 34 }, T0).map(tui.toPlain);
  A.ok(/^──┘ CREATE YOUR OVERSEER └ Who it is ─/.test(ws[3]) && ws.some(l => /│ STARNET +what should it be called\?/.test(l)) && ws.some(l => /│ YOU +Vega/.test(l)), 'the awakening owns COMMS: its stage on the frame, who said each line');
  A.ok(ws.some(l => /┌─ ▲ YOUR CHOICE ─/.test(l)) && ws.some(l => /│ 1  Give it a station codename/.test(l)) && ws.some(l => /› +or type its name and press enter/.test(l)) && ws.some(l => /└─ \[1-1\] PICK {3}\[ENTER\] SEND WHAT YOU TYPED ─/.test(l)), 'its choice is a card: numbered options and the typed answer');
  A.ok(/^you ▸/.test(ws[31]) && /^1-1 pick · or type your own \+ enter · ctrl\+c pauses setup/.test(ws[32]) && !ws.some(l => /CREW/.test(l)) && /^ {2}SPEND UNKNOWN +\d\d:\d\d $/.test(ws[33]), 'the prompt is yours, the key line says how to answer, and there is no crew before the agent exists');
  wakeUi.wake.crew = true; wakeUi.wake.feedKey = 'stopped'; wakeUi.images = true; wakeUi.wake.ask = null;
  const wv = tui.render(tm, wakeUi, { cols: 120, rows: 34 }, T0);
  A.ok(wv.avatar && wv.avatar.key === 'stopped' && wv.map(tui.toPlain).some(l => /├─ \S+ waking ─/.test(l)), 'once it exists, the camera finds it at its desk in the dark: "waking"');
})();
function D_beliefs(dossier, dim) { const Dz = require('../frontend/app/dossier.js'); return Dz.beliefs(Dz.hydrate(dossier), dim).map(b => b.text); }

awakenTests.then(() => A.report('cli-dashboard.test'), e => { A.ok(false, 'the awakening tests threw: ' + ((e && e.stack) || e)); A.report('cli-dashboard.test'); });
