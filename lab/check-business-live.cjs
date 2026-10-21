'use strict';
// Real Go model calls, but explicitly synthetic input and never eligible for external approval.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { client } = require('./business-client.cjs');
async function main(args) {
  if (!args.includes('--live-models')) throw new Error('Explicit --live-models is required');
  const request = await client(), before = await request('/api/colony');
  if (Object.values(before.tasks).some(t => t.activeAttempt)) throw new Error('A business run is active');
  const source = fs.readFileSync(path.resolve(__dirname, '../docs/ColonyDocs/Colony-OS-Business-Prozesse.md'), 'utf8');
  const start = source.indexOf('### Bestätigter Bestand und Ziel');
  const excerpt = source.slice(start, source.indexOf('### L01', start));
  const created = await request('/api/colony/command', { type: 'task.create', expectedRevision: before.revision, businessUnitId: 'lifestruct', processId: 'L01', testOnly: true,
    goal: 'Technischer Abnahmetest, kein Geschäftsauftrag: Erstelle genau einen deutschsprachigen Test-Pin über KI, Alltagsstruktur und Ziele. Keine Gewichts-/Gesundheitsversprechen. Keine Veröffentlichung. Nutze ausschließlich die dokumentierten Fakten; die Ziel-URL und das Board sind ausdrücklich Testdaten. Gib sofort genau ein gültiges JSON-Objekt aus. Keine Werkzeuge, keine Rückfrage, keine Erklärungen außerhalb des JSON.',
    account: 'lab-verification-only', audience: 'Einsteiger, die ihren Alltag mit KI strukturieren möchten', schedule: 'Kein Versand, keine Veröffentlichung; isolierter Lab-Test',
    sources: [{ id: 'doc-business', businessUnitId: 'lifestruct', confirmed: true, uri: 'docs/ColonyDocs/Colony-OS-Business-Prozesse.md', asOf: '2026-10-18', version: '2026-10-18', excerpt }],
    targets: [{ url: 'https://example.org/guide', promise: 'Synthetische Test-Zielseite, keine echte Lifestruct-Seite. Aussagen nur zu den bestätigten Business-Fakten.' }], boards: ['Testboard – nicht verbunden'], inputs: { pinCount: 1, visualGuidelines: 'Lesbarer redaktioneller Text-Pin auf Deutsch. Keine Fotos, keine fremden Assets. Bestätigte Vorlage, kein Upload.' }, budget: { usd: 0, tokens: 250000, ms: 1200000 }, maxRevisions: 3 });
  const outcome = await request('/api/colony/run', { expectedRevision: created.revision, taskId: created.result.id, reserve: { usd: 0, tokens: 48000, ms: 180000 } });
  const task = outcome.result;
  const after = await request('/api/colony');
  if (!task.testOnly || after.inbox.some(item => item.taskId === task.id) || after.externalActionsEnabled !== false) throw new Error('Test-only job leaked into approval/external-action scope');
  let testOnlyApprovalRefused = false;
  try { await request('/api/colony/command', { type: 'approval.decide', expectedRevision: after.revision, taskId: task.id, digest: '0'.repeat(64), decision: 'approve', pinIds: ['lifestruct-test-pin-001'], actions: ['publish'] }); }
  catch (error) { testOnlyApprovalRefused = /TECHNICAL_TEST_NOT_APPROVABLE/.test(error.message); }
  if (!testOnlyApprovalRefused) throw new Error('Test-only job was not fenced from operator approval');
  const report = { taskId: task.id, processId: task.processId, processVersion: task.processVersion, contractVersion: task.contractVersion, testOnly: task.testOnly, status: task.status, reason: task.reason,
    facts: task.facts, pins: task.pins, factReconciliations: task.factReconciliations || [], steps: task.attempts.map(a => ({ role: a.stepId, state: a.state, tokens: a.usage?.tokens, usd: a.usage?.usd, error: a.error })),
    tokens: task.spent.tokens, usdUnknown: task.spent.usdUnknown, review: task.review && { passed: task.review.passed, dimensions: task.review.dimensions, findings: task.review.findings }, artifacts: task.artifacts, operatorApproval: false, externalActions: false, testOnlyApprovalRefused };
  const out = path.resolve(__dirname, '../output/business-functional'); fs.mkdirSync(out, { recursive: true });
  const image = task.artifacts.find(a => a.mime === 'image/png');
  if (image) {
    const source = path.resolve(__dirname, '../.lab-state/workspaces/colony/artifacts', image.sha256 + '.png'), bytes = fs.readFileSync(source);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('Test image digest mismatch');
    fs.copyFileSync(source, path.join(out, 'lifestruct-test-pin.png'));
  }
  fs.writeFileSync(path.join(out, 'live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (task.status !== 'ready_for_approval') process.exitCode = 1;
  return report;
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
