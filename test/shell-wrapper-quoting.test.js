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
    // cmd reads its own switches wherever they sit, fused or not (read off the real cmd.exe): each spelling hands the rest of the
    // line to cmd as a command, so each is the class-2 probe again. Allowed, the inert GUI marker runs; refused, it never does.
    for (const command of [
      'cmd /d/c probe.exe', 'cmd /cprobe.exe', 'cmd /c"probe.exe"', 'cmd /r probe.exe', 'cmd /R probe', 'cmd /rprobe.exe', 'cmd /^c probe.exe',
      'cmd /q/s/c probe.exe', 'cmd /e:on/c probe', 'cmd /d/k probe.exe', 'cmd /d/s/c "probe.exe"'
    ]) {
      const r = rig.execute(command);
      A.ok(r.risk, 'guard refuses the respelled wrapper: ' + command);
      A.eq(r.run, null, 'refused, never dispatched: ' + command);
      A.eq(r.marker, false, 'no marker is produced by it: ' + command);
    }
    // the real System32 GUI programs behind a respelled wrapper: the decision only, nothing here starts them
    for (const command of ['cmd /d/c winver', 'cmd /r winver', 'cmd /cwinver', 'cmd /d/c charmap', 'cmd /c"charmap.exe"']) {
      A.ok(rig.decide(command).risk, 'the real GUI program behind a respelled wrapper is refused: ' + command);
    }
    for (const command of ['cmd /d/c echo plain', 'cmd /cecho plain', 'cmd /c"echo plain"', 'cmd /r echo plain', 'cmd /d /s /c "echo plain"']) {
      const r = rig.execute(command);
      A.eq(r.risk, null, 'plain respelled wrapper positive: ' + command);
      A.ok(r.run && r.run.status === 0, 'positive executes normally: ' + command);
      A.eq(r.marker, false, 'plain data does not become a program: ' + command);
    }
  } finally { rig.dispose(); }
} else {
  console.log('Windows native transport not run on this host; static reconstruction controls above only.');
}
A.report('shell-wrapper-quoting.test');
