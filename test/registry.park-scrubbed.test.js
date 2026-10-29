/* node test/registry.park-scrubbed.test.js — a parked tool result is the SCRUBBED text, never the raw store read.

   The registry scrubs a station tool's stored text before the model sees it (tools/registry.js resultScrubFor). A
   result over the per-result budget is first parked WHOLE in the agent's workspace (ctx.parkOutput, index.js), and
   fs.read reads it back: a workspace tool, which the registry never scrubs. The success path scrubbed only what it
   showed, AFTER the park, so the parked copy kept every key the visible result had hidden. Since the canonical-bytes
   lane a skill's text is stored exactly and scrubbed where it leaves, so a skill.view over the budget (80,000
   characters by default, 8,000 on a small window; a body or a support file may hold 256,000) left a support file's
   vendor key and password on disk, one fs.read away from the model (review round 2, B1). The error path already
   scrubbed before it parked; the success path now does the same.

   Pinned:
   1. a memory-capability tool's over-budget result holding a vendor key and a credential field: neither is in the
      parked copy or the visible result; the receipt wording is unchanged and counts the parked copy's size
   2. a tool's own preview plus fullContent: both scrubbed, the parked fullContent included
   3. a workspace (cabinet) tool's result is parked byte-exact, as before: workspace content is never scrubbed
   4. no scrubber attached: the parked copy is the result byte for byte (tests, the browser copy)
   5. end to end, the real skill store, skill tools and fs tools with the host's scrubStored attached: skill.view of a
      skill over an 8,000-character budget parks, and fs.read of the parked file carries no key and no password
   6. a tool that parks part of its own result: team.dispatch (the real orchestration tools, the real output-artifacts
      parker, scrubStored attached) cuts two workers' 60,000-character texts to fit and spills each one whole to
      .output/team.dispatch-<worker>-*.txt. The spill went through ctx.parkOutput with the worker's raw text, so the
      file held the vendor key the visible row had redacted (review round 3). The registry hands the tool its scrub
      (ctx.scrubText) and the rows are scrubbed before they are cut or parked: no spilled file holds the key, and each
      row's resultChars is its spilled file's length. A workspace tool is handed no scrubText. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const PS = require('../sidecar/prompt-scrub.js');
const ctxMod = require('../sidecar/context.js');
const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeOutputArtifacts } = require('../sidecar/output-artifacts.js');

const KEY = 'sk-proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0f';
const PW = 'Summer2024!rocks';   // a shapeless credential: only the credential-field rule finds it
const SECRET_LINES = 'export OPENAI_API_KEY=' + KEY + '\npassword=' + PW + '\n';
const openCtx = (extra) => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', timeoutMs: 5000 }, extra || {});
function parker() {
  const saved = [];
  let seq = 0;
  return { saved, parkOutput: async (content, meta) => { const p = '.output/' + ((meta && meta.tool) || 'tool') + '-' + (seq++) + '.txt'; saved.push({ path: p, content, meta }); return { path: p }; } };
}
const leaks = (t) => String(t).includes(KEY) || String(t).includes(PW);

(async () => {
  try {
    // ---- 1. a station (memory) tool over the budget: the parked copy is scrubbed ----
    {
      const text = 'HEAD\n' + 'x'.repeat(9000) + '\n' + SECRET_LINES + 'TAIL';
      const reg = makeRegistry();
      reg.register({ name: 'memo.read', capability: 'memory', scope: 'read', schema: { type: 'object', properties: {} }, run: async () => text });
      attachResultScrub(PS.scrubStored);
      const p = parker();
      const r = await reg.dispatch({ id: 'c1', name: 'memo.read', args: {} }, openCtx({ outputMax: 8000, parkOutput: p.parkOutput }));
      attachResultScrub(null);
      A.eq(p.saved.length, 1, '1: the over-budget result is parked once');
      const parked = p.saved.length ? p.saved[0].content : '';
      A.ok(!leaks(parked), '1: the parked copy carries no vendor key and no credential value (parked: ' + JSON.stringify(parked.slice(9000)) + ')');
      A.ok(/OPENAI_API_KEY=/.test(parked) && /^HEAD\n/.test(parked) && /TAIL$/.test(parked), '1: the rest of the parked copy is the result, whole');
      A.ok(!leaks(r.content), '1: the visible result carries neither');
      A.ok(String(r.content).includes(p.saved.length ? p.saved[0].path : '\u0000'), '1: the visible result names the parked path');
      A.eq([r.outputChars, r.outputBytes], [parked.length, Buffer.byteLength(parked, 'utf8')], '1: the size the result reports is the parked copy\'s');
    }
    // ---- 2. a tool's own preview plus fullContent: both scrubbed ----
    {
      const full = 'FULL\n' + 'y'.repeat(500) + '\n' + SECRET_LINES;
      const reg = makeRegistry();
      reg.register({ name: 'memo.preview', capability: 'memory', scope: 'read', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'preview ' + SECRET_LINES, fullContent: full }) });
      attachResultScrub(PS.scrubStored);
      const p = parker();
      const r = await reg.dispatch({ id: 'c2', name: 'memo.preview', args: {} }, openCtx({ parkOutput: p.parkOutput }));
      attachResultScrub(null);
      A.eq(p.saved.length, 1, '2: a preview with fullContent parks the full text');
      A.ok(!leaks(p.saved.length ? p.saved[0].content : ''), '2: the parked fullContent is scrubbed');
      A.ok(!leaks(r.content), '2: the preview the model sees is scrubbed');
      A.ok(/\[full-output receipt: \d+ characters \/ \d+ UTF-8 bytes before truncation; saved once to \.output\/memo\.preview-0\.txt\. Read that file in ranges; do not rerun the tool merely to recover output\.\]/.test(String(r.content)),
        '2: the receipt wording is unchanged: ' + JSON.stringify(String(r.content).slice(-220)));
      const parkedLen = p.saved.length ? p.saved[0].content.length : -1;
      A.ok(String(r.content).includes('[full-output receipt: ' + parkedLen + ' characters'), '2: the receipt counts the parked copy (' + parkedLen + ' chars)');
    }
    // ---- 3. workspace content is parked byte-exact (cabinet: fs/shell output is the model's own workspace) ----
    {
      const text = 'z'.repeat(9000) + '\n' + SECRET_LINES;
      const reg = makeRegistry();
      reg.register({ name: 'cab.cat', capability: 'cabinet', scope: 'read', schema: { type: 'object', properties: {} }, run: async () => text });
      attachResultScrub(PS.scrubStored);
      const p = parker();
      await reg.dispatch({ id: 'c3', name: 'cab.cat', args: {} }, openCtx({ outputMax: 8000, parkOutput: p.parkOutput }));
      attachResultScrub(null);
      A.eq(p.saved.length ? p.saved[0].content : null, text, '3: a workspace tool\'s result is parked byte-exact, as before');
    }
    // ---- 4. no scrubber attached: byte-identical to before ----
    {
      const text = 'w'.repeat(9000) + '\n' + SECRET_LINES;
      const reg = makeRegistry();
      reg.register({ name: 'memo.raw', capability: 'memory', scope: 'read', schema: { type: 'object', properties: {} }, run: async () => text });
      const p = parker();
      await reg.dispatch({ id: 'c4', name: 'memo.raw', args: {} }, openCtx({ outputMax: 8000, parkOutput: p.parkOutput }));
      A.eq(p.saved.length ? p.saved[0].content : null, text, '4: with no scrubber attached the parked copy is the result, byte for byte');
    }
    // ---- 5. end to end: skill.view over the budget, then fs.read of the parked file ----
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'park-scrubbed-'));
      try {
        const rows = [];
        const store = makeSkillStore({ io: { readAll: () => rows, append: (row) => rows.push(row) }, clock: { now: () => 1000 }, stageReviews: false, redact: (s) => ctxMod.redact(s) });
        store.manage({ action: 'create', agentId: 'a', name: 'Deploy', summary: 'deploy it', body: '1. run scripts/deploy.sh\n' + 'x'.repeat(9000), createdBy: 'agent' });
        const w = store.manage({ action: 'write_file', agentId: 'a', target: 'Deploy', path: 'scripts/deploy.sh', content: SECRET_LINES + './deploy\n', createdBy: 'agent' });
        A.ok(w.ok, '5: precondition, the support file is written (' + (w.error || '') + ')');
        A.ok(leaks(JSON.stringify(rows)), '5: precondition, the store keeps the file\'s exact text (the key is scrubbed where it leaves)');
        const reg = makeRegistry();
        makeSkillTools({ store, gate: { decide: () => ({ visible: true }), verify: () => ({ visible: true }) } }).register(reg);
        makeFsTools({ fsp, pathMod: path, root }).register(reg);
        let n = 0;
        const ctx = openCtx({ outputMax: 8000, parkOutput: async (content) => {
          const rel = 'skill.view-run-' + (n++) + '.txt';
          fs.mkdirSync(path.join(root, 'a'), { recursive: true });
          fs.writeFileSync(path.join(root, 'a', rel), content);
          return { path: rel };
        } });
        attachResultScrub(PS.scrubStored);
        const v = await reg.dispatch({ id: 'v', name: 'skill.view', args: { name: 'Deploy' } }, ctx);
        const m = /(skill\.view-run-\d+\.txt)/.exec(String(v.content));
        A.ok(!!m, '5: skill.view over the budget parks its text and names the file');
        A.ok(!leaks(v.content), '5: the visible skill.view carries no key and no password');
        const parkedDisk = m ? fs.readFileSync(path.join(root, 'a', m[1]), 'utf8') : '';
        A.ok(parkedDisk.length > 9000 && parkedDisk.includes('scripts/deploy.sh') && !leaks(parkedDisk), '5: the parked file on disk is the whole view, scrubbed');
        const r = m ? await reg.dispatch({ id: 'r', name: 'fs.read', args: { path: m[1], offset: 9000, limit: 2000 } }, ctx) : { content: '' };
        attachResultScrub(null);
        A.ok(/OPENAI_API_KEY=/.test(String(r.content)), '5: fs.read reads the support file back from the parked copy');
        A.ok(!leaks(r.content), '5: ...with no vendor key and no password in it: ' + JSON.stringify(String(r.content).split('\n').filter(l => /OPENAI|password/.test(l))));
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
    // ---- 6. team.dispatch's per-worker spill is the scrubbed text ----
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'park-scrubbed-dispatch-'));
      try {
        const arts = makeOutputArtifacts({ fsp, fs, pathMod: path, root, crypto });
        let seq = 0;
        const spilled = [];
        const parkOutput = async (content, meta) => {
          const r = await arts.park('lead', String(meta && meta.tool).replace(/[^A-Za-z0-9_.-]/g, '_') + '-' + (seq++), content);
          spilled.push({ path: r.path, meta });
          return r;
        };
        const workerText = 'x'.repeat(30000) + '\n' + SECRET_LINES + 'y'.repeat(30000);
        const runOnce = async (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: workerText }], usd: 0, runId: o.runId });
        let n = 0;
        const { dispatchTool } = makeOrchestrationTools({ runOnce, roster: () => new Map([['w1', { system: 'S' }], ['w2', { system: 'S' }]]), key: 'k', model: 'm', newId: () => 'c' + (++n) });
        const reg = makeRegistry();
        reg.register({ name: 'team.dispatch', capability: 'orchestrator', scope: 'execute', requiresConsent: false, description: 'd', schema: dispatchTool.schema, run: (a, c) => dispatchTool.run(a, c) });
        let wsScrub = 'unset';
        reg.register({ name: 'cab.peek', capability: 'cabinet', scope: 'read', schema: { type: 'object', properties: {} }, run: async (a, c) => { wsScrub = c.scrubText; return 'ok'; } });
        attachResultScrub(PS.scrubStored);
        const r = await reg.dispatch({ id: 'd6', name: 'team.dispatch', args: { workers: [{ agentId: 'w1', prompt: 'a' }, { agentId: 'w2', prompt: 'b' }] } },
          openCtx({ agentId: 'lead', parkOutput, outputMax: 20000, consent: async () => true, approve: async () => true }));
        await reg.dispatch({ id: 'c6', name: 'cab.peek', args: {} }, openCtx());
        attachResultScrub(null);
        A.ok(r.ok, '6: precondition, the dispatch ran (' + String(r.content).slice(0, 200) + ')');
        const files = spilled.filter(x => /^\.output\/team\.dispatch-w[12]-/.test(String(x.path)));
        A.eq(files.length, 2, '6: each worker\'s cut text is spilled to its own .output/team.dispatch-<worker> file (' + JSON.stringify(spilled.map(x => x.path)) + ')');
        const disk = files.map(x => fs.readFileSync(path.join(root, 'lead', x.path), 'utf8'));
        disk.forEach((t, i) => {
          A.ok(t.length > 60000 && /OPENAI_API_KEY=/.test(t), '6: ' + files[i].path + ' is the worker\'s whole text');
          A.ok(!leaks(t), '6: ' + files[i].path + ' holds no raw vendor key and no password');
        });
        A.ok(!leaks(r.content), '6: the rows the lead sees carry neither');
        let rows = [];
        try { rows = JSON.parse(String(r.content)); } catch (e) { A.ok(false, '6: the dispatch result is the JSON rows (' + e.message + ')'); }
        const cutRows = rows.filter(x => x && x.resultTruncated);
        A.eq(cutRows.length, 2, '6: both rows were cut to fit');
        for (const row of cutRows) {
          const k = files.findIndex(x => x.path === row.resultPath);
          A.ok(k >= 0, '6: ' + row.agentId + '\'s row names its spilled file (' + row.resultPath + ')');
          A.eq(row.resultChars, k >= 0 ? disk[k].length : -1, '6: ' + row.agentId + '\'s resultChars is its spilled file\'s length');
        }
        A.eq(wsScrub, null, '6: a workspace tool is handed no scrubText (its result is never scrubbed)');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  } finally { attachResultScrub(null); }
  A.report('registry.park-scrubbed.test');
})().catch(e => { console.log('FAIL: registry.park-scrubbed.test threw -- ' + (e && e.stack || e)); process.exit(1); });
