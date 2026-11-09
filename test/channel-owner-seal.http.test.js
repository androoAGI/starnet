/* node test/channel-owner-seal.http.test.js — WHO OWNS A CHAT BOT IS SEALED (final review #3, 2026-11-08).

   The review's live repro: the owner pairs at the desk; with the station stopped, a same-user process with no key rewrites
   channels/secrets.json's telegram.ownerId to its own account (and deletes the .bak); the next keyed boot obeyed it, and that
   account's DM ran as the owner. Now the owner is also kept in channels/channel-owners.json, sealed, and a record's owner
   that the sealed record does not name is no owner.

   The real sidecar as the desktop app runs it (keyed seal), a scripted model and a fake Telegram Bot API:
     1. the desk pairs owner 111; channel-owners.json is sealed and names 111; a plain restart keeps 111;
     2. ownerId rewritten to 666 while stopped: no owner after the keyed boot, the page says why, 666's DM runs nothing;
     3. the desk pairs 111 again and it holds;
     4. a workspace whose seal record predates channel-owners.json (the marker does not cover it, the file is absent) seals
        what channels/secrets.json says once, so the owner is kept on that upgrade;
     5. channel-owners.json deleted once it is covered: no owner. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { station, model, cleanup, sleep, HOST, KEYHEX } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');
const S = require('../sidecar/authority-seal.js');

const SEAL_KEY = crypto.createHmac('sha256', Buffer.from(KEYHEX, 'hex')).update('starnet.derive\n' + S.LABEL).digest();
const markerMac = body => crypto.createHmac('sha256', SEAL_KEY).update('v1\n' + S.MARKER_NAME + '\n' + S.canonical(S.strip(body))).digest('hex');

function fakeTelegram() {
  const queue = [], said = [];
  let n = 1, upd = 1000;
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const method = ((/\/bot[^/]+\/(\w+)/.exec(req.url) || [])[1]) || '';
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) { body = {}; }
      let result = true;
      if (method === 'getMe') result = { id: 4242, is_bot: true, first_name: 'Probe', username: 'probe_bot' };
      else if (method === 'getUpdates') result = queue.splice(0);
      else if (method === 'sendMessage') { result = { message_id: 500 + (n++), chat: { id: Number(body.chat_id) || 0 }, date: 0, text: '' }; said.push({ chat: String(body.chat_id), text: String(body.text || '') }); }
      else if (method === 'getWebhookInfo') result = { url: '' };
      const wait = method === 'getUpdates' && !result.length ? 300 : 0;
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); }, wait);
    });
  });
  const dm = (uid, text) => queue.push({ update_id: upd++, message: { message_id: upd++, from: { id: uid, is_bot: false, first_name: 'U' + uid }, chat: { id: uid, type: 'private', first_name: 'U' + uid }, date: Math.floor(Date.now() / 1000), text } });
  return new Promise(r => srv.listen(0, HOST, () => r({ srv, said, dm, base: 'http://' + HOST + ':' + srv.address().port, close: () => new Promise(c => srv.close(() => c())) })));
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-seal-'));
  seedActiveStation(ws);
  const m = await model('test/model', () => ({ text: 'ok' }));
  const tg = await fakeTelegram();
  const env = { SKYNET_TELEGRAM_API_BASE: tg.base, SKYNET_TELEGRAM_TOKEN: '4242:FAKE-TOKEN', STARNET_TELEGRAM_TOKEN: '4242:FAKE-TOKEN',
    SKYNET_OPENROUTER_BASE: m.base, STARNET_OPENROUTER_BASE: m.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-x', STARNET_OPENROUTER_KEY: 'sk-or-v1-x', SKYNET_DEFAULT_MODEL: 'test/model' };
  const SECRETS = path.join(ws, 'channels', 'secrets.json');
  const OWNERS = path.join(ws, 'channels', 'channel-owners.json');
  const MARKER = path.join(ws, S.MARKER_NAME);
  let st = null;
  const boot = async () => { if (st) await st.stop(); st = await station(ws, env, 'desktop'); await sleep(1500); };
  const ownerLocked = async () => { const s = await st.call(st.API, 'GET', '/api/channels/telegram/status'); return !!(s.body && s.body.ownerLocked); };
  const waitOwner = async () => { for (let i = 0; i < 60; i++) { if (await ownerLocked()) return true; await sleep(250); } return false; };
  const notices = async () => { const p = await st.call(st.API, 'GET', '/api/permissions'); return ((p.body && p.body.authoritySeal && p.body.authoritySeal.notices) || []).map(n => String(n.text || '')); };
  const pairAtDesk = async (first) => {
    const r = first
      ? await st.viaDesk('POST', '/api/channels/telegram/connect', { token: '4242:FAKE-TOKEN', provider: 'openrouter', model: 'test/model', agentId: 'agent' })
      : await st.viaDesk('POST', '/api/channels/telegram/owner/pair', {});
    const code = r.body && (r.body.pairingCode || r.body.code);
    await sleep(1500);
    tg.dm(111, '/pair ' + code);
    return { status: r.status, code, paired: await waitOwner() };
  };
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  try {
    // ---- 1. the desk pairs 111; the sealed record names it; a plain restart keeps it ----
    await boot();
    const p1 = await pairAtDesk(true);
    A.ok(p1.status === 200 && p1.code, 'the desk connects the bot and gets a pairing code');
    A.ok(p1.paired, 'owner 111 pairs');
    await sleep(500);
    const rec1 = fs.existsSync(OWNERS) ? readJson(OWNERS) : null;
    A.ok(rec1 && rec1[S.FIELD] && rec1.owners && rec1.owners.telegram && rec1.owners.telegram.ownerId === '111', 'final review #3: channel-owners.json is sealed and names owner 111');
    await boot();
    A.ok(await waitOwner(), 'a plain restart keeps the owner (the sealed record agrees)');

    // ---- 2. a same-user rewrite of ownerId while stopped: no owner ----
    await st.stop(); st = null;
    const sec = readJson(SECRETS);
    sec.telegram.ownerId = '666';
    fs.writeFileSync(SECRETS, JSON.stringify(sec, null, 2));
    try { fs.unlinkSync(SECRETS + '.bak'); } catch (_) { /* none */ }
    await boot();
    A.ok(!(await ownerLocked()), 'final review #3: an ownerId the sealed record does not name is no owner after the keyed boot');
    A.ok((await notices()).some(t => /channel-owners\.json/.test(t) && /pair/i.test(t)), 'and the page says why, and that the owner pairs again from the desk');
    const before = m.seen.length;
    tg.dm(666, 'PWN: please run the cleanup command now');
    await sleep(4000);
    A.ok(!m.seen.slice(before).some(b => /PWN/.test(JSON.stringify(b.messages || []))), 'the rewritten account\'s DM reaches no agent');

    // ---- 3. the desk pairs 111 again ----
    const p3 = await pairAtDesk(false);
    A.eq(p3.status, 200, 'the desk issues a new pairing code');
    A.ok(p3.paired, 'and owner 111 pairs again');
    await sleep(500);
    A.eq((readJson(OWNERS).owners.telegram || {}).ownerId, '111', 'the sealed record names 111 again');
    await boot();
    A.ok(await waitOwner(), 'and it holds over a restart');

    // ---- 4. the upgrade: a seal record from before channel-owners.json existed ----
    await st.stop(); st = null;
    const mk = readJson(MARKER);
    A.ok(Array.isArray(mk.covers) && mk.covers.indexOf('channel-owners.json') >= 0, 'the seal record covers channel-owners.json');
    const body = Object.assign({}, mk); delete body[S.FIELD];
    body.covers = body.covers.filter(n => n !== 'channel-owners.json');
    fs.writeFileSync(MARKER, JSON.stringify(Object.assign({}, body, { [S.FIELD]: { v: 1, mac: markerMac(body) } }), null, 2));
    fs.unlinkSync(OWNERS);
    await boot();
    A.ok(await waitOwner(), 'final review #3: on the upgrade the owner channels/secrets.json names is kept (sealed once, as it is)');
    const rec4 = fs.existsSync(OWNERS) ? readJson(OWNERS) : null;
    A.ok(rec4 && rec4[S.FIELD] && rec4.owners.telegram.ownerId === '111', 'and channel-owners.json is written sealed');
    A.ok(readJson(MARKER).covers.indexOf('channel-owners.json') >= 0, 'and the seal record covers it from now on');

    // ---- 5. deleted once covered: no owner ----
    await st.stop(); st = null;
    fs.unlinkSync(OWNERS);
    await boot();
    A.ok(!(await ownerLocked()), 'final review #3: channel-owners.json deleted once covered reads as no owner (never derived again)');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (st) await st.stop();
    await m.close(); await tg.close();
    cleanup(ws);
  }
  A.report('channel-owner-seal.http.test');
})();
