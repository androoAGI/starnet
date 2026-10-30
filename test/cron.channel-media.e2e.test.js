/* node test/cron.channel-media.e2e.test.js -- a routine that delivers to Telegram must be able to send IMAGES.

   Issue (2026-10-18): "Telegram messages cannot be automated from starnet to include images." A routine's REPLY is
   what reaches the chat (deliverCronResult), and an unattended run cannot channel.send at all (the exec lockout:
   nobody is there to approve it). The delivery sent words only, so a routine that made a chart or rendered an
   image could at best name its path — Telegram never received the picture.

   This boots the real sidecar against a fake Bot API and a fake model, connects Telegram, and fires routines with
   Run Now (the scheduled fire's exact delivery path). It proves, off the bytes the Bot API actually received:
     1. an ATTACH line in the routine's reply uploads that workspace file as a photo, and the line itself is not
        part of the delivered text (default ASK posture — the delivery needs no approval nobody can give);
     2. an image the run GENERATED rides the delivery even when the reply names nothing;
     3. a named file that cannot be read never vanishes silently: its line stays in the message as the routine wrote it,
        and the station claims nothing about it (review 2026-10-23: a digest's "MEDIA: N/A" label is not a file, so a
        line is stripped — and a missing file said out loud — only when the file was really read on the station);
     4. a routine that delivers to a chat is told how to attach; a routine that stays on the station is not;
     5. (review round 4, MAJOR-2) a file the routine's own agent keeps sends however old it is, and a named file the
        egress reader REFUSES (a hard link, a name that climbs out) is never silent: its line is stripped, it is logged,
        and the missed-file note names it by its shown name, never a host path. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
// two DIFFERENT valid PNGs, so a test can tell which file arrived
const SEEDED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const RENDER_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// multipart/form-data -> { fields: {name: text}, files: [{ field, filename, contentType, bytes }] }
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const out = { fields: {}, files: [] };
  if (!m) return out;
  const delim = Buffer.from('--' + (m[1] || m[2]).trim());
  let at = buf.indexOf(delim);
  while (at >= 0) {
    const start = at + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next < 0) break;
    const part = buf.slice(start + 2, next - 2);   // skip the CRLF after the delimiter and before the next one
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.slice(0, headEnd).toString();
    const body = part.slice(headEnd + 4);
    const name = (/name="([^"]*)"/i.exec(head) || [])[1] || '';
    const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
    if (filename != null) out.files.push({ field: name, filename, contentType: ((/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim(), bytes: body });
    else out.fields[name] = body.toString();
    at = next;
  }
  return out;
}

async function startTelegram() {
  const calls = [];
  let nextId = 100;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const method = String(req.url || '').split('?')[0].split('/').pop();
      const raw = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      let call = { method, fields: {}, files: [] };
      if (/multipart\/form-data/i.test(ct)) call = Object.assign(call, parseMultipart(raw, ct));
      else { try { call.fields = JSON.parse(raw.toString() || '{}'); } catch (_) {} }
      if (method !== 'getUpdates' && method !== 'getMe') calls.push(call);
      // the Bot API's own ceiling: a message longer than 4096 characters (after entity parsing) is refused outright
      const rendered = String((call.fields && call.fields.text) || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      if (method === 'sendMessage' && Array.from(rendered).length > 4096) {
        call.refused = true;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }));
      }
      const result = method === 'getMe' ? { id: 42, is_bot: true, username: 'routine_media_bot', first_name: 'Routine Media' }
        : method === 'getUpdates' ? []
        : /^send/.test(method) ? { message_id: nextId++, chat: { id: Number(call.fields.chat_id) || 0 } }
        : true;
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      }, method === 'getUpdates' ? 200 : 0);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return {
    calls,
    base: 'http://' + HOST + ':' + server.address().port,
    close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); })
  };
}

function sse(res, chunks, finishReason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason || 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

// The model. Each routine's prompt carries a marker that picks its scripted reply.
async function startModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      requests.push(body);
      if (Array.isArray(body.modalities) && body.modalities.includes('image')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + RENDER_PNG_B64 } }] } }] }));
      }
      const blob = JSON.stringify(body.messages || []);
      const toolDone = (body.messages || []).some(m => m && m.role === 'tool');
      if (blob.includes('ROUTINE_ATTACH')) return sse(res, [{ content: "Here is today's chart.\nATTACH: charts/today.png" }]);
      if (blob.includes('ROUTINE_MISSING')) return sse(res, [{ content: 'Chart attached.\nATTACH: charts/missing.png' }]);
      if (blob.includes('ROUTINE_REFUSED')) return sse(res, [{ content: 'Weekly files.\nATTACH: weekly.pdf\nATTACH: build-out.pdf\nATTACH: ../escape.txt\nATTACH: charts/missing.png' }]);
      if (blob.includes('ROUTINE_LABELS')) return sse(res, [{ content: 'LABELS_START\nMEDIA: N/A\n- MEDIA: TV/radio\nMEDIA: Reuters.com\nLABELS_END' }]);
      if (blob.includes('ROUTINE_LONG')) return sse(res, [{ content: 'LONG_START\n' + Array.from({ length: 220 }, (_, i) => 'finding ' + i + ': the overnight digest line with details').join('\n') + '\nLONG_END' }]);
      if (blob.includes('ROUTINE_RENDER')) {
        if (!toolDone) return sse(res, [{ tool_calls: [{ index: 0, id: 'render', type: 'function', function: { name: 'image_generate', arguments: JSON.stringify({ prompt: 'a red sunrise over the station' }) } }] }], 'tool_calls');
        return sse(res, [{ content: 'Fresh render for today.' }]);
      }
      return sse(res, [{ content: 'Station is quiet today.' }]);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return { requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1', close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

async function waitFor(pred, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = pred();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const telegram = await startTelegram();
  const model = await startModel();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-cron-channel-media-',
    env: {
      SKYNET_TELEGRAM_API_BASE: telegram.base, STARNET_TELEGRAM_API_BASE: telegram.base,
      SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-routine-media-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-routine-media-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_AUX_BUDGET: '0',
      SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
    }
  });
  try {
    await sidecar.start();
    const connected = await sidecar.json('POST', '/api/channels/telegram/connect', {
      token: '123456:TESTTOKEN', key: 'sk-or-v1-routine-media-fake', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system: 'You are ULTRON.'
    });
    A.eq(connected.status, 200, 'Telegram connects to the fake Bot API');
    const up = async () => { const s = await sidecar.json('GET', '/api/channels/telegram/status'); return s.body && s.body.connected && s.body.state === 'up'; };
    const until = Date.now() + 15000;
    while (!(await up())) { if (Date.now() > until) throw new Error('Telegram never reported up'); await sleep(100); }

    // the file a routine made in an earlier step (the agent's own workspace — the same jail channel.send uses)
    const agentDir = path.join(sidecar.workspace, 'agent');
    fs.mkdirSync(path.join(agentDir, 'charts'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'charts', 'today.png'), SEEDED_PNG);

    async function routine(name, prompt, extra) {
      const r = await sidecar.json('POST', '/api/cron', Object.assign({
        name, prompt, schedule: 'every 1h', agentId: 'agent', model: 'test/model', provider: 'openrouter',
        deliver: 'origin', origin: { channel: 'telegram', chatId: '777' }
      }, extra || {}));
      A.eq(r.status, 200, name + ': routine created');
      A.ok(r.body && r.body.job && r.body.job.id, name + ': routine id returned' + (r.body && r.body.error ? ' (' + r.body.error + ')' : ''));
      return r.body.job;
    }
    async function runNow(job) {
      const res = await sidecar.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id }) });
      A.eq(res.status, 200, job.name + ': Run Now streams');
      return (await res.text()).split('\n').map(s => s.trim()).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
    }
    const sysOf = req => ((req.messages || []).find(m => m.role === 'system') || {}).content || '';
    const userOf = req => JSON.stringify((req.messages || []).filter(m => m.role === 'user'));

    /* ---- 1. ATTACH line -> the file is uploaded as a photo, in the default ASK posture ---- */
    const attachJob = await routine('Daily chart', 'ROUTINE_ATTACH send me the daily chart');
    let mark = telegram.calls.length;
    await runNow(attachJob);
    const photo = await waitFor(() => telegram.calls.slice(mark).find(c => c.method === 'sendPhoto'), 10000, 'the chart to arrive as a photo');
    A.eq(photo.fields.chat_id, '777', 'the photo goes to the routine\'s own chat');
    A.eq(photo.files.length, 1, 'one file uploaded');
    A.eq(photo.files[0].filename, 'today.png', 'under its own file name');
    A.ok(photo.files[0].bytes.equals(SEEDED_PNG), 'the exact bytes of the workspace file');
    const words = telegram.calls.slice(mark).filter(c => c.method === 'sendMessage').map(c => String(c.fields.text || ''));
    A.ok(words.some(t => t.indexOf("Here is today's chart.") >= 0), 'the routine\'s words are delivered too');
    A.ok(words.every(t => t.indexOf('ATTACH:') < 0), 'the ATTACH line is not shown to the Commander');
    const order = telegram.calls.slice(mark).map(c => c.method);
    A.ok(order.indexOf('sendMessage') >= 0 && order.indexOf('sendMessage') < order.indexOf('sendPhoto'), 'words first, then the file (a failed upload never costs the message)');
    const attachReq = model.requests.find(r => userOf(r).indexOf('ROUTINE_ATTACH') >= 0);
    A.ok(attachReq && /ATTACH: /.test(sysOf(attachReq)), 'a routine that delivers to a chat is told how to attach a file');
    A.ok(attachReq && /Telegram/.test(sysOf(attachReq)), 'and names the chat platform it delivers to');

    /* ---- 3. a named file that cannot be read -> its line stays visible, nothing pretends ---- */
    const missingJob = await routine('Missing chart', 'ROUTINE_MISSING send me the chart');
    mark = telegram.calls.length;
    await runNow(missingJob);
    const missingMsg = await waitFor(() => telegram.calls.slice(mark).find(c => c.method === 'sendMessage' && String(c.fields.text || '').indexOf('Chart attached.') >= 0), 10000, 'the missing-chart message');
    A.ok(String(missingMsg.fields.text).indexOf('ATTACH: charts/missing.png') >= 0, 'the line naming the file stays in the message, so the Commander sees which file was meant');
    await sleep(500);
    A.ok(!telegram.calls.slice(mark).some(c => c.method === 'sendPhoto' || c.method === 'sendDocument'), 'nothing was uploaded for an unreadable path');
    A.ok(!telegram.calls.slice(mark).some(c => /could not be attached|saved in the workspace/.test(String(c.fields.text || ''))), 'and the station never claims a file it never saw is saved on it');

    /* ---- 3b. a digest's uppercase field labels are its words, not files (review 2026-10-23) ---- */
    const labelsJob = await routine('Media monitor', 'ROUTINE_LABELS write the media digest');
    mark = telegram.calls.length;
    await runNow(labelsJob);
    const labels = await waitFor(() => telegram.calls.slice(mark).find(c => c.method === 'sendMessage' && String(c.fields.text || '').indexOf('LABELS_END') >= 0), 10000, 'the media digest');
    const plain = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    A.ok(['MEDIA: N/A', 'MEDIA: TV/radio', 'MEDIA: Reuters.com'].every(l => plain(labels.fields.text).indexOf(l) >= 0), 'every "MEDIA:" label line arrives as written: ' + JSON.stringify(String(labels.fields.text)));
    await sleep(500);
    A.ok(!telegram.calls.slice(mark).some(c => /could not be attached/.test(String(c.fields.text || ''))), 'with no missing-file note');

    /* ---- 3c. review round 4, MAJOR-2 (scratchpad rr4-routine.js): the routine's own old file sends, a refusal is said ----
       The round-3 age rule refused the routine's own 3-day-old weekly.pdf, and deliverCronResult dropped readNamed's
       missing list, so every refusal reached the chat as a raw "ATTACH:" line with no note. */
    fs.writeFileSync(path.join(agentDir, 'weekly.pdf'), '%PDF-1.4 WEEKLY');
    const threeDays = new Date(Date.now() - 3 * 86400e3);
    fs.utimesSync(path.join(agentDir, 'weekly.pdf'), threeDays, threeDays);
    fs.writeFileSync(path.join(sidecar.workspace, 'outside-secret.txt'), 'OUTSIDE-SECRET');
    let linked = false;
    try { fs.linkSync(path.join(sidecar.workspace, 'outside-secret.txt'), path.join(agentDir, 'build-out.pdf')); linked = true; } catch (e) { console.log('[skip] hard link: ' + e.message); }
    const refusedJob = await routine('Weekly files', 'ROUTINE_REFUSED send me the weekly files');
    mark = telegram.calls.length;
    await runNow(refusedJob);
    const weekly = await waitFor(() => telegram.calls.slice(mark).find(c => c.method === 'sendDocument'), 10000, 'the weekly report to arrive');
    A.ok(weekly.files[0] && weekly.files[0].filename === 'weekly.pdf' && weekly.files[0].bytes.toString() === '%PDF-1.4 WEEKLY', 'the routine\'s own 3-day-old weekly.pdf is sent (was: refused as older than the fire)');
    const missedMsg = await waitFor(() => telegram.calls.slice(mark).find(c => c.method === 'sendMessage' && /could not be attached|refused by the station's send rules/.test(plain(c.fields.text))), 10000, 'the missed-file note');
    const missedText = plain(missedMsg.fields.text);
    A.ok(/"\.\.\/escape\.txt"/.test(missedText) && (!linked || /"build-out\.pdf"/.test(missedText)), 'the missed-file note names each refused file: ' + JSON.stringify(missedText));
    // 0.14.2 review: the note told both refused files "It is saved in the workspace on the station" — "../escape.txt" is
    // outside it, and build-out.pdf is a second name for a file outside it. It now says only what the reader said.
    A.ok(!/saved in the workspace/.test(missedText) && !/could not be found/.test(missedText), 'a refused file is never claimed to be on the station, nor missing: ' + JSON.stringify(missedText));
    A.ok(/refused by the station's send rules and was not attached — "\.\.\/escape\.txt" climbs out of/.test(missedText), 'the climbing name is told the send rules refused it, and why: ' + JSON.stringify(missedText));
    A.ok(!linked || /"build-out\.pdf" has other names on this disk \(a hard link\)/.test(missedText), 'the hard link is told why it never leaves: ' + JSON.stringify(missedText));
    A.ok(missedText.indexOf('charts/missing.png') < 0, 'and not the file that is simply not there');
    A.ok(missedText.indexOf(sidecar.workspace) < 0 && !/[A-Za-z]:[\\/]|\/(?:tmp|Users|home)\//.test(missedText), 'the note names no host path');
    const weeklyWords = plain((telegram.calls.slice(mark).find(c => c.method === 'sendMessage' && String(c.fields.text || '').indexOf('Weekly files.') >= 0) || { fields: {} }).fields.text);
    A.ok(['ATTACH: weekly.pdf', 'ATTACH: build-out.pdf', 'ATTACH: ../escape.txt'].every(l => weeklyWords.indexOf(l) < 0), 'the sent and the refused files\' lines are stripped: ' + JSON.stringify(weeklyWords));
    A.ok(weeklyWords.indexOf('ATTACH: charts/missing.png') >= 0, 'the line naming nothing on the station stays as written');
    A.ok(!telegram.calls.slice(mark).some(c => c.files.some(f => f.bytes.toString() === 'OUTSIDE-SECRET')), 'the hard link never left the station');
    A.ok(!linked || /\[cron\] routine [^\n]* file "build-out\.pdf" refused: [^\n]*hard link/.test(sidecar.output()), 'the refusal is logged on the console');

    /* ---- 5. a LONG report reaches the chat whole, split under the platform's limit (live-caught 2026-10-20) ----
       The delivery sent the routine's reply as ONE message: a digest past 4096 characters was refused by the Bot API
       ("message is too long") on the fire and on every retry, so the chat never saw it at all. */
    const longJob = await routine('Overnight digest', 'ROUTINE_LONG write the overnight digest');
    mark = telegram.calls.length;
    await runNow(longJob);
    await waitFor(() => telegram.calls.slice(mark).some(c => c.method === 'sendMessage' && (c.refused || String(c.fields.text || '').indexOf('LONG_END') >= 0)), 10000, 'the long digest delivery attempt');
    await sleep(300);
    const longParts = telegram.calls.slice(mark).filter(c => c.method === 'sendMessage');
    A.ok(longParts.every(c => !c.refused), 'no part of the digest was refused as too long (' + longParts.filter(c => c.refused).length + ' refused)');
    A.ok(longParts.length >= 3, 'the digest went out in several messages (' + longParts.length + ')');
    const longText = longParts.filter(c => !c.refused).map(c => String(c.fields.text || '')).join('\n');
    A.ok(longText.indexOf('LONG_START') >= 0 && longText.indexOf('finding 219:') >= 0 && longText.indexOf('LONG_END') > longText.indexOf('LONG_START'), 'every line of the digest arrived, in order');
    const longState = (await sidecar.json('GET', '/api/cron')).body.jobs.find(j => j.id === longJob.id);
    A.eq(longState && longState.lastDeliveryOk, true, 'and the routine records the delivery as landed: ' + (longState && longState.lastDeliveryError));

    /* ---- 4. a routine that stays on the station is not told about chat attachments ---- */
    const localJob = await routine('Local note', 'ROUTINE_LOCAL a quiet check', { deliver: 'local', origin: undefined });
    await runNow(localJob);
    const localReq = model.requests.find(r => userOf(r).indexOf('ROUTINE_LOCAL') >= 0);
    A.ok(localReq && sysOf(localReq).indexOf('ATTACH:') < 0, 'a local routine\'s prompt carries no chat-attachment instruction');

    /* ---- 2. an image the run GENERATED rides the delivery without any ATTACH line ----
       Generation itself is a paid write that an unattended run in ASK may not self-approve (unchanged policy), so
       this half runs under the Commander's live Full Access switch — the delivery path is the same either way. */
    const bypass = await sidecar.json('POST', '/api/permissions/bypass', { on: true });
    A.eq(bypass.status, 200, 'Full Access switched on for the render routine');
    const renderJob = await routine('Morning render', 'ROUTINE_RENDER make me a sunrise picture', { unattendedGrants: ['studio'] });
    A.eq(renderJob.unattendedGrants, ['studio'], 'the render routine holds ALLOW IMAGES');
    mark = telegram.calls.length;
    const events = await runNow(renderJob);
    const ended = events.filter(e => e.name === 'agent.run.end').pop();
    A.eq(ended && ended.payload && ended.payload.reason, 'done', 'the render routine completed');
    const rendered = await waitFor(() => telegram.calls.slice(mark).find(c => c.method === 'sendPhoto'), 10000, 'the generated image to arrive');
    A.ok(rendered.files[0] && rendered.files[0].bytes.equals(Buffer.from(RENDER_PNG_B64, 'base64')), 'the photo is the image the run generated');
    A.ok(telegram.calls.slice(mark).some(c => c.method === 'sendMessage' && String(c.fields.text || '').indexOf('Fresh render for today.') >= 0), 'with the routine\'s words');

    /* ---- 2b. a routine WITHOUT ALLOW IMAGES that makes pictures for another purpose keeps its chat words-only ----
       (upgrade review 2026-10-23: a 0.13.x Full Access routine rendering wallpapers into a folder never posted them) */
    const wallpaperJob = await routine('Wallpapers', 'ROUTINE_RENDER render wallpapers into the wallpapers folder');
    A.eq(wallpaperJob.unattendedGrants || [], [], 'the wallpaper routine holds no images grant');
    mark = telegram.calls.length;
    const wpEvents = await runNow(wallpaperJob);
    const wpEnded = wpEvents.filter(e => e.name === 'agent.run.end').pop();
    A.eq(wpEnded && wpEnded.payload && wpEnded.payload.reason, 'done', 'the wallpaper routine completed (and generated its image)');
    await waitFor(() => telegram.calls.slice(mark).some(c => c.method === 'sendMessage' && String(c.fields.text || '').indexOf('Fresh render for today.') >= 0), 10000, 'the wallpaper routine\'s words');
    await sleep(500);
    A.ok(!telegram.calls.slice(mark).some(c => c.method === 'sendPhoto' || c.method === 'sendDocument' || c.method === 'sendMediaGroup'), 'its generated image is not posted to the chat');
    A.ok(!telegram.calls.slice(mark).some(c => /could not be attached/.test(String(c.fields.text || ''))), 'and no missing-file note is invented');
    await sidecar.json('POST', '/api/permissions/bypass', { on: false });
  } catch (error) {
    error.message += '\nBot API calls:\n' + telegram.calls.map(c => '  ' + c.method + ' ' + JSON.stringify(c.fields).slice(0, 200)
      + (c.files.length ? ' files=' + c.files.map(f => f.filename + ':' + f.bytes.length).join(',') : '')).join('\n');
    error.message += '\nSidecar output (tail):\n' + sidecar.output().slice(-6000);
    throw error;
  } finally {
    await sidecar.dispose();
    await telegram.close();
    await model.close();
  }
  A.report('cron.channel-media.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
