'use strict';
/* test/helpers/fake-keys.js — FAKE key-shaped strings for the prompt-scrub tests (context-key-redact, 2026-10-28).

   Built at runtime from a fixed seed (sha256 stream), so no key-shaped literal lives in the repo for a secret scanner
   to flag, and a test re-run greps for byte-identical values. None of these is a credential: each is shaped only to
   match its vendor family's documented prefix + length.

   windows(value, prefix?, n = 12) lists every n-char window of the value's SECRET part (the body after its public
   vendor prefix) — what an invariant asserts never reaches a model prompt, whole or cut. */
const crypto = require('node:crypto');

function stream(seed, n, alphabet) {
  let out = '', i = 0;
  while (out.length < n) {
    const h = crypto.createHash('sha256').update('starnet-fake-key:' + seed + ':' + (i++)).digest();
    for (const b of h) { if (out.length >= n) break; out += alphabet[b % alphabet.length]; }
  }
  return out;
}
const HEX = '0123456789abcdef';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function make(seed) {
  seed = String(seed || 'default');
  const k = (id, prefix, body) => ({ id, prefix, body, value: prefix + body });
  const list = [
    k('OPENROUTER', 'sk-or-v1-', stream(seed + 'or', 64, HEX)),
    k('OPENAI', 'sk-proj-', stream(seed + 'oai', 48, ALNUM)),
    k('ANTHROPIC', 'sk-ant-api03-', stream(seed + 'ant', 90, ALNUM)),
    k('GOOGLE', 'AIza', stream(seed + 'goog', 35, ALNUM)),
    k('GITHUB', 'ghp_', stream(seed + 'gh', 36, ALNUM)),
    k('SLACK', 'xoxb-', '7351942086-4820193756241-' + stream(seed + 'slack', 24, ALNUM)),
    // shapeless: a 32-alnum vendor key (Instantly/Saleshandy-like) — only ever caught once the station HOLDS it
    k('VAULT', '', 'Rq7' + stream(seed + 'vault', 29, ALNUM)),
    // a second OpenAI project key, typed only in a directive the agent then clarifies
    k('ASKKEY', 'sk-proj-', stream(seed + 'ask', 48, ALNUM))
  ];
  const by = {};
  for (const x of list) by[x.id] = x;
  return { list, by };
}

function windows(key, n) {
  n = n || 12;
  const body = key.body, out = [];
  for (let i = 0; i + n <= body.length; i++) out.push(body.slice(i, i + n));
  return out;
}

// the first leak of `key` in `text` — the full value or any 12-char window of its secret part — or null
function leak(text, key, n) {
  text = String(text == null ? '' : text);
  if (text.indexOf(key.value) >= 0) return 'full';
  for (const w of windows(key, n)) if (text.indexOf(w) >= 0) return 'window:' + w.slice(0, 4) + '…';
  return null;
}

module.exports = { make, windows, leak, stream };
