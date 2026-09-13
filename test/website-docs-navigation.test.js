'use strict';
// Keep reorganized docs discoverable: old page URLs, cross-page anchors, search destinations,
// and generated chrome are verified against the real static files.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const A = require('./_assert');
const search = require('../website/docs/search');
const root = path.resolve(__dirname, '..');
const site = path.join(root, 'website');
const ctx = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(site,'docs/search-index.js'),'utf8'),ctx);
const index = ctx.window.SN_DOCS_INDEX;
const pages = index.map(p=>'docs/'+p.u);
A.eq(new Set(pages).size,24,'all 24 existing documentation URLs stay indexed once');
A.eq(new Set(index.map(p=>p.g)).size,6,'docs are organized into six topics');
let checkedLinks=0;
for(const page of ['index.html',...pages]){
  const html=fs.readFileSync(path.join(site,page),'utf8');
  const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]);
  A.eq(ids.length,new Set(ids).size,page+' has unique anchors');
  if(page.startsWith('docs/')){
    A.eq((html.match(/aria-current="page"/g)||[]).length,1,page+' identifies exactly one current page');
    A.ok(html.includes('href="#main-content"'),page+' has a skip link');
    A.ok(!/<script[^>]+src="[^"]*site\.js/.test(html),page+' keeps the docs network-free');
  }
  for(const m of html.matchAll(/href="([^"]+)"/g)){
    const url=new URL(m[1].replace(/&amp;/g,'&'),'https://starnetos.com/'+page);
    if(url.origin!=='https://starnetos.com')continue;
    let file=decodeURIComponent(url.pathname).replace(/^\//,'');
    if(!file || file.endsWith('/'))file+='index.html';
    if(!file.endsWith('.html'))continue;
    const target=path.join(site,file);
    A.ok(fs.existsSync(target),page+' links to existing '+file);
    if(url.hash && fs.existsSync(target)){
      const source=fs.readFileSync(target,'utf8');
      A.ok(source.includes('id="'+decodeURIComponent(url.hash.slice(1))+'"'),page+' resolves '+file+url.hash);
    }
    checkedLinks++;
  }
}
for(const query of ['telegram','api key','night shift','splitter','keyboard','Gatekeeper','Ollama']){
  const hits=search(index,query);
  A.ok(hits.length>0,query+' returns results');
  for(const hit of hits){
    const [file,anchor]=hit.url.split('#');
    const html=fs.readFileSync(path.join(site,'docs',file),'utf8');
    A.ok(!anchor || html.includes('id="'+anchor+'"'),query+' result has a working destination');
  }
}
A.ok(search(index,'Gatekeeper').some(h=>h.url.includes('#')),'body text search links directly to the matching section');
A.eq(search(index,'telegram zzzzzzzzz').length,0,'every query term must match, avoiding unrelated results');
A.eq(search(index,' ').length,0,'empty search returns no results');
A.eq(search(index,'<script>alert(1)</script>').length,0,'markup is treated as a search string');
const stamp=spawnSync(process.execPath,['scripts/website-shell.mjs','--check'],{cwd:root,encoding:'utf8'});
A.eq(stamp.status,0,'generated navigation and index are current: '+stamp.stdout.trim());
console.log('Checked '+checkedLinks+' internal page links.');
A.report('website-docs-navigation.test');
