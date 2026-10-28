/* node test/prompt-scrub.test.js — the ONE resolver for secrets in stored text bound for a prompt (context-key-redact,
   2026-10-28).

   A key the Commander pasted once rode every later run's RECENT ACTIVITY line to the model provider: the projectors
   clipped stored text and never redacted it, and a clipped key is a fragment no redact rule can match afterwards.
   sidecar/prompt-scrub.js is the one rule every projector now calls BEFORE it clips. This file proves the rule:
     1. scrubStored removes every vendor family whole, cut at the end of the text, and cut before an ellipsis
     2. it removes a value the station HOLDS (no shape at all), whole or as a >= 12-char head at a cut point
     3. it leaves ordinary text byte-identical (=== identity), including hyphenated words the old generic sk- rule ate
     4. scrubHeld (the provider-boundary rule) removes held values only: an unsaved vendor key stays readable
     5. the generic sk- rule in context.js keeps 'task-…' slugs and still catches a glued '=sk-…' / '"sk-…' / '_sk-…'
   Fake keys only (test/helpers/fake-keys.js builds them at runtime from a seed). */
'use strict';
const A = require('./_assert.js');
const context = require('../sidecar/context.js');
const PS = require('../sidecar/prompt-scrub.js');
const FK = require('./helpers/fake-keys.js');
const { list, by } = FK.make('prompt-scrub-unit');

const clean = s => list.every(k => FK.leak(s, k) === null);
const leaks = s => list.map(k => FK.leak(s, k) && k.id).filter(Boolean).join(',');

// ---- 1. vendor families: whole, cut at the end, cut before … / ... ----
context.setKnownSecretSource(null);
for (const k of list.filter(x => x.prefix)) {
  const whole = 'RIG ' + k.id + ' ' + k.value + ' pull my campaigns';
  const out = PS.scrubStored(whole);
  A.ok(clean(out) && out.indexOf('[redacted-key]') >= 0, k.id + ' whole is scrubbed: ' + leaks(out));
  A.ok(/pull my campaigns$/.test(out), k.id + ' whole: the rest of the line survives');
  for (const cut of [4, 12, 20]) {
    const head = ('Title ' + k.value).slice(0, 6 + k.prefix.length + cut);
    for (const tail of ['', '…', '...', '  ']) {
      const o = PS.scrubStored(head + tail);
      A.ok(clean(o), k.id + ' cut at ' + cut + ' body chars + ' + JSON.stringify(tail) + ' leaves no 12-char window: ' + JSON.stringify(o));
      if (cut >= 12) A.ok(o.indexOf('[redacted-key]') >= 0, k.id + ' cut at ' + cut + JSON.stringify(tail) + ' is replaced by the placeholder');
    }
  }
}

// ---- 2. a HELD shapeless value: whole, and as a >= 12-char head at a cut point ----
context.setKnownSecretSource(() => [by.VAULT.value]);
{
  const v = by.VAULT.value;
  const whole = PS.scrubStored('RIG instantly ' + v + ' pull my campaigns');
  A.eq(whole, 'RIG instantly [redacted-secret] pull my campaigns', 'a held value is scrubbed whole');
  A.eq(PS.scrubStored('RIG instantly ' + v.slice(0, 15)), 'RIG instantly [redacted-secret]', 'a 15-char held head at the end of the text');
  A.eq(PS.scrubStored('RIG instantly ' + v.slice(0, 12) + '…'), 'RIG instantly [redacted-secret]…', 'a 12-char held head before …');
  A.eq(PS.scrubStored('RIG instantly ' + v.slice(0, 20) + '... more'), 'RIG instantly [redacted-secret]... more', 'a held head before ... mid-text');
  A.eq(PS.scrubStored('Instantly:' + v.slice(0, 14)), 'Instantly:[redacted-secret]', "a held head right after 'Label:'");
  A.eq(PS.scrubStored('INSTANTLY_KEY=' + v.slice(0, 14) + '…'), 'INSTANTLY_KEY=[redacted-secret]…', "a held head right after 'KEY='");
  const short = 'RIG instantly ' + v.slice(0, 11);
  A.ok(PS.scrubStored(short) === short, 'an 11-char held head is left alone (the documented 12-char floor)');
  const mid = 'RIG ' + v.slice(0, 15) + ' more words';
  A.ok(PS.scrubStored(mid) === mid, 'a held head NOT at a cut point is not a cut key (it is left alone)');
  const word = 'Ship the ' + v.slice(0, 5);
  A.ok(PS.scrubStored(word) === word, 'a title ending in a short prefix of a held value is unchanged');
}

// ---- 3. ordinary text is byte-identical (=== identity) ----
context.setKnownSecretSource(() => [by.VAULT.value, 'application/json', 'production']);
{
  const sha = FK.stream('sha40', 40, '0123456789abcdef');
  const fixtures = [
    'Build the task-management-dashboard', 'desk-assignment-overseer-lane', 'risk-assessment-framework-v2',
    'whisk-together-the-ingredients', 'call hf_hub_download for the weights', 'pip install scikit-learn',
    'commit ' + sha, 'request 123e4567-e89b-12d3-a456-426614174000', 'md5 ' + FK.stream('md5', 32, '0123456789abcdef'),
    'sha256 ' + FK.stream('sha256', 64, '0123456789abcdef'), 'blob ' + Buffer.from(FK.stream('b64', 48, 'abcdefgh')).toString('base64'),
    'C:\\Users\\x\\proj\\a.js', '/usr/local/bin', 'switch to xai-grok', 'meet at 20261028:1530', 'sk-learn more',
    'RIG-W1 summarize what I have going on this week', '[LEMLIST_API_KEY saved in API KEYS]', ''
  ];
  for (const f of fixtures) A.ok(PS.scrubStored(f) === f, 'unchanged: ' + JSON.stringify(f));
  A.ok(PS.scrubStored(undefined) === undefined && PS.scrubStored(null) === null && PS.scrubStored(42) === 42, 'a non-string comes back as is');
  // idempotence
  const messy = 'a ' + by.OPENAI.value + ' b ' + by.VAULT.value.slice(0, 13) + '… c ' + ('AIza' + by.GOOGLE.body).slice(0, 16);
  const once = PS.scrubStored(messy);
  A.ok(PS.scrubStored(once) === once, 'scrub(scrub(x)) === scrub(x)');
  A.ok(clean(once), 'the messy line is clean: ' + leaks(once));
}

// ---- 4. scrubHeld: held values only, never a vendor shape; non-keyish held strings are not touched ----
{
  const held = context.heldSecrets();
  A.ok(Array.isArray(held) && Object.isFrozen(held), 'heldSecrets() is a frozen array');
  A.ok(context.heldSecrets() === held, 'the same array comes back while the held set is unchanged (revision identity)');
  const live = 'save this ' + by.OPENAI.value + ' and use ' + by.VAULT.value + ' in production as application/json';
  const out = PS.scrubHeld(live);
  A.ok(out.indexOf(by.OPENAI.value) >= 0, 'scrubHeld leaves an unheld vendor key readable (keys.save starts_with)');
  A.ok(out.indexOf(by.VAULT.value) < 0 && out.indexOf('[redacted-secret]') >= 0, 'scrubHeld removes the held value');
  A.ok(/in production as application\/json$/.test(out), "scrubHeld never touches a held non-credential ('production', 'application/json')");
  A.ok(PS.scrubHeld('nothing here') === 'nothing here', 'scrubHeld identity on clean text');
}

// ---- 5. the generic sk- rule: hyphenated slugs stay, glued keys are still caught ----
context.setKnownSecretSource(null);
{
  const body = FK.stream('generic', 24, 'abcdefghijklmnop0123456789');
  for (const slug of ['task-management-dashboard', 'desk-assignment-overseer-lane', 'risk-assessment-framework-v2', 'whisk-together-the-ingredients'])
    A.eq(context.redact('Build the ' + slug), 'Build the ' + slug, 'context.redact keeps ' + slug);
  for (const glue of [' ', '=', '"', ':', '_', '('])
    A.ok(context.redact('KEY' + glue + 'sk-' + body).indexOf(body) < 0, 'context.redact still catches ' + JSON.stringify(glue) + 'sk-…');
}

A.report('prompt-scrub.test');
