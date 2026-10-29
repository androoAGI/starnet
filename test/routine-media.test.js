/* node test/routine-media.test.js — the files a chat-bound routine's delivery carries (sidecar/routine-media.js).

   Issue 2026-10-18: "Telegram messages cannot be automated from starnet to include images." An unattended run
   cannot channel.send, and the routine delivery was words-only. These lock the pure half of the fix: which files
   ride the delivery, that the ATTACH instruction never reaches the Commander as prose, that a failed file is a
   reported failure rather than a silent omission, and that the note is only written for a chat destination.
   The live half (real sidecar, fake Bot API) is test/cron.channel-media.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const M = require('../sidecar/routine-media.js');
const { MAX_FILES } = require('../sidecar/tools/builtin/comms.js');

(async () => {
  // ---- parseReply: ATTACH lines out, prose kept ----------------------------------------------------------
  {
    const plain = 'Weather is clear.\nNothing else today.';
    const p0 = M.parseReply(plain);
    A.eq(p0.text, plain, 'a reply without ATTACH lines is returned byte-identical');
    A.eq(p0.files, [], 'and names no files');

    const p1 = M.parseReply("Here is today's chart.\nATTACH: charts/today.png\n");
    A.eq(p1.text, "Here is today's chart.", 'the ATTACH line is removed from the delivered words');
    A.eq(p1.files, ['charts/today.png'], 'and its path is collected');

    const p2 = M.parseReply('Two views:\r\n- attach: `a/one.png`\r\n* MEDIA: "b/two.jpg"\r\nATTACH: a/one.png\r\nEnd.');
    A.eq(p2.files, ['a/one.png', 'b/two.jpg'], 'bullets, quotes, backticks, MEDIA: and a lowercase word with a quoted path are read; duplicates collapse');
    A.eq(p2.text, 'Two views:\nEnd.', 'all instruction lines are gone, the prose remains');

    // upgrade review 2026-10-23: digests written long before ATTACH existed carry these as PROSE
    const prose = 'Morning brief\n- Media: TV coverage was strong\nAttach: invoice before replying\nMEDIA: CNN, BBC and Reuters\n'
      + 'Attach: invoice.pdf\n* media: photos.zip\nMEDIA: https://example.com/a.png\nATTACH: see the chart\nDone.';
    const p5 = M.parseReply(prose);
    A.eq(p5.files, [], 'prose "Media:" / "Attach:" lines name no files');
    A.eq(p5.text, prose, 'and the reply is delivered byte-identical, every line kept');
    const p6 = M.parseReply('Report\n- MEDIA: reports/q3 summary.pdf\nATTACH: `reports/q3 summary.pdf`');
    A.eq(p6.files, ['reports/q3 summary.pdf'], 'a path with a space is read only when quoted');
    A.eq(p6.text, 'Report\n- MEDIA: reports/q3 summary.pdf', 'the unquoted line stays as words');

    const p3 = M.parseReply('Mention of ATTACH: in a sentence stays: see ATTACH: x.png inline');
    A.eq(p3.files, [], 'ATTACH inside a sentence is prose, not an instruction');

    const p4 = M.parseReply('ATTACH: only.png');
    A.eq(p4.text, '', 'a reply that is only an ATTACH line leaves no words');
    A.eq(p4.files, ['only.png'], 'but still names the file');

    // review 2026-10-23: uppercase field labels in a digest ("MEDIA: N/A") look like instructions. The host strips
    // ONLY the lines whose file it really read (readNamed) — every other line stays as the routine wrote it.
    const digest = 'Head\r\nMEDIA: N/A\r\n- MEDIA: TV/radio\r\nMEDIA: Reuters.com\r\nMEDIA: 2.1K\r\nATTACH: charts/today.png\r\nTail';
    const cand = M.parseReply(digest);
    A.eq(cand.files, ['N/A', 'TV/radio', 'Reuters.com', '2.1K', 'charts/today.png'], 'path-shaped values are only CANDIDATES');
    A.eq(M.parseReply(digest, []).text, digest, 'none of them read -> the reply is delivered byte for byte');
    A.eq(M.parseReply(digest, []).files, cand.files, 'the candidates are still listed');
    A.eq(M.parseReply(digest, ['charts/today.png']).text, 'Head\nMEDIA: N/A\n- MEDIA: TV/radio\nMEDIA: Reuters.com\nMEDIA: 2.1K\nTail', 'only the line whose file was read is removed');
    A.eq(M.parseReply('A\nATTACH: x.png\nB\nATTACH: x.png', ['x.png']).text, 'A\nB', 'every line naming a read file is removed');
  }

  // ---- readNamed: a named path is an instruction only when the file is really on the station ------------------
  {
    const disk = { 'agent:charts/today.png': Buffer.from('PNG1'), 'writer:out/b.png': Buffer.from('PNG2') };
    const reads = [];
    const read = async (agentId, rel) => {
      reads.push(agentId + ':' + rel);
      const buf = disk[agentId + ':' + rel];
      return buf ? { ok: true, buffer: buf, name: rel.split('/').pop(), mime: 'image/png' } : { ok: false, error: 'not a file' };
    };
    const r = await M.readNamed(['N/A', 'charts/today.png', 'out/b.png', 'Reuters.com'], ['writer', 'agent'], read);
    A.eq(r.found.map(f => f.path), ['charts/today.png', 'out/b.png'], 'only files that exist in a workspace of the fire are found');
    A.eq(r.missing.map(f => f.path), ['N/A', 'Reuters.com'], 'prose values are missing, not files');
    A.ok(r.found[0].got && r.found[0].got.buffer.equals(disk['agent:charts/today.png']), 'a found file carries its bytes (read once)');
    A.eq(M.fireAgents([{ agentId: 'writer' }, { agentId: 'agent' }, { agentId: 'writer' }], 'own'), ['writer', 'agent', 'own'], 'fire agents: newest first, then the routine\'s own');
    // the found files go out from that single read: sendFiles does not read them again
    const picked = M.pickFiles({ named: r.found, runs: [], agentId: 'agent' });
    A.eq(picked.files.map(f => f.path), ['charts/today.png', 'out/b.png'], 'pickFiles takes the found files as named');
    const before = reads.length, uploaded = [];
    const sent = await M.sendFiles(picked.files, { read: read, send: async (item) => { uploaded.push(item.filename); return { ok: true }; } });
    A.eq(sent.attached, ['charts/today.png', 'out/b.png'], 'both attach');
    A.eq(reads.length, before, 'without a second read');
    A.eq(uploaded, ['today.png', 'b.png'], 'under their own names');
    const over = await M.readNamed(['charts/today.png', 'out/b.png', 'charts/today.png', 'out/b.png', 'charts/today.png'], ['writer', 'agent'], read);
    A.eq(over.found.filter(f => f.got).length, MAX_FILES, 'only the first MAX_FILES found keep their bytes');
    A.eq(over.found.length, 5, 'the rest are still known to exist (the cap names them as left behind)');
    A.eq((await M.readNamed(['a.png'], ['agent'], null)).missing.map(f => f.path), ['a.png'], 'no reader wired -> nothing is found');
  }

  // ---- pickFiles: named first, generated images otherwise, capped --------------------------------------
  {
    const runs = [   // newest first, as runStore.list answers
      { agentId: 'writer', artifacts: [{ kind: 'image', path: 'images/final.png' }, { kind: 'file', path: 'notes.md' }] },
      { agentId: 'agent', artifacts: [{ kind: 'image', path: 'images/draft.png' }] }
    ];
    const named = M.pickFiles({ named: ['charts/today.png'], runs: runs, agentId: 'agent' });
    A.eq(named.files.map(f => f.path), ['charts/today.png'], 'a named file wins over generated images');
    A.eq(named.files[0].agents, ['writer', 'agent'], 'it is looked up in every agent of the fire, newest first');

    const auto = M.pickFiles({ named: [], runs: runs, agentId: 'agent', generatedImages: true });
    A.eq(auto.files.map(f => f.path), ['images/draft.png', 'images/final.png'], 'with nothing named, the generated images ride in the order they were made');
    A.eq(auto.files.map(f => f.agents[0]), ['agent', 'writer'], 'each read from the workspace of the agent that made it');
    A.eq(auto.files.map(f => f.root), ['', ''], 'and through THAT row\'s base (its project root, here none)');
    A.ok(auto.files.every(f => f.path !== 'notes.md'), 'a plain written file is never auto-sent — only images');
    // review round 2 (m-routine-root): a pick carries its row's root, and the read is asked through that row alone
    const rooted = M.pickFiles({ named: [], runs: [{ agentId: 'writer', projectRoot: '/proj/a', artifacts: [{ kind: 'image', path: 'images/p.png' }] }], agentId: 'agent', generatedImages: true });
    A.eq(rooted.files, [{ path: 'images/p.png', agents: ['writer'], root: '/proj/a' }], 'a generated image names the row that made it');
    const asked = [];
    await M.sendFiles(rooted.files, { read: async (aid, rel, where) => { asked.push([aid, rel, where]); return { ok: true, buffer: Buffer.from('x'), name: 'p.png', mime: 'image/png' }; }, send: async () => ({ ok: true }) });
    A.eq(asked, [['writer', 'images/p.png', { root: '/proj/a' }]], 'the read goes through that row (where.root), once');

    // upgrade review 2026-10-23: only a routine granted ALLOW IMAGES has its generated pictures sent unasked; a
    // routine that makes images for another purpose (wallpapers into a folder) keeps its chat words-only
    const ungranted = M.pickFiles({ named: [], runs: runs, agentId: 'agent' });
    A.eq(ungranted.files, [], 'without the images grant, generated images stay on the station');
    A.eq(M.pickFiles({ named: ['charts/today.png'], runs: runs, agentId: 'agent' }).files.map(f => f.path), ['charts/today.png'], 'a file the reply names still rides without the grant');

    const none = M.pickFiles({ named: [], runs: [{ agentId: 'agent', artifacts: [{ kind: 'file', path: 'x.md' }] }], agentId: 'agent', generatedImages: true });
    A.eq(none.files, [], 'a run that generated no image attaches nothing (the old delivery, unchanged)');

    const many = M.pickFiles({ named: ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'], runs: [], agentId: 'agent' });
    A.eq(many.files.length, MAX_FILES, 'capped at channel.send\'s own limit');
    A.eq(many.dropped, ['5.png', '6.png'], 'and the cap names what it left behind');
    A.eq(many.files[0].agents, ['agent'], 'a fire with no recorded rows still reads from the routine\'s own agent');
  }

  // ---- filesAlreadySent: a Full Access fire that channel.sent its own files is not sent them again ----------
  // Live 2026-10-18: the routine's prompt said "send it using channel_send"; the run did, AND wrote an ATTACH line,
  // and the picture arrived twice. Decided per destination off channel.send's own summary.
  {
    const trace = (t) => [{ agentId: 'agent', toolTrace: [t] }];
    const ok = (summary, name) => trace({ callId: 'b', name: name || 'channel_send', ok: true, isError: false, summary });
    A.ok(M.filesAlreadySent(ok('sent to 4242 with 1 file(s)'), '@origin', '4242'), 'files already sent to this chat (by chat id)');
    A.ok(M.filesAlreadySent(ok('sent to bot7|4242 in 2 parts with 2 file(s)', 'channel.send'), '@origin', '4242'), 'a per-bot key and a multi-part send still match the chat');
    A.ok(M.filesAlreadySent(ok('sent to bot7|4242 with 1 file(s)'), 'bot7|4242', '4242'), 'and the exact target key matches');
    A.ok(!M.filesAlreadySent(ok('sent to 9999 with 1 file(s)'), '@origin', '4242'), 'files sent to ANOTHER chat do not cancel this one');
    A.ok(!M.filesAlreadySent(ok('sent to 4242'), '@origin', '4242'), 'a words-only send does not cancel the picture');
    A.ok(!M.filesAlreadySent(ok('sent to 4242 — 1 file(s) NOT attached'), '@origin', '4242'), 'a send whose file failed does not cancel it either');
    A.ok(!M.filesAlreadySent(trace({ callId: 'b', name: 'channel_send', ok: false, isError: true, summary: 'sent to 4242 with 1 file(s)' }), '@origin', '4242'), 'a refused send (ASK posture) leaves the delivery to carry the picture');
    A.ok(!M.filesAlreadySent([{ agentId: 'agent' }], '@origin', '4242'), 'a fire with no trace sent nothing itself');
  }

  // ---- sendFiles: read through the injected jail, upload, report every failure ---------------------------
  {
    const disk = { 'agent:charts/today.png': Buffer.from([1, 2, 3]), 'writer:images/final.png': Buffer.from([9]) };
    const read = async (agentId, rel) => {
      const b = disk[agentId + ':' + rel];
      return b ? { ok: true, buffer: b, name: rel.split('/').pop(), mime: 'image/png' } : { ok: false, error: 'not a file' };
    };
    const sent = [];
    const send = async (item) => { sent.push(item); return item.filename === 'reject.png' ? { ok: false, error: 'Bad Request: wrong file' } : { ok: true, messageId: '1' }; };
    disk['agent:reject.png'] = Buffer.from([7]);

    const out = await M.sendFiles([
      { path: 'charts/today.png', agents: ['writer', 'agent'] },
      { path: 'images/final.png', agents: ['writer'] },
      { path: 'missing.png', agents: ['agent'] },
      { path: 'reject.png', agents: ['agent'] }
    ], { read, send });
    A.eq(out.attached, ['charts/today.png', 'images/final.png'], 'the first workspace that holds a file supplies it');
    A.eq(sent[0].kind, 'photo', 'an image uploads as a photo (inline)');
    A.eq(sent[0].filename, 'today.png', 'under its own name');
    A.ok(sent[0].buffer.equals(Buffer.from([1, 2, 3])), 'with the exact bytes read');
    A.eq(out.failed.map(f => f.path), ['missing.png', 'reject.png'], 'an unreadable and a refused file are both reported');
    A.ok(/could not be read/.test(out.failed[0].error), 'a read miss says it could not be read');
    A.ok(/wrong file/.test(out.failed[1].error), 'an upload refusal carries the platform\'s reason');

    const doc = [];
    await M.sendFiles([{ path: 'r.pdf', agents: ['a'] }], { read: async () => ({ ok: true, buffer: Buffer.from('x'), name: 'r.pdf', mime: 'application/pdf' }), send: async (i) => { doc.push(i); return { ok: true }; } });
    A.eq(doc[0].kind, 'document', 'a non-image goes as a document (exact bytes kept)');

    const unwired = await M.sendFiles([{ path: 'a.png', agents: ['a'] }], {});
    A.eq(unwired.failed.length, 1, 'no host wiring is a reported failure, never a pretend success');

    const throwing = await M.sendFiles([{ path: 'a.png', agents: ['a'] }], { read: async () => { throw new Error('boom'); }, send: async () => ({ ok: true }) });
    A.eq(throwing.failed.length, 1, 'a throwing reader degrades to a reported failure');
  }

  // ---- the chat note and the prompt note -----------------------------------------------------------------
  {
    A.eq(M.missedNote([]), '', 'nothing missed -> no note');
    const one = M.missedNote(['charts/missing.png']);
    A.ok(/this file could not be attached here/.test(one) && /"charts\/missing\.png"/.test(one) && /saved in the workspace/.test(one), 'one missed file is named, with where it is');
    A.ok(/these files/.test(M.missedNote(['a.png', 'b.png'])), 'several are named together');

    A.eq(M.deliveryNote([]), '', 'a routine that stays on the station gets no attachment instruction');
    const note = M.deliveryNote(['Telegram', 'Telegram', 'Discord']);
    A.ok(/Telegram \/ Discord chat/.test(note), 'the note names the platforms it delivers to, once each');
    A.ok(/ATTACH: <workspace-relative path>/.test(note), 'and the exact line format');
    A.ok(/station sends this routine's reply/.test(note), 'it says the STATION delivers the reply');
    A.ok(/do not look up chat targets or call channel\.send/.test(note), 'and rules out the lookup and the send an unattended run cannot make');
    A.ok(/Never write that the message or a file cannot be sent/.test(note), 'and forbids the "cannot send" line a live model wrote');
  }

  A.report('routine-media.test');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
