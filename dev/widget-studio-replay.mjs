// Local verification fixture: real MCP transport -> real run loop -> widget.set -> durable reading.
// No external account or paid model. Keep fixture data visibly labelled in the app.
import http from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp } from '../scripts/lib/seed.mjs';
import { messageContentText } from '../scripts/lib/message-content.mjs';

const port = Number(process.env.WIDGET_PROOF_PORT || 9190);
let fixturePort = 0;   // the fixture server's own port, from listen(0) below: port + 1 was a guess at a free neighbour
const MODEL = 'replay/widget-studio-fixture';
let amount = 1240, fail = false, reads = 0, child, providerCalls = 0;
const workspace = process.env.WIDGET_PROOF_WORKSPACE || mkdtempSync(join(tmpdir(), 'starnet-widget-proof-'));
if (process.env.WIDGET_PROOF_WORKSPACE) { if (!existsSync(join(workspace, 'station', 'agent.save.json'))) throw new Error('Missing proof workspace'); }
else materializeSeedWorkspace(join(workspace, 'station'), MODEL);
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type':'application/json' }); res.end(JSON.stringify(body)); };
function turn(body) {
  const all = body.messages || [];
  const origin = all.findLastIndex(m => /(?:Refresh|Update) my saved widget/.test(messageContentText(m.content)));
  if (origin < 0) { console.log('non-widget request',JSON.stringify(all.slice(-1).map(m=>({role:m.role,text:messageContentText(m.content).slice(0,350)})))); return { text: 'Local widget fixture: no background suggestion.' }; }
  const messages = all.slice(origin), tools = (body.tools || []).map(t => t.function?.name).filter(Boolean);
  const named = re => tools.find(n => re.test(n));
  const calls = messages.flatMap(m => m.tool_calls || []), called = re => calls.some(c => re.test(c.function?.name || ''));
  const results = messages.filter(m => m.role === 'tool').map(m => messageContentText(m.content));
  let text = messageContentText(messages[0].content);
  if (!text.includes('Refresh my saved widget')) {
    if (!called(/^widget[_.]get$/)) return { tool: named(/^widget[_.]get$/), args: { id: JSON.parse(text.match(/widget ("[^"]+")/)[1]) } };
    text = results.findLast(t => t.includes('Refresh my saved widget')) || '';
  }
  const id = text.match(/using id=("[^"]+")/), version = text.match(/version=(\d+)/);
  if (!id || !version) return { text: 'Fixture stopped: no current widget definition.' };
  const args = { id: JSON.parse(id[1]), version: Number(version[1]) };
  const proceed = named(/^brief[_.]proceed$/);
  if (proceed && !called(/^brief[_.]proceed$/)) return { tool: proceed, args: { objective: 'Read the labelled local connector fixture and update the saved widget.' } };
  const read = named(/^mcp__widget_demo__revenue_snapshot$/);
  if (!called(/^mcp__widget_demo__revenue_snapshot$/)) {
    if (!read) return { text: 'Fixture stopped: the connector read tool is unavailable.' };
    return { tool: read, args: {} };
  }
  if (!called(/^widget[_.]set$/)) {
    const actual = results.findLast(t => t.includes('WIDGET_FIXTURE_JSON:'));
    if (!actual) args.error = 'Local fixture source unavailable';
    else {
      const data = JSON.parse(actual.match(/WIDGET_FIXTURE_JSON:(\{[^\n]+\})/)[1]);
      args.value = '$' + data.amount; args.sub = 'fixture · this month'; args.sourceUrl = data.sourceUrl;
      if (text.includes('Display: list')) { args.list = data.tasks; delete args.value; }
      if (text.includes('Display: trend')) args.spark = data.series;
      if (text.includes('Display: progress')) { args.progress = data.progress; args.value = data.progress + '%'; }
    }
    return { tool: named(/^widget[_.]set$/), args };
  }
  return { text: 'Local replay verification finished. The widget service holds the reading or its reported source error.' };
}
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) return json(res, { error:'too large' }, 413); }
  let body; try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, {}, 400); }
  if (req.url === '/control') { if ('amount' in body) amount = Number(body.amount); if ('fail' in body) fail = !!body.fail;
    if (body.restart) { child.kill(); await new Promise(r => child.once('exit', r)); boot(); await waitUp('http://127.0.0.1:' + port); }
    return json(res, { amount, fail, reads, providerCalls, workspace, pid: child?.pid }); }
  if (req.url === '/report') return json(res, { fixture: true, amount });
  if (req.url === '/mcp') {
    if (req.method === 'GET') return json(res, {}, 405);
    if (body.id == null) { res.writeHead(202); return res.end(); }
    let result = {};
    if (body.method === 'initialize') result = { protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'Widget proof fixture',version:'1'} };
    if (body.method === 'tools/list') result = { tools:[{ name:'revenue_snapshot', description:'Read the labelled local fixture revenue, tasks and trend.', inputSchema:{type:'object',properties:{}}, annotations:{readOnlyHint:true} }] };
    if (body.method === 'tools/call') { reads++; result = fail ? { isError:true, content:[{type:'text',text:'Local fixture source unavailable'}] }
      : { content:[{type:'text',text:'WIDGET_FIXTURE_JSON:' + JSON.stringify({amount,series:[amount-200,amount-100,amount],progress:62,tasks:['Fixture invoice review · today','Fixture report · tomorrow'],sourceUrl:'http://127.0.0.1:' + fixturePort + '/report'})}] }; }
    return json(res, {jsonrpc:'2.0',id:body.id,result});
  }
  if (req.url?.includes('/models')) return json(res,{data:[{id:MODEL,name:'Local widget fixture',context_length:64000,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']}]});
  if (req.url?.includes('/chat/completions')) {
    const next = turn(body); providerCalls++; console.log('fixture turn',providerCalls,next.tool || 'text');
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const delta = next.tool ? {tool_calls:[{index:0,id:'proof_'+providerCalls,type:'function',function:{name:next.tool,arguments:JSON.stringify(next.args)}}]} : {content:next.text || 'Fixture could not find the required tool.'};
    res.write('data: '+JSON.stringify({choices:[{delta}]})+'\n\n');
    res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:next.tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})+'\n\n');
    return res.end('data: [DONE]\n\n');
  }
  return json(res,{},404);
});
function boot() { child = bootSeededSidecar({port,model:MODEL,key:'local-widget-fixture-not-a-credential',scratchDir:join(workspace,'station'),env:{
  SKYNET_OPENROUTER_BASE:'http://127.0.0.1:'+fixturePort+'/api/v1',STARNET_OPENROUTER_BASE:'http://127.0.0.1:'+fixturePort+'/api/v1',
  STARNET_OPENROUTER_KEY:'local-widget-fixture-not-a-credential',SKYNET_API_TOKEN:'widget-proof-local-token',STARNET_API_TOKEN:'widget-proof-local-token',SKYNET_QUEST_REFRESH:'0',SKYNET_SCOUT:'0'
}}); }
await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
fixturePort = server.address().port;
try { const r = await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(500)}); if (r) throw new Error('Proof app port occupied'); }
catch(e) { if(e.message==='Proof app port occupied') throw e; }
boot();
if (!await waitUp('http://127.0.0.1:'+port)) throw new Error('Proof sidecar did not start');
const connected = await fetch('http://127.0.0.1:'+port+'/api/connectors',{method:'POST',headers:{'Content-Type':'application/json','X-StarNet-Token':'widget-proof-local-token'},body:JSON.stringify({id:'widget_demo',label:'Demo Revenue · test fixture',transport:'http',url:'http://127.0.0.1:'+fixturePort+'/mcp',enabled:true})}).then(r=>r.json());
console.log(JSON.stringify({app:'http://127.0.0.1:'+port,control:'http://127.0.0.1:'+fixturePort+'/control',workspace,pid:child.pid,connected:connected.status?.state}));
function stop(){child?.kill();server.close();}
process.on('SIGINT',stop); process.on('SIGTERM',stop);
