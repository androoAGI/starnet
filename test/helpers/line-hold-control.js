'use strict';
/* test/helpers/line-hold-control.js — the ORIGINAL work-line walk and verdict wording, for the controls of the line-hold lane.

   WHY THIS EXISTS (line-hold S2). Until 5977d433c a verdict-keyed LOOP gate read a reply with NO usable VERDICT line as 'revise':
   five paid passes round the gate, then the work left on DONE marked unapproved. S2 holds it for a person instead (chain.js
   loopDecision, reason 'missing_verdict'). A test that pins the new behaviour must also be shown to FAIL on the old one, and the old
   one must live somewhere that is not a flag in the product. It lives here, as two byte-exact copies of the files at 5977d433c:

     test/fixtures/line-hold-5977d433c/chain.js          sidecar/routing/chain.js          sha256 c5ce9a50b4fa...
     test/fixtures/line-hold-5977d433c/line-verdict.js   frontend/app/line-verdict.js      sha256 f9aac4ac25be...

   They are loaded the way test/line-verdict.shared.test.js loads its saved Pipeline source: compiled AS the production path, so every
   relative require resolves to the product's own modules (work-product, line-fire, line-continuation, pipeline ...), except the one
   the old wording lives behind: the old chain.js gets the OLD line-verdict through './verdict.js'. Production files are never replaced
   and the module cache is never touched.

   pick() is what a rewritten test builds its subject from. By default it is the product. LINE_HOLD_CONTROL=original makes it the
   original, and a rewritten test must then go RED:
       LINE_HOLD_CONTROL=original node test/verdict.blocked.test.js
   original() is always the original, for a test that runs a battery against both (test/line-hold.policy.test.js). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'line-hold-5977d433c');
const PINNED = {
  'chain.js': 'c5ce9a50b4fae3f5f54ee594398511fac119ffaa3da76b260cb892dc1e0558bb',
  'line-verdict.js': 'f9aac4ac25be4e38825d7013939f5fd7f9dc1b2f883d662ea52cb18d36670476'
};

function fixture(name) {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURES, name))).digest('hex');
  if (sha !== PINNED[name]) throw new Error('line-hold control: ' + name + ' is not the preserved 5977d433c source (sha256 ' + sha + ')');
  return text;
}

// compile `source` as the module at `realPath` (its relative requires resolve there); `overrides` answers named requires itself
function compileAt(realPath, source, overrides) {
  const m = new Module(realPath, module);
  m.filename = realPath;
  m.paths = Module._nodeModulePaths(path.dirname(realPath));
  const base = m.require;
  m.require = function (id) { return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : base.call(this, id); };
  m._compile(source, realPath);
  return m.exports;
}

let cached = null;
function original() {
  if (cached) return cached;
  const Verdict = compileAt(path.join(ROOT, 'frontend', 'app', 'line-verdict.js'), fixture('line-verdict.js'), {});
  const chain = compileAt(path.join(ROOT, 'sidecar', 'routing', 'chain.js'), fixture('chain.js'), { './verdict.js': Verdict });
  cached = { chain, Verdict, label: 'original (5977d433c)' };
  return cached;
}

function product() {
  return { chain: require('../../sidecar/routing/chain.js'), Verdict: require('../../sidecar/routing/verdict.js'), label: 'product' };
}

function pick() {
  const want = String(process.env.LINE_HOLD_CONTROL || '').trim().toLowerCase();
  if (want && want !== 'original') throw new Error('LINE_HOLD_CONTROL must be unset or "original"');
  return want === 'original' ? original() : product();
}

module.exports = { pick, original, product, PINNED };
