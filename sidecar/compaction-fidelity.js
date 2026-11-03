/* sidecar/compaction-fidelity.js — pure helpers that keep a context fold FAITHFUL (Step 2 wave 2, Hermes audit).
   Zero IO, no clock, deterministic. Callers: loop.js maybeCompact (fold notes, usage anchor, overflow recovery) and
   compaction-summarizer.js (text rendering of message content).

   USER WORDS SURVIVE A FOLD. Only the FIRST user message was pinned; every later one went through the summarizer, and
   a generic summary silently dropped a "NEVER modify prod-db.conf" constraint the user had added mid-conversation
   (audit probe 09-22). A fold now carries the user messages of the folded slice VERBATIM in a deterministic section
   at the end of the summary note, whatever the summarizer returned (paid fold, fallback digest, and the merge of an
   earlier fold's note alike). The section is host-owned: it is split OFF the previous note before the summarizer
   sees the previous summary, so the model can neither paraphrase nor duplicate it, and re-rendered from its parsed
   items — a message is folded exactly once, so successive folds append and never repeat it. Bounded: a
   window-scaled character budget shared FAIRLY (a short message whole, a long one cut to its share and marked), the
   oldest dropped only when even a floor per message no longer fits, counted in an explicit
   "[k earlier user messages omitted]" line. Items are LENGTH-PREFIXED ("[user message: 57 chars]" + exactly 57
   chars), so any text — even text that looks like a header or the closing tag — round-trips byte-identical.
   Commander steering notes (<steering_note> system messages) are the same class of words and ride along too;
   screenshot pixels handed back by a tool (a user-role message the loop builds) are not the user's words and do not.

   USAGE ANCHOR. The provider's prompt_tokens describes the PREVIOUS request; everything appended since (tool
   results above all) is invisible to it, and before the first call there is no reading at all. anchor = last real
   count + the local estimate of what grew since that reading; no reading = the full local estimate.

   PROVIDER-REPORTED WINDOW. An overflow error that names its numbers ("215000 tokens > 200000 maximum") is the most
   truthful ruler there is: it calibrates whether a fold really got under the window, and a named window smaller
   than the catalog's is adopted. */
'use strict';
const UserText = require('../frontend/app/usertext.js');
const TurnKinds = require('../frontend/app/turnkinds.js');

const VERBATIM_OPEN = '<user_messages_verbatim>';
const VERBATIM_CLOSE = '</user_messages_verbatim>';
const VERBATIM_LEAD = 'The user\'s own messages from the folded part of this conversation, carried word for word (oldest first). They are the user\'s actual words and outrank any paraphrase of them in the summary above.';
const PER_MESSAGE_MAX_CHARS = 4000;
const STEER_RE = /^<steering_note>([\s\S]*)<\/steering_note>$/;
const LABEL = { user: 'user message', steer: 'steering note', task: 'current task' };
const KIND_OF = { 'user message': 'user', 'steering note': 'steer', 'current task': 'task' };
const ITEM_HEAD = /^\[(user message|steering note|current task): (?:first (\d+) of (\d+)|(\d+)) chars\]\n/;
const OMITTED_LINE = /^\[(\d+) earlier user messages? omitted\]\n/;

// character budget for the verbatim section: ~5% of the window (4 chars/token), floor 2k, ceiling 24k (Hermes' cap)
function userBudgetChars(windowTokens) {
  const w = Math.floor(Number(windowTokens) || 0);
  if (!(w > 0)) return 12000;
  return Math.max(2000, Math.min(24000, Math.round(w * 0.05 * 4)));
}

// a string cut that never leaves half of a surrogate pair at the end
function cut(s, n) {
  let k = Math.max(0, Math.floor(n));
  if (k > 0 && k < s.length) { const c = s.charCodeAt(k - 1); if (c >= 0xD800 && c <= 0xDBFF) k--; }
  return s.slice(0, k);
}

// a user-role turn the loop built from a tool's screenshot pixels (its first text part is the capture fence)
function isScreenCapture(m) {
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return false;
  for (const p of m.content) {
    const t = typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : null);
    if (t != null) return TurnKinds.classify({ role: 'user', content: t }).kind === 'capture';
  }
  return false;
}

// the user's words in a message's content: string as-is; array = its text parts (images counted, never carried)
function userText(content) {
  return UserText.flatten(content, UserText.LABELLED);
}

// the user/steering words inside a slice about to be folded, oldest first. opts.pinned = the run's own request
// (loop.js runRequest): matched by identity or by its exact text, it is carried as the 'current task'.
function collectUserMessages(older, opts) {
  const out = [];
  const pinned = opts && opts.pinned && typeof opts.pinned === 'object' ? opts.pinned : null;
  const pinnedText = pinned && pinned.role === 'user' ? userText(pinned.content) : '';
  for (const m of (Array.isArray(older) ? older : [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      const t = userText(m.content);
      if (t) out.push({ kind: (pinned && (m === pinned || (pinnedText && t === pinnedText))) ? 'task' : 'user', text: t, fullChars: t.length });
    } else if (m.role === 'system' && typeof m.content === 'string') {
      const s = STEER_RE.exec(m.content);
      if (s && s[1].trim()) out.push({ kind: 'steer', text: s[1], fullChars: s[1].length });
    }
  }
  return out;
}

function capItem(it, max) {
  if (it.text.length <= max) return it;
  return { kind: it.kind, text: cut(it.text, max), fullChars: Math.max(Number(it.fullChars) || 0, it.text.length) };
}

/* prev (the parsed section of the previous note) + fresh (this fold's slice) -> the bounded section to render.
   FAIR SHARE, NOT NEWEST-FIRST PACKING. Packing whole messages newest-first let a few long chatty messages crowd a
   one-line constraint out of the budget (live proof 09-23: a 66-char "NEVER modify prod-db.conf" was dropped
   behind 2,200-char notes). Now every carried message gets an equal share of the budget — a short one is kept
   whole, a long one is cut to its share and says so — and only when even SHARE_FLOOR chars each would not fit are
   the OLDEST messages dropped (counted in the omitted line). An identical text repeated ("continue") is carried
   once, at its newest position.

   INSTRUCTIONS FIRST, ACKNOWLEDGEMENTS LAST (consistency audit 2026-10-11). Fair share still cut a 1,500-char
   spec to ~480 chars once fifty folded messages shared the budget, and a long chat dropped its OLDEST messages
   first — which is exactly where the Commander's standing instructions live ("always…", "never…", "from now
   on…"). Each carried message now has a priority (messagePriority): an instruction-shaped message is dropped
   only after every ordinary one, a bare acknowledgement ("ok", "thanks", "continue") goes first, and the
   instructions are water-filled first with up to RULE_SHARE of the budget before ordinary messages share the
   rest. With no instruction-shaped message the allocation is exactly the fair share above. The run's OWN request
   (loop.js runRequest, collected with `pinned`) rides as the "current task": allocated before everything else (up
   to TASK_SHARE of the budget when others share it) and never dropped — a long agentic run that folds its own task
   keeps it word for word. */
const SHARE_FLOOR = 240;
const RULE_SHARE = 0.6;
const TASK_SHARE = 0.7;
const RULE_RE = /\b(?:always|never|don['’]?t|do not|doesn['’]?t|must(?:n['’]?t)?|make sure|ensure|from now on|going forward|in (?:the )?future|next time|every time|remember|keep (?:it|them|this|that|the|using|to)|stop (?:doing|using|adding|making|saying)|no more|only (?:use|ever)|use only|instead of|rather than|prefer(?:s|red)?|i (?:want|need|like|hate|dislike|don['’]?t like)|avoid|(?:the )?rule|requirement|style|approved)\b/i;
const ACK_RE = /^(?:ok(?:ay)?|k|thanks?(?: you)?|thx|ty|cool|nice|great|good|perfect|awesome|yes|yep|yeah|yup|no|nope|sure|continue|go(?: on| ahead)?|do it|proceed|next|lol|haha|done|got it|sounds good|looks good|lgtm)[\s.!?,]*$/i;
// 2 = an instruction the Commander gave, 0 = a bare acknowledgement, 1 = everything else
function messagePriority(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return 0;
  if (RULE_RE.test(t)) return 2;
  if (ACK_RE.test(t)) return 0;
  return 1;
}
// water-fill `budget` across `idx` (indexes into items): smallest first, each takes min(its cap, an equal share)
function waterFill(items, idx, budget, cap, alloc) {
  const order = idx.slice().sort((a, b) => cap(items[a]) - cap(items[b]));
  let remaining = Math.max(0, budget);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    alloc[i] = Math.max(1, Math.min(cap(items[i]), Math.floor(remaining / (order.length - k))));
    remaining -= alloc[i];
  }
  return remaining;
}
function mergeUserMessages(prev, fresh, budgetChars) {
  const p = prev || {};
  const all = (Array.isArray(p.items) ? p.items : []).concat(Array.isArray(fresh) ? fresh : []);
  const seen = new Set();
  const uniq = [];   // newest first
  for (let k = all.length - 1; k >= 0; k--) {
    const it = all[k];
    if (!it || typeof it.text !== 'string') continue;
    const key = it.kind + '\n' + it.text;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }
  const budget = Math.max(1, Math.floor(Number(budgetChars) || 0) || userBudgetChars(0));
  const cap = (it) => Math.min(it.text.length, PER_MESSAGE_MAX_CHARS);
  // the run's own request (kind 'task') outranks everything and is never dropped
  const prio = uniq.map(it => it.kind === 'task' ? 3 : messagePriority(it.text));
  // which messages can each keep at least min(own length, SHARE_FLOOR)? Drop the lowest priority first, oldest first
  // within a priority (uniq is newest first, so the oldest is the highest index), and always keep at least one.
  // The current task is counted at the share it will really take (up to TASK_SHARE), not at the floor: counting it
  // at 240 kept every message, then the task took 70% and ordinary messages were cut to 1-char stubs (review
  // memory-learning-05). Now what cannot keep its floor is dropped and counted in the omitted line instead.
  const floorOf = it => Math.min(cap(it), SHARE_FLOOR);
  const others = prio.some(x => x !== 3);
  const dropped = new Set();
  let need = Math.min(uniq.reduce((a, it, k) => a + (prio[k] === 3 ? cap(it) : 0), 0), others ? Math.floor(budget * TASK_SHARE) : budget);
  for (let k = 0; k < uniq.length; k++) if (prio[k] !== 3) need += floorOf(uniq[k]);
  for (let level = 0; level <= 2 && need > budget; level++) {   // level 3 (the current task) is never dropped
    for (let k = uniq.length - 1; k >= 0 && need > budget; k--) {
      if (prio[k] !== level || dropped.has(k) || dropped.size >= uniq.length - 1) continue;
      dropped.add(k); need -= floorOf(uniq[k]);
    }
  }
  const keepIdx = [];
  for (let k = 0; k < uniq.length; k++) if (!dropped.has(k)) keepIdx.push(k);
  const keep = keepIdx.map(k => uniq[k]);
  const keepPrio = keepIdx.map(k => prio[k]);
  const alloc = new Array(keep.length);
  const tasks = [], rules = [], rest = [];
  for (let i = 0; i < keep.length; i++) (keepPrio[i] === 3 ? tasks : keepPrio[i] === 2 ? rules : rest).push(i);
  let remaining = budget;
  // the current task takes what it needs first (up to TASK_SHARE of the budget when other messages share it)
  if (tasks.length) {
    const taskBudget = (rules.length || rest.length) ? Math.floor(remaining * TASK_SHARE) : remaining;
    remaining = remaining - taskBudget + waterFill(keep, tasks, taskBudget, cap, alloc);
  }
  if (rules.length && rest.length) {
    // instructions next: up to RULE_SHARE of what is left (never less than the floor each of them is owed), and never
    // so much that an ordinary message kept above loses the floor it is owed
    const restFloor = rest.reduce((a, i) => a + floorOf(keep[i]), 0);
    const ruleRoom = Math.max(0, remaining - restFloor);
    const ruleBudget = Math.max(Math.min(ruleRoom, rules.reduce((a, i) => a + floorOf(keep[i]), 0)), Math.min(Math.floor(remaining * RULE_SHARE), ruleRoom));
    const left = waterFill(keep, rules, ruleBudget, cap, alloc);
    waterFill(keep, rest, remaining - ruleBudget + left, cap, alloc);
  } else if (rules.length || rest.length) {
    waterFill(keep, rules.length ? rules : rest, remaining, cap, alloc);
  }
  const kept = keep.map((it, i) => capItem(it, alloc[i]));
  return { items: kept.reverse(), omitted: (Math.max(0, Math.floor(Number(p.omitted) || 0))) + dropped.size };
}

function renderUserSection(sec) {
  const items = (sec && Array.isArray(sec.items)) ? sec.items : [];
  const omitted = (sec && sec.omitted > 0) ? Math.floor(sec.omitted) : 0;
  if (!items.length && !omitted) return '';
  let s = VERBATIM_OPEN + '\n' + VERBATIM_LEAD + '\n';
  if (omitted) s += '[' + omitted + ' earlier user message' + (omitted === 1 ? '' : 's') + ' omitted]\n';
  for (const it of items) {
    const n = it.text.length;
    const full = Math.max(Number(it.fullChars) || 0, n);
    s += '[' + (LABEL[it.kind] || LABEL.user) + ': ' + (full > n ? 'first ' + n + ' of ' + full : n) + ' chars]\n' + it.text + '\n';
  }
  return s + VERBATIM_CLOSE;
}

// strict parse of a section body (between the opening tag's newline and the closing tag); null = not a section
function parseSection(body) {
  if (body.indexOf(VERBATIM_LEAD + '\n') !== 0) return null;
  let pos = VERBATIM_LEAD.length + 1;
  let omitted = 0;
  const om = OMITTED_LINE.exec(body.slice(pos, pos + 80));
  if (om) { omitted = Number(om[1]) || 0; pos += om[0].length; }
  const items = [];
  while (pos < body.length) {
    const h = ITEM_HEAD.exec(body.slice(pos, pos + 120));
    if (!h) return null;
    pos += h[0].length;
    const n = Number(h[2] || h[4]);
    if (!(n >= 0) || pos + n >= body.length + 1) return null;
    const text = body.slice(pos, pos + n);
    if (text.length !== n || body.charAt(pos + n) !== '\n') return null;
    pos += n + 1;
    items.push({ kind: KIND_OF[h[1]] || 'user', text, fullChars: h[3] ? Number(h[3]) : n });
  }
  return { items, omitted };
}

/* A summary note's inner text -> { summary, items, omitted }. The section is the LAST thing in the note; the first
   line-start opening tag whose strict parse runs exactly to the end is it (a tag quoted inside a summary or inside a
   carried message cannot parse that way). No section = the whole text is the summary. */
function splitSummary(inner) {
  const s = String(inner == null ? '' : inner);
  const none = { summary: s.trim(), items: [], omitted: 0 };
  if (s.slice(-VERBATIM_CLOSE.length) !== VERBATIM_CLOSE) return none;
  const open = VERBATIM_OPEN + '\n';
  let from = 0;
  for (;;) {
    const at = s.indexOf(open, from);
    if (at < 0) return none;
    if (at === 0 || s.charAt(at - 1) === '\n') {
      const parsed = parseSection(s.slice(at + open.length, s.length - VERBATIM_CLOSE.length));
      if (parsed) return { summary: s.slice(0, at).trim(), items: parsed.items, omitted: parsed.omitted };
    }
    from = at + 1;
  }
}

function joinSummary(summary, section) {
  const a = String(summary == null ? '' : summary).trim();
  const b = String(section == null ? '' : section);
  return a && b ? a + '\n\n' + b : (a || b);
}

// anchor = last real prompt count + what the local ruler says grew since; no reading = the full local ruler
function usageAnchor(reading, rulerNow) {
  const now = Math.max(0, Number(rulerNow) || 0);
  const real = reading ? Math.max(0, Number(reading.promptTokens) || 0) : 0;
  if (!(real > 0)) return now;
  const at = Math.max(0, Number(reading.rulerAtReading) || 0);
  return real + Math.max(0, now - at);
}

/* The numbers an overflow error names, or null. Anthropic "prompt is too long: 215000 tokens > 200000 maximum";
   OpenAI-compatible "maximum context length is 64000 tokens. However, your messages resulted in 82069 tokens";
   Gemini "The input token count (1234567) exceeds the maximum number of tokens allowed (1048576)". */
function reportedWindow(text) {
  const s = String(text == null ? '' : text).replace(/(\d),(?=\d{3}\b)/g, '$1');
  const sane = (used, limit) => (limit >= 1024 && limit <= 50000000) ? { used: used > 0 ? used : 0, limit } : null;
  let m = /(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i.exec(s);
  if (m) return sane(Number(m[1]), Number(m[2]));
  m = /maximum context length is (\d+) tokens/i.exec(s);
  if (m) { const u = /(?:resulted in|requested) (\d+) tokens/i.exec(s); return sane(u ? Number(u[1]) : 0, Number(m[1])); }
  m = /input token count\D{0,4}(\d+)\D{0,4}exceeds the maximum number of tokens allowed\D{0,4}(\d+)/i.exec(s);
  if (m) return sane(Number(m[1]), Number(m[2]));
  return null;
}

/* What a fold left of a REAL prompt size, from local ruler readings before/after it. Two projections: scaling the
   real count by the local shrink ratio (right when the ruler undercounts proportionally) and subtracting the local
   saving (right when the gap is fixed overhead). The smaller one is returned: this only ever decides whether a
   retry is certainly doomed, and a wrongly-doomed verdict would kill a run that could have continued. */
function projectAfterFold(realBefore, rulerBefore, rulerAfter) {
  const after = Math.max(0, Number(rulerAfter) || 0);
  const before = Math.max(0, Number(rulerBefore) || 0);
  const real = Math.max(0, Number(realBefore) || 0);
  if (!(real > 0) || !(before > 0)) return after;
  return Math.max(0, Math.min(real * (after / before), real - (before - after)));
}

/* Message content as plain text for a summarizer / digest: text parts kept, images named (never their bytes),
   inline data URLs and long raw base64 runs replaced by a sized marker. `imageLabel` optionally names the source. */
const DATA_URL_RE = /data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)?(?:;[A-Za-z0-9.+=-]+)*;base64,[A-Za-z0-9+/=]*/g;
const BASE64_RUN_RE = /[A-Za-z0-9+/]{1024,}={0,2}/g;
function scrubBinary(s) {
  return String(s)
    .replace(DATA_URL_RE, (m, mime) => (/^image\//i.test(String(mime || '')) ? '[image]' : '[inline data omitted: ' + m.length + ' chars]'))
    .replace(BASE64_RUN_RE, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m)) ? '[base64 data omitted: ' + m.length + ' chars]' : m);
}
function contentText(content, imageLabel) {
  if (typeof content === 'string') return scrubBinary(content);
  if (content == null) return '';
  if (!Array.isArray(content)) return scrubBinary(JSON.stringify(content));
  const out = [];
  for (const p of content) {
    if (typeof p === 'string') { out.push(scrubBinary(p)); continue; }
    if (!p || typeof p !== 'object') continue;
    const type = String(p.type || '');
    if (typeof p.text === 'string' && (!type || /text/.test(type))) { out.push(scrubBinary(p.text)); continue; }
    if (/image/.test(type)) {
      const alt = String(p.alt || p.caption || p.name || (p.image_url && p.image_url.alt) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      out.push('[image' + (alt ? ': ' + alt : (imageLabel ? ': ' + imageLabel : '')) + ']');
      continue;
    }
    out.push('[' + (type || 'attachment') + ']');
  }
  return out.join('\n');
}

module.exports = {
  userBudgetChars, collectUserMessages, mergeUserMessages, messagePriority, renderUserSection, splitSummary, joinSummary,
  usageAnchor, reportedWindow, projectAfterFold, contentText, scrubBinary, isScreenCapture,
  VERBATIM_OPEN, VERBATIM_CLOSE, PER_MESSAGE_MAX_CHARS
};
