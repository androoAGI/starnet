/* node test/learned-tail.test.js — issue #105: learned state never moves the cached system prefix.

   The heads the sidecar cuts at are held to what the real composers write. The app.js half (blocks last, one boot compose, a
   fork flip reaches the crew) is locked on source, because composeSystemPrompt lives inside the app's closure. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { split, LEARNED_HEADS } = require('../sidecar/learned-tail.js');
const Dossier = require('../frontend/app/dossier.js');
const Fork = require('../frontend/app/fork.js');
const { withDossier } = require('../sidecar/dossierinject.js');
const CommanderContext = require('../sidecar/commander-context.js');

const dossier = Dossier.fresh();
Dossier.upsert(dossier, 'style', { text: 'prefers terse replies' }, 1000);
const block = Dossier.composeBlock(dossier, {});
A.ok(block.includes('prefers terse replies'), 'fixture: the real dossier block holds a belief');
const persona = 'You are Ada.\n\nYOUR PURPOSE (purpose.md):\nShip it.';

// each real block is found by a head, and no byte is lost or reordered
for (const [name, tail] of [['dossier', block], ['fork', Fork.directive()], ['both', block + '\n\n' + Fork.directive()]]) {
  const whole = persona + '\n\n' + tail;
  const s = split(whole);
  A.eq(s.stable, persona, name + ': the stable half is the persona without it');
  A.eq(s.stable + s.learned, whole, name + ': stable + learned is the persona, byte for byte');
}

// THE POINT: toggling learned state leaves the prefix byte-identical
A.eq(split(persona).stable, split(persona + '\n\n' + block).stable, 'a dossier arriving does not move the prefix');
A.eq(split(persona + '\n\n' + block).stable, split(persona + '\n\n' + block + '\n\n' + Fork.directive()).stable, 'the fork block flipping on does not move the prefix');

// server-composed personas: the real compose() output, with a note after the block still kept in order
const composedDossier = CommanderContext.compose({ dossier: block, goal: null });
A.ok(composedDossier.length > 0, 'fixture: compose wrote a block');
const server = withDossier(persona, composedDossier);
A.eq(split(server).stable, persona, 'a server-composed dossier is cut off too');
const composedGoal = CommanderContext.compose({ dossier: '', goal: { text: 'launch the store', next: 'write the page' } });
if (composedGoal) A.eq(split(withDossier(persona, composedGoal)).stable, persona, 'a goal with no dossier is cut off too');
const withNote = server + '\n\nA NOTE AFTER';
A.eq(split(withNote).stable + split(withNote).learned, withNote, 'text after a learned block keeps its place in the tail');

// edges
A.eq(split(persona), { stable: persona, learned: '' }, 'nothing learned: the persona is untouched');
A.eq(split(null), { stable: '', learned: '' }, 'no persona');
A.eq(split(block), { stable: '', learned: block }, 'a persona that is only a learned block');
A.eq(split('prose naming ' + LEARNED_HEADS[0] + ' mid-line').learned, '', 'a head inside a sentence is not a block');

// the wiring: runOnce and the app
const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
A.ok(/const cacheSystemPrefix = persona\.stable \+ toolNote/.test(index), 'the cached prefix starts from the stable half');
A.ok(/FinishLine\.append\(cacheSystemPrefix \+ persona\.learned \+ serviceKeysBlock/.test(index), 'the learned half follows the prefix on the task path');
A.ok(/\(String\(system \|\| ''\) \+ evidenceBlock\)/.test(index), 'internal self-talk keeps its verbatim persona, learned state included');
const app = fs.readFileSync(path.join(root, 'frontend', 'app', 'app.js'), 'utf8');
const compose = app.slice(app.indexOf('function composeSystemPrompt(a)'), app.indexOf('function applyAgentConfig'));
A.ok(/DossierStore\.composeBlock\(\)[\s\S]*Fork\.directive\(\)[\s\S]*return p;/.test(compose), 'the learned blocks close the persona');
A.ok(/recomposeAllPrompts\(\);\s*pushRoster\(\);\s*\/\/ Stage 2/.test(app), 'boot recomposes the whole crew before its roster push');
A.ok(/if \(first \|\| !agent\) return;[^\n]*\n\s*recomposeAllPrompts\(\);\s*pushRoster\(\);/.test(app), 'a fork flip reaches the whole crew and the sidecar roster');

A.report('learned-tail.test');
