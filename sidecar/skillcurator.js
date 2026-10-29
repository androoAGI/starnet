/* sidecar/skillcurator.js - runtime skill lifecycle and consolidation helpers. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillcurator = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function str(v) { return v == null ? '' : String(v); }
  function token(name) {
    const parts = str(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return parts[0] || 'skill';
  }
  function isAgentCreated(s) {
    const by = str(s && s.createdBy);
    return by === 'agent' || by === 'background-review' || by === 'reflection' || by === 'agent-created';
  }
  function candidates(skills) {
    return (Array.isArray(skills) ? skills : []).filter(s => s && s.state !== 'archived' && !s.pinned && isAgentCreated(s));
  }
  function clusters(skills) {
    const map = {};
    for (const s of candidates(skills)) {
      const k = token(s.name);
      (map[k] = map[k] || []).push(s);
    }
    return Object.keys(map).sort().map(k => ({ key: k, skills: map[k].sort((a, b) => a.name.localeCompare(b.name)) })).filter(c => c.skills.length >= 2);
  }
  function shouldCurate(skills, opts) {
    opts = opts || {};
    const minSkills = opts.minSkills == null ? 8 : opts.minSkills;
    if (candidates(skills).length >= minSkills) return true;
    return clusters(skills).length > 0;
  }
  function buildPrompt(input) {
    input = input || {};
    const skills = candidates(input.skills);
    const cls = clusters(skills);
    // A row the gate withholds (annotated by the host: skills/gate.js annotate) is named, never summarized (the scan census).
    const list = skills.length ? skills.map(s => s.withheld ? '- ' + s.name + ' [WITHHELD by the skill guard; leave it alone]' :
      '- ' + s.name + ' [' + (s.category || 'General') + ', use=' + (s.useCount || 0) + ', patch=' + (s.patchCount || 0) + '] -- ' + str(s.summary || '').replace(/\s+/g, ' ').slice(0, 180)
    ).join('\n') : '(none)';
    const clusterLines = cls.length ? cls.map(c => '- ' + c.key + ': ' + c.skills.map(s => s.name).join(', ')).join('\n') : '(none)';
    return [
      'You are StarNet skill curator. This is an umbrella-building consolidation pass.',
      '',
      'Goal: maintain a library of class-level skills, not one-session micro-skills.',
      'Hard rules:',
      '- Touch only agent-created skills shown below.',
      '- Never delete. Archive only after content has been merged or explicitly pruned.',
      '- Never modify pinned skills. This is enforced: a pinned skill refuses every content change.',
      '- Every archive MUST set absorbedInto to the live skill that now carries the content. This is enforced; an archive without it is refused.',
      '- You must skill.view a skill in THIS pass before you may patch, edit, add a file to, or archive it. This is enforced. Never rewrite a skill from its summary.',
      '- Do not use low usage counts as the reason to skip consolidation.',
      '- Prefer one broad umbrella with labeled subsections plus references/templates/scripts over many narrow siblings.',
      '',
      'How to work:',
      '- Inspect clusters with skill.view.',
      '- Patch an existing umbrella when one is broad enough.',
      '- Create a new umbrella only when no existing skill is a good home.',
      '- Demote narrow session detail into references/, templates/, scripts/, or assets/ via skill.manage write_file.',
      '- Archive siblings only after their unique content is preserved, naming the umbrella in absorbedInto.',
      '',
      'Candidate clusters:',
      clusterLines,
      '',
      'Candidate skills:',
      list
    ].join('\n');
  }

  return { candidates, clusters, shouldCurate, buildPrompt };
});
