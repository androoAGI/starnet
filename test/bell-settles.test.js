/* test/bell-settles.test.js — every NEEDS YOU line the bell keeps also LEAVES it when its wait is over (sweep 2026-10-02).

   The 0.13 bell keeps "needs" entries until settleNotifs(key) marks them handled. Three kinds were added with no settle, so the badge
   stayed lit for good once they fired (MARK ALL READ skips waiting entries; only ✕ removed them):
     · STEP-IN "needs you to sign in" (stepin.js) — and its line had no destination, so the bell could not open it either;
     · "∞ loop results are waiting on your review" (windows/loops.js);
     · "N extensions awaiting your approval" (app.js, settled from windows/connectors.js once nothing is pending). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

(async () => {
  // STEP-IN, for real: a handoff that ended (handed back, cancelled, expired) settles its bell line — on the live event and on a
  // refresh that finds it already over (it ended while the page was away, or before a restart)
  const settled = [], notes = [];
  let reply = { ok: true, live: [], recent: [{ id: 'h-old', state: 'returned', agentId: 'nova' }] };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, JSON,
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve(reply) }),
    StationUI: { settleNotifs: k => settled.push(k), notify: (t, c, cat, o) => notes.push(o), h: { present: [] } } });
  require('./helpers/frontend-esc.js').installEsc(ctx);
  vm.runInContext(rd('frontend/app/stepin.js') + '\n;this.__StepIn = StepIn;', ctx, { filename: 'stepin.js' });
  const S = ctx.__StepIn;
  await S.refresh();
  A.ok(settled.indexOf('stepin-h-old') >= 0, 'a handoff found already over on refresh settles its bell line: ' + JSON.stringify(settled));
  const si = rd('frontend/app/stepin.js');
  A.ok(/if \(ended\) \{ recent\.unshift\(p\); recent = recent\.slice\(0, 8\); settle\(p\.id\); \}/.test(si), 'a handoff that ends live (the browser.handoff event) settles its line too');
  A.ok(/key: 'stepin-' \+ p\.id, kind: 'needs', go: \{ term: 'stepin' \}/.test(si), 'the STEP-IN line has a destination, so the bell can open it');
  A.ok(/registerWindow\('stepin'/.test(si), '…and that destination is a real window');

  // loops: every result reviewed settles "waiting on your review"
  const lp = rd('frontend/app/windows/loops.js');
  A.ok(/paintBadge\(waiting\);[\s\S]{0,200}if \(!waiting && typeof StationUI !== 'undefined' && StationUI\.settleNotifs\) StationUI\.settleNotifs\('loops-review'\);/.test(lp), 'the loops watcher settles loops-review once nothing waits');
  A.ok(/key: 'loops-review'/.test(lp), '…the same key it notified under');

  // extensions: the extensions list finding nothing pending settles "awaiting your approval"
  const cn = rd('frontend/app/windows/connectors.js'), app = rd('frontend/app/app.js');
  A.ok(/key: 'extensions-pending'/.test(app), 'fixture: the app notifies under extensions-pending');
  A.ok(/if \(hooks && plugins && !\(\(hooks\.pending \|\| \[\]\)\.length \+ plugins\.plugins\.filter\(x => x && x\.pending\)\.length\)[\s\S]{0,120}StationUI\.settleNotifs\('extensions-pending'\)/.test(cn), 'the extensions list settles it once both reads say nothing is pending (a failed read never settles it)');

  // a background run that made a file AND ends asking something still puts its question in NEEDS YOU ("made X" alone hid it)
  const ch = rd('frontend/app/chat.js');
  A.ok(/!\(thisRunId && notedRuns\.has\(thisRunId\) && !taskQuestion && chipOc !== 'asked'\)/.test(ch), 'a run that already announced a file is skipped only when it does NOT end on a question');

  // B5: a prompt answered ANYWHERE (desk, phone, Telegram, voice — permission.response on the bus) settles its bell entry;
  // R8: re-rendering a pending prompt (reopening its session) never re-announces it
  A.eq((ch.match(/!announcedPrompt\(/g) || []).length, 4, 'the approval card, question card, delegated worker row and background approval each guard prompt announcements');
  A.eq((ch.match(/key: 'needs:' \+ ws\.id, prompt: /g) || []).length, 4, '…and file each path with its promptId');
  // Execute the shared guard and settlement listener: the same worker prompt may arrive as a new
  // payload object or be redrawn on another surface, but it still owns one parent-session bell key.
  // Run the complete production dependency chain and let listener errors fail the test.
  const promptHandlers = [], promptSettled = [], promptNotified = [];
  const promptBus = { on: (name, fn) => { if (name === 'permission.response') promptHandlers.push(fn); },
    emit: (_name, value) => { for (const fn of promptHandlers) fn(value); } };
  const Channels = require('../frontend/app/channels.js'); Channels.reset();
  const promptStart = ch.indexOf('  const promptNeeds = new Map();');
  const promptEnd = ch.indexOf('  function backgroundPermissionNotify(', promptStart);
  const settleStart = ch.indexOf('  const settledPromptNotices = new Set();');
  const settleEnd = ch.indexOf('  async function answerConsent(', settleStart);
  A.ok(promptStart >= 0 && promptEnd > promptStart && settleStart >= 0 && settleEnd > settleStart, 'complete prompt guard, settlement helper and listener are present');
  const promptCtx = vm.createContext({ U: { bus: promptBus }, Channels,
    askerName: p => p.workerAgentId || 'worker', actionPhrase: () => 'write a file',
    StationUI: { settleNotifs: key => promptSettled.push(key), notify: (_text, _cls, _category, opts) => promptNotified.push(opts) } });
  vm.runInContext(ch.slice(settleStart, settleEnd) + ch.slice(promptStart, promptEnd) + '\n;this.__announcedPrompt = announcedPrompt;', promptCtx);
  A.eq(promptHandlers.length, 1, 'one shared prompt-response listener is registered');
  A.eq(promptCtx.__announcedPrompt('worker-prompt', { id: 'parent' }), false, 'a worker prompt is announced on its first arrival');
  A.eq(promptCtx.__announcedPrompt('worker-prompt', { id: 'parent' }), true, 'a copied payload cannot announce that prompt again');
  A.eq(promptCtx.__announcedPrompt('worker-prompt', { id: 'other' }), true, 'another surface cannot refile the prompt under another session');
  A.eq(promptCtx.__announcedPrompt('next-prompt', { id: 'other' }), false, 'a different prompt gets its own announcement');
  Channels.setPending('parent', { promptId: 'worker-prompt' });
  Channels.setPending('other', { promptId: 'next-prompt' });
  promptBus.emit('permission.response', { promptId: 'worker-prompt' });
  A.eq(promptSettled, ['needs:parent'], 'a confirmed response settles its original parent without a mounted card');
  A.eq(Channels.pendingAllOf('parent'), [], 'the background prompt leaves its original channel');
  A.eq(Channels.pendingAllOf('other').map(p => p.promptId), ['next-prompt'], 'a response cannot clear another conversation');
  promptBus.emit('permission.response', { promptId: 'unknown-prompt' });
  promptBus.emit('permission.response', {});
  promptBus.emit('permission.response', { promptId: 'worker-prompt' });
  A.eq(promptSettled, ['needs:parent'], 'unknown, missing and duplicate responses cannot settle unrelated entries');
  A.eq(Channels.pendingAllOf('other').map(p => p.promptId), ['next-prompt'], 'negative responses preserve unrelated pending state');
  A.eq(promptCtx.__announcedPrompt('worker-prompt', { id: 'parent' }), true, 'late rendering cannot re-announce a settled prompt');
  for (const id of ['mira', 'rook']) {
    Channels.setPending('siblings', { promptId: id, workerAgentId: id, tool: 'fs.write' });
    promptCtx.__announcedPrompt(id, { id: 'siblings' });
  }
  promptBus.emit('permission.response', { promptId: 'mira' });
  A.eq(Channels.pendingAllOf('siblings').map(p => p.promptId), ['rook'], 'a remote response removes exactly one background sibling');
  A.eq(promptNotified.map(n => [n.prompt, n.go.ws]), [['rook', 'siblings']], 'the bell keeps the actual remaining sibling in its original conversation');
  promptBus.emit('permission.response', { promptId: 'mira' });
  A.eq(promptNotified.length, 1, 'a duplicate does not re-notify the sibling');
  promptBus.emit('permission.response', { promptId: 'rook' });
  A.eq(Channels.pendingAllOf('siblings'), [], 'the final remote response clears the last background prompt');
  A.eq(promptSettled, ['needs:parent', 'needs:siblings'], 'the last sibling settles its bell without resurrecting the first');
  // B4: a prompt entry from an earlier page life (reload / restart: desk runs die with the page) leaves NEEDS YOU
  const su = rd('frontend/app/stationui.js');
  A.ok(/r\.kind === 'needs' && !r\.done && r\.prompt && r\.life !== NOTIF_LIFE\) \{ r\.done = true; r\.read = true;/.test(su) && /if \(opts && opts\.prompt\) \{ rec\.prompt = String\(opts\.prompt\); rec\.life = NOTIF_LIFE; \}/.test(su), 'a prompt entry raised before this page life is marked handled');
  A.ok(/function buildNotifs\(body\) \{\s*pruneLegacyNotifs\(\);\s*reapDeadPrompts\(\);/.test(su) && /function badges\(\) \{\s*reapDeadPrompts\(\);/.test(su), '…before the bell or its badge is drawn');
  A.ok(/for \(const k of StationUI\.waitingNotifKeys\('stepin-'\)\) if \(!live\.some\(h => 'stepin-' \+ h\.id === k\)\) StationUI\.settleNotifs\(k\);/.test(si), 'a STEP-IN line for a handoff the station no longer has is settled');
  A.ok(/if \(!waiting\) \{ if \(StationUI\.settleNotifs\) StationUI\.settleNotifs\('extensions-pending'\); return; \}/.test(app), 'boot settles extensions-pending when nothing waits any more');
  // R9: a notification for a deleted session keeps the bell and says so
  A.ok(/if \(go\.ws && typeof Workstreams !== 'undefined' && Workstreams\.get && !Workstreams\.get\(go\.ws\)\) \{ toast\('that session was deleted', 'warn'\); return false; \}/.test(su), 'a deleted session: the bell stays and says so');
  // B6: a routine completing opens where its result is, never TO REVIEW — since 2026-10-09 that is the run's OWN
  // session (one click to the result, and opening it settles the bell via seenSession); AUTOMATE › ROUTINES only when
  // the event names no run
  const wd = rd('frontend/app/world.js');
  A.ok(/const ses = p\.runId \? \{ ws: 'cron-' \+ p\.runId \} : \{ term: 'automation', section: 'routines' \};/.test(wd)
    && /hudNote\('◷ routine completed', 'good', \{ go: ses \}, 'cronDigest'\)/.test(wd), '"routine completed" opens that run\'s own session');

  A.report('bell-settles.test');
})().catch(e => { console.error(e); process.exit(1); });
