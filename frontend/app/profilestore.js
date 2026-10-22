/* AGENT OS — profilestore.js : the live wiring that folds REAL signals into the user-affinity profile.

   The browser half of the profile system (pure engine in profile.js), modelled exactly on xpstore.js:
   it captures the interest tag that classify.js already computes-and-discards on every message, plus
   the strongest behavioral signal — SHIPPED work — read from the U.bus event spine, and folds both into
   the persisted `profile` slice through the pure Profile engine.

   Like xpstore.js it is a READ-ONLY consumer: it NEVER emits on U.bus (the frozen shared/events.js
   contract is owned elsewhere), it only subscribes and acts via direct calls. Everything is gated on the
   user's learning-enabled flag, and it holds only derived counts — never raw prompt text — so it stays
   local-first and privacy-safe by construction. Date.now() lives here (the injection edge); the engine
   stays clock-pure. */
'use strict';
const ProfileStore = (() => {
  let profile = null;
  let persistFn = () => {};
  let wired = false;

  // SHIPPED deliverables are the strongest interest signal (an asked-for topic is weak; a finished one
  // is strong), so they fold at a heavier weight than a raw message tag.
  const FEED = ['workitem.delivered'];
  const SHIP_WEIGHT = 3;

  const now = () => Date.now();
  const ready = () => typeof Profile !== 'undefined' && profile;

  // fold a shipped work-item: tag it by its title (the same classifier the rest of the app uses).
  function onDelivered(payload) {
    if (!ready() || profile.enabled === false || (payload && payload.box === 'line-output')) return;
    const title = (payload && payload.title) || '';
    const tag = (typeof Classify !== 'undefined' && Classify.getTag) ? Classify.getTag(title) : 'general';
    Profile.observe(profile, { tag, weight: SHIP_WEIGHT }, now());
    try { persistFn(); } catch (_) {}   // capture the shipped-work accrual to disk
  }

  function init(opts) {
    opts = opts || {};
    if (opts.persist) persistFn = opts.persist;
    profile = (typeof Profile !== 'undefined')
      ? Profile.hydrate(opts.profile)     // resume the saved slice (or a fresh one) — defensively sanitized
      : (opts.profile || null);
    if (!wired && typeof U !== 'undefined' && U.bus) {
      for (const n of FEED) U.bus.on(n, p => { try { onDelivered(p); } catch (e) { console.warn('[profile]', n, e); } });
      wired = true;
    }
  }

  // the direct hook from chat.js: fold the interest tag of a user TASK message (the signal classify.js
  // already computes at the send path and otherwise throws away). Not persisted here — the per-turn
  // App.persist() that follows every message captures it.
  function observeMessage(text) {
    if (!ready() || profile.enabled === false) return;
    const tag = (typeof Classify !== 'undefined' && Classify.getTag) ? Classify.getTag(text) : 'general';
    Profile.observe(profile, { tag, weight: 1 }, now());
  }

  // a cold-start prior from the awakening (the chosen purpose / specialty domain). Guarded by the engine:
  // first seed wins and only on a profile with no real data yet, so resume never clobbers learning.
  function seed(tag) { if (ready()) Profile.seed(profile, tag); }

  // ---- read surface (Phase 1 UI + the recommender consume these) ----
  function summary() { return ready() ? Profile.summary(profile, now()) : null; }
  function score(itemTags) { return ready() ? Profile.score(profile, itemTags, now()) : 0; }
  function explain(itemTags) { return ready() ? Profile.explain(profile, itemTags, now()) : null; }   // the tag behind a "because you…" line
  function serialize() { return profile || undefined; }   // folded into the save envelope by App.persist()

  // ---- glass-box controls (Phase 1 wires these to the UI) ----
  function setEnabled(on) {
    if (ready()) { Profile.setEnabled(profile, on); try { persistFn(); } catch (_) {} }
    if (!on && typeof StarterStore !== 'undefined') StarterStore.cancel();
    if (typeof Chat !== 'undefined' && Chat.refreshStarters) Chat.refreshStarters();
  }
  function enabled() { return ready() ? profile.enabled !== false : true; }
  function forget() {
    if (typeof Profile !== 'undefined') { profile = Profile.forget(profile || Profile.fresh()); try { persistFn(); } catch (_) {} }
    if (typeof StarterStore !== 'undefined') StarterStore.reset();
    if (typeof Chat !== 'undefined' && Chat.refreshStarters) Chat.refreshStarters();
  }

  return { init, observeMessage, seed, summary, score, explain, serialize, setEnabled, enabled, forget };
})();
