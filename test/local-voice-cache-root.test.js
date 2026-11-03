'use strict';
/* node test/local-voice-cache-root.test.js — the voice-model cache never resolves inside the install folder, and a
   cache that is already on disk is moved or reused, never downloaded again.

   THE HOLE (gh#65): on Windows the download sat in %LOCALAPPDATA%\StarNet\models, and %LOCALAPPDATA%\StarNet IS the NSIS
   per-user install folder. The uninstaller deletes only the files it installed and then a non-recursive RMDir, so an
   uninstall orphaned 150-330 MB of weights and kept the install folder alive. On macOS the cache sat beside the app's
   own folder, so a manual wipe needed a second one. The bare sidecar's %LOCALAPPDATA%\StarNet\workspaces stays where it
   is: that is station data, the one documented exception, and whether ERASE deletes it is Andrew's call.

   HOW THE ROWS RUN: the real sidecar module is copied into a scratch tree whose node_modules holds fake engine packages,
   so warm, transcribe and synthesize run their production path (require.resolve, import, env.cacheDir, pipeline,
   from_pretrained) and only the engine itself is fake. A model file that is not under the cacheDir the engine was handed
   counts as a remote fetch and lands there, as the real engine's would. Every row gets a fresh profile, a fresh module
   instance and a faked process.platform, so the Windows and macOS layouts run on every host. Rust's half of the same
   rule is test/native-process-ownership/tests/voice_cache_roots.rs; both read test/fixtures/voice-cache-roots.json. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const A = require('./_assert.js');
const { sidecarFileContaining } = require('./helpers/source.js');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-cache-roots.json'), 'utf8'));
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-voice-roots-')));
const MODULE = path.join(SCRATCH, 'sidecar', 'local-voice.js');
const SAVED_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
const SAVED_ENV = { ...process.env };
const LIFECYCLE_ENV = ['LOCALAPPDATA', 'USERPROFILE', 'HOME', 'XDG_CACHE_HOME', 'STARNET_MODEL_CACHE',
  'STARNET_KOKORO_DTYPE', 'SKYNET_KOKORO_DTYPE', 'STARNET_LOCAL_VOICE', 'SKYNET_LOCAL_VOICE'];
const SPEECH = Buffer.from(new Float32Array(16000).fill(0.1).buffer);
const WHISPER_FILES = ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'];

const engine = globalThis.__voiceEngine = [];

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const kokoroFile = (root, name = 'model.onnx') =>
  path.join(root, 'transformers-kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx', name);
const whisperFile = (root, name) => path.join(root, 'transformers', 'Xenova', 'whisper-tiny.en', 'onnx', name);
const seedTts = (root, text = 'kokoro weights') => write(kokoroFile(root), text);
const seedAsr = (root, text = 'whisper weights') => { for (const name of WHISPER_FILES) write(whisperFile(root, name), text); };
const seedBoth = (root, text) => { seedTts(root, text); seedAsr(root, text); };
const inside = (file, dir) => { const rel = path.relative(dir, file); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const fetches = () => engine.flatMap(load => load.fetched);
const family = name => engine.filter(load => load.family === name);
const servedFrom = (name, root) => family(name).length > 0 && family(name).every(load => inside(load.cacheDir, root));

/* The two engine packages at the edge. The real ones are huge and fetch from the network; these do the one thing this
   test is about: look for the model under the cacheDir they were handed, and say when they would have had to fetch it. */
function installFakeEngines() {
  const pkg = (dir, main) => write(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), main }));
  const modules = path.join(SCRATCH, 'node_modules');
  const lookUp = `
    import fs from 'node:fs';
    import path from 'node:path';
    function need(family, cacheDir, dir, names) {
      const fetched = names.filter(name => !fs.existsSync(path.join(dir, name)));
      globalThis.__voiceEngine.push({ family, cacheDir, fetched });
      fs.mkdirSync(dir, { recursive: true });
      for (const name of fetched) fs.writeFileSync(path.join(dir, name), 'downloaded');
    }`;
  const asr = path.join(modules, '@huggingface', 'transformers');
  pkg(asr, 'index.mjs');
  write(path.join(asr, 'index.mjs'), `${lookUp}
    export const env = {};
    export async function pipeline(task, model) {
      need('asr', env.cacheDir, path.join(env.cacheDir, model, 'onnx'), ${JSON.stringify(WHISPER_FILES)});
      return async () => ({ text: 'heard' });
    }`);
  const kokoro = path.join(modules, 'kokoro-js');
  pkg(kokoro, 'dist/index.mjs');
  write(path.join(kokoro, 'dist', 'index.mjs'), `${lookUp}
    import { env } from '@huggingface/transformers';
    const FILES = { fp32: 'model.onnx', q4: 'model_q4.onnx' };
    export const KokoroTTS = {
      async from_pretrained(id, options) {
        need('tts', env.cacheDir, path.join(env.cacheDir, id, 'onnx'), [FILES[options.dtype]]);
        return { generate: async () => ({ audio: new Float32Array(12000).fill(0.3), sampling_rate: 24000 }) };
      }
    };`);
  const nested = path.join(kokoro, 'node_modules', '@huggingface', 'transformers');
  pkg(nested, 'index.mjs');
  write(path.join(nested, 'index.mjs'), 'export const env = {};');
  const sharp = path.join(modules, 'sharp');
  pkg(sharp, 'index.js');
  write(path.join(sharp, 'index.js'), 'module.exports = { block() {} };');
}

function freshVoice() {
  delete require.cache[MODULE];
  return require(MODULE);
}

function layout(kind, name) {
  const profile = path.join(SCRATCH, 'profiles', name);
  if (kind === 'windows') {
    const local = path.join(profile, 'AppData', 'Local');
    return { platform: 'win32', env: { LOCALAPPDATA: local, USERPROFILE: profile, HOME: profile }, profile,
      installDir: path.join(local, 'StarNet'), root: path.join(local, 'ai.skynet.harness', 'models'),
      legacy: path.join(local, 'StarNet', 'models') };
  }
  if (kind === 'macos') {
    const support = path.join(profile, 'Library', 'Application Support');
    return { platform: 'darwin', env: { USERPROFILE: profile, HOME: profile }, profile,
      installDir: path.join(support, 'StarNet'), root: path.join(support, 'ai.skynet.harness', 'models'),
      legacy: path.join(support, 'StarNet', 'models') };
  }
  const xdg = path.join(profile, 'cache');
  return { platform: 'linux', env: { USERPROFILE: profile, HOME: profile, XDG_CACHE_HOME: xdg }, profile,
    installDir: path.join(profile, 'opt', 'starnet'), root: path.join(xdg, 'starnet', 'models'), legacy: null };
}

// Every row asserts in the layout it names; a throw is a failed row, so the file always reaches its report.
let rows = 0;
async function row(name, kind, body) {
  const at = layout(kind, 'row-' + (++rows));
  fs.mkdirSync(at.profile, { recursive: true });
  Object.defineProperty(process, 'platform', { ...SAVED_PLATFORM, value: at.platform });
  for (const key of LIFECYCLE_ENV) delete process.env[key];
  Object.assign(process.env, at.env);
  engine.length = 0;
  try { await body(at, m => `${name} [${kind}]: ${m}`); }
  catch (error) { A.ok(false, `${name} [${kind}] threw: ${error && error.stack || error}`); }
  finally {
    Object.defineProperty(process, 'platform', SAVED_PLATFORM);
    for (const key of LIFECYCLE_ENV) {
      if (key in SAVED_ENV) process.env[key] = SAVED_ENV[key]; else delete process.env[key];
    }
  }
}

/* Watches the one call a locked file or another volume refuses, and lists every attempt. It renames for real, or throws
   `refuse` instead. With `lostRace` the folder really moves and then the call throws, as if another sidecar got there
   first. */
function watchRename({ refuse, lostRace } = {}) {
  const real = { sync: fs.renameSync, promised: fs.promises.rename };
  const calls = [];
  const stand = (from, to) => {
    calls.push([from, to]);
    if (!refuse || lostRace) real.sync(from, to);
    if (refuse) throw Object.assign(new Error(`${refuse}: rename refused`), { code: refuse });
  };
  fs.renameSync = stand;
  fs.promises.rename = async (from, to) => stand(from, to);
  return { calls, restore() { fs.renameSync = real.sync; fs.promises.rename = real.promised; } };
}

const DOORS = [
  ['warm', voice => voice.warm()],
  ['transcribe', voice => voice.transcribe(SPEECH)],
  ['synthesize', voice => voice.synthesize('Hello there.')]
];

(async () => {
  fs.mkdirSync(path.dirname(MODULE), { recursive: true });
  fs.copyFileSync(path.join(REPO, sidecarFileContaining('kokoroOnnxDir')), MODULE);
  // Synthesis uses the shared production splitter; keep that dependency in the isolated engine fixture too.
  fs.copyFileSync(path.join(REPO, 'sidecar', 'speech-split.js'), path.join(path.dirname(MODULE), 'speech-split.js'));
  installFakeEngines();
  // Node's own lazily loaded internals read process.platform once, so they load here on the real one, before a row fakes it.
  for (const pkg of ['@huggingface/transformers/index.mjs', 'kokoro-js/dist/index.mjs']) {
    await import(pathToFileURL(path.join(SCRATCH, 'node_modules', pkg)).href);
  }

  // The one rule, against the file Rust reads too.
  {
    const { voiceCacheRoots } = freshVoice();
    A.eq(typeof voiceCacheRoots, 'function', 'local-voice exports the pure root resolver');
    if (typeof voiceCacheRoots === 'function') {
      for (const c of FIXTURE.cases) {
        const home = c.env.USERPROFILE || c.env.HOME;
        A.eq(voiceCacheRoots({ platform: c.node, env: c.env, homedir: () => home, join: path.posix.join }),
          { root: c.root, legacy: c.legacy }, c.name);
      }
      A.eq(voiceCacheRoots({ platform: 'win32', env: { STARNET_MODEL_CACHE: 'D:/voice', LOCALAPPDATA: 'C:/a' }, homedir: () => 'C:/a', join: path.posix.join }),
        { root: 'D:/voice', legacy: null }, 'STARNET_MODEL_CACHE wins, and a chosen cache has no legacy root to move');
      A.eq(voiceCacheRoots({ platform: 'win32', env: { LOCALAPPDATA: 'C:/a', STARNET_MODEL_CACHE: 'D:/voice' }, homedir: () => { throw new Error('no home'); }, join: path.posix.join }).root,
        'D:/voice', 'the resolver only asks for a home folder it needs');
    }
  }

  for (const kind of ['windows', 'macos']) {
    await row('a fresh install', kind, async (at, say) => {
      const voice = freshVoice();
      A.eq(voice.status().cacheRoot, at.root, say('the cache resolves to the new root'));
      A.ok(!inside(voice.status().cacheRoot, at.installDir), say('never inside the install folder'));
      A.eq(voice.ttsCached(), false, say('an empty profile holds no model'));
      await voice.warm();
      A.eq(engine.map(load => load.family).sort(), ['asr', 'tts'], say('both engines loaded'));
      A.ok(servedFrom('asr', at.root) && servedFrom('tts', at.root), say('the first download lands in the new root'));
      A.ok(fs.existsSync(kokoroFile(at.root)) && fs.existsSync(whisperFile(at.root, WHISPER_FILES[0])), say('the files are there'));
      A.ok(!fs.existsSync(at.installDir), say('and nothing is created in the old folder'));
      A.eq(voice.ttsCached(), true, say('the model now counts as cached'));
      A.eq(voice.status().cacheRoot, at.root, say('and the status still names the new root'));
    });

    for (const [door, load] of DOORS) {
      await row(`a legacy cache, first load through ${door}`, kind, async (at, say) => {
        seedBoth(at.legacy);
        write(path.join(at.legacy, 'transformers', 'nested', 'keep.txt'), 'every file travels');
        const voice = freshVoice();
        A.eq(voice.ttsCached(), true, say('a legacy cache counts before anything moves'));
        voice.status();
        A.ok(fs.existsSync(at.legacy) && !fs.existsSync(at.root), say('status and ttsCached never move anything'));
        const rename = watchRename();
        try { await load(voice); } finally { rename.restore(); }
        A.eq(rename.calls.length, 1, say('one rename'));
        A.ok(!fs.existsSync(at.legacy), say('the legacy root is gone'));
        A.eq(fs.existsSync(kokoroFile(at.root)) && fs.readFileSync(kokoroFile(at.root), 'utf8'), 'kokoro weights', say('the weights moved'));
        A.eq(fs.existsSync(path.join(at.root, 'transformers', 'nested', 'keep.txt')), true, say('with everything else in the folder'));
        A.eq(fetches(), [], say('no remote fetch'));
        A.ok(engine.length > 0 && engine.every(loaded => inside(loaded.cacheDir, at.root)), say('the engine read the new root'));
        A.eq(voice.ttsCached(), true, say('kokoroCached stays true'));
        A.eq(voice.status().cacheRoot, at.root, say('the status follows the move'));
      });
    }
  }

  for (const code of ['EBUSY', 'EPERM', 'EXDEV']) {
    await row(`the move refused with ${code}`, 'windows', async (at, say) => {
      seedBoth(at.legacy);
      const voice = freshVoice();
      const rename = watchRename({ refuse: code });
      try {
        await voice.warm();
        await voice.synthesize('Still here.');
        await voice.transcribe(SPEECH);
      } finally { rename.restore(); }
      A.eq(rename.calls.length, 1, say('one try per process'));
      A.ok(fs.existsSync(kokoroFile(at.legacy)), say('the legacy root stays where it is'));
      A.ok(!fs.existsSync(at.root), say('and no empty new root appears, or the next process could never move it'));
      A.eq(fetches(), [], say('nothing is downloaded'));
      A.ok(servedFrom('asr', at.legacy) && servedFrom('tts', at.legacy), say('the legacy root is reused in place'));
      A.eq(voice.ttsCached(), true, say('kokoroCached stays true'));
      A.eq(voice.status().cacheRoot, at.legacy, say('the status names where the model really is'));
      A.eq(voice.status().cacheMoveError, code, say('and why it stayed there'));

      engine.length = 0;
      const next = freshVoice();
      A.eq(next.status().cacheMoveError, '', say('the next process starts clean'));
      await next.warm();
      A.ok(!fs.existsSync(at.legacy) && fs.existsSync(kokoroFile(at.root)), say('the next process retries and moves it'));
      A.eq(fetches(), [], say('still no download'));
    });
  }

  await row('both roots complete', 'windows', async (at, say) => {
    seedBoth(at.root, 'new weights');
    seedBoth(at.legacy, 'old weights');
    const voice = freshVoice();
    const rename = watchRename();
    try { await voice.warm(); } finally { rename.restore(); }
    A.ok(servedFrom('asr', at.root) && servedFrom('tts', at.root), say('the new root wins'));
    A.eq(rename.calls, [], say('nothing is renamed'));
    A.eq(fs.readFileSync(kokoroFile(at.legacy), 'utf8'), 'old weights', say('the legacy root is left alone'));
    A.eq(fetches(), [], say('nothing is downloaded'));
    A.eq(voice.status().cacheRoot, at.root, say('the status names the new root'));
  });

  await row('an empty new root beside a complete legacy root', 'windows', async (at, say) => {
    fs.mkdirSync(at.root, { recursive: true });
    seedBoth(at.legacy);
    const voice = freshVoice();
    A.eq(voice.ttsCached(), true, say('the complete root counts'));
    A.eq(voice.status().cacheRoot, at.legacy, say('the status names it'));
    const rename = watchRename();
    try { await voice.warm(); } finally { rename.restore(); }
    A.ok(servedFrom('asr', at.legacy) && servedFrom('tts', at.legacy), say('the complete root is used'));
    A.eq(rename.calls, [], say('nothing is renamed over an existing target'));
    A.eq(fetches(), [], say('nothing is downloaded'));
    A.eq(fs.readdirSync(at.root), [], say('and the new root is left as it was'));
  });

  for (const [held, seedNew, seedLegacy] of [
    ['the new root holds Kokoro, the legacy root Whisper', seedTts, seedAsr],
    ['the new root holds Whisper, the legacy root Kokoro', seedAsr, seedTts]
  ]) {
    await row(held, 'macos', async (at, say) => {
      seedNew(at.root);
      seedLegacy(at.legacy);
      const voice = freshVoice();
      A.eq(voice.ttsCached(), true, say('Kokoro counts wherever it is'));
      const rename = watchRename();
      try { await voice.warm(); } finally { rename.restore(); }
      A.eq(fetches(), [], say('nothing is downloaded while either root holds the model'));
      A.ok(servedFrom('tts', seedNew === seedTts ? at.root : at.legacy), say('Kokoro loads from the root that holds it'));
      A.ok(servedFrom('asr', seedNew === seedAsr ? at.root : at.legacy), say('Whisper loads from the root that holds it'));
      A.eq(rename.calls, [], say('nothing is renamed'));
    });
  }

  await row('both roots present and neither complete', 'windows', async (at, say) => {
    fs.mkdirSync(at.root, { recursive: true });
    write(path.join(at.legacy, 'transformers', 'partial.tmp'), 'a torn download');
    const voice = freshVoice();
    await voice.warm();
    A.ok(servedFrom('asr', at.root) && servedFrom('tts', at.root), say('a new download lands in the new root'));
    A.ok(fs.existsSync(path.join(at.legacy, 'transformers', 'partial.tmp')), say('the legacy root is left alone'));
  });

  await row('STARNET_MODEL_CACHE', 'windows', async (at, say) => {
    const chosen = path.join(at.profile, 'chosen');
    process.env.STARNET_MODEL_CACHE = chosen;
    seedBoth(at.legacy);
    const voice = freshVoice();
    A.eq(voice.status().cacheRoot, chosen, say('still wins'));
    const rename = watchRename();
    try { await voice.warm(); } finally { rename.restore(); }
    A.ok(servedFrom('asr', chosen) && servedFrom('tts', chosen), say('and the engines use it'));
    A.eq(rename.calls, [], say('a chosen cache never pulls the legacy root in'));
    A.ok(fs.existsSync(kokoroFile(at.legacy)) && !fs.existsSync(at.root), say('and neither default root is touched'));
  });

  await row('two sidecars race', 'windows', async (at, say) => {
    seedBoth(at.legacy);
    const voice = freshVoice();
    const rename = watchRename({ refuse: 'ENOENT', lostRace: true });
    try { await voice.warm(); } finally { rename.restore(); }
    A.eq(rename.calls.length, 1, say('the loser tried once'));
    A.ok(servedFrom('asr', at.root) && servedFrom('tts', at.root), say('the loser re-resolves to the moved root'));
    A.eq(fetches(), [], say('and downloads nothing'));
    A.eq(voice.status().cacheMoveError, '', say('a lost race is not a failure'));
  });

  await row('a linked legacy root', 'windows', async (at, say) => {
    const elsewhere = path.join(at.profile, 'big-disk', 'models');
    seedBoth(elsewhere);
    fs.mkdirSync(path.dirname(at.legacy), { recursive: true });
    fs.symlinkSync(elsewhere, at.legacy, 'junction');
    const voice = freshVoice();
    const rename = watchRename();
    try { await voice.warm(); } finally { rename.restore(); }
    A.eq(rename.calls, [], say('a link is not moved: a relative one would stop pointing at its target'));
    A.ok(fs.lstatSync(at.legacy).isSymbolicLink(), say('the link stays'));
    A.ok(servedFrom('asr', at.legacy) && servedFrom('tts', at.legacy), say('and is reused in place'));
    A.eq(fetches(), [], say('nothing is downloaded'));
  });

  await row('Linux has nothing to move', 'linux', async (at, say) => {
    const voice = freshVoice();
    A.eq(voice.status().cacheRoot, at.root, say('the cache folder is unchanged'));
    const rename = watchRename();
    try { await voice.warm(); } finally { rename.restore(); }
    A.ok(servedFrom('asr', at.root) && servedFrom('tts', at.root), say('and is used'));
    A.eq(rename.calls, [], say('nothing is renamed'));
  });

  /* The one wire the crate cannot compile: ERASE's targets come from the tested function, and the hand-copied mirror of
     the sidecar's rule is gone. The docs name the new place and the old one, because a manual wipe follows them. */
  {
    const main = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'main.rs'), 'utf8');
    const erase = fs.readFileSync(path.join(REPO, 'src-tauri', 'src', 'erase_all.rs'), 'utf8');
    const privacy = fs.readFileSync(path.join(REPO, 'PRIVACY.md'), 'utf8');
    const trouble = fs.readFileSync(path.join(REPO, 'website', 'docs', 'troubleshooting.html'), 'utf8');
    A.ok(/erase_all::voice_model_cache_roots\(std::env::consts::OS,/.test(main), 'ERASE takes both roots from erase_all.rs');
    A.ok(!/fn local_voice_model_cache/.test(main), 'main.rs keeps no hand-copied mirror of the rule');
    A.ok(/pub fn voice_model_cache_roots/.test(erase), 'erase_all.rs holds the rule the crate tests');
    for (const [doc, text] of [['PRIVACY.md', privacy], ['troubleshooting', trouble]]) {
      A.ok(text.includes('%LOCALAPPDATA%\\ai.skynet.harness\\'), doc + ' names the new Windows location');
      A.ok(text.includes('%LOCALAPPDATA%\\StarNet\\models\\'), doc + ' names the old Windows location');
      A.ok(text.includes('~/Library/Application Support/StarNet/models/'), doc + ' names the old macOS location');
    }
    A.ok(/voice-model download: <code>%LOCALAPPDATA%\\ai\.skynet\.harness\\<\/code>/i.test(trouble), 'the guide puts the Windows download in the new location');
    A.ok(/voice-model download: <code>~\/Library\/Application Support\/ai\.skynet\.harness\/<\/code>/i.test(trouble), 'the guide puts the macOS download in the new location');
    A.ok(!/voice-model download: <code>%LOCALAPPDATA%\\StarNet\\<\/code>/i.test(trouble), 'and no longer in the install folder');
  }
})().catch(error => {
  A.ok(false, 'the test itself failed: ' + (error && error.stack || error));
}).finally(() => {
  Object.defineProperty(process, 'platform', SAVED_PLATFORM);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  A.report('local-voice-cache-root.test');
});
