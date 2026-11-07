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
const SteeringMessage = require('../frontend/app/steering-message.js');

const { inScope } = ForgetRegistry;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// the source of a record composed from sessions' lines: its quote stamp (the streams it quoted, read when; draftStamp in index.js)
const stampSource = r => ({ quotes: r && r.quotes, quotesAt: r && r.quotesAt, quotesSaturatedAt: r && r.quotesSaturatedAt });
// a store keeps the value it replaced as its .bak: a changed store is saved twice, so the purged copy is the .bak too
const settle = persist => { persist(); persist(); };
const latestStamp = scope => { let l = 0; for (const w of (scope.streams || scope.at || new Map()).values()) if (w > l) l = w; return l; };

/* WHAT NAMES AN UPLOAD (a file under the agent workspace's .attachments/). A directive row's attachments[]; a row of kind 'attachment' of
   its own (attachment-rows: r.attachment = { id, name, mime, path }); a steer row's held wire (auto-steer: a message sent mid-run names its
   files only inside steeringWire, never in attachments[]). A page message names its files the same ways. */
const wiredOf = r => { const m = r && typeof r.steeringWire === 'string' ? SteeringMessage.decode(r.steeringWire) : null; return (m && m.attachments) || []; };
const refsOf = r => (r && Array.isArray(r.attachments) ? r.attachments : []).concat(r && r.kind === 'attachment' && r.attachment ? [r.attachment] : [], wiredOf(r));

/* namedElsewhere({ store, saveStore, paths, except?, onDoubt? }) -> Set: the paths of `paths` that something live still names, or may.
   Three callers: the attachment-files entry below (a deleted session's uploads), the page's own delete of a deleted session's uploads
   (index.js POST /api/attachments with `paths` and the session's id), which cannot see a packed session's rows (save v7), and the
   composer's one-file delete. Live is:
     - a row of a live session anywhere in the transcript: every durable row (store.eachRow), not only the newest rows the RAM mirror
       holds, and the RAM mirror itself (a fail-open write can sit there alone). A path the walk cannot rule out (a damaged line names it,
       or a segment is gone for good) counts as named and onDoubt(paths, why) hears it: that file stays, and the rest are still proved;
     - a message of a session in the page's own save, a packed run's residue included: a /branch copy is the page's alone in this release
       (its copied turns are never written to the transcript), so a file it shares with the deleted session is named only there.
   A deleted session's rows and messages from before its delete name nothing (store.isForgotten), and neither does anything of a stream in
   `except` (a session whose delete has not reached the ledger yet). Throws, so the caller removes nothing, while that cannot be proved:
   the transcript cannot be walked now, or the save cannot be read (unreadable, corrupt, quarantined and not yet written again, or no save
   store at all). Not seen (a known gap): a /branch copy that so far lives only in another window's memory, not yet pushed to the station. */
function namedElsewhere(o) {
  const store = o.store, named = new Set();
  const wanted = new Set((Array.isArray(o.paths) ? o.paths : []).filter(p => typeof p === 'string' && p));
  const except = new Set((Array.isArray(o.except) ? o.except : []).filter(s => typeof s === 'string' && s));
  const unnamed = () => Array.from(wanted).filter(p => !named.has(p));
  const note = r => { for (const a of refsOf(r)) if (a && typeof a.path === 'string' && wanted.has(a.path)) named.add(a.path); };
  const live = r => !!r && !except.has(r.streamId) && !store.isForgotten(r);
  const unproven = why => Object.assign(new Error(why + ', so no upload is proved unused'), { code: 'FORGET_UNPROVEN' });
  if (!wanted.size) return named;
  for (const r of store.all()) if (live(r)) note(r);
  if (unnamed().length) {
    const walk = store.eachRow(r => { if (live(r)) note(r); }, { claims: unnamed() });
    const doubted = (walk && Array.isArray(walk.doubted) ? walk.doubted : []).filter(p => wanted.has(p) && !named.has(p));
    for (const p of doubted) named.add(p);
    if (doubted.length && typeof o.onDoubt === 'function') o.onDoubt(doubted, walk.unread && walk.unread.length ? 'transcript segment ' + walk.unread.join(', ') + ' is gone' : 'a damaged transcript line may name them');
  }
  if (!unnamed().length) return named;
  if (!o.saveStore) throw unproven('the station save is not wired');
  const saved = o.saveStore.loadState('agent');
  if (saved && saved.status === 'absent') {
    // no save at all is a new station, which holds no page-only copy, unless a copy of a save sits beside it (a quarantined or lost primary
    // the page has not written again yet): that copy may hold a /branch copy, so nothing is proved until the page writes
    let kept = true;
    try { kept = typeof o.saveStore.hasRecoveryCopy === 'function' ? o.saveStore.hasRecoveryCopy('agent') !== false : true; } catch (_) { kept = true; }
    if (!kept) return named;
    throw unproven('the station save is missing beside a kept copy of it');
  }
  // 'recovered': the primary was bad and its clean .bak is the station's authoritative copy (the boot reads it the same way)
  if (!saved || (saved.status !== 'ok' && saved.status !== 'recovered') || !saved.doc || typeof saved.doc !== 'object') {
    throw unproven('the station save could not be read (' + ((saved && saved.status) || 'no answer') + ')');
  }
  for (const w of (Array.isArray(saved.doc.workstreams) ? saved.doc.workstreams : [])) {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string' || except.has(w.id) || !Array.isArray(w.history)) continue;
    for (const el of w.history) {
      if (!el || typeof el !== 'object') continue;
      // a packed run (save v7, historyref.js) keeps each row's page-only fields as residue: res = { <index>: fields }
      const messages = typeof el.$ref === 'string' ? (el.res && typeof el.res === 'object' ? Object.values(el.res) : []) : [el];
      for (const m of messages) if (m && typeof m === 'object' && !store.isForgotten({ streamId: w.id, ts: num(m.ts) })) note(m);
    }
  }
  return named;
}

/* THE CENSUS TABLE. Every durable store the sidecar writes - each saveResilient(<NAME>_FILE), each makeDurableJsonStore / makeDomainStore
   (named by its const in index.js, by its file elsewhere) and each memory-store key prefix - is a row here: it is purged by a registered entry,
   or kept ON PURPOSE with the reason. test/forget-registry.census.test.js scans the whole sidecar for those stores and fails on one that has no
   row (a new store must choose) and on a row whose store is gone. Row: [census key, 'entry', registry entry name] or
   [census key, 'exempt', exemption name | '', reason] (an empty name = the key). */
const STORES = [
  // ---- purged by a registered entry ----
  ['INTERESTS_FILE', 'entry', 'interests'],
  ['SCOUT_FILE', 'entry', 'scout'],
  ['recommendation-ledger.js', 'entry', 'recommendations'],
  ['VERDICT_PACKETS_FILE', 'entry', 'verdict-packets'],
  ['taskbrief-store.js', 'entry', 'task-briefs'],
  ['SKILL_GOLDENS_FILE', 'entry', 'skill-goldens'],
  ['STUDY_STATE_FILE', 'entry', 'study-proposals'],
  ['deliverable-store.js', 'entry', 'deliverables'],
  ['NIGHTSHIFT_DRAFTS_FILE', 'entry', 'night-drafts'],
  ['NIGHTSHIFT_ACTS_FILE', 'entry', 'night-acts'],
  ['workshop-store.js', 'entry', 'workshop-backlog'],
  ['quest-store.js', 'entry', 'quests'],
  ['QUESTREFRESH_FILE', 'entry', 'north-star'],
  ['awayBriefingStore', 'entry', 'away-briefing'],
  ['DOSSIER_FILE', 'entry', 'commander-dossier'],
  ['AUTONOMY_POSTURE_FILE', 'entry', 'commander-posture'],
  ['overseer.js', 'entry', 'overseer'],
  ['group-sessions.js', 'entry', 'group-sessions'],
  ['summary-ledger.js', 'entry', 'conversation-summary'],
  ['lineJobStore', 'entry', 'line-jobs'],
  ['memory:notebook', 'entry', 'notebook-memory'],
  ['memory:pending', 'entry', 'notebook-memory'],
  ['threads-store.js', 'entry', 'notebook-memory'],
  // ---- kept on purpose, with the reason ----
  ['CRON_FILE', 'exempt', 'cron-jobs', 'Q4: routines the Commander created are kept - a routine is the Commander\'s own configuration, not a memory of a session'],
  ['CRON_ARMED_FILE', 'exempt', '', 'the arm switch of those routines (a flag and a time)'],
  ['CRON_HALT_FILE', 'exempt', '', 'the halt switch of those routines (a flag and a time)'],
  ['LOOPS_FILE', 'exempt', '', 'Q4: loops the Commander created are kept, like routines - configuration, not a memory'],
  ['LOOPS_HALT_FILE', 'exempt', '', 'the halt switch of those loops (a flag and a time)'],
  ['TURN_IDENTITY_FILE', 'exempt', 'turn-identity-mode', 'turn-identity surface modes only (a mode name per surface)'],
  ['memory:declined', 'exempt', 'declined', 'Q5: the Commander\'s own reject list - plain strings kept on disk and in host dedup so a rejected proposal is never made again; from the first non-adopted delete reflect gets them as dedupOnly, so none reaches a prompt (commit 15)'],
  ['memory:todo', 'exempt', '', 'the agent\'s in-session task plan (todo tool): no source is recorded on its items and it is replaced on every plan write; a known gap, noted for a follow-up - it can only be cleared wholesale'],
  ['memory:embed', 'exempt', '', 'embedding vectors (numbers) keyed by notebook record ids; the notebook-memory entry removes the records and a vector without a record is never served'],
  ['memory:minted', 'exempt', '', 'the mint ledger: fingerprints and counts of routines an agent created (dedup), no session text'],
  ['memory-store.js', 'exempt', '', 'the key-value router itself; every key prefix it serves has its own row (memory:*)'],
  ['personalization-store.js', 'exempt', '', 'the learning switch and its revision counter; the personalization-revision entry bumps the revision on a delete so a learning pass that began before it writes nothing'],
  ['AGENT_ROSTER_FILE', 'exempt', '', 'the crew roster: agent definitions the Commander wrote (names, models, personas), not derived from a session'],
  ['ALLOWLIST_FILE', 'exempt', '', 'the tool and path allowlist the Commander granted'],
  ['BYPASS_FILE', 'exempt', '', 'a consent flag and its time'],
  ['PROJECTS_FILE', 'exempt', '', 'the project registry (folders the Commander blessed)'],
  ['GOALS_FILE', 'exempt', '', 'the Commander\'s own active goal, in the Commander\'s words'],
  ['NIGHTFOCUS_STATE_FILE', 'exempt', '', 'the night focus steer the Commander chose and its settings'],
  ['NIGHTSHIFT_STATE_FILE', 'exempt', '', 'whether the night shift is enabled and its cadence'],
  ['NIGHTSHIFT_LEARN_FILE', 'exempt', '', 'per-archetype up and down verdict tallies (counts only, no text)'],
  ['DISCOVERY_FILE', 'exempt', '', 'project discovery findings read from the Commander\'s folders on disk, not from a session'],
  ['SCHEMA_VERSION_FILE', 'exempt', '', 'the workspace schema version stamp'],
  ['BROWSER_SETTINGS_FILE', 'exempt', '', 'a browser setting the Commander chose'],
  ['EXECUTION_SETTINGS_FILE', 'exempt', '', 'an execution setting the Commander chose'],
  ['RUNTIME_KNOBS_FILE', 'exempt', '', 'runtime tuning settings (numbers and switches)'],
  ['TOOLSETS_FILE', 'exempt', '', 'which tool sets are disabled (a setting)'],
  ['STEPTEST_FILE', 'exempt', '', 'step-test state of a work line (spend and ids)'],
  ['CHANNEL_SECRETS_FILE', 'exempt', '', 'a credential store (secrets, not derived from a session)'],
  ['CODEX_TOKENS_FILE', 'exempt', '', 'a credential store (OAuth tokens)'],
  ['SERVICEKEYS_FILE', 'exempt', '', 'a credential store (service keys)'],
  ['SKILLS_ALLOW_FILE', 'exempt', '', 'learned skill files (Q4): the Commander\'s approvals of reviewed skill bytes'],
  ['SKILL_EVALUATIONS_FILE', 'exempt', '', 'learned skill files (Q4): behavioural comparison receipts of skill candidates'],
  ['SKILL_REGISTRIES_FILE', 'exempt', '', 'skill registry sources (urls the Commander added)'],
  ['SKILL_METRICS_FILE', 'exempt', '', 'skill usage counters'],
  ['SKILL_NUDGE_FILE', 'exempt', '', 'a per-agent turn counter'],
  ['budgetStore', 'exempt', '', 'spending caps and counters (numbers)'],
  ['fallbackStore', 'exempt', '', 'the provider fallback chain (a setting)'],
  ['voiceChatStore', 'exempt', '', 'voice-chat model settings'],
  ['memoryConfigStore', 'exempt', '', 'memory settings (switches and thresholds)'],
  ['lineSpendStore', 'exempt', '', 'work-line spend counters'],
  ['lineShipmentStore', 'exempt', '', 'work-line shipment receipts (ids and states, no title)'],
  ['triggerStore', 'exempt', '', 'trigger runner configuration the Commander made'],
  ['triggerSeenStore', 'exempt', '', 'trigger runner dedup state (hashes of items already seen)'],
  ['widgetStore', 'exempt', '', 'widgets placed on the desk: delivered artifacts, kept like delivered workspace files (Q4)'],
  ['appDataStore', 'exempt', '', 'data an installed app keeps for itself, not derived from a session'],
  ['pluginDataStore', 'exempt', '', 'data an installed plugin keeps for itself, not derived from a session'],
  ['terminalMetadataStore', 'exempt', '', 'metadata of the Commander\'s terminal sessions (not conversation sessions)'],
  ['idempotency-ledger.js', 'exempt', '', 'receipts of external connector writes keyed by hashes (a safety record: it stops a write being repeated)'],
  ['journey-store.js', 'exempt', '', 'the Commander\'s verified progression: outcomes the Commander or a harness contract confirmed, kept as earned'],
  ['request-reservations.js', 'exempt', '', 'API request ids and hashes (24 hour receipts)'],
  ['workflow-takeover.js', 'exempt', '', 'offer decisions keyed by workflow fingerprint (state and time)'],
  ['session-tombstones.js', 'exempt', '', 'the ledger of deletes itself: ids and times only - it IS the record the purge reads']
];
// stores no pattern above can see, with the entry or exemption that covers them
const UNKEYED_ENTRIES = {
  'subagents': 'subagents.json: the manager owns its own writer',
  'attachment-files': 'bytes under the agent workspace .attachments/ (files, not a JSON store)',
  'personalization-revision': 'no store of its own: it bumps the revision of personalization-store.js',
  'save-pre-history-ref': '<agent>.save.pre-history-ref.json: the station save as it was before v7, kept once for a downgrade (savestore.js scrubKept); its 30 day expiry is the timer of the save store itself and does not depend on this entry'
};
const UNKEYED_EXEMPTIONS = [
  ['turn-identity-soak', 'turn-identity.soak.json: ids, counts and hashes only (the soak ledger), no text of a session'],
  ['run-journal', 'the journals of interrupted runs (.run-journal): an unmatched tool intent in one is the only evidence a side effect may have happened, so the file stays until the Commander resolves it; a run that began in, or read, a deleted session is never offered, prepared or continued (runRecoveryForgotten)'],
  ['delivered-workspace-files', 'Q4: files an agent delivered into its workspace are the Commander\'s work product and stay (the deliverables entry removes the library rows that pointed at them)'],
  ['learned-skill-files', 'Q4: skill files an agent learned stay; goldens and verdict packets, which copy a run, are purged'],
  ['channel-legacy-files', 'the per-chat legacy history mirrors of the channel store (and their .bak and legacy-hops files): read only by the rollback path; the store cannot attribute a file to a stream (the hub\'s agentIdFor owns that mapping), so a delete cannot find it - a known gap, noted for a follow-up'],
  ['station-save-bak', 'the previous committed generation of the station save (<agent>.save.json.bak): persist keeps exactly one, so a just-deleted chat can sit in it until the next save replaces it. Under the v7 format the save carries a chat as its packed run ids (the words live in the transcript, which the delete cuts), so what it holds is ids and titles, not turns; it is the only copy the station can recover a torn main from, so purging it would trade a recovery for a smaller window. Named here so it is a decision, not an oversight (a known gap, noted for a follow-up)'],
  ['recovery-copies', 'workspace-recovery keeps the whole old station root as a sibling <root>.recovery-rollback-* until the Commander discards it, and station-recovery bundles carry every chat as text: both are recovery copies of the station AS IT WAS, including chats deleted since. They are made on the Commander\'s own command, shown to the Commander, and removed by the Commander; the delete does not reach into them (a known gap, noted for a follow-up)'],
  ['checkpoint-shadow-repos', 'WORKSPACES/.checkpoints/<agent>/git: restore points of the agent\'s workspace. An upload (.attachments/) is excluded from every new snapshot (checkpoint-store.js info/exclude), and the repo of an agent whose history holds a deleted session\'s upload is replaced by one baseline (forgetAttachments, called by the attachment-files entry), so its older rollback points are lost. Delivered work files in it are the Commander\'s work product (Q4)'],
  ['restored-save-copies', 'a ~restored copy is a workstream row of the PAGE\'s own save (its id is not a valid stream id, so the ledger cannot stamp it); the page\'s delete purges it with the session (commit 16). A file a run in the copy sent stays: that run\'s rows are filed under the global stream, and they name it']
];

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

  /* attachment files: the bytes the agent's file tools can read under its workspace's .attachments/. A deleted session's rows name them
     (refsOf, read through the PROOF view, which still sees forgotten rows). A named file is removed, through the attachments module's own
     removeAttachment, only when nothing live still names it (namedElsewhere above: every durable row of a live session, the RAM mirror, and
     every session of the page's own save, where a /branch copy lives), so a re-send or a branch keeps the file it shares. A file the
     transcript cannot rule out (a damaged line may name it, or a segment is gone for good) is kept, and the pass goes on and settles, also when
     such a line or segment sits among the deleted session's own rows (a file only those rows named cannot be found, and stays). While
     the proof cannot be made at all (the transcript cannot be walked now, the save cannot be read), the pass fails and keeps every file;
     the delete is retried at the next boot or delete. Refs on pre-upgrade rows exist only in the page's own save - the page's delete posts
     those (commit 16). */
  entry({
    name: 'attachment-files',
    sourceOf: ref => ({ streamIds: [ref && ref.streamId], at: num(ref && ref.ts) }),
    forget: async scope => {
      const store = d.transcriptStore();
      const doomed = new Map();   // path -> agentId
      const doom = r => { for (const a of refsOf(r)) if (a && typeof a.path === 'string') doomed.set(a.path, r.agentId || 'agent'); };
      const refused = new Map();   // streamId -> stamp: the deleted sessions a whole read of their own rows refused
      for (const [streamId, stamp] of (scope.streams || scope.at || new Map())) {
        let rows;
        try { rows = store.view('proof', streamId, { complete: true }); }
        catch (error) {
          if (!error || error.code !== 'TRANSCRIPT_UNVOUCHED') throw error;
          refused.set(streamId, stamp);
          continue;
        }
        for (const r of rows) if (num(r.ts) <= stamp) doom(r);
      }
      /* A damaged line or a lost segment among a session's rows refuses that read at every pass, because a closed segment never changes. Failing
         the pass on it would stop the ledger settling, and every later delete's uploads would wait behind it. The walk reads every row that still
         parses; it throws only while the history cannot be vouched for now (boot degraded, a locked segment), and that pass retries. A file that
         only an unreadable row named cannot be found: it stays, and the log says so. */
      if (refused.size) {
        store.eachRow(r => { if (refused.has(r.streamId) && num(r.ts) <= refused.get(r.streamId)) doom(r); });
        if (typeof d.noteUploadsUnread === 'function') d.noteUploadsUnread(refused.size);
      }
      // the reads run only when the deleted sessions named a file at all
      if (doomed.size) {
        const saveStore = typeof d.saveStore === 'function' ? d.saveStore() : null;
        const onDoubt = (kept, why) => { if (typeof d.noteAttachmentsKept === 'function') d.noteAttachmentsKept(kept.length, why); };
        for (const p of namedElsewhere({ store, saveStore, paths: Array.from(doomed.keys()), onDoubt })) doomed.delete(p);
      }
      let removed = 0, stuck = 0;
      const byAgent = new Map();   // agentId -> its doomed paths, whether this pass or an earlier one removed the file
      for (const [rel, agentId] of doomed) {
        if (!byAgent.has(agentId)) byAgent.set(agentId, []);
        byAgent.get(agentId).push(rel);
        if (!(await d.attachments().hasAttachment(agentId, rel))) continue;   // already gone: a second pass reports nothing
        const out = await d.attachments().removeAttachment(agentId, rel);
        if (out && out.ok) removed++; else stuck++;
      }
      if (stuck && typeof d.noteAttachmentsKept === 'function') d.noteAttachmentsKept(stuck, 'they could not be removed, another program may have them open');
      /* the agent's restore points (checkpoint-store.js): a shadow commit made before the repo ignored .attachments/ still holds the bytes. The
         repo of an agent whose history holds a doomed path is replaced by one baseline of the current tree - its older rollback points are lost,
         and the receipt says so (noteCheckpointReset). A repo that holds none is left alone; a repo that cannot be searched or replaced fails the pass (retried at boot). */
      const reset = [];
      if (typeof d.checkpoints === 'function' && d.checkpoints()) {
        for (const [agentId, paths] of byAgent) {
          const out = await d.checkpoints().forgetAttachments(agentId, paths);
          if (out && out.reinit) reset.push(agentId);
        }
      }
      if (reset.length && typeof d.noteCheckpointReset === 'function') d.noteCheckpointReset(reset);
      return removed;
    }
  });

  /* group sessions (group-sessions.json): a group chat is a conversation whose id is its workstream's, so the Commander's delete of that session
     takes its messages, turns, questions, instructions and shared files (the group's own delete tombstones it). Source: the group's id. */
  entry({
    name: 'group-sessions',
    sourceOf: g => ({ streamIds: [g && g.id], at: num(g && g.createdAt) }),
    forget: scope => d.groupSessions().forget(src => inScope(src, scope))
  });

  /* kept conversation summaries (.summaries/<stream>.json, summary-ledger.js): the note a paid fold wrote for a chat, with the canonical rows it
     stands for. Source: the chat's id, the covered rows' range, the sessions those rows READ (quotes) and the time it was written. A delete of
     the chat, or of a session its covered rows read, takes the file with every sibling; admit(src) is asked before a put (index.js persistFold),
     and the ledger refuses a put of its own once the chat was deleted at or after the run began: both stay. */
  entry({
    name: 'conversation-summary',
    sourceOf: r => ({ streamIds: [r && r.streamId], runIds: [r && r.runId], rowIds: [r && r.fromRowId, r && r.toRowId], quotes: r && r.quotes, quotesAt: r && r.quotesAt,
      at: num(r && (r.runStartedAt || r.createdAt)) }),
    forget: scope => { const out = d.summaryLedger().forget(scope); return { removed: out.records, files: out.files }; }
  });

  /* line jobs (line-jobs.json): a job parked at a reviewer's gate keeps, in its saved walk, the chat's words - the ask, the products, the draft
     under review (binding.streamId, the entry run, the attempts' runs). The delete ENDS an unfinished one with the existing refusal and drops
     the walk, so a decision on it finds nothing waiting. A finished job is filed under the line and stays (see linejobs.js forgetUnfinished). */
  const lineJobSource = j => {
    const c = j && (j.continuation && typeof j.continuation === 'object' ? j.continuation : j.entryAdmission && typeof j.entryAdmission === 'object' ? j.entryAdmission : null);
    const b = c && c.binding && typeof c.binding === 'object' ? c.binding : {};
    const runIds = [b.entryRunId].concat((c && Array.isArray(c.attempts) ? c.attempts : []).map(a => a && a.runId)).concat((j && Array.isArray(j.runs) ? j.runs : []).map(r => r && r.runId));
    return { streamIds: [j && j.streamId, b.streamId], runIds: runIds.filter(Boolean), at: num(j && j.startedAt) };
  };
  entry({
    name: 'line-jobs',
    sourceOf: lineJobSource,
    forget: scope => d.lineJobs().forget(j => inScope(lineJobSource(j), scope), 'the conversation this job came from was deleted, so the work waiting on a decision was dropped')
  });

  /* the Commander dossier block and the beliefs snapshot (commit 14, qa/bugs/3e926b6a): composed by the PAGE from beliefs, some learned from runs,
     and pushed here for the unattended runs. Each push names the runs its derived beliefs were learned from and whether it names them all.
     A block that names a run the delete reached goes; one that is not complete and was written at or before the delete cannot say what it was
     learned from, and goes too. A cleared block reads as empty (the missing-snapshot path: the night shift degrades to the EARN tier) until the
     page's complete re-push; the write gate is derivedAdmission in index.js (every push, restore and reset asks it). The posture DIAL is the
     Commander's setting and is never touched; the snapshot loses the beliefs sourced from forgotten runs (and its readiness verdict with them). */
  const dossierSource = m => ({ runIds: m && m.sourceRunIds, at: num(m && m.setAt) });
  entry({
    name: 'commander-dossier',
    sourceOf: dossierSource,
    forget: scope => {
      const dossier = d.dossier(), m = dossier.meta();
      if (!m.block) return 0;
      if (inScope(dossierSource(m), scope) || (!m.complete && m.setAt <= latestStamp(scope))) { dossier.clear(); return 1; }
      return 0;
    }
  });
  entry({
    name: 'commander-posture',
    sourceOf: b => ({ runIds: b && b.sourceRunIds, at: num(b && b.at) }),
    forget: scope => {
      const latest = latestStamp(scope);
      return d.posture().forget(runId => inScope({ runIds: [runId] }, scope), at => at <= latest);
    }
  });

  /* the older station file kept at the v7 upgrade (<agent>.save.pre-history-ref.json) is a copy of EVERY conversation, so a delete cuts the
     deleted sessions (their records, ~restored copies, worker threads and undo rows) out of it, or removes it whole when it cannot be read or
     written back. Source: the session ids (a stream). Idempotent: a second pass finds nothing to cut. A failure throws, so the pass records
     nothing and the next boot retries. The 30 day expiry (savestore.expireKept) is the store's own timer and never waits on this entry. */
  entry({
    name: 'save-pre-history-ref',
    sourceOf: r => ({ streamIds: [r && r.id], at: num(r && r.ts) }),
    forget: scope => {
      const out = d.saveStore().scrubKept(Array.from((scope.streams || scope.at || new Map()).keys()));
      return out.sessions + out.removed;
    }
  });

  // the exemptions: each census row that keeps a store, and the stores no pattern sees
  for (const row of STORES) if (row[1] === 'exempt') registry.exempt(row[2] || row[0], row[3]);
  for (const [name, reason] of UNKEYED_EXEMPTIONS) registry.exempt(name, reason);
  // the table is the contract: every row that names an entry names one that is registered
  for (const row of STORES) if (row[1] === 'entry' && registry.names().indexOf(row[2]) < 0) throw new Error('forget wiring: ' + row[0] + ' names an entry that is not registered: ' + row[2]);
  for (const name of Object.keys(UNKEYED_ENTRIES)) if (registry.names().indexOf(name) < 0) throw new Error('forget wiring: ' + name + ' is not registered');
  return registry;
}

module.exports = { wireForgetRegistry, namedElsewhere, STORES, UNKEYED_ENTRIES, UNKEYED_EXEMPTIONS };
