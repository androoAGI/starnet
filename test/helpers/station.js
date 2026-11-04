/* test/helpers/station.js — seed a FOUNDED station into a workspace, for a test that drives an unattended writer.

   The night shift, environment discovery and the quest refresh stand down on a workspace with no station: the live station
   record says none and no save or roster is on disk (sidecar/station-record.js, P1; test/stationless-boot-census.http.test.js
   proves a station-less session writes no station state). A test that drives one of their ticks on a fresh workspace seeds
   the station a Commander would have founded first:
   - the station record exactly as the contract fixture's active case writes it (test/fixtures/station-record-cases.json),
     re-rooted to this workspace's canonical root, so the sidecar's boot reads it as it is (no copied-record re-mint);
   - the station file whose first accepted write founded it, in the save store's on-disk wrapper, with the floor a founded station has
     saved in it. The saved floor is the routing authority (sidecar/routing/saved-authority.js): a save that holds NO floor is one that
     cannot be proved, and every dispatch through the router (a channel message, Run Now, a scheduled fire) would be refused until a
     page saved one. The floor here is the empty one: the starter room, nothing drawn, so nothing routes and everything runs as it did
     with no plan. (The held states are proved over a real sidecar by test/routing.saved-floor-authority.e2e.test.js.)
   seedActiveStation(ws) -> { record, save } */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SR = require('../../sidecar/station-record.js');
const fixture = require('../fixtures/station-record-cases.json');
const { emptyFloor } = require('./saved-floor.js');

const ACTIVE_CASE = 'an active record';

function activeRecord(ws) {
  const c = fixture.cases.find(x => x.name === ACTIVE_CASE);
  const spec = c && c.files && c.files['workspaces/' + SR.RECORD_FILE];
  if (!spec || !spec.json || spec.json.state !== 'active') throw new Error('test/helpers/station.js: the contract fixture has no "' + ACTIVE_CASE + '" case');
  const record = Object.assign({}, spec.json, { root: SR.canonicalRoot(fs, path, ws) });
  const invalid = SR._internals.invalidRecord(record);
  if (invalid) throw new Error('test/helpers/station.js: the fixture\'s active record is not a valid record (' + invalid + ')');
  return record;
}

function seedActiveStation(ws) {
  fs.mkdirSync(ws, { recursive: true });
  const record = activeRecord(ws);
  const at = record.since;
  const save = {
    schema: 'starnet.save', version: require('../../frontend/app/save.js').CURRENT, updatedAt: at, _saveRevision: 1, _saveDirty: false, _saveClient: 'seed-window',
    agent: { id: 'agent', name: 'SEEDED', createdAt: at }, agents: [], workstreams: [{ id: 'general', history: [] }],
    activeId: 'general', generalId: 'general', station: emptyFloor()
  };
  fs.writeFileSync(path.join(ws, SR.RECORD_FILE), JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(path.join(ws, 'agent.save.json'), JSON.stringify({ version: 1, agentId: 'agent', updatedAt: at, savedAt: at, requestUpdatedAt: at, revision: 1, client: 'seed-window', doc: save }));
  return { record, save };
}

module.exports = { seedActiveStation };
