/* Real channel/session reducers drive the rail projection: no inferred runs or fake unreads. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Channels = require('../frontend/app/channels.js');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
let now = 2000;
const storeContext = vm.createContext({ Date: { now: () => now } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/workstreams.js'), 'utf8'), storeContext);
const Workstreams = storeContext.Workstreams;
const context = vm.createContext({
  Channels, Workstreams, Date: { now: () => now },
  agents: new Map([['nova', { name: 'NOVA' }]]),
  railFmtElapsed: ms => String(ms), railRelTime: () => '1m'
});
const names = ['railRowState(w)', 'railAgentName(w)', 'railModelFull(w)', 'railRowLabel(w, st, project = false)', 'railRowTip(w, st, project = false)'];
vm.runInContext(names.map(n => A.fnBody(app, 'function ' + n)).join('\n'), context);
const row = w => context.railRowState(w);
Workstreams.init({ workstreams: [
  { id: 'general', title: null },
  { id: 'a', agentId: 'nova', title: 'Review', lastActiveAt: 2000, lastReadAt: 1000 },
  { id: 'b', agentId: 'nova', title: 'Other', lastActiveAt: 1000, lastReadAt: 1000 }
], activeId: 'general', generalId: 'general' });
Channels.reset();
const a = Workstreams.get('a'), b = Workstreams.get('b');
A.eq(row(a).dot, 'ws-dot unseen', 'new activity in a closed session is unread');
A.eq(row(b).dot, 'ws-dot seen', 'read session remains quiet');
A.ok(context.railRowLabel(a, row(a)).includes('unread activity'), 'unread is named for assistive technology');
Workstreams.switch('a');
A.eq(row(a).dot, 'ws-dot seen', 'opening the actual session clears unread');
Workstreams.switch('general');
A.eq(row(a).dot, 'ws-dot seen', 'leaving a read session does not relight it');

now = 3000;
Channels.begin('a', now);
A.eq(row(a).dot, 'ws-dot connecting', 'send/connecting is never shown as confirmed work');
A.eq(row(a).meta, 'Connecting', 'no elapsed work is claimed while connecting');
A.ok(context.railRowLabel(a, row(a)).includes('connecting'), 'connecting state is accessible');
now = 4000;
Channels.setRunId('a', 'run-a', now);
Workstreams.appendRun('a', 'run-a', now);
now = 12000;
A.eq(row(a).dot, 'ws-dot working', 'server-confirmed run enters the working state');
A.eq(row(a).meta, '8000', 'elapsed starts at confirmed run time');
A.eq(row(b).dot, 'ws-dot seen', 'a different session on the same agent does not light up');
A.ok(context.railRowLabel(a, row(a)).includes('thinking'), 'working status is named for screen readers');
Channels.setPending('a', { tool: 'fs.write', promptId: 'approval' }, 6000);
A.eq(row(a).dot, 'ws-dot needsyou approval', 'pending approval outranks the working animation');
A.eq(row(a).meta, 'Approval needed', 'approval has an explicit visible label');
A.ok(context.railRowTip(a, row(a)).includes('awaiting your approval'), 'tooltip explains the actual approval state');
Channels.clearPending('a', 11000);
A.eq(row(a).dot, 'ws-dot working', 'resolving approval returns to the same confirmed run');
A.eq(row(a).meta, '3000', 'approval waiting time is excluded after resume');
A.ok(!context.railRowTip(a, row(a)).includes('awaiting'), 'resumed tooltip no longer claims a pending approval');
Channels.setPending('a', { tool: 'brief.ask', promptId: 'question' }, now);
A.eq(row(a).dot, 'ws-dot needsyou reply', 'an agent question has its own reply signal');
A.eq(row(a).meta, 'Reply needed', 'a question cannot masquerade as approval');
now = 13000;
Channels.clearPending('a', now);
Channels.end('a');
Workstreams.noteRunEnd('a', 'run-a', true);
Workstreams.touch('a');
A.eq(row(a).dot, 'ws-dot unseen', 'completed background activity becomes steadily unread');
Workstreams.switch('a');
A.eq(row(a).dot, 'ws-dot seen', 'opening the completed conversation marks it read');
Workstreams.init(Workstreams.serialize());
A.eq(row(Workstreams.get('a')).dot, 'ws-dot seen', 'read status survives save hydration');
let savedA = Workstreams.get('a');
Workstreams.appendRun('a', 'run-failed', 3000);
Workstreams.noteRunEnd('a', 'run-failed', false);
A.eq(row(savedA).dot, 'ws-dot failed', 'a recorded failure is not a live approval');
A.eq(row(savedA).busy, false, 'failure is not reported as ongoing work');
A.eq(row(savedA).meta, '1m', 'failure keeps the normal timestamp instead of a duplicate FAILED label');
A.eq(row(savedA).attn, false, 'a settled failure does not create the approval action row');
A.ok(context.railRowLabel(savedA, row(savedA)).includes('last run failed'), 'failure remains accessible without a visible badge');
A.ok(context.railRowTip(savedA, row(savedA), true).includes('last run failed'), 'project rows keep failure details in their tooltip');
Workstreams.init(Workstreams.serialize());
A.eq(row(Workstreams.get('a')).dot, 'ws-dot failed', 'failed marker survives saved-state hydration');
savedA = Workstreams.get('a');

Channels.setPending('a', { tool: 'fs.write', promptId: 'early' });
A.eq(row(savedA).dot, 'ws-dot needsyou approval', 'a real prompt is visible even before a run-start event');
Channels.clearPending('a');
Workstreams.appendRun('a', 'run-new', 4000);
Channels.begin('a', 4000);
A.eq(row(savedA).dot, 'ws-dot connecting', 'a new attempt clears the stale failure signal');
Channels.reset();
const css = fs.readFileSync(path.join(__dirname, '../frontend/css/glass-demo.css'), 'utf8');
A.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ws-dot::before \{ animation: none; \}/.test(css), 'reduced motion disables both lamp and scan animation');
A.ok(/\.ws-dot\.failed \{[^}]*animation: gd-session-failure/.test(css), 'failure X has its own flashing animation');
A.ok(/railRowTip\(w, st, project\), tipAttr/.test(app), 'in-place rail updates refresh adopted tooltip text along with the signal');
A.ok(context.railRowLabel(savedA, row(savedA), true).includes(row(savedA).status), 'project session rows share the current state label');
A.ok(!context.railRowLabel(savedA, row(savedA), true).includes('Shift+F10'), 'project sessions do not advertise unsupported action shortcuts');
A.ok(!context.railRowTip(savedA, row(savedA), true).includes('right-click'), 'project session tooltip names its real open action');
A.report('session-indicators.test');
