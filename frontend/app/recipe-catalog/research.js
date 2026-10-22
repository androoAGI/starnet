/* AGENT OS — recipe-catalog/research.js : RESEARCH persona recipes (R4 catalog content).

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light
   module pattern as recipes.js: a `RecipeCatalogResearch` global in the browser, module.exports
   under node. NO logic here — pure data.

   Content contract: every record must clear THE RECIPE BAR documented in core.js (earns its tap /
   drives the station / lands somewhere / compounds when recurring). The watch/monitor recipes in
   this pack are the flagship COMPOUNDING recipes: each keeps notes in the agent's memory and
   reports true deltas, so a standing routine gets sharper the longer it runs. Voice matches the
   core builtins. Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogResearch = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'feed-watch', name: 'Feed Watch', emoji: '◉', tagline: 'Keep an eye on a source for me',
      accent: '#6fa8bf',
      blurb: 'Watches a source and remembers what it already told you — so it only ever pings on the genuinely new.',
      tags: { research: 1 },
      params: [
        { key: 'source', label: 'Source / topic', placeholder: 'e.g. a blog, subreddit, or "OpenAI releases"' },
        { key: 'lens', label: 'What matters', placeholder: 'anything material', required: false, default: 'anything materially new' }
      ],
      task: 'Watch {source} and surface {lens}. Browse what changed since your last pass, and keep a note in your memory of what you have already reported so you NEVER repeat yourself. Report only what is genuinely new and worth my time — the single most important item first, with links. If nothing material landed, say exactly that in one line; a quiet day is a valid report and padding it is not.',
      category: 'research', gear: ['dish', 'notebook'], skills: ['feed-watch'], cadence: 'sixhourly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'literature-review', name: 'Literature Review', emoji: '◫', tagline: 'Map what is known on a question',
      accent: '#88b6c4',
      blurb: 'Surveys the credible sources, weights by evidence quality — ten posts citing one study count once.',
      tags: { research: 1 },
      params: [{ key: 'topic', label: 'Question / field', placeholder: 'e.g. RAG vs long-context for retrieval' }],
      intake: [
        { dimension: 'audience', question: 'Who is this review for?', options: ['practitioner (me)', 'technical deep-dive', 'executive summary'], recommended: 'practitioner (me)', reason: 'audience sets the rigor and jargon level' }
      ],
      task: 'Do a literature review on {topic}. Survey the credible sources — papers, serious practitioners, primary data — and synthesize the actual state of knowledge: what is well-established, where credible sources genuinely disagree, and what nobody has answered yet. Weight by evidence quality, not volume: ten posts citing the same study are ONE source. Lead with the state of the art in a paragraph, then the evidence with citations, then the open questions. Offer to save the full review as a file I can keep.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['web-research', 'source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'competitor-tracking', name: 'Competitor Tracking', emoji: '⊗', tagline: 'What a rival shipped or announced',
      accent: '#6fa8bf',
      blurb: 'Tracks a rival against its own history — pricing pages and job posts, not press-release adjectives.',
      tags: { research: 0.8, general: 0.2 },
      params: [{ key: 'competitor', label: 'Competitor', placeholder: 'e.g. a company or product name' }],
      intake: [
        { dimension: 'scope', question: 'Track how wide?', options: ['product + pricing', 'full company (hiring, funding, positioning)'], recommended: 'product + pricing', reason: 'scope decides where each watch pass spends its time' }
      ],
      task: 'Track {competitor} and brief me on what actually CHANGED: launches, pricing moves, positioning shifts, key hires, funding. Compare against your notes from the last check so you report movement, not the standing state — a changed pricing page and three new job posts tell you more than any press release. Lead with the one move that matters most and what it implies for us. Cite sources; skip the announcement adjectives. Update your notes for next time.',
      category: 'research', gear: ['dish', 'notebook'], skills: ['domain-intel', 'web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'claim-fact-check', name: 'Deep Fact-Check', emoji: '⊚', tagline: 'Verify a claim across the record',
      accent: '#88b6c4',
      blurb: 'Maps who is saying it and traces every version to its origin — repetition never launders into confirmation.',
      tags: { research: 0.9, general: 0.1 },
      params: [{ key: 'claim', label: 'The claim', placeholder: 'paste the statement to verify' }],
      task: 'Fact-check this claim by triangulating truly independent sources: "{claim}". First map who is saying it and trace every version back to its origin — most "many sources" collapse into one origin, repeated. Verdict first (true / false / misleading / unverifiable), then the evidence trail showing which sources independently corroborate versus merely echo. If the honest answer is "it depends", say exactly what it depends on. Never launder repetition into confirmation.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'topic-monitor', name: 'Topic Monitor', emoji: '◐', tagline: 'Standing watch on a subject',
      intake: [
        { dimension: "sources", question: "What feeds the watch?", options: ["broad web","high-signal sources only"], recommended: "high-signal sources only", reason: "sets the noise floor of a standing watch" }
      ],
      accent: '#6fa8bf',
      blurb: 'Keeps a running memory of where a subject stands, so every report is a true delta — never a rerun.',
      tags: { research: 1 },
      params: [{ key: 'topic', label: 'Topic', placeholder: 'e.g. EU AI regulation' }],
      task: 'Monitor {topic} and report what shifted since your last check. Keep a running note in your memory of where things stood, so every report is a true delta: new developments, changed sentiment, notable new sources entering the conversation. Lead with the single most consequential change, sourced. Distinguish signal from churn — three outlets recycling one press release is ONE event. If the picture is unchanged, say so plainly in two lines; never manufacture movement.',
      category: 'research', gear: ['dish', 'notebook'], skills: ['feed-watch', 'web-research'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'paper-summarize', name: 'Summarize a Paper', emoji: '▦', tagline: 'The paper, minus the jargon',
      intake: [
        { dimension: "audience", question: "Who is the summary for?", options: ["plain-English (me)","technical peer"], recommended: "plain-English (me)", reason: "sets the jargon level and depth" }
      ],
      accent: '#9fc0c4',
      blurb: 'Reads the results, not just the abstract — the gap between them is usually the story.',
      tags: { research: 0.7, general: 0.3 },
      params: [{ key: 'paper', label: 'Paper / link / text', placeholder: 'paste a link, DOI, or the text' }],
      task: 'Summarize {paper} for a smart non-specialist. Go read the real thing, not a thread about it. Lead with the claim in one sentence, then what they actually did, what they found, and — the part abstracts hide — how much to trust it: sample size, effect size, who funded the study, what the limitations section quietly admits. Flag any gap between what the abstract claims and what the results show; that gap is usually the story. End with whether this changes anything I should do or believe.',
      category: 'research', gear: ['dish'], skills: ['arxiv-research', 'pdf-document-extraction'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'source-compare', name: 'Source Compare', emoji: '⊞', tagline: 'Where the sources actually disagree',
      intake: [
        { dimension: "deliverable", question: "How should the comparison land?", options: ["verdict + key splits","full comparison table"], recommended: "verdict + key splits", reason: "shape decides how the disagreements read" }
      ],
      accent: '#88b6c4',
      blurb: 'Diagnoses WHY sources diverge — different data, definitions, or incentives — and what would settle it.',
      tags: { research: 1 },
      params: [{ key: 'question', label: 'The question', placeholder: 'e.g. did X cause Y?' }],
      task: 'Compare how the main sources answer: {question}. Lay them side by side and isolate exactly where they diverge — then diagnose WHY: different data, different definitions, different incentives, or someone simply being wrong. The divergence diagnosis is the deliverable; agreement is background. End with your best synthesis, clearly marked as your read with a confidence level, and name the single piece of evidence that would settle the question.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['source-triangulation', 'web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'trend-scan', name: 'Trend Scan', emoji: '◇', tagline: 'What is rising in a space',
      intake: [
        { dimension: "scope", question: "How rigorous a scan?", options: ["fast pulse","evidence-weighted scan"], recommended: "evidence-weighted scan", reason: "depth decides how much gets verified before reporting" }
      ],
      accent: '#d9a85a',
      blurb: 'Applies the three-signal rule — money, adoption, organic demand — to split real trends from loud weeks.',
      tags: { research: 0.9, general: 0.1 },
      params: [{ key: 'space', label: 'Space / field', placeholder: 'e.g. developer tooling' }],
      task: 'Scan {space} for what is genuinely rising. Apply the three-signal rule — a real trend shows up in independent places: money moving (funding, hiring, pricing), practitioners adopting (not just discussing), and repeated organic demand. One loud week on social media is zero of those three. Report the two or three real trends with the evidence for each, the one overhyped thing to ignore, and — if you spot it — the trend still early enough to act on.',
      category: 'research', gear: ['dish'], skills: ['web-research', 'domain-intel'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'background-check', name: 'Background Brief', emoji: '◈', tagline: 'What is on the public record',
      intake: [
        { dimension: "scope", question: "How thorough a pass?", options: ["quick public sweep","thorough record pass"], recommended: "thorough record pass", reason: "decides how far past page one the check goes" }
      ],
      accent: '#9fc0c4',
      blurb: 'Builds the verified spine first, then the texture — shipped-versus-claimed, patterns, independent coverage.',
      tags: { research: 0.8, general: 0.2 },
      params: [{ key: 'subject', label: 'Subject', placeholder: 'a person, company, or product' }],
      task: 'Build a background brief on {subject} from public sources only. Establish the verified spine first — roles, dates, track record — then the texture: what they have actually shipped or done versus merely claimed, patterns across their history, and how independent coverage differs from their own telling. Separate confirmed / reported-but-single-source / rumor explicitly, and note what you could not verify. End with the two or three things most worth knowing before dealing with them.',
      category: 'research', gear: ['dish', 'cabinet'], skills: ['osint-public-records', 'source-triangulation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'research-digest', name: 'Research Digest', emoji: '▤', tagline: 'A themed roundup on your topics',
      intake: [
        { dimension: "deliverable", question: "How should the roundup read?", options: ["bullet digest","narrative brief"], recommended: "bullet digest", reason: "shape decides how the themes are woven" }
      ],
      accent: '#6fa8bf',
      blurb: 'A weekly roundup that checks what past digests covered — all fresh, themed, with a what-it-means read.',
      tags: { research: 1 },
      params: [
        { key: 'topics', label: 'Topics', placeholder: 'e.g. AI agents, robotics, chip supply' },
        { key: 'window', label: 'Window', placeholder: 'the past week', required: false, default: 'the past week' }
      ],
      task: 'Put together a research digest on {topics} covering {window}. Check your memory for what previous digests already covered, so this one is all fresh. Group findings by theme; lead each theme with its most consequential item, sourced, plus one line on why it matters — not just what happened. End with a two-line "what this means" synthesis. If a theme has gone quiet, say so — a dying thread is information too. Keep it skimmable, and log what you covered for next time.',
      category: 'research', gear: ['dish', 'notebook'], skills: ['digest-composer', 'web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
