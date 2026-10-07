/* node test/autopilotstore.test.js — the thin idle-driver store (autonomy Slice A). Drives the live loop with an
   injected clock + a fake curiosity hand-off (install:false skips the DOM): activity stamping, the once-per-idle-
   episode beat, the posture gate, and the new-hero reset. Plus source-guards for the browser-flow wiring that
   isn't node-loadable (the chat.js offerCuriosity hand-off + the app.js init). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

global.Autopilot = require('../frontend/app/autopilot.js');
const { AutopilotStore } = require('../frontend/app/autopilotstore.js');

let nowMs = 1000000;
const IDLE = 120000;
let posture = { enabled: true, actsUnattended: false };   // SUGGEST: enabled, but not permitted to act
let offers = 0;
const fresh = () => [{ text: 'x', createdAt: nowMs, updatedAt: nowMs }];
let dossier = { known: ['stack'], blank: ['goals'], familiarity: 1 / 7 };   // cold (no goals)
const beliefs = { stack: fresh() };

AutopilotStore.init({
  install: false,
  now: () => nowMs,
  getPosture: () => posture,
  getDossier: () => dossier,
  getBeliefs: (dim) => beliefs[dim] || [],
  offerCuriosity: () => { offers++; return true; },
  idleMs: IDLE
});

/* ---------- a just-active station does nothing ---------- */
A.eq(AutopilotStore.tick().mode, 'none', 'fresh init starts ACTIVE → no fire (reason: not idle)');
A.eq(offers, 0, 'no curiosity asked while the Commander is active');

/* ---------- going idle earns ONE thing ---------- */
nowMs += IDLE;
let d = AutopilotStore.tick();
A.eq([d.go, d.mode], [true, 'earn'], 'idle + enabled + cold → earn');
A.eq(offers, 1, 'exactly one gentle ask on going idle');

/* ---------- still idle → one beat per episode, no nag ---------- */
nowMs += IDLE * 5;
AutopilotStore.tick();
A.eq(offers, 1, 'staying idle does NOT re-ask (one autopilot beat per idle episode)');

/* ---------- interaction re-arms; a NEW idle episode earns again ---------- */
AutopilotStore.noteActivity();
A.eq(AutopilotStore._state().armed, false, 'activity re-arms the next idle beat');
A.eq(AutopilotStore.tick().mode, 'none', 'right after activity the station is active again, not idle');
nowMs += IDLE;
AutopilotStore.tick();
A.eq(offers, 2, 'a fresh idle episode earns once more');

/* ---------- WAIT posture never fires, even when idle ---------- */
posture = { enabled: false, actsUnattended: false };
AutopilotStore.noteActivity(); nowMs += IDLE;
A.eq(AutopilotStore.tick().mode, 'none', 'WAIT (disabled) posture never acts on its own');
A.eq(offers, 2, 'disabled → no ask');

/* ---------- a HOT + acting dial decides ACT (A1 still earns as the interim, A2 wires the real job) ---------- */
posture = { enabled: true, actsUnattended: true };
dossier = { known: ['goals', 'stack', 'pain', 'identity'], blank: [], familiarity: 4 / 7 };
beliefs.goals = fresh(); beliefs.pain = fresh(); beliefs.identity = fresh();
AutopilotStore.noteActivity(); nowMs += IDLE;
A.eq(AutopilotStore.decideNow().mode, 'act', 'idle + hot + acting dial → the engine decides ACT');

/* ---------- reset disarms ---------- */
AutopilotStore.reset();
A.eq(AutopilotStore._state().armed, false, 'reset clears the idle/armed state for a new hero');

/* ---------- read-only: the store took no U.bus and cannot emit ---------- */
A.ok(typeof global.U === 'undefined', 'AutopilotStore ran with no U.bus present — it never subscribes or emits');

/* ---------- source-guards for the browser-flow wiring (not node-loadable) ---------- */
const chatSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
A.ok(chatSrc.indexOf('function offerCuriosity') > 0, 'chat.js defines offerCuriosity (the idle earn-context hand-off)');
const offerBody = chatSrc.slice(chatSrc.indexOf('function offerCuriosity'), chatSrc.indexOf('function offerCuriosity') + 900);
A.ok(/CuriosityStore\.consider\(\)/.test(offerBody), 'offerCuriosity routes through CuriosityStore (shares the per-session anti-nag cap)');
A.ok(/if \(activeNudge\) return false/.test(offerBody), 'offerCuriosity stands down when a gentle beat is already live (never stacks)');
A.ok(/Dialogue\.isOpen/.test(offerBody), 'offerCuriosity stands down when a focused panel is open');
A.ok(/offerCuriosity/.test(chatSrc.slice(chatSrc.lastIndexOf('return {'))), 'chat.js exports offerCuriosity');

const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
A.ok(/AutopilotStore\.init\(/.test(appSrc), 'app.js initialises AutopilotStore');
A.ok(/offerCuriosity:\s*\(\)\s*=>/.test(appSrc), 'app.js wires Chat.offerCuriosity into the autopilot earn branch');
A.ok(/chat:\s*\(o\)\s*=>/.test(appSrc), 'app.js wires Harness.chat into the autopilot act branch (reason-only runs)');
A.ok(/present:\s*\(d\)\s*=>/.test(appSrc), 'app.js wires the desk delivery (present) for finished drafts');
A.ok(/canWriteFiles:\s*\(\)\s*=>/.test(appSrc), 'app.js wires the cabinet:write consent check (B2 write gate)');
A.ok(/hasCabinet:\s*\(\)\s*=>/.test(appSrc), 'app.js wires the placed-cabinet capability check (object=capability)');
// RUN the real wired hasCabinet against World.heroCaps' real shape ([{objectType}]): the injected stubs below hid that
// the old indexOf('cabinet') could never match, so the B2 real write never fired with a cabinet placed.
{
  const at = appSrc.indexOf('hasCabinet:');
  const line = appSrc.slice(at, appSrc.indexOf('\n', at));
  const arrow = line.slice(line.indexOf('() =>')).replace(/,\s*(\/\/.*)?$/, '');
  const wired = caps => new Function('World', 'agent', 'return (' + arrow + ')')({ heroCaps: () => (typeof caps === 'function' ? caps() : caps) }, { id: 'a' });
  A.eq(wired([{ objectType: 'dish' }, { objectType: 'cabinet' }])(), true, 'hasCabinet: a placed cabinet (heroCaps objects) is seen');
  A.eq(wired([{ objectType: 'dish' }, { objectType: 'plugin', pluginId: 'cabinet' }])(), false, 'hasCabinet: a plugin terminal is not a cabinet');
  A.eq(wired([])(), false, 'hasCabinet: an empty room has no cabinet');
  A.eq(wired(() => { throw new Error('x'); })(), false, 'hasCabinet: a heroCaps hiccup is no cabinet');
}
A.ok(/\/api\/autonomy\/write/.test(appSrc), 'app.js persists the deliverable via the consent-gated /api/autonomy/write endpoint');
A.ok(/Autopilot\.digestSummary\(/.test(appSrc), 'B3: the welcome-back digest summarizes files written vs drafted (digestSummary)');
A.ok(/\/api\/checkpoint\/restore/.test(appSrc), 'B3: the digest offers a one-tap UNDO via the checkpoint restore endpoint');
A.ok(/value:\s*'undo'/.test(appSrc), 'B3: the undo action is wired into the welcome-back beat');
/* ---------- ONE SURFACE PER MOMENT (beat-fat trim 2026-07-03): the cronDigest toasts are FALLBACKS only —
   they fire solely when the COMMS nudge can't render, never beside it (the "announced twice" double). ---------- */
{
  const iPresent = appSrc.indexOf('present: (d) =>');
  const iDigest = appSrc.indexOf('digest: (info) =>');
  A.ok(iPresent > 0 && iDigest > iPresent, 'present + digest hooks exist in order');
  const presentSeg = appSrc.slice(iPresent, iDigest);
  A.ok(/const canNudge = typeof Chat !== 'undefined' && Chat\.nudge;/.test(presentSeg), 'present() decides ONE surface up front (canNudge)');
  A.ok(/if \(!canNudge && typeof StationUI[\s\S]{0,80}StationUI\.notify\)/.test(presentSeg), 'present(): the toast fires ONLY when the nudge cannot (fallback, not a duplicate)');
  const digestSeg = appSrc.slice(iDigest, iDigest + 4500);
  A.ok(/if \(\(typeof Chat === 'undefined' \|\| !Chat\.nudge\) && typeof StationUI/.test(digestSeg), 'digest(): the toast fires ONLY when the welcome-back nudge cannot (fallback, not a duplicate)');
  A.ok(/'cronDigest'[,)]/.test(presentSeg) && /'cronDigest'[,)]/.test(digestSeg), 'both fallback toasts stay tagged cronDigest (P1-8 category mute still works)');
}

/* ---------- A2: the ACT branch — anti-slop pipeline → draft on the desk ---------- */
(async () => {
  let presented = null;
  const hotDossier = { known: ['goals', 'stack', 'pain', 'identity'], blank: [], familiarity: 4 / 7 };
  const hotBeliefs = {
    goals: [{ text: 'ship the StarNet beta to 100 users', updatedAt: nowMs }],
    pain: [{ text: 'manual release notes eat my fridays', updatedAt: nowMs }],
    stack: [{ text: 'node and plain js', updatedAt: nowMs }],
    identity: [{ text: 'andro, solo builder', updatedAt: nowMs }]
  };
  const baseDeps = (chat) => ({
    install: false, now: () => nowMs,
    getPosture: () => ({ enabled: true, actsUnattended: true, leashPerDay: 2 }),
    getDossier: () => hotDossier,
    getBeliefs: (dim) => hotBeliefs[dim] || [],
    getSystem: () => 'SYS', getName: () => 'NOVA',
    offerCuriosity: () => true,
    chat, present: (d) => { presented = d; },
    idleMs: IDLE
  });
  // a good model: proposes one grounded high-confidence candidate, then produces a titled draft.
  const goodChat = async ({ messages }) => {
    const c = messages[0].content;
    if (/Propose up to/.test(c)) return { text: 'JOB: Beta launch checklist\nKIND: advance-goal\nGROUNDS: ship the StarNet beta to 100 users\nCONFIDENCE: high\nSPEC: a pre-launch checklist' };
    if (/Do this ONE job/.test(c)) return { text: 'TITLE: Beta launch checklist\n1. Freeze the build\n2. Tag the release\n3. Smoke test' };
    if (/SELF-REVIEW/.test(c)) return { text: 'VERDICT: ship\nNOTE: solid' };
    return { text: '' };
  };

  AutopilotStore.init(baseDeps(goodChat));
  const r1 = await AutopilotStore.act();
  A.eq([r1.delivered, r1.archetype], [true, 'advance-goal'], 'a hot + leash idle act delivers a grounded advance-goal draft');
  A.eq(presented && presented.title, 'Beta launch checklist', 'the draft is surfaced to the desk (present called with the deliverable)');
  A.ok(presented && /Freeze the build/.test(presented.body), 'the surfaced draft carries the run-produced body');
  A.eq(AutopilotStore._draftState().acted, 1, 'a delivered act consumes one leash unit');
  A.eq(AutopilotStore._draftState().drafts.length, 1, 'the draft is logged for the while-you-were-away digest');

  // BUDGET: leashPerDay 2 → after the 2nd act the idle decision downgrades to EARN (binding budget).
  await AutopilotStore.act();
  AutopilotStore.noteActivity(); nowMs += IDLE;
  const dBudget = AutopilotStore.decideNow();
  A.eq([dBudget.mode, dBudget.binding], ['earn', 'budget'], "today's leash spent → the idle decision falls back to earn (budget binding)");

  // a NEW DAY restores the leash budget → acting resumes.
  nowMs += 86400000;
  A.eq(AutopilotStore.decideNow().mode, 'act', 'a new day rolls the leash back → acting resumes');

  // CONFIDENCE GATE: all-low candidates → no act, no leash spent, nothing surfaced.
  presented = null;
  const lowChat = async ({ messages }) => /Propose up to/.test(messages[0].content)
    ? { text: 'JOB: maybe tweak something\nKIND: advance-goal\nGROUNDS: ship the StarNet beta to 100 users\nCONFIDENCE: low\nSPEC: vague' }
    : { text: 'TITLE: t\nbody' };
  AutopilotStore.init(baseDeps(lowChat));
  const r2 = await AutopilotStore.act();
  A.eq([r2.delivered, r2.reason], [false, 'low-confidence'], 'all-low candidates → no act (the confidence gate: idle-doing-nothing beats slop)');
  A.eq(AutopilotStore._draftState().acted, 0, 'a gated deliberation spends no leash');
  A.eq(presented, null, 'nothing is surfaced when the confidence gate stands the agent down');

  // GROUNDING VETO: an invented-grounds proposal never becomes a candidate → no act.
  const ungroundedChat = async ({ messages }) => /Propose up to/.test(messages[0].content)
    ? { text: 'JOB: rewrite everything\nKIND: advance-goal\nGROUNDS: migrate the whole product to a brand new platform\nCONFIDENCE: high\nSPEC: a plan' }
    : { text: 'TITLE: t\nbody' };
  AutopilotStore.init(baseDeps(ungroundedChat));
  A.eq((await AutopilotStore.act()).delivered, false, 'an invented-grounds proposal is vetoed → no act');

  /* ---------- A3: self-critique ---------- */
  // the agent can DROP its own draft on review (no delivery, no leash spent).
  const dropChat = async ({ messages }) => {
    const c = messages[0].content;
    if (/Propose up to/.test(c)) return { text: 'JOB: x\nKIND: advance-goal\nGROUNDS: ship the StarNet beta to 100 users\nCONFIDENCE: high\nSPEC: s' };
    if (/Do this ONE job/.test(c)) return { text: 'TITLE: Draft\nbody' };
    if (/SELF-REVIEW/.test(c)) return { text: 'VERDICT: drop\nNOTE: padding, not worth their time' };
    return { text: '' };
  };
  AutopilotStore.init(baseDeps(dropChat));
  const rDrop = await AutopilotStore.act();
  A.eq([rDrop.delivered, rDrop.reason], [false, 'self-rejected'], 'self-critique can DROP its own draft (verify-before-done, turned inward)');
  A.eq(AutopilotStore._draftState().acted, 0, 'a self-rejected draft consumes no leash');

  // the agent can REVISE and ship the corrected draft.
  presented = null;
  const reviseChat = async ({ messages }) => {
    const c = messages[0].content;
    if (/Propose up to/.test(c)) return { text: 'JOB: x\nKIND: advance-goal\nGROUNDS: ship the StarNet beta to 100 users\nCONFIDENCE: high\nSPEC: s' };
    if (/Do this ONE job/.test(c)) return { text: 'TITLE: First draft\noriginal body' };
    if (/SELF-REVIEW/.test(c)) return { text: 'VERDICT: revise\nNOTE: tightened\nTITLE: Revised draft\nbetter body' };
    return { text: '' };
  };
  AutopilotStore.init(baseDeps(reviseChat));
  const rRev = await AutopilotStore.act();
  A.eq([rRev.delivered, rRev.verdict], [true, 'revise'], 'self-critique can REVISE and ship the corrected draft');
  A.eq(presented && presented.title, 'Revised draft', 'the surfaced draft is the revised version');
  A.ok(presented && /better body/.test(presented.body), 'the revised body is what reaches the desk');

  /* ---------- A3: the welcome-back digest ---------- */
  let digested = null;
  AutopilotStore.init(Object.assign(baseDeps(goodChat), { digest: (info) => { digested = info; }, digestAwayMs: 300000 }));
  nowMs += 60000;                 // a minute of idle passes, then the autopilot works
  await AutopilotStore.act();
  nowMs += 400000;                // ~6.6 min later the Commander returns
  AutopilotStore.noteActivity();
  A.ok(digested && digested.drafts.length >= 1, 'returning after a real absence shows the welcome-back digest of drafts made while away');
  // a brief glance away does NOT trigger it
  digested = null;
  AutopilotStore.noteActivity();   // near-zero gap now
  A.eq(digested, null, 'a return with no real absence shows no digest (anti-nag)');

  /* ---------- the GENUINE-RETURN hook (2026-07-14): the digest reads the LOCAL draft log, which the
     server-owned night-shift act path never writes — onReturn fires on a real absence REGARDLESS of local
     drafts so app.js can re-offer undecided server-built work (the "it never told me" blind spot). ---------- */
  let returned = null;
  AutopilotStore.init(Object.assign(baseDeps(goodChat), { onReturn: (info) => { returned = info; }, digestAwayMs: 300000 }));
  nowMs += 400000;                 // a real absence with ZERO local drafts (no act ran this init)
  AutopilotStore.noteActivity();
  A.ok(returned && returned.awayMs >= 300000, 'a genuine return fires onReturn even when the local draft log is EMPTY');
  returned = null;
  AutopilotStore.noteActivity();   // near-zero gap
  A.eq(returned, null, 'a brief glance away never fires onReturn (anti-nag)');

  /* ---------- A3: the learn hook re-weights selection ---------- */
  const tieChat = async ({ messages }) => {
    const c = messages[0].content;
    if (/Propose up to/.test(c)) return { text: 'JOB: advance\nKIND: advance-goal\nGROUNDS: ship the StarNet beta to 100 users\nCONFIDENCE: high\nSPEC: s\n\nJOB: pain\nKIND: kill-pain\nGROUNDS: manual release notes eat my fridays\nCONFIDENCE: high\nSPEC: s' };
    if (/Do this ONE job/.test(c)) return { text: 'TITLE: D\nbody' };
    if (/SELF-REVIEW/.test(c)) return { text: 'VERDICT: ship' };
    return { text: '' };
  };
  AutopilotStore.init(Object.assign(baseDeps(tieChat), { getPosture: () => ({ enabled: true, actsUnattended: true, leashPerDay: 9 }) }));
  A.eq((await AutopilotStore.act()).archetype, 'advance-goal', 'with no learning, a tie picks advance-goal (the fixed order)');
  AutopilotStore.rate('kill-pain', true); AutopilotStore.rate('kill-pain', true);   // net +2 → +0.5 selection bias
  A.eq((await AutopilotStore.act()).archetype, 'kill-pain', 'after the Commander likes kill-pain twice, it wins the tie — the learn hook re-weights selection per Commander');

  /* ---------- B2: the act path WRITES a real local file when permitted ---------- */
  let writeCalls = [];
  const writeOkDeps = (over) => Object.assign(baseDeps(goodChat), {
    getPosture: () => ({ enabled: true, actsUnattended: true, leashPerDay: 9 }),
    canWriteFiles: () => true, hasCabinet: () => true,
    writeFile: async (req) => { writeCalls.push(req); return { ok: true, path: req.path, snapshot: 'snap1' }; }
  }, over || {});

  // permitted: cabinet:write granted + a cabinet placed + the write succeeds → a REAL file lands.
  presented = null; writeCalls = [];
  AutopilotStore.init(writeOkDeps());
  const rW = await AutopilotStore.act();
  A.eq([rW.delivered, rW.wrote], [true, true], 'permitted (grant + cabinet) → the deliverable is WRITTEN, not just drafted');
  A.eq(writeCalls.length, 1, 'exactly one write per act');
  A.eq(writeCalls[0].path, 'drafts/beta-launch-checklist.md', 'the write path is the deterministic slug of the title');
  A.ok(/^# Beta launch checklist\n\n/.test(writeCalls[0].content), 'the file body is the H1 title + the deliverable body');
  A.ok(presented && presented.wrote && presented.wrote.path === 'drafts/beta-launch-checklist.md', 'present() learns the file was written (desk copy + B3 undo)');
  A.ok(AutopilotStore._draftState().drafts.slice(-1)[0].wrote, 'the draft-log entry records the write (digest ✎ marker + undo)');

  // NOT permitted: no cabinet placed (object=capability) → falls back to a desk draft, no write attempted.
  writeCalls = []; presented = null;
  AutopilotStore.init(writeOkDeps({ hasCabinet: () => false }));
  const rNoCab = await AutopilotStore.act();
  A.eq([rNoCab.delivered, rNoCab.wrote], [true, false], 'granted but NO cabinet placed → draft-only (still delivered), no write');
  A.eq(writeCalls.length, 0, 'no write attempted without a placed cabinet (keeps B1 honesty true)');

  // NOT permitted: no grant → draft-only.
  writeCalls = [];
  AutopilotStore.init(writeOkDeps({ canWriteFiles: () => false }));
  A.eq((await AutopilotStore.act()).wrote, false, 'no cabinet:write grant → draft-only, no write');
  A.eq(writeCalls.length, 0, 'no write attempted without the grant');

  // write FAILS server-side (e.g. broker denied) → graceful fallback to a desk draft (still delivered, no lost work).
  presented = null;
  AutopilotStore.init(writeOkDeps({ writeFile: async () => ({ ok: false, reason: 'denied' }) }));
  const rFail = await AutopilotStore.act();
  A.eq([rFail.delivered, rFail.wrote], [true, false], 'a server-denied/failed write degrades gracefully to a desk draft');

  A.report('autopilotstore.test');
})();
