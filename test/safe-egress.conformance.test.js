/* node test/safe-egress.conformance.test.js — ONE table of outbound destinations, and the verdict the boundary gives
   for each row.

   THE FAMILY (safe-egress lane, 2026-11-03). Every outbound path whose destination a model or a remote server picks
   held its own private-range table and its own pinned connect lookup, and the copies drifted: the browser allowed
   http://metadata.goog/, connector OAuth refused every IPv6 literal (public ones too), every copy allowed a private IPv4
   spelled as IPv6 ([::127.0.0.1], NAT64 [64:ff9b::a00:5], 6to4 [2002:a00:5::1]) and 224.0.0.1 / 240.0.0.1 /
   255.255.255.255 / 192.0.0.8 / fec0::1 / ff02::1, connector OAuth pinned only the first validated address, and the
   skill fetcher let the connect resolve the name a second time. sidecar/net/safe-egress.js now owns the boundary, and
   this file is its conformance table.

   SECTIONS
     TABLE    the rows. Literal hosts as a URL writes them (IPv4; IPv6 incl. compressed, dotted and embedded-IPv4 forms;
              the integer/hex/octal encodings WHATWG rewrites), names (root dots, intranet suffixes, home.arpa,
              metadata), raw hosts a resolver or a caller can hand over (zone ids, dotted mapped forms, malformed
              octets), and DNS answers (public, private, mixed, 0.0.0.0, NAT64 public/private, dotted ::ffff:, empty,
              non-IP, resolver error, .invalid). NEW marks a state refused since the module, OPEN one allowed since it,
              PINNED a block kept public on purpose (198.18.0.0/15: Clash/Surge fake-IP proxies answer every name there).
     MODULE   the module itself, per POLICIES row: classifyHost, validateUrl's wording and check order (parse, file://,
              http(s), classify, https, credentials), resolveValidated (one DNS question, fail closed, host-authored
              only for a tool consumer's own URL), a differential of every CIDR row against an independent
              net.BlockList, every IPv6 spelling of each embedded-IPv4 block, the pinned lookup, dispatcher, withPinned
              and session lifecycle, refusal() and the DNS-filter exit; plus the wording web.js and browser.js give
              today, read through their own entry points.
     CONSUMERS each consumer built the way index.js builds it, fakes only at the transport edge (dns.promises.lookup
              replaced in-process as the http preload rigs replace it, a fetch and an agentFactory recorder, the CDP
              driver, the desktop opener, the proxy's net.connect), run over the same rows: web_fetch and web_request
              (caller URL, redirect hops, one DNS question per hop, the dial pinned to exactly the validated addresses
              and closed), browser.navigate (caller URL and where the page landed), the login window, desktop links,
              the owned browser's proxy (CONNECT) with the guards makeCdpDriver gives it, connector OAuth's literal
              check (mcp/oauth.js) and its fetch (makeConnectorOauthFetch({ onCloseError }), globalThis.fetch read per
              call: every leg and publicDestination), and the skill document fetch (makeSkillDocumentFetcher({
              fetchImpl }): a document, its redirect hops, a package's one session per host).
     CENSUS   ONE CLASSIFIER: no sidecar file but the boundary holds a private-range or intranet-name table, answers a
              connect-time lookup or asks DNS for a destination itself (code only; one documented exception).
   Real sockets: test/safe-egress.real-socket.test.js. */
'use strict';
const A = require('./_assert.js');
const net = require('node:net');
const dns = require('node:dns');

const UNDICI_RE = /[\\/]node_modules[\\/]undici[\\/]/;
const S = require('../sidecar/net/safe-egress.js');
const undiciAtLoad = Object.keys(require.cache).some(k => UNDICI_RE.test(k));
const F = require('../sidecar/failopen.js');

const POLICY_NAMES = ['web', 'browser', 'connectorOauth', 'skillSource'];
const TOOL_POLICIES = new Set(['web', 'browser']);   // the consumers whose own-URL refusals are host-authored
const VERB = { web: 'fetch', browser: 'navigate to', connectorOauth: 'fetch', skillSource: 'fetch' };
const DNS_PREFIX = { web: 'refusing: ', browser: 'refusing to navigate: ', connectorOauth: 'refusing: ', skillSource: 'refusing: ' };
const HTTPS_TEXT = { connectorOauth: 'connector OAuth endpoints must use https', skillSource: 'skill sources must use HTTPS' };
const CRED_TEXT = { connectorOauth: 'connector OAuth endpoints cannot contain embedded credentials', skillSource: 'skill source URLs cannot contain credentials' };
const WEB_FILE = 'only http(s) URLs are allowed. Files are read with fs_read — a worker\'s saved file at the exact path its dispatch row lists (artifacts[].abs).';
const BROWSER_FILE = 'only http(s) URLs are allowed. To check a file you saved, fs_read it; the Commander opens it from its deliverable card.';
const FILE_TEXT = { web: WEB_FILE, browser: BROWSER_FILE, connectorOauth: WEB_FILE, skillSource: WEB_FILE };
const PUB4 = { address: '93.184.216.34', family: 4 };
const PUB6 = { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 };

function sync(fn) { try { return { value: fn() }; } catch (e) { return { error: e }; } }
async function settle(p) { try { return { value: await p }; } catch (e) { return { error: e }; } }
// the host as a refusal names it: lowercase, IPv6 brackets off, root dots off (written here independently of the module)
function hostOfUrl(raw) { const h = new URL(raw).hostname.toLowerCase(); return h.charAt(0) === '[' ? h.slice(1, -1) : h.replace(/\.+$/, ''); }

/* =============================================== TABLE =============================================== */
// [url, 'allow' | 'refuse', kind, note?]: the URL's host decides the verdict for every consumer
const HOST_ROWS = [
  // IPv4: the refused blocks
  ['http://127.0.0.1/', 'refuse', 'loopback'],
  ['http://127.9.9.9/', 'refuse', 'loopback'],
  ['http://127.0.0.1:8787/api/key', 'refuse', 'loopback'],
  ['http://0.0.0.0/', 'refuse', 'unspecified'],
  ['http://0.1.2.3/', 'refuse', 'unspecified'],
  ['http://10.0.0.5/', 'refuse', 'private'],
  ['http://172.16.0.1/', 'refuse', 'private'],
  ['http://172.31.255.255/', 'refuse', 'private'],
  ['http://192.168.1.1/', 'refuse', 'private'],
  ['http://169.254.169.254/latest/meta-data/', 'refuse', 'link-local'],
  ['http://100.64.0.1/', 'refuse', 'cgnat'],
  ['http://100.127.255.255/', 'refuse', 'cgnat'],
  ['http://192.0.0.8/', 'refuse', 'ietf-protocol', 'NEW'],
  ['http://224.0.0.1/', 'refuse', 'multicast', 'NEW'],
  ['http://239.255.255.250/', 'refuse', 'multicast', 'NEW'],
  ['http://240.0.0.1/', 'refuse', 'reserved', 'NEW'],
  ['http://255.255.255.255/', 'refuse', 'reserved', 'NEW'],
  // IPv4 encodings WHATWG rewrites before any guard sees them
  ['http://2130706433/', 'refuse', 'loopback'],
  ['http://0x7f000001/', 'refuse', 'loopback'],
  ['http://0177.0.0.1/', 'refuse', 'loopback'],
  ['http://017700000001/', 'refuse', 'loopback'],
  ['http://127.1/', 'refuse', 'loopback'],
  ['http://0x7f.0.0.1/', 'refuse', 'loopback'],
  ['http://3232235777/', 'refuse', 'private'],
  ['http://0xa9fea9fe/', 'refuse', 'link-local'],
  ['http://127.0.0.1./', 'refuse', 'loopback'],
  // IPv4: public, including the blocks kept public on purpose
  ['http://8.8.8.8/', 'allow', 'public'],
  ['https://93.184.216.34/', 'allow', 'public'],
  ['http://172.15.255.255/', 'allow', 'public'],
  ['http://172.32.0.0/', 'allow', 'public'],
  ['http://100.63.255.255/', 'allow', 'public'],
  ['http://100.128.0.0/', 'allow', 'public'],
  ['http://192.0.1.0/', 'allow', 'public'],
  ['http://223.255.255.255/', 'allow', 'public'],
  ['https://198.18.0.1/', 'allow', 'public', 'PINNED'],
  ['http://198.19.255.255/', 'allow', 'public', 'PINNED'],
  ['http://192.0.2.1/', 'allow', 'public'],
  ['http://198.51.100.1/', 'allow', 'public'],
  ['http://203.0.113.1/', 'allow', 'public'],
  // IPv6
  ['http://[::1]/', 'refuse', 'loopback'],
  ['http://[0:0:0:0:0:0:0:1]/', 'refuse', 'loopback'],
  ['http://[::]/', 'refuse', 'unspecified'],
  ['http://[fd00::1]/', 'refuse', 'unique-local'],
  ['http://[fc00::1]/', 'refuse', 'unique-local'],
  ['http://[fdff:ffff::1]/', 'refuse', 'unique-local'],
  ['http://[fe80::1]/', 'refuse', 'link-local'],
  ['http://[febf:ffff::1]/', 'refuse', 'link-local'],
  ['http://[fec0::1]/', 'refuse', 'site-local', 'NEW'],
  ['http://[ff02::1]/', 'refuse', 'multicast', 'NEW'],
  ['http://[100::1]/', 'refuse', 'discard', 'NEW'],
  ['http://[64:ff9b:1::a00:5]/', 'refuse', 'nat64-local', 'NEW'],
  // IPv6 carrying an IPv4: classified by the IPv4
  ['http://[::ffff:127.0.0.1]/', 'refuse', 'loopback'],
  ['http://[::127.0.0.1]/', 'refuse', 'loopback', 'NEW'],
  ['http://[64:ff9b::10.0.0.5]/', 'refuse', 'private', 'NEW'],
  ['http://[2002:a00:5::1]/', 'refuse', 'private', 'NEW'],
  ['http://[::ffff:0:10.0.0.5]/', 'refuse', 'private', 'NEW'],
  ['http://[::ffff:169.254.169.254]/', 'refuse', 'link-local'],
  ['https://[::ffff:8.8.8.8]/', 'allow', 'public', 'OPEN'],
  ['https://[64:ff9b::5db8:d822]/', 'allow', 'public', 'OPEN (DNS64 networks)'],
  ['https://[2002:5db8:d822::1]/', 'allow', 'public', 'OPEN'],
  // IPv6: public
  ['https://[2606:4700:4700::1111]/', 'allow', 'public', 'OPEN for connector OAuth'],
  ['http://[2001:db8::1]/', 'allow', 'public'],
  ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'allow', 'public'],
  ['http://[100:0:0:1::]/', 'allow', 'public'],
  ['http://[64:ff9b:2::1]/', 'allow', 'public'],
  // names
  ['http://localhost/', 'refuse', 'loopback-name'],
  ['http://LocalHost./', 'refuse', 'loopback-name'],
  ['http://localhost。/', 'refuse', 'loopback-name'],             // ideographic full stop: WHATWG maps it to a root dot
  ['http://%6c%6f%63%61%6c%68%6f%73%74/', 'refuse', 'loopback-name'],  // percent-encoded: WHATWG decodes it
  ['http://app.localhost/', 'refuse', 'loopback-name'],
  ['http://router.local/', 'refuse', 'mdns-name'],
  ['http://myapp.local./', 'refuse', 'mdns-name'],
  ['http://svc.internal/', 'refuse', 'intranet-name'],
  ['http://svc.internal./', 'refuse', 'intranet-name'],
  ['http://metadata.google.internal/', 'refuse', 'intranet-name'],
  ['http://router.lan./', 'refuse', 'intranet-name'],
  ['http://wiki.intranet/', 'refuse', 'intranet-name'],
  ['http://nas.home/', 'refuse', 'intranet-name'],
  ['http://git.corp/', 'refuse', 'intranet-name'],
  ['http://printer.home.arpa/', 'refuse', 'intranet-name', 'NEW'],
  ['http://home.arpa/', 'refuse', 'intranet-name', 'NEW'],
  ['http://metadata.goog/computeMetadata/v1/', 'refuse', 'metadata-name', 'NEW for the browser'],
  ['http://a.metadata.goog/', 'refuse', 'metadata-name', 'NEW for the browser'],
  ['http://wiki/', 'refuse', 'single-label'],
  ['http://wiki./', 'refuse', 'single-label'],
  ['http://internal-api/', 'refuse', 'single-label'],
  ['http://db/', 'refuse', 'single-label'],
  ['https://example.com/', 'allow', 'name'],
  ['https://example.com./', 'allow', 'name'],
  ['https://news.ycombinator.com/', 'allow', 'name'],
  ['https://xn--nxasmq6b.com/', 'allow', 'name'],
  ['https://localhost.example.com/', 'allow', 'name'],
  ['https://home.arpa.example.com/', 'allow', 'name'],
  ['https://metadata.goog.example.com/', 'allow', 'name'],
  ['http://1e100.net/', 'allow', 'name']
];
// [raw host, 'allow' | 'refuse', kind]: what a resolver answer or a raw caller string can carry (never a WHATWG hostname)
const RAW_ROWS = [
  ['::ffff:127.0.0.1', 'refuse', 'loopback'],
  ['::FFFF:7F00:1', 'refuse', 'loopback'],
  ['fe80::1%eth0', 'refuse', 'link-local'],
  ['fe80::1%25', 'refuse', 'link-local'],
  ['2606:4700:4700::1111%eth0', 'allow', 'public'],
  ['[::1]', 'refuse', 'loopback'],
  ['127.0.0.1.', 'refuse', 'loopback'],
  ['999.1.1.1', 'refuse', 'malformed'],
  ['256.0.0.1', 'refuse', 'malformed'],
  ['010.0.0.1', 'refuse', 'malformed'],   // inet_aton reads 010 as octal 8, a person as 10: refused, not guessed
  ['1234.1.1.1', 'refuse', 'malformed'],
  ['1.2.3', 'refuse', 'numeric-name'],
  ['1.2.3.4.5', 'refuse', 'numeric-name'],
  ['2130706433', 'refuse', 'numeric-name'],
  ['0x7f000001', 'refuse', 'numeric-name'],
  ['0x7f.1', 'refuse', 'numeric-name'],
  ['1::2::3', 'refuse', 'malformed'],
  ['a:b', 'refuse', 'malformed'],
  ['::ffff:010.1.1.1', 'refuse', 'malformed'],
  [':%eth0', 'refuse', 'malformed'],
  ['', 'refuse', 'empty'],
  ['...', 'refuse', 'empty'],
  ['EXAMPLE.COM.', 'allow', 'name'],
  ['8.8.8.8', 'allow', 'public']
];
// DNS answers for https://probe.example.com/x (https, so every policy reaches the DNS step)
const DNS_HOST = 'probe.example.com';
const DNS_ROWS = [
  { label: 'public IPv4', answers: [PUB4], allow: [PUB4] },
  { label: 'public IPv6 then IPv4, order kept', answers: [PUB6, PUB4], allow: [PUB6, PUB4] },
  { label: 'a mislabelled family is read from the address', answers: [{ address: PUB6.address, family: 4 }], allow: [PUB6] },
  { label: 'private', answers: [{ address: '10.0.0.7', family: 4 }], refuse: 'private-answer', address: '10.0.0.7' },
  { label: 'mixed: public then private', answers: [PUB4, { address: '192.168.1.20', family: 4 }], refuse: 'private-answer', address: '192.168.1.20' },
  { label: '0.0.0.0 from a DNS filter', answers: [{ address: '0.0.0.0', family: 4 }], refuse: 'private-answer', address: '0.0.0.0' },
  { label: 'loopback', answers: [{ address: '127.0.0.1', family: 4 }], refuse: 'private-answer', address: '127.0.0.1' },
  { label: 'cloud metadata', answers: [{ address: '169.254.169.254', family: 4 }], refuse: 'private-answer', address: '169.254.169.254' },
  { label: 'NAT64 of a public IPv4 (OPEN)', answers: [{ address: '64:ff9b::5db8:d822', family: 6 }], allow: [{ address: '64:ff9b::5db8:d822', family: 6 }] },
  { label: 'NAT64 of a private IPv4 (NEW)', answers: [{ address: '64:ff9b::a00:5', family: 6 }], refuse: 'private-answer', address: '64:ff9b::a00:5' },
  { label: 'dotted ::ffff: loopback', answers: [{ address: '::ffff:127.0.0.1', family: 6 }], refuse: 'private-answer', address: '::ffff:127.0.0.1' },
  { label: 'dotted ::ffff: public (OPEN)', answers: [{ address: '::ffff:93.184.216.34', family: 6 }], allow: [{ address: '::ffff:93.184.216.34', family: 6 }] },
  { label: 'link-local with a zone id', answers: [{ address: 'fe80::1%eth0', family: 6 }], refuse: 'private-answer', address: 'fe80::1%eth0' },
  { label: 'ULA after a public IPv4', answers: [PUB4, { address: 'fd00::5', family: 6 }], refuse: 'private-answer', address: 'fd00::5' },
  { label: 'multicast (NEW)', answers: [{ address: '224.0.0.251', family: 4 }], refuse: 'private-answer', address: '224.0.0.251' },
  { label: '198.18.0.0/15 fake-IP proxy (PINNED)', answers: [{ address: '198.18.0.5', family: 4 }], allow: [{ address: '198.18.0.5', family: 4 }] },
  { label: 'empty answer', answers: [], refuse: 'no-address' },
  { label: 'not a list', answers: PUB4, refuse: 'no-address' },
  { label: 'non-IP answer', answers: [{ address: 'not-an-ip', family: 4 }], refuse: 'invalid-answer' },
  { label: 'an answer without an address', answers: [{}], refuse: 'invalid-answer' },
  { label: 'a bad answer before a private one: the first decides', answers: [{ address: 'x' }, { address: '10.0.0.1', family: 4 }], refuse: 'invalid-answer' },
  { label: 'resolver error ENOTFOUND', fails: 'ENOTFOUND' },
  { label: 'resolver error EAI_AGAIN', fails: 'EAI_AGAIN' },
  { label: '.invalid is answered locally', host: 'never.invalid', local: 'ENOTFOUND' }
];
const DNS_TEXT = {
  'private-answer': (p, row) => DNS_PREFIX[p] + DNS_HOST + ' resolves to private address ' + row.address,
  'no-address': () => 'no verified DNS address for ' + DNS_HOST,
  'invalid-answer': () => 'resolver returned an invalid IP address for ' + DNS_HOST
};

/* =============================================== MODULE =============================================== */
(async () => {
  // ---- M0. the module loads no network code and holds no state worth a clock ----
  A.ok(!undiciAtLoad, 'requiring the module does not load undici (it is required at dial time)');
  A.eq(Object.keys(S).sort(), ['EXITS', 'POLICIES', 'TABLE', 'classifyHost', 'normalizeHost', 'pinnedDispatcher', 'pinnedLookup',
    'privateAnswerExit', 'refusal', 'resolveValidated', 'session', 'validateUrl', 'withAnswerExit', 'withPinned'], 'the module exports the boundary and nothing else');

  // ---- M1. the table is data: frozen, ordered, every refused row names an exit that exists ----
  A.ok(Object.isFrozen(S.TABLE) && Object.isFrozen(S.TABLE.v4) && Object.isFrozen(S.TABLE.v4[0]) && Object.isFrozen(S.POLICIES.web) &&
    Object.isFrozen(S.POLICIES.web.checks) && Object.isFrozen(S.EXITS), 'TABLE, POLICIES and EXITS are deeply frozen');
  for (const row of S.TABLE.names.concat(S.TABLE.v4, S.TABLE.v6.filter(r => !r.embedded), [S.TABLE.malformed]))
    A.ok(typeof row.kind === 'string' && Object.prototype.hasOwnProperty.call(S.EXITS, row.exit), 'refused row ' + (row.cidr || row.rule || row.kind) + ' names its kind and an exit (' + row.exit + ')');
  for (const row of S.TABLE.v6.filter(r => r.embedded)) A.ok(row.at === 6 || row.at === 1, 'embedded-IPv4 row ' + row.cidr + ' says where its IPv4 sits');
  for (const row of S.TABLE.keptPublic) {
    const probe = row.cidr.split('/')[0].replace(/::$/, '::1');
    A.ok(S.classifyHost(probe).public === true, 'kept public on purpose: ' + row.cidr + ' (' + row.why + ')');
  }
  for (const name of POLICY_NAMES) {
    A.eq(S.POLICIES[name].checks, ['parse', 'file', 'scheme', 'classify', 'https', 'credentials'], name + ' checks in order: parse, file://, http(s), classify, https, credentials');
    A.eq(S.POLICIES[name].name, name, name + ' row carries its own name');
  }
  A.eq(Object.keys(S.POLICIES).sort(), POLICY_NAMES.slice().sort(), 'one POLICIES row per consumer family');

  // ---- M2. HOST_ROWS: classifyHost and every policy's validateUrl agree with the table ----
  for (const [url, want, kind, note] of HOST_ROWS) {
    const host = hostOfUrl(url);
    const c = S.classifyHost(new URL(url).hostname);
    A.ok(c.public === (want === 'allow') && c.kind === kind, url + ' classifies ' + want + '/' + kind + (note ? ' [' + note + ']' : '') + ': ' + JSON.stringify(c));
    if (want === 'refuse') A.ok(Object.prototype.hasOwnProperty.call(S.EXITS, c.exit), url + ' carries an exit: ' + c.exit);
    for (const p of POLICY_NAMES) {
      for (const origin of ['caller', 'redirect']) {
        const r = sync(() => S.validateUrl(url, p, origin));
        const httpOnly = new URL(url).protocol === 'http:';
        if (want === 'refuse') {
          const e = r.error;
          A.ok(e && e.code === 'EGRESS_REFUSED' && e.egress.reason === 'not-public' && e.egress.kind === kind && e.egress.host === host,
            p + '/' + origin + ' refuses ' + url + ' as not-public: ' + JSON.stringify(e && e.egress));
          A.eq(e && e.message, 'refusing to ' + VERB[p] + ' private/loopback/intranet host: ' + host, p + ' words the refusal of ' + url + ' as before');
          A.eq(e && (e.toolSummary || null), p === 'browser' ? 'private address refused' : null, p + ' row summary for ' + url);
          A.eq(e && e.hostAuthored === true, TOOL_POLICIES.has(p) && origin === 'caller', p + '/' + origin + ' host-authored only for a tool consumer\'s own URL: ' + url);
        } else if ((p === 'connectorOauth' || p === 'skillSource') && httpOnly) {
          A.eq(r.error && [r.error.egress.reason, r.error.message], ['https', HTTPS_TEXT[p]], p + ' refuses plain http for a public host: ' + url);
        } else {
          A.ok(r.value instanceof URL && r.value.href === new URL(url).href, p + '/' + origin + ' allows ' + url + (r.error ? ' (refused: ' + r.error.message + ')' : ''));
        }
      }
    }
  }

  // ---- M3. RAW_ROWS: resolver answers and raw strings ----
  for (const [raw, want, kind] of RAW_ROWS) {
    const c = S.classifyHost(raw);
    A.ok(c.public === (want === 'allow') && c.kind === kind, JSON.stringify(raw) + ' classifies ' + want + '/' + kind + ': ' + JSON.stringify(c));
  }
  A.eq(S.classifyHost('fe80::1%eth0').ip, 'fe80::1', 'the zone id is stripped before classification');
  A.eq(S.normalizeHost('[FD00::1]'), 'fd00::1', 'normalizeHost lowercases and strips IPv6 brackets');
  A.eq(S.normalizeHost('Svc.Internal..'), 'svc.internal', 'normalizeHost strips root dots from a name');

  // ---- M4. wording and check order per policy (literal goldens: the bytes each consumer printed before the module) ----
  const each = v => ({ web: v, browser: v, connectorOauth: v, skillSource: v });
  const WORDING = [
    ['not a url', each(['invalid-url', 'invalid URL: not a url', 'invalid URL'])],
    ['file:///etc/passwd', { web: ['file-scheme', WEB_FILE, 'not a web address (file://)'], browser: ['file-scheme', BROWSER_FILE, 'not a web address (file://)'],
      connectorOauth: ['file-scheme', WEB_FILE, 'not a web address (file://)'], skillSource: ['file-scheme', WEB_FILE, 'not a web address (file://)'] }],
    ['ftp://example.com/', each(['scheme', 'only http(s) URLs are allowed', 'not a web address'])],
    ['javascript:alert(1)', each(['scheme', 'only http(s) URLs are allowed', 'not a web address'])],
    // classify runs before https: a private http endpoint is refused as private, not as plain http
    ['http://127.0.0.1:8787/api/key', { web: ['not-public', 'refusing to fetch private/loopback/intranet host: 127.0.0.1', null],
      browser: ['not-public', 'refusing to navigate to private/loopback/intranet host: 127.0.0.1', 'private address refused'],
      connectorOauth: ['not-public', 'refusing to fetch private/loopback/intranet host: 127.0.0.1', null],
      skillSource: ['not-public', 'refusing to fetch private/loopback/intranet host: 127.0.0.1', null] }],
    // https runs before credentials
    ['http://user:pw@example.com/', { web: 'allow', browser: 'allow', connectorOauth: ['https', HTTPS_TEXT.connectorOauth, null], skillSource: ['https', HTTPS_TEXT.skillSource, null] }],
    ['https://user:pw@example.com/', { web: 'allow', browser: 'allow', connectorOauth: ['credentials', CRED_TEXT.connectorOauth, null], skillSource: ['credentials', CRED_TEXT.skillSource, null] }],
    ['https://example.com/a?b=c', each('allow')]
  ];
  for (const [url, per] of WORDING) {
    for (const p of POLICY_NAMES) {
      const r = sync(() => S.validateUrl(url, p));
      if (per[p] === 'allow') { A.ok(r.value instanceof URL, p + ' allows ' + url + (r.error ? ' (refused: ' + r.error.message + ')' : '')); continue; }
      const [reason, text, summary] = per[p];
      A.eq(r.error && [r.error.egress.reason, r.error.message, r.error.toolSummary || null], [reason, text, summary], p + ' wording for ' + url);
      A.eq(r.error && r.error.hostAuthored === true, TOOL_POLICIES.has(p), p + ' marks its own-URL refusal of ' + url + ' host-authored only if it is a tool consumer');
      const hop = sync(() => S.validateUrl(url, p, 'redirect'));
      A.ok(hop.error && hop.error.message === text && hop.error.hostAuthored !== true && hop.error.egress.origin === 'redirect', p + ': a redirect hop to ' + url + ' gets the same words, never host-authored');
    }
  }
  A.eq(FILE_TEXT.browser, BROWSER_FILE, 'file hint table is the one the goldens use');

  // ---- M5. resolveValidated: ONE DNS question, every answer classified, fail closed ----
  for (const row of DNS_ROWS) {
    for (const p of POLICY_NAMES) {
      for (const origin of ['caller', 'redirect']) {
        const calls = [];
        let thrown = null;
        const lookup = async (name, opts) => {
          calls.push([name, opts]);
          if (row.fails) { thrown = Object.assign(new Error('getaddrinfo ' + row.fails + ' ' + name), { code: row.fails, hostname: name }); throw thrown; }
          return row.answers;
        };
        const url = 'https://' + (row.host || DNS_HOST) + '/x';
        const r = await settle(S.resolveValidated(url, { policy: p, lookup, origin }));
        const tag = p + '/' + origin + ' ' + row.label;
        if (row.local) {
          A.eq(calls.length, 0, tag + ': never asks DNS');
          A.ok(r.error && r.error.code === row.local && r.error.message === 'getaddrinfo ENOTFOUND never.invalid' && r.error.hostAuthored !== true, tag + ': ' + (r.error && r.error.message));
          continue;
        }
        A.eq(calls, [[DNS_HOST, { all: true }]], tag + ': exactly one DNS question, all:true, for the URL\'s own name');
        if (row.allow) {
          const d = r.value;
          A.ok(d && !r.error, tag + ': allowed' + (r.error ? ' (refused: ' + r.error.message + ')' : ''));
          if (!d) continue;
          A.eq(d.addresses.map(a => [a.address, a.family]), row.allow.map(a => [a.address, a.family]), tag + ': the Destination holds every validated address, in order, family from the address');
          A.ok(Object.isFrozen(d) && Object.isFrozen(d.addresses) && Object.isFrozen(d.addresses[0]), tag + ': the Destination is frozen');
          A.eq([d.host, d.literal, d.policy, d.origin, d.href], [DNS_HOST, false, p, origin, url], tag + ': host, literal, policy, origin, href');
        } else if (row.fails) {
          A.ok(r.error === thrown, tag + ': the resolver error is rethrown as raised (code ' + row.fails + ' kept)');
          A.ok(r.error && r.error.hostAuthored !== true && !r.error.egress, tag + ': a resolver failure is not dressed up as a refusal');
        } else {
          const e = r.error;
          A.ok(e && e.code === 'EGRESS_REFUSED' && e.egress.reason === row.refuse && e.egress.host === DNS_HOST, tag + ': refused as ' + row.refuse + ': ' + JSON.stringify(e && e.egress));
          A.eq(e && e.message, DNS_TEXT[row.refuse](p, row), tag + ': words it as before');
          const own = row.refuse === 'private-answer' && TOOL_POLICIES.has(p) && origin === 'caller';
          A.eq(e && e.hostAuthored === true, own, tag + ': host-authored only for a tool consumer\'s own URL');
          if (row.refuse === 'private-answer') A.ok(e && e.egress.address === row.address && e.egress.exit === 'dns-filter' && e.egress.transient === false, tag + ': names the address and the DNS-filter exit');
          else A.ok(e && e.egress.exit === 'dns-retry' && e.egress.transient === true, tag + ': an unusable answer is transient, with its retry exit');
        }
      }
    }
  }

  // ---- M6. literal, static mode, default lookup read at call time ----
  {
    let asked = 0;
    const lit = await S.resolveValidated('https://[2606:4700:4700::1111]:8443/x', { policy: 'connectorOauth', lookup: async () => { asked++; return [PUB4]; } });
    A.eq([asked, lit.literal, lit.host, lit.addresses], [0, true, '2606:4700:4700::1111', [{ address: '2606:4700:4700::1111', family: 6 }]], 'an IP literal needs no DNS: its address is the destination');
    A.eq(S.pinnedDispatcher(lit, { agentFactory: () => { throw new Error('no agent for a literal'); } }), null, 'and no pinned dispatcher');
    const lit4 = await S.resolveValidated('http://8.8.8.8/', { policy: 'web', lookup: async () => { asked++; return []; } });
    A.eq([asked, lit4.addresses], [0, [{ address: '8.8.8.8', family: 4 }]], 'an IPv4 literal likewise');
    const st = await S.resolveValidated('https://static.example/', { policy: 'web', lookup: null });
    A.eq([st.literal, st.addresses], [false, []], 'lookup:null is the test-only static mode: no DNS answer');
    A.eq(S.pinnedDispatcher(st, { agentFactory: () => { throw new Error('no agent in static mode'); } }), null, 'and no pin in static mode');
    const stRefused = await settle(S.resolveValidated('http://127.0.0.1/', { policy: 'web', lookup: null }));
    A.ok(stRefused.error && stRefused.error.egress.reason === 'not-public', 'static mode still refuses a private literal');
    const bad = await settle(S.resolveValidated('https://x.example/', { policy: 'web', lookup: 'yes' }));
    A.ok(bad.error instanceof TypeError, 'a lookup that is not a function, null or absent is a programming error');
    const orig = dns.promises.lookup;
    const calls = [];
    dns.promises.lookup = async (name, opts) => { calls.push([name, opts]); return [PUB4]; };
    try {
      const d = await S.resolveValidated('https://late-bound.example/x', { policy: 'browser' });
      A.eq(calls, [['late-bound.example', { all: true }]], 'the default lookup is dns.promises.lookup as it is at call time (the preload rigs swap it after boot), asked once');
      A.eq(d.addresses.map(a => a.address), [PUB4.address], 'and its answer is the destination');
    } finally { dns.promises.lookup = orig; }
    const dest = await S.resolveValidated('https://frozen.example/x', { policy: 'web', lookup: async () => [PUB4] });
    A.throws(() => { dest.host = 'evil.example'; }, 'a Destination cannot be re-aimed: host is frozen');
    A.throws(() => { dest.addresses.push({ address: '127.0.0.1', family: 4 }); }, 'nor can its address list grow');
    const u = dest.url; u.hostname = 'evil.example';
    A.eq([dest.href, dest.url.hostname], ['https://frozen.example/x', 'frozen.example'], 'dest.url is a fresh URL on every read: mutating one never moves the destination');
    A.throws(() => S.validateUrl('https://x.example/', Object.assign({}, S.POLICIES.web)), 'a look-alike policy row is refused: every consumer names its own row');
    A.throws(() => S.validateUrl('https://x.example/'), 'a policy is required');
    A.throws(() => S.validateUrl('https://x.example/', 'web', 'remote'), 'origin is caller or redirect');
  }

  // ---- M7. differential: every CIDR row against an independent net.BlockList ----
  {
    const bl = new net.BlockList();
    for (const r of S.TABLE.v4) { const [a, b] = r.cidr.split('/'); bl.addSubnet(a, Number(b), 'ipv4'); }
    for (const r of S.TABLE.v6) if (!r.embedded) { const [a, b] = r.cidr.split('/'); bl.addSubnet(a, Number(b), 'ipv6'); }
    const v4num = s => s.split('.').reduce((n, p) => n * 256 + Number(p), 0);
    const v4str = n => [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
    const samples4 = new Set();
    for (const r of S.TABLE.v4.concat(S.TABLE.keptPublic.filter(k => k.cidr.indexOf(':') < 0))) {
      const [a, b] = r.cidr.split('/');
      const base = v4num(a), size = Math.pow(2, 32 - Number(b));
      for (const n of [base - 1, base, base + 1, base + Math.floor(size / 2), base + size - 2, base + size - 1, base + size])
        if (n >= 0 && n < Math.pow(2, 32)) samples4.add(v4str(n));
    }
    for (let a = 0; a < 256; a++) for (const b of [0, 1, 63, 64, 127, 128, 168, 169, 254, 255]) samples4.add(a + '.' + b + '.' + ((a * 7) % 256) + '.' + ((a + b) % 256));
    const hex4 = s => { const o = s.split('.').map(Number); return (o[0] * 256 + o[1]).toString(16) + ':' + (o[2] * 256 + o[3]).toString(16); };
    const miss = [];
    for (const s of samples4) {
      const want = bl.check(s, 'ipv4');
      if (want !== !S.classifyHost(s).public) miss.push(s);
      // the mapped spellings: BlockList maps ::ffff:a.b.c.d onto its IPv4 rules itself, so this cross-checks the module's extraction
      for (const m of ['::ffff:' + s, '0:0:0:0:0:ffff:' + hex4(s)]) if (bl.check(m, 'ipv6') !== !S.classifyHost(m).public) miss.push(m);
    }
    A.ok(samples4.size > 2500, 'the IPv4 differential covers every row boundary and a sweep of the space (' + samples4.size + ' addresses)');
    A.eq(miss.slice(0, 8), [], 'every IPv4 (and IPv4-mapped) sample: the module refuses exactly what net.BlockList blocks (' + miss.length + ' disagreements)');

    // IPv6, with BigInt arithmetic and WHATWG's own parser (independent of the module's)
    const v6big = s => {
      const h = new URL('http://[' + s + ']/').hostname.slice(1, -1);
      const gap = h.indexOf('::');
      const l = gap < 0 ? h.split(':') : (h.slice(0, gap) ? h.slice(0, gap).split(':') : []);
      const r = gap < 0 ? [] : (h.slice(gap + 2) ? h.slice(gap + 2).split(':') : []);
      const parts = gap < 0 ? l : l.concat(new Array(8 - l.length - r.length).fill('0'), r);
      return parts.reduce((n, p) => (n << 16n) | BigInt(parseInt(p, 16)), 0n);
    };
    const v6full = n => { const out = []; for (let i = 7; i >= 0; i--) out.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16)); return out.join(':'); };
    const MAX = (1n << 128n) - 1n;
    const inPrefix = (n, cidr) => { const [a, b] = cidr.split('/'); const shift = BigInt(128 - Number(b)); return (n >> shift) === (v6big(a) >> shift); };
    // a sample inside an embedded-IPv4 prefix is decided by its IPv4 (section M8); BlockList maps only ::ffff:0:0/96 itself
    const elsewhere = S.TABLE.v6.filter(r => r.embedded && r.embedded !== 'mapped').map(r => r.cidr);
    const samples6 = new Set();
    for (const r of S.TABLE.v6.filter(x => !x.embedded).concat(S.TABLE.keptPublic.filter(k => k.cidr.indexOf(':') >= 0))) {
      const [a, b] = r.cidr.split('/');
      const base = v6big(a), last = base + (1n << BigInt(128 - Number(b))) - 1n;
      for (const n of [base - 1n, base, base + 1n, last - 1n, last, last + 1n]) if (n >= 0n && n <= MAX) samples6.add(n);
    }
    const firsts = [0x0064, 0x00ff, 0x0100, 0x0101, 0x2001, 0x2002, 0x2003, 0xfbff, 0xfc00, 0xfdff, 0xfe00, 0xfe7f, 0xfe80, 0xfebf, 0xfec0, 0xfeff, 0xff00, 0xffff];
    for (let i = 0; i < 256; i++) firsts.push(i * 257);
    for (const f of firsts) samples6.add((BigInt(f) << 112n) | 0x1234_5678_9abc_def0_0001_0002_0003n);
    for (const s of samples4) samples6.add(v6big('::ffff:' + s));
    let checked6 = 0;
    const miss6 = [];
    for (const n of samples6) {
      if (elsewhere.some(c => inPrefix(n, c))) continue;
      const full = v6full(n), short = new URL('http://[' + full + ']/').hostname.slice(1, -1);
      const want = bl.check(full, 'ipv6');
      checked6++;
      if (want !== !S.classifyHost(full).public || want !== !S.classifyHost(short).public) miss6.push(short);
    }
    A.ok(checked6 > 2500, 'the IPv6 differential covers every row boundary, a sweep of the first hextet and every mapped IPv4 sample (' + checked6 + ' addresses)');
    A.eq(miss6.slice(0, 8), [], 'every IPv6 sample, expanded and compressed: the module refuses exactly what net.BlockList blocks (' + miss6.length + ' disagreements)');
  }

  // ---- M8. every IPv6 spelling of each embedded-IPv4 block is classified by its IPv4 ----
  {
    const V4S = ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.8', '224.0.0.1',
      '240.0.0.1', '255.255.255.255', '8.8.8.8', '93.184.216.34', '198.18.0.1', '192.0.2.1'];
    const spellings = v4 => {
      const o = v4.split('.').map(Number), hi = o[0] * 256 + o[1], lo = o[2] * 256 + o[3];
      const h = n => n.toString(16), H = n => n.toString(16).padStart(4, '0');
      return [
        ['mapped', '::ffff:' + v4], ['mapped', '::ffff:' + h(hi) + ':' + h(lo)], ['mapped', '0:0:0:0:0:ffff:' + h(hi) + ':' + h(lo)],
        ['mapped', '0000:0000:0000:0000:0000:ffff:' + H(hi) + ':' + H(lo)], ['mapped', ('::ffff:' + h(hi) + ':' + h(lo)).toUpperCase()],
        ['mapped', '::ffff:' + v4 + '%eth0', 'raw'],
        ['translated', '::ffff:0:' + v4], ['translated', '0:0:0:0:ffff:0:' + h(hi) + ':' + h(lo)],
        ['compatible', '::' + v4], ['compatible', '::' + h(hi) + ':' + h(lo)], ['compatible', '0:0:0:0:0:0:' + h(hi) + ':' + h(lo)],
        ['nat64', '64:ff9b::' + v4], ['nat64', '64:ff9b::' + h(hi) + ':' + h(lo)], ['nat64', '0064:ff9b:0000:0000:0000:0000:' + H(hi) + ':' + H(lo)],
        ['6to4', '2002:' + h(hi) + ':' + h(lo) + '::'], ['6to4', '2002:' + h(hi) + ':' + h(lo) + '::1'], ['6to4', '2002:' + H(hi) + ':' + H(lo) + ':0:0:0:0:1'],
        ['6to4', '2002:' + h(hi) + ':' + h(lo) + ':abcd::' + v4]
      ];
    };
    let rows = 0;
    for (const v4 of V4S) {
      const base = S.classifyHost(v4);
      for (const [form, spelled, raw] of spellings(v4)) {
        rows++;
        const c = S.classifyHost(spelled);
        // '::0.0.0.0' is '::' itself, the unspecified row: same verdict, no embedded address to report
        const unspecified = form === 'compatible' && v4 === '0.0.0.0';
        A.ok(c.public === base.public && c.kind === base.kind && (unspecified || (c.embedded === v4 && c.form === form)),
          spelled + ' is classified by its IPv4 ' + v4 + ' (' + form + '): ' + JSON.stringify(c));
        if (raw) continue;
        const url = 'http://[' + spelled + ']/';
        const r = sync(() => S.validateUrl(url, 'web'));
        A.eq(!!r.error, !base.public, url + ' (WHATWG: ' + new URL(url).hostname + ') ' + (base.public ? 'allowed' : 'refused') + ' like ' + v4);
      }
    }
    A.ok(rows >= 15 * 18, 'every block has every spelling (' + rows + ' rows)');
  }

  // ---- M9. pinnedLookup: the one connect-time lookup ----
  {
    const L = S.pinnedLookup([PUB6, PUB4], 'Shape.Example.');
    const call = (host, opts) => { let out = null; L(host, opts, (err, a, f) => { out = { err, a, f }; }); return out; };
    const all = call('shape.example', { all: true });
    A.eq([all.err, all.a], [null, [PUB6, PUB4]], 'all:true (Node autoSelectFamily) gets every validated address, in order');
    all.a[0].address = '127.0.0.1';
    A.eq(call('shape.example', { all: true }).a, [PUB6, PUB4], 'and gets copies: a caller mutating them cannot re-aim the next answer');
    const one = call('shape.example', {});
    A.eq([one.err, one.a, one.f], [null, PUB6.address, 6], 'the single-address shape gets the first validated address');
    A.eq(call('SHAPE.example.', {}).a, PUB6.address, 'case and root dot do not change the name');
    A.eq([call('shape.example', { family: 4 }).a, call('shape.example', { family: 'IPv6' }).a], [PUB4.address, PUB6.address], 'options.family keeps that family only');
    A.eq(call('shape.example', { family: 4, all: true }).a, [PUB4], 'family + all: the validated addresses of that family');
    A.eq(call('shape.example', 4).a, PUB4.address, 'a bare family number is honoured');
    let fnShape = null; L('shape.example', (err, a) => { fnShape = a; });
    A.eq(fnShape, PUB6.address, 'lookup(host, callback) works');
    const other = call('evil.example', { all: true });
    A.ok(other.err && other.err.code === 'EGRESS_REFUSED' && other.a === undefined, 'a pinned lookup never answers for a name it did not validate');
    const v4only = S.pinnedLookup(['93.184.216.34'], 'x.example');
    let none = null; v4only('x.example', { family: 6 }, err => { none = err; });
    A.ok(none && none.code === 'ENOTFOUND', 'asking for a family the validated answer lacks is ENOTFOUND, never another address');
    let anyName = null; S.pinnedLookup([PUB4])('whatever.example', {}, (err, a) => { anyName = a; });
    A.eq(anyName, PUB4.address, 'without a host it answers any name (the proxy pins per dial)');
    A.throws(() => S.pinnedLookup([{ address: 'localhost' }]), 'only IP addresses can be pinned');
    A.throws(() => S.pinnedLookup([]), 'an empty pin is a programming error');
  }

  // ---- M10. pinnedDispatcher ----
  {
    const two = await S.resolveValidated('https://two.example/', { policy: 'web', lookup: async () => [PUB6, PUB4] });
    const one = await S.resolveValidated('https://one.example/', { policy: 'web', lookup: async () => [PUB4] });
    let seen = null;
    const agent = S.pinnedDispatcher(two, { agentFactory: o => { seen = o; return { tag: 'fake' }; },
      connect: { timeout: 1234, lookup: () => { throw new Error('a caller lookup must never reach the socket'); } } });
    A.eq(agent, { tag: 'fake' }, 'the agentFactory builds the dispatcher');
    A.ok(seen.connect.autoSelectFamily === true, 'two or more addresses: autoSelectFamily on, explicitly, so every Node walks the list');
    A.eq(seen.connect.timeout, 1234, 'other connect options pass through');
    let list = null; seen.connect.lookup('two.example', { all: true }, (e, l) => { list = l; });
    A.eq(list, [PUB6, PUB4], 'the connect lookup is the pinned one (a caller\'s lookup is overridden)');
    S.pinnedDispatcher(one, { agentFactory: o => { seen = o; return {}; } });
    A.ok(!('autoSelectFamily' in seen.connect), 'one address: Node\'s own default');
    A.throws(() => S.pinnedDispatcher({ url: new URL('https://x.example/'), host: 'x.example', addresses: [PUB4], literal: false }), 'a hand-built destination is refused');
    A.throws(() => S.pinnedDispatcher(Object.assign({}, one)), 'a copy of a minted Destination is refused');
    A.ok(!Object.keys(require.cache).some(k => UNDICI_RE.test(k)), 'undici is still not loaded before the first real dispatcher');
    const real = S.pinnedDispatcher(one);
    const undici = require('undici');
    A.ok(real instanceof undici.Agent, 'the default dispatcher is an undici Agent, required at call time');
    await real.close();
    A.ok(real.closed === true, 'and it closes');
  }

  // ---- M11. withPinned: build, run, close ----
  {
    const dest = await S.resolveValidated('https://pin.example/x', { policy: 'web', lookup: async () => [PUB4] });
    const log = [];
    const agentFactory = o => ({ o, close: async () => { log.push('close'); } });
    const got = await S.withPinned(dest, { agentFactory }, async d => { log.push('fn'); return d && typeof d.o.connect.lookup === 'function' ? 'body' : 'no dispatcher'; });
    A.eq([got, log], ['body', ['fn', 'close']], 'fn gets the pinned dispatcher, and the close is awaited after it');
    log.length = 0;
    const boom = await settle(S.withPinned(dest, { agentFactory }, async () => { log.push('fn'); throw new Error('boom'); }));
    A.ok(boom.error && boom.error.message === 'boom', 'fn\'s error propagates');
    A.eq(log, ['fn', 'close'], 'and the dispatcher is still closed');
    let release = null;
    const held = new Promise(r => { release = r; });
    let done = false;
    const w = S.withPinned(dest, { agentFactory: () => ({ close: () => held }) }, async () => 'x').then(() => { done = true; });
    await new Promise(r => setImmediate(r));
    A.eq(done, false, 'the default close is awaited: withPinned returns only once the dispatcher has closed');
    release(); await w;
    A.eq(done, true, 'and returns once it has');
    const seenErr = [];
    const failing = () => ({ close: async () => { throw new Error('close failed'); } });
    A.eq(await S.withPinned(dest, { agentFactory: failing, onCloseError: e => seenErr.push(e.message) }, async () => 'ok'), 'ok', 'a close error never replaces the result');
    A.eq(seenErr, ['close failed'], 'it goes to onCloseError');
    const before = F.counts()['net.egress.dispatcher-close'] || 0;
    await S.withPinned(dest, { agentFactory: failing }, async () => 'ok');
    A.eq((F.counts()['net.egress.dispatcher-close'] || 0) - before, 1, 'with no handler it is noted through failopen, never swallowed');
    let calls = 0, releaseBg = null;
    const bgHeld = new Promise(r => { releaseBg = r; });
    const bg = await S.withPinned(dest, { agentFactory: () => ({ close: () => { calls++; return bgHeld; } }), closeInBackground: true }, async () => 'response');
    A.eq(bg, 'response', 'closeInBackground: returns while undici\'s graceful close still waits for the body the caller reads next');
    await new Promise(r => setImmediate(r));
    A.eq(calls, 1, 'and the close was started');
    releaseBg();
    const bgErr = [];
    await S.withPinned(dest, { agentFactory: failing, closeInBackground: true, onCloseError: e => bgErr.push(e.message) }, async () => 'ok');
    await new Promise(r => setImmediate(r));
    A.eq(bgErr, ['close failed'], 'a background close error is reported too');
    const lit = await S.resolveValidated('https://[2606:4700:4700::1111]/', { policy: 'web', lookup: async () => { throw new Error('never asked'); } });
    let handed = 'unset';
    await S.withPinned(lit, { agentFactory: () => { throw new Error('no agent for a literal'); } }, async d => { handed = d; });
    A.eq(handed, null, 'an IP literal runs with no dispatcher');
    A.ok((await settle(S.withPinned({ addresses: [PUB4] }, {}, async () => 'x'))).error instanceof TypeError, 'withPinned refuses a hand-built destination');
  }

  // ---- M12. session: one validated answer and one keep-alive dispatcher per host, closed at the end ----
  {
    const asked = [], made = [];
    const sess = S.session({ policy: 'skillSource',
      lookup: async name => { asked.push(name); return name === 'raw.githubusercontent.com' ? [PUB6, PUB4] : [{ address: '140.82.112.6', family: 4 }]; },
      agentFactory: o => { const a = { o, closed: 0, close: async () => { a.closed++; } }; made.push(a); return a; } });
    const d1 = await sess.resolve('https://raw.githubusercontent.com/o/r/main/SKILL.md');
    const d2 = await sess.resolve('https://raw.githubusercontent.com/o/r/main/references/a.md');
    const d3 = await sess.resolve('https://api.github.com/repos/o/r/contents/x', { origin: 'redirect' });
    A.eq(asked, ['raw.githubusercontent.com', 'api.github.com'], 'one DNS question per host for the whole session');
    A.ok(d1.addresses === d2.addresses, 'every Destination of a host carries the one validated answer');
    A.eq(d3.origin, 'redirect', 'each Destination keeps its own origin');
    A.ok(sess.dispatcher(d1) === sess.dispatcher(d2) && sess.dispatcher(d1) === made[0], 'one keep-alive dispatcher per host');
    A.ok(sess.dispatcher(d3) === made[1] && made.length === 2, 'another host gets its own');
    A.ok(made[0].o.connect.autoSelectFamily === true, 'the session pins every validated address');
    const outside = await S.resolveValidated('https://raw.githubusercontent.com/x', { policy: 'skillSource', lookup: async () => [PUB4] });
    A.throws(() => sess.dispatcher(outside), 'a session dials only a Destination it resolved');
    const refused = await settle(sess.resolve('http://127.0.0.1/x'));
    A.ok(refused.error && refused.error.egress.reason === 'not-public' && refused.error.message === 'refusing to fetch private/loopback/intranet host: 127.0.0.1', 'every URL is still validated');
    await sess.close();
    A.eq(made.map(a => a.closed), [1, 1], 'close() closes every dispatcher once');
    await sess.close();
    A.eq(made.map(a => a.closed), [1, 1], 'close() is idempotent');
    A.ok(sess.isClosed() && (await settle(sess.resolve('https://raw.githubusercontent.com/o/r/main/x'))).error, 'a closed session resolves nothing');
    A.throws(() => sess.dispatcher(d1), 'and dials nothing');

    let n = 0, open = null;
    const gate = new Promise(r => { open = r; });
    const race = S.session({ policy: 'web', lookup: async () => { n++; await gate; return [{ address: '10.0.0.9', family: 4 }]; } });
    const a = settle(race.resolve('https://rebind.example/a'));
    const b = settle(race.resolve('https://rebind.example/b', { origin: 'redirect' }));
    open();
    const [ra, rb] = await Promise.all([a, b]);
    A.eq(n, 1, 'concurrent resolves of one host ask DNS once');
    A.ok(ra.error && ra.error.hostAuthored === true && ra.error.egress.origin === 'caller', 'the caller URL\'s refusal is host-authored');
    A.ok(rb.error && rb.error.hostAuthored !== true && rb.error.egress.origin === 'redirect' && rb.error.message === ra.error.message, 'the redirect hop sharing that answer gets its own, never host-authored');
    await settle(race.resolve('https://rebind.example/c'));
    A.eq(n, 2, 'a refused answer is not cached: the next resolve asks again');
    await race.close();
    const failingClose = S.session({ policy: 'web', lookup: async () => [PUB4], agentFactory: () => ({ close: async () => { throw new Error('close failed'); } }), onCloseError: e => made.push(e.message) });
    failingClose.dispatcher(await failingClose.resolve('https://x.example/'));
    await failingClose.close();
    A.eq(made[made.length - 1], 'close failed', 'a session close error is reported');
  }

  // ---- M13. refusal() and the DNS-filter exit ----
  {
    A.throws(() => S.refusal('nope', { policy: 'web' }), 'an unknown reason is a programming error');
    A.throws(() => S.refusal('https', { policy: 'web' }), 'a policy without https wording cannot refuse for https');
    A.throws(() => S.refusal('not-public', { host: 'x' }), 'a refusal names its policy');
    const e = S.refusal('not-public', { policy: 'browser', host: 'svc.internal', kind: 'intranet-name', exit: 'local-service' });
    A.eq([e.message, e.code, e.toolSummary, e.hostAuthored], ['refusing to navigate to private/loopback/intranet host: svc.internal', 'EGRESS_REFUSED', 'private address refused', true], 'refusal(): policy wording, code, summary, host-authored for a tool consumer\'s own URL');
    A.ok(Object.isFrozen(e.egress) && e.egress.exit === 'local-service' && e.egress.origin === 'caller', 'refusal(): a frozen egress record with its exit');
    A.ok(S.refusal('not-public', { policy: 'connectorOauth', host: 'x.internal' }).hostAuthored !== true, 'connector OAuth never marks a refusal host-authored');
    A.ok(S.refusal('not-public', { policy: 'web', host: 'x.internal', origin: 'redirect' }).hostAuthored !== true, 'a redirect hop\'s refusal is never host-authored');
    const BROWSER_GOLDEN = 'StarNet\'s browser safety check refused it: this computer\'s DNS answered 0.0.0.0 for www.etsy.com, a private or blocked address. ' +
      'That answer usually comes from a DNS filter (Pi-hole, AdGuard, NextDNS, router parental controls), a VPN, a security app or the hosts file on this computer. ' +
      'A browser using its own secure DNS can still open the site, so it may work there. StarNet\'s browser uses no outside proxy, VPN or gateway: it connects ' +
      'from this computer. Fix or allow www.etsy.com in that DNS filter.';
    A.eq(S.privateAnswerExit('www.etsy.com', '0.0.0.0', 'browser'), BROWSER_GOLDEN, 'the browser voice is explainRefusal\'s text, byte for byte');
    const B = require('../sidecar/tools/builtin/browser.js')._internals;
    A.eq(B.explainRefusal({ host: 'www.etsy.com', reason: 'refusing to navigate: www.etsy.com resolves to private address 0.0.0.0' }).text, BROWSER_GOLDEN,
      'and browser.js explainRefusal says exactly that');
    const web = S.privateAnswerExit('api.shop.example', '10.1.2.3', 'web');
    A.ok(web.startsWith('this computer\'s DNS answered 10.1.2.3 for api.shop.example, a private or blocked address.') && /Fix or allow api\.shop\.example in that DNS filter\.$/.test(web) &&
      /own secure DNS/.test(web) && !/StarNet's browser/.test(web), 'the web voice: what answered, who usually answers so, and the exit');
    const station = S.privateAnswerExit('auth.example', '0.0.0.0', 'connectorOauth');
    A.ok(/DNS answered 0\.0\.0\.0 for auth\.example/.test(station) && /Fix or allow auth\.example in that DNS filter\.$/.test(station) && !/own secure DNS/.test(station),
      'connector sign-in speaks in the station voice (a policy name picks its voice)');
    A.eq(S.privateAnswerExit('h.example', '0.0.0.0', S.POLICIES.web), S.privateAnswerExit('h.example', '0.0.0.0', 'web'), 'a POLICIES row picks its voice too');
    // withAnswerExit: the one way every consumer appends it (as its own sentence, once), and only to a private answer
    const priv = async p => (await settle(S.resolveValidated('https://h.example/', { policy: p, lookup: async () => [{ address: '0.0.0.0', family: 4 }] }))).error;
    for (const p of POLICY_NAMES) {
      const e = await priv(p);
      const before = e.message;
      A.ok(S.withAnswerExit(e, p) === e && e.message === before + '. ' + (s => s.charAt(0).toUpperCase() + s.slice(1))(S.privateAnswerExit('h.example', '0.0.0.0', p)), p + ': withAnswerExit appends the exit in its voice, as a sentence');
      S.withAnswerExit(e, p);
      A.ok(e.message.split('Fix or allow').length === 2 && e.code === 'EGRESS_REFUSED' && e.egress.reason === 'private-answer', p + ': once, however often it is called, and the refusal keeps its code and record');
    }
    const browserE = await priv('browser');
    A.eq(S.withAnswerExit(browserE, 'browser').message, 'refusing to navigate: h.example resolves to private address 0.0.0.0. ' + S.privateAnswerExit('h.example', '0.0.0.0', 'browser'), 'the browser\'s sentence starts as explainRefusal\'s does');
    const other = S.refusal('no-address', { policy: 'web', host: 'h.example' });
    const plainErr = new Error('getaddrinfo ENOTFOUND h.example');
    A.ok(S.withAnswerExit(other, 'web').message === 'no verified DNS address for h.example' && S.withAnswerExit(plainErr, 'web').message === 'getaddrinfo ENOTFOUND h.example' && S.withAnswerExit(null, 'web') === null,
      'any other refusal or error comes back untouched');
  }

  // ---- M14. the module speaks each consumer's words today: read through web.js and browser.js's own entry points ----
  {
    const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
    const W = makeWebTools({ fetchImpl: async () => ({ status: 200, text: async () => '', headers: { get: () => '' } }), lookup: null })._internals;
    const B = require('../sidecar/tools/builtin/browser.js')._internals;
    const consumers = [['web', W], ['browser', B]];
    for (const url of ['not a url', 'file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'http://127.0.0.1:8787/api/key', 'http://[::1]/',
      'http://localhost./', 'http://169.254.169.254/latest/meta-data/', 'http://wiki./', 'http://[fd00::1]/', 'https://example.com/']) {
      for (const [p, I] of consumers) {
        const want = sync(() => I.assertSafeUrl(url)), got = sync(() => S.validateUrl(url, p));
        const shape = r => r.error ? [r.error.message, r.error.toolSummary || null, r.error.hostAuthored === true] : ['allowed', r.value.href];
        A.eq(shape(got), shape(want), p + ' entry point and its POLICIES row agree on ' + url);
      }
    }
    for (const [label, answers] of [['private', [{ address: '10.0.0.7', family: 4 }]], ['empty', []], ['non-IP', [{ address: 'nope' }]]]) {
      for (const [p, I] of consumers) {
        const u = new URL('https://' + DNS_HOST + '/x');
        const want = await settle(I.assertResolvedSafe(u, async () => answers));
        const got = await settle(S.resolveValidated(u.href, { policy: p, lookup: async () => answers }));
        A.ok(want.error && got.error && want.error.message.startsWith(got.error.message), p + ' DNS refusal (' + label + ') keeps its words: ' + (got.error && got.error.message));
      }
    }
  }

  /* =============================================== CONSUMERS =============================================== */
  // This computer's DNS as the http preload rigs install it: dns.promises.lookup replaced in-process. No consumer below is
  // handed a lookup (index.js hands none), so every DNS question it asks lands here, read by the boundary at call time.
  const realDnsLookup = dns.promises.lookup;
  const asked = [];
  let answerFor = () => [PUB4];
  dns.promises.lookup = async (name, opts) => { asked.push([name, opts]); return answerFor(name); };
  const answerRow = (row, others) => name => {
    if (others && Object.prototype.hasOwnProperty.call(others, name)) return others[name];
    if (row.fails) throw Object.assign(new Error('getaddrinfo ' + row.fails + ' ' + name), { code: row.fails, hostname: name });
    return row.answers;
  };
  const isLiteral = url => net.isIP(hostOfUrl(url)) !== 0;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  // the sentence web_fetch / web_request append to a private-answer refusal (the browser appends its own voice)
  const webExit = (host, address) => '. ' + cap(S.privateAnswerExit(host, address, 'web'));
  async function section(name, fn) {
    try { await fn(); } catch (e) { A.ok(false, name + ': the section threw ' + (e && e.stack || e)); }
  }
  const { makeRegistry } = require('../sidecar/tools/registry.js');
  const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
  const BT = require('../sidecar/tools/builtin/browser.js');
  const WEB_TOOLS = ['web_fetch', 'web_request'];
  const plain = (status, loc) => ({ status, text: async () => 'consumer row ok',
    headers: { get: k => { k = String(k).toLowerCase(); return k === 'content-type' ? 'text/plain' : (k === 'location' ? loc || '' : ''); } } });
  // web_fetch and web_request as index.js registers them (makeWebTools with no lookup and no agentFactory of its own:
  // this computer's DNS, the boundary's dispatcher), with the fetch and the dispatcher factory recorded at the edge
  function webRig(answer) {
    const rec = { fetched: [], agents: [] };
    const reg = makeWebTools({
      fetchImpl: async (url, init) => { rec.fetched.push({ url: String(url), dispatcher: (init && init.dispatcher) || null }); return answer ? answer(String(url)) : plain(200); },
      agentFactory: o => { const a = { o, closed: 0, close: async () => { a.closed++; } }; rec.agents.push(a); return a; }
    }).register(makeRegistry());
    rec.run = (tool, url) => reg.dispatch({ id: 'row-' + tool, name: tool, args: { url } }, { agentId: 'agent' });
    return rec;
  }
  // what a pinned dispatcher hands Node's connect for `host`, in both callback shapes
  function pinOf(agent, host) {
    let all = null, one = null;
    agent.o.connect.lookup(host, { all: true }, (e, l) => { all = e ? 'error ' + e.code : l.map(a => [a.address, a.family]); });
    agent.o.connect.lookup(host, {}, (e, a, f) => { one = e ? 'error ' + e.code : [a, f]; });
    return { all, one };
  }
  const failed = (tool, text) => 'tool ' + tool + ' failed: ' + text;

  // ---- C1. web_fetch / web_request: the caller's own URL, every HOST_ROW ----
  await section('C1', async () => {
    for (const [url, want, , note] of HOST_ROWS) {
      const host = hostOfUrl(url), name = new URL(url).hostname;
      for (const tool of WEB_TOOLS) {
        asked.length = 0; answerFor = () => [PUB4];
        const rec = webRig();
        const r = await rec.run(tool, url);
        const tag = tool + ' ' + url + (note ? ' [' + note + ']' : '');
        if (want === 'refuse') {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, true, failed(tool, 'refusing to fetch private/loopback/intranet host: ' + host)], tag + ': refused in web\'s words, host-authored');
          A.eq([asked.length, rec.fetched.length, rec.agents.length], [0, 0, 0], tag + ': no DNS question, no fetch, no dispatcher');
          continue;
        }
        A.ok(!r.isError, tag + ': allowed' + (r.isError ? ' (refused: ' + r.content + ')' : ''));
        A.eq(rec.fetched.map(f => f.url), [new URL(url).href], tag + ': one fetch, of the URL as written');
        if (isLiteral(url)) {
          A.eq([asked.length, rec.agents.length, rec.fetched.length && rec.fetched[0].dispatcher], [0, 0, null], tag + ': an IP literal needs no DNS and no pin');
          continue;
        }
        A.eq(asked, [[name, { all: true }]], tag + ': ONE DNS question, for the URL\'s own name');
        A.ok(rec.agents.length === 1 && rec.fetched[0].dispatcher === rec.agents[0], tag + ': the fetch dials through the hop\'s pinned dispatcher');
        if (rec.agents[0]) A.eq([pinOf(rec.agents[0], name), rec.agents[0].closed], [{ all: [[PUB4.address, 4]], one: [PUB4.address, 4] }, 1], tag + ': which answers only the validated address, and is closed after the body');
      }
    }
  });

  // ---- C2. web_fetch / web_request: every DNS_ROW for the caller's own URL ----
  await section('C2', async () => {
    for (const row of DNS_ROWS) {
      const host = row.host || DNS_HOST, url = 'https://' + host + '/x';
      for (const tool of WEB_TOOLS) {
        asked.length = 0; answerFor = answerRow(row);
        const rec = webRig();
        const r = await rec.run(tool, url);
        const tag = tool + ' DNS ' + row.label;
        A.eq(asked, row.local ? [] : [[host, { all: true }]], tag + (row.local ? ': answered locally, never asked of DNS' : ': exactly one DNS question'));
        if (row.allow) {
          A.ok(!r.isError && rec.fetched.length === 1 && rec.agents.length === 1 && rec.fetched[0].dispatcher === rec.agents[0], tag + ': allowed, dialed through one pinned dispatcher');
          if (rec.agents[0]) A.eq([pinOf(rec.agents[0], host), rec.agents[0].closed], [{ all: row.allow.map(a => [a.address, a.family]), one: [row.allow[0].address, row.allow[0].family] }, 1],
            tag + ': the dial gets every validated address in order (the first for a single answer), and its dispatcher is closed');
          continue;
        }
        A.eq([rec.fetched.length, rec.agents.length], [0, 0], tag + ': nothing fetched, nothing dialed');
        if (row.refuse === 'private-answer') {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, true, failed(tool, DNS_TEXT[row.refuse]('web', row) + webExit(host, row.address))],
            tag + ': refused in web\'s words plus the DNS-filter exit, host-authored');
        } else if (row.refuse) {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed(tool, DNS_TEXT[row.refuse]('web', row))], tag + ': an unusable answer is refused in web\'s words, never host-authored');
        } else if (tool === 'web_fetch' && (row.fails || row.local) === 'ENOTFOUND') {
          A.eq([r.isError, r.summary], [false, 'domain not found'], tag + ': web_fetch answers a name that does not resolve as a dead domain');
        } else {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed(tool, 'getaddrinfo ' + (row.fails || row.local) + ' ' + host)], tag + ': the resolver\'s own error, never host-authored');
        }
      }
    }
  });

  // ---- C3. web_fetch / web_request: redirect hops (the remote server chose them) ----
  await section('C3', async () => {
    const START = 'https://start.example.com/page';
    const bounceTo = loc => url => (url.indexOf('://start.example.com/') > 0 ? plain(302, loc) : plain(200));
    for (const [url, want] of HOST_ROWS) {
      if (want !== 'refuse') continue;
      for (const tool of WEB_TOOLS) {
        asked.length = 0; answerFor = () => [PUB4];
        const rec = webRig(bounceTo(url));
        const r = await rec.run(tool, START);
        const tag = tool + ' redirect to ' + url;
        A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed(tool, 'refusing to fetch private/loopback/intranet host: ' + hostOfUrl(url))],
          tag + ': refused in the same words, never host-authored');
        A.eq([asked.map(q => q[0]), rec.fetched.length], [['start.example.com'], 1], tag + ': the refused hop is neither asked of DNS nor fetched');
      }
    }
    for (const row of DNS_ROWS) {
      if (row.allow) continue;
      const host = row.host || DNS_HOST;
      for (const tool of WEB_TOOLS) {
        asked.length = 0; answerFor = answerRow(row, { 'start.example.com': [PUB4] });
        const rec = webRig(bounceTo('https://' + host + '/x'));
        const r = await rec.run(tool, START);
        const tag = tool + ' redirect hop, DNS ' + row.label;
        A.eq([asked.map(q => q[0]), rec.fetched.length], [row.local ? ['start.example.com'] : ['start.example.com', host], 1], tag + ': one DNS question per hop, and only the first hop fetched');
        A.ok(r.hostAuthored !== true, tag + ': a redirect hop\'s refusal is never host-authored');
        if (row.refuse === 'private-answer') A.eq([r.isError, r.content], [true, failed(tool, DNS_TEXT[row.refuse]('web', row) + webExit(host, row.address))], tag + ': web\'s words plus the DNS-filter exit');
        else if (row.refuse) A.eq([r.isError, r.content], [true, failed(tool, DNS_TEXT[row.refuse]('web', row))], tag + ': web\'s words');
        else if (tool === 'web_request') A.eq([r.isError, r.content], [true, failed(tool, 'getaddrinfo ' + (row.fails || row.local) + ' ' + host)], tag + ': the resolver\'s own error');
      }
    }
    // a rebinding resolver: public for the hop's one question, loopback for any later one, which is never asked
    for (const tool of WEB_TOOLS) {
      let probe = 0;
      asked.length = 0;
      answerFor = name => (name === 'start.example.com' ? [PUB4] : (++probe === 1 ? [PUB6, PUB4] : [{ address: '127.0.0.1', family: 4 }]));
      const rec = webRig(bounceTo('https://' + DNS_HOST + '/x'));
      const r = await rec.run(tool, START);
      const tag = tool + ' rebinding redirect hop';
      A.ok(!r.isError, tag + ': followed on its one validated answer' + (r.isError ? ' (refused: ' + r.content + ')' : ''));
      A.eq([probe, asked.map(q => q[0])], [1, ['start.example.com', DNS_HOST]], tag + ': each hop asked DNS once; the later (loopback) answer was never asked for');
      A.eq(rec.agents.map((a, i) => pinOf(a, i ? DNS_HOST : 'start.example.com').all), [[[PUB4.address, 4]], [[PUB6.address, 6], [PUB4.address, 4]]], tag + ': each hop dials exactly its validated addresses');
      A.eq(rec.agents.map(a => a.closed), [1, 1], tag + ': every hop\'s dispatcher is closed');
    }
  });

  // browser.navigate and the login window as index.js builds the browser (makeBrowserTools, no lookup: this computer's
  // DNS); the CDP driver is the edge: it records where it was sent and lands where the row says
  function browserRig(landing) {
    const rec = { navigated: [], askedAtNavigate: [], prompts: [] };
    const driver = { navigate: async url => { rec.navigated.push(url); rec.askedAtNavigate.push(asked.length); return landing ? landing(url) : url; } };
    const reg = BT.makeBrowserTools({ driver, env: {}, attendedLogin: { prompt: async p => { rec.prompts.push(p.argsSummary); return 'deny'; } } }).register(makeRegistry());
    rec.run = (tool, url) => reg.dispatch({ id: 'row-' + tool, name: tool, args: { url } }, { agentId: 'agent' });
    return rec;
  }
  const NAV_WORDS = host => 'refusing to navigate to private/loopback/intranet host: ' + host;

  // ---- C4. browser.navigate and the login window: the caller's own URL, every HOST_ROW and DNS_ROW ----
  await section('C4', async () => {
    for (const [url, want, , note] of HOST_ROWS) {
      const host = hostOfUrl(url), name = new URL(url).hostname;
      for (const tool of ['browser.navigate', 'browser.login']) {
        asked.length = 0; answerFor = () => [PUB4];
        const rec = browserRig();
        const r = await rec.run(tool, url);
        const tag = tool + ' ' + url + (note ? ' [' + note + ']' : '');
        if (want === 'refuse') {
          A.eq([r.isError, r.hostAuthored === true, r.content, r.summary], [true, true, failed(tool, NAV_WORDS(host)), 'private address refused'], tag + ': refused in the browser\'s words, host-authored');
          A.eq([asked.length, rec.navigated.length, rec.prompts.length], [0, 0, 0], tag + ': no DNS question, the browser sent nowhere, the Commander never asked');
          continue;
        }
        A.ok(!r.isError, tag + ': allowed' + (r.isError ? ' (refused: ' + r.content + ')' : ''));
        if (tool === 'browser.navigate') A.eq([rec.navigated, rec.askedAtNavigate], [[new URL(url).href], [isLiteral(url) ? 0 : 1]], tag + ': the browser is sent there after exactly one DNS question for the caller\'s URL');
        else A.eq([rec.prompts, asked.map(q => q[0])], [[host], isLiteral(url) ? [] : [name]], tag + ': the Commander is asked, after one DNS question');
      }
    }
    for (const row of DNS_ROWS) {
      const host = row.host || DNS_HOST, url = 'https://' + host + '/x';
      for (const tool of ['browser.navigate', 'browser.login']) {
        asked.length = 0; answerFor = answerRow(row);
        const rec = browserRig();
        const r = await rec.run(tool, url);
        const tag = tool + ' DNS ' + row.label;
        A.eq(asked.slice(0, 1), row.local ? [] : [[host, { all: true }]], tag + (row.local ? ': answered locally, never asked of DNS' : ': the caller\'s URL asks DNS once'));
        if (row.allow) { A.ok(!r.isError && (tool === 'browser.login' ? rec.prompts.length === 1 : rec.navigated.length === 1), tag + ': allowed'); continue; }
        A.eq([rec.navigated.length, rec.prompts.length], [0, 0], tag + ': the browser is sent nowhere and the Commander never asked');
        if (row.refuse === 'private-answer') {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, true, failed(tool, DNS_TEXT[row.refuse]('browser', row) + '. ' + S.privateAnswerExit(host, row.address, 'browser'))],
            tag + ': the browser\'s words plus its DNS-filter exit, host-authored (the caller\'s own URL: no taint)');
        } else if (row.refuse) {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed(tool, DNS_TEXT[row.refuse]('browser', row))], tag + ': the browser\'s words, never host-authored');
        } else {
          A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed(tool, 'getaddrinfo ' + (row.fails || row.local) + ' ' + host)], tag + ': the resolver\'s own error, never host-authored');
        }
      }
    }
  });

  // ---- C5. browser.navigate: where the page LANDED (the site's choice), every refused row ----
  await section('C5', async () => {
    const START = 'https://start.example.com/page';
    for (const [url, want] of HOST_ROWS) {
      if (want !== 'refuse') continue;
      asked.length = 0; answerFor = () => [PUB4];
      const rec = browserRig(sent => (sent === 'about:blank' ? sent : new URL(url).href));
      const r = await rec.run('browser.navigate', START);
      const tag = 'browser.navigate landing on ' + url;
      A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed('browser.navigate', 'blocked unsafe redirect: ' + NAV_WORDS(hostOfUrl(url)))], tag + ': blocked in the browser\'s words, never host-authored');
      A.eq(rec.navigated, [START, 'about:blank'], tag + ': and the tab is sent away from it');
    }
    for (const row of DNS_ROWS) {
      if (row.allow) continue;
      const host = row.host || DNS_HOST;
      asked.length = 0; answerFor = answerRow(row, { 'start.example.com': [PUB4] });
      const rec = browserRig(sent => (sent === 'about:blank' ? sent : 'https://' + host + '/x'));
      const r = await rec.run('browser.navigate', START);
      const tag = 'browser.navigate landing, DNS ' + row.label;
      const words = row.refuse ? DNS_TEXT[row.refuse]('browser', row) : 'getaddrinfo ' + (row.fails || row.local) + ' ' + host;
      A.eq([r.isError, r.hostAuthored === true, r.content], [true, false, failed('browser.navigate', 'blocked unsafe redirect: ' + words)], tag + ': blocked, never host-authored');
      A.eq(asked.map(q => q[0]), row.local ? ['start.example.com'] : ['start.example.com', host], tag + ': one DNS question for the landing host');
    }
  });

  // ---- C6. desktop links: makeDesktopTools as index.js builds it (the browser's URL rule); the opener is the edge ----
  await section('C6', async () => {
    const { makeDesktopTools } = require('../sidecar/tools/builtin/desktop.js');
    for (const [url, want, , note] of HOST_ROWS) {
      const opened = [];
      const D = makeDesktopTools({ opener: async c => { opened.push(c.target); return 'opened'; } });
      const r = await settle(D._internals.open(url, {}));
      const tag = 'desktop link ' + url + (note ? ' [' + note + ']' : '');
      if (want === 'refuse') {
        const e = r.error;
        A.eq(e && [e.message, e.hostAuthored === true, e.toolSummary], [NAV_WORDS(hostOfUrl(url)), true, 'private address refused'], tag + ': refused in the browser\'s words, host-authored');
        A.eq(opened, [], tag + ': nothing opened');
      } else {
        A.eq(opened, [new URL(url).href], tag + ': opened as written');
      }
    }
  });

  // ---- C7. the owned browser's proxy, with the guards makeCdpDriver gives it (no lookup: this computer's DNS) ----
  await section('C7', async () => {
    const http = require('node:http');
    const { EventEmitter } = require('node:events');
    const { startPinnedProxy } = require('../sidecar/tools/builtin/browser-proxy.js');
    const connectVia = (port, authority) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority, agent: false });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    // the socket edge: record the dial the proxy asks for (and what its pinned lookup answers), then refuse it, so no row
    // ever leaves this process. Only the proxy dials through net.connect here: this test's own client uses http's agent.
    const dials = [];
    const realConnect = net.connect;
    net.connect = function (opts) {
      const o = opts && typeof opts === 'object' ? opts : {};
      const dial = { host: o.host, autoSelectFamily: o.autoSelectFamily === true, all: null };
      if (typeof o.lookup === 'function') o.lookup(o.host, { all: true }, (e, l) => { dial.all = e ? 'error ' + e.code : l.map(a => [a.address, a.family]); });
      dials.push(dial);
      const s = new EventEmitter();
      let gone = false;
      s.destroy = () => { if (!gone) { gone = true; setImmediate(() => s.emit('close')); } return s; };
      s.write = () => true; s.end = () => s; s.pipe = d => d;
      setImmediate(() => s.emit('error', Object.assign(new Error('connect ECONNREFUSED (conformance edge)'), { code: 'ECONNREFUSED' })));
      return s;
    };
    const proxy = await startPinnedProxy(BT._internals.proxyGuards());
    try {
      for (const [url, want, , note] of HOST_ROWS) {
        const u = new URL(url), host = hostOfUrl(url);
        asked.length = 0; dials.length = 0; answerFor = () => [PUB4];
        const mark = proxy.refusalMark();
        const status = await connectVia(proxy.port, u.hostname + ':' + (u.port || '443'));
        const kept = proxy.refusalsSince(mark);
        const tag = 'proxy CONNECT ' + u.hostname + (note ? ' [' + note + ']' : '');
        if (want === 'refuse') {
          A.eq([status, kept.map(k => k.reason), dials.length, asked.length], [403, [NAV_WORDS(host)], 0, 0], tag + ': refused in the browser\'s words, never dialed, no DNS question');
          continue;
        }
        A.eq([status, dials.map(d => d.host)], [502, [isLiteral(url) ? host : PUB4.address]], tag + ': dialed exactly the ' + (isLiteral(url) ? 'literal' : 'one validated address') + ' (the edge refused it)');
        A.eq(asked, isLiteral(url) ? [] : [[u.hostname, { all: true }]], tag + ': ' + (isLiteral(url) ? 'no DNS question' : 'one DNS question'));
      }
      for (const row of DNS_ROWS) {
        const host = row.host || DNS_HOST;
        asked.length = 0; dials.length = 0; answerFor = answerRow(row);
        const mark = proxy.refusalMark();
        const status = await connectVia(proxy.port, host + ':443');
        const kept = proxy.refusalsSince(mark);
        const tag = 'proxy CONNECT, DNS ' + row.label;
        A.eq(asked, row.local ? [] : [[host, { all: true }]], tag + (row.local ? ': answered locally' : ': one DNS question per connection'));
        if (row.allow) {
          const many = row.allow.length > 1;
          A.eq([status, dials], [502, [many ? { host, autoSelectFamily: true, all: row.allow.map(a => [a.address, a.family]) } : { host: row.allow[0].address, autoSelectFamily: false, all: null }]],
            tag + ': the dial reaches only the validated addresses, in order (one address is dialed directly)');
          continue;
        }
        const words = row.refuse ? DNS_TEXT[row.refuse]('browser', row) : 'getaddrinfo ' + (row.fails || row.local) + ' ' + host;
        A.eq([status, dials.length, kept.map(k => [k.host, k.reason])], [403, 0, [[host, words]]], tag + ': refused before any dial, the reason kept for the driver');
        const why = kept.length ? BT._internals.explainRefusal(kept[0]) : {};
        if (row.refuse === 'private-answer') A.eq([why.code, why.text], ['NETWORK_REFUSED', S.privateAnswerExit(host, row.address, 'browser')], tag + ': which the driver names as the DNS-filter exit');
        else if (row.refuse !== 'invalid-answer') A.eq(why.code, 'NAVIGATION_FAILED', tag + ': a lookup that gave nothing usable may pass: the one retry');
      }
    } finally {
      net.connect = realConnect;
      await proxy.close();
    }
  });

  const tick = () => new Promise(r => setImmediate(r));
  // the sentence connector sign-in and the skill downloads append to a private-answer refusal (the station's voice)
  const stationExit = (p, host, address) => '. ' + cap(S.privateAnswerExit(host, address, p));
  // the https and the plain-http form of a HOST_ROW (connector OAuth and the skill sources are https-only)
  const asScheme = (url, scheme) => url.replace(/^https?:/, scheme);

  // ---- C8. connector OAuth's literal check (mcp/oauth.js), made wherever an endpoint is named (discovery, client
  //      registration, the token endpoint, the authorization URL): the https form of every HOST_ROW through getJson ----
  await section('C8', async () => {
    const O = require('../sidecar/mcp/oauth.js');
    for (const [url, want, , note] of HOST_ROWS) {
      const target = asScheme(url, 'https:'), host = hostOfUrl(target);
      const fetched = [];
      const fetchImpl = async u => { fetched.push(String(u)); return { status: 200, json: async () => ({ ok: true }) }; };
      const r = await settle(O._internals.getJson(fetchImpl, target, 'protected-resource metadata', {}));
      const tag = 'connector literal check ' + target + (note ? ' [' + note + ']' : '');
      if (want === 'refuse') A.eq([r.error && r.error.message, fetched.length], ['protected-resource metadata: refusing an endpoint on an internal host (' + host + ')', 0], tag + ': refused in its own words, nothing fetched');
      else A.eq([r.error ? r.error.message : 'fetched', fetched], ['fetched', [target]], tag + ': allowed, fetched as written');
    }
    // https comes first, as it always did: a plain-http endpoint is refused for that, whatever its host
    for (const url of ['http://example.com/.well-known/oauth-protected-resource', 'http://127.0.0.1/x']) {
      const r = await settle(O._internals.getJson(async () => { throw new Error('must not fetch'); }, url, 'token endpoint', {}));
      A.eq(r.error && r.error.message, 'token endpoint: url must be https (' + url + ')', 'connector literal check ' + url + ': refused as plain http first');
    }
  });

  // ---- C9. connector OAuth's fetch as index.js builds it, makeConnectorOauthFetch({ onCloseError }): every leg's URL
  //      (a remote server chose it), every HOST_ROW in both schemes and every DNS_ROW, then publicDestination (a custom
  //      server's authorization endpoint). globalThis.fetch is swapped the way the preload rigs swap it ----
  await section('C9', async () => {
    const { makeConnectorOauthFetch } = require('../sidecar/mcp/oauth-fetch.js');
    const realFetch = globalThis.fetch;
    const rec = { fetched: [], agents: [], closeErrors: [] };
    const reset = () => { asked.length = 0; rec.fetched.length = 0; rec.agents.length = 0; };
    globalThis.fetch = async (url, init) => { rec.fetched.push({ url: String(url), init: init || {} }); return { status: 200, ok: true }; };
    const agentFactory = o => { const a = { o, closed: 0, close: async () => { a.closed++; } }; rec.agents.push(a); return a; };
    try {
      const C = makeConnectorOauthFetch({ onCloseError: e => rec.closeErrors.push(e), agentFactory });
      for (const [url, want, , note] of HOST_ROWS) {
        for (const scheme of ['https:', 'http:']) {
          const target = asScheme(url, scheme), host = hostOfUrl(target), name = new URL(target).hostname;
          reset(); answerFor = () => [PUB4];
          const r = await settle(C.connectorOauthFetch(target, { method: 'POST', redirect: 'follow' }));
          await tick();
          const tag = 'connector OAuth ' + target + (note ? ' [' + note + ']' : '');
          if (want === 'refuse') {
            A.eq(r.error && [r.error.message, r.error.hostAuthored === true, r.error.egress && r.error.egress.reason], ['refusing to fetch private/loopback/intranet host: ' + host, false, 'not-public'],
              tag + ': refused in the connector\'s words, never host-authored (a remote server named it)');
            A.eq([asked.length, rec.fetched.length, rec.agents.length], [0, 0, 0], tag + ': no DNS question, no fetch, no dispatcher');
            continue;
          }
          if (scheme === 'http:') {
            A.eq([r.error && r.error.message, asked.length, rec.fetched.length], [HTTPS_TEXT.connectorOauth, 0, 0], tag + ': a public host over plain http is refused for that, before any DNS question');
            continue;
          }
          A.ok(r.value && r.value.status === 200, tag + ': allowed' + (r.error ? ' (refused: ' + r.error.message + ')' : ''));
          const f = rec.fetched[0] || { init: {} };
          A.eq([rec.fetched.length, f.url, f.init.redirect, f.init.method], [1, new URL(target).href, 'manual', 'POST'], tag + ': one fetch, of the URL as written, redirects manual');
          if (isLiteral(target)) {
            A.eq([asked.length, rec.agents.length, f.init.dispatcher || null], [0, 0, null], tag + ': an IP literal needs no DNS and no pin');
            continue;
          }
          A.eq(asked, [[name, { all: true }]], tag + ': ONE DNS question, for the URL\'s own name');
          A.ok(rec.agents.length === 1 && f.init.dispatcher === rec.agents[0], tag + ': the fetch dials through the leg\'s pinned dispatcher');
          if (rec.agents[0]) A.eq([pinOf(rec.agents[0], name), rec.agents[0].closed], [{ all: [[PUB4.address, 4]], one: [PUB4.address, 4] }, 1], tag + ': which answers only the validated address, and is closed');
        }
      }
      for (const row of DNS_ROWS) {
        const host = row.host || DNS_HOST, url = 'https://' + host + '/x';
        reset(); answerFor = answerRow(row);
        const r = await settle(C.connectorOauthFetch(url));
        await tick();
        const tag = 'connector OAuth DNS ' + row.label;
        A.eq(asked, row.local ? [] : [[host, { all: true }]], tag + (row.local ? ': answered locally, never asked of DNS' : ': exactly one DNS question'));
        if (row.allow) {
          A.ok(r.value && rec.fetched.length === 1 && rec.agents.length === 1 && rec.fetched[0].init.dispatcher === rec.agents[0], tag + ': allowed, dialed through one pinned dispatcher');
          if (rec.agents[0]) A.eq([pinOf(rec.agents[0], host), rec.agents[0].closed], [{ all: row.allow.map(a => [a.address, a.family]), one: [row.allow[0].address, row.allow[0].family] }, 1],
            tag + ': the dial gets EVERY validated address, in order (the first for a single answer), and its dispatcher is closed');
          continue;
        }
        A.eq([rec.fetched.length, rec.agents.length], [0, 0], tag + ': nothing fetched, nothing dialed');
        const e = r.error;
        if (row.refuse === 'private-answer') A.eq(e && [e.message, e.hostAuthored === true], [DNS_TEXT[row.refuse]('connectorOauth', row) + stationExit('connectorOauth', host, row.address), false], tag + ': the connector\'s words plus the DNS-filter exit, never host-authored');
        else if (row.refuse) A.eq(e && [e.message, e.hostAuthored === true], [DNS_TEXT[row.refuse]('connectorOauth', row), false], tag + ': the connector\'s words, never host-authored');
        else A.eq(e && [e.message, e.code, e.hostAuthored === true], ['getaddrinfo ' + (row.fails || row.local) + ' ' + host, row.fails || row.local, false], tag + ': the resolver\'s own error, its code kept (it may pass)');
      }
      // a rebinding resolver: [IPv6, IPv4] for a leg's one question, loopback for the next: each leg asks once, dials its own answer
      {
        reset();
        let n = 0;
        answerFor = () => (++n === 1 ? [PUB6, PUB4] : [{ address: '127.0.0.1', family: 4 }]);
        const first = await settle(C.connectorOauthFetch('https://' + DNS_HOST + '/register', { method: 'POST' }));
        const second = await settle(C.connectorOauthFetch('https://' + DNS_HOST + '/token', { method: 'POST' }));
        await tick();
        A.ok(first.value && rec.agents.length === 1 && rec.agents[0].closed === 1, 'connector OAuth rebinding: the first leg dials its one answer, and closes');
        A.eq(rec.agents[0] && pinOf(rec.agents[0], DNS_HOST).all, [[PUB6.address, 6], [PUB4.address, 4]], 'connector OAuth rebinding: that answer, every address of it');
        A.eq([n, rec.fetched.length], [2, 1], 'connector OAuth rebinding: one DNS question per leg; the second leg\'s loopback answer is never fetched');
        A.ok(second.error && second.error.message.startsWith('refusing: ' + DNS_HOST + ' resolves to private address 127.0.0.1. '), 'connector OAuth rebinding: it is refused, with the DNS-filter exit');
      }
      // publicDestination: a custom server's authorization endpoint (the Commander's browser opens it; nothing is fetched)
      for (const [url, want, , note] of HOST_ROWS) {
        const target = asScheme(url, 'https:');
        reset(); answerFor = () => [PUB4];
        const r = await settle(C.publicDestination(target));
        const tag = 'connector publicDestination ' + target + (note ? ' [' + note + ']' : '');
        if (want === 'refuse') A.eq([r.error && r.error.message, asked.length], ['refusing to fetch private/loopback/intranet host: ' + hostOfUrl(target), 0], tag + ': refused in the connector\'s words');
        else A.eq([r.error ? r.error.message : 'ok', r.value && Object.isFrozen(r.value), r.value && r.value.href, r.value && r.value.policy, asked.length, rec.fetched.length, rec.agents.length],
          ['ok', true, new URL(target).href, 'connectorOauth', isLiteral(target) ? 0 : 1, 0, 0], tag + ': a frozen connectorOauth Destination, one DNS question for a name, nothing fetched or dialed');
      }
      for (const row of DNS_ROWS.filter(x => x.refuse === 'private-answer')) {
        reset(); answerFor = answerRow(row);
        const r = await settle(C.publicDestination('https://' + DNS_HOST + '/authorize'));
        A.eq(r.error && r.error.message, DNS_TEXT[row.refuse]('connectorOauth', row) + stationExit('connectorOauth', DNS_HOST, row.address), 'connector publicDestination DNS ' + row.label + ': refused with the DNS-filter exit');
      }
      A.eq(rec.closeErrors, [], 'connector OAuth: no dispatcher close failed');
    } finally { globalThis.fetch = realFetch; }
  });

  // the skill document fetch as index.js builds it, makeSkillDocumentFetcher({ fetchImpl }) (Skill Exchange, the Skill
  // Market catalog, community maps, imports); the fetch and the dispatcher factory are recorded at the edge
  const SF = require('../sidecar/skills/exchange-fetch.js');
  const skillAnswer = (rec, status, text, loc) => ({ status, ok: status >= 200 && status < 300,
    headers: { get: k => (String(k).toLowerCase() === 'location' ? (loc || null) : null) },
    body: { cancel: async () => { rec.cancelled++; }, async *[Symbol.asyncIterator]() { yield Buffer.from(String(text || '')); } } });
  function skillRig(answer) {
    const rec = { fetched: [], agents: [], cancelled: 0 };
    rec.fetchDocument = SF.makeSkillDocumentFetcher({
      fetchImpl: async (url, init) => { rec.fetched.push({ url: String(url), dispatcher: (init && init.dispatcher) || null }); return answer ? answer(rec, String(url)) : skillAnswer(rec, 200, 'consumer row ok'); },
      agentFactory: o => { const a = { o, closed: 0, close: async () => { a.closed++; } }; rec.agents.push(a); return a; }
    });
    return rec;
  }

  // ---- C10. the skill document fetch: a document's own URL (every HOST_ROW in both schemes, every DNS_ROW), its
  //      redirect hops, and a package's ONE session per host ----
  await section('C10', async () => {
    for (const [url, want, , note] of HOST_ROWS) {
      for (const scheme of ['https:', 'http:']) {
        const target = asScheme(url, scheme), host = hostOfUrl(target), name = new URL(target).hostname;
        asked.length = 0; answerFor = () => [PUB4];
        const rec = skillRig();
        const r = await settle(rec.fetchDocument(target));
        const tag = 'skill fetch ' + target + (note ? ' [' + note + ']' : '');
        if (want === 'refuse') {
          A.eq(r.error && [r.error.message, r.error.hostAuthored === true], ['refusing to fetch private/loopback/intranet host: ' + host, false], tag + ': refused in the skill source\'s words, never host-authored');
          A.eq([asked.length, rec.fetched.length, rec.agents.length], [0, 0, 0], tag + ': no DNS question, no fetch, no dispatcher');
          continue;
        }
        if (scheme === 'http:') {
          A.eq([r.error && r.error.message, asked.length, rec.fetched.length], [HTTPS_TEXT.skillSource, 0, 0], tag + ': a public host over plain http is refused for that, before any DNS question');
          continue;
        }
        A.eq([r.error ? r.error.message : 'ok', r.value && r.value.text, rec.fetched.map(f => f.url)], ['ok', 'consumer row ok', [new URL(target).href]], tag + ': allowed, one fetch of the URL as written');
        if (isLiteral(target)) {
          A.eq([asked.length, rec.agents.length, rec.fetched[0] && rec.fetched[0].dispatcher], [0, 0, null], tag + ': an IP literal needs no DNS and no pin');
          continue;
        }
        A.eq(asked, [[name, { all: true }]], tag + ': ONE DNS question, for the URL\'s own name');
        A.ok(rec.agents.length === 1 && rec.fetched[0].dispatcher === rec.agents[0], tag + ': the fetch dials through the hop\'s pinned dispatcher (it handed none before)');
        if (rec.agents[0]) A.eq([pinOf(rec.agents[0], name), rec.agents[0].closed], [{ all: [[PUB4.address, 4]], one: [PUB4.address, 4] }, 1], tag + ': which answers only the validated address, and is closed after the body');
      }
    }
    for (const row of DNS_ROWS) {
      const host = row.host || DNS_HOST, url = 'https://' + host + '/SKILL.md';
      asked.length = 0; answerFor = answerRow(row);
      const rec = skillRig();
      const r = await settle(rec.fetchDocument(url));
      const tag = 'skill fetch DNS ' + row.label;
      A.eq(asked, row.local ? [] : [[host, { all: true }]], tag + (row.local ? ': answered locally, never asked of DNS' : ': exactly one DNS question'));
      if (row.allow) {
        A.ok(r.value && rec.fetched.length === 1 && rec.agents.length === 1 && rec.fetched[0].dispatcher === rec.agents[0], tag + ': allowed, dialed through one pinned dispatcher');
        if (rec.agents[0]) A.eq([pinOf(rec.agents[0], host), rec.agents[0].closed], [{ all: row.allow.map(a => [a.address, a.family]), one: [row.allow[0].address, row.allow[0].family] }, 1],
          tag + ': the dial gets every validated address, in order, and its dispatcher is closed');
        continue;
      }
      A.eq([rec.fetched.length, rec.agents.length], [0, 0], tag + ': nothing fetched, nothing dialed');
      const e = r.error;
      if (row.refuse === 'private-answer') A.eq(e && [e.message, e.hostAuthored === true], [DNS_TEXT[row.refuse]('skillSource', row) + stationExit('skillSource', host, row.address), false], tag + ': the skill source\'s words plus the DNS-filter exit');
      else if (row.refuse) A.eq(e && [e.message, e.hostAuthored === true], [DNS_TEXT[row.refuse]('skillSource', row), false], tag + ': the skill source\'s words');
      else A.eq(e && [e.message, e.code], ['getaddrinfo ' + (row.fails || row.local) + ' ' + host, row.fails || row.local], tag + ': the resolver\'s own error, its code kept (it may pass)');
    }
    // redirect hops (the source chose them): validated as their own destination, one DNS question each, bodies discarded
    const START = 'https://start.example.com/SKILL.md';
    const bounceTo = loc => (rec, url) => (url.indexOf('://start.example.com/') > 0 ? skillAnswer(rec, 302, 'moved', loc) : skillAnswer(rec, 200, 'landed'));
    for (const [url, want] of HOST_ROWS) {
      if (want !== 'refuse') continue;
      const target = asScheme(url, 'https:');
      asked.length = 0; answerFor = () => [PUB4];
      const rec = skillRig(bounceTo(target));
      const r = await settle(rec.fetchDocument(START));
      const tag = 'skill fetch redirect to ' + target;
      A.eq(r.error && [r.error.message, r.error.hostAuthored === true, r.error.egress && r.error.egress.origin], ['refusing to fetch private/loopback/intranet host: ' + hostOfUrl(target), false, 'redirect'], tag + ': refused in the same words, as a redirect hop');
      A.eq([asked.map(q => q[0]), rec.fetched.length, rec.cancelled, rec.agents.map(a => a.closed)], [['start.example.com'], 1, 1, [1]],
        tag + ': the refused hop is neither asked of DNS nor fetched; the redirect\'s body was cancelled and the first hop\'s dispatcher closed');
    }
    for (const row of DNS_ROWS) {
      if (row.allow) continue;
      const host = row.host || DNS_HOST;
      asked.length = 0; answerFor = answerRow(row, { 'start.example.com': [PUB4] });
      const rec = skillRig(bounceTo('https://' + host + '/x'));
      const r = await settle(rec.fetchDocument(START));
      const tag = 'skill fetch redirect hop, DNS ' + row.label;
      A.eq([asked.map(q => q[0]), rec.fetched.length], [row.local ? ['start.example.com'] : ['start.example.com', host], 1], tag + ': one DNS question per hop, and only the first hop fetched');
      const want = row.refuse === 'private-answer' ? DNS_TEXT[row.refuse]('skillSource', row) + stationExit('skillSource', host, row.address)
        : row.refuse ? DNS_TEXT[row.refuse]('skillSource', row) : 'getaddrinfo ' + (row.fails || row.local) + ' ' + host;
      A.eq(r.error && [r.error.message, r.error.hostAuthored === true], [want, false], tag + ': refused in the skill source\'s words');
    }
    {
      let probe = 0;
      asked.length = 0;
      answerFor = name => (name === 'start.example.com' ? [PUB4] : (++probe === 1 ? [PUB6, PUB4] : [{ address: '127.0.0.1', family: 4 }]));
      const rec = skillRig(bounceTo('https://' + DNS_HOST + '/x'));
      const r = await settle(rec.fetchDocument(START));
      A.eq([r.value && r.value.text, probe, asked.map(q => q[0])], ['landed', 1, ['start.example.com', DNS_HOST]], 'skill fetch rebinding redirect hop: followed on its one validated answer; the later (loopback) answer was never asked for');
      A.eq(rec.agents.map((a, i) => [pinOf(a, i ? DNS_HOST : 'start.example.com').all, a.closed]), [[[[PUB4.address, 4]], 1], [[[PUB6.address, 6], [PUB4.address, 4]], 1]], 'skill fetch rebinding redirect hop: each hop dials exactly its validated addresses, and closes');
    }
    // an error status: its body is discarded too, and the hop's dispatcher closed
    {
      asked.length = 0; answerFor = () => [PUB4];
      const rec = skillRig((r2, url) => skillAnswer(r2, 404, 'not here'));
      const r = await settle(rec.fetchDocument('https://gone.example.com/SKILL.md'));
      A.eq([r.error && r.error.message, rec.cancelled, rec.agents.map(a => a.closed)], ['skill source returned HTTP 404', 1, [1]], 'skill fetch HTTP 404: refused as before, its body cancelled, its dispatcher closed');
    }
    // a package: ONE DNS question and ONE keep-alive pinned dispatcher per host for the whole package, closed at its end
    {
      const FILES = { '/demo/SKILL.md': '---\nname: demo\n---\nRead references/guide.md then run scripts/check.js.', '/demo/references/guide.md': 'See assets/pixel.txt.',
        '/demo/scripts/check.js': 'console.log(1)', '/demo/assets/pixel.txt': 'px' };
      asked.length = 0; answerFor = () => [PUB6, PUB4];
      const rec = skillRig((r2, url) => { const p = new URL(url).pathname; return FILES[p] != null ? skillAnswer(r2, 200, FILES[p]) : skillAnswer(r2, 404, 'missing'); });
      const got = await settle(SF.makeSkillPackageFetcher({ fetchDocument: rec.fetchDocument, now: () => 0 })('https://pkg.example.com/demo/SKILL.md'));
      A.eq(got.value && got.value.files.map(f => f.path).sort(), ['SKILL.md', 'assets/pixel.txt', 'references/guide.md', 'scripts/check.js'], 'skill package: every declared file arrives' + (got.error ? ' (' + got.error.message + ')' : ''));
      A.eq(asked, [['pkg.example.com', { all: true }]], 'skill package: ONE DNS question for its host, for the whole package');
      A.ok(rec.agents.length === 1 && rec.fetched.length === 4 && rec.fetched.every(f => f.dispatcher === rec.agents[0]), 'skill package: every file dialed through the one keep-alive pinned dispatcher of its host');
      A.eq(rec.agents[0] && [pinOf(rec.agents[0], 'pkg.example.com').all, rec.agents[0].closed], [[[PUB6.address, 6], [PUB4.address, 4]], 1], 'skill package: which answers every validated address, and is closed once, at the end');
      // a GitHub package: the listing host and the download host each get one question and one dispatcher
      const listing = JSON.stringify([
        { type: 'file', path: 'skills/demo/SKILL.md', download_url: 'https://raw.githubusercontent.com/o/r/main/skills/demo/SKILL.md' },
        { type: 'file', path: 'skills/demo/references/a.md', download_url: 'https://raw.githubusercontent.com/o/r/main/skills/demo/references/a.md' }
      ]);
      asked.length = 0; answerFor = name => (name === 'api.github.com' ? [{ address: '140.82.112.6', family: 4 }] : [PUB4]);
      const gh = skillRig((r2, url) => (new URL(url).hostname === 'api.github.com' ? skillAnswer(r2, 200, listing) : skillAnswer(r2, 200, '# doc')));
      const out = await settle(SF.makeSkillPackageFetcher({ fetchDocument: gh.fetchDocument, now: () => 0 })('https://raw.githubusercontent.com/o/r/main/skills/demo/SKILL.md'));
      A.eq(out.value && out.value.files.map(f => f.path), ['SKILL.md', 'references/a.md'], 'GitHub package: its files arrive' + (out.error ? ' (' + out.error.message + ')' : ''));
      A.eq([asked.map(q => q[0]), gh.agents.length, gh.agents.map(a => a.closed)], [['api.github.com', 'raw.githubusercontent.com'], 2, [1, 1]], 'GitHub package: one DNS question and one dispatcher per host, each closed at the end');
      // a package that fails partway still closes its session
      asked.length = 0; answerFor = () => [PUB4];
      const bad = skillRig((r2, url) => (/SKILL\.md$/.test(url) ? skillAnswer(r2, 200, 'Read references/missing.md.') : skillAnswer(r2, 404, 'missing')));
      const failed = await settle(SF.makeSkillPackageFetcher({ fetchDocument: bad.fetchDocument, now: () => 0 })('https://pkg.example.com/x/SKILL.md'));
      A.ok(failed.error && /HTTP 404/.test(failed.error.message) && bad.agents.length === 1 && bad.agents[0].closed === 1, 'skill package: a failed package still closes its one dispatcher');
    }
  });
  dns.promises.lookup = realDnsLookup;

  /* =============================================== CENSUS =============================================== */
  // ---- C11. ONE CLASSIFIER. No sidecar file but the boundary holds a private-range or intranet-name table, answers a
  //      connect-time lookup, or asks DNS for a destination itself: each of those copies drifted from the others
  //      before the module (the browser allowed metadata.goog, connector OAuth refused every IPv6 literal, three
  //      hand-rolled pins disagreed on Node's { all: true }). Code only: comments are blanked by a small lexer that
  //      keeps strings and regex literals (the tables were written in both). Not counted, on purpose: a path segment
  //      such as '.local' in path.join, the cleartext rule of mcp/transport.http.js (whether the Commander's OWN
  //      connector URL is loopback, so a token may travel over http) and peerowner.js (who is calling the station). ----
  {
    const { sidecarSourceFiles, functionSourceIn } = require('./helpers/source.js');
    const BOUNDARY = 'sidecar/net/safe-egress.js';
    // the one documented exception: it words a refusal, it refuses nothing
    const EXCEPTIONS = [{ rel: 'sidecar/providers/errorClass.js', fn: 'hostScope',
      why: 'words a provider\'s ECONNREFUSED message (this computer, this network or elsewhere); it is not a trust boundary, and errorClass is a UMD module the frontend loads too' }];
    const CENSUS = [
      ['an IPv6 range test', /fe\[89ab\]|f\[cd\]\[|\bfe80:|\bf[cd]00:/i],
      ['a private IPv4 octet test', /===\s*169\s*&&\s*\w+\s*===\s*254|===\s*172\s*&&\s*\w+\s*>=\s*16|===\s*192\s*&&\s*\w+\s*===\s*168|===\s*100\s*&&\s*\w+\s*>=\s*64|(?:169|192|100|172)\\\.(?:254|168|\(\?:)|startsWith\(\s*['"](?:10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./],
      ['an intranet-name test', /endsWith\(\s*['"]\.(?:local|internal|lan|intranet|home|corp|home\.arpa|metadata\.goog)['"]\s*\)|===\s*['"]metadata\.goog['"]|\\\.\(\?:(?:local|lan|internal|intranet|home|corp)\b/],
      ['a hand-rolled connect-time lookup branch', /\b([A-Za-z_$][\w$]*)\s*&&\s*\1\.all\b/],
      ['a hand-rolled connect-time lookup', /\blookup\s*(?::\s*(?:async\s+)?(?:function\b\s*)?)?\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*(?:=>|\{)/],
      ['a connect option carrying its own lookup', /\bconnect\s*:\s*\{[^{}]{0,200}\blookup\b/],
      ['a DNS question asked outside the boundary', /\b(?:dns|dnsPromises)\s*\.\s*(?:promises\s*\.\s*)?lookup\s*\(|\bpromises\s*\.\s*lookup\s*\(|require\(\s*['"](?:node:)?dns['"]\s*\)/]
    ];
    // a `/` opens a regex literal (not a division) after an operator, an opening bracket or one of these keywords
    const regexCanStart = out => {
      let k = out.length - 1;
      while (k >= 0 && /\s/.test(out[k])) k--;
      if (k < 0 || '(,=:[!&|?{};+-*%<>~^'.indexOf(out[k]) >= 0) return true;
      const w = /[A-Za-z_$]+$/.exec(out.slice(Math.max(0, k - 9), k + 1));
      return !!w && /^(?:return|typeof|case|of|in|void|throw|delete|new|else|do|yield|await)$/.test(w[0]);
    };
    // comments blanked (newlines kept); strings, template literals and regex literals kept whole
    const codeOnly = src => {
      let out = '', i = 0;
      const n = src.length;
      while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? n : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
        if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
        if (c === '/' && regexCanStart(out)) {
          let j = i + 1, cls = false;
          while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
          j++;
          while (j < n && /[a-z]/i.test(src[j])) j++;
          out += src.slice(i, j); i = j; continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
          let j = i + 1;
          while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
          out += src.slice(i, j + 1); i = j + 1; continue;
        }
        out += c; i++;
      }
      return out;
    };
    const hits = code => CENSUS.filter(([, re]) => re.test(code)).map(([what]) => what);
    // the census proves itself first: every row finds the copy it was written from (verbatim from the files that held
    // them), and nothing benign trips it
    const COPIES = [
      ['an IPv6 range test', 'return h === \'::1\' || h === \'::\' || /^::ffff:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);'],
      ['a private IPv4 octet test', 'return a === 0 || a === 127 || a === 10 ||\n      (a === 192 && b === 168) || (a === 169 && b === 254) ||'],
      ['a private IPv4 octet test', 'if (/^10\\./.test(h) || /^192\\.168\\./.test(h) || /^169\\.254\\./.test(h)) return \'private\';'],
      ['an intranet-name test', 'h.endsWith(\'.localhost\') || h.endsWith(\'.local\') || h.endsWith(\'.internal\') ||'],
      ['an intranet-name test', '|| /\\.(?:local|lan|internal|home|home\\.arpa)$/.test(h)'],
      ['a hand-rolled connect-time lookup branch', 'if (options && options.all) callback(null, pinned.map(a => Object.assign({}, a)));'],
      ['a hand-rolled connect-time lookup', 'lookup: (_name, opts, cb) => (opts && opts.all) ? cb(null, pinned) : cb(null, pinned[0].address, pinned[0].family) };'],
      ['a connect option carrying its own lookup', 'const dispatcher = pinned ? makePinnedAgent({ connect: {\n        lookup(hostname, options, callback) {'],
      ['a DNS question asked outside the boundary', 'lookup: host => dns.promises.lookup(host, { all: true }),'],
      ['a DNS question asked outside the boundary', 'function nodeLookup(host) { const dns = require(\'node:dns\'); return dns.promises.lookup(host, { all: true }); }']
    ];
    for (const [what, snippet] of COPIES) A.ok(hits(codeOnly(snippet)).indexOf(what) >= 0, 'census self-test: "' + what + '" finds ' + JSON.stringify(snippet.slice(0, 70)));
    const BENIGN = [
      'const dir = path.posix.join(o.home, \'.local\', \'bin\');',
      'const pair = (c & 0xfc00) === 0xdc00 && i >= 2;',
      '// a 302 -> http://169.254.169.254/ cloud-metadata endpoint, fe80::1, h.endsWith(\'.internal\'), opts && opts.all',
      '/* lookup(hostname, options, callback) answers the validated list; dns.promises.lookup is asked once */',
      'const u = \'https://example.com//x\'; const re = /\\/\\//; if (row.internal) return true;',
      'const all = opts && opts.allow; lookupDeps(a, b, c);',
      'if (n === 0 && m === 0) return; if (a === 192 && b === 0) x();'
    ];
    for (const snippet of BENIGN) A.eq(hits(codeOnly(snippet)), [], 'census self-test: benign code is not counted: ' + JSON.stringify(snippet.slice(0, 70)));

    const files = sidecarSourceFiles();
    A.ok(files.length > 100 && files.some(f => f.rel === BOUNDARY) && files[0].rel === 'sidecar/index.js', 'the census reads every sidecar file through test/helpers/source.js (' + files.length + ')');
    A.ok(hits(codeOnly(files.find(f => f.rel === BOUNDARY).text)).length > 0, 'and the boundary itself is where the table and the pinned lookup live');
    const found = [];
    for (const f of files) {
      if (f.rel === BOUNDARY) continue;
      let code = codeOnly(f.text);
      for (const x of EXCEPTIONS.filter(e => e.rel === f.rel)) {
        const body = functionSourceIn(code, x.fn);
        A.ok(body && hits(body).length > 0, 'the documented exception ' + x.rel + ' ' + x.fn + ' still exists and still needs its exception (' + x.why + ')');
        if (body) code = code.replace(body, '');
      }
      for (const what of hits(code)) found.push(f.rel + ': ' + what);
    }
    A.eq(found, [], 'ONE CLASSIFIER: no sidecar file but ' + BOUNDARY + ' holds a range or name table, answers a connect-time lookup or asks DNS itself');
  }

  A.report('safe-egress.conformance.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
