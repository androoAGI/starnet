'use strict';
/* node test/turn-directive.null-capture.test.js — the directive capture and its null-safe readers (turn identity, commit 4;
   A2-SP-06, A2-ROOT-01, A2-FP-C01).

   runOnceCore captures the newest user message BEFORE attachments expand (TurnDirective.capture). A run may have no user
   message at all: an internal system-only body with messages: [], an assistant-only body. capture() returns null for
   those, distinct from a captured empty caption, and every reader is null-safe, so a null capture keeps the trunk path
   exactly (no typed words, the title from runDirective, the trunk string directive, no packet directive) and a found turn
   with no capture is an input conflict (re-keyed). Also: the label of a captionless attachment turn, the one wording, the
   key-blind reuse check on the typed words and attachment ids, the safe packet text, and TurnKinds.ofRun's kinds. Pure. */
const A = require('./_assert.js');
const failopen = require('../sidecar/failopen.js');
const D = require('../sidecar/turn-directive.js');
const TurnKinds = require('../frontend/app/turnkinds.js');
const { isRoutineTrigger } = require('../sidecar/routine-identity.js');

const PNG = { id: 'a1b2c3d4', name: 'photo.png', path: '.attachments/a1b2c3d4.png', mediaType: 'image/png', kind: 'image', size: 68 };
const TXT = { id: 'e5f6a7b8', name: 'notes.txt', path: '.attachments/e5f6a7b8.txt', mediaType: 'text/plain', kind: 'file', size: 12 };
const T = 't0123456789abcdefghijklmn';
const conflicts = () => failopen.counts()['turn.reuse.conflict.input'] || 0;

const API = ['capture', 'typedText', 'wording', 'row', 'title', 'runTitle', 'interruptedTitle', 'packet'];
const missing = API.filter(k => typeof D[k] !== 'function');
A.eq(missing, [], 'TurnDirective exposes the capture and its readers');
A.ok(typeof TurnKinds.ofRun === 'function' && typeof TurnKinds.messageKind === 'function', 'TurnKinds exposes ofRun and messageKind');
if (missing.length || typeof TurnKinds.ofRun !== 'function') { A.report('turn-directive.null-capture'); process.exit(); }

// 1. null capture: no user message to read
A.eq(D.capture([]), null, 'capture([]) is null');
A.eq(D.capture(undefined), null, 'capture(undefined) is null');
A.eq(D.capture([{ role: 'system', content: 'reply OK' }]), null, 'a system-only capture is null');
A.eq(D.capture([{ role: 'assistant', content: 'hello' }]), null, 'an assistant-only capture is null');
A.eq(D.capture([{ role: 'user', content: 42 }]), null, 'a user turn whose content cannot be read (and carries no attachments) is not a capture');
A.eq(D.capture([], { recovery: { title: '' } }), null, 'a recovery whose source names no title is null (the trunk path reads the recovered prompt)');

// 2. every reader is null-safe and keeps the trunk path
A.eq(D.typedText(null), '', 'typedText(null) === \'\'');
A.eq(D.wording(null), '', 'wording(null) === \'\'');
A.eq(D.title(null, 'x'), 'x', 'title(null, runDirective) is runDirective');
A.eq(D.row(null, 'x', 'turn'), 'x', 'row(null, contentBytes) is contentBytes itself (setDirective\'s trunk string path)');
A.eq(D.packet(null, { redact: s => s, keys: [] }), null, 'packet(null) is null (the stash carries no packet directive)');

// 3. a captionless attachment turn IS a capture (captured: true), read through its label
const pic = D.capture([{ role: 'user', content: 'older words' }, { role: 'user', content: '', attachments: [PNG] }], { turnId: T });
A.ok(pic && pic.captured === true, 'a {content: \'\', attachments: [png]} capture is non-null');
A.eq(pic && pic.label, '[image: photo.png]', 'it carries its label');
A.eq([D.typedText(pic), D.wording(pic), D.title(pic, 'EXPANDED')], ['', '[image: photo.png]', '[image: photo.png]'], 'no typed words; the wording and the title are its label (never an older turn, never the expanded bytes)');
A.eq(pic && pic.attachments, [{ id: PNG.id, name: PNG.name, path: PNG.path, mediaType: PNG.mediaType, kind: PNG.kind }], 'its attachments are bounded references (never bytes; the store\'s fields)');
A.eq(D.row(pic, '', 'turn'), { text: '[image: photo.png]', typed: '[image: photo.png]', attachments: pic.attachments, kind: 'turn', labelOnly: true }, 'a captionless turn writes a directive row (its content the label: the expanded text has none), and says it is only a label (the run transcript stamps such a row; it is never the Commander\'s words)');
const two = D.capture([{ role: 'user', content: '', attachments: [PNG, TXT, { name: 'no-path.bin' }] }]);
A.eq(two.label, '[image: photo.png], [file: notes.txt], [file: no-path.bin]', 'one label per attachment, joined');
A.eq(two.attachments.map(a => a.id), [PNG.id, TXT.id], 'a reference outside .attachments/ is labelled but not kept as a ref');
const many = D.capture([{ role: 'user', content: '', attachments: Array.from({ length: 40 }, (_, i) => ({ name: 'file-' + i + '-' + 'x'.repeat(30) + '.txt', path: '.attachments/f' + i + '.txt' })) }]);
A.ok(many.label.length <= 600 && many.attachments.length === 16, 'the label is bounded (600) and the refs too (16)');
const typed = D.capture([{ role: 'user', content: 'look at this', attachments: [TXT] }]);
A.eq([D.typedText(typed), D.wording(typed), D.row(typed, 'look at this\n\n[Attached file: notes.txt] bytes', 'turn').typed], ['look at this', 'look at this', 'look at this'], 'a captioned attachment turn reads its typed words');
A.eq(D.capture([{ role: 'user', content: 'raw text' }], { typedDirective: 'the member\'s own words' }).typedTitleSource, 'the member\'s own words', 'a surface\'s typedDirective titles the run (Q3)');
const rec = D.capture([{ role: 'user', content: 'the page tail' }], { recovery: { title: 'quokka plan' } });
A.eq([rec.text, rec.label, rec.typedTitleSource, rec.recovered], ['quokka plan', '', 'quokka plan', true], 'a recovery continuation\'s directive is its source\'s title, never the page tail');

// 4. titles and the packet: one wording, scrubbed and key-named the one way
const KEY = 'sk-test-' + 'Q'.repeat(40);
const keys = [{ key: KEY, envVar: 'FIXTURE_API_KEY' }];
const keyed = D.capture([{ role: 'user', content: 'save ' + KEY + ' please', attachments: [TXT] }]);
A.ok(D.runTitle(D.title(keyed, 'x'), keys).indexOf(KEY) < 0 && /FIXTURE_API_KEY/.test(D.runTitle(D.title(keyed, 'x'), keys)), 'runTitle names a saved key');
A.eq(D.interruptedTitle({ directiveTitle: 'quokka plan', userTitle: 'expanded bytes' }, []), 'quokka plan', 'an interrupted record takes the journal\'s directive title first');
A.eq(D.interruptedTitle({ userTitle: 'older journal' }, []), 'older journal', 'an older journal (no directiveTitle) keeps its userTitle');
A.eq(D.interruptedTitle(null, []), '', 'no meta: an empty title');
const pkt = D.packet(keyed, { redact: s => s.replace(/please/, '[redacted-secret]'), keys, row: { rowId: 41 } });
A.eq(pkt, { rowId: 41, text: 'save [FIXTURE_API_KEY saved in API KEYS] [redacted-secret]' }, 'the packet text is the wording, key-named then redacted; its rowId the written directive\'s');
A.ok(pkt.text.indexOf(KEY) < 0, 'no raw saved key in the packet');
A.eq(D.packet(pic, { redact: () => { throw new Error('boom'); } }).text, '', 'a redaction that throws leaves the packet text empty (fail closed)');

// 5. reuse: a found turn with no capture is an input conflict; the typed words and attachment ids decide otherwise
const found = (row) => ({ state: 'found', directive: Object.assign({ rowId: 7, agentId: 'agent', content: 'hello there' }, row) });
const reuseWith = (row, directive, extra) => {
  let rekeyed = null;
  const out = D.reuse(null, Object.assign({ found: found(row), runId: 'run-000009', directive, messages: [], latestUserText: () => '', redact: s => s, keys: [], rekey: t => { rekeyed = t; } }, extra || {}));
  return { out, rekeyed };
};
let before = conflicts();
let r = reuseWith({}, null);
A.eq([r.out, r.rekeyed], [null, TurnKinds.runTurnId('run-000009')], 'reuse with a found turn and directive: null re-keys to the run\'s own id');
A.ok(TurnKinds.isTurnId(r.rekeyed), 'fixture: the re-key is a valid turnId');
A.eq(conflicts() - before, 1, 'and is counted as an input conflict');
r = reuseWith({ content: 'hello there' }, D.capture([{ role: 'user', content: 'hello there' }]), { latestUserText: () => 'hello there' });
A.ok(r.out && r.out.rowId === 7 && r.rekeyed === null, 'a typed turn with the same words reuses its directive (content rung)');
r = reuseWith({ content: 'EXPANDED notes bytes', typed: '[image: photo.png], [file: notes.txt]', attachments: [{ id: PNG.id }, { id: TXT.id }] }, D.capture([{ role: 'user', content: '', attachments: [PNG, TXT] }]));
A.ok(r.out && r.out.rowId === 7, 'an attachment turn with the same wording and the same attachment ids reuses its directive (typed rung)');
r = reuseWith({ content: 'EXPANDED', typed: 'look at this', attachments: [{ id: TXT.id }, { id: PNG.id }] }, D.capture([{ role: 'user', content: 'look at this', attachments: [PNG, TXT] }]));
A.ok(r.out && r.out.rowId === 7, 'the attachment ids compare as a set (order aside)');
r = reuseWith({ content: 'EXPANDED', typed: '[image: photo.png], [file: notes.txt]', attachments: [{ id: PNG.id }, { id: 'other-id' }] }, D.capture([{ role: 'user', content: '', attachments: [PNG, TXT] }]));
A.eq(r.out, null, 'a changed attachment is an input conflict');
r = reuseWith({ content: '[image: photo.png]', attachments: [{ id: PNG.id }] }, pic);
A.ok(r.out && r.out.rowId === 7, 'a captionless retry reuses its directive: the expanded text is empty, so the content rung reads the label');
r = reuseWith({ content: 'old words', typed: 'old words' }, D.capture([{ role: 'user', content: 'new words' }]));
A.eq(r.out, null, 'changed words are an input conflict');
const KEYROW = { content: 'use [FIXTURE_API_KEY saved in API KEYS] now', typed: 'look: [FIXTURE_API_KEY saved in API KEYS]', attachments: [{ id: TXT.id }] };
r = reuseWith(KEYROW, D.capture([{ role: 'user', content: 'look: ' + KEY, attachments: [TXT] }]), { keys, redact: s => s.replace(KEY, '[redacted-secret]') });
A.ok(r.out && r.out.rowId === 7, 'a keys.save retry still reuses its directive (key-blind on the typed words)');

// 6. TurnKinds.ofRun: kinds from host-minted origin flags only
const k = (o, ctx) => { const x = TurnKinds.ofRun(o, ctx); return [x.directiveKind, x.rowKind, x.line]; };
A.eq(k({}, {}), ['turn', undefined, undefined], 'an ordinary run is a turn');
A.eq(k({}, { internal: true }), ['station', 'station', undefined], 'an internal run (any stream) is station speech');
A.eq(k({ outputOnly: true }, {}), ['station', 'station', undefined], 'an outputOnly run is station speech');
A.eq(k({ syntheticTrigger: 'on_session_end' }, {}), ['station', 'station', undefined], 'a synthetic trigger is station speech');
A.eq(k({ lineHop: true, lineId: 'ln1', dockId: 'd2' }, {}), ['hop', 'hop', 'ln1@d2'], 'a work-line hop is a hop on its line');
A.eq(k({ lineId: 'ln1', dockId: 'd2' }, {}), ['turn', undefined, undefined], 'a lineId alone is not a hop signal');
A.eq(TurnKinds.ofRun({ lineHop: true, lineId: 'L'.repeat(100), dockId: 'D'.repeat(100) }, {}).line.length, 120, 'the line is bounded to 120');
A.eq(k({ goalContinuation: true }, {}), ['goal-step', undefined, undefined], 'a goal-loop continuation is a goal step (Q13)');
A.eq(k({}, { trigger: 'schedule' }), ['routine', undefined, undefined], 'a scheduled fire is a routine');
A.eq(k({}, { trigger: 'manual' }), ['routine', undefined, undefined], 'a Run-Now fire is a routine');
A.eq(k({ groupTools: true }, { trigger: 'directive' }), ['group', undefined, undefined], 'a group session is a group');
A.eq(k({ taskSource: 'api' }, {}), ['api', undefined, undefined], 'a /v1 directive is api');
A.eq(k({ internal: true, lineHop: true, goalContinuation: true }, { trigger: 'schedule' }), ['station', 'station', undefined], 'station speech wins over every other flag');
for (const t of ['directive', 'schedule', 'manual', 'loop', 'nightshift', 'webhook', '', undefined]) A.eq(TurnKinds.ofRun({}, { trigger: t }).directiveKind === 'routine', isRoutineTrigger(t), 'ofRun\'s routine trigger agrees with routine-identity isRoutineTrigger for ' + String(t));
const capTurn = TurnKinds.tag({ role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE' }, 'capture');
A.eq([TurnKinds.messageKind(capTurn, undefined), TurnKinds.messageKind({ role: 'user' }, 'hop'), TurnKinds.messageKind({ role: 'assistant' }, 'hop'), TurnKinds.messageKind({ role: 'tool' }, undefined)], ['capture', 'station', 'hop', 'turn'], 'messageKind: the tag, else station for a user row, else the run\'s row kind, else turn');
A.eq(TurnKinds.ofRun({}, { internal: true }).kindOf({ role: 'assistant' }), 'station', 'ofRun\'s kindOf stamps by the run\'s row kind');
A.eq(JSON.stringify(capTurn), JSON.stringify({ role: 'user', content: '[BEGIN EXTERNAL SCREEN CAPTURE' }), 'the capture tag never reaches JSON');

A.report('turn-directive.null-capture');
