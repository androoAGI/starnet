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
   "for/in X" qualifier, an "X over Y" comparison, a value from a short list of mutually exclusive alternatives such
   as dark/light or tabs/spaces, or a single-valued location/attribute). Anything else is 'unknown' and falls back to
   the challenge path, because a wrong 'supersede' would retire a genuinely separate fact (the callers keep every
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
     the group's values or topic words, and at least one a value — "a single file" never reads as a quote style. A
     qualifier made only of topic words just names the group ("tabs for indentation"). */
  const ALTERNATIVES = [
    { id: 'theme', values: ['dark', 'light'], topic: ['theme', 'themes', 'mode', 'modes', 'ui', 'color', 'colour', 'scheme', 'appearance', 'background', 'interface'] },
    { id: 'indent', values: ['tab', 'space'], topic: ['indentation', 'indent', 'indenting', 'whitespace', 'level', 'character'] },
    { id: 'length', values: ['short', 'shorter', 'long', 'longer', 'concise', 'brief', 'terse', 'verbose', 'detailed', 'lengthy', 'succinct', 'thorough', 'compact'],
      topic: ['reply', 'answer', 'response', 'message', 'summary', 'explanation', 'output', 'note', 'report', 'update'] },
    { id: 'tone', values: ['formal', 'casual', 'informal', 'friendly', 'professional', 'playful'], topic: ['tone', 'style', 'voice', 'language', 'writing', 'register'] },
    { id: 'quotes', values: ['single', 'double'], topic: ['quote', 'quotation', 'mark', 'string'] },
    { id: 'units', values: ['metric', 'imperial'], topic: ['unit', 'measurement', 'system'] },
    { id: 'temperature', values: ['celsius', 'fahrenheit'], topic: ['temperature', 'degree', 'unit'] },
    { id: 'packages', values: ['npm', 'pnpm', 'yarn', 'bun'], topic: ['package', 'manager', 'install', 'dependency', 'script'] },
    { id: 'case', values: ['camelcase', 'snakecase', 'kebabcase', 'pascalcase'], topic: ['case', 'naming', 'name', 'variable', 'identifier', 'key'] }
  ];
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
        else if (g.topic.indexOf(t) < 0) { ok = false; break; }
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
    let before = toks.slice(0, at), after = toks.slice(at + 1);
    if (rel === 'like-') { rel = 'like'; neg = !neg; }
    // auxiliaries / negation between the subject and its verb ("does not prefer", "never uses", "is not in")
    const subj = [];
    for (const t of before) {
      if (NEG.has(t)) { neg = !neg; continue; }
      if (AUX.has(t) || ARTICLE.has(t)) continue;
      subj.push(t);
    }
    if (rel === 'be' || rel === 'loc') {
      while (after.length && (NEG.has(after[0]) || AUX.has(after[0]))) { if (NEG.has(after[0])) neg = !neg; after = after.slice(1); }
      // "is (located|hosted|…) in X" and "lives in X" are a LOCATION; any other copula is an attribute
      while (after.length && LOC_PART.has(after[0])) { rel = 'loc'; after = after.slice(1); }
      if (after.length && LOC_PREP.has(after[0]) && (rel === 'loc' || rel === 'be')) { rel = 'loc'; after = after.slice(1); }
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
    const qualNamesGroup = g && qual.length && qual.every(t => g.topic.indexOf(t) >= 0);
    const qualKey = qual.length && !qualNamesGroup ? 'q:' + qual.join(' ') : '';
    if (g && (rel === 'pref' || rel === 'like' || rel === 'use')) { topic = 'alt:' + g.id + (qualKey ? '|' + qualKey : ''); if (rel !== 'use') rel = 'pref'; }
    else if (rel === 'like' || rel === 'use') return null;   // several tastes / tools can hold at once: no key outside a group
    else if (qualKey) topic = qualKey;
    else if (over) topic = 'cmp:' + [pick.join(' '), over.join(' ')].sort().join('|');
    else if (rel === 'loc') topic = '';
    else if (rel === 'be' && subject !== 'user' && subjTokens.length >= 2) topic = '';   // an attribute: "the default branch is main"
    if (topic == null) return null;
    // a value that only names the group's dimension ("dark mode" -> dark): compare what was CHOSEN
    const valueOf = toks => (g ? toks.filter(t => g.topic.indexOf(t) < 0) : toks);
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
    const groupId = c => (/^alt:([a-z]+)$/.exec(c.topic) || [])[1] || '';
    if (x.subject === y.subject && groupId(x) && groupId(y) && groupId(x) !== groupId(y)) return 'distinct';
    return 'unknown';
  }

  return { SIM_STOP, SIM_STOP_WORDS, SIM_THRESHOLD, simTokens, similarity, findSimilar, textOf, claimOf, subjectKey, relate, ALTERNATIVES, stem };
});
