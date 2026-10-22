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
  /* THE QUESTION CARD (group chat) reads at a glance and stays fluid (Andrew 2026-10-13: "tiny … unorganized and long and
     not even summarized" / "easy to comprehend and fluid"): who asks · the question, three lines at most (the answers are
     the keys under it; the whole question is one tap away) · the answers as full-width keys, the agent's suggestion lit
     and ★-marked · one plain line on how to answer · the reason and the draft folded on one line. Rebuilt only when ITS
     question changes (paint reconciles), so focus, hover, an open fold and a press survive the 900 ms poll. */
  const openFolds = new Set(), openWholes = new Set();
  const questionCards = new Map(), stateRows = new Map();   // keyed, reused while unchanged (paint reconciles them)
  // the message box as items: at each item an option is matched WHOLE (longest first, so an option that itself contains
  // ";" stays one pick and never lights a shorter one inside it); anything else the Commander typed is kept as written
  function pickItems(value, options) {
    const text = String(value || ''), sorted = options.slice().sort((a, b) => b.length - a.length), items = [];
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /[\s;]/.test(text[i])) i++;
      if (i >= text.length) break;
      const hit = sorted.find(o => o && text.startsWith(o, i) && /^\s*(?:;|$)/.test(text.slice(i + o.length)));
      if (hit) { items.push({ option: hit, text: hit }); i += hit.length; continue; }
      const j = text.indexOf(';', i);
      items.push({ option: null, text: (j < 0 ? text.slice(i) : text.slice(i, j)).trim() }); i = j < 0 ? text.length : j;
    }
    return items;
  }
  function pickedIn(value, options) { return new Set(pickItems(value, options).filter(x => x.option).map(x => x.option)); }
  function togglePick(value, option, options) {
    let items = pickItems(value, options);
    if (items.some(x => x.option === option)) items = items.filter(x => x.option !== option); else items.push({ option, text: option });
    return items.map(x => x.text).filter(Boolean).join('; ');
  }
  // a pick-several key shows ✓ exactly when its answer is in the message box — the box is the truth (you may edit it)
  function syncPicks(card) {
    if (!card || !card._picks) return;
    const box = $('chat-input'), on = pickedIn(box && box.value, [...card._picks.keys()]);
    for (const [option, key] of card._picks) {
      const pressed = on.has(option);
      key.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      key.textContent = (pressed ? '✓ ' : '') + (key._star ? '★ ' : '') + option;
    }
  }
  // "Show the whole question" shows exactly while the question is clamped; a question that cannot be measured (the strip
  // is hidden) keeps its key — re-measured whenever the strip changes size
  const wholeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(list => requestAnimationFrame(() => { for (const e of list) { const c = e.target.closest && e.target.closest('.gc-question'); if (c && c._fit) c._fit(); } })) : null;
  function questionCard(groupId, q) {
    const who = name(q.agentId), color = colorOf(q.agentId);
    const card = h('div', { class: 'gc-question', role: 'group', 'aria-label': who + ' asks you a question' });
    if (color) card.style.setProperty('--gc-c', color);
    const text = h('p', { class: 'gc-q-text' }, q.question);
    // who asks (and its place in a batch: one more tap ends it), then a cue when more is waiting below in the strip
    const seq = Number(q.total) > 1 && Number(q.ordinal) > 0 ? ' (' + q.ordinal + ' of ' + q.total + ')' : '';
    const cue = h('span', { class: 'gc-q-cue' });
    const whoLine = h('div', { class: 'gc-q-who' }); whoLine.append(who + ' asks' + seq, cue); card._cue = cue;
    card.append(whoLine, text);
    const whole = h('button', { type: 'button', class: 'gc-q-whole' }, '▸ Show the whole question');
    const setWhole = open => { card.classList.toggle('whole', open); whole.textContent = open ? '▾ Show less' : '▸ Show the whole question'; if (open) openWholes.add(q.id); else openWholes.delete(q.id); };
    whole.addEventListener('click', () => setWhole(!card.classList.contains('whole')));
    card.append(whole);
    if (openWholes.has(q.id)) setWhole(true);
    card._fit = () => { if (card.classList.contains('whole')) return; if (text.clientHeight > 0 && text.scrollHeight <= text.clientHeight + 2) whole.setAttribute('hidden', ''); else whole.removeAttribute('hidden'); };
    if (wholeObserver) wholeObserver.observe(text);
    const options = Array.isArray(q.options) ? q.options : [];
    const pickMany = q.multiSelect || q.mode === 'conversation';
    // the SAME law as the one-on-one card: the Commander's own history (a real count) outranks the agent's guess
    const g = q.grounded && Array.isArray(q.grounded.options) ? q.grounded.options.filter(o => options.includes(o)) : [];
    const gCount = Number(q.grounded && q.grounded.count) || 0, useGrounded = g.length > 0 && gCount >= 2 && q.mode !== 'conversation';
    const starred = useGrounded ? g : (q.recommended && options.includes(q.recommended) && q.mode !== 'conversation' ? [q.recommended] : []);
    const choices = h('div', { class: 'gc-question-choices' }), keys = [];
    const starLine = useGrounded ? (g.length > 1 ? ' ★ are your usual picks (chosen ' + gCount + '+ times before).' : ' ★ is your usual pick (chosen ' + gCount + ' times before).')
      : starred.length ? ' ★ is ' + who + '\'s suggestion.' : '';
    const howTo = q.multiSelect ? 'Pick all that apply, then send your answer below.' + starLine
      : q.mode === 'conversation' && options.length ? 'Tap a starting point or type your answer below, then send it.'
      : options.length ? 'Tap an answer, or type your own below.' + starLine : 'Type your answer below.';
    const hint = h('div', { class: 'gc-q-hint' }, howTo);
    let sending = false;   // one answer in flight per card, whatever fires the click
    for (const option of options) {
      const lit = starred.includes(option);
      const key = h('button', { type: 'button', class: 'gc-q-choice' + (lit ? ' lit' : '') }, (lit ? '★ ' : '') + option);
      key._star = lit;
      if (pickMany) key.setAttribute('aria-pressed', 'false');
      key.addEventListener('click', () => Promise.resolve().then(async () => {
        if (!pickMany) {
          // one tap answers: every key waits while it is on its way (no second answer), a refusal frees them again
          if (sending) return; sending = true;
          for (const k of keys) k.disabled = true; key.classList.add('chosen'); hint.textContent = 'Sending your answer…';
          try {
            const r = await answerQuestion(groupId, q.id, option);
            // the pressed key leaves with its card: the keyboard lands in the message box, never on <body>
            const a = document.activeElement; if ((!a || a === document.body || !a.isConnected) && $('chat-input')) $('chat-input').focus();
            return r;
          } catch (e) { sending = false; for (const k of keys) k.disabled = false; key.classList.remove('chosen'); hint.textContent = howTo; throw e; }
        }
        // pick several: each tap toggles that answer in the message box (the key keeps the focus); the keys follow the box
        const input = $('chat-input');
        input.value = togglePick(input.value, option, options); draftKey = null;
        syncPicks(card);
      }).catch(showError));
      keys.push(key); choices.append(key);
    }
    if (pickMany) card._picks = new Map(options.map((o, i) => [o, keys[i]]));
    if (options.length) card.append(choices);
    card.append(hint);
    const folds = h('div', { class: 'gc-q-folds' });
    if (q.reason) folds.append(questionFold(card, q.id + ':why', 'Why ' + who + ' is asking', q.reason, ''));
    if (q.sample) folds.append(questionFold(card, q.id + ':draft', 'See the draft ' + who + ' suggests', q.sample, 'gc-q-draft'));
    if (folds.children.length) card.append(folds);
    syncPicks(card);
    return card;
  }
  // the strip's scroller and its layout-px scale (TEXT SIZE is a body zoom)
  function trayScroller(node) { return node && node.closest ? node.closest('.gc-tray-scroll') : null; }
  function layoutScale(sc) { return sc.offsetHeight ? (sc.getBoundingClientRect().height / sc.offsetHeight) || 1 : 1; }
  // a labelled fold; the open/closed choice is remembered by key. Opening one brings its text into view only as far as the
  // card's top (the question) stays on screen, and closing it gives the strip back its place. A fold re-opened from memory
  // when its card is rebuilt never scrolls.
  function questionFold(card, key, label, text, cls) {
    const fold = h('details', { class: 'gc-q-more' });
    fold.append(h('summary', {}, label), h('p', { class: cls || '' }, text));
    let restoring = openFolds.has(key), before = null;
    if (restoring) fold.open = true;
    fold.addEventListener('toggle', () => {
      if (restoring) { restoring = false; return; }
      if (fold.open) openFolds.add(key); else openFolds.delete(key);
      if (openFolds.size > 50) openFolds.delete(openFolds.values().next().value);
      const sc = trayScroller(fold); if (!sc) return;
      if (!fold.open) { if (before != null) sc.scrollTop = before; before = null; return; }
      before = sc.scrollTop;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
        const k = layoutScale(sc), box = sc.getBoundingClientRect();
        const below = (fold.getBoundingClientRect().bottom - box.bottom) / k, room = (card.getBoundingClientRect().top - box.top) / k - 4;
        if (below > 0 && room > 0) sc.scrollTop += Math.min(below, room);
      });
    });
    return fold;
  }
  function showError(e) {
    notice = e.message || String(e); if ($('gc-notice')) $('gc-notice').textContent = notice;
    // a direct chat has no group notice line on screen: say it where the Commander is looking
    if (active?.conversationMode !== 'group' && typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(notice, 'bad');
  }
  async function api(body, query = '') {
    const r = await fetch('/api/groups' + query, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    if (r.status === 401 || r.status === 403) throw new Error('Reconnect to this station by refreshing the page. Your conversation is saved.');
    if (r.status === 404 && !body && !query) throw new Error('Group chat is unavailable on this server. Run the current Agent OS backend, then try again.');
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
  /* The group header: EVERY member by name in their roster colour (lead first), the count, and the + key (Andrew 10-04:
     "you cant even tell when the groupchat is there, it does not show all the agents"). No GROUP word in front of them —
     the names and the count say it (the no-shrunken-chips law, 10-13; walk 10-14 #18). ONE line: names that do not fit
     fold into "+N", which opens the full list, so a name never drops alone onto a second line. */
  function participantsHeader(element, ids, paused, leadId) {
    const order = leadId && ids.includes(leadId) ? [leadId, ...ids.filter(id => id !== leadId)] : ids.slice();
    const people = h('button', { type: 'button', class: 'gc-people', title: order.map(name).join(' · '), 'aria-label': 'Agents in this chat: ' + order.map(name).join(', ') + '. Add or remove agents', onclick: () => picker(true) });
    for (const id of order) {
      const p = h('span', { class: 'gc-person' + (id === leadId ? ' lead' : '') }, name(id));
      const c = colorOf(id); if (c) p.style.color = c;
      people.append(p);
    }
    const more = h('span', { class: 'gc-more', hidden: '' }); people.append(more);
    element.replaceChildren(people, h('span', { class: 'gc-count' }, ids.length + (ids.length === 1 ? ' agent' : ' agents')));
    if (paused) element.append(h('small', {}, 'Paused'));
    fitPeople(people);
  }
  // one line of names: hide from the end until it fits, and say how many are folded away
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
  /* Per-row description for the picker (the row's hover tip, never a line under the name): the class tagline when the agent was recruited from the
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
    /* THE TRAY (2026-10-10, Andrew: "wtf is this share BS … the user can't minimize that"). The shared-files shelf (40%),
       the pending questions (50%) and the turn-state rows (45%) used to stack under the transcript with caps adding up to
       135% — enough to squeeze the conversation to nothing, and the shelf (no overflow) spilled chips under the composer
       where they could not be clicked. Now everything below the transcript lives in ONE tray with ONE budget: the
       transcript always keeps most of the panel. Inside it, what needs the Commander (questions, approvals, live turns)
       scrolls first; the shared files fold to a single "▤ SHARED FILES · N" line that opens on click (remembered per group);
       an opened file shows in its own preview — no longer inside the shelf, so a message attachment previews even in a
       group with no shared files (that was the bug: the preview's parent was hidden whenever the shelf was empty). */
    const files = h('div', { class: 'gc-files' });
    files.append(h('button', { type: 'button', id: 'gc-files-tog', 'aria-expanded': 'false', onclick: () => toggleFiles() }), h('div', { id: 'gc-files', hidden: '' }));
    const preview = h('div', { id: 'gc-preview' });
    const transcript = h('div', { id: 'gc-log', role: 'log', 'aria-label': 'Group messages', 'aria-live': 'polite', class: 'scrolly' });
    const questions = h('div', { id: 'gc-questions' });
    const states = h('div', { id: 'gc-states', 'aria-live': 'polite' });
    const recipient = h('div', { id: 'gc-recipients' });
    // the @ menu is the COMPOSER's, not the group's: it sits over the message box in a direct chat too, so
    // "@finn" works from any chat (a direct chat becomes a group the moment a second agent is picked)
    const mentions = h('div', { id: 'gc-mentions', role: 'listbox', 'aria-label': 'Mention an agent' });
    $('chat-input').addEventListener('input', () => { draftKey = null; autocomplete(); for (const c of questionCards.values()) syncPicks(c); });
    $('chat-input').addEventListener('blur', () => setTimeout(() => { if (!mentionBusy && document.activeElement !== $('chat-input') && !$('gc-mentions')?.contains?.(document.activeElement)) closeMentions(); }, 150));
    const tray = h('div', { id: 'gc-tray', class: 'gc-tray' }), trayScroll = h('div', { class: 'gc-tray-scroll scrolly' });
    trayScroll.append(questions, states, preview); tray.append(trayScroll, files);
    trayScroll.addEventListener('scroll', () => trayEdge(trayScroll), { passive: true });
    root.append(transcript, tray, recipient, h('div', { id: 'gc-notice', role: 'status' }));
    $('chat-log').before(root);
    const row = $('chat-inputrow'); if (row) row.before(mentions); else root.append(mentions);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fitPeople($('gc-header')?.querySelector?.('.gc-people'))).observe(header);
    const css = h('style'); css.textContent = `
      #group-chat{position:relative;display:flex;flex:1 1 0;min-width:0;min-height:0;flex-direction:column;overflow:hidden;color:var(--text);background:transparent;padding:0;gap:0}
      #group-chat[hidden],#gc-header[hidden],#group-chat .gc-files[hidden],#group-chat #gc-files[hidden]{display:none}
      #gc-tray{flex:0 1 auto;min-height:0;max-height:45%;display:flex;flex-direction:column}#gc-tray:has(#gc-questions .gc-question){max-height:max(45%,calc(100% - 170px))}#gc-tray:not(:has(.gc-question,.gc-state,#gc-preview:not(:empty),.gc-files:not([hidden]))){display:none}
      #gc-tray .gc-tray-scroll{flex:0 1 auto;min-height:0;overflow-y:auto;scrollbar-color:var(--ph) transparent}
      #gc-tray .gc-tray-scroll.more-below{-webkit-mask-image:linear-gradient(#000 calc(100% - 28px),transparent);mask-image:linear-gradient(#000 calc(100% - 28px),transparent)}
      #comms-idbar{flex:0 0 auto;flex-wrap:nowrap}#comms-idbar.gc-group>.comms-agent-wrap,#comms-idbar.gc-group>#comms-agent-model,#chat-panel #comms-idbar.gc-group>.comms-identity,#chat-panel #comms-idbar.gc-group>.comms-portrait{display:none}
      #gc-header{display:flex;align-items:center;gap:10px;flex:1;min-width:0;color:var(--ph)}
      .gc-count{order:2;flex:0 0 auto;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim);white-space:nowrap}
      #gc-add-agents{flex:0 0 auto;white-space:nowrap}
      .gc-people{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px;row-gap:2px;flex:1 1 0;min-width:0;max-height:18px;overflow:hidden;margin:0;padding:0;border:0;background:none;font:inherit;text-align:left;cursor:pointer;color:var(--ph)}
      .gc-person{display:inline-block;font-size:15px;line-height:18px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-bright);white-space:nowrap;text-shadow:var(--pg-glow-soft,none)}.gc-person[hidden],.gc-more[hidden]{display:none}
      .gc-more{display:inline-block;font-size:var(--sn-type-control,16px);line-height:18px;letter-spacing:1px;color:var(--ph)}
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
      #gc-log>.gc-retired{flex:0 0 auto}#gc-log>.gc-retired .consent-result{display:block;margin-top:4px}
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
      .gc-files{flex:0 4 auto;display:flex;flex-direction:column;min-height:30px;border-top:1px solid var(--ph-faint);font-size:13px;background:linear-gradient(rgba(0,0,0,.18),rgba(0,0,0,.04))}
      #gc-files-tog{flex:0 0 auto;display:flex;align-items:center;gap:8px;width:100%;min-height:30px;margin:0;padding:4px 12px;border:0;border-radius:0;background:none;box-shadow:none;font:inherit;font-size:12px;letter-spacing:1px;text-transform:uppercase;text-align:left;color:var(--ph-dim);cursor:pointer}
      #gc-files-tog:hover,#gc-files-tog[aria-expanded=true]{color:var(--ph)}#gc-files-tog .gc-files-n{color:var(--ph-bright)}#gc-files-tog .gc-files-caret{margin-left:auto}
      #gc-files{flex:0 1 auto;min-height:0;max-height:132px;overflow-y:auto;display:flex;align-items:center;align-content:flex-start;gap:6px;flex-wrap:wrap;padding:0 12px 8px;scrollbar-color:var(--ph-dim) transparent}
      #gc-files .gc-file{display:inline-flex;align-items:baseline;gap:5px;max-width:100%;margin:0;padding:2px 8px;min-height:22px;font-size:12px;letter-spacing:.3px;border:1px solid var(--ph-faint);border-radius:var(--r-sm,3px);background:rgba(var(--ph-rgb),.03);color:var(--ph);cursor:pointer;box-shadow:none}
      #gc-files .gc-file:hover,#gc-files .gc-file.open{border-color:var(--ph-dim);background:rgba(var(--ph-rgb),.055);color:var(--ph-bright)}#gc-files .gc-file .tc-glyph{color:var(--ph-dim)}#gc-files .gc-file span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #gc-preview{padding:0 12px 8px;border-top:1px solid var(--ph-faint)}#gc-preview:empty{display:none}#gc-preview .gc-preview-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;white-space:normal}#gc-preview .gc-preview-head h4{flex:1 1 auto;min-width:0}#gc-preview h4{margin:6px 0 2px;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:var(--ph)}#gc-preview small{color:var(--ph-dim);font-size:11px;margin-right:10px}
      #gc-preview{overflow-wrap:anywhere}#gc-preview .gc-doc .body{white-space:pre-wrap}#gc-preview .gc-doc .body:has(.md-p,.md-h,.md-list){white-space:normal}#gc-preview a{color:var(--ph);font-size:11px;letter-spacing:1px}#gc-preview .gc-message{margin-top:6px}
      #gc-states{padding:0 12px 4px}#gc-states:empty{display:none}
      .gc-state{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:4px 0 2px;padding:6px 11px;border-left:2px solid var(--ph);border-radius:0 4px 4px 0;background:linear-gradient(180deg,var(--ph-faint),rgba(0,0,0,.25));font-size:15px;letter-spacing:.5px;color:var(--ph-bright)}
      .gc-state .gc-dot{flex:0 0 auto;color:var(--ph);text-shadow:0 0 6px var(--ph-glow);animation:1s steps(1) infinite comms-blink}.gc-state .gc-verb{letter-spacing:1.5px;text-transform:uppercase}.gc-state .gc-what{color:var(--text);font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .gc-state.hold{border-left-color:var(--gold);background:linear-gradient(180deg,color-mix(in srgb,var(--gold) 14%,transparent),rgba(0,0,0,.25))}.gc-state.hold .gc-dot,.gc-state.hold .gc-verb{color:var(--gold);animation:none;text-shadow:none}
      .gc-state.bad{border-left-color:var(--bad)}.gc-state.bad .gc-dot,.gc-state.bad .gc-verb{color:var(--bad);animation:none;text-shadow:none}
      .gc-state .gc-inspect summary{cursor:pointer;list-style:none;text-wrap:pretty}.gc-state .gc-inspect summary::-webkit-details-marker{display:none}.gc-state .gc-inspect summary::before{content:'▸ '}.gc-state .gc-inspect[open] summary::before{content:'▾ '}#gc-states .gc-state .gc-what.gc-asks{flex:1 1 auto;font-size:var(--sn-type-control,16px)!important;line-height:1.4;color:var(--ph-bright);overflow:visible;overflow-wrap:anywhere;white-space:normal;text-wrap:pretty}.gc-state .gc-ok-row{flex:1 0 100%;display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 2px}.gc-state .gc-inspect pre{max-height:240px;overflow:auto;margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;font-family:inherit}.gc-state .gc-ok{min-width:8em;min-height:36px;padding:6px 14px;font:inherit;font-size:var(--sn-type-control,16px);line-height:1.2;letter-spacing:.2px;color:var(--ph-bright);border:1px solid var(--beat-edge);border-radius:5px;background:rgba(var(--ph-rgb),.04);box-shadow:inset 0 1px 0 var(--beat-light);text-shadow:none;cursor:pointer}.gc-state .gc-ok.lit{border-color:rgba(var(--gold-rgb),.55);background:linear-gradient(140deg,rgba(var(--gold-rgb),.15),rgba(var(--ph-rgb),.04))}.gc-state .gc-ok.deny{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,transparent);background:color-mix(in srgb,var(--bad) 5%,transparent)}.gc-state .gc-ok:hover:not(:disabled){background:var(--beat-hover)}.gc-state .gc-ok:disabled{opacity:.55;cursor:default}.gc-state .gc-ok:focus-visible{outline:2px solid var(--ph);outline-offset:2px}#gc-states .gc-state .gc-approval:not(.gc-inspect){font-size:var(--sn-type-control,16px)!important;color:var(--ph-bright);opacity:1}#gc-states .gc-state .gc-inspect :is(summary,pre){font-size:var(--sn-type-control,16px)!important;line-height:1.45}.gc-state .gc-approval{flex:1 0 100%;font-size:14px;line-height:1.45;color:var(--text);opacity:.9;overflow-wrap:anywhere}.gc-state .bb{margin-left:auto!important;font-size:15px!important;min-height:34px!important;padding:0 14px!important}.gc-state .bb+.bb{margin-left:0!important}
      #gc-questions:empty{display:none}#gc-questions{padding:2px 12px 6px}.gc-question{margin:6px 0;padding:13px 15px;border:1px solid rgba(var(--ph-rgb),.2);border-left:2px solid var(--gc-c,rgba(var(--gold-rgb),.62));border-radius:5px;background:var(--cg-card,var(--beat-face));box-shadow:none;color:var(--text);text-shadow:none;overflow-wrap:anywhere;font-variant-ligatures:none}.gc-question .gc-q-who{font-size:var(--sn-type-meta,14px);line-height:1.3;letter-spacing:1.2px;text-transform:uppercase;color:var(--gc-c,var(--gold))}.gc-question .gc-q-cue{color:var(--text);opacity:.85}.gc-question .gc-q-more>summary{list-style:none}.gc-question .gc-q-more>summary::-webkit-details-marker{display:none}.gc-question .gc-q-more>summary::before{content:'▸ '}.gc-question .gc-q-more[open]>summary::before{content:'▾ '}.gc-question .gc-q-hint,.gc-question .gc-q-more>summary{text-wrap:pretty}.gc-question .gc-q-text{margin:6px 0 2px;font-size:var(--sn-type-prose,18px);line-height:1.45;color:var(--ph-bright);white-space:pre-wrap;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.gc-question.whole .gc-q-text{display:block;-webkit-line-clamp:unset;max-height:calc(1.45em * 7);overflow-y:auto}.gc-question .gc-q-whole{display:block;margin:2px 0 0;padding:3px 0;font:inherit;font-size:var(--sn-type-meta,14px);letter-spacing:.3px;color:var(--ph);background:none;border:0;box-shadow:none;text-shadow:none;cursor:pointer}.gc-question .gc-q-whole[hidden]{display:none}.gc-question .gc-q-whole:focus-visible{outline:2px solid var(--ph);outline-offset:2px}.gc-question-choices{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:10px 0}.gc-question .gc-q-choice{min-height:36px;width:100%;padding:6px 14px;font:inherit;font-size:var(--sn-type-control,16px);line-height:1.25;letter-spacing:.2px;text-align:left;white-space:normal;color:var(--ph-bright);border:1px solid var(--beat-edge);border-radius:5px;background:rgba(var(--ph-rgb),.04);box-shadow:inset 0 1px 0 var(--beat-light);text-shadow:none;cursor:pointer}.gc-question .gc-q-choice.lit{border-color:rgba(var(--gold-rgb),.55);background:linear-gradient(140deg,rgba(var(--gold-rgb),.15),rgba(var(--ph-rgb),.04))}.gc-question .gc-q-choice:hover:not(:disabled){background:var(--beat-hover);border-color:var(--ph-dim)}.gc-question .gc-q-choice[aria-pressed=true],.gc-question .gc-q-choice.chosen{border-color:var(--ph-bright);background:linear-gradient(140deg,rgba(var(--gold-rgb),.32),rgba(var(--ph-rgb),.08))}.gc-question .gc-q-choice:disabled{cursor:default;opacity:.55}.gc-question .gc-q-choice.chosen:disabled{opacity:1}.gc-question .gc-q-choice:focus-visible{outline:2px solid var(--ph);outline-offset:3px}.gc-question .gc-q-hint{font-size:var(--sn-type-meta,14px);line-height:1.4;color:var(--text);opacity:.85}.gc-question .gc-q-folds{display:flex;flex-wrap:wrap;gap:2px 22px;margin-top:6px}.gc-question .gc-q-folds>details[open]{flex-basis:100%}.gc-question .gc-q-more>summary{cursor:pointer;padding:3px 0;font-size:var(--sn-type-meta,14px);letter-spacing:.3px;color:var(--ph)}.gc-question .gc-q-more>summary:focus-visible{outline:2px solid var(--ph);outline-offset:2px}.gc-question .gc-q-more>p{margin:6px 0 2px;font-size:var(--sn-type-control,16px);line-height:1.5;color:var(--text);white-space:pre-wrap}.gc-question .gc-q-more>p.gc-q-draft{padding:10px 12px;border:1px solid var(--beat-edge);border-radius:5px;background:rgba(0,0,0,.2)}.gc-message .gc-asked{margin:0 0 4px;font-size:var(--sn-type-meta,14px);line-height:1.4;color:var(--text);opacity:.8;font-variant-ligatures:none}.gc-transfer{color:var(--ph-dim);font-size:12px;padding:2px 0 5px 14px;flex:0 0 auto}.gc-transfer{color:var(--ph-dim);font-size:12px;padding:2px 0 5px 14px;flex:0 0 auto}
      #gc-notice:empty{display:none}#gc-notice{flex:0 0 auto;padding:4px 12px;font-size:13px;color:var(--gold);overflow-wrap:anywhere}
      /* the picker IS its window's height: the two lists share it and scroll on their own, the how-to line and the footer stay
         in the flow under them (min-height:100% let it grow past the window, and the sticky footer then sat over the how-to
         line, which showed through its 95%-alpha panel — walk 10-14 #9). The ADD list keeps a floor of two agents and the
         members list gives way first, to one; below both floors the window body scrolls, the how-to line and footer still in
         the flow (review 10-14: at min-height:0 a 5-member group showed no agent to add on a window 80px shorter). The floors
         count in rows: the 38px portrait + its padding + its 1px rule (8px here, 11px in glass-comms.css), plus the list's 1px frame. */
      .gc-picker{--gc-row-h:55px;--gc-head-h:22px;min-width:0;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px}.gc-picker>.key-input{flex:0 0 auto;display:block;width:100%;box-sizing:border-box;margin:0}
      .gc-sect{display:flex;flex-direction:column;min-width:0;min-height:0}.gc-sect.in{flex:0 1 auto;min-height:calc(var(--gc-head-h) + var(--gc-row-h) + 2px)}.gc-sect.out{flex:1 1 0;min-height:calc(var(--gc-head-h) + 2 * var(--gc-row-h) + 2px)}
      body.glass-demo .gc-picker{--gc-row-h:61px}
      .gc-sect-h{flex:0 0 auto;display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:var(--sn-type-meta,14px);line-height:18px;letter-spacing:1.5px;text-transform:uppercase;color:var(--ph-dim)}.gc-sect-h b{font-weight:normal;color:var(--ph)}
      .gc-sect-list{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid var(--ph-faint);border-radius:3px;background:rgba(0,0,0,.18)}.gc-sect-list:empty{display:none}.gc-sect.in .gc-sect-list{flex:0 1 auto;max-height:min(30vh,174px)}
      .gc-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--ph-faint);min-width:0}.gc-row:last-child{border-bottom:0}.gc-row[hidden]{display:none}
      .gc-row .gc-led{flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:var(--ph-dim)}.gc-row.in .gc-led{box-shadow:0 0 6px var(--ph-glow)}
      .gc-row .gc-pic{flex:0 0 auto;display:flex;line-height:0}.gc-row .gc-av{border-radius:5px;background:rgba(0,0,0,.34);box-shadow:inset 0 0 0 1px rgba(var(--ph-rgb),.22),inset 0 1px 3px rgba(0,0,0,.15)}
      .gc-row .gc-id{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}.gc-row .gc-nm{font-size:14px;letter-spacing:1px;text-transform:uppercase;color:var(--ph-bright);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .gc-row.in .gc-nm{color:var(--ph)}.gc-row .bb{flex:0 0 auto;min-width:74px;text-align:center}.gc-row.in .bb{color:var(--ph-dim)}.gc-row.in .bb:hover{color:var(--bad);border-color:var(--bad);background:transparent}
      .gc-row .bb[disabled]{opacity:.45;cursor:default}
      .gc-row .gc-lead{flex:0 0 auto;font-size:var(--sn-type-meta,14px);letter-spacing:1px;text-transform:uppercase;color:var(--gold)}
      .gc-empty{padding:10px;font-size:13px;line-height:1.4;color:var(--ph-dim)}.gc-empty:empty{display:none}.gc-empty a{color:var(--ph);cursor:pointer}
      .gc-hint{flex:0 0 auto;margin:0;font-size:var(--sn-type-meta,14px);line-height:1.4;color:var(--ph-dim)}.gc-hint b{font-weight:normal;color:var(--ph)}
      .gc-picker>[role=alert]{flex:0 0 auto;margin:0;color:var(--bad);font-size:var(--sn-type-meta,14px)}.gc-picker>[role=alert]:empty{display:none}
      .gc-picker-footer{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 0 0;border-top:1px solid var(--ph-faint)}.gc-picker-footer .gc-delta{flex:1 1 auto;font-size:var(--sn-type-meta,14px);letter-spacing:1px;text-transform:uppercase;color:var(--ph-dim)}
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
  // the message box says who hears it: everyone in the group, or — while a question waits — whom the reply answers
  function setGroupPlaceholder() {
    const box = $('chat-input'); if (!box || active?.conversationMode !== 'group') return;
    const waiting = group && group.id === active.id ? (group.questions || []).find(q => q.state === 'pending') : null;
    box.placeholder = waiting ? 'Answer ' + name(waiting.agentId) + ' · @name messages someone else' : 'Message the group · @ picks one agent';
  }
  // the strip never ends on a half-drawn line: while more is below, its last rows fade out
  function trayEdge(sc) { if (sc && sc.classList) sc.classList.toggle('more-below', sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2); }
  function bind(ws) {
    init(); settleStaleJoins(); if (!root) return;
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
      if (enabled) { if (basePlaceholder == null) basePlaceholder = input.placeholder || ''; input.placeholder = 'Message the group · @ picks one agent'; if (active?.id === ws?.id) setGroupPlaceholder(); }
      else if (basePlaceholder != null) { input.placeholder = basePlaceholder; basePlaceholder = null; }
    }
    if (active?.id === ws?.id) return;
    // the ADD AGENTS window edits ONE session: leaving it for another closes the window (it would edit the wrong chat)
    if (pickerFor && pickerFor !== ws?.id && $('gc-picker') && typeof StationUI !== 'undefined') StationUI.closeTerm('group-agents');
    if (openedFileUrl) { URL.revokeObjectURL(openedFileUrl); openedFileUrl = null; openedFile = null; $('gc-preview').replaceChildren(); }
    // …and the previous group's inline shared images: the log is emptied below, so nothing shows these URLs any more
    // (a read that failed made no URL, so there is nothing to release for it — it already showed as not found)
    for (const p of sharedBlobs.values()) p.then(u => URL.revokeObjectURL(u), () => {});
    sharedBlobs.clear();
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
  /* A REPLY'S FLOW (rc walk 2026-10-14). The group transcript glued the lead's streamed sentences together ("Let me configure
     it:The steps are locked.") and showed none of its tool calls. A reply that made visible calls carries its flow from the
     host (sidecar group-sessions.js: the prose as it streamed + each call's offset into it); it is drawn the way the
     one-on-one chat draws a run — said → did → said — with the same chips (Chat.toolRailOf). `clean` is the finished
     message's marker rule; a still-streaming draft (`live`) never shows a choice marker, complete or half-typed. */
  function renderFlow(body, text, steps, files, clean, live) {
    // a streaming draft re-renders on every token or poll: a chip the Commander opened stays open (keyed by its call id)
    const opened = new Set(Array.from(body.querySelectorAll('.tool-chip.open')).map(c => c.dataset && c.dataset.callId).filter(Boolean));
    body.replaceChildren();
    const src = String(text == null ? '' : text);
    const list = (Array.isArray(steps) ? steps : []).slice().sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    const shownOf = s => (live && typeof Fork !== 'undefined' && Fork.liveText) ? Fork.liveText(s) : clean ? clean(s) : s;
    const prose = s => {
      const shown = String(shownOf(s) || '').trim();
      if (!shown) return;
      const seg = h('div', { class: 'gc-seg' });
      if (typeof Chat !== 'undefined' && Chat.renderProse) Chat.renderProse(seg, shown, { files }); else seg.textContent = shown;
      body.append(seg);
    };
    const offset = s => Math.max(0, Math.min(src.length, Number(s && s.at) || 0));
    let from = 0, i = 0;
    while (i < list.length) {
      const at = Math.max(from, offset(list[i])), batch = [];
      while (i < list.length && Math.max(from, offset(list[i])) === at) batch.push(list[i++]);
      prose(src.slice(from, at));
      if (typeof Chat !== 'undefined' && Chat.toolRailOf) body.append(Chat.toolRailOf(batch));
      from = at;
    }
    prose(src.slice(from));
    if (opened.size) for (const c of Array.from(body.querySelectorAll('.tool-chip'))) {
      if (!(c.dataset && opened.has(c.dataset.callId))) continue;
      c.classList.add('open');
      const head = c.querySelector('.tc-head'); if (head) head.setAttribute('aria-expanded', 'true');
    }
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
    /* A STOP WHILE AN APPROVAL WAITED retires that card here, in the one-on-one card's words (live walk 2026-10-14: the card
       just vanished): right under the reply it interrupted, or — when the turn had said nothing — where the turn ended. */
    const retiredAt = new Map();   // message id -> turns whose unanswered approval follows it
    const shown = group.messages.filter(m => String(m.content || '').trim());
    for (const t of group.turns) if (t.unansweredApproval) {
      const at = shown.find(m => m.turnId === t.id) || shown.filter(m => !t.endedAt || (Number(m.at) || 0) <= t.endedAt).at(-1) || shown.find(m => m.id === t.origin);
      if (at) retiredAt.set(at.id, (retiredAt.get(at.id) || []).concat(t));
    }
    const turnOf = id => (id ? group.turns.find(t => t.id === id) : null);
    for (const m of group.messages) {
      // brief.ask's fallback marker belongs to the durable question card, not a chat bubble. A marker no card claimed
      // (a FORK, or a TASK_QUESTION the host never registered) reads as its question and options — never machine syntax.
      const asks = (group.questions || []).some(q => q.turnId === m.turnId);
      const content = (typeof Fork === 'undefined' || m.author === 'user') ? m.content : asks ? Fork.stripMarkers(m.content) : Fork.readable(m.content);
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
      const askedQ = m.questionId ? (group.questions || []).find(q => q.id === m.questionId) : null;
      // a reply the Commander STOPPED says so; any other unfinished one stays "partial" (failed, cut off)
      const endedTurn = m.partial ? turnOf(m.turnId) : null;
      const unfinished = endedTurn && endedTurn.state === 'stopped' && /^stopped by you$/i.test(String(endedTurn.reason || '')) ? 'stopped by you · work did not complete' : 'partial · work did not complete';
      const rowKey = JSON.stringify([m, content, attachments, group.members, name(m.author), colorOf(m.author), clock, askedQ && askedQ.question, m.partial && unfinished]);
      const row = keep('m:' + m.id, rowKey, () => {
        const row = h('article', { class: 'gc-message cmsg' + (m.author === 'user' ? ' user' : ' agent'), 'data-message-id': m.id });
        const body = h('div', { class: 'body' });
        if (m.author !== 'user' && m.flow && Array.isArray(m.flow.steps) && m.flow.steps.length && typeof Chat !== 'undefined' && Chat.toolRailOf)
          renderFlow(body, m.flow.text, m.flow.steps, fileRefs(group.id, m.author, m.id), s => (typeof Fork === 'undefined' ? s : asks ? Fork.stripMarkers(s) : Fork.readable(s)), false);
        else if (typeof Chat !== 'undefined' && Chat.renderProse) Chat.renderProse(body, content, { files: fileRefs(group.id, m.author, m.id) }); else body.textContent = content;
        const color = colorOf(m.author); if (color) { row.style.setProperty('--gc-c', color); body.style.setProperty('--rail', color); }
        const who = group.members.includes(m.author) ? speaker(m.author, m.id) : h('span', { class: 'who' }, name(m.author).toUpperCase());
        // the answer to a question keeps its question (the card leaves the strip once answered)
        const asked = askedQ ? h('div', { class: 'gc-asked' }, name(askedQ.agentId) + ' asked: ' + (String(askedQ.question || '').length > 140 ? String(askedQ.question).slice(0, 139) + '…' : String(askedQ.question || ''))) : null;
        if (at) {
          const head = h('span', { class: 'cmsg-head' }); head.append(who, h('span', { class: 'cmsg-ts' }, clock));
          row.dataset.ts = String(at.getTime()); row.append(head); if (asked) row.append(asked); row.append(body);
        } else { row.append(who); if (asked) row.append(asked); row.append(body); }
        if (m.partial) row.append(h('small', { class: 'gc-partial' }, unfinished));
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
      for (const t of retiredAt.get(m.id) || []) {
        const ask = t.unansweredApproval;
        const phrase = typeof Chat !== 'undefined' && Chat.consentPhrase ? String(Chat.consentPhrase(ask) || '').trim() : '';
        const said = '▣ ' + name(t.agentId) + ' wants to ' + (phrase || String(ask.tool || 'take an action')) + ' ';
        keep('ra:' + t.id, said, () => {
          const card = h('div', { class: 'cmsg agent tool consent gc-retired', role: 'note' }), body = h('div', { class: 'body' });
          body.append(said, h('span', { class: 'consent-result err' }, '■ the run ended before an answer — nothing was approved'));
          card.append(body);
          return card;
        });
        prevAuthor = null;
      }
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
    for (const t of group.turns) if (t.draft || (t.draftSteps && t.draftSteps.length)) {
      // a streaming reply keeps its row; only its flow moves (prose + the calls it made so far, like the one-on-one chat)
      const n = keep('dr:' + t.id, name(t.agentId) + colorOf(t.agentId), () => {
        const row = h('article', { class: 'gc-message cmsg agent draft' }), body = h('div', { class: 'body' }); const color = colorOf(t.agentId);
        if (color) { row.style.setProperty('--gc-c', color); body.style.setProperty('--rail', color); }
        row.append(h('span', { class: 'who' }, name(t.agentId).toUpperCase()), body); row._gcBody = body; return row;
      });
      const draftSig = JSON.stringify([t.draft || '', t.draftSteps || []]);
      if (n._gcBody && n._gcDraftSig !== draftSig) { n._gcDraftSig = draftSig; renderFlow(n._gcBody, t.draft || '', t.draftSteps || [], fileRefs(group.id, t.agentId, 'draft:' + t.id), null, true); }
    }
    for (let i = 0; i < nodes.length; i++) { const cur = log.children[i]; if (cur !== nodes[i]) log.insertBefore(nodes[i], cur || null); }
    while (log.children.length > nodes.length) log.lastElementChild.remove();
    /* Turn state in the same voice as the direct chat's presence card: dot · NAME · verb.
       Truthful: 'running' only once the sidecar reports it; before that the word is 'connecting'. */
    /* A QUESTION READS AT A GLANCE (Andrew 2026-10-13: "tiny cards with tiny little letters … long and not summarized"):
       who asks, the question in reading size, the answers as real keys, one plain line on how to answer. The model's
       reason and its draft are kept — each one tap away behind a labelled fold, never a wall of text under the keys.
       RECONCILED like the transcript: a card is rebuilt only when ITS question changes, so a key you are hovering,
       tabbing to or pressing while another agent streams is never swapped out from under you. */
    const questions = $('gc-questions'), qNodes = [];
    for (const q of (group.questions || []).filter(q => q.state === 'pending')) {
      const sig = JSON.stringify([q.question, q.options, q.multiSelect, q.mode, q.reason, q.sample, name(q.agentId), colorOf(q.agentId)]);
      let card = questionCards.get(q.id);
      if (!card || card._gcSig !== sig) { card = questionCard(group.id, q); card._gcSig = sig; questionCards.set(q.id, card); }
      qNodes.push(card);
    }
    for (const [qid, node] of questionCards) if (!qNodes.includes(node)) questionCards.delete(qid);
    for (const n of [...questions.children]) if (!qNodes.includes(n)) n.remove();
    let arrived = null;
    for (let i = 0; i < qNodes.length; i++) { const cur = questions.children[i]; if (cur !== qNodes[i]) { if (!qNodes[i].parentElement && !arrived) arrived = qNodes[i]; questions.insertBefore(qNodes[i], cur || null); } }
    for (const c of qNodes) syncPicks(c);
    // more waiting under the first card (a second question, an approval) is said on its who line, in the same font
    const approvalsWaiting = group.turns.filter(t => t.approval && t.state === 'waiting for approval').length;
    qNodes.forEach((c, i) => { if (c._cue) { const more = i === 0 ? qNodes.length - 1 + approvalsWaiting : 0; c._cue.textContent = more ? ' · ' + more + ' more waiting below' : ''; } });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
      for (const c of qNodes) if (c._fit) c._fit();
      // a question that just arrived shows from its top (who asks, what) — never its keys with the question cut off above
      const sc = questions.parentElement;
      if (arrived && sc && arrived.getBoundingClientRect) sc.scrollTop += (arrived.getBoundingClientRect().top - sc.getBoundingClientRect().top) / layoutScale(sc) - 4;
      trayEdge(sc);
    });
    setGroupPlaceholder();
    const states = $('gc-states'), stateNodes = [];
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
      const showContinue = t.state === 'queued' && group.paused && !continueShown; if (showContinue) continueShown = true;
      const rowSig = JSON.stringify([t.state, t.reason, t.quiet, t.agentId, t.approval, tone, group.paused, showContinue, pendingQ && pendingQ.agentId, name(t.agentId), colorOf(t.agentId)]);
      const kept = stateRows.get(t.id);
      if (kept && kept._gcSig === rowSig) { stateNodes.push(kept); continue; }
      const row = h('div', { class: 'gc-state' + tone, 'data-turn-id': t.id });
      row._gcSig = rowSig; stateRows.set(t.id, row); stateNodes.push(row);
      // a queued turn says WHY it waits: the pause, or a question someone else owes an answer to
      const what = t.quiet && ['connecting', 'running'].includes(t.state) ? 'no recent activity; still running'
        : t.state === 'queued' && group.paused ? 'paused — CONTINUE runs it, or send a new message'
        : t.state === 'queued' && pendingQ && pendingQ.agentId !== t.agentId ? 'waits for your answer to ' + name(pendingQ.agentId)
        : t.reason && t.state === 'queued' ? t.reason : VERB[t.state] || t.state;
      const phrase = t.approval && typeof Chat !== 'undefined' && Chat.consentPhrase ? String(Chat.consentPhrase(t.approval) || '').trim() : '';
      const said = t.approval ? (phrase ? 'wants to ' + phrase : 'needs approval: ' + String(t.approval.tool || 'an action')) : what;
      row.append(h('span', { class: 'gc-dot', 'aria-hidden': 'true' }, '●'), h('span', { class: 'gc-verb', style: colorOf(t.agentId) && (!tone || t.approval) ? 'color:' + colorOf(t.agentId) : '' }, name(t.agentId)), h('span', { class: t.approval ? 'gc-what gc-asks' : 'gc-what' }, said));
      if (showContinue) row.append(button('CONTINUE', () => action('resume')));
      if (t.state === 'held' && t.reason) row.append(h('span', { class: 'gc-what' }, t.reason));
      if (t.state === 'held') row.append(button('CONTINUE', () => action('continue')));
      if (['failed', 'interrupted', 'stopped'].includes(t.state)) row.append(button('RETRY', () => action('retry', { turnId: t.id })));
      if (t.approval) {
        // the keys first (line one), the argument text under them: a short window clips text, never the decision
        const keys = [], gid = group.id, pid0 = t.approval.promptId, tool0 = String(t.approval.tool || '');
        const labels = tool0 === 'browser.login' ? ['Open login window', 'Deny'] : tool0 === 'browser.login.done' ? ['Done — I\'ve logged in', 'Cancel'] : ['Approve once', 'Deny'];
        ['once', 'deny'].forEach((decision, i) => {
          const k = h('button', { type: 'button', class: 'gc-ok' + (i ? ' deny' : ' lit') }, labels[i]);
          k.addEventListener('click', () => Promise.resolve().then(async () => {
            if (k.disabled) return;
            for (const x of keys) x.disabled = true; k.textContent = i ? (tool0 === 'browser.login.done' ? 'Cancelling…' : 'Denying…') : 'Sending…';
            try { await api({ op: 'answer', id: gid, promptId: pid0, decision }); }
            catch (e) { for (const x of keys) x.disabled = false; k.textContent = labels[i]; throw e; }
          }).catch(showError));
          keys.push(k);
        });
        const keyRow = h('div', { class: 'gc-ok-row' }); keyRow.append(...keys); row.append(keyRow);
        // every character of the request is one click away under the keys — exactly where the desk card offers it
        // (Chat.consentInspect: a file change as a file, a command as a command; none for a login or a station sentence)
        const ins = typeof Chat !== 'undefined' && Chat.consentInspect ? Chat.consentInspect(t.approval) : null;
        if (ins) {
          const pid = t.approval.promptId;
          const detail = h('details', { class: 'gc-approval gc-inspect', ontoggle: () => { if (detail.open) inspectOpen.add(pid); else inspectOpen.delete(pid); } });
          detail.open = inspectOpen.has(pid);   // a re-render keeps the panel the Commander opened
          const idle = ins.copyLabel || 'COPY';
          const copy = h('button', { type: 'button', class: 'bb gc-copy' }, idle);
          copy.addEventListener('click', () => {
            const done = ok => { copy.textContent = ok ? '✓ COPIED' : 'COPY FAILED: select the text'; setTimeout(() => { copy.textContent = idle; }, 1400); };
            const text = ins.copy || ins.text;   // Chat.copyText falls back to a selection copy where the clipboard API is refused
            try { (typeof Chat !== 'undefined' && Chat.copyText ? Chat.copyText(text) : navigator.clipboard.writeText(text).then(() => true)).then(done, () => done(false)); } catch (_) { done(false); }
          });
          detail.append(h('summary', {}, ins.label || 'Inspect the full request (secrets redacted)'), h('pre', {}, ins.text), copy);
          row.append(detail);
        }
      }
    }
    for (const [tid, node] of stateRows) if (!stateNodes.includes(node)) stateRows.delete(tid);
    for (const n of [...states.children]) if (!stateNodes.includes(n)) n.remove();
    for (let i = 0; i < stateNodes.length; i++) { const cur = states.children[i]; if (cur !== stateNodes[i]) states.insertBefore(stateNodes[i], cur || null); }
    while (states.children.length > stateNodes.length) states.lastElementChild.remove();
    /* Message attachments belong to their turn. Retain the shelf for agent outputs and
       legacy uploads whose original message was never recorded; don't invent that association. */
    const attachedIds = new Set(group.messages.flatMap(m => m.artifactIds || []));
    const sharedFiles = group.artifacts.filter(f => !attachedIds.has(f.id));
    const files = $('gc-files'); files.replaceChildren();
    files.parentElement.hidden = !sharedFiles.length;
    paintFilesToggle(sharedFiles.length);
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
  /* Inline files belong to the message's author and version. Prefer its run's published copy, otherwise the
     newest copy that author had shared when the message was written. An old reply must never open a later
     revision or another agent's same-named file. If no unambiguous shared version exists, use that author's
     workspace file through Chat's normal file resolver. */
  const sharedBlobs = new Map();   // artifact id -> Promise<blob url> (immutable versions: safe to keep)
  function sharedFor(groupId, p, agentId, messageId) {
    const g = group && group.id === groupId ? group : null; if (!g || !agentId) return null;
    const m = (g.messages || []).find(x => x.id === messageId && x.author === agentId);
    if (!m) return null;
    const clean = v => String(v || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const want = clean(p);
    const available = (g.artifacts || []).filter(a => {
      if (a.agentId !== agentId) return false;
      if ((m.artifactIds || []).includes(a.id) || (m.runId && a.runId === m.runId)) return true;
      if (Number.isFinite(m.seq) && Number.isFinite(a.messageSeq)) return a.messageSeq < m.seq;
      return Number.isFinite(m.at) && Number.isFinite(a.createdAt) && a.createdAt <= m.at;
    });
    let matching = available.filter(a => clean(a.sourcePath) === want);
    if (!matching.length) matching = available.filter(a => clean(a.sourcePath).endsWith('/' + want));
    // A bare filename may identify a single authored path; two different paths are ambiguous.
    if (!matching.length && !want.includes('/')) matching = available.filter(a => a.name === want);
    if (!matching.length || new Set(matching.map(a => clean(a.sourcePath) || a.name)).size !== 1) return null;
    const attached = matching.filter(a => (m.artifactIds || []).includes(a.id));
    const fromRun = m.runId && matching.filter(a => a.runId === m.runId);
    const versions = attached.length ? attached : (fromRun && fromRun.length ? fromRun : matching);
    // The ledger appends immutable versions in publication order (including equal timestamps).
    return versions[versions.length - 1];
  }
  function fileRefs(groupId, agentId, messageId) {
    const own = (typeof Chat !== 'undefined' && Chat.workspaceFileRefs) ? Chat.workspaceFileRefs(agentId, 'group:' + groupId + ':' + messageId) : null;
    return {
      // Resolve against the latest ledger at click time, while retaining this message's author/version.
      // Capture runs before the workspace opener, so a published immutable copy takes precedence.
      wire: (a, p) => {
        a.addEventListener('click', ev => {
          const art = sharedFor(groupId, p, agentId, messageId); if (!art) return;
          ev.preventDefault(); ev.stopImmediatePropagation();
          openFile(groupId, art).catch(showError);
        }, true);
        if (own) own.wire(a, p);
      },
      image: p => {
        const art = sharedFor(groupId, p, agentId, messageId);
        if (!art) return own ? own.image(p) : Promise.reject(new Error('no file'));
        if (!sharedBlobs.has(art.id)) sharedBlobs.set(art.id, Chat.imageBlobUrl('/api/groups?id=' + encodeURIComponent(groupId) + '&file=' + encodeURIComponent(art.id), art.sourcePath || art.name));
        return sharedBlobs.get(art.id);
      }
    };
  }
  // the shared shelf's fold, remembered per group (closed until the Commander opens it — the files are one click away)
  const filesKey = id => 'starnet.gc.filesOpen.' + id;
  function filesOpen() { try { return !!(active && localStorage.getItem(filesKey(active.id)) === '1'); } catch (_) { return false; } }
  function paintFilesToggle(n) {
    const tog = $('gc-files-tog'), open = filesOpen(); if (!tog) return;
    tog.replaceChildren(h('span', { class: 'tc-glyph', 'aria-hidden': 'true' }, '▤'), document.createTextNode('shared files'), h('span', { class: 'gc-files-n' }, String(n)), h('span', { class: 'gc-files-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'));
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
    tog.setAttribute('aria-label', (open ? 'Hide ' : 'Show ') + n + ' shared file' + (n === 1 ? '' : 's'));
    $('gc-files').hidden = !open;
  }
  function toggleFiles() {
    if (!active) return;
    const open = !filesOpen();
    try { if (open) localStorage.setItem(filesKey(active.id), '1'); else localStorage.removeItem(filesKey(active.id)); } catch (_) {}
    paintFilesToggle($('gc-files').children.length);
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
    const closeFile = () => { URL.revokeObjectURL(url); openedFileUrl = null; openedFile = null; preview.replaceChildren(); lastPaint = ''; paint(); };
    // CLOSE sits in the head beside SAVE: it used to trail the whole file body, so a long file hid its own way out
    const head = h('div', { class: 'gc-preview-head' });
    head.append(h('h4', {}, file.name), h('small', {}, 'version ' + file.hash.slice(0, 12)), h('a', { href: url, download: file.name }, 'SAVE FILE'), button('CLOSE FILE', closeFile));
    preview.append(head);
    if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) {
      preview.append(h('img', { class: 'gc-file-image', src: url, alt: file.name }));
    } else if (/\.(md|txt|csv|json|log|js|ts|py|html|css|xml|ya?ml|svg)$/i.test(file.sourcePath || file.name)) {
      // the transcript's own markdown look (headings, lists, tables): .cmsg .body is what those styles key on
      const content = await blob.text(), body = h('div', { class: 'gc-message cmsg agent gc-doc' }), inner = h('div', { class: 'body' });
      body.append(inner);
      if (/\.md$/i.test(file.sourcePath || file.name) && Chat.renderProse) Chat.renderProse(inner, content); else inner.textContent = content;
      preview.append(body);
    } else preview.append(h('p', {}, 'This file can be saved and opened in its associated application.'));
    // bring the opened file into view inside the tray (questions and turn rows sit above it)
    const sc = preview.closest('.gc-tray-scroll'); if (sc) sc.scrollTop = Math.max(0, preview.offsetTop - sc.offsetTop);
  }

  /* ---------- STARTING A GROUP ----------
     A direct chat becomes a group the moment a second agent joins it — from the + key or by picking an @agent. The
     backend records the membership FIRST; nothing on screen says "in this chat" until /api/groups answered (the old
     picker showed staged rows as IN THIS CHAT and saved nothing until a SAVE that sat below the window's edge with a
     real-size crew — so "add one and minimize" lost it every time; truthful telemetry).
     The General home stream is never converted: it stays the station's casual line, and a fresh group starts beside it
     (the same rule the rail's + NEW keeps — General is never rebound). */
  function isGeneral(ws) { return !!ws && typeof Workstreams !== 'undefined' && typeof Workstreams.generalId === 'function' && Workstreams.generalId() === ws.id; }
  async function startGroup(origin, ids, opts = {}) {   // opts.kickoff: the lead's next turn, when an agent brought the crew in
    if (!origin) throw new Error('Open a chat first');
    if (origin.conversationMode === 'group') throw new Error('This chat is already a group');
    const lead = origin.agentId || 'agent', general = isGeneral(origin);
    // the words in THIS chat's box, taken now: if you switch chats while it is created, the box holds another chat's words
    const box = $('chat-input'), draft = box && active?.id === origin.id ? box.value : (composerDrafts.get(origin.id) || '');
    const members = [lead, ...ids.filter(id => id !== lead)];
    // THE chat being converted must be idle (not merely the one on screen): a reply still running there would be lost to the
    // group, its approval cards hidden and its STOP retargeted. group.add waits for that reply instead (drainAfterRun).
    if (!general && typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(origin.id)) throw new Error(name(lead) + ' is still working in this chat. Let the run finish (or stop it), then add agents.');
    if (typeof App !== 'undefined' && App.pushRoster) await App.pushRoster();   // the backend must know every agent it seats
    const id = general ? 'ws_' + uid().replace(/-/g, '').slice(0, 20) : origin.id;
    const title = general ? members.map(name).join(' + ') : (origin.title || 'Group chat');
    // from General the new group carries the request it was made for (only that: General's own history stays in General)
    const ask = general && opts.kickoff ? [...(origin.history || [])].reverse().find(m => m && m.role === 'user' && !m.sys && String(m.content || '').trim()) : null;
    const kick = opts.kickoff ? { kickoff: opts.kickoff } : {};
    const g = await api(general ? { op: 'create', id, members, leadId: lead, title, ...(ask ? { history: [{ role: 'user', content: ask.content, ts: ask.ts }], originalAgentId: lead } : {}), ...kick }
      // only the dialogue: the local markers (a run-failed / stopped line, a history-cap marker, a status line) are this
      // page's records, not anyone's words — imported, every member would read them as the lead's (chat.js historyWindowFrom)
      : { op: 'create', id, conversionKey: origin.id, history: (origin.history || []).filter(m => !(m && (m.truncated || m.sys || m.error))), originalAgentId: lead, members, leadId: lead, title, ...kick });
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

  /* ---------- AN AGENT BRINGS CREW IN (station.control group.add, Andrew 2026-10-13) ----------
     "add 2 agents into this chat … it actually refused to do it, I have to manually add it myself". The SAME paths the
     + Add agents key takes, for three shapes of chat:
     - a group: each new member is invited now (safe while a turn runs — the group keeps going);
     - a chat with no reply running: it converts now, exactly as the key does (General opens a new group beside it);
     - the chat whose reply IS running — the run that asked: the join waits for that reply to end. A chat cannot change
       shape under a live reply (the reply, its approval cards and STOP belong to the one-on-one chat), so the join is
       saved on the conversation and lands through the same startGroup the moment the reply ends; a stop, a failed reply
       or a reload drops it and says so in the chat. The agent is told "joining when your reply ends", never "added". */
  const agentNames = ids => { const n = ids.map(name); return n.length > 1 ? n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1] : (n[0] || 'nobody'); };
  async function addAgents(ws, ids, caller) {
    if (!ws) throw new Error('that chat no longer exists');
    if (ws.conversationMode === 'group') {
      const fresh = await api(null, '?id=' + encodeURIComponent(ws.id));
      const add = ids.filter(id => !(fresh.members || []).includes(id));
      if (!add.length) throw new Error(agentNames(ids) + (ids.length > 1 ? ' are' : ' is') + ' already in this chat');
      if (typeof App !== 'undefined' && App.pushRoster) await App.pushRoster();   // the backend must know every agent it seats
      let g = fresh;
      for (const agentId of add) g = await api({ op: 'invite', id: ws.id, agentId });
      adopt(g); save();
      if (active?.id === g.id) { group = g; lastPaint = ''; paint(); }
      return { added: add, members: g.members };
    }
    const lead = ws.agentId || 'agent', add = ids.filter(id => id !== lead);
    if (!add.length) throw new Error(name(lead) + ' is already this chat\'s agent: name someone else from the crew');
    if (typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(ws.id)) {
      // only the run that asked may queue its own chat's change (any other live reply there: refuse, never queue blind)
      const runId = String((Channels.runIdOf && Channels.runIdOf(ws.id)) || '');
      if (!caller || String(caller.streamId || '') !== ws.id || !runId || runId !== String(caller.runId || '')) {
        throw new Error(name(lead) + ' is still answering in that chat: add agents after that reply ends');
      }
      const cur = ws.pendingJoin && ws.pendingJoin.runId === runId ? ws.pendingJoin.ids : [];
      const all = [...new Set([...cur, ...add])].slice(0, 10);
      // what the Commander already answered in that run's Task Brief (the sidecar's host stamp): the kickoff starts from it
      const brief = typeof caller.brief === 'string' && caller.brief.trim() ? caller.brief.trim().slice(0, 600)
        : (ws.pendingJoin && ws.pendingJoin.runId === runId && ws.pendingJoin.brief) || '';
      ws.pendingJoin = { runId, ids: all, at: Date.now(), ...(brief ? { brief } : {}) }; save();
      return { joining: true, agents: all.map(name), note: agentNames(all) + (all.length > 1 ? ' join ' : ' joins ')
        + (isGeneral(ws) ? 'a new group chat that opens beside General' : 'this chat (it becomes a group chat, its history kept)')
        + ' the moment this reply ends. If the reply is stopped or fails, nobody is added and the Commander is told in the chat.' };
    }
    const g = await startGroup(ws, add);
    return { added: add, members: g.members, group: g.id, title: g.title };
  }
  // a line in the chat itself that says what did NOT happen (saved: it is still there after a reload), plus the bell
  function notAdded(ws, ids, why) {
    const text = agentNames(ids) + (ids.length > 1 ? ' were' : ' was') + ' not added to this chat: ' + why + '.';
    if (ws && Array.isArray(ws.history)) { ws.history.push({ role: 'system', sys: true, content: text, ts: Date.now() }); save(); }
    if (ws && typeof Workstreams !== 'undefined' && Workstreams.activeId && Workstreams.activeId() === ws.id && typeof Chat !== 'undefined' && Chat.localLine) Chat.localLine(text);
    if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(text, 'bad');
    return null;
  }
  // chat.js calls this as the asking reply's teardown ends (after the reply is saved in the history, before a queued
  // follow-up is sent — which then goes to the new group): land the join, or say why it did not happen
  async function drainAfterRun(wsId, runId, how) {
    const ws = typeof Workstreams !== 'undefined' && Workstreams.get ? Workstreams.get(wsId) : null;
    const job = ws && ws.pendingJoin;
    if (!job || (runId && job.runId !== String(runId))) return null;
    ws.pendingJoin = null; save();
    if (how && how.stopped) return notAdded(ws, job.ids, 'the reply was stopped before it finished');
    if (ws.lastRunOk === false) return notAdded(ws, job.ids, 'the reply failed before it finished');
    const crew = (typeof App !== 'undefined' && App.agents && App.agents()) || [];
    const ids = job.ids.filter(id => crew.some(a => a && a.id === id));
    if (!ids.length) return notAdded(ws, job.ids, 'they are no longer on the crew');
    try {
      // the lead asked for them to work on the Commander's request: it gets the first turn in the group to hand them their parts
      const kickoff = agentNames(ids) + (ids.length > 1 ? ' have' : ' has') + ' joined this chat at your request. Carry on with the Commander\'s request: give '
        + (ids.length > 1 ? 'each of them their part' : 'them their part') + ' (group.handoff) and do your own.'
        // …starting from what the Commander already answered (review 10-14: from General the new group re-asked "What are
        // we launching?" seconds after they had answered it there)
        + (job.brief ? ' The Commander already answered: ' + String(job.brief).replace(/[\s.;,]+$/, '') + '. Never ask those again.' : '');
      const out = ws.conversationMode === 'group' ? await addAgents(ws, ids, null) : await startGroup(ws, ids, { kickoff });
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(agentNames(ids) + (ids.length > 1 ? ' joined ' : ' joined ') + (out && out.title ? '"' + out.title + '"' : 'the chat'), 'good');
      return out;
    } catch (e) { return notAdded(ws, ids, String((e && e.message) || e).replace(/\.$/, '')); }
  }
  // a reload or a closed tab ends every reply (the request dies with the page): a join still waiting on one never lands
  let joinsSettled = false;
  function settleStaleJoins() {
    if (joinsSettled || typeof Workstreams === 'undefined' || !Workstreams.list) return; joinsSettled = true;
    for (const ws of Workstreams.list({ includeArchived: true }) || []) {
      if (!ws || !ws.pendingJoin) continue;
      const live = typeof Channels !== 'undefined' && Channels.isBusy && Channels.isBusy(ws.id) && Channels.runIdOf && String(Channels.runIdOf(ws.id) || '') === ws.pendingJoin.runId;
      if (live) continue;
      const ids = ws.pendingJoin.ids; ws.pendingJoin = null;
      notAdded(ws, ids, 'the reply was interrupted before it finished (the page reloaded or closed)');
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
      // from General the pick never converts General: a new group opens beside it (startGroup), so the row says so
      const what = item.all ? 'everyone here' : item.member ? 'in this chat' : inGroup ? 'adds to this chat' : isGeneral(active) ? 'opens a group chat with ' + lead + ' beside General' : 'starts a group with ' + lead;
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
    StationUI.toggleTerm('group-agents', origin?.conversationMode === 'group' ? 'AGENTS IN THIS CHAT' : 'ADD AGENTS', body => body.replaceChildren(dialog), { className: 'gc-picker-win', onClose: () => { dialog.remove(); pickerFor = null; pickerRepaint = null; } });
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
        // NO SENTENCES UNDER TILES (walk 10-14 #9): portrait + name; the agent's description is the row's hover tip
        const about = describe(a.id);
        const r = h('div', { class: 'gc-row' + (inChat ? ' in' : ''), role: 'listitem', 'data-agent-name': label(a.id).toLowerCase(), ...(about ? { title: about, 'aria-description': about } : {}) });
        const led = h('span', { class: 'gc-led', 'aria-hidden': 'true' }); if (colorOf(a.id)) led.style.background = colorOf(a.id);
        // the agent's own skin (the shared thumb path every crew surface uses); a skin still loading shows the silhouette
        const pic = h('span', { class: 'gc-pic', 'aria-hidden': 'true' });
        if (typeof AgentPortraits !== 'undefined' && AgentPortraits.thumbHTML) pic.innerHTML = AgentPortraits.thumbHTML(App.agents?.().find(x => x.id === a.id) || a, 32, 38, 'gc-av');
        const idc = h('div', { class: 'gc-id' }); idc.append(h('span', { class: 'gc-nm' }, label(a.id)));
        r.append(led, pic, idc);
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
      const win = dialog.closest ? dialog.closest('.term') : null;
      if (win && typeof win._fitDockedSheet === 'function') win._fitDockedSheet();   // the dock re-seats it to hold its floors
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
  return { bind, sendText, discover, rename, remove, pause, isBusy, stop, mentionKey, mentionTargets, startWith, stateOf, attentionIds, membersOf: id => membersById.get(id) || null, addAgents, drainAfterRun };
})();
