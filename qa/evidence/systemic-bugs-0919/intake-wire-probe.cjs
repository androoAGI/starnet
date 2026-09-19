'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {selectProvider}=require(path.join(process.cwd(),'sidecar/providers/factory.js'));
const {makeMcpToolDef}=require(path.join(process.cwd(),'sidecar/mcp/translate.js'));
(async()=>{
 const wires=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;if(!raw){res.end(JSON.stringify({data:[]}));return;}wires.push(JSON.parse(raw));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:'fs_write',arguments:'{"path":"fixture.txt","text":"probe"}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const baseUrl='http://127.0.0.1:'+server.address().port+'/v1';for(const model of ['llama3.1:8b','qwen3:8b','gpt-oss:20b']){const p=selectProvider({provider:'ollama',fetch,baseUrl});const tools=[{type:'function',function:{name:'fs_write',parameters:{type:'object',properties:{path:{type:'string'},text:{type:'string'}},required:['path','text']}}}];const events=[];for await(const e of p.stream({model,messages:[{role:'user',content:'Create fixture.txt'}],tools}))events.push(e);assert.deepEqual(wires.at(-1).tools,tools);assert.equal(wires.at(-1).tool_choice,'auto');assert.equal(events.find(e=>e.type==='tool_start').name,'fs_write');assert.equal(events.find(e=>e.type==='done').finishReason,'tool_calls');}
 for(const required of [undefined,[],['account']]){const schema={type:'object',properties:{account:{type:'string'}}};if(required)schema.required=required;const before=JSON.stringify(schema);const def=makeMcpToolDef({connectorId:'fixture-zoho',mcpTool:{name:'getMailAccounts',inputSchema:schema},call:async()=>({content:[]})});assert.deepEqual(def.schema,schema);assert.equal(JSON.stringify(schema),before);}
 console.log(JSON.stringify({status:'PASS',ollamaProfileModels:3,checks:18,scope:'Native loopback HTTP, production provider factory, tools payload and structured response parsing; MCP required-field preservation. Controlled server only, not actual Ollama models or Zoho account.'},null,2));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
