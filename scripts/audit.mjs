#!/usr/bin/env node
// audit.mjs — assertion-driven behavioral + truthfulness auditor for StarNet.  (`npm run audit`)
//
// Where `npm run shoot` proves the UI LOOKS right (frames a human/agent reads), this proves the
// floor BEHAVES right and the numbers don't lie — fully automatically, PASS/FAIL, no eyeballing.
// It boots the seeded in-game sidecar, then drives + asserts over CDP against the DEV-only
// window.__SKYNET_TEST__ probe (frontend/app/testapi.js):
//
//   floor-rest (P1 foundation):
//     • the test API is present + in-game
//     • every PLACED body idles inside its OWN zone (Tier A containment)
//     • awareness is GAZE-ONLY: no body is walking toward another body's tile (Tier C)
//     • HUD truthfulness: each on-screen number equals the reduction over the frozen U.bus log
//       (no-app-lies) — for a fresh seed, SPEND/TOKENS must read exactly the event-derived totals
//
// (P2 will add driven scenarios — spawn / summon-walks-to-own-desk / place-a-prop / run-a-task.)
// Exits NONZERO on any failed assertion and writes the offending frame + a JSON report.
//
// Usage:
//   npm run audit
//   SKYNET_AUDIT_PORT=8934 SKYNET_AUDIT_CDP=9334 npm run audit
//   SKYNET_AUDIT_LIVE_PROVIDER=1 npm run audit     # use the real configured provider/key
//   SKYNET_AUDIT_REUSE=1 npm run audit             # intentionally drive an already-running sidecar
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { sleep, launchChrome, connectCDP, evalJS, capture, collectDiagnostics } from './lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, isUp, waitUp, waitDevReady, DEFAULT_MODEL } from './lib/seed.mjs';
import { closeOnly, openSel, dismissRefitGuide } from './lib/states.mjs';
import { messageContentText } from './lib/message-content.mjs';

const PORT = process.env.SKYNET_AUDIT_PORT || '8934';
const CDP_PORT = Number(process.env.SKYNET_AUDIT_CDP || 9334);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const OUT_DIR = process.env.SKYNET_AUDIT_DIR || join(process.cwd(), '.uiaudit');
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';
const KEEP = process.argv.includes('--keep');
const SCRATCH = join(OUT_DIR, '_seed-workspace');
const PROFILE = join(OUT_DIR, '_profile');
const REUSE_EXISTING = /^(1|true|yes|on)$/i.test(String(process.env.SKYNET_AUDIT_REUSE || '').trim());
const LIVE_PROVIDER = /^(1|true|yes|on)$/i.test(String(process.env.SKYNET_AUDIT_LIVE_PROVIDER || '').trim());

// Default audit provider: deterministic, local, zero-spend. The task scenario needs
// a terminal run lifecycle, not a race against OpenRouter rejecting a placeholder key.
function startMockOpenRouter(model) {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      if (req.url && req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{
          id: model || DEFAULT_MODEL,
          name: 'Audit Mock Model',
          context_length: 8000,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools']
        }] }));
        return;
      }
      if (req.url && req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '2\n3\n5' } }] }) + '\n\n');
          setTimeout(() => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 600);
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      base: 'http://127.0.0.1:' + server.address().port + '/api/v1'
    }));
  });
}

// TOOL-EMITTING mock (for the approval scenario): the FIRST directive completion settles the Task Brief
// (brief_proceed — since the briefing-reliability boundary, a.k.a. merge a948a530, the host BLOCKS mutating
// tools until the brief is settled, so a model that leads with fs.write burns its call on the brief gate and
// never reaches the permission broker). The SECOND completion asks for the consent-gated write tool
// (fs.write, capability `cabinet`), so a non-Full-Access interactive run trips the real permission broker →
// emits permission.prompt → PAUSES. Every subsequent completion finishes with plain text + stop, so once the
// human approves and the tool result flows back, the run resumes to a terminal agent.run.end. `calls` counts
// completion requests, which is the ground truth for "the run is blocked" (exactly 2 until approval arrives:
// the settle turn + the paused tool turn).
function startToolMock(model) {
  return new Promise((resolve) => {
    let calls = 0;           // every completion the mock served (background engines included — forensics only)
    let directiveCalls = 0;  // completions belonging to THE AUDIT DIRECTIVE's run — the assertion currency
    const DIRECTIVE_MARK = 'write a short note to a file';   // must match the sendChat text in runApprovalScenario
    const server = createServer((req, res) => {
      if (req.url && req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: model || DEFAULT_MODEL, name: 'Audit Tool Mock', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url && req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          calls++;
          // CONTENT-AWARE ROUTING (2026-07-15 truth-regression triage, finding 6a3a04cf): the station now runs
          // autonomous background model passes (quest-refresh boot look, interests/scout, skill review, the First
          // Pitch) that share this mock. The old `calls === 1` script assumed the FIRST completion was the audit
          // directive — a background pass landing first consumed the scripted tool_call, so the directive run
          // never hit the consent gate and the assertion misread instrument noise as an app lie. Route by the
          // request's own user text instead: only the audit directive's run gets the fs.write ask; everything
          // else gets inert prose. Belt-and-braces: the dedicated sidecar also boots with the server-side
          // background minters opted out (SKYNET_QUEST_REFRESH=0 / SKYNET_SCOUT=0), but frontend-initiated
          // internal calls can't be env'd off, so the mock must stay content-aware regardless.
          let isDirective = false, lastUserTxt = '';
          try {
            const b = JSON.parse(body);
            const lastUser = [...(b.messages || [])].reverse().find(m => m.role === 'user');
            lastUserTxt = messageContentText(lastUser && lastUser.content);
            isDirective = lastUserTxt.toLowerCase().indexOf(DIRECTIVE_MARK) >= 0;
          } catch (_) { /* unparseable → treated as background */ }
          if (isDirective) directiveCalls++;
          else console.log(`[tool-mock] background completion #${calls} (not the directive): "${lastUserTxt.slice(0, 80)}"`);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (isDirective && directiveCalls === 1) {
            // settle the Task Brief first — the host's brief boundary refuses consequential tools before this.
            // (If a boot ever runs WITHOUT the brief layer armed, this call just errors as an unknown tool and
            // the run proceeds to completion #2 exactly the same — the script is safe in both worlds.)
            const tc = { index: 0, id: 'call_brief', type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify({ objective: 'write a short note to a file in the workspace' }) } };
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] }) + '\n\n');
            setTimeout(() => {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
              res.write('data: [DONE]\n\n'); res.end();
            }, 150);
          } else if (isDirective && directiveCalls === 2) {
            const tc = { index: 0, id: 'call_0', type: 'function', function: { name: 'fs.write', arguments: JSON.stringify({ path: 'audit-note.txt', content: 'written by the approval audit' }) } };
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] }) + '\n\n');
            setTimeout(() => {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
              res.write('data: [DONE]\n\n'); res.end();
            }, 150);
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: isDirective ? 'wrote the note as requested.' : 'acknowledged.' } }] }) + '\n\n');
            setTimeout(() => {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }) + '\n\n');
              res.write('data: [DONE]\n\n'); res.end();
            }, 150);
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1', callCount: () => calls, directiveCalls: () => directiveCalls }));
  });
}

// Wait until the DEV test probe is armed AND reports in-game.
async function waitTestReady(cdp, tries = 24) {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(cdp, '!!(window.__SKYNET_TEST__ && window.__SKYNET_TEST__.ready())').catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

// tiny assertion recorder. A SOFT assertion is reported but never fails the build (used for signals
// that depend on the test ENVIRONMENT — e.g. a real model run — rather than a product invariant).
function makeAsserter() {
  const results = [];
  const ok = (name, pass, detail, soft) => {
    results.push({ name, pass: !!pass, detail: detail || '', soft: !!soft });
    const tag = pass ? 'PASS' : (soft ? 'soft' : 'FAIL');
    console.log(`  ${tag}  ${name}${detail ? '  — ' + detail : ''}`);
    return !!pass;
  };
  return { ok, results };
}

// ---- CDP driving helpers (synthetic clicks/typing in the page) ----
const J = (v) => JSON.stringify(v);
const clickSel = (cdp, sel) => evalJS(cdp, `(() => { const el = document.querySelector(${J(sel)}); if (!el) return 'NOTFOUND'; el.click(); return 'clicked'; })()`).catch((e) => 'ERR:' + e.message);
async function waitSel(cdp, sel, tries = 25) {
  for (let i = 0; i < tries; i++) { const ok = await evalJS(cdp, `!!document.querySelector(${J(sel)})`).catch(() => false); if (ok) return true; await sleep(200); }
  return false;
}
const sendChat = (cdp, msg) => evalJS(cdp, `(() => { const i = document.getElementById('chat-input'); if (!i) return 'NO_INPUT'; i.focus(); i.value = ${J(msg)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); return 'sent'; })()`).catch((e) => 'ERR:' + e.message);
const getBodies = (cdp) => evalJS(cdp, 'window.__SKYNET_TEST__.bodies()').catch(() => []);
const tk = (t) => (t ? `${t.x},${t.y}` : '');
// REAL canvas input over CDP: synthesize a genuine left-click (move → press → release) at viewport
// coords, generating the same pointerdown/move/up build.js listens for. Unlike el.click(), this drives
// the actual canvas pointer pipeline, so a placement here proves the mouse→tile→addProp path end-to-end.
async function realClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',   x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased',x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
// what element is topmost at a viewport point (so we can confirm the canvas — not an overlay — receives input).
const elAt = (cdp, x, y) => evalJS(cdp, `(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? { tag: e.tagName, cls: String(e.className || '') } : null; })()`).catch(() => null);
const heroCapTypes = (cdp) => evalJS(cdp, "(typeof World!=='undefined'&&World.heroCaps)?(World.heroCaps('agent')||[]).map(c=>c.objectType):null").catch(() => null);

// containment + gaze-only over a body snapshot (the Tier A/C invariants, reused across scenarios).
function assertFloorInvariants(A, prefix, list) {
  const escaped = (list || []).filter((b) => b.zone && b.inOwnZone === false);   // only bodies that HAVE a zone may violate it
  A.ok(`${prefix}/zoned-bodies-contained`, escaped.length === 0, escaped.length ? escaped.map((b) => `${b.name}@(${b.tile.x},${b.tile.y})`).join('; ') : `${list.length} bodies, none roaming outside its zone`);
  const occ = new Set((list || []).map((b) => tk(b.tile)));
  const chasing = (list || []).filter((b) => b.moving && b.target && occ.has(tk(b.target.tile)) && tk(b.target.tile) !== tk(b.tile));
  A.ok(`${prefix}/awareness-gaze-only`, chasing.length === 0, chasing.length ? chasing.map((b) => `${b.name} → ${tk(b.target.tile)}`).join('; ') : 'no body walking onto another');
}

// SCENARIO: the seeded floor at rest — the P1 invariants.
async function scenarioFloorRest(cdp, A) {
  const api = await evalJS(cdp, 'window.__SKYNET_TEST__ ? { dev: window.__SKYNET_TEST__.dev, version: window.__SKYNET_TEST__.version } : null').catch(() => null);
  A.ok('testapi/present', api && api.dev === true, api ? ('v' + api.version) : 'window.__SKYNET_TEST__ missing');

  const list = await getBodies(cdp);
  A.ok('bodies/nonempty', Array.isArray(list) && list.length >= 1, `${(list || []).length} bodies`);

  // Tier A (containment) + Tier C (gaze-only awareness).
  assertFloorInvariants(A, 'floor', list);

  // Truthful telemetry — displayed HUD numbers equal the reduction over the frozen U.bus log.
  const hud = await evalJS(cdp, 'window.__SKYNET_TEST__.hud()').catch(() => null);
  if (hud && Array.isArray(hud.checks)) {
    for (const c of hud.checks) {
      A.ok(`truthful/${c.metric}`, c.ok, `displayed=${c.displayed} ${c.mode} expected=${c.expected}`);
    }
  } else {
    A.ok('truthful/hud', false, 'hud() returned nothing');
  }

  // Frozen log is live.
  const n = await evalJS(cdp, 'window.__SKYNET_TEST__.eventCount()').catch(() => -1);
  A.ok('log/frozen-bus', typeof n === 'number' && n >= 0, `${n} events captured`);

  return { bodies: list, hud };
}

// SCENARIO: RUN A TASK — send a chat directive and prove a run is dispatched + resolved.
// By default the audit points the sidecar at a deterministic local provider, so this scenario
// waits on terminal agent.run.* events instead of a provider/network race.
async function scenarioTask(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const before = (await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run').length").catch(() => 0)) || 0;
  const sent = await sendChat(cdp, 'list 3 prime numbers, one per line, then stop');
  A.ok('task/sent', sent === 'sent', sent);

  // Tight initial poll: the work pose can be brief, while the frozen log is permanent. Run lifecycle
  // events are the reliable proof a task was dispatched and reached a terminal state.
  let sawActivity = false, kinds = {};
  for (let i = 0; i < 100; i++) {
    const act = await evalJS(cdp, "(typeof World!=='undefined'&&World.getActivity)?World.getActivity():null").catch(() => null);
    if (act === 'task' || act === 'thinking') sawActivity = true;          // latch
    const runs = await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run').map(e=>e.name)").catch(() => []);
    kinds = {}; for (const k of (runs || [])) kinds[k] = (kinds[k] || 0) + 1;
    if ((kinds['agent.run.end'] || 0) > 0) break;                          // run resolved (done or errored)
    await sleep(200);
  }
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  A.ok('task/run-dispatched', total > before && (kinds['agent.run.start'] || 0) > 0, `agent.run.* seen: ${Object.keys(kinds).join(', ') || 'none'}`);
  A.ok('task/run-lifecycle', (kinds['agent.run.start'] || 0) > 0 && (kinds['agent.run.end'] || 0) > 0, `start=${kinds['agent.run.start'] || 0} end=${kinds['agent.run.end'] || 0} err=${kinds['agent.run.error'] || 0}`);
  if (LIVE_PROVIDER) {
    const costs = await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.cost').map(e=>e.payload)").catch(() => []);
    const lastCost = Array.isArray(costs) && costs.length ? costs[costs.length - 1] : {};
    A.ok('task/live-no-run-error', (kinds['agent.run.error'] || 0) === 0, `err=${kinds['agent.run.error'] || 0}`);
    A.ok('task/live-cost-reconciled', !!(lastCost && (lastCost.usd || 0) > 0), `usd=${lastCost && lastCost.usd} tokensIn=${lastCost && lastCost.tokensIn}`);
  }
  A.ok('task/work-pose-engaged', sawActivity, sawActivity ? 'caught World activity=task' : 'work pose too brief to latch; run lifecycle completed deterministically', /*soft*/ true);
}

// SCENARIO: SUMMON a new agent via the real Recruitment Bay, and prove the new body is well-behaved.
async function scenarioSummon(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const before = (await getBodies(cdp)).length;
  const opened = await evalJS(cdp, openSel('#bb-recruit', 'RECRUIT')).catch((e) => 'ERR:' + e.message);
  const bayUp = await waitSel(cdp, '.mkt-cta-main.mkt-deploy', 40);        // bay opens after an /api/limits fetch
  A.ok('summon/bay-open', bayUp, bayUp ? `recruitment bay shown (${opened})` : `.mkt-cta-main.mkt-deploy never appeared (${opened})`);
  if (bayUp) {
    const rec = await evalJS(cdp, "(() => { const b = document.querySelector('.mkt-cta-main.mkt-deploy'); if (!b) return 'NONE'; const id = b.dataset.id || ''; b.click(); return 'recruited:' + id; })()").catch((e) => 'ERR:' + e.message);
    await sleep(2200);                                                     // spawn + materialize + first stroll beat
    const list = await getBodies(cdp);
    A.ok('summon/body-spawned', list.length === before + 1, `${before} → ${list.length} (${rec})`);
    assertFloorInvariants(A, 'summon', list);                             // the new body must stay contained + gaze-only
  }
  await evalJS(cdp, closeOnly).catch(() => {});                            // close the bay for the frame
  await sleep(700);
}

// SCENARIO: THE MOAT — object=capability. Enter BUILD, place a `dish`, and prove the WEB capability
// comes online (placed object ⇒ earned reach). Placement goes through the real station.addProp path via
// a DEV-only Build.__test__ hook (canvas-drag pixel math is private), then we read World.heroCaps.
const capList = (caps) => (Array.isArray(caps) ? caps.map((c) => c && c.objectType) : []);
async function scenarioMoat(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const rawBefore = await evalJS(cdp, "(typeof World!=='undefined'&&World.heroCaps)?World.heroCaps('agent'):null").catch(() => null);
  const before = capList(rawBefore);
  A.ok('moat/heroCaps-readable', Array.isArray(rawBefore), `before=[${before.join(', ') || 'none'}]`);

  // enter BUILD and wait for the dev test hook
  await clickSel(cdp, '#bb-build');
  let built = false;
  for (let i = 0; i < 20; i++) { built = await evalJS(cdp, "!!(typeof Build!=='undefined' && Build.__test__ && Build.__test__.isOpen())").catch(() => false); if (built) break; await sleep(200); }
  A.ok('moat/build-mode', built, built ? 'REFIT open + dev hook present' : 'Build.__test__ not available');

  let placed = null;
  if (built) {
    placed = await evalJS(cdp, "Build.__test__.placeCapProp('workbench')").catch((e) => ({ ok: false, reason: e.message }));
    A.ok('moat/place-prop', !!(placed && placed.ok), placed && placed.ok ? `workbench @ (${placed.tile.tx},${placed.tile.ty})` : `placement failed: ${placed && placed.reason}`);
    await clickSel(cdp, '#refit-done');                 // exit build → re-bake
    await evalJS(cdp, closeOnly).catch(() => {});
    await sleep(900);
  }

  // object=capability: a placed workbench ⇒ the TERMINAL capability (objectType 'workbench') comes online.
  const after = capList(await evalJS(cdp, "(typeof World!=='undefined'&&World.heroCaps)?World.heroCaps('agent'):null").catch(() => null));
  A.ok('moat/capability-online', after.includes('workbench') && !before.includes('workbench'), `after=[${after.join(', ') || 'none'}] (workbench ⇒ terminal)`);
  const KNOWN = new Set(['cabinet', 'dish', 'notebook', 'workbench']);   // heroCaps objectTypes (computer/connector excluded by design)
  const bad = after.filter((c) => !KNOWN.has(c));
  A.ok('moat/caps-well-formed', bad.length === 0, bad.length ? 'unexpected: ' + bad.join(',') : 'every placed object maps to a known capability');
}

// SCENARIO: PROP-PLACE via REAL canvas input (object=capability, proven through the mouse pipeline).
// Where `moat` places through the DEV Build.__test__ hook (validated-tile shortcut), this drives the REAL
// pointer path: enter REFIT, dismiss the first-use guide (it blankets the canvas), select the prop tool +
// CAPABILITY → comms_dish through the actual palette buttons, then CLICK the grid with CDP mouse events at
// the framed centre (fitCamera centres the station, so centre lands inside the spawn room). Asserts
// World.heroCaps gains `dish` (WEB) — the placement, and the capability it earns, both came from a mouse.
async function scenarioPropPlace(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  const before = heroCapTypes(cdp) && (await heroCapTypes(cdp)) || [];
  const hadDish = Array.isArray(before) && before.includes('dish');

  await clickSel(cdp, '#bb-build');
  let built = false;
  for (let i = 0; i < 20; i++) { built = await evalJS(cdp, "!!(typeof Build!=='undefined' && Build.__test__ && Build.__test__.isOpen())").catch(() => false); if (built) break; await sleep(200); }
  A.ok('prop-place/build-mode', built, built ? 'REFIT open' : 'Build.__test__ not available');
  if (!built) return;

  // clear the full-canvas first-use guide, else CDP mouse events hit .refit-guide, never the grid.
  const dismissed = await evalJS(cdp, dismissRefitGuide).catch(() => 0);
  await sleep(200);
  const topEl = await elAt(cdp, 720, 450);
  const canvasClear = !!(topEl && /refit-canvas/.test(topEl.cls));
  A.ok('prop-place/canvas-reachable', canvasClear, canvasClear ? `guide dismissed (${dismissed}); topmost @centre = ${topEl.cls}` : `centre still covered by ${topEl && topEl.cls} — real mouse would miss the grid`);

  // select prop tool → CAPABILITY category → comms_dish, all through the REAL palette DOM.
  const pt = await evalJS(cdp, "(() => { const t=document.querySelector('.refit-tool[data-tool=\"prop\"]'); if(!t) return 'NO_TOOL'; t.click(); return 'ok'; })()").catch((e) => 'ERR:' + e.message);
  await sleep(150);
  await evalJS(cdp, "(() => { const c=document.querySelector('.refit-propcat[data-cat=\"capability\"]'); if(c) c.click(); })()").catch(() => {});
  await sleep(150);
  const tile = await evalJS(cdp, "(() => { const b=document.querySelector('.refit-proptile[data-prop=\"comms_dish\"]'); if(!b) return 'NO_TILE'; b.click(); return 'ok'; })()").catch((e) => 'ERR:' + e.message);
  A.ok('prop-place/prop-selected', pt === 'ok' && tile === 'ok', `tool=${pt} tile=${tile}`);

  // REAL mouse placement: try the framed centre, then a small spiral of nearby tiles (an occupied/edge
  // centre tile just no-ops; a neighbour lands). We assert on the CAPABILITY appearing, not a fixed tile.
  let placed = false; const attempts = [];
  if (canvasClear) {
    const cx = 720, cy = 450;
    const spiral = [[0, 0], [0, -48], [48, 0], [0, 48], [-48, 0], [48, -48], [48, 48], [-48, 48], [-48, -48], [0, -96], [96, 0], [-96, 0], [0, 96]];
    for (const [dx, dy] of spiral) {
      await realClick(cdp, cx + dx, cy + dy);
      await sleep(140);
      const now = (await heroCapTypes(cdp)) || [];
      attempts.push(`(${cx + dx},${cy + dy})`);
      if (now.includes('dish') && !hadDish) { placed = true; break; }
    }
  }
  A.ok('prop-place/mouse-placed-dish', placed, placed ? `dish (WEB) online after real click ${attempts[attempts.length - 1]} (${attempts.length} pt${attempts.length > 1 ? 's' : ''})` : `no dish cap after ${attempts.length} real clicks: ${attempts.join(' ')}`);

  // leave build; re-read the capability from the live world to prove the placement persisted the re-bake.
  await clickSel(cdp, '#refit-done');
  await evalJS(cdp, closeOnly).catch(() => {});
  await sleep(700);
  const after = (await heroCapTypes(cdp)) || [];
  A.ok('prop-place/capability-persists', after.includes('dish'), `after=[${after.join(', ') || 'none'}] (dish ⇒ web)`);
}

// SCENARIO: HUD/XP TRUTH — verify event-derived floor stats separately from
// Commander progression, whose authority is the sidecar's journey endpoint.
async function scenarioHudXp(cdp, A) {
  await evalJS(cdp, closeOnly).catch(() => {});
  // the app's own displayed-vs-reduced checks (station level etc.) must all hold.
  const hud = await evalJS(cdp, 'window.__SKYNET_TEST__.hud()').catch(() => null);
  A.ok('hud-xp/hud-readable', !!(hud && Array.isArray(hud.checks) && hud.checks.length), hud ? `${hud.checks.length} HUD checks` : 'hud() returned nothing');
  if (hud && Array.isArray(hud.checks)) for (const c of hud.checks) A.ok(`hud-xp/${c.metric}`, c.ok, `displayed=${c.displayed} ${c.mode} expected=${c.expected}`);

  // FLOOR STATS truth: the reduced FloorStats snapshot (runs/slag) is derived purely from the frozen log; assert
  // it's internally consistent and reflects the runs the driven scenarios fired (task + approval → ≥1 run).
  const floor = await evalJS(cdp, 'window.__SKYNET_TEST__.reduceFloor()').catch(() => null);
  const runEvents = (await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run.start').length").catch(() => 0)) || 0;
  A.ok('hud-xp/floorstats-reduced', !!(floor && typeof floor.runs === 'number'), floor ? `runs=${floor.runs} slag=${floor.slag}` : 'reduceFloor() returned nothing');
  A.ok('hud-xp/floorstats-runs-match-log', !!floor && floor.runs === runEvents, floor ? `FloorStats.runs=${floor.runs} == agent.run.start count=${runEvents}` : 'no floor snapshot');

  // Crew XP remains observable but cannot determine the Commander headline.
  // Independently query the real endpoint so an unavailable journey cannot pass
  // this service-availability check merely by displaying an honest dash.
  const xp = await evalJS(cdp, 'window.__SKYNET_TEST__.reduceXp()').catch(() => null);
  const journey = await evalJS(cdp, "Harness.api.get('/api/journey')").catch(() => null);
  const commanderLevel = journey && journey.ok && journey.journey && journey.journey.progression && journey.journey.progression.level;
  const chip = await evalJS(cdp, "(() => { const e=document.getElementById('gt-station'); return e?(e.textContent||'').trim():null; })()").catch(() => null);
  const chipLevel = chip == null ? null : (() => { const m = String(chip).match(/(\d+)/); return m ? parseInt(m[1], 10) : null; })();
  A.ok('hud-xp/xp-reduced', !!(xp && typeof xp.level === 'number'), xp ? `Xp.level=${xp.level} xp=${xp.xp}` : 'reduceXp() returned nothing');
  A.ok('hud-xp/commander-source-available', Number.isFinite(commanderLevel), 'backend Commander level=' + commanderLevel);
  A.ok('hud-xp/station-chip-matches-journey', chipLevel != null && Number.isFinite(commanderLevel) && chipLevel === commanderLevel, `displayed COMMANDER="${chip}" (lvl ${chipLevel}) vs backend level=${commanderLevel}`);
}

// SCENARIO: CONVEYOR — drive the REAL production transport module (Conveyor, a page global) end-to-end: a TEST
// belt moves a crate off its open end (delivered exactly once), and a K=2 MERGER junction combines two inbound
// crates into ONE carrier WITHOUT silently losing work. Runs in-page against the same Conveyor build.js/world.js
// use, with the module's injected clock (deterministic; no wall-clock, no RNG) — so this asserts the live art+sim.
async function scenarioConveyor(cdp, A) {
  const present = await evalJS(cdp, "typeof Conveyor !== 'undefined' && !!Conveyor.create").catch(() => false);
  A.ok('conveyor/module-present', present, present ? 'Conveyor global available' : 'Conveyor not loaded in-page');
  if (!present) return;

  // 1) a straight TEST belt carries one crate to its open end and delivers it exactly once.
  const belt = await evalJS(cdp, `(() => {
    const belts = [{x:0,y:0,dir:'E'},{x:1,y:0,dir:'E'},{x:2,y:0,dir:'E'}];
    const del = [];
    const cv = Conveyor.create({ onDeliver: (bx,x,y) => del.push({ id: bx.payload && bx.payload.workitemId, x, y }) });
    cv.enqueueAt(0, 0, { workitemId: 'belt-1', preview: 'test crate' });
    let t = 0, rode = false, deliveredAt = -1;
    for (let i = 0; i < 300; i++) {
      t += 16; cv.tick(16, t, belts);
      if (cv.peekBoxes().some(b => b.payload && b.payload.workitemId === 'belt-1')) rode = true;
      if (del.length && deliveredAt < 0) deliveredAt = i;
      // keep ticking well past delivery so the sink animation (SINK_MS) completes and the box despawns.
      if (deliveredAt >= 0 && i - deliveredAt > 40) break;
    }
    return { rode, delCount: del.length, delId: del[0] && del[0].id, delAt: del[0] && (del[0].x + ',' + del[0].y), remaining: cv.boxCount() };
  })()`).catch((e) => ({ err: e.message }));
  A.ok('conveyor/crate-rode-belt', !!belt && belt.rode === true, belt && belt.err ? belt.err : 'a crate rode the TEST belt');
  A.ok('conveyor/delivered-once', !!belt && belt.delCount === 1 && belt.delId === 'belt-1', belt ? `delivered ${belt.delCount}× (id=${belt.delId}) @ ${belt.delAt}` : 'no belt result');
  A.ok('conveyor/belt-drains', !!belt && belt.remaining === 0, belt ? `${belt.remaining} boxes left on belt (drains to empty)` : 'no belt result');

  // 2) a MERGER junction is a FUNNEL, not a batcher: two inbound crates → TWO deliveries, both ids intact.
  //
  //    This asserted the opposite until 2026-07-26 (`delCount === 1`, one carrier holding a combined
  //    `merged` id list). That contract was the bug 78f3f724 removed: chooseExit absorbed the first K-1
  //    crates so they never delivered, and nobody but this probe ever read `merged`/`mergeCount`. Nothing
  //    in the harness batches — Pipeline.resolveTarget dispatches every work-item independently, so K
  //    inbound messages were always K separate paid runs, and the floor was animating a barrier the
  //    server never performed. The law is K crates in, K crates out, K runs; this probe now holds that.
  //    `bufferSize` stays in the fixture on purpose: a legacy K on a saved prop must be INERT, and a
  //    delivery count of 1 here would mean it started being honoured again.
  const merge = await evalJS(cdp, `(() => {
    const belts = [{x:0,y:0,dir:'E'},{x:1,y:0,dir:'E'},{x:2,y:0,dir:'E'},{x:3,y:0,dir:'E'}];
    const junc = new Map([['2,0', { kind:'merge', bufferSize:2 }]]);
    const del = [];
    const cv = Conveyor.create({ onDeliver: bx => del.push(bx.payload) });
    cv.enqueueAt(0, 0, { workitemId: 'm1' });
    let t = 0; for (let i = 0; i < 30; i++) { t += 16; cv.tick(16, t, belts, junc); }
    cv.enqueueAt(0, 0, { workitemId: 'm2' });
    for (let i = 0; i < 300; i++) { t += 16; cv.tick(16, t, belts, junc); }
    return {
      delCount: del.length,
      ids: del.map(p => p && p.workitemId).sort(),
      fakeCombine: del.some(p => p && (p.merged != null || p.mergeCount != null)),
      remaining: cv.boxCount()
    };
  })()`).catch((e) => ({ err: e.message }));
  A.ok('conveyor/merger-k-in-k-out', !!merge && merge.delCount === 2, merge && merge.err ? merge.err : (merge ? `merger emitted ${merge.delCount} deliveries for 2 inbound (K in = K out)` : 'no merge result'));
  const bothArrived = !!(merge && merge.ids && merge.ids.join(',') === 'm1,m2');
  A.ok('conveyor/merger-loses-nothing', bothArrived && merge.fakeCombine === false, merge ? `delivered=[${(merge.ids || []).join(',')}] fakeCombineFields=${merge.fakeCombine}` : 'no merge result');
  A.ok('conveyor/merger-belt-drains', !!merge && merge.remaining === 0, merge ? `${merge.remaining} boxes left (both crates cross the junction, deliver and despawn)` : 'no merge result');
}

// SCENARIO (dedicated boot): TOOL-RUN WITH APPROVAL — drive a run that hits a real permission gate and prove
// the consent loop end-to-end. Unlike the other scenarios, this needs its OWN sidecar booted WITHOUT Full
// Access (fullAccess:false → the consent broker's interactive surface, bypass off) plus a tool-emitting mock,
// because the shared audit sidecar runs Full Access (which bypasses consent entirely) and the shared mock
// returns plain text (no tool call). Steps: place a `safe` (→ cabinet/files cap) so the agent OWNS fs.write,
// send a directive, and assert: (1) permission.prompt fires + the .consent row renders in COMMS, (2) the run
// is GENUINELY blocked while waiting (no agent.run.end; the mock was called exactly once), (3) approving
// resumes it to a terminal agent.run.end (a 2nd mock call). Ports: 8961/9361 (ad-hoc range, per lane brief).
async function runApprovalScenario() {
  const APORT = process.env.SKYNET_AUDIT_APPROVAL_PORT || '8961';
  const ACDP = Number(process.env.SKYNET_AUDIT_APPROVAL_CDP || 9361);
  const AURL = `http://127.0.0.1:${APORT}/`;
  const ASCRATCH = join(OUT_DIR, '_approval-workspace');
  const APROFILE = join(OUT_DIR, '_approval-profile');
  const A = makeAsserter();
  let mock = null, side = null, proc = null, cdp = null;
  const savedBase = process.env.SKYNET_OPENROUTER_BASE, savedBase2 = process.env.STARNET_OPENROUTER_BASE;
  try {
    if (await isUp(AURL)) throw new Error(`approval port :${APORT} already in use; set SKYNET_AUDIT_APPROVAL_PORT to a free port`);
    mock = await startToolMock(DEFAULT_MODEL);
    process.env.SKYNET_OPENROUTER_BASE = mock.base;
    process.env.STARNET_OPENROUTER_BASE = mock.base;
    console.log(`\nscenario: tool-run-with-approval (dedicated NON-full-access sidecar on :${APORT})`);
    materializeSeedWorkspace(ASCRATCH);
    // KEY: interactive consent surface. Background minters opted out (deterministic instrument — the quest-refresh
    // boot look / scout would otherwise race the directive for the mock; frontend internal calls are additionally
    // defused by the content-aware mock above).
    side = bootSeededSidecar({ port: APORT, scratchDir: ASCRATCH, fullAccess: false, env: { SKYNET_QUEST_REFRESH: '0', SKYNET_SCOUT: '0' } });
    if (!(await waitUp(AURL))) throw new Error('approval sidecar failed to come up on :' + APORT);
    ({ proc } = launchChrome({ cdpPort: ACDP, win: WIN, profileDir: APROFILE }));
    cdp = await connectCDP(ACDP);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: AURL });
    const ready = await waitDevReady(cdp, evalJS, { tries: 30, url: AURL }) && await waitTestReady(cdp);
    A.ok('approval/in-game', ready, ready ? 'floor + testapi ready (non-full-access boot lands in-game)' : 'never reached in-game');
    if (!ready) { await capture(cdp, OUT_DIR, '_FAIL-tool-run-with-approval'); return { name: 'tool-run-with-approval', passed: false, assertions: A.results, data: null }; }

    // give the agent the FILES capability by placing a cabinet-granting prop (safe → cabinet). This isn't the
    // prop-placement test (that's scenarioPropPlace); here we just need fs.write to be OWNED, so use the fast hook.
    await clickSel(cdp, '#bb-build');
    for (let i = 0; i < 20; i++) { if (await evalJS(cdp, "!!(typeof Build!=='undefined'&&Build.__test__&&Build.__test__.isOpen())").catch(() => false)) break; await sleep(200); }
    const placed = await evalJS(cdp, "Build.__test__.placeCapProp('safe')").catch((e) => ({ ok: false, reason: e.message }));
    await clickSel(cdp, '#refit-done'); await evalJS(cdp, closeOnly).catch(() => {}); await sleep(700);
    const caps = (await heroCapTypes(cdp)) || [];
    A.ok('approval/files-cap-owned', !!(placed && placed.ok) && caps.includes('cabinet'), `placed=${placed && placed.ok} heroCaps=[${caps.join(', ') || 'none'}]`);

    // send a directive → the tool-mock asks for fs.write → the interactive consent broker prompts.
    const sent = await sendChat(cdp, 'write a short note to a file, then stop');
    A.ok('approval/directive-sent', sent === 'sent', sent);

    // poll for the LIVE prompt event + the rendered .consent control, while the run stays paused.
    let promptEvt = false, consentRow = false, endedEarly = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const pe = await evalJS(cdp, "window.__SKYNET_TEST__.events('permission.prompt').length").catch(() => 0);
      if ((pe || 0) > 0) promptEvt = true;
      const cr = await evalJS(cdp, "!!document.querySelector('.consent .consent-btn')").catch(() => false);
      if (cr) consentRow = true;
      const ends = await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run.end').length").catch(() => 0);
      if ((ends || 0) > 0) endedEarly = true;
      if (promptEvt && consentRow) break;
    }
    A.ok('approval/prompt-emitted', promptEvt, promptEvt ? 'permission.prompt fired on the run stream' : 'no permission.prompt — run never hit a gate');
    A.ok('approval/consent-row-rendered', consentRow, consentRow ? '.consent control rendered in COMMS' : 'consent control never appeared');
    // BLOCKED: the run must not have terminated, and the DIRECTIVE's run must have made exactly one completion
    // (paused pre-tool-result). Background engine calls are counted separately by the content-aware mock.
    // ≤2 completions while paused: the brief-settle turn + the paused tool turn (or just 1 if the brief
    // layer wasn't armed and the settle call errored without consuming a completion budget).
    const callsBeforeApprove = mock.directiveCalls();
    A.ok('approval/run-blocked-while-waiting', !endedEarly && callsBeforeApprove >= 1 && callsBeforeApprove <= 2, `agent.run.end seen=${endedEarly}; directive completions so far=${callsBeforeApprove} (expect 2 while paused: settle+tool; ${mock.callCount()} total incl. background)`);
    // The session lamp must reach the same pending state as COMMS within its existing 1s refresh.
    let sessionLamp = null;
    for (let i = 0; i < 15; i++) {
      sessionLamp = await evalJS(cdp, `(() => {
        const row = document.querySelector('#workstreams .ws-row.sel'), dot = row?.querySelector('.ws-dot');
        return { approval: !!dot?.classList.contains('approval'), label: row?.querySelector('.ws-meta')?.textContent || '' };
      })()`).catch(() => null);
      if (sessionLamp?.approval && sessionLamp.label === 'Approval needed') break;
      await sleep(100);
    }
    A.ok('approval/session-indicator', !!sessionLamp?.approval && sessionLamp.label === 'Approval needed',
      JSON.stringify(sessionLamp));
    await capture(cdp, OUT_DIR, 'tool-run-with-approval_awaiting');

    // APPROVE ONCE → the paused dispatch resolves, the tool runs, the result flows back, the run resumes.
    const approved = await evalJS(cdp, "(() => { const b=[...document.querySelectorAll('.consent .consent-btn')].find(x=>/approve/i.test(x.textContent||'')); if(!b) return 'NO_BTN'; b.click(); return 'approved'; })()").catch((e) => 'ERR:' + e.message);
    A.ok('approval/approve-clicked', approved === 'approved', approved);
    let resumed = false;
    for (let i = 0; i < 60; i++) { await sleep(250); const ends = await evalJS(cdp, "window.__SKYNET_TEST__.events('agent.run.end').length").catch(() => 0); if ((ends || 0) > 0) { resumed = true; break; } }
    A.ok('approval/run-resumes-on-approve', resumed && mock.directiveCalls() >= 3, `agent.run.end after approve=${resumed}; directive completions now=${mock.directiveCalls()} (≥3 ⇒ settle + tool + post-approval round-trip)`);

    const hardFail = A.results.some((r) => !r.pass && !r.soft);
    await capture(cdp, OUT_DIR, hardFail ? '_FAIL-tool-run-with-approval' : 'tool-run-with-approval');
    return { name: 'tool-run-with-approval', passed: !hardFail, assertions: A.results, data: { console: diag.consoleMsgs.slice(0, 12) } };
  } catch (e) {
    A.ok('tool-run-with-approval/ran', false, 'threw: ' + e.message);
    try { if (cdp) await capture(cdp, OUT_DIR, '_FAIL-tool-run-with-approval'); } catch {}
    return { name: 'tool-run-with-approval', passed: false, assertions: A.results, data: null };
  } finally {
    try { cdp?.ws.close(); } catch {}
    try { proc && proc.kill('SIGKILL'); } catch {}
    try { side && side.kill('SIGKILL'); } catch {}
    try { mock && mock.server && mock.server.close(); } catch {}
    // restore the shared mock base so nothing downstream is affected.
    if (savedBase === undefined) delete process.env.SKYNET_OPENROUTER_BASE; else process.env.SKYNET_OPENROUTER_BASE = savedBase;
    if (savedBase2 === undefined) delete process.env.STARNET_OPENROUTER_BASE; else process.env.STARNET_OPENROUTER_BASE = savedBase2;
    if (!KEEP) { try { rmSync(ASCRATCH, { recursive: true, force: true }); } catch {} try { rmSync(APROFILE, { recursive: true, force: true }); } catch {} }
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let ownSidecar = null;
  let mock = null;
  if (await isUp(APP_URL)) {
    if (!REUSE_EXISTING) throw new Error(`audit port :${PORT} already has a server; set SKYNET_AUDIT_REUSE=1 to reuse it, or set SKYNET_AUDIT_PORT to a free port`);
    console.log(`sidecar: reusing the one already up on :${PORT}`);
  } else {
    if (!LIVE_PROVIDER) {
      mock = await startMockOpenRouter(DEFAULT_MODEL);
      process.env.SKYNET_OPENROUTER_BASE = mock.base;
      process.env.STARNET_OPENROUTER_BASE = mock.base;
      console.log(`provider: deterministic audit mock on ${mock.base}`);
    }
    console.log(`sidecar: booting SEEDED SKYNET_DEV on :${PORT} (model=${DEFAULT_MODEL}) ...`);
    materializeSeedWorkspace(SCRATCH);
    ownSidecar = bootSeededSidecar({ port: PORT, scratchDir: SCRATCH });
    if (!(await waitUp(APP_URL))) throw new Error('seeded sidecar failed to come up on :' + PORT);
    console.log('sidecar: ready');
  }

  const { proc, chrome } = launchChrome({ cdpPort: CDP_PORT, win: WIN, profileDir: PROFILE });
  proc.on('error', (e) => { console.error('chrome spawn error', e); process.exit(1); });
  console.log(`chrome: ${chrome}\ntarget: ${APP_URL}`);

  let cdp, exitCode = 0;
  const report = { url: APP_URL, ranAt: new Date().toISOString(), scenarios: [] };
  try {
    cdp = await connectCDP(CDP_PORT);
    const diag = collectDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });

    const floorReady = await waitDevReady(cdp, evalJS, { tries: 24, url: APP_URL });
    const testReady = floorReady && await waitTestReady(cdp);
    console.log(`floorReady=${floorReady} testReady=${testReady}`);
    if (!testReady) {
      console.error('FAIL: window.__SKYNET_TEST__ never became ready in-game.');
      await capture(cdp, OUT_DIR, '_FAILED-ready');
      exitCode = 2;
    } else {
      // Run the scenarios in order. Earlier ones MUTATE state for later ones (task → working,
      // summon → +1 body), so the order is deliberate: rest (clean) → task (hero) → summon → moat.
      const SCENARIOS = [
        { name: 'floor-rest', fn: scenarioFloorRest },
        { name: 'task',       fn: scenarioTask },
        { name: 'hud-xp',     fn: scenarioHudXp },      // Q3: displayed HUD/XP == event-reduced truth (after a real run)
        { name: 'summon',     fn: scenarioSummon },
        { name: 'moat',       fn: scenarioMoat },
        { name: 'prop-place', fn: scenarioPropPlace },  // Q3: object=capability via REAL canvas mouse input
        { name: 'conveyor',   fn: scenarioConveyor },   // Q3: TEST belt delivers · MERGER loses nothing
      ];
      for (const sc of SCENARIOS) {
        console.log(`\nscenario: ${sc.name}`);
        const A = makeAsserter();
        let data = null;
        try { data = await sc.fn(cdp, A); } catch (e) { A.ok(`${sc.name}/ran`, false, 'threw: ' + e.message); }
        const hardFail = A.results.some((r) => !r.pass && !r.soft);   // SOFT failures never fail the build
        await capture(cdp, OUT_DIR, hardFail ? `_FAIL-${sc.name}` : sc.name);
        report.scenarios.push({ name: sc.name, passed: !hardFail, assertions: A.results, data: data || null });
        if (hardFail) exitCode = 3;
      }

      // TOOL-RUN-WITH-APPROVAL runs in its OWN dedicated NON-full-access sidecar (see runApprovalScenario). It's
      // incompatible with a reused sidecar (that one is Full Access) and with --live (it needs the tool-emitting
      // mock), so it's skipped LOUDLY (a soft, clearly-labelled marker) in those modes rather than silently absent.
      if (REUSE_EXISTING || LIVE_PROVIDER) {
        const A = makeAsserter();
        A.ok('approval/skipped-in-this-mode', true, `not run: ${REUSE_EXISTING ? 'REUSE' : ''}${LIVE_PROVIDER ? 'LIVE_PROVIDER' : ''} mode needs a dedicated non-full-access mock boot`, /*soft*/ true);
        console.log('\nscenario: tool-run-with-approval — SKIPPED (needs a dedicated non-full-access mock boot; not compatible with reuse/live)');
        report.scenarios.push({ name: 'tool-run-with-approval', passed: true, assertions: A.results, data: null });
      } else {
        const scr = await runApprovalScenario();
        report.scenarios.push(scr);
        if (!scr.passed) exitCode = 3;
      }
    }
    report.console = diag.consoleMsgs.slice(0, 30);
    report.exceptions = diag.exceptions.slice(0, 20);
    if (diag.exceptions.length) { console.log(`\nuncaught exceptions: ${diag.exceptions.length}`); diag.exceptions.slice(0, 8).forEach((e) => console.log('  ' + e)); }
  } finally {
    writeFileSync(join(OUT_DIR, 'audit-report.json'), JSON.stringify(report, null, 2));
    try { cdp?.ws.close(); } catch {}
    try { proc.kill('SIGKILL'); } catch {}
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
    if (mock && mock.server) { try { mock.server.close(); } catch {} }
    if (!KEEP) { try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} }
  }

  const all = report.scenarios.flatMap((s) => s.assertions);
  const total = all.length;
  const passed = all.filter((a) => a.pass).length;
  const softFails = all.filter((a) => !a.pass && a.soft).length;
  console.log(`\n${exitCode === 0 ? 'AUDIT PASS' : 'AUDIT FAIL (exit ' + exitCode + ')'} — ${passed}/${total} assertions passed${softFails ? ` (${softFails} soft skip${softFails > 1 ? 's' : ''})` : ''} → ${OUT_DIR}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
