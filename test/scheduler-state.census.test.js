/* Census of clocks, complementing the real consumer matrix. A new page reader must consume the server projection. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { sidecarSourceFiles, sidecarFunctionSource } = require('./helpers/source.js');
const dir = path.join(__dirname, '../frontend/app');
const readers = [];
function walk(at) {
  for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
    const file = path.join(at, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.js')) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(s => !s.trim().startsWith('//') && /\.nextRunAt\b/.test(s));
      if (lines.length) {
        readers.push(path.relative(dir, file).split(path.sep).join('/'));
        A.eq(lines.length, 1, entry.name + ': only one legacy raw schedule read remains');
        const text = fs.readFileSync(file, 'utf8');
        A.ok(text.includes("hasOwnProperty.call(") && text.includes("'nextFireAt'"), entry.name + ': server projection is distinguished from an older host');
      }
    }
  }
}
walk(dir);
A.eq(readers.sort(), ['apps.js', 'widgets.js', 'windows/routines.js', 'workview.js'], 'every page countdown reader is in the server-projection contract');
const files = new Map(sidecarSourceFiles().map(f => [f.rel, f.text]));
for (const rel of ['sidecar/apps.js', 'sidecar/slash-actions.js', 'sidecar/tools/builtin/routines.js']) {
  const src = files.get(rel) || '';
  A.ok(src.includes('scheduler-state.js') && /(?:SchedulerState|Scheduler)\.nextFireOf\(/.test(src), rel + ': uses the single pure fire projection');
}
A.ok(/SchedulerState\.nextFireOf\(/.test(sidecarFunctionSource('cronStateSnapshot')), 'cron rows project through the shared owner');
A.ok(/SchedulerState\.nextFireOf\(/.test(sidecarFunctionSource('handleWorkshopBacklog')), 'workshop clock projects through the shared owner');
A.ok(/schedulerState\(\)/.test(sidecarFunctionSource('lifecycleArmedSnapshot')), 'lifecycle reads shared scheduler authority');
const remote = files.get('sidecar/remote/host.js') || '';
A.ok(/SchedulerState\.holdOf\(/.test(remote) && remote.includes("hasOwnProperty.call(j, 'nextFireAt')"), 'phone reads shared hold and projected clock');
A.report('scheduler-state.census.test');
