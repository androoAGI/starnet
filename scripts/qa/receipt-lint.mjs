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

   EXIT. 0 when every log holds step results and no false green; 1 when a log holds a false green or no step result
   at all (an empty or foreign file must never lint clean); 2 on a usage error or an unreadable file.

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

/* Lints the text of one gate log. allow: Map(step -> texts) or null. A step result line counts only when it
   continues a run (same label and total, next number) or starts one (step 1), so a test that prints a line shaped
   like the runner's cannot steal the steps after it. */
export function lintLog(text, allow) {
  const lines = toLines(text);
  const labels = new Set();
  for (const line of lines) { const m = STEP_RESULT.exec(line); if (m) labels.add(m[1]); }
  const isRunnerLine = line => { for (const label of labels) if (line.startsWith(label + ': ')) return true; return false; };

  const result = { steps: 0, ok: 0, red: 0, runs: 0, falseGreens: [], allowed: [], retried: [], notes: [] };
  const seenAllowText = new Map();   // step -> Set(text used)
  const okSteps = new Set();
  const runs = new Map();            // label + total -> { label, total, last }
  const cutShort = r => result.notes.push('a ' + r.label + ' run ends after step ' + r.last + ' of ' + r.total + ' (cut short?)');
  let block = [];
  let retriedHere = false;
  for (const line of lines) {
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
      if (!isRunnerLine(line)) block.push(line);
      continue;
    }
    if (n === 1) {
      if (run && run.last < run.total) cutShort(run);
      run = { label: m[1], total: Number(m[3]), last: 0 };
      runs.set(key, run);
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
  for (const run of runs.values()) if (run.last < run.total) cutShort(run);
  if (allow) {
    for (const [step, texts] of allow) {
      if (!okSteps.has(step)) continue;
      const used = seenAllowText.get(step) || new Set();
      for (const t of texts) if (!used.has(t)) result.notes.push('allow-list text no longer printed by ' + step + ': "' + t + '" (drop it at this cut?)');
    }
  }
  result.clean = result.steps > 0 && result.falseGreens.length === 0;
  return result;
}

export function lintFile(file, allow) {
  return Object.assign({ file }, lintLog(decode(fs.readFileSync(file)), allow));
}

function render(r, allowFile) {
  const out = [];
  const base = path.basename(r.file);
  if (!r.steps) {
    out.push('receipt-lint: ' + base + ' holds no step result line; not a gate log, or the gate never ran a step');
    return out;
  }
  out.push('receipt-lint: ' + base + ' — ' + r.steps + ' step(s) (' + r.ok + ' ok, ' + r.red + ' red): ' +
    r.falseGreens.length + ' false green(s), ' + r.allowed.length + ' allow-listed');
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
  const code = falseGreens || empty ? 1 : 0;
  if (json) {
    log(JSON.stringify({ schema: 'starnet.receipt-lint.v1', allowList: allowFile, ok: code === 0, results }, null, 2));
    return code;
  }
  for (const r of results) render(r, allowFile).forEach(line => log(line));
  const allowed = results.reduce((sum, r) => sum + r.allowed.length, 0);
  if (code === 0) {
    log('receipt-lint: OK — no ok step printed an unlisted error signal in ' + results.length + ' log(s)' +
      (allowed ? ' (' + allowed + ' allow-listed step(s); review the allow-list at every cut)' : ''));
  } else {
    log('receipt-lint: FAILED — ' + falseGreens + ' ok step(s) printed an error signal' +
      (empty ? ', ' + empty + ' log(s) held no step result' : '') + '; a false green is a red, see docs/RELEASE_RUNBOOK.md §1.4a');
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
