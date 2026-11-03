/* node test/markdown-everywhere.test.js — one reading of an answer, everywhere it is shown (live walk 10-14, seams 2/3/11/17).

   The walker ran one line job whose answer was markdown ('## Findings', '- **Item one:**', '`code`') and found it printed raw
   in three places while WORKFLOWS and the Workflow panel drew it rendered. Locked here by EXECUTING the shipped functions
   (sliced with A.fnBody or required as UMD) over the real COMMS renderer built from chat.js:
     #2   DELIVERABLES › TO REVIEW › WHAT CAME BACK is drawn by Chat.renderProse (escape-first) — and so is the library card's
          WHAT CAME BACK below it, once its drawer opens; a fenced block's ⧉ key works outside COMMS
     #3   the COMMS INBOX "prove the line" card quotes the reply as plain words (Deliverables.plainLine), never markdown
     #11  the goal-arc confirm panel's milestones are plain words (no '**', no '`', no '## ' header as a step)
     #17  TO REVIEW's collapsed glance leaves no stray space where `code` was (the rest of #17: walk-consistency-1014.test.js)
   Review round (10-14): a plain multi-line reply keeps its line breaks in every renderProse container outside COMMS (a cascade
   over the real stylesheets); an answer's file links resolve in the RUN's agent + root, never the agent open in COMMS; a cut
   reply's note sits below the answer; a code-only reply is quoted as its code; numbered heading steps stay milestones. */
'use strict';
const A = require('./_assert.js');
let pending = 1;   // async checks still out (each calls finish())
function finish() { if (--pending === 0) A.report(); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const D = require('../frontend/app/deliverables.js');
const REPLY = '## Findings\n\n- **Item one:** the first point, plainly said.\n- **Item two:** a second point with `code`.\n\nDone — that is the answer.';
const PLAIN = 'Findings Item one: the first point, plainly said. Item two: a second point with code. Done — that is the answer.';

/* ---------- the real COMMS renderer, built from chat.js exactly as test/chat-code-copy.test.js does ---------- */
const chatSrc = rd('frontend/app/chat.js');
function extract(name) {
  const m = new RegExp('(  function ' + name + '\\([\\s\\S]*?\\n  \\})').exec(chatSrc);
  A.ok(m, 'chat.js still defines ' + name + '()');
  return m ? m[1] : '';
}
// eslint-disable-next-line no-new-func
const renderMarkdown = new Function('U',
  /  const REL_PATH = [^\n]*;/.exec(chatSrc)[0] + '\n' +
  ['escapeHtml', 'linkify', 'mdInline', 'hostOf', 'linkHostNote', 'appFileRef', 'fileRefLink', 'fileRefImage', 'reportInline', 'renderFence', 'renderMarkdown'].map(extract).join('\n') +
  '\nreturn renderMarkdown;')(require('../frontend/js/util.js'));
// eslint-disable-next-line no-new-func
const renderProse = new Function('renderMarkdown', 'hydrateFileRefs', /const MD_MARKERS = [^;]+;/.exec(chatSrc)[0] + '\n' + extract('renderProse') + '\nreturn renderProse;')(renderMarkdown, () => {});
const Chat = { renderProse };
const el = () => { const cls = new Set(); return { textContent: '', innerHTML: '', classList: { add: c => cls.add(c), has: c => cls.has(c) }, cls }; };
const rendered = n => /<span class="md-h"[^>]*>Findings<\/span>/.test(n.innerHTML) && (n.innerHTML.match(/<li>/g) || []).length === 2
  && /<code class="md-code">code<\/code>/.test(n.innerHTML) && !/\*\*|## |`/.test(n.innerHTML);

/* ---------- a small cascade over the stylesheets index.html loads, in its order: which white-space rule wins on a <div> with
   these classes? Conservative on purpose — any ancestor context, @media block or non-state pseudo-class counts as "could apply",
   so a rule anywhere that could flip a reply container back to `normal` is seen. ---------- */
function cssRules(file, text, out) {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  let i = 0;
  const block = from => { let d = 0; for (let k = from; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) return k; } return s.length; };
  (function parse(end) {
    while (i < end) {
      const open = s.indexOf('{', i), close = s.indexOf('}', i);
      if (open === -1 || open >= end || (close !== -1 && close < open)) { i = close === -1 ? end : close + 1; return; }
      const prelude = s.slice(i, open).trim(), stop = block(open);
      if (/^@(media|supports|layer|container)\b/.test(prelude)) { i = open + 1; parse(stop); i = stop + 1; continue; }
      if (!prelude.startsWith('@')) out.push({ file, sel: prelude, decl: s.slice(open + 1, stop), order: out.length });
      i = stop + 1;
    }
  })(s.length);
}
const splitTop = (str, sepRe) => { const parts = []; let d = 0, cur = ''; for (const c of str) { if (c === '(') d++; if (c === ')') d--; if (!d && sepRe.test(c)) { parts.push(cur); cur = ''; } else cur += c; } parts.push(cur); return parts.map(x => x.trim()).filter(Boolean); };
function compoundMatches(comp, cls) {
  if (/::/.test(comp)) return false;   // a pseudo-element is another box
  const isArgs = [];
  const bare = comp.replace(/:(is|where|not)\(((?:[^()]|\([^()]*\))*)\)/g, (m, kind, args) => { if (kind !== 'not') isArgs.push(splitTop(args, /,/)); return ''; });
  if (/:(hover|focus|focus-visible|focus-within|active|checked|disabled)\b/.test(bare)) return false;   // a state, not the resting look
  const el = /^[a-z][\w-]*/i.exec(bare);
  if (el && el[0] !== 'div') return false;
  if (/#[\w-]+|\[/.test(bare)) return false;   // these containers carry no id/attribute the stylesheets key on
  const need = (bare.match(/\.[\w-]+/g) || []).map(x => x.slice(1));
  if (!need.every(c => cls.includes(c))) return false;
  return isArgs.every(alts => alts.some(a => compoundMatches(a, cls)));
}
function specificity(sel) {
  const t = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/:(is|not)\(/g, '(');
  return [(t.match(/#[\w-]+/g) || []).length, (t.match(/\.[\w-]+|\[|:(?!:)[\w-]+/g) || []).length, (t.replace(/\.[\w-]+|#[\w-]+|:[\w-]+|\[[^\]]*\]/g, ' ').match(/(^|[\s>+~(,])[a-z][\w-]*/gi) || []).length];
}
const CSS_ORDER = (rd('frontend/index.html').match(/href="css\/[^"?]+/g) || []).map(h => 'frontend/' + h.slice(6));
const ALL_RULES = []; for (const f of CSS_ORDER) cssRules(f, rd(f), ALL_RULES);
function cascadeWhiteSpace(cls) {
  let best = null;
  for (const r of ALL_RULES) {
    const m = /(?:^|;)\s*white-space\s*:\s*([^;!]+?)\s*(!important)?\s*(?:;|$)/.exec(r.decl);
    if (!m) continue;
    for (const sel of splitTop(r.sel, /,/)) {
      const comps = splitTop(sel.replace(/\s*[>+~]\s*/g, ' '), /\s/);
      if (!compoundMatches(comps[comps.length - 1], cls)) continue;
      const cand = { value: m[1], imp: !!m[2], spec: specificity(sel), order: r.order, file: r.file, sel };
      const beats = (a, b) => !b || (a.imp !== b.imp ? a.imp : (a.spec.join() !== b.spec.join() ? a.spec.map((x, k) => x - b.spec[k]).find(x => x) > 0 : a.order > b.order));
      if (beats(cand, best)) best = cand;
    }
  }
  return best;
}
A.ok(CSS_ORDER.length > 20 && ALL_RULES.length > 1000, 'the cascade reads every stylesheet index.html loads (' + CSS_ORDER.length + ' files, ' + ALL_RULES.length + ' rules)');
A.eq(cascadeWhiteSpace(['cmsg', 'body']).value, 'pre-wrap', 'cascade sanity: COMMS’ reply body is pre-wrap');

/* ---------- #2 TO REVIEW › WHAT CAME BACK ---------- */
{
  const ob = rd('frontend/app/windows/outbox.js');
  const answerInto = A.fnBody(ob, '  function answerInto(out, text, files)');
  A.ok(answerInto.length > 20 && answerInto.length < 2000, 'outbox.js has answerInto (one reading of an answer)');
  const run = globals => vm.runInContext(answerInto + '\nanswerInto;', vm.createContext(Object.assign({}, globals)));
  const out = el();
  run({ Chat })(out, REPLY);
  A.ok(rendered(out), 'WHAT CAME BACK draws the heading, the two bullets and the code span — no raw ** / ## / `: ' + out.innerHTML.slice(0, 200));
  A.ok(out.cls.has('wf-md'), 'on the panel scale COMMS prose uses elsewhere (wf-md)');
  const bad = el();
  run({ Chat })(bad, '<img src=x onerror=alert(1)>\n**bold** [x](javascript:alert(1))');
  A.ok(/&lt;img src=x onerror=alert\(1\)&gt;/.test(bad.innerHTML) && !/<img|href="javascript/i.test(bad.innerHTML), 'a reply’s markup never runs (escape-first): ' + bad.innerHTML);
  const bare = el();
  run({})(bare, REPLY);
  A.eq([bare.textContent, bare.innerHTML], [REPLY, ''], 'where COMMS’ renderer is not loaded the answer is plain text, never innerHTML');
  const build = A.fnBody(ob, '  function buildOutbox(body)');
  A.ok(/answerInto\(out, /.test(build) && !/out\.textContent = lastReply/.test(build), 'readResult draws the reply through answerInto');

  /* WHERE ITS FILES LIVE (review 10-14): with no refs, renderProse resolves a reply's relative file link / image against the agent
     open in COMMS — a NOVA run's '[report](out/report.md)' would open CYPHER's file. The run's own refs ride in instead. */
  const seen = [];
  run({ Chat: { renderProse: (n, t, o) => seen.push(o) } })(el(), 'see [report](out/report.md)', 'REFS');
  A.eq(seen, [{ files: 'REFS' }], 'answerInto hands renderProse the run’s file refs');
  const refsArgs = [];
  const runFileRefs = vm.runInContext(A.fnBody(ob, '  function runFileRefs(agentId, projectRoot)') + '\nrunFileRefs;',
    vm.createContext({ String, Chat: { workspaceFileRefs: (...a) => { refsArgs.push(a); return 'R'; } } }));
  A.eq([runFileRefs('nova', 'C:/proj'), runFileRefs('nova', ''), runFileRefs('', null)], ['R', 'R', 'R'], 'runFileRefs builds COMMS’ own refs');
  A.eq(refsArgs, [['nova', null, 'C:/proj'], ['nova', null, undefined], ['agent', null, undefined]], 'for the RUN’s agent at the run’s root (none = its own workspace) — never left to the COMMS agent');
  // …through the REAL workspaceFileRefs: the link is wired to the run's agent, not attachAgentId() (the agent open in COMMS)
  const wired = [];
  const wfr = vm.runInContext('let fileRefScope = 0;\n' + extract('workspaceFileRefs') + '\nworkspaceFileRefs;', vm.createContext({ String,
    attachAgentId: () => 'cypher', wireFileOpen: (a, p, aid, root) => wired.push([p, aid, root]), cachedBlob: (k, load) => k, imageBlobUrl: () => '', fileUrl: () => '' }));
  const novaRefs = wfr('nova', null, 'C:/proj');
  novaRefs.wire({}, 'out/report.md');
  A.eq(wired, [['out/report.md', 'nova', 'C:/proj']], 'a .md file link in a NOVA run opens NOVA’s file at that run’s root (COMMS showed CYPHER)');
  A.ok(/\|nova\|C:\/proj\|out\/c\.png$/.test(novaRefs.image('out/c.png')), 'an image thumbnail reads from the same agent + root');
  const rp = el();
  renderProse(rp, 'see [report](out/report.md)', { files: novaRefs });
  A.ok(rp.__fileRefs === novaRefs && /class="md-file"/.test(rp.innerHTML), 'renderProse keeps the refs on the body it hydrates (bodyEl.__fileRefs)');
  A.ok(/const bodyRefs = bodyEl\.__fileRefs \|\| /.test(extract('hydrateFileRefs')), 'hydrateFileRefs resolves through the refs the body carries');

  /* THE APP'S OWN FILE ADDRESS (user report 10-20): image_generate hands the agent '/api/file?agent=&path=', the agent pasted it
     into ![…](…), and the reply showed a bare label — no picture, asked twice. The address reads back into the same seam. */
  const own = renderMarkdown('![Floral moose — four-stage comparison](/api/file?agent=custom-etsy-designer-androo&path=previews%2Fv3-floral-moose-four-way.jpg)');
  A.ok(/<span class="md-img" data-md-path="previews\/v3-floral-moose-four-way\.jpg" data-md-alt="Floral moose — four-stage comparison" data-md-agent="custom-etsy-designer-androo">/.test(own),
    'an image at the app’s own /api/file address becomes the picture, for the agent and path it names');
  A.ok(/data-md-project="C:\\Proj"/.test(renderMarkdown('![b](/api/file?agent=nova&amp;path=out%2Fb.png&amp;project=C%3A%5CProj)')), 'its project rides along (an &amp;-escaped address too)');
  A.ok(/<a class="md-file" href="#" data-md-path="out\/r\.html" data-md-agent="nova">report<\/a>/.test(renderMarkdown('[report](/api/file?agent=nova&path=out%2Fr.html)')), 'a link to it opens the file');
  // a LINK to a picture is the picture too (second report 10-20: the agent linked its slide JPGs, the user saw only links)
  A.ok(/<span class="md-img" data-md-path="slides\/slide-1\.jpg" data-md-alt="Slide 1">/.test(renderMarkdown('- [Slide 1](slides/slide-1.jpg)')), 'a relative link to a .jpg shows the picture');
  A.ok(/<span class="md-img" data-md-path="previews\/b\.webp" data-md-alt="Board" data-md-agent="nova">/.test(renderMarkdown('[Board](/api/file?agent=nova&path=previews%2Fb.webp)')), 'an app-address link to an image shows the picture');
  A.ok(/<a class="md-file" href="#" data-md-path="out\/notes\.md">/.test(renderMarkdown('[notes](out/notes.md)')) && /<a href="https:\/\/x\.com\/a\.png"/.test(renderMarkdown('[web](https://x.com/a.png)')),
    'a non-image file stays a file link; a web image stays a web link');
  // …and the agent is told how: every typed COMMS turn says ![caption](path) shows the picture (a spoken turn keeps the voice rules alone)
  A.ok(/\+ \(willSpeak \? '' : ' To show the Commander an image file[^']*!\[short caption\]\(path\)/.test(chatSrc), 'a typed COMMS turn tells the agent how to show an image');
  for (const bad of ['/api/file?agent=nova&path=..%2F..%2Fsecret.png', '/api/file?agent=nova&path=%2Fetc%2Fx.png', '/api/file?agent=a%22b&path=x.png', '/api/file?path=x.png', '/api/files?agent=nova&path=x.png'])
    A.ok(!/md-img/.test(renderMarkdown('![x](' + bad + ')')), 'an escaping, absolute, agentless or foreign address stays a label: ' + bad);
  A.ok(/data-md-agent/.test(extract('hydrateFileRefs')) && /workspaceFileRefs\(n\.getAttribute\('data-md-agent'\)/.test(extract('hydrateFileRefs')), 'hydrateFileRefs resolves such a ref in the agent it names');
  // the run's root comes off its own run row (/api/runs — the record ReturnStore.openWork reads), read beside the transcript
  const gets = [];
  const runRecord = vm.runInContext(A.fnBody(ob, '  function runRecord(rw)') + '\nrunRecord;', vm.createContext({ Promise, encodeURIComponent,
    Harness: { api: { get: async u => { gets.push(u); if (/runId=boom/.test(u)) throw new Error('down'); return { runs: [{ runId: 'other' }, { runId: 'r1', projectRoot: 'C:/proj' }] }; } } } }));
  pending++;
  Promise.all([runRecord({ runId: 'r1', agentId: 'nova' }), runRecord({ runId: 'boom', agentId: 'nova' }), runRecord({ agentId: 'nova' })]).then(([hit, down, none]) => {
    A.eq([hit && hit.projectRoot, down, none], ['C:/proj', null, null], 'runRecord: the run’s own row; unreachable or no run id = null (its agent’s workspace)');
    A.eq(gets[0], '/api/runs?agent=nova&runId=r1', 'runRecord reads exactly this run of this agent');
    finish();
  });
  A.ok(/const runRec = runRecord\(rw\);/.test(build) && /const rec = await runRec;\s*answerInto\(out, lastReply\.slice\(0, ANSWER_MAX\), runFileRefs\(rw\.agentId, rec && rec\.projectRoot\)\);\s*answerCut\(out, lastReply\);/.test(build),
    'readResult draws the answer with the run’s refs (agent + its run row’s root), its cut note below it');

  /* a cut reply says so BELOW the answer (review 10-14): appended inside the text, a cut landing in a fenced block drew the note
     as code and its ⧉ key copied it */
  const appended = [];
  const answerCut = vm.runInContext('const ANSWER_MAX = 4000;\n' + A.fnBody(ob, '  function answerCut(out, text)') + '\nanswerCut;', vm.createContext({ String,
    document: { createElement: t => ({ tag: t, className: '', textContent: '' }) } }));
  const host = { appendChild: n => appended.push(n) };
  answerCut(host, 'x'.repeat(4000));
  answerCut(host, '```\n' + 'x'.repeat(4100));
  A.eq(appended.map(n => [n.tag, n.className, n.textContent]), [['div', 'ob-cut', '… output truncated — ↗ OPEN SESSION opens the conversation.']], 'only a cut reply gets the note, as its own element after the answer');
  A.ok(!/output truncated/.test(answerInto), 'the note never rides inside the rendered text');
  A.ok(/\.ob-cut \{[^}]*color: var\(--ph-dim\)/.test(rd('frontend/css/app.css')) && !/\.ob-cut \{[^}]*font-size/.test(rd('frontend/css/app.css')), 'the note reads dim at the answer’s own size (never shrunk)');
  /* a PLAIN reply with single line breaks takes renderProse's textContent fast path (no marker, no link) — its lines survive only
     while the container stays pre-wrap, as COMMS' .cmsg .body is (review 10-14: TO REVIEW + the library ran it into one line) */
  const LETTER = 'Dear team,\nThe build passed.\nShip it tonight.';
  const letter = el();
  run({ Chat })(letter, LETTER);
  A.eq([letter.textContent, letter.innerHTML], [LETTER, ''], 'a plain multi-line reply is drawn as its own text (the fast path)');
  for (const [cls, where] of [[['ob-out', 'wf-md'], 'TO REVIEW'], [['dlv-said', 'md', 'wf-md'], 'the library drawer'],
    [['wf-io', 'wf-md'], 'a Workflow panel / WORKFLOWS step reply'], [['wf-io', 'out', 'wfw-out', 'wf-md'], 'the WORKFLOWS result']]) {
    const won = cascadeWhiteSpace(cls);
    A.eq(won && won.value, 'pre-wrap', where + ' keeps a plain reply’s line breaks (winning white-space rule: ' + (won ? won.file + ' ' + won.sel : 'none') + ')');
  }
  // ...and pre-wrap is safe for rendered markdown: renderMarkdown joins its blocks with no whitespace between the tags
  const blocks = renderMarkdown('## H\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n> q\n\npara');
  A.ok(!/>\s+</.test(blocks), 'no whitespace text between rendered blocks (nothing for pre-wrap to show): ' + blocks.slice(0, 160));

  /* the collapsed glance (#17): the library's one plain line — no '## ', no list dashes, no stray space where `code` was */
  const plain = A.fnBody(ob, '  function plain(s)');
  A.ok(plain.length > 20 && plain.length < 1000, 'outbox.js has plain(s)');
  const glance = vm.runInContext(plain + '\nplain;', vm.createContext({ Deliverables: D, String }));
  A.eq(glance(REPLY), PLAIN, 'the TO REVIEW glance reads as words: “…with code.” (not “with code .”)');
  A.ok(!/const plain = s =>/.test(build), 'no second markdown stripper inside buildOutbox');
}

/* ---------- #2 the library card's WHAT CAME BACK (same window, same renderer) ---------- */
{
  const dl = rd('frontend/app/deliverables.js');
  const proseSaid = A.fnBody(dl, '    function proseSaid(more, r)');
  A.ok(proseSaid.length > 20 && proseSaid.length < 2000, 'deliverables.js has proseSaid');
  const said = el(); said.__prose = false;
  const more = { querySelector: s => (s === '.dlv-said' ? said : null) };
  const fn = vm.runInContext(proseSaid + '\nproseSaid;', vm.createContext({ Chat }));
  fn(more, { run: { deliveryText: REPLY } });
  A.ok(rendered(said) && said.cls.has('wf-md'), 'the library drawer’s WHAT CAME BACK is drawn by the same renderer as TO REVIEW');
  said.innerHTML = 'kept'; fn(more, { run: { deliveryText: REPLY } });
  A.eq(said.innerHTML, 'kept', 'drawn once per drawer');
  // its file links resolve where THIS run put them: the row's agent, at its run record's root (review 10-14)
  const dArgs = [], dOpts = [];
  const fn2 = vm.runInContext(proseSaid + '\nproseSaid;', vm.createContext({ String,
    Chat: { renderProse: (n, t, o) => dOpts.push(o), workspaceFileRefs: (...a) => { dArgs.push(a); return 'REFS' + dArgs.length; } } }));
  const s1 = el(), s2 = el();
  fn2({ querySelector: () => s1 }, { agentId: 'nova', run: { deliveryText: 'see [r](out/r.md)', projectRoot: 'C:/proj' } });
  fn2({ querySelector: () => s2 }, { agentId: '', run: { deliveryText: 'see [r](out/r.md)', projectRoot: '' } });
  A.eq([dArgs, dOpts], [[['nova', null, 'C:/proj'], ['agent', null, undefined]], [{ files: 'REFS1' }, { files: 'REFS2' }]],
    'the library drawer’s answer links open in the run’s own agent + root, never the agent open in COMMS');
  // the root is the RUN's own (sidecar factsOf), not the project it is filed under — a delegated worker wrote in its own workspace
  const { makeProvenanceIndex } = require('../sidecar/deliverable-provenance.js');
  const prov = makeProvenanceIndex([{ runId: 'lead', agentId: 'nova', projectRoot: 'C:/proj', deliveryText: 'x', streamId: 's' },
    { runId: 'w1', agentId: 'cypher', parentRunId: 'lead', projectRoot: '' }], { isInternal: () => false });
  A.eq([prov.factsOf('lead').projectRoot, prov.factsOf('w1').projectRoot, prov.projectOf('w1')], ['C:/proj', '', 'C:/proj'],
    'factsOf carries the run’s own root (a worker filed under its lead’s project still resolves in its own workspace)');
  const toggle = A.fnBody(dl, '    function toggleCard(headBtn)');
  A.ok(/proseSaid\(more, rows\[Number\(card\.dataset\.i\)\]\)/.test(toggle), 'opening a library drawer draws its answer');
  // the ⧉ key of a fenced block drawn outside COMMS copies that block (one document-level handler in chat.js) — executed
  const wire = A.fnBody(chatSrc, "    if (typeof document !== 'undefined' && !document.__proseCopyWired)");
  A.ok(wire.length > 40 && wire.length < 2000, 'chat.js wires one document-level copy handler for .wf-md code blocks');
  const handlers = [], copied = [], shown = [];
  const ctx = vm.createContext({ document: { addEventListener: (t, fn) => { if (t === 'click') handlers.push(fn); } },
    copyText: t => { copied.push(t); return Promise.resolve(true); }, showCopyResult: (b, ok) => shown.push([b.id, ok]) });
  vm.runInContext(wire, ctx); vm.runInContext(wire, ctx);
  A.eq(handlers.length, 1, 'wired once, however often COMMS re-inits');
  const pre = { textContent: 'npm run dev' }, wrapEl = { querySelector: s => (s === '.md-pre' ? pre : null) };
  const key = { id: 'k', closest: s => (s === '.md-pre-wrap' ? wrapEl : null) };
  handlers[0]({ target: { closest: s => (s === '.wf-md .md-copy' ? key : null) } });
  handlers[0]({ target: { closest: () => null } });
  Promise.resolve().then(() => {
    A.eq([copied, shown], [['npm run dev'], [['k', true]]], 'the ⧉ key copies exactly its own block and confirms; any other click is ignored');
    finish();
  });
  pending++;
  const wfcss = rd('frontend/css/workflow-panel.css');
  A.ok(/\.wf-md \.md-pre \{[^}]*white-space: pre;/.test(wfcss) && /\.wf-md \.md-copy \{[^}]*position: absolute;/.test(wfcss) && /\.wf-md \.md-table th, \.wf-md \.md-table td/.test(wfcss), 'code blocks keep their lines, the copy key sits on the block, tables are ruled (wf-md)');
  A.ok(/\.wf-md \.md-code \{ font-family: inherit;/.test(wfcss), 'a code span keeps the station face (live: it fell back to the browser monospace, bigger than its line)');
  A.ok(/\.wf-md \.md-i \{ font-style: italic; \}/.test(wfcss), 'an *italic* the one renderer draws outside COMMS slants there too (COMMS: .cmsg .body .md-i)');
}

/* ---------- #3 the COMMS INBOX card's quote ---------- */
{
  const pq = A.fnBody(chatSrc, '  function plainQuote(raw, max)');
  A.ok(pq.length > 20 && pq.length < 1000, 'chat.js has plainQuote');
  const plainQuote = vm.runInContext(pq + '\nplainQuote;', vm.createContext({ Deliverables: D, String }));
  A.eq(plainQuote(REPLY, 220), '“' + PLAIN + '”', 'the delivered card quotes the reply as plain words');
  A.eq(plainQuote('**' + 'x'.repeat(300) + '**', 220), '“' + 'x'.repeat(220) + '…”', 'a long reply is cut with an ellipsis');
  A.eq(plainQuote('', 220), '', 'no reply, no quote');
  A.eq(plainQuote('```js\nconst a = 1;\nnpm run dev\n```', 220), '“const a = 1; npm run dev”', 'a reply that is only code is quoted as that code (the not-clean card says “the reply below says why”)');
  const card = A.fnBody(chatSrc, '  function sampleCard(opts)');
  const pick = /const said = [^\n]+\n\s*const reply = [^\n]+/.exec(card);
  A.ok(pick && /plainQuote\(said, 220\)/.test(pick[0]), 'the INBOX card quotes through plainQuote, picked in one place');
  /* live 10-14: a 5.5k answer reached the sample channel in two chunks and the card quoted the LAST one ('“All done.”') */
  const quoteOf = (j, clean) => vm.runInContext((pick ? pick[0] : '') + '\nreply;', vm.createContext({ j, clean, plainQuote }));
  A.eq(quoteOf({ replies: ['The report is in [the report](out/r.md).\n\n```\nx = 1\n```', '```\ny = 2\n```\n\nAll done.'] }, true), '“The report is in the report. All done.”',
    'a clean job is quoted from its opening words, across the chunks the channel split it into');
  A.eq(quoteOf({ replies: ['half an answer', '⚠ the model refused: the key is out of credit'] }, false), '“⚠ the model refused: the key is out of credit”',
    'a job that did not finish clean is quoted by its last word — the reason the card promises');
  A.eq(quoteOf({ replies: [] }, true), '', 'no replies, no quote');
}

/* ---------- #17 the one plain line itself ---------- */
{
  A.eq(D.plainLine(REPLY), PLAIN, 'plainLine: headings, list dashes, bold and code marks drop; words stay');
  A.eq(D.plainLine('Run this:\n```js\nconst a = 1;\n```\nthen\n\n| a | b |\n|---|:---:|\n| 1 | 2 |\n\n---\nend'), 'Run this: then a b 1 2 end', 'plainLine: a fenced block, a table’s rule row and pipes, a --- rule drop');
  A.eq(D.plainLine('The report is in [the report](out/report.md) and the chart is ![chart](out/c.png).'), 'The report is in the report and the chart is chart.', 'plainLine: an image keeps its words, its “!” drops (live: “the chart is !chart”)');
  A.eq(D.plainLine('```js\nconst a = 1;\n```'), 'const a = 1;', 'plainLine: a reply that is only code reads as its code');
  A.eq(D.plainLine('**TEASER 1:** Your _agents_ never sleep. ## Subject - [Read more](https://x.test) and `code`'), 'TEASER 1: Your agents never sleep. Subject - Read more and code', 'a server-folded one-line summary still reads as before');
}

/* ---------- #11 the goal-arc milestones ---------- */
{
  const G = require('../frontend/app/goals.js');
  const reply = '## Launch roadmap for the harness\n1. **Ship** the `cli` MVP to ten users\n2. Write the **launch** post for [HN](https://news.ycombinator.com)\n3. Collect feedback from `beta` testers';
  A.eq(G.parseDecomposition(reply, { plain: D.plainLine }), ['Ship the cli MVP to ten users', 'Write the launch post for HN', 'Collect feedback from beta testers'],
    'milestones are plain words, and a markdown header is not a step');
  A.eq(G.parseDecomposition('1. Set up the runtime\n2. Wire the event bus\n3. Build the first agent loop'), ['Set up the runtime', 'Wire the event bus', 'Build the first agent loop'], 'a plain numbered reply parses as before');
  // review 10-14: steps written AS headings stay steps (only a bare header drops), and a leading comparison is kept
  A.eq(G.parseDecomposition('## The roadmap\n### 1. Ship the **CLI** MVP\n### 2. Write the launch post for HN\n### 3. Collect feedback from beta testers', { plain: D.plainLine }),
    ['Ship the CLI MVP', 'Write the launch post for HN', 'Collect feedback from beta testers'], 'numbered headings are the steps; the bare “## The roadmap” header is not');
  A.eq(G.parseDecomposition('## Step 1: Ship the CLI MVP to users\n## Step 2: Write the launch post\n## Step 3: Collect beta feedback', { plain: D.plainLine }),
    ['Step 1: Ship the CLI MVP to users', 'Step 2: Write the launch post', 'Step 3: Collect beta feedback'], '“## Step N:” headings are steps too');
  A.eq(G.parseDecomposition('1. > 100 paying users on the plan\n2. >= $5k monthly revenue from it\n3. Collect feedback from beta testers', { plain: D.plainLine }),
    ['> 100 paying users on the plan', '>= $5k monthly revenue from it', 'Collect feedback from beta testers'], 'a milestone opening on a comparison keeps its “>” (it is not a quote mark)');
  // the live wiring: GoalStore hands the parser the library's plain line
  const mem = {};
  global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  global.Goals = G; global.Deliverables = D;
  global.DossierStore = { beliefs: dim => (dim === 'goals' ? [{ id: 'cd_9', text: 'launch the harness to real users' }] : []) };
  global.fetch = () => Promise.resolve({ ok: true });
  global.Harness = { chat: async () => ({ text: reply, error: false }) };
  const { GoalStore } = require('../frontend/app/goalstore.js');
  GoalStore.init({ now: () => 1000, getSystem: () => '' });
  GoalStore.proposeDecomposition().then(p => {
    A.eq(p && p.texts, ['Ship the cli MVP to ten users', 'Write the launch post for HN', 'Collect feedback from beta testers'], 'the confirm panel is offered plain milestones');
    finish();
  }, e => { A.ok(false, 'proposeDecomposition threw: ' + (e && e.message)); finish(); });
}

