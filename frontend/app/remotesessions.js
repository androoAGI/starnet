/* AGENT OS — remotesessions.js : a conversation you have from your phone is a SESSION on the desk too.

   Agent OS Remote runs a phone's task on the station, detached from any page (sidecar/remote/host.js). Without
   this module the desk never learns about it: a conversation started on the phone has no row in the rail, and a
   phone turn sent into a desk session only shows up the next time that session happens to be reopened.

   WHAT IT DOES (read-only on U.bus, no new events — the contract is owned):
     · GET /api/remote/recent lists the runs a phone started ({runId, agentId, streamId, title, startedAt, endedAt,
       live}). A stream the desk has never seen (they are named 'remote_<agent>_<time>') is ADOPTED as a session,
       titled with what you said, without stealing focus. A session you deleted stays deleted (adopt refuses it).
     · While a phone run is live its session shows busy through the SAME per-session channel state chat.js and
       autosessions.js drive. When it ends the busy state clears, and if that session is the one on screen it is
       reloaded, which merges the station's transcript into it (chat.js reconcileServerHistory). Otherwise the
       merge happens when you open it, exactly as for every other session.
     · It looks again whenever the floor feed reports a run starting or ending, and once after boot. The boot pass
       also reads /api/runs for 'remote_' streams, so phone conversations held while the desk was closed (or across
       a station restart) still appear.

   TRUTH RULE: a row is only ever created from a run the station reports; busy is only ever set while the station
   says that run is live; nothing here writes dialogue — the transcript is fetched by the normal session load.

   Follows autosessions.js: plain init()/reset(), never emits, fail-open (a route error changes nothing). */
'use strict';
const RemoteSessions = (() => {
  const STREAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const PHONE_STREAM = /^remote_/;
  let wired = false, timer = null, syncing = false, again = false;
  const busyMine = new Set();     // session ids this module marked busy
  const settled = new Set();      // runIds whose end has already been applied

  const hasWS = () => typeof Workstreams !== 'undefined' && Workstreams;
  const hasCh = () => typeof Channels !== 'undefined' && Channels;
  const hasChat = () => typeof Chat !== 'undefined' && Chat;
  const hasApp = () => typeof App !== 'undefined' && App;
  const hasU = () => typeof U !== 'undefined' && U && U.bus && U.bus.on;
  function refreshRail() { try { if (hasApp() && App.refreshRail) App.refreshRail(); } catch (_) {} }
  function persist() { try { if (hasApp() && App.persist) App.persist(); } catch (_) {} }
  const titleOf = (t) => { const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, 80) : 'From your phone'; };

  async function getJson(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return null; return (await r.json()) || null; }
    catch (_) { return null; }
  }

  // one run the station reports -> the desk's session state. Returns true when something visible changed.
  function applyRun(run) {
    if (!run || !STREAM_RE.test(String(run.streamId || ''))) return false;
    const id = String(run.streamId);
    let changed = false;
    let ws = Workstreams.get(id);
    if (!ws) {
      if (!PHONE_STREAM.test(id)) return false;   // a desk session the phone wrote into always exists already
      ws = Workstreams.adopt({ id: id, title: titleOf(run.title), agentId: String(run.agentId || 'agent'), lane: 'active', history: [] });
      if (!ws) return false;                        // deleted on the desk: stays deleted
      changed = true;
    }
    if (run.live) {
      if (hasCh() && !Channels.isBusy(id)) {
        Channels.begin(id, Number(run.startedAt) || Date.now());
        Channels.setStatus(id, 'working on a task from your phone…');
        busyMine.add(id);
        changed = true;
      }
      return changed;
    }
    if (run.runId && settled.has(run.runId)) return changed;
    if (run.runId) settled.add(run.runId);
    // clear only a busy state this module set (or one a reload restored with no page run behind it)
    if (hasCh() && Channels.isBusy(id) && (busyMine.has(id) || !(Channels.runIdOf && Channels.runIdOf(id)))) Channels.end(id);
    busyMine.delete(id);
    if (Number(run.endedAt) > (Number(ws.lastActiveAt) || 0)) ws.lastActiveAt = Number(run.endedAt);
    // on screen: reload it so the station's transcript is merged in now; elsewhere the normal open does it
    if (hasChat() && Workstreams.activeId && Workstreams.activeId() === id && !(hasCh() && Channels.isBusy(id))) { try { Chat.load(ws); } catch (_) {} }
    return true;
  }

  async function sync(withBackfill) {
    if (!hasWS()) return;
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      let changed = false;
      if (withBackfill) {
        const hist = await getJson('/api/runs?agent=*');
        const rows = (hist && Array.isArray(hist.runs)) ? hist.runs : [];
        for (const r of rows.slice().reverse()) {   // oldest first, so a conversation's title is its first message
          if (!r || !PHONE_STREAM.test(String(r.streamId || ''))) continue;
          if (r.runId) { if (settled.has(r.runId)) continue; }
          if (applyRun({ runId: r.runId, agentId: r.agentId, streamId: r.streamId, title: r.title, endedAt: r.endedAt || r.ts || 0, live: false })) changed = true;
        }
      }
      const j = await getJson('/api/remote/recent');
      const runs = (j && Array.isArray(j.runs)) ? j.runs.slice().reverse() : [];   // route is newest first
      let anyLive = false;
      for (const run of runs) { if (run && run.live) anyLive = true; if (applyRun(run)) changed = true; }
      if (changed) { refreshRail(); persist(); }
      // a live phone run: look again shortly even if the floor feed drops its end event
      if (anyLive) schedule(4000);
    } finally {
      syncing = false;
      if (again) { again = false; schedule(200); }
    }
  }
  function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; sync(false); }, ms); }

  function init() {
    if (!wired && hasU()) {
      wired = true;
      U.bus.on('agent.run.start', () => schedule(250));
      U.bus.on('agent.run.end', () => schedule(250));
    }
    setTimeout(() => { sync(true); }, 1800);   // after the save load + rail settle (autosessions runs at 1400)
  }
  function reset() { if (timer) { clearTimeout(timer); timer = null; } busyMine.clear(); settled.clear(); }

  return { init, reset, _internals: { applyRun, sync, titleOf } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RemoteSessions };
