'use strict';
// Compile the coordinated source handoff into a reviewable manifest patch.
// No old pixel painter is a valid substitute for an unfinished authored layer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const DATA = 'dev/industrial-textures/coordinated-batch03-recipes.json';
const ART = 'frontend/assets/industrial/batch03';
const DOC = 'docs/station-remaster/batch03';
const OUT = 'frontend/assets/industrial/props-v3';
const FACING = { s: 0, w: 1, n: 2, e: 3 };
const ROOT_OWNED = 'pixelrig bench workbench rack rackV core comms_dish comms_uplink comms_beacon commswall bridge_relaystack war_intelcab fabricator vat tube research_corelens research_trendpillar etsy_packbot'.split(' ');
const PREVIOUS = 'crate desk desk2 chair bridge_consolebank bridge_tacticaltable bridge_equipmentbay bridge_deckperimeter industrial_locker industrial_drawerbank industrial_supplycart industrial_toolcaddy console consoleL filter tank boxes couch plant lowtable'.split(' ');
const EXCLUDED = new Set([...ROOT_OWNED, ...PREVIOUS]);
const CONTENT = new Set('missionboard trophycase comms_inbox calwall arc_microfiche'.split(' '));
const SERVICE = new Set('outbox connector_portal jukebox airlock pub_publishpress pub_outboundchute pub_mailpod intake bay merger splitter joiner loop'.split(' '));
const LANES = ['coordinator', 'crew', 'storage', 'utility', 'control', 'habitat'];
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function json(root, file, optional = false) {
  const absolute = path.join(root, file);
  if (optional && !fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}
function pngInfo(root, file) {
  const bytes = fs.readFileSync(path.join(root, file));
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Not PNG: ' + file);
  return { path: file, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: sha(bytes) };
}
function fit(bounds, size) {
  const scale = Math.min(bounds.width / size.width, bounds.height / size.height);
  return { x: bounds.x + (bounds.width - size.width * scale) / 2,
    y: bounds.y + bounds.height - size.height * scale,
    width: size.width * scale, height: size.height * scale };
}
function rows(value) { return Array.isArray(value) ? value : value && value.records || []; }
function mapCoordinates(points, transform) {
  if (!Array.isArray(points)) return points;
  if (points.length === 2 && points.every(Number.isFinite)) return transform(points);
  return points.map(p => mapCoordinates(p, transform));
}
function toExport(points, space, source, crop) {
  return mapCoordinates(points, ([x, y]) => {
    if (space === 'sourceNormalized') { x *= source.width; y *= source.height; }
    return [(x - crop.left) / crop.width, (y - crop.top) / crop.height];
  });
}
function toWorld(points, box) { return mapCoordinates(points, ([x,y]) => [box.x + x * box.width, box.y + y * box.height]); }
function pointList(points) {
  if (!Array.isArray(points)) return [];
  return points.length === 2 && points.every(Number.isFinite) ? [points] : points.flatMap(pointList);
}

function readContentRegions(root) {
  const filename = 'frontend/app/authored-prop-content.js';
  if (!fs.existsSync(path.join(root, filename))) return {};
  // This module is a pure declaration. Reading its exported geometry does not
  // construct a browser, draw a frame, or mint any runtime state.
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8') + '\nthis.geometry = AuthoredPropContent.regions;', context);
  return clone(context.geometry);
}

function findReceipt(root, lane, key) {
  const direct = `${DOC}/${lane}/${key}.export.json`;
  if (fs.existsSync(path.join(root, direct))) return { file: direct, data: json(root, direct) };
  for (const file of [`${DOC}/${lane}/export-checks.json`, `${ART}/${lane}/export-checks.json`]) {
    const data = rows(json(root, file, true)).find(row => row.id === key);
    if (data) return { file, data };
  }
  return null;
}

function authoredGuides(root, lane, key, source, crop, alphaCrop, box, receipt, contentRegions) {
  const guides = {}, references = [];
  const add = (name, raw, reference) => {
    let normalized = raw.exportNormalized || raw.cropNormalized;
    if (!normalized && raw.sourcePixels) normalized = toExport(raw.sourcePixels, 'sourcePixels', source, crop);
    if (!normalized && raw.sourceNormalized) normalized = toExport(raw.sourceNormalized, 'sourceNormalized', source, crop);
    if (!normalized) return;
    const fitNormalized = mapCoordinates(normalized, ([x,y]) => [(x*crop.width-alphaCrop.left)/alphaCrop.width,(y*crop.height-alphaCrop.top)/alphaCrop.height]);
    guides[name] = { exportNormalized: normalized, fitNormalized, worldPixels: toWorld(fitNormalized, box),
      ...(raw.sourcePixels ? { sourcePixels: raw.sourcePixels } : {}),
      ...(raw.sourceNormalized ? { sourceNormalized: raw.sourceNormalized } : {}),
      ...(raw.behavior ? { behavior: raw.behavior } : {}), reference };
    if (!references.includes(reference)) references.push(reference);
  };
  const direct = `${DOC}/${lane}/${key}.anchors.json`;
  const d = json(root, direct, true);
  if (d) for (const [name, region] of Object.entries(d.regions || {})) add(name, region, direct);
  const shared = `${DOC}/${lane}/anchors.json`;
  const record = rows(json(root, shared, true)).find(row => row.id === key);
  if (record) for (const [name, region] of Object.entries(record.regions || {})) add(name, region, shared);
  if (receipt && receipt.data.authoredGeometry) {
    for (const [name, region] of Object.entries(receipt.data.authoredGeometry.regions || {})) add(name, region, receipt.file);
  }
  const utilityFile = `${DOC}/utility/manifest.json`;
  const utility = json(root, utilityFile, true)?.props?.[key];
  if (lane === 'utility' && utility) {
    for (const [i, region] of (utility.authoredMotionRegions || []).entries()) {
      if (region.normalizedRect) add(region.name || `motion${i}`, { sourceNormalized: rect(...region.normalizedRect), behavior: region.behavior }, utilityFile);
    }
    const transportFile = `${DOC}/utility/transport-content-regions.json`;
    const transport = json(root, transportFile, true)?.props?.[key];
    if (transport) for (const group of ['ports', 'emptyRegions', 'motion']) {
      for (const [i, region] of (transport[group] || []).entries()) {
        const points = region.point || region.rect && rect(...region.rect);
        if (points) add(`${group}:${region.name || i}`, { sourceNormalized: points, behavior: region.behavior }, transportFile);
      }
    }
  }
  // These rectangles were independently annotated against the corrected sources
  // by the authored-content lane, including the calendar crop offset.
  if (CONTENT.has(key) && contentRegions[key]) {
    const visit = (value, name) => {
      if (!value || typeof value !== 'object') return;
      if (['x','y','width','height'].every(k => Number.isFinite(value[k]))) add(name, { exportNormalized: rect(value.x,value.y,value.width,value.height) }, 'frontend/app/authored-prop-content.js');
      else for (const [child, v] of Object.entries(value)) visit(v, `${name}.${child}`);
    };
    visit(contentRegions[key], 'content');
  }
  return { regions: guides, references };
}

// New-export annotations: these were inspected from the corrected batch03 PNG,
// never copied from the prior raster. They are not live-world acceptance.
const ANNOTATIONS = {
  mug: { mode: 'steam', motion: { origin: [.35,.34], rise: 2, trigger: 'ambient' }, bounds: { x:4,y:8,width:4,height:4 }, note:'Steam from the new visible liquid. Keep the root live-calibrated small accessory envelope, separate from its native 10x9 source envelope.' },
  radio: { mode: 'pulse', motion: { region:rect(.62,.421,.30,.175), colour:[205,158,85], trigger:'ambient' }, note:'Subtle decorative tuner illumination in the new amber dial; does not assert audio playback or a provider connection.' },
  quarters_pooltable: { mode:'pool', motion:{ region:rect(.11,.14,.78,.45) }, note:'The new empty felt is the ball field; balls move only for real leisure work. No baked balls or old pixels.' },
  bunk: { mode:'static', foreground:rect(0,.277,1,.723), note:'New quilt and footboard foreground begin below the new pillow. Parent must recheck actual sleeper head placement.' },
  coffee: { mode:'steam', motion:{ origin:[.46,.68], rise:2.4, trigger:'work' }, note:'Retain root equipment integration calibration for this unchanged batch03 coffee source.' },
  quarters_vending: { mode:'pulse', motion:{region:rect(.333,.789,.31,.009),colour:[222,175,92],trigger:'work'}, note:'New delivery-slot aperture alone brightens on real leisure use. Its displayed snacks are decorative, not stock telemetry.' }
};
const ANNOTATION_HASHES = {
  mug:'1af0e806f672e1390a3304b535bd7e13982f3b7f2858b4b27c20d0cc424070e0',
  radio:'cc8752c8e346989a022c50b0cf64711251054f3df3605e068eda33cfd3bb4c18',
  quarters_pooltable:'fe250fa2f9c97823de17754bc669e93113207540632a4040ba262c1ee5925f02',
  bunk:'a5ad18bfb5ca8153b0b0b4f158355572092afdddf22dba041731ad4d9a1af59a',
  coffee:'fd78114fa53b8f3afc1f453316ff3b07618aac60136a6f0fc3b74a89d40dae20',
  quarters_vending:'5fb34ea221beb85c6289f9eed2b7b7b586ae3eb110ade375f1710a2529af3756'
};
const STATEFUL = new Set('connector_portal jukebox airlock outbox missionboard trophycase comms_inbox calwall arc_microfiche bay merger splitter joiner loop intake bridge_orderqueue bridge_dispatch_pylon'.split(' '));
const CALIBRATED_BOUNDS = {bookshelf:{x:-1,y:-10,width:26,height:22}};

function chooseMode(prop, record, contentRegions) {
  if (CONTENT.has(prop.id)) return { status:'supported', mode:'content',
    requiredModules:['frontend/app/authored-prop-content.js'], contentRegions:contentRegions[prop.id],
    note:'Parent confirmed content-mode wiring. Load the module before PropRemaster and route real state to the new apertures.' };
  if (SERVICE.has(prop.id)) return {status:'requires-service-runtime',mode:'service',
    requiredLayer:'parent service content module',note:'Source and normalized regions ready; enable only after parent wires the new service state renderer. Never fill empty routes, doors, connector lamps or parcels with cosmetic guesses.'};
  if (ANNOTATIONS[prop.id]) {
    if (ANNOTATION_HASHES[prop.id] !== record.exported.sha256) return {status:'pending',mode:null,note:'Source changed after its new-region annotation; remeasure before applying.'};
    return { status:'supported', ...clone(ANNOTATIONS[prop.id]) };
  }
  if (prop.id === 'steamvent' && record.authored.regions.emitter) {
    return { status:'supported', mode:'steam', motion:{origin:record.authored.regions.emitter.fitNormalized[0],rise:4,trigger:'ambient'}, note:'Decorative steam from the newly annotated open mouth.' };
  }
  const a = prop.sampledAnimation.remaster;
  if (a.idleFrameVariants === 1 && a.workFrameVariants === 1 && !a.respondsToWorkFlag && !STATEFUL.has(prop.id)) {
    return { status:'supported', mode:'static', ...(CALIBRATED_BOUNDS[prop.id]?{bounds:clone(CALIBRATED_BOUNDS[prop.id])}:{}), note:'No internal native animation or state-dependent pixels. Existing collision, approach, light and mount rules remain parent runtime responsibilities.' };
  }
  return { status:'pending', mode:null, requiredLayer: STATEFUL.has(prop.id) ? 'stateful-content-or-machine' : 'authored-motion',
    note: prop.id === 'bar' ? 'New painted bar has taps and brass rail, no old emissive strip. Author tap/liquid motion before replacement.' :
      prop.id === 'quarters_minifridge' ? 'New painted fridge has an analog dial, no old status-light aperture. Do not pulse the old coordinate.' :
      'New body exists; its native animation/state contract still needs a new authored layer. Preserve existing runtime entry until parent implements it.' };
}

function buildPlan(root = ROOT) {
  const inventory = json(root, 'dev/industrial-textures/prop-inventory.json');
  const structure = json(root, 'dev/industrial-textures/prop-structure-manifest.json');
  const contentRegions = readContentRegions(root);
  const plan = { version:1, scope:'Coordinated complete-art candidates; not user acceptance or live completion', tilePixels:12,
    sourceGeometry:'dev/industrial-textures/prop-structure-manifest.json', excludedRootIds:ROOT_OWNED, excludedPriorIds:PREVIOUS,
    facingSemantics:{r0:'south',r1:'west',r2:'north',r3:'east',note:'An _r suffix is a distinct catalog ID. A -rN suffix is an independently authored view. Only native flat props may use exact runtime quarter turns.'}, props:{} };
  for (const prop of inventory.props.filter(p => !EXCLUDED.has(p.id))) {
    const native = structure.props[prop.id];
    if (!native) throw Error('Missing native geometry: ' + prop.id);
    const entry = { label:prop.label, family:prop.family, nativeGeometry:prop.geometry, nativeOrientation:prop.orientation,
      anchorContract:prop.anchorContract, nativeLeisure:prop.leisureUse, nativeAnimation:prop.sampledAnimation.remaster,
      liveStateContract:prop.liveAnimationTriggers, views:{} };
    for (const [facing, geometry] of Object.entries(native.views)) {
      if (FACING[facing] !== geometry.r) throw Error(`Facing mismatch: ${prop.id}:${facing}`);
      const key = geometry.key, image = geometry.image;
      const matches = LANES.filter(lane => fs.existsSync(path.join(root, ART, lane, image)));
      if (matches.length > 1) throw Error('Ambiguous source lanes: ' + key);
      if (!matches.length) { entry.views[facing] = { status:'missing-source', expectedImage:image, footprint:geometry.footprint, bounds:geometry.bounds, r:geometry.r }; continue; }
      const lane = matches[0], receipt = findReceipt(root, lane, key);
      if (!receipt) throw Error('Missing alpha/export receipt: ' + key);
      const sourceCandidates = [receipt.data.source && (receipt.data.source.startsWith('docs/') ? receipt.data.source : `${DOC}/${lane}/${receipt.data.source}`), `${DOC}/${lane}/sources/${key}.png`, `${DOC}/${lane}/${key}-source.png`, `${DOC}/${lane}/${key}.source.png`].filter(Boolean);
      const sourcePath = sourceCandidates.find(file => fs.existsSync(path.join(root, file)));
      if (!sourcePath) throw Error('Missing original source: ' + key);
      const source = pngInfo(root, sourcePath), exported = pngInfo(root, `${ART}/${lane}/${image}`);
      const cropData = receipt.data.crop || receipt.data.alphaBounds;
      if (!cropData) throw Error('Missing original-to-export crop: ' + key);
      const crop = { left:cropData.left ?? cropData.x, top:cropData.top ?? cropData.y, width:cropData.width, height:cropData.height };
      if (receipt.data.canvasPreserved) Object.assign(crop,{left:0,top:0,width:source.width,height:source.height});
      if (crop.width !== exported.width || crop.height !== exported.height) throw Error('Export crop dimensions differ: ' + key);
      if (receipt.data.sourceSha256 && source.sha256 !== receipt.data.sourceSha256) throw Error('Source hash differs: ' + key);
      if (receipt.data.outputSha256 && exported.sha256 !== receipt.data.outputSha256) throw Error('Export hash differs: ' + key);
      if (receipt.data.subjectRgbChanges !== 0) throw Error('Unverified unchanged subject RGB: ' + key);
      const a = receipt.data.canvasPreserved ? receipt.data.alphaBounds : null;
      const alphaCrop = a ? {left:a.x,top:a.y,width:a.width,height:a.height} : {left:0,top:0,width:exported.width,height:exported.height};
      const box = fit(geometry.bounds, alphaCrop);
      const record = { status:'candidate', key, lane, r:geometry.r, independentlyAuthored:true, source, exported, crop, alphaCrop,
        footprint:geometry.footprint, nativeBounds:geometry.bounds, fit:box, receipt:receipt.file,
        authored:authoredGuides(root,lane,key,source,crop,alphaCrop,box,receipt,contentRegions), liveVerified:false };
      record.runtime = chooseMode(prop, record, contentRegions);
      if (record.runtime.bounds) { record.fit = fit(record.runtime.bounds, exported); record.calibrationNote = record.runtime.note; }
      record.regionWarnings = Object.entries(record.authored.regions).filter(([,region]) => pointList(region.exportNormalized).some(p=>p.some(n=>n<0||n>1))).map(([name])=>name);
      const supports = Object.entries(record.authored.regions).filter(([name])=>/support|seat|occlusion|rim|backrest/i.test(name));
      record.placementGuides = Object.fromEntries(supports);
      if (prop.geometry.tableSurface) {
        const edge = record.authored.regions.nearSupportEdge;
        const pts = edge && pointList(edge.worldPixels);
        record.mountSupport = { legacyGenericRise:prop.geometry.surfaceRisePixels,
          supportPolygonWorld:record.authored.regions.tableSupport?.worldPixels || null,
          nearEdgeWorld:edge?.worldPixels || null,
          measuredNearEdgeRise:pts?.length ? geometry.footprint.h*12-pts.reduce((sum,p)=>sum+p[1],0)/pts.length : null,
          qualification:'A near-edge measurement is not one constant rise for the entire projected tabletop. Parent maps the actual mounted contact point; do not blindly use legacy rise 8.' };
      }
      record.integrationChecks = ['Check actual scale next to approved workstation/crate and the real cadet.', 'Verify each offered facing, bottom contact, shadow, alpha edges, and occlusion in the running station.'];
      if (prop.geometry.tableSurface) record.integrationChecks.push('Map mounted items to this authored support polygon. Native generic surfaceRisePixels is legacy data, not the measured new table top.');
      if (prop.leisureUse) record.integrationChecks.push('Verify real agent approach/use/seat and foreground ordering; artwork alone cannot prove seat alignment.');
      entry.views[facing] = record;
    }
    plan.props[prop.id] = entry;
  }
  const values = Object.values(plan.props), views = values.flatMap(p=>Object.values(p.views));
  plan.counts = { ids:values.length, sourceIds:values.filter(p=>Object.values(p.views).some(v=>v.status!=='missing-source')).length,
    authoredViews:views.filter(v=>v.status!=='missing-source').length, supportedViews:views.filter(v=>v.runtime?.status==='supported').length,
    contentViews:views.filter(v=>v.runtime?.mode==='content').length,
    serviceViews:views.filter(v=>v.runtime?.status==='requires-service-runtime').length,
    pendingViews:views.filter(v=>v.runtime?.status==='pending').length, missingViews:views.filter(v=>v.status==='missing-source').length };
  return plan;
}

function manifestPatch(plan, options = {}) {
  const props = {}, copies = [], pending = [];
  const selected = options.ids ? new Set(options.ids) : null;
  if(selected) for(const id of selected)if(!plan.props[id])throw Error('Not a coordinated recipe ID: '+id);
  for (const [id, prop] of Object.entries(plan.props)) {
    if (selected && !selected.has(id)) continue;
    for (const [facing, record] of Object.entries(prop.views)) {
      const runtime = record.runtime;
      const enabled = runtime?.status === 'supported' || options.enableService && runtime?.status === 'requires-service-runtime';
      if (!enabled) { pending.push({id,facing,reason:runtime?.note || record.status}); continue; }
      const { mode, motion, foreground, screenRegions, bounds } = runtime;
      if(!['static','screen','water','scanner','steam','pulse','pool','content','service'].includes(mode))throw Error('Unsupported authored recipe mode: '+id+':'+mode);
      const view = { image:record.key+'.png', sourceWidth:record.exported.width, sourceHeight:record.exported.height,
        footprint:clone(record.footprint), bounds:clone(bounds || record.nativeBounds), exposure:1, mode,
        ...(motion?{motion:clone(motion)}:{}), ...(foreground?{foreground:clone(foreground)}:{}), ...(screenRegions?{screenRegions:clone(screenRegions)}:{}) };
      (props[id] ||= {views:{}}).views[facing] = view;
      copies.push({from:record.exported.path,to:`${OUT}/${view.image}`,sha256:record.exported.sha256});
    }
  }
  return {version:1,props,copies,pending};
}

function applyPlan(root, plan, options = {}) {
  const patch = manifestPatch(plan, options);
  // Validate every source before any mutation. No generation, recolour, resize,
  // rotation, native-mode mask, or clearing of unrelated manifest entries.
  for (const copy of patch.copies) if (sha(fs.readFileSync(path.join(root,copy.from))) !== copy.sha256) throw Error('Stale recipe export: '+copy.from);
  const manifest = json(root, `${OUT}/manifest.json`);
  for (const copy of patch.copies) fs.copyFileSync(path.join(root,copy.from),path.join(root,copy.to));
  for (const [id, prop] of Object.entries(patch.props)) manifest.props[id] = { ...(manifest.props[id] || {}), views:{ ...(manifest.props[id]?.views || {}), ...prop.views } };
  fs.writeFileSync(path.join(root,`${OUT}/manifest.json`),JSON.stringify(manifest,null,2)+'\n');
  // Completion is never inferred here. The root owns coverage after animation,
  // facing and live proportion checks. Merely adding a body cannot mark done.
  return patch;
}

function main(argv) {
  const option = flag => { const i = argv.indexOf(flag); return i<0?undefined:argv[i+1]; };
  const root = path.resolve(option('--root') || ROOT);
  const plan = argv.includes('--from-recipe') ? json(root,DATA) : buildPlan(root);
  if (argv.includes('--write-recipe')) fs.writeFileSync(path.join(root,DATA),JSON.stringify(plan,null,2)+'\n');
  const options = { enableService:argv.includes('--enable-service'), ids:option('--ids')?.split(',') };
  const patch = argv.includes('--apply') ? applyPlan(root,plan,options) : manifestPatch(plan,options);
  if (option('--patch')) fs.writeFileSync(path.resolve(option('--patch')),JSON.stringify(patch,null,2)+'\n');
  console.log(JSON.stringify({counts:plan.counts,applied:argv.includes('--apply'),eligibleIds:Object.keys(patch.props),pending:patch.pending},null,2));
}
if (require.main === module) main(process.argv.slice(2));
module.exports = {buildPlan,manifestPatch,applyPlan,fit,toExport,toWorld,pngInfo,ROOT_OWNED,PREVIOUS,FACING};
