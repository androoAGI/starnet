/* node test/field-manual-accessibility.test.js — the active Field Manual section must be
   exposed to assistive technology from the same state that paints the visual `.on` tab. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app/tutorial.js'), 'utf8');

function fakeBody() {
  const body = {
    buttons: [],
    classList: { add() {} },
    querySelectorAll(selector) { return selector === '.fm-tab[data-t]' ? this.buttons.filter(button => button.dataset.t) : []; },
    querySelector(selector) { return selector === '.fm-replay' ? this.buttons.find(button => button.textContent === 'REPLAY QUICK TOUR') : null; }
  };
  Object.defineProperty(body, 'innerHTML', {
    set(html) {
      this.buttons = Array.from(html.matchAll(/<button\s+([^>]*)>([^<]+)<\/button>/g), match => {
        const attrs = match[1];
        const attr = name => {
          const found = attrs.match(new RegExp(name + '="([^"]*)"'));
          return found ? found[1] : null;
        };
        return {
          textContent: match[2],
          dataset: { t: attr('data-t') },
          getAttribute: attr,
          onclick: null
        };
      });
    }
  });
  return body;
}

const context = {
  localStorage: { getItem() { return null; }, setItem() {} },
  globalThis: null
};
context.globalThis = context;
vm.runInNewContext(source + '\n;globalThis.__tutorial = Tutorial;', context);

const body = fakeBody();
context.__tutorial.fillFieldManual(body);

function pressedState() {
  return body.buttons.filter(button => button.dataset.t).map(button => ({
    text: button.textContent,
    pressed: button.getAttribute('aria-pressed')
  }));
}

const chapters = ['FIRST MISSION', 'CONTROLS', 'CREW', 'GEAR', 'LINES', 'PROGRESS', 'HELP'];
const expected = active => chapters.map((title, i) => ({
  text: title,
  pressed: title === active ? 'true' : 'false'
}));
A.eq(pressedState(), expected('FIRST MISSION'), 'the initial visual section is the sole pressed button');

const gear = body.buttons.find(button => button.dataset.t === 'GEAR');
A.ok(gear && typeof gear.onclick === 'function', 'the production renderer wired the GEAR control');
gear.onclick();
A.eq(pressedState(), expected('GEAR'), 'selection changes keep the accessible and visual state aligned');

A.report('field-manual-accessibility.test');
