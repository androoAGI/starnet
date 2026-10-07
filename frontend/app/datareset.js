/* STARNET — datareset.js : the two "make it clean again" doors in SETTINGS.

   ERASE EVERYTHING (#65, Settings > APP & BACKUP). A Mac user deleted the app, reinstalled, and found every agent and
   chat still there: uninstalling removes the program, not the per-user app-data folder, the window's own storage or
   the keychain. START FRESH (freshstart.js) keeps the old station in a quarantine on purpose. This door DELETES, through
   the desktop shell's `starnet_erase_everything` (src-tauri/src/erase_all.rs), behind a typed ERASE plus a second
   confirming click. It never claims more than the shell's receipt proves: what was removed, what could not be, and
   whether this window's storage was cleared. Project folders the Commander trusted are recorded by path and are never
   inside StarNet's data, so they are never touched.

   WRITES ARE FROZEN while the erase runs and until the reload: this window still holds the OLD station in memory, and
   its unload/visibility save hooks (cloudsave's beacon, attendance stamps) would otherwise write that old world into
   the brand-new empty station. freezeWrites() blocks localStorage writes, sendBeacon and /api/ fetches on THIS page
   instance only; a reload ends it. If the erase is refused, the freeze is lifted again.

   RESET STATION BROWSER (#61, Settings > BROWSER). POST /api/browser/reset: closes the station browser, ends any
   orphaned StarNet browser left running on the station profile by an earlier StarNet process (never the Commander's
   own Chrome), clears its stale locks. Saved sign-ins are kept.

   UMD: a `DataReset` global in the page; module.exports under node so the pure parts are unit-tested. */
'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DataReset = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const CONFIRM_WORD = 'ERASE';

  function tauriCore(win) {
    const w = win || root;
    return (w && w.__TAURI__ && w.__TAURI__.core && typeof w.__TAURI__.core.invoke === 'function') ? w.__TAURI__.core : null;
  }
  function apiBase(win) { try { return String(((win || root) && (win || root).__STARNET_API__) || ''); } catch (_) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---- the freeze ---- */
  function isApiUrl(u) {
    const s = String((u && u.url) || u || '');
    return /(^|\/\/[^/]+)\/api\//.test(s) || /^\/api\//.test(s);
  }
  function freezeWrites(win) {
    const w = win || root;
    const undo = [];
    try {
      const proto = w.Storage && w.Storage.prototype;
      if (proto && typeof proto.setItem === 'function') {
        const orig = proto.setItem;
        proto.setItem = function () { /* frozen: the old station must not write into the fresh one */ };
        undo.push(() => { proto.setItem = orig; });
      }
    } catch (_) {}
    try {
      const nav = w.navigator;
      if (nav && typeof nav.sendBeacon === 'function') {
        const orig = nav.sendBeacon;
        nav.sendBeacon = function () { return true; };
        undo.push(() => { nav.sendBeacon = orig; });
      }
    } catch (_) {}
    try {
      if (typeof w.fetch === 'function') {
        const orig = w.fetch;
        w.fetch = function (input, init) {
          if (isApiUrl(input)) return Promise.reject(new Error('StarNet is erasing - station writes are frozen'));
          return orig.call(this, input, init);
        };
        undo.push(() => { w.fetch = orig; });
      }
    } catch (_) {}
    w.__STARNET_ERASING__ = true;
    let lifted = false;
    return function lift() {
      if (lifted) return; lifted = true;
      while (undo.length) { try { undo.pop()(); } catch (_) {} }
      try { w.__STARNET_ERASING__ = false; } catch (_) {}
    };
  }

  /* ---- the erase ---- */
  async function eraseDesktop(opts) {
    opts = opts || {};
    const w = opts.win || root;
    const core = opts.core || tauriCore(w);
    if (!core) throw new Error('ERASE EVERYTHING runs in the StarNet desktop app');
    // Best effort, BEFORE the freeze: end any orphaned station browser so its files are not held open (#61).
    try {
      if (typeof w.fetch === 'function') {
        let timer = null;
        await Promise.race([
          w.fetch(apiBase(w) + '/api/browser/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null),
          new Promise(r => { timer = setTimeout(r, 8000); })
        ]);
        if (timer) clearTimeout(timer);
      }
    } catch (_) {}
    const lift = freezeWrites(w);
    let view;
    try { view = await core.invoke('starnet_erase_everything', { confirm: CONFIRM_WORD }); }
    catch (error) { lift(); throw error; }   // refused before any deletion: the window works as before
    view = Object.assign({}, view || {});
    if (view.browserDataCleared !== true) {
      // The native clear failed: remove StarNet's own keys from this window directly (removeItem is not frozen).
      try {
        const fresh = opts.freshStart || (typeof FreshStart !== 'undefined' ? FreshStart : null);
        if (fresh && typeof fresh.clearBrowserState === 'function') { fresh.clearBrowserState(opts.storage); view.browserDataCleared = true; view.browserDataClearedBy = 'fallback'; }
      } catch (e) { view.browserClearError = String((e && e.message) || e); }
    }
    return view;
  }

  /* What the receipt proves, in plain lines — and whether reloading into the fresh station is safe. */
  function eraseSummary(v) {
    v = v || {};
    const removed = Array.isArray(v.removed) ? v.removed : [];
    const failed = Array.isArray(v.failed) ? v.failed : [];
    const kcFailed = Array.isArray(v.keychainFailed) ? v.keychainFailed : [];
    const lines = [];
    lines.push('Deleted ' + removed.length + ' StarNet data location' + (removed.length === 1 ? '' : 's') + ' on this computer.');
    if (failed.length) lines.push('Could NOT delete ' + failed.length + ': ' + failed.map(f => f.path + ' (' + f.error + ')').join('; ') + '. Quit StarNet and delete ' + (failed.length === 1 ? 'it' : 'them') + ' by hand.');
    if (kcFailed.length) lines.push('Could NOT remove ' + kcFailed.length + ' saved credential' + (kcFailed.length === 1 ? '' : 's') + ' from the system keychain: ' + kcFailed.join('; ') + '.');
    else lines.push('Removed StarNet\'s saved keys and tokens from the system keychain.');
    if (v.autostartDisabled === false) lines.push('Launch at login could not be turned off; turn it off in your system settings.');
    lines.push(v.browserDataCleared === true ? 'Cleared this window\'s stored data.' : 'Could NOT clear this window\'s stored data' + (v.browserClearError ? ' (' + v.browserClearError + ')' : '') + '.');
    const complete = v.ok === true && v.browserDataCleared === true;
    const reloadSafe = v.browserDataCleared === true && v.listening === true;
    if (v.listening !== true) lines.push('The fresh station did not start answering yet. Quit StarNet fully and open it again.');
    return { complete, reloadSafe, lines };
  }

  /* ---- station browser reset ---- */
  function browserResetSummary(status, r) {
    r = r || {};
    if (r.driving) return 'An agent is driving the station browser right now. Stop that run, then reset.';
    if (status !== 200 && !r.sweep) return 'The browser was not reset: ' + (r.error || ('the station answered ' + status)) + '.';
    const s = r.sweep;
    const bits = [r.closed ? 'Closed the station browser.' : 'The station browser was not open.'];
    if (!s) bits.push('No orphan check ran.');
    else if (s.error) bits.push('Could not check for a leftover browser: ' + s.error + '.');
    else {
      bits.push(s.found ? ('Ended ' + (s.killed || []).length + ' of ' + s.found + ' leftover StarNet browser process' + (s.found === 1 ? '' : 'es') + ' from an earlier session.') : 'No leftover StarNet browser was running.');
      if ((s.survivors || []).length) bits.push((s.survivors || []).length + ' could not be ended (pid ' + s.survivors.join(', ') + '). Restart your computer if pages still fail.');
      if (s.locks && (s.locks.removed || []).length) bits.push('Cleared its stale profile lock.');
      if ((s.ours || []).length) bits.push('A browser StarNet is using right now was left running.');
    }
    if (r.ok) bits.push('Your saved sign-ins were kept. The next page you open starts a fresh browser.');
    return bits.join(' ');
  }
  async function resetStationBrowser(win) {
    const w = win || root;
    const res = await w.fetch(apiBase(w) + '/api/browser/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let body = null; try { body = await res.json(); } catch (_) { body = null; }
    return { status: res.status, body: body || {} };
  }

  /* ---- mounts (DOM) ---- */
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sfx(name) { try { if (typeof SFX !== 'undefined' && SFX[name]) SFX[name](); } catch (_) {} }

  function mountBrowserReset(host) {
    if (!host || typeof document === 'undefined') return;
    const wrap = el('div', 'set-reset-browser');
    wrap.appendChild(el('h4', 'ms-h', 'RESET STATION BROWSER'));
    wrap.appendChild(el('p', 'set-about', 'Pages will not load, or agents report the browser is stuck? This closes the station browser, ends any copy an earlier StarNet session left running, and clears its stale locks. It never touches your own Chrome. Saved sign-ins are kept.'));
    const row = el('div', 'set-save');
    const btn = el('button', 'bb sm', 'RESET STATION BROWSER'); btn.type = 'button'; btn.id = 'set-reset-browser';
    row.appendChild(btn); wrap.appendChild(row);
    const msg = el('p', 'set-about dim', ''); msg.id = 'set-reset-browser-msg'; msg.setAttribute('role', 'status');
    wrap.appendChild(msg);
    btn.addEventListener('click', async () => {
      sfx('click');
      btn.disabled = true; msg.textContent = 'Resetting the station browser…';
      try {
        const r = await resetStationBrowser();
        msg.textContent = browserResetSummary(r.status, r.body);
      } catch (e) {
        msg.textContent = 'The browser was not reset: ' + String((e && e.message) || e) + '.';
      } finally { btn.disabled = false; }
    });
    host.appendChild(wrap);
  }

  function mountErase(host) {
    if (!host || typeof document === 'undefined') return;
    const core = tauriCore();
    const wrap = el('div', 'set-erase');
    wrap.appendChild(el('h4', 'ms-h', 'ERASE EVERYTHING'));
    const about = el('p', 'set-about');
    about.innerHTML = 'Deletes everything StarNet keeps on this computer and starts over at first run: your station, agents, chats, memory, routines and settings, saved browser sign-ins, files agents saved inside StarNet, logs, the voice-model download, StarNet\'s saved keys and tokens in the system keychain, and this window\'s stored data. <b>This cannot be undone.</b> Export a backup first if you might want it.';
    wrap.appendChild(about);
    wrap.appendChild(el('p', 'set-about dim', 'Not touched: project folders you let agents work in, files exported to "StarNet deliverables", your Downloads folder, your StarNet account and its credits (this computer is unlinked from it), and the StarNet app itself (uninstall it separately).'));
    if (!core) {
      wrap.appendChild(el('p', 'set-about dim', 'ERASE EVERYTHING runs in the StarNet desktop app. Running StarNet from source? Stop it, then delete the workspaces folder it was started with (the repo\'s workspaces/ folder, or the path in SKYNET_WORKSPACES).'));
      host.appendChild(wrap);
      return;
    }
    const row = el('div', 'set-save');
    const input = el('input', 'key-input'); input.type = 'text'; input.id = 'set-erase-word'; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'type ERASE to confirm'; input.setAttribute('aria-label', 'Type ERASE to confirm');
    const btn = el('button', 'bb sm danger', 'ERASE EVERYTHING'); btn.type = 'button'; btn.id = 'set-erase-btn'; btn.disabled = true;
    row.appendChild(input); row.appendChild(btn); wrap.appendChild(row);
    const msg = el('p', 'set-about', ''); msg.id = 'set-erase-msg'; msg.setAttribute('role', 'status');
    wrap.appendChild(msg);
    const reloadBtn = el('button', 'bb sm', 'OPEN THE FRESH STATION'); reloadBtn.type = 'button'; reloadBtn.hidden = true;
    reloadBtn.addEventListener('click', () => { try { location.reload(); } catch (_) {} });
    wrap.appendChild(reloadBtn);
    let busy = false;
    const sync = () => { btn.disabled = busy || input.value.trim() !== CONFIRM_WORD; };
    input.addEventListener('input', sync);
    const run = async () => {
      if (busy || input.value.trim() !== CONFIRM_WORD) return;
      busy = true; sync(); input.disabled = true;
      msg.textContent = 'Stopping StarNet and erasing… keep this window open.';
      try {
        const view = await eraseDesktop({ core });
        const sum = eraseSummary(view);
        msg.textContent = sum.lines.join(' ');
        if (sum.complete && sum.reloadSafe) {
          msg.textContent += ' Opening the fresh station…';
          setTimeout(() => { try { location.reload(); } catch (_) {} }, 1500);
        } else if (sum.reloadSafe) {
          reloadBtn.hidden = false;   // partial: let them read what remains, then go
        }
      } catch (e) {
        busy = false; input.disabled = false; sync();
        msg.textContent = String((e && e.message) || e);
      }
    };
    if (typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
      ArmConfirm.wire(btn, { armedLabel: 'ERASE NOW - CANNOT BE UNDONE', timeoutMs: 6000, onArm: () => sfx('bad'), onConfirm: run });
    } else {
      let armed = false;
      btn.addEventListener('click', () => {
        if (!armed) { armed = true; btn.textContent = 'ERASE NOW - CANNOT BE UNDONE'; setTimeout(() => { armed = false; btn.textContent = 'ERASE EVERYTHING'; }, 6000); return; }
        armed = false; run();
      });
    }
    host.appendChild(wrap);
  }

  return { CONFIRM_WORD, freezeWrites, isApiUrl, eraseDesktop, eraseSummary, browserResetSummary, resetStationBrowser, mountErase, mountBrowserReset, _esc: esc };
});
