/* node test/credits-link.test.js — the device-pairing client + durable link store (sidecar/credits-link.js):
   config-gating (no STARNET_CLOUD_URL => zero surface), the start/poll happy path against a STUBBED cloud
   (fake fetch, no real network), the pollSecret-stays-server-side invariant, the credits.json persistence
   round-trip (proxy for boot-from-file construction), and unlink. No real IO beyond a temp dir. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makeCreditsLink } = require('../sidecar/credits-link.js');

const flush = () => new Promise(r => setTimeout(r, 0));

// a fake StarNet Cloud: link/start mints a code+pollSecret; link/poll flips to confirmed once `confirm()` is called.
function fakeCloud(opts) {
  opts = opts || {};
  const state = { code: opts.code || 'STAR-7F3K', pollSecret: 'ps_secret_' + Math.random().toString(36).slice(2), confirmed: false, released: false };
  const calls = [];
  const json = (obj, ok) => Promise.resolve({ ok: ok !== false, status: ok === false ? 500 : 200, json: () => Promise.resolve(obj) });
  const cloud = {
    state, calls,
    confirm() { state.confirmed = true; },
    fetch(url, init) {
      const u = String(url);
      let body = {}; try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (_) {}
      calls.push({ url: u, method: (init && init.method) || 'GET', body });
      if (u.indexOf('/v1/link/start') >= 0) {
        return json({ code: state.code, pollSecret: state.pollSecret, verifyUrl: 'https://cloud.example/link?code=' + state.code, expiresAt: 9999 });
      }
      if (u.indexOf('/v1/link/poll') >= 0) {
        if (body.pollSecret !== state.pollSecret) return json({ status: 'pending' });   // wrong secret never confirms
        if (!state.confirmed) return json({ status: 'pending' });
        if (state.released) return json({ status: 'consumed' });
        state.released = true;
        return json({
          status: 'confirmed',
          deviceToken: Object.prototype.hasOwnProperty.call(opts, 'deviceToken') ? opts.deviceToken : 'snd_devtoken_abc',
          accountId: Object.prototype.hasOwnProperty.call(opts, 'accountId') ? opts.accountId : 'acct_42'
        });
      }
      return json({}, false);
    }
  };
  return cloud;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-link-'));
  const dir = path.join(tmp, '.secrets');
  const file = path.join(dir, 'credits.json');

  // ---- NOT CONFIGURED: no cloud URL => inert; start refuses; nothing persisted (routes would 404) ----
  {
    const cloud = fakeCloud();
    const link = makeCreditsLink({ cloudUrl: '', fetch: cloud.fetch, fsp, fs, pathMod: path, dir, now: () => 1000 });
    A.eq(link.configured(), false, 'no STARNET_CLOUD_URL => configured() false (link routes 404, no LINK card)');
    const s = await link.start('X');
    A.eq(s.ok, false, 'start() refuses when unconfigured');
    A.eq(cloud.calls.length, 0, 'unconfigured client makes NO network calls');
    A.eq(link.hasSaved(), false, 'nothing persisted when unconfigured');
  }

  // ---- HAPPY PATH: start -> code returned, pollSecret WITHHELD -> poll pending -> confirm -> poll confirmed,
  //      persists credits.json; loadSavedSync round-trips the record (this is the boot-from-file construction) ----
  {
    const cloud = fakeCloud();
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example/', fetch: cloud.fetch, fsp, fs, pathMod: path, dir, now: () => 2000 });
    A.eq(link.configured(), true, 'a STARNET_CLOUD_URL makes linking available');

    const s = await link.start('My Station');
    A.eq(s.ok, true, 'start() ok');
    A.eq(s.code, 'STAR-7F3K', 'start returns the pairing code');
    A.ok(String(s.verifyUrl).indexOf('STAR-7F3K') >= 0, 'verifyUrl embeds the code');
    A.eq(s.pollSecret, undefined, 'start result NEVER exposes the pollSecret (server-side only)');

    const p1 = await link.poll('STAR-7F3K');
    A.eq(p1.status, 'pending', 'poll is pending before confirmation');
    A.eq(link.hasSaved(), false, 'no token persisted while pending');

    cloud.confirm();
    const p2 = await link.poll('STAR-7F3K');
    A.eq(p2.status, 'confirmed', 'poll flips to confirmed after the site confirm');
    A.eq(p2.accountId, 'acct_42', 'confirmed poll carries the accountId');

    // the poll body carried the pollSecret to the cloud (proving it was held + used server-side)
    const pollCall = cloud.calls.find(c => c.url.indexOf('/v1/link/poll') >= 0 && c.body.pollSecret);
    A.eq(pollCall.body.pollSecret, cloud.state.pollSecret, 'the sidecar polls the cloud WITH the stored pollSecret');

    // persistence round-trip == boot-from-file construction
    A.eq(link.hasSaved(), true, 'a confirmed link persists credits.json');
    A.ok(fs.existsSync(file), 'credits.json exists on disk');
    const saved = link.loadSavedSync();
    A.eq(saved.url, 'https://cloud.example', 'saved url = the cloud base (trailing slash trimmed)');
    A.eq(saved.deviceToken, 'snd_devtoken_abc', 'saved deviceToken round-trips');
    A.eq(saved.accountId, 'acct_42', 'saved accountId round-trips');
    // the persisted file must NOT contain the pollSecret (only the durable device token)
    const raw = fs.readFileSync(file, 'utf8');
    A.eq(raw.indexOf(cloud.state.pollSecret), -1, 'the pollSecret is never written to disk');

    // a fresh client over the SAME dir reads the record (a sidecar restart would come up configured)
    const link2 = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: cloud.fetch, fsp, fs, pathMod: path, dir, now: () => 3000 });
    const rehydrated = link2.loadSavedSync();
    A.eq(rehydrated.deviceToken, 'snd_devtoken_abc', 'a new client (restart) rehydrates the linked token from disk');

    // ---- UNLINK: deletes the file, reverts to inert ----
    const u = await link.clearSaved();
    A.eq(u.ok, true, 'clearSaved ok');
    A.eq(u.removed, true, 'clearSaved reports the file removed');
    A.eq(link.hasSaved(), false, 'after unlink nothing is persisted');
    A.eq(fs.existsSync(file), false, 'credits.json is gone after unlink');
    const u2 = await link.clearSaved();
    A.eq(u2.ok, true, 'unlink is idempotent (ENOENT is a success)');
  }

  // ---- UNKNOWN CODE: polling a code we never started here yields 'unknown' (frontend restarts the flow) ----
  {
    const cloud = fakeCloud();
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: cloud.fetch, fsp, fs, pathMod: path, dir, now: () => 4000 });
    const p = await link.poll('STAR-NOPE');
    A.eq(p.status, 'unknown', 'polling an unknown code (no stored secret) reports unknown, makes no cloud call');
    A.eq(cloud.calls.filter(c => c.url.indexOf('/v1/link/poll') >= 0).length, 0, 'no poll network call for an unknown code');
  }

  // ---- INVALID CONFIRMATION: status alone is not identity. Never persist a bearer without its account. ----
  {
    const badDir = path.join(tmp, 'bad-confirm');
    const cloud = fakeCloud({ code: 'STAR-BAD1', accountId: '' });
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: cloud.fetch, fsp, fs, pathMod: path, dir: badDir, now: () => 4500 });
    await link.start('Station'); cloud.confirm();
    const p = await link.poll('STAR-BAD1');
    A.eq(p.status, 'invalid', 'a confirmation without an account id is rejected');
    A.eq(p.error, 'invalid_confirmation', 'the malformed identity handoff is explicit');
    A.eq(link.hasSaved(), false, 'a malformed confirmation never persists a spending credential');
  }

  // ---- LINK REQUEST TIMEOUT: a dead cloud cannot leave the creator waiting forever. ----
  {
    const hung = (url, init) => new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: hung, fsp, fs, pathMod: path, dir: path.join(tmp, 'hung'), now: () => 4600, requestTimeoutMs: 5 });
    let timedOut = false;
    try { await link.start('Station'); } catch (e) { timedOut = e && e.name === 'AbortError'; }
    A.eq(timedOut, true, 'a hung link-start request aborts within the configured bound');
    A.eq(link.hasSaved(), false, 'a timed-out link request persists nothing');
  }

  // Fetch resolves at headers. A cloud that then stalls its JSON body is still a hung request and owes the
  // same bound; clearing the timer at headers used to strand the creator indefinitely.
  {
    const stalledBody = (url, init) => Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      })
    });
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: stalledBody, fsp, fs, pathMod: path, dir: path.join(tmp, 'stalled-body'), now: () => 4700, requestTimeoutMs: 5 });
    let timedOut = false;
    try { await link.start('Station'); } catch (e) { timedOut = e && e.name === 'AbortError'; }
    A.eq(timedOut, true, 'link-start also aborts when headers arrive but the JSON body stalls');
    A.eq(link.hasSaved(), false, 'a body-timeout persists no partial link identity');
  }

  // ---- KEYCHAIN ADOPTION: the desktop strips `deviceToken` from credits.json and injects it at spawn as
  //      STARNET_CREDITS_TOKEN. The station must stay linked across that move, and the non-secret fields
  //      (url/accountId/linkedAt) must survive it — they are NOT part of what gets adopted. ----
  {
    const kcDir = path.join(tmp, 'kc'); const kcFile = path.join(kcDir, 'credits.json');
    fs.mkdirSync(kcDir, { recursive: true });
    // exactly what Rust leaves behind after adoption: the record MINUS the token
    fs.writeFileSync(kcFile, JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_kc', linkedAt: 7 }));

    const withoutEnv = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: fakeCloud().fetch, fsp, fs, pathMod: path, dir: kcDir, now: () => 5000 });
    A.eq(withoutEnv.hasSaved(), false, 'a stripped file alone is NOT a linked station (no token anywhere)');
    A.eq(withoutEnv.tokenAtRest(), 'none', 'and it honestly reports no token at rest');

    const withEnv = makeCreditsLink({
      cloudUrl: 'https://cloud.example', fetch: fakeCloud().fetch, fsp, fs, pathMod: path, dir: kcDir,
      now: () => 5000, envToken: 'snd_from_keychain'
    });
    const rec = withEnv.loadSavedSync();
    A.ok(!!rec, 'stripped file + injected token = still linked (the whole point of adoption)');
    A.eq(rec.deviceToken, 'snd_from_keychain', 'the token comes from the keychain injection');
    A.eq(rec.accountId, 'acct_kc', 'accountId survives adoption (only deviceToken is removed)');
    A.eq(rec.url, 'https://cloud.example', 'url survives adoption');
    A.eq(rec.linkedAt, 7, 'linkedAt survives adoption');
    A.eq(withEnv.tokenAtRest(), 'keychain', 'reports the token now rests in the keychain');
  }

  // ---- SAME-SESSION ADOPTION (2026-08-22): the process that performed the link was spawned BEFORE the link,
  //      so it has NO envToken. Seconds later the shell strips deviceToken from the file. That process must
  //      keep resolving the token it already proved — otherwise the managed provider has no bearer and no
  //      base URL until a full app restart ("catalog offline", WAKE refused right after linking). ----
  {
    const sDir = path.join(tmp, 'same'); const sFile = path.join(sDir, 'credits.json');
    fs.mkdirSync(sDir, { recursive: true });
    fs.writeFileSync(sFile, JSON.stringify({ url: 'https://cloud.example', deviceToken: 'snd_linked_now', accountId: 'acct_s', linkedAt: 11 }));
    const live = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: fakeCloud().fetch, fsp, fs, pathMod: path, dir: sDir, now: () => 7000 });
    A.eq(live.loadSavedSync().deviceToken, 'snd_linked_now', 'pre-adoption: the file token is read (and remembered)');
    // the shell adopts: keychain holds it, file is stripped — same running process, still no envToken
    fs.writeFileSync(sFile, JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_s', linkedAt: 11 }));
    const afterAdopt = live.loadSavedSync();
    A.ok(!!afterAdopt && afterAdopt.deviceToken === 'snd_linked_now', 'after adoption the SAME process still resolves the token it linked with (no restart needed)');
    A.eq(live.tokenAtRest(), 'keychain', 'and reports the token at rest in the keychain');
    // a DIFFERENT process with no injected token never inherits it — the memory is per-process, not a file
    const fresh = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: fakeCloud().fetch, fsp, fs, pathMod: path, dir: sDir, now: () => 7000 });
    A.eq(fresh.hasSaved(), false, 'a fresh process without the keychain injection is NOT linked (nothing leaks through the file)');
    // unlink forgets the live token too
    await live.clearSaved();
    A.eq(live.hasSaved(), false, 'unlink in the linking process forgets the remembered token');
  }

  // ---- PRE-ADOPTION PRECEDENCE: between the link and the desktop's adopt call the token IS in the file.
  //      The file copy must win, so a relink cannot be shadowed by a stale injected token. ----
  {
    const pDir = path.join(tmp, 'pre'); const pFile = path.join(pDir, 'credits.json');
    fs.mkdirSync(pDir, { recursive: true });
    fs.writeFileSync(pFile, JSON.stringify({ url: 'https://cloud.example', deviceToken: 'snd_fresh_from_link', accountId: 'acct_new', linkedAt: 9 }));
    const link = makeCreditsLink({
      cloudUrl: 'https://cloud.example', fetch: fakeCloud().fetch, fsp, fs, pathMod: path, dir: pDir,
      now: () => 6000, envToken: 'snd_stale_from_last_launch'
    });
    A.eq(link.loadSavedSync().deviceToken, 'snd_fresh_from_link', 'the file token wins over a stale injected one');
    A.eq(link.tokenAtRest(), 'file', 'and it reports the token is still on disk (not yet adopted)');
    // The shell now adopts the NEW token and strips it from the file. This running sidecar's envToken is still
    // frozen to the OLD launch-time keychain value; the remembered fresh token must continue to win.
    fs.writeFileSync(pFile, JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_new', linkedAt: 9 }));
    const afterAdopt = link.loadSavedSync();
    A.eq(afterAdopt.deviceToken, 'snd_fresh_from_link', 'after relink adoption, the fresh session token beats the stale launch-time keychain token');
    A.eq(afterAdopt.accountId, 'acct_new', 'the winning fresh token remains bound to the newly confirmed account');
  }

  // ---- UNLINK BEATS THE INJECTED TOKEN: process.env still holds the token after the keychain entry is
  //      deleted, so without an in-process latch the station would look linked until the next restart. ----
  {
    const uDir = path.join(tmp, 'unl'); const uFile = path.join(uDir, 'credits.json');
    fs.mkdirSync(uDir, { recursive: true });
    fs.writeFileSync(uFile, JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_u', linkedAt: 1 }));
    const link = makeCreditsLink({
      cloudUrl: 'https://cloud.example', fetch: fakeCloud().fetch, fsp, fs, pathMod: path, dir: uDir,
      now: () => 7000, envToken: 'snd_injected'
    });
    A.eq(link.hasSaved(), true, 'linked via the injected token');
    await link.clearSaved();
    A.eq(link.hasSaved(), false, 'UNLINK takes effect immediately, even though process.env still holds the token');
    A.eq(link.tokenAtRest(), 'none', 'and nothing is reported at rest');
  }

  // ---- RELINK AFTER UNLINK: the latch must not permanently deafen a process that links again. ----
  {
    const rDir = path.join(tmp, 'relink');
    fs.mkdirSync(rDir, { recursive: true });
    const cloud = fakeCloud({ code: 'STAR-RE01' });
    const link = makeCreditsLink({
      cloudUrl: 'https://cloud.example', fetch: cloud.fetch, fsp, fs, pathMod: path, dir: rDir,
      now: () => 8000, envToken: 'snd_injected'
    });
    await link.clearSaved();
    A.eq(link.hasSaved(), false, 'unlinked');
    await link.start('Station');
    cloud.confirm();
    const p = await link.poll('STAR-RE01');
    A.eq(p.status, 'confirmed', 'relink confirms');
    A.eq(link.hasSaved(), true, 'a fresh link clears the unlink latch');
  }

  await flush();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  A.report('credits-link.test');
})();
