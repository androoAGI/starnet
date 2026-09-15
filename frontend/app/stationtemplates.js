/* Furnished station builds. Room count excludes connecting corridors.
   These describe physical layouts, not hired staff or running workflows. */
'use strict';
const StationTemplates = (() => {
  const catalog = [
    { id: 'default', name: 'DEFAULT', rooms: 1, description: 'One open room. All five essentials, your workstation, and space to grow.', wings: [] },
    { id: 'retreat', name: 'QUIET RETREAT', rooms: 2, description: 'Your home station with a quiet library and lounge to the south.', wings: [['reading','south']] },
    { id: 'cozy', name: 'COZY WORKSHOP', rooms: 3, description: 'Warm wood floors, a furnished lounge, and an Inbox → Bay → Outbox conveyor workshop. Assign an agent to the bay to use the line.', wings: [['cozyWorkshop','north'],['cozyLounge','south']] },
    { id: 'creative', name: 'CREATIVE STUDIO', rooms: 3, description: 'A writing and design studio on one side, a review room on the other.', wings: [['creative','west'],['review','east']] },
    { id: 'research', name: 'RESEARCH STATION', rooms: 3, description: 'An analysis lab to the north and a dedicated reference archive to the east.', wings: [['research','north'],['archive','east']] },
    { id: 'engineering', name: 'ENGINEERING STATION', rooms: 5, description: 'Workshop, analysis lab, review room, and quiet lounge around your home station.', wings: [['engineering','west'],['review','east'],['research','north'],['reading','south']] },
    { id: 'operations', name: 'OPERATIONS STATION', rooms: 5, description: 'Planning, communications, reference, and review rooms around a central home station.', wings: [['archive','west'],['comms','east'],['planning','north'],['review','south']] }
  ];
  const rooms = {
    cozyWorkshop: { name: 'WORKROOM', kind: 'factory', floorStyle: 'walnut', floorMat: 'plank', blueprint: ['front_desk',3,1], props: [['plant',1,1],['plant',16,1],['desk',2,7],['industrial_drawerbank',12,7],['bookshelf',14,9]] },
    cozyLounge: { name: 'LOUNGE', kind: 'quarters', floorStyle: 'walnut', floorMat: 'plank', props: [['tv',2,1],['rug',1,2],['couch',1,5],['industrial_roundtable',11,4],['dinerchair',10,4,3],['dinerchair',13,4,1],['coffee',14,4],['bookshelf',12,1],['plant',16,1],['bunk',13,7],['plant',1,8]] },
    reading: { name: 'LIBRARY', kind: 'quarters', floorStyle: 'walnut', floorMat: 'plank', props: [['couch',1,1],['bookshelf',13,1],['plant',16,8],['industrial_roundtable',2,4]] },
    creative: { name: 'STUDIO', kind: 'lab', floorStyle: 'hull', floorMat: 'resin', props: [['desk',3,1],['easel',11,1],['plant',16,1],['bookshelf',1,8],['industrial_drawerbank',11,8]] },
    review: { name: 'REVIEW', kind: 'hab', floorStyle: 'ash', floorMat: 'resin', props: [['desk',2,1],['whiteboard',11,0],['plant',16,1],['industrial_roundtable',7,4]] },
    research: { name: 'ANALYSIS', kind: 'lab', floorStyle: 'teal', floorMat: 'resin', props: [['desk',3,1],['research_samplecart',12,1],['plant',16,1],['bookshelf',2,8],['bookshelf',12,8]] },
    engineering: { name: 'WORKSHOP', kind: 'factory', floorStyle: 'hull', floorMat: 'tread', props: [['desk',3,1],['fabricator',11,1],['industrial_drawerbank',2,8],['crate',13,8]] },
    planning: { name: 'PLANNING', kind: 'bridge', floorStyle: 'cobalt', floorMat: 'resin', props: [['consoleL',2,1],['missionboard',7,0],['desk',13,1],['holotable',7,6],['plant',16,8]] },
    comms: { name: 'COMMS', kind: 'bridge', floorStyle: 'hull', floorMat: 'resin', props: [['consoleL',3,1],['screens',10,0],['rack',12,1],['plant',16,1]] },
    archive: { name: 'ARCHIVE', kind: 'hab', floorStyle: 'walnut', floorMat: 'plank', props: [['bookshelf',2,1],['bookshelf',6,1],['bookshelf',10,1],['plant',16,1],['desk',3,7]] }
  };
  const slots = {
    east: { x:21, y:0, hall:{x1:18,y1:4,x2:20,y2:6} },
    west: { x:-21, y:0, hall:{x1:-3,y1:4,x2:-1,y2:6} },
    north: { x:0, y:-14, hall:{x1:7,y1:-3,x2:10,y2:-1} },
    south: { x:0, y:14, hall:{x1:7,y1:11,x2:10,y2:13} }
  };
  function build(id, model, sprites, nextId) {
    const entry = catalog.find(c => c.id === id);
    if (!entry) throw new Error('Unknown station build');
    const station = model.create(model.starterDoc());
    const requireOK = r => { if (!r.ok) throw new Error(r.msg || r.error); return r; };
    entry.wings.forEach(([type, side]) => {
      const r = rooms[type], slot = slots[side];
      // Every room retains the familiar 18 x 11 size for straightforward expansion.
      requireOK(station.addRoom({kind:r.kind,name:r.name,floorStyle:r.floorStyle,floorMat:r.floorMat,
        rect:{x1:slot.x,y1:slot.y,x2:slot.x+17,y2:slot.y+10}}));
      requireOK(station.placeHallway({rect:slot.hall}));
      for (const [t,x,y,facing=0] of r.props) {
        const spec = sprites.spec(t);
        if (!spec) throw new Error('Missing station furniture: '+t);
        requireOK(station.addProp({t,x:slot.x+x,y:slot.y+y,w:spec.w,h:spec.h,r:facing,block:spec.blocks!==false}));
      }
      if (r.blueprint) {
        const [blueprint,x,y] = r.blueprint;
        requireOK(station.stampBlueprint(blueprint,slot.x+x,slot.y+y));
      }
    });
    const doc = station.serialize();
    doc.meta.name = entry.name;
    doc.meta.templateId = entry.id;
    if (Number.isInteger(nextId) && nextId > doc._nid) {
      const ids = {};
      for (const rid of doc.order) ids[rid] = 'r' + nextId++;
      const remapped = {};
      for (const rid of doc.order) { const room = doc.rooms[rid]; room.id = ids[rid]; remapped[room.id] = room; }
      doc.rooms = remapped; doc.order = doc.order.map(rid => ids[rid]);
      doc.meta.spawnRoomId = ids[doc.meta.spawnRoomId]; doc.meta.trunkRoomId = ids[doc.meta.trunkRoomId];
      doc.props.forEach(p => { p.id = 'p' + nextId++; });
      doc._nid = nextId;
    }
    return doc;
  }
  return { catalog: catalog.map(({wings,...entry}) => Object.freeze(entry)), build };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StationTemplates;
