/* A line carries the producer's terminal work, verdict and exact produced files. File paths here have already
   been proved by the host's RunPaths.locateProduced seam; this pure ledger grants no filesystem authority. */
'use strict';
const Verdict = require('./verdict.js');
const MAX_FILES = 64;
function mergeFiles(...lists) {
  const out = [], seen = new Set();
  for (const list of lists) for (const file of (Array.isArray(list) ? list : [])) {
    if (typeof file !== 'string' || !file || seen.has(file)) continue;
    if (out.length === MAX_FILES) return out;
    seen.add(file); out.push(file);
  }
  return out;
}
function productOf(value, fallback) {
  const v = value || {}, f = fallback || {}, text = String(v.text == null ? '' : v.text);
  return { text, files: mergeFiles(v.files), endReason: v.endReason || v.reason || null, outcome: v.outcome || null,
    verdict: Object.prototype.hasOwnProperty.call(v, 'verdict') ? v.verdict : (f.getVerdict || Verdict.parseVerdict)(text),
    draft: String(v.draft == null ? (f.draft == null ? '' : f.draft) : v.draft), runId: v.runId || null };
}
module.exports = { MAX_FILES, mergeFiles, productOf };
