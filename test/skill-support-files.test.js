/* node test/skill-support-files.test.js — an imported skill's support files reach the agent as TEXT (GitHub #145, quick win 33).

   An imported skill package keeps every file base64-encoded (skills/exchange.js: { path, encoding: 'base64', content }),
   and both places a support file is shown to the model printed `content` as-is: skill.view and a preloaded skill
   (/skill, preloadSkills -> runtime.composeLoaded). A references/notes.md arrived as a base64 blob.

   Locks: a base64 file that is valid UTF-8 text is shown as its text, a binary one is named with its size and never
   pasted, a plain-text entry is unchanged — in skill.view AND in the preloaded block. */
'use strict';
const A = require('./_assert.js');
const runtime = require('../sidecar/skills/runtime.js');
const { makeSkillTools } = require('../sidecar/tools/builtin/skills.js');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const notes = '# Notes\nUse the ruler before the saw.\nÜnïcödé stays intact — ✓\n';
const script = 'import sys\nprint(sys.argv[1])\n';
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');   // a PNG header: not UTF-8 text
const nul = Buffer.from('abc\u0000def', 'utf8');                                                  // decodes, but holds NUL: binary
const files = [
  { path: 'references/notes.md', encoding: 'base64', content: b64(notes) },
  { path: 'scripts/run.py', encoding: 'base64', content: b64(script) },
  { path: 'assets/logo.png', encoding: 'base64', content: png.toString('base64') },
  { path: 'assets/blob.bin', encoding: 'base64', content: nul.toString('base64') },
  { path: 'checklist.txt', encoding: 'utf8', content: 'plain text stays as it was' },
  { path: 'legacy.md', content: 'an entry with no encoding is text' }
];
const skill = { id: 'sk1', name: 'carpentry', summary: 'cut straight', body: 'Measure twice.', files, state: 'active' };

function checkShown(out, where) {
  A.ok(out.includes('- references/notes.md\n' + notes), where + ': a base64 markdown reference is shown as its text (UTF-8 intact)');
  A.ok(out.includes('- scripts/run.py\n' + script), where + ': a base64 script is shown as its text');
  A.ok(out.includes('- assets/logo.png (binary file, ' + png.length + ' bytes, not shown as text)'), where + ': a binary file is named with its size');
  A.ok(out.includes('- assets/blob.bin (binary file, ' + nul.length + ' bytes, not shown as text)'), where + ': a decodable blob holding NUL is binary');
  A.ok(out.includes('- checklist.txt\nplain text stays as it was') && out.includes('- legacy.md\nan entry with no encoding is text'), where + ': plain-text entries are unchanged');
  for (const f of files.filter(x => x.encoding === 'base64')) A.ok(!out.includes(f.content), where + ': no base64 blob is pasted (' + f.path + ')');
}

// ---- skill.view ----
(async () => {
  const store = { view: (aid, name) => (name === 'carpentry' ? Object.assign({}, skill) : null) };
  const tools = makeSkillTools({ store });
  const r = await tools.viewTool.run({ name: 'carpentry' }, { agentId: 'agent' });
  A.ok(/^# carpentry\ncut straight\n\nMeasure twice\.\n\nSupport files:\n/.test(r.content), 'skill.view keeps its layout: ' + r.content.slice(0, 80));
  checkShown(r.content, 'skill.view');

  // ---- a preloaded skill (/skill, preloadSkills) ----
  const block = runtime.composeLoaded([skill]);
  A.ok(block.includes('### carpentry -- cut straight\nMeasure twice.\n\nSupport files:\n'), 'the preloaded block keeps its layout');
  checkShown(block, 'preloaded skill');

  // ---- the line on its own ----
  A.eq(runtime.supportFileLine({ path: 'empty.md', encoding: 'base64', content: '' }), '- empty.md', 'an empty file is its path alone');
  A.eq(runtime.supportFileLine(null), '', 'no file: nothing');

  A.report('skill-support-files.test');
})();
