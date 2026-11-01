// scripts/lib/scratch.mjs — throwaway directories for QA scripts: a Chrome --user-data-dir, a seeded workspace.
//
// WHY THIS EXISTS (guardian triage, 2026-10-28): session-reliability, chat-cutoff-investigate and check-small-screen
// each made a fresh `profile-<Date.now()>` Chrome profile (and session-reliability a `workspace-*` mkdtemp) INSIDE their
// .dogfood evidence dir and never removed it. A Chrome profile is thousands of files; ~148k of them piled up under
// .dogfood/session-reliability until scripts/lint-evidence-secrets.mjs, which walks all of .dogfood, blew its 120s gate
// bound. Scratch is not evidence: it lives under os.tmpdir(), never under .dogfood, and the script that made it
// removes it when it is done — success or failure.
//
//   const scratch = createScratch('session-reliability');
//   try { const profile = scratch.dir('profile'); ... } finally { await scratch.dispose(); }
//
// dispose() retries: on Windows a Chrome or sidecar that was just killed can hold a handle in its directory for a
// moment after kill() returns (EBUSY/EPERM). A directory that still will not go is reported, not thrown — cleanup must
// never mask the script's own result.
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createScratch(label, { root = tmpdir() } = {}) {
  const tag = String(label || 'qa').replace(/[^A-Za-z0-9_-]+/g, '-');
  const made = [];
  return {
    root,
    dir(kind = 'scratch') {
      const d = mkdtempSync(join(root, `starnet-${tag}-${String(kind).replace(/[^A-Za-z0-9_-]+/g, '-')}-`));
      made.push(d);
      return d;
    },
    get dirs() { return made.slice(); },
    async dispose() {
      const left = [];
      for (const d of made.splice(0)) {
        try { await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
        catch (e) { left.push(d); console.error(`scratch: could not remove ${d}: ${e.code || e.message}`); }
      }
      return left;
    }
  };
}
