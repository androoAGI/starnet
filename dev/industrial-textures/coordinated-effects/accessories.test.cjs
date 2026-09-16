'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const factory=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'accessories.js.inc'),'utf8'));
const recipe=JSON.parse(fs.readFileSync(path.join(__dirname,'../../../docs/station-remaster/batch03/crew/accessory-motion-recipes.json'),'utf8'));
function fixture() {
  const calls=[],stack=[];
  const ctx={globalAlpha:.7,strokeStyle:'initial',lineWidth:.1,
    save(){stack.push([this.globalAlpha,this.strokeStyle,this.lineWidth]);calls.push(['save']);},
    restore(){assert.ok(stack.length);[this.globalAlpha,this.strokeStyle,this.lineWidth]=stack.pop();calls.push(['restore']);}
  };
  for(const k of ['translate','scale','beginPath','ellipse','stroke'])ctx[k]=(...args)=>calls.push([k,...args]);
  const H={};
  for(const k of ['path','clip','ellipse','poly','line'])H[k]=(c,...args)=>{
    assert.equal(c,ctx);calls.push([k,...args,c.globalAlpha]);
  };
  return {ctx,calls,stack,effect:factory(H)};
}
function run(id,state={},cfg) {
  const f=fixture();const handled=f.effect.draw(f.ctx,id,state,cfg||recipe.props[id]?.views.s);
  assert.equal(f.stack.length,0,'canvas save/restore balanced');
  assert.equal(f.ctx.globalAlpha,.7,'caller alpha preserved');
  assert.equal(f.ctx.strokeStyle,'initial','caller stroke preserved');
  assert.equal(f.ctx.lineWidth,.1,'caller width preserved');
  return {...f,handled};
}
test('inactive work surfaces emit no overlay; true work produces physical geometry',()=>{
  for(const id of ['research_papers','etsy_threadrack','easel']) {
    const idle=run(id,{work:false,now:1300});assert.equal(idle.handled,true);assert.deepEqual(idle.calls,[]);
    const a=run(id,{work:true,now:200}),b=run(id,{work:true,now:1700});
    assert.ok(a.calls.some(c=>c[0]==='clip'));
    assert.notDeepEqual(a.calls,b.calls,`${id} geometry must move/reveal`);
  }
});
test('still mode freezes deterministic geometry for all four effects',()=>{
  for(const id of ['research_papers','etsy_threadrack','easel','radio']) {
    assert.deepEqual(run(id,{work:true,still:true,now:200}).calls,run(id,{work:true,still:true,now:1700}).calls);
    assert.deepEqual(run(id,{work:true,still:true,now:1700}).calls,run(id,{work:true,now:0}).calls);
  }
});
test('radio advances ambient needle at native 900ms steps without a work flag',()=>{
  const a=run('radio',{now:0}),b=run('radio',{now:900}),c=run('radio',{now:1800});
  assert.notDeepEqual(a.calls,b.calls);assert.notDeepEqual(b.calls,c.calls);
  assert.deepEqual(a.calls,run('radio',{now:2700}).calls);
  const solid=a.calls.find(x=>x[0]==='poly');assert.equal(solid[2],'#352f23','baked needle is covered before ticks/needle draw');
  const clip=a.calls.find(x=>x[0]==='clip')[1];assert.equal(clip[0][1],.416,'cover baked top tip beyond tight legacy polygon');
});
test('paper converts a world pixel using fitted worldPerUnitX',()=>{
  const sheet=w=>run('research_papers',{work:true,now:1200,worldPerUnitX:w}).calls.filter(c=>c[0]==='poly')[1][1];
  const original=.39,a=sheet(20)[0][0]-original,b=sheet(40)[0][0]-original;
  assert.ok(Math.abs(a-2*b)<1e-10,'one world pixel halves its normalized size for double world width');
});
test('easel reveals actual baked art by clipping only the unpainted lower portion',()=>{
  const clips=t=>run('easel',{work:true,now:t}).calls.filter(c=>c[0]==='clip');
  assert.equal(clips(0).length,2);assert.ok(clips(1600)[1][1][0][1]>clips(400)[1][1][0][1]);
  assert.ok(run('easel',{work:true,now:400}).calls.some(c=>c[0]==='ellipse'),'unpainted canvas retains Saturn construction sketch');
});
test('bounds cover all owned regions and unknown IDs do not touch canvas',()=>{
  const f=fixture();assert.equal(f.effect.ids.length,4);
  for(const id of f.effect.ids) {
    const b=f.effect.frameBounds(id);assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=1&&b.y+b.height<=1);
  }
  assert.equal(run('not-owned',{work:true}).handled,false);assert.deepEqual(run('not-owned').calls,[]);
});
