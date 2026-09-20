'use strict';

// Projects own an existing COMMS workstream. Activity projects the existing worker ledger.
const ProjectHome = (() => {
  let panel, updates, actions, root = '', homeId = '', epoch = 0, timer, crewDirty = false;
  const cards = new Map();
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  async function request(url, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || data.reason || 'Request could not be completed.');
      return data;
    } finally { clearTimeout(timeout); }
  }
  function setup() {
    if (panel) return;
    panel = el('section', 'project-home'); panel.hidden = true; panel.setAttribute('aria-label', 'Project controls');
    panel.innerHTML = '<div class="ph-view-head"><button class="btn ph-back">‹ Back to chat</button><span class="ph-view-title"></span></div>' +
      '<p class="ph-notice" role="status"></p><section class="ph-crew"><p>Preferred crew <span class="ph-crew-count"></span></p><p class="ph-help">The orchestrator can also bring in other station agents.</p><div class="ph-crew-list"></div><button class="btn ph-save">SAVE CREW</button><span class="ph-crew-note" role="status"></span></section>' +
      '<section class="ph-history"><p class="ph-empty">No delegated work yet.</p><div class="ph-activity"></div></section>';
    document.getElementById('chat-panel').insertBefore(panel, document.getElementById('chat-log'));
    updates = el('div', 'ph-updates'); updates.setAttribute('aria-label', 'Agent updates');
    actions = el('div', 'ph-actions'); actions.hidden = true;
    const crew = el('button', 'btn ph-crew-toggle', 'CREW'), activity = el('button', 'btn ph-history-toggle', 'ACTIVITY');
    crew.onclick = () => showView('crew'); activity.onclick = () => showView('activity');
    actions.append(crew, activity); document.getElementById('comms-idbar').appendChild(actions);
    panel.querySelector('.ph-back').onclick = () => { showView(''); activity.focus(); };
    panel.querySelector('.ph-save').onclick = saveCrew;
  }
  function showView(next) {
    panel.hidden = !next;
    document.getElementById('chat-log').hidden = !!next;
    panel.querySelector('.ph-crew').hidden = next !== 'crew';
    panel.querySelector('.ph-history').hidden = next !== 'activity';
    panel.querySelector('.ph-view-title').textContent = next === 'crew' ? 'Project crew' : 'Activity';
    actions.querySelector('.ph-crew-toggle').setAttribute('aria-pressed', String(next === 'crew'));
    actions.querySelector('.ph-history-toggle').setAttribute('aria-pressed', String(next === 'activity'));
  }
  function notice(text) {
    panel.querySelector('.ph-notice').textContent = text;
    let note = updates.querySelector('.ph-inline-notice');
    if (!note) { note = el('p', 'ph-inline-notice'); note.setAttribute('role', 'status'); updates.appendChild(note); }
    if (note.textContent !== text) note.textContent = text;
  }
  function close() {
    ++epoch; clearTimeout(timer); root = homeId = '';
    if (panel) { showView(''); actions.hidden = true; updates.remove(); }
    document.getElementById('comms-title').textContent = '▮ COMMS';
    document.getElementById('comms-idbar').classList.remove('ph-project');
  }
  async function open(projectRoot) {
    setup(); clearTimeout(timer); const token = ++epoch; root = projectRoot; homeId = ''; crewDirty = false; cards.clear();
    panel.querySelector('.ph-activity').replaceChildren(); panel.querySelector('.ph-crew-list').replaceChildren();
    panel.querySelector('.ph-crew-note').textContent = ''; updates.replaceChildren(); showView(''); actions.hidden = false;
    document.getElementById('comms-idbar').classList.add('ph-project');
    document.getElementById('comms-title').textContent = projectRoot.split(/[\\/]/).filter(Boolean).pop();
    document.getElementById('chat-log').appendChild(updates); notice('Opening project…');
    try {
      let data;
      try { data = await request('/api/projects/workspace', { root: projectRoot }); }
      catch (error) { data = await request('/api/projects/workspace?root=' + encodeURIComponent(projectRoot)); if (data.project.blessed) throw error; }
      if (token !== epoch) return;
      homeId = data.session && data.session.id;
      if (homeId) {
        if (!Workstreams.get(homeId)) Workstreams.adopt({ ...data.session, revive: true });
        App.persist(); App.openWorkstream(homeId);
      }
      render(data); poll(token);
    } catch (error) { if (token === epoch) notice('Could not open project. ' + error.message + ' Select the project to retry.'); }
  }
  function render(data) {
    const log = document.getElementById('chat-log');
    if (updates.parentNode !== log) log.appendChild(updates);
    notice(data.project.blessed ? '' : 'Folder access is revoked. Re-add this folder before starting new work.');
    document.getElementById('comms-title').textContent = data.project.name || root.split(/[\\/]/).pop();
    const crewList = panel.querySelector('.ph-crew-list');
    const signature = JSON.stringify(data.crew.map(a => [a.id, a.name]));
    if (!crewDirty && crewList.dataset.signature !== signature + JSON.stringify(data.project.preferredAgents)) {
      crewList.replaceChildren(); crewList.dataset.signature = signature + JSON.stringify(data.project.preferredAgents);
      for (const agent of data.crew.filter(a => a.id !== 'agent')) {
        const label = el('label', 'ph-crew-choice'), input = el('input'); input.type = 'checkbox'; input.value = agent.id;
        input.checked = (data.project.preferredAgents || []).includes(agent.id); input.disabled = !data.project.blessed;
        input.onchange = () => { crewDirty = true; panel.querySelector('.ph-crew-note').textContent = 'Unsaved changes'; };
        label.append(input, el('span', '', agent.name)); crewList.appendChild(label);
      }
      if (!crewList.children.length) crewList.appendChild(el('p', '', 'Recruit agents on the station to choose your preferred crew.'));
    }
    panel.querySelector('.ph-save').disabled = !data.project.blessed;
    panel.querySelector('.ph-crew-count').textContent = (data.project.preferredAgents || []).length ? '· ' + data.project.preferredAgents.length + ' selected' : '· Any station agent';
    const activity = data.activity || [], running = activity.filter(w => w.status === 'running').length;
    actions.querySelector('.ph-history-toggle').textContent = running ? 'ACTIVITY · ' + running : 'ACTIVITY';
    panel.querySelector('.ph-empty').hidden = activity.length > 0;
    const live = new Set(activity.map(w => w.id));
    for (const [id, card] of cards) if (!live.has(id)) { card.node.remove(); card.update.remove(); cards.delete(id); }
    for (const [index, worker] of activity.entries()) {
      let card = cards.get(worker.id);
      if (!card) {
        card = createCard(worker.id); cards.set(worker.id, card);
        updates.appendChild(card.update);
        const next = activity.slice(index + 1).map(w => cards.get(w.id)).find(Boolean);
        panel.querySelector('.ph-activity').insertBefore(card.node, next ? next.node : null);
      }
      card.worker = worker;
      card.title.textContent = String(worker.prompt || 'Delegated work').replace(/\s+/g, ' ').slice(0, 140);
      card.agent.textContent = (data.crew.find(a => a.id === worker.agentId) || {}).name || worker.agentId;
      card.status.textContent = worker.status === 'running' ? (worker.working ? 'Working' : 'Starting') : ({ done: 'Completed', interrupted: 'Stopped', error: 'Needs attention' }[worker.status] || worker.status);
      const updateText = card.agent.textContent + ' · ' + card.status.textContent.toLowerCase() + ' · ' + (worker.status === 'running' ? 'View work' : 'View result');
      if (card.update.textContent !== updateText) card.update.textContent = updateText;
      card.node.dataset.status = worker.status;
      card.prompt.textContent = worker.prompt || '';
      card.prompt.hidden = String(worker.prompt || '').replace(/\s+/g, ' ').length <= 140;
      card.update.setAttribute('aria-label', updateText + ': ' + String(worker.prompt || 'Delegated work'));
      card.update.dataset.status = worker.status;
      card.result.textContent = worker.result || (worker.status === 'running' ? 'Waiting for the agent’s result.' : 'No result was recorded.');
      card.tools.textContent = (worker.tools || []).length ? 'Tools used: ' + worker.tools.join(', ') : '';
      card.artifacts.textContent = (worker.artifacts || []).map(a => typeof a === 'string' ? a : a.path || a.name || a.title || '').filter(Boolean).map(a => 'Output: ' + a).join('\n');
      card.directions.textContent = (worker.steerHistory || []).map(s => (s.status === 'applied' ? 'Direction applied: ' : 'Direction queued: ') + (s.text || '')).join('\n');
      card.controls.hidden = !worker.canInterrupt; card.stop.disabled = card.send.disabled = card.pending || !worker.canInterrupt;
    }
  }
  function createCard(id) {
    const node = el('details', 'ph-card'), summary = el('summary'), title = el('span', 'ph-task'), agent = el('span', 'ph-agent'), status = el('span', 'ph-status');
    const body = el('div', 'ph-card-body'), prompt = el('p'), result = el('pre', 'ph-result'), tools = el('p', 'ph-tools'), artifacts = el('p', 'ph-tools'), directions = el('pre', 'ph-directions'), controls = el('div', 'ph-controls');
    const input = el('textarea'); input.rows = 2; input.placeholder = 'Give this agent a direction…'; input.setAttribute('aria-label', 'Direction for this work');
    const send = el('button', 'btn', 'SEND DIRECTION'), stop = el('button', 'btn', 'STOP WORK'), receipt = el('p', 'ph-receipt'); receipt.setAttribute('role', 'status');
    summary.append(agent, status, title); controls.append(input, send, stop); body.append(prompt, result, tools, artifacts, directions, controls, receipt); node.append(summary, body);
    const update = el('button', 'ph-inline');
    update.onclick = () => { showView('activity'); node.open = true; node.scrollIntoView({ block: 'nearest' }); summary.focus(); };
    const card = { node, update, title, agent, status, prompt, result, tools, artifacts, directions, controls, input, send, stop, receipt, worker: null };
    async function command(kind) {
      const token = epoch, worker = card.worker, text = input.value.trim(); if (kind === 'steer' && !text) { input.focus(); return; }
      card.pending = true; send.disabled = stop.disabled = true;
      try {
        await request('/api/subagents/' + kind, { id, generation: worker.generation, ...(kind === 'steer' ? { text } : {}) });
        if (token !== epoch) return;
        receipt.textContent = kind === 'steer' ? 'Direction queued for this agent. It will also be included in the orchestrator’s review.' : 'Stop requested.';
        if (kind === 'steer' && input.value.trim() === text) input.value = '';
      } catch (error) { if (token === epoch) receipt.textContent = error.message; }
      finally { card.pending = false; if (token === epoch) send.disabled = stop.disabled = !card.worker.canInterrupt; }
    }
    send.onclick = () => command('steer'); stop.onclick = () => command('interrupt'); return card;
  }
  async function saveCrew() {
    const token = epoch, button = panel.querySelector('.ph-save'), note = panel.querySelector('.ph-crew-note'); button.disabled = true;
    const preferredAgents = Array.from(panel.querySelectorAll('.ph-crew-list input:checked')).map(n => n.value);
    try { const data = await request('/api/projects/workspace', { root, preferredAgents }); if (token !== epoch) return; crewDirty = false; render(data); note.textContent = 'Crew preferences saved.'; }
    catch (error) { if (token === epoch) note.textContent = error.message; }
    finally { if (token === epoch) button.disabled = false; }
  }
  function poll(token) {
    timer = setTimeout(async () => {
      if (token !== epoch) return;
      if (homeId && Workstreams.activeId() !== homeId) { close(); return; }
      try { const data = await request('/api/projects/workspace?root=' + encodeURIComponent(root)); if (token !== epoch) return; render(data); }
      catch (_) { if (token === epoch) notice('Activity could not refresh. Showing the last confirmed state; reconnecting…'); }
      if (token === epoch) poll(token);
    }, 2500);
  }
  return { open, close, onSession: id => { if (root && homeId && id !== homeId) close(); } };
})();
