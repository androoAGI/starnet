/* Discovery stays with the Commander profile; prepared work opens in Recipes.
   Retain this module path and the saved discovery data when retiring the duplicate hub. */
'use strict';
(() => {
  const esc = StationUI.h.esc;
  async function post(path, body) {
    const r = await Harness.apiFetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error || j.reason || 'Could not save the change.');
    return j;
  }
  function openDraft(options) {
    StationUI.closeTerm('commander');
    Marketplace.open({tab:'recipes',firstValue:options || {},onLaunch:App.launchRecipe});
    return true;
  }
  function mountSources(parent) {
    const detail = document.createElement('details');
    detail.className = 'wh-source-settings';
    detail.innerHTML = '<summary>Sources Agent OS can study for useful work</summary><div class="wh"><p class="wh-message" role="status"></p><div class="wh-content"></div></div>';
    parent.appendChild(detail);
    const host=detail.querySelector('.wh-content'), message=detail.querySelector('.wh-message');
    let sources=null, findings=[], loading=false;
    const say = text => {if(message.isConnected)message.textContent=text;};
    async function refresh() {
      if(loading)return; loading=true; host.textContent='Reading your sources…';
      try {
        const j=await Harness.api.get('/api/discovery/sources');
        if(!j || !j.ok || !Array.isArray(j.sources))throw Error('Could not read sources. Reopen this section to retry.');
        const d=await Harness.api.get('/api/discovery');
        if(!d || !Array.isArray(d.staged))throw Error('Could not read suggestions. Reopen this section to retry.');
        if(!detail.isConnected)return;
        sources=j; findings=d && Array.isArray(d.staged)?d.staged:[];
        const roots=(j.approvedRoots || []).map(r=>typeof r==='string'?r:r.root || r.path).filter(Boolean);
        const source=j.sources.find(s=>s.kind==='client-update');
        host.innerHTML='<p>Choose an approved folder of notes. Agent OS looks for client updates worth drafting and shows the evidence here. Scanning these text files stays local; starting a draft sends its task context to your configured model.</p>'
          +(roots.length?'<label class="wh-field">Folder<select class="key-input wh-root">'+roots.map(r=>'<option'+(source && source.root===r?' selected':'')+'>'+esc(r)+'</option>').join('')+'</select></label><button class="bb sm" data-save>USE THIS FOLDER</button>':'<p>No approved folders yet. Choose a project folder or use a pasted sample.</p>')
          +'<div class="wh-actions"><button class="bb sm" data-projects>PROJECT FOLDERS</button><button class="bb sm" data-sample>USE A SAMPLE</button></div>'
          +(source?'<p>'+esc(source.root)+' · '+(source.enabled?'discovery enabled':'discovery paused')+(source.available===false?' · folder unavailable':'')+'</p><div class="wh-actions"><button class="bb sm" data-toggle>'+(source.enabled?'PAUSE':'RESUME')+'</button><button class="bb sm" data-remove>REMOVE SOURCE</button><button class="bb sm" data-scan>SCAN NOW</button></div>':'')
          +'<h4>Suggestions from these notes</h4>'+(findings.length?findings.map((f,i)=>'<article class="wh-card"><b>'+esc(f.title)+'</b><p>'+esc(f.quote)+'</p><details><summary>Why this was suggested</summary>'+(f.evidence || []).map(e=>'<p>'+esc(e.path)+':'+esc(e.line)+' — '+esc(e.quote)+'</p>').join('')+'</details><div class="wh-actions"><button class="bb sm" data-finding="'+i+'">REVIEW DRAFT SETUP</button><button class="bb sm" data-dismiss="'+i+'">NOT USEFUL</button></div></article>').join(''):'<p>No current suggestions from this source. Your agent is available in COMMS for any task.</p>');
      } catch(e) {if(detail.isConnected)host.textContent=e.message;} finally {loading=false;}
    }
    detail.addEventListener('toggle',ev=>{if(ev.target===detail && detail.open)refresh();});
    detail.addEventListener('click',async ev=>{
      const b=ev.target.closest('button'); if(!b || !detail.contains(b))return;
      if(b.hasAttribute('data-sample')){openDraft();return;}
      if(b.hasAttribute('data-projects')){StationUI.closeTerm('commander');document.getElementById('ws-tab-projects')?.click();return;}
      if(b.dataset.finding!==undefined){const f=findings[Number(b.dataset.finding)];if(f)openDraft({findingId:f.id,root:f.root,intent:'client-update',pain:f.title,reason:'Suggested from evidence in your selected folder'});return;}
      const source=sources && sources.sources.find(s=>s.kind==='client-update'); b.disabled=true;
      try {
        if(b.hasAttribute('data-save'))await post('/api/discovery/sources',{root:host.querySelector('.wh-root').value,enabled:true});
        else if(b.hasAttribute('data-toggle') && source)await post('/api/discovery/sources',{enabled:!source.enabled});
        else if(b.hasAttribute('data-remove'))await post('/api/discovery/sources',{remove:true});
        else if(b.hasAttribute('data-scan'))await post('/api/discovery/scan',{});
        else if(b.dataset.dismiss!==undefined){const f=findings[Number(b.dataset.dismiss)];if(f)await post('/api/discovery/decide',{id:f.id,decision:'dismiss'});}
        say('Updated. Review the source and suggestions below.');await refresh();
      }catch(e){say(e.message);}finally{if(b.isConnected)b.disabled=false;}
    });
  }
  window.WorkHub={mountSources,open:(pane,options)=>pane==='draft' || pane==='start'?openDraft(options):StationUI.openTerm(pane==='sources'?'commander':pane==='station'?'quests':'tasks')};
  FirstValue.configure({onOpen:openDraft});
})();
