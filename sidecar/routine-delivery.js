/* sidecar/routine-delivery.js — where a scheduled routine's result goes: a chat target (in parts, with its files), the
   session it came from, or nowhere (a silent result) — and the pre-spend proof that its destination is there.

   Moved out of sidecar/index.js unchanged (channel-delivery-ledger, S1), then put on the ONE outbound contract (S4,
   channels/outbound.js). index.js builds one over its own stores, gates and outbound, and hands deliverCronResult,
   cronPreflightConfig, cronDeliveryNote, deliveryStarted, deliveryWithdrawn and deliveryRecorded to the cron driver.

     makeRoutineDelivery(deps) -> { deliverCronResult, cronPreflightConfig, cronDeliveryNote, cronReturnsToSession,
                                    cronSupersededNote, deliveryStarted, deliveryWithdrawn, deliveryRecorded, recordId }
       deps = { channelStore, channelOutbound, channelReach, channelRegistry, redact, runStore, egressReader,
                transcriptStore, stationBridge, now }
       deliverCronResult(job, result) -> { ok, error, deliveredTargets, givenUpTargets } | { ok, skipped } | the session hand-back's answer

   A CHAT TARGET IS ONE DURABLE RECORD in the delivery ledger, 'routine:<jobId>:<runId>:<target>': the text in parts, then
   each file (read again through the fire's reader when its turn comes), then the missed-file note. Once it is written,
   the chat's lane drives it to the end, in order with the chat's other replies, each part marked as the platform takes
   it — after a restart too, whatever the cron says by then (a started digest finishes even if its routine is paused).
   deliverCronResult answers after the record's FIRST attempt: done is delivered; still queued is pending (the cron clock
   asks again later, and the ledger is always asked first, so nothing is sent twice); a tombstone is failed and never
   sent again. A target is listed in deliveredTargets as soon as its first part landed, and stays listed if it is given
   up later, so an older build after a downgrade skips it instead of sending its parts again, and so does this build
   once the tombstone that stood for it is pruned (the cron goes on asking). A target given up for good, at its first
   part too, is also in givenUpTargets, which the cron keeps with the receipt: once its tombstone is pruned this build
   still answers it as given up and never sends it again, and an older build skips it as listed. The record stays 'done' until
   deliveryRecorded(jobId, runId, out) releases it, once the cron's markDelivery naming its target is on disk: a process
   that dies in between is asked again and sends nothing.

   A SESSION'S RETURN IS A ROW OF ITS OWN (turn identity, commit 10). A routine that hands its result back to the session it was
   made in writes it there FIRST through deps.writeDelivery (index.js: TurnDelivery.write over the transcript store, the one writer
   of a delivery row: strict, once per session and run, redacted), then asks the page to fold it in (station.deliver, now carrying
   that row's rowId and turnId so the page's copy is keyed at once). A page that is away or refuses leaves the row where it is: the
   retry finds it and sends the same identity, and a page that opens the session later reads it from the station. A write the disk
   refuses is a failed delivery with no page command sent. Worker deliveries are not this path. A harness built by hand that supplies
   no writeDelivery gets the page command alone, as before the row existed (index.js always supplies it).

   Pure: the clock (now) is injected like every store and gate. */
'use strict';

const { note: failNote, swallow } = require('./failopen.js');
const TurnKinds = require('../frontend/app/turnkinds.js');
const RoutineMedia = require('./routine-media.js');               // a chat-bound routine's delivery carries its files
const RunOutcome = require('../frontend/app/runoutcome.js');      // a stopped fire is worded as a stop (typed-outcomes)
const Publication = require('./channels/history-publication.js');

function makeRoutineDelivery(deps) {
  const d = deps || {};
  const need = ['channelStore', 'channelOutbound', 'channelReach', 'channelRegistry', 'redact', 'runStore', 'egressReader',
    'transcriptStore', 'stationBridge', 'now'];
  const missing = need.filter(k => !d[k]);
  if (missing.length) throw new Error('makeRoutineDelivery: missing ' + missing.join(', '));
  const channelStore = d.channelStore, channelOutbound = d.channelOutbound, channelReach = d.channelReach, channelRegistry = d.channelRegistry;
  const redact = d.redact, runStore = d.runStore, egressReader = d.egressReader;
  const transcriptStore = d.transcriptStore, stationBridge = d.stationBridge;
  const now = d.now;
  // the one writer of a delivery row, over the same transcript store (index.js: fields => TurnDelivery.write(transcriptStore, fields))
  const writeDelivery = typeof d.writeDelivery === 'function' ? d.writeDelivery : null;
  const ledger = () => channelStore.ledger;

  // G7 pre-spend delivery/config proof. A scheduled model run must not spend when its configured destination is
  // already known to be absent or down. This is synchronous and secret-free; the driver persists one alert per
  // unchanged fingerprint and retries on the schedule without an event storm.
  function cronReturnsToSession(job) {
    const origin = job && job.origin;
    if (!(origin && (origin.sessionId || origin.streamId))) return false;
    const mode = String(job.deliver || 'local').trim();
    return (mode === 'local' && !!job.attachToSession)
      || (mode === 'origin' && !origin.target && !(origin.channel && origin.chatId));
  }
  /* cronDeliveryNote(job) -> the [DELIVERY] paragraph a CHAT-bound routine's run carries (routine-media.js): how to
     attach a file to the reply the station delivers. Resolved like deliverCronResult resolves targets, so only a routine
     whose reply really goes to a chat is told — local and session routines compose the exact pre-note system. */
  function cronDeliveryNote(job) {
    try {
      const mode = String((job && job.deliver) || 'local').trim();
      let recs = [];
      if (mode === 'origin' && job.origin && job.origin.target) recs = [channelStore.getChatRecord(String(job.origin.target))];
      else if (mode === 'origin' && job.origin && job.origin.channel && job.origin.chatId) recs = [job.origin];
      else if (mode.indexOf('targets:') === 0) recs = mode.slice(8).split(',').map(s => s.trim()).filter(Boolean).slice(0, 16).map(t => channelStore.getChatRecord(t));
      const names = recs.filter(Boolean).map(r => {
        const base = String(r.channel || 'telegram').split(':')[0];
        const desc = channelRegistry.get(base);
        return (desc && desc.label) || base;
      });
      return RoutineMedia.deliveryNote(names);
    } catch (e) { failNote('cron.deliveryNote', e); return ''; }
  }
  function cronPreflightConfig(job) {
    const mode = String((job && job.deliver) || 'local').trim();
    if (mode === 'local') {
      if (job && job.attachToSession && !(job.origin && (job.origin.sessionId || job.origin.streamId))) {
        return { ok: false, code: 'missing-session-origin', reason: 'session delivery has no captured session; re-save the routine from the intended session' };
      }
      return { ok: true };
    }
    let targets = [];
    if (mode === 'origin') {
      if (cronReturnsToSession(job)) return { ok: true };
      if (job && job.origin && job.origin.target) targets = [String(job.origin.target)];
      else if (job && job.origin && job.origin.channel && job.origin.chatId) targets = ['@origin'];
      else return { ok: false, code: 'missing-origin', reason: 'origin delivery has no captured channel target; re-save the routine from the intended chat' };
    } else if (mode.indexOf('targets:') === 0) {
      targets = mode.slice(8).split(',').map(s => s.trim()).filter(Boolean);
      if (!targets.length) return { ok: false, code: 'empty-targets', reason: 'delivery target list is empty; choose at least one connected chat or local delivery' };
    } else if (mode === 'all') {
      return { ok: false, code: 'dynamic-all-targets', reason: 'all-target delivery is not a durable approved snapshot; re-save explicit connected targets' };
    } else {
      return { ok: false, code: 'unknown-delivery-mode', reason: 'delivery mode "' + mode + '" is not configured; choose local, origin, or approved targets' };
    }
    for (const target of Array.from(new Set(targets)).slice(0, 16)) {
      const rec = target === '@origin' ? job.origin : channelStore.getChatRecord(target);
      if (!rec) return { ok: false, code: 'missing-target', reason: 'delivery target "' + target + '" no longer exists; re-save or remove it' };
      const channel = String(rec.channel || 'telegram');
      if (!channelReach(channel).ok) {
        return { ok: false, code: 'channel-unavailable', reason: 'delivery channel "' + channel + '" is not connected and healthy; reconnect it or choose local delivery' };
      }
    }
    return { ok: true };
  }

  // The delivery of a routine's newest result names the older ones that will not come (cron-store supersedeDeliveries).
  // It promises no place to find them: HISTORY lists only a routine's latest runs, and a script-only routine records
  // no run rows at all — the note says only what is certain.
  function cronSupersededNote(n) {
    n = Math.max(0, parseInt(n, 10) || 0);
    if (!n) return '';
    return '\n\n(' + n + ' earlier result' + (n === 1 ? '' : 's') + ' of this routine ' + (n === 1 ? 'was' : 'were') + ' not delivered and will not be resent.)';
  }

  // ---- the records: one per target of one run ------------------------------------------------------------------------
  const recordId = (jobId, runId, target) => 'routine:' + String(jobId) + ':' + String(runId) + ':' + String(target);
  const tombOf = (id) => { try { return ledger().tombstones().find(t => t.id === id) || null; } catch (e) { failNote('cron.delivery.tombstones', e); return null; } };
  function recordsOf(jobId, runId) {
    const head = recordId(jobId, runId, '');
    let all = [];
    try { all = ledger().deliveries(); } catch (e) { failNote('cron.delivery.ledger', e); all = []; }
    return all.filter(x => x.kind === 'routine' && (Publication.hasMetadata(x)
      ? Publication.binding(x).jobId === jobId && x.runId === runId : x.id.indexOf(head) === 0));
  }
  /* deliveryStarted(jobId, runId) — something of this run's result has gone out: a part landed, or one is on the wire. Its
     lane drives it to the end, so the cron's supersede never drops it (a half-sent digest finishes), and a pause no longer
     holds its bookkeeping. A record NOTHING of which has gone is not started: the chat that refused its first part may
     refuse for hours, and every fire would otherwise queue one more digest for one burst when it comes back. The cron
     still supersedes those to the newest, and deliveryWithdrawn(jobId, runId) takes back what it dropped or re-counted
     (a re-counted result is queued again at its next ask, its note saying the new count: text in a record cannot change).
     deliveryRecorded(jobId, runId, out) — the cron's markDelivery for this run is on disk, naming
     out.deliveredTargets: the records it names that are done may go. One it does not name stays: it finished while the
     cron was asking, and a record that left unnamed would be sent again whole by the next ask. (One that never is
     released is pruned after 7 days.) */
  function deliveryStarted(jobId, runId) { return recordsOf(jobId, runId).some(x => started(x) || ledger().onWire(x.id)); }
  function deliveryWithdrawn(jobId, runId) {
    for (const x of recordsOf(jobId, runId)) {
      try { ledger().withdraw(x.id); } catch (e) { failNote('cron.delivery.withdraw', e); }
    }
  }
  async function deliveryRecorded(jobId, runId, out) {
    const named = new Set(Array.isArray(out && out.deliveredTargets) ? out.deliveredTargets.map(String) : []);
    const head = recordId(jobId, runId, '');
    const proofs = Publication.receipts(Publication.owns(out, 'historyPublications') ? out.historyPublications : [], { jobId, runId });
    if (Publication.owns(out, 'historyPublications') && out.ok !== true) return false;
    let complete = true;
    // A persisted cron receipt survives ledger release. Re-prove the canonical row before
    // treating fresh durable absence as an idempotent release after a crash.
    for (const proof of proofs) {
      try {
        await confirmPublished(proof);
        if (ledger().release(proof.deliveryId, proof) !== true) complete = false;
      } catch (e) { failNote('cron.delivery.release', e); complete = false; }
    }
    for (const x of recordsOf(jobId, runId)) {
      if (Publication.hasMetadata(x)) {
        if (x.state === 'done' && !proofs.some(p => p.deliveryId === x.id)) complete = false;
        continue;
      }
      if (Publication.owns(out, 'historyPublications')) { complete = false; continue; }
      if (x.state !== 'done' || !named.has(x.id.slice(head.length))) continue;
      try { if (ledger().release(x.id) !== true) complete = false; } catch (e) { failNote('cron.delivery.release', e); complete = false; }
    }
    return complete;
  }
  const started = (x) => !!x && (x.state === 'done' || x.parts.some(p => p.sent));

  function historyContext(channel, chatId, streamId) {
    if (!d.history || typeof d.historyContext !== 'function') Publication.refuse('The chat history owner is unavailable');
    const actual = d.historyContext(channel, chatId);
    if (!actual) Publication.refuse('The chat history destination is unavailable');
    if (streamId === undefined) return actual;
    // The ledger/cron proof supplies the OLD destination, never today's chat binding.
    return d.history.context({ store: actual.store, channel, chatId, bindChats: false, streamIdFor: () => streamId });
  }
  async function confirmPublished(proof) {
    const chat = historyContext(proof.channel, proof.chatId, proof.streamId);
    const row = await d.history.deliver({ chat, agentId: proof.agentId, runId: proof.runId, text: '', existingOnly: true });
    if (!row || row.rowId !== proof.rowId || row.turnId !== proof.turnId) Publication.refuse('The saved routine publication no longer matches its row');
    return proof;
  }
  async function publishRecord(job, result, target, prior) {
    const id = recordId(job.id, result.runId, target), record = ledger().publication(id);
    const destination = Publication.record(record);
    if (destination.jobId !== job.id || destination.target !== target || record.runId !== result.runId || record.agentId !== job.agentId) {
      Publication.refuse('The completed delivery belongs to another routine result');
    }
    if (prior && (prior.deliveryId !== id || ['channel', 'chatId', 'agentId', 'runId'].some(k => prior[k] !== record[k]) || prior.streamId !== destination.streamId)) {
      Publication.refuse('The saved routine publication conflicts with its delivery');
    }
    const parts = record.parts.filter(p => p.kind === 'text').sort((a, b) => a.n - b.n);
    if (!parts.length) Publication.refuse('The completed routine has no delivered text');
    if (parts.some(p => Publication.owns(p, 'raw') && typeof p.raw !== 'string')) Publication.refuse('The completed routine text is ambiguous');
    const text = parts.map(p => typeof p.raw === 'string' ? p.raw : p.text).join('');
    const chat = historyContext(record.channel, record.chatId, destination.streamId);
    const row = await d.history.deliver({ chat, agentId: record.agentId, runId: record.runId, text, sourceStream: 'cron-' + record.runId,   // the routine run's own rows name the sessions it read: the delivered copy quotes them too
      existingOnly: !!record.sessionTurns || !!prior });
    if (prior && (!row || row.rowId !== prior.rowId || row.turnId !== prior.turnId)) Publication.refuse('The saved routine publication conflicts with its canonical row');
    const ack = ledger().noteSession(id, { streamId: destination.streamId, rowId: row && row.rowId, turnId: row && row.turnId });
    Publication.acknowledgement(ack, record);
    return Publication.receipt({ v: 1, target, deliveryId: id, channel: record.channel, chatId: record.chatId,
      streamId: ack.streamId, agentId: record.agentId, runId: record.runId, rowId: ack.rowId, turnId: ack.turnId },
    { jobId: job.id, runId: result.runId, agentId: job.agentId, targets: [target] });
  }

  // A file part is read again when its turn comes (after a restart too): through the fire's reader, which picks the run
  // row that produced the name; the missed-file note names what did not come by its shown name, never a host path.
  channelOutbound.provide('routine', {
    read: async (rec, part) => {
      let runs = [];
      try { runs = runStore.list(null, { streamId: 'cron-' + rec.runId, limit: 50 }) || []; } catch (e) { failNote('cron.delivery.runs', e); runs = []; }
      const read = egressReader.fireReader(runs, rec.agentId, part.workdir || '');
      return RoutineMedia.readItem({ path: part.path, agents: Array.isArray(part.agents) && part.agents.length ? part.agents : [rec.agentId], root: part.root }, read);
    },
    // missed = { failed, unreadable } (channels/outbound.js): the one wording tells a file on the station from one that is not,
    // and words each unreadable one by what the reader said of it (refused with its reason, not found, or never read)
    note: (rec, missed) => {
      for (const p of rec.parts) if (p.kind === 'file' && p.error) console.warn('[cron] routine delivery ' + rec.id + ' file "' + p.path + '" not attached [' + rec.channel + ']: ' + p.error);
      const shown = (p) => { try { return egressReader.shownName(egressReader.pathsFor(rec.agentId), p); } catch (e) { failNote('cron.delivery.shownName', e); return ''; } };
      return RoutineMedia.missedNote(missed, shown);
    }
  });

  /* FILES RIDE THE CHAT DELIVERY (routine-media.js, 2026-10-18). An unattended run cannot channel.send (the exec
     lockout), so this is the only way a routine's image or chart reaches the chat: the ATTACH lines its reply names,
     else the images the fire generated (its run rows' artifacts — durable, so a retried delivery finds them too).
     Same approved target, same read as channel.send. A reply with no ATTACH line and no generated image
     delivers byte-identically to before. Worked out once per call, and only when a target still needs its record. */
  async function chatPlan(job, result, text, supersededNote) {
    let chatBody = String(result.text || ''), chatText = text, attach = { files: [], dropped: [] }, named = [], runs = [], refused = [];
    if (result.outcome !== 'failed') {
      const candidates = RoutineMedia.parseReply(result.text).files;
      try { runs = runStore.list(null, { streamId: 'cron-' + result.runId, limit: 50 }) || []; } catch (e) { failNote('cron.delivery.runs', e); runs = []; }
      // Each name is read through the ONE row of this fire that produced it (its artifact ledger, else the one folder of
      // the fire that holds it; two different files under one name are refused): a project routine's `ATTACH: report.md`
      // names the project's file, never a stale same-named one in another agent's private workspace (egress-files.js
      // fireReader). The fire reader picks the row itself, so the name is asked once, not once per agent.
      const fireRead = egressReader.fireReader(runs, job.agentId, job.workdir || '');
      // A named path is an instruction only if the file is really there: read it first (before any word is sent), so a
      // line naming nothing on the station ("MEDIA: N/A") stays in the message as written, with no missing-file note.
      const read = candidates.length ? await RoutineMedia.readNamed(candidates, [job.agentId], fireRead) : { found: [], missing: [] };
      const found = read.found;
      named = found.map(f => f.path);
      // A REFUSED name is never silent (review round 4, MAJOR-2): a file the reader would not send (a hard link, a name
      // outside the run's folders, a protected file) is logged here, its line is stripped, and the missed-file note names
      // it by its shown name. Only a name that is simply not there stays as the routine wrote it.
      refused = read.missing.filter(m => m && m.refused);
      for (const m of refused) console.warn('[cron] routine ' + job.id + ' file "' + m.path + '" refused: ' + m.error);
      // a name whose read threw stays as written (the station never saw it); only the console hears why
      for (const m of read.missing) if (m && m.unread) console.warn('[cron] routine ' + job.id + ' file "' + m.path + '" was not read: ' + m.error);
      // generated images ride unasked only for a routine holding ALLOW IMAGES (the studio grant) — never for one that
      // makes pictures for another purpose (routine-media.js pickFiles)
      attach = RoutineMedia.pickFiles({ named: found, runs: runs, agentId: job.agentId, generatedImages: Array.isArray(job.unattendedGrants) && job.unattendedGrants.indexOf('studio') >= 0 });
      if (named.length || refused.length) {
        const parsed = RoutineMedia.parseReply(result.text, named.concat(refused.map(m => m.path)));
        chatBody = parsed.text;
        chatText = '✦ ' + (job.name || 'Routine') + (parsed.text.trim() ? '\n\n' + parsed.text : '') + supersededNote;
      }
    }
    return { chatBody: chatBody, chatText: chatText, attach: attach, named: named, runs: runs, refused: refused };
  }
  /* THE MEDIA OF ONE TARGET'S RECORD. The words go first and the files follow (channel.send's law): a channel that cannot
     upload never swallows the message. A file refused for the moment waits on its lane's backoff (each part has its own
     mark, so nothing else goes out again); one that cannot go is told to the chat in the note, and never silent — the
     Commander would be waiting for a picture that is not coming. A Full Access fire may already have put its own files
     here with channel.send — never the same picture twice. */
  function mediaFor(plan, job, target, chatId) {
    const withFiles = (plan.attach.files.length || (plan.named.length && plan.attach.dropped.length)) && !RoutineMedia.filesAlreadySent(plan.runs, target, chatId);
    const files = withFiles ? plan.attach.files.map(f => ({ path: f.path, agents: f.agents, root: f.root, workdir: job.workdir || '' })) : [];
    // what is already known not to come: the files over the cap (when the reply named its files: they are on the station),
    // and the names the reader refused, each with what it said (never said to be on the station, nor missing: comms.js
    // missedNote, c0beb187 and the 0.14.2 review: a refused one is named with its reason, and `rule` only when a send rule said no)
    const missed = withFiles && plan.named.length ? plan.attach.dropped : [];
    const refused = plan.refused.map(m => ({ path: m.path, rule: m.rule === true, reason: m.error, shown: m.shown }));
    return { files: files, missed: missed, refused: refused };
  }

  async function deliverCronResult(job, result) {
    if (!job || !result || result.outcome === 'silent') return { ok: true, skipped: true };
    const supersededNote = cronSupersededNote(result.superseded);
    if (job.noAgent) {
      try {
        const streamId = 'cron-' + result.runId;
        const recorded = transcriptStore.view('proof', streamId, { limit: 2 });
        // provenance on both rows (memory-learning-07): the routine's prompt is the Commander's own; the script's stdout is
        // untrusted output, the same as the <untrusted_script_output> a scheduled pre-check script hands a run
        if (!recorded.some(t => t.role === 'user')) transcriptStore.append({ streamId, agentId: job.agentId, role: 'user', taint: null, content: String(job.prompt || ''), turnId: TurnKinds.runTurnId(result.runId), sourceRunId: result.runId, kind: 'routine' });
        if (!recorded.some(t => t.role === 'assistant')) transcriptStore.append({ streamId, agentId: job.agentId, role: 'assistant', taint: 'scheduled script output', content: result.outcome === 'failed' ? String(result.error || 'script failed') : String(result.text || ''), turnId: TurnKinds.runTurnId(result.runId), sourceRunId: result.runId, kind: 'routine' });
      } catch (e) { failNote('cron.script.transcript', e); }
    }
    // a fire SOMEONE STOPPED (the finalization's runOutcome, cron-store markRun; review r7) is worded as a stop by RunOutcome.line —
    // never "✦ <routine> failed" (its coarse finalization outcome stays 'failed': it is no result to deliver as done)
    const stoppedFire = result.runOutcome === 'stopped';
    const text = (result.outcome === 'failed'
      ? ('✦ ' + (job.name || 'Routine') + (stoppedFire ? ' — ' + RunOutcome.line({ outcome: 'stopped' }) : ' failed') + '\n\n' + String(result.error || (stoppedFire ? 'Someone stopped this run.' : 'The run failed.')))
      : ('✦ ' + (job.name || 'Routine') + '\n\n' + String(result.text || '(completed with no text)'))) + supersededNote;
    const mode = String(job.deliver || 'local').trim(), targets = [];
    if (mode === 'origin' && job.origin && job.origin.target) targets.push(String(job.origin.target));
    else if (mode === 'origin' && job.origin && job.origin.channel && job.origin.chatId) targets.push('@origin');
    else if (mode === 'all') { // legacy/hand-edited dynamic fanout is not authority; new writes snapshot targets
      return { ok: false, error: 'all-target delivery needs an approved target snapshot' };
    }
    else if (mode.indexOf('targets:') === 0) targets.push(...mode.slice(8).split(',').map(s => s.trim()).filter(Boolean));
    else if (cronReturnsToSession(job)) {
      /* THE RETURN IS A ROW BEFORE IT IS A PAGE COMMAND (turn identity, commit 10). The reply is written into the session it came
         from first, strictly and once per (session, run): the page cannot be what makes it exist. A retry (the page was away or
         refused, or the station restarted in between) finds that same row and sends its identity again; with no page connected
         the row is already in the station's transcript, and the page finds it the next time it opens the session. A write the
         disk refuses is a failed delivery with the page never asked, so the cron asks again later and nothing was marked done. */
      const sent = redact(text);
      let row = null;
      if (typeof writeDelivery === 'function') {   // (typeof: a harness that slices this function names only the dependencies it supplies)
        try {
          row = writeDelivery({ streamId: job.origin.streamId || job.origin.sessionId, agentId: job.agentId, runId: result.runId, text: sent, sourceStream: 'cron-' + result.runId,   // the routine run's own rows name the sessions it read: the delivered copy quotes them too
            ...(job.noAgent ? { taint: 'scheduled script output' } : {}) });   // a script's stdout is untrusted, and the host knows it; every other taint is not provable from the result
        } catch (e) {
          failNote('cron.session.write', e);
          return { ok: false, error: 'The result could not be saved to the conversation it came from: ' + ((e && e.message) || e) };
        }
      }
      const out = await stationBridge.request('station.deliver', { sessionId: job.origin.sessionId || job.origin.streamId, streamId: job.origin.streamId || job.origin.sessionId, sessionTitle: job.origin.sessionTitle || '', text: sent, prompt: job.prompt, runId: result.runId, agentId: job.agentId, ts: now(), ...(row ? { rowId: row.rowId, turnId: row.turnId } : {}) });
      return out;
    }
    if (!targets.length) return { ok: true, skipped: true };

    const prior = Array.isArray(result.deliveredTargets) ? result.deliveredTargets.map(String) : [];
    // the targets an earlier ask found given up for good (the cron keeps them with the receipt, markDelivery givenUpTargets)
    const givenUp = Array.isArray(result.givenUpTargets) ? result.givenUpTargets.map(String) : [];
    const list = Array.from(new Set(targets)).slice(0, 16);
    const savedPublications = Publication.receipts(Publication.owns(result, 'historyPublications') ? result.historyPublications : [],
      { jobId: job.id, runId: result.runId, agentId: job.agentId, targets: list });
    if (savedPublications.some(p => givenUp.includes(p.target))) Publication.refuse('A refused destination cannot claim routine publication');
    if (savedPublications.some(p => !prior.includes(p.target))) Publication.refuse('The saved publication has no completed transport receipt');
    let plan = null;
    const planOnce = () => plan || (plan = chatPlan(job, result, text, supersededNote));
    // per target: its record's first attempt in this call (a record the ledger already holds is asked, never written again)
    const outcomes = await Promise.all(list.map(async (target) => {
      try {
      const id = recordId(job.id, result.runId, target);
      const held = ledger().delivery(id);
      if (held) {
        if (job.attachToSession) {
          const destination = Publication.record(held);
          if (destination.jobId !== job.id || destination.target !== target || held.runId !== result.runId || held.agentId !== job.agentId) {
            Publication.refuse('The saved delivery belongs to another routine result');
          }
          if (savedPublications.some(p => p.target === target) && held.state !== 'done') Publication.refuse('The published delivery is not confirmed complete');
        }
        if (held.state !== 'done') {
          // only asking how it goes: its first attempt reported itself, and its landing will (one delivery, one report)
          const first = ledger().whenAttempted(id, { quiet: true });
          ledger().drive(held.chat).catch(swallow('cron.delivery.lane'));
          await first;
        }
        return { target, id };
      }
      const tomb = tombOf(id);
      if (tomb) return { target, id, error: tomb.error || 'undeliverable', gaveUp: true };   // refused for good: never sent again
      // ...and so it stays once that bounded tombstone is pruned (30 days, or 50 newer on its channel): the receipt says it
      if (givenUp.indexOf(target) >= 0) return { target, error: 'undeliverable: the platform refused it for good, and it is not sent again', gaveUp: true };
      if (prior.indexOf(target) >= 0) return { target, delivered: true };             // delivered before (its record released)
      const rec = target === '@origin' ? job.origin : channelStore.getChatRecord(target);
      if (!rec) return { target, error: 'unknown chat target ' + target };
      const chatId = String(rec.chatId || target);
      const p = await planOnce();
      const media = mediaFor(p, job, target, chatId);
      const channel = String(rec.channel || 'telegram');
      let historyDestination;
      if (job.attachToSession) {
        const chat = historyContext(channel, chatId);
        const streamId = await d.history.destination({ chat, agentId: job.agentId });
        historyDestination = Publication.destination({ v: 1, streamId, jobId: job.id, target });
      }
      // an explicit route wins: the thread the routine was made in (its origin) or its target's own; else the chat's last
      const out = await channelOutbound.send({ channel, chatId: chatId }, p.chatText, {
        durable: true, deliveryId: id, kind: 'routine', release: 'caller', reason: 'routine', runId: result.runId, agentId: job.agentId,
        ...(historyDestination ? { historyDestination } : {}),
        route: rec.threadId ? { threadId: String(rec.threadId) } : null, media: media.files,
        // the missed-file note rides last, only when a file goes or one is already known not to come
        note: (media.files.length || media.missed.length || media.refused.length) ? { missed: media.missed, refused: media.refused } : null
      });
      if (out.refused || !out.id) return { target, error: out.error || 'could not be queued' };   // the channel is down: asked again later
      return { target, id };
      } catch (e) { return { target, error: (e && e.message) || 'The routine delivery could not be confirmed' }; }
    }));

    let failed = 0, firstError = '';
    const deliveredTargets = new Set(prior);
    const givenUpTargets = new Set(givenUp);
    for (const o of outcomes) {
      if (o.delivered) continue;
      const x = o.id ? ledger().delivery(o.id) : null;
      const tomb = (o.id && !x) ? tombOf(o.id) : null;
      // its first part landed: an older build skips it now, and so will this one when a tombstone that stands for it is pruned
      if ((x && started(x)) || (tomb && tomb.sent > 0)) deliveredTargets.add(o.target);
      /* GIVEN UP FOR GOOD, from its first part on too (review round 1): the tombstone is bounded, and the cron goes on asking
         about a result that did not land (a one-shot's, or a monitor's whose later results are silent). Once it was pruned
         the next ask found no record, no tombstone and no listed target, and sent the result again to a chat that had
         refused it, with a second 'undeliverable'. The receipt keeps the target as given up (this build reads it), and lists
         it among the targets an older build skips. */
      if (o.gaveUp || tomb) { givenUpTargets.add(o.target); deliveredTargets.add(o.target); }
      if (x && x.state === 'done') continue;
      failed++;
      let error = o.error;
      if (!error && x) error = 'still being delivered: ' + (x.lastError || 'waiting for the channel');
      if (!error) error = (tomb && tomb.error) || 'undeliverable';
      firstError = firstError || error;
    }
    const published = new Map(savedPublications.map(p => [p.target, p]));
    if (job.attachToSession) for (const target of list) {
      try {
        if (givenUpTargets.has(target)) continue;
        const id = recordId(job.id, result.runId, target), x = ledger().delivery(id), old = published.get(target);
        if (x && x.state === 'done') {
          published.set(target, await publishRecord(job, result, target, old));
          // Another target may finish while an earlier canonical publication awaits. Its
          // strict publication proves complete transport; keep the returned receipt aligned.
          deliveredTargets.add(target);
        }
        else if (!x && prior.includes(target)) {
          if (!old) Publication.refuse('The original delivery destination is unknown; the result will not be sent again');
          await confirmPublished(old);
        }
      } catch (e) { failed++; firstError = firstError || (e && e.message) || 'The routine publication could not be confirmed'; }
    }
    return { ok: failed === 0, error: firstError || null, deliveredTargets: Array.from(deliveredTargets), givenUpTargets: Array.from(givenUpTargets),
      ...(job.attachToSession ? { historyPublications: [...published.values()] } : {}) };
  }

  return { deliverCronResult, cronPreflightConfig, cronDeliveryNote, cronReturnsToSession, cronSupersededNote, deliveryStarted, deliveryWithdrawn, deliveryRecorded, recordId };
}

module.exports = { makeRoutineDelivery };
