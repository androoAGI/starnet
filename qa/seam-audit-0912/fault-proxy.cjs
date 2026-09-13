'use strict';
// Local fault-injection server. Serves the unchanged seeded app and controls ONLY loop responses.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const S=require('../../sidecar/loopjob-store.js');
const LJ=require('../../sidecar/loopjob.js');
const now=Date.now();
let loops=S.createLoop([],{id:'audit-loop',name:'Audit review draft',objective:'Review this synthetic audit result',gate:'each'},{now});
loops=S.startIteration(loops,'audit-loop',{now,runId:'audit-loop-run'});
loops=S.settleIteration(loops,'audit-loop',{runId:'audit-loop-run',status:'ok',text:'Audit candidate produced',title:'Synthetic review candidate',summary:'A controlled review fixture'},{now:now+100});
const counts={reads:0,controls:[]};
http.createServer(async(req,res)=>{
 if(req.url==='/api/loops'&&req.method==='GET'){
  counts.reads++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({armed:true,halted:false,inFlight:0,loops:loops.map(l=>LJ.summarize(l,{now:Date.now()}))}));return;
 }
 if(req.url==='/api/loops/control'){
  let body='';for await(const b of req)body+=b;
  counts.controls.push(JSON.parse(body));fs.writeFileSync(path.join(__dirname,'proxy-results.json'),JSON.stringify(counts,null,2));
  res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Review in progress; retry when it finishes'}));return;
 }
 const headers={...req.headers,host:'127.0.0.1:19427'};if(headers.origin)headers.origin='http://127.0.0.1:19427';
 const upstream=http.request({hostname:'127.0.0.1',port:19427,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
 upstream.on('error',e=>{if(res.destroyed)return;if(res.headersSent){res.destroy();return;}res.writeHead(502);res.end(e.message);});req.pipe(upstream);res.on('close',()=>upstream.destroy());
}).listen(19428,'127.0.0.1',()=>console.log('Audit fault proxy on 19428; unchanged app on 19427; loop fixture and 409 control errors only.'));
