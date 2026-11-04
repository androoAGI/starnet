'use strict';
/* node test/saved-floor-callers.census.test.js — EVERY ROUTER CALLER IS CLASSIFIED (invariant every-router-caller-classified).

   When the saved floor is the routing authority (SKYNET_ROUTING_AUTHORITY=saved, sidecar/routing/saved-authority.js), the router can
   say "this floor cannot be proved right now" at ANY question, so every place the host asks one must decide what a held floor means
   there, in the code, where a reviewer sees it:
     admit.<reader>(...)    a dispatch seam (which agent, which dock, which room, which brief, which line): the hold is never swallowed,
                            it ends in the seam's own visible refusal. A new seam is this unless it can be shown to be a read.
     observe.<reader>(...)  a read seam (a limit, a readout, a derived record): a hold degrades it to what a router with no plan
                            answers. This is a REVIEWED set, pinned below: a new observe seam must be added here on purpose.
   The census reads the real source (test/helpers/source.js) with a small tokenizer that skips comments, strings and regex literals:
     1. no sidecar file other than index.js builds a router, and index.js builds exactly one;
     2. in index.js the identifier `router` appears only in its declaration, the seam factory call and the two LEGACY posted-plan
        sites (restoreRoutingPlan, handleRouting's legacy branch: deleted with the posted path, when this test forbids them too);
     3. every other reference is admit.<reader> or observe.<reader>, never a mutator, never a name the router does not have;
     4. the observe set is exactly the pinned one (below), counted by reader;
     5. every router method is a reader or a mutator in saved-seams.js (a new router method must be classified to land);
     6. the visible refusals the admit seams rest on are wired where they must be (the hub, the chain, the routine driver's preflight,
        Run Now, the sample route, the step test, the triggers and the hand-off runner, the line stats and the layout fact).
   RED before the lane: ninety-odd raw router.* sites and no seam module. */
const A = require('./_assert.js');
const { sidecarSourceFiles, sidecarTopLevelFunction } = require('./helpers/source.js');
const { READERS, MUTATORS } = require('../sidecar/routing/saved-seams.js');
const { makeRouter } = require('../sidecar/routing/router.js');

/* ---- a tokenizer, not a parser: comments, string contents and regex literals blanked (line breaks kept); template-literal
   expressions stay code. balanced says the brackets closed, which is how a desynchronised scan shows itself. ---- */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'instanceof', 'yield', 'await']);
function tokenize(text) {
  const out = text.split(''), n = text.length, stack = [];
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  let i = 0, mode = 'code', braces = 0, parens = 0, brackets = 0, prevSig = '', lastWord = null;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (mode === 'template') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { mode = 'code'; i++; prevSig = '`'; lastWord = null; continue; }
      if (c === '$' && d === '{') { stack.push(braces); braces++; mode = 'code'; i += 2; prevSig = '{'; lastWord = null; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (c === '/' && d === '/') { let e = text.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue; }
    if (c === '/' && d === '*') { let e = text.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; blank(i, e); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j); i = j + 1; prevSig = c; lastWord = null; continue;
    }
    if (c === '`') { mode = 'template'; i++; continue; }
    if (c === '/') {
      const regexOk = lastWord ? KEYWORDS.has(lastWord) : (prevSig === '' || REGEX_AFTER.has(prevSig));
      if (regexOk) {
        let j = i + 1, cls = false;
        while (j < n && text[j] !== '\n') {
          if (text[j] === '\\') { j += 2; continue; }
          if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; else if (text[j] === '/' && !cls) break;
          j++;
        }
        blank(i + 1, j); i = j + 1; prevSig = '/'; lastWord = null; continue;
      }
    }
    if (c === '{') braces++;
    else if (c === '}') {
      if (stack.length && braces - 1 === stack[stack.length - 1]) { stack.pop(); braces--; mode = 'template'; i++; continue; }
      braces--;
    } else if (c === '(') parens++; else if (c === ')') parens--; else if (c === '[') brackets++; else if (c === ']') brackets--;
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      lastWord = text.slice(i, j); prevSig = text[j - 1]; i = j; continue;
    }
    if (!/\s/.test(c)) { prevSig = c; lastWord = null; }
    i++;
  }
  return { code: out.join(''), balanced: braces === 0 && parens === 0 && brackets === 0 && mode === 'code' && !stack.length };
}
const lineAt = (text, at) => text.slice(0, at).split('\n').length;

const files = sidecarSourceFiles();
const scanned = new Map();
for (const f of files) {
  const t = tokenize(f.text);
  scanned.set(f.rel, t);
  if (/\b(router|admit|observe|makeRouter)\b/.test(f.text)) A.ok(t.balanced, f.rel + ': the tokenizer ends balanced (a desynchronised scan would hide a call)');
}
const INDEX = 'sidecar/index.js';
const idx = scanned.get(INDEX), idxText = files.find(f => f.rel === INDEX).text;
A.ok(idx && idx.code.length === idxText.length, 'index.js is scanned whole');

// ---- 1. one router, built once, in index.js ----
const builders = files.filter(f => /(^|[^\w$.])makeRouter\s*\(/.test(scanned.get(f.rel).code)).map(f => f.rel).sort();
A.eq(builders, ['sidecar/index.js', 'sidecar/routing/router.js'], 'makeRouter is defined in router.js and called in index.js, and nowhere else');
A.eq((idx.code.match(/(^|[^\w$.])makeRouter\s*\(/g) || []).length, 1, 'index.js builds exactly one router');
for (const f of files) {
  if (f.rel === INDEX || f.rel === 'sidecar/routing/router.js') continue;
  A.ok(!/require\(\s*['"][^'"]*routing\/router(\.js)?['"]\s*\)/.test(f.text) && !/require\(\s*['"]\.\/router(\.js)?['"]\s*\)/.test(f.text), f.rel + ': does not load the router');
}

// ---- 2. the identifier `router` in index.js ----
const raw = [];
for (const m of idx.code.matchAll(/(^|[^\w$.])router(?![\w$])(\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
  const at = m.index + m[1].length;
  raw.push({ line: lineAt(idxText, at), member: m[3] || null, before: idx.code.slice(Math.max(0, at - 8), at), after: idx.code.slice(at, at + 24) });
}
const declared = raw.filter(r => /const\s+$/.test(r.before) && !r.member);
const handedToSeams = raw.filter(r => !r.member && /^router\s*,\s*authority/.test(r.after));
const legacy = raw.filter(r => r.member);
A.eq([declared.length, handedToSeams.length, legacy.length], [1, 1, 2], 'index.js names `router` as: its declaration, the seam factory\'s argument, and the legacy posted-plan calls — and nothing else (' + JSON.stringify(raw.map(r => r.line + ':' + (r.member || r.after))) + ')');
A.eq(legacy.map(r => r.member), ['setPlan', 'setPlan'], 'the only raw router calls left are the two legacy posted-plan installs (restoreRoutingPlan and handleRouting); the lane\'s last step deletes them and this line then says []');
for (const r of legacy) {
  const body = r.line;
  const slice = idxText.split('\n').slice(Math.max(0, body - 40), body).join('\n');
  A.ok(/ROUTING_SAVED/.test(slice), 'legacy router.setPlan at line ' + r.line + ' is behind the saved-authority switch');
}

// ---- 3. every other reference is a seam call on a reader ----
const sites = [];
for (const m of idx.code.matchAll(/(^|[^\w$.])(admit|observe)(?![\w$])(\s*\.\s*([A-Za-z_$][\w$]*)\s*(\()?)?/g)) {
  const at = m.index + m[1].length;
  sites.push({ line: lineAt(idxText, at), receiver: m[2], method: m[4] || null, call: !!m[5], before: idx.code.slice(Math.max(0, at - 14), at), after: idx.code.slice(at, at + 20),
    around: idx.code.slice(Math.max(0, at - 24), at + 40).replace(/\s+/g, ' ') });
}
const squash = t => t.replace(/\s+/g, ' ');
const calls = sites.filter(s => s.method);
// an object key that happens to be spelled admit ({ pool: { admit: () => spendPool.admit(...) } }) is not a seam
const others = sites.filter(s => !s.method && !/^(admit|observe)\s*:/.test(s.after));
A.ok(calls.length >= 70, 'the scan found the seam calls (' + calls.length + ')');
for (const s of calls) {
  A.ok(s.call, 'index.js:' + s.line + ' ' + s.receiver + '.' + s.method + ' is called, not stored');
  A.ok(READERS.includes(s.method), 'index.js:' + s.line + ' ' + s.receiver + '.' + s.method + ' is a router reader (' + READERS.join(',') + ')');
}
A.eq(others.map(s => /const \{ admit, observe, hold: routingHold \}/.test(s.around) ? 'declaration of ' + s.receiver : /lineStageTeam\(observe, /.test(s.around) ? 'lineStageTeam(observe)' : 'STRAY ' + s.receiver + ' @ line ' + s.line).sort(),
  ['declaration of admit', 'declaration of observe', 'lineStageTeam(observe)'],
  'the only other mentions: the seam declaration and the object handed to lineStageTeam (a prompt decoration, so a read)');

// ---- 4. the observe set is pinned, by reader ----
const observed = {};
for (const s of calls) if (s.receiver === 'observe') observed[s.method] = (observed[s.method] || 0) + 1;
A.eq(observed, { lineLimits: 6, intakeReceiptFor: 4, dockOf: 1, lineOfAgent: 1, getPlan: 3, docksOf: 1 },
  'the observe seams, by reader: line limits (the chain, both runners\' day caps, the step test, line stats, the layout budget); the persisted/stored intake receipt (the line runner, the routine store, the hub, the trigger runner); '
  + 'the routine store\'s dock and line reads; the trigger folder roots, line stats and the layout fact\'s legacy branch; the room-scope hasBay probe. Everything else is admit.');
/* INVARIANT: a ROOM is never an observe. A held floor degrades an observe read to "no answer", and for stationFor "no answer" is null, which every
   caller reads as the WHOLE default office (router.js savedStationFor: "NEVER null" — the 2026-08-10 audit #1 class). So a group chat's participant
   and the slash readout ask admit.stationFor: a hold stops the turn in the hold's words, or leaves the readout with no placed objects. */
A.eq(observed.stationFor, undefined, 'no observe.stationFor in the host: a degraded room would be the whole default office, wider than the bay it replaces');
A.ok(calls.filter(s => s.receiver === 'admit' && s.method === 'stationFor').length >= 8, 'every room is an admit.stationFor (hub, routines, Run Now, night shift, workshop, implement build, loops, groups, the slash readout)');
const admitted = calls.filter(s => s.receiver === 'admit');
A.ok(admitted.length >= 50, 'the dispatch seams are admit (' + admitted.length + ')');
for (const must of ['resolveDock', 'stationFor', 'stageBrief', 'chainStepDock', 'chainStep', 'chainNext', 'lineOfAgent', 'lineOriginFor', 'dockOf', 'getPlan', 'entryDockOf'])
  A.ok(admitted.some(s => s.method === must), 'there is an admit.' + must + ' seam');

// ---- 5. every router method is classified ----
const api = Object.keys(makeRouter({})).sort();
A.eq(READERS.concat(MUTATORS).sort(), api, 'saved-seams.js classifies every method the router has: a new router method must be a reader (admit/observe) or a mutator to land');
A.eq(MUTATORS.slice().sort(), ['clearPlan', 'clearStation', 'setPlan', 'setStation'], 'the mutators are the posted-plan installs; neither seam object has them');

// ---- 6. the refusals the admit seams rest on are wired ----
const fn = name => sidecarTopLevelFunction(name);
const hubText = files.find(f => f.rel === 'sidecar/channels/hub.js').text;
A.ok(/resolveAgent\(\{ tag, chatId, text: msg\.text, boundAgentId \}\)[\s\S]{0,200}e\.held !== true[\s\S]{0,200}holdRouting\(/.test(hubText), 'the hub refuses a message whose routing is held (resolveAgent throws, holdRouting replies) before anything else runs');
const holdRouting = hubText.slice(hubText.indexOf('async function holdRouting'), hubText.indexOf('async function holdRouting') + 1500);
A.ok(/lineRunner\.settle\(preJob, \{ refusedSaid: why \}\)/.test(holdRouting) && /deliver\(chatId, '⚠ StarNet did not run this message: ' \+ why/.test(holdRouting), 'holdRouting settles a pre-opened job as the existing refused stop and says it in the chat');
A.ok(/catch \(e\) \{ if \(e && e\.held === true\) \{ await lateHold\(e\); return; \} dockBrief = null; \}/.test(hubText) && /catch \(e\) \{ if \(!e \|\| e\.held !== true\) throw e; await lateHold\(e\); return; \}/.test(hubText),
  'a floor that goes held after the route is refused at the dock\'s brief and at its room too: neither read is swallowed into a run with no brief and the whole default office');
A.ok(/const lateHold = async \(error\) => \{[\s\S]{0,200}jobFacts\.refusedSaid = why;[\s\S]{0,120}settleJob\(\);[\s\S]{0,60}intakeSettled = true;[\s\S]{0,400}deliver\(chatId, '⚠ StarNet did not run this message: ' \+ why/.test(hubText), 'lateHold settles the hub\'s own job as the existing refused stop, tells the settlement once, and says it in the chat');
A.ok(/const heldFloor = routingHold\(\);\s*if \(heldFloor\) throw new Error\(heldFloor\.why\);/.test(idxText), 'a group chat turn on a held floor fails in the hold\'s words before it is admitted');
const chainText = files.find(f => f.rel === 'sidecar/routing/chain.js').text;
A.eq((chainText.match(/LineFire\.lineStop\('refused', \{ why: held\.why \}\)/g) || []).length, 2, 'the chain turns a hold at either next-step read into the refused stop, never into "this stage was the last"');
A.ok(/preflightConfig: \(job, ctx\) => \{\s*const held = routingHold\(\);\s*return held \? \{ ok: false, code: 'routing-held', reason: held\.why \} : cronPreflightConfig\(job, ctx\);/.test(idxText), 'a scheduled fire is blocked in the routine\'s own row, before any spend');
A.ok(/routingHold\(\)/.test(fn('handleCronRun')) && /res\.writeHead\(409/.test(fn('handleCronRun').slice(fn('handleCronRun').indexOf('routingHold()'), fn('handleCronRun').indexOf('routingHold()') + 200)), 'Run Now refuses with a 409 before it starts anything');
for (const name of ['runSampleJob', 'startLineFor']) A.ok(/try \{ plan = admit\.getPlan\(\); \}[\s\S]{0,260}holdOf\(e\)/.test(fn(name)), name + ' refuses in the hold\'s words');
A.ok(/routingHold\(\)[\s\S]{0,120}stepTestJson\(res, \{ ok: false, error: held\.why \}\)/.test(fn('handleStepTestStart')), 'a step test does not start off a held floor');
A.ok(/verb === 'continue' \|\| verb === 'rerun'\) \? routingHold\(\)/.test(fn('handleStepTestId')), 'nor does one run a further stage');
A.eq((idxText.match(/held: \(\) => \{ const held = routingHold\(\); return held \? held\.why : null; \}/g) || []).length, 2, 'the trigger runner and the hand-off runner are told when the floor is held');
A.ok(/routingHold\(\)[\s\S]{0,200}routing: \{ state: 'held'/.test(fn('lineStatsSnapshot')), 'line stats say why they are empty');
A.ok(/state: 'held', status: s\.status, why: heldWhy\(s\.status\)/.test(idxText), 'the layout fact reports a held floor with its reason');
A.ok(/if \(ROUTING_SAVED\) return answerRoutingHint\(res, plan\);/.test(fn('handleRouting')) && !/setPlan/.test(fn('answerRoutingHint')) && !/saveResilient|writeFile/.test(fn('answerRoutingHint')), 'in saved mode POST /api/routing is a receipt: it installs nothing and writes nothing');
A.ok(/if \(ROUTING_SAVED\) \{[^}]*routing\.plan\.json is ignored[^}]*return;\s*\}/.test(fn('restoreRoutingPlan') || idxText.slice(idxText.indexOf('(function restoreRoutingPlan()'), idxText.indexOf('(function restoreRoutingPlan()') + 400)), 'boot ignores routing.plan.json in saved mode (said once, never deleted)');

A.report('saved-floor-callers.census');
