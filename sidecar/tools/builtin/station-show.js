/* sidecar/tools/builtin/station-show.js — station.show: the agent puts a StarNet window in front of the Commander.

   WHY (Andrew 2026-10-04: agents should "basically use [StarNet] itself instead of the user having to navigate"): an agent
   asked "where are my deliverables?" or "open my schedules" could only recite a menu path for the Commander to click
   through. This opens it — any place in frontend/app/places.js (the one list of where things are), through the same door
   its dock button or tab uses, raised to the front, answered with what is really on screen.

   SAFETY SHAPE: it changes only what the Commander is LOOKING at — no setting, no data, no spend — so it asks no approval.
   But their eyes are theirs: the page obeys only the run they are watching (its session is the focused one and it is that
   session's live run), so a background worker, a routine, a phone/Telegram turn or a finished run is refused, and the
   refusal says to tell them where it is instead. Every place name comes from the catalog, never from free text.

   Same always-present grant as manual.read / station.inspect (capId 'stationinfo'): knowing and showing the station is
   part of being able to help with it at all, for every agent the Commander talks to — not only the lead. */
'use strict';

const Places = require('../../../frontend/app/places.js');

function makeStationShowTool(deps) {
  deps = deps || {};
  const station = (deps.station && typeof deps.station.request === 'function') ? deps.station : null;
  const refuse = error => ({ content: 'REFUSED: ' + error + ' — do not tell the Commander it is open.', summary: 'not shown' });
  const tool = {
    name: 'station.show', capability: 'stationinfo', scope: 'read', requiresConsent: false, timeoutMs: 15000,
    description: 'OPEN a StarNet window, tab or section on the Commander\'s screen when they ask where something is or to '
      + 'see it ("show me my deliverables", "open schedules", "take me to the recruitment bay") — instead of describing '
      + 'the clicks. place: ' + Places.PLACES.map(p => p.id + ' (' + p.words + ')').join(', ')
      + '. agent (name or id) is required for agent, agent-growth, agent-record, agent-memory, agent-config, agent-desk. '
      + 'Only works while the Commander is watching this conversation; if refused, tell them where it is.',
    // no `required`: a real model (Claude Haiku 4.5, 2026-10-08) sent {target | window | page | section: "settings-…"} and was turned away as
    // invalid arguments — the place is read from place | target | id | window here, and only a catalog id ever opens
    schema: { type: 'object', properties: { place: { type: 'string', enum: Places.ids() }, agent: { type: 'string' } } },
    run: async (args, ctx) => {
      const asked = ['place', 'target', 'id', 'window', 'page', 'section'].map(k => args && args[k]).find(v => typeof v === 'string' && v.trim()) || '';
      const place = Places.get(asked);
      if (!place) return refuse((asked ? 'there is no StarNet place "' + asked + '"' : 'no place was named') + ' — call it as {place: "<id>"} with an id from this tool\'s list');
      const agent = String((args && args.agent) || '').trim();
      if (Places.needsAgent(place) && !agent) return refuse(place.id + ' needs the agent\'s name');
      if (!station) return refuse('this run has no StarNet page attached (nobody has the station open)');
      const origin = ctx && ctx.streamId && ctx.runId ? { streamId: String(ctx.streamId), runId: String(ctx.runId) } : null;
      let out;
      try { out = await station.request('station.show', { place: place.id, agent: agent || undefined, origin }); }
      catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
      if (!out || !out.ok) return refuse(String((out && out.error) || 'the station did not answer'));
      const r = out.result || {};
      const where = place.words + (r.agentName ? ' for ' + r.agentName : '');
      // real-model run 2026-10-08: "clear my notifications" opened NOTIFICATIONS and told the Commander to clear them by hand
      return { content: 'OPEN on the Commander\'s screen: ' + where + ' — ' + place.about + '. If they asked you to CHANGE something '
        + 'here, opening it is not doing it: do the change with station.control / station.power if you have them (tool.search '
        + '"station control").', summary: 'showed ' + where };
    }
  };
  return { tool, register(reg) { reg.register(tool); return reg; } };
}

module.exports = { makeStationShowTool };
