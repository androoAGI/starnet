/* KeepAwake: desktop bridge for the Settings toggle that prevents idle system
   sleep while Agent OS is open. Browser previews expose the same API as a no-op
   so the settings panel can stay truthful without branching everywhere. */
'use strict';

const KeepAwake = (() => {
  const SET_COMMAND = 'starnet_set_keep_awake';
  const STATUS_COMMAND = 'starnet_keep_awake_status';

  let lastRequested = null;
  let lastStatus = { desktop: false, supported: false, enabled: false, message: null };

  function currentWindow() {
    return (typeof window !== 'undefined') ? window : null;
  }

  function tauriCore(win) {
    return win && win.__TAURI__ && win.__TAURI__.core && typeof win.__TAURI__.core.invoke === 'function'
      ? win.__TAURI__.core
      : null;
  }

  function statusShape(raw, requested) {
    raw = raw || {};
    return {
      desktop: !!raw.desktop,
      supported: !!raw.supported,
      enabled: !!raw.enabled,
      message: raw.message == null ? null : String(raw.message),
      requested: !!requested
    };
  }

  function browserStatus(requested) {
    return {
      desktop: false,
      supported: false,
      enabled: false,
      message: 'Keep Computer Awake is available in the Agent OS desktop app.',
      requested: !!requested
    };
  }

  function isDesktop(win) {
    return !!tauriCore(win || currentWindow());
  }

  async function apply(enabled, opts) {
    opts = opts || {};
    const requested = !!enabled;
    const core = tauriCore(opts.win || currentWindow());
    if (!core) {
      lastRequested = requested;
      lastStatus = browserStatus(requested);
      return Object.assign({}, lastStatus);
    }
    if (!opts.force && requested === lastRequested) return Object.assign({}, lastStatus, { requested });

    lastRequested = requested;
    try {
      lastStatus = statusShape(await core.invoke(SET_COMMAND, { enabled: requested }), requested);
      return Object.assign({}, lastStatus);
    } catch (err) {
      lastRequested = null;
      const message = (err && err.message) ? err.message : String(err || 'Keep Computer Awake failed');
      lastStatus = { desktop: true, supported: true, enabled: false, message, requested };
      const wrapped = new Error(message);
      wrapped.status = Object.assign({}, lastStatus);
      throw wrapped;
    }
  }

  async function status(opts) {
    opts = opts || {};
    const core = tauriCore(opts.win || currentWindow());
    if (!core) return Object.assign({}, browserStatus(false));
    lastStatus = statusShape(await core.invoke(STATUS_COMMAND, {}), lastRequested);
    return Object.assign({}, lastStatus);
  }

  return {
    apply,
    status,
    isDesktop,
    _internals: { SET_COMMAND, STATUS_COMMAND, tauriCore, statusShape }
  };
})();

if (typeof module !== 'undefined') module.exports = KeepAwake;
