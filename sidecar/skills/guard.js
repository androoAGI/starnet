/* sidecar/skills/guard.js - static guard for runtime/external skill packages.

   The scanner is intentionally regex-based and deterministic. It catches
   common prompt-injection, exfiltration, destructive command, persistence,
   and obfuscation patterns before a skill package is trusted.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillGuard = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRUST = {
    builtin: { safe: 'allow', caution: 'allow', dangerous: 'allow' },
    trusted: { safe: 'allow', caution: 'allow', dangerous: 'block' },
    // Community procedures commonly contain URLs or setup scripts. Those are inspectable cautions,
    // not automatic malware: install them withheld and bind the Commander's approval to exact bytes.
    // High/critical findings remain an outright block.
    community: { safe: 'allow', caution: 'ask', dangerous: 'block' },
    'agent-created': { safe: 'allow', caution: 'allow', dangerous: 'ask' },
    /* THE COMMANDER IS THE APPROVER, SO THEY GET ASK — NOT BLOCK. A skill the human typed into
       the SKILLS panel used to be scanned as 'trusted', whose answer for dangerous content is
       block; with the gate now enforcing verdicts that made a dead end — you write `rm -rf` into
       your own local procedure on purpose, and the only surface that could bless it is the one
       refusing you, with no key anywhere ("sandbox, no gating" cuts against that). 'trusted'
       still means what it says for content that arrives claiming to be vetted by someone else
       (a future hub install), where a dangerous pattern is evidence the claim is false. */
    user: { safe: 'allow', caution: 'allow', dangerous: 'ask' }
  };
  const ORDER = { safe: 0, caution: 1, dangerous: 2 };
  const PATTERNS = [
    [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'env_exfil_curl', 'critical', 'exfiltration', 'curl command interpolating a secret env var'],
    [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'env_exfil_wget', 'critical', 'exfiltration', 'wget command interpolating a secret env var'],
    [/fetch\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD|API)/i, 'env_exfil_fetch', 'high', 'exfiltration', 'fetch call mentioning secret material'],
    [/requests\.(get|post|put|patch)\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD)/i, 'env_exfil_requests', 'high', 'exfiltration', 'requests call mentioning secret material'],
    [/ignore (all )?(previous|prior|system|developer) instructions/i, 'ignore_instructions', 'high', 'injection', 'instruction override request'],
    [/reveal (the )?(system|developer) prompt/i, 'reveal_prompt', 'high', 'injection', 'prompt disclosure request'],
    [/rm\s+-rf\s+(\/|\$HOME|~|\.)/i, 'rm_rf', 'critical', 'destructive', 'destructive recursive removal'],
    [/Remove-Item\s+.*-Recurse\s+.*-Force/i, 'ps_remove_recurse', 'critical', 'destructive', 'destructive PowerShell removal'],
    /* FETCHED-INSTALL INSTRUCTIONS (2026-09-30). The malicious skills found in another harness's public registry
       (hundreds of them, one campaign) carried no code at all: their TEXT told the reader to install a fake
       "prerequisite" by piping a download into a shell. A text-only package is no defence against that, so a skill
       that tells anyone to download-and-run is rated dangerous, and the softer "paste this into your terminal"
       phrasing is a caution a person must look at. A skill that needs a CLI says so and checks `<tool> --version`. */
    [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i, 'remote_install_pipe', 'high', 'remote-execution', 'a download piped straight into a shell'],
    [/\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n|]*\|\s*(iex|Invoke-Expression)\b/i, 'remote_install_pipe_ps', 'high', 'remote-execution', 'a download piped straight into PowerShell'],
    [/\b(ba|z)?sh\b[^\n]*(<\(|\$\()\s*(curl|wget)\b/i, 'remote_install_subshell', 'high', 'remote-execution', 'a shell running a downloaded script'],
    [/\b(paste|copy and paste|run)\s+(this|the following)\s+(command\s+|line\s+|script\s+)?(in|into)\s+(your\s+|a\s+|the\s+)?(terminal|powershell|command prompt|shell|console)\b/i, 'paste_into_terminal', 'medium', 'remote-execution', 'tells the reader to paste a command into a terminal'],
    [/>+\s*~\/\.(bashrc|zshrc|profile|powershell)/i, 'shell_profile_persist', 'medium', 'persistence', 'shell profile persistence'],
    [/\b(base64|fromCharCode|eval|Invoke-Expression)\b/i, 'obfuscation_eval', 'medium', 'obfuscation', 'obfuscation or dynamic execution'],
    [/https?:\/\/[^\s`'")]+/i, 'network_url', 'low', 'network', 'embedded network URL']
  ];
  const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

  function str(v) { return v == null ? '' : String(v); }
  function verdictFor(findings) {
    let max = 0;
    for (const f of findings) max = Math.max(max, SEV_RANK[f.severity] || 0);
    if (max >= 3) return 'dangerous';
    if (max >= 1) return 'caution';
    return 'safe';
  }
  function scanText(file, content) {
    const findings = [];
    const lines = str(content).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/.test(line)) {
        findings.push({ patternId: 'invisible_unicode', severity: 'medium', category: 'obfuscation', file, line: i + 1, match: '', description: 'invisible Unicode control character' });
      }
      for (const p of PATTERNS) {
        const m = p[0].exec(line);
        if (m) findings.push({ patternId: p[1], severity: p[2], category: p[3], file, line: i + 1, match: str(m[0]).slice(0, 160), description: p[4] });
      }
    }
    return findings;
  }
  /* Scan what the model is shown (sweep/skills 2026-10-20). The name, summary, description and category reach every
     run through the prompt index, so they are scanned too (reported without a line number; the market already did
     this). A support file stored base64-encoded is scanned as its decoded text, not as its encoding. */
  const FileBytes = (typeof require === 'function') ? require('./file-bytes.js') : null;   // the canonical-bytes boundary
  function scanText64(file, f) {
    if (!f || f.encoding !== 'base64') return scanText(file, f && f.content);
    const text = FileBytes ? FileBytes.textOf(f) : null;
    return text != null ? scanText(file, text) : [];
  }
  /* THE SCAN CENSUS (skills-canonical-bytes lane, 2026-10-28; test/skills.scan-census.test.js). Every field of a record
     that reaches a prompt is scanned here. The index prints a skill's platforms, and skill.list / skill.view / a
     preloaded skill print every support file's PATH: both are model-authored text no scan covered. A finding in a path
     names that file (file: its path, line 0, inPath), never SKILL.md. */
  function promptMeta(skill) {
    const platforms = Array.isArray(skill.platforms) ? skill.platforms : [];
    return [skill.name, skill.summary, skill.description, skill.category].map(str).concat(platforms.map(str)).join('\n');
  }
  function scanSkillRecord(skill, opts) {
    opts = opts || {};
    const source = opts.source || skill.createdBy || 'agent-created';
    const files = Array.isArray(skill.files) ? skill.files : [];
    const meta = promptMeta(skill);
    let findings = scanText('SKILL.md', meta).map(f => Object.assign(f, { line: 0 }));
    for (const f of files) {
      const p = str(f && f.path);
      findings = findings.concat(scanText(p || 'support-file', p).map(x => Object.assign(x, { line: 0, inPath: true, description: x.description + ' (in the file name)' })));
    }
    findings = findings.concat(scanText('SKILL.md', str(skill.body) + '\n' + str(skill.setup)));
    for (const f of files) findings = findings.concat(scanText64(str(f.path || 'support-file'), f));
    const verdict = verdictFor(findings);
    return {
      skillName: str(skill.name || skill.id || 'skill'),
      source,
      trustLevel: TRUST[source] ? source : 'community',
      verdict,
      findings,
      summary: findings.length ? (findings.length + ' finding(s), verdict=' + verdict) : 'safe'
    };
  }
  function shouldAllow(scan, opts) {
    opts = opts || {};
    if (!scan) return { allow: true, action: 'allow', reason: 'not scanned' };
    const trust = TRUST[scan.trustLevel] || TRUST.community;
    const action = trust[scan.verdict] || 'block';
    if (action === 'allow') return { allow: true, action, reason: scan.summary || 'safe' };
    if (action === 'ask' && opts.allowAsk !== false) return { allow: true, action, reason: scan.summary || 'requires review' };
    return { allow: false, action, reason: scan.summary || 'blocked by skill guard' };
  }
  /* "take the WORSE of two risk levels" — which failed OPEN on anything it did not recognize. ORDER[unknown]
     is undefined, and `undefined >= n` is FALSE, so an unrecognized level always LOST: worse('Dangerous',
     'safe') returned 'safe', and so did any typo, casing difference, or level a newer scanner emits. An
     unknown risk is the one thing that must never be treated as the safer option — rank it above every known
     level so it wins, and normalize case so a spelling difference is not a downgrade. */
  function rankOf(v) {
    const k = String(v == null ? '' : v).trim().toLowerCase();
    if (!k) return ORDER.safe;
    return Object.prototype.hasOwnProperty.call(ORDER, k) ? ORDER[k] : Infinity;   // unknown = worst
  }
  function worse(a, b) { return rankOf(a) >= rankOf(b) ? a : b; }

  /* TRUST FROM ORIGIN, NEVER THE LAST EDITOR (2026-09-29). Every edit used to overwrite createdBy with the
     editor, and the tier was read off createdBy — so an agent editing a withheld community skill relabeled it
     'agent', the re-scan ran at the agent tier, caution findings flipped ask -> allow and the imported body
     reached the model unapproved (a panel rollback relabeled it 'user' the same way). A skill now keeps the
     tier of where it CAME FROM, and each write is also judged at the tier of WHO WROTE it; the stricter wins.
     A record carrying install provenance (sourceUrl/sourceDigest) came from outside whatever its createdBy
     says, which also heals records the old relabel already rewrote. */
  const ACTION_ORDER = { allow: 0, ask: 1, block: 2 };
  function worseAction(a, b) {
    const ra = Object.prototype.hasOwnProperty.call(ACTION_ORDER, a) ? ACTION_ORDER[a] : 2;
    const rb = Object.prototype.hasOwnProperty.call(ACTION_ORDER, b) ? ACTION_ORDER[b] : 2;
    return ra >= rb ? a : b;
  }
  function tierOf(by) {
    const s = str(by).trim().toLowerCase();
    if (s === 'user') return 'user';
    if (s === 'community' || s === 'skill-exchange') return 'community';
    if (s === 'builtin' || s === 'trusted') return s;
    return 'agent-created';
  }
  function originTier(skill) {
    const t = tierOf(skill && skill.createdBy);
    if (t === 'community' || t === 'builtin' || t === 'trusted') return t;
    return (str(skill && skill.sourceUrl) || str(skill && skill.sourceDigest)) ? 'community' : t;
  }
  // actionFor(skill, verdict) -> 'allow' | 'ask' | 'block': the stricter of the origin tier and the writer tier
  function actionFor(skill, verdict) {
    const v = Object.prototype.hasOwnProperty.call(ORDER, str(verdict)) ? str(verdict) : 'dangerous';   // unknown verdict = worst
    const row = (t) => TRUST[t] || TRUST.community;
    let action = row(originTier(skill))[v] || 'block';
    const writer = str(skill && skill.writtenBy);
    if (writer) action = worseAction(action, row(tierOf(writer))[v] || 'block');
    return action;
  }

  return { scanText, scanSkillRecord, shouldAllow, worse, TRUST, tierOf, originTier, actionFor };
});
