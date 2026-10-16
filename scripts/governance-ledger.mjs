#!/usr/bin/env node
/**
 * Append-only hash chain for Agents University policy changes.
 * changes.csv mirrors chain.jsonl. A decision stays HANDOFF_PENDING
 * until a later human-approval block names it. That block is not written here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const GENESIS = '0'.repeat(64);
const ENTRY_KEYS = ['index', 'timestamp', 'kind', 'scope', 'decisionId', 'summary', 'paths', 'humanApprover', 'approval', 'prevSha256'];

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function entryHash(entry) {
  const body = {};
  for (const key of ENTRY_KEYS) body[key] = entry[key];
  return sha256(Buffer.from(JSON.stringify(body), 'utf8'));
}

export function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

export function changesCsv(entries) {
  const header = 'index,timestamp,decision_id,kind,scope,summary,approval,human_approver,prev_sha256,entry_sha256';
  const rows = entries.map(e => [
    e.index, e.timestamp, e.decisionId, e.kind, e.scope, e.summary, e.approval, e.humanApprover, e.prevSha256, e.entrySha256
  ].map(csvCell).join(','));
  return [header, ...rows, ''].join('\n');
}

export function verifyLedger(root) {
  const problems = [];
  const chainPath = join(root, 'governance', 'ledger', 'chain.jsonl');
  const csvPath = join(root, 'governance', 'ledger', 'changes.csv');
  const decisionsCsv = join(root, 'governance', 'decisions', 'decisions.csv');
  if (!existsSync(chainPath)) return ['ledger chain is missing'];
  const lines = readFileSync(chainPath, 'utf8').split(/\n/).filter(Boolean);
  const entries = lines.map((line, i) => {
    try { return JSON.parse(line); }
    catch (e) { problems.push('chain line ' + i + ' is not JSON'); return null; }
  }).filter(Boolean);
  let prev = GENESIS;
  const approved = new Set();
  for (const entry of entries) {
    if (entry.prevSha256 !== prev) problems.push('block ' + entry.index + ' does not follow the previous hash');
    if (entry.entrySha256 !== entryHash(entry)) problems.push('block ' + entry.index + ' hash does not match its body');
    if (entry.humanApprover !== 'Hakeem Moore') problems.push('block ' + entry.index + ' approver is not Hakeem Moore');
    if (entry.approval !== 'HANDOFF_PENDING' && entry.approval !== 'APPROVED') problems.push('block ' + entry.index + ' has an unknown approval');
    if (entry.scope !== 'university' && entry.scope !== 'starnet-for-university') problems.push('block ' + entry.index + ' is outside the university scope');
    if (entry.kind === 'human-approval') {
      if (entry.approval !== 'APPROVED') problems.push('human-approval block ' + entry.index + ' is not marked APPROVED');
      approved.add(entry.decisionId);
    }
    const decisionJson = join(root, 'governance', 'decisions', entry.decisionId + '.json');
    const decisionMd = join(root, 'governance', 'decisions', entry.decisionId + '.md');
    if (!existsSync(decisionJson) || !existsSync(decisionMd)) problems.push(entry.decisionId + ' is missing its decision folder files');
    prev = entry.entrySha256;
  }
  for (const entry of entries) {
    if (entry.kind === 'policy-change' && entry.approval === 'APPROVED' && !approved.has(entry.decisionId)) {
      problems.push(entry.decisionId + ' says APPROVED without a human-approval block');
    }
  }
  if (existsSync(csvPath) && readFileSync(csvPath, 'utf8') !== changesCsv(entries)) problems.push('changes.csv does not match the chain');
  else if (!existsSync(csvPath)) problems.push('changes.csv is missing');
  if (!existsSync(decisionsCsv)) problems.push('decisions.csv is missing');
  return problems;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()) === false
  ? false
  : process.argv[1] && import.meta.url.replace('file:///', '').replace(/\//g, '\\').toLowerCase().endsWith(process.argv[1].toLowerCase().replace(/\//g, '\\'));

if (isMain || process.argv[1]?.endsWith('verify-governance-ledger.mjs') || process.argv[1]?.endsWith('governance-ledger.mjs')) {
  const root = resolve(process.argv[2] || 'D:\\AML_University_Training_Hospital');
  const problems = verifyLedger(root);
  if (problems.length) {
    for (const p of problems) console.error('FAIL ' + p);
    process.exit(1);
  }
  console.log('governance ledger OK for ' + root);
}
