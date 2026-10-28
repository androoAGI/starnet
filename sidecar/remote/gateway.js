/* sidecar/remote/gateway.js — the fixed menu a paired phone may order from.

   The sidecar has ~300 HTTP routes, all built for a loopback page that holds the master token. A phone gets
   NONE of them. It gets this list of verbs, each validated and clamped here and executed by a `host` object
   that index.js builds from the same in-process functions the desktop uses. Anything not on this list does
   not exist as far as a phone is concerned. There is no "forward this HTTP request" verb and never will be.

     const gw = makeGateway({ host, approvals, now })
     await gw.call(msg, ctx) -> { ok:true, data } | { ok:false, error } (a voice verb's failure may add { code, terminal, outcome })
       msg = { verb, args }      ctx = { deviceId, sessionId }

   VERBS
     status                          crew, live runs, the needs-you count
     threads   { agentId?, limit? }  recent conversations (newest first)
     thread    { streamId, limit? }  one conversation's turns, oldest first
     send      { agentId, text, streamId?, voice? }   start a task; the run lives on the station, not on this socket
                                     (voice: spoken on a voice-only device: the reply is shaped to be heard)
     stop      { runId }             abort a live run, all the way to the provider
     approvals                       every open approval and question on the station
     decide    { runId, promptId, decision }   once | session | deny   (never always / full from a phone)
     reply     { runId, promptId, text }       answer an agent's question
     seen      { runId, promptId }             the phone showed it to a human: one bounded extension
     files     { limit?, query? }    recent deliverables
     fetch     { agentId, path, offset?, length? }   read a file in sealed chunks (≤ 256 KB each)
     view      { have?, at?, offset?, length? }   the station picture the desk last drew, in sealed chunks
     portrait  { agentId }           that agent's sprite
     sprite    { key }               every drawing of one sprite track ("<set>.<track>.<facing>"), for the live crew
     activity  { limit? }            what is running now and what finished, newest first
     pushKey                         the station's push key + whether THIS phone is subscribed
     pushOn    { endpoint, keys }    subscribe this phone to the station's notifications
     pushOff                         unsubscribe this phone
     pushTest                        send this phone one notification now
     hear      { utt, part, frames, frameMs?, last? }   a device's spoken request, Opus frames in order -> { text }
     speak     { text }              say a reply in the station's voice -> { id, mime, bytes }
     speech    { id, offset?, length? }   that reply's audio in sealed chunks (≤ 64 KB each)
     routines                        scheduled routines
     routine   { jobId, enabled }    pause or resume one
     ping                            liveness; the phone's link lamp reads this

   Errors are plain sentences a person can act on. A host that throws never takes the gateway down. */
'use strict';

const MAX_TEXT = 8000;
const MAX_CHUNK = 256 * 1024;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const STREAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

function makeGateway(deps) {
  const host = deps.host;
  const approvals = deps.approvals;
  const now = deps.now;
  if (typeof now !== 'function') throw new Error('makeGateway needs an injected clock (deps.now)');

  const bad = (error) => ({ ok: false, error });
  const good = (data) => ({ ok: true, data: data === undefined ? null : data });
  const id = (v) => { const s = String(v == null ? '' : v); return ID_RE.test(s) ? s : ''; };
  const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  const voiceCall = async (verb, a, ctx) => {
    if (!deps.voice) return bad('this station cannot do voice');
    if (!ctx || !ctx.deviceId) return bad('unknown device');
    const r = await deps.voice[verb](ctx.deviceId, a);
    if (r && r.ok) return good(r.data);
    const out = bad((r && r.error) || 'voice failed');
    // the typed SpeechOutcome (sidecar/speech-outcome.js) rides along ADDITIVELY: { code, terminal, outcome } beside the
    // sentence, so the device is told WHICH failure (a device that reads only `error` is unchanged)
    if (r && r.outcome && typeof r.outcome === 'object' && r.outcome.code) {
      out.code = String(r.outcome.code);
      out.terminal = !!r.outcome.terminal;
      out.outcome = r.outcome;
    }
    return out;
  };

  const VERBS = {
    async ping() { return good({ at: now() }); },

    async status() {
      const s = await host.status();
      return good(Object.assign({}, s, { approvals: approvals.size() }));
    },

    async threads(a) {
      const agentId = a.agentId == null || a.agentId === '' ? '' : id(a.agentId);
      if (a.agentId && !agentId) return bad('unknown agent');
      return good(await host.threads({ agentId, limit: clampInt(a.limit, 1, 300, 20) }));
    },

    async thread(a) {
      const streamId = String(a.streamId || '');
      if (!STREAM_RE.test(streamId)) return bad('unknown conversation');
      return good(await host.thread({ streamId, limit: clampInt(a.limit, 1, 200, 60), before: clampInt(a.before, 0, 100000, 0), page: a.page === true }));
    },

    async send(a, ctx) {
      const agentId = id(a.agentId);
      if (!agentId) return bad('choose an agent first');
      const text = String(a.text == null ? '' : a.text).trim();
      if (!text) return bad('the message is empty');
      if (text.length > MAX_TEXT) return bad('that message is too long for one task (' + MAX_TEXT + ' characters max)');
      let streamId = a.streamId == null || a.streamId === '' ? '' : String(a.streamId);
      if (streamId && !STREAM_RE.test(streamId)) return bad('unknown conversation');
      // voice: the message was spoken on a voice-only device; the reply will only be heard (remote/voice-style.js)
      const r = await host.send({ agentId, text, streamId, deviceId: ctx.deviceId, voice: a.voice === true });
      return r && r.ok === false ? bad(r.error || 'the task could not start') : good(r);
    },

    async stop(a) {
      const runId = id(a.runId);
      if (!runId) return bad('unknown run');
      const r = await host.stop({ runId });
      return r && r.ok ? good({ stopped: true }) : bad((r && r.error) || 'that run is not running');
    },

    async approvals() { return good(approvals.list()); },

    async decide(a) {
      const r = approvals.answer(id(a.runId), id(a.promptId), String(a.decision || ''));
      return r.ok ? good({ decided: String(a.decision) }) : bad(r.error);
    },

    async reply(a) {
      const r = approvals.reply(id(a.runId), id(a.promptId), a.text);
      return r.ok ? good({ answered: true }) : bad(r.error);
    },

    async seen(a) {
      return good({ extended: !!approvals.extend(id(a.runId), id(a.promptId)) });
    },

    async files(a) {
      const query = String(a.query == null ? '' : a.query).trim().toLowerCase().slice(0, 120);
      return good(await host.files({ limit: clampInt(a.limit, 1, 100, 30), query }));
    },

    async fetch(a) {
      const agentId = id(a.agentId);
      const rel = String(a.path == null ? '' : a.path);
      if (!agentId || !rel || rel.length > 1024) return bad('unknown file');
      const offset = clampInt(a.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const length = clampInt(a.length, 1, MAX_CHUNK, MAX_CHUNK);
      const r = await host.fetchFile({ agentId, path: rel, offset, length });
      return r && r.ok === false ? bad(r.error || 'unknown file') : good(r);
    },

    async view(a, ctx) {
      const stamp = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
      return good(await host.view({ deviceId: ctx.deviceId, have: stamp(a.have), at: stamp(a.at), offset: clampInt(a.offset, 0, Number.MAX_SAFE_INTEGER, 0), length: clampInt(a.length, 1, MAX_CHUNK, MAX_CHUNK) }));
    },

    async sprite(a) {
      const key = String(a.key || '');
      if (!/^[A-Za-z0-9_]{1,40}\.[a-z_]{1,20}\.[a-z-]{1,20}$/.test(key)) return bad('unknown sprite');
      const r = await host.sprite({ key });
      return r && r.ok === false ? bad(r.error || 'unknown sprite') : good(r);
    },

    async activity(a) { return good(await host.activity({ limit: clampInt(a.limit, 1, 60, 30) })); },

    async portrait(a) {
      const agentId = id(a.agentId);
      if (!agentId) return bad('unknown agent');
      const r = await host.portrait({ agentId });
      return r && r.ok === false ? bad(r.error || 'no portrait') : good(r);
    },

    async pushKey(a, ctx) {
      if (!deps.push) return bad('this station cannot send notifications');
      return good({ key: deps.push.publicKey(), on: deps.push.has(ctx.deviceId) });
    },

    async pushOn(a, ctx) {
      if (!deps.push) return bad('this station cannot send notifications');
      const keys = a.keys && typeof a.keys === 'object' ? { p256dh: String(a.keys.p256dh || ''), auth: String(a.keys.auth || '') } : {};
      const r = deps.push.subscribe(ctx.deviceId, { endpoint: String(a.endpoint || ''), keys });
      return r.ok ? good({ on: true }) : bad(r.error);
    },

    async pushOff(a, ctx) {
      if (!deps.push) return good({ on: false });
      const r = deps.push.unsubscribe(ctx.deviceId);
      return r.ok ? good({ on: false }) : bad(r.error);
    },

    async pushTest(a, ctx) {
      if (!deps.push || !deps.push.has(ctx.deviceId)) return bad('notifications are not on for this phone');
      const [r] = await deps.push.send([ctx.deviceId], { title: 'Notifications are on', body: 'Your station will tap this phone when your crew needs you.', tag: 'test', url: '#needs' });
      return r && r.ok ? good({ sent: true }) : bad('the push service did not take the notification' + (r && r.status ? ' (' + r.status + ')' : ''));
    },

    // voice: a paired device with a microphone and a speaker (sidecar/remote/voice.js)
    async hear(a, ctx) { return voiceCall('hear', a, ctx); },
    async speak(a, ctx) { return voiceCall('speak', a, ctx); },
    async speech(a, ctx) { return voiceCall('speech', a, ctx); },

    async routines() { return good(await host.routines()); },

    async routine(a, ctx) {
      const jobId = id(a.jobId);
      if (!jobId) return bad('unknown routine');
      if (typeof a.enabled !== 'boolean') return bad('say whether the routine should be on or off');
      const r = await host.setRoutine({ jobId, enabled: a.enabled, deviceId: (ctx && ctx.deviceId) || '' });
      return r && r.ok ? good(r) : bad((r && r.error) || 'that routine could not be changed');
    }
  };

  async function call(msg, ctx) {
    const verb = msg && typeof msg.verb === 'string' ? msg.verb : '';
    const fn = Object.prototype.hasOwnProperty.call(VERBS, verb) ? VERBS[verb] : null;
    if (!fn) return bad('unknown request');
    const args = msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
    try { return await fn(args, ctx || {}); }
    catch (e) { return bad('the station hit an error doing that (' + String((e && e.message) || e).slice(0, 200) + ')'); }
  }

  return { call, verbs: Object.keys(VERBS) };
}

module.exports = { makeGateway, MAX_CHUNK, MAX_TEXT };
