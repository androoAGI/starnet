/* sidecar/userprops.js — player-made props: the station asks the StarNet cloud to generate a prop from a noun
   (paid from StarNet credits), then keeps the result locally so it survives restarts and relinks.

   Contract with the cloud (starnet-cloud src/propgen.js):
     POST {cloud}/v1/props/generate {noun}         -> 202 {job}  | 402 insufficient credits | 429 busy/rate | 400 bad noun
     GET  {cloud}/v1/props/jobs/:id                -> 200 {job}  (job.status queued|running|done|failed, costUsd = real debits)
   Auth is the linked device token (Bearer), the same one managed inference uses.

   A PAID PROP IS NEVER LOST. Every paid start is written to pending.json BEFORE the cloud is asked, under a client
   key the cloud dedupes on: a start that timed out is retried with the same key by the poller (never a second charge),
   and a second click finds the first claim and is refused. A background poller keeps asking until the job settles,
   across window closes and sidecar restarts (the cloud keeps finished props for two weeks and refunds jobs a restart
   cut off). A LOCAL failure to save a finished prop (a locked or unreadable file) keeps the job pending and retries;
   only art that fails validation is dropped. Finished props land in WORKSPACES/.userprops/<id>.png + index.json. The
   folder is dot-prefixed, so it can never be an agent id and /api/file can never serve it; the PNG has its own route.

   Pure factory: fs, path, fetch, clock and timers are injected (lint-determinism). index.js composes it.

   makeUserProps({ fs, path, dir, cloud: () => ({ url, token }), fetch, now, setTimer, clearTimer,
                   writeDurable(deps, file, data), onSettled? }) ->
   JSON goes through durable-store's readJsonResilient/writeJsonResilient (.bak recovery, refuse-to-clobber);
   the PNG through the injected durable writer (index.js passes the update-freeze-aware writeFileDurable).
     { list(), imageFile(id), start(noun), job(id), resume(), stop() } */
'use strict';
const { readJsonResilient, writeJsonResilient } = require('./durable-store.js');
const { swallow, note } = require('./failopen.js');   // a swallowed error stays visible (tagged warn + counter)

const ID_RE = /^user_[a-z0-9_]{3,60}$/;
const POLL_MS = 4000;
const START_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 10000;
const MAX_PNG_BYTES = 4 << 20;
const START_RETRY_MS = 10 * 60 * 1000;   // a start the cloud never answered is retried (same key) for this long
const RECENT_MS = 24 * 60 * 60 * 1000;   // settled jobs are remembered this long, so a failure while REFIT was closed is shown

function slugOf(noun) {
  return String(noun || '').toLowerCase().replace(/^(a|an|the)\s+/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'prop';
}
function isPropId(id) { return ID_RE.test(String(id || '')); }
function finiteNum(v, lo, hi) { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi; }
// The cloud is trusted to generate, not to write arbitrary files: every field that reaches disk or the renderer
// is re-validated against the renderer's own limits (propremaster.js validate()).
function validResult(r) {
  if (!r || typeof r !== 'object') return false;
  const f = r.footprint || {}, b = r.bounds || {};
  return Number.isInteger(f.w) && Number.isInteger(f.h) && f.w >= 1 && f.w <= 16 && f.h >= 1 && f.h <= 16 &&
    finiteNum(b.x, -192, 192) && finiteNum(b.y, -192, 192) && finiteNum(b.width, 0.01, 192) && finiteNum(b.height, 0.01, 192) &&
    Number.isInteger(r.sourceWidth) && Number.isInteger(r.sourceHeight) && r.sourceWidth >= 1 && r.sourceWidth <= 4096 && r.sourceHeight >= 1 && r.sourceHeight <= 4096 &&
    typeof r.png === 'string' && r.png.length > 0 && typeof r.label === 'string';
}
function isPng(buf) { return buf && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a; }

function makeUserProps(deps) {
  const { fs, path, dir, cloud, now } = deps;
  const doFetch = deps.fetch;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const writeDurable = deps.writeDurable || ((d, file, data) => { fs.writeFileSync(file + '.tmp', data); fs.renameSync(file + '.tmp', file); });
  const indexFile = path.join(dir, 'index.json');
  const pendingFile = path.join(dir, 'pending.json');
  const recentFile = path.join(dir, 'recent.json');
  const newKey = deps.randomKey || (() => 'ck_' + require('node:crypto').randomBytes(12).toString('hex'));
  const live = new Map();       // jobId -> last public job state (for the UI)
  let timer = null, polling = false, stopped = false, chain = Promise.resolve();

  // mkdir failing here is not fatal by itself: the durable write right after it fails loudly if the folder is truly unusable
  function ensureDir() { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { note('userprops.mkdir', e); } }
  // absent -> fallback; recovered from .bak -> that value; unreadable/corrupt -> fallback for DISPLAY reads only.
  function readJson(file, fallback) {
    const r = readJsonResilient({ fs }, file);
    return r.value && typeof r.value === 'object' ? r.value : fallback;
  }
  // A read that a WRITE will be built on: a corrupt or unreadable file throws instead of reading as empty, so a
  // mutation can never replace two paid jobs (or the whole prop list) with one new entry.
  function readForWrite(file, fallback) {
    const r = readJsonResilient({ fs }, file);
    if (r.status === 'corrupt' || r.status === 'unreadable') { const e = new Error(path.basename(file) + ' is ' + r.status); e.code = 'state_unreadable'; throw e; }
    return r.value && typeof r.value === 'object' ? r.value : fallback;
  }
  function listW() { const idx = readForWrite(indexFile, { props: [] }); return (Array.isArray(idx.props) ? idx.props : []).filter((p) => p && isPropId(p.id)); }
  function deletedW() { const idx = readForWrite(indexFile, { props: [] }); return (Array.isArray(idx.deleted) ? idx.deleted : []).filter(isPropId); }
  function pendingW() { const p = readForWrite(pendingFile, { jobs: [] }); return Array.isArray(p.jobs) ? p.jobs : []; }
  function writeJson(file, value) {
    ensureDir();
    writeJsonResilient({ fs, path, writeDurable }, file, value);
  }
  // serialize every index/pending mutation (single sidecar per WORKSPACES; in-process order is enough)
  // the CALLER gets p's rejection; the chain itself must keep going after a failed step
  function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(swallow('userprops.serial')); return p; }

  function list() {
    const idx = readJson(indexFile, { props: [] });
    return (Array.isArray(idx.props) ? idx.props : []).filter((p) => p && isPropId(p.id));
  }
  // view 's' (front, <id>.png) or 'w' (the left-facing side view, <id>-w.png). Anything else is refused.
  function imageFile(id, view) {
    if (!isPropId(id)) return null;
    if (view != null && view !== 's' && view !== 'w') return null;
    const f = path.join(dir, id + (view === 'w' ? '-w' : '') + '.png');
    return f.startsWith(dir) ? f : null;
  }
  // ids the player deliberately deleted. The page must NOT keep these in a save (made props are otherwise protected
  // from pruning), or a copy in another crew member's station would linger as a placeholder forever.
  function deleted() {
    const idx = readJson(indexFile, { props: [] });
    return (Array.isArray(idx.deleted) ? idx.deleted : []).filter(isPropId);
  }
  function pending() { const p = readJson(pendingFile, { jobs: [] }); return Array.isArray(p.jobs) ? p.jobs : []; }
  // settled jobs (last 24h, newest first): the page shows a failure it did not see happen (REFIT was closed)
  function recent() { const r = readJson(recentFile, { jobs: [] }); const t = now(); return (Array.isArray(r.jobs) ? r.jobs : []).filter((j) => j && t - (Number(j.at) || 0) < RECENT_MS); }
  function remember(pub) {
    try { writeJson(recentFile, { jobs: [{ id: pub.id, noun: pub.noun, kind: pub.kind || 'front', status: pub.status, error: pub.error || null, costUsd: Number(pub.costUsd) || 0, propId: pub.propId || null, at: now() }].concat(recent().filter((j) => j.id !== pub.id)).slice(0, 12) }); }
    catch (e) { note('userprops.recent', e); }   // a missed history line never blocks a landing
  }

  function cloudCfg() {
    const c = (cloud && cloud()) || {};
    const url = String(c.url || '').replace(/\/+$/, '');
    return url && c.token ? { url, token: String(c.token) } : null;
  }
  async function request(method, url, token, body, timeoutMs) {
    const ac = new AbortController();
    const t = setTimer(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      let j = null; try { j = await res.json(); } catch (_) { j = null; }
      return { status: res.status, ok: res.ok, j };
    } finally { clearTimer(t); }
  }

  // ---- PREVIEW before paying: the cloud sizes the object and draws a quick concept sketch. Kept in memory only
  // (a preview is a few cents and is never a prop); making it hands the cloud the approved sizing + sketch.
  const previews = new Map();   // cloud job id -> { noun, job, result }
  async function startPreview(rawNoun) {
    const noun = String(rawNoun == null ? '' : rawNoun).replace(/\s+/g, ' ').trim();
    if (!noun) return { ok: false, code: 'empty', message: 'Describe an object.' };
    if (noun.length > 60) return { ok: false, code: 'too_long', message: 'Keep it under 60 characters.' };
    const c = cloudCfg();
    if (!c) return { ok: false, code: 'not_linked', message: 'Making props uses StarNet credits. Link this station under SETTINGS \u2192 AI & MODELS first.' };
    let r;
    try { r = await request('POST', c.url + '/v1/props/preview', c.token, { noun }, START_TIMEOUT_MS); }
    catch (e) { note('userprops.preview.start', e); return { ok: false, code: 'unreachable', message: 'StarNet could not be reached. Check your connection and try again.' }; }
    const cloudMsg = r.j && r.j.error && r.j.error.message ? String(r.j.error.message).slice(0, 200) : '';
    if (r.status === 402) return { ok: false, code: 'insufficient_credits', message: cloudMsg && /at least/.test(cloudMsg) ? cloudMsg + ' Top up under SETTINGS \u2192 AI & MODELS.' : 'Out of StarNet credits. Top up under SETTINGS \u2192 AI & MODELS.' };
    if (r.status === 401 || r.status === 403) return { ok: false, code: 'not_linked', message: 'This station\u2019s StarNet link is no longer valid. Relink it under SETTINGS \u2192 AI & MODELS.' };
    if (r.status === 429) return { ok: false, code: 'busy', message: cloudMsg || 'Too many props right now. Try again shortly.' };
    if (r.status === 400) return { ok: false, code: (r.j && r.j.error && r.j.error.code) || 'invalid', message: cloudMsg || 'That description was not accepted.' };
    if (r.status === 404) return { ok: false, code: 'unsupported', message: 'Your StarNet account server does not offer previews yet.' };
    const job = r.j && r.j.job;
    if (!r.ok || !job || typeof job.id !== 'string' || !/^pj_[A-Za-z0-9]{8,64}$/.test(job.id)) return { ok: false, code: 'cloud_error', message: cloudMsg || 'StarNet could not start that preview.' };
    if (previews.size > 40) previews.delete(previews.keys().next().value);
    previews.set(job.id, { noun, job: publicJob(job), result: null });
    return { ok: true, job: { ...publicJob(job), noun, kind: 'preview' } };
  }
  // Poll one preview (on demand: previews are short). The page gets the sketch as a data URL.
  async function preview(id) {
    const pv = previews.get(String(id || ''));
    if (!pv) return { ok: false, code: 'not_found', message: 'No such preview.' };
    if (!pv.result && pv.job.status !== 'failed') {
      const c = cloudCfg();
      if (c) {
        try {
          const r = await request('GET', c.url + '/v1/props/jobs/' + encodeURIComponent(id), c.token, null, POLL_TIMEOUT_MS);
          const job = r.j && r.j.job;
          if (r.status === 404) pv.job = { ...pv.job, status: 'failed', error: { code: 'lost', message: 'StarNet lost track of this preview. Make a new one.' } };
          else if (r.ok && job) {
            pv.job = publicJob(job);
            const res = job.result;
            if (job.status === 'done' && res && res.size && typeof res.sketch === 'string') {
              const png = Buffer.from(res.sketch, 'base64');
              if (isPng(png) && png.length < MAX_PNG_BYTES) pv.result = { label: String(res.label || '').slice(0, 24), size: { fp: String(res.size.fp || ''), height: Number(res.size.height) || 0, like: String(res.size.like || '').slice(0, 80), symmetric: res.size.symmetric === true, profile: res.size.profile === true }, sketch: res.sketch };
              else pv.job = { ...pv.job, status: 'failed', error: { code: 'bad_result', message: 'StarNet returned a preview this station could not use.' } };
            }
          }
        } catch (e) { note('userprops.preview.poll', e); }   // offline: the page asks again
      }
    }
    return { ok: true, job: { ...pv.job, noun: pv.noun }, preview: pv.result ? { label: pv.result.label, footprint: pv.result.size.fp, height: pv.result.size.height, like: pv.result.size.like, symmetric: pv.result.size.symmetric, profile: pv.result.size.profile, sketch: 'data:image/png;base64,' + pv.result.sketch } : null };
  }
  // The cloud's answer to a paid start, as { ok, job } or { ok:false, code, message, final }. `final` = a definitive
  // refusal (nothing was started, the claim can go); otherwise the start MAY have been accepted and is retried.
  function startAnswer(r, what) {
    const cloudMsg = r.j && r.j.error && r.j.error.message ? String(r.j.error.message).slice(0, 200) : '';
    if (r.status === 402) return { ok: false, final: true, code: 'insufficient_credits', message: cloudMsg && /at least/.test(cloudMsg) ? cloudMsg + ' Top up under SETTINGS \u2192 AI & MODELS.' : 'Out of StarNet credits. Top up under SETTINGS \u2192 AI & MODELS.' };
    if (r.status === 401) return { ok: false, final: true, code: 'not_linked', message: 'This station\u2019s StarNet link is no longer valid. Relink it under SETTINGS \u2192 AI & MODELS.' };
    if (r.status === 403) return { ok: false, final: true, code: (r.j && r.j.error && r.j.error.code) || 'not_linked', message: cloudMsg || 'This station\u2019s StarNet link is no longer valid. Relink it under SETTINGS \u2192 AI & MODELS.' };
    if (r.status === 429) return { ok: false, final: true, code: 'busy', message: cloudMsg || 'Too many props right now. Try again shortly.' };
    if (r.status === 400 || r.status === 413) return { ok: false, final: true, code: (r.j && r.j.error && r.j.error.code) || 'invalid', message: cloudMsg || 'That description was not accepted.' };
    if (r.status === 404) return { ok: false, final: true, code: 'unsupported', message: 'Your StarNet account server does not offer ' + what + ' yet.' };
    const job = r.j && r.j.job;
    if (!r.ok || !job || typeof job.id !== 'string' || !/^pj_[A-Za-z0-9]{8,64}$/.test(job.id)) return { ok: false, final: r.status >= 400 && r.status < 500, code: 'cloud_error', message: cloudMsg || 'StarNet could not start that ' + what + '.' };
    return { ok: true, job };
  }
  // Claim -> ask -> record. The claim (pending entry with a client key, no cloud id yet) is written atomically with the
  // duplicate check BEFORE the network call; the cloud dedupes on the key, so a retried POST returns the same job.
  async function paidStart(claim, endpoint, body, what, isDuplicate) {
    const c = cloudCfg();
    if (!c) return { ok: false, code: 'not_linked', message: 'Making props uses StarNet credits. Link this station under SETTINGS \u2192 AI & MODELS first.' };
    const key = newKey();
    const entry = { ...claim, key, status: 'starting', startedAt: now(), endpoint, body };
    const claimed = await serial(() => {
      const jobs = pendingW();
      if (isDuplicate && jobs.some(isDuplicate)) return false;
      writeJson(pendingFile, { jobs: jobs.concat([entry]) });
      return true;
    }).catch((e) => { note('userprops.claim', e); return null; });
    if (claimed === null) return { ok: false, code: 'state_unreadable', message: 'Your made-props list could not be read, so nothing was started. Nothing was charged.' };
    if (!claimed) return { ok: false, code: 'busy', message: 'That is already being made.' };
    let r;
    try { r = await request('POST', c.url + endpoint, c.token, { ...body, clientKey: key }, START_TIMEOUT_MS); }
    catch (e) {
      note('userprops.start', e);   // no answer: it may have started. The poller retries with the same key (never a second charge)
      schedule(POLL_MS);   // ...starting NOW: the poller used to wait for the next sidecar boot, then drop it unasked (sweep 10-02)
      return { ok: false, code: 'unreachable', pendingKey: key, message: 'StarNet did not answer in time. If it started, it will still arrive in MADE BY YOU \u2014 you are never charged twice.' };
    }
    const a = startAnswer(r, what);
    if (!a.ok) {
      if (a.final) await serial(() => writeJson(pendingFile, { jobs: pendingW().filter((j) => j.key !== key) })).catch((e) => note('userprops.unclaim', e));
      else schedule(POLL_MS);   // a retryable answer (a 5xx): the claim stays and the poller asks again with the same key
      return { ok: false, code: a.code, message: a.message };
    }
    await adopt(key, a.job).catch((e) => note('userprops.adopt', e));   // if this write fails the claim stays and the poller adopts it
    live.set(a.job.id, { ...publicJob(a.job), noun: claim.noun, kind: claim.kind || 'front', propId: claim.propId || null });
    schedule(0);
    return { ok: true, job: live.get(a.job.id) };
  }
  // a claim the cloud accepted becomes a polled job (the body is dropped: it can hold a PNG)
  function adopt(key, job) {
    return serial(() => writeJson(pendingFile, { jobs: pendingW().map((j) => j.key === key && !j.id ? { id: job.id, noun: j.noun, kind: j.kind, propId: j.propId, key, startedAt: j.startedAt } : j) }));
  }
  async function start(rawNoun, previewId) {
    const noun = String(rawNoun == null ? '' : rawNoun).replace(/\s+/g, ' ').trim();
    if (!noun) return { ok: false, code: 'empty', message: 'Describe an object.' };
    if (noun.length > 60) return { ok: false, code: 'too_long', message: 'Keep it under 60 characters.' };
    const pv = previewId ? previews.get(String(previewId)) : null;
    const body = pv && pv.result && pv.noun === noun ? { noun, preview: { size: pv.result.size, sketch: pv.result.sketch } } : { noun };
    // a start StarNet has not answered yet (same object) is still in flight: a second click must not send a NEW key
    // (a second charge) — the poller is still asking about the first
    return paidStart({ noun, kind: 'front' }, '/v1/props/generate', body, 'prop making', (j) => !j.id && (j.kind || 'front') === 'front' && j.noun === noun);
  }

  function publicJob(j) {
    return { id: j.id, noun: j.noun, status: j.status, step: j.step, tries: j.tries || 0, maxTries: j.maxTries || 3,
      costUsd: Number(j.costUsd) || 0, costPending: !!j.costPending, error: j.error ? { code: String(j.error.code || 'failed'), message: String(j.error.message || '').slice(0, 240) } : null, propId: j.propId || null };
  }

  async function land(jobId, noun, result, costUsd) {
    return serial(() => {
      const existing = listW().find((p) => p.jobId === jobId);
      if (existing) return existing;   // idempotent: a second poll of a finished job never duplicates the prop
      const png = Buffer.from(result.png, 'base64');
      if (!isPng(png) || png.length > MAX_PNG_BYTES || png.readUInt32BE(16) !== result.sourceWidth || png.readUInt32BE(20) !== result.sourceHeight) throw Object.assign(new Error('bad prop image'), { code: 'bad_image' });
      const id = 'user_' + slugOf(noun) + '_' + jobId.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, '0');
      ensureDir();
      writeDurable({ fs, path }, path.join(dir, id + '.png'), png);
      const entry = { id, jobId, noun, label: String(result.label).slice(0, 24), like: String(result.like || '').slice(0, 80), symmetric: result.symmetric === true, profile: result.profile === true,
        footprint: { w: result.footprint.w, h: result.footprint.h }, bounds: { x: result.bounds.x, y: result.bounds.y, width: result.bounds.width, height: result.bounds.height },
        sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight, costUsd: Number(costUsd) || 0, createdAt: now() };
      const props = listW().concat([entry]);
      writeJson(indexFile, { version: 1, props, deleted: deletedW() });
      return entry;
    });
  }

  // ---- SIDE VIEW: turn a made prop's accepted front view into its left-facing side view (the cloud keeps the
  // height; the station stores <id>-w.png and the side footprint on the index entry). Same pending ledger.
  async function startSide(propId) {
    const entry = list().find((p) => p.id === propId);
    if (!entry) return { ok: false, code: 'not_found', message: 'No such made prop.' };
    if (entry.side) return { ok: false, code: 'exists', message: 'This prop already has a side view.' };
    if (entry.symmetric) return { ok: false, code: 'symmetric', message: 'This prop looks the same from every side, so it already turns for free.' };
    let png;
    try { png = fs.readFileSync(imageFile(propId)); } catch (e) { note('userprops.side.read', e); return { ok: false, code: 'missing_art', message: 'This prop\u2019s front view is missing on disk.' }; }
    const r = await paidStart({ noun: entry.noun, kind: 'side', propId }, '/v1/props/side',
      { noun: entry.noun, front: { png: png.toString('base64'), footprint: entry.footprint, bounds: { height: entry.bounds.height }, profile: entry.profile === true } }, 'side view',
      (j) => j.kind === 'side' && j.propId === propId);
    if (!r.ok && r.code === 'busy' && !/Too many|right now/.test(r.message)) return { ok: false, code: 'busy', message: 'A side view for this prop is already being made.' };
    return r;
  }
  function validSide(r) {
    return !!r && r.view === 'w' && validResult({ ...r, label: 'side' });
  }
  async function landSide(propId, jobId, result, costUsd) {
    return serial(() => {
      const props = listW();
      const entry = props.find((p) => p.id === propId);
      if (!entry) throw Object.assign(new Error('prop gone'), { code: 'prop_gone' });
      if (entry.side) return entry;   // idempotent
      const png = Buffer.from(result.png, 'base64');
      if (!isPng(png) || png.length > MAX_PNG_BYTES || png.readUInt32BE(16) !== result.sourceWidth || png.readUInt32BE(20) !== result.sourceHeight) throw Object.assign(new Error('bad side image'), { code: 'bad_image' });
      writeDurable({ fs, path }, imageFile(propId, 'w'), png);
      entry.side = { jobId, footprint: { w: result.footprint.w, h: result.footprint.h }, bounds: { x: result.bounds.x, y: result.bounds.y, width: result.bounds.width, height: result.bounds.height },
        sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight, costUsd: Number(costUsd) || 0, createdAt: now() };
      writeJson(indexFile, { version: 1, props, deleted: deletedW() });
      return entry;
    });
  }
  // The player's SIZE for a made prop (library-wide). Only a number is stored; the page derives the box from it.
  const SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  async function setScale(propId, scale) {
    if (!isPropId(propId)) return { ok: false, code: 'bad_id', message: 'No such made prop.' };
    const s = Number(scale);
    if (!SCALES.includes(s)) return { ok: false, code: 'bad_scale', message: 'Pick a size from 50% to 300%.' };
    return serial(() => {
      const props = listW();
      const entry = props.find((p) => p.id === propId);
      if (!entry) return { ok: false, code: 'not_found', message: 'No such made prop.' };
      entry.scale = s;
      writeJson(indexFile, { version: 1, props, deleted: deletedW() });
      return { ok: true, id: propId, scale: s };
    });
  }
  // Delete a made prop: its files and index entry go, its id is tombstoned. Refused while a job for it runs.
  // Credits already spent are not refunded (the cloud billed real upstream work) — the page says so.
  async function remove(propId) {
    if (!isPropId(propId)) return { ok: false, code: 'bad_id', message: 'No such made prop.' };
    return serial(() => {
      if (pendingW().some((j) => j.propId === propId)) return { ok: false, code: 'busy', message: 'A side view for this prop is still being made. Delete it once that finishes.' };
      const props = listW();
      if (!props.some((p) => p.id === propId)) return { ok: false, code: 'not_found', message: 'No such made prop.' };
      writeJson(indexFile, { version: 1, props: props.filter((p) => p.id !== propId), deleted: deletedW().concat([propId]).slice(-500) });
      for (const v of ['s', 'w']) { try { fs.rmSync(imageFile(propId, v), { force: true }); } catch (e) { note('userprops.remove.file', e); } }
      return { ok: true, id: propId };
    });
  }

  async function dropPending(pred) { await serial(() => writeJson(pendingFile, { jobs: pendingW().filter((j) => !pred(j)) })).catch((e) => note('userprops.unpending', e)); }
  async function pollOnce() {
    const c = cloudCfg();
    const jobs = pending();
    if (!c || !jobs.length) return jobs.length;
    for (const pj of jobs) {
      // a start the cloud never answered: ask again with the SAME key (the cloud returns the job it may already have)
      if (!pj.id) {
        if (now() - (Number(pj.startedAt) || 0) > START_RETRY_MS) { await dropPending((j) => j.key === pj.key); remember({ id: pj.key, noun: pj.noun, kind: pj.kind, status: 'failed', error: { code: 'unanswered', message: 'StarNet never confirmed this start, so nothing arrived. If it was charged, the charge shows in your credit history.' } }); continue; }
        let rs;
        try { rs = await request('POST', c.url + pj.endpoint, c.token, { ...(pj.body || { noun: pj.noun }), clientKey: pj.key }, START_TIMEOUT_MS); }
        catch (e) { note('userprops.start.retry', e); continue; }
        const a = startAnswer(rs, 'prop');
        if (a.ok) { await adopt(pj.key, a.job).catch((e) => note('userprops.adopt', e)); live.set(a.job.id, { ...publicJob(a.job), noun: pj.noun, kind: pj.kind || 'front', propId: pj.propId || null }); }
        else if (a.final) { await dropPending((j) => j.key === pj.key); remember({ id: pj.key, noun: pj.noun, kind: pj.kind, status: 'failed', error: { code: a.code, message: a.message } }); }
        continue;
      }
      let r;
      try { r = await request('GET', c.url + '/v1/props/jobs/' + encodeURIComponent(pj.id), c.token, null, POLL_TIMEOUT_MS); }
      catch (e) { note('userprops.poll', e); continue; }   // offline: keep the job, try again next tick
      if (r.status === 404) {
        // the cloud has no record of it any more (it keeps finished props for two weeks and refunds interrupted jobs)
        const lost = { ...(live.get(pj.id) || { id: pj.id, noun: pj.noun }), kind: pj.kind || 'front', status: 'failed', error: { code: 'lost', message: 'StarNet no longer has a record of this job. Check your credit history for its charge.' } };
        live.set(pj.id, lost);
        await dropPending((j) => j.id === pj.id);
        remember(lost);
        continue;
      }
      const job = r.j && r.j.job;
      if (!r.ok || !job) continue;
      const pub = { ...publicJob(job), noun: pj.noun };
      if (pj.kind === 'side') { pub.kind = 'side'; pub.propId = pj.propId; }
      // Landing: art that fails validation is dropped (it can never land); a LOCAL failure to save it (a locked or
      // unreadable file, a write frozen during an update) keeps the paid job pending and is retried next tick.
      let keep = false;
      const landFail = (e, what) => {
        if (e && (e.code === 'bad_image')) { pub.status = 'failed'; pub.error = { code: 'bad_result', message: 'StarNet returned ' + what + ' this station could not use.' }; return; }
        if (e && e.code === 'prop_gone') { pub.status = 'failed'; pub.error = { code: 'prop_gone', message: 'The prop was deleted before its side view arrived.' }; return; }
        note('userprops.land', e);
        keep = true; pub.status = 'running'; pub.step = 'saving'; pub.error = null;
      };
      if (job.status === 'done' && pj.kind === 'side') {
        if (!validSide(job.result)) { pub.status = 'failed'; pub.error = { code: 'bad_result', message: 'StarNet returned a side view this station could not use.' }; }
        else {
          try { await landSide(pj.propId, pj.id, job.result, job.costUsd); }
          catch (e) { landFail(e, 'a side view'); }
        }
      } else if (job.status === 'done') {
        if (!validResult(job.result)) { pub.status = 'failed'; pub.error = { code: 'bad_result', message: 'StarNet returned a prop this station could not use.' }; }
        else {
          try { const entry = await land(pj.id, pj.noun, job.result, job.costUsd); pub.propId = entry.id; }
          catch (e) { landFail(e, 'a prop'); }
        }
      }
      live.set(pj.id, pub);
      if (!keep && (pub.status === 'done' || pub.status === 'failed')) {
        await dropPending((j) => j.id === pj.id);
        remember(pub);
        if (deps.onSettled) { try { deps.onSettled(pub); } catch (e) { note('userprops.onSettled', e); } }
      }
    }
    return pending().length;
  }

  function schedule(ms) {
    if (stopped || timer) return;
    timer = setTimer(async () => {
      timer = null;
      if (polling) return schedule(POLL_MS);
      polling = true;
      let left = 0;
      try { left = await pollOnce(); } catch (e) { note('userprops.pollOnce', e); left = pending().length; }
      polling = false;
      if (left) schedule(POLL_MS);
    }, ms);
  }

  function job(id) {
    if (live.has(id)) return live.get(id);
    const pj = pending().find((j) => j.id === id || (!j.id && j.key === id));
    if (pj) return { id, noun: pj.noun, kind: pj.kind || 'front', status: 'running', step: pj.id ? 'waiting' : 'starting', tries: 0, maxTries: 3, costUsd: 0, costPending: false, error: null, propId: pj.propId || null };
    const settled = recent().find((j) => j.id === id);
    if (settled) return { id, noun: settled.noun, kind: settled.kind || 'front', status: settled.status, step: settled.status, tries: 0, maxTries: 3, costUsd: settled.costUsd, costPending: false, error: settled.error, propId: settled.propId || null };
    const sided = list().find((p) => p.side && p.side.jobId === id);
    if (sided) return { id, noun: sided.noun, kind: 'side', status: 'done', step: 'done', tries: 0, maxTries: 3, costUsd: sided.side.costUsd, costPending: false, error: null, propId: sided.id };
    const landed = list().find((p) => p.jobId === id);
    return landed ? { id, noun: landed.noun, status: 'done', step: 'done', tries: 0, maxTries: 3, costUsd: landed.costUsd, costPending: false, error: null, propId: landed.id } : null;
  }

  function resume() { if (pending().length) schedule(0); }
  function stop() { stopped = true; if (timer) { clearTimer(timer); timer = null; } }
  function activeJobs() { return pending().map((pj) => job(pj.id || pj.key)).filter(Boolean); }
  // settled jobs of the last 24h (newest first) for the page to report what happened while REFIT was closed
  function recentJobs() { return recent(); }

  return { list, deleted, remove, setScale, imageFile, start, startPreview, preview, startSide, job, activeJobs, recentJobs, resume, stop, pollOnce, _internals: { slugOf, validResult, isPropId } };
}

module.exports = { makeUserProps, isPropId };
