/* node test/workshop.e2e.test.js — real sidecar proof for the AWAY WORKSHOP (W1 grant + W2 driver).

   Boots the ACTUAL sidecar with a mock OpenRouter, then drives the full loop the way the Commander would:
     1. POST /api/workshop/grant { on:true }  — record the "Build things while I'm away" consent.
     2. POST /api/workshop/queue              — line up a build request.
     3. POST /api/workshop/shift              — force-fire ONE shift NOW (attended test of the unattended path).
   The mock agent WRITES a real file + a deliverable.json manifest via fs_write. Because the agent is GRANTED
   (W1), the autonomous cabinet:write is ALLOWED (an UNGRANTED agent's write default-denies — asserted too).
   Proves end-to-end: the run streams, workshop/<runId>/ + a valid deliverable.json land ON DISK, the shift
   reports built, and workshop.built arrives on the durable SSE bus with the disk-proven manifest.

   Also proves the two ABSOLUTE guards live: an empty backlog is a SILENT no-op (no workshop.built), and an
   UNGRANTED agent's autonomous fs.write is DENIED (the grant is load-bearing, not decorative). */
'use strict';

const A = require('./_assert.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const WORKSHOP_MARK = '[WORKSHOP_SHIFT]';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock OpenRouter: on a WORKSHOP run, write the deliverable file, then the manifest, then stop. Turn is inferred
// from how many tool results the transcript already carries (0 -> write file, 1 -> write manifest, 2 -> done).
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const userMsg = msgs.find(m => m && m.role === 'user');
          const prompt = userWords(userMsg);
          const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          const dir = 'workshop/' + runId;
          // W7 web-tool build path: when the queued item asks for a web tool, build a SELF-CONTAINED index.html
          // (all CSS/JS inline) + a README.md, so the return card's "Open it" opens a RUNNING page and a non-html
          // file exists to test the shell-open route. Keyed off the item title carried in the prompt.
          const wantsWeb = /web tool/i.test(prompt);
          const wantsFailure = /fail build/i.test(prompt);
          const partial = prompt.match(/partial (entry|support) build/i);
          if (prompt.indexOf(WORKSHOP_MARK) === 0 && partial) {
            const present = partial[1] === 'entry' ? 'README.md' : 'index.html';
            if (toolResults === 0) tool('p1', 'fs_write', { path: dir + '/' + present, content: 'Recoverable partial work' });
            else if (toolResults === 1) tool('p2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify({ v: 1, title: 'Incomplete web tool', kind: 'tool', files: [{ path: 'index.html' }, { path: 'README.md' }], howToUse: 'Open index.html' }) });
            else text('Built the complete web tool.');
          } else if (prompt.indexOf(WORKSHOP_MARK) === 0 && wantsFailure) {
            text('I could not produce a valid deliverable.');
          } else if (prompt.indexOf(WORKSHOP_MARK) === 0 && wantsWeb) {
            const html = '<!doctype html><meta charset="utf-8"><title>Tip Calc</title>'
              + '<h1 id="h">Tip Calculator</h1><script>document.getElementById("h").dataset.ready="1";</script>';
            if (toolResults === 0) {
              tool('h1', 'fs_write', { path: dir + '/index.html', content: html });
            } else if (toolResults === 1) {
              tool('h2', 'fs_write', { path: dir + '/README.md', content: '# Tip Calc\n\nOpen index.html.\n' });
            } else if (toolResults === 2) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'item-web', title: 'Tip Calculator', kind: 'tool', summary: 'A single-file HTML tip calculator.', files: [{ path: 'index.html', bytes: html.length }, { path: 'README.md', bytes: 30 }], howToUse: 'Open index.html and use it.', notVerified: ['not run in a browser'] };
              tool('h3', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built a self-contained HTML tip calculator.'); }
          } else if (prompt.indexOf(WORKSHOP_MARK) === 0) {
            if (toolResults === 0) {
              tool('w1', 'fs_write', { path: dir + '/cleaner.py', content: 'print("csv cleaned")\n' });
            } else if (toolResults === 1) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'item-1', title: 'CSV cleaner', kind: 'tool', summary: 'A tiny CSV cleaner script.', files: [{ path: 'cleaner.py', bytes: 21 }], howToUse: 'Run it on a CSV.', notVerified: ['not executed'] };
              tool('w2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built the CSV cleaner in my workshop.'); }
          } else {
            // ungranted-write probe: try an autonomous fs_write; then report.
            if (toolResults === 0) tool('u1', 'fs_write', { path: 'sneaky.txt', content: 'should be denied' });
            else text('done');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } }
  return events;
}

async function startSse(url) {
  const ac = new AbortController(); const events = []; const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  function notify() { for (let i = waiters.length - 1; i >= 0; i--) { const w = waiters[i]; if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); } } }
  (async () => { const dec = new TextDecoder(); let buf = '';
    try { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line || line[0] === ':') continue; if (line.indexOf('data:') === 0) { try { events.push(JSON.parse(line.slice(5).trim())); notify(); } catch (_) {} } } } } catch (_) {} })();
  return { events, waitFor(pred, ms, label) { if (pred(events)) return Promise.resolve(events); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms); waiters.push({ pred, resolve, reject, timer }); }); }, close() { try { ac.abort(); } catch (_) {} } };
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-e2e-'));
  const openLog = path.join(ws, 'open-invocations.log');   // W7: the CI open-seam appends here instead of launching an app
  // SKYNET_DEV=1 marks this as a dev/CI context so the TEST open-seam (SKYNET_TEST_OPEN_LOG) is honored. The seam
  // is now gated on DEV_MODE (audit 1.4): a production process carrying SKYNET_TEST_OPEN_LOG must NOT fake-launch,
  // so the env var alone no longer installs the fake opener — the run must also declare itself dev/test.
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-workshop-fake', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_TEST_OPEN_LOG: openLog };
  const firstBoot = await boot(await allocatePort(), env, 20);
  let child = firstBoot.child;
  let B = 'http://' + HOST + ':' + firstBoot.port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    sse = await startSse(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    // 0. EMPTY BACKLOG (granted, nothing queued) -> silent no-op, no workshop.built.
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', on: true }) });
    const emptyShift = await (await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) })).text();
    const emptyRes = JSON.parse(emptyShift.trim().split('\n').filter(Boolean).pop());
    A.ok(emptyRes.payload && emptyRes.payload.fired === false && emptyRes.payload.reason === 'empty-backlog', 'empty backlog is a SILENT no-op (fired:false)');

    // 1. grant persisted + reflected in the backlog view.
    const bl0 = await (await fetch(B + '/api/workshop/backlog?agent=builder', { headers })).json();
    A.ok(bl0.granted === true, 'grant is recorded and read back via /backlog');

    // 2. queue a build request.
    const q = await (await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-1', title: 'CSV cleaner', detail: 'a script that strips blank rows' }) })).json();
    A.ok(q.ok === true && q.item && q.item.id === 'item-1', 'queued the build request');
    // dedup doctrine: the same normalized title is refused.
    const dup = await (await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-1b', title: '  csv   CLEANER ' }) })).json();
    A.ok(dup.ok === false && dup.reason === 'duplicate', 'a duplicate normalized title is refused (dedup doctrine)');

    // 3. force-fire ONE shift. The granted agent writes cleaner.py + deliverable.json under workshop/<runId>/.
    const shiftRes = await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) });
    A.eq(shiftRes.status, 200, 'shift force-fire returns a stream');
    const stream = await readNdjson(shiftRes);
    const result = (stream.find(e => e.name === 'workshop.shift.result') || {}).payload || {};
    A.ok(result.fired === true && result.reason === 'built', 'shift built a deliverable (fired:true, reason:built)');
    const runId = result.runId;
    A.ok(runId, 'shift returned a runId');
    A.ok(result.manifest && result.manifest.title === 'CSV cleaner', 'shift result carries the disk-proven manifest');

    // 4. THE FILES ARE REALLY ON DISK (the write happened through the real fs-jail, unlocked by the W1 grant).
    const runDir = path.join(ws, 'builder', 'workshop', runId);
    A.ok(fs.existsSync(path.join(runDir, 'cleaner.py')), 'the deliverable file exists on disk');
    const manRaw = fs.readFileSync(path.join(runDir, 'deliverable.json'), 'utf8');
    const man = JSON.parse(manRaw);
    A.ok(man.v === 1 && Array.isArray(man.files) && man.files.length >= 1, 'deliverable.json on disk is a valid v1 manifest');
    const extraFiles = {
      'README.md': Buffer.from('# CSV cleaner\n\n**Safe** preview.\n<script>never run</script>'),
      'sample.csv': Buffer.from('name,value\nalpha,1\nbeta,2\n'),
      'pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      'index.html': Buffer.from('<!doctype html><title>CSV cleaner</title><script>document.body.dataset.ready="1"</script>')
    };
    for (const [name, bytes] of Object.entries(extraFiles)) { fs.writeFileSync(path.join(runDir, name), bytes); man.files.push({ path: name, bytes: bytes.length }); }
    fs.writeFileSync(path.join(runDir, 'deliverable.json'), JSON.stringify(man));

    // 5. workshop.built arrived on the durable SSE bus with the proven manifest.
    await sse.waitFor(ev => ev.some(e => e.name === 'workshop.built' && e.payload && e.payload.agentId === 'builder' && e.payload.runId === runId && e.payload.manifest && e.payload.manifest.files.length >= 1), 6000, 'workshop.built SSE');
    A.ok(true, 'workshop.built emitted with a disk-proven manifest');

    // 6. it shows up as a PENDING deliverable for the return-card.
    const pending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(pending.pending.some(m => m.runId === runId && m.title === 'CSV cleaner'), '/pending lists the built deliverable');
    // WHY-THIS provenance (2026-07-17): the card's "why this" line is server-stamped from the REAL backlog
    // ask (workshopBecause) — never a model claim in the manifest. The queued detail must ride /pending.
    A.eq((pending.pending.find(m => m.runId === runId) || {}).because, 'a script that strips blank rows', '/pending stamps because from the real queued ask');
    const libraryPendingRes = await fetch(B + '/api/deliverables?status=pending&query=csv', { headers });
    const libraryPending = await libraryPendingRes.json();
    const pendingRow = (libraryPending.items || []).find(r => r.runId === runId);
    A.eq(libraryPendingRes.status, 200, 'deliverable library API exists');
    A.ok(pendingRow && pendingRow.status === 'pending' && pendingRow.source === 'queued', 'library projects the real pending Workshop record');
    const expectedSize = man.files.reduce((n, f) => n + f.bytes, 0);
    A.ok(pendingRow.size === expectedSize && pendingRow.files[0].openUrl, 'library reports manifest-proven size and safe open URLs');
    A.ok(pendingRow.files.some(f => f.preview === 'markdown') && pendingRow.files.some(f => f.preview === 'csv') && pendingRow.files.some(f => f.preview === 'image'), 'library allowlists bounded Markdown, CSV, and image previews');
    A.ok(pendingRow.files.some(f => /index\.html$/.test(f.path) && f.sandboxed === true), 'library labels HTML for the existing opaque-origin sandbox');

    // ===================== W7: OPEN the deliverable, don't display its code =====================
    // Build a SELF-CONTAINED web tool (index.html + README.md) and prove the two open surfaces + their guards.
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-web', title: 'a web tool: tip calculator' }) }).then(r => r.json());
    const webShift = await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) });
    const webStream = await readNdjson(webShift);
    const webRes = ((webStream.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.ok(webRes.fired === true && webRes.reason === 'built', 'W7: the web-tool shift built a deliverable');
    const webRun = webRes.runId;
    A.ok(webRes.manifest && webRes.manifest.files.some(f => /index\.html$/.test(f.path)), 'W7: manifest lists index.html');

    // (1) GET /workshop-run/~t/<run ticket>/.../index.html returns the RUNNABLE page (text/html, script intact, no-store).
    //     The ticket rides the PATH so the page's relative assets inherit it (never the master token in a URL).
    const { runPrefix } = require('./_httpToken.js');
    const runBase = B + runPrefix(token, 'builder', webRun) + 'builder/' + webRun;
    const plainBase = B + '/workshop-run/builder/' + webRun;
    const pageRes = await fetch(runBase + '/index.html');
    A.eq(pageRes.status, 200, 'W7: /workshop-run serves the html page 200');
    A.ok(/text\/html/.test(pageRes.headers.get('content-type') || ''), 'W7: html is served as text/html (RUNNABLE, not octet-stream)');
    A.ok(/no-store/.test(pageRes.headers.get('cache-control') || ''), 'W7: /workshop-run is Cache-Control no-store');
    const pageBody = await pageRes.text();
    A.ok(/<script>/.test(pageBody) && /dataset\.ready/.test(pageBody), 'W7: the served html still contains its inline script (it will run in a tab)');

    // AUDIT 0.3 — OPAQUE-ORIGIN SANDBOX: a served deliverable is same-origin executable HTML, so it MUST carry
    // `Content-Security-Policy: sandbox allow-scripts` (scripts run, but NO allow-same-origin → opaque origin →
    // can't read window.__STARNET_API_TOKEN__ or make credentialed /api/* calls). allow-same-origin would defeat
    // the whole fence, so assert it is ABSENT. HEAD carries the same header (a preflight probe must see the fence).
    const cspOf = r => (r.headers.get('content-security-policy') || '');
    A.ok(/\bsandbox\b/.test(cspOf(pageRes)), 'AUDIT 0.3: served html carries a sandbox CSP');
    A.ok(/allow-scripts/.test(cspOf(pageRes)), 'AUDIT 0.3: the sandbox allows scripts (interactive deliverables still run)');
    A.ok(!/allow-same-origin/.test(cspOf(pageRes)), 'AUDIT 0.3: the sandbox does NOT allow-same-origin (opaque origin — token/API unreachable)');
    const headRes = await fetch(runBase + '/index.html', { method: 'HEAD' });
    A.ok(/\bsandbox\b/.test(cspOf(headRes)) && !/allow-same-origin/.test(cspOf(headRes)), 'AUDIT 0.3: HEAD response carries the same opaque-origin sandbox CSP');

    // correct content-type for a non-html asset too (README.md → text/markdown).
    const mdRes = await fetch(runBase + '/README.md');   // a SIBLING asset under the same ticketed prefix (what a relative <link>/<script> resolves to)
    A.ok(/text\/markdown/.test(mdRes.headers.get('content-type') || ''), 'W7: .md served with markdown content-type');
    A.ok(/\bsandbox\b/.test(cspOf(mdRes)) && !/allow-same-origin/.test(cspOf(mdRes)), 'AUDIT 0.3: sibling assets served from the run dir carry the sandbox CSP too');

    A.eq(pageRes.headers.get('referrer-policy'), 'no-referrer', 'W7: a served tool never leaks its ticketed URL as a Referer');

    // (2) CREDENTIAL REQUIRED — a run ticket (tab nav) or the header (fetch); the MASTER token in a URL is refused.
    const noTok = await fetch(plainBase + '/index.html');
    A.eq(noTok.status, 403, 'W7: /workshop-run without a credential is 403 forbidden');
    const badTok = await fetch(B + '/workshop-run/~t/wrong/builder/' + webRun + '/index.html');
    A.eq(badTok.status, 403, 'W7: /workshop-run with a WRONG ticket is 403 forbidden');
    const masterQuery = await fetch(plainBase + '/index.html?token=' + encodeURIComponent(token));
    A.eq(masterQuery.status, 403, 'W7: the MASTER token as ?token= is refused (it leaked into OS-browser history)');
    const masterPath = await fetch(B + '/workshop-run/~t/' + encodeURIComponent(token) + '/builder/' + webRun + '/index.html');
    A.eq(masterPath.status, 403, 'W7: the MASTER token in the ticket slot is refused');
    const otherRun = await fetch(B + runPrefix(token, 'builder', 'some-other-run') + 'builder/' + webRun + '/index.html');
    A.eq(otherRun.status, 403, 'W7: a ticket for another run does not open this run');
    const Tickets = require('../sidecar/apitickets.js');
    const oldT = Tickets.mint(token, 'run', Tickets.scopeRun('builder', webRun), { now: Date.now() - Tickets.KINDS.run.maxTtlMs - 1000 });
    const expiredRun = await fetch(B + '/workshop-run/~t/' + oldT + '/builder/' + webRun + '/index.html');
    A.eq(expiredRun.status, 403, 'W7: an EXPIRED run ticket is 403');
    const viaHeader = await fetch(plainBase + '/index.html', { headers: { 'x-starnet-token': token } });
    A.eq(viaHeader.status, 200, 'W7: a fetch with the header still reads the run (no URL credential needed)');

    // (3) TRAVERSAL IMPOSSIBLE — a ../ escape and an encoded escape both refuse (never reach a file outside the jail).
    const trav1 = await fetch(runBase + '/../../builder.workshop.json');
    A.ok(trav1.status === 403 || trav1.status === 404, 'W7: ../ traversal is refused (403/404), never served');
    const trav2 = await fetch(B + runPrefix(token, 'builder', '..') + 'builder/' + encodeURIComponent('..') + '/' + encodeURIComponent('..') + '/builder.workshop.json');
    A.ok(trav2.status === 403 || trav2.status === 404, 'W7: encoded ../ traversal is refused');
    const badAgent = await fetch(B + runPrefix(token, '../../etc', webRun) + '..%2f..%2fetc/' + webRun + '/index.html');
    A.ok(badAgent.status === 403 || badAgent.status === 404, 'W7: a bad agentId segment is refused');

    // (4) NO DIRECTORY LISTING — requesting the run dir itself (a directory) 404s, never lists.
    const dirReq = await fetch(runBase + '/');
    A.eq(dirReq.status, 404, 'W7: requesting a directory 404s (no directory listing)');
    const dirReq2 = await fetch(runBase);
    A.ok(dirReq2.status === 404, 'W7: the run dir with no trailing file also 404s');

    // (5) POST /api/workshop/open is inert for every payload; token possession
    //     never reaches an OS opener and does not stand in for a human gesture.
    const openOk = await fetch(B + '/api/workshop/open', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: webRun, path: 'README.md' }) });
    const openOkJ = await openOk.json();
    A.ok(openOk.status === 403 && /Open this file manually/.test(openOkJ.error || ''), 'W7: API-token-only open is refused');
    const readOpenLog = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8') : '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const openedTargets = () => readOpenLog().map(e => String(e.target || ''));
    A.eq(openedTargets().length, 0, 'W7: HTTP open never invokes an OS opener');

    const openBad = await fetch(B + '/api/workshop/open', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: webRun, path: '../../builder.workshop.json' }) });
    A.eq(openBad.status, 403, 'W7: traversal cannot reach a native opener');
    const openMissing = await fetch(B + '/api/workshop/open', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: webRun, path: 'does-not-exist.txt' }) });
    A.eq(openMissing.status, 403, 'W7: missing paths cannot reach a native opener');

    // (6) decide keep { open:true } copies only and never opens the destination.
    const keepOpenDir = path.join(os.tmpdir(), 'starnet-keepopen-' + Date.now());
    const koRes = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: webRun, decision: 'keep', destPath: keepOpenDir, open: true }) });
    const koJ = await koRes.json();
    A.ok(koRes.status === 200 && koJ.ok === true && koJ.opened === false, 'W7: keep copies but HTTP cannot open the destination');
    A.eq(openedTargets().length, 0, 'W7: decide HTTP never invokes an OS opener');
    try { fs.rmSync(keepOpenDir, { recursive: true, force: true }); } catch (_) {}

    // 7. GRANT IS LOAD-BEARING: an UNGRANTED agent's autonomous fs.write is DENIED. Queue+shift on a NON-granted
    //    agent -> the write default-denies -> no manifest -> no workshop.built (fired but reason no-manifest).
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'nogrant', on: false }) });
    // queue directly in the store isn't exposed for an ungranted agent via a grant gate, but the queue route allows
    // queueing regardless of grant; fire the shift — runWorkshopShift itself refuses when not granted.
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'nogrant', id: 'ng-1', title: 'blocked build' }) }).then(r => r.json());
    const ngText = await (await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'nogrant' }) })).text();
    const ngRes = JSON.parse(ngText.trim().split('\n').filter(Boolean).pop());
    A.ok(ngRes.payload && ngRes.payload.fired === false && ngRes.payload.reason === 'not-granted', 'an UNGRANTED agent cannot run a workshop shift (grant is load-bearing)');
    A.ok(!fs.existsSync(path.join(ws, 'nogrant', 'workshop')), 'the ungranted agent wrote nothing');

    // A twice-failed Workshop item parks and remains visible as failed rather than disappearing into the queue.
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-fail', title: 'Fail build deliberately' }) });
    for (let i = 0; i < 2; i++) await readNdjson(await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) }));
    const failedLibrary = await (await fetch(B + '/api/deliverables?status=failed', { headers })).json();
    A.ok(failedLibrary.items.some(r => r.title === 'Fail build deliberately' && r.status === 'failed'), 'parked Workshop failure is a durable failed library row');

    // A model's completed claim cannot erase a missing entrypoint or support file.
    const partialRuns = [];
    for (const missing of ['entry', 'support']) {
      const partialAgent = 'partial-' + missing;
      await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: partialAgent, on: true }) });
      await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: partialAgent, id: partialAgent, title: 'Partial ' + missing + ' build' }) });
      for (let attempt = 0; attempt < 2; attempt++) {
        const events = await readNdjson(await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: partialAgent }) }));
        const outcome = (events.find(e => e.name === 'workshop.shift.result') || {}).payload || {};
        A.eq(outcome.reason, 'no-manifest', 'missing ' + missing + ' rejects completion');
        A.ok(!outcome.manifest, 'missing ' + missing + ' never returns a partial success manifest');
        A.ok(!events.some(e => e.name === 'workshop.built'), 'missing ' + missing + ' never emits built');
        const present = missing === 'entry' ? 'README.md' : 'index.html';
        A.ok(outcome.runId && fs.existsSync(path.join(ws, partialAgent, 'workshop', outcome.runId, present)), 'missing ' + missing + ' preserves recoverable files');
        partialRuns.push(outcome.runId);
        if (outcome.reason !== 'no-manifest') break;
      }
      const partialLibrary = await (await fetch(B + '/api/deliverables?agentId=' + partialAgent, { headers })).json();
      A.ok(partialLibrary.items.some(r => r.title === 'Partial ' + missing + ' build' && r.status === 'failed'), 'missing ' + missing + ' remains visibly failed after retry');
    }
    A.ok(!sse.events.some(e => e.name === 'workshop.built' && partialRuns.includes(e.payload && e.payload.runId)), 'durable SSE never advertises an incomplete build');

    // 7.4 KEEP copies a deliverable OUT to a user-chosen folder — COPYFILE_EXCL by default (never a silent
    //     clobber). Runs on its OWN queued item so it doesn't retire item-1 (step 8 still needs it). A second
    //     keep to the SAME folder is refused 409 EEXIST; overwrite:true then replaces.
    await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-keep', title: 'Keep me' }) }).then(r => r.json());
    const keepShift = await fetch(B + '/api/workshop/shift', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder' }) });
    const keepStream = await readNdjson(keepShift);
    const runId2 = ((keepStream.find(e => e.name === 'workshop.shift.result') || {}).payload || {}).runId;
    A.ok(runId2 && runId2 !== runId, 'a second shift built a second deliverable with its own runId');

    const keepDir = path.join(os.tmpdir(), 'starnet-keep-' + Date.now());
    const keep1 = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId2, decision: 'keep', destPath: keepDir }) });
    const keep1j = await keep1.json();
    A.ok(keep1.status === 200 && keep1j.ok === true && keep1j.copied >= 1, 'keep to a fresh folder copies the deliverable files');
    A.ok(fs.existsSync(path.join(keepDir, 'cleaner.py')), 'the kept file really landed at destPath');

    const keep2 = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId2, decision: 'keep', destPath: keepDir }) });
    const keep2j = await keep2.json();
    A.eq(keep2.status, 409, 'keep to a folder that already has the file is refused 409 (no silent overwrite)');
    A.ok(keep2j.code === 'EEXIST' && keep2j.overwritable === true, 'the refusal names EEXIST and flags it overwritable');

    const keep3 = await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId2, decision: 'keep', destPath: keepDir, overwrite: true }) });
    A.eq(keep3.status, 200, 'keep with overwrite:true replaces the existing files');
    try { fs.rmSync(keepDir, { recursive: true, force: true }); } catch (_) {}

    // 8. DISCARD removes the run dir + denylists the item (never silently rebuilt).
    const dec = await (await fetch(B + '/api/workshop/decide', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', runId: runId, decision: 'discard' }) })).json();
    A.ok(dec.ok === true && dec.decision === 'discard', 'discard decision accepted');
    A.ok(!fs.existsSync(runDir), 'discard wiped the run dir');
    const reQ = await (await fetch(B + '/api/workshop/queue', { method: 'POST', headers, body: JSON.stringify({ agentId: 'builder', id: 'item-1', title: 'CSV cleaner' }) })).json();
    A.ok(reQ.ok === false && reQ.reason === 'discarded', 'the discarded item cannot be re-queued (discard = never again)');

    const libraryDecided = await (await fetch(B + '/api/deliverables', { headers })).json();
    A.ok(libraryDecided.items.some(r => r.runId === runId2 && r.status === 'kept'), 'library preserves the kept lifecycle after the backlog row retires');
    A.ok(libraryDecided.items.some(r => r.runId === runId && r.status === 'discarded'), 'library preserves the discarded lifecycle after files are removed');

    const preview = await (await fetch(B + '/api/deliverables/cleanup-preview', { method: 'POST', headers, body: JSON.stringify({ statuses: ['discarded'] }) })).json();
    A.ok(preview.ok && preview.targets.length === 1 && preview.targets[0].runId === runId, 'status-scoped cleanup preview names the exact discarded target');
    A.ok(preview.protected.some(r => r.runId === runId2 && r.status === 'kept'), 'cleanup preview protects kept work');
    const cleaned = await (await fetch(B + '/api/deliverables/cleanup', { method: 'POST', headers, body: JSON.stringify({ statuses: preview.statuses, fingerprint: preview.fingerprint }) })).json();
    A.ok(cleaned.ok && cleaned.removed === 1 && cleaned.undoToken, 'cleanup applies only the previewed metadata rows');
    const undone = await (await fetch(B + '/api/deliverables/cleanup-undo', { method: 'POST', headers, body: JSON.stringify({ undoToken: cleaned.undoToken }) })).json();
    A.ok(undone.ok && undone.restored === 1, 'cleanup undo restores the removed lifecycle row');

    // 9. PERSISTENCE: lifecycle records survive a real sidecar restart, not merely a fresh store instance.
    A.ok(fs.existsSync(path.join(ws, 'builder.workshop.json')), 'the workshop store persisted to disk');
    if (sse) { sse.close(); sse = null; }
    try { child.kill(); } catch (_) {}
    await sleep(180);
    const restarted = await boot(firstBoot.port, env, 20); child = restarted.child; B = 'http://' + HOST + ':' + restarted.port;
    const token2 = await bootToken(B, B);
    const headers2 = { 'Content-Type': 'application/json', 'X-StarNet-Token': token2, Origin: B };
    const afterRestart = await (await fetch(B + '/api/deliverables', { headers: headers2 })).json();
    A.ok(afterRestart.items.some(r => r.runId === runId2 && r.status === 'kept'), 'kept deliverable remains indexed after sidecar restart');
    A.ok(afterRestart.items.some(r => r.runId === runId && r.status === 'discarded'), 'discarded deliverable remains indexed after cleanup undo and restart');
    for (const missing of ['entry', 'support']) {
      const partialAfterRestart = await (await fetch(B + '/api/deliverables?agentId=partial-' + missing, { headers: headers2 })).json();
      A.ok(partialAfterRestart.items.some(r => r.title === 'Partial ' + missing + ' build' && r.status === 'failed'), 'missing ' + missing + ' remains failed after sidecar restart');
    }
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('workshop.e2e.test');
})().catch(e => { console.log('FAIL: workshop.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
