/* Furnished station builds. Room count excludes connecting corridors.
   These describe physical layouts, not hired staff or running workflows. */
'use strict';
const StationTemplates = (() => {
  const catalog = [
    { id: 'default', name: 'DEFAULT', rooms: 1, description: 'One open room. All five essentials, your workstation, and space to grow.', wings: [] },
    { id: 'retreat', name: 'QUIET RETREAT', rooms: 2, description: 'Your home station with a quiet library and lounge to the south.', wings: [['reading','south']] },
    { id: 'cozy', name: 'COZY WORKSHOP', rooms: 3, description: 'Warm wood floors, a furnished lounge, and an Inbox → Bay → Outbox conveyor workshop. Assign an agent to the bay to use the line.', wings: [['cozyWorkshop','north'],['cozyLounge','south']] },
    { id: 'creative', name: 'CREATIVE STUDIO', rooms: 3, description: 'A warm design studio and a review room with an Inbox → Draft → Review → Outbox conveyor. Assign agents to the two prepared steps.', wings: [['creative','north'],['creativeReview','east']] },
    { id: 'software', name: 'SOFTWARE TEAM', rooms: 3, description: 'An engineering workshop and a build room with an Inbox → Build → Test → Outbox conveyor. Assign agents to the two prepared steps.', wings: [['engineering','north'],['buildTest','east']] },
    { id: 'research', name: 'RESEARCH STATION', rooms: 3, description: 'An analysis lab to the north and a dedicated reference archive to the east.', wings: [['research','north'],['archive','east']] },
    { id: 'engineering', name: 'ENGINEERING STATION', rooms: 5, description: 'Workshop, analysis lab, review room, and quiet lounge around your home station.', wings: [['engineering','west'],['review','east'],['research','north'],['reading','south']] },
    { id: 'operations', name: 'OPERATIONS STATION', rooms: 5, description: 'Planning, communications, reference, and review rooms around a central home station.', wings: [['archive','west'],['comms','east'],['planning','north'],['review','south']] }
  ];
  const rooms = {
    cozyWorkshop: { name: 'WORKROOM', kind: 'factory', floorStyle: 'walnut', floorMat: 'plank', blueprint: ['front_desk',3,1], props: [['plant',1,1],['plant',16,1],['desk',2,7],['industrial_drawerbank',12,7],['bookshelf',14,9]] },
    cozyLounge: { name: 'LOUNGE', kind: 'quarters', floorStyle: 'walnut', floorMat: 'plank', props: [['tv',2,1],['rug',1,2],['couch',1,5],['industrial_roundtable',11,4],['dinerchair',10,4,3],['dinerchair',13,4,1],['coffee',14,4],['bookshelf',12,1],['plant',16,1],['bunk',13,7],['plant',1,8]] },
    reading: { name: 'LIBRARY', kind: 'quarters', floorStyle: 'walnut', floorMat: 'plank', props: [['couch',1,1],['bookshelf',13,1],['plant',16,8],['industrial_roundtable',2,4]] },
    creative: { name: 'DESIGN STUDIO', kind: 'lab', floorStyle: 'walnut', floorMat: 'plank', props: [['desk',2,1],['easel',11,1],['plant',0,1],['plant',16,1],['bookshelf',1,8],['industrial_drawerbank',1,6],['industrial_roundtable',12,7],['dinerchair',11,7,3],['dinerchair',14,7,1]] },
    creativeReview: { name: 'DRAFT & REVIEW', kind: 'hab', floorStyle: 'ash', floorMat: 'plank', props: [['desk',2,8],['industrial_roundtable',11,7],['dinerchair',10,7,3],['dinerchair',13,7,1],['bookshelf',15,8],['plant',16,5]], workflow: {
      label: 'CREATIVE · DRAFT & REVIEW',
      steps: [
        'Draft a response to the incoming creative brief. Follow its audience, format, tone, and constraints. Make a complete first draft, flag assumptions, and pass the draft and original requirements to the reviewer.',
        'Review the incoming draft against the original creative brief. Correct clarity, consistency, and unsupported claims while preserving the requested voice. Return the finished version and briefly flag anything that still needs a human decision.'
      ]
    } },
    buildTest: { name: 'BUILD & TEST', kind: 'factory', floorStyle: 'hull', floorMat: 'tread', props: [['desk',2,8],['desk',6,8],['rack',15,8],['industrial_roundtable',12,6],['dinerchair',11,6,3],['dinerchair',14,6,1],['plant',16,5]], workflow: {
      label: 'SOFTWARE · BUILD & TEST',
      steps: [
        'Build what the incoming request asks for. Restate the acceptance criteria, make the smallest complete change that meets them, and note how you checked it. Pass the change, your checks, and the original request to the tester.',
        'Test the incoming change against the original request. Check each acceptance criterion and edge case, fix anything that fails, and say which checks you actually ran. Deliver the verified result and list anything that still needs a human decision.'
      ]
    } },
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
  // Working examples for presets that ship a prepared two-step line, keyed by template id.
  const examples = Object.freeze({
    creative: Object.freeze({
      title: 'Creative Studio',
      line: rooms.creativeReview.workflow.label,
      purpose: 'Turn a short creative brief into a draft, then have a second agent review it before it reaches the outbox.',
      sample: 'SAMPLE JOB: Write a friendly launch announcement for a fictional community garden. Include a headline and three short sentences. Do not invent a date, location, or website. The reviewer should check those constraints and deliver the finished announcement.',
      roles: [
        { name:'Drafter', description:'Writes the first version from your brief and passes it to the reviewer.' },
        { name:'Reviewer', description:'Checks the draft against your brief, improves it, and sends the finished version to the outbox.' }
      ]
    }),
    software: Object.freeze({
      title: 'Software Team',
      line: rooms.buildTest.workflow.label,
      purpose: 'Turn a small change request into working code, then have a second agent test it before it reaches the outbox.',
      sample: 'SAMPLE JOB: Write a JavaScript function slugify(title) that lowercases the title, trims it, and joins words with single hyphens, dropping characters other than letters, digits, and spaces. Include three example inputs with their expected outputs. The tester should check every example, fix any mismatch, and deliver the final function with a short test note.',
      roles: [
        { name:'Builder', description:'Makes the requested change, notes how it was checked, and passes it to the tester.' },
        { name:'Tester', description:'Checks the change against your request, fixes failures, and sends the verified result to the outbox.' }
      ]
    })
  });
  // Resolve roles from the real directed belts on an isolated copy, even before
  // agents are assigned. Rearranging props never changes which step is first.
  function example(doc, model, pipeline) {
    const guide = examples[doc.meta?.templateId];
    if (!guide) return null;
    const live = model.create(structuredClone(doc)), geo = live.projectGeometry();
    const inbox = live.props().find(p=>p.t==='intake' && p.label===guide.line);
    const comp = inbox && pipeline.lineComponents(geo).find(c=>c.intakes.includes(inbox.id));
    const fail = issue => ({...guide,issue,roles:[],ready:false,key:comp?.key});
    const [firstRole, lastRole] = guide.roles.map(r=>r.name);
    if (!comp || comp.bays.length!==2 || comp.intakes.length!==1 || comp.outboxes.length!==1)
      return fail('Reconnect the original Inbox, two Bays and Outbox to use this example. You can still edit a custom workflow normally.');
    const probe = model.create(structuredClone(doc)), ids = comp.bays.map((b,i)=>'preset_probe_'+i);
    comp.bays.forEach((b,i)=>probe.assignPropAgent(b.propId,ids[i]));
    const shape = pipeline.compileRoutingPlan(probe.projectGeometry());
    const first = ids.findIndex(id=>shape.reach[id]);
    const next = first >= 0 ? shape.chains[ids[first]]?.next || [] : [];
    const last = ids.indexOf(next[0]);
    if (first < 0 || next.length!==1 || last < 0 || last===first || !shape.chains[ids[last]]?.outbox || shape.chains[ids[last]]?.next?.length)
      return fail('The belts no longer form Inbox → '+firstRole+' → '+lastRole+' → Outbox. Check their direction and connections.');
    const roles = [first,last].map((i,n)=>({...guide.roles[n],propId:comp.bays[i].propId,agentId:live.propById(comp.bays[i].propId).agentId || ''}));
    const plan = pipeline.compileRoutingPlan(geo), [a,b] = roles.map(r=>r.agentId);
    const missingCompute = roles.filter(r=>r.agentId && !live.bayObjects(r.agentId).includes('computer'));
    const ready = !!(a && b && a!==b && !missingCompute.length && !plan.errors.length && plan.reach[a] && plan.chains[a]?.next?.length===1 && plan.chains[a].next[0]===b && plan.chains[b]?.outbox && !plan.chains[b]?.next?.length);
    const issue = plan.errors.filter(e=>e.code!=='UNBOUND_BAY').map(e=>e.code).join(', ') || (missingCompute.length ? missingCompute.map(r=>r.name).join(' and ')+' needs computer access. Assign each agent their own workstation, then return here.' : '');
    return {...guide,roles,key:comp.key,ready,issue};
  }
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
      if (r.workflow) {
        // A straight two-step line leaves the room's middle and entrance open.
        const nodes = [['intake',1],['bay',5],['bay',10],['outbox',15]].map(([t,x]) => {
          const spec = sprites.spec(t);
          return requireOK(station.addProp({t,x:slot.x+x,y:slot.y+1,w:spec.w,h:spec.h,block:true})).id;
        });
        for (const x of [3,4,7,8,9,12,13,14])requireOK(station.setBelt(slot.x+x,slot.y+2,'E'));
        requireOK(station.setPropLabel(nodes[0],r.workflow.label));
        r.workflow.steps.forEach((brief,i) => requireOK(station.setPropBrief(nodes[i+1],brief)));
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
  return { catalog: catalog.map(({wings,...entry}) => Object.freeze(entry)), build, example };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StationTemplates;
