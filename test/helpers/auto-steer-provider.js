// Deterministic local provider for automatic-steering HTTP and live-browser acceptance.
'use strict';
const http = require('node:http');
async function startProvider() {
  const requests = [];
  let release, held;
  const waiting = new Promise(r => { held = r; });
  const wait = new Promise(r => { release = r; });
  const server = http.createServer((req,res) => {
    if (req.url.includes('/models')) { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({data:[{id:'test/auto-steer',context_length:200000,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']}]})); }
    if (!req.url.includes('/chat/completions')) {res.writeHead(404);return res.end();}
    let raw='';req.on('data',d=>raw+=d);req.on('end',async()=>{
      try {
        const body=JSON.parse(raw), ms=body.messages||[];
        const text=m=>typeof m.content==='string'?m.content:JSON.stringify(m.content);
        const main=ms.some(m=>m.role==='user'&&text(m).includes('AUTO_STEER_REPORT')) && Array.isArray(body.tools) && body.tools.length;
        if(main) requests.push(body);
        const result=id=>ms.some(m=>m.role==='tool'&&m.tool_call_id===id);
        const saidStatus=ms.some(m=>m.role==='assistant'&&text(m).includes('The outline is saved.'));
        const gotStatus=ms.some(m=>m.role==='user'&&text(m).includes("How's it going?"));
        let tool=null, output='Fixture ready.';
        if(main) {
          if(!result('brief_auto')) tool={id:'brief_auto',name:'brief_proceed',args:{objective:'Write AUTO_STEER_REPORT as a file and keep working through status questions.',deliverable:'auto-steer-report.md',assumptions:['write in the current workspace']}};
          else if(!result('outline_auto')) { held(); await wait; tool={id:'outline_auto',name:'fs_write',args:{path:'auto-steer-outline.md',content:'Outline saved.'}}; }
          else if(gotStatus&&!saidStatus) output='The outline is saved. I am continuing the report.';
          else if(!result('report_auto')) tool={id:'report_auto',name:'fs_write',args:{path:'auto-steer-report.md',content:'AUTO_STEER_REPORT completed after the progress answer.\n'+(ms.some(m=>m.role==='user'&&text(m).includes('reference evidence'))?'Reference evidence incorporated.':'')}};
          else output='Completed the original report: [Open report](auto-steer-report.md).';
        }
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
        const delta=tool?{tool_calls:[{index:0,id:tool.id,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{content:output};
        res.write('data: '+JSON.stringify({choices:[{delta}]})+'\n\n');
        res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\n');
        res.end('data: [DONE]\n\n');
      } catch(e){res.writeHead(500);res.end(String(e));}
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {requests,waiting,release,base:'http://127.0.0.1:'+server.address().port+'/api/v1',close:()=>{release();server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
function environment(provider) {return {SKYNET_OPENROUTER_BASE:provider.base,STARNET_OPENROUTER_BASE:provider.base,
 SKYNET_OPENROUTER_KEY:'sk-or-v1-auto-steer-fixture',STARNET_OPENROUTER_KEY:'sk-or-v1-auto-steer-fixture',
 SKYNET_DEFAULT_MODEL:'test/auto-steer',STARNET_DEFAULT_MODEL:'test/auto-steer',SKYNET_FULL_ACCESS:'1',STARNET_FULL_ACCESS:'1',
 SKYNET_AUX_BUDGET:'0',STARNET_AUX_BUDGET:'0',SKYNET_EDGE_TTS_PROBE:'0'};}
module.exports={startProvider,environment};
