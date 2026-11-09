/* test/helpers/desk-code.js — a test station's DESK CODES, read from its console as the person at that station reads them
   (sidecar/deskproof.js; fix-sec2, review 2). A bare station (every station a test spawns) confirms an authority change
   only with the six-digit code it printed on its own stderr. A test that makes such a change on purpose feeds the
   station's output to the reader and replays the refusal with that code, exactly as the page does after the person types it.

     const desk = makeDeskCodeReader();
     child.stderr.on('data', d => desk.feed(d));
     const r2 = await desk.confirm(r, (headers) => fetch(url, { ..., headers: Object.assign({}, base, headers) }));

   confirm(res, replay, bodyKey): res is { status, body } as the test parsed it (or { status, j } with bodyKey 'j'); when it is
   the station's desk challenge in page mode the reader waits for that challenge's code and calls
   replay({ 'X-StarNet-Desk-Proof': id, 'X-StarNet-Desk-Code': code }), else it hands res back untouched. */
'use strict';

const LINE = /Type code (\d{6}) in the StarNet page that asks for confirmation ([A-Z0-9]{1,6})\./g;

function makeDeskCodeReader() {
  const codes = new Map();
  let tail = '';
  function feed(chunk) {
    tail = (tail + String(chunk)).slice(-8192);
    let m;
    LINE.lastIndex = 0;
    while ((m = LINE.exec(tail))) codes.set(m[2], m[1]);
  }
  async function codeFor(label, waitMs) {
    const until = Date.now() + (waitMs == null ? 3000 : waitMs);
    for (;;) {
      if (codes.has(label)) { const c = codes.get(label); codes.delete(label); return c; }
      if (Date.now() >= until) return '';
      await new Promise(r => setTimeout(r, 25));
    }
  }
  async function confirm(res, replay, bodyKey) {
    const b = res && res[bodyKey || 'body'];
    const ch = res && res.status === 403 && b && typeof b === 'object' && b.code === 'desk_confirm_required' && b.deskConfirm;
    if (!ch || ch.mode !== 'page') return res;
    const code = await codeFor(ch.code);
    if (!code) return res;
    return replay({ 'X-StarNet-Desk-Proof': ch.id, 'X-StarNet-Desk-Code': code });
  }
  return { feed, codeFor, confirm };
}

/* fetchJsonAtDesk(desk, url, init) -> the parsed body of a fetch() the station may answer with its desk challenge, replayed
   once with the code it printed (for a test that posts with fetch directly; desk is a makeDeskCodeReader fed the station's
   stderr). */
async function fetchJsonAtDesk(desk, url, init) {
  const go = async extra => {
    const i = Object.assign({}, init || {});
    i.headers = Object.assign({}, (init && init.headers) || {}, extra || {});
    const r = await fetch(url, i);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return (await desk.confirm(await go(), go)).body;
}

module.exports = { makeDeskCodeReader, fetchJsonAtDesk };
