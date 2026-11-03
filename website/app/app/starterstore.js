/* Ongoing personalized session ideas: bounded context cache, cancellation, explicit feedback,
   and exact draft -> run attribution through the existing recommendation ledger. */
'use strict';
const StarterStore = (() => {
  const KEY = 'starnet.session-ideas.v1', TTL = 6 * 3600000, GAP = 60000;
  let deps = {}, state, pending = null, epoch = 0, resetEpoch = 0, lastAttempt = 0, bound = false, queue = Promise.resolve();
  const now = () => deps.now ? deps.now() : Date.now();
  const engine = () => deps.engine || (typeof Starters !== 'undefined' ? Starters : null);
  const storage = () => deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const enabled = () => deps.enabled ? deps.enabled() : !(typeof ProfileStore !== 'undefined' && ProfileStore.enabled && !ProfileStore.enabled());
  function fresh() { return { cache: [], declined: [], accepted: [], drafts: {}, runs: {} }; }
  function load() {
    if (state) return state;
    try {
      const raw = JSON.parse(storage()?.getItem(KEY) || 'null');
      state = raw && raw.version === 1 ? { cache: Array.isArray(raw.cache) ? raw.cache.filter(c => c && typeof c.key === 'string' && Number.isFinite(c.at) && Array.isArray(c.ideas) && c.ideas.every(i => i && typeof i.id === 'string' && typeof i.label === 'string' && typeof i.prompt === 'string' && Array.isArray(i.evidence))).slice(-4) : [],
        declined: Array.isArray(raw.declined) ? raw.declined.filter(r => r && typeof r.title === 'string').slice(-100) : [], accepted: Array.isArray(raw.accepted) ? raw.accepted.filter(r => r && typeof r.title === 'string' && Number.isFinite(r.at)).slice(-60) : [],
        drafts: raw.drafts && typeof raw.drafts === 'object' ? raw.drafts : {}, runs: raw.runs && typeof raw.runs === 'object' ? raw.runs : {} } : fresh();
    } catch (_) { state = fresh(); }
    return state;
  }
  function save() { try { storage()?.setItem(KEY, JSON.stringify({ version: 1, ...state })); } catch (_) {} }
  function post(body) {
    const generation = resetEpoch;
    queue = queue.catch(() => {}).then(async () => {
      if (generation !== resetEpoch || !enabled()) return;
      const fetcher = deps.fetch || (typeof Harness !== 'undefined' && Harness.apiFetch);
      if (!fetcher) return;
      await fetcher('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).catch(() => {});
    return queue;
  }
  function exclusions() {
    load();
    return state.declined.map(r => r.title).concat(state.accepted.filter(r => now() - r.at < 14 * 86400000).map(r => r.title));
  }
  function allowed(idea) {
    const fp = engine().fingerprint(idea.label);
    if (exclusions().some(t => engine().fingerprint(t) === fp)) return false;
    try { if (typeof RecLedger !== 'undefined' && RecLedger.isDeclined(idea.label)) return false; } catch (_) {}
    return true;
  }
  const keyOf = (ctx, options) => JSON.stringify([ctx, options?.modelKey || '', options?.system || '']);
  function peek(ctx, options) {
    load();
    if (!enabled() || !ctx.enabled) return { status: 'paused', ideas: [] };
    if (!ctx.ready) return { status: 'cold', ideas: [] };
    const key = keyOf(ctx, options);
    const cached = state.cache.find(c => c.key === key && now() - c.at < TTL);
    if (cached) return { status: 'ready', ideas: cached.ideas.filter(allowed) };
    if (pending?.key === key) return { status: 'loading', ideas: [] };
    if (lastAttempt && now() - lastAttempt < GAP) return { status: 'cooldown', ideas: [], retryAt: lastAttempt + GAP };
    return { status: 'empty', ideas: [] };
  }
  async function request(ctx, options = {}) {
    const found = peek(ctx, options), key = keyOf(ctx, options);
    if (pending?.key === key) return pending.promise;
    if (['cold', 'paused', 'cooldown'].includes(found.status) || (found.status === 'ready' && !options.force)) return found;
    if (lastAttempt && now() - lastAttempt < GAP) return { status: 'cooldown', ideas: [], retryAt: lastAttempt + GAP };
    cancel();
    const ticket = { key, epoch, controller: new AbortController() };
    pending = ticket; lastAttempt = now();
    ticket.promise = (async () => {
      const deadline = setTimeout(() => ticket.controller.abort(), 45000);
      try {
        const generate = deps.generate || (o => Harness.chat(o));
        const response = await generate({ system: options.system || '', agentId: ctx.agentId, projectRoot: ctx.projectRoot || undefined, internal: true, evidence: true,
          isTask: false, placed: [], signal: ticket.controller.signal,
          messages: [{ role: 'user', content: engine().buildDirective(ctx, exclusions()) }] });
        if (ticket.epoch !== epoch || ticket.controller.signal.aborted || !enabled()) return { status: 'cancelled', ideas: [] };
        // only a reply whose run SUCCEEDED (review 7.1): Harness.chat hands back a cut, limited or stopped reply as { text, outcome } with no error
        if (!response || response.error || (response.outcome && response.outcome !== 'succeeded')) return { status: 'error', ideas: [] };
        const ideas = engine().parse(response.text, ctx, exclusions()).filter(allowed).map((idea, i) => ({ ...idea,
          id: 'session-idea:' + now() + ':' + i + ':' + Math.random().toString(36).slice(2, 10), agentId: ctx.agentId, projectRoot: ctx.projectRoot,
          createdAt: now(), shown: false }));
        state.cache = state.cache.filter(c => c.key !== key).concat({ key, at: now(), ideas }).slice(-4); save();
        return { status: 'ready', ideas };
      } catch (_) { return { status: ticket.epoch === epoch ? 'error' : 'cancelled', ideas: [] }; }
      finally { clearTimeout(deadline); if (pending === ticket) pending = null; }
    })();
    return ticket.promise;
  }
  function shown(idea) {
    if (idea.shown || !enabled()) return;
    idea.shown = true; save();
    post({ id: idea.id, surface: 'session-starters', kind: idea.kind, title: idea.label, target: idea.sessionId || idea.id,
      threadId: idea.sessionId || '', projectId: idea.projectRoot, traits: [idea.kind],
      evidence: idea.evidence.map(s => ({ id: s.id, type: s.type, quote: s.text })), readiness: { ready: true, reasons: ['specific-user-evidence'] },
      modelVersion: 'session-ideas-v1', expiresAt: now() + TTL });
  }
  function dismiss(idea) {
    load(); shown(idea);
    state.declined = state.declined.filter(r => r.title !== idea.label).concat({ title: idea.label, at: now() }).slice(-100); save();
    post({ id: idea.id, state: 'declined', reason: 'not_relevant' }).then(refreshLedger);
  }
  function prepare(idea, wsId, prompt) {
    load(); shown(idea);
    state.drafts[wsId] = { id: idea.id, title: idea.label, prompt: prompt.trim(), at: now() };
    state.drafts = Object.fromEntries(Object.entries(state.drafts).slice(-20)); save();
    post({ id: idea.id, state: 'opened' });
  }
  function claimDraft(wsId, text) {
    load(); const draft = state.drafts[wsId];
    delete state.drafts[wsId]; save();
    if (!draft || now() - draft.at > TTL || draft.prompt !== String(text || '').trim()) return null;
    state.accepted = state.accepted.concat({ title: draft.title, at: now() }).slice(-60); save();
    post({ id: draft.id, state: 'accepted', reason: 'accepted' });
    return draft.id;
  }
  function started(id, runId) {
    if (!id || !runId) return;
    load(); state.runs[runId] = { id }; state.runs = Object.fromEntries(Object.entries(state.runs).slice(-60)); save();
    post({ id, state: 'started', reason: 'accepted' });
  }
  function finished(p) {
    load(); const run = p && state.runs[p.runId];
    if (!run || run.finished || !(typeof RunOutcome !== 'undefined' ? RunOutcome.ofEnd(p, null).ok : p.reason === 'done')) return;   // (typed-outcomes) a SUCCEEDED run: a provider-cut 'done' is not clean
    run.finished = true; save(); post({ id: run.id, state: 'completed', reason: 'completed' });
    // Completion is execution evidence only; usefulness comes from the Commander's rating below.
  }
  function rated(runId, verdict) {
    load(); const run = state.runs[runId], quality = { great: 1, ok: 0.25, miss: -1 }[verdict];
    if (!run || run.rated || quality == null) return;
    run.rated = true; save(); post({ id: run.id, outcome: { runId, quality, completedAt: now() } }).then(refreshLedger);
  }
  function refreshLedger() { try { if (typeof RecLedger !== 'undefined') RecLedger.refresh(true); } catch (_) {} }
  function cancel() { epoch++; if (pending) pending.controller.abort(); pending = null; }
  function reset() { cancel(); resetEpoch++; state = fresh(); lastAttempt = 0; try { storage()?.removeItem(KEY); } catch (_) {} }
  function init(options = {}) {
    deps = options; state = null; load();
    if (!bound && typeof U !== 'undefined' && U.bus) { U.bus.on('agent.run.end', finished); bound = true; }
  }
  return { init, peek, request, shown, dismiss, prepare, claimDraft, started, finished, rated, cancel, reset, exclusions,
    _flush: () => queue, KEY, TTL, GAP };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { StarterStore };
