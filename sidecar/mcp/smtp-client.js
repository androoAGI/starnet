'use strict';
/* sidecar/mcp/smtp-client.js — a deliberately small SMTP submission client on node:tls (implicit TLS, port 465),
   no npm dependency. EHLO, AUTH PLAIN, MAIL FROM, RCPT TO (each), DATA with dot-stuffing, QUIT.

   Used by the Gmail app-password connector. The message itself is built elsewhere (transport.google.js
   mimeMessage — the CRLF-injection-proof builder); this module only refuses envelope addresses that could
   smuggle a command (CR/LF, angle brackets, spaces) and dot-stuffs the payload.

   SECRET HYGIENE: the AUTH line is written once and never stored, echoed or logged. An auth failure is reported
   as kind 'auth' WITHOUT the server's reply text. Every path (success, error, timeout) destroys the socket. */

const { note: failNote } = require('../failopen.js');
const { loginRefusal } = require('./imap-client.js');
const tls = require('node:tls');

class SmtpError extends Error {
  constructor(message, kind, extra) {
    super(message);
    this.name = 'SmtpError';
    this.kind = kind || 'protocol';   // 'auth' | 'timeout' | 'network' | 'protocol' | 'rejected' | 'limit' | 'input' | 'closed'
    if (extra) Object.assign(this, extra);
  }
}

const ENVELOPE = /^[^\s<>()\x00-\x1f\x7f,;]+@[^\s<>()\x00-\x1f\x7f,;@]+$/;
function envelopeAddress(addr) {
  const a = String(addr == null ? '' : addr).trim();
  if (a.length > 320 || !ENVELOPE.test(a)) throw new SmtpError('invalid envelope address', 'input');
  return a;
}

// RFC 5321 §4.5.2: a line starting with "." gets a second "." — and every line ends in CRLF.
function dotStuff(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const lines = text.replace(/\r?\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return Buffer.from(lines.map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n') + '\r\n.\r\n', 'utf8');
}

function sendMail(opts) {
  opts = opts || {};
  const host = opts.host || 'smtp.gmail.com';
  const port = opts.port || 465;
  const idleMs = Math.max(1000, Number(opts.timeoutMs) || 30000);
  const maxMessageBytes = Math.max(1024, Number(opts.maxMessageBytes) || 25 * 1024 * 1024);
  const connect = typeof opts.connect === 'function' ? opts.connect
    : (o) => tls.connect({ host: o.host, port: o.port, servername: o.host, minVersion: 'TLSv1.2', rejectUnauthorized: true });
  const ehloName = String(opts.ehloName || '[127.0.0.1]');
  let from, recipients, payload;
  try {
    from = envelopeAddress(opts.from);
    recipients = (Array.isArray(opts.recipients) ? opts.recipients : []).map(envelopeAddress);
    if (!recipients.length) throw new SmtpError('at least one recipient is required', 'input');
    if (recipients.length > 100) throw new SmtpError('too many recipients (max 100)', 'input');
    payload = dotStuff(opts.data);
    if (payload.length > maxMessageBytes) throw new SmtpError('the message exceeds the size cap', 'limit');
  } catch (e) { return Promise.reject(e); }
  const user = String(opts.user || ''), pass = String(opts.pass || '');
  if (/[\x00\r\n]/.test(user) || /[\x00\r\n]/.test(pass)) return Promise.reject(new SmtpError('invalid credentials format', 'input'));

  return new Promise((resolve, reject) => {
    let socket;
    try { socket = connect({ host, port }); }
    catch (_) { return reject(new SmtpError('could not open a secure connection to ' + host, 'network')); }
    let buf = '', lines = [], waiter = null, done = false, dataSent = false;
    function finish(err, value) {
      if (done) return;
      done = true;
      // Once the payload has left, a dropped connection does NOT mean the mail was not sent.
      if (err && dataSent && err.kind !== 'rejected') {
        err.message += ' after the message was transmitted; it may have been sent, so check the Sent folder before retrying';
        err.effectUnknown = true;
      }
      try { socket.destroy(); } catch (e) { failNote('mcp.smtp.destroy', e); }
      if (err) reject(err); else resolve(value);
    }
    socket.setTimeout(idleMs, () => finish(new SmtpError('the mail server did not respond in time', 'timeout')));
    socket.on('error', () => finish(new SmtpError('the connection to the mail server failed', 'network')));
    socket.on('close', () => finish(new SmtpError('the mail server closed the connection', 'closed')));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > 64 * 1024) return finish(new SmtpError('the mail server sent an over-long reply', 'limit'));
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {            // last line of a (possibly multi-line) reply
          const reply = { code: Number(line.slice(0, 3)), lines: lines.map(l => l.slice(4)) };
          lines = [];
          const w = waiter; waiter = null;
          if (w) w(reply);
        } else if (!/^\d{3}-/.test(line)) {
          return finish(new SmtpError('unreadable reply from the mail server', 'protocol'));
        }
      }
    });
    const next = () => new Promise(r => { waiter = r; });
    const say = (line) => { if (!done) socket.write(line + '\r\n'); };
    const brief = (reply) => (reply.code + ' ' + reply.lines.join(' ')).slice(0, 300);

    (async () => {
      let r = await next();
      if (r.code !== 220) throw new SmtpError('the mail server refused the connection (' + brief(r) + ')', 'protocol');
      say('EHLO ' + ehloName); r = await next();
      if (r.code !== 250) throw new SmtpError('the mail server rejected EHLO (' + brief(r) + ')', 'protocol');
      say('AUTH PLAIN ' + Buffer.from('\u0000' + user + '\u0000' + pass, 'utf8').toString('base64')); r = await next();
      if (r.code !== 235) {
        // the reason is read from the reply here and the reply itself goes no further (secret hygiene above)
        if (r.code === 535 || r.code === 534 || r.code === 530 || r.code === 454) throw new SmtpError('login rejected', 'auth', { code: r.code, reason: loginRefusal(r.lines.join(' ')) });
        throw new SmtpError('the mail server refused authentication (' + r.code + ')', 'auth', { code: r.code });
      }
      say('MAIL FROM:<' + from + '>'); r = await next();
      if (r.code !== 250) throw new SmtpError('the mail server refused the sender (' + brief(r) + ')', 'rejected');
      const accepted = [];
      for (const rcpt of recipients) {
        say('RCPT TO:<' + rcpt + '>'); r = await next();
        if (r.code !== 250 && r.code !== 251) throw new SmtpError('the mail server refused recipient ' + rcpt + ' (' + brief(r) + '); nothing was sent', 'rejected');
        accepted.push(rcpt);
      }
      say('DATA'); r = await next();
      if (r.code !== 354) throw new SmtpError('the mail server refused DATA (' + brief(r) + '); nothing was sent', 'rejected');
      if (!done) { dataSent = true; socket.write(payload); }
      r = await next();
      if (r.code !== 250) throw new SmtpError('the mail server did not accept the message (' + brief(r) + ')', 'rejected');
      const queued = r.lines.join(' ').slice(0, 200);
      say('QUIT');
      finish(null, { accepted, response: queued });
    })().catch(e => finish(e instanceof SmtpError ? e : new SmtpError('mail delivery failed', 'protocol')));
  });
}

module.exports = { sendMail, dotStuff, envelopeAddress, SmtpError };
