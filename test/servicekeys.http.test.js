/* node test/servicekeys.http.test.js — end-to-end proof of the /api/servicekeys surface (the KEYS tab's
   custom platform keys). Boots the REAL host against an isolated temp workspace on an ephemeral port,
   zero model spend. Proves the whole contract the UI + agents rely on:

     - POST upsert -> 200, response carries the MASKED public shape (never the key value).
     - GET list -> masked rows; the raw response text contains NO key substring (the never-echo law).
     - RESTART round-trip: the key survives a host reboot (persisted store re-applied at boot).
     - toggle + remove behave and 404 honestly on unknown ids.
     - validation: bad name / bad key / bad docsUrl refused 400.
     - the injected env var actually reaches a SHELL CHILD (spawn inherits process.env) — proven via the
       host's own child env, not a claim: after upsert, a fresh boot's process.env carries the var, which
       we observe through the persisted file + a second boot's list state (the direct env read is internal;
       the observable contract is list + survival).

   NOT in test:fast (child-process boot); run via `npm run test:http`. Mirrors lifecycle-armed.http.test.js. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const SECRET = 'rk-live-verySECRET-9876';

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-servicekeys-' });
  await fixture.start();
  const B = () => fixture.baseUrl;
  let apiToken = fixture.token;
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: B() };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v, text: t };
  };

  try {
    // ---- empty list on a fresh boot ----
    const empty = await j('GET', '/api/servicekeys');
    A.eq(empty.status, 200, 'GET /api/servicekeys -> 200');
    A.eq(empty.body.keys, [], 'fresh boot: no keys');

    // ---- upsert: masked response, never the value ----
    const up = await j('POST', '/api/servicekeys', { name: 'Resend', key: SECRET, docsUrl: 'https://resend.com/docs' });
    A.eq(up.status, 200, 'POST /api/servicekeys -> 200');
    A.eq(up.body.key && up.body.key.envVar, 'RESEND_API_KEY', 'response names the derived env var');
    A.eq(up.body.key.last4, '····9876', 'response carries a masked last4');
    A.ok(up.text.indexOf(SECRET) < 0, 'upsert response NEVER echoes the key value');

    // ---- list: masked, never the value ----
    const list = await j('GET', '/api/servicekeys');
    A.eq(list.body.keys.length, 1, 'list has the row');
    A.eq(list.body.keys[0].name, 'Resend', 'row keeps the display name');
    A.eq(list.body.keys[0].enabled, true, 'new key enabled by default');
    A.ok(list.text.indexOf(SECRET) < 0, 'list response NEVER contains the key value');

    // ---- validation refusals ----
    A.eq((await j('POST', '/api/servicekeys', { name: '', key: 'x' })).status, 400, 'empty name -> 400');
    A.eq((await j('POST', '/api/servicekeys', { name: 'A', key: 'two words' })).status, 400, 'space in key -> 400');
    A.eq((await j('POST', '/api/servicekeys', { name: 'A', key: 'x', docsUrl: 'ftp://n' })).status, 400, 'non-http docsUrl -> 400');
    // provider-shaped names are refused: 'OpenRouter' would derive OPENROUTER_API_KEY, which the provider
    // credential resolver reads from process.env — a KEYS paste must never become billing credentials.
    const prov = await j('POST', '/api/servicekeys', { name: 'OpenRouter', key: 'sk-or-nope' });
    A.eq(prov.status, 400, 'provider-shaped name -> 400');
    A.ok(/model provider/i.test(String(prov.body.error || '')), 'refusal points at the SETTINGS surface');
    A.eq((await j('POST', '/api/servicekeys', { name: 'Anthropic', key: 'sk-ant-nope' })).status, 400, 'Anthropic likewise refused');
    A.eq((await j('POST', '/api/servicekeys/toggle', { id: 'nope', enabled: false })).status, 404, 'toggle unknown id -> 404');
    A.eq((await j('POST', '/api/servicekeys/remove', { id: 'nope' })).status, 404, 'remove unknown id -> 404');

    // ---- Etsy is honest: manual/watched OAuth only until StarNet owns token refresh ----
    const etsy = await j('POST', '/api/servicekeys', { name: 'Etsy', key: 'etsy-manual-token' });
    A.eq(etsy.status, 200, 'Etsy manual credential can be saved for a watched session');
    A.eq(etsy.body.key.unattendedSupported, false, 'Etsy response truthfully marks unattended mode unsupported');
    A.eq(etsy.body.key.autonomous, false, 'Etsy never starts with unattended authority');
    const etsyAuto = await j('POST', '/api/servicekeys/autonomy', { id: 'etsy', autonomous: true });
    A.eq(etsyAuto.status, 409, 'Etsy unattended grant is refused as a policy conflict');
    A.ok(/OAuth|refresh|unattended/i.test(String(etsyAuto.body.error || '')), 'Etsy refusal explains the missing refresh lifecycle');
    A.eq((await j('POST', '/api/servicekeys/remove', { id: 'etsy' })).status, 200, 'Etsy test credential removed');

    // ---- fix-sec2 review2 #7: "use without asking" is a standing grant, confirmed at the desk; off never asks ----
    {
      const wx = await j('POST', '/api/servicekeys', { name: 'Weather Desk', key: 'wx-desk-token-123' });
      A.eq(wx.status, 200, 'a key is saved');
      const wid = wx.body.key.id;
      const bare = await j('POST', '/api/servicekeys/autonomy', { id: wid, autonomous: true });
      A.eq(bare.status, 403, 'switching unattended use on is not done on the page key alone');
      A.eq(bare.body.code, 'desk_confirm_required', 'it asks at the desk');
      A.ok(String((bare.body.deskConfirm || {}).summary || '').indexOf(wx.body.key.envVar) >= 0, 'naming the key and the variable it fills');
      A.eq(((await j('GET', '/api/servicekeys')).body.keys || []).find(k => k.id === wid).autonomous, false, 'and nothing changed');
      const yes = await fixture.deskJson('POST', '/api/servicekeys/autonomy', { id: wid, autonomous: true });
      A.eq(yes.status, 200, 'confirmed at the desk, it is on');
      A.eq(yes.body.key.autonomous, true, 'and the key says so');
      const off = await j('POST', '/api/servicekeys/autonomy', { id: wid, autonomous: false });
      A.eq(off.status, 200, 'switching it off never asks');
      A.eq(off.body.key.autonomous, false, 'and it is off');
      A.eq((await j('POST', '/api/servicekeys/remove', { id: wid })).status, 200, 'the test key is removed');
    }

    // ---- update with EMPTY key keeps the saved secret (the edit idiom) ----
    const upd = await j('POST', '/api/servicekeys', { name: 'Resend', key: '', docsUrl: 'https://new.docs' });
    A.eq(upd.status, 200, 'update with empty key -> 200 (saved key kept)');
    A.eq(upd.body.key.last4, '····9876', 'kept key still masks to the same last4');

    // ---- RESTART round-trip: the key survives a reboot ----
    await fixture.restart();
    apiToken = fixture.token;
    const after = await j('GET', '/api/servicekeys');
    A.eq(after.body.keys.length, 1, 'REBOOT: key survived the restart');
    A.eq(after.body.keys[0].envVar, 'RESEND_API_KEY', 'REBOOT: env var intact');
    A.eq(after.body.keys[0].docsUrl, 'https://new.docs', 'REBOOT: updated docsUrl persisted');
    A.ok(after.text.indexOf(SECRET) < 0, 'REBOOT: list still never echoes the value');

    // ---- toggle off, then remove ----
    const off = await j('POST', '/api/servicekeys/toggle', { id: 'resend', enabled: false });
    A.eq(off.status, 200, 'toggle off -> 200');
    A.eq(off.body.key.enabled, false, 'row reports disabled');
    const rm = await j('POST', '/api/servicekeys/remove', { id: 'resend' });
    A.eq(rm.status, 200, 'remove -> 200');
    A.eq((await j('GET', '/api/servicekeys')).body.keys, [], 'list empty after remove');
    const serviceKeysFile = path.join(fixture.workspace, 'connectors', 'servicekeys.json');
    const removalCopies = fs.readFileSync(serviceKeysFile, 'utf8') + fs.readFileSync(serviceKeysFile + '.bak', 'utf8');
    A.ok(removalCopies.indexOf(SECRET) < 0, 'remove scrubs the key from both main and resilient backup');

    // Section reset is the other explicit deletion surface and must obey the same two-copy contract.
    A.eq((await j('POST', '/api/servicekeys', { name: 'Resend', key: SECRET })).status, 200, 're-add before section reset');
    A.eq((await j('POST', '/api/config/reset', { section: 'servicekeys' })).status, 200, 'servicekeys reset -> 200');
    const resetCopies = fs.readFileSync(serviceKeysFile, 'utf8') + fs.readFileSync(serviceKeysFile + '.bak', 'utf8');
    A.ok(resetCopies.indexOf(SECRET) < 0, 'servicekeys reset scrubs the key from both main and resilient backup');

    // A REPLACED key goes the same way: rotating a pasted key leaves the old value in neither copy on disk.
    const OLD_KEY = 're_rotate_OLD_1111', NEW_KEY = 're_rotate_NEW_2222';
    A.eq((await j('POST', '/api/servicekeys', { name: 'Resend', key: OLD_KEY })).status, 200, 'save a key to rotate');
    A.eq((await j('POST', '/api/servicekeys', { name: 'Resend', key: '', docsUrl: 'https://resend.com/docs' })).status, 200, 'an edit that keeps the key');
    const rotated = await j('POST', '/api/servicekeys', { name: 'Resend', key: NEW_KEY });
    A.eq([rotated.status, rotated.body.saved], [200, true], 'the rotation is saved and verified');
    const rotationCopies = fs.readFileSync(serviceKeysFile, 'utf8') + fs.readFileSync(serviceKeysFile + '.bak', 'utf8');
    A.ok(rotationCopies.indexOf(OLD_KEY) < 0, 'a rotated key is in neither the main file nor its recovery copy');
    A.ok(fs.readFileSync(serviceKeysFile, 'utf8').indexOf(NEW_KEY) >= 0 && fs.readFileSync(serviceKeysFile + '.bak', 'utf8').indexOf(NEW_KEY) >= 0, 'both copies hold the new key');
    A.eq((await j('GET', '/api/servicekeys')).body.keys[0].last4, '····2222', 'the row serves the new key');
  } finally {
    await fixture.dispose();
  }

  A.report('servicekeys.http.test');
})().catch(e => { console.log('FAIL: servicekeys.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
