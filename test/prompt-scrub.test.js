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
        (review r3: glued to anything but a lowercase vowel it reads every body as base did; after a vowel, where a
        word's 'sk-' sits, a letters-only body, a masked head and a line-end cut are still caught)
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

// ---- 2b. (review r2) heads of keys that share a prefix; a public vendor prefix is not a head; escapes and glue ----
{
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const A1 = 'Rq7' + FK.stream('share-a', 29, ALNUM);                       // a 32-char saved key
  const B1 = A1.slice(0, 23) + FK.stream('share-b', 9, ALNUM);             // shares a 23-char head with A1
  const C1 = A1 + 'EXTRA77';                                               // A1 is a proper prefix of C1
  const ANT = by.ANTHROPIC.value;
  const nm = n => '[' + n + '_KEY saved in API KEYS]';
  PS.setHeldSource(() => [{ value: A1, as: nm('A') }, { value: B1, as: nm('B') }, { value: C1, as: nm('C') }, { value: ANT, as: '[ANTHROPIC_API_KEY saved in API KEYS]' }]);
  A.eq(PS.scrubStored('title ' + C1.slice(0, 38)), 'title ' + nm('C'), 'a longer key cut past the end of a shorter one it begins with is replaced whole (no tail revealed)');
  A.eq(PS.scrubHeld('title ' + C1.slice(0, 38) + '…'), 'title ' + nm('C') + '…', '…by the provider-boundary rule too');
  A.eq(PS.scrubStored('title ' + A1.slice(0, 25)), 'title [redacted-secret]', 'a head two saved keys could be (A, C) is never named after either');
  A.eq(PS.scrubStored('title ' + A1.slice(0, 20) + '…'), 'title [redacted-secret]…', 'a head three saved keys share is [redacted-secret]');
  A.eq(PS.scrubStored('title ' + B1.slice(0, 28)), 'title ' + nm('B'), 'a head only one saved key continues is named after it');
  A.eq(PS.scrubStored('use ' + A1), 'use ' + nm('A'), 'a whole key at the end of the text is named after itself (not the longer key it begins)');
  A.eq(PS.scrubStored('use ' + A1 + ' and ' + C1 + ' now'), 'use ' + nm('A') + ' and ' + nm('C') + ' now', 'whole keys mid-text are named after themselves');
  // the PUBLIC vendor prefix of a saved key is not part of its secret
  for (const t of ['Anthropic keys start with sk-ant-api03…', 'call keys.save with starts_with sk-ant-api03', '{"service":"Anthropic","starts_with":"sk-ant-api03-"}', 'prefix sk-ant-api03-Ab'])
    A.eq(PS.scrubHeld(t), t, 'a bare public prefix of a saved key is prose, not a cut key: ' + t);
  A.eq(PS.scrubHeld('key ' + ANT.slice(0, 13 + 12) + '…'), 'key [ANTHROPIC_API_KEY saved in API KEYS]…', 'a head 12 chars past the public prefix is the saved key');
  PS.setHeldSource(null);
  // vendor cuts after an escape (the same set context.js uses) and glued to a word
  const k = by.OPENAI.value, g = by.GOOGLE.value;
  for (const [label, text] of [['JSON \\b', JSON.stringify({ t: 'x\b' + k.slice(0, 24) + '…' })], ['ANSI', 'Your key: \u001b[1m' + g.slice(0, 20) + '…'], ['%253D', 'q%253D' + by.GITHUB.value.slice(0, 20)],
    ['=3D', 'KEY=3D' + by.SLACK.value.slice(0, 22) + '…'], ['glued sk-', 'title USER_KEY' + 'sk-' + FK.stream('glued-sk', 30, ALNUM).slice(0, 15) + '…']]) {
    const o = PS.scrubStored(text);
    A.ok(o.indexOf('[redacted-key]') >= 0 && !/[A-Za-z0-9]{10,}…/.test(o.replace(/^title USER_KEY/, '')), 'a cut vendor key ' + label + ' is scrubbed: ' + JSON.stringify(o));
  }
  for (const t of ['Build the task-management-dashboard…', 'see the desk-assignment-overseer…', 'Fix task-1730000000000-abc123def456'])
    A.eq(PS.scrubStored(t), t, 'a glued cut rule never eats a slug: ' + t);
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

// ---- 5. context.redact's shapes — a CORPUS, not a hex sample (review r2). Every sk- family the base rule
//         (/sk-[A-Za-z0-9_\-]{16,}/g, 41c298d9a) hid in a context is hidden now; every vendor key is caught right after
//         an escape (JSON \n \b \f \uXXXX, %3D / %253D, quoted-printable =3D, an ANSI colour code); hyphenated slugs and
//         word-like text stay byte-identical; a field rule keeps an auth scheme and every placeholder.
//         Review r3 (2026-10-28): the r2 rule tested every glued body and left 7 corpus cases base hid readable — a
//         glued letters-only body (GENLETTERS after x / mykeyis / 1 / abc123, and inside an object) and a glued masked
//         head under 20 chars (ADMIN, LITELLM, GENLETTERS 'x' + 24 chars + '…'). Those rows, a key glued to a
//         lowercase vowel ('openai' / 'value', whole and masked) and the prompt-scrub mirror's line-end cut are here. ----
context.setKnownSecretSource(null);
{
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', HEX = '0123456789abcdef', URLSAFE = ALNUM + '-_';
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const sep = (b, p, ch) => b.slice(0, p) + ch + b.slice(p + 1);
  const hx = FK.stream('lf-uuid', 32, HEX), uuid = hx.slice(0, 8) + '-' + hx.slice(8, 12) + '-4' + hx.slice(13, 16) + '-a' + hx.slice(17, 20) + '-' + hx.slice(20);
  const kk = (id, prefix, body) => ({ id, prefix, body, value: prefix + body });
  const SK = [
    kk('OPENROUTER', 'sk-or-v1-', FK.stream('c-or', 64, HEX)), kk('ANTHROPIC', 'sk-ant-api03-', sep(FK.stream('c-ant', 95, URLSAFE), 7, '_')),
    kk('PROJ', 'sk-proj-', FK.stream('c-proj', 48, ALNUM)), kk('PROJ_URLSAFE', 'sk-proj-', sep(FK.stream('c-proj2', 156, URLSAFE), 5, '-')),
    kk('SVCACCT', 'sk-svcacct-', sep(FK.stream('c-svc', 120, URLSAFE), 9, '_')), kk('ADMIN', 'sk-admin-', sep(FK.stream('c-adm', 100, URLSAFE), 11, '-')),
    kk('NONE', 'sk-None-', FK.stream('c-none', 48, ALNUM)), kk('GEN48', 'sk-', FK.stream('c-g48', 48, ALNUM)), kk('GENHEX', 'sk-', FK.stream('c-ghex', 32, HEX)),
    kk('LITELLM', 'sk-', sep(FK.stream('c-lite', 22, URLSAFE), 6, '_')), kk('LANGFUSE', 'sk-lf-', uuid), kk('GENDASH', 'sk-', 'live-' + FK.stream('c-gdf', 40, ALNUM)),
    kk('GENLETTERS', 'sk-', FK.stream('c-glet', 40, LETTERS)),   // r3: a body of letters only (no digit)
    // r3: an admin key whose visible head has no digit (the corpus ADMIN row's 'admin-rGfYfqMloWZ-rpc…' has none either)
    kk('ADMIN_NODIGIT', 'sk-admin-', sep(FK.stream('c-adm-nd', 100, LETTERS + '-_'), 11, '-'))
  ];
  const VENDOR = [
    kk('GOOGLE', 'AIza', sep(FK.stream('c-goog', 35, URLSAFE), 10, '_')), kk('GHP', 'ghp_', FK.stream('c-ghp', 36, ALNUM)), kk('GHO', 'gho_', FK.stream('c-gho', 36, ALNUM)),
    kk('GHPAT', 'github_pat_', FK.stream('c-gp1', 22, ALNUM) + '_' + FK.stream('c-gp2', 59, ALNUM)), kk('GLPAT', 'glpat-', sep(FK.stream('c-gl', 20, URLSAFE), 4, '-')),
    kk('SLACK', 'xoxb-', '7351942086-4820193756241-' + FK.stream('c-xoxb', 24, ALNUM)), kk('STRIPE', 'sk_live_', FK.stream('c-stl', 24, ALNUM)),
    kk('GROQ', 'gsk_', FK.stream('c-gsk', 52, ALNUM)), kk('PPLX', 'pplx-', FK.stream('c-pplx', 48, ALNUM)), kk('NOTION', 'ntn_', FK.stream('c-ntn', 46, ALNUM)),
    kk('LINEAR', 'lin_api_', FK.stream('c-lin', 40, ALNUM)), kk('HF', 'hf_', FK.stream('c-hf', 34, ALNUM)), kk('XAI', 'xai-', FK.stream('c-xai', 80, ALNUM)),
    kk('MATRIX', 'syt_', FK.stream('c-syt', 40, ALNUM)), kk('AWS', 'AKIA', FK.stream('c-akia', 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'))
  ];
  const ESC = String.fromCharCode(27);
  const CTX = {
    bare: v => v, prose: v => 'my key is ' + v + ' ok', eq: v => 'OPENAI_API_KEY=' + v, colon: v => 'key:' + v, dquote: v => '"' + v + '"', paren: v => '(' + v + ')',
    line_start: v => 'first line\n' + v + '\nlast', tab: v => 'k\t' + v, underscore: v => 'KEY_' + v, slash: v => '/secrets/' + v,
    json_obj: v => JSON.stringify({ key: v }), json_nl: v => JSON.stringify({ text: 'line1\n' + v }), json_tab: v => JSON.stringify({ text: 'col\t' + v }),
    json_cr: v => JSON.stringify({ text: 'x\r' + v }), json_bs: v => JSON.stringify({ text: 'x\b' + v }), json_ff: v => JSON.stringify({ text: 'x\f' + v }),
    json_nul: v => JSON.stringify({ text: 'x\u0000' + v }), json_ansi: v => JSON.stringify({ text: ESC + '[1m' + v + ESC + '[0m' }),
    json_in_json_nl: v => JSON.stringify(JSON.stringify({ text: 'a\n' + v })), tool_calls_args_nl: v => JSON.stringify([{ function: { arguments: JSON.stringify({ text: 'x\n' + v }) } }]),
    json_u003c: v => '{"t":"\\u003c' + v + '\\u003e"}', json_u0026: v => '{"u":"https://x.io/?a=1\\u0026' + v + '"}', json_u003d: v => '{"t":"KEY\\u003d' + v + '"}',
    json_u0022: v => '{"t":"\\u0022' + v + '\\u0022"}', json_u000a: v => '{"t":"a\\u000a' + v + '"}',
    url_q: v => 'https://api.example.com/v1?key=' + encodeURIComponent(v), url_pct3d: v => 'api_key%3D' + v, url_pct22: v => '%22' + v + '%22',
    url_double: v => 'redirect=https%3A%2F%2Fx.io%2F%3Fapi_key%253D' + v, url_double_22: v => 'q=%2522' + v + '%2522',
    qp_3d: v => 'OPENAI_API_KEY=3D' + v, qp_softbreak: v => 'token=3D' + v.slice(0, 20) + '=\r\n' + v.slice(20),
    ansi_raw: v => ESC + '[32m' + v + ESC + '[0m', ansi_bold: v => 'Your key: ' + ESC + '[1m' + v + ESC + '[22m',
    glued_letter: v => 'x' + v, glued_word: v => 'mykeyis' + v, glued_digit: v => '1' + v, glued_alnum: v => 'abc123' + v,
    // r3 corpus rows (the ckr2 corpus's masked_glued, and a key glued to a lowercase vowel — where a slug's 'sk-' sits)
    glued_masked: v => 'x' + v.slice(0, Math.min(v.length - 4, 24)) + '…', glued_vowel: v => 'openai' + v, glued_vowel_value: v => 'value' + v,
    glued_vowel_masked: v => 'value' + v.slice(0, Math.min(v.length - 4, 24)) + '…', glued_vowel_stars: v => 'openai' + v.slice(0, 22) + '****' + v.slice(-4),
    curl_bearer: v => 'curl -H "Authorization: Bearer ' + v + '" https://x.io', md_fence: v => '```bash\nexport KEY=' + v + '\n```'
  };
  const W = 8;
  const hidden = (out, key) => { for (let i = 0; i + W <= key.body.length; i++) if (out.indexOf(key.body.slice(i, i + W)) >= 0) return false; return true; };
  const BASE_SK = /sk-[A-Za-z0-9_\-]{16,}/g;   // the 41c298d9a generic rule, unanchored: the parity oracle for the sk- families
  let parity = 0, misses = [];
  for (const key of SK) for (const [cn, fn] of Object.entries(CTX)) {
    const text = fn(key.value);
    if (!hidden(text.replace(BASE_SK, '[redacted-key]'), key)) continue;   // base did not hide it either (not a regression)
    parity++;
    const out = context.redact(text);
    if (!hidden(out, key)) misses.push(key.id + '|' + cn + ' -> ' + JSON.stringify(out.slice(0, 90)));
  }
  A.ok(parity > 400, 'the sk- parity corpus is not empty (' + parity + ' shape x context pairs base hid)');
  A.eq(misses, [], 'every sk- key the base rule hid is still hidden (svcacct/admin/None/LiteLLM/Langfuse/letters-only, after \\b \\f \\uXXXX, ANSI, =3D, %253D, glued, glued and masked, glued to a vowel)');
  // r3: the 7 corpus cases 8399010e0 left readable, named one by one (the parity loop above covers them; these say which)
  const byK = id => SK.find(x => x.id === id);
  for (const [id, cn] of [['GENLETTERS', 'glued_letter'], ['GENLETTERS', 'glued_word'], ['GENLETTERS', 'glued_digit'], ['GENLETTERS', 'glued_alnum'],
    ['ADMIN_NODIGIT', 'glued_masked'], ['LITELLM', 'glued_masked'], ['GENLETTERS', 'glued_masked']])
    A.ok(hidden(context.redact(CTX[cn](byK(id).value)), byK(id)), 'r3 corpus row ' + id + '|' + cn + ' is hidden: ' + JSON.stringify(context.redact(CTX[cn](byK(id).value)).slice(0, 60)));
  {
    const L = byK('GENLETTERS');
    const obj = { api_key: L.value, nested: { note: 'x\n' + L.value, arr: ['abc' + L.value, { cookie: 'c' }] } };
    A.ok(hidden(JSON.stringify(context.redact(obj)), L), 'r3 corpus row GENLETTERS|object: a letters-only key glued inside a nested array is hidden');
  }
  const vmiss = [];
  for (const key of VENDOR) for (const [cn, fn] of Object.entries(CTX)) {
    // a vendor key glued to a word is a word ending (the \b rules' contract); a quoted-printable soft break splits the
    // key in two, and no fixed-length vendor rule matched either half at 41c298d9a (only the generic sk- rule does)
    if (/^glued_/.test(cn) || cn === 'underscore' || cn === 'qp_softbreak') continue;
    const out = context.redact(fn(key.value));
    if (!hidden(out, key)) vmiss.push(key.id + '|' + cn + ' -> ' + JSON.stringify(out.slice(0, 90)));
  }
  A.eq(vmiss, [], 'every vendor key is caught in every context, right after a JSON / URL / quoted-printable / ANSI escape included');
  // byte-identical ordinary text: hyphenated slugs (whole, cut by … / ... / ** and Title-Case), word-like sk- text, ids, model names
  for (const slug of ['Build the task-management-dashboard', 'desk-assignment-overseer-lane', 'risk-assessment-framework-for-q4-planning', 'whisk-together-the-ingredients-now',
    'disk-usage-report-generator-v2', 'ask-the-commander-about-schedules-weekly', 'flask-sqlalchemy-integration-guide', 'mask-rcnn-instance-segmentation-2023',
    'brisk-walking-schedule-2024-weekly', 'task-1730000000000-abc123def456', 'desk-ops-2024-10-28-night',
    'the kiosk-mode-installation-guide-for-retail-2024', 'pip install scikit-learn', 'Write the sk-learn-tutorial',
    'Build the task-management-dashboard…', 'title desk-assignment-overseer-lane...', 'title risk-assessment-framework-for-q4-pla…', 'see task-management-dash**',
    'Desk-Assignment-Overseer-Lane', 'Build the Task-Management-Dashboard-For-Q4…', 'migrate task-GitHub-Actions-pipeline-now', 'title whisk-together-the-ingre…',
    'title task-Sprint-Q4-Review…', 'title desk-admin-Settings-Page…',
    'claude-sonnet-4-5-20250929', 'time 20261028:1230', 'AKIA is the AWS prefix', 'x\\nAIza is the Google prefix', 'see %3Dghp_ in the docs'])
    A.eq(context.redact(slug), slug, 'context.redact keeps ' + JSON.stringify(slug));
  // r3: glued to anything but a lowercase vowel, a body reads as base read it — a base64 fragment holding 'sk-' after a
  // consonant ('AbCdEf' + 'sk-' + 19) is indistinguishable from a key glued to a word, and base hid it too
  A.eq(context.redact('AbCdEfsk-0123456789abcdefXYZ'), 'AbCdEf[redacted-key]', "a glued sk- body after a consonant is redacted as base redacted it");
  // r3: the prompt-scrub mirror — a vowel-glued key cut at a LINE END (no mask), where context.redact cannot see a cut
  PS.setHeldSource(null);
  const L = byK('GENLETTERS'), LIT = byK('LITELLM');
  for (const [label, text, key] of [['letters-only, 19 chars at the end of the text', 'title da' + L.value.slice(0, 22), L],
    ['letters-only, 16 chars before a line break', 'title da' + L.value.slice(0, 19) + '\nnext line', L],
    ['letters-only, before a closing quote', '"value' + L.value.slice(0, 21) + '" (recipe)', L], ['LiteLLM, 18 chars at the end', 'title openai' + LIT.value.slice(0, 21), LIT]]) {
    const o = PS.scrubStored(text);
    A.ok(hidden(o, key) && o.indexOf('[redacted-key]') >= 0, 'r3 mirror: a vowel-glued cut key is scrubbed (' + label + '): ' + JSON.stringify(o));
  }
  for (const t of ['Build the task-management-dashboard', 'title desk-assignment-overseer-la', 'title risk-assessment-framework-for-q4', '"title whisk-together-the-ingredients"'])
    A.eq(PS.scrubStored(t), t, 'r3 mirror: a slug at a cut point stays: ' + t);
  // FIELD ASSIGNMENTS: the credential after an auth scheme is the value; a placeholder is not a credential
  for (const keep of ['headers {"Authorization": "Bearer ${INSTANTLY_API_KEY}"}', 'api_key=${INSTANTLY_API_KEY}', 'Authorization: Bearer <token>',
    '"password": "{{ secrets.DB_PASSWORD }}"', 'set api_key=%OPENAI_API_KEY% first', '"api_key": "[redacted-secret]"'])
    A.eq(context.redact(keep), keep, 'a field holding a placeholder is left alone: ' + keep);
  // r3: a placeholder counts only as the WHOLE value — a real credential that merely BEGINS like one is redacted, as base did
  const tail = FK.stream('c-ph-tail', 14, ALNUM);
  for (const [text, want] of [['password=<Tr0ub4dor&3xq', 'password=[redacted-secret]&3xq'], ['password: <' + tail + '!', 'password: [redacted-secret]'],
    ['"password": "<' + tail + '"', '"password": "[redacted-secret]"'], ['client_secret={{x}}' + tail, 'client_secret=[redacted-secret]'],
    ['api_key=${HOME}' + tail, 'api_key=[redacted-secret]'], ['password=%C3%A9' + tail, 'password=[redacted-secret]'],
    ['access_token=%TOKEN%' + tail, 'access_token=[redacted-secret]'], ['Authorization: Token <' + tail, 'Authorization: Token [redacted-secret]'],
    ['Authorization: Bearer <script>' + tail, 'Authorization: Bearer [redacted-secret]']]) {
    A.eq(context.redact(text), want, 'r3: a value that only begins like a placeholder is redacted: ' + JSON.stringify(text));
    const out = PS.scrubStored(text);
    A.ok(out.indexOf(tail) < 0 && out.indexOf('Tr0ub4dor') < 0, 'r3: scrubStored hides it too: ' + JSON.stringify(text) + ' -> ' + JSON.stringify(out));
  }
  // …and a whole placeholder stays, at the end of a sentence, inside a quote, a JSON escape or a closing bracket
  for (const keep of ['Set api_key=${INSTANTLY_API_KEY}.', 'f(api_key={{ api_key }})', '"password": "<your password here>"', 'x={"api_key":"${KEY}\\"}',
    'api_key=[INSTANTLY_API_KEY saved in API KEYS] (saved)', 'export PASSWORD=%DB_PASSWORD%&& run'])
    A.eq(context.redact(keep), keep, 'r3: a whole placeholder is left alone: ' + keep);
  // r3: a shell / code REFERENCE to a saved key is not the key: keys.save tells the model 'in the shell it is the env var
  // NAME', and a clean station's stored instructions said 'Bearer $INSTANTLY_API_KEY' — r2 turned it into 'Bearer
  // [redacted-secret]' in every tool result and internal run, and a read-modify-write saved the placeholder back
  for (const keep of ['curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.x', 'api_key=$STRIPE_API_KEY in the shell', 'use -H "Authorization: Basic $B64CREDS"',
    '[{"objective":"run curl -s -H \\"Authorization: Bearer $INSTANTLY_API_KEY\\" \\"https://api.instantly.ai/v2\\""}]',
    '-Headers @{ Authorization = "Bearer $env:OPENAI_API_KEY" }', 'apiKey: process.env.EXAMPLE_API_KEY,', "api_key = os.environ['OPENAI_API_KEY']",
    'client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))', 'token: process.env["GH_TOKEN"]']) {
    A.eq(context.redact(keep), keep, 'r3: an env-var reference after a field or scheme is left alone (context.redact): ' + keep);
    A.ok(PS.scrubStored(keep) === keep, 'r3: …and through scrubStored: ' + keep);
  }
  for (const [text, want] of [['password=$Summer2024x', 'password=[redacted-secret]'], ['password=$ecurePassword', 'password=[redacted-secret]'],
    ['api_key=$ABC' + tail, 'api_key=[redacted-secret]'], ['password=$env:' + tail + '!', 'password=[redacted-secret]']])
    A.eq(context.redact(text), want, 'r3: a password that only starts with $ is still redacted: ' + JSON.stringify(text));
  PS.setHeldSource(() => [{ value: by.VAULT.value, as: '[INSTANTLY_API_KEY saved in API KEYS]' }]);
  A.eq(PS.scrubStored('api_key=' + by.VAULT.value + ' for the campaigns'),'api_key=[INSTANTLY_API_KEY saved in API KEYS] for the campaigns', 'r3: a held key under a field name keeps its saved NAME (the field rule does not eat it)');
  PS.setHeldSource(null);
  const basic = 'Basic ' + Buffer.from('admin:' + FK.stream('c-basic', 14, ALNUM)).toString('base64');
  A.eq(context.redact('Authorization: ' + basic), 'Authorization: Basic [redacted-secret]', 'Authorization: Basic <credential> -> the credential is redacted, the scheme kept');
  A.eq(context.redact('curl -H "Authorization: Bearer api_key: ' + FK.stream('c-ak', 22, ALNUM) + '"'), 'curl -H "Authorization: [redacted-secret] api_key: [redacted-secret]"', 'a scheme followed by another field name is two assignments, both redacted');
  A.eq(context.redact('password=' + FK.stream('c-pw', 14, ALNUM)), 'password=[redacted-secret]', 'a plain field value is still redacted');
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
  // names are read by WHOLE segments (review r2): a password-shaped value under a credential name is held; a public
  // value under a name that merely CONTAINS key/token/pass/auth/session is not
  const PW = 'Tr0ub4dor&3!xq#Z';
  const heldUnder = (name, value) => collectSecretValues([{ keyed: [{ env: { [name]: value } }], credentialUnder: ['env'] }]).indexOf(value) >= 0;
  for (const name of ['MYSQL_PWD', 'SMTP_PWD', 'DB_PW', 'REDIS_PW', 'ADMIN_PIN', 'X-Admin-Pin', 'HMAC_SALT', 'X-Api-Sig', 'LICENSE', 'SENTRY_DSN', 'X-Db-Pwd',
    'CONNECTION_STRING', 'X-Access-Code', 'OTP_SEED', 'WEBHOOK_SIGNING', 'HUBSPOT_PAT', 'PGPASSWORD', 'TOTP_SECRET', 'ENCRYPTION_KEY', 'apiKey', 'clientSecret',
    'X-Api-Key', 'Authorization', 'DB_PASSWORD', 'SESSION_ID', 'Cookie', 'AWS_SECRET_ACCESS_KEY'])
    A.ok(heldUnder(name, PW), 'a credential NAME holds its value: ' + name);
  for (const [name, value] of [['KEYCLOAK_REALM', 'production'], ['MONKEY_NAME', 'production-mon'], ['OAUTH_REDIRECT_URI', 'http://localhost:3000/callback'],
    ['COMPASS_PROJECT', 'marketing-site'], ['TOKENIZER', 'cl100k_base'], ['SESSION_REGION', 'us-east-1'], ['AUTH0_DOMAIN', 'tenant.us.auth0.com'],
    ['PASSPORT_STRATEGY', 'google-oauth'], ['AWS_ACCESS_KEY_ID', 'AKIAEXAMPLEEXAMPLE'], ['KEY_FILE', '/home/me/keys/sa.json'], ['NODE_ENV', 'production']])
    A.ok(!heldUnder(name, value), 'a public value under a name that only CONTAINS a credential word is not held: ' + name);
  PS.setHeldSource(() => collectSecretValues([{ keyed: [{ env: { KEYCLOAK_REALM: 'production', OAUTH_REDIRECT_URI: 'http://localhost:3000/callback', COMPASS_PROJECT: 'marketing-site', TOKENIZER: 'cl100k_base' } }], credentialUnder: ['env'] }]));
  const turn = 'Deploy marketing-site to production; redirect is http://localhost:3000/callback (tokenizer cl100k_base)';
  A.ok(PS.scrubHeld(turn) === turn, 'the live turn naming those public values is byte-identical');
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
