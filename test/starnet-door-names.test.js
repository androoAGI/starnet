/* test/starnet-door-names.test.js — every StarNet-credit message names a door that EXISTS.
   The SETTINGS console has no "PROVIDERS" section any more: the StarNet card, the STORE (+ ADD CREDITS) and
   the relink live on the AI & MODELS page (stationui.js section id 'providers', label 'AI & MODELS'). A prop
   refusal or a credential error that says "SETTINGS → PROVIDERS" sends the user hunting for a tab that is not
   there (spend-truth lane B5, 2026-10-08). The cloud is a fake fetch; nothing leaves the process. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeUserProps } = require('../sidecar/userprops.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// the door the messages must name really exists: the AI & MODELS section is the providers pane
const station = read('frontend/app/stationui.js');
A.ok(/\{ id: 'providers', label: 'AI & MODELS'/.test(station), 'SETTINGS has an AI & MODELS section (the providers pane)');
/* the STORE is a string node OF the secProviders template (that whole const statement, up to the next declaration),
   and that template is what the AI & MODELS section builds: the structure, not a byte window, so a longer comment or
   another block inside the pane (the org P05 API KEYS service-key lines) never reads as "the STORE moved out". */
const provAt = station.indexOf('const secProviders =');
const provNext = /\n[ \t]*const [A-Za-z_$][\w$]* =/g;
provNext.lastIndex = provAt + 1;
const provEndM = provAt >= 0 ? provNext.exec(station) : null;
const secProvidersTpl = provEndM ? station.slice(provAt, provEndM.index) : '';
A.ok(secProvidersTpl.length > 0, 'the secProviders template is found as one const statement');
A.ok(/id="credits-buy">＋ ADD CREDITS/.test(station) && secProvidersTpl.includes(`'<div id="credits-store"></div>'`) &&
  /\{ id: 'providers', label: 'AI & MODELS'[^\n]*build: frag\(secProviders\b/.test(station),
  'the STORE (+ ADD CREDITS) renders inside that same AI & MODELS pane');
A.ok(!/label: 'PROVIDERS'/.test(station), 'no SETTINGS section is labelled PROVIDERS');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'door-names-'));
  try {
    const make = (cfg, status) => makeUserProps({
      fs, path, dir: path.join(dir, '.userprops'), cloud: () => cfg,
      fetch: async () => ({ status, ok: false, json: async () => ({ error: { message: '', code: '' } }) }),
      now: () => 1000, setTimer: () => 0, clearTimer: () => {}
    });
    const msgs = [];
    // unlinked: refused before any network call, for both the paid start and the preview
    const unlinked = make({ url: '', token: '' }, 500);
    msgs.push(['unlinked start', (await unlinked.start('a lamp')).message]);
    msgs.push(['unlinked preview', (await unlinked.startPreview('a lamp')).message]);
    // the cloud's refusals: out of credit (402), link refused (401/403) — start and preview
    for (const status of [402, 401, 403]) {
      const up = make({ url: 'https://cloud.test', token: 'snd_tok' }, status);
      msgs.push(['start ' + status, (await up.start('a lamp ' + status)).message]);
      msgs.push(['preview ' + status, (await up.startPreview('a lamp ' + status)).message]);
    }
    for (const [what, m] of msgs) {
      A.ok(typeof m === 'string' && m.length > 0, what + ': refusal carries a message');
      A.ok(!/PROVIDERS/.test(m), what + ': never names the missing PROVIDERS tab: ' + m);
      A.ok(/SETTINGS → AI & MODELS/.test(m), what + ': names SETTINGS → AI & MODELS: ' + m);
    }
    // the source keeps no stale door either (a code path this harness did not reach)
    A.ok(!/SETTINGS \\u2192 PROVIDERS|SETTINGS → PROVIDERS/.test(read('sidecar/userprops.js')), 'userprops.js names no SETTINGS → PROVIDERS door anywhere');
    // the starnet credential error (index.js providerCredentialError) points at the real page
    const idx = readSidecarSource();
    A.ok(/if \(id === 'starnet'\) return 'link this station to a StarNet account \(SETTINGS -> AI & MODELS -> STARNET MANAGED\) to run on credits';/.test(idx),
      'a StarNet credential error names SETTINGS -> AI & MODELS -> STARNET MANAGED');
    A.ok(!/SETTINGS -> PROVIDERS -> STARNET MANAGED/.test(idx), 'the old PROVIDERS door is gone from index.js');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  A.report('starnet-door-names');
})().catch(e => { console.error(e); process.exit(1); });
