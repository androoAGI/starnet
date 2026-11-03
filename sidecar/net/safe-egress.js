/* sidecar/net/safe-egress.js — the ONE outbound trust boundary.

   WHAT IT GUARDS. Every request whose destination a model or a remote server chooses: web_fetch and web_request, the
   owned browser (navigate, the login window, desktop) and its loopback proxy, connector OAuth (probe, metadata, client
   registration, code exchange, refresh) and the Skill Exchange / Skill Market / community-map downloads. Each consumer
   names its row in POLICIES and calls this module; none keeps a range table or a connect-time lookup of its own.
   (Destinations the Commander configured himself, such as a provider base URL or a LAN Ollama, are not guarded here:
   some are local on purpose.)

   WHY ONE MODULE (safe-egress lane, 2026-11-03). Five files each held their own private-range table and three
   hand-rolled the pinned connect lookup, and the copies drifted: the browser allowed http://metadata.goog/, connector
   OAuth refused every IPv6 literal (public ones too), every copy allowed a private IPv4 spelled as IPv6 ([::127.0.0.1],
   NAT64 [64:ff9b::a00:5], 6to4 [2002:a00:5::1]), connector OAuth pinned only the FIRST validated address (a dead first
   address failed sign-in where web_fetch fell back to the next), and the skill fetcher validated one DNS answer and then
   let the connect resolve the name again. gh#82 was the same class: web.js's pin answered Node's { all: true } lookup
   with a single address, and every pinned request died as "fetch failed".

   THE RULES
   · classifyHost is data plus a pure parser. ONE ordered table (TABLE): name rules, then IPv4 and IPv6 CIDR rows, each
     with its kind and its exit. An IPv6 address that carries an IPv4 (mapped ::ffff:0:0/96, IPv4-translated
     ::ffff:0:0:0/96, compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16) is classified BY THAT IPv4: a public IPv4
     behind any of them stays reachable, a private one is refused however it is spelled. net.isIP gates the syntax; the
     parser expands '::', dotted tails and zone ids.
   · Kept public on purpose (TABLE.keptPublic): 198.18.0.0/15, where Clash/Surge fake-IP proxies answer every DNS name
     (refusing it would break every web tool for their users), the TEST-NETs, 2001:db8::/32 and Teredo (they reach
     nothing, so refusing them would add refused states with no security value).
   · resolveValidated asks DNS ONCE per call and returns a frozen Destination this module minted. The dial
     (pinnedDispatcher, pinnedLookup) answers ONLY that validated list, so validation and connection share one DNS
     answer and a rebinding resolver is never asked twice: the whole list, in order, when Node asks { all: true } (its
     autoSelectFamily connect walks it, so a dead first address falls back to the next), the first address otherwise;
     options.family is honoured, and a pinned lookup never answers for a name it did not validate.
   · Resolution fails CLOSED. A resolver error is rethrown exactly as the resolver raised it (its code, ENOTFOUND or
     EAI_AGAIN, says it may pass); an empty or non-IP answer is refused as transient; every answer is classified.
     '.invalid' (RFC 2606) is answered locally. lookup: null is the test-only static mode: no DNS and no pin.
   · node:dns and undici are read AT CALL TIME: the http preload rigs replace dns.promises.lookup after boot, and a
     process that never dials never loads undici.
   · A refusal is host-authored (it never taints the run) only for a tool consumer's OWN URL. A redirect hop names a
     host the remote server chose, and the connector and skill consumers never mark one (test/untrusted-taint.test.js).
   · The wording is each consumer's own, from its POLICIES row, byte for byte as before this module. The one addition
     is privateAnswerExit, the DNS-filter exit every consumer appends to a private-answer refusal (withAnswerExit).
   No clock and no randomness (test/lint-determinism.js). Close errors are reported through failopen, never swallowed. */
'use strict';

const net = require('node:net');
const { note: failNote } = require('../failopen.js');

const CLOSE_TAG = 'net.egress.dispatcher-close';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---------- THE CLASSIFICATION TABLE ----------
   Ordered: the first row that matches decides. `exit` names the EXITS entry that tells the reader where the thing they
   wanted is reached instead. Rows marked NEW were allowed by every copy before this module. */
const TABLE = deepFreeze({
  names: [
    { rule: 'localhost', match: 'exact', kind: 'loopback-name', exit: 'local-service' },
    { rule: '.localhost', match: 'suffix', kind: 'loopback-name', exit: 'local-service' },
    { rule: '.local', match: 'suffix', kind: 'mdns-name', exit: 'local-service' },
    { rule: '.internal', match: 'suffix', kind: 'intranet-name', exit: 'local-service' },   // metadata.google.internal too
    { rule: '.lan', match: 'suffix', kind: 'intranet-name', exit: 'local-service' },
    { rule: '.intranet', match: 'suffix', kind: 'intranet-name', exit: 'local-service' },
    { rule: '.home', match: 'suffix', kind: 'intranet-name', exit: 'local-service' },
    { rule: '.corp', match: 'suffix', kind: 'intranet-name', exit: 'local-service' },
    { rule: 'home.arpa', match: 'exact', kind: 'intranet-name', exit: 'local-service' },     // NEW (RFC 8375)
    { rule: '.home.arpa', match: 'suffix', kind: 'intranet-name', exit: 'local-service' },   // NEW
    { rule: 'metadata.goog', match: 'exact', kind: 'metadata-name', exit: 'metadata' },     // GCP metadata shorthand
    { rule: '.metadata.goog', match: 'suffix', kind: 'metadata-name', exit: 'metadata' },
    // integer / hex / partial-dotted IP spellings (2130706433, 0x7f000001, 127.1): WHATWG rewrites them inside a URL,
    // so this row only ever meets a raw string, and an IP that cannot be read one way only is refused
    { rule: 'numeric', match: 'numeric', kind: 'numeric-name', exit: 'malformed' },
    { rule: 'single-label', match: 'single-label', kind: 'single-label', exit: 'local-service' }   // wiki, db, nas
  ],
  v4: [
    { cidr: '0.0.0.0/8', kind: 'unspecified', exit: 'local-service' },
    { cidr: '10.0.0.0/8', kind: 'private', exit: 'local-service' },
    { cidr: '100.64.0.0/10', kind: 'cgnat', exit: 'local-service' },          // also Tailscale tailnet addresses
    { cidr: '127.0.0.0/8', kind: 'loopback', exit: 'local-service' },
    { cidr: '169.254.0.0/16', kind: 'link-local', exit: 'local-service' },    // 169.254.169.254 cloud metadata
    { cidr: '172.16.0.0/12', kind: 'private', exit: 'local-service' },
    { cidr: '192.0.0.0/24', kind: 'ietf-protocol', exit: 'not-public' },      // NEW
    { cidr: '192.168.0.0/16', kind: 'private', exit: 'local-service' },
    { cidr: '224.0.0.0/4', kind: 'multicast', exit: 'not-public' },           // NEW
    { cidr: '240.0.0.0/4', kind: 'reserved', exit: 'not-public' }             // NEW, 255.255.255.255 included
  ],
  v6: [
    { cidr: '::/128', kind: 'unspecified', exit: 'local-service' },
    { cidr: '::1/128', kind: 'loopback', exit: 'local-service' },
    { cidr: '::ffff:0:0/96', embedded: 'mapped', at: 6 },
    { cidr: '::ffff:0:0:0/96', embedded: 'translated', at: 6 },               // RFC 2765 SIIT
    { cidr: '::/96', embedded: 'compatible', at: 6 },                         // NEW for private IPv4s (::7f00:1)
    { cidr: '64:ff9b::/96', embedded: 'nat64', at: 6 },                       // NEW for private IPv4s
    { cidr: '2002::/16', embedded: '6to4', at: 1 },                           // NEW for private IPv4s
    { cidr: '64:ff9b:1::/48', kind: 'nat64-local', exit: 'local-service' },   // NEW (RFC 8215 local-use NAT64)
    { cidr: 'fc00::/7', kind: 'unique-local', exit: 'local-service' },
    { cidr: 'fe80::/10', kind: 'link-local', exit: 'local-service' },
    { cidr: 'fec0::/10', kind: 'site-local', exit: 'local-service' },         // NEW
    { cidr: 'ff00::/8', kind: 'multicast', exit: 'not-public' },              // NEW
    { cidr: '100::/64', kind: 'discard', exit: 'not-public' }                 // NEW
  ],
  keptPublic: [
    { cidr: '198.18.0.0/15', why: 'Clash/Surge fake-IP proxies answer every DNS name from it' },
    { cidr: '192.0.2.0/24', why: 'TEST-NET-1 reaches nothing' },
    { cidr: '198.51.100.0/24', why: 'TEST-NET-2 reaches nothing' },
    { cidr: '203.0.113.0/24', why: 'TEST-NET-3 reaches nothing' },
    { cidr: '2001:db8::/32', why: 'the documentation block reaches nothing' },
    { cidr: '2001::/32', why: 'Teredo is a public tunnel' }
  ],
  malformed: { kind: 'malformed', exit: 'malformed' }
});

/* Where the reader goes instead. A consumer's refusal keeps its own wording; err.egress.exit names the entry here. */
const EXITS = deepFreeze({
  'local-service': 'No public site lives there. A service on this computer is reached with browser.test_navigate (an agent\'s ' +
    'own dev server), one on this network with shell.exec or a terminal, and a connected app through its connector.',
  'not-public': 'That address block is not on the public internet (multicast, broadcast, reserved or protocol-only): there is ' +
    'no site to reach there.',
  'metadata': 'That is a cloud metadata service, which hands out the machine\'s own credentials: no outbound tool may reach it.',
  'malformed': 'Write the address the usual way (a dotted IPv4 such as 93.184.216.34, or a bracketed IPv6), or use the site\'s name.',
  'dns-filter': 'This computer\'s DNS answered a private or blocked address for a public name: a DNS filter, a VPN, a security ' +
    'app or the hosts file. Allow the name there.',
  'dns-retry': 'This computer\'s DNS gave no usable answer. That is often passing: retry, or check this computer\'s DNS or VPN settings.'
});

/* ---------- THE PARSERS (pure) ---------- */
// '1.2.3.4' -> [1,2,3,4]; null for anything that is not four decimal octets. A leading zero is refused: inet_aton
// reads 010 as octal 8, a person reads it as 10, and net.isIP rejects it too.
function v4Octets(s) {
  const parts = String(s).split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}
const v4Number = o => ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
// 'a:b::c' -> eight 16-bit numbers; expands '::' and a dotted IPv4 tail. Input: lowercase, no brackets, no zone id.
function v6Hextets(s) {
  let text = String(s);
  const lastColon = text.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = text.slice(lastColon + 1);
  if (tail.indexOf('.') >= 0) {
    const o = v4Octets(tail);
    if (!o) return null;
    text = text.slice(0, lastColon + 1) + (o[0] * 256 + o[1]).toString(16) + ':' + (o[2] * 256 + o[3]).toString(16);
  }
  const gap = text.indexOf('::');
  if (gap >= 0 && text.indexOf('::', gap + 1) >= 0) return null;
  let groups;
  if (gap >= 0) {
    const left = text.slice(0, gap), right = text.slice(gap + 2);
    const l = left ? left.split(':') : [], r = right ? right.split(':') : [];
    const fill = 8 - l.length - r.length;
    if (fill < 1) return null;
    groups = l.concat(new Array(fill).fill('0'), r);
  } else {
    groups = text.split(':');
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}
const v4At = (x, at) => (x[at] >> 8) + '.' + (x[at] & 255) + '.' + (x[at + 1] >> 8) + '.' + (x[at + 1] & 255);

function compileRow(row, parse) {
  const slash = row.cidr.lastIndexOf('/');
  const base = parse(row.cidr.slice(0, slash));
  const bits = Number(row.cidr.slice(slash + 1));
  if (base == null || !(bits >= 0)) throw new Error('safe-egress: bad table row ' + row.cidr);
  return { row, base, bits };
}
const V4_ROWS = TABLE.v4.map(row => compileRow(row, s => { const o = v4Octets(s); return o && v4Number(o); }));
const V6_ROWS = TABLE.v6.map(row => compileRow(row, v6Hextets));
function inV4(n, c) {
  const size = Math.pow(2, 32 - c.bits);
  return Math.floor(n / size) === Math.floor(c.base / size);
}
function inV6(x, c) {
  let bits = c.bits;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = bits < 16 ? bits : 16;
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((x[i] & mask) !== (c.base[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

/* ---------- classifyHost ---------- */
// lowercase; IPv6 brackets stripped; trailing root dots stripped from everything else (WHATWG strips them for IP
// literals but NOT for names, so `localhost.` / `svc.internal.` / `wiki.` would slip past every name rule)
function normalizeHost(host) {
  let h = String(host == null ? '' : host).toLowerCase();
  if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') h = h.slice(1, -1);
  else h = h.replace(/\.+$/, '');
  return h;
}
function verdict(isPublic, kind, rule, extra) {
  const v = { public: isPublic, kind, rule };
  if (extra) for (const k of Object.keys(extra)) if (extra[k] != null) v[k] = extra[k];
  return Object.freeze(v);
}
const MALFORMED = verdict(false, TABLE.malformed.kind, 'malformed', { exit: TABLE.malformed.exit });
const EMPTY = verdict(false, 'empty', 'empty', { exit: TABLE.malformed.exit });
const NUMERIC_NAME = /^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*$/;

function classifyV4(h) {
  const o = v4Octets(h);
  if (!o || net.isIP(h) !== 4) return MALFORMED;
  const n = v4Number(o);
  for (const c of V4_ROWS) if (inV4(n, c)) return verdict(false, c.row.kind, c.row.cidr, { exit: c.row.exit, ip: h });
  return verdict(true, 'public', 'default', { ip: h });
}
function classifyV6(h) {
  const zone = h.indexOf('%');
  const bare = zone >= 0 ? h.slice(0, zone) : h;
  if (net.isIP(bare) !== 6) return MALFORMED;
  const x = v6Hextets(bare);
  if (!x) return MALFORMED;
  for (const c of V6_ROWS) {
    if (!inV6(x, c)) continue;
    if (c.row.embedded) {
      const v4 = v4At(x, c.row.at);
      const inner = classifyV4(v4);
      return verdict(inner.public, inner.kind, inner.rule, { exit: inner.exit, ip: bare, embedded: v4, form: c.row.embedded });
    }
    return verdict(false, c.row.kind, c.row.cidr, { exit: c.row.exit, ip: bare });
  }
  return verdict(true, 'public', 'default', { ip: bare });
}
function nameMatches(r, h) {
  if (r.match === 'exact') return h === r.rule;
  if (r.match === 'suffix') return h.endsWith(r.rule);
  if (r.match === 'numeric') return NUMERIC_NAME.test(h);
  if (r.match === 'single-label') return h.indexOf('.') < 0;
  return false;
}
// -> { public, kind, rule, exit?, ip?, embedded?, form? }; pure: no DNS, no clock
function classifyHost(host) {
  const h = normalizeHost(host);
  if (!h) return EMPTY;
  if (h.indexOf(':') >= 0) return classifyV6(h);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return classifyV4(h);
  for (const r of TABLE.names) if (nameMatches(r, h)) return verdict(false, r.kind, r.rule, { exit: r.exit });
  return verdict(true, 'name', 'default', null);
}

/* ---------- POLICIES: each consumer's checks, in order, and its own words ---------- */
const CHECKS = ['parse', 'file', 'scheme', 'classify', 'https', 'credentials'];
const WEB_FILE_HINT = 'Files are read with fs_read — a worker\'s saved file at the exact path its dispatch row lists (artifacts[].abs).';
const POLICIES = deepFreeze({
  // web_fetch, web_request (tools/builtin/web.js)
  web: { name: 'web', checks: CHECKS.slice(), protocols: ['http:', 'https:'], https: false, noCredentials: false,
    hostAuthored: true, verb: 'fetch', fileHint: WEB_FILE_HINT, summary: null, dnsPrefix: 'refusing: ',
    httpsMessage: null, credentialsMessage: null, voice: 'web' },
  // browser.navigate, the login window, desktop, the owned browser's proxy (tools/builtin/browser.js)
  browser: { name: 'browser', checks: CHECKS.slice(), protocols: ['http:', 'https:'], https: false, noCredentials: false,
    hostAuthored: true, verb: 'navigate to',
    fileHint: 'To check a file you saved, fs_read it; the Commander opens it from its deliverable card.',
    summary: 'private address refused', dnsPrefix: 'refusing to navigate: ', httpsMessage: null, credentialsMessage: null,
    voice: 'browser' },
  // every connector-OAuth leg (mcp/oauth-fetch.js; its URLs come from an untrusted MCP server)
  connectorOauth: { name: 'connectorOauth', checks: CHECKS.slice(), protocols: ['http:', 'https:'], https: true,
    noCredentials: true, hostAuthored: false, verb: 'fetch', fileHint: WEB_FILE_HINT, summary: null, dnsPrefix: 'refusing: ',
    httpsMessage: 'connector OAuth endpoints must use https',
    credentialsMessage: 'connector OAuth endpoints cannot contain embedded credentials', voice: 'station' },
  // Skill Exchange / Skill Market / community maps (skills/exchange-fetch.js)
  skillSource: { name: 'skillSource', checks: CHECKS.slice(), protocols: ['http:', 'https:'], https: true,
    noCredentials: true, hostAuthored: false, verb: 'fetch', fileHint: WEB_FILE_HINT, summary: null, dnsPrefix: 'refusing: ',
    httpsMessage: 'skill sources must use HTTPS', credentialsMessage: 'skill source URLs cannot contain credentials',
    voice: 'station' }
});
function policyOf(p) {
  if (typeof p === 'string' && has(POLICIES, p)) return POLICIES[p];
  if (p && typeof p === 'object' && has(POLICIES, p.name) && POLICIES[p.name] === p) return p;
  throw new TypeError('safe-egress: name a POLICIES row (' + Object.keys(POLICIES).join(', ') + ')');
}
function originOf(o) {
  if (o === undefined || o === 'caller') return 'caller';
  if (o === 'redirect') return 'redirect';
  throw new TypeError('safe-egress: origin is "caller" or "redirect"');
}

/* ---------- refusal ---------- */
const DETAIL = Symbol('safe-egress.detail');
const REASONS = Object.freeze({
  'invalid-url': { hostAuthored: true, text: (p, d) => 'invalid URL: ' + d.raw, summary: () => 'invalid URL' },
  'file-scheme': { hostAuthored: true, text: p => 'only http(s) URLs are allowed. ' + p.fileHint, summary: () => 'not a web address (file://)' },
  'scheme': { hostAuthored: true, text: () => 'only http(s) URLs are allowed', summary: () => 'not a web address' },
  'not-public': { hostAuthored: true, text: (p, d) => 'refusing to ' + p.verb + ' private/loopback/intranet host: ' + d.host, summary: p => p.summary },
  'https': { hostAuthored: true, text: p => p.httpsMessage },
  'credentials': { hostAuthored: true, text: p => p.credentialsMessage },
  'private-answer': { hostAuthored: true, exit: 'dns-filter', text: (p, d) => p.dnsPrefix + d.host + ' resolves to private address ' + d.address },
  'no-address': { hostAuthored: false, exit: 'dns-retry', transient: true, text: (p, d) => 'no verified DNS address for ' + d.host },
  'invalid-answer': { hostAuthored: false, exit: 'dns-retry', transient: true, text: (p, d) => 'resolver returned an invalid IP address for ' + d.host }
});
// -> Error { message: the policy's wording, code 'EGRESS_REFUSED', egress: { reason, policy, origin, host, address,
//    kind, rule, exit, transient }, toolSummary?, hostAuthored? (only a tool consumer's own URL) }
function refusal(reason, detail) {
  const key = String(reason);
  const r = has(REASONS, key) ? REASONS[key] : null;
  if (!r) throw new TypeError('safe-egress: unknown refusal reason ' + key);
  const d = Object.assign({}, detail);
  const p = policyOf(d.policy);
  const o = originOf(d.origin);
  const text = r.text(p, d);
  if (typeof text !== 'string') throw new TypeError('safe-egress: policy ' + p.name + ' has no wording for ' + reason);
  const e = new Error(text);
  e.code = 'EGRESS_REFUSED';
  const summary = r.summary ? r.summary(p) : null;
  if (summary) e.toolSummary = summary;
  if (r.hostAuthored && p.hostAuthored && o === 'caller') e.hostAuthored = true;
  const record = { reason, policy: p.name, origin: o, host: d.host, address: d.address, kind: d.kind, rule: d.rule,
    exit: d.exit || r.exit, transient: r.transient === true };
  for (const k of Object.keys(record)) if (record[k] == null) delete record[k];
  e.egress = Object.freeze(record);
  Object.defineProperty(e, DETAIL, { value: Object.freeze(Object.assign({}, d, { policy: p.name, origin: o })) });
  return e;
}
// the same refusal for another origin (a session shares one DNS answer between a caller URL and a redirect hop)
function reissue(e, origin) {
  return e && e[DETAIL] && e.egress.origin !== origin ? refusal(e.egress.reason, Object.assign({}, e[DETAIL], { origin })) : e;
}

/* ---------- validateUrl (sync): parse -> file:// -> http(s) -> classify -> https -> credentials ---------- */
function validateUrl(raw, policy, origin) {
  const p = policyOf(policy);
  const o = originOf(origin);
  let u = null;
  for (const check of p.checks) {
    if (check === 'parse') {
      try { u = new URL(raw); } catch (e) { throw refusal('invalid-url', { policy: p, origin: o, raw: String(raw) }); }
    } else if (check === 'file') {
      if (u.protocol === 'file:') throw refusal('file-scheme', { policy: p, origin: o });
    } else if (check === 'scheme') {
      if (p.protocols.indexOf(u.protocol) < 0) throw refusal('scheme', { policy: p, origin: o });
    } else if (check === 'classify') {
      const c = classifyHost(u.hostname);
      if (!c.public) throw refusal('not-public', { policy: p, origin: o, host: normalizeHost(u.hostname), kind: c.kind, rule: c.rule, exit: c.exit });
    } else if (check === 'https') {
      if (p.https && u.protocol !== 'https:') throw refusal('https', { policy: p, origin: o, host: normalizeHost(u.hostname) });
    } else if (check === 'credentials') {
      if (p.noCredentials && (u.username || u.password)) throw refusal('credentials', { policy: p, origin: o, host: normalizeHost(u.hostname) });
    }
  }
  return u;
}

/* ---------- Destination: minted here, frozen, one validated DNS answer ---------- */
const MINTED = new WeakSet();
const NO_ADDRESSES = Object.freeze([]);
const freezeList = list => Object.freeze(list.map(a => Object.freeze({ address: a.address, family: a.family })));
// { url (a fresh URL on every read, so no caller can re-aim it), href, host, addresses: [{ address, family }], literal,
//   policy, origin }. addresses is empty only in the test-only static mode (lookup: null).
function mint(u, host, addresses, literal, p, o) {
  const href = u.href;
  const dest = Object.defineProperties({}, {
    url: { enumerable: true, get() { return new URL(href); } },
    href: { enumerable: true, value: href },
    host: { enumerable: true, value: host },
    addresses: { enumerable: true, value: addresses },
    literal: { enumerable: true, value: literal },
    policy: { enumerable: true, value: p.name },
    origin: { enumerable: true, value: o }
  });
  MINTED.add(Object.freeze(dest));
  return dest;
}
function lookupOf(l) {
  if (l === undefined || l === null || typeof l === 'function') return l;
  throw new TypeError('safe-egress: lookup is a function, null (no DNS, tests only) or absent (this computer\'s DNS)');
}
// read at call time: the http preload rigs replace dns.promises.lookup after boot
function defaultLookup(name, options) { return require('node:dns').promises.lookup(name, options); }
// a validated URL's literal address, or null for a name
function literalOf(host) {
  const c = classifyHost(host);
  return c.ip ? freezeList([{ address: c.ip, family: net.isIP(c.ip) }]) : null;
}
// ONE question to DNS for this host; every answer validated. A resolver error is rethrown as raised.
async function askOnce(u, host, lookup, p, o) {
  if (host.endsWith('.invalid')) {
    // RFC 2606: never resolvable. The host resolver took 11 s to say so on the release-audit machine.
    const e = new Error('getaddrinfo ENOTFOUND ' + host);
    e.code = 'ENOTFOUND';
    throw e;
  }
  const ask = typeof lookup === 'function' ? lookup : defaultLookup;
  const answers = await ask(u.hostname, { all: true });
  if (!Array.isArray(answers) || !answers.length) throw refusal('no-address', { policy: p, origin: o, host });
  const list = [];
  for (const a of answers) {
    const address = a && typeof a.address === 'string' ? a.address : '';
    const family = net.isIP(address);
    if (!family) throw refusal('invalid-answer', { policy: p, origin: o, host });
    const c = classifyHost(address);
    if (!c.public) throw refusal('private-answer', { policy: p, origin: o, host, address, kind: c.kind, rule: c.rule });
    list.push({ address, family });
  }
  return freezeList(list);
}
// (target, { policy, lookup?, origin? }) -> Destination
async function resolveValidated(target, opts) {
  opts = opts || {};
  const p = policyOf(opts.policy);
  const o = originOf(opts.origin);
  const lookup = lookupOf(opts.lookup);
  const u = validateUrl(target, p, o);
  const host = normalizeHost(u.hostname);
  const literal = literalOf(host);
  if (literal) return mint(u, host, literal, true, p, o);
  if (lookup === null) return mint(u, host, NO_ADDRESSES, false, p, o);
  return mint(u, host, await askOnce(u, host, lookup, p, o), false, p, o);
}

/* ---------- the dial ---------- */
function familyOf(f) {
  if (f === 4 || f === 'IPv4') return 4;
  if (f === 6 || f === 'IPv6') return 6;
  return 0;
}
function lookupError(code, message, hostname) {
  const e = new Error(message);
  e.code = code;
  e.hostname = hostname;
  return e;
}
/* THE ONE implementation of Node's connect-time lookup(hostname, options, callback) for a validated answer.
   options.all (Node's autoSelectFamily connect asks for it): COPIES of the whole list, in order. Otherwise the first.
   options.family 4/6 keeps that family only. Given `host`, it answers for that name alone. Never asks DNS. */
function pinnedLookup(addresses, host) {
  const list = (Array.isArray(addresses) ? addresses : []).map(a => {
    const address = typeof a === 'string' ? a : (a && typeof a.address === 'string' ? a.address : '');
    const family = net.isIP(address);
    if (!family) throw new TypeError('pinnedLookup takes validated IP addresses');
    return Object.freeze({ address, family });
  });
  if (!list.length) throw new TypeError('pinnedLookup needs at least one validated address');
  const want = host == null ? null : normalizeHost(host);
  return function pinned(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = null; }
    const o = typeof options === 'number' ? { family: options } : (options || {});
    if (want !== null && normalizeHost(hostname) !== want) {
      return callback(lookupError('EGRESS_REFUSED', 'the pinned lookup for ' + want + ' does not answer for ' + hostname, hostname));
    }
    const fam = familyOf(o.family);
    const pool = fam ? list.filter(a => a.family === fam) : list;
    if (!pool.length) return callback(lookupError('ENOTFOUND', 'no validated IPv' + fam + ' address for ' + hostname, hostname));
    if (o.all) return callback(null, pool.map(a => ({ address: a.address, family: a.family })));
    return callback(null, pool[0].address, pool[0].family);
  };
}
function defaultAgent(options) {
  const { Agent } = require('undici');
  return new Agent(options);
}
function assertMinted(dest, who) {
  if (!MINTED.has(dest)) throw new TypeError(who + ' dials only a Destination that resolveValidated minted');
}
/* A dispatcher whose sockets can reach only dest's validated addresses. null for an IP literal (nothing to resolve)
   and in the static mode. The URL is untouched, so Host and TLS SNI keep the requested name. autoSelectFamily is
   explicit for 2+ addresses so every Node walks the list. */
function pinnedDispatcher(dest, opts) {
  assertMinted(dest, 'pinnedDispatcher');
  if (dest.literal || !dest.addresses.length) return null;
  opts = opts || {};
  const connect = Object.assign({}, opts.connect, { lookup: pinnedLookup(dest.addresses, dest.host) });
  if (dest.addresses.length > 1) connect.autoSelectFamily = true;
  const make = typeof opts.agentFactory === 'function' ? opts.agentFactory : defaultAgent;
  return make({ connect });
}
function reportClose(onCloseError, e) {
  if (typeof onCloseError !== 'function') return failNote(CLOSE_TAG, e);
  try { onCloseError(e); } catch (inner) { failNote(CLOSE_TAG, inner); }
}
async function closeDispatcher(d, onCloseError) {
  if (!d || typeof d.close !== 'function') return;
  try { await d.close(); } catch (e) { reportClose(onCloseError, e); }
}
/* Build, run fn(dispatcher, dest), close. The close is awaited, so a caller that reads the body inside fn leaves no
   socket behind and no later request can reuse this pinned connection. closeInBackground: undici's graceful close
   waits for the in-flight request and its body, for a caller that returns the Response and reads it later. */
async function withPinned(dest, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = null; }
  if (typeof fn !== 'function') throw new TypeError('withPinned(dest, opts, fn) needs fn');
  opts = opts || {};
  const dispatcher = pinnedDispatcher(dest, opts);
  try {
    return await fn(dispatcher, dest);
  } finally {
    if (dispatcher) {
      if (opts.closeInBackground) Promise.resolve().then(() => dispatcher.close()).catch(e => reportClose(opts.onCloseError, e));
      else await closeDispatcher(dispatcher, opts.onCloseError);
    }
  }
}
/* One validated answer and one keep-alive pinned dispatcher per host, for ONE bounded job (a skill package fetch,
   <= 30 s), closed at its end: 64 package files cost one DNS question and one TLS handshake per host, not 64. The
   cached answer was validated, so reusing it never dials anything unvalidated. A host whose lookup failed is asked again
   by the next resolve. */
function session(opts) {
  opts = opts || {};
  const p = policyOf(opts.policy);
  const lookup = lookupOf(opts.lookup);
  const pending = new Map();     // host -> Promise of its validated list
  const validated = new Map();   // host -> the validated list (its identity marks this session's answer)
  const agents = new Map();      // host -> pinned dispatcher
  let closed = false;
  const closedError = () => new Error('this egress session is closed');
  async function resolve(target, ropts) {
    if (closed) throw closedError();
    const o = originOf(ropts && ropts.origin);
    const u = validateUrl(target, p, o);
    const host = normalizeHost(u.hostname);
    const literal = literalOf(host);
    if (literal) return mint(u, host, literal, true, p, o);
    if (lookup === null) return mint(u, host, NO_ADDRESSES, false, p, o);
    let answer = pending.get(host);
    if (!answer) {
      answer = askOnce(u, host, lookup, p, o);
      pending.set(host, answer);
      answer.catch(() => { pending.delete(host); });
    }
    let list;
    try { list = await answer; } catch (e) { throw reissue(e, o); }
    if (closed) throw closedError();
    if (!validated.has(host)) validated.set(host, list);
    return mint(u, host, list, false, p, o);
  }
  function dispatcher(dest) {
    assertMinted(dest, 'session.dispatcher');
    if (closed) throw closedError();
    if (dest.literal || !dest.addresses.length) return null;
    if (validated.get(dest.host) !== dest.addresses) throw new TypeError('session.dispatcher dials only a Destination this session resolved');
    let agent = agents.get(dest.host);
    if (!agent) {
      agent = pinnedDispatcher(dest, { agentFactory: opts.agentFactory, connect: opts.connect });
      agents.set(dest.host, agent);
    }
    return agent;
  }
  async function close() {
    if (closed) return;
    closed = true;
    const open = Array.from(agents.values());
    agents.clear(); pending.clear(); validated.clear();
    for (const agent of open) await closeDispatcher(agent, opts.onCloseError);
  }
  return Object.freeze({ policy: p.name, resolve, dispatcher, close, isClosed: () => closed });
}

/* ---------- the DNS-filter exit ----------
   A PUBLIC name answered with a private or blocked address is this computer's DNS filter far more often than an attack
   (the Etsy reports, 2026-10-08). Moved here from browser.js explainRefusal (whose text it still is, byte for byte, in
   the browser's voice) so web_fetch, web_request and connector sign-in can say it too. */
const ANSWER_VOICES = deepFreeze({
  browser: { lead: 'StarNet\'s browser safety check refused it: ',
    ownDns: 'A browser using its own secure DNS can still open the site, so it may work there. ',
    route: 'StarNet\'s browser uses no outside proxy, VPN or gateway: it connects from this computer. ' },
  web: { lead: '', ownDns: 'A browser using its own secure DNS can still open the site, so it may work there. ',
    route: 'StarNet uses no outside proxy, VPN or gateway: it connects from this computer. ' },
  station: { lead: '', ownDns: '', route: 'StarNet uses no outside proxy, VPN or gateway: it connects from this computer. ' }
});
function voiceOf(who) {
  if (typeof who === 'string' && has(ANSWER_VOICES, who)) return who;
  if (typeof who === 'string' && has(POLICIES, who)) return POLICIES[who].voice;
  if (who && typeof who === 'object' && has(POLICIES, who.name) && POLICIES[who.name] === who) return who.voice;
  return 'station';
}
function privateAnswerExit(host, address, who) {
  const v = ANSWER_VOICES[voiceOf(who)];
  const h = String(host == null ? '' : host), ip = String(address == null ? '' : address);
  return v.lead + 'this computer\'s DNS answered ' + ip + ' for ' + h + ', a private or blocked address. That answer usually ' +
    'comes from a DNS filter (Pi-hole, AdGuard, NextDNS, router parental controls), a VPN, a security app or the hosts file ' +
    'on this computer. ' + v.ownDns + v.route + 'Fix or allow ' + h + ' in that DNS filter.';
}
/* The one way a consumer says it: a private-answer refusal gains that exit as its own sentence, in `who`'s voice, once.
   Any other error comes back untouched. web_fetch, web_request, the browser, connector sign-in and the skill downloads
   all append it here, so the words cannot drift apart again. */
const EXPLAINED = Symbol('safe-egress.explained');
function withAnswerExit(e, who) {
  if (!e || e.code !== 'EGRESS_REFUSED' || !e.egress || e.egress.reason !== 'private-answer' || e[EXPLAINED]) return e;
  const exit = privateAnswerExit(e.egress.host, e.egress.address, who);
  e.message += '. ' + exit.charAt(0).toUpperCase() + exit.slice(1);
  Object.defineProperty(e, EXPLAINED, { value: true });
  return e;
}

module.exports = {
  POLICIES, TABLE, EXITS,
  classifyHost, normalizeHost, validateUrl, resolveValidated,
  pinnedLookup, pinnedDispatcher, withPinned, session,
  refusal, privateAnswerExit, withAnswerExit
};
