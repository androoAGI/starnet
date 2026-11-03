/* node test/line-runner.census.test.js — ONE HOP EXECUTOR (line-job-runner, invariant I4: the sidecar half).

   Every entry's later stages run through sidecar/routing/line-runner.js: the channel hubs (each chat, the sample, the webhook and
   SEND TO hubs), the scheduled fire, Run Now and the step test. Read through test/helpers/source.js, over every sidecar file:
     1. no runOnce call outside line-runner.js runs a line hop — a call handed a hop's $ ceiling (ceilingUsd) or opted out of its
        stream's resume seed (resumeSeed: false) is a hop runner of its own;
     2. the floor-bound chain runner's advance (chain.advance / chainRunner.advance) is called only by line-runner.js (runLineJob);
     3. no sidecar file builds a hop closure for the chain (`runAgent:`) — a hop is a profile of the one executor.
   RED before the lane: hop runOnce calls in hub.js and index.js (the scheduled seam, Run Now, the step test's runDock), and
   chain.advance called by the hub, the scheduled seam and Run Now. The page half (no frontend file composes Pipeline.handoffPrompt or
   calls /api/routing/chain) lands with the dead browser executor's removal. */
'use strict';
const A = require('./_assert.js');
const { sidecarSourceFiles } = require('./helpers/source.js');

const RUNNER = 'sidecar/routing/line-runner.js';
const files = sidecarSourceFiles();
A.ok(files.some(f => f.rel === RUNNER), 'the one hop executor exists: ' + RUNNER);

// the argument text of the call whose '(' is at `open` (balanced parens; strings and comments skipped)
function argsAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && nx === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === ch) break; } continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return '';
}
const lineOf = (text, at) => text.slice(0, at).split('\n').length;
// the CODE of a file: its comments blanked (line breaks kept, so line numbers hold), its strings kept
function codeOf(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { const e = text.indexOf('\n', i); const j = e < 0 ? text.length : e; out += ' '.repeat(j - i); i = j - 1; continue; }
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); const j = e < 0 ? text.length : e + 2; out += text.slice(i, j).replace(/[^\n]/g, ' '); i = j - 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '\\') { j++; continue; } if (text[j] === ch || (ch !== '`' && text[j] === '\n')) break; }
      out += text.slice(i, j + 1); i = j; continue;
    }
    out += ch;
  }
  return out;
}

const hopRuns = [], advances = [], closures = [];
let runnerHopRuns = 0, runnerAdvances = 0;
for (const f of files) {
  const text = codeOf(f.text);
  // 1. runOnce CALLS (never its declaration), with the arguments they pass
  const call = /(^|[^\w.$])runOnce\s*\(/g;
  let m;
  while ((m = call.exec(text))) {
    const at = m.index + m[1].length;
    if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue;   // `async function runOnce(` is the host itself
    const args = argsAt(text, text.indexOf('(', at));
    if (/\bresumeSeed:\s*false\b/.test(args) || /\bceilingUsd:/.test(args)) {
      if (f.rel === RUNNER) runnerHopRuns++;
      else hopRuns.push(f.rel + ':' + lineOf(text, at));
    }
  }
  // 2. the chain runner's advance
  const adv = /\b(?:chainRunner|chain)\.advance\s*\(/g;
  while ((m = adv.exec(text))) {
    if (f.rel === RUNNER) runnerAdvances++;
    else advances.push(f.rel + ':' + lineOf(text, m.index));
  }
  // 3. a hop closure handed to the chain
  const clo = /\brunAgent:\s*(?:async\b|function\b|\()/g;
  while ((m = clo.exec(text))) closures.push(f.rel + ':' + lineOf(text, m.index));
}
A.eq(hopRuns, [], 'no runOnce call outside line-runner.js runs a line hop (a hop\'s ceilingUsd or resumeSeed false)');
A.eq(runnerHopRuns, 1, 'line-runner.js runs every hop through ONE runOnce call');
A.eq(advances, [], 'chain.advance is called only by line-runner.js');
A.eq(runnerAdvances, 1, 'line-runner.js calls it once (runLineJob)');
A.eq(closures, [], 'no sidecar file hands the chain a hop closure of its own (runAgent:)');

A.report('line-runner.census.test');
