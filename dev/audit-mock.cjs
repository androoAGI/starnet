const http=require('node:http'),fs=require('node:fs');
let mode='quick', seq=0, requests=[];const held=new Set();
function finish(res,content){if(res.destroyed)return;res.write('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})+'\n\n');res.end('data: [DONE]\n\n');}
const s=http.createServer((req,res)=>{
 if(req.url==='/control'){let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{const b=JSON.parse(raw||'{}');mode=b.mode||mode;if(b.release)for(const r of held){finish(r,'Audit completed.');held.delete(r)}res.setHeader('content-type','application/json');res.end(JSON.stringify({mode,requests:requests.length,held:held.size}));});return;}
 if(req.url==='/requests'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(requests));}
 if(req.url.includes('/models')){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'anthropic/claude-haiku-4.5',context_length:200000,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']}]}));}
 let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{let b;try{b=JSON.parse(raw)}catch{res.writeHead(400);return res.end()};requests.push(b);res.writeHead(200,{'content-type':'text/event-stream'});if(mode==='error'){res.end('data: '+JSON.stringify({error:{message:'Audit injected failure'}})+'\n\n');return;}
 res.write('data: '+JSON.stringify({choices:[{delta:{content:'Audit reply '+(++seq)+'. '}}]})+'\n\n');
 if(mode==='hold'){held.add(res);res.on('close',()=>held.delete(res));}else setTimeout(()=>finish(res,'Completed the audit reply.'),150);
 });
});s.listen(9237,'127.0.0.1',()=>console.log('Audit mock provider listening 9237'));
