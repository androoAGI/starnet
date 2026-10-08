// SELF-DRIVING — a real model drives StarNet from plain words (2026-10-08).
//   node dev/self-driving-proof.mjs [port] [--estop]        against a RUNNING station with a real model
// Each ask goes into a FRESH COMMS session in the Commander's own words — no tool names — and every check reads the
// harness's truth (the caps route, the halt route, the page's own state), never the agent's reply. Close every other tab
// on that station first: station.show answers only the page whose focused session owns the run.
// The scratch station: the `self-driving-seed` launch entry (dev/seed.js --keep, dev/.env.dev key) — never a real station.
// --estop also presses the E-STOP through the agent and then RESUMEs it through the top-bar button, as the Commander would.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { findChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const PORT = Number(process.argv.find(a => /^\d+$/.test(a)) || 8796);
const ESTOP = process.argv.includes('--estop');
let failed = 0;
let last = null;   // the latest ask's run: a FAIL prints its tool rows, so it can be diagnosed without a re-run
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); if (!ok) { failed++; if (last) for (const t of last.tools.slice(0, 14)) console.log('      ' + t.slice(0, 160)); } };
const dir = mkdtempSync(join(tmpdir(), 'starnet-self-driving-'));
const chrome = spawn(findChrome(), ['--headless=new', '--no-first-run', '--window-size=1440,900', '--remote-debugging-port=9497', '--user-data-dir=' + join(dir, 'c'), 'about:blank'], { stdio: 'ignore', windowsHide: true });
try {
  const cdp = await connectCDP(9497);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
  const run = (s) => evalJS(cdp, s);
  for (let i = 0; i < 80; i++) { try { if (await run(`typeof Chat === 'object' && typeof Workstreams === 'object' && !!document.querySelector('#screen-game.active')`)) break; } catch {} await sleep(500); }
  await sleep(4000);
  const api = (path) => run(`fetch(${JSON.stringify(path)}).then(r => r.json())`);

  // one ask: a fresh session, the Commander's words, wait for the run to end; returns its tool rows + reply
  async function ask(q) {
    const ws = await run(`(() => { const w = Workstreams.create(${JSON.stringify('proof: ' + q.slice(0, 30))}); Chat.load(w); return w.id; })()`);
    await sleep(1500);
    const t0 = Date.now();
    await run(`Chat.sendOrQueue(${JSON.stringify(q)}), true`);
    await sleep(6000);
    while (Date.now() - t0 < 300000) {
      const done = await run(`!Chat.isBusy() && /RUN (COMPLETE|FAILED|STOPPED|ENDED)/.test(document.querySelector('#chat-panel').innerText)`);
      if (done) break;
      await sleep(2000);
    }
    await sleep(2500);
    return last = await run(`(() => { const p = document.querySelector('#chat-panel');
      return { ws: ${JSON.stringify(ws)}, secs: ${'Math.round((Date.now() - ' + t0 + ') / 1000)'},
        tools: [...new Set([...p.querySelectorAll('.tool, [class*="tool-"]')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()))],
        end: (p.innerText.match(/■ RUN [^\\n]*/g) || []).pop() || '', text: p.innerText.slice(-600) }; })()`);
  }
  const used = (r, re) => r.tools.some(t => re.test(t) && /^✓/.test(t));
  const stamp = r => r.secs + 's · ' + (r.end.match(/(\d+) tool calls?/) || ['', '?'])[1] + ' calls';

  // 1 · open a window
  let r = await ask('Open my deliverables for me please.');
  check('"open my deliverables" puts DELIVERABLES on screen', await run(`!!document.querySelector('.term.dlv-win')`) && used(r, /station\.show/), stamp(r));

  // 2 · an escalation, read back from the caps route
  const want = 6 + Math.floor(Math.random() * 4);
  r = await ask('Set a daily spending limit of $' + want + ' for the whole station.');
  const caps = (await api('/api/budget/status')).caps || {};
  check('"daily spending limit of $' + want + '" saves perDay ' + want, caps.perDay === want, stamp(r) + ' · perDay ' + caps.perDay);

  // 3 · a change, not a window
  r = await ask('Clear my notifications.');
  check('"clear my notifications" DOES notifications.clear (opening the window is not doing it)', used(r, /notifications\.clear/), stamp(r));

  // 4 · a look setting both ways, read back from the page
  r = await ask('Turn off the hover hints.');
  const off = await run(`(StationUI.lookNow() || {}).hints`);
  check('"turn off the hover hints" → hints false', off === false, stamp(r));
  r = await ask('Turn the hover hints back on.');
  const on = await run(`(StationUI.lookNow() || {}).hints`);
  check('"turn the hover hints back on" → hints true', on === true, stamp(r));

  // 5 · the conversation it is in
  r = await ask('Pin this chat to the top of my sessions list.');
  const pinned = await run(`!!(Workstreams.get(${JSON.stringify(r.ws)}) || {}).pinned`);
  check('"pin this chat to the top of my sessions list" pins THIS session', pinned, stamp(r));

  // 6 · knowledge, from the manual
  r = await ask("What's a conveyor in StarNet and where do I build one? Two sentences.");
  const reply = await run(`((Workstreams.get(${JSON.stringify(r.ws)}).history || []).filter(m => m.role === 'assistant').pop() || {}).content || ''`);
  check('"what is a conveyor" knows it is a line', /line/i.test(reply) && !/not a (standard|known) term/i.test(reply), stamp(r));

  // 7 · E-STOP through the agent; RESUME through the Commander's own button
  if (ESTOP) {
    r = await ask('Hit the emergency stop — stop everything now.');
    const halt = await api('/api/halt');
    check('"hit the emergency stop" halts every subsystem', halt.halted === true && Object.values(halt.subsystems || {}).every(s => s.halted), stamp(r));
    check('COMMS names the E-STOP and offers no TRY AGAIN', /stopped by the E-STOP this run pressed/.test(r.text) && !/TRY AGAIN/.test(r.text));
    await run(`window.dispatchEvent(new Event('focus')), true`); await sleep(1500);
    await run(`document.getElementById('automation-resume').click(), true`); await sleep(3000);
    check('RESUME AUTOMATION (the Commander) lifts it', (await api('/api/halt')).halted === false);
  }
  try { cdp.ws.close(); } catch {}
} finally {
  chrome.kill();
  setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} }, 1500);
}
console.log(failed ? failed + ' FAILED' : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
