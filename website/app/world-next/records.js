/* Read-only durable work views. Session contents and artifact status remain server-owned. */
'use strict';
const NextRecords=(()=>{
 function mount({host,bridge,agentId,onError}){
  const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
  const nav=make('div',null,'chip-row'),body=make('div');host.replaceChildren(nav,body);let revision=0;
  async function load(kind){const current=++revision;body.replaceChildren(make('p','Loading recorded work…','muted'));try{
   if(kind==='sessions'){
    const [saved,runs]=await Promise.all([bridge.savedSessions(),bridge.listRuns({agentId,limit:50})]);if(current!==revision)return;body.replaceChildren();
    const items=(saved.workstreams||[]).filter(s=>!agentId||s.agentId===agentId),seen=new Set(items.map(s=>s.id));
    for(const r of runs.runs||[])if(r.streamId&&!seen.has(r.streamId)){seen.add(r.streamId);items.push({id:r.streamId,agentId:r.agentId,title:r.title||r.prompt||'Recorded conversation'});}
    body.append(make('p','Saved conversations and recent recorded runs. Select one to read its durable transcript.','muted'));
    if(!items.length)body.append(make('p','No recorded sessions for this crew member.','muted'));
    for(const s of items){const b=make('button',s.title||'General conversation','run-card record-link');b.onclick=async()=>{try{const data=await bridge.readTranscript(s.id,{agentId:s.agentId||agentId,limit:200});if(current!==revision)return;body.replaceChildren();const back=make('button','← Conversations','action');back.onclick=()=>load('sessions');body.append(back,make('p',s.title||'General conversation','section-title'));for(const t of data.turns||[]){if(!t.content)continue;const row=make('div',null,'message '+(t.role==='user'?'user':''));row.append(make('span',t.role==='user'?'YOU':t.agentId||t.role,'speaker'),make('span',typeof t.content==='string'?t.content:JSON.stringify(t.content)));body.append(row);}if(!data.turns?.length)body.append(make('p','No durable transcript turns are available for this session.','muted'));}catch(e){onError(e.message);}};body.append(b);}
   }else if(kind==='files'){
    const data=await bridge.request('/api/deliverables');if(current!==revision)return;body.replaceChildren();
    const rows=(data.items||[]).filter(r=>!agentId||!r.agentId||r.agentId===agentId);if(!rows.length)body.append(make('p','No recorded deliverables for this crew member.','muted'));
    for(const r of rows){const card=make('div',null,'run-card');card.append(make('b',r.title||'Deliverable'),make('small',[r.kind,r.status].filter(Boolean).join(' · ')));if(r.summary)card.append(make('p',r.summary,'muted'));for(const f of r.files||[]){const path=typeof f==='string'?f:f.path;if(!path)continue;const b=make('button','Read '+path,'action record-link');b.onclick=async()=>{try{const text=await bridge.request('/api/file?agent='+encodeURIComponent(r.agentId||agentId)+'&path='+encodeURIComponent(path),{text:true});if(current!==revision)return;body.replaceChildren();const back=make('button','← Deliverables','action');back.onclick=()=>load('files');body.append(back,make('p',path,'section-title'));const source=make('pre',text.slice(0,150000),'file-source');
 if(/\.html?$/i.test(path)){const frame=make('iframe');frame.title=path+' preview';frame.setAttribute('sandbox','');frame.className='artifact-preview';frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'+text;const toggle=make('button','View source','action');source.hidden=true;toggle.onclick=()=>{source.hidden=!source.hidden;frame.hidden=!frame.hidden;toggle.textContent=source.hidden?'View source':'View preview';};body.append(toggle,frame,source);}else body.append(source);}catch(e){onError(e.message);}};card.append(b);}body.append(card);}
   }else{
    const data=await bridge.request('/api/workshop/backlog?agent='+encodeURIComponent(agentId));if(current!==revision)return;body.replaceChildren();body.append(make('p','Recorded workshop queue · '+(data.granted?'Away work enabled':'Away work disabled'),'muted'));for(const r of data.items||[]){const row=make('div',null,'run-card');row.append(make('b',r.title||r.id),make('small',r.status||r.state||'Unknown state'));body.append(row);}if(!data.items?.length)body.append(make('p','No workshop items are queued.','muted'));
   }
  }catch(e){if(current===revision)body.replaceChildren(make('p',e.message,'muted'));}}
  for(const [id,label]of [['sessions','Conversations'],['files','Deliverables'],['queue','Workshop']]){const b=make('button',label,'chip');b.onclick=()=>{for(const c of nav.children)c.classList.toggle('active',c===b);load(id);};nav.append(b);}nav.firstElementChild.click();return()=>{revision++;};
 }
 return{mount};
})();
