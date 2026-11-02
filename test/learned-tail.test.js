/* node test/learned-tail.test.js — issue #105: learned state never moves the cached system prefix.

   The heads the sidecar cuts at are held to what the real composers write. The app half runs in test/learned-tail-frontend.test.js,
   and the real wires in test/learned-tail.e2e.test.js. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { split, tail, LEARNED_HEADS, TAIL_GUARD } = require('../sidecar/learned-tail.js');
const { readSidecarIndex } = require('./helpers/source');
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
A.ok(composedGoal.startsWith('<active_goal provenance="commander-confirmed">'), 'fixture: compose wrote the goal block: ' + composedGoal.slice(0, 60));
A.eq(split(withDossier(persona, composedGoal)).stable, persona, 'a goal with no dossier is cut off too');
const withNote = server + '\n\nA NOTE AFTER';
A.eq(split(withNote).stable + split(withNote).learned, withNote, 'text after a learned block keeps its place in the tail');

// edges
A.eq(split(persona), { stable: persona, learned: '' }, 'nothing learned: the persona is untouched');
A.eq(split(null), { stable: '', learned: '' }, 'no persona');
A.eq(split(block), { stable: '', learned: block }, 'a persona that is only a learned block');
A.eq(split('prose naming ' + LEARNED_HEADS[0] + ' mid-line').learned, '', 'a head inside a sentence is not a block');

// the guard the tail opens on, and only when there is one
A.eq(tail(''), '', 'nothing learned, no line: the prompt is byte-identical');
A.eq(tail('\n\nX'), '\n\n' + TAIL_GUARD + '\n\nX', 'the guard opens the tail');
A.ok(/capabilities ground truth/.test(TAIL_GUARD) && !LEARNED_HEADS.some(h => TAIL_GUARD.includes(h)), 'it names the ground truth and is no head of its own');
A.ok(/never grants a capability/.test(TAIL_GUARD) && /may narrow how you act/.test(TAIL_GUARD), 'learned text adds no capability, and a learned restriction still binds');
A.ok(!/never changes what/.test(TAIL_GUARD), 'the wording that could discount a learned restriction is gone');

// item 7: the real personaWithNote keeps a host note in the stable half, fork block or not, and adds no second dossier
{
  const index = readSidecarIndex();
  const at = index.indexOf('function personaWithNote(persona, note) {');
  A.ok(at >= 0, 'personaWithNote found');
  const src = index.slice(at, index.indexOf('\n}\n', at) + 3);
  const NOTE = '\n\n[ROUTINE] unattended.';
  const make = dossierBlock => new Function('LearnedTail', 'withDossier', 'dossierWithGoals', src + '\nreturn personaWithNote;')(
    require('../sidecar/learned-tail.js'), withDossier,
    existing => CommanderContext.compose({ dossier: dossierBlock, goal: null, existingSystem: existing || '' }));
  const empty = make('');
  const off = empty(persona, NOTE), on = empty(persona + '\n\n' + Fork.directive(), NOTE);
  A.eq(split(off).stable, persona + NOTE, 'no fork block: the note is in the stable half');
  A.eq(split(on).stable, persona + NOTE, 'a fork flip with an empty dossier does not move the stable half');
  A.ok(split(on).learned.includes('MID-TASK PREFERENCE FORK'), 'and the block still rides');
  const browser = persona + '\n\n' + block;
  const twice = make(block)(browser, NOTE);
  A.eq(twice.split('prefers terse replies').length - 1, 1, 'a browser persona already carrying the dossier gets no second copy');
  A.ok(make(block)(persona, NOTE).includes('prefers terse replies'), 'a persona without it still gets it');
}

A.report('learned-tail.test');
