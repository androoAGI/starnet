/* Pure, disposable room construction. Never reads or writes a saved station. */
'use strict';
const PropCatalogFixture = (() => {
  const PAGE_SIZE = 6;
  function select(data, filters = {}) {
    const q = String(filters.search || '').trim().toLowerCase();
    return data.views.filter(v => (!filters.category || v.category === filters.category) &&
      (!filters.facing || v.face === filters.facing) &&
      (!filters.mount || v.placement === filters.mount) &&
      (!q || (v.id + ' ' + v.label).toLowerCase().includes(q)));
  }
  function page(data, filters = {}) {
    const matching = select(data, filters), pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
    const index = Math.max(0, Math.min(pages - 1, Number(filters.page) | 0));
    return { matching, pages, index, entries: matching.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE) };
  }
  function create(entries, P, M) {
    M.setPropRules(id => P.spec(id));
    const doc = M.defaultDoc(), roomId = doc.order[0], props = [], subjects = [], supports = [];
    const native = (id, r = 0) => {
      if (!P.facings(id).includes(r)) throw Error('Unsupported facing: ' + id + ':' + r);
      const f = P.footprintAt(id, r);
      if (!f) throw Error('Missing native footprint: ' + id);
      return f;
    };
    const add = (id, x, y, r, key) => {
      const f = native(id, r), p = { id: key, t: id, x, y, w: f.w, h: f.h, r };
      props.push(p); return p;
    };
    const wall = entries.filter(v => v.placement === 'wall'), floor = entries.filter(v => v.placement !== 'wall');
    const stride = Math.max(9, ...floor.map(v => Math.max(v.footprint.w, v.placement === 'surface' ? 3 : 0) + 4));
    let width = Math.max(30, Math.min(3, Math.max(1, floor.length)) * stride + 4), wallX = 2;
    for (const v of wall) {
      const p = add(v.id, wallX, 0, v.r, 'catalog-' + v.key); subjects.push({ entry: v, prop: p });
      wallX += p.w + 3;
    }
    width = Math.max(width, wallX + 2);
    // Reserve the wall furniture's floor depth before placing free-standing pieces.
    let y = Math.max(4, ...wall.map(v => v.footprint.h + 3));
    for (let start = 0; start < floor.length; start += 3) {
      const row = floor.slice(start, start + 3);
      y += Math.max(0, ...row.map(v => Math.ceil(Math.max(0, -v.bounds.y) / 12)));
      row.forEach((v, col) => {
        let x = 2 + col * stride;
        if (v.placement === 'surface') {
          const f = native('longtable');
          if (v.footprint.w > f.w || v.footprint.h > f.h) throw Error('No containing table for ' + v.key);
          const host = add('longtable', x, y, 0, 'support-' + v.key);
          supports.push(host); x += Math.floor((host.w - v.footprint.w) / 2);
        }
        subjects.push({ entry: v, prop: add(v.id, x, y, v.r, 'catalog-' + v.key) });
      });
      y += Math.max(1, ...row.map(v => v.footprint.h)) + 4;
    }
    // One furnished comparison corner in every room. These are context, never counted as subjects.
    const anchorY = y + 1;
    const anchors = [add('desk', 3, anchorY, 0, 'anchor-desk'), add('chair', 4, anchorY + 2, 0, 'anchor-chair'), add('crate', 12, anchorY, 0, 'anchor-crate')];
    doc.rooms = { [roomId]: { ...doc.rooms[roomId], name: 'CATALOG REVIEW', rects: [{ x1: 0, y1: 0, x2: width, y2: anchorY + 5 }] } };
    doc.order = [roomId]; doc.props = props; doc.belts = {}; doc._nid = 10000;
    const station = M.deserialize(doc);
    // Validate placement order: tables precede their children. Checking a table
    // against its already-mounted child would instead test moving it out from under the child.
    const violations = props.map((p, index) => {
      const before = M.deserialize({ ...doc, props: props.slice(0, index) });
      return { id: p.id, ...before.canPlaceProp(p.t, p.x, p.y, p.w, p.h) };
    }).filter(v => !v.ok);
    return { doc, station, subjects, supports, anchors, violations,
      crew: { x: 9, y: anchorY + 2 }, anchorY, roomId };
  }
  return Object.freeze({ PAGE_SIZE, select, page, create });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PropCatalogFixture;
