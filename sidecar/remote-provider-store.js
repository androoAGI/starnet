'use strict';
// Remote-only credentials. The existing desktop keychain and IPC gate stay independent.
const { writeFileDurable } = require('./durable-write');

function createRemoteProviderStore({ fs, path, dir, write = writeFileDurable }) {
  const file = path.join(dir, 'remote-providers.json');
  let rows = Object.create(null), error = '';
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) throw new Error('invalid store');
    for (const row of Object.values(data.providers)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || ['key', 'baseUrl'].some(k => Object.hasOwn(row, k) && typeof row[k] !== 'string')
        || (Object.hasOwn(row, 'keyPool') && (!Array.isArray(row.keyPool) || row.keyPool.some(k => typeof k !== 'string')))) throw new Error('invalid provider record');
    }
    rows = Object.assign(Object.create(null), data.providers);
  } catch (e) {
    if (e.code !== 'ENOENT') error = 'Remote provider storage is unreadable; existing credentials were left untouched.';
  }
  return {
    get: id => rows[id] || null,
    error: () => error,
    update(id, patch, { migrate = false } = {}) {
      if (error) throw new Error(error);
      // Migration is insert-only. An old viewer cannot overwrite a newer credential or a removal.
      if (migrate && Object.hasOwn(rows, id)) return rows[id];
      const next = Object.assign(Object.create(null), rows, { [id]: { ...rows[id], ...patch } });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      // Force private permissions on the atomic writer's temporary file too, independently of umask.
      const privateFs = Object.create(fs);
      privateFs.openSync = (name, flags) => fs.openSync(name, flags, 0o600);
      const data = JSON.stringify({ version: 1, providers: next });
      write({ fs: privateFs, path }, file, data);
      if (fs.readFileSync(file, 'utf8') !== data) throw new Error('Remote provider storage could not be verified.');
      rows = next;
      return rows[id];
    }
  };
}
module.exports = { createRemoteProviderStore };
