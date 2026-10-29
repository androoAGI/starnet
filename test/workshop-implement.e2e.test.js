/* node test/workshop-implement.e2e.test.js — real sidecar proof that IMPLEMENT actually implements.

   THE GAP THIS CLOSES: the delivery card's Implement action had exactly one way to change anything — apply a
   `kind:"patch"` deliverable to a branch — and that path needs a blessed project AND a project-kind night focus.
   Everywhere else Implement copied files to a folder, so pressing it on a BACKLOG/PLAN produced a .md and nothing
   else ever happened. POST /api/workshop/implement runs the build that does the work the plan describes.

   Boots the ACTUAL sidecar against a mock OpenRouter and drives the true round-trip:
     grant → queue → shift (builds a PLAN, planOnly:true) → implement (builds the REAL thing) → assert on disk.
   It proves:
     • the plan build declares planOnly:true and /pending carries it (the card reads this to decide what Implement means);
     • implement starts a SECOND, DIFFERENT run whose files really exist in the jail (the work happened);
     • the implement run is actually FED the plan (its prompt names the source file — proven by a probe the mock writes);
     • the produced manifest is stamped implementOf ON DISK, so it survives the re-validation every read does;
     • implementing an implementation is refused (loop guard) — a plan can be built, its build cannot;
     • a second implement of the same plan is refused as already-implemented, never a silent double build;
     • unknown run → source-gone; malformed agent/run → 400. */
'use strict';

const A = require('./_assert.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const WORKSHOP_MARK = '[WORKSHOP_SHIFT]';
const IMPLEMENT_MARK = '[IMPLEMENT_BUILD]';

// mock OpenRouter. Two build branches keyed on the prompt sentinel: the WORKSHOP shift writes a PLAN (planOnly),
// the IMPLEMENT run writes the real artifact. The implement branch also records whether its prompt actually named
// the source plan's file, so the test can prove the plan was fed to the run rather than assumed.
function startMockOpenRouter() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          const userMsg = msgs.find(m => m && m.role === 'user');
          const prompt = userWords(userMsg);
          // the run's OWN dir — take it from the manifest instruction, never the first "workshop/" in the text
          // (an implement prompt names the SOURCE dir first, so a loose match would target the wrong run).
          const runId = (prompt.match(/manifest to "workshop\/([A-Za-z0-9-]+)\/deliverable\.json"/) || [])[1] || 'run';
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const tool = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
          };
          const text = t => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); };
          const dir = 'workshop/' + runId;
          if (prompt.indexOf(IMPLEMENT_MARK) === 0 && /Doomed plan/.test(prompt)) {
            // A BUILD THAT PRODUCES NOTHING — no files, no manifest. Drives the failure path that used to strand
            // the Commander: the plan must survive it and stay pending.
            text('I could not build this.');
          } else if (prompt.indexOf(IMPLEMENT_MARK) === 0) {
            // THE IMPLEMENT RUN — build the real thing the plan asked for.
            if (toolResults === 0) {
              // probe: did the prompt actually carry the plan's file path, forbid re-planning, and carry the
              // Commander's typed steer (the "which of these five things" answer) as an overriding instruction?
              const sawSource = /workshop\/[A-Za-z0-9-]+\/automation-backlog\.md/.test(prompt);
              const forbidsPlan = /BUILD, DO NOT RE-PLAN/.test(prompt);
              const sawSteer = /THE COMMANDER TOLD YOU WHAT TO BUILD/.test(prompt) && /do the PowerShell one first/.test(prompt);
              const steerWins = /if the plan and their instruction\s*\n?\s*disagree, THEY win/.test(prompt);
              tool('i0', 'fs_write', { path: dir + '/probe.txt', content: 'SAW_SOURCE=' + sawSource + '\nFORBIDS_REPLAN=' + forbidsPlan + '\nSAW_STEER=' + sawSteer + '\nSTEER_WINS=' + steerWins + '\n' });
            } else if (toolResults === 1) {
              tool('i1', 'fs_write', { path: dir + '/snapshot.ps1', content: 'Get-ComputerInfo | Select-Object CsName, OsName\n' });
            } else if (toolResults === 2) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: 'x', title: 'PC snapshot script', kind: 'tool', planOnly: false,
                summary: 'A PowerShell one-liner that prints the machine summary. Covers the first item of the backlog.',
                files: [{ path: 'probe.txt', bytes: 10 }, { path: 'snapshot.ps1', bytes: 20 }], howToUse: 'Run snapshot.ps1.', notVerified: ['run it once'] };
              tool('i2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Built the snapshot script.'); }
          } else if (prompt.indexOf(WORKSHOP_MARK) === 0) {
            // THE PLAN — exactly the shape that used to make Implement a no-op file copy.
            const doomed = /Doomed plan/.test(prompt);
            if (toolResults === 0) {
              tool('w1', 'fs_write', { path: dir + '/automation-backlog.md', content: '# Automation backlog\n\n1. A PC snapshot script.\n2. A disk report.\n' });
            } else if (toolResults === 1) {
              const manifest = { v: 1, runId: runId, agentId: 'builder', backlogId: doomed ? 'item-doomed' : 'item-plan',
                title: doomed ? 'Doomed plan' : 'Recent-work automation backlog', kind: 'doc', planOnly: true,
                summary: 'A backlog turning repeated workstation questions into automation candidates.',
                files: [{ path: 'automation-backlog.md', bytes: 60 }], howToUse: 'Open automation-backlog.md.', notVerified: ['pick which to build first'] };
              tool('w2', 'fs_write', { path: dir + '/deliverable.json', content: JSON.stringify(manifest) });
            } else { text('Wrote the backlog.'); }
          } else { text('done'); }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 30000);
  });
}

async function readNdjson(res) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', events = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { events.push(JSON.parse(line)); } catch (_) {} } } }
  return events;
}

function implementationRuns(workspace) {
  const root = path.join(workspace, 'builder', 'workshop');
  let dirs = []; try { dirs = fs.readdirSync(root); } catch (_) {}
  return dirs.filter(runId => {
    try { return !!JSON.parse(fs.readFileSync(path.join(root, runId, 'deliverable.json'), 'utf8')).implementOf; }
    catch (_) { return false; }
  });
}

async function exerciseDurabilityFault(mock, mode, expectedReason) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-impl-' + mode + '-'));
  // Patch the CHILD's real fs.renameSync only. The durable writer has already written+fsynced its temp bytes;
  // failing the atomic rename models ENOSPC/device failure at each exact commit boundary without production hooks.
  const hook = `import fs from 'node:fs';
const original = fs.renameSync.bind(fs); let fired = false;
function jsonAt(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch (_) { return null; } }
function backlogOf(v){ if(!v||typeof v!=='object') return null; if(Array.isArray(v.backlog)) return v.backlog; for(const x of Object.values(v)){ const b=backlogOf(x); if(b) return b; } return null; }
fs.renameSync = function(src,dst){
  const target=String(dst), data=(()=>{try{return fs.readFileSync(src,'utf8')}catch(_){return ''}})(); let fail=false;
  if(!fired && process.env.STARNET_IMPL_FAULT==='stamp' && target.endsWith('deliverable.json') && data.includes('\\"implementOf\\"')) fail=true;
  if(!fired && /builder\\.workshop\\.json$/.test(target)) { const b=backlogOf(jsonAt(src))||[]; const built=b.filter(x=>x&&x.builtRunId); const impl=b.filter(x=>x&&String(x.id||'').startsWith('impl-'));
    if(process.env.STARNET_IMPL_FAULT==='registration' && built.length>=2 && impl.some(x=>x.builtRunId)) fail=true;
    if(process.env.STARNET_IMPL_FAULT==='retirement' && b.length===1 && impl.length===1 && impl[0].builtRunId) fail=true;
  }
  if(fail){ fired=true; const e=new Error('INJECT_IMPLEMENT_'+process.env.STARNET_IMPL_FAULT.toUpperCase()); e.code='ENOSPC'; throw e; }
  return original(src,dst);
};`;
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-workshop-fake', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_IMPL_FAULT: mode,
    NODE_OPTIONS: '--import=data:text/javascript,' + encodeURIComponent(hook) };
  const live = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + live.port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = (p, b) => fetch(B + p, { method: 'POST', headers, body: JSON.stringify(b) });
    await post('/api/workshop/grant', { agentId: 'builder', on: true });
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-plan-' + mode, title: 'Durability plan ' + mode });
    const shift = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const plan = ((shift.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.eq(plan.reason, 'built', mode + ': source plan builds before the injected commit fault');
    const first = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: plan.runId }));
    const failed = ((first.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.eq(failed.reason, expectedReason, mode + ': the exact durability failure is reported, never built');
    const pending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(pending.pending.some(m => m.runId === plan.runId), mode + ': the source plan remains pending after the fault');
    if (mode !== 'retirement') A.ok(!pending.pending.some(m => m.runId === failed.runId), mode + ': an uncommitted build is never reviewable');
    else A.ok(pending.pending.some(m => m.runId === failed.runId), 'retirement: the durably registered build remains reviewable');

    const beforeRetry = implementationRuns(ws).length;
    const retryEvents = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: plan.runId }));
    const retry = ((retryEvents.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.ok(retry.reason === 'built' || retry.reason === 'already-implemented', mode + ': a retry heals the one-shot durability fault');
    const healed = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(!healed.pending.some(m => m.runId === plan.runId), mode + ': successful retry durably retires the source');
    if (mode === 'retirement') A.eq(implementationRuns(ws).length, beforeRetry, 'retirement: recovery reuses the proven build instead of spending a duplicate run');
  } finally {
    try { live.child.kill(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-impl-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-workshop-fake', SKYNET_DEFAULT_MODEL: 'test/model' };
  const firstBoot = await boot(await allocatePort(), env, 20);
  const child = firstBoot.child;
  const B = 'http://' + HOST + ':' + firstBoot.port;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = (p, b) => fetch(B + p, { method: 'POST', headers, body: JSON.stringify(b) });

    // 1. build the PLAN — the deliverable shape that used to make Implement a pure file copy.
    await post('/api/workshop/grant', { agentId: 'builder', on: true });
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-plan', title: 'Recent-work automation backlog' });
    const shiftEvents = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const shiftRes = ((shiftEvents.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.ok(shiftRes.fired === true && shiftRes.reason === 'built', 'the shift built the plan deliverable');
    const planRun = shiftRes.runId;
    A.ok(fs.existsSync(path.join(ws, 'builder', 'workshop', planRun, 'automation-backlog.md')), 'the plan file exists in the jail');

    // the card reads planOnly to decide what Implement MEANS — it must survive validation out to /pending.
    const pending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    const planMan = pending.pending.find(m => m.runId === planRun);
    A.ok(planMan, '/pending lists the plan build');
    A.eq(planMan.planOnly, true, '/pending carries planOnly:true — the card knows this DESCRIBES work');
    A.ok(!planMan.implementOf, 'the plan itself is not an implementation');

    // 2. IMPLEMENT — the whole point: a second, real build that does what the plan describes.
    const implEvents = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: planRun, note: 'do the PowerShell one first' }));
    const implRes = ((implEvents.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.ok(implRes.fired === true && implRes.reason === 'built', 'implement ran a real build (fired:true, reason:built)');
    const implRun = implRes.runId;
    A.ok(implRun && implRun !== planRun, 'implement produced a NEW run, distinct from the plan');
    const implDir = path.join(ws, 'builder', 'workshop', implRun);
    A.ok(fs.existsSync(path.join(implDir, 'snapshot.ps1')), 'the implemented artifact really exists on disk — work happened, not a copy');

    // the run must actually be FED the plan, not merely told a plan existed.
    const probe = fs.readFileSync(path.join(implDir, 'probe.txt'), 'utf8');
    A.ok(/SAW_SOURCE=true/.test(probe), 'the implement prompt named the source plan file (the run reads the real plan)');
    A.ok(/FORBIDS_REPLAN=true/.test(probe), 'the implement prompt forbids delivering another plan');
    // THE STEER: a plan lists several things; what the Commander typed on the card is how they pick one.
    A.ok(/SAW_STEER=true/.test(probe), 'the Commander’s typed instruction reached the BUILD prompt (not the chat stream)');
    A.ok(/STEER_WINS=true/.test(probe), 'and it outranks the plan’s own ordering when the two disagree');
    // it is also recorded as the build's provenance, so the delivery card can say WHY in the Commander's words.
    const implItem = ((await (await fetch(B + '/api/workshop/backlog?agent=builder', { headers })).json()).backlog || [])
      .find(b => b.id === 'impl-' + planRun);
    A.ok(implItem && /do the PowerShell one first/.test(String(implItem.grounds || '')), 'the steer is recorded as the build’s grounds (why-this provenance)');

    // 3. the loop guard is stamped ON DISK (every reader re-validates from deliverable.json).
    const onDisk = JSON.parse(fs.readFileSync(path.join(implDir, 'deliverable.json'), 'utf8'));
    A.eq(onDisk.implementOf, planRun, 'the produced manifest is stamped implementOf on disk (survives re-validation)');
    const pending2 = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    const implMan = pending2.pending.find(m => m.runId === implRun);
    A.ok(implMan, '/pending lists the implemented build as its own reviewable deliverable');
    A.eq(implMan.implementOf, planRun, 'and /pending carries implementOf, so the card refuses a second hop');
    A.eq(implMan.planOnly, false, 'the implementation declares planOnly:false — it IS the thing');

    // 3b. THE PLAN IS RETIRED ONLY BECAUSE A BUILD LANDED — and it is NOT 'kept': nothing was copied anywhere.
    A.ok(!pending2.pending.some(m => m.runId === planRun), 'the source plan stops being pending once its build landed');
    const lib = await (await fetch(B + '/api/deliverables', { headers })).json();
    const planRow = (lib.items || []).find(r => r.runId === planRun);
    A.ok(planRow && planRow.status === 'implemented', 'the library records the plan as IMPLEMENTED (acted on, not kept)');
    A.ok(!(lib.items || []).some(r => r.runId === planRun && r.status === 'kept'), 'the plan is never marked kept — no files were copied out of the jail');

    // 4. implementing an IMPLEMENTATION is refused — a plan can be built; its build cannot be built again.
    const loop = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: implRun }));
    const loopRes = ((loop.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.eq(loopRes.reason, 'already-an-implementation', 'implementing an implementation is refused (no plan→plan→plan recursion)');
    A.ok(loopRes.fired === false, 'and it never spends a run to find that out');

    // 5. a SECOND implement of the same plan does not silently build twice.
    const again = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: planRun }));
    const againRes = ((again.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.eq(againRes.reason, 'already-implemented', 're-implementing the same plan is refused honestly, never a double build');

    /* 6. A FAILED BUILD MUST LEAVE THE PLAN. The first cut kept-then-built: the plan was retired BEFORE the build
          ran, so a build that produced nothing left the Commander with the card gone and a failure line telling
          them to "press Implement again" at a deliverable that was no longer pending. Nothing is decided until a
          build actually lands. */
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-doomed', title: 'Doomed plan' });
    const doomShift = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const doomRun = (((doomShift.find(e => e.name === 'workshop.shift.result') || {}).payload) || {}).runId;
    A.ok(doomRun, 'the second plan built');
    const doomImpl = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: doomRun }));
    const doomRes = ((doomImpl.find(e => e.name === 'workshop.implement.result') || {}).payload || {});
    A.eq(doomRes.reason, 'no-manifest', 'a build that produces nothing reports no-manifest honestly');
    const afterFail = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(afterFail.pending.some(m => m.runId === doomRun), 'the plan is STILL PENDING after a failed build — the card returns so "try again" is true');
    const libFail = await (await fetch(B + '/api/deliverables', { headers })).json();
    A.ok(!(libFail.items || []).some(r => r.runId === doomRun && (r.status === 'implemented' || r.status === 'kept')),
      'and a failed build never records the plan as implemented or kept');
    /* Retire BOTH leftovers before the next leg. claimNext takes the TOP of the queue, so anything still
       claimable silently becomes the subject of every later shift — and a failed implement leaves TWO: the plan
       itself AND the never-built `impl-<runId>` item it queued. This exact trap made the FREE leg below assert
       against the wrong deliverable twice. */
    await post('/api/workshop/decide', { agentId: 'builder', runId: doomRun, decision: 'discard' });
    const rmImpl = await post('/api/workshop/remove', { agentId: 'builder', backlogId: 'impl-' + doomRun });
    A.eq(rmImpl.status, 200, 'the failed implement’s unbuilt backlog item can be removed from the queue');

    /* 7. FREE (FULLY AUTONOMOUS) FINISHES THE JOB ITSELF. The whole point of away-work is that value arrives
          while the Commander is gone, so a plan at the top rung is an INTERMEDIATE STEP, not a delivery: the
          shift chains straight into the build and hands back the finished thing. (An earlier cut REFUSED the
          plan and retried — which burned a run and delivered nothing. That is the failure this locks out.)
          At 'leash' (BUILD DRAFTS) the same build stays a plan, because that rung is where the Commander wants
          the approval beat. */
    await post('/api/autonomy/posture', { posture: { initiative: 'free', reach: 'sandbox' } });
    // prove the rung actually took — otherwise every assertion below silently tests the DEFAULT rung.
    const rung = await (await fetch(B + '/api/autonomy/posture', { headers })).json();
    A.eq(((rung.summary) || {}).initiative, 'free', 'the station really is at FREE for this leg');
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-freeplan', title: 'Free-rung plan' });
    const freeShift = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const freeRes = ((freeShift.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.eq(freeRes.reason, 'built', 'the FREE shift still DELIVERS — value arrives, it is never thrown away');
    A.ok(freeRes.chainedFrom, 'and it reports that it chained from a plan');
    A.ok(freeRes.runId !== freeRes.chainedFrom, 'the delivered run is the BUILD, not the plan that seeded it');
    A.eq((freeRes.manifest || {}).planOnly, false, 'what lands at FREE is the finished thing, not a plan');
    A.eq((freeRes.manifest || {}).implementOf, freeRes.chainedFrom, 'the build records the plan it came from');
    const freeDir = path.join(ws, 'builder', 'workshop', freeRes.runId);
    A.ok(fs.existsSync(path.join(freeDir, 'snapshot.ps1')), 'the built artifact really exists on disk — the Commander wakes to a THING');
    const freePending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(freePending.pending.some(m => m.runId === freeRes.runId), 'the finished build is what waits for a decision');
    A.ok(!freePending.pending.some(m => m.runId === freeRes.chainedFrom), 'the intermediate plan does not also nag for one');

    /* 7b. A FAILED CHAIN STILL DELIVERS THE PLAN. This is the guarantee that makes the whole feature safe to
           automate: if the auto-build doesn't land, the Commander gets the plan rather than an empty morning —
           and can press BUILD IT themselves. Never a wasted shift. */
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-freedoomed', title: 'Doomed plan at free' });
    const fbShift = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const fbRes = ((fbShift.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.eq(fbRes.reason, 'built', 'a FREE shift whose auto-build fails still DELIVERS');
    A.ok(fbRes.autoBuildFailed, 'and says the auto-build did not land, rather than reporting a clean build');
    A.ok(!fbRes.chainedFrom, 'the delivered run is the plan itself, not a chained build');
    A.eq((fbRes.manifest || {}).planOnly, true, 'so what waits is the plan — pressable via BUILD IT');
    const fbPending = await (await fetch(B + '/api/workshop/pending?agent=builder', { headers })).json();
    A.ok(fbPending.pending.some(m => m.runId === fbRes.runId), 'and it really is pending a decision, not discarded');
    await post('/api/workshop/decide', { agentId: 'builder', runId: fbRes.runId, decision: 'discard' });

    /* 7c. THE CHAINED BUILD INHERITS THE PLAN'S LEARNING IDENTITY. nightshiftDecideLearn() early-returns on a run
           with no archetype, and the archetype is recorded against the run that PROPOSED the work. Without this,
           a FREE beat would silently stop teaching: the Commander's verdict lands on the chained BUILD (no
           archetype) while the plan is retired by the server with no verdict at all. Asserted through the
           nightshift acts file, which is the durable record both loops read. */
    const actsFile = path.join(ws, 'nightshift.acts.json');
    if (fs.existsSync(actsFile)) {
      const acts = (JSON.parse(fs.readFileSync(actsFile, 'utf8')) || {}).acts || {};
      const planAct = acts[freeRes.chainedFrom];
      if (planAct && planAct.archetype) {
        A.ok(acts[freeRes.runId], 'the chained build has its own acts entry (it can be learned from)');
        A.eq((acts[freeRes.runId] || {}).archetype, planAct.archetype, 'and it inherits the PLAN’s archetype, so a verdict on the build still teaches');
      }
    }

    // back down to the draft rung: the SAME build shape stays a PLAN — the chain is rung-scoped, not universal.
    await post('/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'sandbox' } });
    await post('/api/workshop/queue', { agentId: 'builder', id: 'item-leashplan', title: 'Leash-rung plan' });
    const leashShift = await readNdjson(await post('/api/workshop/shift', { agentId: 'builder' }));
    const leashRes = ((leashShift.find(e => e.name === 'workshop.shift.result') || {}).payload || {});
    A.eq(leashRes.reason, 'built', 'BUILD (DRAFTS) delivers too');
    A.ok(!leashRes.chainedFrom, 'but it does NOT auto-chain — that rung is where the Commander presses the button');
    A.eq((leashRes.manifest || {}).planOnly, true, 'so what arrives is the plan, and the card offers to build it');

    // 8. gates.
    const gone = await readNdjson(await post('/api/workshop/implement', { agentId: 'builder', runId: 'no-such-run' }));
    A.eq(((gone.find(e => e.name === 'workshop.implement.result') || {}).payload || {}).reason, 'source-gone', 'an unknown deliverable is refused as source-gone');
    A.eq((await post('/api/workshop/implement', { agentId: '../etc', runId: planRun })).status, 400, 'a malformed agentId is refused 400');
    A.eq((await post('/api/workshop/implement', { agentId: 'builder', runId: '' })).status, 400, 'a missing runId is refused 400');

    // 9. FAIL-FIRST, REAL-ROUTE DURABILITY PROOF. Each child gets one injected atomic-rename failure, then heals
    // on retry. This locks the three seams that formerly swallowed persistence failures and still claimed built.
    await exerciseDurabilityFault(mock, 'stamp', 'manifest-stamp-failed');
    await exerciseDurabilityFault(mock, 'registration', 'registration-failed');
    await exerciseDurabilityFault(mock, 'retirement', 'built-source-retire-failed');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report();
})().catch(e => { console.error(e); process.exit(1); });
