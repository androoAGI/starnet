'use strict';
/* node test/workstreams-packed-uploads.test.js - THE UPLOADS OF A SESSION THAT IS STILL PACKED (save v7, frontend/app/workstreams.js).

   A photo sent on 0.14 is named by the page's row and by no transcript row (0.14 wrote none), so the page's delete is the only route that can
   remove it. Once the row is sealed, the save packs it with the file in the row's residue, and after a restart the row is not in w.history until
   it is read back. RED before: attachmentRefs answered [] for that session, so a chat deleted from the rail without being opened kept its upload
   for good, and attachmentInUse could not see that a packed session shares a file. Both shipped trees run. */
const path = require('node:path');
const A = require('./_assert.js');

for (const root of ['frontend/app', 'website/app/app']) {
  globalThis.HistoryRef = require(path.join(__dirname, '..', root, 'historyref.js'));
  const W = require(path.join(__dirname, '..', root, 'workstreams.js'));
  const img = { id: 'a', name: 'passport.jpg', path: '.attachments/11111111-1111-4111-8111-111111111111.jpg', mediaType: 'image/jpeg', kind: 'image' };
  const turn = { role: 'user', content: 'look at this', ts: 1700000000000, rowId: 501, streamId: 'ws_old', agentId: 'agent', sourceRunId: 'run_1', kind: 'turn' };
  W.init({ workstreams: [
    { id: 'ws_general', title: null, lane: 'active', history: [] },
    { id: 'ws_old', title: 'Old chat', agentId: 'agent', lane: 'active', history: [Object.assign({}, turn, { attachments: [img] })] }
  ], activeId: 'ws_general', generalId: 'ws_general' });
  A.eq(W.attachmentRefs('ws_old'), [{ path: img.path, agent: 'agent' }], root + ': an inline row names its file');
  A.eq(W.sealTurns('ws_old', [turn]), 1, root + ': the station proved the row');
  const saved = JSON.parse(JSON.stringify(W.serialize()));
  const held = saved.workstreams.find(w => w.id === 'ws_old').history;
  A.ok(held.length === 1 && typeof held[0].$ref === 'string' && !!held[0].res, root + ': premise: the save names the row and keeps the file in its residue: ' + JSON.stringify(held).slice(0, 120));
  W.init(saved);
  A.eq(W.needsHydration('ws_old'), true, root + ': premise: after the restart the row is not read back');
  A.eq(W.attachmentRefs('ws_old'), [{ path: img.path, agent: 'agent' }], root + ': a packed run\'s residue names the file for the delete');
  A.eq(W.attachmentInUse(img.path, 'agent'), true, root + ': a packed session still names the file for another session\'s delete');
  A.eq(W.attachmentInUse(img.path, 'scout'), false, root + ': ...for that agent only');
  A.eq(W.del('ws_old', { forget: true }), true, root + ': the session is deleted');
  A.eq(W.attachmentInUse(img.path, 'agent'), false, root + ': and then nothing names it');
  // a stub (an element an engine exploded) holds its row's residue on itself, not under `res`
  W.init({ workstreams: [
    { id: 'ws_general', title: null, lane: 'active', history: [] },
    { id: 'ws_stub', title: 'Stub', agentId: 'agent', lane: 'active', history: [{ streamId: 'ws_stub', rowId: 777, role: 'user', content: 'look', attachments: [img], $stub: true }] }
  ], activeId: 'ws_general', generalId: 'ws_general' });
  A.eq(W.attachmentRefs('ws_stub'), [{ path: img.path, agent: 'agent' }], root + ': a stub names its file for the delete');
  A.eq(W.attachmentInUse(img.path, 'agent'), true, root + ': a stub still names its file for another session\'s delete');
}
A.report('workstreams-packed-uploads');
