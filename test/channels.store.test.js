/* node test/channels.store.test.js — durable per-chat history + chatmap store (C4).
   An in-memory fake fs proves: history round-trips, missing/corrupt -> [], lossy tail-trim by turns AND chars,
   chatmap save/merge by chatId, atomic temp+rename (no .tmp left behind), agentId jail-grammar enforced. Pure. */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeChannelStore, trimTail } = require('../sidecar/channels/store.js');

// in-memory fs: records writes/renames so we can assert atomicity (write to .tmp, then rename onto the target).
function memFs() {
  const files = new Map();
  const events = [];
  return {
    files, events,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); events.push(['write', p]); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); events.push(['rename', a, b]); },
    mkdirSync() {}
  };
}

let clk = 100;
const clock = { now: () => clk };
const ROOT = '/ws/channels';
const mk = (fs) => makeChannelStore({ fs, pathMod, root: ROOT, clock, limits: { maxTurns: 6, maxChars: 1000 } });

// ---- A. construction guards ----
{
  A.throws(() => makeChannelStore({ pathMod, root: ROOT, clock }), 'missing fs throws');
  A.throws(() => makeChannelStore({ fs: memFs(), root: ROOT, clock }), 'missing pathMod throws');
  A.throws(() => makeChannelStore({ fs: memFs(), pathMod, clock }), 'missing root throws');
  A.throws(() => makeChannelStore({ fs: memFs(), pathMod, root: ROOT }), 'missing clock throws');
}

// ---- B. empty / missing history loads as [] (fail-closed, never throws) ----
{
  const s = mk(memFs());
  A.eq(s.loadHistory('tg_123'), [], 'missing history -> []');
}

// ---- C. append round-trips; ts from injected clock; persisted atomically (write .tmp then rename) ----
{
  const fs = memFs();
  const s = mk(fs);
  clk = 111;
  s.appendTurn('tg_123', 'user', 'hello');
  clk = 222;
  s.appendTurn('tg_123', 'assistant', 'hi there');
  const h = s.loadHistory('tg_123');
  A.eq(h, [{ role: 'user', content: 'hello', ts: 111 }, { role: 'assistant', content: 'hi there', ts: 222 }], 'history round-trips with clock ts');
  // atomicity: every persisted file arrived via a rename from a .tmp; no .tmp left in the store
  const renames = fs.events.filter(e => e[0] === 'rename');
  A.ok(renames.length >= 2, 'each append renamed a temp onto the target');
  A.ok(renames.every(e => /\.tmp$/.test(e[1]) && !/\.tmp$/.test(e[2])), 'rename goes .tmp -> final');
  A.ok(![...fs.files.keys()].some(k => /\.tmp$/.test(k)), 'no .tmp file left behind');
  A.ok(fs.files.has(pathMod.join(ROOT, 'tg_123.history.json')), 'final history file exists');
}

// ---- D. corrupt history file -> [] and a fresh append still works ----
{
  const fs = memFs();
  fs.files.set(pathMod.join(ROOT, 'tg_9.history.json'), '{not json');
  const s = mk(fs);
  A.eq(s.loadHistory('tg_9'), [], 'corrupt history -> []');
  s.appendTurn('tg_9', 'user', 'recover');
  A.eq(s.loadHistory('tg_9').length, 1, 'append recovers over a corrupt file');
  // malformed turns inside an otherwise-valid file are dropped on load
  fs.files.set(pathMod.join(ROOT, 'tg_9.history.json'), JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'ok' }, { role: 'bogus', content: 'x' }, { junk: 1 }] }));
  A.eq(s.loadHistory('tg_9'), [{ role: 'user', content: 'ok' }], 'malformed turns filtered out');
}

// ---- E. lossy tail-trim: by maxTurns (6) ----
{
  const s = mk(memFs());
  for (let i = 0; i < 10; i++) s.appendTurn('tg_t', 'user', 'm' + i);
  const h = s.loadHistory('tg_t');
  A.eq(h.length, 6, 'trimmed to maxTurns=6');
  A.eq(h[0].content, 'm4', 'kept the newest 6 (m4..m9)');
  A.eq(h[5].content, 'm9', 'newest preserved');
}

// ---- F. lossy tail-trim: by maxChars (drops oldest until under budget, always keeps >=1) ----
{
  A.eq(trimTail([{ role: 'user', content: 'a'.repeat(600) }, { role: 'assistant', content: 'b'.repeat(600) }], 40, 1000).length, 1, 'over char budget drops oldest');
  A.eq(trimTail([{ role: 'user', content: 'x'.repeat(5000) }], 40, 1000).length, 1, 'never drops below one turn even if it alone exceeds budget');
  A.eq(trimTail([], 40, 1000), [], 'empty stays empty');
}

// ---- G. chatmap: save/merge by chatId, getChatRecord, lastSeen stamped, survives a fresh store ----
{
  const fs = memFs();
  let s = mk(fs);
  A.eq(s.loadChatMap().chats, {}, 'empty chatmap');
  A.eq(s.getChatRecord('555'), undefined, 'unknown chat -> undefined');
  clk = 700;
  const rec = s.saveChatRecord('555', { agentId: 'tg_555', model: 'anthropic/claude-sonnet-4.6' });
  A.eq(rec.agentId, 'tg_555', 'record saved with agentId');
  A.eq(rec.lastSeen, 700, 'lastSeen stamped from clock');
  // merge: a second patch updates model, keeps agentId
  clk = 800;
  const rec2 = s.saveChatRecord('555', { model: 'openai/gpt-4o' });
  A.eq(rec2.agentId, 'tg_555', 'merge kept agentId');
  A.eq(rec2.model, 'openai/gpt-4o', 'merge updated model');
  A.eq(rec2.lastSeen, 800, 'lastSeen refreshed');
  // a fresh store rebuilt from the same fs sees the persisted record (save-safe persistence)
  s = mk(fs);
  A.eq(s.getChatRecord('555').model, 'openai/gpt-4o', 'record survives a fresh store instance');
}

// ---- H. agentId jail-grammar enforced (no path traversal via a crafted agentId) ----
{
  const s = mk(memFs());
  A.throws(() => s.loadHistory('../escape'), 'traversal agentId rejected');
  A.throws(() => s.appendTurn('a/b', 'user', 'x'), 'slash agentId rejected');
  A.throws(() => s.appendTurn('tg_ok', 'bogusrole', 'x'), 'bad role rejected');
}

// ---- Z. (quick win 34) a file that is BUSY is not a file that is missing ----
// readRaw caught every error as "absent": on Windows an antivirus scan or an indexer holding chatmap.json open answers
// EBUSY/EPERM, the store read that as an empty (or .bak-old) map, and the read-modify-write in saveChatRecord wrote it
// back — every other chat's binding, /allow and approvals gone. Only ENOENT (and a torn/corrupt file) means absent.
{
  const fs = memFs();
  const s = mk(fs);
  s.saveChatRecord('A', { agentId: 'tg_A' });
  s.saveChatRecord('B', { agentId: 'tg_B' });
  const file = pathMod.join(ROOT, 'chatmap.json');
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p) { if (p === file) { const e = new Error('EBUSY: resource busy or locked, open ' + p); e.code = 'EBUSY'; throw e; } return realRead.apply(this, arguments); };
  A.throws(() => s.saveChatRecord('C', { agentId: 'tg_C' }), 'a BUSY chat map refuses the write instead of clobbering it');
  A.throws(() => s.loadChatMap(), 'and a read of a busy file is an error, never an empty map');
  fs.readFileSync = realRead;
  const map = s.loadChatMap();
  A.eq(Object.keys(map.chats).sort(), ['A', 'B'], 'once the lock clears, every chat recorded before is still there');
  // a missing file is still simply absent, and a torn one still recovers from .bak
  const s2 = mk(memFs());
  A.eq(s2.loadOutbox(), [], 'a missing outbox is still empty (ENOENT is absence)');
  const fs3 = memFs();
  const s3 = mk(fs3);
  s3.saveChatRecord('X', { agentId: 'tg_X' });
  s3.saveChatRecord('Y', { agentId: 'tg_Y' });
  fs3.files.set(file, '{"version":1,"chats":{');   // torn main
  A.ok(!!s3.getChatRecord('X'), 'a torn main is still recovered from its .bak (corrupt != busy)');
}

A.report('channels.store.test');
