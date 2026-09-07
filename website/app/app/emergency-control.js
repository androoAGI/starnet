/* State-backed emergency stop recovery. No hotkey, posture writes, or automatic resume. */
'use strict';
(() => {
  const button = document.getElementById('automation-stop-toggle');
  if (!button) return;
  const label = button.querySelector('b');
  const detail = button.querySelector('small');
  const recovery = document.getElementById('automation-resume');
  const retryStop = document.getElementById('automation-stop-retry');
  const names = { cron: 'routines', nightshift: 'night shift', loops: 'loops' };
  let state = null, busy = false, sequence = 0, failure = '';

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    return { response, data };
  }
  function accept(data) {
    if (!data || !data.subsystems || !Object.keys(names).every(k =>
      typeof data.subsystems[k]?.halted === 'boolean')) throw new Error('Stop state could not be verified');
    state = data;
  }
  function render() {
    const stopped = state && Object.keys(names).filter(k => state.subsystems[k].halted);
    const action = !state ? 'CHECK STOP STATE' : stopped.length ? 'RESUME AUTOMATION' : 'STOP AUTOMATION';
    label.textContent = busy ? 'CHECKING…' : action;
    detail.textContent = failure || (!state ? 'Stop state unavailable — click to retry' : stopped.length
      ? 'Stopped: ' + stopped.map(k => names[k]).join(', ')
      : 'Stop all runs; pause routines, night shift & loops');
    button.disabled = busy;
    if (recovery) {
      // Make an old durable stop discoverable immediately after an upgrade/restart.
      recovery.hidden = !!state && !stopped.length;
      recovery.style.display = recovery.hidden ? 'none' : '';
      recovery.textContent = busy ? 'CHECKING…' : action;
      recovery.disabled = busy;
      recovery.setAttribute('data-tip', detail.textContent);
    }
  }
  async function refresh() {
    if (busy) return;
    const stamp = ++sequence;
    try {
      const { response, data } = await request('/api/halt');
      if (stamp !== sequence) return;
      if (!response.ok) throw new Error('Stop state unavailable');
      accept(data);
    } catch (_) { if (stamp === sequence) state = null; }
    if (stamp === sequence) render();
  }
  async function change(forceStop) {
    if (busy) return;
    if (!state && !forceStop) return refresh();
    const resume = !forceStop && state.halted;
    busy = true; ++sequence; failure = ''; render();
    try {
      // The action was chosen by the user's click. Never reinterpret a stale Stop click as Resume.
      const { response, data } = await request(resume ? '/api/halt/resume' : '/api/halt', resume ? { confirm: true } : {});
      const failed = resume ? Object.keys(data.errors || {}).map(k => names[k] || k)
        : Object.keys(names).filter(k => data[k === 'nightshift' ? 'nightshiftHaltPersisted' : k === 'cron' ? 'cronHaltPersisted' : 'loopsHaltPersisted'] !== true).map(k => names[k]);
      if (failed.length) failure = (resume ? 'Could not resume: ' : 'Restart protection failed: ') + failed.join(', ');
      else if (!response.ok || (resume && data.ok !== true)) failure = 'Action failed — recheck the stop state';
      if (!resume) {
        try { if (typeof Chat !== 'undefined' && Chat.abort) Chat.abort(); } catch (_) {}
        if (retryStop) retryStop.hidden = failed.length === 0;
      } else if (retryStop) retryStop.hidden = true;
      if (retryStop) retryStop.style.display = retryStop.hidden ? 'none' : '';
      // A successful-looking POST is insufficient. Read authoritative state again, bypassing caches.
      const checked = await request('/api/halt');
      if (!checked.response.ok) throw new Error('Stop state unavailable');
      accept(checked.data);
      if (resume && state.halted && !failure) failure = 'Some automation remains stopped — retry Resume';
      if (!resume && !Object.keys(names).every(k => state.subsystems[k].halted) && !failure) failure = 'Some automation did not stop — retry Stop';
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(failure || (resume
        ? 'Emergency stop cleared — existing permissions and job settings preserved'
        : 'Automation stopped — stays stopped across restarts'), failure ? 'bad' : 'good');
    } catch (_) {
      state = null; failure = 'Could not verify the result — check the connection and retry';
    } finally { busy = false; render(); }
  }
  button.addEventListener('click', () => change(false));
  if (recovery) recovery.addEventListener('click', () => change(false));
  if (retryStop) retryStop.addEventListener('click', () => change(true));
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  refresh();
})();
