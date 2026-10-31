/* node test/tool-refusal-reason.test.js — a HOST refusal shows its own reason on the person's tool line
   (run-paths-polish P2, 2026-10-30).

   COMMS drew every refused browser.upload and web_request as "✗ error" in the expanded tool line: the reason (a
   protected file, a hard link, a file outside the run's folders, a staged copy that changed) reached the person only
   through the agent's words. Now a refusal the HOST wrote (e.hostAuthored: no page or remote byte in it) carries its
   own reason end to end, and no host path ever reaches the line:
     1. registry.js: the reason is the refusal's own words without the "browser.upload:" frame, WHOLE, through the
        station's stored-text scrub (whatever the tool's own opt-out); an error that is not the host's carries none;
     2. loop.js: agent.tool_result carries it (only on an error);
     3. index.js: loopEmit scrubs host paths out of the whole reason (host-path-scrub.js, the [workspace] placeholder)
        and only THEN bounds it to 400 characters (boundedScrub), so a workspace path in a refusal is never shown.
        Codex A3-REFUSAL-01 (a3-refusal-projection-harness.cjs): the registry cut the reason to 400 BEFORE either scrub,
        so a workspace path crossing the cut lost its tail, matched no prefix, and its head (the account name, a partial
        AppData path) was shown and kept by Channels; a held secret crossing it leaked its first half the same way.
        Every cut from 300 to 430 characters, in each spelling the scrub knows, is checked here;
     4. chat.js: the expanded line reads "✗ <reason>" (the summary otherwise, as before), and channels.js keeps the
        reason so a re-drawn rail after a switch shows it too;
     5. the refusals named in the walk are the host's: browser.upload's egress refusals and its staged-copy recheck,
        and web_request's ${file:…} refusal. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry, attachResultScrub } = require('../sidecar/tools/registry.js');
const { makeHostPathScrub, boundedScrub } = require('../sidecar/host-path-scrub.js');
const { readSidecarIndex } = require('./helpers/source.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const hostRefusal = msg => Object.assign(new Error(msg), { hostAuthored: true });

(async () => {
  // ---- 1 + 2. the registry carries the reason; the loop emits it ----
  {
    const reg = makeRegistry();
    const SCHEMA = { type: 'object', properties: {} };
    reg.register({ impact: 'none', name: 'browser.upload', capability: 'web', resultScrub: false, schema: SCHEMA,
      run: async () => { throw hostRefusal('browser.upload: ".env" is a protected file (credentials or repository internals) and never leaves the station; key sk-test-SECRETSECRET'); } });
    reg.register({ impact: 'none', name: 'page.thing', schema: SCHEMA, run: async () => { throw new Error('page.thing: something the PAGE said'); } });
    reg.register({ impact: 'none', name: 'long.refusal', schema: SCHEMA, run: async () => { throw hostRefusal('x'.repeat(2000)); } });
    reg.register({ impact: 'none', name: 'held.refusal', schema: SCHEMA, run: async () => { throw hostRefusal('y'.repeat(390) + ' Rq9Lm2Vs4Pa7Nx3Uc6Bz1Df8 is held'); } });
    attachResultScrub(text => String(text).replace(/sk-test-[A-Z]+/g, '[redacted-key]').split('Rq9Lm2Vs4Pa7Nx3Uc6Bz1Df8').join('[held-secret]'));
    try {
      const direct = await reg.dispatch({ id: 'd1', name: 'browser.upload', args: {}, argsRaw: '{}' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' });
      A.ok(direct.isError && direct.hostAuthored === true, 'a host refusal is an error the host wrote');
      A.eq(direct.reason, '".env" is a protected file (credentials or repository internals) and never leaves the station; key [redacted-key]',
        'P2 registry: the reason is the refusal\'s own words, without the tool-name frame, through the stored-text scrub (even for a tool that opts out of the result scrub)');
      const page = await reg.dispatch({ id: 'd2', name: 'page.thing', args: {}, argsRaw: '{}' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' });
      A.ok(page.isError && page.reason === undefined, 'P2 registry: an error that is not the host\'s carries no reason (a page could have written it)');
      const long = await reg.dispatch({ id: 'd3', name: 'long.refusal', args: {}, argsRaw: '{}' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' });
      A.ok(typeof long.reason === 'string' && long.reason.length === 2000, 'A3-REFUSAL-01 registry: the reason is kept WHOLE here (no cut before the scrubs): ' + (long.reason || '').length);
      const lineOf = (r, scrub) => (typeof boundedScrub === 'function' ? boundedScrub(scrub || (t => t), r, 400) : String(r).slice(0, 400));
      const bounded = lineOf(long.reason);
      A.ok(bounded.length <= 400 && /…$/.test(bounded), 'P2 host: the line the person sees is bounded (' + bounded.length + ')');
      const held = await reg.dispatch({ id: 'd4', name: 'held.refusal', args: {}, argsRaw: '{}' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' });
      const heldLine = lineOf(held.reason);
      A.ok(!/Rq9L|Rq9Lm2Vs4P/.test(heldLine) && heldLine.length <= 400, 'A3-REFUSAL-01: a held secret crossing the cut never shows a part of itself (was: its first half): ' + JSON.stringify(heldLine.slice(380)));

      const bus = A.makeBus();
      const seq = A.collectBus(bus, events.names());
      const turn = [
        { type: 'tool_start', index: 0, id: 'c0', name: 'browser.upload' }, { type: 'tool_args', index: 0, chunk: '{}' },
        { type: 'tool_start', index: 1, id: 'c1', name: 'page.thing' }, { type: 'tool_args', index: 1, chunk: '{}' },
        { type: 'done', finishReason: 'tool_calls' }
      ];
      const provider = makeReplayProvider({ turns: [turn, [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]] });
      await runAgentLoop({
        messages: [{ role: 'user', content: 'go' }], provider, emit: makeEmitter(bus, () => {}),
        cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r', tools: [],
        limits: { maxIters: 3, grace: false }, dispatch: (c, ctx) => reg.dispatch(c, ctx),
        capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, clock: { now: () => Date.now() }
      });
      const results = seq.filter(e => e.name === 'agent.tool_result').map(e => e.payload);
      const host = results.find(p => p.callId === 'c0'), other = results.find(p => p.callId === 'c1');
      A.ok(host && /^"\.env" is a protected file/.test(host.reason || '') && host.summary === 'error' && host.isError === true,
        'P2 loop: agent.tool_result carries the host refusal\'s reason beside its summary: ' + JSON.stringify(host));
      A.ok(other && !('reason' in other), 'P2 loop: and none for an error the host did not write');
      A.ok(events.validate('agent.tool_result', host).ok !== false, 'the frozen contract accepts the payload as it is');
    } finally { attachResultScrub(null); }
  }

  // ---- 3. the host scrubs host paths out of the reason before it streams ----
  {
    const idx = readSidecarIndex();
    const at = idx.indexOf('const loopEmit = (name, payload) => {');
    const head = at < 0 ? '' : idx.slice(at, at + 600);
    A.ok(/if \(name === 'agent\.tool_result' && payload && typeof payload\.reason === 'string'\) payload = Object\.assign\(\{\}, payload, \{ reason: HostPathScrub\.boundedScrub\(scrubOutbound, payload\.reason, 400\) \}\);/.test(head),
      'A3-REFUSAL-01 host: loopEmit runs a tool_result\'s WHOLE reason through scrubOutbound, then bounds it, before anything else sees it');
    A.ok(/const scrubOutbound = HostPathScrub\.makeHostPathScrub\(\{ fixed: \[WORKSPACES\]/.test(idx), 'P2 host: scrubOutbound is the one host-path scrub, over the workspaces root');
    const WS = 'C:\\Users\\andro\\AppData\\Local\\StarNet\\workspaces';
    const scrub = makeHostPathScrub({ fixed: [WS] });
    const shown = scrub('browser.upload: "notes.txt" cannot be read under ' + WS + '\\alpha\\notes.txt (EACCES)');
    A.ok(!/AppData|andro/i.test(shown) && /\[workspace\]\\alpha\\notes\.txt/.test(shown), 'P2 host: a workspace path in a reason is shown as [workspace]: ' + shown);
    // A3-REFUSAL-01: a host refusal (the browser's invalid-URL guard words) with the workspace root crossing the cut,
    // through the REAL registry (whole reason), then the host's line (scrub whole, then bound): never a fragment
    const reg2 = makeRegistry();
    let raw = '';
    reg2.register({ impact: 'none', name: 'browser.navigate', schema: { type: 'object', properties: {} }, run: async () => { throw hostRefusal('invalid URL: ' + raw); } });
    const SYN = 'C:\\Users\\SYNTHETIC_OWNER\\AppData\\Local\\StarNet\\workspaces';
    const scrubSyn = makeHostPathScrub({ fixed: [SYN], env: null });
    const forms = [SYN, SYN.split('\\').join('/'), encodeURIComponent(SYN), SYN.split('\\').join('\\\\'), SYN.toUpperCase()];
    let cases = 0, fragments = 0, over = 0, split = 0, sample = '';
    for (const form of forms) for (let at = 300; at <= 430; at++) {
      raw = 'bad '.repeat(120).slice(0, Math.max(0, at - 13)) + form + '\\agent\\notes.txt';
      const r = await reg2.dispatch({ id: 'n' + at, name: 'browser.navigate', args: {}, argsRaw: '{}' }, { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a' });
      const out = typeof boundedScrub === 'function' ? boundedScrub(scrubSyn, r.reason || '', 400) : scrubSyn(r.reason || '');
      cases++;
      if (/SYNTHETIC|AppData|Users|C%3A|C:/i.test(out)) { fragments++; sample = sample || out.slice(-48); }
      if (out.length > 400) over++;
      if (/\[[a-z]*…$/.test(out) && !/\[workspace\]…$/.test(out)) split++;
    }
    A.ok(cases === 655 && fragments === 0, 'A3-REFUSAL-01: no cut from 300 to 430, in any spelling, shows a part of the workspace path (' + fragments + ' of ' + cases + ' did' + (sample ? ', e.g. ' + JSON.stringify(sample) : '') + ')');
    A.ok(over === 0 && split === 0, 'A3-REFUSAL-01: every line is at most 400 characters and never cuts inside a [workspace] placeholder (' + over + ' over, ' + split + ' split)');
    A.eq(boundedScrub && boundedScrub(() => { throw new Error('synthetic scrub failure'); }, 'a reason', 400), '', 'A3-REFUSAL-01: a host scrub that throws withholds the reason (fail closed)');
  }

  // ---- 4. the person's line, live and re-drawn ----
  {
    const chat = read('frontend/app/chat.js');
    const grab = (re, what) => { const m = re.exec(chat); A.ok(!!m, 'chat.js has ' + what); return m ? m[0] : ''; };
    const src = [grab(/const deniedResult = ev => [^\n]*\n/, 'the denied-result predicate'), grab(/function foldChipResult\(chip, ev\) \{[\s\S]*?\n  \}/, 'foldChipResult')].join('\n');
    const el = () => { const cls = new Set(), kids = []; return { className: '', textContent: '', kids, cls, querySelector: () => null, dataset: {}, classList: { add: c => cls.add(c), remove: c => cls.delete(c) }, appendChild: k => { kids.push(k); return k; } }; };
    const chip = () => { const c = el(), parts = { '.tc-glyph': el(), '.tc-stat': el(), '.tc-detail': el() }; c.querySelector = s => parts[s] || null; c.parts = parts; return c; };
    const ctx = { document: { createElement: el }, TaskIntent: undefined, fmtMs: ms => ms + 'ms', cap: s => String(s) };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.fold = foldChipResult;', ctx);
    const line = ev => { const c = chip(); ctx.fold(c, ev); return c.parts['.tc-detail'].kids[0].textContent; };
    A.eq(line({ isError: true, summary: 'error', ms: 12, reason: '".env" is a protected file (credentials or repository internals) and never leaves the station' }),
      '✗ ".env" is a protected file (credentials or repository internals) and never leaves the station', 'P2 chat: a refused call\'s expanded line says why (was: "✗ error")');
    A.eq(line({ isError: true, summary: 'error', ms: 12 }), '✗ error', 'P2 chat: an error with no reason reads as before');
    A.eq(line({ isError: false, summary: 'selected 1 file(s)', ms: 9, reason: 'ignored' }), '✓ selected 1 file(s)', 'P2 chat: a success never shows a reason');
    A.ok(/Channels\.addToolResult\(ws\.id, \{ callId: ev\.callId, name: nm, summary: ev\.summary, isError: ev\.isError, ms: ev\.ms, reason: ev\.reason \}\)/.test(chat), 'P2 chat: the live result keeps its reason in the workstream');
    A.ok(/if \(e\.t === 'result'\) resolveChip\(\{ callId: e\.callId, summary: e\.summary, isError: e\.isError, ms: e\.ms, reason: e\.reason \}, e\.name\);/.test(chat), 'P2 chat: a re-drawn rail shows it too');
    const Channels = require('../frontend/app/channels.js');
    Channels.addToolResult('ws-p2', { callId: 'c0', name: 'browser.upload', summary: 'error', isError: true, ms: 1, reason: 'a refusal' });
    Channels.addToolResult('ws-p2', { callId: 'c1', name: 'browser.click', summary: 'ok', isError: false, ms: 1, reason: 'never kept' });
    const rows = Channels.get('ws-p2').toolEvents;
    A.ok(rows[0].reason === 'a refusal' && !('reason' in rows[1]), 'P2 channels: an errored result keeps its reason, a success keeps none');
  }

  // ---- 5. the walk's refusals are the host's ----
  {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-p2-')));
    const ws = path.join(scratch, 'workspaces');
    fs.mkdirSync(path.join(ws, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', '.env'), 'X=1');
    try {
      const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
      const driver = { snapshot: async () => [{ role: 'button', text: 'Choose', x: 1, y: 1, w: 10, h: 10 }], upload: async () => { throw new Error('not reached'); } };
      const b = makeBrowserTools({ driver, fsp, pathMod: path, root: ws });
      const ref = (await b.session.snapshot())[0].ref;
      let e1 = null;
      try { await b.tools.find(t => t.name === 'browser.upload').run({ ref, paths: ['.env'] }, { agentId: 'agent' }); } catch (e) { e1 = e; }
      A.ok(e1 && e1.hostAuthored === true && /protected file/.test(e1.message), 'P2: browser.upload\'s egress refusal is the host\'s (its line shows the reason)');
      const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
      const web = makeWebTools({ fetchImpl: async () => { throw new Error('nothing may be sent'); }, lookup: null, surface: 'interactive', redact: x => x,
        readWorkspaceFile: async () => { throw new Error('".env" is a protected file (credentials or repository internals) and never leaves the station'); } });
      const req = web.requestTool;
      let e2 = null;
      try { await req.run({ url: 'https://example.com/upload', method: 'POST', body: '{"f":"${file:.env}"}' }, { agentId: 'agent' }); } catch (e) { e2 = e; }
      A.ok(e2 && e2.hostAuthored === true && /^"\.env" is a protected file/.test(e2.message), 'P2: web_request\'s ${file:…} refusal is the host\'s, in the egress reader\'s words: ' + (e2 && e2.message));
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  A.report('tool-refusal-reason');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
