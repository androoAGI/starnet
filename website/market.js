/* website/market.js — the public Skill Market page (market.html).

   Reads the SAME catalog every StarNet station installs from (/.well-known/starnet-skills.json, built and signed by
   scripts/build-skill-catalog.mjs) and lists it: StarNet Originals first, then credited community picks. "Read the
   skill" fetches that skill's published SKILL.md. Same-origin requests only (the site's CSP allows nothing else),
   and everything that comes from the catalog is inserted as text, never as HTML. No tracking, no storage. */
(function () {
  'use strict';

  var INDEX = '/.well-known/starnet-skills.json';
  // the app's own gear names (REFIT palette labels, the same ones the in-app SKILL LIBRARY and market show)
  var GEAR = { cabinet: 'INTEL CAB', dish: 'DISH', workbench: 'WORKBENCH', notebook: 'NOTEBOOK', studio: 'STUDIO', orchestrator: 'ORCHESTRATOR', computer: 'COMPUTER' };
  var SHELVES = [
    { id: 'originals', title: 'STARNET ORIGINALS', note: 'Written and tested by StarNet for your station\'s gear and tools.' },
    { id: 'community', title: 'COMMUNITY', note: 'Skills by other authors, each credited: open-source picks adapted for StarNet, and skills StarNet users shared, read by a person before they were published.' }
  ];
  var shelf = 'all';
  var list = document.getElementById('mk-list');
  var status = document.getElementById('mk-status');
  var q = document.getElementById('mk-q');
  var count = document.getElementById('mk-count');
  if (!list || !status) return;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function str(v) { return v == null ? '' : String(v); }
  // only same-origin package paths and https upstream links are ever turned into links
  function safePath(p) { return /^\/skills\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[A-Za-z0-9._\/-]+$/.test(p) && p.indexOf('..') < 0 ? p : ''; }
  function safeHttps(u) { return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }
  // SKILL.md without its frontmatter: what the agent actually reads
  function body(md) { var m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md); return (m ? md.slice(m[0].length) : md).trim(); }

  function card(s) {
    var c = el('article', 'mk-card');
    c.setAttribute('data-shelf', s.shelf === 'originals' ? 'originals' : 'community');
    c.setAttribute('data-search', [s.name, s.slug, s.description, s.category, s.author].concat(s.tags || []).join(' ').toLowerCase());
    var head = el('div', 'mk-head');
    head.appendChild(el('h4', null, s.name || s.slug));
    head.appendChild(el('span', 'mk-cat', s.category || 'General'));
    c.appendChild(head);
    c.appendChild(el('p', 'mk-desc', s.description));

    var meta = el('p', 'mk-meta');
    if (s.shelf === 'originals') meta.appendChild(el('b', null, 'StarNet Original'));
    else { meta.appendChild(document.createTextNode('by ')); meta.appendChild(el('b', null, s.author || 'credited authors')); }
    meta.appendChild(document.createTextNode(' · ' + (s.license || 'license in package') + ' · v' + str(s.version)));
    if (s.uploaded === true) meta.appendChild(document.createTextNode(' · shared by a StarNet user'));
    var up = s.upstream && safeHttps(str(s.upstream.url));
    if (up) {
      meta.appendChild(document.createTextNode(' · '));
      var a = el('a', null, 'original ↗');
      a.href = up; a.target = '_blank'; a.rel = 'noopener';
      meta.appendChild(a);
    }
    c.appendChild(meta);

    var gear = (s.requires || []).map(function (g) { return GEAR[g] || str(g).toUpperCase(); });
    if (gear.length) {
      var g = el('p', 'mk-gear', 'Uses ');
      g.appendChild(el('b', null, gear.join(', ')));
      c.appendChild(g);
    }

    // Download: the skill as a standard Agent Skills folder (.zip), its sha256 pinned in the signed catalog
    var dl = s.download && /^[a-z0-9-]+-\d+\.\d+\.\d+\.zip$/.test(str(s.download.path)) ? safePath('/skills/' + s.slug + '/' + s.version + '/' + s.download.path) : '';
    if (dl) {
      var a2 = el('a', 'mk-dl', 'Download .zip');
      a2.href = dl;
      a2.setAttribute('download', s.download.path);
      var kb = Math.max(1, Math.round((Number(s.download.bytes) || 0) / 1024));
      var row = el('p', 'mk-dl-row');
      row.appendChild(a2);
      row.appendChild(el('span', null, ' ' + kb + ' KB · SKILL.md' + ((s.files || []).length > 1 ? ' + ' + ((s.files || []).length - 1) + ' more' : '')));
      c.appendChild(row);
    }

    var path = safePath(str(s.sourceUrl));
    if (path) {
      var d = el('details', 'mk-read');
      d.appendChild(el('summary', null, 'Read the skill'));
      var pre = el('pre', 'mk-md', 'Loading…');
      d.appendChild(pre);
      d.addEventListener('toggle', function () {
        if (!d.open || d.getAttribute('data-loaded')) return;
        d.setAttribute('data-loaded', '1');
        fetch(path, { credentials: 'omit' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(function (t) { pre.textContent = body(t); })
          .catch(function () { pre.textContent = 'Could not load this skill right now.'; d.removeAttribute('data-loaded'); });
      });
      c.appendChild(d);
    }
    return c;
  }

  function apply() {
    var needle = q ? q.value.trim().toLowerCase() : '';
    var shown = 0;
    Array.prototype.forEach.call(list.querySelectorAll('.mk-group'), function (grp) {
      var vis = 0;
      Array.prototype.forEach.call(grp.querySelectorAll('.mk-card'), function (c) {
        var hit = (shelf === 'all' || c.getAttribute('data-shelf') === shelf) && (!needle || c.getAttribute('data-search').indexOf(needle) >= 0);
        c.hidden = !hit;
        if (hit) vis++;
      });
      grp.hidden = vis === 0;
      var n = grp.querySelector('.mk-group-head span');
      if (n) n.textContent = String(vis);
      shown += vis;
    });
    var none = list.querySelector('.mk-empty');
    if (!shown && !none) list.appendChild(el('p', 'mk-empty', 'No skills match that search.'));
    else if (shown && none) none.remove();
  }

  function render(doc) {
    var skills = (doc && Array.isArray(doc.skills) ? doc.skills : []).filter(function (s) { return s && s.slug; });
    if (!skills.length) { status.textContent = 'The catalog is empty right now.'; return; }
    SHELVES.forEach(function (sh) {
      var rows = skills.filter(function (s) { return (s.shelf === 'originals' ? 'originals' : 'community') === sh.id; });
      if (!rows.length) return;
      var grp = el('div', 'mk-group');
      grp.setAttribute('data-shelf', sh.id);
      var head = el('div', 'mk-group-head');
      head.appendChild(el('h3', null, sh.title));
      head.appendChild(el('span', null, rows.length));
      grp.appendChild(head);
      grp.appendChild(el('p', 'mk-group-note', sh.note));
      var grid = el('div', 'mk-grid');
      rows.forEach(function (s) { grid.appendChild(card(s)); });
      grp.appendChild(grid);
      list.appendChild(grp);
    });
    var originals = skills.filter(function (s) { return s.shelf === 'originals'; }).length;
    if (count) count.textContent = skills.length + ' skills: ' + originals + ' StarNet Originals, written for your station\'s gear, and ' +
      (skills.length - originals) + ' credited picks from the open-source community.';
    status.textContent = '';
    status.hidden = true;
    apply();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.mk-shelf'), function (b) {
    b.addEventListener('click', function () {
      shelf = b.getAttribute('data-shelf');
      Array.prototype.forEach.call(document.querySelectorAll('.mk-shelf'), function (x) {
        var on = x === b;
        x.classList.toggle('on', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      apply();
    });
  });
  if (q) q.addEventListener('input', apply);

  fetch(INDEX, { credentials: 'omit' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(render)
    .catch(function () {
      status.className = 'mk-status mk-err';
      status.textContent = 'Could not load the skill catalog right now. Refresh to try again, or browse it in the app under ABILITIES › DISCOVER › SKILL MARKET.';
    });
}());
