'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDurableJsonStore, writeJsonResilient, readJsonResilient } = require('../sidecar/durable-store.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-durable-faults-'));
let checks = 0, failures = 0;
function check(fn) { checks++; try { fn(); } catch(e) { failures++; console.error(e.message); } }
(async () => {
  try {
    for (const code of ['EACCES','EBUSY','EPERM','EMFILE','EIO']) {
      for (const main of ['good','missing','empty','torn']) {
        const file = path.join(root, code+'-'+main+'.json');
        const original = '{"important":"retain"}';
        if (main !== 'missing') fs.writeFileSync(file, main==='good' ? original : main==='empty' ? '' : '{torn');
        fs.writeFileSync(file+'.bak', original);
        const target = main==='good' ? file : file+'.bak';
        const io = Object.create(fs);
        let locked = true, quarantines = 0;
        io.readFileSync = (p,...args) => {
          if (locked && p===target) throw Object.assign(new Error('injected '+code),{code});
          return fs.readFileSync(p,...args);
        };
        const store = makeDurableJsonStore({fs:io,path,fileFor:()=>file,onCorrupt:(_k,p)=>{
          quarantines++; fs.renameSync(p,p+'.quarantined'); return true;
        }});
        check(()=>assert.equal(store.readKey('key').status,'unreadable',code+' '+main+' must stay unreadable'));
        check(()=>assert.equal(quarantines,0,'unreadable bytes must never enter destructive quarantine'));
        check(()=>assert.throws(()=>store.set('key',{important:'replacement'}),{code:'ESTORE_UNREADABLE'}));
        check(()=>assert.throws(()=>writeJsonResilient({fs:io,path},file,{important:'replacement'}),{code:'ESTORE_UNREADABLE'}));
        let error; try { await store.update('key',()=>({important:'replacement'})); } catch(e) { error=e; }
        check(()=>assert.equal(error?.code,'ESTORE_UNREADABLE','update must refuse too'));
        locked=false;
        const restarted=makeDurableJsonStore({fs,path,fileFor:()=>file});
        check(()=>assert.deepEqual(restarted.get('key'),JSON.parse(original),'restart recovers original bytes'));
      }
    }
    const file=path.join(root,'backup-write.json'); fs.writeFileSync(file,'{"version":1}');
    // D1: the .bak copy runs out of disk after its temp exists; the real durable writer runs for both files
    const full=Object.create(fs); full.writeSync=()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};
    const wd=(deps,p,bytes)=>require('../sidecar/durable-write.js').writeFileDurable(p.endsWith('.bak')?{...deps,fs:full}:deps,p,bytes);
    // the .bak is a hard link when the filesystem allows one (perf 10-19); refuse the link so the COPY path runs
    const noLink=new Proxy(fs,{get(t,k){if(k==='linkSync') return ()=>{throw Object.assign(new Error('not supported'),{code:'EPERM'});}; const v=t[k]; return typeof v==='function'?v.bind(t):v;}});
    check(()=>assert.doesNotThrow(()=>writeJsonResilient({fs:noLink,path,writeDurable:wd},file,{version:2}),'D1: a .bak that cannot be refreshed never blocks the write'));
    check(()=>assert.deepEqual(readJsonResilient({fs},file).value,{version:2},'D1: the committed write lands'));
    check(()=>assert.ok(!fs.existsSync(file+'.bak')||JSON.parse(fs.readFileSync(file+'.bak','utf8')).version===1,'D1: the .bak keeps what it could (absent, or the previous main), never a torn copy'));
    check(()=>assert.deepEqual(fs.readdirSync(root).filter(n=>n.startsWith('backup-write.json')&&/\.tmp$/.test(n)),[],'D1: no temp of the main or the .bak is left'));
    // the link path: the .bak is the previous main's bytes, and no second durable write is made for it
    const linked=path.join(root,'backup-link.json'); fs.writeFileSync(linked,'{"version":1}');
    const writes=[]; const wd2=(deps,p,bytes)=>{writes.push(p); return require('../sidecar/durable-write.js').writeFileDurable(deps,p,bytes);};
    writeJsonResilient({fs,path,writeDurable:wd2},linked,{version:2});
    check(()=>assert.deepEqual(writes,[linked],'one durable write: the main (the .bak is a link, not a rewrite)'));
    check(()=>assert.deepEqual(JSON.parse(fs.readFileSync(linked+'.bak','utf8')),{version:1},'.bak holds the previous committed main'));
    check(()=>assert.deepEqual(readJsonResilient({fs},linked).value,{version:2},'main holds the new value'));
    fs.writeFileSync(linked,'{torn'); writeJsonResilient({fs,path,writeDurable:wd2},linked,{version:3});
    check(()=>assert.deepEqual(JSON.parse(fs.readFileSync(linked+'.bak','utf8')),{version:1},'a torn main never replaces the good .bak'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
  console.log(`durable-store faults: ${checks-failures}/${checks} checks passed`);
  process.exitCode=failures?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
