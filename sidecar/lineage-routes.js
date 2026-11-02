/* sidecar/lineage-routes.js — the lineage route group: what the recovery gate reads, and its two lifecycle requests.

   Routes (all behind the central /api auth gate; nothing here is reachable without the station token):
     GET  /api/lineage              the boot's bounded lineage evidence, its paths redacted for the page
     GET  /api/lineage/report       the redacted recovery report, as a download
     POST /api/lineage/recover      {candidateId}   the Commander's chosen station, activated at the next boot
     POST /api/lineage/start-fresh  START FRESH, the gate's third exit

   publicLineage() is the same redacted view GET /api/save carries. index.js builds this group once, at boot, from the
   lineage it captured before any store opened. test/workspace-lineage.http.test.js and
   test/workspace-recovery-fresh-start.http.test.js drive every route here through the real sidecar. */
'use strict';

function makeLineageRoutes(deps) {
  const { fs, path, platform, arch, homedir, workspaceRoot, candidateRoots, lineage, inspection, recovery, stationView, startFresh,
    desktopShell, readBody, now, restart, log } = deps;

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
      const result = recovery.requestRecovery({
        fs, path, platform, home: homedir(), workspaceRoot,
        candidateRoots,
        inspection, candidateId: String(body.candidateId || ''), now
      });
      json(202, Object.assign({}, result, { desktopWillRestart: desktopShell }));
      // Exit only after the authenticated response is flushed. The desktop guardian respawns automatically;
      // a manual sidecar is explicitly told by the UI to restart it. The next boot applies before store open.
      setTimeout(() => restart(), 150);
    } catch (error) {
      json(409, { ok: false, error: String(error && error.message || error) });
    }
  }

  /* START FRESH (the gate's third exit). The Commander has explicitly chosen a new station over prior-install
     evidence nothing could recover. Current-workspace state is MOVED to a sibling quarantine folder (never
     deleted), external evidence roots are acknowledged by marker, then the sidecar exits exactly like a
     recovery request so the desktop guardian respawns it into clean onboarding. Refused while a verified
     recovery is pending — that path wins. */
  async function handleWorkspaceStartFresh(req, res) {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      const result = startFresh({
        fs, path, platform, workspaceRoot,
        candidateRoots, now
      });
      if (!result.ok) return json(409, { ok: false, error: result.error, moved: result.moved, quarantine: result.quarantine });
      log('[lineage] START FRESH: moved ' + result.moved.length + ' file(s) to ' + (result.quarantine || '(nothing to quarantine)') + '; acknowledged ' + result.acknowledgedRoots.length + ' external root(s)');
      json(202, Object.assign({}, result, { desktopWillRestart: desktopShell }));
      setTimeout(() => restart(), 150);
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
