'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const releaseTrain = read('.github/workflows/release-train.yml');
const install = read('INSTALL.md');
const readme = read('README.md');
const download = read('docs/DOWNLOAD_PAGE.md');
const runbook = read('docs/RELEASE_RUNBOOK.md');
const hostVerifier = read('scripts/verify-update-host.mjs');
const website = [
  read('website/index.html'),
  read('website/docs/getting-started.html'),
  read('website/docs/troubleshooting.html')
].join('\n');

const buildMatrix = releaseTrain.match(/\n  build:\n[\s\S]*?\n    runs-on:/);
assert.ok(buildMatrix, 'release train build matrix is readable');
assert.match(buildMatrix[0], /target: win-x64/);
assert.match(buildMatrix[0], /target: darwin-arm64/);
assert.match(buildMatrix[0], /target: darwin-x64/);
assert.doesNotMatch(buildMatrix[0], /target: linux/,
  'the tagged public release train does not build a Linux leg');

assert.match(install, /Linux is not[\s\S]{0,80}supported (?:public )?release target/i,
  'install guide says Linux is not a supported public target');
assert.match(readme, /pipeline requirements, not proof/i,
  'README distinguishes workflow requirements from installed evidence');
assert.match(install, /release-pipeline requirements[\s\S]{0,180}not installed proof/i,
  'install guide does not turn release workflow code into installed proof');
assert.match(download, /pipeline contract, not installed proof/i,
  'download copy preserves the evidence boundary');
assert.match(hostVerifier,
  /const DEFAULT_REQUIRE = 'windows-x86_64,darwin-aarch64,darwin-x86_64';/,
  'the canonical updater verifier defaults to the same three supported targets as the train');
assert.match(runbook, /all three supported platform keys[\s\S]{0,180}windows-x86_64, darwin-aarch64, and darwin-x86_64/i,
  'the release runbook requires the same three supported targets');
assert.doesNotMatch(runbook, /all five platform keys/i,
  'the release runbook does not restore the retired five-platform public contract');
assert.match(website, /release checks do not prove that an installer works on your computer/i,
  'website preserves the evidence boundary');

const stale = /unsigned and un-notarized|isn't Apple-notarized|Until StarNet is Apple-notarized|None of the builds are code-signed|Linux builds come off[\s\S]{0,80}release train|fully supported from day one/i;
for (const [name, source] of [
  ['README', readme],
  ['install guide', install],
  ['download copy', download],
  ['website install pages', website]
]) {
  assert.doesNotMatch(source, stale, name + ' does not restore the pre-signing/pre-platform-contract copy');
}

assert.match(install, /Do \*\*not\*\* clear quarantine with[\s\S]{0,40}`xattr`/i,
  'public Mac instructions do not normalize bypassing a missing notarization verdict');
assert.match(website, /Do not clear quarantine/i,
  'website treats a public Mac Gatekeeper failure as reportable, not expected');

console.log('release contract docs tests passed');
