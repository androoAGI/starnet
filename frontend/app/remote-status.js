'use strict';
// Remote transport chrome. Runtime facts only: never infer completion from a lost
// connection, and never resend a run. The existing SSE bridge animates the station.
document.addEventListener('DOMContentLoaded', () => {
  if (!window.__STARNET_REMOTE__) return;
  let paintTimer = null;
  const mirror = window.makeRemoteChannels({ channels: Channels,
    locallyDriven: id => typeof Chat !== 'undefined' && Chat.ownsRemoteTransport && Chat.ownsRemoteTransport(id),
    changed: () => {
      if (paintTimer) return;
      paintTimer = setTimeout(() => {
        paintTimer = null;
        if (typeof Chat !== 'undefined' && Chat.renderRemoteActivity) Chat.renderRemoteActivity();
        if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail();
      }, 100);
    },
    settled: () => setTimeout(() => { if (typeof Chat !== 'undefined' && Chat.refreshRemoteTranscript) Chat.refreshRemoteTranscript(); }, 100)
  });
  for (const name of ['agent.run.start', 'agent.token', 'agent.tool_call', 'agent.tool_result', 'permission.prompt', 'agent.run.end']) U.bus.on(name, p => mirror.event(name, p));
  function text(tag, value, target) { const el = document.createElement(tag); el.textContent = value; target.append(el); return el; }
  const review = document.createElement('button'); review.id = 'gateway-control'; review.className = 'bb sm'; review.type = 'button';
  review.setAttribute('aria-haspopup', 'dialog'); review.setAttribute('aria-controls', 'remote-review');
  text('span', '', review).className = 'conn-dot'; review.firstChild.setAttribute('aria-hidden', 'true');
  const label = text('span', 'Gateway', review);
  document.querySelector('#bottombar .bb-right')?.append(review);
  const announcement = document.createElement('span'); announcement.id = 'gateway-announcement'; announcement.setAttribute('role', 'status');
  document.body.append(announcement);
  const dialog = document.createElement('dialog'); dialog.id = 'remote-review'; dialog.className = 'term sn-menu'; dialog.setAttribute('aria-labelledby', 'gateway-title');
  document.body.append(dialog);
  const header = text('header', '', dialog); header.className = 'term-head';
  const title = text('span', 'GATEWAY', header); title.id = 'gateway-title'; title.className = 'term-title';
  const close = text('button', '×', header); close.className = 'term-x'; close.setAttribute('aria-label', 'Close Gateway'); close.type = 'button'; close.onclick = () => dialog.close();
  const body = text('div', '', dialog); body.className = 'term-body';
  const status = text('p', '', body); status.className = 'gateway-state';
  const facts = text('dl', '', body); facts.className = 'gateway-facts sn-menu-options';
  text('dt', 'SERVER', facts).className = 'dim';
  const serverName = text('dd', 'Connecting…', facts);
  text('dt', 'ACCOUNT', facts).className = 'dim';
  const accountName = text('dd', 'Checking sign-in…', facts);
  text('p', 'Your agents keep running when you close or disconnect this app.', body).className = 'sn-menu-note';
  const activity = text('p', '', body);
  const recovery = text('p', '', body); recovery.className = 'sn-menu-note';
  const actions = text('div', '', body); actions.className = 'gateway-actions';
  const retry = text('button', '↻ RECONNECT', actions); retry.className = 'bb'; retry.type = 'button'; retry.hidden = true;
  retry.onclick = () => clientAvailable ? changeConnection('reconnect') : poll();
  const setup = text('button', '⌁ CONNECTION SETTINGS', actions); setup.className = 'bb'; setup.type = 'button'; setup.hidden = !window.__STARNET_CONNECTION_SETUP__;
  setup.onclick = () => { dialog.close(); window.location.href = 'starnet-connect://setup'; };
  const disconnect = text('button', 'DISCONNECT THIS APP', actions); disconnect.className = 'bb'; disconnect.type = 'button'; disconnect.hidden = true;
  disconnect.onclick = () => changeConnection('disconnect');
  const actionError = text('p', '', body); actionError.className = 'msg bad'; actionError.setAttribute('role', 'alert'); actionError.hidden = true;
  const goals = text('div', '', body); goals.style.whiteSpace = 'pre-line';
  const approvals = text('section', '', body); approvals.setAttribute('aria-label', 'Decisions');
  const details = text('details', '', body); details.className = 'sn-menu-options';
  text('summary', 'Connection details', details);
  text('p', 'Private SSH connection. Execution and provider keys stay on your server.', details).className = 'sn-menu-note';
  const timing = text('p', '', details);
  let latest = null, pending = [], busy = false, latency = null, goalCursor = '';
  let connection = 'connecting', pendingSignature = '', opener = null;
  let clientAvailable = false, paused = false, changing = false, pollController = null, connectionGeneration = 0;
  function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
  function render() {
    const connected = connection === 'connected';
    const decisions = `${pending.length} decision${pending.length === 1 ? '' : 's'}`;
    const stateLabel = paused ? 'Disconnected' : connected ? 'Connected' : 'Reconnecting';
    const compact = !connected ? stateLabel : pending.length ? decisions : '';
    setText(label, compact ? `Gateway · ${compact}` : 'Gateway');
    review.dataset.attention = String(!connected || pending.length > 0);
    review.setAttribute('aria-label', `Gateway: ${stateLabel.toLowerCase()}${pending.length ? ', ' + decisions : ''}`);
    setText(announcement, `${stateLabel}${pending.length ? ' · ' + decisions : ''}`);
    dialog.dataset.connected = String(connected);
    setText(status, stateLabel);
    setText(activity, latest ? `${connected ? '' : 'Last known: '}${latest.runs.length} running · ${pending.length} awaiting a decision` : 'Waiting for station activity.');
    setText(recovery, paused ? 'Disconnected for this app session. Reconnect when you are ready.' : !connected ? 'Reconnecting automatically. Station activity will catch up when the connection returns.' : '');
    recovery.hidden = connected;
    retry.hidden = connected;
    retry.disabled = changing || (busy && !clientAvailable);
    disconnect.hidden = !clientAvailable || paused; disconnect.disabled = changing;
    setup.disabled = changing;
    setText(timing, latency === null ? 'Latency unavailable' : `${latency} ms round trip${connected ? '' : ' (last connection)'}`);
    setText(goals, (latest?.remote?.goals || []).map(row => `${row.goal.status} · ${row.goal.turnsUsed}/${row.goal.maxTurns} turns · ${row.goal.goal}`).join('\n'));
    approvals.hidden = pending.length === 0;
    goals.hidden = !(latest?.remote?.goals || []).length;
    const signature = JSON.stringify(pending);
    // Keep controls, keyboard focus and in-flight decisions intact during polls.
    if (signature !== pendingSignature) {
      pendingSignature = signature;
      const hadFocus = approvals.contains(document.activeElement);
      approvals.replaceChildren();
      for (const p of pending) {
        const article = text('article', '', approvals);
        text('strong', `${p.agentId || 'Agent'} · ${p.tool || 'Approval'}`, article);
        text('pre', p.argsSummary || 'Reopen the original session for this request.', article);
        if (p.tool === 'brief.ask' || p.tool === 'human.ask' || p.tool === 'path.trust') {
          text('p', 'Answer this request in its original session.', article); continue;
        }
        const buttons = [];
        const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.hidden = true;
        for (const [buttonLabel, decision] of [['Allow once', 'once'], ['Deny', 'deny']]) {
          const button = text('button', buttonLabel, article); button.type = 'button'; button.className = 'bb sm'; buttons.push(button);
          button.onclick = async () => {
            article.dataset.busy = 'true'; buttons.forEach(b => { b.disabled = true; }); error.hidden = true;
            try {
              const r = await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: p.runId, promptId: p.promptId, decision }), signal: AbortSignal.timeout(15000) });
              const result = await r.json();
              if (!r.ok || !result.ok) throw new Error('This request has expired or could not be applied.');
              pending = pending.filter(row => row.runId !== p.runId || row.promptId !== p.promptId);
              render(); await poll();
            } catch (_) { error.textContent = 'Decision could not be confirmed. Refresh the connection before trying again.'; error.hidden = false; }
            finally { article.dataset.busy = 'false'; buttons.forEach(b => { b.disabled = connection !== 'connected'; }); }
          };
        }
        article.append(error);
      }
      // If a resolved request disappears, keep focus inside the open dialog.
      if (hadFocus && dialog.open) close.focus();
    }
    for (const button of approvals.querySelectorAll('button')) button.disabled = !connected || button.closest('article').dataset.busy === 'true';
  }
  async function clientStatus(generation) {
    const r = await fetch('/remote/client/status', { headers: { 'x-starnet-client': '1' }, cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    const client = await r.json();
    if (generation !== connectionGeneration || changing) return;
    clientAvailable = true; paused = !!client.paused;
    if (client.host) setText(serverName, client.host);
    if (client.user?.login) setText(accountName, '@' + client.user.login);
    if (paused) { connection = 'disconnected'; setText(accountName, 'Disconnected'); }
  }
  async function loadIdentity() {
    const generation = connectionGeneration;
    try {
      await clientStatus(generation);
      if (generation !== connectionGeneration || changing) return;
      if (paused) { render(); return; }
      const r = await fetch('/remote/status', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('disconnected');
      const remote = await r.json();
      if (generation !== connectionGeneration || changing) return;
      if (!clientAvailable) setText(serverName, remote.host || 'Remote server');
      setText(accountName, remote.user?.login ? '@' + remote.user.login : 'Account unavailable');
    } catch (_) {
      if (generation !== connectionGeneration || changing) return;
      if (serverName.textContent === 'Connecting…') setText(serverName, 'Server unavailable');
      if (accountName.textContent === 'Checking sign-in…') setText(accountName, 'Sign-in unavailable');
    }
    render();
  }
  async function changeConnection(action) {
    if (changing) return;
    changing = true; connectionGeneration++; pollController?.abort(); actionError.hidden = true;
    connection = 'reconnecting'; render();
    try {
      const r = await fetch('/remote/client/' + action, { method: 'POST', headers: { 'x-starnet-client': '1', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('Connection change could not be confirmed. Try again.');
      const client = await r.json(); paused = !!client.paused;
      connection = paused ? 'disconnected' : 'reconnecting';
      if (paused) setText(accountName, 'Disconnected');
    } catch (error) { actionError.textContent = error.message; actionError.hidden = false; }
    finally { changing = false; render(); }
    if (!paused) { await poll(); loadIdentity(); }
  }
  function open() {
    if (!dialog.open) { opener = document.activeElement; render(); dialog.showModal(); }
    loadIdentity();
  }
  review.onclick = open;
  details.addEventListener('toggle', () => { if (details.open) loadIdentity(); });
  dialog.addEventListener('close', () => { if (opener?.isConnected && opener.offsetParent !== null) opener.focus(); });
  window.StarNetGateway = Object.freeze({ open });
  async function poll() {
    if (busy || changing) return; busy = true;
    const generation = connectionGeneration, controller = new AbortController(); pollController = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    const started = performance.now();
    try {
      if (paused) return;
      let r = await fetch('/api/state/snapshot', { cache: 'no-store', signal: controller.signal });
      if (r.status === 403) {
        // A restarted server has a new per-launch API token. Renew it through
        // the existing authenticated gateway, preserving this page and its drafts.
        const bootstrap = await fetch('/remote/bootstrap', { cache: 'no-store', signal: controller.signal });
        if (!bootstrap.ok) throw new Error('Reconnecting');
        const credentials = await bootstrap.json();
        if (!/^[a-f0-9]{64}$/.test(credentials.token || '')) throw new Error('Invalid station credential');
        window.__STARNET_API_TOKEN__ = credentials.token;
        r = await fetch('/api/state/snapshot', { cache: 'no-store', signal: controller.signal });
      }
      if (!r.ok) throw new Error('disconnected');
      const snapshot = await r.json();
      if (generation !== connectionGeneration) return;
      latest = snapshot; latency = Math.round(performance.now() - started);
      pending = latest.prompts || [];
      mirror.snapshot(latest);
      const reconnected = connection !== 'connected';
      connection = 'connected';
      if (reconnected && dialog.open) loadIdentity();
      const canAdopt = () => !paused && !changing && generation === connectionGeneration && !document.activeElement?.matches('textarea,input,[contenteditable="true"]')
        && (typeof Chat === 'undefined' || !Chat.canRefreshRemote || Chat.canRefreshRemote());
      if (canAdopt() && latest.runs.length === 0 && typeof CloudSave !== 'undefined' && CloudSave.refreshRemote
        && Number(latest.remote?.saveRevision) > CloudSave.revision()) {
        const saved = await CloudSave.refreshRemote(canAdopt);
        if (saved && typeof App !== 'undefined' && App.refreshRemoteSessions) App.refreshRemoteSessions(saved);
      }
      const nextGoals = JSON.stringify((latest.remote?.goals || []).map(g => [g.streamId, g.lastRunId, g.goal.status, g.goal.turnsUsed]));
      if (canAdopt() && latest.runs.length === 0 && nextGoals !== goalCursor && typeof Chat !== 'undefined' && Chat.refreshRemoteTranscript) {
        await Chat.refreshRemoteTranscript(); goalCursor = nextGoals;
      }
    } catch (_) { if (generation === connectionGeneration) connection = 'reconnecting'; }
    finally { clearTimeout(timeout); pollController = null; busy = false; render(); }
  }
  render(); poll(); setInterval(poll, 5000);
  window.addEventListener('online', poll);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
});
