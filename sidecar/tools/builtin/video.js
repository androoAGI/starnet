/* sidecar/tools/builtin/video.js — `video_generate` / `video_status` / `video_result`: short video the agent MAKES.

   WHY THIS EXISTS. A station can now run MoneyPrinterTurbo (github.com/harry0703/MoneyPrinterTurbo) as a local
   Dockerized service: give it a subject (and optionally a script), it writes a script via an LLM if none was
   given, finds stock/AI footage, generates a voiceover, burns subtitles, and renders an .mp4 — several minutes
   of real wall-clock work. This is the STUDIO's fourth skill, same object as image_generate/voice_generate
   (capId 'studio'), but it CANNOT be a single blocking tool call the way image/voice generation are: a render
   can run long past any sane tool timeout. So this follows the station's OWN existing background-job shape
   (shell.js's shell.exec(background:true) -> shell.bg.status/shell.bg.wait/shell.bg.read/shell.bg.kill,
   sidecar/tools/builtin/shell.js:820-1132) instead of inventing a new async pattern: submit, poll, fetch.

   video_generate submits the job and returns a task_id immediately (consent-gated: it spends real compute/
   render time and will write a file, same reasoning as image_generate/voice_generate). video_status polls
   (read-only, no consent — same posture as shell.bg.status). video_result downloads the finished file into the
   agent's jailed workspace once status is "done" and emits a `deliverable` of kind 'file' (NOT a bespoke
   'video' kind) — same trick voice.js uses for audio: chat.js's mediaKindOf picks the player from the .mp4
   extension, so kind:'file' is what actually renders a video player; a 'video' kind would be silently dropped.

   THE CLIENT IS INJECTED (index.js wires `mptClient` from MONEYPRINTER_API_URL / MONEYPRINTER_API_KEY), and
   file writes go through fs.js's workspace jail exactly like voice_generate, so a result path can never escape
   <root>/<agentId>/.

   Verified against a real local MoneyPrinterTurbo instance (app/controllers/v1/video.py, app/models/schema.py):
     POST {base}/api/v1/videos                body: { video_subject: string, video_script?: string, ... }
                                               200: { status, message, data: { task_id } }
     GET  {base}/api/v1/tasks/{task_id}        200: { status, message, data: { task_id, state, progress,
                                                       videos: string[]|null, combined_videos, error } }
       state: -1 failed (TASK_STATE_FAILED), 1 complete (TASK_STATE_COMPLETE), 4 processing (TASK_STATE_PROCESSING)
       (app/models/const.py:25-27)
     GET  {base}/api/v1/download/{file_path}   the rendered file, streamed (app/controllers/v1/video.py:547)
     auth: header `x-api-key`, only enforced when the station's MoneyPrinterTurbo config.toml sets app.api_key
       (app/controllers/base.py:30-71) — omitted entirely when no key is configured, matching an open local dev
       instance; never fabricate a key the station doesn't have.

   makeVideoTools({ mptClient, fsp, pathMod, root }) -> { generateTool, statusTool, resultTool, register(reg), _internals }
     mptClient.submit({ subject, script? }) -> { ok, taskId, reason? }
     mptClient.status({ taskId }) -> { ok, state: 'processing'|'complete'|'failed', progress, videos, error, reason? }
     mptClient.download({ filePath, signal }) -> { ok, buf, reason? } */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./fs.js'), require('node:crypto'));
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).video = factory(root.SK.tools.builtin.fs, null); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fsMod, nodeCrypto) {
  'use strict';

  const SUBMIT_TIMEOUT_MS = 20000;
  const STATUS_TIMEOUT_MS = 15000;
  const DOWNLOAD_TIMEOUT_MS = 60000;
  const MAX_SUBJECT = 500;
  const MAX_SCRIPT = 4000;

  const str = v => String(v == null ? '' : v).trim();

  // Same self-contained timeout helper as knowledge.js/web.js — duplicated on purpose (each tool file in
  // this codebase owns its own small utilities rather than importing a shared net layer; see voice.js).
  function withTimeout(promiseFactory, ms, parent) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      const reason = new Error('request timed out after ' + ms + 'ms');
      reason.__timeout = true;
      try { ctrl.abort(reason); } catch (_) { ctrl.abort(); }
    }, ms);
    if (parent) {
      if (parent.aborted) { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }
      else { try { parent.addEventListener('abort', () => { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }, { once: true }); } catch (_) {} }
    }
    return Promise.resolve(promiseFactory(ctrl.signal)).catch(e => {
      if (timedOut) {
        const reason = new Error('request timed out after ' + ms + 'ms');
        reason.__timeout = true;
        throw reason;
      }
      throw e;
    }).finally(() => clearTimeout(t));
  }

  const STATE_BY_CODE = { '-1': 'failed', '1': 'complete', '4': 'processing' };

  function makeMoneyPrinterClient({ baseUrl, apiKey, fetchImpl }) {
    const base = str(baseUrl).replace(/\/+$/, '');
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!base || !doFetch) return null;
    const authHeaders = apiKey ? { 'x-api-key': apiKey } : {};

    return {
      async submit({ subject, script, signal }) {
        const body = { video_subject: str(subject) };
        if (script) body.video_script = str(script);
        let res;
        try {
          res = await withTimeout(signal2 => doFetch(base + '/api/v1/videos', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
            body: JSON.stringify(body),
            signal: signal2
          }), SUBMIT_TIMEOUT_MS, signal);
        } catch (e) {
          return { ok: false, reason: e && e.__timeout ? 'MoneyPrinterTurbo request timed out' : ('MoneyPrinterTurbo request failed: ' + str(e && e.message)) };
        }
        let json; try { json = await res.json(); } catch (_) { json = null; }
        if (!res.ok || !json || !json.data || !json.data.task_id) {
          return { ok: false, reason: 'MoneyPrinterTurbo returned an error: ' + str((json && json.message) || (res.status + ' ' + res.statusText)) };
        }
        return { ok: true, taskId: json.data.task_id };
      },

      async status({ taskId, signal }) {
        let res;
        try {
          res = await withTimeout(signal2 => doFetch(base + '/api/v1/tasks/' + encodeURIComponent(taskId), {
            headers: authHeaders, signal: signal2
          }), STATUS_TIMEOUT_MS, signal);
        } catch (e) {
          return { ok: false, reason: e && e.__timeout ? 'MoneyPrinterTurbo request timed out' : ('MoneyPrinterTurbo request failed: ' + str(e && e.message)) };
        }
        if (res.status === 404) return { ok: false, reason: 'no such task' };
        let json; try { json = await res.json(); } catch (_) { json = null; }
        if (!res.ok || !json || !json.data) {
          return { ok: false, reason: 'MoneyPrinterTurbo returned an error: ' + str((json && json.message) || (res.status + ' ' + res.statusText)) };
        }
        const d = json.data;
        return {
          ok: true,
          state: STATE_BY_CODE[String(d.state)] || ('unknown(' + d.state + ')'),
          progress: typeof d.progress === 'number' ? d.progress : null,
          videos: Array.isArray(d.videos) ? d.videos : [],
          combinedVideos: Array.isArray(d.combined_videos) ? d.combined_videos : [],
          error: d.error ? str(d.error) : null
        };
      },

      async download({ filePath, signal }) {
        let res;
        try {
          res = await withTimeout(signal2 => doFetch(base + '/api/v1/download/' + filePath.split('/').map(encodeURIComponent).join('/'), {
            headers: authHeaders, signal: signal2
          }), DOWNLOAD_TIMEOUT_MS, signal);
        } catch (e) {
          return { ok: false, reason: e && e.__timeout ? 'MoneyPrinterTurbo download timed out' : ('MoneyPrinterTurbo download failed: ' + str(e && e.message)) };
        }
        if (!res.ok) return { ok: false, reason: 'download failed: ' + res.status + ' ' + res.statusText };
        const ab = await res.arrayBuffer();
        return { ok: true, buf: Buffer.from(ab) };
      }
    };
  }

  function makeVideoTools(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
    if (!fsp || !P || !ROOT) throw new Error('video.js requires { fsp, pathMod, root }');
    const client = deps.mptClient || null;
    const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT })._internals;

    function emitDeliverable(ctx, aid, rel) {
      if (!ctx || typeof ctx.emit !== 'function') return;
      const d = { id: 'vid_' + String(rel).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: String(rel) };
      if (ctx.room) d.room = ctx.room;
      ctx.emit('deliverable', d);
    }

    const generateTool = {
      name: 'video_generate', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: SUBMIT_TIMEOUT_MS + 10000,
      description: 'Start rendering a short video from a subject (and optional script) — stock/AI footage, a '
        + 'generated voiceover, and burned-in subtitles, assembled by MoneyPrinterTurbo. This only SUBMITS the '
        + 'job and returns a task_id; rendering takes real minutes. Call video_status to poll progress, then '
        + 'video_result once state is "complete" to save the finished file into your workspace. Do not call this '
        + 'more than once per video — resubmitting does not speed anything up.',
      schema: {
        type: 'object', required: ['subject'], properties: {
          subject: { type: 'string', description: 'what the video is about' },
          script: { type: 'string', description: 'optional full narration script; omit to let the service write one from the subject' }
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const subject = str(args.subject);
        if (!subject) throw new Error('subject is required');
        if (subject.length > MAX_SUBJECT) throw new Error('subject is ' + subject.length + ' characters; the cap is ' + MAX_SUBJECT);
        const script = str(args.script);
        if (script.length > MAX_SCRIPT) throw new Error('script is ' + script.length + ' characters; the cap is ' + MAX_SCRIPT);
        if (!client) throw new Error('this station has no video generator wired — video_generate cannot run here');

        const r = await client.submit({ subject, script, signal: ctx && ctx.signal });
        if (!r || r.ok === false) throw new Error('video submission failed' + (r && r.reason ? ': ' + str(r.reason) : ''));
        return { content: 'Started rendering. task_id=' + r.taskId + '. Poll with video_status, then video_result once complete.', summary: 'video_generate → ' + r.taskId };
      }
    };

    const statusTool = {
      name: 'video_status', capability: 'studio', scope: 'read', requiresConsent: false, network: true, timeoutMs: STATUS_TIMEOUT_MS + 5000,
      description: 'Check progress of a video_generate job by its task_id. Returns state (processing/complete/failed), '
        + 'percent progress, and the error message if it failed.',
      schema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
      run: async (args, ctx) => {
        const taskId = str(args && args.task_id);
        if (!taskId) throw new Error('task_id is required');
        if (!client) throw new Error('this station has no video generator wired — video_status cannot run here');
        const r = await client.status({ taskId, signal: ctx && ctx.signal });
        if (!r || r.ok === false) throw new Error('status check failed' + (r && r.reason ? ': ' + str(r.reason) : ''));
        const bits = ['state=' + r.state];
        if (r.progress != null) bits.push('progress=' + r.progress + '%');
        if (r.error) bits.push('error=' + r.error);
        return { content: bits.join(' '), summary: 'video_status(' + taskId + ') → ' + r.state };
      }
    };

    const resultTool = {
      name: 'video_result', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: DOWNLOAD_TIMEOUT_MS + 10000,
      description: 'Once video_status reports state=complete, fetch the finished video for a task_id and SAVE it '
        + 'into your workspace (returns the saved path + a viewer URL; appears in chat with a player). Fails '
        + 'honestly if the task is not actually complete yet — it does not wait or poll for you.',
      schema: {
        type: 'object', required: ['task_id'], properties: {
          task_id: { type: 'string' },
          path: { type: 'string', description: 'optional output filename inside your workspace' }
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const aid = (ctx && ctx.agentId) || 'agent';
        const taskId = str(args.task_id);
        if (!taskId) throw new Error('task_id is required');
        if (!client) throw new Error('this station has no video generator wired — video_result cannot run here');

        const st = await client.status({ taskId, signal: ctx && ctx.signal });
        if (!st || st.ok === false) throw new Error('could not confirm task status' + (st && st.reason ? ': ' + str(st.reason) : ''));
        if (st.state !== 'complete') {
          throw new Error('task ' + taskId + ' is not complete (state=' + st.state + (st.error ? ', error=' + st.error : '') + ') — call video_status until it reports complete');
        }
        const source = (st.combinedVideos && st.combinedVideos[0]) || (st.videos && st.videos[0]);
        if (!source) throw new Error('task reports complete but no output file was listed');

        const dl = await client.download({ filePath: source, signal: ctx && ctx.signal });
        if (!dl || dl.ok === false) throw new Error('fetching the rendered video failed' + (dl && dl.reason ? ': ' + str(dl.reason) : ''));

        let rel = str(args.path);
        if (rel) { if (!/\.[a-z0-9]+$/i.test(rel)) rel += '.mp4'; }
        else {
          const h = nodeCrypto ? nodeCrypto.createHash('sha1').update(taskId).digest('hex').slice(0, 12) : taskId.slice(0, 12);
          rel = 'video/clip-' + h + '.mp4';
        }
        const { abs } = await jail.resolveInside(aid, rel);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, dl.buf);
        emitDeliverable(ctx, aid, rel);

        const viewer = '/api/file?agent=' + encodeURIComponent(aid) + '&path=' + encodeURIComponent(rel);
        const mb = (dl.buf.length / (1024 * 1024)).toFixed(1) + ' MB';
        return { content: 'Saved ' + rel + ' (' + mb + ').\nPlay: ' + viewer, summary: 'video_result → ' + rel };
      }
    };

    return {
      generateTool, statusTool, resultTool,
      register(reg) { reg.register(generateTool); reg.register(statusTool); reg.register(resultTool); return reg; },
      _internals: { makeMoneyPrinterClient, STATE_BY_CODE }
    };
  }

  return { makeVideoTools: makeVideoTools, makeMoneyPrinterClient: makeMoneyPrinterClient };
});
