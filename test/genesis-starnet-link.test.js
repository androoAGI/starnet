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
ok(/data-prov="starnet"[\s\S]{0,200}EASIEST START/.test(index), 'the STARNET hero wears the promoted-start badge');
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
ok(/Harness\.api\.get\('\/api\/credits\?history=0'\)/.test(app), 'the reveal uses the bounded summary endpoint and cannot be stalled by history');
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
ok(/_starnetLinkPollBusy/.test(app) && /generation !== _starnetLinkGeneration/.test(app),
  'slow link polling is single-flight and an old consumed response cannot overwrite a successful relink');
ok(/seq !== _starnetStatusSeq[\s\S]{0,180}answered: false/.test(app),
  'an out-of-order creator balance response becomes unknown instead of repainting a stale zero');
ok(/snap\.authStatus === 'invalid'[\s\S]{0,400}link_token_rejected/.test(host),
  'a newly confirmed token rejected by balance authority is never reported or adopted as linked');
ok(/refreshCreditsProvider\(\)[\s\S]{0,220}\/api\/credits\?history=0/.test(stationui),
  'the provider card reads the bounded summary path rather than waiting on credit history');
ok(/_creditsLinkPollBusy/.test(stationui) && /generation !== _creditsLinkGeneration/.test(stationui),
  'the STORE pairing flow is also single-flight and ignores stale link responses');
ok(/managed credit\|Managed credits/.test(app), 'a billing refusal from the wire preflight is named as billing, not as "model didn’t answer"');
// the preflight reads Harness.chat's refusal string — otherwise every up-front refusal collapses to
// "the provider returned an error" and the real reason never reaches the screen.
ok(/typeof res\.error === 'string' && res\.error\.trim\(\)\) \? res\.error/.test(app), 'preflightWire surfaces res.error (the refusal reason), not only res.text');
ok(/stopStarnetBalancePoll\(\)/.test(app), 'the empty-wallet balance poll has a stop, wired on screen exit');

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
