'use strict';
/* node test/saved-floor-callers.census.test.js — EVERY ROUTER CALLER IS CLASSIFIED (invariant every-router-caller-classified).

   The saved floor is the routing authority (sidecar/routing/saved-authority.js), so the router can say "this floor cannot be proved
   right now" at ANY question, and every place the host asks one must decide what a held floor means there, in the code, where a
   reviewer sees it:
     admit.<reader>(...)    a dispatch seam (which agent, which dock, which room, which brief, which line): the hold is never swallowed,
                            it ends in the seam's own visible refusal. A new seam is this unless it can be shown to be a read.
     observe.<reader>(...)  a read seam (a limit, a readout, a derived record): a hold degrades it to what a router with no plan
                            answers. This is a REVIEWED set, pinned below: a new observe seam must be added here on purpose.
   The census reads the real source (test/helpers/source.js) with a small tokenizer that skips comments, strings and regex literals:
     1. no sidecar file other than index.js builds a router, and index.js builds exactly one;
     2. in index.js the identifier `router` appears only in its declaration and the seam factory call: the host never installs, clears
        or sets anything on it (no setPlan, clearPlan, setStation or clearStation anywhere in the host), and the switch that once let
        a posted plan be the authority is gone;
     3. every other reference is admit.<reader> or observe.<reader>, never a mutator, never a name the router does not have;
     4. the observe set is exactly the pinned one (below), counted by reader;
     5. every router method is a reader or a mutator in saved-seams.js (a new router method must be classified to land);
     6. the visible refusals the admit seams rest on are wired where they must be (the hub, the chain, the routine driver's preflight,
        Run Now, the sample route, the step test, the triggers and the hand-off runner, the line stats and the layout fact).
   RED before the lane: ninety-odd raw router.* sites and no seam module; RED before the default flipped: two host setPlan sites and
   the switch. */
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
A.ok(/(^|[^\w$.])makeRouter\(\{ savedProjection: savedAuthority\.projection, savedHost: true \}\)/.test(idx.code),
  'and builds it on the saved authority, in host mode: the posted-plan mode of router.js is for pure-router fixtures, the host never constructs it');
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
const rawCalls = raw.filter(r => r.member);
A.eq([declared.length, handedToSeams.length, rawCalls.length], [1, 1, 0], 'index.js names `router` as: its declaration and the seam factory\'s argument — and nothing else (' + JSON.stringify(raw.map(r => r.line + ':' + (r.member || r.after))) + ')');
A.eq(rawCalls.map(r => r.member), [], 'the host makes no raw router call at all: the two posted-plan installs (restoreRoutingPlan and handleRouting) are deleted');
// the host never installs, clears or sets anything, on the router or by any other name: the saved floor is the only thing that routes
const installers = [...idx.code.matchAll(/(?<![\w$])(setPlan|clearPlan|setStation|clearStation)(?![\w$])/g)].map(m => m[1] + '@' + lineAt(idxText, m.index));
A.eq(installers, [], 'no setPlan, clearPlan, setStation or clearStation anywhere in sidecar/index.js (code, not comments)');
// (EROUTING_SAVED_<STATUS> is the router's typed error code for a held floor, not the switch: the lookbehind keeps it out)
A.eq(files.filter(f => /ROUTING_AUTHORITY|(?<![A-Za-z])ROUTING_SAVED(?![A-Za-z_])/.test(f.text)).map(f => f.rel), [], 'no sidecar file names the switch that made the saved floor optional (SKYNET_ROUTING_AUTHORITY / ROUTING_SAVED): it is deleted, the saved floor always routes');
A.ok(!/\bpostedPlanOf\b|\bROUTING_FILE\b/.test(idx.code), 'and the posted-plan helpers are gone (postedPlanOf, ROUTING_FILE)');

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
A.eq(observed, { lineLimits: 6, intakeReceiptFor: 4, dockOf: 1, lineOfAgent: 1, getPlan: 2, docksOf: 1 },
  'the observe seams, by reader: line limits (the chain, both runners\' day caps, the step test, line stats, the layout budget); the persisted/stored intake receipt (the line runner, the routine store, the hub, the trigger runner); '
  + 'the routine store\'s dock and line reads; the trigger folder roots and line stats; the room-scope hasBay probe. Everything else is admit. (The layout fact reads the authority\'s status, not the router.)');
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
const receipt = tokenize(fn('handleRouting') + '\n' + fn('answerRoutingHint')).code;
A.ok(/answerRoutingHint\(res, hint\)/.test(receipt) && /savedAuthority\.compareHint\(hint\)/.test(receipt), 'POST /api/routing hands whatever it was sent to the saved authority\'s compareHint, and nothing else');
A.ok(!/setPlan|clearPlan|setStation|saveResilient|loadResilient|writeFile|appendFile|rename|unlink|router\./.test(receipt), 'POST /api/routing is a receipt: it installs nothing, reads no file and writes nothing');
const retired = tokenize(idxText.slice(idxText.indexOf('(function ignoreRetiredRoutingPlan()'), idxText.indexOf('(function ignoreRetiredRoutingPlan()') + 500)).code;
A.ok(/routing\.plan\.json is ignored: the saved floor is the routing authority/.test(idxText) && /existsSync/.test(retired) && !/loadResilient|saveResilient|readFile|writeFile|unlink|rename|rm\(/.test(retired.slice(0, retired.indexOf('})();') + 5)),
  'boot only says routing.plan.json is ignored: it never reads, rewrites or deletes it');

// ---- 7. the unattended seams name their room FIRST, and a hold is never read as a failure ----
/* The room is read through awayBuildRoom BEFORE the first thing the build would claim, queue, pick, admit or spend (test/routing.held-floor-away.e2e.test.js
   holds the behavior over a real sidecar; this holds the shape, so a new read of the room inside a run cannot come back). Read inside the run's try, the typed
   hold landed in `threw` and was released as a FAILED build: two refusals parked a queued item that nothing had tried. */
const room = tokenize(fn('awayBuildRoom')).code;
A.ok(/routingHold\(\)[\s\S]{0,80}admit\.stationFor\(agentId\)[\s\S]{0,200}holdOf\(e\)/.test(room), 'awayBuildRoom asks the entry gate, then the room, and reads a hold that lands between the two as a hold');
for (const [name, firsts] of [['runWorkshopShift', ['claimNext(']], ['runImplementBuild', ['workshopStore.queue(', 'claimById(']], ['runNightshiftActShift', ['nightshiftChat(', 'threadsStore.pick(', 'workshopStore.queue(', 'claimNext(']]]) {
  const body = tokenize(fn(name)).code, at = body.indexOf('awayBuildRoom(');
  A.ok(at >= 0 && !/admit\.stationFor/.test(body), name + ': the room comes from awayBuildRoom, and the run itself never asks the router (a hold there was a failed build)');
  A.ok(/station: (room|firstRoom)\.station/.test(body), name + ': the run is handed the room that was read first');
  A.ok(firsts.every(f => body.indexOf(f) < 0 || at < body.indexOf(f)), name + ': the room is read before ' + firsts.join(', ') + ' (it claims, queues, picks and spends nothing on a held floor)');
}
const nightAct = tokenize(fn('runNightshiftActShift')).code;
A.ok(nightAct.split('awayBuildRoom(').length === 3 && nightAct.lastIndexOf('awayBuildRoom(') < nightAct.indexOf('threadsStore.pick('), 'the night-shift act reads the room twice: before its first model call, and again (fresh) before it picks, queues or claims anything');
A.ok(/precheck: \(\{ loop \}\) => loopReviewBusy\(loop\.id\) \? \{ ok: false, reason: 'review in progress' \} : loopReadiness\(loop\)/.test(idxText) && /precheck: loopReadiness\(l\)/.test(fn('loopStateSnapshot')),
  'a standing loop stands down on a held floor in the driver\'s precheck, and the LOOPS window renders the same gate (waiting, never ready)');
A.ok(/function loopReadiness\(loop\) \{\s*const held = routingHold\(\);\s*return held \? \{ ok: false, reason: held\.why \} : loopPrecheck\(loop\);/.test(idxText), 'and says why in the hold\'s own words');
A.ok(/buildsUnattended && workshopOf\(NIGHTSHIFT_AGENT\) && routingHold\(\)\) return \{ ok: false, reason: 'routing-held' \}/.test(fn('nightshiftPrecheck')), 'the night shift declines a beat that would BUILD before the leash is spent');
const driverText = files.find(f => f.rel === 'sidecar/loopjob-driver.js').text;
A.ok(/try \{ station = deps\.stationFor\(loop\.agentId\); \}[\s\S]{0,200}holdOf\(e\)[\s\S]{0,260}return false;[\s\S]{0,80}stationFault = e;/.test(driverText) && driverText.indexOf('deps.stationFor(loop.agentId)') < driverText.indexOf('store.claimFire(')
  && !/deps\.stationFor\(fresh\.agentId\)/.test(driverText), 'the loop driver names the room before it takes the claim and the iteration slot, and stands a hold down');
// what the person reads: an existing panel's line each (the away card, its build-now toast, the Implement card, the morning report), never a raw code
const frontend = f => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app', f), 'utf8');
A.ok(/r === 'routing-held'\) return '· last shift/.test(frontend('stationui.js')) && /p\.reason === 'routing-held'\) notify\(/.test(frontend('stationui.js')), 'the away card and its build-now toast say a held shift in words');
A.ok(/r === 'routing-held'\) return 'the saved floor/.test(frontend('chat.js')), 'the Implement card says a held press in words');
A.ok(/'routing-held': 'the saved floor/.test(frontend('nightreport.js')), 'the morning report says a held night shift in words');

// ---- 8. the step-through test never reads a hold as "no room", "no brief that matters" or "no next step" ----
/* test/routing.saved-seams.test.js sections 9 and 10 hold the behavior (every hop profile, and a session over the real authority); this holds the shape. The test's
   profile once swallowed a hold into a null room, which the run reads as the WHOLE default office (the 2026-08-10 audit #1 class), and its plan reads swallowed
   one into "no answer", which ended a test 'done' after its first stage. */
const lineRunnerText = files.find(f => f.rel === 'sidecar/routing/line-runner.js').text;
const stepText = files.find(f => f.rel === 'sidecar/routing/steptest.js').text;
const stepProfile = lineRunnerText.slice(lineRunnerText.indexOf('function steptest(o)'), lineRunnerText.indexOf('const PROFILES'));
A.ok(/station: \(h\) => o\.station\(h\.agentId, h\.dockId\),/.test(stepProfile) && !/failNote\('steptest\.station'/.test(stepProfile), 'the step-through test asks for its hop\'s room like every other profile: no swallow, so a failed read fails the hop and runOnce is not called');
A.ok(/catch \(e\) \{ if \(holdOf\(e\)\) throw e; failNote\('steptest\.brief', e\); brief = null; \}/.test(stepProfile), 'a hold reading the dock\'s brief ends the hop; any other brief failure still degrades to no brief');
A.ok(/catch \(e\) \{ if \(holdOf\(e\)\) throw e; failNote\('steptest\.plan', e\); return null; \}/.test(stepText), 'a step-test plan read rethrows a hold: it is a refusal to say, never "no answer"');
A.ok(/start: heldVerb\(start\)/.test(stepText) && /continue: heldVerb\(cont\)/.test(stepText), 'a start or a CONTINUE on a held floor is refused in the hold\'s words, before anything moves');
A.ok(/async function drive\(s\) \{\s*try \{ await walk\(s\); \}\s*catch \(e\) \{\s*const held = holdOf\(e\);[\s\S]{0,260}LineFire\.lineStop\('refused', \{ why: held\.why \}\)/.test(stepText), 'a hold mid-walk ends the test stopped, with the chain\'s refused stop and the hold\'s words');

A.report('saved-floor-callers.census');
