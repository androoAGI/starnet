'use strict';
/* sidecar/mcp/imap-client.js — a deliberately small IMAP4rev1 client on node:tls (no npm dependency).

   Exists for the Gmail app-password connector (transport.gmail-imap.js): just enough IMAP to log in, list
   mailboxes, open one read-only, search with Gmail's X-GM-RAW extension, fetch messages and APPEND a draft.

   One command in flight at a time. Responses are assembled byte-exactly: a line ending in a `{n}` literal marker
   pulls exactly n raw bytes before the response continues, so message bodies, CRLFs inside literals and non-UTF-8
   bytes survive intact. Every session has an idle timeout, an overall byte cap and a literal-size cap, and every
   exit path destroys the socket.

   SECRET HYGIENE: the password is written to the socket once (LOGIN) and is never stored on the session, echoed
   into an error, or logged. Server text is only surfaced for non-auth failures, and never for the LOGIN command. */

const { note: failNote } = require('../failopen.js');
const tls = require('node:tls');

class ImapError extends Error {
  constructor(message, kind, extra) {
    super(message);
    this.name = 'ImapError';
    this.kind = kind || 'protocol';   // 'auth' | 'timeout' | 'network' | 'protocol' | 'no' | 'bad' | 'limit' | 'input' | 'closed'
    if (extra) Object.assign(this, extra);
  }
}

const NUL = '\u0000';
const LIT_MARK = /\u0000L(\d+)\u0000/;

/* Why Gmail refused a login, as a fixed reason read from the server's reply WITHOUT surfacing the reply (it can echo
   the attempted user name). Gmail's IMAP and SMTP word the same refusals alike: "Application-specific password
   required", "Please log in via your web browser" / [WEBALERT], "not enabled for IMAP" / "IMAP access is disabled
   for your domain". Anything else (IMAP [AUTHENTICATIONFAILED], SMTP 535 5.7.8) is the address + password pair. */
function loginRefusal(text) {
  const t = String(text || '');
  if (/application-specific password/i.test(t)) return 'needs-app-password';
  if (/web ?browser|web ?login|WEBALERT/i.test(t)) return 'web-login';
  if (/not enabled for IMAP|\bIMAP\b[^.]*\bdisabled\b/i.test(t)) return 'imap-off';
  return 'credentials';
}

/* ---------- tokenizer: IMAP response text (with literal markers) -> nested arrays ---------- */
function tokenize(text, literals) {
  let i = 0;
  function list(close) {
    const out = [];
    for (;;) {
      while (text[i] === ' ') i++;
      if (i >= text.length) { if (close) throw new ImapError('IMAP response has an unclosed list', 'protocol'); return out; }
      const ch = text[i];
      if (ch === ')') { if (!close) throw new ImapError('IMAP response has an unexpected ")"', 'protocol'); i++; return out; }
      if (ch === '(') { i++; out.push(list(true)); continue; }
      if (ch === '"') {
        i++; let s = '';
        for (;;) {
          if (i >= text.length) throw new ImapError('IMAP response has an unterminated string', 'protocol');
          const c = text[i++];
          if (c === '\\') { s += text[i++] || ''; continue; }
          if (c === '"') break;
          s += c;
        }
        out.push(s); continue;
      }
      if (ch === NUL) {
        const m = LIT_MARK.exec(text.slice(i));
        if (!m || m.index !== 0) throw new ImapError('IMAP response has a damaged literal', 'protocol');
        out.push(literals[Number(m[1])]);
        i += m[0].length; continue;
      }
      // atom (may carry a [section ...] with spaces/parens, and a <partial> suffix)
      let s = '', depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (depth === 0 && (c === ' ' || c === ')' || c === '(' || c === NUL)) break;
        // a [section] only opens on BODY[ / BINARY[ (and their .PEEK/.SIZE forms) or a [response code] at the atom's
        // start: "[" is legal INSIDE an atom, so a flag or label like foo[ used to swallow the rest of the response and
        // fail the whole FETCH ("unclosed list") — one such message broke list_recent / search for the mailbox (10-03)
        if (c === '[' && (depth > 0 || s === '' || /^(?:BODY|BINARY)(?:\.PEEK|\.SIZE)?$/i.test(s))) depth++;
        else if (c === ']' && depth > 0) depth--;
        s += c; i++;
      }
      out.push(s.toUpperCase() === 'NIL' ? null : s);
    }
  }
  return list(false);
}

// `(KEY value KEY value ...)` -> { KEY: value } with upper-cased keys (FETCH attributes).
function pairs(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (let k = 0; k + 1 < arr.length; k += 2) out[String(arr[k]).toUpperCase()] = arr[k + 1];
  return out;
}

/* ---------- argument encoding ---------- */
function isPlainAscii(s) { return /^[\x20-\x7e]*$/.test(s); }
// An IMAP string argument: quoted when it is short printable ASCII, otherwise a literal (exact bytes).
function astring(value) {
  const s = String(value == null ? '' : value);
  if (s.length <= 512 && isPlainAscii(s)) return '"' + s.replace(/[\\"]/g, '\\$&') + '"';
  return { literal: Buffer.from(s, 'utf8') };
}
function quoted(value) {
  const s = String(value == null ? '' : value);
  if (!isPlainAscii(s)) throw new ImapError('IMAP value must be printable ASCII', 'input');
  return '"' + s.replace(/[\\"]/g, '\\$&') + '"';
}

/* ---------- session ---------- */
function openSession(opts) {
  opts = opts || {};
  const host = opts.host || 'imap.gmail.com';
  const port = opts.port || 993;
  const idleMs = Math.max(1000, Number(opts.timeoutMs) || 30000);
  const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || 16 * 1024 * 1024);
  const connect = typeof opts.connect === 'function' ? opts.connect
    : (o) => tls.connect({ host: o.host, port: o.port, servername: o.host, minVersion: 'TLSv1.2', rejectUnauthorized: true });

  return new Promise((resolveOpen, rejectOpen) => {
    let socket;
    try { socket = connect({ host, port }); }
    catch (_) { return rejectOpen(new ImapError('could not open a secure connection to ' + host, 'network')); }

    let buf = Buffer.alloc(0), received = 0, closed = false, tagN = 0;
    let segments = [], literals = [];          // the response being assembled
    let greeted = false, current = null, fatal = null;

    function fail(err) {
      if (fatal) return;
      fatal = err;
      closed = true;
      try { socket.destroy(); } catch (e) { failNote('mcp.imap.destroy', e); }
      if (!greeted) { greeted = true; rejectOpen(err); }
      if (current) { const c = current; current = null; c.reject(err); }
    }
    socket.setTimeout(idleMs, () => fail(new ImapError('the mail server did not respond in time', 'timeout')));
    socket.on('error', () => fail(new ImapError('the connection to the mail server failed', 'network')));
    socket.on('close', () => fail(new ImapError('the mail server closed the connection', 'closed')));
    socket.on('data', (chunk) => {
      if (fatal) return;
      received += chunk.length;
      if (received > maxBytes) return fail(new ImapError('the mail server response exceeded ' + Math.round(maxBytes / 1048576) + ' MiB; narrow the request', 'limit'));
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try { drain(); } catch (e) { fail(e instanceof ImapError ? e : new ImapError('unreadable response from the mail server', 'protocol')); }
    });

    function drain() {
      for (;;) {
        if (fatal) return;
        const nl = buf.indexOf('\r\n');
        if (nl < 0) {
          if (buf.length > 1024 * 1024) throw new ImapError('the mail server sent an over-long line', 'limit');
          return;
        }
        const line = buf.slice(0, nl).toString('utf8');
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (lit) {
          const n = Number(lit[1]);
          if (!Number.isSafeInteger(n) || n > maxBytes) throw new ImapError('the mail server announced a literal larger than the per-call cap', 'limit');
          if (buf.length < nl + 2 + n) return;            // wait for the whole literal
          segments.push(line.slice(0, lit.index));
          segments.push(NUL + 'L' + literals.length + NUL);
          literals.push(Buffer.from(buf.slice(nl + 2, nl + 2 + n)));
          buf = buf.slice(nl + 2 + n);
          continue;                                        // the response continues after the literal
        }
        segments.push(line);
        buf = buf.slice(nl + 2);
        const text = segments.join(''), lits = literals;
        segments = []; literals = [];
        dispatch(text, lits);
      }
    }

    function dispatch(text, lits) {
      if (!greeted) {
        greeted = true;
        if (/^\* (OK|PREAUTH)\b/i.test(text)) return resolveOpen(api);
        const e = new ImapError('the mail server refused the connection', 'protocol');
        fail(e); return;
      }
      if (text.startsWith('+')) {
        if (current && current.onContinue) { const f = current.onContinue; current.onContinue = null; f(); }
        return;
      }
      if (text.startsWith('* ')) {
        if (/^\* BYE\b/i.test(text) && !(current && current.logout)) return fail(new ImapError('the mail server ended the session', 'closed'));
        if (current) current.untagged.push({ text, tokens: tokenize(text.slice(2), lits) });
        return;
      }
      const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/i.exec(text);
      if (!m || !current || m[1] !== current.tag) return;   // stray/unsolicited — ignore
      const c = current; current = null;
      const status = m[2].toUpperCase();
      const rest = m[3] || '';
      const code = (/^\[([^\]]*)\]/.exec(rest) || [])[1] || '';
      if (status === 'OK') c.resolve({ untagged: c.untagged, code, text: rest });
      else c.reject(new ImapError(status === 'NO' ? 'the mail server declined the request' : 'the mail server rejected the command',
        status === 'NO' ? 'no' : 'bad', { code: code.toUpperCase(), serverText: c.quiet ? '' : rest.slice(0, 300), refusal: c.quiet ? loginRefusal(rest) : '' }));
    }

    function write(data) {
      if (closed) throw new ImapError('the mail session is closed', 'closed');
      socket.write(data);
    }

    // parts: strings and { literal: Buffer }. Synchronizing literals: wait for "+" before each literal's bytes.
    function command(parts, flags) {
      flags = flags || {};
      if (fatal) return Promise.reject(fatal);
      if (current) return Promise.reject(new ImapError('IMAP command already in flight', 'protocol'));
      const tag = 'S' + (++tagN);
      return new Promise((resolve, reject) => {
        current = { tag, resolve, reject, untagged: [], onContinue: null, quiet: !!flags.quiet, logout: !!flags.logout };
        const list = [tag].concat(parts);
        // After a literal's bytes the command line simply continues (" next-arg ..." or the final CRLF).
        const step = (k) => {
          let line = '';
          try {
            for (; k < list.length; k++) {
              const p = list[k], sep = k === 0 ? '' : ' ';
              if (p && typeof p === 'object' && Buffer.isBuffer(p.literal)) {
                write(line + sep + '{' + p.literal.length + '}\r\n');
                const next = k + 1, bytes = p.literal;
                if (current) current.onContinue = () => { try { write(bytes); step(next); } catch (e) { fail(e); } };
                return;
              }
              line += sep + p;
            }
            write(line + '\r\n');
          } catch (e) { fail(e instanceof ImapError ? e : new ImapError('could not write to the mail server', 'network')); }
        };
        step(0);
      });
    }

    async function login(user, pass) {
      try {
        // quiet: the server's reply to LOGIN is never surfaced (it can echo the attempted user name)
        await command(['LOGIN', quoted(user), quoted(pass)], { quiet: true });
      } catch (e) {
        if (e && (e.kind === 'no' || e.kind === 'bad')) throw new ImapError('login rejected', 'auth', { code: e.code, reason: e.refusal || 'credentials' });
        throw e;
      }
    }

    // LIST "" "*" -> [{ name, flags[] , delimiter }]
    async function list() {
      const r = await command(['LIST', '""', '"*"']);
      return r.untagged.filter(u => /^LIST$/i.test(String(u.tokens[0]))).map(u => {
        const flags = Array.isArray(u.tokens[1]) ? u.tokens[1].map(f => String(f)) : [];
        let name = u.tokens[3];
        if (Buffer.isBuffer(name)) name = name.toString('utf8');
        return { name: String(name == null ? '' : name), delimiter: u.tokens[2], flags };
      });
    }

    async function examine(mailbox) {
      const r = await command(['EXAMINE', astring(mailbox)]);
      let exists = 0;
      for (const u of r.untagged) if (/^EXISTS$/i.test(String(u.tokens[1]))) exists = Number(u.tokens[0]) || 0;
      return { exists };
    }

    // UID SEARCH ... -> number[]
    async function uidSearch(criteria) {
      const r = await command(['UID', 'SEARCH'].concat(criteria));
      const out = [];
      for (const u of r.untagged) if (/^SEARCH$/i.test(String(u.tokens[0]))) for (const t of u.tokens.slice(1)) { const n = Number(t); if (Number.isSafeInteger(n) && n > 0) out.push(n); }
      return out;
    }

    // FETCH (sequence set or UID set) -> [{ seq, attrs: {UID, ...} }]
    async function fetch(set, items, byUid) {
      if (!/^[0-9:,*]+$/.test(String(set))) throw new ImapError('invalid message set', 'input');
      const r = await command((byUid ? ['UID', 'FETCH'] : ['FETCH']).concat([String(set), items]));
      return r.untagged.filter(u => /^FETCH$/i.test(String(u.tokens[1]))).map(u => ({ seq: Number(u.tokens[0]), attrs: pairs(u.tokens[2]) }));
    }

    async function append(mailbox, flags, message) {
      const bytes = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
      const r = await command(['APPEND', astring(mailbox), '(' + flags.join(' ') + ')', { literal: bytes }]);
      const m = /APPENDUID (\d+) (\d+)/i.exec(r.code || '');
      return { uidValidity: m ? Number(m[1]) : null, uid: m ? Number(m[2]) : null };
    }

    async function logout() {
      if (fatal || closed) return;
      try { await command(['LOGOUT'], { logout: true }); } catch (e) { failNote('mcp.imap.logout', e); }
      close();
    }
    function close() {
      closed = true;
      if (!fatal) fatal = new ImapError('the mail session is closed', 'closed');
      try { socket.destroy(); } catch (e) { failNote('mcp.imap.close', e); }
      if (current) { const c = current; current = null; c.reject(fatal); }
    }

    const api = { command, login, list, examine, uidSearch, fetch, append, logout, close, get bytesReceived() { return received; } };
  });
}

module.exports = { openSession, tokenize, pairs, astring, quoted, ImapError, loginRefusal };
