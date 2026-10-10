/* sidecar/providers/claude-cli.js — the local Claude Code CLI (`claude`) as a brain.

   Instead of an HTTP call, a stream() turn runs a `claude -p` child process, feeds it the transcript on stdin and
   translates its `--output-format stream-json` lines into the LLMProvider HarnessEvents (provider.js). By default
   the child's life IS the turn. With `persistent` (the factory's default), a turn with tools runs on a live child
   kept for the run and sends only what the CLI has not seen yet (see PERSISTENT SESSIONS): its turn ends at the
   CLI's result line instead of the child's exit. Either way text streams only while the CLI is answering, and
   exactly one 'done' is emitted per turn — the station never animates a brain that is not running.

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

   STOP. Aborting req.signal kills the child's whole process tree (taskkill /T on Windows) before returning; a live
   session is retired with it.

   ACCOUNTS. `configDir` points the CLI at one extra sign-in (subscription stacking): the child runs with
   CLAUDE_CONFIG_DIR=<configDir>, a separate CLI identity whose credential the CLI keeps in that folder (proven:
   an empty folder answers `auth status` signed out while ~/.claude stays signed in). No configDir = the CLI's
   own default sign-in. A spent subscription (the CLI's `error:"rate_limit"` line, "You've hit your limit") is
   thrown as a 429 `usage_limit_reached`, which errorClass files as quota_exhausted: the loop rotates to the next
   account instead of retrying this one.

   makeClaudeCliProvider({ spawn?, bin?, env?, configDir?, platform?, fs?, os?, idleMs?, statusTtlMs?, persistent? })
     -> { stream, listModels, contextLimit, priceOf, supportsTools, reasoningEfforts } */
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
     Opus read a thumbnail's headline through `claude -p --input-format stream-json`). Plain text input has no image
     channel, so a turn that carries an image rides stream-json and every other turn keeps the plain text stdin.
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

  function toolsPrompt(tools) {
    const list = [];
    for (const item of (Array.isArray(tools) ? tools : [])) {
      const fn = (item && item.function) || {};
      const name = String(fn.name || '').trim();
      if (!name) continue;
      list.push('- ' + name + (fn.description ? ': ' + String(fn.description).trim() : '') +
        '\n  parameters: ' + JSON.stringify(fn.parameters || { type: 'object', properties: {} }));
    }
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

  /* Leading system messages become the CLI system prompt; everything after is rendered as a tagged transcript
     on stdin (later system messages stay in place as notes, like the native Anthropic adapter keeps them). */
  function buildPrompt(messages, tools, cachePrefix) {
    messages = provider.repairToolPairs(Array.isArray(messages) ? messages : []);
    const system = [];
    let i = 0;
    for (; i < messages.length && messages[i] && messages[i].role === 'system'; i++) {
      const t = textOf(messages[i].content).trim();
      if (t) system.push(t);
    }
    /* Prompt caching (#68): the stable cacheSystemPrefix + tools go before the CLI's dynamic boundary and the per-run
       text (run id, task brief) after it, so each is its own cached block and a new run reuses the stable part. */
    const prefix = typeof cachePrefix === 'string' ? cachePrefix.trim() : '';
    const joined = system.join('\n\n');
    const note = prefix && joined.startsWith(prefix) ? joined.slice(prefix.length).trim() : '';
    const tp = toolsPrompt(tools);
    if (note) system.splice(0, system.length, prefix, ...(tp ? [tp] : []), DYNAMIC_BOUNDARY + '\n' + note);
    else if (tp) system.push(tp);
    const rest = messages.slice(i).filter(m => m && typeof m === 'object');
    const images = [];
    if (rest.length === 1 && rest[0].role === 'user') return withImages({ system: system.join('\n\n'), input: textOf(rest[0].content, images) }, images);
    const lines = ['<conversation>'];
    for (const m of rest) { const line = renderEntry(m, images); if (line != null) lines.push(line); }
    lines.push('</conversation>');
    lines.push('Continue as the assistant: write only your next reply.');
    return withImages({ system: system.join('\n\n'), input: lines.join('\n') }, images);
  }
  // One transcript entry as tagged text. A persistent session's delta (see PERSISTENT SESSIONS) renders through this
  // too, so the entries a live CLI receives one step at a time read exactly like the ones a fresh spawn is handed.
  function renderEntry(m, images) {
    if (m.role === 'user') return '<user>\n' + textOf(m.content, images) + '\n</user>';
    if (m.role === 'system') return '<system_note>\n' + textOf(m.content, images) + '\n</system_note>';
    if (m.role === 'tool') return '<tool_result id="' + String(m.tool_call_id || '') + '">\n' + inertTags(textOf(m.content)) + '\n</tool_result>';
    if (m.role === 'assistant') {
      let body = textOf(m.content);
      const calls = [];
      for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        const fn = (tc && tc.function) || {};
        let args = fn.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch (_) { args = String(args); } }
        calls.push(invokeText(fn.name, args == null ? {} : args));
      }
      if (calls.length) body += (body ? '\n' : '') + '<function_calls>\n' + calls.join('\n') + '\n</function_calls>';
      return '<assistant>\n' + body + '\n</assistant>';
    }
    return null;
  }
  // The entries a live session has not seen yet, as one stream-json user message (images ride as real blocks).
  function deltaInput(entries) {
    const images = [];
    const text = entries.map(m => renderEntry(m, images)).filter(l => l != null).join('\n');
    return asStreamJson(withImages({ system: '', input: text }, images));
  }
  // A persistent child always reads stream-json: a plain-text turn is wrapped as one user message.
  function asStreamJson(prompt) {
    if (prompt.streamJson) return prompt.input;
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt.input || '' }] } }) + '\n';
  }

  /* Resolve the image marks. No image: the plain text stdin, byte-identical to before. Images: the newest MAX_IMAGES
     become numbered blocks after the text ("[image 1 — attached below]" in place), older ones a note; `input` is
     then one stream-json user message and `streamJson` asks for --input-format stream-json. */
  function withImages(prompt, images) {
    if (!images.length) return prompt;
    const first = Math.max(0, images.length - MAX_IMAGES);
    const blocks = [];
    const text = prompt.input.replace(/\u0000starnet-image-(\d+)\u0000/g, (_, k) => {
      const idx = Number(k);
      if (idx < first) return '[earlier image no longer attached]';
      const n = idx - first + 1;
      blocks.push({ type: 'text', text: 'Image ' + n + ':' }, images[idx]);
      return '[image ' + n + ' — attached below]';
    });
    const content = [{ type: 'text', text }].concat(blocks);
    return { system: prompt.system, input: JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n', streamJson: true, imageCount: blocks.length / 2 };
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
    // `rest`: what was already written past the block (a live session must know whether its turn held more than the calls)
    function stop(out) { stopped = true; out.stop = true; out.rest = buf.replace(/^\s+/, '').replace(WRAP_CLOSE_RE, ''); buf = ''; return out; }
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
            if (!named) {
              const name = announcedName(buf);
              if (name) { named = true; out.items.push({ start: name }); }
              else if (buf.length > NAME_SCAN) named = null;   // no name up front: the block is judged when it closes
            }
            const end = buf.indexOf(CALL_CLOSE, scan);
            if (end < 0) { scan = Math.max(0, buf.length - (CALL_CLOSE.length - 1)); return out; }
            out.items.push({ body: buf.slice(0, end), kind, closed: true });
            buf = buf.slice(end + CALL_CLOSE.length);
          } else {
            INVOKE_CLOSE_RE.lastIndex = scan;
            let c, close = null;
            while ((c = INVOKE_CLOSE_RE.exec(buf))) {
              if (!inBlock) { close = c; break; }
              // inside <function_calls> the call ends at the </invoke> that another call or the block's close follows
              const after = buf.slice(c.index + c[0].length).replace(/^\s+/, '');
              if (!after || (after[0] === '<' && couldOpen(after) && !BLOCK_NEXT_RE.test(after))) { scan = c.index; return out; }   // still arriving
              if (BLOCK_NEXT_RE.test(after)) { close = c; break; }
            }
            if (!close) { scan = Math.max(scan, buf.length - HOLD); return out; }
            out.items.push({ body: buf.slice(0, close.index), kind, closed: true });
            buf = buf.slice(close.index + close[0].length);
          }
          calls++; mode = 'next'; continue;
        }
        // 'next': whitespace, then another call, the end of the block, or anything else (the block is over)
        const ws = buf.replace(/^\s+/, '');
        if (!ws) return out;
        if (WRAP_CLOSE_RE.test(ws)) {
          if (calls) return stop(out);
          buf = ws.replace(WRAP_CLOSE_RE, ''); mode = 'prose'; inBlock = false; continue;   // an empty block: nothing to run
        }
        const m = OPEN_RE.exec(ws);
        if (m && m.index === 0) { buf = ws; mode = 'prose'; continue; }   // the prose branch opens it at once
        if (ws[0] === '<' && couldOpen(ws)) return out;                   // '<inv…' or '</function_c…' still arriving
        if (calls) return stop(out);
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
            // a block whose stream ended before </function_calls>: its call ends at the LAST </invoke> written
            const lastClose = kind === 'invoke' && inBlock ? buf.lastIndexOf('</invoke>') : -1;
            if (lastClose >= 0) out.items.push({ body: buf.slice(0, lastClose), kind, closed: true });
            else if (kind === 'invoke' || named === true || parseCall(buf)) out.items.push({ body: buf, kind, closed: false });
            else addText(out, CALL_OPEN + buf);
          } else if (mode === 'prose') addText(out, buf);
        }
        buf = ''; mode = 'prose'; named = false; scan = 0;
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
    function killTree(child) {
      if (!child || child.exitCode != null) return;
      try {
        if (platform === 'win32' && child.pid) {
          const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          if (k && typeof k.on === 'function') k.on('error', () => killDirect(child));
        } else child.kill('SIGTERM');
      } catch (e) { failNote('claudecli.killtree', e); killDirect(child); }
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
  /* PERSISTENT SESSIONS (2026-10-09, #68 follow-up). A fresh `claude -p` per tool step hands the CLI the whole
     transcript as ONE growing stdin block, and a block that grew cannot hit the previous step's cache: every step
     re-wrote the full transcript at the 1h cache-write rate (2x), so a run cost grew with the square of its steps
     (measured: cache writes 2.6k -> 4.6k -> 6.6k -> 8.6k over steps 2-5). With `persistent`, one child per run is
     kept alive on `--input-format stream-json` and each step writes ONLY the entries it has not seen (the tool
     results, a user line, a note). The CLI holds the earlier turns as real messages, so they are cache READS (0.1x)
     and only the delta is written (measured: a flat ~2k write per step, -43% weighted over 5 steps).
     Still no session file: the child keeps --no-session-persistence, the conversation lives only in its memory.
     A session is reused only when the request is provably the same conversation one step later: same account,
     model, effort and system prompt (the per-run note makes that per run), the messages it served unchanged as a
     prefix, then the assistant turn it produced (same call ids, or same text), then only new non-assistant
     entries. Anything else (compaction, a repaired or aged-out entry, a retry) spawns a fresh child, so a reuse can
     never show the model a history StarNet does not have. The pool is module-wide because the factory builds a
     fresh adapter per request. */
  const SESSION_MAX = 4;                       // live children kept at once; the least recently used goes first
  const SESSION_IDLE_MS = 10 * 60 * 1000;      // a run that stalls this long (a consent prompt left open) respawns
  const STOP_DRAIN_MS = 10000;                 // after the call block's interrupt, how long the turn may take to end
  // What a live session hears next when its last turn was cut off past the call block (see the STOP in stream()).
  const CUT_NOTE = 'Your previous reply was cut off right after its </function_calls> block. Anything you wrote after that block was discarded: it was never shown, and nothing in it ran. The real results follow.';
  const sessions = [];
  let exitHooked = false, useSeq = 0;   // useSeq orders sessions by last use (no wall clock: determinism law)
  function retireSession(s) {
    if (!s || s.retired) return;
    s.retired = true;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const at = sessions.indexOf(s);
    if (at >= 0) sessions.splice(at, 1);
    try { s.child.stdin.end(); } catch (e) { failNote('claudecli.session.stdin', e); }
    if (!s.closed) s.kill();
    s.removeSysFile();
  }
  function hookExit() {
    if (exitHooked || typeof process === 'undefined' || typeof process.on !== 'function') return;
    exitHooked = true;
    // a synchronous last word: kill() on each live child (a taskkill spawn would not finish before exit)
    process.on('exit', () => { for (const s of sessions.slice()) { try { s.child.kill(); } catch (e) { failNote('claudecli.session.exitkill', e); } } });
  }
  const stableEntry = m => JSON.stringify(m);
  // The entries `msgs` adds to what session `s` already holds, or null when `msgs` is not its conversation one step on.
  function sessionDelta(s, msgs) {
    const served = s.served;
    if (!served || msgs.length <= served.length + 1) return null;
    for (let i = 0; i < served.length; i++) if (stableEntry(msgs[i]) !== served[i]) return null;
    const a = msgs[served.length];
    if (!a || a.role !== 'assistant') return null;
    const ids = (Array.isArray(a.tool_calls) ? a.tool_calls : []).map(tc => String((tc && tc.id) || ''));
    if (s.emittedIds.length) { if (ids.join('\n') !== s.emittedIds.join('\n')) return null; }
    else if (ids.length || textOf(a.content).trim() !== s.lastText.trim()) return null;
    const rest = msgs.slice(served.length + 1);
    if (rest.some(m => !m || typeof m !== 'object' || m.role === 'assistant' || renderEntry(m, []) == null)) return null;
    return rest;
  }
  function persistOn(env) {
    return !(env && String(env.STARNET_CLAUDE_CLI_PERSIST || '').trim() === '0');
  }

  function makeClaudeCliProvider(opts) {
    opts = opts || {};
    const host = makeCliHost(opts);
    const { spawn, fs, os, path, command, notInstalled, childEnv, killTree } = host;
    const statusTtlMs = opts.statusTtlMs != null ? opts.statusTtlMs : 60000;
    // Injected wall clock (determinism law). Without one, a proven sign-in is kept for this instance's life
    // and a failed probe is never cached — the factory builds a fresh adapter per request anyway.
    const clock = (opts.clock && typeof opts.clock.now === 'function') ? opts.clock : null;
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

    async function* stream(req) {
      req = req || {};
      const signal = req.signal;
      if (signal && signal.aborted) return;
      const cmd = command();
      if (!cmd) throw notInstalled();
      const prompt = buildPrompt(req.messages, req.tools, req.cacheSystemPrefix);
      const turn = ++seq;
      const effort = String(req.reasoningEffort || '').trim().toLowerCase();
      // only a turn with tools can have a next step; a tool-less call (a title, a reflection, a profile note) is one-shot
      // and keeps the plain path rather than parking an idle child that nothing will continue (live 2026-10-09)
      const persistent = !!opts.persistent && Array.isArray(req.tools) && req.tools.length > 0
        && persistOn(opts.env || (typeof process !== 'undefined' ? process.env : null));
      const msgs = persistent ? provider.repairToolPairs(Array.isArray(req.messages) ? req.messages : []).filter(m => m && typeof m === 'object') : null;
      const key = persistent ? require('crypto').createHash('sha256')
        .update([opts.configDir || '', req.model || '', effort, prompt.system || ''].join('\u0000')).digest('hex') : '';

      // Child output is bridged into this generator through a small queue so events are yielded as they arrive.
      const queue = [];
      let wake = null, closed = false, failure = null, exitCode = null;
      const push = (item) => { queue.push(item); if (wake) { const w = wake; wake = null; w(); } };
      const idle = opts.idleMs || timeouts.idleMs();
      let idleTimer = null, finished = false;
      let child, sess = null, sessOk = false, sessKeep = true;
      const stopChild = () => { if (sess) sessKeep = false; killTree(child); };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (finished) return;   // late output after a stop must not re-arm a watchdog nobody is waiting on
        idleTimer = setTimeout(() => { failure = timeouts.timeoutError(idle, 'idle'); stopChild(); push(null); }, idle);
      };
      const onAbort = () => { stopChild(); push(null); };
      const onLine = (line) => { armIdle(); push(line); };

      let input = prompt.input || '';
      if (persistent) {
        const live = sessions.find(s => s.key === key && !s.busy && !s.retired && !s.closed);
        const delta = live ? sessionDelta(live, msgs) : null;
        if (delta) { sess = live; input = deltaInput(live.cutNote ? [{ role: 'system', content: CUT_NOTE }].concat(delta) : delta); }
        else {
          for (const s of sessions.slice()) if (s.key === key && !s.busy) retireSession(s);
          input = asStreamJson(prompt);
        }
      }
      if (!sess) {
        const sysFile = path.join(os.tmpdir(), 'starnet-claude-cli-' + process.pid + '-' + turn + '-' + require('crypto').randomBytes(6).toString('hex') + '.txt');
        const args = cmd.pre.concat(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'], NO_TOOLS_ARGS);
        if (persistent || prompt.streamJson) args.push('--input-format', 'stream-json');   // images (see IMAGES), or a live session
        if (req.model) args.push('--model', String(req.model));
        if (EFFORTS.indexOf(effort) >= 0) args.push('--effort', effort);
        if (prompt.system) { fs.writeFileSync(sysFile, prompt.system, { encoding: 'utf8', mode: 0o600 }); args.push('--system-prompt-file', sysFile); }
        let c;
        try {
          c = spawn(cmd.file, args, { env: childEnv(), cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
          removeFile(sysFile);
          throw notInstalled();
        }
        // One reader per child for its whole life; a turn listens through `listener` while it runs. Between turns a
        // live session's stray lines (status notes) have no listener and are dropped.
        const s = { key, child: c, listener: null, closed: false, retired: false, busy: true, served: null, emittedIds: [],
          lastText: '', lastCost: 0, apiKeySource: null, stderr: '', exitCode: null, idleTimer: null, usedAt: 0,
          kill: () => killTree(c), removeSysFile: () => removeFile(sysFile) };
        let lineBuf = '';
        c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
        c.on('error', (e) => { s.error = (e && e.code === 'ENOENT') ? notInstalled() : e; s.closed = true; if (s.listener) s.listener(null); });
        c.stdout.on('data', (d) => {
          lineBuf += d;
          let nl;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (line && s.listener) s.listener(line);
          }
        });
        c.stderr.on('data', (d) => { s.stderr = (s.stderr + d).slice(-4000); });
        c.on('close', (code) => {
          s.exitCode = code;
          if (lineBuf.trim() && s.listener) s.listener(lineBuf.trim());
          lineBuf = ''; s.closed = true;
          if (s.listener) s.listener(null);
          if (persistent) retireSession(s); else s.removeSysFile();
        });
        // A child that dies before reading stdin surfaces through its exit (no result line), not through EPIPE here.
        c.stdin.on('error', e => failNote('claudecli.stdin', e));
        if (persistent) {
          hookExit();
          if (sessions.length >= SESSION_MAX) {
            const idleOnes = sessions.filter(x => !x.busy).sort((a, b) => a.usedAt - b.usedAt);
            if (idleOnes.length) retireSession(idleOnes[0]);
          }
          sessions.push(s);
        }
        sess = s;
      } else {
        if (sess.idleTimer) { clearTimeout(sess.idleTimer); sess.idleTimer = null; }
        sess.busy = true;
      }
      child = sess.child;
      sess.listener = (line) => {
        if (line != null) return onLine(line);
        if (sess.error) failure = sess.error;
        exitCode = sess.exitCode; closed = true; push(null);
      };
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      armIdle();
      try {
        if (persistent) child.stdin.write(input);
        else child.stdin.end(input);
      } catch (e) { failNote('claudecli.stdin', e); }

      const splitter = makeCallSplitter({ enabled: Array.isArray(req.tools) && req.tools.length > 0 });
      const props = {};   // tool name -> its parameter schemas: a string <parameter> stays raw, the rest parse as JSON
      for (const t of (Array.isArray(req.tools) ? req.tools : [])) {
        const fn = t && t.function;
        if (fn && fn.name) props[String(fn.name)] = (fn.parameters && fn.parameters.properties) || {};
      }
      let callIndex = 0, sawText = false, result = null, apiKeySource = null, apiError = '';
      let blockDone = false, streamUsage = null;   // the call block ended the turn (see the reader's STOP)
      let outChars = 0;   // what the model wrote this turn: the floor for its output tokens when the stop cut the count short
      let emittedText = '', trailing = '', drainTimer = null, interrupted = false;   // a live session: what it said, what it wrote past its STOP
      const emittedIds = [];
      const callId = index => 'call_cli_' + idTag + '_' + turn + '_' + index;
      let open = null;   // the call a tool_start already announced, whose block has not closed yet
      function* emitSplit(part) {
        for (const it of part.items) {
          if (it.text != null) { if (it.text) { sawText = true; emittedText += it.text; yield { type: 'text', delta: it.text }; } continue; }
          if (it.start) {
            open = { index: callIndex++, name: it.start };
            emittedIds[open.index] = callId(open.index);
            yield { type: 'tool_start', index: open.index, id: callId(open.index), name: it.start };
            continue;
          }
          const was = open; open = null;
          const call = it.kind === 'invoke' ? invokeCall(was ? was.name : '', it.body, props[was ? was.name : ''], it.closed)
            : (parseCall(it.body) || (was ? looseCall(it.body, was.name) : null));
          if (!call) {
            const t = CALL_OPEN + it.body + (it.closed ? CALL_CLOSE : '');
            if (was) emittedIds[was.index] = null;   // an announced call that came to nothing: no call id in the transcript
            sawText = true; emittedText += t; yield { type: 'text', delta: t }; continue;
          }
          const index = was ? was.index : callIndex++;
          emittedIds[index] = callId(index);
          if (!was) yield { type: 'tool_start', index, id: callId(index), name: call.name };
          yield { type: 'tool_args', index, chunk: call.args };
          yield { type: 'tool_done', index };
        }
      }
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
          if (j.type === 'system' && j.subtype === 'init') apiKeySource = j.apiKeySource == null ? null : String(j.apiKeySource);
          else if (j.type === 'stream_event' && j.event && j.event.type === 'content_block_delta' && j.event.delta && j.event.delta.type === 'text_delta') {
            outChars += String(j.event.delta.text || '').length;
            // A live session past its STOP: nothing more is shown. What still streams before the interrupt lands is in
            // the CLI's history (proven live: it can quote the cut-off words back), so it is kept to say so next step.
            if (blockDone) { trailing += String(j.event.delta.text || ''); continue; }
            const part = splitter.push(j.event.delta.text);
            yield* emitSplit(part);
            if (part.stop) {
              blockDone = true;
              if (!persistent) break;
              trailing += part.rest || '';
              /* STOP ON A LIVE SESSION. Killing the child (the one-shot path) would lose the session; letting the turn run
                 on lets a model that keeps writing guessed results bill them (live 2026-10-09: Haiku wrote ~3k output
                 tokens past every block). The CLI's own interrupt ends the generation now and keeps the session: its
                 result line then arrives as error_during_execution with zero usage (proven live), and a late interrupt
                 on a turn that already ended is a no-op. */
              try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'stop_' + idTag + '_' + turn, request: { subtype: 'interrupt' } }) + '\n'); interrupted = true; }
              catch (e) { failNote('claudecli.interrupt', e); }
              drainTimer = setTimeout(() => { stopChild(); push(null); }, STOP_DRAIN_MS);
            }
          } else if (j.type === 'stream_event' && j.event && j.event.type === 'message_start') streamUsage = Object.assign({}, j.event.message && j.event.message.usage);
          else if (j.type === 'stream_event' && j.event && j.event.type === 'message_delta' && j.event.usage) streamUsage = Object.assign(streamUsage || {}, j.event.usage);
          else if (j.type === 'assistant' && j.error) apiError = String(j.error);
          else if (j.type === 'result') {
            result = j;
            if (persistent) {
              // a live session's result ends the turn. Its usage is this turn's own; total_cost_usd is the session's
              // running total (proven live 2026-10-09), so the turn is booked the difference
              const total = Number(j.total_cost_usd);
              if (isFinite(total)) { result = Object.assign({}, j, { total_cost_usd: total - sess.lastCost }); sess.lastCost = total; }
              break;
            }
          }
        }
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
        if (persistent) {
          if (apiKeySource != null) sess.apiKeySource = apiKeySource;
          else apiKeySource = sess.apiKeySource;
        }
        if (signal && signal.aborted) return;
        const usageChunk = () => {
          const u = result.usage || {};
          const uncached = Number(u.input_tokens) || 0, cacheWrite = Number(u.cache_creation_input_tokens) || 0;
          const cacheRead = Number(u.cache_read_input_tokens) || 0, out = Number(u.output_tokens) || 0;
          const subscription = apiKeySource === 'none';
          const reported = Number(result.total_cost_usd);
          return {
            type: 'usage',
            usage: {
              prompt_tokens: uncached + cacheWrite + cacheRead,
              completion_tokens: out,
              total_tokens: uncached + cacheWrite + cacheRead + out,
              prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: cacheWrite },
              reasoning_tokens: 0,
              // subscription login: nothing is billed per call. API key: the CLI's own billed figure.
              cost: subscription ? 0 : (isFinite(reported) ? reported : undefined)
            }
          };
        };
        if (blockDone && persistent && result && !result.is_error && (!result.subtype || result.subtype === 'success')) {
          // a live session ended its turn by itself after the call block: its result line is exact, nothing to estimate
          sessOk = true;
          yield usageChunk();
          yield { type: 'done', finishReason: 'tool_calls', truncated: false };
          return;
        }
        if (blockDone) {
          // a live session whose interrupt ended the turn stays usable; any other unclean end (drain timeout, exit) retires it
          if (sess && persistent) { if (interrupted && result && result.subtype === 'error_during_execution') sessOk = true; else sessKeep = false; }
          // The calls are complete; the rest of this generation is the model guessing at results. `finally` ends the
          // child, so no result line comes: book what the stream itself reported (the input side is exact; output is
          // the last count the stream gave, which can run short of the tokens spent before the stop).
          // COST TRUTH ON A STOP (sweep 2026-10-03): no result line means no billed figure, and the stream's last output
          // count is usually 1 (message_delta never came). An API-key sign-in IS billed for this turn, so it is priced
          // from the list-rate table with output floored at ~4 characters a token — it booked $0 and the caps never saw
          // a tool-calling turn. A subscription stays $0 (nothing is billed per call).
          const su = Object.assign({}, streamUsage || {});
          su.output_tokens = Math.max(Number(su.output_tokens) || 0, Math.ceil(outChars / 4));
          result = { usage: su, total_cost_usd: apiKeySource === 'none' ? NaN : estimateUsd(su, req.model) };
          yield usageChunk();
          yield { type: 'done', finishReason: 'tool_calls', truncated: false };
          return;
        }
        if (!result) {
          const tail = String(sess.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
          throw new Error('Claude Code exited with code ' + exitCode + ' before answering' + (tail ? ': ' + tail : ''));
        }
        if (result.is_error || (result.subtype && result.subtype !== 'success')) {
          // a failed turn can still have been BILLED (an API-key sign-in pays for the tokens it used): report what the
          // CLI's result line says it cost before failing, so the ledger and the caps see it (sweep 2026-10-02)
          if (result.usage || isFinite(Number(result.total_cost_usd))) yield usageChunk();
          // The CLI tags a lost sign-in on its assistant line ("error":"authentication_failed"). Carry it as a 401 so
          // errorClass files it as `auth` (fail now, say why) instead of `unknown`, which the loop retries for ~105s.
          if (apiError === 'authentication_failed') {
            const e = new Error('Claude Code is not signed in (' + String(result.result || 'authentication failed').slice(0, 200) + ') — press SIGN IN on the CLAUDE CODE card (Settings → PROVIDERS), then retry');
            e.status = 401; e.code = 'provider_not_configured';
            throw e;
          }
          // A spent subscription window ("You've hit your limit · resets 5pm …"): a 429 usage_limit_reached is
          // quota_exhausted — no retry on this sign-in, rotate to the next connected account (or fall back).
          if (apiError === 'rate_limit') {
            const e = new Error('Claude Code usage limit reached: ' + String(result.result || 'rate limited').slice(0, 300));
            e.status = 429; e.code = 'usage_limit_reached';
            throw e;
          }
          throw new Error('Claude Code error: ' + String(result.result || result.subtype || 'unknown error').slice(0, 400));
        }
        if (!sawText && callIndex === 0 && typeof result.result === 'string') yield* emitSplit(splitter.push(result.result));
        yield* emitSplit(splitter.end());
        sessOk = true;
        yield usageChunk();
        yield { type: 'done', finishReason: callIndex > 0 ? 'tool_calls' : provider.normalizeFinish(result.stop_reason), truncated: false };
      } finally {
        finished = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        if (drainTimer) clearTimeout(drainTimer);
        if (sess) sess.listener = null;
        if (!persistent) {
          if (!closed) killTree(child);
          sess.removeSysFile();
        } else if (sessOk && sessKeep && !sess.closed && !sess.retired && !(signal && signal.aborted)) {
          // the turn ended cleanly: the session now holds exactly this conversation plus the reply it just gave
          sess.served = msgs.map(stableEntry);
          sess.emittedIds = emittedIds.filter(id => id);
          sess.lastText = emittedText;
          sess.cutNote = !!trailing.trim();
          sess.busy = false;
          sess.usedAt = ++useSeq;
          sess.idleTimer = setTimeout(() => retireSession(sess), SESSION_IDLE_MS);
          if (sess.idleTimer && typeof sess.idleTimer.unref === 'function') sess.idleTimer.unref();
        } else retireSession(sess);
      }
    }

    return {
      stream,
      listModels,
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

  return { makeClaudeCliProvider, makeCliHost, _internals: { buildPrompt, makeCallSplitter, parseCall, invokeCall, estimateUsd, toolsPrompt, MODELS, sessions, retireSession } };
});
