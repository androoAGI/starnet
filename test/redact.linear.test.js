/* node test/redact.linear.test.js — redact() runs in linear time on delimiter-dense text, and redacts EXACTLY what the
   old plain regex scans did.

   THE BUG (perf review 2026-10-19): four SECRET_PATTERNS shapes were quadratic as plain global scans. Each start
   position inside one long run re-scanned that run to its end: the masked-key rule on "sk-.sk-.…", the URL-password
   rule on "a.a.a.…" (any dotted or dashed text), the JWT rule on "eyJ-eyJ-…" (found in lane review, not named in the
   perf report), and the private-key rule on a page of BEGIN headers with no END.
   80 KB of crafted page content cost seconds per redact() pass, and every tool result takes at least two.
   Part 1 drives the REAL redact() on those inputs under a time bound (it fails on the old code).
   Part 2 pins the four regexes to their old literals, then diffs each driver against the plain s.replace() scan,
   and the whole redact() against the plain scan of every pattern, on adversarial and seeded random input.
   Redaction must never get weaker: any difference at all is a failure. */
'use strict';
const A = require('./_assert.js');
const C = require('../sidecar/context.js');
const { redact } = C;
C.setKnownSecretSource(null);   // shape redaction only: the oracle below knows nothing about held values

const ms = fn => { const t = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const BOUND = 300;   // the old scans need 1,700-4,400 ms on the 80 KB inputs (1,000 ms on the 320 KB header page)

// ---- 1. the real call path stays fast ----
{
  const cases = [
    ['dotted text a.a.a. (80 KB)', 'a.'.repeat(40000)],
    ['dashed text x-x-x- (80 KB)', 'x-'.repeat(40000)],
    ['sk-.sk-. (80 KB)', 'sk-.'.repeat(20000)],
    ['AIza.AIza. (80 KB)', 'AIza.'.repeat(16000)],
    ['ya29.ya29. (80 KB)', 'ya29.'.repeat(16000)],
    ['sk-a.sk-a. (80 KB)', 'sk-a.'.repeat(16000)],
    ['xapp-1- (80 KB)', 'xapp-1-'.repeat(11500)],
    ['BEGIN PRIVATE KEY headers with no END (320 KB)', '-----BEGIN PRIVATE KEY-----'.repeat(12000)],
    ['eyJ-eyJ- (80 KB)', 'eyJ-'.repeat(20000)],
    ['eyJa-eyJa- (80 KB)', 'eyJa-'.repeat(16000)],
    ['eyJ_eyJ_ with a dot every 4 KB (80 KB)', ('eyJ_'.repeat(1000) + '.').repeat(20)],
  ];
  for (const [label, input] of cases) {
    const r = ms(() => redact(input));
    A.ok(r.ms < BOUND, 'redact() on ' + label + ' takes ' + r.ms.toFixed(1) + ' ms (bound ' + BOUND + ')');
  }
  // the fast path still redacts: a real secret at the END of a long adversarial run is caught
  A.eq(redact('a.'.repeat(5000) + 'b://u:hunter2@h'), 'a.'.repeat(5000) + 'b://u:[redacted-secret]@h', 'a URL password after a long dotted run is scrubbed');
  // the whole dotted run is ONE key body ending in a mask, exactly as the plain scan reads it
  A.eq(redact('sk-.'.repeat(5000) + 'sk-Ab12****Wx9Z'), '[redacted-key]', 'a masked key at the end of a long sk-. run is scrubbed from its first prefix');
  A.eq(redact('sk-. '.repeat(500) + 'sk-Ab12****Wx9Z'), 'sk-. '.repeat(500) + '[redacted-key]', 'a masked key after many spaced sk-. stubs is scrubbed on its own');
  A.eq(redact('-----BEGIN X'.repeat(500) + '-----BEGIN RSA PRIVATE KEY-----\nMIIx\n-----END RSA PRIVATE KEY-----'),
    '-----BEGIN X'.repeat(500) + '[redacted-private-key]', 'a private key after many malformed headers is scrubbed');
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  A.eq(redact('eyJ- '.repeat(500) + JWT), 'eyJ- '.repeat(500) + '[redacted-jwt]', 'a JWT after many spaced eyJ- stubs is scrubbed on its own');
  A.eq(redact('eyJ-'.repeat(5000) + JWT), '[redacted-jwt]', 'a JWT at the end of a long eyJ- run is scrubbed from its first eyJ, as the plain scan reads it');
}

// ---- 2. identical to the old plain scans ----
const OLD_MASKED = /\b(?:(?:sk|pk|rk|xai|pplx|glpat|xox[abeprs])-|sk_(?:live|test)_|(?:gsk|hf|gh[pousr]|whk|ntn|lin_api)_|AIza|ya29\.)[-_.A-Za-z0-9]*?(?:[*•]{2,}|…|\.{3})(?:[-_A-Za-z0-9*•…]|\.{3})*/g;
const OLD_PRIVATE = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g;
// review r3 (2026-10-28): the URL password never runs past a '"' or a '\' (in a compact JSON result it ran across fields)
const OLD_URL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:\/?#@]*:)(?!\[redacted-)[^\s\/?#"\\]+(?=@)/gi;
const OLD_JWT = /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g;
const pats = (C._internals && typeof C._internals.secretPatterns === 'function') ? C._internals.secretPatterns() : [];
A.ok(pats.length > 0, 'the pattern list is reachable for the diff');
const driven = pats.filter(p => p.driven);
A.eq(driven.map(p => [p.re.source, p.re.flags, p.rep]), [[OLD_MASKED.source, 'g', '[redacted-key]'], [OLD_PRIVATE.source, 'g', '[redacted-private-key]'],
  [OLD_JWT.source, 'g', '[redacted-jwt]'], [OLD_URL.source, 'gi', '$1[redacted-secret]']],
  'exactly the four quadratic shapes run through a driver, and their regexes are the old ones unchanged');
const plainAll = s => pats.reduce((acc, p) => acc.replace(p.re, p.rep), s);

let seed = 0xc0ffee;   // mulberry32: deterministic, and every output bit is usable (a float LCG degenerates)
const rnd = n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
const pick = a => a[rnd(a.length)];
const make = (pieces, max) => { let s = ''; const n = 1 + rnd(max); for (let i = 0; i < n; i++) s += pick(pieces); return s; };

const PREFIXES = ['sk-', 'pk-', 'rk-', 'xai-', 'pplx-', 'glpat-', 'xoxb-', 'xoxa-', 'xoxs-', 'sk_live_', 'sk_test_', 'gsk_', 'hf_', 'ghp_', 'gho_', 'ghr_', 'whk_', 'ntn_', 'lin_api_', 'AIza', 'ya29.'];
const MASKED_PIECES = PREFIXES.concat(['sk', 'sk_', 'ya29', 'AI', 'lin_', 'xox', 'a', 'Z', '0', '9', '-', '_', '.', '.', '..', '...', '*', '**', '•', '••', '…', '*•',
  ' ', '\n', '@', ':', '/', '"', ',', 'x', 'é', 'proj-', 'or-v1-']);
const URL_PIECES = ['a', 'b', 'git', 'http', 'x+y', 'Z', '1', '.', '-', '+', '_', '://', '://', ':', ':', '//', '/', '@', '@', '@@', '?', '#', ' ', '\t', '\u00a0', '\n',
  '[redacted-', '[REDACTED-', 'p', 'é', '\u212a', '\u017f', '\u0131', '%40', 'u:p', 'h.com', 'http://', 'a://', 'u:p@', ':pw@', 'x://y:z@', 'git+ssh://', '"', '\\', '\\"', '","o":"'];
const PRIV_PIECES = ['-----BEGIN ', '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN ec PRIVATE KEY-----', '-----END PRIVATE KEY-----',
  '-----END EC PRIVATE KEY-----', '-----END ', '-----', '-', 'RSA ', 'PRIVATE KEY-----', 'BEGIN ', '\n', 'abc', ' '];
const JWT_PIECES = ['eyJ', 'eyJ', 'eyJ', 'eyJhbGciOiJ', 'eyJabcdefgh.', 'eyJAb12_-x9.eyJ', 'eyJa.eyJabcdefgh.', 'abcdefgh.', '.eyJ', '.eyJ', '.eyJ12345678.',
  'abcdefgh', 'Ab12_-x9', '12345678', 'abcd', 'a', 'Z', '0', '_', '-', '-', '.', '.', '..',
  ' ', '\n', '@', ':', '/', '"', '=', '+', 'é', 'xeyJ', 'eyj', 'EyJ', 'ey', 'J', '[redacted-jwt]'];
const ALL_PIECES = MASKED_PIECES.concat(URL_PIECES, PRIV_PIECES, JWT_PIECES, ['password=', 'api_key: "', 'Bearer ', 'sk-or-v1-', 'abcdefghijklmnopqrstuvwxyz0123456789', '12345678:', 'eyJ']);

const families = [
  [OLD_MASKED.source, MASKED_PIECES], [OLD_PRIVATE.source, PRIV_PIECES], [OLD_URL.source, URL_PIECES], [OLD_JWT.source, JWT_PIECES],
];
for (const [src, pieces] of families) {
  const p = driven.find(d => d.re.source === src);
  if (!p || typeof p.run !== 'function') { A.ok(false, 'driver missing for ' + src.slice(0, 40)); continue; }
  let bad = 0, hits = 0;
  const check = (s, why) => {
    const want = s.replace(p.re, p.rep), got = p.run(s);
    if (want !== s) hits++;
    if (got !== want) { bad++; if (bad <= 6) A.eq(got, want, 'driver differs from the plain scan on ' + JSON.stringify(s) + ' (' + why + ')'); }
  };
  for (let n = 0; n < 25000; n++) check(make(pieces, 30), 'random #' + n);
  // adversarial: long dense runs with a real hit buried at a random place
  for (let n = 0; n < 300; n++) {
    const unit = make(pieces, 4), filler = unit.repeat(1 + rnd(60));
    check(filler + make(pieces, 12) + filler.slice(rnd(filler.length + 1)), 'dense #' + n);
  }
  A.eq(bad, 0, 'driver for /' + src.slice(0, 32) + '…/ matches the plain scan on every input (' + hits + ' inputs it redacted)');
  A.ok(hits > 500, 'the fuzz really exercised redactions for /' + src.slice(0, 32) + '…/ (' + hits + ')');
}
{
  let bad = 0;
  for (let n = 0; n < 15000; n++) {
    const s = make(ALL_PIECES, 40);
    const want = plainAll(s), got = redact(s);
    if (got !== want) { bad++; if (bad <= 6) A.eq(got, want, 'redact() differs from the plain scan of every pattern on ' + JSON.stringify(s)); }
  }
  // object and array payloads go through the same string path
  const obj = { a: 'x://u:p@h a.a.a sk-.sk-Ab**', b: ['-----BEGIN PRIVATE KEY-----\nz\n-----END PRIVATE KEY-----'] };
  A.eq(redact(obj), { a: plainAll(obj.a), b: [plainAll(obj.b[0])] }, 'nested payloads redact identically');
  A.eq(bad, 0, 'redact() equals the plain scan of every pattern on every mixed input');
}

A.report('redact.linear.test');
