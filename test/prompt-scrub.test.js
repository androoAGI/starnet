/* node test/prompt-scrub.test.js — the ONE resolver for secrets in stored text bound for a prompt (context-key-redact,
   2026-10-28).

   A key the Commander pasted once rode every later run's RECENT ACTIVITY line to the model provider: the projectors
   clipped stored text and never redacted it, and a clipped key is a fragment no redact rule can match afterwards.
   sidecar/prompt-scrub.js is the one rule every projector now calls BEFORE it clips. This file proves the rule:
     1. scrubStored removes every vendor family whole, cut at a cut point (end of the text or of a LINE, an ellipsis,
        a closing quote), and leaves no 12-char window of the key
     2. it removes a CREDENTIAL the station holds (no shape at all), whole or as a >= 12-char head at a cut point; a
        saved service key becomes its NAME ('[INSTANTLY_API_KEY saved in API KEYS]')
     3. it leaves ordinary text byte-identical (=== identity): hyphenated words the old generic sk- rule ate, and
        vendor-prefixed WORDS ('pip install hf_transformers', 'Write the sk-learn-tutorial') at the end of a title
     4. scrubHeld (the provider-boundary rule) removes held credentials only — a no-digit app password included — and
        never an unheld vendor key
     5. the generic sk- rule keeps 'task-…' slugs yet still catches a key after a JSON / URL escape or glued to a word
     6. the held list is the station's CREDENTIALS (secret-values credentialUnder): a connector's NODE_ENV=production,
        Content-Type: application/json, an email or a project id is never cut out of the Commander's words
     7. the head rule is linear: a 30 000-char '...' run with a held key scrubs in milliseconds (it was seconds)
   Fake keys only (test/helpers/fake-keys.js builds them at runtime from a seed). */
'use strict';
const A = require('./_assert.js');
const context = require('../sidecar/context.js');
const PS = require('../sidecar/prompt-scrub.js');
const { collectSecretValues } = require('../sidecar/secret-values.js');
const FK = require('./helpers/fake-keys.js');
const { list, by } = FK.make('prompt-scrub-unit');

const clean = s => list.every(k => FK.leak(s, k) === null);
const leaks = s => list.map(k => FK.leak(s, k) && k.id).filter(Boolean).join(',');

// ---- 1. vendor families: whole, cut at the end, cut before … / ... / a quote / a line end ----
PS.setHeldSource(null);
for (const k of list.filter(x => x.prefix)) {
  const whole = 'RIG ' + k.id + ' ' + k.value + ' pull my campaigns';
  const out = PS.scrubStored(whole);
  A.ok(clean(out) && out.indexOf('[redacted-key]') >= 0, k.id + ' whole is scrubbed: ' + leaks(out));
  A.ok(/pull my campaigns$/.test(out), k.id + ' whole: the rest of the line survives');
  for (const cut of [4, 12, 20]) {
    const head = ('Title ' + k.value).slice(0, 6 + k.prefix.length + cut);
    for (const tail of ['', '…', '...', '  ', '" (recipe) — finished', '\nnext line', '… more words']) {
      const o = PS.scrubStored(head + tail);
      A.ok(clean(o), k.id + ' cut at ' + cut + ' body chars + ' + JSON.stringify(tail) + ' leaves no 12-char window: ' + JSON.stringify(o));
      if (cut >= 12) A.ok(o.indexOf('[redacted-key]') >= 0, k.id + ' cut at ' + cut + JSON.stringify(tail) + ' is replaced by the placeholder');
    }
  }
  // a key cut inside a JSON string (a brief's quote capped at 600, then serialized): the closing quote is a cut point
  const j = JSON.stringify({ quote: ('my key is ' + k.value).slice(0, 10 + k.prefix.length + 16), next: 'x' });
  A.ok(clean(PS.scrubStored(j)), k.id + ' cut inside a JSON string is scrubbed: ' + PS.scrubStored(j));
}

// ---- 2. a HELD credential: whole, and as a >= 12-char head at a cut point; a saved service key is NAMED ----
PS.setHeldSource(() => [by.VAULT.value]);
{
  const v = by.VAULT.value;
  const whole = PS.scrubStored('RIG instantly ' + v + ' pull my campaigns');
  A.eq(whole, 'RIG instantly [redacted-secret] pull my campaigns', 'a held value is scrubbed whole');
  A.eq(PS.scrubStored('RIG instantly ' + v.slice(0, 15)), 'RIG instantly [redacted-secret]', 'a 15-char held head at the end of the text');
  A.eq(PS.scrubStored('RIG instantly ' + v.slice(0, 12) + '…'), 'RIG instantly [redacted-secret]…', 'a 12-char held head before …');
  A.eq(PS.scrubStored('RIG instantly ' + v.slice(0, 20) + '... more'), 'RIG instantly [redacted-secret]... more', 'a held head before ... mid-text');
  A.eq(PS.scrubStored('Instantly:' + v.slice(0, 14)), 'Instantly:[redacted-secret]', "a held head right after 'Label:'");
  A.eq(PS.scrubStored('INSTANTLY_KEY=' + v.slice(0, 14) + '…'), 'INSTANTLY_KEY=[redacted-secret]…', "a held head right after 'KEY='");
  A.eq(PS.scrubStored('"' + v.slice(0, 18) + '" (recipe) — finished 3 of 4'), '"[redacted-secret]" (recipe) — finished 3 of 4', 'a held head before a closing quote (a TRACK RECORD label)');
  A.eq(PS.scrubStored('• title ' + v.slice(0, 16) + '\n• next'), '• title [redacted-secret]\n• next', 'a held head at the end of a LINE inside a block');
  A.eq(PS.scrubStored(JSON.stringify('line one\n' + v.slice(0, 16))), JSON.stringify('line one\n[redacted-secret]'), 'a held head after an escaped \\n in JSON text');
  const short = 'RIG instantly ' + v.slice(0, 11);
  A.ok(PS.scrubStored(short) === short, 'an 11-char held head is left alone (the documented 12-char floor)');
  const mid = 'RIG ' + v.slice(0, 15) + ' more words';
  A.ok(PS.scrubStored(mid) === mid, 'a held head NOT at a cut point is not a cut key (it is left alone)');
  const word = 'Ship the ' + v.slice(0, 5);
  A.ok(PS.scrubStored(word) === word, 'a title ending in a short prefix of a held value is unchanged');
}
PS.setHeldSource(() => [{ value: by.VAULT.value, as: '[INSTANTLY_API_KEY saved in API KEYS]' }]);
{
  const v = by.VAULT.value;
  A.eq(PS.scrubStored('pull with ' + v + ' now'), 'pull with [INSTANTLY_API_KEY saved in API KEYS] now', 'a saved service key is replaced by its NAME');
  A.eq(PS.scrubHeld('use ' + v.slice(0, 14) + '…'), 'use [INSTANTLY_API_KEY saved in API KEYS]…', 'a cut head of a saved service key is named too');
  A.eq(PS.scrubStored('[INSTANTLY_API_KEY saved in API KEYS] ok'), '[INSTANTLY_API_KEY saved in API KEYS] ok', 'a named placeholder is stable (idempotent)');
}

// ---- 3. ordinary text is byte-identical (=== identity) ----
PS.setHeldSource(() => [by.VAULT.value]);
{
  const sha = FK.stream('sha40', 40, '0123456789abcdef');
  const fixtures = [
    'Build the task-management-dashboard', 'desk-assignment-overseer-lane', 'risk-assessment-framework-v2',
    'whisk-together-the-ingredients', 'call hf_hub_download for the weights', 'pip install scikit-learn',
    'commit ' + sha, 'request 123e4567-e89b-12d3-a456-426614174000', 'md5 ' + FK.stream('md5', 32, '0123456789abcdef'),
    'sha256 ' + FK.stream('sha256', 64, '0123456789abcdef'), 'blob ' + Buffer.from(FK.stream('b64', 48, 'abcdefgh')).toString('base64'),
    'C:\\Users\\x\\proj\\a.js', '/usr/local/bin', 'switch to xai-grok', 'meet at 20261028:1530', 'sk-learn more',
    'RIG-W1 summarize what I have going on this week', '[LEMLIST_API_KEY saved in API KEYS]', '',
    // vendor-prefixed WORDS ending a title (a cut-key rule that ate these wrote the placeholder into run history)
    'pip install hf_transformers', 'Plan the trip to SG.Singapore', 'Write the sk-learn-tutorial', 'deploy job 1730000000:webhookretry',
    'Rename the AKIAPROJECTNAMES', 'summarize meeting ANPAORGANIZATION', 'Use the github_pat_scanner', 'install whk_listener_service',
    'line one hf_transformers\nline two', '"pip install hf_transformers"'
  ];
  for (const f of fixtures) A.ok(PS.scrubStored(f) === f, 'unchanged: ' + JSON.stringify(f));
  A.ok(PS.scrubStored(undefined) === undefined && PS.scrubStored(null) === null && PS.scrubStored(42) === 42, 'a non-string comes back as is');
  // idempotence
  const messy = 'a ' + by.OPENAI.value + ' b ' + by.VAULT.value.slice(0, 13) + '… c ' + ('AIza' + by.GOOGLE.body).slice(0, 16);
  const once = PS.scrubStored(messy);
  A.ok(PS.scrubStored(once) === once, 'scrub(scrub(x)) === scrub(x)');
  A.ok(clean(once), 'the messy line is clean: ' + leaks(once));
  // a WHOLE text (a directive before the store cuts it) never takes the cut-key pass
  const k = 'hf_' + 'Ab3dE5gH7jK9';
  A.eq(PS.scrubStored('install ' + k, { whole: true }), 'install ' + k, 'opts.whole: no cut-key pass on uncut text');
  A.eq(PS.scrubStored('install ' + k), 'install [redacted-key]', '…while the same tail on stored (cut) text is a cut key');
  // scrubDeep: copy-on-write over a JSON-like value
  const obj = { goal: { text: 'ship with ' + by.GITHUB.value, n: 2 }, list: ['plain', 'rotate ' + by.SLACK.value], clean: { a: 'x' } };
  const deep = PS.scrubDeep(obj);
  A.ok(deep !== obj && clean(JSON.stringify(deep)) && deep.clean === obj.clean && deep.goal.n === 2, 'scrubDeep scrubs every string, keeps clean branches by identity');
  A.ok(obj.goal.text.indexOf(by.GITHUB.value) >= 0, 'scrubDeep never mutates its input');
  const tidy = { a: 'nothing', b: ['here'] };
  A.ok(PS.scrubDeep(tidy) === tidy, 'scrubDeep returns the same object when nothing changed');
}

// ---- 4. scrubHeld: held credentials only, never a vendor shape ----
{
  const GMAIL = FK.stream('gmail-app-password', 16, 'abcdefghijklmnopqrstuvwxyz');   // a Google app password: 16 letters, no digit
  PS.setHeldSource(() => [by.VAULT.value, GMAIL]);
  const H = PS.currentHeld();
  A.ok(H && PS.currentHeld() === H, 'the held index is reused while the source is unchanged (revision identity)');
  const live = 'save this ' + by.OPENAI.value + ' and use ' + by.VAULT.value + ' with the mailbox password ' + GMAIL;
  const out = PS.scrubHeld(live);
  A.ok(out.indexOf(by.OPENAI.value) >= 0, 'scrubHeld leaves an unheld vendor key readable (keys.save starts_with)');
  A.ok(out.indexOf(by.VAULT.value) < 0 && out.indexOf('[redacted-secret]') >= 0, 'scrubHeld removes the held value');
  A.ok(out.indexOf(GMAIL) < 0, 'scrubHeld removes a held credential with no digit (a Gmail app password)');
  A.ok(PS.scrubHeld('nothing here') === 'nothing here', 'scrubHeld identity on clean text');
  A.ok(PS.scrubHeld('x ' + by.VAULT.value, []) === 'x ' + by.VAULT.value, 'scrubHeld with an empty held list is identity');
}

// ---- 5. the generic sk- rule: hyphenated slugs stay, escaped and glued keys are still caught ----
context.setKnownSecretSource(null);
{
  const body = FK.stream('generic', 24, 'abcdefghijklmnop0123456789');
  const k32 = 'sk-' + FK.stream('generic32', 32, '0123456789abcdef');
  for (const slug of ['task-management-dashboard', 'desk-assignment-overseer-lane', 'risk-assessment-framework-v2', 'whisk-together-the-ingredients'])
    A.eq(context.redact('Build the ' + slug), 'Build the ' + slug, 'context.redact keeps ' + slug);
  for (const glue of [' ', '=', '"', ':', '_', '('])
    A.ok(context.redact('KEY' + glue + 'sk-' + body).indexOf(body) < 0, 'context.redact still catches ' + JSON.stringify(glue) + 'sk-…');
  const escaped = {
    'JSON \\n': JSON.stringify('KEY=\n' + k32), 'JSON \\t': JSON.stringify('x\t' + k32), 'JSON-in-JSON tool_calls': JSON.stringify([{ function: { arguments: JSON.stringify({ note: 'a\n' + k32 }) } }]),
    'URL %3D': 'q?api_key%3D' + k32, 'glued to a word': 'my key is' + k32
  };
  for (const [name, text] of Object.entries(escaped)) A.ok(context.redact(text).indexOf(k32.slice(3)) < 0, 'context.redact catches a generic sk- key ' + name + ': ' + context.redact(text));
}

// ---- 6. the held list is CREDENTIALS: secret-values credentialUnder ----
{
  const token = FK.stream('conn-token', 32, 'abcdefghijklmnopqrstuvwxyz0123456789');
  const cfg = [{ id: 'c1', url: 'https://mcp.example', token: 'conn-' + token,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'plainvalue', Authorization: 'Bearer ' + token, 'X-Trace': 'Tr4c3' + token },
    env: { NODE_ENV: 'production', NOTIFY_EMAIL: 'andrew.sims2@gmail.com', GCP_PROJECT: 'my-project-123456', NOTES_DIR: '/home/andrew/notes-2026', REGION: 'us-east-1-prod-cluster', DB_PASSWORD: 'hunter2hunter2' } }];
  const cred = collectSecretValues([{ keyed: cfg, credentialUnder: ['headers', 'env'] }]);
  for (const ordinary of ['application/json', 'production', 'andrew.sims2@gmail.com', 'my-project-123456', '/home/andrew/notes-2026', 'us-east-1-prod-cluster'])
    A.ok(cred.indexOf(ordinary) < 0, 'credentialUnder leaves an ordinary connector value out: ' + ordinary);
  for (const secret of ['conn-' + token, 'plainvalue', 'Bearer ' + token, 'Tr4c3' + token, 'hunter2hunter2'])
    A.ok(cred.indexOf(secret) >= 0, 'credentialUnder keeps a credential: ' + secret.slice(0, 12) + '…');
  const all = collectSecretValues([{ keyed: cfg, allUnder: ['headers', 'env'] }]);
  A.ok(all.indexOf('production') >= 0 && all.indexOf('application/json') >= 0, 'allUnder (transcript redaction) still sweeps every header/env string');
  PS.setHeldSource(() => cred);
  const words = 'email it to andrew.sims2@gmail.com, deploy my-project-123456 to us-east-1-prod-cluster in production as application/json';
  A.ok(PS.scrubHeld(words) === words && PS.scrubStored(words) === words, 'the Commander\'s ordinary words survive both rules byte-identically');
  A.ok(PS.scrubHeld('the db password is hunter2hunter2') === 'the db password is [redacted-secret]', 'a named connector credential is still scrubbed');
}

// ---- 7. the head rule is linear ----
{
  PS.setHeldSource(() => [{ value: by.VAULT.value, as: '[INSTANTLY_API_KEY saved in API KEYS]' }]);
  let worst = 0;
  for (const text of ['PASS' + '.'.repeat(30000), 'tok' + ('ab…cdefghijklmn').repeat(2200), ('Rq7' + '.'.repeat(5)).repeat(5000)]) {
    const t0 = process.hrtime.bigint();
    PS.scrubHeld(text); PS.scrubStored(text);
    worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  A.ok(worst < 100, 'a 30 000-char run of cut points with a held key scrubs in < 100 ms (' + worst.toFixed(1) + ' ms)');
}

PS.setHeldSource(null);
A.report('prompt-scrub.test');
