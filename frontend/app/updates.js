/* STARNET updates.js
   Desktop Update Center: autonomous check loop + native Tauri updater bridge. */
'use strict';

const Updates = (() => {
  const KEY = 'starnet.updates.v1';
  // Human-browsable releases page — the GUARANTEED manual-update fallback when the in-app
  // updater can't complete (Gatekeeper on an unsigned mac build, a network/permission/disk
  // failure, an unsupported install layout). Reinstalling the latest build over the top keeps
  // ALL user data (workspaces live in Application Support; localStorage/IndexedDB in the WebView
  // store keyed by the unchanged bundle id — both OUTSIDE the app bundle the installer replaces).
  // Kept in sync with tauri.conf.json plugins.updater.endpoints[0] (same repo, /releases/latest).
  const RELEASES_PAGE = 'https://github.com/androoAGI/starnet-releases/releases/latest';
  const CORE = (typeof UpdateCore !== 'undefined') ? UpdateCore : null;
  const TAURI = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  const invoke = (cmd, args) => TAURI.invoke(cmd, args || {});
  const esc = s => (typeof U !== 'undefined' && U.esc) ? U.esc(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let prefs = loadPrefs();
  let notify = () => {};
  let rerender = () => {};
  let timer = 0;
  let busy = false;
  // True once an update install has COMMITTED (past the GB-4 guard, invoke fired). On macOS/Linux
  // the install ends with app.restart(), which can emit a window close-requested event — the GB-4
  // quit guard (quitguard.js) MUST NOT block that close, or the files swap but the app never
  // relaunches (stuck update). Windows can't hit this: its updater process::exit()s before restart.
  // Set right before the install invoke; only cleared if the install throws (app still alive).
  let installing = false;
  let state = {
    desktop: !!TAURI,
    phase: TAURI ? 'idle' : 'unsupported',
    currentVersion: '',
    target: '',
    update: null,
    error: '',
    downloaded: 0,
    contentLength: 0,
    preparationReceipt: null,
    lastCheckedAt: prefs.lastCheckAt || 0,
    confirmRuns: 0
  };

  function loadPrefs() {
    if (!CORE) return { v: 1, autoCheck: false, lastCheckAt: 0, nextCheckAt: 0, remindAfter: 0, ignoredVersion: '', notifiedVersion: '', failureCount: 0 };
    try { return CORE.hydrateSettings(JSON.parse(localStorage.getItem(KEY))); }
    catch (_) { return CORE.hydrateSettings(null); }
  }
  function savePrefs() {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }
  function cleanError(e) {
    const text = (e && (e.message || e.toString && e.toString())) || String(e || 'unknown error');
    return text.replace(/^Error:\s*/, '').trim();
  }
  function fmtTime(ts) {
    if (!ts) return 'never';
    try { return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return 'recently'; }
  }
  function shortNotes(text) {
    text = String(text || '').trim();
    if (!text) return '';
    if (text.length > 520) text = text.slice(0, 520).trim() + '...';
    return text;
  }
  function snapshot() {
    return Object.assign({}, state, { prefs: Object.assign({}, prefs) });
  }
  function emit() {
    try { rerender('updates'); } catch (_) {}
  }

  async function init(opts) {
    opts = opts || {};
    notify = typeof opts.notify === 'function' ? opts.notify : notify;
    rerender = typeof opts.rerender === 'function' ? opts.rerender : rerender;
    await refreshStatus();
    runLoop('startup');
  }

  async function refreshStatus() {
    if (!TAURI || !CORE) {
      state.desktop = false;
      state.phase = 'unsupported';
      emit();
      return snapshot();
    }
    try {
      const r = await invoke('starnet_update_status');
      state.desktop = !!r.desktop;
      state.currentVersion = r.currentVersion || '';
      state.target = r.target || '';
      if (r.pending) {
        state.update = r.pending;
        state.phase = 'available';
      } else if (state.phase === 'idle') {
        state.phase = 'idle';
      }
      state.error = '';
    } catch (e) {
      state.phase = 'unsupported';
      state.error = cleanError(e);
    }
    emit();
    return snapshot();
  }

  function schedule() {
    clearTimeout(timer);
    if (!CORE) return;
    const now = Date.now();
    const action = CORE.nextAction({
      settings: prefs,
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update },
      now
    });
    if (action.action === 'check') {
      timer = setTimeout(() => runLoop('due'), 1000);
      return;
    }
    const nextAt = action.nextAt || (now + 60 * 60 * 1000);
    timer = setTimeout(() => runLoop(action.reason), Math.max(15000, nextAt - now));
  }

  function runLoop(reason) {
    if (!CORE) return;
    const action = CORE.nextAction({
      settings: prefs,
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update },
      now: Date.now()
    });
    if (action.action === 'check') {
      check(false, reason);
    } else {
      schedule();
    }
  }

  async function check(manual, reason) {
    if (!TAURI || !CORE || busy) return snapshot();
    busy = true;
    state.phase = 'checking';
    state.error = '';
    state.confirmRuns = 0;
    emit();
    try {
      const r = await invoke('starnet_update_check');
      prefs = CORE.recordCheckResult(prefs, r, Date.now());
      state.lastCheckedAt = r.checkedAt || Date.now();
      if (r.available && r.update) {
        state.update = r.update;
        state.phase = 'available';
        if (CORE.shouldNotify(prefs, r.update.version, Date.now(), !!r.update.critical)) {
          notify((r.update.critical ? 'Critical update' : 'StarNet update') + ' v' + r.update.version + ' is ready in Update Center', r.update.critical ? 'warn' : 'gold');
          prefs = CORE.recordNotified(prefs, r.update.version);
        }
      } else {
        state.update = null;
        state.phase = 'current';
        if (manual) notify('StarNet is up to date', 'good');
      }
      savePrefs();
    } catch (e) {
      state.phase = 'error';
      state.error = cleanError(e);
      prefs = CORE.recordCheckError(prefs, Date.now());
      savePrefs();
      if (manual) notify('Update check failed - ' + state.error, 'warn');
    } finally {
      busy = false;
      schedule();
      emit();
    }
    return snapshot();
  }

  // Bound any promise so a hung sidecar cannot stall the update. Timeout/throw returns an explicit failure
  // marker; the installer never starts unless both final browser-owned writes are confirmed.
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve().then(() => promise).catch(() => fallback),
      new Promise(resolve => { try { setTimeout(() => resolve(fallback), ms); } catch (_) { resolve(fallback); } })
    ]);
  }

  // Flush the durable mirror + push the roster before the mutation barrier, each time-boxed and fail-closed.
  async function preInstallDrain(ms) {
    const budget = Math.max(250, +ms || 3000);
    const failed = { ok: false, timeout: true };
    // flushForUpdate distinguishes "nothing pending" from "pending write failed"; only the latter blocks.
    const save = (typeof CloudSave !== 'undefined' && CloudSave && typeof CloudSave.flushForUpdate === 'function')
      ? await withTimeout(CloudSave.flushForUpdate(), budget, failed) : failed;
    // App.pushRoster() returns true only after the sidecar accepts and parses the full roster replacement.
    const roster = (typeof App !== 'undefined' && App && typeof App.pushRoster === 'function')
      ? await withTimeout(App.pushRoster(), budget, false) : false;
    return { ok: !!(save && save.ok === true && roster === true), save, roster: roster === true };
  }

  function browserStoreSnapshot() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!/^(?:starnet|skynet)\./i.test(String(key || ''))) continue;
        const value = localStorage.getItem(key);
        if (value != null) out[key] = String(value);
      }
    } catch (_) {}
    return out;
  }

  async function prepareUpdate(force) {
    const r = await fetch('/api/update/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetVersion: state.update && state.update.version || '', force: force === true, browserStore: browserStoreSnapshot() })
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok || !body || body.ok !== true || !body.receipt) {
      throw new Error((body && (body.error || body.code)) || ('update preparation HTTP ' + r.status));
    }
    state.preparationReceipt = body.receipt;
    return body.receipt;
  }

  /* THE THAW IS THE ONLY WAY OUT, SO ITS OUTCOME MATTERS. /api/update/prepare sets an in-memory
     `updateWritesFrozen` on the sidecar and NOTHING clears it but this route — no TTL, no expiry.
     Verified against a live sidecar: after prepare, /api/activity answered 423
     UPDATE_MUTATIONS_FROZEN at 1s, 3s and 6s idle, and /api/update/status still reported
     frozen:true. So a swallowed failure here leaves the station refusing every durable write —
     saves, transcripts, ledgers — for the rest of the process's life.
     This used to be `.catch(() => null)` with the caller clearing its state unconditionally, which
     is the worst pairing: the one failure the Commander MUST hear about was the one we discarded.
     Worse, the two failures are CORRELATED — a sidecar sick enough to fail the install is exactly
     the one that will fail the thaw. So retry a little, then report honestly.
     A non-2xx or a thrown fetch is the real signal; the body is only consulted to catch a 200 that
     still admits frozen:true (the live route answers frozen:false on success).
     Retries are immediate and deliberately un-delayed: awaiting a timer here would deadlock anywhere
     setTimeout is stubbed to a no-op (the gate's own sandbox does exactly that, so it can drive the
     poll loop at lines 119/123 without recursing), and a hang on the thaw path would be strictly
     worse than the missed backoff. */
  async function cancelPreparation() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch('/api/update/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let body = null; try { body = await r.json(); } catch (_) {}
        if (r && r.ok && !(body && body.frozen === true)) return { thawed: true };
      } catch (_) { /* fall through to the next attempt */ }
    }
    return { thawed: false };
  }

  // Count of sidecar-CONFIRMED live runs (Channels.busy flips on real agent.run.start/end,
  // never on hope) — the truthful input to the GB-4 install guard. 0 when Channels is absent
  // (browser preview), which is also the only context where installing is impossible anyway.
  function liveRunCount() {
    try {
      return (typeof Channels !== 'undefined' && Channels && typeof Channels.busyCount === 'function')
        ? Channels.busyCount() : 0;
    } catch (_) { return 0; }
  }

  async function install(opts) {
    opts = opts || {};
    if (!TAURI || !CORE || busy || !state.update) {
      notify('No StarNet update is ready to install', 'warn');
      return snapshot();
    }
    const Channel = TAURI.Channel;
    if (!Channel) {
      notify('Update progress channel is unavailable in this build', 'warn');
      return snapshot();
    }
    // GB-4: the installer restarts (NSIS: kills) the app, terminating every live provider
    // stream mid-run. Never do that as a click side effect — pause and make it an explicit
    // choice. `force` is set only by the INSTALL ANYWAY button on the guard card.
    const running = liveRunCount();
    const blockReason = CORE.installBlockReason ? CORE.installBlockReason(running, !!opts.force) : null;
    if (blockReason) {
      state.confirmRuns = running;
      notify('Update paused - ' + blockReason, 'warn');
      emit();
      return snapshot();
    }
    state.confirmRuns = 0;
    busy = true;
    state.phase = 'preparing';
    state.downloaded = 0;
    state.contentLength = 0;
    state.error = '';
    const onEvent = new Channel(event => handleInstallEvent(event));
    emit();
    // The installer can kill this process. First prove the newest save + roster landed, then ask the sidecar to
    // freeze every mutation, wait for quiescence, snapshot workspace + browser state, read it back, and issue a
    // durable receipt. Any failed proof leaves the current version running and writable.
    const drained = await preInstallDrain();
    if (!drained.ok) {
      state.phase = 'available';
      state.error = 'State could not be verified on disk. The update was not installed; your current StarNet remains open.';
      busy = false;
      notify('Update paused - state verification failed', 'warn');
      emit();
      return snapshot();
    }
    try {
      await prepareUpdate(!!opts.force);
    } catch (e) {
      state.phase = 'available';
      state.error = 'Pre-update recovery point failed - ' + cleanError(e);
      busy = false;
      notify('Update paused - no verified recovery point was created', 'warn');
      emit();
      return snapshot();
    }
    state.phase = 'downloading';
    emit();
    installing = true;   // from here a close-requested is the update restart — quit guard must allow it
    try {
      await invoke('starnet_update_install', { onEvent });
      state.phase = 'restarting';
      notify('StarNet update installed - restarting', 'good');
    } catch (e) {
      installing = false;   // install failed; the app lives on, so the quit guard resumes normally
      const cancel = await cancelPreparation();
      state.preparationReceipt = null;
      state.phase = 'available';
      state.error = cleanError(e);
      /* A FAILED THAW IS NOT A FOOTNOTE. Clearing the receipt above says "we are out of the update"
         — true of this page, not of the sidecar, which stays frozen until someone thaws it or
         restarts it. Saying only "install failed" there sends the Commander back to a station that
         will refuse every durable write in silence. Name it, and name the one remedy that works. */
      if (!cancel.thawed) {
        state.error = state.error + ' — and the station is still frozen for update';
        notify('Update install failed AND the station is still frozen — saves, transcripts and ledgers will fail until you restart StarNet', 'bad');
      } else {
        notify('Update install failed - ' + state.error, 'warn');
      }
    } finally {
      busy = false;
      emit();
    }
    return snapshot();
  }

  function handleInstallEvent(event) {
    if (!event || !event.event) return;
    if (event.event === 'Started') {
      state.phase = 'downloading';
      state.contentLength = +(event.data && event.data.contentLength) || 0;
      state.downloaded = 0;
    } else if (event.event === 'Progress') {
      state.phase = 'downloading';
      state.downloaded += +(event.data && event.data.chunkLength) || 0;
    } else if (event.event === 'Finished') {
      state.phase = 'installing';
    } else if (event.event === 'Installing') {
      state.phase = 'restarting';
    }
    emit();
  }

  function setAutoCheck(on) {
    prefs = CORE.setAutoCheck(prefs, !!on, Date.now());
    savePrefs();
    schedule();
    emit();
  }
  function remindLater() {
    if (!state.update) return;
    prefs = CORE.remindLater(prefs, state.update.version, Date.now());
    savePrefs();
    notify('Update reminder moved to tomorrow', '');
    schedule();
    emit();
  }
  function ignoreVersion() {
    if (!state.update) return;
    prefs = CORE.ignoreVersion(prefs, state.update.version);
    savePrefs();
    state.update = null;
    state.phase = 'idle';
    notify('StarNet v' + prefs.ignoredVersion + ' will be skipped', 'warn');
    schedule();
    emit();
  }

  function phaseLabel() {
    if (state.phase === 'unsupported') return 'desktop updater unavailable';
    if (state.phase === 'checking') return 'checking for updates';
    if (state.phase === 'preparing') return 'verifying state and creating recovery point';
    if (state.phase === 'available') return 'update ready';
    if (state.phase === 'downloading') return 'downloading update';
    if (state.phase === 'installing') return 'preparing installer';
    if (state.phase === 'restarting') return 'restarting';
    if (state.phase === 'current') return 'up to date';
    if (state.phase === 'error') return 'check failed';
    return 'ready';
  }

  function settingsHtml() {
    const auto = prefs.autoCheck !== false;
    return '<h4 class="ms-h">UPDATES</h4>' +
      '<div class="up-mini">' +
      '<div><b>' + esc(phaseLabel().toUpperCase()) + '</b><span>current v' + esc(state.currentVersion || 'unknown') + ' - last check ' + esc(fmtTime(state.lastCheckedAt)) + '</span></div>' +
      '<button class="bb sm" id="set-updates-open">UPDATE CENTER</button>' +
      '</div>' +
      '<label class="set-row"><input type="checkbox" id="set-updates-auto" ' + (auto ? 'checked' : '') + '> AUTO-CHECK FOR UPDATES</label>';
  }

  function wireSettings(body) {
    const auto = body.querySelector('#set-updates-auto');
    if (auto) auto.addEventListener('change', ev => setAutoCheck(ev.target.checked));
    const open = body.querySelector('#set-updates-open');
    if (open && typeof StationUI !== 'undefined' && StationUI.toggleTerm) {
      // no per-window width: UPDATE CENTER is the default PANEL shell, same as its BUILDERS entry
      // (two window sizes only — see the note in frontend/css/style.css).
      open.addEventListener('click', () => StationUI.toggleTerm('updates', 'UPDATE CENTER', render, {}));
    }
  }

  function render(body) {
    body.innerHTML = html();
    wire(body);
  }

  function html() {
    if (!TAURI) {
      return '<div class="fb-empty">DESKTOP UPDATES ARE AVAILABLE IN THE PACKAGED STARNET APP.<br><span>This browser preview cannot install native releases.</span></div>';
    }
    const update = state.update;
    const pct = CORE.progress(state.downloaded, state.contentLength);
    const notes = update ? shortNotes(update.body) : '';
    const auto = prefs.autoCheck !== false;
    let out = '<div class="up-center">' +
      '<div class="up-head"><div><b>' + esc(phaseLabel().toUpperCase()) + '</b><span>current v' + esc(state.currentVersion || 'unknown') + (state.target ? ' - ' + esc(state.target) : '') + '</span></div>' +
      '<button class="bb sm" id="up-check" ' + (busy ? 'disabled' : '') + '>CHECK NOW</button></div>' +
      '<label class="set-row up-auto"><input type="checkbox" id="up-auto" ' + (auto ? 'checked' : '') + '> CHECK AUTOMATICALLY</label>';
    if (update) {
      const guardN = state.confirmRuns | 0;
      out += '<div class="up-card ' + (update.critical ? 'critical' : '') + '">' +
        '<div class="up-version"><span>AVAILABLE</span><b>v' + esc(update.version) + '</b></div>' +
        (update.date ? '<div class="up-meta">published ' + esc(update.date) + '</div>' : '') +
        (notes ? '<pre class="up-notes">' + esc(notes) + '</pre>' : '<div class="up-meta">No release notes were provided.</div>');
      if (guardN > 0) {
        // GB-4 guard card: install was clicked while agents are live. The count is
        // Channels-confirmed, and the choice is the Commander's, not a side effect.
        out += '<div class="up-guard">' +
          esc(guardN === 1 ? '1 AGENT IS STILL WORKING' : guardN + ' AGENTS ARE STILL WORKING') +
          ' - INSTALLING RESTARTS STARNET AND KILLS ' + (guardN === 1 ? 'ITS RUN' : 'THEIR RUNS') + '.</div>' +
          '<div class="up-actions">' +
          '<button class="bb sm" id="up-guard-wait">WAIT FOR AGENTS</button>' +
          '<button class="bb sm danger" id="up-install-force" ' + (busy ? 'disabled' : '') + '>INSTALL ANYWAY</button>' +
          '</div></div>';
      } else {
        out += '<div class="up-actions"><button class="bb sm" id="up-install" ' + (busy ? 'disabled' : '') + '>INSTALL UPDATE</button>' +
          '<button class="bb sm" id="up-remind">REMIND TOMORROW</button>' +
          (update.critical ? '' : '<button class="bb sm danger" id="up-ignore">SKIP VERSION</button>') + '</div></div>';
      }
    } else {
      out += '<div class="up-empty">No update is pending. StarNet will keep checking in the background while automatic checks are on.</div>';
    }
    if (state.phase === 'preparing' || state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'restarting') {
      out += '<div class="up-progress"><div style="width:' + pct + '%"></div></div>' +
        '<div class="up-meta">' + (state.contentLength ? (pct + '% downloaded') : phaseLabel()) + '</div>';
    }
    if (state.error) {
      // Auto-update failed — never leave the user stuck. Surface the manual path explicitly:
      // reinstalling the latest build keeps all data (see RELEASES_PAGE note).
      out += '<div class="up-error">' + esc(state.error) +
        '<br><button class="bb sm up-manual" id="up-manual-err">DOWNLOAD LATEST MANUALLY</button>' +
        '<span class="up-meta up-manual-note">Reinstalling over the top keeps your station and settings.</span></div>';
    }
    out += '<div class="up-foot">Last checked: ' + esc(fmtTime(state.lastCheckedAt)) +
      ' · <a href="#" id="up-manual-foot" class="up-manual-link">download manually</a></div></div>';
    return out;
  }

  // Open the releases page in the system browser — same invoke-with-fallback pattern app.js uses.
  function openReleasesPage() {
    try {
      if (TAURI && typeof TAURI.invoke === 'function') {
        TAURI.invoke('open_external_url', { url: RELEASES_PAGE }).catch(() => {
          try { window.open(RELEASES_PAGE, '_blank', 'noopener'); } catch (_) {}
        });
        return;
      }
    } catch (_) {}
    try { window.open(RELEASES_PAGE, '_blank', 'noopener'); } catch (_) {}
  }

  function wire(body) {
    const auto = body.querySelector('#up-auto');
    if (auto) auto.addEventListener('change', ev => setAutoCheck(ev.target.checked));
    const checkBtn = body.querySelector('#up-check');
    if (checkBtn) checkBtn.addEventListener('click', () => check(true, 'manual'));
    const installBtn = body.querySelector('#up-install');
    if (installBtn) installBtn.addEventListener('click', () => install());
    const forceBtn = body.querySelector('#up-install-force');
    if (forceBtn) forceBtn.addEventListener('click', () => install({ force: true }));
    const waitBtn = body.querySelector('#up-guard-wait');
    if (waitBtn) waitBtn.addEventListener('click', () => { state.confirmRuns = 0; emit(); });
    const remindBtn = body.querySelector('#up-remind');
    if (remindBtn) remindBtn.addEventListener('click', remindLater);
    const ignoreBtn = body.querySelector('#up-ignore');
    if (ignoreBtn) ignoreBtn.addEventListener('click', ignoreVersion);
    const manualErr = body.querySelector('#up-manual-err');
    if (manualErr) manualErr.addEventListener('click', openReleasesPage);
    const manualFoot = body.querySelector('#up-manual-foot');
    if (manualFoot) manualFoot.addEventListener('click', ev => { ev.preventDefault(); openReleasesPage(); });
  }

  return {
    init, refreshStatus, check, install, preInstallDrain, snapshot, settingsHtml, wireSettings, render,
    phase: () => state.phase,
    // True once an update install has committed — quitguard.js reads this so it never blocks the
    // macOS/Linux app.restart() close (Windows exits before restart, so it never asks).
    isInstalling: () => installing,
    prefs: () => Object.assign({}, prefs)
  };
})();
