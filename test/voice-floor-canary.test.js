/* node test/voice-floor-canary.test.js — the live voice-floor canary judges the right thing, and CI runs it.

   scripts/canary/voice-floor.mjs is the LIVE check of the free Edge floor (it talks to Microsoft, so the gate cannot
   run it for real). This test proves, offline, what it would decide: it runs the REAL script against loopback
   stand-ins for a keyless sidecar and pins
     - green ONLY for a live Edge clip: audio/mpeg, X-Voice-Provider edge:…, a cache MISS, real MP3 bytes, and
       /api/tts/status naming the edge leg ok (a cached clip, a keyed provider, or a fallback envelope is RED)
     - a red run names the failed leg from the typed outcome, exits 1, and retries exactly --retry times
     - --report-only (the scheduled run) exits 0 with a ::warning::
     - the keyless boot environment carries no key variable
   and that .github/workflows/floor-canaries.yml runs it: report-only on the schedule, blocking with one retry at
   release, and release-train.yml waits on it before staging a draft. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'canary', 'voice-floor.mjs');
const MP3 = Buffer.concat([Buffer.from([0xFF, 0xF3, 0x44, 0xC4]), Buffer.alloc(2400, 0x55)]);

function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT].concat(args), { stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => {
      const line = out.split(/\r?\n/).find(l => l.startsWith('{"canary"')) || '';
      let verdict = null;
      try { verdict = JSON.parse(line); } catch (_) { verdict = null; }
      resolve({ code, out, verdict });
    });
  });
}

(async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);

  // ---- the pure judgement ----
  const H = o => ({ get: k => o[k.toLowerCase()] || null });
  const good = { status: 200, headers: H({ 'content-type': 'audio/mpeg', 'x-voice-provider': 'edge:en-US-ChristopherNeural', 'x-voice-cache': 'miss' }), body: MP3 };
  A.eq(mod.judgeTts(good).ok, true, 'a live Edge clip is green');
  A.eq(mod.judgeTts(Object.assign({}, good, { headers: H({ 'content-type': 'audio/mpeg', 'x-voice-provider': 'edge:v', 'x-voice-cache': 'hit' }) })).ok, false, 'a CACHED clip is red: it proves nothing about Edge today');
  A.eq(mod.judgeTts(Object.assign({}, good, { headers: H({ 'content-type': 'audio/wav', 'x-voice-provider': '', 'x-voice-cache': 'miss' }) })).ok, false, 'a keyed provider\'s clip is red: the station was not keyless');
  A.eq(mod.judgeTts(Object.assign({}, good, { body: Buffer.alloc(3000, 0x41) })).ok, false, 'bytes that are not MP3 are red');
  const fb = mod.judgeTts({ status: 200, headers: H({ 'content-type': 'application/json' }), body: Buffer.from(JSON.stringify({ fallback: true, reason: 'edge: edge upgrade refused: HTTP 403', outcome: { code: 'refused', terminal: true } })) });
  A.ok(fb.ok === false && fb.outcome && fb.outcome.code === 'refused', 'a fallback is red and carries the typed outcome (which leg failed)');
  A.ok(mod.looksLikeMp3(Buffer.from('ID3\u0004')) && !mod.looksLikeMp3(Buffer.from('RIFF')), 'MP3 sniff: an ID3 tag or a frame sync, never a WAV');
  const env = mod.keylessEnv({ PATH: '/bin', OPENROUTER_KEY: 'sk-or-x', SKYNET_OPENAI_KEY: 'sk-y', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', STARNET_CREDITS_TOKEN: 't' }, '/tmp/p', 9703);
  A.ok(!Object.keys(env).some(k => /KEY|TOKEN|SECRET/i.test(k)), 'the keyless sidecar\'s env carries no key or token variable: ' + Object.keys(env).join(','));
  A.eq([env.STARNET_PORT, env.APPDATA, env.SKYNET_EDGE_TTS_PROBE], ['9703', '/tmp/p', '0'], 'it gets the canary port, a fresh profile, and no boot probe of its own');

  // ---- the real script against loopback stand-ins for a keyless sidecar ----
  let mode = 'live', ttsCalls = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>window.__STARNET_API_TOKEN__="tok-123";</script>'); }
    if (req.url === '/api/tts' && req.method === 'POST') {
      ttsCalls++;
      if (req.headers['x-starnet-token'] !== 'tok-123') { res.writeHead(403); return res.end('forbidden token'); }
      if (mode === 'live') { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Voice-Provider': 'edge:en-US-ChristopherNeural', 'X-Voice-Cache': 'miss' }); return res.end(MP3); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ fallback: true, reason: 'edge: edge upgrade refused: HTTP 403',
        outcome: { ok: false, terminal: true, retryAfterMs: 0, code: 'refused', engine: 'edge', legs: [{ engine: 'keyed', code: 'no_key', http: 0, detail: '' }, { engine: 'edge', code: 'refused', http: 403, detail: 'edge upgrade refused: HTTP 403' }] } }));
    }
    if (req.url === '/api/tts/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ legs: { edge: mode === 'live' ? { ok: true, code: 'ok' } : { ok: false, code: 'refused', http: 403 } } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    mode = 'live'; ttsCalls = 0;
    const green = await run(['--url', url]);
    A.eq(green.code, 0, 'canary: a live Edge answer exits 0 (' + green.out.trim().slice(0, 300) + ')');
    A.ok(green.verdict && green.verdict.ok === true && green.verdict.last.provider.startsWith('edge:'), 'canary: the verdict line says green and names the Edge voice');

    mode = 'refused'; ttsCalls = 0;
    const red = await run(['--url', url, '--retry', '1']);
    A.eq(red.code, 1, 'canary: a refused floor exits 1 (blocking)');
    A.eq(red.verdict && red.verdict.attempts, 2, 'canary: --retry 1 means one retry, then red');
    A.eq(ttsCalls, 2, 'canary: two live requests, no more');
    A.ok(red.verdict && red.verdict.last.outcome && red.verdict.last.outcome.code === 'refused', 'canary: the red verdict names the failed leg (refused)');
    A.ok(/::error::the free Edge voice floor is RED/.test(red.out), 'canary: a blocking red run prints an ::error:: annotation');

    const report = await run(['--url', url, '--report-only']);
    A.eq(report.code, 0, 'canary: --report-only (the schedule) never fails the check');
    A.ok(/::warning::the free Edge voice floor is RED/.test(report.out), 'canary: but it leaves a ::warning:: annotation');
    const usage = await run(['--bogus']);
    A.eq(usage.code, 2, 'canary: an unknown argument is a usage error');
  } finally {
    srv.close();
  }

  // ---- --sidecar: the mode CI and the release train run. The canary SPAWNS the entry keyless and hermetic, waits for
  // /api/health, judges it, then kills it and removes the profile. A stub entry stands in for the sidecar (offline): it
  // reports back, through /api/tts/status, the environment it was booted with. ----
  {
    const os = require('node:os');
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-canary-stub-'));
    const stub = path.join(stubDir, 'stub-sidecar.js');
    fs.writeFileSync(stub, [
      "'use strict';",
      "const http = require('http');",
      "const MP3 = Buffer.concat([Buffer.from([0xFF, 0xF3, 0x44, 0xC4]), Buffer.alloc(2400, 0x55)]);",
      "const port = Number(process.env.STARNET_PORT);",
      "const seen = { secrets: Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET/i.test(k)), appdata: process.env.APPDATA || '',",
      "  localappdata: process.env.LOCALAPPDATA || '', workspaces: process.env.STARNET_WORKSPACES || '', probe: process.env.SKYNET_EDGE_TTS_PROBE || '', pid: process.pid };",
      "http.createServer((req, res) => {",
      "  if (req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }",
      "  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>window.__STARNET_API_TOKEN__=\"stub-tok\";</script>'); }",
      "  if (req.url === '/api/tts' && req.headers['x-starnet-token'] === 'stub-tok') { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Voice-Provider': 'edge:en-US-ChristopherNeural', 'X-Voice-Cache': 'miss' }); return res.end(MP3); }",
      "  if (req.url === '/api/tts/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ legs: { edge: Object.assign({ ok: true, code: 'ok' }, { seen }) } })); }",
      "  res.writeHead(404); res.end();",
      "}).listen(port, '127.0.0.1');"
    ].join('\n'));
    const dead = path.join(stubDir, 'dead-sidecar.js');
    fs.writeFileSync(dead, "console.error('stub: refusing to boot'); process.exit(3);\n");
    const freePort = await new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    // the canary's OWN environment carries secrets: none may reach the sidecar it boots
    const leaky = Object.assign({}, process.env, { OPENROUTER_API_KEY: 'sk-or-v1-LEAK', GITHUB_TOKEN: 'ghp_LEAK', SKYNET_OPENAI_KEY: 'sk-LEAK', STARNET_WORKSPACES: 'C:/real/workspaces' });
    const booted = await run(['--sidecar', stub, '--port', String(freePort)], leaky);
    A.eq(booted.code, 0, '--sidecar: a keyless entry that answers Edge audio is green (' + booted.out.trim().slice(0, 400) + ')');
    const seen = booted.verdict && booted.verdict.last && booted.verdict.last.status_edge && booted.verdict.last.status_edge.seen;
    A.ok(seen, '--sidecar: the stub reported the environment it was booted with');
    A.eq(seen && seen.secrets, [], '--sidecar: no key, token or secret variable reached the booted sidecar');
    A.ok(seen && /starnet-voice-canary-/.test(seen.appdata) && seen.appdata === seen.localappdata, '--sidecar: a fresh hermetic profile for APPDATA/LOCALAPPDATA: ' + (seen && seen.appdata));
    A.ok(seen && seen.workspaces.indexOf(seen.appdata) === 0, '--sidecar: and a workspace inside it, never the caller\'s STARNET_WORKSPACES: ' + (seen && seen.workspaces));
    A.eq(seen && seen.probe, '0', '--sidecar: the booted sidecar runs no boot probe of its own');
    A.ok(seen && !fs.existsSync(seen.appdata), '--sidecar: the profile is removed afterwards');
    const portFree = await new Promise(r => { const s = http.createServer(); s.once('error', () => r(false)); s.listen(freePort, '127.0.0.1', () => s.close(() => r(true))); });
    A.ok(portFree, '--sidecar: the booted sidecar is killed (its port is free again)');
    const t0 = Date.now();
    const deadRun = await run(['--sidecar', dead, '--port', String(freePort)]);
    A.eq(deadRun.code, 1, '--sidecar: an entry that never comes up is RED (exit 1)');
    A.ok(deadRun.verdict && /did not come up/.test(deadRun.verdict.last.why) && /refusing to boot/.test(deadRun.verdict.last.tail || ''), '--sidecar: and the verdict says so, with the entry\'s own output');
    A.ok(Date.now() - t0 < 20000, '--sidecar: at once when the entry exits, not after the 90 s health wait (' + (Date.now() - t0) + ' ms)');
    fs.rmSync(stubDir, { recursive: true, force: true });
  }

  // ---- CI runs it: report-only on the schedule, blocking with one retry at release ----
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'floor-canaries.yml'), 'utf8');
  const voiceJob = wf.slice(wf.indexOf('\n  voice:'));
  A.ok(/\n {2}schedule:\n {4}- cron: /.test(wf), 'floor-canaries: scheduled');
  A.ok(/\n {2}workflow_call:/.test(wf) && /\n {2}workflow_dispatch:/.test(wf), 'floor-canaries: callable by the release train, and by hand');
  A.ok(/BLOCKING: \$\{\{ github\.event_name != 'schedule'/.test(voiceJob), 'floor-canaries: the schedule is never blocking');
  A.ok(/voice-floor\.mjs --sidecar "\$SIDECAR_ENTRY" --port 9703 --retry 1/.test(voiceJob), 'floor-canaries: a blocking run retries once');
  A.ok(/voice-floor\.mjs --sidecar "\$SIDECAR_ENTRY" --port 9703 --report-only/.test(voiceJob), 'floor-canaries: a scheduled run is report-only');
  // a recovery dispatch for a tag cut BEFORE the canary existed: the script comes from the workflow's own commit, the
  // tag supplies only the sidecar under test (an old tag has no scripts/canary, and stage-draft needs this job)
  A.ok(/ref: \$\{\{ github\.workflow_sha \|\| github\.sha \}\}\n\s+path: \.canary-tool/.test(voiceJob), 'floor-canaries: the canary script is checked out from the workflow\'s own commit');
  const runs = voiceJob.match(/node \S*voice-floor\.mjs/g) || [];
  A.ok(runs.length === 2 && runs.every(r => r === 'node .canary-tool/scripts/canary/voice-floor.mjs'), 'floor-canaries: every run uses that copy, never the tag\'s (' + runs.join(' | ') + ')');
  A.ok(/ref: \$\{\{ inputs\.ref \|\| github\.ref \}\}/.test(voiceJob), 'floor-canaries: the sidecar under test is still the ref asked for');
  const train = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-train.yml'), 'utf8');
  const canaryJob = train.slice(train.indexOf('\n  voice-floor-canary:'), train.indexOf('\n  stage-draft:'));
  A.ok(/uses: \.\/\.github\/workflows\/floor-canaries\.yml/.test(canaryJob) && /blocking: true/.test(canaryJob), 'release-train: calls the voice canary, blocking');
  const stage = train.slice(train.indexOf('\n  stage-draft:'), train.indexOf('\n  stage-draft:') + 200);
  A.ok(/needs: \[assemble, voice-floor-canary\]/.test(stage), 'release-train: no draft is staged until the floor answered');

  A.report('voice-floor-canary');
})().catch(e => { console.error(e); process.exit(1); });
