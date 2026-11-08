/* node test/mail-body-extraction.test.js — read_message returns what an HTML or image-heavy email says.

   Customer report (Whop, 11-04..11-08, Gmail app-password card): "Some HTML emails only return partial plain-text content"
   and "some emails return almost nothing except links or footer text, even when bodyTruncated is false". Both were true of
   sidecar/mcp/mail-parse.js:
     · the plain part won whenever there was one, even an empty one. A newsletter's plain part is often a stub ("View this
       email in your browser", a link, the footer) or a cut-down summary, while the HTML part holds the message. Nothing had
       been cut, so bodyTruncated was honestly false: the wrong part had been read.
     · the HTML reduction dropped every <img> alt text, so an image-made mail had no words left; an Outlook-only
       <!--[if mso]> block leaked a second copy; &rsquo; &zwnj; &#x2019; and the like stayed as raw entities.
   Now the HTML part wins when the plain part is empty or the HTML clearly says more, alt text is kept, comments go, entities
   decode once, and the result says which part it read (bodySource). The list preview (a 6 KB slice) keeps the plain part.
   Runs the real parser and the real connector against the in-process fake Gmail (test/helpers/fake-gmail.js). */
'use strict';
const net = require('node:net');
const A = require('./_assert.js');
const mail = require(process.env.MAIL_PARSE_PATH || '../sidecar/mcp/mail-parse.js');

const CRLF = '\r\n';
const msg = lines => lines.join(CRLF);
const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&' + CRLF);
function alternative(subject, plain, html, extraHead) {
  return msg(['From: Shop <news@shop.example>', 'To: me@example.com', 'Subject: ' + subject, 'Date: Thu, 05 Nov 2026 09:00:00 +0000']
    .concat(extraHead || [], ['MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="alt"', '',
      '--alt', 'Content-Type: text/plain; charset=UTF-8', '', plain,
      '--alt', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html),
      '--alt--', '']));
}

const STORY = ['Our spring collection is here, and it’s the biggest we have ever made.',
  'Every jacket in the range is cut from recycled wool and lined with organic cotton, so it keeps you warm without the guilt.',
  'Members get early access from Monday morning, two days before everyone else, and free returns for sixty days.',
  'We have also opened a new shop in Leeds, on Briggate, with a repair bench where you can bring any coat you bought from us.'];
const NEWSLETTER_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Spring</title>' +
  '<style>body{margin:0} .hero{color:#333} td{padding:0}</style>' +
  '<!--[if mso]><style>.outlook{width:600px}</style><![endif]--></head><body>' +
  '<div style="display:none">Spring is here' + '&zwnj;&nbsp;&#847;'.repeat(80) + '</div>' +
  '<table role="presentation" width="100%"><tr><td align="center">' +
  '<a href="https://shop.example/?utm=1"><img src="https://img.shop.example/logo.png" alt="Shop Example" width="120"></a></td></tr>' +
  '<tr><td><img src="https://img.shop.example/hero.jpg" alt="Spring sale: 40% off every jacket"></td></tr>' +
  '<tr><td class="hero"><h1>Spring is here</h1>' +
  STORY.map(p => '<p>' + p.replace('it’s', 'it&rsquo;s') + '</p>').join('') +
  '<!--[if mso]><table><tr><td>OUTLOOK COPY OF THE BUTTON</td></tr></table><![endif]-->' +
  '<p><a href="https://shop.example/spring">Shop the collection &rarr;</a></p></td></tr>' +
  '<tr><td><img src="https://track.shop.example/open.gif" width="1" height="1" alt=""></td></tr>' +
  '<tr><td style="font-size:11px">You get this because you signed up. <a href="https://shop.example/unsub">Unsubscribe</a> &middot; Shop Example Ltd &copy; 2026</td></tr>' +
  '</table></body></html>';
const STUB_PLAIN = 'View this email in your browser: https://shop.example/view/8f3a2c\n\nUnsubscribe: https://shop.example/unsub';

(async () => {
  /* ---- 1. the customer's newsletter: a stub plain part beside the real HTML ---- */
  {
    const p = mail.parseMessage(Buffer.from(alternative('Spring is here', STUB_PLAIN, NEWSLETTER_HTML)));
    A.eq(p.textSource, 'text/html', 'a "view in your browser" plain part loses to the HTML that holds the message');
    A.ok(!/^View this email/.test(p.text), 'the body is not the stub: ' + JSON.stringify(p.text.slice(0, 80)));
    for (const s of STORY) A.ok(p.text.includes(s), 'the body carries the story: ' + s.slice(0, 40) + '…');
    A.ok(p.text.includes('Spring sale: 40% off every jacket'), 'an image\'s alt text is read (the offer was only in the picture)');
    A.ok(p.text.includes('Shop the collection →'), 'link text is kept, its entity decoded');
    A.ok(p.text.includes('Unsubscribe · Shop Example Ltd © 2026'), 'the footer is still there, at the end');
    A.ok(!/OUTLOOK COPY/.test(p.text) && !/\.outlook|padding:0|margin:0/.test(p.text), 'no Outlook-only copy and no stylesheet');
    A.ok(!/&[a-z#0-9]+;/i.test(p.text), 'no raw entities left');
    A.ok(!/[​-‍͏­]/.test(p.text) && !/ {2}/.test(p.text), 'the preview-line padding is gone');
    A.eq(p.textTruncated, false, 'nothing was cut, and it says so');
  }

  /* ---- 2. an ordinary mail (Gmail writes both parts): the plain part is still the body, byte for byte ---- */
  {
    const plain = 'Hi Sam,\n\nThanks for the notes. I moved the review to Thursday at 3pm; the room is the same.\n\nSee you then,\nAnn';
    const html = '<div dir="ltr">Hi Sam,<div><br></div><div>Thanks for the notes. I moved the review to <b>Thursday at 3pm</b>; the room is the same.</div><div><br></div><div>See you then,</div><div>Ann</div></div>';
    const p = mail.parseMessage(Buffer.from(alternative('Review', plain, html)));
    A.eq([p.textSource, p.text], ['text/plain', plain], 'when both parts say the same, the plain part is read as before');
    const quoted = mail.parseMessage(Buffer.from(alternative('Re: Review', plain + '\n\nOn Wed, Ann wrote:\n> earlier', html + '<blockquote>earlier</blockquote><img src="cid:sig" alt="Ann Example, Studio Lead">')));
    A.eq(quoted.textSource, 'text/plain', 'a signature image\'s few extra words do not flip it');
  }

  /* ---- 3. a plain part that is empty, or a summary of a longer HTML ---- */
  {
    const empty = mail.parseMessage(Buffer.from(alternative('Receipt', '   ', '<p>Order 1042 is confirmed.</p><p>Total: &pound;84.00</p>')));
    A.eq([empty.textSource, empty.text], ['text/html', 'Order 1042 is confirmed.\n Total: £84.00'], 'an empty plain part never wins');
    const summary = mail.parseMessage(Buffer.from(alternative('Weekly', STORY[0], '<h1>Weekly</h1>' + STORY.map(s => '<p>' + s + '</p>').join(''))));
    A.eq(summary.textSource, 'text/html', 'a plain part with one paragraph of four loses to the full HTML');
    A.ok(STORY.every(s => summary.text.includes(s)), 'and every paragraph is read');
  }

  /* ---- 4. an image-only mail with no plain part ---- */
  {
    const raw = msg(['From: a@b.example', 'Subject: Invite', 'Content-Type: text/html; charset=UTF-8', '',
      '<table><tr><td><img src="1.png" alt="You are invited to our launch party"></td></tr><tr><td><img src=2.png alt=\'Friday 13 November, 7pm, The Old Mill\'></td></tr><tr><td><a href="https://rsvp.example"><img src="3.png" alt=RSVP></a></td></tr></table>']);
    const p = mail.parseMessage(Buffer.from(raw));
    A.eq(p.text, 'You are invited to our launch party \n Friday 13 November, 7pm, The Old Mill \n RSVP', 'every picture\'s alt text, quoted or bare, in order');
  }

  /* ---- 5. the list preview reads a 6 KB slice that can end inside the HTML's <style>: it keeps the plain part ---- */
  {
    const p = mail.parseMessage(Buffer.from(alternative('Spring is here', STUB_PLAIN, NEWSLETTER_HTML)), { maxText: 2000, preferPlain: true });
    A.eq(p.textSource, 'text/plain', 'preferPlain keeps the plain part when it has text');
    const cut = alternative('Spring', STUB_PLAIN, '<html><head><style>' + '.x{color:red}'.repeat(600)).slice(0, 6144);
    A.ok(!/color:red/.test(mail.snippetOf(mail.parseMessage(Buffer.from(cut), { maxText: 2000, preferPlain: true }).text, 200)), 'so a preview never shows the stylesheet');
  }

  /* ---- 6. a long HTML body is cut at maxText and says so ---- */
  {
    const p = mail.parseMessage(Buffer.from(alternative('Long', 'see the web version', '<p>' + 'word '.repeat(5000) + '</p>')), { maxText: 1000 });
    A.eq([p.textSource, p.text.length, p.textTruncated], ['text/html', 1000, true], 'cut text is flagged truncated');
  }

  /* ---- 7. entities decode once; comments go whole; hostile input stays linear ---- */
  {
    A.eq(mail.htmlToText('it&rsquo;s &#x2019;&#8217; &AMP; &eacute;&Eacute;&ntilde; &euro;5 &unknown; &amp;lt;b&amp;gt;'), 'it’s ’’ & éÉñ €5 &unknown; &lt;b&gt;', 'named, hex and decimal entities; an unknown one stays; &amp;lt; is decoded once');
    A.eq(mail.htmlToText('a<!-- x > y -->b<!---->c'), 'a b c', 'a comment goes whole, even with a ">" inside');
    A.eq(mail.htmlToText('<ul><li>one</li><li>two</li></ul><blockquote>q</blockquote>after'), 'one\n two\n\n q\nafter', 'lists and quotes end their lines');
    // A ReDoS guard: what matters is that doubling the input roughly doubles the time (a quadratic parse quadruples it).
    // A fixed wall-clock bound failed on a box at 100% CPU (2-4 s for the 800k case) although the parse is linear, so
    // compare each input against half of itself, best of two runs each, plus a generous absolute backstop.
    const best = (html) => { let b = Infinity; for (let k = 0; k < 2; k++) { const t0 = Date.now(); mail.htmlToText(html); b = Math.min(b, Date.now() - t0); } return b; };
    for (const [label, unit, tail, n] of [['"<!--"', '<!--', '', 1000000], ['"<img alt=\\""', '<img alt="', '>', 400000], ['"<img alt=x>"', '<img alt=x>', '', 400000], ['"&amp;"', '&amp;', '', 800000]]) {
      const half = best(unit.repeat(n / 2) + tail), full = best(unit.repeat(n) + tail);
      A.ok(full <= 3 * half + 250, label + ' x ' + n + ' scales linearly (' + half + ' ms for half, ' + full + ' ms for all)');
      A.ok(full < 15000, label + ' x ' + n + ' parses in ' + full + ' ms');
    }
  }

  /* ---- 8. through the real connector: read_message says which part it read; the list preview is unchanged ---- */
  if (!process.env.MAIL_PARSE_PATH) {
    const { startFakeImap } = require('./helpers/fake-gmail.js');
    const G = require('../sidecar/mcp/transport.gmail-imap.js');
    const USER = 'me@example.com', PASS = 'abcdefghijklmnop';
    const im = await startFakeImap({ user: USER, pass: PASS, messages: [
      { uid: 201, msgid: '1790000000000000201', thrid: '1790000000000000201', flags: [], labels: ['\\Inbox'], inbox: true, raw: alternative('Spring is here', STUB_PLAIN, NEWSLETTER_HTML) }
    ] });
    const sockets = [];
    const tr = G.makeGmailImapTransport({ url: G.ENDPOINT, token: USER + ':' + PASS, timeoutMs: 5000, now: () => Date.UTC(2026, 10, 8, 12), newId: () => 'fixed-id', imap: { connect: () => { const s = net.connect({ host: '127.0.0.1', port: im.port }); sockets.push(s); return s; } } });
    let n = 0; const got = new Map();
    tr.onMessage(m => got.set(m.id, m));
    const call = async (method, params) => { const id = ++n; await tr.send({ jsonrpc: '2.0', id, method, params }); return got.get(id); };
    const textOf = r => r && r.result && r.result.content && r.result.content[0].text;
    try {
      await call('initialize', {});
      const recent = JSON.parse(textOf(await call('tools/call', { name: 'list_recent', arguments: { maxResults: 5 } })));
      A.eq(recent.messages.length, 1, 'the newsletter is listed');
      A.ok(/^View this email in your browser/.test(recent.messages[0].snippet), 'the list preview still reads the plain part (a 6 KB slice)');
      const read = JSON.parse(textOf(await call('tools/call', { name: 'read_message', arguments: { messageId: recent.messages[0].id } })));
      A.eq(read.bodySource, 'text/html', 'read_message says the body came from the HTML part');
      A.ok(STORY.every(s => read.body.includes(s)) && read.body.includes('Spring sale: 40% off every jacket'), 'and the body is the message, picture text included');
      A.eq(read.bodyTruncated, false, 'nothing was cut');
    } finally { tr.close(); await im.close(); }
  }

  A.report('mail-body-extraction.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
