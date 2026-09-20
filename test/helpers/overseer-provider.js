'use strict';
const http = require('node:http');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function startOverseerProvider(options = {}) {
  let reviews = 0;
  const requests = [];
  const mock = http.createServer(async (req, res) => {
    if (req.url.includes('/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body), messages = parsed.messages || [];
    requests.push(messages);
    res.setHeader('Content-Type', 'text/event-stream');
    const send = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    const call = (name, args) => send({ tool_calls: [{ index: 0, id: name + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const user = messages.filter(m => m.role === 'user').pop();
    const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
    const tools = messages.slice(lastUserIndex + 1).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const crew = system.match(/^  - ([A-Za-z0-9_-]+) \(/m);
    const workerId = crew ? crew[1] : 'researcher';
    if (!parsed.tools || !parsed.tools.length) send({ content: 'Ready.' });
    else if (String(user && user.content).includes('DIRECT_PROOF')) send({ content: 'Direct specialist answer.' });
    else if (String(user && user.content).startsWith('Review the background work')) { reviews++; if (options.reviewDelay) await sleep(options.reviewDelay); send({ content: 'Reviewed findings: the worker returned two observations.' }); }
    else if (String(user && user.content).includes('WORKER_PROOF')) { await sleep(options.workerDelay || 800); send({ content: 'WORKER_FINDINGS: two verified observations.' }); }
    else if (String(user && user.content).startsWith('Review the project brief and identify')) { await sleep(options.workerDelay || 800); send({ content: 'The project needs a clear audience and a small first milestone. Start with the core workflow, then test it with one user.' }); }
    else if (system.includes('[PROJECT WORKSPACE]')) {
      if (!tools.includes('brief_proceed')) call('brief_proceed', { objective: 'Review this project with the station crew', deliverable: 'A concise project recommendation' });
      else if (!tools.includes('team_dispatch')) call('team_dispatch', { workers: [{ agentId: workerId, prompt: 'Review the project brief and identify the two most useful next steps.' }], background: true });
      else send({ content: 'I’ve asked the crew to review the project. You can keep talking here while they work.' });
    }
    else if (/follow.up/i.test(String(user && user.content))) {
      if (!tools.includes('brief_proceed')) call('brief_proceed', { objective: 'Continue the existing research thread', deliverable: 'Follow-up findings' });
      else if (!tools.includes('team_dispatch')) call('team_dispatch', { workers: [{ agentId: workerId, session: 'Research proof', prompt: 'WORKER_PROOF: continue from your previous findings' }], background: true });
      else send({ content: 'Follow-up started in the existing working session.' });
    }
    else if (!tools.includes('brief_proceed')) call('brief_proceed', { objective: 'Delegate research and review the findings', deliverable: 'Research findings' });
    else if (!tools.includes('session_create')) call('session_create', { title: 'Research proof', agentId: workerId });
    else if (!tools.includes('team_dispatch')) call('team_dispatch', { workers: [{ agentId: workerId, session: 'Research proof', prompt: 'WORKER_PROOF: return two findings' }], background: true });
    else send({ content: 'Research started. You can keep talking here.' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  return { server: mock, requests, reviews: () => reviews };
}
module.exports = { startOverseerProvider };
