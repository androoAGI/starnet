/* test/build-proptile-pressed-state.test.js — A PROP PICK LIGHTS EXACTLY THE PICKED TILE (2026-11-10).

   Found live in Build Mode's prop library: after picking a prop, unrelated tiles could show as chosen, and assistive tech
   read aria-pressed="undefined". The tile onclick refreshed every .refit-proptile with
       const active = tile.dataset.prop === propType || (tile.dataset.coreAbility && tile.dataset.coreAbility === cap);
   and for a tile that does not match AND has no data-core-ability, `false || undefined` is `undefined`.
   classList.toggle('active', undefined) is not "off" — the DOM spec treats an undefined force as a plain toggle, so the
   class FLIPPED on every pick — and String(undefined) wrote aria-pressed="undefined".

   Locked here: the refresh block is run as written against tiles that obey the real DOM semantics (toggle with an
   undefined force flips; setAttribute stringifies) over several picks in a row. After every pick, exactly the picked tile
   (plus a tile sharing its core ability) has .active and aria-pressed="true"; every other tile has no .active and
   aria-pressed="false"; and no tile ever carries aria-pressed="undefined". */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const build = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'build.js'), 'utf8');

/* ---------- the block under test: the grid-only refresh inside propTile's onclick ---------- */
const open = "root.querySelectorAll('.refit-proptile').forEach(tile => {";
const i = build.indexOf(open);
A.ok(i >= 0, 'found the prop tile refresh block');
A.eq(build.split(open).length - 1, 1, 'there is exactly one prop tile refresh block');
const j = build.indexOf('\n      });', i);
A.ok(j > i, 'found the end of the refresh block');
const block = build.slice(i, j + '\n      });'.length);

/* ---------- a tile that behaves like a DOM element where it matters ---------- */
function makeTile(prop, coreAbility) {
  const classes = new Set(['refit-proptile']), attrs = {};
  return {
    dataset: coreAbility ? { prop, coreAbility } : { prop },
    attrs,
    classes,
    classList: {
      // DOM spec: toggle(name, force) — an undefined force is NOT "off", it is a plain toggle.
      toggle(name, force) {
        const want = force === undefined ? !classes.has(name) : Boolean(force);
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
      contains: n => classes.has(n)
    },
    setAttribute(k, v) { attrs[k] = String(v); }
  };
}

// Two core-ability cards (two props can share one ability), plus plain tiles that have no data-core-ability.
const CAP = { desk: 'computer', pc2: 'computer', shelf: 'storage', plant: 'decor', rug: 'decor', lamp: 'light', sofa: 'seat' };
const tiles = [
  makeTile('desk', 'computer'), makeTile('shelf', 'storage'),           // core cards
  makeTile('desk'), makeTile('pc2'), makeTile('shelf'), makeTile('plant'), makeTile('rug'), makeTile('lamp'), makeTile('sofa')   // plain tiles
];

const ctx = {
  propType: null,
  root: { querySelectorAll: sel => (sel === '.refit-proptile' ? tiles : []) },
  WorldModel: { capForProp: t => CAP[t] }
};
vm.createContext(ctx);

function pick(id) { ctx.propType = id; vm.runInContext(block, ctx); }
const expectLit = (t, id) => t.dataset.prop === id || (!!t.dataset.coreAbility && t.dataset.coreAbility === CAP[id]);

/* ---------- several picks in a row, including repeats and a pick that shares a core ability ---------- */
const picks = ['plant', 'rug', 'rug', 'desk', 'pc2', 'sofa', 'plant'];
picks.forEach((id, n) => {
  pick(id);
  const where = 'after pick ' + (n + 1) + ' (' + id + ')';
  tiles.forEach((t, k) => {
    const want = expectLit(t, id), label = 'tile ' + k + ' [' + t.dataset.prop + (t.dataset.coreAbility ? ' core:' + t.dataset.coreAbility : '') + '] ' + where;
    A.eq(t.classes.has('active'), want, label + ': .active');
    A.eq(t.attrs['aria-pressed'], want ? 'true' : 'false', label + ': aria-pressed');
  });
  A.ok(tiles.every(t => t.attrs['aria-pressed'] === 'true' || t.attrs['aria-pressed'] === 'false'), 'every aria-pressed is a real boolean string ' + where);
  A.ok(!tiles.some(t => t.attrs['aria-pressed'] === 'undefined'), 'no tile carries aria-pressed="undefined" ' + where);
});

/* ---------- the sequence ends on a known state: only the last pick (and nothing that merely shares no ability) is lit ---------- */
A.eq(tiles.filter(t => t.classes.has('active')).map(t => t.dataset.prop), ['plant'], 'the last pick is the only tile left lit');

A.report('build-proptile-pressed-state.test');
