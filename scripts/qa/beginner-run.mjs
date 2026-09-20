#!/usr/bin/env node
/* scripts/qa/beginner-run.mjs — the Self-Testing Station's BEGINNER RUN (lane Q2).
 *
 * WHY THIS EXISTS: the whole product thesis is "a brand-new user reaches first value,
 * unassisted, in under 10 minutes." Every other QA detector (shoot/audit/golden) boots the
 * SEEDED path — a pre-onboarded agent already on the floor — deliberately skipping the
 * title/connect/create/awakening flow. So the FRESH-USER path has ZERO automated coverage,
 * and a merge that breaks onboarding regresses silently until Andrew hits it by hand. This
 * script IS the measuring stick: it CDP-drives the cold path a real first-timer walks and
 * screenshots + times every step, failing loudly (with evidence + a ledger finding) the
 * moment a step stalls.
 *
 * THE FRESH BOOT (the key difference from shootRun.mjs): we boot a sidecar WITHOUT SKYNET_DEV
 * and against a THROWAWAY EMPTY temp workspace. Re-derived from dev/seed.js + sidecar/index.js:
 *   - SKYNET_WORKSPACES=<temp dir>  → the sidecar persists into our scratch, NEVER the real
 *     %LOCALAPPDATA%\StarNet\workspaces. An EMPTY dir means no agent.save.json → app.js init()
 *     finds no save → startCreation() → the CREATE YOUR OVERSEER connect screen shows.
 *   - NO SKYNET_DEV: with DEV_MODE off the served index.html does NOT inject window.__STARNET_DEV__,
 *     so harness.js does not treat the origin as pre-configured and does NOT auto-resume. The
 *     connect screen and awakening run for real — exactly what a first-timer sees.
 *   - SKYNET_PORT in the 8950-8959 lane (Part-3 port registry).
 *
 * MODES:
 *   --ui-only (default): a placeholder model + dummy key are handed to the sidecar via env so the
 *     backend is configured, but the browser still drives every control by hand. Asserts every
 *     screen/control on the path is REACHABLE up to the LLM boundary. The awakening ceremony is
 *     100% client-scripted (dialogue chips author local .md docs — no model call), so it is fully
 *     reachable UI-only. WAKE's mandatory wire preflight is aimed at a deterministic local OpenRouter;
 *     the FIRST task /api/run is still the tutorial's first-command (Chat.send(TASK)). That is the
 *     explicit UI-only boundary: reaching it is a PASS (we do not fake a task reply).
 *   --live: a real key from env ONLY (SKYNET_OPENROUTER_KEY / STARNET_OPENROUTER_KEY, or
 *     --key-env <NAME>). Never committed, never echoed, never written into any evidence file.
 *     Drives the full path to a first visible deliverable. Run `npm run lint:evidence-secrets`
 *     over the run dir as part of the gate (the CLI does this automatically after a --live run).
 *
 * EVIDENCE: every step screenshots into .bugloops/beginner-<stamp>/ with a timings.json (per-step
 * ms + total). On stall: capture the stuck frame, file a P0 ledger finding (crew "Beginner Run",
 * fingerprinted on the stuck step), exit nonzero. Then refresh qa/STATUS.md's Beginner Run row.
 *
 * HOUSE PATTERN: the PURE logic (step-budget accounting, timings shape, finding construction) is
 * exported as a factory with an injected clock so test/qa-beginner.test.js exercises it with zero
 * browser/sidecar. The CDP driver + real io live in the CLI block at the foot (the composition
 * root — the only place ambient Date.now()/fs/Chrome live), exactly like ledger.mjs.
 */

// STATIC imports only (side-effect-free) so require(esm) from the CJS test still works — NO
// top-level await anywhere in this module (that would make it un-require()-able, exactly the trap
// ledger.mjs also avoids). cdp.mjs merely defines functions on import; child_process/os spawn
// nothing until called inside the CLI block.
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from '../lib/cdp.mjs';
import { makeLedger } from './ledger.mjs';

/* ─────────────────────────────── PURE CORE ─────────────────────────────── */

// The canonical fresh-user path. Each step has a stable id (fingerprint + timings key), a human
// label, and a per-step budget in ms. `boundary:true` marks the step where UI-only legitimately
// stops (a real LLM response is required to go further). Total budget = 10 minutes (the thesis).
export const STEP_DEFS = [
  { id: 'boot',           label: 'sidecar up + page loaded',            budgetMs: 90000 },
  { id: 'title',          label: 'CREATE YOUR OVERSEER screen reached', budgetMs: 30000 },
  { id: 'connect',        label: 'name + key + model entered',          budgetMs: 30000 },
  { id: 'create-agent',   label: 'WAKE OVERSEER accepted',              budgetMs: 30000 },
  { id: 'awakening',      label: 'in-game floor + awakening began',     budgetMs: 90000 },
  // first-directive's budget must cover the WHOLE remaining awakening cinematic, not just a control
  // appearing. The awakening (onboarding.js) is a deliberate, minutes-long "witnessed birth" — its own
  // comments call it "the first three minutes" — that types ignite → flood → first-contact → mandate →
  // the stakes line → the pain PROMPT before the first selectable option chip (.fnv-opts button) ever
  // renders. MEASURED live (2026-07-08, loaded multi-agent host): the focused dialogue panel opens
  // ~83s after WAKE and the first chip lands ~93s after WAKE (~102s of wall clock into the run). The
  // original 60000 was an un-measured estimate this cinematic always overran under load — the fresh-user
  // path never actually stalls (the ceremony is fine; there are zero console errors/exceptions), the
  // BUDGET was simply too tight. 180s gives honest headroom on a slow/loaded box while the real gate —
  // the 10-minute TOTAL (overTotal, checked before every step) — still catches a genuinely hung birth.
  { id: 'first-directive',label: 'first directive interaction reached', budgetMs: 180000, boundary: true },
  { id: 'first-deliverable', label: 'first visible deliverable',        budgetMs: 240000, liveOnly: true }
];

export const TOTAL_BUDGET_MS = 10 * 60 * 1000;   // the product-thesis number: first value in ten minutes.

function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
function str(v) { return v == null ? '' : String(v); }

// A run stamp like 2026-07-01T14-05-09 (filesystem-safe; no colons). Deterministic given a clock.
export function stampFor(ms) {
  const d = new Date(num(ms));
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + 'T' + p(d.getUTCHours()) + '-' + p(d.getUTCMinutes()) + '-' + p(d.getUTCSeconds());
}

// Select the steps for a mode. UI-only stops at the boundary (inclusive) and drops liveOnly steps;
// live runs every step. Never mutates STEP_DEFS.
export function stepsForMode(mode) {
  const live = mode === 'live';
  const out = [];
  for (const s of STEP_DEFS) {
    if (s.liveOnly && !live) continue;
    out.push(Object.assign({}, s));
    if (s.boundary && !live) break;   // UI-only: the boundary step is the last one we run
  }
  return out;
}

// UI-only still has one intentional model boundary before the awakening: WAKE proves the configured
// wire with a real streamed request. Give that proof a deterministic local OpenRouter rather than the
// placeholder credential ever escaping to the public API. Live mode must keep using the real provider.
export function uiOnlyProviderBaseEnv(mode, base) {
  if (mode !== 'ui-only' || !String(base || '').trim()) return {};
  return {
    SKYNET_OPENROUTER_BASE: String(base),
    STARNET_OPENROUTER_BASE: String(base),
  };
}

// A production-mode sidecar deliberately scans the canonical OS app-data roots for prior-station
// evidence. The Beginner Run must exercise that behavior without seeing the Commander's real profile,
// so the child process gets an empty OS-data namespace as well as its own SKYNET_WORKSPACES root.
export function isolatedOsDataEnv(root, pathMod = path) {
  const base = String(root || '').trim();
  if (!base) return {};
  return {
    HOME: pathMod.join(base, 'Home'),
    USERPROFILE: pathMod.join(base, 'Home'),
    LOCALAPPDATA: pathMod.join(base, 'Local'),
    APPDATA: pathMod.join(base, 'Roaming'),
    XDG_DATA_HOME: pathMod.join(base, 'Xdg'),
  };
}

// Dialogue narration has an explicit read gate. The detector may advance only while the DOM proves
// that gate is armed; otherwise a synthetic key could skip or answer unrelated UI.
export function ceremonyAdvanceKey(readGateArmed) {
  return readGateArmed === true ? ' ' : '';
}

export function startUiOnlyOpenRouter(model) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // OpenRouter's public model catalog does not prove that a supplied key is usable. The product now
      // validates candidate keys against the authenticated /auth/key endpoint before persisting them, so the
      // deterministic Beginner provider must model that no-spend wire as well as /models and inference.
      if (req.url && req.url.includes('/auth/key')) {
        const auth = String(req.headers.authorization || '');
        const valid = auth === 'Bearer sk-or-beginner-ui-only-placeholder';
        res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(valid
          ? { data: { label: 'Beginner Run Local Wire' } }
          : { error: { message: 'invalid local credential' } }));
        return;
      }
      if (req.url && req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{
          id: model,
          name: 'Beginner Run Local Wire',
          context_length: 8000,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools'],
        }] }));
        return;
      }
      if (req.url && req.url.includes('/chat/completions')) {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
          }) + '\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' });
    });
  });
}

// A genuine first boot now opens the explicit "PRESS ANY KEY" splash before creation. Returning
// users never see it. Keep the detector aligned with the user path without bypassing product state:
// this pure policy emits a real key only when the active screen proves the splash is present.
export function firstBootAdvanceKey(activeScreenId) {
  return String(activeScreenId || '') === 'screen-splash' ? 'Enter' : '';
}

// The connect screen exists statically in index.html while async boot reconciliation is still
// showing #screen-boot. A one-shot active-screen sample can therefore see the boot veil before the
// genuine first-run splash appears, send no key, and deadlock waiting for connect. This controller is
// deliberately tiny and pure: the CDP loop observes it on every poll, while the unit test can replay
// the exact boot -> splash -> connect sequence deterministically. It advances splash at most once and
// fails loud on a state that cannot belong to the isolated fresh-user title path.
export function makeFirstBootAdvanceController() {
  let advanced = false;
  let lastScreen = '?';

  function observe(activeScreenId) {
    const screen = String(activeScreenId || '?');
    lastScreen = screen;

    if (screen === 'screen-connect') return { status: 'connect', key: '', screen };
    if (screen === 'screen-splash') {
      if (!advanced) {
        advanced = true;
        return { status: 'advancing', key: firstBootAdvanceKey(screen), screen };
      }
      return { status: 'waiting', key: '', screen };
    }
    if (screen === 'screen-boot' || screen === '?') {
      return { status: 'waiting', key: '', screen };
    }
    return {
      status: 'failed', key: '', screen,
      reason: 'unexpected active screen ' + screen + ' during the isolated fresh-user title step'
    };
  }

  return {
    observe,
    lastScreen() { return lastScreen; },
    didAdvance() { return advanced; }
  };
}

export const BEGINNER_PROVIDER = 'openrouter';
export function beginnerKeyFieldValue(mode, uiOnlyKey) {
  // Live credentials already entered the isolated sidecar through env. Leaving the DOM field blank
  // preserves that configured key; typing any sentinel would overwrite the real credential.
  return mode === 'live' ? '' : String(uiOnlyKey || '');
}

// The step-budget accountant + timings recorder. Injected clock only (no Date.now() in the core).
// Usage by the driver:
//   const acct = makeRunAccountant({ clock, mode });
//   acct.startStep('boot'); ... acct.endStep();  (per step)
//   acct.result() -> { steps:[{id,label,startMs,endMs,ms,ok,overBudget,boundary}], totalMs, ok, overTotal, stalledStep }
export function makeRunAccountant(opts) {
  opts = opts || {};
  const clock = opts.clock || { now() { return 0; } };
  const mode = opts.mode === 'live' ? 'live' : 'ui-only';
  const defs = stepsForMode(mode);
  const byId = new Map(defs.map(d => [d.id, d]));

  const t0 = clock.now();
  const records = [];         // completed step records, in order
  let cur = null;             // { id, label, startMs, budgetMs, boundary }
  let stalledStep = null;     // id of the step that blew its budget or was marked failed

  function startStep(id) {
    const def = byId.get(id);
    if (!def) throw new Error('beginner-run: unknown step id "' + id + '" for mode ' + mode);
    if (cur) endStep();       // implicit close of a still-open step (defensive)
    cur = { id: def.id, label: def.label, startMs: clock.now(), budgetMs: def.budgetMs, boundary: !!def.boundary };
    return cur;
  }

  // Close the current step. `failed` forces a non-ok record (the driver passes true when a check
  // failed even if under budget, e.g. a control was NOTFOUND). Returns the finished record.
  function endStep(failed) {
    if (!cur) return null;
    const endMs = clock.now();
    const ms = Math.max(0, endMs - cur.startMs);
    const overBudget = ms > cur.budgetMs;
    const ok = !failed && !overBudget;
    const rec = { id: cur.id, label: cur.label, startMs: cur.startMs, endMs, ms, budgetMs: cur.budgetMs, ok, overBudget, boundary: cur.boundary };
    records.push(rec);
    if (!ok && !stalledStep) stalledStep = cur.id;
    cur = null;
    return rec;
  }

  // Has the TOTAL 10-minute budget already been blown as of now? The driver checks this before
  // each step so a run that drags is killed loudly rather than silently exceeding the thesis number.
  function overTotal() { return (clock.now() - t0) > TOTAL_BUDGET_MS; }

  function result() {
    // fold any still-open step in as a stall (the driver hit a fatal before endStep).
    if (cur) endStep(true);
    const totalMs = (records.length ? records[records.length - 1].endMs : clock.now()) - t0;
    const overTot = totalMs > TOTAL_BUDGET_MS;
    const ok = !stalledStep && !overTot;
    return {
      mode, startMs: t0, totalMs, budgetMs: TOTAL_BUDGET_MS,
      ok, overTotal: overTot, stalledStep,
      steps: records.map(r => Object.assign({}, r))
    };
  }

  return { startStep, endStep, overTotal, result, _mode: mode, _steps: defs.map(d => Object.assign({}, d)) };
}

// Build a ledger-shaped finding for a stall. Pure: caller supplies the evidence paths + clock ts.
// The fingerprint subject is the STEP id so the same stall never re-files (anti-nag), but two
// different stuck steps file separately.
export function buildStallFinding(o) {
  o = o || {};
  const step = str(o.step) || 'unknown';
  const label = str(o.label) || step;
  const mode = str(o.mode) || 'ui-only';
  const reason = str(o.reason) || 'step did not complete within its budget';
  const evidence = (Array.isArray(o.evidence) ? o.evidence : [o.evidence]).map(str).map(s => s.trim()).filter(Boolean);
  const ms = num(o.ms);
  const totalMs = num(o.totalMs);
  return {
    crew: 'Beginner Run',
    checkId: 'beginner-step',
    subject: step,                                 // fingerprint key: one stall per step
    severity: 'P0',                                // a broken fresh-user path is always P0 (thesis-critical)
    title: 'Beginner Run stuck at ' + step + ' (' + label + ')',
    detail: '[' + mode + '] ' + reason
      + (ms ? ' · step ran ' + ms + 'ms' : '')
      + (totalMs ? ' · total ' + totalMs + 'ms' : '')
      + '. The fresh-user path (title → connect → create → awakening → first directive → first deliverable) did not reach first value.',
    evidence,
    status: 'open'
  };
}

/* ───────────────────────────── THIN CLI / DRIVER ─────────────────────────────
 * Only runs when invoked directly. The ONLY place ambient Date.now()/fs/Chrome/child_process live.
 * The static imports above are side-effect-free so require(esm) from the CJS test still works.
 */

const INVOKED_DIRECTLY = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch (_) { return false; }
})();

// Wrapped in an async IIFE so every `await` below is FUNCTION-scoped, not module-top-level — that
// keeps this file require()-able from the CJS test (top-level await would make it an async ESM graph
// that require() rejects). Fire-and-forget: the IIFE ends in process.exit().
if (INVOKED_DIRECTLY) (async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(__dirname, '..', '..');
  const SIDECAR = path.join(REPO, 'sidecar', 'index.js');
  const BUGLOOPS = path.join(REPO, '.bugloops');
  const STATUS_MD = path.join(REPO, 'qa', 'STATUS.md');

  /* ---- args ---- */
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
  const MODE = has('--live') ? 'live' : 'ui-only';
  const PORT = Number(val('--port', process.env.STARNET_BEGINNER_PORT || '8950'));
  const CDP_PORT = Number(val('--cdp-port', process.env.STARNET_BEGINNER_CDP || '9350'));
  const KEEP = has('--keep');                         // keep the temp workspace + browser profile
  const KEY_ENV = val('--key-env', 'SKYNET_OPENROUTER_KEY');
  const STEP_SCALE = Number(val('--step-scale', '1')) || 1;   // multiply per-step budgets (slow machines)
  if (PORT < 8950 || PORT > 8959) { console.error('[qa:beginner] port ' + PORT + ' is outside the 8950-8959 lane — refusing (Part-3 port law).'); process.exit(1); }

  const now = () => Date.now();
  const clock = { now };
  const STAMP = stampFor(now());
  const RUN_DIR = path.join(BUGLOOPS, 'beginner-' + STAMP);
  fs.mkdirSync(RUN_DIR, { recursive: true });

  // temp workspace lives OUTSIDE the repo (OS temp) so it can never be swept into a commit and never
  // touches the real user workspace. Empty → the connect screen shows.
  // Recovery also inspects a workspace's sibling update-snapshots directory.
  // Own the parent, so unrelated campaigns in the OS temp root are not lineage.
  const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-beginner-ws-'));
  const TEMP_WS = path.join(TEMP_ROOT, 'workspaces');
  fs.mkdirSync(TEMP_WS);
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-beginner-profile-'));
  const OS_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-beginner-osdata-'));
  const OS_DATA_ENV = isolatedOsDataEnv(OS_DATA_ROOT, path);
  for (const dir of Object.values(OS_DATA_ENV)) fs.mkdirSync(dir, { recursive: true });

  const PLACEHOLDER_MODEL = process.env.STARNET_DEFAULT_MODEL || process.env.SKYNET_DEFAULT_MODEL || 'anthropic/claude-3.5-sonnet';
  const UI_ONLY_KEY = 'sk-or-beginner-ui-only-placeholder';   // dummy; never a real secret

  // --live: source the REAL key from env ONLY. Never echo it, never write it to evidence.
  let liveKey = '';
  if (MODE === 'live') {
    liveKey = String(process.env[KEY_ENV] || process.env.STARNET_OPENROUTER_KEY || '').trim();
    if (!liveKey) {
      console.error('[qa:beginner] --live needs a real key in env ' + KEY_ENV + ' (or STARNET_OPENROUTER_KEY). None found — refusing to run.');
      // nothing has booted yet (no sidecar/chrome); just drop the just-created scratch dirs. Don't call
      // cleanup() here — its `let sidecar/chromeProc/cdp` are still in the TDZ at this point.
      if (!KEEP) { try { fs.rmSync(TEMP_WS, { recursive: true, force: true }); } catch {} try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {} try { fs.rmSync(OS_DATA_ROOT, { recursive: true, force: true }); } catch {} try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch {} }
      process.exit(1);
    }
  }

  const log = (m) => console.log('[qa:beginner] ' + m);

  /* ---- boot a FRESH sidecar (no dev seed, empty temp workspace) ---- */
  const APP_URL = 'http://127.0.0.1:' + PORT + '/';
  const isUp = async () => { try { const r = await fetch(APP_URL); return r.ok; } catch { return false; } };

  function bootFreshSidecar() {
    const env = Object.assign({}, process.env, OS_DATA_ENV, uiOnlyProviderBaseEnv(MODE, uiOnlyProvider && uiOnlyProvider.base), {
      SKYNET_WORKSPACES: TEMP_WS,          // → persistence into the throwaway dir, never %LOCALAPPDATA%
      SKYNET_PORT: String(PORT),
      SKYNET_DEFAULT_MODEL: PLACEHOLDER_MODEL,
      SKYNET_OPENROUTER_KEY: (MODE === 'live' ? liveKey : UI_ONLY_KEY),
    });
    // CRITICAL: strip SKYNET_DEV / STARNET_DEV so the served page does NOT auto-resume — the connect
    // screen + awakening must run for real (this is the whole point of the fresh path).
    delete env.SKYNET_DEV; delete env.STARNET_DEV;
    // Also strip SKYNET_FULL_ACCESS so we exercise the same consent posture a first-timer has, unless
    // a live run needs it to complete the first directive without a manual approval; keep it off for
    // ui-only (we stop before any tool run) and on for live (so the first deliverable isn't blocked).
    if (MODE === 'live') env.SKYNET_FULL_ACCESS = '1'; else { delete env.SKYNET_FULL_ACCESS; delete env.STARNET_FULL_ACCESS; }
    return spawn(process.execPath, [SIDECAR], { cwd: REPO, env, stdio: 'ignore' });
  }

  let sidecar = null, chromeProc = null, cdp = null, uiOnlyProvider = null;
  const acct = makeRunAccountant({ clock, mode: MODE });
  const shots = [];            // { step, path } for the strip
  const timingsPath = path.join(RUN_DIR, 'timings.json');

  function cleanup() {
    try { cdp?.ws.close(); } catch {}
    try { chromeProc?.kill('SIGKILL'); } catch {}
    try { sidecar?.kill('SIGKILL'); } catch {}
    try { uiOnlyProvider?.server.close(); } catch {}
    if (!KEEP) {
      try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(OS_DATA_ROOT, { recursive: true, force: true }); } catch {}
    }
  }

  // Screenshot the current step into the run dir with a zero-padded ordinal so the strip sorts.
  async function shoot(step) {
    const ord = String(shots.length + 1).padStart(2, '0');
    const name = ord + '-' + step;
    try { const { path: p } = await capture(cdp, RUN_DIR, name); shots.push({ step, path: p }); return p; }
    catch (e) { log('screenshot failed for ' + step + ': ' + e.message); return ''; }
  }

  // Write timings.json (per-step ms + total) — done on every exit path so evidence is never lost.
  function writeTimings(extra) {
    const res = acct.result();
    const payload = Object.assign({
      mode: MODE, port: PORT, stamp: STAMP, url: APP_URL,
      total: res.totalMs, budget: res.budgetMs, ok: res.ok, overTotal: res.overTotal, stalledStep: res.stalledStep,
      steps: res.steps.map(s => ({ id: s.id, label: s.label, ms: s.ms, budgetMs: s.budgetMs, ok: s.ok, overBudget: s.overBudget, boundary: s.boundary })),
      screenshots: shots.map(s => ({ step: s.step, path: path.relative(REPO, s.path) })),
      capturedAt: new Date(now()).toISOString()
    }, extra || {});
    try { fs.writeFileSync(timingsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch (e) { log('could not write timings.json: ' + e.message); }
    return { res, payload };
  }

  // File a P0 stall finding via the ledger (real io) and refresh STATUS.md. Best-effort — never
  // throws into the exit path (a broken ledger must not mask the underlying stall).
  async function fileStall(step, label, reason, extraEvidence) {
    const evidence = [path.relative(REPO, timingsPath)]
      .concat(shots.map(s => path.relative(REPO, s.path)))
      .concat(extraEvidence || []);
    const finding = buildStallFinding({ step, label, mode: MODE, reason, evidence, ms: lastStepMs(step), totalMs: acct.result().totalMs });
    try {
      const led = realLedger(makeLedger);
      const r = led.add(finding);
      log((r.status === 'added' ? 'FILED' : r.status.toUpperCase()) + ' ledger finding for stall at ' + step + (r.finding ? ' (' + r.finding.id + ')' : '') + (r.reason ? ' — ' + r.reason : ''));
      refreshStatus(led);
    } catch (e) { log('could not file ledger finding (' + e.message + ') — the timings.json + screenshots still stand as evidence'); }
    return finding;
  }
  function lastStepMs(step) { const res = acct.result(); const s = res.steps.find(x => x.id === step); return s ? s.ms : 0; }

  function realLedger(makeLedger) {
    const FINDINGS_DIR = path.join(REPO, 'qa', 'findings');
    const KNOWN_FILE = path.join(REPO, 'qa', 'KNOWN_ISSUES.md');
    const readKnown = () => {
      try { const txt = fs.readFileSync(KNOWN_FILE, 'utf8'); const out = new Set(); const re = /fingerprint[:=]\s*`?([0-9a-fA-F]{6,})`?/g; let m; while ((m = re.exec(txt))) out.add(m[1].toLowerCase()); return out; } catch { return new Set(); }
    };
    return makeLedger({
      clock,
      io: {
        listFindings() { let names; try { names = fs.readdirSync(FINDINGS_DIR); } catch { return []; } const out = []; for (const n of names) { if (!n.endsWith('.json')) continue; try { out.push(JSON.parse(fs.readFileSync(path.join(FINDINGS_DIR, n), 'utf8'))); } catch {} } return out; },
        writeFinding(f) { fs.mkdirSync(FINDINGS_DIR, { recursive: true }); const safe = String(f.id).replace(/[^A-Za-z0-9._-]/g, '_'); fs.writeFileSync(path.join(FINDINGS_DIR, safe + '.json'), JSON.stringify(f, null, 2) + '\n', 'utf8'); },
        knownFingerprints() { return readKnown(); }
      }
    });
  }

  // Rewrite ONLY the Beginner Run row's "Last run" + "Result" cells of qa/STATUS.md, preserving every
  // other cell/column/row/section verbatim. The dashboard row is: | Beginner Run | <question> | <last
  // run> | <result> | <open> |. We replace cells 3 (last run) and 4 (result) and leave 1/2/5 as-is. If
  // the file or a well-formed row is missing, log and skip — STATUS.md is owned collectively (Q0/Q5).
  function refreshStatus() {
    let txt;
    try { txt = fs.readFileSync(STATUS_MD, 'utf8'); } catch { log('STATUS.md not found — skipping row update (Q0/Q5 own the dashboard file)'); return; }
    const res = acct.result();
    const verdict = res.ok ? 'PASS' : (res.stalledStep ? 'STUCK@' + res.stalledStep : 'FAIL');
    const when = new Date(now()).toISOString();
    const lastRun = when + ' · ' + MODE + ' · ' + res.totalMs + 'ms';
    const result = verdict;
    const lines = txt.split('\n');
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*\|\s*Beginner Run\s*\|/.test(line)) continue;
      const cells = line.split('|');
      // cells[0] is '' (leading pipe); the row cells are cells[1..]. Need at least 4 content cells.
      if (cells.length >= 6) { cells[3] = ' ' + lastRun + ' '; cells[4] = ' ' + result + ' '; lines[i] = cells.join('|'); hit = true; }
      break;
    }
    if (!hit) { log('no well-formed "Beginner Run" dashboard row in STATUS.md — leaving it untouched (Q5 seeds the rows)'); return; }
    try { fs.writeFileSync(STATUS_MD, lines.join('\n'), 'utf8'); log('STATUS.md Beginner Run row → ' + verdict); }
    catch (e) { log('could not write STATUS.md: ' + e.message); }
    writeQaStamp(res, verdict);
  }

  // ADDITIVE (EL-7): a stable machine-readable last-run stamp the READY gate (scripts/qa/ready.mjs)
  // reads. STATUS.md is a human dashboard (owned collectively, easy to reformat); this JSON is the
  // machine truth. result: 'PASS' | 'STUCK@<step>' | 'FAIL', mirroring the dashboard verdict exactly.
  // Written on every exit path (refreshStatus is called on success, stall, and fatal). Best-effort.
  function writeQaStamp(res, verdict) {
    try {
      const QA_DIR = path.join(REPO, 'qa');
      const headRun = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
      const trunkHead = headRun.status === 0 && /^[0-9a-f]{40}$/i.test(String(headRun.stdout || '').trim())
        ? String(headRun.stdout).trim().toLowerCase() : '';
      fs.mkdirSync(QA_DIR, { recursive: true });
      fs.writeFileSync(path.join(QA_DIR, 'beginner-last-run.json'), JSON.stringify({
        stampIso: new Date(now()).toISOString(),
        trunkHead,
        result: verdict,                         // 'PASS' | 'STUCK@<step>' | 'FAIL'
        mode: MODE, totalMs: res.totalMs, stalledStep: res.stalledStep || null,
      }, null, 2) + '\n', 'utf8');
    } catch (_) { /* the timings.json + STATUS.md row already stand as evidence */ }
  }

  /* ---- DOM probes (via evalJS): stable id/class selectors, re-derived from index.html/app.js ---- */
  const activeScreen = `((document.querySelector('.screen.active')||{}).id||'?')`;
  const connectReady = `(() => { try {
    const s = document.getElementById('screen-connect');
    if (!s || !s.classList.contains('active')) return false;
    return !!(document.getElementById('in-name') && document.getElementById('in-key') && document.getElementById('in-model') && document.getElementById('btn-wake'));
  } catch (e) { return false; } })()`;
  const gameActive = `(() => { try { const g = document.getElementById('screen-game'); return !!(g && g.classList.contains('active')); } catch (e) { return false; } })()`;
  // the awakening runs in the DIALOGUE panel (.fnv-dialogue inside #chat-panel); a live line or an
  // options list means the ceremony is interactive (client-scripted — no LLM needed to reach here).
  const awakeningLive = `(() => { try {
    const g = document.getElementById('screen-game'); if (!g || !g.classList.contains('active')) return false;
    const dlg = document.querySelector('#chat-panel .fnv-dialogue');
    if (dlg) return true;
    // fallback: before the focused panel opens, the awakening's monologue mirrors into COMMS as .cmsg
    // rows (the live class — the old '#chat-log .msg' selector was stale and never matched, so this
    // fallback silently no-op'd; verified live 2026-07-08 that #chat-log children are '.cmsg agent').
    return !!document.querySelector('.fnv-dialogue, .say-bubble, #chat-log .cmsg');
  } catch (e) { return false; } })()`;
  // an interactive directive point: the dialogue exposes clickable option chips OR a custom input.
  const directiveInteractive = `(() => { try {
    const opts = document.querySelectorAll('#chat-panel .fnv-opts button, #chat-panel .fnv-custom-in, .fnv-opts button');
    return opts.length > 0;
  } catch (e) { return false; } })()`;
  const ceremonyReadGate = `(() => { try {
    const panel = document.querySelector('#chat-panel .fnv-dialogue.fnv-wait, .fnv-dialogue.fnv-wait');
    const cue = panel && panel.querySelector('.fnv-more.show');
    return !!cue;
  } catch (e) { return false; } })()`;

  async function waitFor(expr, budgetMs, pollMs = 500) {
    const deadline = now() + budgetMs;
    while (now() < deadline) {
      if (acct.overTotal()) return { ok: false, reason: 'total 10-minute budget exceeded' };
      const ok = await evalJS(cdp, expr).catch(() => false);
      if (ok) return { ok: true };
      await sleep(pollMs);
    }
    return { ok: false, reason: 'per-step budget of ' + budgetMs + 'ms exhausted' };
  }

  async function waitForFirstBootConnect(budgetMs, pollMs = 500) {
    const deadline = now() + budgetMs;
    const title = makeFirstBootAdvanceController();
    while (now() < deadline) {
      if (acct.overTotal()) return { ok: false, reason: 'total 10-minute budget exceeded' };

      const screen = await evalJS(cdp, activeScreen).catch(() => '?');
      const state = title.observe(screen);
      if (state.status === 'failed') return { ok: false, reason: state.reason };

      if (state.key) {
        const keyEvent = { key: state.key, code: state.key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, keyEvent));
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, keyEvent));
        log('first-boot splash advanced with a real ' + state.key + ' keypress');
      }

      if (state.status === 'connect') {
        const ready = await evalJS(cdp, connectReady).catch(() => false);
        if (ready) return { ok: true };
      }
      await sleep(pollMs);
    }
    return {
      ok: false,
      reason: 'per-step budget of ' + budgetMs + 'ms exhausted (last active screen=' + title.lastScreen() + ')'
    };
  }

  async function waitForFirstDirective(budgetMs, pollMs = 250) {
    const deadline = now() + budgetMs;
    let advances = 0;
    while (now() < deadline) {
      if (acct.overTotal()) return { ok: false, advances, reason: 'total 10-minute budget exceeded' };
      if (await evalJS(cdp, directiveInteractive).catch(() => false)) return { ok: true, advances };

      const key = ceremonyAdvanceKey(await evalJS(cdp, ceremonyReadGate).catch(() => false));
      if (key) {
        const keyEvent = { key, code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, keyEvent));
        await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, keyEvent));
        advances++;
      }
      await sleep(pollMs);
    }
    return { ok: false, advances, reason: 'per-step budget of ' + budgetMs + 'ms exhausted' };
  }

  /* ---- the run ---- */
  let exitCode = 0;
  async function fail(step, label, reason, extraEvidence) {
    log('STALL at ' + step + ': ' + reason);
    acct.endStep(true);
    await shoot('STUCK-' + step).catch(() => {});
    const { res } = writeTimings({ failedAt: step, failReason: reason });
    await fileStall(step, label, reason, extraEvidence);
    log('run FAILED — see ' + path.relative(REPO, RUN_DIR));
    exitCode = 2;
  }

  try {
    log('mode=' + MODE + ' port=' + PORT + ' run=' + path.relative(REPO, RUN_DIR));
    log('temp workspace: ' + TEMP_WS + ' (empty → fresh connect screen; cleaned up after run)');

    // WAKE now performs a mandatory live-wire preflight before entering the station. UI-only owns a
    // local deterministic upstream for that request; --live deliberately leaves the real wire intact.
    if (MODE === 'ui-only') uiOnlyProvider = await startUiOnlyOpenRouter(PLACEHOLDER_MODEL);

    // STEP boot ---------------------------------------------------------------
    acct.startStep('boot');
    if (await isUp()) { log('WARNING: a sidecar is already up on :' + PORT + ' — reusing it (may not be a fresh workspace)'); }
    else { log('booting a FRESH (no dev-seed) sidecar on :' + PORT + ' …'); sidecar = bootFreshSidecar(); }
    { const up = await (async () => { for (let i = 0; i < 120; i++) { if (await isUp()) return true; await sleep(500); } return false; })();
      if (!up) { // can't even reach the sidecar → boot stall (no page to screenshot; timings stands)
        acct.endStep(true); writeTimings({ failedAt: 'boot', failReason: 'sidecar never came up' });
        await fileStall('boot', 'sidecar up + page loaded', 'sidecar never came up on :' + PORT, []);
        throw new Error('sidecar-never-up');
      } }
    const { proc } = launchChrome({ cdpPort: CDP_PORT, win: '1440,900', profileDir: PROFILE });
    chromeProc = proc; chromeProc.on('error', () => {});
    cdp = await connectCDP(CDP_PORT);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    // let the SPA boot; app.js init() runs async (CloudSave.reconcile etc.) before startCreation().
    const booted = await waitFor(`(() => !!document.getElementById('screen-connect'))`, STEP_DEFS[0].budgetMs * STEP_SCALE);
    await shoot('boot');
    if (!booted.ok) { await fail('boot', STEP_DEFS[0].label, 'page never rendered the connect screen DOM — ' + booted.reason); throw new Error('boot-failed'); }
    acct.endStep();
    log('boot ok — page up');

    // STEP title (the CREATE YOUR OVERSEER connect screen is the active screen) -----------------
    acct.startStep('title');
    const onConnect = await waitForFirstBootConnect(STEP_DEFS[1].budgetMs * STEP_SCALE);
    await shoot('title');
    if (!onConnect.ok) {
      const screen = await evalJS(cdp, activeScreen).catch(() => '?');
      if (screen === 'screen-lineage') {
        const lineage = await evalJS(cdp, `(async () => { const r = await fetch('/api/lineage'); return await r.json(); })()`).catch(() => null);
        fs.writeFileSync(path.join(RUN_DIR, 'unexpected-lineage.json'), JSON.stringify(lineage, null, 2) + '\n');
      }
      await fail('title', STEP_DEFS[1].label, 'never reached CREATE YOUR OVERSEER (active screen=' + screen + ', name/key/model/wake controls not all present) — ' + onConnect.reason);
      throw new Error('title-failed');
    }
    acct.endStep();
    log('title ok — CREATE YOUR OVERSEER reached');

    // STEP connect (choose OpenRouter, then fill name + key + model like a real BYOK first-timer) --
    acct.startStep('connect');
    // Product defaults to the recommended keyless ChatGPT path. This detector's isolated placeholder/
    // attended real-key modes intentionally exercise BYOK, so make that one-click choice explicitly.
    const filled = await evalJS(cdp, `(() => { try {
      const set = (id, v) => { const el = document.getElementById(id); if (!el) return false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
      const provider = document.querySelector('.prov[data-prov="${BEGINNER_PROVIDER}"]');
      if (!provider) return { ok: false, provider: false };
      provider.click();
      const nm = set('in-name', 'BEGINNER');
      const key = set('in-key', ${JSON.stringify(beginnerKeyFieldValue(MODE, UI_ONLY_KEY))});
      const model = set('in-model', ${JSON.stringify(PLACEHOLDER_MODEL)});
      const providerSelected = provider.getAttribute('aria-pressed') === 'true';
      return { nm, key, model, provider: providerSelected, ok: nm && key && model && providerSelected };
    } catch (e) { return { ok: false, err: e.message }; } })()`).catch(e => ({ ok: false, err: e.message }));
    await shoot('connect');
    if (!filled || !filled.ok) { await fail('connect', STEP_DEFS[2].label, 'could not populate the connect inputs (name/model): ' + JSON.stringify(filled)); throw new Error('connect-failed'); }
    acct.endStep();
    log('connect ok — OpenRouter selected and name/key/model entered');

    // STEP create-agent (click WAKE OVERSEER; expect a transition off the connect screen) ---------
    acct.startStep('create-agent');
    // NOTE (live vs ui-only key): in ui-only the sidecar already holds the placeholder key server-side,
    // so onWake()'s configured() check passes and the (fake) key in the box is harmless. In live, the
    // real key was seeded into the sidecar env — we intentionally do NOT type it into the DOM, so it is
    // never captured in a screenshot. onWake() sees configured()===true and proceeds.
    const clicked = await evalJS(cdp, `(() => { const b = document.getElementById('btn-wake'); if (!b) return 'NOTFOUND'; try { b.click(); return 'clicked'; } catch (e) { return 'CLICK_ERR:' + e.message; } })()`).catch(e => 'ERR:' + e.message);
    if (clicked !== 'clicked') { await shoot('create-agent'); await fail('create-agent', STEP_DEFS[3].label, 'WAKE OVERSEER control not clickable: ' + clicked); throw new Error('wake-failed'); }
    // WAKE accepted iff we leave the connect screen (or a validation message stays = rejected).
    const left = await waitFor(`(() => { const s = document.getElementById('screen-connect'); return !s || !s.classList.contains('active'); })()`, STEP_DEFS[3].budgetMs * STEP_SCALE);
    await shoot('create-agent');
    if (!left.ok) {
      const msg = await evalJS(cdp, `((document.getElementById('connect-msg')||{}).textContent||'').trim()`).catch(() => '');
      await fail('create-agent', STEP_DEFS[3].label, 'WAKE did not advance off the connect screen' + (msg ? ' (validation said: "' + msg + '")' : '') + ' — ' + left.reason);
      throw new Error('wake-noadvance');
    }
    acct.endStep();
    log('create-agent ok — WAKE accepted, left the connect screen');

    // STEP awakening (the in-game floor is active + the awakening ceremony begins) ----------------
    acct.startStep('awakening');
    const inGame = await waitFor(gameActive, STEP_DEFS[4].budgetMs * STEP_SCALE);
    if (inGame.ok) { await waitFor(awakeningLive, Math.min(30000, STEP_DEFS[4].budgetMs) * STEP_SCALE); }
    await shoot('awakening');
    if (!inGame.ok) {
      const screen = await evalJS(cdp, activeScreen).catch(() => '?');
      await fail('awakening', STEP_DEFS[4].label, 'never reached the in-game floor after WAKE (active screen=' + screen + ') — ' + inGame.reason);
      throw new Error('awakening-failed');
    }
    acct.endStep();
    log('awakening ok — on the floor, ceremony live');

    // STEP first-directive (the awakening/tutorial exposes an interactive directive point) ---------
    // In UI-only this is the BOUNDARY: the ceremony chips are reachable without an LLM; the FIRST real
    // /api/run is the tutorial's first-command. Reaching an interactive directive point = PASS.
    acct.startStep('first-directive');
    const interactive = await waitForFirstDirective(STEP_DEFS[5].budgetMs * STEP_SCALE);
    await shoot('first-directive');
    if (!interactive.ok) {
      await fail('first-directive', STEP_DEFS[5].label, 'no interactive directive point (awakening option chips / custom input) appeared after ' + interactive.advances + ' explicit dialogue advance(s) — ' + interactive.reason);
      throw new Error('directive-failed');
    }
    log('advanced ' + interactive.advances + ' explicit dialogue read gate(s)');
    acct.endStep();
    if (MODE !== 'live') {
      log('first-directive ok — REACHED THE UI-ONLY LLM BOUNDARY (the awakening is client-scripted; the first real /api/run is the tutorial first-command, which needs a live model). Treating boundary as PASS.');
    } else {
      log('first-directive ok — interactive directive point reached');
      // STEP first-deliverable (LIVE ONLY): drive the ceremony to the first real run + a rendered reply.
      acct.startStep('first-deliverable');
      const delivered = await driveToFirstDeliverable(STEP_DEFS[6].budgetMs * STEP_SCALE);
      await shoot('first-deliverable');
      if (!delivered.ok) { await fail('first-deliverable', STEP_DEFS[6].label, 'no visible deliverable/response rendered — ' + delivered.reason); throw new Error('deliverable-failed'); }
      acct.endStep();
      log('first-deliverable ok — a real response rendered');
    }

    // captured any console errors during the run — attach to timings as diagnostic (not a hard fail).
    const consoleErrs = (diag.consoleMsgs || []).slice(0, 20);
    const { res } = writeTimings({ console: consoleErrs, exceptions: (diag.exceptions || []).slice(0, 10) });
    log(res.ok ? 'RUN PASS — total ' + res.totalMs + 'ms across ' + res.steps.length + ' steps' : 'RUN FAILED at ' + res.stalledStep);
    refreshStatus();
    if (!res.ok && exitCode === 0) exitCode = 2;
  } catch (e) {
    if (!/failed|never-up|noadvance/.test(String(e && e.message))) log('FATAL: ' + (e && e.message));
    if (exitCode === 0) exitCode = 1;
    writeTimings({ fatal: String(e && e.message) });
    refreshStatus();
  } finally {
    cleanup();
  }

  // LIVE helper: reach a first visible deliverable. The awakening → tutorial hands off to
  // Chat.send(TASK). We accept the ceremony's default chips (recommended path) to reach the first
  // command quickly, then watch #chat-log for a rendered assistant reply. Conservative + resilient:
  // it clicks the FIRST/recommended option at each dialogue node until a run's reply lands.
  async function driveToFirstDeliverable(budgetMs) {
    const deadline = now() + budgetMs;
    const replyLanded = `(() => { try {
      // a rendered assistant reply / deliverable: a non-empty assistant message row in the chat log,
      // or a run.end reflected as a completed bubble. Kept selector-broad on purpose.
      const rows = document.querySelectorAll('#chat-log .msg.assistant, #chat-log .msg.reply, #chat-log .bubble.assistant, .comms .msg.assistant');
      for (const r of rows) if ((r.textContent || '').trim().length > 1) return true;
      return false;
    } catch (e) { return false; } })()`;
    while (now() < deadline) {
      if (acct.overTotal()) return { ok: false, reason: 'total 10-minute budget exceeded' };
      if (await evalJS(cdp, replyLanded).catch(() => false)) return { ok: true };
      // advance the ceremony: click the first available recommended option chip if present.
      await evalJS(cdp, `(() => { const b = document.querySelector('#chat-panel .fnv-opts button'); if (b) { try { b.click(); return 'chip'; } catch (e) {} } return 'none'; })()`).catch(() => {});
      await sleep(1500);
    }
    return { ok: false, reason: 'no rendered deliverable within the live budget' };
  }

  // Post-run secret lint over the evidence dir (belt-and-suspenders; the gate also runs it). Never
  // writes the key anywhere, but if some product path echoed one into the DOM/screenshot metadata we
  // want to catch it loudly. Best-effort: absence of the linter never fails the run itself.
  if (MODE === 'live') {
    try {
      const lint = path.join(REPO, 'scripts', 'lint-evidence-secrets.mjs');
      const rel = path.relative(REPO, RUN_DIR);
      const r = spawn(process.execPath, [lint, rel], { cwd: REPO, stdio: 'inherit' });
      await new Promise((res) => r.on('exit', (code) => { if (code) { log('EVIDENCE SECRET LINT FAILED — a key-shaped string is in the run dir!'); if (exitCode === 0) exitCode = 3; } res(); }));
    } catch (e) { log('could not run evidence-secret lint: ' + e.message); }
  }

  process.exit(exitCode);
})();
