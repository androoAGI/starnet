/* Group DM UI: backend-owned membership, dispatch and transcript; direct COMMS stays intact. */
'use strict';
const GroupChat = (() => {
  let active = null, group = null, root, timer, busy = false, replyTo = null, roster = [], selected = [];
  let generation = 0, lastPaint = '', notice = '', draftKey = null;
  let openedFileUrl = null, openedFile = null;
  const composerDrafts = new Map();
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
  function showError(e) { notice = e.message || String(e); if ($('gc-notice')) $('gc-notice').textContent = notice; }
  async function api(body, query = '') {
    const r = await fetch('/api/groups' + query, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    if (r.status === 401 || r.status === 403) throw new Error('Reconnect to this station by refreshing the page. Your conversation is saved.');
    if (r.status === 404 && !body && !query) throw new Error('Group chat is unavailable on this server. Run the current StarNet backend, then try again.');
    let out;
    try { out = await r.json(); } catch (_) { throw new Error('The server could not load group chat. Try again.'); }
    if (!r.ok || !out?.ok) throw new Error(out?.error || 'Group request failed'); return out.result;
  }
  function save() { if (typeof App !== 'undefined') { App.persist(); App.refreshRail(); } }
  function adopt(g) {
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
  function name(id) { return id === 'user' ? 'COMMANDER' : (roster.find(a => a.id === id)?.name || App.agents?.().find(a => a.id === id)?.name || id); }
  function colorOf(id) { const c = typeof App !== 'undefined' && App.agents ? App.agents().find(a => a.id === id)?.color : ''; return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : ''; }
  function participantsHeader(element, ids, paused) {
    element.replaceChildren(h('span', { class: 'gc-count' }, ids.length + (ids.length === 1 ? ' agent' : ' agents')));
    /* One line, ellipsized — never a scrollbar. The count beside it says how many; the full list is
       one hover (station tip) or one click (the picker) away. */
    const people = h('button', { type: 'button', class: 'gc-people', title: ids.map(name).join(' · '), 'aria-label': 'Agents in this chat: ' + ids.map(name).join(', ') + '. Add or remove agents', onclick: () => picker(true) });
    for (const id of ids) people.append(h('span', { class: 'gc-person' }, name(id)));
    element.append(people);
    if (paused) element.append(h('small', {}, 'Paused'));
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
    $('chat-input').addEventListener('input', () => { if (active?.conversationMode === 'group') { draftKey = null; autocomplete(); } });
    root.append(transcript, files, questions, states, recipient, h('div', { id: 'gc-mentions', role: 'listbox', 'aria-label': 'Mention participants' }), h('div', { id: 'gc-notice', role: 'status' }));
    $('chat-log').before(root);
    const css = h('style'); css.textContent = `
      #group-chat{position:relative;display:flex;flex:1 1 0;min-width:0;min-height:0;flex-direction:column;overflow:hidden;color:var(--text);background:var(--panel);padding:0;gap:0}
      #group-chat[hidden],#gc-header[hidden]{display:none}
      #comms-idbar{flex:0 0 auto;flex-wrap:nowrap}#comms-idbar.gc-group>.comms-agent-wrap,#comms-idbar.gc-group>#comms-agent-model,#chat-panel #comms-idbar.gc-group>.comms-identity,#chat-panel #comms-idbar.gc-group>.comms-portrait{display:none}
      #gc-header{display:flex;align-items:center;gap:10px;flex:1;min-width:0;color:var(--ph)}
      .gc-count{order:2;flex:0 0 auto;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim);white-space:nowrap}
      #gc-add-agents{flex:0 0 auto;white-space:nowrap}
      .gc-people{display:block;flex:1 1 0;min-width:0;margin:0;padding:0;border:0;background:none;font:inherit;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:var(--ph)}
      .gc-people:hover .gc-person{color:var(--ph-bright)}
      .gc-person{display:inline;font-size:14px;line-height:18px;letter-spacing:1px;color:var(--ph);white-space:nowrap}.gc-person+.gc-person{margin-left:14px}.gc-person::before{content:'▪';margin-right:6px;color:var(--ph-dim)}
      #group-chat .bb,#gc-add-agents{margin:0;padding:3px 8px;min-height:26px;font-size:13px;line-height:18px;letter-spacing:1px;border:1px solid var(--ph-faint);border-radius:3px;background:var(--panel2);color:var(--ph);box-shadow:var(--raise)}
      #group-chat .bb:hover,#gc-add-agents:hover{border-color:var(--ph);background:var(--ph-faint)}
      #group-chat :focus-visible,.gc-picker :focus-visible{outline:1px solid var(--ph);outline-offset:2px}
      #gc-log{flex:1 1 0;min-height:0;min-width:0;overflow:auto;padding:8px 12px;display:flex;flex-direction:column;gap:5px;background:var(--panel);user-select:text;scrollbar-color:var(--ph-dim) transparent}
      #gc-log>.gc-message{flex:0 0 auto;margin:0;background:none;overflow-wrap:anywhere;white-space:normal}#gc-log .body{margin:0}#gc-log .gc-message .who{display:block}
      #gc-log .gc-message.agent .who{color:var(--gc-c,var(--ph-dim))}#gc-log .gc-message.agent{border-left-color:var(--gc-c,var(--ph-faint))}
      #gc-log .gc-message .who.gc-who{cursor:pointer;user-select:none;border:0;background:none;padding:0;font:inherit;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;text-align:left;width:auto}
      #gc-log .gc-message .who.gc-who:hover{color:var(--ph-bright);text-shadow:0 0 5px var(--ph-glow)}
      #gc-log .gc-message .who.gc-who::after{content:' @';opacity:0;font-size:11px;letter-spacing:0;transition:opacity .12s}#gc-log .gc-message .who.gc-who:hover::after{opacity:.8}
      .gc-message.draft .body{opacity:.85}.gc-message.draft .body::after{content:'▌';color:var(--ph);animation:1s steps(1) infinite comms-blink}
      .gc-message .gc-partial{display:block;margin-top:4px;font-size:12px;letter-spacing:.5px;color:var(--gold)}
      #gc-recipients:not(:empty),#gc-mentions:not(:empty){padding:4px 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--ph-dim);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      #gc-recipients .gc-to{color:var(--ph)}#gc-recipients .bb,#gc-mentions .bb{font-size:11px!important;min-height:20px!important;padding:0 6px!important}
      .gc-files{flex:0 0 auto;display:flex;flex-direction:column;min-height:0;max-height:40%;border-top:1px solid var(--ph-faint);font-size:13px;background:linear-gradient(rgba(0,0,0,.18),rgba(0,0,0,.04))}
      #gc-files{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px}#gc-files .gc-files-label{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim);margin-right:2px}
      #gc-files .gc-file{display:inline-flex;align-items:baseline;gap:5px;max-width:100%;margin:0;padding:2px 8px;min-height:22px;font-size:12px;letter-spacing:.3px;border:1px solid var(--ph-faint);border-radius:var(--r-sm,3px);background:rgba(var(--ph-rgb),.03);color:var(--ph);cursor:pointer;box-shadow:none}
      #gc-files .gc-file:hover,#gc-files .gc-file.open{border-color:var(--ph-dim);background:rgba(var(--ph-rgb),.055);color:var(--ph-bright)}#gc-files .gc-file .tc-glyph{color:var(--ph-dim)}#gc-files .gc-file span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #gc-preview{flex:0 1 auto;min-height:0;overflow:auto;padding:0 12px 8px}#gc-preview:empty{display:none}#gc-preview h4{margin:6px 0 2px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:var(--ph)}#gc-preview small{color:var(--ph-dim);font-size:11px;margin-right:10px}
      #gc-preview{white-space:pre-wrap;overflow-wrap:anywhere}#gc-preview a{color:var(--ph);font-size:11px;letter-spacing:1px}#gc-preview .gc-message{margin-top:6px}
      #gc-states{flex:0 0 auto;max-height:25%;overflow:auto;padding:0 12px 4px}
      .gc-state{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:4px 0 2px;padding:6px 11px;border-left:2px solid var(--ph);border-radius:0 4px 4px 0;background:linear-gradient(180deg,var(--ph-faint),rgba(0,0,0,.25));font-size:13px;letter-spacing:.5px;color:var(--ph-bright)}
      .gc-state .gc-dot{flex:0 0 auto;color:var(--ph);text-shadow:0 0 6px var(--ph-glow);animation:1s steps(1) infinite comms-blink}.gc-state .gc-verb{letter-spacing:1.5px;text-transform:uppercase}.gc-state .gc-what{color:var(--ph-dim);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .gc-state.hold{border-left-color:var(--gold);background:linear-gradient(180deg,color-mix(in srgb,var(--gold) 14%,transparent),rgba(0,0,0,.25))}.gc-state.hold .gc-dot,.gc-state.hold .gc-verb{color:var(--gold);animation:none;text-shadow:none}
      .gc-state.bad{border-left-color:var(--bad)}.gc-state.bad .gc-dot,.gc-state.bad .gc-verb{color:var(--bad);animation:none;text-shadow:none}
      .gc-state .gc-approval{flex:1 0 100%;font-size:12px;color:var(--text);opacity:.9;overflow-wrap:anywhere}.gc-state .bb{margin-left:auto!important;font-size:11px!important;min-height:20px!important;padding:0 6px!important}.gc-state .bb+.bb{margin-left:0!important}
      #gc-questions{flex:0 1 auto;max-height:35%;overflow:auto}.gc-question{padding:8px 12px;border-left:2px solid var(--gold);background:var(--panel2);font-size:14px}.gc-question p{margin:5px 0}.gc-question-choices{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}.gc-question small,.gc-transfer{color:var(--ph-dim);font-size:12px}.gc-transfer{padding:2px 0 5px;flex:0 0 auto}
      #gc-notice:empty{display:none}#gc-notice{flex:0 0 auto;padding:4px 12px;font-size:13px;color:var(--gold);overflow-wrap:anywhere}
      .gc-picker{min-width:0;display:flex;flex-direction:column;gap:10px}.gc-picker>.key-input{display:block;width:100%;box-sizing:border-box;margin:0}
      .gc-sect{display:flex;flex-direction:column;min-width:0}.gc-sect-h{display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--ph-dim)}.gc-sect-h b{font-weight:normal;color:var(--ph)}
      .gc-sect-list{max-height:28vh;overflow:auto;border:1px solid var(--ph-faint);border-radius:3px;background:rgba(0,0,0,.18)}.gc-sect-list:empty{display:none}
      .gc-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--ph-faint);min-width:0}.gc-row:last-child{border-bottom:0}.gc-row[hidden]{display:none}
      .gc-row .gc-led{flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:var(--ph-dim)}.gc-row.in .gc-led{box-shadow:0 0 6px var(--ph-glow)}
      .gc-row .gc-id{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}.gc-row .gc-nm{font-size:14px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gc-row .gc-tag{font-size:12px;color:var(--ph-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gc-row .gc-tag:empty{display:none}
      .gc-row.in .gc-nm{color:var(--ph)}.gc-row .bb{flex:0 0 auto;min-width:74px;text-align:center}.gc-row.in .bb{color:var(--ph-dim)}.gc-row.in .bb:hover{color:var(--bad);border-color:var(--bad);background:transparent}
      .gc-row .gc-lead{flex:0 0 auto;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--gold)}
      .gc-empty{padding:10px;font-size:13px;line-height:1.4;color:var(--ph-dim)}.gc-empty a{color:var(--ph);cursor:pointer}
      .gc-hint{margin:0;font-size:13px;line-height:1.4;color:var(--ph-dim)}.gc-hint b{font-weight:normal;color:var(--ph)}
      .gc-picker>[role=alert]{margin:0;color:var(--bad);font-size:13px}.gc-picker>[role=alert]:empty{display:none}
      .gc-picker-footer{display:flex;align-items:center;gap:8px;padding:10px 0 0;border-top:1px solid var(--ph-faint)}.gc-picker-footer .gc-delta{flex:1 1 auto;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim)}
      .gc-picker-footer .bb[disabled]{opacity:.45;cursor:default}.gc-picker-footer .bb.primary{color:var(--ph-bright);border-color:var(--ph-dim)}
    `; document.head.append(css);
    discover().catch(showError);
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
    if (active?.id === ws?.id) return;
    if (openedFileUrl) { URL.revokeObjectURL(openedFileUrl); openedFileUrl = null; openedFile = null; $('gc-preview').replaceChildren(); }
    if (active) composerDrafts.set(active.id, $('chat-input').value);
    active = ws; group = null; replyTo = null; selected = []; lastPaint = ''; generation++;
    clearTimeout(timer); $('gc-log').replaceChildren(); $('gc-states').replaceChildren(); $('gc-questions').replaceChildren(); $('chat-input').value = composerDrafts.get(ws?.id) || ''; draftKey = null; notice = ''; $('gc-notice').textContent = ''; $('gc-mentions').replaceChildren(); recipientLabel();
    if (enabled) poll(generation);
  }
  async function poll(gen) {
    try {
      const id = active.id, result = await api(null, '?id=' + encodeURIComponent(id));
      if (gen !== generation) return;
      group = result; paint();
    } catch (e) { if (gen === generation) showError(e); }
    if (gen === generation && active?.conversationMode === 'group') timer = setTimeout(() => poll(gen), 900);
  }
  function paint() {
    if (!group || group.id !== active?.id) return;
    const signature = JSON.stringify(group); if (lastPaint === signature) return; lastPaint = signature;
    const priorRevision = active.groupRevision;
    adopt(group);
    if (priorRevision !== group.revision) { active.groupRevision = group.revision; save(); }
    participantsHeader($('gc-header'), group.members, !!group.paused);
    const log = $('gc-log'), bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const previousRows = new Map([...log.querySelectorAll('[data-message-id]')].map(row => [row.dataset.messageId, row]));
    log.replaceChildren();
    /* Speaker on every reply. An agent's name is the reply affordance: click it and the next
       message goes to that agent (no button under every bubble). The agent's roster colour
       carries the rail and the name, so who-said-what reads at a glance across N speakers. */
    const speaker = (author, target) => {
      if (author === 'user') return h('span', { class: 'who' }, 'COMMANDER');
      const who = h('button', { type: 'button', class: 'who gc-who', 'aria-label': 'Reply to ' + name(author), onclick: () => { replyTo = target || null; selected = [author]; recipientLabel(); $('chat-input').focus(); } }, name(author).toUpperCase());
      return who;
    };
    for (const m of group.messages) {
      // brief.ask's fallback marker belongs to the durable question card, not a chat bubble.
      const content = (group.questions || []).some(q => q.turnId === m.turnId)
        ? m.content.replace(/(?:^|\n)TASK_QUESTION:[^\n]*(?:\n|$)/g, '\n').trim() : m.content;
      if (!content) continue;
      const attachments = (m.artifactIds || []).map(id => group.artifacts.find(f => f.id === id)).filter(Boolean);
      const rowKey = JSON.stringify([m, content, attachments, group.members, name(m.author), colorOf(m.author)]);
      let row = previousRows.get(m.id);
      if (!row || row._gcMessageKey !== rowKey) {
        row = h('article', { class: 'gc-message cmsg' + (m.author === 'user' ? ' user' : ' agent'), 'data-message-id': m.id });
        const body = h('div', { class: 'body' });
        if (typeof Chat !== 'undefined' && Chat.renderProse) Chat.renderProse(body, content); else body.textContent = content;
        const color = colorOf(m.author); if (color) row.style.setProperty('--gc-c', color);
        row.append(group.members.includes(m.author) ? speaker(m.author, m.id) : h('span', { class: 'who' }, name(m.author).toUpperCase()), body);
        if (m.partial) row.append(h('small', { class: 'gc-partial' }, 'partial · work did not complete'));
        if (attachments.length) renderMessageAttachments(row, group.id, attachments);
        row._gcMessageKey = rowKey;
      }
      log.append(row);
      for (const next of group.turns.filter(t => m.turnId && t.parent === m.turnId && !t.questionId && t.state !== 'stopped')) {
        log.append(h('div', { class: 'gc-transfer' }, next.recoveryOf ? name(next.agentId) + ' was asked to check a handoff that did not start' :
          name(m.author) + ' asked ' + name(next.agentId) + ' to follow up'));
      }
    }
    for (const t of group.turns) if (t.draft) {
      const row = h('article', { class: 'gc-message cmsg agent draft' }); const color = colorOf(t.agentId); if (color) row.style.setProperty('--gc-c', color);
      row.append(h('span', { class: 'who' }, name(t.agentId).toUpperCase()), h('div', { class: 'body' }, t.draft)); log.append(row);
    }
    if (bottom) log.scrollTop = log.scrollHeight;
    /* Turn state in the same voice as the direct chat's presence card: dot · NAME · verb.
       Truthful: 'running' only once the sidecar reports it; before that the word is 'connecting'. */
    const questions = $('gc-questions'); questions.replaceChildren();
    for (const q of (group.questions || []).filter(q => q.state === 'pending')) {
      const id = group.id, card = h('div', { class: 'gc-question', role: 'group', 'aria-label': name(q.agentId) + ' needs your answer' });
      card.append(h('div', { class: 'gc-verb' }, name(q.agentId) + ' · waiting for your answer'), h('p', {}, q.question));
      if (q.reason) card.append(h('p', {}, q.reason));
      if (q.sample) card.append(h('small', {}, 'A starting point · draft'), h('p', { style: 'white-space:pre-wrap' }, q.sample));
      const choices = h('div', { class: 'gc-question-choices' });
      for (const option of q.options) choices.append(button(option, () => {
        if (!q.multiSelect && q.mode !== 'conversation') return answerQuestion(id, q.id, option);
        const input = $('chat-input'); const parts = input.value ? input.value.split('; ') : [];
        if (!parts.includes(option)) parts.push(option); input.value = parts.join('; '); draftKey = null; input.focus();
      }));
      card.append(choices, h('small', {}, q.multiSelect ? 'Choose any that apply, then send your answer below.' : 'Choose an answer or reply in the message box.')); questions.append(card);
    }
    const states = $('gc-states'); states.replaceChildren();
    const VERB = { queued: 'queued', held: 'ready', connecting: 'connecting…', running: 'working', 'waiting for answer': 'waiting for your answer', 'waiting for approval': 'needs approval', stopping: 'stopping', failed: 'failed', interrupted: 'interrupted', stopped: 'stopped' };
    for (const t of group.turns.slice(-15)) {
      if (t.state === 'waiting for answer' && (group.questions || []).some(q => q.turnId === t.id && q.state === 'pending')) continue;
      const needsAttention = ['queued', 'held', 'queued', 'held', 'connecting', 'running', 'waiting for approval', 'waiting for answer', 'stopping'].includes(t.state) ||
        (t === group.turns.at(-1) && ['failed', 'interrupted'].includes(t.state));
      if (!needsAttention) continue;
      const tone = ['failed', 'interrupted'].includes(t.state) ? ' bad' : ['held', 'waiting for approval', 'queued', 'stopped'].includes(t.state) ? ' hold' : '';
      const row = h('div', { class: 'gc-state' + tone, 'data-turn-id': t.id });
      row.append(h('span', { class: 'gc-dot', 'aria-hidden': 'true' }, '●'), h('span', { class: 'gc-verb', style: colorOf(t.agentId) && !tone ? 'color:' + colorOf(t.agentId) : '' }, name(t.agentId)), h('span', { class: 'gc-what' }, t.quiet && ['connecting', 'running'].includes(t.state) ? 'no recent activity; still running' : t.reason && t.state === 'queued' ? t.reason : VERB[t.state] || t.state));
      if (t.state === 'held' && t.reason) row.append(h('span', { class: 'gc-what' }, t.reason));
      if (t.state === 'held') row.append(button('CONTINUE', () => action('continue')));
      if (['failed', 'interrupted', 'stopped'].includes(t.state)) row.append(button('RETRY', () => action('retry', { turnId: t.id })));
      if (t.approval) {
        row.append(h('div', { class: 'gc-approval' }, t.approval.tool + ' · ' + t.approval.argsSummary));
        for (const decision of ['once', 'deny']) row.append(button(decision === 'once' ? 'ALLOW ONCE' : 'DENY', async () => { await api({ op: 'answer', id: group.id, promptId: t.approval.promptId, decision }); }));
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
  function autocomplete() {
    const e = $('gc-mentions'); e.replaceChildren();
    if (!group) return;
    const input = $('chat-input'), match = input.value.slice(0, input.selectionStart).match(/(?:^|\s)@([\w-]*)$/);
    if (!match) return;
    const id = group.id, pos = input.selectionStart, original = input.value;
    for (const a of roster.filter(a => (a.name + ' ' + a.id).toLowerCase().includes(match[1].toLowerCase()))) {
      const member = group.members.includes(a.id);
      const b = button(member ? a.name + ' [' + a.id + ']' : 'Add ' + a.name + ' and mention', async () => {
        if (active?.id !== id) return;
        if (!member) {
          const result = await api({ op: 'invite', id, agentId: a.id });
          if (active?.id !== id) return;
          group = result; paint();
        }
        if (input.value !== original) { e.replaceChildren(); return; }
        const start = pos - match[1].length - 1;
        input.value = original.slice(0, start) + '@' + a.id + ' ' + original.slice(pos);
        draftKey = null; selected = []; replyTo = null; recipientLabel(); e.replaceChildren(); input.focus();
      }); b.setAttribute('role', 'option'); e.append(b);
    }
    if (roster.some(a => !group.members.includes(a.id))) e.append(h('small', {}, 'Adding an agent shares this conversation and its files.'));
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
      if (question && !/(?:^|\s)@/.test(value) && !recipients.length && !options.attachments?.length) {
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
      if (paused) await api({ op: 'control', id, action: 'resume' });
      const result = await api({ op: 'send', id, key, text: String(value || '').trim() || 'Please review the attached files.', replyTo: reply,
        recipients: /(?:^|\s)@/.test(value) ? [] : recipients, artifactIds });
      for (const file of options.attachments || []) sharedAttachments.delete(id + ':' + file.id);
      composerDrafts.delete(id);
      if (active?.id === id) { group = result; $('gc-mentions').replaceChildren(); selected = []; replyTo = null; draftKey = null; notice = ''; $('gc-notice').textContent = ''; paint(); }
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
  async function picker(convert) {
    if ($('gc-picker')) return;
    const origin = convert ? active : null;
    const dialog = h('div', { id: 'gc-picker', class: 'gc-picker' });
    const close = () => StationUI.closeTerm('group-agents');
    dialog.append(h('p', { role: 'status' }, 'Loading agents…'), button('CANCEL', close));
    StationUI.toggleTerm('group-agents', origin?.conversationMode === 'group' ? 'AGENTS IN THIS CHAT' : 'ADD AGENTS', body => body.replaceChildren(dialog), { onClose: () => dialog.remove() });
    try {
      if (App.pushRoster) await App.pushRoster();
      const info = await api(); roster = info.roster;
      const existing = origin?.conversationMode === 'group' ? await api(null, '?id=' + origin.id) : null;
      if (!dialog.isConnected) return;
      dialog.replaceChildren();
      /* Two lists, one verb each. IN THIS CHAT (remove with ✕) and ADD TO THIS CHAT (+ ADD moves the
         row up instantly). Nothing is a toggle you have to decode; the footer says exactly what SAVE
         will do ("+2 · −1"). The lead is marked and cannot be removed — someone must answer an
         unaddressed message. Search appears only when the crew is big enough to need it. */
      const initial = new Set(existing ? existing.members : [origin?.agentId || 'agent']);
      const chosen = new Set(initial);
      const leadId = existing?.leadId || origin?.agentId || 'agent';
      const dup = id => roster.filter(r => r.name === roster.find(a => a.id === id)?.name).length > 1;
      const label = id => name(id) + (dup(id) ? ' (' + id + ')' : '');
      const search = roster.length > 6 ? h('input', { type: 'search', class: 'key-input', placeholder: 'Find an agent by name', 'aria-label': 'Find an agent by name' }) : null;
      if (search) dialog.append(search);
      const inHead = h('div', { class: 'gc-sect-h' }), inList = h('div', { class: 'gc-sect-list', role: 'list', 'aria-label': 'Agents in this chat' });
      const outHead = h('div', { class: 'gc-sect-h' }), outList = h('div', { class: 'gc-sect-list', role: 'list', 'aria-label': 'Agents you can add' });
      const outEmpty = h('div', { class: 'gc-empty' });
      dialog.append(h('div', { class: 'gc-sect' }, null), h('div', { class: 'gc-sect' }, null));
      dialog.children[search ? 1 : 0].append(inHead, inList); dialog.children[search ? 2 : 1].append(outHead, outList, outEmpty);
      const hint = h('p', { class: 'gc-hint' }); dialog.append(hint);
      const errors = h('p', { role: 'alert' }); dialog.append(errors);
      const footer = h('div', { class: 'gc-picker-footer' }), delta = h('span', { class: 'gc-delta', 'aria-live': 'polite' });
      const saveBtn = button('SAVE', async () => {
        try {
          const members = roster.filter(a => chosen.has(a.id)).map(a => a.id);
          const data = { members, leadId: members.includes(leadId) ? leadId : members[0], title: existing?.title || origin?.title || 'Group chat' };
          const g = await api(existing ? { op: 'configure', id: existing.id, revision: existing.revision, ...data } : { op: 'create', ...(origin ? { id: origin.id, conversionKey: origin.id, history: origin.history, originalAgentId: origin.agentId } : {}), ...data });
          adopt(g); save(); close(); active = null; App.openWorkstream(g.id); if (typeof Chat !== 'undefined') Chat.load(Workstreams.get(g.id));
        } catch (e) { errors.textContent = e.message; }
      }); saveBtn.classList.add('primary');
      footer.append(delta, saveBtn, button('CANCEL', close)); dialog.append(footer);
      function row(a, inChat) {
        const r = h('div', { class: 'gc-row' + (inChat ? ' in' : ''), role: 'listitem', 'data-agent-name': label(a.id).toLowerCase() });
        const led = h('span', { class: 'gc-led', 'aria-hidden': 'true' }); if (colorOf(a.id)) led.style.background = colorOf(a.id);
        const idc = h('div', { class: 'gc-id' }); idc.append(h('span', { class: 'gc-nm' }, label(a.id)), h('span', { class: 'gc-tag' }, describe(a.id)));
        r.append(led, idc);
        if (inChat && a.id === leadId) r.append(h('span', { class: 'gc-lead', title: 'Answers when you do not @ anyone' }, 'lead'));
        else if (inChat) { const b = button('✕ REMOVE', () => { chosen.delete(a.id); render(); }); b.setAttribute('aria-label', 'Remove ' + label(a.id) + ' from this chat'); r.append(b); }
        else { const b = button('+ ADD', () => { chosen.add(a.id); render(); }); b.setAttribute('aria-label', 'Add ' + label(a.id) + ' to this chat'); r.append(b); }
        return r;
      }
      function render() {
        const q = (search?.value || '').toLowerCase();
        const ins = roster.filter(a => chosen.has(a.id)), outs = roster.filter(a => !chosen.has(a.id));
        inHead.replaceChildren('In this chat ', h('b', {}, String(ins.length)));
        outHead.replaceChildren('Add to this chat');
        inList.replaceChildren(...ins.map(a => row(a, true))); outList.replaceChildren(...outs.map(a => row(a, false)));
        for (const r of [...inList.children, ...outList.children]) r.hidden = !!q && !r.dataset.agentName.includes(q);
        outEmpty.replaceChildren();
        if (!outs.length) { outEmpty.append('Your whole crew is already in this chat. Recruit more under CREW.'); }
        const lead = chosen.has(leadId) ? leadId : ins[0]?.id;
        hint.replaceChildren('Talk to one agent with ', h('b', {}, '@name'), '. Without an @, ', h('b', {}, lead ? name(lead) : 'the lead'), ' answers. Everyone here sees the whole conversation and its shared files.');
        const added = [...chosen].filter(id => !initial.has(id)).length, removed = [...initial].filter(id => !chosen.has(id)).length;
        const parts = []; if (added) parts.push('+' + added + (added === 1 ? ' agent' : ' agents')); if (removed) parts.push('−' + removed + (removed === 1 ? ' agent' : ' agents'));
        delta.textContent = parts.length ? parts.join(' · ') : 'no changes yet';
        const changed = !!parts.length || (!existing && chosen.size > 1);
        saveBtn.disabled = !changed || !chosen.size; saveBtn.textContent = !existing && chosen.size > 1 ? 'START GROUP CHAT' : 'SAVE';
      }
      if (search) search.addEventListener('input', render);
      render();
    } catch (e) {
      if (!dialog.isConnected) return;
      dialog.replaceChildren(h('p', { role: 'alert' }, e.message || String(e)), button('RETRY', () => { close(); return picker(convert); }), button('CANCEL', close));
    }
  }
  async function rename(id, title) { const state = await api(null, '?id=' + encodeURIComponent(id)); await api({ op: 'configure', id, revision: state.revision, title }); return true; }
  async function remove(id) { await api({ op: 'control', id, action: 'delete' }); }
  async function pause(id) { await api({ op: 'control', id, action: 'pause' }); }
  return { bind, sendText, discover, rename, remove, pause, isBusy, stop };
})();
