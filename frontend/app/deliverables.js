/* AGENT OS deliverable library: safe preview helpers + backend-backed Workshop/artifact browser. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deliverables = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function safeMarkdown(raw) {
    return String(raw || '').slice(0, 512 * 1024).split(/\r?\n/).map(line => {
      let s = esc(line).replace(/\*\*([^*]{1,500})\*\*/g, '<strong>$1</strong>').replace(/`([^`]{1,500})`/g, '<code>$1</code>');
      const h = s.match(/^(#{1,3})\s+(.+)$/); if (h) return '<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>';
      return s ? '<p>' + s + '</p>' : '';
    }).join('');
  }
  // markdown -> one plain line (a card's glance): links keep their words, heading/list/quote marks and **, __, `, * drop.
  // THE ONE GLANCE (walk 10-14): TO REVIEW's preview, the COMMS INBOX card's quote and a goal's milestones read through this
  // same line — a fenced block, a table's rule row and pipes, a --- rule drop too, and a stripped `code` leaves no stray space.
  // …and a reply that is ONLY code reads as that code's own words (fences and language tag dropped) — never an empty glance,
  // or a card whose quote "below" says nothing (review 10-14).
  function plainLine(raw) {
    const src = String(raw || '');
    const words = flatLine(src.replace(/\x60\x60\x60[\s\S]*?(\x60\x60\x60|$)/g, ' '));
    if (words || src.indexOf('\x60\x60\x60') === -1) return words;
    return src.replace(/\x60\x60\x60[^\n]*(\n|$)/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function flatLine(raw) {
    return raw
      .replace(/(^|\n)[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(?=\n|$)/g, '$1')   // a table's rule row
      .replace(/(^|\n)[ \t]*([-*_])([ \t]*\2){2,}[ \t]*(?=\n|$)/g, '$1')                             // a --- / *** rule
      .replace(/[ \t]*\|[ \t]*/g, ' ')
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')   // a link or an image keeps its words (an image's '!' drops too)
      .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/g, '$1')
      .replace(/(^|\s)#{1,6}\s+/g, '$1')   // a heading inside a summary the server already folded onto one line
      .replace(/(\*\*|__|\x60)/g, '').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
      .replace(/\s+/g, ' ').trim();
  }
  function csvRows(raw, maxRows, maxCols) {
    const rows = []; let row = [], cell = '', quoted = false;
    raw = String(raw || '').slice(0, 512 * 1024); maxRows = Math.max(1, maxRows || 50); maxCols = Math.max(1, maxCols || 20);
    for (let i = 0; i <= raw.length && rows.length < maxRows; i++) {
      const c = i < raw.length ? raw[i] : '\n';
      if (quoted && c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
        if (row.length < maxCols) row.push(cell); cell = '';
        if (c === '\r' && raw[i + 1] === '\n') i++;
        if (c !== ',') { rows.push(row); row = []; }
      } else cell += c;
    }
    return rows;
  }
  function safeCsv(raw, maxRows, maxCols) {
    const rows = csvRows(raw, maxRows, maxCols);
    return '<table class="deliverable-csv"><tbody>' + rows.map((r, ri) => '<tr>' + r.map(c => '<' + (ri ? 'td' : 'th') + '>' + esc(c) + '</' + (ri ? 'td' : 'th') + '>').join('') + '</tr>').join('') + '</tbody></table>';
  }
  // A server-built open URL -> a TICKETED one (a file- or run-scoped, minutes-long capability; ApiTicket.sign). The
  // master token never rides an href: these URLs reach OS-browser history, Referer and copied links.
  function openUrl(url) { return (typeof ApiTicket !== 'undefined' && ApiTicket.sign) ? ApiTicket.sign(url) : String(url || ''); }
  const fmtSize = n => n == null ? 'size unknown' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const apiBase = () => typeof window !== 'undefined' ? String(window.__STARNET_API__ || '') : '';
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { status: r.status }); return j; });

  function fileHref(f) {
    const href = openUrl(f && f.openUrl);
    const base = apiBase();
    return base && href.charAt(0) === '/' ? base + href : href;
  }
  // OPENING a text deliverable (not previewing it in a card) asks for the station's readable document view, never raw text on
  // a white tab (live walk 10-14; Chat.readableUrl keeps the one list of text formats). The in-card preview still reads fileHref.
  function openHref(f) {
    const href = fileHref(f);
    return (typeof Chat !== 'undefined' && Chat && typeof Chat.readableUrl === 'function' && /^[^?#]*\/api\/file\?/.test(href)) ? Chat.readableUrl(href, f && f.path) : href;
  }
  // The backend's openUrl already carries the exact jailed path it proved. Read that value instead of
  // rebuilding Workshop paths from display fields (a kept/pending row may have a different lifecycle shape).
  function artifactPath(f) {
    const match = String((f && f.openUrl) || '').match(/[?&]path=([^&#]*)/);
    if (match) { try { return decodeURIComponent(match[1]); } catch (_) {} }
    return String((f && f.path) || '');
  }
  function tauriCore() {
    return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  }
  /* WHERE A LIBRARY FILE IS SAVED (org pass 10-14, P24), read off the backend's own openUrl — never rebuilt from display
     fields: { agentId, path, inProject }. 'path' is what the shared folder / copy-path keys take (relative = the agent's
     workspace, absolute as is); 'inProject' is true only when the URL proves the file sits in that project folder
     (?project=), false only when it proves the file is NOT in it, null when there is no project. 'inWorkspace' is true only
     where the URL proves the agent's own workspace (a relative path with no ?project=, a workshop run) and null for an absolute
     path: that can be any granted folder (a path: grant on the Desktop, say), so only outsideNote's check against the agent's
     real workspace root may call it the workspace. */
  const normPath = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const pathWithin = (root, p) => !!root && normPath(p).indexOf(normPath(root) + '/') === 0;
  function savedLocation(r, f, project) {
    const url = String((f && f.openUrl) || '');
    const isAbs = p => /^(?:[A-Za-z]:[\\/]|\/)/.test(p);
    const dec = s => { try { return decodeURIComponent(s); } catch (_) { return ''; } };
    const within = full => project ? pathWithin(project, full) : null;
    const ws = /^\/workshop-run\/([^/?#]+)\/([^/?#]+)\/([^?#]+)/.exec(url);
    if (ws) return { agentId: dec(ws[1]) || r.agentId || 'agent', path: 'workshop/' + dec(ws[2]) + '/' + ws[3].split('/').map(dec).join('/'), inProject: project ? false : null, inWorkspace: true };
    const agent = dec((/[?&]agent=([^&#]*)/.exec(url) || [])[1] || '') || r.agentId || 'agent';
    const rel = artifactPath(f);
    if (!rel) return null;
    const root = dec((/[?&]project=([^&#]*)/.exec(url) || [])[1] || '');
    if (root && !isAbs(rel)) {
      const sep = root.indexOf('\\') >= 0 ? '\\' : '/';
      const full = root.replace(/[\\/]+$/, '') + sep + rel.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
      return { agentId: agent, path: full, inProject: within(full), inWorkspace: false };
    }
    if (isAbs(rel)) return { agentId: agent, path: rel, inProject: within(rel), inWorkspace: null };   // any folder the run was let write
    return { agentId: agent, path: rel, inProject: project ? false : null, inWorkspace: true };   // relative, no project: the agent's own workspace
  }
  /* the outside-the-project note a FILES row's keys carry (P24): '<AGENT> workspace' only where that is PROVEN, by savedLocation's
     inWorkspace or by an absolute path inside the agent's real workspace root (wsRoot, from Chat.fullSavedPath(agent, '')). Any other
     absolute path outside the project (a granted Desktop folder) is said as outside the project, never as the workspace. */
  function outsideNote(loc, project, who, wsRoot) {
    if (!loc || loc.inProject !== false) return '';
    const s = String(project || '').replace(/[\\/]+$/, ''), leaf = s.split(/[\\/]/).pop() || s;
    const inWs = loc.inWorkspace === true || (loc.inWorkspace == null && pathWithin(wsRoot, loc.path));
    return inWs ? 'saved in ' + who + ' workspace, not in ' + leaf : 'saved outside ' + leaf;
  }
  function revokePreview(state) {
    if (!state) return;
    state.previewId = (state.previewId || 0) + 1;
    if (state.previewAbort) { state.previewAbort.abort(); state.previewAbort = null; }
    if (state.previewExpiry) { clearTimeout(state.previewExpiry); state.previewExpiry = null; }
    if (state.blobUrl) try { URL.revokeObjectURL(state.blobUrl); } catch (_) {}
    state.blobUrl = '';
  }
  async function openDesktop(r, f, href, say, folderKey, pointBelow) {
    const core = tauriCore();
    if (!core || !core.invoke) return false;
    if (f.sandboxed) {
      try { await core.invoke('open_external_url', { url: href }); }
      catch (_) { if (say) say('Could not open that safe preview in your browser.', true); }
      return true;
    }
    try {
      await core.invoke('starnet_open_artifact', { path: artifactPath(f), agentId: r.agentId || 'agent' });
    } catch (err) {
      // Cancel at the host confirmation is an answer. Falling through would bypass the user's refusal.
      if (/declined at the host/i.test(String(err || ''))) return true;
      // re-mint: the host confirmation above may have outlasted the first ticket's few-minute life
      try { await core.invoke('open_external_url', { url: openHref(f) }); }
      // the file row's own folder key takes over (org pass 10-14, P24): reveal it in its folder, or copy its full path.
      // No key on this row: a TO REVIEW FILES row (outbox.js) has no key slot; it points at the library below ONLY while a
      // library card for its run is really drawn there (pointBelow) — a cleared or filtered-out run has none, so it and a
      // library row whose key never wired keep the old real places to look.
      catch (_) {
        if (folderKey && folderKey.click) { folderKey.click(); if (say) say('Could not open that file — showing where it is saved instead.', true); }
        else if (say && pointBelow) say('Could not open that file — open its run in the library below; the folder key on its file row shows where it is saved.', true);
        else if (say) say('Could not open that file — use its session or workspace folder to find it on disk.', true);
      }
    }
    return true;
  }
  async function previewInCard(f, host, state, say) {
    if (!host) return false;
    revokePreview(state);
    if (state && state.previewHost && state.previewHost !== host) state.previewHost.innerHTML = '';
    if (state) state.previewHost = host;
    const id = state.previewId;
    const current = () => state.previewId === id && host.isConnected !== false;
    const controller = new AbortController(); state.previewAbort = controller;
    host.innerHTML = '<p class="muted">Loading safe preview…</p>';
    try {
      const response = await fetch(fileHref(f), { cache: 'no-store', signal: controller.signal });
      if (!current()) return true;
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (f.preview === 'image') {
        const blob = await response.blob();
        if (!current()) return true;
        const blobUrl = URL.createObjectURL(blob);
        if (state) state.blobUrl = blobUrl;
        host.innerHTML = '<img class="deliverable-image" alt="Preview of ' + esc(f.path) + '">';
        const img = host.querySelector('img');
        const release = () => {
          // A late load/error from the previous image owns only its own URL.
          if (state.blobUrl !== blobUrl) return;
          clearTimeout(state.previewExpiry); state.previewExpiry = null;
          URL.revokeObjectURL(blobUrl); state.blobUrl = '';
        };
        state.previewExpiry = setTimeout(release, 30000);
        img.onload = img.onerror = release;
        img.src = blobUrl;
      } else {
        const text = await response.text();
        if (!current()) return true;
        host.innerHTML = '<div class="cfg-block"><b>SAFE PREVIEW · ' + esc(f.path) + '</b>' + (f.preview === 'markdown' ? safeMarkdown(text) : safeCsv(text, 50, 20)) + '</div>';
      }
    } catch (e) {
      if (!current()) return true;
      host.innerHTML = '';
      // A 404 here has ONE ordinary cause: the file was moved or deleted on disk after the library recorded it.
      // KEEP copies rather than moves, so the archive normally survives — but the Commander owns that folder and
      // may clear it. Say the real reason instead of showing them an HTTP code they cannot act on.
      const gone = /\b404\b/.test(String((e && e.message) || ''));
      if (say) say(gone
        ? 'That file is no longer on disk — it was moved or deleted after this deliverable was recorded.'
        : 'Could not preview that file: ' + e.message, true);
    } finally { if (state.previewAbort === controller) state.previewAbort = null; }
    return true;
  }
  // The BROWSER window target for a library file, read off the backend's own openUrl (never rebuilt from display
  // fields): '/workshop-run/<agent>/<run>/<path>' → a workshop page; '/api/file?agent=&path=' → a workspace page.
  function browserTarget(r, f) {
    if (!/\.html?$/i.test(String((f && f.path) || ''))) return null;
    const url = String((f && f.openUrl) || '');
    const m = /^\/workshop-run\/([^/?#]+)\/([^/?#]+)\/([^?#]+)$/.exec(url);
    if (m) {
      try { return { agentId: decodeURIComponent(m[1]), runId: decodeURIComponent(m[2]), path: m[3].split('/').map(decodeURIComponent).join('/'), source: 'workshop' }; }
      catch (_) { return null; }
    }
    if (url.indexOf('/api/file?') === 0) {
      const agent = (/[?&]agent=([^&#]*)/.exec(url) || [])[1];
      let agentId = r.agentId || 'agent';
      try { if (agent) agentId = decodeURIComponent(agent); } catch (_) {}
      return { agentId, path: artifactPath(f), source: 'workspace' };
    }
    return null;
  }
  // is a library card for this run drawn in the window holding this link? (TO REVIEW lists cleared runs too: includeCleared=1)
  function libraryShows(link, runId) {
    if (!runId || !link || !link.closest) return false;
    const win = link.closest('.dlv');   // the library TO REVIEW is mounted inside (stationui's DELIVERABLES builder)
    if (!win || !win.querySelectorAll) return false;
    return Array.prototype.some.call(win.querySelectorAll('article.dlv-card[data-run]'), el => el.getAttribute('data-run') === String(runId));
  }
  async function handleOpenClick(ev, rows, state, say) {
    const link = ev && ev.target && ev.target.closest ? ev.target.closest('a[data-file]') : null;
    if (!link) return false;
    const card = link.closest('[data-i]');
    const r = card && rows && rows[Number(card.dataset.i)];
    const f = r && r.files && r.files[Number(link.dataset.file) || 0];
    if (!r || !f || !f.openUrl) return false;

    // A web page opens RUNNING in the station's BROWSER window — a workshop page from its run folder, a workspace
    // page through the sandboxed /view/ route (the window carries OPEN OUTSIDE for the OS browser).
    const page = browserTarget(r, f);
    if (page && typeof OutputBrowser !== 'undefined' && OutputBrowser.open) {
      ev.preventDefault(); ev.stopPropagation();
      OutputBrowser.open(page);
      return true;
    }

    const core = tauriCore();
    // A browser-only non-preview is already a real href; let the anchor perform its native navigation — with a
    // FRESH ticket (the rendered one may be past its few-minute life; a click handler runs before the navigation).
    if ((!core || !core.invoke) && (!f.preview || f.sandboxed)) { try { link.href = openHref(f); } catch (_) {} return false; }
    ev.preventDefault();
    ev.stopPropagation();
    if (core && core.invoke) {
      const li = link.closest('li'); const slot = li && li.querySelector ? li.querySelector('.dlv-floc') : null;
      return openDesktop(r, f, fileHref(f), say, slot ? slot.querySelector('.deliverable-folder') : null, !slot && libraryShows(link, r.runId));
    }
    return previewInCard(f, card.querySelector('[data-preview]'), state || {}, say);
  }

  /* ============== THE ORGANIZED LIBRARY (2026-08-13) ==============
     Every card is TWO LAYERS and they are never allowed to blur:
       · the SAY band  — the agent's own title + one-line description (deliverable_note). Prose. No authority.
       · the FACTS band — status, crew, file count, size, time. All derived by the harness from the run log.
     The pill outranks the prose: if a card says "churn analysis" and the run failed, FAILED is what reads loudest.
     A row the agent never named shows its filename as the plain fact it is (`authored:false`) rather than dressing
     a basename up as a description — a title we invented would be the same lie in a nicer font. */

  const DAY_MS = 86400000;
  // Time buckets, the axis people actually search on when they can't remember the project. Injected `now` so this
  // is testable headlessly and never reads an ambient clock mid-render.
  function bucketOf(ts, now) {
    if (!ts) return 'EARLIER';
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    if (ts >= midnight.getTime()) return 'TODAY';
    if (ts >= midnight.getTime() - 6 * DAY_MS) return 'THIS WEEK';
    return 'EARLIER';
  }
  const BUCKETS = ['TODAY', 'THIS WEEK', 'EARLIER'];

  // "2h ago" for the glance; the exact stamp still shows in the details drawer. Same vocabulary the sessions and
  // projects rails already use, so the three surfaces read as one system.
  function agoOf(ts, now) {
    if (!ts) return '';
    const d = Math.max(0, now - ts);
    if (d < 60000) return 'just now';
    const m = Math.floor(d / 60000); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    const days = Math.floor(h / 24); if (days < 30) return days + 'd ago';
    return Math.floor(days / 30) + 'mo ago';
  }

  // status -> the pill a person can read. `pending` is the only one that asks for something, so it alone is gold.
  const PILLS = {
    kept: { label: 'KEPT', cls: 'ok' },
    produced: { label: 'DONE', cls: 'ok' },
    // a PLAN the Commander pressed Implement on: it was acted on and produced a build. Distinct from KEPT on
    // purpose — nothing was copied to a folder, so calling it kept would assert a file landing that never happened.
    implemented: { label: 'IMPLEMENTED', cls: 'ok' },
    pending: { label: 'NEEDS A DECISION', cls: 'warn' },
    failed: { label: 'FAILED', cls: 'bad' },
    discarded: { label: 'DISCARDED', cls: 'off' }
  };
  function pillOf(status) {
    return Object.prototype.hasOwnProperty.call(PILLS, status) ? PILLS[status] : { label: String(status || 'UNKNOWN').toUpperCase(), cls: 'off' };
  }
  // A raw agentId reads as debug output; resolve through the live roster the same way every other window does.
  function agentLabel(id) {
    if (typeof App !== 'undefined' && App && typeof App.agentName === 'function') { try { return App.agentName(id) || id; } catch (_) {} }
    return String(id || 'agent');
  }

  // the server refuses to clear an undecided build (it still needs KEEP IT or DISCARD), so a clear never counts one
  const clearableRow = r => !!r && r.status !== 'pending';
  function rowsForRun(items, runId, query) {
    const needle = String(query || '').trim().toLowerCase();
    return items.filter(r => r.runId === runId && (!needle || [r.title, r.summary, r.ask].join(' ').toLowerCase().includes(needle)));
  }
  function mount(body) {
    let rows = [], projects = [], kinds = [], summary = null, loadSeq = 0, project = '', kind = '', total = 0, clearable = 0;   // clearable null = unknown
    let runFilter = null;
    let lastUndo = null;   // the last clear's { text, token }: its UNDO comes back after an arm/disarm or a reload blanks the line
    const openState = { blobUrl: '', previewHost: null };
    const revoke = () => revokePreview(openState);
    // self-driving lane 5: no second DELIVERABLES heading under the MY WORK tab that already says it, and one short line where
    // a four-line paragraph sat (TO REVIEW still lands right after this p.muted — stationui's deliverables builder)
    body.innerHTML = '<div class="cfg dlv"><p class="muted dlv-lead" title="Previews open safely inside Agent OS in a browser; desktop OPEN uses your file app.">Everything your crew made, filed by project — open one for the ask, the answer and every file.</p>' +
      '<div id="dl-head" class="dlv-head-strip"></div><div id="dl-run-scope" class="cfg-block" hidden></div>' +
      '<div class="deliverables-toolbar"><input id="dl-query" aria-label="Search deliverables" placeholder="search title, agent, project"><select id="dl-status" aria-label="Filter deliverables"><option value="">ALL</option><option value="pending">NEEDS A DECISION</option><option value="produced">DONE</option><option value="kept">KEPT</option><option value="implemented">IMPLEMENTED</option><option value="failed">FAILED</option><option value="discarded">DISCARDED</option></select><button class="bb sm" id="dl-clear-shown" data-tip="Takes these cards out of the library (not TO REVIEW&rsquo;s rating list) — the files stay on disk, and UNDO brings them back." hidden>CLEAR ALL</button>' +
        // the two upkeep keys fold behind ONE quiet MORE key (org pass 10-14, P13): search, the status filter, the KIND chips and
        // CLEAR ALL/THESE stay in view (FOLD BY FREQUENCY); the fold opens inline in this row — never a popover.
        '<details class="dlv-tools" id="dl-tools"><summary class="bb sm" aria-label="More library tools">MORE <span class="dlv-tools-car" aria-hidden="true">▸</span></summary>' +
        '<span class="dlv-tools-keys"><button class="bb sm" id="dl-refresh">REFRESH</button><button class="bb sm" id="dl-clean" data-tip="Previews first: removes only the records of failed and discarded runs — files are not deleted, and UNDO brings them back">DELETE FAILED &amp; DISCARDED RECORDS</button></span></details></div>' +
      '<div id="dl-kinds" class="dlv-kinds"></div>' +
      '<div id="dl-msg" class="msg" aria-live="polite"></div><div id="dl-cleanup"></div>' +
      '<div class="dlv-split"><nav id="dl-rail" class="dlv-rail" aria-label="Projects"></nav><div id="dl-list" class="dlv-main"></div></div></div>';
    const q = body.querySelector('#dl-query'), status = body.querySelector('#dl-status'), list = body.querySelector('#dl-list'), rail = body.querySelector('#dl-rail'), msg = body.querySelector('#dl-msg'), cleanup = body.querySelector('#dl-cleanup'), head = body.querySelector('#dl-head'), kindbar = body.querySelector('#dl-kinds');
    const say = (s, bad) => { msg.textContent = s || ''; msg.className = 'msg ' + (bad ? 'bad' : 'ok'); };
    const restoreMsg = () => lastUndo ? sayUndo(lastUndo.text, lastUndo.token) : say('');
    const runScope = body.querySelector('#dl-run-scope');
    const renderRunScope = () => {
      runScope.hidden = !runFilter;
      runScope.innerHTML = runFilter ? '<b>OUTPUTS FROM THIS STEP</b><p>' + esc(runFilter.label) + '</p><button class="bb sm" id="dl-all-runs">SHOW ALL WORK</button>' : '';
      runScope.querySelector('button')?.addEventListener('click', () => { runFilter = null; q.value = ''; status.value = ''; project = ''; kind = ''; renderRunScope(); load(); });
    };
    // org P01: NEEDS YOU's build row lands here on NEEDS A DECISION — the same status filter the summary's route drives
    body._deliverablesShowStatus = (st) => {
      runFilter = null; q.value = ''; project = ''; kind = ''; status.value = String(st || ''); renderRunScope(); load();
    };
    body._deliverablesShowRun = (runId, label) => {
      runFilter = { runId: String(runId), label: String(label || 'Selected step') };
      q.value = ''; status.value = ''; project = ''; kind = ''; renderRunScope(); load();
    };

    /* THE PROJECT RAIL. Counts come from the server's facet, which is computed BEFORE the project filter runs —
       so selecting one project can never hide the others. A root whose path grant was revoked still appears,
       marked: it names work that really happened, and hiding it would be the library lying by omission. */
    function renderRail() {
      const total = projects.reduce((n, p) => n + (Number(p.count) || 0), 0);
      const row = (key, name, count, extra) =>
        '<button class="dlv-proj' + (project === key ? ' on' : '') + '" data-project="' + esc(key) + '">' +
        '<span class="dlv-proj-n">' + esc(name) + '</span><span class="dlv-proj-c">' + count + '</span>' + (extra || '') + '</button>';
      rail.innerHTML = row('', 'ALL WORK', total) + projects.map(p =>
        row(p.unfiled ? 'unfiled' : p.root, p.name, p.count, p.blessed ? '' : '<span class="dlv-proj-rev">folder access revoked</span>')
      ).join('');
    }

    function crewHtml(r) {
      const crew = Array.isArray(r.contributors) ? r.contributors : [];
      if (!crew.length) return '';
      // The LEAD carries the phosphor rail, workers are dim chips — the same "position identifies the speaker"
      // idea COMMS uses, so a two-agent card reads as a hierarchy without anyone having to parse a legend.
      // `identityFallback` is surfaced, never swallowed: that run was NOT the named specialist.
      return '<span class="dlv-crew">' + crew.map(c =>
        '<span class="dlv-who' + (c.role === 'lead' ? ' lead' : '') + '">' + esc(agentLabel(c.agentId)) +
        (c.identityFallback ? '<i> stand-in</i>' : '') + '</span>').join('') + '</span>';
    }

    /* ONE CARD = a glance + a drawer, following the shape Andrew locked for the OUTBOX window: the collapsed row
       carries the identity and the verdict and NO buttons, and everything that needs reading or deciding lives
       one click down. One drawer open at a time. The glance answers "what is this and is it done"; the drawer
       answers "what exactly did I get, what did it cost, and where is it". */
    /* THE DRAWER — three things, and nothing else: what was asked, what came back, and what you can open.
       An earlier draft also listed model, cost, duration, turns and tool counts. Andrew cut every one of them:
       run metrics are the LOGBOOK's subject, and putting them on the card that answers "what did I get" only
       made that answer harder to find. Anything added back here must be ABOUT THE OUTPUT, not the machinery. */
    function detailHtml(r) {
      const run = r.run || null;
      const files = r.files || [];
      const mainAt = r.main ? files.findIndex(f => f && f.path === r.main) : -1;
      const mainFirst = lis => (mainAt > 0 ? [lis[mainAt]].concat(lis.filter((_, i) => i !== mainAt)) : lis).join('');
      const sec = (label, inner) => inner ? '<div class="dlv-sec"><h5>' + label + '</h5>' + inner + '</div>' : '';
      // THE ASK — the Commander's own words, quoted rather than paraphrased.
      const ask = sec('WHAT YOU ASKED FOR', r.ask ? '<p class="dlv-quote">' + esc(r.ask) + '</p>' : '');
      // WHAT CAME BACK — the agent's recorded closing message, and ONLY when the run kept one. It deliberately
      // does NOT fall back to the deliverable's summary: that sentence is already on the row directly above, and
      // reprinting it here would put the same words on screen twice, forty pixels apart. A section that repeats
      // what you just read is the added complexity this pass exists to remove.
      // (a WORKFLOW job's row carries what the line delivered — the job record's own output — 10-03)
      const said = (run && run.deliveryText) || r.output || '';
      // read as the agent wrote it — headings, bold, code — through the same safe renderer the file preview uses (rc walk #48: raw **marks**)
      const back = sec('WHAT CAME BACK', said ? '<div class="dlv-said md">' + safeMarkdown(said) + '</div>' : '');
      // THE FILES — each openable on its own, with the size measured off disk.
      const fileRows = files.length
        // the main file leads the list (its OPEN is the drawer's first key — org pass 10-14, P13); the rows are built in the
        // backend's order first, so every data-file index still points at its own file
        ? '<ul class="dlv-files">' + mainFirst((r.files || []).map((f, fi) => f.openUrl
            ? '<li><a class="bb sm' + (r.main && f.path === r.main ? ' dlv-hero' : '') + '" data-file="' + fi + '" href="' + esc(openHref(f)) + '" target="_blank" rel="noopener">OPEN</a><span class="dlv-fname">' + esc(f.path) + '</span><span class="dlv-fsize">' + esc(fmtSize(f.bytes)) + '</span>' + (r.main && f.path === r.main ? '<span class="dlv-fmain">the main one</span>' : '') + '<span class="dlv-floc" data-floc="' + fi + '"></span></li>'
            : '<li><span class="dlv-fname off">' + esc(f.path) + '</span><span class="dlv-fsize">no longer available</span></li>')) + '</ul>'
        : '<p class="dlv-none">This run recorded no files.</p>';
      const openSession = (r.jobId ? '<button class="bb sm" data-act="workflow">OPEN IN WORKFLOWS</button>' : '') + ((run && run.streamId) ? '<button class="bb sm" data-act="session">↗ OPEN THE FULL CONVERSATION</button>' : '');
      const decide = ((r.actions && r.actions.keep) ? '<button class="bb sm" data-act="keep">KEEP IT</button>' : '') +
        ((r.actions && r.actions.discard) ? '<button class="bb sm danger" data-act="discard">DISCARD</button>' : '') +
        // DONE WITH IT (2026-10-10): clears the card out of the library — files stay on disk, UNDO brings it back. An
        // undecided build is the one row that can't go: it still needs KEEP IT or DISCARD (the backend refuses it too).
        (r.status !== 'pending' ? '<button class="bb sm" data-act="clear" data-tip="Takes it out of this library. The files stay on disk.">✓ DONE · CLEAR</button>' : '');
      const acts = (openSession || decide) ? '<div class="row dlv-acts">' + openSession + decide + '</div>' : '';
      return ask + back + sec('FILES', fileRows) + acts;
    }

    function cardHtml(r, i, now) {
      const pill = pillOf(r.status);
      const nFiles = (r.files || []).length;
      // THE SAY BAND — the agent's words, or an honest admission that there aren't any.
      /* (rc walk #48) the one-line summary is read as plain words — a workflow job's summary is the head of its markdown answer,
         and "**TEASER 1:**" on the glance is markup, not a sentence. An unnamed file says nothing under its name: its name and
         the facts band are the plain facts ("the agent did not name this one" was an apology, not information). */
      const sum = plainLine(r.summary);
      const say2 = '<b class="dlv-title' + (r.authored ? '' : ' plain') + '">' + esc(r.title || 'Untitled output') + '</b>' + (sum ? '<p class="dlv-sum">' + esc(sum) + '</p>' : '');
      // THE FACTS BAND — every item here is provable from the run log.
      // "size unknown" is for a file we could not measure. A row with NO files has nothing to measure, so it says
      // so — the two are different facts and the wrong one reads as a failed read.
      const bulk = nFiles ? (nFiles + (nFiles === 1 ? ' file · ' : ' files · ') + fmtSize(r.size)) : 'no files';
      const facts = '<span class="dlv-pill ' + pill.cls + '">' + esc(pill.label) + '</span>' + crewHtml(r) +
        '<span class="dlv-meta">' + esc(bulk) + (r.createdAt ? ' · ' + esc(agoOf(r.createdAt, now)) : '') + '</span>';
      return '<article class="dlv-card" data-i="' + i + '"' + (r.runId ? ' data-run="' + esc(r.runId) + '"' : '') + '>' +
        '<button class="dlv-head" type="button" aria-expanded="false" aria-controls="dlv-more-' + i + '">' +
        '<span class="dlv-caret" aria-hidden="true">▸</span><span class="dlv-headmain"><span class="dlv-say">' + say2 + '</span>' +
        '<span class="dlv-facts">' + facts + '</span></span></button>' +
        '<div class="dlv-more" id="dlv-more-' + i + '" hidden>' + detailHtml(r) + '</div>' +
        '<div class="deliverable-preview" data-preview aria-live="polite"></div></article>';
    }

    /* The one-line answer to "what have I been working on", above everything else. Counts come from the server's
       pre-filter summary, so this describes the whole library even while a filter is narrowing the list below —
       and "needs a decision" is a real, clickable route to the only rows that are actually waiting on the user. */
    function renderSummary() {
      if (!summary) { head.innerHTML = ''; return; }
      const bits = [];
      bits.push('<b>' + summary.total + '</b> ' + (summary.total === 1 ? 'output' : 'outputs'));
      const nProjects = projects.filter(p => !p.unfiled).length;
      if (nProjects) bits.push('across <b>' + nProjects + '</b> ' + (nProjects === 1 ? 'project' : 'projects'));
      if (summary.newestAt) bits.push('newest <b>' + esc(agoOf(summary.newestAt, Date.now())) + '</b>');
      const pend = summary.pending
        ? '<button class="dlv-needs" data-status="pending">' + summary.pending + ' need' + (summary.pending === 1 ? 's' : '') + ' a decision</button>' : '';
      head.innerHTML = '<div class="dlv-sumline">' + bits.join(' · ') + '</div>' + pend;
    }

    // KIND chips — the second axis, after project. Counts are pre-filter for the same reason the rail's are.
    // the chip reads a plain plural (org pass 10-14, P13) — the raw kind word stays the filter value; an unknown kind reads in caps.
    // It covers every kind a row really carries: a run artifact's own kind too (runstore ARTIFACT_KINDS — the live walk read
    // 'FILE', because the mocked rows only ever said 'files'; the sidecar now files a run's 'file' under 'files')
    const KIND_LABEL = { files: 'FILES', file: 'FILES', image: 'IMAGES', message: 'MESSAGES', workflow: 'WORKFLOW JOBS', build: 'BUILDS', patch: 'CODE PATCHES', skill: 'SKILLS', report: 'REPORTS', damaged: 'DAMAGED RECORDS' };
    const kindLabel = k => KIND_LABEL[String(k || '').toLowerCase()] || String(k || '').toUpperCase();
    function renderKinds() {
      if (!kinds.length) { kindbar.innerHTML = ''; return; }
      const chip = (k, label, count) => '<button class="dlv-chip' + (kind === k ? ' on' : '') + '" data-kind="' + esc(k) + '">' + esc(label) + '<span>' + count + '</span></button>';
      kindbar.innerHTML = chip('', 'ALL KINDS', kinds.reduce((n, k) => n + k.count, 0)) + kinds.map(k => chip(k.kind, kindLabel(k.kind), k.count)).join('');
    }

    function render() {
      renderRail();
      renderSummary();
      renderKinds();
      if (!rows.length) {
        body.querySelector('#dl-clear-shown').hidden = true;   // nothing in view = nothing to clear
        // Say what MAKES a deliverable rather than just reporting absence — an empty library is the one moment
        // the window has to teach what it is for.
        // A filtered miss and an empty library are different facts and must not share a headline — "NOTHING HERE
        // YET" over a library that has 40 rows behind a filter is simply false.
        const filtered = !!(runFilter || project || kind || q.value || status.value);
        list.innerHTML = '<div class="dlv-empty">' + (filtered ? 'NO MATCHES.' : 'NOTHING HERE YET.') + '<br><span>' +
          (runFilter ? 'No recorded outputs from this step match this view. A completed run may have no files; use SHOW ALL WORK to return to the library.' : filtered ? 'Nothing in the library fits this view. Clear the filters to see everything.' : 'When a run creates or changes files, it lands here with the agent’s own name for it, the crew that worked on it, and the project it was for.') +
          '</span>' + (filtered && !runFilter ? '<div><button class="bb sm" data-clear-filters>CLEAR FILTERS</button></div>' : '') + '</div>';
        return;
      }
      const now = Date.now();
      const groups = {}, canClear = {};
      rows.forEach((r, i) => { const b = bucketOf(Number(r.createdAt) || 0, now); (groups[b] = groups[b] || []).push(cardHtml(r, i, now)); if (clearableRow(r)) canClear[b] = true; });
      // each time heading carries its own CLEAR — "I'm done with everything from before this week" is one click, not forty
      // (a heading over only undecided builds has nothing the server would clear, so it carries none)
      list.innerHTML = BUCKETS.filter(b => groups[b] && groups[b].length)
        .map(b => '<section class="dlv-bucket"><h4><span>' + b + '</span>' + (canClear[b] ? '<button type="button" class="dlv-bclear" data-bucket="' + b + '">CLEAR ' + b + '</button>' : '') + '</h4>' + groups[b].join('') + '</section>').join('');
      wireDiscards();
      wireClears();
    }
    /* CLEAR — "I'm done with these, get them out of my library". Library-only and undoable: the files stay on disk and the
       run log is untouched (POST /api/deliverables/clear hides the rows; UNDO brings them back). A bulk clear names its
       scope as the CURRENT VIEW's filter, so the server clears every matching row — not just the 500 this list shows.
       Rows that still need a decision are skipped by the server and the line says how many stayed. */
    const curFilter = () => ({ query: q.value, status: status.value, kind: kind, project: project });
    function bucketBounds(b) {
      const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
      const t = midnight.getTime(), week = t - 6 * DAY_MS;
      return b === 'TODAY' ? { after: t } : b === 'THIS WEEK' ? { after: week, before: t } : { before: week };
    }
    function sayUndo(text, token) {
      if (token) lastUndo = { text, token };   // a clear that took nothing leaves the earlier clear's UNDO standing
      msg.className = 'msg ok';
      msg.innerHTML = esc(text) + (token ? ' <button type="button" class="bb sm" data-undo-clear="' + esc(token) + '">UNDO</button>' : '');
    }
    async function clearRows(body, b) {
      if (b) b.disabled = true;
      try {
        const j = await post('/api/deliverables/clear', body);
        await load();
        const kept = j.skipped ? ' ' + j.skipped + (j.skipped === 1 ? ' still needs' : ' still need') + ' a decision and stayed.' : '';
        sayUndo(j.cleared
          ? 'Cleared ' + j.cleared + (j.cleared === 1 ? ' deliverable' : ' deliverables') + ' from the library. The files stay on disk.' + kept
          : (j.skipped ? 'Nothing cleared —' + kept.replace(/ and stayed\.$/, ': KEEP IT or DISCARD first.') : 'Nothing to clear here.'), j.cleared ? j.undoToken : '');
      } catch (e) { if (b) b.disabled = false; say('Could not clear: ' + e.message, true); }
    }
    // the count is what the clear will actually take (undecided builds stay), or no count when the page cannot prove it
    function clearShownLabel() {
      const filtered = !!(runFilter || project || kind || q.value || status.value);
      const n = runFilter ? rows.filter(clearableRow).length : clearable;
      return (filtered ? 'CLEAR THESE' : 'CLEAR ALL') + (n == null ? '' : ' ' + n);
    }
    /* What a clear of this view would take. A sidecar that sends its own count (clearable) is the answer. Otherwise only
       a count this page can prove: the complete list it was sent; a status filter (every match has that one status); or
       the unfiltered library, whose summary counts the same rows. A list cut short at 500 under any other filter has no
       provable count: null, and the label names none. */
    function provableClearable(j, sent, all) {
      if (typeof j.clearable === 'number' && isFinite(j.clearable)) return j.clearable;
      if (sent.length >= all) return sent.filter(clearableRow).length;
      if (status.value) return status.value === 'pending' ? 0 : all;
      const s = j.summary;
      if (!runFilter && !q.value && !project && !kind && s && Number(s.total) === all && isFinite(Number(s.pending))) return Math.max(0, all - Number(s.pending));
      return null;
    }
    function wireClears() {
      const shown = body.querySelector('#dl-clear-shown');
      shown.hidden = !rows.length || (runFilter ? !rows.some(clearableRow) : clearable === 0);
      if (shown.dataset.armed !== '1') shown.textContent = clearShownLabel();
      if (shown.dataset.wired !== '1' && typeof ArmConfirm !== 'undefined' && ArmConfirm.wire) {
        shown.dataset.wired = '1';
        ArmConfirm.wire(shown, {
          armedLabel: 'CLEAR THEM — SURE?',
          onArm: () => say('Clears every deliverable in this view out of the library (anything still waiting for a decision stays). The files stay on disk, and UNDO brings them back. Click again to confirm.'),
          onDisarm: () => { shown.textContent = clearShownLabel(); restoreMsg(); },
          onConfirm: () => clearRows(runFilter ? { ids: rows.map(r => r.id) } : { filter: curFilter() }, shown)
        });
      }
      shown.disabled = false;
      // the resting label names the real scope — the whole library, or the filtered view — with a count it can prove
      const label = clearShownLabel();
      if (shown.dataset.armed !== '1') shown.textContent = label;
      list.querySelectorAll('button.dlv-bclear').forEach(btn => {
        if (typeof ArmConfirm === 'undefined' || !ArmConfirm.wire) return;
        const bucket = btn.dataset.bucket;
        ArmConfirm.wire(btn, {
          armedLabel: 'CLEAR ' + bucket + ' — SURE?',
          onArm: () => say('Clears everything under ' + bucket + ' in this view out of the library. The files stay on disk, and UNDO brings them back. Click again to confirm.'),
          onDisarm: restoreMsg,
          onConfirm: () => {
            const now = Date.now();
            return clearRows(runFilter ? { ids: rows.filter(r => bucketOf(Number(r.createdAt) || 0, now) === bucket).map(r => r.id) }
              : { filter: Object.assign(curFilter(), bucketBounds(bucket)) }, btn);
          }
        });
      });
    }
    // UNDO lives in the message line; it outlives a re-render because the line is outside the list
    msg.addEventListener('click', async ev => {
      const b = ev.target.closest && ev.target.closest('button[data-undo-clear]'); if (!b) return;
      b.disabled = true;
      try { const u = await post('/api/deliverables/clear-undo', { undoToken: b.dataset.undoClear }); lastUndo = null; await load(); say('Brought back ' + u.restored + (u.restored === 1 ? ' deliverable.' : ' deliverables.')); }
      catch (e) {
        if (e.status === 404) lastUndo = null;   // the server no longer holds that clear (aged out, or used elsewhere): never offer it again
        b.disabled = false; say(e.message, true);
      }
    });
    // Re-wired after every render: innerHTML replaces the buttons, so the previous listeners die with the
    // old nodes and there is nothing to dispose. If armconfirm.js somehow did not load, the buttons stay
    // unwired and the delegated handler discards on a single click — we do NOT fork a fourth hand-rolled
    // copy of the arm/confirm idiom here, which is the thing that helper was extracted to prevent.
    function wireDiscards() {
      if (typeof ArmConfirm === 'undefined' || !ArmConfirm.wire) return;
      list.querySelectorAll('button[data-act="discard"]').forEach(b => {
        // ONCE per node: toggleCard() re-calls this without a re-render, and ArmConfirm.wire ADDS a fresh
        // click listener with its own private `armed` flag each time — double-wired, one confirm click ran
        // onConfirm TWICE (two irreversible workshop deletes; N open drawers = N+1). The wired stamp was
        // written but never read; it is the guard now.
        if (b.dataset.wired === '1') return;
        const r = rows[Number(b.closest('[data-i]').dataset.i)];
        if (!r) return;
        b.dataset.wired = '1';
        ArmConfirm.wire(b, {
          armedLabel: 'DISCARD — SURE?',
          onArm: () => say('Discarding “' + (r.title || 'this output') + '” also removes its Workshop files permanently. Click again to confirm.', true),
          onDisarm: restoreMsg,   // disarming just clears the warning (the last clear's UNDO comes back); it is not an excuse to restate the count
          onConfirm: () => decide(r, 'discard', b)
        });
      });
    }
    async function load() {
      const seq = ++loadSeq; say('Loading…');
      const url = '/api/deliverables?query=' + encodeURIComponent(runFilter ? runFilter.runId : q.value) + '&status=' + encodeURIComponent(status.value) + '&project=' + encodeURIComponent(project) + '&kind=' + encodeURIComponent(kind);
      try {
        const j = await fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
        if (seq !== loadSeq) return;
        rows = j.items || [];
        total = Number(j.total) || rows.length;   // the FULL match count — the list itself ships at most 500
        clearable = provableClearable(j, rows, total);   // before the run narrowing below: the server's view, not the run's
        // The backend's text search narrows the request; equality supplies the actual provenance boundary.
        if (runFilter) rows = rowsForRun(rows, runFilter.runId, q.value);
        projects = Array.isArray(j.projects) ? j.projects : [];   // an older sidecar simply sends none -> rail shows ALL WORK only
        kinds = Array.isArray(j.kinds) ? j.kinds : [];
        summary = j.summary || null;
        render();
        // The summary strip above already states the count. This line is for TRANSIENT status only — loading,
        // errors, and the result of an action — so a second standing count does not sit under it saying the
        // same number in different words. (The last clear's UNDO is an action result: it stays.)
        restoreMsg();
      }
      catch (e) { say('Could not load the library: ' + e.message, true); }
    }
    // DISCARD is irreversible (it deletes the Workshop files), so it asks — but with the station's own
    // 2-step arm/confirm, never `window.confirm`. A native dialog is OS chrome painted over the phosphor
    // terminal, which is exactly what armconfirm.js exists to stop ("no native dialogs inside the phosphor
    // terminal"). The permanence sentence the dialog used to carry moves into the live message line on arm,
    // so nothing is claimed less loudly than before — it is just said in the station's voice.
    async function decide(r, act, b) {
      if (b.disabled) return;   // belt to the once-wiring: a second confirm on an in-flight decide is never a second POST
      b.disabled = true;
      try { const j = await post('/api/workshop/decide', { agentId: r.agentId, runId: r.runId, decision: act }); lastUndo = null; if (typeof NeedsYou !== 'undefined' && NeedsYou.refreshFeeds) NeedsYou.refreshFeeds(true); say(j.decision === 'keep' ? ('Kept ' + r.title + (j.destPath ? ' in ' + j.destPath : '')) : ('Discarded ' + r.title)); await load(); }
      catch (e) { b.disabled = false; say(e.message, true); }
    }
    /* ONE DRAWER OPEN AT A TIME — the same rule the OUTBOX accordion follows. Two open drawers turn a scannable
       list back into the wall of text this window exists to replace. Toggling closed also clears any preview the
       drawer painted, so a collapsed card never leaves a stray file rendered under it. */
    function toggleCard(headBtn) {
      const card = headBtn.closest('[data-i]');
      const more = card && card.querySelector('.dlv-more');
      if (!more) return;
      const wasOpen = !more.hidden;
      list.querySelectorAll('.dlv-more').forEach(d => { d.hidden = true; });
      list.querySelectorAll('.dlv-head').forEach(h => { h.setAttribute('aria-expanded', 'false'); h.classList.remove('on'); });
      list.querySelectorAll('[data-preview]').forEach(p => { p.innerHTML = ''; });
      revoke();
      if (!wasOpen) {
        more.hidden = false;
        headBtn.setAttribute('aria-expanded', 'true');
        headBtn.classList.add('on');
        wireDiscards();   // the drawer's DISCARD only exists once it is open
        wireLocations(card);
        proseSaid(more, rows[Number(card.dataset.i)]);
      }
    }
    /* FIND IT ON DISK (org pass 10-14, P24): each FILES row gets the COMMS '▤ saved' row's own keys — folder (desktop reveals
       the file, a browser copies its path) and, on desktop, copy path. The full path rides the key's tip, never printed on the
       card (Andrew cut a printed path); when the file provably sits outside this item's project, the tip says so first. */
    function wireLocations(card) {
      if (typeof Chat === 'undefined' || !Chat.folderButton || !Chat.copyPathButton) return;
      const r = rows[Number(card.dataset.i)]; if (!r) return;
      card.querySelectorAll('.dlv-floc[data-floc]').forEach(slot => {
        if (slot.dataset.wired === '1') return;
        const f = r.files && r.files[Number(slot.dataset.floc)];
        const loc = f && savedLocation(r, f, r.project || '');
        if (!loc) return;
        slot.dataset.wired = '1';
        // a browser cannot reveal a folder, so its one key is the COMMS copy-path key itself (its own ⧉ glyph — the folder glyph
        // belongs to the desktop key that really opens the folder)
        const keys = [tauriCore() ? Chat.folderButton(loc.agentId, loc.path) : Chat.copyPathButton(loc.agentId, loc.path)];
        if (tauriCore()) keys.push(Chat.copyPathButton(loc.agentId, loc.path));
        // each tip line reads as a sentence, like the window's other key tips ('Copy the full saved path.') — P24 polish 2
        const sentence = t => { const v = String(t || '').trim(); return v ? v.charAt(0).toUpperCase() + v.slice(1) + (/[.!?…]$/.test(v) ? '' : '.') : ''; };
        let lead = sentence(outsideNote(loc, r.project, agentLabel(loc.agentId), '')), shown = loc.path;
        /* ICON KEYS (org pass 10-14, P24 polish): the row's width belongs to the file NAME — labelled keys squeezed it to nothing.
           Each key is its glyph alone at the row's end; what it does rides its tip and aria-label, and its feedback word
           ('path copied', 'opened', 'no path') still shows on the key while it lasts (.fb-live). */
        const verbs = keys.map(k => sentence(k.getAttribute('title') || ''));
        /* the tip is a PATH card (data-tip-path → tooltip.js widens it and keeps these line breaks): what the key does, the
           outside-the-project note, then the path on lines of its own — breaking only after a folder separator, never mid-name */
        const breakable = p => String(p || '').replace(/([\\/])(?=.)/g, '$1\u200b');
        const tip = p => { shown = p; keys.forEach((k, ki) => { k.removeAttribute('title'); k.setAttribute('data-tip-path', ''); k.setAttribute('data-tip', [verbs[ki], lead, breakable(p)].filter(Boolean).join('\n')); }); };
        keys.forEach((k, ki) => {
          k.classList.add('bb', 'sm', 'dlv-loc-key');
          if (verbs[ki]) k.setAttribute('aria-label', verbs[ki]);
          const lbl = k.querySelector && k.querySelector('.fb-label');
          if (lbl && typeof MutationObserver !== 'undefined') new MutationObserver(() => k.classList.toggle('fb-live', lbl.textContent !== k.getAttribute('data-default-label'))).observe(lbl, { childList: true, characterData: true, subtree: true });
          slot.appendChild(k);
        });
        tip(loc.path);
        if (Chat.fullSavedPath) Promise.resolve(Chat.fullSavedPath(loc.agentId, loc.path)).then(full => { if (full) tip(full); }, () => tip(loc.path));
        // an absolute path outside the project: the workspace wording only once the agent's real workspace root proves it holds the file
        if (Chat.fullSavedPath && loc.inProject === false && loc.inWorkspace == null) Promise.resolve(Chat.fullSavedPath(loc.agentId, '')).then(root => {
          const proven = sentence(outsideNote(loc, r.project, agentLabel(loc.agentId), root));
          if (proven !== lead) { lead = proven; tip(shown); }
        }, () => {});
      });
    }
    /* ONE READING OF AN ANSWER (walk 10-14): WHAT CAME BACK is drawn by COMMS' own renderer (Chat.renderProse — escape-first;
       lists, code blocks, tables), exactly as TO REVIEW above it, WORKFLOWS and the Workflow panel draw the same reply — once,
       when the drawer first opens. The safe-markdown HTML stays where COMMS' renderer is not loaded. */
    function proseSaid(more, r) {
      const said = more.querySelector('.dlv-said');
      const text = r ? ((r.run && r.run.deliveryText) || r.output || '') : '';
      if (!said || said.__prose || !text || typeof Chat === 'undefined' || !Chat.renderProse) return;
      said.__prose = true;
      said.classList.add('wf-md');
      // its file links and images open where THIS run put them — the row's agent, at the root its run record ran with (r.run) —
      // never the agent open in COMMS (renderProse's default with no refs), so they agree with the FILES section beside them
      const files = Chat.workspaceFileRefs ? Chat.workspaceFileRefs(String(r.agentId || 'agent'), null, (r.run && r.run.projectRoot) || undefined) : undefined;
      Chat.renderProse(said, text, files ? { files } : undefined);
    }

    list.addEventListener('click', async ev => {
      if (ev.target.closest('button[data-clear-filters]')) {
        clearTimeout(debounce);
        q.value = ''; status.value = ''; project = ''; kind = '';
        q.focus();
        return load();
      }
      const fileLink = ev.target.closest('a[data-file]');
      if (fileLink) return handleOpenClick(ev, rows, openState, say);
      const headBtn = ev.target.closest('.dlv-head');
      if (headBtn) return toggleCard(headBtn);
      const b = ev.target.closest('button[data-act]'); if (!b) return; const card = b.closest('[data-i]'), r = rows[Number(card.dataset.i)]; if (!r) return;
      // "open the session this came from" — the run's real workstream, via the same seam the OUTBOX uses.
      if (b.dataset.act === 'session') {
        const sid = r.run && r.run.streamId;
        if (!sid) return say('That run did not record a session to open.', true);
        // #87: a workflow step's or routine's stream is not in the COMMS rail yet, and App.openWorkstream
        // silently no-ops on an id it doesn't know. ReturnStore.openWork adopts the stream and folds in its
        // durable transcript first (the OUTBOX's ↗ OPEN seam), and says false when it truly can't be read.
        b.disabled = true;
        let ok = false;
        try {
          if (typeof ReturnStore !== 'undefined' && ReturnStore.openWork) {
            ok = await ReturnStore.openWork({ runId: r.runId || sid, streamId: sid, agentId: r.agentId || 'agent', title: r.title || '' });
          } else if (typeof App !== 'undefined' && App && typeof App.openWorkstream === 'function' && typeof Workstreams !== 'undefined' && Workstreams.get(sid)) {
            App.openWorkstream(sid); ok = true;
          }
        } catch (_) { ok = false; }
        b.disabled = false;
        if (!ok) return say('Could not read that conversation — its transcript is not on the station any more.', true);
        if (typeof StationUI !== 'undefined') StationUI.h.workConversation('deliverables');
        return;
      }
      // a WORKFLOW job's row opens its own record in WORKFLOWS (its line, its steps, NEEDS CHANGES / SEND IT AGAIN)
      if (b.dataset.act === 'workflow') {
        if (typeof WorkflowsWindow === 'undefined' || !WorkflowsWindow.open || !WorkflowsWindow.showJob) return say('The WORKFLOWS window is not available here.', true);
        WorkflowsWindow.open({ view: 'line', line: r.line, job: null }, 'deliverables');
        WorkflowsWindow.showJob(r.jobId);
        return;
      }
      if (b.dataset.act === 'clear') return clearRows({ ids: [r.id] }, b);   // one card: no arm — UNDO is right there
      if (b.dataset.act === 'discard' && b.dataset.wired === '1') return;   // its own ArmConfirm listener owns it
      decide(r, b.dataset.act, b);
    });
    rail.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-project]'); if (!b) return;
      project = b.dataset.project || '';
      renderRail();   // paint the selection immediately; the list follows when the fetch lands
      load();
    });
    kindbar.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-kind]'); if (!b) return;
      kind = b.dataset.kind || '';
      renderKinds();
      load();
    });
    // the summary's "N need a decision" is a route, not a label — it drives the real status filter
    head.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-status]'); if (!b) return;
      status.value = b.dataset.status || '';
      load();
    });
    let debounce = 0; q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 180); }); status.addEventListener('change', load); body.querySelector('#dl-refresh').addEventListener('click', load);
    const tools = body.querySelector('#dl-tools');
    if (tools && tools.addEventListener) tools.addEventListener('toggle', () => { const c = tools.querySelector('.dlv-tools-car'); if (c) c.textContent = tools.open ? '▾' : '▸'; });
    body.querySelector('#dl-clean').addEventListener('click', async () => {
      try { const p = await post('/api/deliverables/cleanup-preview', { statuses: ['discarded', 'failed'] }); cleanup.innerHTML = '<div class="cfg-block"><b>CLEANUP PREVIEW</b><p>' + p.targets.length + ' discarded/failed lifecycle record(s) will be removed. ' + p.protected.length + ' pending, kept, or produced record(s) are protected. Files are not deleted.</p>' + (p.targets.length ? '<details class="dlv-clean-list"><summary>SEE THE ' + p.targets.length + ' RECORD' + (p.targets.length === 1 ? '' : 'S') + '</summary><ul>' + p.targets.map(r => '<li>' + esc(r.title) + ' · ' + esc(r.status) + ' · ' + esc(r.runId || r.id) + '</li>').join('') + '</ul></details>' : '') + '<div class="row dlv-acts"><button class="bb sm danger" id="dl-clean-apply" ' + (p.targets.length ? '' : 'disabled') + '>REMOVE EXACTLY THESE ' + p.targets.length + ' RECORDS</button><button class="bb sm" id="dl-clean-cancel">CANCEL</button></div></div>'; cleanup.querySelector('#dl-clean-cancel').addEventListener('click', () => { cleanup.innerHTML = ''; }); const apply = cleanup.querySelector('#dl-clean-apply'); if (apply) apply.addEventListener('click', async () => { try { const c = await post('/api/deliverables/cleanup', { statuses: p.statuses, fingerprint: p.fingerprint }); cleanup.innerHTML = '<div class="msg ok">Removed ' + c.removed + ' record(s). <button class="bb sm" id="dl-undo">UNDO</button></div>'; cleanup.querySelector('#dl-undo').addEventListener('click', async () => { const u = await post('/api/deliverables/cleanup-undo', { undoToken: c.undoToken }); say('Restored ' + u.restored + ' record(s).'); cleanup.innerHTML = ''; await load(); }); await load(); } catch (e) { say(e.message, true); } }); }
      catch (e) { say('Could not preview cleanup: ' + e.message, true); }
    });
    body._deliverablesCleanup = revoke;
    load();
  }
  function showStatus(body, st) {
    if (!body || typeof body._deliverablesShowStatus !== 'function') return false;
    body._deliverablesShowStatus(st); return true;
  }
  function showRun(body, runId, label) {
    if (!runId || !body || typeof body._deliverablesShowRun !== 'function') return false;
    body._deliverablesShowRun(runId, label); return true;
  }
  return { esc, safeMarkdown, plainLine, safeCsv, openUrl, fileHref, artifactPath, savedLocation, outsideNote, handleOpenClick, bucketOf, pillOf, agentLabel, agoOf, fmtSize, mount, showRun, showStatus, rowsForRun, BUCKETS };
});
