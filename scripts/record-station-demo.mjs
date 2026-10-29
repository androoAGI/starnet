#!/usr/bin/env node
/* record-station-demo.mjs — record the homepage "watch it work" chapters from the REAL renderer.
 *
 *   node scripts/stage-website-deploy.mjs        (once — builds website-deploy/ with app/embed.htm)
 *   node scripts/record-station-demo.mjs [chapter ...]
 *
 * WHY RECORDINGS: the homepage used to boot the whole desktop app in an iframe (hundreds of scripts and
 * tens of MB of art) before a visitor saw anything move. Each chapter is now played ONCE, here, through
 * that same app (website/app booted from the crew save in app/demo-boot.js) by emitting the harness's own
 * bus events from website/station-chapters.js, and the station canvas is recorded. The homepage plays
 * the clips and prints the same chapter's trace lines on the video clock — one script, two players.
 *
 * Re-record whenever the renderer, the crew scene or a chapter changes. Needs a GPU (ANGLE/D3D11): the
 * software rasterizer draws the station ~10x slower and the clip would stutter.
 * Output: website/assets/station/<chapter>.mp4 (H.264, faststart) + .webm (VP9 twin) + .jpg (poster frame).
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { connectCDP, sleep } from './lib/cdp.mjs';
import { allocatePort } from '../test/helpers/ports.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGED = join(REPO, 'website-deploy');
const OUT = join(REPO, 'website', 'assets', 'station');
const CHAPTERS_JS = join(REPO, 'website', 'station-chapters.js');
const VIEW = { w: 1300, h: 1066 };
const CROP = { x: 208, y: 182, w: 890, h: 702 };     // the room inside the 1300x1066 camera (station-demo.js shows this window)
const CHROMES = [process.env.STARNET_REC_CHROME,
  'C:/Users/andro/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  'C:/Users/andro/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);

if (!existsSync(join(STAGED, 'app', 'embed.htm'))) { console.error('website-deploy/app/embed.htm missing — run node scripts/stage-website-deploy.mjs first'); process.exit(1); }
const chrome = CHROMES.find(existsSync);
if (!chrome) { console.error('no Chrome found (set STARNET_REC_CHROME)'); process.exit(1); }
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('ffmpeg not on PATH'); process.exit(1); }

const chaptersSrc = readFileSync(CHAPTERS_JS, 'utf8');
const C = (() => { const g = {}; new Function('window', chaptersSrc)(g); return g.StarnetChapters; })();
const want = process.argv.slice(2).length ? process.argv.slice(2) : C.ORDER;
for (const k of want) if (!C.CH[k]) { console.error('unknown chapter ' + k); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = join(STAGED, p);
  if (!f.startsWith(STAGED) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
// the CDP port comes from the OS (test/helpers/ports.js), not 9600 + random: a random pick can be reserved or taken
const port = srv.address().port, cdpPort = await allocatePort();
const prof = join(tmpdir(), 'starnet-rec-' + Date.now());
const proc = spawn(chrome, ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${cdpPort}`, `--window-size=${VIEW.w},${VIEW.h}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });

async function evaluate(cdp, expression, timeout = 120000) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

let code = 0;
try {
  await sleep(1500);
  const cdp = await connectCDP(cdpPort);
  cdp.timeoutMs = 180000;
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
  for (const key of want) {
    const ch = C.CH[key];
    // a fresh boot per chapter: no crate, run or bubble from the previous chapter leaks into this clip
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/app/embed.htm?rec=${key}` });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { await sleep(400); try { up = await evaluate(cdp, '!!(window.StarnetDemoBridge && StarnetDemoBridge.crew() >= 4)'); } catch (_) {} }
    if (!up) throw new Error('station never came up for ' + key);
    await sleep(3500);                                   // crew skins load lazily; let every body wear its real sprite
    const gpu = await evaluate(cdp, 'World.renderPace().drawCostMs');
    await evaluate(cdp, chaptersSrc + ';1');
    const durMs = C.LEAD_MS + ch.len + C.TAIL_MS;
    const b64 = await evaluate(cdp, `(async () => {
      const cv = document.getElementById('stage');
      const rec = new MediaRecorder(cv.captureStream(30), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 16e6 });
      const parts = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start(500);
      const stop = StarnetChapters.perform(${JSON.stringify(key)}, (n, p) => StarnetDemoBridge.emit(n, p));
      await new Promise((r) => setTimeout(r, ${durMs}));
      rec.stop(); await done; stop();
      const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    })()`, durMs + 60000);
    const raw = join(tmpdir(), `starnet-rec-${key}.webm`);
    writeFileSync(raw, Buffer.from(b64, 'base64'));
    const mp4 = join(OUT, key + '.mp4'), jpg = join(OUT, key + '.jpg');
    const crop = `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y}`;
    // the webm from MediaRecorder carries no duration/keyframe index: re-time it to a constant 30 fps
    let r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', `${crop},fps=30,scale=890:-2:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation',
      '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg encode failed for ' + key);
    // VP9 twin for browsers built without H.264 (open-source Chromium builds); the player picks what plays
    const webm = join(OUT, key + '.webm');
    // encoded from the finished H.264 (the raw capture's film grain costs VP9 ~2.5x the bytes for no visible gain)
    r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-c:v', 'libvpx-vp9', '-crf', '42', '-b:v', '0',
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-an', webm], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg webm failed for ' + key);
    r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.2', '-i', mp4, '-frames:v', '1', '-q:v', '4', jpg], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg poster failed for ' + key);
    rmSync(raw, { force: true });
    console.log(`${key}: ${(statSync(mp4).size / 1024).toFixed(0)} KB mp4, ${(statSync(webm).size / 1024).toFixed(0)} KB webm, ${(durMs / 1000).toFixed(1)} s, draw ${Number(gpu).toFixed(1)} ms`);
  }
} catch (e) { console.error(e.message || e); code = 1; }
finally { proc.kill(); srv.close(); await sleep(600); try { rmSync(prof, { recursive: true, force: true }); } catch (_) {} }
process.exit(code);
