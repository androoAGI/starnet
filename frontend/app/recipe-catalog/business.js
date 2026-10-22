/* AGENT OS — recipe-catalog/business.js : BUSINESS persona recipes — freelance and small-business work.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogBusiness` global in the browser, module.exports under node.
   NO logic here — pure data.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE OUTBOUND LINE (this module's extra bar) ══
   Half of these recipes end in something addressed to another human — a proposal, a follow-up, a
   contract reply. EVERY one of them stops at the draft. The directive says so explicitly, in the
   directive itself, because the Commander must never discover after the fact that the station sent
   something on their behalf. (recipes.js `impliesOutbound` reads these for the launch-form warning;
   the honesty has to live in the task text too, where the agent actually reads it.)

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogBusiness = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'client-proposal', name: 'Client Proposal', emoji: '◪', tagline: 'Scoped, priced, and bounded',
      accent: '#7bc88a',
      blurb: 'Turns a loose conversation into a proposal with a real boundary — what is included, and what is not.',
      tags: { general: 1 },
      intake: [
        { dimension: 'deliverable', question: 'What shape of proposal?', options: ['one-page', 'full document'], recommended: 'one-page', reason: 'a proposal that gets read beats a thorough one that does not' }
      ],
      params: [
        { key: 'brief', label: 'What they asked for', placeholder: 'paste the brief / the call notes' },
        { key: 'terms', label: 'Your terms', placeholder: 'e.g. day rate, 50% up front, 4-week window', required: false, default: 'the terms you have told me you normally work on' }
      ],
      task: 'Write a proposal from {brief}, on {terms}. Open by restating THEIR problem in their words well enough that they feel understood — that paragraph wins more work than the credentials section ever does. Then the outcome they get, described as the change in their situation rather than a list of my activities. Scope it precisely, and give equal weight to what is NOT included: unbounded scope is how a good project turns into a bad one, and the exclusions list is the single most valuable part of the document for both sides. Price it clearly with what triggers anything extra. Add the assumptions the price depends on, because those are the early-warning system when things drift. Include a realistic timeline with the dates I need something FROM them, since that is usually what actually delays a project. Close with a specific next step and a decision date. Then flag any part of the brief that is too vague to price and what to ask before sending. Give me the draft — I send it, not you.',
      category: 'business', gear: ['cabinet'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'lead-research', name: 'Lead Research', emoji: '◉', tagline: 'Who to approach, and the way in',
      accent: '#6fa8bf',
      blurb: 'Finds businesses that plausibly need what you sell — each with the evidence and a real opening line.',
      tags: { research: 0.6, general: 0.4 },
      params: [
        { key: 'offer', label: 'What you sell', placeholder: 'e.g. brand photography for restaurants' },
        { key: 'where', label: 'Where to look', placeholder: 'e.g. independent restaurants in Manchester', required: false, default: 'wherever your kind of buyer is findable' }
      ],
      task: 'Find me leads for {offer} in {where}. For each one I want EVIDENCE they have the problem I solve right now — a visible gap, a recent change, something they are publicly trying to do — not just that they belong to the right category. That evidence is what makes an approach welcome instead of spam, and a list without it is a phone book. For each lead: the business, why they plausibly need this now with the specific thing you observed, who the right person to reach is and how they are reachable publicly, roughly what size of engagement is realistic, and one opening line that references the actual observation. Rank by how likely they are to say yes soon, not by how much I would like them as a client. Use only public information — never anything scraped from behind a login or personal contact details that were not published for business contact. Say plainly when the evidence for a lead is thin. Do not contact anyone; the list is for me to work.',
      category: 'business', gear: ['dish', 'notebook'], skills: ['lead-scouting', 'web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'cold-outreach', name: 'Cold Outreach', emoji: '⌁', tagline: 'A first message that is not spam',
      accent: '#6fbcc0',
      blurb: 'Researches the business first, then writes the short specific note that earns a reply.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'target', label: 'Who you are writing to', placeholder: 'the business / person — a link is ideal' },
        { key: 'offer', label: 'What you offer', placeholder: 'what you do for people like them' }
      ],
      task: 'Write a first approach to {target} about {offer}. Look them up first and find the one specific, current, true thing that makes this message worth their sixty seconds — the observation is the entire message; everything else is packaging. Then write it short: the observation, the outcome I could help with stated as their benefit rather than my service, one line of proof that I have done it before, and a small ask that is easy to say yes or no to. Under 120 words, plain language, no flattery, no paragraph about my company, no fake familiarity, and never a manufactured deadline. Give me a subject line that is descriptive rather than clever, one alternate opening in a different register, and a single follow-up to send if there is no reply — once, after a real interval, adding something new rather than repeating myself. Tell me honestly if the observation you found is too thin to justify the message; not sending is a valid outcome. Do not send anything.',
      category: 'business', gear: ['dish'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'pricing-review', name: 'Pricing Review', emoji: '◭', tagline: 'What you should actually charge',
      accent: '#d9a85a',
      blurb: 'Checks your prices against the real going rate and the value delivered — then names the raise you can defend.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'offering', label: 'What you sell', placeholder: 'your service / product and what you charge now' },
        { key: 'position', label: 'Where you sit', placeholder: 'e.g. 6 years in, mostly referrals, always booked', required: false, default: 'what you tell me about your demand and experience' }
      ],
      task: 'Review my pricing for {offering}, given {position}. Find what comparable people actually charge right now — published rates, real listings, what buyers report paying — and say how reliable each number is, because the loudest published rates skew high and the quiet ones skew low. Then price from the other direction: what is this worth to the buyer in money saved or made, since that ceiling matters far more than what my peers charge. Tell me directly whether I am underpriced, and by roughly how much. If I am, give me the specific raise to make, who to apply it to first (new enquiries always, existing clients on a stated notice), the sentence that communicates it without apologizing or over-explaining, and what to do about the small number of clients who will leave — usually the right ones. Cover the structural changes worth more than a rate rise: a minimum engagement, a deposit, a faster-turnaround tier, or charging for the part I currently give away. Name the one change with the best return for the least risk.',
      category: 'business', gear: ['dish', 'notebook'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'contract-read', name: 'Read a Contract', emoji: '▨', tagline: 'Plain language, and the clauses that bite',
      accent: '#cf8a7d',
      blurb: 'Explains what you are agreeing to, flags the terms that hurt later, and drafts what to push back on.',
      tags: { general: 1 },
      params: [{ key: 'contract', label: 'The contract', type: 'file', placeholder: 'the agreement — or paste the terms' }],
      task: 'Read {contract} and tell me plainly what I am agreeing to. Lead with the five things that would actually affect me if this went wrong, not a clause-by-clause walkthrough. Then go looking for the terms that bite quietly: who owns what I produce and when that transfers, payment timing and what happens when they pay late, how either side ends this and with what notice, whether I am restricted from other work, unlimited liability or an indemnity that is not capped, anything that lets them change the terms unilaterally, and automatic renewal. For each concern: what the clause says, what it means for me in practice, how unusual it is, and the specific alternative wording to ask for. Separate what genuinely matters from what is standard boilerplate I should just accept — a list of twenty objections gets me nowhere and marks me as difficult. Draft the pushback message covering the top three. Quote the exact clause behind every point so I can check you. This is not legal advice: say so, and say plainly when something is serious enough to be worth a real lawyer\'s hour. Do not sign or send anything.',
      category: 'business', gear: ['cabinet'], skills: ['pdf-document-extraction'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'client-checkin', name: 'Client Check-In', emoji: '◐', tagline: 'The update they actually value',
      accent: '#88b6c4',
      blurb: 'Drafts the standing update from real progress — and compares against last time so it shows movement.',
      tags: { general: 1 },
      params: [
        { key: 'client', label: 'Client / project', placeholder: 'who it is and what you are doing for them' },
        { key: 'progress', label: 'What happened', type: 'folder', placeholder: 'your notes / work folder — or leave blank and I will ask', required: false, default: 'what you tell me about the period' }
      ],
      task: 'Draft the check-in for {client} from {progress}. Compare against the update in your memory from last time — a client update that does not show MOVEMENT since the last one is the reason clients stop reading them. Structure it the way a paying client actually reads: what moved and what it means for their outcome, what is next and by when, then anything I need from them with a specific date, because that is the part that quietly delays projects and it belongs where they cannot miss it. Anything that has gone wrong goes near the top, stated plainly with the fix and the revised date beside it — a problem they discover later costs ten times more trust than one I lead with. Keep it short enough to read on a phone. No hedging, no filler activity presented as progress. Record what you reported so the next one has a baseline. Draft only; I send it.',
      category: 'business', gear: ['cabinet', 'notebook'], skills: ['digest-composer'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'scope-creep', name: 'Scope Creep Defense', emoji: '⊘', tagline: 'Say yes to the work, no to the free',
      accent: '#cf8a7d',
      blurb: 'Compares the ask against what was agreed, then writes the reply that keeps the client and the boundary.',
      tags: { general: 1 },
      params: [
        { key: 'ask', label: 'What they are now asking', placeholder: 'paste the request' },
        { key: 'agreed', label: 'What was agreed', type: 'file', placeholder: 'the proposal / contract — or describe the original scope', required: false, default: 'the scope you described to me earlier' }
      ],
      task: 'Compare {ask} against {agreed} and tell me whether this is genuinely new work. Be precise, because the answer decides everything and both mistakes are expensive: charging for something that was always included damages trust, and absorbing a real addition teaches the client that scope is free. Quote the part of the original that does or does not cover it. If it is new, estimate the time honestly and give me the reply: warm, no resentment, treating the request as a normal and welcome thing — confirm I can do it, state what it adds in time and cost, and ask them to confirm before I start. Never frame it as a complaint about their behaviour. If it is a small thing genuinely worth absorbing, say so and tell me to name it as included at no charge so the goodwill actually registers instead of vanishing. If this is the third such ask, say that too — the pattern needs a different conversation, and give me the opening line for it. Draft only; I send it.',
      category: 'business', gear: ['cabinet'], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'support-digest', name: 'Support Digest', emoji: '▦', tagline: 'What customers keep hitting',
      accent: '#6fa8bf',
      blurb: 'Clusters real support conversations into the few underlying causes — ranked by what fixing them saves.',
      tags: { general: 1 },
      params: [{ key: 'tickets', label: 'Support conversations', type: 'file', placeholder: 'an export of tickets / emails — or paste them' }],
      task: 'Digest {tickets} into what is actually going wrong. Cluster by underlying CAUSE rather than by the words customers used — thirty conversations are usually five real problems wearing different vocabulary, and the clustering is the whole value here. For each cluster: how many conversations, how much time it is costing to answer repeatedly, whether the fix belongs in the product, the documentation, or the way it is sold (a mismatch between promise and reality shows up here first), and what the fix would be. Rank by conversations saved per unit of effort. Then two extras: quote the two or three messages that state the problem most clearly, because a real customer sentence moves a team further than a summary ever does; and flag anything a customer said that suggests they are close to leaving. Compare against your memory of the last digest and say which clusters are growing, shrinking, or new — the direction of travel is the signal. Save this digest for next time.',
      category: 'business', gear: ['cabinet', 'notebook'], skills: ['digest-composer'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'churn-watch', name: 'Churn Watch', emoji: '◖', tagline: 'Who is quietly on the way out',
      accent: '#cf8a7d',
      blurb: 'Reads the quiet signals across your client list and names who to call this week, with the reason.',
      tags: { general: 1 },
      params: [{ key: 'accounts', label: 'Your clients / accounts', type: 'file', placeholder: 'your client list with recent activity — or describe them' }],
      task: 'Go through {accounts} and tell me who is drifting away. The signals are quiet and they are mostly about CHANGE rather than absolute level: replies getting shorter and slower, a regular rhythm that stopped, a champion who left, renewal approaching with no conversation started, usage falling off, a complaint that was resolved but never followed up. For each at-risk account: what I actually observed, how confident that reading is, what it would cost me to lose them, and the specific action this week — a call rather than an email where it matters, and what to open with. Be honest about which ones are probably already gone and not worth the effort, and which are fine despite looking quiet. Rank by value at risk times how much a timely move would change the odds. Compare against your memory of the last run so I can see who is getting worse. Do not contact anyone.',
      category: 'business', gear: ['cabinet', 'notebook'], skills: [], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'case-study', name: 'Case Study', emoji: '⊙', tagline: 'The win, written so it sells',
      accent: '#b790c0',
      blurb: 'Turns a finished project into the story a future buyer recognizes themselves in.',
      tags: { general: 1 },
      params: [
        { key: 'project', label: 'The project', placeholder: 'what you did, for whom, and how it went' },
        { key: 'numbers', label: 'The results', placeholder: 'any real numbers you can share', required: false, default: 'whatever measurable outcome you can tell me about' }
      ],
      task: 'Turn {project} into a customer story I can publish, using {numbers}. Structure it so a future buyer recognizes THEMSELVES in the opening — the situation before, described with the frustration a similar client is feeling right now, is what makes them keep reading. Then what was actually tried, including the approach that did not work, because a write-up with no friction reads as marketing and gets discounted. Then what changed, with real numbers wherever I have given you one; where I have not, say what to go and ask the client for rather than reaching for a vague superlative. Keep my role honest — what I did versus what their team did — since an inflated claim is exactly what a buyer\'s due-diligence call exposes. Add a pull-quote worth asking the client to approve, a one-paragraph version for a proposal, and a two-line version for a profile. Flag anything that needs the client\'s permission before it goes public, and anything commercially sensitive I should strip.',
      category: 'business', gear: ['cabinet'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'sales-followup', name: 'Follow-Up Sequence', emoji: '◗', tagline: 'The nudges after the pitch',
      accent: '#7bc88a',
      blurb: 'Plans the follow-ups that add something each time — with a stated end, so nothing becomes pestering.',
      tags: { general: 1 },
      params: [
        { key: 'deal', label: 'The opportunity', placeholder: 'who, what you proposed, and what was said last' },
        { key: 'lastcontact', label: 'Last contact', placeholder: 'when and what happened', required: false, default: 'what you tell me about the last exchange' }
      ],
      task: 'Plan the follow-up for {deal}, given {lastcontact}. Read the ACTUAL thread on my connected channels rather than my summary of it — what they literally said, and what they conspicuously did not answer, is the whole basis for the next message, and my recollection of a conversation I want to go well is not reliable. Check your memory for what I have already sent them and when, so a second nudge never repeats the first. First read the silence honestly — no reply after a proposal usually means competing priorities or an unspoken objection, rarely genuine interest, and the sequence should be built for the likely reason rather than my preferred one. Then give me three follow-ups spaced over a realistic period, each ADDING something they did not have before: an answer to the objection I suspect, a relevant example, a reduced first step that lowers the risk of saying yes. Never a message whose entire content is that I am checking in — that asks them to do work for my benefit. Include the polite close-out that goes last: a short note releasing them, which gets more replies than any of the nudges because it costs nothing to answer. State the point where I stop and move on. For each, the send timing and the one line that carries it. Draft only; I send them.',
      category: 'business', gear: ['connector', 'notebook', 'cabinet'], skills: [], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'sop-write', name: 'Write an SOP', emoji: '▩', tagline: 'A process someone else can run',
      accent: '#9fc0c4',
      blurb: 'Turns something only you know how to do into steps a new person can follow without asking you.',
      tags: { general: 1 },
      params: [
        { key: 'process', label: 'The process', placeholder: 'what you do — walk through it roughly' },
        { key: 'who', label: 'Who will run it', placeholder: 'e.g. a new hire, a VA, future me', required: false, default: 'someone competent who has never done this before' }
      ],
      task: 'Turn {process} into a document {who} can follow without asking me anything. Write the steps in order, each one an action with a clear finish, and put the JUDGEMENT in writing — the decision points where I would use experience are exactly what a written process usually leaves out and exactly why handovers fail. For each: what to do, how to know it worked, and what to do when it does not. Name the tools and access needed up front. Flag the two or three steps where a mistake is expensive or hard to undo, and add the check that catches it. Include what is explicitly NOT this person\'s call and who to escalate to. Then interrogate my own description: list every place I said something like "obviously" or skipped a step because it is automatic to me, and ask me the specific question that fills it — those gaps are the whole reason this document will fail. Finish with a short checklist version for someone who already knows the process. Offer it as a file.',
      category: 'business', gear: ['cabinet', 'notebook'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'client-onboard-kit', name: 'Client Onboarding Kit', emoji: '⊞', tagline: 'Start the project properly',
      accent: '#6fbcc0',
      blurb: 'Everything a new client needs in week one — so the project starts clean instead of drifting.',
      tags: { general: 1 },
      params: [
        { key: 'engagement', label: 'The engagement', placeholder: 'what you are doing for them and over what period' },
        { key: 'style', label: 'How you work', placeholder: 'e.g. weekly updates, async, one revision round', required: false, default: 'the way you have told me you normally work' }
      ],
      task: 'Build the onboarding kit for {engagement}, working {style}. Four pieces. A welcome note that sets the tone and states what happens in the first week. A kickoff agenda that surfaces the things that cause trouble later: who actually approves work, what "done" looks like to them, the constraint nobody has mentioned yet, and what a disaster would look like from their side. An intake list of everything I need from them — access, assets, contacts, decisions — each with a date and a note on what stalls without it. And a short working-agreement covering how we communicate, response expectations both ways, how revisions work and how many, and how extra work gets agreed. Keep the whole thing light enough that a small client does not feel bureaucratised; the goal is fewer surprises, not more paperwork. Then tell me the one question in the kickoff most likely to change how I run this project. Draft only.',
      category: 'business', gear: ['cabinet'], skills: ['plan'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
