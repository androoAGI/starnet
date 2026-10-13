/* node test/reasoning-migration-0125.test.js — the 0.12.5 reasoning migration keeps what an upgraded station RAN.
   0.12.4's dock showed every OpenAI-API / xAI / Grok / DeepSeek / StarNet Managed model locked at OFF and saved it,
   while the adapter sent no reasoning_effort. 0.12.5 sends the saved level, so without this migration an upgrade
   would silently turn reasoning OFF for OpenAI/xAI/DeepSeek users and switch paid thinking ON for Managed users.
   app.js is not node-loadable, so the migration is lifted from source (like station-default-wire.test.js). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const readSourceText = require('./_source-text.js');
const appjs = readSourceText(path.join(__dirname, '..', 'frontend', 'app', 'app.js'));
const harnessjs = readSourceText(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'));

function lift(src, name) {
  const start = src.indexOf('  function ' + name + '(');
  A.ok(start >= 0, name + ' exists');
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start, end + 4);
}
function liftConst(src, name) {
  const m = new RegExp('\\n  const ' + name + ' = [^\\n]+\\n').exec(src);
  A.ok(!!m, 'const ' + name + ' exists');
  return m ? m[0] : '';
}
const oneLine = (s, name) => { const m = new RegExp('\\n  function ' + name + '\\([^\\n]+\\n').exec(s); A.ok(!!m, name + ' exists'); return m ? m[0] : ''; };
const src = liftConst(appjs, 'REASONING_MIGRATION') + liftConst(appjs, 'LEGACY_DIAL_LOCKED')
  + oneLine(appjs, 'savedStationProv') + '\n' + lift(appjs, 'migrateLegacyReasoning');
function migrate(saved) {
  const calls = [];
  const Harness = {
    clearLegacyReasoningOff: list => calls.push(['clear', list.slice()]),
    setReasoningEffort: (e, p) => calls.push(['set', e, p])
  };
  const normalizeProviderId = p => String(p || '').trim().toLowerCase();
  const fn = new Function('Harness', 'normalizeProviderId', src + '\nreturn migrateLegacyReasoning;')(Harness, normalizeProviderId);
  return { changed: fn(saved), calls, saved };
}

// ---- OpenAI-API station: the inherited OFF is dropped so the model's default reasoning applies again ----
{
  const r = migrate({ prov: 'openai', reasoningEffort: 'none',
    agent: { id: 'agent', model: 'gpt-5.5', provider: 'openai', reasoningEffort: 'none' },
    agents: [
      { id: 'agent', model: 'gpt-5.5', provider: 'openai', reasoningEffort: 'none' },
      { id: 'coder', model: 'deepseek-v4-pro', provider: 'deepseek', reasoningEffort: 'none' },
      { id: 'grokker', model: 'grok-4.3', provider: 'xai', reasoningEffort: 'off' },
      { id: 'thinker', model: 'deepseek-v4-pro', provider: 'deepseek', reasoningEffort: 'high' },
      { id: 'claude', model: 'claude-sonnet-5', provider: 'anthropic', reasoningEffort: 'none' },
      { id: 'router', model: 'openai/gpt-5.5', provider: 'openrouter', reasoningEffort: 'none' },
      { id: 'unpinned', model: '', provider: null, reasoningEffort: 'none' }
    ] });
  A.eq(r.changed, true, 'a pre-0.12.5 save migrates');
  A.eq(r.saved.agent.reasoningEffort, null, 'the Overseer\'s inherited OFF on OpenAI-API is dropped (model default again)');
  A.eq(r.saved.agents[1].reasoningEffort, null, 'DeepSeek inherited OFF is dropped');
  A.eq(r.saved.agents[2].reasoningEffort, null, 'xAI inherited OFF (stored as off) is dropped');
  A.eq(r.saved.agents[3].reasoningEffort, 'high', 'a non-OFF level on those providers is kept');
  A.eq(r.saved.agents[4].reasoningEffort, 'none', 'Anthropic had a real dial in 0.12.4: its OFF was a real choice and is kept');
  A.eq(r.saved.agents[5].reasoningEffort, 'none', 'OpenRouter had a real dial in 0.12.4: its OFF is kept');
  A.eq(r.saved.agents[6].reasoningEffort, 'none', 'an unpinned agent is untouched (it follows the station default)');
  A.eq('reasoningEffort' in r.saved, false, 'the station-level inherited OFF is dropped');
  A.eq(r.saved.reasoningMigrated, '0125', 'the save is marked');
  A.eq(r.calls[0], ['clear', ['openai', 'xai', 'grok', 'deepseek']], 'the per-provider stored OFF is cleared for exactly the locked providers');
  A.eq(r.calls[1], ['set', 'none', 'starnet'], 'Managed keeps OFF on the page wire');
}

// ---- StarNet Managed station: nothing was sent in 0.12.4, so the onboarding MEDIUM must not switch thinking on ----
{
  const r = migrate({ prov: 'starnet', reasoningEffort: 'medium',
    agent: { id: 'agent', model: 'anthropic/claude-sonnet-5', provider: 'starnet', reasoningEffort: 'medium' },
    agents: [{ id: 'writer', model: 'openai/gpt-5.5', provider: 'starnet', reasoningEffort: 'high' }] });
  A.eq(r.saved.agent.reasoningEffort, 'none', 'the Managed Overseer keeps OFF (nothing sent), not its onboarding MEDIUM');
  A.eq(r.saved.agents[0].reasoningEffort, 'none', 'a Managed pin keeps OFF');
  A.eq(r.saved.reasoningEffort, 'none', 'the Managed station wire keeps OFF');
}

// ---- a pin with no provider uses the station provider (as focusWire does) ----
{
  const r = migrate({ agent: { id: 'agent', model: 'gpt-5.5', provider: 'openai', reasoningEffort: 'none' },
    agents: [{ id: 'x', model: 'gpt-5.4', reasoningEffort: 'none' }] });
  A.eq(r.saved.agents[0].reasoningEffort, null, 'a provider-less pin on an OpenAI-API station is migrated like the station');
}

// ---- once migrated, a deliberate 0.12.5 OFF is never touched again ----
{
  const r = migrate({ reasoningMigrated: '0125', prov: 'openai', reasoningEffort: 'none',
    agent: { id: 'agent', model: 'gpt-5.5', provider: 'openai', reasoningEffort: 'none' } });
  A.eq(r.changed, false, 'an already-migrated save is left alone');
  A.eq(r.saved.agent.reasoningEffort, 'none', 'an explicit 0.12.5 OFF survives');
  A.eq(r.calls.length, 0, 'no stored wire is touched');
}

// ---- wiring locks: both load sites migrate BEFORE the saved effort reaches the wire, and every save is marked ----
A.ok(/migrateLegacyReasoning\(saved\);[^\n]*\n\s*if \(savedStationProv\(saved\) && Harness\.setProv\)/.test(appjs), 're-entry migrates before restoring the wire');
A.ok(/if \(saved && saved\.agent\) migrateLegacyReasoning\(saved\);[^\n]*\n\s*if \(saved && savedStationProv\(saved\)/.test(appjs), 'boot migrates before restoring the wire');
const persistMark = /reasoningEffort, reasoningMigrated: '([^']+)'/.exec(appjs);
A.ok(!!persistMark, 'persist marks every save');
A.eq(persistMark && persistMark[1], (/\n  const REASONING_MIGRATION = '([^']+)';/.exec(appjs) || [])[1], 'the persisted marker equals REASONING_MIGRATION');
A.ok(/getReasoningEffort, setReasoningEffort, clearLegacyReasoningOff,/.test(harnessjs), 'Harness exposes clearLegacyReasoningOff');

// ---- Harness.clearLegacyReasoningOff removes only an inherited OFF, only for the named providers ----
{
  const store = new Map([
    ['starnet.byok.reasoningEffort.openai', 'none'], ['starnet.byok.reasoningEffort.deepseek', 'high'],
    ['starnet.byok.reasoningEffort.anthropic', 'none'], ['starnet.byok.reasoningEffort.xai', 'off']
  ]);
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), removeItem: k => store.delete(k) };
  const LS = { effort: 'starnet.byok.reasoningEffort' };
  const hsrc = lift(harnessjs, 'normalizeReasoningEffort') + '\n' + lift(harnessjs, 'clearLegacyReasoningOff');
  const clear = new Function('localStorage', 'LS', 'providerSlot', 'normalizeProviderId', hsrc + '\nreturn clearLegacyReasoningOff;')(
    localStorage, LS, (base, p) => base + '.' + p, p => String(p).toLowerCase());
  clear(['openai', 'xai', 'grok', 'deepseek']);
  A.eq(store.has('starnet.byok.reasoningEffort.openai'), false, 'OpenAI-API inherited OFF is cleared');
  A.eq(store.has('starnet.byok.reasoningEffort.xai'), false, 'xAI inherited OFF (stored as off) is cleared');
  A.eq(store.get('starnet.byok.reasoningEffort.deepseek'), 'high', 'a real level is kept');
  A.eq(store.get('starnet.byok.reasoningEffort.anthropic'), 'none', 'a provider outside the list is untouched');
}

A.report('reasoning-migration-0125.test');
