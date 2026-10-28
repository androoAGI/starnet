'use strict';
/* node test/needs-you-one-list.test.js — ONE NEEDS YOU (org pass P01, 2026-10-14).
   Before: the rail's NEEDS YOU read live state while NOTIFICATIONS › NEEDS YOU read the bell's stored entries, so the two
   counts disagreed; STEP-IN, extensions and loop reviews showed only in the bell; builds that need a decision and quests
   an agent says are done showed in neither. Clearing NEEDS YOU did not mean nothing was waiting.
   GENUINE (executed): NeedsYou.items lists every blocking wait from its OWN live source — STEP-IN (StepIn.live), a quest
   attest (QuestLedgerStore.pendingAttests), goal-loop reviews (LoopsReview.waiting), extensions and builds (the sidecar's
   /api/hooks + /api/plugins and WorkshopStore.pendingAll) — each with its existing action words and door; a background
   worker's ask is one row (Channels), never two; TO REVIEW and PROPOSALS are never listed. StationUI's buildNotifs renders
   that SAME list as NOTIFICATIONS › NEEDS YOU (tag NEEDS YOU, OPEN and Dismiss by the rail's rules) and the bell badge adds
   the live count to the unread history, never one instead of the other.
   A STORED wait with no live source (a background conversation's finished reply asked a question: chat.js 'needs:<ws>') is
   a row of BOTH lists (StationUI.storedWaits) until it settles — its conversation opened (OPEN here, or any route through
   seenSession), or, with no conversation to open, dismissed — never a second row beside a live ask in the same
   conversation, never in the history while it waits, counted on the bell once. */
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const NOW = 50 * 86400000;
global.localStorage = { getItem: () => null, setItem() {} };
global.document = undefined;
const sessions = new Map([['home', { id: 'home', title: null, agentId: 'agent' }], ['other', { id: 'other', title: 'Launch plan', agentId: 'agent' }]]);
const deleted = new Set();   // sessions the Commander deleted (Workstreams' tombstones)
global.Workstreams = { get: id => sessions.get(id) || null, list: () => [...sessions.values()], unread: () => false, generalId: () => 'home', isDeleted: id => deleted.has(id) };
global.App = { agentName: id => ({ agent: 'NOVA', writer: 'VEX', researcher: 'MIRA', designer: 'ROOK' })[id] || id, openWorkstream: id => opened.push(['ws', id]) };
global.Chat = { consentPhrase: p => String(p.tool), consentInspect: () => null };
const opened = [];
// a background worker's ask: filed into Channels by the lead (final-approval-truth) — it must be ONE row
global.Channels = { allPending: () => [{ wsId: 'home', p: { promptId: 'bg1', tool: 'fs.read', workerAgentId: 'writer', workerStreamId: 'thread_vex', background: true, askedAt: NOW - 50000 } }] };
global.StepIn = { live: () => [{ id: 'h1', agentId: 'researcher', reason: 'login', where: 'github.com', state: 'waiting', requestedAt: NOW - 40000 }], open: id => opened.push(['stepin', id]) };
let confirmed = [];
global.QuestLedgerStore = {
  pendingAttests: () => [{ id: 'q7', title: 'Ship the landing page', status: 'open', attest: { agentId: 'designer', evidence: 'deployed to /landing', at: NOW - 30000 } }],
  confirm: async (id, ok) => { confirmed.push([id, ok]); return { ok: true }; }
};
global.LoopsReview = { waiting: () => [{ id: 'L1', name: 'Tidy the docs', agentId: 'agent', count: 2, since: NOW - 20000 }] };
// the sidecar-backed waits: builds (per agent) and extensions — answered by the station
// …and the build's own session: ensureSession's contract (adopt it and return its id; null when the Commander deleted it, as
// Workstreams.adopt refuses a tombstone), with the store's own id and name for it (workshopstore.js, run for real)
const Shop = require('../frontend/app/workshopstore.js').WorkshopStore;
const ensured = [];
global.WorkshopStore = { pendingAll: async () => [{ runId: 'b1', agentId: 'writer', title: 'Pricing page v2', builtAt: NOW - 10000 }], pendingAllOk: () => true,
  ensureSession: m => { ensured.push(m.runId); const id = 'workshop-' + m.runId; return deleted.has(id) ? null : id; },
  sessionIdOf: Shop.sessionIdOf, sessionTitleOf: Shop.sessionTitleOf };
// NOT waits: the optional TO REVIEW pile and PROPOSALS — present on the page, never listed
global.AutoJobStore = { pendingList: () => [{ id: 'prop1', title: 'A proposed routine' }] };
const fetched = [];
global.fetch = async url => { fetched.push(url); return { ok: true, json: async () => url === '/api/hooks' ? { hooks: [], pending: [{ event: 'on_session_end', command: 'x' }] } : { plugins: [{ id: 'p', pending: true }, { id: 'q', pending: false }] } }; };
const ui = { terms: [], notes: [], rer: [] };
global.StationUI = { openTerm: (k, s) => ui.terms.push([k, s || null]), notify: (t, c) => ui.notes.push([t, c]), rerender: k => ui.rer.push(k), badges() {} };
let shownStatus = null;
global.Deliverables = { showStatus: (body, st) => { shownStatus = st; return true; } };
global.Delegated = require('../frontend/app/delegated.js');
const NY = require('../frontend/app/needsyou.js');

(async () => {
  // the feeds are a sidecar read: the first items() call starts it, the list follows when it answers
  NY.items(NOW);
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  A.ok(fetched.includes('/api/hooks') && fetched.includes('/api/plugins'), 'extensions are read from the sidecar (hooks + plugins), never the bell');
  const list = NY.items(NOW);
  const byKind = k => list.filter(i => i.kind === k);
  A.eq(list.map(i => i.kind).join(','), 'approval,stepin,attest,loop,build,extension', 'every blocking wait, one list: the timed ask first, then STEP-IN, then the station waits oldest first (an untimed extension last, never above the approval)');
  A.eq(byKind('approval').length, 1, 'a background worker\'s ask is one row (its Channels ask), never added twice');
  A.ok(!list.some(i => /prop1|review/i.test(i.key)), 'TO REVIEW and PROPOSALS are optional piles, never NEEDS YOU');
  const step = byKind('stepin')[0];
  A.eq([step.who, step.what, step.where].join(' | '), 'MIRA | needs you to sign in at github.com | STEP-IN', 'STEP-IN: who, what exactly, where');
  const att = byKind('attest')[0];
  A.eq([att.who, att.what, att.where].join(' | '), 'ROOK | says "Ship the landing page" is done | QUESTS', 'a quest an agent says is done');
  A.eq(att.tip, 'deployed to /landing', 'its evidence rides the row\'s tip');
  A.eq(byKind('loop')[0].what, 'has 2 results waiting on your review from "Tidy the docs"', 'goal-loop results waiting on review (who + a verb)');
  A.eq(byKind('extension')[0].what, 'has 2 extensions awaiting your approval', 'extensions awaiting approval (1 hook + 1 plugin), read as STATION has …');
  // (two reviews 10-16) a build row said "in DELIVERABLES" while its door opened the build's own session: it names the place
  // the click lands, by the name the SESSIONS rail gives that session
  A.eq([byKind('build')[0].who, byKind('build')[0].what, byKind('build')[0].where].join(' | '), 'VEX | built "Pricing page v2": keep or discard it | Pricing page v2', 'a build that needs a decision, in its own session (named as the rail names it)');
  A.ok(!ensured.length, '…read only: naming the place never adopts the session (the click does)');

  // each keeps its existing action words
  const k = NY._internals.keysFor;
  const keys = i => [...k(i).matchAll(/data-ny-act="([a-z-]+)"[^>]*>([^<]+)</g)].map(m => m[1] + ':' + m[2]).join(' · ');
  // (Andrew 10-15) the row is the door: a wait whose only action was Open has no key (a click on its row opens it)
  A.eq(keys(step), '', 'STEP-IN → no key, its row opens it');
  // (Andrew 10-19, the inbox: "keep only the safe one-tap actions") a quest's verdict is given on the QUESTS card the row opens
  A.eq(keys(att), '', 'a quest attest → no key, its row opens the QUESTS card where its verdict is given');
  A.eq(keys(byKind('loop')[0]), '', 'loop review → no key, its row opens it');
  A.eq(keys(byKind('extension')[0]), '', 'extensions → no key, its row opens it');
  A.eq(keys(byKind('build')[0]), '', 'a build → no key, its row opens it');
  const buildRow = NY._internals.html([byKind('build')[0]], NOW);
  A.ok(!/class="ny-keys"/.test(buildRow) && /<span class="ny-verb">keep or discard<\/span> · Pricing page v2/.test(buildRow), 'a build row leads with its ask and carries no empty key strip');
  // (Andrew 10-15, premium pass) one agent's builds are ONE card, never the same line repeated per build
  const b0 = byKind('build')[0], twoBuilds = NY._internals.html([b0, Object.assign({}, b0, { key: 'build:b2', since: (b0.since || NOW) + 1000, rail: { verb: 'keep or discard', text: 'Pricing page v3' } })], NOW);
  A.eq((twoBuilds.match(/class="ny-item /g) || []).length, 1, 'two builds from one agent are one card');
  A.ok(/<span class="ny-verb">2 builds to keep or discard<\/span> · Pricing page v2<\/div>/.test(twoBuilds) && /<span class="ny-count">2<\/span>/.test(twoBuilds) && /data-ny-n="2"/.test(twoBuilds),
    '…that leads with how many wait (where the two-line clamp cannot cut it), names the build its click opens (the oldest), and holds both waits');
  A.ok(/<span class="ny-face" aria-hidden="true" data-ny-aid="writer">/.test(twoBuilds) && /<span class="ny-grp-t">Builds to review<\/span><span class="ny-grp-n">2<\/span>/.test(twoBuilds) && !/ny-strip/.test(twoBuilds),
    '…with VEX\'s portrait, under the BUILDS TO REVIEW strip that counts both (Andrew 10-19, B: one panel by kind)');

  // the doors
  NY.openKey('stepin:h1'); A.eq(opened.pop(), ['stepin', 'h1'], 'STEP-IN opens its window on THAT handoff');
  NY.openKey('extensions'); A.eq(ui.terms.pop(), ['connectors', 'extensions'], 'extensions open ABILITIES › EXTENSIONS');
  NY.openKey(att.key); A.eq(ui.terms.pop(), ['quests', 'available'], 'a quest attest opens QUESTS on NOW, where its confirm lives (PASS leads the log)');
  NY.openKey('loop:L1'); A.eq(ui.terms.pop(), ['loops', null], 'loop results open GOAL LOOPS');
  A.ok(!opened.length, 'none of them opens a conversation');
  // (Andrew 10-15: "it only takes you to deliverables … instead of where you are ACTUALLY needed") a build opens ITS OWN session,
  // where its keep/discard card is
  const termsBefore = ui.terms.length;
  A.eq(NY.openKey('build:b1'), { conversation: true }, 'a build opens its own session (NOTIFICATIONS steps aside for it)');
  A.eq(opened.pop(), ['ws', 'workshop-b1'], '…THAT build session, where its keep/discard card is');
  A.ok(ensured[0] === 'b1' && ui.terms.length === termsBefore, '…adopted through WorkshopStore, and DELIVERABLES is not opened');
  // only a build whose session cannot be had (the Commander deleted it: ensureSession returns null, adopt refuses the
  // tombstone) falls back to DELIVERABLES › NEEDS A DECISION, and its row names DELIVERABLES before the click
  deleted.add('workshop-b1');
  A.eq(NY.items(NOW).find(i => i.key === 'build:b1').where, 'DELIVERABLES', 'a build whose session was deleted names DELIVERABLES, where its door now goes');
  global.document = { querySelector: sel => sel === '#dl-status' ? { closest: () => ({}) } : null, hidden: false };
  ensured.length = 0;
  A.eq(NY.openKey('build:b1'), { conversation: false }, '…and opens DELIVERABLES, a window (NOTIFICATIONS keeps the focus there)');
  A.ok(ensured[0] === 'b1', '…after WorkshopStore said its session cannot be had (null)');
  A.eq(ui.terms.pop(), ['deliverables', null], '…the DELIVERABLES window');
  A.eq(shownStatus, 'pending', '…filtered to NEEDS A DECISION');
  A.ok(!opened.length, '…and no conversation');
  global.document = undefined;
  deleted.delete('workshop-b1');
  // what a door opened: NOTIFICATIONS steps aside (workConversation) only for a session, never over a window it just opened
  A.eq(NY.openKey('loop:L1'), { conversation: false }, 'a window door reports it opened a window, not a conversation'); ui.terms.pop();
  A.eq(NY.openKey('approval:nope'), false, 'an unknown key opens nothing');
  {
    const su0 = read('frontend/app/stationui.js');
    A.ok(/const did = NY && NY\.openKey\(el\.dataset\.nyKey\); if \(did && did\.conversation && open\.notifs\) workConversation\('notifs'\);/.test(su0),
      'NOTIFICATIONS › NEEDS YOU steps aside only when the row opened a conversation (a STEP-IN / EXTENSIONS / DELIVERABLES / QUESTS / GOAL LOOPS window keeps the focus)');
  }
  A.ok(!NY.dismissKey('stepin:h1') && !NY.dismissKey(att.key), 'a wait is never dismissed away — only failed work has Dismiss (as on the rail)');
  A.ok(NY.canDismiss({ kind: 'failed' }) && !NY.canDismiss(step), 'canDismiss follows the rail');

  // the rail gives no verdict: the QUESTS card does (its own Confirm / Not yet, through QuestLedgerStore.confirm)
  const hostless = NY._internals;
  A.ok(hostless, 'internals');
  {
    const src = read('frontend/app/needsyou.js');
    A.ok(!/QuestLedgerStore\.confirm/.test(src) && !/attest-yes|attest-no/.test(src), 'NEEDS YOU never confirms a quest itself: the verdict is the QUESTS card\'s');
  }

  // a forced re-read asked for while a read is on its way is never dropped: the earlier read may predate the decision
  {
    // settle the reads the doors above started (opening the build row forces one)
    for (let n = 0; n < 5; n++) { await NY.refreshFeeds(false); await new Promise(r => setTimeout(r, 0)); }
    const realFetch = global.fetch;
    let gate = null, pendingNow = 1;
    const answer = n => url => ({ ok: true, json: async () => url === '/api/hooks' ? { hooks: [], pending: Array.from({ length: n }, () => ({})) } : { plugins: [] } });
    global.fetch = url => { const n = pendingNow; return gate ? gate.then(() => answer(n)(url)) : Promise.resolve(answer(n)(url)); };
    let release; gate = new Promise(r => { release = r; });
    const first = NY.refreshFeeds(true);          // e.g. opening the row: leaves while 1 extension still waits
    pendingNow = 0;                               // …the Commander approves it while that read is still out
    const second = NY.refreshFeeds(true);
    A.ok(second && second !== first, 'a forced re-read during an in-flight read is queued, not handed the stale promise');
    A.eq(NY.refreshFeeds(true), second, 'several forced asks during one read share the one follow-up read');
    gate = null; release();
    await second;
    A.eq(NY._internals.feeds().extensions, 0, 'the row follows the decision at once (the follow-up read), not a minute later');
    global.fetch = realFetch;
    await NY.refreshFeeds(true);                  // back to the fixture's station (2 extensions waiting) for the rest
    const conn = read('frontend/app/windows/connectors.js');
    A.ok(/NeedsYou\.refreshFeeds\(true\)/.test(conn), 'approving / changing an extension in ABILITIES › EXTENSIONS re-reads NEEDS YOU at once');
  }

  // ---- NOTIFICATIONS › NEEDS YOU renders the SAME list; the bell adds the live count ----
  const su = read('frontend/app/stationui.js');
  const from = su.indexOf('  let notifView = \'all\';'), to = su.indexOf('  /* ============== periodic + save dot');
  A.ok(from > 0 && to > from, 'fixture: the NOTIFICATIONS window + bell');
  const badge = { textContent: '', style: { display: '' } };
  const body = { innerHTML: '', querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }) };
  const ctx = {
    NeedsYou: NY, store: { notifs: [
      // covered by a live row: the bell's stored entries for an approval (prompt), STEP-IN, extensions, loop reviews
      { id: 'n1', kind: 'needs', txt: 'VEX needs approval', prompt: 'bg1', key: 'needs:home', read: false, t: NOW - 50000 },
      { id: 'n2', kind: 'needs', txt: 'STEP-IN: MIRA', key: 'stepin-h1', read: false, t: NOW - 40000 },
      { id: 'n3', kind: 'needs', txt: '2 extensions', key: 'extensions-pending', read: false, t: NOW - 60000 },
      { id: 'n4', kind: 'needs', txt: 'loop results', key: 'loops-review', read: false, t: NOW - 20000 },
      // NO live source: a background conversation's finished reply that asked a question (chat.js, no prompt) — a NEEDS YOU
      // row itself, in both lists, until its conversation is opened
      { id: 'n5', kind: 'needs', txt: 'NOVA has a question for you — Launch plan', key: 'needs:other', go: { ws: 'other' }, read: false, t: NOW - 5000 },
      { id: 'n6', kind: 'result', txt: 'NOVA finished', read: false, t: NOW - 4000 },
      { id: 'n7', kind: 'result', txt: 'old news', read: true, t: NOW - 3000 },
      { id: 'n8', kind: 'needs', done: true, txt: 'answered', key: 'needs:x', read: true, t: NOW - 2000 }
    ] },
    open: {}, save() {}, uid: () => 'u', esc: s => String(s), severityOf: () => 'warn', SEV_GLYPH: { warn: '⚠', bad: '✗', good: '✓', gold: '★', info: '▸' },
    notifStamp: () => '[t]', reapDeadPrompts() {}, rerender() {}, sfx() {}, openNotif() {}, workConversation() {}, $: sel => sel === '#nf-badge' ? badge : null
  };
  vm.runInNewContext(su.slice(from, to) + '\nthis.api = { buildNotifs, badges, notifsMarkRead, storedWaits, settleStoredWait };', ctx);
  // NeedsYou reads the station's stored waits through StationUI, as on the page
  global.StationUI.storedWaits = ctx.api.storedWaits;
  global.StationUI.settleStoredWait = ctx.api.settleStoredWait;
  ctx.api.buildNotifs(body);
  const h = body.innerHTML;
  const needsSec = h.slice(h.indexOf('<section class="nf-needs">'), h.indexOf('</section>'));
  A.ok(/<h4 class="ms-h">NEEDS YOU <span class="dim">— 7 waiting<\/span><\/h4>/.test(needsSec), 'NOTIFICATIONS › NEEDS YOU counts what the rail counts (6 live + the stored question)');
  A.eq((needsSec.match(/class="nf [^"]*nf-live/g) || []).length, 7, 'one row per wait');
  A.ok(/data-ny-key="stepin:h1"/.test(needsSec) && /data-ny-key="build:b1"/.test(needsSec) && /data-ny-key="attest:q7@/.test(needsSec), 'STEP-IN, builds and quest attests are in it too');
  A.ok(/<span class="nf-kind">in STEP-IN<\/span>/.test(needsSec) && /<span class="nf-kind">in EXTENSIONS<\/span>/.test(needsSec) && !/<span class="nf-kind">NEEDS YOU</.test(needsSec) && !/Waiting on you/.test(h),
    'each row\'s tag says where it waits (the NEEDS YOU heading above already says what they are; never "Waiting on you")');
  A.ok(/<span class="nf-txt">MIRA needs you to sign in at github\.com<\/span>/.test(needsSec), 'the line is who + what, the place in the tag (never " · in STEP-IN" again)');
  A.ok(/data-ny-key="build:b1"[^>]*>[\s\S]{0,120}<span class="nf-kind">in Pricing page v2<\/span>/.test(needsSec), 'a build\'s row there names its own session too, where its OPEN lands');
  A.eq((needsSec.match(/OPEN ▸/g) || []).length, 7, 'every row is a door');
  A.ok(!/data-ny-dismiss/.test(needsSec), 'no Dismiss on a wait (only failed work, or a stored wait with no conversation left, has one)');
  A.ok(!/ title=/.test(needsSec), 'no native title tooltips on the new rows');
  // the stored question: a row of THIS section, in the station's own words (who + line, its conversation in the tag)
  A.ok(/data-ny-key="asked:n5"[^>]*>[\s\S]{0,200}<span class="nf-kind">in Launch plan<\/span>[\s\S]{0,200}<span class="nf-txt">NOVA has a question for you<\/span><span class="nf-go">OPEN ▸<\/span>/.test(needsSec),
    'a finished reply\'s question is a NEEDS YOU row: who + its line, "in <conversation>", OPEN');
  const hist = h.slice(h.indexOf('</section>'));
  A.ok(!/STEP-IN: MIRA|2 extensions|loop results|VEX needs approval/.test(hist), 'a stored entry a live row already shows is not listed twice');
  A.ok(!/NOVA has a question for you/.test(hist) && /answered/.test(hist), 'the stored question is not in the history while it waits; the handled history stays below');
  // only the live section says NEEDS YOU: a history row tagged NEEDS YOU below it (outside the section, absent from the rail)
  // contradicted the one-list promise (wiring review 2026-10-14)
  A.ok(!/<span class="nf-kind">NEEDS YOU</.test(hist) && !/Asked you/.test(hist), 'no history row carries the NEEDS YOU tag, and nothing waiting sits below as "Asked you"');
  A.ok(/>All · 10</.test(h) && />New · 8</.test(h), 'All / New count the NEEDS YOU rows plus the history (New = 7 waiting + 1 unread result)');
  ctx.api.badges();
  A.eq(badge.textContent, '8', 'the bell: unread history (1 result) PLUS the NEEDS YOU count (7, the stored question once) — never one instead of the other');
  A.eq(ctx.api.notifsMarkRead().waiting, 7, 'notifications.read reports what is really still waiting (the NEEDS YOU list)');
  A.eq(badge.textContent, '7', '…and reading the history never clears a wait off the bell');

  // ---- the rail lists the SAME stored question, and opening it settles it in both lists ----
  {
    const rail = NY.items(NOW);
    A.eq(rail.map(i => i.kind).join(','), 'approval,stepin,attest,loop,build,asked,extension', 'the rail lists the stored question with the station\'s other waits (it blocks no running conversation: never above an ask)');
    const q = rail.find(i => i.key === 'asked:n5');
    A.eq(q && [q.who, q.what, q.where, q.wsId].join(' | '), 'NOVA | has a question for you | Launch plan | other', 'the rail row: who, the line, "in <conversation>" (said once each)');
    A.eq(keys(q), '', 'no key: its row opens its conversation (a question in a reply is answered there)');
    A.ok(!NY.canDismiss(q) && !NY.dismissKey('asked:n5'), 'a stored wait with a conversation is never dismissed away: opening it settles it');
    A.eq(NY.openKey('asked:n5'), { conversation: true }, 'OPEN lands on its conversation (NOTIFICATIONS steps aside with a way back)');
    A.eq(opened.pop(), ['ws', 'other'], '…that conversation');
    const n5 = ctx.store.notifs.find(n => n.id === 'n5');
    A.ok(n5.done && n5.read && n5.opened, 'opening it settles the stored entry (done, read, and marked as opened)');
    A.ok(!NY.items(NOW).some(i => i.key === 'asked:n5'), 'settled: it leaves the rail\'s NEEDS YOU');
    ctx.api.buildNotifs(body);
    const h2 = body.innerHTML, sec2 = h2.slice(h2.indexOf('<section class="nf-needs">'), h2.indexOf('</section>')), hist2 = h2.slice(h2.indexOf('</section>'));
    A.ok(/— 6 waiting</.test(sec2) && !/asked:n5/.test(sec2), '…and NOTIFICATIONS › NEEDS YOU');
    A.ok(/<span class="nf-kind">Asked you<\/span>[\s\S]{0,200}NOVA has a question for you — Launch plan/.test(hist2), 'it stays in the history as what it was: Asked you (never "Handled": nobody answered it)');
    ctx.api.badges();
    A.eq(badge.textContent, '6', 'the bell drops it with the list (counted once, settled once)');
  }

  // ---- any route into its conversation settles it (the rail row, a toast, a station.show): seenSession ----
  {
    const sctx = { store: ctx.store, open: {}, save() {}, badges() {}, rerender() {} };
    vm.runInNewContext(A.fnBody(su, 'function seenSession(wsId)') + '\nthis.seenSession = seenSession;', sctx);
    ctx.store.notifs.push({ id: 'n10', kind: 'needs', txt: 'NOVA has a question for you — Launch plan', key: 'needs:other', go: { ws: 'other' }, read: false, t: NOW - 1500 });
    ctx.store.notifs.push({ id: 'n11', kind: 'needs', txt: 'NOVA wants to write a file', key: 'needs:other-ask', prompt: 'p-other', go: { ws: 'other' }, read: false, t: NOW - 1400 });
    A.ok(NY.items(NOW).some(i => i.key === 'asked:n10'), 'a new question in that conversation is a row again');
    sctx.seenSession('other');
    A.ok(ctx.store.notifs.find(n => n.id === 'n10').done, 'switching to its conversation by any route settles the question');
    A.ok(!ctx.store.notifs.find(n => n.id === 'n11').done, '…never an approval (a prompt): that waits until it is answered');
    A.ok(!NY.items(NOW).some(i => i.key === 'asked:n10'), 'and it leaves NEEDS YOU');
    ctx.store.notifs = ctx.store.notifs.filter(n => n.id !== 'n11');
  }

  // ---- one row per conversation: a live ask there already shows it waiting ----
  {
    ctx.store.notifs.push({ id: 'n12', kind: 'needs', txt: 'NOVA has a question for you', key: 'needs:home', go: { ws: 'home' }, read: false, t: NOW - 1200 });
    const list = NY.items(NOW);
    A.ok(!list.some(i => i.key === 'asked:n12') && list.filter(i => i.wsId === 'home' && i.kind === 'approval').length === 1, 'a stored question in a conversation a live ask already lists is that row, never a second one');
    ctx.api.buildNotifs(body);
    A.ok(!/NOVA has a question for you<\/span>/.test(body.innerHTML.slice(body.innerHTML.indexOf('</section>'))), '…and not in the history while it waits');
    ctx.api.badges();
    A.eq(badge.textContent, String(list.length), 'the bell counts that conversation once');
    ctx.store.notifs = ctx.store.notifs.filter(n => n.id !== 'n12');
  }

  // ---- a stored wait with no conversation to open (none named, or deleted since): its Dismiss settles it ----
  {
    ctx.store.notifs.push({ id: 'n13', kind: 'needs', txt: 'E2E agent waiting on you', key: 'e2e-needs', read: false, t: NOW - 1000 });
    const row = NY.items(NOW).find(i => i.key === 'asked:n13');
    A.ok(row && row.noDoor && row.where === 'NOTIFICATIONS' && row.who === '' && row.what === 'E2E agent waiting on you', 'it is a row too, in its own words, filed in NOTIFICATIONS');
    A.eq(keys(row), 'dismiss:Dismiss', 'no Open (nothing to open): only its Dismiss');
    ctx.api.buildNotifs(body);
    const sec = body.innerHTML.slice(body.innerHTML.indexOf('<section class="nf-needs">'), body.innerHTML.indexOf('</section>'));
    const r13 = (sec.match(/<div class="nf [^"]*" style="[^"]*" data-ny-key="asked:n13"[\s\S]*?<\/button><\/div>/) || [''])[0];
    A.ok(r13 && !/nf-door|role="button"|OPEN ▸/.test(r13) && /data-ny-dismiss="asked:n13"/.test(r13) && /<span class="nf-txt">E2E agent waiting on you<\/span>/.test(r13), 'in NOTIFICATIONS it is no door, its ✕ is the rail\'s Dismiss');
    NY.openKey('asked:n13'); A.eq(ui.terms.pop(), ['notifs', null], 'its "in NOTIFICATIONS" opens the bell, where it was filed');
    A.ok(!ctx.store.notifs.find(n => n.id === 'n13').done, '…which does not settle it');
    A.ok(NY.dismissKey('asked:n13'), 'Dismiss settles it');
    A.ok(ctx.store.notifs.find(n => n.id === 'n13').done && !NY.items(NOW).some(i => i.key === 'asked:n13'), '…and it leaves both lists');
  }

  // ---- NEEDS YOU lives in the SESSIONS view: a render from PROJECTS (a build landing, a STEP-IN, an extension change, a
  // dismiss from NOTIFICATIONS) never un-hides it above the projects list (wiring review 2026-10-14) ----
  {
    const host = { hidden: true, innerHTML: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, querySelectorAll: () => [], contains: () => false };
    global.document = { getElementById: id => id === 'ws-needs' ? host : null, querySelector: () => null, hidden: false, activeElement: null };
    let view = 'projects';
    global.App.railView = () => view;
    NY.render();
    A.ok(host.hidden === true && host.innerHTML === '', 'in PROJECTS a render keeps NEEDS YOU hidden (its 6 waits notwithstanding)');
    // a sidecar feed change (a build landing / an extension approved) re-renders from any view: still hidden in PROJECTS
    const realFetch = global.fetch;
    global.fetch = async url => ({ ok: true, json: async () => url === '/api/hooks' ? { hooks: [], pending: [] } : { plugins: [] } });
    await NY.refreshFeeds(true);
    A.eq(NY._internals.feeds().extensions, 0, 'fixture: the feed really changed (extensions approved)');
    A.ok(host.hidden === true && host.innerHTML === '', 'a feed change heard in PROJECTS leaves NEEDS YOU hidden there');
    A.ok(NY.items(NOW).length > 0, 'the bell and NOTIFICATIONS still read the live list in PROJECTS (items() is not gated)');
    view = 'sessions';
    NY.render();
    A.ok(host.hidden === false && /class="ny-head"/.test(host.innerHTML), 'back in SESSIONS the next render rebuilds the block (never a stale shape)');
    global.fetch = realFetch;
    await NY.refreshFeeds(true);
    delete global.App.railView;
    global.document = undefined;
    A.ok(/railView: \(\) => railView,/.test(read('frontend/app/app.js')), 'App exposes the rail view needsyou.js reads');
  }

  // the rail and the bell share one source; the heartbeat keeps the badge live in every rail view
  const app = read('frontend/app/app.js');
  A.ok(/StationUI\.badges\(\);   \/\/ org P01: the bell adds the live NEEDS YOU count/.test(app), 'the 1s rail heartbeat repaints the bell');
  A.ok(/notifsMarkRead, notifsClear, badges,/.test(su), 'StationUI exposes badges() for it');
  // a place the agent can show
  const Places = require('../frontend/app/places.js');
  A.eq(Places.get('needs-you') && Places.get('needs-you').words, 'SESSIONS › NEEDS YOU', 'station.show knows the needs-you place');
  const M = require('../sidecar/manual.js');
  A.ok(/NEEDS YOU at the top of SESSIONS \[needs-you\] lists every card waiting \(also NOTIFICATIONS › NEEDS YOU\)/.test(M.manualSection('concepts')), 'the agent manual points at the rail first, NOTIFICATIONS second');
  A.ok(!/NOTIFICATIONS › NEEDS YOU lists every/.test(M.starnetManual()), 'no manual line points only at NOTIFICATIONS any more');
  A.report('needs-you-one-list.test');
})().catch(e => { console.error(e); process.exit(1); });
