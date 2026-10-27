/* node test/memory-truth.table.test.js — memory-truth-1027: ONE similarity, ONE subject key, and a contradicted memory
   retired deterministically and reversibly by every writer.

   The 10-26 audit found six hand-copied Jaccard functions and no notion of a belief's SUBJECT: a same-polarity
   correction ("prefers light mode" after "prefers dark mode") was refused as a near-duplicate by reflection, saved
   beside the old belief by notebook.write, and added as a second active record by trusted capture (f97e73fb class);
   and two different facts that share a shape ("the staging db is in frankfurt" / "the production db is in frankfurt")
   were challenged or dropped as restatements. This table drives the same beliefs through every writer:
     1. one similarity: no memory writer keeps its own Jaccard copy (mint-ledger and priorwork pass their own stoplist)
     2. the subject key itself (MemTruth.claimOf / relate): dupe · supersede · distinct · unknown */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { sidecarSourceFiles } = require('./helpers/source');
const MemTruth = require('../frontend/app/memtruth.js');

/* ---------- 1. ONE similarity function ---------- */
{
  const JACCARD = /inter\s*\/\s*\(\s*A\.size\s*\+\s*B\.size\s*-\s*inter\s*\)/;   // the hand-copied formula
  const files = sidecarSourceFiles();
  const writers = ['sidecar/memcore.js', 'sidecar/reflect.js', 'sidecar/tools/builtin/notebook.js', 'sidecar/failreview.js', 'sidecar/mint-ledger.js', 'sidecar/priorwork.js'];
  for (const rel of writers) {
    const f = files.find(x => x.rel === rel);
    A.ok(!!f, rel + ' exists');
    if (!f) continue;
    A.ok(!JACCARD.test(f.text), rel + ' keeps no Jaccard copy of its own');
    A.ok(/memtruth\.js'\)/.test(f.text), rel + ' imports the shared memtruth module');
  }
  const study = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'study.js'), 'utf8');
  A.ok(!JACCARD.test(study) && /require\('\.\/memtruth\.js'\)/.test(study) && /root\.MemTruth/.test(study), 'study.js (browser + sidecar) reads the same module, via the UMD root in the browser');
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  const mt = html.indexOf('<script src="app/memtruth.js">'), st = html.indexOf('<script src="app/study.js">');
  A.ok(mt > 0 && st > mt, 'index.html loads memtruth.js before study.js');
  const memtruthText = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'memtruth.js'), 'utf8');
  A.ok(JACCARD.test(memtruthText), 'the formula lives once, in memtruth.js');

  // the shared function is the old one, byte for byte in behaviour, and takes a caller's own stoplist
  A.eq(MemTruth.similarity('the user prefers npm start', 'prefers npm start over serve'), 0.5, 'Jaccard over 3+ char tokens, stopwords dropped');
  A.eq(MemTruth.similarity('', 'anything'), 0, 'an empty side is never similar');
  A.eq(require('../sidecar/memcore.js').tokenJaccard('alpha beta gamma', 'alpha beta delta'), 0.5, 'memcore.tokenJaccard delegates');
  const ML = require('../sidecar/mint-ledger.js');
  A.ok(ML.isDup('ULTRON daily operating loop', 'Ultron operating loop'), 'mint-ledger keeps its own stoplist (daily) as a parameter');
  A.ok(!ML.isDup('Morning news digest', 'Evening build check'), 'mint-ledger: unrelated names stay apart');
  const PW = require('../sidecar/priorwork.js');
  A.eq(PW.similarity('Improved parkour prototypes v2', 'parkour prototype'), 1, 'priorwork keeps its own stoplist and stemmer');
}

/* ---------- 2. the subject key ---------- */
{
  const key = t => MemTruth.subjectKey(t);
  A.eq(key('User prefers dark mode'), key('The user prefers a light theme'), 'dark/light: one subject (the theme)');
  A.eq(key('User prefers tabs for indentation'), key('From now on, always use spaces instead of tabs for indentation.'), 'tabs/spaces: a note and an order share the subject');
  A.eq(key('User prefers tabs'), key('User now prefers spaces'), 'bare tabs/spaces: one subject');
  A.ok(key('The staging database is in Frankfurt') !== key('The production database is in Frankfurt'), 'staging/production: two subjects');
  A.eq(key('The staging DB lives in the Virginia region'), key('The staging database is in Frankfurt'), 'an abbreviation is the same subject');
  for (const t of ['User prefers Python', 'The user is a designer', 'User likes it when replies are short', 'Project uses React for the frontend',
    'staging deploys from the release branch', 'Is the user on Windows?', 'User prefers tabs. They hate spaces.']) {
    A.eq(key(t), null, 'no confident subject, no key: ' + t);
  }
  const rel = (a, b) => MemTruth.relate(a, b);
  const TABLE = [
    ['User prefers dark mode', 'The user prefers a light theme', 'supersede'],
    ['User prefers tabs for indentation', 'User prefers spaces over tabs for indentation', 'supersede'],
    ['User prefers tabs for indentation', 'Always use spaces for indentation.', 'supersede'],
    ['User prefers tabs', 'User hates tabs', 'supersede'],
    ['User prefers rounded purple cards for Acme website design', 'User does not prefer rounded purple cards for Acme website design', 'supersede'],
    ['The staging database is in Frankfurt', 'The staging DB lives in the Virginia region', 'supersede'],
    ['The default branch is main', 'The default branch is develop', 'supersede'],
    ['User prefers concise replies', 'User prefers detailed replies', 'supersede'],
    ['The staging database is in Frankfurt', 'The production database is in Frankfurt', 'distinct'],
    ['the staging database lives in the frankfurt region', 'the production database lives in the frankfurt region', 'distinct'],
    ['User prefers dark mode', 'User prefers tabs', 'distinct'],
    ['User prefers concise replies', 'User prefers short concise replies', 'dupe'],
    ['The staging database is in Frankfurt', 'the staging database lives in the frankfurt region', 'dupe'],
    ['Always use spaces for indentation.', 'User prefers spaces for indentation', 'dupe'],
    // free-text topics never decide 'distinct': one belief worded twice stays on the similarity path
    ['the Commander prefers npm start over npm run serve', 'Commander prefers to run npm start rather than npm run serve', 'unknown'],
    ['User prefers Python', 'User prefers Go', 'unknown'],
    ['User drafts posts in Notion', 'User now drafts posts in Obsidian', 'unknown']
  ];
  for (const [a, b, want] of TABLE) {
    A.eq(rel(a, b), want, want + ': «' + a + '» vs «' + b + '»');
    A.eq(rel(b, a), want, '…and the verdict is symmetric');
  }
}

A.report('memory-truth.table');
