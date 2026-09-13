import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const rows = JSON.parse(fs.readFileSync('qa/seam-audit-0912/bug-map.json', 'utf8'));
const evidence = {
  A1: ['test/returnstore-recovery.test.js', 'Closed intervals survive failed reads, restart and failed persistence; attended work is excluded. Live recovery fixture passed.'],
  A2: ['test/model-loop-control.test.js and test/loopjob-driver.test.js', 'Pause, Stop and Remove settle through the host driver and survive late resolution/rejection. Replacement and durable retry behavior covered by driver tests.'],
  A3: ['test/seam-audit-recovery.http.test.js', 'Local delivery with follow-up captures the session; create/update validation rejects a missing origin. Live UI save and sidecar restart read-back passed.'],
  A4: ['test/seam-audit-recovery.http.test.js', 'Routine and goal-loop forms omit the implicit station-provider override. UI and HTTP persistence retain null for agent-provider inheritance. Paid multi-provider dispatch was not tested.'],
  A5: ['qa/seam-audit-0912/repair-ui-observations.json', 'Final-source live UI retained the rejection editor, text and focus across polls and changed relative timestamps. Unchanged rows keep their DOM identity.'],
  A6: ['qa/seam-audit-0912/repair-ui-observations.json', 'Final-source live HTTP 409 showed the refusal, preserved the review draft and left Pause available. Controls check acknowledgements, fence stale reads and bound the pending wait.'],
  A7: ['test/transcript.test.js, test/transcript-history-v2.test.js and test/seam-audit-recovery.http.test.js', 'Run attribution is filtered before limiting across memory, segmented history and HTTP restart. Live Outbox loaded one matching transcript only on expansion.'],
  A8: ['test/settings-save-failure.test.js', 'Real UI storage exception produced an unsaved warning; restored storage showed saved and survived reload. Independent OS settings acknowledgements stay independent.'],
  A9: ['test/queryspine.test.js', 'New generation recovers while an old JSON request is stalled; obsolete timeout cannot overwrite the recovered value. Ordinary JSON GET parsing is deadline-bounded.']
};
for (const row of rows) {
  if (!fs.readFileSync(row.file, 'utf8').includes('lane: agent/seam-audit-0912-b')) throw new Error('Not an owned finding: ' + row.file);
  const [test, detail] = evidence[row.id];
  const result = spawnSync(process.execPath, ['scripts/qa/bugs.mjs', '--set', row.fingerprint,
    '--status', 'fixed', '--fix', 'b54b44574', '--regression', test,
    '--verdict', detail + ' Evidence: ' + test + '. See qa/seam-audit-0912/REPAIR.md for final gate receipts and exact scope. Source repaired; installer and affected-customer recovery remain unverified.'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  console.log(row.id + ' ' + row.fingerprint + ': source fixed');
}
for (const args of [['--index', '--write'], ['--validate']]) {
  const result = spawnSync(process.execPath, ['scripts/qa/bugs.mjs', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  console.log((result.stdout + result.stderr).trim());
}
