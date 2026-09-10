/* node test/tutorial-connect-beat.test.js — the tour's last beat: "Connect your world" (BEGINNER_SEAM_PLAN lane 2).

   connectOffers / connectorUp are pure and hoisted out of the IIFE (the dodgeRect shape), so the gate runs the
   real matcher. The beat's wiring (placement, one-shot, click-never-ticks) is locked by source regex, exactly like
   onboarding.test.js locks the awakening. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { connectOffers, connectorUp } = require('../frontend/app/tutorial.js');

/* ---------- goal → connector offers ---------- */
A.eq(connectOffers(['run my email newsletter', 'grow the website']).join(','), 'gmail,webflow,wix', 'email+website goals offer gmail + webflow (+wix fills the third slot)');
A.eq(connectOffers(['write docs', 'book meetings', 'email', 'site']).join(','), 'gmail,webflow,google-calendar', 'every matched topic gets its first connector before any gets a second; capped at 3');
A.eq(connectOffers(['keep my calendar sane']).join(','), 'google-calendar', 'a calendar goal offers google-calendar alone (no padding with unrelated ids)');
A.eq(connectOffers([]).join(','), 'gmail,google-calendar,google-docs', 'no goals → the generic top-3');
A.eq(connectOffers(['learn chess']).join(','), 'gmail,google-calendar,google-docs', 'goals that match no topic → the generic top-3');
A.eq(connectOffers(null).join(','), 'gmail,google-calendar,google-docs', 'a malformed goal list is the cold case, never a throw');
A.ok(connectOffers(['email', 'site', 'docs', 'calendar', 'notes']).length <= 3, 'never more than three offers');

/* ---------- the connector step is READ-BACK truth ---------- */
A.eq(connectorUp([{ id: 'gmail', state: 'up' }]), true, 'a host-proved `up` connector counts');
A.eq(connectorUp([{ id: 'gmail', state: 'cached' }, { id: 'x', state: 'error' }]), false, 'cached / error / off never count');
A.eq(connectorUp(undefined), false, 'a failed read is not a connection');

/* ---------- wiring, by source ---------- */
const src = fs.readFileSync(path.join(__dirname, '../frontend/app/tutorial.js'), 'utf8');
const fin = src.slice(src.indexOf('function finishUp('), src.indexOf('function beatConnect('));
A.ok(/beatConnect\(afterConnect\)/.test(fin), 'finishUp hands the floor to the connect beat');
A.ok(fin.indexOf('PitchStore.offerStarter()') > fin.indexOf('const afterConnect'), 'the starter pitch waits behind the connect beat (chips are ONE layer)');
const beat = src.slice(src.indexOf('function beatConnect('), src.indexOf('function watchConnectors('));
A.ok(/Chat\.choices\(/.test(beat), 'the beat is COMMS chips — the tour’s existing vocabulary, no new window');
A.ok(/skip: true/.test(beat), 'the beat is skippable');
A.ok(/state\.connectOffered = true/.test(beat), 'the beat is one-shot');
A.ok(/StationUI\.connectorJump\(item\.value\)/.test(beat), 'a pick routes into the EXISTING ABILITIES catalog card');
A.ok(!/tickBrief\(/.test(beat), 'the pick itself NEVER ticks the connector step');
const watch = src.slice(src.indexOf('function watchConnectors('), src.indexOf('function seen('));
A.ok(/connectorUp\(j && j\.connectors\)/.test(watch) && /tickBrief\('platform'\)/.test(watch), 'the work-app step ticks only from the /api/connectors read-back');
const portal = src.slice(src.indexOf('function onConnectorPlaced('), src.indexOf('function onLevelUp('));
A.ok(!/tickBrief\('(?:connector|platform)'\)/.test(portal), 'placing a portal cannot complete an account connection');
A.ok(/k: 'platform'.*Connect a work app/.test(src), 'old portal progress is not reinterpreted as a verified connection');
const cx = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/connectors.js'), 'utf8');
A.ok(/StationUI\.connectorJump = function/.test(cx) && /openTerm\('connectors', 'catalog'\)/.test(cx), 'connectorJump opens ABILITIES on the CATALOG rail');
A.ok(!/connectorJump[\s\S]{0,600}oauth\/start/.test(cx.slice(0, cx.indexOf('function ccSignIn'))), 'the jump never starts OAuth itself — the card’s own SIGN IN stays the only door');
A.report('tutorial-connect-beat.test');
