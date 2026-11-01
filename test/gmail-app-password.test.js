/* node test/gmail-app-password.test.js — the Gmail app-password connector (IMAP + SMTP, no OAuth) against
   in-process FAKE servers (test/helpers/fake-gmail.js). No real Google account or network.
   Covers: credential parsing, the IMAP literal path (both directions), search/list/read/draft, SMTP send with
   dot-stuffing and Bcc kept out of the headers, auth failure (clear guidance, password never surfaced),
   timeouts, socket cleanup and the per-call caps. */
'use strict';
const A = require('./_assert.js');
const net = require('node:net');
const { startFakeImap, startFakeSmtp } = require('./helpers/fake-gmail.js');
const imap = require('../sidecar/mcp/imap-client.js');
const smtp = require('../sidecar/mcp/smtp-client.js');
const mail = require('../sidecar/mcp/mail-parse.js');
const G = require('../sidecar/mcp/transport.gmail-imap.js');

const USER = 'me@example.com', PASS = 'abcdefghijklmnop';
const tcp = (port, track) => () => { const s = net.connect({ host: '127.0.0.1', port }); if (track) track.push(s); return s; };

function rpc(t) {
  let n = 0; const got = new Map();
  t.onMessage(m => got.set(m.id, m));
  return async (method, params) => { const id = ++n; await t.send({ jsonrpc: '2.0', id, method, params }); return got.get(id); };
}
const textOf = r => r && r.result && r.result.content && r.result.content[0].text;

(async () => {
  /* A. credential: "address:password", spaces stripped, clear refusals */
  A.eq(G.normalizeCredential(' me@example.com : abcd efgh ijkl mnop '), 'me@example.com:abcdefghijklmnop', 'Google shows the password in groups of four; spaces are stripped');
  A.eq(G.normalizeCredential('Me@Example.com:ABCDEFGHIJKLMNOP'), 'Me@Example.com:abcdefghijklmnop', 'app passwords are case-folded');
  A.throws(() => G.parseCredential('me@example.com:hunter2'), 'a normal (non app) password shape is refused');
  A.throws(() => G.parseCredential('not-an-address:abcdefghijklmnop'), 'an address is required');
  A.throws(() => G.parseCredential('me@example.com\r\nX:abcdefghijklmnop'), 'CR/LF in the address is refused');
  A.throws(() => G.parseCredential(''), 'empty is refused');
  A.eq(G.passwordOf({ url: G.ENDPOINT, token: USER + ':' + PASS }), PASS, 'passwordOf feeds the known-secret list');
  A.eq(G.passwordOf({ url: 'https://example.com/mcp', token: USER + ':' + PASS }), '', 'other connectors are ignored');
  A.eq(G.productForUrl(G.ENDPOINT), 'gmail-app-password', 'exact endpoint match');
  A.eq(G.productForUrl(G.ENDPOINT + 'x'), null, 'no prefix matching');

  /* B. tokenizer: literals, quoted escapes, sections, NIL */
  const t = imap.tokenize('1 FETCH (UID 7 FLAGS (\\Seen) BODY[HEADER.FIELDS (FROM SUBJECT)] \u0000L0\u0000 X-GM-LABELS ("\\\\Inbox" "a \\"q\\"") ENV NIL)', [Buffer.from('From: x\r\n')]);
  const p = imap.pairs(t[2]);
  A.eq(p.UID, '7', 'atom value');
  A.eq(p.FLAGS, ['\\Seen'], 'flag list');
  A.ok(Buffer.isBuffer(p['BODY[HEADER.FIELDS (FROM SUBJECT)]']) && p['BODY[HEADER.FIELDS (FROM SUBJECT)]'].toString() === 'From: x\r\n', 'a section with spaces keeps its literal value byte-exact');
  A.eq(p['X-GM-LABELS'], ['\\Inbox', 'a "q"'], 'quoted strings unescape');
  A.eq(p.ENV, null, 'NIL is null');
  A.eq(imap.astring('plain'), '"plain"', 'short ASCII is quoted');
  A.ok(Buffer.isBuffer(imap.astring('café').literal), 'non-ASCII becomes a literal');

  /* C. MIME reader */
  const parsed = mail.parseMessage(Buffer.from(require('./helpers/fake-gmail.js').DEFAULT_MESSAGES[1].raw));
  A.eq(parsed.headers.subject, 'Café plans', 'RFC 2047 Q subject');
  A.ok(/^Élodie/.test(parsed.headers.from), 'RFC 2047 B sender name');
  A.eq(parsed.text, 'Rendez-vous au café — 8pm.', 'text/plain preferred, quoted-printable + UTF-8 decoded');
  A.eq(parsed.attachments, [{ filename: 'menu.pdf', mimeType: 'application/pdf', size: 13 }], 'attachment inventory, never bytes');
  const html = mail.parseMessage(Buffer.from(require('./helpers/fake-gmail.js').DEFAULT_MESSAGES[2].raw));
  A.eq(html.text, 'See you there & bring the menu', 'base64 html reduced to text');
  A.ok(mail.parseMessage(Buffer.from('Subject: x\r\nContent-Type: multipart/mixed; boundary=zz\r\n\r\n--zz\r\nContent-Type: text/plain\r\n\r\nhalf a mess')).text === 'half a mess', 'a truncated multipart still yields its text');

  /* D. connector against the fake servers */
  const im = await startFakeImap({ user: USER, pass: PASS });
  const sm = await startFakeSmtp({ user: USER, pass: PASS });
  const sockets = [];
  const make = (token, extra) => G.makeGmailImapTransport(Object.assign({ url: G.ENDPOINT, token, timeoutMs: 5000,
    imap: { connect: tcp(im.port, sockets) }, smtp: { connect: tcp(sm.port, sockets) }, now: () => Date.UTC(2026, 9, 2, 12), newId: () => 'fixed-id' }, extra || {}));
  try {
    const tr = make(USER + ':' + PASS); const call = rpc(tr);
    const init = await call('initialize', {});
    A.ok(init && init.result && init.result.capabilities.tools, 'initialize proves the login and returns MCP capabilities');
    A.eq((await call('tools/list')).result.tools.map(x => x.name), ['search_messages', 'list_recent', 'read_message', 'send_email', 'create_draft'], 'the tool set mirrors Gmail');

    const recent = JSON.parse(textOf(await call('tools/call', { name: 'list_recent', arguments: { maxResults: 5 } })));
    A.eq(recent.messages.map(m => m.subject), ['Café plans', 'Quarterly numbers'], 'list_recent: Inbox only, newest first');
    A.eq(recent.messages[0].id, BigInt('1790000000000000002').toString(16), 'ids are Gmail-style hex message ids');
    A.eq(recent.messages[0].unread, true, 'unread state from FLAGS');
    A.eq(recent.messages[1].snippet, 'Hi, the quarterly numbers are attached in the shared sheet. .leading dot line', 'snippet from the body prefix');

    const found = JSON.parse(textOf(await call('tools/call', { name: 'search_messages', arguments: { query: 'plans' } })));
    A.eq(found.messages.map(m => m.subject), ['Re: Café plans', 'Café plans'], 'X-GM-RAW search across All Mail, newest first');
    A.eq(found.totalMatches, 2, 'total match count');
    const before = im.state.commands.length;
    const uni = JSON.parse(textOf(await call('tools/call', { name: 'search_messages', arguments: { query: 'café' } })));
    A.eq(im.state.lastQuery, 'café', 'a non-ASCII query travels as a UTF-8 literal, byte-exact');
    A.ok(im.state.commands.slice(before).some(c => /CHARSET UTF-8 X-GM-RAW \u0000/.test(c)), 'the literal path was used (CHARSET + {n})');
    A.ok(uni.messages.length >= 1, 'the literal query matched');

    const read = JSON.parse(textOf(await call('tools/call', { name: 'read_message', arguments: { messageId: recent.messages[0].id } })));
    A.eq(read.subject, 'Café plans', 'read_message by id');
    A.eq(read.body, 'Rendez-vous au café — 8pm.', 'full decoded body');
    A.eq(read.labels, ['\\Inbox', '\\Important'], 'Gmail labels');
    A.eq(read.attachments[0].filename, 'menu.pdf', 'attachments listed');
    const leading = JSON.parse(textOf(await call('tools/call', { name: 'read_message', arguments: { messageId: recent.messages[1].id } })));
    A.ok(leading.body.includes('\n.leading dot line'), 'a body line starting with "." survives the literal read');
    const missing = await call('tools/call', { name: 'read_message', arguments: { messageId: 'ffff' } });
    A.ok(missing.result.isError && /No message with id ffff/.test(textOf(missing)), 'an unknown id is an honest tool error, not a crash');
    const bad = await call('tools/call', { name: 'read_message', arguments: { messageId: '../x' } });
    A.ok(bad.result.isError, 'a malformed id is refused before any network use');
    const badArgs = await call('tools/call', { name: 'list_recent', arguments: { maxResults: 5000 } });
    A.ok(badArgs.result.isError, 'maxResults is capped by the schema (per-call message cap)');

    const draft = JSON.parse(textOf(await call('tools/call', { name: 'create_draft', arguments: { to: ['Ann <ann@example.com>'], bcc: ['boss@example.com'], subject: 'Draft é', body: 'line one\n.dot line' } })));
    A.eq(draft.saved, true, 'create_draft APPENDs to Drafts');
    A.eq(draft.mailbox, '[Gmail]/Drafts', 'Drafts found by its \\Drafts special-use flag');
    const appended = im.state.appended[0];
    A.ok(/^From: me@example.com\r\nDate: Fri, 02 Oct 2026 12:00:00 \+0000\r\nMessage-ID: <fixed-id@example.com>\r\nTo: Ann <ann@example.com>\r\nBcc: boss@example.com\r\n/.test(appended), 'the draft is the shared MIME builder\'s message with From/Date/Message-ID (Bcc kept in a draft)');
    A.ok(/Subject: =\?UTF-8\?B\?/.test(appended), 'non-ASCII subject is RFC 2047 encoded by the shared builder');

    const injected = await call('tools/call', { name: 'send_email', arguments: { to: ['x@example.com'], subject: 'hi\r\nBcc: evil@example.com', body: 'x' } });
    A.ok(injected.result.isError && sm.state.sent.length === 0, 'header injection is refused before SMTP is touched');

    const sent = JSON.parse(textOf(await call('tools/call', { name: 'send_email', arguments: { to: ['Ann <ann@example.com>'], cc: ['cc@example.com'], bcc: ['hidden@example.com'], subject: 'Numbers', body: 'Hello\n.\n..two dots\nbye' } })));
    A.eq(sent.sent, true, 'send_email delivers over SMTP');
    A.eq(sent.accepted, ['ann@example.com', 'cc@example.com', 'hidden@example.com'], 'every recipient, including Bcc, is in the envelope');
    const wire = sm.state.sent[0];
    A.eq(wire.from, USER, 'MAIL FROM is the account');
    A.ok(!/hidden@example\.com/.test(wire.data), 'Bcc never appears in the delivered headers');
    A.ok(/^From: me@example.com\r\n/.test(wire.data) && /\r\nSubject: Numbers\r\n/.test(wire.data), 'headers present');
    const bodyB64 = wire.data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    A.eq(Buffer.from(bodyB64, 'base64').toString('utf8'), 'Hello\n.\n..two dots\nbye', 'the body round-trips exactly');
    A.ok(sm.state.auths[0].ok, 'AUTH PLAIN with the app password');
    A.eq(smtp.dotStuff('a\r\n.b\r\n..c\n.').toString(), 'a\r\n..b\r\n...c\r\n..\r\n.\r\n', 'dot-stuffing doubles every leading dot and normalizes CRLF');

    const rejecting = await startFakeSmtp({ user: USER, pass: PASS, rejectRcpt: 'nobody@example.com' });
    const tr2 = make(USER + ':' + PASS, { smtp: { connect: tcp(rejecting.port, sockets) } }); const call2 = rpc(tr2);
    const refused = await call2('tools/call', { name: 'send_email', arguments: { to: ['nobody@example.com'], subject: 's', body: 'b' } });
    A.ok(refused.result.isError && /nothing was sent/.test(textOf(refused)) && rejecting.state.sent.length === 0, 'a refused recipient is an honest "nothing was sent"');
    await rejecting.close();

    /* E. auth failure: clear guidance, the password never appears, no retry storm */
    const WRONG = 'zzzzyyyyxxxxwwww';
    const trBad = make(USER + ':' + WRONG); const callBad = rpc(trBad);
    let authErr = null; try { await callBad('initialize', {}); } catch (e) { authErr = e; }
    A.ok(authErr && authErr.authRejected === true, 'a rejected login is flagged authRejected (the manager stops retrying)');
    A.eq(authErr && authErr.message, G.AUTH_HELP.credentials, 'a wrong address/password pair gets the credentials fix');
    A.ok(authErr && /signed in to Google as this same address/.test(authErr.message) && /NEW APP PASSWORD/.test(authErr.message) && /2-Step Verification/.test(authErr.message) && /administrator may have turned app passwords off/.test(authErr.message), 'the error says exactly what to do: ' + (authErr && authErr.message));
    A.ok(!authErr.message.includes(USER), 'the address is never put in the error (it reaches logs and the model)');
    A.ok(authErr && !authErr.message.includes(WRONG) && !JSON.stringify(authErr).includes(WRONG), 'the attempted password is never surfaced, even though the server echoed it');
    A.eq(im.state.logins.filter(l => !l.ok).length, 1, 'exactly one failed login attempt');
    const smBad = await callBad('tools/call', { name: 'send_email', arguments: { to: ['a@example.com'], subject: 's', body: 'b' } }).catch(e => e);
    A.ok(smBad instanceof Error && smBad.authRejected && !smBad.message.includes(WRONG), 'an SMTP 535 maps to the same guidance');
    /* E2. each of Gmail's worded refusals gets its own fix, read from the reply WITHOUT surfacing it */
    A.eq(imap.loginRefusal('[AUTHENTICATIONFAILED] Invalid credentials (Failure)'), 'credentials', 'Gmail\'s live IMAP refusal (probed 10-27) = credentials');
    A.eq(imap.loginRefusal('[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)'), 'needs-app-password', 'account password instead of an app password');
    A.eq(imap.loginRefusal('[ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)'), 'web-login', 'Google paused the sign-in');
    A.eq(imap.loginRefusal('[WEBALERT https://accounts.google.com/x] Web login required.'), 'web-login', 'WEBALERT form');
    A.eq(imap.loginRefusal('[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page (Failure)'), 'imap-off', 'IMAP off for the account');
    A.eq(imap.loginRefusal('[ALERT] IMAP access is disabled for your domain. Please contact your domain administrator (Failure)'), 'imap-off', 'IMAP off by a Workspace admin');
    A.eq(imap.loginRefusal('5.7.8 Username and Password not accepted. For more information, go to https://support.google.com/mail/?p=BadCredentials'), 'credentials', 'SMTP 535 = credentials');
    A.eq(imap.loginRefusal('5.7.9 Application-specific password required. Learn more at https://support.google.com/mail/?p=InvalidSecondFactor'), 'needs-app-password', 'SMTP 534 5.7.9');
    for (const [reply, reason] of [
      ['[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)', 'needs-app-password'],
      ['[ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)', 'web-login'],
      ['[ALERT] IMAP access is disabled for your domain. Please contact your domain administrator (Failure)', 'imap-off']]) {
      const refusing = await startFakeImap({ user: USER, pass: PASS, loginRefusal: reply });
      let rErr = null;
      try { await rpc(G.makeGmailImapTransport({ now: () => 0, url: G.ENDPOINT, token: USER + ':' + WRONG, imap: { connect: tcp(refusing.port, sockets) } }))('initialize', {}); } catch (e) { rErr = e; }
      A.ok(rErr && rErr.authRejected === true, reason + ': still authRejected (no retry)');
      A.eq(rErr && rErr.message, G.AUTH_HELP[reason], reason + ': its own fix text');
      A.ok(rErr && !rErr.message.includes(WRONG) && !rErr.message.includes('support.google.com/mail/accounts') && !JSON.stringify(rErr).includes(WRONG), reason + ': the server reply itself never surfaces');
      await refusing.close();
    }
    let fmtErr = null; try { await rpc(make('me@example.com:short'))('initialize', {}); } catch (e) { fmtErr = e; }
    A.ok(fmtErr && fmtErr.authRejected && /16 letters/.test(fmtErr.message), 'a malformed credential fails before any network use');

    /* F. timeouts: a silent server, and a server that stalls after login */
    const hang = await startFakeImap({ hang: true });
    const trHang = G.makeGmailImapTransport({ now: () => 0, url: G.ENDPOINT, token: USER + ':' + PASS, timeoutMs: 2000, imap: { connect: tcp(hang.port, sockets) } });
    const t0 = Date.now(); let hangErr = null;
    try { await rpc(trHang)('initialize', {}); } catch (e) { hangErr = e; }
    A.ok(hangErr && /did not respond in time/.test(hangErr.message), 'a silent IMAP server times out: ' + (hangErr && hangErr.message));
    A.ok(Date.now() - t0 < 4000, 'within the configured deadline');
    await hang.close();
    const stall = await startFakeImap({ user: USER, pass: PASS, stallAfterLogin: true });
    const trStall = G.makeGmailImapTransport({ now: () => 0, url: G.ENDPOINT, token: USER + ':' + PASS, timeoutMs: 2000, imap: { connect: tcp(stall.port, sockets) } });
    let stallErr = null; try { await rpc(trStall)('initialize', {}); } catch (e) { stallErr = e; }
    A.ok(stallErr && /did not respond in time/.test(stallErr.message), 'a stall mid-session times out');
    await stall.close();
    const smHang = await startFakeSmtp({ hang: true });
    let smtpErr = null;
    try { await smtp.sendMail({ connect: tcp(smHang.port, sockets), timeoutMs: 1000, user: USER, pass: PASS, from: USER, recipients: ['a@example.com'], data: 'x' }); } catch (e) { smtpErr = e; }
    A.ok(smtpErr && smtpErr.kind === 'timeout', 'a silent SMTP server times out');
    await smHang.close();

    /* F2. an unsolicited FETCH (flag change made elsewhere) interleaved in a response is ignored */
    const noisy = await startFakeImap({ user: USER, pass: PASS, unsolicited: true });
    const callNoisy = rpc(G.makeGmailImapTransport({ now: () => 0, url: G.ENDPOINT, token: USER + ':' + PASS, timeoutMs: 5000, imap: { connect: tcp(noisy.port, sockets) } }));
    const noisyList = JSON.parse(textOf(await callNoisy('tools/call', { name: 'list_recent', arguments: {} })));
    A.eq(noisyList.messages.map(m => m.subject), ['Café plans', 'Quarterly numbers'], 'list_recent ignores an unsolicited FETCH row');
    const noisyRead = JSON.parse(textOf(await callNoisy('tools/call', { name: 'read_message', arguments: { messageId: noisyList.messages[1].id } })));
    A.eq(noisyRead.subject, 'Quarterly numbers', 'read_message picks the row for its own UID');
    await noisy.close();

    /* G. byte cap: a session that receives more than its cap is cut off */
    const big = await startFakeImap({ user: USER, pass: PASS, messages: [{ uid: 1, msgid: '5', thrid: '5', flags: [], labels: [], inbox: true, raw: 'Subject: big\r\n\r\n' + 'x'.repeat(200 * 1024) }] });
    const s = await imap.openSession({ connect: tcp(big.port, sockets), maxBytes: 64 * 1024, timeoutMs: 3000 });
    await s.login(USER, PASS); await s.examine('INBOX');
    let capErr = null; try { await s.fetch('1', '(UID BODY.PEEK[]<0.300000>)', false); } catch (e) { capErr = e; }
    A.ok(capErr && capErr.kind === 'limit', 'the per-session byte cap stops an oversized response');
    s.close(); await big.close();

    // Every socket opened by any path above is closed.
    await new Promise(r => setTimeout(r, 200));
    A.eq(sockets.filter(x => !x.destroyed).length, 0, 'every socket is closed on every path (' + sockets.length + ' opened)');
    tr.close(); tr2.close(); trBad.close();
  } finally { await im.close(); await sm.close(); }
  /* H. the connector manager honours authRejected: its own fix text as the status, and NO retry loop */
  const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
  let armed = 0, made = 0;
  const mgr = makeConnectorManager({
    makeTransport: () => { made++; let cb = () => {}; return { onMessage(f) { cb = f; }, close() {}, async send(m) { if (m.id == null) return; const e = new Error(G.AUTH_HELP.credentials); e.authRejected = true; throw e; } }; },
    setTimeoutImpl: () => { armed++; return 1; }, clearTimeoutImpl: () => {}
  });
  const res = await mgr.configure('gmail-app-password', { transport: 'http', url: G.ENDPOINT, token: USER + ':' + PASS });
  A.eq(res.authRequired, true, 'a rejected app password is an auth-required state');
  A.eq(mgr.status('gmail-app-password').detail, G.AUTH_HELP.credentials, 'the status shows the plain-language fix, not a generic HTTP 401');
  A.eq(armed, 0, 'no reconnect is scheduled (repeated bad logins could lock the Google account)');
  A.eq(made, 1, 'exactly one connection attempt');
  A.ok(!JSON.stringify(mgr.list()).includes(PASS), 'the manager summary never carries the password');
  await mgr.close();
  A.report('gmail-app-password.test');
})().catch(e => { console.error(e); process.exit(1); });
