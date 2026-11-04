'use strict';
/* test/helpers/run-order.js — the order runOnceCore takes a turn in (turn identity; DESIGN §12.1, A2-SP-05).

   One list, read by test/turn-run-order.lint.test.js (the real runOnceCore's anchors appear once each, in this order) and
   by the property test's fast-tier run driver (it calls the same real functions in the same order). Each entry names the
   lane commit that adds it (0 = the anchor is older than the lane); both readers use the entries up to UPTO, the lane
   commit the tree is at. */
const RUN_ORDER = Object.freeze([
  { anchor: 'TurnDirective.turnOf(', commit: 3, what: '#2: which turn the run answers' },
  { anchor: 'TurnDirective.reuseByTurn(', commit: 3, what: '#2b: the early findTurn read (re-keys an agent conflict or an unplaceable turn)' },
  { anchor: 'TurnDirective.capture(', commit: 4, what: '#7: the directive, captured once before expansion' },
  { anchor: 'turnWindow.apply(', commit: 8, what: '#20: the server-built window' },
  { anchor: 'attachments.expandForRun(', commit: 0, what: 'the run host expands the attachments' },
  { anchor: 'const kinds = TurnKinds.ofRun(', commit: 4, what: '#9b: the run\'s row kinds, from origin flags' },
  { anchor: 'const runTranscript = makeRunTranscript(', commit: 0, what: '#4: the run\'s transcript writer (reads kinds)' },
  { anchor: 'let retryDirective = TurnDirective.reuse(', commit: 3, what: '#3: the late key-blind input check' },
  { anchor: 'TurnDirective.install(runTranscript, directive,', commit: 4, what: '#10: the directive row and the attachment rows of its files (reads kinds)' },
  { anchor: 'directiveTitle: TurnDirective.title(', commit: 4, what: '#11: the journal names the directive title' },
  { anchor: 'TurnDirective.runTitle(', commit: 4, what: '#12: the run-end title' }
]);
const UPTO = 8;
function upTo(n) { return RUN_ORDER.filter(e => e.commit <= (n == null ? UPTO : n)); }

module.exports = { RUN_ORDER, UPTO, upTo };
