/* node test/remote-view.test.js — the STATION picture a paired phone sees, end to end without a browser:
     · sidecar/remote/view.js      holds the desk's latest still and whether a phone is looking
     · sidecar/remote/portraits.js an agent's own sprite, by the frontend's own skin table
     · host.view / host.portrait through the REAL gateway (validation, chunking, the picture's age)
     · frontend/app/remoteview.js  the desk page draws only while Remote is on and a phone is looking
   The law under test: the phone gets what the desk's renderer drew, stamped with when, and never more. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { makeRemoteView, MAX_BYTES, WANT_MS } = require('../sidecar/remote/view.js');
const { makePortraits } = require('../sidecar/remote/portraits.js');
const { makeRemoteHost } = require('../sidecar/remote/host.js');
const { makeGateway, MAX_CHUNK } = require('../sidecar/remote/gateway.js');

const FRONTEND = path.resolve(__dirname, '..', 'frontend');
const webp = (n) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(Math.max(0, n - 16), 7)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);

(async () => {
  /* ---------- 1. the store ---------- */
  let t = 1000;
  const view = makeRemoteView({ now: () => t });
  A.eq(view.meta(), null, 'a fresh station has no picture');
  A.eq(view.wanted(), false, 'and nobody is looking');
  A.eq(view.put({ w: 800, h: 600, data: Buffer.from('<html>').toString('base64') }).ok, false, 'a non-image is refused whatever it claims to be');
  A.eq(view.put({ mime: 'image/webp', w: 0, h: 600, data: webp(64).toString('base64') }).ok, false, 'a bad size is refused');
  A.eq(view.put({ w: 800, h: 600, data: Buffer.alloc(MAX_BYTES + 1, 1).toString('base64') }).ok, false, 'an oversized picture is refused');
  A.eq(view.meta(), null, 'a refused picture stores nothing');
  const put = view.put({ mime: 'text/html', w: 800, h: 600, data: webp(5000).toString('base64'),
    bodies: [{ agentId: 'forge', x: 100.4, y: 200, name: 'IGNORED', working: true }, { agentId: '../x', x: 1, y: 1 }, { agentId: 'far', x: 9000, y: 1 }, null] });
  A.eq(put.ok, true, 'a real picture is kept');
  const m = view.meta();
  A.eq(m.mime, 'image/webp', 'the type comes from the bytes, never from the claim');
  A.eq(m.at, 1000, 'stamped with when it arrived');
  A.eq(m.bodies, [{ agentId: 'forge', x: 100, y: 200 }], 'crew positions are reduced to id + point; bad ids and off-picture points are dropped');
  A.eq(view.read(0, 100).length, 100, 'reads in chunks');
  A.eq(view.read(4990, 100).length, 10, 'and stops at the end');
  view.want();
  A.eq(view.wanted(), true, 'a phone asked: someone is looking');
  t += WANT_MS + 1;
  A.eq(view.wanted(), false, 'and stops counting once the phone goes quiet');
  A.eq(view.put({ w: 10, h: 10, data: jpeg().toString('base64') }).ok, true, 'a JPEG is accepted too');
  A.eq(view.meta().mime, 'image/jpeg', 'and recognised');

  /* ---------- 2. portraits: the frontend's own skin table ---------- */
  const portraits = makePortraits({ fs, path, frontend: FRONTEND });
  const ctx = { DATA: {} };
  vm.runInNewContext(fs.readFileSync(path.join(FRONTEND, 'app', 'data-shim.js'), 'utf8').replace(/^[\s\S]*?(DATA\.SKINS\s*=)/, '$1'), ctx);
  const skins = Object.keys(ctx.DATA.SKINS);
  A.ok(skins.length >= 40, 'the skin table loaded (' + skins.length + ')');
  A.eq(portraits.skins().slice().sort(), skins.slice().sort(), 'the sidecar reads exactly the skins the renderer knows');
  let missing = [];
  for (const s of skins) {
    const p = portraits.forSkin(s);
    if (!p || p.skin !== s || p.mime !== 'image/png' || Buffer.from(p.data, 'base64').toString('latin1', 1, 4) !== 'PNG') missing.push(s);
  }
  A.eq(missing, [], 'every skin has its sprite');
  const dflt = portraits.forSkin('no-such-skin');
  A.eq(dflt && dflt.skin, ctx.DATA.DEFAULT_SKIN, 'an unknown skin falls back to the default, as the renderer does');
  A.eq(portraits.forSkin('../../secret'), dflt, 'a hostile skin name reads nothing but the default sprite');
  // a device asks for tracks by SET name: every skin maps to a set whose walk/type tracks exist
  let noTracks = [];
  for (const s of skins) { const set = portraits.setFor(s); if (!set || !portraits.framesFor(set + '.walk.east') || !portraits.framesFor(set + '.rot.south')) noTracks.push(s); }
  A.eq(noTracks, [], 'every skin names a sprite set with walk and facing tracks');
  A.eq(portraits.setFor('no-such-skin'), portraits.setFor(ctx.DATA.DEFAULT_SKIN), 'an unknown skin draws with the default skin\'s set');

  /* ---------- 3. the verbs, through the real gateway ---------- */
  let now = 50000;
  const v2 = makeRemoteView({ now: () => now });
  const host = makeRemoteHost({
    now: () => now, newId: () => 'r1', broadcast: () => {},
    roster: () => [{ agentId: 'forge', name: 'FORGE', model: 'm', provider: 'p' }, { agentId: 'scout', name: 'SCOUT' }],
    liveRuns: () => [], transcript: { streams: () => [], history: () => [] },
    view: v2, crewLooks: () => ({ forge: { skin: 'robot', color: '#fff' } }), portrait: (skin) => portraits.forSkin(skin),
    sprites: (key) => portraits.framesFor(key), spriteSet: (skin) => portraits.setFor(skin),
    runHistory: () => history
  });
  let history = [];
  const gw = makeGateway({ host, approvals: { size: () => 0, list: () => [] }, now: () => now });
  const call = (verb, args) => gw.call({ verb, args }, { deviceId: 'd1' });

  const none = await call('view', {});
  A.ok(none.ok && none.data.none === true, 'no picture yet: the phone is told so, not shown a blank');
  A.eq(v2.wanted(), true, 'asking is what tells the desk a phone is looking');

  const big = webp(MAX_CHUNK + 5000);
  v2.put({ w: 1600, h: 1200, data: big.toString('base64'), bodies: [{ agentId: 'forge', x: 10, y: 20 }] });
  now += 7000;
  const c1 = await call('view', {});
  A.eq([c1.data.at, c1.data.now, c1.data.w, c1.data.h, c1.data.mime, c1.data.size], [50000, 57000, 1600, 1200, 'image/webp', big.length], 'the picture comes with its size and BOTH clocks (drawn at, answered at)');
  A.eq(c1.data.bytes, MAX_CHUNK, 'one chunk is at most ' + MAX_CHUNK + ' bytes');
  A.eq(c1.data.eof, false, 'with more to come');
  A.eq(c1.data.bodies, [{ agentId: 'forge', x: 10, y: 20 }], 'the crew positions ride the first chunk');
  const c2 = await call('view', { at: c1.data.at, offset: c1.data.offset + c1.data.bytes });
  A.eq([c2.data.bytes, c2.data.eof, c2.data.bodies], [5000, true, undefined], 'the rest follows');
  A.ok(Buffer.concat([Buffer.from(c1.data.data, 'base64'), Buffer.from(c2.data.data, 'base64')]).equals(big), 'the chunks rebuild the exact picture');
  const same = await call('view', { have: c1.data.at });
  A.eq([same.data.same, same.data.data], [true, undefined], 'a picture the phone already has is not sent again');
  v2.put({ w: 100, h: 100, data: webp(200).toString('base64') });
  const mid = await call('view', { at: c1.data.at, offset: 100 });
  A.eq(mid.data.changed, true, 'a picture replaced mid-read is restarted, never spliced');
  const weird = await call('view', { have: 'x', offset: -5, length: 99999999 });
  A.ok(weird.ok && weird.data.offset === 0 && weird.data.bytes <= MAX_CHUNK, 'junk arguments are clamped');

  const st = await call('status', {});
  A.eq(st.data.agents.map(a => a.skin), ['robot', ''], 'status carries each agent\'s skin (blank when the save has none)');
  A.eq(st.data.agents.map(a => a.sprite), [portraits.setFor('robot'), portraits.setFor('')], 'and the sprite set it draws with (the default set when it has no skin)');
  A.ok(!!(await call('sprite', { key: st.data.agents[0].sprite + '.walk.east' })).ok, 'which a device can fetch tracks from directly');
  const pf = await call('portrait', { agentId: 'forge' });
  A.eq([pf.ok, pf.data.skin, pf.data.mime], [true, 'robot', 'image/png'], 'an agent\'s portrait is its own sprite');
  const ps = await call('portrait', { agentId: 'scout' });
  A.eq(ps.data.skin, ctx.DATA.DEFAULT_SKIN, 'an agent with no skin gets the default sprite');
  A.eq((await call('portrait', { agentId: 'nobody' })).ok, false, 'an unknown agent has no portrait');
  A.eq((await call('portrait', { agentId: '../x' })).ok, false, 'a bad id is refused');

  /* ---------- 4. the desk page: draws only when Remote is on and a phone is looking ---------- */
  let answer = null, stills = 0, still = { canvas: { id: 'c' }, width: 640, height: 480, bodies: [{ agentId: 'forge', x: 1, y: 2 }] };
  const posts = [];
  globalThis.World = { renderStill: (px) => { stills++; A.ok(px >= 800 && px <= 2400, 'asks for a still of a sane size (' + px + ')'); return still; } };
  globalThis.fetch = async (url, o) => {
    if (o && o.method === 'POST') { posts.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({ ok: true }) }; }
    return answer === null ? { ok: false, json: async () => null } : { ok: true, json: async () => answer };
  };
  const { RemoteView } = require('../frontend/app/remoteview.js');
  const I = RemoteView._internals;
  I.encode = async (canvas) => ({ mime: 'image/webp', data: 'QUJD', canvas });

  answer = { ok: true, enabled: false, want: false, at: null };
  A.eq(await I.step(), I.IDLE_MS, 'Remote off: look again slowly');
  A.eq([stills, posts.length], [0, 0], 'and draw nothing');

  answer = { ok: true, enabled: true, want: false, at: null };
  A.eq(await I.step(), I.WATCH_MS, 'Remote on, nobody looking');
  A.eq([stills, posts.length], [1, 1], 'one picture so a phone that opens later has something');
  A.eq(posts[0].url, '/api/remote/view', 'handed to the sidecar');
  A.eq([posts[0].body.mime, posts[0].body.w, posts[0].body.h, posts[0].body.data, posts[0].body.bodies.length], ['image/webp', 640, 480, 'QUJD', 1], 'with its size and the crew positions');
  answer = { ok: true, enabled: true, want: false, at: 123 };
  await I.step(); await I.step();
  A.eq(stills, 1, 'and then no more while nobody is looking');

  answer = { ok: true, enabled: true, want: true, at: 123 };
  A.eq(await I.step(), I.LIVE_MS, 'a phone is looking: redraw on the live cadence');
  await I.step();
  A.eq([stills, posts.length], [3, 3], 'a fresh picture every pass while it looks');

  still = null;
  await I.step();
  A.eq(posts.length, 3, 'no honest picture (no bake yet, the awakening playing): nothing is sent');
  still = { canvas: {}, width: 1, height: 1, bodies: [] };
  I.encode = async () => null;
  await I.step();
  A.eq(posts.length, 3, 'an encode that fails sends nothing');

  answer = { ok: true, enabled: true, want: false, at: null };
  I.encode = async () => ({ mime: 'image/jpeg', data: 'QQ==' });
  await I.step();
  A.eq(posts.length, 4, 'a station that lost its picture (restart) gets a new one without a phone asking');

  // an unchanged room says "same" — but a sidecar that no longer HOLDS the picture (restart) answers 409, and the page
  // must then send the full still instead of re-posting "same" forever (sweep 2026-10-01)
  {
    const realFetch = globalThis.fetch; let held = true; const sent = [];
    globalThis.fetch = async (url, o) => {
      if (o && o.method === 'POST') { const b = JSON.parse(o.body); sent.push(b.same ? 'same' : 'full'); return { ok: !b.same || held, json: async () => ({ ok: !b.same || held }) }; }
      return { ok: true, json: async () => ({ ok: true, enabled: true, want: true, at: 1 }) };
    };
    still = { canvas: {}, width: 2, height: 2, scale: 1, bodies: [] };
    I.encode = async () => ({ mime: 'image/webp', data: 'U0FNRQ==' });
    await I.step(); await I.step();
    A.eq(sent, ['full', 'same'], 'an unchanged room is only confirmed as the same');
    held = false; sent.length = 0;
    await I.step();
    A.eq(sent, ['same', 'full'], 'a station that lost the picture (409 on "same") gets the full still right away');
    globalThis.fetch = realFetch;
  }

  answer = null;
  A.eq(await I.step(), I.IDLE_MS, 'an unreachable station: nothing drawn, nothing thrown');
  A.eq(posts.length, 4, 'and nothing sent');

  /* ---------- 5. the live crew: a crew-free room + the crew stream + their sprite drawings ---------- */
  const v3 = makeRemoteView({ now: () => now });
  A.eq(v3.putCrew([{ agentId: 'forge', key: 'approved_robot.walk.south', idx: 1, x: 1, y: 1, w: 5, h: 9 }]).ok, false, 'no crew positions before there is a room to put them in');
  v3.put({ w: 200, h: 100, data: webp(300).toString('base64'), crewFree: true });
  A.eq(v3.meta().crewFree, true, 'a still drawn without the crew says so');
  const cr = v3.putCrew([
    { agentId: 'forge', key: 'approved_robot.walk.south', idx: 3, x: 10.44, y: 20, w: 6, h: 18, walking: true, working: 'yes' },
    { agentId: 'bad id!', key: 'approved_robot.rot.south', idx: 0, x: 1, y: 1, w: 1, h: 1 },
    { agentId: 'scout', key: '../../etc.passwd.x', idx: 0, x: 1, y: 1, w: 1, h: 1 },
    { agentId: 'muse', key: 'approved_alien.rot.east', idx: 99, x: 1, y: 1, w: 1, h: 1 },
    { agentId: 'ledger', key: 'approved_plaguedoctor.rot.west', idx: 0, x: 9e9, y: 1, w: 1, h: 1 }]);
  A.eq(cr.bodies, [{ agentId: 'forge', key: 'approved_robot.walk.south', idx: 3, x: 10.4, y: 20, w: 6, h: 18, walking: true, working: false }],
    'only well-formed crew rows are kept (bad ids, keys, frame numbers and off-picture points are dropped)');
  A.eq(v3.crew().bodies.length, 1, 'and held for a phone that opens later');

  const walk = portraits.framesFor('approved_robot.walk.south');
  A.ok(walk && walk.frames.length >= 4 && Buffer.from(walk.frames[0], 'base64').toString('latin1', 1, 4) === 'PNG', 'a sprite track is every drawing the stage uses for it (' + (walk && walk.frames.length) + ' frames)');
  A.eq(portraits.framesFor('approved_robot.walk.nowhere'), null, 'a track the manifest does not list is nothing');
  A.eq(portraits.framesFor('..\\..\\x.rot.south'), null, 'a hostile key reads nothing');
  const sp = await call('sprite', { key: 'approved_robot.rot.south' });
  A.ok(sp.ok && sp.data.frames.length >= 1, 'the phone gets a track through the gateway');
  A.eq((await call('sprite', { key: 'x/../y.rot.south' })).ok, false, 'a bad key is refused at the gateway');

  // the view's first chunk carries the crew and whether the room was drawn without them
  const hv = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [], liveRuns: () => [], transcript: { streams: () => [], history: () => [] }, view: v3 });
  const first = await hv.view({ offset: 0, length: 1000 });
  A.eq([first.crewFree, first.crew && first.crew.bodies.length], [true, 1], 'a phone that opens gets the room and where the crew are at once');

  // the room checked again and unchanged: the picture is current (its age restarts) without being re-sent
  now += 30000;
  A.eq(v3.touch(), true, 'an unchanged room can be marked current');
  A.eq(v3.meta().checkedAt, now, 'its checked time moves');
  A.ok(v3.meta().at < now, 'while the picture itself (and what a phone has) stays the same');
  // the crew stream goes only to phones that are looking
  v3.want('phone-a'); now += 1000; v3.want('phone-b'); now += 20000;
  A.eq(v3.lookers().sort(), ['phone-a', 'phone-b'], 'phones that asked recently are looking');
  now += 4500;
  A.eq(v3.lookers(), ['phone-b'], 'a phone that stopped asking stops getting the crew stream');
  // a frozen crew (the desk window hidden) is reported, so the phone never calls it LIVE
  v3.putCrew([{ agentId: 'forge', key: 'approved_robot.rot.south', idx: 0, x: 1, y: 1, w: 5, h: 9 }], true);
  A.eq(v3.meta().crewPaused, true, 'a paused crew stream is known');

  // a long conversation always fits one sealed frame through the relay: newest turns first, within the budget
  const longTurns = [];
  for (let i = 0; i < 60; i++) longTurns.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(9000) + ' #' + i, ts: i });
  const hl = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [], liveRuns: () => [],
    transcript: { streams: () => [], history: () => longTurns }, deskSessions: () => [] });
  const th = await hl.thread({ streamId: 'long', limit: 200 });
  const bytes = Buffer.byteLength(JSON.stringify(th));
  A.ok(bytes < 200 * 1024, 'a 540 KB conversation comes back under 200 KB (' + Math.round(bytes / 1024) + ' KB)');
  A.ok(/#59$/.test(th[th.length - 1].content) && th.length < 60, 'the newest turns are the ones kept');

  /* SESSION HISTORY NEVER DISAPPEARS (Andrew 10-02, testing on the road: "sometimes session history disappears").
     Reproduction: you write from the phone, the desk later saves a newer turn of the same session without having
     merged yours — the phone used to keep only station turns NEWER than the desk's last line, so yours vanished. */
  {
    const desk = [
      { role: 'user', content: 'plan the launch', ts: 100 }, { role: 'assistant', content: 'Here is the plan.', ts: 110 },
      { role: 'system', sys: true, content: '■ RUN COMPLETE' },
      { role: 'user', content: 'and the budget?', ts: 500 }, { role: 'assistant', content: 'About $40.', ts: 510 }
    ];
    const station = [
      { role: 'user', content: 'plan the launch', ts: 100, rowId: 1 }, { role: 'assistant', content: 'Here is the plan.', ts: 110, rowId: 2 },
      { role: 'user', content: 'from my phone: add a teaser', ts: 300, rowId: 3 }, { role: 'assistant', content: 'Teaser added.', ts: 310, rowId: 4 },
      { role: 'user', content: 'and the budget?', ts: 500, rowId: 5 }, { role: 'assistant', content: 'About $40.', ts: 510, rowId: 6 }
    ];
    const hm = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [{ agentId: 'nova', name: 'NOVA' }], liveRuns: () => [],
      transcript: { streams: () => [{ streamId: 'ws_launch', turns: 6, lastAt: 510, preview: '' }], history: () => station },
      deskSessions: () => [{ id: 'ws_launch', agentId: 'nova', title: 'Launch', history: desk, lastActiveAt: 510 }] });
    const turns = (await hm.thread({ streamId: 'ws_launch', limit: 60 })).map(t => t.content);
    A.eq(turns, ['plan the launch', 'Here is the plan.', 'from my phone: add a teaser', 'Teaser added.', 'and the budget?', 'About $40.'],
      'a phone turn the desk never merged stays in its place, even after the desk saved newer turns');
  }
  /* (sweep 2026-10-02, review of ac17da7ce) a phone SEND hands the model at most the newest 100 turns, as it always did — the merge
     lost the limit and sent the whole desk save plus up to 2000 station turns — and a desk turn holding a secret is redacted before
     it merges: the station copy is redacted at write, so the raw desk copy doubled the turn and went to the relay. */
  {
    const { redact } = require('../sidecar/context.js');
    const KEY = 'sk-or-v1-' + 'abcdef'.repeat(7);
    const long = []; for (let i = 0; i < 260; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: 'line ' + i, ts: i, rowId: i + 1 });
    let ran = null;
    const hl = makeRemoteHost({ now: () => now, newId: () => 'run-hist', broadcast: () => {}, roster: () => [{ agentId: 'nova', name: 'NOVA' }], liveRuns: () => [],
      credentials: () => ({ ok: true, provider: 'openrouter', model: 'm', key: 'k' }), runOnce: async (o) => { ran = o; },
      transcript: { streams: () => [], history: () => long }, deskSessions: () => [] });
    await hl.send({ agentId: 'nova', streamId: 'ws_long', text: 'and now?' });
    for (let i = 0; i < 4 && !ran; i++) await new Promise(r => setImmediate(r));
    A.ok(ran && Array.isArray(ran.messages) && ran.messages.length === 101 && ran.messages[0].content === 'line 160' && ran.messages[100].content === 'and now?',
      'a phone send hands the model the newest 100 turns plus the new message, never the whole session: ' + (ran && ran.messages && ran.messages.length));
    const desk = [{ role: 'user', content: 'use ' + KEY + ' for it', ts: 100 }, { role: 'assistant', content: 'Done.', ts: 110 }];
    const station = [{ role: 'user', content: redact('use ' + KEY + ' for it'), ts: 100, rowId: 1 }, { role: 'assistant', content: 'Done.', ts: 110, rowId: 2 }];
    const hr = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [{ agentId: 'nova', name: 'NOVA' }], liveRuns: () => [], redact,
      transcript: { streams: () => [{ streamId: 'ws_key', turns: 2, lastAt: 110, preview: '' }], history: () => station },
      deskSessions: () => [{ id: 'ws_key', agentId: 'nova', title: 'Key', history: desk, lastActiveAt: 110 }] });
    const kt = (await hr.thread({ streamId: 'ws_key', limit: 60 })).map(t => t.content);
    A.eq(kt.length, 2, 'a turn holding a secret is ONE turn on the phone, not the desk copy and the station copy: ' + JSON.stringify(kt));
    A.ok(kt.every(t => t.indexOf(KEY) < 0), 'and the raw key never leaves for the relay');
  }
  // a long conversation is never cut off: it comes in pages, and the phone is told how many older turns remain
  {
    const many = []; for (let i = 0; i < 230; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i, ts: i, rowId: i + 1 });
    const hp = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [], liveRuns: () => [],
      transcript: { streams: () => [], history: () => many }, deskSessions: () => [] });
    const p1 = await hp.thread({ streamId: 'big', limit: 80, page: true });
    A.eq([p1.turns.length, p1.turns[0].content, p1.turns[79].content, p1.earlier, p1.total], [80, 'turn 150', 'turn 229', 150, 230], 'the first page is the newest 80, with 150 older ones to come');
    const p2 = await hp.thread({ streamId: 'big', limit: 80, before: 80, page: true });
    A.eq([p2.turns[0].content, p2.turns[79].content, p2.earlier], ['turn 70', 'turn 149', 70], 'SHOW EARLIER brings the 80 before those');
    const p3 = await hp.thread({ streamId: 'big', limit: 80, before: 160, page: true });
    A.eq([p3.turns.length, p3.turns[0].content, p3.earlier], [70, 'turn 0', 0], 'and the last page reaches the very first turn');
    A.ok(Array.isArray(await hp.thread({ streamId: 'big', limit: 80 })), 'an older phone (no pages) still gets the bare list');
  }
  // the sessions list holds every session (it stopped at 50), and a session the desk never opened is still listed
  {
    const desks = []; for (let i = 0; i < 120; i++) desks.push({ id: 'ws_' + i, agentId: 'nova', title: 'Session ' + i, history: [{ role: 'user', content: 'q' + i, ts: i }], lastActiveAt: i });
    desks.push({ id: 'ws_quiet', agentId: 'nova', title: 'NOVA', history: [], lastActiveAt: 5 });
    const hs2 = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [{ agentId: 'nova', name: 'NOVA' }], liveRuns: () => [],
      transcript: { streams: () => [{ streamId: 'ws_quiet', agentId: 'nova', turns: 2, lastAt: 999, preview: 'what I asked from the phone' }], history: () => [] },
      deskSessions: () => desks });
    const list = await hs2.threads({ limit: 300 });
    A.eq(list.length, 121, 'all 121 sessions are listed');
    A.ok(list.some(t => t.streamId === 'ws_quiet' && t.preview === 'what I asked from the phone'), 'a session whose turns live only in the station record is not hidden as blank');
  }
  // a file read for an agent that does not exist makes nothing
  A.eq((await hl.fetchFile({ agentId: 'ghost', path: 'x.txt', offset: 0, length: 10 })).ok, false, 'no file read (and no folder) for a made-up agent');
  // a phone reads only what the station showed it: the agent's own workspace, or a file a run/deliverable recorded
  {
    const reads = [];
    const hf = makeRemoteHost({ now: () => now, newId: () => 'r', broadcast: () => {}, roster: () => [{ agentId: 'forge', name: 'FORGE' }], liveRuns: () => [],
      transcript: { streams: () => [], history: () => [] }, deskSessions: () => [],
      runHistory: () => [{ runId: 'h1', agentId: 'forge', artifacts: [{ path: 'C:\\proj\\out\\report.md' }] }, { runId: 'h2', agentId: 'scout', artifacts: [{ path: 'C:\\proj\\scout.md' }] }],
      deliverables: async () => [{ id: 'd1', agentId: 'forge', files: [{ path: '/home/me/proj/plan.pdf' }] }],
      readFile: async (agentId, p) => { reads.push(p); return { ok: true, path: p }; } });
    const fetchOk = async (p) => (await hf.fetchFile({ agentId: 'forge', path: p, offset: 0, length: 10 })).ok !== false;
    A.eq(await fetchOk('notes/today.md'), true, 'a file in the agent\'s own workspace is readable');
    A.eq(await fetchOk('C:\\proj\\out\\report.md'), true, 'a file one of its runs recorded is readable');
    A.eq(await fetchOk('/home/me/proj/plan.pdf'), true, 'a file one of its deliverables lists is readable');
    A.eq(await fetchOk('C:\\proj\\.secrets\\keys.json'), false, 'any other absolute path is refused, even in a folder agents may use');
    A.eq(await fetchOk('C:\\proj\\scout.md'), false, 'another agent\'s file is not reachable by naming this agent');
    A.eq(await fetchOk('\\\\server\\share\\x.txt'), false, 'a network path is refused');
    A.eq(await fetchOk('/etc/passwd'), false, 'a posix absolute path is refused');
    A.eq(reads.some(p => /secrets|scout|passwd|server/.test(p)), false, 'and none of those ever reached the disk');
  }

  /* ---------- 6. ACTIVITY: running now + what finished, from the run history ---------- */
  history = [
    { runId: 'h1', agentId: 'forge', reason: 'done', title: 'draft the launch plan', deliveryText: 'Here is the **plan**', streamId: 'ws_1', startedAt: 100, endedAt: 900, artifacts: [{ kind: 'file', path: 'plan.md' }], deliverable: { main: 'out/plan.pdf' }, usd: 0.02 },
    { runId: 'h2', agentId: 'scout', reason: 'cancelled', title: 'research', streamId: 'remote_scout_1', startedAt: 50, endedAt: 60, artifacts: [] },
    { runId: 'h3', agentId: 'forge', reason: 'done', title: 'INTERNAL — self talk', internal: true },
    { runId: 'h4', agentId: 'forge', reason: 'done', title: 'a worker step', parentRunId: 'h1' },
    { runId: 'h5', agentId: 'scout', reason: 'error', failureCode: 'provider_timeout', title: 'fetch prices', startedAt: 10, endedAt: 20 }
  ];
  const act = await call('activity', { limit: 10 });
  A.ok(act.ok, 'activity answers');
  A.eq(act.data.done.map(r => [r.runId, r.state]), [['h1', 'done'], ['h2', 'stopped'], ['h5', 'failed']], 'finished work, newest first; self-talk and worker sub-steps are left out');
  A.eq(act.data.done[0].files, ['plan.md', 'out/plan.pdf'], 'with the files it made');
  A.eq(act.data.done[0].result, 'Here is the **plan**', 'and its result line');
  A.eq(act.data.done[2].error, 'provider_timeout', 'a failure says why');
  A.eq(act.data.live, [], 'nothing running');

  // the desk page streams the crew only while a phone is looking, in the still's pixels
  const crewPosts = [];
  globalThis.fetch = async (url, o) => {
    if (o && o.method === 'POST') { const body = JSON.parse(o.body); (url === '/api/remote/view/crew' ? crewPosts : posts).push({ url, body }); return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => answer };
  };
  still = { canvas: {}, width: 800, height: 600, bodies: [], scale: 2 };
  I.encode = async () => ({ mime: 'image/webp', data: 'QQ==' });
  globalThis.World.crewFrames = () => [{ agentId: 'forge', key: 'approved_robot.walk.south', idx: 2, x: 10.26, y: 20, w: 5, h: 19, walking: true, working: false }];
  answer = { ok: true, enabled: true, want: true, at: 5 };
  await I.step();
  A.eq(posts[posts.length - 1].body.crewFree, true, 'the room goes up without the crew in it');
  await I.sendCrew();
  A.eq(crewPosts.length, 1, 'the crew stream goes to the sidecar');
  A.eq(crewPosts[0].body.bodies[0], { agentId: 'forge', key: 'approved_robot.walk.south', idx: 2, x: 20.5, y: 40, w: 10, h: 38, walking: true, working: false }, 'in the still\'s pixels (world x the still scale)');
  await I.sendCrew();
  A.eq(crewPosts.length, 1, 'an unchanged crew is not sent again straight away');
  RemoteView.reset();

  // the reply streams as what it GREW by, with the whole text again every eighth frame (and after a tool step)
  {
    const evs = []; let emitRef = null; let release = null;
    const hs = makeRemoteHost({
      now: () => Date.now(), newId: () => 'tx-run', broadcast: e => evs.push(e),
      roster: () => [{ agentId: 'lead', name: 'LEAD' }], liveRuns: () => [], transcript: { history: () => [], streams: () => [] },
      credentials: () => ({ ok: true, key: 'k', model: 'm', provider: 'p' }), askConsent: () => Promise.resolve('deny'),
      runOnce: async o => { emitRef = o.emit; await new Promise(r => { release = r; }); o.emit('agent.run.end', { agentId: 'lead', runId: o.runId, reason: 'done', usd: 0 }); }
    });
    await hs.send({ agentId: 'lead', text: 'go', streamId: '', deviceId: 'd1' });
    for (let i = 0; i < 50 && !emitRef; i++) await new Promise(r => setTimeout(r, 10));
    const tok = async (t) => { emitRef('agent.token', { delta: t }); await new Promise(r => setTimeout(r, 300)); };
    await tok('Hel'); await tok('lo'); await tok(' there');
    const tx = () => evs.filter(e => e.type === 'run.text' || e.type === 'run.delta');
    A.eq(tx()[0], { type: 'run.text', runId: 'tx-run', text: 'Hel' }, 'the first frame is the text so far');
    A.eq(tx()[1], { type: 'run.delta', runId: 'tx-run', at: 3, add: 'lo' }, 'then only what it grew by, and where that starts — as its OWN type, so a phone app from before deltas ignores it instead of blanking the reply');
    A.eq(tx()[2], { type: 'run.delta', runId: 'tx-run', at: 5, add: ' there' }, 'and again');
    for (let i = 0; i < 5; i++) await tok('.');
    A.eq(tx()[7], { type: 'run.text', runId: 'tx-run', text: 'Hello there.....' }, 'every eighth frame is the whole text, so a phone that missed a piece is put right');
    // a phone app from before deltas (the relay deploys on its own schedule) never blanks the reply: its only handler was
    // `if (e.type === 'run.text') L.text = e.text`
    { const old = { text: '' }; const seen = []; for (const e of tx()) { if (e.type === 'run.text') old.text = e.text; seen.push(old.text); }
      A.ok(seen.every(t => typeof t === 'string') && old.text === 'Hello there.....', 'an older phone app keeps a readable reply on every frame: ' + JSON.stringify(seen)); }
    emitRef('agent.tool_call', { name: 'fs_read', callId: 'c1' }); await tok('Next');
    A.eq(tx()[tx().length - 1], { type: 'run.text', runId: 'tx-run', text: 'Next' }, 'after a tool step the new text starts whole');
    let text = '';
    for (const e of tx()) { if (typeof e.text === 'string') text = e.text; else if (text.length === e.at) text += e.add; }
    A.eq(text, 'Next', 'a phone applying the frames in order ends with exactly the text');
    release();
  }

  // a phone set to ALWAYS ASK never inherits Full Access; a setting that cannot be read asks too
  for (const [asks, want, label] of [[() => true, true, 'a phone marked ALWAYS ASK never inherits Full Access'], [() => { throw new Error('unreadable'); }, true, 'a setting that cannot be read means the phone asks'], [() => false, false, 'an ordinary phone works with the desk permissions']]) {
    let seen = null;
    const ha = makeRemoteHost({
      now: () => Date.now(), newId: () => 'ask-run', broadcast: () => {}, phoneAsksFirst: asks,
      roster: () => [{ agentId: 'lead', name: 'LEAD' }], liveRuns: () => [], transcript: { history: () => [], streams: () => [] },
      credentials: () => ({ ok: true, key: 'k', model: 'm', provider: 'p' }), askConsent: () => Promise.resolve('deny'),
      runOnce: async o => { seen = o; o.emit('agent.run.end', { agentId: 'lead', runId: o.runId, reason: 'done', usd: 0 }); }
    });
    await ha.send({ agentId: 'lead', text: 'do it', streamId: '', deviceId: 'd1' });
    for (let i = 0; i < 50 && !seen; i++) await new Promise(r => setTimeout(r, 10));
    A.eq(require('../sidecar/run-origin.js').hostPowerWithheldFor(seen), want, label);
  }

  // a delegated WORKER's error/end (forwarded onto the lead's emit) must not mark the phone's run failed
  {
    const evs = []; let seenOpts = null;
    const hw = makeRemoteHost({
      now: () => Date.now(), newId: () => 'lead-run', broadcast: e => evs.push(e), phoneAsksFirst: () => false,
      roster: () => [{ agentId: 'lead', name: 'LEAD' }], liveRuns: () => [], transcript: { history: () => [], streams: () => [] },
      credentials: () => ({ ok: true, key: 'k', model: 'm', provider: 'p' }), askConsent: () => Promise.resolve('deny'),
      runOnce: async o => {
        seenOpts = o;
        o.emit('agent.run.error', { agentId: 'worker', runId: 'worker-run', message: 'worker provider 500' });
        o.emit('agent.run.end', { agentId: 'worker', runId: 'worker-run', reason: 'error', usd: 0 });
        o.emit('agent.run.end', { agentId: 'lead', runId: o.runId, reason: 'done', usd: 0.01 });
      }
    });
    await hw.send({ agentId: 'lead', text: 'do it', streamId: '', deviceId: 'd1' });
    await new Promise(r => setTimeout(r, 50));
    A.eq(seenOpts && require('../sidecar/run-origin.js').hostPowerWithheldFor(seenOpts), false, 'a phone works with the desk permissions: a Full Access agent acts without asking');
    const ended = evs.find(e => e.type === 'run.ended');
    A.ok(ended && ended.reason === 'done' && !ended.error, 'a recovered worker error does not turn the phone run red');
    A.eq(hw.recentRuns()[0] && hw.recentRuns()[0].ok, true, 'the phone recent row says the lead run succeeded');
  }

  // (sweep 2026-10-02) "yes" to the agent's offer, sent from the phone, is a TASK: the classifier sees the agent's last turn
  {
    let seen = null; let ranAsTask = null;
    const Classify = require('../frontend/app/classify.js');
    const hy = makeRemoteHost({
      now: () => Date.now(), newId: () => 'yes-run', broadcast: () => {},
      roster: () => [{ agentId: 'lead', name: 'LEAD' }], liveRuns: () => [],
      transcript: { history: () => [{ role: 'user', content: 'the landlord email' }, { role: 'assistant', content: 'Want me to draft the email to your landlord?' }], streams: () => [] },
      credentials: () => ({ ok: true, key: 'k', model: 'm', provider: 'p' }), askConsent: () => Promise.resolve('deny'),
      classify: (text, ctx) => { seen = ctx; return Classify.isTaskDirective(text, ctx); },
      runOnce: async o => { ranAsTask = o.isTask; o.emit('agent.run.end', { agentId: 'lead', runId: o.runId, reason: 'done', usd: 0 }); }
    });
    await hy.send({ agentId: 'lead', text: 'yes', streamId: 'remote_lead_yes', deviceId: 'd1' });
    await new Promise(r => setTimeout(r, 50));
    A.ok(seen && /draft the email/.test(seen.priorAgentTurn || ''), 'the phone run classifies "yes" with the agent\'s last turn');
    A.eq(ranAsTask, true, 'so "yes" to its offer runs as a task (with tools), not chat that can only promise');
  }

  // (QA 2026-10-02) a host built without the ALWAYS ASK reader gives the phone NO host power (never more power on a missing wire)
  {
    let seen = null;
    const hm = makeRemoteHost({
      now: () => Date.now(), newId: () => 'nowire-run', broadcast: () => {},
      roster: () => [{ agentId: 'lead', name: 'LEAD' }], liveRuns: () => [], transcript: { history: () => [], streams: () => [] },
      credentials: () => ({ ok: true, key: 'k', model: 'm', provider: 'p' }), askConsent: () => Promise.resolve('deny'),
      runOnce: async o => { seen = o; o.emit('agent.run.end', { agentId: 'lead', runId: o.runId, reason: 'done', usd: 0 }); }
    });
    await hm.send({ agentId: 'lead', text: 'do it', streamId: '', deviceId: 'd1' });
    for (let i = 0; i < 50 && !seen; i++) await new Promise(r => setTimeout(r, 10));
    A.eq(require('../sidecar/run-origin.js').hostPowerWithheldFor(seen), true, 'no ALWAYS ASK reader wired: the phone asks');
  }

  // (QA 2026-10-02) REMOVING a phone stops the runs it started; another phone's run keeps going
  {
    let n = 0; const signals = {};
    const hr = makeRemoteHost({
      now: () => Date.now(), newId: () => 'rv-' + (++n), broadcast: () => {}, phoneAsksFirst: () => false,
      roster: () => [{ agentId: 'lead', name: 'LEAD' }], liveRuns: () => [], transcript: { history: () => [], streams: () => [] },
      credentials: () => ({ ok: true, key: 'k', model: 'm', provider: 'p' }), askConsent: () => Promise.resolve('deny'),
      runOnce: async o => { signals[o.runId] = o.signal; await new Promise(r => o.signal.addEventListener('abort', r)); }
    });
    await hr.send({ agentId: 'lead', text: 'long task', streamId: '', deviceId: 'lost-phone' });
    await hr.send({ agentId: 'lead', text: 'other task', streamId: '', deviceId: 'my-phone' });
    for (let i = 0; i < 50 && Object.keys(signals).length < 2; i++) await new Promise(r => setTimeout(r, 10));
    A.eq(hr.stopDevice('lost-phone'), 1, 'stopDevice aborts the one run the removed phone started');
    A.ok(signals['rv-1'].aborted && !signals['rv-2'].aborted, 'the removed phone\'s run stops; the other phone\'s run keeps going');
    A.eq(hr.stopDevice(''), 0, 'an empty device id stops nothing');
    hr.stopDevice('my-phone');
  }

  // (QA 2026-10-02) an ALWAYS ASK phone may pause a routine but never switch one back on (it would fire with standing Full Access)
  {
    const calls = [];
    const mk = (asks) => makeRemoteHost({
      now: () => Date.now(), newId: () => 'r', broadcast: () => {}, phoneAsksFirst: () => asks,
      roster: () => [], liveRuns: () => [], transcript: { history: () => [], streams: () => [] },
      setRoutine: async (jobId, enabled) => { calls.push([jobId, enabled]); return { ok: true }; }
    });
    const gw = makeGateway({ host: mk(true), now: () => Date.now() });
    const on = await gw.call({ verb: 'routine', args: { jobId: 'job1', enabled: true } }, { deviceId: 'd1' });
    A.ok(on && on.ok === false && /ALWAYS ASK/.test(String(on.error || '')), 'an ALWAYS ASK phone is refused turning a routine back on, and told why');
    const off = await gw.call({ verb: 'routine', args: { jobId: 'job1', enabled: false } }, { deviceId: 'd1' });
    A.ok(off && off.ok !== false, 'it may still pause one');
    const gw2 = makeGateway({ host: mk(false), now: () => Date.now() });
    const on2 = await gw2.call({ verb: 'routine', args: { jobId: 'job1', enabled: true } }, { deviceId: 'd2' });
    A.ok(on2 && on2.ok !== false, 'an ordinary phone still turns a routine on');
    A.eq(calls, [['job1', false], ['job1', true]], 'only the allowed changes reached the station');
  }
  // (QA 2026-10-02) the desk side of a phone run: E-STOP reaches one accepted a moment ago (not yet in `runs`), and its
  // session-scoped grants end with it like every other run's
  {
    const idx = readSidecarSource();
    A.ok(idx.includes("for (const id of Array.from(remoteHost._remoteRuns.keys())) if (!runs.has(id)) { remoteHost.stop({ runId: id })")
      && idx.includes('halted: halted + phoneAborted'), 'E-STOP stops a phone task still on its way into runs, and counts it once');
    A.ok(idx.includes('finally { runs.delete(rid); runsMeta.delete(rid); grantsSession.delete(rid); }'), 'a phone run drops its session grants when it ends');
    A.ok(idx.includes('stationOneShots.add(ctrl);') && idx.includes('stationOneShots.delete(ctrl); }') && idx.includes('for (const c of Array.from(stationOneShots)) { try { c.abort();'), 'E-STOP also aborts a NEEDS CHANGES / SET IT UP FOR ME call in flight');
  }
  A.report('remote-view');
})().catch((e) => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
