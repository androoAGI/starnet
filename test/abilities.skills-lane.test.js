'use strict';

// The Skills backend can be completely healthy while a missing frontend lane dependency makes
// ABILITIES silently omit SKILL LIBRARY, AGENT SKILLS, and SKILL EXCHANGE. connectors.js deliberately
// catches lane-builder errors so one optional lane cannot break the whole console; this test therefore
// executes the production lane builder and requires every shipped Skills section to survive that seam.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
const laneMatch = source.match(/function abilitySkillsLane\(body\) \{[\s\S]*?\n  \}\n  window\.AbilityLanes/);
A.ok(laneMatch, 'the ABILITIES Skills lane is present');

const laneSource = laneMatch[0].replace(/\n  window\.AbilityLanes[\s\S]*$/, '');
const context = {
  present: [{ id: 'agent', name: 'Agent' }],
  sel: 0,
  esc: value => String(value),
  skillsPick: null,   // org P21: a one-shot request from a dossier's SKILLS row (null = the dossier's agent)
  skillsShown: null,  // org P21: the agent the open window's lane shows, tied to that window instance
  open: { connectors: { id: 'win-1' } },
  result: null
};
// org P21: the lane names the shown agent through skillsIntro — run the shipped helper, not a stub
const introMatch = source.match(/function skillsIntro\(a\) \{[\s\S]*?\n  \}/);
A.ok(introMatch, 'the AGENT SKILLS intro helper is present');
// night-leak 10-15: the lane ties its pick to the window through a WeakRef (weakWin / shownInOpenWindow) — run the shipped helpers
const weakSrc = (source.match(/  const weakWin = [^\n]*\n/) || [''])[0] + (source.match(/function shownInOpenWindow\(\) \{[\s\S]*?\n  \}/) || [''])[0];
A.ok(/new WeakRef\(w\)/.test(weakSrc) && /function shownInOpenWindow/.test(weakSrc), 'the weak window tie helpers are present');
vm.runInNewContext(weakSrc + '\n' + (introMatch ? introMatch[0] : '') + '\n' + laneSource + '\nresult = abilitySkillsLane({});', context);
// ONE FLAT LIST (UX night 2026-10-26): AGENT SKILLS is the LEARNED SKILLS block of SKILLS, SKILL EXCHANGE the ADD FROM A
// LINK block of SKILL MARKET — the same markup, merged into its neighbour, so build each section and read its HTML
const built = id => { const s = context.result.sections.find(x => x.id === id); if (!s) return ''; const el = { innerHTML: '' }; s.build(el); return el.innerHTML; };
A.ok(/Reusable procedures <b>Agent<\/b> created or learned/.test(built('library')), 'LEARNED SKILLS (in SKILLS) names the agent it shows');

// org P21 fix (review): the dossier's SKILLS pick is ONE-SHOT. Run the shipped lane builder through a sequence of
// opens: sent from NOVA's dossier → NOVA; a later open from anywhere else → the dossier's agent again; a rerender of
// the SAME window keeps an in-window pick; a FRESH window never inherits it.
{
  const helper = (source.match(/function skillsAgentId\(\) \{[\s\S]*?\n  \}/) || [''])[0];
  A.ok(helper, 'skillsAgentId (the one reader every skills action uses) is present');
  const seq = { present: [{ id: 'agent', name: 'Agent' }, { id: 'nova', name: 'NOVA' }], sel: 0, esc: v => String(v), skillsPick: null, skillsShown: null, open: { connectors: { id: 'w1' } } };
  vm.runInNewContext(weakSrc + '\n' + (introMatch ? introMatch[0] : '') + '\n' + laneSource + '\n' + helper, seq);
  const shownAfterBuild = () => { vm.runInNewContext('abilitySkillsLane({});', seq); return vm.runInNewContext('skillsAgentId()', seq); };
  seq.skillsPick = 'nova';
  A.eq(shownAfterBuild(), 'nova', 'P21: sent from NOVA\'s dossier SKILLS row → the lane shows NOVA');
  A.eq(seq.skillsPick, null, 'P21: the request is consumed when the lane builds');
  A.eq(shownAfterBuild(), 'nova', 'P21: a rerender of the same open window keeps NOVA');
  // night-leak 10-15: a strong `win` kept the last closed ABILITIES window (8,762 elements) alive until the next open
  A.ok(seq.skillsShown && seq.skillsShown.win !== seq.open.connectors && typeof seq.skillsShown.win.deref === 'function' && seq.skillsShown.win.deref() === seq.open.connectors,
    'the lane ties its pick to the window WEAKLY (a WeakRef to this instance, never the element itself)');
  seq.open.connectors = { id: 'w2' };
  A.eq(shownAfterBuild(), 'agent', 'P21: a later fresh open (not from the SKILLS row) follows the dossier\'s agent again');
  seq.skillsShown = { id: 'nova', win: new WeakRef(seq.open.connectors) };
  A.eq(vm.runInNewContext('skillsAgentId()', seq), 'nova', 'P21: an in-window pick is what every skills action reads');
  seq.open.connectors = null;
  A.eq(vm.runInNewContext('skillsAgentId()', seq), 'agent', 'P21: once that window is gone the pick is gone with it');
}
const changeSrc = (laneSource.match(/pick\.addEventListener\('change', \(\) => \{[\s\S]*?\n      \}\);/) || [''])[0];
A.ok(/loadAgentSkills\(pick\.value\); loadSkillLibrary\(pick\.value\); loadSkillMarket\(pick\.value\);/.test(changeSrc) && !/skillsPick =/.test(changeSrc),
  'P21: the picker moves the whole lane (agent skills, library, market) to the picked agent and never leaves a sticky request behind');
A.ok(/wireSkillExchange\(skillsAgentId\)/.test(laneSource) && /renderSkillExchangePreview\(host, r\.preview, shownAgent\(\)\)/.test(source),
  'P21: a SKILL EXCHANGE install goes to the agent shown at inspect time');
A.ok(/host\.dataset\.agent = agentId;/.test(source) && /const shownId = host\.dataset\.agent \|\| agentId;/.test(source),
  'P21: the market\'s once-wired click handler acts for the agent of the latest load');
A.ok(/const agentName = \(\(present\.find\(x => x && x\.id === agentId\) \|\| \{\}\)\.name\) \|\| agentId;/.test(source),
  'P21: the library\'s "active for <agent>" names the agent it was loaded for, not the dossier selection');
A.ok(/const openOn = typeof H\.skillsAgentId === 'function' \? H\.skillsAgentId\(\)/.test(fs.readFileSync(path.join(__dirname, '../frontend/app/windows/connectors.js'), 'utf8')),
  'P21: BUILT-IN ABILITIES opens on the same agent as the skills lane');

A.eq(context.result.sections.map(section => section.id), ['market', 'library'],
  'the live lane builds both Skills sections without throwing');
A.eq(context.result.sections.map(section => section.label), ['SKILL MARKET', 'SKILLS'],
  'the live lane exposes the two promised labels');
{
  const market = built('market'), library = built('library');
  const at = (html, id) => html.indexOf('id="' + id + '"');
  A.ok(at(market, 'skm-list') >= 0 && at(market, 'ab-exchange') > at(market, 'skm-list') && at(market, 'sk-exchange-preview') > at(market, 'ab-exchange') && /<span class="sec-l">ADD FROM A LINK<\/span>/.test(market),
    'SKILL MARKET ends with its ADD FROM A LINK block, which carries the whole exchange (inspect + preview)');
  A.ok(at(library, 'sk-agent-pick') >= 0 && at(library, 'sk-lib') > at(library, 'sk-agent-pick') && at(library, 'ab-agent-skills') > at(library, 'sk-lib') && at(library, 'sk-agent') > at(library, 'ab-agent-skills') && /<span class="sec-l">LEARNED SKILLS<\/span>/.test(library),
    'SKILLS: its agent picker on top (it moves the whole section), the library, then the LEARNED SKILLS block');
}
A.ok(/function\s+scanFindingText\s*\(/.test(source), 'Skill Exchange scan findings renderer is defined');
A.ok(/function\s+renderSkillExchangePreview\s*\(/.test(source), 'Skill Exchange preview renderer is defined');
A.ok(/function\s+wireSkillExchange\s*\(/.test(source), 'Skill Exchange controls are wired');
A.ok(/window\.AbilityLanes\.push\(abilitySkillsLane\)/.test(source), 'the Skills lane registers with ABILITIES');
A.ok(source.includes("skills.length + ' skill'"), 'the library count calls these procedures skills, not launchable recipes');
A.ok(/id="sk-exchange-preview"[^>]*role="status"[^>]*aria-live="polite"/.test(source),
  'Skill Exchange inspection and validation feedback is announced');
A.ok(source.includes('PACKAGE SHA-256') && source.includes('sk-package-file'), 'review exposes the complete package manifest and exact digest');
A.ok(source.includes('IMPORT EXPORTED PACKAGE') && source.includes('data-ag-act="export"'), 'lossless import and export controls are present');
A.ok(source.includes('data-ag-act="generations"') && source.includes('data-rollback='), 'offline generation rollback is exposed');
A.ok(source.includes('DISCOVER SITE') && source.includes('SAVE TAP'), 'registry discovery and user-managed taps are exposed');
A.ok(!source.includes('referenced package files remain at the source'), 'the obsolete single-document limitation is gone');

// A Full Access user must not be sent to place a cabinet just to load FILES instructions.
// Exercise the actual UI loader with the real authority projection, not a second grant calculation.
async function checkAvailability() {
  const { effectiveToolsets } = require('../sidecar/capability/effective-toolsets.js');
  const loader = source.match(/function loadSkillLibrary\(agentId\) \{[\s\S]*?\n  \}/)[0];
  async function run(view, shared = []) {
    let requested = '', rendered = null;
    const host = { innerHTML:'', closest:() => null };
    vm.runInNewContext(loader + '\nloadSkillLibrary("agent");', {
      $: () => host, skillLibLoad: 0, Harness:{api:{get:async () => view}},
      World:{heroCaps:() => [],stationCaps:() => shared.map(objectType => ({objectType}))},
      fetch:async url => { requested = url; return {ok:true,json:async () => ({skills:[]})}; },
      renderSkillLibrary:(_host,_skills,_id,placed) => { rendered = Array.from(placed); },
      requestAnimationFrame:() => {}, encodeURIComponent
    });
    await new Promise(resolve => setImmediate(resolve));
    return {requested,rendered,host};
  }
  const full = await run(effectiveToolsets({fullAccess:true}));
  A.ok(full.rendered.includes('cabinet') && full.requested.includes('cabinet'), 'Full Access projects FILES into skill availability without a placed cabinet');
  const profile = await run(effectiveToolsets({agent:{executionProfile:'safe-cell',approvalMode:'ask'}}), ['dish']);
  A.ok(profile.rendered.includes('cabinet') && profile.rendered.includes('dish'), 'profile objects and shared station gear follow the runtime skill context');
  const restricted = await run(effectiveToolsets({agent:{executionProfile:'station-gear',approvalMode:'ask'}}));
  A.ok(!restricted.rendered.includes('cabinet'), 'restricted station without FILES does not invent that ability');
  const unavailable = await run(null);
  A.eq(unavailable.requested, '', 'unavailable authority never produces a guessed skill query');
  A.ok(unavailable.host.innerHTML.includes('Could not load'), 'unavailable authority renders recovery instead of missing-prop advice');
  await checkCandidateReview();
  await checkSkillSharing();
}
checkAvailability().catch(error => { console.error(error); process.exitCode = 1; });

// Execute the real pending-review callbacks. These controls must send the receipt the
// server issued and the candidate digest displayed to the user, never a client verdict.
async function checkCandidateReview() {
  function element() {
    const children = [], found = {};
    return { children, dataset: {}, disabled: false, textContent: '', value: '',
      appendChild(child) { children.push(child); },
      // Like the real DOM, a card built from markup has no control its markup does not carry.
      querySelector(key) {
        const attr = /^\[([a-z-]+)\]$/.exec(key);
        if (this.html != null && attr && !this.html.includes(attr[1])) return null;
        return found[key] || (found[key] = element());
      },
      set innerHTML(html) { this.html = html; }, get innerHTML() { return this.html || ''; } };
  }
  const postSource = source.slice(source.indexOf('  async function skillReviewPost('), source.indexOf('  function loadAgentSkills('));
  const renderSource = source.slice(source.indexOf('  function renderSkillCandidates('), source.indexOf('  function renderAgentSkills('));
  const requests = [], reloads = [], host = element(); let status = 'passed', extra = {};
  const ctx = { host, esc: String, mkEl: (tag, cls) => Object.assign(element(), { tag, className: cls || '' }), loadAgentSkills: id => reloads.push(id),
    ArmConfirm: { wire(btn, opts) { btn.armed = opts; } },
    Harness: { api: { post: async (path, body, opts) => { requests.push({ path, body, opts }); return { ok: true, j: { ok: true, receipt: Object.assign({ receiptId: 'host-receipt', status }, extra) } }; } } },
    review: { candidates: [{ candidateId: 'candidate-3', candidateDigest: 'exact-sha', revision: 3,
      skill: { id: 'brief', name: 'Brief', body: 'Proposed instructions', scope: 'agent', files: [] } }],
      // waitMs is the station's own wait for this suite (index.js evaluationSuiteMetadata); the generic suite omits it
      evaluationSuites: [{ id: 'brief-checks', skillId: 'brief', description: 'Weekly brief checks', cases: 4, waitMs: 750000 },
        { id: 'task-handoff:Brief', skillId: 'brief', description: 'Structured continuation handoff.', generic: true, cases: 3 }] }
  };
  vm.runInNewContext(postSource + renderSource + '\nrenderSkillCandidates(host, "agent", review);', ctx);
  const card = host.children[0], approve = card.querySelector('[data-candidate-approve]');
  // Fake DOM does not parse disabled attributes, but the actual markup must start disabled.
  A.ok(card.html.includes('data-candidate-approve disabled'), 'pending approval starts disabled');
  A.ok(card.html.includes('does not prove improvement for every use'), 'UI states evaluation scope honestly');
  A.ok(card.html.includes('Proposed sharing: Only this agent · revision 3'), 'proposed sharing reads in plain words, not the raw scope id');
  A.ok(/data-suite-json[^>]*placeholder="Example:/.test(card.html), 'the task-check editor shows an example suite');
  A.ok(card.html.includes('data-candidate-acknowledge hidden disabled'), 'no-improvement approval starts hidden and disabled');
  // The header states the gate the station enforces: a passing evaluation, or a complete no-improvement one the owner confirms.
  A.ok(!card.html.includes('needs a passing task evaluation'), 'header does not claim a pass is the only way through');
  A.ok(card.html.includes('needs a task evaluation and your approval. If a complete evaluation shows no improvement but the proposal passed every check, you can still approve it by confirming that.'), 'header names the confirmed no-improvement exit');
  A.ok(card.querySelector('[data-evaluation-suites]').children[2].textContent.includes('generic check (not specific to this skill)'), 'built-in suite is labeled a generic check');
  A.ok(!card.querySelector('[data-evaluation-suites]').children[0].textContent.includes('generic check'), 'owner task checks are not labeled generic');
  const run = card.querySelector('[data-evaluation-suites]').children[1];
  await run.onclick();
  A.eq(requests[0].body.candidateDigest, 'exact-sha', 'evaluation request binds displayed revision');
  A.eq(requests[0].body.suiteId, 'brief-checks', 'host selects runner for registered suite');
  // skills-eval-06: the page waits as long as the station says this suite can take, never a fixed 3 minutes
  A.eq(requests[0].opts && requests[0].opts.timeoutMs, 750000, 'evaluate waits the suite\'s waitMs from the station');
  A.eq(approve.disabled, false, 'passing host receipt enables separate approval action');
  await approve.onclick();
  A.eq(requests[1].opts && requests[1].opts.timeoutMs, 60000, 'other skill actions keep the 60 s wait');
  A.eq(requests[1].body.evaluation, 'host-receipt', 'approval uses durable host receipt ID');
  A.eq(requests[1].body.candidateDigest, 'exact-sha', 'approval remains bound to displayed revision');
  A.ok(!Object.hasOwn(requests[1].body, 'status'), 'UI cannot manufacture evaluation status for approval');
  A.eq(reloads, ['agent'], 'confirmed approval reloads authoritative state');
  const host2 = element(); ctx.host = host2; status = 'regression';
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const card2 = host2.children[0];
  await card2.querySelector('[data-evaluation-suites]').children[1].onclick();
  A.eq(card2.querySelector('[data-candidate-approve]').disabled, true, 'regressed proposal cannot be approved from panel');
  A.eq(card2.querySelector('[data-candidate-acknowledge]').disabled, true, 'regressed proposal cannot be acknowledged from panel');
  // Review finding world-render-10: a misclick must not discard an evaluated proposal. Reject arms first.
  const rejectBtn = card2.querySelector('[data-candidate-reject]');
  A.ok(rejectBtn.armed && typeof rejectBtn.armed.onConfirm === 'function', 'reject is an armed two-step confirm');
  A.ok(!rejectBtn.onclick, 'reject has no one-click path when ArmConfirm is present');
  A.eq(rejectBtn.armed.armedLabel, 'Confirm: reject proposal', 'the armed reject says what the second click does');
  await rejectBtn.armed.onConfirm();
  A.ok(requests.at(-1).path.endsWith('/reject-candidate'), 'reject has a separate server decision');
  // A complete tie (every candidate case passed, no regression) offers ONLY the armed owner acknowledgement,
  // and the panel says plainly that the evaluation showed no improvement.
  const tieCases = [{ before: { completed: true, pass: true }, after: { completed: true, pass: true } }];
  const host4 = element(); ctx.host = host4; status = 'insufficient_evidence';
  extra = { allCandidatePassed: true, regressions: [], improvements: [], cases: tieCases };
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const card4 = host4.children[0], ack = card4.querySelector('[data-candidate-acknowledge]');
  await card4.querySelector('[data-evaluation-suites]').children[1].onclick();
  A.eq(card4.querySelector('[data-candidate-approve]').disabled, true, 'a tie never enables the measured-improvement approval');
  A.eq(ack.hidden, false, 'a complete tie shows the acknowledgement');
  A.eq(ack.disabled, false, 'a complete tie enables the acknowledgement');
  A.ok(/no improvement/i.test(card4.querySelector('[data-evaluation-result]').textContent), 'panel says the evaluation showed no improvement');
  // The owner already registered these checks: the advice is to add one that separates the versions.
  const ownerTieText = card4.querySelector('[data-evaluation-result]').textContent;
  A.ok(!ownerTieText.includes('Register task checks'), 'an owner-suite tie does not ask for checks the owner already registered');
  A.ok(ownerTieText.includes('Add a check that fails without the proposal to measure the difference.'), 'an owner-suite tie says how to measure the difference');
  A.ok(ownerTieText.includes('and so did the run without it'), 'tie copy holds for a new skill as well as a revision');
  A.ok(ack.armed && typeof ack.armed.onConfirm === 'function', 'acknowledgement is an armed two-step confirm');
  await ack.armed.onConfirm();
  A.eq(requests.at(-1).body.acknowledgeNoImprovement, true, 'acknowledgement is sent explicitly');
  A.eq(requests.at(-1).body.evaluation, 'host-receipt', 'acknowledgement still names the host receipt');
  A.eq(requests.at(-1).body.candidateDigest, 'exact-sha', 'acknowledgement stays bound to the displayed revision');
  const host5 = element(); ctx.host = host5;
  extra = { allCandidatePassed: true, regressions: [], improvements: [], cases: [{ before: { completed: false, pass: false }, after: { completed: true, pass: true } }] };
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const card5 = host5.children[0];
  await card5.querySelector('[data-evaluation-suites]').children[1].onclick();
  A.eq(card5.querySelector('[data-candidate-acknowledge]').disabled, true, 'an incomplete evaluation cannot be acknowledged');
  A.eq(card5.querySelector('[data-candidate-acknowledge]').hidden, true, 'an incomplete evaluation hides the acknowledgement');
  // A tie on a built-in generic suite points the owner at registering checks for this skill.
  const host6 = element(); ctx.host = host6; extra = { allCandidatePassed: true, regressions: [], improvements: [], cases: tieCases };
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const card6 = host6.children[0];
  await card6.querySelector('[data-evaluation-suites]').children[3].onclick();
  A.eq(requests.at(-1).body.suiteId, 'task-handoff:Brief', 'generic suite is the one evaluated');
  // A suite listed without waitMs gets the station's own rule: 2 runs a case at 90 s, 2 to 20 min, plus a 30 s margin.
  A.eq(requests.at(-1).opts && requests.at(-1).opts.timeoutMs, 3 * 2 * 90000 + 30000, 'a suite without waitMs waits by its case count');
  A.ok(card6.querySelector('[data-evaluation-result]').textContent.includes('Register task checks for this skill to measure it.'), 'a generic-suite tie suggests registering task checks');
  status = 'passed'; extra = {};
  const host3 = element(); ctx.host = host3;
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const card3 = host3.children[0];
  card3.querySelector('[data-suite-json]').value = JSON.stringify({ id: 'custom', skillName: 'Brief', cases: [] });
  await card3.querySelector('[data-suite-register]').onclick();
  A.eq(requests.at(-1).body.skillId, 'brief', 'custom task checks are bound to the owned skill');
  A.ok(requests.at(-1).path.endsWith('/evaluation-suite'), 'suite JSON is validated by host route');

  // Review finding skills-eval-21: plain words, no raw ids, and a paid passing receipt survives a panel reload.
  const runLabel = card3.querySelector('[data-evaluation-suites]').children[1].textContent;
  A.ok(!runLabel.includes('brief-checks'), 'the run button does not show the raw suite id: ' + runLabel);
  A.eq(runLabel, 'Run these checks', 'the run button says what it does; the description label sits above it');
  // The run's receipt sits in a closed details block, never as a JSON dump in the sentence.
  const note2 = card2.querySelector('[data-evaluation-result]'), receiptBox = note2.children.at(-1);
  A.eq(receiptBox && receiptBox.tag, 'details', 'the evaluation receipt is folded into a details block');
  A.eq(receiptBox && receiptBox.children[0] && receiptBox.children[0].textContent, 'Evaluation receipt', 'the folded receipt is labeled');
  A.ok(!note2.textContent.includes('{'), 'the result sentence carries no JSON');
  // A run the station refused ('policy-denied') says so in plain words, listing only causes the harness can have had.
  const host8 = element(); ctx.host = host8; status = 'insufficient_evidence';
  extra = { allCandidatePassed: false, regressions: [], improvements: [], cases: [{ before: { completed: false, pass: false, reason: 'policy-denied' }, after: { completed: false, pass: false, reason: 'policy-denied' } }] };
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const card8 = host8.children[0];
  await card8.querySelector('[data-evaluation-suites]').children[1].onclick();
  A.ok(card8.querySelector('[data-evaluation-result]').textContent.includes('the station stopped a run (a budget limit, paused spending, the time limit, or an earlier run whose cost could not be settled)'), 'a refused run lists what can stop one');
  A.ok(!card8.querySelector('[data-evaluation-result]').textContent.includes('insufficient_evidence'), 'no enum status reaches the owner');
  // The host's stored receipt for this exact revision (latestEvaluation) seeds the card after a reload.
  // Contract: latestEvaluation is the WHOLE stored receipt row, the same object evaluate-candidate returns as
  // `receipt`, never a summary. The fixtures come from the real evaluator and its real store, not hand-written.
  const SkillEvaluation = require('../sidecar/skillevaluation.js');
  const store = {}, io = { get: k => store[k], set: (k, v) => { store[k] = v; } };
  const suite = { id: 'brief-checks', skillName: 'Brief', version: 1, cases: [
    { id: 'weekly', prompt: 'Write the weekly brief.', checks: [{ id: 'ok', kind: 'json_equal', path: ['ok'], expected: true }] },
    { id: 'held', prompt: 'Write the held-out brief.', heldOut: true, checks: [{ id: 'ok', kind: 'json_equal', path: ['ok'], expected: true }] }] };
  let mode = 'pass';
  const runCase = async ({ phase }) => mode === 'denied' ? { reason: 'policy-denied' } : { reason: 'done', value: { ok: mode === 'tie' || phase === 'after' } };
  const evaluator = SkillEvaluation.makeSkillEvaluator({ suites: [suite], runCase, io, clock: () => 1 });
  const proposed = { id: 'brief', name: 'Brief', body: 'Proposed instructions', scope: 'agent', files: [] };
  const active = { id: 'brief', name: 'Brief', body: 'Current instructions', scope: 'agent', files: [] };
  const storedRow = async m => { mode = m; await evaluator.evaluate({ candidate: proposed, baseline: active, suiteId: suite.id }); return store['skill-evaluation-receipts'].at(-1); };
  const passedRow = await storedRow('pass'), tieRow = await storedRow('tie'), deniedRow = await storedRow('denied');
  A.eq([passedRow.status, tieRow.status, deniedRow.status], ['passed', 'insufficient_evidence', 'insufficient_evidence'], 'the real evaluator stored a pass, a tie and a spend-denied run');
  // A candidate as serveSkillCandidates lists it: both digests come from SkillEvaluation.digestSkill (skillstore digestCandidate).
  const listed = latestEvaluation => ({ review: { candidates: [{ candidateId: 'candidate-4', revision: 4, skill: proposed, latestEvaluation,
    candidateDigest: SkillEvaluation.digestSkill(proposed), baseDigest: SkillEvaluation.digestSkill(active) }],
    evaluationSuites: [{ id: 'brief-checks', skillId: 'brief', description: 'Weekly brief checks' }] } });
  const reload = latestEvaluation => {
    const h = element(); ctx.host = h; ctx.review = listed(latestEvaluation).review;
    vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
    return h.children[0];
  };
  const card7 = reload(passedRow), sent = requests.length;
  A.ok(/^Last evaluation: Passed/.test(card7.querySelector('[data-evaluation-result]').textContent), 'a reloaded panel shows the last evaluation of this revision');
  A.eq(card7.querySelector('[data-candidate-approve]').disabled, false, 'a stored passing receipt keeps approval available');
  await card7.querySelector('[data-candidate-approve]').onclick();
  A.eq(requests.length, sent + 1, 'approval does not require paying for another evaluation');
  A.eq(requests.at(-1).body.evaluation, passedRow.receiptId, 'approval names the stored host receipt; the station re-verifies it');
  // A stored tie offers only the armed acknowledgement, exactly like a fresh one.
  const card9 = reload(tieRow);
  A.eq(card9.querySelector('[data-candidate-acknowledge]').hidden, false, 'a stored tie shows the acknowledgement');
  A.eq(card9.querySelector('[data-candidate-approve]').disabled, true, 'a stored tie never enables the measured approval');
  A.ok(/^Last evaluation: No improvement shown/.test(card9.querySelector('[data-evaluation-result]').textContent), 'a stored tie says no improvement was shown');
  // A stored refused run reads the same after a reload.
  const card10 = reload(deniedRow);
  A.ok(card10.querySelector('[data-evaluation-result]').textContent.includes('the station stopped a run (a budget limit'), 'a stored refused run lists what can stop one');
  A.eq(card10.querySelector('[data-candidate-acknowledge]').hidden, true, 'a stored spend-denied run offers no acknowledgement');
  // A provider error (an HTTP 429) on the first run leaves its cost unsettled, so the real accounting refuses every
  // later run and the runner writes 'policy-denied' for them. No budget limit or paused spending was involved, so
  // the card must not name one. Built with the real evaluator, runner, accounting and ledger modules.
  const Runner = require('../sidecar/skill-evaluation-runner.js');
  const { makeEvaluationAccounting } = require('../sidecar/skill-evaluation-accounting.js');
  const { makeLedger } = require('../sidecar/ledger.js');
  const unsettled = new Map(), booked = [];
  const ledger = makeLedger({ io: { readAll: () => booked.slice(), unsettled: () => [...unsettled.values()], beginRun: r => unsettled.set(r.runId, r),
    finishRun: e => unsettled.delete(e.runId), append: e => booked.push(e) }, clock: { now: () => 42 } });
  const accounting = makeEvaluationAccounting({ ledger, agentId: 'agent', provider: 'test', model: 'test/model' });
  const realRunCase = Runner.makeAgentLoopCaseRunner({ model: 'test/model', runIdPrefix: 'skills-lane', clock: { now: () => 0 },
    provider: { stream: async function* rateLimited() { throw Object.assign(new Error('rate limited'), { status: 429 }); } },
    cost: { reconcile: () => null }, limits: { maxIters: 2, maxCostUsd: 0.08, grace: false },
    authorize: async () => accounting.canContinue(), beforeRun: accounting.beforeRun,
    beforeStream: ({ spentUsd }) => accounting.canContinue(spentUsd), onStream: accounting.onStream, onRun: accounting.onRun });
  await SkillEvaluation.makeSkillEvaluator({ suites: [suite], runCase: realRunCase, io, clock: () => 2 }).evaluate({ candidate: proposed, baseline: active, suiteId: suite.id });
  const erroredRow = store['skill-evaluation-receipts'].at(-1);
  A.eq(erroredRow.cases.map(c => [c.before.reason, c.after.reason]), [['runner-error', 'policy-denied'], ['policy-denied', 'policy-denied']],
    'the real modules hold back every run after a failed one as policy-denied');
  const erroredText = reload(erroredRow).querySelector('[data-evaluation-result]').textContent;
  A.ok(!/budget|paused/i.test(erroredText), 'a run held back after a failed run names no budget limit or paused spending: ' + erroredText);
  A.ok(/a run failed/i.test(erroredText) && /held back every run after it/.test(erroredText), 'it says a run failed and the runs after it were held back: ' + erroredText);
  // A receipt for another revision (or another active version) never reads as this proposal's result.
  const stale = Object.assign({}, passedRow, { candidateDigest: SkillEvaluation.digestSkill(Object.assign({}, proposed, { body: 'An older proposal' })) });
  const untouched = async (card, why) => {
    const note = card.querySelector('[data-evaluation-result]'), before = requests.length;
    A.eq(note.textContent, '', why + ': the markup keeps "No evaluation run from this panel yet."');
    A.eq(note.children.length, 0, why + ': no receipt block');
    await card.querySelector('[data-candidate-approve]').onclick();
    A.eq(requests.length, before, why + ': approve sends nothing');
  };
  await untouched(reload(stale), 'a receipt for another revision is not shown as this one');
  await untouched(reload(Object.assign({}, passedRow, { baselineDigest: SkillEvaluation.digestSkill(null) })), 'a receipt measured against another active version is not shown');

  // skills-eval-17: a proposal whose base is no longer the active skill (the store lists it baseCurrent:false) can
  // only be rejected. The card says so and offers nothing the station would refuse, even with a passing receipt.
  const outdatedHost = element(); ctx.host = outdatedHost;
  ctx.review = { candidates: [Object.assign({}, listed(passedRow).review.candidates[0], { baseCurrent: false })], evaluationSuites: listed(passedRow).review.evaluationSuites };
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const outdated = outdatedHost.children[0];
  A.ok(outdated.html.includes('<span class="sk-badge miss">OUTDATED</span>') && !outdated.html.includes('PROPOSED REVISION'), 'an outdated proposal is badged OUTDATED');
  A.ok(outdated.html.includes('The active skill changed after this was proposed. Reject it, or wait for the agent\'s next revision.'), 'it says why and what the Commander can do');
  for (const attr of ['data-evaluation-suites', 'data-candidate-approve', 'data-candidate-acknowledge', 'data-suite-register', 'data-suite-json'])
    A.ok(!outdated.html.includes(attr), 'an outdated proposal has no ' + attr);
  A.ok(!/Last evaluation|Passed/.test(outdated.querySelector('[data-evaluation-result]').textContent), 'a stored receipt is not offered on an outdated proposal');
  const outdatedReject = outdated.querySelector('[data-candidate-reject]');
  A.ok(outdatedReject && outdatedReject.armed, 'Reject stays, armed as usual');
  await outdatedReject.armed.onConfirm();
  A.ok(requests.at(-1).path.endsWith('/reject-candidate') && requests.at(-1).body.candidateId === 'candidate-4', 'Reject sends the outdated proposal');
  // A fresh proposal (baseCurrent true, or a host that does not send the field) keeps every control.
  for (const baseCurrent of [true, undefined]) {
    const h = element(); ctx.host = h;
    ctx.review = { candidates: [Object.assign({}, listed(null).review.candidates[0], { baseCurrent })], evaluationSuites: listed(null).review.evaluationSuites };
    vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
    A.ok(h.children[0].html.includes('PROPOSED REVISION') && h.children[0].html.includes('data-candidate-approve') && h.children[0].html.includes('data-suite-register'), 'baseCurrent ' + baseCurrent + ' keeps the full card');
  }

  // skills-eval-07: an archive proposal names the skill it archives into, so the Commander approves that one first.
  const archiveHost = element(); ctx.host = archiveHost;
  ctx.review = { candidates: [{ candidateId: 'weekly-candidate-1', candidateDigest: 'archive-sha', revision: 1, baseCurrent: true,
    skill: { id: 'weekly', name: 'Weekly brief', body: 'Old steps', scope: 'agent', files: [], state: 'archived', absorbedInto: 'Reports' } }], evaluationSuites: [] };
  vm.runInNewContext('renderSkillCandidates(host, "agent", review);', ctx);
  const archiveCard = archiveHost.children[0];
  A.ok(archiveCard.html.includes('<div class="sk-attr">Archives into: Reports</div>'), 'an archive proposal shows its heir');
  // the metadata is a labelled list since the old-UI review (10-26 #1), not a raw JSON blob — it still names the heir
  A.ok(archiveCard.html.includes('<dt>Archives into</dt><dd>Reports</dd>'), 'the proposed metadata carries absorbedInto');
  A.ok(!card.html.includes('Archives into'), 'a content revision shows no heir line');
}

// Review finding world-render-10: Change sharing speaks plain words, marks the current choice, asks for a
// project folder only for This project, and a second click on Change sharing closes it.
async function checkSkillSharing() {
  function node(tag, cls) {
    const n = { tag, className: cls || '', children: [], dataset: {}, attrs: {}, hidden: false, disabled: false, textContent: '', value: '', parent: null,
      appendChild(c) { c.parent = n; n.children.push(c); return c; },
      remove() { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; },
      setAttribute(k, v) { n.attrs[k] = String(v); }, focus() { n.focused = true; },
      querySelector(sel) {
        const want = sel === '.sk-body' ? c => /(^| )sk-body( |$)/.test(c.className) : sel === '[data-skill-sharing]' ? c => !!c.dataset.skillSharing : () => false;
        for (const c of n.children) { if (want(c)) return c; const d = c.querySelector(sel); if (d) return d; }
        return null;
      } };
    return n;
  }
  const consts = source.slice(source.indexOf('  // Skill sharing in plain words'), source.indexOf('  function renderAgentSkills('));
  const fn = source.slice(source.indexOf('  function toggleSkillSharing('), source.indexOf('  function editAgentSkill('));
  A.ok(consts.includes('SKILL_SCOPE_LABEL') && fn.includes('function toggleSkillSharing'), 'sharing helpers are present');
  const posts = [], reloads = [];
  const card = node('div', 'sk-card'), body = card.appendChild(node('div', 'sk-body'));
  const ctx = { card, mkEl: node, loadAgentSkills: id => reloads.push(id),
    skillReviewPost: async (action, payload) => { posts.push({ action, payload }); return { ok: true }; },
    skill: { id: 'brief', scope: 'agent', projectRoot: '' } };
  vm.runInNewContext(consts + fn + '\ntoggleSkillSharing(card, skill, "nova");', ctx);
  const panel = body.querySelector('[data-skill-sharing]');
  A.ok(panel, 'Change sharing opens the panel');
  const row = panel.children.find(c => /consent-btns/.test(c.className)), buttons = row.children;
  A.eq(buttons.map(b => b.textContent), ['Only this agent', 'This project', 'Whole station'], 'scope buttons use plain words, not raw ids');
  A.eq(buttons.map(b => b.attrs['aria-pressed']), ['true', 'false', 'false'], 'the current sharing is marked');
  A.ok(/(^| )sel( |$)/.test(buttons[0].className), 'the current sharing has the selected skin');
  const input = panel.children.find(c => c.tag === 'input');
  A.eq(input.hidden, true, 'no folder field until This project is chosen');
  A.ok(panel.children[0].textContent.includes('just nova uses it'), 'the note says who uses each choice');
  await buttons[1].onclick();
  A.eq(posts.length, 0, 'choosing This project first asks for the folder');
  A.eq(input.hidden, false, 'the folder field appears for This project');
  input.value = 'C:/work/brief';
  await buttons[1].onclick();
  A.eq(posts.at(-1).payload, { agentId: 'nova', target: 'brief', scope: 'project', projectRoot: 'C:/work/brief' }, 'the second click shares with the folder');
  await buttons[2].onclick();
  A.eq(posts.at(-1).payload.projectRoot, '', 'a whole-station share sends no folder');
  A.eq(reloads, ['nova', 'nova'], 'each confirmed share reloads authoritative state');
  vm.runInNewContext('toggleSkillSharing(card, skill, "nova");', ctx);
  A.eq(body.querySelector('[data-skill-sharing]'), null, 'a second Change sharing click closes the panel');
  ctx.skill = { id: 'brief', scope: 'project', projectRoot: 'C:/work/brief' };
  vm.runInNewContext('toggleSkillSharing(card, skill, "nova");', ctx);
  const projectPanel = body.querySelector('[data-skill-sharing]');
  A.eq(projectPanel.children.find(c => c.tag === 'input').hidden, false, 'a project-shared skill shows its folder');
  A.eq(projectPanel.children.find(c => /consent-btns/.test(c.className)).children.map(b => b.attrs['aria-pressed']), ['false', 'true', 'false'], 'project sharing is marked current');
  A.report('abilities.skills-lane.test');
}
