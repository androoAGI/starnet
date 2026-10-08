/* test/userprops-catalog.test.js — player-made props, page side, headless:
   - PropSprites.registerUserProp adds a DECORATION row (cosmetic, category 'yours', its own footprint) that the
     catalog, spec, footprintAt and search all see; a bad id is refused; registering twice is a no-op.
   - THE SAVE NEVER LOSES A MADE PROP: with the app's real rule injection (PropSprites.ruleFor) a user_ prop
     survives deserialize even when its row is NOT registered yet (boot race / missing PNG), while a retired
     built-in type is still pruned exactly as before.
   - an unregistered made prop draws a placeholder box instead of nothing (no invisible obstacle). */
'use strict';
const A = require('./_assert.js');
const PropSprites = require('../frontend/app/propsprites.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const PropSearch = require('../frontend/app/propsearch.js');

const before = PropSprites.CATALOG.length;
A.eq(PropSprites.registerUserProp({ id: '../evil' }), null, 'a non user_ id is refused');
A.eq(PropSprites.registerUserProp({ id: 'user_x' }), null, 'a too-short user_ id is refused');
const row = PropSprites.registerUserProp({ id: 'user_grandfather_clock_a1b2c3', label: 'grandfather clock', noun: 'a grandfather clock', footprint: { w: 1, h: 1 } });
A.ok(row && row.user, 'registers a made prop');
A.eq([row.tier, row.cat, row.w, row.h, row.label], ['cosmetic', 'yours', 1, 1, 'GRANDFATHER CLOCK'], 'decoration row with its own footprint and an uppercased label');
A.eq(PropSprites.CATALOG.length, before + 1, 'the catalog grows by one');
A.ok(PropSprites.CATALOG.some((c) => c && c.id === row.id), 'the catalog getter includes it');
A.eq(PropSprites.registerUserProp({ id: row.id, label: 'dupe' }).label, 'GRANDFATHER CLOCK', 'registering twice keeps the first row');
A.eq(PropSprites.CATALOG.length, before + 1, 'and does not duplicate it');
A.eq(PropSprites.footprintAt(row.id, 0), { w: 1, h: 1 }, 'footprintAt resolves it');
A.eq(PropSprites.CAT_LABEL.yours, 'MADE BY YOU', 'the category has a player-facing label');
A.ok((PropSprites.CATS.yours || []).some((c) => c.id === row.id), 'CATS.yours lists it');
A.eq(PropSprites.canRotate ? PropSprites.canRotate(row.id) : false, false, 'a made prop offers no rotation it cannot draw');
const hits = PropSearch.matchProps(PropSprites.CATALOG, 'grandfather', { catLabel: PropSprites.CAT_LABEL, tierLabel: PropSprites.TIER_LABEL });
A.ok((Array.isArray(hits) ? hits : (hits && hits.items) || []).some((c) => (c.id || (c.c && c.c.id)) === row.id) || JSON.stringify(hits).includes(row.id), 'search finds a made prop by its name');

// ---- the save never loses a made prop
A.eq(PropSprites.ruleFor('user_not_loaded_yet_ffffff'), { mount: null, stack: false, surface: false, flat: false }, 'an unregistered made prop still has placement rules');
A.eq(PropSprites.ruleFor('long_retired_prop_type'), null, 'a retired built-in type has none');
WorldModel.setPropRules((t) => PropSprites.ruleFor(t));
const doc = WorldModel.starterDoc();
const room = doc.rooms[doc.order[0]], r0 = room.rects[0];
const at = (i) => ({ x: r0.x1 + 1 + i * 2, y: r0.y1 + 2 });
doc.props = (doc.props || []).concat([
  { id: 'p-made-reg', t: row.id, ...at(0), w: 1, h: 1 },
  { id: 'p-made-unreg', t: 'user_not_loaded_yet_ffffff', ...at(1), w: 2, h: 1 },
  { id: 'p-retired', t: 'long_retired_prop_type', ...at(2), w: 1, h: 1 }
]);
const st = WorldModel.deserialize(JSON.parse(JSON.stringify(doc)));
const kept = st.props().map((p) => p.id);
A.ok(kept.includes('p-made-reg'), 'a registered made prop survives load');
A.ok(kept.includes('p-made-unreg'), 'an UNREGISTERED made prop survives load (paid work is never pruned)');
A.eq(st.props().find((p) => p.id === 'p-made-unreg').w, 2, 'and keeps its saved footprint');
A.ok(!kept.includes('p-retired'), 'a retired built-in type is still pruned');
const round = WorldModel.deserialize(JSON.parse(JSON.stringify(st.serialize ? st.serialize() : st.doc())));
A.ok(round.props().some((p) => p.id === 'p-made-unreg'), 'and survives a second save/load round trip');

// ---- placeholder instead of an invisible obstacle
const ops = [];
const fakeCtx = new Proxy({}, { get: (_, k) => (k === 'setLineDash' || k === 'save' || k === 'restore' || k === 'fillRect' || k === 'strokeRect') ? (...a) => ops.push(k) : undefined, set: () => true });
PropSprites.setCtx(fakeCtx);
PropSprites.draw({ t: 'user_not_loaded_yet_ffffff', x: 2, y: 2, w: 2, h: 1 }, false, {});
A.ok(ops.includes('fillRect') && ops.includes('strokeRect'), 'an unregistered made prop draws a placeholder box');
ops.length = 0;
PropSprites.draw({ t: row.id, x: 2, y: 2, w: 1, h: 1 }, false, {});
A.ok(ops.includes('fillRect'), 'a registered made prop without decoded art (headless) also falls back to the placeholder');
ops.length = 0;
PropSprites.draw({ t: 'long_retired_prop_type', x: 2, y: 2, w: 1, h: 1 }, false, {});
A.eq(ops.length, 0, 'unknown built-in types still draw nothing (unchanged behavior)');

// ---- side views: R turns a made prop only once it has a real side picture
A.eq(PropSprites.canRotate(row.id), false, 'no side view yet: R offers nothing');
A.eq(PropSprites.registerUserSide('user_not_registered_000000', { footprint: { w: 2, h: 1 } }), false, 'a side for an unregistered prop is refused');
A.eq(PropSprites.registerUserSide(row.id, { footprint: { w: 2, h: 1 } }), true, 'registers the side view');
A.eq(PropSprites.canRotate(row.id), true, 'now R turns it');
A.eq(PropSprites.facings(row.id), [0, 1, 3], 'south, west (the made side) and east (its mirror) — never a back view it does not have');
A.eq(PropSprites.footprintAt(row.id, 1), { w: 2, h: 1 }, 'the west facing uses the side view footprint');
A.eq(PropSprites.footprintAt(row.id, 3), { w: 2, h: 1 }, 'and so does the mirrored east facing');
A.eq(PropSprites.footprintAt(row.id, 0), { w: 1, h: 1 }, 'south keeps the front footprint');
ops.length = 0;
PropSprites.draw({ t: row.id, x: 2, y: 2, w: 2, h: 1, r: 1 }, false, {});
A.ok(ops.includes('fillRect'), 'a turned made prop without decoded side art draws the placeholder, not nothing');

// ---- delete: the row leaves the catalog and saves drop the deleted id like a retired type
A.eq(PropSprites.unregisterUserProp('chair'), false, 'a built-in prop can never be unregistered');
const n0 = PropSprites.CATALOG.length;
A.eq(PropSprites.unregisterUserProp(row.id), true, 'a made prop is unregistered');
A.eq(PropSprites.CATALOG.length, n0 - 1, 'the catalog shrinks by one');
A.eq(PropSprites.spec(row.id), null, 'spec no longer knows it');
A.eq(PropSprites.ruleFor(row.id), null, 'a deleted made prop is pruned from saves');
PropSprites.markUserDeleted(['user_old_deleted_aaaaaa']);
A.eq(PropSprites.ruleFor('user_old_deleted_aaaaaa'), null, 'a tombstoned id from the station is pruned too');
A.eq(PropSprites.ruleFor('user_still_protected_bbbbbb'), { mount: null, stack: false, surface: false, flat: false }, 'other unregistered made props stay protected');

// ---- SIZE: pure geometry, row resize, and a copy saved at another size draws SCALED into its own box
global.window = undefined;
const UP = require('../frontend/app/userprops.js');
const base = { footprint: { w: 2, h: 1 }, bounds: { x: -2, y: -10, width: 28, height: 22 }, side: { footprint: { w: 1, h: 2 }, bounds: { x: -2, y: 2, width: 16, height: 22 } } };
const g2 = UP.geometry(base, 2);
A.eq([g2.front.footprint, g2.front.bounds.height, g2.side.footprint], [{ w: 4, h: 2 }, 44, { w: 2, h: 4 }], 'size 200% doubles footprint and height (front and side)');
A.eq(UP.geometry(base, 0.5).front.bounds.height, 14, 'size 50% never drops below the 14px minimum');
A.eq(UP.geometry({ ...base, bounds: { ...base.bounds, height: 100 } }, 3).front.bounds.height, 192, 'the renderer ceiling (192px) holds');
A.eq(UP.geometry(base, 1.7).scale, 1, 'an off-step size falls back to 100%');
A.eq(UP.geometry({ ...base, scale: 1.5 }).scale, 1.5, 'the stored size is used by default');
const big = PropSprites.registerUserProp({ id: 'user_big_statue_c0ffee', label: 'big statue', footprint: { w: 2, h: 2 } });
A.eq(PropSprites.resizeUserProp(big.id, { w: 4, h: 4 }, null), true, 'a made prop row resizes');
A.eq(PropSprites.footprintAt(big.id, 0), { w: 4, h: 4 }, 'and footprintAt follows');
A.eq(PropSprites.resizeUserProp('chair', { w: 9, h: 9 }), false, 'a built-in prop can never be resized this way');
const calls = [];
const scaleCtx = new Proxy({}, { get: (_, k2) => ['save', 'restore', 'translate', 'scale', 'fillRect', 'strokeRect', 'setLineDash'].includes(k2) ? (...args) => calls.push([k2, ...args]) : undefined, set: () => true });
PropSprites.setCtx(scaleCtx);
const hadPR = global.PropRemaster; global.PropRemaster = { draw: () => true };   // stub renderer: exercise the scaled path
PropSprites.draw({ t: big.id, x: 1, y: 1, w: 2, h: 2 }, false, {});
global.PropRemaster = hadPR;
A.ok(calls.some((c) => c[0] === 'scale' && Math.abs(c[1] - 0.5) < 1e-9 && Math.abs(c[2] - 0.5) < 1e-9), 'a copy saved at the old 2x2 size is drawn scaled 0.5 into its own box');

// ---- the credits door (conversion): shown up front, wired to a module that exists, never offered when unlinkable
{
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', 'build.js'), 'utf8');
  const fe = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
  A.ok(/root\.Friendly = api/.test(fe) && !/root\.FriendlyError\b/.test(fe), 'the friendly-error module is the global Friendly');
  A.ok(!/FriendlyError/.test(src), 'build.js never reaches for a FriendlyError global (the door silently did nothing)');
  A.ok(/Friendly\.actionButton\(\{ action: 'store' \}\)/.test(src), 'the credits door opens PROVIDERS through Friendly.actionButton');
  A.ok(/\/api\/credits\/linkable/.test(src) && /makeCredits\.linkable \? 'link' : ''/.test(src), 'GET STARNET CREDITS shows only when this build can link an account');
  A.ok(/id="refit-makeprop-cta" hidden/.test(src), 'the card starts hidden: nothing is claimed before /api/credits answers');
  // (2026-10-07) a FAILED balance check (configured:true, balanceUsd:null) is unknown, never a $0 that says
  // "You're out of StarNet credits" to a funded user
  A.ok(/makeCredits = \{ linked: j\.configured, balanceUsd: typeof j\.balanceUsd === 'number' && isFinite\(j\.balanceUsd\) \? j\.balanceUsd : null \}/.test(src),
    'the BUILD MODE credit read keeps a non-number balance unknown (null), not 0');
  const needSrc = (src.match(/const need = (!makeCredits \? [^;]+);/) || [])[1];
  A.ok(!!needSrc, 'the make-a-prop card decision is found in build.js');
  const need = new Function('makeCredits', 'return ' + needSrc);
  A.eq(need({ linked: true, balanceUsd: null }), '', 'an unknown balance shows no TOP UP card');
  A.eq(need({ linked: true, balanceUsd: 0 }), 'topup', 'a reported $0 balance offers TOP UP');
  A.eq(need({ linked: true, balanceUsd: 1.2 }), '', 'a funded balance shows no card');
  A.eq(need({ linked: false, linkable: true, balanceUsd: 0 }), 'link', 'unlinked + linkable offers the link door');
  A.eq(need({ linked: false, linkable: false, balanceUsd: 0 }), '', 'unlinked + not linkable offers nothing');
  A.eq(need(null), '', 'before /api/credits answers nothing is claimed');
}

// (sweep 2026-10-02) a FRESH load never reuses one already in flight: station.make_prop's reload got the list from before
// the prop finished and said it was not on the page
(async () => {
  const lists = [[], [{ id: 'user_new_lamp_abc123', label: 'new lamp' }]];
  let n = 0, release = null;
  const hadFetch = global.fetch; const hadPS = global.PropSprites; global.PropSprites = PropSprites;
  global.fetch = async () => {
    const mine = lists[Math.min(n++, lists.length - 1)];
    if (n === 1) await new Promise(r => { release = r; });   // the first load is slow (started before the prop landed)
    return { ok: true, json: async () => ({ props: mine, jobs: [], recent: [], deleted: [] }) };
  };
  const stale = UP.load();
  const fresh = UP.load({ fresh: true });
  await new Promise(r => setImmediate(r)); release();
  const [a, b] = await Promise.all([stale, fresh]);
  A.eq([a.props.length, b.props.map(p => p.id)], [0, ['user_new_lamp_abc123']], 'a fresh load waits for the one in flight, then asks again (and sees the new prop)');
  const sc = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'stationcommands.js'), 'utf8');
  A.ok(/'station\.props_reload': async \(\) => \{[\s\S]{0,200}UserProps\.load\(\{ fresh: true \}\)/.test(sc), 'station.props_reload asks for a fresh load');
  global.fetch = hadFetch; global.PropSprites = hadPS;
  A.report();
})();
