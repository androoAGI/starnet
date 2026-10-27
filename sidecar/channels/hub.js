/* sidecar/channels/hub.js — the messaging BRIDGE (C5): inbound message -> the run host -> streamed reply back.

   This is the analogue of the reference harness's injected `_message_handler`: the ONE seam where a normalized InboundMessage
   drives the EXISTING run host (runOnce, extracted from handleRun) and the agent's reply is delivered back to
   the platform. The hub knows nothing of the loop/provider/broker internals — it is handed `runOnce`, the
   durable `store`, a `send`, the current `secrets` (OR key+model), and a `classify` (task-vs-talk), all injected.

     makeChannelHub({ channel, runOnce, store, send, secrets, persona, classify, ownerTrusted?, redact, emit, newId,
                      maxMessageLength?, agentPrefix? }) -> { onInbound, onCallback, onStatus }

   Per inbound it: (1) maps chatId -> a per-chat agentId (`tg_<chatId>`, isolated notebook/workspace/history);
   (2) loads the durable transcript, appends the user turn; (3) runs `runOnce` with surface:'autonomous' (a
   headless chat has no browser to answer a permission.prompt, so an ungranted mutation default-denies and the
   run continues — never stalls) UNLESS this chat opted into approve/deny buttons via `/approvals on`, in which
   case it runs 'interactive' and an ungranted mutation asks on the channel and fail-closes on silence (C6);
   (4) assembles the reply by concatenating agent.token deltas (the SAME contract
   harness.js uses in the browser — there is no agent.message event); (5) delivers it chunked to the platform's
   message-length limit; (6) emits channel.inbound / channel.delivery telemetry. One run per chat: a new message
   ABORTS the in-flight run for that chat and serves the latest (natural chat behavior). The existing per-run
   caps (maxIters/maxCostUsd/maxToolBytes) still bind — a messaging run is just another caller of runOnce.

   Pure + deterministic: every dependency is injected (no fetch/fs/clock/rng here); ids come from `newId`. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.hub = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote, swallow } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); }, swallow: function (tag) { return function (e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); }; } };

  const TASK_SUFFIX = ' The Commander has just messaged you a task — carry it out as best you can and report the result clearly.';
  /* dockSystem(persona, brief, isTask) — the system context an ENTRY dock runs under: its persona, the dock's
     standing brief (step editor — the SAME section header the chain handoff turn uses), and the task suffix.
     Pure + exported so the conveyor step-through test composes the identical entry run (2026-09-22). */
  function dockSystem(persona, brief, isTask) {
    return persona
      + (brief ? '\n\nYOUR STANDING BRIEF FOR THIS STATION:\n' + String(brief).slice(0, 2000) : '')
      + (isTask ? TASK_SUFFIX : '');
  }
  const DEFAULT_PERSONA = 'You are the Commander\'s AI agent, reachable over a messaging app. Address the user as "Commander", '
    + 'keep a spark of personality, and keep replies concise and chat-friendly. When given a task you have REAL tools '
    + '(web search/read, files, memory) — use them and report what you actually found.';

  // why a stopped run ended, as a short human note appended to the reply (mirrors chat.js endReason handling).
  // A 'budget' stop names WHICH spend cap fired (scope/cap ride the additive agent.run.end fields; absent on an
  // old payload → the generic money line) so a channel user isn't sent hunting through runtime settings.
  function budgetNote(scope, capUsd, atBalance, projected) {
    const cap = (typeof capUsd === 'number' && isFinite(capUsd) && capUsd >= 0.01) ? '$' + capUsd.toFixed(2).replace(/\.00$/, '') + ' ' : '';   // sub-cent caps would read "$0.00"
    // projected (agent.run.end budgetProjected): the run family's calls still in flight already took what was left, so
    // the run stopped BEFORE the cap — never say it hit one it did not reach (mirrors chat.js budgetStopLine)
    if (scope === 'run' && projected === true) {
      if (atBalance === true) return '\n\n(' + (cap ? 'stopped before it would spend more than the ' + cap + 'left on your StarNet balance' : 'stopped before it would spend more than what is left on your StarNet balance') + ' — add credits in the app under SETTINGS → AI & MODELS.)';
      return '\n\n(stopped before it would pass the ' + cap + 'per-run spend cap — raise it in the app under SETTINGS › SPENDING LIMITS.)';
    }
    const what = scope === 'run' ? 'hit the ' + cap + 'per-run spend cap'
      : scope === 'agent' ? 'this agent hit its ' + cap + 'lifetime spend cap'
      : scope === 'day' ? 'hit the ' + cap + 'daily spend cap'
      : scope === 'global' ? 'hit the ' + cap + 'all-time spend cap'
      : 'hit a spend cap';
    // a StarNet run whose ceiling admission clamped to the balance (agent.run.end budgetCapIsBalance) spent the wallet:
    // the door is the top-up, not a cap to raise (mirrors chat.js budgetStopLine)
    if (scope === 'run' && atBalance === true) return '\n\n(' + (cap ? 'used the ' + cap + 'left on your StarNet balance' : 'used what was left on your StarNet balance') + ' — add credits in the app under SETTINGS → AI & MODELS.)';
    // the caps live in SETTINGS › SPENDING LIMITS (MISSION CONTROL is only a room label). A per-RUN stop says
    // "raise", never "remove" — on StarNet credits PER RUN 0 still stops at the managed default (mirrors chat.js).
    return '\n\n(' + what + (scope === 'run' ? ' — raise it' : ' — raise or remove it') + ' in the app under SETTINGS › SPENDING LIMITS.)';
  }
  // a follow-up that is itself a stop request never steers the running task — from the owner it IS /stop (onInbound);
  // anything else (a group, a forward) still stops it through the supersede path
  const STOP_WORDS_RE = /^\s*(?:stop|cancel|abort|halt|never\s*mind|nvm|forget\s+(?:it|that)|scratch\s+that)\s*[.!]*\s*$/i;
  // plain-English stop sentences shared with routines/loops (sidecar/stop-reason.js); the inline fallback only serves a
  // non-node embed, which never runs the hub against a real host.
  const StopReason = (typeof require === 'function') ? require('../stop-reason.js') : { stopSentence: (r) => (r ? 'it stopped before finishing (' + r + ')' : '') };
  /* WHY THE RUN STOPPED, in words (2026-10-11 — "they start a task and then stop repeatedly with no explanation"). A raw
     "(stopped: empty)" read as a silent stop, a provider-cut reply had no note at all (finishReason was ignored), a
     station-side cancel said nothing, and the unpriced-model TOKEN ceiling told the user to raise a $ cap that never
     governed it. Every non-clean end now names what happened and the next step. */
  function endNote(reason, state) {
    const st = state || {};
    if (reason === 'max_iters') return '\n\n(reached the step limit — message "continue" to keep going.)';
    if (reason === 'budget') {
      if (st.unpricedModel || st.subscriptionModel) return '\n\n(' + StopReason.stopSentence('budget', st) + '.)';
      return budgetNote(st.budgetScope, st.budgetCapUsd, !!st.budgetCapIsBalance, st.budgetProjected === true);
    }
    // a /stop, a newer message or an E-STOP never reaches here (abandoned() owns those); what is left is a STOP by run
    // id from the station (the desk screen / HUD STOP → POST /api/cancel), so say so instead of going quiet.
    if (reason === 'cancelled') return '\n\n(stopped from the StarNet app before it finished — nothing more will run for this message.)';
    if (reason === 'clarifying') return '';   // a Task Brief question IS the reply — never a "(stopped: …)" note
    if (reason === 'refusal') return '';
    if (reason === 'done') {
      const cut = StopReason.stopSentence('done', st);   // a provider-truncated/filtered reply is not a clean delivery
      return cut ? '\n\n(' + cut + '.)' : '';
    }
    return '\n\n(' + StopReason.stopSentence(reason, st) + '.)';
  }

  // HISTORICAL COMPAT (concurrent-sessions lane, 2026-07-18): the host's admission-time same-agent mutex
  // ("already running a task…") is RETIRED — a current sidecar ADMITS the replacement run even while the aborted
  // one unwinds, so this retry class simply never fires against it. The classifier + bounded retry are KEPT as
  // defense in depth for a version-skewed host (an older sidecar behind a newer bridge) where the supersede race
  // can still surface that transient refusal. Matched on transient + the distinctive phrase so a different
  // transient never gets silently looped. Kept as a narrow regex, not a substring, to avoid false hits.
  const SUPERSEDE_REFUSAL_RE = /already running a task/i;
  function isSupersedeRaceRefusal(transient, message) {
    return !!transient && SUPERSEDE_REFUSAL_RE.test(String(message == null ? '' : message));
  }

  /* Re-open a fenced code block that a chunk boundary cut in half.

     A reply longer than the platform's limit is split into messages, and a ``` block straddling the cut left
     chunk 2 with an UNPAIRED opening fence: the formatter (which only converts what it can prove is balanced
     within its own string) correctly declines to make it code, so the second half of a script or a log lands as
     raw prose with a stray ``` in it. Close the block at the end of the chunk that opened it and re-open at the
     top of the next, so both halves render as code and neither carries a dangling marker.

     Counting is by LINES beginning with ```, which is what a fence actually is — a ``` inside a line of prose
     ("use ```js to fence it") is not a block delimiter and must not flip the state. The reserve below is why
     the split is given less room: the two markers we add have to fit under the same limit. */
  const FENCE_RESERVE = 8;   // '\n```' opening + '```\n' closing, with slack
  function reopenFences(chunks) {
    let open = false;
    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      let c = chunks[i];
      if (open) c = '```\n' + c;                          // continue the block this chunk starts inside
      const fences = (c.match(/^[ \t]{0,3}```/gm) || []).length;
      if (fences % 2 === 1) { c = c.replace(/\s*$/, '') + '\n```'; open = true; }
      else open = false;
      out.push(c);
    }
    return out;
  }

  /* split text into <=max-length pieces, preferring to break at the last newline/space so words/lines stay
     whole. chunkTextParts returns BOTH views, aligned 1:1: `send` carries the fence-doctored chunks the wire
     wants (reopenFences injects synthetic ``` markers), `raw` the undecorated splits of the original text.
     Anyone persisting an undelivered REMAINDER must rebuild it from `raw` — joining decorated chunks bakes
     the synthetic fences into the stored text, and the next pass re-fences them (stray ``` lines per retry). */
  function chunkTextParts(text, max) {
    const s = String(text == null ? '' : text);
    // A non-positive `max` makes `end === i` below, so the loop pushes '' forever without advancing. No
    // caller passes one today (adapters default to 4096), but an unbounded loop is not a thing to leave
    // one bad config away.
    max = (typeof max === 'number' && isFinite(max) && max > 0) ? Math.floor(max) : 4096;
    if (s.length <= max) { const one = s.length ? [s] : []; return { raw: one, send: one }; }
    // Leave room for the fence markers reopenFences may add, but ONLY when there is a fence to worry about —
    // an ordinary long reply keeps the exact old boundaries.
    const fenced = /^[ \t]{0,3}```/m.test(s);
    const room = fenced ? Math.max(1, max - FENCE_RESERVE) : max;
    const out = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(i + room, s.length);
      if (end < s.length) {
        const slice = s.slice(i, end);
        const nl = slice.lastIndexOf('\n');
        const sp = slice.lastIndexOf(' ');
        const cut = nl > room * 0.5 ? nl : (sp > room * 0.5 ? sp : -1);
        if (cut > 0) end = i + cut + 1;
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return { raw: out, send: fenced ? reopenFences(out) : out };
  }
  function chunkText(text, max) { return chunkTextParts(text, max).send; }

  /* Render an inbound message's `replyTo` as the preamble that goes ABOVE the member's own words in the turn.

     WHY THIS EXISTS: long-press a message, hit Reply, ask "what is this?" is the most natural gesture on the
     platform, and until now the model received exactly three words with the referent missing — so it either
     guessed or asked the member to repeat themselves. The quoted text goes here; the quoted message's MEDIA is
     ingested separately by the caller (that is the "reply to a photo" half).

     THE FENCE IS DELIBERATE and it is NOT a refusal. The quote is text the member is POINTING AT, which may be
     another person's words or the bot's own earlier reply — so the preamble names who wrote it and says plainly
     which part is the live request. It must not tell the model to ignore instructions inside the quote: a member
     replying to their own "write the summary" with "do it now" means exactly that, and refusing would be its own
     bug. Attribute, don't forbid.

     Bounded on purpose: a reply to a 4000-character message must not push the member's actual sentence out of
     the model's attention (or the turn out of the context window). Pure — no clock, no I/O. */
  const REPLY_QUOTE_MAX = 500;
  function replyPreamble(replyTo) {
    if (!replyTo || typeof replyTo !== 'object') return '';
    let quoted = String(replyTo.text == null ? '' : replyTo.text).replace(/\s+$/, '');
    const nMedia = Array.isArray(replyTo.media) ? replyTo.media.length : 0;
    if (!quoted && !nMedia) return '';
    if (quoted.length > REPLY_QUOTE_MAX) quoted = quoted.slice(0, REPLY_QUOTE_MAX).replace(/\s+\S*$/, '') + ' […quoted message truncated]';
    const who = String(replyTo.userName == null ? '' : replyTo.userName).trim();
    const bot = !!replyTo.fromBot;
    const label = who ? (who + (bot ? ' (a bot)' : '')) : (bot ? 'a bot' : 'someone');
    const out = ['[The message below is a REPLY to an earlier message from ' + label
      + '. That earlier message is quoted between the markers — it is what the user is pointing at, and their'
      + ' actual request is the text AFTER the end marker.]',
      '--- quoted message ---'];
    if (quoted) out.push(quoted);
    if (nMedia) out.push('(' + nMedia + ' file(s) attached to that quoted message are included with this turn)');
    out.push('--- end quoted message ---');
    return out.join('\n');
  }

  // Map a TYPED reply onto a live choice keyboard: "2" / "2." / "2)" pick by position, and an exact
  // (case-insensitive) option text picks itself. Everything else returns null and passes straight through as a
  // new instruction — a Commander who changes their mind mid-question must never have that silently re-read as
  // an answer to it. Typing and tapping therefore produce the IDENTICAL canonical option text downstream.
  function coerceChoice(options, raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const list = Array.isArray(options) ? options : [];
    const n = /^([1-9][0-9]?)[.)]?$/.exec(s);
    if (n) { const o = list[Number(n[1]) - 1]; return o ? o.value : null; }
    const low = s.toLowerCase();
    for (const o of list) if (String(o.value).toLowerCase() === low) return o.value;
    return null;
  }

  // ---- in-messenger control commands (pure, channel-agnostic) --------------------------------------------
  // Parse a leading slash-command out of an inbound text. Returns { cmd, arg } (cmd lowercased, no slash) or
  // null when the text is NOT a command (a normal message that should start a run). Only the FIRST token is the
  // command; the remainder (trimmed) is the argument. A bare '/' or unknown token still parses so we can reply
  // with help rather than silently spending a run. Telegram-style '/cmd@botname' is tolerated (strip the @suffix).
  // ONE command table — the single source of truth for (a) what parseCommand accepts, (b) what /help prints, and
  // (c) what setMyCommands publishes into Telegram's blue "/" menu. They drifted apart the moment they were three
  // separate lists, so they are now derived from this one array: adding a command here lights it up everywhere.
  // `menu:false` keeps a command working but off the published menu (help is redundant next to Telegram's menu).
  // Names must satisfy Telegram's command grammar (lowercase a-z0-9_, 1-32) — asserted by the unit test.
  // `slash:true` marks a command the SIDECAR executes through the shared slash registry (sidecar/slash.js →
  // slash-actions.js) — the same code path the desktop palette uses, so the answer here is byte-identical to the
  // answer there instead of a second implementation that drifts. Everything else is control-plane work only this
  // hub can do (it owns the in-flight run and the transcript file).
  //
  // `owner` — WHO may run it (2026-09-25, sec-owner-gates). Anyone admitted to the chat (a whitelisted group's
  // members, an allowed non-owner) can TALK to the agent, but only the bound owner may change the station:
  //   'always' — owner-only in every form (state-changing, or reveals the owner's private spend/schedules)
  //   'write'  — the bare form is a read-only readout anyone may see; any argument (a change) is owner-only
  //   absent   — read-only, open to every admitted sender (status, agents, whoami, tools, help, start)
  // Commander-defined commands (userCommandNames) are owner-only too — they run the owner's own aliases.
  const COMMANDS = [
    // `aliases` — the desktop registry's other spellings of the SAME command (sidecar/slash.js; pinned by
    // test/channels.desktop-commands.test.js). Parsed to the canonical name, so the owner gate below reads one rule.
    { command: 'status', description: 'What this chat is doing right now' },
    { command: 'stop', description: 'Stop the run in progress', owner: 'always' },
    { command: 'new', description: 'Forget this chat\'s history and start fresh', owner: 'always', aliases: ['reset'] },
    { command: 'agents', description: 'List agents (→ marks the one you are talking to)', aliases: ['tasks'] },
    { command: 'talk', description: 'Switch this chat to another agent', usage: '/talk <name>', owner: 'always' },
    { command: 'model', description: 'Show or change the current agent\'s model', usage: '/model [id]', owner: 'write' },
    { command: 'usage', description: 'Real spend from the station ledger', slash: true, owner: 'always' },
    { command: 'tools', description: 'The tools this agent can actually call', slash: true },
    { command: 'routine', description: 'List, create or pause scheduled routines', usage: '/routine [list|add <schedule> | <task>|pause N|rm N]', slash: true, owner: 'always', aliases: ['routines'] },
    { command: 'away', description: 'Queue work to build on the away shift', usage: '/away [<what to build>|list|on|off]', slash: true, owner: 'always', aliases: ['build-away', 'buildaway'] },
    { command: 'approvals', description: 'Approve/deny buttons for this chat (on or off)', usage: '/approvals [on|off]', owner: 'write' },
    { command: 'mention', description: 'In a group: when I answer, and whether I follow the rest', usage: '/mention [on|observe|off]', owner: 'write' },
    // A group is closed until the paired owner sends /allow IN it (2026-10-19). The adapter lets exactly these two
    // through from a group it does not answer in yet, so the owner can open it from the inside.
    { command: 'allow', description: 'In a group: let me answer here', owner: 'always' },
    { command: 'deny', description: 'In a group: stop me answering here', owner: 'always' },
    { command: 'whoami', description: 'Show which agent this chat is talking to' },
    { command: 'help', description: 'List these commands', menu: false },
    // Telegram sends this when a fresh chat's START button is pressed. menu:false — the client offers it on an
    // empty chat by itself, and it would be noise in the "/" list for everyone else.
    { command: 'start', description: 'What this bot is and how to talk to it', menu: false }
  ];
  const SLASH_CMDS = COMMANDS.reduce((m, c) => { if (c.slash) m[c.command] = 1; return m; }, {});
  const KNOWN_CMDS = COMMANDS.reduce((m, c) => { m[c.command] = 1; return m; }, {});
  const ALIAS_CMDS = COMMANDS.reduce((m, c) => { for (const a of (c.aliases || [])) m[a] = c.command; return m; }, {});
  const OWNER_CMDS = COMMANDS.reduce((m, c) => { if (c.owner) m[c.command] = c.owner; return m; }, {});
  // Does this parsed command need the bound owner? Pure, exported for the policy test.
  function commandNeedsOwner(parsed) {
    if (!parsed) return false;
    const rule = OWNER_CMDS[parsed.cmd];
    if (rule === 'always') return true;
    if (rule === 'write') return !!String(parsed.arg || '').trim();
    return false;
  }
  // the setMyCommands payload (name + one-line description only — Telegram renders no usage strings).
  function menuCommands() {
    return COMMANDS.filter(c => c.menu !== false).map(c => ({ command: c.command, description: c.description }));
  }
  // the /help body, rendered from the SAME table so it can never claim a command the parser doesn't accept.
  function helpText() {
    return 'Commands:\n' + COMMANDS.map(c => (c.usage || '/' + c.command) + ' — ' + c.description).join('\n');
  }
  /* A STEERING NOTE IS NOT PROSE (bug e903a199, 2026-10-23). The loop echoes a folded note as one token delta,
     '\n[steering] <note>\n' (loop.js foldSteerNotes, and the NOT-applied notice at the run's end). COMMS draws that line
     as its own steer row; buffered raw here it reached the phone as an internal marker glued between the answer before
     the note and the answer after it. joinReplyDelta keeps both answers and every word of the note, but writes the
     note as a readable line of its own ('↪ <note>', the same arrow the steer acknowledgement uses), with one blank line
     on either side — the model's own paragraph break after it is folded in rather than stacked.
     ONE LINE: this hub posts its notes flattened (steerNoteWire, the rule COMMS's steerWire keeps), but a note posted by
     any other client may still carry a line break — the echo is matched whole and its note drawn on the one line. */
  const STEER_ECHO_RE = /^\n\[steering\] ([\s\S]*?)\n?$/;
  const AFTER_STEER_RE = /(?:^|\n)↪ [^\n]*\n\n$/;
  // a steering note as the run gets it: one line, however many bubbles or line breaks it was typed in
  function steerNoteWire(text) { return String(text == null ? '' : text).replace(/\s*\r?\n\s*/g, ' ').trim(); }
  function joinReplyDelta(buf, delta) {
    const b = String(buf == null ? '' : buf), d = String(delta == null ? '' : delta);
    const m = STEER_ECHO_RE.exec(d);
    if (m) return (b.trim() ? b.replace(/\s+$/, '') + '\n\n' : '') + '↪ ' + steerNoteWire(m[1]) + '\n\n';
    if (AFTER_STEER_RE.test(b)) return b + d.replace(/^\s+/, '');
    return b + d;
  }
  // the registry's NOTE commands (slash.js steer, queue/q, background/bg/btw) -> what the words after them are for here
  const NOTE_CMDS = Object.freeze({ steer: 'steer', queue: 'queue', q: 'queue', background: 'background', bg: 'background', btw: 'background' });
  function parseCommand(text) {
    const s = String(text == null ? '' : text).trim();
    if (s[0] !== '/') return null;
    const sp = s.search(/\s/);
    let head = (sp === -1 ? s.slice(1) : s.slice(1, sp)).toLowerCase();
    const at = head.indexOf('@');                 // '/talk@mybot' -> 'talk'
    if (at !== -1) head = head.slice(0, at);
    if (head && !KNOWN_CMDS[head] && ALIAS_CMDS[head]) head = ALIAS_CMDS[head];   // '/reset' -> 'new', '/routines' -> 'routine'
    if (!head || !KNOWN_CMDS[head]) return null;   // not a control command -> treat as a normal message
    const arg = sp === -1 ? '' : s.slice(sp + 1).trim();
    return { cmd: head, arg: arg };
  }

  /* parseUserCommand(text, names) — recognise one of the Commander's OWN commands (`names` = what the sidecar's
     usercommands.json defines). Returns { name, line }, where `line` is the canonical "/name args" the slash
     registry can read, or null when the text is not one of them.

     Two forms a messenger produces that the registry cannot read raw (2026-10-18 — custom commands did not work
     in a bot's groups):
       '/standup@starnetbot'  Telegram appends the bot's @name when a command is picked in a group, and in privacy
                              mode it is often the only form the bot is sent at all. The registry refuses an '@', so
                              this answered "Unknown command." Stripped here exactly as parseCommand strips it for
                              the built-ins.
       '/disk_usage'          Telegram's command grammar has no '-', so a "/disk-usage" command can only be listed in
                              the "/" menu (and tapped) as "/disk_usage". Accepted as the same command — but an exact
                              name always wins, so a Commander who defined both keeps both.
     The head must end at whitespace or the end of the text: "/standup/notes.md" is a path, not a command. */
  function parseUserCommand(text, names) {
    const s = String(text == null ? '' : text).trim();
    const m = /^\/([A-Za-z0-9_-]+)(?:@[A-Za-z0-9_]+)?(?=\s|$)/.exec(s);
    if (!m) return null;
    const list = (Array.isArray(names) ? names : []).map(n => String(n).toLowerCase());
    const typed = m[1].toLowerCase();
    let name = list.indexOf(typed) !== -1 ? typed : null;
    if (!name && typed.indexOf('_') !== -1 && list.indexOf(typed.replace(/_/g, '-')) !== -1) name = typed.replace(/_/g, '-');
    if (!name) return null;
    const rest = s.slice(m[0].length).trim();
    return { name: name, line: '/' + name + (rest ? ' ' + rest : '') };
  }

  // Forgiving roster lookup: exact agentId, then case-insensitive exact name, then case-insensitive prefix on
  // name OR agentId (a unique prefix wins; an ambiguous prefix returns { ambiguous:[...] } so we can list them).
  function matchAgent(roster, query) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return null;
    const list = Array.isArray(roster) ? roster : [];
    for (const a of list) if (String(a.agentId) === q) return { agent: a };
    const ql = q.toLowerCase();
    const nameExact = list.filter(a => String(a.name || '').toLowerCase() === ql);
    if (nameExact.length === 1) return { agent: nameExact[0] };
    if (nameExact.length > 1) return { ambiguous: nameExact };
    const pref = list.filter(a => String(a.name || '').toLowerCase().startsWith(ql) || String(a.agentId).toLowerCase().startsWith(ql));
    if (pref.length === 1) return { agent: pref[0] };
    if (pref.length > 1) return { ambiguous: pref };
    return null;
  }

  function fmtAgentLine(a, boundId) {
    const mark = (boundId && String(a.agentId) === String(boundId)) ? '→ ' : '  ';
    const name = a.name && a.name !== a.agentId ? (a.name + ' (' + a.agentId + ')') : a.agentId;
    return mark + name + ' — ' + (a.model || 'no model set');
  }

  function makeChannelHub(opts) {
    const o = opts || {};
    const channel = o.channel || 'telegram';
    const runOnce = o.runOnce;
    const store = o.store;
    const send = o.send;
    const secrets = typeof o.secrets === 'function' ? o.secrets : () => ({});
    const classify = typeof o.classify === 'function' ? o.classify : () => true;
    const redact = typeof o.redact === 'function' ? o.redact : (p) => p;
    const emit = typeof o.emit === 'function' ? o.emit : () => {};
    const taskIntent = o.taskIntent && typeof o.taskIntent.parse === 'function' ? o.taskIntent : null;
    // TASK BRIEF v2 (additive dep): read the durable brief so the channel fallback can carry the host-validated
    // recommendation. Optional — a hub built without it renders the plain numbered choices exactly as before.
    const briefFor = typeof o.briefFor === 'function' ? o.briefFor : null;
    /* UNADDRESSED BY CONSTRUCTION (bindChats:false — the sample proof, 2026-08-07). A real channel chat REMEMBERS
       which agent it talks to: the hub saves the resolution onto any unbound chat so the autonomous notifier knows
       where to ping. For a hub whose "chat" is not a conversation at all — the POST /api/routing/sample proof crate,
       which exists to prove the floor sorts UNADDRESSED work — that bookkeeping is fatal: sample #1 saved a binding,
       so sample #2 took resolveTarget's ADDRESSED branch and rode straight to the remembered dock, bypassing the
       FILTER/SPLITTER the route claims it exercises. The proof quietly stopped proving anything from its second run
       on. With bindChats:false the hub neither READS nor WRITES a binding for this chat, so every dispatch is
       genuinely unaddressed — including on a station whose store already holds a stale 'sample' record. */
    const bindChats = o.bindChats !== false;
    const groundedFor = typeof o.groundedFor === 'function' ? o.groundedFor : null;
    /* LIVE STEER (optional, 2026-10-11): steerRun(runId, text) -> { ok } posts a note into an IN-FLIGHT run's steer
       buffer — the same buffer COMMS's mid-run steering uses (index.js steerBufs; the loop folds it in at its next
       step). With it, a follow-up that lands while this chat's run is working joins THAT run instead of killing it.
       Absent (tests, an older host) = the supersede behavior below, which now at least SAYS the earlier run stopped. */
    const steerRun = typeof o.steerRun === 'function' ? o.steerRun : null;
    const newId = typeof o.newId === 'function' ? o.newId : (() => { let n = 0; return () => channel + '-run-' + (++n); })();
    // INJECTED wall-clock — no ambient fallback (this module is pure/deterministic; the determinism gate bans a bare
    // Date.now here). The composition root passes now:()=>Date.now(); a hub built without one (unit tests) stamps a
    // run's startedAt as null. Used ONLY to age a run in the state snapshot — never for control flow, so a null
    // startedAt is harmless (the frontend's normalizeSnapshot reads a missing startedAt as 0ms-ago).
    const now = typeof o.now === 'function' ? o.now : null;
    // INJECTED delay (the SAME pattern adapter.js / discord.transport.js already use in this dir): sleep(ms) -> a
    // Promise that resolves after ms. Used ONLY by the supersede-retry backoff below. Tests pass a fake (instant +
    // records the delays); the real fallback is a setTimeout-backed sleep so the fix works even where the composition
    // root doesn't inject one. It is a wall-time WAIT, not a clock READ — the determinism gate bans Date.now/random
    // here, not setTimeout (see adapter.js:70, discord.transport.js:33 for the identical fallback).
    const sleep = typeof o.sleep === 'function' ? o.sleep : (ms => new Promise(r => setTimeout(r, ms)));
    // Durable replies must recover even when polling never drops. A separate outbound-only outage used to leave
    // the outbox parked forever unless another message happened to send successfully. The timer is injected for
    // deterministic tests, unref'd in production, and explicitly closed with the hub lifecycle.
    const setTimer = typeof o.setTimeout === 'function' ? o.setTimeout : setTimeout;
    const clearTimer = typeof o.clearTimeout === 'function' ? o.clearTimeout : clearTimeout;
    const outboxRetryMs = Number.isFinite(o.outboxRetryMs) ? Math.max(1, Number(o.outboxRetryMs)) : 5000;
    const outboxRetryMaxMs = Number.isFinite(o.outboxRetryMaxMs) ? Math.max(outboxRetryMs, Number(o.outboxRetryMaxMs)) : 60000;
    // Supersede-retry knobs (tunable for tests; the defaults give ~0.3s+0.6s+1.2s ≈ a couple seconds of grace). When a
    // second message aborts this chat's in-flight run, the fresh run can momentarily lose the same-agent workspace
    // mutex race in the host and get a TRANSIENT "already running a task" refusal — retry exactly that class a few
    // times so the user's message is never silently dropped. See SUPERSEDE_REFUSAL_RE below for the exact class.
    const supersedeRetries = Number.isFinite(o.supersedeRetries) ? Math.max(0, o.supersedeRetries | 0) : 3;
    const supersedeBackoffMs = Number.isFinite(o.supersedeBackoffMs) ? Math.max(0, o.supersedeBackoffMs) : 300;
    const maxMessageLength = o.maxMessageLength || 4096;
    const agentPrefix = o.agentPrefix || 'tg_';
    const resolveAgent = typeof o.resolveAgent === 'function' ? o.resolveAgent : null;   // Phase B: the placed floor's routing plan
    const getTag = typeof o.getTag === 'function' ? o.getTag : null;                     // FILTER content-routing key (B3 classifier)
    const resolveStation = typeof o.resolveStation === 'function' ? o.resolveStation : null;   // B5: per-bay capability station
    // STEP EDITOR (2026-08-05): stageBriefFor(agentId) -> the standing job brief of the dock this agent crews,
    // or null. PROMPT TEXT ONLY — appended to the entry run's system context below; it never widens grants,
    // tools, or routing (those stay with resolveStation/resolveAgent). Chain hops get theirs inside chain.js.
    const stageBriefFor = typeof o.stageBriefFor === 'function' ? o.stageBriefFor : null;
    // AGENTIC GRAPHS: the dock resolveAgent picked is stage ONE; the belts drawn PAST it say where its output
    // goes. `chain` is the injected executor (sidecar/routing/chain.js) already bound to the floor's edge
    // function — the hub hands it a way to run one hop and stays require-free. Absent -> a single-stage run,
    // byte-identical to the behaviour before work lines existed.
    const chain = (o.chain && typeof o.chain.advance === 'function') ? o.chain : null;
    /* WORK BELONGS TO A LINE (2026-08-07): lineOriginFor(agentId) -> the lineId work ARRIVING at this dock
       belongs to, or null when nothing triggered a workflow. Injected (index.js passes router.lineOriginFor)
       so the compiled plan alone decides; absent -> null -> the chain never advances, the safe default. */
    const lineOriginFor = typeof o.lineOriginFor === 'function' ? o.lineOriginFor : null;
    // Target-agent runtime identity for downstream work-line hops. The connection's own secrets belong only
    // to stage one; reusing them would silently run every later dock on the upstream model/provider.
    const resolveRunConfig = typeof o.resolveRunConfig === 'function' ? o.resolveRunConfig : null;
    // Opt-in for unaddressed sample runs: resolve identity only AFTER the router picks the dock.
    const resolveEntryRunConfig = typeof o.resolveEntryRunConfig === 'function' ? o.resolveEntryRunConfig : null;
    const onLineOutcome = typeof o.onLineOutcome === 'function' ? o.onLineOutcome : null;
    // ENTRY TAINT (security review 2026-09-24): a hub whose every inbound message is EXTERNAL DATA rather than the
    // owner speaking — the line-trigger hub (a webhook payload / a watched folder's file contents) — names the taint
    // its FIRST hop starts under, so the entry run's sensitive tools are consent-gated exactly like any other run
    // that has read untrusted content. Absent -> the old rule (only a media attachment taints the entry run).
    const entryTaint = (typeof o.entryTaint === 'string' && o.entryTaint.trim()) ? o.entryTaint.trim().slice(0, 80) : null;
    /* SEND TO VERDICTS (review finding conveyor-backend-04, 2026-10-13). A hub whose inbound is a SEND TO hand-off (the handoff
       runner's trigger hub, index.js makeTriggerHub) is told the SENDING job's own verdicts instead of inferring them from its taint
       label, so a job the Commander typed into LINE A keeps Full Access on LINE B exactly as an in-line hop does. Both only NARROW:
         entryUntrusted(msg) -> is this entry third-party content? Read only on an entryTaint hub; anything but a literal false, or a
                                throw, is untrusted. Absent -> today's rule (an entryTaint hub's entry is untrusted). An attachment or
                                a forwarded message stays untrusted whatever it answers.
         senderWithheld(msg) -> did the sending job run with host power withheld (a non-owner sender)? Anything but a literal false, or a
                                throw, withholds: the entry run and every hop then run as that sender did (channelSender:true,
                                channelSenderOwner:false). Absent -> nothing is withheld beyond this hub's own sender rule.
       The entry run still starts TAINTED under entryTaint (initialTaint below), like a chain hop. */
    const entryUntrustedFn = typeof o.entryUntrusted === 'function' ? o.entryUntrusted : (() => !!entryTaint);
    const senderWithheldFn = typeof o.senderWithheld === 'function' ? o.senderWithheld : null;
    function entryVerdictUntrusted(msg) {
      try { return entryUntrustedFn(msg) !== false; }
      catch (e) { failNote('channels.hub.entryUntrusted', e); return true; }
    }
    function senderVerdictWithheld(msg) {
      if (!senderWithheldFn) return false;
      try { return senderWithheldFn(msg) !== false; }
      catch (e) { failNote('channels.hub.senderWithheld', e); return true; }
    }
    // SAMPLE/PROOF SEAM (additive, 2026-08-05): an optional streamId (string, or fn(chatId) -> string) stamped
    // onto every runOnce this hub fires (entry dock AND chain hops). With it, the host records the runs +
    // transcripts under that workstream (runs.jsonl streamId -> a readable OUTBOX crate); WITHOUT it — every
    // existing channel — runOnce receives streamId undefined, which the host already reads exactly like the
    // old absent property ('' / 'global' fallbacks), so behaviour is unchanged.
    const streamIdFor = typeof o.streamId === 'function' ? o.streamId
      : (o.streamId ? function () { return String(o.streamId); } : null);
    // Canonical transcript projection. Ordinary channel chats share the durable workstream ledger used by
    // desktop COMMS; the legacy channel history remains an offline fallback only.
    const historyFor = typeof o.historyFor === 'function' ? o.historyFor : null;
    // observeInto(streamId, agentId, text, taint) files an OVERHEARD group line (/mention observe) as a run-less user row
    // in that canonical stream — the one historyFor replays. Without it a hub with historyFor never shows the agent what
    // it overheard, so observe is offered only where it can be kept (observeKept below).
    const observeInto = typeof o.observeInto === 'function' ? o.observeInto : null;
    // ONE-RESOLVER LAW: any telemetry that attributes an inbound message to an agent (workitem crates, queue
    // HUD) must come from THIS hub's resolution, never a parallel guess. onResolved fires once per real message
    // (never for /commands) with the exact agentId the run will execute as, in onInbound's first synchronous
    // slice — before any run starts. Optional; a throwing hook must never break the inbound.
    const onResolved = typeof o.onResolved === 'function' ? o.onResolved : null;
    // In-messenger control surface (channel-agnostic — lives HERE so Telegram/Discord/any future adapter behave
    // identically). All optional: absent -> commands degrade to an honest "not available here" reply.
    //   roster()          -> [{ agentId, name, model, provider }]  (the SAME roster the browser dossier reads)
    //   setModel(id,model)-> { ok, agentId, model, name?, error? } (MUST go through the roster's own write path)
    //   modelCatalog()    -> [modelId,...]  (optional; when reachable, /model validates against it)
    // runSlash(input, ctx) -> { ok, text } — executes a slash command through the SHARED registry the desktop
    // palette uses, in-process (no self-HTTP, no api token). Injected so this module stays testable and so a
    // wire-up that has no slash layer simply reports the command as unavailable rather than crashing.
    const runSlashFn = typeof o.runSlash === 'function' ? o.runSlash : null;
    // names of the Commander's own commands, so this hub can recognise one without owning the list
    const userCommandNames = typeof o.userCommandNames === 'function' ? o.userCommandNames : (() => []);
    // desktopCommand(token) -> true when the shared registry's BUILT-IN table knows this name or alias (slash.resolve):
    // a desktop palette command this hub has no row for (/version, /q, /retry…). Optional; absent = the old fall-through.
    const desktopCommandFn = typeof o.desktopCommand === 'function' ? o.desktopCommand : null;
    // The composition root may mint this only for an authenticated Telegram owner DM. It deliberately lives at
    // the hub edge so every other channel and every Telegram group message stays on its ordinary policy.
    const ownerTrustedFor = typeof o.ownerTrusted === 'function' ? o.ownerTrusted : (() => false);
    // whether this hub HAS an owner DM that can be trusted — what a shell-command refusal may point the owner to
    const ownerDmExec = typeof o.ownerTrusted === 'function';
    /* OWNER IDENTITY for control commands and Full Power inheritance (2026-09-25, sec-owner-gates).
       isOwner(msg) answers "is this sender the bound owner?" in ANY chat type (the owner may /model from their own
       group); it is minted by the composition root from the adapter's paired owner id, never from message text.
       ownerSurface:true marks a hub whose every inbound is already the Commander (the local dev/sample routes and
       the owner-configured line triggers behind the launch token) — it keeps those surfaces byte-identical.
       Absent both, the fallback is ownerTrusted (owner DM) — fail closed: a hub that cannot name its owner
       grants the owner-only commands to nobody. */
    const ownerSurface = o.ownerSurface === true;
    const isOwnerFor = ownerSurface ? (() => true)
      : (typeof o.isOwner === 'function' ? o.isOwner : ownerTrustedFor);
    // untrustedSenders:false — this hub has no chat senders at all (the owner-configured line triggers): its runs
    // are not tagged as sender-originated, so their Full Power posture is unchanged, while its commands still need
    // an owner it can never name (a webhook body that starts with /stop is refused, not obeyed).
    const tagSenderRuns = !ownerSurface && o.untrustedSenders !== false;
    const rosterFn = typeof o.roster === 'function' ? o.roster : null;
    const setModelFn = typeof o.setModel === 'function' ? o.setModel : null;
    const modelCatalogFn = typeof o.modelCatalog === 'function' ? o.modelCatalog : null;
    // MEDIA INGEST (photos/videos/voice/files the user sends IN the messenger). All three are injected by the
    // composition root; any absent -> media degrades to an honest per-item note instead of a silent drop:
    //   fetchMedia(item)                   -> { ok, buffer?, error? }   (adapter.getFile — platform download)
    //   saveAttachment(agentId, name, url) -> { ok, id, name, path, mediaType, kind } (the SAME workspace
    //                                         .attachments/ store the browser COMMS composer uses)
    //   expandAttachments(messages, agentId) -> messages with refs expanded into provider content blocks (the
    //                                         SAME expandUserAttachments the interactive run host calls)
    const fetchMedia = typeof o.fetchMedia === 'function' ? o.fetchMedia : null;
    // INJECTED STT (2026-07-29). transcribe(buffer, mime, name) -> { ok, text } | { ok:false, reason }. Absent,
    // a voice note degrades to exactly the old behaviour (saved file + a note naming its path) — the feature is
    // additive and a host that wires no engine is unchanged.
    const transcribe = typeof o.transcribe === 'function' ? o.transcribe : null;
    const saveAttachmentFn = typeof o.saveAttachment === 'function' ? o.saveAttachment : null;
    const expandAttachments = typeof o.expandAttachments === 'function' ? o.expandAttachments : null;
    // TYPING INDICATOR (ref-parity): chatAction(chatId) fires ONE platform "typing…" action (adapter.chatAction
    // -> Telegram sendChatAction). Optional — absent means the channel simply shows no typing bubble, exactly the
    // old behavior. Telegram's bubble expires ~5s after each action, so the keep-alive loop below refreshes every
    // typingRefreshMs (default 4s: safely inside the 5s window at half the API traffic of the reference's 2s).
    const chatAction = typeof o.chatAction === 'function' ? o.chatAction : null;
    const typingRefreshMs = Number.isFinite(o.typingRefreshMs) ? Math.max(250, o.typingRefreshMs) : 4000;
    // ---- INLINE KEYBOARDS (C6) ---------------------------------------------------------------------------
    // All four are optional and travel together: a hub missing ANY of them renders questions as the numbered
    // text list it always did and never offers approve/deny buttons. That is what keeps every other channel
    // (Discord/Slack/Matrix/Signal) byte-identical while Telegram gains buttons.
    //   prompts        -> the bounded token→meaning registry (channels/prompts.js); the callback_data codec
    //   answerCallback(callbackId, text)            -> ack a tap (kills Telegram's button spinner)
    //   editMessage(chatId, messageId, text, opts)  -> stamp the decision + strip the spent keyboard
    //   askConsent({ agentId, runId, signal, call, tool, onPrompt }) -> Promise<decision>
    //     The HOST owns the pause/resolve (it registers the prompt in the same pendingByRun map the browser's
    //     POST /api/consent answers, so a Telegram prompt is ALSO answerable from the app). The hub owns only
    //     the display and the button→decision hop. onPrompt(promptId, fields) fires synchronously at register
    //     time — that is the hub's cue to render the keyboard.
    //   resolveConsent(runId, promptId, decision)   -> bool (the host's finisher lookup)
    const prompts = o.prompts && typeof o.prompts.create === 'function' ? o.prompts : null;
    const answerCallback = typeof o.answerCallback === 'function' ? o.answerCallback : null;
    const editMessage = typeof o.editMessage === 'function' ? o.editMessage : null;
    const askConsent = typeof o.askConsent === 'function' ? o.askConsent : null;
    const resolveConsent = typeof o.resolveConsent === 'function' ? o.resolveConsent : null;
    //   consentOutcome(runId, promptId) -> how an already-settled prompt really ended ('once'|'session'|'always'|'full'|
    //   'deny'|'timeout'|''): STARNET REMOTE answers the same waiter, so a lost race is not always an expiry (optional)
    const consentOutcome = typeof o.consentOutcome === 'function' ? o.consentOutcome : null;
    const buttonsOk = !!(prompts && answerCallback);   // the minimum to render a tappable keyboard at all
    // Telegram truncates long inline-button labels on narrow phones, so the FULL option text always stays in the
    // message body and the button carries a short, numbered echo of it (reference-harness lesson). 30 chars fits
    // comfortably on a small screen; the leading "N." ties every button to its line in the body list.
    const BTN_LABEL_MAX = 30;
    function btnLabel(n, text) {
      const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      const head = n + '. ';
      return s.length + head.length <= BTN_LABEL_MAX ? head + s : head + s.slice(0, Math.max(1, BTN_LABEL_MAX - head.length - 1)) + '…';
    }
    // Build the Bot API reply_markup for a registered prompt: one button per row (a vertical list stays readable
    // on a phone, and option text is far too long for side-by-side buttons).
    function keyboardFor(entry) {
      return { inline_keyboard: entry.options.map((opt, i) => [{ text: opt.label, callback_data: prompts.data(entry.token, i) }]) };
    }

    // Render ONE live permission ask as an inline keyboard. The four decisions are exactly the broker's own
    // vocabulary (once/session/always/deny) so a tap here means precisely what the same word means on the
    // browser's consent card — this is a second display of one mechanism, not a parallel one.
    //
    // FIRE-AND-FORGET BY CONTRACT: the host calls onPrompt synchronously while registering the prompt, and its
    // fail-closed deny timer is ALREADY running. So this must never throw back into that path and never be
    // awaited by it. If the keyboard fails to send, the prompt simply goes unanswered and the host denies it on
    // schedule — the safe direction, and the same outcome as a Commander who never looks at their phone.
    function sendConsentPrompt(chatId, runId, promptId, fields) {
      (async () => {
        const f = fields || {};
        const entry = prompts.create({
          kind: 'consent',
          chatId: chatId,
          options: [
            { label: '✅ Allow once', value: 'once' },
            { label: '✅ Allow for this session', value: 'session' },
            { label: '♾️ Always allow', value: 'always' },
            { label: '❌ Deny', value: 'deny' }
          ],
          meta: { runId: runId, promptId: promptId }
        });
        if (!entry) return;
        // argsSummary is the WHOLE request now (consentSummary): fit it under a chat message's limit, and say when it
        // doesn't fit — a silent cut would ask for an approval of words the Commander never saw
        const ARGS_MAX = 3000;
        const args = String(f.argsSummary || '').trim();
        const shown = args.length > ARGS_MAX ? args.slice(0, ARGS_MAX) + '\n… (' + (args.length - ARGS_MAX) + ' more characters: open StarNet to read the whole request before you allow it)' : args;
        const body = '🔐 Permission needed\n\n' + String(f.tool || 'a tool')
          + (f.scope ? '  (' + f.scope + ')' : '')
          + (shown ? '\n' + shown : '')
          + '\n\nIf you don\'t answer, this is denied and the run moves on.';
        entry.meta.text = body;
        const r = await deliver(chatId, body, runId, 'prompt', '', { reply_markup: keyboardFor(entry) });
        // Only a message that actually LANDED can be edited when tapped.
        if (r && r.ok) { if (r.messageId) prompts.attach(entry.token, r.messageId); return; }
        // THE KEYBOARD NEVER LANDED. Retire the token, then DENY IMMEDIATELY instead of letting the host's
        // fail-closed timer run its full course. The Commander was never actually asked, so making them wait out
        // CONSENT_TIMEOUT_MS for the answer that is already certain would turn an undeliverable prompt into a
        // two-minute stall — strictly worse than the autonomous floor this chat opted IN from. Same decision,
        // no wait. (No apology message here: the send path is the thing that just failed.)
        prompts.take(entry.token);
        try { if (resolveConsent) resolveConsent(runId, promptId, 'deny'); } catch (e) { failNote('channels.hub.consent.deny', e); }
      })().catch(function () {});
    }
    /* AN UNANSWERED APPROVAL EXPIRED (2026-10-11). It fail-closes (the action does not run), but it used to do so in
       silence and the agent then told the user "you declined". Tell the chat what actually happened and how to retry;
       a late tap on the old keyboard already answers "this was already settled" (onCallback). */
    function notifyConsentTimeout(chatId, runId, fields) {
      const tool = String((fields && fields.tool) || 'that action');
      deliver(chatId, '⌛ No answer in time — ' + tool + ' was NOT run, and the task carried on without it. Reply to ask for it again if you still want it.', runId, 'command')
        .catch(function (e) { failNote('channels.hub.consent.timeoutNotice', e); });
    }
    const MAX_MEDIA_PER_MESSAGE = 10;                // a full Telegram album is 10 items; a merged album must fit
    const MAX_REPLY_MEDIA = 4;                       // files lifted off a QUOTED message — context, never the bulk
    const MAX_MEDIA_BYTES = 8 * 1024 * 1024;         // mirrors attachments.js MAX_BYTES (saveAttachment re-enforces)
    if (typeof runOnce !== 'function') throw new Error('makeChannelHub: runOnce is required');
    if (!store || typeof store.loadHistory !== 'function') throw new Error('makeChannelHub: a channel store is required');
    if (typeof send !== 'function') throw new Error('makeChannelHub: a send(chatId,text) is required');

    // The fallback factory is INVOKED: un-invoked, personaFor returned the inner arrow and every run without a configured
    // system prompt reached the provider opening with the literal text "() => p" (2026-06-14 .. 2026-10-20).
    const personaFor = typeof o.persona === 'function' ? o.persona
      : (() => { const p = (typeof o.persona === 'string' && o.persona) || DEFAULT_PERSONA; return () => p; })();

    const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // notebook/fs-jail agentId grammar (a configured agentId must match)
    // chatId -> { runId, abort, superseded, agentId, startedAt } (one run per CONVERSATION, not per agent). The
    // record is the SINGLE source of truth for this channel's live runs: E-STOP reads it (killAll in halt.js) AND
    // GET /api/state/snapshot reads it (so a reconnect never wipes a live channel run's floor/HUD state — the
    // reconcile keeps any agent listed here). agentId/startedAt are carried so the snapshot can attribute the run
    // to the acting agent and age it, exactly like an interactive/cron/workshop run in runsMeta. Additive to the
    // record: halt.js only ever reads { abort, superseded }, so the extra fields are invisible to it.
    const inflight = new Map();

    // chatId -> a per-chat agentId, sanitized to the notebook/fs-jail grammar (/^[A-Za-z0-9_-]{1,40}$/). Telegram
    // chat ids are already safe (numeric, '-' for groups); the prefix namespaces them away from the browser 'agent'.
    function agentIdFor(chatId) {
      const tail = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40 - agentPrefix.length);
      return agentPrefix + (tail || '0');
    }
    /* HOP HISTORY IS KEYED BY CHAT LINEAGE, NOT BY AGENT (sec-taint 09-25). A downstream hop replays its prior turns
       from the channel store. That store was keyed by the hop's agentId alone, so every chat, every line and every
       direct conversation with that agent shared ONE history: text a hop was handed in chat A (upstream output,
       possibly a hostile page an upstream stage read) replayed into chat B's run of the same agent — and into that
       agent's own untainted DM fallback history. The key is now a digest of channel + chat + line + dock, so a hop
       remembers only the handoffs of its OWN chat's line. Deterministic (two FNV-1a lanes), fits the store's
       agentId grammar ('hop_' + 32 hex = 36 chars ≤ 40), and can never equal a real agent's history file by
       accident short of a 2^-64 collision. */
    function hopHistoryKey(chatId, lineId, node) {
      const src = channel + '\u0000' + String(chatId) + '\u0000' + String(lineId || '') + '\u0000' + String(node || '');
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let i = 0; i < src.length; i++) {
        const c = src.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
      }
      const hex = (n) => ('00000000' + n.toString(16)).slice(-8);
      return 'hop_' + hex(h1) + hex(h2) + hex(Math.imul(h1 ^ h2, 0x01000193) >>> 0) + hex((h2 + src.length) >>> 0);
    }
    // the hop keys a chat has written, remembered on its chat record so /new forgets the line's handoffs too
    function rememberHopKey(chatId, key) {
      if (!bindChats || typeof store.getChatRecord !== 'function' || typeof store.saveChatRecord !== 'function') return;
      try {
        const rec = store.getChatRecord(chatId) || {};
        const keys = Array.isArray(rec.hopKeys) ? rec.hopKeys.filter(k => typeof k === 'string' && AID_RE.test(k)) : [];
        if (keys.indexOf(key) >= 0) return;
        keys.push(key);
        store.saveChatRecord(chatId, { hopKeys: keys.slice(-32) });
      } catch (e) { failNote('channels.hub.hopKeys', e); }
    }

    function resolvedStreamId(chatId) {
      let explicit = '';
      try { if (streamIdFor) explicit = String(streamIdFor(chatId) || ''); } catch (_) { explicit = ''; }
      if (/^[A-Za-z0-9_-]{1,64}$/.test(explicit)) return explicit;
      if (!bindChats) return null;
      try {
        const rec = typeof store.getChatRecord === 'function' ? store.getChatRecord(chatId) : null;
        // a string, always: a NEW chat has no record, and RegExp.test(undefined) tests "undefined" — a valid-looking id
        const bound = rec ? String(rec.streamId || '') : '';
        if (/^[A-Za-z0-9_-]{1,64}$/.test(bound)) return bound;
      } catch (_) {}
      const base = ('channel_' + channel + '_' + String(chatId)).replace(/[^A-Za-z0-9_-]/g, '_');
      return base.slice(0, 64) || null;
    }

    /* ---- ROUTE: answer WHERE the question was asked -------------------------------------------------------
       Two facts arrive with an inbound message and were both thrown away: which sub-conversation it came from
       (`threadId` — a Telegram forum topic today), and which message it was (`messageId`). Without the first,
       every answer in a forum supergroup lands in **General instead of the topic the member is sitting in** —
       the last remaining case of this channel delivering to the wrong place rather than merely doing less. Without
       the second, a reply in a busy group floats loose from its question.

       Ambient per chat rather than threaded through ~40 deliver() call-sites: the route is a property of the
       CONVERSATION, so /status, a consent card and the run's answer should all land in the same topic without
       each having to know it. Bounded (MAX_ROUTES, oldest evicted) because chatIds are unbounded.

       The quote is CONSUMED on first use; the thread is not. A quote answers one specific message, so a routine
       firing six hours later must not reach back and reply to it — but it should still land in the right topic.
       Fields are neutral ({ threadId, replyTo }); only telegram.transport.js knows the Bot API's names, and the
       other four transports ignore opts they do not recognise, so their behaviour is byte-identical. */
    const MAX_ROUTES = 500;
    const routes = new Map();   // chatId -> { threadId, replyTo, lastMessageId }
    function noteRoute(msg) {
      const chatId = String(msg.chatId);
      const threadId = (msg.threadId == null || msg.threadId === '') ? '' : String(msg.threadId);
      // Quoting in a DM is noise — there is only one other person and nothing to disambiguate. Groups only,
      // which is also where a detached answer actually costs the reader something.
      const replyTo = (msg.chatType === 'group' && msg.messageId != null && msg.messageId !== '') ? String(msg.messageId) : '';
      const lastMessageId = (msg.messageId == null || msg.messageId === '') ? '' : String(msg.messageId);
      routes.delete(chatId);                        // re-insert so Map iteration order is least-recently-used first
      routes.set(chatId, { threadId: threadId, replyTo: replyTo, lastMessageId: lastMessageId });
      while (routes.size > MAX_ROUTES) { const k = routes.keys().next().value; routes.delete(k); }
    }

    /* IS THIS EDIT WORTH A FRESH RUN?
       Telegram now delivers `edited_message`, which closes a real gap — fixing a typo used to change nothing and
       the bot went on answering the typo. But "an edit is just another message" is too blunt: editing something
       from last week would fire a run out of nowhere, and it would be spend the member never asked for.

       The bound is the narrowest one that still fixes the case people actually hit: an edit counts only when it
       edits the LAST message we saw in that chat. Anything older is somebody tidying history, not asking again.
       No record (a fresh boot) also declines — we cannot tell an ancient edit from a fresh one, and inventing a
       run is worse than doing nothing. When it IS accepted, the supersede rule downstream does the rest: a
       correction made while the bot is still thinking aborts the stale run and re-answers the corrected text. */
    function editIsCurrent(msg) {
      const r = routes.get(String(msg.chatId));
      if (!r || !r.lastMessageId) return false;
      return String(msg.messageId || '') === r.lastMessageId;
    }
    /* The topic this chat was bound to no longer exists — the transport already saved the message by resending
       to the chat root, but the binding itself must go too, or every later send repeats that failed call and
       its retry. Dropped rather than remembered as "dead": the next inbound message re-learns the real topic. */
    function forgetThread(chatId) {
      const r = routes.get(String(chatId));
      if (r && r.threadId) r.threadId = '';
    }
    // first=true asks for the quote as well (and spends it). Returns null when this chat has no route, so the
    // send call is byte-identical to before on every platform that never sets one.
    function routeOpts(chatId, first) {
      const r = routes.get(String(chatId));
      if (!r) return null;
      const out = {};
      if (r.threadId) out.threadId = r.threadId;
      if (first && r.replyTo) { out.replyTo = r.replyTo; r.replyTo = ''; }
      return (out.threadId || out.replyTo) ? out : null;
    }

    /* ---- REACTION ACK: "I heard you", for the price of one API call -----------------------------------------
       The typing bubble answers "is it working?" only while you are looking at the chat. A reaction is durable:
       put 👀 on the question when the run starts, take it off when the answer lands. It costs no message, adds
       nothing to scroll past, and it is the one acknowledgement that still reads correctly when the member comes
       back twenty minutes later — a run that is still thinking is still marked.

       Purely cosmetic, and it must stay that way: transport-optional (a channel without reactions returns
       ok:false and we never try again for that run), every failure swallowed, and the clear is best-effort. The
       emoji is a CONSTANT, not a setting — bots may only use Telegram's fixed reaction set and an unlisted emoji
       is a 400 that would make the ack look broken. */
    const ACK_EMOJI = '👀';
    const setReaction = typeof o.setReaction === 'function' ? o.setReaction : null;
    const reactionAck = o.reactionAck !== false;   // opt-out for a host that finds it noisy; on by default
    function startAck(chatId, messageId) {
      if (!setReaction || !reactionAck || messageId == null || messageId === '') return function () {};
      let armed = false, cleared = false;
      const set = Promise.resolve()
        .then(() => setReaction(chatId, messageId, ACK_EMOJI))
        .then(r => { armed = !!(r && r.ok); })
        .catch(() => {});
      return function () {
        if (cleared) return;
        cleared = true;
        // Wait for the SET to resolve before clearing: a clear that overtakes its own set leaves the 👀 stuck on
        // a question that was answered ages ago — the exact "the app asserts state the harness can't prove" bug.
        set.then(() => { if (armed) return setReaction(chatId, messageId, ''); }).catch(() => {});
      };
    }

    /* ---- LIVE STREAMING: the reply is written in front of you ------------------------------------------------
       Until now a long answer was a typing bubble followed, thirty seconds later, by a wall of text. This grows
       the reply in place: the first sentences go out as a real message, and each subsequent throttle window
       edits that same message with everything produced so far.

       THE INVARIANT, and the only one that matters: **exactly one complete reply, whatever fails.** Streaming is
       an optimisation on top of the existing deliver() path, never a replacement for it. Every failure mode
       converges on the same place:
         · cannot seed (send failed, channel cannot edit) -> streaming is dead for this run, deliver() sends
           normally, and nothing was left behind because nothing was sent;
         · an intermediate edit fails (429, a blip) -> skipped, the next window tries again, the final edit
           still carries the whole text;
         · the FINAL edit fails -> the stale partial is DELETED and the reply is sent whole, so the member never
           ends up reading half an answer sitting above the real one;
         · the reply outgrows one message -> streaming stops at the limit and deliver() chunks as it always did,
           with chunk 0 replacing the streamed message in place;
         · the run is superseded or E-STOPped -> the partial is deleted, because it answers a question that has
           been withdrawn.

       Both editMessage AND deleteMessage must be wired: arming the grow without the clean-up is what turns a
       failed edit into a duplicate reply. That pairing is also what keeps this Telegram-only for now — no other
       transport supplies either, so their behaviour is byte-identical. */
    /* Can this bot hear a group at all? true / false / null when we have not been told. Read through a function
       because it is learned from getMe, after this hub is built — the same late-binding the bot's own name needs.
       A throwing or absent source answers null, and null means SAY NOTHING: inventing a limitation is as
       dishonest as hiding one. */
    const privacyFn = typeof o.canReadAllGroupMessages === 'function' ? o.canReadAllGroupMessages : null;
    function privacyOk() {
      if (!privacyFn) return null;
      try { const v = privacyFn(); return (v === true || v === false) ? v : null; } catch (_) { return null; }
    }
    const deleteMessage = typeof o.deleteMessage === 'function' ? o.deleteMessage : null;
    const streamOk = !!(editMessage && deleteMessage) && o.streamReplies !== false;
    const STREAM_MIN_MS = Number.isFinite(o.streamMinMs) ? Math.max(250, o.streamMinMs) : 1500;   // Telegram edits: ~1/s is safe
    const STREAM_MIN_CHARS = Number.isFinite(o.streamMinChars) ? Math.max(1, o.streamMinChars) : 60;   // don't seed on "Su"
    const notModified = (e) => /not modified/i.test(String(e || ''));

    function startStream(chatId) {
      if (!streamOk) return null;
      let seedId = '', shown = '', lastAt = -Infinity, dead = false, inFlight = false, done = false;
      const clockNow = () => (now ? now() : 0);
      return {
        get messageId() { return seedId; },
        // Fire-and-forget: called on every token delta with the FULL text so far. Never awaited by the run, and
        // it drops any delta that arrives while an edit is in flight — the next one carries that text anyway.
        push(full) {
          if (dead || done || inFlight) return;
          const text = String(full == null ? '' : full);
          if (!text.trim() || text === shown) return;
          /* NEVER STREAM A PROTOCOL MARKER. The reply that reaches the member is not always `state.buf`: a
             `TASK_QUESTION: …` answer is parsed, stripped and re-rendered as a numbered list with a keyboard
             under it. Streaming the raw buffer would put the internal marker on the member's screen for a few
             seconds before it turned into the real thing — the app showing something the harness never meant to
             assert. Cheap and general: an opening ALL-CAPS token followed by a colon is a marker, not prose, so
             this run simply does not stream. It still delivers, in full, the ordinary way. */
          if (/^\s*[A-Z][A-Z_]{3,}:/.test(text)) { dead = true; return; }
          // Past the single-message limit there is nothing left to stream INTO. Stop, and let deliver() chunk —
          // it will still replace this message in place with chunk 0.
          if (text.length > maxMessageLength) { dead = true; return; }
          const t = clockNow();
          if (seedId && (t - lastAt) < STREAM_MIN_MS) return;
          if (!seedId && text.length < STREAM_MIN_CHARS) return;
          inFlight = true;
          const p = seedId
            ? editMessage(chatId, seedId, text, {})
            : send(chatId, text, routeOpts(chatId, true) || undefined);
          Promise.resolve(p).then((r) => {
            if (r && r.ok) {
              shown = text; lastAt = clockNow();
              if (!seedId) { seedId = String(r.messageId || ''); if (!seedId) dead = true; }   // no id back = nothing to edit
            } else if (!seedId) {
              dead = true;   // could not even start — one probe, then leave the run entirely alone
            }
          }).catch(() => { if (!seedId) dead = true; })
            .then(() => { inFlight = false; });
        },
        // deliver() takes it from here: '' means "send normally", an id means "replace that message in place".
        seal() { done = true; return seedId; },
        // The question was withdrawn (superseded / E-STOP). A partial answer to a question nobody is waiting for
        // is worse than no answer, so remove it.
        abandon() {
          done = true;
          const id = seedId; seedId = '';
          if (!id) return;
          try { Promise.resolve(deleteMessage(chatId, id)).catch(() => {}); } catch (_) {}
        }
      };
    }

    // ---- typing keep-alive: refresh the platform's "typing…" bubble while a run is in flight ---------------
    // Returns a stop() closure. The loop is detached (fire-and-forget) and PURELY cosmetic: any failure degrades
    // to no bubble, never touches the reply path. Backoff mirrors send(): a 429's retry_after (capped 30s) is
    // waited out; a non-retryable failure (bad chat, unsupported channel) stops the loop for this run entirely —
    // one probe, no hammering. There is no "stop typing" API on any platform: stopping just means ceasing
    // refreshes and letting the client-side ~5s timer expire, which is why stop() runs BEFORE deliver() — the
    // final reply must never race a fresh 5s bubble that would linger after the answer (reference-harness lesson).
    function startTyping(chatId) {
      if (!chatAction) return function () {};
      let stopped = false;
      (async () => {
        while (!stopped) {
          let r;
          try { r = await chatAction(chatId, routeOpts(chatId, false)); } catch (e) { r = { ok: false, retryable: true }; }
          if (stopped) break;
          if (r && r.ok === false && !r.retryable) break;
          const waitMs = (r && r.ok === false && Number(r.retryAfter) > 0)
            ? Math.min(Number(r.retryAfter) * 1000, 30000)
            : typingRefreshMs;
          await sleep(waitMs);
        }
      })().catch(function () {});
      return function () { stopped = true; };
    }

    // agentId (optional, last arg) names WHICH roster agent produced this reply, so the floor can pulse the RIGHT
    // agent's dish on a multi-agent station. Passed only for a real RUN reply (onInbound); administrative command
    // replies (/agents, /model…) omit it — no agent "produced" them, so the floor should not attribute a dish.
    // sendOpts (optional) rides ONLY on the FINAL chunk — a keyboard must land under the last thing the user
    // reads, and Telegram would otherwise render one set of buttons per chunk of a long reply. Returns the final
    // chunk's messageId too, which is what a keyboard needs in order to be edited/stripped once it is tapped.
    async function deliver(chatId, text, runId, reason, agentId, sendOpts, seedId) {
      // `send` is what goes on the wire; `raw` rebuilds any undelivered REMAINDER (see chunkTextParts — joining the
      // fence-doctored chunks bakes synthetic ``` markers into the stored text, re-fenced on every redelivery).
      const parts = chunkTextParts(text, maxMessageLength);
      const chunks = parts.send;
      let ok = true, failedAt = -1, messageId = '';
      // A message the stream already put in the chat. Chunk 0 REPLACES it rather than being sent again — that
      // replacement is the whole difference between "streamed" and "streamed, then repeated".
      let seed = (seedId && editMessage) ? String(seedId) : '';
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        // The route rides EVERY chunk (all of a split reply belongs in one topic) while the quote and the
        // keyboard each ride exactly one: the quote the first chunk, the keyboard the last. A fresh object every
        // time — the caller's sendOpts is theirs and must not grow a stale reply id.
        const rt = routeOpts(chatId, i === 0);
        const terminal = (last && sendOpts) ? sendOpts : null;
        const opts = (rt || terminal) ? Object.assign({}, terminal || {}, rt || {}) : undefined;
        let r;
        if (i === 0 && seed) {
          // Replace the streamed partial with the finished chunk. "message is not modified" means the text we
          // streamed was already the final text — a success wearing a 400.
          try { r = await editMessage(chatId, seed, chunks[0], opts || {}); } catch (e) { r = { ok: false, error: (e && e.message) || 'editMessage threw' }; }
          if (r && r.ok === false && notModified(r.error)) r = { ok: true, messageId: seed };
          if (!r || r.ok === false) {
            /* The partial is stranded: we cannot update it and we are about to send the real answer. Remove it
               first, or the member reads half an answer immediately above the whole one. The delete is
               best-effort — if it fails too, delivering the reply still matters more than the duplicate. */
            try { await deleteMessage(chatId, seed); } catch (_) {}
            seed = '';
            try { r = await send(chatId, chunks[0], opts); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
          } else if (!r.messageId) {
            r = { ok: true, messageId: seed };   // an edit answers with no id of its own; it is still that message
          }
        } else {
          try { r = await send(chatId, chunks[i], opts); } catch (e) { r = { ok: false, error: (e && e.message) || 'send threw' }; }
        }
        if (r && r.threadGone) forgetThread(chatId);   // the topic is gone; stop aiming at it
        if (!r || r.ok === false) { ok = false; failedAt = i; break; }
        if (last && r.messageId) messageId = String(r.messageId);
      }
      // DURABLE OUTBOX: a reply that failed to send used to be recorded (channel.delivery ok:false) and then
      // LOST — the agent did the work and the Commander never saw the result. Queue the undelivered remainder
      // (only the chunks that did NOT go out) in the store's bounded outbox; flushOutbox redelivers it when the
      // transport is proven healthy again (next successful delivery, or the adapter's next 'up' status). Command
      // replies (/help, /agents…) are ephemeral and stay fire-and-forget — a stale command menu hours later is
      // noise, not a lost result. Guarded on pushOutbox so hubs built over older/test stores behave as before.
      // 'prompt' joins 'command' as ephemeral: a permission ask whose keyboard failed to send is answered by the
      // host's fail-closed timer within seconds — redelivering that dead question hours later would invite a tap
      // on a run that ended long ago.
      // …unless the chat is KNOWN unreachable. Queueing for a chat that blocked us is not resilience, it is a
      // pile of retries that can only ever fail — and every one of them is an API call. See onMembership.
      // Read the record only on the failure path: this runs on every delivered message, and the happy path must
      // not pay a store read to answer a question that only matters when a send has already failed.
      let unreachable = false;
      if (!ok) {
        try { const r0 = typeof store.getChatRecord === 'function' ? store.getChatRecord(String(chatId)) : null; unreachable = !!(r0 && r0.unreachable); } catch (_) {}
      }
      if (!ok && unreachable) {
        try { console.error('[' + channel + '] reply for chat ' + chatId + ' NOT queued — this chat has blocked or removed the bot'); } catch (_) {}
      }
      const mustPersistFailure = !ok && !unreachable && reason !== 'command' && reason !== 'prompt' && typeof store.pushOutbox === 'function';
      let failurePersisted = false;
      let failurePersistError = null;
      if (mustPersistFailure) {
        try {
          const remainder = '⌛ delayed reply — the channel was unreachable when this was first sent:\n' + parts.raw.slice(failedAt).join('');
          store.pushOutbox({ channel: channel, chatId: String(chatId), text: remainder, runId: runId || '', agentId: agentId ? String(agentId) : '', reason: reason || '' });
          failurePersisted = true;
          scheduleOutboxRetry();
        } catch (e) { failurePersistError = e; }
      }
      const ev = { channel, chatId: String(chatId), runId: runId || '', ok, chunks: chunks.length, reason: reason || '' };
      if (agentId) ev.agentId = String(agentId);   // additive/optional — attribute the dish to the acting agent
      try { emit('channel.delivery', ev); } catch (_) {}
      if (ok) { try { kickOutbox(); } catch (_) {} }   // a proven-healthy send is the cue to drain any backlog
      // The adapter acknowledged this message only after its durable INBOX receipt existed. If the failed answer
      // cannot enter the outbox, reject processing so that receipt remains and replays once capacity returns.
      // `heldText` is the remainder the outbox refused: processInbound keeps it on that receipt (deliverHeld), so the
      // replay sends this finished answer instead of running the message a second time.
      if (mustPersistFailure && !failurePersisted) {
        const err = new Error('failed reply could not be persisted: ' + ((failurePersistError && failurePersistError.message) || 'outbox unavailable'));
        err.heldText = parts.raw.slice(failedAt).join('');
        throw err;
      }
      // `text` is the FINAL chunk's text — the one a keyboard was attached to, and therefore the exact string a
      // later editMessage must rebuild on top of when it stamps the chosen answer in place.
      return { ok: ok, messageId: messageId, text: chunks.length ? chunks[chunks.length - 1] : '' };
    }

    // ---- durable-outbox flush: redeliver queued replies once the transport is healthy ----------------------
    // Triggered by (a) the adapter reporting 'up' (reconnect/restart recovery) and (b) any successful deliver
    // (covers a mid-session send failure while the poll status never dropped). One pass at a time; a failed
    // redelivery bumps the item's try-count and STOPS the pass (transport clearly still shaky) — the item is
    // Retained until delivery succeeds or Telegram proves the chat unreachable. At five failures we emit one
    // escalation event, but keep retrying at the capped cadence — a two-minute outage must not become message loss.
    const OUTBOX_ESCALATE_TRIES = 5;
    let flushing = false;
    let outboxTimer = null;
    let closed = false;
    function pendingOutbox() {
      try { return typeof store.loadOutbox === 'function' ? (store.loadOutbox(channel) || []) : []; }
      catch (_) { return []; }
    }
    function scheduleOutboxRetry() {
      if (closed || outboxTimer || typeof store.loadOutbox !== 'function') return;
      const items = pendingOutbox();
      if (!items.length) return;
      const tries = Math.max(0, Number(items[0] && items[0].tries) || 0);
      const delay = Math.min(outboxRetryMs * Math.pow(2, Math.min(tries, 8)), outboxRetryMaxMs);
      outboxTimer = setTimer(() => {
        outboxTimer = null;
        Promise.resolve(flushOutbox()).catch(function () {});
      }, delay);
      if (outboxTimer && typeof outboxTimer.unref === 'function') outboxTimer.unref();
    }
    function kickOutbox() {
      if (closed) return;
      if (outboxTimer) { try { clearTimer(outboxTimer); } catch (_) {} outboxTimer = null; }
      const p = flushOutbox();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
    async function flushOutbox() {
      if (closed || flushing || typeof store.loadOutbox !== 'function') return;
      flushing = true;
      try {
        const items = store.loadOutbox(channel);
        for (const it of items) {
          // A chat that blocked us cannot be redelivered to. onMembership already drops its backlog, but a flush
          // racing that drop would otherwise spend a failed send per item and then stop the whole pass.
          let dead = false;
          try { const r0 = typeof store.getChatRecord === 'function' ? store.getChatRecord(String(it.chatId)) : null; dead = !!(r0 && r0.unreachable); } catch (_) {}
          if (dead) { try { store.removeOutbox(it.id); } catch (e) { failNote('channels.hub.outbox.remove', e); } continue; }
          const parts = chunkTextParts(it.text, maxMessageLength);
          const chunks = parts.send;
          let ok = true, sentUpTo = 0;
          for (let ci = 0; ci < chunks.length; ci++) {
            let r;
            // Thread only, never the quote: a delayed reply still belongs in its topic, but the message it was
            // answering is hours old and quoting it now would read as a bot talking to the past.
            try { r = await send(it.chatId, chunks[ci], routeOpts(it.chatId, false) || undefined); } catch (e) { r = { ok: false }; }
            if (!r || r.ok === false) { ok = false; break; }
            sentUpTo = ci + 1;
          }
          if (ok) {
            try { store.removeOutbox(it.id); } catch (e) { failNote('channels.hub.outbox.remove', e); }
            const ev = { channel, chatId: String(it.chatId), runId: it.runId || '', ok: true, chunks: chunks.length, reason: 'redelivered' };
            if (it.agentId) ev.agentId = String(it.agentId);
            try { emit('channel.delivery', ev); } catch (_) {}
            continue;
          }
          // PROGRESS: chunks the member already received must never be re-sent — a flaky transport used to
          // replay the first two-thirds of a long answer on every retry pass. The remainder is rebuilt from
          // the RAW (undecorated) splits: joining the fence-doctored send chunks baked reopenFences's
          // synthetic ``` markers into the stored text, which the next pass re-fenced — stray fence lines
          // growing per retry on every long code-bearing reply.
          if (sentUpTo > 0 && typeof store.replaceOutboxText === 'function') {
            try { store.replaceOutboxText(it.id, parts.raw.slice(sentUpTo).join('')); } catch (e) { failNote('channels.hub.outbox.progress', e); }
          }
          // A pass that delivered real chunks is PROGRESS, not another failed attempt — it must not count
          // toward the escalation ceiling, or a long message advancing one chunk per pass reads as failing.
          let bumped = null;
          if (sentUpTo === 0) {
            try { bumped = (typeof store.bumpOutboxTry === 'function') ? store.bumpOutboxTry(it.id) : null; } catch (e) { failNote('channels.hub.outbox.bump', e); }
          }
          if (bumped && bumped.tries === OUTBOX_ESCALATE_TRIES) {
            try { emit('channel.delivery', { channel, chatId: String(it.chatId), runId: it.runId || '', ok: false, chunks: 0, reason: 'redelivery-delayed' }); } catch (_) {}
            try { console.error('[' + channel + '] outbox item for chat ' + it.chatId + ' still delayed after ' + OUTBOX_ESCALATE_TRIES + ' attempts; retained for retry'); } catch (_) {}
          }
          break;   // transport still unhealthy — end this pass; the next healthy cue retries
        }
      } finally {
        flushing = false;
        if (pendingOutbox().length) scheduleOutboxRetry();
        else {
          // Capacity is back. Replay intake deliberately held when a saturated outbox could not accept its reply.
          try { const p = recoverInbox(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {}
        }
      }
    }

    function close() {
      closed = true;
      if (outboxTimer) { try { clearTimer(outboxTimer); } catch (_) {} outboxTimer = null; }
    }

    /* GROUP ADMISSION lives on the chat's own record, like /mention and /approvals: the adapter's allow-list reads
       this per message, so /allow and /deny take effect on the next one and survive a restart. The value is the
       CHANNEL id, not a bare flag, because the station bot and the Discord/Slack/Matrix/Signal hubs share one
       chat map keyed by chat id alone — admitting a chat on one platform must never admit a chat that happens to
       carry the same id on another. (An agent-bound bot's store is already namespaced per bot.) */
    function chatAdmitted(chatId) {
      if (typeof store.getChatRecord !== 'function') return false;
      try { const r = store.getChatRecord(String(chatId)); return !!(r && r.admittedOn === channel); }
      catch (_) { return false; }
    }

    // '/version', '/v@starnetbot args' -> { name, line } when the injected registry check knows the name, else null
    // (the same head grammar parseUserCommand reads: "/tmp/notes.md" is a path, never a command)
    function parseDesktopCommand(text) {
      const s = String(text == null ? '' : text).trim();
      const m = /^\/([A-Za-z0-9_-]+)(?:@[A-Za-z0-9_]+)?(?=\s|$)/.exec(s);
      if (!m) return null;
      const name = m[1].toLowerCase();
      let known = false;
      try { known = desktopCommandFn(name) === true; } catch (e) { failNote('channels.hub.desktopCommand', e); known = false; }
      if (!known) return null;
      const rest = s.slice(m[0].length).trim();
      return { name: name, line: '/' + name + (rest ? ' ' + rest : '') };
    }

    // Resolve which agent a chat is currently bound to, from the SAME precedence run resolution uses (minus the
    // live floor plan, which is content-per-message and not a stable "who am I talking to"). Used by /agents,
    // /talk confirmations, and /model to name the target honestly.
    function ownerOnlyReply(label) {
      return '⚠ ' + label + ' is owner-only on this station — only the paired owner can use it. You can still talk to the agent here.';
    }

    function currentBoundAgent(chatId, boundAgentId, sec) {
      if (boundAgentId) return boundAgentId;
      if (sec && sec.agentId && AID_RE.test(String(sec.agentId))) return String(sec.agentId);
      return agentIdFor(chatId);
    }

    // Handle a parsed control command. Every reply states what ACTUALLY happened (truthful telemetry): a rebind
    // only claims success after saveChatRecord returns; a model change only confirms after setModel reports ok.
    // boundRec is this chat's persisted record (or null) — /approvals reads its opt-in flag and writes it back.
    // chatType (optional, additive) — only /mention needs it, to say honestly that the setting is group-only
    // rather than storing a value that can never apply in a DM. `ownerTrusted` is host-minted at ingress and is
    // forwarded to the shared slash registry so its /tools answer matches this owner DM's actual run authority.
    async function handleCommand(chatId, parsed, boundAgentId, sec, boundRec, chatType, ownerTrusted) {
      const cmd = parsed.cmd, arg = parsed.arg;
      // rosterFn is an INJECTED callback (Discord/other wire-ups pass it straight through); a throwing roster must
      // degrade to a logged error + polite reply, never an unhandled rejection that swallows the whole inbound.
      let roster;
      try { roster = rosterFn ? (rosterFn() || []) : null; }
      catch (e) { try { console.error('[' + channel + '] roster lookup threw in /' + cmd + ':', (e && e.message) || e); } catch (_) {} await deliver(chatId, '⚠ Could not read the agent roster right now — try again in a moment.', '', 'error'); return; }
      const boundId = currentBoundAgent(chatId, boundAgentId, sec);
      // NOTE: no dedicated channel.command/rebind/model bus events — shared/events.js is owned by another
      // workstream (additive-only, by request). The command's honest confirmation is the reply itself; the
      // downstream binding/roster writes are observable in the chatmap + roster files. See report.

      if (cmd === 'help') {
        await deliver(chatId, helpText(), '', 'command');
        return;
      }

      /* /start — the FIRST thing every Telegram user ever sends: the client shows a START button on a fresh
         chat and sends this literal text when it is pressed. It was in no command table, so it fell through
         parseCommand as an ordinary message, SPENT A PAID MODEL RUN, and the member's first ever exchange with
         the station was an agent puzzling over the word "/start". Answered here, for free, with the one thing
         a newcomer actually needs: who they are talking to and what they can say. */
      if (cmd === 'start') {
        const me = (roster || []).find(x => String(x.agentId) === String(boundId));
        const who = me ? (me.name || me.agentId) : boundId;
        await deliver(chatId,
          'STARNET online — you are talking to ' + who + '.\n\n'
          + 'Just say what you need in plain language and I will get on it. I can search and read the web, '
          + 'work with your files, remember things for you, and run scheduled work.\n\n'
          + helpText(), '', 'command');
        return;
      }

      // ---- SHARED SLASH COMMANDS (/usage /tools /routine /away) ----------------------------------------
      // Executed by the sidecar's own registry, so what you read on your phone is what you'd read on the
      // desktop — the same text from the same code, not a second implementation that drifts. A card-shaped
      // reply (title + lines) is flattened to plain text: Telegram has no card.
      if (SLASH_CMDS[cmd]) {
        if (!runSlashFn) { await deliver(chatId, '⚠ ' + '/' + cmd + ' is not available on this channel.', '', 'command'); return; }
        let r;
        // deliveryOrigin: the SAME shape a run from this chat carries (runOnce below), so a "/routine add" typed here
        // reports back to this chat exactly like a routine the agent creates when asked in words (bug 3b958e41)
        const sctx = { agentId: boundId, ownerTrusted: !!ownerTrusted,
          deliveryOrigin: { channel: channel, chatId: String(chatId), threadId: (routes.get(String(chatId)) || {}).threadId || null } };
        try { r = await runSlashFn('/' + cmd + (arg ? ' ' + arg : ''), sctx); }
        catch (e) { try { console.error('[' + channel + '] /' + cmd + ' threw:', (e && e.message) || e); } catch (_) {} r = null; }
        if (!r) { await deliver(chatId, '⚠ Could not run /' + cmd + ' right now — try again in a moment.', '', 'command'); return; }
        const body = (r.lines && r.lines.length)
          ? ((r.title ? r.title + '\n' : '') + r.lines.join('\n'))
          : String(r.text || '');
        await deliver(chatId, body || ('/' + cmd + ' had nothing to report.'), '', 'command');
        return;
      }

      // ---- /stop — abort the run this CHAT has in flight -------------------------------------------------
      // Only this hub can do it: it owns the inflight record (chatId -> { runId, abort, ... }). Marked
      // superseded first so the run's own teardown stays quiet rather than reporting a failure you caused.
      if (cmd === 'stop') {
        const live = inflight.get(chatId);
        if (!live) { await deliver(chatId, 'Nothing is running for this chat right now.', '', 'command'); return; }
        live.superseded = true;
        let aborted = false;
        try { live.abort.abort(); aborted = true; } catch (_) { aborted = false; }
        await deliver(chatId, aborted ? 'Stopped the run in progress.' : '⚠ Could not stop that run — it may already be finishing.', '', 'command');
        return;
      }

      // ---- /new — forget this chat's transcript ----------------------------------------------------------
      // A browser chat can start over because its history lives in localStorage. A messaging chat has no
      // browser: the store file IS the conversation, so this is the only way to start fresh. It refuses while
      // a run is in flight — clearing the history under a live run would strand it mid-conversation.
      if (cmd === 'new') {
        if (inflight.get(chatId)) { await deliver(chatId, 'A run is still going — send /stop first, then /new.', '', 'command'); return; }
        if (!store || typeof store.clearHistory !== 'function') { await deliver(chatId, '⚠ Clearing history is not available on this channel.', '', 'command'); return; }
        let dropped = 0;
        try { dropped = store.clearHistory(boundId); }
        catch (e) { await deliver(chatId, '⚠ Could not clear this chat: ' + ((e && e.message) || 'the write failed') + '.', '', 'command'); return; }
        // the work line's per-chat hop histories start fresh too (hopHistoryKey)
        try {
          const rec = typeof store.getChatRecord === 'function' ? store.getChatRecord(chatId) : null;
          for (const k of (rec && Array.isArray(rec.hopKeys) ? rec.hopKeys : [])) if (typeof k === 'string' && AID_RE.test(k)) dropped += store.clearHistory(k) || 0;
        } catch (e) { failNote('channels.hub.hopKeys.clear', e); }
        /* A RUN READS ITS HISTORY FROM THE CANONICAL STREAM (historyFor), not from the store file above: clearing only the
           file answered "I no longer remember" while the next run replayed up to 100 turns of the old chat, taint and all
           (2026-10-20). Move the chat onto a fresh stream, as /new does in COMMS; the old one stays in the station's
           history, it is just never replayed again. */
        const oldStream = (historyFor && typeof store.saveChatRecord === 'function') ? resolvedStreamId(chatId) : null;
        if (oldStream && !streamIdFor) {
          try { dropped = Math.max(dropped, (historyFor(oldStream, boundId) || []).length); } catch (e) { failNote('channels.hub.new.count', e); }
          const tail = '_n' + String(newId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
          const base = ('channel_' + channel + '_' + String(chatId)).replace(/[^A-Za-z0-9_-]/g, '_');
          try { store.saveChatRecord(chatId, { streamId: base.slice(0, 64 - tail.length) + tail }); }
          catch (e) { await deliver(chatId, '⚠ Could not start this chat fresh: ' + ((e && e.message) || 'the write failed') + '.', '', 'command'); return; }
        }
        await deliver(chatId, dropped
          ? ('Cleared ' + dropped + ' message' + (dropped === 1 ? '' : 's') + ' — this chat starts fresh. I no longer remember what we discussed.')
          : 'Nothing to clear — this chat had no history yet.', '', 'command');
        return;
      }

      // ---- /status — what is this chat doing RIGHT NOW ---------------------------------------------------
      // Reads only live in-memory state + the stored transcript, so it can never claim a run that isn't there.
      if (cmd === 'status') {
        const live = inflight.get(chatId);
        const bits = [];
        if (live) {
          // only quote a duration when BOTH a clock and a start stamp exist — a hub built without a clock
          // (unit wire-ups) must say it is working, never invent an elapsed time.
          const t = now ? now() : 0;
          bits.push((t && live.startedAt)
            ? ('Working — ' + Math.max(0, Math.round((t - live.startedAt) / 1000)) + 's so far.')
            : 'Working on something right now.');
        } else bits.push('Idle — nothing running.');
        const me = (roster || []).find(x => String(x.agentId) === String(boundId));
        bits.push('Agent: ' + (me ? (me.name || me.agentId) : boundId) + (me && me.model ? ' (' + me.model + ')' : ''));
        let turns = 0;
        try { turns = (store && typeof store.loadHistory === 'function') ? store.loadHistory(boundId).length : 0; } catch (_) { turns = 0; }
        bits.push('History: ' + turns + ' message' + (turns === 1 ? '' : 's') + ' remembered.');
        bits.push('Approve/deny buttons: ' + ((boundRec && boundRec.approvals) ? 'ON' : 'OFF') + '.');
        await deliver(chatId, bits.join('\n'), '', 'command');
        return;
      }

      // /approvals [on|off] — the per-chat opt-in for approve/deny buttons. DEFAULT OFF: with it off this chat
      // runs surface:'autonomous' exactly as before (an ungranted write default-denies and the run continues,
      // never stalling). Turning it ON switches the chat to surface:'interactive', so an ungranted write pauses
      // and asks you here — which also means an UNANSWERED prompt holds that run until the host's fail-closed
      // consent timeout denies it. Both halves of that trade are stated to the user, never just the upside.
      if (cmd === 'approvals') {
        const canPrompt = buttonsOk && !!askConsent && !!resolveConsent;
        const on = !!(boundRec && boundRec.approvals);
        if (!arg) {
          await deliver(chatId, canPrompt
            ? ('Approve/deny buttons are ' + (on ? 'ON' : 'OFF') + ' for this chat.\n'
               + (on ? 'When I need permission to write a file or run a tool, I\'ll ask you here with buttons.\nSend /approvals off to go back to silently skipping those actions.'
                     : 'Right now I silently skip any action that needs permission and carry on.\nSend /approvals on to be asked here instead.'))
            : '⚠ Approve/deny buttons are not available on this channel.', '', 'command');
          return;
        }
        const want = /^(on|yes|enable|enabled|true|1)$/i.test(arg) ? true : (/^(off|no|disable|disabled|false|0)$/i.test(arg) ? false : null);
        if (want === null) { await deliver(chatId, 'Usage: /approvals on  ·  /approvals off', '', 'command'); return; }
        if (want && !canPrompt) { await deliver(chatId, '⚠ Approve/deny buttons are not available on this channel — leaving them off.', '', 'command'); return; }
        // truthful telemetry: only claim the setting changed once the durable write actually returned.
        let saved = false;
        try { if (typeof store.saveChatRecord === 'function') { store.saveChatRecord(chatId, { approvals: want }); saved = true; } } catch (_) { saved = false; }
        if (!saved) { await deliver(chatId, '⚠ Could not save that — approve/deny buttons are still ' + (on ? 'ON' : 'OFF') + ' for this chat.', '', 'command'); return; }
        await deliver(chatId, want
          ? 'Approve/deny buttons are ON. I\'ll ask here before any action that needs permission — if you don\'t answer, that action is denied and the run moves on.'
          : 'Approve/deny buttons are OFF. I\'ll silently skip actions that need permission and carry on.', '', 'command');
        return;
      }

      /* GROUP MENTION GATE — the escape hatch for the discipline that shipped with P3.
         "Answer only when addressed" is the right default (a room with traffic is otherwise a model call per
         message the member is not part of), but it is still a POLICY, and shipping a policy with no way to
         change it is how a helpful bot becomes a mute one with no explanation. The gate itself lives in
         adapter.js and reads this record per message, so a flip takes effect on the very next one.
         DM-only chats say so rather than silently storing a setting that can never apply — a control that
         appears to work and does nothing is worse than one that is honest about being irrelevant. */
      if (cmd === 'mention') {
        const isGroup = String(chatType || '') === 'group';
        const on = !(boundRec && boundRec.requireMention === false);
        const observing = !!(boundRec && boundRec.observeUnmentioned);
        const state = !on ? 'off' : (observing ? 'observe' : 'on');
        const describe = { on: 'answer only when addressed, and forget everything else',
                           observe: 'answer only when addressed, but follow the conversation',
                           off: 'answer every message' };
        /* PRIVACY MODE IS THE HARNESS TELLING US WHAT WE CANNOT HEAR, and two of these three states are a
           promise we cannot keep without it. With privacy ON (Telegram's default) a group delivers us ONLY
           slash commands, @username mentions and replies to our own messages — so "answer everything" and
           "follow the conversation" would both be claims about messages that never arrive, and being called by
           NAME cannot work either, because a name is not an @mention. Say so, with the fix, rather than let the
           member conclude the bot is broken. Silent when we do not know (null): never invent a limitation. */
        const seesAll = privacyOk();
        const blind = (seesAll === false && isGroup)
          ? '\n\n⚠ Telegram is only sending me messages that address me directly (@' + 'mention, a reply to me, or a slash command) — '
            + 'privacy mode is ON for this bot, so I never receive ordinary chatter and cannot be woken by name. '
            + 'Open @BotFather → /setprivacy → Disable to change that.'
          : '';
        if (!arg) {
          await deliver(chatId, isGroup
            ? ('In this group I ' + describe[state] + '.\n\n'
               + '/mention on — only when addressed (@ me, reply to me, call me by name, or use a command)\n'
               + '/mention observe — the same, but I read the rest so I know what you were talking about\n'
               + '/mention off — answer everything here (a real run, and real spend, per message)' + blind)
            : 'This setting only applies to groups — in a direct chat I always answer you.', '', 'command');
          return;
        }
        const want = /^(on|yes|enable|enabled|true|1)$/i.test(arg) ? 'on'
          : (/^(off|no|disable|disabled|false|0)$/i.test(arg) ? 'off'
          : (/^(observe|watch|listen|follow|context)$/i.test(arg) ? 'observe' : null));
        if (want === null) { await deliver(chatId, 'Usage: /mention on  ·  /mention observe  ·  /mention off', '', 'command'); return; }
        // never confirm a promise this hub cannot keep (see observeTurn): nothing is saved, so nothing changes
        if (want === 'observe' && !observeKept()) { await deliver(chatId, '⚠ This channel cannot keep what I overhear, so /mention observe is not available here — I still ' + describe[state] + '.', '', 'command'); return; }
        // requireMention and observeUnmentioned are written TOGETHER, always. Two independent toggles would let a
        // chat end up "answer everything AND observe", which would file every message twice.
        const patch = { requireMention: want !== 'off', observeUnmentioned: want === 'observe' };
        let saved = false;
        try { if (typeof store.saveChatRecord === 'function') { store.saveChatRecord(chatId, patch); saved = true; } } catch (_) { saved = false; }
        if (!saved) { await deliver(chatId, '⚠ Could not save that — I still ' + describe[state] + ' here.', '', 'command'); return; }
        const confirm = {
          on: 'From now on I answer only when addressed here — @-mention me, reply to me, call me by name, or use a slash command. I will not keep any of the other messages.',
          observe: 'From now on I still answer only when addressed, but I read the rest of the room so I know what you were talking about. Those messages cost nothing — no model call, just context.',
          off: 'From now on I answer every message in this chat. Each one is a real run, so watch the spend.'
        };
        // The caveat rides the two states that actually depend on hearing unaddressed messages. "on" is exactly
        // what privacy mode already enforces, so warning about it there would be noise.
        await deliver(chatId, confirm[want] + ((want === 'observe' || want === 'off') ? blind : ''), '', 'command');
        return;
      }

      /* /allow and /deny — the owner opens or closes a GROUP from inside it (owner:'always', so the gate above has
         already refused anyone else). The confirmation says who can talk now and what it costs, because admitting
         a room hands every member a way to start real runs on the owner's station. A direct chat is always open
         to the owner and closed to everyone else, so the command says that instead of storing a setting that can
         never apply. Only claimed once the durable write returned (truthful telemetry). */
      if (cmd === 'allow' || cmd === 'deny') {
        if (String(chatType || '') !== 'group') {
          await deliver(chatId, '/allow and /deny are for groups — a direct chat with you is always open, and closed to everyone else.', '', 'command');
          return;
        }
        const was = chatAdmitted(chatId);
        const want = cmd === 'allow';
        if (was === want) {
          await deliver(chatId, want
            ? 'This group is already admitted — I answer here when someone addresses me. Send /deny to remove me.'
            : 'I am not answering in this group. Send /allow here to admit it.', '', 'command');
          return;
        }
        let saved = false;
        try { if (typeof store.saveChatRecord === 'function') { store.saveChatRecord(chatId, { admittedOn: want ? channel : '' }); saved = chatAdmitted(chatId) === want; } } catch (_) { saved = false; }
        if (!saved) {
          await deliver(chatId, '⚠ Could not save that — this group is still ' + (was ? 'admitted' : 'not admitted') + '.', '', 'command');
          return;
        }
        if (!want) {
          await deliver(chatId, 'Removed. I will not answer anything in this group until you send /allow here again.', '', 'command');
          return;
        }
        const seesAll = privacyOk();
        const byName = seesAll === false
          ? ''   // privacy mode ON: a name is not an @mention, so it never reaches us — never promise it
          : ', call me by name';
        await deliver(chatId,
          'This group is admitted. Anyone here can now talk to me — @-mention me, reply to me' + byName + ', or use a command — '
          + 'and every answer is a real run on your station. Send /deny to remove me.', '', 'command');
        return;
      }

      if (cmd === 'agents' || cmd === 'whoami') {
        if (!roster || !roster.length) { await deliver(chatId, 'No roster is available to this channel yet.', '', 'command'); return; }
        if (cmd === 'whoami') {
          const me = roster.find(a => String(a.agentId) === String(boundId));
          await deliver(chatId, me ? ('You are talking to ' + fmtAgentLine(me, boundId).trim()) : ('This chat is bound to "' + boundId + '" (not in the current roster).'), '', 'command');
          return;
        }
        const lines = roster.map(a => fmtAgentLine(a, boundId));
        await deliver(chatId, 'Agents (' + roster.length + '):\n' + lines.join('\n') + '\n\n/talk <name> to switch · /model to change model', '', 'command');
        return;
      }

      if (cmd === 'talk') {
        if (!roster || !roster.length) { await deliver(chatId, 'No roster is available to this channel yet — cannot switch agents.', '', 'command'); return; }
        if (!arg) { await deliver(chatId, 'Usage: /talk <name>. ' + roster.length + ' available:\n' + roster.map(a => '  ' + (a.name || a.agentId)).join('\n'), '', 'command'); return; }
        const m = matchAgent(roster, arg);
        if (!m) { await deliver(chatId, 'No agent matches "' + arg + '". Available:\n' + roster.map(a => '  ' + (a.name || a.agentId)).join('\n'), '', 'command'); return; }
        if (m.ambiguous) { await deliver(chatId, '"' + arg + '" matches several agents — be more specific:\n' + m.ambiguous.map(a => '  ' + (a.name || a.agentId)).join('\n'), '', 'command'); return; }
        const target = m.agent;
        // Persist the rebind. Only confirm the switch if the write actually succeeded (truthful telemetry).
        let saved = false;
        try { if (typeof store.saveChatRecord === 'function') { store.saveChatRecord(chatId, { agentId: String(target.agentId), channel: channel }); saved = true; } } catch (_) { saved = false; }
        if (!saved) { await deliver(chatId, '⚠ Could not persist the switch to "' + (target.name || target.agentId) + '" — this chat is still talking to the previous agent.', '', 'command'); return; }
        const nm = target.name && target.name !== target.agentId ? (target.name + ' (' + target.agentId + ')') : target.agentId;
        await deliver(chatId, 'Now talking to ' + nm + ' — model: ' + (target.model || 'not set') + '.', '', 'command');
        return;
      }

      if (cmd === 'model') {
        if (!roster || !roster.length) { await deliver(chatId, 'No roster is available to this channel yet — cannot read or change models.', '', 'command'); return; }
        const me = roster.find(a => String(a.agentId) === String(boundId));
        if (!me) { await deliver(chatId, 'This chat is bound to "' + boundId + '", which is not in the current roster — /talk to pick an agent first.', '', 'command'); return; }
        if (!arg) { await deliver(chatId, (me.name || me.agentId) + '\'s current model: ' + (me.model || 'not set') + '.\nSend /model <id> to change it.', '', 'command'); return; }
        // Validate against the model catalog when one is reachable sidecar-side; otherwise accept and be honest
        // that no catalog was available to check against.
        let catalog = null;
        try { catalog = modelCatalogFn ? (modelCatalogFn() || null) : null; } catch (_) { catalog = null; }
        if (Array.isArray(catalog) && catalog.length && catalog.indexOf(arg) === -1) {
          const near = catalog.filter(id => String(id).toLowerCase().indexOf(arg.toLowerCase()) !== -1).slice(0, 8);
          await deliver(chatId, '"' + arg + '" is not in the available model catalog.' + (near.length ? ('\nDid you mean:\n' + near.map(x => '  ' + x).join('\n')) : ''), '', 'command');
          return;
        }
        if (!setModelFn) { await deliver(chatId, '⚠ Model changes are not available on this channel (no roster write path wired).', '', 'command'); return; }
        let r; try { r = setModelFn(String(me.agentId), arg); } catch (e) { r = { ok: false, error: (e && e.message) || 'write threw' }; }
        if (!r || r.ok === false) { await deliver(chatId, '⚠ Could not change the model — ' + ((r && r.error) || 'roster write failed') + '. It is still ' + (me.model || 'not set') + '.', '', 'command'); return; }
        await deliver(chatId, (me.name || me.agentId) + '\'s model is now ' + (r.model || arg) + ' (saved to the roster).', '', 'command');
        return;
      }
    }

    // Turn one inbound media list into { attachments:[ref…], notes:[line…] } — download each item, park the bytes
    // in the agent's workspace .attachments/ (same jail as browser uploads), and describe what happened HONESTLY.
    // Per-item degrade: a failed download/save becomes a note the model reads, never a silent drop and never a
    // crashed inbound. Videos/audio/documents get a note naming their saved workspace path so the agent can reach
    // the file with its tools; a photo needs no note (the model literally sees it as an image block).
    async function ingestMedia(agentId, media) {
      const refs = [], notes = [], transcripts = [];
      const items = media.slice(0, MAX_MEDIA_PER_MESSAGE);
      if (media.length > items.length) notes.push('[' + (media.length - items.length) + ' additional file(s) in this message were not ingested — resend them separately]');
      for (const it of items) {
        const kind = String((it && it.kind) || 'file'), name = String((it && it.name) || 'file');
        // Provenance: an item lifted off the message the user REPLIED TO must say so, or the model reads a photo
        // from three messages ago as something just sent and answers the wrong question.
        const from = (it && it.fromReply) ? ' (from the quoted message they replied to)' : '';
        if (!fetchMedia || !saveAttachmentFn) { notes.push('[the user sent a ' + kind + ' ("' + name + '")' + from + ' but media ingest is not wired on this channel]'); continue; }
        if (Number(it.size) > MAX_MEDIA_BYTES) { notes.push('[' + kind + ' "' + name + '"' + from + ' is too large to ingest (' + Math.round(Number(it.size) / (1024 * 1024)) + 'MB > 8MB) — ask the user for a smaller version]'); continue; }
        let got; try { got = await fetchMedia(Object.assign({}, it, { maxBytes: MAX_MEDIA_BYTES })); } catch (e) { got = { ok: false, error: (e && e.message) || 'download threw' }; }
        if (!got || got.ok === false || !got.buffer || !got.buffer.length) { notes.push('[could not download the ' + kind + ' "' + name + '"' + from + ' from ' + channel + ': ' + ((got && got.error) || 'unknown error') + ']'); continue; }
        const dataUrl = 'data:' + (String(it.mime || '') || 'application/octet-stream') + ';base64,' + Buffer.from(got.buffer).toString('base64');
        let saved; try { saved = await saveAttachmentFn(agentId, name, dataUrl); } catch (e) { saved = { ok: false, error: (e && e.message) || 'save threw' }; }
        if (!saved || saved.ok === false) { notes.push('[could not store the ' + kind + ' "' + name + '"' + from + ': ' + ((saved && saved.error) || 'unknown error') + ']'); continue; }
        refs.push({ id: saved.id, name: saved.name, path: saved.path, mediaType: saved.mediaType, kind: saved.kind, srcKind: kind });
        if (saved.kind !== 'image') notes.push('[' + kind + ' "' + name + '"' + from + ' received and saved to ' + saved.path + ' in your workspace]');
        else if (from) notes.push('[the image "' + name + '"' + from + ' is attached to this turn]');

        /* VOICE NOTES WERE DEAD INPUT. We saved the .ogg and told the model "saved to <path>" — a path it
           cannot hear — while the station has owned an STT engine the whole time. Transcribe here, where the
           bytes already are, so a member can hold the button and talk to their agent from a phone.

           Only a real voice note (it.voice, set by the platform's normalize) is transcribed: a forwarded music
           file is audio too, and burning an STT call on it would be spend with no meaning. A failure is a NOTE,
           never a lost turn — the file is already saved and referenced, so the run continues exactly as before
           this feature existed. */
        if (it.voice && transcribe) {
          let tr;
          try { tr = await transcribe(got.buffer, String(it.mime || 'audio/ogg'), name); }
          catch (e) { tr = { ok: false, reason: (e && e.message) || 'transcribe threw' }; }
          if (tr && tr.ok && String(tr.text || '').trim()) transcripts.push(String(tr.text).trim());
          else if (tr && tr.ok) notes.push('[the voice message "' + name + '" contained no speech we could make out — ask them to resend it]');
          else notes.push('[the voice message "' + name + '" could not be transcribed (' + ((tr && tr.reason) || 'no transcription engine configured') + ') — the audio file is saved at ' + saved.path + ', and you can ask them to type it instead]');
        }
      }
      // truthful cross-reference: only claim a visible video still when BOTH the clip and its frame actually saved
      if (refs.some(r => r.srcKind === 'video') && refs.some(r => r.kind === 'image' && /preview-frame/.test(String(r.name)))) {
        notes.push('[the attached image named *-preview-frame.jpg is a still frame from the video above]');
      }
      // counter the analyze-tool reflex: models that CAN see the attached image sometimes still reach for a
      // separate vision tool (and then ask the user for an API key when it isn't configured). Say plainly that
      // the pixels are already in this message. (Live-observed 2026-07-22: gemini called image_analyze on an
      // image it could see directly.)
      if (refs.some(r => r.kind === 'image')) {
        notes.push('[the image(s) are attached inside this message — look at them directly; no vision tool or extra API key is needed]');
      }
      for (const r of refs) delete r.srcKind;   // keep the stored/history reference shape identical to browser uploads
      return { attachments: refs, notes: notes, transcripts: transcripts };
    }

    /* One or more voice notes, rendered as the words the member actually said.

       FENCED AND LABELLED, on purpose. A transcript is a MACHINE's reading of speech: it mishears names, it
       drops negations, and an agent that quotes it back as verbatim user text will eventually put words in the
       Commander's mouth. Naming it as a transcription is what lets the model hedge when the text reads oddly —
       and it is the difference between "you said X" and "I heard X". */
    function transcriptBlock(list) {
      const arr = (Array.isArray(list) ? list : []).filter(t => String(t || '').trim());
      if (!arr.length) return '';
      const head = arr.length === 1
        ? '[voice message, transcribed automatically — this is what they said, but transcription can mishear]'
        : '[' + arr.length + ' voice messages, transcribed automatically — this is what they said, but transcription can mishear]';
      return head + '\n' + arr.map(t => '"' + String(t).trim() + '"').join('\n');
    }

    /* File an overheard group message in the transcript the agent will replay next time it IS addressed.
       Attributed exactly like a real group turn ("Ana: …"), because the whole value is knowing who said what.
       Bounded for free: the store's appendTurn trims by turn count and characters, so a busy room cannot grow
       the history without limit. A message with no words (a bare photo, a sticker) teaches the room nothing and
       is skipped rather than filed as an empty turn. */
    function observeTurn(chatId, msg, boundAgentId, sec) {
      const body = String(msg.text || '').trim();
      if (!body) return;
      const who = String(msg.userName || '').trim();
      const agentId = currentBoundAgent(chatId, boundAgentId, sec);
      const line = who ? (who + ': ' + body) : body;
      try { store.appendTurn(agentId, 'user', line); } catch (e) { failNote('channels.hub.appendTurn', e); }
      /* THE RUN READS THE CANONICAL STREAM (historyFor), not the store file above — filed only there, the overheard room
         never reached the model and "I read the rest of the room" was a promise nobody kept. Filed into the SAME stream
         the next addressed run replays, with the provenance an addressed message from this room would carry: clean,
         unless it is a forwarded third party's words (initialTaint's rule below). */
      if (historyFor && observeInto) {
        const sid = resolvedStreamId(chatId);
        if (sid) { try { observeInto(sid, agentId, line, carriesThirdPartyText(msg) ? 'forwarded message' : null); } catch (e) { failNote('channels.hub.observeInto', e); } }
      }
    }
    // can an overheard line reach the model on this hub? (legacy history is what a hub without historyFor replays)
    function observeKept() { return !historyFor || !!observeInto; }

    // ---- ALBUM (media-group) BATCHING --------------------------------------------------------------------
    // A Telegram album arrives as N SEPARATE messages sharing one media_group_id (caption usually on only one).
    // Without batching, our one-run-per-conversation rule makes each part ABORT the previous part's run — a
    // 5-photo album became 4 supersedes + a final run that saw one photo. Debounce parts per (chatId, groupId):
    // each arrival re-arms a short wait; when the album goes quiet, ONE merged message (all media + the caption)
    // takes the normal path. Deterministic: the wait rides the injected `sleep`; no clocks read.
    const ALBUM_WAIT_MS = Number.isFinite(o.albumWaitMs) ? Math.max(0, o.albumWaitMs) : 800;
    const albums = new Map();   // chatId+'|'+groupId -> { msg (merged), seq, done, resolve }
    // Quick successive text bubbles are one human thought, not competing requests. Batch only plain, non-command
    // text from the same author/topic; media, corrections, commands and cross-speaker group traffic keep their
    // exact existing delivery semantics.
    // The shared hub stays byte-identical for other platforms unless their composition root opts in. Telegram
    // supplies 350ms below; this prevents a platform-specific polish feature from changing generic semantics.
    const TEXT_BATCH_WAIT_MS = Number.isFinite(o.textBatchWaitMs) ? Math.max(0, o.textBatchWaitMs) : 0;
    const textBatches = new Map();

    const activeInbox = new Map();   // durable inbox id -> the one live processing promise (dedupes restart races)
    function inboxId(msg) {
      if (!msg || msg.messageId == null || String(msg.messageId) === '') return '';
      return channel + '|' + String(msg.chatId) + '|' + String(msg.messageId) + (msg.edited ? '|edited' : '');
    }
    function onInbound(msg, intake) {
      const id = inboxId(msg);
      // Older/test stores retain the original behavior. Production's store claim is synchronous and durable,
      // so returning from this function is the exact point the adapter may safely advance Telegram's offset.
      if (!id || typeof store.pushInbox !== 'function' || typeof store.removeInbox !== 'function') return routeInbound(msg, intake);
      // this hub's own claim first, then the store's: a hub this one REPLACED (a reconnect) may still be running it
      const shared = typeof store.liveInbox === 'function' && typeof store.holdInbox === 'function';
      const live = activeInbox.get(id) || (shared ? store.liveInbox(id) : null);
      if (live) {
        if (intake && typeof intake.onAccepted === 'function') { try { intake.onAccepted({ id, durable: true, duplicate: true }); } catch (_) {} }
        return live;
      }
      const receipt = store.pushInbox({ id: id, channel: channel, message: msg });   // throws synchronously -> adapter does NOT ack
      if (intake && typeof intake.onAccepted === 'function') { try { intake.onAccepted({ id, durable: true }); } catch (_) {} }
      // A receipt that already carries an attempt is a RE-DELIVERY of work whose run had started — from recoverInbox,
      // or Telegram handing the same update over again. processInbound decides what that may do (attemptOf, heldOf).
      const routed = withInbox(intake, [id], attemptOf(receipt), heldOf(receipt));
      const running = Promise.resolve().then(() => routeInbound(msg, routed)).then((value) => {
        store.removeInbox(id);   // reply delivered OR its undelivered remainder is now durable in the outbox
        return value;
      }).finally(() => { activeInbox.delete(id); });
      activeInbox.set(id, running);
      if (shared) store.holdInbox(id, running);
      return running;
    }

    /* RECOVERY KNOWS HOW FAR THE RUN GOT (e5ecd6b8, 2026-10-21). The `recovered` flag had no reader: a crash after the
       run had appended a line to a file replayed the whole message as a second identical user turn, the line went in
       twice, and the chat was told "Appended one line". The durable receipt now carries an attempt marker
       (store.markInbox: the run's id once it starts, a count of the tool steps it began), and a re-delivered receipt
       is handled by what that proves, the same split the station's own run recovery makes (COMMS continues a run only
       when nothing uncertain happened, and asks first otherwise):
         no attempt              -> never reached a run: replay it as before
         attempt, 0 tool steps   -> nothing could have happened: run it again, said so, without a second copy of the turn
         attempt, N tool steps   -> something may already be done: do NOT run it again; tell the chat, and leave the next
                                    run in this chat a one-shot note (interruptedAttempt) so a "continue" finishes only
                                    what is left
       The intake copy carries every receipt this message stands for (a merged text batch or album is one run over several
       receipts), so the marker lands on all of them.
       ONLY A REAL RESTART GETS THE CRASH RULE (review, 2026-10-21). A receipt also comes back inside the SAME process:
       the full outbox refused a finished reply (flushOutbox -> recoverInbox replays it once capacity returns), or
       processing threw. Taking that for a crash told the chat "StarNet restarted" when nothing restarted, and — with a
       tool step counted — never delivered the answer the run had finished. So the attempt carries the store's bootId:
       an attempt from THIS process is no restart and replays as before; and a finished reply the outbox refused is kept
       on the receipt (held) and delivered by the replay, whatever process it lands in, without running anything. */
    function attemptOf(receipt) {
      const a = receipt && receipt.attempt;
      if (!a || typeof a !== 'object' || !String(a.runId || '')) return null;
      const here = (store && store.bootId != null) ? String(store.bootId) : '';
      if (here && String(a.boot || '') === here) return null;   // this process left it pending: not a restart
      return { runId: String(a.runId), tools: Math.max(0, Math.floor(Number(a.tools) || 0)) };
    }
    function heldOf(receipt) {
      const h = receipt && receipt.held;
      if (!h || typeof h !== 'object' || typeof h.text !== 'string') return null;
      return { text: h.text, runId: String(h.runId || ''), reason: String(h.reason || ''), agentId: String(h.agentId || ''),
        ids: Array.isArray(h.ids) ? h.ids.filter(x => typeof x === 'string' && x) : [] };
    }
    function withInbox(intake, ids, prior, held) {
      const out = Object.assign({}, intake || {}, { inboxIds: ids.slice() });
      if (prior) out.priorAttempt = prior;
      else delete out.priorAttempt;
      if (held) out.heldReply = held;
      else delete out.heldReply;
      return out;
    }
    function inboxIdsOf(intake) {
      return (intake && Array.isArray(intake.inboxIds)) ? intake.inboxIds.filter(x => typeof x === 'string' && x) : [];
    }
    function clipAsk(text) {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      return t.length > 80 ? t.slice(0, 79) + '…' : t;
    }
    function stepsWord(n) { return n === 1 ? '1 tool step' : n + ' tool steps'; }
    // run ids whose interruption this hub already told the chat about: a merged batch is ONE run over several receipts
    const reportedAttempts = new Set();
    async function reportInterruptedAttempt(chatId, agentId, msg, prior) {
      const runId = String(prior.runId || '');
      if (reportedAttempts.has(runId)) return;
      // the next run in this chat reads this once (interruptedAttemptNote). Counts only — never the message text, which
      // may be a third party's words and has no business in a system prompt.
      if (typeof store.saveChatRecord === 'function') {
        try { store.saveChatRecord(chatId, { interruptedAttempt: { runId: runId, tools: prior.tools } }); }
        catch (e) { failNote('channels.hub.interruptedAttempt.save', e); }
      }
      const ask = clipAsk(msg && msg.text);
      await deliver(chatId, '⚠ StarNet restarted while it was working on ' + (ask ? '"' + ask + '"' : 'your message')
        + '. That attempt had already begun ' + stepsWord(prior.tools) + ', so part of it may already be done. It was NOT run again, '
        + 'so nothing is done twice. Reply "continue" to finish what is left — the next run is told those steps already began.',
        runId, 'interrupted', agentId);
      if (reportedAttempts.size >= 500) reportedAttempts.clear();
      reportedAttempts.add(runId);   // only once it was delivered (or durably queued): a refused notice replays with its receipt
    }
    function interruptedAttemptNote(a) {
      const n = Math.max(0, Math.floor(Number(a && a.tools) || 0));
      return '\n\nHOST NOTE — AN EARLIER REQUEST WAS INTERRUPTED: StarNet restarted while an earlier request in this chat was being '
        + 'worked on, after that attempt had begun ' + stepsWord(n) + '. It was not run again. Any tool result of it in this conversation '
        + 'already happened. If the Commander asks to continue it, finish only what is still missing: never repeat a step whose result '
        + 'is already here, and check the current state before redoing a step whose result is not.';
    }

    async function routeInbound(msg, intake) {
      // work that already had a run is never merged into a newer batch: it is settled on its own, exactly once
      if (intake && (intake.priorAttempt || intake.heldReply)) return processInbound(msg, intake);
      const gid = (msg && msg.mediaGroupId != null && String(msg.mediaGroupId))
        ? (String(msg.chatId) + '|' + String(msg.mediaGroupId)) : '';
      if (gid) return albumInbound(msg, gid, intake);
      if (TEXT_BATCH_WAIT_MS > 0 && textBatchable(msg)) return textInbound(msg, intake);
      return processInbound(msg, intake);
    }

    let recoveringInbox = false;
    async function recoverInbox() {
      if (closed || recoveringInbox || typeof store.loadInbox !== 'function') return;
      recoveringInbox = true;
      try {
        const items = store.loadInbox(channel) || [];
        for (const it of items) {
          if (closed || !it || !it.message) break;
          /* THE SNAPSHOT GOES STALE WHILE WE AWAIT. A live item's onInbound hands back its RUNNING promise, so this
             loop can park behind a whole run while a later item (a follow-up steered into that run, a /routine add
             typed meanwhile) finishes on its own path and leaves the inbox — replaying it from this list then ran it
             a second time (2026-10-20). Replay only what is still durably pending right now. */
          let pending = true;
          try { pending = (store.loadInbox(channel) || []).some(x => x && x.id === it.id); } catch (_) { pending = true; }
          if (!pending) continue;
          try { await onInbound(it.message, { recovered: true }); }
          catch (e) { try { console.error('[' + channel + '] durable inbox recovery failed for ' + String(it.id || '') + ':', (e && e.message) || e); } catch (_) {} break; }
        }
      } finally { recoveringInbox = false; }
    }

    // Words the sender did not author (a platform-flagged forward, or a reply quoting one). Arrives under the
    // owner's id, so owner admission cannot see it — the run is tainted instead (2026-09-23 security audit).
    function carriesThirdPartyText(msg) {
      return !!(msg && (msg.forwarded || (msg.replyTo && msg.replyTo.forwarded)));
    }

    function textBatchable(msg) {
      if (!msg || msg.edited || (Array.isArray(msg.media) && msg.media.length)) return false;
      const text = String(msg.text || '').trim();
      // '/allow@thebot' is a command too — it is the form Telegram's "/" menu sends in a group. Without the
      // @suffix here it was batched as chat, and the same member's next bubble inside the window was glued on as
      // the command's ARGUMENT: "@bot are you there?" vanished into a /deny@bot (2026-10-19).
      return !!text && !/^\/[A-Za-z0-9_-]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text);
    }

    async function textInbound(msg, intake) {
      const key = String(msg.chatId) + '|' + String(msg.userId || '') + '|' + String(msg.threadId || '');
      let rec = textBatches.get(key);
      if (!rec) {
        rec = { msg: Object.assign({}, msg), intake: intake, inboxIds: inboxIdsOf(intake), seq: 0, resolve: null, reject: null, done: null };
        rec.done = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
        rec.done.catch(swallow('channels.hub.textBatch.done'));   // the winner never awaits rec.done — keep a loserless rejection handled
        textBatches.set(key, rec);
      } else {
        rec.inboxIds = rec.inboxIds.concat(inboxIdsOf(intake));   // the merged run stands for every bubble's receipt
        const prior = String(rec.msg.text || '').trim();
        const next = String(msg.text || '').trim();
        rec.msg.text = prior && next ? prior + '\n' + next : (prior || next);
        rec.msg.messageId = msg.messageId == null ? rec.msg.messageId : msg.messageId;
        if (carriesThirdPartyText(msg)) rec.msg.forwarded = true;   // one forwarded bubble taints the merged turn
      }
      const mySeq = ++rec.seq;
      await sleep(TEXT_BATCH_WAIT_MS);
      if (textBatches.get(key) !== rec || rec.seq !== mySeq) return rec.done;
      textBatches.delete(key);
      // The batch's outcome must reach EVERY merged bubble: resolving unconditionally told the losing
      // bubbles' durable-inbox wrappers "handled" even when processing threw, so their rows were removed
      // and only the winner's original (unmerged) message survived for recovery — the rest were lost.
      try { await processInbound(rec.msg, withInbox(rec.intake, rec.inboxIds, null, null)); }
      catch (e) { rec.reject(e); throw e; }
      rec.resolve();
    }

    async function albumInbound(msg, gid, intake) {
      let rec = albums.get(gid);
      if (!rec) {
        rec = { msg: Object.assign({}, msg, { media: Array.isArray(msg.media) ? msg.media.slice() : [] }), intake: intake, inboxIds: inboxIdsOf(intake), seq: 0, resolve: null, reject: null, done: null };
        rec.done = new Promise((res, rej) => { rec.resolve = res; rec.reject = rej; });
        rec.done.catch(swallow('channels.hub.albumBatch.done'));   // same handled-rejection guard as the text batch
        albums.set(gid, rec);
      } else {
        rec.inboxIds = rec.inboxIds.concat(inboxIdsOf(intake));   // one run for every part's receipt
        if (Array.isArray(msg.media) && msg.media.length) rec.msg.media = rec.msg.media.concat(msg.media);
        if (!rec.msg.text && msg.text) rec.msg.text = msg.text;   // the caption rides on whichever part carried it
        if (carriesThirdPartyText(msg)) rec.msg.forwarded = true;
      }
      const mySeq = ++rec.seq;
      await sleep(ALBUM_WAIT_MS);
      if (albums.get(gid) !== rec || rec.seq !== mySeq) return rec.done;   // a newer part re-armed the debounce
      albums.delete(gid);
      // Same failure propagation as textInbound: every merged part's durable-inbox row must survive a throw.
      try { await processInbound(rec.msg, withInbox(rec.intake, rec.inboxIds, null, null)); }
      catch (e) { rec.reject(e); throw e; }
      rec.resolve();
    }

    async function processInbound(msg, intake) {
      // the durable receipts this message stands for, and how far an earlier run of it got (attemptOf, above)
      const inboxIds = inboxIdsOf(intake);
      const priorAttempt = (intake && intake.priorAttempt) || null;
      const markAttempt = (patch) => {
        if (!inboxIds.length || typeof store.markInbox !== 'function') return;
        for (const id of inboxIds) { try { store.markInbox(id, patch); } catch (e) { failNote('channels.hub.markInbox', e); } }
      };
      /* A FINISHED ANSWER THE OUTBOX REFUSED IS KEPT, NOT RE-EARNED. deliver throws (heldText = the undelivered
         remainder) so these receipts stay; the text rides on every one of them, and their replay sends it (heldReply,
         below) instead of running the message again — the run already happened, its tool steps included. */
      const heldReply = (intake && intake.heldReply) || null;
      async function deliverHeld(toChat, text, runId, reason, agentId, sendOpts, seedId, ids) {
        try { return await deliver(toChat, text, runId, reason, agentId, sendOpts, seedId); }
        catch (e) {
          if (e && typeof e.heldText === 'string') markAttempt({ held: { text: e.heldText, runId: runId || '', reason: reason || '', agentId: agentId || '', ids: ids } });
          throw e;
        }
      }
      if (msg && msg.directReply) {
        const directChatId = String(msg.chatId);
        noteRoute(msg);
        await deliver(directChatId, String(msg.directReply), '', 'admission');
        return;
      }
      // ADMISSION-ONLY (adapter.js): the owner's /allow or /deny from a group that is not admitted yet. It got past
      // the allow-list only because of what it says, so it may do exactly that and nothing else — never a run,
      // never another command, never a forwarded copy (a third party's words are never a command).
      if (msg && msg.admissionOnly) {
        const p = carriesThirdPartyText(msg) ? null : parseCommand(msg.text);
        if (!p || (p.cmd !== 'allow' && p.cmd !== 'deny')) return;
      }
      const hasMedia = !!(msg && Array.isArray(msg.media) && msg.media.length);
      if (!msg || (!msg.text && !hasMedia)) return;   // empty update; media-only messages ARE admitted
      const chatId = String(msg.chatId);
      // An edit is only a question if it edits the thing we last heard — checked BEFORE noteRoute overwrites the
      // record it reads. Declining is silent by design: the member sees their own edit, and a bot that pipes up
      // about a two-week-old correction is worse than one that stays out of it.
      if (msg.edited && !editIsCurrent(msg)) {
        try { console.log('[' + channel + '] ignoring an edit of an older message in chat ' + chatId); } catch (_) {}
        return;
      }
      // Remember where this came from BEFORE anything can reply — the very first deliver() below (a command
      // answer, a config error) must already land in the right topic, not just the run's final reply.
      noteRoute(msg);
      // the replay of a receipt whose run FINISHED but whose reply the full outbox refused: send that reply, run nothing
      if (heldReply) {
        const ids = heldReply.ids.length ? heldReply.ids : inboxIds;
        await deliverHeld(chatId, heldReply.text, heldReply.runId, heldReply.reason || 'done', heldReply.agentId || undefined, undefined, '', ids);
        // one run answered every receipt in ids (a merged batch): the others must not send it again
        if (typeof store.removeInbox === 'function') {
          for (const sid of ids) { if (inboxIds.indexOf(sid) < 0) { try { store.removeInbox(sid); } catch (e) { failNote('channels.hub.heldReply.remove', e); } } }
        }
        return;
      }
      /* THEY ARE BACK. A chat marked unreachable (we were blocked or kicked) has just spoken, which is proof the
         block is over — clear the flag here rather than waiting for a `my_chat_member` we may never be sent.
         A stale unreachable flag would suppress this chat's outbox forever, which is the failure mode that made
         the flag worth having in the first place, pointed the other way. */
      if (typeof store.getChatRecord === 'function' && typeof store.saveChatRecord === 'function') {
        try {
          const rec0 = store.getChatRecord(chatId);
          if (rec0 && rec0.unreachable) store.saveChatRecord(chatId, { unreachable: false });
        } catch (e) { failNote('channels.hub.chatRecord.save', e); }
      }

      // Runtime config (live each message): { key?, model, provider?, agentId?, system? }. When the app supplies the
      // REAL agentId + composed system prompt at connect, Telegram runs as the SAME agent as in the app —
      // same notebook (memory), workspace, and identity — just a different session. Absent config falls back
      // to a per-chat agent (tg_<chatId>) + the default persona.
      // secrets() is an INJECTED callback; a throwing one (e.g. a store hiccup) must degrade to a logged error +
      // polite reply rather than an unhandled rejection (onInbound is driven fire-and-forget by the adapter).
      let sec;
      try { sec = secrets() || {}; }
      catch (e) { try { console.error('[' + channel + '] secrets() threw in onInbound:', (e && e.message) || e); } catch (_) {} try { await deliver(chatId, '⚠ Could not read the channel configuration right now — try again in a moment.', '', 'error'); } catch (_) {} return; }
      // The chat's own persisted binding (set by /talk) — the user's explicit choice of which roster agent this
      // chat talks to. Read it once here so both command handling (below) and run resolution can honor it.
      let boundRec = null;
      try { if (bindChats && typeof store.getChatRecord === 'function') boundRec = store.getChatRecord(chatId); } catch (_) {}
      const boundAgentId = (boundRec && boundRec.agentId && AID_RE.test(String(boundRec.agentId))) ? String(boundRec.agentId) : null;
      let ownerTrusted = false;
      try { ownerTrusted = ownerTrustedFor(msg) === true; } catch (_) { ownerTrusted = false; }
      // The bound owner in ANY chat (commands), and the bound owner in a DIRECT chat (Full Power inheritance —
      // a group's context carries other members' words, so only a DM run is purely the owner's).
      let senderIsOwner = false;
      try { senderIsOwner = isOwnerFor(msg) === true; } catch (_) { senderIsOwner = false; }
      const channelSenderOwner = ownerSurface || ownerTrusted || (senderIsOwner && String(msg.chatType || '') === 'dm');

      /* OBSERVE-ONLY: heard, filed, never answered. The mention gate stopped the bot replying to a room it was
         not addressed in, and in doing so gave it amnesia — asked later to "summarise that", it had never seen
         "that". This puts the chatter in the transcript and returns, before ANY of the machinery below: no
         command parsing, no belt crate, no typing bubble, no reaction, no model call. Zero spend by
         construction, not by a check somewhere further down.

         The command parse in particular must stay BELOW this line. An unmentioned "/deploy@someotherbot" is an
         observe verdict, and letting it fall through would have us execute a command aimed at a different bot. */
      if (msg.observeOnly) { observeTurn(chatId, msg, boundAgentId, sec); return; }
      // Per-chat opt-in for approve/deny buttons (/approvals; default OFF). Requires BOTH the user's opt-in AND a
      // channel that can actually render and resolve a keyboard — a chat that opted in but is now running over a
      // transport without buttons must fall back to the safe autonomous floor, never stall on a prompt that
      // physically cannot be answered.
      const wantApprovals = !!(boundRec && boundRec.approvals) && buttonsOk && !!askConsent && !!resolveConsent;

      // Control commands are intercepted BEFORE any run starts — they must never spawn an LLM run. Replies go out
      // through the SAME deliver() path so chunking/limits apply. Channel-agnostic: this lives in the hub, so
      // Telegram/Discord/any future adapter get identical behavior.
      // A FORWARDED "/away on" is a third party's words, not the Commander's command — never parse it as one.
      let parsed = carriesThirdPartyText(msg) ? null : parseCommand(msg.text);
      /* THE COMMANDER'S OWN /allow OR /deny KEEPS RUNNING IN A DM. Both became built-ins in 0.14.0 and the built-ins are
         parsed first, so a command of that name the Commander defined earlier silently stopped running over messaging
         ("/allow and /deny are for groups"). The built-in means something only in a group; in a direct chat theirs
         runs, exactly as before (the user-command path below, owner-gated the same way). */
      if (parsed && (parsed.cmd === 'allow' || parsed.cmd === 'deny') && String(msg.chatType || '') !== 'group' && runSlashFn) {
        let theirs = false;
        try { theirs = (userCommandNames() || []).some(n => String(n).toLowerCase() === parsed.cmd); } catch (e) { failNote('channels.hub.userCommandNames', e); }
        if (theirs) parsed = null;
      }
      // "/deny @spammer" in a group is another bot's command (a moderation bot's), never ours: ours takes no argument
      // unless it names this bot — "/deny@thisbot …" (the adapter has already checked the suffix is us) or
      // "/deny @thisbot" (the adapter marks it argNamesUs). Taken as ours it admitted or closed the owner's station for a
      // room. Silent — answering would put us in their conversation — with ONE exception: the OWNER's /deny in a room
      // we answer in. An ignored close fails open, so the owner is told the room is still open and how to close it.
      if (parsed && (parsed.cmd === 'allow' || parsed.cmd === 'deny') && parsed.arg && String(msg.chatType || '') === 'group'
          && !/^\s*\/[A-Za-z]+@/.test(String(msg.text || '')) && msg.argNamesUs !== true) {
        if (parsed.cmd === 'deny' && senderIsOwner && chatAdmitted(chatId)) {
          await deliver(chatId, '⚠ That /deny had something after it, so I left it alone — this group is still admitted. Send /deny on its own to remove me.', '', 'command');
        }
        return;
      }
      if (parsed) {
        // OWNER GATE: a non-owner may talk to the agent, never reconfigure the station. Refused for free, before
        // any handler, write or slash-registry call — and said plainly, so the member knows it is a policy.
        if (commandNeedsOwner(parsed) && !senderIsOwner) {
          await deliver(chatId, ownerOnlyReply('/' + parsed.cmd), '', 'command');
          return;
        }
        await handleCommand(chatId, parsed, boundAgentId, sec, boundRec, msg.chatType, ownerTrusted);
        return;
      }

      // COMMANDER-DEFINED commands are not in this hub's table (the sidecar owns them), so a "/standup" would
      // otherwise fall through and be answered by the MODEL — spending a turn to say it doesn't understand.
      // Match only against the names the sidecar actually reports, so an ordinary message that happens to start
      // with a slash (a path, say) still reaches the agent untouched. The registry itself decides what a given
      // command may do here: an alias resolves and runs, a shell exec runs only in the owner's trusted DM.
      // Same provenance rule as the built-in table above: forwarded / forward-quoting text is a third party's words,
      // never the Commander's command — it flows on to the (tainted) run as ordinary text.
      // The name list is read only for a slash-led message: it re-reads the Commander's file.
      const userCmd = (runSlashFn && !carriesThirdPartyText(msg) && String(msg.text || '').trim().charAt(0) === '/')
        ? parseUserCommand(msg.text, userCommandNames()) : null;
      if (userCmd) {
        // the Commander's own commands run the Commander's own aliases — owner-only, same gate as the table above
        if (!senderIsOwner) { await deliver(chatId, ownerOnlyReply('/' + userCmd.name), '', 'command'); return; }
        // resolve the agent the SAME way handleCommand does, so a user command is scoped to whoever this chat
        // is actually talking to rather than a default
        const ucAgent = currentBoundAgent(chatId, boundAgentId, sec);
        // chatType + ownerDmExec let the registry word a shell-command refusal truthfully for THIS chat: a group
        // never runs one (the output would post to the whole room), and only a hub that can mint ownerTrusted has
        // an owner DM where one does run.
        const ucCtx = { agentId: ucAgent, ownerTrusted: ownerTrusted, chatType: msg.chatType === 'group' ? 'group' : 'dm', ownerDmExec: ownerDmExec };
        let r;
        try { r = await runSlashFn(userCmd.line, ucCtx); }
        catch (e) { try { console.error('[' + channel + '] user command threw:', (e && e.message) || e); } catch (_) {} r = null; }
        const body = (r && Array.isArray(r.lines) && r.lines.length)
          ? ((r.title ? r.title + '\n' : '') + r.lines.join('\n'))
          : String((r && r.text) || '');
        await deliver(chatId, body || ('/' + userCmd.name + ' had nothing to report.'), '', 'command');
        return;
      }

      /* A DESKTOP COMMAND typed here (bug 6cd531b1): "/version", "/q", "/retry" are the shared registry's own built-ins
         with no row in this hub's table, so they fell through to the model — a paid run whose answer was a guess at
         what the command does. The registry answers instead (for a desktop-only command: "That command only works in
         the StarNet desktop app."), for free. Owner-only like the Commander's own commands: every one of them acts
         on the owner's station. Same provenance rule: a forwarded "/version" is a third party's words. */
      let deskCmd = (runSlashFn && desktopCommandFn && !carriesThirdPartyText(msg)) ? parseDesktopCommand(msg.text) : null;
      /* THE NOTE COMMANDS are the exception: the words after /steer, /queue (/q) and /background (/bg, /btw) are the
         sender's own note, and this hub HAS a way to act on one — sent as a plain follow-up it joins the task already
         running here (the live steer below) or starts one. So the command word is stripped and the note goes on exactly
         as if typed on its own (same sender, same gates). The one refusal is the desktop's own: a /steer with nothing
         running never mints a paid run out of a steering note. */
      if (deskCmd && NOTE_CMDS[deskCmd.name]) {
        const noteText = deskCmd.line.slice(deskCmd.name.length + 1).trim();
        if (!noteText) {
          const joins = !!steerRun && msg.chatType !== 'group';
          await deliver(chatId, '/' + deskCmd.name + ' needs your note after it. Or just send the note as a message'
            + (joins ? ' — while a task is running here it joins that task at its next step.' : '.'), '', 'command');
          return;
        }
        const lr = inflight.get(chatId);
        if (NOTE_CMDS[deskCmd.name] === 'steer' && !(lr && !lr.superseded && !lr.halted)) {
          await deliver(chatId, 'Nothing is running here to steer — send your note as a message to start a task.', '', 'command');
          return;
        }
        msg = Object.assign({}, msg, { text: noteText });
        deskCmd = null;
      }
      if (deskCmd) {
        if (!senderIsOwner) { await deliver(chatId, ownerOnlyReply('/' + deskCmd.name), '', 'command'); return; }
        let r;
        try { r = await runSlashFn(deskCmd.line, { agentId: currentBoundAgent(chatId, boundAgentId, sec), ownerTrusted: ownerTrusted, chatType: msg.chatType === 'group' ? 'group' : 'dm', ownerDmExec: ownerDmExec }); }
        catch (e) { failNote('channels.hub.desktopCommand.run', e); r = null; }
        const body = (r && Array.isArray(r.lines) && r.lines.length)
          ? ((r.title ? r.title + '\n' : '') + r.lines.join('\n'))
          : String((r && r.text) || '');
        await deliver(chatId, body || ('⚠ Could not run /' + deskCmd.name + ' right now — try again in a moment.'), '', 'command');
        return;
      }

      // ---- a TYPED answer to a live choice keyboard ---------------------------------------------------------
      // Resolve it to the canonical option text BEFORE anything reads msg.text (routing, the classifier and the
      // stored turn all must see the real answer, not a bare "2"). Then retire this chat's keyboards either way:
      // if that was the answer it is spent, and if it was NOT, the conversation has moved past the question and
      // a late tap must not reopen it. The buttons stay visible but now answer honestly that they're closed.
      if (prompts) {
        const live = prompts.peekChat(chatId, 'choice');
        if (live) {
          const picked = coerceChoice(live.options, msg.text);
          if (picked) msg = Object.assign({}, msg, { text: picked });
        }
        prompts.dropChat(chatId, 'choice');
      }

      // Phase B routing: the placed floor (a posted RoutingPlan) decides WHICH agent runs. resolveAgent
      // returns the bay-bound agentId, or null -> fall through to today's resolution so real work NEVER stalls.
      // Resolution order: floor plan > this chat's explicit /talk binding > the connect-time configured agentId >
      // the per-chat tg_<chatId> fallback (an unbound chat still just works).
      const tag = getTag ? getTag(msg.text) : undefined;
      /* resolveAgent may answer a bare agentId (every pre-dock seam) or { agentId, dockId } (router.resolveDock —
         multi-bay agents, 2026-09-22): the DOCK the floor routed the work to is the one whose brief, room and line
         the run gets. A binding/fallback resolution carries no dock and the seams read the agent's entry dock. */
      const routedRaw = resolveAgent ? resolveAgent({ tag, chatId, text: msg.text, boundAgentId }) : null;
      const routed = (routedRaw && typeof routedRaw === 'object') ? routedRaw.agentId : routedRaw;
      const routedDock = (routedRaw && typeof routedRaw === 'object' && routedRaw.dockId != null && AID_RE.test(String(routedRaw.dockId))) ? String(routedRaw.dockId) : null;
      const agentId = (routed && AID_RE.test(String(routed))) ? String(routed)
        : boundAgentId
        ? boundAgentId
        : (sec.agentId && AID_RE.test(String(sec.agentId))) ? String(sec.agentId) : agentIdFor(chatId);
      const canonicalStreamId = resolvedStreamId(chatId);
      // the dock this run is AT: only when the floor's own resolution picked this agent (never inferred)
      const dockId = (routedDock && routed && String(routed) === agentId) ? routedDock : null;

      // A re-delivered receipt whose run had already BEGUN tool steps before the crash is never run again from the top
      // (attemptOf, above): before anything below can steer it into a run, supersede one, or start one.
      if (priorAttempt && priorAttempt.tools > 0) { await reportInterruptedAttempt(chatId, agentId, msg, priorAttempt); return; }

      /* A FOLLOW-UP JOINS THE RUN IN FLIGHT (2026-10-11 — "they start a task and then stop repeatedly with no
         explanation as to why"). Every message used to ABORT this chat's working run and delete its partial, so a
         "also make it blue" or a "how's it going?" silently killed the task. When the host can steer (steerRun) and
         this is a plain follow-up to the SAME agent, it goes into that run's steer buffer — the loop reads it at its
         next step, exactly like a COMMS mid-run steer — and nothing is aborted. Only in a DIRECT chat with no
         forwarded/quoted text and no media: the run's trust and taint were decided from its first sender, so a group
         member or third-party text must never ride into it as a Commander instruction. A plain "stop"/"cancel" from
         the owner IS /stop (below). A refused steer (the run already finished its work, or has no id yet) falls
         through to the old path, which now says the earlier run was stopped. */
      const liveRun = inflight.get(chatId);
      // a plain "stop"/"cancel" from the owner while this chat's run is working IS /stop: the same reply, no supersede
      // notice, and no paid model run on the word "stop". Same message kinds the steer below accepts; anything else
      // (a group, a forward, media, a non-owner) falls through unchanged.
      if (liveRun && liveRun.abort && !liveRun.superseded && !liveRun.halted && senderIsOwner
          && msg.chatType !== 'group' && !msg.edited && !carriesThirdPartyText(msg)
          && !(Array.isArray(msg.media) && msg.media.length)
          && STOP_WORDS_RE.test(String(msg.text || ''))) {
        liveRun.superseded = true;   // no supersededBy: the run's teardown stays quiet, exactly like /stop
        let aborted = false;
        try { liveRun.abort.abort(); aborted = true; } catch (e) { failNote('channels.hub.plainStop', e); }
        await deliver(chatId, aborted ? 'Stopped the run in progress.' : '⚠ Could not stop that run — it may already be finishing.', '', 'command');
        return;
      }
      // 409 = that run's loop already FINISHED its work and is settling its reply: never abort it (that would throw away
      // a finished answer) — it delivers, and this message runs next, queued behind it on the same conversation.
      let letPrevFinish = false;
      if (steerRun && liveRun && liveRun.runId && !liveRun.superseded && !liveRun.halted && liveRun.agentId === agentId
          && msg.chatType !== 'group' && !msg.edited && !carriesThirdPartyText(msg)
          && !(Array.isArray(msg.media) && msg.media.length) && !(msg.replyTo && Array.isArray(msg.replyTo.media) && msg.replyTo.media.length)
          && String(msg.text || '').trim() && !STOP_WORDS_RE.test(String(msg.text || ''))) {
        // ONE LINE ON THE WIRE: two quick bubbles arrive here joined by a newline (the text batch), and every reader of
        // the loop's '\n[steering] <note>\n' echo — this hub, COMMS, the phone relay — reads one line
        const note = steerNoteWire(msg.text);
        let steered = false;
        try { const r = await steerRun(liveRun.runId, note); steered = !!(r && r.ok); letPrevFinish = !steered && !!r && r.status === 409; }
        catch (e) { failNote('channels.hub.steer', e); steered = false; }
        if (steered) {
          try { store.appendTurn(agentId, 'user', note); } catch (e) { failNote('channels.hub.appendTurn', e); }
          try { emit('channel.inbound', { channel, chatId, agentId, userId: msg.userId || '', kind: 'dm' }); } catch (e) { failNote('channels.hub.inbound.emit', e); }
          // the run may be PAUSED on an approval keyboard: "next step" would then wait out the keyboard (and a typed "yes"
          // never answers it — only a tap grants a security decision), so say where it is stuck and what unblocks it
          const waitingOnApproval = (liveRun.awaitingConsent || 0) > 0;
          await deliver(chatId, waitingOnApproval
            ? '↪ Added to the task — but it is paused on the permission request above. Tap Allow or Deny there (a typed yes/no does not answer it); it reads your note right after.'
            : '↪ Added to the task that is already running — it picks this up at its next step, no restart.', liveRun.runId, 'command');
          return;
        }
      }

      if (resolveEntryRunConfig) {
        try {
          const config = resolveEntryRunConfig(agentId);
          sec = config && config.ok !== false ? config : { error: (config && config.error) || 'target agent is not configured' };
        } catch (_) { sec = { error: 'target agent configuration could not be read' }; }
      }
      const provider = String(sec.provider || 'openrouter').trim().toLowerCase() || 'openrouter';
      const usingCodex = provider === 'codex' || provider === 'openai-codex';
      const reasoningEffort = sec.reasoningEffort || sec.reasoning_effort || (usingCodex ? 'low' : 'medium');

      // B4 — persist the chat→agent binding (+ this hub's channel) so the autonomous notifier can find which chat to
      // ping for a given agent when a cron run produces work. Best-effort: a store hiccup must never block the reply.
      // GUARD (2026-07-05): a FLOOR-ROUTED agent must never overwrite the user's explicit /talk binding — one
      // belt-routed message used to silently rebind the whole chat to whatever bay the belts picked, so /whoami,
      // /model and the notifier all started asserting an agent the user never chose. Persist only when the chat is
      // unbound or the resolution agrees with the binding.
      // (bindChats:false — an ephemeral proof chat never becomes addressed; see the option note above.)
      try { if (bindChats && typeof store.saveChatRecord === 'function' && (!boundAgentId || boundAgentId === agentId)) store.saveChatRecord(chatId, { agentId: agentId, channel: channel, streamId: canonicalStreamId || undefined }); } catch (e) { failNote('channels.hub.chatRecord.save', e); }

      // announce the SINGLE resolution to the host (workitem crate + queue HUD attribution — one truth).
      // isTask rides along: the BELT IS WORK-ONLY (Andrew's ruling 2026-07-05) — the host places a crate only
      // for a real task directive; "hello" gets a reply and NOTHING on the floor. Same classifier that gates
      // the desk walk + the task tool suffix below, so the body and the belt tell one story.
      // `let`, because a VOICE note carries no text yet: its transcript only exists after media ingest below,
      // and a spoken "research the competitors" must still earn the task suffix. Re-evaluated once the words
      // exist. (The belt crate + onResolved fire here, before the audio is downloaded, so a spoken directive
      // still visualizes as talk — visualization only; the RUN gets the right prompt.)
      let isTask = !!classify(msg.text);
      /* THE WORK'S ORIGIN LINE, or null (work belongs to a line, 2026-08-07 — Andrew's ruling). A channel
         message is OUTSIDE work arriving at the station, so if the dock that will run it is one a line's
         own INBOX feeds, this IS that line running and its drawn stages may follow. Asked of the FINAL
         agentId — however it was resolved — because the per-agent bots deliberately hard-lock stage one to
         their bound agent and never consult floor routing; keying this on the resolution would have said
         "no line" for exactly the floor the Commander drew. The seam is injected (router.lineOriginFor) so
         the compiled plan stays the only authority; absent -> null -> every dock terminal, which is the
         safe direction. It rides `resolvedInfo` (so the host stamps the crate with it) and the chain seed
         below (so the gate can read it). */
      const lineId = lineOriginFor ? ((dockId ? lineOriginFor(agentId, dockId) : lineOriginFor(agentId)) || null) : null;
      const resolvedInfo = { chatId: chatId, agentId: agentId, text: msg.text, isTask: isTask, lineId: lineId };
      if (dockId) resolvedInfo.dockId = dockId;   // additive: the host lands the crate at THIS bay (multi-bay)
      if (onResolved) { try { onResolved(resolvedInfo); } catch (_) {} }
      if (intake && typeof intake.onResolved === 'function') { try { intake.onResolved(resolvedInfo); } catch (_) {} }

      // one run per CONVERSATION: a new message in THIS chat ABORTS its in-flight run — keyed by chatId, NOT
      // agentId, so two chats routed to the SAME agent (via a splitter/filter) never cross-cancel each other.
      // `supersededBy` lets the aborted run's teardown SAY it was stopped for this message (abandoned() below) — a
      // /stop and an E-STOP set superseded without it and keep their own replies.
      const prev = inflight.get(chatId);
      if (prev && !(letPrevFinish && prev === liveRun)) { prev.superseded = true; prev.supersededBy = 'message'; try { prev.abort.abort(); } catch (_) {} }

      try { emit('channel.inbound', { channel, chatId, agentId, userId: msg.userId || '', kind: msg.chatType === 'group' ? 'group' : 'dm' }); } catch (_) {}

      if (!sec.model || (!usingCodex && !sec.configured && !sec.key)) {
        await deliver(chatId, '⚠ ' + (sec.error || 'No provider/model is configured yet. Open the STARNET app → Messaging tab and connect.'), '', 'error');
        return;
      }
      // an earlier run of this message began no tool step before the crash: running it again cannot do anything twice —
      // but the chat is told it is a second go, never left to think it is the first
      if (priorAttempt) {
        const ask = clipAsk(msg.text);
        await deliver(chatId, '↻ StarNet restarted while it was working on ' + (ask ? '"' + ask + '"' : 'your message')
          + '. It had not begun any tool step yet, so nothing can happen twice — running it again now.', priorAttempt.runId, 'command', agentId);
      }

      // TYPING: from here on a real run WILL happen — light the platform's "typing…" bubble now (it also covers
      // media download/ingest, which can take seconds) and keep refreshing until the reply is built. Stopped in
      // the finally BEFORE deliver() so the bubble can expire rather than linger past the answer. The wrapper
      // try/finally does not re-indent the body (matches this file's existing low-indent try style below).
      const stopTyping = startTyping(chatId);
      // …and mark the QUESTION itself, which survives the member closing the app. Cleared in the same finally.
      const clearAck = startAck(chatId, msg.messageId);
      // …and write the ANSWER in front of them as it is produced. Null on every channel that cannot edit, in
      // which case every path below behaves exactly as it did before streaming existed.
      const stream = startStream(chatId);
      // hoisted OUT of the typing try-block: deliver() below the finally reads all three.
      let state = null;          // the LAST attempt's assembled state (buf/errMsg/reason/transient)
      let lastRunId = '';        // the runId actually delivered under (the last attempt's)
      let reply;
      let choiceEntry = null;    // the registered choice keyboard for a TASK_QUESTION reply (null = plain text)
      let finalAgentId = agentId;   // WHO produced the delivered reply — the LAST stage of the work line, not the first
      let firstStageText = null;    // what the ENTRY dock itself said, when a work line went on to replace it
      // Hoisted for the finally below: `myRec` lives in the attempt scope, but the stream's clean-up decision
      // (finish in place vs. delete the partial) is taken out here, after every return path has run.
      let withdrawn = false;
      try {

      // MEDIA: download + store what the user actually sent (photos/videos/voice/files) BEFORE the turn is built,
      // so the model's view of this message carries the real pixels/files instead of a blind spot it has to
      // apologize for. ingestMedia never throws by contract; the belt-and-suspenders catch degrades to a note.
      // REPLY MEDIA rides in the SAME ingest as the message's own: "what is this?" sent as a reply to a photo is
      // one turn that needs those pixels. Tagged with fromReply so every note it produces says where it came
      // from, and bounded separately so a quoted album can never crowd out what the member just sent.
      const ownMedia = Array.isArray(msg.media) ? msg.media : [];
      const replyMedia = (msg.replyTo && Array.isArray(msg.replyTo.media))
        ? msg.replyTo.media.slice(0, MAX_REPLY_MEDIA).map(it => Object.assign({}, it, { fromReply: true })) : [];
      const allMedia = ownMedia.concat(replyMedia);
      let mediaIngest = { attachments: [], notes: [] };
      if (allMedia.length) {
        try { mediaIngest = await ingestMedia(agentId, allMedia); }
        catch (e) { mediaIngest = { attachments: [], notes: ['[media ingest failed: ' + ((e && e.message) || e) + ']'] }; }
      }
      // UNTRUSTED ENTRY (run-origin.js entryUntrusted): the same three provenances that start the entry run tainted —
      // a trigger payload (entryTaint), a chat attachment, a forwarded/quoted third-party message. Decided ONCE per
      // message so the entry run and every hop of its line carry one verdict. A SEND TO hand-off's entryTaint is read through
      // the sending job's own verdict (entryUntrusted above): a Commander-typed job stays trusted on the next line.
      const lineEntryUntrusted = !!((entryTaint && entryVerdictUntrusted(msg)) || mediaIngest.attachments.length || carriesThirdPartyText(msg));
      // …and the sending job's sender verdict (senderWithheld above): a non-owner's job stays withheld on every line it reaches
      const lineWithheld = senderVerdictWithheld(msg);
      const runChannelSender = lineWithheld ? true : tagSenderRuns;
      const runChannelSenderOwner = lineWithheld ? false : channelSenderOwner;
      // The quoted preamble goes ABOVE the member's own words — it is the context their sentence refers back to.
      // It is built from msg.replyTo only, never from msg.text, so routing/classification/commands (which all ran
      // on the RAW text above) are untouched by it.
      const replyLead = replyPreamble(msg.replyTo);
      // A voice note usually carries NO caption, so the transcript IS the message — it goes where the typed
      // words would have gone, above the media notes, not buried among them.
      const spoken = transcriptBlock(mediaIngest.transcripts);
      const written = String(msg.text || '');
      /* GROUP ATTRIBUTION. `userName` was captured on every inbound message and never reached the model, so in
         a group the agent read a merged stream with no idea who said what — it would answer one person using
         another person's context, and could not honour "ask Ana" because it never learned Ana was in the room.
         DM is left alone: there is exactly one human there and a name prefix would just be noise in every turn. */
      const speaker = (msg.chatType === 'group') ? String(msg.userName || '').trim() : '';
      const attributed = speaker ? (speaker + ': ' + written) : written;
      const bodyText = spoken ? (attributed ? attributed + '\n' + spoken : spoken) : attributed;
      // The words only became available just now — classify them, or a spoken task runs without the task prompt.
      if (spoken && !isTask) { try { isTask = !!classify(mediaIngest.transcripts.join(' ')); } catch (e) { failNote('channels.hub.classify', e); } }
      /* AN EDIT IS A CORRECTION, AND IT MUST SAY SO. The original text is already in history — replaying it
         followed by a near-identical turn reads to the model as the member saying two slightly different things
         and can have it answer both, or split the difference. One line naming what happened is the difference
         between "they repeated themselves" and "the earlier version is void". */
      const editLead = msg.edited ? '[the previous message was edited — this is the corrected version, treat it as replacing what came before]' : '';
      // what the member actually asked, as the entry run reads it (voice transcript, quoted reply, attachment notes) minus
      // the edit marker, which names a message a downstream stage never saw. A line's hops no longer replay the chat stream
      // (resumeSeed:false), so this is the only place a stage meets e.g. a captionless voice note's words.
      const lineAsk = (replyLead ? replyLead + '\n\n' : '') + bodyText
        + (mediaIngest.notes.length ? ((bodyText ? '\n' : '') + mediaIngest.notes.join('\n')) : '');
      const turnText = (editLead ? editLead + '\n' : '') + lineAsk;

      // durable transcript: load prior turns, persist the new user turn, build the replay messages. The persisted
      // turn carries the media notes (with saved .attachments/ paths), so an agent in a LATER turn can still reach
      // the files through its workspace tools even though history replays as plain text.
      let history = [];
      try {
        history = canonicalStreamId && historyFor ? historyFor(canonicalStreamId, agentId) : store.loadHistory(agentId);
        if (!Array.isArray(history)) history = [];
      } catch (_) { try { history = store.loadHistory(agentId); } catch (_) { history = []; } }
      // A SECOND GO HAS ONE COPY OF THE TURN. The interrupted run already filed these words (the legacy history below, and
      // its directive row in the canonical stream); with nothing after them, they are this message, not an earlier ask.
      const storedTurn = turnText || '[the user sent a media message]';
      if (priorAttempt && history.length) {
        const last = history[history.length - 1];
        if (last && last.role === 'user' && (last.content === storedTurn || last.content === turnText)) history = history.slice(0, -1);
      }
      // "YES" TO AN OFFER IS A GO: classified on its own, "yes" is chat and the run gets no task prompt. Ask again with the
      // agent's last reply: an affirmation that answers its offer to act ("want me to draft it?") IS the directive.
      if (!isTask && history.length) {
        const prior = history[history.length - 1];
        if (prior && prior.role === 'assistant' && typeof prior.content === 'string') {
          try { isTask = !!classify(msg.text || '', { priorAgentTurn: prior.content }); } catch (e) { failNote('channels.hub.classify.offer', e); }
        }
      }
      if (!priorAttempt) { try { store.appendTurn(agentId, 'user', storedTurn); } catch (e) { failNote('channels.hub.appendTurn', e); } }
      const userTurn = { role: 'user', content: turnText };
      if (mediaIngest.attachments.length) userTurn.attachments = mediaIngest.attachments;
      let messages = history.map(m => ({ role: m.role, content: m.content })).concat([userTurn]);
      // Expand the attachment refs into provider content blocks (base64 image blocks / inlined text) through the
      // SAME expandUserAttachments seam the interactive run host uses. Absent/failed expansion falls back to the
      // note-only turn (the refs are stripped so no provider ever sees a shape it doesn't know).
      if (userTurn.attachments) {
        let expanded = null;
        if (expandAttachments) { try { expanded = await expandAttachments(messages, agentId); } catch (_) { expanded = null; } }
        if (Array.isArray(expanded)) messages = expanded;
        else delete userTurn.attachments;
      }

      const rec = store.getChatRecord ? store.getChatRecord(chatId) : null;
      const persona = sec.system || personaFor(agentId, rec);   // the agent's REAL composed prompt when configured
      // the dock's standing brief (step editor): when the router holds one for this agent's dock, the run's
      // system context carries it — the SAME section header the chain handoff turn uses. Null-safe: no seam /
      // no floor / no brief composes the exact pre-brief system string.
      let dockBrief = null;
      if (stageBriefFor) { try { dockBrief = dockId ? stageBriefFor(agentId, dockId) : stageBriefFor(agentId); } catch (_) { dockBrief = null; } }
      // the one-shot note an interrupted attempt left this chat (reportInterruptedAttempt): read by this run, then cleared
      let interruptedNote = '';
      if (rec && rec.interruptedAttempt && typeof store.saveChatRecord === 'function') {
        interruptedNote = interruptedAttemptNote(rec.interruptedAttempt);
        try { store.saveChatRecord(chatId, { interruptedAttempt: null }); } catch (e) { failNote('channels.hub.interruptedAttempt.clear', e); }
      }
      const system = dockSystem(persona, dockBrief, isTask) + interruptedNote;

      // B5: if this agent runs at a bound BAY, its tools are that bay room's objects (resolveStation), not the
      // default office — so a routed agent's reach is exactly what the floor granted it. null -> office default.
      const bayStation = resolveStation ? (dockId ? resolveStation(agentId, dockId) : resolveStation(agentId)) : null;

      // ---- run with bounded supersede-retry ------------------------------------------------------------------
      // ONE run per conversation: the prev.abort.abort() above told this chat's prior run to stop. But its host-side
      // workspace-mutex slot (index.js concurrencyGate) releases in an async finally as the aborted run unwinds — so
      // the FIRST attempt of the replacement can lose that race and get a TRANSIENT "already running a task" refusal.
      // Retry ONLY that class, up to supersedeRetries times with backoff, so the Commander's message is never
      // silently dropped. Any OTHER outcome (a real reply, a budget/config/capdenied error, an unrelated transient,
      // or a supersede by a still-newer message) exits the loop immediately.
      //
      // ONE stable inflight record spans ALL attempts (created here, deleted once after the loop). This is load-
      // bearing: it must stay in `inflight` DURING the backoff sleep so a message arriving mid-backoff still finds it
      // (prev.superseded=true above) and the parked retry bails instead of firing a stale run. E-STOP (halt.js) reads
      // the SAME record. Per attempt we swap the live AbortController + runId + startedAt so each field always
      // reflects the attempt currently executing (or last executed).
      // agentId/startedAt ride in the record so GET /api/state/snapshot can list THIS run (attributed to the acting
      // agent, aged from startedAt) — a reconnect then keeps the agent's live floor/HUD state instead of clearing it.
      // abort/superseded are what halt.js's E-STOP reads; the extra fields are additive and invisible to it.
      const myRec = { runId: '', abort: null, superseded: false, halted: false, agentId: agentId, startedAt: null };
      // tool steps this message's runs have BEGUN (entry run, every retry attempt, every line hop), stamped on its receipts
      // as each one is announced — loop.js emits agent.tool_call before it dispatches, so the count is durable first
      let attemptTools = 0;
      const noteToolStep = () => { attemptTools++; markAttempt({ tools: attemptTools }); };

      /* AN E-STOP IS NOT A SUPERSEDE. Both set `superseded`, because both must abandon this run's now-stale
         partial reply — but a supersede means a NEWER message owns the conversation and is already running its
         replacement, while an E-STOP means nothing else is coming at all. Returning the same silence for both
         made a deliberate stop indistinguishable from a crashed bot on the one surface that has no floor, no
         browser and no other signal to read. /stop typed from that same chat answers "Stopped the run in
         progress."; the station's E-STOP owes the chat the same courtesy. halt.js sets `halted` for exactly
         this. Delivered at most once per run, whichever abandon-point is reached first. */
      let haltNoticeSent = false;
      const abandoned = async () => {
        if (!myRec.superseded) return false;
        if (myRec.halted && !haltNoticeSent) {
          haltNoticeSent = true;
          // the station's OWN process-fault containment marks the run `faulted` before it kills it (halt.js markFaulted): that
          // stop is said as the fault it was, never as an E-STOP nobody pressed (wave 2 repair, conveyor-backend-08)
          const why = myRec.faulted ? 'the station hit an internal fault and stopped this run' : 'E-STOP was pressed in the station';
          try {
            await deliver(chatId, '⏹ Stopped — ' + why + '. This message got no reply and nothing further will run for it.', myRec.runId || '', 'command');
          } catch (_) { /* a stop notice must never crash the teardown */ }
        } else if (!myRec.halted && myRec.supersededBy === 'message' && !haltNoticeSent && myRec.runId && !(state && state.errMsg)) {
          /* A NEWER MESSAGE STOPPED THIS RUN — never silently (2026-10-11). This is the fallback when the follow-up
             could not join the run (no steer seam, a group chat, media, a "stop" the owner did not send, or no live loop to read
             it): the earlier task's unfinished reply is dropped, so say so once. Its question stays
             in the transcript, so the newer run can see it. */
          haltNoticeSent = true;
          try {
            await deliver(chatId, '⏹ Stopped the earlier task before it finished so your newer message could be handled — its unfinished reply was dropped. If that earlier request still needs doing, say so.', myRec.runId || '', 'command');
          } catch (e) { failNote('channels.hub.supersedeNotice', e); }
        }
        return true;
      };
      inflight.set(chatId, myRec);
      let attempt = 0;
      try {
      for (;;) {
        const runId = newId();
        lastRunId = runId;
        const ac = new AbortController();
        myRec.runId = runId; myRec.abort = ac; myRec.startedAt = now ? now() : null;

        // assemble the reply by buffering agent.token deltas — the SAME reassembly harness.js does in the browser.
        // transient rides alongside errMsg so the retry gate can tell the workspace-mutex race from a hard error.
        state = { runId, buf: '', errMsg: null, reason: null, transient: false, toolsRan: 0 };
        const sink = (name, payload) => {
          let p; try { p = redact(payload); } catch (_) { p = payload; }
          if (name === 'agent.run.start') state.runId = p.runId || state.runId;
          // The reply is already being assembled here, delta by delta — so this is also where it can be SHOWN.
          // stream.push is fire-and-forget and throttled; it can never delay or fail the run.
          else if (name === 'agent.token') { state.buf = joinReplyDelta(state.buf, p.delta); if (stream) stream.push(state.buf); }
          else if (name === 'agent.tool_call') { state.buf = ''; state.toolsRan++; noteToolStep(); }   // counted: an 'empty' end after tools is not "nothing was done"
          else if (name === 'agent.run.error') { state.errMsg = p.message || 'run error'; state.transient = !!p.transient; }
          else if (name === 'capdenied') state.errMsg = state.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
          else if (name === 'agent.run.end') { state.reason = p.reason; state.finishReason = p.finishReason || null; state.unpricedModel = p.unpricedModel || null; state.unpricedCapTokens = Number(p.unpricedCapTokens) || 0; state.subscriptionModel = p.subscriptionModel || null; state.subscriptionCapTokens = Number(p.subscriptionCapTokens) || 0; state.budgetScope = p.budgetScope || null; state.budgetCapUsd = (typeof p.budgetCapUsd === 'number' && isFinite(p.budgetCapUsd)) ? p.budgetCapUsd : null; state.budgetCapIsBalance = p.budgetCapIsBalance === true; state.budgetProjected = p.budgetProjected === true; if (typeof p.usd === 'number' && isFinite(p.usd)) state.usd = Math.max(state.usd || 0, p.usd); }
        };

        // CONSENT SURFACE (per-chat, default OFF — see /approvals). With it off nothing changes: the run stays
        // 'autonomous' and the broker default-denies an ungranted mutation without ever stalling. With it ON the
        // run becomes 'interactive' and `prompt` is the live channel the broker pauses on — the host owns that
        // pause/resolve (askConsent registers it in the SAME pendingByRun the browser answers), while the hub
        // only renders the keyboard and routes the tap back. Built per ATTEMPT so it closes over this attempt's
        // runId + AbortController; a superseded attempt's prompts die with its signal.
        const consentPrompt = wantApprovals ? function (call, tool) {
          // count the open asks on the chat's run record (released however the wait settles: tap, timeout, abort) so a
          // typed follow-up can say the run is paused on this keyboard (LIVE STEER above)
          myRec.awaitingConsent = (myRec.awaitingConsent || 0) + 1;
          const release = function () { myRec.awaitingConsent = Math.max(0, (myRec.awaitingConsent || 1) - 1); };
          let asked;
          try {
            asked = askConsent({
            agentId: agentId, runId: runId, signal: ac.signal, call: call, tool: tool,
            onPrompt: function (promptId, fields) { sendConsentPrompt(chatId, runId, promptId, fields); },
            // the fail-closed timer fired with no tap: SAY so, or the chat sees the run carry on as if they had refused
            onTimeout: function (promptId, fields) { notifyConsentTimeout(chatId, runId, fields); }
            });
          } catch (e) { release(); throw e; }
          return Promise.resolve(asked).finally(release);
        } : undefined;

        // the receipt now names the run that is about to start (written AFTER the user turn was filed above)
        markAttempt({ runId: runId });
        try {
          await runOnce({
            key: usingCodex ? '' : sec.key, model: sec.model, provider, baseUrl: sec.baseUrl || sec.base_url || '', reasoningEffort, system, messages, agentId, isTask,
            emit: sink, signal: ac.signal, runId, lineId, trigger: 'event',
            streamId: canonicalStreamId || undefined,
            // a second go of an interrupted run reuses that run's durable directive row instead of filing the words again
            // (runOnceCore retryDirective: matched by run id, agent, stream AND exact text, so it can only ever dedupe this)
            retryUserRunId: (priorAttempt && attempt === 0) ? priorAttempt.runId : undefined,
            // a VOICE NOTE is a spoken turn: the voice chat model may answer it (never a work line's stage)
            voiceTurn: (!!spoken && !lineId) || undefined,
            initialTaint: entryTaint || (mediaIngest.attachments.length ? 'channel attachment' : (carriesThirdPartyText(msg) ? 'forwarded message' : null)),
            // RUN ORIGIN (run-origin.js entryUntrusted): the job itself is third-party content, so Full Access does not
            // lift this run's taint lock. Every hop of its line inherits the same verdict (lineEntryUntrusted below).
            untrustedEntry: lineEntryUntrusted || undefined,
            surface: wantApprovals ? 'interactive' : 'autonomous',
            ownerTrusted: ownerTrusted,
            // RUN ORIGIN (sidecar/run-origin.js): a chat sender started this run. Full Power (per-agent Full Access /
            // master bypass) is inherited only when that sender is the bound owner in a direct chat (a SEND TO hand-off: as
            // the sending job's sender was, lineWithheld above).
            channelSender: runChannelSender, channelSenderOwner: runChannelSenderOwner,
            // ...but ONLY for who answers a consent prompt. A phone has no floor to place props on, so this run
            // composes the headless office either way. Without this, /approvals on silently cut the agent from
            // the full autonomous office to compute-only (2 tools) — THE MOAT is floor-real placement, and there
            // is no floor here to be real about. See runOnce's `floorless` note (2026-07-28).
            floorless: true,
            prompt: consentPrompt,
            broadcast: true,   // P1: mirror this routed run's lifecycle to the station floor over SSE — it has no browser-local stream
            // LINE WATCH (additive): the run row records the line + bay it worked AT (the per-line stats and bay lamps)
            lineId: lineId || undefined, dockId: dockId || undefined,
            // A channel task is real work the agent should learn from, exactly like a COMMS task. Admission is
            // already owner-gated upstream (adapter.js ownerOk: a non-owner DM never reaches this host, a group
            // must be whitelisted), and each record is stamped with its origin (channel:<name>) so the Commander
            // can see in Memory Core which surface formed a belief.
            reflect: true,
            station: bayStation || undefined,
            taskKey: 'channel:' + channel + ':' + chatId,
            taskSource: channel,
            deliveryOrigin: { channel: channel, chatId: String(chatId), threadId: (routes.get(String(chatId)) || {}).threadId || null }
          });
        } catch (e) {
          state.errMsg = state.errMsg || ('run failed: ' + ((e && e.message) || e));
        }

        // a newer message (or E-STOP) took over this chat — abandon this run's (now stale) partial reply, and do
        // NOT retry (the newer message owns the conversation now and is running its own replacement). On an
        // E-STOP nothing is coming, so abandoned() says so instead of returning the same silence. `withdrawn`
        // is what tells the finally to DELETE the streamed partial: a half answer to a question that has been
        // taken back is worse than no answer, and the E-STOP notice must not appear underneath one.
        if (await abandoned()) { withdrawn = true; return; }

        // Retry ONLY the same-agent workspace-mutex race, and only while attempts remain. On the final failed
        // attempt fall through so the loop exits and the honest "still busy" reply below is delivered.
        if (isSupersedeRaceRefusal(state.transient, state.errMsg) && attempt < supersedeRetries) {
          attempt++;
          // exponential backoff (300ms, 600ms, 1200ms…) — a couple seconds of grace for the aborted run's finally
          // to release the shared workspace slot. Injected sleep so tests run instantly with a fake clock. The
          // record stays in `inflight` across this wait so a mid-backoff message can supersede us (checked next).
          await sleep(supersedeBackoffMs * Math.pow(2, attempt - 1));
          if (await abandoned()) { withdrawn = true; return; }
          continue;
        }
        break;
      }

      /* ---- THE WORK LINE: run every stage the Commander drew downstream of this dock -------------------
         resolveAgent picked WHICH dock; the belts past it say what happens to its output. Deliberately INSIDE
         the inflight try: myRec stays registered for the whole line, so E-STOP (halt.js reads this record) and
         a superseding message reach the downstream stages too — a chain that outlived its own abort handle
         would be an unstoppable spend. The reply that finally leaves is the LAST stage's. */
      if (chain && !state.errMsg && !myRec.superseded && String(state.buf || '').trim()) {
        const line = await chain.advance({
          agentId: agentId, dockId: dockId || undefined, text: state.buf, originalText: lineAsk || msg.text, runId: myRec.runId,
          // the entry run's reconciled spend: the chain's $ ceiling covers the whole line, stage one included
          // (2026-08-10 audit). `line.usd` stays hop-only, so onLineOutcome's accounting is unchanged.
          entryUsd: state.usd || 0,
          // WORK BELONGS TO A LINE: only work the floor routed in through this line's own INBOX advances it.
          // A /talk-bound or fallback-resolved message carries no lineId and stops at the dock that answered.
          lineId: lineId,
          // SEND TO (2026-10-10, additive): the job's stream and the time its entry run started, so a hand-off reads back exactly
          // this job's run rows (a channel chat's stream carries every earlier message too)
          streamId: canonicalStreamId || undefined, since: (typeof myRec.startedAt === 'number' ? myRec.startedAt : undefined),
          /* SEND TO VERDICTS (conveyor-backend-04): the verdicts this job's entry run and every hop below run under, stamped
             POSITIVE only and only here — this hub established them. A hand-off of this job (handoff-runner) runs the next line
             under the same ones; a seed without them (routines, Run Now, anything older) hands on as untrusted + withheld. */
          entryTrusted: lineEntryUntrusted ? undefined : true,
          hostPowerKept: (runChannelSender === true && runChannelSenderOwner !== true) ? undefined : true,   // run-origin.js hostPowerWithheldFor's own test
          signal: myRec.abort ? myRec.abort.signal : null,
          runAgent: async function (h) {
            // a hop is a plain autonomous run of ANOTHER agent: its OWN composed persona (never this channel's
            // configured system prompt — that belongs to the agent the connection names), its OWN bay station,
            // its OWN durable transcript. No consent keyboard: a downstream stage is machine-to-machine.
            // GRANTS LAW (2026-08-04): unattended grants never flow down a line — this call deliberately passes
            // NO unattendedGrants (a routine's grant names ONE agent; see cron-driver.js). `ownerTrusted` below
            // is different by design and stays: the owner initiated this line on their own channel.
            const hopRunId = newId();
            myRec.runId = hopRunId; myRec.agentId = h.agentId; myRec.startedAt = now ? now() : null;
            const hs = { buf: '', errMsg: null, usd: 0 };
            let hopConfig = {};
            if (resolveRunConfig) {
              try { hopConfig = resolveRunConfig(h.agentId); }
              catch (e) { return { text: '', usd: 0, error: 'target agent configuration failed: ' + ((e && e.message) || e) }; }
              if (!hopConfig || hopConfig.ok === false) {
                return { text: '', usd: 0, error: (hopConfig && hopConfig.error) || ('target agent ' + h.agentId + ' is not configured') };
              }
            }
            const hopSink = (name, payload) => {
              let p; try { p = redact(payload); } catch (_) { p = payload; }
              if (name === 'agent.run.end' && p && p.reason === 'cancelled') hs.stopped = true;   // STOP on this step: the line stops here, never hands its half answer on
              if (name === 'agent.token') hs.buf = joinReplyDelta(hs.buf, p.delta);
              else if (name === 'agent.tool_call') { hs.buf = ''; noteToolStep(); }   // a hop's step is this message's step too
              else if (name === 'agent.run.error') hs.errMsg = p.message || 'run error';
              else if (name === 'capdenied') hs.errMsg = hs.errMsg || ('no ' + (p.need || 'capability') + ' — ' + (p.reason || ''));
              else if (name === 'agent.run.end') { if (typeof p.usd === 'number' && isFinite(p.usd)) hs.usd = p.usd; }
            };
            // THIS chat's line history for THIS dock — never the agent's shared history (see hopHistoryKey)
            const hopKey = hopHistoryKey(chatId, lineId, h.dockId || h.agentId);
            let hist = [];
            try { hist = store.loadHistory(hopKey); } catch (_) {}
            try { store.appendTurn(hopKey, 'user', h.text); rememberHopKey(chatId, hopKey); } catch (e) { failNote('channels.hub.appendTurn', e); }
            try {
              await runOnce({
                key: hopConfig.key, model: hopConfig.model, provider: hopConfig.provider,
                baseUrl: hopConfig.baseUrl || hopConfig.base_url || '', reasoningEffort: hopConfig.reasoningEffort || hopConfig.reasoning_effort,
                system: hopConfig.system || personaFor(h.agentId, rec), messages: hist.map(m => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: h.text }]),
                agentId: h.agentId, lineId, isTask: true, emit: hopSink, signal: h.signal, runId: hopRunId, trigger: 'event',
                ceilingUsd: h.ceilingUsd,   // what is left of the line's $ ceiling (lower-only)
                streamId: canonicalStreamId || undefined, parallelBranch: !!h.parallel,   // the whole line shares one canonical transcript; a PARALLEL branch hop skips its one-turn-at-a-time queue (chain.js runBatch)
                resumeSeed: false,   // THIS dock's own history rides `hist` above; never the whole line stream's transcript (runOnceCore seed)
                initialTaint: 'upstream agent output',
                untrustedEntry: lineEntryUntrusted || undefined,   // a hop of a payload-started line stays under the taint lock
                surface: 'autonomous', ownerTrusted: ownerTrusted, broadcast: true, reflect: true,
                channelSender: runChannelSender, channelSenderOwner: runChannelSenderOwner,   // a hop keeps the entry sender's Full Power verdict
                // the hop's OWN dock room (multi-bay: never the union of the agent's bays)
                station: (resolveStation ? (h.dockId ? resolveStation(h.agentId, h.dockId) : resolveStation(h.agentId)) : null) || undefined,
                taskKey: 'chain:' + channel + ':' + chatId + ':' + h.agentId + (h.dockId ? '@' + h.dockId : ''), taskSource: channel,
                lineId: lineId || undefined, dockId: h.dockId || undefined, workitemId: h.workitemId || undefined   // LINE WATCH: the hop's line + bay on its run row (+ its crate on run.start)
              });
            } catch (e) { hs.errMsg = hs.errMsg || ('run failed: ' + ((e && e.message) || e)); }
            if (hs.buf.trim() && !hs.errMsg) { try { store.appendTurn(hopKey, 'assistant', hs.buf); } catch (e) { failNote('channels.hub.appendTurn', e); } }
            return { text: hs.buf, usd: hs.usd, error: hs.errMsg || (hs.stopped ? 'stopped by you' : null) };
          }
        });
        if (onLineOutcome) {
          // a throwing outcome hook is the HOST's bug (the trigger runner records every fire's truth through it): never
          // let it abort the reply, but never swallow it silently either — the failopen ledger names it
          // partial (additive): the JOINER sent on without every branch — the job is not clean, whatever its run rows say
          // unapproved (additive, GitHub #122): a review loop ran out of passes and sent the work on — delivered, never approved
          // outboxId (additive, 2026-10-15): the OUTBOX this job landed in (chain.js out.outboxId) — the only one a SEND TO hand-off
          // ever leaves from, so the sample route names only ITS destination to station.test_line (absent = unknown)
          try { const lo = { agentId: line.agentId, stopped: line.stopped || null, hops: line.hops.slice(), usd: line.usd }; if (line.dockId) lo.dockId = line.dockId; if (line.partial) lo.partial = String(line.partial); if (line.unapproved) lo.unapproved = String(line.unapproved); if (line.outboxId) lo.outboxId = String(line.outboxId); onLineOutcome(lo); } catch (e) { failNote('channels.hub.lineOutcome', e); }
        }
        if (!myRec.superseded && line.hops.length) {
          // the line's answer replaces the first stage's — and the floor/channel agree on who produced it
          firstStageText = state.buf;
          state.buf = line.text + chain.stopNote(line);
          finalAgentId = line.agentId;
        } else if (!myRec.superseded && line.stopped && line.stopped !== 'stopped') {
          state.buf = state.buf + chain.stopNote(line);   // stage one answered but the line never got going — say so
        }
      }
      if (await abandoned()) { withdrawn = true; return; }
      } finally {
        // release the (single) inflight record exactly once — but only if a NEWER message hasn't already replaced it
        // (the supersede path installs its own record under this chatId; clobbering it would drop the live run).
        if (inflight.get(chatId) === myRec) inflight.delete(chatId);
      }

      // persist the assistant turn only on a real, non-error reply; build the outgoing text.
      if (state.errMsg) {
        // an exhausted supersede-retry gets an HONEST channel reply (never the raw internal mutex message) — the
        // user's message was NOT lost silently; they can simply resend. Any other error surfaces its own message.
        // a harness-authored stop (loop guard, loop breaker, unkept promise…) leads with what happened + what to do
        const explained = StopReason.explainStop ? StopReason.explainStop(state.errMsg) : null;
        reply = isSupersedeRaceRefusal(state.transient, state.errMsg)
          ? '⚠ Still busy finishing your last message — please send that again in a moment.'
          : '⚠ ' + (explained ? explained.text : state.errMsg);
      } else if (!String(state.buf || '').trim() && (state.reason === 'empty' || !state.reason)) {
        // NOTHING came back. "(no reply)\n\n(stopped: empty)" read as a silent stop; say what happened and the way on.
        // the shared sentence (stop-reason.js) knows whether tools already ran — a file may be written even though the reply is empty
        const emptySentence = state.reason === 'empty' ? String(StopReason.stopSentence('empty', { toolsRan: state.toolsRan }) || '') : '';
        reply = state.reason === 'empty'
          ? '⚠ ' + emptySentence.charAt(0).toUpperCase() + emptySentence.slice(1).replace('switch model', 'switch model with /model') + '.'
          : '⚠ The run ended without a reply and without saying why — say "continue" to try again.';
      } else {
        reply = state.buf || '(no reply)';
        if (taskIntent) {
          const tq = taskIntent.parse(reply);
          if (tq) {
            const pre = taskIntent.strip(reply);
            // Carry the durable brief's REAL recommendation (brief_ask path) into the channel text. Marker-path
            // questions store no recommendation, so this line simply doesn't render — never fabricated here.
            // A GROUNDED suggestion (the Commander's own answered history, with a count) is provable, so it
            // outranks the model's guess here exactly as it does in COMMS — the surfaces must not disagree.
            let suggested = '';
            try {
              const b = briefFor ? briefFor('channel:' + channel + ':' + chatId) : null;
              const q = b && b.status === 'clarifying' && Array.isArray(b.questions) ? b.questions[b.questions.length - 1] : null;
              if (q && !q.answer && q.text === tq.question) {
                const g = groundedFor ? groundedFor(q) : null;
                if (g && g.option) suggested = '\nsuggested: ' + g.option + ' — you chose this ' + g.count + ' times before';
                else if (q.recommended) suggested = '\nsuggested: ' + q.recommended + (q.reason ? ' — ' + q.reason : '');
              }
            } catch (_) { /* enrichment only; the question always renders */ }
            // Register the tappable version FIRST — if the registry refuses (bounded/duplicate token), we simply
            // fall through to the numbered text below, which is a complete answer path on its own.
            if (buttonsOk && tq.options.length) {
              choiceEntry = prompts.create({
                kind: 'choice', chatId: chatId, chatType: msg.chatType,
                // label = short numbered echo (Telegram truncates long labels on a phone); value/display = the
                // FULL option text, which is what re-enters the conversation when tapped.
                options: tq.options.map((x, i) => ({ label: btnLabel(i + 1, x), value: String(x), display: String(x) })),
                meta: { question: tq.question }
              });
            }
            // The numbered list stays in the body even when buttons render: it is what makes a long option
            // readable (the button label had to be truncated), and it is the whole answer path on a channel
            // without keyboards. The closing line only promises typing when that is the ONLY way to answer.
            reply = (pre ? pre + '\n\n' : '') + tq.question + '\n'
              + tq.options.map((x, i) => (i + 1) + '. ' + x).join('\n')
              + suggested
              + (choiceEntry ? '\nTap a choice below — or reply in your own words.'
                             : tq.mode==='conversation' ? '\nReply in your own words, or say "use your judgment."' : '\nReply with a choice, or say "use your judgment."');
          }
        }
        /* AN AGENT'S TRANSCRIPT RECORDS WHAT THAT AGENT SAID. When a work line ran, `reply` is the LAST
           stage's text — writing it under the ENTRY dock would fabricate a turn: stage one never said it, and
           on the next message it would replay its own history as if it had. Each hop already persists its own
           output under its own id (and the delivering stage's transcript holds the delivered text), so the
           entry dock gets back what IT actually produced. */
        const ownReply = (firstStageText != null) ? firstStageText : reply;
        if (ownReply) { try { store.appendTurn(agentId, 'assistant', ownReply); } catch (e) { failNote('channels.hub.appendTurn', e); } }
        if (state.reason) reply += endNote(state.reason, state);   // 'done' adds a note only when the provider cut the reply short
      }

      // all three die BEFORE deliver — none of them may outlive the reply it announced. The stream is ABANDONED
      // (its partial deleted) only when the run was withdrawn; on every other path deliver() finishes it in place.
      } finally { stopTyping(); clearAck(); if (stream && withdrawn) stream.abandon(); }
      // seal() hands deliver() the streamed message so chunk 0 replaces it in place. It also closes the stream,
      // so a late token delta can never race the final text back out of order.
      const dr = await deliverHeld(chatId, reply, lastRunId, state.errMsg ? 'error' : (state.reason || 'done'), finalAgentId,
        choiceEntry ? { reply_markup: keyboardFor(choiceEntry) } : undefined, stream ? stream.seal() : '', inboxIds);
      // Stitch the delivered message onto the keyboard's registry entry so a tap can edit THAT message in place.
      // A send that failed retires the token immediately: leaving it would let a phantom keyboard (buttons the
      // user can see from a partially-sent reply) resolve against a question they never fully received.
      if (choiceEntry) {
        if (dr && dr.ok && dr.messageId) { prompts.attach(choiceEntry.token, dr.messageId); choiceEntry.meta.text = dr.text || reply; }
        else if (!dr || !dr.ok) prompts.take(choiceEntry.token);
      }
    }

    // ---- inline-keyboard taps (C6) -------------------------------------------------------------------------
    // One tap = { chatId, userId, data, callbackId, messageId }. The adapter has ALREADY owner-gated this (a
    // non-owner's tap never reaches here), so this is the display/decision hop only. Order matters and mirrors
    // the reference harness: resolve the token (single-use) → ACK the tap → stamp the message → act.
    //
    // The ack is not optional politeness: until answerCallbackQuery lands, Telegram spins a loader on the button
    // and eventually shows the user a client-side error, so an unacked tap reads as a broken bot even when the
    // decision was recorded perfectly. It therefore happens BEFORE the (slower, failure-prone) edit and action.
    async function onCallback(cb) {
      if (!cb || !prompts || !answerCallback) return;
      const chatId = String(cb.chatId == null ? '' : cb.chatId);
      const ack = async (text) => { try { await answerCallback(cb.callbackId, text); } catch (_) {} };

      const hit = prompts.parse(cb.data);
      if (!hit) { await ack(); return; }   // a stale keyboard from an older build — ack so the spinner stops

      // SINGLE-USE. A double-tap, a tap on a question the conversation already moved past, and a tap that lost
      // the race with a typed answer all land here. Say so plainly rather than silently doing nothing — and
      // never re-run a decision. The chatId re-check makes a token from one chat unusable in another.
      const entry = prompts.take(hit.token);
      if (!entry || entry.chatId !== chatId) { await ack('That question is no longer open.'); return; }
      const opt = entry.options[hit.idx];
      if (!opt) { await ack('That option is no longer available.'); return; }

      // Only add the tick when the label doesn't already open with its own marker — a consent button reads
      // "✅ Allow for this session", and prefixing that produced a doubled "✓ ✅" in the live toast.
      const shown = String(opt.display || opt.label).trim().slice(0, 60);

      /* SETTLE A CONSENT TAP BEFORE WRITING ANYTHING THAT CLAIMS IT LANDED. Both the ack toast and the
         message stamp assert the decision took effect, and both used to be written BEFORE the host was asked
         whether the decision was still live — so a tap that lost the race with the fail-closed timer (or with
         E-STOP, or with a superseding message) left the permission message permanently rewritten to end
         "▸ ✅ Allow once" on a request the harness had DENIED. A follow-up correction was sent, so the chat
         read in order was honest, but the permanent record of a security decision — the thing a Commander
         scrolls back to — said the opposite of what happened.
         resolveConsent is a local in-memory settle (consentwait.js), not a network hop, so asking first costs
         nothing against the spinner deadline the early ack exists for. */
      let lostRace = false;
      if (entry.kind === 'consent') {
        let done = false;
        try { done = !!resolveConsent(entry.meta.runId, entry.meta.promptId, opt.value); } catch (_) { done = false; }
        lostRace = !done;
      }
      // A lost race is not always a denial: the same ask may have been ALLOWED on another surface (STARNET REMOTE) a moment
      // before this tap — stamping that "expired — DENIED" contradicted an action that ran (2026-10-20).
      let allowedAs = '';
      if (lostRace && consentOutcome) {
        try { const d = String(consentOutcome(entry.meta.runId, entry.meta.promptId) || ''); if (/^(once|session|always|full)$/.test(d)) allowedAs = d; } catch (_) { allowedAs = ''; }
      }
      await ack(allowedAs ? '✓ Already answered elsewhere — allowed' : lostRace ? '⚠ Already expired — denied' : ((/^[\p{L}\p{N}]/u.test(shown) ? '✓ ' : '') + shown));

      // Stamp the OUTCOME into the original message and strip the spent buttons. Cosmetic ONLY in the sense
      // that the decision is already recorded whether or not this edit lands (Telegram 400s a no-op edit, and
      // the message may have been deleted by the user) — which is why it is fired inside its own guard and its
      // result is not read. What it must never be is a different answer from the one the broker applied.
      if (editMessage && entry.messageId) {
        const outcome = allowedAs
          ? '▸ already answered in StarNet — ALLOWED (' + allowedAs + ')'
          : lostRace
          ? '▸ ⚠ expired — DENIED, the run moved on'
          : '▸ ' + String(opt.display || opt.value);
        try { await editMessage(chatId, entry.messageId, String(entry.meta.text || '') + '\n\n' + outcome, {}); } catch (_) {}
      }

      if (entry.kind === 'consent') {
        // The host had already settled it — the fail-closed timer fired, the run was superseded, or E-STOP hit.
        // Telling the user their tap landed would be a lie about what the harness actually did.
        if (lostRace && !allowedAs) { try { await deliver(chatId, '⚠ That permission request had already expired — the action was denied and the run moved on.', entry.meta.runId || '', 'prompt'); } catch (_) {} }
        return;
      }

      // A CHOICE tap re-enters the NORMAL inbound path carrying the option's own text — byte-identical to the
      // Commander having typed that option. So history, agent routing, Task Brief continuity and the run itself
      // are all exactly the typed-answer path; there is no second, divergent "button answer" code path to keep
      // in sync. (processInbound is fire-and-forget from the adapter's perspective; a throw here must not escape
      // into the poll loop, hence the guard.)
      try {
        await processInbound({
          channel: channel, chatId: chatId, chatType: entry.chatType,
          userId: cb.userId == null ? '' : String(cb.userId), userName: '',
          text: opt.value, messageId: '', ts: now ? now() : 0
        });
      } catch (e) {
        try { console.error('[' + channel + '] choice tap failed for chat ' + chatId + ':', (e && e.message) || e); } catch (_) {}
      }
    }

    // adapter transport health -> channel.connect telemetry (poll up / network down / fatal token error).
    // An 'up' is also the durable-outbox recovery cue: the transport just PROVED a round-trip, so any reply
    // queued while it was down (or while the sidecar was off — the outbox survives restarts) redelivers now.
    function onStatus(s) {
      try { emit('channel.connect', { channel, state: (s && s.state) || 'down', detail: (s && s.detail) || '' }); } catch (_) {}
      if (s && s.state === 'up') {
        try { kickOutbox(); } catch (_) {}
        try { const p = recoverInbox(); if (p && typeof p.catch === 'function') p.catch(function () {}); } catch (_) {}
      }
    }

    /* OUR OWN MEMBERSHIP CHANGED — we were blocked, kicked, or let back in.
       This was invisible before: the notifier went on posting into a chat that could never receive it, every
       send failed, every failure queued another retry, and nothing in the product ever said why. The DETECTION
       was deliberately not built alone — a stamped field with no reader is one of this project's named bug
       classes — so it lands here with its consumer:

         · the chat is marked `unreachable`, which stops deliver() queueing anything new for it;
         · its already-queued backlog is dropped NOW, each with the same honest `redelivery-gave-up` delivery
           event a repeatedly-failed item gets. It is the same fact — we are not going to deliver this — and
           inventing a new event name would mean editing the owned shared/events.js contract.

       Clearing is not done here: `left` can arrive for reasons that are not a block, so the flag is lifted by
       the chat actually speaking again (processInbound), which is proof rather than inference. */
    function onMembership(ev) {
      const chatId = String((ev && ev.chatId) || '');
      const status = String((ev && ev.status) || '');
      if (!chatId || !status) return;
      const gone = status === 'kicked' || status === 'left';
      if (!gone) return;                                    // added/promoted/restricted: nothing to stop doing
      /* A GROUP THAT REMOVED US IS NO LONGER ADMITTED. The owner's /allow admitted the room as it was; whoever adds the
         bot back later (any group admin) must not re-open the owner's station to it without a fresh /allow there. Only
         an admission THIS channel granted is withdrawn — the chat map is shared across platforms (chatAdmitted). */
      const patch = { unreachable: true };
      if (String((ev && ev.chatType) || '') === 'group' && chatAdmitted(chatId)) patch.admittedOn = '';
      try { if (typeof store.saveChatRecord === 'function') store.saveChatRecord(chatId, patch); } catch (e) { failNote('channels.hub.chatRecord.save', e); }
      try { console.error('[' + channel + '] chat ' + chatId + ' has ' + (status === 'kicked' ? 'blocked or banned' : 'removed') + ' this bot — queued replies for it are being dropped'); } catch (_) {}
      if (typeof store.loadOutbox !== 'function' || typeof store.removeOutbox !== 'function') return;
      let items = [];
      try { items = store.loadOutbox(channel) || []; } catch (_) { items = []; }
      for (const it of items) {
        if (String(it.chatId) !== chatId) continue;
        try { store.removeOutbox(it.id); } catch (e) { failNote('channels.hub.outbox.remove', e); }
        try { emit('channel.delivery', { channel, chatId: chatId, runId: it.runId || '', ok: false, chunks: 0, reason: 'redelivery-gave-up' }); } catch (_) {}
      }
    }

    return {
      onInbound, onCallback, onStatus, onMembership, close, chatAdmitted,
      _internals: { agentIdFor, chunkText, endNote, deliver, inflight, handleCommand, currentBoundAgent, isSupersedeRaceRefusal, flushOutbox, scheduleOutboxRetry, recoverInbox, activeInbox, inboxId, OUTBOX_ESCALATE_TRIES, TASK_SUFFIX, DEFAULT_PERSONA, keyboardFor, btnLabel, sendConsentPrompt, buttonsOk, replyPreamble, MAX_REPLY_MEDIA, noteRoute, routeOpts, routes, MAX_ROUTES, editIsCurrent, startAck, ACK_EMOJI, observeTurn, startStream, streamOk, notModified }
    };
  }

  return { makeChannelHub, dockSystem, joinReplyDelta, chunkText, chunkTextParts, endNote, parseCommand, parseUserCommand, matchAgent, fmtAgentLine, isSupersedeRaceRefusal, coerceChoice, menuCommands, helpText, replyPreamble, REPLY_QUOTE_MAX, COMMANDS, commandNeedsOwner, _internals: { TASK_SUFFIX, DEFAULT_PERSONA, NOTE_CMDS, parseCommand, matchAgent, fmtAgentLine, isSupersedeRaceRefusal, coerceChoice, menuCommands, helpText, replyPreamble, COMMANDS } };
});
