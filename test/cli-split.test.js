'use strict';
/* node test/cli-split.test.js — THE SPLIT (tui.js drawSplit, /split): talking to more agents at once. Locks:
     1. the panes sit side by side while each keeps SPLIT_MIN_W cells, then in more rows; together they fill the frame
        and never overlap
     2. each pane is its own agent's conversation, under a head naming it and what it is doing; the one you type to is
        marked; COMMS's tab names them all
     3. each pane scrolls on its own: the one you type to by ui.scroll, the rest by ui.scrolls[id] (each clamped to what
        it holds); the panes come back for the wheel (out.areas.panes), and a head is a click that picks the pane
     4. one agent (or none) in ui.panes: COMMS as it was */
const A = require('./_assert.js');
const tui = require('../bin/lib/tui.js');
const { makeStation } = require('../bin/lib/station-model.js');

/* 1 */
{
  const two = tui.splitLayout(2, 0, 99, 0, 30);
  A.eq([two.cols, two.rows], [2, 1], 'two panes in 100 cells: side by side');
  const five = tui.splitLayout(5, 0, 99, 0, 30);
  A.eq([five.cols, five.rows], [2, 3], 'five panes in 100 cells: two a row (each keeps ' + tui.SPLIT_MIN_W + ' cells), three rows');
  const wide = tui.splitLayout(4, 0, 199, 0, 30);
  A.eq([wide.cols, wide.rows], [4, 1], 'four panes in 200 cells: all side by side');
  for (const L of [two, five, wide, tui.splitLayout(3, 0, 99, 0, 30)]) {
    const cells = L.cells;
    const overlap = cells.some((a, i) => cells.some((b, j) => j !== i && a.x0 <= b.x1 && b.x0 <= a.x1 && a.top < b.bot && b.top < a.bot));
    A.ok(!overlap && cells.every(c => c.x1 - c.x0 + 1 >= Math.min(tui.SPLIT_MIN_W, 100) - 1), 'no two panes overlap, each wide enough: ' + JSON.stringify(cells));
  }
  const three = tui.splitLayout(3, 0, 99, 0, 30);
  A.eq([three.cells[2].x0, three.cells[2].x1], [0, 99], 'a row with fewer panes: they take its whole width');
}

/* 2 – 4 */
const m = makeStation();
m.setRoster({ agents: [{ agentId: 'agent', name: 'ULTRON' }, { agentId: 'scout', name: 'SCOUT' }, { agentId: 'forge', name: 'FORGE' }] });
const lines = (id, who, n) => { for (let i = 1; i <= n; i++) m.noteSaid(id, '/note', '', [who + ' line ' + i], true, 1000 + i); };
lines('agent', 'ultron', 40); lines('scout', 'scout', 40); lines('forge', 'forge', 3);
const base = { focus: 'scout', page: '', input: '', scroll: 0, still: true, logo: 'plain', streams: {}, pageData: {} };
const ui = Object.assign({}, base, { panes: ['agent', 'scout', 'forge'], scrolls: { agent: 10, forge: 99 } });
const out = tui.render(m, ui, { cols: 160, rows: 40 }, 2000);
const plain = out.map(tui.toPlain);
const all = plain.join('\n');
A.ok(/COMMS ▸ ULTRON · SCOUT · FORGE/.test(all), 'COMMS\'s tab names every pane');
A.ok(['ULTRON', 'SCOUT', 'FORGE'].every(n => plain.some(l => l.indexOf(n + ' ') >= 0)), 'each pane has its head');
A.ok(/scout line 40/.test(all) && !/scout line 1\b/.test(all.replace(/scout line 1\d/g, '')), 'the pane you type to (SCOUT) shows its latest: scroll 0');
A.ok(/ultron line 30\b/.test(all) && !/ultron line 40/.test(all), 'ULTRON\'s pane is scrolled up by its own 10, the others are not');
A.ok(/forge line 3/.test(all) && ui.scrolls.forge === 0, 'FORGE\'s scroll past what it holds is clamped to it');
A.eq(ui.scrolls.agent, 10, '...ULTRON keeps its own');
const panes = out.areas.panes || [];
A.eq(panes.map(p => p.id), ['agent', 'scout', 'forge'], 'the panes come back for the wheel, in order');
A.ok(out.hits.some(h => h.act && h.act.t === 'pane' && h.act.id === 'forge'), 'a pane\'s head is a click that picks it');
const headRow = plain.findIndex(l => /▌SCOUT/.test(l));
A.ok(headRow >= 0, 'the pane you type to is marked ▌');

const one = tui.render(m, Object.assign({}, base, { panes: ['scout'], scrolls: {} }), { cols: 160, rows: 40 }, 2000);
A.ok(!one.areas.panes && one.map(tui.toPlain).some(l => /COMMS ▸ SCOUT/.test(l)), 'one agent: COMMS as it was');

A.report('cli-split.test');
