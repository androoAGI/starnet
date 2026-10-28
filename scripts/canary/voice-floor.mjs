#!/usr/bin/env node
/*
 * voice-floor.mjs — the LIVE canary for StarNet's free voice floor (Microsoft's Edge read-aloud endpoint).
 *
 * WHY. A station with no OpenRouter, Gemini or OpenAI key speaks only through the keyless Edge floor. On 2026-10-26
 * Microsoft began refusing the v1 Sec-MS-GEC token with HTTP 403, and every keyless station went silent — found by a
 * user, not by us: the loopback Edge test never checks the token, so only a LIVE synth proves the floor. This script
 * is that live synth, against a keyless sidecar, with no credential anywhere in its environment.
 *
 * MODES (one per run):
 *   --sidecar <entry.js>   boot that sidecar entry KEYLESS and hermetic (fresh profile + workspace, allowlisted env,
 *                          no key variables), POST /api/tts, require Edge audio, then GET /api/tts/status. Default:
 *                          sidecar/index.js of this checkout; CI points it at the built artifact's sidecar entry.
 *   --url <http://127.0.0.1:PORT>  the same check against a sidecar that is already running (it must be keyless).
 *   --module <edgetts.js>  call that module's synth() directly, no sidecar. Used to prove the canary goes RED on the
 *                          pre-fix v1-token module (git show efad2b0af^:sidecar/edgetts.js).
 * OPTIONS:
 *   --port N          the port for --sidecar (default 9703)
 *   --retry N         re-run a red check N more times, 5 s apart (release: --retry 1)
 *   --report-only     exit 0 even when red, after a ::warning:: line (the scheduled CI run)
 *   --json <file>     also write the verdict JSON there
 * PASS = HTTP 200, Content-Type audio/mpeg, X-Voice-Provider edge:<voice>, X-Voice-Cache miss (a cached clip proves
 * nothing), at least 1000 bytes that begin with an MP3 frame or an ID3 tag — and /api/tts/status names the edge leg ok.
 * Prints ONE verdict line: {"canary":"voice-floor","ok":…}. Exit 0 green, 1 red, 2 usage.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const o = { mode: 'sidecar', sidecar: join(ROOT, 'sidecar', 'index.js'), url: '', module: '', port: 9703, retry: 0, reportOnly: false, json: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--sidecar') { o.mode = 'sidecar'; o.sidecar = resolve(next()); }
    else if (a === '--url') { o.mode = 'url'; o.url = String(next()).replace(/\/+$/, ''); }
    else if (a === '--module') { o.mode = 'module'; o.module = resolve(next()); }
    else if (a === '--port') o.port = Number(next());
    else if (a === '--retry') o.retry = Math.max(0, Number(next()) || 0);
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--json') o.json = resolve(next());
    else throw new Error('unknown argument: ' + a);
  }
  return o;
}

// An MP3 frame (11 sync bits) or an ID3 tag: what Edge's audio-24khz-48kbitrate-mono-mp3 output starts with.
export function looksLikeMp3(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  return buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
}

/* Judge one /api/tts answer. Returns { ok, why, ... }: why names the FIRST thing that is not a live Edge clip, and a
   fallback envelope's typed outcome (sidecar/speech-outcome.js) is carried through so a red run says which leg failed. */
export function judgeTts({ status, headers, body }) {
  const h = k => String((headers && (typeof headers.get === 'function' ? headers.get(k) : headers[k.toLowerCase()])) || '');
  const ct = h('content-type'), provider = h('x-voice-provider'), cache = h('x-voice-cache');
  const out = { status, contentType: ct, provider, cache, bytes: body ? body.length : 0 };
  if (/json/i.test(ct)) {
    let j = null;
    try { j = JSON.parse(Buffer.from(body || '').toString('utf8')); } catch (_) { j = null; }
    return Object.assign(out, { ok: false, why: 'the station answered a fallback, not audio', reason: j && j.reason, outcome: j && j.outcome });
  }
  if (status !== 200) return Object.assign(out, { ok: false, why: 'HTTP ' + status });
  if (!/^audio\/mpeg/i.test(ct)) return Object.assign(out, { ok: false, why: 'not audio/mpeg: ' + ct });
  if (!/^edge:/.test(provider)) return Object.assign(out, { ok: false, why: 'not the Edge floor: X-Voice-Provider=' + provider + ' (a keyed provider answered, so this station is not keyless)' });
  if (cache !== 'miss') return Object.assign(out, { ok: false, why: 'served from the voice cache (' + cache + '), which proves nothing about Edge today' });
  if (out.bytes < 1000) return Object.assign(out, { ok: false, why: 'only ' + out.bytes + ' bytes of audio' });
  if (!looksLikeMp3(body)) return Object.assign(out, { ok: false, why: 'the bytes are not an MP3 stream' });
  return Object.assign(out, { ok: true, why: '' });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const canaryText = () => 'StarNet voice floor canary, check ' + Date.now() + '.';   // unique: never a cache hit

async function bootToken(base) {
  const r = await fetch(base + '/', { headers: { Origin: base } });
  const m = /window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/.exec(await r.text());
  try { return m ? String(JSON.parse(m[1]) || '') : ''; } catch (_) { return ''; }
}

async function checkUrl(base) {
  const token = await bootToken(base);
  const headers = { 'Content-Type': 'application/json', Origin: base };
  if (token) headers['X-StarNet-Token'] = token;
  const r = await fetch(base + '/api/tts', { method: 'POST', headers, body: JSON.stringify({ text: canaryText() }), signal: AbortSignal.timeout(45000) });
  const body = Buffer.from(await r.arrayBuffer());
  const verdict = judgeTts({ status: r.status, headers: r.headers, body });
  // the status route names the leg's last outcome (absent on a sidecar older than it: reported, not required)
  try {
    const s = await fetch(base + '/api/tts/status', { headers: token ? { 'X-StarNet-Token': token, Origin: base } : { Origin: base }, signal: AbortSignal.timeout(10000) });
    if (s.ok) {
      const st = await s.json();
      verdict.status_edge = st && st.legs && st.legs.edge ? st.legs.edge : null;
      if (verdict.ok && !(verdict.status_edge && verdict.status_edge.ok)) { verdict.ok = false; verdict.why = '/api/tts/status does not name the edge leg ok: ' + JSON.stringify(verdict.status_edge); }
    } else verdict.status_route = 'HTTP ' + s.status;
  } catch (e) { verdict.status_route = String(e && e.message || e); }
  return verdict;
}

async function checkModule(file) {
  const mod = require(file);
  const t0 = Date.now();
  try {
    const buf = await mod.synth(canaryText(), { nowMs: Date.now(), timeoutMs: 20000 });
    const ok = !!buf && buf.length >= 1000 && looksLikeMp3(buf);
    return { ok, why: ok ? '' : 'synth resolved ' + (buf ? buf.length : 0) + ' bytes that are not a usable MP3', bytes: buf ? buf.length : 0, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, why: String(e && e.message || e), code: e && (e.speechCode || e.code) || '', http: e && e.http || 0, ms: Date.now() - t0 };
  }
}

// The environment a KEYLESS sidecar boots with: an allowlist (no *_KEY / *_TOKEN can leak in), a fresh profile and
// workspace, the canary's port, and the boot-time floor probe off (this script IS the probe).
const PASS_ENV = new Set(['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_TEMP']);
export function keylessEnv(parent, profile, port) {
  const env = {};
  for (const [k, v] of Object.entries(parent || {})) if (v != null && PASS_ENV.has(k.toUpperCase())) env[k] = String(v);
  Object.assign(env, {
    APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile,
    STARNET_PORT: String(port), SKYNET_PORT: String(port),
    STARNET_WORKSPACES: join(profile, 'workspaces'), SKYNET_WORKSPACES: join(profile, 'workspaces'),
    SKYNET_EDGE_TTS_PROBE: '0'
  });
  if (process.platform !== 'win32') env.HOME = profile;
  return env;
}

async function checkSidecar(entry, port) {
  const profile = mkdtempSync(join(tmpdir(), 'starnet-voice-canary-'));
  const base = 'http://127.0.0.1:' + port;
  let output = '';
  const child = spawn(process.execPath, [entry], { env: keylessEnv(process.env, profile, port), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  try {
    let healthy = false;
    for (let waited = 0; waited < 90000 && child.exitCode === null; waited += 250) {
      try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) }); if (r.status === 200) { healthy = true; break; } } catch (_) { /* not up yet */ }
      await sleep(250);
    }
    if (!healthy) return { ok: false, why: 'the keyless sidecar did not come up on ' + base, tail: output.slice(-1500) };
    return await checkUrl(base);
  } finally {
    try { child.kill(); } catch (_) { /* already gone */ }
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* a file still held on Windows */ }
  }
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
  const attempts = [];
  for (let i = 0; i <= o.retry; i++) {
    if (i) await sleep(5000);
    const v = o.mode === 'module' ? await checkModule(o.module) : o.mode === 'url' ? await checkUrl(o.url) : await checkSidecar(o.sidecar, o.port);
    attempts.push(v);
    if (v.ok) break;
  }
  const last = attempts[attempts.length - 1];
  const verdict = { canary: 'voice-floor', ok: !!last.ok, mode: o.mode, target: o.mode === 'module' ? o.module : o.mode === 'url' ? o.url : o.sidecar, attempts: attempts.length, last };
  const line = JSON.stringify(verdict);
  console.log(line);
  if (o.json) writeFileSync(o.json, line + '\n');
  if (!verdict.ok) {
    console.log('::' + (o.reportOnly ? 'warning' : 'error') + '::the free Edge voice floor is RED — ' + last.why);
    process.exit(o.reportOnly ? 0 : 1);
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
