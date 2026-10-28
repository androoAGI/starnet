/* bin/lib/tui.js — the PURE screen of the `starnet` dashboard: model + ui state + terminal size → rows of styled
   segments, and those rows → ANSI strings. No I/O and no clock (`now` is passed in), so test/cli-dashboard.test.js
   renders it to plain text and checks the layout.

   Layout: the header (the StarNet wordmark; beside it the station, the counts, NOW — what the busy agents are doing —
   and FLOWS), then two framed panels: CREW down the left (lamp, name, a word for what it is doing; the agent in COMMS
   marked; ≥ 90 columns) and COMMS (the focused agent's conversation, the open ask's card at its foot), then the prompt
   and the keys. One palette: names in white, neon red the only accent, color only where it carries status.

   Every glyph sits in one cell (wide characters take two), and anything an agent or a tool wrote is stripped of
   control characters and escape sequences before it reaches a cell: model output can never drive the terminal. */
'use strict';

const { fmtDur, fmtShort, costText, askInspect, ONCE_ONLY_TOOLS, RUN_FLOOR } = require('./station-model.js');
// the StarNet mark, cut from the real brand art by dev/cli-logo.cjs (never redrawn)
const logo = require('./logo.js');
const sixelLib = require('./sixel.js');   // the real logo: an image where the terminal draws Sixel, braille dots elsewhere

const BARS = '▁▂▃▄▅▆▇█';

// ---- text hygiene + cell widths ----------------------------------------------------------------------
// strip ANSI/OSC escapes and every C0/C1 control except newline; tabs become spaces
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
}
function cpWidth(cp) {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) return 0;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
function width(s) { let w = 0; for (const ch of String(s)) w += cpWidth(ch.codePointAt(0)); return w; }
function trunc(s, n) {
  const t = String(s);
  if (n <= 0) return '';
  if (width(t) <= n) return t;
  let out = '', w = 0;
  for (const ch of t) { const cw = cpWidth(ch.codePointAt(0)); if (w + cw > n - 1) break; out += ch; w += cw; }
  return out.trimEnd() + '…';
}
function wrap(text, w) {
  w = Math.max(4, w);
  const out = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
      while (width(word) > w) {
        if (line) { out.push(line); line = ''; }
        let head = '', hw = 0, rest = '';
        for (const ch of word) { const cw = cpWidth(ch.codePointAt(0)); if (!rest && hw + cw <= w) { head += ch; hw += cw; } else rest += ch; }
        out.push(head); word = rest;
      }
      if (!line) line = word;
      else if (width(line) + 1 + width(word) <= w) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

// ---- the cell grid -------------------------------------------------------------------------------------
function makeGrid(cols, rows) {
  const ch = [], st = [];
  for (let y = 0; y < rows; y++) { ch.push(new Array(cols).fill(' ')); st.push(new Array(cols).fill('')); }
  function put(x, y, s, style) {
    if (y < 0 || y >= rows) return x;
    for (const c of clean(s).replace(/\n/g, ' ')) {
      const cw = cpWidth(c.codePointAt(0));
      if (cw === 0) continue;
      if (x + cw > cols) break;
      if (x >= 0) { ch[y][x] = c; st[y][x] = style || ''; if (cw === 2) { ch[y][x + 1] = ''; st[y][x + 1] = style || ''; } }
      x += cw;
    }
    return x;
  }
  function putR(xr, y, s, style) { return put(xr - width(clean(s)), y, s, style); }
  function hl(y, x0, x1, extra) { if (y < 0 || y >= rows) return; for (let x = Math.max(0, x0); x < Math.min(cols, x1); x++) st[y][x] = (st[y][x] + ' ' + extra).trim(); }
  function out() {
    return ch.map((row, y) => {
      const segs = [];
      for (let x = 0; x < cols; x++) {
        if (row[x] === '') continue;   // the second cell of a wide glyph
        const s = st[y][x];
        if (segs.length && segs[segs.length - 1][1] === s) segs[segs.length - 1][0] += row[x];
        else segs.push([row[x], s]);
      }
      return segs;
    });
  }
  return { put, putR, hl, out, cols, rows };
}

// ---- the screen ------------------------------------------------------------------------------------------
const HELP = [
  ['message', 'talk to the agent shown in COMMS'],
  ['/', 'every command as you type — the app\'s too: /goal /queue /loop …'],
  ['@name message', 'talk to another agent (it queues if busy)'],
  ['/model [name]', 'show or switch the shown agent\'s model'],
  ['/connect [provider]', 'add a provider: the app\'s AI & MODELS list (sign in, link, or a key)'],
  ['/split <agent> …', 'talk to more agents at once: a pane each, side by side (/split close · /split off)'],
  ['/new  /resume', 'a fresh conversation · back to an earlier one'],
  ['y  a  n  v', 'answer the open ask: once, always, no, view'],
  ['1-6 or text', 'answer an open question'],
  ['tab  shift+tab', 'switch the agent shown in COMMS'],
  ['↑ ↓  pgup pgdn', 'your earlier messages · scroll COMMS'],
  ['f1 – f6', 'the pages on the tab rule · /stat /crew /work /floor'],
  ['click', 'an agent opens its chat · a tab, its page'],
  ['right-click', 'an agent: its menu (model, new chat, stop…)'],
  ['ctrl+click', 'opens a link, or a file an agent wrote'],
  ['/stop', 'stop the shown agent\'s runs'],
  ['/retry', 'send your last message again'],
  ['/status', 'the agent, its model, its folder, the station'],
  ['/skills', 'its skills · run one: /<skill> <task>'],
  ['/usage  /tools', 'what is left on each provider · what it can call'],
  ['/routine', 'scheduled routines: list, create, pause'],
  ['/cron  on · off', 'the routines scheduler: its state, arm it'],
  ['/away', 'work it builds on its own away shift'],
  ['/flow [run name text]', 'list workflows · send one job down one'],
  ['/version', 'the CLI and the station'],
  ['/theme [name]', 'colors: red amber green blue purple white'],
  ['/help  ctrl+c', 'this list · quit']
];

// the wordmark in neon red; the star in its A gets a hotter glint
function putLogo(g, word) {
  word.forEach((l, r) => { let x = 0; for (const ch of l) { if (ch !== ' ') g.put(x, r, ch, ch === '✦' ? 'logohi b' : 'logo b'); x++; } });
}
// WORKING SPINS: an agent with a live run, the working count and a running flow turn this wheel (a still screen holds its
// first frame). Every other state keeps its lamp — ▲ asks, ✓ done, ■ stopped, ○ idle — so motion means one thing.
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
function spin(now, still) { return SPIN[still ? 0 : Math.floor(now / 100) % SPIN.length]; }
function lampOf(s, blink, now, still) {
  if (s.key === 'working') return [spin(now, still), 'ph b'];
  if (s.key === 'needs') return ['▲', blink ? 'am b' : 'am faint'];
  if (s.key === 'done') return ['✓', 'ok b'];
  if (s.key === 'stopped') return ['■', 'bad'];
  return ['○', 'dim'];
}

// a framed panel: rounded corners, thin rule lines (box-drawing glyphs, which terminals draw edge to edge)
function frame(g, x0, y0, x1, y1, style) {
  g.put(x0, y0, '╭', style); g.put(x1, y0, '╮', style); g.put(x0, y1, '╰', style); g.put(x1, y1, '╯', style);
  for (let x = x0 + 1; x < x1; x++) { g.put(x, y0, '─', style); g.put(x, y1, '─', style); }
  for (let y = y0 + 1; y < y1; y++) { g.put(x0, y, '│', style); g.put(x1, y, '│', style); }
}
// segments laid on a frame's edge: from the left (x) or ending at the right (xr)
function edgeL(g, x, y, segs) { x = g.put(x, y, ' ', ''); for (const [t, s] of segs) x = g.put(x, y, t, s); return g.put(x, y, ' ', ''); }
function edgeR(g, xr, y, segs) { const w = segs.reduce((n, s) => n + width(s[0]), 0) + 2; return edgeL(g, xr - w, y, segs); }

function render(model, ui, size, now) {
  const W = Math.max(20, size.cols | 0), H = Math.max(8, size.rows | 0);
  const g = makeGrid(W, H);
  // THE MOUSE (bin/lib/mouse.js): every span drawn that a click can act on, { x0, x1 (exclusive), y, act }, and the panes
  // the wheel scrolls. The dashboard reads them off the screen it last painted, so a click lands on what is drawn there.
  const hits = [], areas = {};
  const hit = (x0, x1, y, act) => { if (act && y >= 0 && x1 > x0) hits.push({ x0, x1, y, act }); };
  if (W < 46 || H < 16) {
    g.put(0, 0, trunc('starnet needs at least 46×16 — this terminal is ' + W + '×' + H, W), 'am');
    const small = g.out(); small.hits = hits; small.areas = areas;
    return small;
  }
  const blink = ui.still || Math.floor(now / 530) % 2 === 0;
  const head = model.header(now);
  const rows = model.rows(now);
  const flows = model.flows(now);
  const front = model.front();
  const narrow = W < 80;
  const focusRow = rows.find(r => r.id === ui.focus) || rows[0];

  // the counts, longest form that fits: feed state + working + needs + spend → working + needs → needs alone
  const working = [(head.working ? spin(now, ui.still) + ' ' : '○ ') + head.working + ' working', head.working ? 'ph b' : 'dim'];
  const needs = [(head.needs ? '▲ ' : '△ ') + head.needs + ' needs you', head.needs ? 'am b' : 'dim'];
  const sep = ['   ', ''];
  const feed = head.feed !== 'live' ? [[feedWord(head.feed), 'am'], sep] : [];
  const forms = [feed.concat([working, sep, needs, sep, [costText(head.cost), 'dim']]), feed.concat([working, sep, needs]), [working, sep, needs], [needs]];
  function putCounts(y, xMin) {
    for (const form of forms) {
      const w = form.reduce((n, s) => n + width(s[0]), 0);
      let x = W - w;
      if (x < xMin) continue;
      for (const seg of form) {
        const x0 = x;
        x = g.put(x, y, seg[0], seg[1]);
        if (seg === needs && head.needs) hit(x0, x, y, { t: 'needs' });
        else if (seg === working) hit(x0, x, y, { t: 'page', page: 'crew' });
      }
      return W - w;
    }
    return -1;
  }

  // NOW: what the busy ones are doing (the agent whose ask is on the card is left out: the card says it)
  const busy = rows.filter(r => r.status.key === 'needs' && !(front && front.agentId === r.id)).concat(rows.filter(r => r.status.key === 'working'));
  function drawNow(x0, y) {
    let x = g.put(x0, y, 'NOW    ', 'lbl b');
    for (const r of busy) {
      if (x > W - 12) break;
      const xn = x;
      x = g.put(x, y, r.name, 'hi b');
      hit(xn, x, y, { t: 'agent', id: r.id });
      x = g.put(x, y, ' › ', 'dim');
      x = g.put(x, y, trunc(r.now || 'working', Math.max(8, Math.min(48, W - x - 3))), r.status.key === 'needs' ? 'am' : 'fg');
      x = g.put(x, y, '    ', '');
    }
  }
  // FLOWS: the station's lines and their last job
  function drawFlows(x0, y) {
    hit(x0, W, y, { t: 'page', page: 'work' });   // the line opens WORK, where every flow is listed whole
    let x = g.put(x0, y, 'FLOWS  ', 'lbl b');
    flows.forEach((f, i) => {
      const run = f.state === 'running';
      const lamp = run ? spin(now, ui.still) : f.state === 'done' ? '✓' : f.state === 'failed' || f.state === 'interrupted' ? '✗' : '○';
      const tailText = run ? (f.agents.length ? ' › ' + f.agents[0] + ' ' : ' ') + f.text.replace(/^[A-Z0-9 ]+ · /, '') : ' ' + f.text.replace(/^(done|delivered) · /, '') + (f.shipped ? ' · ' + f.shipped + ' shipped' : '');
      const name = trunc(f.name, 26), tl = trunc(tailText, 30);
      // a flow is said whole or not at all (the first one shortens to fit): never cut off at the screen's edge
      const room = W - x;
      if (i && width(lamp + ' ' + name + tl) > room) { if (x < W) { const more = '+' + (flows.length - i); if (room >= width(more)) g.put(x, y, more, 'dim'); } x = W; return; }
      if (x >= W - 8) return;
      x = g.put(x, y, lamp + ' ', run ? 'ph b' : f.state === 'done' ? 'ok' : lamp === '✗' ? 'bad' : 'dim');
      x = g.put(x, y, trunc(name, Math.max(4, W - x)), run ? 'hi b' : 'fg');
      x = g.put(x, y, trunc(tl, Math.max(0, W - x)), run ? 'ph' : 'dim');
      x = g.put(x, y, '     ', '');
    });
  }

  // ---- header: the StarNet wordmark, and beside it the station, the counts, NOW and FLOWS -------------------------
  // where the terminal draws images, the REAL logo is an image the dashboard paints into these cells (ui.logoImage); the
  // screen here only keeps them blank. Without an image: the same real logo as braille dots (STARNET_LOGO=ascii keeps the
  // drawn-letter version, =plain the one-line mark)
  const img = ui.logoImage && ui.logoImage.cols > 0 ? ui.logoImage : null;
  const word = img || ui.logo === 'plain' ? null : ui.logo === 'ascii' ? (logo && logo.word) || null : sixelLib.brailleLogo();
  const lw = img ? img.cols : word ? Math.max(...word.map(l => width(l))) : 0;
  const lrows = img ? img.rows : word ? word.length : 0;
  let y, top;
  // THE PIP-BOY CHROME (Andrew 10-22, mock A): a tab rule under the logo and a stat bar at the foot, where there is room
  const chrome = !narrow && H >= 20;
  let tabsRow = -1;
  if ((img || word) && lrows >= 3 && W - lw - 3 >= 44) {
    if (word) putLogo(g, word);
    const x0 = lw + 3;
    const xc = putCounts(0, x0);
    if (xc - x0 > 24) g.put(x0, 0, trunc(ui.stationLabel || '', xc - x0 - 3), 'dim');
    if (busy.length) drawNow(x0, 1);
    if (flows.length) drawFlows(x0, 2);
    top = lrows + 1;
    if (chrome) tabsRow = lrows;   // the blank row under the logo
  } else {
    // the one-line mark, the counts on it; NOW and FLOWS under it only when they have something to say
    let x = 0;
    'STARNET'.split('').forEach((ch, i) => { x = g.put(x, 0, ch, 'logo b'); if (i < 6) x = g.put(x, 0, ' ', ''); });
    const xc = putCounts(0, x + 3);
    if (!narrow && xc - x > 30) g.put(x + 3, 0, trunc(ui.stationLabel || '', xc - x - 6), 'dim');
    y = 1;
    if (busy.length) drawNow(0, y++);
    if (flows.length) drawFlows(0, y++);
    top = y;
  }
  const statY = chrome ? H - 1 : -1, hintY = chrome ? H - 2 : H - 1, promptY = hintY - 1, bot = promptY - 1;
  let avatar = null;   // { x, y, cols, rows, id, key }: where the dashboard paints the camera feed, of whom, doing what
  const wk = ui.wake || null;   // the awakening (a station with no agent yet): its stage names where you are

  // ---- CREW: a framed list down the left — lamp, name, and a word for what it is doing — the one in COMMS marked; at its
  // foot, where the terminal draws images and the list leaves room, the station camera locked on the agent in COMMS -
  // the awakening shows the crew once its agent exists; the FLOOR is the crew itself, the whole width
  const side = W >= 90 && rows.length > 0 && !(ui.wake && !ui.wake.crew) && !(ui.page === 'floor' && !ui.wake && !ui.picker && !ui.overlay);
  const sw = side ? 30 : 0;   // room for a name and its tag, and for the camera feed at its foot
  if (side) {
    // the crew BY KIND, each kind under its strip (the app's NEEDS YOU, grouped by kind): who waits on you, who works,
    // who stands by. A kind with nobody in it is not drawn.
    const items = [];
    for (const [label, list, st] of [
      ['NEEDS YOU', rows.filter(r => r.status.key === 'needs'), 'ink b amfill'],
      ['WORKING', rows.filter(r => r.status.key === 'working'), 'lbl b sel'],
      ['STANDING BY', rows.filter(r => r.status.key !== 'needs' && r.status.key !== 'working'), 'lbl b sel']
    ]) if (list.length) { items.push({ strip: label + ' ' + list.length, st }); for (const r of list) items.push({ r }); }
    const card = ui.images && focusRow && items.length <= bot - top - 1 - AGENT_ROWS;
    const listBot = card ? bot - AGENT_ROWS : bot;
    const inner = listBot - top - 1;
    const fi = Math.max(0, items.findIndex(it => it.r === focusRow));
    const start = items.length > inner ? Math.min(Math.max(0, fi - Math.floor(inner / 2)), items.length - inner) : 0;
    const shown = items.slice(start, start + inner);
    const above = items.slice(0, start).filter(it => it.r).length, below = items.slice(start + shown.length).filter(it => it.r).length;
    frame(g, 0, top, sw - 1, bot, 'rule');
    if (tabsRow < 0) edgeL(g, 2, top, [['CREW', 'lbl b'], [' ' + rows.length, 'dim']]);
    if (above) edgeR(g, sw - 2, top, [['↑ ' + above, 'dim']]);
    if (below) edgeR(g, sw - 2, bot, [['↓ ' + below, 'dim']]);
    shown.forEach((it, i) => {
      const yy = top + 1 + i;
      if (it.strip) { g.put(1, yy, (' ' + it.strip).padEnd(sw - 2, ' '), it.st); return; }
      const r = it.r, foc = r === focusRow;
      const [lamp, lc] = lampOf(r.status, blink, now, ui.still);
      // a working agent shows what it has been doing, a segment per 2 s slot: lit = it did something then (a run merely
      // open, waiting on its model, is the dim floor, so a stalled run never reads as busy); the rest keep their word
      const meter = r.status.key === 'working' && Array.isArray(r.act) ? r.act.slice(-6) : null;
      const tag = meter ? null : tagOf(r.status, now);
      g.put(3, yy, lamp, lc);
      g.put(5, yy, trunc(r.name, sw - 7 - (meter ? 7 : tag ? width(tag[0]) + 1 : 0)), foc || r.status.key !== 'idle' ? 'hi b' : 'fg');
      if (meter) meter.forEach((v, k) => g.put(sw - 8 + k, yy, '▌', v > RUN_FLOOR ? 'ph' : 'rule'));
      else if (tag) g.putR(sw - 2, yy, tag[0], tag[1]);
      if (foc) { g.put(1, yy, '▌', 'ph b'); g.hl(yy, 1, sw - 1, 'sel'); }
      hit(1, sw - 1, yy, { t: 'agent', id: r.id });   // a click opens its chat (on the one already open: its menu)
    });
    areas.crew = { x0: 0, x1: sw, y0: top, y1: bot + 1 };
    if (card) {
      // the rule carries its name and what it is doing, the camera's REC light at its end; under it, the feed
      g.put(0, listBot, '├' + '─'.repeat(sw - 2) + '┤', 'rule');
      edgeR(g, sw - 2, listBot, [['●', ui.still || Math.floor(now / 600) % 2 === 0 ? 'ph b' : 'rule'], [' REC', 'dim']]);
      const waking = !!(ui.wake && ui.wake.feedKey);   // the awakening: the newborn at its desk in the dark
      const [said0, wc0, said1] = stateWords(focusRow.status, now, ui.still);
      const wc = waking ? 'dim' : wc0, said = waking ? '' : said1;
      // the crew list's own word for an ask; a name too long for the word keeps the state's lamp alone (⠋ ▲ ✓ ■ ○)
      let word = waking ? 'waking' : focusRow.status.key === 'needs' ? '▲ asks' : said0;
      if (width(focusRow.name) > sw - 14 - width(word)) word = [...word][0];
      // how long it has worked or waited (its row in the list shows its activity), said only beside the whole name
      let more = waking ? '' : said;
      if (more && width(focusRow.name) > sw - 15 - width(word) - width(more)) more = '';
      const title = trunc(focusRow.name, Math.max(4, sw - 14 - width(word) - (more ? width(more) + 1 : 0)));
      edgeL(g, 2, listBot, [[title, 'hi b'], [' ', ''], [word, wc]].concat(more ? [[' ' + more, 'dim']] : []));
      // the feed is an image the dashboard paints into these cells; the screen only says where, of whom, doing what
      avatar = { x: 2, y: listBot + 1, cols: sw - 4, rows: AGENT_ROWS - 1, id: focusRow.id, key: waking ? ui.wake.feedKey : focusRow.status.key };
    }
  }

  // ---- COMMS: the focused agent's conversation, framed; the open ask's card sits at its foot ------------------------------
  const cx0 = sw, cx1 = W - 1;
  // THE PAGES (Andrew 10-22, with the mouse): STAT · CREW · COMMS · WORK · SKILLS on the tab rule, each one the whole of this
  // frame. COMMS is the conversation; SKILLS is the skills list (/skills); the awakening has none of them.
  const page = wk ? '' : PAGES.indexOf(ui.page) >= 0 ? ui.page : '';
  // THE SPLIT: the agents COMMS shows side by side (drawSplit), named where COMMS is named
  const splitIds = !wk && ui.panes ? ui.panes.filter(id => rows.some(r => r.id === id)) : [];
  const splitName = splitIds.length > 1 ? splitIds.map(id => rows.find(r => r.id === id).name).join(' · ') : '';
  frame(g, cx0, top, cx1, bot, 'rule');
  // with the tab rule above, the frames carry no titles of their own (the rule says each place once)
  if (tabsRow < 0) {
    if (wk) edgeL(g, cx0 + 2, top, [[wk.stage.title || 'THE AWAKENING', 'ph b']].concat(wk.stage.detail ? [[' · ' + wk.stage.detail, 'dim']] : []));
    else if (page) edgeL(g, cx0 + 2, top, [[page.toUpperCase(), 'ph b']]);
    else edgeL(g, cx0 + 2, top, splitName ? [['COMMS', 'ph b'], [' ▸ ', 'rule'], [splitName, 'hi b']] : focusRow ? [['COMMS', 'ph b'], [' ▸ ', 'rule'], [focusRow.name, 'hi b']] : [['COMMS', 'ph b']]);
  }
  const right = [];
  const showModel = !page && focusRow && focusRow.model && cx1 - cx0 > 60;
  if (showModel) right.push([focusRow.model, 'dim']);
  if (!page && ui.scroll > 0 && !splitName) right.push([(right.length ? '  ' : '') + '↑ ' + ui.scroll, 'am']);
  if (!page && !side && focusRow && !ui.wake) right.push([(right.length ? '  ' : '') + (rows.indexOf(focusRow) + 1) + '/' + rows.length, 'dim']);
  if (right.length) {
    edgeR(g, cx1 - 1, top, right);
    // the model's name opens /model
    const xs = cx1 - 1 - (right.reduce((n, s) => n + width(s[0]), 0) + 2) + 1;
    if (showModel && !wk) hit(xs, xs + width(focusRow.model), top, { t: 'model' });
  }
  // the trusted project every message from here works in, on the frame's foot (said whatever the width)
  if (ui.project && ui.project.label) edgeL(g, cx0 + 2, bot, [[trunc(ui.project.label, Math.max(8, cx1 - cx0 - 8)), 'dim']]);
  const ix0 = cx0 + 2, ix1 = cx1 - 2, iy0 = top + 1, iy1 = bot - 1;
  const cw = Math.min(ix1 - ix0 + 1, 96);
  // the agent menu you opened first; then an agent's ask (a run is waiting on it); else the folder card, when the folder
  // `starnet` started in is not trusted
  const menuAgent = !wk && ui.agentMenu ? model.state.agents.get(ui.agentMenu) : null;
  const menuRow = menuAgent ? rows.find(r => r.id === menuAgent.id) : null;
  // the "/" menu while a command is typed (above everything else at the foot: it goes the moment the word is done)
  const slash = slashMenu(ui);
  const card = wk ? (wk.ask ? wakeCardLines(wk.ask, cw, now, ui.still) : []) : slash ? slashLines(slash, iy1 - iy0 - 4, cw) : menuRow ? menuLines(menuAgent, menuRow, now, ui.still)
    : front ? cardLines(front, model, cw, H) : ui.trust ? trustLines(ui.trust, cw) : [];
  const cardTop = iy1 - card.length + 1;
  let floorAt = null;   // the FLOOR's picture region, when it draws one (the dashboard puts the picture there)
  const paneBot = card.length ? cardTop - 1 : iy1 + 1;
  if (ui.picker) drawPicker(g, ui.picker, iy0, paneBot, ix0, ix1, blink, hit);
  else if (ui.overlay) drawOverlay(g, ui.overlay, iy0, paneBot, ix0, ix1, tabsRow >= 0);
  else if (page === 'stat') drawStatPage(g, ui, head, rows, flows, iy0, paneBot, ix0, ix1, hit);
  else if (page === 'crew') drawCrewPage(g, model, rows, focusRow, ui, iy0, paneBot, ix0, ix1, now, hit);
  else if (page === 'work') drawWorkPage(g, flows, focusRow, ui, iy0, paneBot, ix0, ix1, now, hit);
  else if (page === 'floor') floorAt = drawFloorPage(g, rows, ui, iy0, paneBot, ix0, ix1, hit);
  else if (wk) drawWake(g, wk, iy0, paneBot, ix0, ix1, ui, now);
  else if (!focusRow) g.put(ix0, iy0, trunc(head.feed === 'connecting' ? 'connecting to the station…' : 'no agents on this station yet', ix1 - ix0 + 1), 'dim');
  else if (splitName) areas.panes = drawSplit(g, model, rows, ui, iy0, paneBot, ix0, ix1, now, hit);
  else drawPane(g, focusRow ? model.logOf(focusRow.id) : [], focusRow, iy0, paneBot, ix0, ix1, ui, now, hit);
  if (card.length) drawCard(g, card, cardTop, ix0, cw, blink, hit);
  areas.comms = { x0: cx0, x1: cx1 + 1, y0: top, y1: bot + 1 };

  // ---- THE TAB RULE: the places on this screen, the one you are in hanging from the rule in a filled label ---------------
  if (tabsRow >= 0) {
    // a list laid over COMMS (/help) is the place you are in: the tab names it, so the list keeps the row
    // every tab is a page a click opens (the awakening's rule names its stage only). [id, label, count]
    const skillsOpen = !!(ui.picker && ui.picker.kind === 'skills');
    const hereId = wk || (ui.overlay && !ui.picker) ? 'comms' : skillsOpen ? 'skills' : page || 'comms';
    const hereText = ui.overlay && !ui.picker ? ui.overlay.title : wk ? wk.stage.title || 'THE AWAKENING'
      : hereId === 'comms' ? (splitName ? 'COMMS ▸ ' + splitName : focusRow ? 'COMMS ▸ ' + focusRow.name : 'COMMS') : hereId.toUpperCase();
    const detail = wk ? wk.stage.detail || '' : '';
    const all = wk ? (side ? [['crew', 'CREW', ' ' + rows.length]] : []).concat([['comms', 'COMMS', '']])
      : [['stat', 'STAT', ''], ['crew', 'CREW', ' ' + rows.length], ['floor', 'FLOOR', ''], ['comms', 'COMMS', ''], ['work', 'WORK', flows.length ? ' ' + flows.length : ''], ['skills', 'SKILLS', '']];
    // the place you are in keeps at least 8 cells of its name; a tab that leaves it less is left off, from the right
    const tw = t => t[0] === hereId ? 0 : 1 + width(t[1]) + width(t[2]) + 1;
    const fixedW = list => 2 + list.reduce((n, t) => n + tw(t) + 3, 0) + 4 + (detail ? width(detail) + 2 : 0);
    const tabs = all.slice();
    while (tabs.length > 1 && W - fixedW(tabs) < 8) { const i = tabs.map(t => t[0] !== hereId).lastIndexOf(true); if (i < 0) break; tabs.splice(i, 1); }
    let x = g.put(0, tabsRow, '──', 'rule');
    for (const t of tabs) {
      const xt = x;
      if (t[0] === hereId) {
        x = g.put(x, tabsRow, '┘', 'rule');
        x = g.put(x, tabsRow, ' ' + trunc(hereText, Math.max(8, W - fixedW(tabs))) + ' ', 'ink b hifill');
        x = g.put(x, tabsRow, '└', 'rule');
        if (detail) x = g.put(x, tabsRow, ' ' + trunc(detail, Math.max(4, W - x - 6)) + ' ', 'dim');
      } else { x = g.put(x, tabsRow, ' ' + t[1], 'dim b'); x = g.put(x, tabsRow, t[2] + ' ', 'dim'); }
      if (!wk) hit(xt, x, tabsRow, { t: 'tab', page: t[0], here: t[0] === hereId });
      x = g.put(x, tabsRow, '───', 'rule');
    }
    while (x < W) x = g.put(x, tabsRow, '─', 'rule');
  }
  // ---- THE STAT BAR (the Pip-Boy's level · HP · AP): the station's level and what it is doing, in segments -----------------
  if (statY >= 0) {
    const sep = ['│', 'rule'];
    const parts = [];
    const st = ui.stats;   // the station's growth, read from its save (Xp.compute): level and how far into it
    // each part opens where it is said in full: the level and the spend on STAT, the crew on CREW, an ask at its agent
    const part = (segs, act) => { segs.act = act; parts.push(segs); };
    if (st && st.level) part([[' LV ' + st.level + ' ', 'ink b hifill'], [' ', '']].concat(Array.from({ length: 10 }, (_, k) => ['▌', k < Math.round((st.frac || 0) * 10) ? 'ph' : 'rule'])).concat([['  XP ' + st.inLevel + '/' + st.span + '  ', 'dim']]), { t: 'page', page: 'stat' });
    // the awakening before its agent exists has no crew to count
    if (!(wk && !wk.crew)) {
      part([['  CREW ' + rows.length + ' ', 'fg b']], { t: 'page', page: 'crew' });
      part([[(head.working ? spin(now, ui.still) + ' ' : '○ ') + head.working + ' WORKING ', head.working ? 'ph b' : 'dim']].map(s => ['  ' + s[0], s[1]]), { t: 'page', page: 'crew' });
      part([[(head.needs ? '▲ ' : '△ ') + head.needs + ' NEEDS YOU ', head.needs ? 'am b' : 'dim']].map(s => ['  ' + s[0], s[1]]), head.needs ? { t: 'needs' } : null);
    }
    part([['  ' + costText(head.cost).toUpperCase() + ' ', 'fg']], { t: 'page', page: 'stat' });
    const d = new Date(now), clock = ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ';
    const room = W - width(clock) - 1;
    let x = 0, drawn = 0;
    parts.forEach(segs => {
      const w = segs.reduce((n, s) => n + width(s[0]), 0) + (drawn ? 1 : 0);
      if (x + w > room) return;   // what does not fit is left out whole, never cut
      if (drawn++) x = g.put(x, statY, sep[0], sep[1]);
      const xs = x;
      for (const [t, s] of segs) x = g.put(x, statY, t, s);
      if (!wk) hit(xs, x, statY, segs.act);
    });
    g.putR(W, statY, clock, 'ink b hifill');
  }

  // ---- prompt + keys ------------------------------------------------------------------------------------------------
  const flashKey = ui.keyFlash && ui.keyFlash.until > now;
  let px = g.put(0, promptY, (ui.wake ? 'you' : focusRow ? focusRow.name.toLowerCase() : 'starnet') + ' ', 'dim');   // the awakening: your answers
  px = g.put(px, promptY, '▸ ', 'brand b');
  const room = W - px - 2 - (flashKey ? 8 : 0);
  // a pasted multi-line message shows its breaks as ⏎; a secret (a /connect key) shows only that something is typed
  const secret = !!(ui.wake && ui.wake.ask && ui.wake.ask.secret);
  const typed = secret ? '•'.repeat(Math.min(40, [...String(ui.input || '').replace(/\s/g, '')].length)) : String(ui.input || '').replace(/\n/g, ' ⏎ ');
  const inp = width(typed) > room ? '…' + tail(typed, room - 1) : typed;
  px = g.put(px, promptY, inp, 'hi');
  g.put(px, promptY, blink ? '█' : ' ', 'ph');
  if (flashKey) g.putR(W, promptY, '[' + ui.keyFlash.k + ']', 'am b');
  if (ui.flash && ui.flash.until > now) g.put(0, hintY, trunc(ui.flash.text, W), ui.flash.style || 'am');
  else if (ui.quitArmed && ui.quitArmed > now) g.put(0, hintY, trunc('ctrl+c again to quit — ' + ui.quitNote, W), 'am b');
  else {
    // /connect is no setup: esc leaves it, and a key or a URL is typed whole (its options are a click)
    const t = wk && wk.connect
      ? (wk.ask && (wk.ask.secret || wk.ask.freeText) ? 'type ' + (wk.ask.customLabel || 'it') + ' + enter · esc goes back'
        : wk.ask ? ((wk.ask.options || []).length ? '1-' + wk.ask.options.length + ' pick · ' : '') + (wk.ask.custom ? 'or type it + enter · ' : '') + 'esc goes back'
          : 'esc goes back')
      : wk
      ? (wk.ask ? ((wk.ask.options || []).length ? '1-' + wk.ask.options.length + ' pick · ' : '') + (wk.ask.custom ? 'or type your own + enter · ' : '') + 'ctrl+c pauses setup'
        : wk.typing ? 'any key shows the rest' : 'ctrl+c pauses setup')
      : slash ? 'tab completes /' + slash.items[slash.sel].name + ' · enter runs it · ↑ ↓ pick · esc hides this'
      : slashCommandOf(ui) ? (c => '/' + c.name + (c.argsHint ? ' ' + c.argsHint : '') + ' — ' + c.desc + (c.here === false ? ' (only in the StarNet app)' : ''))(slashCommandOf(ui))
      : menuRow ? 'o open chat · m model · n new chat · h history' + (menuAgent.runs && menuAgent.runs.size ? ' · s stop' : '') + ' · esc close'
      : front
      ? (front.question ? (front.question.options.length ? '1-' + front.question.options.length + ' pick · ' : '') + 'type an answer + enter · esc clears' : 'y allow once · ' + (canAlways(front) ? 'a always · ' : '') + 'n deny · v ' + (front.view ? 'hide' : 'view') + ' · ' + (narrow ? 'tab agent' : 'tab next agent'))
      : ui.trust ? 'y trust this folder · n not now · or just type to talk'
        : page ? PAGE_HINT[page] + '  ·  esc back to COMMS  ·  f1-f6 pages'
          : narrow ? 'tab agent · /model · /new · /help · ctrl+c quit' : 'tab next agent  ·  ↑ ↓ history  ·  /model  ·  /new  ·  /resume  ·  /help  ·  f1-f6 pages  ·  ctrl+c quit';
    g.put(0, hintY, trunc(t, W), 'dim');
  }
  const out = g.out();
  out.avatar = avatar;
  out.floor = floorAt;
  out.hits = hits;
  out.areas = areas;
  return out;
}

const AGENT_ROWS = 9;   // the titled rule above it + its 8-row scene

// ---- THE PAGES: STAT, CREW and WORK, each the whole COMMS frame (SKILLS is the /skills list; COMMS the conversation) ----
const PAGES = ['stat', 'crew', 'floor', 'work'];
const PAGE_HINT = {
  stat: 'the station: its level, spend, crew and work',
  crew: 'click an agent to open its chat · right-click one for its menu',
  work: 'click a workflow to send it a job',
  floor: 'the crew at work · a handoff flies desk to desk · click a name to open its chat'
};
const padR = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
// a page's rows from `top`, scrolled by ui.pageScroll: { label, segs, act, on, strip } (null = a blank row). A labelled row
// keeps a 12-cell label column; a strip runs the frame's width; a row with an act is clicked as a whole
function drawPageRows(g, list, ui, top, bot, x0, x1, hit) {
  const H = bot - top;
  if (H <= 0) return;
  ui.pageScroll = Math.min(Math.max(0, ui.pageScroll | 0), Math.max(0, list.length - H));
  list.slice(ui.pageScroll, ui.pageScroll + H).forEach((r, i) => {
    if (!r) return;
    const y = top + i;
    if (r.strip) { g.put(x0 - 1, y, padR(' ' + r.strip, x1 - x0 + 3), r.st || 'lbl b sel'); return; }
    let x = x0;
    if (r.label != null) { g.put(x0, y, trunc(r.label, 11), 'lbl b'); x = x0 + 12; }
    for (const [t, s] of r.segs) { const room = x1 + 1 - x; if (room <= 0) break; x = g.put(x, y, trunc(t, room), s); }
    if (r.on) { g.put(x0 - 1, y, '▌', 'ph b'); g.hl(y, x0, x1 + 1, 'sel'); }
    if (r.act) hit(x0 - 1, x1 + 1, y, r.act);
  });
}
// text the station wrote, wrapped under a label (the label on its first row only)
function labelled(L, label, lines, style, w) {
  let first = true;
  for (const t of lines) for (const ln of wrap(String(t), w)) { L.push({ label: first ? label : '', segs: [[ln, style]] }); first = false; }
}
// STAT: the station's level (its save's growth record, read by the app's xp.js), its spend, its crew and work, and the
// ledger's own words (/usage). Nothing here is counted by the terminal that the station did not say.
function drawStatPage(g, ui, head, rows, flows, top, bot, x0, x1, hit) {
  const L = [], w = Math.max(10, x1 - x0 + 1 - 12);
  const st = ui.stats;
  if (st && st.level) {
    const lit = Math.max(0, Math.min(10, Math.round((st.frac || 0) * 10)));
    L.push({ label: 'LEVEL', segs: [[' LV ' + st.level + ' ', 'ink b hifill'], ['  ', ''], ['▌'.repeat(lit), 'ph'], ['▌'.repeat(10 - lit), 'rule'], ['  XP ' + st.inLevel + '/' + st.span, 'hi'], ['  · ' + st.toNext + ' XP to level ' + (st.level + 1), 'dim']] });
    L.push({ label: '', segs: [[st.lifetimeXp + ' XP in all · ' + st.tasksDone + ' task' + (st.tasksDone === 1 ? '' : 's') + ' shipped', 'fg']] });
    L.push({ label: 'CONFIDENCE', segs: [[st.known ? st.confLabel + ' · ' + st.band : 'calibrating', st.known ? 'hi' : 'dim'], ['  · ▲ ' + st.positiveFeedback + '  ▼ ' + st.negativeFeedback + ' rated', 'dim']] });
  } else L.push({ label: 'LEVEL', segs: [['not recorded on this station yet', 'dim']] });
  L.push(null);
  L.push({ label: 'SPEND', segs: [[costText(head.cost), 'hi']].concat(head.cost && head.cost.cap ? [['  · capped at $' + head.cost.cap.toFixed(2) + ' a day', 'dim']] : []) });
  L.push({ label: 'CREW', act: { t: 'page', page: 'crew' }, segs: [[rows.length + ' agent' + (rows.length === 1 ? '' : 's'), 'hi'], ['  · ' + head.working + ' working · ' + head.needs + ' need' + (head.needs === 1 ? 's' : '') + ' you', 'dim']] });
  const running = flows.filter(f => f.state === 'running').length, shipped = flows.reduce((n, f) => n + (Number(f.shipped) || 0), 0);
  L.push({ label: 'WORK', act: { t: 'page', page: 'work' }, segs: [[flows.length + ' workflow' + (flows.length === 1 ? '' : 's'), 'hi'], ['  · ' + running + ' running · ' + shipped + ' shipped', 'dim']] });
  L.push({ label: 'STATION', segs: [[ui.stationLabel || '', 'fg']] });
  L.push(null);
  const u = ui.pageData && ui.pageData.usage;
  if (!u || u.loading) L.push({ label: 'USAGE', segs: [['reading the station ledger…', 'dim']] });
  else if (u.error) L.push({ label: 'USAGE', segs: [[u.error, 'am']] });
  else labelled(L, 'USAGE', (u.title ? [u.title] : []).concat(u.lines || []), 'fg', w);
  drawPageRows(g, L, ui, top, bot, x0, x1, hit);
}
// CREW: every agent on one line — its state, its model, what it is doing — who waits on you first. A click opens its chat.
function drawCrewPage(g, model, rows, focusRow, ui, top, bot, x0, x1, now, hit) {
  const Wd = x1 - x0 + 1, nameW = 18, stW = 14, modelW = Wd >= 100 ? 30 : Wd >= 72 ? 18 : 0;
  const L = [{ segs: [['  ' + padR('NAME', nameW), 'dim b'], [padR('STATE', stW), 'dim b']].concat(modelW ? [[padR('MODEL', modelW), 'dim b']] : []).concat([['NOW', 'dim b']]) }];
  const order = rows.filter(r => r.status.key === 'needs').concat(rows.filter(r => r.status.key === 'working'), rows.filter(r => r.status.key !== 'needs' && r.status.key !== 'working'));
  for (const r of order) {
    const a = model.state.agents.get(r.id) || {};
    const [lamp, lc] = lampOf(r.status, true, now, ui.still);
    const [word, wc, more] = stateWords(r.status, now, ui.still);
    const said = word.replace(/^\S+ /, '') + (more ? ' ' + more : '');
    L.push({ on: r === focusRow, act: { t: 'agent', id: r.id }, segs: [[lamp + ' ', lc], [padR(trunc(r.name, nameW - 1), nameW), r === focusRow || r.status.key !== 'idle' ? 'hi b' : 'fg'], [padR(trunc(said, stW - 1), stW), wc]]
      .concat(modelW ? [[padR(trunc((a.provider ? a.provider + ' · ' : '') + (a.model || '—'), modelW - 1), modelW), 'dim']] : [])
      .concat([[r.now || '', r.status.key === 'needs' ? 'am' : 'fg']]) });
  }
  drawPageRows(g, L, ui, top, bot, x0, x1, hit);
}
/* THE FLOOR (f6, /floor): the whole crew in one room. Where the terminal draws images it is a picture (bin/lib/floor.js):
   this leaves its region empty and says where it is (the dashboard draws it there, with the name plates over it); with no
   images, the same truth as text — the lead, the workers it sent (each with what it is doing), the rest. Under it the LOG
   of the handoffs: who sent what to whom, who came back. ui.floorView: { images, ready, lead, kids, log } */
function drawFloorPage(g, rows, ui, top, bot, x0, x1, hit) {
  const fv = ui.floorView || {};
  const w = x1 - x0 + 1;
  const logLines = (fv.log || []).slice(-3);
  const picBot = bot - 4;   // the LOG: its rule and three lines
  let region = null;
  if (fv.images && picBot - top >= 8) {
    region = { x: x0, y: top, cols: w, rows: picBot - top };
    if (!fv.ready) g.put(x0 + 2, top + 1, trunc('the floor is fetching the crew\'s art…', w - 2), 'dim');
  } else {
    const byId = new Map(rows.map(r => [r.id, r]));
    const word = r => r.status.key === 'working' ? ['● ' + (r.now || 'working'), 'ph'] : r.status.key === 'needs' ? ['▲ ' + (r.now || 'needs you'), 'am'] : r.status.key === 'done' ? ['✓ done', 'ok'] : r.status.key === 'stopped' ? ['■ ' + r.status.text, 'dim'] : ['standing by', 'dim'];
    const kids = (fv.kids || []).filter(id => byId.has(id));
    const lead = byId.get(fv.lead);
    let y = top;
    const line = (r, lead2, prefix) => {
      if (y >= picBot) return;
      let x = g.put(x0, y, prefix, 'rule');
      const x1n = g.put(x, y, r.name, lead2 ? 'ph b' : 'hi b');
      x = lead2 ? g.put(x1n, y, '  lead', 'dim') : x1n;
      const [t, st] = word(r);
      g.put(x + 2, y, trunc(t, Math.max(4, x1 - x - 2)), st);
      hit(x0, x1 + 1, y, { t: 'agent', id: r.id });
      y++;
    };
    if (lead) line(lead, kids.length > 0, '');
    kids.forEach((id, i) => line(byId.get(id), false, i === kids.length - 1 ? '└─▶ ' : '├─▶ '));
    if (lead || kids.length) y++;
    // the rest: who has something going on, then who stands by — on one line when they would not all fit
    const rest = rows.filter(r => r !== lead && kids.indexOf(r.id) < 0);
    const by = rest.filter(r => r.status.key === 'idle');
    rest.filter(r => r.status.key !== 'idle').forEach(r => line(r, false, ''));
    if (by.length && picBot - y >= by.length) by.forEach(r => line(r, false, ''));
    else if (by.length && y < picBot) {
      const x = g.put(x0, y, by.length + ' standing by  ', 'dim');
      g.put(x, y, trunc(by.map(r => r.name).join(', '), Math.max(4, x1 - x)), 'fg');
    }
  }
  let x = g.put(x0, picBot, 'LOG ', 'dim b');
  while (x <= x1) x = g.put(x, picBot, '─', 'rule');
  if (!logLines.length) g.put(x0, picBot + 1, trunc('no handoffs yet — when an agent sends work to the crew it shows here, and on the floor', w), 'dim');
  logLines.forEach((e, i) => g.put(x0, picBot + 1 + i, trunc(clock(e.at) + '  ' + e.text, w), e.style || 'fg'));
  return region;
}
function clock(at) { const d = new Date(at); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); }
// WORK: the station's workflows (a click readies a job for one), its routines (the scheduler's own list) and the away shift
// of the agent shown (/away list)
function drawWorkPage(g, flows, focusRow, ui, top, bot, x0, x1, now, hit) {
  const L = [], D = ui.pageData || {}, w = Math.max(10, x1 - x0 - 1);
  L.push({ strip: 'WORKFLOWS ' + flows.length });
  if (!flows.length) L.push({ segs: [['none yet · build a line in the app (INBOX → steps → OUTBOX)', 'dim']] });
  for (const f of flows) {
    const run = f.state === 'running';
    const lamp = run ? spin(now, ui.still) : f.state === 'done' ? '✓' : f.state === 'failed' || f.state === 'interrupted' ? '✗' : '○';
    const said = run ? (f.agents.length ? f.agents.join(', ') + ' · ' : '') + f.text.replace(/^[A-Z0-9 ]+ · /, '') : f.text;
    L.push({ act: { t: 'flow', name: f.name }, segs: [[lamp + ' ', run ? 'ph b' : f.state === 'done' ? 'ok' : lamp === '✗' ? 'bad' : 'dim'], [padR(trunc(f.name, 27), 28), run ? 'hi b' : 'fg'], [said, run ? 'ph' : 'dim'], [f.shipped ? '  · ' + f.shipped + ' shipped' : '', 'dim']] });
  }
  L.push(null);
  const c = D.cron;
  L.push({ strip: 'ROUTINES' + (c && c.jobs ? ' ' + c.jobs.length + ' · scheduler ' + (c.halted ? 'stopped (E-STOP)' : c.enabled ? 'on' : 'off') : '') });
  if (!c || c.loading) L.push({ segs: [['reading the routines…', 'dim']] });
  else if (c.error) L.push({ segs: [[c.error, 'am']] });
  else if (!c.jobs.length) L.push({ segs: [['none yet · /routine creates one', 'dim']] });
  else for (const j of c.jobs) {
    L.push({ segs: [[(j.inFlight ? spin(now, ui.still) : j.enabled ? '●' : '○') + ' ', j.inFlight ? 'ph b' : j.enabled ? 'ok' : 'dim'], [padR(trunc(j.name, 27), 28), j.enabled ? 'hi' : 'dim'], [j.when, 'fg'],
      [(j.agent ? ' · ' + j.agent : '') + (j.inFlight ? ' · running now' : j.enabled ? (j.next ? ' · next ' + j.next : '') : ' · paused'), 'dim']] });
  }
  L.push(null);
  const a = D.away;
  L.push({ strip: 'AWAY SHIFT' + (a && a.agent ? ' · ' + a.agent : focusRow ? ' · ' + focusRow.name : '') });
  if (!a || a.loading) L.push({ segs: [['reading the away shift…', 'dim']] });
  else if (a.error) L.push({ segs: [[a.error, 'am']] });
  else for (const t of (a.title ? [a.title] : []).concat(a.lines || [])) for (const ln of wrap(String(t), w)) L.push({ segs: [[ln, t === a.title ? 'hi b' : 'fg']] });
  drawPageRows(g, L, ui, top, bot, x0, x1, hit);
}
/* THE "/" MENU (Andrew 10-24: "when users type / it should pop up with the suggestion menu"): while the command word is being
   typed, the commands that match it, from the station's own catalog (the app's 43, the agent's skills, recipes, your own) and
   the terminal's (/flow, the pages, /quit). Pure: ui.slashCatalog is [{ name, aliases, desc, argsHint, source, here }]. */
const SOURCE_ORDER = { terminal: 0, builtin: 0, user: 1, skill: 2, recipe: 3 };
function slashMatches(list, word) {
  const w = String(word || '').toLowerCase();
  const scored = [];
  for (const c of list || []) {
    const n = String(c.name || '').toLowerCase(), al = (c.aliases || []).map(a => String(a).toLowerCase());
    // the word typed whole (a name or an alias: /stat, /v) first, so enter runs what was typed; then the names it
    // starts, the aliases it starts, the names it is in, the descriptions
    const s = !w ? 0 : (n === w || al.indexOf(w) >= 0) ? 0 : n.indexOf(w) === 0 ? 1 : al.some(a => a.indexOf(w) === 0) ? 2 : n.indexOf(w) >= 0 ? 3 : String(c.desc || '').toLowerCase().indexOf(w) >= 0 ? 4 : -1;
    if (s >= 0) scored.push([s, c]);
  }
  return scored.sort((a, b) => a[0] - b[0] || (SOURCE_ORDER[a[1].source] || 0) - (SOURCE_ORDER[b[1].source] || 0)).map(x => x[1]);
}
// the menu, when one shows: only while the command word is typed (a space ends it), never in the awakening, not after esc
function slashMenu(ui) {
  const t = String(ui.input || '');
  if (ui.wake || !/^\/[^\s]*$/.test(t) || ui.slashHidden === t || !Array.isArray(ui.slashCatalog)) return null;
  const items = slashMatches(ui.slashCatalog, t.slice(1));
  if (!items.length) return null;
  return { items, sel: Math.max(0, Math.min(items.length - 1, ui.slashSel | 0)) };
}
// the command a typed line names, once its word is complete (/goal fix it → /goal's entry)
function slashCommandOf(ui) {
  const m = /^\/(\S+)\s/.exec(String(ui.input || ''));
  if (!m || !Array.isArray(ui.slashCatalog)) return null;
  const w = m[1].toLowerCase();
  return ui.slashCatalog.find(c => String(c.name).toLowerCase() === w || (c.aliases || []).some(a => String(a).toLowerCase() === w)) || null;
}
function slashLines(menu, rows, cw) {
  const n = Math.max(1, Math.min(8, rows)), start = Math.max(0, Math.min(menu.sel - Math.floor(n / 2), menu.items.length - n));
  const lines = [{ kind: 'top', title: menu.items.length + ' COMMAND' + (menu.items.length === 1 ? '' : 'S'), glyph: '/ ' }];
  menu.items.slice(start, start + n).forEach((c, i) => {
    const on = start + i === menu.sel;
    const tag = c.here === false ? '  · in the app' : c.source && c.source !== 'builtin' && c.source !== 'terminal' ? '  · ' + (c.source === 'user' ? 'yours' : c.source) : '';
    lines.push({ kind: 'body', on, act: { t: 'slash', name: c.name }, segs: [[padR('/' + c.name, 20), on ? 'hi b' : c.here === false ? 'dim' : 'ph'], [trunc(String(c.desc || ''), Math.max(8, cw - 25 - width(tag))), on ? 'hi' : c.here === false ? 'dim' : 'fg'], [tag, 'dim']] });
  });
  lines.push({ kind: 'bottom', keys: [['[TAB] COMPLETE', 'am b'], ['[ENTER] RUN', 'am b'], ['[↑↓] PICK', 'am b'], ['[ESC] HIDE', 'am b']], more: menu.items.length - n });
  return lines;
}
// THE AGENT MENU (a right-click on an agent, or a click on the one already shown): what you can do with it, a card at the
// foot of COMMS — each line a click, or the letter in brackets
function menuLines(a, row, now, still) {
  const lines = [{ kind: 'top', title: String(a.name).toUpperCase(), glyph: '▸ ' }];
  const [word, wc, more] = stateWords(row.status, now, still);
  lines.push({ kind: 'body', segs: [[(a.provider ? a.provider + ' · ' : '') + (a.model || 'no model set'), 'dim'], ['   ' + word + (more ? ' ' + more : ''), wc]] });
  const n = a.runs ? a.runs.size : 0;
  const items = [['o', 'OPEN CHAT', 'talk to ' + a.name + ' in COMMS'], ['m', 'MODEL', 'switch the model it runs on'], ['n', 'NEW CHAT', 'start a fresh conversation with it'], ['h', 'HISTORY', 'its earlier conversations from this terminal']];
  if (n) items.push(['s', 'STOP', 'stop its ' + n + ' run' + (n === 1 ? '' : 's')]);
  for (const [k, label, what] of items) lines.push({ kind: 'body', act: { t: 'menu', key: k }, segs: [[padR('[' + k.toUpperCase() + '] ' + label, 15), 'am b'], [what, 'fg']] });
  lines.push({ kind: 'bottom', keys: [['CLICK ONE OR PRESS ITS KEY', 'am'], ['[ESC] CLOSE', 'am b', { t: 'menu', key: 'escape' }]] });
  return lines;
}
// what the agent in the card is doing, in words on its rule: [word, style, a second word]
function stateWords(s, now, still) {
  if (s.key === 'working') return [spin(now, still) + ' working', 'ph b', fmtDur(now - (s.since || now))];
  if (s.key === 'needs') return ['▲ needs you', 'am b', ''];
  if (s.key === 'done') return ['✓ done', 'ok', ''];
  if (s.key === 'stopped') return ['■ stopped', 'bad', String(s.text || '') === 'stopped' ? '' : String(s.text || '')];
  return ['○ idle', 'dim', ''];
}

// the word beside a name in the CREW list: what its lamp means, in a word
function tagOf(s, now) {
  if (s.key === 'needs') return ['ASKS', 'am'];
  if (s.key === 'working') return [fmtDur(now - (s.since || now)), 'ph'];
  if (s.key === 'done') return ['DONE', 'ok'];
  if (s.key === 'stopped') return [trunc(String(s.text || 'stopped').toUpperCase(), 9), 'bad'];
  return null;
}

function feedWord(f) { return f === 'connecting' ? 'connecting…' : f === 'down' ? 'feed lost · retrying' : f === 'old' ? 'live feed unavailable · polling' : String(f || ''); }
function spark(act) { const mx = Math.max(4, ...act); return act.map(v => BARS[Math.min(7, Math.round(v / mx * 7))]).join(''); }
function tail(s, n) { const a = [...String(s)]; let out = '', w = 0; for (let i = a.length - 1; i >= 0; i--) { const cw = cpWidth(a[i].codePointAt(0)); if (w + cw > n) break; out = a[i] + out; w += cw; } return out; }

/* MARKDOWN, the way a terminal shows it: an agent writes markdown, and raw `**`, backticks and fences read as noise. Block level:
   fenced code (a dim bar down its left, no fences shown), headings (bold white), bullets (•) and numbered items, quotes, rules.
   Inline: **bold** / __bold__ (bold white), `code` (amber), [text](url) (the text, then the url dim). Everything else is text. */
function mdInline(s, base) {
  base = base || 'fg';
  const out = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(\S(?:[^*]*\S)?)\*(?![\w*])/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push([s.slice(last, m.index), base]);
    if (m[1] || m[2]) out.push([m[1] || m[2], 'hi b']);
    else if (m[3]) out.push([m[3], 'am']);
    else if (m[4]) { out.push([m[4], base === 'fg' ? 'hi' : base]); out.push([' (' + m[5] + ')', 'dim']); }
    else out.push([m[6], base]);   // *emphasis*: a terminal has no italic to give it, so the words stand plain
    last = re.lastIndex;
  }
  if (last < s.length) out.push([s.slice(last), base]);
  return out.length ? out : [['', base]];
}
function mdLines(text) {
  const out = [];
  let code = false;
  for (const raw of clean(text).split('\n')) {
    if (/^\s*```/.test(raw)) { code = !code; continue; }
    if (code) { out.push({ pre: [['│ ', 'dim']], segs: [[raw || ' ', 'fg']] }); continue; }
    let m;
    if ((m = /^#{1,6}\s+(.*)$/.exec(raw))) { out.push({ pre: [], segs: mdInline(m[1], 'hi b') }); continue; }
    if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(raw))) { out.push({ pre: [[' '.repeat(Math.min(6, m[1].length)) + '• ', 'ph']], segs: mdInline(m[2]) }); continue; }
    if ((m = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(raw))) { out.push({ pre: [[' '.repeat(Math.min(6, m[1].length)) + m[2] + '. ', 'ph']], segs: mdInline(m[3]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { out.push({ pre: [], segs: [['────', 'rule']] }); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(raw))) { out.push({ pre: [['│ ', 'dim']], segs: mdInline(m[1], 'dim') }); continue; }
    out.push({ pre: [], segs: mdInline(raw) });
  }
  return out;
}
// styled segments → lines no wider than w, broken at spaces (a longer word is cut), styles kept
function wrapSegs(segs, w) {
  w = Math.max(4, w);
  const lines = [[]];
  let lw = 0;
  const cur = () => lines[lines.length - 1];
  const add = (t, s) => { const L = cur(); if (L.length && L[L.length - 1][1] === s) L[L.length - 1][0] += t; else L.push([t, s]); };
  const breakLine = () => { const L = cur(); if (L.length) L[L.length - 1][0] = L[L.length - 1][0].replace(/ +$/, ''); lines.push([]); lw = 0; };
  for (const [text, style] of segs) {
    for (const tok of String(text).split(/( +)/)) {
      if (!tok) continue;
      if (/^ +$/.test(tok)) { if (lw && lw + tok.length <= w) { add(tok, style); lw += tok.length; } else if (lw) breakLine(); continue; }
      let word = tok;
      while (width(word) > w) {
        if (lw) breakLine();
        let head = '', hw = 0;
        for (const ch of word) { const cw = cpWidth(ch.codePointAt(0)); if (hw + cw > w) break; head += ch; hw += cw; }
        add(head, style); breakLine(); word = word.slice(head.length);
      }
      if (!word) continue;
      if (lw && lw + width(word) > w) breakLine();
      add(word, style); lw += width(word);
    }
  }
  if (lines.length > 1 && !cur().length) lines.pop();
  return lines;
}

// the conversation as rows: { label, lc, segs } (null = a blank row between exchanges); the text column is `tw` wide
function paneRows(log, focusRow, tw, now) {
  const out = [];
  const name = focusRow ? focusRow.name : '';
  log.forEach((e, i) => {
    if ((e.k === 'you' || e.k === 'start' || e.k === 'say') && i > 0) out.push(null);
    if (e.k === 'say') {
      // a station command's answer, under the command that asked: its title, then its lines as the station wrote them
      const rowsOf = (e.title ? [[e.title, 'hi b']] : []).concat(e.lines.flatMap(l => String(l).split('\n')).map(l => [l, e.ok ? 'fg' : 'am']));
      let first = true;
      for (const [t, s] of rowsOf) for (const ln of wrap(t, tw)) { out.push({ label: first ? e.cmd : '', lc: 'ph b', segs: [[ln, s]] }); first = false; }
      if (first) out.push({ label: e.cmd, lc: 'ph b', segs: [['done', 'dim']] });
      return;
    }
    if (e.k === 'tool') {
      const segs = [['↳ ', 'dim'], [e.name, 'ph'], ['  ' + e.args, 'fg']];
      if (e.running) segs.push(['  ' + ['·  ', '·· ', '···'][Math.floor(now / 320) % 3], 'dim']);
      else if (e.res) segs.push(['  · ' + e.res, e.ok === false ? 'bad' : 'dim']);
      out.push({ label: '', segs, file: e.file || '', runId: e.runId || '', root: e.root });   // a file tool's line: ctrl+click opens the file
      return;
    }
    let label = '', lc = '', tc = 'fg', text = e.text, note = '';
    if (e.k === 'you') { label = 'YOU'; lc = 'hi b'; tc = e.queued ? 'dim' : 'hi'; }
    else if (e.k === 'start' && e.source === 'desktop') { label = 'YOU'; lc = 'hi b'; tc = 'hi'; note = '· from the app'; if (!text) text = e.adopted ? '(a run already under way when this terminal attached)' : '(a run from the app)'; }
    else if (e.k === 'start') { label = e.source.toUpperCase().slice(0, 7); lc = 'dim b'; tc = 'fg'; if (!text) text = e.adopted ? '(a ' + e.source + ' run, already under way when this terminal attached)' : '(' + e.source + ' run)'; }
    else if (e.k === 'agent') {
      // the agent's words, rendered as markdown: each block line wrapped under its own prefix (bullet, code bar)
      let first = true;
      for (const ml of mdLines(text + (e.live ? '▍' : ''))) {
        const pw = ml.pre.reduce((n, s) => n + width(s[0]), 0);
        wrapSegs(ml.segs, tw - pw).forEach((segs, j) => {
          out.push({ label: first ? name : '', lc: 'ph b', segs: (j ? (pw ? [[' '.repeat(pw), '']] : []) : ml.pre).concat(segs) });
          first = false;
        });
      }
      return;
    }
    else if (e.k === 'ok') tc = 'ok';
    else if (e.k === 'bad') tc = 'bad';
    else if (e.k === 'ask') tc = 'am';
    else tc = 'dim';
    const lines = wrap(text, tw);
    lines.forEach((ln, j) => {
      const segs = [[ln, tc]];
      // where the words came from, after the first line when it fits there, else after the last
      if (note && ((j === 0 && width(ln) + width(note) + 2 <= tw) || (j === lines.length - 1 && j > 0 && width(lines[0]) + width(note) + 2 > tw && width(ln) + width(note) + 2 <= tw))) segs.push(['  ' + note, 'dim']);
      out.push({ label: j ? '' : label, lc, segs });
    });
  });
  return out;
}
// the conversation inside [x0, x1] (inclusive), rows top..bot-1, newest at the bottom; scrolls by ui.scroll
function drawPane(g, log, focusRow, top, bot, x0, x1, ui, now, hit) {
  const H = bot - top;
  if (H <= 0) return;
  // the label column fits the agent's name and any command whose answer is shown (/routine, /version …)
  const L = Math.max(8, Math.min(14, Math.max(focusRow ? width(focusRow.name) : 0, ...log.filter(e => e.k === 'say').map(e => width(e.cmd))) + 2));
  const all = paneRows(log, focusRow, x1 - x0 + 1 - L, now);
  if (!all.length) { g.put(x0 + L, top, trunc(focusRow ? 'nothing yet · type a message for ' + focusRow.name + ' and press enter' : '', x1 - x0 - L), 'dim'); return; }
  const maxScroll = Math.max(0, all.length - H);
  ui.scroll = Math.min(Math.max(0, ui.scroll | 0), maxScroll);
  const end = all.length - ui.scroll;
  all.slice(Math.max(0, end - H), end).forEach((r, i) => {
    if (!r) return;
    const yy = top + i;
    if (r.label) g.put(x0, yy, trunc(r.label, L - 1), r.lc);
    let x = x0 + L;
    for (const [t, s] of r.segs) { const room = x1 + 1 - x; if (room <= 0) break; x = g.put(x, yy, trunc(t, room), s); }
    if (r.file && hit && focusRow) hit(x0 + L, x, yy, Object.assign({ t: 'file', path: r.file, runId: r.runId, agentId: focusRow.id }, typeof r.root === 'string' ? { root: r.root } : {}));
  });
}
/* THE SPLIT (/split, Andrew 10-27: "talk to multiple agents at once … see both sessions on the screen … as many as they
   want … each session separately scrollable"): COMMS holds one pane per agent in ui.panes, side by side while each keeps
   SPLIT_MIN_W cells, then in more rows. Each pane is that agent's own conversation with its own scroll (the one you type
   to: ui.scroll; the rest: ui.scrolls[id]); its head names it and says what it is doing, the one you type to marked and
   filled. A click on a head picks the pane you type to; the dashboard scrolls the pane under the wheel (out.panes). */
const SPLIT_MIN_W = 36;
function splitLayout(n, x0, x1, top, bot) {
  const w = x1 - x0 + 1;
  const cols = Math.max(1, Math.min(n, Math.floor((w + 1) / (SPLIT_MIN_W + 1))));
  const rowsN = Math.ceil(n / cols), h = bot - top;
  const cells = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), inRow = Math.min(cols, n - r * cols), c = i % cols;
    const cw = Math.floor((w - (inRow - 1)) / inRow);
    const cx0 = x0 + c * (cw + 1), cx1 = c === inRow - 1 ? x1 : cx0 + cw - 1;
    const ch = Math.floor((h - (rowsN - 1)) / rowsN);
    const cy0 = top + r * (ch + 1), cy1 = r === rowsN - 1 ? bot : cy0 + ch;
    cells.push({ x0: cx0, x1: cx1, top: cy0, bot: cy1 });
  }
  return { cols, rows: rowsN, cells };
}
function drawSplit(g, model, rows, ui, top, bot, x0, x1, now, hit) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const ids = (ui.panes || []).filter(id => byId.has(id));
  const L = splitLayout(ids.length, x0, x1, top, bot);
  const out = [];
  ids.forEach((id, i) => {
    const c = L.cells[i], r = byId.get(id), mine = id === ui.focus;
    // the rules between panes
    if (c.x1 < x1) for (let y = c.top; y < c.bot; y++) g.put(c.x1 + 1, y, '│', 'rule');
    if (c.bot < bot) { for (let x = c.x0; x <= c.x1; x++) g.put(x, c.bot, '─', 'rule'); if (c.x1 < x1) g.put(c.x1 + 1, c.bot, '┴', 'rule'); }
    const [word, wc] = stateWords(r.status, now, ui.still);
    const scroll = mine ? ui.scroll : (ui.scrolls && ui.scrolls[id]) || 0;
    let x = g.put(c.x0, c.top, mine ? '▌' : ' ', mine ? 'ph b' : '');
    x = g.put(x, c.top, trunc(r.name, Math.max(4, c.x1 - x - 12)), mine ? 'ink b hifill' : 'hi b');
    x = g.put(x, c.top, ' ' + trunc(word, Math.max(0, c.x1 - x - 6)), wc);
    if (scroll > 0) g.putR(c.x1 + 1, c.top, '↑ ' + scroll, 'am');
    if (hit) hit(c.x0, c.x1 + 1, c.top, { t: 'pane', id });
    const pu = { scroll, still: ui.still };
    drawPane(g, model.logOf(id), r, c.top + 1, c.bot, c.x0 + 1, c.x1, pu, now, hit);
    if (mine) ui.scroll = pu.scroll; else if (ui.scrolls) ui.scrolls[id] = pu.scroll;
    out.push({ id, x0: c.x0, x1: c.x1 + 1, y0: c.top, y1: c.bot });
  });
  return out;
}
/* A PICKER (/model, /resume): a filterable list inside the COMMS frame. p: { title, note, filter, sel, items: [{ cols:
   [[text, style]…], search, current }], loading, error, foot }. The selected row sits on the highlight bar, the current one is
   marked ●, the window scrolls to keep the selection in view. Pure: it only reads p (sel is clamped by the caller's keys). */
function pickerView(p) {
  const terms = String(p.filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (p.items || []).filter(it => terms.every(t => String(it.search || '').indexOf(t) >= 0));
}
function drawPicker(g, p, top, bot, x0, x1, blink, hit) {
  let y = top;
  let x = g.put(x0, y, p.title || 'PICK', 'hi b');
  if (p.note) g.putR(x1 + 1, y, trunc(p.note, Math.max(0, x1 - x - 3)), 'dim');
  y++;
  const list = pickerView(p);
  x = g.put(x0, y, '› ', 'brand b');
  x = g.put(x, y, trunc(p.filter || '', Math.max(4, x1 - x0 - 24)), 'hi');
  g.put(x, y, blink ? '█' : ' ', 'ph');
  g.putR(x1 + 1, y, p.loading ? 'loading…' : list.length + ' of ' + (p.items || []).length, 'dim');
  y += 2;
  const rowsAvail = Math.max(1, bot - 1 - y);
  if (p.error && !list.length) { g.put(x0, y, trunc(p.error, x1 - x0 + 1), 'bad'); }
  else if (!list.length && !p.loading) g.put(x0, y, p.filter ? 'nothing matches "' + trunc(p.filter, 40) + '"' : 'nothing to pick', 'dim');
  const sel = Math.max(0, Math.min(list.length - 1, p.sel | 0));
  const start = Math.max(0, Math.min(sel - Math.floor(rowsAvail / 2), list.length - rowsAvail));
  list.slice(start, start + rowsAvail).forEach((it, i) => {
    const yy = y + i, on = start + i === sel;
    g.put(x0, yy, it.current ? '●' : ' ', 'ph b');
    let xx = x0 + 2;
    // a grouped list (/connect): the group's name where its rows begin (and atop the window), the app's group heads
    if (p.groupW) {
      const wide = x1 - x0 >= 104, prev = list[start + i - 1];
      const gw = wide ? 25 : 14, label = wide ? it.group : (it.groupShort || it.group);
      xx = g.put(xx, yy, padR(i === 0 || !prev || prev.group !== it.group ? trunc(String(label || ''), gw - 1) : '', gw), on ? 'hi b' : 'ph b');
    }
    for (const [t, s] of it.cols) { if (xx > x1) break; xx = g.put(xx, yy, trunc(t, Math.max(0, x1 + 1 - xx)), on ? 'hi b' : s); }
    if (on) { g.put(x0 - 1 < 0 ? x0 : x0 - 1, yy, '▌', 'ph b'); g.hl(yy, x0, x1 + 1, 'sel'); }
    if (hit) hit(x0, x1 + 1, yy, { t: 'pick', i: start + i });   // a click chooses it, as enter does
  });
  g.put(x0, bot - 1, trunc(p.foot || '↑ ↓ pick · enter choose · esc close · type to filter', x1 - x0 + 1), 'dim');
}
// a list laid over COMMS (/help, /status): from o.scroll on, as many as fit; the foot says what is above and below (the
// wheel and pgup / pgdn move it), never a list silently cut short
function drawOverlay(g, o, top, bot, x0, x1, titled) {
  let y = top;
  if (!titled) g.put(x0, y++, o.title, 'hi b');
  const wide = x1 - x0 >= 66, per = wide ? 1 : 2;
  const fit = Math.max(1, Math.floor((bot - 1 - y) / per));
  o.scroll = Math.max(0, Math.min(o.items.length - fit, o.scroll | 0));
  const shown = o.items.slice(o.scroll, o.scroll + fit);
  for (const [k, d] of shown) {
    if (wide) { g.put(x0 + 2, y, trunc(k, 22), 'ph'); g.put(x0 + 26, y, trunc(d, x1 - x0 - 25), 'fg'); y++; }
    else { g.put(x0 + 2, y++, trunc(k, x1 - x0 - 1), 'ph'); g.put(x0 + 4, y++, trunc(d, x1 - x0 - 3), 'fg'); }
  }
  const above = o.scroll, below = o.items.length - o.scroll - shown.length;
  const more = (above ? '↑ ' + above + ' above · ' : '') + (below ? '↓ ' + below + ' more · ' : '') + (above || below ? 'the wheel or pgup pgdn scrolls · ' : '');
  if ((o.foot || more) && y <= bot - 1) g.put(x0 + 2, bot - 1, trunc(more + (o.foot || ''), x1 - x0 - 1), more ? 'am' : 'dim');
}

// the open ask as card rows: [{ text, style, kind }], for a card `cw` cells wide
function cardLines(q, model, cw, H) {
  const a = model.state.agents.get(q.agentId);
  const name = a ? a.name : q.agentId.toUpperCase();
  const lines = [{ kind: 'top', name }];
  const inner = cw - 4;
  if (q.question) {
    wrap(q.question.text, inner).slice(0, 3).forEach(t => lines.push({ kind: 'body', segs: [[t, 'hi']] }));
    q.question.options.forEach((o, i) => lines.push({ kind: 'body', act: { t: 'answer', i }, segs: [[(i + 1) + '  ', 'am b'], [o + (o === q.question.recommended ? '  (suggested)' : ''), 'fg']] }));
  } else {
    lines.push({ kind: 'body', segs: [[q.tool, 'ph b'], ['  ' + q.summary, 'hi']] });
    if (q.view) {
      // the request read as written: a file change as the file (its path, then its text), anything else as key: value lines
      const detail = q.details == null ? ['loading the full request…'] : String(askInspect(q.tool, q.details)).split('\n');
      const room = Math.max(1, Math.min(10, (H || 30) - 22));
      detail.slice(0, room).forEach(t => lines.push({ kind: 'body', segs: [[t, /^File: /.test(t) ? 'hi b' : /^\+/.test(t) ? 'ok' : /^-/.test(t) ? 'bad' : 'fg']] }));
      if (detail.length > room) lines.push({ kind: 'body', segs: [['… ' + (detail.length - room) + ' more line(s)', 'dim']] });
    }
  }
  lines.push({ kind: 'bottom', question: !!q.question, view: q.view, always: canAlways(q), more: model.state.prompts.length - 1 });
  return lines;
}
// Always (allow this kind of action from now on) is offered where the app's card offers it: not on an ask answered fresh
// every time
function canAlways(q) { return !!q && !q.question && ONCE_ONLY_TOOLS.indexOf(q.tool) < 0; }
// the card that asks to trust the folder `starnet` was started in: the project root the station would trust, and what that
// means. Answered with y / n like an ask.
function trustLines(t, cw) {
  const lines = [{ kind: 'top', title: 'TRUST THIS FOLDER?' }];
  lines.push({ kind: 'body', segs: [[String(t.root), 'hi b']] });
  // started in a folder inside a project: the whole project is what gets trusted
  if (t.folder && t.folder !== t.root) lines.push({ kind: 'body', segs: [['you are in ' + t.folder.slice(String(t.root).replace(/[\\/]+$/, '').length + 1) + ' · the whole project is trusted', 'dim']] });
  wrap('the crew can read and change files here · it joins PROJECTS in the app', cw - 4).forEach(s => lines.push({ kind: 'body', segs: [[s, 'fg']] }));
  wrap('not now: each agent works in its own workspace', cw - 4).forEach(s => lines.push({ kind: 'body', segs: [[s, 'dim']] }));
  lines.push({ kind: 'bottom', keys: [['[Y] TRUST', 'am b', { t: 'key', key: 'y' }], ['[N] NOT NOW', 'am b', { t: 'key', key: 'n' }]] });
  return lines;
}
/* THE AWAKENING in COMMS (bin/lib/awaken.js): who said each line (STARNET before the agent exists, then the agent; YOU
   for your answers), each line typed out at its own pace (e.born + e.cps; e.full once it is all shown), a note under them
   while the station works (the wire test). Newest at the bottom; scrolls by ui.scroll. */
function drawWake(g, w, top, bot, x0, x1, ui, now) {
  const H = bot - top;
  if (H <= 0) return;
  const L = Math.max(8, Math.min(14, Math.max(...w.log.map(e => width(e.who || '')), 0) + 2));
  const tw = Math.max(10, x1 - x0 + 1 - L);
  const rows = [];
  w.log.forEach((e, i) => {
    const prev = w.log[i - 1];
    const newBlock = !prev || prev.who !== e.who || e.first;
    if (i && newBlock) rows.push(null);
    const all = [...String(e.text)];
    const n = e.full ? all.length : Math.min(all.length, Math.floor(Math.max(0, now - e.born) * (e.cps || 44) / 1000));
    const shown = all.slice(0, n).join('') + (n < all.length ? '▍' : '');
    const tc = e.bad ? 'bad' : e.you ? (e.skip ? 'dim' : 'hi') : e.who === 'STARNET' ? 'fg' : 'hi';
    const lc = e.you ? 'hi b' : e.who === 'STARNET' ? 'dim b' : 'ph b';
    wrap(shown || ' ', tw).forEach((ln, j) => rows.push({ label: newBlock && !j ? e.who : '', lc, segs: [[ln, tc]] }));
  });
  if (w.note) rows.push({ label: '', segs: [[spin(now, ui.still) + ' ' + w.note, w.noteStyle || 'dim']] });
  const maxScroll = Math.max(0, rows.length - H);
  ui.scroll = Math.min(Math.max(0, ui.scroll | 0), maxScroll);
  const end = rows.length - ui.scroll;
  rows.slice(Math.max(0, end - H), end).forEach((r, i) => {
    if (!r) return;
    const yy = top + i;
    if (r.label) g.put(x0, yy, trunc(r.label, L - 1), r.lc);
    let x = x0 + L;
    for (const [t, s] of r.segs) { const room = x1 + 1 - x; if (room <= 0) break; x = g.put(x, yy, trunc(t, room), s); }
  });
}
// the awakening's choice as a card: numbered options, the typed answer when one is welcome, a wait while a sign-in lands
function wakeCardLines(ask, cw, now, still) {
  const opts = ask.options || [];
  const lines = [{ kind: 'top', title: ask.waiting ? 'SIGN IN' : opts.length ? 'YOUR CHOICE' : 'YOUR ANSWER' }];
  if (ask.waiting) lines.push({ kind: 'body', segs: [[spin(now, still) + ' ' + ask.waiting, 'am']] });
  opts.forEach((o, i) => lines.push({ kind: 'body', act: { t: 'wake', i }, segs: [[(ask.secret || ask.freeText ? '·' : i + 1) + '  ', 'am b'], [String(o.label || ''), o.skip ? 'dim' : 'fg']] }));
  if (ask.custom) lines.push({ kind: 'body', segs: [['›  ', 'am'], ['or type ' + (ask.customLabel || 'your own answer') + ' and press enter' + (ask.optional && !opts.some(o => o.skip) ? ' (enter alone skips)' : ''), 'dim']] });
  const keys = [];
  // a key or a URL is typed from its first character (a digit too): its options are a click, or esc goes back
  if (opts.length && !ask.secret && !ask.freeText) keys.push(['[1-' + opts.length + '] PICK', 'am b']);
  if (ask.custom) keys.push([ask.secret ? '[ENTER] SAVE' : '[ENTER] SEND WHAT YOU TYPED', 'am b', { t: 'enter' }]);
  if (ask.secret || ask.freeText) keys.push(['[ESC] GO BACK', 'am b']);
  lines.push({ kind: 'bottom', keys });
  return lines;
}
function drawCard(g, lines, y0, x0, cw, blink, hit) {
  const xr = x0 + cw - 1;
  const at = hit || (() => {});
  lines.forEach((l, i) => {
    const y = y0 + i;
    if (l.kind === 'top') {
      let x = g.put(x0, y, '┌─ ', 'am');
      x = g.put(x, y, l.glyph || '▲ ', l.glyph || blink ? 'am b' : 'am faint');
      if (l.title) x = g.put(x, y, l.title + ' ', 'hi b');
      else { x = g.put(x, y, String(l.name).toUpperCase(), 'hi b'); x = g.put(x, y, ' ASKS ', 'am b'); }
      while (x < xr) x = g.put(x, y, '─', 'am');
      g.put(xr, y, '┐', 'am');
    } else if (l.kind === 'body') {
      g.put(x0, y, '│', 'am'); g.put(xr, y, '│', 'am');
      let x = x0 + 2;
      for (const [t, s] of l.segs) { const room = xr - 1 - x; if (room <= 0) break; x = g.put(x, y, trunc(t, room), s); }
      at(x0 + 1, xr, y, l.act);   // an option, or a menu line: the whole line is the click
    } else {
      let x = g.put(x0, y, '└─ ', 'am');
      // each key is a button: a click on it is the key pressed
      const key = (t, s, act) => { const xs = x; x = g.put(x, y, t, s); at(xs, x, y, act); };
      if (l.keys) l.keys.forEach(([t, s, act], j) => { if (j) x = g.put(x, y, '   ', 'am'); key(t, s, act); });
      else if (l.question) x = g.put(x, y, 'PICK A NUMBER OR TYPE AN ANSWER', 'am b');
      else {
        key('[Y] ALLOW ONCE', 'am b', { t: 'key', key: 'y' }); x = g.put(x, y, '   ', 'am');
        if (l.always) { key('[A] ALWAYS', 'am b', { t: 'key', key: 'a' }); x = g.put(x, y, '   ', 'am'); }
        key('[N] DENY', 'am b', { t: 'key', key: 'n' }); x = g.put(x, y, '   ', 'am');
        key(l.view ? '[V] HIDE' : '[V] VIEW', 'am b', { t: 'key', key: 'v' });
      }
      x = g.put(x, y, ' ', 'am');
      const tl = l.more > 0 ? ' +' + l.more + ' more ' : '';
      while (x < xr - width(tl)) x = g.put(x, y, '─', 'am');
      if (tl) x = g.put(x, y, tl, 'am b');
      g.put(xr, y, '┘', 'am');
    }
    // the line picked (the "/" menu's) sits on the highlight bar, the rest on the card
    if (l.on) { g.put(x0 + 1, y, '▌', 'ph b'); g.hl(y, x0 + 1, xr, 'sel'); g.hl(y, x0, x0 + 1, 'card'); g.hl(y, xr, xr + 1, 'card'); }
    else g.hl(y, x0, xr + 1, 'card');
  });
}

// ---- styles → ANSI ------------------------------------------------------------------------------------------
// level 0: no color (NO_COLOR) — bold/inverse only · level 2: 256 colors · level 3: 24-bit
const PALETTE = {   // (the accent entries are retinted in place by /theme — theme.js)
  fg: ['#d9d2d4', 252], hi: ['#ffffff', 231], dim: ['#7f666b', 95], rule: ['#7a1c28', 88], lbl: ['#ff4757', 203],
  ph: ['#ff3b4e', 203], am: ['#ffb43a', 214], ok: ['#5dffa8', 85], bad: ['#ff6b3d', 202],
  logo: ['#ff2e3e', 196], logohi: ['#ffb0b8', 217], brand: ['#ff2e3e', 196],   // the wordmark's neon red, and the prompt's ▸
  ink: ['#0c0c0c', 16]   // text on a filled label (the tab you are in, the level, the clock, the NEEDS YOU strip)
};
// (256-color: the card sits on a near-black — the nearest palette brown, 58, is a loud olive)
// hifill / amfill: the Pip-Boy's filled labels — white for where you are, amber for what waits on you
const BG = { sel: ['#3a0c14', 52], card: ['#1f1405', 234], inv: ['#ff3b4e', 203], hifill: ['#ffffff', 231], amfill: ['#ffb43a', 214], plate: ['#120c0e', 233] };
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function sgr(style, level) {
  const parts = String(style || '').split(/\s+/).filter(Boolean);
  const codes = [];
  if (parts.indexOf('b') >= 0) codes.push('1');
  if (parts.indexOf('faint') >= 0) codes.push('2');
  if (level === 0) {
    if (parts.indexOf('inv') >= 0 || parts.indexOf('sel') >= 0 || parts.some(p => /fill$/.test(p))) codes.push('7');
    return codes.length ? '\x1b[' + codes.join(';') + 'm' : '';
  }
  const fgKey = parts.find(p => PALETTE[p]);
  const bgKey = parts.find(p => BG[p]);
  if (parts.indexOf('inv') >= 0) {
    codes.push(level === 3 ? '38;2;6;11;19' : '38;5;16');
    codes.push('1');
  } else if (fgKey) {
    const [hex, c256] = PALETTE[fgKey];
    codes.push(level === 3 ? '38;2;' + hexRgb(hex).join(';') : '38;5;' + c256);
  }
  if (bgKey) {
    const [hex, c256] = BG[bgKey];
    codes.push(level === 3 ? '48;2;' + hexRgb(hex).join(';') : '48;5;' + c256);
  }
  return codes.length ? '\x1b[' + codes.join(';') + 'm' : '';
}
function toAnsi(segs, level) {
  let s = '';
  for (const [t, style] of segs) { const on = sgr(style, level); s += on ? on + t + '\x1b[0m' : t; }
  return s;
}
function toPlain(segs) { return segs.map(s => s[0]).join(''); }
// the segments from cell `col` on (the cells left of it are the logo image's, never written over), up to `end` when given
function sliceSegs(segs, col, end) {
  if (!col && end == null) return segs;
  const out = [];
  let x = 0;
  for (const [t, style] of segs) {
    let piece = '';
    for (const ch of t) { const w = cpWidth(ch.codePointAt(0)); if (x >= col && (end == null || x + w <= end)) piece += ch; x += w; }
    if (piece) out.push([piece, style]);
  }
  return out;
}

// what the terminal can show: NO_COLOR wins, then 24-bit where the terminal says so, else 256
function colorLevel(env, isTTY) {
  const e = env || {};
  if (!isTTY || (e.NO_COLOR != null && e.NO_COLOR !== '') || e.TERM === 'dumb') return 0;
  if (/^(truecolor|24bit)$/i.test(String(e.COLORTERM || '')) || e.WT_SESSION || /^(vscode|iTerm\.app|WezTerm)$/.test(String(e.TERM_PROGRAM || ''))) return 3;
  return 2;
}

module.exports = { PALETTE, BG, render, splitLayout, SPLIT_MIN_W, toAnsi, toPlain, sliceSegs, colorLevel, clean, width, wrap, trunc, makeGrid, HELP, cardLines, trustLines, wakeCardLines, menuLines, pickerView, stateWords, PAGES, slashMatches, slashMenu, slashCommandOf };
