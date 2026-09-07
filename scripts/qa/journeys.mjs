#!/usr/bin/env node
/* scripts/qa/journeys.mjs — the Self-Testing Station's JOURNEY CORPS (lane EL-1).  (`npm run qa:journeys`)
 *
 * WHY THIS EXISTS (and why it's a sibling of audit.mjs, not more scenarios inside it):
 * The Truth Auditor (scripts/audit.mjs) proves STATIC seeded states + a single-shot truthfulness
 * sweep — its main() boots ONE shared seeded sidecar and runs a fixed scenario list against it.
 * Andrew's real escapes are DYNAMIC SEAM bugs: sim↔UI↔task-truth diverging DURING multi-step
 * interactive use, and under INTERRUPTION (E-STOP, panel close, reload mid-run). Two of those —
 * a mid-run page RELOAD, and holding a run genuinely in-flight while we interrupt it — cannot be
 * expressed in the audit's shared-sidecar, fire-and-wait-for-terminal model without rewriting its
 * main(). So this is a dedicated runner that REUSES the audit's proven plumbing (scripts/lib/
 * {cdp,seed,states}.mjs, the same asserter/report/screenshot shape) and adds two things the audit
 * lacks: a CONTROLLABLE mock provider whose stream we can hold open (so a run is truly RUNNING
 * when we interrupt it) and release on command, and a per-STEP parity sweep (parityCheck) run at
 * every journey step instead of once at the end.
 *
 * THE REGRESSION TARGETS (real escapes this corps exists to catch again):
 *   (a) taskboard flooded with every chat session shown IN PROGRESS forever (kind:task|chat fix,
 *       3822e212) — J1 asserts the board rows === the kind:'task' workstreams, no chat/summon on it.
 *   (b) every >30s streaming turn died from a fixed AbortSignal.timeout (connectGuard, 46e1cf22) —
 *       the controllable mock holds a stream open well past any fixed connect timer to prove a long
 *       turn survives; the interrupt journeys prove a deliberately-killed run ends HONESTLY.
 *   (c) features breaking under interruption — J2 conversation Stop / panel-close / reload-mid-run.
 *
 * WHAT EACH JOURNEY ASSERTS (all via the DEV __SKYNET_TEST__ probe + real DOM + real Workstreams/
 * Channels globals — never a mutated fixture):
 *   J1  task-lifecycle + taskboard truth — drive a directive; at each step board rows === backend
 *       workstream store (kind:'task' only), RUNNING/DONE chip === Channels.isBusy truth, topbar +
 *       crew WORKING/IDLE counts === event-reduced truth.
 *   J2  interrupt truth — start a run held in-flight, then (a) conversation Stop, (b) close the panel, (c)
 *       reload the page; after each assert an HONEST end state (no forever-RUNNING chip, no orphan
 *       board row, truth-after-disconnect honored).
 *   J3  double-send / rapid-toggle — fire two directives fast, toggle panels mid-run; assert no
 *       duplicate board rows, no stuck RUNNING, zero uncaught console exceptions.
 *   J4  summon → assign → deliverable → OPEN — build a workshop deliverable and prove the
 *       /workshop-run jail actually SERVES it 200 + runnable html + opaque-origin sandbox CSP.
 *   J5  parityCheck(step) — the reusable sim↔truth sweep every journey calls (exported for reuse).
 *
 * LAWS (Charter Part 5 + StarNet task doctrine):
 *   - NO-FAKE-GREEN: a journey that CANNOT run exits BLOCKED-nonzero; it never silently passes.
 *   - Scripts DETECT + ledger, never notify. This writes .bugloops/journeys-<stamp>/ evidence +
 *     a JSON report; the guardian/overseer file findings.
 *   - Ports: standalone uses the ad-hoc 8960s range (Charter §8); inside guardian it takes ports
 *     from the guardian's env (see guardian.mjs JOURNEY step).
 *
 * Usage:
 *   npm run qa:journeys
 *   SKYNET_JOURNEY_PORT=8962 SKYNET_JOURNEY_CDP=9362 npm run qa:journeys
 *   npm run qa:journeys -- --keep          # keep the scratch workspace + browser profile
 *   npm run qa:journeys -- --only J1,J2    # run a subset (comma ids)
 *
 * Exit code: 0 all journeys green · 3 a hard assertion failed · 2 BLOCKED (could not run).
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from '../lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from '../lib/seed.mjs';
import { closeOnly, openSel } from '../lib/states.mjs';
import { messageContentText } from '../lib/message-content.mjs';
import { makeLedger, fingerprintOf } from './ledger.mjs';

/* ── Dismissed/known journey gate (mirror of golden.mjs's per-frame review-clean) ──────────────
 * A journey assertion can be TRIAGED-and-DISMISSED in the QA ledger (e.g. J2b/panel-close's busy-
 * poll flake, finding 6feab179 — reproduced PASS in isolation, only flakes under CPU starvation).
 * Once dismissed, the anti-nag law says it must never re-nag. But a bare hard-fail still forced
 * exit 3, pinning the release gate (`ready.mjs` reads journeys-last-run.json == pass) RED forever.
 * So — exactly like golden — we ask the ONE dedup/known authority (ledger.mjs) which fingerprints
 * are suppressed and treat a journey whose EVERY hard-fail maps to a dismissed/known finding as
 * REVIEW-CLEAN (excused, not a hard fail). The fingerprint computed here is IDENTICAL to the one
 * the Green Guardian derives for a journey assertion (crew 'Green Guardian' + checkId 'journeys' +
 * subject 'journey/<journeyName>/<assertionName>'), so a guardian-filed-and-dismissed assertion
 * matches exactly. Narrow by design: a NEW/undismissed hard-fail (different subject → different
 * fingerprint) still fails and still exits 3. Fail-open: no ledger access → suppress nothing. */
const GUARDIAN_CREW = 'Green Guardian';       // must match scripts/qa/guardian.mjs CREW
const JOURNEYS_CHECK_ID = 'journeys';         // must match GUARDIAN_STEPS[journeys].id
function journeyAssertionFingerprint(journeyName, assertionName) {
  return fingerprintOf({ crew: GUARDIAN_CREW, checkId: JOURNEYS_CHECK_ID, subject: 'journey/' + journeyName + '/' + assertionName });
}
function dismissedFingerprints() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');   // scripts/qa/ -> repo root
    const findingsDir = join(root, 'qa', 'findings');
    const knownFile = join(root, 'qa', 'KNOWN_ISSUES.md');
    const io = {
      listFindings() {
        let names; try { names = readdirSync(findingsDir); } catch (_) { return []; }
        const out = [];
        for (const n of names) { if (!n.endsWith('.json')) continue; try { out.push(JSON.parse(readFileSync(join(findingsDir, n), 'utf8'))); } catch (_) {} }
        return out;
      },
      knownFingerprints() {
        try {
          const txt = readFileSync(knownFile, 'utf8'); const set = new Set();
          const re = /fingerprint[:=]\s*`?([0-9a-fA-F]{6,})`?/g; let m;
          while ((m = re.exec(txt))) set.add(m[1].toLowerCase());
          return set;
        } catch (_) { return new Set(); }
      }
    };
    return makeLedger({ io })._internals.suppressedFingerprints();
  } catch (_) { return new Set(); }
}

const PORT = process.env.SKYNET_JOURNEY_PORT || '8962';
const CDP_PORT = Number(process.env.SKYNET_JOURNEY_CDP || 9362);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const OUT_DIR = process.env.SKYNET_JOURNEY_DIR || join(process.cwd(), '.uijourneys');
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';
const KEEP = process.argv.includes('--keep');
const SCRATCH = join(OUT_DIR, '_seed-workspace');
const PROFILE = join(OUT_DIR, '_profile');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 && process.argv[i + 1] ? new Set(process.argv[i + 1].split(',').map(s => s.trim().toUpperCase())) : null;
})();

const J = (v) => JSON.stringify(v);
let JOURNEY_API_TOKEN = '';

async function backendSnapshot() {
  if (!JOURNEY_API_TOKEN) return null;
  try {
    const r = await fetch(APP_URL + 'api/state/snapshot', {
      headers: { 'X-StarNet-Token': JOURNEY_API_TOKEN, Origin: APP_URL.replace(/\/$/, '') },
      cache: 'no-store'
    });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

// A frontend channel going idle is only local projection truth. Before starting the next interrupt journey,
// require the sidecar's authoritative snapshot to omit every prior run AND report no queued work twice in a row.
// Two samples prevent a just-completed /api/halt response from racing its run-loop `finally` teardown.
async function waitBackendPriorRunsDrained(priorRunIds, tries = 80) {
  const wanted = new Set((priorRunIds || []).filter(Boolean));
  let consecutive = 0, last = null;
  for (let i = 0; i < tries; i++) {
    last = await backendSnapshot();
    const runs = last && Array.isArray(last.runs) ? last.runs : null;
    const queues = last && Array.isArray(last.queues) ? last.queues : null;
    const livePrior = runs ? runs.filter(r => wanted.has(r.runId)).map(r => r.runId) : [...wanted];
    const drained = !!runs && !!queues && livePrior.length === 0 && queues.every(q => !(Number(q.depth) > 0));
    if (drained) {
      consecutive++;
      if (consecutive >= 2) return { ok: true, livePrior: [], snapshot: last };
    } else consecutive = 0;
    await sleep(100);
  }
  const livePrior = last && Array.isArray(last.runs) ? last.runs.filter(r => wanted.has(r.runId)).map(r => r.runId) : [...wanted];
  return { ok: false, livePrior, snapshot: last };
}

/* ─────────────────────────── CONTROLLABLE MOCK PROVIDER ───────────────────────────
 * A mock OpenRouter whose completion stream we can HOLD OPEN and RELEASE on command. Unlike the
 * audit's fire-and-finish mock, this lets a run be GENUINELY in-flight (Channels.isBusy true, a
 * live agent.run.start with no agent.run.end) while we drive an interrupt — the only way to test
 * interrupt truth honestly. `mode` picks behavior:
 *   'hold'  — emit an opening token, then WAIT (never finish) until release() is called. This is
 *             what keeps a run RUNNING for the interrupt + long-turn journeys.
 *   'quick' — stream a short reply + stop after ~500ms (a normal completing turn, for J1's DONE).
 * We flip the mode live via the `control` object so one sidecar can do both across a journey.  */
function startControllableMock(model) {
  return new Promise((resolve) => {
    const state = { mode: 'quick', open: [], calls: 0 };
    const release = () => {
      for (const r of state.open.splice(0)) {
        try {
          r.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' released' } }] }) + '\n\n');
          r.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          r.write('data: [DONE]\n\n');
          r.end();
        } catch (_) {}
      }
    };
    const server = createServer((req, res) => {
      if (req.url && req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: model || DEFAULT_MODEL, name: 'Journey Mock', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url && req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          state.calls++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          // Parse the request so we can detect a WORKSHOP shift (J4). A workshop run's prompt starts with the
          // '[WORKSHOP_SHIFT]' marker — for those we emit the file-writing tool calls that BUILD the deliverable
          // (mirrors test/workshop.e2e.test.js's mock), so /workshop-run has real bytes to serve. All OTHER runs
          // (the interactive chat directives J1-J3 fire) use the hold/quick behavior.
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const userMsg = msgs.find(m => m && m.role === 'user');
          const prompt = messageContentText(userMsg && userMsg.content);
          const isWorkshop = prompt.indexOf('[WORKSHOP_SHIFT]') === 0;
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          const text = (t) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          if (isWorkshop) {
            const runId = (prompt.match(/workshop\/([A-Za-z0-9-]+)\//) || [])[1] || 'run';
            const dir = 'workshop/' + runId;
            const toolResults = msgs.filter(m => m && m.role === 'tool').length;
            const html = '<!doctype html><meta charset="utf-8"><title>Journey Demo</title>'
              + '<h1 id="h">Journey Demo Tool</h1><script>document.getElementById("h").dataset.ready="1";</script>';
            if (toolResults === 0) tool('h1', 'fs_write', { path: dir + '/index.html', content: html });
            else if (toolResults === 1) tool('h2', 'fs_write', { path: dir + '/README.md', content: '# Journey Demo\n\nOpen index.html.\n' });
            else if (toolResults === 2) {
              const manifest = { v: 1, runId, agentId: 'agent', backlogId: 'journey-web', title: 'Journey Demo Tool', kind: 'tool', summary: 'A single-file HTML demo built by the journey corps.', files: [{ path: 'index.html', bytes: html.length }, { path: 'README.md', bytes: 30 }], howToUse: 'Open index.html.', notVerified: ['not run in a browser'] };
              tool('h3', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else text('Built a self-contained HTML demo tool.');
            return;
          }
          // Send an opening token IMMEDIATELY (past the provider connect guard — headers are already
          // flushed, so the connectGuard is disarmed here; a healthy stream must never be aborted).
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'working' } }] }) + '\n\n');
          if (state.mode === 'hold') {
            state.open.push(res);               // park the stream; release() finishes it later
            res.on('close', () => { const i = state.open.indexOf(res); if (i >= 0) state.open.splice(i, 1); });
          } else {
            setTimeout(() => {
              try {
                res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' done' } }] }) + '\n\n');
                res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
              } catch (_) {}
            }, 450);
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: 'http://127.0.0.1:' + server.address().port + '/api/v1',
      control: {
        setMode: (m) => { state.mode = m; },
        release,
        callCount: () => state.calls,
        openCount: () => state.open.length,
      }
    }));
  });
}

/* ─────────────────────────── asserter (mirrors audit.mjs) ─────────────────────────── */
function makeAsserter() {
  const results = [];
  const ok = (name, pass, detail, soft) => {
    results.push({ name, pass: !!pass, detail: detail || '', soft: !!soft });
    const tag = pass ? 'PASS' : (soft ? 'soft' : 'FAIL');
    console.log(`    ${tag}  ${name}${detail ? '  — ' + detail : ''}`);
    return !!pass;
  };
  return { ok, results };
}

/* ─────────────────────────── CDP driving helpers ─────────────────────────── */
const clickSel = (cdp, sel) => evalJS(cdp, `(() => { const el = document.querySelector(${J(sel)}); if (!el) return 'NOTFOUND'; el.click(); return 'clicked'; })()`).catch((e) => 'ERR:' + e.message);
async function waitSel(cdp, sel, tries = 30) {
  for (let i = 0; i < tries; i++) { const ok = await evalJS(cdp, `!!document.querySelector(${J(sel)})`).catch(() => false); if (ok) return true; await sleep(200); }
  return false;
}
const sendChat = (cdp, msg) => evalJS(cdp, `(() => { const i = document.getElementById('chat-input'); if (!i) return 'NO_INPUT'; i.focus(); i.value = ${J(msg)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return 'sent'; })()`).catch((e) => 'ERR:' + e.message);
// Create a BOARD directive (kind:'task') the way the taskboard "+ ADD" does, then ASSIGN it (which
// opens its stream + sends its title as the first user turn) — the deliberate task path, not a plain chat.
const addAndAssignTask = (cdp, title) => evalJS(cdp, `(() => {
  if (typeof Workstreams === 'undefined' || typeof Chat === 'undefined') return 'NO_GLOBALS';
  const w = Workstreams.create(${J(title)}, { activate: false, kind: 'task' });
  if (!w) return 'NO_WS';
  if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(w.id); else { Workstreams.switch(w.id); if (Chat.load) Chat.load(Workstreams.get(w.id)); }
  if (Chat.send && !(Chat.isBusy && Chat.isBusy())) Chat.send(${J(title)});
  if (typeof App !== 'undefined' && App.persist) App.persist();
  return w.id;
})()`).catch((e) => 'ERR:' + e.message);

// Reliably OPEN the TASKS board. Dock items TOGGLE, so a bare .click() on an already-open panel closes it;
// openSel does close-then-open so the board is guaranteed shown. Returns true once .kb-cols is present AND the
// render has SETTLED — close-then-open briefly leaves the old panel's cards in the DOM alongside the new ones
// (a one-frame double-render, NOT a real duplicate-row bug — verified: an isolated open renders exactly one
// card), so we wait until the board's distinct card set == the store's task set before returning. This keeps
// parityCheck reading a settled board; a GENUINE duplicate (J3's rapid-fire) still shows because it persists.
async function openBoard(cdp) {
  await evalJS(cdp, openSel('[data-term="tasks"]', 'TASKS')).catch(() => {});
  const ok = await waitSel(cdp, '.kb-cols', 30);
  for (let i = 0; i < 25; i++) {
    const settled = await evalJS(cdp, `(() => {
      const cols = document.querySelectorAll('.kb-cols').length;
      const ids = Array.from(document.querySelectorAll('.kb-card')).map(c => c.dataset.id);
      const uniq = new Set(ids);
      const store = (typeof Workstreams !== 'undefined') ? Workstreams.list().filter(x => x.id !== Workstreams.generalId() && x.kind === 'task').length : -1;
      return cols === 1 && ids.length === uniq.size && uniq.size === store;   // one panel, no dup DOM nodes, matches store
    })()`).catch(() => false);
    if (settled) break;
    await sleep(120);
  }
  await sleep(120);
  return ok;
}

// Wait until a live run is in flight on ANY channel (a run held open by the mock). Returns the busy ws id or null.
async function waitBusy(cdp, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const id = await evalJS(cdp, "(typeof Channels!=='undefined' && Channels.busyIds && Channels.busyIds()[0]) || null").catch(() => null);
    if (id) return id;
    await sleep(150);
  }
  return null;
}
// Wait until NO channel is busy (a run has ended honestly).
async function waitIdle(cdp, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const anyBusy = await evalJS(cdp, "(typeof Channels!=='undefined' && Channels.anyBusy && Channels.anyBusy())").catch(() => true);
    if (!anyBusy) return true;
    await sleep(150);
  }
  return false;
}

/* ═══════════════════════════ J5 — parityCheck(step) ═══════════════════════════
 * THE reusable sim↔truth sweep. At a named step it reads BOTH sides of every claim — the DISPLAYED
 * DOM (what the human sees) and the reduced/authoritative TRUTH (Workstreams store, Channels run-state,
 * the frozen U.bus event log) — and asserts they agree. Every journey calls this at each step, so a
 * divergence is caught the instant it appears mid-journey, not just at the end.
 *
 * Reads (all in-page, one round-trip):
 *   - board: the .kb-card ids/lanes/running-chips the DOM renders, per kanban column count.
 *   - store: Workstreams.list() filtered to kind:'task' (the board's ground truth) + Channels.busyIds.
 *   - counts: crew #crew-sum WORKING/IDLE + topbar spend, vs the event-reduced totals.
 * Returns { checks:[{name,ok,detail}], snap } — the caller records each into its asserter.  */
const PARITY_PROBE = `(() => {
  const out = { checks: [], snap: {} };
  const add = (name, ok, detail) => out.checks.push({ name: String(name), ok: !!ok, detail: String(detail == null ? '' : detail) });
  const WS = (typeof Workstreams !== 'undefined') ? Workstreams : null;
  const CH = (typeof Channels !== 'undefined') ? Channels : null;

  // ---- 1. BOARD ROWS === kind:'task' WORKSTREAM STORE (taskboard truth: no chat/summon on the board) ----
  let storeTaskIds = [], storeChatIds = [];
  if (WS && WS.list && WS.generalId) {
    const gid = WS.generalId();
    const all = WS.list();                                   // drops archived; pinned-first
    storeTaskIds = all.filter(x => x.id !== gid && x.kind === 'task').map(x => x.id).sort();
    storeChatIds = all.filter(x => x.id !== gid && x.kind !== 'task').map(x => x.id).sort();
  }
  // DOM cards only exist while the TASKS panel is open; when it's closed there are zero cards and the
  // board-vs-store check is vacuously true (we assert the store itself is well-formed instead).
  const cardEls = Array.from(document.querySelectorAll('.kb-card'));
  const boardOpen = !!document.querySelector('.kb-cols');
  const boardIds = cardEls.map(c => c.dataset.id).filter(Boolean).sort();
  out.snap.storeTaskIds = storeTaskIds; out.snap.storeChatIds = storeChatIds; out.snap.boardIds = boardIds; out.snap.boardOpen = boardOpen;
  if (boardOpen) {
    const same = boardIds.length === storeTaskIds.length && boardIds.every((id, i) => id === storeTaskIds[i]);
    add('board/rows-match-task-store', same, 'board=[' + boardIds.join(',') + '] taskStore=[' + storeTaskIds.join(',') + ']');
    // NEVER a chat/summon session on the board (regression (a)).
    const leaked = boardIds.filter(id => storeChatIds.indexOf(id) >= 0);
    add('board/no-chat-sessions', leaked.length === 0, leaked.length ? 'chat streams on board: ' + leaked.join(',') : 'no chat/summon session rendered as a card');
  } else {
    add('board/rows-match-task-store', true, 'TASKS panel closed — 0 cards (vacuous); store has ' + storeTaskIds.length + ' task(s)');
    add('board/no-chat-sessions', true, 'TASKS panel closed — no cards to leak into');
  }

  // ---- 2. RUNNING/DONE CHIP === Channels.isBusy TRUTH (the chip can't outlive the run) ----
  const busyIds = CH && CH.busyIds ? CH.busyIds().slice().sort() : [];
  out.snap.busyIds = busyIds;
  if (boardOpen) {
    // every card that shows a RUNNING chip MUST be Channels.isBusy; every DONE chip MUST NOT be busy.
    const runningCards = cardEls.filter(c => c.querySelector('.kb-state.running')).map(c => c.dataset.id);
    const doneCards = cardEls.filter(c => c.querySelector('.kb-state.done')).map(c => c.dataset.id);
    const runningLie = runningCards.filter(id => busyIds.indexOf(id) < 0);
    const doneLie = doneCards.filter(id => busyIds.indexOf(id) >= 0);
    add('chip/running-implies-busy', runningLie.length === 0, runningLie.length ? 'RUNNING chip but not busy: ' + runningLie.join(',') : runningCards.length + ' RUNNING card(s), all Channels.isBusy');
    add('chip/done-implies-idle', doneLie.length === 0, doneLie.length ? 'DONE chip but still busy: ' + doneLie.join(',') : doneCards.length + ' DONE card(s), none busy');
    out.snap.runningCards = runningCards; out.snap.doneCards = doneCards;
  } else {
    add('chip/running-implies-busy', true, 'board closed');
    add('chip/done-implies-idle', true, 'board closed');
  }

  // ---- 3. CREW WORKING/IDLE COUNT === Channels busy-count truth (only checkable with the CREW panel open) ----
  const sum = document.querySelector('#crew-sum');
  if (sum && sum.textContent && /WORKING/.test(sum.textContent)) {
    const m = sum.textContent.match(/(\\d+)\\s*WORKING[\\s\\S]*?(\\d+)\\s*IDLE/);
    const shownWorking = m ? parseInt(m[1], 10) : null;
    // the honest working count = distinct agentIds that have a live run. Channels is keyed by wsId, so
    // map busy wsIds -> their agentId and count distinct (a crew member is WORKING iff IT has a live run).
    let liveAgents = new Set();
    if (WS && WS.get) for (const wid of busyIds) { const w = WS.get(wid); if (w) liveAgents.add(w.agentId || 'agent'); }
    // present crew count: rows in the CREW manifest.
    const presentRows = document.querySelectorAll('#crew .crew-row').length;
    out.snap.crewWorkingShown = shownWorking; out.snap.liveAgentCount = liveAgents.size; out.snap.presentRows = presentRows;
    // WORKING shown must never EXCEED the present crew, and must be >= the count of distinct live-run agents
    // that are on the roster (the panel reads its own agent.run.start/end ledger, so it can legitimately be
    // the authority; we assert it does not contradict the Channels truth by claiming FEWER than are busy).
    const busyOnRoster = [...liveAgents].filter(aid => {
      return Array.from(document.querySelectorAll('#crew .crew-row')).some(r => r.dataset.agentId === aid);
    }).length;
    add('crew/working-not-exceeds-present', shownWorking != null && shownWorking <= presentRows, 'shown=' + shownWorking + ' present=' + presentRows);
    add('crew/working-covers-busy', shownWorking != null && shownWorking >= busyOnRoster, 'shownWorking=' + shownWorking + ' >= busy-on-roster=' + busyOnRoster);
  } else {
    add('crew/working-not-exceeds-present', true, 'CREW panel closed — count not displayed');
    add('crew/working-covers-busy', true, 'CREW panel closed — count not displayed');
  }

  // ---- 4. TOPBAR TRUTH === event-reduced truth (HUD numbers fold the frozen U.bus log) ----
  const T = window.__SKYNET_TEST__;
  if (T && T.hud) {
    const hud = T.hud();
    if (hud && Array.isArray(hud.checks)) for (const c of hud.checks) add('topbar/' + c.metric, c.ok, 'displayed=' + c.displayed + ' ' + c.mode + ' expected=' + c.expected);
  } else {
    add('topbar/hud-readable', false, '__SKYNET_TEST__.hud() unavailable');
  }

  // ---- 5. NO STUCK RUNNING: if nothing is busy, no card may still show a RUNNING chip (forever-RUNNING guard) ----
  if (boardOpen && busyIds.length === 0) {
    const stuck = cardEls.filter(c => c.querySelector('.kb-state.running')).map(c => c.dataset.id);
    add('board/no-forever-running', stuck.length === 0, stuck.length ? 'RUNNING chip with nothing busy: ' + stuck.join(',') : 'no stuck RUNNING chip while idle');
  } else {
    add('board/no-forever-running', true, busyIds.length ? busyIds.length + ' run(s) legitimately in flight' : 'board closed');
  }

  return out;
})()`;

async function parityCheck(cdp, A, step) {
  const res = await evalJS(cdp, PARITY_PROBE).catch((e) => ({ checks: [{ name: 'parity/probe', ok: false, detail: 'threw: ' + e.message }], snap: {} }));
  const checks = (res && Array.isArray(res.checks)) ? res.checks : [{ name: 'parity/probe', ok: false, detail: 'no checks returned' }];
  for (const c of checks) A.ok(`${step}::${c.name}`, c.ok, c.detail);
  return res;
}

// Channels becomes busy before the streamed agent.run.start event is guaranteed to reach the crew panel.
// The panel projects that event ledger immediately and reconciles once per second, so allow two full ticks
// before judging the cross-authority count. This is bounded settling, not an exemption: a persistent mismatch
// still reaches parityCheck below and fails loudly while the mock keeps the run genuinely in flight.
async function waitCrewBusyProjection(cdp, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const res = await evalJS(cdp, PARITY_PROBE).catch(() => null);
    const check = res && Array.isArray(res.checks) && res.checks.find(c => c.name === 'crew/working-covers-busy');
    if (check && check.ok) return true;
    await sleep(150);
  }
  return false;
}

/* ═══════════════════════════ J1 — task lifecycle + taskboard truth ═══════════════════════════ */
async function journeyTaskLifecycle(cdp, A, mock) {
  mock.control.setMode('quick');                                    // this journey wants runs that COMPLETE (→ DONE chip)

  // step 0: open the TASKS board on a clean floor and prove parity at rest.
  await evalJS(cdp, closeOnly).catch(() => {});
  await clickSel(cdp, '[data-term="tasks"]');
  await waitSel(cdp, '.kb-cols', 30);
  await sleep(300);
  await parityCheck(cdp, A, 'J1.0-board-open');
  const taskCountBefore = await evalJS(cdp, "(typeof Workstreams!=='undefined') ? Workstreams.list().filter(x=>x.id!==Workstreams.generalId()&&x.kind==='task').length : -1").catch(() => -1);

  // step 1: also send a PLAIN chat (kind:'chat') so we can prove it NEVER shows on the board (regression (a)).
  await clickSel(cdp, '[data-term="commander"]').catch(() => {});   // ensure a compose surface; harmless if absent
  const plain = await sendChat(cdp, 'just a casual hello, no task');
  A.ok('J1/plain-chat-sent', plain === 'sent' || plain === 'NO_INPUT', plain);
  await waitIdle(cdp, 60);
  await openBoard(cdp);
  await parityCheck(cdp, A, 'J1.1-after-plain-chat');

  // step 2: ADD + ASSIGN a real board directive (kind:'task'). Assign sends the title → a run fires.
  // Keep the run genuinely live while cross-authority UI projections settle; quick mode can finish inside
  // the measurement window and turn a named run-live checkpoint into a transition-race probe.
  mock.control.setMode('hold');
  const tid = await addAndAssignTask(cdp, 'list three prime numbers, one per line');
  A.ok('J1/task-created', typeof tid === 'string' && tid.indexOf('ws_') === 0, 'workstream id=' + tid);
  const busyId = await waitBusy(cdp, 40);
  // reopen the board (Chat.load may have switched the panel) and check parity WHILE the run is live.
  await openBoard(cdp);
  A.ok('J1/run-in-flight', !!busyId, busyId ? 'busy on ' + busyId : 'no run went in-flight (mock/provider?)');
  await waitCrewBusyProjection(cdp);
  await parityCheck(cdp, A, 'J1.2-run-live');
  // Internal lane identity stays `active`; the customer-facing heading is IN PROGRESS / REVIEW.
  // Check both authorities so a wording correction cannot conceal a misplaced or idle card.
  const activeLane = await evalJS(cdp, `(() => {
    const c=document.querySelector('.kb-card[data-id="${tid}"]');
    const col=c&&c.closest('.kb-col'); const h=col&&col.querySelector('h4');
    const task=Workstreams.list().find(s=>s.id===${J(tid)});
    return { lane:task&&task.lane, heading:h&&h.textContent.trim(), running:!!(c&&c.querySelector('.kb-state.running')), busy:!!Channels.isBusy(${J(tid)}) };
  })()`).catch(() => null);
  A.ok('J1/assigned-card-active', !!activeLane && activeLane.lane === 'active' &&
    /^IN PROGRESS \/ REVIEW\b/.test(String(activeLane.heading)) && activeLane.running && activeLane.busy,
    'assigned card state = ' + J(activeLane));

  // step 2b: A LIVE RUN OUTRANKS THE LANE (regression guard, 2026-08-14). ↩ QUEUE (and ✓ SHIP, and a
  // drag) can move a card out of ACTIVE while its run is STILL in flight. stateChip used to gate the
  // whole chip on lane==='active', so the card then read "queued, not started" while Channels could
  // prove the agent was working on it. parityCheck's running-implies-busy can't catch that — it only
  // fails a chip that LIES, never a chip that VANISHES — so assert the busy card keeps RUNNING here.
  const queuedMidRun = await evalJS(cdp, `(() => {
    const c = document.querySelector('.kb-card[data-id="${tid}"]');
    if (!c) return 'NO_CARD';
    const b = c.querySelector('button[data-act=queue]');
    if (!b) return 'NO_QUEUE_BTN';
    b.click();
    const c2 = document.querySelector('.kb-card[data-id="${tid}"]');
    if (!c2) return 'CARD_GONE';
    const col = c2.closest('.kb-col'); const h = col && col.querySelector('h4');
    return JSON.stringify({
      lane: h ? h.textContent.trim().split(/\\s+/)[0] : 'NO_COL',
      running: !!c2.querySelector('.kb-state.running'),
      busy: (typeof Channels !== 'undefined' && Channels.isBusy) ? !!Channels.isBusy('${tid}') : null
    });
  })()`).catch(() => 'ERR');
  const qmr = (() => { try { return JSON.parse(String(queuedMidRun)); } catch (_) { return null; } })();
  A.ok('J1/queue-midrun-keeps-running-chip', !!qmr && qmr.busy === true && qmr.running === true && /^TO\b/.test(String(qmr.lane)),
    qmr ? `re-queued mid-run → lane=${qmr.lane} busy=${qmr.busy} RUNNING chip=${qmr.running}` : 'probe failed: ' + queuedMidRun);
  // put it back in ACTIVE so step 3's settled-outcome (DONE — REVIEW & SHIP) assertion reads its own lane.
  await evalJS(cdp, `(() => { Workstreams.setLane('${tid}','active'); if (typeof App!=='undefined'){ App.persist && App.persist(); App.refreshRail && App.refreshRail(); } return 1; })()`).catch(() => 0);

  // step 3: let the run complete → the chip must flip RUNNING → DONE (never forever-RUNNING).
  for (let i = 0; i < 30 && mock.control.openCount() < 1; i++) await sleep(50);
  mock.control.setMode('quick');
  mock.control.release();
  const wentIdle = await waitIdle(cdp, 60);
  A.ok('J1/run-completed', wentIdle, wentIdle ? 'all channels idle after the quick run' : 'run never reached idle');
  await openBoard(cdp);
  await waitSel(cdp, `.kb-card[data-id="${tid}"]`, 30);              // the board re-renders async after the run ends — wait for the card
  await parityCheck(cdp, A, 'J1.3-run-done');
  const chip = await evalJS(cdp, `(() => { const c=document.querySelector('.kb-card[data-id="${tid}"]'); if(!c) return 'NO_CARD'; const s=c.querySelector('.kb-state'); return s?s.className+':'+s.textContent.trim():'NO_CHIP'; })()`).catch(() => 'ERR');
  A.ok('J1/chip-done-after-complete', /done/i.test(String(chip)) && !/running/i.test(String(chip)), 'chip=' + chip);

  // step 4: task count grew by exactly ONE (the plain chat did NOT create a board card).
  const taskCountAfter = await evalJS(cdp, "(typeof Workstreams!=='undefined') ? Workstreams.list().filter(x=>x.id!==Workstreams.generalId()&&x.kind==='task').length : -1").catch(() => -1);
  A.ok('J1/exactly-one-new-task', taskCountAfter === taskCountBefore + 1, `taskStore ${taskCountBefore} → ${taskCountAfter} (plain chat must NOT add a card)`);
}

/* ═══════════════════════════ J2 — interrupt truth (conversation Stop / panel-close / reload) ═══════════════════════════
 * Each variant starts a run HELD in-flight by the mock (so it's genuinely RUNNING), interrupts it, then asserts
 * the UI settles into an HONEST end state: nothing busy, no forever-RUNNING chip, no orphan board row.  */
async function startHeldRun(cdp, A, mock, title) {
  // start from a KNOWN-idle floor: release any parked stream from the prior interrupt journey, HALT any
  // lingering sidecar-side run (an E-STOPped run can be mid-teardown on 'agent'; a new run on the same agent
  // would queue behind it and never reach busy), then wait for every channel to go idle. This ties the run
  // we're about to hold to being the ONLY one in flight (a leftover busy channel makes the check ambiguous).
  const beforeHalt = await backendSnapshot();
  const priorRunIds = beforeHalt && Array.isArray(beforeHalt.runs) ? beforeHalt.runs.map(r => r.runId).filter(Boolean) : [];
  try { mock.control.setMode('quick'); mock.control.release(); } catch (_) {}
  await evalJS(cdp, "(typeof Harness!=='undefined' && Harness.haltAll) ? Harness.haltAll() : 0").catch(() => {});
  await waitIdle(cdp, 60);
  // RED contract for PL-05: frontend-idle is not sufficient authority. The exact prior runs must also
  // have left the sidecar snapshot before a new held run is allowed to start.
  const drain = await waitBackendPriorRunsDrained(priorRunIds);
  A.ok('J2/teardown/backend-prior-runs-drained', drain.ok, drain.snapshot ? ('prior=' + JSON.stringify(priorRunIds) + ' livePrior=' + JSON.stringify(drain.livePrior)) : 'backend snapshot unavailable');
  await evalJS(cdp, closeOnly).catch(() => {});
  await sleep(400);
  mock.control.setMode('hold');
  const tid = await addAndAssignTask(cdp, title);
  // wait for THIS stream (tid) to be the in-flight one — not merely "something is busy" (a leftover channel
  // from a prior journey would make a bare busyIds()[0] read ambiguous). This ties the whole interrupt journey
  // to the run we actually created.
  let busyId = null;
  for (let i = 0; i < 50; i++) {
    const b = await evalJS(cdp, `(typeof Channels!=='undefined' && Channels.isBusy && ${tid && String(tid).indexOf('ws_') === 0 ? `Channels.isBusy(${J(tid)})` : 'false'})`).catch(() => false);
    if (b) { busyId = tid; break; }
    await sleep(150);
  }
  // Busy can precede the provider request. Wait for a genuinely parked stream so a premature
  // mock release cannot accidentally turn an ineffective Stop into an apparent successful run.
  for (let i = 0; i < 50 && mock.control.openCount() === 0; i++) await sleep(150);
  A.ok('J2/provider-stream-held', mock.control.openCount() > 0, 'parked provider streams=' + mock.control.openCount());
  return { tid, busyId };
}
async function assertHonestAfterInterrupt(cdp, A, mock, label, tid) {
  // Do NOT finish the provider for the app: Stop must cause the real cancellation while the
  // provider stays held. Only release after recording the outcome, for failed-case cleanup.
  const idle = await waitIdle(cdp, 80);
  A.ok(`J2/${label}/settles-idle`, idle, idle ? 'no channel busy after interrupt' : 'a channel stayed busy (truth-after-disconnect NOT honored)');
  const snapshot = await backendSnapshot();
  A.ok(`J2/${label}/backend-idle`, !!snapshot && Array.isArray(snapshot.runs) && snapshot.runs.length === 0,
    snapshot ? 'live backend runs=' + JSON.stringify(snapshot.runs) : 'backend snapshot unavailable');
  for (let i = 0; i < 20 && mock.control.openCount() > 0; i++) await sleep(100);
  A.ok(`J2/${label}/provider-stream-closed`, mock.control.openCount() === 0, 'parked provider streams=' + mock.control.openCount());
  mock.control.release();
  // reopen the board and sweep parity — the key assertions: no forever-RUNNING chip, no orphan row.
  await openBoard(cdp);
  await parityCheck(cdp, A, `J2.${label}`);
  if (tid && tid.indexOf && tid.indexOf('ws_') === 0) {
    const chip = await evalJS(cdp, `(() => { const c=document.querySelector('.kb-card[data-id="${tid}"]'); if(!c) return 'NO_CARD'; const s=c.querySelector('.kb-state.running'); return s?'RUNNING':'not-running'; })()`).catch(() => 'ERR');
    A.ok(`J2/${label}/no-forever-running-chip`, chip !== 'RUNNING', 'interrupted card chip = ' + chip);
  }
}

async function clickConversationStop(cdp, A, tid, label) {
  // The global E-STOP/Alt+H UI was deliberately removed in 418b3d95a. Exercise the
  // current user control, including reopening the precise conversation after panel close.
  const result = await evalJS(cdp, `(async () => {
    App.openWorkstream(${J(tid)});
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const button = document.querySelector('#chat-stop');
    if (Workstreams.active()?.id !== ${J(tid)} || !button || button.disabled || !button.getClientRects().length) return 'STOP_NOT_AVAILABLE';
    button.click(); return 'clicked';
  })()`).catch(e => 'ERR:' + e.message);
  A.ok('J2/' + label + '/current-stop-clicked', result === 'clicked', result);
}

async function journeyInterruptStop(cdp, A, mock) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const { tid, busyId } = await startHeldRun(cdp, A, mock, 'stop this conversation: a very long running task');
  A.ok('J2/stop/run-held-live', !!busyId, busyId ? 'run held in-flight on ' + busyId : 'run never went in-flight');
  await clickConversationStop(cdp, A, tid, 'stop');
  await assertHonestAfterInterrupt(cdp, A, mock, 'stop', tid);
}

async function journeyInterruptPanelClose(cdp, A, mock) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const { tid, busyId } = await startHeldRun(cdp, A, mock, 'close the panel while I run');
  A.ok('J2/panel-close/run-held-live', !!busyId, busyId ? 'run held on ' + busyId : 'run never went in-flight');
  // confirm the held run is BUSY on ITS stream before we close (settle the agent.run.start propagation), so the
  // survives-close check reads a genuinely-in-flight run and not a pre-start window.
  for (let i = 0; i < 20 && tid; i++) { if (await evalJS(cdp, `(typeof Channels!=='undefined' && Channels.isBusy && Channels.isBusy(${J(tid)}))`).catch(() => false)) break; await sleep(100); }
  // close every open panel mid-run (the per-stream channel must SURVIVE this — the whole point of channels.js).
  await evalJS(cdp, closeOnly).catch(() => {});
  // while still mid-run, the channel must STILL be busy (closing a panel is not an interrupt). Poll a short window:
  // the invariant is "the run is NOT killed by the close", so any busy sample in the window after close proves it.
  let stillBusy = false;
  for (let i = 0; i < 15; i++) {
    stillBusy = await evalJS(cdp, `(typeof Channels!=='undefined' && Channels.isBusy && ${tid ? `Channels.isBusy(${J(tid)})` : 'Channels.anyBusy()'})`).catch(() => false);
    if (stillBusy) break;
    await sleep(120);
  }
  A.ok('J2/panel-close/run-survives-close', !!stillBusy, stillBusy ? 'run still in-flight after panel close (channel survived)' : 'closing the panel killed the run (regression!)');
  // Reopen the surviving conversation and use its Stop control; closing a panel alone
  // must never cancel work, and completing the provider fixture is not evidence of Stop.
  await clickConversationStop(cdp, A, tid, 'panel-close');
  await assertHonestAfterInterrupt(cdp, A, mock, 'panel-close', tid);
}

async function journeyInterruptReload(cdp, A, mock) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const { tid, busyId } = await startHeldRun(cdp, A, mock, 'reload the page while I run');
  A.ok('J2/reload/run-held-live', !!busyId, busyId ? 'run held on ' + busyId : 'run never went in-flight');
  // hard reload mid-run. Channels is transient (never persisted), so after reload NOTHING may be busy and the
  // board must not show a forever-RUNNING chip from a run whose stream the reload severed.
  mock.control.release();                                            // free the parked socket the reload abandons
  await cdp.send('Page.navigate', { url: APP_URL }).catch(() => {});
  const ready = await waitDevReady(cdp, evalJS, { tries: 40, url: APP_URL });
  const testReady = ready && await evalJS(cdp, '!!(window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready())').catch(() => false);
  A.ok('J2/reload/floor-back', !!testReady, testReady ? 'floor + testapi ready after reload' : 'never came back in-game after reload');
  if (!testReady) return;
  const anyBusy = await evalJS(cdp, "(typeof Channels!=='undefined' && Channels.anyBusy && Channels.anyBusy())").catch(() => true);
  A.ok('J2/reload/nothing-busy-after-reload', !anyBusy, anyBusy ? 'a channel is busy after a fresh reload (impossible truthfully)' : 'no transient run survived the reload');
  await openBoard(cdp);
  await parityCheck(cdp, A, 'J2.reload-after');
  // the task the run was on persisted (Workstreams IS persisted), but its card must NOT claim RUNNING.
  if (tid && tid.indexOf && tid.indexOf('ws_') === 0) {
    const running = await evalJS(cdp, `!!document.querySelector('.kb-card[data-id="${tid}"] .kb-state.running')`).catch(() => false);
    A.ok('J2/reload/no-running-chip-after-reload', !running, running ? 'card still shows RUNNING after reload' : 'reloaded card shows an honest (non-running) state');
  }
}

/* ═══════════════════════════ J3 — double-send / rapid-toggle ═══════════════════════════
 * Fire two directives fast + toggle panels mid-run. Assert: no duplicate board rows, no stuck RUNNING,
 * zero NEW uncaught console exceptions.  */
async function journeyDoubleSend(cdp, A, mock, diag) {
  mock.control.setMode('quick');
  await evalJS(cdp, closeOnly).catch(() => {});
  const exBefore = diag.exceptions.length;
  const beforeIds = await evalJS(cdp, "(typeof Workstreams!=='undefined') ? Workstreams.all().map(w=>w.id) : []").catch(() => []);

  // fire two board directives back-to-back with no wait between (the rapid double-send).
  const t1 = await addAndAssignTask(cdp, 'rapid task one: alpha');
  const t2 = await addAndAssignTask(cdp, 'rapid task two: beta');
  A.ok('J3/two-distinct-ids', t1 !== t2 && String(t1).indexOf('ws_') === 0 && String(t2).indexOf('ws_') === 0, 't1=' + t1 + ' t2=' + t2);

  // toggle panels rapidly WHILE runs are (maybe) in flight — this is the rapid-toggle stress.
  for (const sel of ['[data-term="tasks"]', '[data-term="agents"]', '[data-term="commander"]', '[data-term="tasks"]']) {
    await clickSel(cdp, sel); await sleep(120);
  }
  await waitSel(cdp, '.kb-cols', 20); await sleep(200);
  await waitCrewBusyProjection(cdp);
  await parityCheck(cdp, A, 'J3.mid-toggle');

  // NO DUPLICATE board rows: each task id appears on the board at most once.
  const boardIds = await evalJS(cdp, "Array.from(document.querySelectorAll('.kb-card')).map(c=>c.dataset.id)").catch(() => []);
  const dupCount = boardIds.length - new Set(boardIds).size;
  A.ok('J3/no-duplicate-board-rows', dupCount === 0, dupCount ? dupCount + ' duplicate card id(s): ' + boardIds.join(',') : boardIds.length + ' unique card(s)');

  // let both runs finish, then assert no stuck RUNNING + still no dupes.
  await waitIdle(cdp, 60);
  await openBoard(cdp);
  await parityCheck(cdp, A, 'J3.settled');
  const stuck = await evalJS(cdp, "Array.from(document.querySelectorAll('.kb-card .kb-state.running')).length").catch(() => -1);
  A.ok('J3/no-stuck-running', stuck === 0, stuck + ' card(s) still RUNNING after both runs settled');

  // exactly two NEW workstreams were created (no phantom extra rows from the rapid fire).
  const afterIds = await evalJS(cdp, "(typeof Workstreams!=='undefined') ? Workstreams.all().map(w=>w.id) : []").catch(() => []);
  const added = afterIds.filter(id => beforeIds.indexOf(id) < 0);
  A.ok('J3/exactly-two-new-streams', added.length === 2, added.length + ' new stream(s) (expected 2): ' + added.join(','));

  const exAfter = diag.exceptions.length;
  A.ok('J3/zero-new-exceptions', exAfter === exBefore, exAfter === exBefore ? 'no new uncaught exceptions during rapid send/toggle' : (exAfter - exBefore) + ' new: ' + diag.exceptions.slice(exBefore).join(' | ').slice(0, 240));
}

/* ═══════════════════════════ J4 — summon → assign → deliverable → OPEN ═══════════════════════════
 * A deliverable's Open action is only truthful if the /workshop-run jail actually SERVES a runnable page.
 * The frontend Open action navigates a new tab to /workshop-run/<agent>/<run>/index.html?token= — an
 * interactive nav a headless CDP page can't meaningfully follow. So we assert the SERVE CONTRACT directly
 * over HTTP (the exact bytes+headers the Open action depends on): a real workshop deliverable, built through
 * the granted fs-jail, is served 200 as runnable text/html under an opaque-origin sandbox CSP. This is the
 * same contract test/workshop.e2e.test.js locks, driven here as the terminal step of the summon→deliver
 * journey so a regression in the Open path is caught by the journey corps too.  */
async function journeyDeliverableOpen(cdp, A, base, token, mock) {
  const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: base };
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const agentId = 'agent';                                          // the seeded hero agent id
  // settle first: release any parked stream from a prior journey, HALT any sidecar-side run still executing
  // (an interrupt journey can leave a run mid-flight on 'agent'; the workshop shift shares that agent and its
  // multi-turn tool loop is starved if the agent is busy), then wait for the floor to go fully idle.
  if (mock && mock.control) { try { mock.control.setMode('quick'); mock.control.release(); } catch (_) {} }
  try { await post('/api/halt', {}); } catch (_) {}
  if (cdp) await waitIdle(cdp, 60);
  await sleep(800);

  // grant the workshop (W1) so the autonomous fs.write that builds the deliverable is allowed.
  const g = await post('/api/workshop/grant', { agentId, on: true }).then(r => r.json()).catch(e => ({ error: String(e) }));
  A.ok('J4/workshop-granted', g && (g.ok === true || g.granted === true || g.on === true), 'grant → ' + JSON.stringify(g).slice(0, 120));

  // queue a WEB TOOL build (the mock's "web tool" branch writes a self-contained index.html + manifest).
  const q = await post('/api/workshop/queue', { agentId, id: 'journey-web', title: 'a web tool: journey demo' }).then(r => r.json()).catch(e => ({ error: String(e) }));
  A.ok('J4/build-queued', q && q.ok === true, 'queue → ' + JSON.stringify(q).slice(0, 120));

  // force-fire ONE shift NOW — attended test of the unattended build path (streams NDJSON).
  const shiftRes = await post('/api/workshop/shift', { agentId }).catch(e => ({ status: 0, _err: String(e) }));
  A.ok('J4/shift-streams', shiftRes && shiftRes.status === 200, 'shift status=' + (shiftRes && shiftRes.status));
  let result = {};
  if (shiftRes && shiftRes.status === 200) {
    const text = await shiftRes.text();
    const lines = text.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    result = (lines.find(e => e.name === 'workshop.shift.result') || {}).payload || {};
  }
  A.ok('J4/deliverable-built', result.fired === true && result.reason === 'built' && !!result.runId, 'fired=' + result.fired + ' reason=' + result.reason + ' runId=' + result.runId);
  const runId = result.runId;
  const hasHtml = result.manifest && Array.isArray(result.manifest.files) && result.manifest.files.some(f => /index\.html$/.test(f.path));
  A.ok('J4/manifest-lists-index-html', !!hasHtml, 'manifest files: ' + JSON.stringify((result.manifest && result.manifest.files) || []).slice(0, 160));
  if (!runId || !hasHtml) return;

  // THE OPEN CONTRACT: the served page is 200 runnable text/html, script intact, opaque-origin sandbox CSP.
  const runUrl = base + '/workshop-run/' + agentId + '/' + runId + '/index.html?token=' + encodeURIComponent(token);
  const pageRes = await fetch(runUrl).catch(e => ({ status: 0, _err: String(e) }));
  A.ok('J4/workshop-run-200', pageRes && pageRes.status === 200, 'GET /workshop-run/.../index.html → ' + (pageRes && pageRes.status) + (pageRes && pageRes._err ? ' ' + pageRes._err : ''));
  if (pageRes && pageRes.status === 200) {
    const ct = pageRes.headers.get('content-type') || '';
    const csp = pageRes.headers.get('content-security-policy') || '';
    const bodyTxt = await pageRes.text();
    A.ok('J4/served-as-runnable-html', /text\/html/.test(ct), 'content-type=' + ct + ' (RUNNABLE, not octet-stream)');
    A.ok('J4/inline-script-intact', /<script>/.test(bodyTxt), 'served html still carries its inline <script> (it runs in a tab)');
    A.ok('J4/opaque-origin-sandbox', /\bsandbox\b/.test(csp) && /allow-scripts/.test(csp) && !/allow-same-origin/.test(csp), 'CSP=' + csp);
  }
  // and the token fence still holds (a no-token nav is refused) — the Open action always carries the token.
  const noTok = await fetch(base + '/workshop-run/' + agentId + '/' + runId + '/index.html').catch(() => ({ status: 0 }));
  A.ok('J4/token-required', noTok && noTok.status === 403, 'no-token GET → ' + (noTok && noTok.status) + ' (must be 403)');

  // Open the real WORK-dock surface and prove the just-built backend row reaches its physical controls.
  await evalJS(cdp, `(() => { StationUI.openTerm('deliverables'); return true; })()`).catch(() => false);
  /* 2026-08-13 (deliverables-area): the library is now a glance + a details drawer, so the controls this
     journey exists to prove live one click down instead of on the row. Same INTENT, current DOM:
       .deliverable-row -> .dlv-card, title -> .dlv-title, and OPEN is an <a data-file> (a real href, since
       the OPEN fix that removed window.open), with KEEP/DISCARD inside .dlv-more.
     So we EXPAND the matching card first. That makes this a stronger check than before — it now proves the
     accordion reaches the controls, not just that they were rendered somewhere on the page. */
  let library = null;
  for (let i = 0; i < 30; i++) {
    library = await evalJS(cdp, `(() => {
      const q=document.querySelector('#dl-query'), s=document.querySelector('#dl-status');
      const cards=[...document.querySelectorAll('.dlv-card')];
      const card=cards.find(c=>/Journey Demo Tool/.test(c.textContent))||cards[0]||null;
      const head=card&&card.querySelector('.dlv-head');
      if (head && card.querySelector('.dlv-more') && card.querySelector('.dlv-more').hidden) head.click();
      const more=card&&card.querySelector('.dlv-more');
      return { q:!!q, status:!!s, refresh:!!document.querySelector('#dl-refresh'), clean:!!document.querySelector('#dl-clean'),
        title:card?(card.querySelector('.dlv-title')||{}).textContent||card.textContent:'',
        open:!!(more&&more.querySelector('a[data-file]')),
        keep:!!(more&&more.querySelector('button[data-act="keep"]')), discard:!!(more&&more.querySelector('button[data-act="discard"]')) };
    })()`).catch(() => null);
    if (library && library.title && library.title.indexOf('Journey Demo Tool') >= 0) break;
    await sleep(200);
  }
  A.ok('J4/library-controls-visible', library && library.q && library.status && library.refresh && library.clean, 'search/filter/refresh/cleanup controls=' + JSON.stringify(library));
  A.ok('J4/library-real-pending-row', library && /Journey Demo Tool/.test(library.title || '') && library.open && library.keep && library.discard, 'pending card/actions=' + JSON.stringify(library));
  const filtered = await evalJS(cdp, `(() => { const q=document.querySelector('#dl-query'); q.value='no-such-deliverable'; q.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`).catch(() => false);
  await sleep(400);
  const emptyText = await evalJS(cdp, `document.querySelector('#dl-list')?.textContent || ''`).catch(() => '');
  // The empty state now distinguishes a FILTERED miss from a genuinely empty library — "NO MATCHES" vs
  // "NOTHING HERE YET" — because the second headline over a library with rows behind a filter is simply false.
  // Assert the filtered headline specifically, so this keeps failing if the two ever collapse back into one.
  A.ok('J4/library-search-filters', filtered && /NO MATCHES/.test(emptyText), 'search result=' + String(emptyText).trim().slice(0, 100));
}

/* ═══════════════════════════ J6 — bay-bound crew idle life (desk-stuck escape) ═══════════════════════════
 * Andrew's 2026-07-07 escape: a PLAN-DERIVED (bay-bound) crew body walked to its workstation on a task and
 * then STOOD THERE ETERNALLY — it never returned to idle life after the run ended — and idle bay bodies sat
 * frozen behind their bays. Root cause: stepCrew gated the per-body sentience engine on `b.summoned`, so
 * bay-bound bodies (which are never summoned) got NO idle life. This journey injects a real bay-bound body
 * (belt + bay bound to a probe agent, exactly as syncCrewFromPlan builds one), then asserts the TRUTH the
 * fix restores: an idle bay body has inner life (moves / picks idle goals, caged to its zone), and after a
 * task ENDS it returns to that idle life within a few seconds instead of freezing at its post.
 * We drive the crew work-state via World.setActivityFor — the exact seam agent.run.start/end use for crew. */
async function journeyBayIdleLife(cdp, A) {
  const PROBE = 'deskstuck_probe';
  await evalJS(cdp, closeOnly).catch(() => {});
  const bodyOf = `(() => { try { const b=(window.__SKYNET_TEST__.bodies()||[]).find(x=>x.id===${J(PROBE)}); return b||null; } catch(e){ return null; } })()`;

  // 1) inject a belt + a bay bound to the probe agent → rederive → syncCrewFromPlan spawns a NON-summoned body.
  const inj = await evalJS(cdp, `(() => { try {
    if (typeof Build==='undefined' || !Build.__test__ || !Build.__test__.station) return 'NO_BUILD_TEST';
    const st = Build.__test__.station();
    const okBelt = st.setBelt(6,5,'E'); const okBay = st.addProp({ t:'bay', x:7, y:5, w:1, h:1, agentId:${J(PROBE)} });
    return JSON.stringify({ belt: !!(okBelt&&okBelt.ok), bay: !!(okBay&&okBay.ok!==false) });
  } catch(e){ return 'ERR:'+e.message; } })()`).catch(e => 'ERR:' + e.message);
  A.ok('J6/bay-injected', typeof inj === 'string' && inj.indexOf('ERR') < 0 && inj.indexOf('NO_BUILD') < 0, 'inject → ' + inj);

  // 2) the plan body appears (proves it's a real bay-bound, non-summoned body — the exact class that froze).
  let born = false;
  for (let i = 0; i < 30; i++) { const b = await evalJS(cdp, bodyOf).catch(() => null); if (b && b.id === PROBE) { born = true; break; } await sleep(400); }
  A.ok('J6/bay-body-born', born, born ? 'plan-derived crew body present' : 'bay body never appeared (bay missing from routingPlan.bays)');
  if (!born) return;

  // ALIVE signal: the idle engine legitimately picks "stand still" most of the time, so movement alone is a
  // noisy signal. A body whose engine RUNS also glances / re-faces / occasionally strolls; a FROZEN body
  // (the bug) never does ANY of these — goal stays null, tile fixed, glance null, facing pinned. So "alive" =
  // it moved OR took a non-null goal OR glanced OR changed facing, across a generous window (this is a TRUTH
  // gate — does it EVER come alive — not a latency gate). Cumulative, breaks as soon as it proves life.
  const aliveWithin = async (base, tries) => {
    for (let i = 0; i < tries; i++) {
      await sleep(400);
      const b = await evalJS(cdp, bodyOf).catch(() => null);
      if (!b) continue;
      const moved = base.tile && (b.tile.x !== base.tile.x || b.tile.y !== base.tile.y);
      if (moved || b.goal != null || b.glance != null || (base.dir && b.dir !== base.dir)) return b;
    }
    return null;
  };
  // 3) IDLE-FROM-START must have inner life (not frozen at its bay = the "hidden behind bays" symptom).
  const start = await evalJS(cdp, bodyOf).catch(() => null);
  const aliveA = await aliveWithin({ tile: start && start.tile, dir: start && start.dir }, 60);   // up to ~24s
  A.ok('J6/idle-bay-body-has-life', !!aliveA, aliveA ? ('idle bay body came alive (goal=' + aliveA.goal + ' tile=' + aliveA.tile.x + ',' + aliveA.tile.y + ' — not frozen at its bay)') : 'idle bay body FROZEN at its bay — no inner life');

  // 4) TASK → END: drive the crew work seize the way a run does, then assert it returns to idle life.
  await evalJS(cdp, `World.setActivityFor(${J(PROBE)},'task')`).catch(() => {});
  let worked = false;
  for (let i = 0; i < 12; i++) { const b = await evalJS(cdp, bodyOf).catch(() => null); if (b && (b.working || b.sitting)) { worked = true; break; } await sleep(300); }
  A.ok('J6/task-seizes-body', worked, worked ? 'body went to work on the task' : 'body never entered the work pose');
  await evalJS(cdp, `World.setActivityFor(${J(PROBE)},'idle')`).catch(() => {});
  // THE ESCAPE ASSERTION: after the run ends the body must return to idle LIFE (the engine runs again) —
  // it comes alive rather than freezing standing at the workstation forever. Baseline = its state the instant
  // the run ended (facing 'south', at its post); alive = it moves / picks a goal / glances / re-faces.
  const ended = await evalJS(cdp, bodyOf).catch(() => null);
  const aliveB = await aliveWithin({ tile: ended && ended.tile, dir: ended && ended.dir }, 75);   // up to ~30s
  const returned = !!(aliveB && !aliveB.working && !aliveB.sitting);
  A.ok('J6/returns-to-idle-after-task', returned, returned ? ('body resumed idle life after run end (goal=' + aliveB.goal + ' tile=' + aliveB.tile.x + ',' + aliveB.tile.y + ')') : 'body STUCK at its workstation after the run ended (desk-stuck escape)');

  // 5) it stays caged to its own zone (the fix must not let a bay body roam the whole floor).
  const caged = await evalJS(cdp, bodyOf).catch(() => null);
  A.ok('J6/stays-in-own-zone', !caged || caged.inOwnZone !== false, caged ? ('inOwnZone=' + caged.inOwnZone + ' tile=' + caged.tile.x + ',' + caged.tile.y) : 'no body');

  // cleanup: remove the injected bay + belt so a shared-app follow-on sees the original floor.
  await evalJS(cdp, `(() => { try { const st=Build.__test__.station(); const p=(st.propsByAgent?st.propsByAgent(${J(PROBE)}):[]).find(pp=>pp.t==='bay'); if (p) st.removeProp(p.id); if (st.setBelt) st.setBelt(6,5,''); return 'cleaned'; } catch(e){ return 'ERR:'+e.message; } })()`).catch(() => {});
}

/* ═══════════════════════════ J7 — slash INPUT-path truth (the 2026-07-05 ARGS-bug seam) ═══════════════════════════
 * Andrew's 2026-07-05 escape: an arg-taking slash command typed into the REAL composer ("/model <id>") was
 * silently SENT TO THE AGENT AS CHAT instead of dispatched as a command — because the command palette
 * prefix-matched on the WHOLE line, so the space in "/model id" stopped matching any command name, the palette
 * CLOSED, and Enter fell through to send(). It was fixed (openSlash matches the first token; commandFromLine is
 * the belt-and-suspenders fallback), but the ONLY coverage was SOURCE-GREP tests (test/slash.palette.test.js +
 * test/slash.config.test.js do fs.readFileSync + indexOf on chat.js) — they assert strings EXIST, they never
 * EXECUTE the keydown→openSlash→matchCommands→runSlash→applySlashDirective path. Finding 070e8aca (Perfectionist,
 * P1). This journey drives the ACTUAL composer DOM (set #chat-input value + fire the real 'input' event + a real
 * Enter keydown → the real input.onkeydown handler decides) and asserts the RUNTIME behavior a grep can't:
 *   (a) an arg-taking "/model <id>" DISPATCHES as a command — a LOCAL line appears with the arg
 *       intact, the agent config actually took the model value, and the "/model …" line is NOT echoed as a
 *       .cmsg.user chat row (the exact bug symptom);
 *   (b) a BARE "/whoami" (no args) dispatches as a command (local line, no slash user row);
 *   (c) the CONVERSE — plain prose with no leading "/" is SENT to the agent as a .cmsg.user chat row (the fix
 *       must not over-capture ordinary chat into the command path).
 * LOCAL LINE = .cmsg.system OR .cmsg.agent: the 2026-07-09 UI finale sprint moved command/client output from
 * agent-attributed rows to a SYSTEM register (chat.js localLine → row('system'), lane C — by design). The probe
 * reads BOTH registers so it asserts the dispatch truth, not one UI generation's styling. (First caught as a
 * false P1 pair 3a0dce44/96dc8e88 when it read only .agent — the product was right, the instrument was stale.)
 * Mock boundary is fine: the seam under test is input→dispatch, not model output. */
async function journeySlashTruth(cdp, A, mock) {
  try { mock.control.setMode('quick'); mock.control.release(); } catch (_) {}
  await evalJS(cdp, closeOnly).catch(() => {});
  await clickSel(cdp, '[data-term="commander"]').catch(() => {});    // open COMMS so #chat-input exists
  const haveInput = await waitSel(cdp, '#chat-input', 30);
  A.ok('J7/composer-present', haveInput, haveInput ? '#chat-input mounted' : 'no composer to drive (BLOCKED seam)');
  if (!haveInput) return;

  // Drive the REAL input seam: value + the real 'input' event (opens/filters the palette on '/') + a real Enter
  // keydown through input.onkeydown — never call runSlash/send directly (that would bypass the seam under test).
  const driveLine = (text) => evalJS(cdp, `(() => {
    const i = document.getElementById('chat-input'); if (!i) return 'NO_INPUT';
    i.focus(); i.value = ${J(text)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'typed';
  })()`).catch((e) => 'ERR:' + e.message);
  // Snapshot the transcript: user/agent .cmsg rows + their body text + any user row that STARTS WITH '/'
  // (the bug's fingerprint) + the input's current value + the live agent-config model.
  const readRows = () => evalJS(cdp, `(() => {
    const rows = Array.from(document.querySelectorAll('#chat-log .cmsg'));
    const textOf = r => { const b = r.querySelector('.body'); return b ? String(b.textContent || '') : ''; };
    const userTexts  = rows.filter(r => r.classList.contains('user')).map(textOf);
    const agentTexts = rows.filter(r => r.classList.contains('agent')).map(textOf);
    // command/client output lives in the SYSTEM register since the 2026-07-09 UI finale (localLine → row('system'));
    // localTexts = both registers, so the journey survives styling generations while still proving dispatch.
    const sysTexts   = rows.filter(r => r.classList.contains('system')).map(textOf);
    const localTexts = agentTexts.concat(sysTexts);
    let model = '';
    try { model = (typeof App !== 'undefined' && App.currentAgent && App.currentAgent()) ? (App.currentAgent().model || '') : ''; } catch (_) {}
    return {
      userTexts, agentTexts, localTexts,
      slashUserRows: userTexts.filter(t => t.trim()[0] === '/'),
      inputVal: (document.getElementById('chat-input') || {}).value || '',
      model
    };
  })()`).catch(() => ({ userTexts: [], agentTexts: [], localTexts: [], slashUserRows: [], inputVal: '', model: '' }));
  // poll until predicate(rows) OR timeout — dispatch is async when the command is server-backed (awaits /api/slash/dispatch).
  const until = async (pred, tries = 25) => { let last = await readRows(); for (let i = 0; i < tries; i++) { if (pred(last)) return last; await sleep(160); last = await readRows(); } return last; };

  const stamp = Date.now();

  /* ── (a) ARG-TAKING "/model <id>" — the exact seam that broke. Unique id proves the ARG survived the seam. ── */
  const MODEL_ARG = 'journey/slash-truth-' + stamp;
  const before = await readRows();
  const d1 = await driveLine('/model ' + MODEL_ARG);
  A.ok('J7/model-line-typed', d1 === 'typed', 'drove "/model ' + MODEL_ARG + '" through #chat-input: ' + d1);
  const afterModel = await until(r => r.localTexts.some(t => t.indexOf(MODEL_ARG) >= 0) || r.model === MODEL_ARG);
  // DISPATCHED AS COMMAND: a local line (SYSTEM register, or legacy agent row) carries the arg intact (modelCommand(args) ran).
  const cmdEchoed = afterModel.localTexts.some(t => /model set to/i.test(t) && t.indexOf(MODEL_ARG) >= 0);
  A.ok('J7/arg-command-dispatched', cmdEchoed, cmdEchoed ? 'local line: "Model set to ' + MODEL_ARG + '"' : 'no dispatch confirmation carrying the arg — localTexts=' + JSON.stringify(afterModel.localTexts.slice(-3)));
  // THE ARGUMENT SURVIVED input→dispatch — the precise value the 2026-07-05 bug dropped when it sent the line as chat.
  A.ok('J7/arg-reached-config', afterModel.model === MODEL_ARG, 'App.currentAgent().model=' + JSON.stringify(afterModel.model) + ' (expected the typed arg)');
  // NOT SENT AS CHAT: the "/model …" line must NOT appear as a user chat row (the bug's exact symptom).
  const leakedModel = afterModel.userTexts.filter(t => t.indexOf('/model') >= 0);
  A.ok('J7/arg-line-not-chat', leakedModel.length === 0, leakedModel.length ? 'REGRESSION: "/model …" echoed as a user chat row: ' + JSON.stringify(leakedModel) : 'no "/model …" user chat row (dispatched, not sent)');
  // and the composer was consumed (runSlash/handler clears it) — never left the slash line sitting in the box.
  A.ok('J7/composer-cleared', afterModel.inputVal === '', 'input.value after dispatch = ' + JSON.stringify(afterModel.inputVal));

  /* ── (b) BARE "/whoami" (no args) — dispatches as a command too. ── */
  const whoBefore = await readRows();
  const preWho = new Set(whoBefore.localTexts);
  const d2 = await driveLine('/whoami');
  A.ok('J7/whoami-line-typed', d2 === 'typed', 'drove "/whoami": ' + d2);
  const afterWho = await until(r => r.localTexts.some(t => !preWho.has(t) && /^you are /i.test(t.trim())));
  const whoLine = afterWho.localTexts.some(t => !preWho.has(t) && /^you are /i.test(t.trim()));
  A.ok('J7/bare-command-dispatched', whoLine, whoLine ? 'new local line from /whoami ("You are …")' : 'no /whoami identity line appeared — new localTexts=' + JSON.stringify(afterWho.localTexts.filter(t => !preWho.has(t)).slice(-2)));
  A.ok('J7/no-slash-user-rows', afterWho.slashUserRows.length === 0, afterWho.slashUserRows.length ? 'a slash line leaked as a user chat row: ' + JSON.stringify(afterWho.slashUserRows) : 'no user chat row starts with "/" — every slash line dispatched');

  /* ── (c) CONVERSE — plain prose (no leading "/") is SENT to the agent as a user chat row. ── */
  const PLAIN = 'journey plain chat ' + stamp + ' no slash here';
  const d3 = await driveLine(PLAIN);
  A.ok('J7/plain-line-typed', d3 === 'typed', 'drove plain prose: ' + d3);
  const afterPlain = await until(r => r.userTexts.some(t => t === PLAIN));
  const sentAsChat = afterPlain.userTexts.some(t => t === PLAIN);
  A.ok('J7/plain-text-goes-to-chat', sentAsChat, sentAsChat ? 'plain prose became a .cmsg.user chat row (send path, not command)' : 'plain prose did NOT reach chat — userTexts=' + JSON.stringify(afterPlain.userTexts.slice(-3)));
  // it still must not have been misread as a command (no NEW slash user row from any of the three drives).
  A.ok('J7/plain-not-a-command', afterPlain.slashUserRows.length === 0, 'slashUserRows=' + JSON.stringify(afterPlain.slashUserRows));

  // settle: let the plain-chat run complete so the floor is idle for the orchestrator's between-journey reset.
  try { mock.control.setMode('quick'); mock.control.release(); } catch (_) {}
  await waitIdle(cdp, 40);
}

/* ═══════════════════════════ orchestration ═══════════════════════════ */
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = { url: APP_URL, ranAt: new Date().toISOString(), journeys: [] };
  let exitCode = 0;
  let mock = null, sidecar = null, proc = null, cdp = null;

  // --only accepts exact ids (J1, J2a…) OR a group (J2 → all J2* variants); matched case-insensitively.
  const wantJ = (id) => {
    if (!ONLY) return true;
    const up = String(id).toUpperCase();
    if (ONLY.has(up)) return true;
    for (const sel of ONLY) if (up.startsWith(sel)) return true;   // group prefix: 'J2' selects J2a/J2b/J2c
    return false;
  };
  const finish = (code) => {
    try { writeFileSync(join(OUT_DIR, 'journeys-report.json'), JSON.stringify(report, null, 2)); } catch (_) {}
    try { cdp?.ws.close(); } catch (_) {}
    try { proc && proc.kill('SIGKILL'); } catch (_) {}
    try { sidecar && sidecar.kill('SIGKILL'); } catch (_) {}
    try { mock && mock.server && mock.server.close(); } catch (_) {}
    if (!KEEP) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {} try { rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {} }
    const all = report.journeys.flatMap(j => j.assertions);
    const passed = all.filter(a => a.pass).length;
    const softFails = all.filter(a => !a.pass && a.soft).length;
    const verdict = code === 0 ? 'JOURNEYS PASS' : code === 2 ? 'JOURNEYS BLOCKED' : 'JOURNEYS FAIL (exit ' + code + ')';

    // ADDITIVE (EL-7): a stable machine-readable last-run stamp the READY gate (scripts/qa/ready.mjs)
    // reads. Repo-rooted from this file (not cwd) so it always lands in the source repo's qa/ dir.
    // result: 'pass' (exit 0) | 'blocked' (exit 2) | 'fail'. Best-effort — never changes the exit code.
    try {
      const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const QA_DIR = join(REPO, 'qa');
      const headRun = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
      const trunkHead = headRun.status === 0 && /^[0-9a-f]{40}$/i.test(String(headRun.stdout || '').trim())
        ? String(headRun.stdout).trim().toLowerCase() : '';
      mkdirSync(QA_DIR, { recursive: true });
      writeFileSync(join(QA_DIR, 'journeys-last-run.json'), JSON.stringify({
        stampIso: new Date().toISOString(),
        trunkHead,
        fullSuite: ONLY === null,
        result: code === 0 ? 'pass' : code === 2 ? 'blocked' : 'fail',
        exitCode: code, passed, total: all.length, softFails,
      }, null, 2) + '\n', 'utf8');
    } catch (_) {}
    console.log(`\n${verdict} — ${passed}/${all.length} assertions passed${softFails ? ` (${softFails} soft)` : ''} → ${OUT_DIR}`);
    process.exit(code);
  };

  // BLOCKED guard (no-fake-green): a port collision or a sidecar that won't come up must exit 2, never pass.
  try {
    if (await isUp(APP_URL)) { console.error(`BLOCKED: journey port :${PORT} already has a server; set SKYNET_JOURNEY_PORT to a free port`); return finish(2); }
    mock = await startControllableMock(DEFAULT_MODEL);
    process.env.SKYNET_OPENROUTER_BASE = mock.base;
    process.env.STARNET_OPENROUTER_BASE = mock.base;
    console.log(`provider: controllable journey mock on ${mock.base}`);
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${PORT} (model=${DEFAULT_MODEL}) ...`);
    materializeSeedWorkspace(SCRATCH);
    sidecar = bootSeededSidecar({ port: PORT, scratchDir: SCRATCH });
    if (!(await waitUp(APP_URL))) { console.error('BLOCKED: seeded sidecar failed to come up on :' + PORT); return finish(2); }
    console.log('sidecar: ready');
  } catch (e) {
    console.error('BLOCKED: setup threw — ' + (e && e.stack || e));
    return finish(2);
  }

  // read the per-launch API token from the served page (J4 drives the workshop routes over HTTP).
  let token = '';
  try {
    const html = await (await fetch(APP_URL)).text();
    const m = html.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
    if (m) token = String(JSON.parse(m[1]) || '');
    JOURNEY_API_TOKEN = token;
  } catch (_) {}

  const { proc: chromeProc, chrome } = launchChrome({ cdpPort: CDP_PORT, win: WIN, profileDir: PROFILE });
  proc = chromeProc;
  proc.on('error', (e) => { console.error('chrome spawn error', e); });
  console.log(`chrome: ${chrome}\ntarget: ${APP_URL}`);

  let diag;
  try {
    cdp = await connectCDP(CDP_PORT);
    diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    const floorReady = await waitDevReady(cdp, evalJS, { tries: 30, url: APP_URL });
    const testReady = floorReady && await (async () => { for (let i = 0; i < 24; i++) { if (await evalJS(cdp, '!!(window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready())').catch(() => false)) return true; await sleep(1000); } return false; })();
    if (!testReady) {
      console.error('BLOCKED: never reached in-game (floor + __SKYNET_TEST__).');
      try { await capture(cdp, OUT_DIR, '_BLOCKED-not-in-game'); } catch (_) {}
      report.journeys.push({ name: 'boot', passed: false, blocked: true, assertions: [{ name: 'boot/in-game', pass: false, soft: false, detail: 'floor never came up' }] });
      return finish(2);
    }
    console.log('floor + __SKYNET_TEST__ ready\n');

    // The journeys, in priority order. Each is isolated in a try; a throw is a hard fail (exit 3), not a crash.
    const JOURNEYS = [
      { id: 'J1', name: 'task-lifecycle + taskboard truth', needs: 'cdp', fn: (A) => journeyTaskLifecycle(cdp, A, mock) },
      { id: 'J2a', name: 'interrupt: conversation Stop mid-run', needs: 'cdp', fn: (A) => journeyInterruptStop(cdp, A, mock) },
      { id: 'J2b', name: 'interrupt: panel-close mid-run', needs: 'cdp', fn: (A) => journeyInterruptPanelClose(cdp, A, mock) },
      { id: 'J2c', name: 'interrupt: reload mid-run', needs: 'cdp', fn: (A) => journeyInterruptReload(cdp, A, mock) },
      { id: 'J3', name: 'double-send / rapid-toggle', needs: 'cdp', fn: (A) => journeyDoubleSend(cdp, A, mock, diag) },
      { id: 'J4', name: 'summon→assign→deliverable→OPEN', needs: 'http', fn: (A) => journeyDeliverableOpen(cdp, A, APP_URL.replace(/\/$/, ''), token, mock) },
      { id: 'J6', name: 'bay-bound crew idle life (desk-stuck)', needs: 'cdp', fn: (A) => journeyBayIdleLife(cdp, A) },
      { id: 'J7', name: 'slash INPUT-path truth (2026-07-05 ARGS-bug seam)', needs: 'cdp', fn: (A) => journeySlashTruth(cdp, A, mock) },
    ];

    const suppressed = dismissedFingerprints();   // dismissed/known journey fingerprints (read once)
    for (const jr of JOURNEYS) {
      if (!wantJ(jr.id)) continue;
      const journeyReportName = jr.id + ' ' + jr.name;   // matches the guardian's per-journey fingerprint subject
      if (jr.needs === 'http' && !token) {
        const A = makeAsserter();
        A.ok(jr.id + '/token', false, 'BLOCKED: no API token scraped from the page — cannot drive workshop routes');
        report.journeys.push({ name: journeyReportName, passed: false, blocked: true, assertions: A.results });
        exitCode = exitCode || 2;
        continue;
      }
      console.log(`journey ${jr.id}: ${jr.name}`);
      const A = makeAsserter();
      try { await jr.fn(A); }
      catch (e) { A.ok(`${jr.id}/ran`, false, 'threw: ' + (e && e.message || e)); }
      const hardResults = A.results.filter(r => !r.pass && !r.soft);
      // REVIEW-CLEAN: a journey whose EVERY hard-fail maps to a dismissed/known finding is excused
      // (anti-nag) — not a hard fail, does not force exit 3. A new/undismissed hard-fail still fails.
      const excused = hardResults.length > 0 && hardResults.every(r => suppressed.has(journeyAssertionFingerprint(journeyReportName, r.name)));
      if (excused) console.log(`  review-clean ${jr.id} — ${hardResults.length} hard-fail(s) all match a dismissed/known finding; excused (not counted as a hard fail)`);
      const hardFail = hardResults.length > 0 && !excused;
      try { await capture(cdp, OUT_DIR, hardFail ? `_FAIL-${jr.id}` : jr.id); } catch (_) {}
      report.journeys.push({ name: journeyReportName, passed: !hardFail, excused: excused || undefined, assertions: A.results });
      if (hardFail) exitCode = 3;
      // reset the floor to a clean state between journeys (close panels; release any parked stream).
      try { mock.control.release(); } catch (_) {}
      try { mock.control.setMode('quick'); } catch (_) {}
      await evalJS(cdp, closeOnly).catch(() => {});
      await sleep(400);
      console.log('');
    }

    report.console = diag.consoleMsgs.slice(0, 30);
    report.exceptions = diag.exceptions.slice(0, 20);
    if (diag.exceptions.length) { console.log(`uncaught exceptions during journeys: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach(e => console.log('  ' + e)); }
  } catch (e) {
    console.error('BLOCKED: journey driver threw — ' + (e && e.stack || e));
    return finish(exitCode || 2);
  }
  return finish(exitCode);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
