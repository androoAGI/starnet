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
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).notebook = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Compare against the version the caller actually read. A later edit must never be
  // overwritten by a stale correction; archive prior text outside active recall.
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
    return Object.assign({}, record, {
      title: change.title == null ? record.title : change.title,
      body: change.body, content: change.body, updatedAt: now,
      updatedSourceRunId: change.runId || null, revision: (record.revision || 0) + 1, history,
      confirmation: change.userConfirmed ? 'user-confirmed' : 'inferred', authority: 'reference-only',
      trust: 0, lastFeedbackAt: change.userConfirmed ? now : null, lastUsedAt: null, useCount: 0
    });
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
    const findSimilar = typeof deps.findSimilar === 'function' ? deps.findSimilar : (records, text, o) => {
      // inline Jaccard fallback (mirrors memcore.findSimilar/tokenJaccard) so this UMD tool stays dependency-free
      // in the browser build + standalone tests. Kept in sync with memcore — that is the canonical copy.
      const STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they').split(/\s+/));
      const toks = s => { const set = new Set(); for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !STOP.has(t)) set.add(t); return set; };
      const threshold = (o && typeof o.threshold === 'number') ? o.threshold : 0.6;
      const B = toks(text);
      for (const r of (Array.isArray(records) ? records : [])) {
        if (!r) continue;
        const A = toks(r.content != null ? r.content : ((r.title || '') + ' ' + (r.body || '')));
        if (!A.size || !B.size) continue;
        let inter = 0; for (const t of A) if (B.has(t)) inter++;
        if (inter / (A.size + B.size - inter) >= threshold) return r;
      }
      return null;
    };
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
        const scope = args.scope || (streamId ? 'stream' : 'global');
        if (scope === 'stream' && !streamId) throw new Error('stream memory requires an active stream');
        if (scope !== 'stream' && scope !== 'global') throw new Error('scope must be stream or global');
        const now = clock.now();
        // §5.2 record minted INSIDE the lock against the re-read list, so the id is collision-proof even if a
        // concurrent run/UI write changed the notebook since this run started (P1).
        let note = null, dupe = null;
        const overridden = !!(args && args.distinct);   // the agent SAW the near-dupe and judged this fact different
        await updateNotes(aid, (list) => {
          if (args.replaceId) {
            const at = list.findIndex(n => n.id === args.replaceId);
            note = reviseRecord(list[at], {
              previousBody: args.previousBody, title: redact(String(args.title)), body: redact(String(args.body)), runId
            }, now);
            if (args.scope) { note.scope = scope; note.streamId = scope === 'stream' ? streamId : null; note.projectRoot = scope === 'stream' ? ((ctx && ctx.projectRoot) || null) : null; }
            if (typeof args.pinned === 'boolean') note.pinned = args.pinned;
            list[at] = note;
            return list;
          }
          const text = String(args.title) + ' ' + String(args.body);
          // the near-dupe check runs INSIDE the lock against the RE-READ list — outside it, two concurrent runs
          // saving the same belief would both see a clean notebook and both append.
          dupe = list.find(n => Array.isArray(n.history) && n.history.some(h => h && String(h.body).trim() === String(args.body).trim())) ||
            (overridden ? null : findSimilar(list, text, { threshold: DUPE_THRESHOLD }));
          if (dupe) return undefined;   // nothing to write — skip the store write entirely
          note = {
            id: nextId(list), kind: 'note',
            title: redact(String(args.title)), body: redact(String(args.body)),   // §5.6: scrub secrets before they persist
            scope: scope, streamId: scope === 'stream' ? streamId : null, sourceRunId: runId,
            projectRoot: scope === 'stream' ? ((ctx && ctx.projectRoot) || null) : null,
            // which SURFACE formed this belief (memcore.originOf, injected on the run's tool ctx). Unattended runs
            // can write memory now, so the Commander must be able to tell a channel-learned fact from their own.
            origin: (ctx && ctx.origin) ? String(ctx.origin) : 'commander',
            createdAt: now, ts: now, lastUsedAt: null, useCount: 0, trust: 0, pinned: args.pinned === true
          };
          list.push(note);
          return list;
        });
        // ALREADY KNOWN: a success, not an error — an error makes a model retry with a reworded duplicate, which is
        // the exact behaviour this guard exists to stop. Show the belief it already holds IN FULL so the decision is
        // informed, and emit NOTHING (no memory.write, no deliverable): nothing was written, and a receipt for a
        // write that did not happen is the kind of claim truthful telemetry forbids.
        if (dupe) {
          const held = String(dupe.content != null ? dupe.content : (dupe.body != null ? dupe.body : '')).replace(/\s+/g, ' ').trim().slice(0, 300);
          return {
            content: 'Not saved — you already remember something very close:\n[' + dupe.id + '] ' + String(dupe.title || '') + ': ' + held + '\n\n' +
              'If that is the SAME belief, you are done — do not reword and retry. If this is genuinely a different fact ' +
              ', use distinct:true. If this is a CORRECTION, call notebook.write with replaceId:"' + dupe.id +
              '" and the exact current previousBody from notebook.read. That updates the existing entry; distinct:true does not.',
            summary: 'already known (' + dupe.id + ')'
          };
        }
        if (ctx && typeof ctx.emit === 'function') {
          // memory.write — the durable-memory rung (feeds useCount/trust + the dossier's archivist track). The
          // frozen contract requires runId, so emit only on a real run (some test fixtures carry no runId).
          // streamId is included only when present (the optional field is typed string — never emit a null).
          if (runId) { const w = { agentId: aid, runId, id: note.id, kind: 'note', scope: scope }; if (streamId) w.streamId = streamId; ctx.emit('memory.write', w); }
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
        return { content: (args.replaceId ? 'Updated' : 'Saved') + ' note "' + note.title + '" (' + note.id + ').' + (args.replaceId ? ' The previous text is archived and is no longer active recall.' : ''), summary: (args.replaceId ? 'updated ' : 'wrote ') + note.id };
      }
    };

    const readTool = {
      name: 'notebook.read', capability: 'memory', scope: 'read', requiresConsent: false,
      description: 'Read your notebook (your durable memory). Optional `query` returns the matching entries ranked by relevance (the same ' +
        'BM25 + trust + recency order auto-recall uses); omit it to list everything. Each line is prefixed with the entry id ([note_N]) ' +
        'you can pass to notebook.feedback.',
      schema: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        let list = notesOf(aid);
        const q = args && args.query;
        if (q) {
          const ql = String(q).toLowerCase();
          list = list.filter(n => (n.title + ' ' + n.body).toLowerCase().indexOf(ql) >= 0);
          // substring stays the GATE (predictable "no match"); rank() only REORDERS the matches so the most
          // relevant/trusted/pinned one leads — the explicit read now shares auto-recall's ranking, not raw
          // store order. k = list.length AND floor:false so ranking never truncates a match the gate already
          // admitted (a substring hit inside a longer token scores zero BM25 — rank's relevance floor would
          // silently drop it from an explicit read the gate said matched).
          if (rank && list.length > 1) list = rank(list, String(q), { now: clock.now(), k: list.length, floor: false });
        }
        if (!list.length) return { content: q ? 'No notes match "' + q + '".' : 'Your notebook is empty.', summary: '0 notes' };
        const body = list.map(n => '- [' + n.id + '] ' + n.title + ': ' + n.body).join('\n');
        // report the SIZE of the whole store on a filtered read, so the agent knows how much memory it is holding
        // (the reference harness puts a usage percentage in the system prompt; we have no cap to measure against,
        // but the count is the honest half of that signal — and it is the number a crowded notebook shows up in).
        const total = q ? notesOf(aid).length : list.length;
        const foot = q ? '\n\n(' + list.length + ' of ' + total + ' entries in memory)' : '';
        return { content: body + foot, summary: list.length + ' note(s)' };
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
            idx = list.findIndex(n => n && n.id === String(args.id));
            if (idx < 0) throw new Error('no memory has id "' + args.id + '"');
          } else if (args.match) {
            const m = String(args.match).toLowerCase();
            const hits = [];
            for (let i = 0; i < list.length; i++) {
              const n = list[i]; const text = (n.title + ' ' + n.body + ' ' + (n.content || '')).toLowerCase();
              if (text.indexOf(m) >= 0) hits.push(i);
            }
            if (!hits.length) throw new Error('no memory matches "' + args.match + '"');
            if (hits.length > 1) throw new Error('ambiguous: ' + hits.length + ' memories match "' + args.match + '" — use a more specific substring or the id from notebook.read');
            idx = hits[0];
          } else {
            throw new Error('provide an `id` or a `match` substring to identify the memory');
          }
          const rec = list[idx];
          const now = clock.now();
          const next = Object.assign({}, rec, { trust: nextTrust(rec.trust, delta), lastFeedbackAt: now });
          const out = list.slice(); out[idx] = next;
          recOut = rec; nextOut = next;
          return out;
        });
        // memory.feedback rung — telemetry/bus only (the trust fold already happened above; nobody re-folds it,
        // mirroring how the turn-in writer applies trust directly then emits). reason carries the rating verb.
        if (ctx && typeof ctx.emit === 'function') ctx.emit('memory.feedback', { agentId: aid, id: recOut.id, delta: delta, reason: rating });
        return { content: 'Marked ' + recOut.id + ' ' + rating + ' (trust ' + (Math.round(recOut.trust * 100) / 100) + ' → ' + (Math.round(nextOut.trust * 100) / 100) + ').', summary: rating + ' ' + recOut.id };
      }
    };

    return {
      writeTool, readTool, feedbackTool,
      register(reg) { reg.register(writeTool); reg.register(readTool); reg.register(feedbackTool); return reg; }
    };
  }

  return { makeNotebookTools, reviseRecord };
});
