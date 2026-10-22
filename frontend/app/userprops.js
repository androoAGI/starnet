/* frontend/app/userprops.js — player-made props, page side.
   Boot: fetch the station's made props (GET /api/userprops), fetch each PNG with the API token (a blob URL, so
   the master token never rides in a URL), and register it: PropSprites.registerUserProp (catalog row) +
   PropRemaster.registerRuntime (raster art). Placed made props draw as a dim placeholder until their art is in.
   Make: POST /api/userprops/generate {noun} starts a Agent OS-credits job; watch() polls the station (which polls
   the cloud and keeps the job on disk) until it settles, then loads the new prop. Every number shown to the
   player (cost, tries) is the job state the station reports, never a guess.
   Fires window 'starnet:userprops-changed' whenever the made-prop catalog changes (build.js re-renders). */
'use strict';
const UserProps = (() => {
  const registered = new Set();
  // sizes set on this page, stamped with a sequence number: a load() whose fetch began before a resize finished
  // must not put the older size back (it would repaint the stale value and re-register stale boxes)
  const localScale = new Map();   // id -> { scale, seq }
  let seq = 0;
  const sided = new Set();
  let props = [];
  let loading = null;
  const apiFetch = (url, init) => (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(url, init) : fetch(url, init);
  const changed = () => { try { window.dispatchEvent(new CustomEvent('starnet:userprops-changed', { detail: { count: props.length } })); } catch (_) {} };

  // A made prop's boxes at the player's SIZE. Height scales (floor: the 14px minimum, ceiling: the renderer's 192);
  // footprints scale and round to whole tiles (1..16). Pure: same entry + scale -> same boxes, everywhere.
  const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  function geometry(p, scaleIn) {
    const k = SCALES.includes(Number(scaleIn)) ? Number(scaleIn) : (SCALES.includes(Number(p && p.scale)) ? Number(p.scale) : 1);
    const box = (fp, b) => {
      const w = Math.max(1, Math.min(16, Math.round(fp.w * k))), h = Math.max(1, Math.min(16, Math.round(fp.h * k)));
      const H = Math.max(14, Math.min(192, Math.round(b.height * k)));
      return { footprint: { w, h }, bounds: { x: -2, y: h * 12 - H, width: Math.min(192, w * 12 + 4), height: H } };
    };
    const front = box(p.footprint, p.bounds);
    const side = p.side ? box(p.side.footprint, p.side.bounds) : null;
    return { scale: k, front, side };
  }
  async function decode(id, view) {
    const r = await apiFetch('/api/userprops/image?id=' + encodeURIComponent(id) + (view === 'w' ? '&view=w' : ''));
    if (!r.ok) throw new Error('image ' + r.status);
    const url = URL.createObjectURL(await r.blob());
    const im = new Image();
    try { await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error('decode')); im.src = url; }); }
    catch (e) { URL.revokeObjectURL(url); throw e; }
    return { im, url };
  }
  async function register(p) {
    if (!p || registered.has(p.id) || typeof PropSprites === 'undefined' || !PropSprites.registerUserProp) return false;
    if (!PropSprites.registerUserProp(p)) return false;
    registered.add(p.id);
    if (typeof PropRemaster === 'undefined' || !PropRemaster.registerRuntime) return false;
    let d = null;
    try {
      d = await decode(p.id);
      const g = geometry(p);
      if (g.scale !== 1 && PropSprites.resizeUserProp) PropSprites.resizeUserProp(p.id, g.front.footprint, null);
      const ok = await PropRemaster.registerRuntime(p.id, { image: p.id + '.png', sourceWidth: p.sourceWidth, sourceHeight: p.sourceHeight,
        footprint: g.front.footprint, bounds: g.front.bounds, mode: 'approved', exposure: 1, effects: false }, d.im);
      // A round object looks the same turned: its own front art IS its side view (box turned, same height), free.
      if (ok && p.symmetric && !p.side && PropSprites.registerUserSide) {
        const gf = geometry(p).front, fp = { w: gf.footprint.h, h: gf.footprint.w }, H = gf.bounds.height;
        if (PropSprites.registerUserSide(p.id, { footprint: fp })) {
          sided.add(p.id);
          await PropRemaster.registerRuntime(p.id, { image: p.id + '.png', sourceWidth: p.sourceWidth, sourceHeight: p.sourceHeight, footprint: fp,
            bounds: { x: -2, y: fp.h * 12 - H, width: fp.w * 12 + 4, height: H }, mode: 'approved', exposure: 1, effects: false }, d.im, 'w');
        }
      }
      return ok;
    } catch (_) { return false; }   // the row stays; the prop keeps its placeholder rather than vanishing
    finally { if (d) URL.revokeObjectURL(d.url); }
  }
  // the left-facing side view, once the station has one (made later, from REFIT)
  async function registerSide(p) {
    if (!p || !p.side || sided.has(p.id) || !registered.has(p.id) || !PropSprites.registerUserSide) return false;
    const gs = geometry(p).side;
    if (!PropSprites.registerUserSide(p.id, { footprint: gs.footprint })) return false;
    sided.add(p.id);
    if (typeof PropRemaster === 'undefined' || !PropRemaster.registerRuntime) return false;
    let d = null;
    try {
      d = await decode(p.id, 'w');
      return await PropRemaster.registerRuntime(p.id, { image: p.id + '-w.png', sourceWidth: p.side.sourceWidth, sourceHeight: p.side.sourceHeight,
        footprint: gs.footprint, bounds: gs.bounds, mode: 'approved', exposure: 1, effects: false }, d.im, 'w');
    } catch (_) { return false; }
    finally { if (d) URL.revokeObjectURL(d.url); }
  }
  // load({ fresh: true }) never reuses a load already in flight: one that started before a prop finished would hand back the
  // old list, so station.make_prop's reload said the new prop was not on the page (sweep 2026-10-02)
  function load(opts) {
    if (loading) return (opts && opts.fresh) ? loading.then(() => load(), () => load()) : loading;
    loading = (async () => {
      const startedAt = seq;
      let j = null;
      try { const r = await apiFetch('/api/userprops'); j = r.ok ? await r.json() : null; } catch (_) { j = null; }
      if (j && Array.isArray(j.deleted) && PropSprites.markUserDeleted) PropSprites.markUserDeleted(j.deleted);
      if (j && Array.isArray(j.props)) {
        const before = props.map((p) => p.id).join(',');
        for (const p of j.props) { const l = localScale.get(p.id); if (l && l.seq > startedAt) p.scale = l.scale; }
        props = j.props;
        let any = false;
        for (const p of props) { if (await register(p)) any = true; if (await registerSide(p)) any = true; }
        if (any && PropSprites.userArtChanged) PropSprites.userArtChanged();
        // announce ONLY a real catalog change: build.js re-renders on this, and a panel render itself calls
        // load() to resume a running job — an unconditional event would loop (and wipe what the player typed).
        if (any || props.map((p) => p.id).join(',') !== before) changed();
      }
      return { props: props.slice(), jobs: (j && j.jobs) || [], recent: (j && Array.isArray(j.recent)) ? j.recent : [] };
    })().finally(() => { loading = null; });
    return loading;
  }
  async function generate(noun, previewId) {
    try {
      const r = await apiFetch('/api/userprops/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(previewId ? { noun, previewId } : { noun }) });
      return await r.json();
    } catch (_) { return { ok: false, code: 'unreachable', message: 'The station did not answer. Try again.' }; }
  }
  // SIZE: store the player's size, then re-register the art at it (no regeneration, no credits).
  async function setScale(id, scale) {
    const p = props.find((x) => x.id === id);
    if (!p) return { ok: false, code: 'not_found', message: 'No such made prop.' };
    let j;
    try {
      const r = await apiFetch('/api/userprops/scale', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, scale }) });
      j = await r.json();
    } catch (_) { return { ok: false, code: 'unreachable', message: 'The station did not answer. Try again.' }; }
    if (!j || !j.ok) return j || { ok: false, code: 'failed', message: 'That size could not be saved.' };
    p.scale = j.scale;
    localScale.set(id, { scale: j.scale, seq: ++seq });
    const g = geometry(p);
    PropSprites.resizeUserProp(id, g.front.footprint, g.side && (p.symmetric && !p.side ? null : g.side.footprint));
    let d = null;
    try {
      d = await decode(id);
      await PropRemaster.registerRuntime(id, { image: id + '.png', sourceWidth: p.sourceWidth, sourceHeight: p.sourceHeight, footprint: g.front.footprint, bounds: g.front.bounds, mode: 'approved', exposure: 1, effects: false }, d.im, 's', true);
      if (p.symmetric && !p.side) {
        const fp = { w: g.front.footprint.h, h: g.front.footprint.w }, H = g.front.bounds.height;
        PropSprites.resizeUserProp(id, g.front.footprint, fp);
        await PropRemaster.registerRuntime(id, { image: id + '.png', sourceWidth: p.sourceWidth, sourceHeight: p.sourceHeight, footprint: fp, bounds: { x: -2, y: fp.h * 12 - H, width: Math.min(192, fp.w * 12 + 4), height: H }, mode: 'approved', exposure: 1, effects: false }, d.im, 'w', true);
      }
    } catch (_) { /* the row already has its new box; the art re-registers on the next load */ }
    finally { if (d) URL.revokeObjectURL(d.url); }
    if (p.side) {
      let e = null;
      try {
        e = await decode(id, 'w');
        await PropRemaster.registerRuntime(id, { image: id + '-w.png', sourceWidth: p.side.sourceWidth, sourceHeight: p.side.sourceHeight, footprint: g.side.footprint, bounds: g.side.bounds, mode: 'approved', exposure: 1, effects: false }, e.im, 'w', true);
      } catch (_) {}
      finally { if (e) URL.revokeObjectURL(e.url); }
    }
    if (PropSprites.userArtChanged) PropSprites.userArtChanged();
    return { ok: true, scale: p.scale, geometry: g };
  }
  async function makeSide(id) {
    try {
      const r = await apiFetch('/api/userprops/side', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      return await r.json();
    } catch (_) { return { ok: false, code: 'unreachable', message: 'The station did not answer. Try again.' }; }
  }
  // delete a made prop from the station's library; the caller removes placed copies and the catalog row
  async function remove(id) {
    try {
      const r = await apiFetch('/api/userprops/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const j = await r.json();
      if (j && j.ok) {
        props = props.filter((p) => p.id !== id); registered.delete(id); sided.delete(id);
        // tombstone now (not on the next load): the model's undo filters tombstoned made props, so Ctrl+Z after a
        // delete can never bring back copies of a prop whose art is gone
        if (typeof PropSprites !== 'undefined' && PropSprites.markUserDeleted) PropSprites.markUserDeleted([id]);
      }
      return j;
    } catch (_) { return { ok: false, code: 'unreachable', message: 'The station did not answer. Try again.' }; }
  }
  async function startPreview(noun) {
    try {
      const r = await apiFetch('/api/userprops/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noun }) });
      return await r.json();
    } catch (_) { return { ok: false, code: 'unreachable', message: 'The station did not answer. Try again.' }; }
  }
  // poll one preview until it settles; onUpdate(job) on every change; resolves with { job, preview }
  function watchPreview(id, onUpdate) {
    return new Promise((resolve) => {
      let last = '';
      const tick = async () => {
        let r = null;
        try { r = await (await apiFetch('/api/userprops/preview?id=' + encodeURIComponent(id))).json(); } catch (_) { r = null; }
        if (r && r.ok) {
          const sig = JSON.stringify(r.job);
          if (sig !== last) { last = sig; try { onUpdate && onUpdate(r.job); } catch (_) {} }
          if (r.job.status === 'failed' || r.preview) { resolve(r); return; }
        } else if (r && !r.ok) { resolve(r); return; }
        setTimeout(tick, 1500);
      };
      tick();
    });
  }
  async function job(id) {
    try { const r = await apiFetch('/api/userprops/job?id=' + encodeURIComponent(id)); return await r.json(); }
    catch (_) { return { ok: false, code: 'unreachable' }; }
  }
  // Poll one job until it settles. onUpdate(job) on every change; resolves with the final job.
  function watch(id, onUpdate) {
    return new Promise((resolve) => {
      let last = '', missing = 0;
      const tick = async () => {
        const r = await job(id);
        const j = r && r.ok ? r.job : null;
        // the station no longer knows this job (it settled while it restarted): stop instead of polling forever
        if (!j && r && r.code === 'not_found' && ++missing >= 3) {
          resolve({ id, status: 'failed', costUsd: 0, error: { code: 'lost', message: 'The station lost track of this job. If it finished, it is in MADE BY YOU; check your credit history for its charge.' } });
          return;
        }
        if (j) missing = 0;
        if (j) {
          const sig = JSON.stringify(j);
          if (sig !== last) { last = sig; try { onUpdate && onUpdate(j); } catch (_) {} }
          if (j.status === 'done' || j.status === 'failed') { if (j.status === 'done') await load(); resolve(j); return; }
        }
        setTimeout(tick, 2500);
      };
      tick();
    });
  }
  const list = () => props.slice();
  if (typeof window !== 'undefined') setTimeout(() => { load(); }, 0);
  const get = (id) => props.find((p) => p.id === id) || null;
  return { load, list, get, generate, startPreview, watchPreview, makeSide, remove, setScale, geometry, SCALES, job, watch };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = UserProps;
