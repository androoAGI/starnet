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
  // When a check last STARTED in this launch (0 = none yet). Only this proves "up to date"; a lastCheckAt
  // persisted from an earlier run says nothing about a release published since.
  let sessionCheckAt = 0;
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
    if (!CORE) return { v: 1, autoCheck: false, lastCheckAt: 0, nextCheckAt: 0, remindAfter: 0, ignoredVersion: '', notifiedVersion: '', availableVersion: '', failureCount: 0 };
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
  // A refused or interrupted native install must read as what it is: nothing changed. The updater rejects with bare
  // minisign / reqwest / plugin Display text; keep it as the trailing detail for support, never as the whole message.
  function installFailureText(e) {
    const raw = cleanError(e);
    const kept = ' Nothing was installed; your current StarNet is unchanged.';
    if (/signature|different key|minisign|base64|invalid symbol/i.test(raw)) {
      return 'Update refused: the download did not match the signed StarNet release.' + kept + ' (' + raw + ')';
    }
    if (/download|request|response body|connect|timed? ?out|network|status: \d{3}/i.test(raw)) {
      return 'The update download did not finish.' + kept + ' Check the connection, then press INSTALL UPDATE again. (' + raw + ')';
    }
    return raw;
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
  // The Commander pressed SKIP VERSION on exactly this release. Automatic paths (startup, open, 6 h, a webview reload's
  // native pending update) leave it un-armed; only CHECK NOW shows it again. A critical release is never skippable.
  function isSkipped(update) {
    return !!(update && !update.critical && update.version && String(update.version) === prefs.ignoredVersion);
  }
  // true only when version a is a later release than b (dotted numbers); an unreadable pair is never "newer"
  function isNewerVersion(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10));
    const pb = String(b || '').split('.').map(n => parseInt(n, 10));
    if (!pa.length || !pb.length || pa.some(n => !Number.isFinite(n)) || pb.some(n => !Number.isFinite(n))) return false;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }
  function emit() {
    paintBadge();
    try { rerender('updates'); } catch (_) {}
  }
  // The dock's UPDATES item carries a NEW chip while a verified update is armed (state.update comes only from a
  // native check this launch) — the toast fires once per version, so without this a missed toast was the only sign.
  // navdock.js mirrors it onto the collapsed SYSTEM trigger.
  function paintBadge() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    const b = document.getElementById('up-badge');
    if (!b) return;
    const on = !!(state.update && state.update.version);
    const text = on ? 'NEW' : '';
    if (b.textContent !== text) b.textContent = text;
    const display = on ? 'inline-block' : 'none';
    if (b.style.display !== display) b.style.display = display;
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
      if (r.pending && isSkipped(r.pending)) {
        state.update = null;
        state.phase = 'skipped';
      } else if (r.pending) {
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
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update, currentVersion: state.currentVersion },
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
      runtime: { desktop: state.desktop, phase: state.phase, hasUpdate: !!state.update, currentVersion: state.currentVersion },
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
    sessionCheckAt = Date.now();
    state.phase = 'checking';
    state.error = '';
    state.confirmRuns = 0;
    emit();
    try {
      const r = await invoke('starnet_update_check');
      prefs = CORE.recordCheckResult(prefs, r, Date.now());
      state.lastCheckedAt = r.checkedAt || Date.now();
      if (r.available && r.update && !manual && isSkipped(r.update)) {
        // Found the release the Commander skipped: stay skipped (no card, no NEW chip, no toast).
        state.update = null;
        state.phase = 'skipped';
      } else if (r.available && r.update) {
        state.update = r.update;
        state.phase = 'available';
        if (CORE.shouldNotify(prefs, r.update.version, Date.now(), !!r.update.critical)) {
          notify((r.update.critical ? 'Critical update' : 'StarNet update') + ' v' + r.update.version + ' is ready in Update Center', r.update.critical ? 'warn' : 'gold', undefined, { kind: r.update.critical ? 'alert' : 'result', key: 'update-ready', go: { term: 'updates' } });
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
    // #121: queue the LIVE station first. persist() always hands its envelope to the station file, even when the browser
    // cache is full, so the flush below proves the newest state — not merely the last one the cache could hold. A persist
    // that throws leaves the newest state unqueued: that is an unproven save and blocks the install.
    let queued = true;
    if (typeof App !== 'undefined' && App && typeof App.persist === 'function') {
      try { App.persist(); } catch (_) { queued = false; }
    }
    // flushForUpdate distinguishes "nothing pending" from "pending write failed"; only the latter blocks.
    const save = (typeof CloudSave !== 'undefined' && CloudSave && typeof CloudSave.flushForUpdate === 'function')
      ? await withTimeout(CloudSave.flushForUpdate(), budget, failed) : failed;
    const saveConfirmed = queued && !!(save && save.ok === true);
    // App.pushRoster() returns true only after the sidecar accepts and parses the full roster replacement.
    const roster = (typeof App !== 'undefined' && App && typeof App.pushRoster === 'function')
      ? await withTimeout(App.pushRoster(), budget, false) : false;
    // a latched save conflict never clears by waiting: the station file refused this window's copy (kept aside on the
    // station), so the install path names it instead of "try again in a moment"
    return { ok: !!(saveConfirmed && roster === true), save, saveConfirmed, roster: roster === true, conflict: saveConfirmed ? null : saveConflict() };
  }

  // the save conflict this window holds (CloudSave latches the station file's refusal in page memory), or null
  function saveConflict() {
    try {
      const h = (typeof CloudSave !== 'undefined' && CloudSave && typeof CloudSave.health === 'function') ? CloudSave.health() : null;
      return h && h.conflict ? h.conflict : null;
    } catch (_) { return null; }
  }

  /* WHY the newest save is not confirmed (starnet-releases#4: "have the update gate name the failing cause"): the cause
     CloudSave recorded for its last failed attempt, in the save light's own words (one table: CloudSaveCore.describeCause),
     or "yet" when no attempt has failed (the drain's own time ran out first). And the way past it the card already offers:
     the full installer behind DOWNLOAD LATEST MANUALLY, which keeps the station file — the change it has not confirmed stays
     only in this window, so that is said too. A cause that waiting cannot clear (too large, a full disk, a refused folder, a
     newer StarNet's data) never says "try again in a moment". */
  function saveCause() {
    try {
      const h = (typeof CloudSave !== 'undefined' && CloudSave && typeof CloudSave.health === 'function') ? CloudSave.health() : null;
      return h && (h.consecutiveFailures || 0) > 0 && typeof h.cause === 'string' ? h.cause : null;
    } catch (_) { return null; }
  }
  const STUCK_CAUSES = ['tooLarge', 'diskFull', 'diskDenied', 'degraded', 'forbidden'];
  function unconfirmedSaveRefusal(cause) {
    const words = cause && typeof CloudSaveCore !== 'undefined' && CloudSaveCore && CloudSaveCore.describeCause ? CloudSaveCore.describeCause(cause) : '';
    return 'Your latest station changes are not confirmed in the station file ' + (words ? '(' + words + ')' : 'yet') + ', so the update was not installed. StarNet stays open' +
      (STUCK_CAUSES.indexOf(cause) === -1 ? '; try again in a moment.' : '.') +
      ' If it keeps failing, DOWNLOAD LATEST MANUALLY below installs the full update over the top and keeps your station file — a change the station file has not confirmed stays only in this window.';
  }

  // The words follow the save notice (stationui.js refreshSaveDurability) and name ITS buttons, the only ways out.
  function conflictRefusal(c) {
    if (c.reset === true) {
      return 'This computer’s station was reset after the station in this window was founded, so this window’s changes were kept separately on the station, not saved to the station file. The update was not installed. In the save notice at the top, press Download this window’s save to keep a copy, then Open the fresh station, and install the update.';
    }
    // erased work: this window's copy is from before this computer's station was reset and the station is from after it.
    // The notice shows NO Restore key for it (the station refuses that restore), so the card never names one
    if (c.predatesReset === true) {
      return 'This window holds a station from before this computer’s station was reset, so its changes were not saved into the current station; this window’s copy is kept separately on the station. The update was not installed. In the save notice at the top, press Download this window’s save to keep a copy, then Reload current station, and install the update.';
    }
    return 'Your latest station changes conflict with the station file, so they were not saved to it; this window’s copy is kept separately on the station. The update was not installed. In the save notice at the top, ' +
      (c.recovery ? 'press Restore this window’s sessions (or Reload current station), then install the update.'
        : 'press Download this window’s save to keep a copy, then Reload current station, and install the update.');
  }
  // the notice is drawn when the save dot refreshes; a conflict latched by this very drain may not have drawn it yet
  function raiseConflictNotice() {
    try { if (typeof StationUI !== 'undefined' && StationUI && typeof StationUI.refreshSave === 'function') StationUI.refreshSave(); } catch (_) {}
  }

  // the station-save journals (cloudsave.js): 'starnet.save' and one 'starnet.save.w.<window>' per extra live tab. Only THIS
  // window's journal rides the update bundle — every journal is a whole station save, and the prepare route reads at most
  // 16 MiB (review 10-27: two journals of a big station would refuse the update). The others stay where they are.
  const SAVE_JOURNAL_RE = /^starnet\.save(?:\.w\.[A-Za-z0-9_-]{1,80})?(?:\.merge)?$/;   // (.merge: a journal's merge description, cloudsave writeSide)
  function browserStoreSnapshot() {
    const out = {};
    let own = 'starnet.save';
    try { if (typeof CloudSave !== 'undefined' && CloudSave && typeof CloudSave.journalKey === 'function') own = String(CloudSave.journalKey() || own); } catch (_) {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!/^(?:starnet|skynet)\./i.test(String(key || ''))) continue;
        if (SAVE_JOURNAL_RE.test(String(key)) && key !== own && key !== own + '.merge') continue;
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
      throw Object.assign(new Error((body && (body.error || body.code)) || ('update preparation HTTP ' + r.status)), { code: (body && body.code) || '' });
    }
    state.preparationReceipt = body.receipt;
    return body.receipt;
  }

  async function cancelPreparation() {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch('/api/update/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let body = null;
        try { body = await r.json(); } catch (_) {}
        if (r.ok && body && body.ok === true && body.frozen === false) return body;
        lastError = new Error((body && (body.error || body.code)) || ('update cancellation HTTP ' + r.status));
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('update cancellation failed');
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
      const conflict = drained.saveConfirmed === false ? drained.conflict : null;
      // #121: name the save when it is the save that was not proven — the user's newest edits are the thing at risk
      const cause = drained.saveConfirmed === false && !conflict ? saveCause() : null;
      state.error = conflict ? conflictRefusal(conflict)
        : drained.saveConfirmed === false
        ? unconfirmedSaveRefusal(cause)
        : 'State could not be verified on disk. The update was not installed; your current StarNet remains open.';
      busy = false;
      if (conflict) raiseConflictNotice();
      const causeWords = cause && typeof CloudSaveCore !== 'undefined' && CloudSaveCore && CloudSaveCore.describeCause ? ' (' + CloudSaveCore.describeCause(cause) + ')' : '';
      notify(conflict ? 'Update paused - this window’s changes conflict with the station file (see the save notice at the top)'
        : drained.saveConfirmed === false ? 'Update paused - latest station changes are not confirmed in the station file' + causeWords : 'Update paused - state verification failed', 'warn');
      emit();
      return snapshot();
    }
    try {
      await prepareUpdate(!!opts.force);
    } catch (e) {
      state.phase = 'available';
      // The SIDECAR is the authority on live runs: a routine, hop or background worker this window never lit still
      // refuses a plain install. That is the GB-4 choice (WAIT / INSTALL ANYWAY), never a dead-end error card. At least
      // one agent is working (the sidecar proved a live run), so the count is the confirmed busy agents or 1.
      if (e && e.code === 'UPDATE_RUNS_ACTIVE' && !opts.force) {
        state.confirmRuns = Math.max(1, liveRunCount());
        busy = false;
        notify('Update paused - ' + CORE.installBlockReason(state.confirmRuns, false), 'warn');
        emit();
        return snapshot();
      }
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
      let thawError = null;
      try { await cancelPreparation(); }
      catch (cancelError) { thawError = cleanError(cancelError); }
      if (!thawError) state.preparationReceipt = null;
      state.phase = 'available';
      state.error = installFailureText(e) + (thawError ? '; writes may still be paused - ' + thawError : '');
      notify('Update install failed - ' + state.error, 'warn');
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
    // REMIND TOMORROW on the version the Commander skipped (CHECK NOW brought it back) is the newer choice: cancel the
    // skip, or the automatic check a day later would find it still skipped and the promised reminder never arrives.
    if (prefs.ignoredVersion && prefs.ignoredVersion === String(state.update.version)) prefs = CORE.ignoreVersion(prefs, '');
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
    state.phase = 'skipped';
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
    if (state.phase === 'skipped') return 'update skipped';
    if (state.phase === 'error') return 'check failed';
    // idle = no check this launch: say whether one ever ran, never "not checked yet" over a dated last check
    return state.lastCheckedAt ? 'not checked this launch' : 'never checked';
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
    // The window is the "check it now" place: opening it checks unless this launch already checked recently.
    // Deferred out of this render's stack; check() stamps sessionCheckAt and busy first, so its rerenders never re-enter. AUTO-CHECK off means
    // no request the Commander didn't click (PRIVACY.md §6) — CHECK NOW stays the manual path.
    if (TAURI && CORE && !busy && !installing && prefs.autoCheck !== false && (state.phase === 'idle' || state.phase === 'current' || state.phase === 'skipped' || state.phase === 'error') &&
        CORE.shouldCheckOnOpen(sessionCheckAt, Date.now())) {
      Promise.resolve().then(() => check(false, 'open'));
    }
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
    } else if (state.phase === 'current') {
      out += '<div class="up-empty">You have the latest StarNet (checked ' + esc(fmtTime(state.lastCheckedAt)) + ').</div>';
    } else if (state.phase === 'skipped') {
      // Never "latest": a newer release exists, the Commander chose to skip it.
      out += '<div class="up-empty">v' + esc(prefs.ignoredVersion) + ' is skipped. Press CHECK NOW to see it again.</div>';
    } else if (state.phase === 'checking') {
      out += '<div class="up-empty">Checking for a newer StarNet...</div>';
    } else if (state.phase === 'idle') {
      // Not checked this launch: say only what is known — when the last check ran and what it found.
      const known = prefs.availableVersion && prefs.availableVersion !== state.currentVersion && prefs.availableVersion !== prefs.ignoredVersion ? prefs.availableVersion : '';
      // the last check found the release the Commander skipped: say so, as the skipped phase does — but only while it
      // is still newer than the running build (an install of that version, or a later one, makes the skip stale)
      const skipped = !known && prefs.ignoredVersion && prefs.availableVersion === prefs.ignoredVersion &&
        isNewerVersion(prefs.ignoredVersion, state.currentVersion) ? prefs.ignoredVersion : '';
      out += '<div class="up-empty">' + (known
        ? 'The last check found v' + esc(known) + '. Press CHECK NOW to get it ready to install.'
        : skipped ? 'v' + esc(skipped) + ' is skipped. Press CHECK NOW to see it again.'
        : (state.lastCheckedAt ? 'Not checked since ' + esc(fmtTime(state.lastCheckedAt)) + '.' : 'Never checked for updates.') +
          ' Press CHECK NOW to look for a newer StarNet.') + '</div>';
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
    openReleasesPage,   // the full installer (keeps all data) — the forward-version gate's door, which has no Update Center
    phase: () => state.phase,
    // True once an update install has committed — quitguard.js reads this so it never blocks the
    // macOS/Linux app.restart() close (Windows exits before restart, so it never asks).
    isInstalling: () => installing,
    prefs: () => Object.assign({}, prefs)
  };
})();
