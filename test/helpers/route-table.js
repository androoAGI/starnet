/* test/helpers/route-table.js — the station's MUTATING routes, read from the source as the dispatcher sees them.

   mutatingRoutes(root) -> [{ key, method, match, handler, file, body }]
     · every ROUTES entry in sidecar/index.js whose method is not GET/HEAD/OPTIONS, plus the entries the route modules
       spread into it (lineage-routes.js, browser-view.js, browser-handoff-routes.js), plus the one route the request
       handler answers before the table (the line-trigger webhook, serveTriggerHook);
     · key is 'METHOD match' with the match written as in the source (an exact or qsplit path, a prefix, a regex literal);
     · body is the handler's source: a named handler's function body (searched in the entry's file, then index.js), or the
       inline arrow itself.
   Used by test/route-authority.census.test.js. Reads source only; never boots a station. */
'use strict';
const fs = require('fs');
const path = require('path');
const { fnBody } = require('../_fnbody');

const MATCH_KEYS = ['exact', 'qsplit', 'prefix', 'qprefix', 'rx', 'qrx'];
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

// the text of one balanced {...} / [...] / (...) starting at src[at]
function balanced(src, at) {
  const open = src[at], close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0, i = at, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    // a regex literal (after a key colon or a comma/paren): skip it whole
    if (c === '/' && /[:(,=]\s*$/.test(src.slice(Math.max(0, i - 4), i))) {
      let j = i + 1, cls = false;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === '\\') { j++; continue; }
        if (d === '[') cls = true; else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        else if (d === '\n') { j = -1; break; }
      }
      if (j > 0) { i = j; continue; }
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return '';
}

// the entries of one routes array literal: each top-level {...}
function entriesOf(arrayText) {
  const out = [];
  let i = 1;
  while (i < arrayText.length) {
    const c = arrayText[i];
    if (c === '{') { const e = balanced(arrayText, i); out.push(e); i += e.length; continue; }
    if (c === '/' && arrayText[i + 1] === '/') { const nl = arrayText.indexOf('\n', i); i = nl < 0 ? arrayText.length : nl; continue; }
    if (c === '/' && arrayText[i + 1] === '*') { const e = arrayText.indexOf('*/', i + 2); i = e < 0 ? arrayText.length : e + 2; continue; }
    i++;
  }
  return out;
}

// { m, match, handler } of one entry's text, or null when it is not a route entry
function parseEntry(text) {
  const m = /^\{\s*m:\s*('([A-Z]+)'|\[([^\]]*)\])/.exec(text);
  if (!m) return null;
  const methods = m[2] ? [m[2]] : m[3].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  let match = null;
  for (const k of MATCH_KEYS) {
    const km = new RegExp(',\\s*' + k + ':\\s*').exec(text);
    if (!km) continue;
    const at = km.index + km[0].length;
    const rest = text.slice(at);
    let v;
    if (rest[0] === '\'') v = rest.slice(0, rest.indexOf('\'', 1) + 1);
    else if (rest[0] === '/') { const e = balancedRegex(rest); v = rest.slice(0, e); }
    else v = /^[A-Za-z0-9_.$]+(\[[^\]]*\])?/.exec(rest)[0];
    match = k + ' ' + v;
    break;
  }
  const hm = /,\s*h:\s*/.exec(text);
  let handler = '';
  if (hm) {
    const rest = text.slice(hm.index + hm[0].length);
    const id = /^[A-Za-z0-9_$.]+(?=\s*[,}\n])/.exec(rest);
    handler = id ? id[0] : rest.replace(/,\s*errorPolicy:[\s\S]*$/, '').replace(/\s*\}\s*$/, '').trim();
  }
  return { methods, match, handler };
}
function balancedRegex(s) {
  let j = 1, cls = false;
  for (; j < s.length; j++) {
    const d = s[j];
    if (d === '\\') { j++; continue; }
    if (d === '[') cls = true; else if (d === ']') cls = false;
    else if (d === '/' && !cls) break;
  }
  j++;
  while (/[a-z]/.test(s[j] || '')) j++;
  return j;
}

function bodyOf(handler, files) {
  if (!/^[A-Za-z0-9_$]+$/.test(handler)) return handler;   // an inline arrow: its own text is its body
  for (const src of files) {
    for (const head of ['async function ' + handler + '(', 'function ' + handler + '(']) {
      const b = fnBody(src, head);
      if (b) return b;
    }
    const arrow = new RegExp('(?:const|let)\\s+' + handler + '\\s*=\\s*(?:async\\s*)?\\(').exec(src);
    if (arrow) { const at = src.indexOf('{', arrow.index); return src.slice(arrow.index, at) + balanced(src, at); }
    // a handler built by a factory (`const h = require(...).makeRoute({...})`, `const back = settle(...)`): its statement
    const made = new RegExp('(?:const|let)\\s+' + handler + '\\s*=\\s*[^\\n]*').exec(src);
    if (made) return made[0];
  }
  return '';
}

function routesArray(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return '';
  return balanced(src, src.indexOf('[', at + anchor.length - 1));
}

function mutatingRoutes(root) {
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
  const idx = read('sidecar/index.js');
  const tables = [{ file: 'sidecar/index.js', text: routesArray(idx, 'const ROUTES = [') }];
  for (const rel of ['sidecar/lineage-routes.js', 'sidecar/browser-view.js', 'sidecar/browser-handoff-routes.js']) {
    tables.push({ file: rel, text: routesArray(read(rel), 'routes: [') });
  }
  const out = [];
  for (const t of tables) {
    const own = read(t.file);
    for (const e of entriesOf(t.text)) {
      const p = parseEntry(e);
      if (!p || !p.match) continue;
      for (const method of p.methods) {
        if (READ_ONLY.has(method)) continue;
        out.push({ key: method + ' ' + p.match, method, match: p.match, handler: p.handler, file: t.file, body: bodyOf(p.handler, [own, idx]) });
      }
    }
  }
  // answered before the table: the line-trigger webhook (its own secret, not the station key)
  out.push({ key: 'POST serveTriggerHook', method: 'POST', match: 'TRIGGER_HOOK_RX', handler: 'serveTriggerHook', file: 'sidecar/index.js', body: bodyOf('serveTriggerHook', [idx]) });
  return out;
}

module.exports = { mutatingRoutes, parseEntry, entriesOf, balanced };
