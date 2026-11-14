/* sidecar/tools/builtin/manual-read.js — manual.read: one section of the StarNet operator manual, verbatim.

   The interactive task prompt carries the manual's orientation + behaviour rules inline and only a table of
   contents for its REFERENCE sections (navigation, props, troubleshooting — see sidecar/manual.js). This tool is
   where those sections are read, so the prompt's "call manual.read before naming a window" always points at a
   callable tool. Same grant class as station.inspect (the always-present `computer`, capId 'stationinfo'):
   harness self-knowledge is part of being able to operate at all. Pure: a constant text lookup — no IO, no
   network, no secrets, no state, nothing to consent to. */
'use strict';

const { manualSection, MANUAL_SECTIONS } = require('../../manual.js');

const IDS = MANUAL_SECTIONS.map(s => s.id);

function makeManualReadTool() {
  const tool = {
    name: 'manual.read', capability: 'stationinfo', impact: 'none', scope: 'read', requiresConsent: false,
    description: 'Read one section of the StarNet operator manual, verbatim: how the station works, for guiding the '
      + 'Commander. navigation (every window and control), props (which prop grants which power), '
      + 'troubleshooting (the fix for each stuck case), concepts (what each thing is), or all. Call it before naming any StarNet window, '
      + 'menu, button or prop. Read-only, local, consent-free.',
    schema: { type: 'object', properties: { section: { type: 'string', enum: IDS.concat(['all']) } } },
    run: (args, ctx) => {
      const want = String((args && args.section) || '').trim();
      const text = want ? manualSection(want) : null;
      if (text == null) {
        // ctx.manualOnDemand: the rule sections this run's prompt carries only the core of (STARNET_PREFIX_DOCTRINE: the
        // host names them when it composes the lean index). They are read here, so they are listed with the reference
        // sections, never as "already in your prompt". Absent (every other run), the two lists are the manual's own.
        const onDemand = (ctx && Array.isArray(ctx.manualOnDemand)) ? ctx.manualOnDemand : [];
        const ref = MANUAL_SECTIONS.filter(s => s.kind === 'reference' || onDemand.indexOf(s.id) >= 0).map(s => s.id);
        const inline = MANUAL_SECTIONS.filter(s => s.kind !== 'reference' && onDemand.indexOf(s.id) < 0).map(s => s.id);
        return {
          content: (want ? 'No manual section "' + want + '". ' : 'Name a section. ')
            + 'Reference sections: ' + ref.join(', ') + '. Already in your prompt: ' + inline.join(', ') + '. Or "all".',
          summary: want ? 'unknown section' : 'sections listed'
        };
      }
      return { content: text, summary: 'manual: ' + want.toLowerCase() };
    }
  };
  return { tool, register(reg) { reg.register(tool); return reg; } };
}

module.exports = { makeManualReadTool };
