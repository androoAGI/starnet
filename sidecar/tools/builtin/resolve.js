/* sidecar/tools/builtin/resolve.js — DaVinci Resolve, the STUDIO's edit bay.

   A native port of the Hermes Agent `davinci-resolve` plugin (wassermanproductions, pinned bbd5b207), rebuilt
   for Agent OS and fixed where the original was wrong. Three tools, all granted by the STUDIO object:

     resolve_timeline_file  (write, consent) — build an FCPXML 1.10 timeline from a clip plan and save it into the
                            workspace. Works with FREE Resolve (File > Import > Timeline), no scripting needed.
     resolve_status         (read)           — is Resolve installed / reachable / Studio? Which project + timelines?
     resolve_control        (execute, consent) — LIVE edits through Resolve's own scripting API (Studio only):
                            launch · import_media · import_timeline · create_timeline · add_marker · render ·
                            render_status.

   Why the timeline writer is not a transliteration: the Hermes generator gave every clip one fixed length from
   source frame 0 (no real in/out), accepted integer frame rates only (29.97/23.976 impossible), put the file on a
   single track, hard-coded hasAudio=1 for every asset, and wrote the path as a legacy `src` on <asset>. Here:
   real in/out points, exact NTSC rationals (1001/30000s), connected clips on lanes above/below the spine,
   markers placed on whichever clip owns that moment, assets sized + flagged from ffprobe, <media-rep> paths.

   FREE vs STUDIO (the honest boundary): Blackmagic only lets EXTERNAL scripts attach to Resolve Studio;
   on free Resolve `scriptapp("Resolve")` returns None whatever the preferences say. resolve_status says which
   case the station is in and never claims a live connection it did not make. Resolve's scripting module is
   Python-only, so live control runs a fixed, embedded Python bridge (BRIDGE_PY below) — no model-authored code
   ever reaches the interpreter; the action + JSON args are validated here first.

   makeResolveTools({ fsp, pathMod, root, spawn, pathTrust?, envFor?, platform?, fileUrl?, config?:{ ffprobe?, python? } })
     -> { tools, register(reg), _internals }  — see test/resolve-tools.test.js */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./fs.js'), require('node:url'));
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).resolve = factory(root.SK.tools.builtin.fs, null); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fsMod, nodeUrl) {
  'use strict';

  const str = v => String(v == null ? '' : v).trim();
  const MAX_CLIPS = 500;
  const MAX_MARKERS = 500;
  const PROBE_TIMEOUT_MS = 15000;
  const BRIDGE_TIMEOUT_MS = 120000;
  const PY_PICK_TIMEOUT_MS = 10000;   // per launcher candidate (win32 tries up to 3: py -3, python, python3)
  const STATUS_PROBE_MS = 45000;
  /* resolve_status worst case: every launcher candidate times out before the last one answers, then the probe runs
     its full budget (3 x 10s + 45s = 75s). The registry backstop sits above that so it never pre-empts the probe's
     own honest 'not reachable' answer. */
  const STATUS_TIMEOUT_MS = 3 * PY_PICK_TIMEOUT_MS + STATUS_PROBE_MS + 15000;
  const OUT_MARK = '@@STARNET_RESOLVE@@';

  /* ── time ──────────────────────────────────────────────────────────────────────────────────────────────
     FCPXML time is a rational number of seconds. A frame at rate R is frameDuration = num/den seconds;
     frame n sits at n*num/den s. NTSC rates MUST use the 1001 rationals — a decimal 29.97 drifts. */
  const RATES = {
    '23.976': [1001, 24000], '23.98': [1001, 24000], '24': [1, 24], '25': [1, 25],
    '29.97': [1001, 30000], '30': [1, 30], '48': [1, 48], '50': [1, 50],
    '59.94': [1001, 60000], '60': [1, 60], '120': [1, 120]
  };
  function rateOf(fps) {
    const key = String(Number(fps == null || fps === '' ? 24 : fps));   // 30 -> '30', '29.970' -> '29.97'
    const r = RATES[key];
    if (!r) throw new Error('fps must be one of ' + Object.keys(RATES).join(', ') + ' (got ' + fps + ')');
    return { num: r[0], den: r[1], fps: r[1] / r[0] };
  }
  const toFrames = (sec, rate) => Math.round(Number(sec) * rate.fps);
  function ftime(frames, rate) {
    const n = Math.round(frames);
    if (!n) return '0s';
    // Left UNREDUCED on purpose (n frames = n*num/den s): a literal multiple of frameDuration is the form Resolve's
    // importer is known to accept; whole seconds collapse to "Ns".
    const top = n * rate.num, bot = rate.den;
    return (top % bot === 0) ? (top / bot) + 's' : top + '/' + bot + 's';
  }

  function xmlAttr(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }
  function el(name, attrs, children) {
    const a = Object.keys(attrs || {}).filter(k => attrs[k] != null && attrs[k] !== '')
      .map(k => ' ' + k + '="' + xmlAttr(attrs[k]) + '"').join('');
    if (!children || !children.length) return '<' + name + a + '/>';
    return '<' + name + a + '>' + children.join('') + '</' + name + '>';
  }

  const VIDEO_EXT = /\.(3g2|3gp|avi|braw|dv|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mxf|r3d|ts|webm)$/i;
  const AUDIO_EXT = /\.(aac|aif|aiff|flac|m4a|mp3|ogg|wav|wma)$/i;
  const IMAGE_EXT = /\.(bmp|dpx|exr|gif|jpeg|jpg|png|psd|tga|tif|tiff)$/i;
  function kindOf(p) { return VIDEO_EXT.test(p) ? 'video' : AUDIO_EXT.test(p) ? 'audio' : IMAGE_EXT.test(p) ? 'image' : 'unknown'; }

  /* ── the FCPXML builder (PURE) ─────────────────────────────────────────────────────────────────────────
     plan  : { name, fps, width, height, clips:[{ path, url, name?, in, out, lane?, at? }], markers:[{ at, name, note? }] }
             times in SECONDS. lane 0 (default) = the main storyline, clips play back-to-back unless `at` opens a
             gap; lane >0 = a connected clip ABOVE (b-roll, titles-as-media), lane <0 = BELOW (music, VO). A
             connected clip needs `at` (timeline seconds).
     media : { [path]: { duration (s), hasVideo, hasAudio, audioChannels?, audioRate? } } — from ffprobe
     -> { xml, stats:{ frames, seconds, spine, connected, markers, assets } } ; throws on an impossible plan. */
  function buildFcpxml(plan, media) {
    plan = plan || {}; media = media || {};
    const rate = rateOf(plan.fps);
    const W = Math.round(Number(plan.width) || 1920), H = Math.round(Number(plan.height) || 1080);
    if (!(W > 0 && H > 0 && W <= 16384 && H <= 16384)) throw new Error('width/height out of range');
    const clips = Array.isArray(plan.clips) ? plan.clips : [];
    if (!clips.length) throw new Error('clips must contain at least one clip');
    if (clips.length > MAX_CLIPS) throw new Error('at most ' + MAX_CLIPS + ' clips per timeline');

    // assets: one per distinct media path, ids r2.. (r1 is the format)
    const assetId = {}, assets = [];
    let nextId = 2;
    for (const c of clips) {
      if (assetId[c.path]) continue;
      const m = media[c.path] || {};
      const k = kindOf(c.path);
      const id = 'r' + (nextId++);
      assetId[c.path] = id;
      const hasVideo = m.hasVideo != null ? !!m.hasVideo : (k === 'video' || k === 'image');
      const hasAudio = m.hasAudio != null ? !!m.hasAudio : (k === 'audio');
      // an asset must be at least as long as the furthest out-point we cut from it
      const furthest = Math.max.apply(null, clips.filter(x => x.path === c.path).map(x => Number(x.out) || 0));
      const durSec = Math.max(Number(m.duration) || 0, furthest);
      const attrs = {
        id, name: c.assetName || baseName(c.path), start: '0s', duration: ftime(toFrames(durSec, rate), rate),
        hasVideo: hasVideo ? '1' : '0', hasAudio: hasAudio ? '1' : '0', format: hasVideo ? 'r1' : null
      };
      if (hasAudio) { attrs.audioSources = '1'; attrs.audioChannels = String(m.audioChannels || 2); attrs.audioRate = String(m.audioRate || 48000); }
      assets.push(el('asset', attrs, [el('media-rep', { kind: 'original-media', src: c.url })]));
    }

    // normalize + validate every clip in FRAMES (all arithmetic below is integer frames)
    const norm = clips.map((c, i) => {
      const inF = toFrames(c.in || 0, rate), outF = toFrames(c.out, rate);
      if (!(Number(c.out) > 0)) throw new Error('clip ' + (i + 1) + ': out (seconds) is required and must be > 0');
      if (inF < 0) throw new Error('clip ' + (i + 1) + ': in cannot be negative');
      if (outF <= inF) throw new Error('clip ' + (i + 1) + ': out must be after in (after rounding to ' + rate.fps.toFixed(3) + ' fps frames)');
      const lane = Math.round(Number(c.lane) || 0);
      if (Math.abs(lane) > 9) throw new Error('clip ' + (i + 1) + ': lane must be between -9 and 9');
      const hasAt = c.at != null && c.at !== '';
      if (lane !== 0 && !hasAt) throw new Error('clip ' + (i + 1) + ': a lane ' + lane + ' (connected) clip needs `at` — where on the timeline it starts, in seconds');
      return { i, ref: assetId[c.path], name: str(c.name) || baseName(c.path), inF, durF: outF - inF, lane, atF: hasAt ? toFrames(c.at, rate) : null, children: [] };
    });

    // lay the spine: lane-0 clips in given order; an `at` beyond the current end opens a <gap>
    const spine = [];
    let cursor = 0;
    for (const c of norm.filter(x => x.lane === 0)) {
      if (c.atF != null) {
        if (c.atF < cursor) throw new Error('clip ' + (c.i + 1) + ': at ' + ftime(c.atF, rate) + ' overlaps the previous main-track clip (main-track clips cannot overlap; put it on a lane)');
        if (c.atF > cursor) { spine.push({ gap: true, offF: cursor, durF: c.atF - cursor, srcF: 0, children: [] }); cursor = c.atF; }
      }
      spine.push({ clip: c, offF: cursor, durF: c.durF, srcF: c.inF, children: [] });
      cursor += c.durF;
    }
    // a connected clip / marker attaches to the spine element covering its timeline frame; extend with a gap
    // when something sits past the end of the main storyline (e.g. music under an empty timeline).
    function ownerAt(tF, needF) {
      let o = spine.find(s => tF >= s.offF && tF < s.offF + s.durF);
      if (!o) {
        const end = spine.length ? spine[spine.length - 1].offF + spine[spine.length - 1].durF : 0;
        const upTo = Math.max(tF + (needF || 1), end + 1);
        o = { gap: true, offF: end, durF: upTo - end, srcF: 0, children: [] };
        spine.push(o);
      }
      return o;
    }
    let connected = 0;
    for (const c of norm.filter(x => x.lane !== 0)) {
      const o = ownerAt(c.atF, c.durF);
      o.children.push(el('asset-clip', { ref: c.ref, name: c.name, lane: String(c.lane), offset: ftime(o.srcF + (c.atF - o.offF), rate), start: ftime(c.inF, rate), duration: ftime(c.durF, rate) }));
      connected++;
    }
    const markers = Array.isArray(plan.markers) ? plan.markers : [];
    if (markers.length > MAX_MARKERS) throw new Error('at most ' + MAX_MARKERS + ' markers');
    for (const [j, m] of markers.entries()) {
      if (!(Number(m.at) >= 0)) throw new Error('marker ' + (j + 1) + ': at (timeline seconds) is required');
      const tF = toFrames(m.at, rate);
      const o = ownerAt(tF, 1);
      // markers lead the children list so the file reads marker-then-connected like FCP's own exports
      o.children.unshift(el('marker', { start: ftime(o.srcF + (tF - o.offF), rate), duration: ftime(1, rate), value: str(m.name) || 'Marker', note: str(m.note) }));
    }

    const total = spine.length ? spine[spine.length - 1].offF + spine[spine.length - 1].durF : 0;
    const spineXml = spine.map(s => s.gap
      ? el('gap', { name: 'Gap', offset: ftime(s.offF, rate), start: '0s', duration: ftime(s.durF, rate) }, s.children)
      : el('asset-clip', { ref: s.clip.ref, name: s.clip.name, offset: ftime(s.offF, rate), start: ftime(s.srcF, rate), duration: ftime(s.durF, rate) }, s.children));
    const fmt = el('format', { id: 'r1', name: 'FFVideoFormat' + H + 'p' + String(plan.fps || 24).replace('.', ''), frameDuration: ftime(1, rate), width: String(W), height: String(H) });
    const title = str(plan.name) || 'Agent OS Timeline';
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' +
      el('fcpxml', { version: '1.10' }, [
        el('resources', {}, [fmt].concat(assets)),
        el('library', {}, [el('event', { name: 'Agent OS' }, [el('project', { name: title }, [
          el('sequence', { format: 'r1', duration: ftime(total, rate), tcStart: '0s', tcFormat: 'NDF', audioLayout: 'stereo', audioRate: '48k' },
            [el('spine', {}, spineXml)])
        ])])])
      ]) + '\n';
    return { xml, stats: { frames: total, seconds: +(total / rate.fps).toFixed(3), spine: spine.filter(s => !s.gap).length, gaps: spine.filter(s => s.gap).length, connected, markers: markers.length, assets: assets.length } };
  }

  function baseName(p) { return String(p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'clip'; }

  /* ── the Studio bridge (fixed Python, never model-authored) ──────────────────────────────────────────── */
  const BRIDGE_PY = String.raw`
import json, os, sys, importlib.util
MARK = "@@STARNET_RESOLVE@@"
def out(o):
    sys.stdout.write("\n" + MARK + json.dumps(o, default=str) + "\n"); sys.stdout.flush(); sys.exit(0)
req = json.loads(sys.argv[1]); act = req.get("action"); a = req.get("args") or {}
def load():
    errs = []
    try:
        import DaVinciResolveScript as m
        return m, None
    except Exception as e:
        errs.append("import: %s: %s" % (type(e).__name__, e))
    api = os.environ.get("RESOLVE_SCRIPT_API", "")
    p = os.path.join(api, "Modules", "DaVinciResolveScript.py") if api else ""
    if p and os.path.exists(p):
        try:
            spec = importlib.util.spec_from_file_location("DaVinciResolveScript", p)
            m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
            return m, None
        except Exception as e:
            errs.append("%s: %s: %s" % (p, type(e).__name__, e))
    else:
        errs.append("no module at " + (p or "(RESOLVE_SCRIPT_API unset)"))
    return None, "; ".join(errs)
mod, import_error = load()
base = {"python": sys.version.split()[0], "module_imported": mod is not None, "import_error": import_error}
if mod is None:
    out(dict(base, ok=False, reachable=False, error="DaVinci Resolve's scripting module could not be imported"))
try:
    resolve = mod.scriptapp("Resolve")
except Exception as e:
    out(dict(base, ok=False, reachable=False, error="scriptapp failed: %s: %s" % (type(e).__name__, e)))
if resolve is None:
    out(dict(base, ok=False, reachable=False, error="Resolve did not answer. It must be running, be Resolve STUDIO, and have Preferences > System > General > External scripting using: Local"))
def safe(f, d=None):
    try:
        return f()
    except Exception:
        return d
base.update(reachable=True, product=safe(lambda: resolve.GetProductName()), version=safe(lambda: resolve.GetVersionString()))
pm = resolve.GetProjectManager()
project = pm.GetCurrentProject() if pm else None
def need_project():
    if not project:
        out(dict(base, ok=False, error="no project is open in Resolve"))
def tl_info(tl):
    if not tl:
        return None
    return {"name": tl.GetName(), "fps": safe(lambda: tl.GetSetting("timelineFrameRate")), "start_frame": safe(lambda: tl.GetStartFrame()),
            "end_frame": safe(lambda: tl.GetEndFrame()), "markers": len(safe(lambda: tl.GetMarkers(), {}) or {}),
            "video_tracks": safe(lambda: tl.GetTrackCount("video")), "audio_tracks": safe(lambda: tl.GetTrackCount("audio"))}
if act == "probe":
    if not project:
        out(dict(base, ok=True, project=None))
    names = []
    for i in range(1, (project.GetTimelineCount() or 0) + 1):
        t = project.GetTimelineByIndex(i)
        if t: names.append(t.GetName())
    out(dict(base, ok=True, project=project.GetName(), timelines=names, current_timeline=tl_info(project.GetCurrentTimeline())))
need_project()
mp = project.GetMediaPool()
def into_bin(name):
    if name:
        f = mp.AddSubFolder(mp.GetRootFolder(), name)
        if f: mp.SetCurrentFolder(f)
if act == "import_media":
    into_bin(a.get("bin"))
    items = mp.ImportMedia(a["paths"]) or []
    out(dict(base, ok=len(items) > 0, imported=[i.GetName() for i in items if i], requested=len(a["paths"]),
             error=None if items else "Resolve imported nothing (unsupported or unreadable files?)"))
if act == "import_timeline":
    opts = {"importSourceClips": True}
    if a.get("name"): opts["timelineName"] = a["name"]
    tl = mp.ImportTimelineFromFile(a["path"], opts)
    if not tl: out(dict(base, ok=False, error="Resolve refused the timeline file"))
    project.SetCurrentTimeline(tl)
    out(dict(base, ok=True, timeline=tl_info(tl)))
if act == "create_timeline":
    into_bin(a.get("bin"))
    paths = []
    for c in a["clips"]:
        if c["path"] not in paths: paths.append(c["path"])
    items = mp.ImportMedia(paths) or []
    by_path = {}
    for it in items:
        fp = safe(lambda: it.GetClipProperty("File Path"))
        if fp: by_path[os.path.normcase(os.path.abspath(fp))] = it
    tl = mp.CreateEmptyTimeline(a["name"])
    if not tl: out(dict(base, ok=False, error="Resolve did not create the timeline (name already used?)"))
    project.SetCurrentTimeline(tl)
    infos, missing = [], []
    for c in a["clips"]:
        it = by_path.get(os.path.normcase(os.path.abspath(c["path"])))
        if not it:
            missing.append(c["path"]); continue
        fps = float(safe(lambda: it.GetClipProperty("FPS"), 0) or 0) or float(safe(lambda: tl.GetSetting("timelineFrameRate"), 24) or 24)
        info = {"mediaPoolItem": it, "startFrame": int(round(c["in"] * fps)), "endFrame": int(round(c["out"] * fps)) - 1}
        if c.get("track"): info["trackIndex"] = int(c["track"])
        if c.get("media_type"): info["mediaType"] = 1 if c["media_type"] == "video" else 2
        if c.get("at") is not None:
            tfps = float(safe(lambda: tl.GetSetting("timelineFrameRate"), fps) or fps)
            info["recordFrame"] = int(tl.GetStartFrame()) + int(round(c["at"] * tfps))
        infos.append(info)
    placed = mp.AppendToTimeline(infos) or [] if infos else []
    out(dict(base, ok=len(placed) > 0, timeline=tl_info(tl), placed=len(placed), requested=len(a["clips"]), missing=missing))
if act == "add_marker":
    tl = project.GetCurrentTimeline()
    if not tl: out(dict(base, ok=False, error="no current timeline"))
    fps = float(safe(lambda: tl.GetSetting("timelineFrameRate"), 24) or 24)
    frame = int(round(a["at"] * fps))
    ok = tl.AddMarker(frame, a.get("color") or "Blue", a["name"], a.get("note") or "", int(a.get("duration") or 1), "")
    out(dict(base, ok=bool(ok), frame=frame, timeline=tl.GetName(), error=None if ok else "Resolve refused the marker (a marker may already sit on that frame)"))
if act == "render":
    if not project.GetCurrentTimeline(): out(dict(base, ok=False, error="no current timeline to render"))
    preset = a.get("preset")
    preset_loaded = bool(project.LoadRenderPreset(preset)) if preset else None
    fc = bool(project.SetCurrentRenderFormatAndCodec(a["format"], a["codec"])) if (a.get("format") and a.get("codec")) else None
    os.makedirs(a["target_dir"], exist_ok=True)
    settings_ok = bool(project.SetRenderSettings({"TargetDir": a["target_dir"], "CustomName": a["name"]}))
    job = project.AddRenderJob()
    if not job: out(dict(base, ok=False, error="Resolve did not create a render job", preset_loaded=preset_loaded, format_codec_set=fc, settings_set=settings_ok))
    started = bool(project.StartRendering(job)) if a.get("start", True) else False
    out(dict(base, ok=True, job_id=job, started=started, preset_loaded=preset_loaded, format_codec_set=fc, settings_set=settings_ok, target_dir=a["target_dir"]))
if act == "render_status":
    jid = a.get("job_id")
    out(dict(base, ok=True, job_id=jid, status=project.GetRenderJobStatus(jid) if jid else None, rendering=bool(project.IsRenderingInProgress()), jobs=project.GetRenderJobList() or []))
out(dict(base, ok=False, error="unknown action " + str(act)))
`;

  /* default Resolve locations (Blackmagic's own README paths) — used only to fill env vars the user hasn't set */
  function resolveEnvDefaults(platform, env) {
    env = env || {};
    const d = {};
    if (platform === 'win32') {
      const pd = env.PROGRAMDATA || env.ProgramData || 'C:\\ProgramData';
      const pf = env.PROGRAMFILES || env.ProgramFiles || 'C:\\Program Files';
      d.RESOLVE_SCRIPT_API = pd + '\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting';
      d.RESOLVE_SCRIPT_LIB = pf + '\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll';
      d.app = pf + '\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe';
    } else if (platform === 'darwin') {
      d.RESOLVE_SCRIPT_API = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting';
      d.RESOLVE_SCRIPT_LIB = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so';
      d.app = '/Applications/DaVinci Resolve/DaVinci Resolve.app';
    } else {
      d.RESOLVE_SCRIPT_API = '/opt/resolve/Developer/Scripting';
      d.RESOLVE_SCRIPT_LIB = '/opt/resolve/libs/Fusion/fusionscript.so';
      d.app = '/opt/resolve/bin/resolve';
    }
    return d;
  }

  function makeResolveTools(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root, spawn = deps.spawn;
    if (!fsp || !P || !ROOT || typeof spawn !== 'function') throw new Error('resolve.js requires { fsp, pathMod, root, spawn }');
    const platform = deps.platform || process.platform;
    const envFor = typeof deps.envFor === 'function' ? deps.envFor : () => Object.assign({}, process.env);
    const fileUrl = deps.fileUrl || (p => nodeUrl.pathToFileURL(p).href);
    // host overrides arrive as config, NOT via the child env: sanitizeChildEnv strips every STARNET_* name.
    const cfg = deps.config || {};
    const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT, pathTrust: deps.pathTrust })._internals;

    // one child process, bounded; never a shell. Resolves {code, stdout, stderr, error}.
    function run(cmd, args, opts) {
      opts = opts || {};
      return new Promise(resolve => {
        let child, done = false, stdout = '', stderr = '';
        const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ stdout, stderr }, r)); };
        try { child = spawn(cmd, args, { shell: false, windowsHide: true, env: opts.env || envFor() }); }
        catch (e) { return resolve({ code: null, stdout: '', stderr: '', error: e && e.message || String(e) }); }
        const timer = setTimeout(() => { try { child.kill(); } catch (e) { stderr += String(e && e.message || e); } finish({ code: null, error: 'timed out after ' + (opts.timeoutMs || PROBE_TIMEOUT_MS) + 'ms' }); }, opts.timeoutMs || PROBE_TIMEOUT_MS);
        if (child.stdout) child.stdout.on('data', d => { if (stdout.length < 4e6) stdout += d; });
        if (child.stderr) child.stderr.on('data', d => { if (stderr.length < 2e5) stderr += d; });
        child.on('error', e => finish({ code: null, error: e && e.message || String(e) }));
        child.on('close', code => finish({ code }));
      });
    }

    // media facts from ffprobe; null when ffprobe is absent or the file can't be read (the caller says so).
    async function probeMedia(abs) {
      const ff = str(cfg.ffprobe) || 'ffprobe';
      const r = await run(ff, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { timeoutMs: PROBE_TIMEOUT_MS });
      if (r.code !== 0) return { ok: false, reason: r.error || str(r.stderr).split('\n')[0] || ('ffprobe exit ' + r.code) };
      let j; try { j = JSON.parse(r.stdout); } catch (e) { return { ok: false, reason: 'ffprobe output unreadable' }; }
      const streams = j.streams || [];
      const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
      const a = streams.find(s => s.codec_type === 'audio');
      return { ok: true, duration: Number(j.format && j.format.duration) || Number(v && v.duration) || 0, hasVideo: !!v, hasAudio: !!a,
        audioChannels: a && a.channels, audioRate: a && Number(a.sample_rate), width: v && v.width, height: v && v.height };
    }

    // a media path from the model: workspace-relative stays in the jail; absolute goes through path-trust (read).
    async function mediaPath(aid, p, ctx) {
      const raw = str(p);
      if (!raw) throw new Error('every clip needs a path');
      const { abs } = await jail.resolveInside(aid, raw, { scope: 'read', ctx });
      return abs;
    }

    // Python for the bridge: STARNET_RESOLVE_PYTHON, else the platform's usual launchers. First that answers wins.
    async function pickPython(env) {
      const forced = str(cfg.python);
      const cands = forced ? [[forced, []]] : (platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]);
      const tried = [];
      for (const [cmd, pre] of cands) {
        const r = await run(cmd, pre.concat(['-c', 'import sys;print(sys.version_info[0])']), { env, timeoutMs: PY_PICK_TIMEOUT_MS });
        if (r.code === 0 && /^3/.test(str(r.stdout))) return { cmd, pre };
        tried.push(cmd + ': ' + (r.error || ('exit ' + r.code)));
      }
      return { cmd: null, tried };
    }

    function bridgeEnv() {
      const env = envFor();
      const d = resolveEnvDefaults(platform, env);
      if (!env.RESOLVE_SCRIPT_API) env.RESOLVE_SCRIPT_API = d.RESOLVE_SCRIPT_API;
      if (!env.RESOLVE_SCRIPT_LIB) env.RESOLVE_SCRIPT_LIB = d.RESOLVE_SCRIPT_LIB;
      const mods = P.join(env.RESOLVE_SCRIPT_API, 'Modules');
      env.PYTHONPATH = env.PYTHONPATH ? env.PYTHONPATH + (platform === 'win32' ? ';' : ':') + mods : mods;
      return env;
    }

    async function bridge(action, args, timeoutMs) {
      const env = bridgeEnv();
      const py = await pickPython(env);
      if (!py.cmd) return { ok: false, reachable: false, error: 'no Python 3 found for the Resolve bridge (' + py.tried.join('; ') + '). Install Python 3.10–3.12 or set STARNET_RESOLVE_PYTHON.' };
      const r = await run(py.cmd, py.pre.concat(['-c', BRIDGE_PY, JSON.stringify({ action, args: args || {} })]), { env, timeoutMs: timeoutMs || BRIDGE_TIMEOUT_MS });
      const at = r.stdout.lastIndexOf(OUT_MARK);
      if (at < 0) return { ok: false, reachable: false, error: 'the Resolve bridge produced no result' + (r.error ? ' (' + r.error + ')' : '') + (r.stderr ? ': ' + str(r.stderr).split('\n').slice(-3).join(' | ') : '') };
      try { return Object.assign(JSON.parse(r.stdout.slice(at + OUT_MARK.length).trim().split('\n')[0]), { via: py.cmd }); }
      catch (e) { return { ok: false, reachable: false, error: 'the Resolve bridge result was unreadable' }; }
    }

    async function installed() {
      const app = resolveEnvDefaults(platform, envFor()).app;
      try { await fsp.access(app); return app; } catch (e) { return null; }   // absent or unreadable: either way not launchable
    }

    function emitDeliverable(ctx, aid, rel) {
      if (!ctx || typeof ctx.emit !== 'function') return;
      const d = { id: 'fcpxml_' + String(rel).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: String(rel) };
      if (ctx.room) d.room = ctx.room;
      ctx.emit('deliverable', d);
    }

    const num = (v, d) => (v == null || v === '' ? d : Number(v));

    // ── resolve_timeline_file ──────────────────────────────────────────────────────────────────────────
    const timelineTool = {
      name: 'resolve_timeline_file', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: 180000,
      description: 'Build a DaVinci Resolve timeline as an FCPXML 1.10 file in your workspace — the edit decision list '
        + 'for a cut: which clips, which in/out points, in what order, on which track, with markers. Works with FREE '
        + 'Resolve: the user imports it via File > Import > Timeline (or resolve_control action=import_timeline on '
        + 'Studio). Times are SECONDS. Main-track (lane 0) clips play back to back in the order given; give `at` to '
        + 'leave a gap before one. lane > 0 = a connected clip above the main track (b-roll, overlays), lane < 0 = '
        + 'below (music, voice-over); connected clips need `at`. Media durations and audio/video streams are read '
        + 'with ffprobe when available. Paths: workspace-relative, or absolute paths the station has granted.',
      schema: { type: 'object', required: ['name', 'clips'], properties: {
        name: { type: 'string', description: 'timeline / project name' },
        fps: { type: 'number', description: 'timeline frame rate: 23.976, 24, 25, 29.97, 30, 50, 59.94, 60 (default 24)' },
        width: { type: 'number', description: 'default 1920' },
        height: { type: 'number', description: 'default 1080' },
        clips: { type: 'array', description: 'the cut, in order', items: { type: 'object', required: ['path', 'out'], properties: {
          path: { type: 'string' }, in: { type: 'number', description: 'source in-point, seconds (default 0)' },
          out: { type: 'number', description: 'source out-point, seconds' }, lane: { type: 'number', description: '0 main, >0 above, <0 below' },
          at: { type: 'number', description: 'timeline position in seconds (required for lane != 0)' }, name: { type: 'string' } } } },
        markers: { type: 'array', items: { type: 'object', required: ['at', 'name'], properties: {
          at: { type: 'number', description: 'timeline seconds' }, name: { type: 'string' }, note: { type: 'string' } } } },
        path: { type: 'string', description: 'output file in your workspace (default edits/<name>.fcpxml)' }
      } },
      run: async (args, ctx) => {
        args = args || {};
        const aid = (ctx && ctx.agentId) || 'agent';
        const clipsIn = Array.isArray(args.clips) ? args.clips : [];
        if (!clipsIn.length) throw new Error('clips must contain at least one clip');
        if (clipsIn.length > MAX_CLIPS) throw new Error('at most ' + MAX_CLIPS + ' clips per timeline');
        const absOf = {};
        for (const c of clipsIn) { const k = str(c && c.path); if (!(k in absOf)) absOf[k] = await mediaPath(aid, k, ctx); }
        const media = {}, notes = [];
        for (const k of Object.keys(absOf)) {
          const abs = absOf[k];
          try { await fsp.access(abs); } catch (e) { throw new Error('media not found: ' + k); }
          const m = await probeMedia(abs);
          if (m.ok) media[abs] = m;
          else notes.push(baseName(k) + ': not probed (' + m.reason + ') — stream flags guessed from the extension');
        }
        const plan = {
          name: str(args.name) || 'Agent OS Timeline', fps: num(args.fps, 24), width: num(args.width, 1920), height: num(args.height, 1080),
          clips: clipsIn.map(c => ({ path: absOf[str(c.path)], url: fileUrl(absOf[str(c.path)]), name: c.name, in: num(c.in, 0), out: c.out, lane: c.lane, at: c.at })),
          markers: Array.isArray(args.markers) ? args.markers : []
        };
        for (const c of plan.clips) {
          const m = media[c.path];
          if (m && m.duration && Number(c.out) > m.duration + 0.05) notes.push(baseName(c.path) + ': out ' + c.out + 's is past the media end (' + m.duration.toFixed(2) + 's)');
        }
        const built = buildFcpxml(plan, media);
        let rel = str(args.path) || ('edits/' + (plan.name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'timeline') + '.fcpxml');
        if (!/\.fcpxml$/i.test(rel)) rel += '.fcpxml';
        const { abs } = await jail.resolveInside(aid, rel, { scope: 'write', ctx });
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, built.xml, 'utf8');
        emitDeliverable(ctx, aid, rel);
        const s = built.stats;
        return {
          content: 'Saved ' + rel + ' — FCPXML 1.10, ' + s.seconds + 's at ' + plan.fps + ' fps, ' + s.spine + ' main-track clip(s), '
            + s.connected + ' connected clip(s), ' + s.gaps + ' gap(s), ' + s.markers + ' marker(s), ' + s.assets + ' source file(s).\n'
            + 'Absolute path: ' + abs + '\n'
            + 'Free Resolve: File > Import > Timeline… and pick that file (media links by absolute path). '
            + 'Resolve Studio: resolve_control action=import_timeline path=' + rel + '.'
            + (notes.length ? '\nNotes: ' + notes.join('; ') : ''),
          summary: 'fcpxml → ' + rel
        };
      }
    };

    // ── resolve_status ─────────────────────────────────────────────────────────────────────────────────
    const statusTool = {
      name: 'resolve_status', capability: 'studio', scope: 'read', requiresConsent: false, timeoutMs: STATUS_TIMEOUT_MS,
      description: 'Check DaVinci Resolve on this machine: installed? reachable for live control (Studio + external '
        + 'scripting on)? which project, timelines, current timeline (fps, length, tracks, markers). Call this before '
        + 'resolve_control. If live control is unavailable (free Resolve, Resolve closed), use resolve_timeline_file.',
      schema: { type: 'object', properties: {} },
      run: async () => {
        const app = await installed();
        const r = await bridge('probe', {}, STATUS_PROBE_MS);
        const lines = [];
        lines.push('Installed: ' + (app ? 'yes (' + app + ')' : 'not found at the default location'));
        if (r.reachable) {
          lines.push('Live control: YES — ' + (r.product || 'DaVinci Resolve') + ' ' + (r.version || '') + ' (Python ' + r.python + ' via ' + r.via + ')');
          lines.push('Project: ' + (r.project || 'none open'));
          if (r.timelines) lines.push('Timelines (' + r.timelines.length + '): ' + (r.timelines.join(', ') || '—'));
          const t = r.current_timeline;
          if (t) lines.push('Current timeline: ' + t.name + ' @ ' + t.fps + ' fps, frames ' + t.start_frame + '–' + t.end_frame + ', ' + t.video_tracks + 'V/' + t.audio_tracks + 'A, ' + t.markers + ' marker(s)');
        } else {
          lines.push('Live control: NO — ' + (r.error || 'not reachable'));
          if (r.import_error && !r.module_imported) lines.push('Module: ' + r.import_error);
          lines.push('Use resolve_timeline_file: it works with free Resolve (File > Import > Timeline).');
        }
        return { content: lines.join('\n'), summary: r.reachable ? 'resolve live' : 'resolve not live' };
      }
    };

    // ── resolve_control ────────────────────────────────────────────────────────────────────────────────
    const ACTIONS = ['launch', 'import_media', 'import_timeline', 'create_timeline', 'add_marker', 'render', 'render_status'];
    const controlTool = {
      name: 'resolve_control', capability: 'studio', scope: 'execute', requiresConsent: true, timeoutMs: BRIDGE_TIMEOUT_MS + 30000,
      description: 'Drive a running DaVinci Resolve STUDIO live (external scripting must be on). Actions: '
        + 'launch (open Resolve) · import_media {paths[], bin?} · import_timeline {path (.fcpxml/.xml/.edl/.otio/.aaf), name?} · '
        + 'create_timeline {name, clips[{path,in,out,track?,at?,media_type?}], bin?} (seconds) · add_marker {at (timeline seconds), name, note?, color?} · '
        + 'render {name, target_dir? (default workspace renders/), preset?, format?, codec?, start?} · render_status {job_id?}. '
        + 'Call resolve_status first; on free Resolve use resolve_timeline_file instead.',
      schema: { type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: ACTIONS }, paths: { type: 'array', items: { type: 'string' } }, bin: { type: 'string' },
        path: { type: 'string' }, name: { type: 'string' }, note: { type: 'string' }, color: { type: 'string' },
        at: { type: 'number' }, clips: { type: 'array', items: { type: 'object' } },
        target_dir: { type: 'string' }, preset: { type: 'string' }, format: { type: 'string' }, codec: { type: 'string' },
        start: { type: 'boolean' }, job_id: { type: 'string' }
      } },
      run: async (args, ctx) => {
        args = args || {};
        const aid = (ctx && ctx.agentId) || 'agent';
        const action = str(args.action);
        if (ACTIONS.indexOf(action) < 0) throw new Error('action must be one of ' + ACTIONS.join(', '));
        let payload = {};
        if (action === 'launch') {
          const app = await installed();
          if (!app) throw new Error('DaVinci Resolve is not installed at the default location');
          const r = platform === 'darwin' ? await run('open', ['-a', app], { timeoutMs: 15000 })
            : await new Promise(res => { try { const ch = spawn(app, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: false }); ch.on('error', e => res({ code: null, error: e.message })); if (ch.unref) ch.unref(); setTimeout(() => res({ code: 0 }), 1500); } catch (e) { res({ code: null, error: e.message }); } });
          if (r.code !== 0) throw new Error('could not launch Resolve: ' + (r.error || 'exit ' + r.code));
          return { content: 'Launched ' + app + '. Resolve takes a while to open — call resolve_status until it reports live control.', summary: 'resolve launched' };
        }
        if (action === 'import_media') {
          const paths = Array.isArray(args.paths) ? args.paths : [];
          if (!paths.length || paths.length > MAX_CLIPS) throw new Error('import_media needs 1–' + MAX_CLIPS + ' paths');
          payload = { paths: [], bin: str(args.bin) || null };
          for (const p of paths) payload.paths.push(await mediaPath(aid, p, ctx));
        } else if (action === 'import_timeline') {
          if (!/\.(fcpxml|xml|edl|otio|aaf|drt)$/i.test(str(args.path))) throw new Error('import_timeline needs a path to a .fcpxml/.xml/.edl/.otio/.aaf/.drt file');
          payload = { path: await mediaPath(aid, args.path, ctx), name: str(args.name) || null };
        } else if (action === 'create_timeline') {
          const clips = Array.isArray(args.clips) ? args.clips : [];
          if (!str(args.name) || !clips.length || clips.length > MAX_CLIPS) throw new Error('create_timeline needs a name and 1–' + MAX_CLIPS + ' clips');
          payload = { name: str(args.name), bin: str(args.bin) || null, clips: [] };
          for (const [i, c] of clips.entries()) {
            const inS = num(c.in, 0), outS = Number(c.out);
            if (!(outS > inS && inS >= 0)) throw new Error('clip ' + (i + 1) + ': needs out > in >= 0 (seconds)');
            payload.clips.push({ path: await mediaPath(aid, c.path, ctx), in: inS, out: outS,
              track: c.track != null ? Math.max(1, Math.round(Number(c.track))) : null,
              at: c.at != null ? Math.max(0, Number(c.at)) : null,
              media_type: c.media_type === 'video' || c.media_type === 'audio' ? c.media_type : null });
          }
        } else if (action === 'add_marker') {
          if (!(Number(args.at) >= 0) || !str(args.name)) throw new Error('add_marker needs at (timeline seconds) and name');
          const COLORS = ['Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia', 'Rose', 'Lavender', 'Sky', 'Mint', 'Lemon', 'Sand', 'Cocoa', 'Cream'];
          const color = COLORS.find(c => c.toLowerCase() === str(args.color).toLowerCase()) || 'Blue';
          payload = { at: Number(args.at), name: str(args.name), note: str(args.note), color };
        } else if (action === 'render') {
          if (!str(args.name)) throw new Error('render needs a name (the output file name)');
          const dirRel = str(args.target_dir) || 'renders';
          const { abs } = await jail.resolveInside(aid, dirRel, { scope: 'write', ctx });
          payload = { name: str(args.name).replace(/[\\/:*?"<>|]+/g, '_'), target_dir: abs, preset: str(args.preset) || null,
            format: str(args.format) || null, codec: str(args.codec) || null, start: args.start !== false };
        } else if (action === 'render_status') {
          payload = { job_id: str(args.job_id) || null };
        }
        const r = await bridge(action, payload);
        if (!r.reachable) throw new Error('Resolve is not reachable for live control: ' + (r.error || 'unknown') + ' — on free Resolve use resolve_timeline_file.');
        if (!r.ok) throw new Error('Resolve ' + action + ' failed: ' + (r.error || 'no detail'));
        const { python, module_imported, import_error, reachable, via, ok, ...rest } = r;
        return { content: 'Resolve ' + action + ' OK.\n' + JSON.stringify(rest, null, 1).slice(0, 6000), summary: 'resolve ' + action };
      }
    };

    const tools = [timelineTool, statusTool, controlTool];
    return {
      tools,
      register(reg) { tools.forEach(t => reg.register(t)); return reg; },
      _internals: { buildFcpxml, rateOf, ftime, toFrames, probeMedia, bridge, pickPython, resolveEnvDefaults, BRIDGE_PY, OUT_MARK }
    };
  }

  return { makeResolveTools, buildFcpxml, rateOf, ftime, _internals: { PY_PICK_TIMEOUT_MS, STATUS_PROBE_MS, STATUS_TIMEOUT_MS } };
});
