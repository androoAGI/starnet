/* node test/events-contract.test.js — P2.2 (UPDATE_STATE_SAFETY_AUDIT): the U.bus event contract is FROZEN by
   convention (shared/events.js says so) but nothing FAILS CI when a field is renamed or removed — a breaking
   change to the contract that ships to users, not a red build. This is the additive-only GATE.

   It snapshots each event's { required:[...], properties:[...] } into a checked-in fixture
   (test/fixtures/events-contract.snapshot.json) and, on every run, regenerates from shared/events.js and DIFFS:

     · a breaking change — an existing EVENT disappeared, an existing PROPERTY disappeared, or a NEW required
       field was added to an existing event — FAILS HARD (these break old emitters/listeners on an update).
     · a pure addition — a new event, or a new OPTIONAL property on an existing event — is allowed, but the test
       still FAILS with a friendly "snapshot outdated — regenerate via `node test/events-contract.test.js --update`"
       until the fixture is refreshed (so the snapshot never silently drifts out of date).
     · no change — passes.

   Regenerate the fixture after an intentional additive change:  node test/events-contract.test.js --update

   Registered in test/fast.list — a rename in shared/ now breaks the gate, not the user. (shared/events.js is OWNED
   by the cortex-memory workstream; this test READS it, never edits it.) */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = path.resolve(__dirname, 'fixtures', 'events-contract.snapshot.json');

/* Build the contract snapshot from an events module. Kept as a pure function of a REQUIRED module path so the
   negative test below can point it at a temporary COPY of events.js with a breaking edit — the real shared file is
   never touched, even transiently. Returns { eventName -> { required:[...sorted], properties:[...sorted] } }. */
function buildSnapshot(eventsPath) {
  // fresh require each call (the negative test loads a different file); clear any cached copy of THIS path.
  const resolved = require.resolve(eventsPath);
  delete require.cache[resolved];
  const events = require(resolved);
  const snap = {};
  for (const name of events.names()) {
    const sc = events.EVENTS[name];
    const required = (sc && Array.isArray(sc.required)) ? [...sc.required].sort() : [];
    const properties = (sc && sc.properties && typeof sc.properties === 'object') ? Object.keys(sc.properties).sort() : [];
    snap[name] = { required, properties };
  }
  return snap;
}

// serialize deterministically (event names sorted) so a git diff of the fixture is stable + reviewable.
function serialize(snap) {
  const ordered = {};
  for (const name of Object.keys(snap).sort()) ordered[name] = snap[name];
  return JSON.stringify(ordered, null, 2) + '\n';
}

/* Diff a PREVIOUS snapshot (the checked-in fixture) against the CURRENT one built from source.
   Returns { breaking:[...msgs], additive:[...msgs] }. Breaking = anything that would break old code on an update:
   a removed event, a removed property, or a property that BECAME required on an existing event. Additive = a new
   event, or a new (optional) property on an existing event. */
function diffSnapshots(prev, cur) {
  const breaking = [], additive = [];
  for (const name of Object.keys(prev)) {
    if (!(name in cur)) { breaking.push('event REMOVED: ' + name); continue; }
    const p = prev[name], c = cur[name];
    for (const prop of p.properties) if (!c.properties.includes(prop)) breaking.push('property REMOVED: ' + name + '.' + prop);
    for (const req of c.required) if (!p.required.includes(req)) breaking.push('required field ADDED (breaking): ' + name + '.' + req);
  }
  for (const name of Object.keys(cur)) {
    if (!(name in prev)) { additive.push('event ADDED: ' + name); continue; }
    const p = prev[name], c = cur[name];
    for (const prop of c.properties) if (!p.properties.includes(prop)) additive.push('property ADDED: ' + name + '.' + prop);
  }
  return { breaking, additive };
}

// ---- --update: regenerate the fixture from source, then exit (not a test run) --------------------------------
if (process.argv.includes('--update')) {
  const snap = buildSnapshot('../shared/events.js');
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, serialize(snap));
  console.log('events-contract snapshot regenerated: ' + SNAPSHOT_FILE + ' (' + Object.keys(snap).length + ' events)');
  process.exit(0);
}

// ---- the gate --------------------------------------------------------------------------------------------------
const current = buildSnapshot('../shared/events.js');

A.ok(fs.existsSync(SNAPSHOT_FILE), 'checked-in contract snapshot exists (run --update to create it)');
const prev = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

const { breaking, additive } = diffSnapshots(prev, current);

// BREAKING changes are the hard failure this gate exists for.
if (breaking.length) {
  console.log('EVENT CONTRACT BROKEN — the U.bus contract is additive-only. These changes would break old code on an update:');
  for (const m of breaking) console.log('  · ' + m);
  console.log('If a rename/removal is truly intended, it must go through the cortex-memory owner + a coordinated migration.');
}
A.ok(breaking.length === 0, 'no breaking event-contract changes (removed events/properties, newly-required fields)');

// Pure additions are allowed but must be committed into the fixture: fail friendly until --update is run.
if (additive.length) {
  console.log('events-contract snapshot outdated — regenerate via `node test/events-contract.test.js --update`. New additive entries:');
  for (const m of additive) console.log('  · ' + m);
}
A.ok(additive.length === 0, 'contract snapshot is up to date (no un-recorded additive changes)');

// The fixture must also match byte-for-byte the deterministic re-serialization (catches a hand-edit that reorders
// or malforms the file — the snapshot is generated, never edited by hand).
A.eq(serialize(current), serialize(prev), 'checked-in snapshot matches the deterministic serialization of source');

// ---- self-test of the DIFF LOGIC (proves the gate actually catches a breaking change) -------------------------
// Point the generator at a temporary COPY of events.js with a breaking edit — the REAL shared/events.js is never
// touched. This guarantees the gate isn't a no-op that would pass through a real rename/removal.
(function proveGateCatchesBreakage() {
  const os = require('os');
  const realSrc = fs.readFileSync(path.resolve(__dirname, '..', 'shared', 'events.js'), 'utf8');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-events-neg-'));
  // events.js requires ./schema.js relative to itself — copy that sibling too so the copy loads standalone.
  fs.copyFileSync(path.resolve(__dirname, '..', 'shared', 'schema.js'), path.join(tmpDir, 'schema.js'));
  // Pin the copy to CommonJS. events.js is a UMD file that only takes its CJS branch under CJS; without this the
  // nearest package.json (whatever an unrelated tool left in os.tmpdir()) decides, and a "type":"module" tmpdir
  // loads the copy as ESM, where module.exports is never set and the snapshot sees an empty namespace.
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"type":"commonjs"}');

  // (a) REMOVE an event: delete the whole `agent.token` entry. A rename would look the same to the diff (old gone).
  const removedEvent = realSrc.replace(/'agent\.token': obj\(\[[^\]]*\], \{[^}]*\}\),/, '/* removed for negative test */');
  fs.writeFileSync(path.join(tmpDir, 'events.js'), removedEvent);
  let d = diffSnapshots(current, buildSnapshot(path.join(tmpDir, 'events.js')));
  A.ok(d.breaking.some(m => /event REMOVED: agent\.token/.test(m)), 'gate DETECTS a removed event as breaking');

  // (b) RENAME a property: `delta` -> `deltaText` on agent.token — old prop gone (breaking) + new prop added.
  const renamedProp = realSrc.replace("'agent.token': obj(['agentId', 'runId', 'delta']", "'agent.token': obj(['agentId', 'runId', 'deltaText']")
    .replace('agentId: str, runId: str, delta: str', 'agentId: str, runId: str, deltaText: str');
  fs.writeFileSync(path.join(tmpDir, 'events.js'), renamedProp);
  d = diffSnapshots(current, buildSnapshot(path.join(tmpDir, 'events.js')));
  A.ok(d.breaking.some(m => /property REMOVED: agent\.token\.delta\b/.test(m)), 'gate DETECTS a renamed/removed property as breaking');
  A.ok(d.breaking.some(m => /required field ADDED \(breaking\): agent\.token\.deltaText/.test(m)), 'gate DETECTS a newly-required field as breaking');

  // (c) ADDITIVE: a new OPTIONAL property on an existing event is NOT breaking (only reported as additive).
  const addedOptional = realSrc.replace('agentId: str, runId: str, delta: str', 'agentId: str, runId: str, delta: str, seq: int');
  fs.writeFileSync(path.join(tmpDir, 'events.js'), addedOptional);
  d = diffSnapshots(current, buildSnapshot(path.join(tmpDir, 'events.js')));
  A.eq(d.breaking.length, 0, 'a new OPTIONAL property is NOT flagged breaking');
  A.ok(d.additive.some(m => /property ADDED: agent\.token\.seq/.test(m)), 'a new optional property is reported as additive');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
})();

A.report('events-contract.test');
