'use strict';
/* test/helpers/upload-race-writer.js — a SEPARATE process (what shell.exec background:true or a terminal PTY runs)
   that swaps a browser.upload staged copy for a hard link or a junction to a secret, exactly as scratchpad
   rr5r-stage-race.js does, but DETERMINISTICALLY: it waits for an IPC "go" before swapping and replies "done", so a
   regression test can force the swap into the window the round-5 hardening must cover rather than leave it to chance.
   It is handed the per-agent staging folder (a station-owned path a real same-run process could COMPUTE — owner-only
   ACLs do not stop the same user), finds the one fresh copy folder in it, and swaps.
     argv: <mode> <stageDir> <fileName> <secretPath> <secretDir>
     mode 'hardlink' : replace the staged file with a hard link to the secret (one file, another name)
     mode 'junction' : replace the staged FOLDER with a junction/symlink to the secret's folder */
const fs = require('fs'), P = require('path'), cp = require('child_process');
const [mode, stageDir, fileName, secretPath, secretDir] = process.argv.slice(2);
const win = process.platform === 'win32';
function copyFolder() {
  for (const n of fs.readdirSync(stageDir)) if (/^[0-9a-f]{24}$/.test(n)) return P.join(stageDir, n);
  return null;
}
process.on('message', (m) => {
  if (!m || !m.go) return;
  let error = null;
  try {
    const folder = copyFolder();
    if (!folder) throw new Error('no staged copy folder found in ' + stageDir);
    const copyPath = P.join(folder, fileName);
    if (mode === 'hardlink') { fs.unlinkSync(copyPath); fs.linkSync(secretPath, copyPath); }
    else {
      try { fs.unlinkSync(copyPath); } catch (_) {}
      fs.rmdirSync(folder);
      if (win) cp.execSync('cmd /c mklink /J "' + folder + '" "' + secretDir + '"', { stdio: 'pipe' });
      else fs.symlinkSync(secretDir, folder, 'dir');
    }
  } catch (e) { error = String((e && e.message) || e); }
  process.send({ done: true, error });
});
process.send({ ready: true });
