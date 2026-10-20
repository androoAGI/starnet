'use strict';
const { json, readJsonBody } = require('../respond.js');
const { readBody } = require('../http-body.js');
const PUBLIC_COMMANDS = new Set(['configuration.set', 'task.create', 'task.change', 'approval.decide', 'approval.revoke',
  'action.prepare', 'action.uncertain', 'action.confirm', 'recovery.resolve', 'metric.record', 'preference.global']);
function makeRoutes({ getService, execute, disabled = () => false }) {
  return async function handle(req, res) {
    try {
      const service = await getService(), bare = req.url.split('?')[0];
      if (req.method === 'GET' && bare === '/api/colony') return json(res, 200, { ok: true, ...service.view() });
      const image = /^\/api\/colony\/image\/([a-f0-9]{64})$/.exec(bare);
      if (req.method === 'GET' && image) {
        const bytes = service.image(image[1]);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(bytes);
      }
      if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'COLONY_ROUTE_NOT_FOUND' });
      const body = await readJsonBody(req, readBody, 512 * 1024, res);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { ok: false, error: 'COLONY_INVALID_REQUEST' });
      if (bare === '/api/colony/command') {
        if (!PUBLIC_COMMANDS.has(body.type)) return json(res, 403, { ok: false, error: 'COLONY_HOST_ONLY_COMMAND' });
        return json(res, 200, { ok: true, ...await service.command(body) });
      }
      if (bare === '/api/colony/recover') return json(res, 200, { ok: true, ...await service.recover(body.expectedRevision) });
      if (bare === '/api/colony/run') {
        if (disabled()) return json(res, 409, { ok: false, error: 'COLONY_EXECUTION_DISABLED_OR_HALTED' });
        return json(res, 200, { ok: true, ...await service.runToGate(body.taskId, body.expectedRevision, body.reserve, execute) });
      }
      if (bare === '/api/colony/dashboard-preview') return json(res, 200, { ok: true,
        preview: require('./pinterest.js').importSnapshot(body.snapshot, body.businessUnitId, body.account) });
      return json(res, 404, { ok: false, error: 'COLONY_ROUTE_NOT_FOUND' });
    } catch (error) {
      // Never echo provider exceptions, key material or imported source bodies.
      const code = /^COLONY_[A-Z_]+$/.test(error.code || error.message || '') ? (error.code || error.message) : 'COLONY_OPERATION_FAILED';
      return json(res, code.includes('NOT_FOUND') ? 404 : 409, { ok: false, error: code });
    }
  };
}
module.exports = { makeRoutes, PUBLIC_COMMANDS };
