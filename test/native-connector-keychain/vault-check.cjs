'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { makeConnectorVault, FORMAT } = require('../../sidecar/connector-vault.js');
const keyHex = process.env.STARNET_CONNECTOR_ENCRYPTION_KEY;
delete process.env.STARNET_CONNECTOR_ENCRYPTION_KEY;
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.STARNET_DISPOSABLE_KEYCHAIN, '1');
assert.ok(process.env.RUNNER_TEMP);
const dir = path.join(process.env.RUNNER_TEMP, 'starnet-connector-keychain-acceptance');
const file = path.join(dir, 'state.json'), legacy = path.join(dir, 'oauth.json');
const state = {version:2,configs:[{id:'google-files'},{id:'custom-service'}],oauth:{byId:{'google-files':{accessToken:'SYNTHETIC_ACCESS',refreshToken:'SYNTHETIC_REFRESH'}},clients:{}}};
const make = extra => makeConnectorVault({fs,path,keyHex,required:true,...extra});
if (process.argv[2] === 'migrate') {
  assert.ok(!fs.existsSync(dir), 'fresh disposable fixture required');
  fs.mkdirSync(dir);
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(legacy, JSON.stringify(state.oauth));
  const before = fs.readFileSync(file);
  assert.throws(()=>make({writeDurable(){throw Error('synthetic disk failure');}}).migrate(file,state,[legacy]));
  assert.deepEqual(fs.readFileSync(file),before);
  assert.ok(fs.existsSync(legacy), 'write failure preserves the legacy secret');
  make().migrate(file,state,[legacy]);
  assert.ok(!fs.existsSync(legacy));
} else assert.equal(process.argv[2], 'recover');
for (const target of [file,file+'.bak']) {
  const raw=fs.readFileSync(target,'utf8');
  assert.equal(JSON.parse(raw).format,FORMAT);
  assert.ok(!raw.includes('SYNTHETIC_') && !raw.includes(keyHex));
  assert.deepEqual(make().load(target),state);
}
const before=fs.readFileSync(file);
assert.throws(()=>make({keyHex:''}).load(file));
assert.throws(()=>make({keyHex:'b2'.repeat(32)}).write(file,state));
assert.deepEqual(fs.readFileSync(file),before);
console.log('PASS native-key vault '+process.argv[2]+': encrypted main/backup, exact recovery, failed writes preserve originals');
