'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { makePackageStore } = require('../sidecar/skills/package.js');
const { makeSkillExchange } = require('../sidecar/skills/exchange.js');
const format = require('../sidecar/skills/package-format.js');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-removal-'));
  try {
    for (const imported of [false, true]) {
      const lines = [];
      let failAppend = false;
      const io = { readAll: () => lines.slice(), append: row => {
        if (failAppend) throw new Error('fixture append failed');
        lines.push(row);
      } };
      const pk = makePackageStore({ fs, pathMod: path, root: path.join(tmp, String(imported)) });
      const boot = () => makeSkillStore({ io, packageStore: pk, stageReviews: false });
      let store = boot(), skill;
      if (imported) {
        const exchange = makeSkillExchange({ skillStore: store, packageStore: pk });
        const preview = await exchange.inspectEnvelope({ envelope: format.toEnvelope(format.canonicalize([
          { path: 'SKILL.md', content: '---\nname: removable-notes\ndescription: Notes\n---\nRead the notes.' },
          { path: 'references/old.md', content: 'obsolete note' }
        ])) });
        skill = exchange.install({ agentId: 'a', inspectionId: preview.inspectionId }).skill;
      } else {
        skill = store.write({ agentId: 'a', name: 'removable-notes', body: 'Read the notes.', createdBy: 'user' }).skill;
        store.manage({ agentId: 'a', target: skill.id, action: 'write_file', path: 'references/old.md', content: 'obsolete note', createdBy: 'user' });
        store.manage({ agentId: 'a', target: skill.id, action: 'write_file', path: 'scripts/keep.txt', content: 'keep this', createdBy: 'user' });
      }
      const dir = pk.packageDir(skill), removed = path.join(dir, 'references/old.md');
      const remove = () => store.manage({ agentId: 'a', target: skill.id, action: 'remove_file', path: 'references/old.md', createdBy: 'user' });
      fs.writeFileSync(path.join(dir, 'LICENSE'), 'license text');
      A.ok(fs.existsSync(removed), 'support file exists before removal');
      failAppend = true;
      A.throws(remove, 'a failed durable append refuses removal');
      A.ok(fs.existsSync(removed), 'a refused removal preserves the mirror');
      failAppend = false;
      A.ok(remove().ok, 'removal is accepted');
      A.eq(fs.existsSync(removed), false, 'removed support file leaves the disk mirror');
      A.ok(!store.view('a', skill.id, { bump: false }).files.some(f => f.path === 'references/old.md'), 'hydration cannot resurrect the removed file');
      store = boot();
      A.ok(!store.view('a', skill.id, { bump: false }).files.some(f => f.path === 'references/old.md'), 'removal survives store restart');
      if (!imported) {
        A.eq(fs.readFileSync(path.join(dir, 'scripts/keep.txt'), 'utf8'), 'keep this', 'remaining support file is preserved');
        store.manage({ agentId: 'a', target: skill.id, action: 'remove_file', path: 'scripts/keep.txt', createdBy: 'user' });
      }
      A.eq(store.view('a', skill.id, { bump: false }).files, [], 'removing the last support file leaves an empty package');
      A.ok(fs.existsSync(path.join(dir, 'SKILL.md')), 'the skill document remains');
      A.eq(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), 'license text', 'root-level package files remain');
    }
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside bytes');
    const pk = makePackageStore({ fs, pathMod: path, root: path.join(tmp, 'links') });
    const skill = { agentId: 'a', id: 'links', body: 'Notes', files: [] };
    const dir = pk.writePackage(skill);
    fs.symlinkSync(outside, path.join(dir, 'references'), 'junction');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.linkSync(path.join(outside, 'keep.txt'), path.join(dir, 'assets/linked.txt'));
    pk.writePackage(skill);
    A.eq(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside bytes', 'pruning symlinks and hardlinks leaves their targets intact');
    A.eq(fs.existsSync(path.join(dir, 'references')), false, 'stale support-directory link is removed');
    A.eq(fs.existsSync(path.join(dir, 'assets/linked.txt')), false, 'stale support-file hardlink is removed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  A.report('skills.package-removal');
})().catch(e => { console.error(e); process.exit(1); });
