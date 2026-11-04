'use strict';
const A = require('./_assert');
const { loadShell, windowsRig } = require('./helpers/shell-guard-fixture');
const api = loadShell();

// These are the literal native wrapper forms from the inherited marker proof.
// They are not inert script strings after cmd/PowerShell rebuild command text.
const bad = [
  'powershell -NoProfile -NonInteractive -c Write-Output ok "; .\\probe.exe"',
  'cmd /c "echo ok" "& probe.exe" x'
];
for (const command of bad) A.ok(api.commandSafetyRisk(command, { dialect: 'cmd', isWin: true }), 'native reconstructed command is refused: ' + command);

if (process.platform === 'win32') {
  const rig = windowsRig(api);
  try {
    const fixture = rig.execute('.\\probe.exe', true);
    A.ok(fixture.risk, 'the GUI-subsystem fixture itself is refused');
    A.eq(fixture.run.status, 0, 'the deliberate harmless transport control exits normally');
    A.eq(fixture.marker, true, 'the GUI fixture really executes through production buildMarkedCmd');
    for (const command of bad) {
      const r = rig.execute(command);
      A.ok(r.risk, 'guard refuses the exact native wrapper: ' + command);
      A.eq(r.run, null, 'refused wrapper is never dispatched');
      A.eq(r.marker, false, 'no marker is produced by the refused wrapper');
    }
    for (const command of [
      'cmd /c echo plain',
      'cmd /c "echo plain"',
      'powershell -NoProfile -NonInteractive -c Write-Output plain',
      'powershell -NoProfile -NonInteractive -c "Write-Output \'literal; & probe.exe\'"',
      'echo "literal & probe.exe"',
      '.\\console-probe.exe'
    ]) {
      const r = rig.execute(command);
      A.eq(r.risk, null, 'proven native/builtin/script-quote positive: ' + command);
      A.ok(r.run && r.run.status === 0, 'positive executes normally: ' + command);
      A.eq(r.marker, command === '.\\console-probe.exe', 'quoted data does not become a program: ' + command);
    }
  } finally { rig.dispose(); }
} else {
  console.log('Windows native transport not run on this host; static reconstruction controls above only.');
}
A.report('shell-wrapper-quoting.test');
