/* node test/awaken-full-power-desk.test.js — the terminal awakening's "Full power" is confirmed at the desk, never dropped silently.

   fix-sec2 breakage 3: bin/lib/awaken.js pushed the Overseer as approvalMode 'full' with no raise, and the station's roster
   clamp (index.js handleRoster) quietly kept it at ask. Locks: a Full power pick sends raise + keepFull · a desk challenge
   the station printed to THIS terminal (a station the CLI spawned: st.deskCodeFor) is confirmed with its code and replayed
   once · with no code (a station it only attached to, or the desktop app's) the Overseer is pushed at ask / Trusted Project
   and the person is TOLD where Full power is given · a clamp in a 200 answer is told the same way · Ask for approval sends
   no raise. A fake station; no I/O. */
'use strict';
const A = require('./_assert.js');
const am = require('../bin/lib/app-modules.js');

async function run(o) {
  const M = am.load();
  const rosters = [], replays = [], said = [];
  let save = null, rev = 0, clock = 1800000000000;
  const answer = (json, status) => ({ ok: status == null || status < 400, status: status || 200, json });
  const st = {
    async get(p) {
      if (p === '/api/save?agent=agent') return answer({ save });
      if (p === '/api/providers') return answer({ providers: [{ id: 'openrouter', name: 'OpenRouter', configured: true }] });
      if (p === '/api/models/openrouter') return answer({ models: [{ id: 'm/one' }], default: 'm/one' });
      if (p === '/api/permissions') return answer({ grants: [], masterBypass: false });
      if (p === '/api/autonomy/posture') return answer({ summary: M.Autonomy.fresh() });
      return answer({}, 404);
    },
    async post(p, body, ms, extra) {
      if (p === '/api/save') { save = JSON.parse(JSON.stringify(body)); save._saveRevision = ++rev; return answer({ ok: true, revision: rev }); }
      if (p === '/api/roster') { rosters.push(JSON.parse(JSON.stringify(body))); if (extra) replays.push(extra); return o.roster(body, extra || null); }
      return answer({ ok: true });
    },
    async chat(c) { return /Reply with exactly: OK/.test(String(c.directive || '')) ? { text: 'OK' } : { error: 'the provider returned an error' }; },
    open() { return true; }
  };
  if (o.deskCodeFor) st.deskCodeFor = o.deskCodeFor;
  const opt = re => ({ re });
  const script = [opt(/^Give it a station codename/), opt(/^Composed/), opt(o.full ? /^Full power/ : /^Ask for approval/), opt(/OpenRouter — already connected/), opt(/^m\/one/), opt(/^Let’s talk it through/), opt(/^Code & build/), opt(/^Wait for me/), opt(/^Start with one room/)];
  const io = {
    stage() {}, speaker() {}, note() {}, feed() {}, roster() {},
    async say(segs, op) { for (const s of (typeof segs === 'string' ? [{ text: segs }] : segs)) said.push(((op && op.who) || 'AGENT') + ': ' + s.text); },
    async ask(spec) {
      const pick = script.shift();
      if (!pick) throw new Error('the script ran out at: ' + said[said.length - 1]);
      const choice = (spec.options || []).find(x => pick.re.test(x.label) || pick.re.test(String(x.value)));
      if (!choice) throw new Error('no option ' + pick.re + ' among ' + (spec.options || []).map(x => x.label).join(' | '));
      return Object.assign({}, choice);
    }
  };
  const aw = require('../bin/lib/awaken.js').makeAwakening({ st, io, mods: M, now: () => (clock += 300), sleep: () => new Promise(r => setImmediate(r)) });
  const res = await aw.run({ save: null, resume: false, privateStation: true });
  return { res, rosters, replays, said, save: () => save };
}

const challenge = { id: 'dc-1', mode: 'page', action: 'execution-profile', title: 'StarNet — Give VEGA Full Access', codeWhere: 'terminal' };
const told = said => said.some(l => /^STARNET: full power was not given: it is confirmed at the desk/.test(l) && /give it Full power in the StarNet window/.test(l));

(async () => {
  // 1) a station this terminal spawned: the challenge is confirmed with the code it printed here, and Full power holds
  {
    const asked = [];
    const r = await run({
      full: true,
      deskCodeFor: async id => { asked.push(id); return '123456'; },
      roster: (body, extra) => (body.raise && !(extra && extra.deskProof === 'dc-1' && extra.deskCode === '123456'))
        ? { ok: false, status: 403, json: { ok: false, code: 'desk_confirm_required', error: 'Confirm this change first.', deskConfirm: challenge } }
        : { ok: true, status: 200, json: { ok: true } }
    });
    A.ok(r.res.ok, 'the awakening completes');
    A.ok(r.rosters[0].raise && r.rosters[0].raise[0] === 'agent' && r.rosters[0].keepFull && r.rosters[0].keepFull[0] === 'agent' && r.rosters[0].agents[0].approvalMode === 'full', 'Full power asks for it: raise and keepFull ride the push');
    A.ok(asked[0] === 'dc-1' && r.replays.length >= 1 && r.replays[0].deskProof === 'dc-1' && r.replays[0].deskCode === '123456', 'the challenge is confirmed with the code this terminal was shown, and replayed');
    const ag = r.save().agent;
    A.ok(ag.approvalMode === 'full' && ag.executionProfile === 'this-computer', 'the confirmed Overseer keeps Full power on This Computer');
    A.ok(!told(r.said), 'nothing is said about a drop when nothing dropped');
  }
  // 2) a station it only attached to: no code reaches this terminal — dropped to ask, and the person is told where to give it
  {
    const r = await run({
      full: true,
      roster: body => body.raise
        ? { ok: false, status: 403, json: { ok: false, code: 'desk_confirm_required', error: 'Confirm this change first.', deskConfirm: challenge } }
        : { ok: true, status: 200, json: { ok: true } }
    });
    A.ok(r.res.ok, 'the awakening still completes');
    A.ok(r.replays.length === 0, 'no replay without a code (the check is never guessed past)');
    const after = r.rosters.filter(b => !b.raise);
    A.ok(after.length >= 1 && after.every(b => b.agents[0].approvalMode === 'ask' && b.agents[0].executionProfile === 'trusted-project'), 'the Overseer is pushed at ask / Trusted Project');
    A.ok(told(r.said), 'the person is told Full power was not given, and where it is given');
    const ag = r.save().agent;
    A.ok(ag.approvalMode === 'ask' && ag.executionProfile === 'trusted-project', 'the saved Overseer says what the station holds: ask');
  }
  // 3) the desktop app's station (dialog mode): this terminal cannot confirm it, even with a code book
  {
    let looked = 0;
    const r = await run({
      full: true,
      deskCodeFor: async () => { looked++; return '999999'; },
      roster: body => body.raise
        ? { ok: false, status: 403, json: { ok: false, code: 'desk_only', error: 'This change can only be made in the StarNet window.', deskOnly: true } }
        : { ok: true, status: 200, json: { ok: true } }
    });
    A.ok(r.res.ok && looked === 0 && r.replays.length === 0, 'desk_only: no code is looked up, nothing replayed');
    A.ok(told(r.said) && r.save().agent.approvalMode === 'ask', 'desk_only: dropped to ask, and told');
  }
  // 4) a 200 that clamped it (an older station, or one that answers clamped instead of challenging): told the same way
  {
    const r = await run({
      full: true,
      roster: body => ({ ok: true, status: 200, json: Object.assign({ ok: true }, body.raise ? { clamped: ['agent'] } : {}) })
    });
    A.ok(r.res.ok && told(r.said) && r.save().agent.approvalMode === 'ask', 'a clamped answer is never a silent drop');
  }
  // 5) Ask for approval: no raise is sent, nothing is said
  {
    const r = await run({ full: false, roster: () => ({ ok: true, status: 200, json: { ok: true } }) });
    A.ok(r.res.ok && r.rosters.length >= 1 && r.rosters.every(b => !b.raise && !b.keepFull) && !told(r.said), 'Ask for approval sends no raise');
  }
  A.report('awaken-full-power-desk.test');
})().catch(e => { A.ok(false, 'threw: ' + ((e && e.stack) || e)); A.report('awaken-full-power-desk.test'); });
