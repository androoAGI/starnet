/* Lab-only mobile UI policy. No transport, storage, provider or agent mutations. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.LabMobileUI = api;
    document.addEventListener('DOMContentLoaded', () => api.attach(root, document));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function enabled(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    return !!(w && w.matchMedia && new URLSearchParams(w.location.search).get('lab-mobile') !== 'off'
      && w.matchMedia('(max-width: 760px) and (pointer: coarse)').matches);
  }
  function attach(win, doc) {
    let queued = false, paused = false, disposed = false;
    const world = () => typeof World !== 'undefined' ? World : win.World;
    const media = win.matchMedia('(max-width: 760px) and (pointer: coarse)');
    const sync = () => {
      queued = false;
      if (disposed) return;
      const menu = doc.querySelector('#bottombar .bb-group.open, #terms > .term:not(.term-closing):not(.term-min-hidden):not([aria-hidden="true"])');
      const next = enabled(win) && !!menu;
      doc.body.classList.toggle('lab-mobile-menu-open', next);
      const scene = world();
      if (scene && scene.setMenuPaused) scene.setMenuPaused(next);
      paused = next;
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      Promise.resolve().then(sync);
    };
    const terms = doc.getElementById('terms');
    const observer = new win.MutationObserver(records => {
      if (records.some(r => r.target === terms || (r.type === 'attributes' && r.target.classList.contains('term')))) schedule();
    });
    if (terms) observer.observe(terms, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-hidden'] });
    const dockObserver = new win.MutationObserver(schedule);
    doc.querySelectorAll('#bottombar .bb-group').forEach(el => dockObserver.observe(el, { attributes: true, attributeFilter: ['class'] }));
    if (media.addEventListener) media.addEventListener('change', schedule);
    else if (media.addListener) media.addListener(schedule);
    sync();
    return { sync, paused: () => paused, dispose() {
      disposed = true;
      observer.disconnect(); dockObserver.disconnect();
      if (media.removeEventListener) media.removeEventListener('change', schedule);
      else if (media.removeListener) media.removeListener(schedule);
      const scene = world();
      if (scene && scene.setMenuPaused) scene.setMenuPaused(false);
      doc.body.classList.remove('lab-mobile-menu-open');
    } };
  }
  return { enabled, attach };
});
