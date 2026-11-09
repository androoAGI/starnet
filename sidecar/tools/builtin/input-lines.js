/* sidecar/tools/builtin/input-lines.js — THE ASSEMBLED LINE (GHSA-2hpj #4).

   terminal.write and shell.bg.write send text to a program that is already running. With submit:false the text is a
   PART of a line, and the program only acts on the whole line when Enter arrives. Each part used to be screened on its
   own, so `rm -r` then `f /` then Enter passed two harmless-looking checks and ran a line neither of them was. This keeps,
   per session, the part of the line already typed, and hands the tool every line a write COMPLETES plus the line it
   leaves open, assembled from the earlier parts, so the tool screens what the program will actually read.

     const L = makeInputLines({ editing })   editing true = a terminal (its line editor applies Backspace, Ctrl-U, Ctrl-W
                                             and Ctrl-C); false = a pipe (bytes arrive as sent)
     const p = L.plan(key, data, submit)  -> { ok, lines:[string], open:string, raw:[string], unsure:bool } | { ok:false, error }
         lines = whole lines this write completes (the earlier part included), open = the part still waiting for Enter,
         raw   = the same text with no editing applied (a check of both catches an edit the station modelled wrongly),
         unsure = the line holds keys the station cannot follow (arrows, history, completion): it is screened as typed
     L.commit(key, p)   after the write went through: remember the open part
     L.clear(key)       Ctrl-C sent, stdin closed, the session stopped: no part is waiting

   What it cannot do: follow a line rebuilt from the program's own history or moved through with the arrow keys. Such a
   line is screened as the station saw it typed (escape sequences removed), and `unsure` says so. Pure; no I/O. */
'use strict';

const MAX_OPEN = 32768;     // a part longer than this is refused: it could not be screened as one line
const MAX_KEYS = 256;       // sessions remembered at once (the oldest is forgotten first; a forgotten part reads as empty)

function makeInputLines(opts) {
  const o = opts || {};
  const editing = o.editing !== false;
  const maxOpen = Number(o.maxOpen) > 0 ? Number(o.maxOpen) : MAX_OPEN;
  const open = new Map();   // key -> { text, raw, unsure }

  function eat(state, data) {
    const lines = [], raw = [];
    let cur = state.text, rawCur = state.raw, unsure = state.unsure;
    const s = String(data == null ? '' : data);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], c = s.charCodeAt(i);
      if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && i > 0 && s[i - 1] === '\r') continue;   // \r\n is one Enter
        lines.push(cur); raw.push(rawCur);
        cur = ''; rawCur = ''; unsure = false;
        continue;
      }
      if (!editing) { cur += ch; rawCur += ch; continue; }
      if (ch === '\x1b') {
        // an escape sequence (an arrow, Home, history, a function key): the station cannot follow where it moves the cursor
        unsure = true;
        const n = s[i + 1];
        if (n === '[') { let j = i + 2; while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++; i = j; }
        else if (n === 'O' || n === ']') i += 2;
        else if (n !== undefined) i += 1;
        continue;
      }
      if (ch === '\x7f' || ch === '\b') { cur = Array.from(cur).slice(0, -1).join(''); continue; }
      if (ch === '\x03') { cur = ''; rawCur = ''; unsure = false; continue; }   // Ctrl-C abandons the line
      if (ch === '\x15') { cur = ''; continue; }                                // Ctrl-U clears it (the typed text stays in raw)
      if (ch === '\x17') { cur = cur.replace(/\s+$/, '').replace(/\S+$/, ''); continue; }   // Ctrl-W: the word before
      if (ch === '\t') { cur += ch; rawCur += ch; continue; }                   // kept as typed (completion may add more: unsure)
      if (c < 0x20) { unsure = true; continue; }                                // Ctrl-A/E/K/R/P/N…: moves or recalls, untracked
      cur += ch; rawCur += ch;
    }
    return { lines, raw, cur, rawCur, unsure };
  }

  function plan(key, data, submit) {
    const k = String(key || '');
    const prev = open.get(k) || { text: '', raw: '', unsure: false };
    const r = eat(prev, String(data == null ? '' : data) + (submit === false ? '' : '\r'));
    if (Array.from(r.cur).length > maxOpen || Array.from(r.rawCur).length > maxOpen) {
      return { ok: false, error: 'this input would leave a line longer than ' + maxOpen + ' characters waiting for Enter, too long to check as one line; send it in one piece with submit, or interrupt the line first' };
    }
    return { ok: true, key: k, lines: r.lines, raw: r.raw, open: r.cur, rawOpen: r.rawCur, unsure: r.unsure };
  }

  function commit(key, p) {
    const k = String(key || '');
    if (!p || p.ok !== true) return;
    open.delete(k);
    if (!p.open && !p.rawOpen) return;
    open.set(k, { text: p.open, raw: p.rawOpen, unsure: !!p.unsure && (p.open !== '' || p.rawOpen !== '') });
    while (open.size > MAX_KEYS) open.delete(open.keys().next().value);
  }

  function clear(key) { open.delete(String(key || '')); }

  // every text the tool should screen for this plan: each completed line and the open part, edited and as typed
  function texts(p) {
    const out = [];
    const add = (t) => { const s = String(t == null ? '' : t); if (s.trim() && out.indexOf(s) < 0) out.push(s); };
    if (!p || p.ok !== true) return out;
    for (const t of p.lines) add(t);
    for (const t of p.raw) add(t);
    add(p.open); add(p.rawOpen);
    return out;
  }

  return { plan, commit, clear, texts, _open: open };
}

module.exports = { makeInputLines, MAX_OPEN };
