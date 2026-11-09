/* sidecar/deskproof.js — THE DESK PROOF: a change that hands out lasting power needs more than the page token
   (GHSA-2hpj-9wm7-rvg5 #1, 2026-11-08).

   Why this exists. Every /api route takes the per-launch page token, and a same-user process can read the page the
   sidecar serves — including a command an agent was allowed to run. So the token alone used to be enough to switch
   on FULL BYPASS, answer a card with FULL ACCESS or ALWAYS, pre-approve a capability, raise an agent to full access,
   switch Remote on, make a pairing code or approve a phone. Those are the AUTHORITY changes: each one outlives the
   request and lets later work run without asking. Each now needs a one-time, server-issued confirmation bound to
   exactly that change, and in the desktop app that confirmation is a native dialog the Tauri shell shows and then
   reports with its own IPC token (main.rs starnet_desk_confirm), which no page and no child process ever holds.

   The flow (one round trip the page's fetch wrapper does for every caller, frontend/app/harness.js):
     1. the route sees no proof → it issues a challenge for this exact action + scope and answers
        403 desk_confirm_required { deskConfirm: { id, mode, title, summary, verb, expiresAt } };
     2. desktop ('desktop' mode): the page asks the shell to confirm; the shell shows the title/summary/verb in a
        blocking native dialog and, on yes, POSTs /api/desk/approve { id, title, summary, verb } with the IPC token.
        The words must equal the ones the station issued, so a page cannot show one thing and approve another;
        browser only ('page' mode, no desktop shell): the station cannot tell a browser from another local process,
        so a click proves nothing there. Each page challenge carries a DESK CODE, six digits the station prints only
        in its own console (the terminal it runs in, or over the IPC channel to the `starnet` terminal that started
        it) and never puts in any API body. The page asks the person to type it (fix-sec2, review 2);
     3. the page replays the request with X-StarNet-Desk-Proof: <id> (and X-StarNet-Desk-Code in page mode); the route
        consumes the challenge (single use, same action, same scope, unexpired, approved by the shell in desktop mode,
        the right code in page mode) before it changes anything. A wrong code burns the challenge, and after
        MAX_WRONG_CODES wrong codes a page-mode station takes no authority change until it restarts.

     const d = makeDeskProof({ desktop, ipcToken, now, randomBytes?, announce? })
     d.mode()                                    -> 'desktop' | 'page'
     d.issue({ action, scope, title, summary, verb }) -> public challenge (never a secret)
     d.approve({ id, title, summary, verb }, presentedIpcToken) -> { ok, reason? }   (desktop mode only)
     d.consume(id, action, scope, code?)         -> { ok, reason? }   single use; a mismatch burns the challenge
     d.locked()                                  -> true once MAX_WRONG_CODES wrong codes were typed (page mode)
     announce(note)                              page mode: shows the code where only the person at the station sees it.
                                                 note = { kind: 'code', id, label, title, verb, code, expiresAt }
                                                      | { kind: 'wrong', label, wrong, max } | { kind: 'locked', max }.
                                                 With no announce, a page challenge can never be confirmed.
     cleanWords(s, max)                          -> the dialog-safe text (no control characters but \n, capped)
     shortCode(id)                               -> the public label that matches a prompt to its printed code

   Pure apart from the injected clock and random source; no I/O. */
'use strict';
const nodeCrypto = require('node:crypto');

const TTL_MS = 2 * 60 * 1000;          // long enough to read a dialog, short enough that a stale one is useless
const MAX_OPEN = 32;                   // a flood of challenges evicts the oldest, never grows memory
const ID_RE = /^dc_[A-Za-z0-9_-]{16,64}$/;
const CAPS = Object.freeze({ title: 120, summary: 1200, verb: 40, scope: 2000, action: 64 });
const ACTIONS = Object.freeze(['bypass-on', 'consent-always', 'consent-full', 'grant', 'grant-import', 'approval-full',
  'remote-enable', 'remote-pair', 'device-activate', 'device-desk-permissions',
  // fix-sec2, review 3, 6 and 7: the authority changes the first pass left on the page token alone
  'consent-session', 'routine-grants', 'telegram-owner-pair', 'project-bless', 'hook-allow', 'plugin-allow', 'execution-profile',
  // fix-sec2, review2 #1: an owner code for Discord, Slack, Matrix, Signal or an agent's own Telegram bot
  'channel-owner-pair']);
const CODE_RE = /^\d{6}$/;
const MAX_WRONG_CODES = 5;              // a guesser gets five tries in a station's lifetime (one in 200,000), then nothing

// The shell refuses words with control characters (a dialog must show what was approved, nothing hidden), so the
// station never issues any: everything but \n becomes a space, runs of blank lines collapse, and the text is capped.
// The cap counts code points, as the shell does (main.rs desk_confirm_words_ok), and never splits one: a lone surrogate
// (a name cut through an emoji) cannot cross to the shell as JSON, so that confirmation could never be given (fix-sec2,
// review 12). One already lone in the input becomes U+FFFD.
function wholeText(s) {
  const t = String(s == null ? '' : s);
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < t.length && t.charCodeAt(i + 1) >= 0xDC00 && t.charCodeAt(i + 1) <= 0xDFFF) { out += t[i] + t[i + 1]; i++; }
    else if (c >= 0xD800 && c <= 0xDFFF) out += '\uFFFD';
    else out += t[i];
  }
  return out;
}
// cutPoints(s, max) -> at most `max` code points of s, never half of one
function cutPoints(s, max) { return Array.from(wholeText(s)).slice(0, Math.max(0, Number(max) || 0)).join(''); }
function cleanWords(s, max) {
  const t = wholeText(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
  const cps = Array.from(t);
  return cps.length > max ? cps.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…' : t;
}
function shortCode(id) { return String(id || '').replace(/^dc_/, '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase(); }
function constEq(a, b) {
  const x = nodeCrypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const y = nodeCrypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return !!String(b || '') && nodeCrypto.timingSafeEqual(x, y);
}

function makeDeskProof(deps) {
  const d = deps || {};
  if (typeof d.now !== 'function') throw new Error('makeDeskProof needs an injected clock (deps.now)');
  const now = d.now;
  const randomBytes = d.randomBytes || nodeCrypto.randomBytes;
  const ipcToken = String(d.ipcToken || '');
  const desktop = d.desktop === true && !!ipcToken;   // no shell token, no desktop proof: a bare sidecar is 'page' mode
  const announce = !desktop && typeof d.announce === 'function' ? d.announce : null;
  const open = new Map();
  let wrongCodes = 0;
  function tell(note) {
    if (!announce) return false;
    try { announce(note); return true; } catch (_) { return false; }   // a code nobody was shown confirms nothing
  }
  // six uniform digits (rejection sampling keeps every code equally likely)
  function deskCode() {
    let n = 0;
    for (let i = 0; i < 16; i++) { n = Buffer.from(randomBytes(4)).readUInt32BE(0); if (n < 4294000000) break; }
    return String(n % 1000000).padStart(6, '0');
  }

  function sweep() {
    const t = now();
    for (const [k, c] of open) if (c.expiresAt <= t) open.delete(k);
  }
  // never the desk code: `code` is the public label the printed code is shown beside; codeWhere says where to look
  function publicView(c) {
    const v = { id: c.id, action: c.action, mode: desktop ? 'desktop' : 'page', title: c.title, summary: c.summary, verb: c.verb,
      code: shortCode(c.id), expiresAt: c.expiresAt };
    if (!desktop) { v.codeWhere = c.shown ? 'station-console' : ''; if (wrongCodes >= MAX_WRONG_CODES) v.locked = true; }
    return v;
  }
  function issue(o) {
    const q = o || {};
    const action = String(q.action || '');
    if (ACTIONS.indexOf(action) < 0) throw new Error('unknown desk action: ' + action.slice(0, CAPS.action));
    sweep();
    while (open.size >= MAX_OPEN) open.delete(open.keys().next().value);
    const id = 'dc_' + Buffer.from(randomBytes(18)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const c = {
      id, action, scope: String(q.scope == null ? '' : q.scope).slice(0, CAPS.scope),
      title: cleanWords(q.title || 'StarNet — confirm', CAPS.title),
      summary: cleanWords(q.summary || '', CAPS.summary),
      verb: cleanWords(q.verb || 'Confirm', CAPS.verb),
      expiresAt: now() + TTL_MS,
      approved: false,
      secret: '', shown: false
    };
    if (!desktop && wrongCodes < MAX_WRONG_CODES) {
      c.secret = deskCode();
      c.shown = tell({ kind: 'code', id, label: shortCode(id), title: c.title, verb: c.verb, code: c.secret, expiresAt: c.expiresAt });
    }
    open.set(id, c);
    return publicView(c);
  }
  // desktop only: the shell's report that a person said yes in its native dialog, showing exactly these words
  function approve(o, presentedIpcToken) {
    if (!desktop) return { ok: false, reason: 'no-desktop' };
    if (!constEq(presentedIpcToken, ipcToken)) return { ok: false, reason: 'forbidden' };
    const q = o || {};
    const id = String(q.id || '');
    if (!ID_RE.test(id)) return { ok: false, reason: 'bad-id' };
    sweep();
    const c = open.get(id);
    if (!c) return { ok: false, reason: 'gone' };
    if (String(q.title) !== c.title || String(q.summary) !== c.summary || String(q.verb) !== c.verb) {
      open.delete(id);   // the dialog showed something else: this challenge is never good again
      return { ok: false, reason: 'words-differ' };
    }
    c.approved = true;
    return { ok: true };
  }
  function consume(id, action, scope, code) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return { ok: false, reason: key ? 'bad-id' : 'missing' };
    sweep();
    const c = open.get(key);
    if (!c) return { ok: false, reason: 'gone' };
    open.delete(key);   // single use, whatever the outcome: a proof is never tried twice
    if (c.action !== String(action || '') || c.scope !== String(scope == null ? '' : scope).slice(0, CAPS.scope)) return { ok: false, reason: 'mismatch' };
    if (desktop) return c.approved === true ? { ok: true } : { ok: false, reason: 'not-approved' };
    // page mode: the code the station showed only at its own console (fix-sec2, review 2)
    if (wrongCodes >= MAX_WRONG_CODES) return { ok: false, reason: 'locked' };
    if (!c.shown || !c.secret) return { ok: false, reason: 'no-code-shown' };
    const typed = String(code == null ? '' : code).replace(/\s+/g, '');
    if (!typed) return { ok: false, reason: 'code-missing' };
    if (!CODE_RE.test(typed) || !constEq(c.secret, typed)) {
      wrongCodes++;
      tell(wrongCodes >= MAX_WRONG_CODES ? { kind: 'locked', max: MAX_WRONG_CODES } : { kind: 'wrong', label: shortCode(c.id), wrong: wrongCodes, max: MAX_WRONG_CODES });
      return { ok: false, reason: wrongCodes >= MAX_WRONG_CODES ? 'locked' : 'wrong-code' };
    }
    return { ok: true };
  }
  return { mode: () => (desktop ? 'desktop' : 'page'), issue, approve, consume, locked: () => !desktop && wrongCodes >= MAX_WRONG_CODES, _open: open };
}

module.exports = { makeDeskProof, cleanWords, cutPoints, wholeText, shortCode, TTL_MS, MAX_OPEN, MAX_WRONG_CODES, ACTIONS, CAPS, ID_RE, CODE_RE };
