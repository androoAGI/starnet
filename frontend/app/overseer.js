'use strict';

// Backend delegation projection: arrival never changes the user's active thread.
const Overseer = (() => {
  let busy = false, panel, lastDeliveries = '';
  function open(id) { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(id); }
  async function refresh() {
    if (busy || typeof Workstreams === 'undefined' || !Workstreams.generalId()) return;
    busy = true;
    try {
      const response = await fetch('/api/overseer');
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      let adopted = false;
      for (const row of data.threads || []) {
        if (!row.parentStreamId || Workstreams.get(row.id) || !Workstreams.get(row.parentStreamId)) continue;
        if (Workstreams.adopt(row)) adopted = true;
      }
      if (adopted) { App.persist(); App.refreshRail(); }
      const deliveries = JSON.stringify([(data.workers || []).map(w => [w.runId, w.status]),
        (data.reviews || []).map(r => [r.reviewRunId, r.status])]);
      if ((adopted || deliveries !== lastDeliveries) && typeof StationCommands !== 'undefined') {
        await StationCommands.reconcile(); lastDeliveries = deliveries;
      }
      if (!panel) {
        const rail = document.getElementById('workstreams');
        if (!rail) return;
        panel = document.createElement('details'); panel.className = 'overseer-overview';
        const title = document.createElement('summary'); title.textContent = 'Overseer · delegated work'; panel.appendChild(title);
        const home = document.createElement('button'); home.className = 'bb'; home.type = 'button';
        home.textContent = 'Talk to overseer'; home.addEventListener('click', () => open(Workstreams.generalId())); panel.appendChild(home);
        const rows = document.createElement('div'); rows.className = 'overseer-rows'; panel.appendChild(rows); rail.before(panel);
      }
      const rows = panel.querySelector('.overseer-rows'); rows.replaceChildren();
      const workers = (data.workers || []).filter(w => w.parentStreamId && Workstreams.get(w.parentStreamId));
      for (const w of workers.slice(-20).reverse()) {
        const review = (data.reviews || []).find(r => r.workerRunId === w.runId);
        let status = w.status === 'running' ? (w.working ? 'Working' : 'Starting') : w.status;
        if (w.status === 'done') status = review && review.status === 'done' ? 'Reviewed' : 'Awaiting review';
        if (review && review.status === 'reviewing') status = 'Reviewing result';
        if (review && review.status === 'interrupted') status = 'Review interrupted';
        if (review && review.status === 'cancelled') status = 'Review stopped';
        if (review && review.status === 'superseded') status = 'Newer attempt available';
        if (review && review.status === 'pending' && review.error) status = 'Needs attention';
        if (['stale', 'interrupted', 'error', 'refused'].includes(w.status)) status = 'Needs attention · ' + w.status;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'bb overseer-work';
        const thread = Workstreams.get(w.streamId);
        button.textContent = status + ' · ' + (thread ? thread.title : String(w.prompt || '').slice(0, 80));
        if (review && review.error) button.title = review.error;
        button.addEventListener('click', () => open(thread ? thread.id : w.parentStreamId)); rows.appendChild(button);
      }
      if (!workers.length) rows.textContent = 'Delegated work will appear here.';
      panel.removeAttribute('data-unavailable');
    } catch (_) {
      if (panel) { panel.setAttribute('data-unavailable', 'true'); panel.querySelector('.overseer-rows').textContent = 'Work status unavailable — reconnecting.'; }
    } finally { busy = false; }
  }
  document.addEventListener('DOMContentLoaded', () => { setInterval(refresh, 2500); });
  return { refresh };
})();
