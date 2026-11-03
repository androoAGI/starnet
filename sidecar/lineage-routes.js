/* sidecar/lineage-routes.js — the lineage route group: what the recovery gate reads, and its two lifecycle requests.

   Routes (all behind the central /api auth gate; nothing here is reachable without the station token):
     GET  /api/lineage              the boot's bounded lineage evidence, its paths redacted for the page
     GET  /api/lineage/report       the redacted recovery report, as a download
     POST /api/lineage/recover      {candidateId}   the Commander's chosen station, activated at the next boot
     POST /api/lineage/start-fresh  START FRESH, the gate's third exit

   publicLineage() is the same redacted view GET /api/save carries. index.js builds this group once, at boot, from the
   lineage it captured before any store opened. test/workspace-lineage.http.test.js and
   test/workspace-recovery-fresh-start.http.test.js drive every route here through the real sidecar;
   test/start-fresh-generation.http.test.js drives START FRESH end to end.

   BOTH LIFECYCLE REQUESTS rename this whole generation at the next boot, and on Windows a directory with an open handle does
   not rename. The station browser's durable profile lives inside the generation, so before a request is taken the browser is
   closed and any orphan on its profile is ended, and the sidecar then leaves through the graceful path, which reaps its
   children and exits 75, the guardian's restart code. A bare process.exit skipped all of that. Chromium can still start a
   process as its browser closes that outlives it holding no lock file; the next boot ends whatever is left on the profile
   before it tries the rename again (workspace-recovery.js moveAside). */
'use strict';
const { note: failNote } = require('./failopen.js');

// how long a request waits for the browser to go: past this the rename may still work, and if not it fails closed and says so
const QUIESCE_MS = 12000;

function makeLineageRoutes(deps) {
  const { fs, path, platform, arch, homedir, workspaceRoot, candidateRoots, lineage, inspection, recovery, stationView, requestFresh,
    desktopShell, readBody, now, restart, quiesce, buildVersion, log } = deps;
  const quiesceMs = Number(deps.quiesceMs) > 0 ? Number(deps.quiesceMs) : QUIESCE_MS;

  async function quiesceStation() {
    let timer = null;
    const bound = new Promise(resolve => { timer = setTimeout(resolve, quiesceMs); });
    try {
      const done = await Promise.race([Promise.resolve().then(quiesce), bound]);
      if (done && done.ok === false) log('[lineage] the station browser may still hold this generation: ' + String(done.error));
    } catch (e) { failNote('lineage.quiesce', e); }
    finally { clearTimeout(timer); }
  }

  function publicWorkspaceLineage() {
    const home = homedir();
    const out = JSON.parse(JSON.stringify(lineage));
    out.currentWorkspace = recovery._internals.displayPath(out.currentWorkspace, home, path, platform);
    out.evidence = (out.evidence || []).map(row => Object.assign({}, row, {
      root: recovery._internals.displayPath(row.root, home, path, platform)
    }));
    out.station = stationView();   // the live record (founding moves it): { state, generationId, writeError? }
    return out;
  }

  function serveWorkspaceLineage(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, lineage: publicWorkspaceLineage() }));
  }
  function serveWorkspaceRecoveryReport(req, res) {
    const report = recovery.recoveryReport({
      fs, path, platform, arch, home: homedir(), workspaceRoot,
      candidateRoots,
      inspection, publicLineage: publicWorkspaceLineage(), now
    });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="starnet-recovery-report.json"'
    });
    res.end(JSON.stringify(report, null, 2) + '\n');
  }
  async function handleWorkspaceRecovery(req, res) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    let body;
    try { body = JSON.parse(await readBody(req, 4096)) || {}; }
    catch (_) { return json(400, { ok: false, error: 'bad json' }); }
    try {
      await quiesceStation();
      const result = recovery.requestRecovery({
        fs, path, platform, home: homedir(), workspaceRoot,
        candidateRoots,
        inspection, candidateId: String(body.candidateId || ''), now
      });
      json(202, Object.assign({}, result, { desktopWillRestart: desktopShell }));
      // Exit only after the authenticated response is flushed. The desktop guardian respawns automatically;
      // a manual sidecar is explicitly told by the UI to restart it. The next boot applies before store open.
      setTimeout(() => restart('recovery'), 150);
    } catch (error) {
      json(409, { ok: false, error: String(error && error.message || error) });
    }
  }

  /* START FRESH (the gate's third exit). The Commander has explicitly chosen a new station over prior-install evidence
     nothing could recover. This takes the request and exits exactly like a recovery request; the next boot sets the whole
     generation aside in a quarantine folder (never deleted) and the desktop guardian's respawn lands in clean onboarding. If
     the workspace moved on or the rename failed, that boot says so in lineage.lastFresh. Refused while a verified recovery
     is pending — that path wins. */
  async function handleWorkspaceStartFresh(req, res) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      await quiesceStation();
      const result = requestFresh({
        fs, path, platform, workspaceRoot,
        candidateRoots, now, buildVersion
      });
      if (!result.ok) return json(409, { ok: false, error: result.error });
      log('[lineage] START FRESH requested: the next boot sets this generation aside; acknowledged ' + result.acknowledgedRoots.length + ' external root(s)');
      json(202, { ok: true, restartRequired: true, requestedAt: result.requestedAt, desktopWillRestart: desktopShell });
      setTimeout(() => restart('start-fresh'), 150);
    } catch (error) {
      json(409, { ok: false, error: String(error && error.message || error) });
    }
  }

  return {
    publicLineage: publicWorkspaceLineage,
    routes: [
      { m: 'GET', exact: '/api/lineage/report', h: serveWorkspaceRecoveryReport },
      { m: 'POST', exact: '/api/lineage/recover', h: handleWorkspaceRecovery },
      { m: 'POST', exact: '/api/lineage/start-fresh', h: handleWorkspaceStartFresh },
      { m: 'GET', exact: '/api/lineage', h: serveWorkspaceLineage }
    ]
  };
}

module.exports = { makeLineageRoutes };
