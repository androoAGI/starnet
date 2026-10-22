/* sidecar/plugin-template.js — the files "Create a plugin" (and the crew's plugin.draft_start) write.

   A WORKING plugin, not a stub: code in index.js (a hook, two crew tools, a handler for its window) and one window
   (ui/index.html) built from the station kit — a note list saved through starnet.store, a stat fed by its own
   backend, and a KIT tab that shows every component in the live theme. The author's first sight is proof every
   socket works; their job is to edit, never to guess the shape.

   The two big files live beside this module as plain templates (sidecar/plugin-template/*.tpl) — they are the
   PLUGIN's code, not the station's, so they stay out of the backend's own lint (they use the clock like any app).

   templateFiles({ id, name, description }) -> { 'plugin.json': text, 'index.js': text, 'ui/index.html': text } */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'plugin-template');
let cache = null;
function templates() {
  if (!cache) {
    cache = {
      index: fs.readFileSync(path.join(DIR, 'index.js.tpl'), 'utf8'),
      html: fs.readFileSync(path.join(DIR, 'ui-index.html.tpl'), 'utf8')
    };
  }
  return cache;
}

function htmlText(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function templateFiles(spec) {
  const id = String(spec.id);
  const name = String(spec.name || id);
  const description = String(spec.description || 'A Agent OS plugin.');
  const title = name.replace(/[&<>"'`\u0000-\u001f\u007f]/g, '').toUpperCase().slice(0, 40) || 'PLUGIN';
  const t = templates();

  const manifest = JSON.stringify({
    name, version: '1.0.0', description, main: 'index.js',
    screens: [{ id: 'main', title, entry: 'ui/index.html', size: 'panel' }]
  }, null, 2) + '\n';
  const index = t.index
    .split('{{NAME_COMMENT}}').join(name.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' '))
    .split('{{NAME_JSON}}').join(JSON.stringify(name));
  const html = t.html.split('{{NAME_HTML}}').join(htmlText(name));
  return { 'plugin.json': manifest, 'index.js': index, 'ui/index.html': html };
}

module.exports = { templateFiles };
