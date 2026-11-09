/* node test/desk-breakages.test.js — WHAT THE DESK CONFIRMATION BROKE, MENDED (fix-sec2-1108, review of fix-sec-1108 items 8-12).

   GHSA-2hpj-9wm7-rvg5 #1 put the authority changes behind a desk confirmation. An independent review found legitimate
   flows that lost function with it. This locks each mend:
     8. a terminal's ALWAYS (TUI 'a') and an MCP client's allow-always no longer leave the card waiting: the call is allowed
        once and the answer says why;
     9. a lead's approved station.power change (fullpower.set, permission.grant…) meets the desk through the Commander's
        window (index.js callOwnRouteAtDesk + the page verb station.desk_confirm) instead of always failing;
    10. a restore from a recovery bundle is adopted by the first keyed boot (authority-seal.js adoptRestored), and a bundle
        never carries the seal's bookkeeping;
    11. (unkeyed writes) is fix-sec2 F1, locked in test/authority-seal.test.js section 8;
    12. a name cut through an emoji no longer makes a confirmation the desktop can never show. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const IDX = read('sidecar/index.js');

(async () => {
  // ---- 12. names and dialog words are cut by code point ----
  {
    const D = require('../sidecar/deskproof.js');
    const rocket = '\u{1F680}';
    const name = 'A'.repeat(39) + rocket + 'tail';
    A.eq(Array.from(D.cutPoints(name, 40)).length, 40, 'cutPoints keeps 40 code points');
    A.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(D.cutPoints(name, 40)), 'and never leaves half of an emoji');
    A.eq(D.wholeText('x\uD83D'), 'x�', 'a lone high surrogate becomes U+FFFD');
    A.eq(D.wholeText('\uDE80y'), '�y', 'a lone low surrogate becomes U+FFFD');
    const words = D.cleanWords('Give "' + name.slice(0, 40) + '" FULL ACCESS', 1200);   // slice(0, 40) is the old cut: half an emoji
    A.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(words), 'cleanWords never issues a lone surrogate');
    let threw = false; try { JSON.parse(JSON.stringify({ s: words })); } catch (_) { threw = true; }
    A.ok(!threw, 'the words cross as JSON');
    const capped = D.cleanWords(rocket.repeat(200), 120);
    A.eq(Array.from(capped).length, 120, 'the cap counts code points, as the shell does (main.rs chars().count())');
    const Devices = require('../sidecar/remote/devices.js');
    A.ok(/cutPoints\(/.test(read('sidecar/remote/devices.js')), 'a phone name is cut by code point');
    A.ok(Devices, 'devices.js loads');
    A.ok(!/String\(row\.name \|\| id\)\.slice\(0, 40\)/.test(IDX) && !/String\(cur\.name \|\| agentId\)\.slice\(0, 40\)/.test(IDX), 'the agent names in a confirmation are cut by code point');
  }

  // ---- 8. MCP allow-always: allowed once, said so ----
  {
    const { makeBridge } = require('../sidecar/mcp/bridge-core.js');
    for (const refusal of ['desk_confirm_required', 'desk_only', 'desk_locked']) {
      const calls = [];
      const bridge = makeBridge({ callSidecar: async (m, p, b) => {
        calls.push(b && b.decision);
        if (b && b.decision === 'always') return { ok: true, status: 403, json: { ok: false, code: refusal, error: 'confirm at the desk', deskConfirm: refusal === 'desk_confirm_required' ? { id: 'dc_x', mode: 'page' } : undefined } };
        return { ok: true, status: 200, json: { ok: true, decision: b && b.decision } };
      } });
      const res = await bridge.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'permissions_respond', arguments: { id: 'run1|p1', decision: 'allow-always' } } });
      const text = JSON.stringify(res);
      A.eq(calls, ['always', 'once'], 'MCP allow-always that meets ' + refusal + ' is answered once (' + JSON.stringify(calls) + ')');
      A.ok(/allow-once/.test(text) && /StarNet window/.test(text), 'and the client is told it was allowed once and where ALWAYS is given');
    }
    const calls = [];
    const plain = makeBridge({ callSidecar: async (m, p, b) => { calls.push(b && b.decision); return { ok: true, status: 200, json: { ok: true } }; } });
    await plain.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'permissions_respond', arguments: { id: 'run1|p1', decision: 'allow-always' } } });
    A.eq(calls, ['always'], 'a station that takes ALWAYS is asked once, as before');
  }
  // ---- 8. the TUI 'a' key: the same, from the source (the dashboard is a live TUI) ----
  {
    const dash = read('bin/lib/dashboard.js');
    const at = dash.indexOf('async function answer(key) {');
    const body = dash.slice(at, at + 3000);
    A.ok(/asked === 'always' && deskRefusal\(r\)/.test(body), 'the terminal sees the desk refusal of ALWAYS');
    // breakage 8 (review-sec2): a terminal that cannot read the station's desk codes asks once, and prints no stray code there
    A.ok(/const asked = decision === 'always' && typeof client\.deskCodeFor !== 'function' \? 'once' : decision;/.test(body)
      && /decision: asked, via: 'terminal'/.test(body) && /let downgraded = asked !== decision;/.test(body), 'ALWAYS from a terminal that did not start the station is answered once, without asking for a code');
    const scSrc = read('bin/lib/station-commands.js');
    A.ok(/const asked = decision === 'session' && typeof station\.client\.deskCodeFor !== 'function' \? 'once' : decision;/.test(scSrc)
      && /let downgraded = asked !== decision;/.test(scSrc), '`starnet allow --session` on a station this terminal did not start: once, said so');
    A.ok(/decision: 'once', via: 'terminal'/.test(body) && /downgraded = true/.test(body), 'and answers the card once instead of leaving it waiting');
    A.ok(/allowed ONCE: ALWAYS is confirmed in the StarNet window/.test(body), 'and says so');
    A.ok(/function deskRefusal\(r\) \{ return !!\(r && r\.status === 403 && r\.json && \(r\.json\.code === 'desk_confirm_required' \|\| r\.json\.code === 'desk_only' \|\| r\.json\.code === 'desk_locked'\)\); \}/.test(dash), 'deskRefusal reads the station\'s own codes, the lockout too');
  }
  // ---- breakage 4 (review-sec2): the wrong-code lockout has its own name, and every "fall back to once" path reads it ----
  {
    const respond = require('../sidecar/respond.js');
    A.eq(respond.CODES.desk_locked, 403, 'desk_locked is one of the station\'s codes');
    const gate = A.fnBody(IDX, 'function deskGate(');
    A.ok(/if \(deskProof\.locked\(\)\) \{[\s\S]{0,200}respondFail\(res, 403, 'desk_locked',/.test(gate), 'the lockout answers desk_locked, not a bare forbidden');
    const sc = read('bin/lib/station-commands.js');
    A.ok(sc.indexOf("x.json.code === 'desk_only' || x.json.code === 'desk_locked'") > 0, '`starnet allow --session` falls back to once on a lockout');
    const acp = read('sidecar/acp/core.js');
    A.ok(acp.indexOf("j.code !== 'desk_only' && j.code !== 'desk_locked')) return r;") > 0, 'the ACP session answer falls back to once on a lockout, instead of leaving the card waiting');
    for (const rel of ['frontend/app/', 'website/app/app/']) {
      const app = read(rel + 'app.js'), h = read(rel + 'harness.js'), rt = read(rel + 'windows/routines.js'), fe = read(rel + 'friendlyerror.js');
      A.ok(app.indexOf("deskCode === 'desk_only' || deskCode === 'desk_locked'") > 0 && /r\.desk === 'desk_locked' \? 'Full Access was not confirmed: too many wrong confirmation codes/.test(app), rel + ': a raise refused by the lockout is the desk\'s answer, said in words');
      A.ok(h.indexOf("station === 'desk_only' || station === 'desk_locked'") > 0, rel + ': the page reads the lockout as the station\'s own answer, never a lost session');
      A.ok(rt.indexOf("response.code === 'desk_only' || response.code === 'desk_locked'") > 0, rel + ': a granted routine\'s edit can still be saved without its permissions during a lockout');
      A.ok(/desk_locked: 'station_refused'/.test(fe), rel + ': friendlyerror has the lockout\'s row');
    }
  }

  // ---- 9. a lead's approved escalation meets the desk through the window ----
  {
    const start = IDX.indexOf('const DESK_BRIDGE_WAIT_MS = ');
    const end = IDX.indexOf('// a short, human-readable summary of WHAT a consent prompt is approving');
    A.ok(start > 0 && end > start, 'callOwnRouteAtDesk is in index.js');
    const make = (routeImpl) => new Function('callOwnRoute', IDX.slice(start, end) + '\nreturn callOwnRouteAtDesk;')(routeImpl);
    const challenge = { id: 'dc_abcdefghijklmnopqrst', mode: 'desktop', title: 'StarNet — turn on FULL BYPASS', summary: 's', verb: 'Turn on FULL BYPASS' };
    const seen = [];
    const route = async (m, u, b, h) => {
      seen.push(h || null);
      if (h && h['x-starnet-desk-proof'] === challenge.id) return { status: 200, json: { ok: true, masterBypass: true } };
      return { status: 403, json: { ok: false, code: 'desk_confirm_required', deskConfirm: challenge } };
    };
    const asks = [];
    const yes = { request: async (verb, args, o) => { asks.push([verb, args, o]); return { ok: true, result: { confirmed: true, code: '' } }; } };
    const r = await make(route)(yes, { streamId: 's1', runId: 'r1' })('POST', '/api/permissions/bypass', { on: true });
    A.eq(r.status, 200, 'confirmed at the desk: the change is made');
    A.eq(asks.length, 1, 'the window was asked once');
    A.eq(asks[0][0], 'station.desk_confirm', 'over the station bridge verb station.desk_confirm');
    A.eq(asks[0][1].challenge.id, challenge.id, 'with the station\'s own challenge');
    A.eq(asks[0][1].origin, { streamId: 's1', runId: 'r1' }, 'and the run that asked (a browser page answers only for the run it watches)');
    A.ok(asks[0][2] && asks[0][2].timeoutMs >= 60000 && asks[0][2].timeoutMs < 120000, 'waiting long enough to read a dialog, inside the challenge\'s two minutes');
    A.eq(seen[1] && seen[1]['x-starnet-desk-proof'], challenge.id, 'the replay carries the challenge as its proof');
    const no = { request: async () => ({ ok: true, result: { confirmed: false } }) };
    const r2 = await make(route)(no, {})('POST', '/api/permissions/bypass', { on: true });
    A.ok(r2.status === 403 && r2.json.code === 'desk_not_confirmed' && /did not confirm/.test(r2.json.error) && /nothing changed/.test(r2.json.error), 'a no is refused with the reason');
    const none = { request: async () => ({ ok: false, unattended: true, error: 'no station page answered' }) };
    const r3 = await make(route)(none, {})('POST', '/api/permissions/bypass', { on: true });
    A.ok(r3.status === 403 && /no StarNet window answered/.test(r3.json.error), 'no window: refused, never assumed');
    const passthrough = await make(async () => ({ status: 200, json: { ok: true } }))(yes, {})('POST', '/api/budget/caps', {});
    A.ok(passthrough.status === 200 && asks.length === 1, 'a route that needs no desk is not confirmed');
    // the wiring
    A.ok(/route: callOwnRouteAtDesk\(stationBridge, \{ streamId: o\.streamId \|\| '', runId \}\)/.test(IDX), 'the station tools call routes through callOwnRouteAtDesk');
    A.ok(/req\[IN_PROCESS_REQUEST\] = true;/.test(IDX) && /if \(CLIENT_TOKEN && !\(req && req\[IN_PROCESS_REQUEST\] === true\) && !apiauth\.apiTokenOk\(req, API_TOKEN\)\)/.test(IDX), 'an in-process call gets a challenge (not desk_only), and only a JS property, never a header, marks it');
    A.ok(/for \(const k of \['x-starnet-desk-proof', 'x-starnet-desk-code'\]\) if \(extraHeaders && extraHeaders\[k\]\)/.test(IDX), 'callOwnRoute carries only the desk proof\'s headers');
    A.ok(/timeoutMs: isPower \? 150000 : 45000/.test(read('sidecar/tools/builtin/station-control.js')), 'station.power waits long enough for the dialog');
    // the page verb
    const sc = read('frontend/app/stationcommands.js');
    const v = sc.slice(sc.indexOf("'station.desk_confirm': async (a) => {"), sc.indexOf("'station.control': async (a) => {"));
    A.ok(/if \(c\.mode === 'desktop'\) \{ if \(!\(h\.isDesktop && h\.isDesktop\(\)\)\) throw quiet\(\); \}/.test(v), 'only the desktop window answers a desktop challenge');
    A.ok(/try \{ await requireWatching\(a\.origin\); \} catch \(_\) \{ throw quiet\(\); \}/.test(v), 'in a browser, only the page watching the run');
    A.ok(/const out = await h\.confirmAtDesk\(c\);/.test(v), 'and it confirms the way a click on that setting does');
    A.ok(/confirmAtDesk: c => deskConfirm\.confirmAtDesk\(c\),/.test(read('frontend/app/harness.js')), 'Harness exposes its desk confirmation');
    for (const f of ['frontend/app/stationcommands.js', 'frontend/app/harness.js'])
      A.eq(read(f), read(f.replace('frontend/app/', 'website/app/app/')), f + ' is mirrored into website/app');
  }

  // ---- 10. restore ----
  {
    const S = require('../sidecar/authority-seal.js');
    const KEY = Buffer.alloc(32, 3), OTHER = Buffer.alloc(32, 4);
    const roundTrip = v => JSON.parse(JSON.stringify(v));
    function station(files, record) {
      const mk = { value: undefined, read() { return this.value; }, write(v) { this.value = roundTrip(v); } };
      const rec = { value: record, read() { return this.value; }, drop() { this.value = undefined; } };
      const list = S.NAMES.map(name => ({ name, wrap: name === 'hooks.json' ? (v => Array.isArray(v) ? { hooks: v } : v) : undefined,
        read: () => files[name] === undefined ? undefined : roundTrip(files[name]), write: v => { files[name] = roundTrip(v); } }));
      return { mk, rec, list, seal: S.makeAuthoritySeal({ key: KEY, now: () => 9, marker: mk, restored: rec }) };
    }
    const elsewhere = S.makeAuthoritySeal({ key: OTHER, marker: { read: () => undefined, write: () => {} } });
    const files = {
      'agent.roster.json': roundTrip(elsewhere.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', name: 'NOVA', approvalMode: 'full', executionProfile: 'this-computer' }] })),
      'hooks.json': { hooks: [{ event: 'pre', command: 'node lint.js' }] }   // redacted by the bundle: no seal
    };
    const st = station(files, { version: 1, files: ['agent.roster.json', 'hooks.json'] });
    A.eq(st.seal.boot(st.list).mode, 'enforce', 'a restored workspace boots enforcing');
    A.ok(st.seal.open('agent.roster.json', files['agent.roster.json']).ok && st.seal.open('hooks.json', files['hooks.json']).ok, 'both restored files are sealed for this computer');
    A.eq(st.seal.open('agent.roster.json', files['agent.roster.json']).value.agents, [{ agentId: 'a', name: 'NOVA', approvalMode: 'ask' }], 'the roster keeps its agents, asking first (an approval made elsewhere does not travel)');
    A.eq(st.seal.open('hooks.json', files['hooks.json']).value.hooks, [{ event: 'pre', command: 'node lint.js' }], 'the hooks are kept (each still needs approval here)');
    A.eq(st.rec.value, undefined, 'the restore record is dropped');
    const n = st.seal.notices();
    A.ok(n.some(x => x.kind === 'restored' && /Restored from a recovery bundle/.test(x.text) && /asks first/.test(x.text)), 'one notice says what the restore means');
    A.ok(!n.some(x => x.kind === 'unsealed' || x.kind === 'mismatch' || x.kind === 'marker-missing'), 'nothing reads as changed outside StarNet');
    // the same computer, into the workspace that has its marker: the roster opens under this key and keeps its Full Access
    const homeMk = { value: undefined, read() { return this.value; }, write(v) { this.value = roundTrip(v); } };
    const here = S.makeAuthoritySeal({ key: KEY, now: () => 5, marker: homeMk });
    const files2 = { 'agent.roster.json': roundTrip(here.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] })) };
    const st2 = station(files2, { version: 1, files: ['agent.roster.json'] });
    st2.mk.value = roundTrip(homeMk.value);
    st2.seal.boot(st2.list);
    A.eq(st2.seal.open('agent.roster.json', files2['agent.roster.json']).value.agents[0].approvalMode, 'full', 'restored on the computer that sealed it, the roster is left as it is');
    // ... but into a folder without that marker (the bundle never carries it), nothing shows the copy is current (review
    // 4c): it is adopted asking first, like a roster from another computer
    const files2b = { 'agent.roster.json': roundTrip(files2['agent.roster.json']) };
    const st2b = station(files2b, { version: 1, files: ['agent.roster.json'] });
    st2b.seal.boot(st2b.list);
    A.eq(st2b.seal.open('agent.roster.json', files2b['agent.roster.json']).value.agents[0].approvalMode, 'ask', 'restored into a folder with no marker, the roster asks first');
    // a forged record admits nothing that gives power
    const files3 = { 'permissions.bypass.json': { version: 1, on: true }, 'hooks-allowed.json': { x: { event: 'pre', command: 'evil' } }, 'agent.roster.json': { version: 1, agents: [{ agentId: 'z', approvalMode: 'full' }] } };
    const st3 = station(files3, { version: 1, files: S.NAMES.slice() });
    st3.seal.boot(st3.list);
    A.eq(st3.seal.open('permissions.bypass.json', files3['permissions.bypass.json']).why, 'unsealed', 'a forged record never admits FULL BYPASS');
    A.eq(st3.seal.open('hooks-allowed.json', files3['hooks-allowed.json']).why, 'unsealed', 'nor a hook approval');
    A.eq(st3.seal.open('agent.roster.json', files3['agent.roster.json']).value.agents[0].approvalMode, 'ask', 'and a roster it admits asks first');
    // breakage 5 (review-sec2): a restore elsewhere keeps the NARROW profiles, and the notice names every profile it dropped
    const files4 = { 'agent.roster.json': roundTrip(elsewhere.seal('agent.roster.json', { version: 1, agents: [
      { agentId: 'a', name: 'NOVA', approvalMode: 'full', executionProfile: 'this-computer' },
      { agentId: 'b', name: 'VEGA', approvalMode: 'ask', executionProfile: 'trusted-project' },
      { agentId: 'c', name: 'CELL', approvalMode: 'ask', executionProfile: 'safe-cell' },
      { agentId: 'd', name: 'GEAR', approvalMode: 'ask', executionProfile: 'station-gear' }] })) };
    const st4 = station(files4, { version: 1, files: ['agent.roster.json'] });
    st4.seal.boot(st4.list);
    const back = st4.seal.open('agent.roster.json', files4['agent.roster.json']).value.agents;
    A.eq(back.map(x => [x.agentId, x.approvalMode, x.executionProfile || '']), [['a', 'ask', ''], ['b', 'ask', ''], ['c', 'ask', 'safe-cell'], ['d', 'ask', 'station-gear']], 'the wide profiles are dropped, the narrow ones kept (Safe Cell is never widened to the default)');
    const said = st4.seal.notices().filter(x => x.kind === 'restored').map(x => x.text).join(' ');
    A.ok(/Full Access was not carried over for "NOVA"\./.test(said), 'the notice names who lost Full Access: ' + said);
    A.ok(/back on the Station Gear profile until you choose theirs again here: "NOVA" \(was This Computer\), "VEGA" \(was Trusted Project\)\./.test(said), 'and whose profile went back to Station Gear, with what it was');
    A.ok(!/CELL|GEAR/.test(said), 'an agent that lost nothing is not named');
    A.eq(S.clampRoster({ version: 1, agents: [{ agentId: 'z', approvalMode: 'full', executionProfile: 'this-computer' }] }).agents, [{ agentId: 'z', approvalMode: 'ask' }], 'a tampered roster still loses a wide profile and Full Access, as before');
    A.ok(/restored: \{\s*read: \(\) => readJsonIfPresent\(path\.join\(WORKSPACES, authoritySealMod\.RESTORED_NAME\)\)/.test(IDX), 'index.js hands the seal the restore record');
    // the bundle side
    const R = require('../sidecar/station-recovery.js');
    for (const p of ['authority-seal.json', 'authority-restored.json', 'agent.roster.json.sealed-last', 'hooks.json.unsealed-2'])
      A.eq(R._internals.classifyPolicy(p, null).action, 'skip', 'a bundle never carries ' + p);
    A.eq(R._internals.classifyPolicy('agent.roster.json', null).action, 'include', 'the roster still travels');
    const rec = read('sidecar/station-recovery.js');
    A.ok(/sanitizeObject\(require\('\.\/authority-seal\.js'\)\.strip\(doc\), \[\], redacted\)/.test(rec), 'hooks.json travels without its seal (no mac read as a credential)');
    A.ok(/if \(broughtAuthority\.length \|\| RESTORED_SEALED\.some\(name => restored\.some\(r => r\.path === name\)\)\) writeFlushed\(fs, path\.join\(stage, RESTORED_NAME\)/.test(rec), 'a restore that brings them (or any other sealed file) leaves the record');
    A.ok(/const RESTORED_SEALED = RESTORED_AUTHORITY\.concat\(\['remote\.json', 'cron\.jobs\.json'\]\);/.test(rec), 'remote.json and cron.jobs.json leave it too');
    // breakage 6 (review-sec2): a restore on the same computer that brings a sealed file it does not re-seal (remote.json)
    // gives no marker-missing warning; that file is still not used, and its notice says it came back with the restore
    {
      const homeMk5 = { value: undefined, read() { return this.value; }, write(v) { this.value = roundTrip(v); } };
      const here5 = S.makeAuthoritySeal({ key: KEY, now: () => 5, marker: homeMk5 });
      const files5 = { 'agent.roster.json': roundTrip(here5.seal('agent.roster.json', { version: 1, agents: [{ agentId: 'a', approvalMode: 'full' }] })),
        'remote.json': roundTrip(here5.seal('remote.json', { version: 1, enabled: true })) };
      const st5 = station(files5, { version: 1, files: ['agent.roster.json'] });
      A.eq(st5.seal.boot(st5.list).mode, 'enforce', 'the restored workspace boots enforcing');
      const r5 = st5.seal.open('remote.json', files5['remote.json']);
      A.ok(!r5.ok && r5.why === 'stale', 'remote.json from before the restore is still not used (nothing is trusted more for a restore)');
      const n5 = st5.seal.notices();
      A.ok(!n5.some(x => x.kind === 'marker-missing'), 'no marker-missing warning: ' + n5.map(x => x.kind).join(','));
      A.ok(n5.some(x => x.kind === 'stale' && x.name === 'remote.json' && /came back with a restore from a recovery bundle/.test(x.text) && /paired phone waits for your approval/.test(x.text)), 'and remote.json\'s notice says it came back with the restore, and what that means');
      // the same files with no restore record: the marker was deleted, and that is still said
      const files6 = roundTrip(files5);
      const st6 = station(files6, undefined);
      st6.seal.boot(st6.list);
      A.ok(st6.seal.notices().some(x => x.kind === 'marker-missing'), 'without a restore record, a missing marker still warns');
    }
  }

  // ---- breakage 7 (review-sec2): the person's time at the desk does not count against the request's deadline ----
  {
    const vm = require('vm');
    const harness = read('frontend/app/harness.js');
    const make = o => new Function(A.fnBody(harness, 'function deskConfirmation(') + '\nreturn deskConfirmation;')()(o);
    // a browser's code prompt: it blocks every timer while it is open, and its time is counted before any timer can run
    let t = 1000;
    const ch = { id: 'dc_' + 'b'.repeat(24), mode: 'page', codeWhere: 'terminal', title: 'T', summary: 'S', verb: 'Give' };
    const dc = make({ desktop: false, now: () => t, win: { prompt: () => { t += 90000; return '123456'; } } });
    A.eq(dc.deskTime(), { open: 0, spentMs: 0 }, 'nothing at the desk yet');
    const out = dc.confirmAtDesk(ch);
    A.eq(dc.deskTime().spentMs, 90000, 'a 90 s code prompt is counted the moment it closes (before the overdue timer can fire)');
    A.eq(await out, { yes: true, code: '123456' }, 'and the code is handed on');
    // the shell's dialog: open while the person reads it
    let close;
    const dd = make({ desktop: true, now: () => t, invoke: () => new Promise(r => { close = r; }), win: null });
    const asked = dd.confirmAtDesk(Object.assign({}, ch, { mode: 'desktop' }));
    await new Promise(r => setImmediate(r));
    A.eq(dd.deskTime().open, 1, 'the shell\'s dialog is open');
    t += 75000; close();
    A.eq(await asked, true, 'the yes comes back');
    A.eq(dd.deskTime(), { open: 0, spentMs: 75000 }, 'and its 75 s are counted');
    // requestJson, run with a desk that is busy: its deadline waits for the dialog and moves by the time spent there
    const start = harness.indexOf('  async function requestJson('), end = harness.indexOf('\n  // ONE fold point', start);
    const desk = { open: 0, spentMs: 0 };
    function client() {
      const timers = new Map();
      let release;
      const ctx = vm.createContext({ AbortController, setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => { timers.delete(id); },
        fetch: () => new Promise(r => { release = r; }), deskConfirm: { deskTime: () => ({ open: desk.open, spentMs: desk.spentMs }) } });
      vm.runInContext(harness.slice(start, end) + '\nthis.api = api;', ctx);
      const fire = () => { const all = [...timers.entries()]; timers.clear(); for (const [, x] of all) x.fn(); return all.map(([, x]) => x.ms); };
      return { api: ctx.api, timers, fire, release: v => release(v) };
    }
    {
      const c = client();
      let settled = null;
      c.api.post('/api/agent/approval', { agentId: 'a', mode: 'full' }).then(v => { settled = ['ok', v]; }, e => { settled = ['no', e.message]; });
      await new Promise(r => setImmediate(r));
      desk.open = 1;
      A.eq(c.fire(), [60000], 'the deadline fires while the dialog is open...');
      await new Promise(r => setImmediate(r));
      A.ok(settled === null && c.timers.size === 1 && [...c.timers.values()][0].ms === 1000, '...and waits for it instead of aborting the replay');
      desk.open = 0; desk.spentMs = 90000;
      c.fire();
      await new Promise(r => setImmediate(r));
      A.ok(settled === null && c.timers.size === 1 && [...c.timers.values()][0].ms === 90000, 'once it closes, the deadline moves by the 90 s spent at the desk');
      c.release(new Response('{"ok":true,"approvalMode":"full"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
      A.ok(settled && settled[0] === 'ok' && settled[1].ok === true, 'the replay\'s answer lands: the person who said yes is told yes');
    }
    {
      desk.open = 0; desk.spentMs = 0;
      const c = client();
      let settled = null;
      c.api.post('/api/x', {}).then(() => { settled = 'ok'; }, e => { settled = e.message; });
      await new Promise(r => setImmediate(r));
      c.fire();
      await new Promise(r => setImmediate(r));
      A.ok(/did not confirm this change/.test(String(settled)), 'with nobody at the desk, the deadline is the deadline, as before');
    }
    A.eq(read('website/app/app/harness.js'), harness, 'harness.js is mirrored into website/app');
  }

  // ---- final review B5: a Full Access raise confirmed with a wider profile is one plain question ----
  {
    const start = IDX.indexOf('function deskWords(');
    const src = IDX.slice(start, IDX.indexOf('\n}\n', start) + 2);
    const words = new Function('deskProofMod', src + '\nreturn deskWords;')(require('../sidecar/deskproof.js'));
    const both = words('execution-profile', { names: 'FULL ACCESS for "Overseer", and "Overseer" use the THIS COMPUTER profile', question: 'Give "Overseer" FULL ACCESS and the THIS COMPUTER profile?' });
    A.ok(/^Give "Overseer" FULL ACCESS and the THIS COMPUTER profile\?\n\n/.test(both.summary) && !/Let FULL ACCESS/.test(both.summary), 'B5: the dialog asks one plain question: ' + both.summary.split('\n')[0]);
    const only = words('execution-profile', { names: '"Nova" use the THIS COMPUTER profile' });
    A.ok(/^Let "Nova" use the THIS COMPUTER profile\?\n\n/.test(only.summary), 'B5: a profile alone keeps its words');
    A.ok(IDX.indexOf("question = 'Give ' + parts.join(', and ') + '?';") > 0 && IDX.indexOf("nameOf(id) + ' FULL ACCESS and the ' + label(id) + ' profile'") > 0, 'B5: the roster route builds it from the agents asked for');
  }

  // ---- final review B2: a restored routine store is worded as a restore ----
  {
    const open = A.fnBody(IDX, 'function cronOpenAuthority(');
    A.ok(open.indexOf("(r.restored\n        ? 'cron.jobs.json came back with a restore from a recovery bundle") > 0, 'B2: a restore is said as a restore, not "changed outside StarNet"');
  }

  A.report('desk-breakages.test');
})().catch(e => { console.error(e); process.exit(1); });
