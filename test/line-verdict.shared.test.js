/* H1: actual page/CommonJS/sidecar parser parity. The control loads the saved old
   Pipeline source without replacing production files. No provider, clock or DOM. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const A = require('./_assert.js');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const shared = require('../frontend/app/line-verdict.js');
const server = require('../sidecar/routing/verdict.js');
const pipelinePath = path.join(root, 'frontend/app/pipeline.js');
const pipelineSource = process.env.LINE_VERDICT_PIPELINE_CONTROL
  ? fs.readFileSync(process.env.LINE_VERDICT_PIPELINE_CONTROL, 'utf8') : read('frontend/app/pipeline.js');
const nodeModule = new Module(pipelinePath, module);
nodeModule.filename = pipelinePath;
nodeModule.paths = Module._nodeModulePaths(path.dirname(pipelinePath));
nodeModule._compile(pipelineSource, pipelinePath);
const page = vm.createContext({});
vm.runInContext(read('frontend/app/line-verdict.js'), page, { filename: 'line-verdict.js' });
vm.runInContext(pipelineSource, page, { filename: 'pipeline.js' });
A.ok(server === shared, 'the stable sidecar facade is the shared module, not a second parser');
const cases = [
  ['draft\nVERDICT: approved', 'approved', 'draft'],
  ['draft\nVERDICT: revise', 'revise', 'draft'],
  ['draft\nVERDICT: BLOCKED', 'blocked', 'draft'],
  ['draft\n**VERDICT:** BLOCKED', 'blocked', 'draft'],
  ['draft\nVERDICT: **BLOCKED**', 'blocked', 'draft'],
  ['draft\nVERDICT: `blocked`', 'blocked', 'draft'],
  ['draft\n__VERDICT:__ Blocked.\n\n', 'blocked', 'draft'],
  ['draft\n- **VERDICT:** blocked.', 'blocked', 'draft'],
  ['draft\n> VERDICT: blocker', 'blocked', 'draft'],
  ['draft\nVERDICT: DO NOT SHIP', 'blocked', 'draft'],
  ['draft\nverdict - do not ship until fixed', 'blocked', 'draft'],
  ['draft\nVERDICT: blocked\nexplanation\nnext action', 'blocked', 'draft\nexplanation\nnext action'],
  ['VERDICT: blocked\nfixed\nVERDICT: approved', 'approved', 'VERDICT: blocked\nfixed'],
  ['VERDICT: approved\nregressed\nVERDICT: blocked', 'blocked', 'VERDICT: approved\nregressed'],
  ['quoted\nVERDICT: blocked\none\ntwo\nthree', null, 'quoted\nVERDICT: blocked\none\ntwo\nthree'],
  ['draft\nVERDICT: needs_work', 'revise', 'draft'],
  ['draft\n**VERDICT:** approved', 'approved', 'draft'],
  ['draft\nVERDICT: **not** approved', null, 'draft\nVERDICT: **not** approved'],
  ['draft\nVERDICT: Blocking issues: none', null, 'draft\nVERDICT: Blocking issues: none'],
  ['draft\nVERDICT: maybe', null, 'draft\nVERDICT: maybe'],
  ['missing verdict', null, 'missing verdict'],
  ['', null, ''],
  ['VERDICT: blocked', 'blocked', 'VERDICT: blocked'],
  ['**VERDICT:** approved', 'approved', '**VERDICT:** approved'],
  ['> VERDICT: revise', 'revise', '> VERDICT: revise']
];
for (const [text, verdict, display] of cases) {
  const name = JSON.stringify(text);
  A.eq(server.parseVerdict(text), verdict, 'server verdict ' + name);
  A.eq(page.LineVerdict.parseVerdict(text), verdict, 'browser verdict ' + name);
  A.eq(page.LineVerdict.stripVerdict(text), server.stripVerdict(text), 'same work stripping ' + name);
  A.eq(page.Pipeline.stripVerdictLine(text), display, 'actual browser display ' + name);
  A.eq(nodeModule.exports.stripVerdictLine(text), display, 'actual CommonJS display ' + name);
}
for (const api of [server, page.LineVerdict]) {
  A.ok(api.isVerdictWord('APPROVED') && api.isVerdictWord('revise'), 'existing gate keys retained');
  A.ok(!api.isVerdictWord('blocked') && api.BLOCKED === 'blocked', 'BLOCKED is not a new gate key');
  A.eq(api.parseVerdict(null), null, 'non-text is no verdict');
}
/* S2 (line-hold): the HOLD's three reasons, their one-sentence wording and the reviewer's brief are the shared module's, said the same by the
   page and the sidecar. The sidecar side is built through test/helpers/line-hold-control.js: LINE_HOLD_CONTROL=original makes it the saved
   5977d433c source (one sentence for every hold, a brief promising "treated as revise") and these assertions must go RED there. */
const heldSubject = require('./helpers/line-hold-control.js').pick().Verdict;
for (const api of [heldSubject, page.LineVerdict]) {
  A.eq(api.HOLD_REASONS, ['blocked', 'missing_verdict', 'spent'], 'the three reasons a hold has (line-continuation.js holdRecord)');
  for (const why of ['blocked', 'missing_verdict', 'spent']) for (const gate of ['12,4', 'g1']) {
    A.eq(api.heldWhy(gate, why), page.LineVerdict.heldWhy(gate, why), 'page and sidecar say the ' + why + ' hold alike: ' + gate);
  }
  A.eq(api.heldWhy('g1'), 'the reviewer at the gate g1 answered VERDICT: blocked, so the work is held there — not sent on, not shipped', 'the BLOCKED sentence is what every census pins, byte for byte');
  A.ok(/gave no usable VERDICT line/.test(api.heldWhy('g1', 'missing_verdict')) && /used all its passes/.test(api.heldWhy('g1', 'spent')), 'the other two reasons say their own thing');
  for (const when of ['approved', 'revise']) for (const handsOn of [true, false]) {
    const brief = api.verdictBrief(when, handsOn);
    A.eq(brief, page.LineVerdict.verdictBrief(when, handsOn), 'the brief is one text: ' + when + ', ' + handsOn);
    A.ok(brief.length <= 600 && /A reply with no VERDICT line holds the work for a person\./.test(brief) && !/treated as/.test(brief), 'and it says what silence means, inside the 600 characters handoffPrompt keeps: ' + brief.length);
  }
}
for (const entry of ['frontend/index.html', 'frontend/agent-station-demo.html']) {
  const html = read(entry);
  const before = html.indexOf('<script src="app/line-verdict.js">');
  A.ok(before >= 0 && before < html.indexOf('<script src="app/pipeline.js">'), entry + ' loads the shared owner before its consumer');
}
A.report('line-verdict.shared');
