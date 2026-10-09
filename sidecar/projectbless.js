/* sidecar/projectbless.js — the ADD-A-PROJECT bless core (NS-5c Projects rail).

   POST /api/projects/bless {path} is the SECOND doorway to the SAME standing path-grant machinery as
   conversational path trust (pathtrust.js): the Commander types or picks a folder in the Projects rail and
   blessing it records the identical `path:<normalized-real-root>` grant + known-projects row — one consent
   flow, two doorways, never a parallel store. Here the CLICK is the consent, so unlike a run there is no
   mid-stream prompt() — but the exact same rules gate it:

     • INTERACTIVE ONLY. THE UNATTENDED RULE holds at this doorway too — an autonomous/headless caller can never
       widen its own reach through the API any more than through a tool. surface must be 'interactive' or DENY.
     • the identical HARDLINES (pathtrust's hardlineReason): no .env / .git internals, no NUL, no UNC/network path.
     • the path must EXIST and be a DIRECTORY (a typed path to a file or a missing folder is an honest error).
     • the blessed root is the PROPOSED git-repo root (detectRoot) — the same natural project boundary the
       conversational prompt offers — so blessing C:\proj\src\main.js blesses C:\proj, matching pathtrust.

   makeProjectBless({ fsp, pathMod, detectRoot, normalizeRoot, hardlineReason, bless, isGitRepoOf, now })
     fsp         : node:fs/promises (injected) — stat + realpath only, never writes.
     pathMod     : node:path (injected) — isAbsolute + resolve.
     detectRoot  : async (absPath) => proposedRoot     (pathTrustCore.detectRoot — nearest .git ancestor / dir).
     normalizeRoot: (abs) => canonical key             (pathTrustCore.normalizeRoot — SAME string as the grant key).
     hardlineReason: (rawAbs, resolvedAbs) => reason|null (pathTrustCore._internals.hardlineReason).
     bless       : async (rootReal, { isGitRepo, now }) => bool  — index.js blessProjectRoot (persist-before-commit).
     isGitRepoOf : async (rootReal) => bool.
     now         : injected clock.

   -> { blessPath }
   async blessPath({ path, surface }) -> { ok, root?, isGitRepo?, reason?, code? }   // never throws; honest errors.

   Pure decision core over injected node deps (matches pathtrust.js / permgrants.js). No env, no wall-clock. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).projectbless = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function makeProjectBless(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod;
    if (!fsp || !P) throw new Error('projectbless requires { fsp, pathMod }');
    const detectRoot = typeof deps.detectRoot === 'function' ? deps.detectRoot : (async (a) => P.dirname(P.resolve(a)));
    const normalizeRoot = typeof deps.normalizeRoot === 'function' ? deps.normalizeRoot : ((a) => P.resolve(String(a == null ? '' : a)));
    const hardlineReason = typeof deps.hardlineReason === 'function' ? deps.hardlineReason : (() => null);
    const bless = typeof deps.bless === 'function' ? deps.bless : null;
    const isGitRepoOf = typeof deps.isGitRepoOf === 'function' ? deps.isGitRepoOf : (async () => false);
    const now = typeof deps.now === 'function' ? deps.now : (() => null);

    async function realpathOrSelf(p) { try { return await fsp.realpath(p); } catch (_) { return p; } }
    function pathInside(child, parent) {
      const rel = P.relative(parent, child);
      return rel === '' || (!!rel && !rel.startsWith('..') && !P.isAbsolute(rel));
    }

    async function blessPath(o) {
      o = o || {};
      const surface = o.surface === 'interactive' ? 'interactive' : 'autonomous';
      // THE UNATTENDED RULE: only a live, user-initiated (interactive) surface may bless a new root.
      if (surface !== 'interactive')
        return { ok: false, code: 'autonomous', reason: 'blessing a project folder is a user action — an autonomous run cannot add a project.' };

      const raw = (o.path == null ? '' : String(o.path)).trim();
      if (!raw) return { ok: false, code: 'missing', reason: 'no folder path given' };
      // a typed path MUST be absolute — a relative path has no meaning without a cwd the user can't see.
      if (!P.isAbsolute(raw)) return { ok: false, code: 'relative', reason: 'enter an absolute folder path (e.g. C:\\Users\\you\\project or /home/you/project)' };

      const norm = normalizeRoot(raw);
      const hr = hardlineReason(raw, norm);
      if (hr) return { ok: false, code: 'hardline', reason: hr };

      // must exist AND be a directory — the honest failure a typo or a file path deserves.
      let st;
      try { st = await fsp.stat(norm); }
      catch (_) { return { ok: false, code: 'missing', reason: 'that folder does not exist: ' + norm }; }
      if (!st.isDirectory()) return { ok: false, code: 'notdir', reason: 'that path is a file, not a folder: ' + norm };

      // propose the git-repo ROOT (nearest .git ancestor) — the same boundary the conversational prompt offers.
      const proposed = normalizeRoot(await detectRoot(norm));
      const phr = hardlineReason(proposed, proposed);
      if (phr) return { ok: false, code: 'hardline', reason: phr };

      /* BLESS THE REAL PATH — the same law pathtrust.js already follows, which this doorway did not.
         normalizeRoot is only P.resolve, so a folder reached through a junction or a symlinked ancestor (a
         Windows junction, a OneDrive-redirected known folder, ~/code -> /mnt/data/code, macOS /tmp ->
         /private/tmp) was recorded UN-canonical, while the run guard compares against the realpath. The two
         could never match: the rail happily reported 'added "<folder>"' and drew the row as a trusted project,
         and then the agent was denied on every file in it — a watched session re-raised the folder-trust card
         on EVERY file touch, and an unattended run hard-denied. That is exactly the consent-fatigue loop the
         2026-07-27 pathtrust fix was written to kill, re-opened at the sibling doorway.
         The symlink re-proof comes with it: the picked folder's REAL path must still sit under the proposed
         root's real path, or the proposal is not this folder's project root. */
      const proposedReal = normalizeRoot(await realpathOrSelf(proposed));
      const normReal = normalizeRoot(await realpathOrSelf(norm));
      if (!pathInside(normReal, proposedReal))
        return { ok: false, code: 'escape', reason: 'that folder escapes its own project root through a link: ' + norm };
      const rhr = hardlineReason(proposedReal, proposedReal);
      if (rhr) return { ok: false, code: 'hardline', reason: rhr };

      if (!bless) return { ok: false, code: 'unwired', reason: 'project trust is not wired to persist a grant — denied' };
      const isGit = await isGitRepoOf(proposedReal);
      const ok = await bless(proposedReal, { isGitRepo: isGit, now: now() });
      if (!ok) return { ok: false, code: 'persist', reason: 'could not persist project trust — denied: ' + proposedReal };
      // `root` is the CANONICAL key that was actually granted, so the rail row and the guard cannot disagree
      // about which folder is trusted. `typedRoot` keeps the path the Commander recognizes, for the notice.
      return { ok: true, root: proposedReal, isGitRepo: isGit, typedRoot: proposed };
    }

    return { blessPath };
  }

  // The PROJECT-SCOPED SESSION context line (ref-parity working folder). A session anchored to a project
  // sends its root with each /api/run; this composes the ONE line that rides the system prompt — and ONLY when
  // the caller proved the root is still a standing blessed grant (truthful telemetry: injecting a folder claim
  // for an un-blessed root would assert access the harness can't prove, so `blessed:false` returns '').
  // Pure + bounded; the root is display-trusted (it came from the grant store, not the user message).
  function projectScopeLine(root, blessed) {
    const r = String(root == null ? '' : root).trim();
    if (!r || !blessed) return '';
    return '\n\nPROJECT FOLDER: this session is anchored to the trusted project folder ' + r.slice(0, 1024) +
      ' — unless the user names a different location, file work in this conversation happens there.';
  }

  /* The LAPSED anchor (issue #60). A session anchored to a folder that is NOT a standing grant right now (trust
     removed, or a path that never matched the grant) used to get projectScopeLine's '' and nothing else: the run
     quietly fell back to the private workspace while the Commander, the rail and the shell all pointed at the
     project, so a "verified" fs.write landed where the shell then found it MISSING. Silence was the lie. This
     line asserts no access (it says the opposite) and names the way back. Empty for a blessed or absent root. */
  function projectLapsedLine(root, blessed) {
    const r = String(root == null ? '' : root).replace(/[\r\n]+/g, ' ').trim();
    if (!r || blessed) return '';
    return '\n\nPROJECT FOLDER NOT TRUSTED: this session is anchored to ' + r.slice(0, 1024) + ', but that folder is not a ' +
      'trusted project right now, so a RELATIVE file path writes to your private workspace, not that folder (the shell ' +
      'will not find it there). To work in the folder, use absolute paths inside it (StarNet may ask the Commander to ' +
      'approve it), or ask the Commander to add it again under PROJECTS. Never report a file as saved in that folder ' +
      'unless its receipt names a location inside it.';
  }

  /* The FOLDERLESS workflow (#60/#81 follow-up). A conveyor line's folder comes ONLY from its INBOX's WORKING FOLDER
     chip; trusting a folder under PROJECTS does not attach it to a line. So a stage told "save to project/reports/x.md"
     wrote it into its private workspace and reported the relative path as if it were the project. This line says
     where a relative path really lands and names the way back. Empty when the run has a folder. */
  function workflowNoFolderLine(hasFolder) {
    if (hasFolder) return '';
    return '\n\nNO WORKING FOLDER: this workflow has no working folder, so a RELATIVE file path saves to your private ' +
      'workspace, which other agents cannot read. To put a file in a trusted project, use its absolute path inside that ' +
      'project, and tell the Commander to set WORKING FOLDER on this workflow\'s INBOX.';
  }

  /* PROJECT INSTRUCTIONS — the folder's OWN house rules (2026-07-27).

     projectScopeLine above tells the agent WHERE it is working. It never told it HOW that project wants to be
     worked in. Every serious codebase carries its conventions in a file at the root — AGENTS.md, CLAUDE.md,
     .cursorrules — and until now StarNet read none of them at run time: `harness-import.js` parses AGENTS.md,
     but that is the one-time MIGRATION importer for adopting another harness's home, not live project context.
     So an agent anchored to the Commander's repo re-derived its conventions from scratch on every run, and
     violated the ones it could not guess.

     TRUST: gated on the SAME standing blessed-root grant as the folder line — an un-blessed or revoked root
     loads NOTHING. These files are Commander-owned instructions from a folder the Commander explicitly
     trusted, so they are injected as instructions rather than fenced as untrusted data; fencing them would
     defeat the entire point. They are still run through redact() on the way in, because a project file that
     pastes a key into a setup snippet must not carry it into the prompt.

     CACHE: this rides the SYSTEM prompt, which is the cached prefix. That is safe and deliberate — the text is
     read ONCE per run and is byte-stable for that run's lifetime, so it never shifts the prefix mid-run. It
     changes only when the Commander edits the file, which correctly costs one cache write. */
  const INSTRUCTION_FILES = [
    { label: 'AGENTS.md', names: ['AGENTS.md', 'agents.md'] },
    { label: 'CLAUDE.md', names: ['CLAUDE.md', 'claude.md'] },
    { label: '.cursorrules', names: ['.cursorrules'] }
  ];
  const INSTRUCTIONS_TOTAL_MAX = 16000;   // whole-block ceiling: house rules must never crowd out the task
  const INSTRUCTIONS_FILE_MAX = 8000;

  function makeProjectInstructions(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod;
    const redact = (typeof deps.redact === 'function') ? deps.redact : ((s) => s);
    const totalMax = Number(deps.totalMax) > 0 ? Number(deps.totalMax) : INSTRUCTIONS_TOTAL_MAX;
    const fileMax = Number(deps.fileMax) > 0 ? Number(deps.fileMax) : INSTRUCTIONS_FILE_MAX;

    function clamp(text, max) {
      const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
      if (t.length <= max) return t;
      return t.slice(0, max) + '\n[... truncated by the host: this project instruction file is longer than the run budget allows ...]';
    }

    // -> { text, sources[] }. NEVER throws and never partially fails a run: an unreadable file is simply a
    // file this project does not have. `blessed:false` returns the empty result without touching the disk.
    async function load(root, blessed) {
      const r = String(root == null ? '' : root).trim();
      const empty = { text: '', sources: [] };
      if (!r || !blessed || !fsp || !P) return empty;
      const parts = [], sources = [];
      let budget = totalMax;
      for (const spec of INSTRUCTION_FILES) {
        if (budget <= 0) break;
        for (const name of spec.names) {
          let raw = null;
          // A case-insensitive filesystem resolves both spellings to the same file, so the FIRST hit wins and
          // the rest of that label's candidates are skipped — never the same rules injected twice.
          try { raw = await fsp.readFile(P.join(r, name), 'utf8'); } catch (_) { continue; }
          const body = clamp(redact(String(raw || '')), Math.min(fileMax, budget));
          if (!body) break;
          parts.push('<' + spec.label + '>\n' + body + '\n</' + spec.label + '>');
          sources.push(spec.label);
          budget -= body.length;
          break;
        }
      }
      if (!parts.length) return empty;
      return {
        text: '\n\nPROJECT INSTRUCTIONS — this folder\'s own standing rules, read from ' + sources.join(' and ') +
          '. Follow them for work in this project the way you would follow the Commander\'s own standing orders. ' +
          'A direct instruction in this conversation always wins over them.\n' + parts.join('\n\n'),
        sources: sources
      };
    }

    return { load };
  }

  return { makeProjectBless, projectScopeLine, projectLapsedLine, workflowNoFolderLine, makeProjectInstructions, _internals: { INSTRUCTION_FILES } };
});
