'use strict';

// Small local authoring adapter; uses the original editor, compiler and HTTP save API.
// Offline by default; programmatic live opt-in exposes only save/routing authoring.
const fs = require('node:fs');
const WM = require('../frontend/app/worldmodel.js');
const LE = require('../frontend/app/lineedit.js');
const P = require('../frontend/app/pipeline.js');
const ROLES = new Set(['ANALYST', 'WRITER', 'REVIEWER', 'RESEARCHER', 'ENGINEER']);
const checked = r => { if (!r || !r.ok) throw new Error(JSON.stringify(r)); return r; };

function inspect(st) {
  const plan = P.compileRoutingPlan(st.projectGeometry());
  return {
    valid: P.ok(plan), errors: plan.errors,
    lines: st.props().filter(p => p.t === 'intake').map(p => ({ id: p.id, name: p.label || st.lineName(p.id), graph: st.lineGraph(p.id) })),
    steps: st.props().filter(p => p.t === 'bay').map(p => ({ id: p.id, role: p.role, agentId: p.agentId, label: p.label, brief: p.brief, hands: p.hands, hasCompute: st.bayObjects(p.agentId, p.id).includes('computer') })),
    plan
  };
}

function create(st, spec, agentIds, opts = {}) {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 48 || !Array.isArray(spec.steps) || !spec.steps.length || spec.steps.length > 8) throw new Error('Expected name (1-48 chars) and 1-8 steps');
  if (st.props().some(p => p.t === 'intake' && p.label === spec.name)) throw new Error('Workflow already exists; use edit');
  for (const s of spec.steps) {
    if (!ROLES.has(s.role) || !agentIds.has(s.agentId)) throw new Error('Unknown role or agent: ' + JSON.stringify(s));
    if (typeof s.brief !== 'string' || !s.brief.trim() || s.brief.length > 2000 || typeof s.hands !== 'string' || s.hands.length > 160) throw new Error('Invalid brief or handoff');
  }
  const room = opts.roomId ? st.roomById(opts.roomId) : null;
  if (opts.roomId && !room) throw new Error('Unknown target room');
  // Keep the native layout engine, but restrict its available floor to this BU.
  const editor = room ? Object.assign({}, st, { lineGraph(id) {
    const g = st.lineGraph(id);
    if (g.ok) g.floor.rects = structuredClone(room.rects);
    return g;
  } }) : st;
  const before = new Set(st.props().map(p => p.id));
  checked(LE.run(editor, null, 'newLine', { role: spec.steps[0].role }, { near: opts.near || { x: 8, y: 5 } }));
  const intake = st.props().find(p => p.t === 'intake' && !before.has(p.id));
  checked(st.setPropLabel(intake.id, spec.name));
  let current = st.props().find(p => p.t === 'bay' && !before.has(p.id)).id;
  const ids = [];
  for (let i = 0; i < spec.steps.length; i++) {
    const s = spec.steps[i];
    if (i) current = checked(LE.run(editor, current, 'appendStep', { after: current, role: s.role }, {})).focus;
    checked(st.assignPropAgent(current, s.agentId));
    checked(st.setPropBrief(current, s.brief));
    checked(st.setPropHands(current, s.hands));
    if (s.label) checked(st.setPropLabel(current, s.label));
    ids.push(current);
  }
  // A bound bay alone is not runnable: StarNet requires an actual assigned computer.
  for (const s of spec.steps) checked(st.ensureWorkstation(s.agentId));
  const result = inspect(st);
  if (!result.valid) throw new Error('Workflow does not compile: ' + JSON.stringify(result.errors));
  return { intake: intake.id, steps: ids };
}

function edit(st, id, patch) {
  if (!st.propById(id) || st.propById(id).t !== 'bay') throw new Error('Unknown workflow step');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(k => !['brief', 'hands', 'label'].includes(k))) throw new Error('Only brief, hands and label are editable in this spike');
  for (const k of keys) {
    if (typeof patch[k] !== 'string' || patch[k].length > ({ brief: 2000, hands: 160, label: 48 })[k]) throw new Error('Invalid ' + k);
    checked(st[({ brief: 'setPropBrief', hands: 'setPropHands', label: 'setPropLabel' })[k]](id, patch[k]));
  }
}

async function client(base, { allowLiveAuthoring = false } = {}) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') throw new Error('Only a local test station is allowed');
  const status = await fetch(new URL('/api/lab/status', url), { signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const offline = status.offline === true && status.execution === false;
  const liveAuthoring = allowLiveAuthoring === true && status.live === true;
  if (!status.lab || (!offline && !liveAuthoring)) throw new Error('Refusing to edit a station without the offline lab guard (live authoring requires explicit opt-in)');
  const page = await fetch(url, { signal: AbortSignal.timeout(5000) }).then(r => r.text());
  const match = page.match(/window\.__STARNET_API_TOKEN__=("(?:\\.|[^"])*")/);
  if (!match) throw new Error('No station token; start the local lab first');
  const token = JSON.parse(match[1]);
  return async (route, body) => {
    // This opt-in grants configuration only, NEVER key checks, jobs or execution.
    if (liveAuthoring && !(body === undefined ? ['/api/save', '/api/colony/installation'].includes(route) : ['/api/save', '/api/routing'].includes(route))) throw new Error('Live authoring route denied');
    const res = await fetch(new URL(route, url), { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: url.origin, 'X-StarNet-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await res.json();
    if (!res.ok || value.ok === false) throw new Error(JSON.stringify({ status: res.status, ...value }));
    return value;
  };
}

async function main(args) {
  const [command = 'help', ...rest] = args;
  const flag = key => { const i = rest.indexOf(key); return i < 0 ? undefined : rest[i + 1]; };
  if (command === 'help') return { commands: ['read', 'validate', 'create --spec FILE [--apply]', 'edit --step ID --patch FILE [--apply]'],
    notes: ['Changes are dry-run unless --apply is present.', 'Browser must be reloaded after external edits.', 'No model or workflow execution.',
      'Against a LIVE lab, editing needs the explicit opt-in --live-authoring (the offline lab needs nothing).'],
    base: 'http://127.0.0.1:8790' };
  if (!['read', 'validate', 'create', 'edit'].includes(command)) throw new Error('Unknown command');
  const request = await client(flag('--base') || 'http://127.0.0.1:8790', { allowLiveAuthoring: rest.includes('--live-authoring') });
  const state = await request('/api/save');
  if (!state.save || !state.save.agent) throw new Error('No lab station save');
  const save = structuredClone(state.save);
  const st = WM.create(save.station || WM.starterDoc());
  if (command === 'create') {
    const file = flag('--spec');
    if (!file) throw new Error('--spec FILE required');
    create(st, JSON.parse(fs.readFileSync(file, 'utf8')), new Set([save.agent, ...(save.agents || [])].map(a => a.id)));
  }
  if (command === 'edit') {
    const file = flag('--patch');
    if (!file || !flag('--step')) throw new Error('--step ID --patch FILE required');
    edit(st, flag('--step'), JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  const result = inspect(st);
  if (['create', 'edit'].includes(command) && rest.includes('--apply')) {
    if (!result.valid) throw new Error('Invalid workflow; not saved');
    save.station = st.serialize();
    save.updatedAt = Math.max(Date.now(), Number(save.updatedAt || 0) + 1);
    const saved = await request('/api/save', save); // server enforces _saveRevision; no retry on conflicts
    try { await request('/api/routing', result.plan); }
    catch (e) { throw new Error('Station saved but routing publish failed; reload UI to reconcile: ' + e.message); }
    result.applied = true;
    result.revision = saved.revision;
    result.note = 'Reload the browser to adopt the external edit; do not edit concurrently.';
  } else result.applied = false;
  delete result.plan;
  return result;
}

module.exports = { create, edit, inspect, client, main };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1;
});
