/* node test/history-edit.test.js — unit cover for sidecar/history-edit.js (W1.7 context groundwork): headTail (and the
   registry clamp and turn squeeze that cut through it), elideToolResult (the ONE stub/handle builder; W1.8 cross-run
   replay reuses it), foldRequest and the request view. The end-to-end invariants (real loop, binding upstream, real
   fs.read read-back) live in history-edit.invariant.test.js. Pure: no network, no files. */
'use strict';
const A = require('./_assert.js');
const HE = require('../sidecar/history-edit.js');
const { headTail, elideToolResult, foldRequest, makeRequestView, isElided, ELIDED, ELIDE_HEAD } = HE;

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const firstLine = s => String(s).split('\n')[0];

(async () => {
  // ================= headTail =================
  {
    A.eq(headTail('abc', 10), 'abc', 'headTail: under the cap the text is unchanged');
    A.eq(headTail('abcdefghij', 10), 'abcdefghij', 'headTail: exactly at the cap the text is unchanged');
    const s = 'H'.repeat(700) + 'M'.repeat(5000) + 'T'.repeat(300);
    A.eq(headTail(s, 1000, d => '<' + d + '>'), 'H'.repeat(700) + '<5000>' + 'T'.repeat(300), 'headTail: the first 70% and the last 30% of the cap, the dropped count handed to the marker');
    const dflt = headTail(s, 1000);
    A.ok(dflt.indexOf('5000 characters from the middle are not shown here; the end follows') > 0, 'headTail: the default marker names the gap');
    A.ok(dflt.indexOf('H'.repeat(700)) === 0 && dflt.slice(-300) === 'T'.repeat(300) && dflt.indexOf('M') < 0, 'headTail: the default marker sits between the head and the tail, the middle is gone');
    A.eq(headTail(s, 0), s, 'headTail: a non-positive cap leaves the text alone');
    A.eq(headTail(null, 5), '', 'headTail: null is the empty string');
    // a surrogate pair on either cut is never split: head 7 -> 6 (index 6 is a high surrogate), tail start 29 -> 30
    const E = '😀';
    const t = 'aaaaaa' + E + 'b'.repeat(20) + E + 'cc';
    const cut = headTail(t, 10, d => '<' + d + '>');
    A.eq(cut, 'aaaaaa<24>cc', 'headTail: the cut moves off a surrogate pair on both sides');
    A.ok(!lone.test(cut), 'headTail: no lone surrogate survives a cut');
    const whole = headTail('x'.repeat(5) + E + 'y'.repeat(30) + E + 'z', 12, () => '|');
    A.ok(!lone.test(whole), 'headTail: no lone surrogate at other boundaries either');

    // THE one 70/30 cut: the registry's clamp (through its real dispatch) and the loop's turn squeeze cut through headTail
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const { squeeze } = require('../sidecar/loop.js')._internals;
    const split = [];
    for (const cap of [8000, 8001, 9000, 9001, 12345, 12346]) {
      const reg = makeRegistry();
      reg.register({ impact: 'none', name: 'big', schema: { type: 'object' }, run: async () => E.repeat(cap) });
      const r = await reg.dispatch({ name: 'big', args: {}, argsRaw: '{}' }, { agentId: 'a', canUse: () => ({ ok: true }), canRun: () => ({ ok: true }), outputMax: cap });
      if (!r.ok || r.content.length >= cap * 2) split.push('clamp ' + cap + ': not cut');
      else if (lone.test(r.content)) split.push('clamp ' + cap);
    }
    for (const budget of [1000, 1001, 1002, 1003]) if (lone.test(squeeze(E.repeat(2000), budget, null, 0))) split.push('squeeze ' + budget);
    A.eq(split, [], 'one cut: neither the registry clamp nor the turn squeeze splits a surrogate pair');
  }

  // ================= elideToolResult =================
  {
    const body = 'line one of the result\n' + 'R'.repeat(600) + '\nlast line';
    A.eq(await elideToolResult('x'.repeat(ELIDE_HEAD), { name: 'noop' }), null, 'elide: a body the 240-char head keeps whole is not elided (a stub could only add bytes)');
    const plain = await elideToolResult(body, { name: 'noop' });
    A.ok(plain && plain.handle === null, 'elide: no handle and no parker -> no handle');
    A.eq(firstLine(plain.content), ELIDED + 'noop, ' + body.length + ' bytes; first ' + ELIDE_HEAD + ' chars kept below; re-run the tool for the full output]', 'elide: without a handle the stub keeps the old wording');
    A.eq(plain.content.split('\n').slice(1).join('\n'), body.slice(0, ELIDE_HEAD).replace(/\s+$/, '') + '…', 'elide: the stub keeps the first 240 chars');
    A.ok(isElided({ role: 'tool', content: plain.content }), 'elide: isElided recognises a stub');
    A.ok(!isElided({ role: 'tool', content: body }) && !isElided({ role: 'assistant', content: plain.content }), 'elide: and nothing else');
    const utf = 'é'.repeat(300);
    A.ok(firstLine((await elideToolResult(utf, { name: 'noop' })).content).indexOf(', 600 bytes;') > 0, 'elide: the stub counts UTF-8 bytes, not characters');
    const obj = await elideToolResult({ rows: 'Q'.repeat(400) }, { name: 'db' });
    A.ok(obj && obj.content.indexOf('{"rows":"QQQ') > 0, 'elide: a non-string body is elided as its JSON');

    // the host's own park of the full output is the handle when there is one
    const parked = await elideToolResult(body, { name: 'build', parkedPath: '.starnet/outputs/a/build-r1-0.txt' });
    A.eq(parked.handle, { via: 'parked', path: '.starnet/outputs/a/build-r1-0.txt', call: 'fs.read {"path":".starnet/outputs/a/build-r1-0.txt"}' }, 'elide: a parked path is the handle');
    A.ok(/; the output saved before it was cut: read it with fs\.read \{"path":"\.starnet\/outputs\/a\/build-r1-0\.txt"\}\]$/.test(firstLine(parked.content)), 'elide: and the stub says the file holds the output before the cut');

    // anything else is parked whole at elision — an fs.read result too: the file it read can change, its page follows the window
    const calls = [];
    const park = async (text, meta) => { calls.push({ text, meta }); return { path: '.starnet/outputs/a/p' + calls.length + '.txt' }; };
    const read = await elideToolResult(body, { name: 'fs.read', args: { path: 'src/a.js', offset: 10, limit: 50 }, park, parkMeta: { taintedBy: 'web_fetch' } });
    A.eq(read.handle, { via: 'saved', path: '.starnet/outputs/a/p1.txt', call: 'fs.read {"path":".starnet/outputs/a/p1.txt"}' }, 'elide: an fs.read result is parked like any other, never re-read from its source');
    A.ok(read.content.indexOf('src/a.js') < 0, 'elide: the stub never names the file the result was read from');
    A.ok(calls[0].text === body, 'elide: the park holds the exact elided body');
    A.eq(calls[0].meta, { taintedBy: 'web_fetch', tool: 'fs.read', reason: 'elided-at-compaction' }, 'elide: the park carries the provenance, the tool and the reason');
    A.ok(/; the whole result is saved: read it with fs\.read \{"path":"\.starnet\/outputs\/a\/p1\.txt"\}\]$/.test(firstLine(read.content)), 'elide: the stub says the whole result is saved');
    const noParker = await elideToolResult(body, { name: 'fs_read', args: { path: 'b.txt' } });
    A.ok(noParker.handle === null && /re-run the tool for the full output\]$/.test(firstLine(noParker.content)), 'elide: without a parker an fs.read result keeps the old wording too (no re-read handle)');
    const viaParker = await elideToolResult(body, { name: 'build', parkedPath: '.starnet/outputs/a/b.txt', park });
    A.ok(viaParker.handle.via === 'parked' && calls.length === 1, 'elide: a result the host already parked is not parked again');

    // a body a UTF-8 file cannot hold as it is (a lone surrogate) is never parked: the read-back would differ
    const loneBody = 'x'.repeat(300) + '\uD83D' + 'y'.repeat(10);
    const lonely = await elideToolResult(loneBody, { name: 'noop', park });
    A.ok(lonely.handle === null && calls.length === 1, 'elide: a lone surrogate keeps the body off disk (no park, no handle)');
    const pair = await elideToolResult('x'.repeat(300) + '😀', { name: 'noop', park });
    A.ok(pair.handle && pair.handle.via === 'saved' && calls.length === 2, 'elide: a whole surrogate pair parks normally');

    // quoted words are never parked; a parker that fails or declines leaves the old wording
    const before = calls.length;
    const quoted = await elideToolResult(body, { name: 'recall', park, parkMeta: { quotedStreams: ['stream-2'] } });
    A.ok(quoted.handle === null && calls.length === before, 'elide: words quoted from another session are never handed to the parker');
    A.ok(/re-run the tool for the full output\]$/.test(firstLine(quoted.content)), 'elide: and keep the old wording');
    const threw = await elideToolResult(body, { name: 'noop', park: async () => { throw new Error('disk full'); } });
    A.ok(threw && threw.handle === null, 'elide: a parker that throws leaves no handle (and does not throw)');
    const declined = await elideToolResult(body, { name: 'noop', park: async () => null });
    A.ok(declined && declined.handle === null, 'elide: a parker that declines leaves no handle');
  }

  // ================= foldRequest =================
  {
    const req = { model: 'm', messages: [] };
    A.ok(foldRequest(req) === req && req.neverReread === true, 'foldRequest: marks the request never re-read, in place');
    A.eq(foldRequest(null), null, 'foldRequest: tolerates nothing');
  }

  // ================= the request view =================
  {
    const sym = Symbol('host-marker');
    const think = n => [{ type: 'thinking', thinking: '', signature: 'sig' + n }];
    const asst = (text, n) => ({ role: 'assistant', content: text, reasoning: think(n) });
    const sys = { role: 'system', content: 'S' };
    const u0 = { role: 'user', content: 'task' };
    const a1 = asst('one', 1), t1 = { role: 'tool', tool_call_id: 'c1', content: 'R1' };
    const a2 = asst('two', 2), t2 = { role: 'tool', tool_call_id: 'c2', content: 'R2' };
    a2[sym] = 'kept';
    const tools = [{ type: 'function', function: { name: 'x' } }];

    // a provider that does not bind gets the list itself, untouched
    const off = makeRequestView();
    const offList = [sys, u0, a1, t1];
    const offOut = off.messages(offList, { tools, binds: false });
    A.ok(offOut.messages === offList && offOut.editAt === -1 && offOut.stripped === 0, 'view: a non-binding provider gets the list itself');

    const view = makeRequestView();
    const r1 = view.messages([sys, u0, a1, t1], { tools, binds: true });
    A.ok(r1.messages.length === 4 && r1.editAt === -1 && r1.stripped === 0, 'view: the first request is nobody\'s edit');
    const l2 = [sys, u0, a1, t1, a2, t2];
    const r2 = view.messages(l2, { tools, binds: true });
    A.ok(r2.messages === l2 && r2.editAt === -1 && r2.stripped === 0, 'view: an append-only request is the list itself');

    // an edit at 3 (t1 elided into a new object) strips the blocks at or after it — a2's — and nothing before it
    const t1e = { role: 'tool', tool_call_id: 'c1', content: '[elided] R1' };
    const a3 = asst('three', 3), t3 = { role: 'tool', tool_call_id: 'c3', content: 'R3' };
    const l3 = [sys, u0, a1, t1e, a2, t2];
    const r3 = view.messages(l3, { tools, binds: true });
    A.eq([r3.editAt, r3.stripped], [3, 1], 'view: the edit is found at the first changed message and one turn is stripped');
    A.ok(r3.messages === l3 && r3.messages[2] === a1 && r3.messages[4] === a2, 'view: the list itself goes out, the same objects');
    A.ok(!('reasoning' in a2) && a2.content === 'two', 'view: the stripped block is deleted from its own turn, in place (text kept), so a journal snapshot holds it gone');
    A.ok(a2[sym] === 'kept', 'view: host markers stay where they are (the turn is the same object)');
    A.ok(Array.isArray(a1.reasoning) && a1.reasoning.length === 1, 'view: the block before the edit is untouched');

    // sticky: the next (append-only) request is not taken for an edit, and the new block goes out intact
    const l4 = [sys, u0, a1, t1e, a2, t2, a3, t3];
    const r4 = view.messages(l4, { tools, binds: true });
    A.eq([r4.editAt, r4.stripped], [-1, 0], 'view: an append-only request after an edit strips nothing new (a deletion is not an edit)');
    A.ok(r4.messages === l4 && !('reasoning' in a2), 'view: a stripped turn stays stripped');
    A.ok(Array.isArray(a3.reasoning) && Array.isArray(a1.reasoning), 'view: the block produced after the edit, and the one before it, go out intact');

    // an assistant turn rewritten in place (collapseContinuation) is an edit at its own index: its block goes too
    a3.content = 'three, continued';
    const r5 = view.messages(l4, { tools, binds: true });
    A.eq([r5.editAt, r5.stripped], [6, 1], 'view: an in-place rewrite is seen (the fingerprint memo follows the content)');
    A.ok(!('reasoning' in a3) && a3.content === 'three, continued', 'view: and its own block is stripped (the documented over-strip)');

    // a change to the tools is an edit at 0: every block goes
    const r6 = view.messages(l4, { tools: tools.concat([{ type: 'function', function: { name: 'y' } }]), binds: true });
    A.eq([r6.editAt, r6.stripped], [0, 1], 'view: a tools change is an edit at 0 (only a1 still had a block)');
    A.ok(r6.messages.every(m => !m || !('reasoning' in m)), 'view: no block survives a tools change');

    // a pure shrink (a cut tail, nothing changed before it) is not an edit
    const v2 = makeRequestView();
    v2.messages([sys, u0, a1, t1, a2, t2], { tools, binds: true });
    const shrink = v2.messages([sys, u0, a1, t1], { tools, binds: true });
    A.eq([shrink.editAt, shrink.stripped], [-1, 0], 'view: dropping messages off the end changes no block\'s prefix');

    // a provider switch that stops binding resets the view; nothing is carried into a later binding stretch
    v2.messages([sys, u0], { tools, binds: false });
    const again = v2.messages([sys, u0, a1], { tools, binds: true });
    A.eq([again.editAt, again.stripped], [-1, 0], 'view: a non-binding request clears the baseline');
  }

  A.report('history-edit.test');
})().catch(e => { console.log('FAIL: history-edit.test threw -- ' + (e && e.stack || e)); process.exit(1); });
