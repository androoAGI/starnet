/* node test/scout.e2e.test.js — TRUE end-to-end proof of the SCOUT ORCHESTRATION (runScoutCycle).

   scout.http.test.js proves the ROUTES over pre-seeded state but never fires a run — the whole
   activity→extract→fold→persist→decide→draft→stage→ledger chain in sidecar/index.js had no test; a broken
   hop silently no-ops (the exact anti-pattern the scout lane exists to kill). This suite boots the REAL
   sidecar with a mock OpenRouter and drives REAL task runs so the post-run scout hook fires, then asserts
   against server truth (GET /api/scout + the files on disk):

   BOOT 1 — THE HAPPY CHAIN (cold interests, prospect shelf pre-filled so the mint routes to 'recipe'):
     · real runs feed the cadence counters; the extraction pass fires off REAL activity lines;
     · the mock's TOPIC/EVIDENCE reply (whose evidence quotes the actual run directives) folds into the
       histogram, persists to scout.interests.json, and flips warm;
     · the mint gate fires, the recipe directive goes to the model, the well-formed grounded reply parses,
       a recipe draft is STAGED, and the ledger records both hops (interests folded + recipe staged).

   BOOT 2 — THE HONEST-FAILURE CHAIN (anti-silent-no-op; warm pre-seeded so the mint attempt fires):
     · a well-formed recipe whose WHY cites NOTHING the station observed is rejected by the grounding
       guard: NO draft staged + a 'rejected' ledger note (visible failure, never a quiet nothing);
     · an extraction reply with INVENTED evidence folds to zero topics + an honest 'none' ledger note.

   BOOT 3 — the archetype-seeded prospect mint (zero model spend).
   BOOT 4 — a personalization PAUSE that lands while the extraction call is in flight wins: nothing folded,
     persisted or noted from the late reply, and its spend is still booked.

   ZERO network, zero real key (the run key is a fake routed to the mock). Part of test:http. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const Specialties = require('../shared/specialties.js');
const Interests = require('../sidecar/interests.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BROKER = Specialties.ARCHETYPES.find(spec => spec && spec.id === 'broker');
A.ok(BROKER && BROKER.name, 'the canonical broker archetype is present in the live catalog');

/* ---- the mock OpenRouter: routes on the prompt's marker (extraction vs recipe vs the main run) ---- */
function startMock(replies) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const pricing = replies.priced ? { prompt: '0.000001', completion: '0.000002' } : { prompt: '0', completion: '0' };   // priced: spend is observable in the ledger
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', async () => {
          // holdExtraction: the extraction call stays in flight until the test calls mock.release() (pause-mid-flight arm)
          if (replies.holdExtraction && body.indexOf('intake analyst') >= 0) await new Promise(r => { held.release = r; held.extraction = true; });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const text = (t, usage) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: usage || { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          if (body.indexOf('intake analyst') >= 0) { calls.push('extraction'); text(replies.extraction, replies.extractionUsage); }        // interests.buildDirective's system marker
          else if (body.indexOf('recipe author') >= 0) { calls.push('recipe'); text(replies.recipe); }            // scout.buildRecipeDirective's system marker
          else if (body.indexOf("station's recruiter") >= 0) { calls.push('recruiter'); text(replies.prospect || 'NONE'); }   // the LLM prospect authorship pass
          else { calls.push('run'); text('ok, done.'); }                                                          // the main task run itself
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const calls = [];   // which model passes actually fired — lets a boot assert a pass did NOT run (zero-spend paths)
    const held = { extraction: false, release: null };
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1', calls, held,
      release: () => { if (held.release) held.release(); } }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

/* pre-seed the scout state: the mint gate already EARNED (runsSinceMint past the floor, no prior mint) and
   the prospect shelf FULL — so decide() deterministically routes the one attempt to kind:'recipe'. This seeds
   only the cadence knobs; the chain under test (activity→extract→fold→decide→draft→stage→ledger) runs live. */
function seedScoutState(ws) {
  const staged = [0, 1, 2].map(i => ({
    id: 'seed-p' + i, kind: 'prospect', why: 'seed', fingerprint: 'seed fp ' + i, at: Date.now() - 3600000,
    draft: { name: 'Seed Prospect ' + i, tagline: 'occupies a prospect slot ' + i }
  }));
  fs.writeFileSync(path.join(ws, 'scout.state.json'), JSON.stringify({
    v: 1, state: { v: 1, staged, denylist: [], ledger: [], runsSinceMint: 5, lastMintAt: 0, lastKind: '', context: null }
  }));
}

// Positive persisted fixtures represent post-repair, clean observed activity. Old cache behavior
// remains a separate negative in scout.http.test.js; do not promote legacy topics by hydration.
function trustedInterests(label, now) {
  const candidates = Interests.parse('TOPIC: ' + label + ' | EVIDENCE: ' + label,
    { activityLines: ['Observed clean work: ' + label], requireExactEvidence: true });
  let state = Interests.fresh(now);
  for (let i = 0; i < 5; i++) state = Interests.fold(state, candidates, { now, trustedActivity: true });
  return state;
}

async function driveRun(B, token, agentId, text) {
  const r = await fetch(B + '/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
    body: JSON.stringify({ key: 'sk-or-v1-scout-fake', model: 'test/model', agentId, isTask: true, messages: [{ role: 'user', content: text }] })
  });
  const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }   // drain to run end
}

// poll GET /api/scout until pred(payload) holds (the cycle is fire-and-forget post-run) — or time out honestly.
async function pollScout(B, token, pred, label, ms) {
  const until = Date.now() + (ms || 15000);
  let last = null;
  while (Date.now() < until) {
    try { last = await (await fetch(B + '/api/scout', { headers: { 'X-StarNet-Token': token, Origin: B } })).json(); } catch (_) {}
    if (last && pred(last)) return last;
    await sleep(250);
  }
  throw new Error('timed out waiting for: ' + label + '\nlast /api/scout: ' + JSON.stringify(last));
}

const QUIET = { SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0' };

(async () => {
  /* ================= BOOT 1 — the happy chain ================= */
  {
    const mock = await startMock({
      // evidence is a verbatim fragment of the run directives below — the grounding guard must pass it.
      extraction: 'TOPIC: nvidia earnings research | EVIDENCE: nvidia earnings call',
      recipe: [
        'NAME: Nvidia Earnings Brief',
        'EMOJI: ◈',
        'TAGLINE: nvidia earnings call digest with the movers',
        'BLURB: Reads the latest nvidia earnings call and briefs what moved, why, and what to watch.',
        'CATEGORY: research',
        'TAGS: research=0.9, general=0.1',
        'GEAR: dish',
        'PARAM: quarter | Quarter | e.g. Q2 FY26',
        'TASK: Summarize the {quarter} nvidia earnings call: lead with what moved and why, cite the transcript.',
        'WHY: you keep digging into the nvidia earnings call'   // cites the real evidence -> grounded
      ].join('\n')
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scout-e2e-'));
    seedScoutState(ws);   // no interests file: the histogram starts COLD — warmth must be EARNED live
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);

      // sanity: pre-run, the scout is honestly COLD (no interests -> warm:false, gate binds 'cold').
      const cold = await (await fetch(B + '/api/scout', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq(cold.warm, false, 'pre-run the station is honestly cold (no interests yet)');
      A.eq(cold.gate.binding, 'cold', 'the gate reports the cold binding pre-run');

      // drive REAL task runs — the post-run hook is the ONLY trigger used (no state poked mid-flight).
      await driveRun(B, token, 'scout-e2e', 'dig into the nvidia earnings call and what moved the stock');
      await driveRun(B, token, 'scout-e2e', 'summarize the latest nvidia earnings call transcript for me');
      await driveRun(B, token, 'scout-e2e', 'compare the nvidia earnings call guidance to last quarter');

      // the chain lands: interests folded + warm + a recipe draft STAGED, all from live orchestration.
      const s = await pollScout(B, token,
        p => p.staged && p.staged.some(it => it.kind === 'recipe'),
        'a recipe draft staged by the live scout cycle');
      A.ok(true, 'ORCHESTRATION: a real run chain staged a recipe draft end-to-end');
      A.eq(s.warm, true, 'the station is WARM off live-extracted interests (never pre-seeded)');
      const topic = (s.interests || []).find(t => /nvidia/.test(t.topic));
      A.ok(topic, 'the extracted interest persisted and is served by GET /api/scout');
      A.ok(topic && topic.evidence.some(q => q.indexOf('nvidia earnings call') >= 0), 'the interest carries its verbatim evidence quote');
      const draft = s.staged.find(it => it.kind === 'recipe');
      A.eq(draft.draft.name, 'Nvidia Earnings Brief', 'the staged draft is the parsed model reply');
      A.ok(draft.why.indexOf('nvidia earnings call') >= 0, 'the staged draft carries its evidence-grounded WHY');
      A.ok(draft.draft.task.indexOf('{quarter}') >= 0 && draft.draft.params[0].key === 'quarter', 'the param round-trips the task template');
      A.ok((s.ledger || []).some(e => e.kind === 'interests' && e.outcome === 'folded'), 'the ledger recorded the interests fold');
      A.ok((s.ledger || []).some(e => e.kind === 'recipe' && e.outcome === 'staged' && e.title === 'Nvidia Earnings Brief'), 'the ledger recorded the staged mint');
      A.eq(s.gate.fire, false, 'the mint spent the cadence (the gate no longer fires)');

      // the durable files really landed on disk (restart-safety is the point of the server-side scout).
      const onDiskInterests = JSON.parse(fs.readFileSync(path.join(ws, 'scout.interests.json'), 'utf8'));
      A.ok(onDiskInterests.state && onDiskInterests.state.topics && Object.keys(onDiskInterests.state.topics).some(k => /nvidia/.test(k)), 'scout.interests.json persisted the extracted topic');
      const trusted = onDiskInterests.state && onDiskInterests.state.trustedTopics && onDiskInterests.state.trustedTopics['nvidia-earnings-research'];
      A.ok(trusted && trusted.n === 1, 'live exact-evidence extraction persists an independently counted trusted topic');
      A.eq(trusted && trusted.ev.map(e => e.q), ['nvidia earnings call'], 'trusted disk evidence is the exact clean run fragment');
      const onDiskScout = JSON.parse(fs.readFileSync(path.join(ws, 'scout.state.json'), 'utf8'));
      A.ok((onDiskScout.state.staged || []).some(it => it.kind === 'recipe'), 'scout.state.json persisted the staged draft');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 2 — the honest-failure chain (anti-silent-no-op) ================= */
  {
    const mock = await startMock({
      // INVENTED evidence shares "pipeline" with real activity, so the old overlap parser accepted it.
      // The live exact-evidence guard must drop the full invented quote.
      extraction: 'TOPIC: quantum basket weaving | EVIDENCE: pipeline QUANTUM_SCOUT_INVENTED use imaginary context',
      // a WELL-FORMED recipe whose WHY cites nothing the station observed -> the parseRecipe grounding
      // guard must reject it (the new anti-invented-pitch arm), visibly, via the ledger.
      recipe: [
        'NAME: Fresh Dashboards',
        'EMOJI: ◈',
        'TAGLINE: a cheerful dashboard for cheerful people',
        'BLURB: Builds a dashboard.',
        'CATEGORY: general',
        'TAGS: general=1',
        'GEAR:',
        'PARAM: board | Board | main',
        'TASK: Build the {board} dashboard now.',
        'WHY: because commanders love cheerful dashboards every sunrise'   // ungroundable: cites nothing real
      ].join('\n')
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scout-e2e-'));
    seedScoutState(ws);
    // WARM is pre-seeded here (boot 1 already proved warmth is earned live) so the mint attempt fires at all;
    // lastPassAt:0 leaves the extraction pass free to fire too — both failure arms exercise in one boot.
    fs.writeFileSync(path.join(ws, 'scout.interests.json'), JSON.stringify({
      v: 1, state: Object.assign(trustedInterests('kubernetes ops', Date.now()), { lastPassAt: 0 })
    }));
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      await driveRun(B, token, 'scout-e2e', 'refactor the deploy pipeline for staging');
      await driveRun(B, token, 'scout-e2e', 'tighten rollback handling in the deploy pipeline');

      // the UNGROUNDABLE recipe: rejected + ledger-visible, NEVER a silent nothing, NEVER a staged lie.
      const s = await pollScout(B, token,
        p => (p.ledger || []).some(e => e.kind === 'recipe' && e.outcome === 'rejected'),
        'a rejected ledger note for the ungroundable recipe');
      A.ok(true, 'HONEST FAILURE: the ungroundable recipe reply was rejected AND the ledger says so');
      A.ok(!(s.staged || []).some(it => it.kind === 'recipe'), 'no recipe draft was staged from the invented pitch');

      // the INVENTED extraction evidence: dropped by the grounding guard; the pass notes 'none' honestly.
      const s2 = await pollScout(B, token,
        p => (p.ledger || []).some(e => e.kind === 'interests' && e.outcome === 'none'),
        "an honest 'none' ledger note for the invented-evidence extraction");
      A.ok(!(s2.interests || []).some(t => /quantum/.test(t.topic)), 'the invented topic never entered the histogram');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 3 — the ARCHETYPE-SEEDED prospect mint (recuration 2026-07-14) =================
     A WARM learned interest that points at a dormant curated archetype must stage that archetype's FULL
     spec as a prospect — deterministically, with ZERO model spend (the recruiter authorship pass never
     fires), and a WHY naming the real topic + count. Recipe shelf pre-filled so decide() routes the one
     attempt to kind:'prospect'; the interests pass is gap-suppressed so no extraction call fires either. */
  {
    const mock = await startMock({
      extraction: 'TOPIC: unused | EVIDENCE: unused',
      recipe: 'NONE',
      prospect: 'NAME: Should Never Be Asked\nEMOJI: ✦\nTAGLINE: the llm pass must not fire\nPURPOSE: n/a\nMANUAL: n/a\nKIT: dish\nSKILLS:\nWHY: n/a'
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scout-e2e-'));
    // recipe shelf FULL + cadence earned -> the attempt routes to 'prospect'; prospect shelf empty.
    const stagedRecipes = [0, 1, 2].map(i => ({
      id: 'seed-r' + i, kind: 'recipe', why: 'seed', fingerprint: 'seed recipe fp ' + i, at: Date.now() - 3600000,
      draft: { name: 'Seed Recipe ' + i, tagline: 'occupies a recipe slot ' + i }
    }));
    fs.writeFileSync(path.join(ws, 'scout.state.json'), JSON.stringify({
      v: 1, state: { v: 1, staged: stagedRecipes, denylist: [], ledger: [], runsSinceMint: 5, lastMintAt: 0, lastKind: '', context: null }
    }));
    // a WARM topic whose words hit the broker archetype's own text; lastPassAt now -> extraction gap-suppressed.
    fs.writeFileSync(path.join(ws, 'scout.interests.json'), JSON.stringify({
      v: 1, state: trustedInterests('gpu price tracking', Date.now())
    }));
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      await driveRun(B, token, 'scout-e2e', 'check gpu prices for the build');

      const s = await pollScout(B, token,
        p => (p.staged || []).some(it => it.kind === 'prospect'),
        'an archetype prospect staged by the live scout cycle');
      const draft = s.staged.find(it => it.kind === 'prospect');
      A.eq(draft.draft.archetypeId, 'broker', 'ARCHETYPE MINT: the warm price-hunting interest staged the Broker archetype');
      A.eq(draft.draft.name, BROKER.name, 'the staged draft uses the archetype\'s current canonical name, not an LLM invention');
      A.ok(Array.isArray(draft.draft.kit) && draft.draft.kit.length > 0 && Array.isArray(draft.draft.skills) && draft.draft.skills.length > 0,
        'the staged archetype carries its FULL loadout (kit + skills)');
      A.ok(draft.draft.purpose.length > 0 && draft.draft.manual.length > 0, 'the staged archetype carries its purpose + manual (nothing half-authored)');
      A.ok(draft.why.indexOf('gpu price tracking') >= 0 && draft.why.indexOf('5×') >= 0,
        'the WHY names the real topic and its real count (truthful telemetry): ' + draft.why);
      A.ok((s.ledger || []).some(e => e.kind === 'prospect' && e.outcome === 'staged' && e.title === BROKER.name), 'the ledger recorded the archetype mint under its canonical name');
      A.eq(mock.calls.indexOf('recruiter'), -1, 'ZERO SPEND: the LLM prospect authorship pass never fired for an archetype mint');
      A.eq(mock.calls.indexOf('extraction'), -1, 'the gap-suppressed extraction pass never fired (the mint was pure state)');

      // restart-safety: the staged archetype landed on disk.
      const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'scout.state.json'), 'utf8'));
      A.ok((onDisk.state.staged || []).some(it => it.kind === 'prospect' && it.draft && it.draft.archetypeId === 'broker'),
        'scout.state.json persisted the staged archetype draft');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 4 — a PAUSE that lands mid-extraction wins (personalization authority) =================
     runScoutCycle checked the pause once at entry, then folded + persisted whatever the extraction call returned.
     Here the extraction call is HELD in flight; the Commander pauses learning; then the reply lands. Nothing may be
     folded, persisted or noted (scanDocumentSource's re-check rule), and the call's spend is still booked. */
  {
    const mock = await startMock({
      holdExtraction: true, priced: true, extractionUsage: { prompt_tokens: 1000, completion_tokens: 777, total_tokens: 1777 },
      extraction: 'TOPIC: nvidia earnings research | EVIDENCE: nvidia earnings call',
      recipe: 'NONE'
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-scout-e2e-'));
    seedScoutState(ws);   // cold interests, exactly like BOOT 1's happy chain
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const directives = ['dig into the nvidia earnings call and what moved the stock', 'summarize the latest nvidia earnings call transcript for me', 'compare the nvidia earnings call guidance to last quarter'];
      for (const d of directives) {
        if (mock.held.extraction) break;
        await driveRun(B, token, 'scout-e2e', d);
        const until = Date.now() + 1500;
        while (!mock.held.extraction && Date.now() < until) await sleep(50);
      }
      A.ok(mock.held.extraction, 'PAUSE ARM: the live extraction call is in flight (held by the mock)');
      const off = await (await fetch(B + '/api/personalization', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B }, body: JSON.stringify({ enabled: false }) })).json();
      A.eq(off.enabled, false, 'PAUSE ARM: the Commander paused learning while the call was in flight');
      const interestsFile = path.join(ws, 'scout.interests.json');
      const before = fs.existsSync(interestsFile) ? fs.readFileSync(interestsFile, 'utf8') : null;
      mock.release();
      const ledgerFile = path.join(ws, 'ledger.jsonl');
      const booked = () => { try { return fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).some(l => { try { const r = JSON.parse(l); return r.tokens >= 1777 && r.usd > 0; } catch (_) { return false; } }); } catch (_) { return false; } };
      const until = Date.now() + 5000;
      while (!booked() && Date.now() < until) await sleep(100);
      A.ok(booked(), 'PAUSE ARM: the extraction call\'s spend is still booked to the ledger (truthful cost)');
      await sleep(300);
      const after = fs.existsSync(interestsFile) ? fs.readFileSync(interestsFile, 'utf8') : null;
      A.eq(after, before, 'PAUSE ARM: scout.interests.json is byte-identical — the late reply folded nothing');
      const s = await (await fetch(B + '/api/scout', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.ok(!(s.ledger || []).some(e => e.kind === 'interests' && e.outcome === 'folded'), 'PAUSE ARM: no "folded" note was written after the pause');
      A.ok(!(s.interests || []).some(t => /nvidia/.test(t.topic)), 'PAUSE ARM: the topic never entered the histogram');
      A.eq(mock.calls.indexOf('recipe'), -1, 'PAUSE ARM: the cycle drafted nothing after the pause');
    } finally {
      try { mock.release(); } catch (_) {}
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('scout.e2e.test');
})().catch(e => { console.log('FAIL: scout.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
