/* AGENT OS — waitanchor.js : where a permission-blocked agent WALKS TO and WAITS (G4 embodiment, feature 1).

   When a run blocks on a `permission.prompt`, the acting agent's body stops working, stands, and walks to a
   waiting anchor where it visibly waits until the Commander approves or denies. This module is the PURE
   decision for WHICH tile that anchor is — resolved HONESTLY from the live floor, never a hardcoded coordinate.

   THE ANCHOR LADDER (fixed order; the first that resolves a reachable approach tile wins):
     1. AIRLOCK  — a door-like isolation prop; the most legible "I'm waiting at the threshold" body. If the
                   catalog/bake has one placed, wait beside it.
     2. MISSION BOARD — the "needs you" surface; if no airlock, wait beside the board.
     3. OWN DESK — the honest fallback: the agent stands at its own workstation seat, facing the camera (south).

   ZONE CONTAINMENT (the workforce-zones law): if the chosen anchor's approach tile is OUTSIDE the agent's
   zone, the agent waits at the in-zone tile NEAREST the anchor (never walks out of its area). The caller
   supplies a `zoneAllows(tx,ty)` predicate + a `nearestInZone(tile)` resolver so this stays pure (no Zones dep).

   PURE + node-testable, mirroring propanchor.js: a `WaitAnchor` global in the browser, module.exports under
   node. NO DOM, NO time, NO RNG — the anchor is a deterministic function of the floor + the agent's seat + zone.
   deriveAnchor(prop,...) is reused via the injected `anchorOf` dep so the two modules share one approach-tile law. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.WaitAnchor = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // the door-like anchors we prefer, in priority order. 'airlock' is the current door prop; the list is kept
  // small + data-driven so a future door type only needs adding here (never a hardcoded per-map coordinate).
  const DOOR_TYPES = ['airlock'];
  const BOARD_TYPE = 'missionboard';

  function firstPropOf(props, type) {
    if (!Array.isArray(props)) return null;
    for (const p of props) if (p && p.t === type) return p;
    return null;
  }

  /* resolve(ctx) -> { tx, ty, face, source } | null
       ctx.props      : geo.props (placed prop rects, each { t, x, y, w, h })
       ctx.anchorOf   : (prop) -> { tx, ty, face } | null   — an approach tile beside the prop (PropAnchor.deriveAnchor)
       ctx.seat       : { tx, ty, face } | null             — the agent's own workstation seat (the honest fallback)
       ctx.zoneAllows : (tx, ty) -> bool                    — is this tile inside the agent's zone? (default: always yes)
       ctx.nearestInZone : (tile) -> { tx, ty } | null      — the nearest in-zone tile to `tile` when the anchor is out of zone

     Returns the anchor tile to walk to + a `source` tag ('airlock' | 'missionboard' | 'desk'), or null when the
     floor gives us nothing to stand at (a walled-in board with no seat). The caller PATHS to {tx,ty}; if the path
     itself fails it falls back to standing in place — this module only chooses the honest target. */
  function resolve(ctx) {
    ctx = ctx || {};
    const props = ctx.props || [];
    const anchorOf = typeof ctx.anchorOf === 'function' ? ctx.anchorOf : () => null;
    const zoneAllows = typeof ctx.zoneAllows === 'function' ? ctx.zoneAllows : () => true;
    const nearestInZone = typeof ctx.nearestInZone === 'function' ? ctx.nearestInZone : () => null;

    // clamp a resolved anchor tile into the agent's zone: in-zone → keep it; out-of-zone → nearest in-zone tile
    // (wait at the zone edge nearest the anchor); no in-zone tile at all → this candidate is unusable.
    function clampToZone(a, source) {
      if (!a) return null;
      if (zoneAllows(a.tx, a.ty)) return { tx: a.tx, ty: a.ty, face: a.face || 'south', source };
      const nz = nearestInZone({ tx: a.tx, ty: a.ty });
      if (nz && zoneAllows(nz.tx, nz.ty)) return { tx: nz.tx, ty: nz.ty, face: a.face || 'south', source };
      return null;   // anchor is out of zone and nothing in-zone is near it — fall through to the next candidate
    }

    // 1 + 2: a door-like prop, then the mission board — each via the shared approach-tile law.
    for (const type of DOOR_TYPES) {
      const prop = firstPropOf(props, type);
      const got = prop ? clampToZone(anchorOf(prop), 'airlock') : null;
      if (got) return got;
    }
    const board = firstPropOf(props, BOARD_TYPE);
    const atBoard = board ? clampToZone(anchorOf(board), 'missionboard') : null;
    if (atBoard) return atBoard;

    // 3: the honest fallback — stand at the agent's own seat, facing the camera (south) so "waiting for you" reads.
    if (ctx.seat && Number.isFinite(ctx.seat.tx) && Number.isFinite(ctx.seat.ty)) {
      const s = clampToZone({ tx: ctx.seat.tx, ty: ctx.seat.ty, face: 'south' }, 'desk');
      if (s) { s.face = 'south'; return s; }
    }
    return null;
  }

  return { resolve, DOOR_TYPES, BOARD_TYPE, _firstPropOf: firstPropOf };
});
