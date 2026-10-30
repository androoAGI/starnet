'use strict';
/* test/helpers/staging-base.js — a test's browser.upload staging stays inside its own scratch (run-paths-polish A3,
   test hygiene; polish review round 1).

   sidecar/egress-files.js stages under a PER-USER base unless a root is injected: %LOCALAPPDATA%\StarNet on Windows
   (on a machine with StarNet installed, the desktop app's own folder: skynet-desktop.exe, sidecar\, workspaces\) and
   os.tmpdir() on POSIX. The in-process tests that stage through that default (browser-upload, browser, path-coherence)
   made icacls-locked folders and planted junctions there; a killed run (RAM starvation, exit 3221225773) left them for
   good, because the station's boot sweep looks for its OWN id, never a test's.

   hermeticStagingBase(scratch) points this process's per-user base inside scratch, the way the sidecar fixture points
   a child's LOCALAPPDATA at its hermetic profile: LOCALAPPDATA on Windows, TMPDIR on POSIX (egress-files.js and
   os.tmpdir() read both at call time). Call it before anything stages, and restore() when done.
     -> { base, restore() }   base: the folder the default staging base now resolves under */
const fs = require('node:fs');
const path = require('node:path');

function hermeticStagingBase(scratch) {
  const key = process.platform === 'win32' ? 'LOCALAPPDATA' : 'TMPDIR';
  const had = Object.prototype.hasOwnProperty.call(process.env, key), was = process.env[key];
  const base = path.join(String(scratch), 'per-user-base');
  fs.mkdirSync(base, { recursive: true });
  process.env[key] = base;
  return {
    base,
    restore() { if (had) process.env[key] = was; else delete process.env[key]; }
  };
}

module.exports = { hermeticStagingBase };
