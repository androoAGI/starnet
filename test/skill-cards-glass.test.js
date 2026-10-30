/* test/skill-cards-glass.test.js — an agent's learned and proposed skills wear the library's glass card (old-UI review 10-26 #1).

   Andrew's screenshot (10-26): under the SKILLS library's glass cards, the learned block still drew the June CRT card — ASCII
   * / + / > / v keys, three badge styles side by side, italic half-opacity meta lines, "used 0x - viewed 0x - patched 0x -
   updated 10/13/2026", and a proposal that printed its whole body inline and then a raw JSON blob, inside a solid yellow edge.

   Locks: (1) the learned card renders name, one tag line, summary, plain counts, and a footer with "Read instructions" and a
   drawn pin — no ASCII keys, no hyphen joins, no raw <pre> body; (2) a proposal folds its body and lists its metadata, never
   JSON; (3) the glass sheet gives #sk-agent the library card and readable meta lines. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const src = read('frontend/app/stationui.js');
const between = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('missing ' + a); return src.slice(i, j); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---- (1) a learned card, rendered by the real renderAgentSkills ---- */
const code = between('  const SKILL_SCOPE_LABEL = ', '  function renderAgentSkills(') + between('  function renderAgentSkills(', '  function toggleSkillSharing(');
const host = { innerHTML: '', querySelectorAll: () => [] };
const ctx = vm.createContext({ esc, present: [], CommunityMaps: { live: false }, host, Date, renderSkillCandidates() {}, sfx() {}, notify() {} });
vm.runInContext(code + '\nthis.render = renderAgentSkills;', ctx);
const year = new Date().getFullYear();
ctx.render(host, [
  { id: 'recap', name: 'meeting-recap', summary: 'Recap a meeting.', body: '# Recap\n1. Read it.', state: 'active', scope: 'agent', category: 'productivity', useCount: 1, viewCount: 3, patchCount: 0, updatedAt: new Date(year, 9, 13).getTime(), pinned: true },
  { id: 'old', name: 'old-way', summary: 'Stale.', body: 'x', state: 'stale', scope: 'agent', withheld: true, withheldReason: 'held', updatedAt: new Date(2025, 0, 2).getTime() }
], 'agent', {});
const html = host.innerHTML;
const first = html.slice(0, html.indexOf('data-agent-skill="old"'));
A.ok(/<div class="sk-tags"><span class="sk-tag">PRODUCTIVITY<\/span><span class="sk-tag-sep"> · <\/span><span class="sk-tag on">ACTIVE<\/span><\/div>/.test(first), 'one tag line: category · state, in plain words');
A.ok(/Used 1 time · viewed 3 · patched 0 · updated Oct 13</.test(first), 'counts read as a sentence, dots between, the date as the station prints one');
A.ok(/updated Jan 2, 2025</.test(html), 'an older date carries its year');
A.ok(/<span class="sk-tag held">WITHHELD<\/span>/.test(html), 'WITHHELD joins the same tag line, not a third badge style');
A.ok(/<div class="sk-card-actions"><button class="sk-expand" data-ag-act="expand" aria-expanded="false"[^>]*>Read instructions<\/button>/.test(first), 'the footer opens with "Read instructions", like the library');
A.ok(/<button class="sk-pin on" data-ag-act="pin" aria-pressed="true"[^>]*><svg class="sk-pin-i" viewBox="0 0 16 16"/.test(first) && /<span>Pinned<\/span>/.test(first), 'a pinned skill shows a drawn pin, pressed');
A.ok(!/class="sk-toggle"|>\*<|>\+<|&gt;<\/button>|>v<\/button>/.test(html), 'no ASCII * / + / > / v keys');
A.ok(!/\dx - |  - /.test(html) && !/ - \d+ archived/.test(html), 'no hyphen-joined counts');
A.ok(/<div class="sk-instructions"><pre># Recap/.test(first), 'the instructions sit in the instructions block (safe markdown in the app, plain text here)');
A.ok(/\d+ active · 1 archived|1 active<\/div>|2 active<\/div>/.test(html), 'the summary line joins with a dot');

/* ---- (2) a proposal ---- */
const cand = between('  function renderSkillCandidates(', '  // Skill sharing in plain words');
A.ok(/'<details class="sk-read"><summary>Read the proposed instructions<\/summary>' \+ skillInstructions\(skill\.body\) \+ '<\/details>'/.test(cand), 'a proposal folds its body behind "Read the proposed instructions"');
A.ok(/proposalDetails\(candidate, skill\)/.test(cand) && !/JSON\.stringify\(\{ candidateDigest/.test(cand), 'its metadata is a labelled list, never a JSON blob');
const pctx = vm.createContext({ esc });
vm.runInContext(between('  const proposalDetails = ', '  // a date as the station prints one') + '\nthis.pd = proposalDetails;', pctx);
const list = pctx.pd({ candidateDigest: 'abcdef0123456789', baseDigest: '' }, { category: 'General', requires: ['web', 'files'], packageFiles: [{ path: 'a.md' }, { path: 'b.json' }], absorbedInto: 'Reports' });
A.eq(list, '<details class="sk-meta"><summary>Proposed details</summary><dl class="sk-dl"><dt>Category</dt><dd>General</dd><dt>Needs</dt><dd>web, files</dd><dt>Archives into</dt><dd>Reports</dd><dt>Package files</dt><dd>a.md, b.json</dd><dt>Proposal</dt><dd>abcdef012345</dd></dl></details>',
  'labels in words, empty fields left out, digests short');

/* ---- (3) the sheet ---- */
const glass = read('frontend/css/menu-glass.css');
A.ok(/\.sn-menu :is\(#sk-lib, #sk-agent\) \.sk-card \{[^}]*border-radius: 12px;[^}]*background: var\(--menu-glass\)/.test(glass), 'the learned block shares the library\'s glass card');
A.ok(/\.sn-menu #sk-agent \.sk-attr \{[^}]*font-size: 14px;[^}]*font-style: normal; opacity: 1;/.test(glass), 'meta lines are plain 14px text, not italic whispers');
A.ok(/\.sn-menu #sk-agent \.sk-card:is\(\.want, \.held\) \{ border-color: rgba\(var\(--ph-rgb\), \.22\); \}/.test(glass), 'a proposal or a withheld skill keeps the glass edge (its tag says so)');
A.ok(/\.sn-menu #sk-agent \.sk-pin svg \{[^}]*stroke: currentColor/.test(glass), 'the pin is stroked in the text colour');
A.ok(/const pre = body\.querySelector\('\.sk-instructions'\) \|\| body\.querySelector\('pre'\);/.test(src), 'Edit swaps the rendered instructions block for its editor');

A.report('skill-cards-glass.test');
