/* node test/browser-view.test.js — THE STATION BROWSER (sidecar/browser-view.js): one built-in browser the Commander
   and the agents share. Fake browser sessions, injected clock. Proves:
     - what the Commander types becomes an http(s) address, a loopback address, a search, or a refusal;
     - an INTERACTIVE run drives the station browser (the same session the Commander opened, page intact), refs die
       and downloads re-point as it changes hands, and it STAYS OPEN when the run ends;
     - one driver at a time: while a run drives, the Commander's address/clicks/keys are refused; a second run and
       every unattended run get a private browser (null);
     - the picture streams to the window during and after a run, steps aside for a STEP-IN handoff without stopping
       its stream, survives a long-poll on a still page, and stops when nobody watches;
     - the profile lease is yielded to another run only when nobody is driving or watching; it closes when idle. */
'use strict';
const A = require('./_assert.js');
const { makeBrowserViews, resolveAddress } = require('../sidecar/browser-view.js');

function clock() {
  let t = 1000, seq = 0; const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    advance(ms) { t += ms; for (const [id, x] of Array.from(timers)) if (x.at <= t) { timers.delete(id); x.fn(); } }
  };
}
function fakeSession() {
  const s = { open: false, url: '', stops: 0, starts: 0, inputs: [], navs: [], closed: 0, handler: null, remembered: true, hands: [] };
  s.api = {
    handoffSurface() {
      if (!s.open) throw new Error('no browser page is open');
      return {
        startStream: fn => { s.starts++; s.handler = fn; fn({ data: 'frame-' + s.starts, mime: 'image/jpeg', width: 1440, height: 900 }); return Promise.resolve(true); },
        stopStream: () => { s.stops++; s.handler = null; return Promise.resolve(true); },
        input: ev => { s.inputs.push(ev); return Promise.resolve(true); },
        pageInfo: () => Promise.resolve({ url: s.url, title: 'T:' + s.url }),
        remembered: s.remembered
      };
    },
    handTo: async info => { s.hands.push(info); },
    waitForProfile: async () => {},
    tabs: async () => { s.warmed = (s.warmed || 0) + 1; s.open = true; return []; },
    navigate: async (url, opts) => { if (/blocked/.test(url)) throw new Error('refusing private address'); s.navs.push([url, !!(opts && opts.local)]); s.open = true; s.url = url; return url; },
    back: async () => { s.navs.push(['back']); },
    forward: async () => { s.navs.push(['forward']); },
    close: async () => { s.closed++; s.open = false; }
  };
  return s;
}
const tick = () => new Promise(r => setImmediate(r));
function rig(extra) {
  const clk = clock(); const made = []; const attended = { prompt: undefined }; const ho = { live: false };
  const views = makeBrowserViews(Object.assign({ now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, attended,
    handoffLive: () => ho.live, downloadDirFor: a => '/ws/' + a + '/downloads',
    makeStationSession: () => { const s = fakeSession(); made.push(s); return s.api; } }, extra || {}));
  return { clk, made, attended, ho, views };
}

(async () => {
  // ---- the address bar ----
  const R = resolveAddress;
  A.eq(R('github.com').url, 'https://github.com/', 'a bare host gets https');
  A.eq(R('https://example.com/a?b=1').url, 'https://example.com/a?b=1', 'a full address is kept');
  A.eq(R('http://example.com').url, 'http://example.com/', 'http is allowed');
  A.eq(R('localhost:3000').url, 'http://localhost:3000/', 'a dev server gets http');
  A.eq(R('localhost:3000').local, true, 'loopback is marked local');
  A.eq(R('127.0.0.1:8787/x').url, 'http://127.0.0.1:8787/x', 'a loopback ip with a port');
  A.eq(R('example.com:8080/x').url, 'https://example.com:8080/x', 'host:port is not mistaken for a scheme');
  A.eq(R('example.com').local, false, 'a public host is not local');
  A.ok(R('how to center a div').search && /duckduckgo\.com\/\?q=how%20to%20center%20a%20div$/.test(R('how to center a div').url), 'words become a search');
  A.ok(R('github').search, 'a single word is a search, not a broken address');
  A.eq(R('javascript:alert(1)').ok, false, 'javascript: is refused');
  A.eq(R('file:///c:/secret.txt').ok, false, 'file: is refused');
  A.eq(R('chrome://settings').ok, false, 'chrome: is refused');
  A.eq(R('   ').ok, false, 'an empty address is refused');
  A.eq(R('x'.repeat(2100)).ok, false, 'an absurd address is refused');

  // ---- ONE browser: the Commander opens a page, the agent sees THAT page, and it stays after the run ----
  {
    const { clk, made, attended, views } = rig();
    A.eq(views.list().station.open, false, 'no browser until somebody uses it');
    const o = await views.open('google.com');
    A.ok(o.ok && o.url === 'https://google.com/', 'the Commander opens a page');
    A.eq(o.remembered, true, 'on the durable profile: sign-ins are remembered (the session says so)');
    A.eq(views.list().station.open, true, 'the station browser is open');
    A.eq(views.list().station.driver, null, 'nobody is driving: it is the Commander\'s');

    const prompt = () => 'ask';
    const sess = views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true, loginPrompt: prompt });
    A.ok(!!sess, 'an interactive run is given the station browser');
    // a run that has not browsed yet is NOT the driver: the Commander keeps their browser
    A.eq(views.list().station.driver, null, 'a run that has not touched the browser is not "driving"');
    A.ok((await views.input({ type: 'text', text: 'still mine' })).ok, '…so the Commander can keep using it while the agent thinks');
    A.eq(made[0].hands.length, 0, 'and nothing has changed hands');
    made[0].inputs.length = 0;
    // its first real browser call takes the wheel
    const seen = await sess.handoffSurface().pageInfo();
    A.eq(views.list().station.driver, null, 'asking a passive question (where is the page?) does not take the wheel either');
    A.eq(seen.url, 'https://google.com/', 'THE page the Commander opened is what the agent browser has');
    await sess.back();
    A.eq(made.length, 1, 'no second browser was created: it is the same one');
    A.eq(made[0].navs[made[0].navs.length - 1][0], 'back', 'the agent call reached the shared browser');
    A.eq(made[0].hands.length, 1, 'taking the wheel kills the old refs (handTo)');
    A.eq(made[0].hands[0].downloadDir, '/ws/nova/downloads', '…and re-points downloads at the driving agent\'s jail');
    A.ok(attended.prompt === prompt, 'browser.login asks through the DRIVING run\'s consent channel');
    A.eq(views.list().station.driver.agentId, 'nova', 'the list says who is driving');

    // the Commander's hands are NEVER refused, even while an agent drives (Andrew 2026-10-02: "the whole point was for it
    // to be interactive inside of the window") — one AGENT driver at a time, but you can always click and type
    A.eq((await views.input({ type: 'text', text: 'x' })).ok, true, 'while the agent drives, the Commander can still type');
    A.eq(made[0].inputs.length, 1, '…and it reaches the page');
    const second = views.sessionForRun({ agentId: 'kira', runId: 'r2', interactive: true });
    let busyErr = ''; try { await second.navigate('https://example.org/'); } catch (e) { busyErr = e.message; }
    A.ok(/in use by another run/.test(busyErr), 'a second run cannot drive it while another is: it is told so');
    A.eq(made[0].url, 'https://google.com/', '…and the page did not move');
    A.eq(views.sessionForRun({ agentId: 'nova', runId: 'r3', interactive: false }), null, 'an unattended run never gets the station browser (it uses a private one)');
    A.eq((await views.close()).ok, false, 'it cannot be closed under a driving run');

    // the agent navigates; the Commander watches it live
    await sess.navigate('https://youtube.com/');
    const f1 = await views.frame('station', 0, 0);
    A.ok(f1.ok && f1.frame && f1.frame.seq === 1, 'the picture streams while the agent drives');
    A.eq(f1.page.url, 'https://youtube.com/', 'the address is where the agent took it');
    A.eq(f1.driver.agentId, 'nova', 'each picture says who is driving');

    // the run ends: the browser STAYS
    A.eq(views.releaseRun('r2'), false, 'a run that never drove it releases nothing');
    A.eq(views.releaseRun('r1'), true, 'the driving run releases it');
    A.eq(made[0].closed, 0, 'the browser is NOT closed when the run ends');
    A.eq(views.list().station.open, true, 'it is still open');
    A.eq(views.list().station.driver, null, 'and nobody is driving');
    A.eq(attended.prompt, undefined, 'the ended run\'s consent channel is gone');
    const f2 = await views.frame('station', 0, 0);
    A.ok(f2.ok && f2.page.url === 'https://youtube.com/', 'after the run the Commander still sees what the agent opened');
    A.eq(f2.driver, null, 'with nobody driving');

    // now the Commander drives it
    A.ok((await views.input({ type: 'text', text: 'hello' })).ok, 'the Commander types into the same page');
    A.eq(made[0].inputs[made[0].inputs.length - 1].text, 'hello', 'it reached the page');
    A.eq((await views.input({ type: 'nonsense' })).ok, false, 'an unknown input event is refused');
    await views.open('localhost:5173');
    A.eq(made[0].navs[made[0].navs.length - 1][1], true, 'a loopback address opens in local mode');
    A.ok((await views.nav('back')).ok && (await views.nav('forward')).ok && (await views.nav('reload')).ok, 'back, forward, reload');
    A.eq((await views.nav('explode')).ok, false, 'an unknown action is refused');
    A.eq((await views.open('javascript:alert(1)')).ok, false, 'a refused address never reaches the browser');

    // the next run takes it again: refs die again (the Commander changed the page)
    await views.sessionForRun({ agentId: 'kira', runId: 'r4', interactive: true }).forward();
    A.eq(made[0].hands.length, 2, 'every change of hands kills refs');
    A.eq(made[0].hands[1].downloadDir, '/ws/kira/downloads', 'downloads follow the agent now driving');
    views.releaseRun('r4');
    void clk;
  }

  // ---- an agent uses the browser first (nothing open): the run creates it, and it stays for the Commander ----
  {
    const { made, views } = rig();
    const sess = views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true });
    A.eq(views.list().station.open, false, 'not "open" until the agent actually opens a page (truth, not intent)');
    await sess.navigate('https://youtube.com/');
    A.eq(made.length, 1, 'the first browser call of the agent opens the station browser');
    A.eq(views.list().station.open, true, 'open once it has a page');
    A.eq(views.list().station.driver.agentId, 'nova', 'and the agent is driving');
    views.releaseRun('r1');
    const f = await views.frame('station', 0, 0);
    A.ok(f.ok && f.page.url === 'https://youtube.com/', 'the Commander opens the window after the run and YouTube is there');
  }

  // ---- a SECOND run while one drives: it browses in its own private browser instead of failing (release review) ----
  {
    const { made, views } = rig();
    const first = views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true });
    await first.navigate('https://first.example/');
    const priv = fakeSession(); let privMade = 0;
    const second = views.sessionForRun({ agentId: 'kira', runId: 'r2', interactive: true, makePrivate: () => { privMade++; return priv.api; } });
    const went = await second.navigate('https://second.example/');
    A.eq(went, 'https://second.example/', 'the second run browses (no "in use" error)');
    A.eq(privMade, 1, '…in a private browser made for it');
    A.eq(made[0].url, 'https://first.example/', 'the shared browser was not touched');
    A.eq(views.list().station.driver.runId, 'r1', 'the first run still drives the shared browser');
    A.ok(views.list().agents.some(a => a.runId === 'r2'), 'the Commander can watch the second run\'s private browser');
    await second.navigate('https://second.example/two');
    A.eq(privMade, 1, 'one run, one browser: it stays private for the rest of the run');
    views.releaseRun('r2');
    await tick(); await tick();
    A.eq(priv.closed, 1, 'its private browser closes when the run ends');
    A.ok(!views.list().agents.some(a => a.runId === 'r2'), '…and is no longer listed');
    A.eq(views.list().station.driver.runId, 'r1', 'the first run is unaffected');
    views.releaseRun('r1');
  }

  // ---- PRIVACY: when the run lets go, the Commander's own downloads go to THEIR folder, not the agent's ----
  {
    const { made, views } = rig({ commanderDownloadDir: () => '/home/me/Downloads' });
    const sess = views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true });
    await sess.navigate('https://example.com/');
    A.eq(made[0].hands[made[0].hands.length - 1].downloadDir, '/ws/nova/downloads', 'while nova drives, downloads land in nova\'s folder');
    views.releaseRun('r1');
    await tick(); await tick();
    A.eq(made[0].hands[made[0].hands.length - 1].downloadDir, '/home/me/Downloads', 'after the run, the Commander\'s downloads go to their own Downloads folder');
  }

  // ---- STOP mid-tool: a late tool call of an ENDED run never takes the wheel back (release review, reproduced) ----
  {
    const { views } = rig();
    const sess = views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true });
    await sess.navigate('https://slow.example/');
    views.releaseRun('r1');   // the run's finally ran (STOP / tool timeout) while the tool was still in flight
    let late = ''; try { await sess.navigate('https://after-stop.example/'); } catch (e) { late = e.message; }
    A.ok(/run has ended/.test(late), 'the ended run\'s late driving call is refused');
    A.eq(views.list().station.driver, null, 'nobody is shown driving');
    const typed = await views.input({ type: 'text', text: 'hi' });
    A.eq(typed && typed.ok, true, 'the Commander can still type in the browser');
    const next = views.sessionForRun({ agentId: 'iris', runId: 'r2', interactive: true });
    await next.navigate('https://next.example/');
    A.eq(views.list().station.driver.runId, 'r2', 'and the next run can drive it');
    views.releaseRun('r2');
  }

  // ---- STEP-IN, streaming and idleness ----
  {
    const { clk, made, ho, views } = rig();
    await views.open('example.com');
    await views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true }).forward();
    A.ok((await views.frame('station', 0, 0)).ok, 'watching');
    const stops = made[0].stops;
    ho.live = true;
    A.eq((await views.frame('station', 1, 0)).code, 'handoff', 'a live handoff → the view refuses, naming STEP-IN');
    A.eq(made[0].stops, stops, '…without stopping the handoff\'s stream');
    A.eq(views.list().station.handoff, true, 'the list says the agent is waiting in STEP-IN');
    ho.live = false;
    A.ok((await views.frame('station', 0, 0)).ok, 'after the handoff the picture comes back');
    // a long-poll on a still page IS somebody watching
    const stopsNow = made[0].stops;
    const pending = views.frame('station', 99, 12000);
    await tick();
    clk.advance(7000);
    A.eq(made[0].stops, stopsNow, 'a still page being long-polled keeps its stream');
    clk.advance(6000);
    const late = await pending;
    A.ok(late.ok && late.frame === null, '…and the poll ends empty-handed, not with "closed"');
    clk.advance(7000);
    A.eq(made[0].stops, stopsNow + 1, 'an unwatched stream stops itself');
    // idle: never while a run drives
    clk.advance(11 * 60 * 1000); await tick();
    A.eq(made[0].closed, 0, 'a driven browser never idles out');
    views.releaseRun('r1');
    clk.advance(30 * 60 * 1000 + 1); await tick();
    A.eq(made[0].closed, 1, 'half an hour with nobody driving or watching → it closes');
    A.eq(views.list().station.open, false, 'and is no longer open');
    A.eq((await views.frame('station', 0, 0)).code, 'closed', 'no picture after it closed');
  }

  // ---- the idle clock reads who drives when it runs out: a run that takes the wheel (and a sign-in) inside the idle window keeps
  //      its STEP-IN picture (the clock remembered the empty seat from the last poll, and stopped the browser's one stream) ----
  {
    const { clk, made, ho, views } = rig();
    await views.open('example.com');
    A.ok((await views.frame('station', 0, 0)).ok, 'the Commander watches with nobody driving, then closes the window');
    await views.sessionForRun({ agentId: 'nova', runId: 'r7', interactive: true }).forward();
    ho.live = true;   // the run hits a sign-in: STEP-IN streams this same browser
    const stops = made[0].stops;
    clk.advance(7000); await tick();
    A.eq(made[0].stops, stops, 'the idle clock leaves the STEP-IN picture running');
    ho.live = false; views.releaseRun('r7');
  }

  // ---- it NEVER closes under the Commander: only after half an hour with nobody driving or watching ----
  {
    const { clk, made, views } = rig();
    await views.open('example.com');
    await views.frame('station', 0, 0);
    clk.advance(29 * 60 * 1000); await tick();
    A.eq(made[0].closed, 0, 'still open after 29 idle minutes');
    await views.frame('station', 0, 0);   // somebody looks at it: the half hour starts again
    clk.advance(29 * 60 * 1000); await tick();
    A.eq(made[0].closed, 0, 'looking at it keeps it open');
    A.eq(typeof views.yieldProfile, 'undefined', 'there is no path that closes it for another run');
    clk.advance(60 * 1000 + 1); await tick();
    A.eq(made[0].closed, 1, 'half an hour with nobody driving or watching → it closes');
  }

  // ---- a navigation the browser refuses on a fresh session leaves nothing open ----
  {
    const { made, views } = rig();
    const refused = await views.open('https://blocked.example/');
    A.ok(!refused.ok && /private address/.test(refused.error), 'the browser\'s own refusal is reported in its words');
    A.eq(made[0].closed, 1, '…and the blank session is closed, not left holding the profile');
  }

  // ---- a PRIVATE per-run browser (unattended, or the station one was busy) can still be watched ----
  {
    const { views, ho } = rig();
    const run = fakeSession();
    views.registerRun({ agentId: 'kira', runId: 'p1', session: run.api });
    A.eq(views.list().agents.length, 0, 'a private run with no page open is NOT listed');
    run.open = true; run.url = 'https://example.com/';
    A.eq(views.list().agents[0].target, 'run:p1', 'once it has a page it is listed');
    A.ok((await views.frame('run:p1', 0, 0)).ok, 'its picture streams');
    ho.live = true;
    A.eq((await views.frame('run:p1', 1, 0)).code, 'handoff', 'a handoff on it → STEP-IN');
    ho.live = false;
    const stops = run.stops;
    views.unregisterRun('p1');
    A.eq(run.stops, stops, 'an ending run is forgotten WITHOUT reaching into its closing browser');
    A.eq((await views.frame('run:p1', 0, 0)).code, 'ended', 'an ended run has no picture');
    A.eq(run.inputs.length, 0, 'a private run\'s browser never received Commander input');
  }

  // ---- WARM: opening the window starts the browser in the background, once ----
  {
    const { made, views } = rig();
    const w1 = views.warm();
    A.ok(w1.ok && w1.warming, 'opening the window starts the station browser in the background');
    views.warm();
    await tick();
    A.eq(made.length, 1, 'one browser');
    A.eq(made[0].warmed, 1, 'started once, however often the window is opened');
    A.eq(made[0].navs.length, 0, 'nothing is navigated by warming');
    A.ok(views.warm().open, 'once started, warm says it is open');
    await views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true }).forward();
    A.ok(views.warm().ok && made[0].warmed === 1, 'a browser a run is driving is left alone');
  }

  // ---- Settings → Browser: where it runs ----
  {
    let saved = null; const modesMade = []; const made = [];
    const clk = clock();
    const views = makeBrowserViews({ now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
      readMode: () => saved || 'window', writeMode: m => { saved = m; }, chromeAvailable: () => false,
      makeStationSession: mode => { modesMade.push(mode); const x = fakeSession(); made.push(x); return x.api; } });
    A.eq(views.settings().mode, 'window', 'the default is a CHROME WINDOW (what Hermes does)');
    const r0 = await views.setMode('builtin');
    A.ok(r0.ok && saved === 'builtin', 'switching to BUILT-IN is saved');
    await views.open('example.com');
    A.eq(modesMade[0], 'builtin', 'the station browser is created in the chosen mode');
    A.eq(views.list().station.mode, 'builtin', 'and the list says which mode is running');
    const r1 = await views.setMode('window');
    A.ok(r1.ok && r1.applied && saved === 'window', 'switching to CHROME WINDOW is saved and applied');
    A.eq(made[0].closed, 1, 'the idle browser is restarted (closed now; the next use starts it in the new mode)');
    await views.open('example.com');
    A.eq(modesMade[1], 'window', 'the next start is a Chrome window');
    // a driving run is never pulled out from under
    await views.sessionForRun({ agentId: 'nova', runId: 'r1', interactive: true }).forward();
    const r2 = await views.setMode('builtin');
    A.ok(r2.ok && r2.applied === false, 'while an agent drives, the switch waits');
    A.eq(made[1].closed, 0, 'the driven browser is NOT closed');
    views.releaseRun('r1');
    await tick();
    A.eq(made[1].closed, 1, 'it switches when that run lets go');
    // QA 2026-10-02: switched away and BACK while an agent drives — nothing is pending, the browser stays open
    await views.open('example.com');
    const live = made[made.length - 1];
    await views.sessionForRun({ agentId: 'nova', runId: 'r9', interactive: true }).forward();
    A.eq((await views.setMode('window')).applied, false, 'a switch away waits for the driving run');
    A.eq((await views.setMode('builtin')).applied, true, 'switching back means nothing is pending');
    views.releaseRun('r9');
    await tick();
    A.eq(live.closed, 0, 'so the browser is NOT closed when the run lets go');
    // YOUR CHROME without the extension: honest fallback
    const r3 = await views.setMode('chrome');
    A.ok(r3.ok && r3.mode === 'chrome' && r3.effective === 'window' && r3.chromeAvailable === false, 'YOUR CHROME is saved, but runs as a Chrome window until the extension is paired — and says so');
    await views.open('example.com');
    A.eq(modesMade[modesMade.length - 1], 'window', '…the browser that starts is a Chrome window');
    A.eq((await views.setMode('nonsense')).ok, false, 'an unknown mode is refused');
    A.eq(saved, 'chrome', '…and nothing was saved');
  }

  // ---- no window can open here (no screen / no installed Chromium / headless pin): built-in, and it says so ----
  {
    const modesMade = [];
    const clk = clock();
    const views = makeBrowserViews({ now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
      readMode: () => 'window', windowAvailable: () => false,
      makeStationSession: mode => { modesMade.push(mode); return fakeSession().api; } });
    const s = views.settings();
    A.ok(s.mode === 'window' && s.effective === 'builtin' && s.windowAvailable === false, 'the default asks for a window, runs built-in, and says why');
    await views.open('example.com');
    A.eq(modesMade[0], 'builtin', 'the browser that starts is built-in');
    const views2 = makeBrowserViews({ now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
      readMode: () => 'chrome', windowAvailable: () => false, makeStationSession: () => fakeSession().api });
    A.eq(views2.settings().effective, 'builtin', 'YOUR CHROME with no extension and no window → built-in');
  }

  // ---- a station with no browser of its own ----
  {
    const clk = clock();
    const views = makeBrowserViews({ now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
    A.eq((await views.open('example.com')).ok, false, 'no session factory → an honest refusal');
    A.eq(views.list().station.available, false, 'and the list says it is unavailable');
    A.eq(views.sessionForRun({ agentId: 'a', runId: 'r', interactive: true }), null, 'runs fall back to private browsers');
    let threw = false; try { makeBrowserViews({}); } catch (_) { threw = true; }
    A.ok(threw, 'the clock must be injected');
  }

  // ---- #61 RESET STATION BROWSER: close ours, sweep orphans, report the truth; refused while an agent drives ----
  {
    let sweeps = 0, sweepResult = { ok: true, found: 1, killed: [300], survivors: [], ours: [], locks: { removed: ['lockfile'], failed: [] }, error: null };
    const { made, views } = rig({ sweepStationProfile: async () => { sweeps++; return sweepResult; } });
    await views.open('example.com');
    const r = await views.reset();
    A.ok(r.ok && r.closed, 'reset closes the station browser and reports ok');
    A.eq(made[0].closed, 1, 'the station session really closed');
    A.eq(sweeps, 1, 'and the durable profile was swept for orphans');
    A.eq(r.sweep.killed, [300], 'the receipt carries the sweep verdict');
    sweepResult = { ok: false, found: 1, killed: [], survivors: [300], ours: [], locks: { removed: [], failed: [] }, error: null };
    const r2 = await views.reset();
    A.ok(!r2.ok && /still running/.test(r2.error), 'a surviving orphan is NOT reported as a successful reset');
    const view = views.sessionForRun({ agentId: 'a1', runId: 'run-1', interactive: true });
    await view.navigate('https://example.com/');
    const before = sweeps;
    const r3 = await views.reset();
    A.ok(!r3.ok && r3.driving && r3.driving.runId === 'run-1' && /stop that run/.test(r3.error), 'refused while an agent drives (names the run)');
    A.eq(sweeps, before, 'and nothing was swept or closed');
    views.releaseRun('run-1');
  }

  A.report('browser-view.test');
})().catch(e => { console.log('FAIL: browser-view.test threw - ' + (e && e.stack || e)); process.exit(1); });
