/* sidecar/tools/builtin/recipe-read.js — recipe.read: the full text of one INSTALLED SKILL recipe, for a run that has no
   skill.view on its wire (cost audit W3.9c, 2026-11-14; behind STARNET_PREFIX_RECIPES, off by default).

   THE PROBLEM. The enabled recipes are station text the Commander switched on (skills/catalog.js: the shipped library
   and signed market recipes, each gated on the gear it needs). A run with skill.view on its wire carries a one-line
   index of them and loads a body on demand. skill.view is a SERVER CART (memory) power, so a run without the cart (a
   specialist in a bay with no cart, a station whose MEMORY switch is off, a routine restricted to other toolsets) got
   every enabled body inline instead: about 12 KB of its system prompt on every call, so the index could never point at
   a tool the run cannot call.

   THE READER. This tool serves those same bodies, and only those: `find` resolves a name against the recipes THIS run
   was offered (the list the inline block was composed from), so it returns exactly the text the prompt would have
   carried, never a recipe the Commander disabled or whose gear is not placed. It reads nothing else. A saved agent
   skill, a notebook entry, a past conversation and a widget stay SERVER CART powers: none of them is reachable here
   (an agent-authored skill's name cannot even be spelled "library:<slug>": skillstore.cleanName refuses ':').
   So object = capability holds: the reader grants no power a prop grants, it changes how text the run already holds
   is delivered, from pushed whole on every call to pulled once when a task matches.

   Same class as manual.read (capability 'stationinfo': station self-knowledge the prompt points at, read-only, local,
   consent-free, never a toggleable family). Not a CAP_REGISTRY row: the host offers it only to a run whose wire has no
   skill.view, and only while the switch is on (capability/project-tools.js), so with the switch off no run holds it. */
'use strict';

const NAME = 'recipe.read';

/* makeRecipeReadTool({ find, view })
   find(name) -> the offered recipe (or null); view(recipe) -> its text (skills/catalog.js find over the run's offered
   list, and viewText: the same pair skill.view's bundled resolver uses). */
function makeRecipeReadTool(deps) {
  deps = deps || {};
  const find = typeof deps.find === 'function' ? deps.find : () => null;
  const view = typeof deps.view === 'function' ? deps.view : () => '';
  const tool = {
    name: NAME, capability: 'stationinfo', impact: 'none', scope: 'read', requiresConsent: false,
    description: 'Load the full text of one INSTALLED SKILL recipe from the index in your instructions, by the '
      + 'library:<slug> name shown in brackets there. Call it before following a recipe: the index line is only a '
      + 'summary. Read-only, local, consent-free.',
    schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'the name in brackets, e.g. library:plan' } } },
    run: (args) => {
      const want = String((args && args.name) == null ? '' : args.name).trim();
      const recipe = want ? find(want) : null;
      const text = recipe ? String(view(recipe) || '') : '';
      if (!text) {
        return {
          content: (want ? 'No installed recipe named "' + want + '". ' : 'Name a recipe. ')
            + 'Use a name the INSTALLED SKILLS index in your instructions shows in brackets (library:<slug>); a recipe that is not in that index is not enabled for this run.',
          summary: want ? 'not found' : 'no name'
        };
      }
      return { content: text, summary: 'loaded ' + recipe.name };
    }
  };
  return { tool, register(reg) { reg.register(tool); return reg; } };
}

module.exports = { makeRecipeReadTool, NAME };
