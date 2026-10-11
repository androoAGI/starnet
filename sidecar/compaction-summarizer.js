/* sidecar/compaction-summarizer.js — the context-compaction summarizer, extracted from index.js runOnce.

   WHY THIS FILE EXISTS. The in-line summarizer rendered the whole foldable slice to text and then
   `.slice(0, 16000)` — so on a fold that is routinely 300-500k chars the model saw only the OLDEST ~16k and the
   rest of the run's memory was silently discarded. The loop's contract was fine; the INPUT was truncated.

   CHUNKED FOLD. The slice is rendered to text (see PIXELS ARE NOT TEXT below), partitioned into chunks of `chunkChars`
   (default 48000, env STARNET_COMPACT_CHUNK_CHARS), never splitting an assistant tool_call from its tool
   results; chunk 1 is folded against the caller's prevSummary and chunk N against the running summary from
   N-1 (the existing H5.2 MERGE prompt) — SEQUENTIALLY, never in parallel, so each call sees the summary so
   far. Spend (usd/tokens/unpricedUsage) is summed. Beyond `maxChunks` (default 12) the remainder is folded as
   ONE final chunk with a `[truncated N chars]` marker in the input, and `truncatedChars` is reported so the
   loop can put it in agent.compact (truthful telemetry: a lossy fold says so).

   Contract consumed by loop.js maybeCompact: summarize(older, prevSummary, live) -> { summary, usd, tokens,
   unpricedUsage?, chunks, truncatedChars, rejected?, unbilled?, weightedTokens? }. An abort (signal.aborted) throws mid-chunk — the loop treats a
   throw as a skipped fold, exactly as before. The aux-tier reliability floor (one retry on the run model when a
   cheap aux model fails) is preserved per chunk.

   A CUT-OFF OR REFUSED SUMMARY IS A FAILED SUMMARY. A fold REPLACES the raw turns with whatever text comes back,
   so a fragment committed as "the summary" is a silent context drop dressed up as a success. Audit probe
   (09-22, Hermes parity): history was folded into "Audit config files. VALUE_01=" (the generation hit its output
   cap) and into "I'm sorry, but I can't provide the requested summary." (a refusal) — both committed, both
   deleted the run's memory. Every adapter already normalizes WHY a stream stopped (providers/provider.js `done`):
   'length' = the output cap cut it, 'content_filter' = the provider withheld it, `truncated:true` = the body
   died with no terminal signal. Those are exactly the loop's own "cut" set (loop.js lastFinishReason), and any
   of them in ANY chunk rejects the WHOLE fold: summary '' + `rejected` = the reason, so the loop keeps the
   history and counts the failure toward its compactionFails breaker (after two, the deterministic fallback note
   takes over). A later chunk merging onto an earlier good one would otherwise ship a summary that silently lost
   the cut chunk. A cut/refused AUX-model output gets the same one retry on the run model as a thrown one. An
   unrecognized upstream reason ('error') and a stream that never sent `done` are NOT treated as cut — same as
   the loop — so a working provider never loses its folds to a guess. Spend is still reported on a rejection
   (usd/tokens/unpricedUsage): the calls were made and billed. */
/* PIXELS ARE NOT TEXT (Step 2 wave 2, audit F4). Messages used to be rendered with JSON.stringify, so a screenshot's
   `image_url` part went to the summarizer as its base64 data URL — one 300k-char capture per turn, and a single
   turn-group bigger than a chunk was never split, so three screenshots became six paid summarizer calls carrying
   900,000 base64 chars that no model can read as text (audit probe 09-22). Rendering is now TEXT: text parts
   verbatim, an image part as "[image ...]" (alt/caption, or the tool that captured it), an inline data URL or a
   long raw base64 run as a sized marker (compaction-fidelity.js contentText), and an assistant's tool calls as
   "→ called name(args)" with bounded args so the summary knows what was done. A turn-group still bigger than a
   chunk is BOUNDED (head + tail of each oversized message, with an explicit marker) instead of forcing its own
   chunk, and what that cut is added to `truncatedChars` — a lossy fold says so in agent.compact. */
'use strict';

const fidelity = require('./compaction-fidelity.js');

const DEFAULT_CHUNK_CHARS = 48000;
const DEFAULT_MAX_CHUNKS = 12;
const TOOL_ARGS_MAX = 1000;

/* REFUSAL HEURISTIC — deliberately conservative, because a false positive throws away a paid, correct fold.
   ALL of: the text is short (<= REFUSAL_MAX chars); after stripping leading quote/emphasis marks it OPENS with a
   first-person refusal/apology phrase; and it carries none of the "## <section>" headings the summary prompt
   (context.js compactionSummaryPrompt) demands. A structured summary, a long one, or one that merely mentions an
   apology later on is never rejected. */
const REFUSAL_MAX = 400;
const REFUSAL_OPEN = /^(?:i\s*['’]?m sorry|i am sorry|sorry[,.!\s]|i apologi[sz]e|my apologies|unfortunately,?\s+i\b|as an ai\b|i\s+(?:can['’]?t|cannot|can not|am unable|am not able|won['’]?t|will not|must decline)\b|i['’]m (?:unable|not able)\b)/i;
function looksLikeRefusal(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length > REFUSAL_MAX) return false;
  if (/^##\s/m.test(t)) return false;                     // carries a summary section -> content, not a refusal
  return REFUSAL_OPEN.test(t.replace(/^[\s"'“”‘’*_>]+/, ''));
}
// why one summarizer generation must not be committed, or null. `finish`/`truncated` come off the adapter's done event.
function rejectReason(text, finish, truncated) {
  if (finish === 'length' || finish === 'content_filter') return finish;
  if (truncated) return 'truncated';
  if (looksLikeRefusal(text)) return 'refusal';
  return null;
}

function envInt(name, dflt) {
  const v = parseInt(String(process.env[name] || ''), 10);
  return (Number.isFinite(v) && v > 0) ? v : dflt;
}

// one message -> one text line: role + its text (see PIXELS ARE NOT TEXT). String content without binary is unchanged.
function renderMessage(mm, imageLabel) {
  let c = fidelity.contentText(mm && mm.content, imageLabel);
  if (mm && Array.isArray(mm.tool_calls)) {
    for (const t of mm.tool_calls) {
      const fn = (t && t.function) || {};
      let args = fidelity.scrubBinary(String(fn.arguments == null ? '' : fn.arguments));
      if (args.length > TOOL_ARGS_MAX) args = args.slice(0, TOOL_ARGS_MAX) + '…[' + (args.length - TOOL_ARGS_MAX) + ' more chars]';
      c += (c ? '\n' : '') + '→ called ' + (fn.name || 'tool') + '(' + args + ')';
    }
  }
  return (mm && mm.role ? mm.role : 'msg') + ': ' + c;
}

// head + tail of an oversized text with an explicit marker naming what was cut; { text, cut }
function bound(text, max) {
  if (text.length <= max) return { text, cut: 0 };
  const probe = '\n[… ' + text.length + ' chars of an oversized message omitted from the summarizer input …]\n';
  const room = Math.max(0, max - probe.length);
  const head = Math.floor(room * 0.6), tail = room - head;
  const cut = text.length - head - tail;
  return { text: text.slice(0, head) + '\n[… ' + cut + ' chars of an oversized message omitted from the summarizer input …]\n' + (tail > 0 ? text.slice(text.length - tail) : ''), cut };
}
// a turn-group over the chunk size: small messages keep their full text, the big ones share what is left equally
function fitGroup(lines, max) {
  let remaining = Math.max(0, max - (lines.length - 1));
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].length - lines[b].length);
  const alloc = new Array(lines.length);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    alloc[i] = Math.min(lines[i].length, Math.floor(remaining / (order.length - k)));
    remaining -= alloc[i];
  }
  let cut = 0;
  const out = lines.map((l, i) => { const b = bound(l, Math.max(400, alloc[i])); cut += b.cut; return b.text; });
  let text = out.join('\n');
  if (text.length > max) { const b = bound(text, max); cut += b.cut; text = b.text; }
  return { text, cut };
}

/* Partition messages into chunks by rendered size. A chunk boundary may only fall at a "turn-group start":
   never directly before a role:'tool' message (its owning assistant tool_call would be on the other side).
   A single turn-group larger than chunkChars is bounded to one chunk (fitGroup) instead of being sent whole.
   Pure. partitionDetailed also reports the characters the bounding cut. */
function partitionDetailed(messages, chunkChars) {
  const max = Math.max(1000, Math.floor(Number(chunkChars) || DEFAULT_CHUNK_CHARS));
  const groups = [];   // arrays of rendered lines
  let callNames = '';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) callNames = m.tool_calls.map(t => (t && t.function && t.function.name) || 'tool').join(', ');
    const label = (m && m.role === 'user' && fidelity.isScreenCapture(m) && callNames) ? 'screen capture from ' + callNames : '';
    const line = renderMessage(m, label);
    if (m && m.role === 'tool' && groups.length) groups[groups.length - 1].push(line);
    else groups.push([line]);
  }
  let truncatedChars = 0;
  const chunks = [];
  let cur = '';
  for (const lines of groups) {
    let text = lines.join('\n');
    if (text.length > max) { const f = fitGroup(lines, max); text = f.text; truncatedChars += f.cut; }
    if (cur && cur.length + 1 + text.length > max) { chunks.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + text : text;
  }
  if (cur) chunks.push(cur);
  return { chunks, truncatedChars };
}
function partition(messages, chunkChars) { return partitionDetailed(messages, chunkChars).chunks; }

/* makeSummarizer(deps) -> summarize(older, prevSummary, live)
   deps: streamFn(req) async-iterable of provider events (text/usage) — or provider(live)+... (see below)
         cost            — fallback cost engine (live.cost overrides)
         provider        — fallback provider (live.provider overrides)
         model           — fallback run model (live.model overrides)
         auxModelFor()   — cheap aux model or null
         auxEffortFor(provider, model) — per-request reasoning effort or null
         transcriptDrain(older) — STRICT durable-transcript drain, called ONCE before the fold (may throw)
         memoryBlockFor(transcriptText) — durable-memory block to prepend ('' for none)
         summaryPrompt({prevSummary:bool}) — the H5.1/H5.2 system prompt builder
         emit(name, payload) — bus emit for display-only agent.cost
         signal          — AbortSignal
         agentId, runId
         chunkChars, maxChunks */
function makeSummarizer(deps) {
  deps = deps || {};
  const chunkChars = deps.chunkChars || envInt('STARNET_COMPACT_CHUNK_CHARS', DEFAULT_CHUNK_CHARS);
  const maxChunks = deps.maxChunks || envInt('STARNET_COMPACT_MAX_CHUNKS', DEFAULT_MAX_CHUNKS);
  const signal = deps.signal || { aborted: false };
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};
  const summaryPrompt = deps.summaryPrompt || (() => 'Summarize.');
  const auxModelFor = deps.auxModelFor || (() => null);
  const auxEffortFor = deps.auxEffortFor || (() => null);
  const memoryBlockFor = deps.memoryBlockFor || (() => '');
  const transcriptDrain = deps.transcriptDrain || (() => {});

  async function summarize(older, prevSummary, live) {
    const sProvider = (live && live.provider) || deps.provider;
    const sCost = (live && live.cost) || deps.cost;
    const runModel = (live && live.model) || deps.model;
    const auxModel = auxModelFor();
    const sModel = auxModel || runModel;
    // TRANSCRIPT DRAIN (before the fold) — strict; a throw here leaves the history unfolded (loop contract).
    transcriptDrain(older);

    const parted = partitionDetailed(older, chunkChars);
    let chunks = parted.chunks;
    let truncatedChars = parted.truncatedChars;   // characters an oversized turn-group lost to bounding
    if (chunks.length > maxChunks) {
      const keep = chunks.slice(0, maxChunks - 1);
      const rest = chunks.slice(maxChunks - 1);
      const joined = rest.join('\n');
      truncatedChars += Math.max(0, joined.length - chunkChars);
      keep.push(joined.slice(0, chunkChars) + '\n[truncated ' + truncatedChars + ' chars]');
      chunks = keep;
    }

    let running = (typeof prevSummary === 'string' && prevSummary.trim()) ? prevSummary.trim() : '';
    let usd = 0, tokens = 0, produced = false, rejected = null, weighted = 0, unbilled = false; const unpriced = [];

    async function attempt(useModel, userMsg, hasPrev) {
      const req = { model: useModel, stream: true, signal, messages: [
        { role: 'system', content: summaryPrompt({ prevSummary: hasPrev }) },
        { role: 'user', content: userMsg }
      ] };
      const effort = auxEffortFor(sProvider, useModel);
      if (effort) req.reasoningEffort = effort;
      if (deps.runId) req.runId = deps.runId;   // run attribution (starnet proxy header; other providers ignore it)
      let out = '', usage = null, finish = null, truncated = false;
      const it = deps.streamFn ? deps.streamFn(req, sProvider) : sProvider.stream(req);
      for await (const ev of it) {
        if (ev && ev.type === 'text') out += ev.delta;
        else if (ev && ev.type === 'usage') usage = ev.usage;
        else if (ev && ev.type === 'done') { finish = ev.finishReason || null; truncated = !!ev.truncated; }   // WHY it stopped
      }
      const c = sCost ? sCost.reconcile(usage, useModel) : {};
      emit('agent.cost', { agentId: deps.agentId, runId: deps.runId, usd: c.usd || 0, model: useModel, reconciled: true });
      usd += c.usd || 0; tokens += (c.tokensIn || 0) + (c.tokensOut || 0);
      if (c.unpriced) unpriced.push({ model: useModel, tokensIn: c.tokensIn || 0, tokensOut: c.tokensOut || 0 });
      if (c.unbilled) { unbilled = true; weighted += c.weightedTokens || 0; }   // subscription use: weighted tokens for the usage limit
      const text = out.trim();
      return { text, rejected: rejectReason(text, finish, truncated) };
    }

    for (let n = 0; n < chunks.length; n++) {
      if (signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const transcript = chunks[n];
      let memBlock = '';
      try { memBlock = n === 0 ? (memoryBlockFor(transcript) || '') : ''; } catch (_) { memBlock = ''; }
      const hasPrev = !!running;
      const prevBlock = hasPrev ? 'PREVIOUS SUMMARY (update this — merge the new turns in, drop anything now obsolete):\n' + running + '\n\n' : '';
      const part = chunks.length > 1 ? ' (part ' + (n + 1) + ' of ' + chunks.length + ')' : '';
      const userMsg = (memBlock ? memBlock + '\n\n' : '') + prevBlock + 'Summarize this earlier part of the conversation' + part + ' so it can replace the raw turns:\n\n' + transcript;
      let res;
      // AUX-TIER RELIABILITY FLOOR: retry ONCE on the run model; an abort is a cancel, never retried. A cut or
      // refused aux summary is a failed one too, so it gets the same single retry (never a second).
      if (sModel === runModel) res = await attempt(sModel, userMsg, hasPrev);
      else {
        let retried = false;
        try { res = await attempt(sModel, userMsg, hasPrev); }
        catch (e) { if (signal.aborted) throw e; retried = true; res = await attempt(runModel, userMsg, hasPrev); }
        if (!retried && res.rejected && !signal.aborted) res = await attempt(runModel, userMsg, hasPrev);
      }
      // ONE cut/refused chunk rejects the whole fold: merging later chunks onto the pre-cut summary would ship a
      // summary that silently lost this chunk's turns.
      if (res.rejected) { rejected = res.rejected; break; }
      if (res.text) { running = res.text; produced = true; }   // an empty chunk summary keeps the running one
    }
    // every chunk came back empty (or one was cut/refused) -> '' so the loop refuses to drop history (never fold
    // onto a stale prior summary or a fragment)
    const r = { summary: (produced && !rejected) ? running : '', usd, tokens, chunks: chunks.length, truncatedChars };
    if (rejected) r.rejected = rejected;
    if (unpriced.length) r.unpricedUsage = unpriced;
    if (unbilled) { r.unbilled = true; r.weightedTokens = weighted; }   // additive: absent on billed folds (old shape)
    return r;
  }
  summarize.drain = transcriptDrain;
  return summarize;
}

module.exports = { makeSummarizer, partition, partitionDetailed, renderMessage, looksLikeRefusal, rejectReason, DEFAULT_CHUNK_CHARS, DEFAULT_MAX_CHUNKS };
