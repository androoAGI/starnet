/* Frozen source control from d5024f5a2:frontend/app/chat.js. Do not edit the function. */
'use strict';
module.exports = function mergeCanonicalHistory(local, turns) {
    // Only the canonical final row can supersede saved prose, and only by explicit run identity.
    const finals = new Map(), finalSlots = new Map();
    const sameRun = (a, b) => !!a.sourceRunId && String(a.sourceRunId) === String(b.sourceRunId)
      && (!a.agentId || !b.agentId || a.agentId === b.agentId)
      && (!a.streamId || !b.streamId || a.streamId === b.streamId);
    const withFinal = (prior, canonical) => {
      const row = Object.assign({}, prior, canonical);
      // A rejected attempt's failure flags are evidence, not the accepted answer's status.
      // In particular, error:true would exclude this accepted answer from the next model turn.
      const supersededStatus = Object.assign({}, prior.supersededStatus, canonical.supersededStatus);
      for (const key of ['error', 'stopped', 'stopNote']) {
        if (prior[key] != null) supersededStatus[key] = prior[key];
        delete row[key];
        if (Object.prototype.hasOwnProperty.call(canonical, key)) row[key] = canonical[key];
      }
      if (Object.keys(supersededStatus).length) row.supersededStatus = supersededStatus;
      if (canonical.taint || prior.taint) row.taint = canonical.taint || prior.taint;
      const attachments = [], seen = new Set();
      for (const item of [].concat(prior.attachments || [], canonical.attachments || [])) {
        const key = JSON.stringify(item);
        if (!seen.has(key)) { seen.add(key); attachments.push(item); }
      }
      if (attachments.length) row.attachments = attachments;
      return row;
    };
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (turn && !turn.sys && turn.role === 'assistant' && turn.dispatchState === 'final'
          && turn.sourceRunId && String(turn.content || '').trim() && !finals.has(String(turn.sourceRunId))) finals.set(String(turn.sourceRunId), turn);
    }
    const runParts = new Map();
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!turn || turn.role !== 'assistant' || !turn.sourceRunId) continue;
      const text = String(turn.content || '');
      if (!text.trim()) continue;
      const parts = runParts.get(String(turn.sourceRunId)) || [];
      parts.push(text); runParts.set(String(turn.sourceRunId), parts);
    }
    /* EXPLICIT RUN IDENTITY, HARNESS BYTES ASIDE (rc walk 2026-10-14: a reload showed a reply twice — its durable turns AND
       the page's saved aggregate). The page's aggregate of a run differs from that run's durable turns only by what the
       harness itself adds or removes: the paragraph break streamed after a hidden Task Brief step (loop.js TURN BREAK) and
       the choice marker the chat strips before saving. Only for a row that names its run (an unattributed one stays exact).
       Self-contained (the phone runs this same function): the marker rule is fork.js's — a list number, keyword (MARKER_KEY's
       one case rule), colon, `||` options. */
    const squash = s => String(s == null ? '' : s).replace(/(?:\d{1,2}[.)][ \t]*)?[*_`~]*(?:\bF(?:ORK|ork)|[Tt][Aa][Ss][Kk]_[Qq][Uu][Ee][Ss][Tt][Ii][Oo][Nn])[*_`~]*[ \t]*:[^\n]*\|\|[^\n]*/g, '').replace(/\s+/g, '');
    // A steering note folded mid-run streams into the local reply as a '\n[steering] …\n' line, but the durable
    // transcript stores only the model's own turns. Twins are matched WITHOUT those lines; the local row (which
    // still carries them, so a reload can redraw the note) is the one that survives.
    const steerless = text => String(text || '').replace(/(?:^|\n)\[steering\] [^\n]*\n?/g, '');
    const hasSteer = text => /(?:^|\n)\[steering\] /.test(String(text || ''));
    // the [start, end] run of contiguous parts that joins to exactly `text`, or null
    const joinsTo = (parts, text) => {
      for (let start = 0; start < parts.length - 1; start++) {
        if (!text.startsWith(parts[start])) continue;
        let joined = parts[start];
        for (let end = start + 1; end < parts.length; end++) {
          joined += parts[end];
          if (joined === text) return [start, end];
          if (joined.length >= text.length) break;
        }
      }
      return null;
    };
    // the durable parts this saved aggregate already shows (so a steered row can be enriched by them), or null.
    // A rowId marks a durable row — except on a steered row: the merge that kept it lent it its first part's rowId, and that
    // save is the next load's input (the desk's next open, the phone's every read), so it must find its span again each load.
    const committedAggregate = (row, runId, explicit) => {
      if (row.role !== 'assistant' || (row.rowId && !hasSteer(row.content)) || row.stopped || row.error || (row.attachments && row.attachments.length)) return null;
      const parts = runParts.get(runId) || [], text = steerless(row.content);
      let span = joinsTo(parts, text);
      if (!span && explicit) { const target = squash(text); span = target ? joinsTo(parts.map(squash), target) : null; }
      return span ? parts.slice(span[0], span[1] + 1) : null;
    };
    const kept = [], buckets = new Map();
    let userRunId = '';
    for (let row of Array.isArray(local) ? local : []) {
      if (row && row.sys) { if (!row.transcriptPending) kept.push({ row, key: null }); continue; }
      if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;
      const final = row.role === 'assistant' && finals.get(String(row.sourceRunId || ''));
      if (final && sameRun(row, final)) {
        const id = String(final.sourceRunId);
        if (finalSlots.has(id)) {
          const keptRow = kept[finalSlots.get(id)];
          keptRow.row = withFinal(row, keptRow.row);
          continue;
        }
        row = withFinal(row, final);
        finalSlots.set(id, kept.length);
      }
      if (row.role === 'user') userRunId = String(row.sourceRunId || '');
      const aggregate = committedAggregate(row, String(row.sourceRunId || userRunId), !!row.sourceRunId);
      if (aggregate && !hasSteer(row.content)) continue;
      if (aggregate) {   // keep the steered row: each durable part it already shows enriches it instead of re-inserting
        for (const part of aggregate) { const k = 'assistant\u0000' + part, q = buckets.get(k) || []; q.push(kept.length); buckets.set(k, q); }
        kept.push({ row, key: null });
        continue;
      }
      if (row.role === 'assistant' && !String(row.content == null ? '' : row.content).trim()) continue;
      const key = row.role + '\u0000' + (row.role === 'assistant' ? steerless(row.content) : String(row.content || ''));
      const q = buckets.get(key) || []; q.push(kept.length); buckets.set(key, q);
      kept.push({ row, key });
    }
    const internalTranscriptPrompt = text => /^Shared conversation context \(/.test(text) || /^\[BEGIN EXTERNAL SCREEN CAPTURE/.test(text);
    const inserts = new Map();
    let anchor = -1;
    for (const turn of Array.isArray(turns) ? turns : []) {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) continue;
      const content = String(turn.content == null ? '' : turn.content);
      if (turn.role === 'assistant' && !content.trim()) continue;
      const key = turn.role + '\u0000' + content;
      const q = buckets.get(key), authoritative = turn.role === 'assistant' && turn.dispatchState === 'final' && finals.get(String(turn.sourceRunId || '')) === turn;
      // A matching sentence from another run must never acquire this dispatch's identity.
      const at = q ? q.findIndex(i => authoritative ? sameRun(kept[i].row, turn)
        : finalSlots.get(String(kept[i].row.sourceRunId || '')) !== i) : -1;
      const idx = at >= 0 ? q.splice(at, 1)[0] : -1;
      if (idx >= 0) {
        const prior = kept[idx].row;
        kept[idx].row = authoritative ? withFinal(prior, turn) : Object.assign({}, turn, prior, { role: turn.role, content: hasSteer(prior.content) ? prior.content : content, ts: turn.ts != null ? turn.ts : prior.ts });
        anchor = idx;
        continue;
      }
      if (turn.role === 'user' && internalTranscriptPrompt(content)) continue;
      const list = inserts.get(anchor) || []; list.push(Object.assign({}, turn, { role: turn.role, content })); inserts.set(anchor, list);
    }
    const merged = [];
    for (const turn of inserts.get(-1) || []) merged.push(turn);
    for (let i = 0; i < kept.length; i++) {
      merged.push(kept[i].row);
      const list = inserts.get(i) || [], run = String(kept[i].row.sourceRunId || '');
      /* A RUN KEEPS ITS OWN STATION ROWS (SEND NOW reload lane, 2026-10-14): a reload mid-run saves no copy of that run's
         directive, so the transcript inserts it here, after the last row it matched — which put the NEXT run's directive
         between an earlier run and the steer echo filed for it. This row's run gets its own inserted turns first, then
         the station rows of the same run that follow it, then everyone else's. */
      let k = 0;
      if (run) while (k < list.length && String(list[k].sourceRunId || '') === run) merged.push(list[k++]);
      while (run && k < list.length && i + 1 < kept.length && kept[i + 1].row.sys && String(kept[i + 1].row.sourceRunId || '') === run && !(inserts.get(i + 1) || []).length) merged.push(kept[++i].row);
      for (; k < list.length; k++) merged.push(list[k]);
    }
    return merged;
  };
