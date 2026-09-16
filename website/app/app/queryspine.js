/* STARNET — queryspine.js : one honest browser-side owner for shared JSON GET resources.

   A resource is keyed independently of its URL so every consumer shares the same in-flight
   request, last-good value, freshness clock, and poll timer. Failed reads reject and publish
   error metadata while retaining the last-good value; they never manufacture an empty success.
   Polling exists only while at least one subscriber owns the resource, and the final unsubscribe
   tears its timer down. Dependency-free/browser-global, with narrow injection seams for Node tests. */
'use strict';
const QuerySpine = (() => {
  const resources = new Map();
  let getJson = (path, options) => {
    if (typeof Harness === 'undefined' || !Harness.api || typeof Harness.api.get !== 'function') {
      return Promise.reject(new Error('Harness.api.get unavailable'));
    }
    return Harness.api.get(path, options);
  };
  let now = () => Date.now();
  let armInterval = (fn, ms) => setInterval(fn, ms);
  let disarmInterval = id => clearInterval(id);

  function positiveMs(v) { return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0; }
  function define(key, spec) {
    key = String(key || '').trim();
    spec = spec || {};
    if (!key) throw new Error('query resource key required');
    if (!resources.has(key)) {
      if (!spec.path) throw new Error('query resource path required: ' + key);
      resources.set(key, {
        key,
        path: String(spec.path),
        ttlMs: positiveMs(spec.ttlMs),
        pollMs: positiveMs(spec.pollMs),
        timeoutMs: positiveMs(spec.timeoutMs) || 15000,
        validate: typeof spec.validate === 'function' ? spec.validate : null,
        hasData: false,
        data: undefined,
        updatedAt: 0,
        invalidated: false,
        error: null,
        errorAt: 0,
        generation: 0,
        inFlight: null,
        inFlightGeneration: 0,
        listeners: new Set(),
        timer: null
      });
    } else if (spec.path && resources.get(key).path !== String(spec.path)) {
      throw new Error('query resource path conflict: ' + key);
    }
    return key;
  }

  function resource(key) {
    const r = resources.get(String(key));
    if (!r) throw new Error('unknown query resource: ' + key);
    return r;
  }

  function snapshotOf(r) {
    const ageMs = r.hasData ? Math.max(0, now() - r.updatedAt) : null;
    return Object.freeze({
      key: r.key,
      path: r.path,
      hasData: r.hasData,
      data: r.data,
      updatedAt: r.updatedAt,
      ageMs,
      stale: !r.hasData || r.invalidated || !!r.error || (r.ttlMs > 0 && ageMs >= r.ttlMs),
      error: r.error,
      errorAt: r.errorAt,
      pending: !!r.inFlight
    });
  }

  function state(key) { return snapshotOf(resource(key)); }
  function notify(r) {
    const snap = snapshotOf(r);
    for (const listener of Array.from(r.listeners)) {
      try { listener(snap); } catch (_) { /* one view cannot break the shared resource */ }
    }
  }
  function errorMeta(err) {
    const message = err && err.message ? String(err.message) : String(err || 'query failed');
    return Object.freeze({ message, name: String((err && err.name) || 'Error') });
  }

  function request(key, force) {
    const r = resource(key);
    const fresh = r.hasData && !r.invalidated && !r.error &&
      (r.ttlMs <= 0 || (now() - r.updatedAt) < r.ttlMs);
    if (!force && fresh) return Promise.resolve(snapshotOf(r));
    if (r.inFlight) {
      if (r.inFlightGeneration === r.generation) return r.inFlight;
      // A newer generation owns its own request; an obsolete transport cannot block recovery.
    }

    const generation = r.generation;
    const controller = new AbortController();
    let deadline;
    let p;
    p = Promise.resolve()
      .then(() => Promise.race([
        getJson(r.path, { signal: controller.signal }),
        new Promise((_, reject) => { deadline = setTimeout(() => {
          reject(new Error('Timed out reading ' + r.key + '; retry to refresh'));
          controller.abort();
        }, r.timeoutMs); })
      ]))
      .then(data => {
        if (r.validate && !r.validate(data)) throw new Error('invalid response for ' + r.key);
        if (r.generation !== generation) return data;
        r.data = data;
        r.hasData = true;
        r.updatedAt = now();
        r.invalidated = false;
        r.error = null;
        r.errorAt = 0;
        return data;
      })
      .catch(err => {
        if (r.generation === generation) {
          r.error = errorMeta(err);
          r.errorAt = now();
        }
        throw err;
      })
      .finally(() => {
        clearTimeout(deadline);
        if (r.inFlight === p) r.inFlight = null;
        notify(r);
      })
      .then(() => snapshotOf(r));
    r.inFlight = p;
    r.inFlightGeneration = generation;
    notify(r);
    return p;
  }

  function get(key) { return request(key, false); }
  function refresh(key) { return request(key, true); }
  function invalidate(key, opts) {
    const r = resource(key);
    r.generation++;
    r.invalidated = true;
    notify(r);
    if (opts && opts.refresh) return refresh(key);
    return snapshotOf(r);
  }
  function update(key, data) {
    const r = resource(key);
    if (r.validate && !r.validate(data)) throw new Error('invalid response for ' + r.key);
    r.generation++;
    r.data = data;
    r.hasData = true;
    r.updatedAt = now();
    r.invalidated = false;
    r.error = null;
    r.errorAt = 0;
    notify(r);
    return snapshotOf(r);
  }

  function ensureTimer(r) {
    if (!r.pollMs || !r.listeners.size || r.timer != null) return;
    r.timer = armInterval(() => {
      if (!r.listeners.size) return;
      refresh(r.key).catch(() => {}); // subscribers receive the error-bearing snapshot
    }, r.pollMs);
  }
  function stopTimer(r) {
    if (r.timer == null) return;
    disarmInterval(r.timer);
    r.timer = null;
  }
  function subscribe(key, listener, opts) {
    const r = resource(key);
    if (typeof listener !== 'function') throw new Error('query subscriber required: ' + key);
    r.listeners.add(listener);
    ensureTimer(r);
    if (!opts || opts.immediate !== false) {
      try { listener(snapshotOf(r)); } catch (_) {}
    }
    if (!opts || opts.refresh !== false) get(key).catch(() => {});
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      r.listeners.delete(listener);
      if (!r.listeners.size) stopTimer(r);
    };
  }

  // Shared scheduler truth. A valid response always has the jobs array the sidecar owns.
  define('cron', {
    path: '/api/cron',
    ttlMs: 5000,
    pollMs: 60000,
    validate: data => !!(data && Array.isArray(data.jobs))
  });

  // Durable Commander Journey truth. Polling is shared and subscriber-owned; failed reads keep
  // last-good data with explicit stale/error metadata rather than manufacturing current proof.
  define('journey', {
    path: '/api/journey',
    ttlMs: 12000,
    pollMs: 4000,
    validate: data => !!(data && data.ok && data.journey && typeof data.journey === 'object')
  });

  return {
    define, get, refresh, invalidate, update, subscribe, state,
    _resetForTest() {
      for (const r of resources.values()) {
        stopTimer(r);
        r.hasData = false; r.data = undefined; r.updatedAt = 0; r.invalidated = false;
        r.error = null; r.errorAt = 0; r.generation = 0; r.inFlight = null;
        r.inFlightGeneration = 0; r.listeners.clear();
      }
    },
    _setGetForTest(fn) { getJson = fn; },
    _setClockForTest(fn) { now = fn; },
    _setTimersForTest(setFn, clearFn) { armInterval = setFn; disarmInterval = clearFn; },
    _debug(key) { const r = resource(key); return { listeners: r.listeners.size, timer: r.timer, inFlight: !!r.inFlight }; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuerySpine };
