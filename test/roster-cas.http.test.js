/* test/roster-cas.http.test.js — the crew roster takes the station's revision order, a trailing save is folded forward, and
   an over-cap save says it is too large (wave-1 save-latch-kill; 10-26 audit family B3; gh#121, starnet-releases#4).

   Boots the REAL sidecar (test/helpers/sidecar-fixture.js: a temp workspace, a hermetic profile, a random port).
     a. GROWTH FOLD: a save whose rating watermark trails the ledger is not refused — the station applies the ratings it
        lacks (sidecar/growth-fold.js) and stores it, watermark moved, the acknowledged XP in it;
     b. ROSTER REVISION CHECK: a window's roster built on an older station revision than the station file holds is refused
        (behind) however new its page clock — unless it says what it pushed last (rosterBase): then it is MERGED row by row
        (review 10-27: a window behind the station, merging its saves, must still land its crew changes, or summon fails
        closed), its changed rows taken, another window's rows kept, a row it removed removed; one built on the head is taken;
        a push with no revision (the terminal) keeps the stamp check; the check survives a restart; a station file that went
        BACK (a restored older file) lowers the bar instead of refusing every page until saves climb past it (review 10-27);
     c. NAMED 413: a station save over 16 MiB is answered 413 { tooLarge }, not 400 'bad json', and the station file is
        untouched;
     d. THE STRICT READ, ONE READ (review 10-27): with a growth ledger larger than the bounded boot read (LOG_MAX_BYTES), the
        oldest ratings are not in the store, so a save whose watermark is older than them is refused growthStale, never
        folded past ratings it never applied; one whose watermark is inside what was read is folded. */
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
const onDisk = ws => JSON.parse(fs.readFileSync(path.join(ws, 'agent.roster.json'), 'utf8'));

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
    const atR1 = fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8');   // the station file at R1 (a backup, restored in b)

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
    const forged = await j('POST', '/api/roster', { agents: roster('C-forged'), updatedAt: 400, saveRevision: R2, saveClient: 'winB' });
    A.eq(forged.body.behind, true, 'b: a push on an older revision that cannot be merged is refused — the window id alone proves nothing (review 10-27)');
    // MERGED: window B (behind its own head) adds a crew member; window A, behind, renames the hero and recruits
    const withCrew = await j('POST', '/api/roster', { agents: roster('B-at-R2').concat([{ agentId: 'b-crew', system: 's', name: 'B crew', provider: 'openrouter' }]), updatedAt: 450, saveRevision: R2, saveClient: 'winB',
      rosterBase: { known: ['agent'], changed: ['b-crew'] } });
    A.eq(withCrew.body.ok, true, 'b: window B, behind its own head, adds a crew member: merged (' + JSON.stringify(withCrew.body) + ')');
    const merged = await j('POST', '/api/roster', { agents: roster('A-renamed').concat([{ agentId: 'a-crew', system: 's', name: 'A crew', provider: 'openrouter' }]), updatedAt: 1, saveRevision: R1, saveClient: 'winA',
      rosterBase: { known: ['agent'], changed: ['agent', 'a-crew'] } });
    A.eq(merged.body.ok, true, 'b: window A, behind (and with an older page clock), is MERGED: its changed rows land (' + JSON.stringify(merged.body) + ')');
    A.eq(onDisk(ws).agents.map(a => a.agentId + '=' + a.name).sort(), ['a-crew=A crew', 'agent=A-renamed', 'b-crew=B crew'], 'b: A\'s rename and recruit landed, and B\'s recruit (a row A never had) stayed');
    const removed = await j('POST', '/api/roster', { agents: roster('A-renamed'), updatedAt: 2, saveRevision: R1, saveClient: 'winA',
      rosterBase: { known: ['agent', 'a-crew'], changed: [] } });
    A.eq([removed.body.ok, onDisk(ws).agents.map(a => a.agentId).sort()], [true, ['agent', 'b-crew']], 'b: a row the window removed is removed; another window\'s stays');
    const legacy = await j('POST', '/api/roster', { agents: roster('terminal'), updatedAt: 500 });
    A.eq(legacy.body.ok, true, 'b: a push with no revision (the terminal\'s awaken) keeps only the stamp check');
    A.eq(JSON.parse(fs.readFileSync(path.join(ws, 'agent.roster.json'), 'utf8')).saveRevision, R2, 'b: the newest station revision a roster was built on rides the envelope');
    await fixture.restart();
    const afterRestart = await j('POST', '/api/roster', { agents: roster('A-stale-again'), updatedAt: Date.now() + 2e9, saveRevision: R1, saveClient: 'winA' });
    A.eq(afterRestart.body.behind, true, 'b: after a restart, a roster built on an older revision is still refused');
    // the station file goes BACK to R1 (a restored backup): a page that reopened on it pushes on R1 — taken, not refused forever
    fs.writeFileSync(path.join(ws, 'agent.save.json'), atR1);
    const back = await j('POST', '/api/roster', { agents: roster('on-restored-R1'), updatedAt: Date.now() + 3e9, saveRevision: R1, saveClient: 'winD' });
    A.eq(back.body.ok, true, 'b: after the station file went back to R1, a roster built on R1 is taken (' + JSON.stringify(back.body) + ')');
    A.eq(onDisk(ws).saveRevision, R1, 'b: and the recorded revision came down to the station\'s own');

    // ---- c. the named 413 ----
    const before = fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8');
    const big = station({ _saveClient: 'winA', workstreams: [{ id: 'general', title: null, history: [{ role: 'user', content: 'x'.repeat((16 << 20) + 4096) }] }] });
    const r = await fixture.request('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(big) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch (_) {}
    A.eq(r.status, 413, 'c: a >16 MiB station save is answered 413, not 400 \'bad json\'');
    A.eq(body && body.tooLarge, true, 'c: and says it is too large (' + text.slice(0, 160) + ')');
    A.eq(fs.readFileSync(path.join(ws, 'agent.save.json'), 'utf8'), before, 'c: the station file is untouched');

    // ---- d. the strict read, from one bounded read ----
    // a ledger of ~1.4 MiB under a 1 MiB boot read: the oldest ratings are cut off
    const pad = 'p'.repeat(2000), base = 1_700_000_100_000, rowsN = 700;
    let ledger = '';
    for (let i = 0; i < rowsN; i++) ledger += JSON.stringify({ epoch: 5000, runId: 'cut-' + i, verdict: 'great', ts: base + i, pad,
      entries: [{ agentId: 'agent', id: 'work:cut-' + i, runId: 'cut-' + i, delta: 1, reason: 'work_great', size: 'small' }] }) + '\n';
    fs.writeFileSync(path.join(ws, 'growth-ratings.jsonl'), ledger);
    await fixture.restart({ STARNET_LOG_MAX_BYTES: String(1 << 20) });   // ENV('LOG_MAX_BYTES')
    const head = stored().doc;
    const old = await j('POST', '/api/save', Object.assign({}, head, { _saveRevision: head._saveRevision, _saveClient: 'winE', updatedAt: Date.now() + 5e9,
      stationStats: Object.assign({}, head.stationStats, { ratingSyncAt: base + 1, ratingSyncVersion: 2 }) }));
    A.eq([old.body.ok, old.body.growthStale], [false, true], 'd: a save whose watermark is older than the ratings the bounded read kept is refused growthStale, never folded (' + JSON.stringify(old.body).slice(0, 200) + ')');
    const recent = await j('POST', '/api/save', Object.assign({}, head, { _saveRevision: head._saveRevision, _saveClient: 'winE', updatedAt: Date.now() + 6e9,
      stationStats: Object.assign({}, head.stationStats, { ratingSyncAt: base + rowsN - 3, ratingSyncVersion: 2 }) }));
    A.eq([recent.body.ok, recent.body.growthFolded], [true, 2], 'd: one whose watermark is inside what was read is folded (' + JSON.stringify(recent.body).slice(0, 200) + ')');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + '\n' + fixture.output().slice(-2000));
  } finally {
    await fixture.dispose();
  }
  A.report('roster-cas.http');
})();
