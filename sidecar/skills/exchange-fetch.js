/* Bounded public-HTTPS fetcher for Skill Exchange, the Skill Market catalog, community maps and imports.

   It owns its outbound guard: the boundary's skillSource row (sidecar/net/safe-egress.js: a public host, https, no
   embedded credentials), ONE DNS question per hop with every answer validated, and a dispatcher whose socket can reach
   only the addresses that answer validated. Every redirect hop is validated the same way. Until the safe-egress lane
   (2026-11-03) the guard was web.js's, borrowed through index.js, and the fetch carried no dispatcher, so its connect
   resolved the name a second time through the OS: the address validated was not the address dialed, and a
   DNS-rebinding source could answer the check publicly and the connect with a private address. The transport edge
   (fetchImpl, lookup, agentFactory) is injected, so security cases need no network. */
'use strict';

const egress = require('../net/safe-egress.js');
const { note: failNote } = require('../failopen.js');

const MAX_REDIRECTS = 4;
const MAX_BYTES = 256000;
const packageFormat = require('./package-format.js');
const MAX_PACKAGE_FILES = packageFormat.DEFAULT_MAX_FILES;
const MAX_PACKAGE_BYTES = packageFormat.DEFAULT_MAX_PACKAGE_BYTES;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_REQUESTS = MAX_PACKAGE_FILES * 2;
const MAX_FETCHED_BYTES = MAX_PACKAGE_BYTES * 2; // package bytes plus bounded GitHub directory listings
const PACKAGE_DEADLINE_MS = 30000;
const BODY_DEADLINE_MS = 60000;   // a read with no budget of its own: headers + body, whole

// A body this fetcher will not read (a redirect, an error status) is cancelled: its connection is free for the next
// request, and a pinned Agent's graceful close never waits on it.
async function discard(response) {
  const body = response && response.body;
  if (!body) return;
  try {
    if (typeof body.cancel === 'function') await body.cancel();
    else if (typeof body.destroy === 'function') body.destroy();
  } catch (e) { failNote('skills.fetch.discard-body', e); }
}

function makeSkillDocumentFetcher(deps) {
  deps = deps || {};
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  // the transport edge, for tests. lookup absent: this computer's DNS, read at call time; null: no DNS and no pin
  // (tests only). agentFactory absent: an undici Agent.
  const lookup = deps.lookup;
  if (lookup !== undefined && lookup !== null && typeof lookup !== 'function') {
    throw new TypeError('makeSkillDocumentFetcher: lookup is a function, null (no DNS, tests only) or absent (this computer\'s DNS)');
  }
  const agentFactory = typeof deps.agentFactory === 'function' ? deps.agentFactory : undefined;
  const onCloseError = typeof deps.onCloseError === 'function' ? deps.onCloseError : undefined;
  const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : 12000;
  const bodyDeadlineMs = deps.bodyDeadlineMs > 0 ? deps.bodyDeadlineMs : BODY_DEADLINE_MS;

  // a hop's destination: the skillSource row and ONE DNS answer (the package session's answer for its host, when the
  // hop belongs to a package). A private answer says which setting on this computer gave it.
  async function checked(raw, origin, sess) {
    try { return sess ? await sess.resolve(raw, { origin }) : await egress.resolveValidated(raw, { policy: 'skillSource', lookup, origin }); }
    catch (e) { throw egress.withAnswerExit(e, 'skillSource'); }
  }
  // dial a hop: through the package session's keep-alive Agent for its host, or a pinned Agent of the hop's own, closed
  // once fn is done with the response (its body read or discarded)
  function dialed(dest, sess, fn) {
    if (sess) return fn(sess.dispatcher(dest));
    return egress.withPinned(dest, { agentFactory, onCloseError }, fn);
  }
  // limit/label: a caller fetching something other than a SKILL.md (the Skill Market's catalog index) passes its own
  // cap and name, so an oversized document is refused under its real name instead of being called a SKILL.md
  // onChunk: called as each chunk arrives (the body's silence timer re-arms on it)
  async function bodyBytes(response, limit, label, onChunk) {
    const tooBig = () => new Error(label ? label + ' is larger than ' + Math.round(limit / 1000) + ' KB' : 'SKILL.md is larger than 256 KB');
    const declared = Number(response && response.headers && response.headers.get('content-length')) || 0;
    if (declared > limit) throw tooBig();
    if (response.body && response.body[Symbol.asyncIterator]) {
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        if (onChunk) onChunk();
        const buf = Buffer.from(chunk); total += buf.length;
        if (total > limit) throw tooBig();
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    }
    const bytes = response.arrayBuffer ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text(), 'utf8');
    if (bytes.length > limit) throw (label ? tooBig() : new Error('skill package file is larger than 256 KB'));
    return bytes;
  }
  async function run(raw, requestOpts, sess) {
    if (typeof fetchImpl !== 'function') throw new Error('network fetch is unavailable');
    requestOpts = requestOpts || {};
    const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, Number(requestOpts.timeoutMs) || timeoutMs));
    /* A BODY IS BOUNDED BY SILENCE, NOT BY THE REQUEST TIMER (2026-10-21). The timer used to stop once headers arrived,
       so a body that stalled held the fetch open forever; ending the body at the request timer instead failed a large
       download that was merely slow and steady (a 4 MB community map picture under ~330 KB/s). So the timer is an
       inactivity timer: headers, then every body chunk, re-arm it, and requestTimeoutMs of silence ends the read. A
       caller with a budget of its own (the package fetcher passes what is left of its 30 s) also caps the whole read
       at it; a caller without one (community maps, the market catalog, an import) gets BODY_DEADLINE_MS (review
       2026-10-21: a source trickling a byte before each silence window ran out held its socket open for as long as it
       liked, and a caller's own race, like community maps' 45 s, gave up without ever closing it). 60 s still carries
       a full 4 MB at ~67 KB/s.
       ONE DEADLINE ACROSS EVERY HOP (polish 2026-10-21): the cap was re-armed per redirect hop, so a source bouncing
       the read through MAX_REDIRECTS slow redirects held it for up to MAX_REDIRECTS + 1 times that deadline. It is
       armed once, here, and ends whichever hop is in flight. */
    const capMs = Number(requestOpts.timeoutMs) > 0 ? Number(requestOpts.timeoutMs) : bodyDeadlineMs;
    let current = null, expired = false;
    const cap = setTimeout(() => { expired = true; if (current) current.abort(); }, capMs);
    try {
      let dest = await checked(raw, 'caller', sess);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (expired) throw new Error('skill source timed out');
        const ctrl = new AbortController();
        current = ctrl;
        let idle = null;
        const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), requestTimeoutMs); };
        arm();
        try {
          // the hop's socket reaches only the addresses its one DNS answer validated; the URL keeps the name for SNI
          const step = await dialed(dest, sess, async dispatcher => {
            let response;
            try {
              const init = {
                method: 'GET', redirect: 'manual', signal: ctrl.signal,
                headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1', 'user-agent': 'StarNet-Skill-Exchange/1' }
              };
              if (dispatcher) init.dispatcher = dispatcher;
              response = await fetchImpl(dest.href, init);
            } catch (e) {
              if (ctrl.signal.aborted) throw new Error('skill source timed out');
              throw e;
            }
            if (response.status >= 300 && response.status < 400) {
              const location = response.headers && response.headers.get('location');
              await discard(response);
              if (!location) throw new Error('skill source redirected without a location');
              if (hop === MAX_REDIRECTS) throw new Error('skill source redirected too many times');
              return { next: new URL(location, dest.href).href };
            }
            if (!response.ok) {
              await discard(response);
              throw new Error('skill source returned HTTP ' + response.status);
            }
            const limit = Number(requestOpts.maxBytes) > 0 ? Math.min(Number(requestOpts.maxBytes), 4000000) : MAX_BYTES;
            arm();   // headers are in: the body's first silence window starts now
            // the race settles even for a body stream that ignores the abort
            const timedOut = new Promise((_, reject) => {
              const fail = () => reject(new Error('skill source timed out'));
              if (ctrl.signal.aborted) fail(); else ctrl.signal.addEventListener('abort', fail, { once: true });
            });
            let bytes;
            try { bytes = await Promise.race([bodyBytes(response, limit, requestOpts.maxBytes ? String(requestOpts.label || 'the download') : '', arm), timedOut]); }
            catch (e) {
              // A declared size can refuse before a body reader owns the response. Cancel that unread body
              // before a per-hop or package Agent closes; clearing the timers must not strand its socket.
              // An entered async iterator already cancels on failure, and an aborted reader owns its teardown.
              if (!response.bodyUsed) await discard(response);
              if (ctrl.signal.aborted) throw new Error('skill source timed out');
              throw e;
            }
            return { done: { url: dest.href, bytes, text: bytes.toString('utf8') } };
          });
          if (step.done) return step.done;
          // the source chose this hop: validated as its own destination, never as the caller's own URL
          dest = await checked(step.next, 'redirect', sess);
        } finally { clearTimeout(idle); }
      }
      throw new Error('skill source redirected too many times');
    } finally { clearTimeout(cap); }
  }
  const fetchDocument = (raw, requestOpts) => run(raw, requestOpts, null);
  /* ONE PACKAGE, ONE ANSWER PER HOST. A package fetch makes up to MAX_DISCOVERY_REQUESTS requests, nearly all to one or
     two hosts. Its session keeps each host's ONE validated DNS answer and one keep-alive pinned Agent for the package's
     life (inside its deadline) and closes them at the end, so a package costs a DNS question and a TLS handshake per
     host, not per file. The cached answer was validated, so a reused connection never reaches anything unvalidated. */
  fetchDocument.session = () => {
    const sess = egress.session({ policy: 'skillSource', lookup, agentFactory, onCloseError });
    return { fetchDocument: (raw, requestOpts) => run(raw, requestOpts, sess), close: () => sess.close() };
  };
  return fetchDocument;
}

function referencedPaths(text) {
  const found = new Set();
  const re = /(?:^|[\s(`'"\[])((?:references|templates|scripts|assets)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const p = m[1].replace(/[)\]}>.,;:'"]+$/, '');
    if (p && !p.split('/').includes('..')) found.add(p);
  }
  return Array.from(found);
}

function makeSkillPackageFetcher(deps) {
  deps = deps || {};
  const fetchDocument = deps.fetchDocument;
  if (typeof fetchDocument !== 'function') throw new Error('document fetcher required');
  const now = typeof deps.now === 'function' ? deps.now : null;
  if (!now) throw new Error('package fetcher requires an injected now function');
  const deadlineMs = Number(deps.deadlineMs) > 0 ? Number(deps.deadlineMs) : PACKAGE_DEADLINE_MS;
  const maxFiles = Number(deps.maxFiles) > 0 ? Number(deps.maxFiles) : MAX_PACKAGE_FILES;
  const maxPackageBytes = Number(deps.maxPackageBytes) > 0 ? Number(deps.maxPackageBytes) : MAX_PACKAGE_BYTES;
  const maxDepth = Number(deps.maxDepth) > 0 ? Number(deps.maxDepth) : MAX_DISCOVERY_DEPTH;
  const maxRequests = Number(deps.maxRequests) > 0 ? Number(deps.maxRequests) : MAX_DISCOVERY_REQUESTS;
  const maxFetchedBytes = Number(deps.maxFetchedBytes) > 0 ? Number(deps.maxFetchedBytes) : MAX_FETCHED_BYTES;

  function budget() {
    const startedAt = Number(now());
    // the production document fetcher offers a session (one DNS answer and one keep-alive pinned Agent per host for the
    // whole package, closed by close()); a plain fetchDocument function makes each request on its own
    const sess = typeof fetchDocument.session === 'function' ? fetchDocument.session() : null;
    const get = sess ? sess.fetchDocument : fetchDocument;
    let requests = 0, fetchedBytes = 0, fileCount = 0, packageBytes = 0;
    function remaining() {
      const left = deadlineMs - Math.max(0, Number(now()) - startedAt);
      if (left <= 0) throw new Error('skill package discovery exceeded its ' + deadlineMs + 'ms deadline');
      return left;
    }
    async function fetchOne(url) {
      const left = remaining();
      if (requests >= maxRequests) throw new Error('skill package discovery exceeded ' + maxRequests + ' network requests');
      requests++;
      const got = await get(url, { timeoutMs: left });
      remaining();
      const bytes = got && got.bytes ? Buffer.from(got.bytes) : Buffer.from((got && got.text) || '', 'utf8');
      fetchedBytes += bytes.length;
      if (fetchedBytes > maxFetchedBytes) throw new Error('skill package discovery downloaded more than ' + maxFetchedBytes + ' bytes');
      return Object.assign({}, got || {}, { bytes, text: got && got.text != null ? String(got.text) : bytes.toString('utf8') });
    }
    function ensureFileSlot() {
      if (fileCount >= maxFiles) throw new Error('skill package has more than ' + maxFiles + ' files');
    }
    function addFile(files, path, got) {
      ensureFileSlot();
      const bytes = got && got.bytes ? Buffer.from(got.bytes) : Buffer.from((got && got.text) || '', 'utf8');
      const nextBytes = packageBytes + bytes.length;
      if (nextBytes > maxPackageBytes) throw new Error('skill package is larger than ' + maxPackageBytes + ' bytes');
      packageBytes = nextBytes; fileCount++;
      files.push({ path, bytes });
    }
    function checkDepth(depth) {
      if (depth > maxDepth) throw new Error('skill package references exceed the maximum discovery depth of ' + maxDepth);
    }
    return { fetchOne, ensureFileSlot, addFile, checkDepth, close: async () => { if (sess) await sess.close(); } };
  }

  async function generic(sourceUrl) {
    const b = budget();
    try {
      const main = await b.fetchOne(sourceUrl);
      const files = [];
      b.addFile(files, 'SKILL.md', main);
      const base = new URL('.', main.url || sourceUrl);
      const queue = referencedPaths(main.text).map(rel => ({ rel, depth: 1 }));
      const seen = new Set(queue.map(row => row.rel));
      while (queue.length) {
        const item = queue.shift(), rel = item.rel;
        b.checkDepth(item.depth); b.ensureFileSlot();
        const got = await b.fetchOne(new URL(rel, base).href);
        b.addFile(files, rel, got);
        const bytes = got.bytes;
        if (/\.(?:md|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|html|css|xml|csv)$/i.test(rel)) {
          for (const child of referencedPaths(bytes.toString('utf8'))) if (!seen.has(child)) {
            b.checkDepth(item.depth + 1); seen.add(child); queue.push({ rel: child, depth: item.depth + 1 });
          }
        }
      }
      return { url: main.url || sourceUrl, files };
    } finally { await b.close(); }
  }
  async function github(sourceUrl) {
    const u = new URL(sourceUrl);
    const bits = u.pathname.split('/').filter(Boolean);
    if (u.hostname !== 'raw.githubusercontent.com' || bits.length < 4) return generic(sourceUrl);
    const owner = bits[0], repo = bits[1], ref = bits[2];
    const skillPath = bits.slice(3).join('/');
    if (!/(?:^|\/)SKILL\.md$/i.test(skillPath)) return generic(sourceUrl);
    const rootPath = skillPath.replace(/\/?SKILL\.md$/i, '');
    const apiBase = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/';
    const files = [];
    const b = budget();
    async function walk(relDir, depth) {
      b.checkDepth(depth);
      const apiPath = [rootPath, relDir].filter(Boolean).join('/');
      const response = await b.fetchOne(apiBase + apiPath.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(ref));
      let rows;
      try { rows = JSON.parse(response.text); } catch (_) { throw new Error('GitHub returned an invalid skill directory listing'); }
      if (!Array.isArray(rows)) throw new Error('GitHub did not return a skill directory');
      for (const row of rows) {
        const relative = String(row && row.path || '').slice(rootPath ? rootPath.length + 1 : 0).replace(/\\/g, '/');
        if (row.type === 'dir') {
          if (['references', 'templates', 'scripts', 'assets'].includes(relative.split('/')[0])) await walk(relative, depth + 1);
        } else if (row.type === 'file' && (relative === 'SKILL.md' || ['references', 'templates', 'scripts', 'assets'].includes(relative.split('/')[0]))) {
          if (!row.download_url) throw new Error('GitHub package file has no immutable download URL: ' + relative);
          b.ensureFileSlot();
          const got = await b.fetchOne(row.download_url);
          b.addFile(files, relative, got);
        }
      }
    }
    try {
      await walk('', 0);
      return { url: sourceUrl, files };
    } finally { await b.close(); }
  }
  return github;
}

module.exports = {
  makeSkillDocumentFetcher, makeSkillPackageFetcher, referencedPaths, MAX_REDIRECTS, MAX_BYTES,
  MAX_PACKAGE_FILES, MAX_PACKAGE_BYTES, MAX_DISCOVERY_DEPTH, MAX_DISCOVERY_REQUESTS, MAX_FETCHED_BYTES, PACKAGE_DEADLINE_MS
};
