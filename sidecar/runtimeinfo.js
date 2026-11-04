/* sidecar/runtimeinfo.js - safe, prompt-visible run identity.

   The host knows provider/model/run metadata, but the model only sees prompt text.
   This module exposes the harmless subset as a sanitized system-prompt block so
   the agent can answer basic operator questions without guessing. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).runtimeinfo = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function oneLine(v, fallback, max) {
    const s = (v == null ? '' : String(v))
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return (s || fallback || 'unknown').slice(0, max || 120);
  }

  function listLine(values, maxItems) {
    const out = [];
    const seen = new Set();
    for (const v of Array.isArray(values) ? values : []) {
      const s = oneLine(v, '', 120);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= (maxItems || 6)) break;
    }
    return out;
  }

  // "Today is Wednesday, September 30, 2026 (station clock; trust it over your own sense of the date)." or '' —
  // kept short: it rides every run's system prompt, which has a hard byte budget (test/payload.budget.test.js)
  function todayLine(now) {
    const t = Number(now);
    if (!Number.isFinite(t) || t <= 0) return '';
    try { return 'Today is ' + new Date(t).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' (station clock; trust it over your own sense of the date).'; } catch (_) { return ''; }
  }

  /* SHELL (#128, 2026-10-17): which shell shell.exec ACTUALLY runs for this agent. The tool description is one static
     string shared by every agent and machine, so it cannot know; models on Linux read its old "On Windows this uses
     cmd.exe; wrap PowerShell cmdlets…" as the rule, tried powershell first and burned a call on `powershell: not found`.
     The truth is per agent: the EFFECTIVE execution backend (execution-router.js backendIdFor — Full Power forces
     local, Safe Cell is Docker, Remote SSH is ssh), then the host OS only for the local backend. Docker runs `sh -lc`
     in the agent's container and SSH feeds `sh -s` on the remote host (environment.js), whatever this host is. Stable
     per agent + machine, and it rides the per-run [RUNTIME] block, never the cached tool schema. */
  function shellLine(o) {
    o = o || {};
    const backend = String(o.backend || '');
    const posix = ': POSIX sh syntax, not cmd.exe or PowerShell.';
    if (backend === 'docker') return 'Shell: shell.exec runs sh inside this agent\'s Docker container' + posix;
    if (backend === 'ssh') return 'Shell: shell.exec runs sh on this agent\'s remote SSH host' + posix;
    if (backend !== 'local') return '';
    if (o.platform === 'win32') return 'Shell: shell.exec runs Windows cmd.exe on this computer; wrap PowerShell cmdlets with `powershell -NoProfile -NonInteractive -Command "..."`.';
    const os = /^[a-z0-9]{2,16}$/.test(String(o.platform || '')) ? ' (' + o.platform + ')' : '';
    return 'Shell: shell.exec runs /bin/sh on this computer' + os + posix;
  }

  /* HOST FACTS (gh#128 family, safe-egress S4, 2026-11-03): the platform phrases a host-shared tool description may
     state. A description rides the cached tool schema to every model this machine serves, so a platform word in it is
     a claim about the machine: computer.use said "on the Windows desktop" and browser.test_navigate "never reach
     Windows" on macOS and Linux too, the family #128 closed for shell.exec (whose description now names no shell). A
     description takes its phrase from this one table, for the platform its factory was built for (deps.platform,
     default process.platform; tools/catalog.js buildCatalog({ platform }) declares any one). Same rule as shellLine:
     a platform the table does not know gets neutral words, never a guessed OS and never the raw string. The Windows
     phrases are the bytes those descriptions always had, so the cached tool prefix and payload.budget do not move. */
  const HOST_FACTS = Object.freeze({
    win32: Object.freeze({ os: 'Windows', desktop: 'the Windows desktop', desktopShort: 'Windows' }),
    darwin: Object.freeze({ os: 'macOS', desktop: 'the macOS desktop', desktopShort: 'macOS' }),
    linux: Object.freeze({ os: 'Linux', desktop: 'the Linux desktop', desktopShort: 'the desktop' })
  });
  const NEUTRAL_HOST = Object.freeze({ os: 'this computer\'s OS', desktop: 'this computer\'s desktop', desktopShort: 'the desktop' });
  function hostFacts(platform) {
    const p = String(platform == null ? '' : platform);
    return Object.prototype.hasOwnProperty.call(HOST_FACTS, p) ? HOST_FACTS[p] : NEUTRAL_HOST;
  }

  function runtimeIdentityBlock(o) {
    o = o || {};
    const provider = oneLine(o.provider, 'unknown', 80);
    const model = oneLine(o.model, 'unknown', 160);
    const surface = oneLine(o.surface, 'interactive', 40);
    const trigger = oneLine(o.trigger, 'directive', 40);
    const agentId = oneLine(o.agentId, 'agent', 80);
    const runId = oneLine(o.runId, 'pending', 120);
    const harness = oneLine(o.harness, 'unknown', 80);
    const app = oneLine(o.app, 'unknown', 40);
    const fallbacks = listLine(o.fallbackModels, 6).filter(x => x !== model);
    const lines = [
      '[RUNTIME]',
      'StarNet app version at run start: ' + app,
      'StarNet harness build at run start: ' + harness,
      'Provider: ' + provider,
      'Requested model at run start: ' + model,
      'Agent id: ' + agentId,
      'Run id: ' + runId,
      'Surface: ' + surface,
      'Trigger: ' + trigger
    ];
    if (fallbacks.length) lines.push('Possible fallback models: ' + fallbacks.join(', '));
    const shell = o.shell ? shellLine(o.shell) : '';   // only when shell.exec is on this run's wire
    if (shell) lines.push(shell);
    // TODAY (2026-09-30): a model's own sense of the date is its training era — asked for "today's news" it searched a
    // year-old month. The station's clock is the truth; `now` is injected by the caller (this file never reads a clock).
    const today = todayLine(o.now);
    if (today) lines.push(today);
    lines.push('If the Commander asks what StarNet build, model, provider, run, surface, or session you are using, answer from this block. For mutable harness state such as scheduler health, routines, connectors, or errors, call station.inspect. Do not guess or invent a CLI command.');
    return '\n\n' + lines.join('\n');
  }

  return { oneLine, runtimeIdentityBlock, todayLine, shellLine, hostFacts };
});
