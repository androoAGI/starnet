/* node test/comms-owner.e2e.test.js — THE COMMANDER CAN ALWAYS REACH THE MESSAGE BOX, in real Chromium on a real station
   (wave-1 B8 comms-owner-arbiter: gh#158, gh#117).

   gh#158 (v0.14.0): with the first-task hand-off pending, "select an existing session … the right panel stays on 'Your first
   task' … Create and select a new session. The same onboarding panel remains, with no message box." Done means: with
   handoffPending set, selecting a session leaves #chat-input visible and focusable. This drives the chain a Commander meets:
     1. a returning station boots with handoffPending set (+ a draft) → tutorial.onEnterGame re-offers the hand-off — now as an
        OFFER: the message box is on screen, a real click at its centre lands on it, and it takes focus;
     2. the Commander CLICKS another session in the rail (a real mouse event) → the hand-off steps aside, COMMS shows that session,
        #chat-input is visible and focusable, the first task stays pending and its draft is in the ↑ recall;
     2b. a pick that lands on the conversation ALREADY on screen does the same (review 10-27; gh#158 "create and select a new
        session"): reload → re-offered → a real click on the active session's own rail row steps it aside; then + NEW makes a
        blank, reload → re-offered over that blank → a real click on + NEW (which reuses the blank on screen) steps it aside;
     3. reload → re-offered (still an offer); the Commander types a task into the message box and presses Enter → the hand-off
        steps aside and is COMPLETE (handoffPending false); reload again → it is never offered over COMMS again;
     4. gh#117: CREW › RECRUIT opens the RECRUITMENT BAY whose main key is RECRUIT <NAME>, on screen and clickable; MY WORK's
        door opens the same window titled MY WORK.
   Isolated like station-show.e2e: fresh seeded workspace, APPDATA/LOCALAPPDATA/USERPROFILE/HOME/HERMES_HOME in scratch, a fresh
   Chrome profile, a local mock model, Andrew's real view (1x, TEXT SIZE 90, 400px rail, custom hue 216). Ports are OS-picked
   unless COMMS_OWNER_PORT is set (the gate rig uses 9706); COMMS_OWNER_SHOTS=<dir> saves viewport PNGs at each step. Skips
   LOUDLY with no Chromium. In test:http. */
'use strict';
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');

(async () => {
  const { findChrome, connectCDP, evalJS, collectDiagnostics, sleep } = await import('../scripts/lib/cdp.mjs');
  const { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } = await import('../scripts/lib/seed.mjs');
  let chromePath = null;
  try { chromePath = findChrome(); } catch (_) { chromePath = null; }
  if (!chromePath) { console.log('comms-owner.e2e: SKIPPED — no Chromium installed (this box cannot drive the live page)'); process.exit(0); }

  const failures = [];
  const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); if (!ok) failures.push(name); };
  const freePort = () => new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const a = server.address(); server.close(e => e ? reject(e) : resolve(a.port)); });
  });
  const stopChild = child => new Promise(resolve => {
    if (!child || child.exitCode != null) { resolve(); return; }
    const timer = setTimeout(resolve, 6000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { child.kill('SIGKILL'); } catch (_) {} });
      else child.kill('SIGKILL');
    } catch (_) { clearTimeout(timer); resolve(); }
  });
  // a mock model: every turn answers in words (the runs this test starts only need to complete)
  const mock = { turns: [] };
  mock.server = http.createServer((req, res) => {
    if (req.url.indexOf('/models') >= 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
    if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let p = {}; try { p = JSON.parse(body); } catch (_) {}
      const msgs = p.messages || []; const last = msgs.slice().reverse().find(m => m && m.role === 'user');
      mock.turns.push(last ? JSON.stringify(last.content || '') : '');   // whole: a task run's turn carries its run context first
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ choices: [{ delta: { content: 'Done.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
      res.write('data: [DONE]\n\n'); res.end();
    });
  });
  await new Promise(r => mock.server.listen(0, '127.0.0.1', r));
  const mockBase = 'http://127.0.0.1:' + mock.server.address().port + '/api/v1';

  const root = mkdtempSync(path.join(tmpdir(), 'starnet-comms-owner-e2e-'));
  const iso = {};
  for (const [k, d] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home'], ['HERMES_HOME', 'hermes'], ['XDG_DATA_HOME', 'xdg']]) { iso[k] = path.join(root, 'iso', d); mkdirSync(iso[k], { recursive: true }); }
  const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
  const appPort = Number(process.env.COMMS_OWNER_PORT) || await freePort(), cdpPort = await freePort();
  const base = 'http://127.0.0.1:' + appPort;
  const SHOTS = process.env.COMMS_OWNER_SHOTS || '';
  materializeSeedWorkspace(workspace, 'test/model');
  const sidecar = bootSeededSidecar({ port: appPort, scratchDir: workspace, model: 'test/model', key: 'sk-or-v1-fake', env: Object.assign({ SKYNET_OPENROUTER_BASE: mockBase, STARNET_PORT: String(appPort) }, iso) });
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + cdpPort, '--window-size=1440,900', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  const DRAFT = 'Sort my inbox into three piles';
  // Andrew's real view + a station that already has a pending first task (what a v0.14.0 Commander carried into the update)
  const SEED = `(() => { try { if (sessionStorage.getItem('co-seeded')) return; sessionStorage.setItem('co-seeded', '1');
    localStorage.setItem('starnet.pitch.v1', JSON.stringify({ v: 1, pitched: false, handoffPending: true, handoffDraft: ${JSON.stringify(DRAFT)} }));
    localStorage.setItem('starnet.station.v1', JSON.stringify({ v: 1, settings: { theme: 'custom', themeHue: 216, themeSat: 100, themeGlow: 20, panelBright: -100, flicker: false, textScale: 90, sessionRow: 'inbox' } }));
    localStorage.setItem('starnet.crewrail.w', '400'); localStorage.setItem('starnet.chatw', '767');
  } catch (e) {} })();`;
  // is the message box on screen, does a click at its centre land on it, and does it take focus?
  const BOX = `(() => { const i = document.getElementById('chat-input'); if (!i) return { exists: false };
    const r = i.getBoundingClientRect(), cs = getComputedStyle(i);
    const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 14);
    const hit = document.elementFromPoint(x, y);
    const panel = document.querySelector('.fnv-dialogue');
    return { exists: true, x, y, visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && r.top >= 0 && r.bottom <= innerHeight + 1,
      hitIsBox: !!hit && (hit === i || i.contains(hit)), hit: hit ? (hit.id || String(hit.className || hit.tagName)).slice(0, 60) : null,
      focused: document.activeElement === i, panel: !!panel, offer: !!(panel && panel.classList.contains('fnv-offer')),
      stage: ((document.querySelector('.fnv-stage') || {}).textContent || '').trim(), owner: (typeof Dialogue !== 'undefined' && Dialogue.owner) ? Dialogue.owner() : null,   // classic-script consts are not window props
      pending: (typeof PitchStore !== 'undefined' && PitchStore.handoffPending) ? PitchStore.handoffPending() : 'no PitchStore', title: ((document.getElementById('comms-title') || {}).textContent || '').trim() }; })()`;
  const shot = async (cdp, name) => {
    if (!SHOTS) return;
    try { mkdirSync(SHOTS, { recursive: true }); const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const p = path.join(SHOTS, name + '.png'); writeFileSync(p, Buffer.from(r.data, 'base64')); console.log('  shot ' + p); } catch (e) { console.log('  shot failed: ' + e.message); }
  };
  const click = async (cdp, x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const until = async (cdp, expr, tries, ms) => { for (let i = 0; i < tries; i++) { try { const v = await evalJS(cdp, expr); if (v) return v; } catch (_) {} await sleep(ms || 250); } return null; };
  const offerUp = `(() => { const p = document.querySelector('.fnv-dialogue.show'); return !!p && /FIRST TASK/.test((document.querySelector('.fnv-stage') || {}).textContent || ''); })()`;

  let cdp = null;
  try {
    check('isolated seeded sidecar starts', await waitUp(base + '/'), base);
    cdp = await connectCDP(cdpPort);
    cdp.timeoutMs = 45000;
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    const diagnostics = collectDiagnostics(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 60); window.cancelAnimationFrame = id => clearTimeout(id);' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
    await cdp.send('Page.navigate', { url: base + '/' });
    check('the real page reaches the live station', await waitDevReady(cdp, evalJS, { url: base + '/', tries: 60 }));

    /* ---- 1. the boot re-offer is an offer: the message box is reachable ---- */
    check('boot: the pending first task is re-offered (YOUR FIRST TASK)', !!(await until(cdp, offerUp, 40)));
    await until(cdp, `!!document.querySelector('.fnv-dialogue .fnv-custom-in')`, 40);   // its line has typed out and its box is up
    await sleep(300);
    await shot(cdp, '1-boot-handoff');
    let box = await evalJS(cdp, BOX);
    check('boot: the hand-off is an offer', box.offer && box.owner === 'offer', JSON.stringify(box));
    check('boot: #chat-input is on screen', box.visible, JSON.stringify(box));
    check('boot: a click at the message box centre lands on it (not on the panel)', box.hitIsBox, 'hit ' + box.hit);
    if (box.exists) { await click(cdp, box.x, box.y); await sleep(150); }
    box = await evalJS(cdp, BOX);
    check('boot: clicking the message box focuses it', box.focused, JSON.stringify(box));

    /* ---- 2. the Commander clicks another session in the rail ---- */
    const made = await evalJS(cdp, `(() => { const w = Workstreams.create('Continue Scrap Yard Crew Development', { activate: false }); if (App.refreshRail) App.refreshRail(); return w ? w.id : null; })()`);
    check('a second session exists in the rail', !!made, String(made));
    await sleep(400);
    const row = await evalJS(cdp, `(() => { const li = document.querySelector('.ws-row[data-id=${JSON.stringify(String(made))}]'); if (!li) return null; li.scrollIntoView({ block: 'center' }); const r = li.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 }; })()`);
    check('its rail row is on screen', !!row, JSON.stringify(row));
    if (row) { await click(cdp, row.x, row.y); await sleep(700); }
    box = await evalJS(cdp, BOX);
    const active = await evalJS(cdp, 'Workstreams.activeId()');
    check('select: the clicked session is the one on screen', active === made, active + ' vs ' + made);
    check('select: the hand-off stepped aside (no panel over COMMS)', !box.panel, JSON.stringify(box));
    check('select: #chat-input is visible', box.visible, JSON.stringify(box));
    check('select: a click at its centre lands on it', box.hitIsBox, 'hit ' + box.hit);
    if (box.exists) { await click(cdp, box.x, box.y); await sleep(150); }
    box = await evalJS(cdp, BOX);
    check('select: #chat-input is focusable (DONE MEANS)', box.focused, JSON.stringify(box));
    check('select: the first task is still pending (stepped aside, never declined)', box.pending === true, JSON.stringify(box));
    await shot(cdp, '2-after-session-select');
    // the draft is in the message box's ↑ recall
    const recalled = await evalJS(cdp, `(() => { const i = document.getElementById('chat-input'); i.focus(); i.value = ''; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); const v = i.value; i.value = ''; return v; })()`);
    check('select: ↑ in the empty message box brings the draft back', recalled === DRAFT, JSON.stringify(recalled));

    /* ---- 2b. picks that land on the conversation already on screen ---- */
    const activeRow = `(() => { const id = Workstreams.activeId(); const li = document.querySelector('.ws-row[data-id=' + JSON.stringify(String(id)) + ']'); if (!li) return null; li.scrollIntoView({ block: 'center' }); const r = li.getBoundingClientRect(); return { id, x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2 }; })()`;
    const newKey = `(() => { const b = document.getElementById('ws-new'); if (!b) return null; const r = b.getBoundingClientRect(); if (!(r.width > 0)) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
    await cdp.send('Page.reload', {});
    check('2b reload: the station is back', await waitDevReady(cdp, evalJS, { tries: 60 }));
    check('2b reload: the pending first task is re-offered', !!(await until(cdp, offerUp, 40)));
    await sleep(500);
    const own = await evalJS(cdp, activeRow);
    check('2b: the session on screen has its rail row', !!own, JSON.stringify(own));
    if (own) { await click(cdp, own.x, own.y); await sleep(700); }
    box = await evalJS(cdp, BOX);
    check('2b row: re-clicking the session already on screen stays on it', !!own && (await evalJS(cdp, 'Workstreams.activeId()')) === own.id);
    check('2b row: and the hand-off stepped aside (it used to stay over the conversation)', !box.panel && box.hitIsBox && box.pending === true, JSON.stringify(box));
    const nk = await evalJS(cdp, newKey);
    check('2b: + NEW is on screen', !!nk, JSON.stringify(nk));
    if (nk) { await click(cdp, nk.x, nk.y); await sleep(700); }
    const blank = await evalJS(cdp, 'Workstreams.activeId()');
    check('2b: + NEW opened a blank session', !!blank && blank !== (own && own.id), String(blank));
    await cdp.send('Page.reload', {});
    check('2b reload 2: the station is back', await waitDevReady(cdp, evalJS, { tries: 60 }));
    check('2b reload 2: re-offered over the blank session', !!(await until(cdp, offerUp, 40)) && (await evalJS(cdp, 'Workstreams.activeId()')) === blank);
    await sleep(500);
    const nk2 = await evalJS(cdp, newKey);
    if (nk2) { await click(cdp, nk2.x, nk2.y); await sleep(700); }
    box = await evalJS(cdp, BOX);
    check('2b + NEW: over the untouched blank it reuses the session on screen', (await evalJS(cdp, 'Workstreams.activeId()')) === blank);
    check('2b + NEW: and the hand-off stepped aside (gh#158 "create and select a new session … the same panel remains")', !box.panel && box.hitIsBox && box.pending === true, JSON.stringify(box));

    /* ---- 3. reload → re-offered; a task typed into the message box completes it ---- */
    await cdp.send('Page.reload', {});
    check('reload: the station is back', await waitDevReady(cdp, evalJS, { tries: 60 }));
    check('reload: the pending first task is re-offered', !!(await until(cdp, offerUp, 40)));
    await sleep(500);
    box = await evalJS(cdp, BOX);
    check('reload: still an offer with the message box reachable', box.offer && box.hitIsBox, JSON.stringify(box));
    const turnsBefore = mock.turns.length;
    if (box.exists) { await click(cdp, box.x, box.y); await sleep(120); }
    const TASK = 'Draft a short list of the three oldest emails in my inbox';
    await cdp.send('Input.insertText', { text: TASK });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(900);
    box = await evalJS(cdp, BOX);
    check('send: the hand-off stepped aside for the Commander’s own turn', !box.panel, JSON.stringify(box));
    check('send: a task sent from COMMS completes the hand-off (handoffPending false)', box.pending === false, JSON.stringify(box));
    for (let i = 0; i < 60 && mock.turns.length === turnsBefore; i++) await sleep(250);
    check('send: the task reached the model (a real run)', mock.turns.slice(turnsBefore).some(t => t.indexOf('three oldest emails') >= 0), JSON.stringify(mock.turns.slice(-3).map(t => t.slice(0, 120))));
    for (let i = 0; i < 80 && await evalJS(cdp, 'Chat.isBusy && Chat.isBusy()'); i++) await sleep(250);
    await cdp.send('Page.reload', {});
    check('reload 2: the station is back', await waitDevReady(cdp, evalJS, { tries: 60 }));
    await sleep(3000);   // onEnterGame re-offers 900 ms after entry when a hand-off is pending
    box = await evalJS(cdp, BOX);
    check('reload 2: the completed hand-off is never offered over COMMS again', !box.panel && box.hitIsBox, JSON.stringify(box));

    /* ---- 4. gh#117: CREW › RECRUIT opens a bay that RECRUITS ---- */
    await evalJS(cdp, `(() => { document.getElementById('bb-recruit').click(); return true; })()`);
    // measured where it opens, BEFORE any scroll: a key below the fold must fail here (review 10-27), not be scrolled into view
    const bay = await until(cdp, `(() => { const w = document.querySelector('.term.mkt-window'); const b = w && w.querySelector('.mkt-cta-main'); if (!w || !b) return null;
      const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { title: ((w.querySelector('.term-title') || {}).textContent || '').trim(), cta: b.textContent.replace(/\\s+/g, ' ').trim(), onScreen: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1,
        clickable: !!hit && (hit === b || b.contains(hit)), intent: (typeof Marketplace !== 'undefined' && Marketplace.currentIntent) ? Marketplace.currentIntent() : null,
        second: ((w.querySelector('.mkt-deploy-cur') || {}).textContent || '').trim() }; })()`, 40);
    await shot(cdp, '4-recruit-bay');
    check('gh#117: CREW › RECRUIT opens the RECRUITMENT BAY', !!bay && /RECRUITMENT BAY/.test(bay.title), JSON.stringify(bay));
    check('gh#117: its intent is recruit', !!bay && bay.intent === 'recruit', JSON.stringify(bay));
    check('gh#117: its main key RECRUITS a new agent', !!bay && /^⏼ RECRUIT\b/.test(bay.cta), JSON.stringify(bay));
    check('gh#117: and that key is on screen and clickable where the bay opens (no scroll)', !!bay && bay.onScreen && bay.clickable, JSON.stringify(bay));
    await evalJS(cdp, `(() => { document.querySelectorAll('.term .term-x').forEach(b => { try { b.click(); } catch (_) {} }); return true; })()`);
    await sleep(600);
    await evalJS(cdp, `(() => { App.openRecipes(); return true; })()`);   // WORK › MY WORK › RECIPES (stationui FAMILIES)
    const work = await until(cdp, `(() => { const w = document.querySelector('.term.mkt-window'); return w ? { title: ((w.querySelector('.term-title') || {}).textContent || '').trim(), intent: (typeof Marketplace !== 'undefined' && Marketplace.currentIntent) ? Marketplace.currentIntent() : null } : null; })()`, 40);
    check('MY WORK’s door opens the same window as MY WORK (recipes intent)', !!work && /MY WORK/.test(work.title) && work.intent === 'recipes', JSON.stringify(work));

    const errs = (diagnostics.exceptions || []).filter(e => !/favicon|ERR_ABORTED|net::ERR/i.test(String(e)));
    check('no uncaught page exceptions', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) {
    check('the e2e ran to the end', false, (e && e.stack) || String(e));
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (_) {}
    await stopChild(chrome); await stopChild(sidecar);
    try { mock.server.close(); } catch (_) {}
    try { rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  if (failures.length) { console.log('comms-owner.e2e: ' + failures.length + ' FAILED'); process.exit(1); }
  console.log('comms-owner.e2e: ALL PASS');
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
