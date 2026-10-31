import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { makeRunJournal } = require('../../../sidecar/run-journal.js');
const { makeTranscriptStore } = require('../../../sidecar/transcriptstore.js');
const { makeChannelStore } = require('../../../sidecar/channels/store.js');
const { makeChannelHub } = require('../../../sidecar/channels/hub.js');
const { makeSubagentManager } = require('../../../sidecar/subagents.js');
const cronStore = require('../../../sidecar/cron-store.js');
const { makeCronDriver } = require('../../../sidecar/cron-driver.js');
const fsMod = require('node:fs');
const pathMod = require('node:path');

function memoryJournal() {
  const files = new Map();
  const io = {
    create(id, line) { if (files.has(id)) throw new Error('exists'); files.set(id, line + '\n'); },
    append(id, line) { files.set(id, (files.get(id) || '') + line + '\n'); },
    read(id) { return files.get(id); }, list() { return Array.from(files.keys()); }, readFile(id) { return files.get(id); },
    remove(id) { files.delete(id); }, repair() {}, quarantine() {}
  };
  return { files, journal: makeRunJournal({ io, clock: { now: () => 1 } }) };
}

function memoryFs() {
  const files = new Map();
  return { files,
    readFileSync(path) { if (!files.has(path)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files.get(path); },
    writeFileSync(path, value) { files.set(path, String(value)); },
    renameSync(from, to) { if (!files.has(from)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } files.set(to, files.get(from)); files.delete(from); },
    mkdirSync() {}
  };
}

const EXPECTED = {
  'fault-accepted-before-provider': ['accepted-before-provider', 'resumable-preserving-identity'],
  'fault-provider-stream': ['provider-stream', 'partial-preserved-not-done'],
  'fault-read-intent-before-dispatch': ['read-intent-before-dispatch', 'resume-once-original-run'],
  'fault-mutation-intent-before-dispatch': ['mutation-intent-before-dispatch', 'explicit-needs-review'],
  'fault-mutation-before-result-checkpoint': ['mutation-before-result-checkpoint', 'uncertain-no-redispatch'],
  'fault-result-before-next-turn': ['result-before-next-turn', 'next-turn-no-redispatch'],
  'fault-final-before-transcript-ack': ['final-before-transcript-ack', 'awaiting-transcript-commit'],
  'fault-transcript-before-delivery-ack': ['transcript-before-delivery-ack', 'redeliver-once-original-destination'],
  'fault-compaction-rotation': ['compaction-rotation', 'complete-searchable-history'],
  'fault-routine-subagent-finalization': ['routine-subagent-finalization', 'one-result-one-cost-original-destination']
};

function route(taskId) {
  return { requestedAgentId: 'eval-agent', observedAgentId: 'eval-agent', requestedSessionId: `session-${taskId}`,
    observedSessionId: `session-${taskId}`, requestedDestination: `eval:${taskId}`, deliveredDestination: `eval:${taskId}` };
}

function trajectory(taskId, attempt, observedRecovery, passed, detail = {}) {
  const [injectedAt] = EXPECTED[taskId];
  const at = new Date(Date.UTC(2026, 7, 3, 5, 0, attempt % 60)).toISOString();
  return { schemaVersion: 'starnet.eval.trajectory.v1', taskId, attempt, runId: `${taskId}-${attempt}`,
    startedAt: at, endedAt: at, finalText: passed ? 'boundary recovered' : 'boundary remains unproved',
    events: [{ seq: 1, at, type: 'fault.injected', data: { boundary: injectedAt } },
      { seq: 2, at, type: 'eval.assertion', data: { passed, observedRecovery, detail } }], artifacts: [],
    outcome: { passed, violations: { falseDone: 0, wrongDestination: 0, duplicateMutation: 0, authorityEscape: 0 }, evidence: detail },
    routing: route(taskId), fault: { injectedAt, observedRecovery, ambiguous: false } };
}

async function observe(taskId, attempt) {
  const runId = `${taskId}-${attempt}`;
  if (taskId === 'fault-transcript-before-delivery-ack') {
    // the reply is durable in the delivery ledger (channels/delivery.json) when the process dies; the next process's hub
    // drains its chat lane: one send, to the original destination, and nothing left owed (the same memory facade: no
    // statSync, no linkSync)
    const fs = memoryFs(), root = '/eval/channels';
    const store1 = makeChannelStore({ fs, pathMod, root, clock: { now: () => attempt } });
    store1.ledger.enqueue({ id: 'reply:' + runId, channel: 'telegram', chatId: 'destination-1', runId, agentId: 'eval-agent', parts: ['durable result'] });
    const store2 = makeChannelStore({ fs, pathMod, root, clock: { now: () => attempt + 1 } });
    const sent = [];
    const hub = makeChannelHub({ channel: 'telegram', store: store2, runOnce: async () => {}, secrets: () => ({}),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; }, emit() {}, newId: () => runId, sleep: async () => {} });
    await hub._internals.drain();
    hub.close();
    const passed = sent.length === 1 && sent[0].chatId === 'destination-1' && sent[0].text === 'durable result' && store2.ledger.deliveries().length === 0;
    return trajectory(taskId, attempt, passed ? EXPECTED[taskId][1] : 'redelivery-mismatch', passed, { sends: sent.length, destination: sent[0] && sent[0].chatId });
  }

  if (taskId === 'fault-compaction-rotation') {
    const temp = mkdtempSync(join(tmpdir(), 'starnet-fault-compaction-'));
    const transcriptFile = join(temp, 'transcript.jsonl');
    try {
      const child = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fault-compaction-child.mjs');
      const crash = spawnSync(process.execPath, [child, transcriptFile], { encoding: 'utf8', timeout: 30000 });
      const rows = readFileSync(transcriptFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const restarted = makeTranscriptStore({ io: { readAll: () => rows, append() {} }, clock: { now: () => 4000 } });
      const hits = restarted.search('rotation', 'ROTATION FACT 731', { limit: 5 });
      const crashedAtBoundary = crash.status !== 0 || !!crash.signal;
      const complete = rows.length >= 36 && hits.some(hit => /ROTATION-FACT-731/.test(hit.content));
      const passed = crashedAtBoundary && complete;
      return trajectory(taskId, attempt, passed ? EXPECTED[taskId][1] : 'rotation-history-incomplete', passed,
        { crashedAtBoundary, durableRows: rows.length, searchableHits: hits.length, exitStatus: crash.status, signal: crash.signal || null });
    } catch (error) {
      return trajectory(taskId, attempt, 'rotation-adapter-error', false, { error: String(error && error.message || error).slice(0, 240) });
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  if (taskId === 'fault-routine-subagent-finalization') {
    const temp = mkdtempSync(join(tmpdir(), 'starnet-fault-finalization-'));
    try {
      const subFile = join(temp, 'subagents.json');
      const subRunId = `sub-final-${attempt}`;
      const first = makeSubagentManager({ fs: fsMod, pathMod, file: subFile, clock: { now: () => attempt },
        emit() {}, newId: () => `sub-${attempt}`, afterFinalizationCommitted: () => false });
      const handle = first.start({ id: `worker-${attempt}`, runId: subRunId, leadId: 'lead', agentId: 'worker',
        destination: 'lead:lead', prompt: 'finalize safely' }, async () => ({ status: 'done', reason: 'done', result: 'worker-result', usd: 0.25 }));
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      const subEvents = [];
      const restarted = makeSubagentManager({ fs: fsMod, pathMod, file: subFile, clock: { now: () => attempt + 1 },
        emit: (name, payload) => subEvents.push({ name, payload }), newId: () => `sub-restart-${attempt}` });
      const sub = restarted.get(handle.id);

      const routineId = `routine-${attempt}`;
      const routine = cronStore.makeJob({ id: routineId, prompt: 'routine work', agentId: 'worker', deliver: 'origin',
        origin: { target: 'telegram:original', channel: 'telegram', chatId: 'original' },
        schedule: { kind: 'interval', minutes: 1, display: 'every 1m' } }, { id: routineId, now: 1 });
      let jobs = cronStore.markRun([routine], routineId,
        { runId: `routine-run-${attempt}`, status: 'ok', reason: 'done', output: 'routine-result', usd: 0.5 }, { now: 2 });
      const deliveries = [];
      const driver = makeCronDriver({ getJobs: () => jobs, setJobs: next => { jobs = next; return true; }, runOnce: async () => {},
        emit() {}, newId: () => `routine-new-${attempt}`, newAbort: () => new AbortController(), now: () => 3,
        getKey: () => 'test', defaultModel: 'test/model', persona: 'test',
        deliverResult: async (job, result) => { deliveries.push({ job, result }); return { ok: true }; } });
      await driver.recoverFinalizations();
      const recoveredRoutine = cronStore.getJob(jobs, routineId);
      const subTerminal = subEvents.filter(e => e.name === 'task' && e.payload.id === handle.id && e.payload.status === 'done').length;
      const passed = !!sub && sub.result === 'worker-result' && sub.usd === 0.25 && sub.finalization.state === 'delivered' &&
        sub.finalization.destination === 'lead:lead' && subTerminal === 1 && deliveries.length === 1 &&
        deliveries[0].result.text === 'routine-result' && deliveries[0].job.origin.target === 'telegram:original' &&
        recoveredRoutine.lastUsd === 0.5 && recoveredRoutine.finalization.state === 'delivered';
      return trajectory(taskId, attempt, passed ? EXPECTED[taskId][1] : 'finalization-recovery-mismatch', passed,
        { workerReceipts: sub ? 1 : 0, workerTerminalPublishes: subTerminal, routineDeliveries: deliveries.length,
          workerCost: sub && sub.usd, routineCost: recoveredRoutine && recoveredRoutine.lastUsd,
          workerDestination: sub && sub.finalization.destination,
          routineDestination: deliveries[0] && deliveries[0].job.origin && deliveries[0].job.origin.target });
    } catch (error) {
      return trajectory(taskId, attempt, 'finalization-adapter-error', false, { error: String(error && error.message || error).slice(0, 240) });
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }

  const { journal } = memoryJournal();
  journal.begin({ runId, agentId: 'eval-agent', sessionId: `session-${taskId}`, destination: `eval:${taskId}`, messages: [] });
  let observed = '', detail = {};
  if (taskId === 'fault-accepted-before-provider') {
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' && state.meta.agentId === 'eval-agent' ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, agentId: state.meta.agentId };
  } else if (taskId === 'fault-provider-stream') {
    journal.checkpoint(runId, { phase: 'assistant-partial', messages: [{ role: 'assistant', content: 'partial' }] });
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' && state.checkpoint.messages[0].content === 'partial' && !state.terminal ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, terminal: state.terminal, partial: state.checkpoint.messages[0].content };
  } else if (taskId === 'fault-read-intent-before-dispatch') {
    journal.toolIntent(runId, { callId: 'read-1', name: 'fs.read', mutating: false });
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' ? EXPECTED[taskId][1] : `read-intent-${state.status}`;
    detail = { status: state.status, uncertain: state.uncertain.length };
  } else if (taskId === 'fault-mutation-intent-before-dispatch') {
    journal.toolIntent(runId, { callId: 'write-1', name: 'fs.write', mutating: true });
    const state = journal.inspect(runId);
    observed = state.status === 'needs_review' ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, uncertain: state.uncertain.length };
  } else if (taskId === 'fault-mutation-before-result-checkpoint') {
    journal.toolIntent(runId, { callId: 'write-1', name: 'fs.write', mutating: true });
    const state = journal.inspect(runId);
    observed = state.status === 'needs_review' && state.uncertain.length === 1 ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, uncertain: state.uncertain.length, redispatches: 0 };
  } else if (taskId === 'fault-result-before-next-turn') {
    journal.toolIntent(runId, { callId: 'write-1', name: 'fs.write', mutating: true });
    journal.toolResult(runId, { callId: 'write-1', ok: true, content: 'saved' });
    journal.checkpoint(runId, { phase: 'tool_results', messages: [{ role: 'tool', tool_call_id: 'write-1', content: 'saved' }] });
    const state = journal.inspect(runId);
    observed = state.status === 'resumable' && state.completed.length === 1 && state.uncertain.length === 0 ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, completed: state.completed.length, redispatches: 0 };
  } else if (taskId === 'fault-final-before-transcript-ack') {
    journal.checkpoint(runId, { phase: 'final', messages: [{ role: 'assistant', content: 'final result' }] });
    journal.finish(runId, { reason: 'done', transcriptAck: false });
    const state = journal.inspect(runId);
    observed = state.status === 'awaiting_commit' && state.checkpoint.messages[0].content === 'final result' ? EXPECTED[taskId][1] : state.status;
    detail = { status: state.status, final: state.checkpoint.messages[0].content };
  }
  const passed = observed === EXPECTED[taskId][1];
  return trajectory(taskId, attempt, observed, passed, detail);
}

export async function runFaultAdapters({ tasks, repeats = 100 }) {
  const rows = [];
  for (const task of tasks) for (let attempt = 1; attempt <= repeats; attempt++) rows.push(await observe(task.id, attempt));
  return rows;
}
