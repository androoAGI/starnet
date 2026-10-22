/* sidecar/skills/catalog.js — the BUNDLED skill library: pre-installed, capability-gated recipe documents.

   Distinct from sidecar/skillstore.js (the agent's OWN runtime-saved procedures). These ship WITH Agent OS as
   curated markdown recipes (ported pure-prompt skills). Each declares `requires` = the capability OBJECTS it
   needs (cabinet / dish / workbench / studio / ...) so a recipe is AVAILABLE only to an agent whose workstation
   actually has those objects placed -- the object=capability moat extended from raw tools to know-how. Enabled
   recipes an agent can support are indexed in THAT run's system prompt with the full body one skill.view call
   away (composeIndex; the bodies stay inline via compose() on a run without skill.view), so a skill is REAL
   (the model is told the recipe), never UI decoration.

   PURE (no Date / Math.random / network): loadDir takes an injected fs+path. parse / compose / isAvailable are
   deterministic -- exactly what lint-determinism.js requires and what the node test pins. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).skillsCatalog = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SLUG_RE = /[^a-z0-9]+/g;
  function slugify(s) { return String(s || '').toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

  /* FRONTMATTER: a dependency-free YAML SUBSET (2026-09-29). Our own recipes are authored flat, but a standard
     SKILL.md (the Agent Skills spec, Anthropic's and Hermes' skills, skills.sh) also uses block scalars
     (`description: >-`), nested maps (`metadata:` with author/version) and dash lists. The old flat reader turned
     `description: >-` into the literal text '>-' and silently dropped every nested map. Supported: plain,
     "double" (JSON escapes) and 'single' quoted scalars, multi-line plain/quoted continuations, | and > block
     scalars with - / + chomping, nested maps, dash lists, [flow, lists], true/false, and # comments. Anything
     else stays a string: this reads metadata, it never executes or resolves anything (no anchors, no tags). */
  function unquote(v) {
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
      try { return JSON.parse(v); } catch (_) { return v.slice(1, -1); }
    }
    if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
    return null;
  }
  function splitFlow(inner) {
    const items = []; let cur = '', q = '';
    for (const ch of inner) {
      if (q) { cur += ch; if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === ',') { items.push(cur); cur = ''; continue; }
      cur += ch;
    }
    items.push(cur);
    return items.map(x => x.trim()).filter(Boolean).map(x => { const u = unquote(x); return u !== null ? u : x; });
  }
  function parseValue(raw) {
    let v = String(raw == null ? '' : raw).trim();
    if (v === '') return '';
    const q = unquote(v);
    if (q !== null) return q;
    const hash = v.search(/\s#/);   // a plain scalar ends at ' #' (YAML comment)
    if (hash >= 0) v = v.slice(0, hash).trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v[0] === '[' && v[v.length - 1] === ']') return splitFlow(v.slice(1, -1));
    return v;
  }
  function indentOf(line) { return line.length - line.replace(/^ +/, '').length; }
  function isBlank(line) { return /^\s*(?:#.*)?$/.test(line); }
  const KEY_RE = /^([^\s#:'"\-][^:]*?|-[^\s:][^:]*?)\s*:(?:[ \t]+(.*))?$/;
  function openQuote(v) {
    if (v[0] !== '"' && v[0] !== "'") return false;
    return unquote(v) === null || (v[0] === '"' && /\\"$/.test(v) && !/\\\\"$/.test(v));
  }
  function readBlockScalar(lines, i, parentIndent, header) {
    const style = header[0];
    const chomp = (header.match(/[+-]/) || [''])[0];
    const buf = [];
    let blockIndent = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { buf.push(''); i++; continue; }
      const li = indentOf(l);
      if (li <= parentIndent || (blockIndent >= 0 && li < blockIndent)) break;
      if (blockIndent < 0) blockIndent = li;
      buf.push(l.slice(blockIndent)); i++;
    }
    let trailing = 0;
    while (buf.length && buf[buf.length - 1] === '') { buf.pop(); trailing++; }
    let text;
    if (style === '|') text = buf.join('\n');
    else {
      // folded: single newlines become spaces, blank lines stay newlines, more-indented lines keep their breaks
      text = '';
      for (let k = 0; k < buf.length; k++) {
        const line = buf[k];
        if (k === 0) { text = line; continue; }
        const prev = buf[k - 1];
        if (line === '') { text += '\n'; continue; }
        if (prev === '' || /^\s/.test(line) || /^\s/.test(prev)) text += (prev === '' ? '' : '\n') + line;
        else text += ' ' + line;
      }
    }
    if (chomp === '+') text += '\n'.repeat(trailing + 1);
    else if (chomp !== '-' && text) text += '\n';
    return { value: text, next: i };
  }
  function parseList(lines, i, indent) {
    const out = [];
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      const ind = indentOf(line);
      if (ind < indent || !/^-(?:\s|$)/.test(line.slice(ind))) break;
      if (ind > indent) { i++; continue; }
      const item = line.slice(ind + 1).replace(/^\s+/, '');
      if (KEY_RE.test(item)) {
        // "- key: value" opens a map item; re-read it with the dash as indentation
        const inner = ind + 1 + (line.slice(ind + 1).length - item.length);
        const copy = lines.slice(); copy[i] = ' '.repeat(inner) + item;
        const r = parseMap(copy, i, inner);
        out.push(r.value); i = r.next; continue;
      }
      out.push(parseValue(item)); i++;
    }
    return { value: out, next: i };
  }
  function parseMap(lines, i, indent) {
    const out = {};
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) { i++; continue; }            // tolerant: a stray over-indented line is skipped
      const m = line.slice(ind).match(KEY_RE);
      if (!m) { if (/^-(?:\s|$)/.test(line.slice(ind))) break; i++; continue; }
      const key = m[1].trim().replace(/^["']|["']$/g, '');
      let rest = (m[2] || '').trim();
      i++;
      if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(rest)) {
        const r = readBlockScalar(lines, i, ind, rest);
        out[key] = r.value; i = r.next; continue;
      }
      if (rest === '' || /^#/.test(rest)) {
        let j = i; while (j < lines.length && isBlank(lines[j])) j++;
        const next = j < lines.length ? lines[j] : '';
        const ni = next ? indentOf(next) : -1;
        const isItem = next && /^-(?:\s|$)/.test(next.slice(ni));
        if (next && (ni > ind || (ni === ind && isItem))) {
          const r = isItem ? parseList(lines, j, ni) : parseMap(lines, j, ni);
          out[key] = r.value; i = r.next;
        } else out[key] = '';
        continue;
      }
      // a plain or quoted scalar may continue on more-indented lines (and a quote until it closes)
      // (continuations are always MORE indented than the key, so an unclosed quote can never swallow the next key)
      while (i < lines.length && lines[i].trim() !== '' && indentOf(lines[i]) > ind) {
        if (!openQuote(rest) && KEY_RE.test(lines[i].trim())) break;
        rest += ' ' + lines[i].trim(); i++;
      }
      out[key] = parseValue(rest);
    }
    return { value: out, next: i };
  }
  function parseFrontmatter(text) {
    let t = String(text == null ? '' : text);
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);   // strip a leading BOM if a skill file happens to have one
    const m = t.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: t };
    const lines = m[1].replace(/\t/g, '  ').split(/\r?\n/);
    let meta = {};
    try { meta = parseMap(lines, 0, 0).value; } catch (_) { meta = {}; }
    return { meta: meta, body: m[2].trim() };
  }

  // normalize a parsed skill into the canonical shape. `fallbackSlug` = the filename stem when no `slug:` is set.
  function normalize(meta, body, fallbackSlug) {
    meta = meta || {};
    const requires = Array.isArray(meta.requires) ? meta.requires.map(s => String(s).trim()).filter(Boolean)
      : (meta.requires ? [String(meta.requires).trim()] : []);
    const name = String(meta.name || fallbackSlug || 'Skill').trim();
    return {
      slug: slugify(meta.slug || fallbackSlug || name),
      name: name,
      description: String(meta.description || '').trim(),
      category: String(meta.category || 'General').trim(),
      requires: requires,
      author: String(meta.author || '').trim(),
      license: String(meta.license || '').trim(),
      version: String(meta.version || '').trim(),
      default: meta.default === true,                 // ships ENABLED out of the box (kept to a few lean, broadly-usable recipes)
      body: String(body || '').trim()
    };
  }
  function parse(text, fallbackSlug) { const fm = parseFrontmatter(text); return normalize(fm.meta, fm.body, fallbackSlug); }

  // load every *.md in `dir` via an injected fs ({ readdirSync, readFileSync }) + path ({ join }). Unreadable or
  // malformed files are skipped (fail-open -- a bad recipe never breaks the catalog). Stable category->name order.
  function loadDir(dir, fsmod, pathmod) {
    const out = [];
    let files = [];
    try { files = fsmod.readdirSync(dir).filter(f => /\.md$/i.test(f)); } catch (_) { return out; }
    for (const f of files) {
      try { out.push(parse(fsmod.readFileSync(pathmod.join(dir, f), 'utf8'), f.replace(/\.md$/i, ''))); }
      catch (_) { /* skip a bad file */ }
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return out;
  }

  function asSet(v) { return v instanceof Set ? v : new Set(v || []); }

  // availability = the agent's workstation has EVERY object this recipe needs (object = capability). [] => always.
  function isAvailable(skill, placedTypes) {
    const have = asSet(placedTypes);
    return (skill.requires || []).every(t => have.has(t));
  }
  // enabled = the frontmatter default, overridden by an explicit user choice (overrides: {slug:bool} or Map).
  function isEnabled(skill, overrides) {
    const isMap = overrides instanceof Map;
    const has = isMap ? overrides.has(skill.slug) : !!(overrides && Object.prototype.hasOwnProperty.call(overrides, skill.slug));
    if (has) return !!(isMap ? overrides.get(skill.slug) : overrides[skill.slug]);
    return !!skill.default;
  }
  // Class Loadouts S1: a PER-AGENT class skill package is ADD-ONLY — enabling a skill for this agent can never
  // DISABLE a globally-enabled one, and it doesn't touch the global prefs. So agentEnabled = the class package
  // includes this slug, OR the global rule already enables it. Still gated by availability (placedTypes) + budget.
  function isAgentEnabled(skill, overrides, agentSet) {
    if (agentSet && agentSet.has(skill.slug)) return true;
    return isEnabled(skill, overrides);
  }

  // catalog for the UI/API: each skill plus its enabled/available flags for a given workstation.
  function catalog(skills, opts) {
    opts = opts || {};
    const placed = asSet(opts.placedTypes);
    return (skills || []).map(s => ({
      slug: s.slug, name: s.name, description: s.description, category: s.category,
      requires: (s.requires || []).slice(), author: s.author, license: s.license, version: s.version,
      default: s.default, body: s.body,
      market: !!s.market, shelf: s.shelf || '',   // installed from the Skill Market (skills/market.js), not bundled
      enabled: isEnabled(s, opts.overrides),
      available: isAvailable(s, placed)
    }));
  }

  // the recipes THIS run is offered: ENABLED (global prefs, ADD-only class package) *and* AVAILABLE (the gear is
  // placed), in compose order. The ONE definition shared by the inline block, the index, and skill.view's lookup,
  // so the three can never disagree about which recipes a run has.
  function live(skills, opts) {
    opts = opts || {};
    const placed = asSet(opts.placedTypes);
    // Class Loadouts S1: opts.agentSkills = this agent's class package (slugs). Union ADD-only with global prefs.
    const agentSet = (opts.agentSkills && (opts.agentSkills.size || opts.agentSkills.length))
      ? asSet(Array.isArray(opts.agentSkills) ? opts.agentSkills : [...opts.agentSkills]) : null;
    const out = (skills || []).filter(s => isAgentEnabled(s, opts.overrides, agentSet) && isAvailable(s, placed));
    // agent-package skills compose FIRST so, under the budget cap, GLOBAL extras get truncated before the
    // class package (the class's own recipes are the priority the summon promised).
    if (agentSet) out.sort((a, b) => (agentSet.has(b.slug) ? 1 : 0) - (agentSet.has(a.slug) ? 1 : 0));
    return out;
  }

  // compose the run-prompt block: full bodies of skills that are ENABLED *and* AVAILABLE, bounded to `budget`
  // chars so a long library can't blow the context window. Returns '' when none qualify -- byte-identical to a
  // skill-less prompt (the no-op invariant the test pins, mirroring withDossier). Since the on-demand index
  // (composeIndex, below) this is the FALLBACK for a run that cannot call skill.view: the bodies stay inline there.
  function compose(skills, opts) {
    opts = opts || {};
    const budget = opts.budget > 0 ? opts.budget : 12000;
    const offered = live(skills, opts);
    if (!offered.length) return '';
    let used = 0, omitted = 0;
    const parts = [];
    for (const s of offered) {
      const block = '### ' + s.name + (s.description ? ' -- ' + s.description : '') + '\n' + s.body;
      if (parts.length && used + block.length > budget) { omitted++; continue; }
      parts.push(block); used += block.length;
    }
    if (!parts.length) return '';
    const head = '\n\n## INSTALLED SKILLS\n'
      + 'Your Commander enabled these ready-made skill recipes and your workstation supports them. '
      + 'When a task matches one, FOLLOW its recipe instead of improvising.\n\n';
    const tail = omitted ? ('\n\n(' + omitted + ' more enabled skill' + (omitted > 1 ? 's were' : ' was')
      + ' omitted here to keep the prompt lean.)') : '';
    return head + parts.join('\n\n') + tail;
  }

  /* ── ON-DEMAND RECIPES (progressive disclosure, 2026-09-23) ──────────────────────────────────────────────
     Every model call re-sends the system prompt, and the enabled recipe BODIES were its largest block (~12.4K of
     a ~37K default prompt, re-read on every turn of every task). The index below keeps what the model needs to
     CHOOSE a recipe -- its name and its "use when" line -- and the full body is one skill.view call away, the
     pattern the saved-agent-skill index (skills/runtime.js) and reference harnesses already use. Nothing is
     removed: skill.view returns the exact body the inline block used to carry. The caller composes this ONLY
     when skill.view is on the run's wire; everywhere else compose() keeps the bodies inline. */
  const LIBRARY_PREFIX = 'library:';
  // "library:<slug>" is unambiguous by construction: an agent-authored skill name may not contain ':'
  // (skillstore.cleanName) and its id is a slug, so this name can never resolve to the agent's own store.
  function viewName(skill) { return LIBRARY_PREFIX + skill.slug; }
  function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  // A recipe's "use when" line: its frontmatter description; when it has none, the first meaningful sentence of
  // its body (headings skipped, list markers and emphasis stripped). Bounded so one verbose recipe can't bloat the index.
  function summaryOf(skill) {
    let out = oneLine(skill && skill.description);
    if (!out) {
      for (const raw of String((skill && skill.body) || '').split(/\r?\n/)) {
        if (/^\s*#/.test(raw)) continue;   // a heading restates the name; it is not a "use when"
        const line = oneLine(raw.replace(/^\s*(?:[-*+>]|\d+[.)])\s*/, '').replace(/[*_`]+/g, ''));
        if (!/[A-Za-z]/.test(line)) continue;
        const m = line.match(/^(.+?[.!?])(?:\s|$)/);
        out = m ? m[1] : line;
        break;
      }
    }
    return out.length > 220 ? out.slice(0, 217).replace(/\s+\S*$/, '') + '...' : out;
  }
  function composeIndex(skills, opts) {
    opts = opts || {};
    const budget = opts.budget > 0 ? opts.budget : 12000;   // the same ceiling the inline bodies had
    const offered = live(skills, opts);
    if (!offered.length) return '';
    let used = 0, omitted = 0;
    const lines = [];
    for (const s of offered) {
      const sum = summaryOf(s);
      const line = '- ' + oneLine(s.name) + ' [' + viewName(s) + ']' + (sum ? ' -- ' + sum : '');
      if (lines.length && used + line.length > budget) { omitted++; continue; }
      lines.push(line); used += line.length;
    }
    const head = '\n\n## INSTALLED SKILLS\n'
      + 'Your Commander enabled these ready-made skill recipes and your workstation supports them. '
      + 'When a task matches one, FOLLOW its recipe instead of improvising.\n'
      + 'This is an INDEX, not the recipes. Before following one, load its full text with skill.view using the name in '
      + 'brackets (e.g. skill.view {"name": "' + viewName(offered[0]) + '"}); never work from the one-line summary alone.\n\n';
    const tail = omitted ? ('\n\n(' + omitted + ' more enabled skill' + (omitted > 1 ? 's were' : ' was')
      + ' omitted here to keep the prompt lean.)') : '';
    return head + lines.join('\n') + tail;
  }
  // resolve a skill.view name against the recipes a run is OFFERED (pass live(...)). Accepts the index's
  // "library:<slug>" name, a bare slug, or the display name (case-insensitive). A recipe the Commander disabled,
  // or whose gear is not placed, is not in the list -- so it is not served, exactly as it was never injected.
  function find(offered, name) {
    let q = oneLine(name).toLowerCase();
    if (!q) return null;
    if (q.indexOf(LIBRARY_PREFIX) === 0) q = q.slice(LIBRARY_PREFIX.length).trim();
    if (!q) return null;
    const qs = slugify(q);
    for (const s of (offered || [])) if (s && (s.slug === q || s.slug === qs)) return s;
    for (const s of (offered || [])) if (s && oneLine(s.name).toLowerCase() === q) return s;
    return null;
  }
  // what skill.view returns for a recipe: the heading line the inline block used, then the EXACT body.
  function viewText(skill) {
    return '# ' + skill.name + ' [' + viewName(skill) + ']' + (skill.description ? '\n' + skill.description : '') + '\n\n' + skill.body;
  }

  return { parse, parseFrontmatter, normalize, loadDir, isAvailable, isEnabled, isAgentEnabled, catalog, compose, slugify,
    live, composeIndex, find, viewText, viewName, summaryOf, LIBRARY_PREFIX };
});
