/* AGENT OS — recipe-catalog/data.js : DATA persona recipes — spreadsheets, tables and what they say.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogData` global in the browser, module.exports under node.
   NO logic here — pure data.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE DATA LINE (this module's extra bar — it is the whole reason these recipes are worth a tap) ══
   Every directive here must REFUSE TO SILENTLY GUESS. A row that cannot be parsed, a join that does
   not match, a date whose format is ambiguous, a number that might be a thousands separator — each
   gets surfaced as an explicit unresolved list, never quietly coerced into something that makes the
   output look complete. A clean-looking table with three silently mangled rows is worse than a messy
   one, because the mangling is now invisible and downstream everything inherits it. This is the same
   truthful-telemetry law the product runs on, applied to the Commander's own data.

   Note on tags: these lean `code` because that is what the app's own classifier assigns a directive
   about columns, files and parsing — and it is the honest lane, since this work wants an agent with a
   real toolchain at its desk. Tag honesty is locked by test/recipes.test.js.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogData = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'sheet-clean', name: 'Clean a Spreadsheet', emoji: '▩', tagline: 'Messy export into something usable',
      accent: '#7bc88a',
      blurb: 'Fixes the types, dates and stray text — and lists every row it refused to guess at.',
      tags: { code: 0.7, general: 0.3 },
      params: [
        { key: 'file', label: 'The file', type: 'file', placeholder: 'the .csv / spreadsheet to clean' },
        { key: 'intent', label: 'What you need it for', placeholder: 'what you plan to do with it', required: false, default: 'general analysis — make it correct and consistent' }
      ],
      task: 'Clean up {file} so it is usable for {intent}. Work through the usual damage: header rows that are not the first row, merged cells, numbers stored as text with currency symbols or thousands separators, dates in more than one format in the same column, trailing spaces, inconsistent capitalisation in what should be one category, blank rows used as visual spacing, and totals rows sitting inside the data. Fix what is unambiguous. Then the part that actually matters: anything you CANNOT resolve with confidence goes into an explicit UNRESOLVED list with the row, the value, and what the two possible readings are — never pick one to make the output look complete, because a silently mis-parsed date is invisible from here on and everything downstream inherits it. Pay particular attention to dates that could be day-first or month-first, since both readings are valid and the choice is unrecoverable later. Report what you changed by category with counts, so I can sanity-check the scale of each fix. Deliver the cleaned file plus the unresolved list as a separate file.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: ['file-curation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'data-explain', name: 'Explain This Data', emoji: '◍', tagline: 'What is actually in here',
      accent: '#6fa8bf',
      blurb: 'Reads an unfamiliar dataset and tells you what it holds, what is broken, and what it can answer.',
      tags: { code: 0.6, general: 0.4 },
      params: [{ key: 'file', label: 'The data', type: 'file', placeholder: 'the dataset to look at' }],
      task: 'Read {file} and tell me what I am actually looking at. Start with the shape: how many rows, what each row REPRESENTS in plain language (this is the single most important sentence and it is usually not stated anywhere), and what each column means including the ones whose names are abbreviations. For each column: its type, its range or its distinct values if there are few, how much is missing, and whether the missing values look random or systematic — systematically missing data usually means something specific happened, and it changes what the dataset can honestly be used for. Then flag what would trip me up: columns that look numeric but are categories, a date range with an unexplained gap, values that are clearly placeholders, duplicated rows, and any column whose meaning changes partway through. Finish with the honest capability read: the questions this data can answer well, the ones it can only answer with caveats, and the ones it cannot answer at all despite looking like it should. Do not compute a single summary statistic before you have said what a row is.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'chart-it', name: 'Chart It', emoji: '▧', tagline: 'The right chart, honestly scaled',
      accent: '#b790c0',
      blurb: 'Picks the chart that fits the question and builds it — no truncated axes, no invented precision.',
      tags: { code: 0.6, general: 0.4 },
      params: [
        { key: 'data', label: 'The data', type: 'file', placeholder: 'the file to chart' },
        { key: 'question', label: 'What you want to show', placeholder: 'the point the chart should make', required: false, default: 'whatever the data most clearly shows' }
      ],
      task: 'Chart {data} to show {question}. Choose the form from the question rather than from habit: comparison across categories wants bars, change over time wants a line, relationship between two measures wants a scatter, and parts of a whole almost never wants a pie. Say why you chose it and what you rejected. Then build it honestly — a value axis that starts at zero for bars unless there is a stated reason not to, no dual axes contrived to make two series appear related, no smoothing that hides the variation, and categories ordered by value rather than alphabetically unless the order carries meaning. Label the axes with units, and put the number of observations somewhere visible so the reader can judge how much weight to give it. Then tell me what the chart actually supports saying and — importantly — what it does NOT support, because the most common failure here is a chart that implies a cause when it shows a correlation. If the data is too thin or too noisy for the chart to be honest, say so and propose what would be needed. Deliver the chart as a file plus a one-line caption stating the finding.',
      category: 'data', gear: ['cabinet', 'workbench', 'studio'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'reconcile-lists', name: 'Reconcile Two Lists', emoji: '⊠', tagline: 'What matched, what did not, and why',
      accent: '#cf8a7d',
      blurb: 'Joins two messy lists and reports every unmatched row rather than dropping it quietly.',
      tags: { code: 0.7, general: 0.3 },
      params: [
        { key: 'listA', label: 'First list', type: 'file', placeholder: 'the first file' },
        { key: 'listB', label: 'Second list', type: 'file', placeholder: 'the file to reconcile it against' }
      ],
      task: 'Reconcile {listA} against {listB}. First tell me what you are matching ON and why, and whether that identifier is actually reliable in both — most reconciliations fail because the join key is a name typed by two different people. Match exactly first, then attempt near-matches for the remainder (spacing, casing, punctuation, obvious spelling variants, a name in two orders) and present those as PROPOSED matches for me to approve rather than applying them, because a wrong auto-match is far more damaging than an unmatched row and is much harder to spot afterwards. Then report four groups with counts and rows: matched and identical, matched but with differing values (say exactly which fields differ — this group is usually the interesting one), present only in the first, present only in the second. Nothing may be silently dropped; every input row must appear in exactly one group and the totals must add up. Where values differ, do not decide which side is right — show both and say which looks more reliable and why. Deliver the four groups as a file I can work through.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'extract-table', name: 'Extract to a Table', emoji: '▥', tagline: 'Documents into rows and columns',
      accent: '#88b6c4',
      blurb: 'Pulls structured rows out of unstructured documents — with a confidence mark on every field.',
      tags: { code: 0.6, general: 0.4 },
      params: [
        { key: 'documents', label: 'The documents', type: 'folder', placeholder: 'the folder of files to extract from' },
        { key: 'fields', label: 'Fields to pull', placeholder: 'e.g. date, supplier, amount, reference' }
      ],
      task: 'Extract {fields} from every document in {documents} into one table. One row per document, plus a column recording which file each row came from so anything can be traced back. Take values as they appear rather than normalising them into a tidier form that loses information — put the normalisation in a second column beside the original where it helps. For every field, mark whether the value was found plainly stated, inferred from context, or not found. Never leave a cell filled with a plausible value that was actually inferred without saying so, and never fill a gap with a value taken from a different document; an extraction that looks complete but is a quarter guessed is the failure mode that makes this whole job untrustworthy. List separately any document you could not read at all and why. Where a document contains several candidates for one field, say so rather than picking the first. Report the counts — documents processed, fields found plainly, inferred, missing — then deliver the table as a file.',
      category: 'data', gear: ['cabinet'], skills: ['pdf-document-extraction', 'file-curation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'group-summary', name: 'Summarize by Group', emoji: '◨', tagline: 'The pivot, with the traps flagged',
      accent: '#d9a85a',
      blurb: 'Aggregates the way you meant, then warns you where the average is lying.',
      tags: { code: 0.6, general: 0.4 },
      params: [
        { key: 'data', label: 'The data', type: 'file', placeholder: 'the file to summarize' },
        { key: 'grouping', label: 'Group by', placeholder: 'e.g. by month and region, totalling revenue' }
      ],
      task: 'Summarize {data} {grouping}. Before aggregating, state how you are handling the decisions that quietly change the answer: what happens to rows with a missing group value (they must appear as their own group, never be dropped), whether the categories are being matched case-sensitively, and how partial periods at either end are treated. Then give me the table — but alongside the total or average for each group, include the COUNT, because a group of three behaves nothing like a group of three hundred and an average shown without its count is the most common way a summary misleads. Flag where the mean is a poor summary because the distribution is skewed or has extreme values, and show the median there instead. Call out any group that is unusually small, any that appeared or vanished between periods, and any category that looks like it should be merged with another (the same thing spelled two ways). Finish with the two or three things this summary actually shows, and one line on what it cannot show. Deliver the table as a file.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'dedupe-merge', name: 'Dedupe & Merge', emoji: '⊚', tagline: 'One record per real thing',
      accent: '#6fbcc0',
      blurb: 'Finds the duplicates that are not identical, and proposes the merge rather than performing it.',
      tags: { code: 0.7, general: 0.3 },
      params: [
        { key: 'file', label: 'The list', type: 'file', placeholder: 'the file with duplicates' },
        { key: 'entity', label: 'What a row is', placeholder: 'e.g. a customer, a product', required: false, default: 'whatever the rows appear to represent' }
      ],
      task: 'Find and resolve duplicates in {file}, where a row is {entity}. Exact duplicates are the easy part — the real work is the near-duplicates: the same thing with a typo, an abbreviation, a different name order, an old address, a trailing space, or one record holding a detail the other lacks. Group candidates and give each group a confidence, and PROPOSE the merges rather than applying them, because a wrong merge destroys two records at once and is usually unrecoverable. For each group show the rows side by side so I can see what would be combined. For merges I approve, say which value wins each field and WHY — most complete, most recent, most consistent with the rest — never silently take the first row. Where two records disagree on something that should be unique and stable, that is a flag rather than a merge: it may be two genuinely different things. Report the counts before and after, and list the groups you were unsure about separately so they get a human decision. Deliver the proposals as a file.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'data-quality', name: 'Data Quality Check', emoji: '⚠', tagline: 'What is wrong before you trust it',
      accent: '#cf8a7d',
      blurb: 'Audits a dataset for the errors that survive a glance — and ranks them by what they would break.',
      tags: { code: 0.6, general: 0.4 },
      params: [{ key: 'file', label: 'The dataset', type: 'file', placeholder: 'the file to audit' }],
      task: 'Audit {file} for quality problems before I rely on it. Go looking in the places errors actually hide: values outside any plausible range, negative quantities where none should exist, dates in the future or before the thing existed, identifiers that should be unique and are not, categories with a long tail of near-identical variants, a column whose format changes partway through the file (usually where two exports were joined), rows that are perfect duplicates, and totals that do not reconcile with their components. Check the boring structural things too — encoding damage in text, truncated fields sitting exactly at a round length, numbers that lost their leading zeros. For each finding: what it is, how many rows, an example, the likely cause, and what it would BREAK if I used this data as it is — that last part is what makes this actionable rather than a list of complaints. Rank by consequence, not by count. End with a plain verdict: safe to use, use with these caveats, or fix before using. Where you found nothing wrong in a category, say so explicitly rather than staying silent.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: ['adversarial-review-pass'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'metric-define', name: 'Define the Metric', emoji: '◎', tagline: 'Pin it down before anyone argues',
      accent: '#9fc0c4',
      blurb: 'Turns a vague measure into a definition two people would compute identically.',
      tags: { general: 0.6, code: 0.4 },
      params: [
        { key: 'metric', label: 'The metric', placeholder: 'e.g. active users, churn, on-time delivery' },
        { key: 'context', label: 'Your situation', placeholder: 'what you do and why you are measuring it', required: false, default: 'what you have already told me about the work' }
      ],
      task: 'Pin down a precise definition of {metric} for {context}. FIRST go and look at the actual data behind it — count the rows the definition would include under each reading of the ambiguous cases, and report where the readings DIVERGE. A definition argued in the abstract sounds settled and then produces two different numbers in practice; running it against the real rows is what turns an opinion into a decision, and it is the half of this job a chat box cannot do. Write it so that two people computing it independently would get the same number — that is the entire test, and almost every disputed metric in an organization fails it. Be explicit about every decision the vague version leaves open: exactly who or what is included and excluded, the time window and whether it is a snapshot or a period, how the boundary cases are handled, what happens to things that appear partway through, and which system of record wins when two disagree. Then interrogate the metric itself: what behaviour does it reward if people optimize for it, and what is the obvious way to make the number look better without improving anything real — every metric has one and naming it early is cheap. Say what this measure genuinely tells us and what it is routinely mistaken for. If a simpler or more honest measure would serve the actual purpose better, argue for it. Finish with the exact wording to put in a document, plus the two or three questions to settle with whoever else uses this number before anyone reports it.',
      category: 'data', gear: ['cabinet', 'workbench', 'notebook'], skills: ['decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'recurring-report', name: 'Recurring Report', emoji: '◐', tagline: 'The same numbers, every period',
      accent: '#6fa8bf',
      blurb: 'A standing report that computes the same way each run and leads with what changed.',
      tags: { code: 0.6, general: 0.4 },
      params: [
        { key: 'source', label: 'Where the data lives', type: 'file', placeholder: 'the file / export to read each time' },
        { key: 'measures', label: 'What to report', placeholder: 'the numbers that matter', required: false, default: 'the measures you have reported before' }
      ],
      task: 'Produce my recurring report from {source} covering {measures}. Compute it exactly the way you did last time — read your memory for the definitions you used and reuse them, because a report whose definitions drift between runs makes every comparison in it meaningless and the drift is invisible. If the incoming data has changed shape since the last run, say so prominently rather than adapting quietly. Lead with what CHANGED versus the previous period and the one before that, since the level matters less than the direction and a single period cannot show a direction. For each notable move, go and find the specific cause in the underlying rows rather than restating the percentage — the cause is the entire value of a report over a dashboard. Keep a short constant section of the same core numbers every time so I build a feel for them. Flag anything that looks like a data problem rather than a real change; that distinction is the most common false alarm here. If nothing moved meaningfully, say so in two lines and stop. Save this run\'s numbers and definitions for the next comparison.',
      category: 'data', gear: ['cabinet', 'notebook', 'workbench'], skills: ['digest-composer'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'survey-analyze', name: 'Analyze Open Responses', emoji: '◖', tagline: 'Free text into themes that hold up',
      accent: '#b790c0',
      blurb: 'Clusters open-ended answers into real themes, counted, with the quotes that carry each one.',
      tags: { general: 0.6, code: 0.4 },
      params: [
        { key: 'responses', label: 'The responses', type: 'file', placeholder: 'the survey export / feedback file' },
        { key: 'question', label: 'What was asked', placeholder: 'the question they were answering', required: false, default: 'whatever the file indicates was asked' }
      ],
      task: 'Analyze the open-ended responses in {responses} to {question}. Build themes from what people actually said rather than from categories you expected — read everything before deciding on any theme, or the first twenty answers will set a frame the rest gets forced into. For each theme: how many responses, a plain description, and two or three verbatim quotes that carry it, chosen because they state it clearly rather than because they are the most extreme. Report the counts honestly, including the responses that fit no theme and the ones too vague to code; a tidy set of five themes covering ninety-five percent of answers is usually a sign of over-fitting, not good analysis. Then the things people miss: what is notably ABSENT given what was asked, where two themes are in genuine tension with each other, and whether any theme is concentrated in one group of respondents rather than spread across them. Separate what people said from what you infer they meant, and mark the second as inference. Finish with the two findings that would actually change a decision, and one line on how much confidence the sample size supports.',
      category: 'data', gear: ['cabinet'], skills: ['digest-composer'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'trend-arithmetic', name: 'Project a Trend', emoji: '◗', tagline: 'Where this goes, with the error bars',
      accent: '#d9a85a',
      blurb: 'Extends a series honestly — showing the range, the assumptions, and where projection stops being valid.',
      tags: { general: 0.6, code: 0.4 },
      params: [
        { key: 'series', label: 'The series', type: 'file', placeholder: 'the historical numbers over time' },
        { key: 'horizon', label: 'How far ahead', placeholder: 'e.g. the next 6 months', required: false, default: 'a horizon the data can actually support' }
      ],
      task: 'Project {series} forward over {horizon}. First characterize what the history actually does — the underlying direction, any repeating seasonal shape, how noisy it is period to period, and whether its behaviour changed at some point (a series with a structural break must not be projected from the whole history, and finding that break is often the most useful thing in this exercise). Then project, and give me a RANGE rather than a single line, because a single number implies a precision this cannot have. State every assumption the projection rests on, especially the big implicit one: that the conditions producing this history continue. Say plainly how far out the projection stays meaningful and where it becomes arithmetic with no informational content — extending a short noisy series a long way is a spreadsheet exercise, not a forecast, and I would rather be told that. Name the two or three things that would break the projection, and what early indicator would show one happening. If the history is too short, too noisy, or too broken to project at all, say that instead of producing a number. This is arithmetic on my data, not advice about what to do with the result.',
      category: 'data', gear: ['cabinet', 'workbench'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
