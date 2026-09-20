/* node test/desktop-build-macos-notarization.test.js
   Ensures manual/test Mac builds preserve asynchronous Apple submissions so a long
   notarization queue can be resumed without rebuilding or resubmitting the app. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop-build.yml'), 'utf8');
const installedScript = fs.readFileSync(path.join(root, 'scripts', 'verify-macos-intel-installed.sh'), 'utf8');
const v090Fixture = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'upgrade', 'v090-intel-mac', 'agent.save.json'), 'utf8'));

const buildStep = yml.match(/- name: Build desktop bundles([\s\S]*?)(?=\n      - name: Submit macOS DMG)/);
A.ok(buildStep, 'manual workflow has a desktop build step');
for (const credential of ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
  A.ok(!buildStep[1].includes(`secrets.${credential}`),
    `manual Tauri build does not receive ${credential}`);
}

A.ok(/Submit macOS DMG for asynchronous notarization/.test(yml),
  'manual workflow submits the completed DMG asynchronously');
A.ok(/os: macos-15-intel[\s\S]{0,120}target: darwin-x64/.test(yml),
  'manual Intel Mac builds run on an actual x86_64 hosted runner');
A.ok(/Verify v0\.8\.5 station recovery on Intel macOS[\s\S]{0,220}uname -m[\s\S]{0,120}upgrade-085-090\.test\.js/.test(yml),
  'manual Intel Mac builds exercise the released workspace upgrade on x86_64 hardware');
A.ok(/matrix\.target == 'darwin-x64'[\s\S]{0,220}hydrate-sharp-macos-x64\.sh/.test(yml),
  'manual Intel Mac builds hydrate the lockfile-pinned x64 Sharp runtime');
A.ok(/Prepare bundled macOS native dependencies for signing[\s\S]{0,1400}sign-macos-native-deps\.sh/.test(yml),
  'credentialed manual Mac builds sign the staged native dependency closure');
A.ok(/present" -eq 0[\s\S]{0,300}internal testing only/.test(yml),
  'keyless manual Mac builds remain explicitly unsigned internal-test artifacts');
A.ok(/partial Apple signing credentials[\s\S]{0,120}mixed-trust app/.test(yml),
  'partial Apple credentials fail instead of producing a mixed-trust app');
A.ok(/name: notarization-input-\$\{\{ matrix\.target \}\}/.test(yml),
  'manual workflow preserves submitted DMG and Apple id');
A.ok(/notarize-macos:[\s\S]*?timeout-minutes: 350/.test(yml),
  'manual workflow finalizes notarization in an independent bounded job');
A.ok(/notarize-macos-finalize\.sh/.test(yml), 'manual workflow uses the retryable finalizer');
A.ok(/name: starnet-\$\{\{ matrix\.target \}\}/.test(yml),
  'only the final notarized DMG receives the distributable artifact name');
A.ok(/intel-macos-installed-acceptance:[\s\S]*?needs: \[build, notarize-macos\][\s\S]*?runs-on: macos-15-intel/.test(yml),
  'manual workflow runs installed-app acceptance on actual Intel hardware after notarization');
A.ok(/Install, Finder-launch, and recover v0\.9\.0 station[\s\S]*?verify-macos-intel-installed\.sh/.test(yml),
  'manual workflow delegates the installed upgrade journey to the named verifier');
A.ok(/require_signed_mac:[\s\S]*?default: "false"/.test(yml)
  && /STARNET_REQUIRE_NOTARIZED: \$\{\{ inputs\.require_signed_mac \}\}/.test(yml),
  'manual builds can require signed installed proof without removing the explicit keyless-test tier');
A.ok(/needs: \[build, notarize-macos, intel-macos-installed-acceptance\]/.test(yml),
  'test publication waits for Intel installed-app acceptance');
A.ok(/pattern: starnet-\*/.test(yml),
  'test publication excludes unstapled notarization-input artifacts');

A.eq(v090Fixture.doc.version, 6, 'installed journey uses the save version shipped by v0.9.0');
A.eq(v090Fixture.doc.agent.name, 'NOVA-090-INTEL', 'installed fixture carries an observable prior-station identity');
A.ok(/set app_file to POSIX file[\s\S]*?tell application "Finder" to open app_file/.test(installedScript),
  'installed verifier asks Finder/LaunchServices to open the copied app');
A.ok(/\.local\/share\/StarNet\/workspaces/.test(installedScript)
  && /Library\/Application Support\/ai\.skynet\.harness\/workspaces/.test(installedScript),
  'installed verifier reproduces the v0.9.0 manual-sidecar to desktop shelf split');
A.ok(/source_hash_after[\s\S]*?source_hash_before/.test(installedScript),
  'installed verifier proves the v0.9.0 source save remains byte-identical');
A.ok(/quit_cleanly[\s\S]*?launch_with_finder[\s\S]*?restartSurvived/.test(installedScript),
  'installed verifier quits, relaunches through Finder, and records restart persistence');

// Execute the actual receipt writer against XML/binary installed metadata. Never
// infer the installed version from the verifier checkout or artifact filename.
const receiptWriter = installedScript.match(/python3 - "\$receipt"[^\n]*<<'PY'\r?\n([\s\S]*?)\r?\nPY/)[1];
const probe = `import tempfile, pathlib, plistlib, json, sys
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    app = root / 'StarNet.app'
    (app / 'Contents').mkdir(parents=True)
    dmg = root / 'misleading_0.10.0.dmg'
    dmg.write_bytes(b'exact fixture bytes')
    receipt = root / 'receipt.json'
    for version, fmt in [('0.12.3', plistlib.FMT_XML), ('12.7.19', plistlib.FMT_BINARY), ('', plistlib.FMT_XML), (None, plistlib.FMT_BINARY)]:
        receipt.unlink(missing_ok=True)
        metadata = {} if version is None else {'CFBundleShortVersionString': version}
        (app / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps(metadata, fmt=fmt))
        sys.argv = ['receipt', str(receipt), str(dmg), str(app), '8989', 'source-sha', 'true']
        try:
            exec(${JSON.stringify(receiptWriter)}, {})
        except ValueError:
            assert not version and not receipt.exists()
        else:
            assert version and json.loads(receipt.read_text())['upgrade']['to'] == version
`;
const result = require('child_process').spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', probe], { encoding: 'utf8' });
A.eq(result.status, 0, 'receipt uses actual installed XML/binary plist and rejects missing version: ' + result.stderr);
A.report('desktop-build-macos-notarization.test');
