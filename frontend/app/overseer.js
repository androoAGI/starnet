'use strict';

// Backend delegation projection: arrival never changes the user's active thread.
const Overseer = (() => {
  let busy = false, panel, lastDeliveries = '', lastRendered = '';
  function open(id) { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(id); }
  function project(data, getThread) {
    const reviews = new Map((data.reviews || []).map(r => [r.workerRunId, r]));
    const byThread = new Map();
    const workers = (data.workers || []).filter(w => w.parentStreamId && getThread(w.parentStreamId))
      .slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    for (const w of workers) {
      const key = w.streamId || w.id, previous = byThread.get(key);
      if (!previous || (w.status === 'running' && previous.status !== 'running')) byThread.set(key, w);
    }
    return Array.from(byThread.values()).map(w => {
      const review = reviews.get(w.runId), thread = getThread(w.streamId);
      let status = 'Needs attention', group = 0, detail = 'Ask the overseer to check this attempt.';
      if (w.status === 'running') { status = w.working ? 'Working' : 'Starting'; group = 1; detail = ''; }
      else if (review && review.status === 'reviewing') { status = 'Reviewing result'; group = 1; detail = ''; }
      else if (review && review.status === 'done') {
        status = w.status === 'done' ? 'Reviewed' : 'Issue reported'; group = 2;
        detail = w.status === 'done' ? '' : 'The overseer has reviewed this attempt. Open its conversation for the next step.';
      } else if (review && review.status === 'cancelled') { status = 'Stopped'; detail = 'Ask the overseer when you want to continue.'; }
      else if (review && review.status === 'interrupted') { status = 'Review interrupted'; detail = 'Ask the overseer to check the saved result before continuing.'; }
      else if (review && review.status === 'superseded') { status = 'Earlier attempt'; group = 2; detail = ''; }
      else if (review && review.error) { detail = review.error; }
      else if (w.status === 'done') { status = data.paused ? 'Review paused' : 'Awaiting review'; group = data.paused ? 0 : 1; detail = data.paused ? 'Send the overseer a message when you want to continue.' : ''; }
      else if (w.status === 'stale') detail = 'This attempt lost its connection. Ask the overseer to check what completed.';
      else if (w.status === 'interrupted') detail = 'This attempt was interrupted. Ask the overseer when you want to continue.';
      else if (w.status === 'error' || w.status === 'refused') detail = 'This attempt could not finish. The overseer can inspect the cause.';
      return { key: w.streamId || w.id, status, group, detail,
        title: thread ? thread.title : String(w.prompt || 'Delegated work').slice(0, 80),
        id: thread ? thread.id : w.parentStreamId, parentId: w.parentStreamId };
    }).sort((a, b) => a.group - b.group);
  }
  async function refresh() {
    if (busy || typeof Workstreams === 'undefined' || !Workstreams.generalId()) return;
    busy = true;
    try {
      if (!panel) {
        const rail = document.getElementById('workstreams');
        if (!rail) return;
        panel = document.createElement('section'); panel.className = 'overseer-overview'; panel.setAttribute('aria-label', 'Overseer');
        const home = document.createElement('button'); home.className = 'bb'; home.type = 'button';
        home.textContent = 'Talk to overseer'; home.addEventListener('click', () => open(Workstreams.generalId())); panel.appendChild(home);
        const notice = document.createElement('p'); notice.className = 'overseer-notice'; panel.appendChild(notice);
        const details = document.createElement('details'); details.open = true;
        const title = document.createElement('summary'); title.textContent = 'Delegated work'; details.appendChild(title);
        const rows = document.createElement('div'); rows.className = 'overseer-rows'; details.appendChild(rows); panel.appendChild(details); rail.before(panel);
      }
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
      const rows = panel.querySelector('.overseer-rows');
      const all = project(data, id => Workstreams.get(id)), items = all.slice(0, 20);
      const active = all.filter(item => item.group === 1).length, attention = all.filter(item => item.group === 0).length;
      panel.querySelector('summary').textContent = 'Delegated work' + (active ? ' · ' + active + ' active' : '') + (attention ? ' · ' + attention + ' need attention' : '');
      panel.querySelector('.overseer-notice').textContent = data.paused ? 'Automatic reviews paused. Message the overseer to continue.' : 'Results return to the conversation that requested them.';
      const rendered = JSON.stringify([items, all.length]);
      if (rendered !== lastRendered) {
        rows.replaceChildren();
        for (const item of items) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'bb overseer-work';
          button.textContent = item.status + ' · ' + item.title;
          button.addEventListener('click', () => open(item.id));
          const row = document.createElement('div'); row.className = 'overseer-item'; row.dataset.state = String(item.group); row.appendChild(button);
          if (item.detail) { const hint = document.createElement('p'); hint.textContent = item.detail; row.appendChild(hint); }
          if (item.group !== 1) {
            const result = document.createElement('button'); result.type = 'button'; result.className = 'bb';
            result.textContent = item.group === 0 ? 'Ask overseer' : 'Open review';
            result.addEventListener('click', () => open(item.parentId)); row.appendChild(result);
          }
          rows.appendChild(row);
        }
        if (!items.length) rows.textContent = 'Delegated work will appear here.';
        if (all.length > items.length) { const more = document.createElement('p'); more.textContent = 'Showing 20 of ' + all.length + ' sessions. Find earlier work in the sessions list.'; rows.appendChild(more); }
        lastRendered = rendered;
      }
      panel.removeAttribute('data-unavailable');
    } catch (_) {
      lastRendered = '';
      if (panel) { panel.setAttribute('data-unavailable', 'true'); panel.querySelector('summary').textContent = 'Delegated work · unavailable'; panel.querySelector('.overseer-notice').textContent = 'Work status unavailable — reconnecting.'; panel.querySelector('.overseer-rows').replaceChildren(); }
    } finally { busy = false; }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { refresh(); setInterval(refresh, 2500); });
  return { refresh, project };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Overseer;
