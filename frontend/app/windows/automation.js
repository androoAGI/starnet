/* STARNET — windows/automation.js : the AUTOMATION window (ROUTINES + LOOPS, one console).

   NAV CONDENSE (2026-08-04): the WORK dock sold three flavours of "job" — TASKS, ROUTINES, LOOPS —
   and the subtitles were already apologising for it. ROUTINES answer WHEN, LOOPS answer UNTIL; both
   are standing automation over the same crew, and their windows had the identical shape (an ACTIVE
   list + a CREATE flow). So they now share ONE dock item and ONE console window with four sections:
   ACTIVE ROUTINES · CREATE ROUTINE · ACTIVE LOOPS · START A LOOP.

   Mechanics: this file owns the window slot (key `automation`) and a tiny lane registry. Loads AFTER
   stationui.js and BEFORE windows/routines.js + windows/loops.js (see index.html); each of those
   registers a LANE — a function of (body) returning { sections, wire } — instead of mounting its own
   console. buildAutomation concatenates the lanes' sections into one mountConsole call, then runs
   each lane's wire() against the shared body. All panes are mounted up-front (mountConsole's design),
   the two lanes' ids are disjoint (rt-* / lp-*), so both wirings coexist untouched. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow) return;
  const lanes = [];
  // the seam routines.js / loops.js register through. Kept deliberately tiny: order of registration
  // (script order in index.html) is the section order in the rail — routines first, loops second.
  let draft = null;
  let awayAgent = null;
  window.AutomationWindow = {
    registerLane(fn) { if (typeof fn === 'function') lanes.push(fn); },
    openAway(agentId) {
      awayAgent = agentId || null;
      StationUI.openTerm('automation', 'away');
      StationUI.h.rerender('automation');
    },
    openDraft(value) {
      draft = Object.assign({}, value || {});
      StationUI.openTerm('automation', 'routines-create');
    }
  };

  function buildAutomation(body) {
    const built = lanes.map(fn => fn(body)).filter(b => b && Array.isArray(b.sections));
    const sections = built.reduce((acc, b) => acc.concat(b.sections), []);
    const H = StationUI.h;
    sections.push({ id: 'away', label: 'WHILE I’M AWAY', glyph: '◈', desc: 'Choose an agent, review its queue, and decide whether it can build while you’re away.', build: pane => {
      pane.innerHTML = '<div class="away-picker"><label for="auto-away-agent">Agent</label><select id="auto-away-agent" class="key-input">' + H.present.map(a => '<option value="' + H.esc(a.id) + '">' + H.esc(a.name || a.id) + '</option>').join('') + '</select></div><div id="auto-away-body"></div>' +
        '<details class="cf-group"><summary>Let agents choose their own work</summary><p>Want agents to suggest or pick jobs themselves? Choose their level of initiative in Settings. The queue above holds work you chose.</p><button class="bb sm" id="auto-initiative">OPEN INITIATIVE SETTINGS</button></details>';
    }});
    const labels = { routines: 'Scheduled jobs', 'routines-create': 'New schedule', loops: 'Goal loops', 'loops-start': 'New goal loop', away: 'Away work' };
    const hints = { routines: 'Next runs and recent results', 'routines-create': 'Repeat a task at a chosen time', loops: 'Progress and work to review', 'loops-start': 'Work toward a defined stopping point', away: 'Queued work between messages' };
    sections.forEach(sec => { sec.label = labels[sec.id] || sec.label; });
    // ONE AUTOMATION DOOR: the agents' initiative lives in SETTINGS › AUTONOMY, but whoever opens AUTOMATION sees it
    // here (read from the confirmed posture, never assumed) with a CHANGE door — no hunting through two windows.
    const INIT_NAME = { wait: 'WAIT', propose: 'SUGGEST', leash: 'BUILD', free: 'FREE' };
    const railTop = top => {
      const sum = (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary) ? AutonomyStore.summary() : null;
      top.classList.add('auto-init-head');
      top.innerHTML = '<div class="set-sub"><span class="set-sub-k">ON ITS OWN</span><span class="set-sub-d">'
        + (sum ? H.esc(INIT_NAME[sum.initiative] || String(sum.initiative).toUpperCase()) : 'not loaded yet') + '</span></div>'
        + '<button type="button" class="bb sm" id="auto-init-change" data-tip="Whether agents start work nobody asked for. It does not change the schedules here.">CHANGE</button>';
      top.querySelector('#auto-init-change').addEventListener('click', () => H.openTerm('settings', 'autonomy'));
    };
    StationUI.h.mountConsole(body, 'automation', sections, { search: false, railTop });
    // ONE MENU: AUTOMATE's tabs (SCHEDULES / GOAL LOOPS / AWAY WORK) pick the area, so the rail lists only that
    // area's own pages (e.g. Scheduled jobs + New schedule) instead of repeating the tabs beside them.
    const area = id => String(id || '').startsWith('routines') ? 'routines' : String(id || '').startsWith('loops') ? 'loops' : String(id || '');
    const cur = area(H.consoleSection.automation || (sections[0] && sections[0].id));
    body.querySelectorAll('.con-rail-item').forEach(item => { item.hidden = area(item.dataset.section) !== cur; });
    body.querySelectorAll('.con-rail-item').forEach(item => {
      const hint = document.createElement('span'); hint.className = 'sn-menu-nav-note';
      hint.textContent = hints[item.dataset.section] || ''; item.appendChild(hint);
    });
    body.querySelectorAll('[data-auto-tab]').forEach(button => button.addEventListener('click', () => {
      body.querySelectorAll('[data-auto-tab]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      body.querySelectorAll('[data-auto-panel]').forEach(p => { p.hidden = p.dataset.autoPanel !== button.dataset.autoTab; });
    }));
    built.forEach(b => { if (typeof b.wire === 'function') b.wire(); });
    const picker = body.querySelector('#auto-away-agent');
    const awayBody = body.querySelector('#auto-away-body');
    picker.value = H.present.some(a => a.id === awayAgent) ? awayAgent : (H.present[H.sel] || H.present[0] || {}).id || '';
    const renderAway = () => {
      awayAgent = picker.value;
      const a = H.present.find(a => a.id === awayAgent);
      awayBody.innerHTML = a ? H.workshopCard(a) : '<p>No agents on this station. Recruit one to configure away work.</p>';
      if (a) H.wireWorkshop(awayBody, a);
    };
    picker.addEventListener('change', renderAway);
    body.querySelector('#auto-initiative').onclick = () => H.openTerm('settings', 'autonomy');
    renderAway();
    if (draft) {
      if (draft.widgetId) {
        const prompt = body.querySelector('#rt-prompt');
        if (prompt) prompt.dataset.widgetId = draft.widgetId;
      }
      if (draft.workflowTakeoverId) {
        const prompt = body.querySelector('#rt-prompt');
        if (prompt) {
          prompt.dataset.workflowTakeoverId = draft.workflowTakeoverId;
          const note = document.createElement('p'); note.className = 'set-about';
          note.textContent = 'Takeover review — ' + draft.count + ' separate completed requests. Check sources, changing dates, saved choices and required access. Choose the schedule below; nothing is scheduled until you add the routine.';
          prompt.insertAdjacentElement('beforebegin', note);
          const evidence = document.createElement('details');
          const summary = document.createElement('summary'); summary.textContent = 'Requests behind this offer'; evidence.appendChild(summary);
          for (const item of (draft.evidence || [])) {
            const line = document.createElement('p'); line.textContent = new Date(item.at).toLocaleDateString() + ' — ' + item.quote; evidence.appendChild(line);
          }
          prompt.insertAdjacentElement('beforebegin', evidence);
        }
      }
      if(String(draft.prompt || '').includes('Pasted source (JSON string):')) {
        const note=document.createElement('p');note.className='warn';note.textContent='This draft contains a fixed pasted sample. For fresh updates on each run, replace that sample with an approved source folder before adding the routine.';
        const prompt=body.querySelector('#rt-prompt');if(prompt)prompt.insertAdjacentElement('beforebegin',note);
      }
      for (const [selector, key] of [['#rt-name','name'],['#rt-prompt','prompt'],['#rt-workdir','workdir']]) {
        const el = body.querySelector(selector); if (el) el.value = String(draft[key] || '');
      }
      const agentButton = Array.from(body.querySelectorAll('.rt-agent-btn')).find(b => b.dataset.agent === draft.agentId);
      if (agentButton) agentButton.click();
      // REPEAT SENSE: a takeover carries the rhythm read off when the Commander actually asked. It only
      // pre-selects the picker; nothing is scheduled until the existing ADD click.
      const sug = draft.suggest;
      if (sug && sug.schedule && body._rtPicker && typeof body._rtPicker.set === 'function') {
        body._rtPicker.set(String(sug.schedule));
        const when = body.querySelector('#rt-when');
        if (when) {
          const hint = document.createElement('p'); hint.className = 'set-about'; hint.dataset.rtSuggest = '1';
          hint.textContent = 'Suggested: ' + String(sug.display || sug.schedule) + (sug.why ? ' — ' + String(sug.why) : '') + '. Change it if you like.';
          when.insertAdjacentElement('beforebegin', hint);
        }
      }
      draft = null; // a draft is not a routine; only the existing CREATE click can persist one.
    }
  }

  StationUI.registerWindow('automation', 'AUTOMATION', buildAutomation, { console: true, className: 'automation-win' });
})();
