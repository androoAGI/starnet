const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {makeWorkspaceOwner}=require('../../../sidecar/workspace-owner');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-owner-race-'));
const file=path.join(root,'.starnet-workspace-owner.json');
fs.writeFileSync(file,JSON.stringify({version:1,pid:101,nonce:'dead',startedAt:1}));
const deps={fs,path,now:()=>100,pidAlive:pid=>pid!==101};
const a=makeWorkspaceOwner({...deps,pid:201,nonce:()=> 'a'});let first;
const proxy=Object.create(fs);let triggered=false;
proxy.readFileSync=(name,...args)=>{const raw=fs.readFileSync(name,...args);if(name===file&&!triggered){triggered=true;first=a.acquire(root);}return raw;};
const b=makeWorkspaceOwner({...deps,fs:proxy,pid:202,nonce:()=> 'b'});
try{const second=b.acquire(root);assert.equal(first.ok,true);assert.equal(second.ok,true);console.log(JSON.stringify({reproduced:true,first:first.holder,second:second.holder,onDisk:JSON.parse(fs.readFileSync(file))},null,2));}finally{a.release();b.release();fs.rmSync(root,{recursive:true,force:true});}
