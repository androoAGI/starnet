'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Templates = require('../frontend/app/stationtemplates.js');
const Model = require('../frontend/app/worldmodel.js');
const Sprites = require('../frontend/app/propsprites.js');
const Pipeline = require('../frontend/app/pipeline.js');
const WorkflowLine = require('../frontend/app/workflowline.js');
const { canonical, publishFloor } = require('./helpers/saved-floor.js');

/* one mock OpenAI-compatible provider: `answer(model, body, nth)` writes each reply (nth = that model's call count) */
async function withPreset(presetId, agentIds, answer, fn) {
  const calls = [], count = {};
  const provider = http.createServer((req,res) => {
    let raw=''; req.on('data',d=>{raw+=d;}); req.on('end',()=>{
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({data:agentIds.map(id=>({id:id+'-fixture'}))})); return;
      }
      const body=JSON.parse(raw); calls.push(body);
      const nth=count[body.model]=(count[body.model]||0)+1;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:answer(body.model,body,nth)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:30}})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const fixture=SidecarFixture.create({prefix:presetId+'-example-',timeoutMs:30000,env:{
    SKYNET_OPENROUTER_KEY:'',STARNET_OPENROUTER_KEY:'',SKYNET_DEFAULT_MODEL:'',STARNET_DEFAULT_MODEL:'',
    CUSTOM_OPENAI_BASE_URL:'http://127.0.0.1:'+provider.address().port+'/v1',CUSTOM_OPENAI_KEY:'local-example-fixture'
  }});
  try {
    await fixture.start();
    const agents=agentIds.map(id=>({agentId:id,name:id,system:'Complete the sample task directly.',provider:'custom',model:id+'-fixture'}));
    assert.equal((await fixture.json('POST','/api/roster',{agents,updatedAt:Date.now()})).status,200);
    const station=Model.create(Templates.build(presetId,Model,Sprites));
    // Recruitment gives real agents a workstation through this same model seam.
    for (const agent of agents) assert.equal(station.ensureWorkstation(agent.agentId).ok,true);
    const before=Templates.example(station.serialize(),Model,Pipeline,WorkflowLine);
    assert.equal(before.ready,false,'nobody works the preset yet');
    before.roles.forEach((role,i)=>station.assignPropAgent(role.propId,agents[i].agentId));
    const guide=Templates.example(station.serialize(),Model,Pipeline,WorkflowLine);
    assert.equal(guide.ready,true,guide.issue);
    // The preset is SAVED as the page would save it and its hint published: tools come from the real furniture the save holds, never fixture grants.
    const published=await publishFloor(fixture,canonical(station.serialize()),{label:'the '+presetId+' preset'});
    assert.deepEqual(published.plan.errors,[]);
    const response=await fixture.json('POST','/api/routing/sample',{line:guide.key,text:guide.sample});
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.ok,true,JSON.stringify(response.body));
    await fn({response,calls,guide});
  } finally {
    await fixture.stop();
    await new Promise(resolve=>provider.close(resolve));
  }
}

test('Creative Studio sample follows its saved draft and review briefs through the real harness', async () => {
  const draft = 'Grow Together! Join our community garden and help it flourish. Bring your curiosity and share your ideas. Everyone is welcome to take part.';
  const result = 'Grow Together! Help our community garden flourish. Share your ideas and learn alongside your neighbors. Everyone is welcome to take part.';
  await withPreset('creative',['drafter','reviewer'],model=>model==='reviewer-fixture'?result+'\nVERDICT: approved':draft,async ({response,calls}) => {
    assert.equal(response.body.delivered.agentId,'reviewer');
    // the sample lists its runs newest first
    assert.deepEqual(response.body.runs.map(r=>r.agentId).reverse(),['drafter','reviewer'],'an approved draft ships after one review');
    assert.match(response.body.replies.at(-1),/^Grow Together! Help our community garden flourish/);
    const entry=calls.find(c=>c.model==='drafter-fixture' && JSON.stringify(c.messages).includes('community garden'));
    const hop=calls.find(c=>c.model==='reviewer-fixture' && JSON.stringify(c.messages).includes(draft));
    assert.ok(entry,'the sample brief reaches the configured drafter');
    assert.match(JSON.stringify(entry.messages),/Draft a response/,'the saved drafting instruction is used');
    assert.ok(hop,'the reviewer receives the actual drafted text');
    assert.match(JSON.stringify(hop.messages),/Review the incoming draft/,'the saved review instruction is used');
  });
});

test('Software Studio sample goes back to the Builder when the Tester finds a failure, then ships on a pass', async () => {
  const v1 = 'function slugify(t){ return t.toLowerCase().trim().replace(/ /g,"-"); }';
  const v2 = 'function slugify(t){ return t.toLowerCase().trim().replace(/[^a-z0-9 ]/g,"").split(/ +/).join("-"); }';
  const failure = 'Example 2 fails: "Hello  World" gives "hello--world", expected "hello-world".';
  const pass = 'All three examples pass.\n\n' + v2;
  // answers follow the work, not the call count: the harness also runs after-run memory reads on each agent
  const answer = (model,body) => { const last=body.messages.at(-1); const m=last&&last.role==='user'?userWords(last):JSON.stringify(last);   // this turn's work only, not the agent's history
    return model==='builder-fixture' ? (m.includes('Example 2 fails')?v2:v1) : (m.includes('replace(/ /g')?failure+'\nVERDICT: revise':pass+'\nVERDICT: pass'); };
  await withPreset('software',['builder','tester'],answer,async ({response,calls}) => {
    // the sample lists its runs newest first
    assert.deepEqual(response.body.runs.map(r=>r.agentId).reverse(),['builder','tester','builder','tester'],'a failed check goes back to the builder once, then ships');
    assert.equal(response.body.delivered.agentId,'tester');
    assert.match(response.body.replies.at(-1),/^All three examples pass\./);
    const entry=calls.find(c=>c.model==='builder-fixture' && JSON.stringify(c.messages).includes('slugify(title)'));
    assert.ok(entry,'the sample job reaches the builder');
    assert.match(JSON.stringify(entry.messages),/Build what the incoming request asks for/,'the builder uses the saved Build instructions');
    const test1=calls.find(c=>c.model==='tester-fixture' && JSON.stringify(c.messages).includes(v1.slice(0,30)));
    assert.ok(test1,'the tester receives the builder\'s actual change');
    assert.match(JSON.stringify(test1.messages),/Test the incoming change against the original request/,'the tester uses the saved Test instructions');
    const retry=calls.filter(c=>c.model==='builder-fixture' && JSON.stringify(c.messages).includes('PIPELINE HANDOFF'))[0];
    assert.ok(retry && JSON.stringify(retry.messages).includes('Example 2 fails'),'the builder\'s second pass carries the tester\'s failure report');
  });
});
