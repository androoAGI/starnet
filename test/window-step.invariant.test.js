/* node test/window-step.invariant.test.js: THE WINDOW STEP'S TWO INVARIANTS (cost lane W2.6; STARNET_WINDOW_STEP).

   A. OFF IS THE 0.15.2 CANDIDATE, BYTE FOR BYTE. The switch is off by default. With it unset, or set to anything but on, the
      window seam (sidecar/turn-window.js apply) hands on exactly what the frozen 57c741da7 body does
      (test/fixtures/turn-window-57c741da7.js): the same messages (the same posted array where the frozen body returns it),
      the same row ids, the same comparison record and the same run identity, in every window mode, for a posted window, a
      required one, an id-less one and a branch copy, at an ample and a tight budget and with none.

   B. ON, A SEND OPENS WITH THE PREVIOUS SEND'S HISTORY (red on 57c741da7, where the switch does not exist and the window
      slides). Over a 200-row chat, in shadow and in ID mode, every send past the row cap except the one that crosses a step
      starts with exactly the bytes of the history the send before it carried.

   C. ONE READER. The switch is read once, in sidecar/index.js, through ENV() like every cost switch, and handed to the one
      window seam; only the words that turn the other cost switches on turn it on. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const Fit = require('../frontend/app/historyfit.js');
const Window = require('../sidecar/turn-window.js');
const Frozen = require('./fixtures/turn-window-57c741da7.js');
const View = require('../sidecar/turn-view.js');
const { makeChat, dialogue, wire } = require('./helpers/window-step-chat.js');

const chat = makeChat();
function seam(Module, step) {
  const identities = [];
  const api = Module.make(Object.assign({ transcriptStore: chat.store, turnDual: chat.dual, failNote: () => {}, limitOf: () => 128000, compactAt: 0.65,
    noteIdentity: (run, value) => identities.push({ run, value }) }, step === undefined ? null : { windowStep: step }));
  return { api, identities };
}
const frozen = seam(Frozen), unset = seam(Window), off = seam(Window, () => false), on = seam(Window, () => true);
// one call through a seam: what it returned and everything it recorded
function call(s, messages, request, k) {
  const before = chat.records.length, seen = s.identities.length, ctx = chat.context(k);
  let out, error = null;
  try { out = s.api.apply(messages, request, ctx); } catch (e) { error = e.code || e.message; }
  return { out, same: out === messages, json: JSON.stringify(out), ids: JSON.stringify(out && out[View.ROW_IDS] || null), error,
    records: JSON.stringify(chat.records.slice(before)), identity: JSON.stringify(s.identities.slice(seen)), ctx: Object.keys(ctx).sort().join(',') };
}
const same = (a, b) => a.same === b.same && a.json === b.json && a.ids === b.ids && a.error === b.error && a.records === b.records && a.identity === b.identity && a.ctx === b.ctx;

/* ---------- A. off is the frozen body; B. on, a send opens with the previous send's history ---------- */
const CHECK = new Set([0, 1, 5, 30, 59, 60, 61, 62, 75, 79, 80, 81, 82, 99]);
const stepped = { shadow: [], id: [] };
let cases = 0, differs = 0, changedByOn = 0;
for (let k = 0; k < 100; k++) {
  if (CHECK.has(k)) {
    for (const mode of ['legacy', 'shadow', 'id']) for (const budget of [92800, 30000, undefined]) {
      chat.setMode(mode);
      const posted = chat.posted(k, budget);
      const shapes = {
        posted: [posted, chat.request(k, budget)],
        required: [[chat.newest(k)], chat.request(k, budget, { windowFrom: 'station' })],
        'required with a posted window': [posted, chat.request(k, budget, { windowFrom: 'station' })],
        'no durable ids': [posted.map(m => m.role === 'system' ? m : { role: m.role, content: m.content, turnId: m.turnId }), chat.request(k, budget)],
        'branch copy': [[posted[0], { role: 'assistant', content: 'BRANCH', streamId: 'other', rowId: 7 }].concat(posted.slice(1)), chat.request(k, budget)],
        'not the desk': [posted, chat.request(k, budget, { windowCaller: undefined })]
      };
      for (const name of Object.keys(shapes)) {
        const [messages, request] = shapes[name];
        const want = call(frozen, messages, request, k);
        for (const [label, s] of [['unset', unset], ['off', off]]) {
          cases++;
          if (!same(call(s, messages, request, k), want)) { differs++; A.ok(false, 'send ' + k + ', ' + mode + ', budget ' + budget + ', ' + name + ': the switch ' + label + ' differs from the frozen 57c741da7 window'); }
        }
        if (!same(call(on, messages, request, k), want)) changedByOn++;
      }
    }
  }
  for (const mode of ['shadow', 'id']) {
    chat.setMode(mode);
    stepped[mode].push(wire(on.api.apply(chat.posted(k, 92800), chat.request(k, 92800), chat.context(k))));
  }
  chat.finish(k);
}
A.eq(differs, 0, 'with the switch unset or off, ' + cases + ' window calls return and record exactly what the frozen 57c741da7 body does');
A.ok(cases >= 1500 && changedByOn > 40, 'and the cases are not vacuous: the switch on changes ' + changedByOn + ' of them');

for (const mode of ['shadow', 'id']) {
  const sends = stepped[mode];
  let opens = 0, rewrites = 0, past = 0;
  for (let k = 61; k < sends.length; k++) {
    const prev = sends[k - 1], now = sends[k];
    past++;
    if (now.length > prev.length && prev.every((line, i) => now[i] === line)) opens++; else rewrites++;
  }
  A.eq([past, opens, rewrites], [39, 38, 1], mode + ': past the row cap 38 of 39 sends open with exactly the previous send\'s history; one crosses a step');
  A.eq(sends[99].length >= Fit.HISTORY_CAP, true, mode + ': and the window still holds at least the 120 rows the sliding window holds');
  A.eq(JSON.parse(sends[99][0]).content, chat.page[40].content, mode + ': the last send (199 rows, sliding start row 79) opens on the 40-row mark before it, row 40');
}
A.eq(JSON.stringify(stepped.shadow), JSON.stringify(stepped.id), 'shadow and ID mode send the same history on every send');

/* ---------- C. one reader ---------- */
{
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
  const count = (text, needle) => text.split(needle).length - 1;
  A.eq(count(index, "ENV('WINDOW_STEP')"), 1, 'index.js reads the switch once, through ENV()');
  const reader = index.match(/const windowStepOn = \(\) => (\/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('WINDOW_STEP'\) \|\| ''\)\.trim\(\)\));/);
  A.ok(reader && /TurnWindow\.make\(\{[^;]*windowStep: windowStepOn \}\);/.test(index), 'and hands that one reader to the window seam as windowStep');
  A.eq(count(index, 'windowStepOn()'), 1, 'its one other caller is the earlier note\'s front mark');
  A.ok(/const front = windowStepOn\(\) \? EarlierConversation\.frontMark\(rows, CANONICAL_ROWS_LIMIT\) : 0;\n\s+const dropped = front > 0 && front < cut \? rows\.slice\(front, cut\) : rows\.slice\(0, cut\);/.test(index),
    'which is 0 with the switch off: the note is rendered from rows.slice(0, cut), as before');
  const limits = [index.match(/const canonicalRows = streamId => transcriptStore\.view\('model-replay', streamId, \{ limit: (\d+),/), index.match(/const CANONICAL_ROWS_LIMIT = (\d+);/)];
  A.ok(limits[0] && limits[1] && limits[0][1] === limits[1][1], 'the front mark is told the limit the canonical rows are read with');
  if (reader) {
    const read = value => new Function('ENV', 'return ' + reader[1])(() => value);
    A.eq(['1', 'true', 'on', 'YES', ' 1 '].map(read), [true, true, true, true, true], 'the words that turn the cost switches on turn it on');
    A.eq([undefined, '', '0', 'off', 'false', 'no', 'lean', '2'].map(read), [false, false, false, false, false, false, false, false], 'unset, blank, 0 and anything else leave it off');
  }
  const others = [];
  for (const dir of ['sidecar', 'sidecar/providers', 'frontend/app']) for (const name of fs.readdirSync(path.join(root, dir))) {
    if (!name.endsWith('.js') || (dir === 'sidecar' && name === 'index.js')) continue;
    const text = fs.readFileSync(path.join(root, dir, name), 'utf8');
    if (/ENV\('WINDOW_STEP'\)|process\.env[^\n]{0,40}WINDOW_STEP/.test(text)) others.push(dir + '/' + name);
  }
  A.eq(others, [], 'no other file reads the switch');
  A.eq(dialogue([{ role: 'system' }, { role: 'user' }]).length, 1, 'helper sanity: the dialogue leaves system rows out');
}
A.report('window-step.invariant');
