/* node test/website-skill-market.test.js — the public Skill Market page on starnetos.com (2026-09-30).

   website/market.html lists the same signed catalog every station installs from. This pins what keeps it honest
   and safe on a strict-CSP static site:
     - it is a shell-stamped top page: Skills sits in the nav and footer of every page, and the sitemap lists it
     - no inline script or inline handler (the site's CSP forbids both); it loads market.js, never site.js (the
       privacy policy says only the download page makes the api.github.com request)
     - market.js only ever requests the catalog and published package files on its own origin, inserts catalog
       text with textContent (never innerHTML), and only links https upstreams
     - deploy staging publishes the page, its script and its styles */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'website');
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');
const html = read('market.html');
const js = read('market.js');

// ---- the page ----
A.ok(/<title>Skill Market — StarNet<\/title>/.test(html), 'the page has its own title');
A.ok(/<link rel="canonical" href="https:\/\/starnetos\.com\/market\.html">/.test(html), 'and a canonical URL');
A.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script> (the CSP forbids it)');
A.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers');
A.ok(/<script src="market\.js\?v=[^"]+"><\/script>/.test(html), 'it loads market.js');
A.ok(!/site\.js/.test(html), 'and never site.js (the only page allowed the api.github.com request is the download page)');
A.ok(/<a href="market\.html" class="on">Skills<\/a>/.test(html), 'its own nav entry is marked current');
for (const id of ['mk-list', 'mk-status', 'mk-q', 'mk-count']) A.ok(html.indexOf('id="' + id + '"') >= 0, 'the page has #' + id + ' for market.js');
// ---- uploads (2026-10-06): SHARE YOUR SKILL sends authors to their account's Skills tab, the only upload door ----
A.ok(/<section class="section" id="share">[\s\S]*?<a class="btn btn-primary" href="https:\/\/account\.starnetos\.com\/account\/skills">\[ SUBMIT A SKILL \]<\/a>/.test(html), 'SHARE YOUR SKILL links SUBMIT to account.starnetos.com/account/skills');
A.eq([...html.matchAll(/href="(https:\/\/account\.starnetos\.com[^"]*)"/g)].map(m => m[1]).filter(u => u !== 'https://account.starnetos.com/account/skills'), [], 'and no other account URL');
A.ok(!/Not yet\. Today the market carries/.test(html), 'the FAQ no longer says publishing is impossible');
A.eq([...html.matchAll(/<span class="section-no">(\d+)<\/span>/g)].map(m => m[1]), ['01', '02', '03', '04', '05'], 'sections stay numbered in order');
A.ok(/if \(s\.uploaded === true\) meta\.appendChild\(document\.createTextNode\(/.test(js), 'an uploaded skill\'s card says it was shared by a StarNet user (as text)');

// ---- every page links it ----
const pages = [];
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) { if (!['app', 'skills', '.well-known', 'assets'].includes(n)) walk(p); }
    else if (n.endsWith('.html')) pages.push(path.relative(SITE, p).split(path.sep).join('/'));
  }
})(SITE);
const missing = pages.filter(p => /class="topnav"/.test(read(p)) && !/>Skills<\/a>/.test(read(p)));
A.eq(missing, [], 'every page with the site nav has a Skills link');
const noFooter = pages.filter(p => /class="footer-links"/.test(read(p)) && !/>SKILLS<\/a>/.test(read(p)));
A.eq(noFooter, [], 'and every footer has SKILLS');
A.ok(read('sitemap.xml').indexOf('<loc>https://starnetos.com/market.html</loc>') >= 0, 'the sitemap lists the page');
A.ok(/href="\.\.\/market\.html"/.test(read('docs/skills.html')), 'the skills reference in the docs points to it');
const shell = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'website-shell.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
A.eq(shell.status, 0, 'the shared shell is stamped: ' + (shell.stdout || shell.stderr).trim().split('\n').pop());

// ---- the script ----
const fetches = [...js.matchAll(/fetch\(\s*([^,)]+)/g)].map(m => m[1].trim());
A.eq(fetches.sort(), ['INDEX', 'path'], 'market.js makes exactly two kinds of request: the catalog and a package file');
A.ok(/var INDEX = '\/\.well-known\/starnet-skills\.json';/.test(js), 'the catalog is the same-origin signed index stations install from');
A.ok(/function safePath\(p\) \{ return \/\^\\\/skills\\\//.test(js), 'package files are only requested under /skills/<slug>/<version>/');
A.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js), 'catalog text is never inserted as HTML');
A.ok(/function safeHttps\(u\)/.test(js) && /a\.href = up;/.test(js), 'upstream links go through the https check');
A.ok(!/localStorage|sessionStorage|document\.cookie|navigator\.sendBeacon/.test(js), 'no storage and no tracking');
A.ok(/var dl = s\.download && \/\^\[a-z0-9-\]\+-\\d\+\\\.\\d\+\\\.\\d\+\\\.zip\$\/\.test/.test(js) && /safePath\('\/skills\/' \+ s\.slug/.test(js) && /a2\.setAttribute\('download'/.test(js),
  'Download links only to the published <slug>-<version>.zip inside the package folder, through the same path check');
A.ok(!/https?:\/\//.test(js.replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*)$/gm, '').replace(/safeHttps[\s\S]*?\}/, '')), 'no hard-coded outside hosts');

// the path check behaves: published package files only
const safePath = new Function('p', /function safePath\(p\) \{ (return [^\n]*?) \}/.exec(js)[1]);
A.eq(['/skills/grill-me/1.0.0/SKILL.md', '/skills/simple-english/1.0.0/references/checklist.md'].map(safePath).every(Boolean), true, 'real package paths are allowed');
A.eq(['https://evil.example/SKILL.md', '/skills/../_headers', '/.well-known/x', '//evil.example/skills/a/1.0.0/SKILL.md', '/skills/a/1.0/SKILL.md'].map(safePath).filter(Boolean), [], 'anything else is not');

// ---- deploy staging publishes it ----
const staged = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'stage-website-deploy.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
const held = (staged.stdout || '').split('\n').filter(l => /^\s+- /.test(l)).map(l => l.trim().slice(2));
A.eq(held.filter(f => /^market\.(html|js|css)$/.test(f)), [], 'deploy staging publishes market.html, market.js and market.css');

A.report('website-skill-market.test');
