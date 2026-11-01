'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');

const source = readSidecarSource();
const weights = source.match(/function nightshiftPreferenceWeights\(\) \{[\s\S]*?\n\}/);
const decide = source.match(/function nightshiftDecideLearn\([\s\S]*?\n\}/);

A.ok(weights, 'night-shift effective preference seam exists');
A.ok(weights && /if \(!enabled\) return \{\};/.test(weights[0]), 'pause suppresses every preference source before weights are assembled');
A.ok(weights && /effectivePreferenceWeights\(model, legacy, true\)/.test(weights[0]), 'legacy history and shared evidence meet at one pure authority seam');
A.ok(decide && /recommendationLedger\.verdict/.test(decide[0]), 'new return-card verdicts update the shared recommendation ledger');
A.ok(decide && !/learnFold|saveResilient\(NIGHTSHIFT_LEARN_FILE/.test(decide[0]), 'new verdicts are not double-written to the legacy learn store');
A.ok(/preferenceTallies\(nightshiftPreferenceWeights\(\)\)/.test(source), 'context packs consume the same effective preference model used for ranking');

// LEARNING RE-CHECK after the await (scanDocumentSource's rule): a pause/forget that lands DURING a learning pass's
// model or embedder call wins. Behaviour is proven live in learning-pause-midflight.e2e + scout.e2e BOOT 4; these
// seams keep the fast gate honest about every await in the four passes.
const fnSrc = name => { const m = source.match(new RegExp('async function ' + name + '\\(o\\) \\{[\\s\\S]*?\\n\\}')); return m ? m[0] : ''; };
const predicate = source.match(/function learningUnchangedSince\(start\) \{[\s\S]*?\n\}/);
A.ok(predicate && /s\.enabled && s\.revision === start\.revision/.test(predicate[0]), 'the re-check requires learning still on AND an unchanged revision (setEnabled and markForgotten both bump it)');
for (const [name, awaits] of [
  ['runReflection', [/const out = await reflect\(/]],
  ['runFailureReview', [/const out = await Failreview\.review\(/]],
  ['hybridVectors', [/await embedder\.embed\(plan\.map/, /await embedder\.embed\(\[query\]\)/]],
  ['runScoutCycle', [/Interests\.buildDirective\(\{ activityLines/, /recipe author\. Follow the format/, /recruiter\. Follow the format/]]
]) {
  const body = fnSrc(name);
  A.ok(body && /const pz = personalizationStore\.read\(\);\s*\n\s*if \(!pz\.enabled\) return/.test(body), name + ': snapshots the personalization state at entry');
  for (const at of awaits) {
    const i = body.search(at);
    A.ok(i >= 0, name + ': the await seam ' + at + ' exists');
    // the re-check follows that await before any other statement can persist
    const after = body.slice(i, i + 700);
    A.ok(/if \(!learningUnchangedSince\(pz\)\) return/.test(after), name + ': re-checks the pause/forget after ' + at);
  }
}

A.report('personalization-authority-wiring.test');
