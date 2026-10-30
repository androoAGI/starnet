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
    // review round 4, MAJOR-2: a name the reader REFUSED (ok:false without notFound) is not a missing one. readNamed
    // marks it, with the reader's chat-safe shown name, so the host strips its line and says so; a refusal from one
    // agent outranks "not found" from another
    const hostRead = async (agentId, p) => {
      if (p === 'build/out.pdf') return { ok: false, error: '"build/out.pdf" has other names on this disk (a hard link), so it never leaves the station', shown: 'build/out.pdf' };
      if (p === 'id_rsa' && agentId === 'writer') return { ok: false, error: '"id_rsa" is a protected file', shown: 'id_rsa' };
      return { ok: false, error: '"' + p + '" is not in your workspace', shown: p, notFound: true };
    };
    const refusals = await M.readNamed(['MEDIA/none', 'build/out.pdf', 'id_rsa'], ['agent', 'writer'], hostRead);
    A.eq(refusals.missing.map(m => [m.path, !!m.refused, m.shown || '']), [['MEDIA/none', false, ''], ['build/out.pdf', true, 'build/out.pdf'], ['id_rsa', true, 'id_rsa']], 'readNamed: a refusal is marked refused with its shown name; a plain not-found is not');
    A.ok(/protected file/.test(refusals.missing[2].error), 'the refusal\'s own reason wins over the other agent\'s "not found"');
    const ruled = await M.readNamed(['build/out.pdf', 'busy.pdf'], ['agent'], async (a, p) => p === 'busy.pdf'
      ? { ok: false, error: '"busy.pdf" cannot be read (EBUSY)', shown: 'busy.pdf' }
      : { ok: false, error: '"build/out.pdf" has other names on this disk (a hard link), so it never leaves the station', shown: 'build/out.pdf', rule: true });
    A.eq(ruled.missing.map(m => [m.path, !!m.refused, !!m.rule]), [['build/out.pdf', true, true], ['busy.pdf', true, false]], 'readNamed carries the reader\'s `rule`: a send rule said no, or the file could not be read');
    // 0.14.2 review: a read that THREW is unread, never a refusal: the station never saw the file, so its line stays as written
    const threwNamed = await M.readNamed(['chart.png'], ['agent'], async () => { throw new Error("EPERM: operation not permitted, open 'D:\\proj\\chart.png'"); });
    A.ok(threwNamed.missing.length === 1 && threwNamed.missing[0].unread === true && threwNamed.missing[0].refused !== true, 'readNamed: a thrown read is unread, not refused: ' + JSON.stringify(threwNamed.missing[0]));
    A.ok((await M.readNamed(['a.png'], ['agent'], null)).missing[0].unread === true, 'and so is a name with no reader wired');
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
    /* 0.14.2 review: a read that THREW was a refusal: "Note: this file was refused by the station's send rules and was
       not attached — "chart.png": EPERM: operation not permitted, open '…'" — a rule the station never applied, and the
       raw exception (a host path in it) in the chat. It is unread: named with no claim, the exception kept for the console. */
    const eperm = "EPERM: operation not permitted, open 'D:\\proj\\out\\chart.png'";
    const threw = await M.sendFiles([{ path: 'chart.png', agents: ['a'] }], { read: async () => { throw new Error(eperm); }, send: async () => ({ ok: true }) });
    A.ok(threw.failed[0].unread === true && threw.failed[0].refused !== true && threw.failed[0].notFound !== true, 'a thrown read is unread, never refused nor notFound: ' + JSON.stringify(threw.failed[0]));
    A.ok(threw.failed[0].error.indexOf('EPERM') >= 0, 'the exception stays on the entry, for the console line');
    const threwNote = M.missedNote(threw.failed);
    A.eq(threwNote, 'Note: this file could not be attached here — "chart.png".', 'its chat line names it and claims nothing: ' + threwNote);
    A.ok(!/EPERM|D:|proj|send rules/.test(threwNote), 'and carries neither the exception, its path, nor a rule');
    // one folder threw and another said "not there": the station cannot say it is not there
    let calls = 0;
    const half = await M.sendFiles([{ path: 'c.png', agents: ['x', 'y'] }], { read: async () => { if (calls++ === 0) throw new Error('boom'); return { ok: false, error: '"c.png" is not in your workspace', shown: 'c.png', notFound: true }; }, send: async () => ({ ok: true }) });
    A.ok(half.failed[0].unread === true && half.failed[0].notFound !== true, 'a throw in one folder keeps the file unread, never "not found"');

    // each failure says what the station knows of the file (missedNote words the chat line from it), with the host
    // reader's contract (sidecar/egress-files.js read): notFound:true is "nothing by that name", any other ok:false a
    // refusal, and `rule` on it when a send rule said no (none when the reader could not read the file: EBUSY)
    const hostRead = async (agentId, rel) => rel === 'gone.png'
      ? { ok: false, error: '"gone.png" is not in your workspace', shown: 'gone.png', notFound: true }
      : rel === 'linked.pdf' ? { ok: false, error: '"linked.pdf" has other names on this disk (a hard link), so it never leaves the station', shown: 'linked.pdf', rule: true }
        : rel === 'busy.xlsx' ? { ok: false, error: '"busy.xlsx" cannot be read (EBUSY)', shown: 'busy.xlsx' }
          : { ok: true, buffer: Buffer.from([5]), name: rel, mime: 'image/png' };
    const told = await M.sendFiles([{ path: 'gone.png', agents: ['a'] }, { path: 'linked.pdf', agents: ['a'] }, { path: 'busy.xlsx', agents: ['a'] }, { path: 'up.png', agents: ['a'] }],
      { read: hostRead, send: async () => ({ ok: false, error: 'telegram cannot carry files' }) });
    A.eq(told.failed.map(f => [f.path, !!f.notFound, !!f.refused, !!f.rule]), [['gone.png', true, false, false], ['linked.pdf', false, true, true], ['busy.xlsx', false, true, false], ['up.png', false, false, false]],
      'a missing file is notFound, a refused one is refused (with rule only when a send rule said no), and a file read but not delivered carries no flag');
    A.ok(/hard link/.test(told.failed[1].reason) && told.failed[1].shown === 'linked.pdf', 'a refusal keeps the reader\'s own reason and chat-safe name');
    const busyNote = M.missedNote([told.failed[2]]);
    A.eq(busyNote, 'Note: this file was not attached — "busy.xlsx" cannot be read (EBUSY).', 'a file the reader could not read is named with its reason, and no rule: ' + busyNote);
    A.ok(unwired.failed[0].unread === true, 'a file never read (no host wiring) is marked unread, so nothing is claimed about where it is');
  }

  // ---- the chat note and the prompt note -----------------------------------------------------------------
  {
    A.eq(M.missedNote([]), '', 'nothing missed -> no note');
    const one = M.missedNote(['charts/missing.png']);
    A.ok(/this file could not be attached here/.test(one) && /"charts\/missing\.png"/.test(one) && /saved in the workspace/.test(one), 'one missed file is named, with where it is');
    A.ok(/these files/.test(M.missedNote(['a.png', 'b.png'])), 'several are named together');

    /* 0.14.2 review: a REFUSED file was told "It is saved in the workspace on the station" — for "../escape.txt" (a name
       that climbs out of the workspace) and for a hard link to a file outside it. The station only knows the send rules
       refused it, and the reader's reason: the note says exactly that, and nothing about where the file is. */
    const refused = M.missedNote([{ path: '../escape.txt', refused: true, rule: true, shown: '../escape.txt',
      reason: '"../escape.txt" climbs out of your workspace (..); only a file in your workspace can be sent' }]);
    A.ok(!/saved in the workspace/.test(refused) && !/could not be found/.test(refused), 'a refused file is never claimed saved on the station, nor missing: ' + refused);
    A.ok(/refused by the station's send rules/.test(refused) && /"\.\.\/escape\.txt" climbs out of your workspace/.test(refused), 'it says the send rules refused it, with the reader\'s reason: ' + refused);
    A.ok(/^Note: this file was refused by the station's send rules and was not attached — "z\.png"\.$/.test(M.missedNote([{ path: 'z.png', refused: true, rule: true }])), 'a refusal with no reason names the file alone');
    // a refusal WITHOUT rule (the reader could not read or prove the file) claims no rule (0.14.2 review: EBUSY)
    const busy = M.missedNote([{ path: 'report.xlsx', refused: true, shown: 'report.xlsx', reason: '"report.xlsx" cannot be read (EBUSY)' }]);
    A.eq(busy, 'Note: this file was not attached — "report.xlsx" cannot be read (EBUSY).', 'a file that could not be read is told so, with no rule: ' + busy);
    const mixed = M.missedNote([
      { path: 'up.png', error: 'telegram cannot carry files' },
      { path: 'gone.png', notFound: true, error: 'could not be read from the workspace ("gone.png" is not in your workspace)' },
      { path: 'never.png', unread: true },
      { path: 'linked.pdf', refused: true, rule: true, shown: 'linked.pdf', reason: '"linked.pdf" has other names on this disk (a hard link), so it never leaves the station' },
      { path: 'busy.xlsx', refused: true, shown: 'busy.xlsx', reason: '"busy.xlsx" changed while it was being read; nothing was sent' }]);
    const lines = mixed.split('\n');
    A.eq(lines.length, 5, 'one line for each kind of miss: ' + JSON.stringify(mixed));
    A.ok(/"up\.png"\. It is saved in the workspace on the station\.$/.test(lines[0]), 'only the file the station read and could not deliver is said to be on the station');
    A.ok(/could not be attached here — "never\.png"\.$/.test(lines[1]), 'a file never read is named with no claim about where it is');
    A.ok(/could not be found in the workspace, so nothing was attached — "gone\.png"\.$/.test(lines[2]), 'a missing file is said not to be found');
    A.ok(/refused by the station's send rules and was not attached — "linked\.pdf" has other names on this disk/.test(lines[3]), 'a refused one carries its reason');
    A.ok(/^Note: this file was not attached — "busy\.xlsx" changed while it was being read/.test(lines[4]) && !/send rules/.test(lines[4]), 'one the reader could not read carries its reason and no rule');
    A.ok(lines.every(l => /^Note: /.test(l)), 'every line is a Note');
    A.ok(/"x\.png"/.test(M.missedNote([{ path: '/srv/ws/agent/x.png', refused: true, shown: '/srv/ws/agent/x.png' }])) && !/\/srv\//.test(M.missedNote([{ path: '/srv/ws/agent/x.png', refused: true }])),
      'an absolute path is never quoted, refused or not (run-paths review S3)');

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
