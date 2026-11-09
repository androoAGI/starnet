/* node test/skillreview-diet.test.js — the skill review prompt sends each tool output once (cost lane W1.5).

   The review prompt carries the structured evidence packet (every tool result's first 1600 chars) AND the run's transcript
   tail (12k chars), so a tool output used to go out twice. The transcript now points at the packet for an output it holds
   whole, and keeps only what the packet cut off of a longer one (cut only where the host's final scrub changes nothing).
   Locks: the window is the one the full transcript shows, nothing outside the packet is dropped, nothing is cut when the
   final scrub would replace something, the packet itself is untouched, and with nothing to dedupe the transcript is
   byte-identical to the old one. Pure modules, no sidecar. */
'use strict';
const A = require('./_assert.js');
const SR = require('../sidecar/skillreview.js');
const LE = require('../sidecar/learningevidence.js');

const fileText = n => Array.from({ length: n }, (_, i) => 'line ' + i + ': const rollback = stage(' + i + ') // keep the staging path warm').join('\n');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } });
const messages = [
  { role: 'user', content: 'Rebuild the staging rollback path and write up what changed.' },
  { role: 'assistant', content: 'Reading the deploy script first.', tool_calls: [call('c1', 'fs_read', { path: 'deploy.sh' })] },
  { role: 'tool', tool_call_id: 'c1', content: fileText(60) },                        // ~3.6k: the packet holds its start
  { role: 'assistant', content: 'Running the smoke check.', tool_calls: [call('c2', 'shell_run', { cmd: 'npm run smoke' })] },
  { role: 'tool', tool_call_id: 'c2', content: Array.from({ length: 8 }, (_, i) => 'ok ' + (i + 1) + ' - rollback step ' + (i + 1) + ' restores the staging path').join('\n') + '\nsmoke: 8 passed, 0 failed (4.1 s)' },   // the packet holds it whole
  { role: 'assistant', content: 'Writing the fix.', tool_calls: [call('c3', 'fs_write', { path: 'deploy.sh' })] },
  { role: 'tool', tool_call_id: 'c3', content: 'Saved deploy.sh (2.1 KB).' },                    // shorter than a pointer: kept as it is
  { role: 'assistant', content: 'Done. Rolled back the staging path; the smoke check passes.' }
];
const old = (msgs, cap) => {   // the transcript before the diet, verbatim
  const lines = [];
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
    let c = typeof m.content === 'string' ? m.content : '';
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) c += '\n[tool calls: ' + m.tool_calls.map(tc => tc && tc.function && tc.function.name).filter(Boolean).join(', ') + ']';
    if (c) lines.push(m.role.toUpperCase() + ': ' + c);
  }
  const body = lines.join('\n');
  return body.length > cap ? body.slice(body.length - cap) : body;
};
const same = t => t;
const packet = LE.buildLearningEvidence({ messages });

// ---- the packet holds what the transcript drops ----
A.eq(LE.outputBeyondPacket(packet, messages[4], same), '', 'a short output the packet holds whole: nothing beyond it');
const rest = LE.outputBeyondPacket(packet, messages[2], same);
A.ok(typeof rest === 'string' && rest.length > 0 && messages[2].content.endsWith(rest) && packet.toolResults.find(r => r.callId === 'c1').text + rest === messages[2].content,
  'a long output: exactly the part past the packet\'s copy (packet copy + rest = the output)');
A.eq(LE.outputBeyondPacket(packet, messages[2]), null, 'no final scrub to prove the cut safe: a long output is never cut');
A.eq(LE.outputBeyondPacket(packet, messages[2], t => t.replace('stage(30)', '[redacted-secret]')), null, 'the final scrub would replace something in it: never cut (a cut could split what it replaces whole)');
A.eq(LE.outputBeyondPacket(packet, messages[2], () => { throw new Error('boom'); }), null, 'a final scrub that throws: never cut');
A.eq(LE.outputBeyondPacket(packet, { role: 'tool', tool_call_id: 'elsewhere', content: messages[4].content }, same), null, 'an id the packet does not hold: shown as it is');
A.eq(LE.outputBeyondPacket(packet, Object.assign({}, messages[4], { content: 'smoke: 7 passed, 1 failed' }), same), null, 'a different text under a held id: shown as it is');
A.eq(LE.outputBeyondPacket(packet, messages[1], same), null, 'not a tool message: shown as it is');
A.eq(LE.outputBeyondPacket(null, messages[4], same), null, 'no packet: shown as it is');

// ---- the transcript: pointers, the same window, only ever shorter ----
for (const cap of [12000, 3000, 900, 200]) {
  const before = old(messages, cap);
  const after = SR.transcript(messages, cap, packet, same);
  A.ok(cap < 1000 ? after.length <= before.length : after.length < before.length, 'cap ' + cap + ': the deduped transcript is ' + (cap < 1000 ? 'never longer' : 'shorter') + ' (' + before.length + ' -> ' + after.length + ')');
  A.eq(SR.transcript(messages, cap), before, 'cap ' + cap + ': with no packet it is byte-identical to the old transcript');
  // every line the old window shows whole is still there, as itself or as its pointer; nothing older comes in
  const keptWhole = before.split('\n');
  A.ok(!/USER: Rebuild/.test(after) || /USER: Rebuild/.test(before), 'cap ' + cap + ': no line from before the window');
  A.ok(keptWhole.filter(l => /^ASSISTANT: /.test(l)).every(l => after.indexOf(l) >= 0), 'cap ' + cap + ': every assistant line in the window is unchanged');
}
const full = SR.transcript(messages, 12000, packet, same);
A.ok(full.indexOf('TOOL: [in the evidence packet toolResults callId c2]') >= 0 && full.indexOf('smoke: 8 passed') < 0, 'an output the packet holds whole becomes a pointer to it');
A.ok(full.indexOf('TOOL: Saved deploy.sh (2.1 KB).') >= 0, 'an output shorter than the pointer is kept as it is');
A.ok(full.indexOf('TOOL: [start in the evidence packet toolResults callId c1; continues] ' + rest) >= 0 && full.indexOf('line 0: const rollback') < 0, 'a long output keeps only what the packet cut off');
const elsewhere = messages.concat([{ role: 'tool', tool_call_id: 'zz', content: 'an output the packet was built without, long enough to be worth a pointer if the packet held it' }]);
A.ok(SR.transcript(elsewhere, 12000, packet, same).indexOf('TOOL: an output the packet was built without') >= 0, 'an output the packet does not hold is kept whole');
A.ok(SR.transcript(messages, 12000, packet).indexOf('TOOL: ' + messages[2].content) >= 0, 'without a final scrub the long output is kept whole (only whole outputs dedupe)');

// ---- the prompt: the packet is untouched, only the transcript shrinks ----
const input = { agentId: 'agent', runId: 'r1', messages, skills: [], memories: [] };
const plain = SR.buildPrompt(input), diet = SR.buildPrompt(Object.assign({}, input, { finalScrub: same }));
const head = s => s.slice(0, s.indexOf('Completed run transcript:'));
A.eq(head(diet), head(plain), 'everything before the transcript (rules, packet, skills, memories) is byte-identical');
A.ok(diet.length < plain.length, 'the review prompt is shorter (' + plain.length + ' -> ' + diet.length + ' chars)');
A.ok(diet.indexOf(LE.renderLearningEvidence(input)) >= 0, 'the packet the pointers name is in the same prompt');
// a trusted-only review never had a transcript: unchanged
const trustedOnly = Object.assign({}, input, { trustedOnly: true, finalScrub: same });
A.ok(SR.buildPrompt(trustedOnly).indexOf('[Raw transcript withheld') >= 0, 'a trusted-only review still withholds the raw transcript');

A.report('skillreview-diet.test');
