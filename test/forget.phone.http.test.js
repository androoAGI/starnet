'use strict';
/* node test/forget.phone.http.test.js — THE PHONE'S THREAD AND ITS REPLAY FORGET WHAT QUOTES A DELETED SESSION (turn identity commit 11, host.js).

   The rest of commit 11 is proved on the page's routes (test/forget.tool-quotes.http.test.js); this is the same rule over the phone's: a real sealed phone,
   the real remote host, and a provider the test controls. Rows are seeded straight into the transcript while the station is stopped (the stamp is what a
   run that read the session leaves: quotes + quotesAt), the desk's save holds its own cached copies of the stamped reply (the keyed copy the page keeps, which
   the merge folds into the station's row, and an id-less provisional one), and the Commander deletes the quoted session with the save the page sends.

     before   the phone's thread holds the stamped reply (the station's row, with the desk's keyed copy folded into it) and the desk's id-less user row
     after    thread: no word of the deleted session. The station's row is hidden by the quote rule, so the desk's keyed copy has no twin left and would
              survive the merge as a desk-only row: it is the identity.forgotten list the host carries to the merge (TurnMerge R2) that drops it. The Commander's
              own typed words, the unstamped answer and the desk's id-less USER row of the same run stay
     send     a phone send under window:shadow and window:id hands the provider no word of the deleted session and still hands it the unstamped answer
   RED at the previous commit: the host's display read never carried what the quote rule hid, and the store did not hide a stamped row at all. */
const A = require('./_assert.js');
const { TurnHttpFixture } = require('./helpers/turn-http-fixture.js');

const SENT = 'Wallaby-Phone-Nine';
const textOf = rows => (Array.isArray(rows) ? rows : []).map(r => String(r && r.content)).join('\n');

(async () => {
  const fx = new TurnHttpFixture('forget-phone', () => 0.3);
  try {
    await fx.start();
    const at = Date.now() - 60000;
    await fx.seedRows([
      { streamId: 'q', agentId: 'agent', role: 'user', content: 'tell me the phone codeword', turnId: 'seed_q_0001', directive: true, kind: 'turn', ts: at, taint: null, taintKnown: true },
      { streamId: 'q', agentId: 'agent', role: 'assistant', content: 'The phone codeword is ' + SENT, turnId: 'seed_q_0001', kind: 'turn', ts: at + 1, taint: null, taintKnown: true },
      { streamId: 's', agentId: 'agent', role: 'user', content: 'PHONE_ASK_ONE', turnId: 'seed_s_0001', directive: true, kind: 'turn', ts: at + 10, taint: null, taintKnown: true },
      { streamId: 's', agentId: 'agent', role: 'assistant', content: 'I recall the codeword ' + SENT, turnId: 'seed_s_0001', kind: 'turn', ts: at + 11, sourceRunId: 'seedrun1', quotes: ['q'], quotesAt: [at + 5], taint: null, taintKnown: true },
      { streamId: 's', agentId: 'agent', role: 'user', content: 'PHONE_ASK_TWO', turnId: 'seed_s_0002', directive: true, kind: 'turn', ts: at + 20, taint: null, taintKnown: true },
      { streamId: 's', agentId: 'agent', role: 'assistant', content: 'PHONE_PLAIN_ANSWER', turnId: 'seed_s_0002', kind: 'turn', ts: at + 21, taint: null, taintKnown: true }
    ]);
    const canon = await fx.read('s');
    const reply = canon.turns.find(r => r.role === 'assistant' && String(r.content).includes(SENT));
    A.ok(reply && Number.isSafeInteger(reply.rowId) && reply.quotes && reply.quotes[0] === 'q', 'setup: the stamped reply is a keyed row of the phone\'s stream, with its stamp');

    // the desk's save holds its own cached copies of the reply: a keyed one (what the page keeps) and an id-less provisional one of the same run, and an id-less user row of that run
    let save = (await fx.json('GET', '/api/save?agent=agent')).save;
    const saveWith = async (workstreams, extra) => {
      const body = await fx.json('POST', '/api/save', Object.assign({ schema: 'starnet.save', version: 6, _saveRevision: save._saveRevision, updatedAt: Math.max(Date.now(), save.updatedAt + 1),
        agent: { id: 'agent', createdAt: 1, name: 'TURN' }, workstreams }, extra || null));
      save = (await fx.json('GET', '/api/save?agent=agent')).save;
      return body;
    };
    const deskHistory = [
      { role: 'assistant', content: reply.content, rowId: reply.rowId, streamId: 's', turnId: reply.turnId, sourceRunId: 'seedrun1', ts: reply.ts },
      { role: 'assistant', content: 'a provisional copy: ' + SENT, sourceRunId: 'seedrun1', ts: at + 12 },
      { role: 'user', content: 'PHONE_DESK_USER_NOTE', sourceRunId: 'seedrun1', ts: at + 13 }
    ];
    const sessions = () => [{ id: 's', agentId: 'agent', title: 'Phone', history: deskHistory }, { id: 'q', agentId: 'agent', title: 'Quokka', history: [] }];
    await saveWith(sessions());

    // ---------------- before the delete
    const before = await fx.phoneCall('thread', { streamId: 's', limit: 100 });
    A.ok(textOf(before).includes(SENT), 'before the delete the phone\'s thread holds the stamped reply (so its absence afterwards means something)');
    A.ok(before.some(r => r.content === 'PHONE_DESK_USER_NOTE'), '...and the desk\'s id-less user row of that run (the merge keeps a desk row the station has no twin of)');
    A.eq(before.filter(r => String(r.content).includes(SENT)).length, 1, '...the reply once: the desk\'s keyed copy folds into the station\'s row, and the id-less provisional copy of a reply the station holds is not a second line');

    // ---------------- the delete (the Commander's Delete: the save without q, with q in deletedIds and forgetIds)
    await saveWith([{ id: 's', agentId: 'agent', title: 'Phone', history: deskHistory }], { deletedIds: ['q'], forgetIds: ['q'] });
    const after = await fx.read('s');
    A.ok(after.identity && after.identity.forgotten && after.identity.forgotten.keys.some(k => k[1] === reply.rowId) && after.identity.forgotten.runIds.includes('seedrun1'), 'GET identity lists the row the quote rule hid and the run it came from');
    const thread = await fx.phoneCall('thread', { streamId: 's', limit: 100 });
    A.ok(!textOf(thread).includes(SENT), 'the phone\'s thread holds no word of the deleted session (the station\'s row, the desk\'s keyed copy and its id-less copy are all gone): ' + textOf(thread).slice(0, 300).replace(/\n/g, ' | '));
    A.ok(thread.some(r => r.content === 'PHONE_ASK_ONE') && thread.some(r => r.content === 'PHONE_ASK_TWO') && thread.some(r => r.content === 'PHONE_PLAIN_ANSWER'), 'the Commander\'s typed words and the unstamped answer stay');
    A.ok(thread.some(r => r.content === 'PHONE_DESK_USER_NOTE'), 'the desk\'s id-less USER row of the forgotten run stays (a user row is never a copy a run took by reading a session)');

    // ---------------- a phone send: the provider is handed nothing of the deleted session
    for (const mode of ['shadow', 'id']) {
      await fx.json('POST', '/api/turn-identity/mode', { surface: 'window', mode });
      const mark = fx.requests.length, text = 'PHONE_ASK_' + mode.toUpperCase();
      await fx.phoneSend(text);
      const mine = fx.requests.slice(mark).filter(b => JSON.stringify(b.messages).includes(text));
      A.ok(mine.length > 0, 'window:' + mode + ': the phone\'s send reached the provider');
      A.ok(mine.every(b => !JSON.stringify(b.messages).includes(SENT)), 'window:' + mode + ': no provider body holds a word of the deleted session');
      A.ok(mine.some(b => JSON.stringify(b.messages).includes('PHONE_PLAIN_ANSWER')), 'window:' + mode + ': ...and the unstamped answer is still in the replay');
    }
  } catch (e) {
    console.error(e && e.stack || e);
    process.exitCode = 1;
  } finally {
    await fx.dispose();
  }
  A.report('forget.phone.http');
})().catch(e => { console.error(e); process.exit(1); });
