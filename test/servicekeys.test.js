/* node test/servicekeys.test.js — the custom service-key store's pure core (sidecar/servicekeys.js).

   Proves the KEYS-tab contract end to end at the module level:
     • env-var derivation is stable, collision-refusing, and never yields an invalid var name.
     • upsert validates, updates-in-place by name, and an empty key on update KEEPS the saved key.
     • toPublic (the /api list shape) structurally cannot leak the key — masked last4 only.
     • applyEnv injects enabled keys, scrubs removed/disabled ones it owns, and NEVER clobbers an
       ambient env var it does not own (a real deployment var beats a paste).
     • promptBlock names env vars only — the secret value never enters the prompt — and is '' when
       nothing is enabled (byte-identical no-op at the system-prompt assembly seam). */
'use strict';
const A = require('./_assert.js');
const K = require('../sidecar/servicekeys.js');

// ---- A. deriveEnvVar / slug ----
{
  A.eq(K.deriveEnvVar('Resend'), 'RESEND_API_KEY', 'plain name');
  A.eq(K.deriveEnvVar('Acme Co.'), 'ACME_CO_API_KEY', 'punctuation collapses to _');
  A.eq(K.deriveEnvVar('Foo API key'), 'FOO_API_KEY', 'a name already saying "API key" is not double-suffixed');
  A.eq(K.deriveEnvVar('11labs'), 'K_11LABS_API_KEY', 'digit-leading name gets a K_ prefix (env vars cannot start with a digit)');
  A.eq(K.deriveEnvVar('***'), '', 'no alnum at all -> empty (refused by validate)');
  A.eq(K.slug('Acme Co.'), 'acme-co', 'slug is the stable id');
}

// ---- B. validate ----
{
  A.ok(K.validate({ name: 'Resend', key: 'rk-123' }).ok, 'happy path validates');
  A.ok(!K.validate({ name: '', key: 'x' }).ok, 'empty name refused');
  A.ok(!K.validate({ name: '!!!', key: 'x' }).ok, 'no-alnum name refused');
  A.ok(!K.validate({ name: 'A', key: 'bad\nkey' }).ok, 'newline in key refused');
  A.ok(!K.validate({ name: 'A', key: 'has space' }).ok, 'space in key refused');
  A.ok(K.validate({ name: 'A', key: 'sk-live_ABC.123~x' }).ok, 'dashes/underscores/dots in key are fine');
  A.ok(!K.validate({ name: 'A', key: 'x', docsUrl: 'ftp://nope' }).ok, 'non-http docs url refused');
  A.ok(K.validate({ name: 'A', key: 'x', docsUrl: 'https://docs.acme.co' }).ok, 'https docs url fine');
}

// ---- C. upsert: add, update-in-place, keep-saved-key, collision refusal ----
{
  const r1 = K.upsert([], { name: 'Resend', key: 'rk-old-1234', docsUrl: 'https://resend.com/docs' }, 1000);
  A.ok(!r1.error, 'first upsert ok');
  A.eq(r1.record.envVar, 'RESEND_API_KEY', 'record carries the derived env var');
  A.eq(r1.record.enabled, true, 'new record enabled by default');
  A.eq(r1.record.addedAt, 1000, 'addedAt from injected now');

  // update by same name with an EMPTY key -> the saved key survives (the mc-token edit idiom)
  const r2 = K.upsert(r1.list, { name: 'Resend', key: '', docsUrl: 'https://new.docs' }, 2000);
  A.ok(!r2.error, 'update with empty key ok');
  A.eq(r2.record.key, 'rk-old-1234', 'empty key on update KEEPS the saved key');
  A.eq(r2.record.docsUrl, 'https://new.docs', 'docsUrl updated');
  A.eq(r2.record.addedAt, 1000, 'addedAt preserved on update');
  A.eq(r2.list.length, 1, 'update did not duplicate the row');

  // a NEW record with an empty key is refused (nothing saved to keep)
  A.ok(K.upsert([], { name: 'Fresh', key: '' }, 0).error, 'new record with empty key refused');

  // two different names deriving the SAME env var would shadow each other in the run env -> refused.
  // 'Foo' and 'Foo API key' have DIFFERENT ids (foo / foo-api-key) but both derive FOO_API_KEY.
  const c1 = K.upsert([], { name: 'Foo', key: 'k1' }, 1);
  const c2 = K.upsert(c1.list, { name: 'Foo API key', key: 'k2' }, 2);
  A.ok(c2.error && /already uses FOO_API_KEY/.test(c2.error), 'env-var collision across distinct ids is refused');
  // 'resend!' slugs to the SAME id as 'Resend' -> that is an update, never a collision
  const r3 = K.upsert(r2.list, { name: 'resend!', key: 'rk-2' }, 3000);
  A.ok(!r3.error && r3.list.length === 1, 'same-slug punctuation variant updates in place');
  const r4 = K.upsert(r2.list, { name: 'Re send', key: 'rk-2' }, 3000);   // 're-send' id, RE_SEND_API_KEY — distinct, fine
  A.ok(!r4.error, 'distinct env var coexists');
  const r5 = K.upsert(r4.list, { name: 'Re.Send', key: 'rk-3' }, 3100);   // same id as 're-send' -> update, not collision
  A.ok(!r5.error, 'same-slug name is an update, not a collision');

  // input list is never mutated
  A.eq(r1.list.length, 1, 'upsert does not mutate its input list');
}

// ---- D. toPublic: the list-response shape structurally cannot leak ----
{
  const up = K.upsert([], { name: 'Stripe Test', key: 'sk_test_abcd9876' }, 5);
  const pub = K.toPublic(up.record);
  A.ok(!('key' in pub), 'toPublic carries NO key field');
  A.eq(pub.last4, '····9876', 'masked last4 only');
  const blob = JSON.stringify(pub);
  A.ok(blob.indexOf('sk_test_abcd9876') < 0, 'serialized public shape contains no key substring');
  A.ok(blob.indexOf('abcd') < 0, 'nor the key body');
}

// ---- E. applyEnv: inject, scrub, never clobber ambient ----
{
  const mk = (n, k, en) => K.upsert([], { name: n, key: k }, 1).list.map(r => Object.assign(r, en === false ? { enabled: false } : {}))[0];
  const list = [mk('Alpha', 'a-key'), mk('Beta', 'b-key'), mk('Gamma', 'g-key', false)];
  const env = { PATH: '/bin', BETA_API_KEY: 'ambient-real' };
  let owned = K.applyEnv(list, env, {});
  A.eq(env.ALPHA_API_KEY, 'a-key', 'enabled key injected');
  A.eq(env.BETA_API_KEY, 'ambient-real', 'ambient var NOT clobbered by the paste');
  A.ok(!('GAMMA_API_KEY' in env), 'disabled key not injected');
  A.ok(owned.ALPHA_API_KEY && !owned.BETA_API_KEY, 'ownership tracks only what WE set');

  // remove Alpha, enable Gamma -> Alpha scrubbed (we owned it), Gamma appears, Beta still ambient
  const list2 = [list[1], Object.assign({}, list[2], { enabled: true })];
  owned = K.applyEnv(list2, env, owned);
  A.ok(!('ALPHA_API_KEY' in env), 'removed key WE set is scrubbed from env');
  A.eq(env.GAMMA_API_KEY, 'g-key', 're-enabled key injected');
  A.eq(env.BETA_API_KEY, 'ambient-real', 'ambient var still intact');
  A.eq(env.PATH, '/bin', 'unrelated env untouched');
}

// ---- F. promptBlock: names only, '' when empty ----
{
  A.eq(K.promptBlock([]), '', 'no keys -> empty block (byte-identical no-op)');
  const l1 = K.upsert([], { name: 'Resend', key: 'rk-secret-9999', docsUrl: 'https://resend.com/docs' }, 1).list;
  const l2 = K.setEnabled(K.upsert(l1, { name: 'Off One', key: 'off-key' }, 2).list, 'off-one', false).list;
  const block = K.promptBlock(l2);
  A.ok(block.indexOf('RESEND_API_KEY') >= 0, 'block names the env var');
  A.ok(block.indexOf('resend.com/docs') >= 0, 'block carries the docs pointer');
  A.ok(block.indexOf('rk-secret-9999') < 0, 'block NEVER carries the key value');
  A.ok(block.indexOf('OFF_ONE_API_KEY') < 0, 'disabled key not advertised');
  A.ok(/never print, echo/i.test(block), 'block instructs the model not to leak the value');
  // Windows: shell.exec is cmd.exe, where $NAME stays literal — the block must name the syntax that expands there
  const winBlock = K.promptBlock(l1, { platform: 'win32' });
  A.ok(winBlock.indexOf('%RESEND_API_KEY%') >= 0, 'win32 block names the cmd.exe %VAR% form');
  A.ok(winBlock.indexOf('$env:RESEND_API_KEY') >= 0, 'win32 block names the PowerShell $env: form');
  A.ok(K.promptBlock(l1, { platform: 'linux' }).indexOf('%RESEND_API_KEY%') < 0, 'posix block keeps $VAR (no cmd.exe syntax)');
  A.ok(/Prefer web_request/.test(winBlock), 'with both routes, the block steers to web_request');
  A.ok(!/Prefer web_request/.test(K.promptBlock(l1, { shell: true, request: false, platform: 'win32' })), 'never recommends a route the run lacks');
  A.ok(/"in": "query"/.test(block), 'block teaches the auth query slot for ?key= APIs');
}

// ---- G2. reserved provider env vars: a KEYS paste must never become billing credentials ----
{
  const reserved = ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'SKYNET_OPENROUTER_API_KEY'];
  // 'OpenRouter' derives OPENROUTER_API_KEY — exactly what providerRuntimeKey reads from process.env
  const r1 = K.upsert([], { name: 'OpenRouter', key: 'sk-or-x' }, 1, { reservedEnv: reserved });
  A.ok(r1.error && /model provider/i.test(r1.error), 'provider-shaped name refused with a pointer to SETTINGS');
  A.ok(/OpenRouter Maps/.test(r1.error), 'the refusal suggests a product-specific name that saves (a Google Maps key is not a model key)');
  A.ok(!K.upsert([], { name: 'OpenRouter Maps', key: 'k' }, 1, { reservedEnv: reserved }).error, 'the suggested name actually saves');
  // the scoped desktop form is reserved too ('Skynet OpenRouter' -> SKYNET_OPENROUTER_API_KEY)
  A.ok(K.upsert([], { name: 'Skynet OpenRouter', key: 'k' }, 1, { reservedEnv: reserved }).error, 'scoped provider var refused');
  // a Set works as well as an array, and a non-reserved name still passes with the option present
  A.ok(!K.upsert([], { name: 'Resend', key: 'k' }, 1, { reservedEnv: new Set(reserved) }).error, 'non-provider name unaffected by the guard');
  // applyEnv belt: a PRE-GUARD persisted record with a reserved var is skipped, never written
  const legacy = [{ id: 'openrouter', name: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', key: 'sk-paste', enabled: true }];
  const env = {};
  const owned = K.applyEnv(legacy, env, {}, { reservedEnv: reserved });
  A.ok(!('OPENROUTER_API_KEY' in env), 'applyEnv never writes a reserved provider var (legacy record)');
  A.ok(!owned.OPENROUTER_API_KEY, 'and never claims ownership of it');
}

// ---- G. setEnabled / remove ----
{
  const l = K.upsert([], { name: 'X', key: 'k1' }, 1).list;
  const off = K.setEnabled(l, 'x', false);
  A.ok(!off.error && off.record.enabled === false, 'setEnabled flips');
  A.ok(K.setEnabled(l, 'nope', true).error, 'setEnabled unknown id errors');
  const rm = K.remove(off.list, 'x');
  A.ok(!rm.error && rm.list.length === 0, 'remove empties the list');
  A.ok(K.remove([], 'x').error, 'remove unknown id errors');
}

// ---- H. watched-only integrations cannot silently acquire unattended authority ----
{
  const reason = 'StarNet does not yet manage Etsy OAuth refresh.';
  const add = K.upsert([], {
    name: 'Etsy', key: 'etsy-key', unattendedSupported: false, unattendedReason: reason
  }, 1);
  A.eq(add.record.autonomous, false, 'watched-only key starts with unattended authority disabled');
  A.eq(add.record.unattendedSupported, false, 'watched-only policy is retained on the stored record');
  const grant = K.setAutonomous(add.list, 'etsy', true);
  A.ok(!!grant.error && /OAuth|unattended/i.test(grant.error), 'watched-only key refuses unattended authority');
  const forced = [Object.assign({}, add.record, { autonomous: true })];
  const resolved = K.resolveForRequest(forced, 'ETSY_API_KEY', 'autonomous');
  A.eq(resolved.ok, false, 'legacy/stale autonomous=true cannot bypass watched-only policy');
  A.ok(/OAuth|unattended/i.test(resolved.detail || ''), 'runtime refusal explains the policy');
  A.eq(K.toPublic(add.record).unattendedSupported, false, 'public shape exposes watched-only policy');
  A.ok(/unattended unsupported/i.test(K.promptBlock(add.list)), 'prompt truthfully labels watched-only access');
}

// ---- a MODEL-PROVIDER key name never resolves for an outbound request, and says why (2026-09-28) ----
{
  const reserved = { reservedEnv: new Set(['OPENROUTER_API_KEY', 'OPENROUTER_KEY']) };
  A.eq(K.resolveForRequest([], 'OPENROUTER_API_KEY', 'interactive', reserved), { ok: false, reason: 'reserved' }, 'a provider key name resolves as reserved, not unknown');
  A.eq(K.resolveForRequest([], 'NOPE_API_KEY', 'interactive', reserved), { ok: false, reason: 'unknown' }, 'an ordinary missing key is still unknown');
  // a list saved before the name was reserved still carries the row: the reserved check runs first, so it is never spent
  const legacy = K.upsert([], { name: 'OpenRouter', key: 'sk-or-legacy' }, 1).list;
  A.eq(legacy[0].envVar, 'OPENROUTER_API_KEY', 'fixture: a pre-reservation row carrying the provider var');
  A.eq(K.resolveForRequest(legacy, 'OPENROUTER_API_KEY', 'interactive', reserved), { ok: false, reason: 'reserved' }, 'a legacy row carrying a provider var is never spent');
}

// report() LAST — it is what calls process.exit(fail?1:0). This file ended in a bare console.log,
// which is why it could sit in NO gate for months and then be adopted into one without anybody
// noticing it could never turn the gate red.
A.report('servicekeys.test');
