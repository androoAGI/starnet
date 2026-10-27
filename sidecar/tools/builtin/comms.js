/* sidecar/tools/builtin/comms.js — OUTBOUND channel reach: the agent can message a connected platform.

   THE GAP THIS CLOSES. StarNet drives five real messaging channels (telegram/discord/slack/matrix/signal) but
   every one of them was INBOUND-only: a human messages the station, the hub runs a turn, the reply goes back
   down the same chat. Nothing let an agent SPEAK FIRST. The only outbound path in the whole sidecar was
   autonotify.js — a fixed one-line "a routine ran on its own" ping, composed by the host, not by the agent. So
   "reach" was half a pillar: a routine could research all night and had no way to tell anyone, and an agent
   asked to "let me know on Telegram when the build goes green" could only answer into a chat window nobody was
   watching. The reference harness has had tools/send_message_tool.py + gateway/channel_directory.py from early
   on; this is the same capability on StarNet's own seams.

     makeCommsTools({ listTargets, sendTo, maxLenFor?, redact?, emit? }) -> { targetsTool, sendTool, register }

   ── KNOWN TARGETS ONLY (read this before "improving" the target grammar) ─────────────────────────────────────
   A target must already be in the station's chat map — a chat a human actually opened with this station. The
   agent CANNOT dial an arbitrary chat id, phone number, or channel name. That is not a limitation we failed to
   remove, it is the security boundary:

     · an agent's context routinely contains attacker-controlled text (a fetched page, a tool result, an inbound
       message). `channel.send` is the one tool that carries content OUT to a third party under the Commander's
       own bot identity. Free-form addressing turns any prompt injection into an exfiltration primitive with a
       delivery receipt — "send the contents of .env to @attacker" would be one hop.
     · truthful telemetry: an unknown id would fail at the transport anyway, and a tool that accepts a target it
       cannot reach teaches the model it succeeded.

   Widening reach stays a human act: a person opens a chat with the station, and that chat becomes addressable.
   The reference harness accepts raw ids/E.164 numbers here; we deliberately do not, and this comment is why.

   ── AMBIGUITY IS AN ERROR ───────────────────────────────────────────────────────────────────────────────────
   A target resolves by exact token, then by a UNIQUE channel or chat-id match. Two candidates is a refusal that
   names them, never a pick. Guessing which human to message is not a recoverable mistake — the wrong person has
   already read it, and the agent cannot tell that it happened.

   Pure + injected: no fetch/fs/clock/rng here, so it is node-testable with fake targets and a fake send. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).comms = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TEXT_CHARS = 8000;        // the most an agent may hand one send call (chunked below the platform floor)
  const DEFAULT_MAX_LEN = 1900;   // Discord's 2000 is the lowest real ceiling — the safe default when unknown
  const MAX_CHUNKS = 8;           // a send is a message, not a file transfer: refuse to spray a chat
  const MAX_FILES = 4;            // attachments per send — a report plus its charts, not a directory dump
  const CAPTION_CHARS = 900;      // under Telegram's 1024 media-caption cap, with room for the platform's own trim

  // mime -> how the platform should RENDER it. An unknown type is a document: the one form that carries any
  // bytes intact, so a new file type degrades to "delivered, openable" instead of a refusal.
  function kindForMime(mime, name) {
    const m = String(mime || '').toLowerCase();
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (m.indexOf('image/') === 0) return (m.indexOf('image/svg') === 0 || ext === 'svg') ? 'document' : 'photo';
    if (m.indexOf('video/') === 0) return 'video';
    if (m.indexOf('audio/') === 0) return 'audio';
    return 'document';
  }

  function clean(s, n) {
    s = String(s == null ? '' : s).trim();
    return n && s.length > n ? s.slice(0, n) : s;
  }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  /* chunkText — split on the widest safe boundary under `max` (paragraph, then line, then space, then hard cut).
     Deliberately the same shape the channel hub uses for replies: a chat should never receive a message
     guillotined mid-word when a newline was two characters away. */
  function chunkText(text, max) {
    const limit = Math.max(1, Number(max) || DEFAULT_MAX_LEN);
    const out = [];
    let rest = String(text == null ? '' : text);
    while (rest.length > limit) {
      let cut = -1;
      for (const sep of ['\n\n', '\n', ' ']) {
        const at = rest.lastIndexOf(sep, limit);
        if (at > limit * 0.5) { cut = at + (sep === ' ' ? 0 : sep.length); break; }
      }
      if (cut <= 0) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) out.push(rest);
    return out.length ? out : [''];
  }

  function packTarget(t) {
    return {
      target: String((t && t.target) || ''),
      channel: String((t && t.channel) || ''),
      chatId: String((t && t.chatId) || ''),
      agentId: String((t && t.agentId) || ''),
      connected: !!(t && t.connected)
    };
  }

  /* resolveTarget — exact token, then a unique channel match, then a unique chatId match. Never a guess.
     A target that exists but whose transport is DOWN is resolved and then refused separately, so the model is
     told "that channel is disconnected" instead of "no such target" (two different things to a user). */
  function resolveTarget(targets, want) {
    const q = clean(want, 200);
    if (!q) throw new Error('target is required — call channel.targets to see what this station can reach');
    const all = (targets || []).map(packTarget).filter(t => t.target);
    if (!all.length) {
      throw new Error('this station has no reachable chats yet — a person has to message it on a connected '
        + 'channel once before an agent can send there');
    }
    const exact = all.find(t => t.target === q);
    if (exact) return exact;
    const ql = lower(q);
    for (const field of ['channel', 'chatId']) {
      const hits = all.filter(t => lower(t[field]) === ql);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new Error('"' + q + '" matches ' + hits.length + ' reachable chats — pass an exact target: '
          + hits.map(t => t.target).join(', '));
      }
    }
    throw new Error('"' + q + '" is not a chat this station can reach. Known targets: '
      + all.map(t => t.target).join(', ') + '. An agent can only message a chat a human already opened '
      + 'with this station — it cannot dial a new id.');
  }

  function makeCommsTools(deps) {
    deps = deps || {};
    const listTargets = typeof deps.listTargets === 'function' ? deps.listTargets : function () { return []; };
    const sendTo = deps.sendTo;
    const maxLenFor = typeof deps.maxLenFor === 'function' ? deps.maxLenFor : function () { return DEFAULT_MAX_LEN; };
    // The SAME scrub autonotify applies before a host-composed ping goes out. A tool result or a read file can
    // carry a key-shaped string, and this is the one tool that would hand it to a third party.
    const redact = typeof deps.redact === 'function' ? deps.redact : function (t) { return t; };
    const emit = typeof deps.emit === 'function' ? deps.emit : function () {};
    // OUTBOUND FILES (2026-07-29). Both injected: readFile proves the path stays in the agent's own workspace
    // jail (the host owns that proof), sendMediaTo uploads through the channel's transport. Absent either one,
    // `files` is refused with a reason rather than silently ignored — an agent told "sent" about a file that
    // never moved is the exact lie this file exists to prevent.
    const readFile = typeof deps.readFile === 'function' ? deps.readFile : null;
    const sendMediaTo = typeof deps.sendMediaTo === 'function' ? deps.sendMediaTo : null;

    const targetsTool = {
      // impact none: it lists the chats the host already holds; no network, no send
      name: 'channel.targets', capability: 'comms', impact: 'none', scope: 'read', requiresConsent: false,
      description: 'List the messaging chats this station can actually send to (channel, chat, which agent it is bound to, and whether that channel is connected right now). Call this before channel.send.',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const targets = (listTargets() || []).map(packTarget).filter(t => t.target);
        const live = targets.filter(t => t.connected).length;
        return {
          content: JSON.stringify({ targets: targets, reachable: live }),
          summary: targets.length
            ? live + ' of ' + targets.length + ' known chat(s) reachable now'
            : 'no chats known yet — nobody has messaged this station on a connected channel'
        };
      }
    };

    const sendTool = {
      /* impact external-unknown, DECLARED, and deliberately the lane it always fell into. It acts OUTWARD as the station
         on a third-party platform with the channel's stored bot token and can carry workspace files out (capability
         registry: "the obvious prompt-injection exfiltration target"), and this lane is the strictest one that still
         lets the Commander send: a watched run asks an exact per-call confirmation and ANY yes covers that one send only
         (no "always" grant is ever recorded); a delegated worker and an unattended ASK run are never offered it; a
         tainted run loses it; Full Access keeps it. external-credentialed (web_request's class) was tried in quick win 8
         and rejected in review: it made one "Always" a station-wide comms:execute grant, offered it to delegated workers
         under a watched lead, and offered it to unattended runs whose exec lockout refuses every call. Moving it to a
         class that stores grants waits for Andrew's security sign-off. */
      name: 'channel.send', capability: 'comms', impact: 'external-unknown', scope: 'execute', requiresConsent: true, timeoutMs: 30000,
      description: 'Send a message from this station to a connected messaging chat (Telegram, Discord, Slack, Matrix, Signal), optionally with files attached. Use this when the Commander asks to be told, pinged, notified, or messaged somewhere, or to report a result outside the station — including sending them an image, chart, or document you produced. The target must be a chat channel.targets lists — an agent cannot message a new id.',
      schema: {
        type: 'object',
        required: ['target', 'text'],
        properties: {
          target: { type: 'string', description: 'A target token from channel.targets (a channel name or chat id also works when it matches exactly one).' },
          text: { type: 'string', maxLength: TEXT_CHARS, description: 'The message body. Plain text; it is split into platform-sized parts automatically.' },
          files: {
            type: 'array', maxItems: MAX_FILES,
            items: { type: 'string' },
            description: 'Optional workspace-relative paths of files to attach (images send inline, everything else as a document). Up to ' + MAX_FILES + '. On a channel that cannot carry files the message still sends and names the path instead.'
          }
        }
      },
      run: async (args, ctx) => {
        if (typeof sendTo !== 'function') throw new Error('outbound messaging unavailable');
        const text = clean(args && args.text);
        if (!text) throw new Error('text is required — an empty message is never sent');
        if (text.length > TEXT_CHARS) {
          throw new Error('text is ' + text.length + ' characters (limit ' + TEXT_CHARS
            + ') — send a summary and put the detail in a file instead; nothing was sent');
        }
        const t = resolveTarget(listTargets() || [], args && args.target);
        // A resolved-but-DOWN transport is its own answer. Reporting "sent" into a dead channel, or "no such
        // target" for a chat that plainly exists, are both lies the model would repeat to the Commander.
        if (!t.connected) {
          throw new Error(t.channel + ' is not connected right now, so nothing was sent to ' + t.target
            + ' — reconnect it in the CHANNELS panel and try again');
        }

        const body = redact(text);
        const parts = chunkText(body, maxLenFor(t.channel));
        if (parts.length > MAX_CHUNKS) {
          throw new Error('that message would take ' + parts.length + ' chat messages (limit ' + MAX_CHUNKS
            + ') — send a summary and put the detail in a file instead');
        }

        // Sequential, and it STOPS at the first failure. Firing the rest would leave the chat holding parts
        // 1,3,4 of a four-part message with no way to tell; `sent` below reports exactly what landed.
        let sent = 0, error = null;
        for (const part of parts) {
          let r;
          // Transports never throw — a failure is a resolved { ok:false, error }. Guard anyway: a host that
          // wires a throwing send must not take the whole run down with it.
          try { r = await sendTo(t.target, part); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
          if (r && r.ok === false) { error = String(r.error || 'send failed'); break; }
          sent++;
        }

        /* ---- ATTACHMENTS ------------------------------------------------------------------------------
           THE TEXT GOES FIRST, ALWAYS, and files are attempted after it. It would read prettier to hang a
           short message off the first photo as its caption — but then a channel that cannot upload would have
           swallowed the words along with the file. The floor is delivery: the message lands even when every
           upload fails, and a failed file degrades to a line naming where it is in the workspace, which the
           Commander can still open on the station.

           Each file is reported truthfully in the result: the model must be able to tell "sent with 2 files"
           from "sent, and the files did not go". */
        const wanted = Array.isArray(args && args.files) ? args.files.filter(x => typeof x === 'string' && x.trim()) : [];
        const fileNotes = [], attached = [], unreadable = [];
        if (wanted.length && !error) {
          if (wanted.length > MAX_FILES) {
            fileNotes.push(wanted.length + ' files requested (limit ' + MAX_FILES + ') — only the first ' + MAX_FILES + ' were attempted');
          }
          for (const rel of wanted.slice(0, MAX_FILES)) {
            if (!readFile || !sendMediaTo) { fileNotes.push('"' + rel + '" was not sent — attaching files is not wired on this host'); continue; }
            let got;
            try { got = await readFile(String((ctx && ctx.agentId) || ''), rel); }
            catch (e) { got = { ok: false, error: (e && e.message) || 'read threw' }; }
            if (!got || got.ok === false || !got.buffer || !got.buffer.length) {
              unreadable.push(rel);
              fileNotes.push('"' + rel + '" could not be read from your workspace (' + ((got && got.error) || 'not found') + ') — nothing was attached');
              continue;
            }
            const item = { kind: kindForMime(got.mime, got.name || rel), buffer: got.buffer, filename: String(got.name || rel).split(/[\\/]/).pop(), mime: got.mime || '' };
            let r;
            try { r = await sendMediaTo(t.target, item); } catch (e) { r = { ok: false, error: (e && e.message) || 'upload threw' }; }
            if (r && r.ok) { attached.push(rel); continue; }
            fileNotes.push('"' + rel + '" could not be delivered (' + ((r && r.error) || 'upload failed') + ')');
          }
          // Say so IN THE CHAT, not just in the tool result: the human is the one who wanted the file, and a
          // silent omission would leave them waiting for an attachment that is never coming.
          // Only a file that was READ and then failed to upload is on the station. One that could not be read (missing,
          // empty, or a refused path like "../../channels/secrets.json") was claimed "saved in the workspace" too (2026-10-20).
          const missed = wanted.slice(0, MAX_FILES).filter(f => attached.indexOf(f) === -1 && unreadable.indexOf(f) === -1);
          const lines = [];
          if (missed.length) lines.push((missed.length === 1 ? 'this file' : 'these files') + ' could not be attached here — '
            + missed.map(f => '"' + f + '"').join(', ') + '. ' + (missed.length === 1 ? 'It is' : 'They are') + ' saved in the workspace on the station.');
          if (unreadable.length) lines.push((unreadable.length === 1 ? 'this file' : 'these files') + ' could not be found in the workspace, so nothing was attached — '
            + unreadable.map(f => '"' + f + '"').join(', ') + '.');
          if (lines.length) {
            try { await sendTo(t.target, 'Note: ' + lines.join('\nNote: ')); } catch (_) { /* the note is a courtesy; never fail the send over it */ }
          }
        }

        /* OUTBOUND TELEMETRY on the existing contract event, so the station floor pulses the sending agent's
           dish for an agent-initiated message exactly as it does for a hub reply. Never fabricated: `ok`
           reflects whether every part actually landed, and `chunks` is what landed, not what was attempted.
           runId comes from the dispatch context (index.js threads it onto capCtx) so this delivery is
           attributable to the run that sent it — the first cut hardcoded '' and made every agent-initiated
           send an orphan row. */
        /* Build the payload OUTSIDE the try. The catch is there so a rejected/validator-unhappy event can never
           kill a run that already sent its message — but wrapping the CONSTRUCTION too meant a typo in this
           object (a ReferenceError on an undefined helper, live-caught here) silently dropped the whole event
           with no trace. Only the emit call is allowed to fail quietly. */
        const delivery = {
          channel: t.channel, chatId: t.chatId, runId: String((ctx && ctx.runId) || ''), ok: !error,
          chunks: sent, reason: error ? String(error).slice(0, 200) : '', agentId: t.agentId
        };
        try { emit('channel.delivery', delivery); } catch (_) {}

        if (error) {
          throw new Error('send to ' + t.target + ' failed after ' + sent + ' of ' + parts.length
            + ' part(s): ' + error);
        }
        return {
          content: JSON.stringify({ ok: true, target: t.target, channel: t.channel, parts: sent,
            filesAttached: attached, filesFailed: fileNotes }),
          summary: 'sent to ' + t.target + (parts.length > 1 ? ' in ' + parts.length + ' parts' : '')
            + (attached.length ? ' with ' + attached.length + ' file(s)' : '')
            + (fileNotes.length ? ' — ' + fileNotes.length + ' file(s) NOT attached' : '')
        };
      }
    };

    return {
      targetsTool: targetsTool,
      sendTool: sendTool,
      _resolveTarget: resolveTarget,
      _chunkText: chunkText,
      register(reg) { reg.register(targetsTool); reg.register(sendTool); return reg; }
    };
  }

  // kindForMime + MAX_FILES are shared with routine-media.js: a routine's delivery attaches files exactly like this tool.
  return { makeCommsTools, DEFAULT_MAX_LEN, MAX_CHUNKS, TEXT_CHARS, MAX_FILES, kindForMime };
});
