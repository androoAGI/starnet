/* node test/update-center-truth.test.js — the Update Center never says "no update" while the station knows of one.
   Reproduces the 0.13.1 → 0.13.2 report through the REAL updates.js in a vm: a launch finds the update (one toast),
   the app restarts inside the 6h interval, and the next launch must re-arm it at once — not show "No update is
   pending" until the interval runs out. Also locks: opening the window checks (unless AUTO-CHECK is off or this
   launch already checked), the idle copy only states what is known, and the dock carries a NEW chip while armed. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UpdateCore = require('../frontend/app/updatecore.js');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/updates.js'), 'utf8') + '\n;globalThis.__Updates = Updates;';
const tick = () => new Promise(r => setImmediate(r));

function launch(store, opts) {
  const o = opts || {};
  const checks = [];
  const toasts = [];
  const timers = new Map();
  let timerId = 0;
  const badge = { textContent: '', style: { display: 'none' } };
  // o.clock = { t } drives Date.now() inside updates.js, so a test can let 15 minutes or 6 hours pass.
  const clock = o.clock || null;
  const VmDate = clock ? class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  } : Date;
  let openBody = null;
  const invoke = async cmd => {
    if (cmd === 'starnet_update_status') return { desktop: true, currentVersion: o.current || '0.13.1', pending: o.pending || null };
    if (cmd === 'starnet_update_check') {
      // The native check stamps the same clock updates.js reads, so a controlled clock moves nextCheckAt too.
      const now = clock ? clock.t : Date.now();
      checks.push(now);
      if (o.error) throw new Error(o.error);
      const v = o.latest || '0.13.2';
      return v === (o.current || '0.13.1')
        ? { available: false, checkedAt: now }
        : { available: true, checkedAt: now, update: { version: v, body: '' } };
    }
    return {};
  };
  const context = {
    UpdateCore,
    window: { __TAURI__: { core: { invoke, Channel: class {} } }, open() {} },
    document: { getElementById: id => (id === 'up-badge' ? badge : null) },
    localStorage: {
      get length() { return store.size; }, key(i) { return Array.from(store.keys())[i] || null; },
      getItem(k) { return store.has(k) ? store.get(k) : null; }, setItem(k, v) { store.set(k, String(v)); }
    },
    console,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    Date: VmDate, JSON, Promise, Math, String, Number, Object, Array, RegExp, Error
  };
  require('./helpers/frontend-esc.js').installEsc(context);
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'updates.js' });
  const updates = context.__Updates;
  return {
    updates, checks, toasts, badge, timers,
    // rerender mirrors StationUI.rerender('updates'): an open Update Center re-renders through render().
    init: () => updates.init({ notify: msg => toasts.push(msg), rerender: () => { if (openBody) updates.render(openBody); } }),
    open() {
      // Buttons record their click handlers so a test can press them (body.click('#up-ignore')).
      const handlers = {};
      const body = {
        innerHTML: '',
        querySelector: sel => ({ addEventListener: (ev, fn) => { handlers[sel] = fn; } }),
        click: sel => handlers[sel] && handlers[sel]({ preventDefault() {}, target: {} })
      };
      openBody = body;
      updates.render(body);
      return body;
    }
  };
}

(async () => {
  // ---- the report: found, toast missed, restart → must re-arm immediately ----
  {
    const store = new Map();
    const first = launch(store);
    await first.init(); await tick();
    A.eq(first.checks.length, 1, 'a fresh install checks on startup');
    A.eq(first.updates.phase(), 'available', 'the first launch finds 0.13.2');
    A.eq(first.toasts.length, 1, 'one toast announces it');
    A.eq(first.badge.style.display, 'inline-block', 'the dock UPDATES item shows the NEW chip');
    A.eq(first.badge.textContent, 'NEW', 'the chip reads NEW');

    // restart an hour later — still inside the 6h interval that used to suppress the check
    const second = launch(store);
    await second.init(); await tick();
    A.eq(second.checks.length, 1, 'the relaunch checks at once because the last check found an update');
    A.eq(second.updates.phase(), 'available', 'the relaunch shows the update instead of "no update"');
    A.eq(second.toasts.length, 0, 'no second toast for the same version (the chip carries it now)');
    A.eq(second.badge.style.display, 'inline-block', 'the NEW chip is back after the restart');
  }

  // ---- after the update lands, the remembered version is the running one: no forced check, no chip ----
  {
    const store = new Map();
    const before = launch(store);
    await before.init(); await tick();
    const after = launch(store, { current: '0.13.2', latest: '0.13.2' });
    await after.init(); await tick();
    A.eq(after.checks.length, 0, 'the updated app does not re-check inside the interval');
    A.eq(after.badge.style.display, 'none', 'no NEW chip on the version that is already running');
    const body = after.open(); await tick();
    A.eq(after.checks.length, 1, 'opening the Update Center checks (no check yet this launch)');
    A.eq(after.updates.phase(), 'current', 'and proves the app is current');
    after.open(); await tick();
    A.eq(after.checks.length, 1, 'reopening right away reuses this launch\'s fresh answer');
    A.ok(!/No update is pending/.test(body.innerHTML), 'the old unconditional "No update is pending" claim is gone');
  }

  // ---- idle copy states only what is known; AUTO-CHECK off never checks on open ----
  {
    const store = new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: false, lastCheckAt: 0, nextCheckAt: 0 })]]);
    const off = launch(store);
    await off.init(); await tick();
    const body = off.open(); await tick();
    A.eq(off.checks.length, 0, 'AUTO-CHECK off: neither startup nor opening the window sends a request');
    A.eq(off.updates.phase(), 'idle', 'nothing was checked');
    A.ok(/Never checked for updates\./.test(body.innerHTML), 'the window says it has not checked, never "no update"');
    A.ok(!/since never/.test(body.innerHTML), 'never "Not checked since never." (review seams-08, tests-05)');
    A.ok(/NEVER CHECKED/.test(body.innerHTML), 'the status label does not claim READY');

    // a check ran on an earlier launch: the header and the body agree (review app-shell-ui-06)
    const dated = new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: false, lastCheckAt: 5 })]]);
    const d = launch(dated);
    await d.init(); await tick();
    const db = d.open(); await tick();
    A.eq(d.checks.length, 0, 'AUTO-CHECK off: still no request on open');
    A.ok(/NOT CHECKED THIS LAUNCH/.test(db.innerHTML) && !/NOT CHECKED YET/.test(db.innerHTML), 'the label never says "not checked yet" over a dated last check');
    A.ok(/Not checked since /.test(db.innerHTML) && !/since never/.test(db.innerHTML), 'the body names when the last check ran');

    // the last check found the version the Commander skipped: the idle window says it is skipped
    const skip = new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: false, availableVersion: '0.13.3', ignoredVersion: '0.13.3', lastCheckAt: 5 })]]);
    const sk = launch(skip);
    await sk.init(); await tick();
    const sb = sk.open(); await tick();
    A.ok(/v0\.13\.3 is skipped/.test(sb.innerHTML), 'a remembered skip is named after a relaunch');

    // SKIP 0.13.3 → CHECK NOW → INSTALL → relaunch on 0.13.3: the running version is never called skipped
    const landed = launch(new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: false, availableVersion: '0.13.3', ignoredVersion: '0.13.3', lastCheckAt: 5 })]]), { current: '0.13.3' });
    await landed.init(); await tick();
    const lb = landed.open(); await tick();
    A.ok(!/is skipped/.test(lb.innerHTML), 'the version already running is not called skipped');
    A.ok(/Not checked since /.test(lb.innerHTML), 'the body falls back to when the last check ran');

    // a newer build is running than the skipped one the last check found: that old skip is stale, not news
    const past = launch(new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: false, availableVersion: '0.13.3', ignoredVersion: '0.13.3', lastCheckAt: 5 })]]), { current: '0.13.10' });
    await past.init(); await tick();
    const pb = past.open(); await tick();
    A.ok(!/is skipped/.test(pb.innerHTML), 'a skipped version older than the running one is not named');

    const known = new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: false, availableVersion: '0.13.2', lastCheckAt: 5 })]]);
    const k = launch(known);
    await k.init(); await tick();
    const kb = k.open(); await tick();
    A.ok(/The last check found v0\.13\.2/.test(kb.innerHTML), 'a remembered update is named, with CHECK NOW to arm it');
  }

  // Failed native rearming must honor the retry deadline, including after restarting.
  {
    const store = new Map([['starnet.updates.v1', JSON.stringify({ autoCheck: true, availableVersion: '0.13.2', nextCheckAt: Date.now() + 3600000 })]]);
    const first = launch(store, { error: 'offline fixture' });
    await first.init(); await tick();
    A.eq(first.checks.length, 1, 'remembered update initially re-arms immediately');
    A.eq(first.updates.phase(), 'error', 'failed native rearming is visible');
    A.ok([...first.timers.values()].some(t => t.delay >= UpdateCore.RETRY_BASE_MS - 1000), 'automatic retry waits for the first backoff deadline');
    A.ok(![...first.timers.values()].some(t => t.delay === 1000), 'no one-second check loop remains');
    await first.updates.check(true, 'manual'); await tick();
    A.eq(first.checks.length, 2, 'manual CHECK NOW remains immediate during backoff');
    A.ok([...first.timers.values()].some(t => t.delay >= UpdateCore.RETRY_BASE_MS * 2 - 1000), 'second failure doubles the automatic retry deadline');
    const restarted = launch(store, { error: 'offline fixture' });
    await restarted.init(); await tick();
    A.eq(restarted.checks.length, 0, 'restart respects the stored failure deadline');
    A.ok([...restarted.timers.values()].some(t => t.delay >= UpdateCore.RETRY_BASE_MS * 2 - 1000), 'restart schedules the remaining backoff');
  }

  // ---- SKIP VERSION stays skipped: no open-check, 6 h check or webview reload re-arms it (review app-shell-ui-01) ----
  {
    const clock = { t: Date.now() };
    const store = new Map();
    const s = launch(store, { clock, current: '0.13.2', latest: '0.13.3' });
    await s.init(); await tick();
    A.eq(s.updates.phase(), 'available', 'the startup check finds 0.13.3');
    A.eq(s.badge.style.display, 'inline-block', 'the NEW chip is lit');

    clock.t += 20 * 60 * 1000;                       // twenty minutes later the Commander opens Update Center
    const body = s.open(); await tick();
    A.eq(s.checks.length, 1, 'an armed update is not re-checked on open');
    A.ok(/id="up-ignore"/.test(body.innerHTML), 'the card offers SKIP VERSION');
    body.click('#up-ignore'); await tick(); await tick();
    A.eq(s.updates.prefs().ignoredVersion, '0.13.3', 'SKIP VERSION records the skipped version');
    A.eq(s.updates.phase(), 'skipped', 'the window shows the version as skipped');
    A.eq(s.badge.style.display, 'none', 'the NEW chip goes out after SKIP VERSION');
    A.ok(!/id="up-ignore"|id="up-install"/.test(body.innerHTML), 'the INSTALL / SKIP card does not come back at once');
    A.ok(/v0\.13\.3 is skipped/.test(body.innerHTML), 'the window says which version is skipped');
    A.ok(!/You have the latest StarNet/.test(body.innerHTML), 'a skipped update is never shown as "latest"');
    A.ok(/UPDATE SKIPPED/.test(body.innerHTML), 'the status label says skipped, not up to date');

    clock.t += 20 * 60 * 1000;                       // a later open still may look for something newer...
    const beforeOpen = s.checks.length;
    s.open(); await tick(); await tick();
    A.eq(s.checks.length, beforeOpen + 1, 'a later open of a skipped window still checks for a newer release');
    A.eq(s.updates.phase(), 'skipped', '...but finding the skipped version again leaves it skipped');
    A.eq(s.badge.style.display, 'none', 'no NEW chip after a later open-check');

    clock.t += UpdateCore.CHECK_INTERVAL_MS + 1000;  // the 6 h automatic check
    await s.updates.check(false, 'due'); await tick();
    A.eq(s.updates.phase(), 'skipped', 'the 6 h check does not re-arm the skipped version');
    A.eq(s.badge.style.display, 'none', 'no NEW chip after the 6 h check');
    A.eq(s.toasts.filter(t => /ready in Update Center/.test(t)).length, 1, 'no new toast for the skipped version');

    await s.updates.check(true, 'manual'); await tick();
    A.eq(s.updates.phase(), 'available', 'CHECK NOW still shows the skipped version so it can be installed');

    // a webview reload keeps the native pending update in memory: refreshStatus must not re-arm a skipped one
    const reload = launch(store, { clock, current: '0.13.2', latest: '0.13.3', pending: { version: '0.13.3', body: '' } });
    await reload.init(); await tick();
    A.eq(reload.checks.length, 0, 'the reload does not re-check inside the interval (only refreshStatus decides)');
    A.eq(reload.badge.style.display, 'none', 'a reload with the skipped version pending does not light the NEW chip');
    A.eq(reload.updates.phase(), 'skipped', 'a reload with the skipped version pending stays skipped');

    // a NEWER release than the skipped one is armed as normal
    const newer = launch(store, { clock, current: '0.13.2', latest: '0.13.4' });
    await newer.init(); await newer.updates.check(false, 'due'); await tick();
    A.eq(newer.updates.phase(), 'available', 'a version newer than the skipped one is offered');
    A.eq(newer.badge.style.display, 'inline-block', 'and lights the NEW chip');
  }

  // ---- REMIND TOMORROW on a skipped version that CHECK NOW brought back: the reminder arrives (review app-shell-ui-01) ----
  {
    const clock = { t: Date.now() };
    const store = new Map();
    const s = launch(store, { clock, current: '0.13.2', latest: '0.13.3' });
    await s.init(); await tick();
    const body = s.open(); await tick();
    body.click('#up-ignore'); await tick();
    A.eq(s.updates.phase(), 'skipped', 'SKIP VERSION skips 0.13.3');
    await s.updates.check(true, 'manual'); await tick();
    A.eq(s.updates.phase(), 'available', 'CHECK NOW shows the skipped version again');
    A.ok(/id="up-remind"/.test(body.innerHTML), 'the card offers REMIND TOMORROW');
    body.click('#up-remind'); await tick();
    A.ok(s.toasts.includes('Update reminder moved to tomorrow'), 'REMIND TOMORROW promises a reminder');
    A.eq(s.updates.prefs().ignoredVersion, '', 'choosing a reminder cancels the skip of that version');

    const pending = [...s.timers.values()];
    A.eq(pending.length, 1, 'one automatic timer is scheduled');
    A.ok(pending[0] && pending[0].delay >= UpdateCore.REMIND_LATER_MS - 1000, 'the next automatic step waits for the reminder');
    const before = s.checks.length;
    const readyToasts = () => s.toasts.filter(t => /StarNet update v0\.13\.3 is ready in Update Center/.test(t)).length;
    const toastsBefore = readyToasts();
    clock.t += 25 * 60 * 60 * 1000;                  // the timer fires a day later
    if (pending[0]) pending[0].fn();
    await tick(); await tick();
    A.eq(s.checks.length, before + 1, 'the reminder runs an automatic check');
    A.eq(s.updates.phase(), 'available', 'the reminded version is offered again, not skipped');
    A.eq(s.badge.style.display, 'inline-block', 'the NEW chip is lit for the reminder');
    A.eq(readyToasts(), toastsBefore + 1, 'the reminder toast arrives');
  }

  A.report('update-center-truth');
})().catch(e => { console.error(e); process.exit(1); });
