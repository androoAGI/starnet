/* node test/release-train-provenance.test.js — P1.5 release-train provenance gate invariants.

   The release train (.github/workflows/release-train.yml, `build` job) refuses to ship a binary unless
   `git describe --tags` resolves to the tag being built AND the built exe byte-contains the build.rs commit
   stamp. That gate is CORRECT, but it only works if the CI checkout actually has the tag + history available:
   with the default shallow `actions/checkout@v4` (fetch-depth 1, no tags) `git describe --tags` falls back to
   the bare short SHA, so `describe != tag` and the gate fails producing ZERO artifacts — exactly what stalled
   the v0.4.0 train (0 artifacts, 2026-07-08). The fix is `fetch-depth: 0` on the build-job checkout so the
   environment can compute a truthful describe (this does NOT loosen the gate — it feeds it real git data).

   This locks, without running CI:
     · the build job's checkout fetches full history+tags (fetch-depth: 0) so describe/build.rs see the tag.
     · the provenance gate itself is still present (describe==tag check + binary byte-scan) — a future edit that
       silently drops the gate is caught here.
     · build.rs and the yml compute `git describe` with the SAME flag set, so their describe output is identical
       (a drift between them would make the gate compare mismatched strings).
   Pure text/structural check — no node_modules, no YAML parser (js-yaml isn't a dep). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github', 'workflows', 'release-train.yml'), 'utf8');
const buildRs = fs.readFileSync(path.join(root, 'src-tauri', 'build.rs'), 'utf8');
const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
const tauriConf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));

function rustStringArray(name) {
  const match = buildRs.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
  A.ok(match, `build.rs declares ${name}`);
  return Array.from(match[1].matchAll(/"([^"]+)"/g), row => row[1].replace(/\\\\/g, '/'));
}

// --- isolate the `build` job block (from its header to the next top-level job header) ---
const hdr = yml.match(/^  build:$/m);
A.ok(hdr, 'release-train.yml has a `build` job');
const bodyStart = hdr.index + hdr[0].length;
const afterBuild = yml.slice(bodyStart);
const nextJobRel = afterBuild.search(/^  [a-z0-9_-]+:$/m); // first sibling job header after `build:`
const buildJob = nextJobRel === -1 ? afterBuild : afterBuild.slice(0, nextJobRel);

// --- the build-job checkout must fetch full history + tags so `git describe --tags` resolves the tag ---
const coIdx = buildJob.indexOf('uses: actions/checkout@v4');
A.ok(coIdx !== -1, 'build job has an actions/checkout step');
// the checkout step spans until the next `- ` step marker at 6-space indent.
const fromCheckout = buildJob.slice(coIdx);
const nextStepRel = fromCheckout.slice(1).search(/\n      - /);
const checkoutStep = nextStepRel === -1 ? fromCheckout : fromCheckout.slice(0, nextStepRel + 1);
A.ok(/fetch-depth:\s*0\b/.test(checkoutStep),
  'build-job checkout uses fetch-depth: 0 (full history+tags — else `git describe --tags` returns the bare SHA and the provenance gate fails describe!=tag, shipping 0 artifacts)');

A.ok(/ref:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref \}\}/.test(checkoutStep),
  'manual recovery runs build the immutable requested tag instead of the workflow branch');
const checkoutSteps = Array.from(
  yml.matchAll(/^      - uses: actions\/checkout@v4\s*$([\s\S]*?)(?=^      - |^  [a-z0-9_-]+:|$(?![\s\S]))/gm),
  row => row[0]
);
A.eq(checkoutSteps.length, 6, 'release train has the expected six source checkouts, including installed Intel acceptance');
for (const [i, step] of checkoutSteps.entries()) {
  A.ok(/^\s*ref:\s*\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref \}\}\s*$/m.test(step),
    `source checkout ${i + 1} uses the immutable requested tag during a manual recovery run`);
}

// 0.8.5 is distributed on Windows and macOS only. Linux must not enter the release matrix,
// draft asset set, or required updater manifest while it remains unsupported.
A.ok(/target:\s*win-x64/.test(buildJob), 'release matrix includes Windows x64');
A.ok(/target:\s*darwin-arm64/.test(buildJob), 'release matrix includes macOS arm64');
A.ok(/target:\s*darwin-x64/.test(buildJob), 'release matrix includes macOS x64');
A.ok(!/target:\s*linux-/.test(buildJob), 'release matrix excludes unsupported Linux builds');
A.ok(/--allow-missing linux-x86_64,linux-x86_64-deb/.test(yml),
  'manifest assembly explicitly omits unsupported Linux updater targets');
A.ok(/--require-platforms windows-x86_64,darwin-aarch64,darwin-x86_64/.test(yml),
  'draft verification requires every supported Windows and macOS updater target');
A.ok(!/-name '\*\.deb'|-name '\*\.AppImage'/.test(yml),
  'draft collection cannot attach Linux installers');

// --- the provenance gate must still exist (guard against a future edit quietly removing it) ---
A.ok(/git describe --tags --always --dirty/.test(buildJob),
  'provenance gate still computes `git describe --tags --always --dirty`');
A.ok(/grep -aq -- "\$COMMIT"/.test(buildJob),
  'provenance gate still byte-scans the built binary for the build.rs commit stamp');

// --- build.rs and the yml must describe with the SAME flags so their output is byte-identical ---
const rsDescribe = buildRs.match(/"describe"[^\)\]]*\]/);
A.ok(rsDescribe, 'build.rs invokes git describe');
const rsFlags = (rsDescribe[0].match(/--[a-z]+/g) || []).sort();
const ymlDescribe = buildJob.match(/\$\(git describe ([^)\n]*)\)/); // the real command, not the prose comments
A.ok(ymlDescribe, 'build job invokes `$(git describe …)`');
const ymlFlags = (ymlDescribe[1].match(/--[a-z]+/g) || []).sort();
A.eq(ymlFlags, rsFlags,
  'yml and build.rs `git describe` use the same flag set (identical describe output feeds the gate)');

// Cargo must invalidate build.rs for every path whose bytes can reach the packaged app. Watching only
// .git/HEAD and .git/index misses ordinary unstaged edits because neither Git metadata file changes.
const watchedInputs = rustStringArray('SHIPPED_INPUTS');
const configuredResourceRoots = [tauriConf.build.frontendDist, ...Object.keys(tauriConf.bundle.resources)];
const requiredInputs = [
  ...configuredResourceRoots,
  'src', 'capabilities', 'icons', 'installer', 'binaries',
  'build.rs', 'Cargo.toml', 'Cargo.lock', 'tauri.conf.json'
];
for (const input of new Set(requiredInputs)) {
  A.ok(watchedInputs.includes(input), `build.rs reruns when shipped input changes: ${input}`);
}
A.ok(/for path in SHIPPED_INPUTS[\s\S]*cargo:rerun-if-changed=\{path\}/.test(buildRs),
  'every declared shipped input is emitted as a Cargo rerun dependency');

// `git describe --dirty` ignores untracked files. Lock the supplemental status check to the same
// top-level Git roots that tauri.conf packages, so a newly added shipped file cannot claim clean provenance.
const shippedGitRoots = rustStringArray('SHIPPED_GIT_ROOTS');
A.eq(shippedGitRoots, ['frontend', 'sidecar', 'shared', 'remote', 'src-tauri'],
  'dirty detection covers every Git-owned packaged root');
A.ok(/"diff"[\s\S]{0,220}"--quiet"[\s\S]{0,220}"--ignore-cr-at-eol"[\s\S]{0,220}"HEAD"/.test(buildRs) && /diff\.args\(SHIPPED_GIT_ROOTS\)/.test(buildRs),
  'tracked dirty detection catches real shipped-input changes but ignores Tauri CR-only rewrites');
A.ok(/"ls-files"[\s\S]{0,220}"--others"[\s\S]{0,220}"--exclude-standard"/.test(buildRs) && /untracked\.args\(SHIPPED_GIT_ROOTS\)/.test(buildRs),
  'dirty detection independently includes untracked shipped inputs');
A.ok(/shipped_inputs_dirty\(\)\.unwrap_or\(describe_dirty\)/.test(buildRs),
  'packaged source roots are authoritative, with git-describe as the fail-closed fallback');
A.ok(/!dirty\s*&&\s*describe_dirty[\s\S]*describe\.truncate/.test(buildRs),
  'operational repository dirt is removed from the display stamp when packaged roots are clean');
A.ok(/dirty\s*&&\s*!describe_dirty[\s\S]*describe\.push_str\("-dirty"\)/.test(buildRs),
  'untracked packaged source dirt is added to the display stamp even when git-describe misses it');
A.ok(/rev-parse",\s*"--git-path"/.test(buildRs),
  'Git metadata rerun paths resolve correctly in both primary checkouts and linked worktrees');

// Installed proof needs the full immutable candidate SHA, not only the human-facing short commit.
A.ok(/rev-parse",\s*"HEAD/.test(buildRs) && /STARNET_BUILD_SHA/.test(buildRs),
  'build.rs embeds a full candidate SHA for installed-artifact proof');
A.ok(/\.env\("STARNET_BUILD_SHA",\s*env!\("STARNET_BUILD_SHA"\)\)/.test(mainRs),
  'desktop shell passes the full build SHA to the packaged sidecar');
A.ok(/sha:\s*env!\("STARNET_BUILD_SHA"\)/.test(mainRs),
  'starnet_build_info exposes the same full build SHA to the installed page');
A.ok(/std::env::current_exe\(\)/.test(mainRs) && /Sha256::new\(\)/.test(mainRs),
  'desktop shell derives content identity from the executable that is actually running');
A.ok(/rename\s*=\s*"executableSha256"/.test(mainRs) && /rename\s*=\s*"executableSize"/.test(mainRs),
  'starnet_build_info exposes runtime executable SHA-256 + size without exposing its path');

A.report('release-train-provenance.test');
