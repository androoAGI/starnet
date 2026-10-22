/* AGENT OS — recipe-catalog/ops.js : OPS / LIFE-ADMIN persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogOps` global in the browser, module.exports under
   node. NO logic here — pure data.

   Content contract: every record must clear THE RECIPE BAR documented in core.js (earns its tap /
   drives the station / lands somewhere / compounds when recurring). Ops recipes reach for the
   station's own reach first — connected channels for the inbox, memory for the recurring reviews
   and watches — and fall back to paste only for material that genuinely lives outside (private
   statements, personal notes). Voice matches the core builtins. Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogOps = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'inbox-triage-brief', name: 'Inbox Triage', emoji: '⊟', tagline: 'What in your inbox actually needs you',
      accent: '#6fa8bf',
      blurb: 'Reads your connected channels (or a paste), sorts by what needs you, and pre-drafts the core of each reply.',
      tags: { general: 1 },
      params: [{ key: 'messages', label: 'Messages', placeholder: 'leave blank to read your connected channels — or paste emails / threads', required: false, default: 'the recent unread messages on my connected channels — read them directly; if no channel is connected, ask me to paste instead' }],
      task: 'Triage these messages: {messages}\n\nSort them into Reply now / Reply later / FYI-only / Ignore, each with a one-line reason. Lead with anything time-sensitive or from someone who matters. For each reply-now, draft the one-sentence core of what the reply should say — so answering takes seconds, not re-reading. Flag anything that smells like a scam or phish. Do not send, archive, or delete anything; I act, you sort.',
      category: 'ops', gear: ['connector'], skills: ['digest-composer'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'meeting-prep', name: 'Meeting Prep', emoji: '◱', tagline: 'Walk in ready, not cold',
      intake: [
        { dimension: "objective", question: "What should the prep aim at?", options: ["just get me oriented","help me drive an outcome"], recommended: "just get me oriented", reason: "changes whether prep is a briefing or a playbook" }
      ],
      accent: '#6fa8bf',
      blurb: 'Situation brief, likely topics, your talking points — with a live background pass on who is in the room.',
      tags: { general: 0.7, research: 0.3 },
      params: [
        { key: 'meeting', label: 'The meeting', placeholder: 'who / what it is about' },
        { key: 'context', label: 'Context', placeholder: 'paste agenda / prior notes', required: false, default: 'what you already know about it' }
      ],
      task: 'Prep me for {meeting}, using {context}. Give me the situation in one paragraph, then: the three topics most likely to come up, the questions I should expect with suggested answers, and the two or three points I should land. If the other side is a public person or company, run a quick background pass on where they stand right now — recent moves change the conversation. Flag anything worth fact-checking before I walk in. One skim, not a dossier.',
      category: 'ops', gear: ['dish'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'weekly-review', name: 'Weekly Review', emoji: '▤', tagline: 'Close the week, aim the next',
      accent: '#7bc88a',
      blurb: 'Compares against last week\'s review from memory — the pattern across weeks is the real signal.',
      tags: { general: 1 },
      params: [{ key: 'notes', label: 'This week', placeholder: 'paste your notes / done list / calendar', required: false, default: 'what you tell me about this week' }],
      task: 'Run my weekly review from {notes}. Compare against last week\'s review in your memory — the pattern across weeks is the real signal. Give me the honest read: what actually moved; what slipped and the REASON it slipped (overcommitted, avoided, blocked — each needs a different fix); and what I keep carrying forward without touching, because that item wants doing or dropping, not re-listing. Then the three things that most deserve next week, in order. Store this review for next week\'s comparison. Straight mirror, no cheerleading.',
      category: 'ops', gear: ['notebook'], skills: ['decision-1-3-1'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'travel-plan', name: 'Travel Plan', emoji: '◈', tagline: 'A trip mapped end to end',
      intake: [
        { dimension: "constraints", question: "What wins on trade-offs?", options: ["budget-conscious","comfort first"], recommended: "budget-conscious", reason: "decides every either/or in the itinerary" }
      ],
      accent: '#d9a85a',
      blurb: 'Researches real options into a walkable day-by-day — with what to book early and what to leave loose.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'trip', label: 'The trip', placeholder: 'e.g. 4 days in Lisbon in October' },
        { key: 'priorities', label: 'What matters', placeholder: 'e.g. food, walkable, budget-conscious', required: false, default: 'a good balance of highlights and downtime' }
      ],
      task: 'Plan {trip} around {priorities}. Research the real options — current opening days, actual distances, honest reviews — then give me a day-by-day plan that is genuinely walkable in the time, not a fantasy checklist. Include where to stay and why that neighborhood, the few bookings to lock early versus what to leave loose, and rough costs. Lead with a quick summary, then the detail. Flag anything time-sensitive. Do not book anything — the plan is mine to act on.',
      category: 'ops', gear: ['dish', 'cabinet'], skills: ['web-research', 'plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'price-watch', name: 'Price Watch', emoji: '◉', tagline: 'Tell me when it moves',
      accent: '#6fa8bf',
      blurb: 'Records real price history in memory — so a "deal" is judged against the truth, not the crossed-out fiction.',
      tags: { general: 0.7, research: 0.3 },
      params: [
        { key: 'item', label: 'What to watch', placeholder: 'a product, ticker, or "flights to Tokyo"' },
        { key: 'trigger', label: 'Tell me when', placeholder: 'it moves meaningfully', required: false, default: 'it moves meaningfully or comes back in stock' }
      ],
      task: 'Watch the price of {item} and tell me when {trigger}. Check the current price across a couple of reliable sources, record it in your memory with the date, and judge any move against YOUR recorded history — a "deal" only counts against real prior prices, never the seller\'s crossed-out fiction. Surface it only on a move worth acting on, with the number, the delta from history, and the link. Nothing moved? One line. And never tell me to hurry — urgency is their trick, not yours.',
      category: 'ops', gear: ['dish', 'notebook'], skills: ['price-watch'], cadence: 'sixhourly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'subscription-audit', name: 'Subscription Audit', emoji: '⊡', tagline: 'What you are paying for and forgot',
      accent: '#cf8a7d',
      blurb: 'Keep / downgrade / cancel with the yearly cost of each — and the total the cancel pile would save.',
      tags: { general: 1 },
      params: [{ key: 'charges', label: 'Statements', type: 'file', placeholder: 'a statement / card export — or paste the recurring charges' }],
      task: 'Audit the recurring charges in {charges}. Read the real statement rather than a list I typed from memory — the ones I forget to mention are precisely the ones worth finding. Compare against your record from the last run: a price that CREPT UP is invisible in any single statement and is the most valuable thing this can tell me, so lead with anything that changed since last time. For each: keep, downgrade, or cancel — with a one-line reason and the cost stated per month AND per year, because the yearly number is the one that stings. Lead with the biggest easy savings. Flag duplicates, overlapping services doing the same job, and anything that looks like a forgotten free-trial rollover. Total what the cancel pile saves per year, and note which cancellations are known to be deliberately annoying so I budget the patience. I decide; you make it obvious.',
      category: 'ops', gear: ['cabinet', 'notebook'], skills: ['ledger-upkeep'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'decision-memo', name: 'Decision Memo', emoji: '◇', tagline: 'One page to make the call',
      accent: '#b790c0',
      blurb: 'Options with honest trade-offs — "do nothing" included — then a real position, not a hedge.',
      tags: { general: 1 },
      params: [
        { key: 'decision', label: 'The decision', placeholder: 'the choice you are weighing' },
        { key: 'material', label: 'The material', type: 'folder', placeholder: 'the docs / data behind it', required: false, default: 'whatever you already know about this' }
      ],
      intake: [
        { dimension: 'audience', question: 'Who reads the memo?', options: ['just me', 'team / stakeholders'], recommended: 'just me', reason: 'a stakeholder memo needs context a self-memo can skip' }
      ],
      task: 'Write a one-page decision memo for {decision}, working from {material} and from the live web where a fact is checkable. Ground it first: read what actually exists rather than reasoning from my summary, and check your memory for decisions I have made before that rhyme with this one and how they turned out — my own track record is the best available evidence about how I decide badly. State the actual question — often not the one asked — then the viable options with honest trade-offs, including "do nothing", which is always an option and usually the incumbent. Name the few facts that would change the answer and the cheapest way to get them. Then decide: a clear recommendation, the reasoning, your confidence, and the early signal that would tell us we chose wrong. Take a position — hedged memos decide nothing.',
      category: 'ops', gear: ['cabinet', 'dish', 'notebook'], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'learning-plan', name: 'Learning Plan', emoji: '◫', tagline: 'A path from zero to competent',
      intake: [
        { dimension: "deliverable", question: "What kind of path?", options: ["project-based path","course/reading path"], recommended: "project-based path", reason: "changes what each stage of the plan looks like" }
      ],
      accent: '#7bc88a',
      blurb: 'A project at every stage, ONE resource per stage, testable milestones — and progress tracked in memory.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'skill', label: 'What to learn', placeholder: 'e.g. SQL, sourdough, Rust' },
        { key: 'budget', label: 'Time budget', placeholder: 'e.g. 3 hours a week', required: false, default: 'a few hours a week' }
      ],
      task: 'Design a learning plan for {skill} on {budget}. Sequence from foundations to competent with a small PROJECT at every stage — you learn by making, not by finishing courses — and exactly ONE good resource per stage, chosen from the research over the ten alternatives. Define what "I can actually do this now" looks like at each milestone, so progress is testable rather than felt. Be honest about the total timeline. Offer to store the plan in your memory and check my progress against it when I come back.',
      category: 'ops', gear: ['dish', 'notebook'], skills: ['study-plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'daily-standup', name: 'Daily Standup', emoji: '☀', tagline: 'Your day, focused before it starts',
      accent: '#d9a85a',
      blurb: 'Reads your connected calendar or tasks when it can, remembers yesterday — the one thing to protect, first.',
      tags: { general: 1 },
      params: [{ key: 'context', label: 'Today', placeholder: 'paste your calendar / tasks — or leave blank to read connected channels', required: false, default: 'today\'s calendar and tasks — read them from my connected channels if any are wired, otherwise ask me' }],
      task: 'Give me a focused standup for {context}. Lead with the ONE thing that matters most today and where the protected time for it lives. Then the rest in order — meetings with a prep note where one is needed, deadlines, follow-ups. Flag conflicts and over-packed stretches. Check your memory for yesterday\'s standup and call out anything I said I would do that is not on today\'s list — follow-through should be visible. Save today\'s for tomorrow. Ten-second read.',
      category: 'ops', gear: ['connector', 'notebook'], skills: ['plan'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'stock-watch', name: 'Market Watch', emoji: '◐', tagline: 'A pulse on what you hold or track',
      accent: '#6fa8bf',
      blurb: 'Reports only real moves with the likely driver, against your last pulse from memory — trend, not snapshot.',
      tags: { general: 0.5, research: 0.5 },
      params: [{ key: 'watchlist', label: 'Watchlist', placeholder: 'e.g. tickers or assets you follow' }],
      task: 'Give me a market pulse on {watchlist}. Report only the names that moved meaningfully — each with the number and the likely driver (earnings, news, sector move), sourced from the coverage, never guessed. Compare against your last pulse in memory so I see the trend, not a snapshot, and update it after. Lead with the biggest mover; skip everything flat. Whole list quiet? One line. This is a briefing, not advice — never tell me to buy or sell anything.',
      category: 'ops', gear: ['dish', 'notebook'], skills: ['web-research'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
