/* sidecar/skills/gate.js - WHO MAY READ a saved skill.

   skillstore.persist() has always scanned every skill through skills/guard.js and stamped the
   verdict on the record as `guardAction` ('allow' | 'ask' | 'block'). Nothing consumed it: a
   skill the scanner called dangerous was still indexed into the system prompt, still preloaded
   by /skill, and still returned in full by skill.view. This module is the consumer — the one
   place that answers "may the MODEL see this?".

   Three rules, and they are deliberately not symmetric:
     block -> never visible, and NOT approvable. `block` is the trust table's answer for content
              a TRUSTED source should never have written (skills/guard.js TRUST); a click cannot
              make it safe, and offering the click would just train the Commander to click.
     ask   -> withheld until the Commander approves THIS EXACT CONTENT. The approval is keyed to
              a content digest, mirroring plugins.js keying its allowlist to the code hash: an
              edit re-asks, exactly like a silently edited plugin re-asks.
     other -> visible.

   A withheld skill is still LISTED (name + reason, never its summary — the summary is
   model-authored text the scanner never covered). Hiding the row outright would make the model
   try to create a same-named skill, which manage() then refuses as a duplicate: a silent gate
   that manufactures a confusing refusal two turns later. Truthful telemetry applies to the
   prompt too — say the skill exists and say it is withheld.

   Pure and dependency-injected: `approvals` is a lookup the sidecar owns (a JSON file under
   WORKSPACES), `guard` is skills/guard.js. Nothing here touches the filesystem.
*/
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillGate = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTION_RANK = { allow: 0, '': 0, ask: 1, block: 2 };
  function str(v) { return v == null ? '' : String(v); }
  function rankOf(a) {
    const k = str(a).trim().toLowerCase();
    // Unknown action = worst, same law as guard.js worse(): an unrecognized verdict must never
    // be treated as the safer option.
    return Object.prototype.hasOwnProperty.call(ACTION_RANK, k) ? ACTION_RANK[k] : ACTION_RANK.block;
  }
  function worseAction(a, b) { return rankOf(a) >= rankOf(b) ? (str(a) || 'allow') : (str(b) || 'allow'); }
  function trustSource(createdBy) {
    const source = str(createdBy).trim().toLowerCase();
    if (source === 'user') return 'user';
    if (source === 'community' || source === 'skill-exchange') return 'community';
    if (source === 'builtin' || source === 'trusted') return source;
    return 'agent-created';
  }

  /* digestOf — a stable content fingerprint over everything the guard actually scans (body,
     setup, and every support file), so an approval is bound to the content that was reviewed.
     FNV-1a in pure JS on purpose: skillstore stamps this on every persist and the store must
     stay dependency-free (no crypto, no injected hash to forget in a test). Collision risk is
     irrelevant here — this is a change detector, not a signature.
     A FILE IS HASHED AS ITS BYTES (canonical bytes, 2026-10-28): its exact text, else a binary marker and its canonical
     base64 (skills/file-bytes.js contentKey; a binary file never digests like a text file holding its base64, so the
     marker moves a binary file's digest, and the re-stamp below carries it like any other). It used to hash the string the file happened to be stored as, so the same bytes
     stored base64 (every installed package file) and read back as text (the package mirror) were two digests, and an
     approval of one never matched the other. A text file stored as text hashes exactly as before, so an approval of an
     authored skill is untouched; skillstore re-stamps a record whose stored form changed its digest, and the host
     carries its approvals over (restampApprovals, below). */
  const contentKey = (typeof require === 'function') ? require('./file-bytes.js').contentKey : (f) => str(f && f.content);
  function digestOf(skill) { return fnvDigest(skill, contentKey); }
  // The v0.14 digest (the stored string of each file), kept ONLY to recognise what an approval written before the
  // canonical digest carries. Never stamp with it.
  function legacyDigestOf(skill) { return fnvDigest(skill, (f) => str(f && f.content)); }
  function fnvDigest(skill, keyOf) {
    const files = Array.isArray(skill && skill.files) ? skill.files.slice() : [];
    files.sort((a, b) => str(a && a.path).localeCompare(str(b && b.path)));
    let text = str(skill && skill.body) + '\x00' + str(skill && skill.setup);
    for (const f of files) text += '\x00' + str(f && f.path) + '\x00' + (f ? keyOf(f) : '');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      const hi = text.charCodeAt(i) >>> 8;
      if (hi) { h ^= hi; h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    }
    return ('00000000' + h.toString(16)).slice(-8) + '-' + text.length;
  }

  function categoriesOf(skill) {
    const scan = skill && skill.scan;
    const findings = (scan && Array.isArray(scan.findings)) ? scan.findings : [];
    const out = [];
    for (const f of findings) {
      // Report the CATEGORY, never the matched text: the match is attacker-authored content and
      // echoing it into a tool result would carry the injection straight back into the prompt.
      const c = str(f && f.category);
      if (c && out.indexOf(c) < 0) out.push(c);
    }
    return out;
  }

  function makeSkillGate(deps) {
    deps = deps || {};
    const guard = deps.guard || null;
    const approvals = deps.approvals || null;

    function keyFor(agentId, id) { return str(agentId || 'agent') + '\x00' + str(id); }
    function approvalFor(skill) {
      if (!approvals || typeof approvals.get !== 'function' || !skill) return null;
      try { return approvals.get(str(skill.agentId || 'agent'), str(skill.id), stampOf(skill)) || null; } catch (_) { return null; }
    }
    /* A stamped digest is what list() can carry (metadata only — no body). When the store had no
       digest stamper, fall back to the lifecycle stamp so an approval still expires on the next
       real mutation rather than never expiring. */
    function stampOf(skill) {
      const d = str(skill && skill.contentDigest);
      return d || ('u' + str((skill && skill.updatedAt) || 0));
    }
    /* AN UNSTAMPED RECORD (no contentDigest: saved before digest stamping — a legacy row with no verdict, or an
       'ask' written between verdict stamping and digest stamping) has only the lifecycle stamp, which no
       Approve can match: the route binds the approval to digestOf(the bytes the Commander read). With the body,
       verify() re-scans those live bytes and re-decides against their digest (below), so an approval releases
       exactly the bytes that were scanned and read — never unscanned bytes on a lifecycle stamp (review
       2026-10-12: an earlier fix approved the live digest here with no scan, which laundered a rewrite past the
       guard). Metadata only (the prompt index, skill.list): the lifecycle stamp the record carried when it was
       approved (`rec.stamp`), so the next real mutation re-asks. A stamped record is unchanged. */
    function isApproved(skill) {
      const rec = approvalFor(skill);
      if (!rec) return false;
      const want = str(rec.digest);
      if (want === stampOf(skill)) return true;
      if (str(skill.contentDigest) || typeof skill.body === 'string') return false;
      return !!str(rec.stamp) && str(rec.stamp) === stampOf(skill);
    }

    /* decide — the metadata-only decision, safe to call from the index composer where bodies are
       not loaded. `action` is the guard verdict already stamped on the record by persist(). */
    /* The action the trust rule gives this record TODAY, from metadata alone: the stored scan verdict judged at
       the stricter of its origin tier and its writer tier (guard.actionFor). A stamp written under the old
       relabel can be MORE permissive than that; it never wins. '' when there is no guard or no stored verdict. */
    function ruleAction(skill) {
      const verdict = str(skill && skill.scan && skill.scan.verdict);
      if (!verdict || !guard || typeof guard.actionFor !== 'function') return '';
      try { return str(guard.actionFor(skill, verdict)); } catch (_) { return ''; }
    }
    function decide(skill) {
      if (skill && skill.pendingCandidate) return { action: 'ask', visible: false, approvable: false,
        categories: categoriesOf(skill), reason: 'proposed revision awaits behavior evaluation and Commander approval; the active version is unchanged' };
      const stamped = str(skill && skill.guardAction).trim().toLowerCase();
      const rule = ruleAction(skill);
      const action = rule ? worseAction(stamped, rule) : stamped;
      if (action === 'block') {
        return { action: 'block', visible: false, approvable: false, categories: categoriesOf(skill),
          reason: 'blocked by the skill guard' };
      }
      if (action === 'ask') {
        if (isApproved(skill)) return { action: 'ask', visible: true, approvable: true, approved: true, categories: categoriesOf(skill), reason: 'approved by the Commander' };
        return { action: 'ask', visible: false, approvable: true, approved: false, categories: categoriesOf(skill),
          reason: 'needs the Commander\'s approval in ABILITIES > SKILLS' };
      }
      return { action: action || 'allow', visible: true, approvable: false, categories: [], reason: '' };
    }

    /* verify — the DELIVERY decision, for the one path that hands over a real body (skill.view /
       preload). package.js hydrate() reads SKILL.md back off disk and OVERRIDES the stored body,
       so the bytes delivered here are not necessarily the bytes persist() scanned: someone who
       can write into the package dir could otherwise launder content past the scanner. Recompute
       the digest, and on a mismatch re-scan LIVE and take the worse of the two actions. */
    function liveScan(skill) {
      try {
        if (!guard || typeof guard.scanSkillRecord !== 'function' || typeof guard.shouldAllow !== 'function') return null;
        const scan = guard.scanSkillRecord(skill, { source: typeof guard.originTier === 'function' ? guard.originTier(skill) : trustSource(skill.createdBy) });
        if (typeof guard.actionFor === 'function') return { action: guard.actionFor(skill, scan.verdict), scan };
        const policy = guard.shouldAllow(scan, { allowAsk: true });
        return { action: (policy && policy.action) || 'allow', scan };
      } catch (_) { return null; }
    }
    function verify(skill) {
      const base = decide(skill);
      const stamped = str(skill && skill.contentDigest);
      if (!skill || typeof skill.body !== 'string') return base;
      /* A LEGACY RECORD CARRIES NO VERDICT AND NO DIGEST. skills.jsonl predates both the scanner
         and this gate, so an old skill would otherwise sail through with guardAction '' — the
         quietest possible hole, because it looks exactly like a clean skill. Nothing can scan it
         from metadata alone (list() has no body), so the delivery seam scans it here, where the
         body finally exists. The index may still name it; only the bytes are gated. */
      if (!stamped && !str(skill.guardAction)) {
        const live = liveScan(skill);
        if (!live || live.action === 'allow') return base;
        // Decide against the digest of the bytes just scanned: the allow route stores digestOf(the body the Commander
        // read), so with no stamp isApproved() would compare it to 'u'+updatedAt and ALLOW would never take effect.
        // An approval releases exactly these bytes.
        const legacy = decide(Object.assign({}, skill, { guardAction: live.action, scan: live.scan, contentDigest: digestOf(skill) }));
        legacy.unscanned = true;
        if (!legacy.visible) legacy.reason = 'this skill was saved before the guard existed and re-scanning it flagged content — review it in ABILITIES > SKILLS';
        return legacy;
      }
      /* An unstamped record WITH a verdict: its verdict describes bytes no digest pins, so re-scan what is here now,
         take the worse action, and judge any approval against THESE bytes' digest (fail closed: unscannable => ask). */
      if (!stamped) {
        const live = liveScan(skill);
        return decide(Object.assign({}, skill, {
          guardAction: worseAction(base.action, live ? live.action : 'ask'), scan: (live && live.scan) || skill.scan, contentDigest: digestOf(skill)
        }));
      }
      if (digestOf(skill) === stamped) return base;
      const live = liveScan(skill);
      const action = worseAction(base.action, live ? live.action : 'ask');   // unscannable tamper => at least ask
      /* Re-decide against the LIVE digest, never the stamped one. decide()'s 'ask' branch calls
         isApproved(), which compares the approval record to stampOf(skill) === skill.contentDigest — the
         digest written at PERSIST time, which a write into the package dir never moves. Handing decide()
         the stale stamp here let a prior approval clear the very tamper this branch just proved it does
         not cover, and the live re-scan can never save it: liveScan passes source 'user'/'agent-created'
         and both TRUST rows map dangerous -> 'ask', never 'block', so worseAction('ask','ask') is 'ask'
         and the approved branch made it visible. That laundered whatever is now in SKILL.md into the
         model on the one seam that hands over a real body. */
      const merged = decide(Object.assign({}, skill, {
        guardAction: action, scan: (live && live.scan) || skill.scan, contentDigest: digestOf(skill)
      }));
      merged.tampered = true;
      merged.approved = false;   // an approval of other bytes is not an approval of these
      merged.reason = merged.visible ? merged.reason
        : (merged.action === 'block' ? 'the package on disk no longer matches what was reviewed, and re-scanning it blocked'
          : 'the package on disk was changed after it was reviewed — re-approve it in ABILITIES > SKILLS');
      return merged;
    }

    /* annotate — stamp the decision onto a metadata list without mutating the input. Consumers
       (prompt index, skill.list, the SKILLS panel) all read the same fields.

       With { verify: true } AND a body present, the DELIVERY decision is used instead of the
       metadata-only one. decide() cannot re-digest, so a caller that holds real bytes would otherwise
       keep printing "Approved by you for this exact content" about a package whose SKILL.md no longer
       matches what was reviewed — the panel asserting a content binding the backend does not hold.
       Callers with metadata only (the prompt index, skill.list) get decide() exactly as before. */
    function annotate(skills, opts) {
      const useVerify = !!(opts && opts.verify);
      return (Array.isArray(skills) ? skills : []).map(s => {
        const d = (useVerify && s && typeof s.body === 'string') ? verify(s) : decide(s);
        return Object.assign({}, s, {
          withheld: !d.visible, withheldReason: d.visible ? '' : d.reason,
          guardDecision: d.action, guardApprovable: !!d.approvable, guardCategories: d.categories,
          guardTampered: !!d.tampered
        });
      });
    }
    // Reviewers may inspect their clean draft to continue editing it. This does not
    // grant foreground delivery or waive a content finding / blocked origin.
    function verifyDraft(skill) {
      if (!skill || !skill.pendingCandidate) return verify(skill);
      const live = liveScan(skill);
      if (!live || live.action !== 'allow') return { action: (live && live.action) || 'ask', visible: false,
        approvable: false, categories: categoriesOf(skill), reason: 'pending draft must pass the content guard before a reviewer can load it' };
      return { action: 'allow', visible: true, approvable: false, categories: [], reason: 'review draft only; not an active skill' };
    }
    function pending(skills) {
      return annotate(skills).filter(s => s.withheld && s.guardApprovable)
        .map(s => ({ id: s.id, agentId: s.agentId, name: s.name, action: s.guardDecision, categories: s.guardCategories, digest: stampOf(s) }));
    }

    return { decide, verify, verifyDraft, annotate, pending, keyFor, stampOf, isApproved, digestOf };
  }

  /* restampApprovals(approvals, restamps) -> a new approvals map, or null when nothing moves. The approvals file
     (skills-allowed.json) is keyed '<agent>\0<id>' (the panel's one approval per skill) or '<agent>\0<id>\0<digest>'
     (a promotion's precommit). For each re-stamp skillstore.digestRestamps() lists, an approval that carries one of
     that record's old digests is copied to '<agent>\0<id>\0<new digest>' with the new digest (and the new stamp, when
     its stamp was the record's old stamp): the same bytes, approved once, stay approved. Nothing is removed, so an
     older StarNet reading the file still finds its own key. A copy is marked `restampedFrom`, so the Commander's next
     decision on the skill supersedes it (supersedeApproval, below). */
  function restampApprovals(approvals, restamps) {
    if (!approvals || typeof approvals !== 'object' || !Array.isArray(restamps) || !restamps.length) return null;
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    let next = null;
    for (const r of restamps) {
      if (!r || !str(r.to) || !Array.isArray(r.from) || !r.from.length) continue;
      const base = str(r.agentId || 'agent') + '\x00' + str(r.id);
      const target = base + '\x00' + str(r.to);
      if (own(next || approvals, target)) continue;
      for (const k of [base].concat(r.from.map(d => base + '\x00' + str(d)))) {
        const rec = own(approvals, k) ? approvals[k] : null;
        if (!rec || typeof rec !== 'object' || r.from.indexOf(str(rec.digest)) < 0) continue;
        next = next || Object.assign({}, approvals);
        const stamp = str(rec.stamp) && str(rec.stamp) === str(r.stamp) ? str(r.to) : rec.stamp;
        next[target] = Object.assign({}, rec, { digest: str(r.to), stamp, restampedFrom: str(rec.digest) });
        break;
      }
    }
    return next;
  }

  /* supersedeApproval(approvals, key, entry) -> a new approvals map holding `entry` at the panel key '<agent>\0<id>',
     with every '<agent>\0<id>\0<digest>' copy restampApprovals made removed. A copy carries an older decision forward to
     the new digest of the same bytes; once the Commander decides again, that older decision is over. Left in place, it
     sat beside the new approval under its own digest key (the lookup reads the digest key first), so restoring the
     superseded bytes on disk released them again. A promotion's own digest-keyed precommit is not a copy and stays. */
  function supersedeApproval(approvals, key, entry) {
    const next = dropRestamped(approvals, key);
    next[str(key)] = entry;
    return next;
  }
  /* dropRestamped(approvals, key) -> a new approvals map without the '<agent>\0<id>\0<digest>' copies restampApprovals made
     for the skill at panel key `key`. Each of the Commander's decisions on a skill ends them: the allow route (through
     supersedeApproval) and a promotion (index.js approve-candidate, once it has landed). Everything else stays, the
     panel key and a promotion's own precommit included. */
  function dropRestamped(approvals, key) {
    const next = Object.assign({}, approvals && typeof approvals === 'object' ? approvals : {});
    const prefix = str(key) + '\x00';
    for (const k of Object.keys(next)) {
      const rec = next[k];
      if (k.startsWith(prefix) && rec && typeof rec === 'object' && str(rec.restampedFrom)) delete next[k];
    }
    return next;
  }
  /* pruneRestamped(approvals) -> a new approvals map without each restamped copy a later decision on its skill
     superseded, or null when there is none. The host runs it once at boot, after restampApprovals. A promotion drops
     the copies once it lands (dropRestamped), but if that write fails the copies stay, and the older decision would
     go on releasing its bytes beside the promotion. So a copy whose `at` (the time of the decision it carries) is older
     than the skill's panel key or one of its precommits is dropped here, unless that newer decision is of the same
     bytes the copy carries (its digest is the copy's restampedFrom): that is the same approval, given again. */
  function pruneRestamped(approvals) {
    if (!approvals || typeof approvals !== 'object') return null;
    const at = (rec) => (Number.isFinite(Number(rec && rec.at)) ? Number(rec.at) : 0);
    const decisions = new Map();   // '<agent>\0<id>' -> the panel key and precommits: [{ at, digest }]
    const copies = [];
    for (const k of Object.keys(approvals)) {
      const rec = approvals[k];
      if (!rec || typeof rec !== 'object') continue;
      const parts = k.split('\x00');
      if (parts.length < 2 || parts.length > 3) continue;
      const base = parts[0] + '\x00' + parts[1];
      if (parts.length === 3 && str(rec.restampedFrom)) { copies.push({ k, base, at: at(rec), from: str(rec.restampedFrom) }); continue; }
      if (!decisions.has(base)) decisions.set(base, []);
      decisions.get(base).push({ at: at(rec), digest: str(rec.digest) });
    }
    let next = null;
    for (const c of copies) {
      if (!(decisions.get(c.base) || []).some(d => d.at > c.at && d.digest !== c.from)) continue;
      next = next || Object.assign({}, approvals);
      delete next[c.k];
    }
    return next;
  }

  return { makeSkillGate, digestOf, legacyDigestOf, restampApprovals, supersedeApproval, dropRestamped, pruneRestamped, worseAction };
});
