/* sidecar/providers/claude-cli.js — the local Claude Code CLI (`claude`) as a brain.

   Instead of an HTTP call, a turn is a `claude -p` child process fed on stdin, whose `--output-format stream-json`
   lines are translated into the LLMProvider HarnessEvents (provider.js). An agent-loop turn rides ONE persistent child
   per run and sends only what is new since the last turn (see PERSISTENT CHILD); any other call — and every turn
   under STARNET_CLAUDE_CLI_PERSIST=0 — spawns its own one-shot child with the whole transcript. Text streams only
   while the CLI is answering, and exactly one 'done' is emitted when the turn has really ended with a result — the
   station never animates a brain that is not running.

   CAPABILITY BOUNDARY. The CLI is an agent with its own tools (Bash, Edit, MCP connectors…). Letting it use them
   would bypass StarNet's capability gate and consent broker, so the child is started with NO tools at all:
   `--tools ""`, an empty `--strict-mcp-config`, no skills/slash commands, no setting sources, no session file.
   StarNet's own tools are described in the system prompt, and the model requests them with
   <tool_call>{"name":…,"arguments":{…}}</tool_call> blocks. This adapter turns those blocks into the ordinary
   tool_start/tool_args/tool_done events, so loop.js executes them through the same gate as every other provider.

   COST TRUTH. The CLI's final `result` line carries real usage and `total_cost_usd`. Its `init` line says how it
   is authenticated: apiKeySource 'none' = a Claude subscription login (Pro/Max), which bills nothing per call,
   so the turn is booked at $0 with its real token counts; any API-key source bills real money, so the CLI's
   reported cost is booked as the provider cost (cost.js `usage.cost`).

   STOP. Aborting req.signal kills the child's whole process tree (taskkill /T on Windows) before returning.

   ACCOUNTS. `configDir` points the CLI at one extra sign-in (subscription stacking): the child runs with
   CLAUDE_CONFIG_DIR=<configDir>, a separate CLI identity whose credential the CLI keeps in that folder (proven:
   an empty folder answers `auth status` signed out while ~/.claude stays signed in). No configDir = the CLI's
   own default sign-in. A spent subscription (the CLI's `error:"rate_limit"` line, "You've hit your limit") is
   thrown as a 429 `usage_limit_reached`, which errorClass files as quota_exhausted: the loop rotates to the next
   account instead of retrying this one.

   makeClaudeCliProvider({ spawn?, bin?, env?, configDir?, platform?, fs?, os?, idleMs?, statusTtlMs?, persist?, persistIdleMs?, persistEndGraceMs?, onRateLimit? })
     onRateLimit(info): each run's `rate_limit_event` (its rate_limit_info: this sign-in's usage windows) — sub-usage.js
     -> { stream, listModels, release, persistStats, contextLimit, priceOf, supportsTools, reasoningEfforts } */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'));
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).claudeCli = factory(root.SK.providers.provider); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider) {
  'use strict';

  const timeouts = provider.timeouts;
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  const DEFAULT_CONTEXT = 200000;
  /* What `claude --model` runs on a subscription sign-in — every id here was proven live 2026-09-29 (a one-line call
     each; the CLI answered on exactly that model). Named models first; the `[1m]` ids are the CLI's own 1M-context
     variants. The bare aliases come last: they always follow the newest model of each family, and they stay listed
     because a station pinned to one (every claude-cli station before this list) must keep a model the catalog
     proves — ModelDock clears a pin the live catalog no longer carries. Fable is left out on purpose: the CLI
     accepts it but an account without Fable is silently served Opus 4.8, so listing it would name a model the run
     did not use. */
  const MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    { id: 'claude-opus-5-5[1m]', name: 'Claude Opus 5.5 · 1M context', context: 1000000 },
    { id: 'claude-sonnet-5-5[1m]', name: 'Claude Sonnet 5.5 · 1M context', context: 1000000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'opus', name: 'Latest Claude Opus · follows new releases' },
    { id: 'sonnet', name: 'Latest Claude Sonnet · follows new releases' },
    { id: 'haiku', name: 'Latest Claude Haiku · follows new releases' }
  ];
  const contextOf = id => { const m = MODELS.find(x => x.id === String(id || '')); return (m && m.context) || (/\[1m\]$/i.test(String(id || '')) ? 1000000 : DEFAULT_CONTEXT); };
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const CALL_OPEN = '<tool_call>';
  const CALL_CLOSE = '</tool_call>';
  const NO_TOOLS_ARGS = [
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence'
  ];

  /* IMAGES (2026-10-08). The CLI's stream-json INPUT takes Anthropic content blocks, images included (proven live:
     Opus read a thumbnail's headline through `claude -p --input-format stream-json`). Every turn rides stream-json
     since 2026-10-12 (see PROMPT CACHE at splitPrompt); an image follows the transcript entry it came in.
     An image the API cannot take (an unsupported type, an unreadable reference, past the per-turn cap) keeps a note
     in its place: the model is told a picture was there, never handed a description of one it did not get. */
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const MAX_IMAGES = 20;   // the newest are sent; the loop already ages old screenshots out (TOOL_IMAGE_KEEP)
  const IMAGE_MARK = '\u0000starnet-image-';
  function imageBlockOf(p) {
    let s = p && p.type === 'image_url' ? (p.image_url && (p.image_url.url != null ? p.image_url.url : p.image_url)) : null;
    if (p && p.type === 'image' && p.source && typeof p.source === 'object') {
      const src = p.source;
      if (src.type === 'base64' && IMAGE_TYPES.indexOf(String(src.media_type || '').toLowerCase()) >= 0 && src.data) return { type: 'image', source: { type: 'base64', media_type: String(src.media_type).toLowerCase(), data: String(src.data) } };
      if (src.type === 'url' && /^https?:\/\//i.test(String(src.url || ''))) return { type: 'image', source: { type: 'url', url: String(src.url) } };
      return null;
    }
    s = String(s == null ? '' : s);
    const m = /^data:([^;,]*?);base64,([\s\S]+)$/i.exec(s);
    if (m) {
      const media = (m[1] || '').toLowerCase().replace('image/jpg', 'image/jpeg');
      return IMAGE_TYPES.indexOf(media) >= 0 ? { type: 'image', source: { type: 'base64', media_type: media, data: m[2].replace(/\s+/g, '') } } : null;
    }
    if (/^https?:\/\//i.test(s)) return { type: 'image', source: { type: 'url', url: s } };
    return null;
  }

  // `images`, when given, collects each sendable image and leaves a mark where it sat (buildPrompt resolves the marks).
  function textOf(content, images) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return typeof content.text === 'string' ? content.text : '';
    const parts = [];
    for (const p of content) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p.text === 'string') parts.push(p.text);
      else if (p && (p.type === 'image_url' || p.type === 'image')) {
        const block = images ? imageBlockOf(p) : null;
        if (block) { parts.push(IMAGE_MARK + images.length + '\u0000'); images.push(block); }
        else parts.push('[image attachment omitted — it could not be sent to the Claude Code brain]');
      }
    }
    return parts.join('\n');
  }

  // Each tool as the prompt lists it: { name, line }.
  function toolLines(tools) {
    const list = [];
    for (const item of (Array.isArray(tools) ? tools : [])) {
      const fn = (item && item.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      list.push({ name, line: '- ' + name + (fn.description ? ': ' + String(fn.description).trim() : '') +
        '\n  parameters: ' + JSON.stringify(fn.parameters || { type: 'object', properties: {} }) });
    }
    return list;
  }
  function toolsPrompt(tools) {
    const list = toolLines(tools).map(t => t.line);
    // A turn with NO tools still says so: a Claude Code model told about station powers in the system prompt otherwise
    // improvises its own native tool-call markup as TEXT (live 09-28: '<invoke name="Bash">…' leaked into a chat reply).
    if (!list.length) return '# Tools\nNo tools are available in this turn. Answer in plain prose only: never write tool-call markup (<tool_call>, <invoke>, <function_calls>) and never claim to have run anything.';
    /* THE MODEL'S OWN CALL FORMAT (2026-10-02). The protocol used to be <tool_call>{json}</tool_call>, and Claude
       drifted back to the <invoke>/<parameter> markup it is trained on (live: a whole game written as <invoke
       name="fs_write"> blocks the adapter could not see — nothing ran, and the run read as "every tool result came
       back empty"). Asking for the format it already writes ends the drift, and a raw parameter value carries a
       file as-is, with none of the JSON escaping that broke big writes. <tool_call> blocks are still understood. */
    return [
      '# Tools',
      'You cannot execute anything yourself; StarNet runs tools for you. To call tools, end your reply with a block exactly like:',
      '<function_calls>',
      '<invoke name="TOOL_NAME">',
      '<parameter name="PARAM_NAME">value</parameter>',
      '</invoke>',
      '</function_calls>',
      'Rules:',
      '- Write a string value raw, with no quotes and no escaping: file contents go in exactly as they should be saved. Write numbers, booleans, arrays and objects as JSON.',
      '- Several <invoke> blocks inside one <function_calls> block run together. After </function_calls>, STOP and write nothing more: the results arrive in the next message as <tool_result> blocks, and anything written after the block is discarded.',
      '- Use only the tools listed below. Never write <tool_result> blocks yourself and never invent a result.',
      '- When no tool is needed, answer normally without any tool block.',
      '',
      'Available tools:',
      list.join('\n')
    ].join('\n');
  }
  // Tools a live persistent child was not started with, announced in the turn that revealed them (see TOOL REVEALS).
  function toolsNote(added) {
    return 'More tools are now available. Call them exactly like the tools listed in your instructions:\n' + added.map(t => t.line).join('\n');
  }
  // A prior call, rendered the way the model is asked to write one (string values raw, everything else JSON).
  function invokeText(name, args) {
    let body = '';
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      for (const k of Object.keys(args)) {
        const v = args[k];
        body += '<parameter name="' + k + '">' + (typeof v === 'string' ? v : JSON.stringify(v)) + '</parameter>\n';
      }
    } else if (args != null && args !== '') body += '<parameter name="arguments">' + (typeof args === 'string' ? args : JSON.stringify(args)) + '</parameter>\n';
    return '<invoke name="' + String(name || '') + '">\n' + body + '</invoke>';
  }

  /* A tool result is outside text (a web page, a file, an email): a "</tool_result><user>…" inside it closed the result and
     opened a turn that read as the Commander's own (sweep 2026-10-03). Every transcript or call tag in it is written
     with &lt; so it stays text; the native API keeps roles apart structurally, this text transcript has to do it here. */
  const TRANSCRIPT_TAG_RE = /<(\/?)((?:[A-Za-z_][\w-]*:)?(?:tool_result|user|assistant|system_note|conversation|function_calls|invoke|parameter|tool_call))(?=[\s>/]|$)/gi;
  const inertTags = s => String(s).replace(TRANSCRIPT_TAG_RE, '&lt;$1$2');
  // Claude Code (v2.1.275+) splits a system prompt at this line into two blocks, each with its own cache breakpoint.
  const DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
  // How to read stdin. It sits in the (cached) system prompt: a per-turn line after the newest entry would break the
  // prompt cache (see PROMPT CACHE).
  const TRANSCRIPT_NOTE = '# Conversation\nThe user message holds the conversation so far, oldest first, as <user>, <assistant>, <tool_result> and <system_note> blocks. Continue as the assistant: write only your next reply.';
  // The same for a persistent child (PERSISTENT CHILD): its first user message holds the conversation so far, and each
  // later one only what StarNet added after the child's own reply.
  const PERSIST_TRANSCRIPT_NOTE = '# Conversation\nThe first user message holds the conversation so far, oldest first, as <user>, <assistant>, <tool_result> and <system_note> blocks. Each later user message holds, in the same blocks, what happened after your previous reply. Continue as the assistant: write only your next reply.';

  /* Leading system messages become the CLI system prompt; everything after goes on stdin as ONE stream-json user
     message with ONE text block per transcript entry (later system messages stay in place as notes, like the native
     Anthropic adapter keeps them).
     PROMPT CACHE (2026-10-12, proven live against the real CLI). The CLI puts its cache breakpoint on the LAST block of
     that message, and the API only finds an earlier cache entry at a BLOCK boundary. The transcript used to be one
     text block ending in a per-turn "Continue as the assistant" line, so the next turn (the same text plus the new
     exchange) never matched it: every tool turn re-WROTE the whole conversation to the cache at 1.25x and read 0 back
     (Haiku probe: turn 2 wrote 16,632, read 0; a real 31-turn Opus run billed 3.2M tokens that way). With one block per
     entry and nothing after the newest one, turn N's prompt is a block-for-block prefix of turn N+1's (the same probe:
     read 16,550, wrote 21). So: no per-turn suffix block (TRANSCRIPT_NOTE carries the instruction), consecutive tool
     results share one block (the API looks back only ~20 blocks for an earlier entry), and an image's number is its
     place in the whole conversation, so a new image never renumbers an old one.
     A persistent child (PERSISTENT CHILD) gets the same blocks: the whole transcript when it starts, then only the
     entries that are new since its reply, as its next user message. */
  function splitPrompt(messages, tools, cachePrefix, transcriptNote) {
    // host-fence tags (<run_context>, <recalled-memory>, <conversation_summary>) in user/tool text and inside a note's
    // body are written inert (provider.js INERT HOST FENCES): this transcript is ONE text, so a forged close would read as host text
    messages = provider.repairToolPairs(provider.inertHostFences(Array.isArray(messages) ? messages : []));
    const system = [];
    let i = 0;
    // The per-run <run_context> note ENDS the leading block (as in provider.preserveClaudeContinuations): on a first
    // message nothing but the system prompt precedes it, and swallowing it (and the recall after it) put the run id in
    // the CLI system prompt, so message 1's system differed from message 2's and the next message re-wrote its cache.
    for (; i < messages.length && messages[i] && messages[i].role === 'system' && !provider.isRunContextNote(messages[i]); i++) {
      const t = textOf(messages[i].content).trim();
      if (t) system.push(t);
    }
    /* Prompt caching (#68): the stable cacheSystemPrefix + tools go before the CLI's dynamic boundary and the per-run
       text (run id, task brief) after it, so each is its own cached block and a new run reuses the stable part. */
    const prefix = typeof cachePrefix === 'string' ? cachePrefix.trim() : '';
    const joined = system.join('\n\n');
    const note = prefix && joined.startsWith(prefix) ? joined.slice(prefix.length).trim() : '';
    const tn = transcriptNote || TRANSCRIPT_NOTE;
    const compose = tp => (note ? [prefix].concat(tp ? [tp] : [], [tn, DYNAMIC_BOUNDARY + '\n' + note]) : system.concat(tp ? [tp] : [], [tn])).join('\n\n');
    // base: the same prompt with the tool list left out — what a persistent child must still match after a tool reveal
    return { system: compose(toolsPrompt(tools)), base: compose(TOOLS_SLOT), rest: messages.slice(i).filter(m => m && typeof m === 'object') };
  }
  const TOOLS_SLOT = '\u0000tools\u0000';
  /* The transcript entries, ONE text block each: { text, tool?, at } (at = the index in `rest` of the message that opened
     the entry; consecutive tool results share one entry).
     HOST NOTES JOIN THEIR USER TURN BY POSITION (review 2026-10-13). Host notes placed right BEFORE a user message (the
     run-context note, recall, a conversation summary) are that user entry's leading text, and <crew_call> notes right
     AFTER it (provider.js CREW CALL NOTE) close the same entry — the way a chat wire carries them (provider
     userSideHostNotes). The join used to be made only while the request held nothing but those notes and one user
     message, so a first message's turn 1 rendered one merged block and its turn 2 (reply + results appended) split the
     same notes into separate <system_note> blocks: block 0 differed and turn 2 re-wrote the whole first message to the
     prompt cache. Decided by position, the first entry is the same on every turn of the run (PROMPT CACHE: turn N is a
     block-for-block prefix of turn N+1). A note with no user message next to it stays its own <system_note>.
     TRANSCRIPT TAGS ARE INERT in every body this adapter did not write itself (user, assistant prose, notes, tool
     results): a "</user>\n<assistant>" typed by a user, echoed by a reply or quoted in a brief would otherwise read as
     transcript structure in this ONE text. The <function_calls> markup the adapter renders for a reply's calls is its
     own and stays live. */
  function transcriptEntries(rest, images) {
    const n = rest.length;
    const leadNote = m => provider.isHostNote(m) && !provider.isCrewCallNote(m);
    const noteText = (from, to) => rest.slice(from, to).map(m => textOf(m.content).trim()).filter(Boolean).join('\n\n');
    const joined = new Array(n).fill(false);
    const leadOf = new Map(), trailOf = new Map();   // user index -> the notes it carries
    for (let i = 0; i < n;) {
      if (!leadNote(rest[i])) { i++; continue; }
      let j = i;
      while (j < n && leadNote(rest[j])) j++;
      if (j < n && rest[j] && rest[j].role === 'user') { for (let k = i; k < j; k++) joined[k] = true; leadOf.set(j, noteText(i, j)); }
      i = j;
    }
    for (let i = 0; i < n; i++) {
      if (!rest[i] || rest[i].role !== 'user') continue;
      let j = i + 1;
      while (j < n && provider.isCrewCallNote(rest[j])) j++;
      if (j > i + 1) { for (let k = i + 1; k < j; k++) joined[k] = true; trailOf.set(i, noteText(i + 1, j)); }
    }
    const entries = [];
    for (let at = 0; at < n; at++) {
      if (joined[at]) continue;
      const m = rest[at];
      if (m.role === 'user') {
        const lead = leadOf.get(at) || '', trail = trailOf.get(at) || '';
        entries.push({ text: '<user>\n' + inertTags((lead ? lead + '\n\n' : '') + textOf(m.content, images) + (trail ? '\n\n' + trail : '')) + '\n</user>', at });
      }
      else if (m.role === 'system') entries.push({ text: '<system_note>\n' + inertTags(textOf(m.content, images)) + '\n</system_note>', at });
      else if (m.role === 'tool') {
        const t = '<tool_result id="' + String(m.tool_call_id || '') + '">\n' + inertTags(textOf(m.content)) + '\n</tool_result>';
        const last = entries[entries.length - 1];
        if (last && last.tool) last.text += '\n' + t; else entries.push({ text: t, tool: true, at });
      }
      else if (m.role === 'assistant') {
        let body = inertTags(textOf(m.content));
        const calls = [];
        for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
          const fn = (tc && tc.function) || {};
          let args = fn.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch (_) { args = String(args); } }
          calls.push(invokeText(fn.name, args == null ? {} : args));
        }
        if (calls.length) body += (body ? '\n' : '') + '<function_calls>\n' + calls.join('\n') + '\n</function_calls>';
        entries.push({ text: '<assistant>\n' + body + '\n</assistant>', at });
      }
    }
    return entries;
  }
  // The whole conversation as ONE stream-json user message: what a one-shot child, or a persistent child that has just
  // started, is given.
  function renderTranscript(system, rest) {
    const images = [];
    return withBlocks(system, transcriptEntries(rest, images), images);
  }
  function buildPrompt(messages, tools, cachePrefix) {
    const sp = splitPrompt(messages, tools, cachePrefix);
    return renderTranscript(sp.system, sp.rest);
  }
  /* What a live persistent child has not seen yet: the entries of every message after its own reply (rest[n]), as ONE
     user message in the same blocks; `notes` (a tool reveal) close it as <system_note> entries. Images keep their
     number in the whole conversation. null = nothing to send. */
  function renderDelta(rest, n, notes) {
    const images = [];
    const entries = transcriptEntries(rest, images).filter(e => e.at > n);
    for (const t of notes || []) entries.push({ text: '<system_note>\n' + t + '\n</system_note>', at: rest.length });
    return entries.length ? withBlocks('', entries, images) : null;
  }
  // One transcript message, by value: a persistent child is reused only while every message it holds is unchanged.
  function fingerprint(m) {
    return require('crypto').createHash('sha1').update(JSON.stringify([m.role, m.content == null ? null : m.content, m.tool_calls || null, m.tool_call_id || null, m.name || null])).digest('hex');
  }
  const canonArgs = a => {
    if (typeof a !== 'string') return JSON.stringify(a == null ? {} : a);
    try { return JSON.stringify(JSON.parse(a || '{}')); } catch (_) { return a; }
  };
  // Did the loop record the reply the child wrote exactly as it was handed over (same text, same calls, same args)?
  function sameReply(m, p) {
    if (!m || m.role !== 'assistant' || textOf(m.content) !== p.text) return false;
    const tc = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (tc.length !== p.calls.length) return false;
    return tc.every((c, i) => {
      const fn = (c && c.function) || {};
      return !!c && c.id === p.calls[i].id && String(fn.name || '') === p.calls[i].name && canonArgs(fn.arguments) === canonArgs(p.calls[i].args);
    });
  }
  /* Every live persistent child, so an exiting sidecar never leaves one behind (each also ends by itself when its stdin
     closes). The CLI keeps helper processes of its own (a cmd.exe + conhost.exe were seen under one), so on Windows the
     tree goes with a SYNCHRONOUS taskkill /T (an exit handler cannot wait on anything async) of the child's OWN pid;
     only a real ChildProcess is ever killed by pid. */
  /* LIVE maps each child to the synchronous removal of its system-prompt temp file (review 2026-10-13: the exit hook
     killed a parked child's tree but left %TEMP%\starnet-claude-cli-*.txt behind, holding the whole system prompt —
     persona, rules, tool list, task brief). A one-shot child is registered for its turn too, so a sidecar exiting
     mid-turn neither leaves it running nor leaves its prompt file. */
  const LIVE = new Map();
  let exitHooked = false;
  function hookExit() {
    if (exitHooked || typeof process === 'undefined' || typeof process.once !== 'function') return;
    exitHooked = true;
    process.once('exit', () => {
      const cp = require('../child-env.js').guardChildProcess(require('node:child_process'));   // ChildProcess stays reachable through the guard's prototype
      for (const [c, unlinkPrompt] of LIVE) {
        // observed exit: its pid may already be reused, so it is never killed — but its prompt file still goes
        if (c.exitCode == null && c.signalCode == null) {
          try {
            if (process.platform === 'win32' && c instanceof cp.ChildProcess && c.pid && c.exitCode == null) {
              cp.spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            } else c.kill();
          } catch (e) { failNote('claudecli.persist.exit', e); }
        }
        if (typeof unlinkPrompt === 'function') { try { unlinkPrompt(); } catch (e) { failNote('claudecli.persist.exit.unlink', e); } }
      }
      LIVE.clear();
    });
  }

  /* The stdin message: each entry's text block, its images right after it. The newest MAX_IMAGES images become
     numbered blocks ("[image 3 — attached below]" in place), older ones a note. `input` is one stream-json user
     message; `blocks` is its content. */
  function withBlocks(system, entries, images) {
    const first = Math.max(0, images.length - MAX_IMAGES);
    const blocks = [];
    let imageCount = 0;
    for (const e of entries) {
      const after = [];
      const text = e.text.replace(/\u0000starnet-image-(\d+)\u0000/g, (_, k) => {
        const idx = Number(k);
        if (idx < first) return '[earlier image no longer attached]';
        after.push({ type: 'text', text: 'Image ' + (idx + 1) + ':' }, images[idx]);
        return '[image ' + (idx + 1) + ' — attached below]';
      });
      blocks.push({ type: 'text', text }, ...after);
      imageCount += after.length / 2;
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '<user>\n(no messages yet)\n</user>' });
    return { system, input: JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n', blocks, imageCount };
  }

  /* STREAMING CALL READER. Prose passes through as soon as it cannot be the start of a call; a call is announced
     ({ start: name }) the moment its tool name has streamed in, and its body follows when it closes ({ body }). Two
     shapes are read: <invoke name="…"><parameter name="…">…</parameter></invoke>, optionally inside <function_calls>
     (the format the prompt asks for), and the older <tool_call>{json}</tool_call>.
     WHY ANNOUNCE EARLY (2026-10-02, reproduced live): a turn that writes a game is ONE call holding the whole file;
     the adapter yielded nothing until it closed, and the run read "waiting for 6:15" with no sign of life.
     WHY STOP ({ stop: true }): the API ends a turn at the close of its call block and waits for the results. Here
     `claude -p` runs with no tools, so nothing stops it: the model wrote a call, heard nothing back, wrote the next
     one on a guess, and finally told the Commander "every tool result is coming back empty". The reader ends the
     turn when the call block is over: at </function_calls>, or at the first thing after a call that is not another
     call. Anything the model writes past that point is a guess at results it has not seen. */
  const PFX = '(?:[A-Za-z_][\\w-]*:)?';   // a tag may carry a namespace prefix
  const OPEN_RE = new RegExp('<tool_call>|<' + PFX + 'function_calls>|<' + PFX + 'invoke\\s+name="([^"]{1,200})"\\s*>');
  const INVOKE_CLOSE_RE = new RegExp('</' + PFX + 'invoke>', 'g');
  const WRAP_CLOSE_RE = new RegExp('^</' + PFX + 'function_calls>');
  // A value is written RAW, so it may itself contain "</parameter>" (a doc about this format, an XML file): it ends only at
  // the "</parameter>" that another <parameter> or the end of the call follows. The old first-match cut such a file short
  // and handed the stub over as a complete call (sweep 2026-10-03).
  const PARAM_OPEN_SRC = '<' + PFX + 'parameter\\s+name="([^"]{1,200})"\\s*>';
  const PARAM_OPEN_RE = new RegExp(PARAM_OPEN_SRC);
  const PARAM_END_RE = new RegExp('</' + PFX + 'parameter>(?=\\s*(?:<' + PFX + 'parameter\\s+name="[^"]{1,200}"\\s*>|$))', 'g');
  const BLOCK_NEXT_RE = new RegExp('^(?:<' + PFX + 'invoke\\s+name="|</' + PFX + 'function_calls>)');
  const NAME_SCAN = 400;   // a <tool_call>'s name leads its JSON; past this many chars without one, stop looking
  const HOLD = 80;         // a trailing '<…' this short with no '>' yet may still become a call tag: hold it back
  function announcedName(buf) {
    const head = buf.slice(0, NAME_SCAN);
    const at = head.search(/"arguments"\s*:/);   // never read a "name" field from inside the arguments
    const m = /"name"\s*:\s*"((?:[^"\\]|\\.){1,200})"/.exec(at >= 0 ? head.slice(0, at) : head);
    return m ? m[1].trim() : '';
  }
  function makeCallSplitter(opts) {
    const enabled = !(opts && opts.enabled === false);
    // mode: 'prose' | 'call' (inside one call) | 'next' (a call or <function_calls> just passed: another call, or the end?)
    let buf = '', mode = 'prose', kind = '', named = false, scan = 0, calls = 0, stopped = false;
    /* A CALL'S SEARCHED BODY IS PARKED (2026-10-20). `scan` already kept the close-tag search from re-reading a call's
       body, but each push appended to buf and then searched it, and searching a freshly appended string makes V8 copy
       the WHOLE string flat first: a 512 KB fs_write cost 1-4 s of sidecar CPU, quadratic in the file. The part before
       `scan` has been searched and no later search reads it, so it moves to `parts` and buf keeps only the unsearched
       tail. A <tool_call>'s head stays whole until its name is settled (announcedName reads its first NAME_SCAN chars). */
    let parts = [];
    function park() { if (scan > 0 && (kind !== 'json' || named !== false)) { parts.push(buf.slice(0, scan)); buf = buf.slice(scan); scan = 0; } }
    function held() { const h = parts.length ? parts.join('') : ''; parts = []; return h; }
    /* CODE IS NOT A CALL (sweep 2026-10-03): a reply that SHOWS the call format in a code fence or inline code ran it — a
       fenced example fs_delete deleted the file, and `<invoke name="shell">` in a sentence swallowed the rest of the
       reply as a call. The prose that has gone out is tracked for an open ``` fence or ` span; a call tag inside one is
       text. inBlock: inside <function_calls>, whose own close ends it — so a "</invoke>" inside a value is not the end. */
    let fence = false, tick = false, inBlock = false;
    function track(s) {
      for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 96 && s.startsWith('```', i)) { fence = !fence; tick = false; i += 2; continue; }
        const c = s[i];
        if (c === '\n') tick = false;
        else if (c === '`' && !fence) tick = !tick;
      }
    }
    function addText(out, s) {
      if (!s) return;
      track(s);
      out.text += s;
      const last = out.items[out.items.length - 1];
      if (last && last.text != null) last.text += s; else out.items.push({ text: s });
    }
    const couldOpen = tail => tail.length <= HOLD && tail.indexOf('>') < 0;
    // out.rest = what the model wrote past the block in this same delta (dropped here; the persistent child keeps it)
    function stop(out, rest) { stopped = true; out.stop = true; out.rest = String(rest || ''); buf = ''; parts = []; return out; }
    function drain(out) {
      for (;;) {
        if (stopped) { buf = ''; return out; }
        if (mode === 'prose') {
          const m = enabled ? OPEN_RE.exec(buf) : null;
          if (m) {
            addText(out, buf.slice(0, m.index));
            if (fence || tick) { addText(out, m[0]); buf = buf.slice(m.index + m[0].length); continue; }   // shown, not called
            if (buf.slice(0, m.index).trim()) inBlock = false;
            buf = buf.slice(m.index + m[0].length);
            if (m[0] === CALL_OPEN) { mode = 'call'; kind = 'json'; named = false; scan = 0; continue; }
            if (m[1] == null) { mode = 'next'; inBlock = true; continue; }   // <function_calls>: its calls follow
            mode = 'call'; kind = 'invoke'; named = true; scan = 0;
            out.items.push({ start: m[1].trim() });
            continue;
          }
          let keep = 0;
          if (enabled) { const lt = buf.lastIndexOf('<'); if (lt >= 0 && couldOpen(buf.slice(lt))) keep = buf.length - lt; }
          // a run of backticks at the end may be the start of a fence still arriving: hold it so the fence is read whole
          if (enabled) { const bt = /`+$/.exec(buf.slice(0, buf.length - keep)); if (bt) keep += bt[0].length; }
          addText(out, buf.slice(0, buf.length - keep));
          buf = buf.slice(buf.length - keep);
          return out;
        }
        if (mode === 'call') {
          // the close-tag search resumes where the last one stopped: a file-sized call is scanned once, not per delta
          if (kind === 'json') {
            // named === null is final (the head past NAME_SCAN can no longer change), so only `false` looks again
            if (named === false) {
              const name = announcedName(buf);
              if (name) { named = true; out.items.push({ start: name }); }
              else if (buf.length > NAME_SCAN) named = null;   // no name up front: the block is judged when it closes
            }
            const end = buf.indexOf(CALL_CLOSE, scan);
            if (end < 0) { scan = Math.max(0, buf.length - (CALL_CLOSE.length - 1)); park(); return out; }
            out.items.push({ body: held() + buf.slice(0, end), kind, closed: true });
            buf = buf.slice(end + CALL_CLOSE.length);
          } else {
            INVOKE_CLOSE_RE.lastIndex = scan;
            let c, close = null;
            while ((c = INVOKE_CLOSE_RE.exec(buf))) {
              if (!inBlock) { close = c; break; }
              // inside <function_calls> the call ends at the </invoke> that another call or the block's close follows
              const after = buf.slice(c.index + c[0].length).replace(/^\s+/, '');
              if (!after || (after[0] === '<' && couldOpen(after) && !BLOCK_NEXT_RE.test(after))) { scan = c.index; park(); return out; }   // still arriving
              if (BLOCK_NEXT_RE.test(after)) { close = c; break; }
            }
            if (!close) { scan = Math.max(scan, buf.length - HOLD); park(); return out; }
            out.items.push({ body: held() + buf.slice(0, close.index), kind, closed: true });
            buf = buf.slice(close.index + close[0].length);
          }
          calls++; mode = 'next'; continue;
        }
        // 'next': whitespace, then another call, the end of the block, or anything else (the block is over)
        const ws = buf.replace(/^\s+/, '');
        if (!ws) return out;
        if (WRAP_CLOSE_RE.test(ws)) {
          if (calls) return stop(out, ws.replace(WRAP_CLOSE_RE, ''));
          buf = ws.replace(WRAP_CLOSE_RE, ''); mode = 'prose'; inBlock = false; continue;   // an empty block: nothing to run
        }
        const m = OPEN_RE.exec(ws);
        if (m && m.index === 0) { buf = ws; mode = 'prose'; continue; }   // the prose branch opens it at once
        if (ws[0] === '<' && couldOpen(ws)) return out;                   // '<inv…' or '</function_c…' still arriving
        if (calls) return stop(out, ws);
        inBlock = false;
        addText(out, '<function_calls>' + buf); buf = ''; mode = 'prose';  // a <function_calls> with no call was prose
        return out;
      }
    }
    return {
      push(delta) { buf += String(delta || ''); return drain({ text: '', items: [], stop: false }); },
      // A call the model never closed (the output limit cut it) still counts when it was announced or its body parses.
      end() {
        const out = { text: '', items: [], stop: false };
        if (!stopped) {
          if (mode === 'call') {
            buf = held() + buf;   // the parked body rejoins: the cut-off verdicts below read the whole call
            // a block whose stream ended before </function_calls>: its call ends at the LAST </invoke> written
            const lastClose = kind === 'invoke' && inBlock ? buf.lastIndexOf('</invoke>') : -1;
            if (lastClose >= 0) out.items.push({ body: buf.slice(0, lastClose), kind, closed: true });
            else if (kind === 'invoke' || named === true || parseCall(buf)) out.items.push({ body: buf, kind, closed: false });
            else addText(out, CALL_OPEN + buf);
          } else if (mode === 'prose') addText(out, buf);
        }
        buf = ''; parts = []; mode = 'prose'; named = false; scan = 0;
        return out;
      }
    };
  }

  function parseCall(body) {
    const raw = String(body || '').trim();
    let j = null;
    try { j = JSON.parse(raw); } catch (_) {
      // A file-sized call's commonest slip is a raw newline or tab inside a string. The shared repair ladder escapes
      // those; a repair that had to CLOSE an open string means the call was cut off, and that is never accepted.
      try {
        const d = require('./sanitize.js').repairToolCallArgumentsDetailed(raw);
        if (d && !d.closedOpenString) j = JSON.parse(d.text);
      } catch (_) { j = null; }
    }
    if (!j || typeof j !== 'object' || typeof j.name !== 'string' || !j.name.trim()) return null;
    const args = j.arguments != null ? j.arguments : (j.input != null ? j.input : {});
    return { name: j.name.trim(), args: typeof args === 'string' ? args : JSON.stringify(args) };
  }
  /* An ANNOUNCED call whose body will not parse (cut off by the output limit, or broken past repair) still goes to the
     loop as that call, its arguments text handed over as written: the loop's own repair ladder fixes it or refuses it
     with a reason the model reads ("NOT executed — reissue it complete"). It used to be dumped as prose, which put a
     whole game's source into the chat and wrote no file. */
  function looseCall(body, name) {
    const s = String(body || '');
    const at = s.search(/"arguments"\s*:/);
    const args = at >= 0 ? s.slice(at).replace(/^"arguments"\s*:\s*/, '').replace(/\}\s*$/, '').trim() : '';
    return { name, args: args || '{}' };
  }
  // One <parameter> value: raw text for a string parameter (a file arrives exactly as written), JSON for the rest.
  function paramValue(raw, schema) {
    const t = schema && schema.type;
    const types = Array.isArray(t) ? t : (t ? [t] : []);
    if (types.indexOf('string') >= 0) return raw;
    const s = raw.trim();
    if (!types.length && !/^(?:[[{"]|-?\d|true$|false$|null$)/.test(s)) return raw;
    try { return JSON.parse(s); } catch (_) { return raw; }   // not JSON after all: hand the text over, the tool validates it
  }
  /* An <invoke> body -> { name, args } (args = a JSON string, as the loop takes it). A call the output limit cut off
     inside a parameter is handed over with that value still OPEN, so the loop's repair ladder sees a cut-off value
     and refuses it ("NOT executed — reissue it complete") instead of writing half a file. */
  function invokeCall(name, body, props, closed) {
    const args = {};
    let rest = String(body || ''), m, open = null;
    while ((m = PARAM_OPEN_RE.exec(rest))) {
      const from = m.index + m[0].length;
      PARAM_END_RE.lastIndex = from;
      const e = PARAM_END_RE.exec(rest);
      // a value with no end: cut off by the output limit (or never closed) — handed over OPEN so the loop refuses it
      if (!e) { open = [null, m[1], rest.slice(from)]; break; }
      args[m[1]] = paramValue(rest.slice(from, e.index), props && props[m[1]]);
      rest = rest.slice(e.index + e[0].length);
    }
    if (!open) return { name, args: JSON.stringify(args) };
    const head = JSON.stringify(args).slice(0, -1);
    return { name, args: head + (head.length > 1 ? ',' : '') + JSON.stringify(open[1]) + ':' + JSON.stringify(open[2]).slice(0, -1) };
  }

  /* The local-CLI plumbing the provider AND the sign-in driver share: find the binary, build its station-free env,
     kill its process tree, ask `claude auth status`. */
  function makeCliHost(opts) {
    opts = opts || {};
    const childEnvLib = require('../child-env.js');
    const cp = opts.spawn ? null : childEnvLib.guardChildProcess(require('node:child_process'));
    const spawn = opts.spawn || cp.spawn;
    const fs = opts.fs || require('fs');
    const os = opts.os || require('os');
    const path = require('path');
    const env = opts.env || process.env;
    const platform = opts.platform || process.platform;

    function isFile(p) {
      try { return fs.statSync(p).isFile(); } catch (_) { return false; }
    }
    // A `claude.cmd` npm shim cannot be spawned without a shell, so it runs as `node <cli.js>` instead.
    function which(name) {
      const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
      for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
          const p = path.join(dir, name + ext);
          if (isFile(p)) return p;
        }
      }
      return '';
    }
    function command() {
      const configured = String(opts.bin || env.STARNET_CLAUDE_BIN || '').trim();
      let bin = configured || which('claude');
      if (!bin && platform === 'win32' && env.USERPROFILE) {
        const native = path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe');
        if (isFile(native)) bin = native;
      }
      if (!bin && platform !== 'win32' && env.HOME) {
        const native = path.join(env.HOME, '.local', 'bin', 'claude');   // the native installer's home on macOS/Linux
        if (isFile(native)) bin = native;
      }
      /* An app opened from the macOS Finder gets a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin): Homebrew and `npm -g`
         installs were never found and the card said "not installed" (sweep 2026-10-02). Look where they live too. */
      if (!bin && platform !== 'win32') {
        for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', env.HOME ? path.join(env.HOME, '.npm-global', 'bin') : '']) {
          if (dir && isFile(path.join(dir, 'claude'))) { bin = path.join(dir, 'claude'); break; }
        }
      }
      if (!bin) return null;
      // an npm-installed `claude` is a link to a JS file with a `#!/usr/bin/env node` line — and that bare PATH has no
      // `node` either: run the script with the station's own Node instead of trusting the shebang
      if (platform !== 'win32' && typeof fs.realpathSync === 'function') {
        let real = '';
        try { real = fs.realpathSync(bin); } catch (_) { real = ''; }
        if (/\.(c|m)?js$/i.test(real)) return { file: process.execPath, pre: [real] };
      }
      if (/\.(cmd|bat)$/i.test(bin)) {
        const cli = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (isFile(cli)) return { file: process.execPath, pre: [cli] };
        return null;
      }
      return { file: bin, pre: [] };
    }
    function notInstalled() {
      const e = new Error('Claude Code is not installed on this computer — install it, then pick CLAUDE CODE and sign in with Claude');
      e.code = 'provider_not_configured';
      return e;
    }
    function notSignedIn() {
      const e = new Error('Claude Code is installed but not signed in — press SIGN IN on the CLAUDE CODE card (Settings → PROVIDERS), then retry');
      e.code = 'provider_not_configured';
      return e;
    }
    /* The CLI gets the station-free env (child-env.js: no STARNET_/SKYNET_ secrets, no station-held key values),
       and its own memory stays out of the turn: auto-memory would inject the CLI user's notes into a StarNet agent. */
    function childEnv() {
      const out = childEnvLib.stationChildEnv(env);
      delete out.CLAUDECODE;               // a sidecar started from inside a Claude Code session is not a nested session
      delete out.CLAUDE_CODE_ENTRYPOINT;
      out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      if (opts.configDir) out.CLAUDE_CONFIG_DIR = String(opts.configDir);   // an extra account's own CLI identity
      return out;
    }
    function killDirect(child) {
      try { child.kill(); } catch (e) { failNote('claudecli.kill', e); }
    }
    function killTree(child, onAttemptDone) {
      let reported = false;
      const report = error => { if (!reported) { reported = true; if (onAttemptDone) onAttemptDone(error || null); } };
      if (!child || child.exitCode != null || child.signalCode != null) { report(null); return; }
      try {
        if (platform === 'win32' && child.pid) {
          const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          if (k && typeof k.on === 'function') {
            k.on('error', e => { killDirect(child); report(e); });
            k.on('close', (code, signal) => {
              const error = code === 0 ? null : new Error('Claude Code taskkill failed: ' + (signal || code));
              if (error) failNote('claudecli.killtree', error);
              report(error);
            });
          } else report(new Error('Claude Code taskkill returned no observable process'));
        } else {
          const sent = child.kill('SIGTERM');
          report(sent === false ? new Error('Claude Code termination signal was not sent') : null);
        }
      } catch (e) { failNote('claudecli.killtree', e); killDirect(child); report(e); }
    }
    /* `claude auth status` is a free, local check (no model call). Resolves the proven state, never throws:
       { installed, loggedIn, authMethod, email?, subscription?, error? } — booleans/labels only, never a token. */
    function authStatus() {
      return new Promise(resolve => {
        const cmd = command();
        if (!cmd) return resolve({ installed: false, loggedIn: false, error: notInstalled() });
        let out = '', settled = false, child;
        const finish = (st) => { if (settled) return; settled = true; clearTimeout(timer); resolve(st); };
        const timer = setTimeout(() => { killTree(child); finish({ installed: true, loggedIn: false, error: new Error('Claude Code did not answer `claude auth status` within 15s') }); }, 15000);
        try {
          child = spawn(cmd.file, cmd.pre.concat(['auth', 'status']), { env: childEnv(), cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { return finish({ installed: false, loggedIn: false, error: notInstalled() }); }
        child.stdout.setEncoding('utf8');
        child.on('error', () => finish({ installed: false, loggedIn: false, error: notInstalled() }));
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', () => {});
        child.on('close', () => {
          let j = null;
          try { j = JSON.parse(out.trim()); } catch (_) { j = null; }
          const keyed = !!String(childEnv().ANTHROPIC_API_KEY || '').trim();   // only a key the CLI will actually see
          const loggedIn = !!((j && j.loggedIn === true) || keyed);
          const st = { installed: true, loggedIn, authMethod: (j && j.authMethod && j.authMethod !== 'none') ? String(j.authMethod) : (keyed ? 'api_key' : '') };
          if (j && typeof j.email === 'string' && j.email) st.email = j.email.slice(0, 200);
          if (j && typeof j.subscriptionType === 'string' && j.subscriptionType) st.subscription = j.subscriptionType.slice(0, 40);
          if (!loggedIn) st.error = notSignedIn();
          finish(st);
        });
      });
    }
    /* `claude auth logout` for this identity: the CLI clears its own credential (on macOS that is a keychain entry
       outside the config folder, so deleting the folder alone would strand it). Resolves { ok }, never throws. */
    function logout() {
      return new Promise(resolve => {
        const cmd = command();
        if (!cmd) return resolve({ ok: false });
        let settled = false, child;
        const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok }); };
        const timer = setTimeout(() => { killTree(child); finish(false); }, 15000);
        try {
          child = spawn(cmd.file, cmd.pre.concat(['auth', 'logout']), { env: childEnv(), cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        } catch (_) { return finish(false); }
        child.on('error', () => finish(false));
        child.on('close', code => finish(code === 0));
      });
    }
    return { spawn, fs, os, path, env, platform, isFile, command, notInstalled, notSignedIn, childEnv, killTree, authStatus, logout };
  }

  // the CLI's own model names and aliases -> the list-rate table's ids (an alias follows the newest of its family)
  const ALIAS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5-20251001' };
  function estimateUsd(u, model) {
    try {
      const id = String(model || '').replace(/\[1m\]$/i, '');
      const prices = require('./prices.js');
      const p = prices.priceOf('anthropic', ALIAS[id] || id);
      if (!p) return NaN;
      const uncached = Number(u.input_tokens) || 0, write = Number(u.cache_creation_input_tokens) || 0, read = Number(u.cache_read_input_tokens) || 0;
      const c = p.cache || { read: 1, write: 1 };
      return ((uncached + read * c.read + write * c.write) * p.in + (Number(u.output_tokens) || 0) * p.out) / 1e6;
    } catch (_) { return NaN; }
  }
  function makeClaudeCliProvider(opts) {
    opts = opts || {};
    const host = makeCliHost(opts);
    const { spawn, fs, os, path, command, notInstalled, childEnv, killTree } = host;
    const statusTtlMs = opts.statusTtlMs != null ? opts.statusTtlMs : 60000;
    // Injected wall clock (determinism law). Without one, a proven sign-in is kept for this instance's life
    // and a failed probe is never cached — the factory builds a fresh adapter per request anyway.
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;
    // the CLI's own word on this sign-in's usage windows (a rate_limit_event line, every run): handed to the host as is
    const rateLimitSeen = info => { if (typeof opts.onRateLimit === 'function' && info) { try { opts.onRateLimit(info); } catch (e) { failNote('claudecli.ratelimit.reader', e); }   // a reader never breaks a run } };
    let status = null, statusAt = 0, statusPromise = null;
    let seq = 0;
    // tool-call ids are unique per ADAPTER, not just per turn: the factory builds a fresh adapter per request (and per
    // account on a usage-limit switch), so "call_cli_1_0" repeated in one transcript — a fallback to a provider that
    // requires unique tool ids would reject the conversation (sweep 2026-10-02)
    const idTag = require('crypto').randomBytes(4).toString('hex');

    function removeFile(p) {
      try { fs.unlinkSync(p); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('claudecli.sysprompt.unlink', e); }
    }
    function statusFresh() {
      if (!status) return false;
      if (!clock) return status.ok;
      return clock.now() - statusAt < (status.ok ? statusTtlMs : 10000);
    }
    function probeStatus() {
      if (statusFresh()) return Promise.resolve(status);
      if (statusPromise) return statusPromise;
      statusPromise = host.authStatus()
        .then(st => st.loggedIn ? { ok: true, authMethod: st.authMethod } : { ok: false, error: st.error || host.notSignedIn() })
        .then(st => { status = st; statusAt = clock ? clock.now() : 0; statusPromise = null; return st; });
      return statusPromise;
    }

    async function listModels() {
      const st = await probeStatus();
      if (!st.ok) throw st.error;
      return MODELS.map(m => ({
        id: m.id, name: m.name, context_length: m.context || DEFAULT_CONTEXT, max_completion_tokens: null, pricing: null,
        supportsTools: true, supportsReasoning: true, supported_parameters: ['tools', 'reasoning'], reasoningEfforts: EFFORTS.slice()
      }));
    }

    const effortOf = req => { const e = String(req.reasoningEffort || '').trim().toLowerCase(); return EFFORTS.indexOf(e) >= 0 ? e : ''; };
    function cliArgs(cmd, req, sysFile) {
      // stdin is always stream-json user messages: one block per transcript entry keeps the prompt cache hitting
      const args = cmd.pre.concat(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--input-format', 'stream-json'], NO_TOOLS_ARGS);
      if (req.model) args.push('--model', String(req.model));
      const effort = effortOf(req);
      if (effort) args.push('--effort', effort);
      if (sysFile) args.push('--system-prompt-file', sysFile);
      return args;
    }

    /* ONE TURN'S LINES. What a turn's stream-json output means, shared by the one-shot child and the persistent one
       (PERSISTENT CHILD below). line(j) returns the events that line yields; blockDone is set the moment the call block
       has ended the turn (see the reader's STOP). */
    function makeTurn(req, turn) {
      const splitter = makeCallSplitter({ enabled: Array.isArray(req.tools) && req.tools.length > 0 });
      const props = {};   // tool name -> its parameter schemas: a string <parameter> stays raw, the rest parse as JSON
      for (const tl of (Array.isArray(req.tools) ? req.tools : [])) {
        const fn = tl && tl.function;
        if (fn && fn.name) props[String(fn.name)] = (fn.parameters && fn.parameters.properties) || {};
      }
      const callId = index => 'call_cli_' + idTag + '_' + turn + '_' + index;
      let open = null;   // the call a tool_start already announced, whose block has not closed yet
      const t = {
        callIndex: 0, sawText: false, result: null, apiKeySource: null, apiError: '',
        blockDone: false, streamUsage: null,   // the call block ended the turn (see the reader's STOP)
        outChars: 0,   // what the model wrote this turn: the floor for its output tokens when the stop cut the count short
        raw: '',       // every text delta exactly as the CLI streamed it: what a persistent child keeps as this reply
        rest: '',      // what the model wrote past its call block inside the delta that ended it
        shown: '', calls: [],   // what this turn handed the loop (its text, its calls): the reply the loop records
        compacted: false        // the CLI folded its own history: a persistent child no longer holds StarNet's
      };
      function emitSplit(part, out) {
        for (const it of part.items) {
          if (it.text != null) { if (it.text) { t.sawText = true; t.shown += it.text; out.push({ type: 'text', delta: it.text }); } continue; }
          if (it.start) {
            open = { index: t.callIndex++, name: it.start };
            t.calls[open.index] = { id: callId(open.index), name: it.start, args: '' };
            out.push({ type: 'tool_start', index: open.index, id: callId(open.index), name: it.start });
            continue;
          }
          const was = open; open = null;
          const call = it.kind === 'invoke' ? invokeCall(was ? was.name : '', it.body, props[was ? was.name : ''], it.closed)
            : (parseCall(it.body) || (was ? looseCall(it.body, was.name) : null));
          if (!call) { const txt = CALL_OPEN + it.body + (it.closed ? CALL_CLOSE : ''); t.sawText = true; t.shown += txt; out.push({ type: 'text', delta: txt }); continue; }
          const index = was ? was.index : t.callIndex++;
          if (!was) { t.calls[index] = { id: callId(index), name: call.name, args: '' }; out.push({ type: 'tool_start', index, id: callId(index), name: call.name }); }
          t.calls[index].args += call.args;
          out.push({ type: 'tool_args', index, chunk: call.args });
          out.push({ type: 'tool_done', index });
        }
        return out;
      }
      t.line = function (j) {
        const out = [];
        if (j.type === 'system' && j.subtype === 'init') t.apiKeySource = j.apiKeySource == null ? null : String(j.apiKeySource);
        else if (j.type === 'system' && j.subtype === 'compact_boundary') t.compacted = true;
        else if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta' && j.event.delta && j.event.delta.type === 'text_delta') {
          const text = String(j.event.delta.text || '');
          t.outChars += text.length;
          t.raw += text;
          const part = splitter.push(j.event.delta.text);
          emitSplit(part, out);
          if (part.stop) { t.blockDone = true; t.rest = part.rest || ''; }
        } else if (j.type === 'stream_event' && j.event && j.event.type === 'message_start') t.streamUsage = Object.assign({}, j.event.message && j.event.message.usage);
        else if (j.type === 'stream_event' && j.event && j.event.type === 'message_delta' && j.event.usage) t.streamUsage = Object.assign(t.streamUsage || {}, j.event.usage);
        else if (j.type === 'assistant' && j.error) t.apiError = String(j.error);
        else if (j.type === 'rate_limit_event') rateLimitSeen(j.rate_limit_info);
        else if (j.type === 'result') t.result = j;
        return out;
      };
      // `billed.total_cost_usd` is what THIS turn cost (a persistent child's result line carries its running total)
      t.usageChunk = function (billed) {
        const u = billed.usage || {};
        const uncached = Number(u.input_tokens) || 0, cacheWrite = Number(u.cache_creation_input_tokens) || 0;
        const cacheRead = Number(u.cache_read_input_tokens) || 0, out = Number(u.output_tokens) || 0;
        const subscription = t.apiKeySource === 'none';
        const reported = Number(billed.total_cost_usd);
        return {
          type: 'usage',
          usage: {
            prompt_tokens: uncached + cacheWrite + cacheRead,
            completion_tokens: out,
            total_tokens: uncached + cacheWrite + cacheRead + out,
            prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite },
            reasoning_tokens: 0,
            // subscription login: nothing is billed per call. API key: the CLI's own billed figure.
            cost: subscription ? 0 : (isFinite(reported) ? reported : undefined),
            // a $0 turn that still drew on the sign-in's usage window: the loop's per-run subscription-token
            // ceiling counts it (loop.js maxSubscriptionTokens), since no $ cap ever sees a $0 turn
            subscription: subscription || undefined
          }
        };
      };
      /* The calls are complete; the rest of this generation is the model guessing at results. No result line comes for
         a stopped turn: book what the stream itself reported (the input side is exact; output is the last count the
         stream gave, which can run short of the tokens spent before the stop).
         COST TRUTH ON A STOP (sweep 2026-10-03): no result line means no billed figure, and the stream's last output
         count is usually 1 (message_delta never came). An API-key sign-in IS billed for this turn, so it is priced
         from the list-rate table with output floored at ~4 characters a token — it booked $0 and the caps never saw
         a tool-calling turn. A subscription stays $0 (nothing is billed per call). */
      t.stopChunks = function (model) {
        const su = Object.assign({}, t.streamUsage || {});
        su.output_tokens = Math.max(Number(su.output_tokens) || 0, Math.ceil(t.outChars / 4));
        return [t.usageChunk({ usage: su, total_cost_usd: t.apiKeySource === 'none' ? NaN : estimateUsd(su, model) }), { type: 'done', finishReason: 'tool_calls', truncated: false }];
      };
      // `detail` (the result line's subtype) names only a GENERIC failure: a tagged auth / usage-limit failure with an empty
      // `result` keeps its plain words, never an internal string such as error_during_execution (review 2026-10-13)
      t.failureError = function (message, detail) {
        // The CLI tags a lost sign-in on its assistant line ("error":"authentication_failed"). Carry it as a 401 so
        // errorClass files it as `auth` (fail now, say why) instead of `unknown`, which the loop retries for ~105s.
        if (t.apiError === 'authentication_failed') {
          const e = new Error('Claude Code is not signed in (' + String(message || 'authentication failed').slice(0, 200) + ') — press SIGN IN on the CLAUDE CODE card (Settings → PROVIDERS), then retry');
          e.status = 401; e.code = 'provider_not_configured';
          return e;
        }
        // A spent subscription window ("You've hit your limit · resets 5pm …"): a 429 usage_limit_reached is
        // quota_exhausted — no retry on this sign-in, rotate to the next connected account (or fall back).
        if (t.apiError === 'rate_limit') {
          const e = new Error('Claude Code usage limit reached: ' + String(message || 'rate limited').slice(0, 300));
          e.status = 429; e.code = 'usage_limit_reached';
          return e;
        }
        return new Error('Claude Code error: ' + String(message || detail || 'unknown error').slice(0, 400));
      };
      // The turn's end from its result line: a failure is thrown (after booking what it was billed); a success yields
      // the rest of the reply, its usage and exactly one done. `cost` overrides the line's total_cost_usd.
      t.finish = function* (exit, cost) {
        const result = t.result;
        if (!result) {
          const tail = String(exit.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
          throw new Error('Claude Code exited with code ' + exit.code + ' before answering' + (tail ? ': ' + tail : ''));
        }
        const billed = cost === undefined ? result : Object.assign({}, result, { total_cost_usd: cost });
        if (result.is_error || (result.subtype && result.subtype !== 'success')) {
          // a failed turn can still have been BILLED (an API-key sign-in pays for the tokens it used): report what the
          // CLI's result line says it cost before failing, so the ledger and the caps see it (sweep 2026-10-02)
          if (result.usage || isFinite(Number(billed.total_cost_usd))) yield t.usageChunk(billed);
          throw t.failureError(result.result, result.subtype);
        }
        if (!t.sawText && t.callIndex === 0 && typeof result.result === 'string') yield* emitSplit(splitter.push(result.result), []);
        yield* emitSplit(splitter.end(), []);
        yield t.usageChunk(billed);
        yield { type: 'done', finishReason: t.callIndex > 0 ? 'tool_calls' : provider.normalizeFinish(result.stop_reason), truncated: false };
      };
      return t;
    }

    async function* stream(req) {
      req = req || {};
      if (req.signal && req.signal.aborted) return;
      const cmd = command();
      if (!cmd) throw notInstalled();
      // The persistent child serves the agent loop (a turn that carries tools). A side call (summary, vision, wire test)
      // or a second request while the child is mid-turn runs its own one-shot child and never touches it.
      const persistent = persistOn && Array.isArray(req.tools) && req.tools.length > 0 && !(session && session.busy);
      const box = {};   // the turn's line reader (makeTurn), once the turn has one: what its init line said about billing
      const turn = persistent ? persistentStream(req, cmd, box) : oneShotStream(req, cmd, box);
      const logUsage = envOf('STARNET_CLAUDE_CLI_PERSIST_LOG') === '1';
      /* A SUBSCRIPTION CALL BILLS NOTHING PER CALL (80de2a75 review). Before this turn's first event, a subscription
         sign-in (init line apiKeySource 'none') says so as { type:'billing', perCall:false }: a Stop that cuts this
         call off mid-stream then cost nothing, so the loop never flags the run's spend as a floor or unknown. An
         API-key sign-in says nothing (its cut call IS billed). A turn that yields nothing yields no billing fact. */
      let billingSaid = false;
      for await (const ev of turn) {
        if (!billingSaid && box.turn && box.turn.apiKeySource === 'none') { billingSaid = true; yield { type: 'billing', perCall: false }; }
        // the diagnostics switch also prints each turn's usage: what the prompt cache did (read vs written) per turn
        if (logUsage && ev && ev.type === 'usage' && ev.usage) {
          const u = ev.usage, d = u.prompt_tokens_details || {};
          plog('usage ' + (persistent ? 'persistent' : 'one-shot') + ': in=' + u.prompt_tokens + ' cache_read=' + (d.cached_tokens || 0) + ' cache_write=' + (d.cache_creation_tokens || 0) + ' out=' + u.completion_tokens + (u.subscription ? ' subscription' : ''));
        }
        yield ev;
      }
    }

    // ONE-SHOT: one `claude -p` child for one turn (STARNET_CLAUDE_CLI_PERSIST=0 runs every turn this way).
    const ONE_SHOT_EXIT_GRACE_MS = Number(opts.oneShotExitGraceMs) > 0 ? Number(opts.oneShotExitGraceMs) : 3000;   // after its result line a child normally exits by itself in ~2 s
    async function* oneShotStream(req, cmd, box) {
      const signal = req.signal;
      const prompt = buildPrompt(req.messages, req.tools, req.cacheSystemPrefix);
      const turn = ++seq;
      const sysFile = path.join(os.tmpdir(), 'starnet-claude-cli-' + process.pid + '-' + turn + '-' + require('crypto').randomBytes(6).toString('hex') + '.txt');
      const args = cliArgs(cmd, req, '');
      if (prompt.system) { fs.writeFileSync(sysFile, prompt.system, { encoding: 'utf8', mode: 0o600 }); args.push('--system-prompt-file', sysFile); }

      // Child output is bridged into this generator through a small queue so events are yielded as they arrive.
      const queue = [];
      let wake = null, closed = false, failure = null, exitCode = null, stderr = '';
      const push = (item) => { queue.push(item); if (wake) { const w = wake; wake = null; w(); } };
      const idle = opts.idleMs || timeouts.idleMs();
      let idleTimer = null, finished = false;
      let child;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (finished) return;   // late output after a stop must not re-arm a watchdog nobody is waiting on
        idleTimer = setTimeout(() => { failure = timeouts.timeoutError(idle, 'idle'); killTree(child); push(null); }, idle);
      };
      const onAbort = () => { killTree(child); push(null); };
      try {
        child = spawn(cmd.file, args, { env: childEnv(), cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        removeFile(sysFile);
        throw notInstalled();
      }
      LIVE.set(child, prompt.system ? () => removeFile(sysFile) : null); hookExit();
      if (req.signal && typeof req.signal.addEventListener === 'function') req.signal.addEventListener('abort', onAbort, { once: true });
      armIdle();
      let lineBuf = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.on('error', (e) => { failure = (e && e.code === 'ENOENT') ? notInstalled() : e; closed = true; LIVE.delete(child); push(null); });
      child.stdout.on('data', (d) => {
        armIdle();
        lineBuf += d;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (line) push(line);
        }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      child.on('close', (code) => { exitCode = code; if (lineBuf.trim()) push(lineBuf.trim()); lineBuf = ''; closed = true; LIVE.delete(child); push(null); });
      // A child that dies before reading stdin surfaces through its exit (no result line), not through EPIPE here.
      child.stdin.on('error', e => failNote('claudecli.stdin', e));
      try { child.stdin.end(prompt.input || ''); } catch (e) { failNote('claudecli.stdin', e); }

      const T = makeTurn(req, turn);
      if (box) box.turn = T;
      let endedOnResult = false;
      try {
        for (;;) {
          if (signal && signal.aborted) return;
          if (!queue.length) {
            if (closed) break;
            await new Promise(r => { wake = r; });
            continue;
          }
          const line = queue.shift();
          if (line == null) {
            if (signal && signal.aborted) return;
            if (failure) throw failure;
            if (closed) break;
            continue;
          }
          let j;
          try { j = JSON.parse(line); } catch (_) { continue; }
          yield* T.line(j);
          if (T.blockDone) break;   // `finally` ends the child: the rest of this generation is a guess at results
          /* THE RESULT LINE ENDS THE TURN (stall report 2026-10-13). The turn used to end on the child's close, which comes
             ~2 s after `result` on the installed CLI (2.1.284) — every one-shot turn paid that wait, and a CLI that
             lingered let the idle watchdog fire with the finished reply in hand and throw it away as a timeout (the loop
             then re-ran the turn). The reply, its usage and its cost are all on the result line: book it now. */
          if (T.result) { endedOnResult = true; break; }
        }
        if (signal && signal.aborted) return;
        if (T.blockDone) { yield* T.stopChunks(req.model); return; }
        yield* T.finish({ code: exitCode, stderr });
      } finally {
        finished = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        // a child that already answered exits on its own (stdin is closed): give it a moment, then take its tree
        if (!closed && endedOnResult && !(signal && signal.aborted)) {
          const late = setTimeout(() => { if (!closed) killTree(child); }, ONE_SHOT_EXIT_GRACE_MS);
          if (late && typeof late.unref === 'function') late.unref();
        } else if (!closed) killTree(child);
        removeFile(sysFile);
      }
    }

    /* PERSISTENT CHILD (2026-10-12). One-shot children pay the CLI's start-up and session setup on every model turn
       (8.8-12.2 s a turn against Claude Code's 3.9-6.2 s on the same Opus model, gauntlet n=1). Now an agent-loop turn
       (one that carries tools) keeps ONE child per run, with the same isolation flags and stream-json input: it starts
       with StarNet's whole transcript (the PROMPT CACHE blocks, one per entry), holds the conversation itself, and each
       later turn sends only the entries StarNet added since its reply (the tool results, notes, steering) as its next
       user message, in the same blocks. Its system prompt reads PERSIST_TRANSCRIPT_NOTE instead of TRANSCRIPT_NOTE.
       PROVEN on the installed CLI (2.1.284, scratchpad cli-persist/exp-*.log): one child answers successive user lines
       (each turn ends at its own `result` line; result.usage is per turn, total_cost_usd is the RUNNING total); a model
       ends its reply on its own right after </function_calls> (end_turn ~30-70 ms after the last delta), and the child
       then holds exactly the text that streamed; an interrupt keeps the streamed text AND adds a
       "[Request interrupted by user]" turn, so it is never used — a reply that runs on past its block is the one case
       that would diverge, and it closes the child instead.
       IN SYNC OR START FRESH. The child is reused only while what it holds is provably StarNet's history: the same
       system prompt (persona, rules, brief), the same tools or more (a tool_search reveal is announced in that turn's
       message: TOOL REVEALS), model, effort, run and Stop signal; every earlier message unchanged (a fingerprint
       each); the reply it wrote recorded by the loop unedited (same text, same calls); nothing but new
       user/tool/system messages after it. Anything else (compaction, an aged-out screenshot, a dropped or repaired
       call, a retry after a failed turn, a model switch, a withdrawn or changed tool, the CLI compacting itself)
       closes the child and the turn starts a fresh one from StarNet's whole history, exactly like a one-shot turn.
       STARNET_CLAUDE_CLI_PERSIST_LOG=1 prints one line per decision (reuse, fresh + why, closed + why) and one per
       turn's usage (cache read vs written), on either path.
       LIFECYCLE. The child ends at the run's end (release(), called by the loop), on Stop (the run signal, even
       between turns), on any turn that did not end cleanly (error, crash, idle watchdog), after
       STARNET_CLAUDE_CLI_PERSIST_IDLE_MS (default 5 min) parked, and when the sidecar exits; every kill takes the
       child's whole process tree (taskkill /T on Windows). STARNET_CLAUDE_CLI_PERSIST=0 runs every turn one-shot. */
    const envOf = k => String(host.env[k] == null ? '' : host.env[k]).trim();
    const persistOn = opts.persist != null ? !!opts.persist : envOf('STARNET_CLAUDE_CLI_PERSIST') !== '0';
    const persistIdleMs = Number(opts.persistIdleMs) > 0 ? Number(opts.persistIdleMs) : (Number(envOf('STARNET_CLAUDE_CLI_PERSIST_IDLE_MS')) > 0 ? Number(envOf('STARNET_CLAUDE_CLI_PERSIST_IDLE_MS')) : 300000);
    const endGraceMs = Number(opts.persistEndGraceMs) > 0 ? Number(opts.persistEndGraceMs) : 3000;   // a reply's own end_turn after its block
    const PIPE_DRAIN_MS = Number(opts.persistPipeDrainMs) > 0 ? Number(opts.persistPipeDrainMs) : 2000;   // 'exit' seen, no 'close' yet: how long the pipes may still drain
    let session = null, sessionSeq = 0;
    const ownedSessions = new Set();   // includes non-reusable children whose exit is still unconfirmed
    const stats = { spawned: 0, reused: 0, fresh: {}, closed: {} };   // what the persistent path did (tests, the live proof)
    const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
    const sha1 = s => require('crypto').createHash('sha1').update(s).digest('hex');
    const sessionKey = (req, system) => sha1(JSON.stringify([String(req.model || ''), effortOf(req), system]));
    const toolMap = tools => new Map(toolLines(tools).map(t => [t.name, t.line]));
    // STARNET_CLAUDE_CLI_PERSIST_LOG=1: one console line per persistent-child decision (reuse / fresh + why / closed + why)
    const plog = msg => { if (envOf('STARNET_CLAUDE_CLI_PERSIST_LOG') === '1') console.log('[claude-cli persist] ' + msg); };

    function openSession(cmd, req, system, key, runId) {
      const sysFile = path.join(os.tmpdir(), 'starnet-claude-cli-' + process.pid + '-s' + (++sessionSeq) + '-' + require('crypto').randomBytes(6).toString('hex') + '.txt');
      fs.writeFileSync(sysFile, system, { encoding: 'utf8', mode: 0o600 });
      let child;
      try {
        child = spawn(cmd.file, cliArgs(cmd, req, sysFile), { env: childEnv(), cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        removeFile(sysFile);
        throw notInstalled();
      }
      const s = { child, key, runId, model: String(req.model || ''), effort: effortOf(req), tools: toolMap(req.tools), signal: req.signal || null, sysFile, alive: true, closed: false, busy: false, covered: [], pending: null,
        costSeen: 0, apiKeySource: null, stderr: '', exitCode: null, error: null, sink: null, onData: null, idleTimer: null, onRunAbort: null, primed: false, systemHash: sha1(system), closing: false, killPending: false, cleanupError: null, closeReason: null, processExited: false };
      ownedSessions.add(s); LIVE.set(child, () => removeFile(sysFile)); hookExit();
      let buf = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => {
        if (s.onData) s.onData();
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            // Initialization belongs to this exact child, including a warm child before any turn has a sink.
            let metadata;
            try { metadata = JSON.parse(line); } catch (_) { metadata = null; }
            if (metadata && metadata.type === 'system' && metadata.subtype === 'init')
              s.apiKeySource = metadata.apiKeySource == null ? null : String(metadata.apiKeySource);
            if (s.sink) s.sink(line);
          }
        }
      });
      child.stderr.on('data', d => { s.stderr = (s.stderr + d).slice(-4000); });
      child.on('error', e => { s.error = (e && e.code === 'ENOENT') ? notInstalled() : e; s.alive = false; if (s.sink) s.sink(null); closeSession(s, 'crash'); });
      /* EXIT WITHOUT CLOSE (review 2026-10-13). A child whose root exits while a helper of its own still holds its stdout or
         stderr gets 'exit' but never 'close': it stayed owned for good (persistStats().live true, cleanupPending 1) and
         its prompt file was never removed. Once the exit is observed, give the pipes a moment to drain, then let them go
         and release the session as 'close' would. */
      child.on('exit', () => {
        s.processExited = true; closeSession(s, 'exit');
        const drain = setTimeout(() => {
          if (s.closed) return;
          for (const pipe of [child.stdout, child.stderr]) { try { if (pipe && typeof pipe.destroy === 'function') pipe.destroy(); } catch (e) { failNote('claudecli.persist.pipes', e); } }
          s.alive = false; if (s.sink) s.sink(null); finishSession(s);
        }, PIPE_DRAIN_MS);
        if (drain && typeof drain.unref === 'function') drain.unref();
      });
      child.on('close', code => { s.exitCode = code; s.alive = false; if (buf.trim() && s.sink) s.sink(buf.trim()); buf = ''; if (s.sink) s.sink(null); finishSession(s); });
      child.stdin.on('error', e => failNote('claudecli.persist.stdin', e));
      // Stop ends the child even between turns (while the loop runs the tools it asked for)
      if (s.signal && typeof s.signal.addEventListener === 'function') {
        s.onRunAbort = () => closeSession(s, 'stop', true);
        s.signal.addEventListener('abort', s.onRunAbort, { once: true });
      }
      stats.spawned++;
      session = s;
      return s;
    }
    function finishSession(s) {
      if (s.closed) return;
      s.closed = true; s.alive = false; s.killPending = false;
      if (session === s) session = null;
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      if (s.onRunAbort && s.signal && typeof s.signal.removeEventListener === 'function') s.signal.removeEventListener('abort', s.onRunAbort);
      ownedSessions.delete(s); LIVE.delete(s.child);
      bump(stats.closed, s.closeReason || 'exit');
      plog('child ' + (s.child && s.child.pid) + ' exited: ' + (s.closeReason || 'exit'));
      removeFile(s.sysFile);
    }
    function closeSession(s, why, retry) {
      if (!s || s.closed || (s.closing && (!retry || s.killPending))) return;
      // Unavailable for reuse is not proof of process exit. Only the child's close event releases ownership.
      s.closing = true; s.alive = false; s.closeReason = s.closeReason || why || 'closed';
      if (session === s) session = null;
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      s.onData = null;
      if (s.sink) s.sink(null);
      const endStdin = () => { try { s.child.stdin.end(); } catch (e) { failNote('claudecli.persist.stdin', e); } };
      if (s.closed || s.processExited) { endStdin(); return; }
      /* KILL THE LIVE TREE (real-process proof 2026-10-13). On Windows the tree goes by the child's own pid, and
         taskkill /T can only walk it from a LIVE root. Closing stdin first let the CLI exit on that EOF before taskkill
         ran, and a helper process it had started was left running (3 of 3: release, Stop, idle). So on Windows stdin
         closes only once the kill attempt is over; elsewhere it still closes first. */
      const win = host.platform === 'win32';
      if (!win) endStdin();
      s.killPending = true; s.cleanupError = null;
      killTree(s.child, error => {
        if (win) endStdin();
        if (s.closed) return;
        s.killPending = false; s.cleanupError = error;
      });
    }
    /* WARM REPLACEMENT. A child closed at the end of a CALL turn (it wrote past its block, or never ended) is replaced at
       once with the same flags and system prompt, while the loop runs the tools: the next turn then gives it the whole
       history without paying the CLI's start-up (live: an idle child answered its first line in 1.1 s, 0.1 s to init,
       against 3.7 s cold). It is an ordinary child of this run: Stop, run end and the idle timeout end it the same way,
       and a next turn it does not fit (another prompt, model or run) closes it unused. */
    function prewarm(cmd, req, system, key, runId) {
      let w;
      try { w = openSession(cmd, req, system, key, runId); } catch (e) { failNote('claudecli.persist.prewarm', e); return; }
      stats.prewarmed = (stats.prewarmed || 0) + 1;
      plog('warm child ' + (w.child && w.child.pid) + ' started');
      w.idleTimer = setTimeout(() => closeSession(w, 'idle'), persistIdleMs);
      if (w.idleTimer && typeof w.idleTimer.unref === 'function') w.idleTimer.unref();
    }
    // What the child now holds: the request it answered + the reply it wrote. It waits, parked, for the next turn.
    function parkSession(s, rest, T, req) {
      if (s.closed || s.closing) return;   // a drained final result cannot revive an exited child
      s.tools = toolMap(req.tools);   // every tool the child has now been told about (its system prompt + any announced since)
      s.covered = rest.map(fingerprint);
      s.pending = { text: T.shown, calls: T.calls.filter(Boolean).map(c => ({ id: c.id, name: c.name, args: c.args })) };
      s.busy = false; s.sink = null; s.onData = null;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => closeSession(s, 'idle'), persistIdleMs);
      if (s.idleTimer && typeof s.idleTimer.unref === 'function') s.idleTimer.unref();
    }
    // Can this request ride the live child? { delta } = only what it has not seen; { why } = start fresh.
    function planDelta(s, key, runId, signal, rest, req) {
      if (!s.alive) return { why: 'dead' };
      if (s.key !== key) {   // the child was started on another system prompt (persona, rules, task brief), model or effort
        return { why: s.model !== String(req.model || '') ? 'model' : s.effort !== effortOf(req) ? 'effort' : 'system' };
      }
      if (s.runId !== runId || s.signal !== (signal || null)) return { why: 'run' };
      const n = s.covered.length;
      if (rest.length < n + 2) return { why: 'history' };
      for (let i = 0; i < n; i++) if (fingerprint(rest[i]) !== s.covered[i]) return { why: 'history' };
      if (!s.pending || !sameReply(rest[n], s.pending)) return { why: 'reply' };
      const delta = rest.slice(n + 1);
      if (delta.some(m => m.role === 'assistant')) return { why: 'history' };
      /* TOOL REVEALS. tool_search grants a deferred tool by ADDING it to the request's tool list, and the list lives in
         the system prompt the child was started with. Every tool the child knows must still be offered unchanged; one
         that is new is announced at the end of this turn's message instead of restarting the child. */
      const added = [];
      const want = toolLines(req.tools);
      for (const t of want) {
        if (!s.tools.has(t.name)) added.push(t);
        else if (s.tools.get(t.name) !== t.line) return { why: 'tools' };
      }
      if (s.tools.size + added.length !== want.length) return { why: 'tools' };   // a tool the child knows was withdrawn
      return { delta, added, n };
    }
    function costOf(s, result) {   // this turn's share of the child's running total_cost_usd
      const total = Number(result && result.total_cost_usd);
      if (!isFinite(total)) return NaN;
      const turn = total >= s.costSeen ? total - s.costSeen : NaN;
      s.costSeen = total;
      return turn;
    }

    async function* persistentStream(req, cmd, box) {
      const signal = req.signal;
      const sp = splitPrompt(req.messages, req.tools, req.cacheSystemPrefix, PERSIST_TRANSCRIPT_NOTE);
      const key = sessionKey(req, sp.base);
      const runId = req.runId == null ? '' : String(req.runId);
      let s = session, prompt = null;
      if (s && !s.primed) {
        // a WARM child started for this run (see prewarm): it holds nothing yet, so it takes the whole history
        if (s.alive && s.key === key && s.runId === runId && s.signal === (signal || null) && s.systemHash === sha1(sp.system)) {
          prompt = renderTranscript(sp.system, sp.rest); bump(stats.fresh, 'warm'); plog('use warm child ' + (s.child && s.child.pid));
        } else { closeSession(s, 'warm_unused'); s = null; bump(stats.fresh, 'first'); plog('fresh child: warm one did not fit'); }
      } else if (s) {
        const plan = planDelta(s, key, runId, signal, sp.rest, req);
        // only the entries after the child's own reply; null = nothing sendable: start fresh instead
        if (plan.delta) prompt = renderDelta(sp.rest, plan.n, plan.added.length ? [toolsNote(plan.added)] : []);
        if (prompt && plan.added.length) { stats.announced = (stats.announced || 0) + plan.added.length; plog('announce ' + plan.added.length + ' revealed tool(s): ' + plan.added.map(t => t.name).join(', ')); }
        if (prompt) { stats.reused++; plog('reuse child ' + (s.child && s.child.pid) + ': +' + plan.delta.length + ' message(s)'); }
        else { const why = plan.why || 'empty'; bump(stats.fresh, why); plog('fresh child: ' + why); closeSession(s, why); s = null; }
      } else { bump(stats.fresh, 'first'); plog('fresh child: first'); }
      if (!s) { s = openSession(cmd, req, sp.system, key, runId); prompt = renderTranscript(sp.system, sp.rest); }

      const turn = ++seq;
      const T = makeTurn(req, turn);
      T.apiKeySource = s.apiKeySource;   // init is session-scoped, not repeated for every user turn
      if (box) box.turn = T;
      const queue = [];
      let wake = null, failure = null, clean = false, finished = false, idleTimer = null;
      const push = (item) => { queue.push(item); if (wake) { const w = wake; wake = null; w(); } };
      const idle = opts.idleMs || timeouts.idleMs();
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (finished) return;
        idleTimer = setTimeout(() => { failure = timeouts.timeoutError(idle, 'idle'); closeSession(s, 'idle_timeout'); push(null); }, idle);
      };
      const onAbort = () => { closeSession(s, 'stop'); push(null); };
      const settle = () => {   // this turn no longer watches the child
        finished = true;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      };
      const nextLine = async () => {   // undefined = the child is gone; null = a wake-up (stop, watchdog, exit)
        while (!queue.length) {
          // exit is not stdout EOF: a final result/usage line can arrive before close.
          if (s.closed || (!s.alive && !s.processExited)) return undefined;
          await new Promise(r => { wake = r; });
        }
        return queue.shift();
      };
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      s.busy = true; s.sink = push; s.onData = armIdle; s.primed = true;
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      armIdle();
      try {
        s.child.stdin.write(prompt.input);   // one stream-json user message (renderTranscript / renderDelta)
      } catch (e) { failNote('claudecli.persist.stdin', e); }
      try {
        for (;;) {
          if (signal && signal.aborted) return;
          const line = await nextLine();
          if (line === undefined) break;
          if (line === null) {
            if (signal && signal.aborted) return;
            if (failure) throw failure;
            if (s.error) throw s.error;
            continue;
          }
          let j;
          try { j = JSON.parse(line); } catch (_) { continue; }
          yield* T.line(j);
          if (T.blockDone || T.result) break;   // a turn ends at its result line; the child stays
        }
        if (signal && signal.aborted) return;
        /* A FINISHED TURN IS NEVER A TIMEOUT (stall report 2026-10-13). The watchdog counts silence from the last line
           the CLI wrote, and a child that has answered stays silent by design: when the turn's result line (or its
           complete call block) was already read but the loop was still busy with an earlier event, the watchdog fired in
           that gap and the finished reply was thrown away as a timeout (the loop then re-ran the turn). It is delivered;
           the watchdog has already closed the child, so the next turn starts a fresh one. Only a turn with neither is a
           timeout. */
        if (failure && !T.result && !T.blockDone) throw failure;

        if (T.blockDone) {
          /* The calls are complete. A model that ends its reply right there leaves the child holding exactly the text
             that streamed, and the child is kept. One that writes on (a guess at results) or goes quiet without
             ending has put something StarNet will never record into the child's history: close it, and the next turn
             starts a fresh child from StarNet's own transcript. */
          let tail = T.rest, ended = null;
          /* KNOWN GAP (review 2026-10-13, kept on purpose): usage and done wait for the result line (30-70 ms, at most the
             grace), and a Stop that lands in that window ends the turn with no usage booked — the same abort-without-usage
             every streaming adapter has when Stop beats its usage chunk. Yielding the stream's estimate before the wait
             would close it, but a turn would then carry TWO usage snapshots, and its consumers (the eval runner's live
             spend takes the max of every snapshot) are built on one per turn (claude-cli-persist-review R3). A
             subscription turn is $0 either way; only an API-key sign-in leaves that turn's spend unrecorded. */
          const GRACE = {};
          const grace = setTimeout(() => push(GRACE), endGraceMs);
          try {
            for (;;) {
              if (signal && signal.aborted) return;
              const line = await nextLine();
              if (line === undefined || line === GRACE) break;
              if (line === null) { if (signal && signal.aborted) return; if (failure) break; continue; }
              let j;
              try { j = JSON.parse(line); } catch (_) { continue; }
              if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta' && j.event.delta) {
                const d = j.event.delta.type === 'text_delta' ? String(j.event.delta.text || '') : '\u0001';   // any other delta: still generating
                if (j.event.delta.type === 'text_delta') { T.raw += d; T.outChars += d.length; }
                tail += d;
                if (tail.trim()) break;
              } else if (j.type === 'stream_event' && j.event && j.event.type === 'message_delta' && j.event.usage) T.streamUsage = Object.assign(T.streamUsage || {}, j.event.usage);
              else if (j.type === 'system' && j.subtype === 'compact_boundary') T.compacted = true;
              else if (j.type === 'assistant' && j.error) T.apiError = String(j.error);
              else if (j.type === 'rate_limit_event') rateLimitSeen(j.rate_limit_info);
              else if (j.type === 'result') { ended = j; break; }
            }
          } finally { clearTimeout(grace); }
          if (signal && signal.aborted) return;
          if (ended && (ended.is_error || (ended.subtype && ended.subtype !== 'success'))) {
            T.result = ended;
            const cost = costOf(s, ended);
            settle(); closeSession(s, 'error');
            // Calls have already streamed. Reuse only the existing failure/usage settlement, never their deltas.
            yield* T.finish({ code: s.exitCode, stderr: s.stderr }, cost);
            return;
          }
          if (T.apiError) {
            settle(); closeSession(s, 'error');
            // No terminal result proves billed cost here. Retain the same explicitly estimated partial
            // accounting used for an interrupted tool turn, then surface the observed auth/quota failure.
            yield T.stopChunks(req.model)[0];
            throw T.failureError(T.apiError);
          }
          const inSync = !!ended && !tail.trim() && !ended.is_error && ended.subtype === 'success' && !T.compacted &&
            String(ended.result == null ? '' : ended.result).trim() === T.raw.trim();
          let out;
          if (inSync) {
            // the turn really ended: book its own result line (exact output tokens; this turn's share of the cost)
            const cost = costOf(s, ended);
            const billed = { usage: ended.usage || T.streamUsage || {}, total_cost_usd: isFinite(cost) ? cost : estimateUsd(ended.usage || {}, req.model) };
            out = [T.usageChunk(billed), { type: 'done', finishReason: 'tool_calls', truncated: false }];
            settle(); parkSession(s, sp.rest, T, req); clean = true;
          } else {
            const why = ended ? 'diverged' : (tail.trim() ? 'overrun' : 'no_end');
            stats.lastClose = { why, after: tail.replace(/\u0001/g, '[non-text]').slice(0, 160), ended: !!ended };   // what the reply did past its block
            // a reply that wrote on and then ENDED still has its result line: book that line's exact usage and this turn's
            // share of the running cost (review 2026-10-13), not the stream estimate; overrun / no_end have no line
            const cost = ended ? costOf(s, ended) : NaN;
            settle(); closeSession(s, why);
            if (!(signal && signal.aborted)) prewarm(cmd, req, sp.system, key, runId);   // the loop runs the tools meanwhile
            out = ended
              ? [T.usageChunk({ usage: ended.usage || T.streamUsage || {}, total_cost_usd: isFinite(cost) ? cost : (T.apiKeySource === 'none' ? NaN : estimateUsd(ended.usage || {}, req.model)) }), { type: 'done', finishReason: 'tool_calls', truncated: false }]
              : T.stopChunks(req.model);
          }
          for (const ev of out) yield ev;
          return;
        }

        const result = T.result;
        if (!result) { settle(); closeSession(s, 'exit'); yield* T.finish({ code: s.exitCode, stderr: s.stderr }); return; }
        const cost = costOf(s, result);
        const ok = !result.is_error && (!result.subtype || result.subtype === 'success');
        if (!ok) { settle(); closeSession(s, 'error'); yield* T.finish({ code: s.exitCode, stderr: s.stderr }, cost); return; }
        const out = Array.from(T.finish({ code: s.exitCode, stderr: s.stderr }, cost));   // the reply's tail, usage, done
        settle();
        if (!T.compacted && String(result.result == null ? '' : result.result).trim() === T.raw.trim()) { parkSession(s, sp.rest, T, req); clean = true; }
        else closeSession(s, 'diverged');
        for (const ev of out) yield ev;
      } finally {
        settle();
        if (!clean) closeSession(s, 'turn');   // a turn that did not end cleanly takes its child with it
      }
    }

    // The run is over: its persistent child goes now instead of idling out (loop.js calls this as the run ends).
    function release(runId) {
      const id = runId == null ? '' : String(runId);
      for (const s of Array.from(ownedSessions)) if (s.runId === id) closeSession(s, 'run_end', true);
    }

    return {
      stream,
      listModels,
      release,
      persistStats() {
        const closing = Array.from(ownedSessions).filter(s => s.closing);
        return JSON.parse(JSON.stringify(Object.assign({ enabled: persistOn, live: ownedSessions.size > 0,
          reusable: !!session, cleanupPending: closing.length, cleanupFailures: closing.filter(s => s.cleanupError).length }, stats)));
      },
      contextLimit(id) { return contextOf(id); },
      // The CLI reports its own billed cost per turn (see COST TRUTH above); there is no list-rate table here.
      priceOf() { return null; },
      supportsTools() { return true; },
      // a turn with an image rides the CLI's stream-json input as real image blocks (see IMAGES), so image_analyze's
      // session fallback can use a Claude Code agent's own model
      supportsImages() { return true; },
      reasoningEfforts() { return EFFORTS.slice(); }
    };
  }

  return { makeClaudeCliProvider, makeCliHost, _internals: { buildPrompt, makeCallSplitter, parseCall, invokeCall, estimateUsd, toolsPrompt, MODELS } };
});
