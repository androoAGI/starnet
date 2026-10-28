'use strict';
/* test/helpers/fake-gmail.js — in-process FAKE Gmail IMAP + SMTP servers (plain TCP on 127.0.0.1) for the
   app-password connector tests. Never product code; no real Google account or network is used.

   IMAP: greeting, LOGIN, LIST (with \All / \Drafts special-use), EXAMINE, [UID] SEARCH (X-GM-RAW substring
   match, X-GM-MSGID, CHARSET UTF-8 with a synchronizing literal), [UID] FETCH (literals for every BODY item),
   APPEND (literal), LOGOUT. SMTP: EHLO, AUTH PLAIN, MAIL, RCPT, DATA (un-dot-stuffs), QUIT.
   `hang: true` accepts the TCP connection and never says a word (timeout tests). */
const net = require('node:net');

const CRLF = '\r\n';
function msg(lines) { return lines.join(CRLF); }

const DEFAULT_MESSAGES = [
  { uid: 101, msgid: '1790000000000000001', thrid: '1790000000000000001', flags: ['\\Seen'], labels: ['\\Inbox'], inbox: true,
    raw: msg(['From: Ann Example <ann@example.com>', 'To: me@example.com', 'Subject: Quarterly numbers', 'Date: Tue, 01 Sep 2026 09:00:00 +0000',
      'Message-ID: <a1@example.com>', 'Content-Type: text/plain; charset=UTF-8', '', 'Hi, the quarterly numbers are attached in the shared sheet.', '.leading dot line', '']) },
  { uid: 102, msgid: '1790000000000000002', thrid: '1790000000000000002', flags: [], labels: ['\\Inbox', '\\Important'], inbox: true,
    raw: msg(['From: =?UTF-8?B?w4lsb2RpZQ==?= <elodie@example.org>', 'To: me@example.com', 'Subject: =?UTF-8?Q?Caf=C3=A9_plans?=', 'Date: Wed, 02 Sep 2026 10:00:00 +0000',
      'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: multipart/alternative; boundary="b2"', '', '--b2',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Rendez-vous au caf=C3=A9 =E2=80=94 8pm.', '--b2',
      'Content-Type: text/html; charset=UTF-8', '', '<p>Rendez-vous</p>', '--b2--', '--b1',
      'Content-Type: application/pdf; name="menu.pdf"', 'Content-Disposition: attachment; filename="menu.pdf"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('%PDF-1.4 fake').toString('base64'), '--b1--', '']) },
  { uid: 103, msgid: '1790000000000000003', thrid: '1790000000000000002', flags: [], labels: ['\\Sent'], inbox: false,
    raw: msg(['From: me@example.com', 'To: Elodie <elodie@example.org>', 'Subject: Re: Café plans', 'Date: Wed, 02 Sep 2026 11:00:00 +0000',
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('<div>See you <b>there</b> &amp; bring the menu</div>').toString('base64'), '']) }
];

function startFakeImap(opts) {
  opts = opts || {};
  const user = opts.user || 'me@example.com';
  const pass = opts.pass || 'abcdefghijklmnop';
  const state = { logins: [], commands: [], appended: [], connections: 0, messages: (opts.messages || DEFAULT_MESSAGES).map(m => Object.assign({}, m)) };
  const sockets = new Set();
  const server = net.createServer(sock => {
    state.connections++; sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    if (opts.hang) return;
    sock.write('* OK Gimap ready for requests from 127.0.0.1 fake' + CRLF);
    let buf = Buffer.alloc(0), pending = null, authed = false, selected = null;
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (pending && pending.need != null) {
          if (buf.length < pending.need) return;
          pending.parts.push(buf.slice(0, pending.need)); buf = buf.slice(pending.need); pending.need = null;
          continue;
        }
        const nl = buf.indexOf(CRLF);
        if (nl < 0) return;
        const line = buf.slice(0, nl).toString('utf8'); buf = buf.slice(nl + 2);
        const lit = /\{(\d+)\}$/.exec(line);
        if (!pending) pending = { text: '', parts: [] };
        if (lit) { pending.text += line.slice(0, lit.index) + '\u0000'; pending.need = Number(lit[1]); sock.write('+ go ahead' + CRLF); continue; }
        pending.text += line;
        const cmd = pending; pending = null;
        handle(cmd.text, cmd.parts);
      }
    });
    function sectionsOf(mailbox) {
      if (/All Mail/i.test(mailbox)) return state.messages;
      if (/^INBOX$/i.test(mailbox)) return state.messages.filter(m => m.inbox);
      if (/Drafts/i.test(mailbox)) return state.appended.map((raw, i) => ({ uid: 1 + i, msgid: String(900 + i), thrid: String(900 + i), flags: ['\\Draft'], labels: [], raw }));
      return [];
    }
    function matches(m, q) {
      const hay = m.raw.toLowerCase();
      return String(q).toLowerCase().split(/\s+/).filter(Boolean).every(term => {
        const t = term.replace(/^(from|subject|to):/, '');
        return hay.includes(t) || hay.includes(t.normalize('NFC'));
      });
    }
    function lit(b) { b = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8'); return Buffer.concat([Buffer.from('{' + b.length + '}' + CRLF), b]); }
    function fetchOne(seq, m, items) {
      const out = [Buffer.from('* ' + seq + ' FETCH (UID ' + m.uid + ' X-GM-MSGID ' + m.msgid + ' X-GM-THRID ' + m.thrid +
        ' FLAGS (' + m.flags.join(' ') + ') INTERNALDATE "02-Sep-2026 10:00:00 +0000" RFC822.SIZE ' + Buffer.byteLength(m.raw))];
      if (/X-GM-LABELS/.test(items)) out.push(Buffer.from(' X-GM-LABELS (' + m.labels.map(l => '"' + l.replace(/\\/g, '\\\\') + '"').join(' ') + ')'));
      const rawBuf = Buffer.from(m.raw, 'utf8');
      const split = rawBuf.indexOf(CRLF + CRLF);
      const head = split < 0 ? rawBuf : rawBuf.slice(0, split + 2), text = split < 0 ? Buffer.alloc(0) : rawBuf.slice(split + 4);
      const hf = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/.exec(items);
      if (hf) {
        const want = hf[1].toLowerCase().split(' ');
        const lines = head.toString('utf8').split(CRLF).filter(l => want.includes(l.split(':')[0].toLowerCase()));
        out.push(Buffer.from(' BODY[HEADER.FIELDS (' + hf[1] + ')] '), lit(lines.join(CRLF) + CRLF + CRLF));
      }
      const tp = /BODY\.PEEK\[TEXT\]<0\.(\d+)>/.exec(items);
      if (tp) out.push(Buffer.from(' BODY[TEXT]<0> '), lit(text.slice(0, Number(tp[1]))));
      const bp = /BODY\.PEEK\[\]<0\.(\d+)>/.exec(items);
      if (bp) out.push(Buffer.from(' BODY[]<0> '), lit(rawBuf.slice(0, Number(bp[1]))));
      out.push(Buffer.from(')' + CRLF));
      return Buffer.concat(out);
    }
    function handle(text, parts) {
      state.commands.push(text.replace(/LOGIN .*/i, 'LOGIN <hidden>'));
      const m = /^(\S+) (.*)$/.exec(text);
      if (!m) return;
      const tag = m[1], rest = m[2];
      const ok = (t) => sock.write(tag + ' OK ' + (t || 'Success') + CRLF);
      if (opts.stallAfterLogin && authed) return;             // logged in, then silence (timeout mid-session)
      if (/^LOGIN /i.test(rest)) {
        const q = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/i.exec(rest);
        const u = q && q[1].replace(/\\(.)/g, '$1'), p = q && q[2].replace(/\\(.)/g, '$1');
        state.logins.push({ user: u, ok: u === user && p === pass });
        if (u === user && p === pass) { authed = true; return ok(user + ' authenticated (Success)'); }
        // Deliberately hostile: echoes the attempted password, so a test can prove the client never surfaces it.
        // opts.loginRefusal: one of Gmail's other worded refusals, in place of [AUTHENTICATIONFAILED].
        return sock.write(tag + ' NO ' + (opts.loginRefusal || '[AUTHENTICATIONFAILED] Invalid credentials (Failure)') + ' ' + (u || '') + ' ' + (p || '') + CRLF);
      }
      if (/^LOGOUT/i.test(rest)) { sock.write('* BYE LOGOUT Requested' + CRLF); ok('73 good day (Success)'); return sock.end(); }
      if (!authed) return sock.write(tag + ' BAD not authenticated' + CRLF);
      if (/^LIST /i.test(rest)) {
        sock.write('* LIST (\\HasNoChildren) "/" "INBOX"' + CRLF);
        sock.write('* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"' + CRLF);
        sock.write('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"' + CRLF);
        sock.write('* LIST (\\Drafts \\HasNoChildren) "/" "[Gmail]/Drafts"' + CRLF);
        return ok();
      }
      if (/^(EXAMINE|SELECT) /i.test(rest)) {
        selected = /^(?:EXAMINE|SELECT) "((?:[^"\\]|\\.)*)"/i.exec(rest)[1];
        sock.write('* ' + sectionsOf(selected).length + ' EXISTS' + CRLF + '* 0 RECENT' + CRLF);
        return ok('[READ-ONLY] ' + selected + ' selected. (Success)');
      }
      if (/^APPEND /i.test(rest)) {
        const raw = parts[0] ? parts[0].toString('utf8') : '';
        state.appended.push(raw);
        return ok('[APPENDUID 7 ' + state.appended.length + '] (Success)');
      }
      const box = sectionsOf(selected || '');
      if (/^UID SEARCH /i.test(rest)) {
        let hits = [];
        const gm = /X-GM-MSGID (\d+)/i.exec(rest);
        if (gm) hits = box.filter(x => x.msgid === gm[1]);
        else {
          const quoted = /X-GM-RAW "((?:[^"\\]|\\.)*)"/i.exec(rest);
          const q = quoted ? quoted[1].replace(/\\(.)/g, '$1') : (parts[0] ? parts[0].toString('utf8') : '');
          state.lastQuery = q;
          hits = box.filter(x => matches(x, q));
        }
        sock.write('* SEARCH' + hits.map(h => ' ' + h.uid).join('') + CRLF);
        return ok('SEARCH completed (Success)');
      }
      const fm = /^(UID )?FETCH (\S+) (.*)$/i.exec(rest);
      if (fm) {
        const items = fm[3];
        let rows = [];
        if (fm[1]) { const uids = fm[2].split(',').map(Number); rows = box.map((x, i) => [i + 1, x]).filter(([, x]) => uids.includes(x.uid)); }
        else { const [a, b] = fm[2].split(':').map(Number); rows = box.map((x, i) => [i + 1, x]).filter(([s]) => s >= a && s <= (b || a)); }
        // a real server may interleave an UNSOLICITED flag update (another client marked mail read)
        if (opts.unsolicited) sock.write('* 1 FETCH (FLAGS (\\Seen))' + CRLF);
        for (const [s, x] of rows) sock.write(fetchOne(s, x, items));
        return ok('Success');
      }
      sock.write(tag + ' BAD unknown command' + CRLF);
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ port: server.address().port, state, close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
  }));
}

function startFakeSmtp(opts) {
  opts = opts || {};
  const user = opts.user || 'me@example.com';
  const pass = opts.pass || 'abcdefghijklmnop';
  const state = { auths: [], sent: [], connections: 0 };
  const sockets = new Set();
  const server = net.createServer(sock => {
    state.connections++; sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    if (opts.hang) return;
    sock.write('220 smtp.fake.example ESMTP ready' + CRLF);
    let buf = '', inData = false, env = { from: '', rcpt: [] }, data = '';
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (inData) {
        const end = buf.indexOf(CRLF + '.' + CRLF);
        if (end < 0) return;
        data = buf.slice(0, end + 2); buf = buf.slice(end + 5); inData = false;
        state.sent.push({ from: env.from, rcpt: env.rcpt.slice(), data: data.split(CRLF).map(l => (l.startsWith('..') ? l.slice(1) : l)).join(CRLF), wire: data });
        sock.write('250 2.0.0 OK 1700000000 fake-queue-id' + CRLF);
      }
      let nl;
      while (!inData && (nl = buf.indexOf(CRLF)) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        if (/^EHLO /i.test(line)) sock.write('250-smtp.fake.example at your service' + CRLF + '250-SIZE 35882577' + CRLF + '250 AUTH LOGIN PLAIN' + CRLF);
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          state.auths.push({ user: u, ok: u === user && p === pass });
          sock.write(u === user && p === pass ? '235 2.7.0 Accepted' + CRLF
            : '535-5.7.8 Username and Password not accepted. For more information, go to' + CRLF + '535 5.7.8  https://support.google.com/mail/?p=BadCredentials fake' + CRLF);
        } else if (/^MAIL FROM:/i.test(line)) { env = { from: line.slice(10).replace(/[<>]/g, ''), rcpt: [] }; sock.write('250 2.1.0 OK' + CRLF); }
        else if (/^RCPT TO:/i.test(line)) {
          const r = line.slice(8).replace(/[<>]/g, '');
          if (opts.rejectRcpt && r === opts.rejectRcpt) sock.write('550 5.1.1 The email account that you tried to reach does not exist' + CRLF);
          else { env.rcpt.push(r); sock.write('250 2.1.5 OK' + CRLF); }
        }
        else if (/^DATA$/i.test(line)) { inData = true; sock.write('354 Go ahead' + CRLF); if (buf) sock.emit('data', Buffer.alloc(0)); }
        else if (/^QUIT$/i.test(line)) { sock.write('221 2.0.0 closing connection' + CRLF); sock.end(); }
        else sock.write('502 5.5.1 Unrecognized command' + CRLF);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ port: server.address().port, state, close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
  }));
}

module.exports = { startFakeImap, startFakeSmtp, DEFAULT_MESSAGES };
