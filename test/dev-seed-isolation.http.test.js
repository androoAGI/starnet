'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const entry = path.resolve(__dirname, '../dev/seed.js');

function fixture() {
  const f = SidecarFixture.create({prefix:'seed-isolation-',entry,timeoutMs:30000,
    env:{SKYNET_DEFAULT_MODEL:'test/model',SKYNET_OPENROUTER_KEY:'seed-fixture'}});
  f.args = ['--keep','--workspace',f.workspace];
  const stop = f.stop.bind(f);
  f.stop = async () => {
    if (process.platform === 'win32' && f.child) spawnSync('taskkill', ['/PID',String(f.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    await stop();
  };
  return f;
}

(async () => {
  for (const args of [['--workspace'],['--workspace','--keep'],['--workspace','unused']]) {
    const result = spawnSync(process.execPath,[entry,...args],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);
    assert.match(result.stderr,/--workspace requires/);
  }
  const a=fixture(), b=fixture();
  try {
    // Concurrent campaigns must neither contend for a lease nor share durable data.
    await Promise.all([a.start(), b.start()]);
    assert.notEqual(a.workspace,b.workspace);
    for (const f of [a,b]) assert.ok(fs.existsSync(path.join(f.workspace,'agent.save.json')));
    const before = await a.json('GET','/api/save?agent=agent');
    const doc = {...before.body.save,updatedAt:Date.now()+1000};
    doc.agent = {...doc.agent,name:'ISOLATED A'};
    assert.equal((await a.json('POST','/api/save',doc)).body.ok,true);
    assert.notEqual((await b.json('GET','/api/save?agent=agent')).body.save.agent.name,'ISOLATED A');
    await a.stop(); await a.start();
    assert.equal((await a.json('GET','/api/save?agent=agent')).body.save.agent.name,'ISOLATED A');
    assert.notEqual((await b.json('GET','/api/save?agent=agent')).body.save.agent.name,'ISOLATED A');
    console.log('dev-seed isolation: invalid arguments, concurrent workspaces, independent saves and retained restart PASS');
  } finally { await Promise.all([a.dispose(),b.dispose()]); }
})().catch(error => { console.error(error); process.exitCode=1; });
