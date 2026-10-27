/* test/roster-cas.http.test.js — the crew roster takes the station's revision order, a trailing save is folded forward, and
   an over-cap save says it is too large (wave-1 save-latch-kill; 10-26 audit family B3; gh#121, starnet-releases#4).

   Boots the REAL sidecar (test/helpers/sidecar-fixture.js: a temp workspace, a hermetic profile, a random port).
     a. GROWTH FOLD: a save whose rating watermark trails the ledger is not refused — the station applies the ratings it
        lacks (sidecar/growth-fold.js) and stores it, watermark moved, the acknowledged XP in it;
     b. ROSTER REVISION CHECK: a window's roster built on an older station revision than the station file holds is refused
        (behind) however new its page clock; the window that wrote the head, or one built on the head, is taken; a window
        whose own later save landed before its ACK is taken; a push with no revision (the terminal) keeps the stamp check;
        the check survives a restart;
     c. NAMED 413: a station save over 16 MiB is answered 413 { tooLarge }, not 400 'bad json', and the station file is
        untouched. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const station = over => Object.assign({
  schema: 'starnet.save', version: 6, updatedAt: Date.now(), _saveRevision: 0, _saveDirty: true,
  agent: { id: 'agent', name: 'NOVA', createdAt: 5000, stats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [], receipts: { runs: [], feedback: [] } } },
  agents: [], generalId: 'general', activeId: 'general', deletedIds: [],
  stationStats: { xp: 0, level: 1, lifetimeXp: 0, confidence: 50, samples: 0, counters: {}, milestones: [], receipts: { runs: [], feedback: [] }, ratingSyncAt: 0, ratingSyncVersion: 2 },
  workstreams: [{ id: 'general', title: null, history: [{ role: 'user', content: 'hi' }] }]
}, over || {});
const roster = name => [{ agentId: 'agent', system: 'sys', name, provider: 'openrouter' }];

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-roster-cas-', env: { OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '' } });
  const ws = fixture.workspace;
  // the rating ledger holds one acknowledged verdict for this station (epoch = its founding), newer than the save will know
  const ratedAt = 1_700_000_000_000;
  fs.writeFileSync(path.join(ws, 'growth-ratings.jsonl'), JSON.stringify({ epoch: 5000, runId: 'run-rated', verdict: 'great', ts: ratedAt,
    entries: [{ agentId: 'agent', id: 'work:run-rated', runId: 'run-rated', delta: 3, reason: 'work_great', size: 'small' }] }) + '\n');
  try {
    await fixture.start();
    const j = (m, p, b) => fixture.json(m, p, b);
    const stored = () => JSON.parse(fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8'));

    // ---- a. the growth fold ----
    const first = await j('POST', '/api/save', station({ _saveClient: 'winA' }));
    A.eq(first.status, 200, 'a: the save is answered 200');
    A.eq(first.body.ok, true, 'a: a save whose watermark trails the ledger LANDS (folded), never refused growthStale (' + JSON.stringify(first.body) + ')');
    A.ok(Number(first.body.growthFolded) >= 1, 'a: the station says it folded the ratings in (' + first.body.growthFolded + ')');
    const s1 = stored().doc;
    A.eq(s1.stationStats.ratingSyncAt, ratedAt, 'a: the stored watermark is the ledger\'s newest rating');
    A.ok(s1.agent.stats.xp > 0 && s1.stationStats.xp > 0, 'a: and the acknowledged XP is in the station file (' + s1.agent.stats.xp + ')');
    const R1 = first.body.revision;

    // ---- b. the roster's revision check ----
    const a1 = await j('POST', '/api/roster', { agents: roster('A-at-R1'), updatedAt: 100, saveRevision: R1, saveClient: 'winA' });
    A.eq(a1.body.ok, true, 'b: a roster built on the station\'s head revision is taken');
    // window B, on the same head, saves: the station moves on
    const b1 = await j('POST', '/api/save', Object.assign(s1, { _saveRevision: R1, _saveClient: 'winB', updatedAt: Date.now() + 1, workstreams: s1.workstreams.concat([{ id: 'b', history: [{ role: 'user', content: 'b' }] }]) }));
    A.eq(b1.body.ok, true, 'b: window B saves');
    const R2 = b1.body.revision;
    const behind = await j('POST', '/api/roster', { agents: roster('A-stale'), updatedAt: Date.now() + 1e9, saveRevision: R1, saveClient: 'winA' });
    A.eq([behind.body.ok, behind.body.behind, behind.body.revision], [false, true, R2], 'b: window A, now behind, is refused — however new its page clock');
    A.eq(JSON.parse(fs.readFileSync(path.join(ws, 'agent.roster.json'), 'utf8')).agents[0].name, 'A-at-R1', 'b: and the roster on disk is untouched');
    const bOk = await j('POST', '/api/roster', { agents: roster('B-at-R2'), updatedAt: 200, saveRevision: R2, saveClient: 'winB' });
    A.eq(bOk.body.ok, true, 'b: window B\'s roster, built on the head, is taken');
    // window B saves again; its roster push left before that ACK came back (built on R2, head now R3 = B's own write)
    const b2 = await j('POST', '/api/save', Object.assign(stored().doc, { _saveRevision: R2, _saveClient: 'winB', updatedAt: Date.now() + 2 }));
    A.eq(b2.body.ok, true, 'b: window B saves again');
    const own = await j('POST', '/api/roster', { agents: roster('B-own-later'), updatedAt: 300, saveRevision: R2, saveClient: 'winB' });
    A.eq(own.body.ok, true, 'b: a window whose own later save is the head is not refused for not having heard its ACK');
    const forged = await j('POST', '/api/roster', { agents: roster('C-forged'), updatedAt: 400, saveRevision: R2, saveClient: 'winC' });
    A.eq(forged.body.behind, true, 'b: another window on that older revision is refused');
    const legacy = await j('POST', '/api/roster', { agents: roster('terminal'), updatedAt: 500 });
    A.eq(legacy.body.ok, true, 'b: a push with no revision (the terminal\'s awaken) keeps only the stamp check');
    A.eq(JSON.parse(fs.readFileSync(path.join(ws, 'agent.roster.json'), 'utf8')).saveRevision, R2, 'b: the newest station revision a roster was built on rides the envelope');
    await fixture.restart();
    const afterRestart = await j('POST', '/api/roster', { agents: roster('A-stale-again'), updatedAt: Date.now() + 2e9, saveRevision: R1, saveClient: 'winA' });
    A.eq(afterRestart.body.behind, true, 'b: after a restart, a roster built on an older revision is still refused');

    // ---- c. the named 413 ----
    const before = fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8');
    const big = station({ _saveClient: 'winA', workstreams: [{ id: 'general', title: null, history: [{ role: 'user', content: 'x'.repeat((16 << 20) + 4096) }] }] });
    const r = await fixture.request('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(big) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch (_) {}
    A.eq(r.status, 413, 'c: a >16 MiB station save is answered 413, not 400 \'bad json\'');
    A.eq(body && body.tooLarge, true, 'c: and says it is too large (' + text.slice(0, 160) + ')');
    A.eq(fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8'), before, 'c: the station file is untouched');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + '\n' + fixture.output().slice(-2000));
  } finally {
    await fixture.dispose();
  }
  A.report('roster-cas.http');
})();
