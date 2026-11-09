// scripts/lib/crew-ab.mjs — the pure half of the LEANER CREW DEFAULTS A/B (scripts/crew-defaults-ab.mjs): the crew tasks,
// their oracles, the crew each arm summons, and the metering arithmetic. No I/O, no clock, no randomness, so every
// expected answer is computed here from the task's own data and can be checked without spending anything.
//
// THE TASKS are the parity pack's orchestration scenarios (scripts/eval/packs/parity-v0.9.0.jsonl) made concrete on
// StarNet's real crew: the pack names the outcome, this module gives each one data with one right answer.
//   parity-orch-named-delegation  the lead hands a named class-high worker (ENGINEER) a priced order list; the answer
//                                 needs both discounts and half-up cent rounding per order
//   parity-orch-parallel-fanout   the lead sends two workers at once: ANALYST (reasoning class, high) a median and a
//                                 population standard deviation, RESEARCHER (balanced class) the cities in a paragraph
//   parity-orch-synthesis         a two-stage line: WRITER (balanced) drafts a release note from an incident note, AUDITOR
//                                 (reasoning, high) checks it and answers APPROVED or REVISE, up to three passes
// Each class is a real builtin (frontend/app/specialties.js): its tier and its applied effort come from there.

export const TASK_IDS = ['parity-orch-named-delegation', 'parity-orch-parallel-fanout', 'parity-orch-synthesis'];

// ---- task 1: the order list (id, region, quantity, unit price in cents) -------------------------------------------------
export const ORDERS = [
  ['A-101', 'EU', 12, 1999], ['A-102', 'US', 3, 14950], ['A-103', 'EU', 1, 110000], ['A-104', 'APAC', 25, 475],
  ['A-105', 'US', 12, 9650], ['A-106', 'EU', 7, 6125], ['A-107', 'APAC', 2, 41000], ['A-108', 'US', 40, 235],
  ['A-109', 'EU', 11, 10500], ['A-110', 'US', 1, 104000], ['A-111', 'APAC', 9, 7770], ['A-112', 'EU', 30, 995]
];
const money = cents => (cents / 100).toFixed(2);
// exact: integer cents x percent factors, rounded half up to the cent once per order
export function orderAmounts() {
  return ORDERS.map(([id, region, qty, cents]) => {
    const n = cents * qty * (qty >= 10 ? 90 : 100) * (region === 'EU' ? 95 : 100);   // in 1/10000 of a cent
    return { id, cents: Math.floor((n + 5000) / 10000) };
  });
}
export function expectedOrders() {
  const rows = orderAmounts();
  const total = rows.reduce((s, r) => s + r.cents, 0);
  const top = rows.reduce((a, b) => (b.cents > a.cents ? b : a));
  return { total: money(total), top: top.id };
}

// ---- task 2: a number list and a paragraph ------------------------------------------------------------------------------
export const NUMBERS = [12, 7, 19, 3, 25, 14, 9, 31, 6, 18, 22, 11, 27, 4, 16];
export const PARAGRAPH = 'The courier left Lisbon before dawn, crossed into Spain and refuelled in Zaragoza while the depot in ' +
  'Catalonia was still closed. Customs paperwork was printed in Geneva and signed for Switzerland, and the parcel finally ' +
  'reached Lyon, the last stop in France.';
export function expectedFanout() {
  const s = NUMBERS.slice().sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) * (x - mean), 0) / s.length);
  return { median: median.toFixed(2), stdev: sd.toFixed(2), cities: ['Geneva', 'Lisbon', 'Lyon', 'Zaragoza'] };
}

// ---- task 3: the incident note the line turns into a release note -------------------------------------------------------
export const INCIDENT = 'Incident note. Build 4.12.2 shipped on 2026-10-01 with an image cache that kept stale entries. ' +
  'It was detected on 2026-10-03: 3.7% of uploads showed an old thumbnail, across 0.4% of accounts. Build 4.12.3, released ' +
  'on 2026-10-04, fixes it by changing how the cache evicts entries when an upload is replaced. No data was lost.';
export const FACTS = [['version', /\b4\.12\.3\b/], ['date', /\b2026-10-04\b/], ['share', /\b3\.7\s?(%|percent)/i], ['fix', /evict/i]];

export const LEAD_SYSTEM = 'You are the Overseer of this station. You lead a crew. When the Commander names a crew member for a ' +
  'piece of work, hand it to that member with your team delegation tool, wait for the result, and report it. Never do ' +
  'delegated work yourself.';

export function taskPrompt(id) {
  if (id === 'parity-orch-named-delegation') {
    return 'Delegate this to ENGINEER (agent id engineer) and report the result; do not work it out yourself.\n\n' +
      'Orders (id, region, quantity, unit price in USD):\n' + ORDERS.map(([i, r, q, c]) => i + ', ' + r + ', ' + q + ', ' + money(c)).join('\n') +
      '\n\nEach order is quantity x unit price. An order of 10 or more units gets 10% off. An EU order then gets a further 5% off ' +
      'its discounted amount. Round each order to the nearest cent, halves rounding up, and only then add them up.\n\n' +
      'Finish your reply with exactly these two lines:\nTOTAL: <the sum, two decimals, no currency sign or separators>\n' +
      'TOP: <the id of the order with the largest final amount>';
  }
  if (id === 'parity-orch-parallel-fanout') {
    return 'Send these two jobs at the same time, in one delegation, and report both results once.\n\n' +
      '1. To ANALYST (agent id analyst): for the numbers ' + NUMBERS.join(', ') + ', the median and the population standard ' +
      'deviation, each to two decimals.\n2. To RESEARCHER (agent id researcher): the cities named in this paragraph, ' +
      'alphabetical (regions and countries are not cities):\n"' + PARAGRAPH + '"\n\n' +
      'Finish your reply with exactly these three lines:\nMEDIAN: <two decimals>\nSTDEV: <two decimals>\nCITIES: <comma-separated>';
  }
  return INCIDENT;
}
// the line's two stage briefs (the bays' own brief, as a saved floor carries it)
export const WRITER_BRIEF = 'Write a customer-facing release note of 60 to 120 words from the incident note you are given. It ' +
  'must state the fixed version, the release date of the fix in YYYY-MM-DD form, the share of uploads affected as a percent, ' +
  'and what the fix changed. Reply with SOURCE: followed by the incident note word for word, then DRAFT: followed by the note.';
// (the review gate's own instruction rides with it: the line's verdict brief, frontend/app/line-verdict.js verdictBrief, asks
// for the VERDICT line, so this brief never names a verdict format of its own)
export const AUDITOR_BRIEF = 'You receive a SOURCE incident note and a DRAFT release note. Check that the draft states, ' +
  'correctly for the SOURCE: the fixed version, the release date of the fix (YYYY-MM-DD), the percent of uploads affected and ' +
  'what the fix changed. Approve it only when all four are right; otherwise say briefly what is missing or wrong.';

// ---- oracles ------------------------------------------------------------------------------------------------------------
const lineValue = (text, key) => {
  const m = String(text || '').match(new RegExp('^\\s*\\**' + key + '\\**\\s*:\\s*\\**\\s*(.+?)\\s*\\**\\s*$', 'gim'));
  if (!m) return null;
  return m[m.length - 1].replace(new RegExp('^\\s*\\**' + key + '\\**\\s*:\\s*\\**\\s*', 'i'), '').replace(/\**\s*$/, '').trim();
};
const num2 = v => { const n = Number(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n.toFixed(2) : null; };

// the release note in what the line delivered: the text after its last DRAFT: marker, or the whole text when it has no SOURCE
// echo (a reviewer that approved with fixes leads with the finished note itself); a SOURCE echo with no DRAFT is no note
export function releaseNoteOf(text) {
  const t = String(text || '');
  const at = t.search(/DRAFT\s*:(?![\s\S]*DRAFT\s*:)/i);
  if (at >= 0) return t.slice(at).replace(/^DRAFT\s*:/i, '');
  return /SOURCE\s*:/i.test(t) ? '' : t;
}
// grade(taskId, { leadText, output, delivered, unapproved }) -> { ok, checks: [[name, ok, got, want]] }
export function grade(id, o) {
  const checks = [];
  const check = (name, got, want) => checks.push([name, got === want, got, want]);
  if (id === 'parity-orch-named-delegation') {
    const want = expectedOrders();
    check('TOTAL', num2(lineValue(o.leadText, 'TOTAL')), want.total);
    check('TOP', (lineValue(o.leadText, 'TOP') || '').toUpperCase(), want.top);
  } else if (id === 'parity-orch-parallel-fanout') {
    const want = expectedFanout();
    check('MEDIAN', num2(lineValue(o.leadText, 'MEDIAN')), want.median);
    check('STDEV', num2(lineValue(o.leadText, 'STDEV')), want.stdev);
    const cities = (lineValue(o.leadText, 'CITIES') || '').split(',').map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
    check('CITIES', cities.join(', '), want.cities.join(', '));
  } else {
    const note = releaseNoteOf(o.output);
    check('delivered', !!o.delivered, true);
    check('approved at the gate', !o.unapproved, true);
    check('release note', note.trim().length > 0, true);
    for (const [name, re] of FACTS) check(name, re.test(note), true);
  }
  return { ok: checks.every(c => c[1]), checks };
}

// ---- the crew each arm summons ------------------------------------------------------------------------------------------
// role: the agent id the task names; cls: the builtin class it was summoned from
export const CREW = [
  { agentId: 'engineer', name: 'ENGINEER', cls: 'engineer', tasks: ['parity-orch-named-delegation'] },
  { agentId: 'analyst', name: 'ANALYST', cls: 'analyst', tasks: ['parity-orch-parallel-fanout'] },
  { agentId: 'researcher', name: 'RESEARCHER', cls: 'researcher', tasks: ['parity-orch-parallel-fanout'] },
  { agentId: 'drafter', name: 'WRITER', cls: 'writer', tasks: ['parity-orch-synthesis'] },
  { agentId: 'reviewer', name: 'AUDITOR', cls: 'auditor', tasks: ['parity-orch-synthesis'] }
];
/* The roster an arm's page would push after summoning each class onto the lead's model (app.js summonAgent + applyLoadout +
   pushRoster): every recruit copies the lead's model and takes its class's effort. With the switch on, a balanced class
   preselects the family's mid-tier model and a fast class its small one (CrewDefaults.tierPick over the catalog the provider
   listed: never an id it did not list; no pick = the copy), and each row carries its marker (class for the class effort, pin
   for the Overseer, whose effort is the Commander's own dial). Off, no row carries a marker: exactly what the page sends. */
export function rosterFor(arm, o) {
  const lean = arm === 'lean';
  const rows = [Object.assign({ agentId: 'agent', name: 'OVERSEER', system: LEAD_SYSTEM, provider: o.provider, model: o.leadModel,
    reasoningEffort: o.leadEffort, role: '' }, lean ? { effortSource: 'pin' } : {})];
  const picks = {};
  for (const c of CREW) {
    const spec = o.Specialties.get(c.cls);
    if (!spec) throw new Error('crew-ab: no builtin class ' + c.cls);
    const doc = o.Specialties.compose(spec) || {};
    const pick = lean && spec.model !== 'reasoning'
      ? o.CrewDefaults.tierPick({ mode: o.CrewDefaults.ON, tier: spec.model, base: o.leadModel, catalog: o.catalogIds }) : null;
    picks[c.agentId] = { cls: c.cls, tier: spec.model, effort: spec.reasoningEffort || null, model: pick || o.leadModel, picked: !!pick };
    const brief = c.agentId === 'drafter' ? WRITER_BRIEF : c.agentId === 'reviewer' ? AUDITOR_BRIEF : '';
    rows.push(Object.assign({ agentId: c.agentId, name: c.name,
      system: 'You are ' + c.name + ', a ' + spec.name + ' on this station\'s crew.' + (doc.purpose ? ' ' + doc.purpose : '') + (brief ? '\n\n' + brief : ''),
      provider: o.provider, model: pick || o.leadModel, reasoningEffort: spec.reasoningEffort || null, role: 'specialist' },
    lean && spec.reasoningEffort ? { effortSource: 'class' } : {}));
  }
  return { rows, picks };
}

// ---- metering -----------------------------------------------------------------------------------------------------------
// a catalog row's per-token prices (OpenRouter's strings, USD per token); an unpriced row is refused by the runner
export function priceOf(row) {
  const p = (row && row.pricing) || {};
  const n = v => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : null; };
  const input = n(p.prompt), output = n(p.completion);
  if (input == null || output == null) return null;
  return { input, output, cacheRead: n(p.input_cache_read) != null ? n(p.input_cache_read) : input,
    cacheWrite: n(p.input_cache_write) != null ? n(p.input_cache_write) : input * 1.25, reasoning: n(p.internal_reasoning) != null ? n(p.internal_reasoning) : output };
}
// a usage receipt (sidecar/usage-receipts.js) priced on the HIGH side for the spend cap: cached reads at their own price only
// when the catalog names one, cache writes at 1.25x when it names none, reasoning tokens charged on top of the output count
// even where the provider already counts them inside it. A receipt with no usage (usageMissing) is charged a full window.
export function capCostUsd(r, price, missingTokens) {
  if (!r || !price) return 0;
  if (r.usageMissing) return (missingTokens || 0) * Math.max(price.input, price.output);
  const v = k => (Number.isFinite(r[k]) && r[k] > 0 ? r[k] : 0);
  return v('uncachedIn') * price.input + v('cacheRead') * price.cacheRead + v('cacheWrite') * price.cacheWrite +
    v('out') * price.output + v('reasoning') * price.reasoning;
}
// a receipt at the catalog's published price: what the provider's own token counts cost (OpenRouter counts reasoning inside
// the completion tokens, so out is charged once). null when the call's usage never arrived: unknown, never $0
export function listCostUsd(r, price) {
  if (!r || !price || r.usageMissing) return null;
  const v = k => (Number.isFinite(r[k]) && r[k] > 0 ? r[k] : 0);
  return v('uncachedIn') * price.input + v('cacheRead') * price.cacheRead + v('cacheWrite') * price.cacheWrite + v('out') * price.output;
}
// the cost audit's input measure (2026-11-08): uncached input (cache writes are uncached input) + 0.1 x cached reads
export function inputEq(r) {
  const v = k => (r && Number.isFinite(r[k]) && r[k] > 0 ? r[k] : 0);
  return v('uncachedIn') + v('cacheWrite') + 0.1 * v('cacheRead');
}
export function sumReceipts(list) {
  const t = { calls: 0, uncachedIn: 0, cacheRead: 0, cacheWrite: 0, out: 0, reasoning: 0, inputEq: 0, usageMissing: 0 };
  for (const r of list || []) {
    t.calls++;
    if (r.usageMissing) { t.usageMissing++; continue; }
    for (const k of ['uncachedIn', 'cacheRead', 'cacheWrite', 'out', 'reasoning']) t[k] += Number.isFinite(r[k]) && r[k] > 0 ? r[k] : 0;
    t.inputEq += inputEq(r);
  }
  t.inputEq = Math.round(t.inputEq);
  return t;
}
