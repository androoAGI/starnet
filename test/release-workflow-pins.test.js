/* node test/release-workflow-pins.test.js — the release workflows run only reviewed action code, on a read-only token.

   GHSA-2hpj: release-train.yml, release.yml and desktop-build.yml hold the signing and notarization secrets. A tag
   such as `actions/checkout@v4` can be moved by whoever controls that action's repo, so each third-party action is
   pinned to a full commit SHA (the tag stays as a comment for readers and update bots). The workflow token gets
   `contents: read` only: releases go to the releases repo through RELEASES_TOKEN, never through this token.

   Pure text check, no YAML parser (js-yaml isn't a dep). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.github', 'workflows');
const FILES = ['release-train.yml', 'release.yml', 'desktop-build.yml'];
const shaOf = new Map();   // action -> the one SHA every file pins it to

for (const name of FILES) {
  const yml = fs.readFileSync(path.join(dir, name), 'utf8');
  const uses = Array.from(yml.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm), m => ({ ref: m[1], rest: m[2] }));
  const external = uses.filter(u => !u.ref.startsWith('./'));
  A.ok(external.length >= 4, name + ': fixture: the third-party actions are found (' + external.length + ')');
  for (const u of external) {
    const m = u.ref.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)@([0-9a-f]{40})$/);
    A.ok(!!m, name + ': ' + u.ref + ' is pinned to a full commit SHA');
    A.ok(/^\s+#\s+\S+/.test(u.rest), name + ': ' + u.ref + ' keeps its tag as a comment');
    if (!m) continue;
    if (!shaOf.has(m[1])) shaOf.set(m[1], m[2]);
    A.eq(m[2], shaOf.get(m[1]), name + ': ' + m[1] + ' is pinned to the same commit as in the other release workflows');
  }
  for (const u of uses.filter(x => x.ref.startsWith('./'))) {
    A.ok(fs.existsSync(path.join(__dirname, '..', u.ref)), name + ': local workflow ' + u.ref + ' exists in this repo');
  }

  // top-level least privilege: before `jobs:`, exactly `contents: read`
  const head = yml.slice(0, yml.search(/^jobs:\s*$/m));
  const perms = head.match(/^permissions:[ \t]*\n((?:[ \t]+\S.*\n)+)/m);
  A.ok(!!perms, name + ': declares a top-level permissions block');
  A.eq(perms ? perms[1].trim().split(/\n/).map(s => s.trim()) : null, ['contents: read'], name + ': the workflow token only reads contents');
  A.ok(!/^\s*permissions:\s*(write-all|read-all)\s*$/m.test(yml) && !/^\s+[a-z-]+:\s*write\s*$/m.test(yml),
    name + ': no job widens the token to write');
  A.ok(!/secrets\.GITHUB_TOKEN|github\.token/.test(yml), name + ': no step relies on the workflow token for release writes');
}
A.ok(shaOf.size >= 5, 'fixture: the shared actions were compared across files (' + shaOf.size + ')');

A.report('release-workflow-pins.test');
