/* sidecar/skills/package.js - filesystem-backed runtime skill packages.

   StarNet's append-only JSONL skill log remains the durable event stream.
   This module mirrors the latest skill state into inspectable package dirs:

     <root>/<agentId>/<skillId>/SKILL.md
     <root>/<agentId>/<skillId>/references|templates|scripts|assets/...

   It is dependency-injected for tests and sidecar containment.
*/
'use strict';
const packageFormat = require('./package-format.js');
const catalog = require('./catalog.js');
const FileBytes = require('./file-bytes.js');   // the canonical-bytes boundary: every file crosses disk <-> store through it
const { note: failNote } = require('../failopen.js');
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillPackage = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUPPORT_DIRS = ['references', 'templates', 'scripts', 'assets'];
  function str(v) { return v == null ? '' : String(v); }
  function escYaml(v) { return JSON.stringify(str(v)); }
  function arr(v) { return Array.isArray(v) ? v.map(x => str(x)).filter(Boolean) : []; }
  function safeSegment(v) {
    return str(v).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
  }
  function supportPath(raw) {
    let p = str(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    if (!p || /^[A-Za-z]:/.test(p) || p.indexOf('..') >= 0 || /[\x00-\x1F]/.test(p)) return null;
    const root = p.split('/')[0];
    if (SUPPORT_DIRS.indexOf(root) < 0 || p === root) return null;
    return p;
  }
  function frontmatter(skill) {
    const lines = [
      '---',
      'name: ' + escYaml(skill.name || skill.id || 'Skill'),
      'description: ' + escYaml(skill.description || skill.summary || ''),
      'category: ' + escYaml(skill.category || 'General'),
      'state: ' + escYaml(skill.state || 'active'),
      'created_by: ' + escYaml(skill.createdBy || 'agent'),
      'source_run_id: ' + escYaml(skill.sourceRunId || ''),
      'pinned: ' + (!!skill.pinned ? 'true' : 'false')
    ];
    if (skill.sourceUrl) lines.push('source_url: ' + escYaml(skill.sourceUrl));
    if (skill.sourceDigest) lines.push('source_digest: ' + escYaml(skill.sourceDigest));
    if (skill.sourceVersion) lines.push('source_version: ' + escYaml(skill.sourceVersion));
    if (skill.sourceAuthor) lines.push('source_author: ' + escYaml(skill.sourceAuthor));
    if (skill.sourceLicense) lines.push('source_license: ' + escYaml(skill.sourceLicense));
    // Consolidation lineage: an archived package says which live skill absorbed it, so the merge is
    // readable on disk and not just in the JSONL log.
    if (skill.absorbedInto) lines.push('absorbed_into: ' + escYaml(skill.absorbedInto));
    const platforms = arr(skill.platforms);
    const requires = arr(skill.requires);
    if (platforms.length) lines.push('platforms: [' + platforms.map(escYaml).join(', ') + ']');
    if (requires.length) lines.push('requires: [' + requires.map(escYaml).join(', ') + ']');
    lines.push('---');
    return lines.join('\n');
  }
  function renderSkillMd(skill) {
    const setup = str(skill.setup).trim();
    const body = str(skill.body).trim();
    const files = Array.isArray(skill.files) ? skill.files : [];
    const pointers = files.length
      ? '\n\n## Support Files\n' + files.map(f => '- `' + str(f.path) + '`').join('\n')
      : '';
    return frontmatter(skill) + '\n\n' + (setup ? '## Setup\n' + setup + '\n\n' : '') + body + pointers + '\n';
  }
  /* INVERSE of renderSkillMd's composition. hydrate() reads back a document THIS module wrote, so the
     leading '## Setup' section and the trailing '## Support Files' pointer list in it are RENDERED
     artifacts, not part of the author's body. Handing them back as `body` breaks the round-trip: the
     next persist renders a second '## Setup' in front of a body that already has one — unbounded growth,
     one copy per cycle — and skill.view prints the setup twice, because it composes setup + body + files
     itself from the separate fields.

     The Setup section's END is a blank line, and a setup value may itself contain blank lines, so the
     boundary CANNOT be recovered from the document text alone. Do not guess: strip the EXACT block the
     renderer would have written for the values we already hold (`known`), repeatedly, so a package
     already corrupted by the re-append heals instead of carrying its duplicates forever.

     When the document has a '## Setup' heading we cannot claim exactly — someone hand-edited SKILL.md,
     which the package dir is explicitly there to invite — we keep the WHOLE region as the body and
     report setup:'' rather than guessing a split. Nothing is lost (the setup text stays where the author
     put it) and the round-trip is still a fixed point: an empty setup renders no Setup block, so the
     next hydrate reads back the same bytes.

     The trailing pointer list IS unambiguous (every line is a backtick-quoted path), so it is matched
     structurally — that also strips a list gone stale against the files now on disk. A '## Support
     Files' section written as prose does not match and is left alone. */
  function splitRendered(text, known) {
    let body = str(text).trim();
    known = known || {};
    const knownSetup = str(known.setup).trim();
    let setup = '';
    if (knownSetup) {
      const block = '## Setup\n' + knownSetup;
      while (body === block || body.indexOf(block + '\n') === 0) {
        body = body.slice(block.length).replace(/^(?:\r?\n)+/, '');
        setup = knownSetup;
      }
    }
    // No claim possible and the region still opens with a Setup heading: hand-edited. Leave it in the body.
    if (!setup && /^##[ \t]+Setup[ \t]*(?:\r?\n|$)/.test(body)) setup = '';
    else if (!setup) setup = knownSetup;   // the heading is simply absent; keep what we hold
    for (;;) {
      const tail = body.match(/(?:^|\r?\n)##[ \t]+Support Files[ \t]*\r?\n(?:[ \t]*-[ \t]+`[^`\r\n]*`[ \t]*(?:\r?\n|$))+$/);
      if (!tail) break;
      body = body.slice(0, body.length - tail[0].length).replace(/(?:\r?\n)+$/, '');
    }
    return { setup, body: body.trim() };
  }
  /* ONE frontmatter reader for every SKILL.md (skills/catalog.js). The copy that lived here was flat: an installed
     standard skill's `description: >-` hydrated as the text '>-', and our own JSON-quoted values came back with
     their escapes still in them. */
  function parseFrontmatter(text) {
    const parsed = catalog.parseFrontmatter(str(text));
    const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
    if (typeof meta.description === 'string') meta.description = meta.description.replace(/\s+/g, ' ').trim();
    return { meta, body: parsed.body };
  }

  function makePackageStore(opts) {
    opts = opts || {};
    const fs = opts.fs;
    const path = opts.pathMod;
    const root = opts.root;
    const now = typeof opts.now === 'function' ? opts.now : () => 0;
    if (!fs || !path || !root) {
      return { writePackage() {}, hydrate(skill) { return skill; }, packageDir() { return ''; }, renderSkillMd, parseFrontmatter, splitRendered };
    }
    function packageDir(skill) {
      return path.join(root, safeSegment(skill.agentId || 'agent'), safeSegment(skill.id || skill.name || 'skill'));
    }
    function archiveDir(skill) {
      return path.join(root, '.archive', safeSegment(skill.agentId || 'agent'), safeSegment(skill.id || skill.name || 'skill'));
    }
    function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
    /* PATH REDIRECT GUARD. supportPath() already refuses `..`, absolute paths, drive letters and
       control bytes, so the STRING can't escape — but a SYMLINK can: if `skill-packages/agent/x`
       or a `references` dir inside it is a link, a "contained" relative write lands wherever the
       link points. String validation cannot see that; only resolving can. Resolve the deepest
       existing ancestor, re-attach the rest, and require the result to sit under the real root. */
    function realOf(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
    function insideRoot(target) {
      const rootReal = realOf(root) || path.resolve(root);
      let probe = path.resolve(target);
      const rest = [];
      for (;;) {
        const real = realOf(probe);
        if (real) {
          const full = rest.length ? path.join(real, rest.join(path.sep)) : real;
          const rel = path.relative(rootReal, full);
          return !!rel && rel.indexOf('..') !== 0 && !path.isAbsolute(rel);
        }
        const parent = path.dirname(probe);
        if (parent === probe) return false;    // walked past the filesystem root without finding anything real
        rest.unshift(path.basename(probe));
        probe = parent;
      }
    }
    function writeText(file, text) {
      // Check BEFORE mkdir: creating the directory chain first would materialize the escape path.
      if (!insideRoot(file)) throw new Error('skill package path escapes the package root: ' + file);
      ensureDir(path.dirname(file));
      if (!insideRoot(file)) throw new Error('skill package path escapes the package root: ' + file);
      fs.writeFileSync(file, text, 'utf8');
    }
    function writeBytes(file, bytes) {
      if (!insideRoot(file)) throw new Error('skill package path escapes the package root: ' + file);
      ensureDir(path.dirname(file));
      if (!insideRoot(file)) throw new Error('skill package path escapes the package root: ' + file);
      fs.writeFileSync(file, bytes);
    }
    function projectedFiles(skill) {
      const files = Array.isArray(skill.files) ? skill.files : [];
      return files.map(f => ({ path: supportPath(f.path), content: str(f.content), encoding: f.encoding === 'base64' ? 'base64' : 'utf8', updatedAt: f.updatedAt || 0 })).filter(f => f.path);
    }
    function writePackage(skill, wopts) {
      ensureDir(root);   // so insideRoot() can realpath the root itself — a root that does not exist yet would otherwise compare an unresolved path against resolved ones (fail-closed on any symlinked save dir)
      const dir = skill.state === 'archived' ? archiveDir(skill) : packageDir(skill);
      const visible = packageDir(skill);
      if (skill.state === 'archived' && visible !== dir) {
        try { if (fs.existsSync(visible)) fs.rmSync(visible, { recursive: true, force: true }); } catch (_) {}
      }
      ensureDir(dir);
      if (Array.isArray(skill.packageFiles) && skill.packageFiles.length && skill.packageDigest && !skill.packageDiverged) {
        const pkg = packageFormat.fromEnvelope({ format: packageFormat.FORMAT, digest: skill.packageDigest, files: skill.packageFiles });
        // The manifest is complete, so the directory must be complete too. Remove the prior contained
        // generation before writing; otherwise an upstream-deleted script remains executable on disk.
        if (!insideRoot(dir)) throw new Error('skill package path escapes the package root: ' + dir);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        ensureDir(dir);
        for (const f of pkg.files) writeBytes(path.join(dir, f.path), Buffer.from(f.content, 'base64'));
        return dir;
      }
      /* AN EDITED PACKAGE KEEPS ITS FILES' BYTES (bug a36d1b00). Every file of an installed package was stored base64, and
         this path wrote the stored TEXT: references/setup.md became a line of base64 on disk, a script stopped running, and
         readSupportFiles() read the base64 back as the file. Each file is written as the bytes it holds (FileBytes). */
      const s = Object.assign({}, skill, { files: projectedFiles(skill) });
      writeText(path.join(dir, 'SKILL.md'), renderSkillMd(s));
      for (const f of s.files) writeBytes(path.join(dir, f.path), FileBytes.bytesOf(f));
      removeDropped(dir, skill, wopts && wopts.previous);
      return dir;
    }
    /* A FILE THE SKILL NO LONGER HOLDS LEAVES ITS MIRROR (remove_file). This path only ever added, so a removed reference
       stayed on disk and hydrate() kept delivering it (a view that no longer digested to the stamp). Only a path the
       previous version held and this one does not is removed, and only while its bytes are what that version held there
       (or the base64 text the pre-fix mirror wrote for it): a file changed or placed by hand is never touched. */
    function removeDropped(dir, skill, previous) {
      if (!previous || !Array.isArray(previous.files)) return;
      const keep = new Set((Array.isArray(skill.files) ? skill.files : []).map(f => supportPath(f && f.path)).filter(Boolean));
      for (const f of previous.files) {
        const p = supportPath(f && f.path);
        if (!p || keep.has(p)) continue;
        const file = path.join(dir, p);
        let st = null;
        try { st = fs.lstatSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('skills.package.remove.stat', e); continue; }
        if (!st.isFile() || st.nlink > 1 || !insideRoot(file)) continue;
        let bytes = null;
        try { bytes = fs.readFileSync(file); } catch (e) { failNote('skills.package.remove.read', e); continue; }
        if (!bytes.equals(FileBytes.bytesOf(f)) && !legacyMirror(f, { encoding: 'utf8', content: bytes.toString('utf8') })) continue;
        try { fs.unlinkSync(file); } catch (e) { failNote('skills.package.remove', e); }
      }
    }
    // The pre-fix mirror's signature (bug a36d1b00): a file on disk holding exactly the record's own base64 TEXT.
    function legacyMirror(rec, disk) {
      return !!rec && str(rec.encoding) === 'base64' && !!str(rec.content) && !!disk && disk.encoding === 'utf8' && str(disk.content) === str(rec.content);
    }
    /* Disk limits mirror what the store itself can hold (64 support files; 1 MiB per file and 4 MiB in all cover the
       store's character caps in any UTF-8 width). A package over them is not this skill's package: returns null and
       hydrate() keeps the stored record. */
    const DISK_MAX_FILES = 64, DISK_MAX_FILE_BYTES = 1024 * 1024, DISK_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
    function readSupportFiles(dir) {
      const out = [];
      let total = 0;
      for (const sd of SUPPORT_DIRS) {
        const base = path.join(dir, sd);
        if (!fs.existsSync(base)) continue;
        // The support folder itself may be a link (a symlink, or a Windows junction): never walk into it.
        try { if (fs.lstatSync(base).isSymbolicLink() || !insideRoot(base)) continue; } catch (_) { continue; }
        const stack = [base];
        while (stack.length) {
          const cur = stack.pop();
          let entries = [];
          try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
          for (const ent of entries) {
            const full = path.join(cur, ent.name);
            // A symlink inside the package is skipped, never followed: hydrate() feeds these bytes
            // straight into skill.view, so following a link would let anything on disk be read out
            // as this skill's "support file".
            if (ent.isSymbolicLink()) continue;
            if (ent.isDirectory()) stack.push(full);
            else if (ent.isFile()) {
              const rel = path.relative(dir, full).replace(/\\/g, '/');
              const p = supportPath(rel);
              if (!p) continue;
              // A hardlinked file also lives somewhere else on disk; this module never writes one, so it is skipped.
              let st = null; try { st = fs.lstatSync(full); } catch (_) { continue; }
              if (st.nlink > 1) continue;
              total += st.size;
              if (out.length >= DISK_MAX_FILES || st.size > DISK_MAX_FILE_BYTES || total > DISK_MAX_TOTAL_BYTES) return null;
              // Read ONCE as bytes, decoded once (FileBytes). A file that cannot be read is not delivered as empty: the
              // package cannot be read faithfully, so hydrate() keeps the stored record (as over the disk limits above).
              let content = null;
              try { content = fs.readFileSync(full); } catch (e) { failNote('skills.package.read', e); return null; }
              out.push(FileBytes.toEntry(p, content, { updatedAt: 0, bytes: content.length }));
            }
          }
        }
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return out;
    }
    function sealed(skill) {
      return !!(Array.isArray(skill.packageFiles) && skill.packageFiles.length && skill.packageDigest && !skill.packageDiverged);
    }
    /* WHICH FILES THE VIEW CARRIES. A record file the mirror never writes (a root LICENSE or NOTICE) cannot drift on disk,
       so it comes from the record. A file on disk holding the record's bytes is the record's entry (its stored form, so the
       view digests to the stamp persist() wrote); so is one the pre-fix mirror wrote as the record's own base64 TEXT (bug
       a36d1b00), which the next write puts back as bytes. Anything else on disk is a change the gate re-digests and
       re-scans. No support file on disk at all keeps the record's files, as before. */
    function viewFiles(skill, disk) {
      const rec = Array.isArray(skill.files) ? skill.files : [];
      if (!disk.length) return rec.slice();
      const byPath = new Map(rec.map(f => [str(f && f.path), f]));
      const out = rec.filter(f => f && !supportPath(f.path));
      for (const d of disk) {
        const r = byPath.get(d.path);
        out.push(r && (FileBytes.sameBytes(r, d) || legacyMirror(r, d)) ? r : d);
      }
      return out;
    }
    function hydrate(skill) {
      if (!skill) return skill;
      const dir = skill.state === 'archived' ? archiveDir(skill) : packageDir(skill);
      const md = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(md)) return skill;
      if (!insideRoot(md)) return skill;   // same law as the write side: a redirected package is not this skill's package
      /* AN UNTOUCHED INSTALL IS ITS RECORD. writePackage wrote packageFiles' exact bytes, and the record's body and files
         were decoded from those same bytes at install, so the view is the record itself and digests to its stamp. It used
         to re-parse SKILL.md out of the manifest: a body the store held differently (the log redactor ran over it at
         install) digested to something no approval of what the Commander read could match. */
      if (sealed(skill)) return Object.assign({}, skill, { packagePath: dir });
      let parsed = null;
      try { parsed = parseFrontmatter(fs.readFileSync(md, 'utf8')); } catch (e) { failNote('skills.package.hydrate', e); }
      const disk = readSupportFiles(dir);
      if (!disk) return skill;   // over the disk limits, or unreadable (readSupportFiles): keep the stored record
      const out = Object.assign({}, skill);
      if (parsed) {
        out.description = parsed.meta.description || out.description || out.summary || '';
        out.platforms = Array.isArray(parsed.meta.platforms) ? parsed.meta.platforms : (out.platforms || []);
        // Split the rendered artifacts back off, so hydrate -> persist re-renders the SAME bytes
        // instead of nesting another '## Setup' / pointer list on every cycle. See splitRendered.
        const split = splitRendered(parsed.body || '', skill);
        /* AN UNTOUCHED DOCUMENT DELIVERS THE STORED BODY. The renderer trims, so a body stored with a trailing newline
           read back as other bytes and its approval never matched the stamp (approve, and the index still withheld it).
           A document holding the stored body and setup (whitespace at the ends aside) is the stored record. */
        if (split.body === str(skill.body).trim() && split.setup === str(skill.setup).trim()) {
          out.body = str(skill.body); out.setup = str(skill.setup);
        } else {
          // A body region that split down to nothing (a setup-only document) is legitimately empty; a
          // region that was ALREADY empty means a blank/unreadable SKILL.md, so keep what we hold.
          out.body = split.body || (str(parsed.body).trim() ? '' : (out.body || ''));
          out.setup = split.setup;
        }
      }
      out.files = viewFiles(skill, disk);
      out.packagePath = dir;
      return out;
    }
    function generationDir(skill) {
      return path.join(root, '.generations', safeSegment(skill.agentId || 'agent'), safeSegment(skill.id || skill.name || 'skill'));
    }
    function snapshot(skill) {
      if (!skill || !skill.packageDigest || !Array.isArray(skill.packageFiles) || !skill.packageFiles.length) return null;
      const pkg = packageFormat.fromEnvelope({ format: packageFormat.FORMAT, digest: skill.packageDigest, files: skill.packageFiles });
      const dir = generationDir(skill); ensureDir(dir);
      const target = path.join(dir, pkg.digest + '.json');
      if (!fs.existsSync(target)) writeText(target, packageFormat.toEnvelope(pkg, {
        name: skill.name || '', sourceUrl: skill.sourceUrl || '', sourceVersion: skill.sourceVersion || '', savedAt: now()
      }));
      return { digest: pkg.digest, bytes: pkg.bytes, fileCount: pkg.files.length };
    }
    function generations(skill) {
      const dir = generationDir(skill); if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => {
        try {
          const raw = fs.readFileSync(path.join(dir, n), 'utf8'); const envelope = JSON.parse(raw);
          const pkg = packageFormat.fromEnvelope(envelope);
          return { digest: pkg.digest, bytes: pkg.bytes, fileCount: pkg.files.length, metadata: envelope.metadata || {} };
        } catch (_) { return null; }
      }).filter(Boolean);
    }
    function readGeneration(skill, digest) {
      if (!/^[a-f0-9]{64}$/.test(str(digest))) throw new Error('invalid generation digest');
      const file = path.join(generationDir(skill), str(digest) + '.json');
      if (!insideRoot(file) || !fs.existsSync(file)) throw new Error('no such offline generation');
      return packageFormat.fromEnvelope(fs.readFileSync(file, 'utf8'));
    }
    return { writePackage, hydrate, packageDir, archiveDir, renderSkillMd, parseFrontmatter, splitRendered, supportPath, snapshot, generations, readGeneration };
  }

  return { makePackageStore, renderSkillMd, parseFrontmatter, splitRendered, supportPath, safeSegment, SUPPORT_DIRS };
});
