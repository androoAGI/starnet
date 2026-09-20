'use strict';

const crypto = require('node:crypto');
const { writeFileDurable } = require('./durable-write.js');

const FORMAT = 'starnet.connector-vault.v1';
const AAD = Buffer.from(FORMAT);
const UNAVAILABLE = 'Connector credentials are locked. Restart StarNet with the original OS account and an unlocked credential store.';
function validState(value) {
  const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
  return object(value) && value.version === 2 && Array.isArray(value.configs) &&
    object(value.oauth) && object(value.oauth.byId) && object(value.oauth.clients);
}

// The desktop shell supplies a stable, OS-keychain-backed key. Never create a
// plaintext key beside the ciphertext, and never treat a missing key as empty data.
function makeConnectorVault({ fs, path, keyHex = '', required = false, writeDurable = writeFileDurable }) {
  if (keyHex && !/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error(UNAVAILABLE);
  const key = keyHex ? Buffer.from(keyHex, 'hex') : null;
  let locked = required && !key;
  function decode(value) {
    if (value && typeof value.format === 'string' && value.format.startsWith('starnet.connector-vault.') && value.format !== FORMAT) throw new Error(UNAVAILABLE);
    if (!value || value.format !== FORMAT) return value;
    if (!key) throw new Error(UNAVAILABLE);
    try {
      if (!/^[a-f0-9]{24}$/.test(value.iv || '') || !/^[a-f0-9]{32}$/.test(value.tag || '') ||
          typeof value.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error();
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      cipher.setAAD(AAD);
      cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      const plain = JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
      if (!validState(plain)) throw new Error();
      return plain;
    } catch (_) { throw new Error(UNAVAILABLE); }
  }
  function encode(value) {
    if (!validState(value)) throw new Error('Invalid connector state; saved credentials were preserved');
    if (!key) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { format: FORMAT, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
  }
  function readOne(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { absent: true }; throw new Error(UNAVAILABLE); }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { corrupt: true }; }
    // Every supported current/legacy format is an object. JSON null is present
    // data, never proof of an absent store: boot migration would otherwise seal
    // an empty state over this file AND its last-good encrypted backup.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(UNAVAILABLE);
    return { value: decode(parsed), encrypted: parsed && parsed.format === FORMAT };
  }
  function load(file) {
    if (locked) throw new Error(UNAVAILABLE);
    try {
      const main = readOne(file);
      if (!main.absent && !main.corrupt) return main.value;
      const bak = readOne(file + '.bak');
      if (!bak.absent && !bak.corrupt) return bak.value;
      if (main.absent && bak.absent) return undefined;
      throw new Error(UNAVAILABLE);
    } catch (_) { locked = true; throw new Error(UNAVAILABLE); }
  }
  function readVerified(file, value) {
    const got = readOne(file);
    if (got.absent || got.corrupt || key && !got.encrypted || JSON.stringify(got.value) !== JSON.stringify(value)) throw new Error(UNAVAILABLE);
  }
  function write(file, value, { removal = false } = {}) {
    if (locked) throw new Error(UNAVAILABLE);
    // Read before writing: a wrong/missing key must never overwrite the last copy.
    const previous = load(file);
    const data = JSON.stringify(encode(value));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!removal && previous !== undefined) {
      writeDurable({ fs, path }, file + '.bak', JSON.stringify(encode(previous)));
      readVerified(file + '.bak', previous);
    }
    writeDurable({ fs, path }, file, data);
    readVerified(file, value);
    // First write and explicit removal must both have a verified recovery copy.
    if (removal || previous === undefined) {
      writeDurable({ fs, path }, file + '.bak', JSON.stringify(encode(value)));
      readVerified(file + '.bak', value);
    }
    return true;
  }
  function migrate(file, value, legacyFiles = []) {
    if (!key) return false;
    // Seal BOTH copies and verify before removing any old credential file.
    write(file, value, { removal: true });
    for (const legacy of legacyFiles) {
      for (const target of [legacy, legacy + '.bak']) {
        try { fs.unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Connector credential migration could not remove a legacy copy'); }
      }
    }
    return true;
  }
  return { load, write, migrate, get protected() { return !!key && !locked; }, get locked() { return locked; } };
}

module.exports = { makeConnectorVault, FORMAT, UNAVAILABLE };
