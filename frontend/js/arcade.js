/* AGENT OS — arcade.js : "BREACH PROTOCOL" — the playable arcade cabinet.
   Clicking an arcade cabinet in the quarters opens a real game: a phosphor
   Space-Invaders descendant where rogue scraper-bots besiege the station and
   the Commander mans the point-defense turret. Renders into a low-res canvas
   inside a prop window (PROPTERM mounts/unmounts it), colors pulled live from
   the active theme so it matches the terminal skin. A top-5 STATION RECORDS board
   persists in localStorage — the house crew hold the seed scores until you take them. */
'use strict';

const ARCADE = (() => {
  const W = 232, H = 290;            // internal phosphor resolution (logical units)
  /* SUPERSAMPLE. The cabinet lives in a ~430px window, so a 232-wide bitmap used to be
     stretched ~1.97x by `width:100%` + image-rendering:pixelated. Sprites survived that
     (they're solid 1px blocks) but the 7-8px VT323 HUD did not: the browser antialiased
     it into grey soup at 8px and then the upscale magnified the soup — SCORE/HI were
     unreadable. Fix: give the canvas S x more device pixels and scale the draw transform,
     so every glyph rasterizes at 16 device px while ALL draw code keeps logical coords. */
  const S = 2;
  const HI_KEY = 'starnet_arcade_hi';
  const SCORES_KEY = 'starnet_arcade_scores';
  let cv = null, ctx = null, raf = 0, mounted = false, hidden = false;
  let last = 0, acc = 0, frameN = 0;
  let keys = {}, kd = null, ku = null;
  let C = {};                        // theme colors, sampled at mount + refreshed
  let st = null;                     // game state

  /* ---------- sprites (binary rows) ---------- */
  const SPR = {
    // SPAMBOT — bottom rows, 10 pts
    bot: [[
      '000011110000', '011111111110', '111111111111', '111001100111',
      '111111111111', '000110011000', '001101101100', '110000000011'
    ], [
      '000011110000', '011111111110', '111111111111', '111001100111',
      '111111111111', '001101101100', '011000000110', '000110011000'
    ]],
    // SCRAPER — middle rows, 20 pts
    scraper: [[
      '00100000100', '00010001000', '00111111100', '01101110110',
      '11111111111', '10111111101', '10100000101', '00011011000'
    ], [
      '00100000100', '10010001001', '10111111101', '11101110111',
      '11111111111', '00111111100', '00100000100', '01000000010'
    ]],
    // CLAW ELITE — top row, 30 pts
    claw: [[
      '00011000', '00111100', '01111110', '11011011',
      '11111111', '00100100', '01011010', '10100101'
    ], [
      '00011000', '00111100', '01111110', '11011011',
      '11111111', '01011010', '10000001', '01000010'
    ]],
    // ROGUE UPLINK — bonus saucer
    saucer: [[
      '0000111111110000', '0011111111111100', '0111111111111110',
      '1101101101101101', '1111111111111111', '0011100110011100', '0000100000010000'
    ]],
    // the Commander's turret (ULTRON pattern head — eyes drawn separately)
    turret: [[
      '0000001000000', '0000011100000', '0000011100000', '0111111111110',
      '1111111111111', '1111111111111', '1111111111111', '1111111111111'
    ]]
  };
  const ROWTYPE = ['claw', 'scraper', 'scraper', 'bot', 'bot'];
  const ROWPTS = [30, 20, 20, 10, 10];

  /* ---------- ULTRON commentary ---------- */
  const Q = {
    attract: [
      'ULTRON> Hostile botnet detected on approach vector.',
      'ULTRON> The turret is calibrated. You are not.',
      'ULTRON> VYBES holds the record. This bothers me.',
      'ULTRON> Token accepted. Try to be efficient, Commander.'
    ],
    wave: [
      'ULTRON> Wave purged. They never learn.',
      'ULTRON> Acceptable. The next batch is angrier.',
      'ULTRON> Hostiles deleted. Logging it to the archives.',
      'ULTRON> Clean sweep. I almost felt something.'
    ],
    death: [
      'ULTRON> Turret rebuilt. Try not to waste this one.',
      'ULTRON> Fabricating replacement. Hold position.',
      'ULTRON> That was avoidable. Re-armed.'
    ],
    over: [
      'ULTRON> Simulation terminated. The crew will hear about this.',
      'ULTRON> Recorded. Filed. Judged.',
      'ULTRON> The station survived. You did not.'
    ],
    hi: 'ULTRON> New station record. VYBES is going to sulk.'
  };
  /* Never let the attract loop claim VYBES holds a record the Commander already took. */
  function attractQuip(board) {
    const top = board && board[0];
    return U.pick(top && top.name !== 'VYBES' ? Q.attract.filter(q => q.indexOf('VYBES') < 0) : Q.attract);
  }

  /* ---------- score board ----------
     The cabinet keeps a real top-5 ledger, not just a single hi-score: every finished
     (or abandoned) run posts its score + the wave it died on, and the board persists to
     localStorage. The house crew hold the seed records until the Commander takes them. */
  const HOUSE = [
    { name: 'VYBES', score: 2600, wave: 6 },
    { name: 'ATLAS', score: 1840, wave: 5 },
    { name: 'ORACLE', score: 1120, wave: 3 },
    { name: 'PROBE', score: 760, wave: 3 },
    { name: 'RELAY', score: 430, wave: 2 }
  ];
  function loadHi() {
    try {
      const o = JSON.parse(localStorage.getItem(HI_KEY));
      if (o && o.score) return o;
    } catch (e) { }
    return { name: 'VYBES', score: 2600 };
  }
  function saveHi(o) { try { localStorage.setItem(HI_KEY, JSON.stringify(o)); } catch (e) { } }

  function loadScores() {
    try {
      const a = JSON.parse(localStorage.getItem(SCORES_KEY));
      if (Array.isArray(a) && a.length) return a.filter(r => r && r.score >= 0).slice(0, 5);
    } catch (e) { }
    // first run on this station — fold any legacy single hi-score into the seeded board
    const hi = loadHi(), b = HOUSE.map(r => ({ ...r }));
    if (hi.score && !b.some(r => r.name === hi.name && r.score === hi.score)) b.push({ name: hi.name, score: hi.score, wave: 0 });
    return b.sort((x, y) => y.score - x.score).slice(0, 5);
  }
  function saveScores(a) {
    try { localStorage.setItem(SCORES_KEY, JSON.stringify(a.map(({ name, score, wave }) => ({ name, score, wave })))); } catch (e) { }
    saveHi({ name: a[0].name, score: a[0].score });   // keep the legacy key in step
  }
  /* Bank THIS run onto the board. Rebuilt every time from st.base — the pre-run snapshot —
     so it is idempotent: taking the record mid-run, dying, and closing the window can all
     call it and the run still appears exactly once. */
  function bank() {
    if (!st || st.score <= 0) return;
    const b = st.base.map(r => ({ ...r, me: false }));
    b.push({ name: 'CMDR', score: st.score, wave: st.wave, me: true });
    b.sort((x, y) => y.score - x.score);
    st.board = b.slice(0, 5);
    saveScores(st.board);
  }

  /* ---------- theme colors ---------- */
  function sampleColors() {
    const cs = getComputedStyle(document.body);
    const v = n => (cs.getPropertyValue(n) || '').trim();
    C = {
      ph: v('--ph') || '#ffaa33', bright: v('--ph-bright') || '#ffd9a3',
      dim: v('--ph-dim') || '#b9791c', faint: v('--ph-faint') || '#1e1404',
      red: '#ff4a3d', cyan: '#2ee6c8'
    };
  }

  /* ---------- shields ---------- */
  function makeBunker(x, y) {
    const w = 24, h = 16, g = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      let s = 1;
      if (yy < 4 && (xx < 4 - yy || xx > 19 + yy)) s = 0;           // sloped shoulders
      if (yy >= 12 && xx >= 8 && xx <= 15) s = 0;                    // arch
      if (yy === 11 && xx >= 9 && xx <= 14) s = 0;
      g[yy * w + xx] = s;
    }
    return { x, y, w, h, g };
  }
  function bunkerHit(px, py, r) {                 // point hit + blast erosion
    for (const b of st.bunkers) {
      const lx = Math.round(px - b.x), ly = Math.round(py - b.y);
      if (lx < 0 || ly < 0 || lx >= b.w || ly >= b.h || !b.g[ly * b.w + lx]) continue;
      for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) {
        if (xx * xx + yy * yy > r * r + 1) continue;
        const ex = lx + xx, ey = ly + yy;
        if (ex >= 0 && ey >= 0 && ex < b.w && ey < b.h && U.chance(0.82)) b.g[ey * b.w + ex] = 0;
      }
      return true;
    }
    return false;
  }
  function bunkerClearRect(x0, y0, x1, y1) {      // invaders plow through shields
    for (const b of st.bunkers)
      for (let yy = 0; yy < b.h; yy++) for (let xx = 0; xx < b.w; xx++)
        if (b.x + xx >= x0 && b.x + xx <= x1 && b.y + yy >= y0 && b.y + yy <= y1) b.g[yy * b.w + xx] = 0;
  }

  /* ---------- game state ---------- */
  function newWave() {
    st.inv = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 8; c++) {
      const spr = SPR[ROWTYPE[r]][0];
      st.inv.push({
        c, r, type: ROWTYPE[r], pts: ROWPTS[r], w: spr[0].length, h: spr.length,
        x: 34 + c * 22, y: 38 + r * 16 + Math.min(40, (st.wave - 1) * 6), alive: true
      });
    }
    st.dir = 1; st.stepT = 0; st.frame = 0; st.bombs = []; st.pb = null;
    st.saucer = null; st.saucerT = U.irnd(700, 1300); st.marchN = 0;
  }
  function reset(mode) {
    const board = loadScores();
    st = {
      mode, t: 0, score: 0, lives: 3, wave: 1, board, base: board, hi: { ...board[0] }, beatHi: false,
      px: W / 2 - 6, pb: null, bombs: [], inv: [], dir: 1, stepT: 0, frame: 0,
      saucer: null, saucerT: 999, marchN: 0, modeT: 0,
      bunkers: [0.22, 0.5, 0.78].map(f => makeBunker(Math.round(W * f) - 12, H - 66)),
      quip: attractQuip(board), flash: 0
    };
    newWave();
  }
  function startGame() {
    reset('play');
    st.quip = attractQuip(st.board);
    SFX.open();
  }

  /* ---------- audio ---------- */
  const sShoot = () => SFX.tone(900, 0.05, 'square', 0.12);
  const sKill = r => SFX.tone(130 + r * 40, 0.07, 'sawtooth', 0.16);
  const sMarch = n => SFX.tone([92, 84, 76, 68][n % 4], 0.05, 'square', 0.07);
  const sSaucer = () => SFX.tone(440, 0.08, 'triangle', 0.1);

  /* ---------- 60Hz tick ---------- */
  function step() {
    st.t++;
    if (st.flash > 0) st.flash--;
    if (st.mode === 'attract' || st.mode === 'over') {
      if (st.t % 360 === 0) st.quip = st.mode === 'over' ? U.pick(Q.over) : attractQuip(st.board);
      return;
    }
    if (st.mode === 'pause') return;
    if (st.mode === 'dead') {
      if (--st.modeT <= 0) {
        if (st.lives <= 0) { gameOver(); } else { st.mode = 'play'; st.px = W / 2 - 6; st.bombs = []; }
      }
      return;
    }
    if (st.mode === 'wave') {
      if (--st.modeT <= 0) { st.wave++; newWave(); st.mode = 'play'; }
      return;
    }

    /* --- player --- */
    if (keys.l) st.px -= 1.8;
    if (keys.r) st.px += 1.8;
    st.px = U.clamp(st.px, 4, W - 17);
    if (keys.f && !st.pb) { st.pb = { x: st.px + 6, y: H - 32 }; sShoot(); }

    /* --- player bullet --- */
    if (st.pb) {
      st.pb.y -= 5;
      const b = st.pb;
      if (b.y < 14) st.pb = null;
      else if (bunkerHit(b.x, b.y, 2)) st.pb = null;
      else {
        if (st.saucer && b.x >= st.saucer.x && b.x <= st.saucer.x + 16 && b.y >= 24 && b.y <= 31) {
          st.score += st.saucer.pts; st.flash = 4; st.pb = null;
          st.saucer.dead = 20; SFX.notify();
        }
        if (st.pb) for (const v of st.inv) {
          if (!v.alive) continue;
          if (b.x >= v.x && b.x <= v.x + v.w && b.y >= v.y && b.y <= v.y + v.h) {
            v.alive = false; st.score += v.pts; st.pb = null; sKill(v.r);
            break;
          }
        }
        checkHi();
      }
    }

    /* --- invader march --- */
    const alive = st.inv.filter(v => v.alive);
    if (!alive.length) { st.mode = 'wave'; st.modeT = 110; st.quip = U.pick(Q.wave); SFX.level(); return; }
    const interval = Math.max(4, Math.round(38 * (alive.length / 40) * Math.pow(0.92, st.wave - 1)) + 3);
    if (++st.stepT >= interval) {
      st.stepT = 0; st.frame ^= 1; sMarch(st.marchN++);
      let edge = false;
      for (const v of alive) {
        const nx = v.x + st.dir * 4;
        if (nx < 4 || nx + v.w > W - 4) edge = true;
      }
      for (const v of alive) {
        if (edge) v.y += 8; else v.x += st.dir * 4;
        bunkerClearRect(v.x, v.y, v.x + v.w, v.y + v.h);
        if (v.y + v.h >= H - 28) { st.lives = 0; gameOver(); return; }  // breach
      }
      if (edge) st.dir *= -1;
      // bombs drop from bottom-most invader of a random occupied column
      if (st.bombs.length < 2 + Math.min(3, st.wave) && U.chance(0.45 + st.wave * 0.04)) {
        const cols = {};
        alive.forEach(v => { if (!cols[v.c] || v.y > cols[v.c].y) cols[v.c] = v; });
        const src = U.pick(Object.values(cols));
        st.bombs.push({ x: src.x + src.w / 2, y: src.y + src.h + 1 });
      }
    }

    /* --- bombs --- */
    const bSpd = 1.1 + st.wave * 0.08;
    st.bombs = st.bombs.filter(b => {
      b.y += bSpd;
      if (b.y > H - 12) return false;
      if (bunkerHit(b.x, b.y, 2)) return false;
      if (b.y >= H - 30 && b.y <= H - 22 && b.x >= st.px && b.x <= st.px + 13) { hitPlayer(); return false; }
      return true;
    });

    /* --- saucer --- */
    if (st.saucer) {
      const s = st.saucer;
      if (s.dead) { if (--s.dead <= 0) st.saucer = null; }
      else {
        s.x += s.vx;
        if (st.t % 14 === 0) sSaucer();
        if (s.x < -18 || s.x > W + 2) st.saucer = null;
      }
    } else if (--st.saucerT <= 0) {
      const ltr = U.chance(0.5);
      st.saucer = { x: ltr ? -16 : W, vx: ltr ? 0.9 : -0.9, pts: U.pick([50, 100, 150, 300]), dead: 0 };
      st.saucerT = U.irnd(900, 1600);
    }
  }

  function hitPlayer() {
    st.lives--; st.mode = 'dead'; st.modeT = 70; st.pb = null;
    st.quip = st.lives > 0 ? U.pick(Q.death) : U.pick(Q.over);
    SFX.bad();
  }
  function gameOver() {
    st.mode = 'over'; st.t = 0;
    st.quip = st.beatHi ? Q.hi : U.pick(Q.over);
    bank();                          // the run lands on the board win or lose
    SFX.close();
  }
  function checkHi() {
    if (!st.beatHi && st.score > st.hi.score) {
      st.beatHi = true; st.hi = { name: 'CMDR', score: st.score };
      st.quip = Q.hi; SFX.notify();
      bank();        // persist the record the moment it falls — closing the window can't lose it
      if (typeof SIM !== 'undefined' && SIM.S) SIM.crewChat('VYBES', 'commander just cracked the BREACH PROTOCOL record. respect. rematch after my shift.');
    } else if (st.beatHi) st.hi.score = st.score;
  }

  /* ---------- drawing ---------- */
  function px(x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  function sprite(rows, x, y, col) {
    ctx.fillStyle = col;
    for (let yy = 0; yy < rows.length; yy++) {
      const r = rows[yy];
      for (let xx = 0; xx < r.length; xx++)
        if (r[xx] === '1') ctx.fillRect(Math.round(x) + xx, Math.round(y) + yy, 1, 1);
    }
  }
  function text(s, x, y, col, size, align) {
    ctx.fillStyle = col; ctx.font = (size || 8) + "px 'VT323','Courier New',monospace";
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'top';
    ctx.fillText(s, x, y);
  }

  function draw() {
    ctx.setTransform(S, 0, 0, S, 0, 0);   // every draw below stays in logical (W x H) units
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (st.flash > 0) { ctx.fillStyle = C.faint; ctx.fillRect(0, 0, W, H); }

    /* HUD */
    text('SCORE ' + String(st.score).padStart(5, '0'), 5, 4, C.ph);
    text('HI ' + String(st.hi.score).padStart(5, '0'), W - 5, 4, st.beatHi ? C.bright : C.dim, 8, 'right');   // the holder's name lives on the records board, not the HUD
    px(0, 14, W, 1, C.faint);

    if (st.mode === 'attract' || st.mode === 'over') { drawSplash(); return; }

    /* field */
    if (st.saucer && !st.saucer.dead) sprite(SPR.saucer[0], st.saucer.x, 24, C.cyan);
    if (st.saucer && st.saucer.dead) text('+' + st.saucer.pts, st.saucer.x + 8, 24, C.cyan, 8, 'center');
    for (const v of st.inv) if (v.alive)
      sprite(SPR[v.type][st.frame], v.x, v.y, v.type === 'claw' ? C.red : v.type === 'scraper' ? C.bright : C.ph);
    for (const b of st.bunkers) {
      ctx.fillStyle = C.dim;
      for (let yy = 0; yy < b.h; yy++) for (let xx = 0; xx < b.w; xx++)
        if (b.g[yy * b.w + xx]) ctx.fillRect(b.x + xx, b.y + yy, 1, 1);
    }
    /* turret (blinks out while dead) */
    if (st.mode !== 'dead' || (st.modeT >> 2) & 1) {
      sprite(SPR.turret[0], st.px, H - 30, C.bright);
      px(st.px + 3, H - 25, 2, 1, C.red); px(st.px + 8, H - 25, 2, 1, C.red);  // ULTRON eyes
    }
    if (st.pb) px(st.pb.x, st.pb.y, 1, 4, C.bright);
    for (const b of st.bombs) px(b.x, b.y + ((st.t >> 2) & 1), 1, 4, C.red);
    px(0, H - 20, W, 1, C.dim);

    /* status line */
    let liv = '';
    for (let i = 0; i < st.lives; i++) liv += '▲ ';
    text(liv, 5, H - 15, C.ph);
    text('WAVE ' + st.wave, W - 5, H - 15, C.dim, 8, 'right');
    if (st.mode === 'wave') text('WAVE ' + st.wave + ' PURGED', W / 2, H / 2 - 20, C.bright, 10, 'center');
    if (st.mode === 'pause') text('— PAUSED —', W / 2, H / 2 - 20, C.bright, 10, 'center');
    text(st.quip, W / 2, H - 7, C.dim, 7, 'center');
  }

  /* the station records ledger — the run you just played is the bright row */
  function drawBoard(y0, gap) {
    text('STATION RECORDS', W / 2, y0, C.dim, 8, 'center');
    st.board.forEach((r, i) => {
      const y = y0 + 12 + i * gap;
      const col = r.me ? C.bright : i === 0 ? C.ph : C.dim;
      text((i + 1) + '.', 46, y, col, 8);
      text(r.name, 60, y, col, 8);
      text('WAVE ' + (r.wave || 1), 132, y, col, 8);
      text(String(r.score).padStart(5, '0'), W - 46, y, col, 8, 'right');
    });
  }

  function drawSplash() {
    const blink = (st.t >> 5) & 1;
    const over = st.mode === 'over';
    text('ULTRON COMMAND PRESENTS', W / 2, 36, C.dim, 8, 'center');
    text('BREACH', W / 2, 52, C.bright, 26, 'center');
    text('PROTOCOL', W / 2, 80, C.bright, 26, 'center');
    px(36, 112, W - 72, 1, C.ph);
    if (over) {
      text('GAME OVER', W / 2, 118, C.red, 14, 'center');
      text((st.beatHi ? '★ ' : '') + 'FINAL SCORE ' + String(st.score).padStart(5, '0') + (st.beatHi ? ' ★' : ''),
        W / 2, 136, st.beatHi ? C.bright : C.ph, 9, 'center');
      drawBoard(152, 9);
    } else if (((st.t / 300) | 0) & 1) {
      drawBoard(124, 9);              // attract mode alternates bounty <-> records every 5s
    } else {
      // bounty table
      const rows = [
        ['claw', C.red, 'CLAW ELITE', '30 PTS'],
        ['scraper', C.bright, 'SCRAPER', '20 PTS'],
        ['bot', C.ph, 'SPAMBOT', '10 PTS'],
        ['saucer', C.cyan, 'ROGUE UPLINK', '?? PTS']
      ];
      rows.forEach(([k, col, name, pts], i) => {
        const y = 124 + i * 14;
        sprite(SPR[k][0], 58, y, col);
        text(name, 84, y, C.ph, 8);
        text(pts, 176, y, C.dim, 8, 'right');
      });
    }
    if (blink) text('INSERT TOKEN — SPACE OR CLICK', W / 2, over ? 222 : 198, C.bright, 9, 'center');
    text('◄ ► MOVE   SPACE FIRE   P PAUSE', W / 2, over ? 240 : 216, C.dim, 8, 'center');
    text(st.quip, W / 2, H - 7, C.dim, 7, 'center');
  }

  /* ---------- loop ---------- */
  function loop(ts) {
    if (!mounted) return;
    raf = requestAnimationFrame(loop);
    if (hidden) { last = ts; return; }         // rolled up: no stepping, no drawing, no key hijack
    if (!last) last = ts;
    acc += Math.min(60, ts - last); last = ts;
    while (acc >= 16.67) { step(); acc -= 16.67; }
    if (++frameN % 90 === 0) sampleColors();   // follow live theme switches
    draw();
  }

  /* ---------- input ---------- */
  const KEYMAP = { ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r', ' ': 'f', ArrowUp: 'f', w: 'f', W: 'f' };
  function onKey(down) {
    return ev => {
      if (!mounted || hidden) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (down && (ev.key === 'p' || ev.key === 'P') && (st.mode === 'play' || st.mode === 'pause')) {
        st.mode = st.mode === 'pause' ? 'play' : 'pause'; SFX.click(); ev.preventDefault(); return;
      }
      const k = KEYMAP[ev.key];
      if (!k) return;
      ev.preventDefault();
      keys[k] = down;
      if (down && k === 'f' && (st.mode === 'attract' || st.mode === 'over')) startGame();
    };
  }

  /* ---------- public: window shell + lifecycle ---------- */
  function shell() {
    return '<div class="arc-wrap">' +
      '<canvas id="arc-cv" class="arc-cv" width="' + (W * S) + '" height="' + (H * S) + '"></canvas>' +
      '<div class="arc-foot"><span>CABINET 01 ▪ 1 TOKEN / PLAY</span><span>REV. 2086 ULTRON COMMAND</span></div>' +
      '</div>';
  }
  function mount(body) {
    unmount();                         // safety: never two loops
    cv = body.querySelector('#arc-cv'); if (!cv) return;
    ctx = cv.getContext('2d');
    sampleColors();
    keys = {};
    reset('attract');
    cv.addEventListener('click', () => { if (st.mode === 'attract' || st.mode === 'over') startGame(); });
    kd = onKey(true); ku = onKey(false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    mounted = true; last = 0; acc = 0;
    raf = requestAnimationFrame(loop);
  }
  function unmount() {
    if (!mounted) return;
    mounted = false; hidden = false;
    bank();                          // walking away mid-run still banks the score
    cancelAnimationFrame(raf);
    if (kd) window.removeEventListener('keydown', kd);
    if (ku) window.removeEventListener('keyup', ku);
    kd = ku = null; cv = ctx = null;
  }
  /* roll-up support: freeze the cabinet without tearing it down */
  function pause() { hidden = true; if (st && st.mode === 'play') st.mode = 'pause'; keys = {}; }
  function resume() { hidden = false; last = 0; acc = 0; }

  return { shell, mount, unmount, pause, resume, get hi() { return loadHi(); } };
})();
