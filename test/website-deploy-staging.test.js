'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./_assert.js');

const root = path.join(__dirname, '..');
const staged = path.join(root, 'website-deploy');
const run = spawnSync(process.execPath, ['scripts/stage-website-deploy.mjs'], { cwd: root, encoding: 'utf8' });
A.eq(run.status, 0, 'guarded website staging completes');
// The pricing page ships EXACTLY when the release flag says so — the staging script follows
// website/site.js PRICING_LIVE, and this guard follows the same single source of truth, so the
// gate is green in both the held and the launched state but never in a mixed one.
const PRICING_LIVE = /var PRICING_LIVE = true;/.test(fs.readFileSync(path.join(root, 'website', 'site.js'), 'utf8'));
A.eq(fs.existsSync(path.join(staged, 'pricing.html')), PRICING_LIVE,
  PRICING_LIVE ? 'launched pricing page ships in the deploy artifact' : 'held-back pricing page is absent from deploy artifact');
A.ok(fs.existsSync(path.join(staged, '404.html')), 'staged artifact carries a real not-found page');
A.eq(fs.existsSync(path.join(staged, 'app', 'assets', 'sprites', '_assembly')), false, 'sprite assembly sources are absent from deploy artifact');
A.ok(fs.existsSync(path.join(staged, 'app', 'index.html')), 'staged artifact retains the embedded app');
A.ok(fs.existsSync(path.join(staged, 'app/assets/industrial/calibration/crate.png')), 'required calibration texture ships so the remaster remains enabled');
A.ok(fs.existsSync(path.join(staged, 'app/assets/industrial/projection-correction/manifest.json')), 'default remastered prop manifest ships');
for (const folder of ['batch02', 'batch03', 'props-v2', 'props-v3', 'camera-audit']) {
  A.eq(fs.existsSync(path.join(staged, 'app/assets/industrial', folder)), false, 'review art is excluded from website upload: ' + folder);
}
const stagedApp = fs.readFileSync(path.join(staged, 'app', 'index.html'));
const stagedEmbed = fs.readFileSync(path.join(staged, 'app', 'embed.htm'));
A.ok(stagedEmbed.equals(stagedApp), 'staged artifact carries a unique dashboard-upload-safe embed entry');
const stagedSpecialties = path.join(staged, 'shared', 'specialties.js');
A.ok(fs.existsSync(stagedSpecialties), 'staged artifact carries the shared specialty catalog required by the embedded station');
A.ok(fs.readFileSync(stagedSpecialties).equals(fs.readFileSync(path.join(root, 'shared', 'specialties.js'))),
  'the staged shared specialty catalog is byte-identical to backend/frontend authority');

// 2026-09-03: the GitHub Pages workflow was removed — Pages was never enabled and it failed on
// every trunk push since 2026-08-11. The real deploy is 'wrangler pages deploy website-deploy' by
// hand, so the guard is the staging script itself (asserted above), not a workflow file.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
A.eq(pkg.scripts['website:stage'], 'node scripts/stage-website-deploy.mjs', 'staging has one package entry point');

const home = fs.readFileSync(path.join(root, 'website', 'index.html'), 'utf8');
const pricingTags = home.match(/<[^>]+data-pricing-link[^>]*>/g) || [];
A.ok(pricingTags.length > 0 && pricingTags.every(tag => /\shidden(?:\s|>)/.test(tag)), 'held-back pricing is hidden in raw HTML before JavaScript runs');
A.ok(/rel="canonical" href="https:\/\/starnetos\.com\/"/.test(home), 'homepage publishes its canonical URL');
A.ok(/og-card\.png\?v=\d+/.test(home), 'social card URL is cache-busted for share crawlers');
A.ok(!/v0\.8\.5/.test(home), 'raw homepage no longer falls back to the obsolete 0.8.5 train');
A.ok(/current source build/.test(home) && /Current stable version/.test(home), 'preview and stable release train are labeled separately');
A.ok(/github\.com\/androoAGI\/starnet\/issues/.test(home), 'community support points at a real public destination');
A.eq(/data-social|discord\.gg|x\.com\/yourhandle/.test(home), false, 'homepage carries no dormant or invented social links');
const site = fs.readFileSync(path.join(root, 'website', 'site.js'), 'utf8');
A.ok(/el\.hidden = !PRICING_LIVE/.test(site), 'the release flag explicitly reveals or hides every pricing fragment');
A.eq(/RELEASES_PAGE/.test(site), false, 'unused release-page alias is gone');
const fallback = /FALLBACK_VERSION = '(\d+\.\d+\.\d+)'/.exec(site);
A.ok(fallback, 'offline release fallback is an explicit public version');
A.ok(fallback && home.includes('<span id="ver-badge">v' + fallback[1] + '</span>') && home.includes('<span class="ver">v' + fallback[1] + '</span>'), 'raw homepage release labels agree with the offline fallback');

const privacy = fs.readFileSync(path.join(root, 'website', 'legal', 'privacy.html'), 'utf8');
A.ok(/Edge Read Aloud/.test(privacy) && !/Live Voice works with no network at all/.test(privacy), 'public voice disclosure names the network fallback without an absolute offline claim');
const connectors = fs.readFileSync(path.join(root, 'website', 'docs', 'connectors.html'), 'utf8');
const toolsets = fs.readFileSync(path.join(root, 'sidecar', 'capability', 'toolsets.js'), 'utf8');
const workbench = 'Run shell commands and verify code — the code-execution bench.';
A.ok(connectors.includes(workbench) && toolsets.includes(workbench), 'public and in-app workbench descriptions match actual granted tools');
A.ok(/Local <code>stdio<\/code> servers[\s\S]*SAFE CELL/.test(connectors) && !/stdio<\/code> servers[\s\S]{0,120}<b>not<\/b> supported/.test(connectors), 'connector docs describe the isolated Safe Cell stdio path');
const providers = fs.readFileSync(path.join(root, 'website', 'docs', 'providers.html'), 'utf8');
A.ok(/ChatGPT \(Codex\)/.test(providers) && /Ollama/.test(providers) && /Perplexity/.test(providers), 'provider docs name the current first-class roster');
const sidecar = fs.readFileSync(path.join(root, 'sidecar', 'index.js'), 'utf8');
A.eq(/function saveConnectorOauth\(/.test(sidecar), false, 'unused connector OAuth persistence wrapper is removed');

A.report('website-deploy-staging.test');
