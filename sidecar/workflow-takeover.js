'use strict';

// Read existing task/run history; never learn a workflow from a prompt counter alone.
const crypto = require('node:crypto');
const { makeDurableJsonStore } = require('./durable-store.js');
const DAY = 86400000;
const WINDOW = 60 * DAY;
const MIN_GAP = 20 * 3600000;
const MAX_OFFERS = 2;
const RETRY = /\b(try again|retry|still broken|still wrong|did(?:n't| not) work|fix (?:it|that|this)|instead|correction|redo|undo|revert)\b/i;
const INTERNAL = /^(cron|nightshift|workshop|scout|autopilot|system)[-:]/;
const ATTACHED = /\b(attached|attachment|this file|this document|above|below)\b/i;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// Deliberately small paraphrase vocabulary. Preserve targets, negation, numbers and paths.
// Different topics are not one workflow just because both start with “summarize”.
// Kept as the EXACT key for routine dedupe and the original contract; grouping now uses core()/similar().
function signature(text) {
  let s = clip(text, 4000).toLowerCase().replace(/^(?:(?:please|can you|could you|would you)\s+)+/, '');
  if (!s || RETRY.test(s) || ATTACHED.test(s)) return '';
  s = s.replace(/\b(?:compile|assemble)\b/g, 'prepare').replace(/\bsummarise\b/g, 'summarize');
  const words = s.match(/[\p{L}\p{N}_:/@.\\-]+/gu) || [];
  const kept = words.map(w => w.replace(/\.+$/, '')).filter(w => w && !/^(the|a|an|please)$/.test(w));
  if (kept.length < 4) return '';
  return kept.join(' '); // preserve source/destination roles and step order
}

/* ---- REPEAT SENSE (2026-10-01) -------------------------------------------------------------------------------
   The exact signature above only grouped requests typed with the same words, so a habit like "summarize today's
   AI news" / "what's new in AI today? summarize it" / "give me an AI news summary" never earned an offer. core()
   reduces a request to what makes it THE SAME WORK: its content words (paraphrases folded, light stemming, dates
   and cadence words dropped — they change every occasion), plus three guards that make two requests DIFFERENT
   work however many words they share: negation, the role words that follow a preposition (report FOR Acme vs FOR
   Beta, FROM Alice TO Bob vs FROM Bob TO Alice) and explicit paths/urls/emails. Pure and deterministic. */
const STOP = new Set(('a an the and or but of at by as is are was were be been being do does did done have has had it its '
  + 'this that these those there here what whats which who whom how why when where can could would will should shall may '
  + 'might must please pls me my mine i im ive we us our ours you your yours he she they them their it\'s let lets just '
  + 'some any all each every more most other such only own same so than too very also again up out over then now '
  + 'today tonight tomorrow yesterday daily weekly monthly morning afternoon evening night week month year day days '
  + 'latest newest new recent recently current currently quick quickly short brief briefly thing things stuff get give '
  + 'go make sure want need like know tell show find-out ok okay thanks thank hey hi hello one ones two three few couple '
  + 'via per mine whats it’s i’m let’s don’t').split(/\s+/).filter(Boolean));
const PREPS = new Set(['for', 'to', 'from', 'about', 'into', 'with', 'on', 'in', 'onto', 'regarding']);
const NEG = /\b(?:not|never|no|without|don['’]?t|do not|doesn['’]?t|shouldn['’]?t|stop)\b/i;
const DATEISH = /^(?:\d{1,4}(?:[/.-]\d{1,2}){1,2}|\d{1,2}(?:st|nd|rd|th)|(?:19|20)\d\d|mon(?:day)?s?|tue(?:s(?:day)?)?s?|wed(?:nesday)?s?|thu(?:rs(?:day)?)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?::\d\d)?(?:am|pm)?)$/;
const PHRASES = [
  [/\b(?:put together|pull together|whip up|write up|compile|assemble|prep|draft|compose|write|create|produce|generate)\b/g, 'prepare'],
  [/\b(?:summarise|summarization|summary|summaries|recap|rundown|roundup|round-up|digest|overview|tl;?dr)\b/g, 'summarize'],
  [/\b(?:look up|lookup|search for|search|dig up)\b/g, 'find'],
  [/\b(?:check on|keep an eye on|monitor|scan|watch)\b/g, 'check'],
  [/\b(?:e-?mail|mail)\b/g, 'send'],
  [/\b(?:headlines|happenings|developments|updates on)\b/g, 'news'],
  [/\b(?:a\.i\.?|artificial intelligence)\b/g, 'ai'],
  [/\b(?:what['’]?s new in|what is new in|what['’]?s happening in|what is happening in)\b/g, 'news about']
];
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
function core(text) {
  let s = clip(text, 4000).toLowerCase().replace(/^(?:(?:please|can you|could you|would you|hey|ok|okay)[,\s]+)+/, '');
  if (!s || RETRY.test(s) || ATTACHED.test(s)) return null;
  const neg = NEG.test(s);
  const protectedTokens = new Set();
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.]+|(?:[a-z]:)?(?:[\\/][\w.-]+)+|\b[\w-]+\.(?:md|txt|csv|json|pdf|docx?|xlsx?|pptx?|js|ts|py|html?)\b/gi, m => {
    protectedTokens.add(m.replace(/[.,;:!?)]+$/, '').toLowerCase()); return ' ';
  });
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  const raw = s.match(/[\p{L}\p{N}_'’-]+/gu) || [];
  const words = [], roles = {};
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i].replace(/['’]s$/, '').replace(/^['’-]+|['’-]+$/g, '');
    if (!w) continue;
    if (PREPS.has(w)) {
      for (let j = i + 1; j < Math.min(raw.length, i + 4); j++) {
        const n = raw[j].replace(/['’]s$/, '').replace(/^['’-]+|['’-]+$/g, '');
        if (PREPS.has(n)) break;
        if (!n || STOP.has(n) || DATEISH.test(n)) continue;
        (roles[w] = roles[w] || new Set()).add(stem(n)); break;
      }
      continue;
    }
    if (STOP.has(w) || DATEISH.test(w) || NEG.test(w) || /^\d+$/.test(w)) continue;
    words.push(stem(w));
  }
  const content = Array.from(new Set(words));
  if (content.length < 3) return null;
  const r = {}; for (const k of Object.keys(roles).sort()) r[k] = Array.from(roles[k]).sort();
  return { neg, roles: r, paths: Array.from(protectedTokens).sort(), words: content.sort() };
}
function disjointConflict(a, b) {
  if (!a.length || !b.length) return false;
  return !a.some(x => b.includes(x));
}
function similar(a, b) {
  if (!a || !b || a.neg !== b.neg) return false;
  for (const k of Object.keys(a.roles || {})) if (b.roles && b.roles[k] && disjointConflict(a.roles[k], b.roles[k])) return false;
  // Alice->Bob vs Bob->Alice: the same two names in swapped roles are a conflict even though every set overlaps.
  if (a.roles && b.roles && a.roles.from && a.roles.to && b.roles.from && b.roles.to &&
      a.roles.from.some(x => b.roles.to.includes(x)) && a.roles.to.some(x => b.roles.from.includes(x)) &&
      !a.roles.from.some(x => b.roles.from.includes(x))) return false;
  if (disjointConflict(a.paths || [], b.paths || [])) return false;
  const A = new Set(a.words), B = new Set(b.words);
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  const small = Math.min(A.size, B.size), union = A.size + B.size - inter;
  return inter >= Math.min(3, small) && inter / small >= 0.75 && inter / union >= 0.5;
}

/* CADENCE — a SUGGESTION only, read off when the Commander actually asked (sidecar local time is the
   Commander's machine time: Agent OS is local-first). The review form pre-selects it; the Commander still
   picks and confirms. Returns null when the occasions show no honest rhythm. */
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function hourLabel(h) { return (h % 12 || 12) + ' ' + (h < 12 ? 'AM' : 'PM'); }
function suggestCadence(times) {
  const ts = (times || []).map(Number).filter(t => isFinite(t) && t > 0).sort((a, b) => a - b);
  if (ts.length < 3) return null;
  const hours = ts.map(t => new Date(t).getHours()).sort((a, b) => a - b);
  const mid = hours[Math.floor(hours.length / 2)];
  const steady = hours.every(h => Math.abs(h - mid) <= 3);
  const hour = steady ? mid : 9;
  const gaps = []; for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / DAY);
  gaps.sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)];
  const days = ts.map(t => new Date(t).getDay());
  const same = days.every(d => d === days[0]);
  const at = (steady ? '' : 'around ') + hourLabel(hour);
  if (same && gap >= 5) return { schedule: '0 ' + hour + ' * * ' + days[0], display: DAYNAMES[days[0]] + 's at ' + hourLabel(hour), why: 'you asked on ' + DAYNAMES[days[0]] + 's' + (steady ? ' around ' + hourLabel(hour) : '') };
  if (gap <= 1.6 && days.every(d => d >= 1 && d <= 5) && ts.length >= 4) return { schedule: '0 ' + hour + ' * * 1-5', display: 'weekdays at ' + hourLabel(hour), why: 'you asked on weekdays ' + at };
  if (gap <= 1.6) return { schedule: '0 ' + hour + ' * * *', display: 'every day at ' + hourLabel(hour), why: 'you asked about daily ' + at };
  if (gap >= 5 && gap <= 9) { const d = days[days.length - 1]; return { schedule: '0 ' + hour + ' * * ' + d, display: DAYNAMES[d] + 's at ' + hourLabel(hour), why: 'you asked about weekly ' + at }; }
  return null;
}

function idFor(key) { return 'workflow-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24); }
function normCore(c) {
  if (!c || !Array.isArray(c.words)) return null;
  const roles = {};
  for (const k of Object.keys(c.roles || {}).slice(0, 12)) if (Array.isArray(c.roles[k])) roles[clip(k, 20)] = c.roles[k].slice(0, 8).map(x => clip(x, 60));
  return { neg: c.neg === true, roles, paths: (Array.isArray(c.paths) ? c.paths : []).slice(0, 8).map(x => clip(x, 200)),
    words: c.words.slice(0, 60).map(x => clip(x, 60)), agentId: clip(c.agentId, 80), project: clip(c.project, 400) };
}
function normalize(raw) {
  const x = raw || {};
  return { v: 1, forgottenAt: Math.max(0, Number(x.forgottenAt) || 0),
    decisions: (Array.isArray(x.decisions) ? x.decisions : []).filter(d => d && /^workflow-[a-f0-9]{24}$/.test(d.id))
      .slice(-200).map(d => ({ id: d.id, offers: Math.max(0, Number(d.offers) || 0),
        never: d.never === true, until: Math.max(0, Number(d.until) || 0), at: Math.max(0, Number(d.at) || 0),
        core: normCore(d.core) })) };
}
// A decision follows the WORK, not only its id: a cluster's id moves when its oldest occasion ages out of the
// window, and "don't offer this again" must still hold for the same workflow asked a fourth time.
// A decision saved by 0.12.5 has no core, and its id was the WORDS' signature (idFor([agent, project, signature(text)])): it
// still answers for the same request, or a "don't offer this again" (or a snooze) was forgotten on upgrade.
function legacyIds(agentId, project, texts) {
  return texts.map(t => signature(t)).filter(Boolean).map(sig => idFor([agentId, project, sig].join('\n')));
}
function decisionFor(state, id, c, agentId, project, legacy) {
  return state.decisions.find(d => d.id === id) ||
    state.decisions.find(d => d.core && d.core.agentId === agentId && d.core.project === project && similar(d.core, c)) ||
    (legacy && legacy.length ? state.decisions.find(d => !d.core && legacy.indexOf(d.id) >= 0) : null) || null;
}
function blocked(decision, now) {
  return !!(decision && (decision.never || decision.until > now || decision.offers >= MAX_OFFERS));
}
function jobCovers(jobs, agentId, c, text) {
  return (jobs || []).some(j => j && j.agentId === agentId &&
    ((text && signature(j.prompt) && signature(j.prompt) === signature(text)) || similar(core(j.prompt), c)));
}

// Every completed request that could count as an occasion: same filters as before, now carrying its core.
function rowsFrom(input, state) {
  const { briefs = [], runs = [], ratings = [], now = 0, redact = s => s } = input || {};
  const runMap = new Map(runs.map(r => [r.runId, r]));
  const ratingMap = new Map(ratings.map(r => [r.runId, r.verdict]));
  const rows = [];
  const seen = new Set();
  for (const b of briefs.slice(0, 500)) {
    const r = runMap.get(b.runId);
    if (!r || seen.has(r.runId) || r.internal || INTERNAL.test(r.streamId || '') ||
        !['interactive', 'channel'].includes(b.source) || b.agentId !== r.agentId) continue;
    seen.add(r.runId);
    const at = Number(b.completedAt || b.updatedAt);
    if (!(at > state.forgottenAt && at <= now && now - at <= WINDOW)) continue;
    const text = clip(b.originalDirective, 4000);
    if (redact(text) !== text) continue; // never carry a credential-bearing request into a proposed routine
    const c = core(text); if (!c) continue;
    const uncertain = r.completionEvidence && (['verification_required', 'incomplete'].includes(r.completionEvidence.completionVerdict) ||
      ['unverified_effects', 'judgment_required'].includes(r.completionEvidence.effectVerdict));
    // failed: a real failure or a "close"/"missed" rating — breaks the streak. ok: completed with proven work.
    // Anything else (a chat-only answer, a clarifying turn, uncertain effects) is NEUTRAL: it neither counts nor
    // resets — a quick follow-up answered from context is not a failed occasion of the habit.
    const failed = ['ok', 'miss'].includes(ratingMap.get(r.runId)) || b.status !== 'done' || r.reason !== 'done';
    const ok = !failed && !r.clarifying && !uncertain &&
      !(r.uncertainMutations || []).length && (r.toolsOk > 0 || (r.artifacts || []).length > 0);
    rows.push({ b, r, text, at, ok, failed, c, agentId: b.agentId, project: String(r.projectRoot || '') });
  }
  return rows.sort((a, b) => a.at - b.at);
}
// Greedy clustering in time order: a request joins the first cluster (same agent + project) it is similar to —
// compared against the cluster's FIRST and LATEST wording, so a habit that drifts slowly still holds together
// while a different target never joins.
function cluster(rows) {
  const clusters = [];
  for (const row of rows) {
    const home = clusters.find(k => k.agentId === row.agentId && k.project === row.project &&
      (similar(k.rows[0].c, row.c) || similar(k.rows[k.rows.length - 1].c, row.c)));
    if (home) home.rows.push(row); else clusters.push({ agentId: row.agentId, project: row.project, rows: [row] });
  }
  return clusters;
}
function occasionsOf(rows) {
  let occasions = [];
  for (const row of rows) {
    if (row.failed) { occasions = []; continue; } // repeated failures never earn a takeover
    if (!row.ok) continue;                        // neutral: neither an occasion nor a failure
    if (!occasions.length || row.at - occasions[occasions.length - 1].at >= MIN_GAP) occasions.push(row);
    else occasions[occasions.length - 1] = row; // one work session counts once, using its latest instructions
  }
  return occasions;
}

function candidates(input) {
  const { jobs = [], now = 0, redact = s => s } = input || {};
  const state = normalize(input && input.state);
  if (input && input.enabled === false) return [];
  const out = [];
  for (const k of cluster(rowsFrom(input, state))) {
    const occasions = occasionsOf(k.rows);
    if (occasions.length < 3) continue;
    const last = occasions[occasions.length - 1];
    const id = idFor([k.agentId, k.project, k.rows[0].b.id || k.rows[0].r.runId].join('\n'));
    if (blocked(decisionFor(state, id, last.c, k.agentId, k.project, legacyIds(k.agentId, k.project, k.rows.map(x => x.text))), now)) continue;
    if (jobs.some(j => j && j.meta && j.meta.workflowTakeoverId === id) || jobCovers(jobs, last.b.agentId, last.c, last.text)) continue;
    const evidence = occasions.slice(-6).map(x => ({ briefId: x.b.id, runId: x.r.runId, at: x.at, quote: clip(x.text, 400) }));
    const answers = (last.b.questions || []).filter(q => q.answer).map(q => '- ' + clip(redact(q.text), 240) + ': ' + clip(redact(q.answer), 500));
    const settled = last.b.settled || {};
    const context = [];
    for (const field of ['deliverable', 'audience', 'success']) if (settled[field]) context.push(field + ': ' + clip(redact(settled[field]), 500));
    for (const source of (settled.sources || [])) context.push('source: ' + clip(redact(source), 300));
    const prompt = [last.text, context.length ? '\nDetails from the last completed task:\n' + context.join('\n') : '',
      answers.length ? '\nChoices from the last completed task (review for future runs):\n' + answers.join('\n') : ''].filter(Boolean).join('\n');
    const reworded = new Set(occasions.map(o => o.text.replace(/\s+/g, ' ').toLowerCase())).size > 1;
    out.push({ id, name: clip(last.text.replace(/\s+/g, ' '), 80), prompt, agentId: last.b.agentId,
      workdir: last.r.projectRoot || '', count: occasions.length, lastAt: last.at, evidence,
      suggest: suggestCadence(occasions.map(o => o.at)),
      core: Object.assign({}, last.c, { agentId: k.agentId, project: k.project }),
      why: 'You asked for this workflow on ' + occasions.length + ' separate occasions' + (reworded ? ' (in different words)' : '') +
        ', and each recorded run completed with tool work or an artifact.' });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt || b.count - a.count).slice(0, 3);
}

/* notice() — the AGENT-side half. Called while a NEW request is being prepared: if this request is the same work
   the Commander already had completed on at least two separate earlier days (so this is the third+ occasion), the
   lead is told so it can offer — in its own reply, once — to make it a standing routine. Same evidence bar and the
   same decisions/jobs suppression as the takeover card; nothing is ever created by a notice. */
function notice(input) {
  const { directive, agentId, projectRoot = '', jobs = [], now = 0, redact = s => s } = input || {};
  if (!input || input.enabled === false) return null;
  const text = clip(directive, 4000);
  if (!text || redact(text) !== text) return null;
  const c = core(text); if (!c) return null;
  const state = normalize(input.state);
  const project = String(projectRoot || '');
  const rows = rowsFrom(input, state).filter(r => r.agentId === agentId && r.project === project && similar(r.c, c));
  const prior = occasionsOf(rows);
  if (prior.length < 2) return null;
  if (now - prior[prior.length - 1].at < MIN_GAP) return null; // same work session — a follow-up, not a habit
  if (jobCovers(jobs, agentId, c, text)) return null;
  // Same id rule as candidates() (the oldest member); decisionFor also matches by core when clustering differs.
  const id = idFor([agentId, project, rows[0].b.id || rows[0].r.runId].join('\n'));
  if (blocked(decisionFor(state, id, c, agentId, project, legacyIds(agentId, project, rows.map(x => x.text).concat([text]))), now)) return null;
  const times = prior.map(o => o.at).concat([now]);
  return { id, count: prior.length + 1, dates: prior.map(o => o.at), suggest: suggestCadence(times),
    quotes: prior.slice(-3).map(o => clip(o.text, 160)), core: Object.assign({}, c, { agentId, project }) };
}

function makeWorkflowTakeoverStore(deps) {
  const durable = makeDurableJsonStore({ fs: deps.fs, path: deps.path,
    fileFor: () => deps.path.join(deps.workspaces, 'workflow-takeovers.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt });
  const read = () => normalize(durable.get('workflow-takeovers'));
  function decide(id, action, now, workCore) {
    if (!/^workflow-[a-f0-9]{24}$/.test(id) || !['shown', 'defer', 'never', 'review'].includes(action)) return Promise.resolve(false);
    return durable.update('workflow-takeovers', raw => {
      const s = normalize(raw); let d = s.decisions.find(x => x.id === id);
      if (!d) { d = { id, offers: 0, never: false, until: 0, at: 0, core: null }; s.decisions.push(d); }
      if (workCore) d.core = normCore(workCore);
      if (action === 'shown') { d.offers++; d.until = now + DAY; }
      if (action === 'defer') { d.until = now + 7 * DAY; d.offers = Math.min(d.offers, MAX_OFFERS - 1); }
      if (action === 'review') d.until = now + 7 * DAY;
      if (action === 'never') d.never = true;
      d.at = now; return normalize(s);
    }).then(() => true);
  }
  const forget = now => durable.update('workflow-takeovers', () => ({ v: 1, forgottenAt: now, decisions: [] }));
  return { read, decide, forget };
}
module.exports = { signature, core, similar, suggestCadence, candidates, notice, makeWorkflowTakeoverStore, normalize, MIN_GAP };
