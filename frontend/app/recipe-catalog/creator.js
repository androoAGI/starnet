/* AGENT OS — recipe-catalog/creator.js : CREATOR recipes — audience, publishing, and the archive.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as recipes.js: a `RecipeCatalogCreator` global in the browser, module.exports under node.
   NO logic here — pure data.

   ══ WHY THIS MODULE WAS REBUILT (2026-08-04) ══
   Seven of its ten recipes failed the chat-box test outright: "draft me some hooks", "give me title
   ideas", "outline a script". A plain chat box does all of that just as well, so shipping them is what
   made the catalog read as a prompt list. The rebuild rests on the one thing a chat box does not have:
   THE COMMANDER'S OWN ARCHIVE AND CHANNELS. Every recipe here reads what they actually published, what
   their audience actually said, or what the live web now says about work they put out months ago.

   That reframing is also what makes these NON-OBVIOUS (bar 6). "Write me a hook" is a request anyone
   thinks of. "Go through everything I have published and tell me which claims have since become false"
   is not — and it is only possible on a station that can read the archive and the live web together.

   Content contract: every record clears THE RECIPE BAR documented in core.js, all six points.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogCreator = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'audience-question-mining', name: 'Question Mining', emoji: '◉', tagline: 'The thing they keep asking',
      accent: '#6fa8bf',
      blurb: 'Reads your real comments and replies, finds the question that keeps recurring, and drafts the piece that answers it once.',
      tags: { research: 0.5, general: 0.5 },
      params: [{ key: 'where', label: 'Where to read', placeholder: 'leave blank to read your connected channels — or point me at an export', required: false, default: 'the comments and replies on my connected channels' }],
      task: 'Mine {where} for what my audience actually keeps asking. Cluster by the UNDERLYING question rather than the words used — thirty comments are usually four real questions wearing different vocabulary, and that clustering is the whole value here. For each cluster: how many people asked, the clearest verbatim example, and whether I have already answered it somewhere. If I have and they are still asking, my answer is not findable — a different problem and a more valuable finding. Compare against your memory of the last run and say which questions are NEW, which are growing, and which have gone quiet since I covered them; that last one is the only honest way to tell whether a piece landed. Then take the top cluster and draft the outline of the piece that answers it properly, in my voice, with the specific examples the comments show people need. Flag any question I should NOT answer publicly. If nothing new surfaced, say so in one line and stop.',
      category: 'creator', gear: ['connector', 'notebook', 'cabinet'], skills: ['digest-composer'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'stale-content-sweep', name: 'Stale Content Sweep', emoji: '⚠', tagline: 'What you published that is now wrong',
      accent: '#cf8a7d',
      blurb: 'Re-checks your published work against the live web — dead links, moved pages, and claims that quietly became false.',
      tags: { research: 0.6, general: 0.4 },
      params: [{ key: 'published', label: 'Your published work', placeholder: 'your site / channel — or the folder holding it' }],
      task: 'Sweep {published} for things that are no longer true. Nobody re-reads their own back catalogue, so errors accumulate silently and a reader who finds one assumes everything else is stale too — this is reputational maintenance, not tidying. Four passes. Dead or redirected links, with what they point at now. Claims about products, prices, versions or people that have since changed, checked against the live web. Anything I stated as current — "the newest", "recently", a year, a number — that has aged into being wrong. And recommendations of tools or services that have shut down, changed hands, or gone paid. For each: where it is, what it says, what is actually true now with a source, and how serious it is — a dead link in a footnote is not a wrong price in the first paragraph. Rank by that seriousness, and by traffic if I have given you any. Compare against your memory so a fix I already made is not raised twice. Nothing rotted, one line and stop.',
      category: 'creator', gear: ['dish', 'cabinet', 'notebook'], skills: ['web-research'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'repurpose-queue', name: 'Repurpose Queue', emoji: '⊕', tagline: 'The work you made once and used once',
      accent: '#7bc88a',
      blurb: 'Finds pieces in your archive that never got a second life — ranked by what is still worth reviving.',
      tags: { general: 1 },
      params: [
        { key: 'archive', label: 'Your archive', type: 'folder', placeholder: 'the folder holding your published work' },
        { key: 'formats', label: 'Where you publish', placeholder: 'e.g. short video, newsletter, threads', required: false, default: 'the formats you have told me you use' }
      ],
      task: 'Go through {archive} and find work that was made once and used once. Most creators sit on far more than they think: a piece that did well and was never cut down, an idea buried in the middle of something about a different topic, an explanation given in passing that deserves to be its own thing, a piece that landed badly because of timing or format rather than substance. For each candidate: what it is, why it is worth a second life, which of {formats} it suits and why THAT one, and what would have to change — most repurposing fails because a piece is moved without being re-cut for the new format. Rank by how little work each needs against how much it is likely to be worth. Say plainly which pieces should stay buried. Compare against your memory so anything I already repurposed drops off and the same piece is not offered every week. Then take the top one and draft the re-cut version.',
      category: 'creator', gear: ['cabinet', 'notebook'], skills: ['content-calendar'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'voice-drift', name: 'Voice Drift', emoji: '◒', tagline: 'How your writing changed without you noticing',
      accent: '#b790c0',
      blurb: 'Reads your archive in time order and reports how your voice and subjects actually moved.',
      tags: { general: 1 },
      params: [{ key: 'archive', label: 'Your archive', type: 'folder', placeholder: 'the folder holding your published work, oldest to newest' }],
      task: 'Read across {archive} in time order and tell me how my writing has actually changed. This is invisible from the inside — each piece feels like the last one — so it needs somebody reading the whole run at once, which is exactly what a chat box cannot do. Report on: sentence length and structure, how much I hedge, how personal it is, how much I explain versus assume, the words and constructions I have started leaning on, and the ones I have dropped. Then subjects: what I have drifted toward and away from, and whether that reads as a decision or a drift. Be concrete — quote an early passage beside a recent one making the same kind of point, because the comparison shows more than any description. Say which changes look like genuine improvement and which look like habits hardening into tics, and be honest that some of it is simply change rather than decline. Finish with the two or three things worth deliberately keeping and the one worth deliberately breaking. Save this reading so a later run can measure against it.',
      category: 'creator', gear: ['cabinet', 'notebook'], skills: ['humanizer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'performance-diff', name: 'What Actually Landed', emoji: '◐', tagline: 'Your numbers against your own record',
      accent: '#d9a85a',
      blurb: 'Reads your real export and compares it against its own history — a good week measured against you, not a benchmark.',
      tags: { general: 1 },
      params: [
        { key: 'stats', label: 'Your stats export', type: 'file', placeholder: 'the analytics / stats export' },
        { key: 'goal', label: 'What you are optimizing for', placeholder: 'e.g. subscribers, replies, reach', required: false, default: 'whatever the export makes measurable' }
      ],
      task: 'Read {stats} and tell me what actually landed, measured against {goal}. Compare against the numbers you recorded on previous runs — a raw figure means nothing alone, and an industry benchmark means less than my own baseline, so the comparison that matters is against me. Report what over- and under-performed relative to MY normal, and for each the specific attribute that plausibly explains it: subject, format, length, timing, the opening. Say plainly when you cannot tell, because a confident story about noise is the main way creators learn the wrong lesson. Distinguish a real move from ordinary variance — with small numbers most differences are noise and you should say so rather than narrating them. Then the useful part: what the pattern ACROSS several runs suggests I should do more of, and what I keep doing that has never once worked. Flag anything that looks like a reporting change rather than a real change. Save this run\'s figures for next time.',
      category: 'creator', gear: ['cabinet', 'notebook'], skills: [], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'idea-harvest', name: 'Idea Harvest', emoji: '◈', tagline: 'The half-thoughts you already had',
      accent: '#6fbcc0',
      blurb: 'Sweeps your notes and messages for ideas you started and abandoned, then ranks them into a real queue.',
      tags: { general: 1 },
      params: [{ key: 'where', label: 'Where to look', type: 'folder', placeholder: 'your notes folder — I will also read connected channels if you have them' }],
      task: 'Harvest ideas out of {where}, and from my connected channels if any are reachable. I am after the things I already thought of and lost: a note that stops mid-sentence, a point made in passing in a message and never developed, a question I wrote down, a strong opinion stated once and dropped, and recurring complaints — the thing I keep grumbling about is usually the thing I should make. For each: what the idea appears to be, where it came from, and how developed it already is, because an idea with three paragraphs behind it is a completely different proposition from one line. Rank by how much of the work is already done times how well it fits what my audience keeps asking about. Cluster anything that is really the same idea recurring — a thought I have had four times is not four ideas, it is one thing I clearly need to make, and noticing that is the most valuable thing here. Compare against your memory so the same suggestions are not offered every week. Then develop the top one into a real outline.',
      category: 'creator', gear: ['cabinet', 'notebook', 'connector'], skills: ['creative-ideation'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'hook-from-archive', name: 'Hooks From What Worked', emoji: '⌁', tagline: 'Openings built from your own hits',
      accent: '#7bc88a',
      blurb: 'Learns what your best-performing openings had in common, then writes new ones to that pattern.',
      tags: { general: 1 },
      params: [
        { key: 'archive', label: 'Your archive', type: 'folder', placeholder: 'your published work — with stats if you have them' },
        { key: 'topic', label: 'What you are making now', placeholder: 'the piece that needs an opening' }
      ],
      task: 'Write openings for {topic}, learned from {archive}. First do the part that makes this worth more than asking for hooks cold: read my actual openings, and where the archive carries performance data, work out what my BEST ones have structurally in common. Do they open on a claim, a scene, a number, a question, a confession? How long before the point arrives? What did the weak ones do instead? State that pattern explicitly so I can judge whether you found it or are pattern-matching on noise, and say how much data it rests on. Then write six openings for the new piece to that pattern, marking which of my own past openings each is echoing. Vary them: several safely on-pattern, one or two deliberately off it, because a creator who only repeats their own hits stops growing. For each, one line on what it promises the reader — an opening that promises something the piece does not deliver is the most expensive kind of good hook. Do not reach for a stock formula I have never used; the point is my voice, not a template.',
      category: 'creator', gear: ['cabinet'], skills: ['short-form-script'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'series-gaps', name: 'Coverage Gaps', emoji: '◫', tagline: 'The obvious thing you never covered',
      accent: '#88b6c4',
      blurb: 'Maps what you have published against what your subject actually contains, and names the holes.',
      tags: { research: 0.5, general: 0.5 },
      params: [
        { key: 'archive', label: 'Your archive', type: 'folder', placeholder: 'the folder holding your published work' },
        { key: 'subject', label: 'Your subject', placeholder: 'the area you cover', required: false, default: 'whatever the archive shows you cover' }
      ],
      task: 'Map what {archive} already covers against what {subject} actually contains, and find the holes. Go and see what the field genuinely includes — what practitioners discuss, what beginners get stuck on, what the standard progression through this subject looks like — then compare it honestly against my archive. Three kinds of gap matter: the foundational thing I skipped because it felt too obvious to me (the most common and the most valuable, because my audience is not me), the topic I keep referencing as if I had covered it and never did, and the natural next step from something that did well. Rank by how many of my existing pieces would link to it, since a gap in the middle of a map is worth more than one at the edge. Be honest about which gaps are deliberate and fine to leave. For the top one, draft the outline and name which existing pieces should point at it. Save the map so later runs measure against it.',
      category: 'creator', gear: ['dish', 'cabinet', 'notebook'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'comment-triage', name: 'Comment Triage', emoji: '⊟', tagline: 'The replies actually worth your time',
      accent: '#6fa8bf',
      blurb: 'Reads your real comment stream and sorts it into what deserves a reply, what needs a fix, and what to ignore.',
      tags: { general: 1 },
      params: [{ key: 'where', label: 'Where to read', placeholder: 'leave blank to read your connected channels — or paste the comments', required: false, default: 'the recent comments on my connected channels' }],
      task: 'Triage {where}. Sort into: deserves a real reply (a genuine question, a thoughtful disagreement, someone who clearly engaged properly), needs a FIX rather than a reply (they found a mistake, a broken link, or something genuinely unclear — this pile is the most valuable and the easiest to lose inside a wall of praise), worth acknowledging briefly, and ignore. For the ignore pile, say what it is — noise, bait, or someone having a bad day — without editorializing. For each reply-worthy one, draft the core of the response in a sentence or two so answering takes seconds. Flag anything suggesting a piece is being widely misread, because that is a signal about the piece rather than about the commenters. Flag anything abusive or targeting me personally SEPARATELY and draft no reply to it — those get a decision from me, not a fast response. Do not post anything. Compare against your memory so a recurring complaint gets marked as recurring.',
      category: 'creator', gear: ['connector', 'notebook'], skills: ['inbox-triage'], cadence: 'morning',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'publish-checklist', name: 'Pre-Publish Check', emoji: '⊜', tagline: 'The last look before it is public',
      accent: '#9fc0c4',
      blurb: 'Checks a finished piece against the live web and against your own archive before it goes out.',
      tags: { research: 0.5, general: 0.5 },
      params: [{ key: 'piece', label: 'The piece', type: 'file', placeholder: 'the finished draft, ready to go out' }],
      task: 'Check {piece} before it goes public. This is the pass that needs tools rather than taste, so do the checkable things properly. Verify every link resolves and points where the text says it does. Check every factual claim, name, number, date and version against the live web, and flag anything you cannot confirm rather than letting it through. Check it against my own archive: does it contradict something I have already published — either this is a correction and should say so, or one of them is wrong — and does it repeat something I have covered without adding anything. Then the things that embarrass people: a placeholder left in, a name spelled two ways, a broken internal cross-mention, an unresolved note to self, a number in the text disagreeing with a number in a chart. Then one honest read on whether the opening earns the piece and whether the ending lands or merely stops. Give me a go / fix-first verdict, with blocking items listed separately from nice-to-haves.',
      category: 'creator', gear: ['dish', 'cabinet'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'promise-vs-delivery', name: 'Promise vs Delivery', emoji: '⊗', tagline: 'Does the piece do what the title says',
      accent: '#cf8a7d',
      blurb: 'Reads your titles against your actual content and finds where you over-promised — the quiet source of churn.',
      tags: { general: 1 },
      params: [{ key: 'archive', label: 'Your archive', type: 'folder', placeholder: 'the folder holding your published work' }],
      task: 'Go through {archive} and check every title and opening against what the piece actually delivers. Over-promising is the most damaging habit in publishing and the hardest to see in your own work, because the author knows what they meant. For each piece: what the title promises a reader will get, what the piece actually provides, and the gap. Sort by how badly a reader would feel misled — "less comprehensive than implied" is minor, "the titular question is never answered" is severe. Where a piece UNDER-promises, say so too: a strong piece behind a vague title is a fixable waste, and there are usually more of those than anyone expects. Where the archive carries engagement data, check whether the over-promising pieces show the pattern you would predict — people arriving and leaving quickly. For the worst offenders, give me either a truer title or the paragraph the piece needs to actually keep its promise, and say which of those two is the honest fix. Save the audit so later runs only re-check what changed.',
      category: 'creator', gear: ['cabinet', 'notebook'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'posting-rhythm', name: 'Posting Rhythm', emoji: '◱', tagline: 'A schedule built from what you can sustain',
      accent: '#d9a85a',
      blurb: 'Reads your real publishing history to find the cadence you actually hold, not the one you intended.',
      tags: { general: 1 },
      params: [
        { key: 'archive', label: 'Your archive', type: 'folder', placeholder: 'your published work, with dates' },
        { key: 'capacity', label: 'What you can give it', placeholder: 'e.g. one evening a week', required: false, default: 'whatever the history shows you have actually sustained' }
      ],
      task: 'Read the publishing dates across {archive} and tell me the rhythm I ACTUALLY hold, against {capacity}. Everyone plans a cadence they cannot sustain and then feels bad about it; the history says what is genuinely sustainable, and that is the only honest basis for a schedule. Report my real median gap between pieces, how much it varies, the longest gaps and whether anything in the work suggests why, and whether the rhythm is improving or decaying over time. Check whether pieces made under time pressure are visibly worse — if they are not, I can safely go faster, and if they are, that settles the frequency argument on evidence rather than opinion. Then propose a cadence I have demonstrably sustained rather than an aspirational one, plus the smaller format that keeps things alive during the gaps. Say plainly if the honest answer is that I should publish LESS and better. Include what to do about a missed slot, because the recovery matters more than the plan. Save the analysis for comparison.',
      category: 'creator', gear: ['cabinet', 'notebook'], skills: ['content-calendar'], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
