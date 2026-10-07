/* sidecar/tools/builtin/voice.js — `voice_generate`: speech the agent MAKES, as a file it can hand over.

   The station could already SPEAK (POST /api/tts — the keyed neural ladder, with Edge read-aloud as the free
   keyless floor). What no agent could do was PRODUCE audio: a voiceover for a video, a narrated summary, an
   audio message. Asked what StarNet lacked, agents answered "voice generation" — and they were right about
   the tool while the whole synthesis stack sat one seam away, wired only to the station's own mouth.

   This is the STUDIO's third skill, and it is deliberately the same shape as image_generate:
     • it WRITES into the agent's jailed workspace (so consent-gated, exactly like fs.write / image_generate);
     • it emits a `deliverable` so the clip lands in chat — as kind 'file', NOT 'audio'. That is not sloppiness:
       chat.js filters deliverables to kind 'file'|'image' and then picks the player from the FILE EXTENSION
       (mediaKindOf → MEDIA_KIND_BY_EXT), so an .mp3/.wav announced as 'file' renders as an inline seekable
       <audio>. A 'audio' kind would be dropped by that filter — the honest wire is the one that plays.
     • it returns the saved path + the /api/file viewer URL.

   THE LADDER IS INJECTED, not rebuilt. deps.synth is the host's one-shot synthesizer (index.js reuses the
   SAME ttsSynthKeyed chain + Edge floor that /api/tts drives), so a station with any voice-capable key gets
   its keyed voice and a zero-key station still gets the free Edge neural floor. With no synth injected at
   all the tool says so honestly rather than writing a silent file.

   makeVoiceTools({ synth, fsp, pathMod, root, defaultVoice? }) -> { generateTool, register(reg), _internals }
     synth({ text, voice, style }) -> { ok, buf, ext, mime, provider?, reason? }
   Reuses the fs.js workspace jail, so an output path can never escape <root>/<agentId>/. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./fs.js'), require('node:crypto'));
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).voice = factory(root.SK.tools.builtin.fs, null); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fsMod, nodeCrypto) {
  'use strict';

  // Edge caps a single synthesis turn well below this; the keyed providers cap lower still. A long script is
  // the caller's job to split into takes — silently truncating a voiceover would be the worst failure here.
  const MAX_TEXT = 4000;
  const SYNTH_TIMEOUT_MS = 60000;
  const EXT_BY_MIME = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/opus': '.opus' };
  const MIME_BY_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4' };

  const str = v => String(v == null ? '' : v).trim();

  function makeVoiceTools(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
    if (!fsp || !P || !ROOT) throw new Error('voice.js requires { fsp, pathMod, root }');
    const synth = typeof deps.synth === 'function' ? deps.synth : null;
    // pathTrust (issue #77): with the run's guard wired, a relative path in a project-scoped run lands IN the
    // project and an absolute path inside a trusted project is allowed, exactly like fs.write / image_generate.
    const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT, pathTrust: typeof deps.pathTrust === 'function' ? deps.pathTrust : undefined })._internals;

    function emitDeliverable(ctx, aid, rel) {
      if (!ctx || typeof ctx.emit !== 'function') return;
      // kind:'file' ON PURPOSE — see the header. The extension is what makes chat render a player.
      const d = { id: 'aud_' + String(rel).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: String(rel) };
      if (ctx.room) d.room = ctx.room;
      ctx.emit('deliverable', d);
    }

    // ext/mime agreement, whichever half the synthesizer chose to report. A caller-supplied filename
    // extension never overrides the actual bytes — a .wav named .mp3 is a file no player will open.
    function extOf(result) {
      const e = str(result && result.ext).replace(/^\./, '').toLowerCase();
      if (e) return '.' + e;
      const m = str(result && (result.mime || result.outType)).split(';')[0].toLowerCase();
      return EXT_BY_MIME[m] || '.mp3';
    }
    function mimeOf(result, ext) {
      const m = str(result && (result.mime || result.outType)).split(';')[0].toLowerCase();
      return m || MIME_BY_EXT[ext.replace(/^\./, '')] || 'audio/mpeg';
    }

    const generateTool = {
      name: 'voice_generate', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: SYNTH_TIMEOUT_MS + 15000,
      description: 'Speak text as neural audio and SAVE it into your workspace as a playable clip (returns the saved '
        + 'path + a viewer URL, and the clip appears in chat with a player). Use for any "record / narrate / read this '
        + 'aloud / make a voiceover" request, or to hand the Commander an audio version of something you wrote. This '
        + 'is NOT how you talk in conversation — your spoken replies are already handled by the station. Optional '
        + '"voice" picks a named voice and "style" gives delivery direction (e.g. "calm and deliberate"); support for '
        + 'both depends on which voice credential the station holds. Optional "path" sets the output filename. Long '
        + 'scripts: split them into takes and call once per take — text over ' + MAX_TEXT + ' characters is refused, never truncated.',
      schema: {
        type: 'object', required: ['text'], properties: {
          text: { type: 'string', description: 'what to say — plain prose, no SSML' },
          voice: { type: 'string', description: 'optional named voice' },
          style: { type: 'string', description: 'optional delivery direction, e.g. "warm, unhurried"' },
          path: { type: 'string', description: 'optional output filename: relative = the project folder in a project-scoped conversation, else your private workspace; or an absolute path inside a trusted project folder' }
        }
      },
      run: async (args, ctx) => {
        args = args || {};
        const aid = (ctx && ctx.agentId) || 'agent';
        const text = str(args.text).replace(/\s+/g, ' ');
        if (!text) throw new Error('text is required');
        if (text.length > MAX_TEXT) {
          throw new Error('text is ' + text.length + ' characters; the cap is ' + MAX_TEXT
            + '. Split the script into takes and call voice_generate once per take — a truncated voiceover is worse than a refused one.');
        }
        if (!synth) throw new Error('this station has no speech synthesizer wired — voice_generate cannot produce audio here');

        const r = await synth({ text: text, voice: str(args.voice), style: str(args.style) });
        if (!r || r.ok === false || !r.buf || !r.buf.length) {
          throw new Error('speech synthesis failed' + (r && r.reason ? ': ' + str(r.reason) : '') + ' — no audio was written');
        }
        const buffer = Buffer.isBuffer(r.buf) ? r.buf : Buffer.from(r.buf);
        const ext = extOf(r);
        const mime = mimeOf(r, ext);

        let rel = str(args.path);
        if (rel) { if (!/\.[a-z0-9]+$/i.test(rel)) rel += ext; }
        else {
          // content-addressed like image_generate: deterministic (no ambient rng — lint-determinism) and
          // collision-resistant, so re-speaking the same line overwrites rather than piling up takes.
          const h = nodeCrypto ? nodeCrypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12) : 'take';
          rel = 'audio/voice-' + h + ext;
        }
        const placed = await jail.resolveInside(aid, rel, { scope: 'write', ctx });   // throws on escape / '..' / untrusted
        const abs = placed.abs;
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buffer);
        emitDeliverable(ctx, aid, rel);

        const where = await jail.outputPlacement(aid, placed);
        const viewer = where.viewer;
        const kb = (buffer.length / 1024).toFixed(0) + ' KB';
        const via = str(r.provider);
        return {
          content: 'Spoke ' + text.length + ' characters and saved ' + rel + ' (' + kb + ', ' + mime
            + (via ? ', via ' + via : '') + ').\n' + where.line + (viewer ? '\nPlay: ' + viewer : ''),
          summary: 'voice → ' + rel
        };
      }
    };

    return {
      generateTool: generateTool,
      register(reg) { reg.register(generateTool); return reg; },
      _internals: { extOf, mimeOf, emitDeliverable, MAX_TEXT, SYNTH_TIMEOUT_MS }
    };
  }

  return { makeVoiceTools: makeVoiceTools };
});
