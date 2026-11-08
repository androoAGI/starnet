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
       once in its log and on the Permissions page (GET /api/permissions authoritySeal.keyed false). */
'use strict';

const crypto = require('node:crypto');

const LABEL = 'starnet/authority-seal/v1';
const FIELD = '__seal';
const MARKER_NAME = 'authority-seal.json';
const LAST_SUFFIX = '.sealed-last';
const RESTORED_NAME = 'authority-restored.json';
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
  let markerOk = false;
  let sealedWorkspace = false;   // unkeyed only: the marker says a keyed StarNet seals these files (boot)
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
  function seal(name, value) {
    if (!key) { keepLastSealed(name); return value; }
    if (!plainObject(value)) return value;
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
      if (verify(f.name, cap)) continue;                 // not a copy this key sealed: no cap, the file answers for itself
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
  function adoptRestored(files) {
    if (!key || !restored) return [];
    let rec;
    try { rec = restored.read(); } catch (_) { return []; }
    if (rec === undefined || rec === null) return [];
    const listed = new Set(plainObject(rec) && Array.isArray(rec.files) ? rec.files.map(String) : []);
    const adopted = [];
    for (const f of (Array.isArray(files) ? files : [])) {
      if (!listed.has(f.name) || (f.name !== 'agent.roster.json' && f.name !== 'hooks.json')) continue;
      let v;
      try { v = f.read(); } catch (_) { continue; }
      if (v === undefined || v === null || !verify(f.name, v)) continue;
      const raw = strip(v);
      const value = f.name === 'agent.roster.json' ? clampRoster(raw) : (typeof f.wrap === 'function' ? f.wrap(raw) : raw);
      if (!plainObject(value)) continue;
      try { f.write(seal(f.name, value)); adopted.push(f.name); }
      catch (e) { log('could not seal the restored ' + f.name + ': ' + String((e && (e.code || e.message)) || e)); }
    }
    // a record that cannot be removed only reseals, clamped, a listed file that fails its seal again
    try { if (typeof restored.drop === 'function') restored.drop(); } catch (e) { log('could not remove ' + RESTORED_NAME + ': ' + String((e && (e.code || e.message)) || e)); }
    if (adopted.length) notice({ kind: 'restored', sealed: adopted.slice(),
      text: 'Restored from a recovery bundle: ' + adopted.join(' and ') + ' sealed for this computer.' +
        (adopted.indexOf('agent.roster.json') >= 0 ? ' Every agent asks first until you give Full Access again here.' : '') +
        (adopted.indexOf('hooks.json') >= 0 ? ' Each hook waits for your approval.' : '') });
    return adopted;
  }

  function boot(files) {
    adoptRestored(files);
    if (!key) {
      // as before: nothing sealed or checked. Only a workspace the desktop app sealed is told what that means here.
      let sealedHere = false;
      try { sealedHere = marker.read && marker.read() !== undefined; } catch (_) { sealedHere = true; }
      sealedWorkspace = sealedHere;
      if (sealedHere) notice({ kind: 'unkeyed-sealed', text: 'These permission files were sealed by the StarNet app, but this StarNet has no credential-store key. They are read as they are. When the app opens them again it keeps what a change made here takes away, and does not use what one adds (FULL BYPASS, Full Access, a hook or an approval) until you give it there.' });
      else log('unkeyed: this station has no credential-store key, so its permission files are not sealed (any program running as this user can change them)');
      return { mode: 'unkeyed', sealed: [], failed: [] };
    }
    let m, markerBad = false;
    try { m = marker.read(); } catch (_) { markerBad = true; }
    if (m !== undefined || markerBad) {
      if (!markerBad && !verify(MARKER_NAME, m)) { markerOk = true; const reconciled = reconcile(files); return { mode: 'enforce', sealed: [], failed: [], reconciled }; }
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
    notices: () => list.map(n => Object.assign({}, n, n.sealed ? { sealed: n.sealed.slice() } : {}, n.failed ? { failed: n.failed.slice() } : {}, n.dropped ? { dropped: n.dropped.slice() } : {}))
  };
}

// keepCopy(fs, file) -> the path of a byte-exact copy of a refused file (<file>.unsealed-<n>, first free), or null.
// A copy, never a hard link: the hook files are rewritten in place, and a link would follow the new bytes.
function keepCopy(fs, file) {
  const r = require('./persist/quarantine.js').preserve({ fs: fs }, file, 'unsealed', { copyOnly: true });
  return r && r.ok ? r.to : null;
}

module.exports = { makeAuthoritySeal, keepCopy, clampRoster, lowerOf, canonical, strip, LABEL, FIELD, MARKER_NAME, LAST_SUFFIX, RESTORED_NAME, NAMES, CONSEQUENCE };
