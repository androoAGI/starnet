#!/usr/bin/env node
/**
 * Contextual task memory is the folder hierarchy:
 *   memory/context-task/contexts/<context-id>/CONTEXT.md
 *   memory/context-task/contexts/<context-id>/tasks/<task-id>/TASK.md
 * A task belongs to the context folder that contains it.
 * Each link stores a relative path and the SHA-256 of the target bytes.
 *
 * Human identity is two checks (the assigned factors):
 *   1. identity.json names Hakeem Moore as sole-human-approver
 *   2. SHA-256 of identity.json matches IDENTITY-SHA256.txt
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] || 'D:\\AML_University_Training_Hospital');
const problems = [];
function fail(m) { problems.push(m); }

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function read(p) { return readFileSync(p); }

const identityPath = join(ROOT, 'governance', 'human-authority', 'identity.json');
const digestPath = join(ROOT, 'governance', 'human-authority', 'IDENTITY-SHA256.txt');
if (!existsSync(identityPath) || !existsSync(digestPath)) {
  fail('human identity record is missing');
} else {
  const identity = JSON.parse(read(identityPath).toString('utf8'));
  const digest = read(digestPath).toString('utf8').trim().toLowerCase();
  const actual = sha256(read(identityPath));
  if (identity.legalName !== 'Hakeem Moore') fail('identity name is not Hakeem Moore');
  if (identity.role !== 'sole-human-approver') fail('identity role is not sole-human-approver');
  if (!Array.isArray(identity.factors) || identity.factors.join(',') !== 'named-human,record-sha256') {
    fail('identity factors are not the assigned pair');
  }
  if (actual !== digest) fail('identity SHA-256 does not match IDENTITY-SHA256.txt');
}

const contextsDir = join(ROOT, 'memory', 'context-task', 'contexts');
if (!existsSync(contextsDir)) fail('context-task hierarchy is missing');
else {
  for (const contextId of readdirSync(contextsDir)) {
    const contextDir = join(contextsDir, contextId);
    if (!statSync(contextDir).isDirectory()) continue;
    const contextMd = join(contextDir, 'CONTEXT.md');
    const contextJsonPath = join(contextDir, 'context.json');
    if (!existsSync(contextMd) || !existsSync(contextJsonPath)) {
      fail(contextId + ' is missing CONTEXT.md or context.json');
      continue;
    }
    const contextJson = JSON.parse(read(contextJsonPath).toString('utf8'));
    if (contextJson.contextId !== contextId) fail(contextId + ' folder name does not match contextId');
    if (contextJson.humanApprover !== 'Hakeem Moore') fail(contextId + ' approver is not Hakeem Moore');
    const contextHash = sha256(read(contextMd));
    if (contextJson.contextSha256 !== contextHash) fail(contextId + ' CONTEXT.md hash drifted');
    const tasksDir = join(contextDir, 'tasks');
    if (!existsSync(tasksDir)) continue;
    for (const taskId of readdirSync(tasksDir)) {
      const taskDir = join(tasksDir, taskId);
      if (!statSync(taskDir).isDirectory()) continue;
      const taskMd = join(taskDir, 'TASK.md');
      const taskJsonPath = join(taskDir, 'task.json');
      if (!existsSync(taskMd) || !existsSync(taskJsonPath)) {
        fail(taskId + ' is missing TASK.md or task.json');
        continue;
      }
      const parentContext = dirname(dirname(taskDir));
      if (resolve(parentContext) !== resolve(contextDir)) fail(taskId + ' is not inside its context folder');
      const taskJson = JSON.parse(read(taskJsonPath).toString('utf8'));
      if (taskJson.taskId !== taskId) fail(taskId + ' folder name does not match taskId');
      if (taskJson.contextId !== contextId) fail(taskId + ' contextId does not match its parent folder');
      if (taskJson.humanApprover !== 'Hakeem Moore') fail(taskId + ' approver is not Hakeem Moore');
      if (existsSync(digestPath) && taskJson.humanIdentitySha256 !== read(digestPath).toString('utf8').trim().toLowerCase()) {
        fail(taskId + ' is not linked to the human identity digest');
      }
      if (sha256(read(taskMd)) !== taskJson.taskSha256) fail(taskId + ' TASK.md hash drifted');
      for (const link of taskJson.links || []) {
        const target = resolve(taskDir, link.path);
        if (!existsSync(target)) { fail(taskId + ' broken link ' + link.path); continue; }
        if (sha256(read(target)) !== link.sha256) fail(taskId + ' link hash drifted ' + link.path);
        const rel = relative(taskDir, target);
        if (rel !== link.path.replace(/\//g, '\\') && rel !== link.path) {
          fail(taskId + ' link path is not the relative hierarchy path ' + link.path);
        }
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error('FAIL ' + p);
  process.exit(1);
}
console.log('context-task linkage OK for ' + ROOT);
