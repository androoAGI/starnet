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

  // ---- UNLINK DURABILITY FAILURE: the tombstone is what stops a surviving injected token from silently
  //      self-healing on restart. If that write fails, deleting credits.json is useful but NOT a completed
  //      unlink, so the caller must receive failure and be able to retry the tombstone write. ----
  {
    const fDir = path.join(tmp, 'unlink-write-fail'); const fFile = path.join(fDir, 'credits.json');
    fs.mkdirSync(fDir, { recursive: true });
    fs.writeFileSync(fFile, JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_f', linkedAt: 1 }));
    let failTombstone = true;
    const failingFsp = Object.assign({}, fsp, {
      writeFile: async (target, ...args) => {
        if (failTombstone && String(target).endsWith('credits.unlinked.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return fsp.writeFile(target, ...args);
      }
    });
    const link = makeCreditsLink({
      cloudUrl: 'https://cloud.example', fetch: () => Promise.reject(new Error('offline')), fsp: failingFsp,
      fs, pathMod: path, dir: fDir, now: () => 3500, envToken: 'snd_survived'
    });
    const failed = await link.clearSaved();
    A.eq(failed.ok, false, 'a missing durable unlink tombstone is never reported as success');
    A.eq(failed.removed, true, 'the bearer file is still removed when the tombstone write fails');
    A.eq(link.hasSaved(), false, 'the live process honours the unlink immediately');
    failTombstone = false;
    const retry = await link.clearSaved();
    A.eq(retry.ok, true, 'a later retry can finish the durable unlink after the record is already gone');
    const fresh = makeCreditsLink({
      cloudUrl: 'https://cloud.example', fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ accountId: 'acct_f' }) }),
      fsp, fs, pathMod: path, dir: fDir, now: () => 3600, envToken: 'snd_survived'
    });
    A.eq((await fresh.healFromEnv()).reason, 'unlink_tombstone', 'a restart cannot resurrect the link after the successful retry');
  }

  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/handleCreditsUnlink[\s\S]*?creditsJson\(res, ok \? 200 : 500, \{ ok, unlinked: ok/.test(hostSource),
    'the HTTP route fails truthfully instead of returning 200/unlinked:true for a rejected durable unlink');

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
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: hung, fsp, fs, pathMod: path, dir: path.join(tmp, 'hung'), now: () => 4600, requestTimeoutMs: 5, linkRetryMs: 0 });
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
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: stalledBody, fsp, fs, pathMod: path, dir: path.join(tmp, 'stalled-body'), now: () => 4700, requestTimeoutMs: 5, linkRetryMs: 0 });
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

  // ---- BOOT SELF-HEAL (2026-08-25 stranded-user incident): a reinstall deletes credits.json but the
  //      keychain token survives and is injected back as envToken. healFromEnv() rebuilds the record ONLY
  //      after the cloud vouches for the token (/v1/whoami) — and refuses on every guard: an existing link,
  //      a same-session unlink, an unlink tombstone on disk, a revoked token, an unreachable cloud. ----
  {
    const mkWhoamiFetch = (opts) => {
      opts = opts || {};
      const calls = [];
      const fn = (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).indexOf('/v1/whoami') >= 0) {
          if (opts.revoked) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: { message: 'unauthorized' } }) });
          if (opts.unreachable) return Promise.reject(new Error('ECONNREFUSED'));
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, accountId: 'acct_healed' }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      };
      fn.calls = calls;
      return fn;
    };

    // happy path: keychain token + empty dir -> whoami -> record rebuilt, station linked again, zero clicks
    {
      const hDir = path.join(tmp, 'heal');
      const f = mkWhoamiFetch();
      const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: f, fsp, fs, pathMod: path, dir: hDir, now: () => 9000, envToken: 'snd_keychain_survivor' });
      A.eq(link.hasSaved(), false, 'reinstall state: token in keychain, no link record');
      const r = await link.healFromEnv();
      A.eq(r.healed, true, 'the link self-heals from the surviving keychain token');
      A.eq(r.accountId, 'acct_healed', 'the account comes from the cloud, never guessed');
      A.eq(link.hasSaved(), true, 'the rebuilt record persists — the station is linked again');
      A.eq(link.loadSavedSync().accountId, 'acct_healed', 'the record carries the whoami account');
      const who = f.calls.find(c => c.url.indexOf('/v1/whoami') >= 0);
      A.eq(who.init.headers.Authorization, 'Bearer snd_keychain_survivor', 'the heal authenticates with the injected token');
      // idempotent: a linked station heals nothing
      A.eq((await link.healFromEnv()).reason, 'already_linked', 'a live link refuses the heal (nothing to do)');
    }

    // a REVOKED token heals nothing — the cloud's 401 is the gate that stops resurrecting a dead link
    {
      const rDir = path.join(tmp, 'heal-revoked');
      const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: mkWhoamiFetch({ revoked: true }), fsp, fs, pathMod: path, dir: rDir, now: () => 9100, envToken: 'snd_dead_token' });
      const r = await link.healFromEnv();
      A.eq(r.healed, false, 'a revoked token cannot seed a heal');
      A.eq(r.reason, 'token_revoked', 'and the refusal says why');
      A.eq(link.hasSaved(), false, 'nothing persisted');
    }

    // an UNREACHABLE cloud degrades to the pre-heal behavior: honestly unlinked, no record invented
    {
      const uDir = path.join(tmp, 'heal-offline');
      const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: mkWhoamiFetch({ unreachable: true }), fsp, fs, pathMod: path, dir: uDir, now: () => 9200, envToken: 'snd_tok' });
      const r = await link.healFromEnv();
      A.eq(r.healed, false, 'offline cloud: no heal');
      A.eq(r.reason, 'unreachable', 'named honestly');
      A.eq(link.hasSaved(), false, 'no record invented while blind');
    }

    // the UNLINK TOMBSTONE outranks the keychain: clearSaved writes it, healFromEnv refuses on it,
    // and a FRESH process (new spawn, token still injected from a failed keychain clear) refuses too.
    {
      const tDir = path.join(tmp, 'heal-tomb'); const tFile = path.join(tDir, 'credits.json');
      fs.mkdirSync(tDir, { recursive: true });
      fs.writeFileSync(tFile, JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_t', linkedAt: 1 }));
      const f = mkWhoamiFetch();
      const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: f, fsp, fs, pathMod: path, dir: tDir, now: () => 9300, envToken: 'snd_injected' });
      await link.clearSaved();
      A.eq((await link.healFromEnv()).reason, 'unlinked_this_session', 'same session: the unlink latch refuses first');
      const fresh = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: mkWhoamiFetch(), fsp, fs, pathMod: path, dir: tDir, now: () => 9400, envToken: 'snd_injected' });
      const r = await fresh.healFromEnv();
      A.eq(r.healed, false, 'a fresh process after an unlink does NOT resurrect the link from the keychain');
      A.eq(r.reason, 'unlink_tombstone', 'the Commander\'s unlink outranks the surviving keychain token');
      // a REAL relink clears the tombstone, so healing works again after future reinstalls
      const cloud2 = fakeCloud({ code: 'STAR-HE01', deviceToken: 'snd_new', accountId: 'acct_new' });
      const relink = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: cloud2.fetch, fsp, fs, pathMod: path, dir: tDir, now: () => 9500 });
      await relink.start('Station'); cloud2.confirm();
      A.eq((await relink.poll('STAR-HE01')).status, 'confirmed', 'relink confirms');
      A.eq(fs.existsSync(path.join(tDir, 'credits.unlinked.json')), false, 'a fresh link removes the tombstone');
    }

    // UNLINK now also kills the token CLOUD-side (best-effort): the dying bearer rides to /v1/link/revoke
    {
      const vDir = path.join(tmp, 'unlink-revoke'); const vFile = path.join(vDir, 'credits.json');
      fs.mkdirSync(vDir, { recursive: true });
      fs.writeFileSync(vFile, JSON.stringify({ url: 'https://cloud.example', deviceToken: 'snd_dying', accountId: 'acct_v', linkedAt: 2 }));
      const f = mkWhoamiFetch();
      const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: f, fsp, fs, pathMod: path, dir: vDir, now: () => 9600 });
      await link.clearSaved();
      const rev = f.calls.find(c => c.url.indexOf('/v1/link/revoke') >= 0);
      A.ok(rev, 'unlink fires the cloud-side revoke');
      A.eq(rev.init.headers.Authorization, 'Bearer snd_dying', 'with the dying token as bearer');
      A.eq(link.hasSaved(), false, 'and the local unlink still completes');
      // offline unlink still unlinks locally (revoke is best-effort by contract)
      const wDir = path.join(tmp, 'unlink-offline'); const wFile = path.join(wDir, 'credits.json');
      fs.mkdirSync(wDir, { recursive: true });
      fs.writeFileSync(wFile, JSON.stringify({ url: 'https://cloud.example', deviceToken: 'snd_x', accountId: 'acct_w', linkedAt: 3 }));
      const offline = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: () => Promise.reject(new Error('offline')), fsp, fs, pathMod: path, dir: wDir, now: () => 9700 });
      const u = await offline.clearSaved();
      A.eq(u.ok, true, 'an offline unlink still succeeds locally');
      A.eq(offline.hasSaved(), false, 'and the station is unlinked');
    }
  }

  // A consumed confirmation must survive a transient disk failure until the same poll is retried.
  {
    const retryDir = path.join(tmp, 'persist-retry');
    const cloud = fakeCloud();
    let failWrite = true;
    const io = Object.assign({}, fsp, { writeFile: async (...args) => {
      if (failWrite) throw new Error('fixture disk unavailable');
      return fsp.writeFile(...args);
    } });
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: cloud.fetch, fsp: io, fs, pathMod: path, dir: retryDir });
    await link.start(); cloud.confirm();
    let failed = false;
    try { await link.poll(cloud.state.code); } catch (_) { failed = true; }
    A.eq(failed, true, 'failed persistence is reported');
    A.eq(link.hasSaved(), false, 'a failed write cannot claim a durable link');
    failWrite = false;
    A.eq((await link.poll(cloud.state.code)).status, 'confirmed', 'retry saves the one-shot confirmation');
    A.eq(cloud.calls.filter(c => c.url.includes('/link/poll')).length, 1, 'retry does not consume the cloud handoff twice');
    A.eq(link.loadSavedSync().deviceToken, 'snd_devtoken_abc', 'the exact confirmed credential survives');
  }

  // Interrupted unlink: tombstone landed but credits.json survived a failed delete/process exit.
  {
    const interruptedDir = path.join(tmp, 'interrupted-unlink');
    fs.mkdirSync(interruptedDir, { recursive: true });
    fs.writeFileSync(path.join(interruptedDir, 'credits.json'), JSON.stringify({ url: 'https://cloud.example', accountId: 'acct_old', deviceToken: 'snd_old' }));
    fs.writeFileSync(path.join(interruptedDir, 'credits.unlinked.json'), JSON.stringify({ unlinkedAt: 1 }));
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fsp, fs, pathMod: path, dir: interruptedDir, envToken: 'snd_old' });
    A.eq(link.hasSaved(), false, 'durable unlink wins over a leftover file on reboot');
  }

  // A whoami response that sends headers then stalls must not strand boot recovery forever.
  {
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fsp, fs, pathMod: path,
      dir: path.join(tmp, 'heal-body-timeout'), envToken: 'snd_fixture', requestTimeoutMs: 20,
      fetch: async (_url, init) => ({ ok: true, json: () => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
      }) }) });
    A.eq((await link.healFromEnv()).reason, 'unreachable', 'timeout covers response body consumption');
    A.eq(link.hasSaved(), false, 'timed-out identity never creates a link');
  }

  // Issue #76 (2026-10-06): the boot heal was ONE-SHOT. A cloud that was slow/down at launch left a keychain-authorized
  // station unlinked for the whole session even after the cloud recovered. A transient refusal now arms a spaced retry;
  // a definitive one (revoked token) never does; concurrent askers share one whoami.
  {
    let clock = 10000, mode = 'down';
    const calls = [];
    const f = (url, init) => {
      calls.push(String(url));
      if (mode === 'down') return Promise.reject(new Error('ETIMEDOUT'));
      if (mode === '502') return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      if (mode === 'revoked') return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, accountId: 'acct_back' }) });
    };
    const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: f, fsp, fs, pathMod: path,
      dir: path.join(tmp, 'heal-retry'), now: () => clock, envToken: 'snd_survivor', healRetryMs: 30000 });
    A.eq(link.healRetryDue(), false, 'nothing to retry before the first heal');
    const first = await link.healFromEnv();
    A.eq(first.reason, 'unreachable', 'boot heal met a dead cloud');
    A.eq(first.retryable, true, 'an unreachable cloud is a transient refusal');
    A.eq(link.healRetryDue(), false, 'the retry is spaced — not due immediately');
    clock += 30000;
    A.eq(link.healRetryDue(), true, 'due once the spacing has elapsed');
    mode = '502';
    const second = await link.healFromEnv();
    A.eq(second.reason, 'whoami http 502', 'a 502 is named');
    A.eq(second.retryable, true, 'a 5xx keeps the retry armed');
    clock += 30000;
    mode = 'up';
    const [a, b] = [link.healFromEnv(), link.healFromEnv()];
    A.eq(a === b, true, 'concurrent heals share one in-flight attempt');
    const healed = await a;
    A.eq(healed.healed, true, 'the station relinks itself once the cloud is back — no restart');
    A.eq(link.loadSavedSync().accountId, 'acct_back', 'the record carries the cloud-vouched account');
    A.eq(calls.filter(u => u.includes('/v1/whoami')).length, 3, 'one whoami per attempt (the shared one counted once)');
    A.eq(link.healRetryDue(), false, 'a healed station has nothing left to retry');

    // a definitive 401 disarms the retry: a revoked token is never re-asked in a loop
    let c2 = 0;
    const revoked = makeCreditsLink({ cloudUrl: 'https://cloud.example', fsp, fs, pathMod: path, dir: path.join(tmp, 'heal-retry-revoked'),
      now: () => c2, envToken: 'snd_dead', healRetryMs: 10,
      fetch: () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }) });
    const rv = await revoked.healFromEnv();
    A.eq(rv.retryable, false, 'a revoked token is not a transient failure');
    c2 += 1000;
    A.eq(revoked.healRetryDue(), false, 'and never arms a retry');
  }

  // ---- PAIRING-START RETRY (link-down 2026-10-07): one transient blip used to end the pairing with "could not reach
  //      the link service". A 5xx / transport error / abort takes ONE spaced second attempt; a 4xx never does. ----
  {
    const scripted = (answers) => {
      const calls = [];
      const fetch = (url, init) => {
        calls.push(String(url));
        const a = answers.shift();
        if (a === 'throw') return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
        if (a === 'abort') return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        const status = a || 200;
        return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(status === 200 ? { code: 'STAR-RTRY', pollSecret: 'ps', verifyUrl: 'https://cloud.example/v', expiresAt: 1 } : { error: 'x' }) });
      };
      return { calls, fetch };
    };
    const mk = (fetch, sub) => makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch, fsp, fs, pathMod: path, dir: path.join(tmp, 'start-retry-' + sub), now: () => 5000, linkRetryMs: 0 });
    for (const [first, label] of [[503, 'a 5xx'], ['throw', 'a transport error'], ['abort', 'an aborted request']]) {
      const c = scripted([first, 200]);
      const s = await mk(c.fetch, String(first)).start('Station');
      A.eq([s.ok, s.code, c.calls.length], [true, 'STAR-RTRY', 2], label + ' on link/start is retried once and the pairing goes on');
    }
    for (const [status, label] of [[400, 'a 400'], [429, 'a 429 (a fixed wait would only meet the same limit)']]) {
      const c = scripted([status, 200]);
      let err = null; try { await mk(c.fetch, String(status)).start('Station'); } catch (e) { err = e; }
      A.eq([err && err.status, c.calls.length], [status, 1], label + ' is a verdict: exactly one call, the status kept');
    }
    {
      const c = scripted([502, 502]);
      let err = null; try { await mk(c.fetch, 'twice').start('Station'); } catch (e) { err = e; }
      A.eq([err && err.status, err && err.attempts, c.calls.length], [502, 2, 2], 'two transient failures surface the last error with attempts:2');
    }
    {
      // an unlink during the backoff wins: the dead attempt never mints a second code
      const c = scripted([503, 200]);
      const link = makeCreditsLink({ cloudUrl: 'https://cloud.example', fetch: c.fetch, fsp, fs, pathMod: path, dir: path.join(tmp, 'start-retry-superseded'), now: () => 5000, linkRetryMs: 20 });
      const pending = link.start('Station');
      await new Promise(r => setTimeout(r, 5));
      await link.clearSaved();
      const s = await pending;
      A.eq([s.ok, s.error, c.calls.length], [false, 'superseded', 1], 'an unlink during the retry backoff supersedes the start with no second call');
    }
  }

  await flush();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  A.report('credits-link.test');
})();
