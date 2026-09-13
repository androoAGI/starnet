/* Progressive reading aids. Everything is local; article content stays visible without JS. */
(function(){
  'use strict';
  var d=document, main=d.querySelector('.docs-main');
  if(!main) return;
  d.body.classList.add('docs-enhanced');
  var up=location.pathname.includes('/docs/guides/') ? '../' : '';
  var esc=function(s){return String(s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
  var y=d.getElementById('year'); if(y) y.textContent=String(new Date().getFullYear());

  var crumbs=d.createElement('nav'); crumbs.className='crumbs'; crumbs.setAttribute('aria-label','Breadcrumb');
  var overview=d.body.classList.contains('docs-overview');
  crumbs.innerHTML='<a href="'+up+'index.html">Docs</a><span class="sep">/</span>' +
    (overview ? '<span class="here">'+esc(d.body.dataset.title)+'</span>' :
    '<a href="'+up+'index.html#'+esc(d.body.dataset.groupId)+'">'+esc(d.body.dataset.group)+'</a><span class="sep">/</span><span class="doc-kind">'+esc(d.body.dataset.kind)+'</span>');
  // The docs landing page already identifies itself; articles keep their topic trail.
  if(!overview || d.body.dataset.title!=='Documentation') main.prepend(crumbs);

  function revealTarget(){
    var id; try{id=decodeURIComponent(location.hash.slice(1));}catch(e){return;}
    var target=id && d.getElementById(id);
    if(!target) return;
    var parent=target.closest('details');
    while(parent){parent.open=true;parent=parent.parentElement.closest('details');}
    target.scrollIntoView({block:'start'});
  }
  addEventListener('hashchange',revealTarget);
  // Wait for initial layout, including the reading aids and browser scroll restoration.
  addEventListener('load',function(){if(location.hash)requestAnimationFrame(revealTarget);},{once:true});

  var heads=Array.from(main.querySelectorAll('h2[id]'));
  main.querySelectorAll('h2[id],h3[id]').forEach(function(h){
    var a=d.createElement('a'); a.className='h-anchor'; a.href='#'+h.id; a.textContent='#'; a.setAttribute('aria-label','Link to '+h.textContent.trim()); h.append(a);
  });
  if(heads.length>=3 && !overview){
    var toc=d.createElement('aside'); toc.className='docs-toc'; toc.setAttribute('aria-label','On this page');
    toc.innerHTML='<div class="toc-title">On this page</div><ol>'+heads.map(function(h){return '<li><a href="#'+esc(h.id)+'">'+esc(h.textContent.replace(/#$/,'').replace(/^\d+[.\s]*/,'').trim())+'</a></li>';}).join('')+'</ol><a class="toc-top" href="#main-content">Back to top ↑</a>';
    main.parentNode.append(toc); main.parentNode.classList.add('has-toc');
    var tocLinks=Array.from(toc.querySelectorAll('ol a'));
    function spy(){
      var current=heads[0]; heads.forEach(function(h){if(h.getBoundingClientRect().top<=130) current=h;});
      tocLinks.forEach(function(a){var on=a.hash==='#'+current.id;a.classList.toggle('on',on);if(on)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});
    }
    addEventListener('scroll',spy,{passive:true});spy();
  }
  var bar=d.createElement('div');bar.className='read-progress';bar.setAttribute('aria-hidden','true');d.body.append(bar);
  function progress(){var h=d.documentElement,max=h.scrollHeight-h.clientHeight;bar.style.transform='scaleX('+(max>0?Math.min(1,h.scrollTop/max):0)+')';}
  addEventListener('scroll',progress,{passive:true});progress();

  main.querySelectorAll('table').forEach(function(table){
    var wrap=d.createElement('div');wrap.className='table-wrap';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Scrollable reference table');table.before(wrap);wrap.append(table);
  });
  main.querySelectorAll('pre').forEach(function(pre){
    if(!navigator.clipboard) return;
    var wrap=d.createElement('div');wrap.className='pre-wrap';pre.before(wrap);wrap.append(pre);
    var b=d.createElement('button');b.type='button';b.className='pre-copy';b.textContent='Copy';b.setAttribute('aria-live','polite');
    b.addEventListener('click',function(){
      navigator.clipboard.writeText(pre.textContent.replace(/^\$\s?/gm,'')).then(function(){b.textContent='Copied';b.classList.add('ok');},function(){b.textContent='Select text to copy';})
        .then(function(){setTimeout(function(){b.textContent='Copy';b.classList.remove('ok');},2000);});
    });wrap.append(b);
  });
  var side=d.getElementById('docs-side'),toggle=side.querySelector('.side-toggle');
  toggle.addEventListener('click',function(){var open=side.classList.toggle('open');toggle.setAttribute('aria-expanded',String(open));toggle.textContent=open?'Close documentation menu':'Browse documentation';});

  var input=d.getElementById('docs-search'),results=d.getElementById('docs-results'),status=d.getElementById('docs-search-status');
  function closeSearch(){results.hidden=true;input.setAttribute('aria-expanded','false');}
  function search(){
    var q=input.value.trim();
    if(q.length<2){closeSearch();results.replaceChildren();status.textContent='';return;}
    var hits=window.SN_DOCS_SEARCH(window.SN_DOCS_INDEX||[],q);
    results.innerHTML=hits.length ? hits.map(function(h){return '<a class="ss-hit" href="'+up+esc(h.url)+'"><span class="ss-g">'+esc(h.page.g)+' · '+esc(h.page.k)+'</span><span class="ss-t">'+esc(h.label)+'</span><span class="ss-s">'+esc(h.label!==h.page.t?h.page.t:h.excerpt)+'</span></a>';}).join('') : '<div class="ss-none">No results for “'+esc(q)+'”. Try a shorter phrase or visit the <a href="'+up+'help.html">help center</a>.</div>';
    results.hidden=false;input.setAttribute('aria-expanded','true');status.textContent=hits.length?hits.length+' results available. Use the down arrow to browse.':'No results.';
  }
  input.addEventListener('input',search);input.addEventListener('focus',function(){if(input.value)search();});
  input.addEventListener('keydown',function(e){
    if(e.key==='Escape'){closeSearch();input.blur();}
    var first=!results.hidden && results.querySelector('a');
    if(e.key==='Enter' && first){e.preventDefault();first.click();}
    if(e.key==='ArrowDown' && first){e.preventDefault();first.focus();}
  });
  results.addEventListener('keydown',function(e){
    var links=Array.from(results.querySelectorAll('a')),i=links.indexOf(d.activeElement);
    if(e.key==='ArrowDown' && links[i+1]){e.preventDefault();links[i+1].focus();}
    if(e.key==='ArrowUp'){e.preventDefault();(links[i-1]||input).focus();}
    if(e.key==='Escape'){input.focus();closeSearch();}
  });
  d.addEventListener('click',function(e){if(!e.target.closest('.side-search'))closeSearch();});
  d.addEventListener('keydown',function(e){
    if(d.activeElement.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(d.activeElement.tagName)||e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.key==='/'){e.preventDefault();input.focus();}
  });
})();
