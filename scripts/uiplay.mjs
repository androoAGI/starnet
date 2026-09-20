#!/usr/bin/env node
// uiplay.mjs — INTERACTIVE playthrough auditor for StarNet.
//
// Static screenshots (uishoot.mjs) catch how the UI LOOKS at rest. This catches what
// breaks while you actually PLAY: send a chat directive, watch the live run, and detect
// elements/handlers stacking on top of each other in ways that don't make sense —
// the conflicts that only appear mid-interaction. Captures, per tick:
//   - a screenshot frame (so the sequence can be eyeballed)
//   - console errors + uncaught exceptions (CDP)
//   - a STACKING report: visible, clickable elements that overlap a sibling so a click
//     could hit the wrong thing (z-fighting / duplicated beats / panel-over-chat).
//
// Zero-dep (Node 22 global fetch + WebSocket). Assumes/boots a SKYNET_DEV sidecar.
//
// Usage:
//   node scripts/uiplay.mjs --boot
//   SKYNET_SHOT_PORT=8920 node scripts/uiplay.mjs --msg "say PONG only"
import { connectCDP } from './lib/cdp.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { materializeSeedWorkspace, bootSeededSidecar } from './lib/seed.mjs';

const APP_PORT = process.env.SKYNET_SHOT_PORT || '8920';
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const OUT_DIR = process.env.SKYNET_SHOT_DIR || join(process.cwd(), '.uiplay');
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9330);
const WIN = process.env.SKYNET_SHOT_SIZE || '1440,900';
const MSG = (() => { const i = process.argv.indexOf('--msg'); return i > -1 ? process.argv[i + 1] : 'list 3 prime numbers, one per line, then stop'; })();
const TICKS = Number(process.env.SKYNET_PLAY_TICKS || 12);
const TICK_MS = Number(process.env.SKYNET_PLAY_TICK_MS || 1600);

const CHROME = [
  process.env.SKYNET_CHROME,
  'C:/Users/andro/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Users/andro/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((c) => existsSync(c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(cdp, expression) { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; }
async function frame(cdp, name) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT_DIR, name + '.png'), Buffer.from(r.data, 'base64')); }

async function ensureSidecar() {
  const up = async () => { try { const r = await fetch(APP_URL); return r.ok; } catch { return false; } };
  if (await up()) return null;
  if (process.argv.indexOf('--boot') === -1) { console.log(`sidecar down on :${APP_PORT}; pass --boot`); return null; }
  const scratch = join(OUT_DIR, '_seed-workspace');
  materializeSeedWorkspace(scratch);
  console.log(`booting isolated SKYNET_DEV on :${APP_PORT} (workspace=${scratch}) ...`);
  const sc = bootSeededSidecar({ port: APP_PORT, scratchDir: scratch });
  for (let i = 0; i < 60; i++) { if (await up()) return sc; await sleep(500); }
  throw new Error('sidecar failed on :' + APP_PORT);
}

// In-page stacking detector: visible + clickable elements whose boxes overlap a NON-ancestor
// sibling enough that a click is ambiguous. Scoped to the chat column + floating UI so we flag
// real "functions stacking" rather than ordinary nested layout.
// Flags only GENUINE stacking: a floating surface (beat/card/modal/nudge/approval) that
// overlaps another such surface so it visually occludes it. Excludes legitimate normal-flow
// adjacency (e.g. the input row sitting just under the transcript) which is NOT a conflict.
const STACK_FN = `(() => {
  const FLOAT = '.beat,.reply,.card,.mc-card,.approval,.term,.nav-coach,.toast,.curio,.proposal,.turn-in,.popover,.menu';
  const within = (el, id) => !!el.closest('#'+id);
  const floaty = el => el.matches(FLOAT) || (() => { const cs=getComputedStyle(el); return cs.position==='absolute'||cs.position==='fixed'||(parseInt(cs.zIndex)||0) > 0; })();
  const vis = el => { const cs=getComputedStyle(el); if (cs.pointerEvents==='none'||cs.visibility==='hidden'||cs.display==='none'||+cs.opacity===0) return false; const r=el.getBoundingClientRect(); return r.width>8 && r.height>8 && el.offsetParent!==null; };
  // candidate surfaces only — things that should each own their space
  const els = [...new Set([...document.querySelectorAll(FLOAT+',#chat-log > *,.bb-grp')])].filter(e => vis(e) && floaty(e));
  const info = els.map(e => ({ e, r: e.getBoundingClientRect(), z: parseInt(getComputedStyle(e).zIndex)||0, tag: e.tagName.toLowerCase(), cls: (e.className||'').toString().split(/\\s+/).slice(0,2).join('.'), txt: (e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,30) }));
  const area = r => Math.max(0,r.width)*Math.max(0,r.height);
  const inter = (a,b) => { const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)); const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)); return x*y; };
  const hits=[];
  for (let i=0;i<info.length;i++) for (let j=i+1;j<info.length;j++) {
    const a=info[i], b=info[j];
    if (a.e.contains(b.e)||b.e.contains(a.e)) continue;       // nesting is legitimate
    // exclude the known-legit pair: transcript line vs the input row's controls
    if (within(a.e,'chat-log') && within(b.e,'chat-inputrow')) continue;
    if (within(b.e,'chat-log') && within(a.e,'chat-inputrow')) continue;
    const ov=inter(a.r,b.r); if (ov<=0) continue;
    const frac=ov/Math.max(1,Math.min(area(a.r),area(b.r)));
    if (frac<0.45) continue;                                   // must meaningfully occlude
    hits.push({ frac:+frac.toFixed(2), a:{tag:a.tag,cls:a.cls,txt:a.txt,z:a.z}, b:{tag:b.tag,cls:b.cls,txt:b.txt,z:b.z} });
  }
  return { count:hits.length, hits: hits.slice(0,14) };
})()`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ownSidecar = await ensureSidecar();
  if (!CHROME) throw new Error('no chrome; set SKYNET_CHROME');
  const proc = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--hide-scrollbars','--mute-audio',`--remote-debugging-port=${CDP_PORT}`,`--window-size=${WIN}`,`--user-data-dir=${join(OUT_DIR,'_profile')}`,'about:blank'], { stdio: 'ignore' });
  const consoleErrors = [], exceptions = [];
  let cdp;
  try {
    cdp = await connectCDP(CDP_PORT);
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') consoleErrors.push({ type: p.type, text: (p.args||[]).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0,200) }); });
    cdp.on('Runtime.exceptionThrown', (p) => exceptions.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception').slice(0,200)));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(9000);
    console.log(`title=${await ev(cdp,'document.title')} dev=${await ev(cdp,'!!window.__STARNET_DEV__')}`);

    // baseline stacking (before any interaction) + the resting frame
    await frame(cdp, '00-rest');
    const baseStack = await ev(cdp, STACK_FN);
    console.log(`rest stacking: ${baseStack.count} overlap(s)`);

    // SEND a real chat directive: focus the input, set value, dispatch Enter (matches chat.js handler)
    const sent = await ev(cdp, `(() => {
      const inp = document.getElementById('chat-input'); if (!inp) return 'NO_INPUT';
      inp.focus(); inp.value = ${JSON.stringify(MSG)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
      return 'SENT:'+inp.value;
    })()`);
    console.log(`send → ${sent} | msg="${MSG}"`);

    // watch the run: frame + stacking each tick
    const stackTimeline = [];
    for (let t = 0; t < TICKS; t++) {
      await sleep(TICK_MS);
      const tag = String(t + 1).padStart(2, '0');
      await frame(cdp, `${tag}-run`);
      const s = await ev(cdp, STACK_FN);
      const status = await ev(cdp, `(document.getElementById('chat-status')||{}).textContent||''`).catch(() => '');
      stackTimeline.push({ tick: t + 1, overlaps: s.count, status });
      console.log(`  t${tag}: status="${(status||'').trim().slice(0,28)}" stacking=${s.count}`);
    }
    // SCENARIO A — open a dock panel WHILE in COMMS (modal-over-live-chat stacking)
    await ev(cdp, `(() => { const el=[...document.querySelectorAll('.bb')].find(e=>(e.textContent||'').includes('SETTINGS')); el&&el.click(); return !!el; })()`);
    await sleep(1500); await frame(cdp, 'A-panel-over-chat');
    const stackPanel = await ev(cdp, STACK_FN);
    console.log(`A panel-over-chat stacking=${stackPanel.count}`);
    // close it again
    await ev(cdp, `document.querySelectorAll('.term-x').forEach(b=>{try{b.click()}catch{}})`);
    await sleep(700);

    // SCENARIO B — rapid double-send (does a 2nd directive dogpile beats / overlap the first reply?)
    await ev(cdp, `(() => { const i=document.getElementById('chat-input'); if(!i)return; i.focus(); i.value='count from 1 to 3'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true})); })()`);
    await sleep(400);
    await ev(cdp, `(() => { const i=document.getElementById('chat-input'); if(!i)return; i.focus(); i.value='now say DONE'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true})); })()`);
    await sleep(2500); await frame(cdp, 'B-double-send');
    const stackDouble = await ev(cdp, STACK_FN);
    console.log(`B double-send stacking=${stackDouble.count}`);
    await sleep(4000);   // let it settle

    const finalStack = await ev(cdp, STACK_FN);
    await frame(cdp, '99-final');

    const report = { msg: MSG, ticks: TICKS, restStacking: baseStack, runTimeline: stackTimeline, panelOverChat: stackPanel, doubleSend: stackDouble, finalStacking: finalStack, consoleErrors, exceptions };
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== PLAYTHROUGH REPORT ===`);
    console.log(`console errors/warnings: ${consoleErrors.length}`);
    consoleErrors.slice(0, 12).forEach(e => console.log(`  [${e.type}] ${e.text}`));
    console.log(`uncaught exceptions: ${exceptions.length}`);
    exceptions.slice(0, 8).forEach(e => console.log(`  ${e}`));
    const dumpHits = (label, s) => { console.log(`${label}: ${s.count} overlap(s)`); s.hits.forEach(h => console.log(`  ${h.frac} :: ${h.a.cls}|"${h.a.txt}"(z${h.a.z})  ⨯  ${h.b.cls}|"${h.b.txt}"(z${h.b.z})`)); };
    dumpHits('panel-over-chat', stackPanel);
    dumpHits('double-send', stackDouble);
    dumpHits('final', finalStack);
    console.log(`\nframes + report → ${OUT_DIR}`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    proc.kill('SIGKILL');
    if (ownSidecar) { try { ownSidecar.kill('SIGKILL'); } catch {} }
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
