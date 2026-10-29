/* sidecar/host-path-scrub.js — A CHAT IS NEVER SHOWN AN ABSOLUTE HOST PATH (run-paths lane, review round 3, 2026-10-28).

   A project-scoped run is told where a saved file is by its absolute path in the agent's private workspace, and a model
   echoes it; a routine digest, a channel.send, a loop notice or a notifier ping can carry one too. Round 2 cut the
   workspaces root in three of the hubs only, per chunk AFTER chunking (a path cut at a chunk boundary went out whole in
   two halves), and only as literally spelled. This module is the ONE outbound scrub: index.js wraps every live channel
   adapter's send / editMessage / answerCallback in place (guardOutbound), so the hubs, channel.send, a routine
   delivery, the notifier, a loop notice and a step-in nudge all reach the wire through it, and every caller that
   chunks (the hubs, channel.send, a routine delivery) scrubs the WHOLE text before it chunks.

   For each prefix (the workspaces root, its real path, its other spellings: hostPathForms) a match is:
     - the segments with ANY separator run between them (\ / \\ //, JSON-escaped), any case. A separator is also one
       of the characters a localized Windows SHOWS for '\' (the yen and won signs of a Japanese or Korean code page and
       their fullwidth forms) or a model writes for one (the fullwidth solidi, set minus, the reverse solidus operator,
       the small reverse solidus) (review round 4, minor-3);
     - a drive segment is its letter and then ':' , an admin share's '$' (\\localhost\c$\…) or the legacy file-URL
       pipe (file:///C|/…), each as written or percent-encoded;
     - each character as written OR percent-encoded (C%3A%5CUsers, work%73paces; a space also as '+');
     - on a Windows path, each segment also by its 8.3 short name (WORKSP~1, or the hashed WO1A2B~1 form);
     - followed by an end that is not a longer name: (?![\w-]|\.[\w-]) (a separator passes it). So the root at a
       sentence's end ("…\workspaces.") is cut, and another folder ("…\workspaces-old", "…\workspaces.bak") is not.
       The tail is a lookahead (review round 4): the separators after the root stay in the text as written and are
       scanned again, so a second spelling right behind the first ("<root>/c/Users/…") is cut too.
   LINEAR TIME (review round 4, MAJOR-1). A form that starts with a separator (/c/…, /mnt/c/…, /cygdrive/c/…, a
   \\localhost\c$ share) begins with sep+, so on a long run of separators every start inside the run re-scanned the
   rest of it: 64,000 '/' blocked the event loop for 17 s through hub.deliver, and again on every outbox retry. Such a
   form may not start right after a separator ((?<!sep), so only the first separator of a run starts it, which is where
   the leftmost match began anyway: the output is unchanged). And a text longer than LONG_TEXT is scrubbed in windows
   of CHUNK characters that overlap by the longest a form can be spelled (OVERLAP_PER_CHAR per character, every one
   percent-encoded), so the cost stays linear in the text whatever the pattern does, and a path across a window edge
   is still cut whole.
   A match becomes a readable placeholder, the separators after it kept as written, never nothing: `cd <root>\alpha && npm test`
   reads `cd [workspace]\alpha && npm test` (round 2 deleted it to `cd  && npm test`). The placeholder is in square
   brackets, never angle brackets: Slack reads <…> as a control sequence (a link, a mention; review round 4, minor-7).
   It names no prefix, so scrubbing it again is a no-op.

   FAIL CLOSED: the fixed prefixes the scrub was built with are always scrubbed; a live prefix list that throws loses
   only its extra spellings, and the failure is noted. Pure apart from that note: no fs, no clock (the host hands in
   realpath).

     makeHostPathScrub({ fixed: string[], prefixes?: () => string[], longText?, chunk? }) -> scrub(text) -> text
                                                      (idempotent; longText / chunk: the window bounds, for tests)
     hostPathForms(root, { realpath?, env? }) -> string[]   the root, its real path, their /c/, /mnt/c/, /cygdrive/c/
                                                      and admin-share forms, and the %VAR% / $env:VAR / $VAR / ~ forms
                                                      of the environment variables that prefix them (env: process.env
                                                      when absent, null for none)
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
// a separator: \ and /, as written or percent-encoded, and what a localized Windows shows or a model writes for '\':
// the yen and won signs, fullwidth yen and won, fullwidth \ and /, set minus, reverse solidus operator, small \
const SEP = '(?:[\\\\/\\u00A5\\u20A9\\uFFE5\\uFFE6\\uFF3C\\uFF0F\\u2216\\u29F5\\uFE68]|%5[Cc]|%2[Ff])';
// what follows a drive letter: its colon, an admin share's '$' (\\localhost\c$\…), the legacy file-URL pipe (file:///C|/)
const DRIVE = '(?::|%3[Aa]|\\$|%24|\\||%7[Cc])';

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
// a drive path, one of its POSIX-shell spellings, an admin share, or an environment / tilde form of one: their path
// segments may be 8.3 names
const WINDOWS_LIKE = /^(?:[A-Za-z]:|[\\/](?:mnt[\\/]|cygdrive[\\/])?[A-Za-z](?:[\\/]|$)|[\\/]{2}[^\\/]+[\\/][A-Za-z]:|%[^%\\/]+%|\$\{?(?:env:)?[A-Za-z_]\w*\}?|~(?:[\\/]|$))/i;

function prefixRe(root) {
  const short = WINDOWS_LIKE.test(root);
  const share = /^[\\/]{2}/.test(root);
  const body = root.split(/[\\/]+/).map((seg, i) => {
    if (!seg) return '';
    if (/^[A-Za-z]:$/.test(seg)) return charRe(seg[0]) + DRIVE;
    // the first segment (a drive, a variable, ~) and a share's host are names, never 8.3 folder names
    if (!short || i === 0 || (share && i === 1)) return literalRe(seg);
    const s = shortRe(seg);
    return s ? '(?:' + literalRe(seg) + '|' + s + ')' : literalRe(seg);
  }).join(SEP + '+');
  // a separator-led form never starts INSIDE a separator run (linear time, MAJOR-1); file:///C:/… is a drive form
  return /^[\\/]/.test(root) ? '(?<!' + SEP + ')' + body : body;
}
// the end of the root: not a longer name. A lookahead, so the separators after it stay in the text and are scanned again
const TAIL = '(?![\\w-]|\\.[\\w-])';
/* The ONE pattern for a prefix list (longest first). The forms are grouped by how they start, each group behind one
   cheap guard: the separator-led forms behind (?<!sep)(?=sep), every other group behind its first character as written
   or encoded. A position that starts no form costs one check per group, not one per form (the environment adds dozens
   of forms), and the order within a group is kept. */
function patternFor(list) {
  const groups = [], byLead = new Map();
  for (const f of list) {
    const first = Array.from(f)[0];
    const lead = /^[\\/]/.test(f) ? '' : first.toLowerCase();
    let g = byLead.get(lead);
    if (!g) { g = { lead, firsts: [], alts: [] }; byLead.set(lead, g); groups.push(g); }
    if (g.firsts.indexOf(first) < 0) g.firsts.push(first);
    g.alts.push(prefixRe(f));
  }
  const guard = (g) => (g.lead ? '(?=' + g.firsts.map(charRe).join('|') + ')' : '(?<!' + SEP + ')(?=' + SEP + ')');
  return new RegExp('(?:' + groups.map(g => guard(g) + '(?:' + g.alts.join('|') + ')').join('|') + ')' + TAIL, 'gi');
}
const LONG_TEXT = 200000, CHUNK = 65536, OVERLAP_PER_CHAR = 9;   // 9: one character as three percent-encoded UTF-8 bytes

/* A long text in bounded windows. A match must START inside [pos, pos + chunk); the window reaches `over` further, so
   a match that starts before its edge is seen whole. A match that touches the window's end may run on past it (its
   tail lookahead saw the window's end, not the text): the next window starts at it instead, unless it already starts
   the window (then it is longer than any spelling of a form, and is taken as found). */
function scrubWindows(text, re, chunk, over) {
  let out = '', pos = 0;
  const n = text.length;
  while (pos < n) {
    const stop = Math.min(n, pos + chunk), end = Math.min(n, stop + over);
    const win = text.slice(pos, end);
    let last = 0, resume = -1, m;
    re.lastIndex = 0;
    while ((m = re.exec(win)) !== null) {
      if (pos + m.index >= stop) break;
      const mEnd = m.index + m[0].length;
      if (end < n && mEnd + 2 > win.length && m.index > 0) { resume = m.index; break; }
      out += win.slice(last, m.index) + PLACEHOLDER;
      last = mEnd;
    }
    re.lastIndex = 0;
    const adv = resume > 0 ? resume : Math.max(last, stop - pos);
    out += win.slice(last, adv);
    pos += adv;
  }
  return out;
}

// every prefix with its shell spellings (hostPathForms without realpath), trailing separators dropped. env: the
// environment its variable forms come from (null: none, so a per-call pass never re-reads the environment)
function cleanList(list, env) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) {
    for (const form of hostPathForms(String(r == null ? '' : r), { env: env || null })) {
      const root = form.replace(/[\\/]+$/, '');
      if (root.length >= 4 && out.indexOf(root) < 0) out.push(root);
    }
  }
  return out;
}

function makeHostPathScrub(o) {
  o = o || {};
  // the fixed roots' environment forms are read once, here (o.env: the environment, process.env when absent)
  const fixed = cleanList(o.fixed, o.env === undefined ? processEnv() : o.env);
  const live = typeof o.prefixes === 'function' ? o.prefixes : null;
  const longText = Number(o.longText) > 0 ? Number(o.longText) : LONG_TEXT;
  const chunk = Number(o.chunk) > 0 ? Number(o.chunk) : CHUNK;
  let key = null, re = null, over = 0, lastExtra = null, list = [];
  return function scrub(text) {
    if (typeof text !== 'string' || !text) return text;
    let extra = [];
    if (live) {
      try { extra = live() || []; }
      catch (e) { failNote('hostpaths.prefixes', e); extra = []; }   // fail closed: the fixed prefixes still apply
    }
    const ek = Array.isArray(extra) ? extra.map(String).join('\n') : '';
    if (ek !== lastExtra) { list = cleanList(fixed.concat(Array.isArray(extra) ? extra : []), null).sort((a, b) => b.length - a.length); lastExtra = ek; }
    if (!list.length) return text;
    const k = list.join('\n');
    if (k !== key) { re = patternFor(list); key = k; over = list[0].length * OVERLAP_PER_CHAR + 64; }
    if (text.length > longText) return scrubWindows(text, re, chunk, over);
    return text.replace(re, PLACEHOLDER);
  };
}

/* The spellings of ONE root a chat could be shown: as configured, its real path (a junctioned or symlinked data folder
   is named by its target in a tool's output), and for a drive path the Git Bash (/c/…), WSL (/mnt/c/…) and Cygwin
   (/cygdrive/c/…) forms a shell prints and the machine's own admin share (\\localhost\c$\…, \\127.0.0.1\c$\…,
   \\<COMPUTERNAME>\c$\…; \\?\UNC\localhost\c$\… holds the first). Then the environment's spellings (review round 4,
   minor-3): for each variable whose value really prefixes one of those forms, %VAR%\…, $env:VAR\…, ${env:VAR}\…,
   $VAR/… and ${VAR}/… (USERPROFILE, HOME and %HOMEDRIVE%%HOMEPATH% also as ~/…). o.env: the environment (process.env
   when absent, null for none). o.realpath may throw; the root's other spellings are returned anyway. */
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
  const env = o.env === undefined ? processEnv() : o.env;
  const hosts = ['localhost', '127.0.0.1'];
  const machine = env && typeof env === 'object' && typeof env.COMPUTERNAME === 'string' ? env.COMPUTERNAME.trim() : '';
  if (/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(machine)) hosts.push(machine);
  for (const p of out.slice()) {
    const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(p);
    if (!m) continue;
    const rest = m[2].split(/[\\/]+/).filter(Boolean).join('/');
    const tail = rest ? '/' + rest : '';
    const d = m[1].toLowerCase();
    for (const pre of ['/' + d, '/mnt/' + d, '/cygdrive/' + d]) add(pre + tail);
    for (const h of hosts) add('//' + h + '/' + d + ':' + tail);   // prefixRe reads the ':' as ':', '$' or '|'
  }
  if (env && typeof env === 'object') for (const f of envForms(out.slice(), env)) add(f);
  return out;
}

function processEnv() { return typeof process === 'object' && process && process.env ? process.env : null; }

// the %VAR% / $env:VAR / $VAR / ~ spellings of the forms, from the variables whose value prefixes one at a segment edge
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function envForms(forms, env) {
  const norm = (s) => String(s).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const pairs = [], homes = [];
  let keys = [];
  try { keys = Object.keys(env); } catch (e) { failNote('hostpaths.env', e); return []; }
  for (const k of keys) {
    if (!ENV_NAME.test(k)) continue;
    const raw = env[k];
    if (typeof raw !== 'string' || raw.length > 1024 || /[;\r\n]/.test(raw)) continue;
    const v = norm(raw.trim());
    if (v.length < 2 || !/^(?:[A-Za-z]:|\/)/.test(v)) continue;   // a drive path, a rooted or a POSIX path
    pairs.push([['%' + k + '%', '$env:' + k, '${env:' + k + '}', '$' + k, '${' + k + '}'], v]);
    if (/^(?:USERPROFILE|HOME)$/i.test(k)) homes.push(v);
  }
  const hd = env.HOMEDRIVE, hp = env.HOMEPATH;
  if (typeof hd === 'string' && typeof hp === 'string' && /^[A-Za-z]:$/.test(hd.trim()) && /^[\\/]/.test(hp.trim())) {
    const v = norm(hd.trim() + hp.trim());
    pairs.push([['%HOMEDRIVE%%HOMEPATH%', '$env:HOMEDRIVE$env:HOMEPATH', '$HOMEDRIVE$HOMEPATH'], v]);
    homes.push(v);
  }
  for (const h of homes) pairs.push([['~'], h]);
  const out = [];
  for (const form of forms) {
    const f = norm(form);
    for (const [names, v] of pairs) {
      // a rooted value (HOMEPATH: \Users\me) prefixes a drive form without its drive
      const base = v[0] === '/' && /^[A-Za-z]:\//.test(f) ? f.slice(2) : f;
      const b = base.toLowerCase(), lv = v.toLowerCase();
      let rest = null;
      if (b === lv) rest = '';
      else if (b.indexOf(lv + '/') === 0) rest = base.slice(v.length);
      if (rest === null) continue;
      for (const n of names) out.push(n + rest);
    }
  }
  return out;
}

/* Wrap an adapter's outbound TEXT in place: send(chatId, text, opts), editMessage(chatId, messageId, text, opts),
   answerCallback(callbackId, text), sendMedia(chatId, item, opts), sendMediaGroup(chatId, items, opts) and
   setShortDescription(text). Every string the chat can see is scrubbed (review round 4, minor-4): the text, every string
   inside opts.reply_markup (an inline keyboard's labels and URLs, on a send and on an edit, or the whole keyboard when it
   is already JSON), a media item's caption and file name, each item of an album, and the bot's status line. Copies,
   never the caller's objects in place. In place on the ADAPTER, so every holder of it (its hub's send closure, the
   live-channel registry, a routine delivery) goes through the scrub. Idempotent. */
const guarded = new WeakSet();
function guardOutbound(adapter, scrub) {
  if (!adapter || typeof adapter !== 'object' || typeof scrub !== 'function' || guarded.has(adapter)) return adapter;
  const wrap = (name, fixes) => {
    const f = adapter[name];
    if (typeof f !== 'function') return;
    adapter[name] = function () {
      const args = Array.prototype.slice.call(arguments);
      for (const at of Object.keys(fixes)) if (Number(at) < args.length) args[at] = fixes[at](args[at]);
      return f.apply(adapter, args);
    };
  };
  const text = (t) => (typeof t === 'string' ? scrub(t) : t);
  // every string in a plain structure (arrays and plain objects, a bounded depth); anything else as it is
  const deep = (v, depth) => {
    if (typeof v === 'string') return scrub(v);
    if (!v || typeof v !== 'object' || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => deep(x, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const o = {};
    for (const k of Object.keys(v)) o[k] = deep(v[k], depth + 1);
    return o;
  };
  const opts = (o) => (o && typeof o === 'object' && o.reply_markup != null ? Object.assign({}, o, { reply_markup: deep(o.reply_markup, 0) }) : o);
  const media = (item) => {
    if (!item || typeof item !== 'object') return item;
    const out = Object.assign({}, item);
    if (typeof item.caption === 'string') out.caption = scrub(item.caption);
    if (typeof item.filename === 'string') out.filename = scrub(item.filename);
    return out;
  };
  wrap('send', { 1: text, 2: opts });
  wrap('editMessage', { 2: text, 3: opts });
  wrap('answerCallback', { 1: text });
  wrap('sendMedia', { 1: media, 2: opts });
  wrap('sendMediaGroup', { 1: (items) => (Array.isArray(items) ? items.map(media) : items), 2: opts });
  wrap('setShortDescription', { 0: text });
  guarded.add(adapter);
  return adapter;
}

module.exports = { makeHostPathScrub, hostPathForms, guardOutbound, PLACEHOLDER, _internals: { prefixRe, shortRe, charRe, patternFor } };
