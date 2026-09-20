'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name=setup-token]').content;
  let initialized = false, polling = false, current = null, lastMessage = null, mode = 'new', openAfterTest = false;
  const input = () => ({ host: $('host').value.trim(), 'ssh-port': $('ssh-port').value, 'gateway-port': $('gateway-port').value });
  function invalidate() { $('open').hidden = true; $('test').hidden = false; }
  function render(state) {
    current = state;
    if (!initialized) {
      initialized = true;
      mode = state.config ? 'existing' : 'new';
      renderMode();
      if (state.config) { $('host').value = state.config.host; $('ssh-port').value = state.config['ssh-port'] || ''; $('gateway-port').value = state.config['gateway-port']; }
    }
    $('location-choice').hidden = !state.localAvailable;
    $('local').disabled = !state.localAvailable;
    $('identity').textContent = state.user ? 'Signed in as ' + state.user.login : 'Sign in with the GitHub account that owns this station.';
    $('login').textContent = state.user ? '↻ SWITCH GITHUB ACCOUNT' : '⏼ SIGN IN WITH GITHUB ↗';
    $('return').hidden = !state.config;
    const messageKey = state.phase + ':' + state.message;
    if (messageKey !== lastMessage) { $('status').textContent = state.message; $('status').dataset.phase = state.phase; lastMessage = messageKey; }
    $('cancel').hidden = !state.busy;
    for (const id of ['login', 'profile', 'test', 'ssh', 'install', 'host', 'ssh-port', 'gateway-port']) $(id).disabled = state.busy || (id === 'install' && !state.installerAvailable) || (id === 'gateway-port' && mode === 'new');
    document.querySelectorAll('[data-mode]').forEach(el => el.disabled = state.busy);
    $('return').disabled = state.busy;
    const canOpen = !state.busy && state.phase === 'connected' && state.config && JSON.stringify(input()) === JSON.stringify({ host: state.config.host, 'ssh-port': String(state.config['ssh-port'] || ''), 'gateway-port': String(state.config['gateway-port']) });
    $('test').hidden = !!canOpen; $('open').hidden = !canOpen;
    if (openAfterTest && !state.busy && (canOpen || state.phase === 'error')) {
      openAfterTest = false;
      if (canOpen) openStation();
    }
  }
  async function request(route, data) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20000);
    try {
    const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'x-starnet-setup': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: abort.signal });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || 'The request did not complete.');
    render(state);
    } finally { clearTimeout(timeout); }
  }
  async function action(route, data = {}) {
    try { await request(route, data); }
    catch (error) { openAfterTest = false; $('status').textContent = error.message; $('status').dataset.phase = 'error'; }
  }
  function openStation() {
    if (current.localAvailable) { window.location.href = 'starnet-connect://remote'; return; }
    window.location.href = 'http://127.0.0.1:' + (current.config?.port || 8790);
  }
  $('login').onclick = () => action('login'); $('profile').onclick = () => action('profile');
  $('connection').onsubmit = event => { event.preventDefault(); invalidate(); openAfterTest = !current?.config; action('test', input()); };
  $('cancel').onclick = () => { openAfterTest = false; action('cancel'); };
  $('ssh').onclick = () => { if ($('connection').reportValidity()) action('ssh', input()); };
  $('install').onclick = () => { if ($('connection').reportValidity()) action('install', input()); };
  $('open').onclick = openStation; $('return').onclick = openStation;
  for (const id of ['host', 'ssh-port', 'gateway-port']) $(id).addEventListener('input', invalidate);
  function renderMode() {
    document.querySelectorAll('[data-mode]').forEach(button => {
      button.classList.toggle('sel', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
    $('install-panel').hidden = mode !== 'new';
    if (mode === 'new') $('gateway-port').value = '18791';
    $('gateway-port').disabled = mode === 'new';
  }
  $('local').onclick = async () => {
    if (!current?.localAvailable) return;
    if (current.busy) await action('cancel');
    $('status').textContent = 'Opening your local station…';
    lastMessage = null;
    window.location.href = 'starnet-connect://local';
  };
  $('remote-choice').onclick = () => $('host').focus();
  document.querySelectorAll('[data-mode]').forEach(el => el.onclick = () => {
    mode = el.dataset.mode; renderMode(); invalidate();
  });
  async function poll() {
    if (polling) return; polling = true;
    try { await request('status'); } catch (_) { $('status').textContent = 'The connection helper stopped. Reopen StarNet to reconnect.'; }
    finally { polling = false; }
  }
  request('status').then(() => { if (!current.busy && current.config) return action('profile'); }).catch(() => { $('status').textContent = 'Connection Setup could not start. Reopen StarNet.'; });
  setInterval(poll, 1000);
})();
