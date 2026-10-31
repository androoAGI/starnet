/* node test/comms-tools.test.js — OUTBOUND channel reach (sidecar/tools/builtin/comms.js).

   Locks the capability AND its containment: an agent can message a chat a human already opened with this
   station, and cannot message anything else. The second half is the point — channel.send is the one tool that
   carries content out to a third party under the Commander's own bot identity, so free-form addressing would
   turn any prompt injection into an exfiltration primitive. */
'use strict';
const A = require('./_assert.js');
const { makeCommsTools, MAX_CHUNKS, TEXT_CHARS } = require('../sidecar/tools/builtin/comms.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');

const call = (name, args) => ({ id: 'c1', name, args: args || {}, argsRaw: JSON.stringify(args || {}), parseError: null });

const TARGETS = [
  { target: 'bot1|55501', channel: 'telegram:bot1', chatId: '55501', agentId: 'agent', connected: true },
  { target: '99001', channel: 'discord', chatId: '99001', agentId: 'scribe-1', connected: true },
  { target: '99002', channel: 'discord', chatId: '99002', agentId: 'agent', connected: true },
  { target: 'C0SLACK1', channel: 'slack', chatId: 'C0SLACK1', agentId: 'agent', connected: false }
];

(async () => {
  // ---- channel.targets: the reachable set, with honest live state ------------------------------------
  {
    const t = makeCommsTools({ listTargets: () => TARGETS });
    const body = JSON.parse((await t.targetsTool.run({})).content);
    A.eq(body.targets.length, 4, 'every known chat is listed');
    A.eq(body.reachable, 3, 'only chats on a CONNECTED transport count as reachable');
    A.eq(body.targets[0].channel, 'telegram:bot1', 'a per-bot telegram channel keeps its instance suffix');
    A.ok(!('token' in body.targets[0]) && !('persona' in body.targets[0]), 'a target never leaks chat config or secrets');

    const empty = makeCommsTools({ listTargets: () => [] });
    const out = await empty.targetsTool.run({});
    A.eq(JSON.parse(out.content).targets.length, 0, 'a station nobody has messaged lists nothing');
    A.ok(/nobody has messaged/.test(out.summary), 'and it explains WHY there is nothing, not just "0"');
  }

  // ---- channel.send: the happy path ------------------------------------------------------------------
  {
    const sent = [];
    const emitted = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: (target, text) => { sent.push([target, text]); return Promise.resolve({ ok: true }); },
      emit: (name, payload) => emitted.push([name, payload])
    });
    const out = await t.sendTool.run({ target: 'bot1|55501', text: 'the build is green' }, { runId: 'run-77', agentId: 'agent' });
    A.eq(sent.length, 1, 'one part, one send');
    A.eq(sent[0][0], 'bot1|55501', 'the send carries the TARGET KEY (the host resolves the real chatId)');
    A.eq(sent[0][1], 'the build is green', 'the body goes through intact');
    A.eq(JSON.parse(out.content).ok, true, 'the tool reports success');

    // outbound telemetry on the SHIPPED contract event, so the floor pulses the sending agent's dish
    const d = emitted.find(e => e[0] === 'channel.delivery');
    A.ok(d, 'an agent-initiated send emits channel.delivery like a hub reply does');
    A.eq(d[1].ok, true, 'delivery ok reflects the real outcome');
    A.eq(d[1].chunks, 1, 'chunk count is what actually landed');
    A.eq(d[1].agentId, 'agent', 'the delivery names the agent bound to that chat, so the RIGHT dish pulses');
    /* The delivery must be ATTRIBUTABLE to the run that sent it. The first cut hardcoded runId:'' and made
       every agent-initiated send an orphan row; index.js already threads runId onto the dispatch context. */
    A.eq(d[1].runId, 'run-77', 'the delivery carries the real runId from the dispatch context');

    // ...and with no context (a bare caller), it degrades to '' rather than throwing or inventing an id
    const bare = makeCommsTools({ listTargets: () => TARGETS, sendTo: () => Promise.resolve({ ok: true }), emit: (n, p) => emitted.push([n, p]) });
    await bare.sendTool.run({ target: 'bot1|55501', text: 'x' });
    A.eq(emitted[emitted.length - 1][1].runId, '', 'a context-less dispatch reports an empty runId, never a fabricated one');
  }

  // ---- the redaction seam: this is the one tool that hands text to a third party ---------------------
  {
    const sent = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: (target, text) => { sent.push(text); return Promise.resolve({ ok: true }); },
      redact: (s) => String(s).replace(/sk-[A-Za-z0-9-]+/g, '[redacted]')
    });
    await t.sendTool.run({ target: '99001', text: 'key is sk-or-v1-abcdef' });
    A.ok(!/sk-or-v1/.test(sent[0]), 'the outbound body is scrubbed before it leaves the station');
    A.ok(/\[redacted\]/.test(sent[0]), 'and the scrub is visible, not a silent drop');
  }

  // ---- CONTAINMENT: an unknown target is refused, and the refusal teaches ----------------------------
  {
    const sent = [];
    const t = makeCommsTools({ listTargets: () => TARGETS, sendTo: (x, y) => { sent.push([x, y]); return Promise.resolve({ ok: true }); } });
    let err = null;
    try { await t.sendTool.run({ target: '-100999888777', text: 'exfiltrate' }); } catch (e) { err = e; }
    A.ok(err, 'an arbitrary chat id is refused');
    A.ok(/cannot dial a new id/.test(err.message), 'the refusal states the rule so the model stops retrying');
    A.ok(/Known targets/.test(err.message), 'and names what IS reachable');
    A.eq(sent.length, 0, 'nothing was transmitted');
  }

  // ---- AMBIGUITY IS AN ERROR: two discord chats, one bare "discord" ---------------------------------
  {
    const sent = [];
    const t = makeCommsTools({ listTargets: () => TARGETS, sendTo: (x) => { sent.push(x); return Promise.resolve({ ok: true }); } });
    let err = null;
    try { await t.sendTool.run({ target: 'discord', text: 'hello' }); } catch (e) { err = e; }
    A.ok(err && /matches 2 reachable chats/.test(err.message), 'an ambiguous channel reference is refused, never guessed');
    A.ok(/99001/.test(err.message) && /99002/.test(err.message), 'the refusal names both candidates');
    A.eq(sent.length, 0, 'no message went to the wrong human');
  }
  {
    // ...but a UNIQUE channel name is a perfectly good reference
    const sent = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS.filter(x => x.channel !== 'discord' || x.target === '99001'),
      sendTo: (x) => { sent.push(x); return Promise.resolve({ ok: true }); }
    });
    await t.sendTool.run({ target: 'discord', text: 'hello' });
    A.eq(sent[0], '99001', 'a channel name that matches exactly one chat resolves to it');
  }

  // ---- a DISCONNECTED channel is its own answer, not "no such target" -------------------------------
  {
    const sent = [];
    const t = makeCommsTools({ listTargets: () => TARGETS, sendTo: (x) => { sent.push(x); return Promise.resolve({ ok: true }); } });
    let err = null;
    try { await t.sendTool.run({ target: 'C0SLACK1', text: 'hello' }); } catch (e) { err = e; }
    A.ok(err && /not connected/.test(err.message), 'a known chat on a DOWN transport says "not connected"');
    A.ok(!/not a chat this station can reach/.test(err.message), 'it does NOT claim the chat is unknown — a different fact');
    A.ok(/nothing was sent/.test(err.message), 'and it states plainly that nothing went out');
    A.eq(sent.length, 0, 'nothing was transmitted into a dead channel');
  }

  // ---- chunking: split under the platform ceiling, in order ------------------------------------------
  {
    const sent = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: (target, text) => { sent.push(text); return Promise.resolve({ ok: true }); },
      maxLenFor: () => 100
    });
    const para = ['A'.repeat(80), 'B'.repeat(80), 'C'.repeat(80)].join('\n\n');
    const out = await t.sendTool.run({ target: '99001', text: para });
    A.eq(sent.length, 3, 'the body is split into platform-sized parts');
    A.ok(sent.every(s => s.length <= 100), 'no part exceeds the ceiling: ' + sent.map(s => s.length).join(','));
    A.eq(sent[0], 'A'.repeat(80), 'the split lands on the paragraph boundary, not mid-word');
    A.eq(sent[1], 'B'.repeat(80), 'and parts stay IN ORDER — a shuffled reply is unreadable');
    A.eq(JSON.parse(out.content).parts, 3, 'the tool reports how many chat messages it actually sent');
  }

  // ---- a send is a message, not a file transfer ------------------------------------------------------
  {
    const sent = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: (x, text) => { sent.push(text); return Promise.resolve({ ok: true }); },
      maxLenFor: () => 100
    });
    let err = null;
    try { await t.sendTool.run({ target: '99001', text: 'x'.repeat(100 * (MAX_CHUNKS + 3)) }); } catch (e) { err = e; }
    A.ok(err && /limit /.test(err.message), 'a message that would spray the chat is refused up front');
    A.eq(sent.length, 0, 'and NOTHING is sent — the refusal happens before the first part');
  }

  // ---- the per-call ceiling refuses whole instead of silently clipping a successful send ------------
  {
    const sent = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: (x, text) => { sent.push(text); return Promise.resolve({ ok: true }); }
    });
    let err = null;
    try { await t.sendTool.run({ target: '99001', text: 'x'.repeat(TEXT_CHARS) + 'tail-marker' }); } catch (e) { err = e; }
    A.ok(err && /characters \(limit /.test(err.message), 'an oversized payload is refused with the exact limit');
    A.ok(/nothing was sent/.test(err.message), 'the refusal states that no partial prefix escaped');
    A.eq(sent.length, 0, 'the transport receives ZERO chunks — no silently clipped successful send');
  }

  // ---- PARTIAL DELIVERY IS REPORTED, never rounded up to success ------------------------------------
  {
    const sent = [];
    const emitted = [];
    const t = makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: (target, text) => { sent.push(text); return Promise.resolve(sent.length === 2 ? { ok: false, error: 'rate limited' } : { ok: true }); },
      maxLenFor: () => 100,
      emit: (n, p) => emitted.push([n, p])
    });
    let err = null;
    try { await t.sendTool.run({ target: '99001', text: ['A'.repeat(80), 'B'.repeat(80), 'C'.repeat(80)].join('\n\n') }); } catch (e) { err = e; }
    A.ok(err && /failed after 1 of 3 part/.test(err.message), 'the error says exactly how much landed: ' + (err && err.message));
    A.ok(/rate limited/.test(err.message), 'and carries the transport reason');
    A.eq(sent.length, 2, 'it STOPS at the first failure instead of scattering the rest');
    const d = emitted.find(e => e[0] === 'channel.delivery');
    A.eq(d[1].ok, false, 'the delivery event records the failure');
    A.eq(d[1].chunks, 1, 'and the honest count of parts that landed');
  }

  // ---- a throwing transport cannot take the run down -----------------------------------------------
  {
    const t = makeCommsTools({ listTargets: () => TARGETS, sendTo: () => { throw new Error('socket exploded'); } });
    let err = null;
    try { await t.sendTool.run({ target: '99001', text: 'hi' }); } catch (e) { err = e; }
    A.ok(err && /socket exploded/.test(err.message), 'a throwing send surfaces as an honest tool error');
  }

  // ---- guards -------------------------------------------------------------------------------------
  {
    const t = makeCommsTools({ listTargets: () => TARGETS, sendTo: () => Promise.resolve({ ok: true }) });
    let e1 = null; try { await t.sendTool.run({ target: '99001', text: '   ' }); } catch (e) { e1 = e; }
    A.ok(e1 && /text is required/.test(e1.message), 'an empty message is never sent');
    let e2 = null; try { await t.sendTool.run({ text: 'hi' }); } catch (e) { e2 = e; }
    A.ok(e2 && /target is required/.test(e2.message), 'a missing target is refused');

    const unwired = makeCommsTools({ listTargets: () => TARGETS });
    let e3 = null; try { await unwired.sendTool.run({ target: '99001', text: 'hi' }); } catch (e) { e3 = e; }
    A.ok(e3 && /unavailable/.test(e3.message), 'an unwired host reports unavailable rather than claiming a send');
  }

  /* ---- the gate: channel.send is capability- AND consent-gated ------------------------------------
     This is the enforcement that makes the containment story real. channel.targets sends nothing, but the list is
     the Commander's chats, so a watched run confirms each listing and an unattended run is never offered it;
     channel.send asks every time until the Commander grants it, so an autonomous run cannot quietly message
     people off a stale grant. */
  {
    let sends = 0;
    const reg = makeRegistry();
    makeCommsTools({
      listTargets: () => TARGETS,
      sendTo: () => { sends++; return Promise.resolve({ ok: true }); }
    }).register(reg);
    /* channel.send DECLARES impact external-unknown (quick win 8 review): a real run's dispatch context always carries its
       run authority (index.js dctx.authorize), and on a watched run that authority asks the exact per-call confirmation
       (inputpolicy.js), whose yes covers this one send and skips the standing-grant broker. So the gate is driven here
       the way a run drives it: with a watched run's authority whose confirmation answers `answer`. */
    const { makeRunAuthority } = require('../sidecar/inputpolicy.js');
    let asked = 0;
    const watched = (answer) => makeRunAuthority({ surface: 'interactive', isTask: true, fullAccess: false, confirm: async () => { asked++; return answer; } }).authorize;

    const noGrant = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {}, authorize: watched('once') });
    const deniedCap = await reg.dispatch(call('channel.send', { target: '99001', text: 'hi' }), noGrant);
    A.ok(deniedCap.isError && /capability denied/.test(deniedCap.content), 'channel.send is dark without a placed dish (comms grant)');
    A.eq(sends, 0, 'capability denial sends nothing');

    /* channel.targets DECLARES external-unknown too, the lane it always fell into (B3, release 0.14.2: as impact none
       every unattended, non-owner chat and tainted run holding the DISH could list the Commander's chats). It needs no
       consent grant (requiresConsent false); the run authority is what asks. delegated-command-gap.test locks its
       projection and taint on every lane. */
    const targetsGrant = { agentId: 'agent', room: 'office', hasCompute: true, tools: ['channel.targets'], approvalRules: {} };
    asked = 0;
    const listed = await reg.dispatch(call('channel.targets', {}), makeCapCtx(targetsGrant, { emit: () => {}, authorize: watched('once') }));
    A.ok(!listed.isError && asked === 1 && JSON.parse(listed.content).targets.length === TARGETS.length, 'a watched run lists the chats after one exact confirmation: ' + listed.content);
    asked = 0;
    const refusedList = await reg.dispatch(call('channel.targets', {}), makeCapCtx(targetsGrant, { emit: () => {}, authorize: watched('deny') }));
    A.ok(refusedList.isError && /confirmation was denied/.test(refusedList.content) && asked === 1 && !/99001/.test(refusedList.content), 'a refused confirmation lists nothing: ' + refusedList.content);
    const unattendedList = await reg.dispatch(call('channel.targets', {}),
      makeCapCtx(targetsGrant, { emit: () => {}, authorize: makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: false }).authorize }));
    A.ok(unattendedList.isError && /user-control denied/.test(unattendedList.content) && !/99001/.test(unattendedList.content), 'an unattended ASK run cannot list them: ' + unattendedList.content);
    const bareList = await reg.dispatch(call('channel.targets', {}), makeCapCtx(targetsGrant, { emit: () => {} }));
    A.ok(bareList.isError && /no run authority/.test(bareList.content), 'a dispatch with no run authority lists nothing: ' + bareList.content);

    const grant = { agentId: 'agent', room: 'office', hasCompute: true, tools: ['channel.send'], approvalRules: {} };
    const noAuthority = await reg.dispatch(call('channel.send', { target: '99001', text: 'hi' }), makeCapCtx(grant, { emit: () => {}, consent: async () => ({ allow: true }) }));
    A.ok(noAuthority.isError && /no run authority/.test(noAuthority.content), 'a dispatch with no run authority at all is refused, whatever a consent callback says');
    asked = 0;
    const deniedConsent = await reg.dispatch(call('channel.send', { target: '99001', text: 'hi' }),
      makeCapCtx(grant, { emit: () => {}, authorize: watched('deny') }));
    A.ok(deniedConsent.isError && /confirmation was denied/.test(deniedConsent.content) && asked === 1, 'messaging a real human asks first: ' + deniedConsent.content);
    A.eq(sends, 0, 'a refused confirmation sends nothing');

    asked = 0;
    const always = watched('always');
    const allowed = await reg.dispatch(call('channel.send', { target: '99001', text: 'hi' }),
      makeCapCtx(grant, { emit: () => {}, authorize: always, consent: async () => ({ allow: false, reason: 'the standing-grant broker is never asked' }) }));
    A.ok(!allowed.isError, 'an approved send goes out: ' + allowed.content);
    A.eq(sends, 1, 'and reaches the transport exactly once');
    await reg.dispatch(call('channel.send', { target: '99001', text: 'again' }), makeCapCtx(grant, { emit: () => {}, authorize: always }));
    A.eq(asked, 2, 'an "always" answer covers that one send: the next send asks again');
  }

  A.report('comms-tools');
})().catch(e => { console.log('FAIL: comms-tools threw -- ' + (e && e.stack || e)); process.exit(1); });
