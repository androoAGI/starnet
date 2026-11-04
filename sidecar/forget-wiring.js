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

const { inScope } = ForgetRegistry;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// the source of a record composed from sessions' lines: its quote stamp (the streams it quoted, read when; draftStamp in index.js)
const stampSource = r => ({ quotes: r && r.quotes, quotesAt: r && r.quotesAt, quotesSaturatedAt: r && r.quotesSaturatedAt });
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
      if (out.removed) { d.interests.set(out.state); d.interests.persist(); }
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
      if (out.removed) { d.scout.set(out.state); d.scout.persist(); }
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

  return registry;
}

module.exports = { wireForgetRegistry };
