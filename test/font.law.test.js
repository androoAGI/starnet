'use strict';

/* THE STARNET FONT LAW.
 *
 * VT323 is the station's face. Everything — COMMS, the panels, the canvas, the baked floor
 * plates — is drawn in it, and a fallback face is never acceptable: the pixel grade IS the
 * product's look, and Courier New in its place reads as a different application.
 *
 * The 2026-08-06 regression: index.html loaded VT323 from Google Fonts *in addition* to the
 * local @font-face. That link registered three more 'VT323' faces whose unicode-ranges covered
 * Latin — every glyph the station renders — each carrying `font-display: swap`, which means
 * "paint the fallback NOW and swap the real face in when the network answers". A slow, blocked,
 * or offline load therefore painted the whole app in Courier New, and a StationBake that ran in
 * that window baked fallback text permanently into the floor.
 *
 * This suite is the standing guard. It fails if any of the paths back to a non-VT323 glyph
 * reopen: a remote font source, a `swap` display, a font-family or ctx.font that omits VT323,
 * a CSP that re-permits font CDNs, or a missing/empty local woff2.
 */

const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const root = path.resolve(__dirname, '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const stripCssComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ---------- 1. the face itself ships, locally, and is not a stub ---------- */
const woff2 = path.join(root, 'frontend', 'assets', 'fonts', 'vt323.woff2');
A.ok(fs.existsSync(woff2), 'the VT323 woff2 ships in frontend/assets/fonts/');
A.ok(fs.statSync(woff2).size > 8000, 'the shipped VT323 woff2 is a real face, not a stub');

/* ---------- 2. exactly one @font-face, local, and `block` not `swap` ---------- */
const style = rd('frontend/css/style.css');
const faces = stripCssComments(style).match(/@font-face\s*\{[^}]*\}/g) || [];
A.eq(faces.length, 1, 'style.css declares exactly one @font-face');
const face = faces[0];
A.ok(/font-family:\s*'?VT323'?/.test(face), 'the @font-face is VT323');
A.ok(/url\(\s*'\.\.\/assets\/fonts\/vt323\.woff2'\s*\)/.test(face), 'VT323 loads from the local bundled woff2');
A.ok(!/https?:/.test(face), 'the VT323 @font-face has no network source');
A.ok(/font-display:\s*block/.test(face), 'VT323 uses font-display:block — never `swap`, which licenses a fallback repaint');

/* ---------- 3. no remote font anywhere in the shipped HTML ---------- */
for (const html of ['frontend/index.html', 'website/app/index.html']) {
  if (!fs.existsSync(path.join(root, html))) continue;
  const src = rd(html);
  A.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src), html + ' loads no font from a CDN');
  A.ok(!/<link[^>]+href=["']https?:\/\/[^"']*\.(?:woff2?|ttf|otf)/i.test(src), html + ' links no remote font file');
}

/* ---------- 4. every CSS font-family names VT323 (or inherits one that does) ---------- */
for (const f of fs.readdirSync(path.join(root, 'frontend', 'css')).filter(n => n.endsWith('.css'))) {
  const decls = stripCssComments(rd('frontend/css/' + f)).match(/font-family\s*:[^;}]+/g) || [];
  for (const d of decls) {
    A.ok(/VT323|inherit/i.test(d), 'frontend/css/' + f + ' — every font-family is VT323 or inherit, got: ' + d.trim());
  }
}

/* ---------- 5. every canvas font names VT323 ----------
   ctx.font has no font-display and no repaint-on-load: whatever is resolved at draw time is
   what the user keeps. A generic family in that string is a silent fallback waiting to happen. */
const jsFiles = [];
for (const dir of ['frontend/app', 'frontend/js']) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const n of fs.readdirSync(abs)) if (n.endsWith('.js')) jsFiles.push(dir + '/' + n);
}
for (const f of jsFiles) {
  const src = stripJsComments(rd(f));
  // single-line only: a string literal never spans a newline, and letting [\s\S] cross one
  // mis-pairs quotes across statements and reports a phantom fallback.
  const literals = src.match(/(['"])(?:(?!\1)[^\n])*?monospace(?:(?!\1)[^\n])*?\1/g) || [];
  for (const lit of literals) {
    A.ok(/VT323/.test(lit), f + ' — a canvas/inline font string falls back without naming VT323: ' + lit);
  }
}

/* ---------- 6. the desktop shell cannot reach a font CDN, and serves the real frontend ---------- */
const tauri = JSON.parse(rd('src-tauri/tauri.conf.json'));
const csp = (tauri.app && tauri.app.security && tauri.app.security.csp) || '';
A.ok(csp, 'the desktop shell declares a CSP');
A.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(csp), 'the desktop CSP permits no font CDN — a regression fails loudly instead of silently going to the network');
// Application code stays embedded; offline fonts are shared with the packaged browser mirror.
A.eq(tauri.build.frontendDist, 'frontend-embed', 'the desktop embeds the staged application code');
A.eq(tauri.bundle.resources['frontend-dist'], 'frontend', 'offline fonts remain in the packaged media resource');
A.ok(/"desktop:build":\s*"[^"]*stage-frontend-dist\.mjs[^"]*tauri build"/.test(rd('package.json')), 'desktop:build stages the frontend before tauri build, so the embedded copy is never stale');

A.report('font.law.test');
