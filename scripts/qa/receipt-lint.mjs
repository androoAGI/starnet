#!/usr/bin/env node
/* scripts/qa/receipt-lint.mjs — a step a gate log scores green really was green (C0-4, 2026-11-11).

     node scripts/qa/receipt-lint.mjs <gate.log> [<gate.log> ...] [--allow=<file> | --no-allow] [--json]

   WHY. The gate runner (scripts/run-test-list.mjs) scores a step by its exit code alone. A test that throws,
   catches and logs the throw, and still reaches its OK summary exits 0 and reads green. The v0.15.0 HTTP receipt
   carried test/forget.tool-quotes.http.test.js that way: an Error and its stack, then "OK (6 assertions)", then
   "step 350/357 ok". test/_assert.js report() now refuses an exit code set before it (56a0ed102); this lint reads
   the receipt itself, so a test that never calls report(), or a log written before that fix, is caught too.

   WHAT IT CHECKS. For every step the runner reported `ok`, the output printed since the previous step's result
   line (the scored attempt only: a quarantined retry starts a new attempt) is searched for four signals:
     stack   a stack frame: "    at fn (file:12:3)", "    at file:12:3", "    at Array.map (<anonymous>)"
     error   an error line: "Error: ", "TypeError: ", "AssertionError [ERR_ASSERTION]: " as a word
     fail    a "FAIL:" line, the test/_assert.js convention (the runner keeps the same lines for test/flaky.list)
     throw   a logged throw: "threw" or "unhandled", any case (the fourth signal of the 0.15.0 autopsy scan)
   An ok step that printed any of them is a FALSE GREEN, unless scripts/qa/receipt-lint.allow names that step and
   the text it is expected to print. Signals are grouped into events: a signal line together with the stack frames
   right under it, or a run of stack frames under the line before them. An allow-list entry clears an event only
   when that event's line contains one of the entry's texts, so a NEW error in an allow-listed step still fails.
   Red steps are the gate's own verdict and are only counted here; the red-disposition rules for them are in
   docs/RELEASE_RUNBOOK.md §1.4a.

   READING THE WHOLE RUN. A step the lint never finds is a step whose output it never read, so a log it cannot follow
   to the end never lints clean. A step whose output ends without a newline leaves that text in front of the runner's
   next line on the same physical line ("progress...run-test-list: step 2/4 ok 0.2s — node ..."); the lint finds the
   runner's line anywhere in a line, once it knows the run's label, and lints the text in front of it with that step.
   A run that stops before its last step, a run whose step count disagrees with the runner's own tally ("<label>: ran
   X of Y step(s)"), a run with no tally, or a tally for a run the lint never read, is an INCOMPLETE RUN and fails:
   the log was cut short (deadline, interrupt, a partial copy) or holds a result line the lint could not follow.

   EXIT. 0 when every log holds step results, every run is read to the runner's tally, and no step is a false green;
   1 when a log holds a false green, an incomplete run, or no step result at all (an empty or foreign file must never
   lint clean); 2 on a usage error or an unreadable file.

   Read-only: it reads the logs and the allow-list, writes nothing, runs nothing, and finishes in well under a
   second on a 1,784-step log. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOW = path.join(HERE, 'receipt-lint.allow');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// "<label>: step N/M ok 3.8s — node test/x.test.js" or "... FAILED (exit 1) 0.8s — node ...". The dash is matched as
// any non-space run, so a log decoded with the wrong code page still parses.
const STEP_RESULT = /^(\S+): step (\d+)\/(\d+) (ok|FAILED \(([^)]*)\)) \d+(?:\.\d+)?s \S+ node (\S+)\s*$/;
const FLAKY_RETRY = /^(\S+): step (\d+)\/(\d+) failed \(.*\) in its quarantined flaky case\b.*retrying once/;
// "<label>: ran 4 of 4 step(s) in 0m01s": the runner's own tally, printed once when a run ends (cut short or not).
const TALLY = /^(\S+): ran (\d+) of (\d+) step\(s\) in /;
// The runner's lines that can come straight after a step's output. The runner prints each with console.log, so each
// one ends its physical line; text in front of one on the same line is the step's last output, written with no
// newline. A candidate counts only when the text from the label to the end of the line is a whole runner line.
const STEP_NOTE = /^\S+: step \d+\/\d+ (?:TIMED OUT |reached the run deadline |could not start: |interrupted |is quarantined in )/;
const INTERRUPT = /^\S+: interrupted by \S+ /;
const AFTER_OUTPUT = [STEP_RESULT, FLAKY_RETRY, STEP_NOTE, INTERRUPT, TALLY];

/* Where a runner line starts inside a line that a step's output ran into: the first index > 0 at which a known label
   begins a whole runner line, or -1 (index 0 is an ordinary runner line). */
function gluedAt(line, labels) {
  let best = -1;
  for (const label of labels) {
    const needle = label + ': ';
    for (let at = line.indexOf(needle, 1); at > 0 && (best < 0 || at < best); at = line.indexOf(needle, at + 1)) {
      const rest = line.slice(at);
      if (AFTER_OUTPUT.some(re => re.test(rest))) { best = at; break; }
    }
  }
  return best;
}

export const SIGNALS = Object.freeze({
  stack: line => /^\s+at\s+(?:.+\s\((?:.*:\d+(?::\d+)?|<anonymous>|native|unknown location|index \d+)\)|.+:\d+:\d+)\s*$/.test(line),
  error: line => /(?:^|[^A-Za-z0-9_$])(?:[A-Z][A-Za-z0-9]*)?Error(?: \[[A-Z0-9_]+\])?:(?:\s|$)/.test(line),
  fail: line => /^\s*FAIL:/.test(line),
  throw: line => /threw|unhandled/i.test(line)
});

function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const toLines = text => String(text).split(/\r?\n/).map(line => line.replace(ANSI, ''));

/* The allow-list: "<step> | <expected text> [| <expected text> ...]" per line, "#" comments. A step listed twice or
   with no expected text is an error, never a silent pass. Returns Map(step -> [text, ...]). */
export function parseAllowList(text, source) {
  const out = new Map();
  const where = source || 'allow-list';
  toLines(text).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('|').map(part => part.trim());
    const step = parts.shift();
    const texts = parts.filter(Boolean);
    if (!step) throw new Error(where + ':' + (index + 1) + ': an entry has no step');
    if (!texts.length) throw new Error(where + ':' + (index + 1) + ': ' + step + ' names no expected text, so it would allow anything');
    if (out.has(step)) throw new Error(where + ':' + (index + 1) + ': ' + step + ' is listed twice');
    out.set(step, texts);
  });
  return out;
}

export function readAllowList(file) {
  return parseAllowList(fs.readFileSync(file, 'utf8'), file);
}

/* Signal events in one step's output: [{ line, kinds:[...], frames }]. A run of stack frames belongs to the signal
   line right above it, or, when that line is no signal (console.trace, a custom prefix), opens its own event named
   after that line. */
export function signalEvents(lines) {
  const events = [];
  let frameOwner = null;   // the event the current run of stack frames belongs to
  let prevLine = null;     // the last line that was not a stack frame
  let prevEvent = null;    // the event that line opened, when it was a signal line
  for (const line of lines) {
    if (SIGNALS.stack(line)) {
      if (!frameOwner) {
        frameOwner = prevEvent || { line: prevLine == null ? '(a stack frame with no line above it)' : prevLine.trim(), kinds: [], frames: 0 };
        if (!prevEvent) events.push(frameOwner);
        if (!frameOwner.kinds.includes('stack')) frameOwner.kinds.push('stack');
      }
      frameOwner.frames++;
      continue;
    }
    frameOwner = null;
    const kinds = ['error', 'fail', 'throw'].filter(kind => SIGNALS[kind](line));
    prevEvent = kinds.length ? { line: line.trim(), kinds, frames: 0 } : null;
    if (prevEvent) events.push(prevEvent);
    prevLine = line;
  }
  return events;
}

/* Why a run cannot vouch for its steps, or null when it was read from step 1 to the runner's tally. */
function incompleteRun(run) {
  const name = 'the ' + run.label + ' run of ' + run.total + ' step(s)';
  const lost = run.lostAt ? '; the lint lost track after step ' + run.lostAt.after + ' (the next result line it found was step ' +
    run.lostAt.saw + '), so the output of the steps after it was never read' : '';
  const off = run.tallies.find(t => t.ran !== t.read);
  if (off) return name + ': the runner says it ran ' + off.ran + ' step(s), the lint read ' + off.read + lost;
  if (run.last < run.total) {
    return name + ' stops after step ' + run.last + (run.lostAt ? lost
      : run.tallies.length ? ': the gate was cut short (the runner ran ' + run.tallies[0].ran + '), so this is no green receipt'
        : ' and the runner never printed its tally: a partial log');
  }
  if (!run.tallies.length) return name + ': every step was read, but the runner never printed its tally ("ran ' + run.total + ' of ' + run.total + ' step(s)"): a log copied before the run ended?';
  return null;
}

/* Lints the text of one gate log. allow: Map(step -> texts) or null. A step result line counts only when it
   continues a run (same label and total, next number) or starts one (step 1), so a test that prints a line shaped
   like the runner's cannot steal the steps after it. A run the lint cannot read to the runner's tally is reported
   in `incomplete` and makes the log unclean. */
export function lintLog(text, allow) {
  const lines = toLines(text);
  const labels = new Set();
  for (const line of lines) { const m = STEP_RESULT.exec(line) || TALLY.exec(line); if (m) labels.add(m[1]); }
  const isRunnerLine = line => { for (const label of labels) if (line.startsWith(label + ': ')) return true; return false; };

  const result = { steps: 0, ok: 0, red: 0, runs: 0, glued: 0, falseGreens: [], allowed: [], retried: [], incomplete: [], notes: [] };
  const seenAllowText = new Map();   // step -> Set(text used)
  const okSteps = new Set();
  const runs = new Map();            // label + total -> the current run { label, total, last, tallies, lostAt }
  const allRuns = [];
  let block = [];
  let retriedHere = false;
  for (const physical of lines) {
    let line = physical;
    const cut = labels.size ? gluedAt(line, labels) : -1;
    if (cut > 0) {
      block.push(line.slice(0, cut));
      line = line.slice(cut);
      result.glued++;
    }
    const tally = TALLY.exec(line);
    if (tally) {
      const run = runs.get(tally[1] + '\0' + tally[3]);
      const ran = Number(tally[2]);
      if (run) run.tallies.push({ ran, read: run.last });
      else if (ran > 0 || Number(tally[3]) > 0) {
        result.incomplete.push('the ' + tally[1] + ' runner says it ran ' + ran + ' of ' + tally[3] + ' step(s), but the lint read no step of that run');
      }
      continue;
    }
    const retry = FLAKY_RETRY.exec(line);
    const retryRun = retry && runs.get(retry[1] + '\0' + retry[3]);
    if (retryRun && Number(retry[2]) === retryRun.last + 1) {
      block = [];
      retriedHere = true;
      continue;
    }
    const m = STEP_RESULT.exec(line);
    const n = m ? Number(m[2]) : 0;
    const key = m ? m[1] + '\0' + m[3] : '';
    let run = m ? runs.get(key) : null;
    const boundary = m && (n === 1 || (run && n === run.last + 1));
    if (!boundary) {
      // a result line that skips ahead in a run is the mark of a step line the lint did not find
      if (run && n > run.last + 1 && !run.lostAt) run.lostAt = { after: run.last, saw: n };
      if (!isRunnerLine(line)) block.push(line);
      continue;
    }
    if (n === 1) {
      run = { label: m[1], total: Number(m[3]), last: 0, tallies: [], lostAt: null };
      runs.set(key, run);
      allRuns.push(run);
      result.runs++;
    }
    run.last = n;
    const total = run.total;
    result.steps++;
    const step = m[6];
    const position = n + '/' + total;
    if (m[4] !== 'ok') {
      result.red++;
    } else {
      result.ok++;
      okSteps.add(step);
      if (retriedHere) result.retried.push({ position, step });
      const events = signalEvents(block);
      if (events.length) {
        const texts = allow ? allow.get(step) : null;
        const unexplained = events.filter(event => {
          const hit = texts ? texts.find(t => event.line.includes(t)) : null;
          if (hit) {
            if (!seenAllowText.has(step)) seenAllowText.set(step, new Set());
            seenAllowText.get(step).add(hit);
          }
          return !hit;
        });
        const row = { position, step, events };
        if (unexplained.length) result.falseGreens.push(Object.assign(row, { unexplained }));
        else result.allowed.push(row);
      }
    }
    block = [];
    retriedHere = false;
  }
  for (const run of allRuns) {
    const why = incompleteRun(run);
    if (why) result.incomplete.push(why);
  }
  if (result.glued) {
    result.notes.push(result.glued + ' runner line(s) followed step output that had no newline; that output was linted with its step');
  }
  if (allow) {
    for (const [step, texts] of allow) {
      if (!okSteps.has(step)) continue;
      const used = seenAllowText.get(step) || new Set();
      for (const t of texts) if (!used.has(t)) result.notes.push('allow-list text no longer printed by ' + step + ': "' + t + '" (drop it at this cut?)');
    }
  }
  result.clean = result.steps > 0 && result.falseGreens.length === 0 && result.incomplete.length === 0;
  return result;
}

export function lintFile(file, allow) {
  return Object.assign({ file }, lintLog(decode(fs.readFileSync(file)), allow));
}

function render(r, allowFile) {
  const out = [];
  const base = path.basename(r.file);
  const incomplete = () => { for (const why of r.incomplete) out.push('  INCOMPLETE RUN  ' + why); };
  if (!r.steps) {
    out.push('receipt-lint: ' + base + ' holds no step result line; not a gate log, or the gate never ran a step');
    incomplete();
    return out;
  }
  out.push('receipt-lint: ' + base + ' — ' + r.steps + ' step(s) (' + r.ok + ' ok, ' + r.red + ' red): ' +
    r.falseGreens.length + ' false green(s), ' + r.allowed.length + ' allow-listed' +
    (r.incomplete.length ? ', ' + r.incomplete.length + ' incomplete run(s)' : ''));
  incomplete();
  for (const row of r.falseGreens) {
    out.push('  FALSE GREEN  step ' + row.position + '  ' + row.step + '  [' + [...new Set(row.unexplained.flatMap(e => e.kinds))].join(', ') + ']');
    for (const event of row.unexplained.slice(0, 3)) out.push('      ' + event.line.slice(0, 200) + (event.frames ? '  (+' + event.frames + ' stack frame(s))' : ''));
    if (row.unexplained.length > 3) out.push('      … and ' + (row.unexplained.length - 3) + ' more');
  }
  for (const row of r.allowed) {
    out.push('  allowed      step ' + row.position + '  ' + row.step + '  (' + row.events.length + ' expected event(s), ' +
      path.basename(allowFile || 'allow-list') + ', reviewed at every cut)');
  }
  for (const row of r.retried) out.push('  note: step ' + row.position + ' ' + row.step + ' passed on its quarantined retry; its first attempt was red (cause: test/flaky.list)');
  if (r.red) out.push('  note: ' + r.red + ' red step(s): the gate itself is red; apply the red-disposition rules (docs/RELEASE_RUNBOOK.md §1.4a)');
  for (const note of r.notes) out.push('  note: ' + note);
  return out;
}

export function main(argv, io) {
  const log = (io && io.log) || (line => console.log(line));
  const files = [];
  let allowFile = DEFAULT_ALLOW, json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--no-allow') allowFile = null;
    else if (arg.startsWith('--allow=')) allowFile = arg.slice('--allow='.length);
    else if (arg === '-h' || arg === '--help') { log('usage: node scripts/qa/receipt-lint.mjs <gate.log> [...] [--allow=<file> | --no-allow] [--json]'); return 0; }
    else if (arg.startsWith('--')) { log('receipt-lint: unknown option ' + arg); return 2; }
    else files.push(arg);
  }
  if (!files.length) { log('usage: node scripts/qa/receipt-lint.mjs <gate.log> [...] [--allow=<file> | --no-allow] [--json]'); return 2; }
  let allow = null;
  try { if (allowFile) allow = readAllowList(allowFile); }
  catch (error) { log('receipt-lint: cannot use the allow-list: ' + error.message); return 2; }
  const results = [];
  for (const file of files) {
    try { results.push(lintFile(file, allow)); }
    catch (error) { log('receipt-lint: cannot read ' + file + ': ' + error.message); return 2; }
  }
  const falseGreens = results.reduce((sum, r) => sum + r.falseGreens.length, 0);
  const empty = results.filter(r => !r.steps).length;
  const incomplete = results.reduce((sum, r) => sum + r.incomplete.length, 0);
  const code = falseGreens || empty || incomplete ? 1 : 0;
  if (json) {
    log(JSON.stringify({ schema: 'starnet.receipt-lint.v1', allowList: allowFile, ok: code === 0, results }, null, 2));
    return code;
  }
  for (const r of results) render(r, allowFile).forEach(line => log(line));
  const allowed = results.reduce((sum, r) => sum + r.allowed.length, 0);
  if (code === 0) {
    log('receipt-lint: OK — every run read to its tally, and no ok step printed an unlisted error signal in ' + results.length + ' log(s)' +
      (allowed ? ' (' + allowed + ' allow-listed step(s); review the allow-list at every cut)' : ''));
  } else {
    const why = [];
    if (falseGreens) why.push(falseGreens + ' ok step(s) printed an error signal');
    if (incomplete) why.push(incomplete + ' run(s) not read to the runner\'s tally');
    if (empty) why.push(empty + ' log(s) held no step result');
    log('receipt-lint: FAILED — ' + why.join(', ') + '; a false green or an unread step is a red, see docs/RELEASE_RUNBOOK.md §1.4a');
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
