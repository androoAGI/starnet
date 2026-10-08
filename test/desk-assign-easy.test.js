/* test/desk-assign-easy.test.js — GIVING AN AGENT A DESK IS ONE CLICK (2026-10-07 — Andrew: "Assigning a desk to an agent
   should be much easier. Currently you have to go and make sure u hit the configure button, its SO SO SO CONFUSING").
   It used to be: select the desk → find CONFIGURE → a centred modal → pick. And the COMMS "PLACE ITS DESK" door placed a desk
   that belonged to NOBODY, so the deskless agent still had nowhere to sit. Locked here (source — build.js is the DOM-bound REFIT
   module; the live round-trip was proven in the seeded app):
     1. a selected workstation's own card carries WHO SITS HERE — one chip per agent, one click assigns; no CONFIGURE key for it;
     2. giving an agent a desk takes it off its OTHER workstation in the same transaction (world.js seats the agent at the FIRST
        workstation bound to it, so a second binding was a click that visibly did nothing) — one UNDO;
     3. PLACE ITS DESK arms a desk FOR that agent: the next floor click drops it already theirs; any placed desk becomes the
        selection so its card asks who sits there. */
const A = require('assert');
const fs = require('fs');
const path = require('path');
const build = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'build.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
const fn = name => { const i = build.indexOf('function ' + name + '('); A.ok(i > 0, name + ' exists'); return build.slice(i, build.indexOf('\n  }\n', i)); };

// 1. the card is the picker
const sel = fn('renderSelection');
A.ok(/if\(WORKSTATION_TYPES\[p\.t\]\)actions\.before\(sitsRow\(p\)\);/.test(sel), 'a selected workstation shows WHO SITS HERE above its keys');
A.ok(/if\(isEditableProp\(p\.t\)&&!WORKSTATION_TYPES\[p\.t\]\)add\('CONFIGURE'/.test(sel), 'a workstation has no CONFIGURE key');
const row = fn('sitsRow');
A.ok(/WHO SITS HERE/.test(row) && /const res = assignDesk\(p\.id, aid\);/.test(row), 'each chip assigns in one click');
A.ok(/if \(p\.agentId\) chip\('NOBODY', ''\);/.test(row), 'a bound desk can be emptied from the same row');
A.ok(!/ASSIGN AGENT TO WORKSTATION/.test(build), 'the old centred modal picker is gone');

// 2. one desk per agent, one undo
const assign = fn('assignDesk');
A.ok(/station\.transact\(/.test(assign), 'reassigning is one transaction (one undo)');
A.ok(/station\.propsByAgent\(id\)\) if \(q\.id !== propId && WORKSTATION_TYPES\[q\.t\]\) station\.assignPropAgent\(q\.id, ''\)/.test(assign),
  'the agent leaves its other workstation');

// 3. PLACE ITS DESK places THEIR desk
A.ok(/placement\.agentId = owner;/.test(build) && /const owner = WORKSTATION_TYPES\[propType\] \? deskOwner : null;/.test(build), 'a desk placed for an agent lands bound to it');
A.ok(/selectedPropId = res\.id; renderSelection\(\);   \/\/ the tool stays armed/.test(build), 'a placed desk becomes the selection so its card asks who sits there');
A.ok(/if \(id !== 'prop'\) deskOwner = null;/.test(fn('selectTool')) && /deskOwner = null;/.test(fn('close')), 'leaving the prop tool or BUILD MODE drops the pending owner');
A.ok(/openAssign, placeDeskFor,/.test(build), 'Build exports placeDeskFor');
A.ok(/function openDeskPlacement\(agentId\)/.test(app) && /Build\.placeDeskFor\(agentId\)/.test(app), 'the app door passes the agent through');
A.ok(/App\.openDeskPlacement\(id\)/.test(chat), 'the COMMS chip names the deskless agent');

console.log('desk-assign-easy: ok');
