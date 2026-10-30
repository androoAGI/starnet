/* node test/process-operation-copy.test.js — an approval card says what the call DOES (authority-census, A5-F3).

   THE DEFECT (a5-consent-copy-and-broker-map.json; live walk W-A1 read cards): both classifiers keyed the words on the tool
   FAMILY. Desktop actionPhrase (frontend/app/chat.js) said "run a command" for every shell/terminal tool except a write;
   the phone's lock-screen push (sidecar/index.js remoteAskWords) said "wants to run a command" for the whole family,
   writes included. So a terminal.read card — reading a session's output — asked the Commander to approve running a
   command, which is a power that call does not have.

   THE CONTRACT: each operation in its own words — run a command (shell.exec, terminal.start), type into a running process,
   read output, check a status, wait, interrupt, stop, resize — the same verbs on the desk and on the phone, the session it
   touches named where there is one. Copy only: which calls ask, and what an answer grants, is not changed here (a read can
   still need approval for the data it exposes). The real production functions run; nothing here re-implements them. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sidecarTopLevelFunction } = require('./helpers/source');

// a function inside chat.js's module body: from its 2-space-indented declaration to its closing '  }'
function chatFunction(src, name) {
  const lines = src.split('\n');
  const i = lines.findIndex(l => l.indexOf('  function ' + name + '(') === 0);
  if (i < 0) return '';
  const j = lines.findIndex((l, k) => k > i && l === '  }');
  return lines.slice(i, j + 1).join('\n');
}
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8').replace(/\r\n/g, '\n');
const leadKeys = (chatSrc.match(/^ {2}const LEAD_KEYS = \[[^\n]*\];$/m) || [''])[0];
const desk = {};
vm.createContext(desk);
// processOperation exists only after the fix; the unchanged actionPhrase on 748b0462595 runs without it
vm.runInContext([leadKeys, chatFunction(chatSrc, 'glance'), chatFunction(chatSrc, 'requestArgs'), chatFunction(chatSrc, 'leadText'),
  chatFunction(chatSrc, 'processOperation'), chatFunction(chatSrc, 'actionPhrase'), 'this.actionPhrase = actionPhrase;'].join('\n'), desk);
A.ok(typeof desk.actionPhrase === 'function' && leadKeys, 'the desktop card phrase is the production chat.js actionPhrase');

const phone = {};
vm.createContext(phone);
vm.runInContext(sidecarTopLevelFunction('remoteAskWords') + '\nthis.remoteAskWords = remoteAskWords;', phone);
A.ok(typeof phone.remoteAskWords === 'function', 'the lock-screen words are the production remoteAskWords');

const card = (tool, args) => desk.actionPhrase({ tool, argsSummary: JSON.stringify(args || {}) });
const push = (tool, args) => phone.remoteAskWords({ tool, argsSummary: JSON.stringify(args || {}) });

// ---- the reads and the lifecycle never claim to run a command ----
const READS = {
  'terminal.read': [{ session: 'build' }, 'read output from a running process: build'],
  'terminal.status': [{ session: 'build' }, 'check a process status: build'],
  'shell.bg.read': [{ id: 'devserver' }, 'read output from a running process: devserver'],
  'shell.bg.status': [{ id: 'devserver' }, 'check a process status: devserver'],
  'shell.bg.wait': [{ id: 'devserver' }, 'wait for a running process: devserver'],
  'shell.bg.kill': [{ id: 'devserver' }, 'stop a running process: devserver'],
  'terminal.stop': [{ session: 'build' }, 'stop a running process: build'],
  'terminal.interrupt': [{ session: 'build' }, 'interrupt a running process: build'],
  'terminal.resize': [{ session: 'build', cols: 120, rows: 40 }, 'resize a terminal session: build']
};
for (const [tool, [args, words]] of Object.entries(READS)) {
  A.eq(card(tool, args), words, tool + ': the desktop card names the operation and its session');
  A.eq(card(tool.replace(/\./g, '_'), args), words, tool + ' (wire name): the same words');
  A.eq(push(tool, args), 'wants to ' + words, tool + ': the lock screen says the same');
  A.eq(push(tool.replace(/\./g, '_'), args), 'wants to ' + words, tool + ' (wire name): the same on the lock screen');
  A.ok(!/run a command/.test(card(tool, args)) && !/run a command/.test(push(tool, args)), tool + ' never reads as running a command');
}

// ---- controls: the runners still say so, typing says typing, and typed input never reaches a lock screen ----
A.eq(card('shell.exec', { cmd: 'npm test' }), 'run a command: npm test', 'shell.exec still runs a command (desk)');
A.eq(push('shell.exec', { cmd: 'npm test' }), 'wants to run a command: npm test', 'shell.exec still runs a command (phone)');
A.eq(card('terminal.start', { command: 'npm run dev', name: 'dev' }), 'run a command: npm run dev', 'terminal.start still runs a command (desk)');
A.eq(push('terminal.start', { command: 'npm run dev', name: 'dev' }), 'wants to run a command: npm run dev', 'terminal.start still runs a command (phone)');
A.eq(card('terminal.write', { session: 'build', data: 'y' }), 'type into a running process: y', 'terminal.write types into a process (desk, the glance as before)');
A.eq(push('terminal.write', { session: 'build', data: 'hunter2' }), 'wants to type into a running process', 'terminal.write types into a process (phone) and the typed text stays off the lock screen');
A.eq(push('shell.bg.write', { id: 'repl', input: 'secret' }), 'wants to type into a running process', 'shell.bg.write: the same, no typed text');
A.ok(!/run a command/.test(card('shell.future_tool', {})) && !/run a command/.test(push('shell.future_tool', {})), 'a shell/terminal name the table does not know is never promoted to "run a command"');

// ---- one vocabulary: the desk and the phone agree on every operation ----
const ALL = ['shell.exec', 'terminal.start', 'terminal.write', 'shell.bg.write'].concat(Object.keys(READS));
for (const tool of ALL) {
  const d = card(tool, {}), p = push(tool, {});
  A.eq('wants to ' + d, p, tool + ': the desk and the phone use the same verb (' + d + ')');
}

// ---- the packaged website mirror carries the same words (npm run sync:website) ----
const mirror = path.join(__dirname, '..', 'website', 'app', 'app', 'chat.js');
if (fs.existsSync(mirror)) {
  const m = fs.readFileSync(mirror, 'utf8').replace(/\r\n/g, '\n');
  A.eq(chatFunction(m, 'processOperation'), chatFunction(chatSrc, 'processOperation'), 'the website mirror has the same operation table');
}

A.report('process-operation-copy.test');
