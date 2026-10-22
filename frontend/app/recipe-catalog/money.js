/* AGENT OS — recipe-catalog/money.js : MONEY persona recipes — the money admin a person actually has.

   Registered in index.js by the aggregator — this file only EXPORTS the array. Same UMD-light module
   pattern as its siblings: a `RecipeCatalogMoney` global in the browser, module.exports under node.
   NO logic here — pure data.

   Content contract: every record clears THE RECIPE BAR documented in core.js (earns its tap / drives
   the station / lands somewhere / compounds when recurring), in the same imperative harness voice.

   ══ THE MONEY LINE (this module's extra bar — do not cross it) ══
   These recipes do money ADMIN — sorting what was spent, assembling what an accountant needs, doing the
   arithmetic on a payoff order, finding a charge you stopped noticing. They never recommend a security to
   buy or sell, never size a position, and never tell the Commander what to do with savings. Where a
   directive touches investing at all it GATHERS AND EXPLAINS, and says plainly that the call is the
   Commander's and a licensed advisor's — that is not a disclaimer bolted on, it is what the recipe does.
   A recipe that would only be useful as advice does not ship here.

   Schema v2:
   { id, name, emoji, tagline, blurb, accent, tags, params, task, category, gear, skills, cadence, source, forkedFrom } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.RecipeCatalogMoney = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECIPES = [
    {
      id: 'budget-build', name: 'Build a Budget', emoji: '◧', tagline: 'A budget from real numbers, not vibes',
      accent: '#7bc88a',
      blurb: 'Reads your actual statements, finds what you really spend, and sets targets you have a chance of hitting.',
      tags: { general: 1 },
      intake: [
        { dimension: 'constraints', question: 'What should the budget optimize for?', options: ['free up cash fast', 'a sustainable steady plan'], recommended: 'a sustainable steady plan', reason: 'decides whether targets are aggressive or livable' }
      ],
      params: [
        { key: 'statements', label: 'Statements', type: 'file', placeholder: 'a bank/card export — or paste a few months of transactions' },
        { key: 'income', label: 'Monthly take-home', placeholder: 'e.g. 4200 after tax', required: false, default: 'the income you can see in the statements' }
      ],
      task: 'Build me a budget from {statements}, against take-home of {income}. Work from what I ACTUALLY spent over the whole period, not one unlucky month — pull the real average per category and show the range, because a category that swings wildly needs a different plan than one that is steady. Separate fixed commitments from things I choose each time; only the second kind is really adjustable. Set targets I have a genuine chance of hitting: a target that requires me to become a different person is a target I will abandon in three weeks, so say when a number is unrealistic instead of writing it down. End with the one or two changes that free up the most money for the least pain, in order, and what the month looks like if I make them. Offer to save the budget so we can compare next month against it.',
      category: 'money', gear: ['cabinet', 'notebook'], skills: ['ledger-upkeep'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'spend-audit', name: 'Spending Audit', emoji: '⊠', tagline: 'Where the money actually went',
      accent: '#cf8a7d',
      blurb: 'Sorts real transactions into where the money went — and names the gap between that and where you think it went.',
      tags: { general: 1 },
      params: [
        { key: 'statements', label: 'Transactions', type: 'file', placeholder: 'a statement export — or paste the transactions' },
        { key: 'period', label: 'Period', required: false, type: 'choice', default: 'the last 3 months',
          options: ['the last month', 'the last 3 months', 'the last 6 months', 'the last year'] }
      ],
      task: 'Audit my spending across {period} from {statements}. Sort every transaction into plain-English buckets a person would recognize, not accounting categories — and put anything you cannot confidently place in an UNSORTED pile rather than guessing it into a bucket, because a tidy chart built on guesses is worse than an honest gap. Then give me the part that stings: the three categories that are bigger than almost anyone would guess, the small recurring charges that add up to more than one obvious big one, and anything that changed sharply versus earlier in the period. Rank what I could change by money-freed against how much I would miss it. No lecture and no shame — I want the number and the choice, not a verdict on my character.',
      category: 'money', gear: ['cabinet'], skills: ['cost-audit'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'fee-hunt', name: 'Fee Hunt', emoji: '⌸', tagline: 'The charges you stopped noticing',
      accent: '#d9a85a',
      blurb: 'Hunts the quiet leaks — duplicate charges, crept-up prices, fees with a real cancellation path.',
      tags: { general: 1 },
      params: [{ key: 'statements', label: 'Statements', type: 'file', placeholder: 'a statement export — or paste the charges' }],
      task: 'Hunt the quiet money leaks in {statements}. I am looking for four things: charges I am paying twice (the same service under two names, or overlapping tools that do one job), prices that crept up without me agreeing to anything, fees that exist only because of how an account is set up rather than anything I get, and anything still billing for something I stopped using. For each one give me the monthly and annual number — annual is the one that actually lands — plus exactly how to stop it and what I lose if I do. Sort by annual amount. Be honest when a charge is fair value rather than padding the list: a hunt that flags everything is one I will stop trusting.',
      category: 'money', gear: ['cabinet', 'notebook'], skills: ['cost-audit'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'bill-negotiate', name: 'Negotiate a Bill', emoji: '⊝', tagline: 'Leverage, and the words to say',
      accent: '#7bc88a',
      blurb: 'Finds what competitors charge, then hands you the call plan — opening line, fallback, and when to walk.',
      tags: { general: 0.6, research: 0.4 },
      params: [
        { key: 'bill', label: 'The bill', placeholder: 'e.g. internet, insurance, phone — and what you pay now' },
        { key: 'history', label: 'Your history', placeholder: 'how long a customer, any outages / claims', required: false, default: 'whatever you can tell me when I ask' }
      ],
      task: 'Prepare me to negotiate {bill} down, given {history}. First find what this provider actually charges NEW customers right now and what the nearest rivals charge for the same tier — that gap is my entire leverage and I need the real current numbers, with links. Then give me a plan for the call: the opening ask, the number I should actually expect to land, the exact phrase that gets me to the retentions desk instead of a front-line agent who cannot approve anything, what to say when they offer a worse deal dressed as a favor, and the point where walking away is the better move. Include what to check in the fine print before I agree — a lower monthly figure hiding a longer lock-in is a loss. Do not contact anyone; the call is mine to make.',
      category: 'money', gear: ['dish'], skills: ['web-research'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'big-purchase', name: 'Big Purchase Call', emoji: '⌾', tagline: 'Decide it, stop browsing it',
      accent: '#d9a85a',
      blurb: 'Turns an endless comparison into a decision — real options, real trade-offs, and a recommendation.',
      tags: { general: 0.6, research: 0.4 },
      intake: [
        { dimension: 'deliverable', question: 'How should this land?', options: ['one recommendation', 'a ranked shortlist'], recommended: 'one recommendation', reason: 'a shortlist is where a decision goes to die' }
      ],
      params: [
        { key: 'item', label: 'What you are buying', placeholder: 'e.g. a used car under 15k, a laptop for video work' },
        { key: 'matters', label: 'What matters', placeholder: 'e.g. reliability over features, must last 5 years', required: false, default: 'value that holds up over time' }
      ],
      task: 'Help me decide on {item}, optimizing for {matters}. Go find what is actually available right now at real prices, not list prices from a year ago. Cut the field to three genuine contenders and kill the rest in one line each so I know they were considered. For the three: what each is genuinely best at, the specific way each one disappoints people six months in (find the long-term owner reports, not launch reviews), and the total cost including the things sellers leave out — accessories, servicing, insurance, the upgrade I will be pushed into. Then land on ONE recommendation and say what would have to be true for me to pick differently. Flag anything time-sensitive, but never manufacture urgency — if waiting is smarter, say so. Do not buy anything.',
      category: 'money', gear: ['dish'], skills: ['web-research', 'decision-1-3-1'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'invoice-chase', name: 'Chase Invoices', emoji: '▥', tagline: 'Who owes you, and the nudge',
      accent: '#cf8a7d',
      blurb: 'Tracks what is outstanding and how late, then drafts the escalating nudge each one has earned.',
      tags: { general: 1 },
      params: [{ key: 'invoices', label: 'Invoices', type: 'file', placeholder: 'your invoice list / export — or paste who owes what' }],
      task: 'Go through {invoices} and tell me who owes me money. For each outstanding one: the amount, how many days past the agreed terms, and what I already sent them — check your memory for what we sent last time and when, so a second nudge never reads like the first. Sort by amount-times-lateness, because that is the real order to spend my energy in, not strict age. Then draft the message each one has earned: a light nudge for barely-late, something firmer for a repeat drifter, and for anything badly overdue a clear note stating the amount, the original terms, and a specific date — polite and completely unambiguous, never apologetic. I am asking for money I am owed and the draft should read that way. Do not send anything. Record what you drafted so the next run escalates instead of repeating.',
      category: 'money', gear: ['cabinet', 'notebook'], skills: ['ledger-upkeep'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'receipt-ledger', name: 'Receipt Ledger', emoji: '▣', tagline: 'Receipts into a ledger you can file',
      accent: '#9fc0c4',
      blurb: 'Turns a folder of receipts into a clean categorized ledger — with the unreadable ones flagged, not guessed.',
      tags: { general: 1 },
      params: [
        { key: 'receipts', label: 'Receipts', type: 'folder', placeholder: 'the folder of receipts / exports' },
        { key: 'scheme', label: 'Categories', placeholder: 'your category scheme', required: false, default: 'standard expense categories for a small business' }
      ],
      task: 'Turn the receipts in {receipts} into one clean ledger using {scheme}. For each: date, vendor, amount, currency, tax component where it is shown, category, and which file it came from so every row traces back to the original receipt. Where a receipt is unreadable, ambiguous, or missing the amount, put it in a FLAGGED section with what you could and could not read — never invent a value to make the table look complete, because a ledger with one silently guessed row is a ledger I cannot file. Call out duplicates (the same purchase captured twice), anything that looks personal rather than business, and any total that does not add up. Deliver it as a file I can hand to an accountant or import, plus a one-paragraph summary of totals by category.',
      category: 'money', gear: ['cabinet'], skills: ['file-curation', 'ledger-upkeep'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'tax-prep-pack', name: 'Tax Prep Pack', emoji: '◪', tagline: 'Assemble the folder before the deadline',
      accent: '#88b6c4',
      blurb: 'Assembles what your accountant will ask for, names what is missing, and lists the questions worth asking.',
      tags: { general: 1 },
      params: [
        { key: 'folder', label: 'Your records', type: 'folder', placeholder: 'the folder with statements, invoices, receipts' },
        { key: 'situation', label: 'Your situation', placeholder: 'e.g. sole trader in the UK, one rental, some freelance', required: false, default: 'what you tell me when I ask' }
      ],
      task: 'Assemble a tax preparation pack from {folder} for someone whose situation is: {situation}. Sort what is there into the buckets a preparer actually asks for — income by where it came from, deductible costs by category, anything with an asset or a one-off event attached. Then the most valuable part: a MISSING list naming every document the situation implies should exist but is not in the folder, and where each one normally comes from. Add the questions worth asking a professional this year, each with the reason it matters for my specific situation, so I do not pay for an hour of being asked things I could have answered in advance. State clearly that this is preparation and organization, not tax advice, and that a qualified preparer signs off on what is actually owed. Deliver a summary file plus the sorted index.',
      category: 'money', gear: ['cabinet'], skills: ['file-curation'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'insurance-review', name: 'Insurance Review', emoji: '⊚', tagline: 'What you are covered for — and the gaps',
      accent: '#88b6c4',
      blurb: 'Reads the policy you never read, in plain language — what is covered, what is excluded, where you are exposed.',
      tags: { general: 0.7, research: 0.3 },
      params: [{ key: 'policy', label: 'The policy', type: 'file', placeholder: 'the policy document — or paste the summary' }],
      task: 'Read {policy} and tell me in plain language what I am actually covered for. Lead with the three things most people assume are covered under a policy like this and are not — the exclusions are the whole document, everything else is marketing. Then: the real limits and what happens when a claim exceeds them, the excess I pay before anything pays out, the conditions that void cover entirely (these are usually buried and mundane, like a notification window or a maintenance requirement), and the deadlines that apply when something actually goes wrong. Give me a short list of where I look exposed given what this policy covers, and the questions to put to the insurer in writing. Quote the exact clause behind each point so I can check you. Do not contact the insurer or change anything.',
      category: 'money', gear: ['cabinet', 'dish'], skills: ['pdf-document-extraction'], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'refund-recover', name: 'Refund Recovery', emoji: '◨', tagline: 'Money owed back, and how to claim it',
      accent: '#d9a85a',
      blurb: 'Finds the charges worth disputing, checks the deadlines, and drafts the claim that gets read.',
      tags: { general: 1 },
      params: [{ key: 'charges', label: 'The charges', placeholder: 'paste the disputed charges — or point me at the statement' }],
      task: 'Look at {charges} and find what I can plausibly get back. For each candidate: what the claim actually is (billed after cancelling, charged twice, service not delivered, price different from what was agreed, an automatic renewal with no notice), what evidence I would need, the realistic odds, and — critically — the deadline, because most of these die on a time limit nobody mentions. Sort by amount times likelihood, and tell me plainly which ones are not worth my hour. Then draft the claim for the top ones: the specific facts, the amount, the outcome I want, and a firm date — no throat-clearing, no apologizing for asking. Note where a card issuer or consumer body is the better route than the merchant, and how long that takes. Do not send or file anything; I act, you prepare.',
      category: 'money', gear: ['cabinet', 'dish'], skills: [], cadence: null,
      source: 'builtin', forkedFrom: null
    },
    {
      id: 'money-checkin', name: 'Money Check-In', emoji: '◕', tagline: 'The weekly look, against last week',
      accent: '#6fa8bf',
      blurb: 'A standing check that remembers last week — so it reports the delta and the drift, not a fresh pile of numbers.',
      tags: { general: 1 },
      params: [{ key: 'source', label: 'Where to look', type: 'file', placeholder: 'your statement export / ledger — or leave blank and I will ask', required: false, default: 'the statements and ledger you have shown me before' }],
      task: 'Run my weekly money check-in from {source}. Compare against the check-in in your memory from last week — the delta is the whole point, a fresh pile of totals every week teaches me nothing. Report: what came in and went out versus the same figure last week, any category that moved sharply and the transaction that caused it, anything new that has started recurring, and any commitment coming up that I should have cash ready for. Then one line on the direction of travel over the runs you have on record — drift is only visible across weeks and it is the thing I will otherwise miss. If nothing meaningful moved, say exactly that in two sentences and stop; a quiet week is a valid report and padding it out trains me to skim. Save this week so next week has something to compare against.',
      category: 'money', gear: ['cabinet', 'notebook'], skills: ['ledger-upkeep'], cadence: 'weekly',
      source: 'builtin', forkedFrom: null
    }
  ];

  return RECIPES;
});
