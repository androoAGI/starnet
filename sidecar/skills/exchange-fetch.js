/* Bounded public-HTTPS fetcher for Skill Exchange. Every redirect is revalidated through the
   station's existing URL + DNS guards. Dependency-injected so security cases need no network. */
'use strict';

const MAX_REDIRECTS = 4;
const MAX_BYTES = 256000;
const packageFormat = require('./package-format.js');
const MAX_PACKAGE_FILES = packageFormat.DEFAULT_MAX_FILES;
const MAX_PACKAGE_BYTES = packageFormat.DEFAULT_MAX_PACKAGE_BYTES;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_REQUESTS = MAX_PACKAGE_FILES * 2;
const MAX_FETCHED_BYTES = MAX_PACKAGE_BYTES * 2; // package bytes plus bounded GitHub directory listings
const PACKAGE_DEADLINE_MS = 30000;

function makeSkillDocumentFetcher(deps) {
  deps = deps || {};
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const assertSafeUrl = deps.assertSafeUrl;
  const assertResolvedSafe = deps.assertResolvedSafe;
  const lookup = deps.lookup;
  const timeoutMs = deps.timeoutMs > 0 ? deps.timeoutMs : 12000;

  async function checked(raw) {
    let u = assertSafeUrl ? assertSafeUrl(raw) : new URL(raw);
    if (u.protocol !== 'https:') throw new Error('skill sources must use HTTPS');
    if (u.username || u.password) throw new Error('skill source URLs cannot contain credentials');
    if (assertResolvedSafe) await assertResolvedSafe(u, lookup);
    return u;
  }
  // limit/label: a caller fetching something other than a SKILL.md (the Skill Market's catalog index) passes its own
  // cap and name, so an oversized document is refused under its real name instead of being called a SKILL.md
  async function bodyBytes(response, limit, label) {
    const tooBig = () => new Error(label ? label + ' is larger than ' + Math.round(limit / 1000) + ' KB' : 'SKILL.md is larger than 256 KB');
    const declared = Number(response && response.headers && response.headers.get('content-length')) || 0;
    if (declared > limit) throw tooBig();
    if (response.body && response.body[Symbol.asyncIterator]) {
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
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
  async function fetchDocument(raw, requestOpts) {
    if (typeof fetchImpl !== 'function') throw new Error('network fetch is unavailable');
    requestOpts = requestOpts || {};
    const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, Number(requestOpts.timeoutMs) || timeoutMs));
    let u = await checked(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetchImpl(u.href, {
          method: 'GET', redirect: 'manual', signal: ctrl.signal,
          headers: { accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.1', 'user-agent': 'Agent OS-Skill-Exchange/1' }
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new Error('skill source timed out');
        throw e;
      } finally { clearTimeout(timer); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && response.headers.get('location');
        if (!location) throw new Error('skill source redirected without a location');
        if (hop === MAX_REDIRECTS) throw new Error('skill source redirected too many times');
        u = await checked(new URL(location, u.href).href);
        continue;
      }
      if (!response.ok) throw new Error('skill source returned HTTP ' + response.status);
      const limit = Number(requestOpts.maxBytes) > 0 ? Math.min(Number(requestOpts.maxBytes), 4000000) : MAX_BYTES;
      const bytes = await bodyBytes(response, limit, requestOpts.maxBytes ? String(requestOpts.label || 'the download') : '');
      return { url: u.href, bytes, text: bytes.toString('utf8') };
    }
    throw new Error('skill source redirected too many times');
  }
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
      const got = await fetchDocument(url, { timeoutMs: left });
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
    return { fetchOne, ensureFileSlot, addFile, checkDepth };
  }

  async function generic(sourceUrl) {
    const b = budget();
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
  }
  async function github(sourceUrl) {
    const b = budget();
    const u = new URL(sourceUrl);
    const bits = u.pathname.split('/').filter(Boolean);
    if (u.hostname !== 'raw.githubusercontent.com' || bits.length < 4) return generic(sourceUrl);
    const owner = bits[0], repo = bits[1], ref = bits[2];
    const skillPath = bits.slice(3).join('/');
    if (!/(?:^|\/)SKILL\.md$/i.test(skillPath)) return generic(sourceUrl);
    const rootPath = skillPath.replace(/\/?SKILL\.md$/i, '');
    const apiBase = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/';
    const files = [];
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
    await walk('', 0);
    return { url: sourceUrl, files };
  }
  return github;
}

module.exports = {
  makeSkillDocumentFetcher, makeSkillPackageFetcher, referencedPaths, MAX_REDIRECTS, MAX_BYTES,
  MAX_PACKAGE_FILES, MAX_PACKAGE_BYTES, MAX_DISCOVERY_DEPTH, MAX_DISCOVERY_REQUESTS, MAX_FETCHED_BYTES, PACKAGE_DEADLINE_MS
};
