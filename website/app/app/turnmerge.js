/* frontend/app/turnmerge.js — the page's turn ids: minted, sent, bound (turn-identity, commit 3).

   Pure, zero-dep beyond TurnKinds, UMD: the desk (chat.js), its website mirror and the tests load the SAME module, so the
   page holds no id logic of its own. No clock, no randomness: a mint takes an injected rng, a send an injected `now`.
   Later commits add the merge (merge, legacyMerge, compare, sameTurn, …); this commit holds only the send side.

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
                                             field the row already holds is kept) */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./turnkinds.js'));
  else { root.TurnMerge = factory(root.TurnKinds); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (TurnKinds) {
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

  return { pendingRow, newTurnId, sendIds, bindStart, ofTurn };
});
