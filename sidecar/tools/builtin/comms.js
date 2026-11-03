/* sidecar/tools/builtin/comms.js — OUTBOUND channel reach: the agent can message a connected platform.

   THE GAP THIS CLOSES. StarNet drives five real messaging channels (telegram/discord/slack/matrix/signal) but
   every one of them was INBOUND-only: a human messages the station, the hub runs a turn, the reply goes back
   down the same chat. Nothing let an agent SPEAK FIRST. The only outbound path in the whole sidecar was
   autonotify.js — a fixed one-line "a routine ran on its own" ping, composed by the host, not by the agent. So
   "reach" was half a pillar: a routine could research all night and had no way to tell anyone, and an agent
   asked to "let me know on Telegram when the build goes green" could only answer into a chat window nobody was
   watching. The reference harness has had tools/send_message_tool.py + gateway/channel_directory.py from early
   on; this is the same capability on StarNet's own seams.

     makeCommsTools({ listTargets, sendTo, readFile?, sendMediaTo?, redact? }) -> { targetsTool, sendTool, register }
       sendTo(target, text, { maxParts, reason, runId, agentId }) -> { ok, error?, parts, sent, refused? }
       sendMediaTo(target, item, { reason, runId, agentId }) -> { ok, error? }
     The HOST sends (index.js: channels/outbound.js, the one outbound contract): it scrubs the whole body, chunks it at
     the channel's own limit with the one chunker, refuses a body that would take more than maxParts messages before
     any part goes, carries the chat's topic, and reports the one channel.delivery. This tool decides what may be sent
     and where, and tells the model exactly what landed.

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

  const TEXT_CHARS = 8000;        // the most an agent may hand one send call (the host chunks it under the platform floor)
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

  /* refusedFileLine(name, reason) -> the chat line (without "Note: ") for a file the send rules refused (the reader's
     answer carries `rule`): shared with routine-media.js, so a channel.send and a routine delivery say it the same way.
     `reason` is the host reader's own refusal (sidecar/egress-files.js read: it quotes the chat-safe name, never a host
     path); it is the only thing the station knows about such a file, so nothing is said about where the file is or
     whether it exists.
     unsentFileLine(name, reason) -> the same line for a file the reader could not read or prove WITHOUT a send rule
     saying no (EBUSY/EACCES, a change mid-read, no path object: no `rule` on the answer). No rule is claimed (0.14.2
     review: "report.xlsx" cannot be read (EBUSY) was told the send rules refused it); the reader's reason is all. */
  function fileReasonText(name, reason) {
    const nm = '"' + String(name || 'file') + '"';
    const why = String(reason == null ? '' : reason).trim().slice(0, 300).replace(/[\s.;,:]+$/, '');
    return (!why ? nm : why.indexOf(nm) >= 0 ? why : nm + ': ' + why) + '.';
  }
  function refusedFileLine(name, reason) {
    return 'this file was refused by the station\'s send rules and was not attached — ' + fileReasonText(name, reason);
  }
  function unsentFileLine(name, reason) {
    return 'this file was not attached — ' + fileReasonText(name, reason);
  }

  function clean(s, n) {
    s = String(s == null ? '' : s).trim();
    return n && s.length > n ? s.slice(0, n) : s;
  }

  /* missedNote(missed, shown) -> the chat's note about the files that did not come ('' when none). THE ONE WORDING of it,
     for every path that attaches files to a chat message (this tool, and a routine's delivery through routine-media.js), so
     the two cannot disagree again (c0beb187: both were told "saved", and the routine's copy of the sentence kept saying so
     after this tool's was fixed). Each entry is a path, or { path, … } saying what the station knows of the file:
       - a plain path, or an entry with no flag: the station READ the file and could not deliver it (the upload failed, the
         chat cannot carry files, or it was over the cap), so it is still in the workspace on the station;
       - refused + rule: the send rules would not let it leave (a hard link, a name outside the run's folders, a protected or
         empty file): named with the reason the reader gave (refusedFileLine), never "saved in the workspace" nor "could not
         be found" (0.14.2 review: a refused name may not be in the workspace at all, and a hard link or a protected file IS);
       - refused without rule: the reader could not read or prove it (EBUSY, a change mid-read): named with that reason and
         no rule claimed (unsentFileLine);
       - notFound: nothing by that name, so nothing was attached; unread: it was never read (no wiring, or the read threw),
         so nothing is claimed about where it is, and its `error` (a raw exception, for the console) never reaches the chat.
     { failed, unreadable } (two lists) is read too: `failed` as given, and an `unreadable` entry that says no more of itself
     as unread — it is never said to be on the station. shown(path) -> the name the chat may see (an entry's own chat-safe
     `shown` wins); an absolute host path is never quoted, only its file name (run-paths review S3). */
  function missedNote(missed, shown) {
    const asEntry = e => (typeof e === 'string' ? { path: e } : e);
    const known = e => !!e && (e.refused === true || e.notFound === true || e.unread === true);
    const entries = Array.isArray(missed) ? missed
      : (missed && typeof missed === 'object')
        ? (Array.isArray(missed.failed) ? missed.failed : []).concat((Array.isArray(missed.unreadable) ? missed.unreadable : [])
          .map(asEntry).map(e => (known(e) ? e : Object.assign({}, e, { unread: true }))))
        : [];
    const list = entries.map(asEntry).filter(e => e && typeof e.path === 'string' && e.path);
    if (!list.length) return '';
    const abs = s => /^(?:[A-Za-z]:|[\\/])/.test(String(s));
    const name = e => {
      if (typeof e.shown === 'string' && e.shown && !abs(e.shown)) return e.shown;
      const s = typeof shown === 'function' ? String(shown(e.path) || '') : '';
      if (s && !abs(s)) return s;
      return abs(e.path) ? (String(e.path).split(/[\\/]/).filter(Boolean).pop() || 'file') : String(e.path);
    };
    const named = arr => arr.map(e => '"' + name(e) + '"').join(', ');
    const these = arr => (arr.length === 1 ? 'this file' : 'these files');
    const refused = list.filter(e => e.refused === true);
    const gone = list.filter(e => e.refused !== true && e.notFound === true);
    const unread = list.filter(e => e.refused !== true && e.notFound !== true && e.unread === true);
    const kept = list.filter(e => e.refused !== true && e.notFound !== true && e.unread !== true);
    const lines = [];
    if (kept.length) lines.push(these(kept) + ' could not be attached here — ' + named(kept) + '. ' + (kept.length === 1 ? 'It is' : 'They are') + ' saved in the workspace on the station.');
    if (unread.length) lines.push(these(unread) + ' could not be attached here — ' + named(unread) + '.');
    if (gone.length) lines.push(these(gone) + ' could not be found in the workspace, so nothing was attached — ' + named(gone) + '.');
    for (const e of refused) lines.push((e.rule === true ? refusedFileLine : unsentFileLine)(name(e), e.reason != null ? e.reason : e.error));
    return 'Note: ' + lines.join('\nNote: ');
  }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

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
    // The SAME scrub autonotify applies before a host-composed ping goes out. A tool result or a read file can
    // carry a key-shaped string, and this is the one tool that would hand it to a third party.
    const redact = typeof deps.redact === 'function' ? deps.redact : function (t) { return t; };
    // OUTBOUND FILES (2026-07-29). Both injected: readFile(agentId, path, ctx) reads a file only from inside the RUN's own
    // private workspace or approved project root (ctx.paths), the .env/.git/credential floor always, never with a path
    // card (the host owns that proof, sidecar/egress-files.js); sendMediaTo uploads through the channel's transport. Absent either one,
    // `files` is refused with a reason rather than silently ignored — an agent told "sent" about a file that
    // never moved is the exact lie this file exists to prevent.
    const readFile = typeof deps.readFile === 'function' ? deps.readFile : null;
    const sendMediaTo = typeof deps.sendMediaTo === 'function' ? deps.sendMediaTo : null;

    const targetsTool = {
      /* impact external-unknown, DECLARED, and deliberately the lane it always fell into, beside channel.send's. It lists
         every chat a human opened with this station: its chat id, its channel and the agent it is bound to. As impact
         none it was offered, with no grant, to every run holding the DISH (the default headless office that unattended
         and chat runs compose holds one), on any surface and tainted or not, so a chat run that is not the owner's DM
         could list the Commander's chats. In this lane a watched run asks an exact per-call confirmation, an unattended
         ASK run is not offered it (nor channel.send, so it has nothing to look up), a tainted run loses it, and an
         owner DM or Full Access keeps it. Declaring it none (quick win 8) was reverted in review and waits for Andrew's
         security sign-off. briefExempt keeps it a read the model may make before the Task Brief settles, as in 0.14.1
         (taskbrief-policy canMutate holds a scope-read tool only when it DECLARES external-unknown, the rule for MCP
         reads; undeclared, it passed). */
      name: 'channel.targets', capability: 'comms', impact: 'external-unknown', scope: 'read', requiresConsent: false,
      briefExempt: true,
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
         tainted run loses it; Full Access keeps it. Declared, it is also refused on a dispatch that carries no run
         authority at all (registry.js reads a declared external-unknown; every run context carries one, index.js dctx).
         external-credentialed (web_request's class) was tried in quick win 8
         and rejected in review: it made one "Always" a station-wide comms:execute grant, offered it to delegated workers
         under a watched lead, and offered it to unattended runs whose exec lockout refuses every call. Moving it to a
         class that stores grants waits for Andrew's security sign-off. */
      name: 'channel.send', capability: 'comms', impact: 'external-unknown', scope: 'execute', requiresConsent: true, timeoutMs: 30000,
      description: 'Send a message from this station to a connected messaging chat (Telegram, Discord, Slack, Matrix, Signal), optionally with files attached. Use it when the Commander asks to be told, pinged, notified or messaged somewhere, or to report a result outside the station, including sending them an image, chart or document you produced. The target must be a chat channel.targets lists; an agent cannot message a new id.',
      schema: {
        type: 'object',
        required: ['target', 'text'],
        properties: {
          target: { type: 'string', description: 'A target token from channel.targets (a channel name or chat id also works when it matches exactly one).' },
          text: { type: 'string', maxLength: TEXT_CHARS, description: 'Plain-text body; split into platform-sized parts automatically.' },
          files: {
            type: 'array', maxItems: MAX_FILES,
            items: { type: 'string' },
            description: 'Files (fs_read paths) to attach (images inline, the rest as documents), up to ' + MAX_FILES + '. A channel that cannot carry files still gets the message, naming the path.'
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

        // ONE send for the whole body: the host chunks it under the platform's own limit and refuses, before the first
        // part, a body that would take more than MAX_CHUNKS messages. It goes part by part and STOPS at the first
        // failure: firing the rest would leave the chat holding parts 1,3,4 of a four-part message with no way to tell;
        // `sent` reports exactly what landed. OUTBOUND TELEMETRY is the host's: it reports each send's one
        // channel.delivery on the existing contract event (ok: every part landed; chunks: what landed), so the floor
        // pulses the sending agent's dish as it does for a hub reply. runId and the chat's agent ride along so that
        // delivery is attributable to the run that sent it and pulses the RIGHT agent's dish.
        const body = redact(text);
        const meta = { runId: String((ctx && ctx.runId) || ''), agentId: t.agentId };
        let out;
        // Transports never throw — a failure is a resolved { ok:false, error }. Guard anyway: a host that wires a
        // throwing send must not take the whole run down with it.
        try { out = await sendTo(t.target, body, Object.assign({ maxParts: MAX_CHUNKS, reason: 'tool' }, meta)); }
        catch (e) { out = { ok: false, error: (e && e.message) || 'send threw' }; }
        out = out || { ok: false, error: 'send failed' };
        if (out.refused === 'too-many-parts') {
          throw new Error('that message would take ' + out.parts + ' chat messages (limit ' + MAX_CHUNKS
            + ') — send a summary and put the detail in a file instead');
        }
        const parts = Math.max(1, Number(out.parts) || 1);
        const error = out.ok === false ? String(out.error || 'send failed') : null;
        const sent = error ? Math.max(0, Math.floor(Number(out.sent) || 0)) : (out.sent != null ? Math.max(0, Math.floor(Number(out.sent) || 0)) : parts);

        /* ---- ATTACHMENTS ------------------------------------------------------------------------------
           THE TEXT GOES FIRST, ALWAYS, and files are attempted after it. It would read prettier to hang a
           short message off the first photo as its caption — but then a channel that cannot upload would have
           swallowed the words along with the file. The floor is delivery: the message lands even when every
           upload fails, and a failed file degrades to a line naming where it is in the workspace, which the
           Commander can still open on the station.

           Each file is reported truthfully in the result: the model must be able to tell "sent with 2 files"
           from "sent, and the files did not go". */
        const wanted = Array.isArray(args && args.files) ? args.files.filter(x => typeof x === 'string' && x.trim()) : [];
        // what the station knows of each file that did not go: notFound (the reader found nothing by that name), refused
        // (the reader said no, with its reason: `rule` when a send rule did, else it could not read or prove the file),
        // unread (never read: not wired, or the read itself threw)
        const fileNotes = [], attached = [], notFound = [], refused = [], unread = [];
        if (wanted.length && !error) {
          if (wanted.length > MAX_FILES) {
            fileNotes.push(wanted.length + ' files requested (limit ' + MAX_FILES + ') — only the first ' + MAX_FILES + ' were attempted');
          }
          // the name the CHAT is told: the host's shown form (a jail-relative name, never an absolute host path), else
          // the file name of an absolute path (run-paths review S3: a refused absolute receipt was quoted into the chat)
          const shown = {};
          for (const rel of wanted.slice(0, MAX_FILES)) {
            if (!readFile || !sendMediaTo) { unread.push(rel); fileNotes.push('"' + rel + '" was not sent — attaching files is not wired on this host'); continue; }
            let got, threw = false;
            // ctx rides along: the host resolves the name through THIS run's path object (ctx.paths), as fs.read would
            try { got = await readFile(String((ctx && ctx.agentId) || ''), rel, ctx); }
            catch (e) { threw = true; got = { ok: false, error: (e && e.message) || 'read threw' }; }
            if (got && typeof got.shown === 'string' && got.shown) shown[rel] = got.shown;
            if (!got || got.ok === false || !got.buffer || !got.buffer.length) {
              // the host reader's contract (sidecar/egress-files.js read): ok:false + notFound is "nothing by that name";
              // ok:false without it carries the chat-safe reason, and `rule` when a send rule refused the file (a protected,
              // linked, outside or empty file) rather than the read failing (EBUSY, a change mid-read)
              if (got && got.ok === false && !threw) {
                if (got.notFound === true) notFound.push(rel);
                else refused.push({ rel, reason: String(got.error || ''), rule: got.rule === true });
              } else unread.push(rel);
              fileNotes.push('"' + rel + '" could not be read from your workspace (' + ((got && got.error) || 'not found') + ') — nothing was attached');
              continue;
            }
            const item = { kind: kindForMime(got.mime, got.name || rel), buffer: got.buffer, filename: String(got.name || rel).split(/[\\/]/).pop(), mime: got.mime || '' };
            let r;
            try { r = await sendMediaTo(t.target, item, Object.assign({ reason: 'tool' }, meta)); } catch (e) { r = { ok: false, error: (e && e.message) || 'upload threw' }; }
            if (r && r.ok) { attached.push(rel); continue; }
            fileNotes.push('"' + rel + '" could not be delivered (' + ((r && r.error) || 'upload failed') + ')');
          }
          // Say so IN THE CHAT, not just in the tool result: the human is the one who wanted the file, and a
          // silent omission would leave them waiting for an attachment that is never coming.
          // Only a file that was READ and then failed to upload is on the station. One that could not be read (missing,
          // empty, or a refused path like "../../channels/secrets.json") was claimed "saved in the workspace" too (2026-10-20),
          // and the fix then told every refused one it "could not be found in the workspace" (0.14.2 review: a hard link or
          // a protected file IS there; the station only knows the send rules refused it, and why).
          // The sentence is missedNote's, the one a routine's delivery says too.
          const notRead = f => notFound.indexOf(f) >= 0 || unread.indexOf(f) >= 0 || refused.some(r => r.rel === f);
          const missed = wanted.slice(0, MAX_FILES).filter(f => attached.indexOf(f) === -1 && !notRead(f));
          const note = missedNote(missed.concat(unread.map(f => ({ path: f, unread: true })), notFound.map(f => ({ path: f, notFound: true })),
            refused.map(r => Object.assign({ path: r.rel, refused: true }, r))), f => shown[f]);   // each refusal as the reader gave it: its reason and rule
          if (note) {
            try { await sendTo(t.target, note, Object.assign({ reason: 'note' }, meta)); } catch (_) { /* the note is a courtesy; never fail the send over it */ }
          }
        }

        if (error) {
          throw new Error('send to ' + t.target + ' failed after ' + sent + ' of ' + parts
            + ' part(s): ' + error);
        }
        return {
          content: JSON.stringify({ ok: true, target: t.target, channel: t.channel, parts: sent,
            filesAttached: attached, filesFailed: fileNotes }),
          summary: 'sent to ' + t.target + (parts > 1 ? ' in ' + parts + ' parts' : '')
            + (attached.length ? ' with ' + attached.length + ' file(s)' : '')
            + (fileNotes.length ? ' — ' + fileNotes.length + ' file(s) NOT attached' : '')
        };
      }
    };

    return {
      targetsTool: targetsTool,
      sendTool: sendTool,
      _resolveTarget: resolveTarget,
      register(reg) { reg.register(targetsTool); reg.register(sendTool); return reg; }
    };
  }

  // kindForMime, MAX_FILES, missedNote, refusedFileLine and unsentFileLine are shared with routine-media.js: a routine's delivery
  // attaches files exactly like this tool, and says the same about the ones that did not come.
  return { makeCommsTools, MAX_CHUNKS, TEXT_CHARS, MAX_FILES, kindForMime, missedNote, refusedFileLine, unsentFileLine };
});
