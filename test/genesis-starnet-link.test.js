'use strict';
// genesis-starnet-link.test.js — source guard for the STARNET MANAGED path on the first-run connect screen.
// The subscription flow must be reachable at genesis (buy on the site → link in one confirmed code — no API
// key anywhere), and it must stay HONEST: the chip is hidden until the sidecar reports a real cloud seam,
// and WAKE refuses an unlinked pick instead of admitting a run the credits gate would bounce.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const index = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const stationui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const link = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'credits-link.js'), 'utf8');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

// STARNET is THE HERO (the promoted easiest start) and ships HIDDEN — only the live probe reveals it.
ok(/class="prov prov-hero hidden" data-prov="starnet"/.test(index), 'the STARNET hero ships hidden (honesty: no cloud, no offer)');
ok(/data-prov="starnet"[\s\S]{0,600}Subscribe and start\. No API keys\./.test(index), 'the STARNET hero clearly explains the simple subscription path');
// ChatGPT/Codex has no chip of its own anymore — its sign-in lives inside the OPENAI card.
ok(!/data-prov="codex"/.test(index), 'no standalone codex chip — ChatGPT sign-in lives inside the OPENAI selection');
ok(/pickedProvider === 'codex'\) pickedProvider = 'openai'/.test(app), 'a returning codex agent lands on the OPENAI card');
ok(/codexConnected\) \{[\s\S]{0,400}setProv\('codex'\)/.test(app) || /codexConnected[\s\S]{0,300}setProv\('codex'\)/.test(app),
  'WAKE on the OPENAI card rides the codex path when the ChatGPT sign-in is live and no key was typed');
// The revealed hero becomes the default pick on a fresh create — never over a real user click.
ok(/autoPick && \(linked \|\| linkable\) && !userPickedProvider/.test(app), 'the hero auto-pick yields to any real user pick');
ok(/id="starnet-block"/.test(index), 'the genesis link block exists');
ok(/id="btn-starnet-link"/.test(index) && /id="starnet-code"/.test(index) && /id="btn-starnet-open"/.test(index),
  'the link block carries its button, code display, and open-page control');

// The reveal is keyed on the sidecar seam, not hardcoded on.
ok(/async function revealStarnetGenesis\(/.test(app), 'genesis probes the cloud seam before offering the chip');
ok(/\/api\/credits\/linkable/.test(app), 'the reveal asks /api/credits/linkable (the STORE reads the same pair)');
// (2026-10-08) it may pass its own wait (api.get's 15s default lost to a ~16s link self-heal) — RUN in credits-status-wait.test.js
ok(/async function revealStarnetGenesis\([\s\S]{0,400}?Harness\.api\.get\('\/api\/credits\?history=0'(?:, \{ timeoutMs: \d+ \})?\)/.test(app), 'the reveal uses the bounded summary endpoint and cannot be stalled by history');
ok(/revealStarnetGenesis\(!recovery\)/.test(app), 'the connect screen actually runs the reveal (auto-pick only on a fresh create)');

// The pairing flow rides the SAME sidecar engine as the STORE — one implementation.
ok(/\/api\/credits\/link\/start/.test(app) && /\/api\/credits\/link\/poll/.test(app),
  'genesis linking uses the sidecar pairing routes (the STORE engine, not a second copy)');
ok(/harness_adopt_credits_token/.test(app), 'a fresh link hands the token to the OS keychain immediately');
ok(/refreshCreditsConfigured/.test(app), "a fresh link teaches Harness so configured('starnet') answers without a restart");

// WAKE is gated: an unlinked STARNET pick is refused with the remedy named, before any agent exists.
ok(/pickedProvider === 'starnet'[\s\S]{0,1800}!creditState\.linked[\s\S]{0,240}link your StarNet account first/i.test(app),
  'WAKE refuses an unlinked STARNET pick and names the one-button remedy');

// Leaving the screen (or switching provider) drops the in-flight pairing poll — no orphan pollers.
ok(/stopStarnetLinkPoll\(\)/.test(app), 'the pairing poll has a stop, wired on screen exit and provider switch');

// EMPTY WALLET IS SAID HERE (2026-08-22: a first-timer signed in without buying credits; WAKE's real call was
// refused by managed admission and the screen said "your model didn't answer", so they kept switching models).
ok(/id="btn-starnet-credits"/.test(index), 'the STARNET block offers ADD CREDITS');
ok(/id="btn-starnet-switch"/.test(index) && /USE A DIFFERENT ACCOUNT/.test(index),
  'the genesis screen lets a paid beginner escape an automatically linked wrong account');
ok(/async function switchStarnetAccount\(\)[\s\S]{0,1400}harness_clear_credits_token[\s\S]{0,800}\/api\/credits\/unlink[\s\S]{0,800}startStarnetLink\(\)/.test(app),
  'switch account clears keychain + sidecar link and immediately starts the normal pairing flow');
ok(/function starnetOutOfCredit\(\)/.test(app), 'a linked-but-empty wallet is a named state');
ok(/no credits yet/.test(app) && /btn-starnet-credits/.test(app), 'the status line names the empty wallet and the button opens the store');
const wakeCreditsStart = app.indexOf("msg.textContent = 'checking your StarNet credits…'");
const wakeCreditsRefresh = app.indexOf('const creditState = await refreshStarnetGenesisStatus();', wakeCreditsStart);
const wakeCreditsZero = app.indexOf('if (!(creditState.balanceUsd > 0))', wakeCreditsRefresh);
ok(wakeCreditsStart >= 0 && wakeCreditsRefresh > wakeCreditsStart && wakeCreditsZero > wakeCreditsRefresh,
  'WAKE awaits a fresh authoritative balance before it may classify the active linked account as empty');
ok(/!creditState\.answered[\s\S]{0,260}credits are safe/.test(app) && /creditState\.balanceUsd == null/.test(app),
  'an unavailable/unknown balance is never converted into a false no-credits denial');
ok(/http 404\\b[\s\S]{0,160}configured: false[\s\S]{0,80}answered = true/.test(app),
  'a definitive unlinked 404 still gives the user the LINK ACCOUNT remedy instead of claiming a balance outage');
ok(/linkedAccount !== String\(r\.accountId/.test(host) && /link_account_mismatch/.test(host),
  'link confirmation refuses any account-ID mismatch between the newly confirmed token and the active credits adapter');
ok(/balanceUsd:\s*balanceVerified \? balanceUsd : null/.test(host),
  'link confirmation returns the freshly verified balance for the newly active account, never an inherited cached value');
ok(!/credits\.refresh\(CREDITS_ACCOUNT\)/.test(host) && !/credits\.history\(CREDITS_ACCOUNT/.test(host),
  'the host cannot override the active adapter account with a stale global account id');
ok(/fileToken \|\| sessionToken \|\| envToken/.test(link),
  'after relink adoption, the fresh in-process token outranks the stale launch-time keychain token');
ok(/typeof j\.balanceUsd === 'number'/.test(app) && /typeof p\.balanceUsd === 'number'/.test(app),
  'creator and link responses accept only numeric balances — malformed strings never become $0');
ok(/\/api\/credits\?history=0/.test(app) && /credits status timeout/.test(app),
  'WAKE uses a bounded balance-only status request and cannot be stranded behind activity history');
// The WAKE wait must outlast the sidecar's own worst case (heal whoami 8s + one balance read 8s), or a healing
// read answers after WAKE already said "couldn't confirm your credit balance" (link-down F6, 2026-10-07).
{
  const m = /new Error\('credits status timeout'\)\),\s*(\d+)\)/.exec(app);
  ok(m && Number(m[1]) >= 16000, 'the WAKE credits status wait outlasts the sidecar heal + balance budget (16s)');
}
ok(/if \(!\(heal && heal\.healed\)\) await adapter\.refresh\(\)/.test(host) && /rebuildCredits\(\)\.then\(\(\) => \(\{ healed: true \}\)\)/.test(host),
  'a credits read that just healed the link reuses the heal\'s balance read instead of chaining a second one');
ok(/_starnetLinkPollBusy/.test(app) && /generation !== _starnetLinkGeneration/.test(app),
  'slow link polling is single-flight and an old consumed response cannot overwrite a successful relink');
ok(/seq !== _starnetStatusSeq[\s\S]{0,180}answered: false/.test(app),
  'an out-of-order creator balance response becomes unknown instead of repainting a stale zero');
ok(/snap\.authStatus === 'invalid'[\s\S]{0,400}link_token_rejected/.test(host),
  'a newly confirmed token rejected by balance authority is never reported or adopted as linked');
ok(/refreshCreditsProvider\(\)[\s\S]{0,220}\/api\/credits\?history=0/.test(stationui),
  'the provider card reads the bounded summary path rather than waiting on credit history');
ok(/function publishCreditsConfigured\(configured\)[\s\S]{0,300}setDesktopConfigured\('starnet',\s*!!configured\)[\s\S]{0,200}ModelDock\.reflect/.test(stationui),
  'Settings publishes a definitive managed-link answer to the same cache and model dock COMMS reads');
ok(/if \(j && j\.configured\) \{[\s\S]{0,100}publishCreditsConfigured\(true\)/.test(stationui)
  && /if \(!\(j && j\.unavailable\)\) publishCreditsConfigured\(false\)/.test(stationui),
  'linked and definitive-unlinked answers converge the COMMS cache while temporary outages preserve it');
ok((stationui.match(/\.then\(\(\) => refreshCreditsProvider\(\)\)\s*\.then\(\(\) => \{ (?:_creditsUnlinkPending = false; )?scheduleSettingsRepaint\(\); wireCredits\(body\); \}\)/g) || []).length === 2,
  'link and unlink repaint the provider card after the Store and COMMS truth converges');
ok(/_creditsLinkPollBusy/.test(stationui) && /generation !== _creditsLinkGeneration/.test(stationui),
  'the STORE pairing flow is also single-flight and ignores stale link responses');
ok(/managed credit\|Managed credits/.test(app), 'a billing refusal from the wire preflight is named as billing, not as "model didn’t answer"');
// the preflight reads Harness.chat's refusal string — otherwise every up-front refusal collapses to
// "the provider returned an error" and the real reason never reaches the screen.
ok(/typeof res\.error === 'string' && res\.error\.trim\(\)\) \? res\.error/.test(app), 'preflightWire surfaces res.error (the refusal reason), not only res.text');
ok(/stopStarnetBalancePoll\(\)/.test(app), 'the empty-wallet balance poll has a stop, wired on screen exit');

// (2026-10-07) the WAKE billing ladder RUNS against the sidecar's real refusal strings: a refused link says relink
// (never "try WAKE again" — a retry can't fix it), an unanswered check says retry, only a reported $0 says ADD CREDITS.
{
  const start = app.indexOf('if (/managed credit|Managed credits/i.test(wire.why)) {');
  const end = app.indexOf("msg.textContent = 'your model didn’t answer'", start);
  ok(start > 0 && end > start, 'the WAKE billing ladder is found in app.js');
  const ladder = new Function('wire', 'msg', 'pickedProvider', 'refreshStarnetGenesisStatus', app.slice(start, end) + '\nreturn true;');
  // the sidecar's admission refusals, exactly as runOnceCore emits them: refuseManaged builds every one from the pure
  // budgetcaps.managedRefusalMessage (the strings moved there with audit B11's held refusal)
  ok(/budgetCaps\.managedRefusalMessage\(\{ exhausted, linkRefused, held: [^\n]*\}\)/.test(host), 'refuseManaged builds its refusal from budgetcaps.managedRefusalMessage');
  const refusalOf = require(path.join(__dirname, '..', 'sidecar', 'budgetcaps.js')).managedRefusalMessage;
  const refusedLink = refusalOf({ linkRefused: true }).message;
  const unanswered = refusalOf({}).message;
  const outOf = refusalOf({ exhausted: true }).message;
  const held = refusalOf({ exhausted: true, balanceUsd: 0, held: { runs: 1, usd: 4, counted: true } }).message;
  ok(/refused this station's link/.test(refusedLink) && /did not answer/.test(unanswered) && /^Out of managed credit/.test(outOf) && /^Managed credits are held/.test(held),
    'the sidecar still emits the refused-link, unanswered, out-of-credit and held refusals');
  // preflightWire collapses whitespace and keeps 160 chars: the WAKE screen only ever sees that much
  const wake = (why, prov) => {
    const msg = { textContent: '' }; let refreshed = 0;
    const r = ladder({ why: why.replace(/\s+/g, ' ').slice(0, 160) }, msg, prov, () => { refreshed++; });
    return { r, text: msg.textContent, refreshed };
  };
  for (const prov of ['starnet', 'openai']) {
    const w = wake(refusedLink, prov);
    ok(w.r === false && w.refreshed === 1, 'a refused link bounces WAKE and repaints the link state (' + prov + ')');
    ok(/no longer accepts this station’s link/.test(w.text) && /credits are safe/.test(w.text), 'a refused link names the refused link (' + prov + ')');
    ok(!/try WAKE again in a moment|couldn’t read your credit balance|no credits|ADD CREDITS/.test(w.text), 'a refused link is never "retry" or "out of credits" (' + prov + ')');
  }
  ok(/CONNECT STARNET ACCOUNT/.test(wake(refusedLink, 'starnet').text) && /id="btn-starnet-link" class="btn">CONNECT STARNET ACCOUNT/.test(index),
    'on the STARNET pick the relink copy names the button that is actually on screen');
  ok(!/CONNECT STARNET ACCOUNT/.test(wake(refusedLink, 'openai').text), 'another provider pick is never pointed at a STARNET button it is not showing');
  ok(/couldn’t read your credit balance/.test(wake(unanswered, 'starnet').text), 'an unanswered balance check still says the balance could not be read');
  ok(/no credits/.test(wake(outOf, 'starnet').text), 'only a reported empty wallet says ADD CREDITS');
  // a balance HELD by this station's own running StarNet runs (audit B11) is neither empty nor unreadable
  for (const prov of ['starnet', 'openai']) {
    const w = wake(held, prov);
    ok(w.r === false && w.refreshed === 1, 'a held balance bounces WAKE and repaints the balance (' + prov + ')');
    ok(/held by runs still working/.test(w.text) && /wait for them to finish/i.test(w.text), 'a held balance says it is held and to wait (' + prov + '): ' + w.text);
    ok(!/couldn’t read your credit balance|has no credits/.test(w.text), 'a held balance is never "could not read" or "no credits" (' + prov + ')');
  }
  ok(/＄ ADD CREDITS above/.test(wake(held, 'starnet').text) && !/＄ ADD CREDITS/.test(wake(held, 'openai').text),
    'only the STARNET pick (which shows the ＄ ADD CREDITS button) is pointed at it; another pick is offered its own key');
  ok(wake('rate limited', 'starnet').r === true, 'a non-billing failure falls through to the model-did-not-answer line');
  ok(!/LINK YOUR STARNET ACCOUNT/.test(app), 'WAKE never names a LINK YOUR STARNET ACCOUNT button (the button reads CONNECT STARNET ACCOUNT)');
}

// REMOTE UNLINK (0.10.8 field regression): local keychain/file presence is not proof after the account page
// revoked the device. The sidecar must project the cloud's 401/403 as configured:false, both first-run and
// Settings must offer pairing again, and neither surface may turn the stale cached $0 into "no credits".
ok(/snap\.authStatus === 'invalid'[\s\S]{0,300}configured:\s*false[\s\S]{0,200}reason:\s*'link_revoked'/.test(host),
  'a cloud-rejected linked device is reported as unconfigured with an explicit revoked reason');
ok(/const revoked = !CREDITS_URL[\s\S]{0,240}snap\.authStatus === 'invalid'/.test(host) &&
   /available = creditsLink\.configured\(\) && \(!credits\.configured\(\) \|\| revoked\)/.test(host),
  'remote revocation re-opens the normal LINK STATION flow without a manual local unlink');
ok(/previous link was removed from your account/.test(app),
  'genesis names the removed link and tells the Commander to reconnect credits');
ok(/lk\.reason === 'link_revoked'[\s\S]{0,220}previous link was removed from your account/.test(stationui),
  'Settings renders the same relink recovery from backend truth');
ok(/LINK SAVED · SERVICE UNAVAILABLE/.test(stationui) && /link saved on this station, but StarNet could not verify it/.test(app),
  'temporary cloud failure is presented separately and never overclaimed as LINKED');

console.log('genesis-starnet-link.test.js OK -', n, 'assertions');
