/* sidecar/tools/builtin/notebook.js — the NOTEBOOK (memory) capability: the first real tool.
   Pure, sandboxed, no filesystem path-escape surface, no network. Backed by an injected store
   (in-memory for tests; localStorage/Save-backed in the browser; SQLite in the sidecar later) —
   the tool never touches storage directly. Notes are namespaced per agent.

   makeNotebookTools({ store, clock }) -> { writeTool, readTool, register(registry) }
     store : { get(key) -> value|undefined, set(key, value) }
     clock : { now() -> ms }   (injected for deterministic note timestamps)
   At call time, ctx supplies agentId / room / emit (the validated emitter) / consent. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('../../context.js') : (root.SK && root.SK.context));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).notebook = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (retrieval) {
  'use strict';

  // Compare against the version the caller actually read. A later edit must never be
  // overwritten by a stale correction; archive prior text outside active recall.
  // change.confirmation (host-derived only — notebook.write's statedBy proof) overrides the userConfirmed flag.
  function reviseRecord(record, change, now) {
    if (!record) throw new Error('no such memory — read your notebook before correcting it');
    const previous = String(record.content != null ? record.content : record.body || '');
    if (typeof change.previousBody !== 'string' || change.previousBody !== previous) {
      throw new Error('memory changed since it was read — read it again and retry the correction with its current previousBody');
    }
    const history = (Array.isArray(record.history) ? record.history : []).concat([{
      title: record.title || '', body: previous, sourceRunId: record.updatedSourceRunId || record.sourceRunId || null,
      revision: record.revision || 0, replacedAt: now
    }]);
    const confirmation = change.confirmation || (change.userConfirmed ? 'user-confirmed' : 'inferred');
    const out = Object.assign({}, record, {
      title: change.title == null ? record.title : change.title,
      body: change.body, content: change.body, updatedAt: now,
      updatedSourceRunId: change.runId || null, revision: (record.revision || 0) + 1, history,
      confirmation: confirmation, authority: 'reference-only',
      trust: 0, lastFeedbackAt: confirmation === 'user-confirmed' ? now : null, lastUsedAt: null, useCount: 0
    });
    // the old text's proof (and its old rating) describe the archived text, not this one
    delete out.statedBy; delete out.distrust;
    if (change.statedBy) out.statedBy = change.statedBy;
    return out;
  }

  /* PROVENANCE PROVEN, NOT CLAIMED (memory-truth lane, 2026-10-11). A user's correction saved by the agent used to
     render "[inferred, unconfirmed]" while the older rule it replaced read "[user-confirmed reference]" — so the
     model trusted the stale one. A note can now carry the Commander's authority, but only when the HOST can show it:
     ctx.commanderWords is the text the Commander typed in this run's conversation (set by the host on the owner's
     own surfaces only — never a channel guest, a routine, a hand-off or a delegated worker), and the note must be
     THEIR words: a complete ordered sentence matches after a few explicit framing equivalences, carries
     the same polarity (a "hate tabs" sentence never proves "prefers tabs"), and is shaped like a statement about
     themselves or an instruction (a bare "make it dark" is a one-off task, not a stated preference). Anything less
     is not proof, and the note keeps its ordinary provenance. Pure + deterministic. */
  const PROOF_STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that these those with as at by ' +
    'from your you i we they he she them our their not no do does did has have had will would can could me my so if up us am ' +
    'user users commander prefers prefer preferred preference preferences wants want wanted likes like liked love loves ' +
    'ask asks asked said says say told tell should must need needs please always never use uses used using instead rather ' +
    'over than also just only really very all any every when what which whenever don doesn didn won isn aren shouldn can cannot t s ll ve re d m').split(/\s+/));
  const PROOF_NEG = /\b(?:not|no|never|nor|none|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|isn'?t|aren'?t|shouldn'?t|avoid|without|stop|hate|hates|dislike|dislikes|against)\b/i;
  const PROOF_SHAPE = /\b(?:i|i'm|i've|i'd|we|my|me|our|prefer|always|never|from now on|going forward|by default|every ?time|whenever|remember|don'?t|do not|stop|avoid|make sure|please)\b/i;
  // a STANDING instruction in the Commander's own words: it is about every future conversation, not this one
  const STANDING = /\b(?:always|never|from now on|going forward|in (?:the )?future|every ?time|whenever|by default|(?:i|we)(?:'d| would)? (?:always |really |much )?prefer|don'?t ever|do not ever|for (?:all|every) (?:future )?(?:chats?|conversations?|projects?|tasks?))\b/i;
  const norm = s => String(s == null ? '' : s).replace(/[‘’]/g, "'");
  function stem(t) {
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 4 && /(?:s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && /[^s]s$/.test(t)) return t.slice(0, -1);
    return t;
  }
  function proofTokens(s) {
    const out = [];
    for (const t of norm(s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2 && !PROOF_STOP.has(t)) out.push(stem(t));
    return out;
  }
  // Deliberately conservative: a bag of words cannot prove a relation or a qualifier. Keep every word and
  // its order except these explicit preference/instruction frames. Unsupported paraphrases stay inferred.
  function proofForm(s, weaken) {
    let t = norm(s).toLowerCase().trim().replace(/[.!?;]+$/, '').trim();
    if (/["“”`]/.test(t)) return '';   // quoted material is not attested as the speaker's own preference
    t = t.replace(/^actually[\s,]+/, '');
    // Only the source may lose standing/time framing to prove a weaker paraphrase. Never erase a
    // qualifier from the note: that would let an ordinary preference attest an invented always/now.
    if (weaken) t = t.replace(/^(?:from now on|going forward|by default|in (?:the )?future)[\s,:]+/, '').replace(/\s+now$/, '');
    t = t.replace(/^(?:i|we|(?:the )?(?:user|commander))\s+(always\s+)?prefers?\s+/, '$1prefer ');
    t = t.replace(/^(always\s+)?use\s+/, '$1prefer ');
    if (weaken) t = t.replace(/^always (?=prefer )/, '');
    return t.replace(/\binstead of\b/g, 'over').replace(/\s+/g, ' ');
  }
  // -> the Commander's sentence that proves body, or '' when there is no such sentence.
  function statedSentence(body, words) {
    const want = proofForm(body);
    if (!want || new Set(proofTokens(body)).size < 2 || /["“”`]/.test(norm(words))) return '';
    const neg = PROOF_NEG.test(norm(body));
    for (const raw of norm(words).split(/[.!?;\n]+/)) {
      const sentence = raw.trim();
      if (!sentence || !PROOF_SHAPE.test(sentence) || PROOF_NEG.test(sentence) !== neg) continue;
      if (proofForm(sentence) === want || proofForm(sentence, true) === want) return sentence;
    }
    return '';
  }

  function makeNotebookTools(deps) {
    deps = deps || {};
    const store = deps.store;
    const clock = deps.clock || { now: () => 0 };
    // §5.6 always-on secret scrub: a jotted note can carry a key/token the agent saw this run, and it must
    // never persist to disk (or get re-injected into a future prompt by recall) in cleartext. The host injects
    // redact (the same one reflection + edits + SSE use); identity fallback keeps the tool usable standalone.
    const redact = typeof deps.redact === 'function' ? deps.redact : (x => x);
    // optional relevance ranker (context.rank — the SAME BM25+trust+recency+pinned brain auto-recall uses). The
    // host injects it so an explicit notebook.read query orders its matches the way recall does; standalone (no
    // injection) the tool falls back to store order, staying dependency-free for the browser build + tests.
    const rank = typeof deps.rank === 'function' ? deps.rank : null;
    // Read-only, owner/privacy-filtered by the host on each call; never part of updateNotes.
    const sharedStanding = typeof deps.sharedStanding === 'function' ? deps.sharedStanding : null;
    // injected trust fold (memcore.nextTrust) for notebook.feedback's rating nudge; inline fallback keeps the
    // tool standalone. clamp + step (delta*0.15) MUST match memcore.nextTrust — kept in sync.
    const nextTrust = typeof deps.nextTrust === 'function' ? deps.nextTrust : (prev, delta) => {
      const t = (typeof prev === 'number' && isFinite(prev)) ? prev : 0;
      const d = (typeof delta === 'number' && isFinite(delta)) ? delta : 0;
      const v = t + d * 0.15; return v < 0 ? 0 : v > 1 ? 1 : v;
    };
    // agent-feedback deltas (parity with the reference harness's fact feedback: asymmetric — penalize harder
    // than reward, so one bad recall sinks faster than one good recall rises). Expressed in OUR delta units (×0.15 in nextTrust):
    // helpful +0.075, unhelpful −0.15 — both WEAKER than a user turn-in keep (+2 → +0.30): the human still wins.
    const HELPFUL_DELTA = 0.5, UNHELPFUL_DELTA = -1.0;
    const RATING_STEP = 0.15;   // = memcore.TRUST_STEP (the delta→trust scale nextTrust applies) — kept in sync
    // NEAR-DUPE CHALLENGE at the write boundary. Reflection has deduped its PROPOSALS by Jaccard since M-mem.6, but
    // a direct notebook.write never was — so the same belief accumulated in a dozen phrasings over months, diluting
    // recall (the top-K ranker spends slots on restatements) and giving the Commander a panel full of noise to
    // prune by hand. The reference harness forces this issue with a hard char cap that ERRORS when full; we have no
    // cap by design (the user owns their memory, and top-K already bounds the prompt), so the equivalent is to
    // stop the redundant WRITE rather than to cap the store.
    //
    // WHY A CHALLENGE AND NOT A SILENT BLOCK. Token overlap cannot tell a restatement from two different facts that
    // share a shape: "staging db is in frankfurt" vs "production db is in frankfurt" scores as high as a genuine
    // paraphrase, because the ONE token that carries the difference is the one that differs. Any threshold tight
    // enough to catch real paraphrases will therefore sometimes swallow a real memory — and a false suppression is
    // worse than a duplicate (the same bar declinedindex.js sets). So we show the agent the belief it already holds
    // and let it decide: a restatement stops there; a genuinely distinct fact is re-sent with distinct:true and
    // saved. Nothing is ever silently lost, and the common case costs one refused call instead of a permanent
    // duplicate. Threshold matches reflection's — one definition of "near-dupe" across the whole memory system.
    const DUPE_THRESHOLD = 0.6;
    // inline Jaccard fallback (mirrors memcore.tokenJaccard) so this UMD tool stays dependency-free in the browser
    // build + standalone tests. Kept in sync with memcore — that is the canonical copy.
    const jaccard = typeof deps.similarity === 'function' ? deps.similarity : (a, b) => {
      const STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they').split(/\s+/));
      const toks = s => { const set = new Set(); for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !STOP.has(t)) set.add(t); return set; };
      const A = toks(a), B = toks(b);
      if (!A.size || !B.size) return 0;
      let inter = 0; for (const t of A) if (B.has(t)) inter++;
      return inter / (A.size + B.size - inter);
    };
    const textOf = r => (r.content != null ? r.content : ((r.title || '') + ' ' + (r.body || '')));
    const findSimilar = typeof deps.findSimilar === 'function' ? deps.findSimilar : (records, text, o) => {
      const threshold = (o && typeof o.threshold === 'number') ? o.threshold : 0.6;
      for (const r of (Array.isArray(records) ? records : [])) if (r && jaccard(textOf(r), text) >= threshold) return r;
      return null;
    };
    /* SAME SUBJECT, DIFFERENT CLAIM (memory-truth lane, 2026-10-11). "User prefers tabs" vs "User prefers spaces"
       overlap 0.5 — under the near-dupe bar — so the new note was saved beside the old one and BOTH stayed active
       forever: a contradiction recall served side by side. A write that overlaps an existing note in [0.3, 0.6) is
       still saved (it may be a separate fact — a false block is worse than a duplicate), but the result names those
       notes so the model can retire the one this replaces through the ordinary correction path. Nothing is deleted
       without the model choosing it. */
    const SIMILAR_FLOOR = 0.3;
    const SIMILAR_MAX = 3;
    // memory-truth: the host's receipt seam — every committed write is reported for ITS run, so COMMS shows exactly
    // what this run saved (it used to borrow the agent's previous run's list). Host-injected; absent standalone.
    const onSaved = typeof deps.onSaved === 'function' ? deps.onSaved : null;
    const KEY = aid => 'notebook:' + (aid || 'agent');
    // M-mem.2: widen any legacy {id,title,body,ts} note to the §5.2 memory-record shape
    // (kind/scope/provenance/trust/useCount/pinned), idempotently — so an existing notebook upgrades
    // transparently on read, and the next write persists the new shape. title/body/ts are preserved.
    function migrate(n) {
      if (n && n.kind && n.scope) return n;
      return Object.assign({
        kind: 'note', scope: 'global', streamId: null, sourceRunId: null,
        createdAt: (n && typeof n.ts === 'number') ? n.ts : 0,
        lastUsedAt: null, useCount: 0, trust: 0, pinned: false
      }, n);
    }
    const notesOf = aid => { const v = store.get(KEY(aid)); return Array.isArray(v) ? v.map(migrate) : []; };
    // P1 SAFE WRITE: route every mutation through store.update (per-agent serialized, re-read-under-lock) when
    // the host provides it; fall back to the plain get->mutate->set for a standalone store (browser/tests). The
    // mutator always receives the MIGRATED current list and returns the new list (or undefined to skip writing).
    const updateNotes = (aid, mutator) => {
      const apply = cur => mutator(Array.isArray(cur) ? cur.map(migrate) : []);
      if (store && typeof store.update === 'function') return store.update(KEY(aid), apply);
      const next = apply(store.get(KEY(aid)));
      if (next !== undefined) store.set(KEY(aid), next);
      return Promise.resolve(next);
    };
    // collision-proof id: one past the HIGHEST existing note_N. Positional ('note_'+list.length) reuses a slot
    // freed by a forget (M-mem.6) -> a DUPLICATE id -> id-keyed ops corrupt/delete the wrong record. Mirrors
    // memcore.nextNoteId (kept inline so this UMD tool stays dependency-free).
    const nextId = list => { let max = 0; for (const n of list) { const m = /^note_(\d+)$/.exec(n && n.id); if (m && +m[1] > max) max = +m[1]; } return 'note_' + (max + 1); };

    const writeTool = {
      // NO consent gate: the notebook is the agent's OWN sandboxed private memory (no filesystem reach, no
      // network, a sibling file its fs.* tools can't even touch) — not the user's files. Prompting on every
      // jotted note would be pure consent-fatigue; approval is reserved for outward effects (fs.* writes).
      name: 'notebook.write', capability: 'memory', scope: 'write', requiresConsent: false,
      description: 'Save a durable fact to your persistent memory so it survives across sessions and is auto-recalled when relevant. Keep entries short and high-signal. ' +
        'WHEN: save proactively when the user states a preference or correction, or you learn a stable fact about them, their environment, or conventions — ' +
        'priority: preferences & corrections > environment facts > procedures. The best memory stops the user repeating themselves. ' +
        'SKIP: trivia, task progress, completed-work logs, PR/issue/commit ids, anything that will be stale within a week (that is not memory). ' +
        "WRITE STYLE: a declarative fact, not an instruction to yourself — 'User prefers concise replies' is right; 'Always reply concisely' is wrong " +
        '(an imperative gets re-read in a later session as a standing order and can override the user). Reusable procedures belong in a skill, not memory. ' +
        'CORRECTIONS: read the existing entry, then use replaceId and its exact previousBody to update it in place. Never use distinct:true for a correction; that leaves the obsolete belief active. ' +
        'APPROVED REQUIREMENTS: save explicit reusable preferences and approved design requirements with pinned:true so they stay in context even on short follow-ups. Include the approved artifact/reference path and concrete style constraints; read the artifact again before producing a variant. ' +
        'Use scope:stream for project/task requirements (an anchored trusted project is captured by the host); scope:global only for preferences the user wants across projects. Current instructions always win. ' +
        'Say saved/updated only after this tool confirms the write. A fact you already hold is not saved twice: "already known" means no write occurred.',
      schema: {
        type: 'object', required: ['title', 'body'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          distinct: { type: 'boolean', description: 'Only for a genuinely separate fact, never a correction to an existing fact.' },
          replaceId: { type: 'string', description: 'Existing note id to correct in place instead of appending a contradictory entry.' },
          previousBody: { type: 'string', description: 'Exact current body from notebook.read; required with replaceId to prevent overwriting a newer edit.' },
          pinned: { type: 'boolean', description: 'Keep an explicit reusable preference or approved requirement in context within its scope.' },
          scope: { type: 'string', enum: ['stream', 'global'], description: 'stream for this project/task, global only for user preferences applying across projects.' }
        }
      },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const runId = ctx && ctx.runId ? String(ctx.runId) : null;   // provenance source (B1 Cortex seam)
        const streamId = ctx && ctx.streamId ? String(ctx.streamId) : null;   // M-mem.2b: the run's workstream
        const projectRoot = (ctx && ctx.projectRoot) || null;
        if (args.scope && args.scope !== 'stream' && args.scope !== 'global') throw new Error('scope must be stream or global');
        if (args.scope === 'stream' && !streamId) throw new Error('stream memory requires an active stream');
        /* MEMORY CARRIES ITS RUN'S TAINT (2026-10-10). A run that read a web page, an email or a stranger's message
           could otherwise save the injected text as a "fact" — and recalled memory is trusted context, so a later
           Full Access run would start clean in front of it. A tainted run's note is stamped with that taint (recall
           re-latches it on the reading run), and it can never be PINNED (pinned = injected into every prompt). */
        let taintedBy = '';
        try { const a = ctx && ctx.connectorAuthority; taintedBy = a && typeof a.taintedBy === 'function' ? String(a.taintedBy() || '') : ''; } catch (_) { taintedBy = 'taint check failed'; }
        if (taintedBy && args.pinned === true) {
          return { content: 'Not saved — this run has read outside content (' + taintedBy + '), so it cannot pin a memory into every future prompt. Save it unpinned, or ask the Commander to pin it.', summary: 'pin refused (tainted run)' };
        }
        const now = clock.now();
        // PROVENANCE (see statedSentence): the Commander's own sentence behind this note, proven by the host's words —
        // never on a tainted run (the words may sit beside outside content the note actually came from).
        const words = (!taintedBy && ctx && typeof ctx.commanderWords === 'string') ? ctx.commanderWords : '';
        const quote = words ? statedSentence(String(args.body), words) : '';
        const statedBy = quote ? { runId: runId, quote: redact(quote).slice(0, 200) } : null;
        /* STANDING INSTRUCTIONS GO STATION-WIDE (memory-truth lane). A note defaults to its chat thread (scope stream),
           where it gets no boost and its pin does not apply anywhere else — so "from now on, always X", saved in one
           chat, was invisible as a standing order in every other one. When the Commander's own sentence behind the
           note is standing-shaped ("always", "never", "from now on", "I prefer", …) the default is global instead.
           An explicit scope always wins, and a project session keeps its project tier (it already spans every chat
           in that project). Task-local facts stay in their thread, as before. */
        const standing = !!(quote && STANDING.test(norm(quote)));
        const widen = standing && !projectRoot;
        const scope = args.scope || (streamId && !widen ? 'stream' : 'global');
        const writeProject = retrieval.memoryProjectKey({ scope: scope, projectRoot: projectRoot });
        // §5.2 record minted INSIDE the lock against the re-read list, so the id is collision-proof even if a
        // concurrent run/UI write changed the notebook since this run started (P1).
        let note = null, dupe = null, folded = null, similar = [];
        const overridden = !!(args && args.distinct);   // the agent SAW the near-dupe and judged this fact different
        await updateNotes(aid, (list) => {
          if (args.replaceId) {
            const at = list.findIndex(n => n.id === args.replaceId);
            const prior = list[at];
            if (prior && !retrieval.memoryAllowedInProject(prior, projectRoot)) {
              throw new Error('no such memory in this project — read your notebook before correcting it');
            }
            // a correction in the Commander's proven words keeps (or earns) their authority; otherwise it is the
            // agent's inference and renders "[corrected, unconfirmed]" — superseding, never laundered
            const confirmation = statedBy ? ((prior && prior.confirmation === 'user-confirmed') ? 'user-confirmed' : 'user-stated') : 'inferred';
            note = reviseRecord(prior, {
              previousBody: args.previousBody, title: redact(String(args.title)), body: redact(String(args.body)), runId,
              confirmation: confirmation, statedBy: statedBy
            }, now);
            if (args.scope || widen) { note.scope = scope; note.streamId = scope === 'stream' ? streamId : null; note.projectRoot = scope === 'stream' ? projectRoot : null; }
            if (typeof args.pinned === 'boolean') note.pinned = args.pinned;
            /* FOLD THE SAME-RUN COPY. After a save that listed similar notes (below), the model retires the old one by
               correcting it to the new text — which would leave this run's fresh copy as a duplicate. A note THIS run
               created (same sourceRunId, never revised) whose text now equals the corrected record is folded into it:
               one active belief, the old text archived in its history, and the copy's pin carried over. */
            const same = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
            const copyAt = runId ? list.findIndex((n, i) => i !== at && n && n.sourceRunId === runId && !n.revision &&
              retrieval.memoryProjectKey(n) === retrieval.memoryProjectKey(note) &&
              !(Array.isArray(n.history) && n.history.length) && same(n.body) === same(note.body)) : -1;
            if (copyAt >= 0) {
              folded = list[copyAt];
              if (typeof args.pinned !== 'boolean' && folded.pinned) note.pinned = true;
              if (!args.scope && folded.scope === 'global' && note.scope === 'stream') { note.scope = 'global'; note.streamId = null; note.projectRoot = null; }
            }
            if (taintedBy) { note.taintedBy = taintedBy.slice(0, 200); note.pinned = false; } else delete note.taintedBy;
            list[at] = note;
            return copyAt >= 0 ? list.filter((_, i) => i !== copyAt) : list;
          }
          const text = String(args.title) + ' ' + String(args.body);
          // the near-dupe check runs INSIDE the lock against the RE-READ list — outside it, two concurrent runs
          // saving the same belief would both see a clean notebook and both append.
          // A belief in another project cannot stand in for this write or nominate its correction.
          // Compare boundaries, not stream ids: a project's notes already span its conversations.
          const candidates = list.filter(n => retrieval.memoryProjectKey(n) === writeProject);
          dupe = candidates.find(n => Array.isArray(n.history) && n.history.some(h => h && String(h.body).trim() === String(args.body).trim())) ||
            (overridden ? null : findSimilar(candidates, text, { threshold: DUPE_THRESHOLD }));
          if (dupe) return undefined;   // nothing to write — skip the store write entirely
          // same subject, different claim: collected against the list BEFORE the new note joins it
          similar = candidates.map((n, i) => ({ n, i, s: n ? jaccard(textOf(n), text) : 0 }))
            .filter(x => x.s >= SIMILAR_FLOOR && x.s < DUPE_THRESHOLD)
            .sort((a, b) => (b.s - a.s) || (b.i - a.i)).slice(0, SIMILAR_MAX).map(x => x.n);
          note = {
            id: nextId(list), kind: 'note',
            title: redact(String(args.title)), body: redact(String(args.body)),   // §5.6: scrub secrets before they persist
            scope: scope, streamId: scope === 'stream' ? streamId : null, sourceRunId: runId,
            projectRoot: scope === 'stream' ? projectRoot : null,
            // which SURFACE formed this belief (memcore.originOf, injected on the run's tool ctx). Unattended runs
            // can write memory now, so the Commander must be able to tell a channel-learned fact from their own.
            origin: (ctx && ctx.origin) ? String(ctx.origin) : 'commander',
            createdAt: now, ts: now, lastUsedAt: null, useCount: 0, trust: 0, pinned: args.pinned === true
          };
          if (statedBy) { note.confirmation = 'user-stated'; note.statedBy = statedBy; }
          if (taintedBy) note.taintedBy = taintedBy.slice(0, 200);
          list.push(note);
          return list;
        });
        // ALREADY KNOWN: a success, not an error — an error makes a model retry with a reworded duplicate, which is
        // the exact behaviour this guard exists to stop. Show the belief it already holds IN FULL so the decision is
        // informed, and emit NOTHING (no memory.write, no deliverable): nothing was written, and a receipt for a
        // write that did not happen is the kind of claim truthful telemetry forbids.
        /* AN ECHO CARRIES ITS TAINT (security-storage-02). The near-dupe refusal and the similar-notes tail below quote
           a held note verbatim — the same exposure as notebook.read — so a clean run that sees a tainted note's text
           here is tainted by it too (registry copies taintedBy onto the result; the host latches it via relayedTaint). */
        const echoTaint = rows => { const t = (rows || []).find(n => n && typeof n.taintedBy === 'string' && n.taintedBy); return t ? { taintedBy: 'memory saved by a run that read ' + t.taintedBy } : {}; };
        if (dupe) {
          const held = String(dupe.content != null ? dupe.content : (dupe.body != null ? dupe.body : '')).replace(/\s+/g, ' ').trim().slice(0, 300);
          return Object.assign({
            content: 'Not saved — you already remember something very close:\n[' + dupe.id + '] ' + String(dupe.title || '') + ': ' + held + '\n\n' +
              'If that is the SAME belief, you are done — do not reword and retry. If this is genuinely a different fact ' +
              ', use distinct:true. If this is a CORRECTION, call notebook.write with replaceId:"' + dupe.id +
              '" and the exact current previousBody from notebook.read. That updates the existing entry; distinct:true does not.',
            summary: 'already known (' + dupe.id + ')'
          }, echoTaint([dupe]));
        }
        // the receipt for THIS run, registered before memory.write tells COMMS to fetch it
        if (onSaved && runId) onSaved(aid, runId, {
          id: note.id, key: note.id + '@' + (note.revision || 0), kind: 'note', content: String(note.body), scope: note.scope,
          projectRoot: note.projectRoot || null, origin: note.origin || 'commander', saved: true, source: 'notebook.write',
          revised: !!args.replaceId, folded: folded ? folded.id : null, confirmation: note.confirmation || null
        });
        if (ctx && typeof ctx.emit === 'function') {
          // memory.write — the durable-memory rung (feeds useCount/trust + the dossier's archivist track). The
          // frozen contract requires runId, so emit only on a real run (some test fixtures carry no runId).
          // streamId is included only when present (the optional field is typed string — never emit a null).
          if (runId) { const w = { agentId: aid, runId, id: note.id, kind: 'note', scope: note.scope }; if (streamId) w.streamId = streamId; ctx.emit('memory.write', w); }
          /* HOOKS — on_memory_write. Observe-only by construction (hooks.js refuses to let it block): memory is
             the Commander's own, and a script that could veto their notes would be a foot-gun with no upside.
             Fire-and-forget — the note is already saved, so a slow hook delays nothing. */
          if (ctx.hooks && typeof ctx.hooks.invoke === 'function') {
            try { ctx.hooks.invoke('on_memory_write', { session_id: runId || '', extra: { agent_id: aid, id: note.id, kind: 'note', scope: scope, title: note.title, source: 'notebook.write' } }); } catch (_) {}
          }
          const d = { id: note.id, agentId: aid, kind: 'note', title: note.title };
          if (ctx.room) d.room = ctx.room;
          ctx.emit('deliverable', d);
        }
        // the result says what was really recorded: where the note applies, and — when the host proved it — that it
        // carries the Commander's own words (a model may only claim that because the tool says so)
        const where = (!args.replaceId || args.scope || widen)
          ? ' Scope: ' + (note.scope === 'global' ? 'every conversation' : note.projectRoot ? 'this project' : 'this conversation only') +
            (widen && !args.scope && note.scope === 'global' ? ' (a standing instruction in the Commander\'s own words)' : '') + '.'
          : '';
        const proof = note.confirmation === 'user-stated' || (statedBy && note.confirmation === 'user-confirmed') ? ' Recorded as the Commander\'s own words.' : '';
        let tail = '';
        if (folded) tail = ' Folded ' + folded.id + ' (saved earlier this run with the same text) into it.';
        if (similar.length) {
          tail = '\n\nSimilar notes you already hold:\n' + similar.map(n => '[' + n.id + '] ' + String(n.title || '') + ': ' +
            String(n.content != null ? n.content : (n.body != null ? n.body : ''))).join('\n') +
            '\n\nIf ' + note.id + ' REPLACES one of them, retire the old one now: call notebook.write with replaceId set to its id, ' +
            'previousBody set to its exact text above, and this same title/body — Agent OS folds ' + note.id + ' into it, so only ' +
            'the corrected belief stays active. If they are separate facts, leave both.';
        }
        return Object.assign({ content: (args.replaceId ? 'Updated' : 'Saved') + ' note "' + note.title + '" (' + note.id + ').' + (args.replaceId ? ' The previous text is archived and is no longer active recall.' : '') + where + proof + tail, summary: (args.replaceId ? 'updated ' : 'wrote ') + note.id }, echoTaint(similar));
      }
    };

    const readTool = {
      name: 'notebook.read', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Read your notebook (your durable memory). Optional `query` returns the matching entries ranked by relevance (the same ' +
        'BM25 + trust + recency order auto-recall uses); omit it to list all available entries. Project notes stay within their project. Each line is prefixed with the entry id ([note_N]) ' +
        'you can pass to notebook.feedback. Shared standing preferences use [shared:agent/id], are read-only, and can be found by that key.',
      schema: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        let list = notesOf(aid);
        let sharedUnavailable = false;
        if (sharedStanding && retrieval && retrieval.isStandingMemory) {
          try {
            const incoming = await sharedStanding(ctx || {});
            const foreign = (Array.isArray(incoming) ? incoming : []).filter(n => n && n.foreign && retrieval.isStandingMemory(n)
              && /^[A-Za-z0-9_-]{1,40}$/.test(String(n.sourceAgentId || '')) && n.sourceAgentId !== aid
              && /^[A-Za-z0-9_-]{1,80}$/.test(String(n.sourceRecordId || '')))
              .map(n => Object.assign({}, n, { id: '', title: n.title || 'Standing preference', body: String(n.content || n.body || '') }));
            list = list.concat(foreign);
          } catch (_) { sharedUnavailable = true; }
        }
        // Apply scope before every selector, including list-all and singleton reads without a ranker.
        const notebookTotal = list.length;
        list = list.filter(n => retrieval.memoryAllowedInProject(n, (ctx && ctx.projectRoot) || null));
        const total = list.length;
        const q = args && args.query;
        if (q) {
          const ql = String(q).toLowerCase();
          list = list.filter(n => ((n.foreign ? 'shared:' + n.sourceAgentId + '/' + n.sourceRecordId + ' ' : '') + n.title + ' ' + n.body).toLowerCase().indexOf(ql) >= 0);
          // substring stays the GATE (predictable "no match"); rank() only REORDERS the matches so the most
          // relevant/trusted/pinned one leads — the explicit read now shares auto-recall's ranking, not raw
          // store order. k = list.length AND floor:false so ranking never truncates a match the gate already
          // admitted (a substring hit inside a longer token scores zero BM25 — rank's relevance floor would
          // silently drop it from an explicit read the gate said matched).
          // projectRoot: rank() drops a project-scoped record unless the run is IN that project — without it, an
          // explicit read silently lost every project lesson even inside its own project (the gate had admitted it).
          if (rank && list.length > 1) list = rank(list, String(q), { now: clock.now(), k: list.length, floor: false, projectRoot: (ctx && ctx.projectRoot) || null });
        }
        if (!list.length) return { content: (q ? 'No notes match "' + q + '".' : notebookTotal ? 'No notes are available in this project.' : 'Your notebook is empty.') + (sharedUnavailable ? ' Shared preferences could not be read; their absence is unverified.' : ''), summary: '0 notes' };
        const body = list.map(n => '- [' + (n.foreign ? 'shared:' + n.sourceAgentId + '/' + n.sourceRecordId : n.id) + '] ' + n.title + (n.foreign ? ' (read-only shared preference)' : '') + ': ' + n.body).join('\n');
        // report the SIZE of the available notebook on a filtered read, so the count matches its project boundary
        // (the reference harness puts a usage percentage in the system prompt; we have no cap to measure against,
        // but the count is the honest half of that signal — and it is the number a crowded notebook shows up in).
        const foot = (q ? '\n\n(' + list.length + ' of ' + total + ' entries in memory)' : '') + (sharedUnavailable ? '\n[Shared preferences could not be read; these results are partial.]' : '');
        // a note a tainted run saved is outside content at one remove: reading it taints this run too (2026-10-10)
        const tainted = list.find(n => n && typeof n.taintedBy === 'string' && n.taintedBy);
        return Object.assign({ content: body + foot, summary: list.length + ' note(s)' }, tainted ? { taintedBy: 'memory saved by a run that read ' + tainted.taintedBy } : {});
      }
    };

    // notebook.feedback — parity with the reference harness's fact feedback ("good facts rise, bad facts sink"). Rating a recalled
    // memory nudges its TRUST (a stat), never its content and never deletes it — fully consistent with the
    // user-owns-memory model (the agent gives a soft signal, exactly like the user's turn-in verdict; the user
    // still owns edit/forget). Pairs with trust-decay: a re-affirmed memory resets its fade (lastFeedbackAt),
    // an unhelpful one sinks below fresher beliefs in recall. No silent loss: a sunk memory is still stored,
    // visible in the panel, and recallable — it just ranks lower.
    const feedbackTool = {
      name: 'notebook.feedback', capability: 'memory', scope: 'write', requiresConsent: false,
      description: 'Rate a memory you recalled and used this run so the right ones surface next time — "helpful" if it was accurate and ' +
        'useful, "unhelpful" if it was outdated or wrong. Good memories rise; stale ones fade (they are NOT deleted, only de-prioritized). ' +
        'Identify the entry by its `id` (from notebook.read, e.g. note_3) or by `match` — a unique substring of its text (use this for a ' +
        'memory you saw in recalled context, where no id is shown).',
      schema: {
        type: 'object', required: ['rating'],
        properties: {
          rating: { type: 'string', enum: ['helpful', 'unhelpful'] },
          id: { type: 'string', description: 'The entry id, e.g. note_3.' },
          match: { type: 'string', description: 'A unique substring identifying the entry (alternative to id).' }
        }
      },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const rating = args && args.rating;
        const delta = rating === 'helpful' ? HELPFUL_DELTA : rating === 'unhelpful' ? UNHELPFUL_DELTA : null;
        // error paths THROW — the registry turns a throw into an isError result (a returned {isError} is ignored).
        if (delta === null) throw new Error('rating must be "helpful" or "unhelpful"');
        // The lookup + trust fold run INSIDE the per-agent lock against the re-read list (P1); the error paths
        // throw out of the mutator, which rejects the run (the registry turns that into an isError result) and
        // — critically — skips the write, so a missing/ambiguous id never overwrites the notebook.
        let recOut = null, nextOut = null;
        await updateNotes(aid, (list) => {
          if (!list.length) throw new Error('your notebook is empty — nothing to rate');
          let idx = -1;
          if (args.id) {
            idx = list.findIndex(n => n && n.id === String(args.id) && retrieval.memoryAllowedInProject(n, (ctx && ctx.projectRoot) || null));
            if (idx < 0) throw new Error('no memory has id "' + args.id + '"');
          } else if (args.match) {
            const m = String(args.match).toLowerCase();
            const hits = [];
            for (let i = 0; i < list.length; i++) {
              const n = list[i]; const text = (n.title + ' ' + n.body + ' ' + (n.content || '')).toLowerCase();
              if (retrieval.memoryAllowedInProject(n, (ctx && ctx.projectRoot) || null) && text.indexOf(m) >= 0) hits.push(i);
            }
            if (!hits.length) throw new Error('no memory matches "' + args.match + '"');
            if (hits.length > 1) throw new Error('ambiguous: ' + hits.length + ' memories match "' + args.match + '" — use a more specific substring or the id from notebook.read');
            idx = hits[0];
          } else {
            throw new Error('provide an `id` or a `match` substring to identify the memory');
          }
          const rec = list[idx];
          const now = clock.now();
          /* AN "UNHELPFUL" THAT TRUST CANNOT ABSORB BECOMES DISTRUST (memory-truth lane, 2026-10-11). Trust is clamped
             at 0 and a fresh note starts there, so rating an outdated note unhelpful changed nothing: it ranked exactly
             as before. The share of the penalty trust could not take is kept as `distrust` (bounded [0,1]; rank()
             subtracts it, fading on the trust clock), and a later "helpful" pays distrust down before trust rises. */
          const t0 = Math.max(0, Math.min(1, Number(rec.trust) || 0));
          let distrust = Math.max(0, Math.min(1, Number(rec.distrust) || 0)), trust;
          if (delta < 0) {
            trust = nextTrust(t0, delta);
            const shortfall = (-delta * RATING_STEP) - (t0 - trust);
            if (shortfall > 1e-9) distrust = Math.min(1, distrust + shortfall);
          } else {
            const pay = Math.min(distrust, delta * RATING_STEP);
            distrust -= pay;
            trust = nextTrust(t0, (delta * RATING_STEP - pay) / RATING_STEP);
          }
          const next = Object.assign({}, rec, { trust: trust, lastFeedbackAt: now });
          if (distrust > 1e-9) next.distrust = Math.round(distrust * 1e6) / 1e6; else delete next.distrust;
          const out = list.slice(); out[idx] = next;
          recOut = rec; nextOut = next;
          return out;
        });
        // memory.feedback rung — telemetry/bus only (the trust fold already happened above; nobody re-folds it,
        // mirroring how the turn-in writer applies trust directly then emits). reason carries the rating verb.
        if (ctx && typeof ctx.emit === 'function') ctx.emit('memory.feedback', { agentId: aid, id: recOut.id, delta: delta, reason: rating });
        const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
        const sink = (Number(nextOut.distrust) || 0) !== (Number(recOut.distrust) || 0)
          ? ', distrust ' + r2(recOut.distrust) + ' → ' + r2(nextOut.distrust) + (rating === 'unhelpful' ? ' — it now ranks lower in recall' : '') : '';
        return { content: 'Marked ' + recOut.id + ' ' + rating + ' (trust ' + r2(recOut.trust) + ' → ' + r2(nextOut.trust) + sink + ').', summary: rating + ' ' + recOut.id };
      }
    };

    return {
      writeTool, readTool, feedbackTool,
      register(reg) { reg.register(writeTool); reg.register(readTool); reg.register(feedbackTool); return reg; }
    };
  }

  return { makeNotebookTools, reviseRecord };
});
