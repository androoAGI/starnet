// scripts/website-shell.mjs — stamps the shared chrome (topbar, docs sidebar, pager, footer,
// search index, sitemap) into every static page under website/.
//
// The site is plain HTML on Cloudflare Pages with no build step, so the shell used to be
// hand-copied into every page and drifted (docs pages lacked FIELD MANUAL, legal pages had a
// different nav, sidebars disagreed about what existed). This script makes ONE manifest the
// truth: run it after adding or renaming a page and every family is re-stamped identically.
//
//   node scripts/website-shell.mjs           # rewrite in place
//   node scripts/website-shell.mjs --check   # exit 1 if any page would change (CI-friendly)
//
// Rules the script enforces:
//   * The manifest owns navigation, article titles, topic directories and release fallbacks.
//     Article prose and diagrams stay authored in HTML; missing heading IDs are stamped once.
//   * docs/ and legal/ pages never load site.js (privacy.html discloses that only the download
//     page makes the one api.github.com request). docs.js is network-free by construction.
//   * The sitemap lists every published page; stage-website-deploy.mjs prunes held-back URLs.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'website');
const CHECK = process.argv.includes('--check');
const V = '20260913-terminal-nav';
const ORIGIN = 'https://starnetos.com';
const GITHUB = 'https://github.com/androoAGI/starnet';
const RELEASES = 'https://github.com/androoAGI/starnet-releases/releases/latest';
const CONTACT = 'mailto:androo.agi@gmail.com';
const FALLBACK_RELEASE = /var FALLBACK_VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'site.js'), 'utf8'))?.[1];
if (!FALLBACK_RELEASE) throw new Error('site.js must declare the verified public release fallback');

// ---------------------------------------------------------------------------------------
// THE MANIFEST — one topic per page; pagers stay within that topic.
// ---------------------------------------------------------------------------------------
export const NAV = [
  { id: 'start', group: 'Start here', description: 'Install StarNet, choose a model, and give your first agent a task.', items: [
    { url: 'docs/index.html', title: 'Documentation', kind: 'Overview' },
    { url: 'docs/getting-started.html', title: 'Install & first task', kind: 'Quickstart' },
    { url: 'docs/providers.html', title: 'Models & providers', kind: 'Reference' },
    { url: 'docs/guides/index.html', title: 'Step-by-step guides', kind: 'Overview' },
  ]},
  { id: 'station', group: 'Station & agents', description: 'Build your station, recruit a crew, and give them the tools to work.', items: [
    { url: 'docs/station.html', title: 'Station & capabilities', kind: 'Reference' },
    { url: 'docs/guides/crew.html', title: 'Set up your crew', kind: 'Guide' },
    { url: 'docs/agents.html', title: 'Agents, teams & voice', kind: 'Reference' },
    { url: 'docs/guides/goals.html', title: 'Goals, quests & XP', kind: 'Guide' },
  ]},
  { id: 'workflows', group: 'Conveyor workflows', description: 'Send work between agents, route different jobs, and combine results.', items: [
    { url: 'docs/guides/first-line.html', title: 'Build your first workflow', kind: 'Guide' },
    { url: 'docs/guides/conveyors.html', title: 'Conveyor basics', kind: 'Guide' },
    { url: 'docs/guides/filter.html', title: 'Filter & route work', kind: 'Guide' },
    { url: 'docs/guides/splitter-joiner.html', title: 'Split & combine results', kind: 'Guide' },
  ]},
  { id: 'automation', group: 'Repeat & automate', description: 'Reuse good work, schedule routines, and configure unattended runs.', items: [
    { url: 'docs/guides/routines.html', title: 'Create repeatable work', kind: 'Guide' },
    { url: 'docs/skills.html', title: 'Skills & routines reference', kind: 'Reference' },
    { url: 'docs/guides/night-shift.html', title: 'Set up Night Shift', kind: 'Guide' },
    { url: 'docs/autonomy.html', title: 'Autonomy controls', kind: 'Reference' },
  ]},
  { id: 'connections', group: 'Connect your tools', description: 'Connect services, message your station, or work with another harness.', items: [
    { url: 'docs/connect-a-platform.html', title: 'Connect a service', kind: 'Guide' },
    { url: 'docs/guides/channels.html', title: 'Messaging channels', kind: 'Guide' },
    { url: 'docs/connectors.html', title: 'Connectors & MCP reference', kind: 'Reference' },
    { url: 'docs/migrating.html', title: 'From OpenClaw or Hermes', kind: 'Guide' },
  ]},
  { id: 'help', group: 'Troubleshooting & help', description: 'Fix a problem, look up a shortcut, or get help from a human.', items: [
    { url: 'docs/help.html', title: 'Help center', kind: 'Help' },
    { url: 'docs/troubleshooting.html', title: 'Troubleshooting', kind: 'Help' },
    { url: 'docs/shortcuts.html', title: 'Keyboard shortcuts', kind: 'Reference' },
    { url: 'docs/glossary.html', title: 'Glossary', kind: 'Reference' },
  ]},
];
const FLAT = NAV.flatMap(g => g.items.map(i => ({ ...i, group: g.group, groupId: g.id })));

// Only these load site.js (the one api.github.com request) — they get the live version badge.
const LOADS_SITE_JS = ['index.html', 'pricing.html'];
// Pages that get the topbar + footer but no sidebar/pager.
const TOP_PAGES = ['index.html', 'pricing.html', '404.html', 'legal/privacy.html', 'legal/terms.html',
  'legal/_privacy.nocredits.html', 'legal/_terms.nocredits.html'];

// ---------------------------------------------------------------------------------------
const esc = (s) => s.replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function rel(fromPage, toUrl) {
  // both are website-relative posix paths
  const fromDir = posix.dirname(fromPage);
  let r = posix.relative(fromDir === '.' ? '' : fromDir, toUrl);
  return r || './';
}
function topbar(page) {
  const here = (u) => rel(page, u);
  const home = page === 'index.html' ? '' : here('index.html');
  const is404 = page === '404.html';
  const root = is404 ? '/' : home;                    // 404 is served at any depth → absolute
  const h = (u) => is404 ? '/' + u : here(u);
  const dc = page.startsWith('docs/') ? ' class="on"' : '';
  const pr = page === 'pricing.html' ? ' class="on"' : '';
  return `<header class="topbar" id="topbar">
  <a class="brand" href="${root || '#top'}" aria-label="StarNet home">STARNET<span class="brand-divider"> / </span><span class="brand-context">${dc ? 'Docs' : 'Agent station'}</span></a>
  <nav class="topnav" aria-label="Site">
    <a href="${root}#station">Product</a>
    <a href="${h('docs/index.html')}"${dc}>Docs</a>
    <a href="${h('pricing.html')}"${pr} data-pricing-link${LOADS_SITE_JS.includes(page) ? ' hidden' : ''}>Pricing</a>
    <a href="${GITHUB}" target="_blank" rel="noopener">GitHub &nearr;</a>
  </nav>
  <span class="topbar-right">
    <a href="${h('docs/help.html')}">Help</a>
    <a class="nav-download" href="${root}#download">Download &darr;</a>
  </span>
</header>`;
}
function sidebar(page) {
  const here = (u) => rel(page, u);
  const overviewLinks = FLAT.filter(i => i.kind === 'Overview').map(i =>
    `      <a href="${here(i.url)}"${i.url === page ? ' class="active" aria-current="page"' : ''}>${i.url === 'docs/index.html' ? 'Docs overview' : esc(i.title)}</a>`).join('\n');
  const groups = NAV.map(g => {
    const items = g.items.filter(i => i.kind !== 'Overview');
    const links = items.map(i =>
      `    <a href="${here(i.url)}"${i.url === page ? ' class="active" aria-current="page"' : ''}>${esc(i.title)}</a>`).join('\n');
    return `    <details class="side-group"${items.some(i => i.url === page) ? ' open' : ''}>\n    <summary class="side-title">${esc(g.group)}</summary>\n${links}\n    </details>`;
  }).join('\n');
  return `<aside class="docs-side" id="docs-side">
    <div class="side-home">Documentation</div>
    <div class="side-search"><label class="sr-only" for="docs-search">Search docs</label><input id="docs-search" type="search" placeholder="Search docs…" autocomplete="off" spellcheck="false" aria-controls="docs-results" aria-expanded="false"><kbd class="search-key" aria-hidden="true">/</kbd><div class="ss-results" id="docs-results" hidden></div><span id="docs-search-status" class="sr-only" role="status" aria-live="polite"></span></div>
    <button class="side-toggle" type="button" aria-expanded="false" aria-controls="side-nav">Browse documentation</button>
    <nav id="side-nav" class="side-nav" aria-label="Docs">
      <div class="side-quick">
${overviewLinks}
      </div>
      <p class="side-label">Browse topics</p>
${groups}
    </nav>
  </aside>`;
}
function pager(page) {
  const entry = FLAT.find(x => x.url === page);
  if (entry?.kind === 'Overview') return '';
  const peers = FLAT.filter(x => x.group === entry?.group && x.kind !== 'Overview');
  const i = peers.findIndex(x => x.url === page);
  if (i < 0) return '';
  const prev = peers[i - 1], next = peers[i + 1];
  const a = (p, dir) => p ? `<a class="pg ${dir}" href="${rel(page, p.url)}"><span class="pg-k">${dir === 'prev' ? '&larr; PREVIOUS' : 'NEXT &rarr;'}</span><span class="pg-t">${esc(p.title)}</span></a>` : '<span></span>';
  return `<nav class="doc-pager" aria-label="More in ${esc(entry.group)}">${a(prev, 'prev')}${next ? a(next, 'next') : `<a class="pg next" href="${rel(page, 'docs/index.html')}#${entry.groupId}"><span class="pg-k">Explore this topic &rarr;</span><span class="pg-t">${esc(entry.group)}</span></a>`}</nav>`;
}
function footer(page) {
  const here = (u) => page === '404.html' ? '/' + u : rel(page, u);
  const home = page === 'index.html' ? '#top' : (page === '404.html' ? '/' : rel(page, 'index.html'));
  return `<footer class="footer">
  <div class="footer-line">STARNET &middot; a living station of AI agents, doing real work in the dark</div>
  <div class="footer-links">
    <a href="${home}">HOME</a>
    <a href="${GITHUB}" target="_blank" rel="noopener">GITHUB</a>
    <a href="${RELEASES}" target="_blank" rel="noopener">RELEASES</a>
    <a href="${here('pricing.html')}" data-pricing-link${LOADS_SITE_JS.includes(page) ? ' hidden' : ''}>PRICING</a>
    <a href="${here('docs/index.html')}">DOCS</a>
    <a href="${here('docs/help.html')}">HELP</a>
    <a href="${GITHUB}/issues" target="_blank" rel="noopener">COMMUNITY</a>
    <a href="${here('legal/privacy.html')}">PRIVACY</a>
    <a href="${here('legal/terms.html')}">TERMS</a>
    <a href="${CONTACT}">CONTACT</a>
  </div>
  <div class="footer-fine">MIT license &middot; ${LOADS_SITE_JS.includes(page) ? `<span id="ver-foot">v${FALLBACK_RELEASE}</span> &middot; ` : ''}&copy; <span id="year">2026</span> StarNet &middot; no telemetry, no tracking &mdash; <a href="${here('legal/privacy.html')}">we collect nothing</a></div>
</footer>`;
}

// ---------------------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'app' || n === 'assets') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.html')) out.push(posix.join(...relative(ROOT, p).split(/[\\/]/)));
  }
  return out;
}
function replaceBlock(html, open, close, replacement, label, page) {
  const s = html.indexOf(open);
  if (s < 0) { if (replacement) throw new Error(`${page}: missing ${label} marker "${open}"`); return html; }
  const e = html.indexOf(close, s);
  if (e < 0) throw new Error(`${page}: unterminated ${label}`);
  return html.slice(0, s) + replacement + html.slice(e + close.length);
}
function textOf(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function directory() {
  return '<!-- docs-directory -->\n<div class="topic-grid">\n' + NAV.map((g, n) => {
    const items = g.items.filter(i => i.kind !== 'Overview');
    return `<section class="topic" id="${g.id}" aria-labelledby="${g.id}-title"><div class="topic-head"><span class="topic-number" aria-hidden="true">0${n + 1}</span><div><h3 id="${g.id}-title">${esc(g.group)}</h3><p class="topic-desc">${esc(g.description)}</p></div></div><div class="topic-links">` + items.map(i => `<a href="${rel('docs/index.html', i.url)}"><span>${esc(i.title)}</span><small>${i.kind}</small></a>`).join('') + '</div></section>';
  }).join('\n') + '\n</div>\n<!-- /docs-directory -->';
}

// Stable section URLs are authored into the HTML, so search and shared links work without JS.
function anchorHeadings(html) {
  const used = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  return html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (all, level, attrs, body) => {
    if (/\bid=/.test(attrs)) return all;
    const base = textOf(body).toLowerCase().replace(/^\d+[.\s]*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
    let id = base, suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return `<h${level}${attrs} id="${id}">${body}</h${level}>`;
  });
}

const pages = walk(ROOT);
const index = [];
let changed = 0;
for (const page of pages) {
  const file = join(ROOT, page);
  let html = readFileSync(file, 'utf8');
  const before = html;
  const isDoc = FLAT.some(x => x.url === page);
  const isTop = TOP_PAGES.includes(page);
  if (!isDoc && !isTop) { console.warn(`skip (not in manifest): ${page}`); continue; }

  html = replaceBlock(html, '<header class="topbar"', '</header>', topbar(page), 'topbar', page);
  // 404.html deliberately carries no footer (a dead end should stay a dead end); everything else does.
  if (html.includes('<footer class="footer">')) html = replaceBlock(html, '<footer class="footer">', '</footer>', footer(page), 'footer', page);

  if (isDoc) {
    const entry = FLAT.find(x => x.url === page);
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(entry.title)} — StarNet Docs</title>`);
    if (entry.kind !== 'Overview') html = html.replace(/<h1[^>]*>[\s\S]*?<\/h1>/, `<h1>${esc(entry.title)}</h1>`);
    if (page === 'docs/index.html') html = replaceBlock(html, '<!-- docs-directory -->', '<!-- /docs-directory -->', directory(), 'directory', page);
    html = html.replace(/<main class="docs-main"[^>]*>/, '<main class="docs-main" id="main-content" tabindex="-1">');
    html = anchorHeadings(html);
    html = replaceBlock(html, '<aside class="docs-side"', '</aside>', sidebar(page), 'sidebar', page);
    // pager: replace a legacy hand-written .doc-next or a previous .doc-pager, else insert before </main>
    if (html.includes('<div class="doc-next">')) html = replaceBlock(html, '<div class="doc-next">', '</div>', pager(page), 'doc-next', page);
    else if (html.includes('<nav class="doc-pager"')) html = replaceBlock(html, '<nav class="doc-pager"', '</nav>', pager(page), 'doc-pager', page);
    else if (pager(page)) html = html.replace('  </main>', pager(page) + '\n  </main>');
    // body data + docs.js + search index (network-free)
    const depth = page.split('/').length - 1;
    const up = '../'.repeat(depth - 1);                         // docs/x → '', docs/guides/x → '../'
    html = html.replace(/<body[^>]*>/, `<body class="docs-page${entry.kind === 'Overview' ? ' docs-overview' : ''}" data-group="${esc(entry.group)}" data-group-id="${entry.groupId}" data-kind="${entry.kind}" data-title="${esc(entry.title)}">`);
    html = html.replace(/\n<a class="skip-link"[^>]*>[^<]*<\/a>/g, '');
    html = html.replace(/(<body[^>]*>)/, '$1\n<a class="skip-link" href="#main-content">Skip to content</a>');
    html = html.replace(/\n<script src="[^"]*(?:search-index|search|docs)\.js[^"]*"><\/script>/g, '');
    html = html.replace('</body>', `<script src="${up}search-index.js?v=${V}"></script>\n<script src="${up}search.js?v=${V}"></script>\n<script src="${up}docs.js?v=${V}"></script>\n</body>`);
    // stylesheet cache-bust
    html = html.replace(/(href="(?:\.\.\/)?(?:docs\.css|guides\.css))\?v=[^"]*"/g, `$1?v=${V}"`);
    // search index entry
    const main = html.slice(html.indexOf('<main class="docs-main"'), html.indexOf('</main>'));
    const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    const heads = [...main.matchAll(/<h[23][^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>/g)].map(m => ({ id: m[1], t: textOf(m[2]).replace(/^\d+[.\s]*/, '') }));
    const sections = [...main.matchAll(/<h[23][^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h[23]>([\s\S]*?)(?=<h[23]\b|<nav class="doc-pager"|$)/g)].map(m => ({ id: m[1], t: textOf(m[2]).replace(/^\d+[.\s]*/, ''), b: textOf(m[3]).slice(0, 2400) }));
    index.push({ u: page.replace(/^docs\//, ''), t: entry.title, g: entry.group, k: entry.kind, d: textOf(desc), h: heads, s: sections });
  } else {
    html = html.replace(/(href="(?:\.\.\/)?(?:styles\.css|docs\/docs\.css|\/styles\.css))(?:\?v=[^"]*)?"/, `$1?v=${V}"`);
    if (LOADS_SITE_JS.includes(page)) {
      html = html.replace(/(<span (?:id="ver-badge"|class="ver")>)v[\d.]+(<\/span>)/g, `$1v${FALLBACK_RELEASE}$2`);
      html = html.replace(/(src="site\.js\?v=)[^"]+/, `$1${V}`);
    }
  }
  if (html !== before) {
    changed++;
    if (!CHECK) writeFileSync(file, html);
    else console.log(`would change: ${page}`);
  }
}

// search index (docs-relative urls; loaded by docs pages only)
const idxJs = `/* generated by scripts/website-shell.mjs — do not edit */\nwindow.SN_DOCS_INDEX=${JSON.stringify(index)};\n`;
const idxPath = join(ROOT, 'docs', 'search-index.js');
let idxOld = ''; try { idxOld = readFileSync(idxPath, 'utf8'); } catch {}
if (idxOld !== idxJs) { changed++; if (!CHECK) writeFileSync(idxPath, idxJs); else console.log('would change: docs/search-index.js'); }

// sitemap
const smPages = pages.filter(p => (FLAT.some(x => x.url === p) || TOP_PAGES.includes(p)) && p !== '404.html' && !posix.basename(p).startsWith('_'));
const sm = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  smPages.map(p => `  <url><loc>${ORIGIN}/${p === 'index.html' ? '' : p}</loc></url>`).join('\n') + '\n</urlset>\n';
const smPath = join(ROOT, 'sitemap.xml');
if (readFileSync(smPath, 'utf8') !== sm) { changed++; if (!CHECK) writeFileSync(smPath, sm); else console.log('would change: sitemap.xml'); }

console.log(`${CHECK ? 'check' : 'stamp'}: ${pages.length} pages, ${changed} ${CHECK ? 'would change' : 'written'}, ${index.length} indexed`);
if (CHECK && changed) process.exit(1);
