/* node test/discovery.http.test.js — ENVIRONMENT DISCOVERY routes, boot-level (mirrors scout.http.test.js).

   Boots the real sidecar, blesses a REAL throwaway git repo through the real /api/projects/bless machinery,
   forces one discovery cycle, and proves the whole loop over HTTP:
     - the trust boundary holds end-to-end: before the bless, a forced scan stages NOTHING (binding no-roots);
     - after the bless, the scan finds the repo's REAL chores — the uncommitted working tree and the TODO
       marker — and every staged finding carries the repo's own line as its verbatim quote;
     - the findings land on the ONE recommendation ledger (surface 'discovery', quote-typed evidence);
     - dismiss removes the finding, denylists its fingerprint TO DISK, and a forced re-scan does NOT re-stage
       it (dismiss = never again, surviving the next cycle);
     - accept resolves it (no re-nag) and the routes answer honestly for unknown ids.
   ZERO model spend: discovery never calls a model — the repo's own lines are the evidence.
   Part of test:http (child-process boot tests don't gate the fast lane). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function git(cwd, args) { execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true }); }

(async () => {
  // a REAL throwaway repo with exactly two honest chores: one TODO marker, one uncommitted file.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-disc-repo-'));
  fs.writeFileSync(path.join(repo, 'main.js'), 'exports.run = () => 1;\n// TODO: wire the discovery dial\n');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'x@x.x']); git(repo, ['config', 'user.name', 'x']);
  git(repo, ['add', 'main.js']); git(repo, ['commit', '-q', '-m', 'seed']);
  fs.writeFileSync(path.join(repo, 'notes.md'), 'uncommitted scratch\n');

  const fixture = SidecarFixture.create({
    prefix: 'sk-discovery-',
    env: { OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' }
  });
  const ws = fixture.workspace;
  await fixture.start();
  const B = fixture.baseUrl;
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    // token gate: the discovery read is a data route like any other.
    const noTok = await fetch(B + '/api/discovery');
    A.eq(noTok.status, 403, 'GET /api/discovery without a token -> 403');
    apiToken = fixture.token;

    // BEFORE the bless: nothing to scan, and the engine says so by name.
    const cold = await j('POST', '/api/discovery/scan');
    A.eq(cold.status, 200, 'forced scan answers 200');
    A.eq(cold.body.fired, false, 'no blessed roots -> the cycle does not fire');
    A.eq(cold.body.binding, 'no-roots', '…and names WHY (no-roots)');

    // PERSIST-IF-CHANGED (2026-10-19): a no-fire cycle that changes nothing must not rewrite the state file. The
    // 15-min tick used to do two durable writes (.bak + main) of byte-identical content on every pass.
    const stateFile = path.join(ws, 'discovery.state.json');
    const st1 = fs.statSync(stateFile), text1 = fs.readFileSync(stateFile, 'utf8');
    const bak1 = fs.existsSync(stateFile + '.bak') ? fs.statSync(stateFile + '.bak').mtimeMs : null;
    await new Promise(r => setTimeout(r, 50));   // a rewrite would move mtime past this gap
    const cold2 = await j('POST', '/api/discovery/scan');
    A.eq(cold2.body.binding, 'no-roots', 'a second no-fire cycle names the same binding');
    A.eq(fs.statSync(stateFile).mtimeMs, st1.mtimeMs, 'an unchanged no-fire cycle does NOT rewrite discovery.state.json');
    A.eq(fs.readFileSync(stateFile, 'utf8'), text1, '…and the content is exactly what was already on disk');
    A.eq(fs.existsSync(stateFile + '.bak') ? fs.statSync(stateFile + '.bak').mtimeMs : null, bak1, '…nor its .bak');

    // bless the repo through the REAL grant machinery (the only door — discovery never blesses).
    // ...confirmed at the desk (GHSA-2hpj #1) with the code this station printed, as the person at it types it
    const bless = await fixture.deskJson('POST', '/api/projects/bless', { path: repo });
    A.eq(bless.status, 200, 'POST /api/projects/bless -> 200');

    // the forced cycle scans the blessed root and stages the repo's real chores.
    const scan = await j('POST', '/api/discovery/scan');
    A.eq(scan.body.fired, true, 'with a blessed root the forced cycle fires');
    A.ok(scan.body.staged >= 2, 'it staged the repo\'s chores (wip + todo), got ' + scan.body.staged);

    const g1 = await j('GET', '/api/discovery');
    A.eq(g1.status, 200, 'GET /api/discovery -> 200');
    const wip = g1.body.staged.find(f => f.kind === 'wip');
    const todo = g1.body.staged.find(f => f.kind === 'todo');
    A.ok(!!wip, 'the uncommitted working tree became a wip finding');
    A.ok(wip.quote.indexOf('notes.md') >= 0, '…citing the porcelain row verbatim (' + wip.quote + ')');
    A.ok(!!todo, 'the TODO marker became a finding');
    A.ok(todo.quote.indexOf('TODO: wire the discovery dial') >= 0, '…citing the marker line verbatim');
    A.ok(g1.body.ledger.some(e => e.outcome === 'staged'), 'every stage is on the attempt ledger');

    // the findings land on the ONE recommendation ledger, quote-typed.
    const recs = await j('GET', '/api/recommendations?surface=discovery&limit=10');
    A.ok((recs.body.entries || []).length >= 2, 'the impressions are on the durable recommendation ledger');
    const row = recs.body.entries.find(e => e.kind === 'todo');
    A.ok(row && row.evidence[0] && row.evidence[0].quote.indexOf('TODO') >= 0, 'the ledger evidence is the verbatim quote');

    // dismiss: gone, denylisted TO DISK, and a forced re-scan does not resurrect it.
    const dis = await j('POST', '/api/discovery/decide', { id: todo.id, decision: 'dismiss' });
    A.eq(dis.body.ok, true, 'dismiss acknowledged');
    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'discovery.state.json'), 'utf8'));
    A.ok(onDisk.state.denylist.indexOf(todo.fingerprint) >= 0, 'the dismissed fingerprint is persisted to the denylist');
    await j('POST', '/api/discovery/scan');
    const g2 = await j('GET', '/api/discovery');
    A.eq(g2.body.staged.some(f => f.fingerprint === todo.fingerprint), false,
      'a forced re-scan does NOT re-stage a dismissed finding (dismiss = never again)');

    // accept resolves (picked up — no re-nag on the next scan either).
    const acc = await j('POST', '/api/discovery/decide', { id: wip.id, decision: 'accept' });
    A.eq(acc.body.ok, true, 'accept acknowledged');
    await j('POST', '/api/discovery/scan');
    const g3 = await j('GET', '/api/discovery');
    A.eq(g3.body.staged.some(f => f.fingerprint === wip.fingerprint), false, 'an accepted finding does not re-stage');

    const stale = await j('POST', '/api/discovery/decide', { id: todo.id, decision: 'dismiss' });
    A.eq(stale.body.ok, false, 'deciding an already-decided id answers ok:false, never a throw');
    const bad = await j('POST', '/api/discovery/decide', { id: 'x', decision: 'shred' });
    A.eq(bad.status, 400, 'an illegal decision -> 400');

    console.log('discovery.http.test: OK');
  } finally {
    await fixture.dispose();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('discovery.http.test');
})().catch(e => { console.error(e); process.exit(1); });
