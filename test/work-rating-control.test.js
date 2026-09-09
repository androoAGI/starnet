'use strict';
const A=require('./_assert.js');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../frontend/app/chat.js'),'utf8');
function node(){return {children:[],disabled:false,setAttribute(){},appendChild(c){this.children.push(c);c.parent=this;},querySelectorAll(){return this.children;},remove(){this.parent.children=this.parent.children.filter(c=>c!==this);}};}
(async()=>{
 const notices=[],host=node();let calls=0,settled=0;
 const context={document:{createElement:node},localStorage:{getItem:()=> '1'},name:'NOVA',WORKRATE_COACH_KEY:'rating-test',setTimeout:()=>0,
   runMeta:()=>null,runWork:new Map(),StationUI:{notify:(message)=>notices.push(message)},
   rateWork:async()=>++calls===1?{ok:false,error:'Station changed — reload the app before rating this work.'}:{ok:true,applied:true},verdictFollowupBeat:()=>{},recommendPass:()=>{}};
 vm.createContext(context);vm.runInContext(A.fnBody(source,'function workRateControl('),context);
 context.workRateControl(host,'agent','same-run',()=>settled++);
 const buttons=host.children.find(n=>n.className==='consent-btns').children;
 await buttons[0].onclick();
 A.eq(notices[0],'Station changed — reload the app before rating this work.','the real control displays the reason instead of replacing it with a generic toast');
 A.ok(buttons.every(b=>!b.disabled),'failed ratings keep all three verdict buttons enabled for retry');
 A.eq(settled,0,'a rejection does not settle or collect the work');
 await buttons[0].onclick();
 A.eq(calls,2,'the same control retries the same run');
 A.ok(host.children.some(n=>n.textContent==='★ +XP'),'acknowledged retry displays success');
 A.report('work-rating-control.test');
})().catch(e=>{console.error(e);process.exit(1);});
