/* Offline regressions for image-task admission, credential routing, and truthful completion. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const ImageTask = require('../sidecar/image-task.js');

// Explicit creation requests are guarded; analysis/discussion/negation stays on the ordinary path.
A.eq(ImageTask.classify('Create an image of a red cube'), { kind: 'image-generation' }, 'classifies an explicit image-generation request');
A.eq(ImageTask.classify('Please make me a picture of Northstar'), { kind: 'image-generation' }, 'classifies a named visual artifact request');
A.eq(ImageTask.classify('Draw me a capybara in a spacesuit'), null, 'an unspecified drawing medium retains the ordinary tool path');
A.eq(ImageTask.classify('Analyze this image and describe it'), null, 'image analysis is not mistaken for generation');
A.eq(ImageTask.classify('Design a logo system and usage guide'), null, 'an ambiguous design deliverable is not forced onto the raster STUDIO path');
A.eq(ImageTask.classify('Do not generate an image; write the prompt only'), null, 'a negated generation request is not artifact-gated');

for (const prompt of [
  'Draw a distinction between TCP and UDP',
  'Illustrate your reasoning with a text example',
  'Create a Docker image for this Node app',
  'Make the profile picture clickable',
  'Explain how image generators create pictures',
  'The image is broken. Create a fix for the upload handler',
  'Write a prompt that says: create an image of a red cube',
  'Can you explain how to generate an image of a red cube?',
  'Do not draw an image of a red cube',
  'Create an SVG image of a red cube',
  'Create an image of a red cube using CSS',
  'Generate an image of a diagram in Mermaid',
  'Draw an image of the architecture using ASCII',
  'Create an image processing script'
]) A.eq(ImageTask.classify(prompt), null, 'ordinary request is not STUDIO-gated: ' + prompt);
for (const prompt of [
  'Please create an image of a red cube',
  'Could you please generate a picture showing a moonlit forest?',
  'Draw an illustration depicting a capybara in a spacesuit',
  'Make me a photorealistic image of a mountain'
]) A.eq(ImageTask.classify(prompt), { kind: 'image-generation' }, 'explicit visual request retains artifact enforcement: ' + prompt);

// The configured provider/model remains the agent route. Only credentials proven compatible with
// STUDIO's OpenRouter transport may be selected for the separate generation call.
const direct = ImageTask.resolveRoute({ providerId: 'openrouter', runKey: 'run-or-key', stationOpenRouterKey: 'station-or-key' });
A.eq(direct.key, 'run-or-key', 'an OpenRouter run uses its own configured key');
A.eq(direct.keySource, 'run', 'the route records that the run key authorized generation');
const borrowed = ImageTask.resolveRoute({ providerId: 'gemini', runKey: 'gemini-key', stationOpenRouterKey: 'station-or-key' });
A.eq(borrowed.key, 'station-or-key', 'a non-OpenRouter run uses the separately connected station OpenRouter key');
A.eq(borrowed.keySource, 'station', 'the route never relabels the configured provider key');
const managedInput = { providerId: 'starnet', runKey: 'untrusted-request-key', providerBaseUrl: 'https://wrong.example/v1', managedKey: 'device-token', managedBaseUrl: 'https://account.starnetos.com/v1/' };
const managed = ImageTask.resolveRoute(managedInput);
A.eq(managed, { ok: true, provider: 'starnet', key: 'device-token', baseUrl: 'https://account.starnetos.com/v1', keySource: 'managed' }, 'credits-only route keeps the linked credential and endpoint together');
for (const providerId of ['gemini', 'codex', 'custom', 'anthropic']) {
  A.eq(ImageTask.resolveRoute({ ...managedInput, providerId }).provider, 'starnet', providerId + ' conversation can generate using linked credits');
}
A.eq(ImageTask.resolveRoute({ ...managedInput, managedBaseUrl: '', stationOpenRouterKey: 'byok' }).ok, false, 'missing managed endpoint cannot leak device token or silently spend BYOK');
A.eq(ImageTask.resolveRoute({ ...managedInput, managedKey: '' }).ok, false, 'missing managed credential fails closed');
A.eq(ImageTask.admissionBlocker({ hasStudio: true, studioEnabled: true, route: managed }), null, 'linked credits admit generation without an OpenRouter key');
const impossible = ImageTask.resolveRoute({ providerId: 'gemini', runKey: 'gemini-key', stationOpenRouterKey: '' });
A.eq(impossible.ok, false, 'a Gemini key alone is not treated as an OpenRouter STUDIO route');
A.eq(impossible.code, 'media-route-required', 'the incompatible credential path has an exact blocker code');

const noGear = ImageTask.admissionBlocker({ hasStudio: false, studioEnabled: false, route: direct, providerId: 'openrouter', model: 'x' });
A.ok(/Open REFIT, place a STUDIO/.test(noGear), 'missing gear names the exact REFIT action');
const disabled = ImageTask.admissionBlocker({ hasStudio: true, studioEnabled: false, route: direct });
A.ok(/MEDIA STUDIO is disabled/.test(disabled) && /ABILITIES > TOOLSETS/.test(disabled), 'disabled STUDIO names the exact toolset action instead of asking for another prop');
const noRoute = ImageTask.admissionBlocker({ hasStudio: true, studioEnabled: true, route: impossible, providerId: 'gemini', model: 'gemini-2.5-pro' });
A.ok(/gemini \/ gemini-2\.5-pro/.test(noRoute) && /link this station/.test(noRoute), 'incompatible model/key path names both the configured route and exact fix');
A.eq(ImageTask.admissionBlocker({ hasStudio: true, studioEnabled: true, route: direct }), null, 'a placed, enabled STUDIO plus compatible credential is admitted');

// Completion is artifact-backed. Successful prose, successful unrelated tools, or a generic file
// cannot turn an image request green; a collector-proven image path can.
const falseDone = { reason: 'done', messages: [{ role: 'assistant', content: 'Done!' }] };
const completionError = ImageTask.enforceCompletion(falseDone, [{ kind: 'file', path: 'notes.txt' }]);
A.eq(falseDone.reason, 'error', 'done without an image artifact is rewritten to error');
A.ok(/without a produced image artifact/.test(completionError), 'the completion error states the missing proof exactly');
const trueDone = { reason: 'done' };
A.eq(ImageTask.enforceCompletion(trueDone, [{ kind: 'image', path: 'images/result.png' }]), null, 'a produced image artifact preserves done');
A.eq(trueDone.reason, 'done', 'artifact-backed completion stays done');
const clarification = { reason: 'done' };
A.eq(ImageTask.enforceCompletion(clarification, [], { clarifying: true }), null, 'a Task Brief clarification is neutral, not a false completion');
A.eq(clarification.reason, 'done', 'the Task Brief host may map the neutral turn to clarifying');
const alreadyFailed = { reason: 'budget' };
A.eq(ImageTask.enforceCompletion(alreadyFailed, []), null, 'an existing non-success terminal is not rewritten');
A.eq(alreadyFailed.reason, 'budget', 'existing failure reason is preserved');

// Composition-root lock: the pure policy must guard the real run host, including the
// terminal event that consumers use as completion truth.
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
const runHost = indexSource.slice(indexSource.indexOf('async function runOnce(o)'));
const admissionAt = runHost.indexOf('ImageTask.admissionBlocker');
const loopAt = runHost.indexOf('result = await runAgentLoop');
A.ok(admissionAt >= 0 && loopAt > admissionAt, 'the STUDIO blocker runs before the configured model/fallback loop');
A.ok(/makeImageTools\(\{ openrouter: studioRoute\.ok \? \{ apiKey: studioRoute\.key, model, baseUrl: studioRoute\.baseUrl/.test(runHost), 'the image tool receives only the compatible resolved key and base route');
A.ok(/\(taskBrief \|\| imageTask\).*agent\.run\.end/.test(runHost), 'a provisional image-task done event is buffered until artifact settlement');
A.ok(/ImageTask\.enforceCompletion\(result, execution\.artifactList\(\)/.test(runHost), 'the real artifact ledger settles image completion');
A.ok(/reason: taskQuestionAsked \? 'clarifying' : \(\(result && result\.reason\)/.test(runHost), 'the emitted terminal uses the artifact-corrected result reason');



const byokRecovery = ImageTask.admissionBlocker({ hasStudio: true, studioEnabled: true, providerId: 'custom', model: 'local-model', route: { ok: false } });
A.ok(/OpenRouter API key/.test(byokRecovery) && /StarNet account/.test(byokRecovery), 'BYOK media recovery exposes both supported routes');
const managedRecovery = ImageTask.admissionBlocker({ hasStudio: true, studioEnabled: true, providerId: 'starnet', route: { ok: false } });
A.ok(/relink/.test(managedRecovery) && !/OpenRouter/.test(managedRecovery), 'managed failure stays on the linked-account route');

A.report('image-task.test');
