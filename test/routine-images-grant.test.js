/* node test/routine-images-grant.test.js — the per-routine unattended IMAGES grant ('studio').

   Issue (2026-10-18): "every morning at 8, make me a sunrise picture and send it on Telegram" fired, but in the
   default ASK posture image_generate (studio:write, requiresConsent) was refused by the consent broker — nobody is
   there to say yes — and the run then told the Commander to "pre-authorize image generation on this routine", a
   setting that did not exist. Andrew approved (10-18) a grant shaped like the terminal / connected-tools ones: a tick
   in the create form AND an ALLOW IMAGES key on an existing routine's row (a routine the agent made from a chat has
   no grant and no other place to get one).

   Locks, as pure units and as wiring: the broker tier is narrow (autonomous, studio only, never execute, predicate
   must say yes); the whitelist and store carry 'studio'; an agent rewriting the task drops it; the run predicate is
   host-sourced, lifted by taint, and never covers a delegated worker; a line hop is handed no grant; the refusal
   names the real switch; the row grant adds to the CURRENT grants under the lock; the panel shows and sends it. */
'use strict';
const { readSidecarSource } = require('./helpers/source');

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeConsentBroker, SILENCE } = require('../sidecar/permissions.js');
const { normalizeUnattendedGrants, makeRunAuthority, GRANTABLE_UNATTENDED } = require('../sidecar/inputpolicy.js');
const cronStore = require('../sidecar/cron-store.js');
const taint = require('../sidecar/taint.js');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const IMAGE = { name: 'image_generate', capability: 'studio', scope: 'write', requiresConsent: true };
const ANALYZE = { name: 'image_analyze', capability: 'studio', scope: 'read', requiresConsent: false };
const WRITE = { name: 'fs.write', capability: 'cabinet', scope: 'write', requiresConsent: true };
const EXEC = { name: 'shell.exec', capability: 'workbench', scope: 'execute', requiresConsent: true };
const imageCall = { name: 'image_generate', args: { prompt: 'a sunrise over the station' } };

// ---- 1. the broker tier ----
{
  const granted = makeConsentBroker({ surface: 'autonomous', studioGrant: () => true });
  const d = granted(imageCall, IMAGE);
  A.ok(d.allow === true, 'a granted routine may generate an image unattended');
  A.ok(/per-routine unattended images grant/.test(d.reason), 'the allow names the grant that authorized it');

  const off = makeConsentBroker({ surface: 'autonomous', studioGrant: () => false });
  const refused = off(imageCall, IMAGE);
  A.ok(refused.allow === false, 'a predicate that says no leaves the default-deny standing');
  A.eq(refused.reason, SILENCE, 'with no refusal hook the ordinary "silence is not consent" answer is unchanged');
  A.ok(makeConsentBroker({ surface: 'autonomous' })(imageCall, IMAGE).allow === false, 'no predicate wired -> denied (every non-routine caller)');
  A.ok(makeConsentBroker({ surface: 'autonomous', studioGrant: () => { throw new Error('x'); } })(imageCall, IMAGE).allow === false, 'a throwing predicate fails closed');
  A.ok(makeConsentBroker({ surface: 'autonomous', studioGrant: () => 'yes' })(imageCall, IMAGE).allow === false, 'only a literal true counts');

  // capability-scoped: the images grant never generalizes to another family
  A.ok(granted({ name: 'fs.write', args: { path: 'a.md' } }, WRITE).allow === false, 'an images grant does NOT unlock a file write');
  A.ok(granted({ name: 'shell.exec', args: { cmd: 'ls' } }, EXEC).allow === false, 'an images grant does NOT unlock shell');
  // and it can never open execute, even for a studio tool declared that way: it sits below the exec lockout
  const STUDIO_EXEC = { name: 'studio.render', capability: 'studio', scope: 'execute', requiresConsent: true };
  A.ok(granted({ name: 'studio.render', args: {} }, STUDIO_EXEC).allow === false, 'an execute-scope studio tool is still locked out');
  const perms = read('sidecar/permissions.js');
  A.ok(perms.indexOf('if (studioAutonomy(call, tool)) return { allow: true') > perms.indexOf("surface === 'autonomous' && scope === 'execute'"),
    'the images tier sits BELOW the exec lockout (it is a write; it must never be able to open shell)');
  A.ok(perms.indexOf('if (studioAutonomy(call, tool)) return { allow: true') > perms.indexOf('const hr = hardline ? hardline(call, tool) : null;'),
    'and below the hardline floor');

  // surface-scoped: a watched run still asks the human (a thenable = it reached the prompt branch)
  const watched = makeConsentBroker({ surface: 'interactive', studioGrant: () => true, prompt: () => 'deny' })(imageCall, IMAGE);
  A.ok(watched && typeof watched.then === 'function', 'interactive still asks — the grant never pre-approves a watched run');

  // image_analyze is a read: allowed with or without the grant, exactly as before
  A.ok(makeConsentBroker({ surface: 'autonomous' })({ name: 'image_analyze', args: {} }, ANALYZE).allow === true, 'image_analyze stays a plain auto-allowed read');

  // the refusal hook: only studio refusals consult it; null/blank/throwing -> SILENCE
  const hinted = makeConsentBroker({ surface: 'autonomous', studioGrant: () => false, studioRefusal: () => 'ALLOW IMAGES hint' });
  A.eq(hinted(imageCall, IMAGE).reason, 'ALLOW IMAGES hint', 'an ungranted image call carries the host\'s refusal text');
  A.eq(hinted({ name: 'fs.write', args: { path: 'a.md' } }, WRITE).reason, SILENCE, 'a non-studio refusal never borrows the images hint');
  A.eq(makeConsentBroker({ surface: 'autonomous', studioRefusal: () => null })(imageCall, IMAGE).reason, SILENCE, 'a null hint falls back to SILENCE');
  A.eq(makeConsentBroker({ surface: 'autonomous', studioRefusal: () => '  ' })(imageCall, IMAGE).reason, SILENCE, 'a blank hint falls back to SILENCE');
  A.eq(makeConsentBroker({ surface: 'autonomous', studioRefusal: () => { throw new Error('x'); } })(imageCall, IMAGE).reason, SILENCE, 'a throwing hint falls back to SILENCE');

  // Full Access and a standing "Always" studio grant keep working exactly as before
  A.ok(makeConsentBroker({ surface: 'autonomous', bypass: true })(imageCall, IMAGE).allow === true, 'Full Access still generates');
  const always = makeConsentBroker({ surface: 'autonomous', grantsPermanent: new Set(['studio:write']) });
  A.ok(always(imageCall, IMAGE).allow === true, 'a standing Always studio:write grant still generates');
}

// ---- 2. the whitelist, the authority and the store ----
{
  A.ok(GRANTABLE_UNATTENDED.has('studio'), "'studio' is a grantable unattended family");
  A.eq(Array.from(normalizeUnattendedGrants(['studio', 'STUDIO', 'studio ', 'images', null, 'workbench'])).sort(), ['studio', 'workbench'],
    'the authority keeps exactly the modelled names (case and aliases are not grants)');
  const auth = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: ['studio'] });
  A.eq(auth.unattendedGrants, ['studio'], 'a run reports the images grant it actually carries');
  A.ok(auth.project(IMAGE) === true, 'image_generate is offered to an unattended run (impact none) — the broker decides');
  A.ok(auth.project(EXEC) === false, 'an images grant does not offer the terminal');

  const job = cronStore.makeJob({ id: 'sunrise', prompt: 'make me a sunrise picture', agentId: 'agent', schedule: { kind: 'every', everyMs: 3600000 }, unattendedGrants: ['studio', 'bogus'] }, { id: 'sunrise', now: 1 });
  A.eq(job.unattendedGrants, ['studio'], 'the job record keeps the images grant and drops an unknown one');
  let jobs = [job];
  jobs = cronStore.updateJob(jobs, 'sunrise', { unattendedGrants: ['workbench', 'studio', 'studio'] }, { now: 2 });
  A.eq(cronStore.getJob(jobs, 'sunrise').unattendedGrants, ['workbench', 'studio'], 'a patch re-normalizes (dedup, whitelist)');
  // GRANTS BIND TO THE APPROVED INSTRUCTION: an agent rewriting the task drops images too
  A.eq(cronStore.grantsRevokedByAgentEdit(cronStore.getJob(jobs, 'sunrise'), { prompt: 'something else entirely' }), ['workbench', 'studio'],
    'an agent rewriting a granted routine\'s task drops the images grant with the others');
  A.eq(cronStore.grantsRevokedByAgentEdit(cronStore.getJob(jobs, 'sunrise'), { name: 'renamed' }), [], 'a rename keeps it');
}

// ---- 3. the run wiring (index.js) ----
{
  const src = readSidecarSource();
  A.ok(/studioGrant: \(call, tool\) => !askedBy\.getStore\(\) && !execution\.taintedBy\(\) && unattendedGrants\.indexOf\('studio'\) >= 0,/.test(src),
    'the images grant is read off the run\'s host-sourced grants, lifted by taint, and never covers a delegated worker');
  A.ok(!/studioGrant:[^\n]*ownerTrusted/.test(src), 'it is not widened to other postures (Full Access / an owner DM pass by their own tiers)');
  A.ok(/surface === 'interactive' \? \[\] : Array\.from\(normalizeUnattendedGrants\(o\.unattendedGrants\)\)/.test(src),
    'the grant list itself is the same host-only source the terminal/connector grants use');
  // the refusal only speaks for a routine's OWN run, and names the switch that exists
  A.ok(/studioRefusal: \(\) => \{\s*if \(askedBy\.getStore\(\) \|\| !\(trigger === 'schedule' && String\(o\.cronJobId \|\| ''\)\)\) return null;/.test(src),
    'the images refusal hint is for a routine\'s own run only (a worker, hop, trigger or chat keeps the plain refusal)');
  A.ok(/▣ ALLOW IMAGES on this routine in AUTOMATE › SCHEDULES/.test(src), 'the refusal names the real row key and where it lives');
  A.ok(/switched off for the rest of THIS run because it read content from outside StarNet/.test(src), 'a granted run lifted by taint is told why, not sent to grant what it has');

  // taint: an image is not itself an outward action, so taint.js keeps the TOOL; the GRANT is what taint lifts
  A.ok(taint.allowedWhenTainted(IMAGE) === true, 'taint does not lock image_generate as a tool (a standing Always grant behaves as before)');

  // the row grant: added to the CURRENT grants, inside the cron write lock
  const upd = src.slice(src.indexOf('function handleCronUpdate('), src.indexOf('// POST /api/cron/remove'));
  A.ok(/const addGrants = Array\.isArray\(body\.addGrants\)/.test(upd), 'POST /api/cron/update accepts addGrants beside the patch');
  const lockAt = upd.indexOf('await withCronWrite(jobs => {');
  A.ok(lockAt > 0 && upd.indexOf('const current = cronStore.getJob(jobs, id);', lockAt) > lockAt, 'the current grants are read INSIDE the lock');
  A.ok(/\(current && current\.unattendedGrants\) \|\| \[\]\)\)\.concat\(addGrants\)/.test(upd), 'addGrants unions onto what the routine holds now');

  // the agent-facing routine paths still cannot name a grant (the self-grant hole stays closed)
  A.ok(!/unattendedGrants|addGrants/.test(read('sidecar/tools/builtin/routines.js')), 'routine.create / routine.manage never name a grant');
  A.ok(!/addGrants/.test(read('sidecar/slash-actions.js')), 'the /routine slash action cannot add one either');
}

// ---- 4. a line hop is never handed the grant ----
{
  const driver = read('sidecar/cron-driver.js');
  const seam = driver.slice(driver.indexOf('Promise.resolve(advanceChain({'), driver.indexOf('onHop: function () { renewLease(job.id, runId); }'));
  A.ok(/unattendedGrants: \[\]/.test(seam), 'the scheduled line seam hands every hop an EMPTY grant list');
  const src = readSidecarSource();
  const hop = src.slice(src.indexOf("GRANTS NEVER FLOW DOWN A LINE (2026-08-04): the unattended grant was approved"), src.indexOf("initialTaint: 'upstream agent output'\n              });"));
  A.ok(/unattendedGrants: \[\],/.test(hop), 'the Run Now hop is handed an EMPTY grant list too');
}

// ---- 5. the panel (create-form tick, row badge, row key) ----
{
  const panel = read('frontend/app/windows/routines.js');
  A.ok(/id="rt-img"/.test(panel), 'the create form carries the images tick');
  A.ok(/Let this routine make <b>images<\/b>/.test(panel), 'in plain language');
  A.ok(/can cost money and counts toward your spend caps/.test(panel), 'and it says the spend is real and capped');
  A.ok(/if \(\(body\.querySelector\('#rt-img'\) \|\| \{\}\)\.checked\) grants\.push\('studio'\);/.test(panel), 'a ticked box sends studio');
  A.ok(/\['#rt-term', '#rt-conn', '#rt-img'\]\.forEach/.test(panel), 'the images tick is never sticky across creates');
  A.ok(/grantBadge\(grantsOf\.indexOf\('studio'\) >= 0, '▣ images'/.test(panel), 'a routine that may make images is badged on its row');
  A.ok(/const canAllowImages = grantsOf\.indexOf\('studio'\) < 0 && !j\.noAgent;/.test(panel), 'ALLOW IMAGES shows only on a model routine that lacks it');
  A.ok(/data-act="allow-images"/.test(panel), 'the row key exists');
  const h = panel.slice(panel.indexOf("if (act === 'allow-images') {"), panel.indexOf("if (act === 'toggle') {"));
  A.ok(/if \(!btn\.dataset\.armed\)/.test(h), 'granting takes a deliberate second click');
  A.ok(/addGrants: \['studio'\]/.test(h), 'the row sends addGrants, never its own (possibly stale) grant list');
  A.ok(!/unattendedGrants: grantsOf/.test(h), 'it never re-posts the rendered list');
  A.ok(/job\.unattendedGrants\.indexOf\('studio'\) >= 0/.test(h), 'the success toast is proven off the saved job the station returns');
  A.ok(!/window\.confirm|confirm\(/.test(h), 'no native dialog');
}

A.report('routine-images-grant.test');
