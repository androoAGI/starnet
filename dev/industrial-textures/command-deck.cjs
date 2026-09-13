'use strict';
// Only the isolated art-preview station uses this composition. Customer saves
// keep their own rooms, placements and workstation assignments.
module.exports = function commandDeck() {
  return [
    { id: 'p33', t: 'bridge_deckperimeter', x: 5, y: 5, w: 12, h: 8, block: false },
    { id: 'p20', t: 'bridge_consolebank', x: 2, y: 0, w: 9, h: 1, block: true },
    { id: 'p21', t: 'bridge_consolebank', x: 11, y: 0, w: 9, h: 1, block: true },
    { id: 'p1', t: 'desk', x: 10, y: 3, w: 3, h: 1, block: true, agentId: 'agent' },
    { id: 'p2', t: 'desk2', x: 3, y: 3, w: 3, h: 1, block: true },
    { id: 'p3', t: 'desk2', x: 17, y: 3, w: 3, h: 1, block: true },
    { id: 'p10', t: 'chair', x: 4, y: 4, w: 1, h: 1, r: 2, block: true },
    { id: 'p11', t: 'chair', x: 18, y: 4, w: 1, h: 1, r: 2, block: true },
    { id: 'p22', t: 'bridge_tacticaltable', x: 8, y: 7, w: 7, h: 4, block: true },
    { id: 'p23', t: 'chair', x: 6, y: 8, w: 1, h: 1, r: 3, block: true },
    { id: 'p24', t: 'chair', x: 16, y: 8, w: 1, h: 1, r: 1, block: true },
    { id: 'p25', t: 'bridge_equipmentbay', x: 1, y: 7, w: 4, h: 1, block: true },
    { id: 'p26', t: 'bridge_equipmentbay', x: 17, y: 7, w: 4, h: 1, block: true },
    { id: 'p27', t: 'bridge_equipmentbay', x: 1, y: 11, w: 4, h: 1, block: true },
    { id: 'p28', t: 'bridge_equipmentbay', x: 17, y: 11, w: 4, h: 1, block: true },
    { id: 'p29', t: 'desk2', x: 2, y: 14, w: 3, h: 1, block: true },
    { id: 'p30', t: 'desk2', x: 17, y: 14, w: 3, h: 1, block: true },
    { id: 'p31', t: 'chair', x: 3, y: 15, w: 1, h: 1, r: 2, block: true },
    { id: 'p32', t: 'chair', x: 18, y: 15, w: 1, h: 1, r: 2, block: true }
  ];
};
