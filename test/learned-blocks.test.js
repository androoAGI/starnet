/* node test/learned-blocks.test.js — the persona's LEARNED blocks ride AFTER the cache prefix.

   composeSystemPrompt (frontend/app/app.js) ends each persona with the Commander dossier block and, while style
   confidence is low, the fork directive. Inside the sidecar's cacheSystemPrefix every change to either re-wrote the
   whole stable prefix cold. sidecar/learned-blocks.js lifts exactly those bytes out so runOnceCore can place them
   after the prefix. On a TASK turn chat.js glues its task hint straight onto the persona (no blank line), so the
   last learned block is NOT closed by a paragraph boundary — the split must still leave an identical base for
   every persona state. This locks the pure split (exact, ordered, length-preserving, idempotent, narrow), its
   drift against the frontend sources it mirrors (fork.js, dossier.js, chat.js's task hint), and the index.js
   wiring. test/learned-prefix.e2e.test.js proves the bytes on the provider wire. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { splitLearned, DOSSIER_HEAD } = require('../sidecar/learned-blocks.js');
const Fork = require('../frontend/app/fork.js');
const Dossier = require('../frontend/app/dossier.js');

// chat.js appends this to the persona on task turns: `system + (isTask ? '<hint>' : '') + (willSpeak ? voiceModeRules() : '')`
function chatTaskHint() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
  const m = /\(isTask \? '((?:[^'\\]|\\.)*)' : ''\)/.exec(src);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}
const HINT = chatTaskHint();
const VOICE = "\n\n[VOICE MODE — you're talking out loud, not typing.] Reply the way you'd actually SAY it.";   // voiceModeRules() opens a paragraph
const FORK = Fork.directive();
const IDENT = 'You are Atlas, a station agent.\n\nYOUR PURPOSE (purpose.md):\nShip things.';
const seed = (beliefs) => {
  const d = Dossier.fresh();
  beliefs.forEach(([dim, t], i) => Dossier.upsert(d, dim, { text: t }, i + 1));
  return Dossier.composeBlock(d, {});
};
const D1 = seed([['stack', 'TypeScript'], ['goals', 'Ship Phase A']]);
const D2 = seed([['stack', 'TypeScript'], ['goals', 'Ship Phase A'], ['style', 'terse']]);         // D1 + "\n- Working style: terse" (style composes after stack)
const D1B = seed([['stack', 'TypeScript'], ['goals', 'Ship Phase A'], ['stack', 'Vite']]);         // D1 + "; Vite" (stack is the last line)
const opts = { dossierBlock: D1, forkDirective: FORK };
const whole = r => r.base.length + r.learned.length;

// ---- drift locks: the sidecar matches exactly what the browser composes ----
A.ok(D1.length > 0, 'a seeded dossier composes a block');
A.eq(D1.split('\n')[0], DOSSIER_HEAD, 'DOSSIER_HEAD is the first line frontend/app/dossier.js composeBlock produces');
A.ok(D1.split('\n').slice(1).every(l => l.startsWith('- ')), 'every dossier line after the header is a "- Lead:" bullet (the structural fallback shape)');
A.ok(/^MID-TASK PREFERENCE FORK/.test(FORK), 'the fork directive text comes from frontend/app/fork.js');
A.ok(/^ If this needs real work/.test(HINT), 'chat.js task hint extracted from source (space-glued, no paragraph break)');
A.ok(D1B.indexOf(D1 + '; ') === 0, 'fixture: a second belief extends the line with "; "');
A.ok(D2.indexOf(D1 + '\n- ') === 0, 'fixture: a new dimension adds a "- " line after the copy');
const idxSrc = fs.readFileSync(path.resolve(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
A.ok(idxSrc.indexOf("const FORK_DIRECTIVE = require('../frontend/app/fork.js').directive();") >= 0, 'the sidecar takes the fork text from the same frontend module');

// ---- the four persona states x every tail chat.js / runOnceCore can append: ONE base ----
const STATES = {
  none: '',
  dossier: '\n\n' + D1,
  'dossier+fork': '\n\n' + D1 + '\n\n' + FORK,
  fork: '\n\n' + FORK
};
const TAILS = {
  'no tail': '',
  'task hint': HINT,
  'voice rules': VOICE,
  'task hint + voice': HINT + VOICE,
  'project line': '\n\n\nPROJECT FOLDER: C:\\proj',
  'task hint + workflow line': HINT + '\n\nNO WORKING FOLDER: relative paths save privately.'
};
for (const [tname, tail] of Object.entries(TAILS)) {
  for (const [copyName, copy] of [['in-sync copy', D1], ['empty copy', '']]) {
    const bases = {};
    for (const [sname, blocks] of Object.entries(STATES)) {
      const sys = IDENT + blocks + tail;
      const r = splitLearned(sys, { dossierBlock: copy, forkDirective: FORK });
      const label = tname + ' / ' + copyName + ' / ' + sname;
      A.eq(whole(r), sys.length, label + ': length invariant');
      A.eq(splitLearned(r.base, { dossierBlock: copy, forkDirective: FORK }).learned, '', label + ': idempotent');
      // the documented residual: structural fallback (no usable copy) + glued tail on the LAST bullet line
      const residual = copy === '' && sname === 'dossier' && tail.startsWith(HINT);
      if (residual) {
        A.eq(r.learned, '\n\n' + D1 + HINT, label + ': (residual) the glued hint rides with the structurally-found dossier');
        continue;
      }
      A.eq(r.learned, blocks, label + ': exactly the learned blocks move, in order');
      bases[sname] = r.base;
    }
    for (const sname of Object.keys(bases)) A.eq(bases[sname], IDENT + tail, tname + ' / ' + copyName + ' / ' + sname + ': base identical across persona states');
  }
}

// ---- stale sidecar copies ----
{
  // copy is a strict prefix: the persona's block continues with "; belief" or "\n- Lead:" — the exact copy is rejected
  for (const [label, persona] of [['"; B" continuation', D1B], ['"\\n- X" continuation', D2]]) {
    const sys = IDENT + '\n\n' + persona + '\n\n' + FORK + HINT;
    const r = splitLearned(sys, opts);
    A.eq([r.base, r.learned], [IDENT + HINT, '\n\n' + persona + '\n\n' + FORK], 'stale strict-prefix copy (' + label + '): the whole persona block moves');
    A.eq(whole(r), sys.length, 'length invariant (' + label + ')');
  }
  // an unrelated stale copy, fork present: the structural fallback stops at the fork's "\n\n"
  const D3 = seed([['stack', 'Rust'], ['people', 'the platform team']]);
  const r = splitLearned(IDENT + '\n\n' + D3 + '\n\n' + FORK + HINT, opts);
  A.eq([r.base, r.learned, r.moved], [IDENT + HINT, '\n\n' + D3 + '\n\n' + FORK, { dossier: true, fork: true }], 'structural fallback + fork split cleanly');
  const nul = splitLearned(IDENT + '\n\n' + D3 + '\n\n' + FORK, { dossierBlock: null, forkDirective: FORK });
  A.eq(nul.base, IDENT, 'null sidecar copy: structural fallback');
  A.eq(splitLearned(IDENT + '\n\n' + D3).learned, '\n\n' + D3, 'no opts at all: structural fallback still finds the dossier');
}
// ---- a belief containing "\n\n" (beliefs are only trimmed): the exact path carries it whole ----
{
  const DX = seed([['stack', 'TypeScript'], ['goals', 'Ship Phase A\n\nthen Phase B']]);
  A.ok(DX.indexOf('\n\n') > 0, 'fixture: the composed dossier carries an internal blank line');
  const sys = IDENT + '\n\n' + DX + '\n\n' + FORK + HINT;
  const r = splitLearned(sys, { dossierBlock: DX, forkDirective: FORK });
  A.eq([r.base, r.learned], [IDENT + HINT, '\n\n' + DX + '\n\n' + FORK], 'internal "\\n\\n" belief moves whole via the exact copy');
  const s2 = splitLearned(IDENT + '\n\n' + DX + HINT, { dossierBlock: DX, forkDirective: FORK });
  A.eq(s2.base, IDENT + HINT, 'internal "\\n\\n" belief + glued hint: the hint stays in the base');
}
// ---- narrowness ----
{
  const cron = 'You are the autonomous runner.\n\n<commander_context provenance="commander-dossier">\n' + D1 + '\n</commander_context>';
  A.eq(splitLearned(cron, opts).learned, '', 'the evidence pack\'s <commander_context> wrapper stays in place');
  const roster = IDENT + '\n\n' + D1 + '\n\n[ROUTINE] unattended.\n\n<commander_context provenance="commander-dossier">\n' + D1 + '\n</commander_context>';
  const rr = splitLearned(roster, opts);
  A.eq([rr.base, rr.learned], [IDENT + '\n\n[ROUTINE] unattended.\n\n<commander_context provenance="commander-dossier">\n' + D1 + '\n</commander_context>', '\n\n' + D1], 'cron: the roster persona\'s plain dossier moves, the wrapped evidence copy stays');
  A.eq(splitLearned(IDENT + '\n' + D1, opts).learned, '', 'a header that is not a paragraph start is ignored');
  A.eq(splitLearned(IDENT + ' ' + FORK, opts).learned, '', 'fork text that does not start a paragraph is ignored');
  A.eq(splitLearned(IDENT + '\n\n' + DOSSIER_HEAD + ' and more', opts).learned, '', 'a header with no bullets is not a dossier');
  const n = splitLearned(IDENT, opts);
  A.eq([n.base, n.learned], [IDENT, ''], 'no learned blocks: no-op');
  A.eq(splitLearned(null, opts), { base: '', learned: '', moved: { dossier: false, fork: false } }, 'null system');
  A.eq(splitLearned(undefined).base, '', 'undefined system, no opts');
}

// ---- index.js wiring ----
A.ok(idxSrc.indexOf("splitLearned(system || ''") >= 0, 'runOnceCore splits the original system');
A.ok(idxSrc.indexOf('const cacheSystemPrefix = learnedSplit.base + toolNote') >= 0, 'the cache prefix starts from the base');
A.ok(idxSrc.indexOf('cacheSystemPrefix + learnedSplit.learned + runtimeSkillBlock') >= 0, 'the learned blocks ride right after the prefix');
const sysLine = idxSrc.split('\n').findIndex(l => l.indexOf('const sys = internal') >= 0);
A.ok(sysLine > 0, 'the final seam is present');
A.ok(idxSrc.split('\n').slice(sysLine, sysLine + 3).join('\n').indexOf('learnedSplit') < 0, 'the internal path keeps the verbatim system');

A.report('learned-blocks.test');
