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
    const wd=(_deps,p,bytes)=>{if(p.endsWith('.bak')) throw Object.assign(new Error('disk full'),{code:'ENOSPC'});fs.writeFileSync(p,bytes);};
    check(()=>assert.throws(()=>writeJsonResilient({fs,path,writeDurable:wd},file,{version:2}),{code:'ENOSPC'}));
    check(()=>assert.deepEqual(readJsonResilient({fs},file).value,{version:1},'failed backup must preserve the committed primary'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
  console.log(`durable-store faults: ${checks-failures}/${checks} checks passed`);
  process.exitCode=failures?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
