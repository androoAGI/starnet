'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {SidecarFixture}=require('./helpers/sidecar-fixture.js');
const fixture=SidecarFixture.create({entry:path.join(__dirname,'helpers/save-read-fault-host.cjs')});
(async()=>{
 try {
  await fixture.start();
  const body={id:'retained',label:'Retained',request:'A retained reading',display:'metric',source:{kind:'agent',id:'starnet'}};
  const created=await fixture.json('POST','/api/widgets/configure',body);
  assert.equal(created.status,200,JSON.stringify(created.body));
  const file=path.join(fixture.workspace,'station.widgets.json'),control=path.join(fixture.workspace,'save-read-fault.json');
  const original=fs.readFileSync(file,'utf8');
  for(const mode of ['primary','missing','empty','torn']){
   fs.writeFileSync(file,original);fs.writeFileSync(file+'.bak',original);
   if(mode==='missing')fs.unlinkSync(file);
   if(mode==='empty')fs.writeFileSync(file,'');
   if(mode==='torn')fs.writeFileSync(file,'{torn');
   const target=mode==='primary'?'station.widgets.json':'station.widgets.json.bak';
   fs.writeFileSync(control,JSON.stringify({file:target}));
   await fixture.json('GET','/api/widgets');
   const write=await fixture.json('POST','/api/widgets/configure',{...body,id:'must-not-replace'});
   assert.notEqual(write.status,200,'unreadable state must refuse replacement: '+mode);
   assert.equal(fs.readFileSync(path.join(fixture.workspace,target),'utf8'),original,'fault must not quarantine or replace '+mode);
   fs.unlinkSync(control);await fixture.restart();
   const list=await fixture.json('GET','/api/widgets');
   assert.equal(list.status,200);
   assert.equal(list.body.widgets.some(w=>w.id==='retained'),true,'restart retains '+mode);
   assert.equal(list.body.widgets.some(w=>w.id==='must-not-replace'),false);
  }
  console.log('durable-store HTTP: primary/backup read faults, write refusal, no quarantine, four restarts PASS');
 } finally {await fixture.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
