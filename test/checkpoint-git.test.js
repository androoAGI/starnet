'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'starnet-checkpoint-git-'));
const heartbeat = path.join(root,'heartbeat.txt');
const worker = path.join(root,'worker.cjs');
const launcher = path.join(root,'launcher.cjs');
// The worker stops by itself after 30 s, so a failed run leaves no process behind.
fs.writeFileSync(worker,"const fs=require('node:fs'); setTimeout(()=>process.exit(0),30000); setInterval(()=>fs.appendFileSync(process.argv[2],'x'),40);");
// The grandchild must be able to OUTLIVE the launcher, or killing only the direct child would pass. On Windows, node
// puts a non-detached child in a kill-on-close job, so the launcher's death would take the worker with it; detached
// keeps it out (as git's own children are). On POSIX it stays in the launcher's process group, as git's children
// do. It inherits the output pipe, as git's children do, so the runner settles only once every holder is gone.
fs.writeFileSync(launcher,"require('node:child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'inherit',windowsHide:true,detached:process.platform==='win32'});setInterval(()=>{},1000);");
// A grandchild that survives keeps that pipe open and the run never settles: bound the wait so that fails, not stalls.
const settled=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(()=>r(null),ms))]);
const run = makeCheckpointGitRunner({spawn,file:process.execPath,timeoutMs:1200,clock:{now:()=>Date.now()}});
(async()=>{
  try {
    const split = await run(['-e',"process.stdout.write('data'); process.stderr.write('warning');"],{cwd:root});
    A.eq(split.code,0,'successful process'); A.eq(split.stdout,'data','stdout contains only data'); A.eq(split.stderr,'warning','stderr retained separately');
    const timed = await settled(run([launcher,worker,heartbeat],{cwd:root}),8000);
    A.ok(timed&&timed.timedOut&&timed.code!==0,'timeout is observable, and the run settled (no descendant kept the output open)');
    A.ok(fs.existsSync(heartbeat),'descendant actually ran');
    const before=fs.statSync(heartbeat).size;
    await new Promise(r=>setTimeout(r,250));
    A.eq(fs.statSync(heartbeat).size,before,'timeout stopped descendant before returning');
    // abort only once THIS run's grandchild is writing, so a kill of the direct child alone cannot pass (tests-11);
    // its own runner has a long timeout so a slow spawn is waited for, never turned into a timeout instead.
    const abortRun=makeCheckpointGitRunner({spawn,file:process.execPath,timeoutMs:15000,clock:{now:()=>Date.now()}});
    const controller=new AbortController();
    const startSize=fs.statSync(heartbeat).size;
    const aborted=abortRun([launcher,worker,heartbeat],{cwd:root,signal:controller.signal});
    const deadline=Date.now()+10000;
    while(fs.statSync(heartbeat).size===startSize&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
    A.ok(fs.statSync(heartbeat).size>startSize,'descendant running before abort');
    controller.abort();
    const abortResult=await settled(aborted,8000);
    A.ok(abortResult&&abortResult.aborted&&abortResult.code!==0,'abort is observable, and the run settled (no descendant kept the output open)');
    const afterAbort=fs.statSync(heartbeat).size;
    await new Promise(r=>setTimeout(r,250));
    A.eq(fs.statSync(heartbeat).size,afterAbort,'abort stopped descendant before returning');
    // #107 residual: a per-call bound wins over the constructor default. Shadow-repo maintenance (gc, the re-init
    // add/commit) needs longer than a snapshot's add; ignoring opts.timeoutMs cut every gc off at the default and
    // left its half-written tmp_pack behind on every turn. A 2.5 s command must finish under a 6 s per-call bound
    // even though the runner's own default (1.2 s) would kill it, and a per-call bound shorter than the default
    // must still stop a command that would otherwise run on.
    const slowOk=await settled(run(['-e',"setTimeout(()=>{process.stdout.write('done');process.exit(0);},2500)"],{cwd:root,timeoutMs:6000}),12000);
    A.ok(slowOk&&slowOk.code===0&&!slowOk.timedOut,'a per-call timeoutMs longer than the default lets the command finish');
    A.eq(slowOk&&slowOk.stdout,'done','the longer per-call bound returns the command output');
    const longDefault=makeCheckpointGitRunner({spawn,file:process.execPath,timeoutMs:15000,clock:{now:()=>Date.now()}});
    const t0=Date.now();
    const cutShort=await settled(longDefault(['-e',"setTimeout(()=>process.exit(0),12000)"],{cwd:root,timeoutMs:1200}),10000);
    A.ok(cutShort&&cutShort.timedOut&&cutShort.code!==0,'a per-call timeoutMs shorter than the default stops the command');
    A.ok(Date.now()-t0<10000,'the shorter per-call bound is honoured, not the 15 s default');
    const missing=await makeCheckpointGitRunner({spawn,file:path.join(root,'absent-executable')})([],{cwd:root});
    A.ok(missing.code!==0,'missing executable resolves fail-open error');
    const source=readSidecarSource();
    A.ok(source.includes("require('./checkpoint-git.js').makeCheckpointGitRunner"),'real sidecar wires supervised checkpoint runner');
    const bounded = makeCheckpointGitRunner({spawn,file:process.execPath,maxBytes:128});
    for (const stream of ['stdout','stderr']) {
      const tooMuch = await bounded(['-e',"process."+stream+".write('x'.repeat(4096));setInterval(()=>{},1000)"],{cwd:root});
      A.ok(tooMuch.code!==0&&tooMuch.truncated,'oversized '+stream+' cannot be parsed as success');
      A.ok(tooMuch.stdout.length<=128&&tooMuch.stderr.length<256,'captured output stays bounded');
    }
    A.report('checkpoint-git.test');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
