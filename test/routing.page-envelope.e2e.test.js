/* node test/routing.page-envelope.e2e.test.js — THE PAGE'S HINT ENVELOPE AGAINST THE HOST THAT STILL INSTALLS POSTED PLANS
   (lane saved-floor-routing-authority, S4; delete with the posted-plan path when the default flips).

   The page now posts its floor as {version:1, plan, compilerLinks} (frontend/app/world.js, the poster): a hint that the saved floor
   answers. Until SKYNET_ROUTING_AUTHORITY=saved is the default, the sidecar's posted-plan path is still what routes, and it read the
   whole body as the plan: an envelope was a "malformed plan", persisted as a clear, so a page built for the saved floor switched
   routing off on every host that had not flipped. The posted-plan path now installs the plan INSIDE an envelope, exactly as it
   installed the plan the page posted before, and a bare plan body still works for everything that posts one.
     1. the page's envelope (the very JSON of a compiled floor with its links) arms the line: 200 with the plan's hash, the line is listed
     2. what is persisted and restored at boot is the PLAN, never the envelope: a restart re-arms the same line
     3. an envelope of a floor the compiler refuses is the same 422 a bare plan got, with the plan kept as the capability view
     4. an envelope with no plan clears, as an empty post does; a bare plan arms again
   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { lineStation, hintFor, clone } = require('./helpers/saved-floor.js');

(async () => {
  const fx = SidecarFixture.create({ prefix: 'sk-page-envelope-', timeoutMs: 30000, env: { SKYNET_ROUTING_AUTHORITY: '' } });   // the posted-plan host
  const planFile = path.join(fx.workspace, 'routing.plan.json');
  const hint = hintFor(lineStation());   // what the page posts for INBOX > alpha > beta > OUTBOX
  const LINE = hint.plan.lineOfProp.i1;
  A.ok(LINE && Array.isArray(hint.compilerLinks), 'fixture: the envelope names its line and carries the compiler\'s links');
  const persisted = () => JSON.parse(fs.readFileSync(planFile, 'utf8'));
  try {
    await fx.start();
    A.ok(!/routing\.plan\.json is ignored/.test(fx.output()), 'fixture: this host reads posted plans (the saved-floor host says it ignores routing.plan.json)');
    const armed = async () => {
      const r = await fx.json('GET', '/api/routing/lines/stats');
      A.eq(r.status, 200, 'the line stats answer');
      return ((r.body.lines || []).find(x => x.lineId === LINE) || {}).lineId || null;
    };
    A.eq(await armed(), null, 'nothing is armed before the page posts');

    // ---- 1. the envelope arms the line ----
    const r1 = await fx.json('POST', '/api/routing', hint);
    A.eq([r1.status, r1.body.ok, r1.body.hash, r1.body.bays], [200, true, hint.plan.hash, 2], 'the envelope is accepted: its plan is what the host installs (' + r1.text.slice(0, 200) + ')');
    A.eq(await armed(), LINE, 'the line is armed from the plan inside the envelope');

    // ---- 2. the PLAN is what is persisted and what boot restores ----
    const file = persisted() || {};
    A.eq([file.hash, Array.isArray(file.errors), 'compilerLinks' in file, 'version' in file], [hint.plan.hash, true, false, false], 'routing.plan.json holds the plan, not the envelope');
    await fx.restart({ SKYNET_ROUTING_AUTHORITY: '' });
    A.ok(/routing plan restored from disk/.test(fx.output()), 'boot restores the persisted plan');
    A.eq(await armed(), LINE, 'the restart re-arms the same line');

    // ---- 3. a refused floor is refused through the envelope, as it was bare ----
    const loop = hintFor(lineStation({ cyclic: true }));
    const r3 = await fx.json('POST', '/api/routing', loop);
    A.eq([r3.status, r3.body.ok, r3.body.caps], [422, false, true], 'an envelope of a looped floor is a 422 that keeps its capability view (' + r3.text.slice(0, 200) + ')');
    A.ok(Array.isArray(r3.body.codes) && r3.body.codes.length > 0, 'it names the blocker');
    A.eq(await armed(), null, 'and routing is off for it');
    A.eq((persisted() || {}).hash, loop.plan.hash, 'the refused PLAN itself is what is kept');

    // ---- 4. no plan clears; a bare plan still arms ----
    const r4 = await fx.json('POST', '/api/routing', { version: 1, plan: null, compilerLinks: null });
    A.eq([r4.status, r4.body.ok, r4.body.cleared], [200, true, true], 'an envelope with no plan is the clear an empty post was');
    A.eq(persisted(), null, 'and the clear is what is persisted');
    const r5 = await fx.json('POST', '/api/routing', clone(hint.plan));
    A.eq([r5.status, r5.body.ok, r5.body.hash], [200, true, hint.plan.hash], 'a bare plan body still arms, for everything that posts one');
    A.eq(await armed(), LINE, '...and the line is armed again');
  } finally {
    await fx.dispose().catch(() => {});
  }
  A.report('routing.page-envelope.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
