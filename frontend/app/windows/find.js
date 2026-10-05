/* STARNET — windows/find.js : FIND (Ctrl+K) — one search for every place, agent and conversation in the station.

   WHY (Andrew 2026-10-04: "WAAY easier to use and navigate"): StarNet has ~50 places behind a dock, menus, tabs and
   console rails, and the only searches lived INSIDE single windows. FIND searches all of it from one field and opens the
   result through the SAME door its button uses — Places.open (app/places.js), the opener the agent's station.show uses —
   so FIND, the agent and the manual can never name different places. No match is never a dead end: the last row hands
   the words to the crew in COMMS (typed in, not sent — the Commander presses Enter).

   A station window like every other (WINDOWS DOCK FROM THE BOTTOM law): registered here, opened from SYSTEM › FIND or
   Ctrl+K, never a centred popup. Material: the Workflow-window glass (css/find-window.css). */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow || typeof Places === 'undefined') return;
  const esc = StationUI.h.esc;
  let query = '';
  let sel = 0;
  let rows = [];

  // agent places, per crew member: "NOVA › CONFIG" (the dossier tabs + the desk)
  const AGENT_TABS = Places.PLACES.filter(p => Places.needsAgent(p));
  const tabWord = p => p.open.desk ? 'DESK' : p.words.split(' › ').pop();

  function entries() {
    const out = [];
    for (const p of Places.PLACES) if (!Places.needsAgent(p)) out.push({ kind: 'place', place: p, name: p.words, line: p.about, hay: (p.words + ' ' + p.about + ' ' + p.id).toLowerCase() });
    const crew = (typeof App !== 'undefined' && App.agents && App.agents()) || [];
    for (const a of crew) {
      if (!a || !a.id) continue;
      const nm = String(a.name || a.id).toUpperCase();
      for (const p of AGENT_TABS) {
        out.push({ kind: 'agent', place: p, agentId: a.id, name: nm + ' › ' + tabWord(p), line: p.about.replace(/^an agent's /, nm + '\'s '),
          hay: (nm + ' ' + (a.role || '') + ' ' + p.words + ' ' + p.about + ' agent crew').toLowerCase(), first: p.open.agent === 'brief' });
      }
    }
    const ws = (typeof Workstreams !== 'undefined' && Workstreams.list) ? (Workstreams.list() || []) : [];
    const gid = (typeof Workstreams !== 'undefined' && Workstreams.generalId) ? Workstreams.generalId() : null;
    for (const w of ws) {
      if (!w || w.archived || w.kind === 'task') continue;
      const title = w.title != null ? w.title : (w.id === gid ? 'General' : null);
      if (!title) continue;
      out.push({ kind: 'session', ws: w.id, name: 'COMMS › ' + title, line: w.conversationMode === 'group' ? 'a group chat' : 'a conversation', hay: (title + ' comms session chat conversation').toLowerCase() });
    }
    return out;
  }

  // every word must appear; a name that starts with the query ranks first, then a word in the name, then anywhere
  function search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = entries();
    if (!words.length) return all.filter(e => e.kind === 'place' || (e.kind === 'agent' && e.first));
    const scored = [];
    for (const e of all) {
      if (!words.every(w => e.hay.indexOf(w) >= 0)) continue;
      const nm = e.name.toLowerCase();
      const score = (nm.indexOf(words[0]) === 0 ? 0 : words.every(w => nm.indexOf(w) >= 0) ? 1 : 2) + (e.kind === 'session' ? 0.5 : 0);
      scored.push([score, e]);
    }
    return scored.sort((a, b) => a[0] - b[0]).map(x => x[1]);
  }

  function rowHtml(e, i) {
    const glyph = e.kind === 'agent' ? '◉' : e.kind === 'session' ? '▸' : e.kind === 'ask' ? '›' : '▤';
    return '<button type="button" class="fnd-row' + (i === sel ? ' on' : '') + (e.kind === 'ask' ? ' fnd-ask' : '') + '" role="option" aria-selected="' + (i === sel) + '" data-i="' + i + '">'
      + '<span class="fnd-g" aria-hidden="true">' + glyph + '</span>'
      + '<span class="fnd-t"><b class="fnd-n">' + esc(e.name) + '</b><span class="fnd-l">' + esc(e.line) + '</span></span></button>';
  }

  function paint(body) {
    const list = body.querySelector('.fnd-list');
    if (!list) return;
    rows = search(query);
    if (query.trim()) rows.push({ kind: 'ask', name: 'ASK THE CREW', line: '“' + query.trim().slice(0, 120) + '” — typed into COMMS for you to send' });
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    list.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<p class="fnd-empty">nothing on the station yet</p>';
    const count = body.querySelector('.fnd-count');
    if (count) count.textContent = query.trim() ? (rows.length - 1) + ' found' : rows.length + ' places';
    const on = list.querySelector('.fnd-row.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  async function go(e) {
    if (!e) return;
    StationUI.closeTerm('find');
    try {
      if (e.kind === 'session') { if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(e.ws); return; }
      if (e.kind === 'ask') {
        if (typeof Chat !== 'undefined' && Chat.prefill) Chat.prefill(query.trim());
        const input = document.getElementById('chat-input'); if (input) input.focus();
        return;
      }
      const out = await Places.open(e.place, { ui: StationUI, agentId: e.agentId,
        build: typeof Build !== 'undefined' ? Build : null, app: typeof App !== 'undefined' ? App : null, market: typeof Marketplace !== 'undefined' ? Marketplace : null });
      if (!out || !out.open) StationUI.notify(e.name + ' could not open right now', 'warn');
    } catch (err) { StationUI.notify(String((err && err.message) || err), 'warn'); }
  }

  function build(body) {
    body.innerHTML = '<div class="fnd">'
      + '<div class="fnd-head"><input class="fnd-field" type="search" autocomplete="off" spellcheck="false" placeholder="find a window, an agent, a setting, a conversation…" aria-label="Find anything on the station" aria-controls="fnd-list">'
      + '<span class="fnd-count" aria-live="polite"></span></div>'
      + '<div class="fnd-list" id="fnd-list" role="listbox" aria-label="Results"></div>'
      + '<p class="fnd-keys">↑ ↓ to move · Enter to open · Ctrl+K from anywhere</p></div>';
    const field = body.querySelector('.fnd-field');
    field.value = query;
    field.addEventListener('input', () => { query = field.value; sel = 0; paint(body); });
    field.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); paint(body); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(0, sel - 1); paint(body); }
      else if (ev.key === 'Enter') { ev.preventDefault(); go(rows[sel]); }
    });
    body.querySelector('.fnd-list').addEventListener('click', ev => {
      const b = ev.target && ev.target.closest && ev.target.closest('.fnd-row');
      if (b) go(rows[Number(b.dataset.i)]);
    });
    paint(body);
    setTimeout(() => { try { field.focus(); field.select(); } catch (_) {} }, 0);
  }

  StationUI.registerWindow('find', 'FIND', build, { className: 'find-win' });

  // Ctrl+K (⌘K) from anywhere: open FIND — or, when it is already showing, put the cursor back in its field
  document.addEventListener('keydown', ev => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || !(ev.key === 'k' || ev.key === 'K')) return;
    ev.preventDefault();
    const out = StationUI.showTerm('find');
    const field = document.querySelector('.find-win .fnd-field');
    if (out && out.open && field) { field.focus(); field.select(); }
  });
})();
