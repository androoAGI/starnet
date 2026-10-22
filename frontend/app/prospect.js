/* AGENT OS — prospect.js : the PURE prospect generator (the station AUTHORS bespoke new agent specs beyond the
   curated catalog + archetype pool).

   Where recruiter.js (Slice 2) ranks EXISTING classes against the Commander's real workflow, this covers the gap
   the catalog CAN'T fill: as the station learns, it drafts a brand-new specialist tailored to the observed work —
   a "prospect". The station DRAFTS; the Commander CONFIRMS (never auto-save, never auto-summon) — the agent-analog
   of the R5 "bottle a run" flow.

   This module owns two pure, deterministic halves (no Date.now / Math.random — the clock is injected upstream):
     • buildDirective(ctx) — a strict, constrained reason-only directive (mirrors pitch.js discipline): propose
       EXACTLY ONE new specialist in a fixed NAME:/EMOJI:/… format, choosing kit ONLY from the real CAP_REGISTRY
       keys and skills ONLY from the real installed slugs, grounding WHY in the real observed signal, and replying
       NONE when a catalog class (esp. the recruiter's top pick) already serves the gap.
     • parse(text) — parse + VALIDATE HARD: reject any kit key not in the allowed capability set, any unknown skill
       slug, and any near-duplicate of an existing class (name/tag overlap). A rejected parse yields null (no
       prospect this cycle) — a malformed spec is NEVER rendered. NONE parses to a sentinel, not a draft.

   TRUTHFUL TELEMETRY: the parsed WHY (grounded in a real counter) is the only reason a prospect card ever shows,
   and the validated kit is the only capability set it may claim. A `Prospect` global in the browser,
   module.exports under node. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Prospect = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FIELDS = ['NAME', 'EMOJI', 'TAGLINE', 'PURPOSE', 'MANUAL', 'KIT', 'SKILLS', 'WHY'];

  // build the constrained drafting directive. ctx = { dossierBlock, worksignalSummary, rosterClasses (name/tag),
  // catalogSummary ([{id,tagline}] of ALL builtins+customs — so it never duplicates one), capabilityKeys (real
  // CAP_REGISTRY keys the kit may use), skillSlugs (real installed skill-library slugs), topRecommendation
  // (the recruiter's top existing-class pick, so the draft only covers what NO class serves). */
  function buildDirective(ctx) {
    ctx = ctx || {};
    const caps = (ctx.capabilityKeys || []).join(', ');
    const slugs = (ctx.skillSlugs || []).join(', ');
    const roster = (ctx.rosterClasses || []).map(c => (c && (c.name || c)) || '').filter(Boolean).join(', ') || '(none yet)';
    const catalog = (ctx.catalogSummary || []).map(c => '• ' + (c.id || '?') + ' — ' + (c.tagline || '')).join('\n') || '(none)';
    const top = ctx.topRecommendation ? String(ctx.topRecommendation) : '';
    const lines = [];
    lines.push('You are the station\'s recruiter, drafting ONE brand-new specialist role tailored to how the Commander ACTUALLY works.');
    lines.push('A specialist is a REAL JOB with standing importance in the Commander\'s business, project, or craft — the kind of role they would hire for (think: retention editor, grant writer, community manager, supply buyer). Never a generalist assistant, never a vague "helper".');
    lines.push('');
    lines.push('WHAT YOU KNOW ABOUT THE COMMANDER:');
    if (ctx.dossierBlock) lines.push(String(ctx.dossierBlock).trim());
    if (ctx.worksignalSummary) lines.push('OBSERVED WORKFLOW: ' + String(ctx.worksignalSummary).trim());
    lines.push('');
    lines.push('CURRENT CREW (do NOT duplicate these roles): ' + roster);
    lines.push('EXISTING CLASS CATALOG (do NOT propose anything an entry here already serves):');
    lines.push(catalog);
    if (top) lines.push('The best-fitting EXISTING class for the current gap is: ' + top + '. Only draft a prospect if NO existing class — including that one — already serves the observed need.');
    lines.push('');
    lines.push('HARD CONSTRAINTS:');
    lines.push('- Propose EXACTLY ONE new specialist, distinct from every crew member AND every catalog entry above.');
    lines.push('- The role must be SPECIALIZED: one clear job a business would hire for, with a domain of its own — not a broader restatement of an existing class and not an assistant-for-everything.');
    lines.push('- PURPOSE states the job, the standard the work is held to, and what the role never does. MANUAL bullets are a real operating playbook (method + honesty rules + output shape), not restated marketing.');
    lines.push('- KIT must be chosen ONLY from these real capability keys: ' + (caps || '(none available)') + '. Use nothing else.');
    lines.push('- SKILLS must be chosen ONLY from these real installed skill slugs: ' + (slugs || '(none available)') + '. Use nothing else. SKILLS may be empty.');
    lines.push('- WHY must cite the REAL observed signal above (the capability lanes / stated goals) — never a generic pitch.');
    lines.push('- If an existing class already serves the need, reply with exactly: NONE');
    lines.push('');
    lines.push('REPLY IN EXACTLY THIS FORMAT (one per line, no extra prose):');
    lines.push('NAME: <role name, 2-3 words>');
    lines.push('EMOJI: <one glyph>');
    lines.push('TAGLINE: <one line, what it is for>');
    lines.push('PURPOSE: <2-4 sentences — its job, in the harness voice>');
    lines.push('MANUAL: <2-5 standing-order bullets separated by " | ">');
    lines.push('KIT: <comma-separated capability keys from the allowed set>');
    lines.push('SKILLS: <comma-separated skill slugs from the allowed set, or leave blank>');
    lines.push('WHY: <one sentence grounding this in the Commander\'s observed work>');
    return lines.join('\n');
  }

  // a stable fingerprint for dedup + denylist: lowercase alphanumeric tokens >=3 chars, deduped + sorted.
  function fingerprint(text) {
    const toks = String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }

  // token-overlap ratio of two fingerprints (Jaccard) — for near-duplicate detection against existing classes.
  function overlap(fpA, fpB) {
    const a = fpA ? fpA.split(' ') : [], b = fpB ? new Set(fpB.split(' ')) : new Set();
    if (!a.length || !b.size) return 0;
    let hit = 0; for (const t of a) if (b.has(t)) hit++;
    return hit / new Set(a.concat(Array.from(b))).size;
  }

  // parse + VALIDATE. opts = { allowedKit (Set/array of real CAP keys), allowedSkills (Set/array of real slugs),
  // existingClasses ([{name,tags}] builtins+customs — near-duplicate guard) }.
  // Returns: null (unparseable/invalid), { none:true } (explicit NONE), or a validated draft spec.
  function parse(text, opts) {
    opts = opts || {};
    const raw = String(text == null ? '' : text);
    if (/^\s*NONE\s*$/im.test(raw) && !/^\s*NAME\s*:/im.test(raw)) return { none: true };   // explicit no-mint

    // capture the value ON THE SAME LINE only. Horizontal-whitespace classes ([^\S\r\n]) around the value stop the
    // trailing \s* from swallowing the newline and grabbing the NEXT field's text when a field is EMPTY (e.g. an
    // empty "SKILLS:" line followed by "WHY: …" must yield '' for SKILLS, not the WHY line).
    const grab = label => { const m = new RegExp('^[^\\S\\r\\n]*' + label + '[^\\S\\r\\n]*:[^\\S\\r\\n]*([^\\r\\n]*?)[^\\S\\r\\n]*$', 'im').exec(raw); return m ? m[1].trim() : ''; };
    const name = grab('NAME');
    const tagline = grab('TAGLINE');
    const purpose = grab('PURPOSE');
    const why = grab('WHY');
    // the load-bearing fields must all be present — a partial draft is a malformed one (never rendered).
    if (!name || !tagline || !purpose || !why) return null;

    const allowedKit = toSet(opts.allowedKit);
    const allowedSkills = toSet(opts.allowedSkills);
    const kit = splitList(grab('KIT'));
    const skills = splitList(grab('SKILLS'));
    // HARD kit validation: every kit key must be a REAL capability. One bad key rejects the whole draft (a spec
    // that claims a capability the registry can't grant is a lie — never soft-drop it into a partial claim).
    if (!kit.length) return null;                                   // a specialist with no gear is not a real role
    for (const k of kit) if (!allowedKit.has(k)) return null;
    for (const s of skills) if (!allowedSkills.has(s)) return null; // HARD skill validation: no unknown slug

    // NEAR-DUPLICATE guard: reject a draft whose name/tag fingerprint overlaps an existing class too much.
    const draftFp = fingerprint(name + ' ' + tagline);
    const draftTagFp = fingerprint(tagline);
    for (const cls of (opts.existingClasses || [])) {
      const clsFp = fingerprint((cls.name || '') + ' ' + Object.keys(cls.tags || {}).join(' ') + ' ' + (cls.tagline || ''));
      if (name && cls.name && name.toLowerCase() === String(cls.name).toLowerCase()) return null;   // exact name clash
      if (overlap(draftFp, clsFp) >= 0.6) return null;             // heavy token overlap → too close to an existing class
      // a near-identical TAGLINE is a strong duplicate signal on its own (same job, different name) — reject it.
      if (draftTagFp && overlap(draftTagFp, fingerprint(cls.tagline || '')) >= 0.7) return null;
    }

    const manual = grab('MANUAL');
    const emoji = (grab('EMOJI') || '✦').slice(0, 2) || '✦';
    return {
      none: false,
      draft: {
        name: name.slice(0, 28),
        emoji,
        tagline: tagline.slice(0, 60),
        purpose,
        manual: manual ? manual.split('|').map(s => s.trim()).filter(Boolean).map(s => (s[0] === '-' ? s : '- ' + s)).join('\n') : '',
        kit, skills,
        custom: true
      },
      why,
      fingerprint: draftFp
    };
  }

  function toSet(x) { return x instanceof Set ? x : new Set(Array.isArray(x) ? x : []); }
  function splitList(s) { return String(s || '').split(/[,\s]+/).map(t => t.trim().toLowerCase()).filter(Boolean); }

  return { buildDirective, parse, fingerprint, overlap, FIELDS };
});
