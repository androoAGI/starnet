/* sidecar/routine-delivery.js — where a scheduled routine's result goes: a chat target (in parts, with its files), the
   session it came from, or nowhere (a silent result) — and the pre-spend proof that its destination is there.

   Moved out of sidecar/index.js unchanged (channel-delivery-ledger, S1); index.js builds one over its own stores, gates and
   scrub, and hands deliverCronResult, cronPreflightConfig and cronDeliveryNote to the cron driver.

     makeRoutineDelivery(deps) -> { deliverCronResult, cronPreflightConfig, cronDeliveryNote, cronReturnsToSession,
                                    cronChatTurn, cronSendPart, cronSupersededNote }
       deps = { channelStore, channelReach, channelRegistry, scrubOutbound, redact, runStore, egressReader,
                readChannelUpload, transcriptStore, stationBridge, now, setTimeout? }
       deliverCronResult(job, result) -> { ok, error, deliveredTargets } | { ok, skipped } | the session hand-back's answer

   Pure: the clock (now) and the timer a 429 wait uses (setTimeout) are injected like every store and gate. */
'use strict';

const { note: failNote } = require('./failopen.js');
const RoutineMedia = require('./routine-media.js');               // a chat-bound routine's delivery carries its files
const RunOutcome = require('../frontend/app/runoutcome.js');      // a stopped fire is worded as a stop (typed-outcomes)
const { chunkText: hubChunkText } = require('./channels/chunk.js');   // the hub's one chunker

function makeRoutineDelivery(deps) {
  const d = deps || {};
  const need = ['channelStore', 'channelReach', 'channelRegistry', 'scrubOutbound', 'redact', 'runStore', 'egressReader',
    'readChannelUpload', 'transcriptStore', 'stationBridge', 'now'];
  const missing = need.filter(k => !d[k]);
  if (missing.length) throw new Error('makeRoutineDelivery: missing ' + missing.join(', '));
  const channelStore = d.channelStore, channelReach = d.channelReach, channelRegistry = d.channelRegistry;
  const scrubOutbound = d.scrubOutbound, redact = d.redact, runStore = d.runStore, egressReader = d.egressReader;
  const readChannelUpload = d.readChannelUpload, transcriptStore = d.transcriptStore, stationBridge = d.stationBridge;
  const now = d.now;
  const setTimer = typeof d.setTimeout === 'function' ? d.setTimeout : setTimeout;

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

  /* ONE ROUTINE DELIVERY PER CHAT AT A TIME (upgrade review 2026-10-23). A long reply goes out in parts, one awaited send
     each; two routines delivering to the same chat at once (a recovery pass runs several receipts together) interleaved
     their parts. Each chat is a FIFO: a delivery waits for the one ahead of it to finish, words and files both. */
  const cronChatTails = new Map();
  function cronChatTurn(key, fn) {
    const run = (cronChatTails.get(key) || Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    cronChatTails.set(key, tail);
    tail.then(() => { if (cronChatTails.get(key) === tail) cronChatTails.delete(key); });
    return run;
  }
  // Telegram answers a burst with 429 + retry_after: wait it out once for THIS part (a short, bounded wait) rather than
  // fail the delivery, whose retry would resend every part that already landed.
  async function cronSendPart(adapter, chatId, text, route) {
    let sent = await adapter.send(chatId, text, route);
    const wait = Number(sent && sent.ok === false && sent.retryable ? sent.retryAfter : 0);
    if (wait > 0 && wait <= 30) {
      await new Promise(r => setTimer(r, wait * 1000 + 250));
      sent = await adapter.send(chatId, text, route);
    }
    return sent;
  }
  // The delivery of a routine's newest result names the older ones that will not come (cron-store supersedeDeliveries).
  // It promises no place to find them: HISTORY lists only a routine's latest runs, and a script-only routine records
  // no run rows at all — the note says only what is certain.
  function cronSupersededNote(n) {
    n = Math.max(0, parseInt(n, 10) || 0);
    if (!n) return '';
    return '\n\n(' + n + ' earlier result' + (n === 1 ? '' : 's') + ' of this routine ' + (n === 1 ? 'was' : 'were') + ' not delivered and will not be resent.)';
  }

  async function deliverCronResult(job, result) {
    if (!job || !result || result.outcome === 'silent') return { ok: true, skipped: true };
    const supersededNote = cronSupersededNote(result.superseded);
    if (job.noAgent) {
      try {
        const streamId = 'cron-' + result.runId;
        const recorded = transcriptStore.reconstruct(streamId, { limit: 2 });
        // provenance on both rows (memory-learning-07): the routine's prompt is the Commander's own; the script's stdout is
        // untrusted output, the same as the <untrusted_script_output> a scheduled pre-check script hands a run
        if (!recorded.some(t => t.role === 'user')) transcriptStore.append({ streamId, agentId: job.agentId, role: 'user', taint: null, content: String(job.prompt || '') });
        if (!recorded.some(t => t.role === 'assistant')) transcriptStore.append({ streamId, agentId: job.agentId, role: 'assistant', taint: 'scheduled script output', content: result.outcome === 'failed' ? String(result.error || 'script failed') : String(result.text || '') });
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
      const out = await stationBridge.request('station.deliver', { sessionId: job.origin.sessionId || job.origin.streamId, streamId: job.origin.streamId || job.origin.sessionId, sessionTitle: job.origin.sessionTitle || '', text: redact(text), prompt: job.prompt, runId: result.runId, agentId: job.agentId, ts: now() });
      return out;
    }
    if (!targets.length) return { ok: true, skipped: true };
    /* FILES RIDE THE CHAT DELIVERY (routine-media.js, 2026-10-18). An unattended run cannot channel.send (the exec
       lockout), so this is the only way a routine's image or chart reaches the chat: the ATTACH lines its reply names,
       else the images the fire generated (its run rows' artifacts — durable, so a retried delivery finds them too).
       Same approved target, same read as channel.send. A reply with no ATTACH line and no generated image
       delivers byte-identically to before. */
    let chatBody = String(result.text || ''), chatText = text, attach = { files: [], dropped: [] }, named = [], runs = [], refused = [];
    let fireRead = readChannelUpload;
    if (result.outcome !== 'failed') {
      const candidates = RoutineMedia.parseReply(result.text).files;
      try { runs = runStore.list(null, { streamId: 'cron-' + result.runId, limit: 50 }) || []; } catch (_) { runs = []; }
      // Each name is read through the ONE row of this fire that produced it (its artifact ledger, else the one folder of
      // the fire that holds it; two different files under one name are refused): a project routine's `ATTACH: report.md`
      // names the project's file, never a stale same-named one in another agent's private workspace (egress-files.js
      // fireReader). The fire reader picks the row itself, so the name is asked once, not once per agent.
      fireRead = egressReader.fireReader(runs, job.agentId, job.workdir || '');
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
    let failed = 0, firstError = '';
    const deliveredTargets = new Set(Array.isArray(result.deliveredTargets) ? result.deliveredTargets : []);
    for (const target of Array.from(new Set(targets)).slice(0, 16)) {
      if (deliveredTargets.has(target)) continue;
      const rec = target === '@origin' ? job.origin : channelStore.getChatRecord(target);
      if (!rec) { failed++; firstError = firstError || 'unknown chat target ' + target; continue; }
      const channel = String(rec.channel || 'telegram'), reach = channelReach(channel, { attempt: true }), live = reach.live;
      if (!reach.ok) { failed++; firstError = firstError || reach.error; continue; }   // a live handle is not a heartbeat (channels/reach.js)
      const chatId = String(rec.chatId || target), route = rec.threadId ? { threadId: rec.threadId } : undefined;
      await cronChatTurn(channel + '\u0001' + chatId + '\u0001' + String(rec.threadId || ''), async () => {
        try {
          // A routine's reply is as long as the model made it, and the adapter sends ONE message (the hub chunks chat
          // replies before calling it). Sent whole, a digest past Telegram's 4096 was refused "message is too long" on the
          // fire and on every retry — the chat never saw it (2026-10-20). Split it under the platform's ceiling, in order.
          const desc = channelRegistry.get(channel.split(':')[0]);
          // the host-path scrub runs on the WHOLE text before it is split (a path cut at a part boundary went out in halves)
          const parts = hubChunkText(scrubOutbound(redact(chatText)), Number(desc && desc.maxMessageLength) > 200 ? Number(desc.maxMessageLength) : 1900);
          for (let i = 0; i < parts.length; i++) {
            const sent = await cronSendPart(live.adapter, chatId, parts[i], route);
            if (sent && sent.ok === false) throw new Error((sent.error || 'send failed') + (i ? ' (after ' + i + ' of ' + parts.length + ' parts)' : ''));
          }
          deliveredTargets.add(target);
          if (job.attachToSession) {
            channelStore.appendTurn(job.agentId, 'user', '[Scheduled routine: ' + job.name + '] ' + String(job.prompt || ''));
            channelStore.appendTurn(job.agentId, 'assistant', chatBody);
          }
        } catch (e) { failed++; firstError = firstError || ((e && e.message) || String(e)); return; }
        // The words landed, so this target is delivered: a file that fails is told to the chat, never retried (a retry
        // would resend the message), and never silent — the Commander would be waiting for a picture that is not coming.
        // A Full Access fire may already have put its own files here with channel.send — never the same picture twice.
        // Each missed file carries what the station knows of it (routine-media.js missedNote): a refused one its reason,
        // and `rule` only when a send rule said no; never "saved in the workspace" (0.14.2 review: a refused name may not
        // be in the workspace at all).
        let missed = refused.map(m => ({ path: m.path, refused: true, rule: m.rule === true, reason: m.error, shown: m.shown }));
        if ((attach.files.length || (named.length && attach.dropped.length)) && !RoutineMedia.filesAlreadySent(runs, target, chatId)) {
          const files = await RoutineMedia.sendFiles(attach.files, {
            read: fireRead,
            send: (item) => typeof live.adapter.sendMedia === 'function'
              ? live.adapter.sendMedia(chatId, item, route)
              : Promise.resolve({ ok: false, error: channel + ' cannot carry files' })
          });
          for (const f of files.failed) console.warn('[cron] routine ' + job.id + ' file "' + f.path + '" not attached [' + channel + ']: ' + f.error);
          missed = files.failed.concat(named.length ? attach.dropped : []).concat(missed);
        }
        if (missed.length) {
          // the chat sees a jail-relative name or a file name, never an absolute host path (egress-files.js shownName)
          const shown = (p) => { try { return egressReader.shownName(egressReader.pathsFor(job.agentId), p); } catch (e) { failNote('cron.delivery.shownName', e); return ''; } };
          try { await live.adapter.send(chatId, RoutineMedia.missedNote(missed, shown), route); } catch (e) { failNote('cron.delivery.missedNote', e); }
        }
      });
    }
    return { ok: failed === 0, error: firstError || null, deliveredTargets: Array.from(deliveredTargets) };
  }

  return { deliverCronResult, cronPreflightConfig, cronDeliveryNote, cronReturnsToSession, cronChatTurn, cronSendPart, cronSupersededNote };
}

module.exports = { makeRoutineDelivery };
