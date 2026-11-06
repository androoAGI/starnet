/* sidecar/reply-assembler.js — how a run's token deltas become the reply a person reads.

   joinReplyDelta (one delta onto the reply so far), steerNoteWire (a steering note as the run gets it) and the two
   patterns they read moved here out of channels/hub.js unchanged; the hub module keeps exporting joinReplyDelta.

     makeReplyAssembler() -> { feed(name, payload), text(), toolsRan }   one run's reply, fed that run's events in order
       feed           -> 'token' | 'tool' | ''   which of the two events it assembles from this was ('' for any other)
       text()         -> the reply so far: its deltas joined by joinReplyDelta, since the last tool call
       toolsRan       -> agent.tool_call events so far: an 'empty' end after tools is not "nothing was done"

   ONE ASSEMBLER FOR EVERY REPLY SINK (the family of bug e903a199). There is no agent.message event: every surface that
   keeps a run's words rebuilds them from its deltas, and only the channel hub used to join them. The cron driver, the
   loop driver and the host's hop, Run Now, night-shift and step-test sinks each concatenated raw, so a steered routine
   delivered '[steering] <note>' between two answers glued together. Every sink that KEEPS a reply feeds it here. The
   sink keeps everything else about a run (its errors, its end, its telemetry); this owns those two events and no more.
   A surface that forwards deltas live to a client draws its own steer row and does not use it: each one is named, with
   its reason, in test/reply-assembler.census.test.js.

   Pure: no I/O, no clock. */
'use strict';
const SteeringMessage = require('../frontend/app/steering-message.js');

/* A STEERING NOTE IS NOT PROSE (bug e903a199, 2026-10-23). The loop echoes a folded note as one token delta,
   '\n[steering] <note>\n' (loop.js foldSteerNotes, and the NOT-applied notice at the run's end). COMMS draws that line
   as its own steer row; buffered raw in the channel hub it reached the phone as an internal marker glued between the
   answer before the note and the answer after it. joinReplyDelta keeps both answers and every word of the note, but
   writes the note as a readable line of its own ('↪ <note>', the same arrow the steer acknowledgement uses), with one
   blank line on either side — the model's own paragraph break after it is folded in rather than stacked.
   ONE LINE: the channel hub posts its notes flattened (steerNoteWire, the rule COMMS's steerWire keeps), but a note
   posted by any other client may still carry a line break — the echo is matched whole and its note drawn on the one
   line. */
const STEER_ECHO_RE = /^\n\[steering\] ([\s\S]*?)\n?$/;
const AFTER_STEER_RE = /(?:^|\n)↪ [^\n]*\n\n$/;
// a steering note as the run gets it: one line, however many bubbles or line breaks it was typed in
function steerNoteWire(text) { return String(text == null ? '' : text).replace(/\s*\r?\n\s*/g, ' ').trim(); }
function joinReplyDelta(buf, delta) {
  const b = String(buf == null ? '' : buf), d = String(delta == null ? '' : delta);
  const m = STEER_ECHO_RE.exec(d);
  if (m) { const note = SteeringMessage.decode(m[1]); return (b.trim() ? b.replace(/\s+$/, '') + '\n\n' : '') + '↪ ' + steerNoteWire(note ? note.text + (note.attachments.length ? ' [attached: ' + note.attachments.map(a => a.name || 'file').join(', ') + ']' : '') : m[1]) + '\n\n'; }
  if (AFTER_STEER_RE.test(b)) return b + d.replace(/^\s+/, '');
  return b + d;
}

function makeReplyAssembler() {
  let buf = '';
  const assembler = {
    toolsRan: 0,
    feed(name, payload) {
      if (name === 'agent.token') { buf = joinReplyDelta(buf, payload && payload.delta); return 'token'; }
      if (name === 'agent.tool_call') { buf = ''; assembler.toolsRan++; return 'tool'; }   // what came before it was narration: only the terminal segment is the reply
      return '';
    },
    text() { return buf; }
  };
  return assembler;
}

module.exports = { makeReplyAssembler, joinReplyDelta, steerNoteWire, STEER_ECHO_RE, AFTER_STEER_RE };
