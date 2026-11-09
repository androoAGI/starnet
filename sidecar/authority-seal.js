/* sidecar/authority-seal.js — THE AUTHORITY FILES CARRY A SEAL (GHSA-2hpj #3).

   Five files say what this station may do without asking: permissions.bypass.json (FULL BYPASS), agent.roster.json
   (which agents have Full Access), hooks.json + hooks-allowed.json (which shell hooks run) and plugins-allowed.json
   (which plugin code runs). They sit in the workspace as plain JSON, and any process running as this user (an agent's
   shell command among them) could write them and be obeyed at the next boot. Each one now carries a seal: an
   HMAC-SHA256 over its own name and its canonical content, keyed from the OS credential store's key (the same
   keychain / Credential Manager / libsecret entry that encrypts connector sign-ins, through connector-vault's
   deriveKey, so the raw key never leaves the vault). A file whose seal is missing or wrong is not obeyed: its reader
   gets the safe default (bypass off, every agent ask-first, no hooks, nothing approved), a copy of its bytes is kept
   beside it, and the station says so in one sentence the page shows.

   makeAuthoritySeal({ key, now, marker: { read, write }, keep?, log?, lastSealed?, current? })
     key      Buffer | null — the derived seal key; null (a bare station, or the desktop without its credential store)
              means unkeyed: nothing is sealed or checked, exactly as before (boot reports mode 'unkeyed').
     marker   read() -> value | undefined (absent), throws when unreadable; write(value). The sealed record that this
              station has been sealing (authority-seal.json). It turns the one-time upgrade into a one-time event: once
              it exists, an unsealed file is a changed file, never an old one.
     keep     (name) -> path | null: keep a copy of a refused file's bytes (once per file per process).
     lastSealed { read(name) -> value | undefined, write(name, value), drop(name) }: the <name>.sealed-last store (F1).
     current  (name) -> the file's value on disk now | undefined: what an unkeyed StarNet is about to overwrite (F1).
     restored { read() -> { files: [names] } | undefined, drop() }: the record a restore from a recovery bundle leaves
              (station-recovery.js RESTORED_NAME; fix-sec2 review 10). See adoptRestored below.
     desktop  true when this is the desktop app's station, which always has its key (review 4d). Unkeyed over a sealed
              workspace it HOLDS (every file at its safe default, no permission change saved) instead of reading the
              files unchecked. A bare or pm2 station (desktop absent) never holds for want of a key.
   -> { keyed, seal(name, value), open(name, value), boot(files), notices(), clampRoster(raw) }

   boot(files: [{ name, read, write, wrap? }]) runs once, before any reader. With a valid marker: nothing to do but the
   reconcile below. With no marker and no sealed file: this is the upgrade — every present file is sealed as it is (wrap
   first, e.g. a legacy array hooks.json becomes { hooks }) and the marker is written; a notice names what was sealed.
   With no marker but a sealed file present, or a marker that does not verify: not an upgrade (the marker was removed or
   the key changed), so nothing is re-sealed and each file answers for itself. Honest limit: a same-user process that
   deletes the marker AND rewrites every authority file unsealed looks exactly like an install that never sealed; and an
   OS credential store readable by any same-user process (Windows Credential Manager) holds the key such a process could
   use. A seal binds content, not freshness: an older sealed copy of a file (its .bak among them) still opens.

   A STARNET WITHOUT THE KEY ON A SEALED WORKSPACE (fix-sec2 F1, 2026-11-08). The desktop app runs unkeyed when the OS
   credential store does not answer at launch (connector-vault `fallback`), and a bare station (`npm start`, the CLI's
   own, a pm2 deploy) has no key at all. Both go on saving the roster, hooks and approvals, unsealed, and the app's next
   keyed boot refused all of it as "changed outside StarNet" and dropped every agent's Full Access. Now:
     - unkeyed, over a workspace the marker says was sealed, seal() first keeps the file as it is on disk, when it still
       carries a seal, as <name>.sealed-last: the newest copy the key approved (an older one is replaced, an unsealed
       file never is);
     - the next keyed boot with a valid marker reconciles each file that has such a copy and fails its own seal: the
       file is taken where it TAKES POWER AWAY and capped by the sealed copy where it would ADD power (lowerOf: FULL
       BYPASS on, an agent's Full Access or a wider execution profile, a hook, a hook or plugin approval), sealed, written
       back, and the copy dropped; one notice names what was not taken. A file with no sealed copy, or a copy that does
       not verify, is refused exactly as before. The cap is a copy the key sealed, so a process without the key gains
       nothing it could not already get by putting an older sealed copy back;
     - a station with no key over a workspace nobody sealed stays as it was (nothing sealed or checked), and says so
       once in its log and on the Permissions page (GET /api/permissions authoritySeal.keyed false).

   AN OLDER SEALED COPY IS NOT THE CURRENT ONE (fix-sec2 review 4b, 2026-11-08). A seal bound only a file's name and
   content, so any copy the key ever sealed opened forever: after FULL BYPASS was switched off, permissions.bypass.json.bak
   (persist/replace.js keeps the previous main) was a sealed { on: true }; copied over the main file, or the main file
   broken so loadResilient recovered from .bak, FULL BYPASS came back at the next boot. The same for the roster after an
   agent lost Full Access. Now:
     - each seal carries a generation g (a number that only grows: the clock in ms, and always above every generation this
       station has seen for the file), bound into the MAC, so a seal cannot be moved to another generation;
     - a write that TAKES POWER AWAY (lowerOf below finds something the previous value gave that the new one does not:
       FULL BYPASS off, an agent's Full Access or wide profile removed, a hook, an approval or a grant removed) first
       raises the file's floor in the sealed marker to the new generation, then the file is written;
     - open() refuses a copy whose generation is under its floor ('stale'): the reader gets the safe default, as for an
       edited file, and the page says it was an older copy put back.
   A write that only adds power or changes nothing that matters does not move the floor, so a .bak older than it still
   opens (that is the torn-write recovery the .bak exists for, and it gives no more than the current file). The order
   (marker first, then the file) means a crash in between leaves the file under its floor: it reads as its safe default,
   never as the power the user was taking away. Honest limit: the floor lives in the marker, a file in the same
   workspace; a process that saved an old marker AND old files can put both back. Holding the floors (or a counter) in
   the OS credential store beside the key would close that; it needs the desktop shell's Rust side (see 4c).

   A MISSING MARKER IS NOT A FRESH INSTALL (fix-sec2 review 4c, 2026-11-08). Deleting authority-seal.json and stripping
   the seal from each file made the next keyed boot look like the one-time upgrade, which sealed whatever the files then
   said. Now the upgrade runs only when there is no marker AND no trace of sealing anywhere StarNet looks: no seal on any
   authority file, nor on their .bak or .sealed-last copies (opts.evidence). With a trace, a missing marker, or one that
   does not verify (another key, or edited), means the record of what was last taken away is gone: every floor is set
   above every generation seen and above the clock, so no copy sealed before now opens. Each file reads as its safe
   default until StarNet writes it again, the page says why, and the marker is written afresh. A marker that cannot be
   READ (a lock held by antivirus or backup, not damage) holds this boot instead (held): every reader gets its default
   and nothing is saved, and the next start tries again, so a passing lock never costs the user their settings.
   Honest limit (what only the Rust side can add): a process that deletes the marker AND every trace (the files' seals,
   their .bak and .sealed-last copies) still looks like an install that never sealed. The desktop shell could keep a
   record in the OS credential store beside the key ("this key has sealed, at floors F"), written by the sidecar
   through an IPC call; then a missing marker would be detectable whatever the workspace holds, and the floors would
   survive a replayed marker. A same-user process can still write the credential store, so that raises the bar
   (it must target the store too) rather than closing it. Not done here: it needs a Rust change this lane cannot build.

   THREE MORE FILES CARRY AUTHORITY (fix-sec2 review 4a, 2026-11-08). The review found three the first pass left plain:
     - permissions.allow.json: every standing "always allow" and every trusted project folder (path:<root>). Sealed as a
       whole file like the five; refused, it reads as empty (nothing pre-allowed, no trusted folder).
     - .secrets/remote.json: the phones allowed to reach this station. A row with no `pending` field reads as approved,
       so a hand-written phone skipped the desk. Sealed as a whole file; refused, the station keeps its own identity and
       every phone waits for approval at the desk again, asking first, with remote access off.
     - cron.jobs.json: each routine's unattendedGrants and its notepad's taint stamp. This file is rewritten on every
       scheduler tick, so it is sealed in PARTS (sealParts / openParts): one MAC per granted routine over what its grants
       are bound to (agent, prompt, script, workdir, toolsets) and one per clean notepad, all under one generation kept
       in the envelope's __seals. A part that fails loses only what it claimed: that routine's grants, or the notepad
       counts as outside content. Without a key the record is carried as it was read, so a later keyed boot still
       verifies every routine the keyless station did not change.
   A workspace sealed before these three existed (its marker has no `covers`, or does not list one) seals each of them
   once as it is, at its first keyed boot, the same one-time upgrade the five had; `covers` in the sealed marker then
   lists it, so the upgrade cannot be asked for again. */
'use strict';

const crypto = require('node:crypto');

const LABEL = 'starnet/authority-seal/v1';
const FIELD = '__seal';
const MARKER_NAME = 'authority-seal.json';
const LAST_SUFFIX = '.sealed-last';
const RESTORED_NAME = 'authority-restored.json';
const LEGACY_NAMES = Object.freeze(['permissions.bypass.json', 'agent.roster.json', 'hooks.json', 'hooks-allowed.json', 'plugins-allowed.json']);
// sealed as whole files (review 4a added the last two)
const NAMES = Object.freeze(LEGACY_NAMES.concat(['permissions.allow.json', 'remote.json']));
// sealed in parts by their owner (index.js), not as one value
const PART_NAMES = Object.freeze(['cron.jobs.json']);
const ALL_NAMES = Object.freeze(NAMES.concat(PART_NAMES));

// What the safe default means for each file, in the words the page shows.
const CONSEQUENCE = Object.freeze({
  'permissions.bypass.json': 'FULL BYPASS is off. Turn it on again in SETTINGS if you want it.',
  'agent.roster.json': 'every agent asks first. Give Full Access again where you want it.',
  'hooks.json': 'its hooks are not loaded. Add them again in SETTINGS.',
  'hooks-allowed.json': 'every hook waits for your approval again.',
  'plugins-allowed.json': 'every plugin waits for your approval again.',
  'permissions.allow.json': 'every standing permission and every trusted project folder is off. Give them again in PERMISSIONS.',
  'remote.json': 'remote access is off and every paired phone waits for your approval at the desk again, asking first.',
  'cron.jobs.json': 'those routines run without their unattended grants, and a notepad counts as outside content. Grant them again in SCHEDULES.'
});

const plainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Canonical JSON: the value as JSON would carry it (a JSON round trip first), object keys sorted at every depth.
function canonical(value) {
  const walk = v => {
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    if (plainObject(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
    return JSON.stringify(v);
  };
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : walk(JSON.parse(text));
}

// The value without its seal field (a shallow copy; arrays and non-objects come back as they are).
function strip(value) {
  if (!plainObject(value) || !Object.prototype.hasOwnProperty.call(value, FIELD)) return value;
  const out = {};
  for (const k of Object.keys(value)) if (k !== FIELD) out[k] = value[k];
  return out;
}

// A roster whose seal failed keeps who the agents are and loses what they may do: approvalMode back to ask, a wider
// execution envelope back to its default, and no freshness stamp (an unsealed stamp from the future would make every
// real push from the page look stale). A NARROW profile is kept (fix-sec2 breakage 5): Safe Cell is narrower than the
// default, so dropping it would widen the agent. `lost` (optional) collects what was taken, for the restore notice.
function clampRoster(raw, lost) {
  const rows = plainObject(raw) && Array.isArray(raw.agents) ? raw.agents : (Array.isArray(raw) ? raw : []);
  return {
    version: 1,
    agents: rows.filter(plainObject).map(row => {
      const out = {};
      for (const k of Object.keys(row)) if (k !== 'executionProfile') out[k] = row[k];
      out.approvalMode = 'ask';
      const p = row.executionProfile;
      const narrow = typeof p === 'string' && NARROW_PROFILES.indexOf(p) >= 0;
      if (narrow) out.executionProfile = p;
      if (Array.isArray(lost) && (row.approvalMode === 'full' || (p !== undefined && p !== null && p !== '' && !narrow)))
        lost.push({ name: String(row.name || row.agentId || 'agent').slice(0, 40), full: row.approvalMode === 'full', profile: narrow || p == null || p === '' ? '' : String(p).slice(0, 40) });
      return out;
    })
  };
}
const PROFILE_WORDS = Object.freeze({ 'this-computer': 'This Computer', 'trusted-project': 'Trusted Project', 'remote-ssh': 'Remote SSH' });
// the restore notice's words for what clampRoster took: who lost Full Access, and whose profile went back to Station Gear
function lostWords(lost) {
  const q = n => '"' + n + '"';
  const full = lost.filter(x => x.full).map(x => q(x.name));
  const prof = lost.filter(x => x.profile).map(x => q(x.name) + ' (was ' + (PROFILE_WORDS[x.profile] || x.profile) + ')');
  return (full.length ? ' Full Access was not carried over for ' + full.join(', ') + '.' : '')
    + (prof.length ? ' These agents are back on the Station Gear profile until you choose theirs again here: ' + prof.join(', ') + '.' : '');
}

/* lowerOf(name, value, cap, nowMs) -> { value, dropped: [what was not taken] } | null (a file it has no rule for).
   The meet of an unsealed file and the last copy the key sealed: everything in `value` that takes power away is kept,
   and nothing in it gives more power than `cap` gave. Both arrive without their seal field. */
const NARROW_PROFILES = Object.freeze(['station-gear', 'safe-cell']);   // the default envelope and the narrower Safe Cell
const hookKey = h => String(h && h.event) + '\u0000' + String(h && h.command).trim();
function lowerOf(name, value, cap, nowMs) {
  const dropped = [];
  const c = plainObject(cap) ? cap : {};
  if (name === 'permissions.bypass.json') {
    const v = plainObject(value) ? value : {};
    const on = v.on === true && c.on === true;
    if (v.on === true && !on) dropped.push('FULL BYPASS on');
    return { value: Object.assign({}, v, { version: 1, on: on }), dropped };
  }
  if (name === 'agent.roster.json') {
    const rows = plainObject(value) && Array.isArray(value.agents) ? value.agents : (Array.isArray(value) ? value : []);
    const capRows = new Map((Array.isArray(c.agents) ? c.agents : []).filter(plainObject).map(r => [String(r.agentId || ''), r]));
    const agents = rows.filter(plainObject).map(row => {
      const was = capRows.get(String(row.agentId || '')) || null;
      const label = '"' + String(row.name || row.agentId || 'agent').slice(0, 40) + '"';
      const out = Object.assign({}, row);
      if (row.approvalMode === 'full' && !(was && was.approvalMode === 'full')) { out.approvalMode = 'ask'; dropped.push('Full Access for ' + label); }
      if (Object.prototype.hasOwnProperty.call(row, 'executionProfile')) {
        const same = was && canonical(was.executionProfile) === canonical(row.executionProfile);
        if (!same && NARROW_PROFILES.indexOf(String(row.executionProfile)) < 0) {
          delete out.executionProfile;
          dropped.push('the "' + String(row.executionProfile).slice(0, 40) + '" execution profile for ' + label);
        }
      }
      return out;
    });
    const out = { version: 1, agents };
    const stamp = plainObject(value) ? Number(value.updatedAt) : NaN;
    if (Number.isFinite(stamp) && stamp > 0 && stamp <= nowMs) out.updatedAt = stamp;   // never a stamp from the future
    const rev = plainObject(value) ? Number(value.saveRevision) : NaN;
    if (Number.isInteger(rev) && rev > 0) out.saveRevision = rev;
    return { value: out, dropped };
  }
  if (name === 'hooks.json') {
    const list = Array.isArray(value) ? value : (plainObject(value) && Array.isArray(value.hooks) ? value.hooks : []);
    const had = new Set((Array.isArray(c.hooks) ? c.hooks : (Array.isArray(cap) ? cap : [])).filter(plainObject).map(hookKey));
    const hooks = [];
    for (const h of list.filter(plainObject)) {
      if (had.has(hookKey(h))) hooks.push(h);
      else dropped.push('the hook "' + String(h.command || '').slice(0, 60) + '"');
    }
    return { value: Object.assign({}, plainObject(value) ? value : {}, { hooks }), dropped };
  }
  if (name === 'permissions.allow.json') {
    const v = plainObject(value) ? value : {};
    const had = new Set(Array.isArray(c.allow) ? c.allow.filter(k => typeof k === 'string') : []);
    const allow = [];
    for (const k of (Array.isArray(v.allow) ? v.allow : []).filter(x => typeof x === 'string')) {
      if (had.has(k)) allow.push(k);
      else dropped.push(k.indexOf('path:') === 0 ? 'the trusted folder ' + k.slice(5, 85) : 'the standing permission ' + k.slice(0, 80));
    }
    const meta = {};
    const m = plainObject(v.meta) ? v.meta : {};
    for (const k of allow) if (plainObject(m[k])) meta[k] = m[k];
    return { value: Object.assign({}, v, { version: 1, allow, meta }), dropped };
  }
  if (name === 'remote.json') {
    const v = plainObject(value) ? value : {};
    const capRows = new Map((Array.isArray(c.devices) ? c.devices : []).filter(plainObject).map(d => [String(d.id || ''), d]));
    const devices = (Array.isArray(v.devices) ? v.devices : []).filter(plainObject).map(d => {
      const was = capRows.get(String(d.id || ''));
      const label = '"' + String(d.name || d.id || 'phone').slice(0, 40) + '"';
      const out = Object.assign({}, d);
      if (!was || String(was.publicKey) !== String(d.publicKey)) {
        if (d.pending !== true || d.askFirst !== true) dropped.push('the phone ' + label);
        out.pending = true; out.askFirst = true;
        return out;
      }
      if (d.pending !== true && was.pending === true) { out.pending = true; dropped.push('the approval of the phone ' + label); }
      if (d.askFirst !== true && was.askFirst === true) { out.askFirst = true; dropped.push('the phone ' + label + ' acting without asking'); }
      return out;
    });
    const enabled = v.enabled === true && c.enabled === true;
    if (v.enabled === true && !enabled) dropped.push('remote access on');
    return { value: Object.assign({}, v, { devices, enabled }), dropped };
  }
  if (name === 'hooks-allowed.json' || name === 'plugins-allowed.json') {
    const v = plainObject(value) ? value : {};
    const out = {};
    for (const k of Object.keys(v)) {
      const row = v[k], was = c[k];
      const same = plainObject(row) && plainObject(was) && (name === 'plugins-allowed.json'
        ? String(row.digest) === String(was.digest)
        : String(row.event) === String(was.event) && String(row.command) === String(was.command));
      if (same) out[k] = row;
      else dropped.push(name === 'plugins-allowed.json' ? 'the approval of plugin "' + String(k).slice(0, 40) + '"'
        : 'the approval of hook "' + String(plainObject(row) ? row.command : k).slice(0, 60) + '"');
    }
    return { value: out, dropped };
  }
  return null;
}

// lowers(name, prev, next) -> true when `next` takes away power `prev` gave (a file with no rule: always true, the safe
// side: its floor moves). prev null: nothing was sealed before it (the upgrade), so there is nothing to take away.
function lowers(name, prev, next, nowMs) {
  if (prev === null) return false;
  const r = lowerOf(name, prev, next, nowMs);
  return !r || r.dropped.length > 0;
}

// What a refused or restored remote.json keeps: the station's own identity, and its phones, each waiting for the desk.
function clampRemote(raw) {
  const v = plainObject(raw) ? raw : {};
  return Object.assign({}, strip(v), {
    devices: (Array.isArray(v.devices) ? v.devices : []).filter(plainObject).map(d => Object.assign({}, d, { pending: true, askFirst: true })),
    enabled: false
  });
}

// The generation a seal carries: 0 for a seal from before generations, null for one that is not a whole number.
function genOf(s) {
  if (!plainObject(s) || s.g === undefined) return 0;
  return Number.isSafeInteger(s.g) && s.g > 0 ? s.g : null;
}

function makeAuthoritySeal(opts) {
  const o = opts || {};
  const key = Buffer.isBuffer(o.key) && o.key.length >= 32 ? Buffer.from(o.key) : null;
  const now = typeof o.now === 'function' ? o.now : () => 0;
  const marker = o.marker || {};
  const keep = typeof o.keep === 'function' ? o.keep : () => null;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const lastSealed = o.lastSealed && typeof o.lastSealed.read === 'function' && typeof o.lastSealed.write === 'function' ? o.lastSealed : null;
  const current = typeof o.current === 'function' ? o.current : null;
  const restored = o.restored && typeof o.restored.read === 'function' ? o.restored : null;
  const desktop = o.desktop === true;
  let restoreSeen = false;       // this boot found a restore's record (authority-restored.json)
  let restoredBoot = false;      // ...and the marker was missing: the floors were reset for a restore, not a deleted marker
  const evidence = typeof o.evidence === 'function' ? o.evidence : () => [];   // other copies: .bak, .sealed-last (4c)
  let held = '';                 // why this boot keeps every authority file at its default and saves none (4c, 4d)
  const migrating = new Set();   // names sealed once as they are this boot: not yet in the marker's covers (4a)
  let floorsReset = false;       // the marker was missing or foreign: every floor was set above what exists (4c)
  let markerOk = false;
  let sealedAt = 0;
  let sealedWorkspace = false;   // unkeyed only: the marker says a keyed StarNet seals these files (boot)
  const list = [];             // notices, oldest first
  const broken = new Map();    // name -> the notice for a refused file (one per file until it is sealed again)
  const floors = {};           // name -> the lowest generation that still opens (review 4b), kept in the sealed marker
  const lastG = {};            // name -> the highest generation this station has seen or issued for the file
  const known = new Map();     // name -> the value last opened or sealed (null: nothing sealed before), to tell a lowering

  // A seal with a generation binds it: 'v1\n' name '\n' 'g' g '\n' canonical content. Without one (g 0): the first form.
  const macOf = (name, value, g) => crypto.createHmac('sha256', key).update('v1\n' + String(name) + '\n' + (g > 0 ? 'g' + g + '\n' : '') + canonical(strip(value))).digest('hex');
  const floorOf = name => (Number.isSafeInteger(floors[name]) && floors[name] > 0 ? floors[name] : 0);
  const nextGen = name => Math.max(Math.floor(Number(now())) || 0, (lastG[name] || 0) + 1, floorOf(name) + 1);
  const seen = (name, g) => { if (Number.isSafeInteger(g) && g > (lastG[name] || 0)) lastG[name] = g; };
  function notice(n) {
    const row = Object.assign({ at: now() }, n);
    list.push(row);
    if (list.length > 40) list.shift();
    log(row.text);
    return row;
  }
  // writeMarker({ force, strict }): written once when the station starts sealing, and again whenever a floor moves
  // (force). strict: a failure throws, so a write that takes power away is not made without its floor.
  function writeMarker(w) {
    const o = w || {};
    if (!key || (markerOk && !o.force)) return;
    if (!sealedAt) sealedAt = now();
    const fl = {};
    for (const k of Object.keys(floors).sort()) if (floorOf(k)) fl[k] = floors[k];
    const body = { version: 1, sealedAt: sealedAt, floors: fl, covers: ALL_NAMES.filter(n => !migrating.has(n)) };
    try { marker.write(Object.assign({}, body, { [FIELD]: { v: 1, mac: macOf(MARKER_NAME, body, 0) } })); markerOk = true; }
    catch (e) {
      const why = String((e && (e.code || e.message)) || e);
      log('could not write ' + MARKER_NAME + ': ' + why);
      if (o.strict) throw new Error('StarNet could not record this change in ' + MARKER_NAME + ' (' + why + '), so it was not saved. Try again.');
    }
  }
  // the floors a verified marker carries (a marker from before generations has none)
  function adoptMarker(m) {
    sealedAt = Number(m.sealedAt) || 0;
    // a marker from before covers sealed the first five; any name it does not list is sealed once as it is (4a)
    const covers = Array.isArray(m.covers) ? m.covers.map(String) : LEGACY_NAMES.slice();
    for (const n of ALL_NAMES) if (covers.indexOf(n) < 0) migrating.add(n);
    const fl = plainObject(m.floors) ? m.floors : {};
    for (const k of Object.keys(fl)) if (Number.isSafeInteger(fl[k]) && fl[k] > 0) { floors[k] = fl[k]; seen(k, fl[k]); }
  }
  // '' | 'unsealed' | 'mismatch' | 'stale' (a copy the key sealed, older than the file's floor)
  function verify(name, value) {
    if (!plainObject(value) || !plainObject(value[FIELD])) return 'unsealed';
    const s = value[FIELD];
    if (s.v !== 1 || typeof s.mac !== 'string' || !/^[a-f0-9]{64}$/.test(s.mac)) return 'mismatch';
    const g = genOf(s);
    if (g === null) return 'mismatch';
    const want = Buffer.from(macOf(name, value, g), 'hex');
    if (!crypto.timingSafeEqual(want, Buffer.from(s.mac, 'hex'))) return 'mismatch';
    return g < floorOf(String(name)) ? 'stale' : '';
  }

  // Unkeyed over a sealed workspace: before this StarNet overwrites a file it cannot seal, keep the copy the key last
  // sealed (only while the file on disk still carries a seal: the first overwrite keeps it, later ones leave it be).
  function keepLastSealed(name) {
    if (key || !sealedWorkspace || !lastSealed || !current) return;
    let cur;
    try { cur = current(String(name)); } catch (_) { return; }
    if (!plainObject(cur) || !plainObject(cur[FIELD])) return;
    try { lastSealed.write(String(name), cur); }
    catch (e) { log('could not keep the sealed copy of ' + name + ': ' + String((e && (e.code || e.message)) || e)); }
  }

  // seal(name, value) -> the value to write. Unkeyed: the value unchanged (a bare station writes what it always did).
  // Keyed: a write that takes power away moves the file's floor first (review 4b); when the marker cannot record it,
  // this throws and the caller saves nothing (its own failure path: the change is reported, state unchanged).
  function seal(name, value) {
    name = String(name);
    if (held) throw new Error(held);
    if (!key) { keepLastSealed(name); return value; }
    if (!plainObject(value)) return value;
    const body = strip(value);
    const g = nextGen(name);
    if (!known.has(name) || lowers(name, known.get(name), body, now())) {
      const was = floors[name];
      floors[name] = g;
      try { writeMarker({ force: true, strict: true }); }
      catch (e) { if (was === undefined) delete floors[name]; else floors[name] = was; throw e; }
    } else writeMarker();                   // the first sealed write of a station that had nothing to migrate
    broken.delete(name);                    // a file StarNet writes again is whole again
    known.set(name, body);
    seen(name, g);
    return Object.assign({}, body, { [FIELD]: { v: 1, mac: macOf(name, body, g), g: g } });
  }

  // open(name, value) -> { ok, value } (the value without its seal) | { ok: false, why: 'unsealed' | 'mismatch' | 'stale' }.
  // An absent file (undefined / null) is ok: it already reads as its default.
  function open(name, value) {
    name = String(name);
    if (held) return (value === undefined || value === null) ? { ok: true, value: value, absent: true } : { ok: false, why: 'held' };
    if (!key) return { ok: true, value: strip(value), unkeyed: true };
    if (value === undefined || value === null) { known.delete(name); return { ok: true, value: value, absent: true }; }
    const why = verify(name, value);
    if (!why) { known.set(name, strip(value)); seen(name, genOf(value[FIELD])); return { ok: true, value: strip(value) }; }
    known.delete(name);                     // not a value StarNet can compare with: its next write moves the floor
    if (!broken.has(name)) {
      let keptAt = null;
      try { keptAt = keep(name) || null; } catch (_) { keptAt = null; }
      broken.set(name, notice({
        kind: why, name: name, keptAt: keptAt,
        text: why === 'stale' && floorsReset && restoredBoot
          ? name + ' came back with a restore from a recovery bundle, which does not carry the record of what was last taken away, so ' + (CONSEQUENCE[name] || 'it is not used.')
          : why === 'stale' && floorsReset
          ? name + ' cannot be checked against the record of what was last taken away (' + MARKER_NAME + ' was missing or did not match), so ' + (CONSEQUENCE[name] || 'it is not used.')
          : why === 'stale'
          ? name + ' is an older copy than the last change that took power away (it was put back, from a backup or its .bak), so ' + (CONSEQUENCE[name] || 'it is not used.')
          : name + ' was changed outside StarNet (' + (why === 'unsealed' ? 'it has no seal' : 'its seal does not match') + '), so ' +
            (CONSEQUENCE[name] || 'it is not used.') + (keptAt ? ' A copy of it was kept as ' + keptAt + '.' : '')
      }));
    }
    return { ok: false, why: why };
  }

  // keyed, valid marker: take back what an unkeyed StarNet saved (see the header). -> [names reconciled]
  function reconcile(files) {
    const done = [];
    if (!lastSealed) return done;
    // a copy that cannot be removed stays a cap: it can only lower the file again, never raise it
    const drop = name => { try { if (typeof lastSealed.drop === 'function') lastSealed.drop(name); } catch (e) { log('could not remove the sealed copy of ' + name + ': ' + String((e && (e.code || e.message)) || e)); } };
    for (const f of (Array.isArray(files) ? files : [])) {
      let cap;
      try { cap = lastSealed.read(f.name); } catch (_) { continue; }
      if (cap === undefined || cap === null) continue;
      if (verify(f.name, cap)) continue;                 // not a copy this key sealed, or one under the floor (4b): no cap
      let v;
      try { v = f.read(); } catch (_) { continue; }
      if (v === undefined || v === null || !verify(f.name, v)) { drop(f.name); continue; }   // gone, or whole again: spent
      const raw = strip(v);
      const low = lowerOf(f.name, typeof f.wrap === 'function' ? f.wrap(raw) : raw, strip(cap), now());
      if (!low) continue;
      try { f.write(seal(f.name, low.value)); }
      catch (e) { log('could not reseal ' + f.name + ': ' + String((e && (e.code || e.message)) || e)); continue; }
      drop(f.name);
      done.push(f.name);
      notice({ kind: 'reconciled', name: f.name, dropped: low.dropped.slice(0, 20),
        text: f.name + ' was saved by a StarNet that could not seal it (the credential store did not answer, or a StarNet without the app). ' +
          (low.dropped.length ? 'What that change took away is kept; what it added is not used: ' + low.dropped.slice(0, 6).join(', ') +
            (low.dropped.length > 6 ? ' and ' + (low.dropped.length - 6) + ' more' : '') + '. Give it again here if you want it.'
            : 'It is kept as it is and sealed again.') });
    }
    return done;
  }

  /* A RESTORED STATION IS NOT A CHANGED ONE (fix-sec2, review 10). A recovery bundle carries agent.roster.json as sealed on
     the computer that made it and hooks.json with its credential values taken out, and the restore (bin/station-recovery,
     no key) cannot seal anything. On another computer, or after the redaction, the seal failed and the first boot said
     "changed outside StarNet", dropped every hook and every agent's Full Access. The restore now leaves a record naming the
     two; the first keyed boot takes each one that does not open under this key as a restore: the roster keeps its agents,
     each asking first (an approval made on another computer does not travel, like FULL BYPASS and the approval files the
     bundle leaves out), and hooks.json keeps its hooks, each still waiting for approval here. Both are sealed, the record
     is dropped, and one notice says so. A forged record gains nothing: what it admits is the ask-first roster and hooks
     that run only once approved at the desk. A file that opens under this key is left exactly as it is. */
  const RESTORABLE = ['agent.roster.json', 'hooks.json', 'permissions.allow.json'];
  function adoptRestored(files) {
    if (!key || !restored) return [];
    let rec;
    try { rec = restored.read(); } catch (_) { return []; }
    if (rec === undefined || rec === null) return [];
    restoreSeen = true;
    const listed = new Set(plainObject(rec) && Array.isArray(rec.files) ? rec.files.map(String) : []);
    const adopted = [], lost = [];
    for (const f of (Array.isArray(files) ? files : [])) {
      if (!listed.has(f.name) || RESTORABLE.indexOf(f.name) < 0) continue;
      let v;
      try { v = f.read(); } catch (_) { continue; }
      if (v === undefined || v === null || !verify(f.name, v)) continue;
      const raw = strip(v);
      // permissions.allow.json: a restore carries none of its approvals (station-recovery empties it); sealed empty here
      const value = f.name === 'agent.roster.json' ? clampRoster(raw, lost)
        : f.name === 'permissions.allow.json' ? { version: 1, allow: [], meta: {} }
        : (typeof f.wrap === 'function' ? f.wrap(raw) : raw);
      if (!plainObject(value)) continue;
      try { f.write(seal(f.name, value)); adopted.push(f.name); }
      catch (e) { log('could not seal the restored ' + f.name + ': ' + String((e && (e.code || e.message)) || e)); }
    }
    // a record that cannot be removed only reseals, clamped, a listed file that fails its seal again
    try { if (typeof restored.drop === 'function') restored.drop(); } catch (e) { log('could not remove ' + RESTORED_NAME + ': ' + String((e && (e.code || e.message)) || e)); }
    if (adopted.length) notice({ kind: 'restored', sealed: adopted.slice(),
      text: 'Restored from a recovery bundle: ' + adopted.join(', ') + ' sealed for this computer.' +
        (adopted.indexOf('agent.roster.json') >= 0 ? ' Every agent asks first until you give Full Access again here.' + lostWords(lost) : '') +
        (adopted.indexOf('hooks.json') >= 0 ? ' Each hook waits for your approval.' : '') });
    return adopted;
  }

  // what generation each file on disk carries now, so a new seal is always above it (a clock set back included)
  function seedGens(files) {
    for (const f of files) {
      let v;
      try { v = f.read(); } catch (_) { continue; }
      if (plainObject(v) && plainObject(v[FIELD])) seen(f.name, genOf(v[FIELD]));
    }
  }

  // A trace of sealing outside the marker (4c): a seal on any authority file or on one of its other copies. -> { any, maxG }
  function traces(present) {
    let any = false, maxG = 0;
    const look = v => {
      if (!plainObject(v)) return;
      const s = plainObject(v[FIELD]) ? v[FIELD] : (plainObject(v.__seals) ? v.__seals : null);
      if (!s) return;
      any = true;
      const g = genOf(s);
      if (g && g > maxG) maxG = g;
    };
    for (const x of present) look(x.v);
    let more = [];
    try { more = evidence() || []; } catch (e) { log('could not look for other sealed copies: ' + String((e && (e.code || e.message)) || e)); }
    for (const v of (Array.isArray(more) ? more : [])) look(v);
    return { any, maxG };
  }
  // the record of what was last taken away is gone: no copy sealed before now may open (4c)
  function resetFloors(names, maxG) {
    let top = maxG || 0;
    for (const k of Object.keys(lastG)) if (lastG[k] > top) top = lastG[k];
    const base = Math.max((Math.floor(Number(now())) || 0) + 1, top + 1);
    for (const n of names) { floors[n] = base; seen(n, base); }
    floorsReset = true;
  }

  /* RECORDS SEALED IN PARTS (review 4a; cron.jobs.json). parts: { key: value } — only what claims power (a routine's
     grants with what they are bound to, a notepad that says it is clean). The record { v, g, macs } rides in the file.
       sealParts(name, parts, { lowering }) -> record | null (unkeyed: the caller carries the record it read). lowering
         (the caller knows: grants removed, a granted routine deleted) moves the floor first, as seal() does.
       openParts(name, record, parts) -> null (unkeyed: obey as is) | { migrating } (sealed once as it is: obey) |
         { held } (obey nothing that needs the seal) | { ok: [keys that verify], stale }
       refused(name, text): the one notice for a file whose parts failed (until StarNet seals it again). */
  const partMac = (name, k, g, value) => crypto.createHmac('sha256', key).update('v1\n' + String(name) + '#' + String(k) + '\ng' + g + '\n' + canonical(value)).digest('hex');
  function sealParts(name, parts, o) {
    name = String(name);
    if (held) throw new Error(held);
    if (!key) return null;
    const g = nextGen(name);
    const wasMigrating = migrating.delete(name);
    if ((o && o.lowering === true) || !known.has(name)) {
      const was = floors[name];
      floors[name] = g;
      try { writeMarker({ force: true, strict: true }); }
      catch (e) { if (was === undefined) delete floors[name]; else floors[name] = was; if (wasMigrating) migrating.add(name); throw e; }
    } else writeMarker({ force: wasMigrating });
    known.set(name, true);
    seen(name, g);
    broken.delete(name);
    const macs = {};
    for (const k of Object.keys(parts || {}).sort()) macs[k] = partMac(name, k, g, parts[k]);
    return { v: 1, g: g, macs: macs };
  }
  function openParts(name, rec, parts) {
    name = String(name);
    if (held) return { held: true };
    if (!key) return null;
    if (migrating.has(name)) return { migrating: true };
    const g = plainObject(rec) && rec.v === 1 ? genOf(rec) : 0;
    const macs = plainObject(rec) && plainObject(rec.macs) ? rec.macs : {};
    const ok = [];
    const fresh = g !== null && g > 0 && g >= floorOf(name);
    if (fresh) {
      for (const k of Object.keys(parts || {})) {
        const mac = macs[k];
        if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) continue;
        if (crypto.timingSafeEqual(Buffer.from(partMac(name, k, g, parts[k]), 'hex'), Buffer.from(mac, 'hex'))) ok.push(k);
      }
      seen(name, g);
    }
    known.set(name, true);
    return { ok: ok, stale: g !== null && g > 0 && !fresh };
  }
  function refused(name, text) {
    name = String(name);
    if (broken.has(name)) return;
    broken.set(name, notice({ kind: 'parts', name: name, text: String(text) }));
  }

  function boot(files) {
    files = Array.isArray(files) ? files : [];
    if (!key) {
      // as before: nothing sealed or checked. Only a workspace the desktop app sealed is told what that means here.
      let sealedHere = false;
      try { sealedHere = marker.read && marker.read() !== undefined; } catch (_) { sealedHere = true; }
      sealedWorkspace = sealedHere;
      /* THE DESKTOP APP WITHOUT ITS KEY DOES NOT READ SEALED FILES UNCHECKED (review 4d). The app always has a
         credential-store key; without one (the store unreachable, or a damaged entry that the shell could not read) a
         sealed workspace's files cannot be checked, and anyone who can write them could have. So this boot holds:
         every file reads as its safe default and no permission change is saved, with the reason, until a restart
         finds the key. A bare or pm2 station has no key by design and goes on as before (the notice below). */
      if (desktop && sealedHere) {
        held = 'StarNet cannot save permission changes right now: it could not read its key from this computer\'s credential store, and this station\'s permission files were sealed with it. Restart StarNet to try again.';
        notice({ kind: 'held', text: 'StarNet could not read its key from this computer\'s credential store, so it cannot check the permission files it sealed with it. Until it can, FULL BYPASS is off, every agent asks first, no hooks or plugins run, standing permissions are off, and permission changes are not saved. Restart StarNet to try again; if this keeps happening, check that the system credential store (Windows Credential Manager, the macOS keychain, or the Secret Service) is working.' });
        return { mode: 'held', sealed: [], failed: [] };
      }
      if (sealedHere) notice({ kind: 'unkeyed-sealed', text: 'These permission files were sealed by the StarNet app, but this StarNet has no credential-store key. They are read as they are. When the app opens them again it keeps what a change made here takes away, and does not use what one adds (FULL BYPASS, Full Access, a hook or an approval) until you give it there.' });
      else log('unkeyed: this station has no credential-store key, so its permission files are not sealed (any program running as this user can change them)');
      return { mode: 'unkeyed', sealed: [], failed: [] };
    }
    seedGens(files);
    let m, markerErr = null;
    try { m = marker.read(); } catch (e) { markerErr = e || new Error('unreadable'); }
    if (markerErr && !(markerErr instanceof SyntaxError || markerErr.name === 'SyntaxError')) {
      // could not be read (a lock, not damage): this boot neither trusts the files nor rewrites the record
      const why = String(markerErr.code || markerErr.message || markerErr).slice(0, 80);
      held = 'StarNet cannot save permission changes right now: it could not read ' + MARKER_NAME + ' (' + why + '), the record of which permission files are current. Restart StarNet to try again.';
      notice({ kind: 'held', text: 'StarNet could not read ' + MARKER_NAME + ' (' + why + '), so until it restarts FULL BYPASS is off, every agent asks first, no hooks or plugins run, standing permissions are off, and permission changes are not saved. Another program (antivirus, backup or sync) may be holding the file: restart StarNet to try again.' });
      return { mode: 'held', sealed: [], failed: [] };
    }
    const markerValid = !markerErr && m !== undefined && !verify(MARKER_NAME, m);
    const present = [];
    for (const f of files) {
      let v;
      try { v = f.read(); } catch (_) { continue; }
      if (v !== undefined && v !== null) present.push({ f: f, v: v });
    }
    const names = files.map(f => f.name);
    let lost = '';                          // 'mismatch' | 'missing': the record of floors is gone (4c)
    if (markerValid) { markerOk = true; adoptMarker(m); }   // the floors first: a restore or a sealed copy is judged against them (4b)
    else if (m !== undefined || markerErr) lost = 'mismatch';
    else { const t = traces(present); if (t.any) { lost = 'missing'; resetFloors(names, t.maxG); } }
    if (lost === 'mismatch') resetFloors(names, traces(present).maxG);
    // a restore is taken before anything else (it is sealed above the new floors, so it is current)
    const adopted = adoptRestored(files);
    if (markerValid) {
      const reconciled = reconcile(files);
      // a file this marker does not cover yet (added after the workspace was sealed): sealed once as it is (4a)
      const sealedNow = [], failedNow = [];
      for (const x of present) {
        if (!migrating.has(x.f.name)) continue;
        migrating.delete(x.f.name);
        if (plainObject(x.v) && plainObject(x.v[FIELD])) continue;   // already sealed: it answers for itself
        const value = typeof x.f.wrap === 'function' ? x.f.wrap(x.v) : x.v;
        if (!plainObject(value)) { failedNow.push(x.f.name); continue; }
        known.set(x.f.name, null);
        try { x.f.write(seal(x.f.name, value)); sealedNow.push(x.f.name); }
        catch (e) { failedNow.push(x.f.name); }
      }
      for (const f of files) migrating.delete(f.name);   // absent: nothing to seal, covered from now on
      writeMarker({ force: true });
      if (sealedNow.length || failedNow.length) notice({ kind: 'migrated', sealed: sealedNow.slice(), failed: failedNow.slice(),
        text: 'StarNet now also seals ' + (sealedNow.length ? sealedNow.join(', ') : 'nothing more') + ', once, on this upgrade' +
          (failedNow.length ? '; ' + failedNow.join(', ') + ' could not be sealed and will not be used' : '') +
          '. A change made to ' + (sealedNow.length > 1 ? 'them' : 'it') + ' outside StarNet is not obeyed from now on.' });
      return { mode: 'enforce', sealed: sealedNow, failed: failedNow, reconciled: reconciled, migrating: Array.from(migrating) };
    }
    if (lost) {
      writeMarker({ force: true });
      /* A RESTORE IS NOT A DELETED MARKER (fix-sec2 breakage 6). A recovery bundle never carries authority-seal.json, so a
         restore's first keyed boot always finds it missing. With the restore's record there, that is said as a restore:
         no marker-missing warning. Nothing is trusted more for it: every file the restore did not re-seal is still judged
         against the reset floors (not used until set again here), and its own notice says it came back with the restore. */
      restoredBoot = lost === 'missing' && restoreSeen;
      if (!restoredBoot) notice({ kind: 'marker-' + lost, text: (lost === 'mismatch'
        ? MARKER_NAME + ' does not match this computer\'s key (the credential-store entry changed, or the file was edited).'
        : MARKER_NAME + ' is missing, although these permission files were sealed.') +
        ' It is the record of what was last taken away, so StarNet cannot tell an older copy of a permission file from the current one: none of them is used until you set it again here. Nothing was re-sealed.' });
      return { mode: 'enforce', sealed: [], failed: [] };
    }
    // no marker and no trace: the upgrade (or a new station). What is sealed in parts is sealed by its owner, once, as it is.
    for (const n of PART_NAMES) migrating.add(n);
    if (adopted.length) return { mode: 'enforce', sealed: [], failed: [], migrating: Array.from(migrating) };   // a restore into a fresh folder: the rest answers for itself
    if (!present.length) return { mode: 'enforce', sealed: [], failed: [], migrating: Array.from(migrating) };   // the marker comes with the first sealed write
    const sealed = [], failed = [];
    for (const x of present) {
      const value = typeof x.f.wrap === 'function' ? x.f.wrap(x.v) : x.v;
      if (!plainObject(value)) { failed.push(x.f.name); continue; }
      known.set(x.f.name, null);            // nothing was sealed before the upgrade: no floor to move
      try { x.f.write(seal(x.f.name, value)); sealed.push(x.f.name); }
      catch (e) { failed.push(x.f.name); }
    }
    writeMarker();
    notice({ kind: 'migrated', sealed: sealed.slice(), failed: failed.slice(),
      text: 'StarNet now seals its permission files with a key from this computer\'s credential store. It sealed ' +
        (sealed.length ? sealed.join(', ') : 'nothing') + ' once, on this upgrade' +
        (failed.length ? '; ' + failed.join(', ') + ' could not be sealed and will not be used' : '') +
        '. A change made to them outside StarNet is not obeyed from now on.' });
    return { mode: 'migrated', sealed: sealed, failed: failed, migrating: Array.from(migrating) };
  }

  return {
    get keyed() { return !!key; },
    get held() { return held; },
    sealParts: sealParts, openParts: openParts, refused: refused,
    seal: seal, open: open, boot: boot, clampRoster: clampRoster,
    notices: () => list.map(n => Object.assign({}, n, n.sealed ? { sealed: n.sealed.slice() } : {}, n.failed ? { failed: n.failed.slice() } : {}, n.dropped ? { dropped: n.dropped.slice() } : {}))
  };
}

// keepCopy(fs, file) -> the path of a byte-exact copy of a refused file (<file>.unsealed-<n>, first free), or null.
// A copy, never a hard link: the hook files are rewritten in place, and a link would follow the new bytes.
function keepCopy(fs, file) {
  const r = require('./persist/quarantine.js').preserve({ fs: fs }, file, 'unsealed', { copyOnly: true });
  return r && r.ok ? r.to : null;
}

module.exports = { makeAuthoritySeal, keepCopy, clampRoster, clampRemote, lowerOf, canonical, strip, LABEL, FIELD, MARKER_NAME, LAST_SUFFIX, RESTORED_NAME, NAMES, LEGACY_NAMES, PART_NAMES, CONSEQUENCE };
