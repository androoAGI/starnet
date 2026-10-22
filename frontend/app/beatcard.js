/* AGENT OS — beatcard.js : dependency-free lifecycle for COMMS post-run cards.

   The renderer supplies nodes, copy, actions, and persistence hooks. This module owns the
   cross-feature mechanics that used to be cloned in chat.js: one visible slot, run dedupe,
   pending reservations, decision/expiry state, FIFO deferral, vanish cleanup, and generation
   tokens that make late async completions from an old COMMS render inert. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BeatCard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PRIORITY = ['memory', 'study', 'arc', 'trust', 'thread', 'rate', 'nudge'];

  function makeSlot(priority) {
    const order = (Array.isArray(priority) && priority.length ? priority : DEFAULT_PRIORITY).slice();
    const pending = new Map();
    let visible = null;

    function rank(kind) { const i = order.indexOf(kind); return i < 0 ? order.length : i; }
    function reserve(kind, key) {
      if (!kind || !key) return;
      if (!pending.has(kind)) pending.set(kind, new Set());
      pending.get(kind).add(key);
    }
    function releaseReservation(kind, key) {
      const set = pending.get(kind);
      if (!set) return;
      if (key) set.delete(key); else set.clear();
      if (!set.size) pending.delete(kind);
    }
    /* can(kind, selfKey) — may `kind` take the one slot right now?
       'busy' (a card is visible) · the blocking kind (a higher-ranked reservation is in flight) · 'free'.

       SELF-RESERVATION (the thread-channel deadlock, fixed 2026-08-04). The collection pass reserves BOTH of its
       fetch-backed kinds ('study' and 'thread', under its own runId) so nothing lower can steal the slot across the
       await — and then asked this predicate whether thread could speak. Its own 'study' reservation outranks
       'thread', so the answer was always 'study': threadCandidate returned null on EVERY run, queueThread was never
       reached and offerThread was dead code. A reservation held under `selfKey` is therefore INVISIBLE to a caller
       that identifies itself with that key: a pass can never veto its own candidate collection. Another run's
       reservation under the same kind still blocks, because its key differs. */
    function can(kind, selfKey) {
      if (visible !== null) return 'busy';
      const ownRank = rank(kind);
      for (const [pendingKind, keys] of pending) {
        const others = keys.size - ((selfKey && keys.has(selfKey)) ? 1 : 0);
        if (others > 0 && rank(pendingKind) < ownRank) return pendingKind;
      }
      return 'free';
    }
    function show(kind) {
      if (visible !== null && visible !== kind) return false;
      visible = kind;
      return true;
    }
    function request(kind) {
      if (visible !== null) return 'queue';
      visible = kind;
      return 'render';
    }
    function done(kind, handoffKind) {
      if (visible === kind || visible === null) visible = handoffKind || null;
    }
    function reset() { pending.clear(); visible = null; }

    return {
      reserve, releaseReservation, can, show, request, done, reset,
      visibleBeat() { return visible; },
      pendingCount(kind) {
        if (kind) return pending.has(kind) ? pending.get(kind).size : 0;
        let n = 0; for (const keys of pending.values()) n += keys.size; return n;
      },

      // Compatibility surface for the existing Study.makeBeatSlot contract. The implementation
      // lives here so old focused tests and any older callers exercise the shared arbiter.
      memoryProposed(runId) { reserve('memory', runId); },
      memoryDeck() { return request('memory'); },
      memoryShown() { show('memory'); },
      memoryDone(runId, more) { releaseReservation('memory', runId); done('memory', more ? 'memory' : null); },
      memoryEmpty(runId) { releaseReservation('memory', runId); },
      // every canX takes the OPTIONAL self-key: the collection pass passes its runId so its own in-flight
      // reservations don't veto its own candidates (see can()).
      canStudy(selfKey) { return can('study', selfKey); },
      studyShown() { show('study'); },
      studyDone(more) { done('study', more ? 'memory' : null); },
      canArc(selfKey) { return can('arc', selfKey); },
      arcShown() { show('arc'); },
      arcDone(more) { done('arc', more ? 'memory' : null); },
      canTrust(selfKey) { return can('trust', selfKey); },
      trustShown() { show('trust'); },
      trustDone(more) { done('trust', more ? 'memory' : null); },
      canThread(selfKey) { return can('thread', selfKey); },
      threadShown() { show('thread'); },
      threadDone(more) { done('thread', more ? 'memory' : null); },
      _pending() { return this.pendingCount('memory'); }
    };
  }

  function create(options) {
    options = options || {};
    const timers = options.timers || {};
    const later = typeof timers.setTimeout === 'function' ? timers.setTimeout : setTimeout;
    const cancel = typeof timers.clearTimeout === 'function' ? timers.clearTimeout : clearTimeout;
    const vanish = typeof options.vanish === 'function'
      ? options.vanish
      : function (node, done) { if (node && typeof node.remove === 'function') node.remove(); if (done) done(); };
    const maxSeen = Number.isFinite(options.maxSeen) ? Math.max(1, options.maxSeen) : 200;
    /* MINIMUM VISIBLE AGE. Leaving a card undecided is read as an IGNORE, and two ignores permanently silence a
       belief/offer — so an "ignore" may only be tallied against a card the Commander actually had a chance to see.
       A card retired before this age closes as 'unseen': the slot is freed exactly the same way, but no feature
       ignore hook fires. Tunable; 1.2s is comfortably longer than any render+scroll and far shorter than the
       run-to-run gap a real card lives across. */
    const minVisible = Number.isFinite(options.minVisible) ? Math.max(0, options.minVisible) : 1200;
    const slot = makeSlot(options.priority);
    const seen = new Map();
    const queues = new Map();
    const expiryTimers = new Map();
    let active = null;
    let generation = 1;
    let sequence = 0;

    function seenSet(kind) { if (!seen.has(kind)) seen.set(kind, new Set()); return seen.get(kind); }
    function once(kind, runId) {
      if (!runId) return false;
      const set = seenSet(kind);
      if (set.has(runId)) return false;
      set.add(runId);
      while (set.size > maxSeen) set.delete(set.values().next().value);
      return true;
    }
    function hasSeen(kind, runId) { const set = seen.get(kind); return !!(set && set.has(runId)); }
    function enqueue(kind, key, value) {
      if (!kind) return false;
      if (!queues.has(kind)) queues.set(kind, []);
      const q = queues.get(kind);
      if (key && q.some(item => item.key === key)) return false;
      q.push({ key: key || null, value: value });
      return true;
    }
    function shift(kind) {
      const q = queues.get(kind);
      if (!q || !q.length) return null;
      const item = q.shift();
      return item ? item.value : null;
    }
    function queueSize(kind) { const q = queues.get(kind); return q ? q.length : 0; }
    function clearQueue(kind) { if (kind) queues.delete(kind); else queues.clear(); }
    function clearExpiry(kind) {
      if (!expiryTimers.has(kind)) return;
      cancel(expiryTimers.get(kind));
      expiryTimers.delete(kind);
    }
    function isCurrent(record) { return !!record && active === record && record.generation === generation && !record.closed; }
    function handoffOf(record) {
      if (!record || typeof record.handoff !== 'function') return null;
      try { return record.handoff() || null; } catch (_) { return null; }
    }
    function close(record, reason, extra) {
      extra = extra || {};
      if (!isCurrent(record) || record.closing) return false;
      record.closing = true;
      clearExpiry(record.kind);
      if (record.seenTimer) { cancel(record.seenTimer); record.seenTimer = null; }
      // an expiry that lands before the card was visible long enough is NOT a verdict — see minVisible.
      if (reason === 'expired' && !record.seen) reason = 'unseen';
      if (reason === 'expired' && typeof record.onExpire === 'function') {
        try { record.onExpire(record); } catch (_) {}
      }
      if (typeof record.onRelease === 'function') {
        try { record.onRelease(reason, record); } catch (_) {}
      }
      active = null;
      record.closed = true;
      slot.done(record.kind, handoffOf(record));
      const after = function () {
        if (typeof record.onGone === 'function') { try { record.onGone(reason, record); } catch (_) {} }
        if (typeof extra.onGone === 'function') { try { extra.onGone(reason, record); } catch (_) {} }
      };
      vanish(record.node, after);
      return true;
    }
    function makeHandle(record) {
      return {
        attach(node) { if (!isCurrent(record)) return false; record.node = node || null; return true; },
        isCurrent() { return isCurrent(record); },
        isDecided() { return !!record.decided; },
        decide() {
          if (!isCurrent(record) || record.decided) return false;
          record.decided = true;
          clearExpiry(record.kind);
          return true;
        },
        ifCurrent(fn) { if (!isCurrent(record)) return false; if (typeof fn === 'function') fn(record); return true; },
        finish(opts) {
          opts = opts || {};
          if (!isCurrent(record)) return false;
          const ms = Number.isFinite(opts.delay) ? Math.max(0, opts.delay) : 0;
          if (record.finishTimer) cancel(record.finishTimer);
          if (ms === 0) return close(record, opts.reason || 'decided', opts);
          const expectedGeneration = generation;
          record.finishTimer = later(function () {
            record.finishTimer = null;
            if (generation !== expectedGeneration) return;
            close(record, opts.reason || 'decided', opts);
          }, ms);
          return true;
        },
        expire() {
          if (!isCurrent(record) || record.decided) return false;
          const connected = !record.node || record.node.isConnected !== false;
          return close(record, connected ? 'expired' : 'detached');
        },
        kind: record.kind,
        runId: record.runId,
        token: record.token
      };
    }
    function claim(spec) {
      spec = spec || {};
      const kind = spec.kind;
      if (!kind || active) return null;
      if (!spec.preclaimed && slot.can(kind) !== 'free') return null;
      if (!spec.preclaimed && !slot.show(kind)) return null;
      const record = {
        kind: kind, runId: spec.runId || null, data: spec.data,
        node: spec.node || null, decided: false, closing: false, closed: false,
        generation: generation, token: ++sequence, finishTimer: null,
        seen: minVisible === 0, seenTimer: null,
        handoff: spec.handoff, onExpire: spec.onExpire,
        onRelease: spec.onRelease, onGone: spec.onGone
      };
      active = record;
      if (minVisible > 0) {
        const expectedGeneration = generation;
        record.seenTimer = later(function () {
          record.seenTimer = null;
          if (generation === expectedGeneration) record.seen = true;
        }, minVisible);
      }
      record.handle = makeHandle(record);
      return record.handle;
    }
    function expire(kind) { if (!active || (kind && active.kind !== kind)) return false; return active.handle.expire(); }
    /* THE STARVE FIX (recommendation spine, S2). A scheduled sweep is armed at a NEW task end to retire the
       PREVIOUS moment's undecided card. It used to expire only when the holder's kind matched the sweep's
       kind — so an unanswered gentle nudge (or any other family) kept the one slot until the next reset()
       and starved every higher-value offer queued behind it. The sweep now retires whichever UNDECIDED card
       is holding the slot. Nothing about a decision is weakened: handle.expire() still refuses a decided
       card, so a verdict can never be miscounted as an "ignore", and each record fires its OWN onExpire
       hook — the right feature tallies the ignore, never the sweeper's. */
    /* sweepExpire(armedToken) — retire the card this sweep was ARMED AGAINST.

       THE RACING-SWEEP BUG (fixed 2026-08-04). Three sweeps arm at every hero run end (the study, trust and
       thread lifecycle wires each call scheduleExpire(kind, 900)), and the queue drain that runs in the SAME
       timer batch can render a brand-new card between them. The next sweep in that batch then retired the
       FRESH card — the Commander never saw a frame of it — and its onExpire tallied an "ignore" against a
       belief that was never actually shown. Two of those permanently silence it, and the session cap was
       already spent by markShown. A sweep is now bound to the record that was holding the slot when it ARMED:
       if the slot turned over in between (or was empty at arm time), the sweep is a no-op. */
    function sweepExpire(armedToken) {
      if (!active) return false;
      if (arguments.length && active.token !== armedToken) return false;
      return active.handle.expire();
    }
    function scheduleExpire(kind, delay) {
      clearExpiry(kind);
      const expectedGeneration = generation;
      const armedToken = active ? active.token : 0;   // WHICH card this sweep is allowed to retire
      const id = later(function () {
        expiryTimers.delete(kind);
        if (generation === expectedGeneration) sweepExpire(armedToken);
      }, Math.max(0, Number(delay) || 0));
      expiryTimers.set(kind, id);
      return id;
    }
    function reset(opts) {
      opts = opts || {};
      generation += 1;
      for (const id of expiryTimers.values()) cancel(id);
      expiryTimers.clear();
      if (active && active.finishTimer) cancel(active.finishTimer);
      if (active && active.seenTimer) cancel(active.seenTimer);
      active = null;
      slot.reset();
      if (opts.seen !== false) seen.clear();
      if (opts.queues !== false) queues.clear();
    }

    return {
      slot, once, hasSeen, enqueue, shift, queueSize, clearQueue, claim, expire, sweepExpire, scheduleExpire, reset,
      reserve(kind, runId) { slot.reserve(kind, runId); },
      releaseReservation(kind, runId) { slot.releaseReservation(kind, runId); },
      canOffer(kind, selfKey) { return slot.can(kind, selfKey); },
      busy(kind) { return !!(active && (!kind || active.kind === kind)); },
      active(kind) { return active && (!kind || active.kind === kind) ? active.handle : null; },
      visibleBeat() { return slot.visibleBeat(); },
      generation() { return generation; }
    };
  }

  return { create, makeSlot, DEFAULT_PRIORITY: DEFAULT_PRIORITY.slice() };
});
