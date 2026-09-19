/* dev/seed.js — the one-command dev launcher: boot a StarNet sidecar that is ALREADY onboarded.

   Why this exists: every fresh sidecar launch (a new SKYNET_WORKSPACES dir + a new browser origin/port)
   used to drop you at the title screen → connect screen (paste key, pick model) → the WAKE ceremony,
   every single time. That is fine for testing onboarding itself, but ruinous for testing everything else.

   What it does:
     1. Loads dev/.env.dev (gitignored) for SKYNET_OPENROUTER_KEY + SKYNET_DEFAULT_MODEL (+ optional port).
        Real shell env vars win over .env.dev, so you can override per launch.
     2. Materializes a scratch workspace from the committed golden fixture (dev/fixtures/seed-workspace/):
        a ready agent (identity, purpose, model) so the host boots configured. Fresh copy each run by
        default (clean slate, still onboarded); pass --keep to reuse the previous scratch dir.
     3. Launches `node sidecar/index.js` in DEV mode: SKYNET_DEV=1 (the frontend auto-boot hook) +
        SKYNET_FULL_ACCESS=1 (no consent prompts mid-test) + the seeded workspace + your key/model.

   Result: open the printed URL and you land straight in the live station, agent awake, ready to chat.
   No BEGIN, no key paste, no ceremony — on any port.

   Dev-only. The SKYNET_DEV flag is never set in a packaged build, so none of this can leak to shipping. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'seed-workspace');
const workspaceArg = process.argv.indexOf('--workspace');
const workspaceValue = workspaceArg < 0 ? null : process.argv[workspaceArg + 1];
if (workspaceArg >= 0 && (!workspaceValue || workspaceValue.startsWith('--'))) die('--workspace requires a directory');
if (workspaceArg >= 0 && !process.argv.includes('--keep')) die('--workspace requires --keep; explicit workspaces are never cleared');
const SCRATCH = workspaceValue ? path.resolve(workspaceValue) : path.join(__dirname, '.scratch-workspace');
const ENV_DEV = path.join(__dirname, '.env.dev');
const SIDECAR = path.join(REPO, 'sidecar', 'index.js');

const KEEP = process.argv.includes('--keep');

function die(msg) { console.error('\n[dev:seed] ' + msg + '\n'); process.exit(1); }

// minimal .env parser: KEY=VALUE per line, # comments, optional surrounding quotes. Does NOT override a
// value already present in the real environment (shell env wins, so you can override per launch).
function loadEnvDev() {
  if (!fs.existsSync(ENV_DEV)) return false;
  const txt = fs.readFileSync(ENV_DEV, 'utf8');
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

// build the scratch workspace from the golden fixture, then stamp the live model + a fresh updatedAt into
// the seeded save/roster so (a) the model HUD is correct and (b) the server save always wins the boot-time
// reconcile against any stale localStorage left over from a previous session on the same port.
function materializeWorkspace(model) {
  if (!KEEP && fs.existsSync(SCRATCH)) fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  // --keep must actually KEEP the previous session's state. The old unconditional cpSync overwrote
  // agent.save.json/agent.roster.json from the fixture on EVERY relaunch — and the boot reconcile is
  // "freshest updatedAt wins", so the re-stamped fixture (crew none, default station) silently clobbered
  // the real save: summoned crew + built floor vanished on every --keep restart. With --keep we only
  // fill in MISSING files (a fixture file added since the scratch was made) and never touch existing ones.
  const kept = KEEP && fs.existsSync(path.join(SCRATCH, 'agent.save.json'));
  fs.cpSync(FIXTURE, SCRATCH, { recursive: true, force: !kept, errorOnExist: false });
  if (kept) return;   // the kept save/roster already carry the session's real model + updatedAt

  const now = Date.now();
  const savePath = path.join(SCRATCH, 'agent.save.json');
  try {
    const w = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    w.updatedAt = now; w.savedAt = now;
    if (w.doc) { w.doc.updatedAt = now; if (w.doc.agent) w.doc.agent.model = model || w.doc.agent.model || ''; }
    fs.writeFileSync(savePath, JSON.stringify(w, null, 2));
  } catch (e) { console.warn('[dev:seed] could not stamp agent.save.json:', e.message); }

  const rosterPath = path.join(SCRATCH, 'agent.roster.json');
  try {
    const r = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    for (const a of (r.agents || [])) a.model = model || a.model || '';
    fs.writeFileSync(rosterPath, JSON.stringify(r, null, 2));
  } catch (e) { /* roster is optional for the browser loop */ }
}

// print a LOUD boxed warning to stderr (used when the configured model is dead on the live catalog).
function warnBox(lines) {
  const width = Math.max(58, ...lines.map(l => l.length)) + 2;
  const top = '  ┏' + '━'.repeat(width) + '┓';
  const bot = '  ┗' + '━'.repeat(width) + '┛';
  console.error('');
  console.error(top);
  for (const l of lines) console.error('  ┃ ' + l.padEnd(width - 1) + '┃');
  console.error(bot);
  console.error('');
}

// Fail-open pre-flight: fetch the KEY-INDEPENDENT public OpenRouter catalog (same source the sidecar warms
// at boot) and check the configured model id is present. If it's ABSENT, warn LOUDLY that the first run will
// fail — model ids rot and a dead default 404s ("No endpoints found"). We WARN, never block: an unreachable
// catalog, a fetch error, or a brand-new-but-real slug must not stop a dev launch (mirrors the sidecar's
// warmModelCatalogSet() returning null => skip the check). Returns a promise that always resolves.
async function checkModelInCatalog(model) {
  if (typeof globalThis.fetch !== 'function') return;   // ancient node; sidecar warm will still run
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: ctrl.signal });
    if (!r.ok) return;                                  // catalog unreachable -> stay quiet, sidecar decides
    const body = await r.json();
    const list = (body && body.data) || body;
    if (!Array.isArray(list) || !list.length) return;   // empty/odd payload -> don't false-alarm
    const ids = list.map(m => String((m && m.id) || '')).filter(Boolean);
    if (ids.indexOf(model) !== -1) return;              // present -> all good, no noise
    const near = ids.filter(id => id.toLowerCase().indexOf('anthropic/') === 0).slice(0, 4);
    warnBox([
      'default model NOT in live catalog — first runs WILL fail.',
      '',
      '  SKYNET_DEFAULT_MODEL = ' + model,
      '  This id is not on openrouter.ai/api/v1/models (it 404s:',
      '  "No endpoints found"). Set SKYNET_DEFAULT_MODEL to a live id',
      '  in dev/.env.dev, then relaunch.' ,
      ...(near.length ? ['', '  Live Anthropic ids right now, e.g.:', ...near.map(x => '    ' + x)] : [])
    ]);
  } catch (_) {
    /* fetch error / abort -> fail-open: say nothing, let the sidecar warm + the first run report the truth */
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const hadEnvDev = loadEnvDev();
  if (!fs.existsSync(SIDECAR)) die('cannot find sidecar at ' + SIDECAR);
  if (!fs.existsSync(FIXTURE)) die('cannot find the seed fixture at ' + FIXTURE);

  const key = String(process.env.SKYNET_OPENROUTER_KEY || '').trim();
  const model = String(process.env.SKYNET_DEFAULT_MODEL || '').trim();
  const port = String(process.env.SKYNET_PORT || process.env.PORT || '8787').trim();

  if (!model) {
    die('no SKYNET_DEFAULT_MODEL set.\n' +
        '  Set it once in dev/.env.dev (copy dev/.env.dev.example), e.g.\n' +
        '    SKYNET_DEFAULT_MODEL=anthropic/claude-haiku-4.5   # a live id (ids rot — see .env.dev.example)\n' +
        (hadEnvDev ? '  (dev/.env.dev was found but had no SKYNET_DEFAULT_MODEL)' : '  (no dev/.env.dev found yet)'));
  }
  if (!key) {
    console.warn('[dev:seed] WARNING: no SKYNET_OPENROUTER_KEY set — the UI will load and resume, but agent\n' +
                 '           runs will fail until a key is provided (set it in dev/.env.dev). If you sign in\n' +
                 '           with ChatGPT/Codex instead, ignore this.');
  }

  // Pre-flight the live catalog so a dead default model is called out LOUDLY here, not silently swallowed
  // until the agent's first chat fails. Fail-open: never blocks the launch (see checkModelInCatalog).
  await checkModelInCatalog(model);

  materializeWorkspace(model);

  const childEnv = Object.assign({}, process.env, {
    SKYNET_DEV: '1',
    SKYNET_FULL_ACCESS: '1',
    SKYNET_WORKSPACES: SCRATCH,
    SKYNET_PORT: port
  });

  const url = 'http://127.0.0.1:' + port;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║  StarNet DEV SEED — booting a pre-onboarded station        ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('   agent     : NOVA (seeded, no setup needed)');
  console.log('   model     : ' + model);
  console.log('   key       : ' + (key ? 'set (' + key.slice(0, 7) + '…)' : 'NOT SET — runs will fail'));
  console.log('   workspace : ' + SCRATCH + (KEEP ? '  [--keep: reused]' : '  [fresh copy]'));
  console.log('   open      : ' + url);
  console.log('   (full access on; no consent prompts; dev auto-boot skips onboarding)');
  console.log('');

  const child = spawn(process.execPath, [SIDECAR], { cwd: REPO, env: childEnv, stdio: 'inherit' });
  const fwd = (sig) => { try { child.kill(sig); } catch (_) {} };
  process.on('SIGINT', () => fwd('SIGINT'));
  process.on('SIGTERM', () => fwd('SIGTERM'));
  child.on('exit', code => process.exit(code == null ? 0 : code));
}

main().catch(e => die('unexpected: ' + (e && e.message || e)));
