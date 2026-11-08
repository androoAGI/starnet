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

   makeAuthoritySeal({ key, now, marker: { read, write }, keep?, log? })
     key      Buffer | null — the derived seal key; null (a bare station, or the desktop without its credential store)
              means unkeyed: nothing is sealed or checked, exactly as before (boot reports mode 'unkeyed').
     marker   read() -> value | undefined (absent), throws when unreadable; write(value). The sealed record that this
              station has been sealing (authority-seal.json). It turns the one-time upgrade into a one-time event: once
              it exists, an unsealed file is a changed file, never an old one.
     keep     (name) -> path | null: keep a copy of a refused file's bytes (once per file per process).
   -> { keyed, seal(name, value), open(name, value), boot(files), notices(), clampRoster(raw) }

   boot(files: [{ name, read, write, wrap? }]) runs once, before any reader. With a valid marker: nothing to do. With no
   marker and no sealed file: this is the upgrade — every present file is sealed as it is (wrap first, e.g. a legacy
   array hooks.json becomes { hooks }) and the marker is written; a notice names what was sealed. With no marker but a
   sealed file present, or a marker that does not verify: not an upgrade (the marker was removed or the key changed),
   so nothing is re-sealed and each file answers for itself. Honest limit: a same-user process that deletes the marker
   AND rewrites every authority file unsealed looks exactly like an install that never sealed; and an OS credential
   store readable by any same-user process (Windows Credential Manager) holds the key such a process could use. */
'use strict';

const crypto = require('node:crypto');

const LABEL = 'starnet/authority-seal/v1';
const FIELD = '__seal';
const MARKER_NAME = 'authority-seal.json';
const NAMES = Object.freeze(['permissions.bypass.json', 'agent.roster.json', 'hooks.json', 'hooks-allowed.json', 'plugins-allowed.json']);

// What the safe default means for each file, in the words the page shows.
const CONSEQUENCE = Object.freeze({
  'permissions.bypass.json': 'FULL BYPASS is off. Turn it on again in SETTINGS if you want it.',
  'agent.roster.json': 'every agent asks first. Give Full Access again where you want it.',
  'hooks.json': 'its hooks are not loaded. Add them again in SETTINGS.',
  'hooks-allowed.json': 'every hook waits for your approval again.',
  'plugins-allowed.json': 'every plugin waits for your approval again.'
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

// A roster whose seal failed keeps who the agents are and loses what they may do: approvalMode back to ask, the
// execution envelope back to its default, and no freshness stamp (an unsealed stamp from the future would make every
// real push from the page look stale).
function clampRoster(raw) {
  const rows = plainObject(raw) && Array.isArray(raw.agents) ? raw.agents : (Array.isArray(raw) ? raw : []);
  return {
    version: 1,
    agents: rows.filter(plainObject).map(row => {
      const out = {};
      for (const k of Object.keys(row)) if (k !== 'executionProfile') out[k] = row[k];
      out.approvalMode = 'ask';
      return out;
    })
  };
}

function makeAuthoritySeal(opts) {
  const o = opts || {};
  const key = Buffer.isBuffer(o.key) && o.key.length >= 32 ? Buffer.from(o.key) : null;
  const now = typeof o.now === 'function' ? o.now : () => 0;
  const marker = o.marker || {};
  const keep = typeof o.keep === 'function' ? o.keep : () => null;
  const log = typeof o.log === 'function' ? o.log : () => {};
  let markerOk = false;
  const list = [];             // notices, oldest first
  const broken = new Map();    // name -> the notice for a refused file (one per file until it is sealed again)

  const macOf = (name, value) => crypto.createHmac('sha256', key).update('v1\n' + String(name) + '\n' + canonical(strip(value))).digest('hex');
  function notice(n) {
    const row = Object.assign({ at: now() }, n);
    list.push(row);
    if (list.length > 40) list.shift();
    log(row.text);
    return row;
  }
  function writeMarker() {
    if (!key || markerOk) return;
    const body = { version: 1, sealedAt: now() };
    try { marker.write(Object.assign({}, body, { [FIELD]: { v: 1, mac: macOf(MARKER_NAME, body) } })); markerOk = true; }
    catch (e) { log('could not write ' + MARKER_NAME + ': ' + String((e && (e.code || e.message)) || e)); }
  }
  function verify(name, value) {
    if (!plainObject(value) || !plainObject(value[FIELD])) return 'unsealed';
    const s = value[FIELD];
    if (s.v !== 1 || typeof s.mac !== 'string' || !/^[a-f0-9]{64}$/.test(s.mac)) return 'mismatch';
    const want = Buffer.from(macOf(name, value), 'hex');
    return crypto.timingSafeEqual(want, Buffer.from(s.mac, 'hex')) ? '' : 'mismatch';
  }

  // seal(name, value) -> the value to write. Unkeyed: the value unchanged (a bare station writes what it always did).
  function seal(name, value) {
    if (!key || !plainObject(value)) return value;
    writeMarker();                          // the first sealed write of a station that had nothing to migrate
    broken.delete(String(name));            // a file StarNet writes again is whole again
    const body = strip(value);
    return Object.assign({}, body, { [FIELD]: { v: 1, mac: macOf(name, body) } });
  }

  // open(name, value) -> { ok, value } (the value without its seal) | { ok: false, why: 'unsealed' | 'mismatch' }.
  // An absent file (undefined / null) is ok: it already reads as its default.
  function open(name, value) {
    if (!key) return { ok: true, value: strip(value), unkeyed: true };
    if (value === undefined || value === null) return { ok: true, value: value, absent: true };
    const why = verify(String(name), value);
    if (!why) return { ok: true, value: strip(value) };
    if (!broken.has(String(name))) {
      let keptAt = null;
      try { keptAt = keep(String(name)) || null; } catch (_) { keptAt = null; }
      broken.set(String(name), notice({
        kind: why, name: String(name), keptAt: keptAt,
        text: String(name) + ' was changed outside StarNet (' + (why === 'unsealed' ? 'it has no seal' : 'its seal does not match') + '), so ' +
          (CONSEQUENCE[name] || 'it is not used.') + (keptAt ? ' A copy of it was kept as ' + keptAt + '.' : '')
      }));
    }
    return { ok: false, why: why };
  }

  function boot(files) {
    if (!key) {
      // as before: nothing sealed or checked. Only a workspace the desktop app sealed is told what that means here.
      let sealedHere = false;
      try { sealedHere = marker.read && marker.read() !== undefined; } catch (_) { sealedHere = true; }
      if (sealedHere) notice({ kind: 'unkeyed-sealed', text: 'These permission files were sealed by the StarNet app, but this StarNet has no credential-store key. They are read as they are, and a change made here is not obeyed by the app until it is made there again.' });
      return { mode: 'unkeyed', sealed: [], failed: [] };
    }
    let m, markerBad = false;
    try { m = marker.read(); } catch (_) { markerBad = true; }
    if (m !== undefined || markerBad) {
      if (!markerBad && !verify(MARKER_NAME, m)) { markerOk = true; return { mode: 'enforce', sealed: [], failed: [] }; }
      notice({ kind: 'marker-mismatch', text: MARKER_NAME + ' does not match this computer\'s key (the credential-store entry changed, or the file was edited). Each permission file is checked as it is; any that do not match are not used.' });
      writeMarker();
      return { mode: 'enforce', sealed: [], failed: [] };
    }
    const present = [];
    for (const f of (Array.isArray(files) ? files : [])) {
      let v;
      try { v = f.read(); } catch (_) { continue; }
      if (v !== undefined && v !== null) present.push({ f: f, v: v });
    }
    if (present.some(x => plainObject(x.v) && Object.prototype.hasOwnProperty.call(x.v, FIELD))) {
      notice({ kind: 'marker-missing', text: MARKER_NAME + ' is missing although the permission files are sealed. Nothing was re-sealed; each file is checked as it is.' });
      writeMarker();
      return { mode: 'enforce', sealed: [], failed: [] };
    }
    if (!present.length) return { mode: 'enforce', sealed: [], failed: [] };   // the marker comes with the first sealed write
    const sealed = [], failed = [];
    for (const x of present) {
      const value = typeof x.f.wrap === 'function' ? x.f.wrap(x.v) : x.v;
      if (!plainObject(value)) { failed.push(x.f.name); continue; }
      try { x.f.write(seal(x.f.name, value)); sealed.push(x.f.name); }
      catch (e) { failed.push(x.f.name); }
    }
    writeMarker();
    notice({ kind: 'migrated', sealed: sealed.slice(), failed: failed.slice(),
      text: 'StarNet now seals its permission files with a key from this computer\'s credential store. It sealed ' +
        (sealed.length ? sealed.join(', ') : 'nothing') + ' once, on this upgrade' +
        (failed.length ? '; ' + failed.join(', ') + ' could not be sealed and will not be used' : '') +
        '. A change made to them outside StarNet is not obeyed from now on.' });
    return { mode: 'migrated', sealed: sealed, failed: failed };
  }

  return {
    get keyed() { return !!key; },
    seal: seal, open: open, boot: boot, clampRoster: clampRoster,
    notices: () => list.map(n => Object.assign({}, n, n.sealed ? { sealed: n.sealed.slice() } : {}, n.failed ? { failed: n.failed.slice() } : {}))
  };
}

// keepCopy(fs, file) -> the path of a byte-exact copy of a refused file (<file>.unsealed-<n>, first free), or null.
// A copy, never a hard link: the hook files are rewritten in place, and a link would follow the new bytes.
function keepCopy(fs, file) {
  const r = require('./persist/quarantine.js').preserve({ fs: fs }, file, 'unsealed', { copyOnly: true });
  return r && r.ok ? r.to : null;
}

module.exports = { makeAuthoritySeal, keepCopy, clampRoster, canonical, strip, LABEL, FIELD, MARKER_NAME, NAMES, CONSEQUENCE };
