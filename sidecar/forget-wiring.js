/* sidecar/forget-wiring.js - WHICH STORES FORGET A DELETED SESSION, AND HOW (turn identity commit 12; qa/bugs/3e926b6a, 31042fab, 6e750350).

   wireForgetRegistry(registry, deps) registers every durable store that holds words DERIVED from a session - an interest, a staged
   draft, a verdict packet, a task brief, a golden, a study proposal, a deliverable row, a night-shift draft, a quest, an overseer
   thread, a worker record, an attachment file - and exempts, with a reason, every durable store that does not. index.js builds the
   registry once, beside forgetDeletedSessionMemory, and hands this module the stores; so adding a store never edits that hotfile's
   purge body again: one entry here, one line in the wiring block there.

   Each entry is { name, sourceOf(record), forget(scope) }:
     sourceOf  the source the store records on ONE record: { streamIds, runIds, rowIds, at } (any subset). It is what forget matches
               against the scope and what the write-time gate (registry.admit) is asked before a record is written.
     forget    removes what the scope names (ForgetRegistry.inScope over sourceOf) and returns how many records went. Idempotent: a
               pass that failed half-way runs again for the same stamp, and the catch-up (session-tombstones repurge) runs every entry
               again once per registry VERSION for the deletes made before an upgrade.

   Every dep is read inside a closure, never at wiring time: the stores are built later in index.js than the registry.

   WHAT IS KEPT ON PURPOSE (exemptions, Q4): routines the Commander created (cron-jobs), delivered workspace files, learned skill
   files, and the stores whose records hold no words of a session (counters, ids, settings, secrets). Each is named below with its
   reason, and test/forget-registry.census.test.js requires one of the two for every durable store the sidecar writes. Adopted stamps
   (a delete made before the ledger's first read, I7 limit d) are never purged by any entry: the ledger never hands them to a pass. */
'use strict';

const ForgetRegistry = require('./forget-registry.js');
const SessionTombstones = require('./session-tombstones.js');
const Interests = require('./interests.js');
const Scout = require('./scout.js');
const QuestRefresh = require('./questrefresh.js');

const { inScope } = ForgetRegistry;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// the source of a record composed from sessions' lines: its quote stamp (the streams it quoted, read when; draftStamp in index.js)
const stampSource = r => ({ quotes: r && r.quotes, quotesAt: r && r.quotesAt, quotesSaturatedAt: r && r.quotesSaturatedAt });
// a store keeps the value it replaced as its .bak: a changed store is saved twice, so the purged copy is the .bak too
const settle = persist => { persist(); persist(); };
const latestStamp = scope => { let l = 0; for (const w of (scope.streams || scope.at || new Map()).values()) if (w > l) l = w; return l; };

function wireForgetRegistry(registry, deps) {
  const d = deps || {};
  const entry = e => registry.register(e);

  /* the notebook, the pending proposals and the open threads a deleted session wrote (session-tombstones forgetSessionMemory): the
     records CREATED in it go, the versions its runs wrote leave records created elsewhere, a rating verdict keeps the Commander's
     words without the deleted work. The scope carries the runs that QUOTE a deleted session too, so the reading run's own notes go. */
  entry({
    name: 'notebook-memory',
    sourceOf: r => ({ streamIds: [r && r.streamId], runIds: [r && (r.sourceRunId || r.runId)], at: num(r && (r.createdAt || r.ts)) }),
    forget: async scope => {
      const counts = await SessionTombstones.forgetSessionMemory({ store: d.notebookStore(), threads: d.threadsStore(), agentIds: d.memoryAgentIds(), scope });
      return { removed: counts.notes + counts.revisions + counts.verdicts + counts.pending + counts.threads, counts };
    }
  });

  /* a delete bumps the personalization revision, so a learning pass that started before it (learningUnchangedSince) drops what it
     was about to fold instead of writing it after the purge */
  entry({
    name: 'personalization-revision',
    sourceOf: () => ({}),
    forget: async () => { await d.personalization().markForgotten(d.now()); return 0; }
  });

  /* trusted interest evidence: every quote records the owner row it was quoted from (src { streamId, runId, rowId }, off the context pack's
     parallel activity[].src). A topic with ANY quote from a deleted session is dropped whole (its label is the model's summary of those
     lines); quarantined evidence is unproven, so a purge does not read it as a source. The match is by stream and row, not by run: an
     interest drawn from a directive the Commander typed stays when that run later read a deleted session. */
  const interestSource = (src, ev) => ({ streamIds: [src.streamId], rowIds: [src.rowId], at: num(ev && ev.at) });
  entry({
    name: 'interests',
    sourceOf: ev => interestSource(ev.src || {}, ev),
    forget: scope => {
      const out = Interests.purge(d.interests.get(), (src, ev) => inScope(interestSource(src, ev), scope));
      if (out.removed) { d.interests.set(out.state); settle(d.interests.persist); }
      return out.removed;
    }
  });

  /* the scout's staged drafts and attempt notes quote the activity lines and interests the cycle's prompt held (quote stamp, draftStamp in
     index.js). A staged draft with NO stamp predates sources and may quote any session: it goes with the first delete after it (it is
     re-minted from what is still there), because staged drafts ride later prompts as the names a new draft must not repeat. */
  entry({
    name: 'scout',
    sourceOf: it => stampSource(it),
    forget: scope => {
      const latest = latestStamp(scope);
      const out = Scout.drop(d.scout.get(), it => (it.quotes ? inScope(stampSource(it), scope) : !!it.draft && num(it.at) <= latest));
      if (out.removed) { d.scout.set(out.state); settle(d.scout.persist); }
      return out.removed;
    }
  });

  /* the cross-surface recommendation ledger: an entry composed from sessions carries the quote stamp too. One the Commander DECLINED keeps
     its decision (the reject list and the preference sample) and loses its evidence quotes; any other goes whole. */
  entry({
    name: 'recommendations',
    sourceOf: e => stampSource(e),
    forget: scope => d.recommendations().forget(e => inScope(stampSource(e), scope))
  });

  /* verdict-review packets: a parked packet (the run's transcript tail and directive, kept so a later rating can teach a skill) and a held
     review (armed by a rating, waiting out its grace) are copies of the run's words. Source: the packet's stream and directive row, and
     the run itself - so the run that READ a deleted session loses its packet too. A held review is cancelled, not run. */
  const packetSource = (runId, packet, at) => ({ streamIds: [packet && packet.streamId], runIds: [runId],
    rowIds: [packet && packet.directive && packet.directive.rowId], at: num(at) });
  entry({
    name: 'verdict-packets',
    sourceOf: row => packetSource(row && row.runId, row && row.packet, row && row.at),
    forget: scope => d.verdictReview().forget((runId, packet, at) => inScope(packetSource(runId, packet, at), scope))
  });

  /* task briefs: the Commander's directive, the questions asked and the answers given, per conversation. Source: the brief's stream and
     directive row and the runs that opened and completed it. patterns() also asks the registry's read-time belt, so an answered question of a
     deleted session is never offered as an OBSERVED PATTERN while a purge is pending. */
  const briefSource = b => ({ streamIds: [b && b.streamId], runIds: [b && b.originalRunId, b && b.runId], rowIds: [b && b.directiveRowId], at: num(b && b.createdAt) });
  entry({
    name: 'task-briefs',
    sourceOf: briefSource,
    forget: scope => d.taskBriefs().forget(b => inScope(briefSource(b), scope))
  });

  /* skill goldens: a great-rated run frozen per skill - its directive and the start of its output, kept to measure later runs against. Source:
     the run (the scope names every run filed in a deleted session and every run that quoted one). A skill whose last golden goes keeps no key. */
  const goldenSource = g => ({ runIds: [g && g.runId], at: num(g && g.mintedAt) });
  entry({
    name: 'skill-goldens',
    sourceOf: goldenSource,
    forget: scope => {
      const cur = d.goldens.get() || {};
      const next = {};
      let removed = 0;
      for (const key of Object.keys(cur)) {
        const list = Array.isArray(cur[key]) ? cur[key] : [];
        const keep = list.filter(g => !inScope(goldenSource(g), scope));
        removed += list.length - keep.length;
        if (keep.length || !list.length) next[key] = keep;
      }
      if (removed) settle(() => d.goldens.persist(next));
      return removed;
    }
  });

  /* study proposals: belief updates a finished run's aux pass proposed, held server-side until the Commander turns them in. Source: the run
     the pass studied and the runs its proposals cite. A proposal citing a deleted session's run goes alone; a run whose proposals all go
     leaves no entry (and no 'latest' pointer to it). The browser-owned `declined` mirror beside it is a reject list: kept (Q5). */
  const studyRuns = e => [e && e.runId].concat(((e && e.proposals) || []).flatMap(p => [p && p.sourceRunId, p && p.evidenceRef && p.evidenceRef.runId]));
  entry({
    name: 'study-proposals',
    sourceOf: e => ({ runIds: studyRuns(e), at: num(e && e.createdAt) }),
    forget: scope => {
      const byRun = d.study.byRun(), latest = d.study.latest();
      let removed = 0;
      for (const [runId, e] of Array.from(byRun)) {
        if (inScope({ runIds: [runId, e && e.runId] }, scope)) { byRun.delete(runId); removed++; continue; }
        const proposals = Array.isArray(e && e.proposals) ? e.proposals : [];
        const keep = proposals.filter(p => !inScope({ runIds: [p && p.sourceRunId, p && p.evidenceRef && p.evidenceRef.runId] }, scope));
        if (keep.length === proposals.length) continue;
        removed += proposals.length - keep.length;
        if (keep.length) byRun.set(runId, Object.assign({}, e, { proposals: keep })); else byRun.delete(runId);
      }
      for (const [agent, runId] of Array.from(latest)) if (!byRun.has(runId)) latest.delete(agent);
      if (removed) settle(d.study.persist);
      return removed;
    }
  });

  /* the deliverables library: the lifecycle rows (kept, discarded, failed, implemented) of what a run built, with the title, summary and file
     names, and the cleanup undo batches that hold copies of removed rows. Source: the run. The files themselves are delivered workspace files
     and stay (Q4); the store holds metadata only. */
  const deliverableSource = r => ({ runIds: [r && r.runId], at: num(r && r.createdAt) });
  entry({
    name: 'deliverables',
    sourceOf: deliverableSource,
    forget: scope => d.deliverables().forget(r => inScope(deliverableSource(r), scope))
  });

  /* the night shift's desk drafts (title and body of what a beat produced, read by the morning digest and by PriorWork into later beats), its
     act ledger (which archetype a run served) and the away workshop's queued jobs. A beat is composed from the context pack's sessions, so a
     draft or a job carries the quote stamp (draftStamp / quotedStamp in index.js) and the act's run; the run's own record is quote-stamped too.
     A draft or a job queued by the night shift with NO stamp predates sources and may quote any session: it goes with the first delete after it
     (a job already BUILT stays, its deliverable row and files are the Commander's to keep or discard). */
  const draftSource = x => ({ runIds: [x && x.runId], quotes: x && x.quotes, quotesAt: x && x.quotesAt, quotesSaturatedAt: x && x.quotesSaturatedAt, at: num(x && x.at) });
  entry({
    name: 'night-drafts',
    sourceOf: draftSource,
    forget: scope => {
      const latest = latestStamp(scope);
      const cur = d.nightDrafts.get() || [];
      const keep = cur.filter(x => !(x && (inScope(draftSource(x), scope) || (!x.quotes && !x.runId && num(x.at) <= latest))));
      const removed = cur.length - keep.length;
      if (removed) { d.nightDrafts.set(keep); settle(d.nightDrafts.persist); }
      return removed;
    }
  });
  entry({
    name: 'night-acts',
    sourceOf: act => ({ runIds: [act && act.runId], at: num(act && act.at) }),
    forget: scope => {
      const acts = d.nightActs.get() || {};
      let removed = 0;
      for (const runId of Object.keys(acts)) if (inScope({ runIds: [runId], at: num(acts[runId] && acts[runId].at) }, scope)) { delete acts[runId]; removed++; }
      if (removed) settle(d.nightActs.persist);
      return removed;
    }
  });
  const jobSource = x => ({ runIds: [x && x.runId, x && x.builtRunId, x && x.buildingRunId], quotes: x && x.quotes, quotesAt: x && x.quotesAt, quotesSaturatedAt: x && x.quotesSaturatedAt, at: num(x && (x.ts || x.at)) });
  entry({
    name: 'workshop-backlog',
    sourceOf: jobSource,
    forget: async scope => {
      const latest = latestStamp(scope);
      let removed = 0;
      for (const agentId of d.workshopAgentIds()) {
        removed += await d.workshop().forget(agentId, x => inScope(jobSource(x), scope)
          || (x && x.source === 'nightshift' && !x.quotes && !x.builtRunId && !x.buildingRunId && num(x.ts) <= latest));
      }
      return removed;
    }
  });

  /* quests and the north star. A generated quest (minted by the quest refresh from the context pack) and an inferred north star carry the quote
     stamp of the sessions they were inferred from; the pass's ledger notes and staged quests do too. A generated OPEN quest with no stamp
     predates sources and rides every run's context (questinject) until completed, so it goes with the first delete after it (the next refresh
     mints it again from what is still there); a quest the Commander completed or dismissed, the declined-inference list and the dismissed-forever
     titles stay. The Commander's own goal-arc star carries no stamp and is never dropped. */
  const stampedSource = x => ({ quotes: x && x.quotes, quotesAt: x && x.quotesAt, quotesSaturatedAt: x && x.quotesSaturatedAt });
  entry({
    name: 'quests',
    sourceOf: stampedSource,
    forget: scope => {
      const latest = latestStamp(scope);
      return d.quests().forget(q => (q.quotes ? inScope(stampedSource(q), scope) : q.kind === 'generated' && q.status === 'open' && num(q.createdAt) <= latest));
    }
  });
  entry({
    name: 'north-star',
    sourceOf: stampedSource,
    forget: scope => {
      const latest = latestStamp(scope);
      // a pending inference or staged quest with no stamp predates sources: dropped (the next cycle infers again); notes and an adopted star only by stamp
      const out = QuestRefresh.drop(d.northStar.get(), x => (x.quotes ? inScope(stampedSource(x), scope)
        : ((x.status === 'proposed' && num(x.at) <= latest) || (!!x.contract && !x.outcome))));
      if (out.removed) { d.northStar.set(out.state); settle(d.northStar.persist); }
      return out.removed;
    }
  });

  /* the away briefing's state: the last briefing delivered (its items name the runs and sessions it summarised, with an excerpt of each run's own
     words) is read back by the page and rides the Commander's evidence into later runs. It carries the stamp of the sessions it summarised (the
     briefing row in the 'briefing' stream carries the same one), and one with no stamp predates sources and goes with the first delete after it.
     The 'briefed through' time stays: forgetting must not make the station brief the same runs again. */
  entry({
    name: 'away-briefing',
    sourceOf: last => stampedSource(last),
    forget: async scope => {
      const latest = latestStamp(scope);
      let removed = 0;
      const mutate = raw => {
        const st = raw && typeof raw === 'object' ? raw : {};
        const last = st.last && typeof st.last === 'object' ? st.last : null;
        if (!last || !(last.quotes ? inScope(stampedSource(last), scope) : num(last.at) <= latest)) return undefined;
        removed = 1;
        return Object.assign({}, st, { last: null });
      };
      await d.awayBriefing().update('briefing', mutate);
      if (removed) await d.awayBriefing().update('briefing', raw => Object.assign({}, raw));   // written twice: the .bak holds the purged copy
      return removed;
    }
  });

  /* delegated threads and hand-off reports (overseer.json): a thread's title and a report's error line are words of the session the lead
     delegated from. Source: the thread's own id and parent session, the lead run that filed it, a report's sessions and runs. */
  entry({
    name: 'overseer',
    sourceOf: x => ({ streamIds: [x && x.id, x && x.parentStreamId], runIds: [String((x && x.requestId) || '').split(':')[0]], at: num(x && x.createdAt) }),
    forget: scope => d.overseer().forget(src => inScope(src, scope))
  });

  /* worker records (subagents.json): the lead's brief, the worker's result and its event tail. A settled record goes; a worker still running
     keeps its place and loses only those words. */
  entry({
    name: 'subagents',
    sourceOf: r => ({ streamIds: [r && r.parentStreamId, r && r.streamId], runIds: [r && r.runId, r && r.parentRunId], at: num(r && (r.startedAt || r.updatedAt)) }),
    forget: scope => d.subagents().forget(r => inScope({ streamIds: [r.parentStreamId, r.streamId], runIds: [r.runId, r.parentRunId], at: num(r.startedAt || r.updatedAt) }, scope))
  });

  return registry;
}

module.exports = { wireForgetRegistry };
