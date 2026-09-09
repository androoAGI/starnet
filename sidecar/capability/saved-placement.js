'use strict';
const { makeStationStore } = require('../station-store.js');
// The same room scope World.heroCaps uses. A missing client snapshot may use the
// durable floor; an explicitly empty snapshot must never resurrect removed gear.
function savedPlacement(save, agentId) {
  if (!save || !save.station) return [];
  const checked = makeStationStore().validateStationDoc(save.station);
  if (!checked.ok) return [];
  const station = checked.station;
  const types = station.agentRoomId(agentId)
    ? station.bayObjects(agentId)
    : station.props().map(p => station.capForProp(p.t));
  return [...new Set(types.map(o => typeof o === 'string' ? o : o && o.objectType)
    .filter(t => t && t !== 'computer' && t !== 'connector'))]
    .map(objectType => ({ objectType }));
}
module.exports = { savedPlacement };
