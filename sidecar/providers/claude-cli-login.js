/* sidecar/providers/claude-cli-login.js — SIGN IN WITH CLAUDE for the claude-cli brain.

   StarNet never holds a Claude subscription credential. This driver only runs the user's own Claude Code CLI:
   `claude auth login --claudeai` opens the browser, completes the OAuth handshake itself and stores the token in
   the CLI's own credential store. StarNet watches that child and asks `claude auth status` for the verdict.

   The CLI offers two ways to finish (both proven on v2.1.284 with no terminal attached):
     1. automatic — the browser it opened calls back to the CLI, and the child exits 0.
     2. manual    — the CLI prints a fallback authorize URL and waits on stdin ("Paste code here if prompted >").
                    That page shows a one-time code; submitCode() writes it to the child's stdin. The code is
                    passed through and never logged or stored.

   ONE login child at a time (a second start() replaces the first). It is killed on cancel, on the TTL, and when
   the sidecar exits, so a half-finished sign-in never outlives the station.

   makeClaudeCliLogin({ host?, spawn?, env?, platform?, fs?, os?, clock?, ttlMs?, urlWaitMs? })
     start()               -> { status:'pending', login_id, url } | { status:'connected', ... } | { status:'error', error, code }
     poll(login_id)        -> { status:'pending' } | { status:'connected', authMethod, email?, subscription? } | { status:'error', ... }
     submitCode(id, code)  -> { ok:true } | { ok:false, error }
     cancel(login_id)      -> { ok:true }
     status()              -> { installed, loggedIn, authMethod, email?, subscription?, signingIn, error? } */
'use strict';
const crypto = require('crypto');
const { makeCliHost } = require('./claude-cli.js');
const { makeBreakaway } = require('../breakaway.js');

const AUTHORIZE_URL_RE = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/;

function makeClaudeCliLogin(opts) {
  opts = opts || {};
  const host = opts.host || makeCliHost(opts);
  /* The CLI opens the person's BROWSER, which it starts when none is running. Inside the desktop shell's station job
     that browser would be the station's — a StarNet crash would close it, a quit would end its helper processes. So the
     login runs TETHERED (sidecar/breakaway.js): outside the job, still ended with its launcher (cancel, TTL, sidecar
     exit — end() kills the launcher's tree — and a hard kill of StarNet), while the browser it opens is in no job.
     No launcher named (macOS, Linux, `npm start`, a test host): a plain spawn, exactly as before. */
  const spawnLogin = makeBreakaway({ env: host.env || {}, platform: host.platform || process.platform }).spawnVia((f, a, o) => host.spawn(f, a, o), { tether: true });
  const ttlMs = opts.ttlMs || 10 * 60 * 1000;           // an abandoned sign-in is killed, never left listening
  const urlWaitMs = opts.urlWaitMs || 8000;             // how long start() waits for the CLI to print its URL
  // poll re-asks `claude auth status` every Nth poll (the tile polls every 1.5s, so 2 = ~3s) — a count, not a clock
  const statusEveryPolls = Math.max(1, opts.statusEveryPolls || 2);
  let flow = null;   // { id, child, url, exit: null|{code}, stderr, timer }

  function end(f) {
    if (!f) return;
    if (f.timer) { clearTimeout(f.timer); f.timer = null; }
    host.killTree(f.child);
    if (flow === f) flow = null;
  }
  function publicStatus(st) {
    const out = { installed: !!st.installed, loggedIn: !!st.loggedIn, authMethod: st.authMethod || '' };
    if (st.email) out.email = st.email;
    if (st.subscription) out.subscription = st.subscription;
    if (st.error) { out.error = st.error.message; out.code = st.error.code || ''; }
    return out;
  }
  function tail(text) {
    return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' ')
      .replace(AUTHORIZE_URL_RE, '[sign-in link]').slice(0, 300);
  }

  async function status() {
    const st = publicStatus(await host.authStatus());
    st.signingIn = !!(flow && !flow.exit);
    return st;
  }

  async function start() {
    end(flow);
    const cmd = host.command();
    if (!cmd) { const e = host.notInstalled(); return { status: 'error', error: e.message, code: 'not_installed' }; }
    let child;
    try {
      child = spawnLogin(cmd.file, cmd.pre.concat(['auth', 'login', '--claudeai']), { env: host.childEnv(), cwd: host.os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return { status: 'error', error: host.notInstalled().message, code: 'not_installed' };
    }
    const f = { id: crypto.randomUUID(), child, url: '', exit: null, stderr: '', out: '', timer: null };
    flow = f;
    f.timer = setTimeout(() => { if (!f.exit) f.expired = true; end(f); }, ttlMs);
    if (f.timer.unref) f.timer.unref();
    let urlSeen = null;
    const urlReady = new Promise(r => { urlSeen = r; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      f.out = (f.out + d).slice(-8000);
      const m = AUTHORIZE_URL_RE.exec(f.out);
      if (m && !f.url) { f.url = m[0]; urlSeen(); }
    });
    child.stderr.on('data', d => { f.stderr = (f.stderr + d).slice(-4000); });
    child.stdin.on('error', () => {});   // a child that already exited surfaces through its exit, not EPIPE
    child.on('error', e => { f.exit = { code: -1, spawnError: e }; urlSeen(); });
    child.on('close', code => { f.exit = f.exit || { code }; if (f.timer) { clearTimeout(f.timer); f.timer = null; } urlSeen(); });
    let waitTimer;
    await Promise.race([urlReady, new Promise(r => { waitTimer = setTimeout(r, urlWaitMs); })]);
    clearTimeout(waitTimer);
    if (f.exit) return settle(f);
    return { status: 'pending', login_id: f.id, url: f.url || '' };
  }

  // The child has exited: the ONLY proof of "connected" is `claude auth status` saying so afterwards.
  async function settle(f) {
    if (f.exit && f.exit.spawnError) {
      if (flow === f) flow = null;
      return { status: 'error', error: host.notInstalled().message, code: 'not_installed' };
    }
    const st = await host.authStatus();
    if (flow === f) flow = null;
    if (st.loggedIn) return Object.assign({ status: 'connected' }, publicStatus(st));
    const why = tail(f.stderr) || tail(f.out);
    return { status: 'error', error: 'Claude sign-in did not finish' + (why ? ' — ' + why : '') + ' — sign in again to retry.', code: 'login_failed' };
  }

  async function poll(id) {
    const f = flow;
    if (!f || f.id !== String(id || '')) return { status: 'error', error: 'this sign-in is no longer running — press SIGN IN WITH CLAUDE again', code: 'login_not_found' };
    if (!f.exit) {
      // the credential can land before the child exits (it may linger on its paste prompt): proven sign-in wins
      f.polls = (f.polls || 0) + 1;
      if (f.polls % statusEveryPolls === 0) {
        const st = await host.authStatus();
        if (st.loggedIn && flow === f) { end(f); return Object.assign({ status: 'connected' }, publicStatus(st)); }
      }
      return { status: 'pending' };
    }
    return settle(f);
  }

  function submitCode(id, code) {
    const f = flow;
    if (!f || f.id !== String(id || '') || f.exit) return { ok: false, error: 'this sign-in is no longer running — press SIGN IN WITH CLAUDE again' };
    const clean = String(code || '').replace(/[\r\n]+/g, '').trim();
    if (!clean || clean.length > 512) return { ok: false, error: 'that does not look like a sign-in code' };
    try { f.child.stdin.write(clean + '\n'); } catch (_) { return { ok: false, error: 'the Claude sign-in stopped listening — press SIGN IN WITH CLAUDE again' }; }
    return { ok: true };
  }

  function cancel(id) {
    if (flow && (!id || flow.id === String(id))) end(flow);
    return { ok: true };
  }

  function shutdown() { end(flow); }

  return { start, poll, submitCode, cancel, status, shutdown, _flow: () => flow };
}

module.exports = { makeClaudeCliLogin, AUTHORIZE_URL_RE };
