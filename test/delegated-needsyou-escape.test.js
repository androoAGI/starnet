'use strict';
/* DELEGATED AND NEEDS YOU ESCAPE A SINGLE QUOTE (reliability wave 1, quick win 36, 2026-10-27).
   delegated.js and needsyou.js each carried their own esc that escaped & < > " but left ' raw, while every other surface
   (app.js, build.js, world.js, the SESSIONS rail) escapes through U.esc, the one complete escaper. A task title, an agent
   name or a place the Commander or a model wrote ("O'Brien's page") went into attribute values and text unescaped: harmless
   only while every attribute stays double-quoted, and one quote style change away from an injection. Both modules now call
   U.esc. This renders the REAL modules with the production U.esc (test/helpers/frontend-esc.js) and holds that the quote
   arrives as &#39; — in text and in attribute values — and that nothing else changed in the escaping. */
const A = require('./_assert.js');
const { installEsc, esc } = require('./helpers/frontend-esc.js');
installEsc();

const NOW = 50 * 86400000;
const NAME = "O'NEIL", TASK = `Fix O'Brien's <b>"launch"</b> page`, WHERE = "o'brien.example";

// the production escaper itself: the five characters, and nothing else touched
A.eq(esc(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;', 'U.esc escapes & < > " and \'');

/* ---------- DELEGATED: the dispatch card's rows ---------- */
{
  global.Channels = { pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
  global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
  global.App = { agentName: id => ({ researcher: NAME })[id] || id };
  global.document = undefined;
  const D = require('../frontend/app/delegated.js');
  const ws = o => Object.assign({ history: [], runIds: ['r'], lastRunReason: 'done' }, o);
  D._internals.opened.add("lead'1");
  const html = D._internals.lineHtml({ lead: "lead'1", rows: [{ ws: ws({ id: "k'1", agentId: 'researcher', title: TASK }), worker: null }] }, 'home');
  A.ok(html.indexOf('data-dg-toggle="lead&#39;1"') >= 0, 'delegated: an id with a quote is escaped in its attribute');
  A.ok(html.indexOf('data-dg-row="k&#39;1"') >= 0, 'delegated: the row id attribute too');
  A.ok(html.indexOf('O&#39;NEIL') >= 0, 'delegated: the agent name is escaped');
  A.ok(html.indexOf('data-tip="Fix O&#39;Brien&#39;s &lt;b&gt;&quot;launch&quot;&lt;/b&gt; page"') >= 0, 'delegated: the task tip attribute carries &#39; (and the other four as before)');
  A.ok(html.indexOf("O'NEIL") < 0 && html.indexOf("O'Brien") < 0 && html.indexOf("k'1") < 0 && html.indexOf("lead'1") < 0, 'delegated: no quote from the data reaches the markup raw');
  A.ok(html.indexOf('<b>"launch"</b>') < 0, 'delegated: markup in a title stays text');
}

/* ---------- NEEDS YOU: the waits list ---------- */
{
  global.localStorage = { getItem: () => null, setItem() {} };
  global.Workstreams = { get: () => null, list: () => [], unread: () => false, generalId: () => 'home', isDeleted: () => false };
  global.Chat = { consentPhrase: p => String(p.tool), consentInspect: () => null };
  global.Channels = { allPending: () => [] };
  global.StepIn = { live: () => [{ id: "h'1", agentId: 'researcher', reason: 'login', where: WHERE, state: 'waiting', requestedAt: NOW - 40000 }], open() {} };
  global.fetch = undefined;   // no sidecar feeds in this test
  const NY = require('../frontend/app/needsyou.js');
  const list = NY.items(NOW);
  const step = list.find(i => i.kind === 'stepin');
  A.ok(step && step.who === NAME && String(step.what).indexOf(WHERE) >= 0, 'needs you: the STEP-IN wait is listed with its quoted name and place');
  const html = NY._internals.html(list, NOW);
  A.ok(html.indexOf('O&#39;NEIL') >= 0, 'needs you: the agent name is escaped');
  A.ok(html.indexOf('o&#39;brien.example') >= 0, 'needs you: the place is escaped');
  A.ok(/data-ny-key="[^"]*h&#39;1[^"]*"/.test(html), 'needs you: a key holding a quote is escaped in its attribute');
  A.ok(html.indexOf("O'NEIL") < 0 && html.indexOf("o'brien") < 0 && html.indexOf("h'1") < 0, 'needs you: no quote from the data reaches the markup raw');
}

A.report('delegated-needsyou-escape.test');
