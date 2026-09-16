/* node test/comms-deliverable-replay.test.js — a stream's recorded deliverables (the ▤ saved / ▤ made rows)
   are replayed by renderHistory in time order, so a reload, stream switch or Try Again keeps the clickable
   file rows a customer relies on (2026-09-14 report: "can't send clickable files anymore, sends a text path").
   chat.js is browser/DOM flow and not require-able (see chat-stopped-retry.test.js) — the record shape is
   exercised through Workstreams; the render seam is locked on source. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');

// ---- the record every replay depends on: Workstreams files {title, kind, runId, t} on the stream ----
{
  const Workstreams = require('../frontend/app/workstreams.js');
  const ws = Workstreams.create ? Workstreams.create({ agentId: 'agent', title: 'files' }) : null;
  A.ok(ws && ws.id, 'a workstream can be created headlessly');
  A.eq(Workstreams.recordDeliverable(ws.id, { title: 'out/report.md', kind: 'file', runId: 'r1', t: 1000 }), true, 'a file deliverable is recorded');
  A.eq(Workstreams.recordDeliverable(ws.id, { title: 'out/cover.png', kind: 'image', runId: 'r1', t: 1200 }), true, 'an image deliverable is recorded');
  const w = Workstreams.get ? Workstreams.get(ws.id) : Workstreams.find(ws.id);
  A.eq(w.deliverables.map(d => d.title), ['out/report.md', 'out/cover.png'], 'deliverables persist on the stream in arrival order');
  A.eq(w.deliverables.map(d => d.kind), ['file', 'image'], 'the RENDERED kind is what gets recorded (file stays file, image stays image)');
  A.eq(w.deliverables.map(d => d.t), [1000, 1200], 'each record carries the time the live row was painted');
}

// ---- the render seam: renderHistory replays those rows in stamp order, before the reply that followed them ----
{
  A.ok(/function replayableDeliverables\(ws\)[\s\S]{0,400}d\.kind === 'file' \|\| d\.kind === 'image' \|\| d\.kind === 'video' \|\| d\.kind === 'audio'/.test(src),
    'only file/image/video/audio deliverables replay (skill/tool records keep their own surfaces)');
  A.ok(/function replayableDeliverables\(ws\)[\s\S]{0,600}\.sort\(\(a, b\) => \(\+a\.t \|\| 0\) - \(\+b\.t \|\| 0\)\)/.test(src),
    'replay order is the recorded time, not array order');
  A.ok(/function replayDeliverableRow\(d, agentId\)[\s\S]{0,400}if \(mk === 'image'\) imageDeliverableLine\(d\.title, agentId\);[\s\S]{0,200}mediaPlayerLine\(d\.title, agentId, mk\);[\s\S]{0,120}else deliverableLine\(d\.title, agentId\);/.test(src),
    'a replayed row uses the SAME renderers as the live event (thumbnail / player / ▤ saved link)');
  const body = src.match(/function renderHistory\(\) \{([\s\S]*?)\n  \}\n/);
  A.ok(body, 'renderHistory found');
  const rh = body ? body[1] : '';
  A.ok(/const delivs = replayableDeliverables\(activeWs\)/.test(rh), 'renderHistory reads the active stream\'s recorded deliverables');
  A.ok(/if \(stamp !== false\) flushDeliverablesBefore\(stamp\);[\s\S]{0,200}const r = row\('agent'/.test(rh),
    'files stamped at/before an assistant turn render BEFORE that reply (where the live run painted them)');
  A.ok(/flushDeliverablesBefore\(null\);[\s\S]{0,120}finally \{ renderingHistory = false; \}/.test(rh),
    'files newer than the last stored turn still render, after the transcript');
  A.ok(/const delivAgent = \(activeWs && activeWs\.agentId\) \|\| 'agent'/.test(rh), 'replayed rows open through the stream\'s own agent workspace');
}

A.report('comms-deliverable-replay.test');
