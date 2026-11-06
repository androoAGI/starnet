/* frontend/app/turnmerge.js — the page's turn ids and shared station-cache merge (turn-identity).

   Pure, UMD (TurnKinds and ApiTicket's byte-tested SHA-256): the desk (chat.js), its website mirror and the tests load the SAME module, so the
   page holds no id logic of its own. No clock, no randomness: a mint takes an injected rng, a send an injected `now`.
   The station's keyed rows are authoritative. Unmatched local rows survive unless an explicit forget/retract proof
   removes them; only a completed answer of the same turn replaces a provisional reply. legacyMerge preserves the
   previous algorithm verbatim for older stations and the rollback modes. Reconcile owns the optional redaction IO.

     pendingRow(row, rng)                    the optimistic user row, named: a fresh turnId (TurnKinds.mintTurnId) and a
                                             page-only turnAt = the row's own ts at push (a merge may later rewrite ts,
                                             never turnAt). A row that already holds a valid turnId is returned as is
     newTurnId(rng)                          a turnId for a turn with no row of its own (a work-line hop)
     sendIds(rows, { retry, retryRow, now }) the ids a send posts: { turnId, retryOf (a retry only), turnAt + clientNow (the
                                             row's own turnAt, never ts, and the client's clock now), turnRowId (the bound
                                             directive's rowId) }; {} for a row without a turnId (an older row keeps the
                                             legacy retry path)
     bindStart(rows, start, runId, sent)     binds the run.start echo { turnId, directiveRowId } to the user row this send
                                             named (sent.turnId): sets its sourceRunId (when missing) and directive rowId
                                             (when missing), and re-keys it to a differing echoed turnId while it has no
                                             rowId (the station answered it as a new turn). Mutates only that row. A send
                                             that named no turn (a recovery continuation) binds nothing.
                                             -> { index, rekeyed, turnId }: turnId = the turn the run answers (the echo,
                                             else the sent one)
     ofTurn(row, { turnId, sourceRunId })    a copy of a reply / partial / stopped / hop row naming its turn and run (a
                                             field the row already holds is kept)
     deliverableOf(row)                      the one adapter from a canonical file row to the page's deliverable record
                                             { title, kind, runId, t, agentId, root, rowId }; null for anything else
     splitSteer(rows)                        a reply that embeds '[steering] ' lines (the trunk save shape) becomes, in place, its prose parts
                                             as assistant messages and each note a user '[steering] <note>' message; windowRows applies it
                                             everywhere but window:'legacy' (the rollback window keeps today's bytes) */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./turnkinds.js'), require('./apiticket.js').sha256Text);
  else { root.TurnMerge = factory(root.TurnKinds, root.ApiTicket.sha256Text); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TurnKinds, sha256) {
  'use strict';

  const isSafeNonNeg = v => Number.isSafeInteger(v) && v >= 0;
  const isRowId = v => Number.isSafeInteger(v) && v > 0;
  const isUser = r => !!r && typeof r === 'object' && r.role === 'user';

  function pendingRow(row, rng) {
    if (!row || typeof row !== 'object') return row;
    if (TurnKinds.isTurnId(row.turnId)) return row;
    const out = Object.assign({}, row, { turnId: TurnKinds.mintTurnId(rng) });
    if (isSafeNonNeg(row.ts) && out.turnAt === undefined) out.turnAt = row.ts;
    return out;
  }

  function newTurnId(rng) { return TurnKinds.mintTurnId(rng); }

  function lastUser(rows) {
    const list = Array.isArray(rows) ? rows : [];
    for (let i = list.length - 1; i >= 0; i--) if (isUser(list[i])) return list[i];
    return null;
  }

  function sendIds(rows, opts) {
    const o = opts || {};
    const row = isUser(o.retryRow) ? o.retryRow : lastUser(rows);
    if (!row || !TurnKinds.isTurnId(row.turnId)) return {};
    const out = { turnId: row.turnId };
    if (o.retry) out.retryOf = row.turnId;
    if (isSafeNonNeg(row.turnAt) && isSafeNonNeg(o.now)) { out.turnAt = row.turnAt; out.clientNow = o.now; }
    if (isRowId(row.rowId)) out.turnRowId = row.rowId;
    return out;
  }

  function bindStart(rows, start, runId, sent) {
    const echoed = start && TurnKinds.isTurnId(start.turnId) ? start.turnId : '';
    const named = sent && TurnKinds.isTurnId(sent.turnId) ? sent.turnId : '';
    const result = { index: -1, rekeyed: false, turnId: echoed || named };
    const list = Array.isArray(rows) ? rows : [];
    if (!named) return result;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!isUser(list[i]) || list[i].turnId !== named) continue;
      const row = list[i];
      result.index = i;
      if (echoed && echoed !== row.turnId && !isRowId(row.rowId)) { row.turnId = echoed; result.rekeyed = true; }
      if (runId && !row.sourceRunId) row.sourceRunId = String(runId);
      if (start && isRowId(start.directiveRowId) && !isRowId(row.rowId) && row.turnId === echoed) row.rowId = start.directiveRowId;
      return result;
    }
    return result;
  }

  function ofTurn(row, ids) {
    if (!row || typeof row !== 'object') return row;
    const i = ids || {};
    const out = Object.assign({}, row);
    if (out.turnId === undefined && TurnKinds.isTurnId(i.turnId)) out.turnId = i.turnId;
    if (!out.sourceRunId && i.sourceRunId) out.sourceRunId = String(i.sourceRunId);
    return out;
  }

function legacyMerge(local, turns) {
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
  }

  const MERGE_FIELDS = new Set(['rowId', 'streamId', 'idFrom', 'supersededStatus', 'typedText']);
  const PRESENTATION = ['stopNote', 'projectRoot', 'supersededStatus'];
  const textOf = r => String(r && r.content != null ? r.content : '');
  const objectRow = r => !!r && typeof r === 'object' && !Array.isArray(r);
  const dialogue = r => objectRow(r) && !r.sys && !r.error && !r.stopped && !r.steerEcho && !r.foreign && !r.truncated && (r.role === 'user' || r.role === 'assistant');
  const hasTurn = r => !!r && TurnKinds.isTurnId(r.turnId);
  const runOf = r => String(r && r.sourceRunId || '');
  const streamOf = (r, fallback) => String(r && r.streamId || fallback || '');
  const keyOf = (r, fallback) => r && isRowId(r.rowId) ? JSON.stringify([streamOf(r, fallback), r.rowId]) : '';
  const legacyRow = r => objectRow(r) && !isRowId(r.rowId) && !hasTurn(r) && !runOf(r);

  function localKind(row) {
    if (!objectRow(row)) return 'legacy';
    if (row.foreign) return 'foreign';
    if (row.steerEcho) return 'steerEcho';
    if (row.truncated) return 'truncated';
    if (row.error || row.stopped) return 'error';
    if (row.sys || row.role === 'system') return 'sys';
    if (isUser(row) && hasTurn(row) && !isRowId(row.rowId)) return 'pending';
    return legacyRow(row) ? 'legacy' : 'dialogue';
  }

  function idsOf(row) {
    const out = {};
    if (!objectRow(row)) return out;
    if (isRowId(row.rowId)) out.rowId = row.rowId;
    if (row.streamId) out.streamId = String(row.streamId);
    if (hasTurn(row)) out.turnId = row.turnId;
    if (row.sourceRunId) out.sourceRunId = String(row.sourceRunId);
    if (TurnKinds.isKind(row.kind)) out.kind = row.kind;
    return out;
  }

  function stationRow(turn) { return objectRow(turn) ? Object.assign({}, turn, idsOf(turn)) : turn; }

  // Save histories compare values, independent of object property insertion order. Only fields acquired by a
  // merge are ignored on the fallback rung; two assistant parts sharing a turn still remain distinct rows.
  function equalValue(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return Number.isNaN(a) && Number.isNaN(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => equalValue(v, b[i]));
    const ak = Object.keys(a).filter(k => a[k] !== undefined), bk = Object.keys(b).filter(k => b[k] !== undefined);
    return ak.length === bk.length && ak.every(k => Object.prototype.hasOwnProperty.call(b, k) && equalValue(a[k], b[k]));
  }
  function sameTurn(a, b) {
    if (a === b) return true;
    if (!objectRow(a) || !objectRow(b)) return equalValue(a, b);
    const trusted = a.idFrom !== 'collision' && b.idFrom !== 'collision';
    if (trusted && isRowId(a.rowId) && isRowId(b.rowId)) return keyOf(a) === keyOf(b);
    if (trusted && isUser(a) && isUser(b) && dialogue(a) && dialogue(b) && hasTurn(a) && a.turnId === b.turnId) return true;
    const withoutMerge = row => Object.fromEntries(Object.entries(row).filter(([k]) => !MERGE_FIELDS.has(k)));
    return equalValue(withoutMerge(a), withoutMerge(b));
  }

  function attachmentsOf(a, b) {
    const out = [], seen = new Set();
    for (const item of [].concat(a || [], b || [])) {
      if (!item || typeof item !== 'object') continue;
      const key = item.id ? 'id:' + item.id : item.path ? 'path:' + item.path : JSON.stringify(item);
      if (!seen.has(key)) { seen.add(key); out.push(item); }
    }
    return out;
  }
  function presentation(target, local) {
    const out = Object.assign({}, target);
    for (const field of PRESENTATION) if (local[field] !== undefined && out[field] === undefined) out[field] = local[field];
    const atts = attachmentsOf(target.attachments, local.attachments);
    if (atts.length) out.attachments = atts;
    return out;
  }
  function statusOf(row) {
    const out = Object.assign({}, row.supersededStatus);
    for (const k of ['error', 'stopped', 'stopNote']) if (row[k] !== undefined) out[k] = row[k];
    return out;
  }
  function groupMatches(a, b, stream) {
    if (streamOf(a, stream) !== streamOf(b, stream)) return false;
    return hasTurn(a) ? a.turnId === b.turnId : !!runOf(a) && runOf(a) === runOf(b);
  }
  function storedKey(row, keyer) { return row.role + '\u0000' + (typeof keyer === 'function' ? String(keyer(textOf(row))) : textOf(row)); }

  // Hashes are diagnostic labels only. Equality and binding use full keys/text, never this hash.
  const textHash = text => sha256(text).slice(0, 12);
  function diagnosticKey(row) {
    return (row && isRowId(row.rowId) ? JSON.stringify([textHash(streamOf(row)), row.rowId]) : '') || (row && row.synthId ? 'synth:' + row.synthId :
      [localKind(row), row && row.role || '', row && row.turnId || '', runOf(row), textHash(textOf(row))].join(':'));
  }
  function recordProof(report, name, row, target, proof) {
    report.counts[name] = (report.counts[name] || 0) + 1;
    if (['pending', 'orphan', 'forgotten', 'retracted', 'station_rowid_collision'].includes(name) && !report.classes.includes(name)) report.classes.push(name);
    if (!row) return;
    const ids = idsOf(row); if (ids.streamId) ids.streamId = textHash(ids.streamId);
    const entry = { reason: name, ids, from: diagnosticKey(row) };
    if (target) { entry.target = idsOf(target); if (entry.target.streamId) entry.target.streamId = textHash(entry.target.streamId); }
    if (proof) entry.proof = proof;
    report.healed.push(entry);
  }
  // Forget and explicit retraction are independent of the selected merge algorithm. Validate each list
  // separately: unrelated malformed collision diagnostics must never disable a valid deletion proof.
  function filterLocal(local, identity, onDrop) {
    const id = identity || {}, stream = id.streamId || '', forgotten = id.forgotten || {};
    const list = value => Array.isArray(value) ? value : [];
    const retracted = new Set(list(id.retracted));
    const forgottenKeys = new Set(list(forgotten.keys).map(k => Array.isArray(k) ? JSON.stringify(k) : objectRow(k) ? keyOf(k, stream) : String(k)));
    const forgottenRuns = new Set(list(forgotten.runIds).map(String));
    return (Array.isArray(local) ? local : []).filter(row => {
      if (!objectRow(row)) return false;
      if (streamOf(row, stream) !== stream) return true;
      const key = keyOf(row, stream);
      const rule = isRowId(row.rowId) && retracted.has(row.rowId) ? 'identity.retracted'
        : isRowId(row.rowId) && forgottenKeys.has(key) ? 'identity.forgotten.keys'
        : !isRowId(row.rowId) && row.role === 'assistant' && forgottenRuns.has(runOf(row)) ? 'identity.forgotten.runIds'
        : Number(id.forgottenAt) > 0 && Number.isFinite(row.ts) && row.ts <= id.forgottenAt ? 'forgottenAt' : '';
      if (!rule) return true;
      if (typeof onDrop === 'function') onDrop(rule === 'identity.retracted' ? 'retracted' : 'forgotten', row, { rule, at: Number(id.forgottenAt) || 0 });
      return false;
    });
  }
  function collisionKeys(station, identity) {
    const id = identity || {}, stream = id.streamId || '';
    const keys = new Set((Array.isArray(id.collided) ? id.collided : []).map(k => Array.isArray(k) ? JSON.stringify(k) : objectRow(k) ? keyOf(k, stream) : String(k)));
    const seen = new Set();
    for (const row of Array.isArray(station) ? station : []) { const key = keyOf(row, stream); if (key) { if (seen.has(key) || row.idFrom === 'collision') keys.add(key); seen.add(key); } }
    return keys;
  }
  function demoteRows(rows, station, identity) {
    const stream = identity && identity.streamId || '', collided = collisionKeys(station, identity);
    return rows.map(row => {
      if (!objectRow(row) || !isRowId(row.rowId) || (row.idFrom !== 'collision' && !collided.has(keyOf(row, stream)))) return row;
      const out = Object.assign({}, row, { idFrom: 'collision' }); delete out.rowId; return out;
    });
  }
  /* THE TRIMMED MARKER. chat.js capHistory records a local drop as ONE leading row, { role:'system', truncated:true }. The
     frozen legacyMerge keeps user/assistant rows only (and is byte-pinned as the rollback owner), so every reload through
     the legacy path erased the line and the thread read as complete. The local marker goes back FIRST, once, byte for
     byte, when dialogue follows it; a history without one never gains one. The id merge words its own from station
     evidence (R7) and is not touched here. */
  const markerRow = r => objectRow(r) && r.truncated === true && r.role === 'system';
  /* A MID-TASK MESSAGE THE STATION HOLDS AND THE PAGE NEVER DREW (auto-steer). The station files a folded message as a steer
     row carrying its steeringWire (the lossless transport line, steering-message.js); the page draws it as a local steerEcho
     row. When a reload (or a phone) finds the station's row with no echo or streamed '[steering]' line of the same wire in the
     same run, the echo is made from the station's row. The frozen legacyMerge keeps user/assistant rows only, so this runs
     in front of it and the station's steer rows leave its input. */
  function steeringApi() {
    try { if (typeof module !== 'undefined' && module.exports && typeof require === 'function') return require('./steering-message.js'); } catch (_) {}
    return typeof globalThis !== 'undefined' && globalThis.SteeringMessage ? globalThis.SteeringMessage : null;
  }
  const wireOf = r => objectRow(r) && typeof r.steeringWire === 'string' ? r.steeringWire : '';
  const sameSteerWire = (echoRow, stationRow) => {
    const S = steeringApi(), wire = wireOf(stationRow);
    return !!(S && wire && S.sameWire(textOf(echoRow).replace(/^\[steering\] /, ''), wire));
  };
  function withSteerEchoes(local, station) {
    const S = steeringApi(), rows = Array.isArray(station) ? station : [];
    const incoming = rows.filter(t => objectRow(t) && wireOf(t) && (t.role === 'user' || t.kind === 'steer'));
    if (!S || !incoming.length) return { local, station };
    const next = (Array.isArray(local) ? local : []).slice();
    for (const t of incoming) {
      const echo = '[steering] ' + t.steeringWire;
      if (!next.some(m => objectRow(m) && String(m.sourceRunId || '') === String(t.sourceRunId || '') &&
          ((m.steerEcho && (m.content === echo || S.sameWire(String(m.content || '').replace(/^\[steering\] /, ''), t.steeringWire)))
            || (m.role === 'assistant' && (('\n' + m.content + '\n').includes('\n' + echo + '\n') || S.containsWire(m.content, t.steeringWire)))))) {
        next.push(Object.assign({}, t, { role: 'system', sys: true, steerEcho: true, content: echo }));
      }
    }
    return { local: next, station: rows.filter(t => incoming.indexOf(t) < 0) };
  }
  function legacyWithIdentity(local, station, identity) {
    const filtered = filterLocal(local, identity), steered = withSteerEchoes(filtered, station), mine = steered.local, lead = markerRow(mine[0]) ? mine[0] : null;
    const rows = demoteRows(legacyMerge(mine, steered.station), steered.station, identity);
    return lead && rows.some(r => objectRow(r) && (r.role === 'user' || r.role === 'assistant')) ? [lead].concat(rows) : rows;
  }
  function compare(a, b) {
    // the marker is presentation (the legacy merge keeps the page's wording, the id merge words its own): never a divergence
    const aa = (Array.isArray(a) ? a : []).filter(r => !markerRow(r)), bb = (Array.isArray(b) ? b : []).filter(r => !markerRow(r));
    const left = aa.map(diagnosticKey), right = bb.map(diagnosticKey);
    const subtract = (one, other) => {
      const counts = new Map(); for (const k of other) counts.set(k, (counts.get(k) || 0) + 1);
      return one.filter(k => { const n = counts.get(k) || 0; if (n) { counts.set(k, n - 1); return false; } return true; });
    };
    const onlyA = subtract(left, right), onlyB = subtract(right, left);
    const ordered = left.length === right.length && left.every((k, i) => k === right[i]);
    // Equal durable keys must be compared even when another row moved. A reorder must not conceal
    // a station-byte change, and an idless row's position must not manufacture a new diagnostic identity.
    const paired = new Map();
    for (const row of bb) { const k = diagnosticKey(row), rows = paired.get(k) || []; rows.push(row); paired.set(k, rows); }
    let bytes = false;
    for (const row of aa) { const rows = paired.get(diagnosticKey(row)); if (rows && rows.length && textOf(row) !== textOf(rows.shift())) bytes = true; }
    const same = ordered && !bytes, classes = [];
    if (bytes) classes.push('bytes');
    if (onlyA.length || onlyB.length) classes.push('unexplained');
    else if (!ordered) classes.push('order');
    return { same, classes, onlyA: onlyA.slice(0, 50), onlyB: onlyB.slice(0, 50) };
  }

  function mergeState(local, station, opts) {
    const o = opts || {}, identity = o.identity || {}, stream = identity.streamId || o.streamId || '';
    const report = { classes: [], counts: {}, healed: [] }, pendingLegacy = new Set();
    const count = (name, row, target, proof) => recordProof(report, name, row, target, proof);
    const byKey = new Map(), byTurn = new Map(), claimed = new Set();
    const collided = new Set((identity.collided || []).map(k => Array.isArray(k) ? JSON.stringify(k) : typeof k === 'object' ? keyOf(k, stream) : String(k)));
    const source = (Array.isArray(station) ? station : []).filter(objectRow);
    for (const r of source) { const k = keyOf(r, stream); if (k) { if (byKey.has(k) || r.idFrom === 'collision') collided.add(k); else byKey.set(k, r); } }
    byKey.clear();
    const entries = source.map((row, i) => ({ row: stationRow(row), order: i, collided: row.idFrom === 'collision' || collided.has(keyOf(row, stream)) }));
    const spine = entries.filter(e => isRowId(e.row.rowId)).sort((a, b) => a.row.rowId - b.row.rowId || a.order - b.order);
    for (const line of entries.filter(e => !isRowId(e.row.rowId))) {
      let at = -1;
      for (let i = 0; i < spine.length; i++) if (groupMatches(line.row, spine[i].row, stream)) at = i;
      if (at < 0) {
        if (Number.isFinite(line.row.ts)) for (let i = 0; i < spine.length; i++) { if (Number.isFinite(spine[i].row.ts) && spine[i].row.ts <= line.row.ts) at = i; }
        else at = spine.length - 1;
      }
      spine.splice(at + 1, 0, line);
    }
    for (const entry of spine) {
      const r = entry.row, key = keyOf(r, stream);
      if (entry.collided) {
        count('station_rowid_collision', r);
        // The store explicitly disavowed this key. Keep both rows' bytes, but neither can lend the bad key.
        delete r.rowId; r.idFrom = 'collision'; continue;
      }
      if (key) byKey.set(key, entry);
      if (streamOf(r, stream) === stream && r.directive === true && isUser(r) && hasTurn(r) && !byTurn.has(r.turnId)) byTurn.set(r.turnId, entry);
    }
    const live = new Set((identity.liveRunIds || []).map(String));
    const finishedAnswers = row => spine.filter(e => !e.collided && dialogue(e.row) && !e.row.synthId && e.row.role === 'assistant' && textOf(e.row).trim() && !live.has(runOf(e.row)) && groupMatches(row, e.row, stream));
    const localRows = filterLocal(local, identity, (name, row, proof) => count(name, row, null, proof));
    const latestUser = [...localRows].reverse().find(r => isUser(r) && dialogue(r));
    const retained = [], seenKeys = new Map(), seenUsers = new Map(), steering = new Set();
    // A bound directive wins H1 even if its optimistic twin preceded it in the save.
    const ordered = localRows.map((row, order) => ({ row, original: row, order }));
    ordered.sort((a, b) => Number(isRowId(b.row.rowId)) - Number(isRowId(a.row.rowId)) || a.order - b.order);
    const bind = (entry, row, contentBinding, sourceRow) => {
      const boundKey = keyOf(row, stream);
      count(contentBinding ? 'legacy_content' : boundKey && boundKey === keyOf(entry.row, stream) ? 'bound_key' : 'bound_turn', row, entry.row);
      entry.row = presentation(entry.row, row);
      if (!entry.collided && (contentBinding || row.idFrom === 'content')) entry.row.idFrom = 'content';
      if (isUser(row) && isSafeNonNeg(row.turnAt) && entry.row.turnAt === undefined) entry.row.turnAt = row.turnAt;
      const answered = finishedAnswers(row).length || (legacyRow(row) && spine.slice(spine.indexOf(entry) + 1).some(e => dialogue(e.row) && !e.row.synthId && e.row.role === 'assistant' && textOf(e.row).trim()));
      const retryMember = row === latestUser || sourceRow === latestUser || (isUser(row) && latestUser && groupMatches(row, latestUser, stream));
      if (retryMember && !answered) {
        const raw = row.typedText != null ? row.typedText : row.typed != null ? row.typed : row.content;
        if (typeof raw === 'string' && raw !== String(entry.row.typed != null ? entry.row.typed : entry.row.content)) entry.row.typedText = raw;
      } else delete entry.row.typedText;
      claimed.add(entry);
    };
    for (const item of ordered) {
      let row = item.row; const key = keyOf(row, stream), kind = localKind(row), sameStream = streamOf(row, stream) === stream;
      const disavowed = row.idFrom === 'collision' || collided.has(key);
      // A collision disavows the key for every local kind, including annotations which never enter R6.
      // Persist that fact across a narrower next read; an old key must never regain H2/save authority.
      if (disavowed && isRowId(row.rowId)) { count('local_rowid_collision', row, null, { rule: 'R0' }); row = item.row = Object.assign({}, row, { idFrom: 'collision' }); delete row.rowId; }
      if (row.truncated) { count('truncation_marker', row, null, { rule: 'R7' }); continue; }   // rebuilt only from affirmative station evidence after the cap
      if (key && !disavowed && seenKeys.has(key)) {
        const prior = seenKeys.get(key); prior.row = presentation(prior.row, row);
        if (byKey.has(key)) bind(byKey.get(key), row, false);
        count('duplicate_key', row, prior.row); continue;
      }
      if (!disavowed && isUser(row) && dialogue(row) && hasTurn(row)) {
        const tk = streamOf(row, stream) + '\u0000' + row.turnId, prior = seenUsers.get(tk);
        if (prior && (!isRowId(row.rowId) || !isRowId(prior.row.rowId))) {
          prior.row = presentation(prior.row, row);
          const target = byTurn.get(row.turnId); if (target && sameStream) bind(target, row, false);
          count('directive_twin', row, target && sameStream ? target.row : prior.row); continue;
        }
        if (!prior) seenUsers.set(tk, item);
      }
      if (key && !disavowed) seenKeys.set(key, item);
      if (key && !disavowed && byKey.has(key)) { bind(byKey.get(key), row, false); continue; }
      if (key && !disavowed) {
        if (sameStream && row.rowId >= Number(identity.fromRowId || Infinity)) count('orphan', row);
        retained.push(item); continue;   // outside the window or orphaned: absence is never deletion proof
      }
      if (!key && !disavowed && sameStream && isUser(row) && dialogue(row) && hasTurn(row) && byTurn.has(row.turnId)) { bind(byTurn.get(row.turnId), row, false); continue; }
      if (!key && !disavowed && sameStream && isUser(row) && dialogue(row) && !hasTurn(row) && runOf(row)) {
        const twin = spine.find(e => !e.collided && streamOf(e.row, stream) === stream && e.row.directive === true && runOf(e.row) === runOf(row)
          && localRows.some(r => keyOf(r, stream) && keyOf(r, stream) === keyOf(e.row, stream)));
        if (twin) { bind(twin, row, false); count('attachment_twin', row, twin.row); continue; }
      }
      const provisional = !row.sys && !row.foreign && !row.steerEcho && !row.truncated;
      const answers = provisional && !disavowed && !isRowId(row.rowId) && row.role === 'assistant' ? finishedAnswers(row) : [];
      if (answers.length) {
        const last = answers[answers.length - 1], status = statusOf(row);
        // Prior stop evidence belongs under supersededStatus, never on the accepted answer's active status.
        last.row = presentation(last.row, Object.assign({}, row, { stopNote: undefined }));
        if (Object.keys(status).length) last.row.supersededStatus = Object.assign({}, last.row.supersededStatus, status);
        count('provisional_answer', row, last.row); continue;
      }
      const synthetic = sameStream && kind === 'error' && spine.find(e => streamOf(e.row, stream) === stream && e.row.synthId && runOf(row) && runOf(e.row) === runOf(row));
      if (synthetic) { count('synthetic_status', row, synthetic.row); continue; }
      if (sameStream && kind === 'steerEcho') {
        const match = spine.find(e => streamOf(e.row, stream) === stream && e.row.kind === 'steer' && !steering.has(e) &&
          ((row.noteId ? row.noteId === e.row.noteId : runOf(row) && runOf(row) === runOf(e.row) && textOf(row).replace(/^\[steering\] /, '') === textOf(e.row).replace(/^\[steering\] /, ''))
            || (runOf(row) && runOf(row) === runOf(e.row) && sameSteerWire(row, e.row))));
        if (match) { steering.add(match); count('steer_twin', row, match.row); continue; }
      }
      if (sameStream && (legacyRow(row) || disavowed) && dialogue(row)) {
        const k = storedKey(row, o.legacyKey);
        const match = spine.find(e => streamOf(e.row, stream) === stream && dialogue(e.row) && !claimed.has(e) && (!hasTurn(e.row) || e.collided) && storedKey(e.row, o.legacyKey) === k);
        if (match) { bind(match, row, true, item.original); continue; }
        pendingLegacy.add(item.original); item.row = Object.assign({}, row, { legacy: true });
        if (disavowed) { delete item.row.rowId; item.row.idFrom = 'collision'; }
      } else if (kind === 'pending') count('pending', row);
      retained.push(item);
    }
    // Local annotations keep their relative order at the last row of their own turn/run; otherwise their timestamp
    // places them without changing the station spine. Unknown timestamps stay after the last station row.
    const after = new Map();
    for (const item of retained.sort((a, b) => a.order - b.order)) {
      let anchor = -1;
      for (let i = 0; i < spine.length; i++) if (groupMatches(item.row, spine[i].row, stream)) anchor = i;
      if (anchor < 0) {
        if (Number.isFinite(item.row.ts)) for (let i = 0; i < spine.length; i++) { if (Number.isFinite(spine[i].row.ts) && spine[i].row.ts <= item.row.ts) anchor = i; }
        else anchor = spine.length - 1;
      }
      const rows = after.get(anchor) || []; rows.push(item.row); after.set(anchor, rows);
    }
    let rows = (after.get(-1) || []).slice();
    for (let i = 0; i < spine.length; i++) rows.push(spine[i].row, ...(after.get(i) || []));
    const cap = Number.isSafeInteger(o.cap) && o.cap >= 0 ? o.cap : 120;
    let excess = Math.max(0, rows.filter(dialogue).length - cap), droppedStation = false;
    const stationSet = new Set(spine.map(e => e.row));
    rows = rows.filter(row => { if (excess && dialogue(row)) { excess--; if (stationSet.has(row)) droppedStation = true; count('cap', row, null, { rule: 'R7', cap }); return false; } return true; });
    if (droppedStation || identity.hasOlder === true) rows.unshift({ role: 'system', truncated: true, content: '… earlier turns are stored on the station' });
    return { rows, report, pendingLegacy };
  }

  function merge(local, station, opts) { const out = mergeState(local, station, opts); return { rows: out.rows, report: out.report }; }

  async function reconcile(local, response, opts) {
    const o = opts || {}, reply = response || {}, station = Array.isArray(reply.turns) ? reply.turns : [];
    const identity = reply.identity && reply.identity.v === 2 ? reply.identity : null;
    let mode = identity && identity.modes && ['legacy', 'shadow', 'id'].includes(identity.modes.merge) ? identity.modes.merge : 'legacy';
    const note = event => { if (typeof o.note === 'function') o.note(event); };
    const dropped = new Map();
    const current = () => filterLocal(typeof o.getLocal === 'function' ? o.getLocal() : local, identity,
      (name, row, proof) => dropped.set(row, { name, proof }));
    const options = { identity, streamId: reply.stream || '', cap: o.cap };
    const nextMerge = rows => {
      if (mode !== 'legacy') {
        try { return mergeState(rows, station, options); }
        catch (e) { mode = 'legacy'; note({ event: 'merge-fallback', surface: 'merge' }); }
      }
      return { rows: [], report: { classes: [], counts: {} }, pendingLegacy: new Set() };
    };
    let raw = current(), legacy = legacyWithIdentity(raw, station, identity), next = nextMerge(raw);
    const collisions = collisionKeys(station, identity);
    const left = mode === 'id' ? [...next.pendingLegacy] : raw.filter(r => (legacy.includes(r) || r.idFrom === 'collision' || collisions.has(keyOf(r, identity && identity.streamId))) && objectRow(r) && !r.sys && ['user', 'assistant'].includes(r.role) && typeof r.content === 'string');
    let clean = null;
    if (left.length && station.some(r => /\[redacted-/.test(textOf(r))) && typeof o.redactAsk === 'function') {
      try { clean = await o.redactAsk(left); } catch (e) { clean = false; }
      if (clean === false) note('history-redact-unavailable');
    }
    raw = current();
    if (clean && typeof clean.get === 'function') {
      const eligible = new Set(left), ORIGINAL = Symbol('typed-original');
      const keyed = raw.map(row => {
        const content = eligible.has(row) ? clean.get(row.content) : undefined;
        if (content === undefined || content === row.content) return row;
        return Object.assign({}, row, { content, typedText: row.typedText != null ? row.typedText : row.typed != null ? row.typed : row.content, [ORIGINAL]: row });
      });
      next = nextMerge(keyed);
      // Only a content-bound station row consumes the scrubbed copy. Unmatched rows stay exactly as typed.
      next.rows = next.rows.map(row => row[ORIGINAL] || row);
      const TYPED = Symbol('typed'), copies = new Set();
      const legacyInput = raw.map(row => { const content = eligible.has(row) ? clean.get(row.content) : undefined; if (content === undefined || content === row.content) return row;
        const copy = Object.assign({}, row, { content, [TYPED]: row }); copies.add(copy); return copy; });
      legacy = legacyWithIdentity(legacyInput, station, identity);
      const lastUser = legacy.map(r => r && r.role).lastIndexOf('user');
      const answered = legacy.slice(lastUser + 1).some(r => r && r.role === 'assistant' && !r.error && !r.stopped && textOf(r).trim());
      legacy = legacy.map((row, i) => { const original = row && row[TYPED]; if (!original) return row; if (copies.has(row)) return original;
        const out = Object.assign({}, row, i === lastUser && !answered && row.role === 'user' ? { content: original.content } : null); delete out[TYPED]; return out; });
    } else { next = nextMerge(raw); legacy = legacyWithIdentity(raw, station, identity); }
    const diff = compare(legacy, next.rows);
    if (identity && mode !== 'legacy' && !diff.same) note({ event: 'merge-divergence', classes: [...new Set(diff.classes.concat(next.report.classes))], onlyLegacy: diff.onlyA, onlyNew: diff.onlyB });
    const out = mode === 'id' ? { rows: next.rows, report: next.report } : { rows: legacy, report: { classes: mode === 'shadow' ? diff.classes : [], counts: {}, healed: [], mode } };
    out.rows = demoteRows(out.rows, station, identity);
    for (const [row, removal] of dropped) recordProof(out.report, removal.name, row, null, removal.proof);
    return out;
  }

  /* THE ONE DELIVERABLE ADAPTER (turn identity, commit 10). A canonical kind:'deliverable' row becomes the page's deliverable record
     { title: the exact path, kind: its media, runId, t, agentId: the writing agent's folder, root: the project folder or '', rowId }.
     The page draws and files a file chip only through this, and nothing reads or splits the row's prose. Null for a row that is not
     a well-formed file row: a bad field is never repaired here either (TurnKinds.deliverableFields is the one grammar). */
  function deliverableOf(row) {
    if (!objectRow(row) || row.kind !== 'deliverable') return null;
    const d = TurnKinds.deliverableFields(row.deliverable);
    if (!d) return null;
    return { title: d.path, kind: d.media, runId: row.sourceRunId, t: row.ts, agentId: d.workspace, root: d.root, rowId: row.rowId };
  }

  /* A STEERED REPLY, SPLIT AT ITS NOTES (turn identity, commit 10; A2-REB-1). The trunk save shape of a reply a note steered is ONE
     assistant row whose text holds the run's '\n[steering] <note>\n' echoes between its paragraphs (the token stream carried them).
     Replayed as it is, the model would read the Commander's words as its own: so in a window each such row becomes, in place, its
     non-blank prose parts as assistant messages with every note a user '[steering] <note>' message between them, exactly as the
     station's own replay shapes a steer row. The split (chat.js renderHistory's regex) is the only thing done to the text: no part is
     trimmed or reworded. A derived message is not a durable row, so it carries no rowId and no idFrom; the note rows are kind
     'steer', so a retry still ends on the directive (HistoryFit.endOnUserTurn). Every other row is returned as it is. */
  const STEER_LINES = /(?:^|\n)\[steering\] ([^\n]*)\n?/;
  const STEER_START = /(?:^|\n)\[steering\] /;
  function splitSteer(input) {
    const rows = Array.isArray(input) ? input : [], out = [];
    for (const row of rows) {
      if (!objectRow(row) || row.role !== 'assistant' || row.sys || typeof row.content !== 'string' || !STEER_START.test(row.content)) { out.push(row); continue; }
      const base = Object.assign({}, row); delete base.rowId; delete base.idFrom;
      const parts = row.content.split(STEER_LINES);   // [prose, note, prose, note, …, prose]
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          if (!parts[i].trim()) continue;
          const note = { role: 'user', kind: 'steer', content: '[steering] ' + parts[i] };
          for (const k of ['ts', 'sourceRunId', 'turnId', 'streamId']) if (row[k] !== undefined) note[k] = row[k];
          out.push(note);
        } else if (parts[i].trim()) out.push(Object.assign({}, base, { content: parts[i] }));
      }
    }
    return out;
  }

  function windowRows(input, options) {
    const rows = Array.isArray(input) ? input : [], o = options || {};
    // a canonical system-kind row (a file row, from commit 10) is display only: the rollback window never carries one either
    if (o.window === 'legacy') return rows.filter(row => !(row && (row.truncated || row.sys || row.error || (row.role === 'system' && TurnKinds.SYSTEM_KINDS.indexOf(row.kind) >= 0))));
    const ctx = { finalRuns: new Set(rows.filter(row => TurnKinds.isFinalDeliveryRow(row)).map(row => String(row.sourceRunId || ''))) };
    // outside the rollback window a reply that embeds its steering notes is split at them (M3: window:legacy keeps today's bytes)
    return splitSteer(rows.filter(row => row && TurnKinds.replayable(row, { shape: 'prose', forAgent: o.forAgent, line: o.line, streamId: o.streamId, ctx }))
      .map(row => TurnKinds.classify(row, ctx).kind === 'steer'
        ? Object.assign({}, row, { role: 'user', content: String(row.content || '').startsWith('[steering] ') ? row.content : '[steering] ' + String(row.content || '') }) : row));
  }

  return { pendingRow, newTurnId, sendIds, bindStart, ofTurn, legacyMerge, legacyWithIdentity, merge, reconcile, stationRow, idsOf, localKind, sameTurn, compare, windowRows, splitSteer, deliverableOf };
});
