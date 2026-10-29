/* sidecar/routine-media.js — the files a scheduled routine's delivery carries into a chat.

   THE GAP (issue 2026-10-18, "Telegram messages cannot be automated to include images"). A routine's REPLY is what
   reaches the Commander's chat (index.js deliverCronResult), and an unattended run cannot channel.send at all — it
   is scope 'execute', and the exec lockout (permissions.js tier 2.5) denies it with nobody there to approve. The
   delivery was words-only, so a routine that rendered an image or drew a chart could at best name its path:
   Telegram never received the picture.

   THE FIX rides the delivery that is ALREADY approved. The Commander chose the destination when the routine was
   saved; the files go to that same chat, read the way channel.send reads them (the host's readFile: only from inside
   the PRODUCING run's own private workspace or approved project root, so a project routine's relative name means its
   project — sidecar/egress-files.js), uploaded with the same transport call. No new reach: a file can only go where the
   routine's words already go, and only from the folders the run that made it worked in.

   Which files (capped at MAX_FILES, the same 4 channel.send allows):
     1. ATTACH lines in the final reply — "ATTACH: charts/today.png", one per line. The agent's explicit choice,
        and the lines are removed from the delivered text (they are an instruction to the station, not prose).
        "MEDIA:" is read the same way: it is the reference harness's spelling and models carry it over. A line is
        removed only when its file was really READ from a workspace (readNamed); one naming nothing stays as written.
     2. Otherwise — only for a routine granted ALLOW IMAGES (the studio grant) — the images the fire itself GENERATED
        (image_generate artifacts on its run rows), so a routine whose model forgot the convention still delivers the
        picture it paid for. A routine without that grant that makes images for another purpose keeps its chat words-only.
   Neither applies to a chat the fire already sent its own files to with channel.send (possible under Full Access —
   filesAlreadySent): the same picture must not arrive twice.

   THE WORDS GO FIRST and files follow (channel.send's law): a channel that cannot upload never swallows the
   message. A file that does not arrive is said out loud in the chat, naming where it is on the station.

   Pure + injected: no fs/network/clock here; the host passes read/send. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./tools/builtin/comms.js') : (root.SK && root.SK.tools && root.SK.tools.builtin && root.SK.tools.builtin.comms));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).routineMedia = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (comms) {
  'use strict';

  const MAX_FILES = comms.MAX_FILES;
  const kindForMime = comms.kindForMime;
  // A whole line that is only the instruction: optional bullet, the word, then the path (optionally `quoted`).
  const ATTACH_LINE = /^\s*(?:[-*•]\s*)?(ATTACH|MEDIA)\s*:\s*([`"']?)([^`"'\r\n]+?)\2\s*$/i;
  /* PROSE IS NOT AN INSTRUCTION (upgrade review 2026-10-23). Every chat routine's reply goes through here, including
     routines written long before this existed, and digests carry lines like "- Media: TV coverage was strong" or
     "Attach: invoice before replying". Read as files, those lines vanished from the message and the chat got a false
     "could not be attached" note. A line is a file instruction only when its path LOOKS like a workspace path (one
     token, with a folder or an extension, not a web address) AND it is written the way the [DELIVERY] note teaches
     (the uppercase word) or marks the path as code/quoted. Anything else is the routine's words and stays. */
  function attachPath(keyword, quote, raw) {
    const p = String(raw || '').trim();
    if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return '';
    if (!quote && /\s/.test(p)) return '';
    if (!(/[\\/]/.test(p) || /\.[A-Za-z0-9]{1,10}$/.test(p))) return '';
    return (quote || keyword === keyword.toUpperCase()) ? p : '';
  }

  /* parseReply(text, only?) -> { text, files }
     Pulls the ATTACH lines out of a reply. `text` is the reply without them (trailing blank lines trimmed);
     `files` is the paths in order, de-duplicated. A reply with no ATTACH line comes back unchanged.
     `only` (an array of paths): remove only the lines naming one of THESE paths — the host passes the files it really
     read (readNamed), so a line naming nothing on the station ("MEDIA: N/A", "- MEDIA: TV/radio") stays in the
     message as written. When nothing is removed the reply comes back byte for byte. */
  function parseReply(text, only) {
    const src = String(text == null ? '' : text);
    const strip = Array.isArray(only) ? only.map(String) : null;
    const files = [];
    let removed = false;
    const kept = [];
    for (const line of src.split(/\r?\n/)) {
      const m = ATTACH_LINE.exec(line);
      const p = m ? attachPath(m[1], m[2], m[3]) : '';
      if (!p) { kept.push(line); continue; }
      if (files.indexOf(p) < 0) files.push(p);
      if (strip && strip.indexOf(p) < 0) { kept.push(line); continue; }
      removed = true;
    }
    if (!removed) return { text: src, files: files };
    return { text: kept.join('\n').replace(/\s+$/, ''), files: files };
  }

  /* filesAlreadySent(runs, target, chatId) -> true when the fire itself already put files into THIS chat with a
     successful channel.send (possible under Full Access). Live 2026-10-18: the routine's prompt said "send it using
     channel_send", the run did that AND wrote an ATTACH line, and the picture arrived twice. The tool's own summary
     names where it went — "sent to <target>[ in N parts] with N file(s)" — so the check is per destination: a send
     to another chat, a words-only send, or a refused one (ASK) leaves this delivery to carry the files. */
  function filesAlreadySent(runs, target, chatId) {
    const want = [String(target || ''), String(chatId || '')].filter(Boolean);
    const id = String(chatId || '');
    return (Array.isArray(runs) ? runs : []).some(r => r && (Array.isArray(r.toolTrace) ? r.toolTrace : []).some(t => {
      if (!t || !/^channel[._]send$/.test(String(t.name || '')) || t.ok !== true || t.isError) return false;
      const m = /^sent to (\S+?)(?: in \d+ parts)? with [1-9]\d* file/.exec(String(t.summary || ''));
      if (!m) return false;
      return want.indexOf(m[1]) >= 0 || (!!id && m[1].slice(-(id.length + 1)) === '|' + id);   // '<botId>|<chatId>' keys
    }));
  }

  /* pickFiles({ named, runs, agentId, generatedImages }) -> { files:[{ path, agents:[agentId…], root? }], dropped:[path…] }
     runs = the fire's run rows ({ agentId, projectRoot, artifacts }), NEWEST first. A named path goes as readNamed
     found it (the host's fire reader picks the row that produced it). With nothing named and `generatedImages` true,
     each image the fire generated is read through the ROW that generated it (its agent and its project root, `root`),
     in the order they were made, never through another row's folder. `dropped` is what the cap left behind.
     `generatedImages` is the host's answer to "does this routine hold the ALLOW IMAGES (studio) grant": a routine
     that makes pictures for some other purpose ("render wallpapers into /wallpapers") never had them posted to its
     chat before 0.14, and must not start now (upgrade review 2026-10-23). Absent -> false. */
  // The workspaces a fire's files may live in: every agent that ran in it, newest first, then the routine's own agent.
  function fireAgents(runs, agentId) {
    const own = String(agentId || '');
    const agents = [];
    for (const r of (Array.isArray(runs) ? runs : [])) { const a = String((r && r.agentId) || ''); if (a && agents.indexOf(a) < 0) agents.push(a); }
    if (own && agents.indexOf(own) < 0) agents.push(own);
    return agents;
  }

  function pickFiles(o) {
    o = o || {};
    const runs = Array.isArray(o.runs) ? o.runs.filter(r => r && typeof r === 'object') : [];
    const own = String(o.agentId || '');
    const agents = fireAgents(runs, own);
    // a named entry is a path, or a file readNamed already read ({ path, agents, got }) — it is sent from that read
    const named = (Array.isArray(o.named) ? o.named : [])
      .map(p => (typeof p === 'string' ? { path: p, agents: agents.slice() } : p))
      .filter(p => p && typeof p.path === 'string' && p.path.trim());
    let all;
    if (named.length) {
      all = named.map(p => (p.got ? { path: p.path, agents: (p.agents || agents).slice(), got: p.got } : { path: p.path, agents: (p.agents || agents).slice() }));
    } else if (o.generatedImages !== true) {
      all = [];
    } else {
      all = [];
      for (const r of runs.slice().reverse()) {
        for (const a of (Array.isArray(r.artifacts) ? r.artifacts : [])) {
          if (!a || a.kind !== 'image' || !a.path) continue;
          const p = String(a.path);
          if (all.some(f => f.path === p)) continue;
          all.push({ path: p, agents: [String(r.agentId || own)].filter(Boolean), root: String(r.projectRoot || '') });
        }
      }
    }
    return { files: all.slice(0, MAX_FILES), dropped: all.slice(MAX_FILES).map(f => f.path) };
  }

  /* sendFiles(files, { read(agentId, rel, where?), send(item) }) -> Promise<{ attached:[path], failed:[{ path, error }] }>
     Sequential, never throws. read answers { ok, buffer, name, mime } | { ok:false, error } (the host's proof);
     send answers the transport's SendResult. A file that carries its row (`root`) is read through that row alone
     (where = { root }); otherwise the first agent whose read answers wins. */
  // One file -> { got } | { error }. Never throws.
  async function readOne(f, read) {
    let readError = '';
    const where = typeof f.root === 'string' ? { root: f.root } : undefined;
    for (const agentId of (f.agents && f.agents.length ? f.agents : [''])) {
      let got;
      try { got = await read(agentId, f.path, where); } catch (e) { got = { ok: false, error: (e && e.message) || 'read threw' }; }
      if (got && got.ok !== false && got.buffer && got.buffer.length) return { got: got };
      readError = readError || (got && got.error) || 'not found';
    }
    return { error: readError || 'not found' };
  }

  /* readNamed(paths, agents, read) -> Promise<{ found:[{ path, agents, got }], missing:[{ path, error }] }>
     Reads each path an ATTACH line names, through `read` for each agent in order (the host's fire reader picks the row
     that produced the name itself, so the host passes the routine's own agent alone). Only a FOUND file makes its line
     an instruction (the host strips it and attaches the file, or says it could not be attached — true, the file is on
     the station); a missing one leaves the line in the message as the routine wrote it, with no note: prose such as
     "MEDIA: N/A" names nothing, and the station never claims a file it never saw (upgrade review 2026-10-23). Only the
     first MAX_FILES found keep their bytes (the rest are over the cap and only need to be known to exist). */
  async function readNamed(paths, agents, read) {
    const found = [], missing = [];
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p.trim());
    for (const p of list) {
      const f = { path: p, agents: (Array.isArray(agents) ? agents : []).slice() };
      const r = typeof read === 'function' ? await readOne(f, read) : { error: 'attaching files is not wired on this host' };
      if (!r.got) { missing.push({ path: p, error: r.error }); continue; }
      found.push(found.length < MAX_FILES ? Object.assign(f, { got: r.got }) : f);
    }
    return { found: found, missing: missing };
  }

  async function sendFiles(files, io) {
    const read = io && typeof io.read === 'function' ? io.read : null;
    const send = io && typeof io.send === 'function' ? io.send : null;
    const attached = [], failed = [];
    for (const f of (Array.isArray(files) ? files : [])) {
      if ((!read && !f.got) || !send) { failed.push({ path: f.path, error: 'attaching files is not wired on this host' }); continue; }
      let got = f.got || null;
      if (!got) {
        const r = await readOne(f, read);
        if (!r.got) { failed.push({ path: f.path, error: 'could not be read from the workspace (' + r.error + ')' }); continue; }
        got = r.got;
      }
      const name = String(got.name || f.path).split(/[\\/]/).pop();
      const item = { kind: kindForMime(got.mime, name), buffer: got.buffer, filename: name, mime: got.mime || '' };
      let r;
      try { r = await send(item); } catch (e) { r = { ok: false, error: (e && e.message) || 'upload threw' }; }
      if (r && r.ok) attached.push(f.path);
      else failed.push({ path: f.path, error: (r && r.error) || 'upload failed' });
    }
    return { attached: attached, failed: failed };
  }

  // The chat line for files that did not come — channel.send's own wording, so both paths read the same.
  // shown(path) (the host's): the name the chat may see. An absolute host path is never quoted into a chat (run-paths
  // review S3): without the host's mapping it is named by its file name only.
  function missedNote(paths, shown) {
    const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
    if (!list.length) return '';
    const abs = s => /^(?:[A-Za-z]:|[\\/])/.test(String(s));
    const name = p => {
      const s = typeof shown === 'function' ? String(shown(p) || '') : '';
      if (s && !abs(s)) return s;
      return abs(p) ? (String(p).split(/[\\/]/).filter(Boolean).pop() || 'file') : String(p);
    };
    return 'Note: ' + (list.length === 1 ? 'this file' : 'these files') + ' could not be attached here — '
      + list.map(p => '"' + name(p) + '"').join(', ') + '. ' + (list.length === 1 ? 'It is' : 'They are') + ' saved in the workspace on the station.';
  }

  /* deliveryNote(platforms) -> the system-prompt paragraph for a routine whose reply goes to a chat ('' otherwise).
     Only a chat-bound routine gets it: a routine that stays on the station has nowhere to upload to, and an
     instruction it cannot use would only put ATTACH lines into a COMMS session. */
  function deliveryNote(platforms) {
    const names = (Array.isArray(platforms) ? platforms : []).map(p => String(p || '').trim()).filter(Boolean);
    if (!names.length) return '';
    const where = names.filter((p, i) => names.indexOf(p) === i).join(' / ');
    // Live finding (haiku-4.5, 2026-10-18): told only the ATTACH format, the model still called channel.targets, found
    // no listed chat and wrote "I cannot send the image to you" into a delivery that carried the image. So the note
    // says up front that the STATION delivers, and rules out the lookup as well as the send.
    return '\n\n[DELIVERY] The station sends this routine\'s reply to the Commander\'s ' + where + ' chat for you — do not '
      + 'look up chat targets or call channel.send. To include a file you made (an image, chart or document in your '
      + 'workspace), end the reply with one line per file: ATTACH: <workspace-relative path> — up to ' + MAX_FILES
      + '; images arrive inline. Never write that the message or a file cannot be sent.';
  }

  return { parseReply, pickFiles, fireAgents, readNamed, filesAlreadySent, sendFiles, missedNote, deliveryNote, MAX_FILES };
});
