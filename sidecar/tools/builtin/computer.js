/* sidecar/tools/builtin/computer.js - legacy computer-use contract.
   This module owns the schema and host authority boundary, delegating native
   operations to the Windows driver or an injected driver.

   makeComputerTools({ driver? }) -> { useTool, register(reg), _internals }
     driver.perform(action) -> Promise
     driver.capture()       -> Promise<{ width, height, ... } | string>
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).computer = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const win32 = require('./win32desktop.js');

  const ACTIONS = ['screenshot', 'move', 'click', 'double_click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'wait'];
  // Keyboard input lands in whatever window has FOCUS — these are the actions the focus-truth guard covers.
  const KEYBOARD_ACTIONS = ['type', 'key', 'hotkey'];
  // The harness's own window (desktop shell exe or a browser tab titled STARNET). Typing into it is never the
  // intent — it means the target app lost focus (the 2026-07-08 "typed the song into its own chat box" incident).
  const SELF_WINDOW_RE = /starnet/i;
  const DESTRUCTIVE_HOTKEYS = [
    'ctrl+alt+delete',
    'ctrl+shift+esc',
    'alt+f4',
    'meta+r',
    'win+r',
    'meta+x',
    'win+x',
    'ctrl+w',
    'ctrl+q'
  ];
  const COMMAND_TEXT_RE = /\b(cmd|powershell|pwsh|bash|sh)\s+(\/c|-c)\b|(^|\s)(rm\s+-rf|del\s+\/[sq]|format\s+[a-z]:|shutdown\b|restart-computer\b|reg\s+delete\b|curl\s+.*\|\s*(sh|bash|pwsh|powershell))/i;

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/windows/g, 'win').replace(/command/g, 'meta');
  }
  function validateAction(raw) {
    const a = Object.assign({}, raw || {});
    a.action = String(a.action || '').trim();
    if (ACTIONS.indexOf(a.action) < 0) throw new Error('unsupported computer action: ' + a.action);
    if (a.x != null) a.x = Number(a.x);
    if (a.y != null) a.y = Number(a.y);
    if (a.dx != null) a.dx = Number(a.dx);
    if (a.dy != null) a.dy = Number(a.dy);
    if (a.durationMs != null) a.durationMs = Math.max(0, Math.min(10000, Number(a.durationMs) || 0));
    if (a.button != null) a.button = String(a.button);
    if (a.text != null) a.text = String(a.text);
    if (a.key != null) a.key = String(a.key);
    if (a.keys != null && !Array.isArray(a.keys)) throw new Error('computer hotkey keys must be an array');
    if (Array.isArray(a.keys)) a.keys = a.keys.map(k => String(k));
    if (a.expectApp != null) a.expectApp = String(a.expectApp);
    return a;
  }
  function hardBlock(action) {
    // A paired remote owner is the user at the physical machine. Validate the input shape, but do not turn a
    // denylist of keys or typed text into a second, weaker notion of ownership. Normal runs cannot reach this
    // function at all: physicalInputAllowed still requires the host-minted remote-owner lease.
    return validateAction(action);
  }
  function summarize(action) {
    const a = action || {};
    if (a.action === 'type') return 'type ' + String(a.text || '').length + ' chars';
    if (a.action === 'hotkey') return 'hotkey ' + ((a.keys || []).join('+') || a.key || '');
    if (a.action === 'click' || a.action === 'double_click' || a.action === 'move') return a.action + ' ' + a.x + ',' + a.y;
    if (a.action === 'drag') return 'drag ' + a.x + ',' + a.y + ' by ' + (a.dx || 0) + ',' + (a.dy || 0);
    if (a.action === 'scroll') return 'scroll ' + (a.dx || 0) + ',' + (a.dy || 0);
    return a.action;
  }
  // FOCUS-TRUTH GUARD: keyboard input is only delivered when we can prove (or the driver cannot know) which
  // window will receive it. Returns a human-readable foreground note for the tool result; throws when input
  // must NOT be sent: foreground is StarNet's own window, or it doesn't match the model's declared expectApp.
  async function checkFocus(driver, action) {
    if (KEYBOARD_ACTIONS.indexOf(action.action) < 0) return '';
    if (typeof driver.foreground !== 'function') {
      if (action.expectApp) throw new Error('focus check unavailable: this desktop driver cannot report the foreground window — input NOT sent');
      return '';
    }
    const fg = (await driver.foreground()) || {};
    const title = String(fg.title || ''), proc = String(fg.process || '');
    if (SELF_WINDOW_RE.test(title) || SELF_WINDOW_RE.test(proc)) {
      throw new Error('refused: the foreground window is StarNet itself ("' + (title || proc) + '") — the target app lost focus, so input was NOT sent; re-focus the target app (click it) before typing');
    }
    if (action.expectApp) {
      const want = action.expectApp.toLowerCase();
      if (title.toLowerCase().indexOf(want) < 0 && proc.toLowerCase().indexOf(want) < 0) {
        throw new Error('focus check failed: the foreground window is "' + title + '" (' + proc + '), expected "' + action.expectApp + '" — input was NOT sent; re-focus the target app and retry');
      }
    }
    return 'foreground="' + title + '" (' + proc + ')';
  }
  function win32DriverRequested(env) {
    env = env || process.env;
    return /^(1|true|win32|windows)$/i.test(String(env.STARNET_COMPUTER_DRIVER || env.SKYNET_COMPUTER_DRIVER || ''));
  }
  // Was the driver explicitly DISABLED? Lets a desktop-shell run opt back out (e.g. QA)
  // without unsetting the shell marker.
  function win32DriverDisabled(env) {
    env = env || process.env;
    return /^(0|false|off|none)$/i.test(String(env.STARNET_COMPUTER_DRIVER || env.SKYNET_COMPUTER_DRIVER || ''));
  }
  function underDesktopShell(env) {
    env = env || process.env;
    return /^(1|true|yes|on)$/i.test(String(env.STARNET_DESKTOP_SHELL || env.SKYNET_DESKTOP_SHELL || ''));
  }
  // Environment selection is only ONE half of the authority check. Presence under the
  // desktop shell used to auto-enable physical input for every task; that was unsafe.
  // The shell marker is informational now: Windows plus an explicit driver selection is
  // necessary, and makeComputerTools still requires a host-minted attended lease per call.
  function win32DriverActive(env, platform) {
    env = env || process.env;
    return platform === 'win32' && underDesktopShell(env) && win32DriverRequested(env) && !win32DriverDisabled(env);
  }
  function makeWin32DesktopDriver(deps) {
    const d = win32.makeWin32DesktopDriver(deps || {});
    return d || makeInertDriver('computer-use unavailable: native desktop control needs Windows');
  }

  // Fail-closed driver injected into every ordinary StarNet run. It throws instead of
  // returning success, so telemetry never claims an input action that policy prevented.
  function makeInertDriver(reason) {
    const why = reason || 'physical input is disabled for agent runs';
    const unavailable = async () => { throw new Error(why); };
    return { perform: unavailable, capture: unavailable, foreground: unavailable, inert: true };
  }

  // A task, autonomous/test surface, standing approval, Full Access, and the desktop-shell
  // environment alone are not input authority. The sole positive shape is a host-minted
  // remote-owner lease for a locally paired Telegram owner.
  function physicalInputAllowed(deps, ctx) {
    deps = deps || {}; ctx = ctx || {};
    if (deps.allowPhysicalInput !== true) return false;
    if (ctx.unrestrictedHost === true && ctx.inputMode === 'full-power') return true;
    return ctx.remoteDesktopAuthorized === true && ctx.ownerTrusted === true &&
      ctx.surface === 'interactive' && ctx.inputMode === 'remote-owner';
  }
  function assertPhysicalInputAllowed(deps, ctx) {
    if (!physicalInputAllowed(deps, ctx)) {
      throw new Error('physical input is disabled: Full Power or an authenticated remote-owner desktop lease is required');
    }
  }

  function makeDriver(deps) {
    deps = deps || {};
    if (deps.allowPhysicalInput !== true) return makeInertDriver();
    const d = deps && deps.driver;
    if (d && typeof d.perform === 'function') return d;
    if (process.platform === 'win32' && win32DriverActive(process.env, process.platform)) return makeWin32DesktopDriver(deps);
    return makeInertDriver('computer-use unavailable: native remote desktop driver is not enabled');
  }

  /* A capture that is only DESCRIBED is not a capture. `capture_after=<json>` told the model the screen
     was 1920×1080 and nothing about what was on it, so the next click went to coordinates it had never
     seen. Drivers hand back base64 under one of several field names (or a bare base64 string); this
     normalizes them and defers the "may it go on the wire" decision to the shared imagewire sniffer, so
     this producer and fs.read answer that question identically. */
  function captureToWire(cap, imageWire) {
    if (!cap || !imageWire) return { images: null };
    const b64 = (typeof cap === 'string') ? cap
      : String((cap && (cap.data || cap.base64 || cap.png || cap.image)) || '');
    if (!b64 || typeof Buffer === 'undefined') return { images: null };
    let buf;
    try { buf = Buffer.from(b64.replace(/^data:[^;,]*(;base64)?,/i, ''), 'base64'); }
    catch (_) { return { images: null }; }
    const info = imageWire.sniff('capture.png', buf);
    if (!info) return { images: null };                  // not decodable as an image -> caller keeps the text proof
    const wire = imageWire.toWire(buf, info);
    return { images: wire.images, note: imageWire.describe(info, 'screen') + (wire.note ? ' — ' + wire.note : '') };
  }

  function makeComputerTools(deps) {
    deps = deps || {};
    const driver = makeDriver(deps);
    const imageWire = (deps.imageWire && typeof deps.imageWire.sniff === 'function') ? deps.imageWire : null;
    const useTool = {
      name: 'computer.use',
      // A cached shell/verify approval (`workbench:execute`) must never authorize input.
      capability: 'physical-input',
      impact: 'physical-input',
      scope: 'execute',
      requiresConsent: true,
      timeoutMs: 15000,
      description: 'PHYSICAL mouse/keyboard/screen control on the Windows desktop. Available under host-minted Full Power or to a locally paired Telegram owner; restricted runs remain synthetic-only.',
      schema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS },
          x: { type: 'number' },
          y: { type: 'number' },
          dx: { type: 'number' },
          dy: { type: 'number' },
          button: { type: 'string' },
          text: { type: 'string' },
          key: { type: 'string' },
          keys: { type: 'array', items: { type: 'string' } },
          durationMs: { type: 'number' },
          capture_after: { type: 'boolean' },
          expectApp: { type: 'string', description: 'Legacy advisory app/title hint; foreground matching is not enforced. Inspect the screen before typing. CUA offers explicit window and element targets.' }
        }
      },
      run: async (args, ctx) => {
        assertPhysicalInputAllowed(deps, ctx);
        const action = hardBlock(args || {});
        // The paired Telegram owner is at the controls; foreground observations must not silently narrow which
        // window they can use. The screenshot action remains available for visual verification after any input.
        const fgNote = '';
        const result = await driver.perform(action);
        let proof = '';
        let images = null;
        if (action.capture_after || action.action === 'screenshot') {
          const cap = await driver.capture();
          if (!cap) throw new Error('capture_after failed: no capture returned');
          const wired = captureToWire(cap, imageWire);
          images = wired.images;
          // The text proof stays either way: it is what the run log and the war room render, and it is the
          // only record left when the pixels are dropped (oversized, or the host has tool images off).
          if (wired.note) proof = 'capture_after=' + wired.note;
          else if (typeof cap === 'string') proof = 'capture_after=' + cap;
          else proof = 'capture_after=' + JSON.stringify(cap);
        }
        const content = 'computer.' + action.action + ' ok' + (['screenshot', 'wait'].includes(action.action) ? '' : ' (input dispatched; verify the outcome)') + (fgNote ? '\n' + fgNote : '') + (proof ? '\n' + proof : '') + (result ? '\n' + String(result) : '');
        return { content, summary: summarize(action), images };
      }
    };
    return { useTool, register(reg) { reg.register(useTool); return reg; }, _internals: { ACTIONS, KEYBOARD_ACTIONS, SELF_WINDOW_RE, checkFocus, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, win32DriverActive, win32DriverDisabled, underDesktopShell, makeWin32DesktopDriver, makeInertDriver, physicalInputAllowed, assertPhysicalInputAllowed } };
  }

  return { makeComputerTools, _internals: { ACTIONS, KEYBOARD_ACTIONS, SELF_WINDOW_RE, checkFocus, hardBlock, validateAction, summarize, COMMAND_TEXT_RE, win32DriverRequested, win32DriverActive, win32DriverDisabled, underDesktopShell, makeWin32DesktopDriver, makeInertDriver, physicalInputAllowed, assertPhysicalInputAllowed } };
});
