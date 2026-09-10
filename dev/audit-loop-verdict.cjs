const {auth,api,mock,sleep}=require('./audit-api.cjs');const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
async function main(){await auth();const root=path.resolve('dev/audit-0910/verdict-repo-'+Date.now());fs.mkdirSync(root,{recursive:true});const git=(...args)=>cp.execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();git('init','-q');for(const key of ['user.name','user.email']){const value=cp.execFileSync('git',['config',key],{encoding:'utf8'}).trim();if(!value)throw Error('Missing repository human identity');git('config',key,value);}fs.writeFileSync(path.join(root,'base.txt'),'base\n');git('add','--','base.txt');git('commit','-q','-m','test: audit verdict baseline');
 const report={root,baseHead:git('rev-parse','HEAD')};report.bless=await api('/api/projects/bless',{path:root});
 await mock({mode:'hold'});report.created=await api('/api/loops',{name:'Audit conflicting verdicts',objective:'Produce one audit candidate to review.',workdir:root,queueCap:1,maxIterations:1,exitOn:'never',model:'anthropic/claude-haiku-4.5',provider:'openrouter'});const id=report.created.loop?.id;if(!id)throw Error(JSON.stringify(report.created));
 let s;for(let n=0;n<180;n++){s=(await api('/api/loops')).loops.find(l=>l.id===id);if(s?.state==='running')break;await sleep(250)};console.log('loop state '+s?.state);
 if(s?.state!=='running')throw Error(JSON.stringify(s));
 // Same fixture technique as loops-git.e2e: place a known candidate during a held model run.
 fs.writeFileSync(path.join(root,'candidate.txt'),'AUDIT_APPROVED_WORK_MUST_REMAIN\n');await mock({mode:'quick',release:true});
 for(let n=0;n<180;n++){s=(await api('/api/loops')).loops.find(l=>l.id===id);if(s?.recent?.some(i=>i.commit))break;await sleep(250)}
 report.candidate=s;report.fileBefore=fs.existsSync(path.join(root,'candidate.txt'));console.log('candidate '+JSON.stringify(s));
 const iter=s?.recent?.find(i=>i.commit);if(!iter)throw Error('No committed candidate');
 // Reject begins asynchronous git work; the competing approval can commit its verdict while it awaits git.
 const rejection=api('/api/loops/verdict',{id,n:iter.n,verdict:'rejected'});await sleep(25);
 report.approval=await api('/api/loops/verdict',{id,n:iter.n,verdict:'approved'});report.rejection=await rejection;
 report.after=(await api('/api/loops')).loops.find(l=>l.id===id);report.fileAfter=fs.existsSync(path.join(root,'candidate.txt'));report.gitLog=git('log','-3','--oneline');
 fs.writeFileSync('dev/audit-0910/loop-verdict-race.json',JSON.stringify(report,null,2));console.log(JSON.stringify({approval:report.approval,rejection:report.rejection,fileBefore:report.fileBefore,fileAfter:report.fileAfter,recent:report.after.recent,gitLog:report.gitLog}));
}main().catch(e=>{console.error(e);process.exitCode=1});
