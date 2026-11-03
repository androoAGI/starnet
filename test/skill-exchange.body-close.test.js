'use strict';
// Real response bodies and pinned undici sockets. Only the public-to-loopback transport edge is substituted.
const A = require('./_assert.js');
const http = require('node:http');
const { Agent, fetch } = require('undici');
const moduleFile = require.resolve('../sidecar/skills/exchange-fetch.js');
let owner = require(moduleFile);
if (process.env.SKILL_EXCHANGE_FETCH_SOURCE) {
  const Module = require('node:module');
  const saved = new Module(moduleFile, module);
  saved.filename = moduleFile; saved.paths = module.paths;
  saved._compile(require('node:fs').readFileSync(process.env.SKILL_EXCHANGE_FETCH_SOURCE, 'utf8'), moduleFile);
  owner = saved.exports;
}
const { makeSkillDocumentFetcher, makeSkillPackageFetcher } = owner;

async function scenario(mode, kind) {
  const label = mode + '/' + kind;
  const events = [], seen = [];
  const agents = [], socketClosures = [], responses = [];
  let guard, questions = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.headers.host);
    if (req.url.startsWith('/repos/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ type: 'file', path: 'SKILL.md', download_url: 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md' }]));
      return;
    }
    if (kind === 'declared') {
      res.writeHead(200, { 'Content-Length': '300000', 'Content-Type': 'text/plain' });
      res.write('x'); // The refused body stays open until its owner cancels it.
    } else if (kind === 'streamed') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write(Buffer.alloc(300000, 120));
    } else res.end('small');
  });
  server.on('connection', socket => socketClosures.push(new Promise(resolve => socket.once('close', resolve))));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    guard = setTimeout(() => { events.push('forced-close'); server.closeAllConnections(); }, 4000);
    const read = makeSkillDocumentFetcher({
      timeoutMs: 1000, bodyDeadlineMs: 2000,
      lookup: async () => { questions++; return [{ address: '93.184.216.34', family: 4 }]; },
      agentFactory: opts => {
        const agent = new Agent({ ...opts, connect: { ...opts.connect, lookup(host, options, cb) {
          opts.connect.lookup(host, options, (error, address, family) => {
            if (error) return cb(error);
            if (Array.isArray(address)) return cb(null, address.map(row => ({ address: '127.0.0.1', family: row.family })));
            cb(null, '127.0.0.1', family);
          });
        } } });
        agents.push(agent);
        // A wrapper observes close without overriding Agent.close's callback/promise recursion.
        return { dispatch: agent.dispatch.bind(agent), close: async () => {
          events.push('close-start'); await agent.close(); events.push('close-done');
        } };
      },
      fetchImpl: (url, init) => {
        const local = new URL(url); local.protocol = 'http:'; local.port = String(port);
        // TLS is outside this body-ownership test. The validated name and actual pinned Agent stay intact.
        init.signal.addEventListener('abort', () => events.push('abort'), { once: true });
        // Keep the response reachable: garbage collection must not substitute for the caller's cleanup.
        return fetch(local, init).then(response => { responses.push(response); return response; });
      }
    });
    let result, error;
    const url = mode === 'github' ? 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md' : 'https://body-close.example/SKILL.md';
    try {
      if (mode === 'document') result = await read(url);
      else if (mode === 'session') {
        const session = read.session();
        try { result = await session.fetchDocument(url); }
        finally { await session.close(); }
      } else result = await makeSkillPackageFetcher({ fetchDocument: read, now: Date.now, deadlineMs: 2000 })(url);
    }
    catch (caught) { error = caught; }
    events.push('settled');
    await Promise.all(socketClosures);
    if (kind === 'small') A.eq(result && (result.files ? result.files[0].bytes.toString('utf8') : result.text), 'small', label + ': a permitted document is fully read');
    else A.ok(error && /larger than/.test(error.message), label + ': retains the actual size refusal');
    A.eq(events.includes('abort'), false, label + ': refusal/read completes without waiting for the request deadline');
    A.eq(events.includes('forced-close'), false, label + ': the external watchdog does not have to release the socket');
    A.ok(events.lastIndexOf('close-done') >= 0 && events.lastIndexOf('close-done') < events.indexOf('settled'), label + ': caller settles after its pinned dispatchers close');
    A.eq(events.filter(event => event === 'close-done').length, agents.length, label + ': every owned dispatcher closes');
    A.eq(questions, mode === 'github' ? 2 : 1, label + ': one validated DNS answer per actual host');
    A.eq(seen, mode === 'github' ? ['api.github.com:' + port, 'raw.githubusercontent.com:' + port] : ['body-close.example:' + port], label + ': transport retains the validated Hosts');
  } finally {
    clearTimeout(guard);
    await Promise.all(agents.map(agent => agent.destroy()));
    responses.length = 0;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
(async () => {
  for (const mode of ['document', 'session', 'package', 'github']) {
    for (const kind of ['declared', 'streamed', 'small']) await scenario(mode, kind);
  }
  A.report('skill-exchange.body-close');
})().catch(error => { console.error(error); process.exitCode = 1; });
