'use strict';
const A = require('./_assert.js');
const Kinds = require('../frontend/app/turnkinds.js');
const Pipeline = require('../frontend/app/pipeline.js');
const GoalLoop = require('../frontend/app/goalloop.js');
const Fidelity = require('../sidecar/compaction-fidelity.js');
const UserText = require('../frontend/app/usertext.js');
// Frozen pre-C6 transcript self-talk predicate. It applies only on global, not to an owner's named session.
function beforeSelfTalk(row) {
  if (!row || row.streamId !== 'global' || row.role !== 'user') return false;
  const content = String(row.content == null ? '' : row.content);
  return content.indexOf('\n\nAssistant reply (context only): ') >= 0 || content.startsWith('INTERNAL —')
    || (content.startsWith('Goal:\n') && /Is the goal satisfied — done or continue\?$/.test(content));
}
for (const content of ['ordinary text', 'INTERNAL — create a title', 'Request\n\nAssistant reply (context only): reply',
  'Goal:\nrelease the build\nIs the goal satisfied — done or continue?', 'INTERNAL ordinary words', 'Goal:\nplain owner task']) {
  for (const streamId of ['global', 's']) for (const role of ['user', 'assistant']) {
    const row = { role, streamId, content };
    A.eq(Kinds.legacyPrompt(row), beforeSelfTalk(row), 'frozen self-talk predicate: ' + role + '/' + streamId + '/' + content.slice(0, 20));
  }
}
const handoff = 'PIPELINE HANDOFF — you are stage 2 of a work line on this station.\n\nThe original request was:\nrepair it\n\nThe upstream stage (one) produced:\nnotes';
for (const content of [handoff, '  ' + handoff, handoff.slice(0, 100), 'ordinary request', 'PIPELINE HANDOFF is a phrase I am discussing']) {
  A.eq(Kinds.legacyKind({ role: 'user', content }), Pipeline.isHandoff(content) ? 'hop' : 'turn', 'shared handoff parser is the legacy authority');
}
const capture = '[BEGIN EXTERNAL SCREEN CAPTURE — fixture]';
const parts = [{ type: 'text', text: capture }, { type: 'image_url', image_url: { url: 'fixture' } }];
A.eq(Kinds.classify({ role: 'user', content: capture }).kind, 'capture', 'capture fence is classified once');
A.eq(UserText.flatten(parts, UserText.LABELLED), '', 'labelled user text still excludes a screenshot turn');
A.eq(Kinds.legacyKind({ role: 'user', content: 'Shared conversation context (records)' }), 'group', 'group writer head is recognized');
A.eq(Kinds.legacyKind({ role: 'user', content: '[STRUCTURED RESULT REPAIR] retry' }), 'station', 'repair writer head is recognized');
A.eq(Kinds.legacyKind({ role: 'assistant', content: 'reply', sourceRunId: 'hop' }, { hopRuns: new Set(['hop']) }), 'hop', 'a handoff run carries its reply kind');
A.eq(Kinds.legacyKind({ role: 'assistant', content: 'reply', sourceRunId: 'internal' }, { runOf: () => ({ internal: true }) }), 'station', 'host internal provenance hides arbitrary station wording');
A.eq(Kinds.legacyKind({ role: 'user', content: 'ordinary owner text' }), 'turn', 'ordinary owner wording stays ordinary');
A.eq(Fidelity.isScreenCapture({ role: 'user', content: parts }), true, 'actual compaction capture reader delegates the same fence');
A.eq(Fidelity.isScreenCapture({ role: 'user', content: [{ type: 'text', text: 'ordinary image caption' }, parts[1]] }), false, 'an ordinary user image is not a synthetic capture');
A.ok(typeof GoalLoop.stepOfTurn === 'function', 'goal-step authority remains the existing parser');
A.report('legacy-kind.equivalence');
