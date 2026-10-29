/* sidecar/host-path-scrub.js — A CHAT IS NEVER SHOWN AN ABSOLUTE HOST PATH (run-paths lane, review round 3, 2026-10-28).

   A project-scoped run is told where a saved file is by its absolute path in the agent's private workspace, and a model
   echoes it; a routine digest, a channel.send, a loop notice or a notifier ping can carry one too. Round 2 cut the
   workspaces root in three of the hubs only, per chunk AFTER chunking (a path cut at a chunk boundary went out whole in
   two halves), and only as literally spelled. This module is the ONE outbound scrub: index.js wraps every live channel
   adapter's send / editMessage / answerCallback in place (guardOutbound), so the hubs, channel.send, a routine
   delivery, the notifier, a loop notice and a step-in nudge all reach the wire through it, and every caller that
   chunks (the hubs, channel.send, a routine delivery) scrubs the WHOLE text before it chunks.

   For each prefix (the workspaces root, its real path, its other spellings: hostPathForms) a match is:
     - the segments with ANY separator run between them (\ / \\ //, JSON-escaped), any case;
     - each character as written OR percent-encoded (C%3A%5CUsers, work%73paces; a space also as '+');
     - on a Windows path, each segment also by its 8.3 short name (WORKSP~1, or the hashed WO1A2B~1 form);
     - followed by a separator run, or by an end that is not a longer name: (?:sep+|(?![\w-]|\.[\w-])). So the
       root at a sentence's end ("…\workspaces.") is cut, and another folder ("…\workspaces-old", "…\workspaces.bak")
       is not.
   A match becomes a readable placeholder plus the separators as written, never nothing: `cd <root>\alpha && npm test`
   reads `cd [workspace]\alpha && npm test` (round 2 deleted it to `cd  && npm test`). The placeholder is in square
   brackets, never angle brackets: Slack reads <…> as a control sequence (a link, a mention; review round 4, minor-7).
   It names no prefix, so scrubbing it again is a no-op.

   FAIL CLOSED: the fixed prefixes the scrub was built with are always scrubbed; a live prefix list that throws loses
   only its extra spellings, and the failure is noted. Pure apart from that note: no fs, no clock (the host hands in
   realpath).

     makeHostPathScrub({ fixed: string[], prefixes?: () => string[] }) -> scrub(text) -> text   (idempotent)
     hostPathForms(root, { realpath? }) -> string[]   the root, its real path, and the /c/, /mnt/c/, /cygdrive/c/ forms
     guardOutbound(adapter, scrub) -> adapter         wraps the adapter's outbound text in place (idempotent)
     PLACEHOLDER                                      '[workspace]' */
'use strict';
const { note: failNote } = require('./failopen.js');

const PLACEHOLDER = '[workspace]';

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// a percent-encoded byte, its hex digits in either case
const pctRe = (hex) => '%' + hex.toUpperCase().replace(/[A-F]/g, (x) => '[' + x + x.toLowerCase() + ']');
const URI_UNRESERVED = /^[A-Za-z0-9\-_.!~*'()]$/;

// ONE character: as written, or percent-encoded (its UTF-8 bytes), a space also as '+'
function charRe(c) {
  const alts = [escapeRe(c)];
  let enc = '';
  if (URI_UNRESERVED.test(c)) enc = pctRe(c.charCodeAt(0).toString(16).padStart(2, '0'));
  else if (!/^[\uD800-\uDFFF]$/.test(c)) enc = encodeURIComponent(c).replace(/%([0-9A-Fa-f]{2})/g, (m, h) => pctRe(h));
  if (enc) alts.push(enc);
  if (c === ' ') alts.push('\\+');
  return alts.length === 1 ? alts[0] : '(?:' + alts.join('|') + ')';
}
const literalRe = (s) => Array.from(String(s)).map(charRe).join('');
const SEP = '(?:[\\\\/]|%5[Cc]|%2[Ff])';

// a Windows segment's 8.3 short names, when it has any: NAME~N (its first six legal characters) and the hashed form
// windows mints after the fourth collision (two characters, four hex digits, ~N), each with its 3-character extension
const SHORT_LEGAL = /^[A-Za-z0-9!#$%&'()@^_`{}~-]{1,8}(?:\.[A-Za-z0-9!#$%&'()@^_`{}~-]{1,3})?$/;
function shortRe(seg) {
  if (SHORT_LEGAL.test(seg)) return '';
  const dot = seg.lastIndexOf('.');
  const clean = (s) => s.toUpperCase().replace(/[\s.]/g, '').replace(/[^A-Z0-9!#$%&'()@^_`{}~-]/g, '_');
  const stem = clean(dot > 0 ? seg.slice(0, dot) : seg), ext = dot > 0 ? clean(seg.slice(dot + 1)).slice(0, 3) : '';
  if (!stem) return '';
  const tail = '~\\d{1,6}' + (ext ? '(?:\\.' + escapeRe(ext) + ')?' : '');
  return escapeRe(stem.slice(0, 6)) + tail + '|' + escapeRe(stem.slice(0, 2)) + '[0-9A-Fa-f]{4}' + tail;
}
// a drive path, or one of its POSIX-shell spellings: their segments may be 8.3 names
const WINDOWS_LIKE = /^(?:[A-Za-z]:|[\\/](?:mnt[\\/]|cygdrive[\\/])?[A-Za-z](?:[\\/]|$))/;

function prefixRe(root) {
  const short = WINDOWS_LIKE.test(root);
  return root.split(/[\\/]+/).map((seg, i) => {
    if (!seg) return '';
    if (!short || (i === 0 && /:$/.test(seg))) return literalRe(seg);
    const s = shortRe(seg);
    return s ? '(?:' + literalRe(seg) + '|' + s + ')' : literalRe(seg);
  }).join(SEP + '+');
}
const TAIL = '(' + SEP + '+|(?![\\w-]|\\.[\\w-]))';

// every prefix with its shell spellings (hostPathForms without realpath: pure), trailing separators dropped
function cleanList(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) {
    for (const form of hostPathForms(String(r == null ? '' : r))) {
      const root = form.replace(/[\\/]+$/, '');
      if (root.length >= 4 && out.indexOf(root) < 0) out.push(root);
    }
  }
  return out;
}

function makeHostPathScrub(o) {
  o = o || {};
  const fixed = cleanList(o.fixed);
  const live = typeof o.prefixes === 'function' ? o.prefixes : null;
  let key = null, re = null;
  return function scrub(text) {
    if (typeof text !== 'string' || !text) return text;
    let extra = [];
    if (live) {
      try { extra = live() || []; }
      catch (e) { failNote('hostpaths.prefixes', e); extra = []; }   // fail closed: the fixed prefixes still apply
    }
    const list = cleanList(fixed.concat(cleanList(extra))).sort((a, b) => b.length - a.length);
    if (!list.length) return text;
    const k = list.join('\n');
    if (k !== key) { re = new RegExp('(?:' + list.map(prefixRe).join('|') + ')' + TAIL, 'gi'); key = k; }
    return text.replace(re, (m, sep) => PLACEHOLDER + (sep || ''));
  };
}

/* The spellings of ONE root a chat could be shown: as configured, its real path (a junctioned or symlinked data folder
   is named by its target in a tool's output), and for a drive path the Git Bash (/c/…), WSL (/mnt/c/…) and Cygwin
   (/cygdrive/c/…) forms a shell prints. o.realpath may throw; the root's other spellings are returned anyway. */
function hostPathForms(root, o) {
  o = o || {};
  const out = [];
  const add = (r) => { const s = String(r || ''); if (s && out.indexOf(s) < 0) out.push(s); };
  const r = String(root || '').trim();
  if (!r) return out;
  add(r);
  if (typeof o.realpath === 'function') {
    try { add(o.realpath(r)); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('hostpaths.realpath', e); }
  }
  for (const p of out.slice()) {
    const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
    if (!m) continue;
    const rest = m[2].split(/[\\/]+/).filter(Boolean).join('/');
    const d = m[1].toLowerCase();
    for (const pre of ['/' + d, '/mnt/' + d, '/cygdrive/' + d]) add(pre + (rest ? '/' + rest : ''));
  }
  return out;
}

/* Wrap an adapter's outbound TEXT in place: send(chatId, text, …), editMessage(chatId, messageId, text, …),
   answerCallback(callbackId, text) and a media item's caption. In place, so every holder of the adapter (its hub's
   send closure, the live-channel registry, a routine delivery) goes through the scrub. Idempotent. */
const guarded = new WeakSet();
function guardOutbound(adapter, scrub) {
  if (!adapter || typeof adapter !== 'object' || typeof scrub !== 'function' || guarded.has(adapter)) return adapter;
  const wrap = (name, at, fix) => {
    const f = adapter[name];
    if (typeof f !== 'function') return;
    adapter[name] = function () {
      const args = Array.prototype.slice.call(arguments);
      args[at] = fix(args[at]);
      return f.apply(adapter, args);
    };
  };
  const text = (t) => (typeof t === 'string' ? scrub(t) : t);
  wrap('send', 1, text);
  wrap('editMessage', 2, text);
  wrap('answerCallback', 1, text);
  wrap('sendMedia', 1, (item) => (item && typeof item === 'object' && typeof item.caption === 'string' ? Object.assign({}, item, { caption: scrub(item.caption) }) : item));
  guarded.add(adapter);
  return adapter;
}

module.exports = { makeHostPathScrub, hostPathForms, guardOutbound, PLACEHOLDER, _internals: { prefixRe, shortRe, charRe } };
