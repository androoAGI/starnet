'use strict';
/* test/helpers/host-notes.js — read the host notes out of a captured Chat Completions request, wherever the wire put them.

   The per-run <run_context> note, <recalled-memory> and the earlier-conversation <conversation_summary> are host notes.
   On a Claude route they ride as their own messages; on every other Chat Completions route (provider 'custom',
   OpenRouter non-Claude models such as the fixtures' 'test/model', hosted openai-compatible profiles, Ollama) they are
   the fenced leading text of the NEWEST user message (provider.js userSideHostNotes — strict chat templates refuse a
   system message after index 0). The <crew_call> note (review 2026-10-12) trails instead: it is the fenced CLOSING text
   of that user message. Tests that read the run identity or recall from a request, or route a mock on the Commander's
   own words, use these instead of assuming one placement. */

const TAGS = ['run_context', 'recalled-memory', 'conversation_summary', 'crew_call'];
const TAG_ALT = TAGS.join('|');
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : (c == null ? '' : String(c)));
const LEAD_BLOCK = new RegExp('^\\s*<(' + TAG_ALT + ')>[\\s\\S]*?</\\1>\\s*');
const TRAIL_BLOCK = new RegExp('\\s*<(' + TAG_ALT + ')>(?:(?!<\\1>)[\\s\\S])*?</\\1>\\s*$');

// a user text split into its leading host notes, the Commander's own words, and its trailing host notes. On the wire
// the user's own text carries no live host fence (provider.js INERT HOST FENCES), so a live block is host-authored.
function splitUser(t) {
  const lead = [], trail = [];
  for (;;) { const m = LEAD_BLOCK.exec(t); if (!m) break; lead.push(m[0].trim()); t = t.slice(m[0].length); }
  for (;;) { const m = TRAIL_BLOCK.exec(t); if (!m) break; trail.unshift(m[0].trim()); t = t.slice(0, m.index); }
  return { lead, words: t, trail };
}

// every fenced <tag>…</tag> block in the request's messages (system notes and user-side notes alike), in order
function hostNotes(messages, tag) {
  const tags = tag ? [tag] : TAGS;
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'system' && m.role !== 'user')) continue;
    // a user message only carries host notes as its LEADING or CLOSING text (anything between is the Commander's words)
    const blocks = m.role === 'user' ? (s => s.lead.concat(s.trail))(splitUser(text(m.content))) : [text(m.content)];
    for (const b of blocks) for (const name of tags) {
      const re = new RegExp('<' + name + '>[\\s\\S]*?</' + name + '>', 'g');
      let hit;
      while ((hit = re.exec(b))) out.push(hit[0]);
    }
  }
  return out;
}
const runContextOf = messages => hostNotes(messages, 'run_context').join('\n');
const recallOf = messages => hostNotes(messages, 'recalled-memory').join('\n');
// the Commander's own words of a user message: its text without the leading and closing host notes
function userWords(message) {
  return splitUser(text(message && message.content)).words;
}
// a copy of a user message without its host notes (string content -> the own words; a parts array loses its leading
// and closing host-note text parts), so a test that inspects "what the Commander sent" keeps reading exactly that
function withoutHostNotes(message) {
  if (!message || message.role !== 'user') return message;
  const c = message.content;
  if (typeof c === 'string') return Object.assign({}, message, { content: userWords(message) });
  if (!Array.isArray(c)) return message;
  const allNotes = p => p && typeof p.text === 'string' && new RegExp('^\\s*<(' + TAG_ALT + ')>').test(p.text) && !userWords({ role: 'user', content: p.text }).trim();
  let i = 0, j = c.length;
  while (i < j && allNotes(c[i])) i++;
  while (j > i && allNotes(c[j - 1])) j--;
  return (i || j < c.length) ? Object.assign({}, message, { content: c.slice(i, j) }) : message;
}
// the newest user message's own words
function lastUserWords(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].role === 'user') return userWords(list[i]);
  return '';
}

// the run's OPENING prompt: the first user message's own words, skipping a user turn that is host notes alone. On a Claude
// route (provider.js chatRoleProjection -> preserveClaudeContinuations) the <run_context> note and recall are their own
// user turns BEFORE the Commander's message instead of leading it, so "the first user message" can be a host note.
// A mock that routes on how a run opens (qa:journeys J4's [WORKSHOP_SHIFT]) reads this on every route.
function firstUserWords(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'user') continue;
    const words = userWords(m);
    if (words.trim()) return words;
  }
  return '';
}

// every host-authored prompt text of a request: the system messages, then the host notes that ride user-side. Tests that
// read "the prompt the host sent" (the [RUNTIME] block, the run's skill index, recall) read this, not one placement.
function hostText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = list.filter(m => m && m.role === 'system').map(m => text(m.content));
  const userSide = [];
  for (const m of list) if (m && m.role === 'user') for (const n of hostNotes([m])) userSide.push(n);
  return sys.concat(userSide).join('\n\n');
}

// the loop's own fenced host messages (<steering_note>, <acceptance_before_done>, <continue_after_tools>, …) wherever the
// wire put them: as their own system message, or — on every Chat Completions route and Claude route since 2026-10-27
// (provider.js projectRoles) — as fenced user-side text after the turn they follow. Returns each fenced block.
function loopNotes(messages, tag) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== 'system' && m.role !== 'user')) continue;
    const re = new RegExp('<' + tag + '>[\\s\\S]*?</' + tag + '>', 'g');
    const t = text(m.content);
    let hit;
    while ((hit = re.exec(t))) out.push(hit[0]);
  }
  return out;
}

module.exports = { TAGS, text, hostNotes, runContextOf, recallOf, userWords, withoutHostNotes, lastUserWords, firstUserWords, hostText, loopNotes };
