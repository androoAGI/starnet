/* node test/route-honesty.e2e.test.js — boot the REAL sidecar (child process, ISOLATED temp workspace) and prove
   the two 2026-09-03 audit fixes over real sockets:
     1. corrupt store ≠ empty store: GET /api/notebook / /api/memory/declined answer 500 { error, code } over a
        corrupt file (no .bak), while an absent store still answers 200 + [].
     2. fail-loud-but-safe: POST /api/dev/fault (DEV-only) raises a real uncaught exception → /api/health flips to
        503 "degraded: …", /api/diagnostics carries processFault, and the process EXITS 1 (the desktop watchdog's
        respawn trigger) after the bounded delay. With STARNET_UNCAUGHT_KEEP_SERVING=1 it degrades but stays up.
   Zero network, zero model spend. Registered in test/http.list (child-process boot tests don't gate test:fast). */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, workspaces, attemptsLeft, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        STARNET_PORT: String(port), STARNET_WORKSPACES: workspaces,
        STARNET_DEV: '1', SKYNET_DEV: '1',                      // enables POST /api/dev/fault (404 otherwise)
        STARNET_UNCAUGHT_EXIT_DELAY_MS: '3000',                 // widen the DEGRADED window so it is observable over sockets
        STARNET_UNCAUGHT_KEEP_SERVING: '', SKYNET_UNCAUGHT_KEEP_SERVING: '',
        SKYNET_CRON_ENABLED: '', STARNET_CRON_ENABLED: ''
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, output: () => out }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, workspaces, attemptsLeft - 1, extraEnv))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 45000);
  });
}
function exited(child, ms) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const t = setTimeout(() => resolve(null), ms);
    child.once('exit', code => { clearTimeout(t); resolve(code); });
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-route-honesty-'));
  // CORRUPT fixtures (no .bak → unrecoverable): the exact "torn store" shape the old routes rendered as 200 + [].
  fs.writeFileSync(path.join(ws, 'agent.notebook.json'), '{"notes": [ this is not json');
  fs.writeFileSync(path.join(ws, 'agent.declined.json'), 'not json either');
  let child = null;
  try {
    const b = await boot(await allocatePort(), ws, 6);
    child = b.child;
    const B = 'http://' + HOST + ':' + b.port;
    const tok = await bootToken(B, B);
    A.ok(!!tok, 'boot token extracted');
    const H = { 'X-StarNet-Token': tok, Origin: B };
    const j = async (m, p, body) => { const r = await fetch(B + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: body ? JSON.stringify(body) : undefined }); let out = null; try { out = await r.json(); } catch (_) {} return { status: r.status, body: out }; };

    // ---- 1. corrupt ≠ empty ----
    const nb1 = await j('GET', '/api/notebook?agent=agent');
    A.eq(nb1.status, 500, 'GET /api/notebook over a CORRUPT store → 500 (was 200 + notes:[])');
    A.ok(nb1.body && /^ESTORE_/.test(String(nb1.body.code)), 'carries a store error code: ' + JSON.stringify(nb1.body));
    A.ok(nb1.body && typeof nb1.body.error === 'string' && nb1.body.error.length > 0, 'carries a human error string');
    const quarantined = fs.readdirSync(ws).filter(f => /^agent\.notebook\.json\.corrupt-/.test(f));
    A.eq(quarantined.length, 1, 'the corrupt notebook was quarantined (forensic bytes kept), not wiped');
    const nb2 = await j('GET', '/api/notebook?agent=agent');
    A.eq(nb2.status, 200, 'after quarantine the key is genuinely absent → 200');
    A.ok(nb2.body && Array.isArray(nb2.body.notes) && nb2.body.notes.length === 0, '…and honestly empty');
    const dec = await j('GET', '/api/memory/declined?agent=agent');
    A.eq(dec.status, 500, 'GET /api/memory/declined over a CORRUPT store → 500');
    A.ok(dec.body && /^ESTORE_/.test(String(dec.body.code)), 'declined carries a store code: ' + JSON.stringify(dec.body));
    const recs = await j('GET', '/api/memory/records?agent=fresh-agent');
    A.eq(recs.status, 200, 'an ABSENT store (new agent) is still 200');
    A.ok(recs.body && Array.isArray(recs.body.records) && recs.body.records.length === 0, 'absent → empty records, no error');
    const pend = await j('GET', '/api/memory/pending?agent=fresh-agent');
    A.eq(pend.status, 200, 'pending for a fresh agent → 200 (nothing broken)');
    const tr = await j('GET', '/api/transcript?agent=fresh-agent&stream=global');
    A.eq(tr.status, 200, 'transcript for a fresh agent → 200');
    const sk = await j('GET', '/api/skills?placed=cabinet');
    A.eq(sk.status, 200, 'skills catalog healthy → 200');

    // ---- 2. fail-loud: health is honest, then the process exits for the watchdog ----
    const h0 = await fetch(B + '/api/health');
    A.eq(h0.status, 200, '/api/health is 200 before the fault');
    A.eq(await h0.text(), 'ok', '/api/health says ok before the fault');
    const f = await j('POST', '/api/dev/fault', {});
    A.eq(f.status, 202, 'POST /api/dev/fault accepted (DEV mode)');
    let hs = 0, ht = '';
    for (let i = 0; i < 40 && hs !== 503; i++) { await sleep(50); try { const r = await fetch(B + '/api/health'); hs = r.status; ht = await r.text(); } catch (_) {} }
    A.eq(hs, 503, '/api/health flips to 503 after the uncaught exception');
    A.ok(/^degraded: uncaughtException: synthetic uncaught exception/.test(ht), 'health body names the fault: ' + ht);
    const dg = await j('GET', '/api/diagnostics');
    A.eq(dg.status, 200, 'diagnostics still assembles while degraded');
    A.ok(dg.body && dg.body.report && dg.body.report.processFault && /synthetic uncaught exception/.test(dg.body.report.processFault.message), 'diagnostics report carries processFault');
    A.eq(dg.body.report.processFault.exiting, true, 'diagnostics says the process is exiting');
    A.ok(/Process fault: uncaughtException/.test(String(dg.body.text)), 'paste-ready text carries the Process fault line');
    A.ok(dg.body.report.errors.some(e => /process uncaughtException: synthetic/.test(e.message)), 'the diagnostics ring ALSO recorded it (old behaviour preserved)');
    const code = await exited(child, 8000);
    A.eq(code, 1, 'sidecar exited with code 1 within the bounded delay (got ' + code + ')');
    A.ok(/\[process-fault\] uncaughtException: state is unproven/.test(b.output()), 'boot log carries the fail-loud line');
    child = null;

    // ---- 3. the test-only opt-out keeps the process alive but still degrades health ----
    const b2 = await boot(await allocatePort(), fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-route-honesty-keep-')), 6, { STARNET_UNCAUGHT_KEEP_SERVING: '1' });
    child = b2.child;
    const B2 = 'http://' + HOST + ':' + b2.port;
    const tok2 = await bootToken(B2, B2);
    const f2 = await fetch(B2 + '/api/dev/fault', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': tok2, Origin: B2 }, body: '{}' });
    A.eq(f2.status, 202, 'keep-serving boot accepted the fault');
    let hs2 = 0;
    for (let i = 0; i < 40 && hs2 !== 503; i++) { await sleep(50); try { hs2 = (await fetch(B2 + '/api/health')).status; } catch (_) {} }
    A.eq(hs2, 503, 'keep-serving still degrades /api/health to 503 (never a false ok)');
    const code2 = await exited(child, 1500);
    A.eq(code2, null, 'with UNCAUGHT_KEEP_SERVING the process stays alive (exit code still null)');
    A.ok(/kept alive \(UNCAUGHT_KEEP_SERVING is set/.test(b2.output()), 'log names the opt-out');
    try { child.kill(); } catch (_) {}
    child = null;

    // ---- 4. CRASH-LOOP BREAKER across three lives of ONE workspace (crash-ledger.js) ----
    // life 1 + life 2: fault → exit 1 (the ledger remembers). life 3: the 3rd fault inside 10m TRIPS the breaker —
    // the process stays alive QUIESCED, /api/health answers 503 "degraded: crash-loop: 3 faults in 10m — last: …",
    // the static recovery shell + diagnostics keep serving, and every other route fails closed. The ledger FILE
    // is the restart-survival proof.
    const wsLoop = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-route-honesty-loop-'));
    let port3 = await allocatePort();   // one port for all three lives of the workspace
    const lifeFault = async (life) => {
      const bl = await boot(port3, wsLoop, 6, { STARNET_UNCAUGHT_EXIT_DELAY_MS: '300' });
      port3 = bl.port;
      child = bl.child;
      const BL = 'http://' + HOST + ':' + bl.port;
      const tokL = await bootToken(BL, BL);
      const fl = await fetch(BL + '/api/dev/fault', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': tokL, Origin: BL }, body: '{}' });
      A.eq(fl.status, 202, 'life ' + life + ': fault accepted');
      let st = 0, body = '';
      for (let i = 0; i < 60 && st !== 503; i++) { await sleep(50); try { const r = await fetch(BL + '/api/health'); st = r.status; body = await r.text(); } catch (_) {} }
      A.eq(st, 503, 'life ' + life + ': /api/health 503');
      return { bl, BL, tokL, body };
    };
    for (let life = 1; life <= 2; life++) {
      const { bl, body } = await lifeFault(life);
      A.ok(/^degraded: uncaughtException: synthetic/.test(body), 'life ' + life + ': single-fault health line: ' + body);
      const c = await exited(child, 8000);
      A.eq(c, 1, 'life ' + life + ': exits 1 (breaker not yet tripped; got ' + c + ')');
      A.ok(!/CRASH LOOP/.test(bl.output()), 'life ' + life + ': no crash-loop line yet');
      child = null;
      await sleep(150);   // let the port drain before the next life binds it
    }
    const ledgerFile = path.join(wsLoop, '.crash-ledger.json');
    A.ok(fs.existsSync(ledgerFile), 'the crash ledger file survived two process exits');
    A.eq(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).entries.length, 2, 'ledger holds the two fault exits');
    {
      const { bl, BL, tokL, body } = await lifeFault(3);
      A.ok(/^degraded: crash-loop: 3 faults in 10m — last: synthetic uncaught exception/.test(body), 'life 3: health names the LOOP + last summary: ' + body);
      const c = await exited(child, 1500);
      A.eq(c, null, 'life 3: the process is HELD alive (no exit)');
      A.ok(/\[process-fault\] uncaughtException: CRASH LOOP — 3 fault exit/.test(bl.output()), 'life 3: boot log carries the crash-loop hold line');
      const shell = await fetch(BL + '/', { headers: { Origin: BL } });
      A.eq(shell.status, 200, 'life 3: static recovery shell remains reloadable');
      const rd = await fetch(BL + '/api/skills?placed=cabinet', { headers: { 'X-StarNet-Token': tokL, Origin: BL } });
      A.eq(rd.status, 503, 'life 3: non-diagnostic API reads fail closed while held');
      const rosterFile = path.join(wsLoop, 'agent.roster.json');
      A.eq(fs.existsSync(rosterFile), false, 'life 3: no roster existed before the refused mutation');
      const wr = await fetch(BL + '/api/roster', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': tokL, Origin: BL }, body: JSON.stringify({ updatedAt: Date.now(), agents: [{ agentId: 'agent', system: 'audit', name: 'Audit', provider: 'openrouter' }] }) });
      const wj = await wr.json();
      A.eq(wr.status, 503, 'life 3: mutations fail closed while held');
      A.eq(wj.code, 'EPROCESS_FAULT', 'life 3: refusal names the process-fault boundary');
      A.eq(fs.existsSync(rosterFile), false, 'life 3: refused mutation wrote no roster bytes');
      const v1 = await fetch(BL + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' }, body: '{}' });
      A.eq(v1.status, 503, 'life 3: external /v1 work also fails closed');
      const dg3 = await fetch(BL + '/api/diagnostics', { headers: { 'X-StarNet-Token': tokL, Origin: BL } });
      const d3 = await dg3.json();
      A.ok(d3.report && d3.report.processFault && d3.report.processFault.exiting === false && d3.report.processFault.loop && d3.report.processFault.loop.count === 3, 'life 3: diagnostics processFault says held + loop count 3');
      A.ok(d3.report.crashLoop && d3.report.crashLoop.tripped === true && d3.report.crashLoop.count === 3, 'life 3: diagnostics crashLoop tripped');
      A.ok(/CRASH LOOP — 3 fault exits in 10m/.test(String(d3.text)) && /Crash-loop ledger: 3 fault exit/.test(String(d3.text)), 'life 3: paste-ready text names the loop + ledger');
      A.eq(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).entries.length, 3, 'ledger holds all three fault exits');
      try { child.kill(); } catch (_) {}
      child = null;
    }

    // ---- 5. the exit-73 owner-unavailable path: 3rd refusal in 10m holds a DEGRADED listener, never reclaims ----
    // A LIVE holder (this test process's own PID) owns the workspace, so every acquire is honestly refused. Lives 1+2
    // exit 73 as before; life 3 stays up on the port answering /api/health 503 "degraded: workspace owner unavailable…"
    // and 503 JSON elsewhere — with the owner file UNTOUCHED (no auto-reclaim).
    const wsOwn = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-route-honesty-owner-'));
    const ownerFile = path.join(wsOwn, '.starnet-workspace-owner.json');
    const ownerDoc = JSON.stringify({ version: 1, pid: process.pid, nonce: 'test-holder-nonce', startedAt: Date.now(), executable: process.execPath });
    fs.writeFileSync(ownerFile, ownerDoc);
    // Each life takes its own port from the OS as it boots (one port shared by all three lives sat unbound for the
    // seconds lives 1 and 2 spent loading and exiting). Only a tripped life binds: its holding listener. If that bind is
    // refused ("could not bind :N (EACCES) — exiting 73", BIND_REFUSED) the life is booted again on a fresh port, and
    // resolves with the port it holds and how many refused binds it took (rebinds). Every boot is one more refusal in
    // the workspace's crash ledger, so the loop count the health line names is 3 + rebinds, not a fixed 3.
    const bootAny = (port, attemptsLeft = 3, rebinds = 0) => new Promise((resolve) => {
      const c = spawn(process.execPath, [INDEX], {
        env: Object.assign({}, process.env, { STARNET_PORT: String(port), STARNET_WORKSPACES: wsOwn, STARNET_DEV: '1', SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '', STARNET_CRON_ENABLED: '' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', done = false;
      const fin = (v) => { if (!done) { done = true; resolve(Object.assign({ child: c, port, rebinds, output: () => out }, v)); } };
      const onData = d => { out += d.toString(); if (out.indexOf('http://' + HOST + ':' + port) >= 0) fin({ listening: true, code: null }); };
      c.stdout.on('data', onData); c.stderr.on('data', onData);
      c.on('exit', code => setTimeout(() => {
        if (!done && code === 73 && BIND_REFUSED.test(out) && attemptsLeft > 0) {
          done = true;
          resolve(allocatePort().then(next => bootAny(next, attemptsLeft - 1, rebinds + 1)));
          return;
        }
        fin({ listening: false, code });
      }, 50));
      setTimeout(() => { try { c.kill(); } catch (_) {} fin({ listening: false, code: 'timeout' }); }, 30000);
    });
    let ownerBoots = 0;   // refusals the crash ledger has recorded for wsOwn
    for (let life = 1; life <= 2; life++) {
      const r = await bootAny(await allocatePort());
      ownerBoots += 1 + r.rebinds;
      A.eq(r.code, 73, 'owner life ' + life + ': refused with exit 73 (got ' + r.code + ')');
      A.ok(/safety code: WORKSPACE_BUSY/.test(r.output()), 'owner life ' + life + ': safety code printed');
    }
    A.eq(fs.readFileSync(ownerFile, 'utf8'), ownerDoc, 'owner file untouched after two refusals');
    {
      const r = await bootAny(await allocatePort());
      ownerBoots += 1 + r.rebinds;
      child = r.child;
      A.eq(r.listening, true, 'owner life 3: a degraded HOLDING listener came up instead of exit 73');
      A.eq(r.code, null, 'owner life 3: process alive');
      const BO = 'http://' + HOST + ':' + r.port;
      const h = await fetch(BO + '/api/health');
      const htxt = await h.text();
      A.eq(h.status, 503, 'owner life 3: /api/health 503');
      A.ok(/^degraded: workspace owner unavailable — another process may own /.test(htxt) && /holder PID \d+/.test(htxt) && htxt.indexOf('crash-loop: ' + ownerBoots + ' faults in 10m') >= 0, 'owner life 3: health carries the owner reason + recovery guidance + loop count (' + ownerBoots + '): ' + htxt);
      const sv = await fetch(BO + '/api/save?agent=agent');
      A.eq(sv.status, 503, 'owner life 3: every other route is 503 (the frontend lands on STATION DATA UNREACHABLE)');
      const svj = await sv.json();
      A.eq(svj.code, 'WORKSPACE_BUSY', 'owner life 3: JSON carries the safety code');
      A.eq(fs.readFileSync(ownerFile, 'utf8'), ownerDoc, 'owner life 3: the owner claim was NOT reclaimed or rewritten');
      A.ok(!fs.existsSync(path.join(wsOwn, 'runtime.knobs.json')) && !fs.existsSync(path.join(wsOwn, 'ledger.jsonl')), 'owner life 3: no store was opened/written');
      A.ok(/holding a degraded listener on :/.test(r.output()), 'owner life 3: boot log names the hold');
      try { child.kill(); } catch (_) {}
      child = null;
    }
    // ---- 5b. a refused HOLDING bind retries on a fresh port; that boot is one more refusal in the ledger ----
    // The port this life is handed is already taken, so its holding listener prints "could not bind :N (EADDRINUSE) —
    // exiting 73". bootAny reads that as a refused bind and boots the life again on a fresh OS port, where it holds.
    {
      const blocker = net.createServer();
      await new Promise((resolve, reject) => { blocker.once('error', reject); blocker.listen(0, HOST, resolve); });
      const blocked = blocker.address().port;
      try {
        const r = await bootAny(blocked);
        ownerBoots += 1 + r.rebinds;
        child = r.child;
        A.eq(r.rebinds, 1, 'rebind: the refused holding bind was retried exactly once (got ' + r.rebinds + ')');
        A.ok(r.listening === true && r.port !== blocked, 'rebind: the retried life holds on its own fresh port, not the refused one (' + blocked + ' -> ' + r.port + ')');
        const h = await fetch('http://' + HOST + ':' + r.port + '/api/health');
        const htxt = await h.text();
        A.eq(h.status, 503, 'rebind: /api/health on the fresh port answers 503 degraded');
        A.ok(htxt.indexOf('crash-loop: ' + ownerBoots + ' faults in 10m') >= 0, 'rebind: the ledger counted the refused boot too (' + ownerBoots + '): ' + htxt);
        A.eq(fs.readFileSync(ownerFile, 'utf8'), ownerDoc, 'rebind: the owner claim is still untouched');
        try { child.kill(); } catch (_) {}
        child = null;
      } finally {
        blocker.close();
      }
    }
  } finally {
    if (child) { try { child.kill(); } catch (_) {} }
  }
  A.report('route-honesty.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
