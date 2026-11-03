/* engine-floor.mjs — reads scripts/lib/engine-floor.json, the ONE web-engine floor, and derives every mirror from it.
 *
 * WHY ONE TABLE. The floor was declared three ways and they disagreed (gh#136, 5308fc67, E12): tauri.conf.json promised
 * macOS 11.0; bootguard.js called any engine without regex lookbehind TOO OLD ("needs Safari 16.4+"), so a healthy
 * Safari 16.0 Mac read "web engine: TOO OLD" in every copied report and one missing non-critical file rendered "STARNET
 * NEEDS A NEWER macOS" with RELOAD hidden; and the syntax ratchet banned 16.4 syntax so that engines BELOW 16.4 could
 * parse the page. The floor now follows what the station code already uses without a guard (Safari 15.4: Object.hasOwn,
 * Array#at, crypto.randomUUID, structuredClone, dialog.showModal), so no engine that works today loses support.
 *
 * What reads it:
 *   floorApis(t)        the api features whose since IS the floor: bootguard's floor probes. An engine missing any of
 *                       them is below the floor; one that has them all is not.
 *   syntaxRules(t)      syntax newer than the floor: test/webkit-floor-syntax.test.js bans it from every page script (a
 *                       parse error drops the whole file, and its module with it).
 *   apiRules(t)         APIs newer than the floor: the same test requires a typeof guard at each use.
 *   shimSource(t)       the WebKit floor shim: deletes every API newer than the floor before any page script runs
 *                       (scripts/qa/webkit-floor-boot.mjs).
 *   assertEngineFloor   what stage-frontend-dist.mjs refuses to stage: tauri.conf.json, or bootguard's FLOOR literal or
 *                       floor probes, disagreeing with the table. The message names the file and the floor's value.
 * Honest limit: syntax is gated lexically and APIs by removal; the bugs and CSS of a real Safari 15.4 are not reproduced. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TABLE = join(dirname(fileURLToPath(import.meta.url)), 'engine-floor.json');
export const SCHEMA = 'starnet.engine-floor/1';
export const MIRRORS = Object.freeze({ tauri: 'src-tauri/tauri.conf.json', bootguard: 'frontend/app/bootguard.js' });
const VERSION = /^\d+\.\d+$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** -1 / 0 / 1 for dotted versions ('15.4' < '16.0'). */
export function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** 'Array.prototype.at' → member of Array.prototype; 'AbortSignal.timeout' → static of AbortSignal; 'OffscreenCanvas' → global. */
export function splitPath(path) {
  const parts = String(path || '').split('.');
  if (!parts.length || !parts.every(p => IDENT.test(p))) return null;
  if (parts.length === 1) return { kind: 'global', owner: '', key: parts[0] };
  if (parts.length === 2 && parts[1] !== 'prototype') return { kind: 'static', owner: parts[0], key: parts[1] };
  if (parts.length === 3 && parts[1] === 'prototype') return { kind: 'member', owner: parts[0] + '.prototype', key: parts[2] };
  return null;
}

export const floorApis = t => t.features.filter(f => f.kind === 'api' && cmpVersion(f.since, t.safari) === 0);
export const postFloorApis = t => t.features.filter(f => f.kind === 'api' && cmpVersion(f.since, t.safari) > 0);
export const postFloorSyntax = t => t.features.filter(f => f.kind === 'syntax' && cmpVersion(f.since, t.safari) > 0);

export function validate(t) {
  const bad = m => { throw new Error('scripts/lib/engine-floor.json: ' + m); };
  if (!t || t.schema !== SCHEMA) bad('schema is not ' + SCHEMA);
  for (const k of ['safari', 'macos', 'macosWithFloor']) if (!VERSION.test(String(t[k]))) bad(k + ' is not a version such as 15.4: ' + JSON.stringify(t[k]));
  if (!Array.isArray(t.features) || !t.features.length) bad('it lists no features');
  const ids = new Set();
  for (const f of t.features) {
    if (!f || typeof f.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(f.id)) bad('a feature id must be kebab-case: ' + JSON.stringify(f));
    if (ids.has(f.id)) bad('the feature id ' + f.id + ' is listed twice');
    ids.add(f.id);
    if (!VERSION.test(String(f.since))) bad(f.id + ': since is not a Safari version');
    if (f.kind === 'syntax') {
      if (typeof f.pattern !== 'string' || !f.pattern) bad(f.id + ': a syntax feature needs a pattern');
      try { new RegExp(f.pattern, 'g'); } catch (e) { bad(f.id + ': the pattern does not compile: ' + e.message); }
      if (cmpVersion(f.since, t.safari) <= 0) bad(f.id + ': syntax at or below the floor is no rule; drop it');
    } else if (f.kind === 'api') {
      if (!splitPath(f.path)) bad(f.id + ': path must be Global, Owner.member or Owner.prototype.member: ' + JSON.stringify(f.path));
      if (cmpVersion(f.since, t.safari) < 0) bad(f.id + ': an api below the floor defines nothing; drop it');
    } else bad(f.id + ': kind must be syntax or api');
  }
  if (!floorApis(t).length) bad('no api feature has since = the floor, so nothing defines it (bootguard would have nothing to probe)');
  return t;
}

export function readFloor(file = TABLE) { return validate(JSON.parse(readFileSync(file, 'utf8'))); }

export function syntaxRules(t) {
  return postFloorSyntax(t).map(f => ({ id: f.id, since: f.since, name: f.id + ' (Safari ' + f.since + '+)', re: new RegExp(f.pattern, 'g') }));
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOST = '(?:(?:window|globalThis|self)\\??\\.)?';
/* An API newer than the floor, lexically: `use` finds each place the page reaches for it, `guard` each typeof (or `in`)
   check of the same API. test/webkit-floor-syntax.test.js passes a use only inside a guard or with one just before it. */
export function apiRules(t) {
  return postFloorApis(t).map(f => {
    const p = splitPath(f.path), k = esc(p.key);
    let use, guard;
    if (p.kind === 'member') {
      use = '\\.' + k + '(?![\\w$])';
      guard = 'typeof\\s*\\(?\\s*[\\w$.?\\[\\]\'"]*\\.' + k + '(?![\\w$])|[\'"]' + k + '[\'"]\\s+in\\b';
    } else if (p.kind === 'static') {
      const o = esc(p.owner);
      use = '(?<![\\w$])' + o + '\\??\\.' + k + '(?![\\w$])';
      guard = 'typeof\\s*\\(?\\s*' + HOST + o + '\\??\\.' + k + '(?![\\w$])|[\'"]' + k + '[\'"]\\s+in\\s+' + HOST + o + '(?![\\w$])';
    } else {
      use = '(?<![\\w$])' + k + '(?![\\w$])';
      guard = 'typeof\\s*\\(?\\s*' + HOST + k + '(?![\\w$])|[\'"]' + k + '[\'"]\\s+in\\s+(?:window|globalThis|self)(?![\\w$])';
    }
    return { id: f.id, since: f.since, path: f.path, name: f.path + ' (Safari ' + f.since + '+)', use: new RegExp(use, 'g'), guard: new RegExp(guard, 'g') };
  });
}

/* The WebKit floor shim (an init script): before any page script, delete every API newer than the floor, then publish
   what it did as window.__STARNET_FLOOR_SHIM__ ({ floor, removed, absent, kept }). `kept` names an API it could not
   delete, which makes the floor run untrustworthy (the harness goes red on it). ES5 on purpose. */
export function shimSource(t) {
  const del = postFloorApis(t).map(f => { const p = splitPath(f.path); return [f.id, p.owner, p.key]; });
  return [
    '(function (floor, del) {',
    '  var removed = [], absent = [], kept = [], has = Object.prototype.hasOwnProperty;',
    '  for (var i = 0; i < del.length; i++) {',
    '    var id = del[i][0], owner = del[i][1], key = del[i][2], o = globalThis;',
    '    try {',
    '      if (owner) { var parts = owner.split("."); for (var j = 0; j < parts.length && o != null; j++) o = o[parts[j]]; }',
    '      if (o == null || !has.call(o, key)) { absent.push(id); continue; }',
    '      if (delete o[key] && !has.call(o, key)) removed.push(id); else kept.push(id);',
    '    } catch (e) { kept.push(id); }',
    '  }',
    '  try { Object.defineProperty(globalThis, "__STARNET_FLOOR_SHIM__", { value: Object.freeze({ floor: floor, removed: removed, absent: absent, kept: kept }), configurable: true }); } catch (e) {}',
    '})(' + JSON.stringify(t.safari) + ', ' + JSON.stringify(del) + ');',
    ''
  ].join('\n');
}

/* bootguard.js mirrors the floor as one literal line and one probe table; these read them back. */
export function readFloorLiteral(src) {
  const m = /\bconst FLOOR = Object\.freeze\(\{([^}]*)\}\)/.exec(String(src || ''));
  if (!m) return null;
  const out = {};
  for (const kv of m[1].matchAll(/(\w+):\s*'([^']*)'/g)) out[kv[1]] = kv[2];
  return out;
}
export function readProbeNames(src) {
  const block = /\bconst FLOOR_PROBES = \[([\s\S]*?)\n\s*\];/.exec(String(src || ''));
  return block ? [...block[1].matchAll(/^\s*\[\s*'([^']+)'\s*,/gm)].map(m => m[1]) : [];
}

/** Every way a mirror disagrees with the table, each naming its file and the floor's value. [] = all agree. */
export function mirrorDrift({ root, table = readFloor() } = {}) {
  const problems = [];
  let tauri = null;
  try { tauri = JSON.parse(readFileSync(join(root, MIRRORS.tauri), 'utf8')); } catch (e) { problems.push(MIRRORS.tauri + ' could not be read: ' + e.message); }
  if (tauri) {
    const min = tauri.bundle && tauri.bundle.macOS && tauri.bundle.macOS.minimumSystemVersion;
    if (min !== table.macos) problems.push(MIRRORS.tauri + ' bundle.macOS.minimumSystemVersion is ' + JSON.stringify(min) + '; the engine floor is macOS "' + table.macos + '"');
  }
  let src = '';
  try { src = readFileSync(join(root, MIRRORS.bootguard), 'utf8'); } catch (e) { problems.push(MIRRORS.bootguard + ' could not be read: ' + e.message); }
  if (src) {
    const lit = readFloorLiteral(src);
    if (!lit) problems.push(MIRRORS.bootguard + ' carries no FLOOR literal (const FLOOR = Object.freeze({ safari: \'' + table.safari + '\', macos: \'' + table.macos + '\', macosWithFloor: \'' + table.macosWithFloor + '\' }))');
    else for (const k of ['safari', 'macos', 'macosWithFloor']) {
      if (lit[k] !== table[k]) problems.push(MIRRORS.bootguard + ' FLOOR.' + k + ' is ' + JSON.stringify(lit[k] === undefined ? null : lit[k]) + '; the engine floor says "' + table[k] + '"');
    }
    const have = readProbeNames(src), want = floorApis(table).map(f => f.path);
    if (have.join('|') !== want.join('|')) problems.push(MIRRORS.bootguard + ' FLOOR_PROBES are [' + have.join(', ') + ']; the engine floor is defined by [' + want.join(', ') + ']');
  }
  return problems;
}

/** Throws when a mirror drifted (stage-frontend-dist.mjs runs this before staging anything). */
export function assertEngineFloor({ root, table = readFloor() } = {}) {
  const problems = mirrorDrift({ root, table });
  if (problems.length) {
    throw new Error('the web-engine floor is declared in more than one place and they disagree:\n  - ' + problems.join('\n  - ') +
      '\nscripts/lib/engine-floor.json is the one floor (Safari ' + table.safari + ', macOS ' + table.macos + '): set the named file back to it,' +
      ' or move the floor in that table (a decision for Andrew) and then every mirror it names.');
  }
  return { safari: table.safari, macos: table.macos, probes: floorApis(table).map(f => f.path) };
}
