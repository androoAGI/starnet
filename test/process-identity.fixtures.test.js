/* node test/process-identity.fixtures.test.js — one PID-reuse rule, judged the same in JS and in Rust.

   sidecar/process-identity.js judgeReuse decides whether the process holding a PID today can be the one that stamped
   a workspace-owner claim. The desktop shell has to make the same call natively (src-tauri/src/process_identity.rs:
   START FRESH and ERASE refuse to move a station a live owner holds). Two copies of a rule drift, so both read the
   SAME cases from test/fixtures/process-identity-cases.json: this test runs them through judgeReuse, and the Rust
   unit test `process_identity::tests::shared_fixtures_match_the_js_rule` runs them through judge_reuse. A case added
   for one is a case for both. This test also pins that the Rust side really reads that file and really implements
   the rule's constants, so the parity cannot quietly become two separate fixture sets. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { judgeReuse, predatesBoot, BOOT_SLACK_MS, CIM_TOLERANCE_MS, _internals } = require('../sidecar/process-identity.js');

const ROOT = path.resolve(__dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'process-identity-cases.json'), 'utf8'));

A.ok(Array.isArray(fixtures.judge) && fixtures.judge.length >= 15, 'the shared fixture file carries the judge cases');
const names = new Set();
for (const c of fixtures.judge) {
  A.ok(!names.has(c.name), 'every fixture case has its own name: ' + c.name);
  names.add(c.name);
  A.ok(['reused', 'same-process', 'unknown'].indexOf(c.verdict) >= 0, 'a fixture names a real verdict: ' + c.name);
  const got = judgeReuse(c.stamp, c.seen);
  A.eq(got.verdict, c.verdict, 'JS judgeReuse: ' + c.name);
}
for (const [raw, want] of fixtures.imageName) A.eq(_internals.imageName(raw), want, 'JS imageName(' + JSON.stringify(raw) + ')');
// the probe readers the two sides share: macOS `ps -o lstart= -o comm=` (TZ=UTC) and Linux /proc/<pid>/stat field 22
for (const [raw, want] of fixtures.lstart) A.eq(_internals.parseLstart(raw), want, 'JS parseLstart(' + JSON.stringify(raw) + ')');
for (const [raw, want] of fixtures.procStat) A.eq(_internals.parseProcStat(raw), want, 'JS parseProcStat(' + JSON.stringify(raw) + ')');

// the boot rule: a claim stamped before this computer last started is released before any probe
A.ok(Array.isArray(fixtures.predatesBoot) && fixtures.predatesBoot.length >= 5, 'the shared fixture file carries the boot cases');
for (const [booted, stamped, want] of fixtures.predatesBoot) A.eq(predatesBoot(stamped, booted), want, 'JS predatesBoot(stamp ' + stamped + ', boot ' + booted + ')');
A.eq(BOOT_SLACK_MS, 60000, 'the boot slack the fixtures assume');

// the constants the fixtures are written against
A.eq(_internals.REUSE_SLACK_MS, 60000, 'the reuse slack the fixtures assume');
A.eq(_internals.REUSE_EXE_SLACK_MS, 2000, 'the other-image slack the fixtures assume');
A.eq(CIM_TOLERANCE_MS, 7200000, 'the approximate-reading tolerance the fixtures assume');

// the Rust side reads THIS file and holds the same constants
const rust = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'process_identity.rs'), 'utf8');
A.ok(rust.includes('include_str!("../../test/fixtures/process-identity-cases.json")'), 'the Rust rule is tested against this same fixture file');
A.ok(/fn shared_fixtures_match_the_js_rule\(\)/.test(rust), 'the Rust parity test exists');
A.ok(/fn the_shared_boot_rule_matches_the_js_rule\(\)/.test(rust) && /fixtures\["predatesBoot"\]/.test(rust), 'and its boot-rule twin reads the same rows');
A.ok(/pub const BOOT_SLACK_MS: u64 = 60_000;/.test(rust), 'the Rust boot rule holds the same slack');
// the shell judges a claim in the sidecar's order: the boot rule first (workspace-owner.js holderDead)
const held = rust.slice(rust.indexOf('pub fn claim_is_held_with('), rust.indexOf('#[cfg(test)]'));
A.ok(held.indexOf('predates_boot(') >= 0 && held.indexOf('predates_boot(') < held.indexOf('probe(claim.pid)'), 'the Rust claim check applies the boot rule before probing the PID');
// …and a GATE runs that Rust half: the fast gate's rust-policy job tests the shell's own file, by path, and requires the
// two parity tests to have passed (a text check here cannot prove the Rust rule right — only running it can)
const crate = fs.readFileSync(path.join(ROOT, 'test', 'native-process-ownership', 'src', 'lib.rs'), 'utf8');
A.ok(/#\[path = "\.\.\/\.\.\/\.\.\/src-tauri\/src\/process_identity\.rs"\]\s*pub mod process_identity;/.test(crate), 'the rules crate compiles the shell\'s own process_identity.rs');
const gate = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'fast-gate.yml'), 'utf8');
const policy = gate.slice(gate.indexOf('  rust-policy:'));
A.ok(/cargo test --locked --manifest-path test\/native-process-ownership\/Cargo\.toml/.test(policy), 'the fast gate runs it on every PR');
A.ok(/for t in shared_fixtures_match_the_js_rule the_shared_boot_rule_matches_the_js_rule; do/.test(policy), 'and fails unless both parity tests passed');
// the workspace owner judges with THIS rule, not a copy of it
const wo = fs.readFileSync(path.join(ROOT, 'sidecar', 'workspace-owner.js'), 'utf8');
A.ok(/predatesBoot: predatesBootAt \} = require\('\.\/process-identity\.js'\)/.test(wo) && /return predatesBootAt\(ms, bootedAt\(\)\);/.test(wo), 'workspace-owner.js judges with the shared predatesBoot');
A.ok(/const REUSE_SLACK_MS: u64 = 60_000;/.test(rust) && /const REUSE_EXE_SLACK_MS: u64 = 2_000;/.test(rust), 'the Rust rule holds the same slacks');

A.report('process-identity.fixtures');
