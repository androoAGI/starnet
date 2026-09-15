/* Furnished station builds. Room count excludes connecting corridors.
   These describe physical layouts, not hired staff or running workflows. */
'use strict';
const StationTemplates = (() => {
  const catalog = [
    { id: 'default', name: 'DEFAULT', rooms: 1, description: 'One open room. All five essentials, your workstation, and space to grow.', wings: [] },
    { id: 'retreat', name: 'QUIET RETREAT', rooms: 2, description: 'Focused solo work with a separate reading and rest room.', wings: ['reading'] },
    { id: 'creative', name: 'CREATIVE STUDIO', rooms: 3, description: 'A home for writing, design, and media work, with a studio and review room.', wings: ['creative', 'review'] },
    { id: 'research', name: 'RESEARCH STATION', rooms: 3, description: 'Space to investigate, compare sources, and organize a reference library.', wings: ['research', 'reading'] },
    { id: 'engineering', name: 'ENGINEERING STATION', rooms: 5, description: 'Separate rooms for implementation, review, research, and a break between tasks.', wings: ['engineering', 'review', 'research', 'reading'] },
    { id: 'operations', name: 'OPERATIONS STATION', rooms: 5, description: 'A planning center with rooms for research, communications, review, and reference.', wings: ['planning', 'research', 'review', 'reading'] }
  ];
  const rooms = {
    reading: { name: 'LIBRARY', kind: 'quarters', floorStyle: 'walnut', floorMat: 'plank', props: [['bookshelf',2,1],['couch',6,6],['plant',13,8]] },
    creative: { name: 'STUDIO', kind: 'lab', floorStyle: 'violet', floorMat: 'resin', props: [['desk',3,2],['easel',10,2],['plant',13,8]] },
    review: { name: 'REVIEW', kind: 'hab', floorStyle: 'ash', floorMat: 'panel', props: [['desk',3,2],['industrial_roundtable',10,6],['plant',13,8]] },
    research: { name: 'RESEARCH', kind: 'lab', floorStyle: 'teal', floorMat: 'tile', props: [['desk',3,2],['research_samplecart',11,2],['bookshelf',10,7]] },
    engineering: { name: 'WORKSHOP', kind: 'factory', floorStyle: 'rust', floorMat: 'tread', props: [['desk',3,2],['fabricator',10,2],['crate',11,8]] },
    planning: { name: 'PLANNING', kind: 'bridge', floorStyle: 'cobalt', floorMat: 'panel', props: [['desk',3,2],['missionboard',10,1],['plant',13,8]] }
  };
  const slots = [
    { x:21, y:0, hall:{x1:18,y1:4,x2:20,y2:6} },
    { x:-19, y:0, hall:{x1:-3,y1:4,x2:-1,y2:6} },
    { x:0, y:-14, hall:{x1:7,y1:-3,x2:10,y2:-1} },
    { x:0, y:14, hall:{x1:7,y1:11,x2:10,y2:13} }
  ];
  function build(id, model, sprites, nextId) {
    const entry = catalog.find(c => c.id === id);
    if (!entry) throw new Error('Unknown station build');
    const station = model.create(model.starterDoc());
    const requireOK = r => { if (!r.ok) throw new Error(r.msg || r.error); return r; };
    entry.wings.forEach((type, i) => {
      const r = rooms[type], slot = slots[i];
      // North/south wings span the central room; east/west are slightly narrower.
      const width = i < 2 ? 16 : 18;
      requireOK(station.addRoom({kind:r.kind,name:r.name,floorStyle:r.floorStyle,floorMat:r.floorMat,
        rect:{x1:slot.x,y1:slot.y,x2:slot.x+width-1,y2:slot.y+10}}));
      requireOK(station.placeHallway({rect:slot.hall}));
      for (const [t,x,y] of r.props) {
        const spec = sprites.spec(t);
        if (!spec) throw new Error('Missing station furniture: '+t);
        requireOK(station.addProp({t,x:slot.x+x,y:slot.y+y,w:spec.w,h:spec.h,block:spec.blocks!==false}));
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
