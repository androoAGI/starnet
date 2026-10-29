/* node test/skills.delivery-scrub.test.js — skill text stored exact is scrubbed FIELD FIRST where it leaves, and no
   delivery seam falls back to the raw text (review round 2 of the canonical-bytes lane).

   The store keeps a skill's exact text and cuts a summary at 280 characters. A vendor key the cut leaves half-there is
   still found at the end of its own field (prompt-scrub's cut-key rule), but not once a composer has put text after it.

   A. skill.list / skill.view (M1): the registry scrubbed only the composed rows, so a summary cut inside a key left the
      fragment visible ('-- <summary> [active, used 0x]'). Each row is now scrubbed field by field first (deps.scrubSkills:
      the host's scrubSkillsForPrompt, the same field-first scrub the run index uses), and the registry scrubs the
      composed result again. A scrub that fails withholds the result; every host construction of the tools passes it.
   B. the export and the evaluation runner (M2) took the host's scrub as an option and, without one (or with one that
      returned a non-string), sent the exact text: an export left the station raw, a system prompt carried the key.
      Both now default to prompt-scrub's scrubStored, as interests.js and outcomes.js do, and never fall back to raw.
   C. a promotion is the Commander's next decision on a skill (M3): a restamped copy of an older approval
      (gate.restampApprovals) ends with it, as it does in the allow route (gate.dropRestamped, shared with
      supersedeApproval), and only once the promotion has landed.
   D. a write_file over the per-file limit names the file it refused (m-msg).
   Review round 3:
   E. the field scrub itself (skills/runtime.js scrubSkillText) never hands back raw text: a scrub that returns no string,
      or no scrub at all, throws (as the export and the evaluation runner stop), and skill.list over it is withheld.
   F. skill.list and skill.view built with no scrubSkills take the host's field-first scrub themselves (prompt-scrub
      scrubStored under one held read), so a construction that leaves it out shows no raw text; the identity, passed
      explicitly, is how a byte-path test reads the stored text.
   G. a promotion whose drop of the restamped copies is not saved answers with a `warning` (the promotion stands; the
      host's own route code, run in a sandbox), and the next start drops a copy older than the skill's panel decision or
      a precommit (gate.pruneRestamped, wired at boot after restampApprovals); a copy of the latest decision, or of bytes
      approved again later, stays.
   H. an export refuses a support file whose path holds a credential, naming it by its scrubbed path: a path cannot be
      rewritten like the file's text, and it left the station raw. */
'use strict';
const A = require('./_assert.js');
const PS = require('../sidecar/prompt-scrub.js');
const ctxMod = require('../sidecar/context.js');
const runtime = require('../sidecar/skills/runtime.js');
const gateMod = require('../sidecar/skills/gate.js');
const packageFormat = require('../sidecar/skills/package-format.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');
const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
const { makeSkillExchange } = require('../sidecar/skills/exchange.js');
const { makeAgentLoopCaseRunner } = require('../sidecar/skill-evaluation-runner.js');
const { readSidecarSource, sidecarFunctionSource } = require('./helpers/source.js');

const KEYS = { openai: 'sk-proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f', github: 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c', google: 'AIza' + 'SyAb3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z' };
const PW = 'Summer2024!rocks';
// the host's own field-first scrub (index.js scrubSkillsForPrompt), as the tools are handed it
const hostScrubSkills = (list) => PS.withHeld(() => (Array.isArray(list) ? list : []).map(s => runtime.scrubSkillText(s, PS.scrubStored)));
const newStore = () => { const rows = []; return makeSkillStore({ io: { readAll: () => rows, append: (r) => rows.push(r) }, clock: { now: () => 1 }, stageReviews: false, redact: (s) => ctxMod.redact(s) }); };
const visibleGate = { decide: () => ({ visible: true }), verify: () => ({ visible: true }) };
async function dispatch(store, name, args, deps) {
  const reg = makeRegistry();
  makeSkillTools(Object.assign({ store, gate: visibleGate }, deps || {})).register(reg);
  attachResultScrub(PS.scrubStored);
  try { return await reg.dispatch({ id: 'c', name, args: args || {} }, { agentId: 'a' }); } finally { attachResultScrub(null); }
}

(async () => {
  // ---- A. skill.list and skill.view: each field scrubbed before the row is composed ----
  {
    const cuts = [];
    for (const [kind, KEY] of Object.entries(KEYS)) for (const keep of [14, 18, 22, 26]) {
      const store = newStore();
      // an installed (sealed) package is stored verbatim; the store cuts the summary at 280, inside the key
      const pf = [{ path: 'SKILL.md', encoding: 'base64', content: Buffer.from('---\nname: x\n---\nbody').toString('base64'), bytes: 20, sha256: 'a'.repeat(64) }];
      const made = store.manage({ action: 'create', agentId: 'a', name: 'Inst', summary: 'x'.repeat(280 - keep - 1) + ' ' + KEY, body: 'steps', createdBy: 'community',
        sourceUrl: 'https://e.x/SKILL.md', packageDigest: 'd'.repeat(64), packageFiles: pf, packageDiverged: false });
      if (!made.ok) { A.ok(false, 'A: precondition, the install is stored (' + made.error + ')'); continue; }
      const frag = KEY.slice(0, keep);
      A.ok(store.list('a')[0].summary.endsWith(frag), 'A: precondition, the stored summary ends in the cut ' + kind + ' key (' + keep + ' chars)');
      const list = String((await dispatch(store, 'skill.list', {}, { scrubSkills: hostScrubSkills })).content);
      const view = String((await dispatch(store, 'skill.view', { name: 'Inst' }, { scrubSkills: hostScrubSkills })).content);
      if (list.includes(frag) || view.includes(frag)) cuts.push(kind + '/' + keep + (list.includes(frag) ? ' list' : '') + (view.includes(frag) ? ' view' : ''));
      if (kind === 'github' && keep === 14) A.ok(/^- Inst \[owner: a, scope: agent\] -- x+ .*\[active, used 0x\]/.test(list), 'A: the row is still the row: ' + list.slice(0, 80).replace(/x{20,}/, 'x…'));
    }
    A.eq(cuts, [], 'A: no fragment of a key the summary cut leaves reaches skill.list or skill.view');

    // the support file's text and path, and the setup: scrubbed in the view, and still shown
    const store = newStore();
    store.manage({ action: 'create', agentId: 'a', name: 'Deploy', summary: 'deploy it', body: '1. run it', setup: 'needs bash', createdBy: 'agent' });
    // a support file is stored as its exact bytes (an authored body is still redacted at the store)
    store.manage({ action: 'write_file', agentId: 'a', target: 'Deploy', path: 'scripts/deploy.sh', content: 'export OPENAI_API_KEY=' + KEYS.openai + '\npassword=' + PW + '\n./deploy\n', createdBy: 'agent' });
    const view = String((await dispatch(store, 'skill.view', { name: 'Deploy' }, { scrubSkills: hostScrubSkills })).content);
    A.ok(!view.includes(KEYS.openai) && !view.includes(PW), 'A: the view carries no key and no password');
    A.ok(/Setup:\nneeds bash/.test(view) && /- scripts\/deploy\.sh\nexport OPENAI_API_KEY=/.test(view) && /\n1\. run it/.test(view) && /\.\/deploy/.test(view), 'A: ...and is still the whole view (setup, body, file)');
    // the gate decides from the record as stored, never the scrubbed copy
    let decided = null;
    await dispatch(store, 'skill.view', { name: 'Deploy' }, { scrubSkills: hostScrubSkills, gate: { decide: () => ({ visible: true }), verify: (s) => { decided = s; return { visible: true }; } } });
    A.ok(!!decided && JSON.stringify(decided.files || []).includes(KEYS.openai), 'A: the delivery gate verifies the stored record, not the scrubbed copy');

    // a scrub that fails withholds the result: never the raw row
    const broken = String((await dispatch(store, 'skill.list', {}, { scrubSkills: () => null })).content);
    A.ok(!broken.includes('deploy it') && /failed/.test(broken), 'A: a field scrub that returns no list withholds skill.list (' + broken.slice(0, 120) + ')');
    const brokenView = String((await dispatch(store, 'skill.view', { name: 'Deploy' }, { scrubSkills: () => { throw new Error('scrub down'); } })).content);
    A.ok(!brokenView.includes('./deploy') && /failed/.test(brokenView), 'A: a field scrub that throws withholds skill.view (' + brokenView.slice(0, 120) + ')');

    // every host construction of the skill tools hands them the field-first scrub
    const src = readSidecarSource();
    const sites = [];
    for (let i = src.indexOf('makeSkillTools({'); i >= 0; i = src.indexOf('makeSkillTools({', i + 1)) sites.push(src.slice(i, i + 1400));
    A.ok(sites.length >= 3, 'A: the host builds the skill tools for the run, the review and the curator (' + sites.length + ' sites)');
    A.eq(sites.filter(s => !/\bscrubSkills: scrubSkillsForPrompt\b/.test(s.slice(0, s.indexOf('.register(registry)')))).length, 0, 'A: each passes scrubSkills: scrubSkillsForPrompt');
    A.ok(/PromptScrub\.withHeld\(\(\) => \(Array\.isArray\(list\) \? list : \[\]\)\.map\(s => runtimeSkills\.scrubSkillText\(s, PromptScrub\.scrubStored\)\)\)/.test(sidecarFunctionSource('scrubSkillsForPrompt')),
      'A: scrubSkillsForPrompt is the field-first stored-text scrub, one held read per call');
  }

  // ---- B. the export and the evaluation runner default to the stored-text scrub, and never fall back to raw ----
  {
    const store = newStore();
    const made = store.manage({ action: 'create', agentId: 'a', name: 'Ship', summary: 'ship it', body: '1. run scripts/ship.sh\n2. ship', createdBy: 'user' });
    const id = made.skill.id;
    store.manage({ action: 'write_file', agentId: 'a', target: id, path: 'scripts/ship.sh', content: 'export GITHUB_TOKEN=' + KEYS.github + '\npassword=' + PW + '\n./ship\n', createdBy: 'user' });
    A.ok(JSON.stringify(store.view('a', id, { bump: false }).files).includes(KEYS.github), 'B: precondition, the support file is stored exact');
    const leaves = (envelope) => { const pkg = packageFormat.fromEnvelope(envelope); return pkg.files.map(f => Buffer.from(f.content, 'base64').toString('utf8')).join('\n') + JSON.stringify(JSON.parse(envelope).metadata || {}); };
    const plain = makeSkillExchange({ skillStore: store, hash: (s) => String(s).length, now: () => 1 });
    const out = leaves(plain.exportPackage({ agentId: 'a', id }).envelope);
    A.ok(!out.includes(KEYS.github) && !out.includes(PW) && /\.\/ship/.test(out) && /2\. ship/.test(out),'B export: with no scrub injected, an export leaves scrubbed (prompt-scrub scrubStored)');
    const odd = makeSkillExchange({ skillStore: store, hash: (s) => String(s).length, now: () => 1, scrubText: () => undefined });
    let oddOut = null, oddErr = null;
    try { oddOut = leaves(odd.exportPackage({ agentId: 'a', id }).envelope); } catch (e) { oddErr = e; }
    A.ok(!!oddErr && !(oddOut || '').includes(KEYS.github), 'B export: a scrub that returns no text stops the export (nothing leaves raw): ' + (oddErr ? oddErr.message : 'exported'));

    const skill = store.view('a', id, { bump: false });
    const evalSystem = async (opts) => {
      let system = '';
      const runCase = makeAgentLoopCaseRunner(Object.assign({ provider: { stream: async function* () {} }, runIdPrefix: 'delivery',
        runAgentLoop: async (args) => { system = args.messages[0].content; return { reason: 'done', messages: [] }; } }, opts));
      let error = null;
      try { await runCase({ task: { id: 't', prompt: 'do it', fixtures: {} }, skill, phase: 'candidate' }); } catch (e) { error = e; }
      return { system, error };
    };
    const dflt = await evalSystem({});
    A.ok(!dflt.error && /Procedure under evaluation:/.test(dflt.system) && !dflt.system.includes(KEYS.github) && !dflt.system.includes(PW), 'B evaluation: with no scrub injected, the system prompt is scrubbed');
    const bad = await evalSystem({ scrub: () => 42 });
    A.ok(!bad.system.includes(KEYS.github) && !bad.system.includes(PW), 'B evaluation: a scrub that returns no text never sends the raw procedure' + (bad.error ? ' (' + bad.error.message + ')' : ''));
  }

  // ---- C. a promotion ends a restamped copy of an older approval ----
  {
    A.ok(typeof gateMod.dropRestamped === 'function', 'C: gate.dropRestamped is exported');
    if (typeof gateMod.dropRestamped === 'function') {
      const approvals = {
        'a\x00s': { digest: 'd0', action: 'allow' },
        'a\x00s\x00d1': { digest: 'd1', action: 'allow', restampedFrom: 'd0' },
        'a\x00s\x00d2': { digest: 'd2', action: 'allow' },                   // a promotion's precommit: not a copy
        'a\x00t\x00d3': { digest: 'd3', action: 'allow', restampedFrom: 'x' }, // another skill's copy
        'a\x00st\x00d4': { digest: 'd4', action: 'allow', restampedFrom: 'x' } // a skill whose id merely starts the same
      };
      const next = gateMod.dropRestamped(approvals, 'a\x00s');
      A.eq(Object.keys(next).sort(), ['a\x00s', 'a\x00s\x00d2', 'a\x00st\x00d4', 'a\x00t\x00d3'], 'C: dropRestamped removes only that skill\'s restamped copies');
      A.ok(Object.keys(approvals).length === 5, 'C: ...and returns a new map (the input is untouched)');
      const sup = gateMod.supersedeApproval(approvals, 'a\x00s', { digest: 'd9', action: 'allow' });
      A.eq(Object.keys(sup).sort(), ['a\x00s', 'a\x00s\x00d2', 'a\x00st\x00d4', 'a\x00t\x00d3'], 'C: supersedeApproval still drops the copies and writes the decision');
      A.eq(sup['a\x00s'].digest, 'd9', 'C: ...holding the new decision');
    }
    const route = sidecarFunctionSource('handleSkillCandidateAction');
    const branch = route.slice(route.indexOf("if (action === 'approve-candidate')"), route.indexOf("if (action !== 'evaluate-candidate')"));
    const approveAt = branch.indexOf('skillStore.approveCandidate(');
    const dropAt = branch.indexOf('dropRestampedSkillApprovals(skillApprovals, agentId + \'\\x00\' + candidate.skill.id)');
    A.ok(approveAt > 0 && dropAt > approveAt, 'C: the promotion route drops the restamped copies once approveCandidate has run');
    A.ok(dropAt > 0 && /if \(result\.ok\) \{/.test(branch.slice(approveAt, dropAt)), 'C: ...only when the promotion landed (until then a copy may keep the active version approved)');
    A.ok(/const \{[^}]*dropRestamped: dropRestampedSkillApprovals[^}]*\} = require\('\.\/skills\/gate\.js'\)/.test(readSidecarSource()), 'C: the host takes dropRestamped from skills/gate.js');
  }

  // ---- D. a write_file over the per-file limit names the file ----
  {
    const rows = [];
    const store = makeSkillStore({ io: { readAll: () => rows, append: (r) => rows.push(r) }, clock: { now: () => 1 }, stageReviews: false, supportFileMax: 1000 });
    store.manage({ action: 'create', agentId: 'a', name: 'Big', summary: 's', body: 'b', createdBy: 'agent' });
    const r = store.manage({ action: 'write_file', agentId: 'a', target: 'Big', path: 'references/huge.md', content: 'y'.repeat(1001), createdBy: 'agent' });
    A.ok(!r.ok && /references\/huge\.md/.test(String(r.error)) && /1001 bytes, over the 1000-byte limit/.test(String(r.error)), 'D: the refusal names the file and its size: ' + r.error);
  }

  // an installed (sealed) package, stored verbatim, whose summary holds a whole key
  const installWithKey = (store, name, key) => store.manage({ action: 'create', agentId: 'a', name, summary: 'ships with ' + key, body: 'steps', createdBy: 'community',
    sourceUrl: 'https://e.x/' + name + '/SKILL.md', packageDigest: 'd'.repeat(64), packageDiverged: false,
    packageFiles: [{ path: 'SKILL.md', encoding: 'base64', content: Buffer.from('---\nname: x\n---\nbody').toString('base64'), bytes: 20, sha256: 'a'.repeat(64) }] });

  // ---- E. the field scrub never hands back the raw text ----
  {
    const sk = { name: 'S', summary: 'uses ' + KEYS.openai, body: 'b', files: [{ path: 'references/a.md', content: 'token ' + KEYS.github }] };
    const tryScrub = (scrub) => { try { return { out: runtime.scrubSkillText(sk, scrub) }; } catch (e) { return { error: e }; } };
    const odd = tryScrub(() => 42), none = tryScrub(null), ok = tryScrub(PS.scrubStored);
    A.ok(!!odd.error && !odd.out, 'E: a field scrub that returns no string throws, never the raw field (' + (odd.error ? odd.error.message : JSON.stringify(odd.out).slice(0, 80)) + ')');
    A.ok(!!none.error && !none.out, 'E: no scrub at all throws, never the raw skill (' + (none.error ? none.error.message : JSON.stringify(none.out).slice(0, 80)) + ')');
    A.ok(!ok.error && !JSON.stringify(ok.out).includes(KEYS.openai) && !JSON.stringify(ok.out).includes(KEYS.github), 'E: ...while the stored-text scrub scrubs every field');
    const store = newStore();
    A.ok(installWithKey(store, 'Inst', KEYS.openai).ok, 'E: precondition, the install is stored');
    // the tool's own output (no registry scrub after it): the field scrub is the only one
    const tools = makeSkillTools({ store, gate: visibleGate, scrubSkills: (l) => l.map(s => runtime.scrubSkillText(s, () => undefined)) });
    let listOut = null, listErr = null;
    try { listOut = (await tools.listTool.run({}, { agentId: 'a' })).content; } catch (e) { listErr = e; }
    A.ok(!!listErr && !String(listOut || '').includes(KEYS.openai), 'E: skill.list over a field scrub that returns no text is withheld (' + (listErr ? listErr.message : String(listOut).slice(0, 80)) + ')');
  }

  // ---- F. with no scrubSkills passed, the skill tools scrub each field themselves ----
  {
    const store = newStore();
    A.ok(installWithKey(store, 'Inst', KEYS.google).ok, 'F: precondition, the install is stored');
    store.manage({ action: 'create', agentId: 'a', name: 'Deploy', summary: 'deploy it', body: '1. run it', createdBy: 'agent' });
    store.manage({ action: 'write_file', agentId: 'a', target: 'Deploy', path: 'scripts/deploy.sh', content: 'export OPENAI_API_KEY=' + KEYS.openai + '\npassword=' + PW + '\n./deploy\n', createdBy: 'agent' });
    const bare = makeSkillTools({ store, gate: visibleGate });   // no scrubSkills, and no registry scrub after the tool
    const list = String((await bare.listTool.run({}, { agentId: 'a' })).content);
    const view = String((await bare.viewTool.run({ name: 'Deploy' }, { agentId: 'a' })).content);
    A.ok(!list.includes(KEYS.google) && /- Inst /.test(list) && /- Deploy /.test(list), 'F: skill.list with no scrubSkills shows each row scrubbed (' + list.slice(0, 120) + ')');
    A.ok(!view.includes(KEYS.openai) && !view.includes(PW) && /- scripts\/deploy\.sh\nexport OPENAI_API_KEY=/.test(view) && /\.\/deploy/.test(view), 'F: skill.view with no scrubSkills shows the file scrubbed, and whole');
    const raw = makeSkillTools({ store, gate: visibleGate, scrubSkills: (l) => l });
    A.ok(String((await raw.viewTool.run({ name: 'Deploy' }, { agentId: 'a' })).content).includes(KEYS.openai), 'F: the identity, passed explicitly, shows the stored text as it is (what a byte-path test reads)');
  }

  // ---- G. a promotion whose drop of the restamped copies is not saved says so; the next start drops them ----
  {
    A.ok(typeof gateMod.pruneRestamped === 'function', 'G: gate.pruneRestamped is exported');
    const prune = typeof gateMod.pruneRestamped === 'function' ? gateMod.pruneRestamped : () => null;
    const ap = {
      'a\x00s': { digest: 'd0', action: 'allow', at: 100 },                               // the panel's decision
      'a\x00s\x00d1': { digest: 'd1', action: 'allow', at: 100, restampedFrom: 'd0' },    // its carried-over copy
      'a\x00s\x00cand': { digest: 'cand', action: 'allow', at: 300 },                     // a later promotion's precommit
      'a\x00s\x00d5': { digest: 'd5', action: 'allow', at: 50, restampedFrom: 'd4' },     // a copy older than the panel's decision
      'a\x00t': { digest: 't0', action: 'allow', at: 500 },
      'a\x00t\x00t1': { digest: 't1', action: 'allow', at: 500, restampedFrom: 't0' },    // a copy of the latest decision
      'a\x00u': { digest: 'u0', action: 'allow', at: 200 },
      'a\x00u\x00u1': { digest: 'u1', action: 'allow', at: 100, restampedFrom: 'u0' }     // the same bytes, approved again later
    };
    const pruned = prune(ap);
    A.eq(Object.keys(pruned || ap).map(k => k.split('\x00').join('|')).sort(), ['a|s', 'a|s|cand', 'a|t', 'a|t|t1', 'a|u', 'a|u|u1'],
      'G: pruneRestamped drops each copy a later decision on another version superseded, and keeps every decision');
    A.eq(Object.keys(ap).length, 8, 'G: ...and returns a new map (the input is untouched)');
    A.eq(prune({ 'a\x00t': ap['a\x00t'], 'a\x00t\x00t1': ap['a\x00t\x00t1'] }), null, 'G: nothing superseded is null (nothing is written at boot)');
    const src = readSidecarSource();
    const boot = src.slice(src.indexOf('restampSkillApprovals(skillApprovals, skillStore.digestRestamps())'), src.indexOf("failNote('skills.approval-restamp'"));
    A.ok(/const pruned = pruneRestampedSkillApprovals\(moved \|\| skillApprovals\);/.test(boot) && /if \(moved \|\| pruned\) persistSkillApprovals\(pruned \|\| moved\);/.test(boot),
      'G: the boot prunes superseded copies after the re-stamp carries approvals over, and persists either change once');
    A.ok(/pruneRestamped: pruneRestampedSkillApprovals[^}]*\} = require\('\.\/skills\/gate\.js'\)/.test(src), 'G: the host takes pruneRestamped from skills/gate.js');

    // the promotion route itself (index.js handleSkillCandidateAction), in a sandbox: the precommit lands, the drop's write fails
    const vm = require('vm');
    const routeSrc = sidecarFunctionSource('handleSkillCandidateAction');
    const promote = async (failDrop) => {
      const notes = [];
      let writes = 0;
      const cand = { candidateId: 'c1', status: 'pending', candidateDigest: 'cd', baseDigest: 'bd', name: 'S', skill: { id: 's', name: 'S', body: 'new' } };
      const g = {
        URL, console, Buffer,
        skillApprovals: { 'a\x00s': { digest: 'd0', action: 'allow', at: 100 }, 'a\x00s\x00d1': { digest: 'd1', action: 'allow', at: 100, restampedFrom: 'd0' } },
        readBody: async () => JSON.stringify({ agentId: 'a', candidateId: 'c1', candidateDigest: 'cd', receiptId: 'r1' }),
        learningJson: (res, code, value) => { res.code = code; res.body = value; },
        isAgentId: () => true,
        skillStore: { candidate: () => cand, promotionBlocker: () => '', view: () => ({ id: 's', body: 'old' }), approveCandidate: () => ({ ok: true, skill: { id: 's', name: 'S' } }) },
        skillGate: { verify: () => ({ action: 'allow' }), digestOf: () => 'cand' },
        verifySkillPromotion: () => ({ ok: true, receiptId: 'r1' }),
        SkillEvaluation: { digestSkill: () => 'bd' },
        persistSkillApprovals: (next) => { writes++; if (failDrop && writes > 1) throw new Error('disk full'); g.skillApprovals = next; return true; },
        dropRestampedSkillApprovals: gateMod.dropRestamped,
        failNote: (tag) => notes.push(tag),
        chanEmit: () => {}
      };
      vm.createContext(g);
      const route = vm.runInContext('(' + routeSrc + ')', g);
      const res = {};
      await route({ url: '/api/skill-candidates/approve-candidate' }, res);
      return { res, notes, approvals: g.skillApprovals };
    };
    const failed = await promote(true);
    A.eq([failed.res.code, failed.res.body && failed.res.body.ok], [200, true], 'G route: precondition, the promotion lands (' + JSON.stringify(failed.res.body) + ')');
    A.ok(/could not be cleared/.test(String(failed.res.body && failed.res.body.warning)) && /disk full/.test(String(failed.res.body && failed.res.body.warning)),
      'G route: a drop whose write fails answers with a warning naming the failure: ' + JSON.stringify(failed.res.body && failed.res.body.warning));
    A.ok(failed.notes.indexOf('skills.promote.restamped') >= 0, 'G route: ...and notes it');
    A.ok(!!failed.approvals['a\x00s\x00d1'] && !!failed.approvals['a\x00s\x00cand'], 'G route: precondition, the copy is still saved beside the precommit');
    const atBoot = prune(failed.approvals) || failed.approvals;
    A.ok(!atBoot['a\x00s\x00d1'] && !!atBoot['a\x00s\x00cand'] && !!atBoot['a\x00s'], 'G route: the next start drops the copy (older than the precommit) and keeps every decision');
    const landed = await promote(false);
    A.ok(landed.res.code === 200 && !('warning' in (landed.res.body || {})) && !landed.approvals['a\x00s\x00d1'], 'G route: a drop that is saved answers with no warning');
  }

  // ---- H. an export refuses a support-file path that holds a credential ----
  {
    const store = newStore();
    const made = store.manage({ action: 'create', agentId: 'a', name: 'Paths', summary: 'p', body: '1. go', createdBy: 'user' });
    const id = made.skill.id;
    const w = store.manage({ action: 'write_file', agentId: 'a', target: id, path: 'references/' + KEYS.github + '.md', content: 'notes\n', createdBy: 'user' });
    A.ok(w.ok && (store.view('a', id, { bump: false }).files || []).some(f => f.path.includes(KEYS.github)), 'H: precondition, the file is stored under that path (' + (w.error || '') + ')');
    const ex = makeSkillExchange({ skillStore: store, hash: (s) => String(s).length, now: () => 1 });
    let env = null, err = null;
    try { env = ex.exportPackage({ agentId: 'a', id }).envelope; } catch (e) { err = e; }
    A.ok(!!err && !env, 'H: the export is refused' + (env ? ' (it left: ' + JSON.stringify(packageFormat.fromEnvelope(env).files.map(f => f.path)) + ')' : ''));
    A.ok(!!err && /^references\/.*\.md looks like it holds a credential, so the skill was not exported$/.test(err.message), 'H: ...naming the file: ' + (err && err.message));
    A.ok(!!err && !err.message.includes(KEYS.github), 'H: ...by its scrubbed path (the refusal carries no key)');
    store.manage({ action: 'remove_file', agentId: 'a', target: id, path: 'references/' + KEYS.github + '.md', createdBy: 'user' });
    store.manage({ action: 'write_file', agentId: 'a', target: id, path: 'references/notes.md', content: 'notes\n', createdBy: 'user' });
    A.ok(packageFormat.fromEnvelope(ex.exportPackage({ agentId: 'a', id }).envelope).files.some(f => f.path === 'references/notes.md'), 'H: a skill whose paths are clean exports');
  }

  A.report('skills.delivery-scrub.test');
})().catch(e => { attachResultScrub(null); console.log('FAIL: skills.delivery-scrub.test threw -- ' + (e && e.stack || e)); process.exit(1); });
