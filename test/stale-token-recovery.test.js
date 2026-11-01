/* node test/stale-token-recovery.test.js — #39: after a sidecar restart the open page keeps a STALE API token.

   The sidecar mints a per-launch token and injects it into the page it serves; a restart (START FRESH's exit(75), a
   crash respawn, a container restart) mints a new one, and every /api/ call from the still-open page answered
   403 'forbidden token'. Each surface misread it as its own failure: START FRESH greyed out forever after it
   SUCCEEDED, the connect screen said "catalog offline", a rename looked saved and silently reverted.

   harness.js now recovers in place: re-read the token from the page the sidecar serves ('/'), adopt it, replay the
   refused request ONCE. This test drives the lifted staleTokenRecovery() with real WHATWG Responses and locks the
   narrowness that makes it safe: it never swallows a real 403, never replays without proof of a rotation, never
   loops, and shares one page read across concurrent 403s. Source locks cover the wiring and the honest surfaces. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const harness = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const sidecar = readSidecarSource();

// Lift by indentation, NOT fnBody: the token regex holds a quote inside a character class (the documented fnBody
// hazard). The factory's own closing brace is the first two-space-indented "}" line after its header.
const start = harness.indexOf('  function staleTokenRecovery(o) {');
A.ok(start >= 0, 'harness.js defines staleTokenRecovery(o)');
const end = harness.indexOf('\n  }\n', start);
const factorySrc = harness.slice(start, end + 4);
A.ok(factorySrc.length > 200 && factorySrc.length < 6000, 'lifted exactly the factory (' + factorySrc.length + ' chars)');
const staleTokenRecovery = new Function(factorySrc + '\nreturn staleTokenRecovery;')();

// The page the sidecar serves carries the token in EXACTLY this shape (sidecar/index.js serveStatic). Lock the
// producer so a format change there cannot silently blind the recovery.
// The boot script now opens with a per-response CSP nonce (<script nonce="…">) and carries the token only for the
// same-user owner (peerOwnerCheck); the recovery's TOKEN_RE matches the assignment itself, whatever the tag carries.
A.ok(sidecar.includes("'window.__STARNET_API_TOKEN__=' + JSON.stringify(API_TOKEN) + ';'"),
  'serveStatic still injects window.__STARNET_API_TOKEN__=<json>; into the page');
A.ok(sidecar.includes("(scriptNonce ? '<script nonce=\"' + scriptNonce + '\">' : '<script>')"),
  'serveStatic opens the boot script with its per-response nonce');
A.ok(/res\.writeHead\(403\); res\.end\('forbidden token'\); return true;/.test(sidecar),
  "rejectBadApiToken still answers the stale-token case with the exact body 'forbidden token'");
const pageWith = tok => '<html><head><script>window.__STARNET_API_TOKEN__=' + JSON.stringify(tok) + ';</script>\n</head><body></body></html>';

function rig(opts) {
  opts = opts || {};
  const st = { token: opts.token || 'OLD', pageReads: 0, recovered: 0, stale: 0, replays: [] };
  const page = opts.page != null ? opts.page : pageWith('NEW');
  const rec = staleTokenRecovery({
    rawFetch: (u) => {
      A.eq(u, '/', 'the only thing the recovery ever fetches is the same-origin page');
      st.pageReads++;
      if (opts.pageFails) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(new Response(page, { status: 200 }));
    },
    getToken: () => st.token,
    setToken: t => { st.token = t; },
    canRefresh: () => opts.canRefresh !== false,
    onRecovered: () => { st.recovered++; },
    onStale: () => { st.stale++; }
  });
  const replay = (status, body) => fresh => { st.replays.push(fresh); return Promise.resolve(new Response(body || '{"ok":true}', { status: status || 200 })); };
  return { st, rec, replay };
}
const forbiddenToken = () => new Response('forbidden token', { status: 403 });

(async () => {
  // 1. a healthy response passes straight through — no page read, no body read.
  {
    const { st, rec, replay } = rig();
    const ok = new Response('{"x":1}', { status: 200 });
    const out = await rec.settle(ok, 'OLD', replay());
    A.ok(out === ok && st.pageReads === 0 && st.replays.length === 0, 'a 200 is returned untouched with no page read');
  }
  // 2. a ROUTE's own 403 is a real refusal: never swallowed, never replayed.
  for (const body of ['forbidden', 'forbidden host', 'forbidden origin', '{"error":"not allowed"}', 'forbidden ticket']) {
    const { st, rec, replay } = rig();
    const res = new Response(body, { status: 403 });
    const out = await rec.settle(res, 'OLD', replay());
    A.ok(out === res && st.pageReads === 0 && st.replays.length === 0 && st.stale === 0,
      "a 403 '" + body + "' passes through untouched (not the token gate)");
    A.eq(await out.text(), body, 'the caller can still read the untouched 403 body');
  }
  // 3. THE BUG: a stale-token 403 after a restart → adopt the served token, replay once, caller sees the success.
  {
    const { st, rec, replay } = rig();
    const out = await rec.settle(forbiddenToken(), 'OLD', replay(200, '{"lineage":{"priorInstallEvidence":false}}'));
    A.eq(out.status, 200, 'the caller gets the REPLAYED response, not the 403');
    A.eq((await out.json()).lineage.priorInstallEvidence, false, 'the replayed body is intact');
    A.eq(st.token, 'NEW', 'the fresh token from the served page is adopted');
    A.eq(st.replays.join(','), 'NEW', 'exactly one replay, carrying the fresh token');
    A.ok(st.recovered === 1 && st.stale === 0, 'recovery is reported once, not staleness');
  }
  // 3b. the page the sidecar serves today: a nonce'd boot script — recovery reads the token all the same.
  {
    const { st, rec, replay } = rig({ page: '<html><head><script nonce="b64Nonce+/==">window.__STARNET_API_TOKEN__=' + JSON.stringify('NEW') + ';</script>\n</head><body></body></html>' });
    const out = await rec.settle(forbiddenToken(), 'OLD', replay());
    A.eq(out.status, 200, 'a nonce-tagged boot script still yields the fresh token and one replay');
    A.eq(st.token, 'NEW', 'the fresh token is adopted from the nonce-tagged page');
  }
  // 3c. a page served to a different OS user withholds the token: nothing to adopt, the 403 stands.
  {
    const { st, rec, replay } = rig({ page: '<html><head><script nonce="n">window.__STARNET_TOKEN_WITHHELD__="other-user";</script></head></html>' });
    const res = forbiddenToken();
    const out = await rec.settle(res, 'OLD', replay());
    A.ok(out === res && st.replays.length === 0 && st.stale === 1, 'a withheld-token page is not a rotation: 403 stands, stale reported');
  }
  // 3d. A PAGE THE STATION KEPT ITS KEY FROM (review threads-backend-05 / sidecar-index-06). The sidecar serves the page
  // without its key when it cannot prove this browser runs as its own OS user, and says why in
  // window.__STARNET_TOKEN_WITHHELD__. Every keyed call 403s like a stale page, but it is NOT a restarted station: the
  // page must say WHY and name the owner's escape hatch, never "the station restarted". For a LASTING reason (another
  // account, no check on this platform) a re-read only re-runs the same failing check, so the page never offers one.
  // For a TRANSIENT reason (the lookup timed out or failed, the connection could not be traced — a loaded box, a race)
  // re-running the check IS the fix: the page re-reads '/' at most once a minute on a refused call and adopts the key
  // the moment the check passes, and the notice offers a reload before the env-var hatch that turns the check off.
  {
    const noticeSrc = A.fnBody(harness, 'function tokenWithheldNotice(');
    A.ok(noticeSrc.length > 100 && noticeSrc.length < 3000, 'harness.js defines tokenWithheldNotice(reason)');
    const retrySrc = A.fnBody(harness, 'function withheldRetryable(');
    A.ok(retrySrc.length > 20 && retrySrc.length < 600, 'harness.js defines withheldRetryable(reason)');
    const tokenWithheldNotice = new Function(retrySrc + '\n' + noticeSrc + '\nreturn tokenWithheldNotice;')();
    const WHY = { 'lookup-failed': /ownership check timed out or failed/, 'peer-not-found': /connection could not be traced/,
      'other-user': /connection belongs to another account/, 'unsupported-platform': /can’t run the ownership check/, 'constructor': /ownership check did not pass/ };
    const TRANSIENT = new Set(['lookup-failed', 'peer-not-found']);
    for (const reason of Object.keys(WHY)) {
      const t = tokenWithheldNotice(reason);
      A.ok(WHY[reason].test(t), 'the withheld notice names the reason in plain words (' + reason + '): ' + t);
      A.ok(/STARNET_TRUST_LOCAL_PEERS=1/.test(t) && /won’t take commands from this page/.test(t), 'and says what it means + the owner\'s escape hatch');
      A.ok(!/restarted/i.test(t), 'and never claims a restart (' + reason + ')');
      if (TRANSIENT.has(reason)) {
        A.ok(/reload this page to run the check again/i.test(t) && t.search(/reload this page/i) < t.indexOf('STARNET_TRUST_LOCAL_PEERS'),
          'a transient reason offers a reload (it re-runs the check) BEFORE the hatch that turns the check off: ' + t);
      } else {
        A.ok(!/reload/i.test(t), 'a lasting reason never offers a reload (it re-runs the same failing check): ' + t);
      }
    }
    A.eq(tokenWithheldNotice(''), '', 'a page that holds its key has no withheld notice');

    // the real wiring (lifted from harness.js), driven with the real factory and a fake clock
    const wiringStart = harness.indexOf('  let sessionStale = false;');
    const wiringEnd = harness.indexOf("  if (typeof window !== 'undefined' && window.fetch && !window.__STARNET_FETCH_HARDENED__)");
    A.ok(wiringStart > 0 && wiringEnd > wiringStart, 'lifted the stale-token wiring');
    const wiringSrc = harness.slice(wiringStart, wiringEnd);
    const wire = (withheld, pages) => {
      const notes = [], settled = []; let reads = 0; const clock = { now: 1000 };
      const win = { fetch: () => { const page = typeof pages === 'function' ? pages() : pages; reads++; return Promise.resolve(new Response(page || '<html></html>', { status: 200 })); } };
      if (!withheld) win.__STARNET_API_TOKEN__ = 'OLD';
      const StationUI = { notify: (text, cls, category, opts) => notes.push({ text, cls, category, opts }), settleNotifs: key => settled.push(key) };
      const w = new Function('window', 'DESKTOP', 'StationUI', 'staleTokenRecovery', 'tokenWithheld', 'Date',
        'let apiToken = window.__STARNET_API_TOKEN__ || "";\n' + wiringSrc +
        '\nreturn { staleToken, stale: () => sessionStale, note: noteTokenWithheld, boot: typeof bootNotices === "function" ? bootNotices : null, withheld: () => tokenWithheld, token: () => apiToken };')(
        win, false, StationUI, staleTokenRecovery, withheld, { now: () => clock.now });
      return { w, notes, settled, reads: () => reads, clock };
    };
    const withheldPage = reason => '<html><script>window.__STARNET_TOKEN_WITHHELD__=' + JSON.stringify(reason) + ';</script></html>';
    // TRANSIENT: the check is re-run at most once a minute; once it passes the page takes its key in place
    {
      let passes = false;
      const { w, notes, settled, reads, clock } = wire('lookup-failed', () => passes ? pageWith('NEW') : withheldPage('lookup-failed'));
      w.note();   // boot (Harness.init) shows it first …
      for (let i = 0; i < 3; i++) {
        const res = forbiddenToken();
        A.ok(await w.staleToken.settle(res, '', fresh => Promise.resolve(new Response('replayed:' + fresh))) === res, 'a withheld page\'s 403 stands while the check still fails');
      }
      A.eq(reads(), 1, 'a transient reason re-runs the check ONCE, then waits — never a page read per refused call');
      A.eq(notes.length, 1, '… and the withheld notice is shown ONCE (boot + every later 403): ' + JSON.stringify(notes.map(n => n.text)));
      A.eq(notes[0].text, tokenWithheldNotice('lookup-failed'), 'the notice is the withheld wording, not the restart wording');
      A.ok(notes[0].opts && notes[0].opts.kind === 'alert' && notes[0].opts.key === 'token-withheld', 'kept in NOTIFICATIONS as one alert (it outlives the toast)');
      A.eq(w.stale(), false, 'a withheld page is not a stale (restarted) session: no surface may say "the station restarted"');
      A.eq(settled.length, 0, 'a withheld page never marks its own alert handled while the check fails');
      clock.now += 59000;
      await w.staleToken.settle(forbiddenToken(), '', null);
      A.eq(reads(), 1, 'still inside the minute: no second page read');
      clock.now += 1000;
      passes = true;
      const outs = await Promise.all([1, 2, 3].map(() => w.staleToken.settle(forbiddenToken(), '', fresh => Promise.resolve(new Response('replayed:' + fresh)))));
      A.eq(reads(), 2, 'a minute later the check runs again — and concurrent refused calls share that ONE page read');
      A.eq(await Promise.all(outs.map(r => r.text())), ['replayed:NEW', 'replayed:NEW', 'replayed:NEW'], 'once the check passes, every refused call replays with the adopted key');
      A.ok(w.token() === 'NEW' && w.withheld() === '', 'the page adopts its key in place and is no longer withheld');
      A.eq(settled, ['token-withheld'], 'the withheld alert is marked handled');
      const last = notes[notes.length - 1];
      A.ok(notes.length === 2 && last.cls === 'good' && /ownership check passed on retry/.test(last.text) && !/restarted/i.test(last.text),
        'and the page says the check passed on retry, never "restarted": ' + (last && last.text));
      A.eq(w.stale(), false, 'a page that passed on retry is not stale');
    }
    // LASTING: another account (or no check on this platform) never re-reads, however long the page stays open
    for (const reason of ['other-user', 'unsupported-platform']) {
      const { w, notes, settled, reads, clock } = wire(reason, pageWith('NEW'));
      w.note();
      for (let i = 0; i < 3; i++) {
        const res = forbiddenToken();
        A.ok(await w.staleToken.settle(res, '', null) === res, 'a lasting withheld page\'s 403 stands (' + reason + ')');
        clock.now += 120000;
      }
      A.eq(reads(), 0, 'a lasting reason never re-reads the page (' + reason + '): it would only re-run the same failing check');
      A.ok(notes.length === 1 && notes[0].text === tokenWithheldNotice(reason) && w.withheld() === reason && w.stale() === false && settled.length === 0,
        'one withheld notice, still withheld, not a stale session (' + reason + ')');
    }
    {
      const { w, notes, settled, reads } = wire('', pageWith('OLD'));
      w.note();
      A.eq(notes.length, 0, 'a page that holds its key shows no withheld notice at boot');
      A.eq(settled, ['token-withheld'], '… and marks an alert left by an earlier withheld page as handled (the owner fixed it)');
      await w.staleToken.settle(forbiddenToken(), 'OLD', null);
      A.ok(reads() === 1 && w.stale() === true && notes.length === 1 && /station restarted/.test(notes[0].text),
        'a keyed page whose token went stale keeps the restart + reload wording: ' + (notes[0] && notes[0].text));
    }
    // (live walk 10-14) a restart whose first page read comes back without the new key (the ownership check timed out on a
    // loaded box): ONE honest alert that stays while the page is refused, says the page keeps trying and reloads on a click —
    // and the next refused call that finds the key marks it handled and says so in the same card
    {
      let served = withheldPage('lookup-failed');
      const { w, notes, settled, reads, clock } = wire('', () => served);
      w.note();
      for (let i = 0; i < 3; i++) await w.staleToken.settle(forbiddenToken(), 'OLD', null);
      A.ok(reads() === 1 && w.stale() === true, 'the first refused call reads the page at once; the next polls inside 3 s do not (' + reads() + ' reads)');
      clock.now += 3000;
      await w.staleToken.settle(forbiddenToken(), 'OLD', null);
      A.ok(reads() === 2 && w.stale() === true, '…every 3 s the page is read again while the key is missing — never once per poll (each read runs the ownership lookup)');
      A.eq(notes.length, 1, 'one notice for the whole refused stretch, not one per poll');
      const n = notes[0] || {};
      A.ok(/station restarted/.test(n.text) && /keeps trying on its own/.test(n.text) && /reload this page/i.test(n.text) && !/could not reconnect/.test(n.text),
        'it says what is true: the page keeps trying, and a reload reconnects now: ' + n.text);
      A.ok(n.opts && n.opts.kind === 'alert' && n.opts.key === 'station-restarted', 'kept in NOTIFICATIONS as one alert (it outlives the four-second toast)');
      A.ok(n.opts && typeof n.opts.onClick === 'function' && /Friendly\.actionButton\(\{ action: 'reload' \}\)/.test(String(harness)), 'its toast\'s click takes the reload door COMMS error rows offer');
      // (review 10-14) the SAME text is the kept bell row, and a bell row is a door only with opts.go: a row without one must
      // never promise a click (it read "click here to reload now", and a click on it did nothing)
      A.ok(n.opts && !n.opts.go && !/click/i.test(n.text), 'the kept row (no door in the bell) promises no click: ' + n.text);
      served = pageWith('NEW');
      clock.now += 3000;
      const out = await w.staleToken.settle(forbiddenToken(), 'OLD', fresh => Promise.resolve(new Response('replayed:' + fresh)));
      A.eq(await out.text(), 'replayed:NEW', 'the next refused call that finds the key replays with it');
      A.ok(w.stale() === false && w.token() === 'NEW', 'the page is no longer stale and holds the new key');
      A.eq(settled.filter(k => k === 'station-restarted').length, 1, 'the restart alert is marked handled');
      const last = notes[notes.length - 1];
      A.ok(notes.length === 2 && last.cls === 'good' && /reconnected on its own/.test(last.text) && last.opts && last.opts.key === 'station-restarted',
        'and "reconnected on its own" replaces the warning card in place: ' + (last && last.text));
    }
    // (review 10-14) A RELOAD SETTLES IT. The alert lives in the bell's localStorage, and only onRecovered settled it — a page
    // reloaded during the refused stretch (exactly what the toast's click does) came up ONLINE with the bell still saying
    // "has not picked up its new key yet", unread. The alert belongs to the page that raised it: a new page life marks it
    // handled at boot, whether it boots with its key or says why it was withheld.
    for (const withheld of ['', 'lookup-failed']) {
      const { w, notes, settled } = wire(withheld, pageWith('NEW'));
      A.ok(typeof w.boot === 'function', 'the wiring has a boot step for an earlier page\'s alerts (' + (withheld || 'keyed') + ')');
      if (typeof w.boot === 'function') w.boot();
      A.ok(settled.indexOf('station-restarted') >= 0, 'a booting page marks an earlier page\'s "station restarted" alert handled (' + (withheld || 'keyed') + ')');
      A.ok(withheld ? notes.length === 1 && /won’t take commands/.test(notes[0].text) : notes.length === 0,
        '…and raises only what is true of this page (' + (withheld || 'keyed') + '): ' + JSON.stringify(notes.map(x => x.text)));
    }
    A.ok(/async function init\(\) \{[^}]*?\n\s*bootNotices\(\);/.test(harness), 'Harness.init runs that boot step');
    A.ok(/let tokenWithheld = \(typeof window !== 'undefined' && !window\.__STARNET_API_TOKEN__ && window\.__STARNET_TOKEN_WITHHELD__\)/.test(harness),
      'harness reads the withheld reason only when the page carries no key (cleared when a retry adopts one)');
    A.ok(/async function init\(\) \{\s*(\/\/[^\n]*\n\s*)?bootNotices\(\);/.test(harness) && /function bootNotices\(\) \{\s*noteTokenWithheld\(\);/.test(harness),
      'boot shows the withheld notice before the first refused call');
    A.ok(/tokenWithheld: \(\) => tokenWithheld,/.test(harness) && /tokenWithheldNotice: \(\) => tokenWithheldNotice\(tokenWithheld\),/.test(harness)
      && /tokenWithheldRetryable: \(\) => withheldRetryable\(tokenWithheld\),/.test(harness),
      'Harness exposes tokenWithheld(), tokenWithheldNotice() and tokenWithheldRetryable() for the surfaces');
  }
  // 4. the served page carries the SAME token → no rotation proven → no replay; staleness reported.
  {
    const { st, rec, replay } = rig({ page: pageWith('OLD') });
    const res = forbiddenToken();
    const out = await rec.settle(res, 'OLD', replay());
    A.ok(out === res && st.replays.length === 0 && st.stale === 1 && st.recovered === 0,
      'same token on the page: the 403 stands, never replayed, reported as stale');
  }
  // 5. a page with no token at all, or a page read that throws, is not a rotation either.
  for (const o of [{ page: '<html></html>' }, { pageFails: true }]) {
    const { st, rec, replay } = rig(o);
    const res = forbiddenToken();
    const out = await rec.settle(res, 'OLD', replay());
    A.ok(out === res && st.replays.length === 0 && st.stale === 1, 'no token recoverable (' + JSON.stringify(o) + '): 403 stands, stale reported');
  }
  // 6. desktop (canRefresh false): never reads a page the sidecar did not serve.
  {
    const { st, rec, replay } = rig({ canRefresh: false });
    const res = forbiddenToken();
    const out = await rec.settle(res, 'OLD', replay());
    A.ok(out === res && st.pageReads === 0 && st.stale === 1, 'desktop: no page read, 403 stands, stale reported');
  }
  // 7. NO LOOP: the replay itself 403s → that answer is final (one replay, never a second).
  {
    const { st, rec, replay } = rig();
    const out = await rec.settle(forbiddenToken(), 'OLD', replay(403, 'forbidden token'));
    A.eq(out.status, 403, 'a replay that also 403s is returned as-is');
    A.eq(st.replays.length, 1, 'exactly one replay — never a loop');
  }
  // 8. concurrent 403s share ONE page read; a late 403 for the old token reuses the adopted token without reading.
  {
    const { st, rec, replay } = rig();
    const outs = await Promise.all([1, 2, 3, 4].map(() => rec.settle(forbiddenToken(), 'OLD', replay())));
    A.ok(outs.every(r => r.status === 200), 'every concurrent refused call is replayed to success');
    A.eq(st.pageReads, 1, 'four concurrent 403s share ONE page read');
    A.eq(st.replays.join(','), 'NEW,NEW,NEW,NEW', 'each replays once with the fresh token');
    const late = await rec.settle(forbiddenToken(), 'OLD', replay());
    A.ok(late.status === 200 && st.pageReads === 1, 'a late 403 sent with the old token reuses the adopted token (no second read)');
  }
  // 9. an unreplayable (streamed) body: token still adopted so the NEXT call works; this one keeps its 403.
  {
    const { st, rec } = rig();
    const res = forbiddenToken();
    const out = await rec.settle(res, 'OLD', null);
    A.ok(out === res && st.token === 'NEW' && st.stale === 0, 'no replay function: 403 returned, fresh token adopted for the next call');
  }
  // 10. the caller's body is never consumed by the sniff (clone), even on the recover path's pass-through.
  {
    const { rec } = rig({ page: pageWith('OLD') });
    const res = forbiddenToken();
    const out = await rec.settle(res, 'OLD', null);
    A.eq(await out.text(), 'forbidden token', 'the sniff reads a clone; the caller still reads the real body');
  }

  // ---- wiring (source locks) ----
  const wrapper = harness.slice(harness.indexOf("if (typeof window !== 'undefined' && window.fetch && !window.__STARNET_FETCH_HARDENED__)"));
  A.ok(/staleToken\.settle\(res, t, replayable \?/.test(wrapper), 'the global /api fetch wrapper routes every response through staleToken.settle');
  A.ok(/setToken: t => \{ apiToken = t; try \{ window\.__STARNET_API_TOKEN__ = t;/.test(harness),
    'adopting a token updates BOTH the cached header token and window.__STARNET_API_TOKEN__ (apiticket.js mints SSE/file/save tickets from it)');
  A.ok(/canRefresh: \(\) => !DESKTOP && !\(typeof window !== 'undefined' && window\.__STARNET_API__\) && \(!tokenWithheld \|\| withheldRetryDue\(\)\)/.test(harness),
    'desktop never reads the page for a token (the shell keeps one token across respawns); a page the station kept its key from only when a transient retry is due');
  A.ok(/if \(!inflight && !o\.canRefresh\(\)\) return Promise\.resolve\(''\);/.test(harness),
    'a refused call joins a page read already in flight without asking again (a rate-limited retry is shared, not refused)');
  A.ok(/sessionStale: \(\) => sessionStale/.test(harness), 'Harness exposes sessionStale() for the surfaces');

  // the START FRESH + recover polls: a 403 is not "not ready yet".
  const gate = A.fnBody(app, 'function showPriorStateGate(');
  A.ok(gate.length > 0 && gate.length < app.length, 'lifted showPriorStateGate');
  const polls = gate.match(/if \(probe\.status === 403\) \{ clearInterval\(timer\); location\.reload\(\); return; \}/g) || [];
  A.eq(polls.length, 2, 'both restart polls (START FRESH, RECOVER) stop and reload once on a 403 instead of greying out forever');
  A.ok(/const next = body && body\.lineage;[\s\S]{0,400}checked again — still nothing recoverable here/.test(gate),
    'RETRY with nothing recoverable re-asks the sidecar and SAYS so instead of a no-op reload');
  A.ok(/throw new Error\(refusedPageLine\(\) \|\| 'report unavailable'\)/.test(gate),
    'report export names a refused page (withheld key or stale session) instead of "report unavailable"');
  A.ok(/could not check again — ' \+ \(refusedPageLine\(\) \|\| 'the station service did not answer'\)/.test(gate),
    'RETRY names a refused page instead of "the station service did not answer"');
  // the connect screen: a stale session is not an offline catalog, and not the user's network.
  const models = A.fnBody(app, 'async function loadModels(');
  A.ok(/const refused = refusedPageLine\(\);\s*countEl\.textContent = refused \? '\(' \+ refused \+ '\)' : '\(catalog offline — type or pick a slug\)'/.test(models),
    'loadModels names a refused page (withheld key or stale session), "catalog offline" only otherwise');
  const wake = A.fnBody(app, 'async function onWake(');
  A.ok(/const refused = refusedPageLine\(\);[\s\S]{0,300}'could not start — ' \+ \(refused \|\| /.test(wake), 'WAKE names a refused page instead of "Failed to fetch"');
  // ONE phrase for "why this page is refused": a page the station kept its key from is checked FIRST, so no surface
  // tells its owner "the station restarted; reload this page" — a reload re-runs the same check (review threads-backend-05)
  {
    const lineSrc = A.fnBody(app, 'function refusedPageLine(');
    A.ok(lineSrc.length > 50 && lineSrc.length < 2000, 'app.js defines refusedPageLine()');
    const lineFor = (H) => new Function('Harness', lineSrc + '\nreturn refusedPageLine;')(H)();
    const withheld = lineFor({ tokenWithheld: () => 'other-user', tokenWithheldRetryable: () => false, sessionStale: () => true });
    A.ok(/not verified as running under your own user account/.test(withheld) && /STARNET_TRUST_LOCAL_PEERS=1/.test(withheld) && !/restarted|reload/i.test(withheld),
      'a lasting withheld page says it was not verified + the escape hatch, never "restarted; reload": ' + withheld);
    const transient = lineFor({ tokenWithheld: () => 'peer-not-found', tokenWithheldRetryable: () => true, sessionStale: () => true });
    A.ok(/not verified as running under your own user account/.test(transient) && /reload this page to run the check again/.test(transient)
      && transient.indexOf('reload') < transient.indexOf('STARNET_TRUST_LOCAL_PEERS=1') && !/restarted/i.test(transient),
      'a transient withheld page offers a reload to re-run the check before the hatch, never "restarted": ' + transient);
    A.ok(!/reload/i.test(lineFor({ tokenWithheld: () => 'peer-not-found', sessionStale: () => true })), 'an older Harness without the retry probe offers no reload');
    A.eq(lineFor({ tokenWithheld: () => '', sessionStale: () => true }), 'the station restarted; reload this page', 'a keyed page\'s stale session keeps the reload line');
    A.eq(lineFor({ tokenWithheld: () => '', sessionStale: () => false }), '', 'a page that is not refused has no line');
    A.eq(lineFor({}), '', 'an older Harness without either probe has no line');
  }

  A.report('stale-token-recovery');
})().catch(e => { console.error(e); process.exit(1); });
