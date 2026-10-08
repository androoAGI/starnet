/* node test/fs.jail.test.js — the fs.* tools' path jail (the security spine) + a real
   write→read→list roundtrip + the size cap + the deliverable emit. Uses a real temp dir
   so the jail is proven against the actual filesystem, including Windows-specific inputs. */
'use strict';
const A = require('./_assert.js');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const ROOT = path.join(os.tmpdir(), 'starnet-fs-test-' + process.pid);
const { writeTool, readTool, listTool, appendTool, editTool, searchTool, _internals } = makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { writeBytes: 32, readReturn: 1000 } });

async function rejects(promise, msg) { try { await promise; A.ok(false, msg + ' — did NOT reject'); } catch (e) { A.ok(true, msg); } }

(async () => {
  // ---- path jail: every escape attempt is rejected before any I/O ----
  for (const bad of ['../secret', '../../etc/passwd', 'a/../../b', '..\\win', 'sub/../../up', '/abs/unix', 'C:\\windows\\x', '\\\\server\\share']) {
    await rejects(_internals.resolveInside('ag', bad), 'rejects escape: ' + bad);
  }
  // a legitimate nested path is allowed and lands inside the workspace
  {
    const { abs, base } = await _internals.resolveInside('ag', 'reports/q3.md');
    A.ok(abs.indexOf(base + path.sep) === 0, 'legit nested path stays inside the jail');
  }
  // a bad agentId is rejected (no path traversal via the agent segment)
  await rejects(_internals.resolveInside('../evil', 'x.txt'), 'rejects path-traversal agentId');
  // symlink/junction-style escapes: the string path stays under the jail, but the real target does not.
  {
    const outside = path.join(os.tmpdir(), 'starnet-fs-outside-' + process.pid);
    try {
      await fsp.mkdir(path.join(ROOT, 'ag'), { recursive: true });
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'pwn.txt'), 'nope');
      await fsp.symlink(outside, path.join(ROOT, 'ag', 'link'), 'dir');
      await rejects(_internals.resolveInside('ag', 'link/pwn.txt'), 'rejects symlink escape to an outside directory');
    } catch (e) {
      A.ok(true, 'symlink escape regression skipped because this filesystem disallows symlinks');
    } finally {
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch (e) {}
    }
  }
  // A dangling final symlink must not be treated as a missing ordinary file. The
  // former realpath fallback allowed fs.write to create its outside target.
  {
    const outside = path.join(os.tmpdir(), 'starnet-fs-dangling-' + process.pid + '.json');
    const link = path.join(ROOT, 'ag', 'dangling.json');
    let linked = false;
    try { await fsp.symlink(outside, link, 'file'); linked = true; }
    catch (e) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e; }
    if (linked) {
      await rejects(writeTool.run({ path: 'dangling.json', content: 'x' }, { agentId: 'ag' }), 'fs.write refuses a dangling final symlink');
      await rejects(appendTool.run({ path: 'dangling.json', content: 'x' }, { agentId: 'ag' }), 'fs.append refuses a dangling final symlink');
      A.ok(!fs.existsSync(outside), 'dangling symlink did not create the outside target');
      await fsp.unlink(link);
    }
  }

  // ---- write -> read -> list roundtrip (real disk) ----
  {
    const captured = [];
    const ctx = { agentId: 'ag', room: 'office', emit: (name, p) => captured.push({ name, p }) };
    const w = await writeTool.run({ path: 'note.md', content: 'hello world' }, ctx);
    A.ok(/wrote note\.md/.test(w.summary), 'write summary');
    A.eq(w.mutationReceipt.state, 'read-back-verified', 'write success is backed by an exact read-back receipt');
    A.eq(w.mutationReceipt.verifiedBytes, 11, 'write receipt reports the verified byte count');
    A.ok(/^[a-f0-9]{64}$/.test(w.mutationReceipt.sha256), 'write receipt carries the intended byte digest');
    const dl = captured.find(c => c.name === 'deliverable');
    A.ok(dl && dl.p.kind === 'file' && dl.p.title === 'note.md' && dl.p.room === 'office', 'write emits a deliverable');

    const r = await readTool.run({ path: 'note.md' }, ctx);
    A.eq(r.content, 'hello world', 'read returns what was written');

    await writeTool.run({ path: 'sub/deep.txt', content: 'x' }, ctx);
    const ls = await listTool.run({}, ctx);
    A.ok(ls.content.indexOf('note.md') >= 0 && ls.content.indexOf('sub') >= 0, 'list shows files + subdir');
  }

  // ---- size cap rejects oversize writes ----
  await rejects(writeTool.run({ path: 'big.txt', content: 'x'.repeat(64) }, { agentId: 'ag' }), 'oversize write rejected by cap');

  // ---- reading a missing file is a clean error (not a crash) ----
  await rejects(readTool.run({ path: 'nope.md' }, { agentId: 'ag' }), 'missing file -> clean error');

  // ---- large durable text can be recovered in exact ranges without rerunning its producer ----
  {
    const large = 'A'.repeat(1000) + 'MIDDLE' + 'Z'.repeat(1200);
    const dir = path.join(ROOT, 'paged');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'large.txt'), large, 'utf8');
    const p0 = await readTool.run({ path: 'large.txt', offset: 0, limit: 1000 }, { agentId: 'paged' });
    const p1 = await readTool.run({ path: 'large.txt', offset: 1000, limit: 1000 }, { agentId: 'paged' });
    const p2 = await readTool.run({ path: 'large.txt', offset: 2000, limit: 1000 }, { agentId: 'paged' });
    const payload = r => r.content.split('\n[showing characters ')[0];
    A.eq(payload(p0) + payload(p1) + payload(p2), large, 'paged fs.read reconstructs every original character exactly once');
    A.ok(/"offset":1000,"limit":1000/.test(p0.content), 'the truncation receipt gives the exact next read call');
    A.ok(/end of file/.test(p2.content), 'the final page states the durable output is exhausted');
    const beyond = await readTool.run({ path: 'large.txt', offset: large.length + 50, limit: 1000 }, { agentId: 'paged' });
    A.ok(new RegExp('characters ' + large.length + '-' + large.length + ' of ' + large.length).test(beyond.content), 'a continuation beyond EOF clamps to an honest empty terminal range');
  }

  // ---- numbered reads: cat -n style "<n>\t<line>", offset/limit are LINES; the plain default is untouched ----
  {
    const src = 'alpha\nbeta\r\ngamma\ndelta\n';
    const dir = path.join(ROOT, 'numbered');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'src.js'), src, 'utf8');
    const ctx = { agentId: 'numbered' };
    A.eq((await readTool.run({ path: 'src.js' }, ctx)).content, src, 'the plain default returns the bytes exactly as stored (no numbering)');
    A.eq((await readTool.run({ path: 'src.js', raw: true }, ctx)).content, src, 'raw:true is the explicit spelling of the plain path');
    const n = await readTool.run({ path: 'src.js', numbered: true }, ctx);
    A.eq(n.content, '1\talpha\n2\tbeta\n3\tgamma\n4\tdelta', 'numbered: every line is "<n><TAB><text>", CR stripped, no phantom trailing line');
    A.ok(/lines 1-4 of 4/.test(n.summary), 'numbered summary reports the line range');
    const page = await readTool.run({ path: 'src.js', numbered: true, offset: 2, limit: 2 }, ctx);
    A.eq(page.content.split('\n[showing lines ')[0], '2\tbeta\n3\tgamma', 'offset/limit page by 1-based line and line count');
    A.ok(/\[showing lines 2-3 of 4; next: fs\.read \{"path":"src\.js","numbered":true,"offset":4,"limit":2\}\]/.test(page.content), 'the numbered trailer gives the exact next line-paged call');
    const tail = await readTool.run({ path: 'src.js', numbered: true, offset: 4 }, ctx);
    A.eq(tail.content, '4\tdelta\n[showing lines 4-4 of 4; end of file]', 'the last page says end of file');
    const past = await readTool.run({ path: 'src.js', numbered: true, offset: 9 }, ctx);
    A.ok(/past the end/.test(past.content) && /has 4 lines/.test(past.content), 'an offset past EOF is an honest note, not an error or empty string');
    await rejects(readTool.run({ path: 'src.js', numbered: true, limit: 0 }, ctx), 'numbered limit must be positive');
    // the read-return cap ends a numbered page on a WHOLE line and says where to continue
    const long = Array.from({ length: 40 }, (_, i) => 'L' + i + ' ' + 'x'.repeat(60)).join('\n');
    await fsp.writeFile(path.join(dir, 'long.txt'), long, 'utf8');
    const capped = await readTool.run({ path: 'long.txt', numbered: true }, ctx);   // readReturn is 1000 chars here
    const rows = capped.content.split('\n[showing lines ')[0].split('\n');
    A.ok(rows.length > 5 && rows.length < 40 && rows.every(r => /^\d+\tL\d+ x+$/.test(r)), 'a capped numbered page holds only whole numbered lines');
    A.ok(capped.content.indexOf('(output cap); next: fs.read {"path":"long.txt","numbered":true,"offset":' + (rows.length + 1) + ',') >= 0, 'the cap trailer names the next line to continue from');
  }

  // ---- one agent cannot read another agent's workspace via the path ----
  await rejects(readTool.run({ path: '../other/note.md' }, { agentId: 'ag' }), 'cannot escape to a sibling agent workspace');

  // ---- a blessed project session makes relative paths project-native without weakening the jail ----
  {
    const project = path.join(os.tmpdir(), 'starnet-fs-project-' + process.pid);
    await fsp.mkdir(project, { recursive: true });
    await fsp.writeFile(path.join(project, 'incident.log'), 'PROJECT_LOG', 'utf8');
    const guarded = [];
    const guard = async (abs, o) => {
      guarded.push({ abs, scope: o.scope });
      if (!_internals.pathInside(abs, project)) throw new Error('not blessed');
      return { base: project, abs };
    };
    const PT = makeFsTools({ fsp, pathMod: path, root: ROOT, pathTrust: guard, limits: { writeBytes: 64, readReturn: 1000 } });
    const ctx = { agentId: 'project-agent', projectRoot: project };
    A.eq((await PT.readTool.run({ path: 'incident.log' }, ctx)).content, 'PROJECT_LOG', 'project-scoped fs.read resolves a relative path at projectRoot');
    const pw = await PT.writeTool.run({ path: 'fix.txt', content: 'PROJECT_FIX' }, ctx);
    A.eq(await fsp.readFile(path.join(project, 'fix.txt'), 'utf8'), 'PROJECT_FIX', 'project-scoped fs.write lands in projectRoot');
    // issue #60: the receipt names WHERE the bytes went, so a verified write can't hide a wrong base folder
    A.ok(pw.content.indexOf('[location: ' + path.join(project, 'fix.txt') + ']') >= 0, 'project write receipt names the absolute project location');
    const privW = await PT.writeTool.run({ path: 'priv.txt', content: 'P' }, { agentId: 'project-agent' });
    A.ok(/\[location: .*priv\.txt \(your private workspace, not a project folder;/.test(privW.content), 'unscoped write receipt says it landed in the private workspace, not a project');
    A.ok(/absolute path inside it, or work from a conversation scoped to that project\)\]/.test(privW.content), 'and names the way into a project folder (absolute path, or a project-scoped conversation)');
    A.ok(!fs.existsSync(path.join(ROOT, 'project-agent', 'fix.txt')), 'project write does not silently land in the private workspace');
    A.ok(guarded.some(x => x.scope === 'read') && guarded.some(x => x.scope === 'write'), 'project-relative reads and writes still pass through path trust');
    await rejects(PT.readTool.run({ path: '../outside.txt' }, ctx), 'project-relative traversal remains illegal');
    const unscoped = await PT._internals.resolveInside('project-agent', 'plain.txt', { scope: 'read', ctx: { agentId: 'project-agent' } });
    A.ok(unscoped.abs.indexOf(path.join(ROOT, 'project-agent')) === 0, 'an unscoped session keeps the historic private-workspace root');
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- fs.append: creates then adds without clobbering; respects the combined-size cap ----
  {
    const ctx = { agentId: 'ag2' };
    await appendTool.run({ path: 'log.txt', content: 'a' }, ctx);
    const appended = await appendTool.run({ path: 'log.txt', content: 'b' }, ctx);
    A.eq(appended.mutationReceipt.state, 'read-back-verified', 'append is not reported successful until combined bytes are reread');
    A.eq((await readTool.run({ path: 'log.txt' }, ctx)).content, 'ab', 'append creates then adds without clobbering');
    await rejects(appendTool.run({ path: 'log.txt', content: 'x'.repeat(64) }, ctx), 'append respects the combined-size cap');
  }
  // ---- fs.edit: exact replace + replacement count; errors when find is absent ----
  {
    const ctx = { agentId: 'ag3' };
    await writeTool.run({ path: 'e.txt', content: 'foo bar' }, ctx);
    const e = await editTool.run({ path: 'e.txt', find: 'foo', replace: 'baz' }, ctx);
    A.ok(/1 replacement/.test(e.content), 'edit reports the replacement count');
    A.eq(e.mutationReceipt.state, 'read-back-verified', 'edit carries a verified mutation receipt');
    A.eq((await readTool.run({ path: 'e.txt' }, ctx)).content, 'baz bar', 'edit applied to disk');
    await rejects(editTool.run({ path: 'e.txt', find: 'nope', replace: 'x' }, ctx), 'edit errors when "find" is absent');
  }
  // ---- fs.edit UNIQUENESS: a multi-match "find" is refused unless replace_all / expected_count says so ----
  {
    const ctx = { agentId: 'ag3u' };
    await writeTool.run({ path: 'm.txt', content: 'x=1; x=2; x=3;' }, ctx);
    let err = null;
    try { await editTool.run({ path: 'm.txt', find: 'x=', replace: 'y=' }, ctx); } catch (e) { err = e; }
    A.ok(err && /matches 3 places/.test(err.message) && /replace_all/.test(err.message) && /expected_count/.test(err.message), 'multi-match find is refused with the count + both escape hatches named');
    A.eq((await readTool.run({ path: 'm.txt' }, ctx)).content, 'x=1; x=2; x=3;', 'a refused multi-match edit changed NOTHING');
    err = null;
    try { await editTool.run({ path: 'm.txt', find: 'x=', replace: 'y=', expected_count: 2 }, ctx); } catch (e) { err = e; }
    A.ok(err && /matches 3 places/.test(err.message) && /expected_count is 2/.test(err.message), 'a wrong expected_count is refused with both numbers');
    await rejects(editTool.run({ path: 'm.txt', find: 'x=', replace: 'y=', expected_count: 0 }, ctx), 'expected_count must be a positive integer');
    const e3 = await editTool.run({ path: 'm.txt', find: 'x=', replace: 'y=', expected_count: 3 }, ctx);
    A.ok(/3 replacements/.test(e3.content), 'an exact expected_count applies all matches');
    A.eq((await readTool.run({ path: 'm.txt' }, ctx)).content, 'y=1; y=2; y=3;', 'expected_count edit landed');
    const e4 = await editTool.run({ path: 'm.txt', find: 'y=', replace: 'z=', replace_all: true }, ctx);
    A.ok(/3 replacements/.test(e4.content), 'replace_all applies every match');
    A.eq((await readTool.run({ path: 'm.txt' }, ctx)).content, 'z=1; z=2; z=3;', 'replace_all edit landed');
    const e5 = await editTool.run({ path: 'm.txt', find: 'z=1', replace: 'w=1' }, ctx);
    A.ok(/1 replacement\b/.test(e5.content), 'exactly-one-match keeps the historic path with no flag');
  }
  // ---- fs.edit READ-BEFORE-EDIT: a file this agent never observed is refused with a machine-readable precondition ----
  {
    const ctx = { agentId: 'ag3r' };
    await fsp.mkdir(path.join(ROOT, 'ag3r'), { recursive: true });
    await fsp.writeFile(path.join(ROOT, 'ag3r', 'unseen.txt'), 'alpha beta');   // created OUTSIDE the tools
    let err = null;
    try { await editTool.run({ path: 'unseen.txt', find: 'alpha', replace: 'omega' }, ctx); } catch (e) { err = e; }
    A.ok(err && /have not read unseen\.txt/.test(err.message), 'editing a never-read file is refused');
    A.ok(err && /in this run/.test(err.message) && !/in this session/.test(err.message), 'the refusal says "in this run" (read stamps live per run: makeFsTools is rebuilt each run)');
    A.eq(err && err.precondition, { code: 'read_before_edit', requiredTool: 'fs.read', requiredState: 'current_file_observed' }, 'the refusal names fs.read as the precondition');
    A.eq(await fsp.readFile(path.join(ROOT, 'ag3r', 'unseen.txt'), 'utf8'), 'alpha beta', 'nothing was written');
    await readTool.run({ path: 'unseen.txt' }, ctx);
    const ok = await editTool.run({ path: 'unseen.txt', find: 'alpha', replace: 'omega' }, ctx);
    A.ok(/Edited unseen\.txt/.test(ok.content), 'after fs.read the same edit lands');
    // a file this agent itself created via the tools is already observed — create-then-edit never trips
    await writeTool.run({ path: 'mine.txt', content: 'one two' }, ctx);
    A.ok(/Edited mine\.txt/.test((await editTool.run({ path: 'mine.txt', find: 'one', replace: '1' }, ctx)).content), 'a file written via fs.write is editable without a separate read');
  }
  // ---- fs.list recursive: nested tree with dir markers ----
  {
    const ctx = { agentId: 'ag4' };
    await writeTool.run({ path: 'a.txt', content: '1' }, ctx);
    await writeTool.run({ path: 'sub/b.txt', content: '2' }, ctx);
    const tree = await listTool.run({ recursive: true }, ctx);
    A.ok(tree.content.indexOf('sub/') >= 0 && tree.content.indexOf('sub/b.txt') >= 0, 'recursive list shows the nested tree');
  }

  // ---- two concurrent agents writing the SAME relative path do NOT collide (per-agent jail roots) ----
  {
    const a = { agentId: 'alpha' }, b = { agentId: 'beta' };
    await writeTool.run({ path: 'note.md', content: 'A-content' }, a);
    await writeTool.run({ path: 'note.md', content: 'B-content' }, b);
    A.eq((await readTool.run({ path: 'note.md' }, a)).content, 'A-content', 'alpha reads its own note.md');
    A.eq((await readTool.run({ path: 'note.md' }, b)).content, 'B-content', 'beta reads its own note.md (no clobber by alpha)');
    const ra = await _internals.resolveInside('alpha', 'note.md');
    const rb = await _internals.resolveInside('beta', 'note.md');
    A.ok(ra.base !== rb.base, 'each agent resolves under a DISTINCT per-agent jail base');
    A.ok(ra.abs !== rb.abs, 'the same relative path lands at different absolute paths per agent');
  }

  // ---- fs.search: content grep over the workspace (path:line: text), bounded + jailed ----
  {
    const ctx = { agentId: 'srch' };
    await writeTool.run({ path: 'a.txt', content: 'alpha TODO one' }, ctx);   // <=32 bytes
    await writeTool.run({ path: 'sub/b.txt', content: 'beta todo two' }, ctx);
    await writeTool.run({ path: 'c.txt', content: 'no marker here' }, ctx);

    // substring is case-sensitive by default: only a.txt's "TODO" matches
    const s1 = await searchTool.run({ query: 'TODO' }, ctx);
    A.ok(s1.content.indexOf('a.txt:1: alpha TODO one') >= 0, 'search finds the substring with workspace-relative path:line');
    A.ok(s1.content.indexOf('b.txt') < 0, 'case-sensitive substring does NOT match lowercase "todo"');

    // ignoreCase catches both
    const s2 = await searchTool.run({ query: 'todo', ignoreCase: true }, ctx);
    A.ok(s2.content.indexOf('a.txt:1:') >= 0 && s2.content.indexOf('sub/b.txt:1:') >= 0, 'ignoreCase matches both files');

    // regex
    const s3 = await searchTool.run({ query: 'beta|gamma', regex: true }, ctx);
    A.ok(s3.content.indexOf('sub/b.txt:1:') >= 0, 'regex alternation matches');
    await rejects(searchTool.run({ query: '(unclosed', regex: true }, ctx), 'invalid regex -> clean error');

    // path scope limits the search to a subdirectory (paths stay workspace-root-relative)
    const s4 = await searchTool.run({ query: 'todo', ignoreCase: true, path: 'sub' }, ctx);
    A.ok(s4.content.indexOf('sub/b.txt:1:') >= 0 && s4.content.indexOf('a.txt:') < 0, 'path scopes the search to the subdir');

    // no matches is a clean (non-error) result
    const s5 = await searchTool.run({ query: 'zzz-nope' }, ctx);
    A.ok(/0 matches/.test(s5.summary), 'no matches -> clean "0 matches" result');

    // empty query is rejected; the jail still applies to the start path
    await rejects(searchTool.run({ query: '' }, ctx), 'empty query rejected');
    await rejects(searchTool.run({ query: 'x', path: '../other' }, ctx), 'search cannot escape the workspace jail');
  }

  // ---- fs.search v2 (parity with the reference harness): targets, output modes, file_glob, context, densify, paging, redact ----
  {
    const SX = path.join(ROOT, 'sx');
    await fsp.mkdir(path.join(SX, 'lib'), { recursive: true });
    await fsp.mkdir(path.join(SX, '.secret'), { recursive: true });
    await fsp.mkdir(path.join(SX, 'node_modules'), { recursive: true });
    // fixtures written directly (bypass the 32-byte tool cap) — content search is read-only anyway
    await fsp.writeFile(path.join(SX, 'app.js'), 'function alpha() {\n  // TODO refactor alpha\n  return 1\n}\n');
    await fsp.writeFile(path.join(SX, 'lib', 'util.js'), '// TODO test util\nfunction beta() {\n  return alpha() // TODO wire\n}\n');
    await fsp.writeFile(path.join(SX, 'notes.md'), '# Notes\nTODO write docs\nTODO ship it\nTODO review\n');
    await fsp.writeFile(path.join(SX, '.secret', 'h.js'), 'TODO hidden\n');            // hidden dir -> skipped
    await fsp.writeFile(path.join(SX, 'node_modules', 'dep.js'), 'TODO dep\n');         // node_modules -> skipped
    await fsp.writeFile(path.join(SX, 'data.bin'), Buffer.from([0, 84, 79, 68, 79]));   // NUL -> binary, skipped
    const ctx = { agentId: 'sx' };
    const lines = s => s.content.split('\n');

    // content mode, 6 matches across 3 files -> DENSIFIED (path header once, then "  <line>: text")
    const c = await searchTool.run({ query: 'TODO' }, ctx);
    A.ok(c.content.indexOf('TODO hidden') < 0, 'hidden dirs are skipped (rg default)');
    A.ok(c.content.indexOf('TODO dep') < 0, 'node_modules is skipped');
    A.ok(/6 matches in 3 file/.test(c.summary), 'counts true matches across files (binary/hidden/node_modules excluded)');
    A.ok(lines(c).indexOf('app.js') >= 0 && lines(c).indexOf('lib/util.js') >= 0 && lines(c).indexOf('notes.md') >= 0, 'densified: each file path on its own header line');
    A.ok(lines(c).some(l => /^ {2}\d+: .*TODO/.test(l)), 'densified: indented "  <line>: <content>" match rows');

    // count mode -> matches per file
    const cnt = await searchTool.run({ query: 'TODO', output_mode: 'count' }, ctx);
    A.ok(/app\.js: 1/.test(cnt.content) && /lib\/util\.js: 2/.test(cnt.content) && /notes\.md: 3/.test(cnt.content), 'count mode reports matches per file');

    // files_only -> just the paths with matches
    const fo = await searchTool.run({ query: 'TODO', output_mode: 'files_only' }, ctx);
    A.eq(lines(fo).filter(Boolean).sort(), ['app.js', 'lib/util.js', 'notes.md'], 'files_only lists the matching file paths');

    // file_glob restricts which files are searched
    const fg = await searchTool.run({ query: 'TODO', output_mode: 'count', file_glob: '*.md' }, ctx);
    A.ok(/notes\.md: 3/.test(fg.content) && fg.content.indexOf('app.js') < 0, 'file_glob limits the search to matching files');

    // context lines: a match row (":") plus neighbouring context rows ("-")
    const cc = await searchTool.run({ query: 'beta', file_glob: '*.js', context: 1 }, ctx);
    A.ok(/^ {2}2: function beta/m.test(cc.content), 'context: the match line is shown with ":"');
    A.ok(/^ {2}1- /m.test(cc.content) && /^ {2}3- /m.test(cc.content), 'context: surrounding lines are shown with "-"');

    // target 'files': glob over names
    const ff = await searchTool.run({ query: '*.js', target: 'files' }, ctx);
    A.eq(lines(ff).filter(Boolean).sort(), ['app.js', 'lib/util.js'], 'target files: glob matches both .js files (hidden/node_modules excluded)');
    const fmd = await searchTool.run({ query: '*.md', target: 'files' }, ctx);
    A.eq(lines(fmd).filter(Boolean), ['notes.md'], 'target files: *.md finds the markdown file');
    const fu = await searchTool.run({ query: '*util*', target: 'files' }, ctx);
    A.eq(lines(fu).filter(Boolean), ['lib/util.js'], 'target files: substring glob finds the nested file');

    // paging: limit + offset + an actionable next-offset hint
    const p1 = await searchTool.run({ query: 'TODO', limit: 2, offset: 0 }, ctx);
    A.ok(/\[truncated/.test(p1.content) && /offset=2/.test(p1.content), 'paging: truncation hint names the next offset');
    A.ok(/showing 2/.test(p1.summary), 'paging: summary reports the shown count');

    // redaction: surfaced lines are scrubbed (separate instance with a redact dep)
    const RID = makeFsTools({ fsp, pathMod: path, root: ROOT, redact: s => String(s).replace(/sk-secret-\d+/g, '[REDACTED]') });
    await fsp.mkdir(path.join(ROOT, 'sxr'), { recursive: true });
    await fsp.writeFile(path.join(ROOT, 'sxr', 'creds.md'), 'TODO use key sk-secret-123 here\n');
    const rr = await RID.searchTool.run({ query: 'TODO' }, { agentId: 'sxr' });
    A.ok(rr.content.indexOf('[REDACTED]') >= 0 && rr.content.indexOf('sk-secret-123') < 0, 'fs.search redacts secrets out of surfaced lines (§5.6)');
  }

  // ---- NS-5: an absolute path is ILLEGAL when no pathTrust is wired, and ROUTED to it when it is ----
  {
    // unwired (this file's default tools): every absolute form stays illegal (the historic jail invariant)
    for (const abs of ['/etc/passwd', 'C:\\Windows\\x', '\\\\server\\share\\y']) {
      await rejects(_internals.resolveInside('ag', abs), 'unwired: absolute path stays illegal: ' + abs);
    }
    // wired: an absolute path is handed to the injected guard verbatim, with the tool's scope threaded
    const seen = [];
    const guard = async (abs, o) => { seen.push({ abs, scope: o.scope, agentId: o.agentId }); return { base: '/blessed', abs: abs }; };
    const WT = makeFsTools({ fsp, pathMod: path, root: ROOT, pathTrust: guard });
    const rr = await WT._internals.resolveInside('agz', '/outside/project/file.txt', { scope: 'read', ctx: { agentId: 'agz' } });
    A.ok(rr.abs === '/outside/project/file.txt' && rr.base === '/blessed', 'wired: absolute path is resolved via the injected guard');
    A.ok(seen.length === 1 && seen[0].scope === 'read' && seen[0].agentId === 'agz', 'guard receives the absolute path with scope + agentId');
    // a write tool threads scope:'write' to the guard (so writes can stay consent-gated by the caller)
    const checkpoints = [];
    await WT.writeTool.run({ path: '/outside/project/w.txt', content: 'x' }, {
      agentId: 'agz', checkpointMutation: async (root, label, opts) => checkpoints.push({ root, label, opts })
    }).catch(() => {});
    A.ok(seen.some(s => s.scope === 'write'), 'a write tool threads scope:"write" to the guard');
    A.eq(checkpoints.length, 1, 'external fs write asks the host to checkpoint before filesystem mutation');
    A.eq(checkpoints[0].root, '/blessed', 'checkpoint binds to the root resolved by path trust, not the agent jail');
    A.eq(checkpoints[0].opts.resolvedRoot, true, 'one-time path authorization is explicitly host-marked for snapshot creation');
    // NUL is illegal even with a guard wired (never reaches the guard)
    await rejects(WT._internals.resolveInside('agz', '/a/\0/b', { scope: 'read' }), 'NUL stays illegal even when pathTrust is wired');
    // a relative path is UNAFFECTED by the guard — still jailed, guard never consulted for it
    const before = seen.length;
    await WT._internals.resolveInside('agz', 'inside/rel.txt', { scope: 'read' });
    A.ok(seen.length === before, 'a relative path never reaches the guard (jail path unchanged)');
  }

  /* ---- fs.search obeys the SAME jail as fs.read ----
     resolveInside's realpath proof only covers the path the CALLER names; the walk that follows never
     re-proved what it reached, so fs.read refused a jail-escaping symlink while fs.search grepped its
     CONTENTS and printed the matching line. Simulated over an injected POSIX fs so it runs on a host that
     cannot create symlinks (Windows without developer mode). ---- */
  {
    const P = require('node:path').posix;
    const PM = Object.assign({}, P, { sep: '/', win32: require('node:path').win32, posix: P });
    const LINK = '/ws/agent/leak.txt', TARGET = '/outside/.ssh/id_rsa', SECRET = 'BEGIN PRIVATE KEY SUPER_SECRET';
    const dirent = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link', isFile: () => kind === 'file' });
    const fakeFsp = {
      async mkdir() {},
      async readdir(dir) { return dir === '/ws/agent' ? [dirent('leak.txt', 'link'), dirent('notes.md', 'file')] : []; },
      async stat() { return { mtimeMs: 1, isFile: () => true, isDirectory: () => false }; },
      async lstat() { return {}; },
      async realpath(p) { return p === LINK ? TARGET : p; },
      async readFile(p, enc) {
        if (p === LINK) return enc ? SECRET : Buffer.from(SECRET);
        if (p === '/ws/agent/notes.md') return enc ? 'hello' : Buffer.from('hello');
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    };
    const T = makeFsTools({ fsp: fakeFsp, pathMod: PM, root: '/ws' });
    const c = { agentId: 'agent' };
    await rejects(T.readTool.run({ path: 'leak.txt' }, c), 'fs.read refuses a symlink that escapes the jail');
    const hit = await T.searchTool.run({ query: 'SUPER_SECRET' }, c);
    A.ok(hit.content.indexOf(SECRET) < 0, 'fs.search does NOT read through the same escaping symlink');
    A.eq(hit.summary.indexOf('0 matches'), 0, 'and reports no match rather than the jailbroken line');
  }

  /* ---- a path-shaped file_glob must actually filter by PATH ----
     It was built from the full pattern but tested against the basename, so "src/*.js" matched nothing and
     returned a clean "0 matches" — indistinguishable from "the text isn't there". ---- */
  {
    const dir = path.join(ROOT, 'globby');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'needle here\n');
    fs.writeFileSync(path.join(dir, 'top.js'), 'needle here\n');
    const T = makeFsTools({ fsp: require('node:fs/promises'), pathMod: path, root: ROOT });
    const c = { agentId: 'globby' };
    const scoped = await T.searchTool.run({ query: 'needle', file_glob: 'src/*.js' }, c);
    A.ok(/src\/a\.js/.test(scoped.content), 'a path-shaped file_glob matches inside the named directory');
    A.ok(!/top\.js/.test(scoped.content), 'and excludes files outside it');
    const bare = await T.searchTool.run({ query: 'needle', file_glob: '*.js' }, c);
    A.eq(bare.summary.indexOf('2 matches'), 0, 'a bare name glob still matches by basename everywhere');
  }

  /* ---- a model-supplied regex must never be able to freeze the station ----
     fs.search { regex:true } compiles the MODEL's string and runs it synchronously over every line of every
     candidate file. StarNet is ONE process — UI, API, SSE bus, every agent run — so a backtracking blow-up
     pegged the event loop indefinitely: measured, `(a|a)+$` against a 41-character line never returned and
     the tool's own timeoutMs could not help (withTimeout rejects the promise; it cannot stop synchronous
     work). Only killing the process recovered. ---- */
  {
    const dir = path.join(ROOT, 'redos');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'const x = "' + 'a'.repeat(40) + 'b";\nfunction handler() {}\n');
    const T = makeFsTools({ fsp: require('node:fs/promises'), pathMod: path, root: ROOT });
    const c = { agentId: 'redos' };
    const refused = async (q) => {
      try { await T.searchTool.run({ query: q, regex: true }, c); return false; }
      catch (e) { return /backtrack catastrophically/.test(e.message); }
    };
    for (const q of ['(a|a)+$', '(\\s+)+$', '(.*)*x', '(a+)+', '(ab|abc)+'])
      A.ok(await refused(q), 'catastrophic pattern refused (fast, not hung): ' + q);
    // ...and the floor must not eat ordinary search patterns
    for (const q of ['function\\s+\\w+', '(ab|cd)+', '^const\\s', 'handler|x', '(?:foo|bar)baz'])
      A.ok(!(await refused(q)), 'ordinary pattern still allowed: ' + q);
    const hit = await T.searchTool.run({ query: 'handler', regex: true }, c);
    A.ok(/handler/.test(hit.content), 'a real regex search still returns its matches');
  }

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  A.report('fs.jail.test');
})();
