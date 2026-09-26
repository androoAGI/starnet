'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Templates = require('../frontend/app/stationtemplates.js');
const Model = require('../frontend/app/worldmodel.js');
const Sprites = require('../frontend/app/propsprites.js');
const Pipeline = require('../frontend/app/pipeline.js');

test('Creative Studio sample follows its saved draft and review briefs through the real harness', async () => {
  const calls = [];
  const draft = 'Grow Together! Join our community garden and help it flourish. Bring your curiosity and share your ideas. Everyone is welcome to take part.';
  const result = 'Grow Together! Help our community garden flourish. Share your ideas and learn alongside your neighbors. Everyone is welcome to take part.';
  const provider = http.createServer((req,res) => {
    let raw=''; req.on('data',d=>{raw+=d;}); req.on('end',()=>{
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({data:[{id:'drafter-fixture'},{id:'reviewer-fixture'}]})); return;
      }
      const body=JSON.parse(raw); calls.push(body);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:body.model==='reviewer-fixture'?result:draft},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const fixture=SidecarFixture.create({prefix:'creative-example-',timeoutMs:30000,env:{
    SKYNET_OPENROUTER_KEY:'',STARNET_OPENROUTER_KEY:'',SKYNET_DEFAULT_MODEL:'',STARNET_DEFAULT_MODEL:'',
    CUSTOM_OPENAI_BASE_URL:'http://127.0.0.1:'+provider.address().port+'/v1',CUSTOM_OPENAI_KEY:'local-example-fixture'
  }});
  try {
    await fixture.start();
    const agents=['drafter','reviewer'].map(id=>({agentId:id,name:id,system:'Complete the sample task directly.',provider:'custom',model:id+'-fixture'}));
    assert.equal((await fixture.json('POST','/api/roster',{agents,updatedAt:Date.now()})).status,200);
    const station=Model.create(Templates.build('creative',Model,Sprites));
    // Recruitment gives real agents a workstation through this same model seam.
    for (const agent of agents) assert.equal(station.ensureWorkstation(agent.agentId).ok,true);
    const before=Templates.example(station.serialize(),Model,Pipeline);
    before.roles.forEach((role,i)=>station.assignPropAgent(role.propId,agents[i].agentId));
    const guide=Templates.example(station.serialize(),Model,Pipeline);
    assert.equal(guide.ready,true);
    const plan=Pipeline.compileRoutingPlan(station.projectGeometry());
    // Mirror World.compileRouting: tools come from real furniture, never fixture grants.
    for (const bay of [...plan.bays,...plan.dockBays]) bay.objects=station.bayObjects(bay.agentId);
    assert.deepEqual(plan.errors,[]);
    assert.equal((await fixture.json('POST','/api/routing',plan)).body.ok,true);
    const response=await fixture.json('POST','/api/routing/sample',{line:guide.key,text:guide.sample});
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.ok,true);
    assert.equal(response.body.delivered.agentId,'reviewer');
    assert.equal(response.body.runs.length,2);
    assert.deepEqual(new Set(response.body.runs.map(r=>r.agentId)),new Set(['drafter','reviewer']));
    assert.equal(response.body.replies.at(-1),result);
    const entry=calls.find(c=>c.model==='drafter-fixture' && JSON.stringify(c.messages).includes('community garden'));
    const hop=calls.find(c=>c.model==='reviewer-fixture' && JSON.stringify(c.messages).includes(draft));
    assert.ok(entry,'the sample brief reaches the configured drafter');
    assert.match(JSON.stringify(entry.messages),/Draft a response/,'the saved drafting instruction is used');
    assert.ok(hop,'the reviewer receives the actual drafted text');
    assert.match(JSON.stringify(hop.messages),/Review the incoming draft/,'the saved review instruction is used');
  } finally {
    await fixture.stop();
    await new Promise(resolve=>provider.close(resolve));
  }
});

test('Software Team sample follows its saved build and test briefs through the real harness', async () => {
  const calls = [];
  const draft = 'function slugify(title) { return title.toLowerCase().trim().replace(/[^a-z0-9 ]/g, "").split(/ +/).join("-"); }';
  const result = 'Checked all three examples; they pass. Final slugify function attached.';
  const provider = http.createServer((req,res) => {
    let raw=''; req.on('data',d=>{raw+=d;}); req.on('end',()=>{
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({data:[{id:'builder-fixture'},{id:'tester-fixture'}]})); return;
      }
      const body=JSON.parse(raw); calls.push(body);
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:body.model==='tester-fixture'?result:draft},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const fixture=SidecarFixture.create({prefix:'software-example-',timeoutMs:30000,env:{
    SKYNET_OPENROUTER_KEY:'',STARNET_OPENROUTER_KEY:'',SKYNET_DEFAULT_MODEL:'',STARNET_DEFAULT_MODEL:'',
    CUSTOM_OPENAI_BASE_URL:'http://127.0.0.1:'+provider.address().port+'/v1',CUSTOM_OPENAI_KEY:'local-example-fixture'
  }});
  try {
    await fixture.start();
    const agents=['builder','tester'].map(id=>({agentId:id,name:id,system:'Complete the sample task directly.',provider:'custom',model:id+'-fixture'}));
    assert.equal((await fixture.json('POST','/api/roster',{agents,updatedAt:Date.now()})).status,200);
    const station=Model.create(Templates.build('software',Model,Sprites));
    // Recruitment gives real agents a workstation through this same model seam.
    for (const agent of agents) assert.equal(station.ensureWorkstation(agent.agentId).ok,true);
    const before=Templates.example(station.serialize(),Model,Pipeline);
    before.roles.forEach((role,i)=>station.assignPropAgent(role.propId,agents[i].agentId));
    const guide=Templates.example(station.serialize(),Model,Pipeline);
    assert.equal(guide.ready,true);
    const plan=Pipeline.compileRoutingPlan(station.projectGeometry());
    // Mirror World.compileRouting: tools come from real furniture, never fixture grants.
    for (const bay of [...plan.bays,...plan.dockBays]) bay.objects=station.bayObjects(bay.agentId);
    assert.deepEqual(plan.errors,[]);
    assert.equal((await fixture.json('POST','/api/routing',plan)).body.ok,true);
    const response=await fixture.json('POST','/api/routing/sample',{line:guide.key,text:guide.sample});
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.ok,true);
    assert.equal(response.body.delivered.agentId,'tester');
    assert.equal(response.body.runs.length,2);
    assert.deepEqual(new Set(response.body.runs.map(r=>r.agentId)),new Set(['builder','tester']));
    assert.equal(response.body.replies.at(-1),result);
    const entry=calls.find(c=>c.model==='builder-fixture' && JSON.stringify(c.messages).includes('slugify'));
    const hop=calls.find(c=>c.model==='tester-fixture' && JSON.stringify(c.messages).includes('slugify(title)'));
    assert.ok(entry,'the sample request reaches the configured builder');
    assert.match(JSON.stringify(entry.messages),/Build what the incoming request asks for/,'the saved build instruction is used');
    assert.ok(hop,'the tester receives the actual built change');
    assert.match(JSON.stringify(hop.messages),/Test the incoming change/,'the saved test instruction is used');
  } finally {
    await fixture.stop();
    await new Promise(resolve=>provider.close(resolve));
  }
});
