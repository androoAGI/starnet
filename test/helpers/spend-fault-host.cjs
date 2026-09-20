'use strict';
const fs=require('node:fs'),path=require('node:path');
const originalOpen=fs.openSync.bind(fs),originalRead=fs.readFileSync.bind(fs);
const root=process.env.SKYNET_WORKSPACES,ledger=path.join(root,'ledger.jsonl');
const control=path.join(root,'spend-fault.json');
function fault(file,flags) {
  let mode;try{mode=JSON.parse(originalRead(control,'utf8')).mode;}catch{}
  if(path.resolve(String(file))!==ledger)return;
  const read=String(flags)==='r';
  if((mode==='read'&&read)||(mode==='write'&&String(flags)==='a+'))throw Object.assign(new Error('injected spend '+mode+' failure'),{code:read?'EACCES':'ENOSPC'});
}
fs.openSync=function(file,flags,...args){fault(file,flags);return originalOpen(file,flags,...args);};
fs.readFileSync=function(file,...args){fault(file,'r');return originalRead(file,...args);};
require(process.env.STARNET_SPEND_INSTALLED_ENTRY || '../../sidecar/index.js');
