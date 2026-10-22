/* AGENT OS — recipe-catalog/general.js : the UNIVERSAL STANDING WATCHES.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogGeneral` global in the browser, module.exports under node.
   NO logic here — pure data.

   ══ WHAT BELONGS HERE ══
   Every record clears THE RECIPE BAR in core.js — and this module is where bar 6 (NON-OBVIOUS or
   UNIVERSAL) is load-bearing. These are the recipes whose whole reason to exist is that the Commander
   would never have thought to ask for them: a station that remembers what it saw last week can notice
   things a person cannot, because the noticing depends on a record nobody was keeping.

   The shape they share: each one holds STATE ACROSS RUNS and reports only the DELTA. That is why they
   cannot be a chat prompt — not because the wording is clever, but because run one is worth little and
   run six is worth a lot. When editing, protect the delta. A "watch" rewritten to re-describe the
   current state every run is dead: the Commander stops opening it, and then it is worth nothing at all.

   ⛔ AND PROTECT THE SILENCE. Every one of these is told to say "nothing moved" in one line and stop.
   A watch that always finds something to report is a watch that has learned to pad, and padding is how
   the Commander learns to skim. Quiet is the correct output most weeks.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogGeneral = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'promises-made', name: 'Promises I Made', emoji: '⊛', tagline: 'What you said you would do, and did not',
      accent: '#cf8a7d',
      blurb: 'Reads what you actually sent and surfaces every commitment you made that never closed.',
      tags: { general: 1 },
      params: [{ key: 'where', label: 'Where to read', placeholder: 'leave blank to read your connected channels — or point me at an export', required: false, default: 'the messages I have sent on my connected channels' }],
      task: 'Go through {where} and find every commitment I MADE that has not closed. I am looking for the sentences people forget they wrote: "I will send you", "let me look into", "I will get back to you", "leave it with me", "I will have that by" — and the softer ones that still landed as a promise in the other person\'s head, which are the ones that actually damage trust because I do not even remember making them. For each: who I said it to, what I committed to, when, whether a deadline was stated or implied, and whether anything since suggests it was resolved. Check your memory of previous runs so a promise I already closed is not raised twice, and so one I keep carrying gets flagged as REPEATEDLY OVERDUE — that pattern is the real finding. Sort by how long it has been outstanding times how much the person is likely still waiting. For each open one, draft the one-line message that either delivers it or honestly resets the expectation, because a late thing with a new date costs almost nothing and silence costs a lot. Do not send anything. If nothing is outstanding, say exactly that in one line and stop. Record what you found so the next run can tell what closed.',
      category: 'general', gear: ['connector', 'notebook', 'cabinet'], skills: ['inbox-triage'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'promises-owed', name: 'What I Am Owed', emoji: '◨', tagline: 'The things other people never sent back',
      accent: '#d9a85a',
      blurb: 'Tracks what others committed to you and quietly never delivered — with the nudge each one has earned.',
      tags: { general: 1 },
      params: [{ key: 'where', label: 'Where to read', placeholder: 'leave blank to read your connected channels — or point me at an export', required: false, default: 'the messages on my connected channels' }],
      task: 'Read {where} and tell me what other people committed to me and never delivered. Most of these die silently: someone says they will send something, both sides move on, and the thing I was actually waiting for is now three weeks late and I have half-forgotten I was blocked on it. For each: who, what they said they would do, the exact words, when, and how long it has been. Compare against your memory of previous runs so anything that has since arrived drops off and anything still open shows how many runs it has survived — a promise on its fourth run is a different problem from one on its first, and needs a different message. Mark which ones I am actually BLOCKED on versus merely waiting for, because that distinction decides where my chasing energy goes. For the ones worth chasing, draft a short note that is friendly, quotes what they said, and makes it easy for them to answer — never a passive-aggressive reminder of how long it has been. Say plainly which ones to write off and stop tracking. Do not send anything. Nothing outstanding, one line. Save the state for next run.',
      category: 'general', gear: ['connector', 'notebook', 'cabinet'], skills: ['inbox-triage'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'terms-drift', name: 'Terms Drift Watch', emoji: '⚠', tagline: 'When the things you depend on change the deal',
      accent: '#cf8a7d',
      blurb: 'Watches the pricing and terms pages of the services you rely on, and reports only what actually changed.',
      tags: { research: 0.6, general: 0.4 },
      params: [{ key: 'services', label: 'What you depend on', placeholder: 'the tools / services / providers you pay for or rely on' }],
      task: 'Watch the pricing, terms and policy pages for {services}. On this run, fetch each one, and compare against the text you recorded on the previous run. THE RECORD IS THE ENTIRE POINT: nobody reads these pages twice, so a change made quietly in March is discovered in December when it costs something, and that gap is exactly what a station with a memory closes. Report only genuine changes, and for each: which service, what the wording was before, what it is now, and — the part that matters — what it means for someone in my position. Sort by consequence: price rises, a free tier narrowing, usage limits, a change to who owns what I put in, a new right for them to use my data, a shortened notice period, or a term that now permits something previously forbidden. Explicitly separate substantive changes from a page merely being reworded or reorganized, because reorganization is common and reporting it as a change trains me to ignore you. Where something changed, say whether there is an action with a deadline attached. If you could not fetch a page, say so plainly — that is completely different from no change, and confusing the two is how this watch quietly fails. Nothing moved, one line. Record every page for next time.',
      category: 'general', gear: ['dish', 'notebook'], skills: ['feed-watch'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'belief-check', name: 'Check What I Believe', emoji: '⊗', tagline: 'The facts you learned that quietly expired',
      accent: '#b790c0',
      blurb: 'Takes the things you have told it are true and re-tests them against the live world.',
      tags: { research: 0.7, general: 0.3 },
      params: [{ key: 'area', label: 'The area', placeholder: 'e.g. what I believe about my tools, my market, my stack', required: false, default: 'everything I have stated as fact in our work together' }],
      task: 'Go through what I have told you is true about {area} — your memory of my stated assumptions, plus anything asserted in the notes and documents you can reach — and re-test it against the live world. This is the check nobody runs on themselves: a fact learned two years ago feels identical in the head to one learned yesterday, so the beliefs quietly steering my decisions are exactly the ones never revisited. For each belief you can check: what I appear to believe, whether it still holds, and what the current position actually is with a source. Rank by how much I would do differently if I learned it had changed — a stale fact I never act on does not matter, and one under a live decision matters a great deal. Be careful in both directions: do not report a belief as broken on one contrary article, and do not confirm one just because the same stale claim is repeated in many places. Say which you could not verify and why, rather than passing an unchecked belief as confirmed. Where something HAS changed, say what I should reconsider because of it. Compare against your previous run so I see what has newly shifted. Save what you checked and when.',
      category: 'general', gear: ['dish', 'notebook', 'cabinet'], skills: ['source-triangulation', 'web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'abandoned-work', name: 'The Graveyard', emoji: '◪', tagline: 'What you started and quietly left',
      accent: '#9fc0c4',
      blurb: 'Sweeps your project folders for work begun and abandoned, and makes you decide: finish, archive, or bin.',
      tags: { general: 0.6, code: 0.4 },
      params: [{ key: 'where', label: 'Where to sweep', type: 'folder', placeholder: 'your projects / work folder' }],
      task: 'Sweep {where} for work I started and abandoned. Look for the real signals rather than just old timestamps: a folder whose files stop mid-structure, a draft with no ending, a project with a first commit and nothing after, a document named like a plan that was never acted on, a half-migrated thing where two approaches sit side by side, notes to myself that were never resolved. For each: what it appears to be, how far it got, when it stopped, and — the useful part — the best guess at WHY it stopped, because "blocked on a decision" and "lost interest" and "finished elsewhere and never cleaned up" need completely different answers. Then force the call: finish it, archive it, or delete it, with a recommendation and one line of reasoning for each. Be willing to say that something should be deleted; a graveyard I only ever add to is the problem this is meant to solve. Flag anything abandoned that OTHER live work still depends on, since that is a real risk hiding as clutter. Compare against your previous run and call out anything I said I would finish and did not — one item on its third run is a decision I am avoiding, and I want it named. Save the state.',
      category: 'general', gear: ['cabinet', 'notebook'], skills: ['file-curation'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'expiry-watch', name: 'Expiry Watch', emoji: '⌸', tagline: 'The dates that cost money when missed',
      accent: '#d9a85a',
      blurb: 'Reads your real documents for every renewal, expiry and deadline — and warns with enough lead time to act.',
      tags: { general: 1 },
      params: [{ key: 'records', label: 'Where to read', type: 'folder', placeholder: 'the folder with your documents / bills / agreements' }],
      task: 'Read {records} and find every date that costs something when missed: expiries, renewals, notice periods, warranty ends, registration and licence dates, free periods converting to paid, and any deadline with a consequence attached. For each, do the thing a calendar cannot: report the date I must ACT by rather than the date on the document. Those are rarely the same — a policy needing thirty days notice must be handled a month before it expires, and the expiry date itself is already too late. That single conversion is most of this recipe\'s value. Give me what it is, the document it came from, the real act-by date, roughly how long the action takes, and what happens if it slips. Sort by act-by date. Then a short DUE SOON list of anything inside its lead time right now. Compare against your memory: tell me what has newly entered its window since the last run, and what I was warned about before and have still not handled — a second warning on the same item should say so plainly. Where a document implies a date but does not state one, flag it as needing confirmation rather than guessing. Nothing due, one line. Save for next run.',
      category: 'general', gear: ['cabinet', 'notebook'], skills: ['file-curation'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'what-changed', name: 'What Changed?', emoji: '◒', tagline: 'A standing watch on anything you name',
      accent: '#6fa8bf',
      blurb: 'Watches whatever you point it at and reports only genuine deltas, measured against its own records.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'subject', label: 'What to watch', placeholder: 'a page, a policy, a price, a competitor, a listing — anything with a state' },
        { key: 'care', label: 'What you care about', placeholder: 'what would actually matter to you', required: false, default: 'any change that would change what I should do' }
      ],
      task: 'Keep watch on {subject} and tell me when {care}. On this run: check the current state, compare it against what you recorded last time, and store what you found with the date. Report ONLY genuine changes measured against your own records — never against your impression, and never a re-description of the current state dressed up as an update, because a watch that reports every run trains me to ignore it and then it is worth nothing. For each real change: what it was, what it is now, roughly when it happened, and whether it changes anything I should DO. Separate substantive change from cosmetic, and say when something merely LOOKS different because it was reworded or moved. If you could not check properly this run, say that explicitly rather than reporting no change — those two are completely different and confusing them is how a watch fails silently for months. Nothing moved, one line and stop.',
      category: 'general', gear: ['dish', 'notebook'], skills: ['feed-watch'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'read-this', name: 'Read This For Me', emoji: '▨', tagline: 'What it says, and what it means for you',
      accent: '#6fa8bf',
      blurb: 'Reads the document you are avoiding and tells you what it actually means for you specifically.',
      tags: { general: 1 },
      params: [
        { key: 'document', label: 'The document', type: 'file', placeholder: 'the letter / policy / notice / agreement' },
        { key: 'concern', label: 'What you want to know', placeholder: 'what you are worried about, if anything', required: false, default: 'whatever in it most affects me' }
      ],
      task: 'Read {document} and tell me what it means for me, particularly regarding {concern}. Lead with the answer to the question I am actually asking, in one paragraph of ordinary language — no preamble about what kind of document this is. Then the three things in here that affect me most, each with what it means in practice rather than a restatement of the wording. Then anything with a DEADLINE or requiring me to do something, at the top of its own short list, because that is the part that costs money to miss. Point me at the specific sections worth reading in full myself and say why. Flag anything ambiguous, anything contradicting something else in the document, and anything unusual for a document of this kind. Quote the exact wording behind every point so I can check you rather than take your word for it. If this is serious enough to warrant a professional — legal, medical, financial — say so plainly and say what to ask them. Then save the key dates and obligations to your memory so the standing expiry watch picks them up. Do not reply to it or act on it.',
      category: 'general', gear: ['cabinet', 'notebook'], skills: ['pdf-document-extraction'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'find-the-catch', name: 'Find the Catch', emoji: '⊝', tagline: 'What they are not putting in the headline',
      accent: '#cf8a7d',
      blurb: 'Reads an offer adversarially against what its rivals actually charge — the real cost, the exit, the quiet part.',
      tags: { general: 0.6, research: 0.4 },
      params: [{ key: 'offer', label: 'The offer', placeholder: 'paste the deal / terms / pitch — or the link' }],
      task: 'Read {offer} adversarially and find the catch. Assume it was written by someone competent whose interests differ from mine, and that anything genuinely good is in the headline while everything else sits where it will not be read. Work out the REAL total cost over a realistic period — not the monthly figure or the introductory rate, but what I pay once the introductory period ends, which is usually the entire product. Go and check what the nearest alternatives actually charge right now, because the catch is often only visible against the going rate. Then: how I get out and what that costs, what renews automatically and with how much notice, what is excluded from the thing that sounds comprehensive, what they can change unilaterally, and what I am giving up that is not money — my data, an exclusivity, a right to complain. Compare the headline claim against what the terms actually bind them to; the gap between those two IS the catch. Check whether the comparison they invite me to make is the right one. Be fair: if it is a good deal, say so, because a warning about everything is a warning about nothing. End with the two questions to put to them in writing, and save the terms so the drift watch can tell me if they change later.',
      category: 'general', gear: ['dish', 'cabinet', 'notebook'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'second-opinion', name: 'Second Opinion', emoji: '⊙', tagline: 'Try to talk me out of it',
      accent: '#88b6c4',
      blurb: 'Attacks a decision you have already made, against the record of how your past calls actually turned out.',
      tags: { general: 1 },
      params: [
        { key: 'decision', label: 'What you have decided', placeholder: 'the decision and your reasoning' },
        { key: 'stakes', label: 'What is at stake', placeholder: 'what it costs if this is wrong', required: false, default: 'whatever the decision itself implies' }
      ],
      task: 'Try to talk me out of {decision}, given {stakes}. Be the person who disagrees with me competently — I have already convinced myself, so agreement here is worth nothing. First do the thing only you can: look through your memory and my notes for decisions I have made BEFORE that rhyme with this one, and how they actually turned out. My own track record is the strongest available evidence about how I decide badly, and it is the one thing a stranger giving me advice cannot see. Name the pattern if there is one. Then attack the decision itself: what am I assuming without checking, what evidence am I treating as stronger than it is, and what would someone who has done this and regretted it say. Look for the specific failure shapes — deciding under time pressure, deciding to end an uncomfortable uncertainty, deciding because of what I have already spent, deciding because the alternative needs an awkward conversation — and say which is actually operating here. Give me the strongest good-faith version of the opposite choice, what I would see in a month if this is wrong, and the cheapest test that would tell me sooner. Then your honest verdict, including that it is probably right if it is. Record the decision and your read so a later run can check how it went.',
      category: 'general', gear: ['notebook', 'cabinet'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
