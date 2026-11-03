'use strict';
/* test/helpers/voice-rig.js — boot the station's voice scripts into a vm sandbox in the order the page loads them.

   frontend/index.html loads the voice modules as classic scripts, one after another, into one global scope. A rig
   that hand-picks app/voice.js boots a module graph the page never runs, and the day voice.js reads a module loaded
   ahead of it, every such rig throws at load while the page works. So the order is read from index.html, never
   restated here.

   bootVoice(sandbox, { through, stream }) runs every app/voice*.js script the page loads, in page order, up to and
   including `through` (default 'voice.js'). voice-stream.js is the live audio transport: a rig fakes it as a global
   when it needs one, so it is loaded only with { stream: true }. Returns the sandbox's { Voice, VoiceLive, VoiceState }
   (undefined for a module not loaded). Each script is compiled once per process and run in every sandbox. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
// every voice module the page loads, in page order (app/voice-stream.js, app/voice.js, app/voice-live.js, ...)
const VOICE_SCRIPTS = Array.from(PAGE.matchAll(/<script\b[^>]*\bsrc="app\/(voice(?:-[a-z]+)?\.js)"/g), m => m[1]);

const compiled = new Map();
function script(name) {
  if (!compiled.has(name)) {
    const src = fs.readFileSync(path.join(ROOT, 'frontend', 'app', name), 'utf8');
    compiled.set(name, new vm.Script(src, { filename: name }));
  }
  return compiled.get(name);
}
// a script's top-level const is a binding of the context's global scope, not a sandbox property: read it from inside
const GLOBALS = new vm.Script('({ Voice: typeof Voice === "undefined" ? undefined : Voice, ' +
  'VoiceLive: typeof VoiceLive === "undefined" ? undefined : VoiceLive, ' +
  'VoiceState: typeof VoiceState === "undefined" ? undefined : VoiceState })');

function bootVoice(sandbox, opts) {
  opts = opts || {};
  const through = opts.through || 'voice.js';
  const last = VOICE_SCRIPTS.indexOf(through);
  if (last < 0) throw new Error('frontend/index.html does not load app/' + through + ' (it loads ' + VOICE_SCRIPTS.join(', ') + ')');
  if (!vm.isContext(sandbox)) vm.createContext(sandbox);
  for (const name of VOICE_SCRIPTS.slice(0, last + 1)) {
    if (name === 'voice-stream.js' && !opts.stream) continue;
    script(name).runInContext(sandbox);
  }
  return GLOBALS.runInContext(sandbox);
}

module.exports = { bootVoice, VOICE_SCRIPTS };
