/* Group DM UI: backend-owned membership, dispatch and transcript; direct COMMS stays intact. */
'use strict';
const GroupChat = (() => {
  let active = null, group = null, root, timer, busy = false, replyTo = null, roster = [], selected = [];
  let generation = 0, lastPaint = '', notice = '', draftKey = null;
  let openedFileUrl = null, openedFile = null;
  // the ADD AGENTS window: which session it edits, and its repaint (so a member who joins by @mention shows in it)
  let pickerFor = null, pickerRepaint = null;
  // the @ menu over the composer: its rows, the highlighted one, and the "@que" being typed
  let mentionItems = [], mentionSel = 0, mentionCtx = null, mentionBusy = false;
  let basePlaceholder = null;
  const composerDrafts = new Map();
  const inspectOpen = new Set();   // approval promptIds whose INSPECT panel the Commander opened (survives a re-render)
  const sharedAttachments = new Map();
  const $ = id => document.getElementById(id);
  const uid = () => crypto.randomUUID();
  const h = (tag, attrs = {}, value) => {
    const e = document.createElement(tag);
    for (const [key, v] of Object.entries(attrs)) { if (key.startsWith('on')) e.addEventListener(key.slice(2), v); else if (key === 'class') e.className = v; else e.setAttribute(key, v); }
    if (value != null) e.textContent = value;
    return e;
  };
  const button = (label, fn) => h('button', { type: 'button', class: 'bb', onclick: () => Promise.resolve().then(fn).catch(showError) }, label);
  function showError(e) {
    notice = e.message || String(e); if ($('gc-notice')) $('gc-notice').textContent = notice;
    // a direct chat has no group notice line on screen: say it where the Commander is looking
    if (active?.conversationMode !== 'group' && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(notice, 'bad');
  }
  async function api(body, query = '') {
    const r = await fetch('/api/groups' + query, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    if (r.status === 401 || r.status === 403) throw new Error('Reconnect to this station by refreshing the page. Your conversation is saved.');
    if (r.status === 404 && !body && !query) throw new Error('Group chat is unavailable on this server. Run the current StarNet backend, then try again.');
    let out;
    try { out = await r.json(); } catch (_) { throw new Error('The server could not load group chat. Try again.'); }
    if (!r.ok || !out?.ok) throw new Error(out?.error || 'Group request failed'); return out.result;
  }
  function save() { if (typeof App !== 'undefined') { App.persist(); App.refreshRail(); } }
  // Who sits in each group, as the backend last reported it. The rail's per-agent view lists a group
  // under EVERY member, so it reads this instead of the workstream's single agentId (the lead).
  const membersById = new Map();
  function adopt(g) {
    if (g && Array.isArray(g.members)) {
      const before = membersById.get(g.id), next = g.members.slice();
      membersById.set(g.id, next);
      // a member joined or left: whoever's sessions the rail is showing must gain (or lose) this group now, not
      // after a reload. Deferred so the record below is updated first; unchanged members never repaint.
      if (before && before.join('\n') !== next.join('\n') && typeof App !== 'undefined' && App.refreshRail) queueMicrotask(() => App.refreshRail());
    }
    let ws = Workstreams.get(g.id) || Workstreams.adopt({ id: g.id, title: g.title, agentId: g.leadId, kind: 'chat', conversationMode: 'group', lane: 'active' });
    if (ws) {
      ws.conversationMode = 'group'; ws.agentId = g.leadId; ws.title = g.title;
      if (g.messages) {
        ws.history = g.messages.map(m => ({ role: m.author === 'user' ? 'user' : 'assistant', agentId: m.author === 'user' ? undefined : m.author, content: m.content, ts: m.at, ...(m.artifactIds?.length ? { artifactIds: m.artifactIds.slice() } : {}) }));
        ws.runIds = g.turns.filter(t => t.runId).map(t => t.runId);
        ws.lastActiveAt = g.updatedAt;
      }
    }
    return ws;
  }
  // the live crew: the station registry first (it is what CREW shows), the backend's roster as the fallback
  function crew() {
    const live = typeof App !== 'undefined' && App.agents ? (App.agents() || []) : [];
    const list = live.length ? live : roster;
    return list.filter(a => a && a.id).map(a => ({ id: a.id, name: String(a.name || a.id) }));
  }
  function name(id) { return id === 'user' ? 'COMMANDER' : (roster.find(a => a.id === id)?.name || App.agents?.().find(a => a.id === id)?.name || id); }
  function colorOf(id) { const c = typeof App !== 'undefined' && App.agents ? App.agents().find(a => a.id === id)?.color : ''; return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : ''; }
  /* The group header: a [ GROUP ] tag, then EVERY member by name in their roster colour (lead first), the count, and
     the + key. Names wrap to a second line before anything is hidden; past two lines the rest fold into "+N", which
     opens the full list (Andrew 10-04: "you cant even tell when the groupchat is there, it does not show all the agents"). */
  function participantsHeader(element, ids, paused, leadId) {
    const order = leadId && ids.includes(leadId) ? [leadId, ...ids.filter(id => id !== leadId)] : ids.slice();
    const people = h('button', { type: 'button', class: 'gc-people', title: order.map(name).join(' · '), 'aria-label': 'Agents in this chat: ' + order.map(name).join(', ') + '. Add or remove agents', onclick: () => picker(true) });
    for (const id of order) {
      const p = h('span', { class: 'gc-person' + (id === leadId ? ' lead' : '') }, name(id));
      const c = colorOf(id); if (c) p.style.color = c;
      people.append(p);
    }
    const more = h('span', { class: 'gc-more', hidden: '' }); people.append(more);
    element.replaceChildren(h('span', { class: 'gc-badge', 'aria-hidden': 'true' }, 'GROUP'), people, h('span', { class: 'gc-count' }, ids.length + (ids.length === 1 ? ' agent' : ' agents')));
    if (paused) element.append(h('small', {}, 'Paused'));
    fitPeople(people);
  }
  // two lines of names at most: hide from the end until it fits, and say how many are folded away
  function fitPeople(people) {
    if (!people || typeof people.querySelectorAll !== 'function' || !people.isConnected) return;
    const persons = [...people.querySelectorAll('.gc-person')], more = people.querySelector('.gc-more');
    for (const p of persons) p.hidden = false;
    if (more) more.hidden = true;
    let hidden = 0;
    while (people.scrollHeight > people.clientHeight + 1 && hidden < persons.length - 1) {
      persons[persons.length - 1 - hidden].hidden = true; hidden++;
      if (more) { more.hidden = false; more.textContent = '+' + hidden; }
    }
  }
  /* Per-row description for the picker: the class tagline when the agent was recruited from the
     catalog, otherwise its role. Never invented — blank beats a made-up job title. */
  function describe(id) {
    const a = typeof App !== 'undefined' && App.agents ? App.agents().find(x => x.id === id) : null; if (!a) return '';
    const spec = a.specialtyId && typeof Specialties !== 'undefined' && Specialties.get ? Specialties.get(a.specialtyId) : null;
    return spec?.tagline || (a.role === 'overseer' || id === 'agent' ? 'the overseer' : a.role || '');
  }
  function init() {
    if (root) return;
    const bar = $('comms-idbar'); if (!bar) return;
    root = h('section', { id: 'group-chat', 'aria-label': 'Group conversation', hidden: '' });
    const header = h('div', { id: 'gc-header', class: 'gc-header', hidden: '' });
    const addAgents = button('+ Add agents', () => picker(true)); addAgents.id = 'gc-add-agents';
    bar.append(header, addAgents);
    const files = h('div', { class: 'gc-files' }); files.append(h('div', { id: 'gc-files' }), h('div', { id: 'gc-preview' }));
    const transcript = h('div', { id: 'gc-log', role: 'log', 'aria-label': 'Group messages', 'aria-live': 'polite', class: 'scrolly' });
    const questions = h('div', { id: 'gc-questions' });
    const states = h('div', { id: 'gc-states', 'aria-live': 'polite' });
    const recipient = h('div', { id: 'gc-recipients' });
    // the @ menu is the COMPOSER's, not the group's: it sits over the message box in a direct chat too, so
    // "@finn" works from any chat (a direct chat becomes a group the moment a second agent is picked)
    const mentions = h('div', { id: 'gc-mentions', role: 'listbox', 'aria-label': 'Mention an agent' });
    $('chat-input').addEventListener('input', () => { draftKey = null; autocomplete(); });
    $('chat-input').addEventListener('blur', () => setTimeout(() => { if (!mentionBusy && document.activeElement !== $('chat-input') && !$('gc-mentions')?.contains?.(document.activeElement)) closeMentions(); }, 150));
    root.append(transcript, files, questions, states, recipient, h('div', { id: 'gc-notice', role: 'status' }));
    $('chat-log').before(root);
    const row = $('chat-inputrow'); if (row) row.before(mentions); else root.append(mentions);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitPeople($('gc-header')?.querySelector?.('.gc-people'))).observe(header);
    const css = h('style'); css.textContent = `
      #group-chat{position:relative;display:flex;flex:1 1 0;min-width:0;min-height:0;flex-direction:column;overflow:hidden;color:var(--text);background:transparent;padding:0;gap:0}
      #group-chat[hidden],#gc-header[hidden],#group-chat .gc-files[hidden]{display:none}
      #comms-idbar{flex:0 0 auto;flex-wrap:nowrap}#comms-idbar.gc-group>.comms-agent-wrap,#comms-idbar.gc-group>#comms-agent-model,#chat-panel #comms-idbar.gc-group>.comms-identity,#chat-panel #comms-idbar.gc-group>.comms-portrait{display:none}
      #gc-header{display:flex;align-items:center;gap:10px;flex:1;min-width:0;color:var(--ph)}
      .gc-badge{flex:0 0 auto;align-self:center;font-size:12px;line-height:18px;letter-spacing:1.5px;color:var(--ph-bright);text-shadow:var(--pg-glow-soft,none);white-space:nowrap}
      .gc-badge::before{content:'[ ';opacity:.6}.gc-badge::after{content:' ]';opacity:.6}
      .gc-count{order:2;flex:0 0 auto;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim);white-space:nowrap}
      #gc-add-agents{flex:0 0 auto;white-space:nowrap}
      .gc-people{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px;row-gap:2px;flex:1 1 0;min-width:0;max-height:38px;overflow:hidden;margin:0;padding:0;border:0;background:none;font:inherit;text-align:left;cursor:pointer;color:var(--ph)}
      .gc-person{display:inline-block;font-size:15px;line-height:18px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-bright);white-space:nowrap;text-shadow:var(--pg-glow-soft,none)}.gc-person[hidden],.gc-more[hidden]{display:none}
      .gc-more{display:inline-block;font-size:13px;line-height:18px;letter-spacing:1px;color:var(--ph)}
      .gc-people:hover .gc-person,.gc-people:hover .gc-more{text-decoration:underline;text-underline-offset:3px}
      #group-chat .bb,#gc-add-agents{margin:0;padding:3px 8px;min-height:26px;font-size:13px;line-height:18px;letter-spacing:1px;border:1px solid var(--ph-faint);border-radius:3px;background:var(--panel2);color:var(--ph);box-shadow:var(--raise)}
      #group-chat .bb:hover,#gc-add-agents:hover{border-color:var(--ph);background:var(--ph-faint)}
      #group-chat :focus-visible,.gc-picker :focus-visible{outline:1px solid var(--ph);outline-offset:2px}
      #gc-log{flex:1 1 0;min-height:0;min-width:0;overflow:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px;background:transparent;user-select:text;scrollbar-color:var(--ph-dim) transparent}
      #gc-log>.gc-message{flex:0 0 auto;margin:0;overflow-wrap:anywhere;white-space:normal}#gc-log .body{margin:0}
      body #chat-panel #gc-log .gc-message.agent .who{color:var(--gc-c,var(--ph))}
      #gc-log .gc-message .who.gc-who{cursor:pointer;user-select:none;border:0;background:none;padding:0;font:inherit;text-transform:uppercase;text-align:left;width:auto;min-height:0;box-shadow:none}
      #gc-log .gc-message .who.gc-who:hover{color:var(--ph-bright)}
      #gc-log .gc-message .who.gc-who::after{content:' @';opacity:0;font-size:11px;letter-spacing:0;transition:opacity .12s}#gc-log .gc-message .who.gc-who:hover::after{opacity:.8}
      body #chat-panel #gc-log>.gc-message.cmsg.agent:not(.tool):not(.consent):not(.turnin):not(.nudge):not(.deliverable)+.gc-message.cmsg.agent:not(.tool):not(.consent):not(.turnin):not(.nudge):not(.deliverable):not(.gc-cont){margin-top:6px}
      body #chat-panel #gc-log>.gc-message.cmsg.agent:not(.tool):not(.consent):not(.turnin):not(.nudge):not(.deliverable)+.gc-message.cmsg.agent:not(.tool):not(.consent):not(.turnin):not(.nudge):not(.deliverable):not(.gc-cont)>.cmsg-head{display:flex;justify-content:flex-start;margin:0 2px 4px}
      body #chat-panel #gc-log>.gc-message.cmsg.agent:not(.tool):not(.consent):not(.turnin):not(.nudge):not(.deliverable)+.gc-message.cmsg.agent:not(.tool):not(.consent):not(.turnin):not(.nudge):not(.deliverable):not(.gc-cont)>.cmsg-head>.who{display:inline-block}
      #gc-log>.gc-masthead{flex:0 0 auto}#gc-log .gc-masthead .bc-name{margin:0 2px}
      body #chat-panel #gc-log .cmsg.broadcast.gc-masthead .bc-line.gc-how{text-transform:none;letter-spacing:.4px;opacity:.75}
      body #chat-panel #gc-log .gc-message.agent .who.gc-who:is(:hover,:focus-visible){color:var(--ph-bright);text-shadow:0 0 5px var(--ph-glow)}
      .gc-message.draft .body{opacity:.85}.gc-message.draft .body::after{content:'▌';color:var(--ph);animation:1s steps(1) infinite comms-blink}
      .gc-message .gc-partial{display:block;margin-top:4px;font-size:12px;letter-spacing:.5px;color:var(--gold)}
      #gc-recipients:not(:empty){padding:4px 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--ph-dim);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      #gc-recipients .gc-to{color:var(--ph)}#gc-recipients .bb{font-size:11px!important;min-height:20px!important;padding:0 6px!important}
      #gc-mentions{flex:0 0 auto;display:flex;flex-direction:column;max-height:min(40vh,264px);overflow:auto;margin:0 0 6px;padding:0;border:1px solid rgba(var(--ph-rgb),.35);border-radius:4px;background:color-mix(in srgb,var(--panel2) 94%,var(--ph));scrollbar-color:var(--ph-dim) transparent}
      #gc-mentions:empty{display:none}
      #gc-mentions .gc-mention{display:flex;align-items:center;gap:10px;width:100%;min-height:30px;margin:0;padding:4px 10px;border:0;border-radius:0;background:none;box-shadow:none;color:var(--text);font:inherit;text-align:left;cursor:pointer}
      #gc-mentions .gc-mention[aria-selected=true],#gc-mentions .gc-mention:hover{background:rgba(var(--ph-rgb),.12);color:var(--ph-bright)}
      #gc-mentions .gc-mention[disabled]{opacity:.5;cursor:default}
      #gc-mentions .gc-led{flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:var(--ph-dim)}
      #gc-mentions .gc-mn{flex:0 1 auto;min-width:0;font-size:15px;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #gc-mentions .gc-mt{flex:0 0 auto;margin-left:auto;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim)}
      #gc-mentions .gc-mention[aria-selected=true] .gc-mt{color:var(--ph)}
      #gc-mentions .gc-mention-note{flex:0 0 auto;padding:4px 10px;border-top:1px solid rgba(var(--ph-rgb),.18);font-size:11px;letter-spacing:.6px;color:var(--ph-dim)}
      .gc-files{flex:0 0 auto;display:flex;flex-direction:column;min-height:0;max-height:40%;border-top:1px solid var(--ph-faint);font-size:13px;background:linear-gradient(rgba(0,0,0,.18),rgba(0,0,0,.04))}
      #gc-files{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px}#gc-files .gc-files-label{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim);margin-right:2px}
      #gc-files .gc-file{display:inline-flex;align-items:baseline;gap:5px;max-width:100%;margin:0;padding:2px 8px;min-height:22px;font-size:12px;letter-spacing:.3px;border:1px solid var(--ph-faint);border-radius:var(--r-sm,3px);background:rgba(var(--ph-rgb),.03);color:var(--ph);cursor:pointer;box-shadow:none}
      #gc-files .gc-file:hover,#gc-files .gc-file.open{border-color:var(--ph-dim);background:rgba(var(--ph-rgb),.055);color:var(--ph-bright)}#gc-files .gc-file .tc-glyph{color:var(--ph-dim)}#gc-files .gc-file span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #gc-preview{flex:0 1 auto;min-height:0;overflow:auto;padding:0 12px 8px}#gc-preview:empty{display:none}#gc-preview h4{margin:6px 0 2px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:var(--ph)}#gc-preview small{color:var(--ph-dim);font-size:11px;margin-right:10px}
      #gc-preview{white-space:pre-wrap;overflow-wrap:anywhere}#gc-preview a{color:var(--ph);font-size:11px;letter-spacing:1px}#gc-preview .gc-message{margin-top:6px}
      #gc-states{flex:0 0 auto;max-height:45%;overflow:auto;padding:0 12px 4px}
      .gc-state{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:4px 0 2px;padding:6px 11px;border-left:2px solid var(--ph);border-radius:0 4px 4px 0;background:linear-gradient(180deg,var(--ph-faint),rgba(0,0,0,.25));font-size:13px;letter-spacing:.5px;color:var(--ph-bright)}
      .gc-state .gc-dot{flex:0 0 auto;color:var(--ph);text-shadow:0 0 6px var(--ph-glow);animation:1s steps(1) infinite comms-blink}.gc-state .gc-verb{letter-spacing:1.5px;text-transform:uppercase}.gc-state .gc-what{color:var(--ph-dim);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .gc-state.hold{border-left-color:var(--gold);background:linear-gradient(180deg,color-mix(in srgb,var(--gold) 14%,transparent),rgba(0,0,0,.25))}.gc-state.hold .gc-dot,.gc-state.hold .gc-verb{color:var(--gold);animation:none;text-shadow:none}
      .gc-state.bad{border-left-color:var(--bad)}.gc-state.bad .gc-dot,.gc-state.bad .gc-verb{color:var(--bad);animation:none;text-shadow:none}
      .gc-state .gc-inspect summary{cursor:pointer}.gc-state .gc-inspect pre{max-height:240px;overflow:auto;margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}.gc-state .gc-approval{flex:1 0 100%;font-size:12px;color:var(--text);opacity:.9;overflow-wrap:anywhere}.gc-state .bb{margin-left:auto!important;font-size:11px!important;min-height:20px!important;padding:0 6px!important}.gc-state .bb+.bb{margin-left:0!important}
      #gc-questions{flex:0 0 auto;max-height:50%;overflow:auto}.gc-question{padding:8px 12px;border-left:2px solid var(--gold);background:var(--panel2);font-size:14px}.gc-question p{margin:5px 0}.gc-question-choices{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}.gc-question small,.gc-transfer{color:var(--ph-dim);font-size:12px}.gc-transfer{padding:2px 0 5px 14px;flex:0 0 auto}
      #gc-notice:empty{display:none}#gc-notice{flex:0 0 auto;padding:4px 12px;font-size:13px;color:var(--gold);overflow-wrap:anywhere}
      /* the picker fills its window: the two lists share the height and scroll on their own, the footer never leaves view */
      .gc-picker{min-width:0;min-height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px}.gc-picker>.key-input{flex:0 0 auto;display:block;width:100%;box-sizing:border-box;margin:0}
      .gc-sect{display:flex;flex-direction:column;min-width:0;min-height:0}.gc-sect.in{flex:0 0 auto}.gc-sect.out{flex:1 1 0;min-height:132px}
      .gc-sect-h{flex:0 0 auto;display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--ph-dim)}.gc-sect-h b{font-weight:normal;color:var(--ph)}
      .gc-sect-list{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid var(--ph-faint);border-radius:3px;background:rgba(0,0,0,.18)}.gc-sect-list:empty{display:none}.gc-sect.in .gc-sect-list{flex:0 1 auto;max-height:min(30vh,174px)}
      .gc-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--ph-faint);min-width:0}.gc-row:last-child{border-bottom:0}.gc-row[hidden]{display:none}
      .gc-row .gc-led{flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:var(--ph-dim)}.gc-row.in .gc-led{box-shadow:0 0 6px var(--ph-glow)}
      .gc-row .gc-id{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}.gc-row .gc-nm{font-size:14px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gc-row .gc-tag{font-size:12px;color:var(--ph-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gc-row .gc-tag:empty{display:none}
      .gc-row.in .gc-nm{color:var(--ph)}.gc-row .bb{flex:0 0 auto;min-width:74px;text-align:center}.gc-row.in .bb{color:var(--ph-dim)}.gc-row.in .bb:hover{color:var(--bad);border-color:var(--bad);background:transparent}
      .gc-row .bb[disabled]{opacity:.45;cursor:default}
      .gc-row .gc-lead{flex:0 0 auto;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--gold)}
      .gc-empty{padding:10px;font-size:13px;line-height:1.4;color:var(--ph-dim)}.gc-empty a{color:var(--ph);cursor:pointer}
      .gc-hint{flex:0 0 auto;margin:0;font-size:13px;line-height:1.4;color:var(--ph-dim)}.gc-hint b{font-weight:normal;color:var(--ph)}
      .gc-picker>[role=alert]{flex:0 0 auto;margin:0;color:var(--bad);font-size:13px}.gc-picker>[role=alert]:empty{display:none}
      .gc-picker-footer{flex:0 0 auto;position:sticky;bottom:0;display:flex;align-items:center;gap:8px;padding:10px 0 0;border-top:1px solid var(--ph-faint);background:var(--panel)}.gc-picker-footer .gc-delta{flex:1 1 auto;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim)}
      .gc-picker-footer .gc-delta.ok{color:var(--ph)}.gc-picker-footer .bb.primary{color:var(--ph-bright);border-color:var(--ph-dim)}
    `; document.head.append(css);
    discover().catch(e => { notice = e.message || String(e); });   // quiet: nobody asked yet (and the website embed has no sidecar)
    watch();
  }
  /* A group you are not looking at still owes you its news: replies land, questions wait, approvals expire in 5 minutes.
     Every few seconds (never while the window is hidden) the station-wide list says what each group is doing, and the
     rail reads it: unread activity, "Reply needed", "Approval needed", working. All of it is backend state. */
  const states = new Map();
  let watching = false, watchTimer = 0;
  function stateOf(id) {
    if (group && group.id === id && active?.id === id) {
      const t = group.turns || [];
      return { approvals: t.filter(x => x.state === 'waiting for approval').length, questions: (group.questions || []).filter(q => q.state === 'pending').length,
        busy: !group.paused && t.some(x => x.state === 'queued' || ['connecting', 'running', 'waiting for approval', 'waiting for answer', 'stopping'].includes(x.state)), paused: !!group.paused };
    }
    return states.get(id) || null;
  }
  function attentionIds() { return [...states.keys()].filter(id => { const st = stateOf(id); return st && (st.approvals || st.questions); }); }
  function watch() {
    if (watching) return; watching = true;
    const tick = async () => {
      try {
        if (typeof document === 'undefined' || !document.hidden) {
          const result = await api(); roster = result.roster || roster;
          let changed = false;
          for (const g of result.groups || []) {
            const next = { approvals: g.approvals || 0, questions: g.questions || 0, busy: !!g.busy && !g.paused, paused: !!g.paused };
            if (JSON.stringify(states.get(g.id) || null) !== JSON.stringify(next)) { states.set(g.id, next); changed = true; }
            const known = Workstreams.get(g.id), was = membersById.get(g.id);
            if (!known) { if (Workstreams.isDeleted && Workstreams.isDeleted(g.id)) continue; if (adopt(g)) changed = true; }   // a session you deleted stays deleted
            else if (!was || was.join('\n') !== (g.members || []).join('\n') || known.title !== g.title) { adopt(g); changed = true; }
            const ws = Workstreams.get(g.id);
            if (ws && g.id !== active?.id && g.updatedAt && g.updatedAt > (ws.lastActiveAt || 0)) { ws.lastActiveAt = g.updatedAt; changed = true; }
          }
          if (changed) save();
        }
      } catch (_) { /* the open group's own poll reports errors; the watch stays quiet and retries */ }
      clearTimeout(watchTimer); watchTimer = setTimeout(tick, 4000);
    };
    watchTimer = setTimeout(tick, 4000);
    // back from a minimize: look now, not up to 4 s later
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(watchTimer); tick(); } });
  }
  async function discover() {
    const result = await api(); roster = result.roster;
    for (const g of result.groups) adopt(g);
    save();
  }
  function bind(ws) {
    init(); if (!root) return;
    const enabled = !!ws && ws.conversationMode === 'group';
    $('gc-header').hidden = !enabled;
    $('comms-idbar').classList.toggle('gc-group', enabled);
    $('comms-idbar').hidden = false;
    for (const id of ['chat-log', 'chat-queued']) { const e = $(id); if (e) e.style.display = enabled ? 'none' : ''; }
    $('chat-inputrow').style.display = '';
    root.hidden = !enabled;
    // the message box says who hears it: in a group, everyone (the lead answers an un-@ed message)
    const input = $('chat-input');
    if (input) {
      if (enabled) { if (basePlaceholder == null) basePlaceholder = input.placeholder || ''; input.placeholder = 'Message the group · @ picks one agent'; }
      else if (basePlaceholder != null) { input.placeholder = basePlaceholder; basePlaceholder = null; }
    }
    if (active?.id === ws?.id) return;
    // the ADD AGENTS window edits ONE session: leaving it for another closes the window (it would edit the wrong chat)
    if (pickerFor && pickerFor !== ws?.id && $('gc-picker') && typeof StationUI !== 'undefined') StationUI.closeTerm('group-agents');
    if (openedFileUrl) { URL.revokeObjectURL(openedFileUrl); openedFileUrl = null; openedFile = null; $('gc-preview').replaceChildren(); }
    if (active) composerDrafts.set(active.id, input.value);
    active = ws; group = null; replyTo = null; selected = []; lastPaint = ''; generation++;
    clearTimeout(timer); $('gc-log').replaceChildren(); $('gc-states').replaceChildren(); $('gc-questions').replaceChildren(); input.value = composerDrafts.get(ws?.id) || ''; draftKey = null; notice = ''; $('gc-notice').textContent = ''; closeMentions(); recipientLabel();
    if (enabled) poll(generation);
  }
  async function poll(gen) {
    try {
      const id = active.id, result = await api(null, '?id=' + encodeURIComponent(id));
      if (gen !== generation) return;
      group = result; paint();
    } catch (e) {
      if (gen === generation) showError(/not found/i.test(e.message || '') ? new Error('This group no longer exists on this station. Delete it from the session list.') : e);
      if (/not found/i.test(e.message || '')) return;   // never poll a gone group every 900 ms forever
    }
    if (gen === generation && active?.conversationMode === 'group') timer = setTimeout(() => poll(gen), 900);
  }
  // the turn's REAL recorded time (never the current clock for a message that carries none)
  function stampOf(at) { const d = new Date(at); return at && !isNaN(d.getTime()) ? d : null; }
  const clockLabel = d => typeof Chat !== 'undefined' && Chat.clockLabel ? Chat.clockLabel(d) : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const breakLabel = d => typeof Chat !== 'undefined' && Chat.breakLabel ? Chat.breakLabel(d) : d.toDateString();
  /* The first line of every group transcript says what this is and who is in it — a station line in the COMMS
     vocabulary (a ruled line, [ tags ]), rebuilt from backend membership on every paint, so it can't go stale. */
  function masthead(g) {
    const d = h('div', { class: 'cmsg broadcast gc-masthead', role: 'note' }), stack = h('span', { class: 'bc-stack' });
    const who = h('span', { class: 'bc-line' }); who.append('GROUP CHAT · ');
    const order = [g.leadId, ...g.members.filter(id => id !== g.leadId)].filter(id => g.members.includes(id));
    order.forEach((id, i) => {
      if (i) who.append(' · ');
      const em = h('span', { class: 'bc-name' }, name(id)); const c = colorOf(id); if (c) em.style.color = c; who.append(em);
    });
    stack.append(who, h('span', { class: 'bc-line gc-how' }, '@name talks to one agent · without an @, ' + name(g.leadId) + ' answers'));
    d.append(stack);
    return d;
  }
  function paint() {
    if (!group || group.id !== active?.id) return;
    const signature = JSON.stringify(group); if (lastPaint === signature) return; lastPaint = signature;
    const priorRevision = active.groupRevision;
    adopt(group);
    if (priorRevision !== group.revision) { active.groupRevision = group.revision; save(); }
    participantsHeader($('gc-header'), group.members, !!group.paused, group.leadId);
    if (pickerFor === group.id && pickerRepaint) pickerRepaint(group);
    const log = $('gc-log'), bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    /* RECONCILE, never rebuild. Every node is keyed and kept while its content is unchanged, so text you selected in an
       older message survives the 900 ms poll while an agent streams (replaceChildren used to wipe it every tick). */
    const previous = new Map([...log.children].filter(n => n._gcKey).map(n => [n._gcKey, n]));
    const nodes = [];
    const keep = (key, sig, build) => { let n = previous.get(key); if (!n || n._gcSig !== sig) { n = build(); n._gcKey = key; n._gcSig = sig; } nodes.push(n); return n; };
    keep('masthead', JSON.stringify([group.members, group.leadId, group.members.map(name), group.members.map(colorOf)]), () => masthead(group));
    /* Speaker on every reply. An agent's name is the reply affordance: click it and the next
       message goes to that agent (no button under every bubble). The agent's roster colour
       carries the rail and the name, so who-said-what reads at a glance across N speakers. */
    const speaker = (author, target) => {
      if (author === 'user') return h('span', { class: 'who' }, 'COMMANDER');
      const who = h('button', { type: 'button', class: 'who gc-who', 'aria-label': 'Reply to ' + name(author), onclick: () => { replyTo = target || null; selected = [author]; recipientLabel(); $('chat-input').focus(); } }, name(author).toUpperCase());
      return who;
    };
    // the direct chat's copy key, on every message: the message as it was written
    const copyKey = content => {
      const cp = h('button', { type: 'button', class: 'cmsg-copy', 'aria-label': 'Copy message', 'data-tip': 'copy message', 'data-copy-label': 'Copy message' }, '⧉');
      cp.addEventListener('click', () => {
        const done = ok => { cp.classList.add(ok ? 'copied' : 'copy-failed'); setTimeout(() => cp.classList.remove('copied', 'copy-failed'), 1400); };
        try { navigator.clipboard.writeText(content).then(() => done(true), () => done(false)); } catch (_) { done(false); }
      });
      return cp;
    };
    let prevAt = 0, prevAuthor = null, prevClock = '';
    for (const m of group.messages) {
      // brief.ask's fallback marker belongs to the durable question card, not a chat bubble.
      const content = (group.questions || []).some(q => q.turnId === m.turnId)
        ? m.content.replace(/(?:^|\n)TASK_QUESTION:[^\n]*(?:\n|$)/g, '\n').trim() : m.content;
      if (!content) continue;
      const attachments = (m.artifactIds || []).map(id => group.artifacts.find(f => f.id === id)).filter(Boolean);
      // TIME BREAKS, the direct chat's rule: the first stamped turn, a new day, or 30 minutes of quiet
      const at = stampOf(m.at), clock = at ? clockLabel(at) : '';
      if (at) {
        if (!prevAt || new Date(prevAt).toDateString() !== at.toDateString() || at.getTime() - prevAt >= 30 * 60000) {
          const label = breakLabel(at);
          keep('tb:' + m.id, label, () => { const tb = h('div', { class: 'cmsg-timebreak', role: 'separator' }); tb.append(h('span', { class: 'tb-when' }, label)); return tb; });
          prevAuthor = null;
        }
        prevAt = at.getTime();
      }
      const rowKey = JSON.stringify([m, content, attachments, group.members, name(m.author), colorOf(m.author), clock]);
      const row = keep('m:' + m.id, rowKey, () => {
        const row = h('article', { class: 'gc-message cmsg' + (m.author === 'user' ? ' user' : ' agent'), 'data-message-id': m.id });
        const body = h('div', { class: 'body' });
        if (typeof Chat !== 'undefined' && Chat.renderProse) Chat.renderProse(body, content); else body.textContent = content;
        const color = colorOf(m.author); if (color) { row.style.setProperty('--gc-c', color); body.style.setProperty('--rail', color); }
        const who = group.members.includes(m.author) ? speaker(m.author, m.id) : h('span', { class: 'who' }, name(m.author).toUpperCase());
        if (at) {
          const head = h('span', { class: 'cmsg-head' }); head.append(who, h('span', { class: 'cmsg-ts' }, clock));
          row.dataset.ts = String(at.getTime()); row.append(head, body);
        } else row.append(who, body);
        if (m.partial) row.append(h('small', { class: 'gc-partial' }, 'partial · work did not complete'));
        if (attachments.length) renderMessageAttachments(row, group.id, attachments);
        row.append(copyKey(content));
        return row;
      });
      // a same-speaker follow-up stamped the same minute reads as one message (the direct chat's rule)
      row.classList.toggle('ts-repeat', !!clock && prevAuthor === m.author && prevClock === clock);
      // the COMMS rule that drops the callsign on an agent row after an agent row assumes ONE agent; here the row
      // above may be someone else, so only a true same-speaker follow-up continues it
      row.classList.toggle('gc-cont', prevAuthor === m.author);
      prevAuthor = m.author; prevClock = clock;
      // replies a PAUSE stopped before they ran (E-STOP, a restart, PAUSE — then a new message carried on): said under
      // the message they were for, with the one key that runs them now
      const unrun = m.author === 'user' ? group.turns.filter(t => t.origin === m.id && t.state === 'stopped' && t.reason === 'Paused before it ran' && !group.turns.some(x => x.retryOf === t.id)) : [];
      if (unrun.length) {
        const say = unrun.map(t => name(t.agentId)).join(', ') + ' did not run · stopped by the pause';
        keep('ps:' + m.id, say, () => { const line = h('div', { class: 'gc-transfer' }, say + ' '); line.append(button('RETRY', async () => { for (const t of unrun) await action('retry', { turnId: t.id }); })); return line; });
        prevAuthor = null;
      }
      for (const next of group.turns.filter(t => m.turnId && t.parent === m.turnId && !t.questionId && t.state !== 'stopped')) {
        const say = next.recoveryOf ? name(next.agentId) + ' was asked to check a handoff that did not start' : name(m.author) + ' asked ' + name(next.agentId) + ' to follow up';
        keep('tr:' + next.id, say, () => h('div', { class: 'gc-transfer' }, say));
        prevAuthor = null;
      }
    }
    for (const t of group.turns) if (t.draft) {
      // a streaming reply keeps its row; only its text moves
      const n = keep('dr:' + t.id, name(t.agentId) + colorOf(t.agentId), () => {
        const row = h('article', { class: 'gc-message cmsg agent draft' }), body = h('div', { class: 'body' }); const color = colorOf(t.agentId);
        if (color) { row.style.setProperty('--gc-c', color); body.style.setProperty('--rail', color); }
        row.append(h('span', { class: 'who' }, name(t.agentId).toUpperCase()), body); row._gcBody = body; return row;
      });
      if (n._gcBody && n._gcBody.textContent !== t.draft) n._gcBody.textContent = t.draft;
    }
    for (let i = 0; i < nodes.length; i++) { const cur = log.children[i]; if (cur !== nodes[i]) log.insertBefore(nodes[i], cur || null); }
    while (log.children.length > nodes.length) log.lastElementChild.remove();
    /* Turn state in the same voice as the direct chat's presence card: dot · NAME · verb.
       Truthful: 'running' only once the sidecar reports it; before that the word is 'connecting'. */
    const questions = $('gc-questions'); questions.replaceChildren();
    for (const q of (group.questions || []).filter(q => q.state === 'pending')) {
      const id = group.id, card = h('div', { class: 'gc-question', role: 'group', 'aria-label': name(q.agentId) + ' needs your answer' });
      card.append(h('div', { class: 'gc-verb' }, name(q.agentId) + ' · waiting for your answer'), h('p', {}, q.question));
      const choices = h('div', { class: 'gc-question-choices' });
      for (const option of q.options) choices.append(button(option, () => {
        if (!q.multiSelect && q.mode !== 'conversation') return answerQuestion(id, q.id, option);
        const input = $('chat-input'); const parts = input.value ? input.value.split('; ') : [];
        if (!parts.includes(option)) parts.push(option); input.value = parts.join('; '); draftKey = null; input.focus();
      }));
      card.append(choices, h('small', {}, q.multiSelect ? 'Choose any that apply, then send your answer below.' : 'Choose an answer or reply in the message box.'));
      if (q.reason) card.append(h('p', {}, q.reason));
      if (q.sample) card.append(h('small', {}, 'A starting point · draft'), h('p', { style: 'white-space:pre-wrap' }, q.sample));
      questions.append(card);
    }
    const states = $('gc-states'); states.replaceChildren();
    const VERB = { queued: 'queued', held: 'ready', connecting: 'connecting…', running: 'working', 'waiting for answer': 'waiting for your answer', 'waiting for approval': 'needs approval', stopping: 'stopping', failed: 'failed', interrupted: 'interrupted', stopped: 'stopped' };
    const pendingQ = (group.questions || []).find(q => q.state === 'pending');
    const needsYou = t => t.state === 'waiting for approval' || t.state === 'held' || (t.state === 'queued' && group.paused);
    let continueShown = false;
    for (const t of group.turns.slice(-15).sort((a, b) => needsYou(b) - needsYou(a))) {
      if (t.state === 'waiting for answer' && (group.questions || []).some(q => q.turnId === t.id && q.state === 'pending')) continue;
      const needsAttention = ['queued', 'held', 'queued', 'held', 'connecting', 'running', 'waiting for approval', 'waiting for answer', 'stopping'].includes(t.state) ||
        (t === group.turns.at(-1) && ['failed', 'interrupted'].includes(t.state));
      if (!needsAttention) continue;
      const tone = ['failed', 'interrupted'].includes(t.state) ? ' bad' : ['held', 'waiting for approval', 'queued', 'stopped'].includes(t.state) ? ' hold' : '';
      const row = h('div', { class: 'gc-state' + tone, 'data-turn-id': t.id });
      // a queued turn says WHY it waits: the pause, or a question someone else owes an answer to
      const what = t.quiet && ['connecting', 'running'].includes(t.state) ? 'no recent activity; still running'
        : t.state === 'queued' && group.paused ? 'paused — CONTINUE runs it, or send a new message'
        : t.state === 'queued' && pendingQ && pendingQ.agentId !== t.agentId ? 'waits for your answer to ' + name(pendingQ.agentId)
        : t.reason && t.state === 'queued' ? t.reason : VERB[t.state] || t.state;
      row.append(h('span', { class: 'gc-dot', 'aria-hidden': 'true' }, '●'), h('span', { class: 'gc-verb', style: colorOf(t.agentId) && !tone ? 'color:' + colorOf(t.agentId) : '' }, name(t.agentId)), h('span', { class: 'gc-what' }, what));
      if (t.state === 'queued' && group.paused && !continueShown) { continueShown = true; row.append(button('CONTINUE', () => action('resume'))); }
      if (t.state === 'held' && t.reason) row.append(h('span', { class: 'gc-what' }, t.reason));
      if (t.state === 'held') row.append(button('CONTINUE', () => action('continue')));
      if (['failed', 'interrupted', 'stopped'].includes(t.state)) row.append(button('RETRY', () => action('retry', { turnId: t.id })));
      if (t.approval) {
        // the keys first (line one), the argument text under them: a short window clips text, never the decision
        for (const decision of ['once', 'deny']) row.append(button(decision === 'once' ? 'ALLOW ONCE' : 'DENY', async () => { await api({ op: 'answer', id: group.id, promptId: t.approval.promptId, decision }); }));
        // argsSummary is the WHOLE request (user report 10-08): one glance line here, every character in INSPECT under it
        const raw = String(t.approval.argsSummary || ''), one = raw.replace(/\s+/g, ' ').trim();
        row.append(h('div', { class: 'gc-approval' }, t.approval.tool + (one ? ' · ' + (one.length > 160 ? one.slice(0, 159) + '…' : one) : '')));
        if (one.length > 160 || /\n/.test(raw.trim())) {
          const pid = t.approval.promptId;
          const detail = h('details', { class: 'gc-approval gc-inspect', ontoggle: () => { if (detail.open) inspectOpen.add(pid); else inspectOpen.delete(pid); } });
          detail.open = inspectOpen.has(pid);   // a re-render keeps the panel the Commander opened
          const copy = h('button', { type: 'button', class: 'bb gc-copy' }, 'COPY');
          copy.addEventListener('click', () => {
            const done = ok => { copy.textContent = ok ? '✓ COPIED' : 'COPY FAILED: select the text'; setTimeout(() => { copy.textContent = 'COPY'; }, 1400); };
            try { navigator.clipboard.writeText(raw).then(() => done(true), () => done(false)); } catch (_) { done(false); }
          });
          detail.append(h('summary', {}, 'Inspect complete request (secret patterns redacted)'), h('pre', {}, raw), copy);
          row.append(detail);
        }
      }
      states.append(row);
    }
    /* Message attachments belong to their turn. Retain the shelf for agent outputs and
       legacy uploads whose original message was never recorded; don't invent that association. */
    const attachedIds = new Set(group.messages.flatMap(m => m.artifactIds || []));
    const sharedFiles = group.artifacts.filter(f => !attachedIds.has(f.id));
    const files = $('gc-files'); files.replaceChildren();
    files.parentElement.hidden = !sharedFiles.length;
    if (sharedFiles.length) files.append(h('span', { class: 'gc-files-label' }, 'shared'));
    for (const f of sharedFiles) {
      const chip = h('button', { type: 'button', class: 'gc-file' + (openedFile === f.id ? ' open' : ''), 'aria-label': 'Open shared file ' + f.name, onclick: () => openFile(group.id, f).catch(showError) });
      chip.append(h('span', { class: 'tc-glyph', 'aria-hidden': 'true' }, '▤'), h('span', {}, f.name)); files.append(chip);
    }
    recipientLabel();
    if (Chat.refreshGroupControls) Chat.refreshGroupControls();
    // follow the newest message LAST: the turn-state, question and file strips below the log were just rebuilt, and
    // they take height from it — scrolling before they grew left the newest reply hidden under them
    if (bottom) log.scrollTop = log.scrollHeight;
  }
  function renderMessageAttachments(row, id, files) {
    const view = h('div', { class: 'chat-attach-view gc-attachments', 'aria-label': 'Message attachments' });
    for (const file of files) {
      const image = /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name);
      const chip = h('button', { type: 'button', class: image ? 'gc-attachment-image' : 'gc-file', 'aria-label': 'Open attachment ' + file.name,
        onclick: () => openFile(id, file).catch(showError) });
      if (image) {
        const img = h('img', { alt: file.name, loading: 'lazy' }); chip.append(img);
        fetch('/api/groups?id=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file.id)).then(r => {
          if (!r.ok) throw Error('Attachment preview unavailable'); return r.blob();
        }).then(blob => {
          if (!img.isConnected || active?.id !== id) return;
          const url = URL.createObjectURL(blob), free = () => URL.revokeObjectURL(url);
          img.addEventListener('load', free, { once: true }); img.addEventListener('error', free, { once: true }); img.src = url;
        }).catch(() => { img.remove(); });
      }
      chip.append(h('span', {}, file.name)); view.append(chip);
    }
    row.append(view);
  }
  function recipientLabel() {
    const e = $('gc-recipients'); e.replaceChildren();
    if (!selected.length) return;
    e.append(document.createTextNode('to'), h('span', { class: 'gc-to' }, selected.map(name).join(', ')));
    e.append(button('✕', () => { selected = []; replyTo = null; recipientLabel(); }));
  }
  async function openFile(id, file) {
    const response = await fetch('/api/groups?id=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file.id));
    if (!response.ok) throw new Error('Could not open this shared file');
    const blob = await response.blob();
    if (active?.id !== id) return;
    const preview = $('gc-preview'); preview.replaceChildren();
    if (openedFileUrl) URL.revokeObjectURL(openedFileUrl);
    const url = URL.createObjectURL(blob);
    openedFileUrl = url; openedFile = file.id; lastPaint = ''; paint();
    preview.append(h('h4', {}, file.name), h('small', {}, 'version ' + file.hash.slice(0, 12)), h('a', { href: url, download: file.name }, 'SAVE FILE'));
    if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) {
      preview.append(h('img', { class: 'gc-file-image', src: url, alt: file.name }));
    } else if (/\.(md|txt|csv|json|log|js|ts|py|html|css|xml|ya?ml|svg)$/i.test(file.sourcePath || file.name)) {
      const content = await blob.text(), body = h('div', { class: 'gc-message' });
      if (/\.md$/i.test(file.sourcePath || file.name) && Chat.renderProse) Chat.renderProse(body, content); else body.textContent = content;
      preview.append(body);
    } else preview.append(h('p', {}, 'This file can be saved and opened in its associated application.'));
    preview.append(button('CLOSE FILE', () => { URL.revokeObjectURL(url); openedFileUrl = null; openedFile = null; preview.replaceChildren(); lastPaint = ''; paint(); }));
  }

  /* ---------- STARTING A GROUP ----------
     A direct chat becomes a group the moment a second agent joins it — from the + key or by picking an @agent. The
     backend records the membership FIRST; nothing on screen says "in this chat" until /api/groups answered (the old
     picker showed staged rows as IN THIS CHAT and saved nothing until a SAVE that sat below the window's edge with a
     real-size crew — so "add one and minimize" lost it every time; truthful telemetry).
     The General home stream is never converted: it stays the station's casual line, and a fresh group starts beside it
     (the same rule the rail's + NEW keeps — General is never rebound). */
  function isGeneral(ws) { return !!ws && typeof Workstreams !== 'undefined' && typeof Workstreams.generalId === 'function' && Workstreams.generalId() === ws.id; }
  async function startGroup(origin, ids) {
    if (!origin) throw new Error('Open a chat first');
    if (origin.conversationMode === 'group') throw new Error('This chat is already a group');
    const lead = origin.agentId || 'agent', general = isGeneral(origin);
    // the words in THIS chat's box, taken now: if you switch chats while it is created, the box holds another chat's words
    const box = $('chat-input'), draft = box && active?.id === origin.id ? box.value : (composerDrafts.get(origin.id) || '');
    const members = [lead, ...ids.filter(id => id !== lead)];
    if (!general && typeof Chat !== 'undefined' && Chat.isBusy && active?.id === origin.id && Chat.isBusy()) throw new Error(name(lead) + ' is still working in this chat. Let the run finish (or stop it), then add agents.');
    if (typeof App !== 'undefined' && App.pushRoster) await App.pushRoster();   // the backend must know every agent it seats
    const id = general ? 'ws_' + uid().replace(/-/g, '').slice(0, 20) : origin.id;
    const title = general ? members.map(name).join(' + ') : (origin.title || 'Group chat');
    const g = await api(general ? { op: 'create', id, members, leadId: lead, title }
      : { op: 'create', id, conversionKey: origin.id, history: origin.history, originalAgentId: lead, members, leadId: lead, title });
    adopt(g); save();
    const still = !active || active.id === origin.id;
    // the words in the message box travel with the conversation — what is in it NOW if you stayed (you may have kept
    // typing), the snapshot if you left (the box holds another chat's words). General's box is left empty: they moved.
    composerDrafts.set(g.id, still && box ? box.value : draft); if (general) composerDrafts.set(origin.id, '');
    if (pickerFor === origin.id) pickerFor = g.id;
    if (!still) return g;   // you moved on while it was created: it waits in the rail, you are not pulled back
    active = null;   // a same-id conversion must rebind COMMS (bind returns early for the session it already shows)
    if (typeof App !== 'undefined' && App.openWorkstream) App.openWorkstream(g.id);
    if (typeof Chat !== 'undefined' && Chat.load) Chat.load(Workstreams.get(g.id));
    if (!active) bind(Workstreams.get(g.id));   // nothing else rebound COMMS: show the group we just made
    if (active?.id === g.id) { group = g; lastPaint = ''; paint(); }
    return g;
  }
  // configure carries the revision it read; any turn-state write bumps it, so a busy group answers 409 — re-read and retry
  async function configureMembers(id, change) {
    for (let attempt = 0; ; attempt++) {
      const fresh = await api(null, '?id=' + encodeURIComponent(id));
      const members = change(fresh.members.slice());
      try {
        return await api({ op: 'configure', id, revision: fresh.revision, members, leadId: members.includes(fresh.leadId) ? fresh.leadId : members[0] });
      } catch (e) { if (attempt >= 3 || !/Session changed/i.test(e.message || '')) throw e; }
    }
  }

  /* ---------- THE @ MENU ----------
     Typing @ in ANY chat lists the crew over the message box: ↑/↓ move, Enter or Tab picks, Esc closes. Picking a
     member writes its handle; picking someone not in the chat adds them first (a direct chat becomes a group). */
  function closeMentions() { mentionItems = []; mentionSel = 0; mentionCtx = null; const e = $('gc-mentions'); if (e) e.replaceChildren(); const input = $('chat-input'); if (input && input.removeAttribute) input.removeAttribute('aria-activedescendant'); }
  function mentionQuery() {
    const input = $('chat-input'); if (!input) return null;
    const v = String(input.value || ''); if (v[0] === '/') return null;   // the slash palette owns a leading /
    const caret = typeof input.selectionStart === 'number' ? input.selectionStart : v.length;
    const m = v.slice(0, caret).match(/(?:^|\s)@([\w-]*)$/);
    return m ? { q: m[1], start: caret - m[1].length - 1, end: caret, original: v } : null;
  }
  // the handle written into the message: the agent's name when it is one word no one else wears, else its stable id
  function handleFor(id) {
    const list = crew(), nm = list.find(a => a.id === id)?.name || id;
    const lower = nm.toLowerCase();
    const clash = list.some(a => a.id !== id && (a.name.toLowerCase() === lower || a.id === nm || a.name.toLowerCase().startsWith(lower + ' ')));
    return /^[\w-]+$/.test(nm) && !clash ? nm : id;
  }
  function autocomplete() {
    const e = $('gc-mentions'); if (!e) return;
    if (mentionBusy) return;
    const ctx = mentionQuery();
    if (!ctx || !active) return closeMentions();
    const inGroup = active.conversationMode === 'group';
    if (inGroup && (!group || group.id !== active.id)) return closeMentions();   // membership not loaded yet: never guess it
    const members = inGroup ? group.members : [active.agentId || 'agent'];
    const q = ctx.q.toLowerCase();
    const score = a => { const n = a.name.toLowerCase(), i = a.id.toLowerCase(); return !q ? 1 : n.startsWith(q) || i.startsWith(q) ? 0 : n.includes(q) || i.includes(q) ? 1 : -1; };
    let items = crew().map(a => ({ id: a.id, name: a.name, member: members.includes(a.id), s: score(a) })).filter(a => a.s >= 0);
    if (!inGroup) items = items.filter(a => !a.member);   // a direct chat is already talking to its own agent
    items.sort((a, b) => (b.member - a.member) || (a.s - b.s));
    if (inGroup && 'all'.startsWith(q) && members.length > 1) items.unshift({ id: 'all', name: 'all', member: true, all: true, s: 0 });
    const prev = mentionItems[mentionSel]?.id;
    mentionCtx = ctx; mentionItems = items;
    mentionSel = Math.max(0, items.findIndex(i => i.id === prev));
    renderMentions();
  }
  function renderMentions() {
    const e = $('gc-mentions'); if (!e) return;
    e.replaceChildren();
    if (!mentionItems.length || !active) return;
    const inGroup = active.conversationMode === 'group', lead = name(active.agentId || 'agent');
    mentionItems.forEach((item, i) => {
      const row = h('button', { type: 'button', class: 'gc-mention', role: 'option', id: 'gc-mention-' + i, 'aria-selected': String(i === mentionSel),
        onmousedown: ev => ev.preventDefault(),   // keep the caret in the message box
        onclick: () => acceptMention(item) });
      if (mentionBusy) row.setAttribute('disabled', '');
      const led = h('span', { class: 'gc-led', 'aria-hidden': 'true' }); const c = colorOf(item.id); if (c) led.style.background = c;
      const what = item.all ? 'everyone here' : item.member ? 'in this chat' : inGroup ? 'adds to this chat' : 'starts a group with ' + lead;
      row.append(led, h('span', { class: 'gc-mn' }, item.all ? '@all' : item.name), h('span', { class: 'gc-mt' }, what));
      e.append(row);
    });
    if (mentionItems.some(i => !i.member)) e.append(h('div', { class: 'gc-mention-note' }, mentionBusy ? 'Adding…' : '↑↓ choose · Enter adds · adding an agent shares this conversation and its files'));
    const input = $('chat-input'); if (input) input.setAttribute('aria-activedescendant', 'gc-mention-' + mentionSel);
    const sel = e.querySelector ? e.querySelector('[aria-selected="true"]') : null; if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  async function acceptMention(item) {
    const ctx = mentionCtx, input = $('chat-input');
    if (!item || !ctx || !input || mentionBusy) return;
    if (input.value !== ctx.original) return autocomplete();
    const ws = active;
    if (!item.member) {
      mentionBusy = true; renderMentions();
      try {
        if (ws.conversationMode === 'group') {
          const result = await api({ op: 'invite', id: ws.id, agentId: item.id });
          if (active?.id === ws.id) { group = result; adopt(result); paint(); }   // record the new member now, so the rail lists the group under them
        } else await startGroup(ws, [item.id]);
      } catch (e) { mentionBusy = false; closeMentions(); showError(e); return; }
      mentionBusy = false;
    }
    const handle = item.all ? 'all' : handleFor(item.id);
    // the box may have moved on while the agent was being added: splice into what is there NOW, never the snapshot
    const cur = input.value, head = ctx.original.slice(0, ctx.end);
    if (cur.slice(0, ctx.end) === head) {
      input.value = cur.slice(0, ctx.start) + '@' + handle + ' ' + cur.slice(ctx.end).replace(/^ /, '');
      const caret = cur === ctx.original ? ctx.start + handle.length + 2 : input.value.length; if (input.setSelectionRange) input.setSelectionRange(caret, caret);
    }
    draftKey = null; selected = []; replyTo = null; recipientLabel(); closeMentions(); if (input.focus) input.focus();
    if (typeof Chat !== 'undefined' && Chat.autoGrowInput) Chat.autoGrowInput();
  }
  // Chat's composer keydown asks here first: while the @ menu is open it owns ↑ ↓ Enter Tab Esc
  function mentionKey(e) {
    const list = $('gc-mentions');
    if (!mentionItems.length || !list || !list.children.length) return false;
    if (!mentionCtx || $('chat-input')?.value !== mentionCtx.original) { closeMentions(); return false; }   // stale menu: the box moved on
    const n = mentionItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; renderMentions(); return true; }
    if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); acceptMention(mentionItems[mentionSel]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMentions(); return true; }
    return false;
  }
  // @handles in a DIRECT chat that name another crew agent exactly (id, or a name only they wear) — the send path
  // turns that chat into a group with them before sending, so "@finn take a look" reaches FINN from any chat
  function mentionTargets(text, ws) {
    if (!ws || ws.conversationMode === 'group') return [];
    const plain = String(text || '').replace(/```[\s\S]*?```|`[^`]*`/g, '').replace(/^>.*$/gm, '');
    const list = crew(), out = [];
    for (const m of plain.matchAll(/(?:^|\s)@(?=[\w-])/g)) {
      const rest = plain.slice(m.index + m[0].length), hd = rest.match(/^[\w-]+/)[0];
      const named = list.filter(a => rest.slice(0, a.name.length).toLowerCase() === a.name.toLowerCase() && !/[\w-]/.test(rest.charAt(a.name.length)));
      const best = Math.max(0, ...named.map(a => a.name.length)), longest = named.filter(a => a.name.length === best);
      const exact = best > hd.length ? null : list.find(a => a.id === hd);
      const hits = exact ? [exact] : longest;
      if (hits.length !== 1) continue;
      const id = hits[0].id; if (id !== (ws.agentId || 'agent') && !out.includes(id)) out.push(id);
    }
    return out;
  }
  const converting = new Map();   // origin id → the conversion in flight (a second Enter must not create a second group)
  async function startWith(ids) {
    const origin = active; if (!origin) return null;
    if (converting.has(origin.id)) return converting.get(origin.id);
    const run = (async () => { try { closeMentions(); return await startGroup(origin, ids); } catch (e) { showError(e); return null; } finally { converting.delete(origin.id); } })();
    converting.set(origin.id, run);
    return run;
  }

  async function answerQuestion(id, questionId, text) {
    const result = await api({ op: 'answerQuestion', id, questionId, text });
    if (active?.id === id) { group = result; lastPaint = ''; paint(); }
    return true;
  }

  async function sendText(value, options = {}) {
    if (busy || !active || active.conversationMode !== 'group' || (!String(value || '').trim() && !options.attachments?.length)) return false;
    const id = active.id, agentId = options.attachmentAgent || active.agentId, paused = group?.paused;
    const reply = replyTo, recipients = [...selected], key = draftKey || (draftKey = uid()); busy = true;
    try {
      const question = (group?.questions || []).find(q => q.state === 'pending');
      // a plain reply — or one aimed at the asker (their name clicked) — answers the waiting question
      if (question && !/(?:^|\s)@/.test(value) && (!recipients.length || (recipients.length === 1 && recipients[0] === question.agentId)) && !options.attachments?.length) {
        await answerQuestion(id, question.id, String(value).trim()); composerDrafts.delete(id); draftKey = null; return true;
      }
      const artifactIds = [];
      for (const file of options.attachments || []) {
        const attachmentKey = id + ':' + file.id;
        if (sharedAttachments.has(attachmentKey)) { artifactIds.push(sharedAttachments.get(attachmentKey)); continue; }
        const response = await fetch('/api/file?agent=' + encodeURIComponent(agentId) + '&path=' + encodeURIComponent(file.path));
        if (!response.ok) throw new Error('Could not share ' + file.name);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 1024 * 1024) throw new Error('Group files currently support up to 1 MiB; ' + file.name + ' is still attached.');
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        const uploaded = await api({ op: 'attach', id, key: file.id, name: file.name, content: btoa(binary) });
        const artifact = uploaded.artifacts.find(a => a.attachmentKey === file.id && a.agentId === 'user');
        if (!artifact) throw new Error('Attachment was not confirmed. Your file is still staged.');
        sharedAttachments.set(attachmentKey, artifact.id); artifactIds.push(artifact.id);
      }
      // a paused group (E-STOP, a restart, PAUSE) resumes INSIDE the send, only once the message is valid
      const result = await api({ op: 'send', id, key, text: String(value || '').trim() || 'Please review the attached files.', replyTo: reply,
        recipients: /(?:^|\s)@/.test(value) ? [] : recipients, artifactIds, ...(paused ? { resume: true } : {}) });
      for (const file of options.attachments || []) sharedAttachments.delete(id + ':' + file.id);
      composerDrafts.delete(id);
      if (active?.id === id) { group = result; closeMentions(); selected = []; replyTo = null; draftKey = null; notice = ''; $('gc-notice').textContent = ''; paint(); }
      return true;
    } catch (e) { showError(e); return false; } finally { busy = false; }
  }
  function isBusy() { return !!(group && group.id === active?.id && group.turns.some(t => ['queued', 'held', 'connecting', 'running', 'waiting for approval', 'waiting for answer', 'stopping'].includes(t.state))); }
  async function stop() {
    const id = active?.id; if (!id) return;
    try {
      const result = await api({ op: 'control', id, action: 'stop-all' });
      if (active?.id === id) { group = result; lastPaint = ''; paint(); }
    } catch (e) { showError(e); }
  }
  async function action(action, extra = {}) {
    const id = active.id; const result = await api({ op: 'control', id, action, ...extra });
    if (active?.id === id) { group = result; lastPaint = ''; paint(); }
  }
  /* ---------- ADD AGENTS ----------
     Two lists, one verb each, and every verb SAVES: + ADD seats the agent on the backend at once (a direct chat
     becomes a group on the first one), ✕ REMOVE takes them out at once. IN THIS CHAT only ever lists what the
     backend confirmed. The lead is marked and cannot be removed — someone must answer an unaddressed message.
     The lists share the window's height and scroll on their own; the footer (status + DONE) never leaves view. */
  async function picker() {
    const open = $('gc-picker');
    if (open) {   // already open: a minimized window comes back up; otherwise one is enough
      const w = open.closest ? open.closest('.term') : null;
      if (w && w.classList.contains('term-min-hidden')) StationUI.toggleTerm('group-agents');
      return;
    }
    const origin = active;
    pickerFor = origin?.id || null;
    const dialog = h('div', { id: 'gc-picker', class: 'gc-picker' });
    const close = () => StationUI.closeTerm('group-agents');
    dialog.append(h('p', { role: 'status' }, 'Loading agents…'), button('CANCEL', close));
    StationUI.toggleTerm('group-agents', origin?.conversationMode === 'group' ? 'AGENTS IN THIS CHAT' : 'ADD AGENTS', body => body.replaceChildren(dialog), { onClose: () => { dialog.remove(); pickerFor = null; pickerRepaint = null; } });
    try {
      if (App.pushRoster) await App.pushRoster();
      const info = await api(); roster = info.roster;
      let current = origin?.conversationMode === 'group' ? await api(null, '?id=' + encodeURIComponent(origin.id)) : null;
      if (!dialog.isConnected) return;
      dialog.replaceChildren();
      let saving = null, status = '', statusOk = false;
      const membersNow = () => current ? current.members : [origin?.agentId || 'agent'];
      const leadNow = () => current ? current.leadId : (origin?.agentId || 'agent');
      const dup = id => roster.filter(r => r.name === roster.find(a => a.id === id)?.name).length > 1;
      const label = id => name(id) + (dup(id) ? ' (' + id + ')' : '');
      const search = roster.length > 6 ? h('input', { type: 'search', class: 'key-input', placeholder: 'Find an agent by name', 'aria-label': 'Find an agent by name' }) : null;
      if (search) dialog.append(search);
      const inHead = h('div', { class: 'gc-sect-h' }), inList = h('div', { class: 'gc-sect-list', role: 'list', 'aria-label': 'Agents in this chat' });
      const outHead = h('div', { class: 'gc-sect-h' }), outList = h('div', { class: 'gc-sect-list', role: 'list', 'aria-label': 'Agents you can add' });
      const outEmpty = h('div', { class: 'gc-empty' });
      const inSect = h('div', { class: 'gc-sect in' }), outSect = h('div', { class: 'gc-sect out' });
      inSect.append(inHead, inList); outSect.append(outHead, outList, outEmpty);
      dialog.append(inSect, outSect);
      const hint = h('p', { class: 'gc-hint' }); dialog.append(hint);
      const errors = h('p', { role: 'alert' }); dialog.append(errors);
      const footer = h('div', { class: 'gc-picker-footer' }), delta = h('span', { class: 'gc-delta', 'aria-live': 'polite' });
      const done = button('DONE', close); done.classList.add('primary');
      footer.append(delta, done); dialog.append(footer);
      async function change(agentId, add) {
        if (saving) return;
        saving = agentId; errors.textContent = ''; status = (add ? 'adding ' : 'removing ') + name(agentId) + '…'; statusOk = false; render();
        try {
          if (!current) current = await startGroup(origin, [agentId]);
          else {
            current = add ? await api({ op: 'invite', id: current.id, agentId }) : await configureMembers(current.id, ids => ids.filter(id => id !== agentId));
            adopt(current); save();
            if (active?.id === current.id) { group = current; lastPaint = ''; paint(); }
          }
          status = name(agentId) + (add ? ' joined · saved' : ' left · saved'); statusOk = true;
        } catch (e) { errors.textContent = e.message || String(e); status = ''; }
        finally { saving = null; if (dialog.isConnected) render(); }
      }
      function row(a, inChat) {
        const r = h('div', { class: 'gc-row' + (inChat ? ' in' : ''), role: 'listitem', 'data-agent-name': label(a.id).toLowerCase() });
        const led = h('span', { class: 'gc-led', 'aria-hidden': 'true' }); if (colorOf(a.id)) led.style.background = colorOf(a.id);
        const idc = h('div', { class: 'gc-id' }); idc.append(h('span', { class: 'gc-nm' }, label(a.id)), h('span', { class: 'gc-tag' }, describe(a.id)));
        r.append(led, idc);
        if (inChat && a.id === leadNow()) { r.append(h('span', { class: 'gc-lead', title: 'Answers when you do not @ anyone' }, 'lead')); return r; }
        const b = inChat ? button(saving === a.id ? 'REMOVING…' : '✕ REMOVE', () => change(a.id, false)) : button(saving === a.id ? 'ADDING…' : '+ ADD', () => change(a.id, true));
        b.setAttribute('aria-label', (inChat ? 'Remove ' : 'Add ') + label(a.id) + (inChat ? ' from this chat' : ' to this chat'));
        if (saving) b.setAttribute('disabled', '');
        r.append(b); return r;
      }
      function render() {
        const q = (search?.value || '').toLowerCase(), chosen = membersNow();
        const ins = roster.filter(a => chosen.includes(a.id)), outs = roster.filter(a => !chosen.includes(a.id));
        inHead.replaceChildren('In this chat ', h('b', {}, String(ins.length)));
        outHead.replaceChildren('Add to this chat');
        inList.replaceChildren(...ins.map(a => row(a, true))); outList.replaceChildren(...outs.map(a => row(a, false)));
        for (const r of [...inList.children, ...outList.children]) r.hidden = !!q && !r.dataset.agentName.includes(q);
        outEmpty.replaceChildren();
        if (!outs.length) { outEmpty.append('Your whole crew is already in this chat. Recruit more under CREW.'); }
        hint.replaceChildren('Talk to one agent with ', h('b', {}, '@name'), '. Without an @, ', h('b', {}, name(leadNow())), ' answers. Everyone here sees the whole conversation and its shared files.');
        if (current) shown = current.members.join('\n') + '|' + current.leadId;
        delta.textContent = status || (current ? ins.length + (ins.length === 1 ? ' agent' : ' agents') + ' in this chat' : '+ ADD starts a group chat');
        delta.classList.toggle('ok', statusOk);
      }
      let shown = '';
      pickerRepaint = g => { const k = g.members.join('\n') + '|' + g.leadId; current = g; if (!saving && k !== shown) render(); };
      if (search) search.addEventListener('input', render);
      render();
    } catch (e) {
      if (!dialog.isConnected) return;
      dialog.replaceChildren(h('p', { role: 'alert' }, e.message || String(e)), button('RETRY', () => { close(); return picker(true); }), button('CANCEL', close));
    }
  }
  async function rename(id, title) { const state = await api(null, '?id=' + encodeURIComponent(id)); await api({ op: 'configure', id, revision: state.revision, title }); return true; }
  // a group the backend already lost is already gone: deleting or archiving it must still finish on this side
  const goneOk = e => { if (!/not found/i.test(e.message || '')) throw e; };
  async function remove(id) { await api({ op: 'control', id, action: 'delete' }).catch(goneOk); states.delete(id); }
  async function pause(id) { await api({ op: 'control', id, action: 'pause' }).catch(goneOk); }
  return { bind, sendText, discover, rename, remove, pause, isBusy, stop, mentionKey, mentionTargets, startWith, stateOf, attentionIds, membersOf: id => membersById.get(id) || null };
})();
