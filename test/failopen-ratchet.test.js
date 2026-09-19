/* node test/failopen-ratchet.test.js — the fail-open RATCHET (2026-08-18 sweep).
   A bare silent promise catch — .catch with an empty/constant handler — on a background pass hid
   reflection's 100% failure rate for weeks. The 2026-08-18 sweep converted every dangerous sidecar
   site to swallow(tag) from sidecar/failopen.js and hand-audited the remainder as benign (shutdown
   reaps, CDP teardown, value defaults, reconnect loops that re-arm themselves). This test locks that
   audited baseline PER FILE: counts may only go DOWN. If it failed on your change, don't raise the
   number — use `.catch(swallow('your.tag'))` (or `.catch(swallow('your.tag', null))` for a value
   default), or handle the error. Lowering a count? Lower the baseline here in the same commit. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..', 'sidecar');

// the swallow class: .catch( () => {} ) / .catch(e => null) / => undefined / 0 / false — one silent
// constant-result handler, any single-identifier arg, with or without parens. Matches comments too;
// the baseline includes the two historical comment mentions on purpose (deleting them only lowers counts).
const SILENT_CATCH = /\.catch\(\s*\(?\s*_?\w*\s*\)?\s*=>\s*(\{\s*\}|null|undefined|0|false)\s*\)/g;

/* Audited baseline (forward-slash paths relative to sidecar/). Every file not listed must be CLEAN. */
const BASELINE = {
  'acp/serve.js': 1,                  // run-cancel relay on an already-torn-down session
  'channels/hub.js': 3,               // reaction cosmetics + message delete (documented best-effort)
  'index.js': 11,                     // shutdown reaps, inputGuard diagnostics, value defaults, 1 comment
  'local-voice.js': 2,                // ASR/TTS serialization tails (the queued run carries its own errors)
  'loopjob-driver.js': 1,             // snapshot degrade -> loopcheck already treats null as "cannot prove"
  'lsp-manager.js': 3,                // idle-close / pid-pin / closeAll teardown
  'mcp/manager.js': 1,                // connect() re-arms scheduleReconnect on failure (self-healing)
  'mcp/serve.js': 3,                  // SSE starts; the 3s reconnect timer re-arms on failure
  'mcp/transport.http.js': 1,         // best-effort MCP session DELETE on close
  'media-service.js': 1,              // voice-cache eviction (retried every 32 misses)
  'procledger.js': 1,                 // opportunistic pid identity pin (probe dedupes)
  'providers/anthropic.js': 1,        // catalog warm; a later call retries
  'providers/gemini.js': 1,           // catalog warm; a later call retries
  'providers/openai-compatible.js': 1,// catalog warm; a later call retries
  'providers/openrouter.js': 1,       // catalog warm; a later call retries
  'providers/provider.js': 2,         // reader.cancel() on timeout/abort teardown
  'shellbg.js': 1,                    // opportunistic pid identity pin (fail-closed to cmd matching)
  'spotify/store.js': 1,              // r.json() value default on an error body
  'terminal-sessions.js': 1,          // opportunistic pid identity pin
  'tools/builtin/browser.js': 9,      // CDP best-effort sends on adopt/close/failRequest seams
  'tools/builtin/image.js': 1,        // r.json() value default
  'tools/builtin/orchestration.js': 1,// pending-promise guard (result read elsewhere)
  'tools/builtin/webreader.js': 1,    // debugger session close on teardown
};

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);
A.ok(files.length > 50, 'scanner sees the sidecar tree (' + files.length + ' js files)');

let totalOver = 0;
const seen = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const src = fs.readFileSync(f, 'utf8');
  const n = (src.match(SILENT_CATCH) || []).length;
  seen[rel] = n;
  const cap = BASELINE[rel] || 0;
  if (n > cap) {
    totalOver++;
    A.ok(false, rel + ' has ' + n + ' bare silent catch(es), baseline allows ' + cap +
      ' — wrap the new one(s) in swallow(tag) from sidecar/failopen.js instead of a silent handler');
  }
}
A.eq(totalOver, 0, 'no sidecar file exceeds its audited silent-catch baseline');

// the ratchet's own hygiene: a baseline row for a deleted/renamed file is stale — prune it so the
// lock list stays a truthful map of the audited surface.
for (const rel of Object.keys(BASELINE)) {
  A.ok(rel in seen, 'baseline row exists on disk: ' + rel + ' (file moved/deleted? prune the row)');
}

// helper presence: the alternative this test points authors at must actually exist and load.
A.notThrows(() => require('../sidecar/failopen.js').swallow('ratchet.selftest'), 'failopen helper loads');

/* ============================================================================================
   PART 2 — the SYNC class (2026-08-21): `try { ... } catch (_) {}` / `catch {}` with an EMPTY body
   (whitespace- or comment-only). The 08-19 sweep ratcheted the promise form and explicitly left
   ~900 sync empties un-ratcheted. The highest-value subsystems (loop, stores, providers, channels,
   cron, tools/registry) were hand-audited: 52 sites that hid a failure someone would want to know
   about were rewired to failNote(tag, e) (= failopen.note); the remainder in those files are
   legitimately silent (value defaults, best-effort teardown, bus/console wrappers, self-re-arming
   retries) and are CAPPED at their audited count. Every other sidecar file is baselined at its
   current count so nothing NEW can be added silently anywhere. Counts only ratchet DOWN; when you
   lower one, lower the row in the same commit; a deleted file's stale row fails the test.
   Matches in comments/strings count too (same convention as PART 1 — deleting them only lowers counts). */

// not preceded by `.` (promise .catch(...)), optional single-identifier binding, body = only whitespace and comments
const EMPTY_SYNC_CATCH = /(?<![.\w$])catch\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\s*\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}/g;
function countSync(src) { return (String(src).match(EMPTY_SYNC_CATCH) || []).length; }

// ---- the detector against fixtures (a ratchet whose regex is wrong locks the wrong thing) ----
A.eq(countSync('try { a(); } catch (e) {}'), 1, 'detects catch (e) {}');
A.eq(countSync('try { a(); } catch (_) { }'), 1, 'detects catch (_) { } with inner whitespace');
A.eq(countSync('try { a(); } catch {}'), 1, 'detects optional-binding catch {}');
A.eq(countSync('try { a(); } catch (err) {\n  // nothing to do\n}'), 1, 'detects a line-comment-only body');
A.eq(countSync('try { a(); } catch (_) { /* best effort */ }'), 1, 'detects a block-comment-only body');
A.eq(countSync('try { a(); } catch (_) { /* a */ // b\n /* c */ }'), 1, 'detects a mixed comment-only body');
A.eq(countSync('try { a(); } catch (e) { failNote("t", e); }'), 0, 'a body that notes is NOT empty');
A.eq(countSync('try { a(); } catch (e) { x = null; }'), 0, 'a body that does something is NOT empty');
A.eq(countSync('try { a(); } catch (e) { /* why */ return null; }'), 0, 'comment + statement is NOT empty');
A.eq(countSync('p.catch(() => {})'), 0, 'the promise form belongs to PART 1, not this detector');
A.eq(countSync('p.catch(_ => {})'), 0, 'promise form without parens is not matched either');
A.eq(countSync('const unmatched = {}; if (x) {}'), 0, 'an empty non-catch block is not matched');
A.eq(countSync('try { a(); } catch (e) {} finally { b(); }'), 1, 'an empty catch followed by finally still counts');
A.eq(countSync('try { a(); } catch ({ message }) {}'), 0, 'destructured bindings are out of scope (none exist in sidecar/; documented limit)');
// the guard's own guard file: failopen.js carries exactly the swallow() console.warn shield + one doc mention
A.eq(countSync(fs.readFileSync(path.join(ROOT, 'failopen.js'), 'utf8')), 2, 'failopen.js itself: swallow() warn shield + note() doc mention, nothing more');

/* Audited SYNC baseline (forward-slash paths relative to sidecar/). AUDITED rows are hard caps with the
   remaining sites classified; all other rows are the as-found count on 2026-08-21 (not yet hand-audited:
   lower them as you touch the file). Every file not listed must be CLEAN. */
const SYNC_BASELINE = {
  'acp/core.js': 1,
  'acp/serve.js': 4,
  'artifacts.js': 2,
  'autonomy-ledger.js': 1,
  'autonotify.js': 2,
  'budget.js': 1,
  'channels/adapter.js': 5,
  'channels/discord.gateway.js': 10,
  'channels/discord.transport.js': 3,
  'channels/hub.js': 41,   // AUDITED — 41 left: emit() bus wrappers, console.* wrappers, best-effort deletes/edits/acks, timer clears, aborts, host observer callbacks, loadHistory value defaults
  'channels/proxy-fetch.js': 1,
  'channels/signal.transport.js': 2,
  'channels/slack.transport.js': 8,
  'channels/sse.js': 2,
  'channels/store.js': 2,   // AUDITED — 2 left: ensureRoot mkdir, onRecover observer
  'channels/telegram.transport.js': 4,
  'checkpoint-store.js': 12,   // AUDITED — 12 left: realpath/stat/readdir value defaults, .bak staging, gc best-effort, dw loader fallback
  'configexport.js': 0,
  'consentwait.js': 1,
  'credits-link.js': 2,
  'credits.js': 3,
  'cron-driver.js': 16,   // AUDITED — 16 left: emit() wrappers, warn wrapper, abort on stale lease / E-STOP (ratcheted down: the fire loop's swallowed throw now records a real failure, bug-sweep 2026-08-28)
  'cron-lock.js': 4,   // AUDITED — 4 left: fd close / unlink / release teardown
  'deliverable-store.js': 3,   // AUDITED — 3 left: journal absent on first load, fd close in finally, stat size default
  'domain-store.js': 1,
  'durable-store.js': 3,   // AUDITED — corrupt-primary parse probe / mkdir before a write that fails loudly itself (x2); backup failures now propagate
  'durable-write.js': 3,
  'edgetts.js': 3,
  'environment.js': 15,
  'execution-router.js': 1,
  'execution-settings.js': 1,
  'failopen.js': 2,
  'folderpick.js': 1,
  'halt.js': 1,
  'harness-import.js': 1,
  'http-body.js': 2,
  'index.js': 371,
  'ledger.js': 1,
  'logbound.js': 2,
  'loop.js': 2,   // AUDITED — 2 left: aborted sleep() during retry backoff (x2)
  'loopjob-driver.js': 10,
  'lsp-manager.js': 10,
  'mcp/client.js': 1,
  'mcp/manager.js': 13,
  'mcp/oauth.js': 2,
  'mcp/serve.js': 5,
  'mcp/translate.js': 1,
  'mcp/transport.http.js': 5,
  'mcp/transport.stdio.js': 5,
  'media-service.js': 21,
  'native-stt.js': 1,
  'nightshift-driver.js': 6,
  'openai-compat.js': 18,
  'output-artifacts.js': 2,
  'pathtrust.js': 2,
  'plugins.js': 1,
  'providers/anthropic.js': 1,
  'providers/codex-auth.js': 2,
  'providers/codex-token-store.js': 1,
  'providers/codex.js': 3,
  'providers/gemini.js': 1,
  'providers/liveprices.js': 3,
  'providers/oauth-device.js': 2,
  'providers/openrouter.js': 1,
  'providers/prices.js': 1,
  'providers/provider.js': 5,
  'providers/ratelimits.js': 1,   // AUDITED — 1 left: headers.get fall-through
  'questsweeps.js': 1,
  'routing/chain.js': 1,
  'run-journal.js': 7,
  'runroute.js': 2,
  'savestore.js': 7,   // AUDITED — 7 left: ensureRoot, stale .corrupt target unlink, fd close in finally, .bak staging (x2), warn wrappers (x2)
  'servicekeys.js': 1,
  'shellbg.js': 8,
  'shellhooks.js': 4,
  'skillreview.js': 2,
  'skills/catalog.js': 1,
  'skills/metrics.js': 1,
  'skills/package.js': 3,
  'skills/prefs.js': 2,
  'skills/registry.js': 1,
  'skillstore.js': 3,   // AUDITED — 3 left: corrupt log -> empty library (documented), digest stamp, history view projection
  'slash-actions.js': 1,
  'station-bridge.js': 2,
  'station-recovery.js': 3,
  'subagents.js': 10,
  'taskbrief-tools.js': 3,
  'terminal-sessions.js': 3,
  'tools/builtin/browser.js': 46,
  'tools/builtin/code.js': 3,
  'tools/builtin/comms.js': 2,
  'tools/builtin/connectors.js': 2,
  'tools/builtin/fs.js': 3,
  'tools/builtin/notebook.js': 1,
  'tools/builtin/orchestration.js': 8,
  'tools/builtin/quests.js': 1,
  'tools/builtin/shell.js': 12,
  'tools/builtin/skills.js': 4,
  'tools/builtin/spotify.js': 1,
  'tools/builtin/terminal.js': 2,
  'tools/builtin/verify.js': 2,
  'tools/builtin/web.js': 2,
  'tools/builtin/webreader.js': 3,
  'tools/builtin/win32desktop.js': 1,
  'tools/registry.js': 3,   // AUDITED — 3 left: abort-listener attach/detach, abort() in timeout
  'transcript-history.js': 7,
  'transcriptstore.js': 2,   // AUDITED — 2 left: frozen message marker, tool_calls JSON value default
  'update-preparation.js': 4,
  'workspace-lease.js': 2,
  'workspace-lineage.js': 1,
  'workspace-owner.js': 3,
  'workspace-recovery.js': 9,
};

let syncOver = 0;
const syncSeen = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const n = countSync(fs.readFileSync(f, 'utf8'));
  syncSeen[rel] = n;
  const cap = SYNC_BASELINE[rel] || 0;
  if (n > cap) {
    syncOver++;
    A.ok(false, rel + ' has ' + n + ' empty sync catch block(s), baseline allows ' + cap +
      " — route the new one(s) through failNote(tag, e) (sidecar/failopen.js note()) or handle the error; a catch whose silence is the DESIGN must be argued in a comment AND still lowers nothing here");
  }
}
A.eq(syncOver, 0, 'no sidecar file exceeds its audited empty-sync-catch baseline');
for (const rel of Object.keys(SYNC_BASELINE)) {
  A.ok(rel in syncSeen, 'sync baseline row exists on disk: ' + rel + ' (file moved/deleted? prune the row)');
}
// a baseline that is ABOVE reality is a silent slack the next author would spend: every row must be exact.
let slack = 0;
for (const rel of Object.keys(SYNC_BASELINE)) { if ((syncSeen[rel] || 0) < SYNC_BASELINE[rel]) { slack++; A.ok(false, rel + ' sync baseline ' + SYNC_BASELINE[rel] + ' > actual ' + (syncSeen[rel] || 0) + ' — lower the row (ratchet DOWN in the same commit)'); } }
A.eq(slack, 0, 'every sync baseline row equals the on-disk count (no slack to spend)');
// the helper the message points at
A.notThrows(() => require('../sidecar/failopen.js').note('ratchet.selftest.sync', new Error('x')), 'failopen.note loads and fires');

A.report('fail-open ratchet');
