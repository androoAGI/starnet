'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const calls = [], writes = [];
const context = {
  localStorage: { getItem: () => null, setItem: (...args) => writes.push(args) },
  StationUI: { openTerm: (...args) => calls.push(['open', ...args]), closeTerm: (...args) => calls.push(['close', ...args]) }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/app/tutorial.js'), 'utf8') + '\nthis.tutorial = Tutorial;', context);
const tutorial = context.tutorial;
function body() {
  const result = { html: '', buttons: [], classList: { add() {} },
    querySelectorAll(selector) {
      const attr = { '[data-platform-start]': 'platformStart', '[data-fm-open]': 'fmOpen' }[selector];
      return attr ? this.buttons.filter(b => b.dataset[attr]) : [];
    }, querySelector() { return null; }
  };
  Object.defineProperty(result, 'innerHTML', { set(html) {
    this.html = html;
    this.buttons = [...html.matchAll(/<button\s+([^>]*)>([^<]+)<\/button>/g)].map(([,attrs,text]) => ({
      textContent: text, dataset: Object.fromEntries([...attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([,key,value]) => [key.replace(/-([a-z])/g, (_,c) => c.toUpperCase()), value]))
    }));
  }});
  return result;
}
const before = JSON.stringify(tutorial._state());
assert.equal(tutorial.showPlatformConnections(), true);
assert.deepEqual(calls.pop(), ['open', 'manual', 'platforms']);
const guide = body(); tutorial.fillFieldManual(guide);
assert.match(guide.html, /aria-label="CONNECT PLATFORMS"/);
guide.buttons.find(b => b.dataset.platformStart === 'apps').onclick();
assert.deepEqual(calls.slice(-2), [['close', 'manual'], ['open', 'connectors', 'catalog']]);
assert.match(tutorial.platformGuideHTML('apps'), /data-platform-guide="apps" open/);
assert.match(tutorial.platformGuideHTML('apps'), /saved key is not a tested connection/);
guide.buttons.find(b => b.dataset.platformStart === 'messaging').onclick();
assert.deepEqual(calls.slice(-2), [['close', 'manual'], ['open', 'messaging', 'overview']]);
assert.match(tutorial.platformGuideHTML('messaging'), /data-platform-guide="messaging" open/);
assert.match(tutorial.platformGuideHTML('messaging'), /Complete pairing/);
const details = { open: false, dataset: { platformGuide: 'messaging' } }, back = {};
tutorial.wirePlatformGuide({ querySelectorAll: selector => selector === '[data-platform-guide]' ? [details] : [back] });
details.ontoggle();
assert.doesNotMatch(tutorial.platformGuideHTML('messaging'), /data-platform-guide="messaging" open/);
back.onclick();
assert.deepEqual(calls.pop(), ['open', 'manual', 'platforms']);
assert.equal(tutorial.openPlatformSetup('invalid'), false);
assert.equal(JSON.stringify(tutorial._state()), before, 'replaying setup help cannot complete tutorial or connection milestones');
assert.equal(writes.length, 0, 'opening instructions does not save a connection or progress');
console.log('tutorial-platform-guide: OK (routing, replay, collapse and truthful progress)');
