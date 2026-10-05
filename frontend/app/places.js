/* frontend/app/places.js — PLACES: every place in StarNet a Commander can be shown, in the words the UI itself uses.

   WHY (Andrew 2026-10-04: "the agents [should] understand EVERYTHING about starnet … so it can basically use itself
   instead of the user having to navigate"): an agent could change ~45 settings from chat but could not put ONE window
   in front of the Commander — "where are my deliverables?" got a menu path to read and click through. This is the one
   list of where things are. The agent's station.show tool (sidecar/tools/builtin/station-show.js) takes its ids and
   describes them from it; the page (stationcommands.js station.show) opens each one through the SAME door its dock
   button, tab or menu entry uses. One list, so the tool, its description and the page can never name different places.

   Each place: { id, words (the UI's own path — what the Commander sees), about (one line: what it is for),
   open: how the page reaches it — { term, section? } a window (StationUI.openTerm key + console section, aliases
   included), { agent: <dossier tab> } an agent's dossier tab, { desk: true } an agent's desk screen,
   { fn: 'build' | 'recruit' | 'recipes' } a door that is not a plain window }.
   Pure data + lookups: no DOM, no IO — node-requirable (the sidecar reads it) and browser-loadable. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Places = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const P = (id, words, about, open) => Object.freeze({ id, words, about, open: Object.freeze(open) });

  const PLACES = Object.freeze([
    // ---- WORK ----
    P('tasks', 'MY WORK › TASKS', 'the task board: planned work as cards; assigning a card hands it to an agent', { term: 'tasks' }),
    P('deliverables', 'MY WORK › DELIVERABLES', 'everything the crew finished, with its files', { term: 'deliverables' }),
    P('to-review', 'MY WORK › DELIVERABLES › TO REVIEW', 'finished work waiting for the Commander\'s verdict, at the top of DELIVERABLES', { term: 'outbox' }),
    P('recipes', 'MY WORK › RECIPES', 'ready-made jobs to start in one click', { fn: 'recipes' }),
    P('workflows', 'AUTOMATE › WORKFLOWS', 'lines of agents on the floor: send a job down a line, see each line\'s output', { term: 'workflows' }),
    P('schedules', 'AUTOMATE › SCHEDULES', 'routines: any job on a schedule (StarNet\'s own scheduler, never OS cron)', { term: 'automation', section: 'routines' }),
    P('new-schedule', 'AUTOMATE › SCHEDULES › NEW', 'the form for a new scheduled routine', { term: 'automation', section: 'routines-create' }),
    P('goal-loops', 'AUTOMATE › GOAL LOOPS', 'one objective repeated until it is done', { term: 'automation', section: 'loops' }),
    P('new-goal-loop', 'AUTOMATE › GOAL LOOPS › START', 'the form for a new goal loop', { term: 'automation', section: 'loops-start' }),
    P('away-work', 'AUTOMATE › AWAY WORK', 'what agents work on between the Commander\'s messages', { term: 'automation', section: 'away' }),
    P('quests', 'QUESTS', 'the quest log: personal quests, goal steps and floor gaps', { term: 'quests' }),
    P('progress', 'QUESTS › PROGRESS', 'station level, systems coming online, the goal constellation', { term: 'quests', section: 'progress' }),
    P('trophies', 'TROPHY CASE', 'trophies the station has earned', { term: 'trophies' }),
    // ---- BUILD / CONNECT ----
    P('build-mode', 'BUILD MODE', 'the full-screen station builder: rooms, decks, props (a prop in an agent\'s room grants a power)', { fn: 'build' }),
    P('abilities', 'CONNECT › ABILITIES', 'the one place platforms get connected, and everything agents can do', { term: 'connectors' }),
    P('find-a-service', 'CONNECT › ABILITIES › CATALOG', 'one-click connectors to vetted services, searchable by name', { term: 'connectors', section: 'catalog' }),
    P('connected-services', 'CONNECT › ABILITIES › CONNECTED SERVICES', 'connected MCP services: status, reconnect, attach one by URL', { term: 'connectors', section: 'mcp' }),
    P('api-connections', 'CONNECT › ABILITIES › SAVED API CONNECTIONS', 'API keys for any platform, listed or not (the universal fallback)', { term: 'connectors', section: 'keys' }),
    P('built-in-abilities', 'CONNECT › ABILITIES › BUILT-IN ABILITIES', 'each built-in ability and its kill-switch', { term: 'connectors', section: 'toolsets' }),
    P('computer-control', 'CONNECT › ABILITIES › COMPUTER CONTROL', 'how agents drive native desktop apps', { term: 'connectors', section: 'computer' }),
    P('skill-market', 'CONNECT › ABILITIES › SKILL MARKET', 'StarNet Originals and community skills to install', { term: 'connectors', section: 'market' }),
    P('skill-library', 'CONNECT › ABILITIES › SKILL LIBRARY', 'the procedures agents follow, installed on this station', { term: 'connectors', section: 'library' }),
    P('agent-skills', 'CONNECT › ABILITIES › AGENT SKILLS', 'procedures agents created or learned themselves', { term: 'connectors', section: 'agent' }),
    P('skill-exchange', 'CONNECT › ABILITIES › SKILL EXCHANGE', 'inspect and install open SKILL.md procedures', { term: 'connectors', section: 'exchange' }),
    P('extensions', 'CONNECT › ABILITIES › EXTENSIONS', 'the Commander\'s own hooks and plugins', { term: 'connectors', section: 'extensions' }),
    P('channels', 'CONNECT › CHANNELS', 'message agents from Telegram, Discord, Slack, Matrix or Signal', { term: 'messaging' }),
    P('apps', 'APPS', 'the station\'s own apps, built by the crew', { term: 'apps' }),
    P('browser', 'BROWSER', 'the station browser agents use', { term: 'browser' }),
    P('saved-sign-ins', 'STEP-IN', 'take the wheel of an agent\'s browser; the sign-ins agents reuse', { term: 'stepin' }),
    // ---- CREW ----
    P('recruit', 'CREW › RECRUIT', 'the Recruitment Bay: summon a new agent from a class, or build a custom class', { fn: 'recruit' }),
    P('agent', 'CREW › AGENTS › BRIEF', 'an agent\'s dossier: who it is, its setup, what it can do (name the agent)', { agent: 'brief' }),
    P('agent-growth', 'CREW › AGENTS › GROWTH', 'an agent\'s level, XP and achievements', { agent: 'growth' }),
    P('agent-record', 'CREW › AGENTS › RECORD', 'an agent\'s past runs, failures and restore points', { agent: 'record' }),
    P('agent-memory', 'CREW › AGENTS › MEMORY', 'what an agent remembers and how it learns', { agent: 'memory' }),
    P('agent-config', 'CREW › AGENTS › CONFIG', 'an agent\'s instructions, model, access and look', { agent: 'config' }),
    P('agent-desk', 'an agent\'s DESK', 'the agent\'s desk screen: what it is working on right now', { desk: true }),
    P('you', 'CREW › YOU', 'the Commander\'s own dossier: about you, aims, preferences, what agents are told', { term: 'commander' }),
    // ---- SYSTEM ----
    P('settings', 'SETTINGS', 'every station setting', { term: 'settings' }),
    P('settings-ai', 'SETTINGS › AI & MODELS', 'AI providers, their keys and sign-ins, default and backup models', { term: 'settings', section: 'providers' }),
    P('settings-autonomy', 'SETTINGS › AUTONOMY', 'when agents work on their own, and what they did while you were away', { term: 'settings', section: 'autonomy' }),
    P('settings-permissions', 'SETTINGS › PERMISSIONS', 'access and approval rules for the station or one agent', { term: 'settings', section: 'permissions' }),
    P('settings-spending', 'SETTINGS › SPENDING LIMITS', 'spending caps and recorded usage', { term: 'settings', section: 'budget' }),
    P('settings-look', 'SETTINGS › LOOK & SOUND', 'lighting, colour, CRT effects, sound and agent voices', { term: 'settings', section: 'appearance' }),
    P('settings-alerts', 'SETTINGS › ALERTS', 'what pings the Commander and whether it chimes', { term: 'settings', section: 'notifs' }),
    P('settings-remote', 'SETTINGS › REMOTE', 'pair a phone and control the station from anywhere', { term: 'settings', section: 'remote' }),
    P('settings-browser', 'SETTINGS › BROWSER', 'where the station browser runs', { term: 'settings', section: 'browser' }),
    P('settings-app', 'SETTINGS › APP & BACKUP', 'startup, runtime limits, backups, updates, troubleshooting', { term: 'settings', section: 'system' }),
    P('notifications', 'NOTIFICATIONS', 'everything that happened and what is waiting on the Commander', { term: 'notifs' }),
    P('updates', 'UPDATES', 'check for and install a StarNet update', { term: 'updates' }),
    P('field-manual', 'FIELD MANUAL', 'the Commander\'s guide to StarNet', { term: 'manual' }),
    P('find', 'SYSTEM › FIND', 'one search over every window, agent and conversation (Ctrl+K from anywhere)', { term: 'find' })
  ]);

  const BY_ID = Object.create(null);
  for (const p of PLACES) BY_ID[p.id] = p;
  const ids = () => PLACES.map(p => p.id);
  const get = id => BY_ID[String(id || '').trim().toLowerCase()] || null;
  const needsAgent = p => !!(p && (p.open.agent || p.open.desk));

  /* OPEN a place through its own door — the ONE opener for the agent's station.show and the Commander's FIND (Ctrl+K).
     env = the page's own objects, passed in so this file stays DOM-free (the sidecar requires it) and testable:
     { ui: StationUI, build?: Build, app?: App, market?: Marketplace, agentId? (for an agent place), sleep?(ms) }.
     Resolves what is really on screen ({ open, key, … }); throws when a door is not loaded on this page. */
  async function open(place, env) {
    const o = place.open, ui = env.ui;
    if (o.agent || o.desk) return ui.showAgent(env.agentId, o.agent || null, !!o.desk);
    if (o.fn === 'build') {
      if (!env.build || !env.build.open) throw new Error('BUILD MODE is not loaded on this page');
      env.build.open();
      return { open: !!(env.build.isOpen && env.build.isOpen()), key: 'build-mode' };
    }
    if (o.fn === 'recruit' || o.fn === 'recipes') {
      const fn = env.app && (o.fn === 'recruit' ? env.app.openSummonBay : env.app.openRecipes);
      if (!fn) throw new Error('that door is not loaded on this page');
      // the bay already showing this tab is RAISED, never re-opened: re-opening resets it, and a half-written recipe or
      // class would be lost to "show me the recruitment bay"
      const tabNow = env.market && env.market.currentTab ? env.market.currentTab() : null;
      let out = ui.showTerm('marketplace');
      if (!out.open || tabNow !== (o.fn === 'recipes' ? 'recipes' : 'agents')) {
        fn();
        // the summon bay reads the agent limit before it opens (one fetch, first time only): wait for the window
        const sleep = env.sleep || (ms => new Promise(r => setTimeout(r, ms)));
        for (let i = 0; i < 40 && !(out = ui.showTerm('marketplace')).open; i++) await sleep(100);
      }
      return out;
    }
    return ui.showTerm(o.term, o.section || undefined);
  }

  return { PLACES, ids, get, needsAgent, open };
});
