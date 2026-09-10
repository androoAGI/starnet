/* node test/onboarding-legibility.test.js — replayable first-command tour + total glossary hint coverage. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Glossary = require('../frontend/app/glossary.js');

(function () {
  const root = path.resolve(__dirname, '..');
  const files = [path.join(root, 'frontend', 'index.html')];
  for (const dir of [path.join(root, 'frontend', 'app'), path.join(root, 'frontend', 'app', 'windows')]) {
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.js')) files.push(path.join(dir, name));
  }
  const used = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/data-hint=(?:"|')([^"']+)(?:"|')/g)) {
      // Dynamic template expressions are tested by their producers; this gate owns literal UI vocabulary.
      if (!/[+${}<>]/.test(match[1])) used.add(match[1].trim().toLowerCase());
    }
  }
  const missing = [...used].filter(term => !Glossary.has(term));
  A.eq(missing, [], 'every literal data-hint in the shipped UI resolves to glossary copy');
  for (const term of ['agent', 'crew', 'model', 'provider', 'run', 'approval', 'transcript', 'deliverable', 'artifact', 'verification', 'context', 'fallback', 'settings', 'update', 'restore', 'logbook', 'notification', 'manual']) {
    A.ok(Glossary.has(term), 'everyday harness term is explained: ' + term);
    const sentence = Glossary.lookup(term);
    A.ok(sentence.length >= 25 && /[.!?]$/.test(sentence), term + ' is a useful one-sentence definition');
  }

  // Drive the actual tutorial module with a returning-user state. The ordinary entry remains one-shot,
  // while replayFirstCommand deliberately re-enters the same real tour without clearing saved progress.
  const tutorialSrc = fs.readFileSync(path.join(root, 'frontend', 'app', 'tutorial.js'), 'utf8');
  let opens = 0;
  let liveName = 'NOVA';
  const speakerNames = [];
  let closedManual = 0;
  let tutorialRaw = JSON.stringify({ v: 1, firstCommandDone: true, seen: {}, brief: { command: true }, briefDismissed: true, briefComplete: false });
  let tutorialRemovals = 0;
  const context = vm.createContext({
    console, setTimeout, clearTimeout, Promise,
    localStorage: {
      getItem: () => tutorialRaw,
      setItem(_key, value) { tutorialRaw = value; },
      removeItem() { tutorialRaw = null; tutorialRemovals++; }
    },
    Chat: { typeLine() {}, localLine() {}, choices() {} },
    Dialogue: { open(opts) { opens++; speakerNames.push(opts.name); }, node() { return new Promise(() => {}); }, isOpen() { return false; }, close() {} },
    StationUI: { closeTerm(key) { if (key === 'manual') closedManual++; } },
    U: { bus: { on() {} } },
    document: { querySelector() { return null; }, getElementById(id) { return id === 'gt-agent' ? { textContent: liveName } : null; }, body: { contains() { return false; }, appendChild() {}, style: {} } },
    window: { addEventListener() {}, removeEventListener() {} },
    matchMedia: () => ({ matches: true })
  });
  vm.runInContext(tutorialSrc, context, { filename: 'tutorial.js' });
  vm.runInContext('Tutorial.firstCommand({name:"NOVA"})', context);
  A.eq(opens, 0, 'returning users are not forced through the automatic tour again');
  const replayed = vm.runInContext('Tutorial.replayFirstCommand()', context);
  A.ok(replayed && opens === 1, 'Field Manual replay enters the real quick-tour flow for a returning user');
  A.eq(speakerNames[0], 'NOVA', 'replay after reload uses the existing agent identity instead of minting a name');
  vm.runInContext('Tutorial.teardown()', context);
  liveName = 'ORION';
  vm.runInContext('Tutorial.replayFirstCommand()', context);
  A.eq(speakerNames[1], 'ORION', 'a later replay reads the renamed live agent instead of the previous tutorial name');
  A.eq(JSON.parse(tutorialRaw).brief.command, true, 'replay preserves earned first-command progress');
  A.eq(closedManual, 2, 'replay closes the Field Manual before the Dialogue lesson can be covered');
  A.ok(/fm-replay/.test(tutorialSrc) && /replay\.onclick = \(\) =>/.test(tutorialSrc), 'Field Manual renders and wires REPLAY QUICK TOUR');
  const resetState = vm.runInContext('Tutorial.reset()', context);
  A.eq(resetState.firstCommandDone, false, 'new-Commander reset re-arms the one-shot tour');
  A.eq(resetState.seen, {}, 'new-Commander reset clears inherited coachmark history');
  A.eq(resetState.brief, {}, 'new-Commander reset clears inherited FIRST STEPS progress');
  A.eq(tutorialRemovals, 1, 'tutorial reset explicitly removes starnet.tutorial.v1');

  // Release clarity regression: Genesis must route each editable choice to its real home, and the work
  // vocabulary must preserve the product's existing truth — deliberate tasks are board cards; every saved
  // conversation is a COMMS Session; recruited crew are real agents, never decorative placeholders.
  const indexSrc = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
  const stationUiSrc = fs.readFileSync(path.join(root, 'frontend', 'app', 'stationui.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(root, 'frontend', 'app', 'app.js'), 'utf8');
  A.ok(/Workstreams\.reset\(\);[\s\S]{0,240}Tutorial\.reset\(\)/.test(appSrc),
    'the real new-Commander reset funnel clears tutorial ownership before entering the station');
  A.ok(indexSrc.includes('agent setup in CREW › AGENTS') && indexSrc.includes('model in COMMS') && indexSrc.includes('SYSTEM › SETTINGS'),
    'Genesis routes editable setup to the real agent, model, and settings surfaces');
  A.eq(indexSrc.includes('everything here is re-editable later in the Commander Dossier'), false,
    'Genesis no longer sends agent configuration to the Commander Dossier');
  A.ok(/data-term="tasks"[^>]*>[\s\S]*?<small>[^<]*planned work[^<]*<\/small>/.test(indexSrc),
    'WORK describes TASKS as planned board work instead of claiming every run lives there');
  A.ok(stationUiSrc.includes('<b>NO TASKS</b>') && /id="kb-in"[^>]*aria-label="New task"/.test(stationUiSrc),
    'TASK BOARD uses task language instead of exposing the internal workstream record name');
  A.ok(stationUiSrc.includes('Chats, routines, and while-away runs live as Sessions in COMMS'),
    'TASK BOARD explains which real work belongs only in COMMS Sessions');
  A.ok(/workstream:\s+'the saved conversation behind a COMMS session/.test(fs.readFileSync(path.join(root, 'frontend', 'app', 'glossary.js'), 'utf8')),
    'the glossary explains the workstream record without conflating it with a board task');
  A.ok(/every crew member you recruit is a real, separate agent/.test(tutorialSrc),
    'Field Manual states that recruited crew are real independent agents');
  A.eq(/echoes for now|placeholders until you recruit more minds/.test(tutorialSrc), false,
    'Field Manual contains no placeholder-agent contradiction');

  A.report('onboarding-legibility.test');
})();
