/* STARNET — freshstart.js
   Desktop-only last-resort reset used when the sidecar is too sick to serve its own recovery route.
   The native command quarantines durable station data first; only after that succeeds do we clear
   browser-owned StarNet state. OS-keychain credentials (including the linked credit account) are
   deliberately outside both operations. */
'use strict';

const FreshStart = (() => {
  // Dot namespaces hold station state. The underscore namespace is the original arcade store and
  // is still StarNet-owned; leaving it behind contradicts "completely fresh".
  const PREFIXES = ['starnet.', 'skynet.', 'starnet_', 'skynet_'];

  function ownedKey(key) {
    return PREFIXES.some(prefix => String(key || '').startsWith(prefix));
  }

  function clearBrowserState(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) throw new Error('browser storage is unavailable');
    const keys = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (ownedKey(key)) keys.push(key);
      }
      keys.forEach(key => store.removeItem(key));
      const remaining = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (ownedKey(key)) remaining.push(key);
      }
      if (remaining.length) throw new Error('StarNet browser state remained after clearing');
      return keys.length;
    } catch (error) {
      throw new Error('browser state could not be cleared: ' + String(error && error.message || error));
    }
  }

  function retryBrowserClear(result, storage) {
    if (!result || result.ok !== true) throw new Error('StarNet could not preserve the prior station');
    let cleared = 0, fallbackError = '';
    try { cleared = clearBrowserState(storage); }
    catch (error) { fallbackError = String(error && error.message || error); }
    const browserDataCleared = result.browserDataCleared === true || !fallbackError;
    return Object.assign({}, result, {
      browserDataCleared,
      browserKeysCleared: cleared,
      browserClearError: browserDataCleared ? '' : fallbackError
    });
  }

  async function resetDesktop(core, storage) {
    if (!core || typeof core.invoke !== 'function') throw new Error('desktop recovery is unavailable');
    // Native first: it moves the durable generation to quarantine and starts a clean sidecar.
    // Never erase the cache when native preservation fails — it may be the user's last readable copy.
    const result = await core.invoke('starnet_start_fresh');
    return retryBrowserClear(result, storage);
  }

  return { clearBrowserState, retryBrowserClear, resetDesktop };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FreshStart;
