/* Also safe to load from index.html: ?propCatalogRoom opens this isolated fixture. */
'use strict';
(async () => {
  const query = new URLSearchParams(location.search), cv = document.getElementById('prop-catalog-fixture');
  if (!cv) {
    if (query.has('propCatalogRoom')) {
      const url = new URL('prop-catalog-review.html', location.href);
      url.search = location.search; url.searchParams.set('propSet', 'projection');
      location.replace(url);
    }
    return;
  }
  const $ = id => document.getElementById(id), data = PropCatalogData, F = PropCatalogFixture;
  const ctx = cv.getContext('2d'), visited = new Set();
  const filters = { category: query.get('category') || '', search: query.get('q') || '', facing: query.get('facing') || '', mount: query.get('mount') || '', page: Number(query.get('page')) || 0 };
  let powered = false, moving = false, outlines = false, scale = 2, room = null, frame = 0, selected = null;
  await Promise.all([IndustrialTextures.ready, PropRemaster.ready]);
  await SPRITES.init(); await SPRITES.ensureSkin('station_minion');
  for (const c of data.categories) {
    const option = document.createElement('option'), entries = data.views.filter(v => v.category === c.id);
    option.value = c.id; option.textContent = c.label + ' · ' + new Set(entries.map(v => v.id)).size + ' types';
    $('category').append(option);
  }
  for (const id of ['category', 'facing', 'mount']) {
    $(id).value = filters[id];
    $(id).addEventListener('change', () => { filters[id] = $(id).value; filters.page = 0; rebuild(); });
  }
  $('search').value = filters.search;
  $('search').addEventListener('input', () => { filters.search = $('search').value; filters.page = 0; rebuild(); });
  $('previous').onclick = () => { filters.page--; rebuild(); };
  $('next').onclick = () => { filters.page++; rebuild(); };
  $('power').onclick = () => { powered = !powered; $('power').textContent = 'Fixture state: ' + (powered ? 'powered (preview)' : 'idle'); $('power').setAttribute('aria-pressed', powered); paint(); };
  $('motion').onclick = () => { moving = !moving; $('motion').textContent = 'Motion: ' + (moving ? 'fixture preview' : 'frozen'); $('motion').setAttribute('aria-pressed', moving); cancelAnimationFrame(frame); paint(); };
  $('outlines').onclick = () => { outlines = !outlines; $('outlines').setAttribute('aria-pressed', outlines); $('outlines').textContent = outlines ? 'Hide footprints' : 'Show footprints'; paint(); };
  $('scale').onchange = () => { scale = Number($('scale').value); resize(); paint(); };
  function syncURL() {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ category: filters.category, q: filters.search, facing: filters.facing, mount: filters.mount, page: filters.page })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
  }
  function resize() {
    if (!room) return;
    cv.width = Math.ceil(room.geo.W * scale); cv.height = Math.ceil(room.geo.H * scale);
    cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
  }
  function rebuild() {
    cancelAnimationFrame(frame); selected = F.page(data, filters); filters.page = selected.index; syncURL();
    const fixture = F.create(selected.entries, PropSprites, WorldModel), geo = fixture.station.projectGeometry();
    const rendered = geo.props.map(p => ({ ...p, mount: fixture.station.mountOf(p) }));
    PropSprites.setSurfaceLayout(rendered);
    room = { ...fixture, geo, rendered, bake: StationBake.bake(geo) }; resize();
    $('page').textContent = 'Room ' + (selected.index + 1) + ' / ' + selected.pages;
    $('previous').disabled = selected.index === 0; $('next').disabled = selected.index + 1 >= selected.pages;
    $('entries').replaceChildren();
    selected.entries.forEach((v, index) => {
      const article = document.createElement('article'), title = document.createElement('strong'), detail = document.createElement('p');
      title.textContent = (index + 1) + '. ' + v.label + ' / ' + v.face.toUpperCase();
      detail.textContent = v.id + ' · ' + v.footprint.w + '×' + v.footprint.h + ' tiles · ' + v.placement +
        (v.optionalStack ? ' (optional table placement)' : '') + (v.nativeMirror ? ' · native mirrored side' : '') + (v.nativeTurn ? ' · native decal turn' : '');
      article.append(title, detail); $('entries').append(article);
    });
    paint();
  }
  function paint() {
    cancelAnimationFrame(frame);
    if (!room) return;
    const { geo, bake, rendered } = room, now = moving ? performance.now() : 0;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, geo.W, geo.H); ctx.drawImage(bake.baseCv, 0, 0);
    PropSprites.setCtx(ctx); PropSprites.setNow(now); PropSprites.setSurfaceLayout(rendered);
    for (const p of rendered) PropSprites.drawShadow(p, p.mount);
    const order = p => PropSprites.surfacePlacement(p)?.sortY ?? (p.y + p.h) * 12;
    const crew = { id: 'catalog-scale-crew', skin: 'station_minion', px: (room.crew.x - geo.origin.tx) * 12, py: (room.crew.y - geo.origin.ty) * 12, state: 'idle', dir: 'south' };
    const items = rendered.map(p => ({ y: order(p), draw: () => PropSprites.draw(p, powered, { still: !moving, occupied: powered }) }));
    items.push({ y: crew.py, draw: () => SPRITES.drawBody(ctx, crew, now, { reducedMotion: !moving }) });
    items.sort((a, b) => a.y - b.y).forEach(item => item.draw()); ctx.drawImage(bake.lightCv, 0, 0);
    if (outlines) {
      ctx.save(); ctx.strokeStyle = '#78c6c1'; ctx.lineWidth = .6; ctx.setLineDash([2, 2]);
      for (const p of rendered) ctx.strokeRect(p.x * 12, p.y * 12, p.w * 12, p.h * 12);
      ctx.restore();
    }
    ctx.save(); ctx.font = '4px monospace'; ctx.fillStyle = '#dbd1ad';
    room.subjects.forEach((s, i) => {
      const p = rendered.find(p => p.id === s.prop.id);
      if (p) ctx.fillText(String(selected.entries.indexOf(s.entry) + 1), p.x * 12, (p.y + p.h) * 12 + 6);
    });
    ctx.fillText('WORKSTATION + CHAIR     CREW     CRATE / SCALE REFERENCES', (3 - geo.origin.tx) * 12, (room.anchorY + 4 - geo.origin.ty) * 12); ctx.restore();
    const status = PropRemaster.status(), loaded = new Set(status.views), mounts = rendered.filter(p => p.mount === 'surface').map(p => ({ id: p.id, ...PropSprites.surfacePlacement(p) }));
    const missing = selected.entries.filter(v => !loaded.has(v.id + ':' + v.artFace));
    const runtimeDrift = selected.entries.filter(v => !PropSprites.facings(v.id).includes(v.r) || JSON.stringify(PropSprites.footprintAt(v.id, v.r)) !== JSON.stringify(v.footprint));
    if (!room.violations.length && !missing.length && !runtimeDrift.length) selected.entries.forEach(v => visited.add(v.key));
    const present = data.views.filter(v => loaded.has(v.id + ':' + v.artFace));
    $('coverage').textContent = 'Catalog: ' + data.catalogTypes + ' types / ' + data.supportedViews + ' native directions. Available art: ' + present.length + '/' + data.supportedViews +
      '. Loader failures: ' + status.failures.length + '. Rendered this visit: ' + visited.size + ' directions / ' + new Set([...visited].map(k => k.split(':')[0])).size + ' types. Filter: ' + selected.matching.length + ' directions.';
    const failures = mounts.filter(m => !m.authored);
    $('report').textContent = (selected.entries.length ? 'This room: ' + selected.entries.length + ' catalog views, ' + room.supports.length + ' support tables, and 3 scale anchors.' : 'No catalog views match these filters.') +
      '\nFixture state: ' + (powered ? 'powered demonstration only' : 'idle') + '; motion ' + (moving ? 'running' : 'frozen') + '. ' +
      'Placement conflicts: ' + room.violations.length + '; missing current-view art: ' + missing.length + '; surface fallback placements: ' + failures.length + '.';
    $('diagnostics').textContent = JSON.stringify({ fixtureOnly: true, ownerApproval: 'not asserted', violations: room.violations, missing: missing.map(v => v.key), runtimeDrift: runtimeDrift.map(v => v.key), mounts, assetFailures: status.failures }, null, 2);
    document.body.dataset.result = room.violations.length || missing.length || runtimeDrift.length || failures.length ? 'review-issues' : 'rendered';
    // A compact observable receipt for the coordinator's browser check; no save or backend reference.
    window.PropCatalogReviewState = { types: data.catalogTypes, directions: data.supportedViews, keys: selected.entries.map(v => v.key), rendered: visited.size,
      doc: room.doc, violations: room.violations, mounts, missing: missing.map(v => v.key), assetFailures: status.failures, runtimeDrift: runtimeDrift.map(v => v.key), fixtureOnly: true, powered, moving };
    if (moving) frame = requestAnimationFrame(paint);
  }
  rebuild();
})().catch(error => {
  const report = document.getElementById('report'); if (report) report.textContent = error.stack || String(error);
  document.body.dataset.result = 'error'; console.error(error);
});
