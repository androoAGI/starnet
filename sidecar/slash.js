/* sidecar/slash.js -- Agent OS slash-command registry.

   Pure command metadata + resolution. The sidecar owns the catalog so every UI surface can discover
   the same commands, while the browser still executes local view actions such as retry/stop/copy. */
'use strict';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const BUILTIN_COMMANDS = Object.freeze([
  Object.freeze({
    name: 'retry',
    category: 'Session',
    desc: 're-run the last turn',
    action: 'retry'
  }),
  Object.freeze({
    name: 'stop',
    category: 'Session',
    desc: 'interrupt the running turn',
    action: 'stop'
  }),
  Object.freeze({
    name: 'copy',
    category: 'Info',
    desc: "copy the agent's last reply",
    action: 'copy'
  }),
  Object.freeze({
    name: 'help',
    category: 'Info',
    desc: 'list available commands',
    action: 'help'
  }),
  Object.freeze({
    name: 'new',
    aliases: ['reset'],
    category: 'Session',
    desc: 'start a fresh workstream',
    argsHint: '[title]',
    action: 'new'
  }),
  Object.freeze({
    name: 'branch',
    aliases: ['fork'],
    category: 'Session',
    desc: 'fork this conversation into a new workstream',
    argsHint: '[title]',
    action: 'branch'
  }),
  Object.freeze({
    name: 'status',
    category: 'Session',
    desc: 'show current stream and run state',
    action: 'status'
  }),
  Object.freeze({
    name: 'usage',
    category: 'Info',
    desc: 'show real spend from the station ledger',
    action: 'usage',
    dispatch: 'server'
  }),
  Object.freeze({
    name: 'queue',
    aliases: ['q'],
    category: 'Session',
    desc: 'show or add queued follow-up text',
    argsHint: '[message]',
    action: 'queue'
  }),
  Object.freeze({
    name: 'steer',
    category: 'Session',
    desc: 'steer the running turn (nothing to steer when idle)',
    argsHint: '<guidance>',
    action: 'steer'
  }),
  Object.freeze({
    name: 'undo',
    category: 'Session',
    desc: 'remove the last local exchange',
    action: 'undo'
  }),
  Object.freeze({
    name: 'compress',
    category: 'Session',
    desc: 'show context compaction status',
    argsHint: '',
    action: 'compress'
  }),
  Object.freeze({
    name: 'title',
    category: 'Session',
    desc: 'show or rename the current workstream',
    argsHint: '[name]',
    action: 'title'
  }),
  Object.freeze({
    name: 'resume',
    aliases: ['sessions', 'switch'],
    category: 'Session',
    desc: 'list or switch workstreams',
    argsHint: '[name|number]',
    action: 'resume'
  }),
  Object.freeze({
    name: 'save',
    category: 'Session',
    desc: 'save the current station state',
    action: 'save'
  }),
  Object.freeze({
    name: 'agents',
    aliases: ['tasks'],
    category: 'Session',
    desc: 'show active agents and running streams',
    action: 'agents'
  }),
  Object.freeze({
    name: 'background',
    aliases: ['bg', 'btw'],
    category: 'Session',
    desc: 'run a prompt in a new background workstream',
    argsHint: '<prompt>',
    action: 'background'
  }),
  Object.freeze({
    name: 'goal',
    category: 'Session',
    desc: 'set a goal this session works toward (status/pause/resume/clear)',
    argsHint: '[text|status|pause|resume|clear]',
    action: 'goal'
  }),
  Object.freeze({
    name: 'subgoal',
    category: 'Session',
    desc: 'add a criterion the session goal must also satisfy',
    argsHint: '[text|remove N|clear]',
    action: 'subgoal'
  }),
  Object.freeze({
    name: 'clear',
    aliases: ['cls'],
    category: 'Session',
    desc: 'clear COMMS and start a fresh workstream',
    argsHint: '[title]',
    action: 'clear'
  }),
  Object.freeze({
    name: 'history',
    aliases: ['hist'],
    category: 'Session',
    desc: 'show recent turns of this workstream',
    argsHint: '[n]',
    action: 'history'
  }),
  Object.freeze({
    name: 'whoami',
    category: 'Info',
    desc: 'show the current agent identity',
    action: 'whoami'
  }),
  Object.freeze({
    name: 'insights',
    category: 'Info',
    desc: 'usage rollup from the run history',
    action: 'insights'
  }),
  Object.freeze({
    name: 'model',
    category: 'Configuration',
    desc: 'show or set the active model',
    argsHint: '[model-id]',
    action: 'model'
  }),
  Object.freeze({
    name: 'personality',
    category: 'Configuration',
    desc: 'show or set the active personality',
    argsHint: '[personality]',
    action: 'personality'
  }),
  Object.freeze({
    name: 'yolo',
    category: 'Configuration',
    desc: 'toggle full-access approval mode',
    argsHint: '[on|off]',
    action: 'yolo'
  }),
  Object.freeze({
    name: 'reasoning',
    category: 'Configuration',
    desc: 'show or set how hard the model thinks before answering',
    argsHint: '[none|minimal|low|medium|high|xhigh]',
    action: 'reasoning'
  }),
  Object.freeze({
    name: 'fast',
    category: 'Configuration',
    desc: 'drop reasoning effort to minimal for quicker, cheaper replies',
    argsHint: '',
    action: 'fast'
  }),
  Object.freeze({
    name: 'voice',
    category: 'Configuration',
    desc: 'show or toggle spoken replies',
    argsHint: '[on|off|handsfree|status]',
    action: 'voice'
  }),
  Object.freeze({
    name: 'tools',
    category: 'Tools',
    desc: 'show the tools this agent can actually call',
    action: 'tools',
    dispatch: 'server'
  }),
  Object.freeze({
    name: 'skills',
    category: 'Tools',
    desc: 'show installed skill recipes',
    action: 'skills'
  }),
  Object.freeze({
    name: 'memory',
    category: 'Tools',
    desc: 'show the active agent memory records',
    argsHint: '[query]',
    action: 'memory'
  }),
  Object.freeze({
    name: 'bundles',
    category: 'Tools',
    desc: 'list recipe and skill slash bundles',
    action: 'bundles'
  }),
  Object.freeze({
    name: 'cron',
    category: 'Tools',
    desc: 'show or arm scheduled routines',
    argsHint: '[on|off|status]',
    action: 'cron'
  }),
  Object.freeze({
    name: 'routine',
    aliases: ['routines'],
    category: 'Tools',
    desc: 'list, create, preview, pause or delete a scheduled routine',
    argsHint: '[list | add <schedule> | <task> | preview <schedule> | pause N | resume N | rm N]',
    action: 'routine',
    dispatch: 'server'
  }),
  Object.freeze({
    name: 'away',
    aliases: ['build-away', 'buildaway'],   // both spellings the old client-only /build-away answered to
    category: 'Tools',
    desc: 'queue work for this agent to build on its own away shift',
    argsHint: '[<what to build> | list | on | off | now]',
    action: 'away',
    dispatch: 'server'
  }),
  Object.freeze({
    name: 'loop',
    category: 'Session',
    desc: 'repeat a prompt on an interval in this workstream',
    argsHint: '<interval> <prompt> | status | off',
    action: 'loop'
  }),
  Object.freeze({
    name: 'suggestions',
    aliases: ['suggest'],
    category: 'Tools',
    desc: 'review recurring-task recipe suggestions',
    argsHint: '[accept N|dismiss N|clear]',
    action: 'suggestions'
  }),
  Object.freeze({
    name: 'blueprint',
    aliases: ['bp'],
    category: 'Tools',
    desc: 'load a recipe blueprint into the composer',
    argsHint: '[recipe]',
    action: 'blueprint'
  }),
  Object.freeze({
    name: 'reload-mcp',
    aliases: ['reload_mcp'],
    category: 'Tools',
    desc: 'refresh configured MCP connectors',
    argsHint: '[connector-id]',
    action: 'reload-mcp'
  }),
  Object.freeze({
    name: 'reload-skills',
    aliases: ['reload_skills'],
    category: 'Tools',
    desc: 'refresh the slash skill catalog',
    action: 'reload-skills'
  }),
  Object.freeze({
    name: 'debug',
    category: 'Info',
    desc: 'show chat and slash debug state',
    action: 'debug'
  }),
  Object.freeze({
    name: 'version',
    aliases: ['v'],
    category: 'Info',
    desc: 'show Agent OS version information',
    action: 'version'
  })
]);

function cleanName(s) {
  return String(s || '').trim().replace(/^\//, '').toLowerCase();
}

function visibleCommand(c) {
  const out = {
    name: c.name,
    aliases: (c.aliases || []).slice(),
    category: c.category || 'General',
    desc: c.desc || '',
    argsHint: c.argsHint || '',
    source: c.source || 'builtin',
    action: c.action || '',
    dispatch: c.dispatch || 'client'
  };
  if (c.target) out.target = Object.assign({}, c.target);
  if (Object.prototype.hasOwnProperty.call(c, 'available')) out.available = !!c.available;
  if (Object.prototype.hasOwnProperty.call(c, 'enabled')) out.enabled = !!c.enabled;
  return out;
}

function buildIndex(commands) {
  const byName = new Map();
  const byToken = new Map();
  for (const raw of commands || []) {
    const c = Object.assign({}, raw || {});
    c.name = cleanName(c.name);
    c.aliases = (Array.isArray(c.aliases) ? c.aliases : []).map(cleanName).filter(Boolean);
    if (!NAME_RE.test(c.name)) throw new Error('bad slash command name: ' + c.name);
    if (byName.has(c.name)) throw new Error('duplicate slash command: ' + c.name);
    byName.set(c.name, c);
    for (const token of [c.name].concat(c.aliases)) {
      if (!NAME_RE.test(token)) throw new Error('bad slash command token: ' + token);
      if (byToken.has(token)) throw new Error('duplicate slash command token: ' + token);
      byToken.set(token, c);
    }
  }
  return { byName, byToken };
}

const INDEX = buildIndex(BUILTIN_COMMANDS);

function recipeDesc(r) {
  return ((r && r.emoji) ? String(r.emoji) + ' ' : '')
    + String((r && r.name) || (r && r.id) || 'Recipe')
    + ((r && r.tagline) ? ' - ' + String(r.tagline) : '');
}

function applyRecipeDefaults(recipe, args) {
  let directive = String((recipe && recipe.task) || (recipe && recipe.name) || '');
  const params = Array.isArray(recipe && recipe.params) ? recipe.params : [];
  const required = params.filter(p => p && p.key && p.required !== false);
  if (args && required.length === 1) {
    directive = directive.split('{' + required[0].key + '}').join(args);
  }
  for (const p of params) {
    if (!p || !p.key) continue;
    if (p.required !== false) continue;
    if (p.default != null && p.default !== '') directive = directive.split('{' + p.key + '}').join(p.default);
  }
  return directive.trim();
}

function skillInvocationText(skill, args) {
  const task = args || '{task}';
  const head = 'Use the "' + String((skill && skill.name) || (skill && skill.slug) || 'Skill') + '" skill recipe for this task.';
  const desc = (skill && skill.description) ? '\n\nDescription: ' + String(skill.description) : '';
  const body = (skill && skill.body) ? '\n\nSkill recipe:\n' + String(skill.body).trim() : '';
  return (head + desc + body + '\n\nTask: ' + task).trim();
}

function addCommand(out, used, raw) {
  const c = Object.assign({}, raw || {});
  c.name = cleanName(c.name);
  c.aliases = (Array.isArray(c.aliases) ? c.aliases : []).map(cleanName).filter(Boolean);
  if (!c.name || !NAME_RE.test(c.name) || used.has(c.name)) return false;
  for (const a of c.aliases) if (!a || !NAME_RE.test(a) || used.has(a)) return false;
  out.push(c);
  used.add(c.name);
  for (const a of c.aliases) used.add(a);
  return true;
}

function dynamicCommands(opts) {
  opts = opts || {};
  const out = BUILTIN_COMMANDS.map(c => Object.assign({}, c));
  const used = new Set();
  for (const c of out) {
    used.add(c.name);
    for (const a of c.aliases || []) used.add(a);
  }

  for (const r of (Array.isArray(opts.recipes) ? opts.recipes : [])) {
    if (!r || !r.id) continue;
    addCommand(out, used, {
      name: r.id,
      category: 'Recipes',
      desc: recipeDesc(r),
      source: 'recipe',
      action: 'insert',
      dispatch: 'insert',
      target: { type: 'recipe', id: String(r.id) }
    });
  }

  // COMMANDER-DEFINED commands (sidecar/usercommands.js). Added BEFORE skills/recipes cannot take their names
  // but AFTER builtins, so a user command can never shadow a builtin — addCommand refuses a used name, which
  // means /help can never be redefined out from under someone.
  for (const u of (Array.isArray(opts.userCommands) ? opts.userCommands : [])) {
    if (!u || !u.name) continue;
    addCommand(out, used, {
      name: u.name,
      category: u.category || 'Yours',
      desc: u.desc || '',
      source: 'user',
      action: 'user',
      dispatch: 'user',
      target: { type: 'user', userType: u.userType, target: u.target || '', command: u.command || '' }
    });
  }

  for (const s of (Array.isArray(opts.skills) ? opts.skills : [])) {
    if (!s || !s.slug || s.available === false) continue;
    const base = cleanName(s.slug);
    const name = used.has(base) ? ('skill-' + base) : base;
    addCommand(out, used, {
      name,
      category: 'Skills',
      desc: String(s.description || s.name || s.slug || ''),
      source: 'skill',
      action: 'insert',
      dispatch: 'insert',
      target: { type: 'skill', slug: String(s.slug) },
      available: s.available !== false,
      enabled: !!s.enabled
    });
  }
  return out;
}

function parseInput(input) {
  const text = String(input || '').trim();
  const noSlash = text.replace(/^\//, '');
  const m = noSlash.match(/^([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { token: '', args: '' };
  return { token: cleanName(m[1]), args: String(m[2] || '').trim() };
}

function resolve(input) {
  return resolveWith(input, BUILTIN_COMMANDS);
}

function resolveWith(input, commands) {
  const parsed = parseInput(input);
  let command = null;
  if (commands === BUILTIN_COMMANDS) command = parsed.token ? INDEX.byToken.get(parsed.token) : null;
  else {
    const idx = buildIndex(commands);
    command = parsed.token ? idx.byToken.get(parsed.token) : null;
  }
  return command ? { command, args: parsed.args, token: parsed.token } : null;
}

function catalog(opts) {
  return { commands: dynamicCommands(opts).map(visibleCommand) };
}

function findRecipe(id, recipes) {
  id = String(id || '');
  return (recipes || []).find(r => r && String(r.id) === id) || null;
}

function findSkill(slug, skills) {
  slug = String(slug || '');
  return (skills || []).find(s => s && String(s.slug) === slug) || null;
}

function dispatch(input, opts) {
  opts = opts || {};
  return dispatchDepth(input, opts, 0);
}

/* depth guards an ALIAS CHAIN: /a → /b → /a would otherwise recurse forever. The reference harness recurses
   through its own process_command with no visible bound; we cap it and say so rather than hanging. */
const MAX_ALIAS_DEPTH = 5;

function dispatchDepth(input, opts, depth) {
  const commands = dynamicCommands(opts);
  const hit = resolveWith(input, commands);
  if (!hit) return { ok: false, error: 'unknown slash command', status: 404 };
  const c = hit.command;
  if (c.target && c.target.type === 'user') {
    // ALIAS: rewrite to the target and re-resolve through this same registry, so an alias can only ever reach
    // a command the Commander could have typed — it inherits every guard the real command has.
    if (c.target.userType === 'alias') {
      if (depth >= MAX_ALIAS_DEPTH) return { ok: false, error: 'alias chain too deep (possible loop)', status: 400 };
      const line = (c.target.target + (hit.args ? ' ' + hit.args : '')).trim();
      return dispatchDepth(line, opts, depth + 1);
    }
    // EXEC: the registry stays PURE — it hands back what to run and the caller (which owns spawn) decides
    // whether it is allowed to run it here. See runUserExec / runSlashForChannel in sidecar/index.js.
    return {
      ok: true,
      command: visibleCommand(c),
      args: hit.args,
      directive: { type: 'exec', name: c.name, command: c.target.command, args: hit.args }
    };
  }
  if (c.target && c.target.type === 'recipe') {
    const recipe = findRecipe(c.target.id, opts.recipes);
    if (!recipe) return { ok: false, error: 'unknown recipe', status: 404 };
    return {
      ok: true,
      command: visibleCommand(c),
      args: hit.args,
      directive: {
        type: 'insert',
        source: 'recipe',
        text: applyRecipeDefaults(recipe, hit.args),
        select: 'first-placeholder'
      }
    };
  }
  if (c.target && c.target.type === 'skill') {
    const skill = findSkill(c.target.slug, opts.skills);
    if (!skill || skill.available === false) return { ok: false, error: 'skill unavailable', status: 409 };
    return {
      ok: true,
      command: visibleCommand(c),
      args: hit.args,
      directive: {
        type: 'insert',
        source: 'skill',
        text: skillInvocationText(skill, hit.args),
        select: 'first-placeholder'
      }
    };
  }
  // A command declaring dispatch:'server' names a door the SIDECAR opens, not the browser. The endpoint awaits
  // the matching slash-actions handler and rewrites this into a { type:'say', text } directive carrying one
  // honest line. Keeping the execution server-side is what lets every surface (COMMS palette, channel hub,
  // external harness) run the same command and read the same answer instead of each re-implementing a fetch.
  return {
    ok: true,
    command: visibleCommand(c),
    args: hit.args,
    directive: {
      type: c.dispatch === 'server' ? 'server' : 'client',
      action: c.action,
      args: hit.args
    }
  };
}

module.exports = {
  BUILTIN_COMMANDS,
  applyRecipeDefaults,
  buildIndex,
  catalog,
  cleanName,
  dispatch,
  dynamicCommands,
  parseInput,
  resolve,
  resolveWith,
  skillInvocationText,
  visibleCommand
};
