/* sidecar/servicekeys.js — custom service API keys (the KEYS tab's "add an unlisted platform" store).

   A third credential class beside provider keys (model access) and connector/channel tokens (MCP auth):
   "the user's key for ANY external service" — pasted once in TOOLSETS & CONNECTORS → KEYS, consumed by
   agents as an environment variable in their shell runs (spawn inherits process.env), and advertised to
   the model by NAME ONLY via a system-prompt block. The value itself never rides the prompt, the bus, or
   any /api response (list responses carry a masked last4) — truthful telemetry applies to secrets too.

   This is the pure, deterministic core (secrets.js idiom): no fs, no process, no ambient env. The host
   (index.js) owns persistence + the real process.env; this module answers:

     deriveEnvVar(name)                  -> 'ACME_CO_API_KEY' (uppercase, non-alnum → '_', collapsed)
     slug(name)                          -> stable record id ('acme-co')
     validate({name,key,docsUrl})        -> { ok } | { ok:false, error }
     mask(key)                           -> '····abcd' (never more than the last 4 chars)
     toPublic(record)                    -> the list-response shape: NO key, masked last4
     upsert(list, {name,key,docsUrl}, now, {reservedEnv})
                                         -> { list, record } | { error }   (same name = update in place;
                                            an empty key on update KEEPS the saved key, like mc-token;
                                            a name deriving a RESERVED env var — a model-provider keyEnv —
                                            is refused: a KEYS paste must never become billing credentials)
     setEnabled(list, id, enabled)       -> { list, record } | { error }
     remove(list, id)                    -> { list, removed } | { error }
     applyEnv(list, env, owned, {reservedEnv})
                                         -> owned'  — writes enabled keys into `env`, removes vars WE set
                                            that are gone/disabled, and NEVER clobbers a var that already
                                            existed but isn't ours (a real deployment env wins over a paste).
                                            Reserved (provider) vars are never written — belt to upsert's braces
     promptBlock(list)                   -> the <service_keys> system-prompt block naming env vars (no values);
                                            '' when nothing is enabled (byte-identical no-op for the seam) */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.servicekeys = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NAME_MAX = 64;
  const KEY_MAX = 4096;
  const URL_MAX = 512;
  const LIST_MAX = 100;   // sanity bound, not a product gate

  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX);
  }

  // "Acme Co." -> ACME_CO_API_KEY. Always suffixed _API_KEY unless the name itself already says so
  // ("Foo API key" -> FOO_API_KEY, not FOO_API_KEY_API_KEY). A digit-leading name gets a K_ prefix
  // (env var names can't start with a digit).
  function deriveEnvVar(name) {
    let base = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    base = base.replace(/_?API_?KEY$/, '').replace(/_+$/, '');
    if (!base) return '';
    if (/^[0-9]/.test(base)) base = 'K_' + base;
    return base + '_API_KEY';
  }

  function validate(input) {
    const o = (input && typeof input === 'object') ? input : {};
    const name = String(o.name == null ? '' : o.name).trim();
    if (!name) return { ok: false, error: 'name is required' };
    if (name.length > NAME_MAX) return { ok: false, error: 'name is too long (max ' + NAME_MAX + ' chars)' };
    if (!slug(name)) return { ok: false, error: 'name needs at least one letter or digit' };
    if (!deriveEnvVar(name)) return { ok: false, error: 'name needs at least one letter or digit' };
    if ('key' in o && o.key != null && o.key !== '') {
      const key = String(o.key);
      if (key.length > KEY_MAX) return { ok: false, error: 'key is too long (max ' + KEY_MAX + ' chars)' };
      // one line of printable ASCII (every real API key is) — control chars / spaces are paste accidents
      if (/[^!-~]/.test(key)) return { ok: false, error: 'key must be a single line of printable characters (no spaces or line breaks)' };
    }
    if (o.docsUrl) {
      const u = String(o.docsUrl).trim();
      if (u.length > URL_MAX) return { ok: false, error: 'docs URL is too long' };
      if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'docs URL must start with http:// or https://' };
    }
    return { ok: true };
  }

  function mask(key) {
    const k = String(key || '');
    if (!k) return '';
    return '····' + k.slice(-4);
  }

  function isRecord(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  // the shape every /api response carries — by construction there is no `key` field to leak.
  function toPublic(record) {
    const r = isRecord(record) ? record : {};
    return {
      id: String(r.id || ''),
      name: String(r.name || ''),
      envVar: String(r.envVar || ''),
      docsUrl: String(r.docsUrl || ''),
      enabled: r.enabled !== false,
      autonomous: r.autonomous === true,   // shown so the panel can state the unattended grant honestly
      unattendedSupported: r.unattendedSupported !== false,
      unattendedReason: String(r.unattendedReason || ''),
      addedAt: (typeof r.addedAt === 'number') ? r.addedAt : 0,
      last4: mask(r.key)
    };
  }

  function cleanList(list) { return (Array.isArray(list) ? list : []).filter(isRecord); }

  // normalize a caller-supplied reserved-env option (array or Set of var names) to a lookup Set.
  function reservedSet(opts) {
    const raw = opts && opts.reservedEnv;
    if (raw instanceof Set) return raw;
    return new Set(Array.isArray(raw) ? raw : []);
  }

  // add-or-update by name-slug. Never mutates the input list. `now` injected (no ambient clock).
  // opts.reservedEnv = the host's model-provider keyEnv names (plus STARNET_/SKYNET_ scoped forms):
  // a KEYS paste deriving one of those would silently become BILLING credentials via envFirst()'s
  // process.env read — refused here with a pointer to the right surface instead.
  function upsert(list, input, now, opts) {
    const v = validate(input);
    if (!v.ok) return { error: v.error };
    const src = cleanList(list);
    const name = String(input.name).trim();
    const id = slug(name);
    const prev = src.find(r => r.id === id) || null;
    const key = (input.key == null || input.key === '') ? (prev ? String(prev.key || '') : '') : String(input.key);
    if (!key) return { error: 'key is required' };
    if (!prev && src.length >= LIST_MAX) return { error: 'too many service keys (max ' + LIST_MAX + ')' };
    const envVar = deriveEnvVar(name);
    if (reservedSet(opts).has(envVar)) {
      // "Google" / "Gemini" / "OpenAI" collide with a model provider's key var, but users mostly mean a NON-model
      // API from that company (Maps, YouTube, Places, image gen). Say how to save it here instead of dead-ending.
      return { error: name + ' would be saved as ' + envVar + ', which is reserved for the ' + name + ' model provider key (add AI model keys under SETTINGS). '
        + 'For a different ' + name + ' API, name it after the product instead — e.g. "' + name + ' Maps" or "' + name + ' YouTube"' };
    }
    // a rename collision (two names deriving the same env var under different ids) would silently
    // shadow one key with the other in the run env — refuse it instead.
    if (src.some(r => r.id !== id && r.envVar === envVar)) return { error: 'another entry already uses ' + envVar };
    const unattendedSupported = input.unattendedSupported !== false;
    const unattendedReason = unattendedSupported ? '' : String(input.unattendedReason || 'unattended use is not supported for this integration').slice(0, 240);
    const record = {
      id: id, name: name, envVar: envVar, key: key,
      docsUrl: input.docsUrl ? String(input.docsUrl).trim() : (prev ? String(prev.docsUrl || '') : ''),
      enabled: prev ? (prev.enabled !== false) : true,
      // UNATTENDED GRANT — default OFF, and never inferred. `enabled` means "an agent may spend this key
      // while you are watching"; `autonomous` additionally means "...and while you are not". A scheduled,
      // Night-Shift, or messaged run can only spend a key carrying this flag, so adding a key never
      // silently widens what happens overnight. Preserved across edits; only setAutonomous flips it.
      autonomous: unattendedSupported && prev ? (prev.autonomous === true) : false,
      unattendedSupported: unattendedSupported,
      unattendedReason: unattendedReason,
      addedAt: prev ? (prev.addedAt || 0) : (typeof now === 'number' ? now : 0)
    };
    return { list: src.filter(r => r.id !== id).concat([record]), record: record };
  }

  function setEnabled(list, id, enabled) {
    const src = cleanList(list);
    const prev = src.find(r => r.id === String(id || ''));
    if (!prev) return { error: 'no such service key' };
    const record = Object.assign({}, prev, { enabled: !!enabled });
    return { list: src.map(r => (r.id === prev.id ? record : r)), record: record };
  }

  // Flip the unattended grant. Turning a key OFF entirely also revokes it for unattended use implicitly
  // (resolveForRequest requires enabled AND autonomous), so there is no "granted but disabled" hole.
  function setAutonomous(list, id, autonomous) {
    const src = cleanList(list);
    const prev = src.find(r => r.id === String(id || ''));
    if (!prev) return { error: 'no such service key' };
    if (autonomous && prev.unattendedSupported === false) return { error: prev.unattendedReason || 'unattended use is not supported for this integration' };
    const record = Object.assign({}, prev, { autonomous: !!autonomous });
    return { list: src.map(r => (r.id === prev.id ? record : r)), record: record };
  }

  /* Resolve a `${ENV_VAR}` placeholder for an outbound request. Returns a discriminated result rather
     than throwing, so the caller can turn each refusal into an actionable tool error:
       { ok:true, value }                      — spend it
       { ok:false, reason:'unknown' }          — no such key (or it is disabled)
       { ok:false, reason:'unattended', name } — real key, but not granted for unattended runs
       { ok:false, reason:'reserved' }         — a model-provider key name (opts.reservedEnv): KEYS can never
                                                 hold one, so no Commander action can make it resolve
     `surface` is the RUN's surface, not the user's intent: an autonomous run can never talk itself
     into a grant, because the flag lives on the stored record and nothing in the run can write it. */
  function resolveForRequest(list, envVar, surface, opts) {
    const want = String(envVar || '').trim();
    if (!want) return { ok: false, reason: 'unknown' };
    // Checked before the list: a legacy or hand-edited row carrying a provider var is still never spent here.
    if (reservedSet(opts).has(want)) return { ok: false, reason: 'reserved' };
    const row = cleanList(list).find(r => r.envVar === want && r.enabled !== false && r.key);
    if (!row) return { ok: false, reason: 'unknown' };
    if (surface !== 'interactive' && (row.autonomous !== true || row.unattendedSupported === false)) {
      return {
        ok: false,
        reason: 'unattended',
        name: row.name,
        detail: row.unattendedSupported === false ? String(row.unattendedReason || 'unattended use is not supported for this integration') : ''
      };
    }
    return { ok: true, value: String(row.key), name: row.name };
  }

  function remove(list, id) {
    const src = cleanList(list);
    const prev = src.find(r => r.id === String(id || ''));
    if (!prev) return { error: 'no such service key' };
    return { list: src.filter(r => r.id !== prev.id), removed: prev };
  }

  /* Write every ENABLED key into `env` and return the new owned-set (env var name -> true).
     Ownership is the clobber guard: we only ever DELETE or OVERWRITE a var that WE set on a previous
     apply (`owned`), so a var the operator exported before launch (a real RESEND_API_KEY in the shell
     env) always wins over a pasted one — the paste is simply skipped and stays skipped until the
     ambient var goes away. Disabled/removed keys we own are scrubbed from env. */
  function applyEnv(list, env, owned, opts) {
    const e = env || {};
    const prevOwned = (owned && typeof owned === 'object') ? owned : {};
    const nextOwned = {};
    const want = {};
    const reserved = reservedSet(opts);
    for (const r of cleanList(list)) {
      if (r.enabled === false) continue;
      if (reserved.has(r.envVar)) continue;   // a pre-guard persisted record must still never shadow a provider key
      if (r.envVar && r.key) want[r.envVar] = String(r.key);
    }
    for (const k of Object.keys(want)) {
      if ((k in e) && !prevOwned[k]) continue;   // ambient var wins; never clobber what isn't ours
      e[k] = want[k];
      nextOwned[k] = true;
    }
    for (const k of Object.keys(prevOwned)) {
      if (!(k in want) && prevOwned[k]) { try { delete e[k]; } catch (_) {} }
    }
    return nextOwned;
  }

  /* The env map a shell run must actually RECEIVE. Names of the ENABLED keys, resolved from the HOST
     env that applyEnv already populated — so the ambient-wins ownership rule is honoured for free, a
     key pasted after boot is live on the very next run, and a disabled/removed one disappears (applyEnv
     scrubs what it owns). Pure: reads `hostEnv`, never writes it.
     WHY THIS EXISTS: spawn does NOT inherit process.env here. environment.js hands every shell child a
     sanitizeChildEnv() snapshot that strips any name matching _KEY/_TOKEN/_SECRET/… — and deriveEnvVar
     always ends in _API_KEY, so 100% of KEYS-tab entries were stripped while promptBlock still told the
     model the variable was there (the model expanded empty and got a 401). This map is merged back into
     the child env per call; the VALUE still never enters the prompt. */
  /* ⛔ THE UNATTENDED GRANT APPLIES HERE TOO (bug-sweep P0). `opts.surface` is the RUN's surface, exactly as in
     resolveForRequest: on any non-interactive surface a key is handed over ONLY if the Commander flipped its
     unattended grant (`autonomous === true`). Without this, the KEYS tab enforced that grant on web_request
     while a scheduled / night-shift / channel shell child silently received EVERY enabled key — the same
     secret, the same run, two different answers. An ABSENT surface means the caller never wired one; treat it
     as interactive so an un-updated caller behaves exactly as before. */
  function runEnv(list, hostEnv, opts) {
    const src = hostEnv || {};
    const reserved = reservedSet(opts);
    const surface = (opts && opts.surface) || 'interactive';
    const out = {};
    for (const r of cleanList(list)) {
      if (r.enabled === false) continue;
      if (surface !== 'interactive' && (r.autonomous !== true || r.unattendedSupported === false)) continue;   // no unattended support/grant -> no key for an unattended run
      if (!r.envVar || reserved.has(r.envVar)) continue;   // never let a paste shadow a provider/billing key
      const v = src[r.envVar];
      if (v != null && v !== '') out[r.envVar] = String(v);
    }
    return out;
  }

  /* The system-prompt block. NAMES only — the value never enters the prompt (the model uses the env
     var from its shell). '' when nothing is enabled, so the assembly seam stays byte-identical for a
     user with no service keys. The caller gates this on shell.exec being in the run's resolved tools:
     advertising an env var the run can't read would be the exact truthful-telemetry violation the
     quest block comments warn about. */
  function promptBlock(list, opts) {
    const rows = cleanList(list).filter(r => r.enabled !== false && r.envVar && r.key);
    if (!rows.length) return '';
    // WHICH WAY can this run actually spend a key? The block must describe only the routes the run HAS,
    // or it teaches a tool the model wasn't given (the truthful-telemetry violation this block's own
    // history is about). Default to both when unspecified so an un-updated caller stays informative.
    const canShell = !opts || opts.shell !== false;
    const canRequest = !opts || opts.request !== false;
    const lines = rows
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map(r => '- ' + r.name + ': ' + r.envVar
        + (r.unattendedSupported === false ? ' [watched sessions only; unattended unsupported]' : (r.autonomous === true ? '' : ' [watched sessions only]'))
        + (r.docsUrl ? ' (API docs: ' + r.docsUrl + ')' : ''));
    const how = [];
    if (canRequest) how.push('with web_request, by writing the NAME as a placeholder in a header — e.g. '
      + 'headers {"Authorization": "Bearer ${' + rows[0].envVar + '}"} — which the host substitutes at send time. '
      + 'For an API that takes its key as a query parameter (?key=...), pass auth {"key": "' + rows[0].envVar + '", "in": "query", "name": "key"} '
      + 'instead — never put a ${NAME} placeholder in the url or body. '
      + 'web_request can also SEND workspace files to upload endpoints: write ${file:relative/path} in the body '
      + 'where the base64 belongs, or use its multipart parameter — never read and paste file bytes yourself');
    // The shell is cmd.exe on Windows (environment.js spawns shell:true), where $NAME is sent as literal text and
    // the API answers 401. Name the syntax that actually expands on THIS host instead of letting the model guess bash.
    const win = !!(opts && opts.platform === 'win32');
    if (canShell) how.push(win
      ? 'in your shell, where each name is an environment variable. This host is Windows and shell.exec runs cmd.exe: write %'
        + rows[0].envVar + '% (inside powershell -Command use $env:' + rows[0].envVar + '); $' + rows[0].envVar + ' is NOT expanded there'
      : 'in your shell, where each name is an environment variable ($' + rows[0].envVar + ' in curl etc.)');
    return '<service_keys>\n'
      + 'The Commander has connected API keys for these services. You can use them ' + how.join('; and ') + '.\n'
      + (canRequest && canShell ? 'Prefer web_request for API calls — it needs no shell quoting and works the same on every OS.\n' : '')
      + 'You will never see a key\'s value and must never ask the Commander for one. NEVER print, echo, or '
      + 'write a value anywhere; reference it only by name.\n'
      + lines.join('\n')
      + '\n</service_keys>';
  }

  return { NAME_MAX, KEY_MAX, LIST_MAX, slug, deriveEnvVar, validate, mask, toPublic, upsert, setEnabled, setAutonomous, remove, applyEnv, runEnv, resolveForRequest, promptBlock };
});
