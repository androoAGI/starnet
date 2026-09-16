/* Real Git blobs above the old aggregate stdout limit remain fully source-locked.
   The payload is compressible fixture data, never a downloaded/generated asset. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),A=require('./_assert');
(async()=>{
 const {buildReleaseSurface,MARKETED_DOCS}=await import(process.env.CLAIMS_TEST_SOURCE ? require('node:url').pathToFileURL(path.resolve(process.env.CLAIMS_TEST_SOURCE)).href : '../scripts/qa/product-perfect/claims.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'starnet-claims-batch-'));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024}).toString('utf8').trim();
 try {
  git('init','--quiet');git('config','core.autocrlf','false');
  const expected=new Map(),MiB=1024*1024;
  function write(relative,size,byte){
   const file=path.join(dir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
   const fd=fs.openSync(file,'w'),hash=crypto.createHash('sha256'),chunk=Buffer.alloc(MiB,byte);
   try {for(let remaining=size;remaining>0;){const data=chunk.subarray(0,Math.min(remaining,chunk.length));fs.writeSync(fd,data);hash.update(data);remaining-=data.length;}}
   finally {fs.closeSync(fd);}
   expected.set(relative,{bytes:size,sha256:hash.digest('hex')});
  }
  for(const name of MARKETED_DOCS)write(name,0,0);
  // One blob exceeds 64 MiB by itself; the smaller pair also exercises a normal
  // multi-object batch. Spaces/non-ASCII names must still resolve exact objects.
  write('frontend/00 large panel.js',65*MiB+17,0x61);
  write('frontend/alpha panel.js',4*MiB+11,0x62);
  write('frontend/beta-\u03b2.js',4*MiB+23,0x63);
  git('add','--',...expected.keys());
  git('-c','user.name=Claims Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','test fixture');
  const head=git('rev-parse','HEAD'),surface=buildReleaseSurface(dir);
  A.eq(surface.sourceCommit,head,'snapshot stays bound to the exact candidate commit');
  A.eq(surface.files.map(r=>r.path),[...expected.keys()].sort(),'all tracked release files survive byte-budgeted batching');
  A.ok(surface.files.reduce((n,r)=>n+r.bytes,0)>64*MiB,'fixture exceeds the former aggregate buffer limit');
  A.ok(surface.files.some(r=>r.bytes>64*MiB),'a single oversized blob must also be read without truncation');
  for(const row of surface.files){
   const want=expected.get(row.path);
   A.eq(row.bytes,want.bytes,row.path+' preserves its complete byte count');
   A.eq(row.sha256,want.sha256,row.path+' hashes every byte from the candidate blob');
  }
  fs.writeFileSync(path.join(dir,'frontend/alpha panel.js'),'uncommitted replacement');
  const cached=buildReleaseSurface(dir,{candidateCommit:head});
  A.eq(cached,surface,'repeated candidate snapshot ignores ambient edits and keeps exact cached bytes');
 } finally {
  // Delete only this fixture directory under the resolved temporary root.
  if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()))throw new Error('fixture cleanup escaped temporary root');
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
 A.report('qa-claims-blob-batch');
})().catch(error=>{console.error(error&&error.stack||error);process.exitCode=1;});
