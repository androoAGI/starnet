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
for (const entry of ['frontend/index.html', 'frontend/agent-station-demo.html']) {
  const html = read(entry);
  const before = html.indexOf('<script src="app/line-verdict.js">');
  A.ok(before >= 0 && before < html.indexOf('<script src="app/pipeline.js">'), entry + ' loads the shared owner before its consumer');
}
A.report('line-verdict.shared');
