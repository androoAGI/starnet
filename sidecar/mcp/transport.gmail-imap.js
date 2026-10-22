'use strict';
/* sidecar/mcp/transport.gmail-imap.js — Gmail through a Google APP PASSWORD (IMAP + SMTP), no OAuth.

   Why it exists: Agent OS's Google OAuth app is not verified yet, and Google hard-blocks the RESTRICTED Gmail
   scopes (read/compose) for unverified apps ("This app is blocked"). A Google app password is the account
   owner's own credential for mail clients: it needs 2-Step Verification on the account and nothing from Google
   on Agent OS's side. Agent OS then talks to imap.gmail.com:993 and smtp.gmail.com:465 (both implicit TLS) directly
   from this computer — no Agent OS server in between.

   Shape: a local MCP adapter exactly like transport.google.js (initialize / tools/list / tools/call), so the
   existing connector manager owns permissions, approval, status and tool projection. Each tool call opens its own
   short IMAP (or SMTP) session and closes it on every path; nothing idles open.

   Credential: the connector's protected `token` holds "address:apppassword" (normalizeCredential). The password
   is never echoed into a result, an error, a log line or an event; index.js also lists it as a known secret so
   the redactor scrubs it anywhere it might surface.

   Privacy: mailbox read access — google-relay-guard.js treats this endpoint like restricted Gmail, so mail
   content never reaches Agent OS Managed. */

const { note: failNote } = require('../failopen.js');
const crypto = require('node:crypto');
const imap = require('./imap-client.js');
const smtp = require('./smtp-client.js');
const mail = require('./mail-parse.js');
const google = require('./transport.google.js');

const ID = 'gmail-app-password';
const ENDPOINT = 'https://imap.gmail.com/#app-password';
const IMAP_HOST = 'imap.gmail.com', IMAP_PORT = 993;
const SMTP_HOST = 'smtp.gmail.com', SMTP_PORT = 465;
const SETUP_URL = 'https://myaccount.google.com/apppasswords';
const TWO_STEP_URL = 'https://myaccount.google.com/signinoptions/two-step-verification';
const AUTH_HELP = 'Gmail did not accept this app password. Check that 2-Step Verification is on for this Google account ('
  + TWO_STEP_URL + '), create a new app password at ' + SETUP_URL + ' and paste it into the Gmail (app password) card again. '
  + 'On a work or school (Google Workspace) account, an administrator can turn app passwords off.';

const MAX_RESULTS = 50, DEFAULT_RESULTS = 20;
const READ_CAP = 4 * 1024 * 1024;              // bytes of one message fetched by read_message
const SESSION_CAP = 8 * 1024 * 1024;           // bytes one IMAP session may receive
const OUTPUT_CAP = 256 * 1024;                 // characters of one tool result

function productForUrl(url) { return url === ENDPOINT ? ID : null; }

/* ---------- credential ---------- */
const ADDRESS = /^[^\s@<>()",;:\\[\]\x00-\x1f\x7f]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function credentialError(message) { const e = new Error(message); e.credentialInvalid = true; return e; }
function parseCredential(token) {
  const raw = String(token == null ? '' : token);
  const i = raw.lastIndexOf(':');
  if (i <= 0) throw credentialError('Enter your Gmail address and a 16-letter Google app password.');
  const address = raw.slice(0, i).trim();
  const password = raw.slice(i + 1).replace(/\s+/g, '');
  if (address.length > 254 || !ADDRESS.test(address)) throw credentialError('Enter a valid Gmail or Google Workspace email address.');
  if (!/^[A-Za-z]{16}$/.test(password)) throw credentialError('A Google app password is 16 letters (Google shows it in four groups of four). Create one at ' + SETUP_URL + '.');
  return { address, password: password.toLowerCase() };
}
function normalizeCredential(token) { const c = parseCredential(token); return c.address + ':' + c.password; }
// The bare password, for the known-secret redaction list. Never throws.
function passwordOf(cfg) {
  if (!cfg || productForUrl(String(cfg.url || '')) !== ID) return '';
  try { return parseCredential(cfg.token).password; } catch (_) { return ''; }
}

/* ---------- tools ---------- */
const STR = { type: 'string' };
const ADDR_LIST = { type: 'array', items: STR, maxItems: 50 };
function tool(name, description, properties, required, readOnly) {
  return { name, description, inputSchema: { type: 'object', properties, required: required || [], additionalProperties: false },
    annotations: { readOnlyHint: !!readOnly, destructiveHint: !readOnly, openWorldHint: true } };
}
const MESSAGE_PROPS = { to: { type: 'array', items: STR, minItems: 1, maxItems: 50 }, cc: ADDR_LIST, bcc: ADDR_LIST, subject: STR, body: STR, replyTo: STR };
const TOOLS = [
  tool('search_messages', 'Search Gmail with normal Gmail search syntax (from:, subject:, newer_than:7d, has:attachment, in:sent, label:…). Searches All Mail (not Spam or Trash). Returns the newest matches with sender, subject, date and a short snippet; use read_message for the full text.', { query: STR, maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } }, [], true),
  tool('list_recent', 'List the newest messages in the Inbox with sender, subject, date, unread state and a short snippet.', { maxResults: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } }, [], true),
  tool('read_message', 'Read one Gmail message by the id returned from search_messages or list_recent: headers, readable text and the list of attachments (names and sizes only).', { messageId: STR }, ['messageId'], true),
  tool('send_email', 'SEND a plain-text email from the connected Gmail account. This is an external message; obtain the user’s authorization of the exact recipients and text before sending.', MESSAGE_PROPS, ['to', 'subject', 'body']),
  tool('create_draft', 'Save a plain-text email as a Gmail draft (in Drafts). Does not send.', MESSAGE_PROPS, ['to', 'subject', 'body'])
];

/* ---------- helpers ---------- */
function hexId(dec) { try { return BigInt(String(dec)).toString(16); } catch (_) { return ''; } }
function decId(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  return BigInt('0x' + hex).toString();
}
function attrKey(attrs, prefix) { return Object.keys(attrs).find(k => k.startsWith(prefix)); }
function buf(v) { return Buffer.isBuffer(v) ? v : Buffer.from(v == null ? '' : String(v), 'utf8'); }
function flagsOf(attrs) { return Array.isArray(attrs.FLAGS) ? attrs.FLAGS.map(String) : []; }
function mailboxOf(addr) { const m = /<([^<>]+)>\s*$/.exec(String(addr)); return (m ? m[1] : String(addr)).trim(); }
function textResult(value, isError) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length > OUTPUT_CAP) text = text.slice(0, OUTPUT_CAP) + '\n[truncated]';
  return { content: [{ type: 'text', text }], isError: !!isError };
}

const SUMMARY_ITEMS = '(UID X-GM-MSGID X-GM-THRID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.6144>)';
function summarize(attrs) {
  const hk = attrKey(attrs, 'BODY[HEADER'), tk = attrKey(attrs, 'BODY[TEXT]');
  const head = hk ? buf(attrs[hk]) : Buffer.alloc(0);
  const parsed = mail.parseMessage(Buffer.concat([head, Buffer.from('\r\n'), tk ? buf(attrs[tk]) : Buffer.alloc(0)]), { maxText: 2000 });
  return {
    id: hexId(attrs['X-GM-MSGID']), threadId: hexId(attrs['X-GM-THRID']),
    date: parsed.headers.date || String(attrs.INTERNALDATE || ''), from: parsed.headers.from, to: parsed.headers.to,
    subject: parsed.headers.subject, snippet: mail.snippetOf(parsed.text, 200),
    unread: !flagsOf(attrs).some(f => /^\\Seen$/i.test(f)), size: Number(attrs['RFC822.SIZE']) || 0
  };
}

function makeGmailImapTransport(opts) {
  opts = opts || {};
  if (productForUrl(opts.url) !== ID) throw new Error('Unknown Gmail app-password connector');
  const timeoutMs = Math.max(2000, Math.min(600000, Number(opts.timeoutMs) || 60000));
  const imapOpts = Object.assign({ host: IMAP_HOST, port: IMAP_PORT }, opts.imap || {});
  const smtpOpts = Object.assign({ host: SMTP_HOST, port: SMTP_PORT }, opts.smtp || {});
  // the clock is injected by the host (sidecar/index.js) — backend modules never read ambient time (lint-determinism)
  if (typeof opts.now !== 'function') throw new Error('makeGmailImapTransport requires an injected now() clock');
  const now = opts.now;
  const newId = typeof opts.newId === 'function' ? opts.newId : () => crypto.randomUUID();
  const token = opts.token;
  let receive = () => {}, closed = false, boxes = null;
  const live = new Map();   // request id -> abort()

  function authError() { const e = new Error(AUTH_HELP); e.authRejected = true; return e; }
  function friendly(e) {
    if (e && e.credentialInvalid) { const x = new Error(e.message + ' Open the Gmail (app password) card to fix it.'); x.authRejected = true; return x; }
    if (e && e.kind === 'auth') return authError();
    if (e && e.kind === 'timeout') return new Error('Gmail did not respond in time; try again');
    if (e && e.kind === 'limit') return new Error('Gmail ' + e.message);
    if (e && (e.kind === 'network' || e.kind === 'closed')) return Object.assign(new Error('Gmail connection failed: ' + e.message), e.effectUnknown ? { effectUnknown: true } : {});
    return e instanceof Error ? e : new Error(String(e));
  }

  // One authenticated IMAP session for one operation, with an overall deadline. Closed on every path.
  async function withImap(reqId, fn) {
    const cred = parseCredential(token);
    let session = null, timer = null, aborted = false;
    const abort = () => { aborted = true; if (session) session.close(); };
    if (reqId != null) live.set(reqId, abort);
    try {
      return await Promise.race([
        new Promise((_, reject) => { timer = setTimeout(() => { abort(); reject(new imap.ImapError('the mail server did not respond in time', 'timeout')); }, timeoutMs); }),
        (async () => {
          session = await imap.openSession(Object.assign({ timeoutMs: Math.min(timeoutMs, 30000), maxBytes: SESSION_CAP }, imapOpts));
          if (aborted || closed) { session.close(); throw new imap.ImapError('cancelled', 'closed'); }
          await session.login(cred.address, cred.password);
          const out = await fn(session, cred);
          await session.logout();
          return out;
        })()
      ]);
    } finally {
      clearTimeout(timer);
      if (session) session.close();
      if (reqId != null) live.delete(reqId);
    }
  }

  async function mailboxes(session) {
    if (boxes) return boxes;
    const list = await session.list();
    const flagged = f => (list.find(b => b.flags.some(x => x.toLowerCase() === f)) || {}).name;
    boxes = { all: flagged('\\all') || '[Gmail]/All Mail', drafts: flagged('\\drafts') || '[Gmail]/Drafts' };
    return boxes;
  }

  async function newest(session, mailbox, max) {
    const { exists } = await session.examine(mailbox);
    if (!exists) return [];
    const rows = await session.fetch(Math.max(1, exists - max + 1) + ':' + exists, SUMMARY_ITEMS, false);
    return rows.filter(r => r.attrs.UID != null).sort((a, b) => b.seq - a.seq).map(r => summarize(r.attrs));
  }

  async function search(session, query, max) {
    const b = await mailboxes(session);
    if (!query) return { messages: await newest(session, b.all, max) };
    await session.examine(b.all);
    const crit = /^[\x20-\x7e]*$/.test(query) ? ['X-GM-RAW', imap.astring(query)] : ['CHARSET', 'UTF-8', 'X-GM-RAW', { literal: Buffer.from(query, 'utf8') }];
    const uids = (await session.uidSearch(crit)).sort((x, y) => y - x);
    const pick = uids.slice(0, max);
    if (!pick.length) return { messages: [], totalMatches: 0 };
    const rows = await session.fetch(pick.join(','), SUMMARY_ITEMS, true);
    const byUid = new Map(rows.map(r => [Number(r.attrs.UID), r.attrs]));
    return { messages: pick.filter(u => byUid.has(u)).map(u => summarize(byUid.get(u))), totalMatches: uids.length };
  }

  async function read(session, messageId) {
    const dec = decId(messageId);
    if (!dec) return { error: 'messageId must be an id returned by search_messages or list_recent' };
    const b = await mailboxes(session);
    await session.examine(b.all);
    const uids = await session.uidSearch(['X-GM-MSGID', dec]);
    if (!uids.length) return { error: 'No message with id ' + messageId + ' in All Mail (it may be in Spam or Trash, or deleted).' };
    const rows = await session.fetch(String(uids[0]), '(UID X-GM-MSGID X-GM-THRID X-GM-LABELS FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.' + READ_CAP + '>)', true);
    // the row for OUR uid — an unsolicited FETCH (a flag change made elsewhere) can arrive in the same response
    const attrs = (rows.find(r => Number(r.attrs.UID) === uids[0]) || {}).attrs || {};
    const bk = attrKey(attrs, 'BODY[]');
    if (!bk) return { error: 'Gmail returned no content for message ' + messageId };
    const size = Number(attrs['RFC822.SIZE']) || 0;
    const parsed = mail.parseMessage(buf(attrs[bk]), { maxText: 100000 });
    return {
      id: hexId(attrs['X-GM-MSGID']) || messageId, threadId: hexId(attrs['X-GM-THRID']),
      labels: Array.isArray(attrs['X-GM-LABELS']) ? attrs['X-GM-LABELS'].map(l => (Buffer.isBuffer(l) ? l.toString('utf8') : String(l))) : [],
      unread: !flagsOf(attrs).some(f => /^\\Seen$/i.test(f)),
      ...parsed.headers, body: parsed.text, bodyTruncated: parsed.textTruncated || size > READ_CAP,
      attachments: parsed.attachments, size
    };
  }

  function buildMessage(a, cred, withBcc) {
    const raw = Buffer.from(google.mimeMessage(Object.assign({}, a, withBcc ? {} : { bcc: undefined })), 'base64url').toString('utf8');
    const date = new Date(now()).toUTCString().replace(/GMT$/, '+0000');
    const domain = cred.address.split('@')[1];
    return 'From: ' + cred.address + '\r\nDate: ' + date + '\r\nMessage-ID: <' + newId() + '@' + domain + '>\r\n' + raw;
  }

  async function sendEmail(reqId, a) {
    const cred = parseCredential(token);
    let message;
    try { message = buildMessage(a, cred, false); }       // Bcc travels only in the envelope, never in a header
    catch (e) { return textResult(e.message, true); }
    const recipients = [].concat(a.to || [], a.cc || [], a.bcc || []).map(mailboxOf);
    let socket = null, timedOut = false;
    const cancel = () => { if (socket) { try { socket.destroy(); } catch (e) { failNote('mcp.gmailImap.cancel', e); } } };
    if (reqId != null) live.set(reqId, cancel);
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);   // overall deadline, not just idle
    try {
      const r = await smtp.sendMail({
        host: smtpOpts.host, port: smtpOpts.port, timeoutMs: Math.min(timeoutMs, 30000),
        connect: (o) => { socket = (smtpOpts.connect || defaultTls)(o); return socket; },
        user: cred.address, pass: cred.password, from: cred.address, recipients, data: message
      });
      return textResult({ sent: true, from: cred.address, accepted: r.accepted, server: r.response });
    } catch (e) {
      if (e && (e.kind === 'input' || e.kind === 'rejected')) return textResult('Not sent: ' + e.message, true);
      if (timedOut && e && !e.effectUnknown) throw new Error('Gmail did not respond in time; the message was not sent');
      throw friendly(e);
    } finally { clearTimeout(timer); if (reqId != null) live.delete(reqId); }
  }
  function defaultTls(o) { return require('node:tls').connect({ host: o.host, port: o.port, servername: o.host, minVersion: 'TLSv1.2', rejectUnauthorized: true }); }

  async function callTool(reqId, name, args) {
    const def = TOOLS.find(t => t.name === name);
    if (!def) return textResult('Unknown Gmail tool: ' + name, true);
    try { google.validate(def, args); } catch (e) { return textResult(e.message, true); }
    const max = Math.min(MAX_RESULTS, args.maxResults || DEFAULT_RESULTS);
    if (name === 'send_email') return sendEmail(reqId, args);
    if (name === 'create_draft') {
      const cred = parseCredential(token);
      let message;
      try { message = buildMessage(args, cred, true); } catch (e) { return textResult(e.message, true); }
      const r = await withImap(reqId, async (s) => {
        const b = await mailboxes(s);
        const appended = await s.append(b.drafts, ['\\Draft', '\\Seen'], message);
        return { saved: true, mailbox: b.drafts, uid: appended.uid };
      });
      return textResult(r);
    }
    const value = await withImap(reqId, async (s) => {
      if (name === 'search_messages') return search(s, String(args.query || '').trim(), max);
      if (name === 'list_recent') return { messages: await newest(s, 'INBOX', max) };
      return read(s, args.messageId);
    });
    if (value && value.error) return textResult(value.error, true);
    return textResult(value);
  }

  async function send(msg) {
    if (msg.method === 'notifications/cancelled') {
      const abort = live.get(msg.params && msg.params.requestId);
      if (abort) abort();
      return;
    }
    if (msg.id == null) return;
    if (closed) throw new Error('Gmail connector closed');
    let result;
    try {
      if (msg.method === 'initialize') {
        // Prove the credential works (IMAP LOGIN + mailbox list) before the connector reports connected.
        await withImap(null, s => mailboxes(s));
        result = { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'Agent OS Gmail app-password connector (IMAP/SMTP)', version: '1' } };
      } else if (msg.method === 'tools/list') result = { tools: TOOLS };
      else if (msg.method === 'tools/call') result = await callTool(msg.id, msg.params && msg.params.name, (msg.params && msg.params.arguments) || {});
      else if (msg.method === 'ping') result = {};
      else throw new Error('Unsupported Gmail MCP method');
    } catch (e) { throw friendly(e); }
    if (!closed) receive({ jsonrpc: '2.0', id: msg.id, result });
  }

  return {
    send, onMessage(cb) { receive = cb; },
    close() { closed = true; for (const abort of live.values()) { try { abort(); } catch (e) { failNote('mcp.gmailImap.abort', e); } } live.clear(); }
  };
}

module.exports = { ID, ENDPOINT, TOOLS, SETUP_URL, TWO_STEP_URL, AUTH_HELP, IMAP_HOST, SMTP_HOST,
  productForUrl, parseCredential, normalizeCredential, passwordOf, makeGmailImapTransport, summarize };
