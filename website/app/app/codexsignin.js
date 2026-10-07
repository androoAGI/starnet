/* STARNET — codexsignin.js : the ONE device-code OAuth sign-in driver for keyless subscription providers.

   Originally the ChatGPT (Codex) device-code flow extracted from app.js's connect-screen (start → show code →
   open page → poll → connected) so the Settings→PROVIDERS panel can offer RE-SIGN-IN without duplicating the
   poll loop. Now GENERALIZED: the same engine drives any /api/auth/<pid>/* device flow (codex, grok, kimi, …).
   `CodexSignIn` is the codex-bound instance and is UNCHANGED in API + behavior (test/codexsignin.test.js pins
   it). `OAuthSignIn.for(pid)` returns a per-provider engine (cached, single-flight PER provider).

   DOM-free by design: callers pass callbacks and render into their own surface (the brain screen's #codex-*
   block, or a settings row's inline box). Tokens never touch this module — it only sees the sidecar's public
   device-flow endpoints (user_code / verification_uri / status strings).

   Callbacks (all optional):
     onRequesting()                                — the start call is in flight
     onCode({ user_code, verification_uri, open_uri })
                                                   — show the code + verification_uri; OPEN open_uri.
       Two URLs, deliberately: `verification_uri` is the bare, human-typeable address to DISPLAY, while
       `open_uri` is RFC 8628's verification_uri_complete (the same page with ?user_code=… pre-filled),
       falling back to the bare one when the issuer doesn't publish a complete form (codex). Never open the
       bare URL blind: kimi's page is a pure code CONSUMER — landing on
       https://www.kimi.com/code/authorize_device with no user_code renders "Missing user_code parameter"
       and the sign-in is unfinishable, even though the device + poll legs are perfectly healthy.
     onConnected()                                 — the sidecar exchanged + persisted tokens
     onError(message)                              — start failed or the poll reported a hard error
     onTimeout()                                   — the device code expired before the user finished

   Single-flight: start() cancels any in-flight flow first; cancel() aborts silently (screen change /
   disconnect). Matches the app.js behavior it replaces exactly, including the transient-network
   keep-polling rule. */
'use strict';

/* KimiRegion — which Kimi deployment the NEXT sign-in goes to (#70). A Kimi account is either Global (kimi.ai) or
   China (kimi.com) and can only sign in at its own deployment; the sidecar stores the chosen region WITH the
   credential and routes refreshes + inference to it. This only remembers the Commander's pick for the next sign-in
   (a per-browser convenience) and what the sidecar last reported for the stored sign-in. Default for a fresh
   sign-in: the stored sign-in's region when one is known, else Global. DOM-free. */
const KimiRegion = (() => {
  const KEY = 'starnet.kimi.region';
  const OPTIONS = Object.freeze([
    Object.freeze({ id: 'global', label: 'GLOBAL', host: 'kimi.ai' }),
    Object.freeze({ id: 'cn', label: 'CHINA', host: 'kimi.com' })
  ]);
  let known = '';
  const norm = v => { v = String(v == null ? '' : v).trim().toLowerCase(); return v === 'global' || v === 'cn' ? v : ''; };
  function picked() { try { return norm(localStorage.getItem(KEY)); } catch (_) { return ''; } }
  return {
    OPTIONS,
    get() { return picked() || known || 'global'; },
    set(r) { r = norm(r); if (!r) return false; try { localStorage.setItem(KEY, r); } catch (_) {} return true; },
    // the sidecar's word on the STORED sign-in (status/accounts `region`); seeds the default when nothing was picked
    noteSignedIn(r) { r = norm(r); if (r) known = r; },
    label(r) { const o = OPTIONS.find(x => x.id === norm(r)); return o ? o.label + ' · ' + o.host : ''; }
  };
})();

// The internal engine factory — one closure (its own flow/timer) per provider, so two providers can be
// mid-sign-in independently. `paths` holds the three device-flow endpoints for this provider, plus an optional
// `region()` (kimi): the deployment this sign-in goes to, sent as the start body so the sidecar signs in THERE.
function makeOAuthSignIn(paths) {
  let flow = null;    // { device_auth_id, user_code, deadline } — the in-flight device-code login
  let timer = null;   // the poll setTimeout handle

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    flow = null;
  }

  // Kick off the device-code flow: request a code, hand it to the caller, then poll until done.
  async function start(cb) {
    cb = cb || {};
    cancel();
    if (cb.onRequesting) cb.onRequesting();
    let d;
    try {
      const region = typeof paths.region === 'function' ? String(paths.region() || '') : '';
      const r = await fetch(paths.start, region
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ region }) }
        : { method: 'POST' });
      d = await r.json();
      if (!r.ok) throw new Error(d.error || ('start failed (' + r.status + ')'));
    } catch (e) {
      if (cb.onError) cb.onError('could not start sign-in: ' + ((e && e.message) || e));
      return;
    }
    const my = flow = {
      device_auth_id: d.device_auth_id,
      user_code: d.user_code,
      deadline: Date.now() + ((d.expires_in || 900) * 1000)
    };
    // ONE place computes "which URL do we actually open" so no call site can get it wrong.
    if (cb.onCode) cb.onCode({ user_code: d.user_code, verification_uri: d.verification_uri, open_uri: d.verification_uri_complete || d.verification_uri });
    poll(my, d.interval || 5, cb);
  }

  // One poll tick on a timer; the sidecar reports pending until the user finishes, then connects + persists.
  function poll(my, intervalS, cb) {
    timer = setTimeout(async () => {
      if (flow !== my) return;   // superseded / cancelled while waiting
      if (Date.now() > my.deadline) { flow = null; if (cb.onTimeout) cb.onTimeout(); return; }
      let j;
      try {
        const r = await fetch(paths.poll, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_auth_id: my.device_auth_id, user_code: my.user_code }) });
        j = await r.json();
      } catch (e) { j = { status: 'pending' }; }   // transient network blip — keep polling
      if (flow !== my) return;                       // bailed out (back/disconnect) while awaiting
      if (j.status === 'connected') { flow = null; if (cb.onConnected) cb.onConnected(); return; }
      if (j.status === 'error') { flow = null; if (cb.onError) cb.onError('sign-in failed: ' + (j.error || 'try again')); return; }
      poll(my, intervalS, cb);                       // pending — schedule the next tick
    }, Math.max(2, intervalS) * 1000);
  }

  // Forget the stored credentials (the sidecar clears tokens AND any recorded dead-sign-in state).
  async function logout() {
    cancel();
    try { await fetch(paths.logout, { method: 'POST' }); } catch (_) {}
  }

  return { start, cancel, logout, active: () => !!flow };
}

// build the three endpoints for a provider id. Codex is spelled out literally so the codex device-flow
// endpoints (start/poll/logout) stay greppable in source (the source-lock tests pin /api/auth/codex/poll).
function oauthPathsFor(pid) {
  const b = '/api/auth/' + pid;
  return Object.assign({ start: b + '/start', poll: b + '/poll', logout: b + '/logout' }, pid === 'kimi' ? { region: () => KimiRegion.get() } : {});
}

// The codex-bound engine — UNCHANGED public surface (start/cancel/logout/active), so every existing caller and
// test/codexsignin.test.js keep working verbatim. Its endpoints are the literal /api/auth/codex/{start,poll,logout}.
const CodexSignIn = makeOAuthSignIn({ start: '/api/auth/codex/start', poll: '/api/auth/codex/poll', logout: '/api/auth/codex/logout' });

// The generalized registry: one cached engine per provider id, single-flight per provider (each has its own
// closure). CodexSignIn is registered as the codex engine so `OAuthSignIn.for('codex')` returns the SAME driver.
const _oauthEngines = { codex: CodexSignIn };
const OAuthSignIn = {
  for(pid) {
    pid = String(pid || '').trim().toLowerCase();
    if (!pid) return CodexSignIn;
    if (!_oauthEngines[pid]) _oauthEngines[pid] = makeOAuthSignIn(oauthPathsFor(pid));
    return _oauthEngines[pid];
  }
};

/* OAuthAccounts — SUBSCRIPTION STACKING for the device-code subscriptions (codex / grok / kimi): extra sign-ins
   beside the primary. Every flow is the SAME makeOAuthSignIn engine pointed at the account routes — a new account
   only exists once its device sign-in completes (the sidecar creates it then), so cancel() leaves nothing behind.
     OAuthAccounts.for(pid).accounts()        -> { accounts: [{ account, label, primary, connected, expired, email?, coolingUntil }], max } or null
     OAuthAccounts.for(pid).add(cb)           the engine's callbacks (onCode / onConnected / onError / onTimeout)
     OAuthAccounts.for(pid).signIn(id, cb)    sign an existing extra account in again
     OAuthAccounts.for(pid).cancel() · active() · remove(id) -> { ok } */
function makeOAuthAccounts(pid) {
  const base = '/api/auth/' + pid + '/';
  let engine = null;
  const run = (startPath, cb) => {
    if (engine) engine.cancel();
    engine = makeOAuthSignIn(Object.assign({ start: startPath, poll: base + 'account-poll', logout: base + 'accounts' },
      pid === 'kimi' ? { region: () => KimiRegion.get() } : {}));
    return engine.start(cb);
  };
  return {
    async accounts() {
      try {
        const r = await fetch(base + 'accounts');
        if (!r.ok) return null;   // a refused answer is not an empty account list
        const j = await r.json();
        return (j && Array.isArray(j.accounts)) ? j : null;
      } catch (_) { return null; }
    },
    add(cb) { return run(base + 'add', cb); },
    signIn(account, cb) { return run(base + 'account-start?account=' + encodeURIComponent(account), cb); },
    cancel() { if (engine) engine.cancel(); },
    active() { return !!(engine && engine.active()); },
    async remove(account) {
      try {
        const r = await fetch(base + 'remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: String(account || '') }) });
        const j = await r.json();
        return { ok: !!(j && j.ok) };
      } catch (_) { return { ok: false }; }
    }
  };
}
const _oauthAccountEngines = {};
const OAuthAccounts = {
  for(pid) {
    pid = String(pid || '').trim().toLowerCase();
    if (!_oauthAccountEngines[pid]) _oauthAccountEngines[pid] = makeOAuthAccounts(pid);
    return _oauthAccountEngines[pid];
  }
};

/* ClaudeCliSignIn — SIGN IN WITH CLAUDE for surfaces outside the brain screen (Settings → PROVIDERS). Not a device
   code: the sidecar runs the user's own `claude auth login` (it opens the browser and keeps the token; StarNet
   never sees it) and /api/auth/claude-cli/* reports what the CLI proved. DOM-free like the engine above.
     status(account?)       -> the sidecar's { installed, loggedIn, authMethod, email?, subscription?, signingIn } or null
     accounts()             -> { accounts: [{ account, label, primary, coolingUntil, installed, loggedIn, … }], max } or null
     start(cb, opts?)       cb.onStarting() · cb.onPending({ url, account }) · cb.onConnected(status) · cb.onError(msg, code)
                            opts.account = sign in that extra account; opts.add = create a NEW account and sign it in
     submitCode(code)       -> { ok, error? } — the code the fallback sign-in page shows, relayed to the CLI's stdin
     cancel()               stops polling and kills the login child (an abandoned ADD also removes the empty account)
     remove(account)        -> { ok, signedOut } — the CLI signs that account out and its folder is deleted
   SUBSCRIPTION STACKING: every extra account is its own CLI sign-in; when the one a run is on hits its usage limit,
   the run continues on the next. "Connected" is only ever reported once that account's own `claude auth status`
   says signed in — and a flow that ends on an already-landed sign-in is connected, never an error. */
function makeClaudeCliSignIn() {
  const base = '/api/auth/claude-cli/';
  let flow = null, timer = null;
  async function call(verb, body) {
    try {
      const r = await fetch(base + verb, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (_) { return null; }
  }
  function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  // the default sign-in's calls stay exactly as they were: `account` rides only for an extra account
  const acct = (body, account) => (account ? Object.assign(body, { account }) : body);
  async function status(account) {
    const j = await call('status' + (account ? '?account=' + encodeURIComponent(account) : ''));
    return (j && typeof j.installed === 'boolean') ? j : null;
  }
  async function accounts() {
    const j = await call('accounts');
    return (j && Array.isArray(j.accounts)) ? j : null;
  }
  async function start(cb, opts) {
    cb = cb || {}; opts = opts || {};
    stopTimer(); flow = null;
    if (cb.onStarting) cb.onStarting();
    const j = opts.add ? await call('add', {}) : await call('start', acct({}, String(opts.account || '')));
    const account = String((opts.add ? j && j.account : opts.account) || '');
    if (!j) { if (cb.onError) cb.onError('couldn’t start the Claude sign-in — try again', ''); return; }
    if (j.status === 'connected') { if (cb.onConnected) cb.onConnected(Object.assign({ account }, j)); return; }
    if (j.status !== 'pending') { if (cb.onError) cb.onError(j.error || 'Claude sign-in failed', j.code || ''); return; }
    const my = flow = { login_id: j.login_id, url: j.url || '', account, added: !!opts.add };
    if (cb.onPending) cb.onPending({ url: my.url, account });
    poll(my, cb);
  }
  function poll(my, cb) {
    timer = setTimeout(async () => {
      timer = null;
      if (flow !== my) return;
      const j = await call('poll', acct({ login_id: my.login_id }, my.account));
      if (flow !== my) return;
      if (!j || j.status === 'pending') { poll(my, cb); return; }   // a transient network blip keeps polling
      flow = null;
      if (j.status === 'connected') { if (cb.onConnected) cb.onConnected(Object.assign({ account: my.account }, j)); return; }
      const st = await status(my.account);
      if (st && st.loggedIn) { if (cb.onConnected) cb.onConnected(Object.assign({ account: my.account }, st)); return; }
      if (cb.onError) cb.onError(j.error || 'Claude sign-in did not finish — try again', j.code || '');
    }, 1500);
  }
  async function submitCode(code) {
    const my = flow;
    if (!my) return { ok: false, error: 'no Claude sign-in is running — press SIGN IN again' };
    const j = await call('code', acct({ login_id: my.login_id, code: String(code || '') }, my.account));
    return (j && j.ok) ? { ok: true } : { ok: false, error: (j && j.error) || 'that code didn’t go through — try pasting it again' };
  }
  async function cancel() {
    const my = flow; flow = null; stopTimer();
    if (!my) return;
    await call('cancel', acct({ login_id: my.login_id }, my.account));
    if (my.added && my.account) await call('remove', { account: my.account });   // it never signed in: leave nothing behind
  }
  async function remove(account) {
    const j = await call('remove', { account: String(account || '') });
    return (j && typeof j.ok === 'boolean') ? j : { ok: false };
  }
  return { status, accounts, start, submitCode, cancel, remove, active: () => !!flow, flowAccount: () => (flow ? flow.account : null) };
}
const ClaudeCliSignIn = makeClaudeCliSignIn();

if (typeof module !== 'undefined' && module.exports) { module.exports = CodexSignIn; module.exports.OAuthSignIn = OAuthSignIn; module.exports.ClaudeCliSignIn = ClaudeCliSignIn; module.exports.makeClaudeCliSignIn = makeClaudeCliSignIn; module.exports.OAuthAccounts = OAuthAccounts; module.exports.KimiRegion = KimiRegion; }
if (typeof window !== 'undefined') { window.CodexSignIn = CodexSignIn; window.OAuthSignIn = OAuthSignIn; window.ClaudeCliSignIn = ClaudeCliSignIn; window.OAuthAccounts = OAuthAccounts; window.KimiRegion = KimiRegion; }
