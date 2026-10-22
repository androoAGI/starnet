/* sidecar/provider-accounts.js — EXTRA sign-in accounts for a subscription provider (subscription stacking).

   A subscription provider (Claude Code, ChatGPT/Codex, Grok, Kimi) has ONE primary sign-in — the one its existing
   store already holds (the CLI's own ~/.claude, codex/tokens.json, <id>/tokens.json). The Commander can connect
   MORE accounts of the same provider; when the account a run is on hits its usage limit, the run fails over to the
   next one (index.js runOnce builds the chain, credpool.js cools the spent account).

   Each extra account is one folder: WORKSPACES/.secrets/accounts/<provider>/<id>/. The dotted .secrets root is out
   of every agent's file jail (agent ids never contain a dot) and /api/file refuses it. What lives inside belongs to
   the provider's own store: for Claude Code the folder IS the CLI's CLAUDE_CONFIG_DIR (the CLI writes its own
   credential there — Agent OS never reads it); for the OAuth providers it holds that account's tokens.json.
   account.json carries only { id, seq } — no email, no token — so listing accounts never touches a credential.

   makeProviderAccounts({ root, fs?, path?, randomId? }) -> {
     list(provider)        -> [{ id, seq, dir }]   oldest first; unreadable/foreign folders are skipped
     add(provider)         -> { id, seq, dir }
     remove(provider, id)  -> boolean             deletes the folder (the caller signs the account out first)
     dir(provider, id)     -> string | null       null for an unknown provider or a malformed id
   } */
'use strict';

const PROVIDERS = ['claude-cli', 'codex', 'grok', 'kimi'];
const MAX_ACCOUNTS = 7;                 // + the primary = 8, the API-key pool's ceiling (credpool MAX_KEYS)
const ID_RE = /^[a-f0-9]{8,32}$/;

function makeProviderAccounts(opts) {
  opts = opts || {};
  const fs = opts.fs || require('fs');
  const path = opts.path || require('path');
  const root = opts.root;
  if (!root) throw new Error('provider-accounts: root is required');
  const randomId = opts.randomId || (() => require('crypto').randomBytes(6).toString('hex'));

  function providerDir(provider) {
    return PROVIDERS.indexOf(provider) >= 0 ? path.join(root, provider) : null;
  }
  function dir(provider, id) {
    const base = providerDir(provider);
    if (!base || !ID_RE.test(String(id || ''))) return null;
    return path.join(base, String(id));
  }

  function list(provider) {
    const base = providerDir(provider);
    if (!base) return [];
    let names;
    try { names = fs.readdirSync(base); } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      if (!ID_RE.test(name)) continue;
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(base, name, 'account.json'), 'utf8')); } catch (_) { meta = null; }
      if (!meta || meta.id !== name) continue;
      out.push({ id: name, seq: Number(meta.seq) || 0, dir: path.join(base, name) });
    }
    out.sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : 1));
    return out;
  }

  function add(provider) {
    const base = providerDir(provider);
    if (!base) throw new Error('this provider does not take extra accounts: ' + provider);
    const have = list(provider);
    if (have.length >= MAX_ACCOUNTS) throw new Error('at most ' + MAX_ACCOUNTS + ' extra accounts per provider');
    const seq = have.reduce((m, a) => Math.max(m, a.seq), 0) + 1;
    let id = '';
    for (let i = 0; i < 5 && (!id || have.some(a => a.id === id)); i++) id = String(randomId());
    if (!ID_RE.test(id)) throw new Error('provider-accounts: bad generated id');
    const d = path.join(base, id);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(d, 'account.json'), JSON.stringify({ id, seq }), { encoding: 'utf8', mode: 0o600 });
    return { id, seq, dir: d };
  }

  function remove(provider, id) {
    const d = dir(provider, id);
    if (!d) return false;
    try { fs.statSync(d); } catch (_) { return false; }
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  }

  return { list, add, remove, dir, MAX: MAX_ACCOUNTS };
}

module.exports = { makeProviderAccounts, PROVIDERS, MAX_ACCOUNTS };
