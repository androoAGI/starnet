'use strict';
/* One canonical five-character HTML escape, through actual migrated aliases.
   Exact saved source controls prove duplicate implementations and null drift.
   plainTitle in pluginhost is a stripping title sanitizer, not HTML encoding. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const A = require('./_assert.js');
const root = path.resolve(__dirname, '..');
const controlled = process.env.ACK_ESCAPE_CONTROL_DIR;
const read = rel => fs.readFileSync(controlled ? path.join(controlled,
  (rel === 'frontend/js/util.js' ? 'truthful-ack-download-original-' : 'truthful-ack-escape-original-') + rel.replaceAll('/', '-') + '.txt') : path.join(root, rel), 'utf8');
const context = { console, localStorage: { getItem: () => null } };
vm.createContext(context); vm.runInContext(read('frontend/js/util.js') + '\nthis.U=U;', context);
const canonical = context.U;
const vectors = [[null, ''], [undefined, ''], [0, '0'], [false, 'false'], ['&<>"\'', '&amp;&lt;&gt;&quot;&#39;'], ['\u00e9t\u00e9 \u96ea \u{1f680}', '\u00e9t\u00e9 \u96ea \u{1f680}'], ['plain', 'plain']];
for (const [input, output] of vectors) A.eq(canonical.esc(input), output, 'canonical escape preserves text and quotes while treating missing values as empty');
const aliases = { apps: 'esc', cratecard: 'esc', datareset: 'esc', deliverables: 'esc', deskscreen: 'esc', firstvalue: 'esc',
  outputbrowser: 'esc', 'remote-devices': 'esc', schedpicker: 'esc', stepin: 'esc', 'windows/workflows': 'esc',
  tutorial: 'fmEsc', agentportraits: 'escA', updates: 'esc', modelpicker: 'esc', workflowpanel: 'esc', chat: 'escapeHtml' };
const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
for (const [rel, name] of Object.entries(aliases)) {
  const file = 'frontend/app/' + rel + '.js', source = read(file), lines = source.split(/\r?\n/);
  const at = lines.findIndex(line => line.includes('const ' + name + ' =') || line.includes('function ' + name + '('));
  if (at < 0) throw Error('actual alias missing: ' + file);
  const alias = rel === 'modelpicker' && !lines[at].trim().endsWith(';') ? lines.slice(at, at + 3).join('\n') : lines[at];
  let calls = 0;
  const dependency = { esc: s => { calls++; return canonical.esc(s); } };
  const fixture = { U: dependency, H: null, HTML_ESC: { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }, require: createRequire(path.join(root, file)) };
  vm.createContext(fixture); vm.runInContext(alias + '\nthis.escape=' + name + ';', fixture);
  for (const [input, output] of vectors) A.eq(fixture.escape(input), output, file + ': actual page alias keeps complete text/attribute escaping');
  A.eq(calls, vectors.length, file + ': every invocation delegates to the one owner');
  A.ok(!alias.includes('.replace('), file + ': no inline HTML encoder remains');
  const script = 'src="app/' + rel + '.js"';
  A.ok(index.includes(script) && index.indexOf('src="js/util.js"') < index.indexOf(script), file + ': actual page graph loads the canonical owner first');
  if (!controlled) {
    const node = { H: null, require: createRequire(path.join(root, file)) };
    vm.createContext(node); vm.runInContext(alias + '\nthis.escape=' + name + ';', node);
    A.eq(node.escape('&<>"\''), '&amp;&lt;&gt;&quot;&#39;', file + ': CommonJS path reaches the same production owner');
  }
}
// Whole-frontend ratchet, including an inline partial encoder rather than only
// known helper names. Decoder/selector/stripping sanitizers are not encoders.
function encoders(source) {
  return source.split(/\r?\n/).filter(line => line.includes('replace(/[&<>"\']/g')
    || /\.replace\([^\n]*["']&amp;["']/.test(line));
}
A.eq(encoders("return String(s).replace(/[&<>\"']/g, c => MAP[c]);").length, 1, 'census detects a map stored outside the encoder');
A.eq(encoders("text.replace(/&/g, '&amp;').replace(/</g, '&lt;')").length, 1, 'census detects a partial inline encoder');
A.eq(encoders("text.replace(/&amp;/g, '&'); title.replace(/[&<>\"'`]/g, '');").length, 0, 'census leaves entity decoding and stripping sanitizers separate');
const counts = {};
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) { walk(full); continue; }
    if (!item.name.endsWith('.js')) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    const known = rel === 'frontend/js/util.js' || Object.hasOwn(aliases, rel.replace(/^frontend\/app\//, '').replace(/\.js$/, ''));
    const text = controlled && rel === 'frontend/app/app.js'
      ? fs.readFileSync(path.join(controlled, 'truthful-ack-download-original-frontend-app-app.js.txt'), 'utf8')
      : controlled && known ? read(rel) : fs.readFileSync(full, 'utf8');
    const count = encoders(text).length;
    if (count) counts[rel] = count;
  }
}
walk(path.join(root, 'frontend'));
A.eq(counts, { 'frontend/js/util.js': 1 }, 'exact escape-owner baseline: no unreviewed copies or inline encoders');
A.report('escape-parity.census');
