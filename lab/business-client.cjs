'use strict';
async function client() {
  const base = 'http://127.0.0.1:8790';
  const lab = await fetch(base + '/api/lab/status').then(r => r.json());
  if (!lab.lab || !lab.live) throw new Error('A live local lab is required');
  const page = await fetch(base).then(r => r.text()), match = page.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
  if (!match) throw new Error('Local station is not ready');
  const token = JSON.parse(match[1]);
  return async (route, body) => {
    if (!['/api/colony', '/api/colony/model-defaults', '/api/colony/command', '/api/colony/run', '/api/save'].includes(route)) throw new Error('Business test route denied');
    if (body !== undefined && !['/api/colony/command', '/api/colony/run'].includes(route)) throw new Error('Business test write denied');
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, 'X-StarNet-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(900000) });
    const value = await response.json(); if (!response.ok || value.ok === false) throw new Error(value.error || 'Business request failed'); return value;
  };
}
module.exports = { client };
