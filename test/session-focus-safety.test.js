'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../frontend/app/', file), 'utf8');
const chat = read('chat.js');
function fn(src, name) {
  const match = src.match(new RegExp('  (?:async )?function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, name + ' exists');
  return match[0];
}
(async () => {
  // Delayed speech is an output event, not navigation. It must leave the draft and view alone.
  const voice = { selected: 'reading', draft: 'my follow-up', ensureBoundFocus() { this.selected = 'call'; this.draft = ''; }, caption: (who, text) => captions.push(text) };
  const captions = [];
  voice.ensureBoundFocus = () => { voice.selected = 'call'; voice.draft = ''; };
  vm.runInNewContext(fn(read('voice-live.js'), 'onAssistant') + ';onAssistant({text:"answer", opening:true});', voice);
  assert.equal(voice.selected, 'reading', 'an assistant reply must not reopen its session');
  assert.equal(voice.draft, 'my follow-up');
  assert.deepEqual(captions, ['answer']);

  // An attachment send yields to upload completion. Navigation in that interval cancels this
  // submission, preserving both the original draft and the newly displayed session's composer.
  const origin = { id: 'original' }, target = { id: 'other' }, sent = [];
  const sandbox = { activeWs: origin, focusVersion: 0, input: { value: 'original draft' }, pendingAtts: [{}],
    composerContextIssue: () => null, recordSent() {}, isBusy: () => false,
    settleAttachments: async () => { sandbox.activeWs = target; sandbox.input.value = 'other draft'; },
    takeAttachments: () => [{id:'upload'}], closeSlash() {}, autoGrowInput() {}, send: (...args) => sent.push(args) };
  await vm.runInNewContext(fn(chat, 'submitComposer') + ';submitComposer();', sandbox);
  assert.equal(sent.length, 0, 'upload completion cannot send into a newly selected session');
  assert.equal(sandbox.input.value, 'other draft');
  sandbox.activeWs = origin; sandbox.input.value = 'original draft';
  sandbox.settleAttachments = async () => { sandbox.focusVersion++; }; // left and returned during upload
  await vm.runInNewContext(fn(chat, 'submitComposer') + ';submitComposer();', sandbox);
  assert.equal(sent.length, 0, 'returning to the origin cannot revive an old send');
  origin.conversationMode = 'group'; sandbox.GroupChat = { sendText: () => sent.push('group') };
  await vm.runInNewContext(fn(chat, 'submitComposer') + ';submitComposer();', sandbox);
  assert.equal(sent.length, 0, 'group submission obeys the same navigation guard');

  // Run identity, current navigation generation, and a clear composer all matter. Going away and
  // back must not revive an old model request, nor may another run forge the selected run's intent.
  const meta = { streamId: 'original', focusVersion: 7 };
  const gate = { activeWs: origin, focusVersion: 7, input: {value:''}, pendingAtts: [],
    RUN_META: new Map([['run-a', meta]]), Channels: {isBusy: () => true, runIdOf: () => 'run-a'} };
  vm.runInNewContext(fn(chat, 'canFocusSession') + ';this.canFocus = canFocusSession;', gate);
  const request = {streamId:'original',runId:'run-a'};
  assert.equal(gate.canFocus(request), true, 'the current foreground run can honor an explicit focus request');
  gate.input.value = 'typing'; assert.equal(gate.canFocus(request), false, 'a draft blocks automatic navigation');
  gate.input.value = ''; gate.pendingAtts = [{}]; assert.equal(gate.canFocus(request), false);
  gate.pendingAtts = []; gate.focusVersion++; assert.equal(gate.canFocus(request), false, 'navigation invalidates old requests');
  gate.focusVersion = 7; gate.activeWs = target; assert.equal(gate.canFocus(request), false);
  gate.activeWs = origin; assert.equal(gate.canFocus({streamId:'original',runId:'other-run'}), false);
  assert.equal(gate.canFocus(null), false, 'unattributed requests cannot switch sessions');
  gate.Channels.isBusy = () => false; assert.equal(gate.canFocus(request), false, 'completed runs cannot navigate');
  gate.Channels.isBusy = () => true; gate.Channels.runIdOf = () => 'replacement'; assert.equal(gate.canFocus(request), false, 'a superseded run cannot navigate');
  console.log('session-focus-safety.test: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });