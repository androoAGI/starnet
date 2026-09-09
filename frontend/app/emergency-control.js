/* Recovery for legacy saved automation halts. This control can only resume, never stop. */
'use strict';
(() => {
  const recovery = document.getElementById('automation-resume');
  if (!recovery) return;
  const names = { cron: 'routines', nightshift: 'night shift', loops: 'loops' };
  let state = null, busy = false, sequence = 0, failure = '';

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    });
    return { response, data: await response.json() };
  }
  function accept(data) {
    if (!data || !data.subsystems || !Object.keys(names).every(k =>
      typeof data.subsystems[k]?.halted === 'boolean')) throw new Error('Pause state could not be verified');
    // Derive from the individual receipts, including partially recovered saves.
    state = { stopped: Object.keys(names).filter(k => data.subsystems[k].halted) };
  }
  function render() {
    recovery.hidden = !!state && !state.stopped.length;
    recovery.style.display = recovery.hidden ? 'none' : '';
    recovery.textContent = busy ? 'CHECKING…' : state ? 'RESUME AUTOMATION' : 'CHECK AUTOMATION';
    recovery.disabled = busy;
    recovery.setAttribute('data-tip', failure || (!state ? 'Pause state unavailable — click to retry'
      : 'Resume previously paused ' + state.stopped.map(k => names[k]).join(', ')));
  }
  async function refresh() {
    if (busy) return;
    const stamp = ++sequence;
    try {
      const { response, data } = await request('/api/halt');
      if (stamp !== sequence) return;
      if (!response.ok) throw new Error('Pause state unavailable');
      accept(data);
    } catch (_) { if (stamp === sequence) state = null; }
    if (stamp === sequence) render();
  }
  async function resume() {
    if (busy) return;
    if (!state) return refresh();
    if (!state.stopped.length) return;
    busy = true; ++sequence; failure = ''; render();
    try {
      const { response, data } = await request('/api/halt/resume', { confirm: true });
      const failed = Object.keys(data.errors || {}).map(k => names[k] || k);
      if (failed.length) failure = 'Could not resume: ' + failed.join(', ');
      else if (!response.ok || data.ok !== true) failure = 'Resume failed — recheck automation';
      const checked = await request('/api/halt');
      if (!checked.response.ok) throw new Error('Pause state unavailable');
      accept(checked.data);
      if (state.stopped.length && !failure) failure = 'Some automation remains paused — retry Resume';
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(failure ||
        'Automation resumed — existing permissions and job settings preserved', failure ? 'bad' : 'good');
    } catch (_) {
      state = null; failure = 'Could not verify the result — check the connection and retry';
    } finally { busy = false; render(); }
  }
  recovery.addEventListener('click', resume);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  refresh();
})();
