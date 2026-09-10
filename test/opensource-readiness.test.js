#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = p => JSON.parse(read(p));

const pkg = json('package.json');
const lock = json('package-lock.json');
const tauri = json('src-tauri/tauri.conf.json');

assert.equal(pkg.version, tauri.version, 'package.json and desktop version must agree');
assert.equal(lock.version, pkg.version, 'package-lock top-level version must agree');
assert.equal(lock.packages[''].version, pkg.version, 'package-lock root package version must agree');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.private, true, 'prevent accidental npm publication; GitHub visibility is independent');
assert.match(pkg.repository.url, /github\.com\/androoAGI\/starnet(?:\.git)?$/,
  'repository URL must point at the renamed public source repo (starnet)');

for (const required of [
  'LICENSE', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
  '.gitleaksignore', '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/workflows/secret-history.yml'
]) assert.ok(fs.existsSync(path.join(ROOT, required)), required + ' must exist');

const ignore = read('.gitleaksignore').split(/\r?\n/).filter(line => /^[0-9a-f]{40}:/.test(line));
// 25 pre-publication fingerprints + the reviewed loopback mock-provider fixtures
// from 2026-09-03 and 2026-09-10. Bump ONLY with a reviewed .gitleaksignore entry.
assert.equal(ignore.length, 27, 'the reviewed pre-publication baseline is finite and exact');
assert.equal(new Set(ignore).size, ignore.length, 'baseline fingerprints must be unique');

const workflow = read('.github/workflows/secret-history.yml');
assert.match(workflow, /fetch-depth:\s*0/, 'history scan must fetch all commits');
assert.match(workflow, /gitleaks git \. --no-banner --redact/);
assert.match(workflow, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/,
  'downloaded scanner archive must be checksum-pinned');

const operatorSurface = [
  read('scripts/release-cut.mjs'),
  read('docs/RELEASE_RUNBOOK.md'),
  read('docs/STARNET_UPDATES.md')
].join('\n');
assert.doesNotMatch(operatorSurface, /source repo stays private|Source repo \(private\)/,
  'release instructions must not contradict the public-source launch');
assert.match(operatorSurface, /Public source repo:/,
  'the release runbook must identify the source repository as public');

console.log('opensource-readiness.test: OK');
