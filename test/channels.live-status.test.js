'use strict';
// The resolver is the command/read boundary: stale roster metadata cannot override the
// pair a message actually executes, and a bound bot has no roster command surface at all.
const fs=require('fs'), os=require('os'), path=require('path');
const A=require('./_assert.js');
const Factory=require('../sidecar/channels/factory.js');
const History=require('./helpers/channel-history.js');
const {makeChannelStore}=require('../sidecar/channels/store.js');
let Hub=require('../sidecar/channels/hub.js');
if(process.env.CHANNEL_STATUS_CONTROL) {
  const Module=require('module'), filename=require.resolve('../sidecar/channels/hub.js');
  const old=new Module(filename,module); old.filename=filename; old.paths=Module._nodeModulePaths(path.dirname(filename));
  old._compile(fs.readFileSync(process.env.CHANNEL_STATUS_CONTROL,'utf8'),filename); Hub=old.exports;
}
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-channel-status-')), hubs=[];
  try {
    for(const kind of ['telegram','telegram-bot']) {
      const sends=[], runs=[]; let model='live-model', unavailable=false, n=0;
      const store=makeChannelStore({fs,pathMod:path,root:path.join(root,kind),clock:{now:()=>1}});
      const cfg=()=>unavailable ? {ok:false,error:'Reconnect the target provider'} : {ok:true,configured:true,key:'fixture',provider:'custom',model,system:'LIVE-SYSTEM',agentId:'writer'};
      const options={channel:kind,store,secrets:()=>({key:'fixture',provider:'custom',model:'connect-model',agentId:'writer'}),
        resolveEntryRunConfig:cfg,resolveRunConfig:cfg,isOwner:()=>true,newId:()=>kind+'-'+(++n),now:()=>1,
        send:async(_chat,text)=>{sends.push(text);return {ok:true};},
        runOnce:async o=>{runs.push(o);const end={agentId:o.agentId,runId:o.runId,reason:'done',outcome:'succeeded',turns:1,usd:0};o.emit('agent.run.end',end);return {...end,text:'Done'};}
      };
      if(kind === 'telegram') Object.assign(options,{roster:()=>[{agentId:'writer',name:'Writer',model:'stale-roster-model'}],
        setModel:(_id,value)=>{model=value;return {ok:true,model:value};}});
      const hub=Hub.makeChannelHub(Factory.makeHubDeps(kind,{history:History.make(store).history},options)); hubs.push(hub);
      const send=text=>hub.onInbound({channel:kind,chatId:'42',chatType:'dm',userId:'owner',text,messageId:'m'+(++n),ts:1});
      await send('/status');
      A.ok(sends.at(-1).includes('(live-model)')&&!sends.at(-1).includes('stale-roster-model'),kind+': status names the live resolver model, including the bound bot without a roster surface');
      if(kind === 'telegram') {
        await send('/model'); A.ok(sends.at(-1).includes('current model: live-model'), 'model query uses the live target pair');
        await send('/model next-model'); A.ok(sends.at(-1).includes('model is now next-model'),'model write acknowledges the next resolved pair');
        await send('/status'); A.ok(sends.at(-1).includes('(next-model)'),'status observes model change immediately');
        await send('Do the task'); A.eq(runs.at(-1)?.model,'next-model','the next real hub run matches status and model acknowledgement');
      }
      const paidBefore=runs.length;
      unavailable=true;
      await send('/status');
      A.ok(sends.at(-1).includes('Not ready: Reconnect the target provider')&&!sends.at(-1).includes('(live-model)'),kind+': failed live resolution is not presented as ready');
      A.eq(runs.length,paidBefore,kind+': command readouts make no provider call');
      hub.close();
    }
  } finally { for(const h of hubs)h.close();fs.rmSync(root,{recursive:true,force:true}); }
  A.report('channels.live-status.test');
})().catch(error=>{console.error(error);process.exitCode=1;});
