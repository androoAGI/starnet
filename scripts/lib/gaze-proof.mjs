// Test-only instrumentation: compare movement immediately around the real gaze
// call. An occupied waypoint alone does not establish the cause of movement.
export function instrumentGaze(source) {
  const signature = 'function glanceAt(self_, otherBody, dur, now) {';
  if (source.split(signature).length !== 2) throw new Error('gaze proof requires exactly one known glanceAt seam');
  return source.replace(signature, `
  const gazeProof = { calls: 0, forced: 0, violations: [] };
  const gazeMovement = () => JSON.stringify(allBodies().map(b => ({
    id:b.id, px:b.px, py:b.py, target:b.target, path:b.pathPts,
    pathIdx:b.pathIdx, goal:b.goal, state:b.state
  })));
  function glanceAt(self_, otherBody, dur, now) {
    const before = gazeMovement();
    try { return originalGlanceAt(self_, otherBody, dur, now); }
    finally {
      gazeProof.calls++;
      if (before !== gazeMovement()) gazeProof.violations.push({ observer:self_?.id, other:otherBody?.id });
    }
  }
  window.__STARNET_GAZE_PROOF__ = {
    read: () => JSON.parse(JSON.stringify(gazeProof)),
    exercise: () => {
      const list = allBodies().filter(b => !b.unplaced);
      for (const a of list) for (const b of list) if (a !== b) {
        glanceAt(a, b, 800, performance.now()); gazeProof.forced++;
      }
      return JSON.parse(JSON.stringify(gazeProof));
    }
  };
  function originalGlanceAt(self_, otherBody, dur, now) {`);
}

export async function installGazeProof(cdp, source) {
  const body = Buffer.from(instrumentGaze(source)).toString('base64');
  const errors = [];
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/app/world.js*', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', p => {
    cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body
    }).catch(e => errors.push(e.message));
  });
  return errors;
}
