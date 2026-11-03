/* frontend/app/turnkinds.js — the one home of a turn's identity grammar and of row kinds (turn-identity, commit 1).

   Pure, zero-dep, UMD: the sidecar's transcript store and run writer require() it, and later the page and the phone
   host load the SAME module, so a turnId the desk mints and the station checks follow one grammar. No clock, no
   randomness, no fs, no crypto: a mint takes an injected rng, a time conversion an injected `now`.

     TURN_ID_RE, isTurnId(v)          the turnId grammar (8-64 of [A-Za-z0-9_-]); a bad value is dropped, never thrown
     runTurnId(runId)                 'r' + runId, sanitized and clipped to 64 ('' when that is not a turnId): the
                                      server's own mint for a run, so it is never looked up as a resend
     phoneTurnId(runId)               'ph' + runId, sanitized and clipped the same way (the phone host's mint)
     ownMint(turnId, runId)           true only for an id derived from THIS run's own id (either mint above)
     mintTurnId(rng)                  't' + 24 base36 chars drawn from rng() in [0,1); a TypeError without an rng
     QUOTES_MAX                       the ONE quote capacity (32 stream ids)
     quoteStamp(entries)              [{id, at}] (a bare string is {id, at: 0}) -> { quotes, quotesAt }: up to 32
                                      distinct ids with their read times aligned; more, or any '*', is the
                                      saturated stamp { quotes: ['*'], quotesAt: [min at] }; {} for none
     stationTime(clientTs, clientNow, now)   the station time of a client instant, from the client's own elapsed
                                      time (now - (clientNow - clientTs)), so a client clock's offset cancels
     clientTurnTime(body, now)        { turnAt, clientClock: { clientNow, at } } for a body carrying a usable
                                      turnAt + clientNow pair, else {}
     KINDS, isKind(v), SYSTEM_KINDS   row kinds; rows of a SYSTEM kind are stored with role 'system', so an older
                                      reader (reconstruct, appendNew, markRecorded, the page merges) skips them
     tag(msg, kind, extra) / tagOf(msg)   a kind carried on a message object under a non-enumerable Symbol: invisible
                                      to JSON.stringify, so a tagged message's wire and disk bytes never change */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.TurnKinds = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TURN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const ID_MAX = 64;
  const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  const MINT_CHARS = 24;
  const QUOTES_MAX = 32;
  const SATURATED = '*';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const KINDS = Object.freeze(['turn', 'station', 'goal-step', 'routine', 'group', 'hop', 'capture', 'steer', 'observed',
    'deliverable', 'delivery', 'retract', 'briefing', 'api']);
  // stored role 'system': trunk's readers skip these, so a downgrade never replays one as the Commander's words.
  // 'delivery' is NOT here: it is a routine's reply, assistant speech, and stays role 'assistant'.
  const SYSTEM_KINDS = Object.freeze(['steer', 'deliverable', 'retract']);

  function isTurnId(v) { return typeof v === 'string' && TURN_ID_RE.test(v); }
  function isKind(v) { return typeof v === 'string' && KINDS.indexOf(v) >= 0; }
  function isSafeNonNeg(v) { return Number.isSafeInteger(v) && v >= 0; }

  function derived(prefix, runId) {
    const id = (prefix + (runId == null ? '' : String(runId))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, ID_MAX);
    return isTurnId(id) ? id : '';
  }
  function runTurnId(runId) { return derived('r', runId); }
  function phoneTurnId(runId) { return derived('ph', runId); }
  // derived from THIS run's own id; every other value, whatever its prefix, was supplied and must be looked up
  function ownMint(turnId, runId) {
    if (!isTurnId(turnId)) return false;
    return turnId === runTurnId(runId) || turnId === phoneTurnId(runId);
  }

  function mintTurnId(rng) {
    if (typeof rng !== 'function') throw new TypeError('TurnKinds.mintTurnId needs an rng() returning a number in [0,1)');
    let id = 't';
    for (let i = 0; i < MINT_CHARS; i++) {
      const v = Number(rng());
      const k = Math.floor((v >= 0 && v < 1 ? v : 0) * BASE36.length);
      id += BASE36[Math.min(BASE36.length - 1, Math.max(0, k))];
    }
    return id;
  }

  // [{id, at}] -> { quotes, quotesAt }. An entry's `at` is the read epoch of the first dispatch that read that stream;
  // a missing or unusable one counts as 0 (the earliest, so a delete never misses it). Duplicates keep their earliest.
  function quoteStamp(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const ids = [];
    const firstAt = new Map();
    let saturated = false, minAt = Infinity;
    for (const e of list) {
      const id = typeof e === 'string' ? e : (e && typeof e === 'object' && typeof e.id === 'string' ? e.id : '');
      if (!id) continue;
      const at = (e && typeof e === 'object' && isSafeNonNeg(e.at)) ? e.at : 0;
      if (at < minAt) minAt = at;
      if (id === SATURATED) { saturated = true; continue; }
      if (!firstAt.has(id)) { firstAt.set(id, at); ids.push(id); }
      else if (at < firstAt.get(id)) firstAt.set(id, at);
    }
    if (!saturated && !ids.length) return {};
    if (saturated || ids.length > QUOTES_MAX) return { quotes: [SATURATED], quotesAt: [minAt] };
    return { quotes: ids, quotesAt: ids.map(id => firstAt.get(id)) };
  }

  // a client instant in station time: the client's own elapsed time since it (clientNow - clientTs), subtracted from
  // the station's now. Only a pair of non-negative safe integers no more than 7 days apart is used.
  function stationTime(clientTs, clientNow, now) {
    if (!isSafeNonNeg(clientTs) || !isSafeNonNeg(clientNow) || !Number.isSafeInteger(now)) return undefined;
    const elapsed = clientNow - clientTs;
    if (elapsed < 0 || elapsed > WEEK_MS) return undefined;
    return now - elapsed;
  }
  function clientTurnTime(body, now) {
    const b = body && typeof body === 'object' ? body : {};
    const turnAt = stationTime(b.turnAt, b.clientNow, now);
    return turnAt === undefined ? {} : { turnAt, clientClock: { clientNow: b.clientNow, at: now } };
  }

  // Symbol-keyed and non-enumerable: JSON.stringify, Object.keys and object spread never see it, so a tag rides the
  // message object through the loop without reaching the wire or the disk (the transcript's PERSISTED marker idiom).
  const KIND_TAG = Symbol('starnet.turn.kind');
  function tag(msg, kind, extra) {
    if (!msg || typeof msg !== 'object' || !isKind(kind)) return msg;
    if (!Object.isExtensible(msg) && !Object.prototype.hasOwnProperty.call(msg, KIND_TAG)) return msg;
    const value = { kind };
    if (extra && typeof extra === 'object' && extra.noteId != null) value.noteId = String(extra.noteId);
    Object.defineProperty(msg, KIND_TAG, { value: Object.freeze(value), enumerable: false, configurable: true, writable: true });
    return msg;
  }
  function tagOf(msg) { return msg && typeof msg === 'object' && msg[KIND_TAG] ? msg[KIND_TAG] : null; }

  return {
    TURN_ID_RE, isTurnId, runTurnId, phoneTurnId, ownMint, mintTurnId,
    QUOTES_MAX, quoteStamp, stationTime, clientTurnTime,
    KINDS, isKind, SYSTEM_KINDS, tag, tagOf
  };
});
