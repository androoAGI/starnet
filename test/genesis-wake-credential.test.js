'use strict';
const fs=require('fs'),A=require('./_assert');
const src=fs.readFileSync(require.resolve('../frontend/app/app.js'),'utf8');
const fn=A.fnBody(src,'async function onWakeAttempt(');
async function attempt({stored=false,connected=true,typed='',provider='openai'}={}){
 const elements={};for(const id of ['in-name','connect-msg','in-base-url','in-model','in-key'])elements[id]={value:id==='in-model'?'gpt-5.5':id==='in-key'?typed:'',textContent:'',innerHTML:''};
 const seen={calls:0,provider:null,storedWrites:0};
 const Harness={configured:()=>true,hasStoredCredential:()=>stored,setModel:m=>{seen.model=m},setProv:p=>{seen.provider=p},validateAndSetKey:async()=>{seen.storedWrites++}};
 const run=Function('Harness','elements','seen','connected','provider',`const el=id=>elements[id],SFX={boot(){},open(){}},stopCodexPoll=()=>{},stopStarnetLinkPoll=()=>{},stopStarnetBalancePoll=()=>{},stopAllOAuthPolls=()=>{},providerNeedsBaseUrl=()=>false,isOAuthProviderId=()=>false,providerNeedsKey=()=>true,providerSignupUrl=()=> 'https://example.invalid',providerLabel=()=> 'OpenAI',esc=x=>x,wakeBtnBusy=()=>{};let pickedProvider=provider,codexConnected=connected,prefilledKey='',keyOverwriteConfirmed=false;const preflightWire=async()=>{seen.calls++;return{ok:false,why:'test transport sentinel'}};${fn}\nreturn onWakeAttempt();`);
 await run(Harness,elements,seen,connected,provider);return{...seen,message:elements['connect-msg'].innerHTML||elements['connect-msg'].textContent};
}
(async()=>{
 let r=await attempt();A.eq(r.provider,'codex','DEV configured=true cannot override a real ChatGPT sign-in');A.eq(r.calls,1,'selected ChatGPT path reaches preflight');A.eq(r.model,'gpt-5.5','selected model is preserved');
 r=await attempt({stored:true});A.eq(r.provider,'openai','a real saved API key keeps the API route');
 r=await attempt({typed:'test-only-placeholder'});A.eq(r.provider,'openai','an explicitly typed key wins');A.eq(r.storedWrites,1,'typed key uses validation path');
 r=await attempt({connected:false});A.eq(r.calls,0,'no actual credential stops before a doomed request');A.ok(r.message.includes('sign in with ChatGPT'),'missing credential gives actionable setup guidance');
 r=await attempt({provider:'openrouter',stored:true});A.eq(r.provider,'openrouter','server-held key from the actual DEV provider remains valid');
 A.report('genesis-wake-credential');
})().catch(e=>{console.error(e);process.exitCode=1});
