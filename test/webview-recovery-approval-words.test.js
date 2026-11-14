/* node test/webview-recovery-approval-words.test.js — a restored setup says approval came back as ASK FOR APPROVAL.

   Review R3-D2 (stabilization plan C0-5, condition 3; a silent reset introduced by 9ca21dd7c, #181). When the page stops during
   the first-run wire test, the setup comes back (restoreWakeDraft) with every choice except approval: FULL POWER is never
   restored (it keeps its own confirm), so the Working style is back to ASK FOR APPROVAL. The message said "Your choices are
   kept", and the picker sits on the Your Overseer step, which the restore does not open. The message now says approval is the
   exception and how to choose FULL POWER again, in the screen's own labels (index.html, app.js APPROVAL). Both trees. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function restoreMessage(src, recovered) {
  const start = src.indexOf('  const WAKE_DRAFT_KEY = ');
  const end = src.indexOf('\n  // Returns TRUE once it commits to entering the station', start);
  A.ok(start > 0 && end > start && end - start < 12000, 'fixture: the #181 helpers are one bounded block before onWakeAttempt');
  const nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', className: '', dispatchEvent() {} }); return nodes.get(id); };
  const ctx = {
    Date, JSON, Number, Object, Array, String, Event: class { constructor(type) { this.type = type; } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { hash: '', pathname: '/index.html', search: '' }, history: { replaceState() {} },
    document: { querySelectorAll: () => [], getElementById: node }, el: node,
    pickedProvider: 'openai', pickedSkin: 'bear', pickedPersona: 'professional', pickedTraits: {}, pickedCustomVoice: '',
    pickedApproval: 'full', userPickedProvider: false,
    buildSkins() {}, buildVoice() {}, buildApproval() {}, updateNameplate() {}, updateHint() {}, selectProviderUI() {},
    OverseerSetup: { showStep() {}, beginConnection() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.restore = restoreWakeDraft; this.approval = () => pickedApproval;', ctx);
  ctx.restore({ name: 'NOVA', provider: 'openai', model: 'gpt-5' }, recovered);
  return { text: node('connect-msg').textContent, approval: ctx.approval() };
}

const html = read('frontend/index.html');
const appSrc = read('frontend/app/app.js');
// the labels the message uses are the screen's own
A.ok(/data-setup-step="identity"[^>]*>Your Overseer</.test(html), 'the identity step is labelled "Your Overseer"');
A.ok(/<label>Working style /.test(html), 'its approval picker is labelled "Working style"');
A.ok(/id: 'ask',\s+label: 'ASK FOR APPROVAL'/.test(appSrc) && /id: 'full', label: 'FULL POWER'/.test(appSrc), 'the two cards read ASK FOR APPROVAL and FULL POWER');

for (const tree of ['frontend/app', 'website/app/app']) {
  const src = read(tree + '/app.js'), t = tree + ': ';
  for (const recovered of [true, false]) {
    const said = restoreMessage(src, recovered), r = t + (recovered ? 'host recovery' : 'plain stop') + ': ';
    A.eq(said.approval, 'ask', r + 'FULL POWER is still never restored (the safe default holds)');
    A.ok(!/Your choices are kept —/.test(said.text), r + 'the message no longer says every choice is kept: ' + said.text);
    A.ok(/except Working style/.test(said.text) && /back to ASK FOR APPROVAL/.test(said.text), r + 'it says approval is back to ASK FOR APPROVAL');
    A.ok(/To use FULL POWER, choose it again under Your Overseer › Working style/.test(said.text), r + 'and how to choose FULL POWER again, where its picker is');
    A.ok(/press WAKE to try again/.test(said.text) && /startup\.log/.test(said.text), r + 'and what to do next, as before');
  }
}
A.report('webview-recovery-approval-words.test (R3-D2)');
