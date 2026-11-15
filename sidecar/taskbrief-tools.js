'use strict';
const Policy = require('./taskbrief-policy.js');
const Context = require('./taskbrief-context.js');
const { swallow } = require('./failopen.js');

// The batch-wide escape hatch the card sends for "use your judgment for the rest". Anchored and exact:
// a deferral that carries a real constraint ("use your judgment for the rest, but keep it short") must
// NOT silently swallow the remaining questions — it falls through as an ordinary answer to this one.
const REST_SKIP = /^\s*use your judgment for the rest\s*[.!]?\s*$/i;

/* THE HELD CALL IS MADE AGAIN (#187, 2026-11-14). The brief gate holds a write/execute call ("nothing ran"), the model settles
   the brief, and the settle's reply used to say only "unlocked". A small local model (qwen3:8b, live wire capture) then took
   that as the work being done: it never re-made the held fs_write + shell_exec and told the Commander "created and executed"
   with no file on disk. The gate records each call it holds (noteHeldCall, from index.js briefHoldFor) and the settle names
   them, so the next step is the call itself, not a summary of work that never ran. Bounded: 6 calls, 300 chars of args each;
   the args are the model's own, sent back to it. Cleared by the settle, so a later settle never repeats them. */
const HELD_MAX = 6, HELD_ARGS_MAX = 300;
function noteHeldCall(state, call) {
  if (!state || !call || !call.name) return;
  let text;
  try { text = JSON.stringify(call.args && typeof call.args === 'object' ? call.args : {}) || '{}'; } catch (_) { text = '{}'; /* cyclic or BigInt args: named without them */ }
  const row = String(call.name).replace(/\./g, '_') + ' ' + (text.length > HELD_ARGS_MAX ? text.slice(0, HELD_ARGS_MAX) + '…' : text);
  const list = Array.isArray(state.held) ? state.held : (state.held = []);
  if (list.indexOf(row) < 0 && list.length < HELD_MAX) list.push(row);
}
// the wire tool name of each held row (its first token), once each: what survives a question on the brief (ops-1115 T3).
// The same key the loop's held ledger uses (loop.js wireKey: dots read as underscores).
const heldKey = (n) => String(n == null ? '' : n).replace(/\./g, '_');
const heldNamesOf = (state) => Array.from(new Set((state && Array.isArray(state.held) ? state.held : []).map(h => heldKey(String(h).split(' ')[0])).filter(Boolean)));
// `kept`: the names an earlier run's question kept on the brief (store.noteHeld), named back without args unless this run
// already holds the same tool with its args.
function heldAgainNote(state, kept) {
  const inRun = heldNamesOf(state);
  const held = state && Array.isArray(state.held) ? state.held.splice(0) : [];
  for (const k of Array.isArray(kept) ? kept : []) { const n = heldKey(k); if (n && inRun.indexOf(n) < 0 && held.indexOf(n) < 0) held.push(n); }
  if (!held.length) return '';
  return '\nNothing has run yet: the call' + (held.length > 1 ? 's' : '') + ' the brief held must be made again now, in this same turn, before you report any result:\n'
    + held.map(h => '- ' + h).join('\n');
}

function registerTaskBriefTools(registry, store, state, deps) {
  const now = () => deps && deps.now ? deps.now() : 0;
  // IN-TURN CLARIFY (2026-07-31, Hermes-parity): on a WATCHED run the host wires a blocking asker —
  // the question renders live, the answer resumes THIS turn, and "which approach?" stops costing the
  // whole run its plan and context. Absent (unattended/channel runs), behavior is byte-identical to
  // before: the question ends the run and the durable brief resumes on the next reply.
  const askCommander = deps && typeof deps.askCommander === 'function' ? deps.askCommander : null;
  registry.register({
    // capability 'taskbrief' marks these as the host's OWN internal controls (inputpolicy SAFE_BUILTIN_CAPS):
    // read-only bookkeeping, zero external effect — never routed through the external-unknown confirmation.
    name: 'brief.ask', scope: 'read', readOnly: true, capability: 'taskbrief', impact: 'none',
    // The clarify wait blocks INSIDE run(), so the default 30s ctx.timeoutMs would kill it mid-question
    // (same shape as browser.login's hour). The wait itself is bounded by the consent waiter's fail-closed
    // timer + one ack extension; this ceiling only has to sit safely above that.
    // Batched asks (up to 3 questions) wait sequentially inside one run() — the ceiling must cover three
    // consent waits (fail-closed timer + one ack extension each), not one.
    timeoutMs: 30 * 60 * 1000,
    description: 'Ask one concrete question and listen. The question is ONE short plain sentence: the options show as tap keys under it, so never list them in it, and background goes in reason. Prefer mode:conversation for discovery: options are optional shortcuts, sample is an optional small draft to react to. Ask about the last real example, a troublesome step, or an exception. After the answer use brief.update to extract everything it established before choosing another question or proceeding. Legacy mode:choice supports bundled independent decisions. Inspect available context first; correct rejected arguments rather than bypassing the task lifecycle in prose.',
    schema: (() => {
      const qProps = {
        // the enum IS the whitelist (taskbrief-policy DIMENSIONS) — live-caught 2026-07-16: without it the
        // model invents dimensions ('dashboard_tech'), burns retries on rejections, then falls back to prose.
        dimension: { type: 'string', enum: Array.from(Policy.DIMENSIONS) },
        question: { type: 'string', description: 'ONE short plain sentence (about 15 words). Never list the options in it: they show as tap keys under it. Background goes in reason.' }, options: { type: 'array', items: { type: 'string' } },
        recommended: { type: 'string' }, reason: { type: 'string' },
        mode:{type:'string',enum:['conversation','choice'],description:'conversation: one open-ended question with optional shortcuts. choice: legacy bounded choices.'},
        sample:{type:'string',description:'Optional short draft/example to react to; not a claim of a created file or completed action.'},
        multiSelect: { type: 'boolean', description: 'true when the options are NOT mutually exclusive and the Commander may pick several (e.g. sources, constraints). The chips then toggle instead of firing.' }
      };
      /* An `also` item takes the same fields, said ONCE (cost audit W1.3): the items repeated every top-level description
         (~540 B on every attended task call). Types, enums and item types stay, so the wire contract is unchanged. */
      const itemProps = {};
      for (const k of Object.keys(qProps)) { const p = Object.assign({}, qProps[k]); delete p.description; itemProps[k] = p; }
      return { type: 'object', required: ['dimension', 'question', 'reason', 'discoverable'], properties: Object.assign({}, qProps, {
        // live-caught 2026-07-16: with no description the model reads 'discoverable' as an open judgment call
        // and stalls; it is an attestation, not a research report.
        discoverable: { type: 'boolean', description: 'Pass false to attest you checked the available context (conversation, task brief, granted files) and the answer is not there. Only false is accepted. Attested once for the whole call.' },
        newBlocker: { type: 'boolean' },
        also: { type: 'array', maxItems: 2, description: 'Up to two MORE material questions (distinct dimensions) asked in the same interruption, each with the fields above, used the same way. Never split related questions across calls.',
          items: { type: 'object', required: ['dimension', 'question', 'options', 'recommended', 'reason'], properties: itemProps } }
      }) };
    })(),
    run: async args => {
      const checked = Policy.validateQuestions(args, state.brief);
      // A rejection is model-facing steering: name the fix and forbid the prose fallback (live-caught
      // 2026-07-16: after rejections the model asked in plain prose and escaped the brief lifecycle).
      if (!checked.ok) {
        // brief_ask is a HIDDEN tool, so a rejection reaches neither the transcript nor telemetry. Left
        // unlogged it was invisible: a model that chronically fails the validator quietly downgrades to the
        // marker fallback (no recommendation at all) and the Commander just stops seeing ★ chips with no
        // way to know why. One warn line makes that rate knowable without surfacing model churn as UI noise.
        try { console.warn('[taskbrief] brief_ask rejected: ' + checked.error); } catch (_) {}
        throw new Error(checked.error + '. Correct the arguments and call brief_ask again — do NOT ask in plain prose; if you cannot satisfy the validator, end your reply with: TASK_QUESTION: <question> || <option A> | <option B> — and put the question ONLY in that marker line (it renders as the question card; never write it out in prose as well).');
      }
      // ASK-WORTHINESS GATE: the Commander has repeatedly answered "use your judgment" in this dimension, so
      // asking again spends one of only two questions on something they have already told us to decide. Refuse
      // and steer to the honest alternative — pick a reversible default and SURFACE it as a correctable
      // assumption in brief_proceed, where the read card makes it visible and steerable.
      let deferred = [];
      try { deferred = typeof store.deferredDimensions === 'function' ? store.deferredDimensions() : []; } catch (_) { deferred = []; }
      const kept = checked.questions.filter(q => deferred.indexOf(q.dimension) < 0);
      const droppedDims = checked.questions.filter(q => deferred.indexOf(q.dimension) >= 0).map(q => q.dimension);
      if (!kept.length) {
        try { console.warn('[taskbrief] brief_ask suppressed: ' + droppedDims.join(', ') + ' habitually deferred'); } catch (_) {}
        throw new Error('the Commander has repeatedly answered "use your judgment" on ' + droppedDims.join(', ')
          + ' decisions — do not ask this. Choose the most sensible reversible default, call brief_proceed, and state that choice as a correctable assumption.');
      }
      if (droppedDims.length) { try { console.warn('[taskbrief] brief_ask trimmed deferred dimension(s): ' + droppedDims.join(', ')); } catch (_) {} }
      // Unattended surfaces have no live round-trip: only ONE question can survive to the durable end-run
      // marker, so a batch there would silently discard the rest. Reject early and steer to the honest shape.
      if (!askCommander && kept.length > 1) {
        throw new Error('this surface cannot collect multiple answers in one turn — re-call brief_ask with ONLY the single most material question and decide the rest with reversible defaults stated in brief_proceed');
      }
      // Rebuild the candidate to exactly the kept questions (call-level fields ride along), so the store
      // validates and persists the same batch that will be asked.
      const candidate = Object.assign({}, kept[0], { discoverable: false, newBlocker: args && args.newBlocker === true, also: kept.slice(1) });
      const saved = await (typeof store.askMany === 'function' ? store.askMany(state.brief.id, candidate, now()) : store.ask(state.brief.id, candidate, now()));
      if (!saved) throw new Error('question was rejected by the Task Brief policy');
      state.brief = saved;
      const asked = saved.questions.slice(-kept.length);   // the freshly stored batch, with durable ids
      if (askCommander) {
        const answers = [];
        for (let i = 0; i < asked.length; i++) {
          const q = asked[i];
          // The PROVABLE suggestion (the Commander's own answered history, with a count) reached only the
          // end-run fallback card. The live card — now the primary path — showed the model's guess alone.
          let grounded = null;
          try { grounded = typeof store.groundedFor === 'function' ? store.groundedFor(q) : null; } catch (_) { grounded = null; }
          let res = null;
          try {
            res = await askCommander({ question: q.text, options: q.options.slice(), recommended: q.recommended || '', reason: q.reason || '',
              mode:q.mode, sample:q.sample, context:state.brief.context,
              multiSelect: q.multiSelect === true, ordinal: i + 1, total: asked.length,
              grounded: grounded ? { options: (grounded.options || []).slice(0, 6), count: Number(grounded.count) || 0 } : null });
          } catch (_) { res = null; }
          if (!(res && res.answered && res.text && typeof store.answerInTurn === 'function')) break;   // walk-away: stop asking, fall back below
          // "use your judgment for the rest" — one tap hands back EVERY remaining decision. Opting out of a
          // 3-question batch used to cost 3 taps, which is the wrong ratio for the person the batch exists
          // to spare. Stored as the plain deferral string so the skip/deferral bookkeeping still sees it.
          const restSkip = REST_SKIP.test(res.text);
          const text = restSkip ? 'use your judgment' : res.text;
          const updated = await store.answerInTurn(state.brief.id, text, now(), q.id);
          if (!updated) break;
          state.brief = updated;
          answers.push({ q, text });
          if (restSkip) {
            let bailed = false;
            for (const rest of asked.slice(i + 1)) {
              const u = await store.answerInTurn(state.brief.id, 'use your judgment', now(), rest.id);
              if (!u) { bailed = true; break; }
              state.brief = u;
              answers.push({ q: rest, text: 'use your judgment' });
            }
            if (bailed) break;
            break;
          }
        }
        if (answers.length === asked.length) {
          const lines = answers.map(a => 'The Commander answered "' + a.text + '" to: ' + a.q.text + (a.q.mode==='conversation' ? '\nAnswer sourceId: '+a.q.id : ''));
          if(asked.some(q=>q.mode==='conversation')) return {content:lines.join('\n')+'\nRead the WHOLE answer, including volunteered constraints, sources, exceptions and corrections. Call brief.update with through='+answers[answers.length-1].q.id+' and a complete revised understanding. Then proceed if the next useful action is clear, show a small draft for feedback, or ask ONE newly useful question. Do not mechanically fill every field.',summary:'conversation answered'};
          return { content: lines.join('\n') + '\nContinue the task with ' + (answers.length > 1 ? 'these decisions' : 'this decision') + ' applied — do not re-ask them.', summary: 'answered in turn' };
        }
        // no live answer (walked away, disconnected, or the store refused a stale write): fall through to
        // the durable end-run question below — the FIRST unanswered question rides the marker and the
        // remaining ones resume from the durable 'clarifying' brief on the next reply.
      }
      const open = (state.brief.questions || []).find(x => !x.answer) || asked[0];
      // the question ends this run and the per-run held list with it: keep the held tool NAMES on the brief (#187)
      const heldNow = heldNamesOf(state);
      if (heldNow.length && typeof store.noteHeld === 'function') {
        await Promise.resolve().then(() => store.noteHeld(state.brief.id, heldNow)).catch(swallow('taskbrief.held.persist'));
      }
      return { content: 'Waiting for the Commander\'s decision.', summary: 'task question ready', control: {
        final: true, reason: 'done', text: 'TASK_QUESTION: ' + open.text + ' || ' + (open.options.length ? open.options.join(' | ') : '[free text]')
      } };
    }
  });
  registry.register({
    name:'brief.update',scope:'read',readOnly:true,capability:'taskbrief',impact:'none',
    description:'Update the task-local working understanding from the whole request and all answers. Replace the snapshot, preserve relevant earlier details, and remove corrected interpretations. Every fact needs a verbatim user quote and sourceId (request or question id). Put assumptions and remaining unknowns separately. This is not long-term memory. Call after each conversational answer before asking again or proceeding.',
    schema:{type:'object',required:['through','facts','nextStep'],properties:{
      through:{type:'string'},facts:{type:'array',items:{type:'object',required:['dimension','text','quote','sourceId'],properties:{
        dimension:{type:'string',enum:Array.from(Policy.DIMENSIONS)},text:{type:'string'},quote:{type:'string'},sourceId:{type:'string'} }}},
      assumptions:{type:'array',items:{type:'string'}},unknowns:{type:'array',items:{type:'string'}},nextStep:{type:'string'}
    }},
    run:async args=>{
      const saved=await store.updateContext(state.brief.id,args,now());
      if(!saved) throw new Error('Task context cannot be updated while waiting or after completion.');
      state.brief=saved;
      // Items whose quote matched none of the Commander's words were kept as labelled assumptions, not refused
      // (taskbrief-context QUOTE ANCHORING). Say so, so the model neither re-sends them nor treats them as quoted.
      const sent=Array.isArray(args && args.assumptions) ? args.assumptions.map(a=>String(a).trim()) : [];
      const demoted=((saved.context && saved.context.assumptions) || []).filter(a=>a.indexOf(Context.UNCONFIRMED)===0 && sent.indexOf(a)<0);
      const note=demoted.length ? '\n'+demoted.length+' item(s) had no matching quote from the Commander and were saved as unconfirmed assumptions instead. That does not block the task: continue (brief.proceed when ready) and state them as assumptions.' : '';
      return {content:'Working understanding saved for this task only.'+note+'\n'+JSON.stringify(saved.context),summary:'task context updated'};
    }
  });
  registry.register({
    name: 'brief.proceed', scope: 'read', readOnly: true, capability: 'taskbrief', impact: 'none',
    // SAME RESPONSE (cost audit W1.2): "immediately before" read as "in a reply of its own" and cost a full request per
    // task; the host runs this first in its batch (TaskBriefPolicy.settleFirst). A material question still goes to brief_ask.
    description: 'Settle the Task Brief and unlock consequential tools. When no material question is left to ask (use brief_ask for one), send it in the SAME response as your first write/execute call, listed first; the host runs it first.',
    schema: { type: 'object', required: ['objective'], properties: {
      objective: { type: 'string' }, deliverable: { type: 'string' }, audience: { type: 'string' }, success: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } }
    } },
    run: async args => {
      const checked = Policy.validateProceed(args); if (!checked.ok) throw new Error(checked.error);
      const kept = state.brief && Array.isArray(state.brief.heldCalls) ? state.brief.heldCalls.slice() : [];   // proceed() clears them
      const saved = await store.proceed(state.brief.id, checked.brief, now());
      if (!saved) throw new Error('Task Brief cannot proceed from its current state. After a conversational answer call brief.update to incorporate it first.');
      state.brief = saved;
      return { content: 'Task Brief settled. Consequential tools are unlocked.' + heldAgainNote(state, kept), summary: 'task brief settled' };
    }
  });
  return ['brief.ask', 'brief.proceed', 'brief.update'];
}

module.exports = { registerTaskBriefTools, noteHeldCall };
