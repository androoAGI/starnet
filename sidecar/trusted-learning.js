/* Host-only learning input. A tool transcript is evidence, never owner authority.
   The composition root captures the current user message before attachments expand.
   No model-provided provenance fields, prior conversation turns, or quoted documents
   are accepted as proof that a standing preference came from the owner. */
'use strict';
// rowTaint: the one rule for a stored transcript row's provenance (transcriptstore.js; docs/DECISIONS.md).
const { rowTaint } = require('./transcriptstore.js');
const TurnView = require('./turn-view.js');
const UserText = require('../frontend/app/usertext.js');   // the one flattener of a message's text parts (LEARNING policy)

function textOf(message) {
  if (!message || message.role !== 'user') return '';
  return UserText.flatten(message.content, UserText.LEARNING);
}
function quotedMaterial(text) {
  return /```|~~~|(?:^|\n)\s*>|<\/?(?:document|email|untrusted|script)\b|[“"][^“”"]{20,}[”"]/i.test(String(text || '')) || /\b(?:examples?|samples?|transcript|following (?:document|email|message)|(?:document|attachment|website|webpage|email|message|article)\s+(?:says?|said|states?|reads?|instructs?))[^\n]*[:\n]/i.test(String(text || ''));
}
// LEARNING TAIL: the most transcript any durable learning pass can read, counted back from the newest turn. The review
// stash (verdictreview.js PERSIST_CHARS, each turn clipped to PER_MESSAGE_CHARS) is the widest; reflection, study,
// thread mining, failure review and the skill review's raw transcript all read a shorter tail (its structured evidence
// leaves quoted turns out on its own: learningevidence.js). test/trusted-learning.test.js locks these bounds.
const LEARNING_TAIL_CHARS = 16000;
const LEARNING_TAIL_MESSAGE_CHARS = 4000;
const RECALL_FENCE = /<(recalled-memory|run_context|crew_call)>[\s\S]*?<\/\1>|<\/?(?:recalled-memory|run_context|crew_call)>/gi;   // + the per-run <run_context> and <crew_call> notes (lean-prompt 2026-10-12)
// quotedInLearningTail: is there quoted material in a user turn a learning pass can still read? A quote that scrolled
// past every pass's tail must not keep learning off for the rest of a long conversation. Each later turn counts the
// LEAST any pass would count it, so a quote is never called out of reach too early: tool and block-content turns
// count nothing (reflection reads string user/agent text only), recalled-memory fences count nothing (stripped),
// a turn counts at most its per-turn clip, and the newest agent answer counts nothing (the stash keeps it whole).
// The newest user turn is always read (reflection and the stash keep the directive even when the tail cut it).
function quotedInLearningTail(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let used = 0, sawUser = false, sawAnswer = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (sawUser && used >= LEARNING_TAIL_CHARS) return false;
    if (m.role === 'user') {
      if (quotedMaterial(textOf(m))) return true;
      sawUser = true;
    }
    const raw = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'assistant' && !sawAnswer && raw.trim()) { sawAnswer = true; continue; }
    used += Math.min(raw.replace(RECALL_FENCE, '').length, LEARNING_TAIL_MESSAGE_CHARS);
  }
  return false;
}
// Ambient activity and repeat-work claims require the original owner text, not the completion run's later
// provenance. Only a row rowTaint reads as clean (the writer's clean stamp, no taint) can supply that proof, so a
// legacy row without the stamp never does.
function originsOf(runRecords) {
  return runRecords === undefined ? null : new Map((Array.isArray(runRecords) ? runRecords : []).filter(r => r && r.runId).map(r => [r.runId, r]));
}
function cleanOwnerRow(m, origins) {
  return TurnView.ownerRow(m, { rowTaint, quotedMaterial, runOf: id => origins && origins.get(id) });
}
// `tail` bounds the window to the newest rows, before filtering (ambient activity: 400); 0 reads every row passed in.
function cleanOwnerRows(rows, runRecords, tail = 400) {
  const origins = originsOf(runRecords);
  const list = Array.isArray(rows) ? rows : [];
  return (tail > 0 ? list.slice(-tail) : list).filter(m => cleanOwnerRow(m, origins));
}
function ownedBriefs(briefs, transcriptRows, runRecords) {
  const list = (Array.isArray(briefs) ? briefs : []).filter(b => b && b.agentId && b.originalDirective);
  // New briefs retain an immutable originalRunId. Older host briefs already encode that identity in
  // tb_<original-run-id>; never substitute completion's mutable runId or a later identical request.
  const originalOf = b => b.originalRunId || (typeof b.id === 'string' && b.id.startsWith('tb_') ? b.id.slice(3) : '');
  // A brief's proof is its ORIGINAL directive row, and the repeat-work detector reaches back 60 days: a recency tail
  // (every assistant and tool row counts toward it) drops a two-week-old occasion of a weekly task (review
  // sidecar-index-03). Look the proof up by run id across every row the caller holds; each row still has to pass the
  // same clean-owner check. The clean rows are indexed by the agent, stream and run that wrote them: one pass, then
  // one lookup per brief. The host's RAM mirror keeps only the newest 3000 rows station-wide (routine streams count
  // too), so on a busy station a weekly request's earlier occasions can still fall out of it; proving those from disk
  // is the host's job.
  const wanted = new Set(list.map(originalOf).filter(Boolean)), origins = originsOf(runRecords), proof = new Map(), byId = new Map();
  for (const m of Array.isArray(transcriptRows) ? transcriptRows : []) {
    if (!m || !cleanOwnerRow(m, origins)) continue;
    if (Number.isSafeInteger(m.rowId) && m.rowId > 0) byId.set(m.rowId, m);
    if (!wanted.has(m.sourceRunId)) continue;
    const key = JSON.stringify([m.agentId, m.streamId, m.sourceRunId]);
    if (!proof.has(key)) proof.set(key, []);
    proof.get(key).push(m);
  }
  const seen = new Set();
  return list.filter(b => {
    if (b.directiveRowId != null) {
      const row = Number.isSafeInteger(b.directiveRowId) && b.directiveRowId > 0 ? byId.get(b.directiveRowId) : null;
      if (!row || row.agentId !== b.agentId || row.streamId !== (b.streamId || 'global')
          || row.content.trim().slice(0, 4000) !== b.originalDirective || seen.has(row.rowId)) return false;
      seen.add(row.rowId); return true;
    }
    const original = originalOf(b);
    if (!original) return false;
    const stream = b.streamId || 'global', key = JSON.stringify([b.agentId, stream, original]);
    const row = (proof.get(key) || []).find(m => m.content.trim().slice(0, 4000) === b.originalDirective);
    if (seen.has(key) || !row || (row.rowId && seen.has(row.rowId))) return false;
    if (row.rowId) seen.add(row.rowId);
    seen.add(key); return true;
  });
}
// Quoted material in any of these user turns. Callers pass the context a run REPLAYS (a server-seeded or re-seeded
// transcript, a recovery checkpoint, the earlier-conversation rows): a pasted document there is data the learning
// passes must not read as the Commander's words, whoever sent the history.
function quotedTurns(messages) {
  return (Array.isArray(messages) ? messages : []).some(m => m && m.role === 'user' && quotedMaterial(textOf(m)));
}
function capture(messages, source) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i] || list[i].role !== 'user') continue;
    const content = textOf(list[i]);
    // Do not silently truncate a directive and mistake its incomplete prefix for the owner's instruction.
    if (!content.trim() || content.length > 16000 || quotedMaterial(content)) return null;
    return { index: i, role: 'user', source: source || 'interactive-owner', content };
  }
  return null;
}
function eligible(origin) {
  const o = origin || {};
  // A recipe launch sends the recipe author's template (built-in or an imported file), not the owner's wording.
  return !o.internal && !o.parentRunId && !o.delegatedBy && !o.groupTools && !o.recovery && !o.handoff &&
    !o.untrustedEntry && !o.syntheticTrigger && !o.hostPowerWithheld && !o.recipeId && !o.fromRecipe &&
    (o.source === 'interactive-owner' || (o.source === 'channel-owner' && o.channelSenderOwner === true));
}
/* A PICK IS NOT A STANDING PREFERENCE (2026-10-12). "I prefer X" is standing only when X names a KIND of thing
   ("tabs over spaces", "a dark theme", "it when replies are short", "that you use tabs"), not one of the items in
   front of the Commander right now. Structure decides, not a word list of candidate nouns:
     - any statement that points back at the current item (", ship it", ", go with that", "Never do that again.")
       cannot stand on its own later, whatever its anchor (POINTS_BACK, checked for every anchor below);
     - a "one"-headed item ("the blue one", "a shorter one") is a pick;
     - a clause about how things should go ("it when …", "that you …", "to …", "using …") stays standing;
     - a pronoun/demonstrative object ("this layout", "that one", "the latter") is a pick;
     - a labelled candidate ("option B", "version 2", "B") or a definite/possessive item ("the second option",
       "your draft") is a pick unless the sentence names the general case it covers ("the first person voice in
       essays", "Python 3 for scripts").
   When in doubt it is a pick, and nothing is saved. */
const POINTS_BACK = /\b(?:it|this|that|these|those|them)(?:\s+(?:again|instead|anymore|too|now|then|here|there|later|first|yet))?\s*(?:[,;:!.]|$)/i;
const GENERAL_CASE = /\b(?:(?:in|for|on|across|with)\s+(?!(?:this|that|these|those|its|his|us|yours|ours|theirs)\b)(?:(?:all|every|any|future|new|my|our)\s+){0,3}[a-z][a-z-]*s\b|when(?:ever)?\b|every\s+time\b)/i;
function onePick(lead) {
  const m = /^(?:i|we)\s+(?:strongly\s+|generally\s+)?prefer\s+([\s\S]*?)[\s.!]*$/i.exec(lead);
  if (!m) return false;
  const object = m[1];
  if (/\bones?\b(?!-)\s*(?:[,;:!.]|$|\b(?:over|instead|rather|better|more|than|in|for|on|of|from|with|because)\b)/i.test(object)) return true;
  if (/^(?:it\s+(?:when|if|whenever)|that\s+(?:you|we|i|they|he|she|it|there|the|all|every|each|any|no|our|my|your)|to|when|whenever|if)\b|^\w+ing\b/i.test(object)) return false;
  if (/^(?:it|its|this|that|these|those|them|either|neither|both|yours|mine|ours|theirs|the\s+(?:latter|former|other|rest))\b/i.test(object)) return true;
  const labelled = /^(?:#?\d+|[a-z])$/i.test(object) || /^[A-Za-z][\w-]*\s+(?:#?\d+(?:\.\d+)*|(?!I\b)[A-Z])(?![\w'])/.test(object);
  const definite = /^(?:the|your|my|our|his|her|their)\b/i.test(object);
  return (labelled || definite) && !GENERAL_CASE.test(object);
}
function preferences(input, projectRoot) {
  if (!input || !['interactive-owner', 'channel-owner'].includes(input.source)) return [];
  const text = String(input.content || '').replace(/[‘’]/g, "'");
  // An opt-out applies to the whole message, including a preference in an earlier sentence.
  if (/\b(?:do not|don't|never)\s+(?:(?:automatically|ever)\s+)?(?:save|store|remember|retain|memorize)\b|\b(?:no|without)\s+(?:persistent\s+)?memor(?:y|ies)\b/i.test(text)) return [];
  // Preserve exact words; do not infer polarity or reorder a comparison. Quoted/code material and reports of
  // somebody else's instructions are data even when a user pasted them into a user-role message.
  if (/[`<>“”"]|(?:^|\n)\s*>/.test(text) || /\b(?:examples?|samples?|transcript|following|says?|said|asked|told|quotes?)[^\n]*[:\n]/i.test(text) || /\b(?:quoted?|document|attachment|website|webpage|email|message|article)\s+(?:says?|said|states?|reads?|instructs?)\b/i.test(text)) return [];
  const out = [];
  for (const raw of text.split(/\n|(?<=[.!?])\s+/)) {
    const content = raw.trim();
    if (content.length < 8 || content.length > 600 || /\?$/.test(content)) continue;
    // STANDING = an explicit standing marker. A bare "I prefer …" is not one: it is as often a pick between the drafts in
    // front of the Commander ("I prefer the second option", "I prefer option two") as a lasting taste, and two review
    // rounds of pick/taste word lists opened new holes both ways (2026-10-12). Fail closed: without a marker nothing is
    // auto-saved here — the agent can still save a real preference with notebook.write, whose provenance is proven
    // against the Commander's own words.
    if (!/^(?:(?:please\s+)?remember(?:\s+that)?[,:]?\s+)?(?:(?:from now on|going forward|by default|for (?:all|every) future (?:tasks?|chats?|conversations?))[,:]?\s|(?:always|never)\s)/i.test(content)) continue;
    // An anchor word alone is not a standing preference: an idiom ("Never mind"), a remark ("Never seen it this bad",
    // "Always worked before"), a one-off pick between drafts ("I prefer the second option") or a description of current
    // behavior ("By default the app opens to settings", "Going forward the API returns 404") is task wording, and saving
    // it would hand every agent a standing order nobody gave. A described subject must still say what should happen.
    // When in doubt, nothing is saved.
    const lead = content.replace(/^(?:please\s+)?remember(?:\s+that)?[,:]?\s+/i, '');
    // Always/Never only opens an order when an instruction follows. ever/again/before/once (and yet/even/really/…) are
    // adverbs, judged by what follows them: "Never again push to main." is the order an angry owner gives, while
    // "Never again.", "Never before have I seen this", "Never once has this worked" and "Always was" are not.
    if (/^(?:never\s+mind\b|(?:always|never)\s+(?:(?:ever|again|before|once|yet|even|really|truly|actually|quite)\s+)*(?:(?:seen|been|had|heard|knew|known|got|gotten|did|done|was|were|is|are|am|has|does|thought|felt|happened|happens|worked|works|liked|loved|expected|imagined|managed|understood|occurred|would|could|might|will|can|shall|should|must|gets|seems|fails|goes|breaks|noticed|tried|used|wanted|needed|realized|said|told|saw|went|came|made|took|gonna)\b(?!-)|(?:do|have)\s+(?:i|we|you|they)\b)|(?:always|never)\s+(?:(?:ever|again|before|once|yet|even|really|truly|actually|quite)\b\s*)+(?:[.!,;:—–…-]|$))/i.test(lead)) continue;
    if (POINTS_BACK.test(lead) || onePick(lead)) continue;
    if (/^(?:always|never|from now on|going forward|by default|for (?:all|every) future (?:tasks?|chats?|conversations?))[,:]?\s+(?:the|a|an|this|that|these|those|it|its|there|they|he|she|his|her|our|their|my)\b/i.test(lead) &&
      !/\b(?:should|must|shall|needs?\s+to|ha(?:s|ve)\s+to|ought\s+to|(?:is|are)\s+to|please)\b/i.test(lead)) continue;
    if (/\b(?:passwords?|secrets?|credentials?|api.?keys?|access.?tokens?|auth|permissions?|approvals?|safety|guards?|polic(?:y|ies)|system.?prompts?|instruction.?hierarchy|full.?access|bypass(?:ing)?|overrides?|forget|do not (?:remember|save)|don't (?:remember|save))\b/i.test(content)) continue;
    const global = !projectRoot || /\b(?:across all (?:projects|tasks)|for (?:all|every) future (?:tasks?|chats?|conversations?))\b/i.test(content);
    // The Commander's exact words. The host never saves them unscrubbed (review memory-learning-03): captureTrustedLearning
    // scrubs each one, and a statement the scrub changed (a key, a URL password, a secret the host holds) is never saved
    // silently; it waits, scrubbed, on the Keep/Edit/Discard deck. writeMemoryRecord's user-stated re-check compares these
    // exact words with the written text, so only an unscrubbed statement is stamped as the Commander's own.
    out.push({ kind: 'profile', content, scope: global ? 'global' : 'project', projectRoot: global ? null : String(projectRoot), standing: true });
    if (out.length >= 5) break;
  }
  return out;
}
// Every captured statement is a standing instruction by construction, so the reflection deck's generic
// always/never/from-now-on tier would hold all of them. Ask its remaining tiers (a credential, personal data, an
// instruction carrying authority) with the standing marker rewritten as the modal it stands for, so "Never ask before
// deleting files" still reads as an authority-shaped "do not ask ... delete". No deck predicate: never auto-save.
function needsReview(content, highStakes) {
  if (typeof highStakes !== 'function') return true;
  return highStakes(String(content || '').replace(/[‘’]/g, "'").replace(/\bnever\b/gi, 'do not')
    .replace(/\b(?:always|from now on|going forward|by default|for (?:all|every) future (?:tasks?|chats?|conversations?))\b/gi, 'must'));
}
function checks(evidence) {
  const e = evidence || {};
  const requirements = e.contract && Array.isArray(e.contract.requirements) ? e.contract.requirements : [];
  return (Array.isArray(e.checks) ? e.checks : []).slice(0, 20).map(c => {
    const requirement = requirements.find(r => r.id === c.id);
    return { id: String(c.id || '').slice(0, 80), type: String(c.type || '').slice(0, 60), status: c.status === 'passed' ? 'passed' : 'failed', code: String(c.code || '').slice(0, 80),
      ...(requirement && requirement.type === 'verification_passed' ? { command: String(requirement.command || '').slice(0, 1000) } : {}) };
  });
}
function evidence(input) {
  const o = input || {};
  // trustedOnly: quoted material the owner typed. Not taint (tools keep owner authority), but learning reads only
  // the captured directive and host checks, never the raw transcript. Present only when set: clean shape unchanged.
  return { version: 1, source: 'host', runId: String(o.runId || ''), trigger: String(o.trigger || ''), tainted: !!o.tainted,
    ...(o.trustedOnly ? { trustedOnly: true } : {}),
    trustedUserMessages: o.trustedInput ? [o.trustedInput] : [], checks: checks(o.completion), loadedSkills: o.loadedSkills || [] };
}
module.exports = { textOf, quotedMaterial, quotedInLearningTail, quotedTurns, LEARNING_TAIL_CHARS, LEARNING_TAIL_MESSAGE_CHARS, cleanOwnerRows, ownedBriefs, capture, eligible, preferences, needsReview, checks, evidence };
