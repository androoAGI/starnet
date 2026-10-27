/* STARNET — memtruth.js : ONE similarity and ONE subject key for every memory writer (memory-truth-1027).
   Pure + testable (UMD: a `MemTruth` global in the browser, module.exports under node; the sidecar requires it as
   ../frontend/app/memtruth.js like study.js and classify.js).

   WHY ONE MODULE. Six hand-copied Jaccard functions decided "is this the same belief?" (memcore, reflect, notebook,
   failreview, mint-ledger, priorwork, study), each with its own stoplist and drift. And none of them could answer the
   question a memory writer actually has: is this a RESTATEMENT of a belief I hold (drop it), a CORRECTION of it (the
   old one must stop being active), or a DIFFERENT FACT that happens to share its shape (keep both)? Token overlap
   cannot tell those apart: "prefers dark mode" vs "prefers light mode" overlap as much as a paraphrase, and "the
   staging db is in frankfurt" vs "the production db is in frankfurt" overlap MORE than "prefers tabs" vs "prefers
   spaces". So a corrected preference was refused as a near-duplicate (f97e73fb) or saved beside the belief it
   corrected, both active.

   similarity(a, b, opts) is the one token-Jaccard (opts.stop / minLen / normalize / stem let a caller keep its own
   stoplist — mint-ledger and priorwork do). claimOf(text) reads a ONE-CLAIM belief into subject · relation · topic ·
   value · polarity, and subjectKey(text) is its key. relate(a, b) answers the writer's question:
     'dupe'      same subject, same claim                     -> nothing new to write
     'supersede' same subject, a different claim              -> the newer claim retires the older one
     'distinct'  a confidently DIFFERENT subject or topic     -> both are kept, no challenge
     'unknown'   no confident parse of either side            -> the caller keeps today's similarity paths
   Deliberately conservative: a key exists only when the subject AND the dimension being claimed are explicit (a
   preference's "for/in X" qualifier, an "X over Y" comparison, a value from a short list of mutually exclusive
   alternatives such as dark/light or tabs/spaces, a PLACE — a proper name or a region/city/country noun — for a location,
   or a NAME — capitalised, numbered, or "called X" — for a thing's single-valued attribute). A state ("is protected",
   "is slow"), a membership ("is in the design team") or a dwelling ("lives in a flat") has no key, and neither do two
   different things a length is about ("concise replies" vs "detailed reports"). Anything else is 'unknown' and falls
   back to the challenge path, because a wrong 'supersede' would retire a genuinely separate fact (the callers keep every
   supersession reversible: the old text and its provenance go into the surviving record's history). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MemTruth = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- similarity: the ONE token-Jaccard -------------------------------------------------------------------------
  const SIM_STOP_WORDS = 'a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they';
  const SIM_STOP = new Set(SIM_STOP_WORDS.split(/\s+/));
  const SIM_THRESHOLD = 0.6;   // the near-duplicate bar every memory writer shares

  function stopSet(stop) {
    if (stop instanceof Set) return stop;
    if (Array.isArray(stop)) return new Set(stop);
    if (stop && typeof stop === 'object') return new Set(Object.keys(stop).filter(k => stop[k]));
    return SIM_STOP;
  }
  // significant tokens: lowercase alnum runs of at least minLen (default 3) chars, stopwords dropped, then stemmed.
  // opts.normalize (string -> string) replaces the default lowercasing; opts.stem maps each kept token.
  function simTokens(s, opts) {
    const o = opts || {};
    const stop = stopSet(o.stop);
    const minLen = Number.isFinite(o.minLen) ? o.minLen : 3;
    const text = typeof o.normalize === 'function' ? String(o.normalize(s)) : String(s == null ? '' : s).toLowerCase();
    const set = new Set();
    for (const t of text.split(/[^a-z0-9]+/)) {
      if (t.length < minLen || stop.has(t)) continue;
      set.add(typeof o.stem === 'function' ? o.stem(t) : t);
    }
    return set;
  }
  // Jaccard overlap of the two token sets in [0,1]; two empty sets are NOT similar (0).
  function similarity(a, b, opts) {
    const A = simTokens(a, opts), B = simTokens(b, opts);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }
  const textOf = r => (r == null ? '' : typeof r === 'string' ? r : (r.content != null ? String(r.content) : ((r.title || '') + ' ' + (r.body || ''))));
  // first record whose text is >= threshold-similar to `text`, or null
  function findSimilar(records, text, opts) {
    const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : SIM_THRESHOLD;
    for (const r of (Array.isArray(records) ? records : [])) if (r && similarity(textOf(r), text, opts) >= threshold) return r;
    return null;
  }

  // ---- the subject key ---------------------------------------------------------------------------------------------
  const NEG = new Set(['not', 'never', 'no', 'nor']);
  // auxiliaries, adverbs and fillers that sit between a subject and its verb and carry no claim
  const AUX = new Set(['do', 'does', 'did', 'will', 'would', 'should', 'must', 'can', 'could', 'may', 'might', 'shall', 'really', 'strongly',
    'generally', 'also', 'still', 'now', 'always', 'usually', 'definitely', 'much', 'actually', 'currently', 'mostly', 'only']);
  const ARTICLE = new Set(['a', 'an', 'the', 'some', 'any']);
  const PERSON = new Set(['user', 'users', 'commander', 'i', 'we', 'me', 'my', 'our', 'us', 'owner']);
  // short forms that name the same thing (a subject or value must not turn "distinct" on an abbreviation)
  const SYN = { db: 'database', dbs: 'database', databases: 'database', repo: 'repository', repos: 'repository', prod: 'production', env: 'environment',
    envs: 'environment', config: 'configuration', configs: 'configuration', docs: 'documentation', app: 'application', apps: 'application', k8s: 'kubernetes' };
  /* relation words. pref = a choice between alternatives (one wins per dimension); like = a taste that may hold for
     several values at once, so it is keyed only inside an alternatives group; use = what a THING uses (several at
     once, keyed only inside a group), while the Commander's own "use X" is a pref; loc = where something is
     (single-valued); be = a copula (single-valued only for an attribute: "the default branch is main"). */
  const REL = {
    prefer: 'pref', prefers: 'pref', preferred: 'pref', want: 'pref', wants: 'pref', wanted: 'pref',
    like: 'like', likes: 'like', love: 'like', loves: 'like',
    dislike: 'like-', dislikes: 'like-', hate: 'like-', hates: 'like-', avoid: 'like-', avoids: 'like-',
    use: 'use', uses: 'use',
    lives: 'loc', live: 'loc', located: 'loc', resides: 'loc', reside: 'loc', sits: 'loc', hosted: 'loc', based: 'loc',
    is: 'be', are: 'be', was: 'be', were: 'be'
  };
  const PRONOUN = new Set(['it', 'this', 'that', 'these', 'those', 'them', 'one', 'ones', 'either', 'both']);
  const LOC_PREP = new Set(['in', 'at', 'on', 'inside']);
  const LOC_PART = new Set(['located', 'based', 'hosted', 'stored', 'deployed', 'running', 'kept', 'living']);
  /* WHICH "where" a location word claims: where something IS (geo), what HOSTS / runs it (host), where it is STORED
     (store). Three different questions: "hosted on AWS" never retires "located in Frankfurt". */
  const LOC_CLASS = { lives: 'geo', live: 'geo', located: 'geo', resides: 'geo', reside: 'geo', sits: 'geo', based: 'geo', living: 'geo',
    hosted: 'host', deployed: 'host', running: 'host', stored: 'store', kept: 'store' };
  // a location's value must read as a PLACE: a proper name / a number (checked against the original text) or one of these
  const PLACE_NOUN = new Set(['region', 'city', 'country', 'province', 'county', 'zone', 'datacenter', 'office', 'continent']);
  // "the default branch is CALLED main" / "is named" / "is set to": the value is explicitly a name
  const NAMING = new Set(['called', 'named']);
  // a qualifier names the DIMENSION a claim is about ("tabs FOR indentation", "dark mode IN the editor")
  const QUAL = new Set(['for', 'in', 'when', 'on', 'across', 'during', 'while', 'within', 'inside']);
  const CMP2 = [['instead', 'of'], ['rather', 'than']];
  const CMP1 = new Set(['over', 'than', 'vs', 'versus', 'not']);
  // standing framing the Commander opens an instruction with — stripped, never part of the claim
  const LEAD = [['from', 'now', 'on'], ['going', 'forward'], ['by', 'default'], ['in', 'the', 'future'], ['in', 'future'], ['remember', 'that'],
    ['note', 'that'], ['please'], ['remember'], ['actually'], ['also'], ['now'], ['so'], ['ok'], ['okay'], ['generally'], ['usually'], ['always'], ['never']];
  const FUTURE = /^for (?:all|every) (?:future )?(?:tasks?|chats?|conversations?|projects?|work)$/;
  /* Mutually exclusive ALTERNATIVES: a value from one of these lists is a claim about that dimension even without
     a qualifier ("prefers tabs" and "prefers spaces" are the same subject). Every word of the value must be one of
     the group's values, topic words or objects, and at least one a value — "a single file" never reads as a quote
     style. A qualifier made only of topic words just names the group ("tabs for indentation"). TOPIC words name the
     dimension itself ("dark MODE" = "a light THEME"); OBJECTS name the thing the value is about, and stay in the key
     (canonical form): "concise REPLIES" and "detailed REPORTS" are two different deliverables, never one subject. */
  const ALTERNATIVES = [
    { id: 'theme', values: ['dark', 'light'], topic: ['theme', 'themes', 'mode', 'modes', 'ui', 'color', 'colour', 'scheme', 'appearance', 'background', 'interface'] },
    { id: 'indent', values: ['tab', 'space'], topic: ['indentation', 'indent', 'indenting', 'whitespace', 'level', 'character'] },
    { id: 'length', values: ['short', 'shorter', 'long', 'longer', 'concise', 'brief', 'terse', 'verbose', 'detailed', 'lengthy', 'succinct', 'thorough', 'compact'],
      topic: ['length'],
      objects: { reply: 'reply', answer: 'reply', response: 'reply', message: 'message', summary: 'summary', explanation: 'explanation', output: 'output',
        note: 'note', report: 'report', update: 'update' } },
    { id: 'tone', values: ['formal', 'casual', 'informal', 'friendly', 'professional', 'playful'], topic: ['tone', 'style', 'voice', 'language', 'writing', 'register'] },
    { id: 'quotes', values: ['single', 'double'], topic: ['quote', 'quotation', 'mark', 'string'] },
    { id: 'units', values: ['metric', 'imperial'], topic: ['unit', 'measurement', 'system'] },
    { id: 'temperature', values: ['celsius', 'fahrenheit'], topic: ['temperature', 'degree', 'unit'] },
    { id: 'packages', values: ['npm', 'pnpm', 'yarn', 'bun'], topic: ['package', 'manager', 'install', 'dependency', 'script'] },
    { id: 'case', values: ['camelcase', 'snakecase', 'kebabcase', 'pascalcase'], topic: ['case', 'naming', 'name', 'convention'],
      objects: { variable: 'variable', identifier: 'identifier', key: 'key' } }
  ];
  const inGroup = (g, t) => g.topic.indexOf(t) >= 0 || !!(g.objects && g.objects[t]);
  function stem(t) {
    if (SYN[t]) return SYN[t];
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && /[^s]s$/.test(t)) return t.slice(0, -1);
    return t;
  }
  function words(text) {
    let t = String(text == null ? '' : text).toLowerCase().replace(/[‘’ʼ`]/g, "'");
    t = t.replace(/\b(do|does|did|is|are|was|were|has|have|had|should|would|could|must|need)n'?t\b/g, '$1 not')
      .replace(/\bwon'?t\b/g, 'will not').replace(/\bcan'?t\b/g, 'can not').replace(/\bcannot\b/g, 'can not')
      .replace(/'s\b/g, '').replace(/'/g, '');
    return t.split(/[^a-z0-9]+/).filter(Boolean);
  }
  function startsWith(toks, at, phrase) {
    for (let i = 0; i < phrase.length; i++) if (toks[at + i] !== phrase[i]) return false;
    return true;
  }
  function groupOf(tokens) {
    if (!tokens.length) return null;
    for (const g of ALTERNATIVES) {
      let hit = false, ok = true;
      for (const t of tokens) {
        if (g.values.indexOf(t) >= 0) hit = true;
        else if (!inGroup(g, t)) { ok = false; break; }
      }
      if (ok && hit) return g;
    }
    return null;
  }
  const clean = toks => toks.filter(t => !ARTICLE.has(t)).map(stem);

  /* claimOf(text) -> { subject, rel, topic, value:{pick,over}, neg, key } | null. ONE claim only: a text with two
     sentences, a question, or no recognisable relation has no key (null), and every caller then keeps its old path. */
  function claimOf(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw.length > 300 || /\?\s*$/.test(raw)) return null;
    const sentences = raw.split(/[.!;\n]+(?:\s+|$)/).map(s => s.trim()).filter(Boolean);
    if (sentences.length !== 1) return null;
    let toks = words(sentences[0]);
    /* NAME-SHAPED tokens, read from the ORIGINAL case (words() lowercases): capitalised past the first word ("Frankfurt",
       "Postgres", "CI") — a place or a name — or carrying a digit ("18", "v2") — a name, never a place. Not a state. */
    const named = new Set(), numbered = new Set();
    String(sentences[0]).split(/[^A-Za-z0-9]+/).filter(Boolean).forEach((t, i) => {
      if (i > 0 && t.length >= 2 && /^[A-Z]/.test(t)) named.add(stem(t.toLowerCase()));
      if (/\d/.test(t)) numbered.add(stem(t.toLowerCase()));
    });
    let neg = false;
    // strip the standing framing ("From now on, always …", "Remember that …", "For all future tasks, …")
    for (let guard = 0; guard < 8 && toks.length; guard++) {
      const lead = LEAD.find(p => startsWith(toks, 0, p));
      if (lead) { if (lead.length === 1 && lead[0] === 'never') neg = !neg; toks = toks.slice(lead.length); continue; }
      const fut = toks.slice(0, 5).join(' ').match(/^for (?:all|every) (?:future )?\w+/);
      if (fut && FUTURE.test(fut[0])) { toks = toks.slice(fut[0].split(' ').length); continue; }
      break;
    }
    if (toks.length < 2) return null;
    // the relation: the first relation word within the first six tokens
    let at = -1;
    for (let i = 0; i < Math.min(toks.length, 7); i++) if (REL[toks[i]]) { at = i; break; }
    if (at < 0) return null;
    let rel = REL[toks[at]];
    const copula = toks[at];
    let before = toks.slice(0, at), after = toks.slice(at + 1);
    if (rel === 'like-') { rel = 'like'; neg = !neg; }
    let where = rel === 'loc' ? (LOC_CLASS[copula] || 'geo') : null, isName = false;
    // auxiliaries / negation between the subject and its verb ("does not prefer", "never uses", "is not in")
    const subj = [];
    for (const t of before) {
      if (NEG.has(t)) { neg = !neg; continue; }
      if (AUX.has(t) || ARTICLE.has(t)) continue;
      subj.push(t);
    }
    if (rel === 'be' || rel === 'loc') {
      while (after.length && (NEG.has(after[0]) || AUX.has(after[0]))) { if (NEG.has(after[0])) neg = !neg; after = after.slice(1); }
      // "is (located|hosted|…) in X" and "lives in X" are a LOCATION (of the participle's kind); a bare "is in X" is
      // one only when X reads as a place (checked below); any other copula is an attribute
      while (after.length && LOC_PART.has(after[0])) { rel = 'loc'; where = LOC_CLASS[after[0]] || 'geo'; after = after.slice(1); }
      if (after.length && LOC_PREP.has(after[0]) && (rel === 'loc' || rel === 'be')) { if (rel === 'be') where = 'geo'; rel = 'loc'; after = after.slice(1); }
      if (rel === 'be' && after.length && NAMING.has(after[0])) { isName = true; after = after.slice(1); }
      else if (rel === 'be' && after[0] === 'set' && after[1] === 'to') { isName = true; after = after.slice(2); }
    } else if (after.length && NEG.has(after[0]) && after[0] === 'no') { neg = !neg; after = after.slice(1); }
    if (!after.length) return null;
    // the subject: who or what the belief is about. An imperative ("use spaces …") is the Commander's own order.
    let subject;
    const subjTokens = clean(subj).filter(t => !NEG.has(t));
    if (!subjTokens.length) {
      if (at !== 0 || (rel !== 'pref' && rel !== 'use')) return null;   // only "use …" / "prefer …" read as an order
      subject = 'user';
    } else if (subjTokens.length > 4) return null;
    else subject = subjTokens.map(t => (PERSON.has(t) ? 'user' : t)).filter((t, i, a) => a.indexOf(t) === i).join(' ');
    // the Commander's "use X" is a preference; a thing that "uses X" is a fact about that thing
    if (rel === 'use') rel = subject === 'user' ? 'pref' : 'use';
    // split off a qualifier ("for indentation", "in the editor") — never the location a loc claim names
    let object = after, qualifier = [];
    if (rel !== 'loc') {
      for (let i = 1; i < after.length; i++) if (QUAL.has(after[i])) { object = after.slice(0, i); qualifier = after.slice(i + 1); break; }
    }
    // a comparison: "X over Y", "X instead of Y", "X rather than Y", "X, not Y"
    let pick = object, over = null;
    for (let i = 1; i < object.length; i++) {
      const two = CMP2.find(p => startsWith(object, i, p));
      if (two) { pick = object.slice(0, i); over = object.slice(i + 2); break; }
      if (CMP1.has(object[i])) { pick = object.slice(0, i); over = object.slice(i + 1); break; }
    }
    if (pick.some(t => NEG.has(t))) return null;   // a negation inside the value is more than one claim
    if (pick[0] === 'to') pick = pick.slice(1);    // "prefers to run X"
    if (!pick.length || PRONOUN.has(pick[0]) && pick.length === 1) return null;   // "likes it when …": the claim is elsewhere
    pick = clean(pick); over = over ? clean(over) : null;
    const qual = clean(qualifier).filter(t => !SIM_STOP.has(t));
    if (!pick.length || (over && !over.length)) return null;
    // the dimension (topic) being claimed — explicit, or no key at all
    let topic = null;
    const g = groupOf(pick) || (over && groupOf(over));
    const qualNamesGroup = g && qual.length && qual.every(t => inGroup(g, t));
    const qualKey = qual.length && !qualNamesGroup ? 'q:' + qual.join(' ') : '';
    // what a length / naming-case value is ABOUT stays in the key: "concise replies" never retires "detailed reports"
    const objects = g && g.objects ? pick.concat(over || [], qualNamesGroup ? qual : []).map(t => g.objects[t]).filter((t, i, a) => t && a.indexOf(t) === i).sort() : [];
    const placeLike = toks => toks.some(t => named.has(t) || PLACE_NOUN.has(t));   // "until 3pm" is a time, never a place
    const nameLike = toks => toks.some(t => named.has(t) || numbered.has(t));
    if (g && (rel === 'pref' || rel === 'like' || rel === 'use')) {
      topic = 'alt:' + g.id + (objects.length ? '|o:' + objects.join(',') : '') + (qualKey ? '|' + qualKey : '');
      if (rel !== 'use') rel = 'pref';
    }
    else if (rel === 'like' || rel === 'use') return null;   // several tastes / tools can hold at once: no key outside a group
    else if (qualKey && rel === 'pref') topic = qualKey;      // a preference FOR something; an attribute's qualifier is no dimension
    else if (over) topic = 'cmp:' + [pick.join(' '), over.join(' ')].sort().join('|');
    // a location: only a PLACE ("in Frankfurt", "in the Virginia region"), never a state, a team or a dwelling
    else if (rel === 'loc' && placeLike(pick)) topic = where && where !== 'geo' ? where : '';
    // a thing's single-valued attribute: only a NAME ("the default branch is called main", "the Node version is 18",
    // "the CI runner is Linux"), never a state ("the main branch is protected"), and singular ("the maintainers are …")
    else if (rel === 'be' && subject !== 'user' && subjTokens.length >= 2 && (copula === 'is' || copula === 'was') && (isName || nameLike(pick))) topic = qualKey;
    if (topic == null) return null;
    // a value that only names the group's dimension ("dark mode" -> dark): compare what was CHOSEN
    const valueOf = toks => (g ? toks.filter(t => !inGroup(g, t)) : toks);
    const value = { pick: valueOf(pick), over: over ? valueOf(over) : null };
    if (!value.pick.length) value.pick = pick;
    return { subject, rel, topic, value, neg, key: subject + '|' + rel + '|' + topic };
  }
  function subjectKey(text) { const c = claimOf(text); return c ? c.key : null; }

  function overlap(a, b) {
    const A = new Set(a || []), B = new Set(b || []);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }
  function sameValue(x, y) {
    if (overlap(x.pick, y.pick) < 0.5) return false;
    if (x.over && y.over && overlap(x.over, y.over) < 0.5) return false;
    return true;
  }
  /* relate(a, b) -> 'dupe' | 'supersede' | 'distinct' | 'unknown' for two belief texts (or records). Symmetric in its
     verdict; the CALLER decides which side is newer. */
  function relate(a, b) {
    const x = claimOf(textOf(a)), y = claimOf(textOf(b));
    if (!x || !y) return 'unknown';
    if (x.key === y.key) return (x.neg === y.neg && sameValue(x.value, y.value)) ? 'dupe' : 'supersede';
    if (x.rel !== y.rel) return 'unknown';
    // the same claim about a different subject — the shape token overlap mistakes for a restatement
    if (x.subject !== y.subject && x.topic === y.topic && x.neg === y.neg && sameValue(x.value, y.value)) return 'distinct';
    // the same subject, two different alternatives groups (theme vs indentation). A qualifier or a comparison that
    // differs is NOT enough: "prefers npm start over serve" and "prefers to run npm start rather than serve" are one
    // belief worded twice, and their free-text topics differ.
    const groupId = c => (/^alt:([a-z]+)/.exec(c.topic) || [])[1] || '';
    if (x.subject === y.subject && groupId(x) && groupId(y) && groupId(x) !== groupId(y)) return 'distinct';
    return 'unknown';
  }

  /* titlesConflict(titleA, bodyA, titleB, bodyB) -> true when two notes' TITLES name different things the bodies do not
     ("Editor theme: User prefers dark mode" vs "Slides theme: User prefers light mode"). A writer that only reads the
     body would call that one subject; the titles say it is two. What is left of each title after its generic words, the
     alternatives vocabulary and every word either body already says must be comparable: both non-empty and neither a
     subset of the other is a conflict. A title that only restates the body ("Theme", "Dark mode") never conflicts. */
  const TITLE_GENERIC = new Set(['preference', 'pref', 'setting', 'user', 'commander', 'note', 'fact', 'profile', 'memory', 'info', 'information',
    'detail', 'choice', 'rule', 'convention', 'default', 'configuration', 'location', 'current', 'new', 'updated', 'update', 'correction',
    'corrected', 'changed', 'change', 'favorite', 'favourite']);
  const ALT_WORDS = new Set([].concat.apply([], ALTERNATIVES.map(g => g.values.concat(g.topic, Object.keys(g.objects || {})))));
  function titleRest(title, bodies) {
    const said = new Set();
    for (const b of bodies) for (const t of simTokens(b, { minLen: 2, stem })) said.add(t);
    const out = [];
    for (const t of simTokens(title, { minLen: 2, stem })) if (!TITLE_GENERIC.has(t) && !ALT_WORDS.has(t) && !PERSON.has(t) && !said.has(t)) out.push(t);
    return out;
  }
  function titlesConflict(titleA, bodyA, titleB, bodyB) {
    const a = titleRest(titleA, [bodyA, bodyB]), b = titleRest(titleB, [bodyA, bodyB]);
    if (!a.length || !b.length) return false;
    return !a.every(t => b.indexOf(t) >= 0) && !b.every(t => a.indexOf(t) >= 0);
  }

  return { SIM_STOP, SIM_STOP_WORDS, SIM_THRESHOLD, simTokens, similarity, findSimilar, textOf, claimOf, subjectKey, relate, titlesConflict, ALTERNATIVES, stem };
});
